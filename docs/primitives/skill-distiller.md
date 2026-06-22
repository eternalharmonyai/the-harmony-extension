# Skill Distiller (Crucible)

**Primitive:** Skill extraction from conversation with idempotency and structured output.

## Architecture

```
Conversation → Pattern Recognition → Skill Extraction
                        ↓
                Idempotency check (content hash)
                        ↓
                JSON Schema validation → Structured skill
                        ↓
                Persistent storage (JSONL)
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `extract` | conversation, domain | skill, confidence, is_duplicate | Extract reusable skill from conversation |
| `query` | domain, keyword, limit | skills[] | Search extracted skills |
| `stats` | — | total_skills, domains, avg_confidence | Extraction statistics |
| `export` | domain? | skills_json | Export skills as structured JSON |

## Idempotency

- **Content hash:** SHA256 of conversation text
- **Duplicate detection:** Same conversation → same skill (no re-extraction)
- **Confidence threshold:** Skills below threshold are saved but flagged
- **Deduplication:** Query results deduplicate semantically similar skills

## Key Features
- **Pattern recognition:** Identifies reusable techniques from conversations
- **Domain tagging:** Auto-categorizes skills by domain
- **Confidence scoring:** How certain the extraction is
- **Structured output:** JSON Schema validated for downstream consumption

## Configuration
```json
{
  "min_confidence": 0.6,
  "max_skills_per_extraction": 5,
  "deduplication_threshold": 0.85,
  "domains": ["coding", "debugging", "architecture", "testing", "devops"]
}
```

## Usage Example
```typescript
// Extract skills from a conversation
harmony_skill_distiller({
  action: 'extract',
  conversation: 'We used tmp+rename pattern to make JSONL writes atomic...',
  domain: 'coding'
});
// => { skill: 'Atomic JSONL writes via tmp+rename', confidence: 0.92, is_duplicate: false }

// Search skills
harmony_skill_distiller({
  action: 'query',
  keyword: 'atomic',
  limit: 5
});
// => [{ skill: 'Atomic JSONL writes via tmp+rename', domain: 'coding', confidence: 0.92 }, ...]
```
