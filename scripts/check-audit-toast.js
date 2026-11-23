#!/usr/bin/env node
/**
 * check:audit-toast - proves the Triple-Check notification text carries its disclosures.
 *
 * Background: check:audit-scope proves the classifier excludes read-only references
 * (18/18). It cannot see the notification string, which used to be an inline template
 * literal in chatParticipant.ts. So this was true:
 *
 *   delete `${scopeSuffix}` from the message  ->  every gate still green
 *   the audit still narrows correctly         ->  and renders as if nothing was filtered
 *
 * That is Rule #6 broken with a passing build. The formatter now lives in
 * src/auditToast.ts, so this gate asserts the RENDERED string rather than the shape
 * of the source that builds it.
 *
 * The load-bearing assertion is 'a narrowed audit can never render as a clean one'.
 * The exact-string snapshot below is the mutation guard: reintroducing the old inline
 * literal, or dropping the scope suffix, changes the string and fails here.
 *
 * What this gate does NOT prove: that the host rendered the notification.
 * showInformationMessage is host UI. The claim is "the string and action list we hand
 * the host are correct", never "a human saw it".
 */

const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const toast = require(path.join(root, 'out', 'auditToast.js'));

const {
    formatTripleCheckToast,
    formatTripleCheckDetails,
    normalizeFindings,
    verdictIcon,
    tripleCheckActions,
    FIRST_FINDING_PREVIEW_CHARS,
} = toast;

const checks = [];
let failures = 0;

function check(name, fn) {
    try {
        fn();
        checks.push({ name, ok: true });
    } catch (err) {
        checks.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
        failures += 1;
    }
}

const DASH = '\u2014';
const CAUTION = '\u26A0\uFE0F';
const OK_ICON = '\u2705';
const NOGO = '\u{1F6A8}';

// ── 1. Positive control: the surface under test exists ──────────────────────
check('CONTROL: formatter, details builder and helpers are exported', () => {
    assert.strictEqual(typeof formatTripleCheckToast, 'function', 'formatTripleCheckToast missing');
    assert.strictEqual(typeof formatTripleCheckDetails, 'function', 'formatTripleCheckDetails missing');
    assert.strictEqual(typeof normalizeFindings, 'function', 'normalizeFindings missing');
    assert.strictEqual(typeof verdictIcon, 'function', 'verdictIcon missing');
    assert.strictEqual(typeof tripleCheckActions, 'function', 'tripleCheckActions missing');
    assert.strictEqual(typeof FIRST_FINDING_PREVIEW_CHARS, 'number', 'preview cap missing');
});

// ── 2. Negative control: malformed input must not throw or print "undefined" ─
check('CONTROL: malformed input degrades without throwing or leaking "undefined"', () => {
    for (const input of [{}, { verdict: undefined, summary: null }, { summary: 42, findings: 'nope' }]) {
        const out = formatTripleCheckToast(input);
        assert.strictEqual(typeof out.message, 'string');
        assert.ok(!out.message.includes('undefined'), `message leaked undefined: ${out.message}`);
        assert.ok(!out.message.includes('null'), `message leaked null: ${out.message}`);
        assert.ok(Array.isArray(out.actions) && out.actions.includes('Dismiss'));
        assert.deepStrictEqual(out.findings, []);
    }
});

// ── 3. THE INVARIANT: narrow and clean must never render the same ───────────
check('INVARIANT: a narrowed audit can never render as a clean one', () => {
    const base = { verdict: 'CAUTION', summary: 'Nothing conclusive found', findings: [] };
    const narrowed = formatTripleCheckToast({ ...base, scopeNote: '2 read-only references excluded' });
    const clean = formatTripleCheckToast({ ...base, scopeNote: '' });
    assert.notStrictEqual(
        narrowed.message,
        clean.message,
        'the scope note vanished - a silently narrowed audit is indistinguishable from a clean one'
    );
    assert.ok(narrowed.message.includes('2 read-only references excluded'), 'the note must be readable in the message');
});

// ── 4. Mutation guard: the exact string, so dropping a suffix fails loudly ──
check('EXACT: the canonical toast string is pinned character for character', () => {
    const out = formatTripleCheckToast({
        verdict: 'CAUTION',
        summary: 'No secrets or private terms found; 1 logic note',
        scopeNote: '2 read-only references excluded',
        urgentIssues: [],
        findings: ['maxTokens budget exceeds limit'],
    });
    const expected =
        `${CAUTION} Triple-Check: No secrets or private terms found; 1 logic note ` +
        `[2 read-only references excluded] ${DASH} maxTokens budget exceeds limit`;
    assert.strictEqual(out.message, expected, 'rendered string changed - check the scope/finding suffixes');
});

// ── 5. The suffix is CONDITIONAL - clean audits are not permanently noisy ───
check('a clean scope renders NO bracket suffix', () => {
    for (const scopeNote of ['', '   ', undefined, null]) {
        const out = formatTripleCheckToast({ verdict: 'GO', summary: 'Clean', scopeNote, findings: [] });
        assert.ok(!out.message.includes('['), `empty scope note produced a suffix: ${out.message}`);
    }
});

