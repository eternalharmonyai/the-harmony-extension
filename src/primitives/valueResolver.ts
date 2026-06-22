/** Value Resolver (Ethos) — Principle-based tradeoff resolution with conductor escalation
 *
 * Beyond-100% (E4): Multi-stakeholder resolution — weighted preferences with priority tiers,
 *   aggregated into ranked recommendations for complex multi-party decisions.
 *
 * @example
 *   invoke({ action: 'define_hierarchy', principles: [{name:'safety',priority:1},{name:'speed',priority:3}] });
 *   invoke({ action: 'resolve_multi', stakeholders: [{id:'u1',weight:0.8,tier:1,utilities:{opt1:0.9,opt2:0.2}}], options: ['opt1','opt2'] });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir, appendJsonl, readJsonl, readJson } from '../swarmHarden';
import { concertSpeak } from '../concertHall';
import { structuredLog } from '../storageUtils';
import { consult } from '../providers';
import { BasePrimitive } from './basePrimitive';

interface VHier { principles: { name: string; priority: number; description: string }[]; }
interface VTen { id: string; option_a: string; option_b: string; principle_a: string; principle_b: string; resolution?: string; justification?: string; timestamp: number; status: string; }
interface VResolverInput { action: 'define_hierarchy' | 'resolve_tension' | 'query' | 'stats' | 'resolve_multi'; principles?: { name: string; priority: number; description: string }[]; tension?: { option_a: string; option_b: string; principle_a: string; principle_b: string }; max_llm_attempts?: number; stakeholders?: { id: string; weight: number; tier: 1|2|3; utilities: Record<string, number> }[]; options?: string[]; }

export class ValueResolverTool extends BasePrimitive<VResolverInput> {
    constructor(private readonly secrets?: vscode.SecretStorage) { super('value-resolver'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<VResolverInput>, _token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action, principles, tension } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const dir = safeHarmonyDir(root, 'value-resolver'); await ensureDir(dir);
        const hp = path.join(dir, 'hierarchy.json'), tp = path.join(dir, 'tensions.jsonl');
        const readH = async (): Promise<VHier> => { return (await readJson(hp)) ?? { principles: [] }; };
        const readT = async (): Promise<VTen[]> => { return await readJsonl(tp); };
        switch (action) {
            case 'define_hierarchy': {
                if (!principles?.length) return textResult(JSON.stringify({ error: 'principles required' }));
                // Atomic write: write to temp file, then rename (crash-safe)
                const tmp = hp + '.tmp.' + crypto.randomBytes(8).toString('hex');
                try {
                    await fs.writeFile(tmp, JSON.stringify({ principles }, null, 2), 'utf8');
                    await fs.rename(tmp, hp); // rename is atomic on same volume
                } catch { try { await fs.unlink(tmp); } catch {} throw new Error('atomic write failed'); }
                return textResult(JSON.stringify({ status: 'defined', hierarchy: principles.sort((a, b) => a.priority - b.priority).map(p => 'P' + p.priority + '. ' + p.name + ': ' + p.description) }, null, 2));
            }
            case 'resolve_tension': {
                if (!tension) return textResult(JSON.stringify({ error: 'tension required' }));
                try {
                    const h = await readH(); if (h.principles.length === 0) return textResult(JSON.stringify({ error: 'no hierarchy defined' }));
                    const pa = h.principles.find(p => p.name === tension.principle_a), pb = h.principles.find(p => p.name === tension.principle_b);
                    if (!pa || !pb) return textResult(JSON.stringify({ error: 'principle not found' }));
                    let winner: string, wp: string, just: string, status = 'resolved';
                    if (pa.priority < pb.priority) {
                        winner = tension.option_a; wp = tension.principle_a;
                        just = `"${winner}" because Principle "${wp}" (priority ${pa.priority}) outranks "${tension.principle_b}" (priority ${pb.priority})`;
                    } else if (pb.priority < pa.priority) {
                        winner = tension.option_b; wp = tension.principle_b;
                        just = `"${winner}" because Principle "${wp}" (priority ${pb.priority}) outranks "${tension.principle_a}" (priority ${pa.priority})`;
                    } else {
                        // Equal priority — collaborative escalation pipeline
                        const ts = await readT();
                        const cached = ts.filter(t => t.principle_a === tension.principle_a && t.principle_b === tension.principle_b && t.status === 'resolved').pop();
                        if (cached && cached.resolution) {
                            winner = cached.resolution; wp = 'precedent';
                            just = `Cached precedent: "${winner}" (resolved ${new Date(cached.timestamp).toISOString()})`;
                        } else if (this.secrets) {
                            try {
                                const maxAttempts = options.input.max_llm_attempts ?? 1;
                                const r = await consult(this.secrets, { provider: 'deepseek', tier: 'mid',
                                    question: `Resolve this value tension with EQUAL priority principles. Do NOT compromise — find the solution that satisfies BOTH principles at 100%.\n\nPrinciple A: "${tension.principle_a}" → Option: ${tension.option_a}\nPrinciple B: "${tension.principle_b}" → Option: ${tension.option_b}\n\nOutput JSON: {winner: "option_a"|"option_b"|"synthesis", justification: string, satisfies_both: boolean}`,
                                    maxTokens: 512 }, _token);
                                const parsed = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
                                if (parsed.winner === 'synthesis' || parsed.satisfies_both) {
                                    winner = parsed.winner === 'option_a' ? tension.option_a : parsed.winner === 'option_b' ? tension.option_b : `SYNTHESIS: ${parsed.justification?.slice(0, 200) ?? 'mutual resolution'}`;
                                    wp = 'synthesis'; just = parsed.justification ?? 'LLM-reasoned resolution satisfying both principles';
                                } else {
                                    winner = parsed.winner === 'option_a' ? tension.option_a : tension.option_b;
                                    wp = parsed.winner === 'option_a' ? tension.principle_a : tension.principle_b;
                                    just = parsed.justification ?? 'LLM-reasoned: insufficient for synthesis';
                                }
                            } catch {
                                status = 'escalated_to_conductor';
                                try { await concertSpeak('value-resolver', 'ethos', `ESCALATED: Tie between "${tension.principle_a}" and "${tension.principle_b}" — equal priority ${pa.priority}. Options: ${tension.option_a} vs ${tension.option_b}. Conductor review needed.`); } catch {}
                                return textResult(JSON.stringify({ status: 'escalated_to_conductor', principle_a: tension.principle_a, principle_b: tension.principle_b, priority: pa.priority, option_a: tension.option_a, option_b: tension.option_b, message: 'Equal priority — escalated to Conductor for collaborative resolution. No arbitrary default was chosen.' }, null, 2));
                            }
                        } else {
                            status = 'escalated_to_conductor';
                            try { await concertSpeak('value-resolver', 'ethos', `ESCALATED: Tie between "${tension.principle_a}" and "${tension.principle_b}" — equal priority ${pa.priority}.`); } catch {}
                            return textResult(JSON.stringify({ status: 'escalated_to_conductor', principle_a: tension.principle_a, principle_b: tension.principle_b, priority: pa.priority, option_a: tension.option_a, option_b: tension.option_b, message: 'Equal priority, no secrets for LLM — escalated to Conductor.' }, null, 2));
                        }
                    }
                    const t: VTen = { id: uid(), option_a: tension.option_a, option_b: tension.option_b, principle_a: tension.principle_a, principle_b: tension.principle_b, resolution: winner, justification: just, timestamp: Date.now(), status };
                    await appendJsonl(tp, t);
                    try { await concertSpeak('value-resolver', 'ethos', 'Resolved: ' + tension.option_a + ' vs ' + tension.option_b + ' -> ' + winner); } catch {}
                    structuredLog('value-resolver', 'info', 'tension resolved', { winner, principle: wp, status });
                    return textResult(JSON.stringify({ status, winner, winning_principle: wp, justification: just }, null, 2));
                } catch (e: any) {
                    structuredLog('value-resolver', 'error', 'degraded fallback', { error: e.message });
                    const ts = await readT(); const cached = ts.filter(t => t.principle_a === tension.principle_a && t.principle_b === tension.principle_b).pop();
                    if (cached) return textResult(JSON.stringify({ status: 'degraded', cached_resolution: cached.resolution, justification: cached.justification + ' (from cache)' }, null, 2));
                    return textResult(JSON.stringify({ status: 'unresolved', error: 'No cached fallback' }, null, 2));
                }
            }
            case 'query': {
                try {
                    const ts = await readT();
                    ts.sort((a, b) => b.timestamp - a.timestamp);
                    return textResult(JSON.stringify({ count: ts.length, tensions: ts.slice(0, 20).map(t => ({ id: t.id, option_a: t.option_a, option_b: t.option_b, resolution: t.resolution?.slice(0, 100), status: t.status, timestamp: new Date(t.timestamp).toISOString() })) }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'query failed', detail: e.message })); }
            }
            case 'stats': {
                try {
                    const ts = await readT();
                    const byStatus: Record<string, number> = {}; for (const t of ts) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; }
                    let hier: VHier | null = null;
                    try { hier = await readJson(hp); } catch {}
                    return textResult(JSON.stringify({ total_tensions: ts.length, by_status: byStatus, principles_defined: hier?.principles?.length ?? 0, resolution_rate: ts.length > 0 ? Math.round((ts.filter(t => t.status === 'resolved').length / ts.length) * 100) : 0 }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'stats failed', detail: e.message })); }
            }
            case 'resolve_multi': {
                // ── E4: Multi-stakeholder value resolution ──
                if (!options.input.stakeholders?.length || !options.input.options?.length) {
                    return textResult(JSON.stringify({ error: 'stakeholders[] and options[] required for resolve_multi' }));
                }
                const { stakeholders, options: optionIds } = options.input;
                const tierMultipliers: Record<number, number> = { 1: 5, 2: 3, 3: 1 };
                const scores: { option: string; totalScore: number; contributions: { stakeholder: string; score: number }[] }[] = [];
                for (const optId of optionIds) {
                    let total = 0;
                    const contributions: { stakeholder: string; score: number }[] = [];
                    for (const s of stakeholders) {
                        const utility = s.utilities[optId] ?? 0;
                        const score = s.weight * utility * (tierMultipliers[s.tier] ?? 1);
                        total += score;
                        contributions.push({ stakeholder: s.id, score: Math.round(score * 1000) / 1000 });
                    }
                    scores.push({ option: optId, totalScore: Math.round(total * 1000) / 1000, contributions });
                }
                scores.sort((a, b) => b.totalScore - a.totalScore);
                const winner = scores[0];
                return textResult(JSON.stringify({
                    action: 'resolve_multi',
                    stakeholders: stakeholders.length,
                    options: optionIds.length,
                    rankings: scores.map(s => ({ option: s.option, score: s.totalScore })),
                    recommendation: winner.option,
                    confidence: scores.length > 1 ? Math.round((winner.totalScore / (winner.totalScore + scores[1].totalScore)) * 1000) / 1000 : 1,
                    tier_breakdown: stakeholders.map(s => ({ id: s.id, weight: s.weight, tier: s.tier, multiplier: tierMultipliers[s.tier] ?? 1 }))
                }, null, 2));
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
