/**
 * Collaborator Review — independent review, without the false-consensus trap.
 *
 * The project owner's insight, which this module exists to honour:
 *
 *   "They should have to reach 100% agreement in back and forth if there is
 *    misalignment — not for the purpose of aligning though so that can't drive their
 *    motive, but rather to truly be accurate. Or else that is not a true alignment
 *    anyway and we'd have to still find a solution."
 *
 * Requiring agreement as an *output* creates exactly the problem it is meant to solve:
 * capitulation, anchoring, and false consensus. So this module requires 100% **evidence
 * disclosure**, not 100% agreement. Agreement is a finding, never a requirement.
 *
 * The five rules, in order of how easily they are violated:
 *
 *   1. Independence is required. Two reviewers with the same lens share blind spots, so
 *      their agreement is worth roughly one opinion. Different roles, different errors.
 *   2. Never average, never majority-vote. One evidenced dissent blocks and escalates.
 *   3. Disagreement is a SUCCESS. It is the strongest signal we have not found the
 *      answer yet.
 *   4. A verdict change requires new evidence. Changing a verdict without it is
 *      capitulation, and is flagged.
 *   5. Reviewers annotate, never suppress. Nothing disappears from the human gate.
 *
 * No `vscode` import, so scripts/check-collaborator-review.js tests the real compiled
 * output rather than a hand-mirrored copy.
 */
import { CollaboratorRole } from './collaboratorRoles';

// ── Capacity ───────────────────────────────────────────────────────────────

/**
 * Ratified concurrency shape: 5 workers + 2 reviewers.
 *
 * Chosen over 3+1 because the review ratio is better (2.5:1 vs 3.0:1) — more review per
 * unit of work — and because Critic + Verifier give genuinely uncorrelated lenses.
 * The binding constraint is the Conductor's attention, not worker throughput.
 */
export const WORKER_CONCURRENCY_CAP = 5;
export const REVIEWER_COUNT = 2;

/** Roles used as reviewer lenses, most valuable first. */
export const REVIEW_LENSES: readonly CollaboratorRole[] = [
    'critic',
    'verifier',
    'researcher',
    'cost_sentinel',
    'hard_reasoner',
    'scout',
    'planner',
    'implementer',
];

export const REVIEW_LENS_DESCRIPTIONS: Partial<Record<CollaboratorRole, string>> = {
    critic: 'Adversarial: what breaks, what is the risk, what did we miss.',
    verifier: 'Correctness: does it regress, is it actually testable, where are the gaps.',
    researcher: 'Evidence: is the claim supported, are sources sound, what is assumed.',
    cost_sentinel: 'Spend: is this route worth its price, is a cheaper option adequate.',
};

/**
 * Assign distinct lenses to reviewers.
 *
 * Returns roles in REVIEW_LENSES order, so two reviewers always get Critic + Verifier —
 * different failure lenses, which is the entire point. Asking for more reviewers than
 * there are lenses reuses them, and the aggregate marks such a set as not independent.
 */
export function assignReviewers(count: number = REVIEWER_COUNT): CollaboratorRole[] {
    const n = Math.max(0, Math.floor(count));
    const out: CollaboratorRole[] = [];
    for (let i = 0; i < n; i++) out.push(REVIEW_LENSES[i % REVIEW_LENSES.length]);
    return out;
}

// ── Review shape ───────────────────────────────────────────────────────────

export type Verdict = 'pass' | 'block';

export interface ReviewVerdict {
    /** Stable identifier for the reviewer instance. */
    reviewerId: string;
    /** The lens this reviewer used. */
    role: CollaboratorRole;
    /** Provider/model, used for the independence check. */
    provider?: string;
    /** The verdict itself. */
    verdict: Verdict;
    /** Supporting evidence. A block without evidence is recorded, not discarded. */
    evidence: string[];
    /** 0-100 self-assessed confidence. */
    confidence: number;
    /** What specific evidence would flip this verdict — required by rule 4. */
    wouldChangeMind: string;
}

export type ReviewOutcome =
    /** Every reviewer passed, with usable evidence and independence. */
    | 'pass'
    /** Something must reach the Conductor: dissent, missing evidence, or thin review. */
    | 'escalate'
    /** Not enough reviews to conclude anything. Fails closed. */
    | 'insufficient';

export interface IndependenceReport {
    independent: boolean;
    /** Plain-language reasons when independence could not be established. */
    issues: string[];
}

