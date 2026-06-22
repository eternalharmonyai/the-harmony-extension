/**
 * Property Tester (Logos) — Generate and EXECUTE property-based tests via SandboxRunner.
 *
 * 100% upgrade: lightweight PBT harness injected into the sandbox.
 *   - Generates 100 random inputs (scalars, arrays, objects)
 *   - Shrinks failing inputs via binary search (numeric) or prefix truncation (arrays/strings)
 *   - Reports pass rate + minimal counterexample + shrink iterations
 *
 * @example
 *   // Validate a sort invariant with 100 random arrays:
 *   invoke({ action: 'validate', invariant: 'sort preserves length', 
 *            target_code: 'function sort(arr) { return arr.slice().sort((a,b)=>a-b); }',
 *            test_code: 'function property(arr) { const out = sort(arr); return out.length === arr.length; }' })
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir, appendJsonl, readJsonl } from '../swarmHarden';
import { consult } from '../providers';
import { SandboxRunner } from '../sandboxRunner';
import { BasePrimitive } from './basePrimitive';

interface PropertyTest { id: string; name: string; invariant: string; language: string; test_code: string; generator: string; timestamp: number; status: string; run_count?: number; pass_count?: number; shrunk_counterexample?: unknown; }
interface PropertyTesterInput { action: 'generate' | 'validate' | 'query' | 'stats'; name?: string; invariant?: string; language?: string; target_code?: string; test_code?: string; query_language?: string; limit?: number; run_count?: number; }

export class PropertyTesterTool extends BasePrimitive<PropertyTesterInput> {
    constructor(private readonly secrets?: vscode.SecretStorage) { super('property-tester'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<PropertyTesterInput>, token: vscode.CancellationToken) {
        this.requireFields(options.input as any, ['action']);
        const { action, name, invariant, language = 'typescript', target_code, test_code, query_language, limit = 20 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const dir = safeHarmonyDir(root, 'property-tests'); await ensureDir(dir);
        const fp = path.join(dir, 'tests.jsonl');
        switch (action) {
            case 'generate': {
                if (!invariant || !target_code) return textResult(JSON.stringify({ error: 'invariant and target_code required' }));
                if (!this.secrets) return textResult(JSON.stringify({ error: 'secrets required' }));
                try { const r = await consult(this.secrets, { provider: 'deepseek', tier: 'mid', question: 'Generate a property-based test for: ' + invariant + '\n\nCODE:\n' + target_code.slice(0, 4000) + '\n\nOutput ONLY test code.', maxTokens: 1024 }, token);
                    const test: PropertyTest = { id: uid(), name: name ?? 'prop_' + uid(), invariant, language, test_code: r.text, generator: 'llm', timestamp: Date.now(), status: 'generated' };
                    await appendJsonl(fp, test);
                    return textResult(JSON.stringify({ status: 'generated', id: test.id, invariant: invariant.slice(0, 200), test_code: test.test_code.slice(0, 500) }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'generation failed', detail: e.message })); }
            }
            case 'validate': {
                if (!test_code || !target_code) return textResult(JSON.stringify({ error: 'test_code and target_code required' }));
                const numRuns = options.input.run_count ?? 100;
                if (token.isCancellationRequested) return textResult(JSON.stringify({ error: 'cancelled', detail: 'PBT validation cancelled' }));

                // Build a lightweight PBT harness that runs INSIDE the sandbox.
                // It generates random inputs, runs the property N times, shrinks failures.
                const pbtHarness = buildPBTHarness(numRuns);
                const runnableCode = [
                    target_code,
                    test_code,
                    pbtHarness,
                    'runPBT(property, ' + numRuns + ');'
                ].join('\n\n');

                const runner = new SandboxRunner(root);
                const result = await runner.execute(runnableCode, undefined, {
                    language: language === 'python' ? 'python' : 'javascript',
                    timeoutSec: Math.max(15, Math.ceil(numRuns / 20)),  // scale timeout with run count
                    memoryLimitMB: 64,
                    allowFallback: true
                });

                // Parse PBT structured output from sandbox stdout
                let pbt: { pass: boolean; total_runs: number; passed: number; failed: number; errors: number; counterexample?: unknown; shrink_iterations?: number; } | null = null;
                let parseError: string | undefined;
                if (result.output) {
                    try {
                        const marker = '___PBT_RESULT___';
                        const idx = result.output.indexOf(marker);
                        if (idx !== -1) {
                            const jsonStart = result.output.indexOf('{', idx);
                            const jsonEnd = result.output.lastIndexOf('}');
                            if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                                pbt = JSON.parse(result.output.slice(jsonStart, jsonEnd + 1));
                            }
                        }
                    } catch (e: any) { parseError = e.message; }
                }

                if (!pbt) {
                    // Fallback: single-run result (no property function detected)
                    const pass = result.pass && !result.error;
                    return textResult(JSON.stringify({
                        status: pass ? 'passed' : 'failed',
                        pass,
                        output: result.output?.slice(0, 2000) || '',
                        error: result.error,
                        diagnostics: result.diagnostics,
                        tier: result.tier,
                        note: 'single-run mode (no property() function detected or harness failed)' + (parseError ? ' — parse: ' + parseError : '')
                    }, null, 2));
                }

                return textResult(JSON.stringify({
                    status: pbt.pass ? 'passed' : 'failed',
                    pass: pbt.pass,
                    total_runs: pbt.total_runs,
                    passed: pbt.passed,
                    failed: pbt.failed,
                    errors: pbt.errors,
                    counterexample: pbt.counterexample ?? null,
                    shrink_iterations: pbt.shrink_iterations ?? 0,
                    tier: result.tier
                }, null, 2));
            }
            case 'query': {
                let tests: PropertyTest[] = await readJsonl(fp); if (query_language) tests = tests.filter(t => t.language === query_language);
                tests.sort((a, b) => b.timestamp - a.timestamp);
                return textResult(JSON.stringify({ count: Math.min(tests.length, limit), tests: tests.slice(0, limit).map(t => ({ id: t.id, name: t.name, invariant: t.invariant.slice(0, 150) })) }, null, 2));
            }
            case 'stats': {
                try {
                    const tests: PropertyTest[] = await readJsonl(fp);
                    const byLanguage: Record<string, number> = {}; for (const t of tests) { byLanguage[t.language] = (byLanguage[t.language] || 0) + 1; }
                    const byStatus: Record<string, number> = {}; for (const t of tests) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; }
                    return textResult(JSON.stringify({ total: tests.length, by_language: byLanguage, by_status: byStatus, pass_rate: tests.length > 0 ? tests.filter(t => t.status === 'passed').length : 0 }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'stats failed', detail: e.message })); }
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}

// ══════════════════════════════════════════════════════════════════
// Lightweight PBT Harness (injected into sandbox code)
// ══════════════════════════════════════════════════════════════════

/** Build a self-contained JS PBT harness that runs inside the sandbox. */
function buildPBTHarness(numRuns: number): string {
    return `
// ── PBT Harness (injected by Logos) ──
var __PBT = { total: 0, passed: 0, failed: 0, errors: 0, failures: [] };

function randomScalar() {
    var t = Math.floor(Math.random() * 4);
    if (t === 0) return Math.floor(Math.random() * 200) - 100;       // int [-100,100)
    if (t === 1) return (Math.random() * 200 - 100).toFixed(2);      // float string
    if (t === 2) return Math.random() < 0.5 ? 'test_' + Math.floor(Math.random()*1000) : '';
    return Math.random() < 0.5;                                       // boolean
}

function randomArray(minLen, maxLen, elemGen) {
    var len = minLen + Math.floor(Math.random() * (maxLen - minLen + 1));
    var arr = [];
    for (var i = 0; i < len; i++) { arr.push(elemGen()); }
    return arr;
}

function randomObject(depth) {
    if (depth === undefined) depth = 0;
    if (depth > 2) return randomScalar();
    var obj = {};
    var keys = Math.floor(Math.random() * 5) + 1;
    for (var i = 0; i < keys; i++) {
        obj['k' + i] = Math.random() < 0.5 ? randomScalar() : randomArray(0, 5, randomScalar);
    }
    return obj;
}

function shrinkNumeric(val, propFn, ctx) {
    // Binary-search shrink toward zero
    var lo = val < 0 ? val : 0;
    var hi = val < 0 ? 0 : val;
    var best = val;
    for (var iter = 0; iter < 20; iter++) {
        var mid = (lo + hi) / 2;
        try {
            if (!propFn(mid, ctx)) { best = mid; hi = mid; }
            else { lo = mid; }
        } catch(e) { best = mid; hi = mid; }
        if (Math.abs(hi - lo) < 0.001) break;
    }
    return best;
}

function shrinkArray(arr, propFn, ctx) {
    // Try progressively shorter prefixes
    var best = arr;
    for (var len = arr.length - 1; len >= 0; len--) {
        var prefix = arr.slice(0, len);
        try {
            if (!propFn(prefix, ctx)) { best = prefix; }
            else { break; }
        } catch(e) { best = prefix; }
    }
    return best;
}

function shrink(counterexample, propFn, ctx) {
    var shrunk = counterexample;
    var iterations = 0;
    // Shrink numeric values
    if (typeof shrunk === 'number') {
        shrunk = shrinkNumeric(shrunk, propFn, ctx);
        iterations++;
    }
    // Shrink arrays
    if (Array.isArray(shrunk)) {
        shrunk = shrinkArray(shrunk, propFn, ctx);
        iterations++;
        // Also shrink individual elements
        for (var i = 0; i < shrunk.length; i++) {
            if (typeof shrunk[i] === 'number') {
                var orig = shrunk[i];
                shrunk[i] = shrinkNumeric(orig, propFn, ctx);
                iterations++;
                // Check if still fails with shrunk element
                try { if (propFn(shrunk, ctx)) { shrunk[i] = orig; } } catch(e) {}
            }
        }
    }
    return { counterexample: shrunk, iterations: iterations };
}

function runPBT(propFn, N) {
    var ctx = {};
    for (var i = 0; i < N; i++) {
        // Generate a random input (scalar, array, or object)
        var input;
        var roll = Math.random();
        if (roll < 0.4) {
            input = randomScalar();
        } else if (roll < 0.75) {
            input = randomArray(0, 20, randomScalar);
        } else {
            input = randomObject(0);
        }
        __PBT.total++;
        try {
            var ok = propFn(input, ctx);
            if (ok) { __PBT.passed++; }
            else { __PBT.failed++; __PBT.failures.push(input); }
        } catch(e) {
            __PBT.errors++;
            __PBT.failures.push({ input: input, error: String(e) });
        }
    }
    var result = {
        pass: __PBT.failed === 0 && __PBT.errors === 0,
        total_runs: __PBT.total,
        passed: __PBT.passed,
        failed: __PBT.failed,
        errors: __PBT.errors
    };
    if (__PBT.failures.length > 0) {
        var shrunk = shrink(__PBT.failures[0], propFn, ctx);
        result.counterexample = shrunk.counterexample;
        result.shrink_iterations = shrunk.iterations;
    }
    console.log('___PBT_RESULT___ ' + JSON.stringify(result));
}
`;
}
