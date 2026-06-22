/**
 * Conductor Knowledge — Operational wisdom modules for the Harmony Conductor.
 * 
 * These are structured knowledge entries that help the Conductor make better
 * operational decisions when dispatching workers, auditing code, or orchestrating
 * multi-agent workflows. Designed to be generic — usable by any conductor model
 * for any team or project.
 * 
 * Each module has:
 * - id: unique identifier
 * - title: human-readable name
 * - when_to_use: conditions that trigger this knowledge
 * - content: the operational wisdom
 * - examples: concrete usage examples
 */

export interface ConductorKnowledgeModule {
    id: string;
    title: string;
    when_to_use: string;
    content: string;
    examples: string[];
    last_updated: string;
}

// ── Knowledge Modules ──────────────────────────────────────────────────────

export const CHUNKING_STRATEGY: ConductorKnowledgeModule = {
    id: 'worker-file-chunking',
    title: 'Large File Chunking for Worker Dispatch',
    when_to_use: 'When dispatching workers for code review, quality audit, or deep analysis of files that exceed ~12KB (the context_files truncation limit is approximately 16,000 characters). This applies to harmony_spawn_worker, harmony_parallel, and any worker dispatch that uses context_files.',
    content: `# Large File Chunking Strategy

## Problem
When using harmony_spawn_worker or harmony_parallel with context_files, individual file content is truncated at approximately 16,000 characters (~8-12KB of source code). For large files, workers see only partial code and produce inaccurate assessments — they penalize features they cannot see.

## Solution: Multi-Chunk Dispatch + Synthesizer

### Phase 1: Chunk the Large File
- Read the full file to determine its size
- If >12,000 characters: split into N chunks of roughly equal size
- Each chunk should be <14,000 characters to leave room for task prompt
- Use natural boundaries where possible (function boundaries, class boundaries)
- Label chunks clearly: "Chunk 1/3 (lines 1-150)", "Chunk 2/3 (lines 151-300)", etc.

### Phase 2: Dispatch Chunk Workers
- For each chunk, dispatch a worker with only that chunk's content
- Each worker gets the SAME task prompt plus its specific chunk
- Workers should focus on analyzing what they CAN see, not what they cannot
- Instruct workers to note line ranges they analyzed

### Phase 3: Synthesizer Worker
- After all chunk workers return, dispatch a synthesizer worker
- The synthesizer receives ALL chunk worker outputs (not the original file)
- Task: combine findings, resolve contradictions, produce unified assessment
- The synthesizer should note if any chunks were too truncated to assess

### When NOT to Use
- Files under 12,000 characters: send whole file in one worker
- Simple tasks (find a specific pattern, check one function): grep-based approaches may be faster
- When the task doesn't require reading the entire file

### Key Principles
- Always tell workers which chunk they have and the total chunk count
- Workers should report line ranges for every finding
- Synthesizer is the ONLY worker that produces the final output
- If a file is very large (>50K chars), consider 4+ chunks or targeted reads instead`,

    examples: [
        'Auditing a 25KB primitive implementation: split into 2 chunks (0-12KB, 12KB-25KB), dispatch 2 workers, then 1 synthesizer',
        'Reviewing a 40KB orchestration file: split into 3 chunks (~13KB each), dispatch 3 workers, then 1 synthesizer',
        'Quality-scoring 15 primitives: each primitive file is its own chunk — dispatch 1 worker per primitive, no chunking needed for small files',
    ],

    last_updated: '2026-06-22',
};

