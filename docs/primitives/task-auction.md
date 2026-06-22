# Task Auction (Agora)

**Primitive:** Evidence-weighted bidding with time-decayed credibility scoring.

## Architecture

```
Bid Request → Agent credibility lookup → Beta-Binomial scoring
                    ↓
            Time-decay weighting (30-day half-life)
                    ↓
            Bid ranking → Winner selection
```

## Mathematical Model

- **Base credibility:** Beta-Binomial(α=successes+1, β=failures+1)
- **Time decay:** weight = e^(-λt) where λ = ln(2)/30days
- **Bid score:** credibility_weight × time_decay × bid_amount

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `auction` | task, bids, min_credibility | winner, bid_details | Run auction for task assignment |
| `record` | agent_id, success, context | — | Record bid outcome for credibility update |
| `stats` | agent_id? | credibility_scores, auction_history | Agent credibility statistics |

## Key Features
- **Evidence-weighted:** Credibility based on actual past performance, not arbitrary weights
- **Time-decay:** Recent performance matters more (30-day half-life)
- **Configurable threshold:** Minimum credibility for bid eligibility
- **Cold start:** New agents get neutral prior (α=1, β=1)

## Configuration
```json
{
  "min_credibility": 0.3,
  "decay_half_life_days": 30,
  "prior_alpha": 1,
  "prior_beta": 1
}
```

## Usage Example
```typescript
// Run auction
harmony_task_auction({
  action: 'auction',
  task: { type: 'code_review', complexity: 'medium' },
  bids: [
    { agent_id: 'worker-1', bid: 0.85 },
    { agent_id: 'worker-2', bid: 0.92 }
  ]
});
// => { winner: 'worker-2', credibility: 0.88, bid_amount: 0.92, time_weight: 0.95 }

// Record outcome
harmony_task_auction({
  action: 'record',
  agent_id: 'worker-2',
  success: true
});
```
