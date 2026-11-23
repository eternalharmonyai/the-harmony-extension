#!/usr/bin/env node
'use strict';

// Gate: snapshot copy policy must never become a write policy, and .harmony documents must keep
// a real undo path.
//
// HISTORY (2026-11-20):
//   1. createRequiredPreActionSnapshot pushed policy-excluded paths into `failures`, which aborts
//      the snapshot and makes EVERY caller refuse the action. Net effect: an EXISTING file under
//      .harmony/ could not be edited at all, while a NEW file in the same directory edited fine.
//   2. A blanket `.harmony` segment exclude also meant our own notes/plans had NO snapshot at all.
//
// This gate proves all four properties:
//   A. A policy-excluded path still PROCEEDS (with a warning) — it must never refuse the action.
//   B. .harmony documents ARE snapshotted, so they have a real undo path.
//   C. Dangerous subtrees (snapshot stores, live state, private) are still excluded.
//   D. Genuine failures still abort — the safety boundary is intact.
//   E. The two hand-maintained copies (src/snapshotUtils.ts and bin/harmony-cli.js) agree.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'snapshotUtils.ts');
const CLI = path.join(ROOT, 'bin', 'harmony-cli.js');
const COMPILED = path.join(ROOT, 'out', 'snapshotUtils.js');

// The real default cap is 2MB, so the oversize branch is unreachable with a small fixture.
// Force the code's own 256KB floor to be the effective cap instead of inventing a fake one.
process.env.HARMONY_GATE_MAX_BYTES = process.env.HARMONY_GATE_MAX_BYTES || '1';

let pass = 0;
let fail = 0;