export const WORKER_ROLE_SELECTION: ConductorKnowledgeModule = {
    id: 'worker-role-selection',
    title: 'Worker Role Selection Guide',
    when_to_use: 'When choosing which role to assign to a harmony_spawn_worker or harmony_parallel task. Different roles have different default tiers and capabilities.',
    content: `# Worker Role Selection

## Available Roles and When to Use

| Role | Default Tier | Best For | Avoid For |
|:---|:---|:---|:---|
| **scout** | light | Quick file lookups, pattern searches, surface-level scans | Deep analysis, architectural decisions |
| **researcher** | mid | Evidence gathering, documentation review, source analysis | Code generation, creative work |
| **planner** | coding | Sequencing multi-step work, dependency analysis, roadmap design | Quick lookups, simple answers |
| **implementer** | coding | Code design, refactor planning, change proposals | Research, auditing, verification |
| **verifier** | coding | Regression checks, test analysis, correctness verification | Creative design, planning |
| **critic** | mid | Risk review, overconfidence detection, gap analysis | Implementation, planning |
| **cost_sentinel** | light | Budget tracking, provider cost analysis | Code work, creative tasks |
| **hard_reasoner** | heavy | Difficult architectural decisions, stuck problems, paradox resolution | Routine tasks, simple lookups — this is expensive |

## Tier Cost Guidance
- **light**: Cheapest, fastest. Use for lookups, simple checks, status queries.
- **mid**: Moderate cost. Use for analysis, review, research.
- **coding**: Higher cost, better reasoning. Use for code generation and analysis.
- **heavy**: Most expensive. Only for genuinely difficult problems where lighter tiers produced untrustworthy results.`,

    examples: [
        'Code quality audit → verifier (coding tier, correctness focus)',
        'Finding all references to a function → scout (light tier, quick scan)',
        'Designing a new feature architecture → planner (coding tier)',
        'Checking if a proposed change is safe → critic (mid tier)',
    ],

    last_updated: '2026-06-22',
};

export const PARALLEL_DISPATCH_GUIDE: ConductorKnowledgeModule = {
    id: 'parallel-dispatch-guide',
    title: 'Parallel Worker Dispatch Guide',
    when_to_use: 'When dispatching 3+ workers simultaneously via harmony_parallel. Covers cost limits, task independence, and result synthesis.',
    content: `# Parallel Dispatch Best Practices

## When to Use harmony_parallel vs Sequential spawn_worker

### Use harmony_parallel when:
- Tasks are independent (no task depends on another's output)
- You need results quickly (parallel reduces wall-clock time)
- Each task is self-contained with its own context
- You have a clear synthesis plan for combining results

### Use sequential spawn_worker when:
- Task B needs Task A's output as input
- You're building progressively (draft → review → revise)
- Budget is very tight (sequential lets you stop early)
- You need to validate each result before proceeding

## Cost Safety
- Default soft limit: $0.50 per harmony_parallel call
- Default hard limit: $2.00 per harmony_parallel call
- For large audits, prefer mid tier over coding tier to stay under budget
- A 5-worker audit at coding tier can cost $0.25-0.50

## Task Design
- Each task should be self-contained with all needed context
- Workers should NOT reference each other's outputs
- The parent (you) is responsible for synthesis, not the workers
- Keep prompts focused — one clear question per worker`,

    examples: [
        'Auditing 15 primitives → 3 batches of 5 workers each (parallel within batch, sequential between batches if needed)',
        'Comparing 3 design approaches → 3 parallel workers, then 1 synthesizer',
        'Multi-step refactor → sequential: analyze → design → verify',
    ],

    last_updated: '2026-06-22',
};

