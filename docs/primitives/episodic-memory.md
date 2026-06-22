# Episodic Memory (Mnemosyne)

**Primitive:** DuckDB-backed episodic memory with conflict resolution and forgetting policy.

## Architecture

```
Memory Write → Semantic fingerprint → Conflict detection
                                            ↓
                            Resolve: latest, merge, or keep_both
                                            ↓
                            DuckDB storage (ACID, paginated reads)
                                            ↓
Memory Read → Semantic search → Ranked results → Paginated output
```

## Storage

- **Backend:** DuckDB (ACID-compliant, concurrent-safe)
- **Migration:** Automatic JSONL → DuckDB on first access
- **Pagination:** Cursor-based with configurable page size
- **Indexing:** Semantic fingerprint for conflict detection

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `remember` | content, context, importance | memory_id | Store an episodic memory |
| `recall` | query, limit, offset | memories[], has_more | Search and retrieve memories |
| `forget` | memory_id or policy | forgotten_count | Remove memories (explicit or policy) |
| `stats` | — | total_memories, size_bytes, oldest, newest | Memory store statistics |
| `migrate` | — | migrated_count | Migrate from JSONL to DuckDB |

## Forgetting Policy

- **TTL-based:** Memories older than threshold are candidates
- **Importance-weighted:** High-importance memories survive longer
- **Soft delete:** Marked as forgotten, not immediately removed
- **Configurable:** Per-type retention policies

## Configuration
```json
{
  "default_ttl_days": 90,
  "max_memories": 10000,
  "page_size": 50,
  "conflict_resolution": "latest",
  "forgetting_policy": "importance_weighted"
}
```

## Usage Example
```typescript
// Store memory
harmony_episodic_memory({
  action: 'remember',
  content: 'User prefers TypeScript over JavaScript for new projects',
  context: 'project-setup-discussion',
  importance: 0.8
});
// => { memory_id: 'mem-abc123' }

// Recall memories
harmony_episodic_memory({
  action: 'recall',
  query: 'TypeScript preferences',
  limit: 5
});
// => [{ memory_id: 'mem-abc123', content: '...', relevance: 0.92, timestamp: '...' }, ...]
```
