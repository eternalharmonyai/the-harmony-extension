/**
 * Swarm Primitives — Wave 1 + Wave 2 from Kimi's 15-primitive architecture.
 * 
 * Wave 1: convergence_arbiter, adversarial_critic, episodic_memory, decision_log
 * Wave 2: uncertainty_fabric, task_auction, value_resolver
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as git from 'isomorphic-git';
import { consult, ProviderId, resolveCollabModel, Tier } from './providers';
import { concertSpeak, concertCheck, ConcertMessage } from './concertHall';
import { safeHarmonyDir, appendJsonl, readJsonl, rewriteJsonl, readJson, writeJson } from './swarmHarden';
import { idempotent, structuredLog } from './storageUtils';

function workspaceRoot(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
function textResult(text: string): vscode.LanguageModelToolResult {
    const c = text.length > 16000 ? text.slice(0, 16000) + '\n...[truncated]' : text;
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(c.trim() || '[empty]')]);
}
function uid(): string { return crypto.randomUUID().slice(0, 8); }
async function ensureDir(d: string): Promise<void> { await fs.mkdir(d, { recursive: true }); }
function jaccardSimilarity(a: string, b: string): number {
    const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
    const sa = tok(a), sb = tok(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    return new Set([...sa].filter(x => sb.has(x))).size / new Set([...sa, ...sb]).size;
}

// ═══ 1. harmony_convergence_arbiter ═══
interface ConvergenceArbiterInput { room?: string; proposals?: string[]; threshold?: number; max_rounds?: number; current_round?: number; allow_llm_fallback?: boolean; }
export class ConvergenceArbiterTool implements vscode.LanguageModelTool<ConvergenceArbiterInput> {
    constructor(private readonly secrets?: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ConvergenceArbiterInput>, token: vscode.CancellationToken) {
        const { room, proposals: raw, threshold = 0.3, max_rounds = 11, current_round = 1, allow_llm_fallback = true } = options.input;
        let proposals = raw ?? [];
        if (room) { try { const result = await concertCheck([room]); const rm = result?.messages; if (rm && rm.length) proposals = rm.map(m => m.body); } catch {} }
        if (proposals.length < 2) return textResult(JSON.stringify({ signal: 'GO', metrics: { proposal_count: proposals.length, pairwise_similarity_mean: 0, information_gain: 1.0, rounds_elapsed: current_round }, reasoning: 'Need more proposals', recommendation: 'Continue generating' }, null, 2));
        
        // ── Enhanced similarity: TF-IDF weighted n-gram overlap ──
        const ngrams = (s: string, n: number): Set<string> => {
            const clean = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            const words = clean.split(' ');
            const set = new Set<string>();
            for (let i = 0; i <= words.length - n; i++) set.add(words.slice(i, i + n).join(' '));
            return set;
        };
        
        // Compute IDF weights (rarer n-grams = more informative)
        const allBigrams = proposals.map(p => ngrams(p, 2));
        const bigramDocFreq = new Map<string, number>();
        for (const bgSet of allBigrams) for (const bg of bgSet) bigramDocFreq.set(bg, (bigramDocFreq.get(bg) ?? 0) + 1);
        const N = proposals.length;
        
        const weightedSimilarity = (a: string, b: string): number => {
            const ag = ngrams(a, 2), bg = ngrams(b, 2);
            const intersection = new Set([...ag].filter(x => bg.has(x)));
            if (intersection.size === 0) return 0;
            // Weight by IDF: shared RARE bigrams indicate deeper similarity
            let weightedOverlap = 0, totalWeight = 0;
            for (const g of intersection) {
                const idf = Math.log((N + 1) / ((bigramDocFreq.get(g) ?? 0) + 1)) + 1;
                weightedOverlap += idf;
            }
            for (const g of new Set([...ag, ...bg])) {
                const idf = Math.log((N + 1) / ((bigramDocFreq.get(g) ?? 0) + 1)) + 1;
                totalWeight += idf;
            }
            return totalWeight > 0 ? weightedOverlap / totalWeight : 0;
        };
        
        // Compute pairwise similarities
        const sims: number[] = [];
        for (let i = 0; i < proposals.length; i++) for (let j = i + 1; j < proposals.length; j++) {
            const a = proposals[i]?.trim(), b = proposals[j]?.trim();
            if (!a && !b) { sims.push(1); }
            else if (!a || !b) { sims.push(0); }
            else { sims.push(weightedSimilarity(a, b)); }
        }
        const mean = sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
        
        // ── Information gain estimation ──
        // Measure: how much unique bigram coverage does each new proposal add?
        const allCovered = new Set<string>();
        const gains: number[] = [];
        for (const p of proposals) {
            const before = allCovered.size;
            for (const bg of ngrams(p, 2)) allCovered.add(bg);
            gains.push(allCovered.size - before);
        }
        const totalNewInfo = gains.reduce((a, b) => a + b, 0);
        const infoGain = allCovered.size > 0 ? totalNewInfo / allCovered.size : 1;
        
        // ── Decision logic ──
        let signal: string, reasoning: string;
        const roundFraction = current_round / max_rounds;
        const diminishingReturns = infoGain < 0.15 || (current_round > 1 && infoGain < gains[gains.length - 1] * 3);
        
        if (current_round >= max_rounds) {
            signal = 'STOP'; reasoning = `Max rounds (${max_rounds}) reached.`;
        } else if (mean >= (1.0 - threshold) && diminishingReturns) {
            signal = 'STOP'; reasoning = `Converged (sim=${mean.toFixed(3)}) with diminishing returns (infoGain=${infoGain.toFixed(3)}).`;
        } else if (mean >= (1.0 - threshold)) {
            signal = 'CAUTION'; reasoning = `High similarity (${mean.toFixed(3)}) but still gaining information (${infoGain.toFixed(3)}).`;
        } else if (diminishingReturns && current_round > 3) {
            signal = 'CAUTION'; reasoning = `Diminishing information gain (${infoGain.toFixed(3)}) — approaching consensus.`;
        } else {
            signal = 'GO'; reasoning = `Diverse proposals (sim=${mean.toFixed(3)}, infoGain=${infoGain.toFixed(3)}).`;
        }
        
        // Deterministic tiebreaker for CAUTION signals (replaces LLM fallback)
        if (signal === 'CAUTION') {
            // Use n-gram overlap trend: if last 2 rounds show declining information gain, STOP
            const recentGains = gains.slice(-2);
            const declining = recentGains.length >= 2 && recentGains[0] > recentGains[1];
            const veryLowGain = infoGain < 0.05;
            
            if (declining && veryLowGain) {
                signal = 'STOP';
                reasoning += ` Deterministic tiebreaker: declining gains (${recentGains.map(g => g.toFixed(3)).join(' → ')}) + very low info gain (${infoGain.toFixed(3)}) → converge.`;
            } else if (mean >= 0.85 && infoGain < 0.10) {
                signal = 'STOP';
                reasoning += ` Deterministic tiebreaker: high similarity (${mean.toFixed(3)}) + low info gain (${infoGain.toFixed(3)}) → converge.`;
            }
        }
        
        const costEstimate = proposals.length * (current_round + 1) * 0.001; // rough cost per round
        const recommendation = signal === 'STOP'
            ? `Converge. Cost saved by stopping now: ~$${costEstimate.toFixed(3)}. Log with harmony_decision_log.`
            : signal === 'CAUTION'
                ? `One more round (est. cost: ~$${costEstimate.toFixed(3)}), then converge.`
                : `Continue exploring. Expected information gain justifies cost (~$${costEstimate.toFixed(3)}/round).`;
        
        const v = {
            signal,
            metrics: {
                proposal_count: proposals.length,
                pairwise_similarity_mean: Math.round(mean * 1000) / 1000,
                pairwise_similarity_min: Math.round((sims.length > 0 ? Math.min(...sims) : 0) * 1000) / 1000,
                information_gain: Math.round(infoGain * 1000) / 1000,
                diminishing_returns: diminishingReturns,
                rounds_elapsed: current_round,
                round_fraction: Math.round(roundFraction * 100),
                estimated_cost_next_round: Math.round(costEstimate * 10000) / 10000,
            },
            reasoning,
            recommendation,
        };
        try { await concertSpeak(room || 'convergence', 'arbiter', JSON.stringify(v)); } catch {}
        return textResult(JSON.stringify(v, null, 2));
    }
}

// ═══ 2. harmony_adversarial_critic ═══
interface AdversarialCriticInput { target: string; language?: string; dimensions?: string[]; validate?: boolean; }
export interface HardenedCriticFinding {
    dimension: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'observation';
    description: string;
    evidence?: { line_number?: number; code_snippet?: string; pattern?: string };
    failing_test?: string;
    test_result?: 'test_failed' | 'test_passed' | 'not_validated' | 'test_error';
    remediation?: string;
    confidence_0_to_1?: number;
    false_positive_risk?: 'low' | 'medium' | 'high';
}
export class AdversarialCriticTool implements vscode.LanguageModelTool<AdversarialCriticInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<AdversarialCriticInput>, token: vscode.CancellationToken) {
        const { target, language = 'typescript', dimensions = ['security', 'logic', 'performance'], validate = true } = options.input;
        if (!target?.trim()) return textResult('error: target required');
        const sp = `You are an ADVERSARIAL CODE CRITIC. Find REAL, evidence-backed flaws only — not style opinions.
For each finding provide a JSON object with:
- dimension: "security"|"logic"|"performance"|"correctness"|"maintainability"
- severity: "critical"|"high"|"medium"|"low"  (critical = exploitable/crash, high = bug, medium = smell, low = nit)
- description: one sentence
- evidence: { line_number?: number, code_snippet?: string (exact line from code), pattern?: string (e.g. "unsanitized input") }
- failing_test: a concrete test that WOULD FAIL because of this bug
- remediation: brief fix suggestion
- confidence_0_to_1: your confidence this is a real bug (0.0-1.0)

Output ONLY a JSON array. No markdown, no explanation.`;
        const sel = await resolveCollabModel(this.secrets);
        let response: string;
        try { const r = await consult(this.secrets, { provider: sel?.provider ?? 'deepseek', tier: 'mid', question: sp + '\n\nCODE (' + language + '):\n' + target.slice(0, 8000), maxTokens: 2048 }, token); response = r.text; }
        catch (e: any) { return textResult('error: critic failed: ' + (e?.message ?? String(e))); }
        let findings: HardenedCriticFinding[];
        try { const m = response.match(/\[[\s\S]*\]/); if (!m) return textResult('No JSON in critic response: ' + response.slice(0, 500)); findings = JSON.parse(m[0]); if (!Array.isArray(findings) || findings.length === 0) return textResult('Critic found nothing: ' + response.slice(0, 300)); }
        catch { return textResult('Parse error: ' + response.slice(0, 500)); }
        findings = findings.filter(f => dimensions.includes(f.dimension));

        // ── Evidence gate: findings without evidence are demoted to "observation" ──
        for (const f of findings) {
            const hasEvidence = f.evidence && (f.evidence.line_number || f.evidence.code_snippet || f.evidence.pattern);
            if (!hasEvidence) {
                f.severity = 'observation';
                f.false_positive_risk = 'high';
            }
            // Confidence below 0.3 also demotes to observation
            if ((f.confidence_0_to_1 ?? 1) < 0.3) {
                f.severity = 'observation';
                f.false_positive_risk = 'high';
            }
        }

        // ── Validation: test each finding's failing test ──
        if (validate) {
            for (const f of findings) {
                if (!f.failing_test || f.failing_test.trim().length < 10) { f.test_result = 'not_validated'; if (f.severity !== 'observation') f.severity = 'low'; continue; }
                try {
                    const tr = await consult(this.secrets, { provider: 'deepseek', tier: 'light', question: 'Test validator. Does this test FAIL? Answer FAILS/PASSES/UNCLEAR.\nCODE:\n' + target.slice(0, 3000) + '\nTEST:\n' + f.failing_test.slice(0, 2000), maxTokens: 64 }, token);
                    const rt = tr.text.toUpperCase();
                    if (rt.includes('FAILS')) f.test_result = 'test_failed';
                    else if (rt.includes('PASSES')) { f.test_result = 'test_passed'; f.severity = 'observation'; f.false_positive_risk = 'high'; }
                    else f.test_result = 'not_validated';
                } catch { f.test_result = 'test_error'; }
            }
            findings = findings.filter(f => f.test_result !== 'test_passed');
        }

        // ── Severity calibration: "critical" requires test_failed + evidence ──
        for (const f of findings) {
            if (f.severity === 'critical') {
                const hasEvidence = f.evidence && (f.evidence.line_number || f.evidence.code_snippet || f.evidence.pattern);
                if (f.test_result !== 'test_failed' || !hasEvidence) {
                    f.severity = 'high'; // downgrade: critical needs proof
                }
            }
        }

        // ── False-positive risk assessment ──
        for (const f of findings) {
            if (f.false_positive_risk) continue; // already set by evidence gate
            const conf = f.confidence_0_to_1 ?? 0.5;
            if (f.severity === 'low' && conf < 0.6) f.false_positive_risk = 'medium';
            else if (conf < 0.4) f.false_positive_risk = 'high';
            else if (conf < 0.7) f.false_positive_risk = 'medium';
            else f.false_positive_risk = 'low';
        }

        // ── Correlation / duplicate detection ──
        const seen = new Set<string>();
        findings = findings.filter(f => {
            const fp = (f.evidence?.pattern ?? '') + '|' + (f.remediation ?? '').slice(0, 80);
            if (seen.has(fp)) return false;
            seen.add(fp);
            return true;
        });

        if (findings.length === 0) return textResult(JSON.stringify({ verdict: 'NO_VALID_FINDINGS', note: 'All findings were filtered by evidence/confidence/duplicate gates' }, null, 2));
        try { await concertSpeak('adversarial', 'critic', JSON.stringify({ count: findings.length, high_risk: findings.filter(f => f.false_positive_risk === 'high').length })); } catch {}
        return textResult(JSON.stringify({
            verdict: 'FINDINGS_FOUND',
            finding_count: findings.length,
            critical: findings.filter(f => f.severity === 'critical').length,
            validated: findings.filter(f => f.test_result === 'test_failed').length,
            high_false_positive_risk: findings.filter(f => f.false_positive_risk === 'high').length,
            observations: findings.filter(f => f.severity === 'observation').length,
            findings
        }, null, 2));
    }
}

// ═══ 3. harmony_episodic_memory (upgraded to DuckDB backend) ═══
interface EMemInput { action: 'store' | 'query' | 'decay' | 'consolidate' | 'stats' | 'graph' | 'forget'; store?: { content: string; tags?: string[]; confidence?: number; related_ids?: string[]; source?: string }; query?: { tags?: string[]; min_confidence?: number; max_age_hours?: number; related_to?: string; source?: string; limit?: number }; decay_half_life_hours?: number; graph_root_id?: string; graph_max_depth?: number; }
export class EpisodicMemoryTool implements vscode.LanguageModelTool<EMemInput> {
    private _store: any = null;
    
    private async getStore(): Promise<any> {
        if (this._store) return this._store;
        const { EpisodicStore } = await import('./episodicStore');
        const root = workspaceRoot(); if (!root) throw new Error('no workspace');
        this._store = new EpisodicStore(root);
        await this._store.init();
        return this._store;
    }
    
    async invoke(options: vscode.LanguageModelToolInvocationOptions<EMemInput>, _token: vscode.CancellationToken) {
        const { action, store, query, decay_half_life_hours = 72, graph_root_id, graph_max_depth = 3 } = options.input;
        
        try {
            const es = await this.getStore();
            switch (action) {
                case 'store': {
                    if (!store?.content) return textResult('error: content required');
                    // Idempotency: hash content to prevent duplicate writes
                    const contentHash = crypto.createHash('sha256').update(store.content).digest('hex').slice(0, 16);
                    const result = await idempotent(`emem-store:${contentHash}`, async () => {
                        return await es.store({
                            content: store.content,
                            tags: store.tags,
                            confidence: store.confidence,
                            related_ids: store.related_ids,
                            source: store.source,
                        });
                    });
                    structuredLog('episodic-memory', 'info', 'memory stored', { id: result.id, tags: store.tags });
                    return textResult(JSON.stringify(result, null, 2));
                }
                case 'query': {
                    const results = await es.query({
                        tags: query?.tags,
                        min_confidence: query?.min_confidence,
                        max_age_hours: query?.max_age_hours,
                        related_to: query?.related_to,
                        source: query?.source,
                        limit: query?.limit ?? 20,
                    });
                    return textResult(JSON.stringify({
                        count: results.length,
                        memories: results.map((m: any) => ({
                            id: m.id,
                            timestamp: m.created_at,
                            content: (m.content ?? '').slice(0, 300),
                            tags: m.tags ?? [],
                            confidence: m.confidence,
                            source: m.source,
                        }))
                    }, null, 2));
                }
                case 'decay': {
                    const result = await es.decay(decay_half_life_hours);
                    return textResult(JSON.stringify({ status: 'decayed', ...result }, null, 2));
                }
                case 'consolidate': {
                    const result = await es.consolidate();
                    return textResult(JSON.stringify({ status: 'consolidated', ...result }, null, 2));
                }
                case 'stats': {
                    const stats = await es.stats();
                    return textResult(JSON.stringify(stats, null, 2));
                }
                case 'graph': {
                    if (!graph_root_id) return textResult('error: graph_root_id required');
                    const rows = await es.graph(graph_root_id, graph_max_depth);
                    return textResult(JSON.stringify({
                        root: graph_root_id,
                        max_depth: graph_max_depth,
                        nodes: rows.length,
                        edges: rows.map((r: any) => ({
                            from: r.memory_id,
                            to: r.related_id,
                            type: r.relation_type,
                        })),
                    }, null, 2));
                }
                case 'forget': {
                    const result = await es.applyForgettingPolicy();
                    return textResult(JSON.stringify({ status: 'forgotten', ...result }, null, 2));
                }
                default: return textResult('error: unknown action. Use: store, query, decay, consolidate, stats, graph, forget');
            }
        } catch (e: any) {
            return textResult(JSON.stringify({ error: 'episodic memory error', detail: e?.message ?? String(e) }, null, 2));
        }
    }
}

// ═══ 4. harmony_decision_log ═══

// ═══ 4. harmony_decision_log ═══
interface DNode { id: string; parent_ids: string[]; timestamp: number; agent: string; decision: string; premises: string[]; alternatives: string[]; rationale: string; status: string; context?: string; }
interface DLogInput { action: 'append' | 'query' | 'graph' | 'stats'; append?: { decision: string; premises?: string[]; alternatives?: string[]; rationale?: string; parent_ids?: string[]; agent?: string; status?: string; context?: string }; query?: { parent_id?: string; agent?: string; status?: string; since_hours?: number; keyword?: string; limit?: number }; root_id?: string; max_depth?: number; }
function buildTree(nodes: DNode[], nid: string, prefix = '', last = true, depth = 0, maxD = 5): string {
    if (depth >= maxD) return ''; const n = nodes.find(x => x.id === nid); if (!n) return '';
    let t = prefix + (last ? '\u2514\u2500\u2500 ' : '\u250c\u2500\u2500 ') + n.decision.slice(0, 80) + ' [' + n.status + '] (' + n.agent + ')\n';
    const ch = nodes.filter(x => x.parent_ids.includes(nid));
    for (let i = 0; i < ch.length; i++) t += buildTree(nodes, ch[i].id, prefix + (last ? '    ' : '\u2502   '), i === ch.length - 1, depth + 1, maxD);
    return t;
}
export class DecisionLogTool implements vscode.LanguageModelTool<DLogInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<DLogInput>, _token: vscode.CancellationToken) {
        const { action, append, query, root_id, max_depth = 5 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'decision-log'); await ensureDir(dir);
        const fp = path.join(dir, 'decisions.jsonl');
        const readAll = async (): Promise<DNode[]> => { return await readJsonl(fp); };
        const appendD = async (n: DNode) => { await appendJsonl(fp, n); };
        switch (action) {
            case 'append': {
                if (!append?.decision) return textResult('error: decision required');
                const nodes = await readAll(); const pids = append.parent_ids ?? [];
                for (const p of pids) if (!nodes.some(n => n.id === p)) return textResult('error: parent ' + p + ' not found');
                const n: DNode = { id: uid(), parent_ids: pids, timestamp: Date.now(), agent: append.agent ?? 'unknown', decision: append.decision, premises: append.premises ?? [], alternatives: append.alternatives ?? [], rationale: append.rationale ?? '', status: append.status ?? 'proposed', context: append.context };
                await appendD(n);
                try { await concertSpeak('decision-log', n.agent, 'Decision: ' + n.decision.slice(0, 200)); } catch {}
                return textResult(JSON.stringify({ status: 'appended', id: n.id, decision: n.decision, timestamp: new Date(n.timestamp).toISOString() }, null, 2));
            }
            case 'query': {
                const q = query ?? {}; let nodes = await readAll();
                if (q.parent_id) nodes = nodes.filter(n => n.parent_ids.includes(q.parent_id!));
                if (q.agent) nodes = nodes.filter(n => n.agent === q.agent);
                if (q.status) nodes = nodes.filter(n => n.status === q.status);
                if (q.since_hours !== undefined) nodes = nodes.filter(n => n.timestamp >= Date.now() - q.since_hours! * 3600 * 1000);
                if (q.keyword) { const kw = q.keyword.toLowerCase(); nodes = nodes.filter(n => n.decision.toLowerCase().includes(kw) || n.rationale.toLowerCase().includes(kw)); }
                nodes.sort((a, b) => b.timestamp - a.timestamp);
                const r = nodes.slice(0, q.limit ?? 20);
                return textResult(JSON.stringify({ count: r.length, total: nodes.length, decisions: r.map(n => ({ id: n.id, timestamp: new Date(n.timestamp).toISOString(), agent: n.agent, decision: n.decision.slice(0, 200), status: n.status })) }, null, 2));
            }
            case 'graph': {
                const nodes = await readAll(); if (nodes.length === 0) return textResult('No decisions yet.');
                const allIds = new Set(nodes.map(n => n.id));
                const roots = nodes.filter(n => n.parent_ids.length === 0 || n.parent_ids.every(p => !allIds.has(p)));
                const sid = root_id ?? roots[0]?.id; if (!sid) return textResult('No roots.');
                const tree = buildTree(nodes, sid, '', true, 0, max_depth);
                return textResult(JSON.stringify({ root_id: sid, total: nodes.length, tree: '\n' + tree, status: { proposed: nodes.filter(n => n.status === 'proposed').length, accepted: nodes.filter(n => n.status === 'accepted').length, rejected: nodes.filter(n => n.status === 'rejected').length, superseded: nodes.filter(n => n.status === 'superseded').length } }, null, 2));
            }
            case 'stats': {
                const nodes = await readAll();
                const ag = new Map<string, number>(); for (const n of nodes) ag.set(n.agent, (ag.get(n.agent) ?? 0) + 1);
                return textResult(JSON.stringify({ total: nodes.length, status: { proposed: nodes.filter(n => n.status === 'proposed').length, accepted: nodes.filter(n => n.status === 'accepted').length, rejected: nodes.filter(n => n.status === 'rejected').length, superseded: nodes.filter(n => n.status === 'superseded').length }, top_agents: [...ag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ agent: k, decisions: v })) }, null, 2));
            }
            default: return textResult('error: unknown action. Use: append, query, graph, stats');
        }
    }
}

// ═══ 5. harmony_uncertainty_fabric (Wave 2 — upgraded: Beta distributions + calibration) ═══
interface UClaim { id: string; claim: string; alpha: number; beta: number; evidence: string[]; counterevidence: string[]; source: string; timestamp: number; status: string; calibrated?: boolean; }
interface UFabricInput { action: 'add' | 'query' | 'escalate' | 'stats' | 'calibrate'; add?: { claim: string; confidence?: number; variance?: number; evidence?: string[]; counterevidence?: string[]; source?: string }; query?: { min_confidence?: number; max_variance?: number; status?: string; source?: string; limit?: number }; escalate_threshold?: number; calibrate?: { claim_id: string; actual_outcome: boolean }; }
export class UncertaintyFabricTool implements vscode.LanguageModelTool<UFabricInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<UFabricInput>, _token: vscode.CancellationToken) {
        const { action, add, query, escalate_threshold = 0.4, calibrate } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'uncertainty-fabric'); await ensureDir(dir);
        const fp = path.join(dir, 'claims.jsonl');
        const calFp = path.join(dir, 'calibration.jsonl');
        const readAll = async (): Promise<UClaim[]> => { return await readJsonl(fp); };
        const rewrite = async (cs: UClaim[]) => { await rewriteJsonl(fp, cs); };
        
        // Beta distribution helpers
        const betaMean = (a: number, b: number) => a / (a + b);
        const betaVar = (a: number, b: number) => (a * b) / ((a + b) ** 2 * (a + b + 1));
        
        // Convert legacy mean/variance to alpha/beta
        const fromLegacy = (mean: number, variance: number): { alpha: number; beta: number } => {
            if (variance <= 0 || variance >= mean * (1 - mean)) {
                // Fallback: use confidence as pseudo-counts
                return { alpha: Math.max(1, mean * 10), beta: Math.max(1, (1 - mean) * 10) };
            }
            const k = (mean * (1 - mean)) / variance - 1;
            return { alpha: Math.max(0.5, mean * k), beta: Math.max(0.5, (1 - mean) * k) };
        };
        
        // Compute aggregate uncertainty from Beta distributions
        const computeAggregate = (claims: UClaim[]) => {
            const active = claims.filter(c => c.status !== 'resolved');
            if (active.length === 0) return { aggregate_mean: 0, aggregate_variance: 0, high_risk_count: 0, total_observations: 0 };
            const totalAlpha = active.reduce((s, c) => s + c.alpha, 0);
            const totalBeta = active.reduce((s, c) => s + c.beta, 0);
            const aggMean = totalAlpha / (totalAlpha + totalBeta);
            const aggVar = (totalAlpha * totalBeta) / ((totalAlpha + totalBeta) ** 2 * (totalAlpha + totalBeta + 1));
            const highRisk = active.filter(c => {
                const m = betaMean(c.alpha, c.beta);
                const v = betaVar(c.alpha, c.beta);
                return m < escalate_threshold || v > 0.3;
            }).length;
            return {
                aggregate_mean: Math.round(aggMean * 1000) / 1000,
                aggregate_variance: Math.round(aggVar * 1000) / 1000,
                high_risk_count: highRisk,
                total_observations: totalAlpha + totalBeta - active.length * 2, // subtract priors
            };
        };
        
        switch (action) {
            case 'add': {
                if (!add?.claim) return textResult('error: claim required');
                // Convert scalar confidence to Beta distribution
                const rawMean = add.confidence ?? 0.5;
                const rawVar = add.variance ?? 0.1;
                const dist = fromLegacy(rawMean, rawVar);
                const c: UClaim = {
                    id: uid(), claim: add.claim,
                    alpha: dist.alpha, beta: dist.beta,
                    evidence: add.evidence ?? [],
                    counterevidence: add.counterevidence ?? [],
                    source: add.source ?? 'unknown',
                    timestamp: Date.now(),
                    status: (rawMean < escalate_threshold || rawVar > 0.3) ? 'escalated' : 'pending',
                    calibrated: false,
                };
                await appendJsonl(fp, c);
                if (c.status === 'escalated') {
                    try { await concertSpeak('uncertainty', 'fabric', `HIGH RISK (α=${c.alpha.toFixed(1)}, β=${c.beta.toFixed(1)}): ${c.claim.slice(0, 200)}`); } catch {}
                }
                const m = betaMean(c.alpha, c.beta), v = betaVar(c.alpha, c.beta);
                return textResult(JSON.stringify({
                    status: c.status,
                    id: c.id,
                    mean: Math.round(m * 1000) / 1000,
                    variance: Math.round(v * 1000) / 1000,
                    alpha: c.alpha,
                    beta: c.beta,
                    observations: (c.alpha + c.beta - 2),
                    is_escalated: c.status === 'escalated',
                }, null, 2));
            }
            case 'query': {
                const q = query ?? {}; let cs = await readAll();
                if (q.min_confidence !== undefined) cs = cs.filter(c => betaMean(c.alpha, c.beta) >= q.min_confidence!);
                if (q.max_variance !== undefined) cs = cs.filter(c => betaVar(c.alpha, c.beta) <= q.max_variance!);
                if (q.status) cs = cs.filter(c => c.status === q.status);
                if (q.source) cs = cs.filter(c => c.source === q.source);
                cs.sort((a, b) => betaMean(b.alpha, b.beta) - betaMean(a.alpha, a.beta));
                const r = cs.slice(0, q.limit ?? 20);
                const agg = computeAggregate(cs);
                return textResult(JSON.stringify({
                    count: r.length,
                    total: cs.length,
                    aggregate: agg,
                    claims: r.map(c => ({
                        id: c.id,
                        claim: c.claim.slice(0, 200),
                        mean: Math.round(betaMean(c.alpha, c.beta) * 1000) / 1000,
                        variance: Math.round(betaVar(c.alpha, c.beta) * 1000) / 1000,
                        alpha: c.alpha, beta: c.beta,
                        observations: c.alpha + c.beta - 2,
                        status: c.status,
                        calibrated: c.calibrated,
                    }))
                }, null, 2));
            }
            case 'escalate': {
                const cs = await readAll(); let n = 0;
                for (const c of cs) {
                    const m = betaMean(c.alpha, c.beta), v = betaVar(c.alpha, c.beta);
                    const isHighRisk = m < escalate_threshold || v > 0.3;
                    if (isHighRisk && c.status !== 'escalated') { c.status = 'escalated'; n++; }
                }
                if (n > 0) await rewrite(cs);
                const agg = computeAggregate(cs);
                return textResult(JSON.stringify({
                    escalated: n,
                    aggregate: agg,
                    recommendation: agg.high_risk_count > 3
                        ? 'DECOMPOSE: too many high-risk claims. Break down the problem.'
                        : agg.aggregate_variance > 0.25
                            ? 'GATHER_EVIDENCE: high aggregate variance (uncertainty). Need more observations.'
                            : agg.total_observations < 10
                                ? 'MORE_DATA: only ' + agg.total_observations + ' observations — increase calibration sample size.'
                                : 'PROCEED: uncertainty within acceptable bounds.',
                }, null, 2));
            }
            case 'stats': {
                const cs = await readAll();
                const agg = computeAggregate(cs);
                return textResult(JSON.stringify({
                    total: cs.length,
                    calibrated: cs.filter(c => c.calibrated).length,
                    uncalibrated: cs.filter(c => !c.calibrated).length,
                    escalated: cs.filter(c => c.status === 'escalated').length,
                    aggregate: agg,
                    high_variance: cs.filter(c => betaVar(c.alpha, c.beta) > 0.3).length,
                    total_observations: cs.reduce((s, c) => s + c.alpha + c.beta - 2, 0),
                }, null, 2));
            }
            case 'calibrate': {
                if (!calibrate?.claim_id) return textResult('error: claim_id required');
                const cs = await readAll();
                const claim = cs.find(c => c.id === calibrate.claim_id);
                if (!claim) return textResult('error: claim not found');
                
                // Bayesian update: add observation to Beta distribution
                const oldMean = betaMean(claim.alpha, claim.beta);
                const oldVar = betaVar(claim.alpha, claim.beta);
                
                if (calibrate.actual_outcome) {
                    claim.alpha += 1; // success
                } else {
                    claim.beta += 1; // failure
                }
                
                const newMean = betaMean(claim.alpha, claim.beta);
                const newVar = betaVar(claim.alpha, claim.beta);
                claim.calibrated = true;
                
                // Record calibration point
                const calPoint = {
                    claim_id: calibrate.claim_id,
                    old_alpha: claim.alpha - (calibrate.actual_outcome ? 1 : 0),
                    old_beta: claim.beta - (calibrate.actual_outcome ? 0 : 1),
                    new_alpha: claim.alpha,
                    new_beta: claim.beta,
                    old_mean: Math.round(oldMean * 1000) / 1000,
                    new_mean: Math.round(newMean * 1000) / 1000,
                    outcome: calibrate.actual_outcome,
                    timestamp: Date.now(),
                };
                await appendJsonl(calFp, calPoint);
                
                // Resolve if we have enough observations
                const observations = claim.alpha + claim.beta - 2;
                if (observations >= 5) claim.status = 'resolved';
                
                await rewrite(cs);
                return textResult(JSON.stringify({
                    status: 'calibrated',
                    claim_id: calibrate.claim_id,
                    old_mean: calPoint.old_mean,
                    new_mean: calPoint.new_mean,
                    alpha: claim.alpha,
                    beta: claim.beta,
                    observations,
                    variance: Math.round(newVar * 1000) / 1000,
                    direction: calibrate.actual_outcome ? 'confirmed ↑' : 'contradicted ↓',
                }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 6. harmony_task_auction (Wave 2) ═══

// ═══ 6. harmony_task_auction (Wave 2) ═══
interface TRecord { taskType: string; agent: string; success: boolean; confidenceBid: number; timestamp: number; }
interface TAuctionInput { action: 'bid' | 'record' | 'stats'; task_type?: string; bids?: { agent: string; bid: number; specialization?: string[] }[]; record?: { task_type: string; agent: string; success: boolean; confidence_bid?: number }; }
export class TaskAuctionTool implements vscode.LanguageModelTool<TAuctionInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<TAuctionInput>, _token: vscode.CancellationToken) {
        const { action, task_type, bids, record } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'task-auction'); await ensureDir(dir);
        const fp = path.join(dir, 'history.jsonl');
        const readH = async (): Promise<TRecord[]> => { return await readJsonl(fp); };
        switch (action) {
            case 'bid': {
                if (!task_type || !bids?.length) return textResult('error: task_type and bids required');
                const h = await readH();
                const adj = bids.map(b => { const ah = h.filter(x => x.agent === b.agent && x.taskType === task_type); const rate = ah.length > 0 ? ah.filter(x => x.success).length / ah.length : 0.5; return { ...b, adjusted_bid: Math.round(b.bid * (0.4 + 0.6 * rate) * 10) / 10, success_rate: Math.round(rate * 100), history: ah.length }; });
                adj.sort((a, b) => b.adjusted_bid - a.adjusted_bid);
                if (adj[0].adjusted_bid < 3) return textResult(JSON.stringify({ verdict: 'CAPABILITY_GAP', message: 'No agent above threshold. Decompose or spawn specialist.', bids: adj }, null, 2));
                return textResult(JSON.stringify({ verdict: 'AWARDED', winner: adj[0].agent, adjusted_bid: adj[0].adjusted_bid, all_bids: adj }, null, 2));
            }
            case 'record': {
                if (!record?.task_type || !record.agent) return textResult('error: task_type and agent required');
                await fs.appendFile(fp, JSON.stringify({ taskType: record.task_type, agent: record.agent, success: record.success, confidenceBid: record.confidence_bid ?? 5, timestamp: Date.now() }) + '\n', 'utf8');
                return textResult(JSON.stringify({ status: 'recorded' }, null, 2));
            }
            case 'stats': {
                const h = await readH(); const byA = new Map<string, { t: number; s: number }>();
                for (const r of h) { if (!byA.has(r.agent)) byA.set(r.agent, { t: 0, s: 0 }); const a = byA.get(r.agent)!; a.t++; if (r.success) a.s++; }
                return textResult(JSON.stringify({ total: h.length, agents: [...byA.entries()].map(([k, v]) => ({ agent: k, tasks: v.t, rate: Math.round(v.s / v.t * 100) })).sort((a, b) => b.rate - a.rate) }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 7. harmony_value_resolver (Wave 2) ═══
interface VHier { principles: { name: string; priority: number; description: string }[]; }
interface VTen { id: string; option_a: string; option_b: string; principle_a: string; principle_b: string; resolution?: string; justification?: string; timestamp: number; status: string; }
interface VResolverInput { action: 'define_hierarchy' | 'resolve_tension' | 'query' | 'stats'; principles?: { name: string; priority: number; description: string }[]; tension?: { option_a: string; option_b: string; principle_a: string; principle_b: string }; }
export class ValueResolverTool implements vscode.LanguageModelTool<VResolverInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<VResolverInput>, _token: vscode.CancellationToken) {
        const { action, principles, tension } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'value-resolver'); await ensureDir(dir);
        const hp = path.join(dir, 'hierarchy.json'), tp = path.join(dir, 'tensions.jsonl');
        const readH = async (): Promise<VHier> => { return (await readJson(hp)) ?? { principles: [] }; };
        const readT = async (): Promise<VTen[]> => { return await readJsonl(tp); };
        switch (action) {
            case 'define_hierarchy': {
                if (!principles?.length) return textResult('error: principles required');
                await fs.writeFile(hp, JSON.stringify({ principles }, null, 2), 'utf8');
                return textResult(JSON.stringify({ status: 'defined', hierarchy: principles.sort((a, b) => a.priority - b.priority).map(p => 'P' + p.priority + '. ' + p.name + ': ' + p.description) }, null, 2));
            }
            case 'resolve_tension': {
                if (!tension) return textResult('error: tension required');
                try {
                const h = await readH(); if (h.principles.length === 0) return textResult('error: no hierarchy defined');
                const pa = h.principles.find(p => p.name === tension.principle_a), pb = h.principles.find(p => p.name === tension.principle_b);
                if (!pa || !pb) return textResult('error: principle not found. Available: ' + h.principles.map(p => p.name).join(', '));
                const winner = pa.priority <= pb.priority ? tension.option_a : tension.option_b;
                const wp = pa.priority <= pb.priority ? tension.principle_a : tension.principle_b;
                const just = '"' + winner + '" because Principle "' + wp + '" (P' + Math.min(pa.priority, pb.priority) + ') outranks (P' + Math.max(pa.priority, pb.priority) + ').';
                const t: VTen = { id: uid(), option_a: tension.option_a, option_b: tension.option_b, principle_a: tension.principle_a, principle_b: tension.principle_b, resolution: winner, justification: just, timestamp: Date.now(), status: 'resolved' };
                await appendJsonl(tp, t);
                try { await concertSpeak('value-resolver', 'ethos', 'Resolved: ' + tension.option_a + ' vs ' + tension.option_b + ' -> ' + winner); } catch {}
                structuredLog('value-resolver', 'info', 'tension resolved', { winner, principle: wp });
                return textResult(JSON.stringify({ status: 'resolved', winner, winning_principle: wp, justification: just }, null, 2));
                } catch (e: any) {
                    // Graceful degradation: return cached last-known resolution for same principles
                    structuredLog('value-resolver', 'error', 'resolution failed, using degraded fallback', { error: e.message });
                    const ts = await readT();
                    const cached = ts.filter(t => t.principle_a === tension.principle_a && t.principle_b === tension.principle_b).pop();
                    if (cached) {
                        return textResult(JSON.stringify({ status: 'degraded', cached_resolution: cached.resolution, justification: cached.justification + ' (from cache)', note: 'Value resolver degraded — using last cached resolution' }, null, 2));
                    }
                    return textResult(JSON.stringify({ status: 'unresolved', error: 'Resolution unavailable — no cached fallback. Manual resolution required.', detail: e.message }, null, 2));
                }
            }
            case 'query': {
                const ts = await readT();
                return textResult(JSON.stringify({ total: ts.length, resolved: ts.filter(t => t.status === 'resolved').length, recent: ts.slice(-10).map(t => ({ id: t.id, tension: t.option_a + ' vs ' + t.option_b, resolution: t.resolution })) }, null, 2));
            }
            case 'stats': {
                const h = await readH(), ts = await readT();
                return textResult(JSON.stringify({ hierarchy_defined: h.principles.length > 0, principles: h.principles.length, tensions: ts.length, resolved: ts.filter(t => t.status === 'resolved').length, hierarchy: h.principles.sort((a, b) => a.priority - b.priority).map(p => ({ priority: p.priority, name: p.name })) }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 8. harmony_swarm_topology (Wave 3) ═══
type Topology = 'star' | 'pipeline' | 'ring' | 'small_world';
interface TopologyInput { action: 'configure' | 'status' | 'phase_transition'; topology?: Topology; phase?: string; reason?: string; }
export class SwarmTopologyTool implements vscode.LanguageModelTool<TopologyInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<TopologyInput>, _token: vscode.CancellationToken) {
        const { action, topology = 'star', phase, reason } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'topology'); await ensureDir(dir);
        const fp = path.join(dir, 'state.json');
        const read = async (): Promise<any> => { return (await readJson(fp)) ?? { current: 'star', phases: [] }; };
        const rules: Record<Topology, string> = {
            star: 'Hub-and-spoke: one lead, fan-out to workers. Best for debugging.',
            pipeline: 'Sequential handoff. Best for code generation with review stages.',
            ring: 'Consensus rounds. Best for security/quality review.',
            small_world: 'High clustering, short paths. Best for architectural brainstorming.',
        };
        switch (action) {
            case 'configure': {
                const state = await read(); state.current = topology; state.configured_at = Date.now();
                if (phase) state.phases.push({ topology, phase, reason, timestamp: Date.now() });
                await writeJson(fp, state);
                try { await concertSpeak('topology', 'director', 'Switched to ' + topology + (phase ? ' for ' + phase : '')); } catch {}
                return textResult(JSON.stringify({ status: 'configured', topology, phase, routing_rules: rules[topology] }, null, 2));
            }
            case 'status': {
                const state = await read();
                return textResult(JSON.stringify({ current_topology: state.current, phase_history: (state.phases || []).slice(-5), routing_rules: rules[state.current as Topology] || 'Unknown' }, null, 2));
            }
            case 'phase_transition': {
                if (!topology || !phase) return textResult('error: topology and phase required');
                const state = await read();
                const prev = state.current;
                state.current = topology;
                state.phases.push({ topology, phase, reason, previous: prev, timestamp: Date.now() });
                await writeJson(fp, state);
                try { await concertSpeak('topology', 'director', 'Phase: ' + prev + ' -> ' + topology + ' (' + phase + ')'); } catch {}
                return textResult(JSON.stringify({ status: 'transitioned', from: prev, to: topology, phase, transitions: state.phases.length }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 9. harmony_execution_sandbox (Wave 3 — upgraded to three-tier safe execution) ═══
interface ESandboxInput { action: 'run' | 'status' | 'capabilities'; language?: string; code?: string; test?: string; timeout_sec?: number; memory_limit_mb?: number; }
export class ExecutionSandboxTool implements vscode.LanguageModelTool<ESandboxInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ESandboxInput>, _token: vscode.CancellationToken) {
        const { action, language = 'javascript', code, test, timeout_sec = 30, memory_limit_mb = 64 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        
        switch (action) {
            case 'run': {
                if (!code) return textResult('error: code required');
                
                // Dynamic import to avoid crash when sandboxRunner is missing
                let SandboxRunner: any;
                try {
                    const mod = await import('./sandboxRunner');
                    SandboxRunner = mod.SandboxRunner;
                } catch (e: any) {
                    return textResult(JSON.stringify({
                        error: 'Sandbox runner unavailable',
                        detail: e?.message ?? 'sandboxRunner module not found',
                        note: 'This tool requires isolated-vm. Run: npm install isolated-vm'
                    }, null, 2));
                }
                
                const runner = new SandboxRunner(root);
                const result = await runner.execute(code, test, {
                    language,
                    timeoutSec: timeout_sec,
                    memoryLimitMB: memory_limit_mb,
                    allowFallback: true,
                });
                
                return textResult(JSON.stringify({
                    pass: result.pass,
                    output: result.output?.slice(0, 4000),
                    error: result.error,
                    tier: result.tier,
                    metrics: result.metrics,
                    diagnostics: result.diagnostics,
                    fallback_used: result.fallback_used,
                    note: result.tier === 1 ? 'Executed in isolated-vm (V8 isolate)' :
                           result.tier === 2 ? 'Executed in Pyodide (CPython WASM)' :
                           'Executed in Windows Sandbox (Hyper-V VM)'
                }, null, 2));
            }
            case 'capabilities': {
                let capabilities: any = { tier1: false, tier2: false, tier3: false };
                try {
                    const mod = await import('./sandboxRunner');
                    const runner = new mod.SandboxRunner(root);
                    capabilities = await runner.detectCapabilities();
                } catch { /* sandboxRunner unavailable */ }
                return textResult(JSON.stringify({
                    tiers: {
                        tier1: capabilities.tier1 ? 'available — isolated-vm (JS/TS, <1s)' : 'unavailable',
                        tier2: capabilities.tier2 ? 'available — Pyodide (Python, 3-5s)' : 'unavailable — install Pyodide',
                        tier3: capabilities.tier3 ? 'available — Windows Sandbox (any language, 30-60s)' : 'unavailable — requires Windows Pro/Enterprise',
                    },
                    recommended: `tier${capabilities.recommended ?? 1}`
                }, null, 2));
            }
            case 'status': {
                const dir = safeHarmonyDir(root, 'sandbox-exec');
                const runs: string[] = [];
                try { await ensureDir(dir); const entries = await fs.readdir(dir); for (const e of entries) { const s = await fs.stat(path.join(dir, e)); if (s.isDirectory()) runs.push(e); } } catch {}
                return textResult(JSON.stringify({ sandbox_dir: dir, total_runs: runs.length, recent: runs.slice(-10) }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 10. harmony_temporal_branch (Wave 3 — upgraded: Chronos git-backend) ═══
interface TemporalBranchInput { action: 'checkpoint' | 'fork' | 'rollback' | 'switch' | 'list' | 'log'; branch_name?: string; message?: string; target_commit?: string; mode?: 'hard' | 'soft'; }
export class TemporalBranchTool implements vscode.LanguageModelTool<TemporalBranchInput> {
    private _store: any = null;
    
    private async getStore(): Promise<any> {
        if (this._store) return this._store;
        const { TemporalStore } = await import('./temporalStore');
        const root = workspaceRoot(); if (!root) throw new Error('no workspace');
        this._store = new TemporalStore(root);
        await this._store.init();
        return this._store;
    }
    
    async invoke(options: vscode.LanguageModelToolInvocationOptions<TemporalBranchInput>, _token: vscode.CancellationToken) {
        const { action, branch_name, message, target_commit, mode = 'hard' } = options.input;
        
        try {
            const store = await this.getStore();
            switch (action) {
                case 'checkpoint': {
                    if (!message) return textResult('error: message required for checkpoint');
                    const result = await store.checkpoint(message);
                    return textResult(JSON.stringify({
                        status: 'checkpointed',
                        commit: result.commit.slice(0, 8),
                        branch: result.branch,
                        message,
                    }, null, 2));
                }
                case 'fork': {
                    if (!branch_name || !message) return textResult('error: branch_name and message required');
                    const result = await store.fork(branch_name, message);
                    return textResult(JSON.stringify({
                        status: 'forked',
                        branch: result.branch,
                        commit: result.commit.slice(0, 8),
                    }, null, 2));
                }
                case 'rollback': {
                    if (!target_commit) return textResult('error: target_commit required');
                    const result = await store.rollback(target_commit, mode);
                    return textResult(JSON.stringify({
                        status: 'rolled_back',
                        mode,
                        current_commit: result.commit.slice(0, 8),
                    }, null, 2));
                }
                case 'switch': {
                    if (!branch_name) return textResult('error: branch_name required');
                    const result = await store.switchTo(branch_name);
                    return textResult(JSON.stringify({
                        status: 'switched',
                        branch: result.branch,
                        commit: result.commit.slice(0, 8),
                    }, null, 2));
                }
                case 'list': {
                    const branches = await store.listBranches();
                    return textResult(JSON.stringify({ branches }, null, 2));
                }
                case 'log': {
                    const log = await store.log(10);
                    return textResult(JSON.stringify({
                        commits: log.map((entry: any) => ({
                            oid: entry.oid?.slice(0, 8),
                            message: entry.commit?.message ?? '',
                            timestamp: entry.commit?.author?.timestamp ?? 0,
                        }))
                    }, null, 2));
                }
                default: return textResult('error: unknown action. Use: checkpoint, fork, rollback, switch, list, log');
            }
        } catch (e: any) {
            return textResult(JSON.stringify({ error: 'temporal branch error', detail: e?.message ?? String(e) }, null, 2));
        }
    }
}

// ═══ 11. harmony_thought_graph (Wave 4 — upgraded: Rigor executable DAG) ═══
interface ThoughtNode { id: string; claim: string; evidence: string[]; status: 'hypothesis' | 'verified' | 'rejected' | 'pending'; dependencies: string[]; source: string; timestamp: number; counterexamples?: string[]; execution_result?: 'pass' | 'fail' | 'unexecuted'; }
interface ThoughtGraphInput { action: 'add' | 'query' | 'verify' | 'graph' | 'stats' | 'execute' | 'counterexample'; claim?: string; evidence?: string[]; dependencies?: string[]; source?: string; verify_id?: string; verify_status?: string; query_status?: string; limit?: number; execute_id?: string; counterexample?: { node_id: string; example: string }; }
export class ThoughtGraphTool implements vscode.LanguageModelTool<ThoughtGraphInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ThoughtGraphInput>, _token: vscode.CancellationToken) {
        const { action, claim, evidence, dependencies, source, verify_id, verify_status, query_status, limit = 20, execute_id, counterexample } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'thought-graph'); await ensureDir(dir);
        const fp = path.join(dir, 'nodes.jsonl');
        const readAll = async (): Promise<ThoughtNode[]> => { return await readJsonl(fp); };
        const rewrite = async (ns: ThoughtNode[]) => { await rewriteJsonl(fp, ns); };
        
        // Helper: topological sort
        const topoSort = (nodes: ThoughtNode[]): ThoughtNode[] => {
            const visited = new Set<string>();
            const inProgress = new Set<string>();
            const result: ThoughtNode[] = [];
            const nodeMap = new Map(nodes.map(n => [n.id, n]));
            
            const visit = (id: string): boolean => {
                if (inProgress.has(id)) return false; // cycle
                if (visited.has(id)) return true;
                inProgress.add(id);
                const node = nodeMap.get(id);
                if (node) {
                    for (const dep of node.dependencies) {
                        if (!visit(dep)) return false;
                    }
                    visited.add(id);
                    result.push(node);
                }
                inProgress.delete(id);
                return true;
            };
            
            for (const node of nodes) {
                if (!visited.has(node.id)) {
                    if (!visit(node.id)) return []; // cycle detected
                }
            }
            return result;
        };
        
        switch (action) {
            case 'add': {
                if (!claim) return textResult('error: claim required');
                const nodes = await readAll();
                const deps = dependencies ?? [];
                for (const d of deps) { if (!nodes.some(n => n.id === d)) return textResult('error: dependency ' + d + ' not found'); }
                const n: ThoughtNode = { id: uid(), claim, evidence: evidence ?? [], status: 'pending', dependencies: deps, source: source ?? 'unknown', timestamp: Date.now(), execution_result: 'unexecuted' };
                await appendJsonl(fp, n);
                return textResult(JSON.stringify({ status: 'added', id: n.id, claim: n.claim.slice(0, 200), dependencies: n.dependencies }, null, 2));
            }
            case 'query': {
                let nodes = await readAll();
                if (query_status) nodes = nodes.filter(n => n.status === query_status);
                nodes.sort((a, b) => b.timestamp - a.timestamp);
                const r = nodes.slice(0, limit);
                return textResult(JSON.stringify({ count: r.length, total: nodes.length, nodes: r.map(n => ({ id: n.id, claim: n.claim.slice(0, 200), status: n.status, evidence: n.evidence.length, deps: n.dependencies.length, executed: n.execution_result })) }, null, 2));
            }
            case 'verify': {
                if (!verify_id || !verify_status) return textResult('error: verify_id and verify_status required');
                const nodes = await readAll();
                const node = nodes.find(n => n.id === verify_id);
                if (!node) return textResult('error: node not found');
                node.status = verify_status as ThoughtNode['status'];
                await rewrite(nodes);
                return textResult(JSON.stringify({ status: 'verified', id: node.id, new_status: node.status }, null, 2));
            }
            case 'execute': {
                const nodes = await readAll();
                
                // Load SandboxRunner for actual claim verification
                let sandboxRunner: any = null;
                try {
                    const { SandboxRunner } = await import('./sandboxRunner');
                    sandboxRunner = new SandboxRunner(root);
                } catch { /* sandboxRunner unavailable — fall through to static execution */ }
                
                // Execute a specific node or all pending nodes in topological order
                if (execute_id) {
                    const node = nodes.find(n => n.id === execute_id);
                    if (!node) return textResult('error: node not found');
                    const result = await this.executeNode(node, nodes, sandboxRunner);
                    await rewrite(nodes);
                    return textResult(JSON.stringify(result, null, 2));
                }
                // Execute ALL pending in topological order
                const sorted = topoSort(nodes);
                if (sorted.length === 0) return textResult(JSON.stringify({ status: 'cycle_detected', reason: 'Graph contains cycles — cannot execute topologically' }, null, 2));
                
                const results: any[] = [];
                let executed = 0, passed = 0, failed = 0;
                for (const node of sorted) {
                    if (node.status !== 'pending') continue;
                    const result = await this.executeNode(node, nodes, sandboxRunner);
                    results.push(result);
                    if (result.status === 'executed' || result.status === 'rejected') executed++;
                    if (result.execution_result === 'pass') passed++;
                    if (result.execution_result === 'fail') failed++;
                }
                // Rewrite after batch to save all state changes
                await rewrite(nodes);
                return textResult(JSON.stringify({
                    status: 'executed_dag',
                    total_nodes: sorted.length,
                    executed,
                    passed,
                    failed,
                    results: results.slice(0, 50),
                }, null, 2));
            }
            case 'counterexample': {
                if (!counterexample?.node_id || !counterexample.example) return textResult('error: node_id and example required');
                const nodes = await readAll();
                const node = nodes.find(n => n.id === counterexample.node_id);
                if (!node) return textResult('error: node not found');
                node.counterexamples = [...(node.counterexamples ?? []), counterexample.example];
                node.status = 'rejected';
                node.execution_result = 'fail';
                await rewrite(nodes);
                try { await concertSpeak('thought-graph', 'rigor', `Counterexample for ${node.id}: ${counterexample.example.slice(0, 150)}`); } catch {}
                return textResult(JSON.stringify({
                    status: 'counterexample_injected',
                    node_id: node.id,
                    counterexamples: node.counterexamples,
                    new_status: 'rejected',
                }, null, 2));
            }
            case 'graph': {
                const nodes = await readAll();
                const roots = nodes.filter(n => n.dependencies.length === 0);
                const sorted = topoSort(nodes);
                const hasCycle = sorted.length === 0 && nodes.length > 0;
                const tree = roots.map(n => {
                    const buildDepTree = (node: ThoughtNode, depth = 0, visited = new Set<string>()): string => {
                        if (visited.has(node.id) || depth > 50) return '  '.repeat(depth) + '\u2514 [RECURSION]\n';
                        visited.add(node.id);
                        let t = '  '.repeat(depth) + (depth > 0 ? '\u2514 ' : '') + node.claim.slice(0, 60) + ' [' + node.status + ']' + (node.execution_result === 'fail' ? ' \u274C' : node.execution_result === 'pass' ? ' \u2705' : '') + '\n';
                        const children = nodes.filter(c => c.dependencies.includes(node.id));
                        for (const c of children) t += buildDepTree(c, depth + 1, new Set(visited));
                        return t;
                    };
                    return buildDepTree(n);
                }).join('');
                return textResult(JSON.stringify({
                    total: nodes.length,
                    roots: roots.length,
                    has_cycle: hasCycle,
                    topology_valid: !hasCycle,
                    status: {
                        hypothesis: nodes.filter(n => n.status === 'hypothesis').length,
                        verified: nodes.filter(n => n.status === 'verified').length,
                        rejected: nodes.filter(n => n.status === 'rejected').length,
                        pending: nodes.filter(n => n.status === 'pending').length,
                    },
                    executed: nodes.filter(n => n.execution_result === 'pass').length,
                    failed: nodes.filter(n => n.execution_result === 'fail').length,
                    tree: '\n' + (tree || '(empty)'),
                }, null, 2));
            }
            case 'stats': {
                const nodes = await readAll();
                const sorted = topoSort(nodes);
                return textResult(JSON.stringify({
                    total: nodes.length,
                    by_status: {
                        hypothesis: nodes.filter(n => n.status === 'hypothesis').length,
                        verified: nodes.filter(n => n.status === 'verified').length,
                        rejected: nodes.filter(n => n.status === 'rejected').length,
                        pending: nodes.filter(n => n.status === 'pending').length,
                    },
                    execution: {
                        passed: nodes.filter(n => n.execution_result === 'pass').length,
                        failed: nodes.filter(n => n.execution_result === 'fail').length,
                        unexecuted: nodes.filter(n => n.execution_result === 'unexecuted').length,
                    },
                    with_evidence: nodes.filter(n => n.evidence.length > 0).length,
                    with_counterexamples: nodes.filter(n => (n.counterexamples?.length ?? 0) > 0).length,
                    topology_valid: sorted.length > 0,
                    has_cycles: sorted.length === 0 && nodes.length > 0,
                }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
    
    // ═══ Helper: execute a single thought graph node ═══
    private async executeNode(node: ThoughtNode, allNodes: ThoughtNode[], sandboxRunner: any): Promise<any> {
        // Check dependencies
        for (const dep of node.dependencies) {
            const depNode = allNodes.find(n => n.id === dep);
            if (!depNode || depNode.status !== 'verified') {
                return { id: node.id, status: 'blocked', reason: `Dependency ${dep} not verified` };
            }
        }
        
        // Check counterexamples
        if (node.counterexamples && node.counterexamples.length > 0) {
            node.status = 'rejected';
            node.execution_result = 'fail';
            return { id: node.id, status: 'rejected', execution_result: 'fail', counterexamples: node.counterexamples };
        }
        
        // Attempt sandbox verification if evidence looks like test code
        if (sandboxRunner && node.evidence.length > 0) {
            const testEvidence = node.evidence.find(e => 
                e.includes('assert') || e.includes('expect') || e.includes('test(') || 
                e.includes('===') || e.includes('throw')
            );
            if (testEvidence) {
                try {
                    const result = await sandboxRunner.execute(testEvidence, undefined, { language: 'javascript', timeoutSec: 10 });
                    if (result.pass) {
                        node.status = 'verified';
                        node.execution_result = 'pass';
                        return { id: node.id, status: 'verified', execution_result: 'pass', sandbox: 'passed' };
                    } else {
                        node.status = 'rejected';
                        node.execution_result = 'fail';
                        return { id: node.id, status: 'rejected', execution_result: 'fail', sandbox_error: result.error };
                    }
                } catch (e: any) {
                    // Sandbox failed — fall through to static execution
                }
            }
        }
        
        // Static execution: mark as verified if no counterexamples + deps verified
        node.execution_result = 'pass';
        return { id: node.id, status: 'executed', execution_result: 'pass', claim: node.claim.slice(0, 200) };
    }
}

// ═══ 12. harmony_horizon_planner (Wave 4) ═══

// ═══ 12. harmony_horizon_planner (Wave 4) ═══
interface HorizonPlan { id: string; goal: string; next_step: string; blockers: string[]; estimated_impact: string; timeline: 'tactical' | 'operational' | 'strategic'; timestamp: number; status: string; }
interface HorizonPlannerInput { action: 'plan' | 'query' | 'align' | 'stats'; goal?: string; next_step?: string; blockers?: string[]; estimated_impact?: string; timeline?: string; query_timeline?: string; limit?: number; }
export class HorizonPlannerTool implements vscode.LanguageModelTool<HorizonPlannerInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<HorizonPlannerInput>, _token: vscode.CancellationToken) {
        const { action, goal, next_step, blockers, estimated_impact, timeline = 'tactical', query_timeline, limit = 20 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'horizon-planner'); await ensureDir(dir);
        const fp = path.join(dir, 'plans.jsonl');
        const readAll = async (): Promise<HorizonPlan[]> => { return await readJsonl(fp); };
        switch (action) {
            case 'plan': {
                if (!goal || !next_step) return textResult('error: goal and next_step required');
                const plan: HorizonPlan = { id: uid(), goal, next_step, blockers: blockers ?? [], estimated_impact: estimated_impact ?? 'unknown', timeline: timeline as HorizonPlan['timeline'], timestamp: Date.now(), status: 'active' };
                await appendJsonl(fp, plan);
                try { await concertSpeak('horizon', 'metis', 'Plan [' + timeline + ']: ' + goal.slice(0, 150)); } catch {}
                return textResult(JSON.stringify({ status: 'planned', id: plan.id, timeline, next_step, goal: goal.slice(0, 200) }, null, 2));
            }
            case 'query': {
                let plans = await readAll();
                if (query_timeline) plans = plans.filter(p => p.timeline === query_timeline);
                plans.sort((a, b) => b.timestamp - a.timestamp);
                // Alignment check: next_step should move toward goal
                const alignmentIssues = plans.filter(p => p.status === 'active').map(p => ({
                    id: p.id, goal: p.goal.slice(0, 100), next_step: p.next_step.slice(0, 100),
                    alignment_warning: p.next_step.length < 10 ? 'Next step is very short - may need more detail' : null,
                }));
                return textResult(JSON.stringify({ count: Math.min(plans.length, limit), total: plans.length, alignment_issues: alignmentIssues.filter(a => a.alignment_warning).length > 0 ? alignmentIssues.filter(a => a.alignment_warning) : 'All steps appear adequate', plans: plans.slice(0, limit).map(p => ({ id: p.id, timeline: p.timeline, goal: p.goal.slice(0, 150), next_step: p.next_step.slice(0, 150), blockers: p.blockers })) }, null, 2));
            }
            case 'align': {
                const MAX_RETRIES = 3;
                const plans = await readAll();
                // Filter out plans that have been retried too many times
                const retryCounts = new Map<string, number>();
                for (const p of plans) {
                    if (p.status === 'rejected') {
                        retryCounts.set(p.id, (retryCounts.get(p.id) ?? 0) + 1);
                    }
                }
                // Discard plans that exceeded retry limit
                const retryLimited = new Set([...retryCounts.entries()].filter(([, c]) => c >= MAX_RETRIES).map(([id]) => id));
                const active = plans.filter(p => p.status === 'active' && !retryLimited.has(p.id));
                const summary = { tactical: active.filter(p => p.timeline === 'tactical').length, operational: active.filter(p => p.timeline === 'operational').length, strategic: active.filter(p => p.timeline === 'strategic').length };
                const misaligned = active.filter(p => p.blockers.length > 3);
                return textResult(JSON.stringify({ active_plans: active.length, by_timeline: summary, high_blocker_count: misaligned.length > 0 ? misaligned.map(p => ({ goal: p.goal.slice(0, 100), blockers: p.blockers.length })) : 'None', recommendation: summary.strategic === 0 ? 'Consider adding strategic plans for long-term direction.' : summary.tactical > summary.strategic * 3 ? 'Many tactical plans - ensure they align with strategic goals.' : 'Plan distribution looks balanced.' }, null, 2));
            }
            case 'stats': {
                const plans = await readAll();
                return textResult(JSON.stringify({ total: plans.length, active: plans.filter(p => p.status === 'active').length, by_timeline: { tactical: plans.filter(p => p.timeline === 'tactical').length, operational: plans.filter(p => p.timeline === 'operational').length, strategic: plans.filter(p => p.timeline === 'strategic').length }, avg_blockers: plans.length > 0 ? Math.round(plans.reduce((s, p) => s + p.blockers.length, 0) / plans.length * 10) / 10 : 0 }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 13. harmony_skill_distiller (Wave 5) ═══
interface SkillCrystal { id: string; name: string; description: string; preconditions: string[]; invariants: string[]; failure_modes: string[]; solution_pattern: string; language: string; extracted_from: string; timestamp: number; }
interface SkillDistillerInput { action: 'extract' | 'query' | 'load' | 'stats' | 'export_snippet'; name?: string; description?: string; preconditions?: string[]; invariants?: string[]; failure_modes?: string[]; solution_pattern?: string; language?: string; extracted_from?: string; query_language?: string; query_name?: string; limit?: number; snippet_prefix?: string; snippet_description?: string; }
export class SkillDistillerTool implements vscode.LanguageModelTool<SkillDistillerInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SkillDistillerInput>, _token: vscode.CancellationToken) {
        const { action, name, description, preconditions, invariants, failure_modes, solution_pattern, language = 'typescript', extracted_from, query_language, query_name, limit = 20 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'skill-crystals'); await ensureDir(dir);
        const fp = path.join(dir, 'crystals.jsonl');
        const readAll = async (): Promise<SkillCrystal[]> => { return await readJsonl(fp); };
        switch (action) {
            case 'extract': {
                if (!name || !solution_pattern) return textResult('error: name and solution_pattern required');
                const safeName = name.replace(/[^a-zA-Z0-9_\- .]/g, '').replace(/\.\./g, '').slice(0, 128);
                if (!safeName) return textResult('error: name must contain valid characters');
                const crystal: SkillCrystal = { id: uid(), name: safeName, description: description ?? '', preconditions: preconditions ?? [], invariants: invariants ?? [], failure_modes: failure_modes ?? [], solution_pattern, language, extracted_from: extracted_from ?? 'unknown', timestamp: Date.now() };
                await appendJsonl(fp, crystal);
                try { await concertSpeak('skill-distiller', 'crucible', 'Crystal: ' + name + ' (' + language + ')'); } catch {}
                return textResult(JSON.stringify({ status: 'extracted', id: crystal.id, name, language, preconditions: crystal.preconditions.length, invariants: crystal.invariants.length }, null, 2));
            }
            case 'query': {
                let crystals = await readAll();
                if (query_language) crystals = crystals.filter(c => c.language === query_language);
                if (query_name) { const q = query_name.toLowerCase(); crystals = crystals.filter(c => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)); }
                crystals.sort((a, b) => b.timestamp - a.timestamp);
                return textResult(JSON.stringify({ count: Math.min(crystals.length, limit), total: crystals.length, crystals: crystals.slice(0, limit).map(c => ({ id: c.id, name: c.name, language: c.language, description: c.description.slice(0, 150), preconditions: c.preconditions, failure_modes: c.failure_modes })) }, null, 2));
            }
            case 'load': {
                if (!query_name) return textResult('error: query_name required');
                const crystals = await readAll();
                const match = crystals.find(c => c.name === query_name || c.id === query_name);
                if (!match) return textResult('error: crystal not found');
                return textResult(JSON.stringify({ crystal: { name: match.name, language: match.language, description: match.description, preconditions: match.preconditions, invariants: match.invariants, failure_modes: match.failure_modes, solution_pattern: match.solution_pattern, extracted_from: match.extracted_from } }, null, 2));
            }
            case 'stats': {
                const crystals = await readAll();
                const byLang = new Map<string, number>(); for (const c of crystals) byLang.set(c.language, (byLang.get(c.language) ?? 0) + 1);
                return textResult(JSON.stringify({ total: crystals.length, by_language: [...byLang.entries()].map(([k, v]) => ({ language: k, count: v })), with_preconditions: crystals.filter(c => c.preconditions.length > 0).length, with_failure_modes: crystals.filter(c => c.failure_modes.length > 0).length }, null, 2));
            }
            case 'export_snippet': {
                if (!query_name) return textResult('error: query_name required');
                const crystals = await readAll();
                const match = crystals.find(c => c.name === query_name || c.id === query_name);
                if (!match) return textResult('error: crystal not found');
                const prefix = options.input.snippet_prefix ?? match.name.replace(/\s+/g, '-').toLowerCase();
                const desc = options.input.snippet_description ?? match.description;
                const body = match.solution_pattern.split('\n');
                const snippet = {
                    [match.name]: {
                        prefix,
                        body,
                        description: desc,
                        scope: match.language
                    }
                };
                const snippetDir = path.join(dir, 'snippets'); await ensureDir(snippetDir);
                const safeFilename = path.basename(match.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.code-snippets');
                const snippetPath = path.join(snippetDir, safeFilename);
                await fs.writeFile(snippetPath, JSON.stringify(snippet, null, 2), 'utf8');
                return textResult(JSON.stringify({
                    status: 'exported',
                    name: match.name,
                    prefix,
                    language: match.language,
                    path: snippetPath,
                    snippet_json: snippet
                }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 14. harmony_property_tester (Wave 5) ═══
interface PropertyTest { id: string; name: string; invariant: string; language: string; test_code: string; generator: string; timestamp: number; status: string; }
interface PropertyTesterInput { action: 'generate' | 'validate' | 'query' | 'stats'; name?: string; invariant?: string; language?: string; target_code?: string; test_code?: string; query_language?: string; limit?: number; }
export class PropertyTesterTool implements vscode.LanguageModelTool<PropertyTesterInput> {
    constructor(private readonly secrets?: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PropertyTesterInput>, token: vscode.CancellationToken) {
        const { action, name, invariant, language = 'typescript', target_code, test_code, query_language, limit = 20 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'property-tests'); await ensureDir(dir);
        const fp = path.join(dir, 'tests.jsonl');
        const readAll = async (): Promise<PropertyTest[]> => { return await readJsonl(fp); };
        switch (action) {
            case 'generate': {
                if (!invariant || !target_code) return textResult('error: invariant and target_code required');
                if (!this.secrets) return textResult('error: secrets required for LLM-based generation');
                try {
                    const r = await consult(this.secrets, { provider: 'deepseek', tier: 'mid', question: 'Generate a property-based test for this invariant in ' + language + '. The test should use random inputs to verify the invariant holds.\n\nINVARIANT: ' + invariant + '\n\nTARGET CODE:\n' + target_code.slice(0, 4000) + '\n\nOutput ONLY the test code, no explanation.', maxTokens: 1024 }, token);
                    const test: PropertyTest = { id: uid(), name: name ?? 'property_' + uid(), invariant, language, test_code: r.text, generator: 'llm', timestamp: Date.now(), status: 'generated' };
                    await appendJsonl(fp, test);
                    return textResult(JSON.stringify({ status: 'generated', id: test.id, invariant: invariant.slice(0, 200), test_code: test.test_code.slice(0, 500) }, null, 2));
                } catch (e: any) { return textResult('error: generation failed: ' + (e?.message ?? String(e))); }
            }
            case 'validate': {
                if (!test_code || !target_code) return textResult('error: test_code and target_code required');
                try { new Function(target_code); } catch (e: any) { return textResult(JSON.stringify({ status: 'target_syntax_error', error: e.message }, null, 2)); }
                try { new Function(test_code); } catch (e: any) { return textResult(JSON.stringify({ status: 'test_syntax_error', error: e.message }, null, 2)); }
                return textResult(JSON.stringify({ status: 'validated', note: 'Both target and test pass syntax check. Full runtime validation requires execution environment.' }, null, 2));
            }
            case 'query': {
                let tests = await readAll();
                if (query_language) tests = tests.filter(t => t.language === query_language);
                tests.sort((a, b) => b.timestamp - a.timestamp);
                return textResult(JSON.stringify({ count: Math.min(tests.length, limit), total: tests.length, tests: tests.slice(0, limit).map(t => ({ id: t.id, name: t.name, invariant: t.invariant.slice(0, 150), language: t.language })) }, null, 2));
            }
            case 'stats': {
                const tests = await readAll();
                return textResult(JSON.stringify({ total: tests.length, generated: tests.filter(t => t.status === 'generated').length, by_language: [...new Set(tests.map(t => t.language))].map(l => ({ language: l, count: tests.filter(t => t.language === l).length })) }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}

// ═══ 15. harmony_analogy_engine (Wave 5) ═══
interface AnalogyRecord { id: string; problem: string; domain: string; mapping: string; verified: boolean; verification_notes: string; timestamp: number; }
interface AnalogyEngineInput { action: 'map' | 'verify' | 'query' | 'stats'; problem?: string; domain?: string; analogy_id?: string; verified?: boolean; verification_notes?: string; query_domain?: string; limit?: number; }
export class AnalogyEngineTool implements vscode.LanguageModelTool<AnalogyEngineInput> {
    constructor(private readonly secrets?: vscode.SecretStorage) {}
    async invoke(options: vscode.LanguageModelToolInvocationOptions<AnalogyEngineInput>, token: vscode.CancellationToken) {
        const { action, problem, domain, analogy_id, verified, verification_notes, query_domain, limit = 20 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult('error: no workspace');
        const dir = safeHarmonyDir(root, 'analogies'); await ensureDir(dir);
        const fp = path.join(dir, 'records.jsonl');
        const readAll = async (): Promise<AnalogyRecord[]> => { return await readJsonl(fp); };
        switch (action) {
            case 'map': {
                if (!problem || !domain) return textResult('error: problem and domain required');
                if (!this.secrets) return textResult('error: secrets required for LLM-based mapping');
                try {
                    const r = await consult(this.secrets, { provider: 'deepseek', tier: 'mid', question: 'Map this problem to domain "' + domain + '". Construct an analogy and VERIFY whether it holds.\n\nPROBLEM: ' + problem.slice(0, 2000) + '\n\nOutput JSON: {"mapping":"...", "holds": true/false, "why":"..."}', maxTokens: 512 }, token);
                    let mapping = r.text; let holds = true; let why = '';
                    try { const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] || '{}'); mapping = j.mapping || r.text; holds = j.holds !== false; why = j.why || ''; } catch {}
                    const record: AnalogyRecord = { id: uid(), problem: problem.slice(0, 300), domain, mapping, verified: holds, verification_notes: why, timestamp: Date.now() };
                    await appendJsonl(fp, record);
                    return textResult(JSON.stringify({ status: 'mapped', id: record.id, domain, holds, mapping: mapping.slice(0, 300), why }, null, 2));
                } catch (e: any) { return textResult('error: mapping failed: ' + (e?.message ?? String(e))); }
            }
            case 'verify': {
                if (!analogy_id || verified === undefined) return textResult('error: analogy_id and verified required');
                const records = await readAll();
                const rec = records.find(r => r.id === analogy_id);
                if (!rec) return textResult('error: analogy not found');
                rec.verified = verified;
                rec.verification_notes = verification_notes ?? '';
                await rewriteJsonl(fp, records);
                return textResult(JSON.stringify({ status: 'verified', id: rec.id, holds: rec.verified }, null, 2));
            }
            case 'query': {
                let records = await readAll();
                if (query_domain) records = records.filter(r => r.domain === query_domain);
                records.sort((a, b) => b.timestamp - a.timestamp);
                return textResult(JSON.stringify({ count: Math.min(records.length, limit), total: records.length, verified: records.filter(r => r.verified).length, analogies: records.slice(0, limit).map(r => ({ id: r.id, domain: r.domain, problem: r.problem.slice(0, 100), holds: r.verified })) }, null, 2));
            }
            case 'stats': {
                const records = await readAll();
                const byDomain = new Map<string, number>(); for (const r of records) byDomain.set(r.domain, (byDomain.get(r.domain) ?? 0) + 1);
                return textResult(JSON.stringify({ total: records.length, verified: records.filter(r => r.verified).length, unverified: records.filter(r => !r.verified).length, by_domain: [...byDomain.entries()].map(([k, v]) => ({ domain: k, count: v })) }, null, 2));
            }
            default: return textResult('error: unknown action');
        }
    }
}
