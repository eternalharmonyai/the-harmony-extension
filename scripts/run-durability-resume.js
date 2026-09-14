#!/usr/bin/env node
'use strict';
/**
 * Durability harness — crash injection + durable resumable staging.
 *
 * The Phase-1 harness proves nothing is silently lost. THIS one proves the harder
 * promises this harness checks:
 *
 *   R1  An interrupted rebuild leaves a durable checkpoint on disk.
 *   R2  A restart SURFACES it honestly (/status staging_root + staging_chunks).
 *   R3  The next index of the SAME root RESUMES — it embeds only the remainder.
 *   R4  RESUME == REBUILD: the final vector count equals an uninterrupted run.
 *   R5  A completed rebuild clears the checkpoint.
 *   R6  An unreadable/incompatible checkpoint is discarded loudly (never trusted blindly).
 *
 * Everything runs against a REAL daemon on a throwaway FIXTURE corpus, so a full
 * rebuild is seconds, not minutes. Live data is never touched.
 *
 * Usage:  node scripts/run-durability-resume.js
 * Env:    HARMONY_HUB_BIN, HARMONY_HUB_PORT (default 7992)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.HARMONY_HUB_PORT || 7992);
const TOKEN = 'resume-harness';
const BIN = process.env.HARMONY_HUB_BIN
    || path.resolve(ROOT, '..', 'HarmonyHub', 'target', 'release', 'harmonyhub.exe');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resume-'));
const FIXTURE = path.join(WORK, 'fixture');
const STAGING = 'staging.bincode';

const results = [];
let child = null;
let logs = '';

function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail || '' });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getStatus() {
    try {
        const res = await fetch(`http://127.0.0.1:${PORT}/status`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
            signal: AbortSignal.timeout(4000),
        });
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

async function hub(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
    return res.json();
}

async function startDaemon(dataDir) {
    child = spawn(BIN, [
        '--data-dir', dataDir,
        '--bind', `127.0.0.1:${PORT}`,
        '--auth-token', TOKEN,
        '--idle-stop-minutes', '0',
        '--idle-unload-minutes', '0',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => { logs += d.toString(); });
    child.stderr.on('data', (d) => { logs += d.toString(); });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        const s = await getStatus();
        if (s) return s;
        if (child.exitCode !== null) throw new Error(`daemon exited early (code ${child.exitCode})\n${logs.slice(-2000)}`);
        await sleep(500);
    }
    throw new Error('daemon did not become ready within 180s');
}

async function killDaemon() {
    if (!child) return;
    const proc = child;
    child = null;
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    const deadline = Date.now() + 15000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(200);
    await sleep(1200); // let the OS release the port
}

async function stopDaemon() {
    if (!child) return;
    const proc = child;
    child = null;
    try { proc.kill('SIGTERM'); } catch { /* noop */ }
    const deadline = Date.now() + 15000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(200);
    await sleep(1200);
}

async function runToCompletion(label, { killAtChunks = 0 } = {}) {
    const { job_id } = await hub('POST', '/index', { path: FIXTURE });
    let killed = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 900000) {
        const j = await hub('GET', `/index/status/${job_id}`);
        if (killAtChunks && !killed && j.chunks_done >= killAtChunks) {
            killed = true;
            console.log(`  … killing -9 at chunks_done=${j.chunks_done} (${label})`);
            await killDaemon();
            return { job: j, killed: true };
        }
        if (j.state === 'done' || j.state === 'failed') return { job: j, killed };
        await sleep(400);
    }
    throw new Error(`${label}: timed out`);
}

function makeFixture() {
    fs.mkdirSync(FIXTURE, { recursive: true });
    for (let f = 0; f < 20; f++) {
        const lines = [];
        for (let i = 0; i < 900; i++) {
            lines.push(`// fixture${f} line ${i} :: function_${f}_${i}(a, b) { return a + b + ${i}; }`);
        }
        fs.writeFileSync(path.join(FIXTURE, `mod${f}.js`), lines.join('\n'));
    }
}

function freshDataDir(name) {
    const dir = path.join(WORK, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({
        allowed_roots: [FIXTURE],
        excluded_substrings: [],
    }, null, 2));
    return dir;
}

const stagingPath = (dir) => path.join(dir, STAGING);

