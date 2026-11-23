/**
 * Collaborator Roles — the single canonical role taxonomy.
 *
 * Vocabulary decisions (see the Conductor/Collaborator split):
 *   - Conductor  = the seat the human talks to. Holds tool authority. Accountable for the turn.
 *   - Collaborator = a specialist peer the Conductor brings in. Advisory only.
 *
 * There were previously TWO role vocabularies that only overlapped on four entries:
 *   - lmTools.ts      WorkerRole   (8): scout, researcher, planner, implementer,
 *                                       verifier, critic, cost_sentinel, hard_reasoner
 *   - swarmTools.ts   SwarmRoleId  (7): coordinator, researcher, project_scout,
 *                                       designer, implementer, verifier, cost_sentinel
 * `scout` vs `project_scout` was a collision waiting to be confused. This module is
 * the one source of truth; the swarm IDs are preserved and mapped, never rewritten,
 * so existing swarm receipts and policies stay valid.
 *
 * This module intentionally has NO `vscode` import so the real compiled output can be
 * unit-tested by scripts/check-collaborator-roles.js instead of a hand-mirrored copy.
 */

export type CollaboratorRole =
    | 'scout'
    | 'researcher'
    | 'planner'
    | 'implementer'
    | 'verifier'
    | 'critic'
    | 'cost_sentinel'
    | 'hard_reasoner';

/** Canonical order, used for display and stable iteration. */
export const COLLABORATOR_ROLES: readonly CollaboratorRole[] = [
    'scout',
    'researcher',
    'planner',
    'implementer',
    'verifier',
    'critic',
    'cost_sentinel',
    'hard_reasoner',
];

export type RoleDefaultTier = 'light' | 'mid' | 'coding' | 'heavy';

export const COLLABORATOR_ROLE_TIERS: Record<CollaboratorRole, RoleDefaultTier> = {
    scout: 'light',
    researcher: 'mid',
    planner: 'coding',
    implementer: 'coding',
    verifier: 'coding',
    critic: 'mid',
    cost_sentinel: 'light',
    hard_reasoner: 'heavy',
};

export const COLLABORATOR_ROLE_LABELS: Record<CollaboratorRole, string> = {
    scout: 'Scout',
    researcher: 'Researcher',
    planner: 'Planner',
    implementer: 'Implementer',
    verifier: 'Verifier',
    critic: 'Critic',
    cost_sentinel: 'Cost Sentinel',
    hard_reasoner: 'Hard Reasoner',
};

export const COLLABORATOR_ROLE_SUMMARIES: Record<CollaboratorRole, string> = {
    scout: 'Locates relevant files, symbols, facts, and risks.',
    researcher: 'Gathers evidence and separates verified facts from assumptions.',
    planner: 'Sequences multi-step work with dependencies and validation points.',
    implementer: 'Designs the smallest coherent change and names edge cases.',
    verifier: 'Checks for regressions, missing tests, and validation gaps.',
    critic: 'Challenges correctness, maintainability, security, and user impact.',
    cost_sentinel: 'Assesses provider/model spend risk and cheaper adequate routes.',
    hard_reasoner: 'Spends effort on genuinely difficult reasoning or architecture.',
};

/**
 * Swarm role IDs mapped onto the canonical taxonomy.
 *
 * `coordinator` deliberately maps to `'conductor'`, not to a Collaborator role:
 * orchestration is the Conductor's job, not a peer's. Mapping it to a Collaborator
 * would quietly reintroduce the very collision this module exists to remove.
 *
 * Old IDs remain valid inputs — this is a translation layer, not a rename, so no
 * stored swarm receipt or policy file needs rewriting.
 */
export const SWARM_ROLE_TO_COLLABORATOR: Record<string, CollaboratorRole | 'conductor'> = {
    coordinator: 'conductor',
    project_scout: 'scout',
    researcher: 'researcher',
    designer: 'implementer',
    implementer: 'implementer',
    verifier: 'verifier',
    cost_sentinel: 'cost_sentinel',
};

