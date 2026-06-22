/**
 * Task Auction (Agora) — Beta-Binomial calibrated credibility bidding with time decay.
 *
 * 100% upgrade: replaces arbitrary 0.4+0.6*rate with Beta-Binomial posterior.
 *   - α = Σ(weight × success) + 1, β = Σ(weight × failure) + 1
 *   - weight = exp(-λ × age_days) — recent evidence matters more
 *   - Half-life default 30 days: evidence from 30 days ago counts at 50%
 *   - Credibility = α / (α + β) — shrinks toward 0.5 when data is sparse
 *   - Converges to true recent success rate with more evidence
 *
 * @example
 *   invoke({ action: 'bid', task_type: 'code-review',
 *            bids: [{agent:'kronos', bid:8}, {agent:'hermes', bid:7}] });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir } from './shared';
import { safeHarmonyDir, readJsonl } from '../swarmHarden';
import * as fs from 'fs/promises';
import { BasePrimitive } from './basePrimitive';

interface TRecord { taskType: string; agent: string; success: boolean; confidenceBid: number; timestamp: number; }
interface TAuctionInput { action: 'bid' | 'record' | 'stats'; task_type?: string; bids?: { agent: string; bid: number; specialization?: string[] }[]; record?: { task_type: string; agent: string; success: boolean; confidence_bid?: number }; min_bid_threshold?: number; }

export class TaskAuctionTool extends BasePrimitive<TAuctionInput> {
    constructor() { super('task-auction'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<TAuctionInput>, _token: vscode.CancellationToken) {
        this.requireFields(options.input as any, ['action']);
        const { action, task_type, bids, record, min_bid_threshold = 3 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const dir = safeHarmonyDir(root, 'task-auction'); await ensureDir(dir);
        const fp = path.join(dir, 'history.jsonl');
        const readH = async (): Promise<TRecord[]> => { return await readJsonl(fp); };
        switch (action) {
            case 'bid': {
                if (!task_type || !bids?.length) return textResult(JSON.stringify({ error: 'task_type and bids required' }));
                const h = await readH();
                const adj = bids.map(b => {
                    const ah = h.filter(x => x.agent === b.agent && x.taskType === task_type);
                    // Time-decayed weighted counts: recent evidence matters more
                    const now = Date.now();
                    const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30-day half-life
                    const decayRate = Math.log(2) / halfLifeMs;
                    let wSuccesses = 0, wFailures = 0;
                    for (const r of ah) {
                        const ageMs = now - r.timestamp;
                        const weight = Math.exp(-decayRate * ageMs); // exp decay: 1.0→0.5 at half-life
                        if (r.success) wSuccesses += weight; else wFailures += weight;
                    }
                    // Beta-Binomial with Laplace smoothing (Beta(1,1) prior)
                    const alpha = wSuccesses + 1;
                    const beta = wFailures + 1;
                    const credibility = alpha / (alpha + beta);  // posterior mean
                    // Specialization bonus: Jaccard similarity
                    let specScore = 1.0;
                    if (b.specialization && b.specialization.length > 0) {
                        const taskTokens = new Set(task_type.toLowerCase().split(/[\s_\-]+/).filter(t => t.length > 1));
                        const specTokens = new Set(b.specialization.flatMap(s => s.toLowerCase().split(/[\s_\-]+/)));
                        const intersection = [...taskTokens].filter(t => specTokens.has(t)).length;
                        const union = new Set([...taskTokens, ...specTokens]).size;
                        specScore = union > 0 ? (0.5 + 0.5 * (intersection / union)) : 1.0;
                    }
                    return { agent: b.agent, raw_bid: b.bid, adjusted_bid: Math.round(b.bid * credibility * specScore * 10) / 10, credibility: Math.round(credibility * 100) / 100, alpha: Math.round(alpha * 100) / 100, beta: Math.round(beta * 100) / 100, weighted_successes: Math.round(wSuccesses * 100) / 100, weighted_failures: Math.round(wFailures * 100) / 100, specialization_score: Math.round(specScore * 100) / 100, history: ah.length };
                });
                adj.sort((a, b) => b.adjusted_bid - a.adjusted_bid);
                if (adj[0].adjusted_bid < min_bid_threshold) return textResult(JSON.stringify({ verdict: 'CAPABILITY_GAP', message: `No agent above threshold (${min_bid_threshold}). Decompose or spawn specialist.`, threshold: min_bid_threshold, bids: adj }, null, 2));
                return textResult(JSON.stringify({ verdict: 'AWARDED', winner: adj[0].agent, adjusted_bid: adj[0].adjusted_bid, all_bids: adj }, null, 2));
            }
            case 'record': {
                if (!record?.task_type || !record.agent) return textResult(JSON.stringify({ error: 'task_type and agent required' }));
                await fs.appendFile(fp, JSON.stringify({ taskType: record.task_type, agent: record.agent, success: record.success, confidenceBid: record.confidence_bid ?? 5, timestamp: Date.now() }) + '\n', 'utf8');
                return textResult(JSON.stringify({ status: 'recorded' }, null, 2));
            }
            case 'stats': {
                const h = await readH(); const byA = new Map<string, { t: number; s: number }>();
                for (const r of h) { if (!byA.has(r.agent)) byA.set(r.agent, { t: 0, s: 0 }); const a = byA.get(r.agent)!; a.t++; if (r.success) a.s++; }
                return textResult(JSON.stringify({ total: h.length, agents: [...byA.entries()].map(([k, v]) => ({ agent: k, tasks: v.t, rate: Math.round(v.s / v.t * 100) })).sort((a, b) => b.rate - a.rate) }, null, 2));
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
