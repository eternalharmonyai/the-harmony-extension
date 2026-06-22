/** Analogy Engine (Metaphora) — Cross-domain analogical transfer with persistence
 *
 * @example
 *   invoke({ action: 'map', source_domain: 'biology.evolution', target_domain: 'software.architecture', concept: 'natural selection' });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir, appendJsonl, readJsonl } from '../swarmHarden';
import { consult } from '../providers';
import { BasePrimitive } from './basePrimitive';

interface AnalogyRecord { id: string; action: string; source_domain: string; target_domain: string; result: any; timestamp: number; }
interface AnalogyEngineInput { action: 'map' | 'verify' | 'transfer' | 'query' | 'transfer_cross_domain'; source_domain?: string; target_domain?: string; source_problem?: string; mapping_hint?: string; analogy_json?: string; verification?: Array<{ hypothesis: string; status?: string }>; insight?: string; query_action?: string; limit?: number; }

/** Schema-validated JSON parse with retry. Falls back through: direct parse → regex → raw text. */
async function safeJsonParse(llmText: string, expectedSchema: string[], retryProvider?: (attempt: number) => Promise<string>): Promise<any> {
    const extractJson = (text: string): string | null => {
        // Try direct parse first
        try { JSON.parse(text); return text; } catch {}
        // Regex extraction
        const match = text.match(/\{[\s\S]*\}/);
        return match ? match[0] : null;
    };
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        const jsonStr = extractJson(llmText);
        if (!jsonStr) {
            if (attempt < 3 && retryProvider) { llmText = await retryProvider(attempt); continue; }
            return { raw: llmText.slice(0, 1000), parse_error: true, reason: 'no JSON found' };
        }
        try {
            const parsed = JSON.parse(jsonStr);
            // Schema validation: check that expected keys exist
            const missing = expectedSchema.filter(k => !(k in parsed));
            if (missing.length > 0) {
                if (attempt < 3 && retryProvider) { llmText = await retryProvider(attempt); continue; }
                return { ...parsed, parse_warning: `missing keys: ${missing.join(', ')}` };
            }
            return parsed;
        } catch {
            if (attempt < 3 && retryProvider) { llmText = await retryProvider(attempt); continue; }
            return { raw: llmText.slice(0, 1000), parse_error: true, reason: 'JSON parse failed' };
        }
    }
    return { raw: llmText.slice(0, 1000), parse_error: true, reason: 'max retries exceeded' };
}

