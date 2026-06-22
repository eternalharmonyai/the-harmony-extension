/**
 * Tests for Ethos (valueResolver.ts) — multi-stakeholder resolution math.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('ValueResolver (Ethos)', () => {
    it('should compute weighted stakeholder scores', () => {
        const tierMultipliers: Record<number, number> = { 1: 5, 2: 3, 3: 1 };
        const stakeholders = [
            { id: 'u1', weight: 0.8, tier: 1 as const, utilities: { opt1: 0.9, opt2: 0.2 } },
            { id: 'u2', weight: 0.5, tier: 2 as const, utilities: { opt1: 0.4, opt2: 0.8 } },
        ];
        const scoreOpt1 = stakeholders.reduce((s, st) => s + st.weight * (st.utilities.opt1 ?? 0) * (tierMultipliers[st.tier] ?? 1), 0);
        const scoreOpt2 = stakeholders.reduce((s, st) => s + st.weight * (st.utilities.opt2 ?? 0) * (tierMultipliers[st.tier] ?? 1), 0);
        // u1 (tier1, wt0.8): opt1=0.9*0.8*5=3.6, opt2=0.2*0.8*5=0.8
        // u2 (tier2, wt0.5): opt1=0.4*0.5*3=0.6, opt2=0.8*0.5*3=1.2
        // opt1 total: 4.2, opt2 total: 2.0
        assert.ok(scoreOpt1 > scoreOpt2);
        assert.ok(Math.abs(scoreOpt1 - 4.2) < 0.01);
        assert.ok(Math.abs(scoreOpt2 - 2.0) < 0.01);
    });

    it('should handle single stakeholder', () => {
        const s = { weight: 1.0, tier: 1 as const, utilities: { a: 0.7, b: 0.3 } };
        const mult = { 1: 5, 2: 3, 3: 1 };
        assert.equal(s.weight * s.utilities.a * mult[s.tier], 3.5);
    });

    it('should prioritize higher tier stakeholders', () => {
        const mult = { 1: 5, 2: 3, 3: 1 };
        const s1 = { weight: 0.5, tier: 1 as const, utility: 0.6 };
        const s2 = { weight: 0.9, tier: 3 as const, utility: 0.9 };
        const score1 = s1.weight * s1.utility * mult[s1.tier]; // 1.5
        const score2 = s2.weight * s2.utility * mult[s2.tier]; // 0.81
        assert.ok(score1 > score2);
    });

    it('should compute confidence from score ratios', () => {
        const s1 = 4.2, s2 = 2.0;
        const confidence = s1 / (s1 + s2);
        assert.ok(Math.abs(confidence - 0.677) < 0.01);
    });

    it('should rank options by score', () => {
        const scores = [{ option: 'c', score: 0.5 }, { option: 'a', score: 4.2 }, { option: 'b', score: 2.0 }];
        scores.sort((a, b) => b.score - a.score);
        assert.equal(scores[0].option, 'a');
        assert.equal(scores[1].option, 'b');
        assert.equal(scores[2].option, 'c');
    });
});
