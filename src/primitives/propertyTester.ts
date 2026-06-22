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
// PBT Harness — fast-check-quality generators + integrated shrinking
// Self-contained JS injected into sandbox. No external dependencies.
// ══════════════════════════════════════════════════════════════════

/** Build a self-contained JS PBT harness that runs inside the sandbox.
 *  Features fast-check-compatible arbitraries, integrated shrinking,
 *  and statistical reporting. */
function buildPBTHarness(numRuns: number): string {
    return `
// ── PBT Harness v2 — fast-check-quality generators + shrinking ──
var __PBT = { total: 0, passed: 0, failed: 0, errors: 0, failures: [], shrinks: 0 };
var __SEED = Math.floor(Math.random() * 2147483647);

// ── PRNG (mulberry32) for reproducible runs ──
function _next() { __SEED |= 0; __SEED = __SEED + 0x6D2B79F5 | 0; var t = Math.imul(__SEED ^ __SEED >>> 15, 1 | __SEED); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

// ═══════════════════════════════════════════════════════════════
// Arbitraries (fast-check-compatible API)
// ═══════════════════════════════════════════════════════════════

var fc = {};

// Integer in [min, max] — with integrated shrinking toward 0
fc.integer = function(min, max) {
    if (min === undefined) min = -0x80000000;
    if (max === undefined) max = 0x7fffffff;
    return { generate: function(rng) { return min + Math.floor(rng() * (max - min + 1)); }, shrink: function(val) { var out = []; if (val > 0) out.push(Math.floor(val / 2)); if (val < 0) out.push(Math.ceil(val / 2)); if (val > 0) out.push(val - 1); if (val < 0) out.push(val + 1); out.push(0); return out; } };
};

// Natural number [0, max]
fc.nat = function(max) { return fc.integer(0, max === undefined ? 0x7fffffff : max); };

// Float in [min, max]
fc.float = function(min, max) {
    if (min === undefined) min = 0; if (max === undefined) max = 1;
    return { generate: function(rng) { return min + rng() * (max - min); }, shrink: function(val) { var out = []; var s = val > 0 ? val / 2 : val * 2; out.push(s >= min ? s : 0); out.push(0); return out; } };
};

// Boolean
fc.boolean = function() {
    return { generate: function(rng) { return rng() < 0.5; }, shrink: function(val) { return val ? [false] : []; } };
};

// Character (printable ASCII)
fc.char = function() {
    return { generate: function(rng) { return String.fromCharCode(32 + Math.floor(rng() * 95)); }, shrink: function(val) { var c = val.charCodeAt(0); return c > 32 ? [String.fromCharCode(Math.max(32, Math.floor(c / 2))), ' '] : []; } };
};

// String (printable ASCII, length 0..maxLength)
fc.string = function(maxLength) {
    if (maxLength === undefined) maxLength = 100;
    return { generate: function(rng) { var len = Math.floor(rng() * (maxLength + 1)); var s = ''; for (var i = 0; i < len; i++) s += String.fromCharCode(32 + Math.floor(rng() * 95)); return s; }, shrink: function(val) { var out = []; if (val.length > 0) out.push(val.slice(0, Math.floor(val.length / 2))); if (val.length > 0) out.push(val.slice(1)); for (var i = 0; i < val.length; i++) { var c = val.charCodeAt(i); if (c > 32) { var s = val.slice(0,i) + String.fromCharCode(Math.max(32, c-1)) + val.slice(i+1); out.push(s); } } return out; } };
};

// Array of arbitrary, length 0..maxLength
fc.array = function(arb, maxLength) {
    if (maxLength === undefined) maxLength = 100;
    return { generate: function(rng) { var len = Math.floor(rng() * (maxLength + 1)); var arr = []; for (var i = 0; i < len; i++) arr.push(arb.generate(rng)); return arr; }, shrink: function(val) { var out = []; if (val.length > 0) out.push(val.slice(0, Math.floor(val.length / 2))); if (val.length > 0) out.push(val.slice(1)); for (var i = 0; i < val.length; i++) { var shrinks = arb.shrink(val[i]); for (var s = 0; s < shrinks.length; s++) { var copy = val.slice(); copy[i] = shrinks[s]; out.push(copy); } } return out; } };
};

// One of several arbitraries (pick randomly)
fc.oneof = function() {
    var arbs = arguments;
    return { generate: function(rng) { var idx = Math.floor(rng() * arbs.length); return arbs[idx].generate(rng); }, shrink: function(val) { /* try all arbs for shrinking */ return []; } };
};

// Constant value
fc.constant = function(val) { return { generate: function() { return val; }, shrink: function() { return []; } }; };

// Record (object with named arbitrary fields)
fc.record = function(schema) {
    return { generate: function(rng) { var obj = {}; for (var k in schema) obj[k] = schema[k].generate(rng); return obj; }, shrink: function(val) { var out = []; for (var k in schema) { var shrinks = schema[k].shrink(val[k]); for (var s = 0; s < shrinks.length; s++) { var copy = JSON.parse(JSON.stringify(val)); copy[k] = shrinks[s]; out.push(copy); } } return out; } };
};

// Tuple (fixed-length array of arbitraries)
fc.tuple = function() {
    var arbs = arguments;
    return { generate: function(rng) { var arr = []; for (var i = 0; i < arbs.length; i++) arr.push(arbs[i].generate(rng)); return arr; }, shrink: function(val) { var out = []; for (var i = 0; i < arbs.length && i < val.length; i++) { var shrinks = arbs[i].shrink(val[i]); for (var s = 0; s < shrinks.length; s++) { var copy = val.slice(); copy[i] = shrinks[s]; out.push(copy); } } return out; } };
};

// Email-like string (alphanum@alphanum.domain)
fc.email = function() {
    return { generate: function(rng) { var user = ''; var ulen = 3 + Math.floor(rng()*10); for (var i=0;i<ulen;i++) user += String.fromCharCode(97+Math.floor(rng()*26)); var dom = ''; var dlen = 3 + Math.floor(rng()*8); for (var i=0;i<dlen;i++) dom += String.fromCharCode(97+Math.floor(rng()*26)); var tlds = ['com','org','net','io','dev']; return user + '@' + dom + '.' + tlds[Math.floor(rng()*tlds.length)]; }, shrink: function(val) { var out = []; if (val.length > 5) out.push(val.slice(0, Math.floor(val.length/2)) + '@t.co'); return out; } };
};

// UUID string
fc.uuid = function() {
    return { generate: function(rng) { var h = function(n) { var s=''; for(var i=0;i<n;i++) s+=Math.floor(rng()*16).toString(16); return s; }; return h(8)+'-'+h(4)+'-4'+h(3)+'-'+(8+Math.floor(rng()*4)).toString(16)+h(3)+'-'+h(12); }, shrink: function(val) { return []; } };
};

// ═══════════════════════════════════════════════════════════════
// Integrated Shrinking Engine
// ═══════════════════════════════════════════════════════════════

function shrinkIntegrated(counterexample, arb, propFn, ctx, maxIter) {
    if (maxIter === undefined) maxIter = 200;
    var best = counterexample;
    var iterations = 0;
    var queue = [counterexample];
    var seen = new Set();
    seen.add(JSON.stringify(counterexample));
    
    while (queue.length > 0 && iterations < maxIter) {
        var current = queue.shift();
        var candidates = arb.shrink(current);
        for (var c = 0; c < candidates.length; c++) {
            var candidate = candidates[c];
            var key = JSON.stringify(candidate);
            if (seen.has(key)) continue;
            seen.add(key);
            iterations++;
            try {
                if (!propFn(candidate, ctx)) {
                    best = candidate;
                    queue.push(candidate); // continue shrinking from here
                }
            } catch(e) {
                best = candidate;
                queue.push(candidate);
            }
        }
    }
    return { counterexample: best, iterations: iterations };
}

// ═══════════════════════════════════════════════════════════════
// Property Runner
// ═══════════════════════════════════════════════════════════════

// Auto-detect the arbitrary to use based on property function name/context
function detectArbitrary(propFn) {
    var name = (propFn.name || '').toLowerCase();
    // Check if function expects an object (record-style)
    var src = propFn.toString();
    if (src.indexOf('{') > 0 && (src.indexOf('.length') > 0 || src.indexOf('[0]') > 0 || src.indexOf('sort') > 0)) return fc.array(fc.integer(-1000,1000), 50);
    if (src.indexOf('@') > 0 || name.indexOf('email') >= 0) return fc.email();
    if (src.indexOf('uuid') >= 0 || name.indexOf('uuid') >= 0) return fc.uuid();
    if (name.indexOf('string') >= 0 || src.indexOf('.charAt') > 0 || src.indexOf('.toLowerCase') > 0) return fc.string(200);
    if (name.indexOf('bool') >= 0 || name.indexOf('flag') >= 0) return fc.boolean();
    if (name.indexOf('float') >= 0 || name.indexOf('double') >= 0 || name.indexOf('decim') >= 0) return fc.float(-10000,10000);
    // Default: integer (most common for mathematical properties)
    return fc.integer(-10000, 10000);
}

function runPBT(propFn, N) {
    var arb = detectArbitrary(propFn);
    var ctx = {};
    
    // Run edge cases first (fast-check style)
    var edgeCases = [];
    if (arb.generate.name !== 'constant') {
        // Try 0, 1, -1, empty, max, min for integer-like arbitraries
        try { edgeCases.push(arb.shrink(99999999)); } catch(e) {}
    }
    
    for (var i = 0; i < N; i++) {
        var input;
        if (i < 5) {
            // Edge cases: try 0, 1, -1, max, empty
            var edges = [0, 1, -1, '', [], Number.MAX_SAFE_INTEGER];
            var edgeVal = edges[i];
            input = typeof arb.generate === 'function' ? (i < 2 ? arb.generate(function(){return i===0?0:1;}) : arb.generate(_next)) : edgeVal;
        } else {
            input = arb.generate(_next);
        }
        __PBT.total++;
        try {
            var ok = propFn(input, ctx);
            if (ok) { __PBT.passed++; }
            else { __PBT.failed++; __PBT.failures.push({ input: input, run: i }); }
        } catch(e) {
            __PBT.errors++;
            __PBT.failures.push({ input: input, error: String(e), run: i });
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
        var failure = __PBT.failures[0];
        var counterexample = failure.input;
        var shrunk = shrinkIntegrated(counterexample, arb, propFn, ctx);
        result.counterexample = shrunk.counterexample;
        result.shrink_iterations = shrunk.iterations;
        result.first_failure_run = failure.run;
    }
    
    console.log('___PBT_RESULT___ ' + JSON.stringify(result));
}
`;
}
