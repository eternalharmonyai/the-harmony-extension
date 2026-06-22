/**
 * Deliberation Protocol — safe cross-role challenge system.
 * 
 * Roles can challenge each other's findings without zombie-auto-apply.
 * Challenges follow a strict FSM: raised → debated → escalated → resolved/withdrawn.
 * ALL code changes require human confirmation — patches are staged, never auto-applied.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { concertSpeak } from './concertHall';

function workspaceRoot(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
function uid(): string { return crypto.randomUUID().slice(0, 8); }
function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text.slice(0, 16000).trim() || '[empty]')]);
}

// ═══ Data Model ═══

export type ChallengeStatus = 'raised' | 'debated' | 'escalated' | 'resolved' | 'withdrawn';
export type ResolutionType = 'accepted' | 'rejected' | 'withdrawn' | 'merged';
export type EscalationTrigger = 'timeout' | 'stalemate' | 'high_severity_conflict' | 'false_positive_risk' | 'human_requested';

export interface EscalationPath {
    trigger: EscalationTrigger;
    escalatedAt: string; // ISO 8601
    targetRole: string;  // 'human' or 'coordinator'
    contextSummary: string;
}

export interface Resolution {
    type: ResolutionType;
    resolvedAt: string;
    resolvedByRole: string;
    reasoning: string;
    evidence: string[];
    stagedPatchId?: string; // Reference to .harmony/patches/[id].patch — NEVER auto-applied
}

export interface Challenge {
    challengeId: string;
    targetFindingId: string;
    sourceRole: string;
    targetRole: string;
    status: ChallengeStatus;
    severity: 'low' | 'medium' | 'high' | 'critical';
    confidence: number; // 0.0–1.0
    description: string;
    evidence: string[];
    turnCount: number;
    createdAt: number; // epoch ms — used for TTL
    escalation?: EscalationPath;
    resolution?: Resolution;
}

// ═══ FSM: Allowed Transitions ═══

const ALLOWED_TRANSITIONS: Record<ChallengeStatus, ChallengeStatus[]> = {
    raised: ['debated', 'withdrawn'],
    debated: ['debated', 'escalated', 'resolved', 'withdrawn'],
    escalated: ['resolved', 'withdrawn'],
    resolved: [],   // terminal
    withdrawn: [],  // terminal
};

function isTransitionAllowed(from: ChallengeStatus, to: ChallengeStatus): boolean {
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// ═══ Safety Constants ═══

const MAX_TURN_COUNT = 3;           // Auto-escalate after 3 debate turns
const CHALLENGE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_CHALLENGES_PER_MINUTE = 10;
const MAX_RECURSION_DEPTH = 3;      // Prevent infinite challenge-on-challenge loops
const MAX_PENDING_CHALLENGES = 100; // Global cap

// ═══ Persistence ═══

async function deliberationsDir(): Promise<string> {
    const root = workspaceRoot();
    if (!root) throw new Error('no workspace open');
    const dir = path.join(root, '.harmony', 'deliberations');
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

function challengePath(dir: string, challengeId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(challengeId)) throw new Error(`invalid challenge id: ${challengeId}`);
    return path.join(dir, `${challengeId}.json`);
}

/** Atomic write using temp-then-rename (TOCTOU-safe, matches concert hall pattern). */
async function writeChallengeAtomic(challenge: Challenge): Promise<void> {
    const dir = await deliberationsDir();
    const dest = challengePath(dir, challenge.challengeId);
    const tmp = dest + '.tmp';
    const buf = Buffer.from(JSON.stringify(challenge, null, 2), 'utf8');
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, dest);
}

async function readChallenge(challengeId: string): Promise<Challenge | null> {
    try {
        const dir = await deliberationsDir();
        const raw = await fs.readFile(challengePath(dir, challengeId), 'utf8');
        return JSON.parse(raw) as Challenge;
    } catch {
        return null;
    }
}

async function listActiveChallenges(): Promise<Challenge[]> {
    try {
        const dir = await deliberationsDir();
        const entries = await fs.readdir(dir);
        const challenges: Challenge[] = [];
        for (const entry of entries) {
            if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
            try {
                const raw = await fs.readFile(path.join(dir, entry), 'utf8');
                const c = JSON.parse(raw) as Challenge;
                if (c.status !== 'resolved' && c.status !== 'withdrawn') {
                    challenges.push(c);
                }
            } catch { /* skip corrupt files */ }
        }
        return challenges;
    } catch {
        return [];
    }
}

