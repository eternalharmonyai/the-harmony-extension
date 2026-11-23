#!/usr/bin/env node
/**
 * check:audit-classify — proves the Triple-Check post-filter CLASSIFIES, never DELETES.
 *
 * Background: the original filter was destructive. It deleted every finding that did not
 * match a security regex and reported the deletion only to console.log, which meant a
 * real finding could vanish with nothing on a human-readable surface to say it existed.
 * Tightening that regex bought quiet at the cost of invisible recall loss — a genuine
 * trade-off between two failure modes.
 *
 * The classifier removes the trade-off: security findings drive the verdict, logic
 * findings are KEPT and labelled, and the only items removed are "no secrets found"
 * echoes, whose count is reported.
 *
 * This gate therefore proves BOTH directions, because each one alone is a lie:
 *   - a benign "token"/"hardcod" mention must NOT be promoted to security
 *   - a benign mention must NOT be deleted either — it must still be there
 *
 * The final check is an explicit anti-regression control: if a future edit makes the
 * filter destructive again, the suite fails rather than quietly going green.
 */

const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const audit = require(path.join(root, 'out', 'auditClassify.js'));

const { classifyAuditFindings, isSecurityFinding, isSecretsEcho, AUDIT_SURFACE_LABEL } = audit;

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

// ── 1. Positive control: the surface under test actually exists ─────────────────
check('CONTROL: classifier, predicates and honesty label are exported', () => {
    assert.strictEqual(typeof classifyAuditFindings, 'function', 'classifyAuditFindings missing');
    assert.strictEqual(typeof isSecurityFinding, 'function', 'isSecurityFinding missing');
    assert.strictEqual(typeof isSecretsEcho, 'function', 'isSecretsEcho missing');
    assert.ok(typeof AUDIT_SURFACE_LABEL === 'string' && AUDIT_SURFACE_LABEL.length > 5, 'honesty label missing');
});

// ── 2. Negative control: empty input must produce nothing, not filler ───────────
check('CONTROL: empty input classifies to nothing at all', () => {
    const r = classifyAuditFindings([], []);
    assert.deepStrictEqual(r.counts, { security: 0, logic: 0, dropped: 0 });
    assert.deepStrictEqual(r.findings, []);
    assert.deepStrictEqual(r.urgentIssues, []);
    assert.deepStrictEqual(r.logicFindings, []);
});

// ── 3. The trade-off: benign mentions must be DOWNGRADED, not destroyed ─────────
check('a "maxTokens budget" note is logic — and STILL PRESENT', () => {
    const note = 'maxTokens budget exceeds the configured limit in the chat loop';
    assert.strictEqual(isSecurityFinding(note), false, 'a token budget mention must not be security');
    const r = classifyAuditFindings([note], []);
    assert.ok(r.findings.includes(note), 'the note was DELETED — classification must not delete');
    assert.strictEqual(r.counts.logic, 1);
    assert.strictEqual(r.counts.security, 0);
    assert.strictEqual(r.counts.dropped, 0, 'a logic note is kept, not dropped');
});

check('a "CancellationToken" note is logic — and STILL PRESENT', () => {
    const note = 'CancellationToken ignored in the retry path';
    assert.strictEqual(isSecurityFinding(note), false);
    const r = classifyAuditFindings([note], []);
    assert.ok(r.findings.includes(note));
    assert.strictEqual(r.counts.logic, 1);
});

check('a bare "hardcoded" note is LOGIC — not a credential', () => {
    const note = 'hardcoded tier priority order may mislead maintenance readers';
    assert.strictEqual(isSecurityFinding(note), false, 'bare hardcod must not pass the security bar');
    const r = classifyAuditFindings([note], []);
    assert.ok(r.findings.includes(note), 'the note must survive classification');
});

// ── 4. Real security language must still be caught ──────────────────────────────
check('a hardcoded API key IS security', () => {
    assert.strictEqual(isSecurityFinding('hardcoded API key left in the config handler'), true);
});

check('a token embedded in a URL IS security', () => {
    assert.strictEqual(isSecurityFinding('access token embedded in the request URL'), true);
});

check('an exposed credential IS security', () => {
    assert.strictEqual(isSecurityFinding('database password exposed in the log line'), true);
});

// ── 5. The only permitted removal is an echo, and it must be COUNTED ────────────
check('a "no secrets found" echo is counted as dropped, never listed as a finding', () => {
    const echo = 'no secrets found in the changed files';
    assert.strictEqual(isSecretsEcho(echo), true);
    assert.strictEqual(isSecurityFinding(echo), false, 'an echo is not a security finding');
    const r = classifyAuditFindings([echo], []);
    assert.strictEqual(r.findings.includes(echo), false, 'an echo should not masquerade as a finding');
    assert.strictEqual(r.counts.dropped, 1, 'the drop must be COUNTED, never silent');
});

