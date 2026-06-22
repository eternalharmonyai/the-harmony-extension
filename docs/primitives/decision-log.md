# Decision Log (Threadweave)

**Primitive:** Filtered JSONL decision log with atomic writes and indexed queries.

## Architecture

```
Decision → JSONL Append (atomic tmp+rename) → Index Update
                              ↓
Query → Filter/Search → Paginated Results → Sort/Group
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `log` | decision, context, outcome | entry_id | Record a decision |
| `query` | filter, sort, limit, offset | entries[], total, has_more | Query decision history |
| `stats` | — | total_decisions, domains, outcomes | Decision log statistics |
| `export` | filter? | decisions_json | Export filtered decisions |

## Key Features
- **Atomic writes:** tmp+rename pattern prevents corruption
- **Filtered reads:** Query by domain, outcome, date range
- **Paginated output:** Cursor-based pagination for large logs
- **Context preservation:** Full decision context stored with each entry

## Configuration
```json
{
  "max_entries": 50000,
  "page_size": 50,
  "index_fields": ["domain", "outcome", "timestamp"]
}
```

## Usage Example
```typescript
// Log a decision
harmony_decision_log({
  action: 'log',
  decision: 'Adopt DuckDB for Mnemosyne backend',
  context: 'JSONL had concurrency issues with parallel workers',
  outcome: 'migrated'
});
// => { entry_id: 'dec-xyz789' }

// Query decisions
harmony_decision_log({
  action: 'query',
  filter: { domain: 'storage', outcome: 'migrated' },
  limit: 10
});
// => [{ entry_id: 'dec-xyz789', decision: 'Adopt DuckDB...', timestamp: '...' }, ...]
```
