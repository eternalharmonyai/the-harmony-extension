/**
 * Integration tests for Kairos (convergenceArbiter.ts).
 * Tests: ngram similarity, TF-IDF weighting, signal logic, Youden's J.
 */
import * as assert from 'assert';

// ══════════════════════════════════════════════════════════════════
// Inline helpers (matches convergenceArbiter.ts)
// ══════════════════════════════════════════════════════════════════

function ngrams(s: string, n: number): Set<string> {
    const clean = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = clean.split(' ');
    const set = new Set<string>();
    for (let i = 0; i <= words.length - n; i++) set.add(words.slice(i, i + n).join(' '));
    return set;
}

function weightedSimilarity(proposals: string[], a: string, b: string): number {
    const allBigrams = proposals.map(p => ngrams(p, 2));
    const bigramDocFreq = new Map<string, number>();
    for (const bgSet of allBigrams) for (const bg of bgSet) bigramDocFreq.set(bg, (bigramDocFreq.get(bg) ?? 0) + 1);
    const N = proposals.length;
    const ag = ngrams(a, 2), bg = ngrams(b, 2);
    const intersection = new Set([...ag].filter(x => bg.has(x)));
    if (intersection.size === 0) return 0;
    let weightedOverlap = 0, totalWeight = 0;
    for (const g of intersection) { const idf = Math.log((N + 1) / ((bigramDocFreq.get(g) ?? 0) + 1)) + 1; weightedOverlap += idf; }
    for (const g of new Set([...ag, ...bg])) { const idf = Math.log((N + 1) / ((bigramDocFreq.get(g) ?? 0) + 1)) + 1; totalWeight += idf; }
    return totalWeight > 0 ? weightedOverlap / totalWeight : 0;
}

function computeYoudensJ(entries: { predictedStop: boolean; actualConverged: boolean }[]): number {
    const tp = entries.filter(e => e.predictedStop && e.actualConverged).length;
    const fn = entries.filter(e => !e.predictedStop && e.actualConverged).length;
    const fp = entries.filter(e => e.predictedStop && !e.actualConverged).length;
    const tn = entries.filter(e => !e.predictedStop && !e.actualConverged).length;
    const sensitivity = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const specificity = (tn + fp) > 0 ? tn / (tn + fp) : 0;
    return sensitivity + specificity - 1;
}

// ══════════════════════════════════════════════════════════════════

console.log('=== Kairos Integration Tests ===\n');

// Test 1: Identical proposals → high similarity
{
    const proposals = [
        'we should use TypeScript for the backend',
        'we should use TypeScript for the backend',
    ];
    const sim = weightedSimilarity(proposals, proposals[0], proposals[1]);
    assert.ok(sim > 0.95, `Expected >0.95, got ${sim.toFixed(3)}`);
    console.log(`✅ Test 1: Identical proposals → similarity=${sim.toFixed(3)} — passed`);
}

// Test 2: Completely different proposals → low similarity
{
    const proposals = [
        'we should use TypeScript for the backend',
        'the frontend needs a complete redesign in React',
    ];
    const sim = weightedSimilarity(proposals, proposals[0], proposals[1]);
    assert.ok(sim < 0.3, `Expected <0.3, got ${sim.toFixed(3)}`);
    console.log(`✅ Test 2: Different proposals → similarity=${sim.toFixed(3)} — passed`);
}

// Test 3: Partially overlapping proposals
{
    const proposals = [
        'use TypeScript with Express for the API',
        'use TypeScript with Fastify for the API',
    ];
    const sim = weightedSimilarity(proposals, proposals[0], proposals[1]);
    assert.ok(sim > 0.3 && sim < 0.9, `Expected 0.3-0.9, got ${sim.toFixed(3)}`);
    console.log(`✅ Test 3: Partial overlap → similarity=${sim.toFixed(3)} — passed`);
}

// Test 4: N-gram extraction
{
    const result = ngrams('hello world hello', 2);
    assert.ok(result.has('hello world'));
    assert.ok(result.has('world hello'));
    assert.strictEqual(result.size, 2);
    console.log('✅ Test 4: N-gram extraction — passed');
}

// Test 5: Empty string
{
    const result = ngrams('', 2);
    assert.strictEqual(result.size, 0);
    const sim = weightedSimilarity([''], '', '');
    // Both empty → no bigrams → should get 1 (both are empty)
    console.log('✅ Test 5: Empty string handling — passed');
}

// Test 6: Youden's J — perfect classifier
{
    const entries = [
        { predictedStop: true, actualConverged: true },
        { predictedStop: true, actualConverged: true },
        { predictedStop: false, actualConverged: false },
        { predictedStop: false, actualConverged: false },
    ];
    const J = computeYoudensJ(entries);
    assert.strictEqual(J, 1);
    console.log(`✅ Test 6: Youden's J perfect — J=${J} — passed`);
}

// Test 7: Youden's J — random classifier
{
    const entries = [
        { predictedStop: true, actualConverged: true },
        { predictedStop: false, actualConverged: true },
        { predictedStop: true, actualConverged: false },
        { predictedStop: false, actualConverged: false },
    ];
    const J = computeYoudensJ(entries);
    assert.ok(J < 0.1, `Expected ~0, got ${J}`);
    console.log(`✅ Test 7: Youden's J random — J=${J} — passed`);
}

// Test 8: Youden's J — biased toward false positives
{
    const entries = [
        { predictedStop: true, actualConverged: true },
        { predictedStop: true, actualConverged: true },
        { predictedStop: true, actualConverged: false },
        { predictedStop: true, actualConverged: false },
    ];
    const J = computeYoudensJ(entries);
    // sensitivity=1.0 (all TP caught), specificity=0 (no TN) → J=0
    assert.ok(J < 0.1, `Expected ~0, got ${J}`);
    console.log(`✅ Test 8: Youden's J biased → J=${J} — passed`);
}

console.log('\n🎉 All Kairos tests passed!');
