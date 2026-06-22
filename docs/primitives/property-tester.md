# Property Tester (Logos)

**Primitive:** Property-based testing with counterexample shrinking and structured verification.

## Architecture

```
Test Schema → Generator (random inputs) → Property assertion
                    ↓ (failure)
            Shrinker → Minimal counterexample
                    ↓
            Report: { passed, counterexample, shrunk_input, seed }
```

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `test` | schema, property, num_tests | passed, counterexample, stats | Run property-based tests |
| `shrink` | counterexample, property | minimal_failure | Shrink failing input to minimal case |
| `stats` | — | total_runs, failures, avg_shrink_steps | Test statistics |
| `replay` | seed | replay_result | Re-run with specific seed |

## Key Features
- **Random input generation:** From schema definition (types, ranges, constraints)
- **Shrinking:** Auto-reduce failing inputs to minimal counterexample
- **Seed reproducibility:** Replay any failing test with its seed
- **Structured output:** Pass/fail with exact counterexample and shrink path

## Configuration
```json
{
  "default_num_tests": 100,
  "max_shrink_steps": 50,
  "timeout_sec": 30,
  "seed": null
}
```

## Usage Example
```typescript
// Property: sorting should be idempotent
harmony_property_tester({
  action: 'test',
  schema: { type: 'array', items: { type: 'integer', min: 0, max: 100 }, maxLength: 20 },
  property: 'arr => JSON.stringify(arr.sort()) === JSON.stringify(arr.sort().sort())',
  num_tests: 100
});
// => { passed: true, tests_run: 100, shrinks: 0 }

// Property: reverse should be involutive (reverse(reverse(x)) === x)
harmony_property_tester({
  action: 'test',
  schema: { type: 'array', items: { type: 'string' }, maxLength: 10 },
  property: 'arr => JSON.stringify(arr.reverse().reverse()) === JSON.stringify(arr)',
  num_tests: 100
});
// => { passed: false, counterexample: ["a","b"], reason: 'reverse mutates in place',
//      seed: 42, shrunk_input: ["x"] }
```
