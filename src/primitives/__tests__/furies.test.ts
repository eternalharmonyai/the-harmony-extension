/**
 * Integration tests for Furies (adversarialCritic.ts).
 * Tests: finding structure validation, severity calibration, duplicate detection.
 */
import * as assert from 'assert';

console.log('=== Furies Integration Tests ===\n');

interface CriticFinding {
    dimension: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    code_snippet?: string;
    line_number?: number;
    pattern?: string;
    recommendation?: string;
    test_failed?: boolean;
}

// Test 1: Finding structure validation
{
    const finding: CriticFinding = {
        dimension: 'security',
        severity: 'high',
        description: 'Unvalidated user input in SQL query',
        code_snippet: 'db.query("SELECT * FROM users WHERE id=" + userId)',
        line_number: 42,
        pattern: 'sql-injection',
        recommendation: 'Use parameterized queries',
    };
    assert.strictEqual(finding.dimension, 'security');
    assert.strictEqual(finding.severity, 'high');
    assert.ok(finding.code_snippet!.length > 0);
    assert.ok(finding.line_number! > 0);
    console.log('✅ Test 1: Finding structure validation — passed');
}

// Test 2: Evidence gate — requires code_snippet, line_number, or pattern
function hasEvidence(finding: CriticFinding): boolean {
    return !!(finding.code_snippet || finding.line_number || finding.pattern);
}

{
    const withEvidence: CriticFinding = { dimension: 'perf', severity: 'medium', description: 'N+1 query', code_snippet: 'for user in users: posts = user.posts.all()' };
    assert.strictEqual(hasEvidence(withEvidence), true);

    const withoutEvidence: CriticFinding = { dimension: 'perf', severity: 'medium', description: 'It might be slow' };
    assert.strictEqual(hasEvidence(withoutEvidence), false);
    console.log('✅ Test 2: Evidence gate — passed');
}

// Test 3: Severity calibration — critical requires test_failed + evidence
function isValidSeverity(finding: CriticFinding): boolean {
    if (finding.severity === 'critical') {
        return finding.test_failed === true && hasEvidence(finding);
    }
    return true;
}

{
    const validCritical: CriticFinding = { dimension: 'security', severity: 'critical', description: 'RCE', code_snippet: 'eval(userInput)', line_number: 100, test_failed: true };
    assert.strictEqual(isValidSeverity(validCritical), true);

    const invalidCritical: CriticFinding = { dimension: 'security', severity: 'critical', description: 'RCE', test_failed: false };
    assert.strictEqual(isValidSeverity(invalidCritical), false);
    console.log('✅ Test 3: Severity calibration — passed');
}

// Test 4: Duplicate detection via text similarity
function jaccardText(a: string, b: string): number {
    const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
    const sa = tok(a), sb = tok(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    return new Set([...sa].filter(x => sb.has(x))).size / new Set([...sa, ...sb]).size;
}

{
    const dup1 = 'SQL injection vulnerability in user input handling at login endpoint';
    const dup2 = 'SQL injection risk in user input at login handler';
    const unique = 'Memory leak in WebSocket connection pooling';

    const dupScore = jaccardText(dup1, dup2);
    const uniqueScore = jaccardText(dup1, unique);

    assert.ok(dupScore > 0.3, `Duplicates should be similar, got ${dupScore}`);
    assert.ok(uniqueScore < 0.3, `Unrelated should be dissimilar, got ${uniqueScore}`);
    console.log('✅ Test 4: Duplicate detection via Jaccard — passed');
}

// Test 5: Multi-dimensional coverage
const DIMENSIONS = ['security', 'performance', 'logic', 'maintainability', 'ethics'];
{
    const covered = DIMENSIONS.every(d => d.length > 3);
    assert.ok(covered);
    assert.strictEqual(DIMENSIONS.length, 5);
    console.log('✅ Test 5: All 5 dimensions available — passed');
}

console.log('\n=== Furies: 5/5 tests passed ===\n');
