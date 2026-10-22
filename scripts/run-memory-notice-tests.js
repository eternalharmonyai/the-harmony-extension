#!/usr/bin/env node
/**
 * run-memory-notice-tests.js
 *
 * Memory-health notice severity classification: case table + mutation sensitivity check.
 *
 * EXIT CODES
 *   0  all cases pass AND every mutant is caught
 *   1  a case failed, or a mutant slipped through
 *   2  the module under test does not exist yet
 */

'use strict';

const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'out', 'memoryNotice.js');

const SILENT = 'silent';
const INFO = 'info';
const WARNING = 'warning';
const ERROR = 'error';

// ─── The contract under test ────────────────────────────────────────────────
// health: the /ext/v1/health body (snake_case, as the Hub sends it)
// text(key): localization stub
// returns: { severity, key } — key is null when severity === 'silent'

// A realistic localization stub: real templates with real placeholders.
// A stub that returns bare keys cannot exercise placeholder substitution — and then
// a raw `{reason}` reaching a user would sail straight through the suite.
const TEMPLATES = {
    'memory.adopted': 'Harmony memory adopted the existing snapshot: generation {generation}, {entries} entries.',
    'memory.stateNote': 'Harmony memory: {reason}',
    'memory.backupSkipped': 'Harmony memory is not keeping a rolling backup — {reason}',
    'memory.healthAttention': 'Harmony memory needs attention — {reason}',
    'memory.healthUnreadable': 'Harmony memory health could not be read — {reason}',
    'memory.unknownReason': 'no reason reported',
};

const T = (key) => TEMPLATES[key] ?? `[${key}]`;

// ─── Verbatim Hub sentences ─────────────────────────────────────────────────
// Copied from the Hub's src/memory.rs. Paraphrases are dangerous here:
// the classifier decides lossless-vs-lossy by matching these exact words, so a
// paraphrase in the test would pass while the REAL message fell through to the
// warning default. Case 16 pins every literal back to the Hub source.
const HUB = {
    // :159
    losslessAdopt: 'pre-manifest snapshot adopted and checksummed (no rebuild needed)',
    // :174
    losslessManifestRewritten: 'snapshot adopted and checksummed (manifest was unreadable and rewritten)',
    // :207
    losslessPrevComplete: 'recovered the previous complete generation 3 (checksum verified against the retained manifest); the interrupted commit was discarded',
    // :212
    losslessInterrupted: 'recovered generation 2 - a two-phase commit was interrupted before the new snapshot was published',
    // :238
    losslessPending: "committed a 'pending' save from an interrupted restart (generation 3)",
    // :309 — LOSSY: the newest save is gone, yet the Hub reports it as `loaded`.
    lossyFallback: 'current snapshot missing; recovered the previous generation (2)',
    // :215 — LOSSY/unknown provenance.
    lossyReplaced: 'the snapshot does not match the checksum its complete manifest records, so it was replaced outside the daemon (a restore, a save by an older build, or disk damage); the manifest was re-baselined',
    // :326 — LOSSY: everything was dropped.
    corruptEmpty: 'no usable snapshot remains; starting empty (all bad bytes were preserved); memory will save to a fresh generation',
    // :686
    backupSkipped: 'the previous generation belongs to a different configuration; it is not overwritten, so no rolling backup is being kept',
};

function health(fields) {
    return {
        memory_state: undefined,
        memory_reason: null,
        memory_last_error: null,
        memory_backup_skipped: null,
        memory_generation: 1,
        memory_entries: 0,
        ...fields,
    };
}

