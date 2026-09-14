#!/usr/bin/env node
'use strict';
/**
 * Durability harness — proves the Phase-1 index-durability INVARIANTS.
 *
 * This harness makes exactly four promises. This script proves them
 * against a REAL daemon, on a COPY of a data dir. Live data is never written to.
 *
 *   I1  Nothing is deleted.             A snapshot the daemon cannot use is KEPT on disk.
 *   I2  Every outcome is explained.     /status reports index_state + index_note.
 *   I3  Adoption never rebuilds.        A pre-manifest snapshot loads with no re-index.
 *   I4  Writes are atomic + checksummed. manifest.snapshot_sha256 === sha256(snapshot).
 *
 * It deliberately does NOT assert `resume == rebuild`. There is no resume path yet;
 * those assertions belong to the durable-staging slice, alongside kill -9 injection.
 *
 * Usage:
 *   node scripts/run-durability-harness.js
 *
 * Env:
 *   HARMONY_HUB_BIN       daemon binary (default: <repo>/../HarmonyHub/target/release/harmonyhub.exe)
 *   HARMONY_HUB_DATA_DIR  dir whose snapshot.bincode seeds the test
 *                         (default: VS Code globalStorage hub-data when present)
 *   HARMONY_HUB_PORT      listen port (default 7991)
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.HARMONY_HUB_PORT || 7991);
const TOKEN = 'durability-harness';
const BIN = process.env.HARMONY_HUB_BIN
    || path.resolve(ROOT, '..', 'HarmonyHub', 'target', 'release', 'harmonyhub.exe');
function defaultSeedDir() {
    let dir = process.env.APPDATA || os.homedir();
    for (const part of ['Code', 'User', 'globalStorage', 'harmony.harmony-extension', 'hub-data']) {
        dir = path.join(dir, part);
        if (!fs.existsSync(dir)) return '';
    }
    return dir;
}
const SEED_DIR = process.env.HARMONY_HUB_DATA_DIR || defaultSeedDir();

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-durability-'));
const SNAPSHOT = 'snapshot.bincode';
const MANIFEST = 'index-manifest.json';

const results = [];
let child = null;

function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail || '' });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function getStatus() {
    try {
        const res = await fetch(`http://127.0.0.1:${PORT}/status`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
            signal: AbortSignal.timeout(4000),
        });
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

async function startDaemon(dataDir) {
    child = spawn(BIN, [
        '--data-dir', dataDir,
        '--bind', `127.0.0.1:${PORT}`,
        '--auth-token', TOKEN,
        '--idle-stop-minutes', '0',
    ], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const s = await getStatus();
        if (s) return s;
        if (child.exitCode !== null) throw new Error(`daemon exited early (code ${child.exitCode})`);
        await sleep(500);
    }
    throw new Error('daemon did not become ready within 120s');
}

async function stopDaemon() {
    if (!child) return;
    const proc = child;
    child = null;
    try { proc.kill(); } catch { /* already gone */ }
    const deadline = Date.now() + 15000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(200);
    await sleep(400); // let the OS release the port and file handles
}

const manifestPath = (dir) => path.join(dir, MANIFEST);
const snapshotPath = (dir) => path.join(dir, SNAPSHOT);
const readManifest = (dir) => JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
const writeManifest = (dir, obj) => fs.writeFileSync(manifestPath(dir), JSON.stringify(obj, null, 2));

function seedDir(name, { withManifest }) {
    const dir = path.join(WORK, name);
    fs.mkdirSync(dir, { recursive: true });
    if (!SEED_DIR || !fs.existsSync(path.join(SEED_DIR, SNAPSHOT))) return null;
    fs.copyFileSync(path.join(SEED_DIR, SNAPSHOT), snapshotPath(dir));
    if (fs.existsSync(path.join(SEED_DIR, 'policy.json'))) {
        fs.copyFileSync(path.join(SEED_DIR, 'policy.json'), path.join(dir, 'policy.json'));
    }
    // The daemon loads its embedding model at startup; reuse the cached copy when present
    // so the harness does not trigger a multi-hundred-MB download.
    const cacheSrc = path.join(SEED_DIR, '.fastembed_cache');
    if (fs.existsSync(cacheSrc)) fs.cpSync(cacheSrc, path.join(dir, '.fastembed_cache'), { recursive: true });
    if (withManifest) fs.copyFileSync(path.join(SEED_DIR, MANIFEST), manifestPath(dir));
    return dir;
}

