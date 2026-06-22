# Analogy Engine (Metaphora)

**Primitive:** Cross-domain analogical transfer with LLM-powered mapping and persistence.

## Architecture

```
Source Domain → Concept Extraction → Structural Mapping
                        ↓
            Target Domain → Analogy Generation → Verification
                        ↓
            Transfer → Apply Insight → Cross-Domain Validation
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `map` | source_domain, target_domain, concept | analogy, mapping, confidence | Map concept across domains |
| `verify` | analogy_json, verification[] | verified, issues[] | Verify analogy quality |
| `transfer` | source_problem, mapping_hint | transferred_solution | Transfer solution via analogy |
| `query` | action, limit | past_analogies[] | Search analogy history |
| `transfer_cross_domain` | source_domain, target_domain, source_problem | cross_domain_solution | Full cross-domain transfer |

## Key Features
- **Structural mapping:** Identifies isomorphic relationships across domains
- **LLM-powered:** Uses language models for creative analogy generation
- **Verification:** Checks analogy consistency and applicability
- **Persistence:** JSONL storage for analogy reuse
- **Fallback:** Structural fallback when LLM unavailable

## Configuration
```json
{
  "llm_fallback": true,
  "min_confidence": 0.5,
  "max_analogies_per_query": 10,
  "domains": ["biology", "physics", "software", "mathematics", "economics"]
}
```

## Usage Example
```typescript
// Map concept across domains
harmony_analogy_engine({
  action: 'map',
  source_domain: 'biology.evolution',
  target_domain: 'software.architecture',
  concept: 'natural selection'
});
// => { analogy: 'Evolutionary architecture: components that don\'t meet fitness criteria are refactored or replaced',
//      mapping: { variation: 'feature branches', selection: 'code review', retention: 'merge to main' },
//      confidence: 0.87 }

// Transfer solution
harmony_analogy_engine({
  action: 'transfer',
  source_problem: 'How do ant colonies find shortest paths?',
  mapping_hint: 'Use pheromone-like signals for distributed routing'
});
// => { transferred_solution: 'Ant-colony optimization for swarm routing — agents leave "digital pheromones" on successful paths' }
```
