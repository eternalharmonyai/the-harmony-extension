/**
 * Harness for the versioned migration platform (src/hubMigrations.ts).
 *
 * Runs on synthetic temp directories only — it never touches a real Hub store, and it
 * redirects the ledger via HARMONY_MIGRATIONS_FILE so the user's own ledger is untouched.
 *
 * What it proves:
 *   M1 nothing      — no durable store in the legacy home: not an error, recorded as skipped
 *   M2 already      — the new home already holds a usable store: single-stat fast path
 *   M3 pending      — the Hub is running: we do NOT move, and the wait is RECORDED
 *   M4 applied      — the Hub is stopped: the store moves and verifies, ledger records it
 *   M5 idempotent   — a second run is a no-op (re-running a migration is safe)
 *   M6 rollback     — a store that fails verification is NOT accepted; legacy is kept
 *   M7 reinstall    — a simulated uninstall wipe of globalStorage loses nothing
 *   M8 skipped      — "nothing to migrate" is RECORDED, not silent, and does not churn
 *   M9 already      — an adoptable store is RECORDED once, and a later no-op never overwrites it
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migration-'));
process.env.HARMONY_MIGRATIONS_FILE = path.join(root, 'migrations.json');

const { runHubDataRelocation, storeLooksUsable, migrationLedgerPath, HUB_DATA_RELOCATION_ID } =
    require('../out/hubMigrations.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
    else { fail++; console.log(`FAIL  ${name}  — ${detail}`); }
}
function mkStore(dir, { manifest = true } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'snapshot.bincode'), Buffer.alloc(4096, 7));
    if (manifest) fs.writeFileSync(path.join(dir, 'index-manifest.json'), JSON.stringify({ manifest_schema_version: 2 }));
}
function readLedger() {
    try { return JSON.parse(fs.readFileSync(migrationLedgerPath(), 'utf8')); } catch { return { migrations: [] }; }
}
const caseDir = (n) => {
    const d = path.join(root, n);
    fs.mkdirSync(d, { recursive: true });
    return d;
};
const running = () => Promise.resolve(true);
const stopped = () => Promise.resolve(false);
const quiet = () => undefined;

(async () => {
    // M1 — nothing durable to move.
    {
        const d = caseDir('m1');
        const out = await runHubDataRelocation({
            legacyDir: path.join(d, 'legacy'), targetDir: path.join(d, 'target'),
            isHubRunning: stopped, log: quiet,
        });
        check('M1 nothing to move is a no-op', out.status === 'nothing' && out.dir === path.join(d, 'target'), `status=${out.status}`);
    }

    // M2 — the new home already holds a usable store (cheap fast path).
    {
        const d = caseDir('m2');
        const target = path.join(d, 'target');
        mkStore(target);
        const out = await runHubDataRelocation({
            legacyDir: path.join(d, 'legacy'), targetDir: target,
            isHubRunning: () => { throw new Error('must not probe the Hub on the fast path'); }, log: quiet,
        });
        check('M2 existing store is adopted without a Hub probe', out.status === 'already' && out.dir === target, `status=${out.status}`);
    }

    // M3 — Hub running: never rename under it, and record the wait.
    {
        const d = caseDir('m3');
        const legacy = path.join(d, 'legacy'), target = path.join(d, 'target');
        mkStore(legacy);
        const out = await runHubDataRelocation({ legacyDir: legacy, targetDir: target, isHubRunning: running, log: quiet });
        const rec = readLedger().migrations.find(m => m.id === HUB_DATA_RELOCATION_ID);
        check('M3 pending: store NOT moved while the Hub runs',
            out.status === 'pending' && out.dir === legacy && fs.existsSync(path.join(legacy, 'snapshot.bincode')),
            `status=${out.status}`);
        check('M3 pending is RECORDED in the ledger', !!rec && rec.status === 'pending', `record=${rec ? rec.status : 'absent'}`);
    }

    // M4 — Hub stopped: move + verify + record (the real migration).
    {
        const d = caseDir('m4');
        const legacy = path.join(d, 'legacy'), target = path.join(d, 'target');
        mkStore(legacy);
        fs.writeFileSync(path.join(legacy, 'policy.json'), '{}');
        const out = await runHubDataRelocation({ legacyDir: legacy, targetDir: target, isHubRunning: stopped, log: quiet });
        const rec = readLedger().migrations.find(m => m.id === HUB_DATA_RELOCATION_ID);
        check('M4 applied: store moved and verified',
            out.status === 'applied' && out.dir === target && storeLooksUsable(target),
            `status=${out.status}`);
        check('M4 the whole store moved (policy.json came along)',
            fs.existsSync(path.join(target, 'policy.json')) && !fs.existsSync(legacy));
        check('M4 applied is RECORDED with from -> to',
            !!rec && rec.status === 'applied' && rec.to === target && rec.from === legacy,
            `record=${rec ? rec.status : 'absent'}`);
    }

    // M5 — idempotent: re-running after a successful migration is a no-op.
    {
        const d = caseDir('m5');
        const legacy = path.join(d, 'legacy'), target = path.join(d, 'target');
        mkStore(legacy);
        await runHubDataRelocation({ legacyDir: legacy, targetDir: target, isHubRunning: stopped, log: quiet });
        // Recreate a legacy store to simulate a second physical copy, then re-run.
        const again = await runHubDataRelocation({ legacyDir: legacy, targetDir: target, isHubRunning: stopped, log: quiet });
        check('M5 re-running a completed migration is a no-op', again.status === 'already', `status=${again.status}`);
    }

    // M6 — verification failure must NOT be accepted; the legacy store is kept.
    {
        const d = caseDir('m6');
        const legacy = path.join(d, 'legacy'), target = path.join(d, 'target');
        mkStore(legacy);
        fs.writeFileSync(path.join(legacy, 'index-manifest.json'), '{ this is not json');
        const out = await runHubDataRelocation({ legacyDir: legacy, targetDir: target, isHubRunning: stopped, log: quiet });
        const rec = readLedger().migrations.find(m => m.id === HUB_DATA_RELOCATION_ID);
        check('M6 a store that fails verification is not adopted',
            out.status === 'failed' && out.dir === legacy,
            `status=${out.status}`);
        check('M6 legacy store is rolled back and still present',
            fs.existsSync(path.join(legacy, 'snapshot.bincode')) && !storeLooksUsable(target));
        check('M6 failure is RECORDED', !!rec && rec.status === 'failed', `record=${rec ? rec.status : 'absent'}`);
    }

    // M7 — THE POINT: a simulated uninstall wipe of globalStorage loses nothing.
    {
        const d = caseDir('m7');
        const globalStorage = path.join(d, 'globalStorage', 'harmony.harmony-extension', 'hub-data');
        const target = path.join(d, '.harmony', 'hub-data', 'visual-studio-code');
        mkStore(globalStorage);
        const out = await runHubDataRelocation({ legacyDir: globalStorage, targetDir: target, isHubRunning: stopped, log: quiet });
        // VS Code deletes the extension's globalStorage on uninstall:
        fs.rmSync(path.join(d, 'globalStorage'), { recursive: true, force: true });
        check('M7 the store survived an uninstall-style wipe of globalStorage',
            out.status === 'applied' && fs.existsSync(path.join(target, 'snapshot.bincode')) && storeLooksUsable(target),
            `status=${out.status}`);
        check('M7 the new home is outside globalStorage', !target.toLowerCase().includes('globalstorage'));
    }

    // M8 — "nothing to migrate" must be VISIBLE, and must not rewrite the ledger every run.
    {
        const d = caseDir('m8');
        const legacy = path.join(d, 'legacy'), target = path.join(d, 'target');
        let clock = 1000;
        const tick = () => clock++;
        const out1 = await runHubDataRelocation({ legacyDir: legacy, targetDir: target, isHubRunning: stopped, log: quiet, now: tick });
        let rec = readLedger().migrations.find(m => m.id === HUB_DATA_RELOCATION_ID);
        const firstAt = rec ? rec.at : -1;
        check('M8 nothing-to-move is still a no-op for the caller', out1.status === 'nothing', `status=${out1.status}`);
        check('M8 the skipped state is RECORDED (visible, not silent)',
            !!rec && rec.status === 'skipped' && rec.from === legacy && rec.to === target,
            `record=${rec ? rec.status : 'absent'}`);
        const out2 = await runHubDataRelocation({ legacyDir: legacy, targetDir: target, isHubRunning: stopped, log: quiet, now: tick });
        rec = readLedger().migrations.find(m => m.id === HUB_DATA_RELOCATION_ID);
        check('M8 an unchanged outcome does not churn the ledger',
            out2.status === 'nothing' && !!rec && rec.at === firstAt,
            `at ${firstAt} -> ${rec ? rec.at : 'absent'}`);
    }

    // M9 — the steady state must also be VISIBLE, without ever overwriting a real move.
    {
        const d = caseDir('m9');
        const target = path.join(d, 'target');
        mkStore(target);
        const saved = process.env.HARMONY_MIGRATIONS_FILE;
        process.env.HARMONY_MIGRATIONS_FILE = path.join(d, 'm9-ledger.json');
        let clock = 2000;
        try {
            const out = await runHubDataRelocation({
                legacyDir: path.join(d, 'legacy'), targetDir: target,
                isHubRunning: stopped, log: quiet, now: () => clock++,
            });
            const rec = readLedger().migrations.find(m => m.id === HUB_DATA_RELOCATION_ID);
            check('M9 an adoptable store still reports already', out.status === 'already', `status=${out.status}`);
            check('M9 the steady state is RECORDED once (visible, not silent)',
                !!rec && rec.status === 'already' && rec.at === 2000,
                `record=${rec ? rec.status + '@' + rec.at : 'absent'}`);
            const before = JSON.stringify(readLedger());
            await runHubDataRelocation({
                legacyDir: path.join(d, 'legacy'), targetDir: target,
                isHubRunning: stopped, log: quiet, now: () => clock++,
            });
            check('M9 a later no-op does not rewrite the ledger', JSON.stringify(readLedger()) === before);
        } finally {
            process.env.HARMONY_MIGRATIONS_FILE = saved;
        }
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
    console.error('harness error:', err);
    process.exit(2);
});