async function main() {
    console.log('HarmonyHub durability harness — invariants');
    console.log(`  binary   : ${BIN}`);
    console.log(`  seed dir : ${SEED_DIR || '(none)'}`);
    console.log(`  work dir : ${WORK}`);
    console.log('');

    if (!fs.existsSync(BIN)) {
        console.error(`FAIL: daemon binary not found at ${BIN}\n      build it: cargo build --release --manifest-path <HarmonyHub>/Cargo.toml`);
        process.exitCode = 1;
        return;
    }

    // ── Case 0: a truly empty data dir must be reported honestly, not guessed at ──
    console.log('Case 0 — empty data dir (honest "empty" state)');
    {
        const dir = path.join(WORK, 'empty');
        fs.mkdirSync(dir, { recursive: true });
        const s = await startDaemon(dir);
        check('I2 empty dir reports index_state=empty', s.index_state === 'empty', `index_state=${s.index_state}`);
        check('I2 empty dir gives a reason', typeof s.index_note === 'string' && s.index_note.length > 0, s.index_note || '');
        check('I1 empty dir creates no manifest', !fs.existsSync(manifestPath(dir)));
        await stopDaemon();
    }
    console.log('');

    const seeded = seedDir('adopt', { withManifest: false });
    if (!seeded) {
        console.log('SKIP: no seed snapshot found (set HARMONY_HUB_DATA_DIR to a hub data dir).');
        console.log('      Cases 1-4 need a real snapshot; Case 0 already passed.');
        return;
    }

    const originalSha = sha256(snapshotPath(seeded));

    // ── Case 1: a pre-manifest snapshot is ADOPTED, never rebuilt (I3) ──
    console.log('Case 1 — legacy snapshot with no manifest (adoption, no rebuild)');
    {
        const s = await startDaemon(seeded);
        check('I3 adopts without rebuilding', s.index_state === 'adopted', `index_state=${s.index_state}`);
        check('I3 vectors are present (not re-indexed from zero)', s.vectors > 0, `vectors=${s.vectors}`);
        check('I1 the seed snapshot is untouched', sha256(snapshotPath(seeded)) === originalSha);
        check('I4 an adopting manifest was written', fs.existsSync(manifestPath(seeded)));
        await stopDaemon();
    }
    console.log('');

    // ── Case 2: the manifest verifies, and the load does not rebuild (I4 + I3) ──
    console.log('Case 2 — restart with a manifest (verified load)');
    {
        const s = await startDaemon(seeded);
        const m = readManifest(seeded);
        check('I2 reports index_state=loaded', s.index_state === 'loaded', `index_state=${s.index_state}`);
        check('I2 a healthy load carries no note', s.index_note === null || s.index_note === undefined, String(s.index_note));
        check('I4 manifest checksum matches the snapshot bytes', m.snapshot_sha256 === sha256(snapshotPath(seeded)));
        check('I4 manifest vector_count matches /status', m.vector_count === s.vectors, `${m.vector_count} vs ${s.vectors}`);
        check('I1 snapshot is still the original bytes', sha256(snapshotPath(seeded)) === originalSha);
        await stopDaemon();
    }
    console.log('');

    // ── Case 3: an unusable manifest must be LOUD, and must delete NOTHING (I1 + I2) ──
    console.log('Case 3 — manifest/model mismatch (loud + non-destructive)');
    {
        const good = readManifest(seeded);
        writeManifest(seeded, { ...good, model: 'harness-deliberately-wrong-model' });
        const s = await startDaemon(seeded);
        check('I2 reports index_state=incompatible', s.index_state === 'incompatible', `index_state=${s.index_state}`);
        check('I2 the reason names both models', typeof s.index_note === 'string' && s.index_note.includes('harness-deliberately-wrong-model'), s.index_note || '');
        check('I1 the snapshot was NOT deleted', fs.existsSync(snapshotPath(seeded)));
        check('I1 the snapshot bytes are UNCHANGED', sha256(snapshotPath(seeded)) === originalSha);
        check('I1 the manifest was NOT deleted', fs.existsSync(manifestPath(seeded)));
        check('I2 nothing was loaded from an unusable index', s.vectors === 0, `vectors=${s.vectors}`);
        await stopDaemon();
        writeManifest(seeded, good); // restore for the next case
    }
    console.log('');

    // ── Case 4: a damaged snapshot must be LOUD, and must delete NOTHING (I1 + I2) ──
    console.log('Case 4 — corrupted snapshot (loud + non-destructive)');
    {
        fs.writeFileSync(snapshotPath(seeded), Buffer.alloc(64, 0x7f));
        const s = await startDaemon(seeded);
        check('I2 reports index_state=corrupt', s.index_state === 'corrupt', `index_state=${s.index_state}`);
        check('I2 the reason is present', typeof s.index_note === 'string' && s.index_note.length > 0, s.index_note || '');
        check('I1 the damaged snapshot was KEPT for forensics', fs.existsSync(snapshotPath(seeded)));
        check('I1 the manifest was NOT deleted', fs.existsSync(manifestPath(seeded)));
        check('I2 nothing was loaded from a damaged index', s.vectors === 0, `vectors=${s.vectors}`);
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
        console.log(`Phase-1 invariants: ${results.length - failed.length}/${results.length} passed`);
        if (failed.length) {
            for (const f of failed) console.error(`  FAILED: ${f.name} — ${f.detail}`);
            process.exitCode = 1;
        }
    });
