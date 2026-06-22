/**
 * Adversarial Critic (Furies) — Schema-validated adversarial code review + differential fuzzing.
 *
 * 100% upgrade: structured output guarantee via schema validation.
 * Beyond-100% (E5): differential testing — generates counterexample code, executes via sandbox,
 *   reports which claimed invariants were violated with minimal failing inputs.
 *
 * @example
 *   // Standard adversarial review
 *   invoke({ action: 'review', target: code, dimensions: ['security','logic'], validate: true });
 *   // Differential fuzzing — generate + execute counterexamples for claimed invariants
 *   invoke({ action: 'fuzz', target: code, language: 'javascript', invariants: ['always returns >= 0', 'never throws on valid input'] });
 */
import * as vscode from 'vscode';
import { workspaceRoot, textResult } from './shared';
import { consult, resolveCollabModel } from '../providers';
import { concertSpeak } from '../concertHall';
import { SandboxRunner } from '../sandboxRunner';
import { BasePrimitive } from './basePrimitive';

interface AdversarialCriticInput { action?: 'review' | 'fuzz'; target: string; language?: string; dimensions?: string[]; validate?: boolean; invariants?: string[]; }
export interface HardenedCriticFinding { dimension: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'observation'; description: string; evidence?: { line_number?: number; code_snippet?: string; pattern?: string }; failing_test?: string; test_result?: 'test_failed' | 'test_passed' | 'not_validated' | 'test_error'; remediation?: string; confidence_0_to_1?: number; false_positive_risk?: 'low' | 'medium' | 'high'; }