async function main() {
    console.log('HarmonyHub durability harness — crash injection + resume');
    console.log(`  binary : ${BIN}`);
    console.log(`  work   : ${WORK}`);
    console.log('');

    if (!fs.existsSync(BIN)) {
        console.error(`FAIL: daemon binary not found at ${BIN}`);
        process.exitCode = 1;
        return;
    }
    makeFixture();

    // ── Case A: baseline — an uninterrupted rebuild (this is the ground truth) ──
    console.log('Case A — uninterrupted rebuild (baseline)');
    let fullVectors = 0;
    {
        const dir = freshDataDir('baseline');
        await startDaemon(dir);
        const { job } = await runToCompletion('baseline');
        check('A1 baseline job completes', job.state === 'done', `state=${job.state} ${job.error || ''}`);
        fullVectors = job.total_vectors;
        check('A2 baseline indexed a real corpus', fullVectors > 100, `vectors=${fullVectors}`);
        check('A3 a completed rebuild leaves no checkpoint', !fs.existsSync(stagingPath(dir)));
        await stopDaemon();
    }
    console.log('');

    // ── Case B: kill -9 mid-rebuild, then restart + resume ──
    console.log('Case B — kill -9 mid-rebuild, restart, resume (R1-R5)');
    {
        const dir = freshDataDir('resume');
        await startDaemon(dir);
        const crashed = await runToCompletion('crash', { killAtChunks: 210 });
        check('B1 crash killed the daemon mid-rebuild', crashed.killed, `chunks_done=${crashed.job.chunks_done}`);
        check('R1 a durable checkpoint was written before the crash', fs.existsSync(stagingPath(dir)),
            fs.existsSync(stagingPath(dir)) ? `${fs.statSync(stagingPath(dir)).size} bytes` : 'missing');

        logs = '';
        const s = await startDaemon(dir);
        check('R2 restart surfaces the checkpoint honestly in /status',
            typeof s.staging_root === 'string' && s.staging_chunks > 0,
            `staging_root=${s.staging_root} staging_chunks=${s.staging_chunks}`);
        check('R2 the checkpoint is not mistaken for a loaded index', s.vectors === 0, `vectors=${s.vectors}`);

        logs = '';
        const resumed = await runToCompletion('resume');
        check('R3 the daemon logged that it RESUMED the checkpoint', /RESUMING the durable checkpoint/.test(logs),
            (logs.match(/RESUMING the durable checkpoint[^\n]*/) || ['(no resume log)'])[0].slice(0, 140));
        const m = /RESUMING the durable checkpoint[^\n]*?-\s*(\d+) chunks already embedded/.exec(logs);
        const reused = m ? Number(m[1]) : 0;
        check('R3 it reused the already-embedded chunks', reused >= 190, `reused=${reused}`);
        check('R3 the resumed run still reports the ROOT total (not just the remainder)',
            resumed.job.new_chunks === fullVectors,
            `new_chunks=${resumed.job.new_chunks} full=${fullVectors}`);
        check('R4 RESUME == REBUILD (same final vector count)', resumed.job.total_vectors === fullVectors,
            `resume=${resumed.job.total_vectors} rebuild=${fullVectors}`);
        check('R5 the completed rebuild cleared the checkpoint', !fs.existsSync(stagingPath(dir)));
        check('R2 /status no longer reports a pending checkpoint',
            (await getStatus()).staging_root === null || (await getStatus()).staging_root === undefined);
        await stopDaemon();
    }
    console.log('');

    // ── Case C: a corrupt checkpoint must be discarded loudly, never trusted ──
    console.log('Case C — corrupt checkpoint (never trusted blindly)');
    {
        const dir = freshDataDir('corrupt');
        fs.writeFileSync(stagingPath(dir), Buffer.alloc(128, 0x41));
        logs = '';
        const s = await startDaemon(dir);
        check('R6 a corrupt checkpoint is reported as unusable',
            /staging checkpoint is present but unusable/.test(logs),
            (logs.match(/staging checkpoint is present but unusable[^\n]*/) || ['(no warning)'])[0].slice(0, 120));
        check('R6 it is not surfaced as a valid resume', !s.staging_root, `staging_root=${s.staging_root}`);
        const { job } = await runToCompletion('corrupt-rebuild');
        check('R6 the rebuild still completes correctly', job.state === 'done' && job.total_vectors === fullVectors,
            `state=${job.state} vectors=${job.total_vectors}`);
        await stopDaemon();
    }
    console.log('');
}

main()
    .catch((err) => {
        console.error('HARNESS ERROR: ' + (err && err.message ? err.message : String(err)));
        process.exitCode = 1;
    })
    .finally(async () => {
        await stopDaemon();
        try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
        const failed = results.filter((r) => !r.ok);
        console.log(`Phase-0/2 invariants: ${results.length - failed.length}/${results.length} passed`);
        if (failed.length) {
            for (const f of failed) console.error(`  FAILED: ${f.name} — ${f.detail}`);
            process.exitCode = 1;
        }
    });
