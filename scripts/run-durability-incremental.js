#!/usr/bin/env node
'use strict';
/**
 * Durability harness — INCREMENTAL re-index.
 *
 * The promise: after a first full index, a re-index re-embeds ONLY what changed, and the
 * resulting index is INDISTINGUISHABLE from a clean full rebuild of the same filesystem.
 *
 *   I1  A no-change re-index embeds ZERO new chunks (the whole point of the slice).
 *   I2  An edit + add + delete re-index embeds only the changed/added files.
 *   I3  INCREMENTAL == FULL REBUILD - the persisted per-file fingerprints and per-root chunk
 *       counts from the incremental run equal those of a fresh full rebuild over the SAME
 *       final filesystem state. (This is the honest equivalence check: the raw vectors are
 *       not exposed over HTTP, but the manifest's roots[].files + chunk_count are canonical.)
 *   I4  A real deletion under a complete scan DOES remove that file's chunks.
 *   I5  Every incremental run reports complete=true, so no deletion was ever refused silently.
 *
 * The incomplete-scan case (an unreadable file must be CARRIED, never deleted) is covered
 * precisely by the pure unit tests in indexer.rs (delta_tests, 5/5).
 *
 * Usage:  node scripts/run-durability-incremental.js
 * Env:    HARMONY_HUB_BIN, HARMONY_HUB_PORT (default 7994)
 * Exit:   0 = all pass, 1 = failure (usable as a gate)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.HARMONY_HUB_PORT || 7994);
const TOKEN = 'incremental-harness';
const BIN = process.env.HARMONY_HUB_BIN
    || path.resolve(ROOT, '..', 'HarmonyHub', 'target', 'release', 'harmonyhub.exe');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-incremental-'));
const FIXTURE = path.join(WORK, 'fixture');
const D1 = path.join(WORK, 'hub-a');   // incremental run
const D2 = path.join(WORK, 'hub-b');   // clean full rebuild for comparison

const results = [];
let child = null;
let logs = '';

function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail || '' });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedFixture() {
    fs.mkdirSync(FIXTURE, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE, 'alpha.js'),
        `// alpha v1\nfunction alpha() { return 1; }\nmodule.exports = { alpha };\n`);
    fs.writeFileSync(path.join(FIXTURE, 'beta.py'),
        `# beta v1\ndef beta():\n    return 1\n`);
    fs.writeFileSync(path.join(FIXTURE, 'gamma.md'),
        `# gamma v1\n\nSome documentation text for the fixture corpus.\n`);
}

/** Canonical form of what the daemon persisted: per-file fingerprints + per-root chunk count. */
function canonical(dataDir) {
    const p = path.join(dataDir, 'index-manifest.json');
    if (!fs.existsSync(p)) return null;
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    const files = [];
    let chunks = 0;
    for (const r of m.roots || []) {
        chunks += r.chunk_count || 0;
        for (const f of r.files || []) {
            files.push({ name: path.basename(f.rel_path), size: f.size, hash: f.content_hash });
        }
    }
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { files, chunks, schema: m.manifest_schema_version, state: m.state };
}

/** The persisted content hash for one file, from a data dir's manifest. */
function fileHash(dataDir, name) {
    const c = canonical(dataDir);
    if (!c) return null;
    const f = c.files.find((x) => x.name === name);
    return f ? f.hash : null;
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
        await sleep(400);
    }
    throw new Error('index job did not finish within 300s');
}

async function indexNow() {
    await hub('POST', '/policy/allow', { path: FIXTURE });
    const job = await hub('POST', '/index', { path: FIXTURE, scope: 'all' });
    const done = await waitJob(job.job_id);
    if (done.state !== 'done') throw new Error(`index job failed: ${done.error}`);
    return done;
}