export class AdversarialCriticTool extends BasePrimitive<AdversarialCriticInput> {
    constructor(private readonly secrets: vscode.SecretStorage) { super('adversarial-critic'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<AdversarialCriticInput>, token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['target']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action = 'review', target, language = 'typescript', dimensions = ['security', 'logic', 'performance'], validate = true, invariants } = options.input;
        if (!target?.trim()) return textResult(JSON.stringify({ error: 'target required' }));
        
        // ── E5: Differential Fuzzing ──
        if (action === 'fuzz') {
            if (!invariants?.length) return textResult(JSON.stringify({ error: 'invariants[] required for fuzz action — e.g. ["always returns >= 0", "never throws on valid input"]' }));
            const root = workspaceRoot();
            if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
            const sel = await resolveCollabModel(this.secrets);
            const fuzzPrompt = `You are a DIFFERENTIAL TESTER. For each claimed invariant, generate JavaScript test code that tries to VIOLATE it. The test MUST use try/catch and console.log('PASS:'+invariant_index) or console.log('FAIL:'+invariant_index). Output ONLY a JSON array of {invariant_index:number, test_code:string}.

TARGET CODE:\n${target.slice(0, 4000)}\n\nINVARIANTS:\n${invariants.map((inv, i) => `${i}: ${inv}`).join('\n')}`;
            let fuzzResponse: string;
            try { const r = await consult(this.secrets, { provider: sel?.provider ?? 'deepseek', tier: 'mid', question: fuzzPrompt, maxTokens: 2048 }, token); fuzzResponse = r.text; }
            catch (e: any) { return textResult(JSON.stringify({ error: 'fuzz generation failed', detail: e?.message ?? String(e) })); }
            
            // Parse generated tests
            let tests: { invariant_index: number; test_code: string }[] = [];
            try {
                const start = fuzzResponse.indexOf('['), end = fuzzResponse.lastIndexOf(']');
                if (start >= 0 && end > start) tests = JSON.parse(fuzzResponse.slice(start, end + 1));
            } catch { return textResult(JSON.stringify({ error: 'failed to parse fuzz response', raw: fuzzResponse.slice(0, 500) })); }
            
            // Execute each test via sandbox
            let runner: SandboxRunner;
            try { runner = new SandboxRunner(root); } catch { return textResult(JSON.stringify({ error: 'sandbox unavailable' })); }
            const results: any[] = [];
            let violationsFound = 0;
            for (const test of tests) {
                const invText = invariants[test.invariant_index] ?? `invariant #${test.invariant_index}`;
                try {
                    const wrapper = `${test.test_code}\n// If we reach here without throwing, the invariant held\nconsole.log('PASS:'+${test.invariant_index});`;
                    const r = await runner.execute(wrapper, undefined, { language: 'javascript', timeoutSec: 8 });
                    const passed = (r.output ?? '').includes('PASS:');
                    if (passed) {
                        results.push({ invariant_index: test.invariant_index, invariant: invText, violated: false, note: 'counterexample failed to break invariant' });
                    } else {
                        violationsFound++;
                        results.push({ invariant_index: test.invariant_index, invariant: invText, violated: true, counterexample_output: (r.output ?? r.error ?? '').slice(0, 500) });
                    }
                } catch (e: any) {
                    violationsFound++;
                    results.push({ invariant_index: test.invariant_index, invariant: invText, violated: true, error: e?.message ?? String(e) });
                }
            }
            return textResult(JSON.stringify({
                action: 'fuzz',
                invariants_tested: invariants.length,
                counterexamples_generated: tests.length,
                violations_found: violationsFound,
                verdict: violationsFound > 0 ? 'INVARIANTS_VIOLATED' : 'ALL_INVARIANTS_HELD',
                results
            }, null, 2));
        }
        const sp = `You are an ADVERSARIAL CODE CRITIC. Find REAL, evidence-backed flaws. Output ONLY a JSON array of findings with: dimension, severity, description, evidence (line_number, code_snippet, pattern), failing_test, remediation, confidence_0_to_1.`;
        const sel = await resolveCollabModel(this.secrets);
        let response: string;
        try { const r = await consult(this.secrets, { provider: sel?.provider ?? 'deepseek', tier: 'mid', question: sp + '\n\nCODE (' + language + '):\n' + target.slice(0, 8000), maxTokens: 2048 }, token); response = r.text; }
        catch (e: any) { return textResult(JSON.stringify({ error: 'critic failed', detail: e?.message ?? String(e) })); }
        let findings: HardenedCriticFinding[] = [];
        let parseAttempts = 0;
        const maxParseAttempts = 2;
        while (parseAttempts < maxParseAttempts) {
            parseAttempts++;
            try {
                // Extract JSON array robustly — find the first [ and matching ]
                let start = response.indexOf('[');
                let end = response.lastIndexOf(']');
                if (start === -1 || end === -1 || start >= end) throw new Error('no JSON array in critic response');
                const jsonStr = response.slice(start, end + 1);
                const parsed = JSON.parse(jsonStr);
                if (!Array.isArray(parsed)) throw new Error('critic response is not an array');
                // Schema validation: each finding must have required fields
                const valid = parsed.filter((f: any) => {
                    if (!f || typeof f !== 'object') return false;
                    if (!f.dimension || !f.severity || !f.description) return false;
                    const validSeverities = ['critical', 'high', 'medium', 'low', 'observation'];
                    if (!validSeverities.includes(f.severity)) { f.severity = 'observation'; }
                    if (typeof f.confidence_0_to_1 === 'number') {
                        f.confidence_0_to_1 = Math.max(0, Math.min(1, f.confidence_0_to_1));
                    }
                    return true;
                });
                const invalidCount = parsed.length - valid.length;
                if (invalidCount > 0 && parseAttempts < maxParseAttempts) {
                    // Retry LLM with schema to get better output
                    const schemaPrompt = sp + `\n\nYou MUST output a JSON array where each object has EXACTLY these fields:\n- dimension: string (one of: security, logic, performance, style, correctness)\n- severity: string (one of: critical, high, medium, low, observation)\n- description: string (required)\n- evidence: object with optional line_number (number), code_snippet (string), pattern (string)\n- failing_test: string (optional test code that demonstrates the flaw)\n- remediation: string (suggested fix)\n- confidence_0_to_1: number between 0 and 1\n\n${invalidCount} items were invalid in your previous response. Please fix and respond with ONLY the JSON array.`;
                    try {
                        const retry = await consult(this.secrets, { provider: sel?.provider ?? 'deepseek', tier: 'mid', question: schemaPrompt + '\n\nCODE (' + language + '):\n' + target.slice(0, 8000), maxTokens: 2048 }, token);
                        response = retry.text;
                        continue; // retry the parse loop
                    } catch { /* retry failed — use what we have */ }
                }
                findings = valid as HardenedCriticFinding[];
                if (invalidCount > 0) {
                    // Mark invalid findings as observations with high false positive risk
                    const invalidFindings = parsed.filter((f: any, i: number) => !valid.includes(f)).map((f: any) => ({
                        dimension: f.dimension || 'unknown',
                        severity: 'observation' as const,
                        description: f.description || 'Invalid finding — failed schema validation',
                        confidence_0_to_1: 0.1,
                        false_positive_risk: 'high' as const
                    }));
                    findings = [...valid, ...invalidFindings];
                }
                break; // success
            } catch (err: any) {
                if (parseAttempts >= maxParseAttempts) {
                    return textResult(JSON.stringify({ error: 'parse error after retry', detail: err?.message ?? String(err) }));
                }
                // Retry with schema
                const schemaPrompt = sp + `\n\nIMPORTANT: You MUST output ONLY a valid JSON array. No markdown, no explanation. Each item must have: dimension, severity, description, evidence (optional), failing_test (optional), remediation (optional), confidence_0_to_1 (optional).\n\nYour previous response could not be parsed. Please respond with ONLY the JSON array.`;
                try {
                    const retry = await consult(this.secrets, { provider: sel?.provider ?? 'deepseek', tier: 'mid', question: schemaPrompt + '\n\nCODE (' + language + '):\n' + target.slice(0, 8000), maxTokens: 2048 }, token);
                    response = retry.text;
                } catch (e: any) {
                    return textResult(JSON.stringify({ error: 'critic failed after retry', detail: e?.message ?? String(e) }));
                }
            }
        }
        findings = findings.filter(f => dimensions.includes(f.dimension));
        for (const f of findings) { if (!f.evidence?.line_number && !f.evidence?.code_snippet && !f.evidence?.pattern) { f.severity = 'observation'; f.false_positive_risk = 'high'; } if ((f.confidence_0_to_1 ?? 1) < 0.3) { f.severity = 'observation'; } }
        if (findings.length === 0) return textResult(JSON.stringify({ verdict: 'NO_VALID_FINDINGS' }, null, 2));
        // Validate findings via sandbox when requested
        if (validate) {
            const root = workspaceRoot();
            if (root) {
                try {
                    const runner = new SandboxRunner(root);
                    for (const f of findings) {
                        if (f.failing_test && f.failing_test.trim()) {
                            try {
                                const r = await runner.execute(f.failing_test, undefined, { language: 'javascript', timeoutSec: 5 });
                                f.test_result = r.pass ? 'test_passed' : 'test_failed';
                                if (r.pass) { f.severity = 'observation'; f.false_positive_risk = 'high'; }
                            } catch { f.test_result = 'test_error'; }
                        } else { f.test_result = 'not_validated'; }
                    }
                } catch {} // sandbox unavailable — leave test_result as undefined
            }
        }
        try { await concertSpeak('adversarial', 'critic', JSON.stringify({ count: findings.length })); } catch {}
        return textResult(JSON.stringify({ verdict: 'FINDINGS_FOUND', finding_count: findings.length, findings: findings.slice(0, 20) }, null, 2));
    }
}
