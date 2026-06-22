# Value Resolver (Ethos)

**Primitive:** Multi-principle ethical reasoning with precedence caching and escalation.

## Architecture

```
Dilemma → Principle Matching → Cached Precedent Lookup
                    ↓ (no match)
            LLM Reasoning → Principle Application
                    ↓ (ambiguous)
            Conductor Escalation → Final Resolution
```

## Resolution Pipeline

1. **Equal-priority check:** If all principles have equal weight, check precedent cache
2. **Cached precedent:** Return prior resolution for same dilemma
3. **LLM reasoning:** Delegate to language model for novel dilemmas
4. **Conductor escalation:** Human-in-the-loop for genuinely hard cases

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `resolve` | dilemma, principles | resolution, reasoning, tier | Resolve an ethical dilemma |
| `query` | keyword, limit | past_resolutions[] | Search resolution history |
| `stats` | — | total_resolutions, cache_hit_rate, escalation_rate | Resolution statistics |
| `precedent` | dilemma_hash | cached_resolution | Check precedent cache |

## Key Features
- **Principle-based:** Weighs competing principles rather than binary rules
- **Precedent caching:** Same dilemma → same resolution (deterministic)
- **LLM fallback:** Novel cases get reasoned analysis
- **Escalation:** Hard cases go to human conductor
- **Atomic writes:** JSONL storage with tmp+rename pattern

## Configuration
```json
{
  "cache_ttl_days": 365,
  "llm_fallback": true,
  "escalation_threshold": 0.3,
  "max_principles": 10
}
```

## Usage Example
```typescript
// Resolve dilemma
harmony_value_resolver({
  action: 'resolve',
  dilemma: 'Should we optimize for speed or correctness in this hot path?',
  principles: ['correctness_first', 'performance_matters', 'user_experience']
});
// => { resolution: 'Prioritize correctness with performance budget',
//      reasoning: 'Correctness is foundational; performance can be improved incrementally',
//      tier: 'cached_precedent' }
```
