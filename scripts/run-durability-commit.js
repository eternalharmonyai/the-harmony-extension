#!/usr/bin/env node
'use strict';
/**
 * Durability harness — commit window (the crash between publishing the snapshot and
 * committing its manifest).
 *
 * WHY THIS EXISTS
 *   store.rs::snapshot() publishes in this order:
 *       write tmp -> fsync -> copy snapshot -> snapshot.prev -> rename(snapshot) ->
 *       fsync_dir -> write_manifest(LAST)
 *   A crash (or `taskkill /F`, which stopDaemon() can issue) in the gap between the
 *   rename and the manifest write leaves a NEW snapshot.bincode beside an OLD
 *   index-manifest.json. On boot the checksum gate sees
 *       manifest.snapshot_sha256 != sha(live snapshot)
 *   and reports state="corrupt" -> a forced full rebuild of an index that is
 *   perfectly healthy. That is the exact cost this subsystem exists to prevent.
 *
 *   this window was identified during design review; this harness
 *   reproduces it deterministically so the fix can be PROVEN rather than asserted.
 *
 * WHAT IT ASSERTS (desired behaviour, not today's)
 *   C1  Artifact P (manifest newer than the live snapshot): recover to a COMPLETE
 *       generation. Never "corrupt", never a forced rebuild.
 *   C2  Artifact Q (live snapshot newer than the manifest): adopt the COMPLETE newer
 *       generation. Never "corrupt".
 *   C3  A genuinely torn snapshot is STILL reported "corrupt" and KEPT (no false
 *       optimism) - the fix must not make us blind to real damage.
 *   C4  Generation is monotonic: recovery never moves it backwards.
 *   C5  Recovery is EXPLAINED (index_note is present and non-empty).
 *   C6  Recovery preserves the vector count (nothing silently dropped).
 *
 * The artifacts are built by copying REAL files + editing the REAL manifest JSON, so
 * the reproduction is faithful and needs no daemon test hooks.
 *
 * Usage:  node scripts/run-durability-commit.js
 * Env:    HARMONY_HUB_BIN, HARMONY_HUB_PORT (default 7993)
 * Exit:   0 = all pass, 1 = at least one failure (suitable as a gate)
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.HARMONY_HUB_PORT || 7993);
const TOKEN = 'commit-harness';
const BIN = process.env.HARMONY_HUB_BIN
    || path.resolve(ROOT, '..', 'HarmonyHub', 'target', 'release', 'harmonyhub.exe');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-commit-'));
const DATA = path.join(WORK, 'hub-data');
const FIXTURE = path.join(WORK, 'fixture');

const SNAP = path.join(DATA, 'snapshot.bincode');
const SNAP_PREV = path.join(DATA, 'snapshot.prev.bincode');
const MANIFEST = path.join(DATA, 'index-manifest.json');
const MANIFEST_PREV = path.join(DATA, 'index-manifest.prev.json');

const results = [];
let child = null;
let logs = '';

function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail || '' });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readManifest() {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}
function writeManifest(obj) {
    fs.writeFileSync(MANIFEST, JSON.stringify(obj, null, 2));
}

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
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
    return res.json();
}

async function startDaemon() {
    child = spawn(BIN, [
        '--data-dir', DATA,
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
        if (child.exitCode !== null) throw new Error(`daemon exited early (${child.exitCode})\n${logs.slice(-2000)}`);
        await sleep(400);
    }
    throw new Error('daemon did not become ready within 180s');
}

async function stopDaemon() {
    if (!child) return;
    try { child.kill(); } catch { /* ignore */ }
    await sleep(700);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    await sleep(500);
    child = null;
}

async function waitJob(jobId) {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
        const j = await hub('GET', `/index/status/${jobId}`);
        if (j.state !== 'running') return j;
        await sleep(500);
    }
    throw new Error('index job did not finish within 300s');
}

async function indexNow(label) {
    await hub('POST', '/policy/allow', { path: FIXTURE });
    const job = await hub('POST', '/index', { path: FIXTURE, scope: 'all' });
    const done = await waitJob(job.job_id);
    if (done.state !== 'done') throw new Error(`index '${label}' failed: ${done.error}`);
    return done;
}

function seedFixture(version) {
    fs.mkdirSync(FIXTURE, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE, 'alpha.js'),
        `// alpha ${version}\nfunction alpha() { return '${version}'; }\nmodule.exports = { alpha };\n`);
    fs.writeFileSync(path.join(FIXTURE, 'beta.py'),
        `# beta ${version}\ndef beta():\n    return "${version}"\n`);
}

