# Harmony Primitives — Documentation Index

Harmony's 15 primitives form the orchestration backbone. Each primitive is a self-contained reasoning or coordination tool.

## Cognitive Primitives

| Primitive | Tool Name | Description |
|:---|:---|:---|
| [Thought Graph](thought-graph.md) | Rigor | DAG-based claim-evidence reasoning |
| [Uncertainty Fabric](uncertainty-fabric.md) | Aletheia | Beta-distribution uncertainty modeling |
| [Convergence Arbiter](convergence-arbiter.md) | Kairos | TF-IDF consensus detection with calibration |
| [Property Tester](property-tester.md) | Logos | Property-based testing with shrinking |
| [Adversarial Critic](adversarial-critic.md) | Furies | Adversarial code review with counterexamples |
| [Analogy Engine](analogy-engine.md) | Metaphora | Cross-domain analogical transfer |
| [Value Resolver](value-resolver.md) | Ethos | Multi-principle ethical reasoning |
| [Temporal Branch](temporal-branch.md) | Chronos | Branch-based temporal reasoning |

## Coordination Primitives

| Primitive | Tool Name | Description |
|:---|:---|:---|
| [Task Auction](task-auction.md) | Agora | Evidence-weighted bidding with time-decay |
| [Swarm Topology](swarm-topology.md) | Topos | Agent registry with health monitoring |
| [Horizon Planner](horizon-planner.md) | Metis | Hierarchical task planning |
| [Decision Log](decision-log.md) | Threadweave | Filtered decision history |
| [Skill Distiller](skill-distiller.md) | Crucible | Conversation-to-skill extraction |

## Infrastructure Primitives

| Primitive | Tool Name | Description |
|:---|:---|:---|
| [Execution Sandbox](execution-sandbox.md) | Simulacrum | Multi-tier sandboxed code execution |
| [Episodic Memory](episodic-memory.md) | Mnemosyne | DuckDB-backed memory with forgetting |

## Shared Infrastructure

All primitives extend `BasePrimitive` which provides:
- **Input validation:** `requireFields()` for structured validation
- **Structured errors:** JSON error responses (not plain strings)
- **Cancellation tokens:** Long-running operations respect abort signals
- **Telemetry:** Execution time, success/failure tracking
- **Mutex:** Per-primitive operation locking
- **Fallback:** Graceful degradation patterns

Storage primitives use atomic `tmp+rename` JSONL writes via `swarmHarden.ts`.
