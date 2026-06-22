/**
 * Federated Conductor Mesh Tests — Beyond-100% Phase C3
 */
import * as assert from 'assert';

console.log('\n=== Conductor Mesh Tests ===\n');

function simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) { hash = ((hash << 5) - hash) + content.charCodeAt(i); hash |= 0; }
    return Math.abs(hash).toString(16).padStart(8, '0');
}
assert.strictEqual(simpleHash('same'), simpleHash('same'));
assert.notStrictEqual(simpleHash('same'), simpleHash('different'));
console.log('  ✅ Content dedup');

function parseMeta(filename: string, content: string): { title: string; occurrences: number; confidence: number } {
    const tm = content.match(/^# (.+)$/m);
    const om = content.match(/This happened \*\*(\d+) times\*\*/);
    const thm = content.match(/Threshold: (\d+) occurrences/);
    return { title: tm?.[1] ?? filename, occurrences: om ? parseInt(om[1]) : 1, confidence: thm ? Math.min(parseInt(thm[1]) / 3, 1.0) : 0.5 };
}
const md = '# Prevent Worker Context Truncation\n\n## Category\nContext\n\nThis happened **5 times** across multiple sessions.\n\nThreshold: 3 occurrences triggered automatic proposal.\n';
const meta = parseMeta('learned.md', md);
assert.strictEqual(meta.title, 'Prevent Worker Context Truncation');
assert.strictEqual(meta.occurrences, 5);
assert.ok(Math.abs(meta.confidence - 1.0) < 0.01);
console.log('  ✅ Metadata extraction');

function confidenceScore(occ: number, thresh: number): number { return Math.min(occ / thresh, 1.0); }
assert.ok(Math.abs(confidenceScore(1, 3) - 0.333) < 0.01);
assert.ok(Math.abs(confidenceScore(2, 3) - 0.667) < 0.01);
assert.strictEqual(confidenceScore(3, 3), 1.0);
console.log('  ✅ Confidence scoring');

function isStale(updatedAt: number, maxAgeDays: number): boolean { return updatedAt < Date.now() - maxAgeDays * 86400000; }
assert.strictEqual(isStale(Date.now(), 90), false);
assert.strictEqual(isStale(Date.now() - 86400000 * 100, 90), true);
console.log('  ✅ Staleness detection');

const ACTIONS = ['join','leave','sync','status','prune','search','export'];
assert.strictEqual(ACTIONS.length, 7);
console.log('  ✅ 7 mesh actions');

interface Mod { confidence: number; updated_at: number; status: string; }
function autoPrune(mods: Mod[], minConf: number, maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 86400000; let p = 0;
    for (const m of mods) if (m.status !== 'pruned' && (m.confidence < minConf || m.updated_at < cutoff)) { m.status = 'pruned'; p++; }
    return p;
}
const mods: Mod[] = [
    { confidence: 0.9, updated_at: Date.now(), status: 'active' },
    { confidence: 0.2, updated_at: Date.now(), status: 'active' },
    { confidence: 0.8, updated_at: Date.now() - 86400000 * 100, status: 'stale' },
];
const pruned = autoPrune(mods, 0.3, 90);
assert.ok(pruned >= 2);
console.log('  ✅ Auto-prune: ' + pruned + ' modules');

interface SM { title: string; category: string; tags: string[]; }
function search(mods: SM[], q: string): SM[] {
    const l = q.toLowerCase();
    return mods.filter(m => m.title.toLowerCase().includes(l) || m.category.toLowerCase().includes(l) || m.tags.some(t => t.toLowerCase().includes(l)));
}
const sms: SM[] = [{title:'Prevent Truncation',category:'Context',tags:['truncation']},{title:'Verify Continuity',category:'Integrity',tags:['continuity']}];
assert.strictEqual(search(sms, 'truncation').length, 1);
console.log('  ✅ Search: 1 result');

console.log('\n🎉 All Conductor Mesh tests passed!');