// ═══ Rate Limiting (in-memory, per-session) ═══

const challengeTimestamps: number[] = [];

function checkRateLimit(): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = now - 60_000;
    // Prune old entries
    while (challengeTimestamps.length > 0 && challengeTimestamps[0] < windowStart) {
        challengeTimestamps.shift();
    }
    if (challengeTimestamps.length >= MAX_CHALLENGES_PER_MINUTE) {
        const oldest = challengeTimestamps[0];
        return { allowed: false, retryAfterMs: oldest + 60_000 - now + 100 };
    }
    challengeTimestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
}

// ═══ State Transition with Audit + Concert Hall Post ═══

async function transitionChallenge(
    challenge: Challenge,
    newStatus: ChallengeStatus,
    actorRole: string,
    reason: string,
    extra?: Partial<Challenge>
): Promise<Challenge> {
    if (!isTransitionAllowed(challenge.status, newStatus)) {
        throw new Error(
            `Invalid transition: ${challenge.status} → ${newStatus}. ` +
            `Allowed from ${challenge.status}: ${ALLOWED_TRANSITIONS[challenge.status]?.join(', ') || 'none'}`
        );
    }
    const updated: Challenge = { ...challenge, ...extra, status: newStatus };
    await writeChallengeAtomic(updated);
    // Post to concert hall for visibility
    try {
        await concertSpeak(
            'deliberations',
            actorRole,
            JSON.stringify({
                challengeId: updated.challengeId,
                transition: `${challenge.status} → ${newStatus}`,
                reason,
                actor: actorRole,
            })
        );
    } catch { /* non-critical */ }
    return updated;
}

// ═══ Escalation Check ═══

function checkEscalation(challenge: Challenge): EscalationTrigger | null {
    // Timeout: exceeded max debate turns
    if (challenge.turnCount > MAX_TURN_COUNT) return 'timeout';
    // High severity + high confidence from both sides = escalate
    if (challenge.severity === 'critical' && challenge.confidence > 0.8) {
        return 'high_severity_conflict';
    }
    // Stalemate detection would require comparing debate messages via concert hall
    // (implemented in harmony_convergence_arbiter integration)
    return null;
}

// ═══ Tool: harmony_deliberation_challenge ═══

export interface DeliberationChallengeInput {
    action: 'raise' | 'debate' | 'resolve' | 'withdraw' | 'list';
    targetFindingId?: string;
    challengeId?: string;
    sourceRole?: string;
    targetRole?: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    confidence?: number;
    description?: string;
    evidence?: string[];
    resolutionType?: ResolutionType;
    reasoning?: string;
}