function ok(name, detail) { pass += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
function bad(name, detail) { fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
function check(name, condition, detail) { condition ? ok(name, detail) : bad(name, detail); }

console.log('check:snapshot-exclusion');
console.log('checks scheduled: 2 structural + 4 canary/parity + 15 behavioural + 3 formatter = 24');

if (!fs.existsSync(SOURCE)) { console.log(`  FAIL  source missing: ${SOURCE}`); process.exit(2); }
if (!fs.existsSync(CLI)) { console.log(`  FAIL  cli missing: ${CLI}`); process.exit(2); }

const source = fs.readFileSync(SOURCE, 'utf8');
const cli = fs.readFileSync(CLI, 'utf8');

// ── Structural ──────────────────────────────────────────────────────────────
const partsBlock = (source.match(/PRE_ACTION_SNAPSHOT_EXCLUDED_PARTS = new Set\(\[([\s\S]*?)\]\)/) || ['', ''])[1];
check(
    'structural: `.harmony` is no longer a blanket segment exclude',
    partsBlock.length > 0 && !/['"]\.harmony['"]/.test(partsBlock),
    partsBlock.replace(/\s+/g, ' ').trim().slice(0, 90)
);

const exclusionBlock = (source.match(/if \(shouldSkipPreActionSnapshotPath\(normalized\)\) \{[\s\S]*?\n {8}\}/) || [''])[0];
check(
    'structural: exclusion branch warns instead of failing',
    exclusionBlock.includes('warnings.push(') && !exclusionBlock.includes('failures.push('),
    `${exclusionBlock.split('\n').length} lines inspected`
);

// ── Parity: the two hand-maintained copies must not drift ───────────────────
// Comments inside the array contain apostrophes ("CLI's 200-file budget"), which corrupt naive
// quote pairing: the apostrophe closes one string and the next quote opens a bogus one, so the
// extractor silently yields COMMENT TEXT and the parity check compares garbage to garbage and
// reports a match. Strip line comments first, then pin the result with canaries.
function extractList(text, name) {
    const match = text.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\];`));
    if (!match) return null;
    const stripped = match[1].replace(/\/\/[^\n]*/g, '');
    return Array.from(stripped.matchAll(/['"]([^'"\n]+)['"]/g)).map(m => m[1]);
}
const tsPrefixes = extractList(source, 'PRE_ACTION_SNAPSHOT_EXCLUDED_PREFIXES');
const cliPrefixes = extractList(cli, 'SNAPSHOT_EXCLUDED_PREFIXES');

// Canaries: a broken extractor must fail LOUDLY, never "pass" parity against itself.
check('canary: extractor found both non-trivial lists',
    Array.isArray(tsPrefixes) && Array.isArray(cliPrefixes) && tsPrefixes.length >= 20 && cliPrefixes.length >= 20,
    `${tsPrefixes ? tsPrefixes.length : 'null'} / ${cliPrefixes ? cliPrefixes.length : 'null'}`);
check('canary: every extracted entry is really a .harmony/ path',
    Array.isArray(tsPrefixes) && tsPrefixes.every(v => v.startsWith('.harmony/')),
    Array.isArray(tsPrefixes) ? (tsPrefixes.filter(v => !v.startsWith('.harmony/')).slice(0, 3).join(' | ') || 'all clean') : 'n/a');
check('canary: measured gaps present AND the goal paths still included',
    Array.isArray(tsPrefixes) && tsPrefixes.includes('.harmony/hygiene') &&
    tsPrefixes.includes('.harmony/history') && tsPrefixes.includes('.harmony/memory.jsonl') &&
    !tsPrefixes.includes('.harmony/notes') && !tsPrefixes.includes('.harmony/handoffs'));

check(
    'parity: TS and CLI prefix exclude lists are identical',
    Array.isArray(tsPrefixes) && Array.isArray(cliPrefixes) && tsPrefixes.length > 0 &&
    tsPrefixes.length === cliPrefixes.length && tsPrefixes.every((v, i) => v === cliPrefixes[i]),
    tsPrefixes && cliPrefixes ? `ts=${tsPrefixes.length} cli=${cliPrefixes.length}` : 'list not found'
);

// ── Load the REAL compiled module with a vscode stub ────────────────────────
if (!fs.existsSync(COMPILED)) {
    console.log(`  FAIL  compiled module missing: ${COMPILED} — run "npm run compile" first`);
    process.exit(2);
}

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => {
                if (key === 'snapshotMaxBytes') {
                    const override = Number(process.env.HARMONY_GATE_MAX_BYTES || 0);
                    return override > 0 ? override : fallback;
                }
                return fallback;
            },
        }),
    },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.apply(this, arguments);
};

const mod = require(COMPILED);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-snapshot-gate-'));
function write(rel, content) {
    const target = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
}

write('.harmony/notes/existing.md', '# prior content\n');            // must be COPIED now
write('.harmony/plans/plan.md', '# plan\n');                        // must be COPIED now
write('.harmony/snapshots/s1/manifest.json', '{"files":[]}\n');     // recursion — excluded
write('.harmony/continuity/ledger.jsonl', '{"x":1}\n');             // live state — excluded
write('.harmony/private/terms.json', '{"t":[]}\n');                 // private — excluded
write('.harmony/todo.json', '{"items":[]}\n');                      // live state file — excluded
write('.harmony/hygiene/bundled.exe', 'MZ'.repeat(64));             // bundled binary — excluded
write('.harmony/history/chat_ledger.jsonl', '{"t":1}\n');         // chat ledger — excluded
write('.harmony/memory.jsonl', '{"m":1}\n');                      // live memory log — excluded
write('node_modules/pkg/index.js', 'module.exports=1;\n');          // segment exclude still works
write('src/normal.ts', 'export const value = 1;\n');                // healthy control
write('docs/oversize.txt', 'x'.repeat(300 * 1024));                 // over the 256KB floor

const snap = (rel, label) => mod.createRequiredPreActionSnapshot(tmpRoot, [rel], label, 'vscode');

(async () => {
    // A + B: the original defect, and the narrowing that gives real undo.
    const notes = await snap('.harmony/notes/existing.md', 'gate: document under .harmony');
    check('A: excluded path no longer refuses the action (it would have aborted)', notes.ok === true,
        notes.ok ? 'proceeded' : `refused: ${String(notes.message).slice(0, 120)}`);
    check('B: .harmony/notes is now snapshotted, so it has a real undo path',
        notes.ok === true && notes.snapshot && notes.snapshot.copied === 1 &&
        Array.isArray(notes.warnings) && notes.warnings.length === 0,
        notes.ok && notes.snapshot ? `copied=${notes.snapshot.copied}` : 'no snapshot');

    const plans = await snap('.harmony/plans/plan.md', 'gate: plans under .harmony');
    check('B: .harmony/plans is snapshotted too',
        plans.ok === true && plans.snapshot && plans.snapshot.copied === 1 && plans.warnings.length === 0);

    // C: dangerous subtrees stay excluded, and each skip is disclosed.
    const skipCases = [
        ['.harmony/snapshots/s1/manifest.json', 'snapshot store (recursion)'],
        ['.harmony/continuity/ledger.jsonl', 'live-written state'],
        ['.harmony/private/terms.json', 'private material'],
        ['.harmony/todo.json', 'live-written state file'],
        ['.harmony/hygiene/bundled.exe', 'bundled binary (measured 29 MB)'],
        ['.harmony/history/chat_ledger.jsonl', 'chat ledger history'],
        ['.harmony/memory.jsonl', 'live memory log'],
        ['node_modules/pkg/index.js', 'segment exclude still applies'],
    ];
    for (const [rel, why] of skipCases) {
        const result = await snap(rel, `gate: ${why}`);
        check(`C: ${why} is excluded AND disclosed, not silent`,
            result.ok === true && result.snapshot === undefined &&
            Array.isArray(result.warnings) && result.warnings.length === 1 &&
            /excluded from snapshot copy policy/.test(result.warnings[0]),
            result.ok ? JSON.stringify(result.warnings) : 'refused');
    }

    // Remaining behavioural cases.
    const healthy = await snap('src/normal.ts', 'gate: healthy path');
    check('normal path still snapshots normally',
        healthy.ok === true && healthy.snapshot && healthy.snapshot.copied === 1 && healthy.warnings.length === 0);

    const missing = await snap('.harmony/notes/missing.md', 'gate: missing file');
    check('missing file stays a non-failing, non-warning skip',
        missing.ok === true && Array.isArray(missing.warnings) && missing.warnings.length === 0);

    const oversize = await snap('docs/oversize.txt', 'gate: oversize file');
    check('oversize skip is surfaced, not silent',
        oversize.ok === true && oversize.warnings.length === 1 &&
        /exceeds the \d+ byte snapshot limit/.test(oversize.warnings[0]),
        oversize.ok ? JSON.stringify(oversize.warnings) : 'n/a');

    // D: negative control — a real failure must still abort.
    const escape = await snap('../escape.md', 'gate: path outside workspace');
    check('D: a real failure still aborts (safety boundary intact)',
        escape.ok === false && /pre-action snapshot failed/.test(String(escape.message)),
        escape.ok ? 'DID NOT ABORT — boundary defanged' : 'aborted as expected');

    // Formatter.
    const noteOnlyWarning = mod.formatSnapshotNote(undefined, ['x: excluded from snapshot copy policy — no automatic undo for this path']);
    check('formatter: warning renders when there is no snapshot',
        /no pre-action snapshot/.test(noteOnlyWarning) && /NO automatic undo/.test(noteOnlyWarning));
    const noteBoth = mod.formatSnapshotNote(notes.snapshot, ['y: excluded']);
    check('formatter: warning and snapshot both render',
        /no pre-action snapshot/.test(noteBoth) && /pre-action snapshot:/.test(noteBoth) && /restore command:/.test(noteBoth));
    check('formatter: clean case stays empty', mod.formatSnapshotNote(undefined, []) === '');

    fs.rmSync(tmpRoot, { recursive: true, force: true });

    console.log('');
    console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (pass=${pass} fail=${fail})`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`  FAIL  unexpected error: ${error && error.message ? error.message : String(error)}`);
    console.log('RESULT: FAIL');
    process.exit(1);
});
