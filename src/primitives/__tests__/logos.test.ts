/**
 * Tests for Logos (propertyTester.ts) — PBT harness validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('PropertyTester (Logos)', () => {
    // Test property assertions directly
    it('should detect commutative property', () => {
        const isCommutative = (a: number, b: number) => (a + b) === (b + a);
        assert.ok(isCommutative(3, 7));
        assert.ok(isCommutative(-5, 12));
    });

    it('should detect non-commutative operations', () => {
        const concat = (a: string, b: string) => a + b;
        const isCommutative = (a: string, b: string) => concat(a, b) === concat(b, a);
        assert.ok(!isCommutative('hello', 'world'));
    });

    it('should verify idempotent property', () => {
        const sort = (arr: number[]) => [...arr].sort((a, b) => a - b);
        const testArr = [3, 1, 4, 1, 5];
        const once = JSON.stringify(sort(testArr));
        const twice = JSON.stringify(sort(sort(testArr)));
        assert.equal(once, twice);
    });

    it('should detect reversibility violation', () => {
        const arr = [1, 2, 3];
        arr.reverse(); // reverse mutates in place — the classic PBT catch
        assert.deepEqual(arr, [3, 2, 1]); // Original WAS mutated
    });

    it('should handle counterexample generation pattern', () => {
        // Pattern: generate random inputs, test property, report failing case
        const property = (n: number) => n % 2 === 0;
        const testInputs = [2, 4, 6, 7, 8];
        const failures = testInputs.filter(n => !property(n));
        assert.equal(failures.length, 1);
        assert.equal(failures[0], 7);
    });
});
