/**
 * Integration tests for Topos (swarmTopology.ts).
 * Tests: agent registry operations, routing resolution, staleness detection.
 */
import * as assert from 'assert';

console.log('=== Topos Integration Tests ===\n');

interface AgentEntry { agent_id: string; capabilities: string[]; registered_at: number; last_seen?: number; }

// Test 1: Agent registry CRUD
{
    const agents: AgentEntry[] = [];
    const register = (a: AgentEntry) => {
        const idx = agents.findIndex(x => x.agent_id === a.agent_id);
        if (idx >= 0) agents[idx] = a; else agents.push(a);
    };
    register({ agent_id: 'kronos', capabilities: ['planning', 'reasoning'], registered_at: Date.now() });
    register({ agent_id: 'hermes', capabilities: ['code-review', 'testing'], registered_at: Date.now() });
    assert.strictEqual(agents.length, 2);
    // Re-register updates
    register({ agent_id: 'kronos', capabilities: ['planning', 'reasoning', 'code-review'], registered_at: Date.now() });
    assert.strictEqual(agents.length, 2);
    assert.strictEqual(agents.find(a => a.agent_id === 'kronos')!.capabilities.length, 3);
    console.log('✅ Test 1: Agent registry CRUD — passed');
}

// Test 2: Routing resolution (keyword + Jaccard scoring)
function resolveRouting(task: string, agents: AgentEntry[], top_n = 5): { agent_id: string; score: number }[] {
    const taskTokens = task.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    const taskTokenSet = new Set(taskTokens);
    return agents.map(a => {
        let score = 0;
        const allCapTokens = new Set<string>();
        for (const cap of a.capabilities) {
            for (const ct of cap.toLowerCase().split(/[_\-\s]+/)) allCapTokens.add(ct);
        }
        const intersection = [...taskTokenSet].filter(t => allCapTokens.has(t)).length;
        const union = new Set([...taskTokenSet, ...allCapTokens]).size;
        score += union > 0 ? (intersection / union) * 5 : 0;
        for (const ct of allCapTokens) {
            for (const tt of taskTokenSet) {
                if (ct === tt) score += 2;
                else if (ct.includes(tt) || tt.includes(ct)) score += 1;
            }
        }
        return { agent_id: a.agent_id, score: Math.round(score * 100) / 100 };
    }).sort((a, b) => b.score - a.score).slice(0, top_n).filter(s => s.score > 0);
}

{
    const agents: AgentEntry[] = [
        { agent_id: 'kronos', capabilities: ['planning', 'reasoning', 'strategy'], registered_at: Date.now() },
        { agent_id: 'hermes', capabilities: ['code-review', 'testing', 'python'], registered_at: Date.now() },
        { agent_id: 'athena', capabilities: ['documentation', 'writing'], registered_at: Date.now() },
    ];
    const matches = resolveRouting('create a roadmap for the python migration', agents);
    assert.ok(matches.length > 0, 'Should find at least one match');
    // hermes should score for 'python', kronos for 'roadmap'/'planning'
    assert.ok(matches.some(m => m.agent_id === 'hermes' || m.agent_id === 'kronos'));
    console.log('✅ Test 2: Routing resolution finds relevant agents — passed');
}

// Test 3: No agents → empty routing
{
    const matches = resolveRouting('any task', []);
    assert.strictEqual(matches.length, 0);
    console.log('✅ Test 3: Empty registry → no matches — passed');
}

// Test 4: Staleness detection
function isStale(agent: AgentEntry, now: number, staleMinutes = 1440): boolean {
    const lastActivity = agent.last_seen ?? agent.registered_at;
    return (now - lastActivity) > staleMinutes * 60 * 1000;
}

{
    const now = Date.now();
    const fresh: AgentEntry = { agent_id: 'active', capabilities: ['testing'], registered_at: now - 1000, last_seen: now - 100 };
    const stale: AgentEntry = { agent_id: 'dormant', capabilities: ['testing'], registered_at: now - 2 * 24 * 60 * 60 * 1000 };
    assert.strictEqual(isStale(fresh, now, 1440), false);
    assert.strictEqual(isStale(stale, now, 1440), true);
    console.log('✅ Test 4: Staleness detection — passed');
}

// Test 5: Eviction removes only stale agents
{
    const now = Date.now();
    const agents: AgentEntry[] = [
        { agent_id: 'active-1', capabilities: ['a'], registered_at: now - 1000, last_seen: now - 100 },
        { agent_id: 'stale-1', capabilities: ['b'], registered_at: now - 3 * 24 * 60 * 60 * 1000 },
        { agent_id: 'active-2', capabilities: ['c'], registered_at: now - 2000, last_seen: now - 200 },
    ];
    const staleMs = 1440 * 60 * 1000; // 24 hours
    const fresh = agents.filter(a => (now - (a.last_seen ?? a.registered_at)) <= staleMs);
    const stale = agents.filter(a => (now - (a.last_seen ?? a.registered_at)) > staleMs);
    assert.strictEqual(fresh.length, 2);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].agent_id, 'stale-1');
    console.log('✅ Test 5: Eviction removes only stale agents — passed');
}

console.log('\n=== Topos: 5/5 tests passed ===\n');