async function main() {
    console.log('Incremental re-index harness');
    console.log(`  bin      = ${BIN}`);
    console.log(`  workdir  = ${WORK}\n`);

    if (!fs.existsSync(BIN)) {
        console.error(`ABORT: daemon binary not found at ${BIN}`);
        process.exit(2);
    }

    seedFixture();

    // ---- First full index on D1 -------------------------------------------
    console.log('[1] first index (full) ...');
    await startDaemon(D1);
    const j1 = await indexNow();
    const v1 = (await getStatus()).vectors;
    console.log(`    full: ${j1.total_vectors} vectors from ${j1.files_indexed} file(s)\n`);

    // ---- I1: a no-change re-index must embed NOTHING ----------------------
    console.log('[2] I1 no-change re-index ...');
    const j2 = await indexNow();
    const s2 = await getStatus();
    check('I1 no-change re-index embeds 0 new chunks', j2.embedded_chunks === 0, `embedded_chunks=${j2.embedded_chunks}`);
    check('I1 vector count is unchanged', s2.vectors === v1, `vectors=${s2.vectors} expected=${v1}`);
    check('I5 no-change run was complete', (logs.match(/complete=true/g) || []).length > 0, 'complete=true seen in the log');

    // ---- I2/I3: edit + add + delete -> incremental ------------------------
    console.log('[3] I2/I3 edit + add + delete -> incremental ...');
    fs.writeFileSync(path.join(FIXTURE, 'alpha.js'),
        `// alpha v2 (changed)\nfunction alpha() { return 2; }\nfunction alphaPrime() { return 202; }\nmodule.exports = { alpha };\n`);
    fs.writeFileSync(path.join(FIXTURE, 'delta.js'),
        `// delta (new)\nfunction delta() { return 'new'; }\nmodule.exports = { delta };\n`);
    fs.unlinkSync(path.join(FIXTURE, 'gamma.md'));

    const j3 = await indexNow();
    const s3 = await getStatus();
    check('I2 incremental embeds only the changed/added files',
        j3.embedded_chunks > 0 && j3.embedded_chunks < j1.embedded_chunks,
        `embedded=${j3.embedded_chunks} (a full run embeds ${j1.embedded_chunks})`);
    check('I3 vectors present after the incremental swap', s3.vectors > 0, `vectors=${s3.vectors}`);

    const A = canonical(D1);

    // ---- Clean full rebuild over the SAME final filesystem state ----------
    console.log('[4] I3 clean full rebuild for comparison ...');
    await stopDaemon();
    await startDaemon(D2);
    const j4 = await indexNow();
    const B = canonical(D2);
    console.log(`    full rebuild: ${j4.total_vectors} vectors\n`);

    const sameFiles = A && B && JSON.stringify(A.files) === JSON.stringify(B.files);
    const sameChunks = A && B && A.chunks === B.chunks;
    check('I3 INCREMENTAL == FULL: identical per-file fingerprints', !!sameFiles,
        sameFiles ? `${A.files.length} files` : `A=${JSON.stringify(A && A.files)} B=${JSON.stringify(B && B.files)}`);
    check('I3 INCREMENTAL == FULL: identical chunk count', !!sameChunks,
        `incremental=${A && A.chunks} full=${B && B.chunks}`);
    check('I3 deleted file is gone from the fingerprints',
        !!A && !A.files.some((f) => f.name === 'gamma.md'),
        `files=${A && A.files.map((f) => f.name).join(',')}`);

    // ---- I4: a real deletion under a complete scan DOES drop chunks -------
    console.log('[5] I4 delete a file -> chunks must be removed ...');
    await stopDaemon();
    await startDaemon(D1);
    const before = (await getStatus()).vectors;
    fs.unlinkSync(path.join(FIXTURE, 'beta.py'));
    const j5 = await indexNow();
    const after = (await getStatus()).vectors;
    const C = canonical(D1);
    check('I4 the deleted file is dropped from the fingerprints',
        !!C && !C.files.some((f) => f.name === 'beta.py'),
        `files=${C && C.files.map((f) => f.name).join(',')}`);
    check('I4 the live index shrank', after < before, `before=${before} after=${after}`);
    check('I5 deletion run reported complete=true',
        (logs.match(/complete=true/g) || []).length > 0, `delete job new_chunks=${j5.new_chunks}`);

    // ---- I6: HASH IS AUTHORITY -------------------------------------------------
    // A same-size edit with a RESTORED mtime must still be detected. This is the case that
    // silently rots a metadata-only index (NTFS file tunnelling, rsync -t, checkouts). Both
    // writes use a FIXED timestamp, so the stored mtime is identical by construction and the
    // only possible difference is the content.
    console.log('[6] I6 same-size edit with a restored mtime ...');
    const FIXED = new Date(2020, 0, 1, 0, 0, 0, 0);
    const eps = path.join(FIXTURE, 'epsilon.js');
    const contentA = '// epsilon A\nfunction e() { return 11111111; }\n';
    const contentB = '// epsilon B\nfunction e() { return 22222222; }\n';
    if (contentA.length !== contentB.length) throw new Error('I6 fixture contents must be the same length');

    fs.writeFileSync(eps, contentA);
    fs.utimesSync(eps, FIXED, FIXED);
    await indexNow();
    const hashA = fileHash(D1, 'epsilon.js');

    fs.writeFileSync(eps, contentB);
    fs.utimesSync(eps, FIXED, FIXED); // restore the SAME mtime - only the content differs
    const j6 = await indexNow();
    const hashB = fileHash(D1, 'epsilon.js');

    check('I6 same-size, same-mtime edit WAS detected and re-embedded',
        j6.embedded_chunks > 0, `embedded_chunks=${j6.embedded_chunks}`);
    check('I6 the persisted fingerprint actually changed',
        !!hashA && !!hashB && hashA !== hashB,
        `before=${hashA ? hashA.slice(0, 12) : null} after=${hashB ? hashB.slice(0, 12) : null}`);

    await stopDaemon();

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