async function main() {
    console.log('Commit-window durability harness');
    console.log(`  bin      = ${BIN}`);
    console.log(`  workdir  = ${WORK}\n`);

    if (!fs.existsSync(BIN)) {
        console.error(`ABORT: daemon binary not found at ${BIN}`);
        console.error('Build it with: cargo build --release --manifest-path ../HarmonyHub/Cargo.toml');
        process.exit(2);
    }

    // ---- Generation 1 -----------------------------------------------------
    seedFixture('v1');
    console.log('[1] generating generation 1 ...');
    await startDaemon();
    const gen1Job = await indexNow('gen1');
    const gen1Vectors = gen1Job.total_vectors;
    const gen1Generation = (await getStatus()).index_generation;
    const gen1SnapshotSha = sha256(SNAP);
    console.log(`    gen1: ${gen1Vectors} vectors, generation ${gen1Generation}\n`);
    await stopDaemon();

    // ---- Generation 2 -----------------------------------------------------
    seedFixture('v2');
    console.log('[2] generating generation 2 ...');
    await startDaemon();
    const gen2Job = await indexNow('gen2');
    const gen2Vectors = gen2Job.total_vectors;
    const gen2SnapshotSha = sha256(SNAP);
    console.log(`    gen2: ${gen2Vectors} vectors\n`);
    await stopDaemon();

    // Snapshot the real artifacts so each scenario starts from a known state.
    const gen2SnapshotBytes = fs.readFileSync(SNAP);
    const gen1SnapshotBytes = fs.existsSync(SNAP_PREV) ? fs.readFileSync(SNAP_PREV) : null;
    const gen1Manifest = fs.existsSync(MANIFEST_PREV)
        ? JSON.parse(fs.readFileSync(MANIFEST_PREV, 'utf8'))
        : null;
    console.log(`    snapshot.prev present: ${gen1SnapshotBytes !== null}`);
    console.log(`    manifest.prev present: ${gen1Manifest !== null}\n`);

    // ---- C1  Artifact P: manifest newer than the live snapshot -------------
    // Faithful artifact of "pending manifest was written, the rename never landed":
    // manifest describes gen2 and says pending; the live snapshot is still gen1.
    console.log('[3] C1 artifact P (manifest pending/ahead, snapshot behind) ...');
    if (gen1SnapshotBytes) {
        fs.writeFileSync(SNAP, gen1SnapshotBytes);
        const m = readManifest();
        m.state = 'pending';
        m.snapshot_sha256 = gen2SnapshotSha;
        writeManifest(m);
        await startDaemon();
        const s = await getStatus();
        check('C1 not reported corrupt', s && s.index_state !== 'corrupt', `state=${s && s.index_state}`);
        check('C1 recovered a complete generation',
            !!s && ['loaded', 'adopted'].includes(s.index_state), `state=${s && s.index_state}`);
        check('C1 recovery explained', !!(s && s.index_note), `note=${s && s.index_note}`);
        await stopDaemon();
    } else {
        check('C1 snapshot.prev existed to build artifact P', false, 'snapshot.prev missing');
    }

    // ---- C2  Artifact Q: live snapshot newer than the manifest -------------
    // Faithful artifact of "rename landed, manifest commit did not complete".
    console.log('[4] C2 artifact Q (snapshot ahead, manifest behind) ...');
    fs.writeFileSync(SNAP, gen2SnapshotBytes);
    if (gen1Manifest) {
        writeManifest(gen1Manifest); // stale manifest, complete state, gen1 sha
        await startDaemon();
        const s = await getStatus();
        check('C2 not reported corrupt', s && s.index_state !== 'corrupt', `state=${s && s.index_state}`);
        check('C2 accepted a complete generation',
            !!s && ['loaded', 'adopted'].includes(s.index_state), `state=${s && s.index_state}`);
        check('C6 recovery preserved vectors',
            !!s && s.vectors === gen2Vectors, `vectors=${s && s.vectors} expected=${gen2Vectors}`);
        check('C4 generation did not move backwards',
            !!s && s.index_generation >= gen1Generation, `generation=${s && s.index_generation}`);
        check('C5 recovery explained', !!(s && s.index_note), `note=${s && s.index_note}`);
        await stopDaemon();
    } else {
        check('C2 manifest.prev existed to build artifact Q', false, 'manifest.prev missing');
    }

    // ---- C3  Genuinely torn snapshot stays corrupt -------------------------
    console.log('[5] C3 genuinely torn snapshot ...');
    fs.writeFileSync(SNAP, gen2SnapshotBytes);
    const torn = Buffer.from(gen2SnapshotBytes.subarray(0, Math.max(64, Math.floor(gen2SnapshotBytes.length / 3))));
    const goodManifest = readManifest();
    goodManifest.state = 'complete';
    goodManifest.snapshot_sha256 = gen2SnapshotSha;
    writeManifest(goodManifest);
    fs.writeFileSync(SNAP, torn);
    await startDaemon();
    const tornStatus = await getStatus();
    check('C3 torn snapshot is reported corrupt', tornStatus && tornStatus.index_state === 'corrupt',
        `state=${tornStatus && tornStatus.index_state}`);
    check('C3 torn snapshot is KEPT (never deleted)', fs.existsSync(SNAP));
    await stopDaemon();

    // ---- Report -----------------------------------------------------------
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log('\nFAILED:');
        for (const f of failed) console.log(`  - ${f.name}  (${f.detail})`);
        console.log('\nDaemon log tail:');
        console.log(logs.slice(-3000));
    }
    fs.rmSync(WORK, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
    console.error('\nHARNESS ERROR:', err && err.message ? err.message : err);
    if (logs) console.error('\nDaemon log tail:\n' + logs.slice(-3000));
    await stopDaemon();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(2);
});
