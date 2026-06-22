# Swarm Topology (Topos)

**Primitive:** Agent registry with semantic routing, health monitoring, and stale agent eviction.

## Architecture

```
Agent Registration → Capability Index → Semantic Keyword Scoring
                                              ↓
Task Routing → Match agents by capability → Score ranking → Best match
                                              ↓
Health Check → last_seen staleness → Stale indicator → Eviction
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `register_agent` | agent_id, capabilities, endpoint | agent_entry | Register or update an agent |
| `resolve_routing` | task_description, required_capabilities | ranked_agents | Find best agents for a task |
| `list_agents` | include_stale? | agents with health status | List all registered agents |
| `evict_stale` | max_staleness_days | evicted_count | Remove stale agents |
| `stats` | — | total, active, stale counts | Registry statistics |

## Agent Health Model

- **last_seen:** Timestamp of last agent heartbeat
- **Staleness threshold:** Configurable (default 7 days)
- **Stale indicator:** Agents beyond threshold are marked but not auto-evicted
- **Explicit eviction:** `evict_stale` action required to remove

## Key Features
- **Semantic routing:** Keyword overlap scoring (not exact match)
- **Graceful degradation:** Stale agents filtered from routing results
- **Capability-based matching:** Agents declare what they can do
- **Health transparency:** All agents show staleness status

## Configuration
```json
{
  "max_staleness_days": 7,
  "min_capability_score": 0.3,
  "auto_evict": false
}
```

## Usage Example
```typescript
// Register agent
harmony_swarm_topology({
  action: 'register_agent',
  agent_id: 'code-reviewer-1',
  capabilities: ['typescript', 'code_review', 'refactoring'],
  endpoint: 'worker://code-reviewer-1'
});

// Route task
harmony_swarm_topology({
  action: 'resolve_routing',
  task_description: 'Review TypeScript code for security vulnerabilities',
  required_capabilities: ['typescript', 'code_review']
});
// => [{ agent_id: 'code-reviewer-1', score: 0.85, capabilities: [...], health: 'active' }]

// Check health
harmony_swarm_topology({ action: 'list_agents', include_stale: true });
// => [{ agent_id: 'code-reviewer-1', health: 'active', last_seen: '2h ago' },
//     { agent_id: 'old-worker', health: 'stale', last_seen: '12d ago' }]

// Clean up
harmony_swarm_topology({ action: 'evict_stale', max_staleness_days: 7 });
// => { evicted: 1, remaining: 1 }
```