export class AnalogyEngineTool extends BasePrimitive<AnalogyEngineInput> {
    constructor(private readonly secrets: vscode.SecretStorage) { super('analogy-engine'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<AnalogyEngineInput>, token: vscode.CancellationToken) {
        this.requireFields(options.input as any, ['action']);
        const { action, source_domain, target_domain, source_problem, mapping_hint, analogy_json, verification, insight, query_action, limit = 20 } = options.input;
        const root = workspaceRoot();
        const dir = root ? safeHarmonyDir(root, 'analogy-engine') : null;
        const fp = dir ? path.join(dir, 'analogies.jsonl') : null;
        if (dir) await ensureDir(dir);
        const persist = async (rec: Omit<AnalogyRecord, 'id' | 'timestamp'>) => {
            if (!fp) return;
            await appendJsonl(fp, { id: uid(), timestamp: Date.now(), ...rec });
        };
        switch (action) {
            case 'map': {
                if (!source_domain || !target_domain) return textResult(JSON.stringify({ error: 'source_domain and target_domain required' }));
                try { const r = await consult(this.secrets, { provider: 'deepseek', tier: 'mid', question: `Map this problem from ${source_domain} to ${target_domain}. ${mapping_hint ? 'Hint: ' + mapping_hint : ''}\n\nPROBLEM:\n${source_problem ?? ''}\n\nOutput ONLY a valid JSON object (no markdown, no explanation) with: mapping_table (array of {source_concept, target_concept, rationale}), transferable_insights (string[]), verification (array of {hypothesis, status: "holds"|"partial"|"breaks"})`, maxTokens: 2048 }, token);
                    const parsed = await safeJsonParse(r.text, ['mapping_table', 'verification'], async (attempt) => {
                        const retry = await consult(this.secrets, { provider: 'deepseek', tier: 'light', question: `Your response was not valid JSON. Retry (attempt ${attempt}/3). Output ONLY the JSON object.`, maxTokens: 1024 }, token);
                        return retry.text;
                    });
                    await persist({ action: 'map', source_domain, target_domain, result: parsed });
                    return textResult(JSON.stringify(parsed, null, 2).slice(0, 8000));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'analogy mapping failed', detail: e.message })); }
            }
            case 'verify': {
                if (!analogy_json) return textResult(JSON.stringify({ error: 'analogy_json required' }));
                try { const r = await consult(this.secrets, { provider: 'deepseek', tier: 'light', question: 'Verify this analogy. For each verification hypothesis, set status to "holds", "partial", or "breaks". Output ONLY valid JSON:\n' + analogy_json.slice(0, 4000), maxTokens: 1024 }, token);
                    const parsed = await safeJsonParse(r.text, ['verification']);
                    await persist({ action: 'verify', source_domain: 'from_json', target_domain: 'from_json', result: parsed });
                    return textResult(JSON.stringify(parsed, null, 2).slice(0, 4000));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'verification failed', detail: e.message })); }
            }
            case 'transfer': {
                if (!insight) return textResult(JSON.stringify({ error: 'insight required' }));
                try { const r = await consult(this.secrets, { provider: 'deepseek', tier: 'mid', question: 'Transfer this insight to practical guidance:\n' + insight.slice(0, 2000), maxTokens: 1024 }, token);
                    const result = { transferred_insight: r.text.slice(0, 3000) };
                    await persist({ action: 'transfer', source_domain: 'insight', target_domain: 'guidance', result });
                    return textResult(JSON.stringify(result, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'transfer failed', detail: e.message })); }
            }
            case 'query': {
                if (!fp) return textResult(JSON.stringify({ error: 'no workspace' }));
                try {
                    let records: AnalogyRecord[] = await readJsonl(fp);
                    if (query_action) records = records.filter(r => r.action === query_action);
                    records.sort((a, b) => b.timestamp - a.timestamp);
                    return textResult(JSON.stringify({ count: Math.min(records.length, limit), total: records.length, analogies: records.slice(0, limit).map(r => ({ id: r.id, action: r.action, source: r.source_domain, target: r.target_domain, timestamp: r.timestamp })) }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'query failed', detail: e.message })); }
            }
            case 'transfer_cross_domain': {
                // ── E3: Cross-domain transfer learning ──
                if (!fp) return textResult(JSON.stringify({ error: 'no workspace' }));
                if (!source_domain || !target_domain) return textResult(JSON.stringify({ error: 'source_domain and target_domain required for cross-domain transfer' }));
                try {
                    const records: AnalogyRecord[] = await readJsonl(fp);
                    // Find analogies with same source domain pattern
                    const sourceAnalogies = records.filter(r => r.source_domain === source_domain || r.target_domain === source_domain);
                    if (sourceAnalogies.length === 0) {
                        return textResult(JSON.stringify({ action: 'transfer_cross_domain', source: source_domain, target: target_domain, 
                            transferred_mappings: [], confidence: 0, note: `No prior analogies from ${source_domain}. Use 'map' to create one first.` }, null, 2));
                    }
                    // Extract structural patterns from source analogies
                    const patterns: { source_entities: string[]; target_entities: string[]; relations: string[]; score: number; example_id: string }[] = [];
                    for (const rec of sourceAnalogies.slice(0, 5)) {
                        const mapping = rec.result?.mapping_table;
                        if (Array.isArray(mapping)) {
                            const srcEnts = mapping.map((m: any) => m.source_concept).filter(Boolean);
                            const tgtEnts = mapping.map((m: any) => m.target_concept).filter(Boolean);
                            const rels = mapping.map((m: any) => m.rationale).filter(Boolean);
                            patterns.push({ source_entities: srcEnts, target_entities: tgtEnts, relations: rels, score: mapping.length, example_id: rec.id });
                        }
                    }
                    // Structural similarity: longest pattern scored highest
                    patterns.sort((a, b) => b.score - a.score);
                    const best = patterns[0];
                    // Attempt to transfer: LLM adapts the pattern to the new domain
                    let llmResult: any = { transferred_mappings: [] };
                    try {
                        const r = await consult(this.secrets, { provider: 'deepseek', tier: 'mid',
                            question: `Cross-domain transfer. Adapt this analogy pattern from ${source_domain} to ${target_domain}.\n\nSOURCE PATTERN (from ${source_domain}):\n${JSON.stringify(best, null, 2)}\n\n${source_problem ? 'SOURCE PROBLEM:\n' + source_problem.slice(0, 2000) : ''}\n\nGenerate a mapping table transferring the structural pattern to ${target_domain}. Output ONLY JSON: {mapping_table: [{source_concept, target_concept, rationale}]}`,
                            maxTokens: 1024 }, token);
                        const parsed = await safeJsonParse(r.text, ['mapping_table']);
                        llmResult = parsed;
                    } catch { 
                        // Structural fallback: adapt source pattern directly without LLM
                        llmResult = {
                            mapping_table: best.source_entities.map((src: string, i: number) => ({
                                source_concept: src,
                                target_concept: best.target_entities[i] ?? `[adapt to ${target_domain}]`,
                                rationale: best.relations[i] ?? 'structural transfer (no LLM)',
                                fallback: true
                            })),
                            note: 'LLM unavailable — structural pattern applied directly'
                        };
                    }
                    const confidence = best.score > 0 ? Math.min(1, best.score / 10) : 0.3;
                    await persist({ action: 'transfer_cross_domain', source_domain, target_domain, result: { patterns, transferred: llmResult } });
                    return textResult(JSON.stringify({
                        action: 'transfer_cross_domain',
                        source: source_domain, target: target_domain,
                        prior_analogies: sourceAnalogies.length,
                        best_pattern: { entities: best.source_entities.length + best.target_entities.length, relations: best.relations.length },
                        transferred_mappings: llmResult?.mapping_table ?? [],
                        confidence: Math.round(confidence * 1000) / 1000
                    }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'cross-domain transfer failed', detail: e.message })); }
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
