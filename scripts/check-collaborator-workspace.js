#!/usr/bin/env node
/**
 * Gate: Collaborator workspace (L0 physical isolation).
 *
 * Loads the REAL compiled module and drives it with a fake git runner, so this gate
 * proves the logic without creating worktrees, mutating the repo, or requiring git.
 *
 * Run: npm run check:collaborator-workspace
 */
'use strict';

const path = require('path');
const mod = require(path.join(__dirname, '..', 'out', 'collaboratorWorkspace.js'));

const {
    COLLAB_ROOT,
    WORKTREES_DIR,
    RETENTION_DAYS,
    isValidRunId,
    assertValidRunId,
    makeRunId,
    branchForRun,
    worktreePathFor,
    isInsideCollabRoot,
    canTransition,
    assertTransition,
    planRetention,
    createRunWorktree,
    listWorktrees,
    removeRunWorktree,
    describeRun,
    createLazyRun,
    hasResolvedBase,
    loadRuns,
    saveRun,
    runsFilePath,
    materializeRun,
    MAX_RUNS_KEPT,
} = mod;

let pass = 0;
const failures = [];
function check(name, condition, detail) {
    if (condition) pass++;
    else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function throws(name, fn, match) {
    try {
        fn();
        failures.push(`${name} — expected a throw, got none`);
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (match && !msg.includes(match)) failures.push(`${name} — threw but message lacked ${JSON.stringify(match)}: ${msg}`);
        else pass++;
    }
}

const ROOT = process.cwd();

// ── 1. Constants reflect the ratified decisions ────────────────────────────
check('collab root is .harmony/collab', COLLAB_ROOT === '.harmony/collab', COLLAB_ROOT);
check('worktrees dir under collab root', WORKTREES_DIR === '.harmony/collab/worktrees', WORKTREES_DIR);
check('retention is 90 days as ratified', RETENTION_DAYS === 90, String(RETENTION_DAYS));

// ── 2. P1: run ids cannot become traversal ────────────────────────────────
check('accepts a normal id', isValidRunId('r-1700000000000-abc123'));
check('accepts short id', isValidRunId('abc'));
check('rejects empty', !isValidRunId(''));
check('rejects uppercase', !isValidRunId('ABC'));
check('rejects dots (traversal)', !isValidRunId('../../etc'));
check('rejects forward slash', !isValidRunId('a/b'));
check('rejects backslash', !isValidRunId('a\\b'));
check('rejects drive letter', !isValidRunId('c:evil'));
check('rejects too short', !isValidRunId('ab'));
check('rejects too long', !isValidRunId('a'.repeat(65)));
check('rejects non-string', !isValidRunId(null));
throws('assertValidRunId refuses traversal', () => assertValidRunId('../x'), 'invalid run id');

// ── 3. Run identity ───────────────────────────────────────────────────────
const id = makeRunId(1700000000000, 'deadbeef');
check('makeRunId is deterministic given inputs', id === 'r-1700000000000-deadbeef', id);
check('makeRunId output is valid', isValidRunId(id));
check('makeRunId with random suffix is valid', isValidRunId(makeRunId()));
check('branch is namespaced', branchForRun(id) === `collab/${id}`, branchForRun(id));
throws('branchForRun validates its input', () => branchForRun('../x'), 'invalid run id');

// ── 4. P1: derived paths stay inside the sandbox ──────────────────────────
const wtPath = worktreePathFor(ROOT, id);
check('worktree path is inside collab root', isInsideCollabRoot(ROOT, wtPath), wtPath);
check('worktree path ends with run id', wtPath.endsWith(id));
throws('worktreePathFor refuses traversal ids', () => worktreePathFor(ROOT, '../../../evil'), 'invalid run id');
check('isInsideCollabRoot accepts the worktrees base', isInsideCollabRoot(ROOT, path.resolve(ROOT, WORKTREES_DIR)));
check('isInsideCollabRoot rejects the repo root', !isInsideCollabRoot(ROOT, path.resolve(ROOT)));
check('isInsideCollabRoot rejects a sibling escape', !isInsideCollabRoot(ROOT, path.resolve(ROOT, '.harmony/../evil')));
check('isInsideCollabRoot rejects a prefix lookalike', !isInsideCollabRoot(ROOT, path.resolve(ROOT, '.harmony/collab-evil/x')));

// ── 5. Status machine: archived is terminal ──────────────────────────────
check('created -> active', canTransition('created', 'active'));
check('active -> completed', canTransition('active', 'completed'));
check('completed -> archived', canTransition('completed', 'archived'));
check('archived is terminal', !canTransition('archived', 'active'));
check('cannot skip backwards', !canTransition('completed', 'active'));
check('cannot go created -> completed', !canTransition('created', 'completed'));
throws('assertTransition enforces the machine', () => assertTransition('archived', 'active'), 'illegal run transition');

// ── 6. P2: retention never deletes, always announces ─────────────────────
const DAY = 24 * 60 * 60 * 1000;
const now = 1700000000000;
const mk = (runId, ageDays, createdAtOverride) => ({
    runId,
    branch: `collab/${runId}`,
    baseCommit: 'abcdef1234567890',
    createdAt: createdAtOverride !== undefined ? createdAtOverride : new Date(now - ageDays * DAY).toISOString(),
    status: 'completed',
    path: '/tmp/x',
});

const plan = planRetention(
    [mk('fresh', 1), mk('edge', 90), mk('old', 200), mk('bad', 0, 'not-a-date')],
    { now }
);
check('fresh run retained', plan.retained.some((r) => r.runId === 'fresh'));
check('run at exactly 90 days is expired', plan.expired.some((r) => r.runId === 'edge'));
check('old run expired', plan.expired.some((r) => r.runId === 'old'));
check('unparseable timestamp is NOT expired', plan.unknownAge.some((r) => r.runId === 'bad'));
check('unparseable timestamp not counted as retained', !plan.retained.some((r) => r.runId === 'bad'));
check('plan announces the retention window', plan.announcement.includes('90 days'), plan.announcement);
check('plan states nothing was removed', /Nothing has been removed/i.test(plan.announcement), plan.announcement);
check('plan reports unknown-age count', plan.announcement.includes('unreadable'), plan.announcement);
check('plan never mutates its input', plan.expired.length + plan.retained.length + plan.unknownAge.length === 4);
check('plan carries the window it used', plan.retentionDays === 90);

const emptyPlan = planRetention([], { now });
check('empty plan still announces', emptyPlan.announcement.length > 20, emptyPlan.announcement);
check('empty plan has no expired runs', emptyPlan.expired.length === 0);

// ── 7. createRunWorktree drives git correctly ────────────────────────────
function fakeGit(responses) {
    const calls = [];
    const run = (args, cwd) => {
        calls.push({ args, cwd });
        const key = args[0];
        if (responses && Object.prototype.hasOwnProperty.call(responses, key)) return responses[key];
        return '';
    };
    run.calls = calls;
    return run;
}

const git2 = fakeGit({ 'rev-parse': 'deadbeef1234567890abcdef1234567890abcdef', worktree: '' });

const record = createRunWorktree({
    workspaceRoot: ROOT,
    runId: id,
    role: 'implementer',
    label: 'chat features',
    git: git2,
    now,
});

check('record captures the resolved base commit', record.baseCommit === 'deadbeef1234567890abcdef1234567890abcdef', record.baseCommit);
check('record status is created', record.status === 'created');
check('record path is the sandbox', record.path === wtPath, record.path);
check('record branch is namespaced', record.branch === `collab/${id}`);
check('record carries role', record.role === 'implementer');
check('record carries label', record.label === 'chat features');
check('re-parse resolves base FIRST', git2.calls[0].args[0] === 'rev-parse', JSON.stringify(git2.calls[0]));
check('worktree add comes second', git2.calls[1].args[0] === 'worktree', JSON.stringify(git2.calls[1]));
check('worktree add uses -b', git2.calls[1].args.includes('-b'));
check('worktree add target is the sandbox', git2.calls[1].args.includes(wtPath));
check('worktree add base is the resolved commit', git2.calls[1].args.includes(record.baseCommit));
check('git runs from the workspace root', git2.calls.every((c) => c.cwd === ROOT));

const badGit = fakeGit({ 'rev-parse': 'not-a-sha' });
throws('refuses an unresolvable base commit', () => createRunWorktree({ workspaceRoot: ROOT, runId: id, git: badGit }), 'base commit');
throws('createRunWorktree refuses traversal ids', () => createRunWorktree({ workspaceRoot: ROOT, runId: '../x', git: badGit }), 'invalid run id');

// ── 8. listWorktrees is read-only and parses porcelain ───────────────────
const listGit = fakeGit({
    worktree: `worktree ${path.resolve(ROOT, WORKTREES_DIR, 'aaa')}\nHEAD deadbeef\nbranch refs/heads/collab/aaa\n\nworktree ${path.resolve(ROOT, WORKTREES_DIR, 'bbb')}\nHEAD cafebabe\n`,
});
const listed = listWorktrees(ROOT, listGit);
check('lists both worktrees', listed.length === 2, JSON.stringify(listed));
check('list includes aaa', listed.some((p) => p.endsWith('aaa')));
check('list includes bbb', listed.some((p) => p.endsWith('bbb')));
check('list only ran a read command', listGit.calls.every((c) => c.args[0] === 'worktree' && c.args.includes('--porcelain')));

// ── 9. removeRunWorktree refuses anything outside the sandbox ────────────
const rmGit = fakeGit({ worktree: '' });
removeRunWorktree(ROOT, id, { git: rmGit });
check('remove targets the sandbox path', rmGit.calls[0].args.includes(wtPath));
check('remove does not force by default', !rmGit.calls[0].args.includes('--force'));

const rmGit2 = fakeGit({ worktree: '' });
removeRunWorktree(ROOT, id, { git: rmGit2, force: true });
check('remove honours force when asked', rmGit2.calls[0].args.includes('--force'));
throws('remove refuses traversal ids', () => removeRunWorktree(ROOT, '../../x', { git: rmGit }), 'invalid run id');

// ── 10. describeRun is readable and mentions the base commit ────────────
const described = describeRun(record);
check('describeRun includes run id', described.includes(id));
check('describeRun includes status', described.includes('created'));
check('describeRun shows a short base commit', described.includes('deadbeef'), described);
check('describeRun includes the role', described.includes('implementer'));

// ── 11. Lazy runs: free on every dispatch, no git, no directory ─────────
const lazy = createLazyRun({ role: 'implementer', label: 'chat features', now });
check('lazy run is valid', isValidRunId(lazy.runId), lazy.runId);
check('lazy run starts as created', lazy.status === 'created');
check('lazy run has no resolved base', lazy.baseCommit === '', JSON.stringify(lazy.baseCommit));
check('lazy run has no path yet', lazy.path === '', JSON.stringify(lazy.path));
check('lazy run has a branch name', lazy.branch === `collab/${lazy.runId}`);
check('lazy run carries role and label', lazy.role === 'implementer' && lazy.label === 'chat features');
check('lazy run has a parseable timestamp', Number.isFinite(Date.parse(lazy.createdAt)), lazy.createdAt);
check('hasResolvedBase false before materialising', hasResolvedBase(lazy) === false);
check('hasResolvedBase true when set', hasResolvedBase({ ...lazy, baseCommit: 'deadbeef' }) === true);
check('hasResolvedBase rejects garbage', hasResolvedBase({ ...lazy, baseCommit: 'not-a-sha' }) === false);
const lazyDefaultId = createLazyRun();
check('lazy run generates its own id', isValidRunId(lazyDefaultId.runId), lazyDefaultId.runId);
check('lazy run ids are unique across calls', createLazyRun().runId !== createLazyRun().runId);

// ── 12. Run store round-trips and is bounded ────────────────────────────
const fsMod = require('fs');
const osMod = require('os');
const tmpRoot = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'harmony-collab-'));
try {
    check('empty store reads as empty with no warning', loadRuns(tmpRoot).runs.length === 0 && !loadRuns(tmpRoot).warning);
    check('runs file path is under collab root', runsFilePath(tmpRoot).includes(path.join('.harmony', 'collab')));

    const written1 = saveRun(tmpRoot, lazy);
    check('saveRun reports the count', written1 === 1, String(written1));
    const back = loadRuns(tmpRoot);
    check('saved run round-trips', back.runs.length === 1 && back.runs[0].runId === lazy.runId);
    check('round-trip preserves the role', back.runs[0].role === 'implementer');
    check('round-trip is clean', !back.warning);

    // Saving the same run id must replace, not duplicate.
    saveRun(tmpRoot, { ...lazy, status: 'active' });
    const afterUpsert = loadRuns(tmpRoot);
    check('re-saving the same id does not duplicate', afterUpsert.runs.length === 1, String(afterUpsert.runs.length));
    check('re-saving updates the record', afterUpsert.runs[0].status === 'active', afterUpsert.runs[0].status);

    // Bounding
    for (let i = 0; i < MAX_RUNS_KEPT + 5; i++) {
        saveRun(tmpRoot, { ...lazy, runId: makeRunId(now + i, `k${i}`) });
    }
    const bounded = loadRuns(tmpRoot);
    check('store is bounded to MAX_RUNS_KEPT', bounded.runs.length <= MAX_RUNS_KEPT, String(bounded.runs.length));
    check('store kept the newest records', bounded.runs[bounded.runs.length - 1].runId.includes('k'), bounded.runs[bounded.runs.length - 1].runId);

    // Corrupt file must not throw, and must say so.
    fsMod.writeFileSync(runsFilePath(tmpRoot), '{not json', 'utf8');
    const corrupt = loadRuns(tmpRoot);
    check('corrupt store does not throw', Array.isArray(corrupt.runs));
    check('corrupt store reports a warning', typeof corrupt.warning === 'string' && corrupt.warning.length > 0, String(corrupt.warning));

    // A non-array payload must be rejected, not iterated.
    fsMod.writeFileSync(runsFilePath(tmpRoot), '{"nope":1}', 'utf8');
    const notArray = loadRuns(tmpRoot);
    check('non-array store is ignored', notArray.runs.length === 0);
    check('non-array store warns', !!notArray.warning);

    // Malformed records inside a valid array are skipped, and counted.
    fsMod.writeFileSync(runsFilePath(tmpRoot), JSON.stringify([{ runId: 'good-one' }, { runId: '../../evil' }, { nope: true }]), 'utf8');
    const mixed = loadRuns(tmpRoot);
    check('valid records survive', mixed.runs.length === 1, String(mixed.runs.length));
    check('traversal-shaped ids are dropped', !mixed.runs.some((r) => r.runId.includes('..')));
    check('dropped records are reported', !!mixed.warning, String(mixed.warning));

    // saveRun refuses a traversal id outright.
    throws('saveRun refuses a traversal id', () => saveRun(tmpRoot, { ...lazy, runId: '../evil' }), 'invalid run id');
} finally {
    try { fsMod.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── 13. materializeRun costs nothing until asked, then records the base ──
const lazyWtPath = worktreePathFor(ROOT, lazy.runId);
const matGit = fakeGit({ 'rev-parse': 'cafebabe1234567890abcdef1234567890abcdef', worktree: '' });
const materialized = materializeRun(ROOT, { ...lazy, path: '' }, { git: matGit });
check('materialize resolves the base commit', materialized.baseCommit === 'cafebabe1234567890abcdef1234567890abcdef');
check('materialize sets hasResolvedBase', hasResolvedBase(materialized) === true);
check('materialize records the sandbox path', materialized.path === lazyWtPath, materialized.path);
check('materialize path is inside the sandbox root', isInsideCollabRoot(ROOT, materialized.path), materialized.path);
check('materialize created the worktree branch', matGit.calls[1].args.includes('-b'));
check('materialize targets the sandbox', matGit.calls[1].args.includes(lazyWtPath), JSON.stringify(matGit.calls[1].args));
throws('materialize refuses a bad base', () => materializeRun(ROOT, lazy, { git: fakeGit({ 'rev-parse': 'nope', worktree: '' }) }), 'base commit');
throws('materialize refuses a traversal run id', () => materializeRun(ROOT, { ...lazy, runId: '../x' }, { git: matGit }), 'invalid run id');

// ── 14. materializeRunById transitions created -> active, persists, and is idempotent ──
const tmpMatRoot = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'harmony-collab-mat-'));
try {
    const { materializeRunById } = mod;
    const savedLazy = createLazyRun({ role: 'implementer', label: 'materialize test', now });
    saveRun(tmpMatRoot, savedLazy);
    const matByIdGit = fakeGit({ 'rev-parse': '11223344556677889900aabbccddeeff00112233', worktree: '' });
    const firstMat = materializeRunById(tmpMatRoot, savedLazy.runId, { git: matByIdGit });
    check('materializeRunById transitions status to active', firstMat.run.status === 'active', firstMat.run.status);
    check('materializeRunById sets alreadyMaterialized=false on first call', firstMat.alreadyMaterialized === false);
    check('materializeRunById persists active run to runs.json', loadRuns(tmpMatRoot).runs[0].status === 'active');
    const secondMat = materializeRunById(tmpMatRoot, savedLazy.runId, { git: matByIdGit });
    check('materializeRunById is idempotent on second call', secondMat.alreadyMaterialized === true && matByIdGit.calls.length === 2);
    throws('materializeRunById refuses unknown runId', () => materializeRunById(tmpMatRoot, 'r-9999999999999-missing', { git: matByIdGit }), 'not found');

    //Archived or completed runs must be refused even when baseCommit is already resolved.
    saveRun(tmpMatRoot, { ...firstMat.run, status: 'archived' });
    throws('materializeRunById refuses an archived run even with resolved base', () => materializeRunById(tmpMatRoot, savedLazy.runId, { git: matByIdGit }), 'illegal run transition');

    // Tampered branch in ledger must be refused rather than forwarded to git argv.
    throws('materializeRun refuses a tampered branch name', () => materializeRun(ROOT, { ...lazy, branch: '--force' }, { git: matGit }), 'does not match expected');
} finally {
    try { fsMod.rmSync(tmpMatRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Report ───────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length === 0) {
    console.log(`✅ check:collaborator-workspace — ${pass}/${total} assertions passed`);
    process.exit(0);
}
console.error(`❌ check:collaborator-workspace — ${failures.length} of ${total} failed:\n`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