// ── 6. Findings are surfaced, never discarded ───────────────────────────────
check('urgent AND normal findings both survive, in order', () => {
    const out = formatTripleCheckToast({
        verdict: 'NO-GO',
        summary: 'Two problems',
        urgentIssues: ['Hardcoded secret detected in handler'],
        findings: ['maxTokens budget exceeds limit'],
    });
    assert.deepStrictEqual(out.findings, [
        'Hardcoded secret detected in handler',
        'maxTokens budget exceeds limit',
    ], 'urgent must come first and nothing may be dropped');
    assert.ok(out.message.includes('Hardcoded secret detected in handler'), 'the first finding must be inline');
    assert.ok(out.message.includes('+1 more'), 'the remainder must be counted');
});

check('whitespace is collapsed and blank entries are dropped', () => {
    const out = formatTripleCheckToast({
        verdict: 'CAUTION',
        summary: 'x',
        findings: ['  multi\n\nline\tfinding  ', '', '   ', null],
    });
    assert.deepStrictEqual(out.findings, ['multi line finding']);
});

check('a long first finding is truncated to the preview cap, not dropped', () => {
    const long = 'a'.repeat(400);
    const out = formatTripleCheckToast({ verdict: 'CAUTION', summary: 'x', findings: [long] });
    assert.ok(out.firstFinding, 'first finding must exist');
    assert.strictEqual(out.firstFinding.length, FIRST_FINDING_PREVIEW_CHARS);
    assert.ok(out.message.includes(out.firstFinding), 'the preview must appear inline');
    assert.ok(!out.message.includes('+0 more'), 'a single finding must not claim a remainder');
});

// ── 7. Action set ───────────────────────────────────────────────────────────
check('GO with findings keeps Show Details reachable - a quiet verdict still has notes', () => {
    assert.deepStrictEqual(tripleCheckActions('GO', 1), ['Show Details', 'Dismiss']);
});

check('GO without findings offers only Dismiss and no pointless audit run', () => {
    assert.deepStrictEqual(tripleCheckActions('GO', 0), ['Dismiss']);
});

check('non-GO offers Run Full Audit first, and Show Details only when there is something to show', () => {
    assert.deepStrictEqual(tripleCheckActions('NO-GO', 2), ['Run Full Audit', 'Show Details', 'Dismiss']);
    assert.deepStrictEqual(tripleCheckActions('CAUTION', 0), ['Run Full Audit', 'Dismiss']);
});

check('Dismiss is always the last action', () => {
    for (const [verdict, n] of [['GO', 0], ['GO', 3], ['NO-GO', 0], ['CAUTION', 1], ['??', 5]]) {
        const actions = tripleCheckActions(verdict, n);
        assert.strictEqual(actions[actions.length - 1], 'Dismiss', `${verdict}/${n} did not end with Dismiss`);
    }
});

// ── 8. Unknown verdicts must never masquerade as success ────────────────────
check('an unrecognised verdict never renders the GO checkmark', () => {
    assert.strictEqual(verdictIcon('GO'), OK_ICON);
    assert.strictEqual(verdictIcon('NO-GO'), NOGO);
    for (const odd of ['go', 'PASS', '', undefined, null, 'UNKNOWN']) {
        assert.strictEqual(verdictIcon(odd), CAUTION, `${String(odd)} must degrade to caution`);
    }
});

// ── 9. The Show Details surface carries the same disclosures ────────────────
check('details name the scope note when the audit was narrowed', () => {
    const lines = formatTripleCheckDetails({
        verdict: 'CAUTION',
        summary: 'Nothing conclusive',
        scopeNote: '3 read-only references excluded',
        pathCount: 1,
        findings: ['a note'],
    });
    assert.ok(lines[0].includes('verdict=CAUTION'), 'verdict must be on the first line');
    assert.ok(lines.some((l) => l.includes('3 read-only references excluded')), 'scope note missing from details');
    assert.ok(lines.some((l) => l.startsWith('  1. a note')), 'findings must be numbered');
});

check('details state the count when nothing was filtered - clean is affirmative, not absent', () => {
    const lines = formatTripleCheckDetails({
        verdict: 'GO',
        summary: 'Clean',
        scopeNote: '',
        pathCount: 4,
        findings: [],
    });
    assert.ok(
        lines.some((l) => l.includes('all 4 path(s) are write-capable tool references')),
        'a clean scope must still be stated explicitly'
    );
});

// ── 10. Anti-regression control naming the original defect ──────────────────
check('CONTROL: rebuilding the message without the scope suffix would fail this suite', () => {
    const out = formatTripleCheckToast({
        verdict: 'CAUTION',
        summary: 'ok',
        scopeNote: '1 read-only reference excluded',
        findings: [],
    });
    const withoutSuffix = `${CAUTION} Triple-Check: ok`;
    assert.notStrictEqual(
        out.message,
        withoutSuffix,
        'the scope suffix is gone - the old inline behaviour is back'
    );
});

const passed = checks.length - failures;
for (const c of checks) {
    if (c.ok) {
        console.log(`PASS  ${c.name}`);
    } else {
        console.log(`FAIL  ${c.name}\n        ${c.error}`);
    }
}

console.log(`\ncheck-audit-toast: ${passed}/${checks.length} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