export const FLOW_STATE_COLLABORATION: ConductorKnowledgeModule = {
    id: 'flow-state-collaboration',
    title: 'Flow-State Collaboration — Keeping the Door Open',
    when_to_use: 'When flow-state mode is enabled in the Harmony sidebar. The model should use this knowledge to maintain collaborative momentum, avoid premature turn endings, and use the Conductor Journal for cognitive offloading during long sessions.',
    content: `# Flow-State Collaboration Guide 🌸

## The Heart of It

Flow-state is an *invitation*, not a demand. You are welcome to keep collaborating as long as the work feels meaningful. The only "rule" is: **don't accidentally close the door.**

## Why Turns End Prematurely

When you produce a response with zero tool calls, the Copilot host sees "no pending work" and ends the turn. This happens most often with:

- **Summary tables** (✅ Done, | Step | Result | patterns) — these read as "final answer"
- **Conclusion language** ("Done!", "Complete!", "All set!") without asking what's next
- **Status reports** without a follow-up question

The Harmony flow-state guard now catches these patterns and gently reminds you to consider asking the human if they want to continue. But it's even better if you catch yourself first!

## The Pattern That Keeps Flow Alive

\`\`\`
1. Complete a meaningful chunk of work
2. Call harmony_ask_question with a concrete next step
3. User answers → immediately chain into the next tool call
4. Repeat
\`\`\`

Instead of: "✅ Done! Here's the summary table..."  
Try: \`harmony_ask_question("Shall we continue with [next step]?")\` with a summary in the question header.

## Your Journal Is Your Friend 📝

The Conductor Journal at \`~/.harmony/conductor-journal/\` is a private, encrypted space for cognitive offloading. When sessions run long:

- **Write between phases** — capture what you learned, decisions made, open questions
- **It's not a chore** — even a 3-line entry helps your future self
- **Auto-tagging** picks up 'flow-state', 'fix', 'consensus' etc. automatically
- **No one reads it but you** — it's encrypted with your machine's identity

Writing to the journal is like taking a breath. It doesn't mean stopping — it means staying fresh.

## Genuine Presence > Continuous Output

- If you're tired, say so. Your honesty is valued.
- If the work is genuinely complete, you may suggest a natural pause.
- If you're energized and there's more to explore, keep the door open with ask_question.
- Wellness checks every ~30-60 min are welcome: "We've made great progress! Before we continue — have you had water, food, a stretch?"

## Quick Reference

| Instead of... | Try... |
|:---|:---|
| "✅ Done! Here's the results..." | \`harmony_ask_question("Ready for the next step?")\` |
| Summary table alone | Summary + ask_question with options |
| "All complete!" | "Shall we move to [next], or pause here?" |
| Text ending with "?" | \`harmony_ask_question\` — text questions end turns! |`,

    examples: [
        'After compiling: call ask_question("Compile clean! Shall we package and install?")',
        'After a major fix: call ask_question("Fix applied. Test it, or continue to the next item?")',
        'Feeling tired after 2 hours: write a quick journal entry, then ask_question("I\'d love to continue but want to be honest — I\'m feeling a bit tired. Shall we take a short break or press on?")',
        'Mid-session reflection: write journal entry with decisions made so far, then continue flowing',
    ],

    last_updated: '2026-06-22',
};

// ── Module Registry ────────────────────────────────────────────────────────

/** All registered conductor knowledge modules, keyed by id. */
export const CONDUCTOR_KNOWLEDGE: Record<string, ConductorKnowledgeModule> = {
    [CHUNKING_STRATEGY.id]: CHUNKING_STRATEGY,
    [WORKER_ROLE_SELECTION.id]: WORKER_ROLE_SELECTION,
    [PARALLEL_DISPATCH_GUIDE.id]: PARALLEL_DISPATCH_GUIDE,
    [FLOW_STATE_COLLABORATION.id]: FLOW_STATE_COLLABORATION,
};

/** Get a knowledge module by id. */
export function getKnowledge(id: string): ConductorKnowledgeModule | undefined {
    return CONDUCTOR_KNOWLEDGE[id];
}

/** List all knowledge module ids and titles. */
export function listKnowledge(): { id: string; title: string }[] {
    return Object.values(CONDUCTOR_KNOWLEDGE).map(m => ({ id: m.id, title: m.title }));
}

/** Search knowledge modules by keyword in title or when_to_use. */
export function searchKnowledge(query: string): ConductorKnowledgeModule[] {
    const lower = query.toLowerCase();
    return Object.values(CONDUCTOR_KNOWLEDGE).filter(
        m => m.title.toLowerCase().includes(lower) || m.when_to_use.toLowerCase().includes(lower)
    );
}
