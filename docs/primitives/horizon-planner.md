# Horizon Planner (Metis)

**Primitive:** Hierarchical planning with atomic JSONL persistence for task decomposition.

## Architecture

```
Goal → Task Decomposition → Dependency Graph
                ↓
        Priority Assignment → Resource Estimation
                ↓
        Execution Plan → JSONL Persistence (atomic)
                ↓
        Progress Tracking → Plan Adaptation
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `plan` | goal, constraints, resources | plan_id, tasks[], dependencies | Create execution plan |
| `decompose` | task_id, strategy | sub_tasks[] | Break down a task |
| `status` | plan_id | progress, blocked_tasks, completion_pct | Check plan progress |
| `adapt` | plan_id, change_description | updated_tasks[] | Adapt plan to changes |
| `complete` | task_id | plan_progress | Mark task complete |
| `stats` | — | total_plans, completion_rate, avg_tasks | Planning statistics |

## Key Features
- **Hierarchical decomposition:** Tasks break into sub-tasks recursively
- **Dependency tracking:** Tasks ordered by prerequisite relationships
- **Atomic persistence:** tmp+rename JSONL writes prevent corruption
- **Adaptive planning:** Plans update when circumstances change

## Configuration
```json
{
  "max_depth": 5,
  "max_tasks_per_plan": 100,
  "default_strategy": "breadth_first",
  "auto_decompose_threshold": 8
}
```

## Usage Example
```typescript
// Create plan
harmony_horizon_planner({
  action: 'plan',
  goal: 'Implement per-primitive documentation for 15 primitives',
  constraints: { time_budget_hours: 4, quality: 'comprehensive' }
});
// => { plan_id: 'plan-42', tasks: [{ id: 't1', title: 'Audit existing docs', priority: 1 }, ...] }

// Decompose task
harmony_horizon_planner({
  action: 'decompose',
  task_id: 't1',
  strategy: 'depth_first'
});
// => { sub_tasks: [{ id: 't1.1', title: 'Check @example coverage' }, { id: 't1.2', title: 'Identify gaps' }] }
```
