/** Decision Log (Threadweave) — Causal reasoning store
 *
 * @example
 *   invoke({ action: 'log', decision: 'Use DuckDB', rationale: 'ACID + performance', options: ['SQLite','DuckDB','JSONL'] });
 *   invoke({ action: 'query', limit: 10 });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir, appendJsonl, readJsonl } from '../swarmHarden';
import { concertSpeak } from '../concertHall';
import { BasePrimitive } from './basePrimitive';

interface DNode { id: string; parent_ids: string[]; timestamp: number; agent: string; decision: string; premises: string[]; alternatives: string[]; rationale: string; status: string; context?: string; }
interface DLogInput { action: 'append' | 'query' | 'graph' | 'stats'; append?: { decision: string; premises?: string[]; alternatives?: string[]; rationale?: string; parent_ids?: string[]; agent?: string; status?: string; context?: string }; query?: { parent_id?: string; agent?: string; status?: string; since_hours?: number; keyword?: string; limit?: number }; root_id?: string; max_depth?: number; }

function buildTree(nodes: DNode[], nid: string, prefix = '', last = true, depth = 0, maxD = 5): string {
    if (depth >= maxD) return ''; const n = nodes.find(x => x.id === nid); if (!n) return '';
    let t = prefix + (last ? '\u2514\u2500\u2500 ' : '\u250c\u2500\u2500 ') + n.decision.slice(0, 80) + ' [' + n.status + '] (' + n.agent + ')\n';
    const ch = nodes.filter(x => x.parent_ids.includes(nid));
    for (let i = 0; i < ch.length; i++) t += buildTree(nodes, ch[i].id, prefix + (last ? '    ' : '\u2502   '), i === ch.length - 1, depth + 1, maxD);
    return t;
}

export class DecisionLogTool extends BasePrimitive<DLogInput> {
    constructor() { super('decision-log'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<DLogInput>, _token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action, append, query, root_id, max_depth = 5 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const dir = safeHarmonyDir(root, 'decision-log'); await ensureDir(dir);
        const fp = path.join(dir, 'decisions.jsonl');
        const readAll = async (): Promise<DNode[]> => { return await readJsonl(fp); };
        // Filtered read: iterates all entries, applies filters in single pass (memory-efficient for time-based queries)
        const readFiltered = async (filter: (n: DNode) => boolean, maxAgeHours?: number): Promise<DNode[]> => {
            const results: DNode[] = [];
            const cutoff = maxAgeHours ? Date.now() - maxAgeHours * 3600 * 1000 : 0;
            try {
                const raw = await readJsonl<DNode>(fp);
                for (const node of raw) {
                    if (maxAgeHours && node.timestamp < cutoff) continue;
                    if (filter(node)) results.push(node);
                }
            } catch { /* file doesn't exist yet */ }
            return results;
        };
        switch (action) {
            case 'append': {
                if (!append?.decision) return textResult(JSON.stringify({ error: 'decision required' }));
                const nodes = await readAll(); const pids = append.parent_ids ?? [];
                for (const p of pids) if (!nodes.some(n => n.id === p)) return textResult(JSON.stringify({ error: `parent ${p} not found` }));
                const n: DNode = { id: uid(), parent_ids: pids, timestamp: Date.now(), agent: append.agent ?? 'unknown', decision: append.decision, premises: append.premises ?? [], alternatives: append.alternatives ?? [], rationale: append.rationale ?? '', status: append.status ?? 'proposed', context: append.context };
                await appendJsonl(fp, n);
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
                try {
                    const nodes = await readAll();
                    const rid = root_id ?? nodes[0]?.id;
                    if (!rid) return textResult(JSON.stringify({ error: 'no decisions' }));
                    const tree = buildTree(nodes, rid, '', true, 0, max_depth ?? 5);
                    return textResult(JSON.stringify({ root_id: rid, total_nodes: nodes.length, tree, max_depth: max_depth ?? 5 }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'graph failed', detail: e.message })); }
            }
            case 'stats': {
                try {
                    const nodes = await readAll();
                    const byStatus: Record<string, number> = {}; for (const n of nodes) { byStatus[n.status] = (byStatus[n.status] || 0) + 1; }
                    const byAgent: Record<string, number> = {}; for (const n of nodes) { byAgent[n.agent] = (byAgent[n.agent] || 0) + 1; }
                    const avgPremises = nodes.length > 0 ? nodes.reduce((s, n) => s + n.premises.length, 0) / nodes.length : 0;
                    return textResult(JSON.stringify({ total_decisions: nodes.length, by_status: byStatus, by_agent: byAgent, avg_premises: Math.round(avgPremises * 10) / 10, oldest: nodes.length > 0 ? new Date(nodes[0].timestamp).toISOString() : 'none' }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'stats failed', detail: e.message })); }
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
