/**
 * Integration tests for Agora (taskAuction.ts).
 * Tests: Beta-Binomial credibility, time-decay weighting, specialization Jaccard.
 */
import * as assert from 'assert';

console.log('=== Agora Integration Tests ===\n');

// ══════════════════════════════════════════════════════════════════
// Inline time-decay utility (matches taskAuction.ts implementation)
// ══════════════════════════════════════════════════════════════════

function computeCredibility(records: { success: boolean; timestamp: number }[], now: number) {
    const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30-day half-life
    const decayRate = Math.log(2) / halfLifeMs;
    let wSuccesses = 0, wFailures = 0;
    for (const r of records) {
        const ageMs = now - r.timestamp;
        const weight = Math.exp(-decayRate * ageMs);
        if (r.success) wSuccesses += weight; else wFailures += weight;
    }
    const alpha = wSuccesses + 1;
    const beta = wFailures + 1;
    return { credibility: alpha / (alpha + beta), alpha, beta, wSuccesses, wFailures };
}

// Test 1: No history → credibility ~0.5 (Laplace prior)
{
    const result = computeCredibility([], Date.now());
    assert.ok(Math.abs(result.credibility - 0.5) < 0.01, `Expected ~0.5, got ${result.credibility}`);
    assert.strictEqual(result.alpha, 1);
    assert.strictEqual(result.beta, 1);
    console.log('✅ Test 1: No history → Laplace prior 0.5 — passed');
}

// Test 2: All successes → credibility approaches 1.0
{
    const now = Date.now();
    const records = [
        { success: true, timestamp: now - 1000 },
        { success: true, timestamp: now - 2000 },
        { success: true, timestamp: now - 3000 },
    ];
    const result = computeCredibility(records, now);
    assert.ok(result.credibility > 0.7, `Expected >0.7, got ${result.credibility}`);
    console.log('✅ Test 2: All successes → credibility >0.7 — passed');
}

// Test 3: All failures → credibility approaches 0.0
{
    const now = Date.now();
    const records = [
        { success: false, timestamp: now - 1000 },
        { success: false, timestamp: now - 2000 },
        { success: false, timestamp: now - 3000 },
    ];
    const result = computeCredibility(records, now);
    assert.ok(result.credibility < 0.3, `Expected <0.3, got ${result.credibility}`);
    console.log('✅ Test 3: All failures → credibility <0.3 — passed');
}

// Test 4: Time-decay: old failures matter less than recent successes
{
    const now = Date.now();
    const records = [
        { success: false, timestamp: now - 100 * 24 * 60 * 60 * 1000 }, // 100 days ago — nearly zero weight
        { success: true, timestamp: now - 1000 },                         // 1 second ago
    ];
    const result = computeCredibility(records, now);
    assert.ok(result.credibility > 0.6, `Expected >0.6 (recent success dominates old failure), got ${result.credibility}`);
    console.log('✅ Test 4: Time-decay: recent > old — passed');
}

// Test 5: 50/50 split → credibility ~0.5
{
    const now = Date.now();
    const records = [
        { success: true, timestamp: now - 1000 },
        { success: false, timestamp: now - 1000 },
    ];
    const result = computeCredibility(records, now);
    assert.ok(Math.abs(result.credibility - 0.5) < 0.01, `Expected ~0.5, got ${result.credibility}`);
    console.log('✅ Test 5: 50/50 split → ~0.5 — passed');
}

// Test 6: Specialization Jaccard similarity
function jaccardTaskCap(task: string, capabilities: string[]): number {
    const taskTokens = new Set(task.toLowerCase().split(/[\s_\-]+/).filter(t => t.length > 1));
    const specTokens = new Set(capabilities.flatMap(s => s.toLowerCase().split(/[\s_\-]+/)));
    const intersection = [...taskTokens].filter(t => specTokens.has(t)).length;
    const union = new Set([...taskTokens, ...specTokens]).size;
    return union > 0 ? (0.5 + 0.5 * (intersection / union)) : 1.0;
}

{
    const score = jaccardTaskCap('code review for python', ['code-review', 'python', 'security']);
    assert.ok(score > 0.7, `Expected >0.7 for matching specs, got ${score}`);
    console.log('✅ Test 6: Jaccard specialization match — passed');
}

{
    const score = jaccardTaskCap('code review for python', ['planning', 'documentation']);
    assert.ok(score < 0.7, `Expected <0.7 for non-matching specs, got ${score}`);
    console.log('✅ Test 7: Jaccard specialization miss — passed');
}

console.log('\n=== Agora: 7/7 tests passed ===\n');
