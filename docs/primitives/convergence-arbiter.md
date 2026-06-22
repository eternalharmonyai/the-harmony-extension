# Convergence Arbiter (Kairos)

**Primitive:** Consensus detection via TF-IDF weighted n-gram analysis with LLM fallback.

## Architecture

```
Proposals → TF-IDF similarity → threshold check → [converged?]
                ↓ (insufficient)              ↓ (yes)
           LLM fallback analysis          Return consensus
                ↓ (still unclear)
           Conductor escalation
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `assess` | proposals, threshold, allow_llm_fallback | converged, similarity, recommendation, tier | Compare proposals for convergence |
| `calibrate` | session_id, actual_converged | — | Record ground truth for threshold tuning |
| `stats` | — | total_sessions, accuracy, youdens_j, optimal_threshold | Calibration quality metrics |

## Key Features
- **Youden's J optimization:** Self-tuning thresholds from calibration data
- **LLM fallback:** When TF-IDF is inconclusive, delegates to language model
- **Conductor escalation:** Final tiebreaker for hard cases
- **Calibration log:** JSONL-based ground-truth tracking for continuous improvement

## Configuration
```json
{
  "threshold": 0.7,
  "max_rounds": 3,
  "allow_llm_fallback": true,
  "max_fallback_attempts": 2
}
```

## Usage Example
```typescript
// Assess convergence
harmony_convergence_arbiter({
  action: 'assess',
  proposals: ['Use SQLite for storage', 'Use DuckDB for storage'],
  threshold: 0.7
});
// => { converged: false, similarity: 0.54, recommendation: 'llm_fallback', tier: 'llm' }

// Calibrate after session
harmony_convergence_arbiter({
  action: 'calibrate',
  session_id: 'ses-42',
  actual_converged: true
});

// Check calibration stats
harmony_convergence_arbiter({ action: 'stats' });
// => { total_sessions: 150, accuracy_pct: 87.3, youdens_j_max: 0.82, optimal_threshold: 0.68 }
```