// Each case drives a *fresh* session unless `sameSession: true`.
const CASES = [
    {
        id: 1,
        name: 'fresh install stays quiet (plain empty)',
        health: health({ memory_state: 'empty' }),
        want: { severity: SILENT, key: null },
    },
    {
        id: 2,
        name: 'a real last_error warns',
        health: health({ memory_state: 'loaded', memory_last_error: 'disk damage on the snapshot' }),
        want: { severity: WARNING, key: 'lastError' },
    },
    {
        id: 3,
        name: 'benign backup_skipped is INFO, not a warning',
        health: health({
            memory_state: 'loaded',
            memory_backup_skipped: 'previous generation belongs to a different configuration',
        }),
        want: { severity: INFO, key: 'backupSkipped' },
    },
    {
        id: 4,
        name: 'the backup_skipped info speaks only once per session',
        health: health({
            memory_state: 'loaded',
            memory_backup_skipped: 'previous generation belongs to a different configuration',
        }),
        want: { severity: INFO, key: 'backupSkipped' },
        sameSession: true,
        secondRead: { severity: SILENT, key: null },
    },
    {
        id: 5,
        name: 'adopt receipt is INFO and leaves the failure slot FREE',
        health: health({ memory_state: 'adopted', memory_reason: HUB.losslessAdopt }),
        want: { severity: INFO, key: 'adopted' },
        sameSession: true,
        // after the receipt, a real failure in the SAME session must still warn
        thenHealth: health({ memory_state: 'loaded', memory_last_error: 'publish failed' }),
        thenWant: { severity: WARNING, key: 'lastError' },
    },
    {
        id: 6,
        name: 'incompatible is an ERROR (writes are paused)',
        health: health({ memory_state: 'incompatible', memory_reason: 'model mismatch' }),
        want: { severity: ERROR, key: 'incompatible' },
    },
    {
        id: 7,
        name: 'corrupt warns',
        health: health({ memory_state: 'corrupt', memory_last_error: 'snapshot lost with a manifest present' }),
        want: { severity: WARNING, key: 'lastError' },
    },
    {
        id: 8,
        name: 'two DIFFERENT info conditions both speak in one session',
        health: health({
            memory_state: 'loaded',
            memory_backup_skipped: 'previous generation belongs to a different configuration',
        }),
        want: { severity: INFO, key: 'backupSkipped' },
        sameSession: true,
        thenHealth: health({
            memory_state: 'loaded',
            memory_reason: HUB.losslessPending,
        }),
        thenWant: { severity: INFO, key: 'stateNote' },
    },
    {
        id: 9,
        name: 'an unreadable read reports the transport reason, never a raw {reason}',
        unread: { detail: 'HTTP 500: hub paused' },
        want: { severity: WARNING, key: 'healthUnreadable' },
        mustContain: 'HTTP 500: hub paused',
    },
    {
        id: 10,
        name: 'a LOSSY fallback reported as loaded WARNS — the newest save is gone',
        health: health({ memory_state: 'loaded', memory_reason: HUB.lossyFallback }),
        want: { severity: WARNING, key: 'stateNote' },
        mustContain: 'recovered the previous generation',
    },
    {
        id: 11,
        name: 'a LOSSLESS recovery stays INFO (no false alarm)',
        health: health({ memory_state: 'loaded', memory_reason: HUB.losslessPrevComplete }),
        want: { severity: INFO, key: 'stateNote' },
        mustContain: 'recovered the previous complete generation',
    },
    {
        id: 12,
        name: "backup_skipped quotes the Hub's own words, not 'no reason reported'",
        health: health({ memory_state: 'loaded', memory_backup_skipped: HUB.backupSkipped }),
        want: { severity: INFO, key: 'backupSkipped' },
        mustContain: 'no rolling backup is being kept',
        mustNotContain: 'no reason reported',
    },
    {
        id: 13,
        name: "last_error quotes memory_last_error, not 'no reason reported'",
        health: health({ memory_state: 'loaded', memory_last_error: 'disk damage on the snapshot' }),
        want: { severity: WARNING, key: 'lastError' },
        mustContain: 'disk damage on the snapshot',
        mustNotContain: 'no reason reported',
    },
    {
        id: 14,
        name: 'corrupt with NO last_error still reports the real words, never "could not be read"',
        health: health({ memory_state: 'corrupt', memory_reason: HUB.corruptEmpty }),
        want: { severity: WARNING, key: 'corrupt' },
        mustContain: 'no usable snapshot remains',
        mustNotContain: 'could not be read',
    },
    {
        id: 15,
        name: 'an unrecognised adoption reason WARNS and keeps the Hub sentence',
        health: health({ memory_state: 'adopted', memory_reason: HUB.lossyReplaced }),
        want: { severity: WARNING, key: 'stateNote' },
        mustContain: 'replaced outside the daemon',
    },
];

// ─── Mutants: each MUST fail the table ──────────────────────────────────────

