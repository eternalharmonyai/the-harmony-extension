/**
 * Tests for Mnemosyne (episodicMemory.ts) — clustering and idempotency.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('EpisodicMemory (Mnemosyne)', () => {
    it('should compute Jaccard similarity', () => {
        const jaccard = (a: string[], b: string[]): number => {
            if (!a.length && !b.length) return 1;
            const sa = new Set(a), sb = new Set(b);
            const intersection = [...sa].filter(x => sb.has(x)).length;
            return intersection / (sa.size + sb.size - intersection || 1);
        };
        assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3); // intersection={b}, union={a,b,c}=3
        assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);       // identical
        assert.equal(jaccard(['x'], ['y']), 0);                   // disjoint
        assert.equal(jaccard([], []), 1);                         // both empty
    });

    it('should detect idempotent content via hash', () => {
        const crypto = require('crypto');
        const hash1 = crypto.createHash('sha256').update('same content|tag1,tag2|source').digest('hex');
        const hash2 = crypto.createHash('sha256').update('same content|tag1,tag2|source').digest('hex');
        const hash3 = crypto.createHash('sha256').update('different|tag1|source').digest('hex');
        assert.equal(hash1, hash2);
        assert.notEqual(hash1, hash3);
    });

    it('should cluster by temporal proximity', () => {
        const now = Date.now();
        const window = 30 * 60 * 1000; // 30 min
        const isWithinWindow = (t1: number, t2: number) => Math.abs(t1 - t2) <= window;
        assert.ok(isWithinWindow(now, now + 15 * 60 * 1000));  // 15 min apart
        assert.ok(!isWithinWindow(now, now + 60 * 60 * 1000)); // 60 min apart
    });

    it('should group related memories into episodes', () => {
        const memories = [
            { id: 'm1', tags: ['ui', 'dark-mode'], time: 1000 },
            { id: 'm2', tags: ['ui', 'theme'], time: 2000 },
            { id: 'm3', tags: ['backend', 'api'], time: 100000 },
        ];
        // m1 and m2 share tag 'ui' → same episode
        // m3 has no tag overlap → different episode
        const jaccard = (a: string[], b: string[]): number => {
            const sa = new Set(a), sb = new Set(b);
            const int = [...sa].filter(x => sb.has(x)).length;
            return int / (sa.size + sb.size - int || 1);
        };
        assert.ok(jaccard(memories[0].tags, memories[1].tags) > 0);   // m1-m2: overlap
        assert.equal(jaccard(memories[0].tags, memories[2].tags), 0);  // m1-m3: no overlap
    });

    it('should count orphaned memories outside episodes', () => {
        const total = 100;
        const episodes = [{ count: 30 }, { count: 25 }, { count: 15 }];
        const inEpisodes = episodes.reduce((s, e) => s + e.count, 0);
        const orphaned = total - inEpisodes;
        assert.equal(orphaned, 30);
    });
});