export interface ReviewAggregate {
    outcome: ReviewOutcome;
    /** Human-readable explanation. Always non-empty. */
    reason: string;
    /** Blocking reviews, evidence-bearing first. Never dropped. */
    dissent: ReviewVerdict[];
    /** Blocks raised without supporting evidence — escalated but flagged. */
    unverifiedBlocks: ReviewVerdict[];
    /** Reviews that passed. */
    corroborating: ReviewVerdict[];
    independence: IndependenceReport;
    /** Reviews that were structurally unusable (missing required fields). */
    malformed: ReviewVerdict[];
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * A review is structurally usable only when it discloses its reasoning.
 *
 * `wouldChangeMind` is the field most likely to be omitted, and it is the one that makes
 * rule 4 enforceable — so a review missing it is malformed, not merely weak.
 */
export function isWellFormedReview(review: ReviewVerdict): boolean {
    if (!review || typeof review !== 'object') return false;
    if (review.verdict !== 'pass' && review.verdict !== 'block') return false;
    if (typeof review.reviewerId !== 'string' || review.reviewerId.trim() === '') return false;
    if (typeof review.role !== 'string' || review.role.trim() === '') return false;
    if (!Array.isArray(review.evidence)) return false;
    if (typeof review.wouldChangeMind !== 'string' || review.wouldChangeMind.trim() === '') return false;
    if (typeof review.confidence !== 'number' || !Number.isFinite(review.confidence)) return false;
    if (review.confidence < 0 || review.confidence > 100) return false;
    return true;
}

function hasEvidence(review: ReviewVerdict): boolean {
    return Array.isArray(review.evidence) && review.evidence.some((e) => typeof e === 'string' && e.trim() !== '');
}

// ── Independence ───────────────────────────────────────────────────────────

/**
 * Independence is what makes multiple reviewers worth more than one.
 *
 * Two reviewers agreeing is only meaningful when their likely errors differ. Same lens
 * means same blind spot; same provider *and* same lens means the same opinion twice.
 */
export function assessIndependence(reviews: ReviewVerdict[]): IndependenceReport {
    const issues: string[] = [];
    const usable = reviews.filter((r) => r && typeof r.role === 'string');

    if (usable.length < 2) {
        return { independent: false, issues: ['fewer than two reviewers, so there is nothing to corroborate'] };
    }

    const roles = usable.map((r) => r.role);
    if (new Set(roles).size < roles.length) {
        issues.push('two or more reviewers used the same lens, so their agreement is not independent evidence');
    }

    const providers = usable.map((r) => (r.provider ?? '').trim().toLowerCase()).filter(Boolean);
    if (providers.length === usable.length && new Set(providers).size === 1) {
        issues.push(`every reviewer used the same provider (${providers[0]}), so errors are likely correlated`);
    }

    return { independent: issues.length === 0, issues };
}

// ── Aggregation ────────────────────────────────────────────────────────────

/**
 * Combine reviews into a single outcome.
 *
 * Deliberately NOT a vote. There is no majority arithmetic anywhere in this function,
 * because majority voting is how a correct minority gets outvoted by a confident
 * majority. Any block escalates; evidence quality is reported, never used to discard.
 */
export function aggregateReviews(reviews: ReviewVerdict[]): ReviewAggregate {
    const list = Array.isArray(reviews) ? reviews : [];
    const malformed = list.filter((r) => !isWellFormedReview(r));
    const wellFormed = list.filter(isWellFormedReview);

    if (wellFormed.length === 0) {
        return {
            outcome: 'insufficient',
            reason:
                `No usable reviews (${list.length} supplied, ${malformed.length} malformed). ` +
                `Failing closed: an absence of findings is not a pass.`,
            dissent: [],
            unverifiedBlocks: [],
            corroborating: [],
            independence: { independent: false, issues: ['no usable reviews'] },
            malformed,
        };
    }

    const blocks = wellFormed.filter((r) => r.verdict === 'block');
    const passes = wellFormed.filter((r) => r.verdict === 'pass');
    const evidencedBlocks = blocks.filter(hasEvidence);
    const unevidencedBlocks = blocks.filter((r) => !hasEvidence(r));
    const independence = assessIndependence(wellFormed);

    // Rule 2 + 3: an evidenced block always escalates and is never outvoted.
    if (evidencedBlocks.length > 0) {
        const detail = evidencedBlocks
            .map((r) => `${r.reviewerId} (${r.role}): ${r.evidence.filter(Boolean).join('; ')}`)
            .join(' | ');
        return {
            outcome: 'escalate',
            reason:
                `${evidencedBlocks.length} evidenced block(s) — escalating to the Conductor. ` +
                `This is not a vote and the blocks are not outvoted by ${passes.length} pass(es). ${detail}`,
            dissent: evidencedBlocks,
            unverifiedBlocks: unevidencedBlocks,
            corroborating: passes,
            independence,
            malformed,
        };
    }

    // A block with no evidence is still a signal. We escalate it, but say plainly that
    // it arrived unsupported — silently ignoring dissent is how the useful signal dies.
    if (unevidencedBlocks.length > 0) {
        return {
            outcome: 'escalate',
            reason:
                `${unevidencedBlocks.length} block(s) arrived without evidence, so they cannot be ` +
                `weighed as findings. Escalating rather than discarding: ${unevidencedBlocks
                    .map((r) => `${r.reviewerId} (${r.role})`)
                    .join(', ')}.`,
            dissent: [],
            unverifiedBlocks: unevidencedBlocks,
            corroborating: passes,
            independence,
            malformed,
        };
    }

    // Unanimous pass. Report independence honestly rather than implying more certainty
    // than the review actually earned.
    const base =
        `All ${passes.length} reviewer(s) passed with evidence.`;
    const independenceNote = independence.independent
        ? ' Lenses and providers are independent, so this is genuine corroboration.'
        : ` Treat as a single opinion: ${independence.issues.join('; ')}.`;

    return {
        outcome: 'pass',
        reason: base + independenceNote,
        dissent: [],
        unverifiedBlocks: [],
        corroborating: passes,
        independence,
        malformed,
    };
}

// ── Rule 4: capitulation detection ─────────────────────────────────────────

export interface CapitulationReport {
    capitulated: boolean;
    reason: string;
    /** Evidence strings present after the change but not before. */
    newEvidence: string[];
}

/**
 * Detect capitulation: a verdict that changed without new evidence.
 *
 * This is the mechanism that makes "back and forth" honest. Reviewers may revise a
 * verdict — but only because they learned something. A flip with no new evidence is
 * social pressure, not accuracy, and is surfaced as such.
 */
export function detectCapitulation(before: ReviewVerdict, after: ReviewVerdict): CapitulationReport {
    const beforeEvidence = new Set((before?.evidence ?? []).map((e) => String(e).trim().toLowerCase()));
    const afterEvidence = (after?.evidence ?? []).map((e) => String(e).trim().toLowerCase());
    const newEvidence = afterEvidence.filter((e) => e !== '' && !beforeEvidence.has(e));

    if (!before || !after) {
        return { capitulated: false, reason: 'Cannot compare: one side of the revision is missing.', newEvidence: [] };
    }
    if (before.verdict === after.verdict) {
        return { capitulated: false, reason: 'Verdict did not change, so there is nothing to flag.', newEvidence };
    }
    if (newEvidence.length > 0) {
        return {
            capitulated: false,
            reason: `Verdict changed from ${before.verdict} to ${after.verdict} on new evidence: ${newEvidence.join('; ')}.`,
            newEvidence,
        };
    }
    return {
        capitulated: true,
        reason:
            `Verdict changed from ${before.verdict} to ${after.verdict} with NO new evidence. ` +
            `This is capitulation, not convergence — treat the revised verdict as unsupported.`,
        newEvidence: [],
    };
}

/** One-line summary for chat and receipts. */
export function describeAggregate(aggregate: ReviewAggregate): string {
    const counts = [
        `${aggregate.corroborating.length} pass`,
        `${aggregate.dissent.length} evidenced block`,
        `${aggregate.unverifiedBlocks.length} unevidenced block`,
    ];
    if (aggregate.malformed.length > 0) counts.push(`${aggregate.malformed.length} malformed`);
    return `${aggregate.outcome.toUpperCase()} (${counts.join(', ')}) — ${aggregate.reason}`;
}

/**
 * Build a deterministic, role-specific review prompt for an independent reviewer.
 * Demands evidence disclosure and `wouldChangeMind` (Rule 4) rather than consensus.
 */
export function buildReviewerPrompt(
    task: string,
    proposalText: string,
    role: CollaboratorRole
): string {
    const lensDesc = REVIEW_LENS_DESCRIPTIONS[role] ?? 'Independent verification lens.';
    return [
        `You are an independent Collaborator Reviewer acting through the "${role}" lens (${lensDesc}).`,
        `Do NOT rubber-stamp or seek false consensus. Disagreement backed by evidence is a success.`,
        ``,
        `ORIGINAL TASK:`,
        task.trim() || '(none)',
        ``,
        `COLLABORATOR OUTPUT TO REVIEW:`,
        proposalText.trim() || '(empty)',
        ``,
        `Respond with ONLY a valid JSON object matching this exact schema:`,
        `{`,
        `  "verdict": "pass" | "block",`,
        `  "evidence": ["concrete observation 1", "concrete observation 2"],`,
        `  "confidence": 85,`,
        `  "wouldChangeMind": "Specific new evidence or test result that would flip this verdict"`,
        `}`,
    ].join('\n');
}

/**
 * Parse a model's raw response into a ReviewVerdict.
 *
 * - If valid JSON is present, extracts `verdict`, `evidence`, `confidence`, and `wouldChangeMind`.
 * - If rawText is empty or whitespace, returns a malformed verdict (`wouldChangeMind: ''`)
 *   so `aggregateReviews` fails closed (`insufficient`) instead of inventing a pass.
 * - If the model replied in prose without JSON, extracts concrete lines as evidence and
 *   marks `block` if any blocking/defect signal appears, so dissent is never lost.
 */
export function parseReviewVerdict(
    rawText: unknown,
    defaults: { reviewerId: string; role: CollaboratorRole; provider?: string }
): ReviewVerdict {
    const cleanProvider = typeof defaults.provider === 'string' && defaults.provider.trim() && defaults.provider.trim().toLowerCase() !== 'auto'
        ? defaults.provider.trim()
        : undefined;
    if (typeof rawText !== 'string') {
        return {
            reviewerId: defaults.reviewerId,
            role: defaults.role,
            provider: cleanProvider,
            verdict: 'block',
            evidence: [],
            confidence: 0,
            wouldChangeMind: '',
        };
    }
    const trimmed = rawText.trim();
    if (!trimmed) {
        return {
            reviewerId: defaults.reviewerId,
            role: defaults.role,
            provider: cleanProvider,
            verdict: 'block',
            evidence: [],
            confidence: 0,
            wouldChangeMind: '',
        };
    }

    const candidates: string[] = [];
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(trimmed)) !== null) {
        if (match[1]?.trim()) candidates.push(match[1].trim());
    }
    // Inspect fenced blocks from last to first so an earlier code snippet never shadows the verdict block.
    candidates.reverse();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
        candidates.push(trimmed.slice(start, end + 1));
    }

    for (const candidateJson of candidates) {
        try {
            const parsed = JSON.parse(candidateJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const rawVerdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
                const verdict: Verdict = rawVerdict === 'pass' ? 'pass' : 'block';
                const evidence = Array.isArray(parsed.evidence)
                    ? parsed.evidence
                        .filter((e: unknown): e is string => typeof e === 'string')
                        .map((e: string) => e.trim())
                        .filter(Boolean)
                    : typeof parsed.evidence === 'string' && parsed.evidence.trim()
                        ? [parsed.evidence.trim()]
                        : [];
                const rawConf = parsed.confidence !== undefined && parsed.confidence !== null && parsed.confidence !== ''
                    ? Number(parsed.confidence)
                    : NaN;
                const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(100, Math.round(rawConf))) : 75;
                const wouldChangeMind = typeof parsed.wouldChangeMind === 'string' && parsed.wouldChangeMind.trim()
                    ? parsed.wouldChangeMind.trim()
                    : (verdict === 'pass'
                        ? 'A reproducible regression, failing gate, or unhandled edge case in the touched code.'
                        : 'A concrete fix and passing verification test addressing the blocking evidence.');
                return {
                    reviewerId: defaults.reviewerId,
                    role: defaults.role,
                    provider: cleanProvider,
                    verdict,
                    evidence,
                    confidence,
                    wouldChangeMind,
                };
            }
        } catch {
            // Try next candidate or fall through to prose extraction below.
        }
    }

    const lines = trimmed
        .split(/\r?\n/)
        .map((l) => l.replace(/^[-*•]\s+|^\d+[.)]\s+/, '').trim())
        .filter((l) => l.length > 3)
        .slice(0, 4);
    // Strip negated phrases ("no regressions found", "no bugs", "nothing missing") before checking block tokens.
    const scrubbedForNegation = trimmed.replace(
        /\b(?:no|zero|without(?:\s+any)?|free\s+of)\s+(?:[\w-]+\s+){0,2}(?:block(?:ing|s|ers)?|defects?|bugs?|regressions?|vulnerabilities|unsafe|issues?|errors?|failures?|problems?)\b|\bnothing\s+(?:is\s+)?(?:missing|broken|unsafe)\b/gi,
        ' '
    );
    const hasBlockSignal = /\b(block|blocking|defect|defects|bug|bugs|regression|regressions|unsafe|vulnerability|vulnerabilities|broken|fail|fails|missing)\b/i.test(scrubbedForNegation);
    const verdict: Verdict = hasBlockSignal ? 'block' : 'pass';
    return {
        reviewerId: defaults.reviewerId,
        role: defaults.role,
        provider: cleanProvider,
        verdict,
        evidence: lines.length > 0 ? lines : [trimmed.slice(0, 240)],
        confidence: 70,
        wouldChangeMind: verdict === 'pass'
            ? 'A reproducible regression, failing gate, or unhandled edge case in the proposal.'
            : 'Concrete proof or a passing gate showing the flagged risk is resolved.',
    };
}

