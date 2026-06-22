# Temporal Branch (Chronos)

**Primitive:** Branch-based temporal reasoning with merge/diff and snapshot history.

## Architecture

```
Timeline → Branch Creation → Parallel State Evolution
                    ↓
            Merge Request → Diff Analysis → Conflict Resolution
                    ↓
            Merged Timeline → Snapshot History
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `branch` | name, from_snapshot | branch_id | Create a reasoning branch |
| `snapshot` | branch_id, state | snapshot_id | Save current branch state |
| `merge` | source_branch, target_branch | merge_result, conflicts | Merge two branches |
| `diff` | branch_a, branch_b | differences | Compare branch states |
| `list` | — | branches[] | List all branches |
| `stats` | — | total_branches, snapshots, merges | Branch statistics |

## Key Features
- **Branch isolation:** Independent reasoning paths
- **Snapshot history:** Full state preservation per branch
- **Merge with conflict detection:** Structural diff between branches
- **Cancel token support:** Long-running operations respect cancellation

## Configuration
```json
{
  "max_branches": 20,
  "max_snapshots_per_branch": 100,
  "auto_merge_strategy": "latest_wins",
  "diff_depth": 3
}
```

## Usage Example
```typescript
// Create branch
harmony_temporal_branch({
  action: 'branch',
  name: 'alternative-approach',
  from_snapshot: 'snap-main-42'
});
// => { branch_id: 'branch-7' }

// Compare branches
harmony_temporal_branch({
  action: 'diff',
  branch_a: 'main',
  branch_b: 'alternative-approach'
});
// => { differences: [{ path: 'storage.backend', main: 'JSONL', branch: 'DuckDB' }] }

// Merge
harmony_temporal_branch({
  action: 'merge',
  source_branch: 'alternative-approach',
  target_branch: 'main'
});
// => { merge_result: 'success', conflicts: [], merged_snapshot: 'snap-main-43' }
```
