/**
 * Consensus Protocol — host-agnostic core.
 *
 * A declarative, reusable, hash-bound multi-model deliberation. A round either reaches
 * agreement or records the remaining disagreement, and the verdict states which —
 * together with the artifacts it was bound to.
 *
 * The mechanism is generic: which seats take part, with which provider and tier, comes
 * from a protocol file the caller points at — not from this module.
 *
 * No `vscode` imports here — the editor-facing wrapper is `consensusTools.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type SeatTransport = 'provider' | 'manual';
export type ConvergenceMode = 'unanimity' | 'supermajority' | 'rationale';
export type DissentPolicy = 'record' | 'block';
/** Why two seats disagree: a matter of fact (settleable by evidence) or of values (may persist). */
export type DisagreementKind = 'facts' | 'values' | 'unknown';
export type LedgerVerdict = 'converged' | 'disagreed' | 'incomplete';

export interface ConsensusSeat {
    id: string;
    /** `provider` = dispatched automatically; `manual` = carried by a human to a model Harmony cannot reach. */
    transport: SeatTransport;
    provider?: string;
    tier?: string;
    role?: string;
    /** Optional human-facing label (falls back to id in prompts). */
    label?: string;
    /** Lineage/vendor (e.g. "claude"). Consensus counts distinct TRUST DOMAINS, not model names. */
    family?: string;
    /** Specific model within the family (e.g. "opus-5"). Recorded per response, never baked into the seat id. */
    model?: string;
    note?: string;
}

export interface ConsensusProtocol {
    name: string;
    question: string;
    /** Paths (workspace-relative or absolute) the verdict is bound to; edit one -> verdict auto-invalidates. */
    artifacts?: string[];
    panel: ConsensusSeat[];
    rounds?: number;
    convergence?: ConvergenceMode;
    requireRestate?: boolean;
    requireRationaleForChange?: boolean;
    dissentPolicy?: DissentPolicy;
    classifyDisagreements?: boolean;
    maxProviderCallsPerRound?: number;
}

export interface SeatPosition {
    seat: string;
    round: number;
    transport: SeatTransport;
    answer?: string;
    model?: string;
    /** Steelman: seat id -> this seat's restatement of that peer's position. */
    restates?: Record<string, string>;
    changesCitedReason?: boolean;
    confidence?: number;
    recordedAt: string;
}

export interface Disagreement {
    id: string;
    topic: string;
    seats: string[];
    kind: DisagreementKind;
    evidence?: string;
    /** Set once the panel resolves it; a resolved disagreement no longer blocks convergence. */
    resolution?: string;
}

export interface ArtifactHash { path: string; sha256: string; }

export interface ConsensusLedger {
    id: string;
    protocol: string;
    question: string;
    createdAt: string;
    rounds: number;
    convergence: ConvergenceMode;
    dissentPolicy: DissentPolicy;
    artifacts: ArtifactHash[];
    snapshots: { at: string; artifactsHash: string; note?: string }[];
    positions: SeatPosition[];
    agreements: string[];
    disagreements: Disagreement[];
    verdict: LedgerVerdict;
    notes: string[];
}

export const DEFAULT_ROUNDS = 3;
export const DEFAULT_CONVERGENCE: ConvergenceMode = 'unanimity';

// ── files / hashing ─────────────────────────────────────────────────────────

export function sha256File(p: string): string | undefined {
    try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
    catch { return undefined; }
}

export function hashArtifacts(paths: string[] | undefined, root: string): ArtifactHash[] {
    const out: ArtifactHash[] = [];
    for (const rel of paths ?? []) {
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        const sha = sha256File(abs);
        if (sha) out.push({ path: rel, sha256: sha });
    }
    return out;
}

export function combinedArtifactHash(arts: ArtifactHash[]): string {
    const h = crypto.createHash('sha256');
    for (const a of [...arts].sort((x, y) => x.path.localeCompare(y.path))) h.update(`${a.path}:${a.sha256}\n`);
    return h.digest('hex');
}

export function readJson<T = any>(p: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return undefined; }
}