export function normalizeSwarmRole(id: string | undefined): CollaboratorRole | 'conductor' | undefined {
    if (!id) return undefined;
    const key = id.trim().toLowerCase();
    if ((COLLABORATOR_ROLES as readonly string[]).includes(key)) return key as CollaboratorRole;
    return SWARM_ROLE_TO_COLLABORATOR[key];
}

export function isCollaboratorRole(value: unknown): value is CollaboratorRole {
    return typeof value === 'string' && (COLLABORATOR_ROLES as readonly string[]).includes(value);
}

// ── Intent-based role selection ────────────────────────────────────────────

export interface RoleSelection {
    /** The chosen Collaborator role. */
    role: CollaboratorRole;
    /** 0-100. Below AMBIGUITY_THRESHOLD the choice is a fallback, not a judgement. */
    confidence: number;
    /** Plain-language rationale, safe to show the user. */
    reason: string;
    /** The literal words that triggered the choice. Empty when nothing matched. */
    matched: string[];
    /** True when no rule fired strongly enough to be trusted. */
    ambiguous: boolean;
    /** Runners-up, best first. Empty when only one role scored. */
    alternatives: CollaboratorRole[];
}

/** Below this, we say "this is a guess" instead of silently pretending certainty. */
export const AMBIGUITY_THRESHOLD = 45;

interface Signal {
    /** Matched against a space-padded, punctuation-stripped lowercase copy of the task. */
    pattern: RegExp;
    /** Relative importance. Higher wins. */
    weight: number;
    /** Human-readable name of the concept that matched. */
    label: string;
}

interface RoleIntent {
    role: CollaboratorRole;
    signals: Signal[];
}

/**
 * Signals use word boundaries on purpose.
 *
 * The security-plane detector shipped with an over-broad substring regex and emitted
 * critical governance findings on benign sentences. The same mistake here would route
 * "replace the test fixture" to Verifier because it contains "test". Boundaries and
 * explicit phrases keep the heuristic honest.
 */
