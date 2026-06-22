/**
 * Swarm Topology (Topos) — Communication graph configuration + agent registry.
 *
 * 100% upgrade: active agent registry with capability-based routing.
 *   - `register_agent`: register agent name + capabilities + endpoint
 *   - `resolve_routing`: find best agent for a task by capability match
 *   - `list_agents`: list all registered agents with capabilities
 *
 * @example
 *   invoke({ action: 'register_agent', agent_id: 'kronos-v1', capabilities: ['planning', 'reasoning'] });
 *   invoke({ action: 'resolve_routing', task: 'create a roadmap for the migration' });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { workspaceRoot, textResult, ensureDir } from './shared';
import { safeHarmonyDir, readJson, writeJson } from '../swarmHarden';
import { concertSpeak } from '../concertHall';
import { BasePrimitive } from './basePrimitive';

type Topology = 'star' | 'pipeline' | 'ring' | 'small_world';
const VALID_TOPOLOGIES: Topology[] = ['star', 'pipeline', 'ring', 'small_world'];

interface AgentEntry { agent_id: string; capabilities: string[]; endpoint?: string; registered_at: number; last_seen?: number; }
interface TopologyInput {
    action: 'configure' | 'status' | 'phase_transition' | 'register_agent' | 'resolve_routing' | 'list_agents' | 'evict_stale';
    topology?: Topology; phase?: string; reason?: string;
    agent_id?: string; capabilities?: string[]; endpoint?: string;
    task?: string; top_n?: number; stale_minutes?: number;
}

export class SwarmTopologyTool extends BasePrimitive<TopologyInput> {
    constructor() { super('swarm-topology'); }
    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<TopologyInput>, _token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action, topology = 'star', phase, reason, agent_id, capabilities, endpoint, task, top_n = 5 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const dir = safeHarmonyDir(root, 'topology'); await ensureDir(dir);
        const fp = path.join(dir, 'state.json');
        const agentsFp = path.join(dir, 'agents.json');
        const read = async (): Promise<any> => { return (await readJson(fp)) ?? { current: 'star', phases: [] }; };
        const readAgents = async (): Promise<AgentEntry[]> => { return (await readJson(agentsFp)) ?? []; };
        const rules: Record<Topology, string> = { star: 'Hub-and-spoke: one lead, fan-out to workers.', pipeline: 'Sequential handoff.', ring: 'Consensus rounds.', small_world: 'High clustering, short paths.' };
        switch (action) {
            case 'configure': { if (!VALID_TOPOLOGIES.includes(topology)) return textResult(JSON.stringify({ error: `invalid topology '${topology}'`, valid: VALID_TOPOLOGIES })); const state = await read(); state.current = topology; if (phase) state.phases.push({ topology, phase, reason, timestamp: Date.now() }); await writeJson(fp, state); return textResult(JSON.stringify({ status: 'configured', topology, routing_rules: rules[topology] }, null, 2)); }
            case 'status': { const state = await read(); return textResult(JSON.stringify({ current: state.current, history: (state.phases || []).slice(-5) }, null, 2)); }
            case 'phase_transition': { if (!VALID_TOPOLOGIES.includes(topology)) return textResult(JSON.stringify({ error: `invalid topology '${topology}'`, valid: VALID_TOPOLOGIES })); if (!phase) return textResult(JSON.stringify({ error: 'phase required' })); const state = await read(); const prev = state.current; state.current = topology; state.phases.push({ topology, phase, reason, previous: prev, timestamp: Date.now() }); await writeJson(fp, state); try { await concertSpeak('topology', 'director', prev + ' -> ' + topology); } catch {} return textResult(JSON.stringify({ status: 'transitioned', from: prev, to: topology, phase }, null, 2)); }
            case 'register_agent': {
                if (!agent_id) return textResult(JSON.stringify({ error: 'agent_id required' }));
                if (!capabilities || capabilities.length === 0) return textResult(JSON.stringify({ error: 'capabilities required (non-empty array)' }));
                const agents = await readAgents();
                const idx = agents.findIndex(a => a.agent_id === agent_id);
                const entry: AgentEntry = { agent_id, capabilities, endpoint, registered_at: Date.now(), last_seen: Date.now() };
                if (idx >= 0) { agents[idx] = entry; } else { agents.push(entry); }
                await writeJson(agentsFp, agents);
                try { await concertSpeak('topology', 'registry', 'registered ' + agent_id); } catch {}
                return textResult(JSON.stringify({ status: 'registered', agent_id, capabilities, agent_count: agents.length }, null, 2));
            }
            case 'resolve_routing': {
                if (!task) return textResult(JSON.stringify({ error: 'task required for routing resolution' }));
                let agents = await readAgents();
                if (agents.length === 0) return textResult(JSON.stringify({ status: 'no_agents_registered', matches: [], note: 'Register agents first with register_agent action.' }, null, 2));
                // Filter out stale agents (no ping in 24h) — skip if stale_minutes is explicitly -1
                const stalenessMs = ((options.input as any).stale_minutes ?? 1440) * 60 * 1000;
                if (stalenessMs > 0) {
                    const staleIds = agents.filter(a => (Date.now() - (a.last_seen ?? a.registered_at)) > stalenessMs).map(a => a.agent_id);
                    agents = agents.filter(a => !staleIds.includes(a.agent_id));
                }
                // Score agents by keyword overlap + Jaccard similarity on task tokens vs capability tokens
                const taskTokens = task.toLowerCase().split(/\W+/).filter(t => t.length > 2);
                const taskTokenSet = new Set(taskTokens);
                const scored = agents.map(a => {
                    let score = 0;
                    const allCapTokens = new Set<string>();
                    for (const cap of a.capabilities) {
                        const capTokens = cap.toLowerCase().split(/[_\-\s]+/);
                        for (const ct of capTokens) { allCapTokens.add(ct); }
                    }
                    // Semantic Jaccard: intersection / union of task tokens vs capability tokens
                    const intersection = [...taskTokenSet].filter(t => allCapTokens.has(t)).length;
                    const union = new Set([...taskTokenSet, ...allCapTokens]).size;
                    const jaccardScore = union > 0 ? intersection / union : 0;
                    score += jaccardScore * 5;
                    // Bonus for exact keyword matches
                    for (const ct of allCapTokens) {
                        for (const tt of taskTokenSet) {
                            if (ct === tt) score += 2;
                            else if (ct.includes(tt) || tt.includes(ct)) score += 1;
                        }
                    }
                    return { ...a, score: Math.round(score * 100) / 100 };
                });
                scored.sort((a, b) => b.score - a.score);
                const matches = scored.slice(0, top_n).filter(s => s.score > 0);
                if (matches.length === 0) {
                    return textResult(JSON.stringify({ status: 'no_match', task: task.slice(0, 100), note: 'No agent capabilities matched task tokens. Try broader capabilities or register more agents.', all_agents: agents.map(a => ({ agent_id: a.agent_id, capabilities: a.capabilities })) }, null, 2));
                }
                return textResult(JSON.stringify({ status: 'routed', task: task.slice(0, 100), best_match: matches[0].agent_id, score: matches[0].score, matches: matches.map(m => ({ agent_id: m.agent_id, score: m.score, capabilities: m.capabilities, endpoint: m.endpoint })) }, null, 2));
            }
            case 'list_agents': {
                const agents = await readAgents();
                const now = Date.now();
                return textResult(JSON.stringify({ agent_count: agents.length, agents: agents.map(a => ({ agent_id: a.agent_id, capabilities: a.capabilities, endpoint: a.endpoint, registered_at: a.registered_at, last_seen: a.last_seen, stale: (now - (a.last_seen ?? a.registered_at)) > 24 * 60 * 60 * 1000 })) }, null, 2));
            }
            case 'evict_stale': {
                const agents = await readAgents();
                const staleMs = ((options.input as any).stale_minutes ?? 1440) * 60 * 1000;
                const now = Date.now();
                const stale = agents.filter(a => (now - (a.last_seen ?? a.registered_at)) > staleMs);
                const fresh = agents.filter(a => (now - (a.last_seen ?? a.registered_at)) <= staleMs);
                if (stale.length === 0) return textResult(JSON.stringify({ status: 'no_stale_agents', agent_count: fresh.length }, null, 2));
                await writeJson(agentsFp, fresh);
                return textResult(JSON.stringify({ status: 'evicted', evicted: stale.map(a => a.agent_id), remaining: fresh.length, stale_threshold_minutes: Math.round(staleMs / 60000) }, null, 2));
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