export class DeliberationChallengeTool implements vscode.LanguageModelTool<DeliberationChallengeInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DeliberationChallengeInput>,
        _token: vscode.CancellationToken
    ) {
        const input = options.input;
        const role = input.sourceRole || 'unknown';

        // ── List ──
        if (input.action === 'list') {
            const active = await listActiveChallenges();
            if (active.length === 0) return textResult('No active deliberations.');
            const summary = active.map(c =>
                `[${c.challengeId}] ${c.status} | ${c.severity} | ${c.sourceRole}→${c.targetRole} | "${c.description.slice(0, 80)}" | turns:${c.turnCount}`
            ).join('\n');
            return textResult(`${active.length} active deliberation(s):\n${summary}`);
        }

        // ── Raise ──
        if (input.action === 'raise') {
            // Rate limit
            const rl = checkRateLimit();
            if (!rl.allowed) {
                return textResult(`Rate limited. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`);
            }
            // Evidence gate
            if (!input.evidence || input.evidence.length === 0) {
                return textResult('error: evidence required. Provide at least one file path, line number, or code snippet.');
            }
            if (!input.targetFindingId || !input.description || !input.targetRole) {
                return textResult('error: targetFindingId, description, and targetRole are required to raise a challenge.');
            }
            // Global pending cap
            const active = await listActiveChallenges();
            if (active.length >= MAX_PENDING_CHALLENGES) {
                return textResult(`error: too many pending challenges (${active.length}/${MAX_PENDING_CHALLENGES}). Resolve or withdraw some first.`);
            }

            const challenge: Challenge = {
                challengeId: `dlb-${uid()}`,
                targetFindingId: input.targetFindingId,
                sourceRole: role,
                targetRole: input.targetRole,
                status: 'raised',
                severity: input.severity || 'medium',
                confidence: input.confidence ?? 0.5,
                description: input.description,
                evidence: input.evidence.slice(0, 10), // cap evidence entries
                turnCount: 1,
                createdAt: Date.now(),
            };
            await writeChallengeAtomic(challenge);
            try {
                await concertSpeak('deliberations', role,
                    `⚡ CHALLENGE RAISED [${challenge.challengeId}] ${role}→${input.targetRole}: ${input.description.slice(0, 200)}`
                );
            } catch { /* non-critical */ }
            return textResult(JSON.stringify({
                challengeId: challenge.challengeId,
                status: challenge.status,
                message: `Challenge raised against finding ${input.targetFindingId}. Next: ${input.targetRole} should debate or the coordinator may escalate.`,
                requiresHumanIntervention: false,
                nextTurnRole: input.targetRole,
            }, null, 2));
        }

        // ── Debate ──
        if (input.action === 'debate') {
            if (!input.challengeId || !input.reasoning) {
                return textResult('error: challengeId and reasoning are required to debate.');
            }
            const challenge = await readChallenge(input.challengeId);
            if (!challenge) return textResult(`error: challenge ${input.challengeId} not found.`);
            if (challenge.status !== 'raised' && challenge.status !== 'debated') {
                return textResult(`error: cannot debate challenge in status "${challenge.status}".`);
            }
            // TTL check
            if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) {
                const resolved = await transitionChallenge(challenge, 'resolved', 'system',
                    'TTL expired', { resolution: { type: 'rejected', resolvedAt: new Date().toISOString(), resolvedByRole: 'system', reasoning: 'Challenge timed out.', evidence: [] } });
                return textResult(JSON.stringify({ challengeId: resolved.challengeId, status: resolved.status, message: 'Challenge timed out (48h TTL). Auto-resolved as rejected.' }, null, 2));
            }
            // Recursion depth check
            if (challenge.turnCount >= MAX_RECURSION_DEPTH + MAX_TURN_COUNT) {
                const escalated = await transitionChallenge(challenge, 'escalated', role,
                    'Max debate depth reached', { turnCount: challenge.turnCount + 1, escalation: { trigger: 'stalemate', escalatedAt: new Date().toISOString(), targetRole: 'human', contextSummary: input.reasoning.slice(0, 200) } });
                return textResult(JSON.stringify({ challengeId: escalated.challengeId, status: escalated.status, message: 'Max depth reached. Escalated to human.', requiresHumanIntervention: true, nextTurnRole: 'human' }, null, 2));
            }
            // Advance debate
            const debated = await transitionChallenge(challenge, 'debated', role,
                input.reasoning.slice(0, 500), { turnCount: challenge.turnCount + 1 });
            // Check auto-escalation
            const escalateTrigger = checkEscalation(debated);
            if (escalateTrigger) {
                const escalated = await transitionChallenge(debated, 'escalated', 'system',
                    `Auto-escalation: ${escalateTrigger}`, {
                        escalation: {
                            trigger: escalateTrigger,
                            escalatedAt: new Date().toISOString(),
                            targetRole: 'human',
                            contextSummary: `${debated.turnCount} turns, confidence=${debated.confidence}`
                        }
                    });
                return textResult(JSON.stringify({ challengeId: escalated.challengeId, status: escalated.status, message: `Auto-escalated (${escalateTrigger}). Requires human intervention.`, requiresHumanIntervention: true, nextTurnRole: 'human' }, null, 2));
            }
            return textResult(JSON.stringify({ challengeId: debated.challengeId, status: debated.status, message: `Debate turn ${debated.turnCount}. ${debated.turnCount >= MAX_TURN_COUNT ? 'Next turn will auto-escalate.' : 'Continue debating or resolve.'}`, requiresHumanIntervention: false, nextTurnRole: debated.sourceRole === role ? debated.targetRole : debated.sourceRole }, null, 2));
        }

        // ── Resolve ──
        if (input.action === 'resolve') {
            if (!input.challengeId || !input.resolutionType || !input.reasoning) {
                return textResult('error: challengeId, resolutionType, and reasoning are required to resolve.');
            }
            const challenge = await readChallenge(input.challengeId);
            if (!challenge) return textResult(`error: challenge ${input.challengeId} not found.`);
            if (challenge.status === 'resolved' || challenge.status === 'withdrawn') {
                return textResult(`error: challenge already ${challenge.status}.`);
            }
            const resolution: Resolution = {
                type: input.resolutionType,
                resolvedAt: new Date().toISOString(),
                resolvedByRole: role,
                reasoning: input.reasoning,
                evidence: input.evidence || [],
                // accepted → stage a patch id (never auto-apply)
                stagedPatchId: input.resolutionType === 'accepted' ? `patch-${uid()}` : undefined,
            };
            const resolved = await transitionChallenge(challenge, 'resolved', role,
                `Resolved as ${input.resolutionType}: ${input.reasoning.slice(0, 200)}`,
                { resolution });
            const msg = input.resolutionType === 'accepted'
                ? `Resolved ACCEPTED. Staged patch ${resolution.stagedPatchId} — REQUIRES HUMAN CONFIRMATION to apply.`
                : `Resolved ${input.resolutionType}. No code changes needed.`;
            return textResult(JSON.stringify({ challengeId: resolved.challengeId, status: resolved.status, message: msg, requiresHumanIntervention: input.resolutionType === 'accepted', nextTurnRole: 'human' }, null, 2));
        }

        // ── Withdraw ──
        if (input.action === 'withdraw') {
            if (!input.challengeId) {
                return textResult('error: challengeId is required to withdraw.');
            }
            const challenge = await readChallenge(input.challengeId);
            if (!challenge) return textResult(`error: challenge ${input.challengeId} not found.`);
            if (challenge.status === 'resolved' || challenge.status === 'withdrawn') {
                return textResult(`error: challenge already ${challenge.status}.`);
            }
            const withdrawn = await transitionChallenge(challenge, 'withdrawn', role,
                input.reasoning || 'Withdrawn by challenger',
                { resolution: { type: 'withdrawn', resolvedAt: new Date().toISOString(), resolvedByRole: role, reasoning: input.reasoning || 'Withdrawn', evidence: [] } });
            return textResult(JSON.stringify({ challengeId: withdrawn.challengeId, status: withdrawn.status, message: 'Challenge withdrawn. Original finding stands.', requiresHumanIntervention: false, nextTurnRole: 'none' }, null, 2));
        }

        return textResult(`error: unknown action "${(input as any).action}". Use raise, debate, resolve, withdraw, or list.`);
    }
}

