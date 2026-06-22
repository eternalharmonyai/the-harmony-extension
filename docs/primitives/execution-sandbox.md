# Execution Sandbox (Simulacrum)

**Primitive:** Multi-tier sandboxed code execution with timeout enforcement.

## Architecture

```
Code Input → Safety Pre-check → Tier Selection
                                      ↓
                    Tier 1: isolated-vm (JS/TS) — fastest, Node.js only
                    Tier 2: Pyodide (Python) — browser-grade Python in Node
                    Tier 3: Windows Sandbox (.wsb) — full OS isolation
                                      ↓
                    Timeout enforcement via Promise.race
                                      ↓
                    Result + stdout/stderr + execution_time
```

## Tiers

| Tier | Runtime | Isolation | Use Case |
|:---|:---|:---|:---|
| 1 | isolated-vm | Process-level | JS/TS code, fast feedback |
| 2 | Pyodide | WASM sandbox | Python scripts, data analysis |
| 3 | Windows Sandbox | OS-level | Untrusted code, system access |

## Safety

- **Code size limit:** 50KB max
- **Dangerous pattern detection:** `eval`, `Function()`, `require('child_process')`
- **Timeout:** Configurable per execution (default 30s)
- **Memory limit:** Per-tier caps

## Actions

| Action | Input | Output | Description |
|:---|:---|:---|:---|
| `execute` | code, language, timeout_sec | result, stdout, stderr, execution_time | Execute code in sandbox |
| `execute_async` | code, language, timeout_sec | job_id | Fire-and-forget execution |
| `result` | job_id | result, status | Poll async job result |
| `stats` | — | total_executions, failures, avg_time | Execution statistics |

## Configuration
```json
{
  "default_timeout_sec": 30,
  "max_code_size_kb": 50,
  "tier": "auto",
  "dangerous_patterns": ["eval", "Function(", "require(", "import(", "exec(", "subprocess"]
}
```

## Usage Example
```typescript
// Sync execution
harmony_execution_sandbox({
  action: 'execute',
  code: 'console.log(2 + 2)',
  language: 'javascript',
  timeout_sec: 10
});
// => { result: undefined, stdout: '4\n', execution_time: 0.12 }

// Async fire-and-forget
harmony_execution_sandbox({
  action: 'execute_async',
  code: 'import time; time.sleep(5); print("done")',
  language: 'python',
  timeout_sec: 30
});
// => { job_id: 'job-abc123', status: 'running' }

// Poll result
harmony_execution_sandbox({ action: 'result', job_id: 'job-abc123' });
// => { result: undefined, stdout: 'done\n', status: 'complete', execution_time: 5.2 }
```
