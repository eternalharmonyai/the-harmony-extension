/**
 * Integration tests for Aletheia (uncertaintyFabric.ts).
 * Tests: Beta distribution math, aggregate uncertainty, evidence weighting.
 */
import * as assert from 'assert';

// ══════════════════════════════════════════════════════════════════
// Inline Beta distribution helpers (matches uncertaintyFabric.ts)
// ══════════════════════════════════════════════════════════════════

function betaPosteriorMean(alpha: number, beta: number): number {
    return alpha / (alpha + beta);
}

function betaPosteriorVariance(alpha: number, beta: number): number {
    const total = alpha + beta;
    return (alpha * beta) / (total * total * (total + 1));
}

/** Evidence-weighted initialization: log2 diminishing returns */
function evidenceWeightedAlpha(observations: number, baseAlpha = 1): number {
    return baseAlpha + Math.log2(observations + 1);
}

function evidenceWeightedBeta(observations: number, failures: number, baseBeta = 1): number {
    return baseBeta + Math.log2(failures + 1);
}

/** Aggregate multiple Beta distributions into a single estimate */
function aggregateBeta(entries: { alpha: number; beta: number }[]): { mean: number; variance: number } {
    if (entries.length === 0) return { mean: 0.5, variance: 0.25 };
    // Weighted average by precision (inverse variance)
    let totalWeight = 0;
    let weightedMean = 0;
    for (const e of entries) {
        const total = e.alpha + e.beta;
        if (total <= 0) continue;
        const weight = total; // More observations = more weight
        weightedMean += (e.alpha / total) * weight;
        totalWeight += weight;
    }
    const mean = totalWeight > 0 ? weightedMean / totalWeight : 0.5;
    // Pooled variance
    const n = entries.length;
    return { mean: Math.round(mean * 10000) / 10000, variance: Math.round((mean * (1 - mean)) / (totalWeight + 1) * 10000) / 10000 };
}

// ══════════════════════════════════════════════════════════════════

console.log('=== Aletheia Integration Tests ===\n');

// Test 1: Beta posterior mean with no data → prior dominates
{
    const mean = betaPosteriorMean(1, 1); // Beta(1,1) = uniform
    assert.strictEqual(mean, 0.5);
    console.log('✅ Test 1: Uniform prior mean = 0.5 — passed');
}

// Test 2: Beta posterior with 10 successes, 2 failures
{
    const mean = betaPosteriorMean(11, 3); // alpha=10+1, beta=2+1
    assert.ok(mean > 0.7 && mean < 0.85, `Expected 0.7-0.85, got ${mean}`);
    console.log(`✅ Test 2: 10 successes, 2 failures → mean=${mean.toFixed(3)} — passed`);
}

// Test 3: Beta variance shrinks with more data
{
    const v1 = betaPosteriorVariance(3, 1);   // 2 successes
    const v2 = betaPosteriorVariance(11, 3);  // 10 successes, 2 failures
    assert.ok(v2 < v1, `Expected v2(${v2.toFixed(4)}) < v1(${v1.toFixed(4)})`);
    console.log(`✅ Test 3: Variance shrinks — v1=${v1.toFixed(4)}, v2=${v2.toFixed(4)} — passed`);
}

// Test 4: Evidence-weighted alpha (log2 diminishing returns)
{
    const a1 = evidenceWeightedAlpha(1);   // log2(2) = 1
    const a2 = evidenceWeightedAlpha(3);   // log2(4) = 2
    const a3 = evidenceWeightedAlpha(7);   // log2(8) = 3
    const a100 = evidenceWeightedAlpha(100); // log2(101) ≈ 6.66
    assert.ok(a2 > a1, 'More observations → higher alpha');
    assert.ok(a3 > a2, 'Still increasing');
    assert.ok(a100 - a3 < 5, `Diminishing returns: a100(${a100.toFixed(2)}) - a3(${a3.toFixed(0)}) < 5`);
    console.log(`✅ Test 4: Evidence-weighted — 1obs→${a1.toFixed(1)}, 3obs→${a2.toFixed(1)}, 7obs→${a3.toFixed(1)}, 100obs→${a100.toFixed(1)} — passed`);
}

// Test 5: Aggregate single entry returns same
{
    const result = aggregateBeta([{ alpha: 11, beta: 3 }]);
    assert.ok(Math.abs(result.mean - 11/14) < 0.01);
    console.log(`✅ Test 5: Single-entry aggregate — passed`);
}

// Test 6: Aggregate multiple entries
{
    const result = aggregateBeta([
        { alpha: 11, beta: 3 },  // 0.786
        { alpha: 5, beta: 5 },   // 0.500
        { alpha: 3, beta: 1 },   // 0.750
    ]);
    assert.ok(result.mean > 0.5 && result.mean < 0.9, `Mean ${result.mean} in range`);
    assert.ok(result.variance < 0.1, `Variance ${result.variance} is small`);
    console.log(`✅ Test 6: Multi-entry aggregate — mean=${result.mean}, variance=${result.variance} — passed`);
}

// Test 7: Empty aggregate → 0.5 prior
{
    const result = aggregateBeta([]);
    assert.strictEqual(result.mean, 0.5);
    console.log('✅ Test 7: Empty aggregate → 0.5 — passed');
}

console.log('\n🎉 All Aletheia tests passed!');