// ═══ Integration helpers (called from swarmPrimitives / swarmTools) ═══

/** Called by AdversarialCriticTool / ConvergenceArbiterTool to auto-raise a challenge. */
export async function raiseDeliberationChallenge(
    sourceRole: string,
    targetRole: string,
    targetFindingId: string,
    description: string,
    evidence: string[],
    severity: 'low' | 'medium' | 'high' | 'critical' = 'medium',
    confidence: number = 0.5,
): Promise<Challenge | null> {
    const rl = checkRateLimit();
    if (!rl.allowed) return null;
    if (!evidence || evidence.length === 0) return null;
    const active = await listActiveChallenges();
    if (active.length >= MAX_PENDING_CHALLENGES) return null;
    const challenge: Challenge = {
        challengeId: `dlb-${uid()}`,
        targetFindingId,
        sourceRole,
        targetRole,
        status: 'raised',
        severity,
        confidence,
        description,
        evidence: evidence.slice(0, 10),
        turnCount: 1,
        createdAt: Date.now(),
    };
    await writeChallengeAtomic(challenge);
    try {
        await concertSpeak('deliberations', sourceRole,
            `⚡ AUTO-CHALLENGE [${challenge.challengeId}] ${sourceRole}→${targetRole}: ${description.slice(0, 200)}`
        );
    } catch { /* non-critical */ }
    return challenge;
}

