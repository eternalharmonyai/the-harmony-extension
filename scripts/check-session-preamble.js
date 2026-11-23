#!/usr/bin/env node
/**
 * Gate: resumed-session preamble trimming.
 *
 * Loads the REAL compiled module (out/sessions.js) with a stubbed `vscode`
 * module, so this gate exercises the shipped trimming logic rather than a
 * hand-mirrored copy. It cannot pass while the shipped code drifts.
 *
 * Invariants under test:
 *   1. The CEILING is absolute — no output may ever exceed it.
 *   2. Under TARGET: verbatim, no annotation, zero noise.
 *   3. TARGET..CEILING: complete, annotated, nothing dropped.
 *   4. Over CEILING: newest turns kept, oldest dropped, order preserved.
 *   5. A single oversized turn keeps BOTH ends, with the omission counted.
 *   6. Every degradation states its magnitude (no silent trimming).
 *
 * Run: npm run check:session-preamble
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

// ── Minimal vscode stub ───────────────────────────────────────────────────
// formatSessionPreamble is pure; it never touches the host API. The stub only
// needs to satisfy the module-level import.
const vscodeStub = {
    workspace: { workspaceFolders: undefined, fs: {} },
    Uri: { joinPath: (...parts) => ({ path: parts.join('/') }) },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
};

let mod;
try {
    mod = require(path.join(__dirname, '..', 'out', 'sessions.js'));
} finally {
    Module._load = originalLoad;
}

const {
    formatSessionPreamble,
    SESSION_PREAMBLE_TARGET_CHARS,
    SESSION_PREAMBLE_CEILING_CHARS,
    SESSION_SCHEMA_VERSION,
} = mod;

const TARGET = SESSION_PREAMBLE_TARGET_CHARS;
const CEILING = SESSION_PREAMBLE_CEILING_CHARS;
const OMITTED_COUNT = /(\d+)\s+earlier turn/;

let pass = 0;
const failures = [];

function check(name, condition, detail) {
    if (condition) {
        pass++;
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function makeSession(turns, notes) {
    return {
        name: 'gate-session',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
        notes,
        turns: turns.map((text, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            text,
            ts: '2026-01-01T00:00:00Z',
        })),
    };
}

// options.notes         -> stored on the session file
// options.formatOptions -> { targetChars, ceilingChars } passed to the formatter
function render(turns, options) {
    const o = options || {};
    return formatSessionPreamble(makeSession(turns, o.notes), o.formatOptions);
}

function atMost(name, out, limit) {
    check(name, out.length <= limit, `got ${out.length} chars, limit ${limit}`);
}

// ── 0. Declared budget sanity ────────────────────────────────────────────
check('target is 8000 chars', TARGET === 8000, `got ${TARGET}`);
check('ceiling is 24000 chars', CEILING === 24000, `got ${CEILING}`);
check('target sits below ceiling', TARGET < CEILING, `${TARGET} vs ${CEILING}`);

// ── 1. Under target: verbatim, no annotation ─────────────────────────────
{
    const out = render(['hello there', 'general kenobi']);
    check('short session keeps turn 1', out.includes('hello there'));
    check('short session keeps turn 2', out.includes('general kenobi'));
    check('short session emits no context note', !out.includes('[Context:'), 'annotation leaked into the happy path');
    check('assistant turn is labelled Conductor', out.includes('Conductor: general kenobi'));
    check('header is present', out.includes('[Resumed session: "gate-session"'));
    check('section heading is present', out.includes('Prior conversation:'));
}

// ── 2. Notes are preserved and the header stays well-formed ──────────────
{
    const out = render(['one'], { notes: 'remember the pem fix' });
    check('notes are preserved', out.includes('Notes: remember the pem fix'));
    check('heading appears exactly once', out.split('Prior conversation:').length === 2, 'heading duplicated or missing');
}

// ── 3. TARGET..CEILING: complete, annotated, nothing dropped ─────────────
{
    // ~20.6k chars: comfortably over target, comfortably under ceiling.
    const turns = Array.from({ length: 40 }, (_, i) => `MARK${i} ` + 'q'.repeat(500));
    const out = render(turns);
    atMost('over-target output stays within ceiling', out, CEILING);
    check('over-target keeps the oldest turn (fidelity first)', out.includes('MARK0 '), 'oldest turn was dropped while still under ceiling');
    check('over-target keeps the newest turn', out.includes('MARK39'));
    check('over-target drops nothing', !OMITTED_COUNT.test(out), 'reported omissions while under ceiling');
    check('over-target says it is over target', /over target/.test(out), 'no over-target annotation');
}

// ── 4. Over ceiling: trim oldest-first, keep recency and order ───────────
{
    // ~65k chars: well past the ceiling, so trimming is mandatory.
    const turns = Array.from({ length: 80 }, (_, i) => `MARK${i} ` + 'q'.repeat(800));
    const out = render(turns);
    atMost('trimmed output stays within ceiling', out, CEILING);
    check('most recent turn survives trimming', out.includes('MARK79'));
    check('oldest turn is dropped when trimming', !out.includes('MARK0 '), 'oldest turn leaked into trimmed output — recency inversion');
    check('kept turns stay in chronological order', out.indexOf('MARK78') < out.indexOf('MARK79'), 'turn order reversed');
    const m = out.match(OMITTED_COUNT);
    check('trim manifest states how many turns were omitted', !!m, 'marker does not report an omitted count');
    if (m) {
        const omitted = Number(m[1]);
        check('reported omit count is plausible', omitted > 0 && omitted < turns.length, `reported ${omitted} of ${turns.length}`);
    }
}

// ── 5. A single oversized turn keeps both ends ───────────────────────────
{
    // ~30k chars in ONE turn: past the ceiling, so it must be stitched.
    const big = 'HEADMARK' + 'w'.repeat(30000) + 'TAILMARK';
    const out = render([big]);
    atMost('oversized single turn stays within ceiling', out, CEILING);
    check('oversized turn keeps the beginning', out.includes('HEADMARK'), 'head lost');
    check('oversized turn keeps the conclusion', out.includes('TAILMARK'), 'tail lost — head-only truncation');
    check('stitch announces the omission', /chars omitted/.test(out), 'stitching was silent');
}

// ── 6. Other shapes still respect the ceiling ────────────────────────────
{
    const huge = render(['X'.repeat(20000)]);
    atMost('single 20k turn stays within ceiling', huge, CEILING);

    const hugeNotes = render(['small turn'], { notes: 'N'.repeat(20000) });
    atMost('huge notes stay within ceiling', hugeNotes, CEILING);

    const massiveNotes = render(['tiny'], { notes: 'N'.repeat(30000) });
    atMost('massive notes are hard-clamped to the ceiling', massiveNotes, CEILING);

    const manyTiny = render(Array.from({ length: 300 }, (_, i) => `tiny ${i} ` + 'z'.repeat(90)));
    atMost('300 tiny turns stay within ceiling', manyTiny, CEILING);
}

// ── 7. The budget hook a future setting will use actually works ──────────
{
    const turns = Array.from({ length: 20 }, (_, i) => `OVR${i} ` + 'v'.repeat(200));
    const out = render(turns, { formatOptions: { targetChars: 1000, ceilingChars: 2000 } });
    atMost('custom ceiling is honoured', out, 2000);
    check('custom ceiling still keeps the newest turn', out.includes('OVR19'));
}

// ── 8. Degenerate inputs must not throw ─────────────────────────────────
{
    let threw = null;
    let out = '';
    try {
        out = render([]);
    } catch (e) {
        threw = e;
    }
    check('empty turn list does not throw', !threw, threw && threw.message);
    check('empty turn list still returns the header', !threw && out.includes('Prior conversation:'), 'header missing');

    let threw2 = null;
    try {
        render(['a'], { notes: '' });
    } catch (e) {
        threw2 = e;
    }
    check('empty notes string does not throw', !threw2, threw2 && threw2.message);
}

// ── 9. Provenance is declared, never fabricated ──────────────────────────
{
    const base = {
        name: 'prov',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
        turns: [{ role: 'user', text: 'hi', ts: '2026-01-01T00:00:00Z' }],
    };

    const reconstructed = formatSessionPreamble(Object.assign({}, base, { source: 'memory-reconstruction' }));
    check('memory reconstruction is labelled', /Provenance: reconstructed from memory/.test(reconstructed), 'provenance missing');

    const transcript = formatSessionPreamble(Object.assign({}, base, { source: 'chat-history' }));
    check('a real transcript is not labelled as reconstruction', !/reconstructed from memory/.test(transcript));

    const legacy = formatSessionPreamble(base);
    check('a pre-provenance file still renders', legacy.includes('Prior conversation:') && !/reconstructed from memory/.test(legacy));

    check('schema version is declared', typeof SESSION_SCHEMA_VERSION === 'number' && SESSION_SCHEMA_VERSION >= 1, `got ${SESSION_SCHEMA_VERSION}`);

    // ── P1 extractive digest-at-save (deterministic, schema-versioned, no forced migration) ──
    const { buildExtractiveSessionDigest } = mod;
    const sampleTurns = [
        { role: 'user', text: 'Please update src/providers.ts and package.json for Vertex AI.', ts: '2026-01-01T00:00:00Z' },
        { role: 'assistant', text: '✅ Landed Vertex AI endpoint routing in src/providers.ts and scripts/check-studio-settings.js.\n- [ ] Reload window owed in VS Code', ts: '2026-01-01T00:00:01Z' },
    ];
    const dig1 = buildExtractiveSessionDigest(sampleTurns);
    const dig2 = buildExtractiveSessionDigest(sampleTurns);
    check('digest is deterministic across calls', JSON.stringify(dig1) === JSON.stringify(dig2));
    check('digest extracts and sorts mentioned workspace files',
        dig1.filesMentioned.includes('src/providers.ts') && dig1.filesMentioned.includes('package.json') && dig1.filesMentioned.includes('scripts/check-studio-settings.js'));
    check('digest extracts decision lines', dig1.decisions.length === 1 && /Landed Vertex AI/.test(dig1.decisions[0]));
    check('digest extracts open items', dig1.openItems.length === 1 && /Reload window owed/.test(dig1.openItems[0]));
}

// ── 10. Settings are declared AND consumed (no dead UI) ─━━━━━━━━━━━━━━━━
{
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const props = ((((pkg.contributes || {}).configuration || {}).properties) || {});
    const nls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
    const nlsZh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
    const src = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');

    for (const [key, expectedDefault] of [
        ['preambleTargetChars', TARGET],
        ['preambleCeilingChars', CEILING],
    ]) {
        const full = `harmony.sessions.${key}`;
        const def = props[full] || {};
        const nlsKey = `config.harmony.sessions.${key}.description`;

        check(`${key} setting is declared`, Object.keys(def).length > 0, 'missing from contributes.configuration');
        check(`${key} default matches the module constant`, def.default === expectedDefault, `declared ${def.default} vs constant ${expectedDefault}`);
        check(`${key} uses an nls placeholder`, def.description === `%${nlsKey}%`, `got ${def.description}`);
        check(`${key} description resolves in package.nls.json`, typeof nls[nlsKey] === 'string' && nls[nlsKey].length > 20);
        check(`${key} description resolves in package.nls.zh-cn.json`, typeof nlsZh[nlsKey] === 'string' && nlsZh[nlsKey].length > 5);
    }

    // Declared is not enough — the shipping source must actually read them.
    check('the settings namespace is consumed in src', src.includes("getConfiguration('harmony.sessions')"), 'no consumer found — dead UI');
    check('the budget helper is passed to the formatter', /formatSessionPreamble\(session, preambleBudgetFromSettings\(\)\)/.test(src), 'setting not wired into the preamble call');
}

// ── Report ───────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
    console.error(`\n✖ session-preamble gate: ${pass}/${total} passed\n`);
    for (const f of failures) console.error(`  ✖ ${f}`);
    console.error('');
    process.exit(1);
}
console.log(`✔ session-preamble gate: ${pass}/${total} passed`);