const MUTANTS = [
    {
        id: 'M1',
        name: 'collapsing backupSkipped into the warning slot',
        // Affects EVERY read of a backup_skipped condition: cases 3, 4 and 8's first read.
        mustFail: [3, 4, 8, 12],
    },
    {
        id: 'M2',
        name: 'single shared flag: the adopt receipt consumes the failure slot',
        // Affects EVERY lastError read: cases 2, 5's later read, and 7.
        mustFail: [2, 5, 7, 13],
    },
    {
        id: 'M3',
        name: 'reason treated as silent for incompatible',
        mustFail: [6],
    },
    {
        id: 'M4',
        name: 'dedupe disabled: the same info re-fires every read',
        mustFail: [4],
    },
    {
        id: 'M5',
        name: 'one info slot per session: a second DISTINCT info is suppressed',
        mustFail: [8],
    },
    {
        id: 'M6',
        name: 'any last_error demoted to informational',
        mustFail: [2, 5, 7, 13],
    },
    {
        id: 'M7',
        name: 'every recovery reason treated as a lossless receipt',
        mustFail: [10, 15],
    },
    {
        id: 'M8',
        name: "backup notice reads memory_reason, losing the Hub's words",
        mustFail: [12],
    },
    {
        id: 'M9',
        name: 'a corrupt store described as an unreadable read',
        mustFail: [14],
    },
];

// ─── Harness ────────────────────────────────────────────────────────────────

function judge(got, want) {
    if (!got) return { ok: false, why: 'no notice returned' };
    const sevOk = got.severity === want.severity;
    const keyOk = (got.key ?? null) === (want.key ?? null);
    if (sevOk && keyOk) return { ok: true };
    return {
        ok: false,
        why: `expected ${want.severity}/${want.key ?? '-'}, got ${got.severity}/${got.key ?? '-'}`,
    };
}

/**
 * @param makeSession () => { consider(health, text): {severity,key}|null }
 */
function runSuite(makeSession, label) {
    const results = [];
    for (const c of CASES) {
        const session = makeSession();
        let ok = true;
        let why = '';

        const first = c.unread
            ? session.considerUnreadable(T, c.unread.detail)
            : session.consider(c.health, T);
        const v1 = judge(first ?? { severity: SILENT, key: null }, c.want);
        if (!v1.ok) { ok = false; why = `first read: ${v1.why}`; }

        // A notice must never render a raw placeholder to a user.
        if (ok && c.mustContain && !(first && String(first.text).includes(c.mustContain))) {
            ok = false;
            why = `first read text did not contain ${JSON.stringify(c.mustContain)} (got ${JSON.stringify(first && first.text)})`;
        }
        // Notice text must carry the evidence, not just the right severity.
        if (ok && c.mustNotContain && first && String(first.text).includes(c.mustNotContain)) {
            ok = false;
            why = `first read text must NOT contain ${JSON.stringify(c.mustNotContain)} (got ${JSON.stringify(first.text)})`;
        }
        if (ok && first && /\{(reason|generation|entries)\}/.test(String(first.text))) {
            ok = false;
            why = `first read leaked a raw placeholder: ${JSON.stringify(first.text)}`;
        }

        if (ok && c.secondRead) {
            const second = session.consider(c.health, T);
            const v2 = judge(second ?? { severity: SILENT, key: null }, c.secondRead);
            if (!v2.ok) { ok = false; why = `second read: ${v2.why}`; }
        }

        if (ok && c.thenHealth) {
            const later = session.consider(c.thenHealth, T);
            const v3 = judge(later ?? { severity: SILENT, key: null }, c.thenWant);
            if (!v3.ok) { ok = false; why = `later read: ${v3.why}`; }
        }

        results.push({ id: c.id, name: c.name, ok, why });
    }

    const failed = results.filter((r) => !r.ok);
    return { label, results, failed, passed: results.length - failed.length, total: results.length };
}

function report(run, { expectAllPass }) {
    const verdict = expectAllPass
        ? run.failed.length === 0 ? 'PASS' : 'FAIL'
        : run.failed.length > 0 ? 'CAUGHT' : 'BLIND';
    console.log(`\n── ${run.label}: ${verdict} (${run.passed}/${run.total})`);
    for (const r of run.results) {
        const mark = r.ok ? '  ok  ' : ' FAIL ';
        console.log(`   ${mark} case ${r.id} ${r.name}${r.ok ? '' : ` — ${r.why}`}`);
    }
    return verdict;
}