// ── 5b. NEGATION DIRECTION: a genuine positive must NEVER read as an echo ──────
// This section exists because an earlier echo pattern matched a bare "secrets found",
// which silently deleted real findings. Every string below was actually destroyed by
// that build, verified by running the installed module — not imagined as a risk.
check('"Secret found in config.ts" is security — NOT an echo, NOT dropped', () => {
    const finding = 'Secret found in config.ts';
    assert.strictEqual(isSecretsEcho(finding), false, 'a genuine positive was mistaken for an echo');
    assert.strictEqual(isSecurityFinding(finding), true, 'a genuine positive must be security');
    const r = classifyAuditFindings([finding], []);
    assert.ok(r.findings.includes(finding), 'the finding was DELETED as an echo');
    assert.strictEqual(r.counts.dropped, 0, 'nothing should be dropped here');
});

check('"Secrets found: API key in src/config.ts" survives with its credential intact', () => {
    const finding = 'Secrets found: API key in src/config.ts';
    assert.strictEqual(isSecretsEcho(finding), false, 'an API key finding was mistaken for an echo');
    const r = classifyAuditFindings([finding], []);
    assert.ok(r.findings.includes(finding), 'an API key finding was DELETED as an echo');
    assert.strictEqual(r.counts.security, 1);
    assert.strictEqual(r.counts.dropped, 0);
});

check('"Hardcoded secret detected in handler" is security, not an echo', () => {
    const finding = 'Hardcoded secret detected in handler';
    assert.strictEqual(isSecretsEcho(finding), false, 'a detected secret was mistaken for an echo');
    assert.strictEqual(isSecurityFinding(finding), true);
    const r = classifyAuditFindings([finding], []);
    assert.ok(r.findings.includes(finding), 'the finding was DELETED as an echo');
});

check('a negation elsewhere in the sentence cannot erase a real positive', () => {
    const finding = 'No secrets found, but a hardcoded API key exists in config.ts';
    assert.strictEqual(isSecretsEcho(finding), false, 'the negation clause swallowed the real positive');
    assert.strictEqual(isSecurityFinding(finding), true);
    assert.ok(classifyAuditFindings([finding], []).findings.includes(finding));
});

check('CONTROL: negation-anchored echoes are still recognised and still counted', () => {
    const echoes = [
        'no secrets found',
        'No secrets or private terms found',
        'no secrets identified in changed files',
        'There are no secrets detected',
    ];
    for (const echo of echoes) {
        assert.strictEqual(isSecretsEcho(echo), true, `expected an echo: ${echo}`);
        const r = classifyAuditFindings([echo], []);
        assert.ok(!r.findings.includes(echo), `echo leaked into findings: ${echo}`);
        assert.strictEqual(r.counts.dropped, 1, `echo not counted: ${echo}`);
    }
});

// ── 6. Conservation law: nothing meaningful disappears ─────────────────────────
check('nothing vanishes: findings length equals security + logic', () => {
    const input = [
        'hardcoded API key in handler',
        'maxTokens budget exceeds limit',
        'password reset flow missing a guard',
        'token budget accounting drifts',
    ];
    const r = classifyAuditFindings(input, []);
    assert.strictEqual(r.findings.length, r.counts.security + r.counts.logic, 'counts do not add up');
    assert.strictEqual(r.findings.length, input.length, 'a finding was lost');
    for (const note of input) {
        assert.ok(r.findings.includes(note), `lost: ${note}`);
    }
});

check('security findings sort BEFORE logic findings', () => {
    const r = classifyAuditFindings(['maxTokens budget exceeds limit', 'hardcoded API key in handler'], []);
    assert.ok(isSecurityFinding(r.findings[0]), 'the actionable item must come first');
});

check('urgentIssues admits security items only', () => {
    const r = classifyAuditFindings(['maxTokens budget exceeds limit'], ['hardcoded API key in handler', 'token budget exceeded']);
    assert.strictEqual(r.urgentIssues.length, 1);
    assert.ok(isSecurityFinding(r.urgentIssues[0]));
});

check('duplicates across the two input lists collapse to one entry', () => {
    const note = 'hardcoded API key in handler';
    const r = classifyAuditFindings([note], [note]);
    assert.strictEqual(r.findings.length, 1);
});

// ── 7. Explicit anti-regression control ────────────────────────────────────────
check('CONTROL: a reintroduced destructive filter would fail this suite', () => {
    const note = 'minor logic nit about token counting';
    const r = classifyAuditFindings([note], []);
    assert.ok(
        r.findings.includes(note),
        'a non-security note was filtered out — the destructive behaviour is back'
    );
    assert.strictEqual(r.counts.dropped, 0, 'logic notes must never be counted as dropped');
});

const passed = checks.length - failures;
for (const c of checks) {
    if (c.ok) {
        console.log(`PASS  ${c.name}`);
    } else {
        console.log(`FAIL  ${c.name}\n        ${c.error}`);
    }
}

console.log(`\ncheck-audit-classify: ${passed}/${checks.length} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