/** Post a challenge update to the concert hall for sidebar visibility. */
export async function postChallengeUpdate(
    challengeId: string,
    status: ChallengeStatus,
    summary: string,
    actorRole: string
): Promise<void> {
    try {
        await concertSpeak('deliberations', actorRole,
            JSON.stringify({ challengeId, status, summary, actor: actorRole, ts: Date.now() })
        );
    } catch { /* non-critical */ }
}

/** Get active deliberations for sidebar enrichment. */
export async function getActiveDeliberations(): Promise<Challenge[]> {
    return listActiveChallenges();
}

// ═══ Swarm integration stubs (called from swarmTools.ts) ═══

// Generic finding type compatible with both swarmTools.ts CriticFinding
// and swarmPrimitives.ts HardenedCriticFinding
interface GenericFinding {
    severity?: string;
    confidence_0_to_1?: number;
    confidence?: number;
    evidence?: { line_number?: number; code_snippet?: string; pattern?: string };
    dimension?: string;
    description?: string;
    claim?: string;
}

export interface DeliberationRecord {
    turnId: string;
    findings: any[];
    createdAt: number;
    approvalRequired?: boolean;
}

const deliberationRecords = new Map<string, DeliberationRecord>();

export function createDeliberationRecord(turnId: string): DeliberationRecord {
    const record: DeliberationRecord = { turnId, findings: [], createdAt: Date.now() };
    deliberationRecords.set(turnId, record);
    return record;
}

export function gateAllFindings(findings: any[]): { gated: any[]; filtered: number } {
    const gated = findings.filter((f: any) => {
        const ev = f.evidence;
        const hasEvidence = ev && (ev.line_number || ev.code_snippet || ev.pattern || (Array.isArray(ev) && ev.length > 0));
        const conf = f.confidence_0_to_1 ?? (f.confidence ? f.confidence / 100 : 0);
        const hasConfidence = conf >= 0.3;
        return hasEvidence && hasConfidence;
    });
    return { gated, filtered: findings.length - gated.length };
}

export async function postFindingToDeliberation(turnId: string, role: string, finding: any): Promise<void> {
    const record = deliberationRecords.get(turnId);
    if (record) record.findings.push(finding);
    try {
        await concertSpeak('deliberations', role,
            JSON.stringify({ turnId, finding: finding.description?.slice(0, 200) || finding.claim?.slice(0, 200), severity: finding.severity, confidence: finding.confidence_0_to_1 ?? finding.confidence })
        );
    } catch { /* non-critical */ }
}

export async function checkDeliberationRoom(turnId: string): Promise<string[]> {
    try {
        const { concertCheck } = await import('./concertHall');
        const result = await concertCheck(['deliberations']);
        return (result?.messages || []).map(m => `[${m.from}] ${m.body.slice(0, 200)}`);
    } catch {
        return [];
    }
}

export function formatDeliberationSummary(record: DeliberationRecord): string {
    const { gated } = gateAllFindings(record.findings);
    if (gated.length === 0) return 'No evidence-backed findings to deliberate.';
    return gated.map((f: any) =>
        `- [${f.severity || '?'}] ${f.dimension || f.claim?.slice(0, 40) || '?'}: ${(f.description || f.claim || '').slice(0, 100)} (confidence: ${f.confidence_0_to_1 ?? (f.confidence ? f.confidence / 100 : '?')})`
    ).join('\n');
}

export function requiresHumanEscalation(record: DeliberationRecord): boolean {
    const { gated } = gateAllFindings(record.findings);
    return gated.some((f: any) =>
        (f.severity === 'critical' || f.severity === 'blocker') &&
        (f.confidence_0_to_1 ?? (f.confidence ? f.confidence / 100 : 0)) > 0.8
    );
}

export function getUnresolvedEscalations(record: DeliberationRecord): any[] {
    const { gated } = gateAllFindings(record.findings);
    return gated.filter((f: any) =>
        f.severity === 'critical' || f.severity === 'blocker' ||
        (f.confidence_0_to_1 ?? (f.confidence ? f.confidence / 100 : 0)) > 0.8
    );
}
