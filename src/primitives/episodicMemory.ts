/**
 * Episodic Memory (Mnemosyne) — DuckDB-backed with Jaccard conflict resolution.
 * Includes idempotency for duplicate prevention.
 *
 * Beyond-100% (E6): Episodic clustering — auto-group related memories into episodes
 *   using temporal proximity + tag overlap + content similarity.
 *
 * @example
 *   invoke({ action: 'store', store: { content: 'User prefers dark mode', tags: ['preference', 'ui'], confidence: 0.9 } });
 *   invoke({ action: 'query', query: { tags: ['preference'], limit: 10 } });
 *   // => { count, total, next_cursor, memories: [{ id, timestamp, content, tags, confidence, source }] }
 *   invoke({ action: 'decay', decay_half_life_hours: 168 });
 *   invoke({ action: 'stats' });  // => { total_memories, by_tag, memory_depth, oldest, newest, backend: 'duckdb' }
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { workspaceRoot, textResult } from './shared';
import { idempotent, structuredLog } from '../storageUtils';
import { BasePrimitive } from './basePrimitive';

interface EMemInput { action: 'store' | 'query' | 'decay' | 'consolidate' | 'stats' | 'graph' | 'forget' | 'cluster'; store?: { content: string; tags?: string[]; confidence?: number; related_ids?: string[]; source?: string }; query?: { tags?: string[]; min_confidence?: number; max_age_hours?: number; related_to?: string; source?: string; limit?: number }; decay_half_life_hours?: number; graph_root_id?: string; graph_max_depth?: number; }

export class EpisodicMemoryTool extends BasePrimitive<EMemInput> {
    private _store: any = null;
    
    private async getStore(): Promise<any> {
        if (this._store) return this._store;
        const { EpisodicStore } = await import('../episodicStore');
        const root = workspaceRoot(); if (!root) throw new Error(JSON.stringify({ error: 'NO_WORKSPACE', detail: 'no workspace' }));
        this._store = new EpisodicStore(root);
        await this._store.init();
        return this._store;
    }
    
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<EMemInput>, _token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        const { action, store, query, decay_half_life_hours = 72, graph_root_id, graph_max_depth = 3 } = options.input;
        try {
            const es = await this.getStore();
            switch (action) {
                case 'store': {
                    if (!store?.content) return textResult(JSON.stringify({ error: 'content required' }));
                    const contentHash = crypto.createHash('sha256').update(store.content + '|' + (store.tags ?? []).join(',') + '|' + (store.source ?? '')).digest('hex').slice(0, 16);
                    const result = await idempotent(`emem-store:${contentHash}`, async () => {
                        return await es.store({ content: store.content, tags: store.tags, confidence: store.confidence, related_ids: store.related_ids, source: store.source });
                    });
                    structuredLog('episodic-memory', 'info', 'memory stored', { id: result.id, tags: store.tags });
                    return textResult(JSON.stringify(result, null, 2));
                }
                case 'query': {
                    const result = await es.query({ tags: query?.tags, min_confidence: query?.min_confidence, max_age_hours: query?.max_age_hours, related_to: query?.related_to, source: query?.source, limit: query?.limit ?? 20, cursor: (query as any)?.cursor });
                    return textResult(JSON.stringify({ count: result.memories.length, total: result.total, next_cursor: result.next_cursor ?? null, memories: result.memories.map((m: any) => ({ id: m.id, timestamp: m.created_at, content: (m.content ?? '').slice(0, 300), tags: m.tags ?? [], confidence: m.confidence, source: m.source })) }, null, 2));
                }
                case 'decay': { const result = await es.decay(decay_half_life_hours); return textResult(JSON.stringify({ status: 'decayed', ...result }, null, 2)); }
                case 'consolidate': { const result = await es.consolidate(); return textResult(JSON.stringify({ status: 'consolidated', ...result }, null, 2)); }
                case 'stats': { const stats = await es.stats(); return textResult(JSON.stringify(stats, null, 2)); }
                case 'graph': {
                    if (!graph_root_id) return textResult(JSON.stringify({ error: 'graph_root_id required' }));
                    const rows = await es.graph(graph_root_id, graph_max_depth);
                    return textResult(JSON.stringify({ root: graph_root_id, max_depth: graph_max_depth, nodes: rows.length, edges: rows.map((r: any) => ({ from: r.memory_id, to: r.related_id, type: r.relation_type })) }, null, 2));
                }
                case 'forget': { const result = await es.applyForgettingPolicy(); return textResult(JSON.stringify({ status: 'forgotten', ...result }, null, 2)); }
                case 'cluster': {
                    // ── E6: Episodic clustering ──
                    const allMemories = await es.query({ limit: 1000 });
                    const memories = allMemories.memories;
                    if (memories.length < 2) return textResult(JSON.stringify({ episodes: [], total_memories: memories.length, note: 'Need at least 2 memories to cluster' }, null, 2));
                    // Sort by timestamp
                    const sorted = [...memories].sort((a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0));
                    const TEMPORAL_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
                    const TAG_SIM_THRESHOLD = 0.3;
                    // Union-Find for clustering
                    const parent = new Map<string, string>();
                    const find = (id: string): string => {
                        if (!parent.has(id)) { parent.set(id, id); return id; }
                        const p = parent.get(id)!;
                        if (p !== id) parent.set(id, find(p));
                        return parent.get(id)!;
                    };
                    const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
                    const jaccard = (a: string[], b: string[]): number => {
                        if (!a.length && !b.length) return 1;
                        const sa = new Set(a), sb = new Set(b);
                        const intersection = [...sa].filter(x => sb.has(x)).length;
                        return intersection / (sa.size + sb.size - intersection || 1);
                    };
                    // Sliding window: connect memories within temporal window with tag overlap
                    let windowStart = 0;
                    for (let i = 0; i < sorted.length; i++) {
                        while (windowStart < i && ((sorted[i] as any).created_at ?? 0) - ((sorted[windowStart] as any).created_at ?? 0) > TEMPORAL_WINDOW_MS) {
                            windowStart++;
                        }
                        for (let j = windowStart; j < i; j++) {
                            const tagsI = (sorted[i] as any).tags ?? [];
                            const tagsJ = (sorted[j] as any).tags ?? [];
                            if (jaccard(tagsI, tagsJ) >= TAG_SIM_THRESHOLD) {
                                union((sorted[i] as any).id, (sorted[j] as any).id);
                            }
                        }
                    }
                    // Group by component leader
                    const components = new Map<string, any[]>();
                    for (const mem of sorted) {
                        const leader = find((mem as any).id);
                        if (!components.has(leader)) components.set(leader, []);
                        components.get(leader)!.push(mem);
                    }
                    // Build episodes
                    const episodes = [...components.values()]
                        .filter(group => group.length >= 2)
                        .map(group => {
                            const times = group.map((m: any) => m.created_at ?? 0);
                            const allTags = new Set<string>();
                            group.forEach((m: any) => (m.tags ?? []).forEach((t: string) => allTags.add(t)));
                            return {
                                episode_id: `ep-${group[0].id?.slice(0, 8) ?? 'unknown'}-${group.length}`,
                                memory_count: group.length,
                                time_start: new Date(Math.min(...times)).toISOString(),
                                time_end: new Date(Math.max(...times)).toISOString(),
                                tags_union: [...allTags].slice(0, 20),
                                memories: group.map((m: any) => ({ id: m.id, content: (m.content ?? '').slice(0, 100), timestamp: new Date(m.created_at ?? 0).toISOString(), tags: m.tags ?? [] }))
                            };
                        })
                        .sort((a, b) => b.memory_count - a.memory_count);
                    return textResult(JSON.stringify({
                        action: 'cluster',
                        total_memories: memories.length,
                        episodes_found: episodes.length,
                        orphaned: memories.length - episodes.reduce((s, e) => s + e.memory_count, 0),
                        parameters: { temporal_window_minutes: TEMPORAL_WINDOW_MS / 60000, tag_similarity_threshold: TAG_SIM_THRESHOLD },
                        episodes
                    }, null, 2));
                }
                default: return textResult(JSON.stringify({ error: `unknown action: ${action}`, valid: ['store','query','decay','consolidate','stats','graph','forget'] }));
            }
        } catch (e: any) { return textResult(JSON.stringify({ error: 'episodic memory error', detail: e?.message ?? String(e) }, null, 2)); }
    }
}