const ROLE_INTENTS: RoleIntent[] = [
    {
        role: 'cost_sentinel',
        signals: [
            { pattern: /\bcosts?\b/, weight: 30, label: 'cost' },
            { pattern: /\bpricing\b/, weight: 30, label: 'pricing' },
            { pattern: /\bbudgets?\b/, weight: 30, label: 'budget' },
            { pattern: /\bspend(ing)?\b/, weight: 30, label: 'spend' },
            { pattern: /\btokens?\b/, weight: 20, label: 'tokens' },
            { pattern: /\bcheaper\b/, weight: 30, label: 'cheaper' },
            { pattern: /\bprovider (cost|spend|risk)\b/, weight: 35, label: 'provider cost' },
            { pattern: /\brate limits?\b/, weight: 25, label: 'rate limits' },
        ],
    },
    {
        role: 'verifier',
        signals: [
            { pattern: /\bverif(y|ication)\b/, weight: 35, label: 'verify' },
            { pattern: /\bregressions?\b/, weight: 35, label: 'regression' },
            { pattern: /\bcoverage\b/, weight: 30, label: 'coverage' },
            { pattern: /\b(tests?|test suite)\b/, weight: 25, label: 'tests' },
            { pattern: /\bassertions?\b/, weight: 25, label: 'assertion' },
            { pattern: /\bedge cases?\b/, weight: 25, label: 'edge case' },
            { pattern: /\breproduce\b/, weight: 30, label: 'reproduce' },
            { pattern: /\b(fails?|failing|broken)\b/, weight: 25, label: 'failure' },
            { pattern: /\bdoes (it|this) (still )?work\b/, weight: 35, label: 'still works' },
        ],
    },
    {
        role: 'critic',
        signals: [
            { pattern: /\bcritique\b/, weight: 40, label: 'critique' },
            { pattern: /\breview\b/, weight: 30, label: 'review' },
            { pattern: /\bweakness(es)?\b/, weight: 35, label: 'weakness' },
            { pattern: /\bflaws?\b/, weight: 35, label: 'flaw' },
            { pattern: /\brisks?\b/, weight: 25, label: 'risk' },
            { pattern: /\bchallenge\b/, weight: 30, label: 'challenge' },
            { pattern: /\boverconfiden/, weight: 35, label: 'overconfidence' },
            { pattern: /\bwhat (could|might) go wrong\b/, weight: 40, label: 'failure modes' },
            { pattern: /\bsecond opinion\b/, weight: 35, label: 'second opinion' },
        ],
    },
    {
        role: 'hard_reasoner',
        signals: [
            { pattern: /\barchitecture\b/, weight: 30, label: 'architecture' },
            { pattern: /\bparadox\b/, weight: 40, label: 'paradox' },
            { pattern: /\binvariants?\b/, weight: 35, label: 'invariant' },
            { pattern: /\bstuck\b/, weight: 35, label: 'stuck' },
            { pattern: /\bprove\b/, weight: 35, label: 'prove' },
            { pattern: /\btrade-?offs?\b/, weight: 30, label: 'tradeoff' },
            { pattern: /\bdeep(ly)? reason/, weight: 35, label: 'deep reasoning' },
            { pattern: /\bwhy does\b/, weight: 25, label: 'root cause' },
            { pattern: /\bfundamentally\b/, weight: 30, label: 'fundamental' },
        ],
    },
    {
        role: 'planner',
        signals: [
            { pattern: /\bplans?\b/, weight: 30, label: 'plan' },
            { pattern: /\bplanning\b/, weight: 35, label: 'planning' },
            { pattern: /\broadmap\b/, weight: 35, label: 'roadmap' },
            { pattern: /\bphases?\b/, weight: 30, label: 'phases' },
            { pattern: /\bsequenc(e|ing)\b/, weight: 35, label: 'sequence' },
            { pattern: /\bdependenc(y|ies)\b/, weight: 30, label: 'dependency' },
            { pattern: /\bstep[- ]by[- ]step\b/, weight: 35, label: 'step by step' },
            { pattern: /\bstrategy\b/, weight: 30, label: 'strategy' },
            { pattern: /\bhow (should|do) (we|i) (approach|structure|organize)/, weight: 40, label: 'approach' },
        ],
    },
    {
        role: 'researcher',
        signals: [
            { pattern: /\bresearch\b/, weight: 40, label: 'research' },
            { pattern: /\bevidence\b/, weight: 35, label: 'evidence' },
            { pattern: /\bcompare\b/, weight: 30, label: 'compare' },
            { pattern: /\bsources?\b/, weight: 25, label: 'sources' },
            { pattern: /\bcitations?\b/, weight: 35, label: 'citation' },
            { pattern: /\bdocs?\b/, weight: 20, label: 'docs' },
            { pattern: /\bwhat('s| is) the (latest|current|state)\b/, weight: 40, label: 'current state' },
            { pattern: /\bbest practice/, weight: 30, label: 'best practice' },
            { pattern: /\bexplain (how|why)\b/, weight: 25, label: 'explain' },
        ],
    },
    {
        role: 'scout',
        signals: [
            { pattern: /\bfind\b/, weight: 30, label: 'find' },
            { pattern: /\blocate\b/, weight: 35, label: 'locate' },
            { pattern: /\bwhere (is|are|does)\b/, weight: 35, label: 'where' },
            { pattern: /\bsearch\b/, weight: 30, label: 'search' },
            { pattern: /\bwhich files?\b/, weight: 40, label: 'which file' },
            { pattern: /\blist\b/, weight: 20, label: 'list' },
            { pattern: /\bgrep\b/, weight: 35, label: 'grep' },
            { pattern: /\bpoint me\b/, weight: 35, label: 'point me' },
        ],
    },
    {
        role: 'implementer',
        signals: [
            { pattern: /\bimplement\b/, weight: 35, label: 'implement' },
            { pattern: /\brefactor\b/, weight: 35, label: 'refactor' },
            { pattern: /\bfix\b/, weight: 30, label: 'fix' },
            { pattern: /\badd\b/, weight: 20, label: 'add' },
            { pattern: /\bwrite\b/, weight: 20, label: 'write' },
            { pattern: /\bdesign\b/, weight: 25, label: 'design' },
            { pattern: /\bpatch\b/, weight: 30, label: 'patch' },
            { pattern: /\bchange\b/, weight: 20, label: 'change' },
        ],
    },
];

/** Space-pad + strip punctuation so `\b` behaves predictably. */
function normalizeTask(task: string): string {
    const cleaned = task.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return ` ${cleaned} `;
}

/**
 * Choose a Collaborator role from the task text.
 *
 * Honest by design: when nothing scores above AMBIGUITY_THRESHOLD this returns
 * `implementer` with `ambiguous: true` and a reason that says so, rather than
 * asserting a confident choice it did not earn.
 */
export function selectCollaboratorRole(task: string): RoleSelection {
    const text = normalizeTask(task || '');
    if (!text.trim()) {
        return {
            role: 'implementer',
            confidence: 0,
            reason: 'No task text to read, so no role could be inferred. Defaulting to Implementer.',
            matched: [],
            ambiguous: true,
            alternatives: [],
        };
    }

    const scored = ROLE_INTENTS.map((intent) => {
        let score = 0;
        const matched: string[] = [];
        // Corroboration bonus: two independent concepts pointing the same way is
        // stronger evidence than one strong word, so add a small multiplier.
        for (const signal of intent.signals) {
            if (signal.pattern.test(text)) {
                score += signal.weight;
                matched.push(signal.label);
            }
        }
        if (matched.length > 1) score += 10;
        return { role: intent.role, score, matched };
    })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || COLLABORATOR_ROLES.indexOf(a.role) - COLLABORATOR_ROLES.indexOf(b.role));

    if (scored.length === 0) {
        return {
            role: 'implementer',
            confidence: 20,
            reason: 'The task contained no role-specific language, so this is a default rather than a judgement. Override the role if that is wrong.',
            matched: [],
            ambiguous: true,
            alternatives: [],
        };
    }

    const best = scored[0];
    const runnersUp = scored.slice(1).map((s) => s.role);
    const secondScore = scored.length > 1 ? scored[1].score : 0;
    // Confidence is the winner's score normalised, reduced when a rival is close.
    const margin = best.score - secondScore;
    const raw = Math.min(100, best.score);
    const confidence = scored.length > 1 ? Math.max(0, Math.min(100, Math.round(raw - (margin < 15 ? 20 : 0)))) : raw;
    const ambiguous = confidence < AMBIGUITY_THRESHOLD;
    const label = COLLABORATOR_ROLE_LABELS[best.role];

    const reason = ambiguous
        ? `Weak signal (${best.matched.join(', ')}) — ${label} is a best guess, not a confident read. Override if needed.`
        : `Detected ${best.matched.join(', ')}, which points to ${label}.`;

    return {
        role: best.role,
        confidence,
        reason,
        matched: best.matched,
        ambiguous,
        alternatives: runnersUp,
    };
}

/** One-line summary of the whole taxonomy, for tool descriptions and docs. */
export function describeCollaboratorRoles(): string {
    return COLLABORATOR_ROLES.map(
        (role) => `${COLLABORATOR_ROLE_LABELS[role]} [${COLLABORATOR_ROLE_TIERS[role]}]: ${COLLABORATOR_ROLE_SUMMARIES[role]}`
    ).join('\n');
}
