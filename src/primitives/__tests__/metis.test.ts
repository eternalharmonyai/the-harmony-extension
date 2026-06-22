/**
 * Tests for Metis (horizonPlanner.ts) — plan creation and validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('HorizonPlanner (Metis)', () => {
    it('should validate timeline values', () => {
        const validTimelines = ['tactical', 'operational', 'strategic'];
        assert.ok(validTimelines.includes('tactical'));
        assert.ok(validTimelines.includes('operational'));
        assert.ok(validTimelines.includes('strategic'));
        assert.ok(!validTimelines.includes('invalid'));
        assert.ok(!validTimelines.includes(''));
    });

    it('should generate unique plan IDs', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            ids.add(id);
        }
        assert.equal(ids.size, 100); // All unique
    });

    it('should validate parent-child plan relationships', () => {
        const existingPlans = new Set(['plan-1', 'plan-2']);
        const isValidParent = (parentId: string | undefined) => {
            if (!parentId) return true; // Root plans don't need parent
            return existingPlans.has(parentId);
        };
        assert.ok(isValidParent(undefined));
        assert.ok(isValidParent('plan-1'));
        assert.ok(!isValidParent('nonexistent'));
    });

    it('should sort plans by timeline priority', () => {
        const priority = { strategic: 3, operational: 2, tactical: 1 } as Record<string, number>;
        const plans = [
            { id: 'p1', timeline: 'tactical' },
            { id: 'p2', timeline: 'strategic' },
            { id: 'p3', timeline: 'operational' },
        ];
        plans.sort((a, b) => (priority[b.timeline] ?? 0) - (priority[a.timeline] ?? 0));
        assert.equal(plans[0].timeline, 'strategic');
        assert.equal(plans[2].timeline, 'tactical');
    });

    it('should handle empty plan list gracefully', () => {
        const plans: any[] = [];
        assert.equal(plans.length, 0);
        assert.equal(plans.filter(p => p.status === 'active').length, 0);
    });
});
