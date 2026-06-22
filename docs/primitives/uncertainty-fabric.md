# Uncertainty Fabric (Aletheia)

**Primitive:** Beta-distribution uncertainty modeling with calibration tracking.

## Architecture

```
Claim → Prior (α, β) → Evidence update → Posterior (α', β')
                              ↓
                    Mean + Variance computation
                              ↓
                    Calibration log → Accuracy tracking
```

## Mathematical Model

- **Prior:** Beta(α, β) representing initial belief
- **Evidence update:** α' = α + successes, β' = β + failures
- **Mean:** α / (α + β)
- **Variance:** (α × β) / ((α + β)² × (α + β + 1))
- **Calibration:** Compare predicted probability vs actual outcomes

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `estimate` | claim, evidence | mean, variance, confidence | Model uncertainty for a claim |
| `update` | claim_id, observed, success | new_mean, new_variance | Update with observed evidence |
| `aggregate` | claim_ids[] | joint_mean, joint_variance | Combine multiple uncertainties |
| `calibrate` | — | calibration_curve, reliability | Check calibration quality |
| `stats` | — | total_estimates, miscalibration_rate | Uncertainty store statistics |
| `query` | filter | results[] | Query historical estimates |

## Key Features
- **Beta distribution:** Proper conjugate prior for binary outcomes
- **Calibration tracking:** Compare predictions against reality
- **Aggregation:** Combine multiple independent uncertainties
- **Persistence:** DuckDB-backed uncertainty store

## Configuration
```json
{
  "prior_alpha": 1,
  "prior_beta": 1,
  "confidence_threshold": 0.8,
  "calibration_window": 100
}
```

## Usage Example
```typescript
// Initial estimate
harmony_uncertainty_fabric({
  action: 'estimate',
  claim: 'This code change will not introduce regressions',
  evidence: ['All 45 tests pass', 'Change is limited to one file']
});
// => { mean: 0.82, variance: 0.04, confidence: 0.82 }

// Update after deployment
harmony_uncertainty_fabric({
  action: 'update',
  claim_id: 'claim-1',
  observed: true,
  success: true
});
// => { new_mean: 0.88, new_variance: 0.02 }
```
