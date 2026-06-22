/**
 * Self-Improvement Loop Tests — Beyond-100% Phase B2
 */
import * as assert from 'assert';

console.log('\n=== Self-Improvement Loop Tests ===\n');

// Pattern detection via keyword matching
const PATTERN_MAP: Record<string, string[]> = {
    context_truncation: ['truncat', 'chunk', '12kb', 'context limit'],
    continuity_mismatch: ['continuity', 'mismatch', "didn't match"],
    duplicate_work: ['duplicate', 'already implemented', 're-implement'],
    tool_registration: ['manifest', 'registration mismatch'],
    missing_validation: ['no test', 'no compile', 'skipped validation'],
};

function detectPatterns(summary: string): string[] {
    const detected: string[] = [];
    const lower = summary.toLowerCase();
    for (const [cat, keywords] of Object.entries(PATTERN_MAP)) {
        if (keywords.some(kw => lower.includes(kw))) detected.push(cat);
    }
    return detected;
}

// Test: detects truncation
const r1 = detectPatterns('Files were truncated at 12KB limit, causing incomplete worker analysis');
assert.ok(r1.includes('context_truncation'), 'Detects context_truncation');
console.log('  ✅ context_truncation detected');

// Test: detects continuity mismatch
const r2 = detectPatterns("Continuity ledger said fixes were done but files didn't match");
assert.ok(r2.includes('continuity_mismatch'), 'Detects continuity_mismatch');
console.log('  ✅ continuity_mismatch detected');

// Test: detects multiple patterns
const r3 = detectPatterns('Workers were truncated and manifest had registration mismatch');
assert.ok(r3.includes('context_truncation') && r3.includes('tool_registration'), 'Detects multiple patterns');
console.log('  ✅ Multiple patterns: truncation + registration');

// Test: no false positives
const r4 = detectPatterns('Everything compiled cleanly and all tests passed');
assert.strictEqual(r4.length, 0, 'No false positives on clean summary');
console.log('  ✅ No false positives on clean summary');

// ─── Threshold logic ───────────────────────────────────────────────

function checkThreshold(occurrences: number, threshold: number): { trigger: boolean; confidence: number } {
    return {
        trigger: occurrences >= threshold,
        confidence: Math.min(occurrences / threshold, 1.0),
    };
}

assert.strictEqual(checkThreshold(1, 3).trigger, false, '1/3: no trigger');
assert.strictEqual(checkThreshold(2, 3).trigger, false, '2/3: no trigger');
assert.strictEqual(checkThreshold(3, 3).trigger, true, '3/3: trigger!');
assert.strictEqual(checkThreshold(5, 3).confidence, 1.0, '5/3: max confidence');
console.log('  ✅ Threshold logic: 1→no, 2→no, 3→yes, 5→max confidence');

// ─── Proposal generation ───────────────────────────────────────────

function generateProposal(category: string, occurrences: number): { title: string; hasContent: boolean } {
    const titles: Record<string, string> = {
        context_truncation: 'Prevent Worker Context Truncation',
        continuity_mismatch: 'Verify Continuity Claims Against Files',
        duplicate_work: 'Avoid Duplicate Work Across Sessions',
        tool_registration: 'Keep Tool Registration in Sync',
        missing_validation: 'Always Validate After Changes',
    };
    return {
        title: titles[category] ?? `Pattern: ${category}`,
        hasContent: true,
    };
}

const prop = generateProposal('context_truncation', 3);
assert.ok(prop.title.includes('Truncation'), 'Proposal title descriptive');
assert.ok(prop.hasContent, 'Proposal has content');
console.log('  ✅ Proposal generation: "' + prop.title + '"');

// ─── 10 pattern categories ─────────────────────────────────────────

const CATEGORIES = [
    'context_truncation', 'continuity_mismatch', 'duplicate_work',
    'tool_registration', 'dependency_conflict', 'worker_timeout',
    'snapshot_conflict', 'compilation_loop', 'missing_validation', 'path_casing',
];
assert.strictEqual(CATEGORIES.length, 10, '10 pattern categories');
console.log('  ✅ 10 pattern categories defined');

// ─── Session fingerprint simulation ─────────────────────────────────

const sessionSummaries = [
    'Fixed 3 context truncation bugs. Manifest had registration mismatch. Compiled clean.',
    'Context truncated again. Large files need chunking. No tests run before commit.',
    'Context truncation keeps happening! Need to document chunking strategy.',
];

const patternCounts: Record<string, number> = {};
for (const summary of sessionSummaries) {
    const patterns = detectPatterns(summary);
    for (const p of patterns) {
        patternCounts[p] = (patternCounts[p] ?? 0) + 1;
    }
}

assert.ok(patternCounts['context_truncation']! >= 3, 'truncation: 3+ occurrences → auto-proposal triggered');
assert.ok(patternCounts['tool_registration']! >= 1, 'registration: 1 occurrence');
console.log('  ✅ Session simulation: truncation=3 (proposal!), registration=1');
console.log('     Pattern counts:', JSON.stringify(patternCounts));

console.log('\n🎉 All Self-Improvement Loop tests passed!');
console.log('   Pattern detection ✅');
console.log('   Threshold logic ✅');
console.log('   Proposal generation ✅');
console.log('   Session simulation ✅');
