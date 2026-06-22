/**
 * Tests for Metaphora (analogyEngine.ts) — structural validation only.
 * Full integration tests require LLM provider + workspace.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

// Test the safeJsonParse utility (imported inline since it's not exported)
const safeJsonParse = async (text: string, schema: string[]): Promise<any> => {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { parse_error: true };
    try {
        const parsed = JSON.parse(match[0]);
        const missing = schema.filter(k => !(k in parsed));
        return missing.length ? { ...parsed, parse_warning: `missing: ${missing.join(',')}` } : parsed;
    } catch { return { parse_error: true }; }
};

describe('AnalogyEngine (Metaphora)', () => {
    it('should parse valid JSON with required keys', async () => {
        const r = await safeJsonParse('{"mapping_table":[],"verification":[]}', ['mapping_table', 'verification']);
        assert.ok(Array.isArray(r.mapping_table));
        assert.ok(Array.isArray(r.verification));
    });

    it('should flag missing keys', async () => {
        const r = await safeJsonParse('{"mapping_table":[]}', ['mapping_table', 'verification']);
        assert.ok(r.parse_warning);
    });

    it('should handle non-JSON gracefully', async () => {
        const r = await safeJsonParse('not json at all', ['mapping_table']);
        assert.ok(r.parse_error);
    });

    it('should extract JSON from markdown wrapping', async () => {
        const r = await safeJsonParse('```json\n{"mapping_table":[1],"verification":[2]}\n```', ['mapping_table', 'verification']);
        assert.ok(Array.isArray(r.mapping_table));
    });

    it('should handle empty input', async () => {
        const r = await safeJsonParse('', ['key']);
        assert.ok(r.parse_error);
    });
});