// ─── Hub-literal pin ────────────────────────────────────────────────────────
// The lossless allow-list in src/memoryNotice.ts matches English sentences the Hub
// sends. If the Hub rewords one, the classifier falls back to "warn" — safe, but a
// false alarm for the user. This check turns that into a test failure instead.
//
// It pins the REAL exported list, not a copy, so it cannot drift away from the code.
// memory.rs lives outside this workspace: its absence is REPORTED (never silently
// skipped) but does not fail a machine that only has the extension.
// The Hub workspace may live anywhere: an explicit override wins, otherwise the usual
// sibling checkout is tried. No absolute path is baked in — this script is published.
const HUB_SOURCE = (process.env.HARMONY_HUB_SOURCE || '').trim()
    || require('path').join(process.cwd(), '..', 'HarmonyHub', 'src', 'memory.rs');

function checkHubPin(mod) {
    const list = mod.LOSSLESS_REASON_PREFIXES;
    if (!Array.isArray(list) || list.length === 0) {
        console.error('\n── HUB LITERAL PIN: FAIL — the classifier exports no allow-list.');
        return true;
    }

    let src;
    try {
        src = require('fs').readFileSync(HUB_SOURCE, 'utf8');
    } catch (e) {
        console.log(`\n── HUB LITERAL PIN: SKIPPED (no ${HUB_SOURCE} on this machine)`);
        console.log('   The allow-list is UNVERIFIED here — treat a green run as partial.');
        return false;
    }

    let bad = false;

    // Negative control FIRST: prove we are reading the file we think we are. If a
    // sentence we KNOW is the lossy (warn) one is missing, we have the wrong file and
    // a green pin would mean nothing.
    const lossySentinel = 'recovered the previous generation';
    if (!src.includes(lossySentinel)) {
        console.error(`\n── HUB LITERAL PIN: FAIL — cannot find ${JSON.stringify(lossySentinel)}.`);
        console.error('   Wrong file: the allow-list below would prove nothing. Fix HUB_SOURCE.');
        return true;
    }

    for (const prefix of list) {
        if (!src.includes(prefix)) {
            bad = true;
            console.error(`   ⚠ allow-list entry no longer appears in memory.rs: ${JSON.stringify(prefix)}`);
        }
    }

    // The lossy look-alike must never be promoted into the list by accident: it reads
    // almost identically to the lossless one but means the newest save was discarded.
    if (list.some((p) => lossySentinel.startsWith(p) || p === lossySentinel)) {
        bad = true;
        console.error(`   ⚠ the LOSSY sentence ${JSON.stringify(lossySentinel)} is in the allow-list.`);
        console.error('     That would report a discarded save as a harmless receipt.');
    }

    console.log(
        `\n── HUB LITERAL PIN: ${bad ? 'DRIFT' : 'OK'} ` +
        `(${list.length} entries verified against memory.rs)`,
    );
    return bad;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
    let mod = null;
    try {
        mod = require(MODULE_PATH);
    } catch (e) {
        console.error('\n════════════════════════════════════════════════════════════');
        console.error('  MODULE NOT BUILT — the extraction has not landed.');
        console.error(`  expected: ${MODULE_PATH}`);
        console.error(`  reason  : ${String((e && e.message) || e)}`);
        console.error('');
        console.error('  This suite is RED BY DESIGN until src/memoryNotice.ts is');
        console.error('  extracted, exports MemoryNoticeSession, and is compiled.');
        console.error('  See the memory-notice severity notes for the allow-list rationale.');
        console.error('════════════════════════════════════════════════════════════\n');
        process.exit(2);
    }

    if (typeof mod.MemoryNoticeSession !== 'function') {
        console.error('\nFAIL: out/memoryNotice.js does not export MemoryNoticeSession.\n');
        process.exit(1);
    }

    const makeReal = () => new mod.MemoryNoticeSession();

    console.log('═'.repeat(64));
    console.log(' memory health notice — severity split test suite');
    console.log('═'.repeat(64));

    let bad = false;

    // Print the roster BEFORE running anything. A check that silently fails to execute
    // is otherwise indistinguishable from a check that passed — which is exactly how
    // this pin was briefly dead code while the suite still reported PASS.
    console.log(`\n checks scheduled: hub-literal pin + ${CASES.length} cases + ${MUTANTS.length} mutants`);
    if (checkHubPin(mod)) bad = true;

    const real = runSuite(makeReal, 'REAL implementation');
    if (report(real, { expectAllPass: true }) !== 'PASS') bad = true;

    for (const m of MUTANTS) {
        // A mutant is a wrapper that reproduces the regression on top of the
        // real session, so the difference under test is exactly the regression.
        const makeMutant = () => {
            const inner = new mod.MemoryNoticeSession();

            // None of these mutants touch the unreadable path, so it always delegates.
            const considerUnreadable = (text, detail) => inner.considerUnreadable(text, detail);

            if (m.id === 'M4') {
                // Dedupe removed entirely: call the raw classifier on every read.
                // (This is why the classifier itself is exported separately.)
                return {
                    consider(h, text) {
                        const n = mod.classifyMemoryHealthNotice(h, text);
                        return n && n.severity !== SILENT ? n : null;
                    },
                    considerUnreadable,
                };
            }

            if (m.id === 'M5') {
                // One info slot for the whole session, regardless of key.
                let infoFired = false;
                return {
                    consider(h, text) {
                        const n = inner.consider(h, text);
                        if (n && n.severity === INFO) {
                            if (infoFired) return null;
                            infoFired = true;
                        }
                        return n;
                    },
                    considerUnreadable,
                };
            }

            return {
                consider(h, text) {
                    const notice = inner.consider(h, text);
                    if (!notice) return null;
                    if (m.id === 'M1' && notice.key === 'backupSkipped') {
                        return { severity: WARNING, key: 'backupSkipped' };
                    }
                    if (m.id === 'M2' && notice.key === 'lastError') {
                        // the adopt receipt swallowed the failure slot
                        return { severity: INFO, key: 'adopted' };
                    }
                    if (m.id === 'M3' && notice.key === 'incompatible') {
                        return { severity: SILENT, key: null };
                    }
                    if (m.id === 'M6' && notice.key === 'lastError') {
                        return { severity: INFO, key: 'lastError' };
                    }
                    if (m.id === 'M7' && notice.severity === WARNING && notice.key === 'stateNote') {
                        return { severity: INFO, key: 'stateNote', text: notice.text };
                    }
                    if (m.id === 'M8' && notice.key === 'backupSkipped') {
                        // Reads memory_reason instead of memory_backup_skipped: the Hub's words vanish.
                        return {
                            severity: INFO,
                            key: 'backupSkipped',
                            text: 'Harmony memory is not keeping a rolling backup — no reason reported',
                        };
                    }
                    if (m.id === 'M9' && notice.key === 'corrupt') {
                        // Describes a successful read as a failed one.
                        return {
                            severity: WARNING,
                            key: 'healthUnreadable',
                            text: `Harmony memory health could not be read — ${notice.text || ''}`,
                        };
                    }
                    return notice;
                },
                considerUnreadable,
            };
        };

        const run = runSuite(makeMutant, `MUTANT ${m.id} — ${m.name}`);
        report(run, { expectAllPass: false });

        // A mutant counts as caught ONLY when the EXACT expected case set fails.
        // Too few = blind spot. Too many = wrong-reason kill, which proves nothing
        // about the regression we meant to probe.
        const caughtIds = run.failed.map((r) => r.id).sort((a, b) => a - b);
        const expected = [...m.mustFail].sort((a, b) => a - b);
        const missing = expected.filter((id) => !caughtIds.includes(id));
        const extra = caughtIds.filter((id) => !expected.includes(id));

        if (missing.length) {
            bad = true;
            console.error(`   ⚠ ${m.id} was NOT caught where it matters.`);
            console.error(`     expected case(s) ${expected.join(',')} to fail — got ${caughtIds.join(',') || 'none'}`);
        } else if (extra.length) {
            bad = true;
            console.error(`   ⚠ ${m.id} failed case(s) ${extra.join(',')} that were NOT expected.`);
            console.error('     Wrong-reason kill: the mutant is not a clean probe of the regression.');
        }
    }

    console.log('\n' + '═'.repeat(64));
    if (bad) {
        console.log(' RESULT: FAIL');
        console.log('═'.repeat(64) + '\n');
        process.exit(1);
    }
    console.log(` RESULT: PASS — all cases green and all ${MUTANTS.length} mutants caught`);
    console.log('═'.repeat(64) + '\n');
    process.exit(0);
}

main();
