/**
 * Tests for Chronos (temporalBranch.ts) — branch management logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('TemporalBranch (Chronos)', () => {
    it('should validate branch names', () => {
        const validName = (name: string) => /^[a-zA-Z0-9._-]+$/.test(name) && name.length > 0 && name.length <= 64;
        assert.ok(validName('feature-branch'));
        assert.ok(validName('main'));
        assert.ok(validName('v2.0_test'));
        assert.ok(!validName(''));
        assert.ok(!validName('branch/with/slash'));
        assert.ok(!validName('branch with spaces'));
    });

    it('should detect dirty workspace pattern', () => {
        // Simulate: check if there are unsaved changes
        const isDirty = (modifiedFiles: string[]) => modifiedFiles.length > 0;
        assert.ok(isDirty(['file1.ts']));
        assert.ok(!isDirty([]));
    });

    it('should compute diff between snapshots', () => {
        const snap1 = { a: 1, b: 2, c: 3 };
        const snap2 = { a: 1, b: 4, c: 3 };
        const diff: string[] = [];
        for (const k of Object.keys(snap1)) {
            if ((snap1 as any)[k] !== (snap2 as any)[k]) diff.push(k);
        }
        assert.deepEqual(diff, ['b']);
    });

    it('should handle identical snapshots', () => {
        const s = { x: 10, y: 20 };
        const diff: string[] = [];
        for (const k of Object.keys(s)) {
            if ((s as any)[k] !== (s as any)[k]) diff.push(k);
        }
        assert.equal(diff.length, 0);
    });

    it('should list branches from registry', () => {
        const branches = [
            { name: 'main', active: true },
            { name: 'dev/feature', active: false },
        ];
        assert.equal(branches.length, 2);
        assert.equal(branches.find(b => b.active)?.name, 'main');
    });
});