export function writeJson(p: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

// ── protocol ────────────────────────────────────────────────────────────────

export function defaultProtocol(name: string, question: string): ConsensusProtocol {
    return {
        name,
        question,
        artifacts: [],
        panel: [
            { id: 'seat-a', transport: 'manual', role: 'e.g. reviewer A', note: 'set transport/provider in your protocol file' },
        ],
        rounds: DEFAULT_ROUNDS,
        convergence: DEFAULT_CONVERGENCE,
        requireRestate: true,
        requireRationaleForChange: true,
        dissentPolicy: 'record',
        classifyDisagreements: true,
        maxProviderCallsPerRound: 6,
    };
}

export function validateProtocol(p: any): string[] {
    const problems: string[] = [];
    if (!p || typeof p !== 'object') return ['protocol is not an object'];
    if (!p.name || typeof p.name !== 'string') problems.push('missing "name"');
    if (!p.question || typeof p.question !== 'string') problems.push('missing "question"');
    if (!Array.isArray(p.panel) || p.panel.length === 0) {
        problems.push('"panel" must be a non-empty array of seats');
    } else {
        const ids = new Set<string>();
        for (const s of p.panel) {
            if (!s?.id) { problems.push('a seat is missing "id"'); continue; }
            if (ids.has(s.id)) problems.push(`duplicate seat id "${s.id}"`);
            ids.add(s.id);
            if (s.transport !== 'provider' && s.transport !== 'manual') problems.push(`seat "${s.id}" transport must be "provider" or "manual"`);
            if (s.transport === 'provider' && !s.provider) problems.push(`seat "${s.id}" needs "provider" when transport is "provider"`);
        }
    }
    if (p.rounds != null && (!Number.isInteger(p.rounds) || p.rounds < 1 || p.rounds > 7)) problems.push('"rounds" must be an integer 1-7');
    if (p.convergence != null && !['unanimity', 'supermajority', 'rationale'].includes(p.convergence)) problems.push('"convergence" must be unanimity|supermajority|rationale');
    if (p.dissentPolicy != null && !['record', 'block'].includes(p.dissentPolicy)) problems.push('"dissentPolicy" must be record|block');
    return problems;
}

export function normalizeProtocol(p: any): ConsensusProtocol {
    return {
        ...p,
        rounds: p?.rounds ?? DEFAULT_ROUNDS,
        convergence: p?.convergence ?? DEFAULT_CONVERGENCE,
        requireRestate: p?.requireRestate ?? true,
        requireRationaleForChange: p?.requireRationaleForChange ?? true,
        dissentPolicy: p?.dissentPolicy ?? 'record',
        classifyDisagreements: p?.classifyDisagreements ?? true,
        artifacts: Array.isArray(p?.artifacts) ? p.artifacts : [],
        panel: Array.isArray(p?.panel) ? p.panel : [],
    };
}

// ── ledger ──────────────────────────────────────────────────────────────────

export function ledgerId(name: string, at: Date = new Date()): string {
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${stamp}-${slug}`;
}

export function newLedger(protocol: ConsensusProtocol, id: string, artifacts: ArtifactHash[], now: Date = new Date()): ConsensusLedger {
    return {
        id,
        protocol: protocol.name,
        question: protocol.question,
        createdAt: now.toISOString(),
        rounds: protocol.rounds ?? DEFAULT_ROUNDS,
        convergence: protocol.convergence ?? DEFAULT_CONVERGENCE,
        dissentPolicy: protocol.dissentPolicy ?? 'record',
        artifacts,
        snapshots: [{ at: now.toISOString(), artifactsHash: combinedArtifactHash(artifacts), note: 'ledger created' }],
        positions: [],
        agreements: [],
        disagreements: [],
        verdict: 'incomplete',
        notes: [],
    };
}

// ── prompts: the discipline that earns agreement ────────────────────────────

export function renderRound1Prompt(protocol: ConsensusProtocol, seat: ConsensusSeat): string {
    return [
        `You are seat "${seat.label ?? seat.id}" on a consensus panel${seat.role ? ` (role: ${seat.role})` : ''}.`,
        '',
        'QUESTION:',
        protocol.question,
        '',
        'Answer INDEPENDENTLY. Do not hedge toward an imagined consensus.',
        'Give: (1) your position, (2) your reasoning, (3) the facts you rely on,',
        '(4) which parts are matters of FACT vs VALUES/taste.',
        'If you are unsure, say so plainly rather than guessing.',
    ].join('\n');
}

export function renderPeerPrompt(
    protocol: ConsensusProtocol,
    seat: ConsensusSeat,
    round: number,
    peerAnswers: { seat: string; answer: string }[],
): string {
    const lines = [
        `Round ${round}. You are seat "${seat.label ?? seat.id}".`,
        '',
        'PEER POSITIONS:',
        ...peerAnswers.map(p => `\n— ${p.seat}:\n${p.answer}`),
        '',
        'RULES:',
    ];
    if (protocol.requireRestate) {
        lines.push('- FIRST restate each peer position in your own words, accurately enough that they would recognise it.');
    }
    lines.push('- THEN state where you AGREE and where you DISAGREE, with your reasons.');
    if (protocol.requireRationaleForChange) {
        lines.push('- If you CHANGE your position, cite the specific reason (new evidence, or a corrected step in reasoning). Social pressure alone is NOT a reason.');
    }
    lines.push('- For each disagreement, label it FACTS (settleable by evidence) or VALUES (a genuine preference that may persist).');
    lines.push('- If you still disagree, say so plainly. A recorded disagreement is a valid result.');
    return [protocol.question, '', ...lines].join('\n');
}

// ── classification / verdict / staleness ────────────────────────────────────

const VALUE_MARKERS = [/\bprefer\b/i, /\bvalue\b/i, /\btaste\b/i, /\bphilosoph/i, /\bshould\b/i, /\bpriority\b/i, /\btrade-?off\b/i, /\bethic/i, /\bmission\b/i, /\btolerab/i, /\bwe want\b/i];
const FACT_MARKERS = [/\bmeasured?\b/i, /\bbenchmark\b/i, /\bverified\b/i, /\bsource\b/i, /\bdata\b/i, /\bevidence\b/i, /\bpasses?\b/i, /\bfails?\b/i, /\bhash\b/i, /\bline \d+/i, /\breproduc/i, /\btested?\b/i, /\brouted?\b/i];

/** Best-effort classification of a disagreement statement. An explicit label always wins. */
export function classifyDisagreement(text: string, explicit?: DisagreementKind): DisagreementKind {
    if (explicit && explicit !== 'unknown') return explicit;
    const t = text ?? '';
    const hasValue = VALUE_MARKERS.some(r => r.test(t));
    const hasFact = FACT_MARKERS.some(r => r.test(t));
    if (hasFact && !hasValue) return 'facts';
    if (hasValue && !hasFact) return 'values';
    return 'unknown';
}

export function newDisagreement(topic: string, seats: string[], kind: DisagreementKind, evidence?: string): Disagreement {
    const id = crypto.createHash('sha1').update(`${topic}|${[...seats].sort().join(',')}`).digest('hex').slice(0, 10);
    return { id, topic, seats, kind, evidence };
}

export function positionsForRound(ledger: ConsensusLedger, round: number): SeatPosition[] {
    return ledger.positions.filter(p => p.round === round);
}

/** Unresolved disagreements (no `resolution`) determine the verdict. */
export function computeVerdict(ledger: ConsensusLedger): LedgerVerdict {
    const blocking = ledger.disagreements.filter(d => !d.resolution);
    if (blocking.length > 0) return 'disagreed';
    if (ledger.agreements.length > 0) return 'converged';
    return 'incomplete';
}

/** True when an artifact a verdict was bound to has changed since the ledger was written. */
export function isStale(ledger: ConsensusLedger, root: string): { stale: boolean; changed: string[] } {
    const current = hashArtifacts(ledger.artifacts.map(a => a.path), root);
    const byPath = new Map(current.map(a => [a.path, a.sha256]));
    const changed = ledger.artifacts.filter(a => byPath.get(a.path) !== a.sha256).map(a => a.path);
    return { stale: changed.length > 0, changed };
}
