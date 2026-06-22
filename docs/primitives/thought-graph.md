# Thought Graph (Rigor)

**Primitive:** Directed acyclic graph (DAG) for claim-evidence reasoning with parallel node execution.

## Architecture

```
Claim → Evidence Nodes → Reasoning Edges → DAG Validation
                              ↓
                    Node Execution (parallel where possible)
                              ↓
                    Topological Sort → Resolution Order
                              ↓
                    Graph Statistics + Visualization
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `add_node` | claim, evidence, dependencies | node_id | Add a reasoning node |
| `add_edge` | from_node, to_node, relationship | edge_id | Connect nodes with typed relationship |
| `validate` | — | is_dag, cycles, orphan_nodes | Validate graph structure |
| `resolve` | root_node? | resolution_path, confidence | Resolve claim through evidence chain |
| `stats` | — | nodes, edges, depth, width | Graph statistics |
| `execute` | node_ids? | results[] | Execute node claims via SandboxRunner |

## Key Features
- **DAG enforcement:** Cycles detected and rejected
- **Typed relationships:** supports, contradicts, depends_on, explains
- **Parallel execution:** Independent nodes run concurrently
- **Topological resolution:** Correct dependency ordering
- **SandboxRunner integration:** Actual claim verification

## Configuration
```json
{
  "max_nodes": 1000,
  "max_depth": 50,
  "allow_cycles": false,
  "parallel_execution": true
}
```

## Usage Example
```typescript
// Build reasoning graph
harmony_thought_graph({ action: 'add_node', claim: 'DuckDB outperforms SQLite for analytics' });
// => { node_id: 'n1' }
harmony_thought_graph({ action: 'add_node', claim: 'DuckDB uses columnar storage', dependencies: [] });
// => { node_id: 'n2' }
harmony_thought_graph({ action: 'add_edge', from_node: 'n2', to_node: 'n1', relationship: 'supports' });

// Validate
harmony_thought_graph({ action: 'validate' });
// => { is_dag: true, cycles: [], orphan_nodes: [], node_count: 2, edge_count: 1 }
```
