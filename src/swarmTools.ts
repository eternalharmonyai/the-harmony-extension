import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as os from 'os';
import { confirmPremiumModel, consult, listAvailableProviders, modelFor, ProviderId, Tier } from './providers';
import { estimateCost } from './costTracker';
import { withOperationLock } from './operationLocks';
import { concertSpeak, concertCheck, formatConcertCheck } from './concertHall';
import { createDeliberationRecord, gateAllFindings, postFindingToDeliberation, checkDeliberationRoom, formatDeliberationSummary, requiresHumanEscalation, getUnresolvedEscalations } from './deliberation';

const MAX_RESULT_CHARS = 60000;
const SWARM_DIR = '.harmony/swarm';
const CUSTOM_ROLES_PATH = '.harmony/swarm/custom-roles.json';
const PRIVATE_PLANNING_EXT = `.${'fa'}${'mily'}.md`;

// ── Custom Roles ────────────────────────────────────────────────────────
// Stored in .harmony/swarm/custom-roles.json.
// Users can define new swarm roles with tool permissions, tier defaults,
// provider preferences, evidence requirements, and auto-join concert rooms.

interface CustomRoleDefinition {
    id: string;
    label: string;
    purpose: string;
    toolPermissions: string[];
    tierDefaults?: { provider: string; tier: string };
    providerPreferences?: string[];
    requiresEvidence?: boolean;
    concertRoom?: string;
}

async function loadCustomRoles(): Promise<CustomRoleDefinition[]> {
    const root = workspaceRoot();
    if (!root) return [];
    try {
        const raw = await fs.readFile(path.join(root, CUSTOM_ROLES_PATH), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((r: any) => typeof r?.id === 'string' && typeof r?.label === 'string' && typeof r?.purpose === 'string' && Array.isArray(r?.toolPermissions));
    } catch { return []; }
}

function customRoleToSwarmRole(cr: CustomRoleDefinition): SwarmRole {
    return {
        id: cr.id as SwarmRoleId,
        label: cr.label,
        purpose: cr.purpose,
        allowedToolClasses: cr.toolPermissions,
        forbidden: ['direct file writes without evidence', 'unsourced claims'],
        outputContract: cr.requiresEvidence ? 'Evidence-gated finding with source citations and confidence score.' : `${cr.label} summary with recommended next action.`
    };
}

// ── Critic Hardening ────────────────────────────────────────────────────
// Every finding from Verifier/Critic must follow this evidence-gated format.
// Findings without source/evidence at low confidence are downgraded to observation.

interface CriticFinding {
    claim: string;
    confidence: number;  // 0-100, ≥90 near-certain, <50 speculative
    evidence: string[];
    counterevidence: string[];
    severity: 'blocker' | 'risk' | 'observation' | 'style';
    source: string;  // MUST cite specific file:line or verifiable behavior
}

let fixtureWorkspaceRoot: string | undefined;
let fixtureSafetySwitches: Record<string, boolean> | undefined;

type SwarmMode = 'plan_only' | 'read_only_probes' | 'execution_guarded';
type RiskTolerance = 'low' | 'medium' | 'high';
type SwarmRoleId = 'coordinator' | 'researcher' | 'project_scout' | 'designer' | 'implementer' | 'verifier' | 'cost_sentinel';

interface SwarmPlanInput {
    objective: string;
    mode?: SwarmMode;
    scope_paths?: string[];
    roles?: SwarmRoleId[];
    risk_tolerance?: RiskTolerance;
    max_cost_usd?: number;
    max_steps?: number;
    max_writes?: number;
    max_terminal_commands?: number;
    write_receipt?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmReceiptsInput {
    action?: 'list' | 'read';
    turn_id?: string;
    limit?: number;
    format?: 'markdown' | 'json';
}

interface SwarmPreflightInput {
    turn_id?: string;
    intended_action?: 'read_only_probes' | 'mutation_escrow' | 'execution';
    require_fresh_pricing?: boolean;
    max_pricing_age_days?: number;
    format?: 'markdown' | 'json';
}

interface SwarmEscrowInput {
    turn_id?: string;
    title: string;
    proposal_type?: 'patch' | 'terminal' | 'provider_call';
    target_paths?: string[];
    summary: string;
    validation_plan: string[];
    rollback_plan?: string;
    estimated_cost_usd?: number;
    risk_tolerance?: RiskTolerance;
    write_proposal?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmDispatchInput {
    turn_id?: string;
    roles?: SwarmRoleId[];
    source_urls?: string[];
    page_url?: string;
    provider?: ProviderId;
    tier?: Tier;
    enable_provider_fanout?: boolean;
    max_tokens?: number;
    write_receipt?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmExecuteInput {
    turn_id?: string;
    proposal_id?: string;
    dry_run?: boolean;
    patch_text?: string;
    terminal_command?: string;
    provider?: ProviderId;
    tier?: Tier;
    question?: string;
    max_tokens?: number;
    write_receipt?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmAutonomyDesignInput {
    objective?: string;
    max_parallel_proposals?: number;
    allow_commits?: boolean;
    write_design?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmProposalExecutionPayload {
    proposal_id: string;
    patch_text?: string;
    terminal_command?: string;
    provider?: ProviderId;
    tier?: Tier;
    question?: string;
    max_tokens?: number;
}

interface SwarmAutonomyRunInput {
    turn_id?: string;
    mode?: 'plan' | 'dry_run' | 'execute';
    proposal_ids?: string[];
    proposal_payloads?: SwarmProposalExecutionPayload[];
    max_proposals?: number;
    max_steps?: number;
    max_provider_calls?: number;
    max_runtime_seconds?: number;
    checkpoint_each_step?: boolean;
    validation_command?: string;
    require_clean_git?: boolean;
    allow_terminal_proposals?: boolean;
    allow_provider_calls?: boolean;
    commit_mode?: 'none' | 'proposal_receipt';
    commit_message?: string;
    confirm_execute?: boolean;
    write_receipt?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmCommitDryRunInput {
    turn_id?: string;
    autonomy_run_id?: string;
    proposal_ids?: string[];
    commit_message?: string;
    validation_command?: string;
    snapshot_receipt_path?: string;
    require_clean_manifest?: boolean;
    write_receipt?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmCommitExecuteInput {
    turn_id?: string;
    dry_run_id?: string;
    dry_run_receipt_path?: string;
    commit_message?: string;
    validation_command?: string;
    snapshot_receipt_path?: string;
    require_clean_manifest?: boolean;
    confirm_execute?: boolean;
    write_receipt?: boolean;
    format?: 'markdown' | 'json';
}

interface SwarmRole {
    id: SwarmRoleId;
    label: string;
    purpose: string;
    allowedToolClasses: string[];
    forbidden: string[];
    outputContract: string;
}

interface SwarmBudget {
    maxCostUsd: number;
    maxSteps: number;
    maxWrites: number;
    maxTerminalCommands: number;
}

interface SwarmReceipt {
    version: 1;
    turnId: string;
    createdAt: string;
    objective: string;
    requestedMode: SwarmMode;
    executionEnabled: boolean;
    riskTolerance: RiskTolerance;
    scopePaths: string[];
    blockedScopePaths: string[];
    roles: SwarmRole[];
    budget: SwarmBudget;
    lockIntents: string[];
    safetyGates: string[];
    mutationEscrow: string[];
    verificationGates: string[];
    stopConditions: string[];
    nextToolPlan: string[];
}

interface SwarmPreflightCheck {
    status: 'pass' | 'warn' | 'block';
    message: string;
}

interface SwarmEscrowProposal {
    version: 1;
    proposalId: string;
    turnId: string;
    createdAt: string;
    title: string;
    proposalType: 'patch' | 'terminal' | 'provider_call';
    targetPaths: string[];
    blockedTargetPaths: string[];
    summary: string;
    validationPlan: string[];
    rollbackPlan?: string;
    estimatedCostUsd: number;
    riskTolerance: RiskTolerance;
    applied: boolean;
    executionEnabled: boolean;
    notes: string[];
}

interface SwarmExecutionReceipt {
    version: 1;
    executionId: string;
    turnId: string;
    proposalId: string;
    createdAt: string;
    dryRun: boolean;
    proposalType: 'patch' | 'terminal' | 'provider_call';
    targetPaths: string[];
    status: 'executed' | 'dry_run' | 'blocked' | 'failed';
    writesApplied: number;
    terminalCommandsRun: number;
    providerCallsRun: number;
    providerCallLimit: number;
    provider?: ProviderId;
    tier?: Tier;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    proposalEstimatedCostUsd: number;
    estimatedCostUsd?: number;
    costBudgetUsd?: number;
    costBudgetRemainingUsd?: number;
    budgetWithinLimit: boolean;
    costEstimateSource: 'proposal' | 'actual_estimate' | 'not_provider_call';
    budgetProof: string[];
    output: string;
    validationPlan: string[];
    receiptPath?: string;
}

interface SwarmAutonomyStepResult {
    proposalId: string;
    proposalType: 'patch' | 'terminal' | 'provider_call';
    status: 'planned' | 'dry_run' | 'executed' | 'blocked' | 'failed' | 'validation_failed' | 'skipped';
    output: string;
    validationOutput?: string;
    writesApplied: number;
    terminalCommandsRun: number;
    providerCallsRun: number;
}

interface SwarmAutonomyCheckpoint {
    at: string;
    reason: string;
    stepCount: number;
    totals: {
        writesApplied: number;
        terminalCommandsRun: number;
        providerCallsRun: number;
    };
    receiptPath?: string;
}

interface SwarmAutonomyRunReceipt {
    version: 1;
    runId: string;
    turnId: string;
    createdAt: string;
    mode: 'plan' | 'dry_run' | 'execute';
    status: 'planned' | 'completed' | 'blocked' | 'failed' | 'validation_failed';
    maxProposals: number;
    budgets: {
        maxProposals: number;
        maxSteps: number;
        maxProviderCalls: number;
        maxRuntimeSeconds: number;
    };
    validationCommand?: string;
    requireCleanGit: boolean;
    commitMode: 'none' | 'proposal_receipt';
    commitProposalPath?: string;
    steps: SwarmAutonomyStepResult[];
    totals: {
        writesApplied: number;
        terminalCommandsRun: number;
        providerCallsRun: number;
    };
    checkpoints: SwarmAutonomyCheckpoint[];
    hardStops: string[];
    notes: string[];
    resumeHint: string;
    receiptPath?: string;
}

interface SwarmCommitDryRunReceipt {
    version: 1;
    dryRunId: string;
    turnId: string;
    autonomyRunId?: string;
    createdAt: string;
    status: 'ready' | 'blocked' | 'failed';
    commitMessage: string;
    includedProposalIds: string[];
    manifestPaths: string[];
    validationCommand?: string;
    snapshotRequirement: {
        required: boolean;
        status: 'provided' | 'missing';
        receiptPath?: string;
    };
    preflightDecision: 'GO' | 'CAUTION' | 'NO-GO';
    checks: string[];
    git: Record<string, ProcessRun>;
    unexpectedStatusPaths: string[];
    blockedPaths: string[];
    notes: string[];
    receiptPath?: string;
}

interface SwarmCommitExecutionReceipt {
    version: 1;
    executionId: string;
    turnId: string;
    dryRunId: string;
    createdAt: string;
    status: 'committed' | 'blocked' | 'failed' | 'validation_failed';
    commitMessage: string;
    commitHash?: string;
    manifestPaths: string[];
    snapshotReceiptPath: string;
    snapshotReceipt?: SnapshotReceiptValidation;
    validationCommand: string;
    validationOutput?: string;
    preflightDecision: 'GO' | 'CAUTION' | 'NO-GO';
    checks: string[];
    git: Record<string, ProcessRun>;
    stagedPaths: string[];
    unexpectedStatusPaths: string[];
    blockedPaths: string[];
    notes: string[];
    receiptPath?: string;
}

interface SnapshotReceiptValidation {
    status: 'valid' | 'invalid';
    receiptPath: string;
    manifestPath?: string;
    snapshotId?: string;
    restoreCommand?: string;
    copiedPaths: string[];
    missingManifestPaths: string[];
    issues: string[];
}

interface SwarmDispatchRoleResult {
    role: SwarmRoleId;
    status: 'ran' | 'skipped' | 'blocked' | 'provider_failed';
    summary: string;
    toolOutputs: string[];
    provider?: ProviderId;
    model?: string;
    providerText?: string;
    estimatedCostUsd?: number;
    criticFindings?: CriticFinding[];  // Evidence-gated findings for verifier/critic roles
}

interface SwarmDispatchReceipt {
    version: 1;
    dispatchId: string;
    turnId: string;
    createdAt: string;
    mode: 'read_only_probes';
    objective: string;
    providerFanoutEnabled: boolean;
    roles: SwarmDispatchRoleResult[];
    totalEstimatedCostUsd: number;
    executionEnabled: false;
    writesApplied: 0;
    terminalCommandsRun: 0;
    notes: string[];
}

interface PricingSnapshotSummary {
    fetchedAt?: string;
    staleAfterDays?: number;
}

interface LockRecordSummary {
    resource?: string;
    operation?: string;
    createdAt?: string;
    expiresAt?: string;
    file: string;
}

const ROLE_LIBRARY: Record<SwarmRoleId, SwarmRole> = {
    coordinator: {
        id: 'coordinator',
        label: 'Coordinator',
        purpose: 'Owns the plan, sequencing, lock decisions, and final answer.',
        allowedToolClasses: ['read-only registry/status tools', 'receipt review', 'ask-question gates'],
        forbidden: ['direct file writes', 'direct terminal execution', 'secret printing'],
        outputContract: 'Decision memo with approved next step, blocked risks, and whether mutation escrow may advance.'
    },
    researcher: {
        id: 'researcher',
        label: 'Researcher',
        purpose: 'Gathers current external evidence and source freshness before claims or provider choices.',
        allowedToolClasses: ['harmony_current_research', 'harmony_source_ledger', 'harmony_pricing_refresh with write controls'],
        forbidden: ['unsourced claims', 'cost quotes from stale snapshots', 'workspace writes outside source ledgers/snapshots'],
        outputContract: 'Source-backed findings with fetched time, source URLs, contradictions, and confidence limits.'
    },
    project_scout: {
        id: 'project_scout',
        label: 'Project Scout',
        purpose: 'Maps the local project before implementation decisions.',
        allowedToolClasses: ['harmony_repo_map', 'harmony_dependency_audit', 'read/list/grep/status/diff'],
        forbidden: ['installing packages', 'changing files', 'running broad commands without coordinator approval'],
        outputContract: 'Repo map, likely controlling files, cheap validation checks, and blast-radius notes.'
    },
    designer: {
        id: 'designer',
        label: 'Designer',
        purpose: 'Reviews real website/UI state across DOM, screenshots, accessibility, and responsive behavior.',
        allowedToolClasses: ['harmony_page_inspect', 'harmony_design_audit', 'harmony_responsive_screenshots with write controls', 'harmony_lighthouse'],
        forbidden: ['visual claims without a real page or screenshot when one is available', 'decorative redesigns outside scope'],
        outputContract: 'Prioritized UI/a11y/layout risks with screenshots or DOM signals and one recommended fix at a time.'
    },
    implementer: {
        id: 'implementer',
        label: 'Implementer',
        purpose: 'Turns approved findings into exact mutation proposals.',
        allowedToolClasses: ['harmony_patch_preflight', 'harmony_code_surgery_plan', 'patch proposal text'],
        forbidden: ['direct writes in this swarm scaffold', 'multi-file rewrites without coordinator lock approval'],
        outputContract: 'Escrow proposal: exact files, old/new intent, lock resources, validation command, rollback note.'
    },
    verifier: {
        id: 'verifier',
        label: 'Verifier',
        purpose: 'Checks every mutation before the next mutation is allowed.',
        allowedToolClasses: ['compile/test/lint commands after coordinator approval', 'git diff/status', 'screenshots', 'Lighthouse'],
        forbidden: ['fixing while verifying', 'continuing after failed validation without coordinator decision'],
        outputContract: 'Validation receipt with command/tool used, result, failure summary, and next gate decision.'
    },
    cost_sentinel: {
        id: 'cost_sentinel',
        label: 'Cost Sentinel',
        purpose: 'Keeps provider/model/tool spend visible before expensive work.',
        allowedToolClasses: ['harmony_provider_status', 'harmony_pricing_refresh', 'harmony_cost_estimator'],
        forbidden: ['premium model fan-out without a fresh source snapshot', 'spend above budget without user confirmation'],
        outputContract: 'Cost/budget note with fresh/stale provider status, estimated spend, and stop threshold.'
    }
};

function clip(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function workspaceFoldersByPriority(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (!activeFolder) return folders;
    return [activeFolder, ...folders.filter(folder => folder.uri.toString() !== activeFolder.uri.toString())];
}

function workspaceRoot(): string | undefined {
    if (fixtureWorkspaceRoot) return fixtureWorkspaceRoot;
    return workspaceFoldersByPriority()[0]?.uri.fsPath;
}

function relPath(absPath: string): string {
    const root = workspaceRoot();
    return root ? path.relative(root, absPath).replace(/\\/g, '/') || '.' : absPath;
}

function planOnlyMode(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
}

function swarmSafetySwitch(key: string, defaultValue = false): boolean {
    if (fixtureSafetySwitches && Object.prototype.hasOwnProperty.call(fixtureSafetySwitches, key)) return fixtureSafetySwitches[key];
    return vscode.workspace.getConfiguration('harmony').get<boolean>(`swarm.${key}`) ?? defaultValue;
}

function disabledSwarmSwitchMessage(key: string, action: string): string {
    return `error: ${action} is disabled by harmony.swarm.${key}=false. Enable it intentionally in settings before running this dangerous swarm path.`;
}

function validationCommandExecutionBlock(): string | undefined {
    if (!swarmSafetySwitch('terminalExecution.enabled')) return disabledSwarmSwitchMessage('terminalExecution.enabled', 'swarm validation command execution');
    return undefined;
}

function swarmProposalExecutionBlock(proposalType: SwarmEscrowProposal['proposalType']): string | undefined {
    if (!swarmSafetySwitch('mutationExecution.enabled')) return disabledSwarmSwitchMessage('mutationExecution.enabled', 'swarm mutation execution');
    if (proposalType === 'patch' && !swarmSafetySwitch('patchExecution.enabled')) return disabledSwarmSwitchMessage('patchExecution.enabled', 'swarm patch execution');
    if (proposalType === 'terminal' && !swarmSafetySwitch('terminalExecution.enabled')) return disabledSwarmSwitchMessage('terminalExecution.enabled', 'swarm terminal execution');
    if (proposalType === 'provider_call' && !swarmSafetySwitch('providerCalls.enabled')) return disabledSwarmSwitchMessage('providerCalls.enabled', 'swarm provider calls');
    return undefined;
}

function section(title: string, body: string | string[]): string {
    return `## ${title}\n\n${Array.isArray(body) ? (body.length ? body.map(item => `- ${item}`).join('\n') : '- (none)') : body}`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function makeTurnId(): string {
    return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeScopePath(inputPath: string): string {
    return inputPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim();
}

function safeSwarmId(input: string): string {
    return input.replace(/[^a-zA-Z0-9._-]/g, '');
}

function isBlockedScopePath(inputPath: string): boolean {
    const lower = normalizeScopePath(inputPath).toLowerCase();
    return lower.includes('/.harmony/') || lower.startsWith('.harmony/') || lower.endsWith(PRIVATE_PLANNING_EXT) || lower.includes('/.git/') || lower.startsWith('.git/');
}

function isSecretLookingPath(inputPath: string): boolean {
    const lower = normalizeScopePath(inputPath).toLowerCase();
    return lower === '.env'
        || lower.endsWith('/.env')
        || lower.includes('secret')
        || lower.includes('token')
        || lower.includes('credential')
        || lower.includes('apikey')
        || lower.includes('api-key')
        || lower.includes('private')
        || lower.includes('id_rsa');
}

function uniqueSorted(items: string[]): string[] {
    return Array.from(new Set(items.map(normalizeScopePath).filter(Boolean))).sort();
}

const SWARM_PATCH_SNAPSHOT_TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.ps1', '.css', '.html', '.rs', '.py', '.cs', '.go', '.java', '.xml']);

function parseGitPatchTargetPaths(patchText: string): string[] {
    const targets: string[] = [];
    for (const line of patchText.split(/\r?\n/)) {
        const diff = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (diff?.[2]) targets.push(diff[2]);
        const added = line.match(/^\+\+\+ b\/(.+)$/);
        if (added?.[1]) targets.push(added[1]);
        const removed = line.match(/^--- a\/(.+)$/);
        if (removed?.[1]) targets.push(removed[1]);
    }
    return uniqueSorted(targets.filter(target => target !== '/dev/null'));
}

function swarmPatchSnapshotCopyName(relativePath: string): string {
    const normalized = normalizeScopePath(relativePath);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
    return `${hash}-${path.basename(normalized).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'file'}`;
}

function swarmPatchSnapshotRestoreCommand(root: string, snapshotId: string): string {
    return `node bin/harmony-cli.js --workspace "${root}" snapshot restore --id ${snapshotId} --all --confirm`;
}

async function createSwarmPatchPreActionSnapshot(root: string, relativePaths: string[], reason: string): Promise<{ ok: true; note: string } | { ok: false; message: string }> {
    const paths = uniqueSorted(relativePaths);
    if (!paths.length) return { ok: false, message: 'error: patch target paths are required before creating a pre-action snapshot' };
    for (const targetPath of paths) {
        if (isBlockedScopePath(targetPath) || isSecretLookingPath(targetPath)) return { ok: false, message: `error: snapshot blocked for protected path: ${targetPath}` };
        if (!resolveWorkspaceContainedPath(root, targetPath)) return { ok: false, message: `error: snapshot target escapes workspace: ${targetPath}` };
    }
    const id = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const snapshotDir = path.join(root, '.harmony', 'snapshots', id);
    const filesDir = path.join(snapshotDir, 'files');
    await fs.mkdir(filesDir, { recursive: true });
    const manifest: any = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        mode: 'small-text-copy',
        note: reason,
        limits: { maxFiles: paths.length, maxBytes: 256 * 1024 },
        excludes: ['.git', '.harmony', 'secret', 'credential', 'key'],
        files: [],
    };
    for (const targetPath of paths) {
        const fullPath = resolveWorkspaceContainedPath(root, targetPath);
        if (!fullPath) return { ok: false, message: `error: snapshot target escapes workspace: ${targetPath}` };
        const stat = await fs.stat(fullPath).catch(() => undefined);
        if (!stat) {
            manifest.files.push({ path: targetPath, exists: false, copied: false, reason: 'target does not exist yet' });
            continue;
        }
        if (!stat.isFile()) return { ok: false, message: `error: snapshot target is not a file: ${targetPath}` };
        const ext = path.extname(fullPath).toLowerCase();
        if (stat.size > 256 * 1024 || !SWARM_PATCH_SNAPSHOT_TEXT_EXTS.has(ext)) {
            return { ok: false, message: `error: refusing patch without restorable small-text snapshot for ${targetPath}` };
        }
        const copyName = swarmPatchSnapshotCopyName(targetPath);
        await fs.copyFile(fullPath, path.join(filesDir, copyName));
        manifest.files.push({ path: targetPath, exists: true, size: stat.size, mtime: stat.mtime.toISOString(), copied: true, copyPath: `files/${copyName}` });
    }
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { ok: true, note: `\nPre-action snapshot: ${normalizeScopePath(path.relative(root, manifestPath))}\nRestore with: ${swarmPatchSnapshotRestoreCommand(root, id)}` };
}

function resolveWorkspaceContainedPath(root: string, candidate: string): string | undefined {
    const resolved = path.resolve(root, candidate);
    const normalizedRoot = path.resolve(root);
    const comparableResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const comparableRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
    return comparableResolved === comparableRoot || comparableResolved.startsWith(`${comparableRoot}${path.sep}`) ? resolved : undefined;
}

function parsePorcelainPaths(text: string): string[] {
    return uniqueSorted(String(text || '').split(/\r?\n/).filter(Boolean).map(line => {
        const raw = line.slice(3).trim();
        const renamed = raw.includes(' -> ') ? raw.split(' -> ').pop() ?? raw : raw;
        return renamed.replace(/^"|"$/g, '');
    }));
}

function pathInManifest(statusPath: string, manifestPaths: string[]): boolean {
    const status = normalizeScopePath(statusPath);
    return manifestPaths.some(item => {
        const manifest = normalizeScopePath(item).replace(/\/$/, '');
        return status === manifest || status.startsWith(`${manifest}/`);
    });
}

function selectedRoles(inputRoles?: SwarmRoleId[]): SwarmRole[] {
    const defaults: SwarmRoleId[] = ['coordinator', 'cost_sentinel', 'project_scout', 'researcher', 'designer', 'implementer', 'verifier'];
    const ids = inputRoles?.length ? inputRoles : defaults;
    const unique = Array.from(new Set(ids.filter(id => id in ROLE_LIBRARY)));
    if (!unique.includes('coordinator')) unique.unshift('coordinator');
    if (!unique.includes('verifier')) unique.push('verifier');
    return unique.map(id => ROLE_LIBRARY[id]);
}

async function selectedRolesWithCustom(inputRoles?: SwarmRoleId[]): Promise<SwarmRole[]> {
    const builtIn = selectedRoles(inputRoles);
    const custom = await loadCustomRoles();
    return [...builtIn, ...custom.map(customRoleToSwarmRole)];
}

function buildBudget(input: SwarmPlanInput, mode: SwarmMode): SwarmBudget {
    const defaultCost = mode === 'execution_guarded' ? 1 : 0.25;
    const defaultWrites = mode === 'execution_guarded' ? 1 : 0;
    const defaultTerminal = mode === 'execution_guarded' ? 1 : 0;
    return {
        maxCostUsd: clamp(Number(input.max_cost_usd ?? defaultCost), 0, 25),
        maxSteps: Math.floor(clamp(Number(input.max_steps ?? 12), 1, 100)),
        maxWrites: Math.floor(clamp(Number(input.max_writes ?? defaultWrites), 0, 10)),
        maxTerminalCommands: Math.floor(clamp(Number(input.max_terminal_commands ?? defaultTerminal), 0, 10))
    };
}

function lockIntents(scopePaths: string[], mode: SwarmMode): string[] {
    const base = ['swarm:turn-receipt', 'provider:budget', 'git:status'];
    if (mode !== 'plan_only') base.push('terminal:verification-readiness');
    const scoped = scopePaths.length ? scopePaths.map(scope => `file:${scope}`) : ['workspace:unscoped-review'];
    if (mode === 'execution_guarded') return [...base, ...scoped.map(scope => `${scope}:mutation-escrow`)];
    return [...base, ...scoped.map(scope => `${scope}:read-intent`)];
}

function safetyGates(mode: SwarmMode, risk: RiskTolerance): string[] {
    const gates = [
        'Execution_guarded receipts may be consumed by harmony_swarm_execute; non-execution modes never execute mutations.',
        'Plan-only mode disables receipt writes and all future mutation gates.',
        'Local state, git internals, and private planning files are blocked from swarm scope by default.',
        'Provider/model fan-out requires a fresh provider status or pricing refresh when costs matter.',
        'Only the coordinator may advance a proposal from reading to mutation escrow.',
        'Only one resource may be in mutation escrow at a time.',
        'Every mutation must be followed by verifier output before another mutation is considered.'
    ];
    if (mode === 'execution_guarded') gates.push('Guarded execution requires harmony_swarm_escrow plus harmony_swarm_execute confirmation, operation locks, and validation receipts.');
    if (risk === 'low') {
        gates.push('Low-risk mode requires user confirmation for package installs, process kills, git writes, secret access, and multi-file patches.');
    }
    return gates;
}

function mutationEscrow(mode: SwarmMode): string[] {
    const steps = [
        'Reader roles produce findings and cite tool outputs or source URLs.',
        'Implementer produces an escrow proposal instead of editing: exact target resources, intended change, validation command, rollback note, and risk label.',
        'Coordinator checks scope, lock intent, budget, plan-only state, and whether the proposal is one small verified change.',
        'The guarded execution gate may apply exactly one approved mutation under an operation lock.',
        'Verifier runs the cheapest focused validation and records the result before any further mutation.'
    ];
    if (mode !== 'execution_guarded') {
        steps.push('Because this plan is not execution_guarded, max writes and terminal commands are forced to zero in the active plan.');
    }
    return steps;
}

function verificationGates(mode: SwarmMode): string[] {
    const gates = [
        'Prefer focused behavior/test/compile validation over broad checks.',
        'Use git diff/status receipts after validation to show exactly what changed.',
        'For frontend work, include page inspect, responsive screenshots, or design audit when visual behavior is in scope.',
        'For provider-heavy work, include provider status and pricing freshness before expensive calls.'
    ];
    if (mode === 'execution_guarded') gates.push('Stop immediately on failed validation unless the coordinator approves one local repair attempt.');
    return gates;
}

function stopConditions(budget: SwarmBudget): string[] {
    return [
        `Stop when estimated cost would exceed $${budget.maxCostUsd.toFixed(2)}.`,
        `Stop after ${budget.maxSteps} role/tool steps.`,
        `Stop after ${budget.maxWrites} approved write(s).`,
        `Stop after ${budget.maxTerminalCommands} approved terminal command(s).`,
        'Stop on secret exposure risk, private planning-file scope, unexpected workspace mismatch, stale pricing for a cost quote, or failed validation.'
    ];
}

function nextToolPlan(mode: SwarmMode): string[] {
    const steps = [
        'Call harmony_provider_status before selecting model/provider routes.',
        'Call harmony_repo_map and/or harmony_dependency_audit before code edits in an unfamiliar project.',
        'Call harmony_current_research or harmony_pricing_refresh only with explicit source/cost need.',
        'Call harmony_page_inspect, harmony_responsive_screenshots, or harmony_design_audit for frontend/UI work.',
        'Produce one mutation escrow proposal before any future write-capable swarm tool is allowed.'
    ];
    if (mode === 'read_only_probes') steps.push('Run only read-only probes, then summarize findings and stop before mutation escrow.');
    if (mode === 'execution_guarded') steps.push('Use harmony_swarm_execute to consume one approved escrow proposal under locks and confirmation.');
    return steps;
}

async function buildReceipt(input: SwarmPlanInput): Promise<SwarmReceipt> {
    const mode = input.mode ?? 'plan_only';
    const risk = input.risk_tolerance ?? 'low';
    const rawScope = (input.scope_paths ?? []).map(normalizeScopePath).filter(Boolean);
    const blockedScopePaths = rawScope.filter(isBlockedScopePath);
    const scopePaths = rawScope.filter(scope => !isBlockedScopePath(scope));
    const roles = await selectedRolesWithCustom(input.roles);
    const budget = buildBudget(input, mode);
    if (mode !== 'execution_guarded') {
        budget.maxWrites = 0;
        budget.maxTerminalCommands = 0;
    }
    return {
        version: 1,
        turnId: makeTurnId(),
        createdAt: new Date().toISOString(),
        objective: input.objective.trim(),
        requestedMode: mode,
        executionEnabled: mode === 'execution_guarded',
        riskTolerance: risk,
        scopePaths,
        blockedScopePaths,
        roles,
        budget,
        lockIntents: lockIntents(scopePaths, mode),
        safetyGates: safetyGates(mode, risk),
        mutationEscrow: mutationEscrow(mode),
        verificationGates: verificationGates(mode),
        stopConditions: stopConditions(budget),
        nextToolPlan: nextToolPlan(mode)
    };
}

async function writeReceipt(receipt: SwarmReceipt): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, receipt.turnId);
    await fs.mkdir(dir, { recursive: true });
    const planPath = path.join(dir, 'plan.json');
    const payload = JSON.stringify(receipt, null, 2);
    await fs.writeFile(planPath, payload, 'utf8');
    await fs.writeFile(path.join(root, SWARM_DIR, 'latest-plan.json'), payload, 'utf8');
    return relPath(planPath);
}

function formatRoles(roles: SwarmRole[]): string[] {
    return roles.map(role => `${role.label}: ${role.purpose} Output: ${role.outputContract}`);
}

function formatBudget(budget: SwarmBudget): string[] {
    return [
        `max cost: $${budget.maxCostUsd.toFixed(2)}`,
        `max role/tool steps: ${budget.maxSteps}`,
        `max approved writes: ${budget.maxWrites}`,
        `max approved terminal commands: ${budget.maxTerminalCommands}`
    ];
}

function formatReceipt(receipt: SwarmReceipt, writtenPath?: string, skippedWrite?: string): string {
    return [
        '# Harmony Swarm Plan',
        '',
        `Turn id: ${receipt.turnId}`,
        `Created: ${receipt.createdAt}`,
        `Mode requested: ${receipt.requestedMode}`,
        `Execution enabled: ${receipt.executionEnabled ? 'yes (guarded executor required)' : 'no'}`,
        writtenPath ? `Receipt written: ${writtenPath}` : (skippedWrite ?? 'Receipt not written.'),
        '',
        section('Objective', receipt.objective),
        '',
        section('Scope Paths', receipt.scopePaths.length ? receipt.scopePaths : ['No explicit scope paths provided. Treat workspace scope as unbounded until project_scout narrows it.']),
        '',
        receipt.blockedScopePaths.length ? section('Blocked Scope Paths', receipt.blockedScopePaths.map(scope => `${scope} (private or unsafe for swarm scope)`)) + '\n' : '',
        section('Roles', formatRoles(receipt.roles)),
        '',
        section('Budget', formatBudget(receipt.budget)),
        '',
        section('Lock Intents', receipt.lockIntents),
        '',
        section('Safety Gates', receipt.safetyGates),
        '',
        section('Mutation Escrow Protocol', receipt.mutationEscrow),
        '',
        section('Verification Gates', receipt.verificationGates),
        '',
        section('Stop Conditions', receipt.stopConditions),
        '',
        section('Next Tool Plan', receipt.nextToolPlan)
    ].filter(Boolean).join('\n');
}

async function readReceiptById(turnId: string): Promise<SwarmReceipt | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const safeTurnId = turnId.replace(/[^a-zA-Z0-9._-]/g, '');
    const target = safeTurnId === 'latest' ? path.join(root, SWARM_DIR, 'latest-plan.json') : path.join(root, SWARM_DIR, safeTurnId, 'plan.json');
    try { return JSON.parse(await fs.readFile(target, 'utf8')) as SwarmReceipt; } catch { return undefined; }
}

async function readPricingSnapshot(): Promise<PricingSnapshotSummary | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    try { return JSON.parse(await fs.readFile(path.join(root, '.harmony', 'provider-pricing', 'latest.json'), 'utf8')) as PricingSnapshotSummary; } catch { return undefined; }
}

async function listActiveLocks(): Promise<LockRecordSummary[]> {
    const root = workspaceRoot();
    if (!root) return [];
    const dir = path.join(root, '.harmony', 'locks');
    const entries: Array<{ name: string; isFile(): boolean }> = await fs.readdir(dir, { withFileTypes: true }).catch((): Array<{ name: string; isFile(): boolean }> => []);
    const locks: LockRecordSummary[] = [];
    for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))) {
        const filePath = path.join(dir, entry.name);
        try {
            const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as LockRecordSummary;
            const expired = parsed.expiresAt ? Date.parse(parsed.expiresAt) < Date.now() : false;
            if (!expired) locks.push({ ...parsed, file: relPath(filePath) });
        } catch {
            locks.push({ file: relPath(filePath), operation: 'unreadable-lock-file' });
        }
    }
    return locks;
}

interface ProcessRun { ok: boolean; stdout: string; stderr: string; error?: string; }

async function execFile(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessRun> {
    return new Promise(resolve => {
        cp.execFile(command, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', error: err ? err.message : undefined });
        }).on('error', error => resolve({ ok: false, stdout: '', stderr: '', error: error.message }));
    });
}

async function runGit(args: string[]): Promise<string> {
    const root = workspaceRoot();
    if (!root) return 'error: no workspace folder is open';
    const result = await execFile('git', args, root, 60000);
    if (!result.ok) return `error: git ${args.join(' ')} failed\n${result.error ?? ''}\n${result.stderr}`.trim();
    return result.stdout.trim() || '(no output)';
}

async function readPackageSummary(): Promise<string> {
    const root = workspaceRoot();
    if (!root) return 'no workspace folder is open';
    try {
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        const scripts = Object.entries(pkg.scripts ?? {}).map(([name, script]) => `${name}: ${script}`).slice(0, 25);
        const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).slice(0, 40);
        return [
            `package: ${pkg.name ?? '(unnamed)'} ${pkg.version ?? ''}`.trim(),
            `scripts: ${scripts.length ? scripts.join('; ') : '(none)'}`,
            `dependencies: ${deps.length ? deps.join(', ') : '(none)'}`,
        ].join('\n');
    } catch {
        return 'no package.json found at workspace root';
    }
}

async function walkForSwarm(root: string, maxFiles: number): Promise<string[]> {
    const excludes = new Set(['.git', '.harmony', 'node_modules', 'out', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__']);
    const files: string[] = [];
    async function walk(absDir: string, depth: number): Promise<void> {
        if (depth > 5 || files.length >= maxFiles) return;
        const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (files.length >= maxFiles || excludes.has(entry.name) || entry.name.endsWith(PRIVATE_PLANNING_EXT)) continue;
            const abs = path.join(absDir, entry.name);
            const rel = path.relative(root, abs).replace(/\\/g, '/');
            if (entry.isDirectory()) await walk(abs, depth + 1);
            else if (entry.isFile()) files.push(rel);
        }
    }
    await walk(root, 0);
    return files.sort();
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchReadonlySource(url: string, token: vscode.CancellationToken): Promise<string> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return `invalid URL: ${url}`; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `blocked non-http URL: ${url}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        const response = await fetch(parsed.toString(), { signal: controller.signal as any, headers: { 'User-Agent': 'Harmony-Swarm-Dispatch/0.2' } });
        const raw = await response.text();
        const text = (response.headers.get('content-type') ?? '').includes('html') ? stripHtml(raw) : raw.replace(/\s+/g, ' ').trim();
        return [`${response.ok ? 'ok' : 'failed'} HTTP ${response.status}: ${response.url || url}`, text.slice(0, 2000)].join('\n');
    } catch (error: any) {
        return `fetch failed for ${url}: ${error?.message ?? String(error)}`;
    } finally {
        clearTimeout(timeout);
        sub.dispose();
    }
}

async function runRoleProbe(role: SwarmRoleId, receipt: SwarmReceipt, input: SwarmDispatchInput, secrets: vscode.SecretStorage, token: vscode.CancellationToken): Promise<SwarmDispatchRoleResult> {
    const root = workspaceRoot();
    const toolOutputs: string[] = [];
    if (role === 'coordinator') {
        toolOutputs.push(`objective: ${receipt.objective}`);
        toolOutputs.push(`mode: ${receipt.requestedMode}; scope: ${receipt.scopePaths.join(', ') || '(unscoped)'}`);
    } else if (role === 'project_scout') {
        if (!root) return { role, status: 'blocked', summary: 'No workspace folder is open.', toolOutputs };
        const files = await walkForSwarm(root, 500);
        toolOutputs.push(await readPackageSummary());
        toolOutputs.push(`sample files (${files.length}):\n${files.slice(0, 120).join('\n')}`);
    } else if (role === 'verifier') {
        toolOutputs.push('git status:\n' + await runGit(['status', '--short', '--branch']));
        toolOutputs.push('git diff stat:\n' + await runGit(['diff', '--stat']));
        toolOutputs.push('staged diff stat:\n' + await runGit(['diff', '--staged', '--stat']));
        toolOutputs.push('package validation candidates:\n' + await readPackageSummary());
        // Critic hardening: verifier MUST produce evidence-gated findings
        toolOutputs.push('');
        toolOutputs.push('--- EVIDENCE-GATED FORMAT REQUIRED ---');
        toolOutputs.push('Every finding MUST follow this JSON structure:');
        toolOutputs.push('{"claim":"...","confidence":0-100,"evidence":["file:line or behavior"],"counterevidence":["what weakens this?"],"severity":"blocker|risk|observation|style","source":"specific file:line"}');
        toolOutputs.push('Rule: confidence < 50 without source = downgrade to observation severity.');
        toolOutputs.push('Rule: findings without "source" are automatically observation-only and never block progress.');
    } else if (role === 'cost_sentinel') {
        const pricing = await readPricingSnapshot();
        const providers = await listAvailableProviders(secrets);
        toolOutputs.push(`configured providers with keys: ${providers.join(', ') || '(none)'}`);
        toolOutputs.push(pricing?.fetchedAt ? `latest pricing snapshot: ${pricing.fetchedAt}; staleAfterDays=${pricing.staleAfterDays ?? '(not set)'}` : 'no local provider pricing snapshot found');
        toolOutputs.push(`budget: maxCostUsd=$${receipt.budget.maxCostUsd.toFixed(2)}, maxSteps=${receipt.budget.maxSteps}`);
    } else if (role === 'researcher') {
        const urls = (input.source_urls ?? []).map(url => url.trim()).filter(Boolean).slice(0, 6);
        if (!urls.length) toolOutputs.push('No source_urls supplied; researcher did not fetch external sources.');
        for (const url of urls) toolOutputs.push(await fetchReadonlySource(url, token));
    } else if (role === 'designer') {
        if (input.page_url?.trim()) toolOutputs.push(await fetchReadonlySource(input.page_url.trim(), token));
        else toolOutputs.push('No page_url supplied; designer recommends harmony_page_inspect/responsive_screenshots before UI claims.');
    } else if (role === 'implementer') {
        toolOutputs.push('Read-only dispatch: implementer may propose escrow text only. No patches were generated or applied by this tool.');
    }

    const roleInfo = ROLE_LIBRARY[role] ?? { label: role, purpose: 'Custom swarm role — refer to role definition for specific capabilities.' };
    const baseSummary = `${roleInfo.label} read-only probe completed with ${toolOutputs.length} output block(s).`;
    if (!input.enable_provider_fanout) return { role, status: 'ran', summary: baseSummary, toolOutputs };
    if (planOnlyMode()) return { role, status: 'skipped', summary: `${baseSummary} Provider fan-out skipped because plan-only mode is enabled.`, toolOutputs };
    const provider = input.provider ?? 'deepseek';
    const tier = input.tier ?? 'light';

    // Big Guns mode guard: ask before heavy/premium swarm fan-out
    const allowed = await confirmPremiumModel(provider, tier, modelFor(provider, tier), 'swarm provider fan-out');
    if (!allowed) {
        return { role, status: 'blocked', summary: `${baseSummary} Provider fan-out blocked by Big Guns mode (${provider}/${tier}).`, toolOutputs };
    }

    try {
        const prompt = [
            `Swarm objective: ${receipt.objective}`,
            `Role: ${roleInfo.label}`,
            `Role purpose: ${roleInfo.purpose}`,
            'Read-only probe output:',
            toolOutputs.join('\n\n---\n\n'),
            '',
            'Return a compact role receipt with: findings, risks, recommended next action, and whether mutation escrow is warranted. Do not propose direct execution.'
        ].join('\n');
        const response = await consult(secrets, {
            provider,
            tier,
            system: 'You are a read-only Harmony swarm role. You may analyze outputs, but you must not claim anything was edited, executed, committed, installed, or applied.',
            question: prompt,
            maxTokens: Math.max(256, Math.min(4096, Math.floor(Number(input.max_tokens) || 900))),
        }, token);
        const promptTokens = response.usage?.promptTokens ?? Math.ceil(prompt.length / 4);
        const completionTokens = response.usage?.completionTokens ?? Math.ceil(response.text.length / 4);
        return {
            role,
            status: 'ran',
            summary: baseSummary,
            toolOutputs,
            provider: response.provider,
            model: response.model,
            providerText: response.text,
            estimatedCostUsd: estimateCost(response.provider, response.model, promptTokens, completionTokens),
        };
    } catch (error: any) {
        return { role, status: 'provider_failed', summary: `${baseSummary} Provider fan-out failed: ${error?.message ?? String(error)}`, toolOutputs, provider };
    }
}

async function writeDispatchReceipt(receipt: SwarmDispatchReceipt): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, receipt.turnId, 'dispatch');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${receipt.dispatchId}.json`);
    const payload = JSON.stringify(receipt, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(root, SWARM_DIR, receipt.turnId, 'latest-dispatch.json'), payload, 'utf8');
    return relPath(target);
}

async function listReceipts(limit: number): Promise<SwarmReceipt[]> {
    const root = workspaceRoot();
    if (!root) return [];
    const dir = path.join(root, SWARM_DIR);
    const entries: Array<{ name: string; isDirectory(): boolean }> = await fs.readdir(dir, { withFileTypes: true }).catch((): Array<{ name: string; isDirectory(): boolean }> => []);
    const ids = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse().slice(0, limit);
    const receipts: SwarmReceipt[] = [];
    for (const id of ids) {
        const receipt = await readReceiptById(id);
        if (receipt) receipts.push(receipt);
    }
    return receipts;
}

function pricingFreshnessCheck(snapshot: PricingSnapshotSummary | undefined, maxAgeDays: number): SwarmPreflightCheck {
    if (!snapshot?.fetchedAt) return { status: 'block', message: 'No provider pricing snapshot found. Run harmony_pricing_refresh before cost-sensitive swarm work.' };
    const ageMs = Date.now() - new Date(snapshot.fetchedAt).getTime();
    if (!Number.isFinite(ageMs)) return { status: 'block', message: `Provider pricing snapshot has unreadable fetchedAt: ${snapshot.fetchedAt}` };
    const ageDays = ageMs / 86400000;
    if (ageDays > maxAgeDays) return { status: 'block', message: `Provider pricing snapshot is ${ageDays.toFixed(1)} days old, older than ${maxAgeDays} day limit.` };
    return { status: 'pass', message: `Provider pricing snapshot is ${ageDays < 1 ? `${Math.max(0, ageDays * 24).toFixed(1)} hours` : `${ageDays.toFixed(1)} days`} old.` };
}

function preflightDecision(checks: SwarmPreflightCheck[]): 'GO' | 'CAUTION' | 'NO-GO' {
    if (checks.some(check => check.status === 'block')) return 'NO-GO';
    if (checks.some(check => check.status === 'warn')) return 'CAUTION';
    return 'GO';
}

function formatChecks(checks: SwarmPreflightCheck[]): string[] {
    return checks.map(check => `${check.status.toUpperCase()}: ${check.message}`);
}

async function runPreflight(receipt: SwarmReceipt | undefined, input: SwarmPreflightInput): Promise<{ decision: 'GO' | 'CAUTION' | 'NO-GO'; checks: SwarmPreflightCheck[]; receipt?: SwarmReceipt; locks: LockRecordSummary[]; pricingSnapshot?: PricingSnapshotSummary }> {
    const intendedAction = input.intended_action ?? 'read_only_probes';
    const checks: SwarmPreflightCheck[] = [];
    const pricingSnapshot = await readPricingSnapshot();
    const locks = await listActiveLocks();
    if (!receipt) {
        checks.push({ status: 'block', message: `Swarm receipt not found: ${input.turn_id?.trim() || 'latest'}` });
        return { decision: 'NO-GO', checks, locks, pricingSnapshot };
    }
    checks.push({ status: 'pass', message: `Loaded swarm receipt ${receipt.turnId}.` });
    checks.push(receipt.executionEnabled
        ? { status: 'pass', message: 'Receipt is execution-enabled; guarded executor is allowed after escrow/lock/confirmation checks.' }
        : { status: 'pass', message: 'Receipt is non-execution: executionEnabled=false.' });
    if (intendedAction === 'execution') {
        checks.push(receipt.requestedMode === 'execution_guarded' && receipt.executionEnabled
            ? { status: 'pass', message: 'Execution preflight allowed for execution_guarded receipt.' }
            : { status: 'block', message: `Execution requires execution_guarded receipt with executionEnabled=true; mode=${receipt.requestedMode}.` });
    }
    if (planOnlyMode() && intendedAction !== 'read_only_probes') {
        checks.push({ status: 'block', message: 'Plan-only mode is enabled; mutation escrow/execution is blocked.' });
    }
    if (receipt.blockedScopePaths.length) {
        checks.push({ status: 'block', message: `Receipt contains blocked private scope path(s): ${receipt.blockedScopePaths.join(', ')}` });
    }
    if (receipt.budget.maxCostUsd <= 0 && input.require_fresh_pricing) {
        checks.push({ status: 'warn', message: 'Receipt has zero cost budget; provider fan-out should not run.' });
    }
    if (intendedAction === 'mutation_escrow' && receipt.requestedMode !== 'execution_guarded') {
        checks.push({ status: 'block', message: `Mutation escrow requires an execution_guarded receipt; receipt mode is ${receipt.requestedMode}.` });
    }
    if (intendedAction === 'mutation_escrow' && receipt.budget.maxWrites <= 0) {
        checks.push({ status: 'block', message: 'Receipt maxWrites is 0; mutation escrow should not advance.' });
    }
    if (input.require_fresh_pricing) {
        checks.push(pricingFreshnessCheck(pricingSnapshot, Math.max(1, Math.min(30, Math.floor(input.max_pricing_age_days ?? 7)))));
    }
    if (locks.length) {
        checks.push({ status: 'warn', message: `Active operation lock(s) exist: ${locks.map(lock => `${lock.resource ?? lock.file} (${lock.operation ?? 'unknown'})`).join('; ')}` });
    } else {
        checks.push({ status: 'pass', message: 'No active operation locks found under .harmony/locks.' });
    }
    return { decision: preflightDecision(checks), checks, receipt, locks, pricingSnapshot };
}

function pathWithinScope(targetPath: string, scopePaths: string[]): boolean {
    if (!scopePaths.length) return true;
    const normalizedTarget = normalizeScopePath(targetPath).toLowerCase();
    return scopePaths.some(scope => {
        const normalizedScope = normalizeScopePath(scope).toLowerCase().replace(/\/+$/, '');
        return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
    });
}

function buildEscrowProposal(receipt: SwarmReceipt, input: SwarmEscrowInput): SwarmEscrowProposal {
    const rawTargets = (input.target_paths ?? []).map(normalizeScopePath).filter(Boolean);
    const blockedTargetPaths = rawTargets.filter(target => isBlockedScopePath(target) || !pathWithinScope(target, receipt.scopePaths));
    const targetPaths = rawTargets.filter(target => !blockedTargetPaths.includes(target));
    return {
        version: 1,
        proposalId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`,
        turnId: receipt.turnId,
        createdAt: new Date().toISOString(),
        title: input.title.trim(),
        proposalType: input.proposal_type ?? 'patch',
        targetPaths,
        blockedTargetPaths,
        summary: input.summary.trim(),
        validationPlan: input.validation_plan.map(step => step.trim()).filter(Boolean),
        rollbackPlan: input.rollback_plan?.trim() || undefined,
        estimatedCostUsd: Math.max(0, Number(input.estimated_cost_usd ?? 0)),
        riskTolerance: input.risk_tolerance ?? receipt.riskTolerance,
        applied: false,
        executionEnabled: receipt.executionEnabled,
        notes: [
            'Escrow proposal only. Nothing has been applied, executed, installed, committed, or sent to a provider by this tool.',
            receipt.executionEnabled
                ? 'harmony_swarm_execute may consume this proposal after confirmation, preflight, budget checks, and operation locks.'
                : 'This proposal is not executable because the parent receipt is not execution-enabled.'
        ]
    };
}

function validateEscrowProposal(receipt: SwarmReceipt, proposal: SwarmEscrowProposal): SwarmPreflightCheck[] {
    const checks: SwarmPreflightCheck[] = [];
    checks.push(receipt.requestedMode === 'execution_guarded'
        ? { status: 'pass', message: 'Receipt is execution_guarded, so mutation escrow proposals are allowed.' }
        : { status: 'block', message: `Receipt mode is ${receipt.requestedMode}; mutation escrow requires execution_guarded.` });
    checks.push(receipt.executionEnabled
        ? { status: 'pass', message: 'Receipt execution is enabled; proposal may later be consumed by harmony_swarm_execute.' }
        : { status: 'pass', message: 'Execution remains disabled; proposal can only be recorded.' });
    if (planOnlyMode()) checks.push({ status: 'block', message: 'Plan-only mode is enabled; escrow proposal write is blocked.' });
    if (!proposal.title) checks.push({ status: 'block', message: 'Proposal title is required.' });
    if (!proposal.summary) checks.push({ status: 'block', message: 'Proposal summary is required.' });
    if (!proposal.validationPlan.length) checks.push({ status: 'block', message: 'At least one validation step is required.' });
    if (!proposal.targetPaths.length && proposal.proposalType === 'patch') checks.push({ status: 'block', message: 'Patch proposals require at least one allowed target path.' });
    if (proposal.blockedTargetPaths.length) checks.push({ status: 'block', message: `Blocked or out-of-scope target path(s): ${proposal.blockedTargetPaths.join(', ')}` });
    if (proposal.estimatedCostUsd > receipt.budget.maxCostUsd) checks.push({ status: 'block', message: `Estimated cost $${proposal.estimatedCostUsd.toFixed(2)} exceeds receipt budget $${receipt.budget.maxCostUsd.toFixed(2)}.` });
    if (proposal.proposalType === 'provider_call' && proposal.estimatedCostUsd <= 0) checks.push({ status: 'block', message: 'Provider-call proposals require a positive estimated_cost_usd so the receipt has an explicit budget proof.' });
    if (proposal.proposalType === 'provider_call' && receipt.budget.maxCostUsd <= 0) checks.push({ status: 'block', message: 'Provider-call proposals require a positive swarm max_cost_usd budget.' });
    if (proposal.proposalType === 'terminal' && receipt.budget.maxTerminalCommands <= 0) checks.push({ status: 'block', message: 'Receipt maxTerminalCommands is 0; terminal proposals are blocked.' });
    if (proposal.proposalType === 'patch' && receipt.budget.maxWrites <= 0) checks.push({ status: 'block', message: 'Receipt maxWrites is 0; patch proposals are blocked.' });
    if (!checks.some(check => check.status === 'block')) checks.push({ status: 'pass', message: 'Escrow proposal is recordable. It is still not executable.' });
    return checks;
}

async function writeEscrowProposal(proposal: SwarmEscrowProposal): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, proposal.turnId, 'escrow');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${proposal.proposalId}.json`);
    const payload = JSON.stringify(proposal, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(root, SWARM_DIR, proposal.turnId, 'latest-escrow.json'), payload, 'utf8');
    return relPath(target);
}

async function readEscrowProposal(turnId: string, proposalId?: string): Promise<SwarmEscrowProposal | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const safeTurnId = turnId.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeProposalId = proposalId?.replace(/[^a-zA-Z0-9._-]/g, '');
    const target = safeProposalId
        ? path.join(root, SWARM_DIR, safeTurnId, 'escrow', `${safeProposalId}.json`)
        : path.join(root, SWARM_DIR, safeTurnId, 'latest-escrow.json');
    try { return JSON.parse(await fs.readFile(target, 'utf8')) as SwarmEscrowProposal; } catch { return undefined; }
}

async function updateEscrowProposal(proposal: SwarmEscrowProposal): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    const target = path.join(root, SWARM_DIR, proposal.turnId, 'escrow', `${proposal.proposalId}.json`);
    const payload = JSON.stringify(proposal, null, 2);
    await fs.writeFile(target, payload, 'utf8').catch(() => undefined);
    await fs.writeFile(path.join(root, SWARM_DIR, proposal.turnId, 'latest-escrow.json'), payload, 'utf8').catch(() => undefined);
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<ProcessRun> {
    return new Promise(resolve => {
        cp.exec(command, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', error: err ? err.message : undefined });
        }).on('error', error => resolve({ ok: false, stdout: '', stderr: '', error: error.message }));
    });
}

async function executePatch(root: string, proposal: SwarmEscrowProposal, patchText: string, dryRun: boolean): Promise<string> {
    if (!patchText.trim()) return 'error: patch_text is required for patch proposals';
    const patchTargets = parseGitPatchTargetPaths(patchText);
    if (!patchTargets.length) return 'error: patch_text must include git-style target paths';
    const extraTargets = patchTargets.filter(target => !pathInManifest(target, proposal.targetPaths));
    if (extraTargets.length) return `error: patch targets are outside the escrow proposal target list: ${extraTargets.join(', ')}`;
    const protectedTargets = patchTargets.filter(target => isBlockedScopePath(target) || isSecretLookingPath(target));
    if (protectedTargets.length) return `error: patch targets are blocked by protected path policy: ${protectedTargets.join(', ')}`;
    const dir = path.join(root, SWARM_DIR, proposal.turnId, 'execution');
    await fs.mkdir(dir, { recursive: true });
    const patchPath = path.join(dir, `${proposal.proposalId}.patch`);
    await fs.writeFile(patchPath, patchText, 'utf8');
    const check = await execFile('git', ['apply', '--check', patchPath], root, 120000);
    if (!check.ok) return `patch check failed\n${check.error ?? ''}\n${check.stderr}`.trim();
    if (dryRun) return `patch dry-run passed: ${relPath(patchPath)}`;
    const snapshot = await createSwarmPatchPreActionSnapshot(root, patchTargets, `VS Code swarm patch execute before git apply ${patchTargets.join(', ')}`);
    if (!snapshot.ok) return snapshot.message;
    const applied = await execFile('git', ['apply', patchPath], root, 120000);
    if (!applied.ok) return `patch apply failed\n${applied.error ?? ''}\n${applied.stderr}`.trim();
    return `patch applied: ${relPath(patchPath)}${snapshot.note}`;
}

async function executeTerminal(root: string, command: string, dryRun: boolean): Promise<string> {
    const raw = command.trim();
    if (!raw) return 'error: terminal_command is required for terminal proposals';
    if (dryRun) return `terminal dry-run: ${raw}`;
    const result = await runShell(raw, root, 120000);
    return [
        result.ok ? 'terminal command completed' : 'terminal command failed',
        result.stdout.trim(),
        result.stderr.trim() ? `[stderr]\n${result.stderr.trim()}` : '',
        result.error ? `[error]\n${result.error}` : ''
    ].filter(Boolean).join('\n');
}

async function writeExecutionReceipt(receipt: SwarmExecutionReceipt): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, receipt.turnId, 'execution');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${receipt.executionId}.json`);
    const payload = JSON.stringify(receipt, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(root, SWARM_DIR, receipt.turnId, 'latest-execution.json'), payload, 'utf8');
    return relPath(target);
}

function formatCostLabel(amount: number | undefined): string {
    if (amount === undefined) return 'unknown';
    if (amount < 0.05) return '●○○ Low';
    if (amount < 0.20) return '●●○ Medium';
    return '●●● Significant';
}

function formatBudgetLabel(remaining: number | undefined): string {
    if (remaining === undefined) return 'unknown';
    if (remaining > 0.15) return '●●● ample';
    if (remaining > 0.05) return '●●○ moderate';
    return '●○○ tight';
}

function formatExecution(receipt: SwarmExecutionReceipt, writtenPath?: string, skippedWrite?: string): string {
    return [
        '# Harmony Swarm Execution',
        '',
        `Execution id: ${receipt.executionId}`,
        `Turn id: ${receipt.turnId}`,
        `Proposal id: ${receipt.proposalId}`,
        `Type: ${receipt.proposalType}`,
        `Status: ${receipt.status}`,
        `Dry run: ${receipt.dryRun ? 'yes' : 'no'}`,
        `Writes applied: ${receipt.writesApplied}`,
        `Terminal commands run: ${receipt.terminalCommandsRun}`,
        `Provider calls run: ${receipt.providerCallsRun}/${receipt.providerCallLimit}`,
        `Budget verdict: ${receipt.budgetWithinLimit ? 'within_budget' : 'over_budget'} (${receipt.costEstimateSource})`,
        `Proposal cost: ${formatCostLabel(receipt.proposalEstimatedCostUsd)}`,
        receipt.provider ? `Provider route: ${receipt.provider}/${receipt.tier ?? '(unknown tier)'} / ${receipt.model ?? '(unknown model)'}` : '',
        typeof receipt.estimatedCostUsd === 'number' ? `Provider cost: ${formatCostLabel(receipt.estimatedCostUsd)}` : '',
        typeof receipt.costBudgetRemainingUsd === 'number' ? `Budget remaining: ${formatBudgetLabel(receipt.costBudgetRemainingUsd)}` : '',
        writtenPath ? `Execution receipt written: ${writtenPath}` : (skippedWrite ?? 'Execution receipt not written.'),
        '',
        section('Budget Proof', receipt.budgetProof.length ? receipt.budgetProof : ['No budget proof recorded.']),
        '',
        section('Target Paths', receipt.targetPaths.length ? receipt.targetPaths : ['No target paths.']),
        '',
        section('Output', receipt.output || '(no output)'),
        '',
        section('Validation Plan', receipt.validationPlan.length ? receipt.validationPlan : ['No validation plan supplied.'])
    ].join('\n');
}

function formatPreflight(result: Awaited<ReturnType<typeof runPreflight>>): string {
    return [
        '# Harmony Swarm Preflight',
        '',
        `Decision: ${result.decision}`,
        result.receipt ? `Receipt: ${result.receipt.turnId}` : 'Receipt: (missing)',
        '',
        section('Checks', formatChecks(result.checks)),
        '',
        section('Active Locks', result.locks.length ? result.locks.map(lock => `${lock.file}: ${lock.resource ?? '(unknown resource)'} ${lock.operation ?? ''}`.trim()) : ['No active locks found.']),
        '',
        section('Pricing Snapshot', result.pricingSnapshot?.fetchedAt ? [`fetchedAt: ${result.pricingSnapshot.fetchedAt}`, `staleAfterDays: ${result.pricingSnapshot.staleAfterDays ?? '(not set)'}`] : ['No latest provider pricing snapshot found.'])
    ].join('\n');
}

function formatDispatch(receipt: SwarmDispatchReceipt, writtenPath?: string, skippedWrite?: string): string {
    const roleSections = receipt.roles.map(role => [
        `### ${ROLE_LIBRARY[role.role].label}`,
        '',
        `Status: ${role.status}`,
        `Summary: ${role.summary}`,
        role.provider ? `Provider: ${role.provider}/${role.model ?? '(unknown model)'}` : '',
        typeof role.estimatedCostUsd === 'number' ? `Cost: ${formatCostLabel(role.estimatedCostUsd)}` : '',
        '',
        section('Tool Outputs', role.toolOutputs.length ? role.toolOutputs.map(output => output.slice(0, 3000)) : ['No output.']),
        role.providerText ? `\n## Provider Role Note\n\n${role.providerText}` : '',
    ].filter(Boolean).join('\n'));
    return [
        '# Harmony Swarm Dispatch',
        '',
        `Dispatch id: ${receipt.dispatchId}`,
        `Turn id: ${receipt.turnId}`,
        `Created: ${receipt.createdAt}`,
        `Mode: ${receipt.mode}`,
        `Provider fan-out: ${receipt.providerFanoutEnabled ? 'enabled' : 'disabled'}`,
        `Execution enabled: no`,
        `Writes applied: ${receipt.writesApplied}`,
        `Terminal commands run: ${receipt.terminalCommandsRun}`,
        `Relative cost: ${formatCostLabel(receipt.totalEstimatedCostUsd)}`,
        writtenPath ? `Dispatch written: ${writtenPath}` : (skippedWrite ?? 'Dispatch not written.'),
        '',
        section('Objective', receipt.objective),
        '',
        section('Notes', receipt.notes),
        '',
        ...roleSections,
    ].join('\n');
}

function formatEscrow(proposal: SwarmEscrowProposal, checks: SwarmPreflightCheck[], writtenPath?: string, skippedWrite?: string): string {
    return [
        '# Harmony Swarm Escrow Proposal',
        '',
        `Proposal id: ${proposal.proposalId}`,
        `Turn id: ${proposal.turnId}`,
        `Type: ${proposal.proposalType}`,
        `Applied: ${proposal.applied ? 'yes' : 'no'}`,
        `Execution enabled: ${proposal.executionEnabled ? 'yes' : 'no'}`,
        writtenPath ? `Proposal written: ${writtenPath}` : (skippedWrite ?? 'Proposal not written.'),
        '',
        section('Title', proposal.title),
        '',
        section('Summary', proposal.summary),
        '',
        section('Allowed Targets', proposal.targetPaths.length ? proposal.targetPaths : ['No allowed targets.']),
        '',
        proposal.blockedTargetPaths.length ? section('Blocked Targets', proposal.blockedTargetPaths) + '\n' : '',
        section('Validation Plan', proposal.validationPlan),
        '',
        section('Rollback Plan', proposal.rollbackPlan ?? 'No rollback plan supplied.'),
        '',
        section('Checks', formatChecks(checks)),
        '',
        section('Notes', proposal.notes)
    ].filter(Boolean).join('\n');
}

class SwarmPlanTool implements vscode.LanguageModelTool<SwarmPlanInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmPlanInput>): Promise<vscode.LanguageModelToolResult> {
        const objective = options.input.objective?.trim();
        if (!objective) return textResult('error: missing argument: objective');
        const receipt = await buildReceipt({ ...options.input, objective });
        const shouldWrite = options.input.write_receipt !== false && !planOnlyMode();
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (shouldWrite) {
            writtenPath = await writeReceipt(receipt);
            skippedWrite = writtenPath ? undefined : 'Receipt was not written because no workspace root is open.';
        } else {
            skippedWrite = planOnlyMode() && options.input.write_receipt !== false
                ? 'Plan-only mode is enabled; swarm receipt write was skipped.'
                : 'Receipt write disabled by input.';
        }
        if (options.input.format === 'json') return textResult(JSON.stringify({ receipt, writtenPath, skippedWrite }, null, 2));
        return textResult(formatReceipt(receipt, writtenPath, skippedWrite));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmPlanInput>) {
        return { invocationMessage: `Planning dormant swarm: ${options.input.mode ?? 'plan_only'}` };
    }
}

class SwarmReceiptsTool implements vscode.LanguageModelTool<SwarmReceiptsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmReceiptsInput>): Promise<vscode.LanguageModelToolResult> {
        const action = options.input.action ?? 'list';
        if (action === 'read') {
            const turnId = options.input.turn_id?.trim() || 'latest';
            const receipt = await readReceiptById(turnId);
            if (!receipt) return textResult(`error: swarm receipt not found: ${turnId}`);
            if (options.input.format === 'json') return textResult(JSON.stringify(receipt, null, 2));
            return textResult(formatReceipt(receipt));
        }
        const limit = Math.floor(clamp(Number(options.input.limit ?? 10), 1, 50));
        const receipts = await listReceipts(limit);
        if (options.input.format === 'json') return textResult(JSON.stringify(receipts, null, 2));
        return textResult([
            '# Harmony Swarm Receipts',
            '',
            receipts.length ? receipts.map(receipt => `- ${receipt.turnId} | ${receipt.createdAt} | ${receipt.requestedMode} | ${receipt.objective.slice(0, 140)}`).join('\n') : '- No swarm receipts found.'
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmReceiptsInput>) {
        return { invocationMessage: `Reading swarm receipts: ${options.input.action ?? 'list'}` };
    }
}

class SwarmPreflightTool implements vscode.LanguageModelTool<SwarmPreflightInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmPreflightInput>): Promise<vscode.LanguageModelToolResult> {
        const receipt = await readReceiptById(options.input.turn_id?.trim() || 'latest');
        const result = await runPreflight(receipt, options.input);
        if (options.input.format === 'json') return textResult(JSON.stringify(result, null, 2));
        return textResult(formatPreflight(result));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmPreflightInput>) {
        return { invocationMessage: `Checking swarm preflight: ${options.input.intended_action ?? 'read_only_probes'}` };
    }
}

class SwarmDispatchTool implements vscode.LanguageModelTool<SwarmDispatchInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmDispatchInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const plan = await readReceiptById(options.input.turn_id?.trim() || 'latest');
        // When Orchestrate Mode or Deep Orchestrate is enabled, skip pricing freshness
        // requirements even with provider fan-out. The orchestrator manages costs internally.
        const orchestrating = vscode.workspace.getConfiguration('harmony').get<boolean>('orchestrateMode.enabled')
            || vscode.workspace.getConfiguration('harmony').get<boolean>('deepOrchestrate.enabled');
        const preflight = await runPreflight(plan, { turn_id: options.input.turn_id, intended_action: 'read_only_probes', require_fresh_pricing: !orchestrating && !!options.input.enable_provider_fanout });
        if (!plan || preflight.decision === 'NO-GO') {
            return textResult(options.input.format === 'json'
                ? JSON.stringify({ preflight }, null, 2)
                : formatPreflight(preflight));
        }
        if (options.input.enable_provider_fanout && !swarmSafetySwitch('providerCalls.enabled')) {
            return textResult(disabledSwarmSwitchMessage('providerCalls.enabled', 'swarm provider fan-out'));
        }
        const allowedRoleIds = new Set<SwarmRoleId>(plan.roles.map(role => role.id));
        const defaultRoles: SwarmRoleId[] = ['coordinator', 'project_scout', 'verifier', 'cost_sentinel', 'researcher'];
        const requested = (options.input.roles?.length ? options.input.roles : defaultRoles).filter(role => allowedRoleIds.has(role));
        const readOnlyRoleIds = new Set<SwarmRoleId>(['coordinator', 'project_scout', 'verifier', 'cost_sentinel', 'researcher', 'designer', 'implementer']);
        const readOnlyAllowed = requested.filter(role => readOnlyRoleIds.has(role));
        const roleResults: SwarmDispatchRoleResult[] = [];
        const swarmRoom = `swarm-${plan.turnId.slice(0, 16)}`;
        for (const role of readOnlyAllowed.slice(0, plan.budget.maxSteps)) {
            if (token.isCancellationRequested) break;
            const result = await runRoleProbe(role, plan, options.input, this.secrets, token);
            roleResults.push(result);
            // Post to concert board — every role's findings visible to all
            try {
                await concertSpeak(swarmRoom, role, result.providerText
                    ? `${result.summary}\n\nProvider analysis:\n${result.providerText.slice(0, 2000)}`
                    : result.summary);
            } catch { /* concert hall unavailable — non-fatal */ }
        }
        // ── Deliberation Protocol: evidence-gate findings, post to deliberation room ──
        const delibRecord = createDeliberationRecord(plan.turnId);
        for (const result of roleResults) {
            if (result.criticFindings?.length) {
                for (const finding of result.criticFindings) {
                    delibRecord.findings.push(finding);
                    try {
                        await postFindingToDeliberation(plan.turnId, result.role, finding);
                    } catch { /* concert hall unavailable */ }
                }
            }
        }
        // Gate all findings through evidence requirements
        const gated = gateAllFindings(delibRecord.findings);
        delibRecord.findings = gated.gated;
        delibRecord.approvalRequired = delibRecord.findings.some(f => f.severity === 'blocker' || f.severity === 'risk');
        // Check deliberation room for cross-role challenges
        const delibMessages = await checkDeliberationRoom(plan.turnId);
        const delibSummary = formatDeliberationSummary(delibRecord);
        // ── Human escalation check ──
        let escalationNote: string | undefined;
        if (requiresHumanEscalation(delibRecord)) {
            const unresolved = getUnresolvedEscalations(delibRecord);
            escalationNote = `⚠️ HUMAN ESCALATION REQUIRED: ${unresolved.length} finding(s) have low-confidence cross-role disagreement. Coordinator cannot auto-resolve.`;
        }
        // Check concert board for cross-role insights before synthesizing
        let concertMessages: string | undefined;
        try {
            const check = await concertCheck([swarmRoom]);
            if (check.messages.length > 0) {
                concertMessages = formatConcertCheck(check.messages);
            }
        } catch { /* concert hall unavailable — non-fatal */ }
        const totalEstimatedCostUsd = roleResults.reduce((total, role) => total + (role.estimatedCostUsd ?? 0), 0);
        const dispatch: SwarmDispatchReceipt = {
            version: 1,
            dispatchId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`,
            turnId: plan.turnId,
            createdAt: new Date().toISOString(),
            mode: 'read_only_probes',
            objective: plan.objective,
            providerFanoutEnabled: !!options.input.enable_provider_fanout,
            roles: roleResults,
            totalEstimatedCostUsd,
            executionEnabled: false,
            writesApplied: 0,
            terminalCommandsRun: 0,
            notes: [
                'Read-only dispatch receipt only. No patches were applied, no terminal commands were run, and no git writes were performed.',
                'Provider fan-out, when enabled, is analysis-only and records estimated cost from available usage metadata.',
                'Mutation still requires a separate harmony_swarm_escrow proposal and future guarded executor.'
            ],
        };
        const shouldWrite = options.input.write_receipt !== false && !planOnlyMode();
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (shouldWrite) {
            writtenPath = await writeDispatchReceipt(dispatch);
            skippedWrite = writtenPath ? undefined : 'Dispatch was not written because no workspace root is open.';
        } else {
            skippedWrite = planOnlyMode() && options.input.write_receipt !== false
                ? 'Plan-only mode is enabled; dispatch receipt write was skipped.'
                : 'Dispatch receipt write disabled by input.';
        }
        if (options.input.format === 'json') return textResult(JSON.stringify({ preflight, dispatch, writtenPath, skippedWrite, concertMessages, delibSummary, escalationNote }, null, 2));
        return textResult(`${formatPreflight(preflight)}\n\n${formatDispatch(dispatch, writtenPath, skippedWrite)}\n\n${delibSummary}${concertMessages ? '\n\n' + concertMessages : ''}${escalationNote ? '\n\n' + escalationNote : ''}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmDispatchInput>) {
        const base = { invocationMessage: `Dispatching read-only swarm roles${options.input.enable_provider_fanout ? ' with provider fan-out' : ''}` };
        if (!options.input.enable_provider_fanout) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Run read-only swarm provider fan-out?',
                message: new vscode.MarkdownString(`Harmony wants to ask provider **${options.input.provider ?? 'deepseek'}** to summarize read-only swarm role outputs. This may use paid model quota, but will not edit files or run terminal commands.`)
            }
        };
    }
}

class SwarmEscrowTool implements vscode.LanguageModelTool<SwarmEscrowInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmEscrowInput>): Promise<vscode.LanguageModelToolResult> {
        const receipt = await readReceiptById(options.input.turn_id?.trim() || 'latest');
        if (!receipt) return textResult(`error: swarm receipt not found: ${options.input.turn_id?.trim() || 'latest'}`);
        const proposal = buildEscrowProposal(receipt, options.input);
        const checks = validateEscrowProposal(receipt, proposal);
        const shouldWrite = options.input.write_proposal !== false && !checks.some(check => check.status === 'block') && !planOnlyMode();
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (shouldWrite) {
            writtenPath = await writeEscrowProposal(proposal);
            skippedWrite = writtenPath ? undefined : 'Proposal was not written because no workspace root is open.';
        } else if (checks.some(check => check.status === 'block')) {
            skippedWrite = 'Proposal write blocked by safety checks.';
        } else {
            skippedWrite = planOnlyMode() && options.input.write_proposal !== false
                ? 'Plan-only mode is enabled; escrow proposal write was skipped.'
                : 'Proposal write disabled by input.';
        }
        if (options.input.format === 'json') return textResult(JSON.stringify({ proposal, checks, writtenPath, skippedWrite }, null, 2));
        return textResult(formatEscrow(proposal, checks, writtenPath, skippedWrite));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmEscrowInput>) {
        return { invocationMessage: `Recording swarm escrow proposal: ${options.input.proposal_type ?? 'patch'}` };
    }
}

class SwarmExecuteTool implements vscode.LanguageModelTool<SwarmExecuteInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmExecuteInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const turnId = options.input.turn_id?.trim() || 'latest';
        const receipt = await readReceiptById(turnId);
        if (!receipt) return textResult(`error: swarm receipt not found: ${turnId}`);
        const proposal = await readEscrowProposal(receipt.turnId, options.input.proposal_id?.trim());
        if (!proposal) return textResult(`error: swarm escrow proposal not found for turn ${receipt.turnId}`);
        const preflight = await runPreflight(receipt, { turn_id: receipt.turnId, intended_action: 'execution', require_fresh_pricing: proposal.proposalType === 'provider_call' });
        if (preflight.decision === 'NO-GO') return textResult(options.input.format === 'json' ? JSON.stringify({ preflight, proposal }, null, 2) : formatPreflight(preflight));
        if (planOnlyMode()) return textResult('error: plan-only mode is enabled; swarm execution is blocked.');
        if (proposal.applied) return textResult(`error: proposal ${proposal.proposalId} was already applied/executed.`);
        const checks = validateEscrowProposal(receipt, proposal);
        if (checks.some(check => check.status === 'block')) {
            return textResult(options.input.format === 'json' ? JSON.stringify({ preflight, proposal, checks }, null, 2) : `${formatPreflight(preflight)}\n\n${formatEscrow(proposal, checks)}`);
        }
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const dryRun = options.input.dry_run === true;
        if (!dryRun) {
            const switchBlock = swarmProposalExecutionBlock(proposal.proposalType);
            if (switchBlock) return textResult(switchBlock);
        }
        let output = '';
        let status: SwarmExecutionReceipt['status'] = dryRun ? 'dry_run' : 'executed';
        let writesApplied = 0;
        let terminalCommandsRun = 0;
        let providerCallsRun = 0;
        let providerRoute: { provider: ProviderId; tier: Tier; model: string; promptTokens: number; completionTokens: number; estimatedCostUsd: number } | undefined;
        try {
            output = await withOperationLock(root, `swarm:${receipt.turnId}:${proposal.proposalId}`, 'swarm guarded execute', { proposalType: proposal.proposalType, targetPaths: proposal.targetPaths, dryRun }, async () => {
                if (token.isCancellationRequested) return 'cancelled before execution';
                if (proposal.proposalType === 'patch') {
                    const result = await executePatch(root, proposal, options.input.patch_text ?? '', dryRun);
                    if (!dryRun && result.startsWith('patch applied')) writesApplied = 1;
                    return result;
                }
                if (proposal.proposalType === 'terminal') {
                    const result = await executeTerminal(root, options.input.terminal_command ?? '', dryRun);
                    if (!dryRun && !result.startsWith('error:')) terminalCommandsRun = 1;
                    return result;
                }
                const provider = options.input.provider ?? 'deepseek';
                const tier = options.input.tier ?? 'light';
                const question = options.input.question?.trim() || proposal.summary;
                if (dryRun) return `provider dry-run: ${provider}/${tier}\nquestion: ${question}`;
                const response = await consult(this.secrets, { provider, tier, question, maxTokens: Math.max(128, Math.min(4096, Math.floor(Number(options.input.max_tokens) || 900))) }, token);
                providerCallsRun = 1;
                const promptTokens = response.usage?.promptTokens ?? Math.ceil(question.length / 4);
                const completionTokens = response.usage?.completionTokens ?? Math.ceil(response.text.length / 4);
                providerRoute = { provider: response.provider, tier, model: response.model, promptTokens, completionTokens, estimatedCostUsd: estimateCost(response.provider, response.model, promptTokens, completionTokens) ?? 0 };
                return `[${response.provider}/${response.model}]\n\n${response.text}`;
            }, 5 * 60_000);
            if (/^(error:|patch check failed|patch apply failed|terminal command failed|cancelled)/i.test(output.trim())) status = 'failed';
        } catch (error: any) {
            status = 'failed';
            output = `execution failed: ${error?.message ?? String(error)}`;
        }
        const providerCallLimit = proposal.proposalType === 'provider_call' ? 1 : 0;
        const costEstimateSource: SwarmExecutionReceipt['costEstimateSource'] = providerRoute ? 'actual_estimate' : (proposal.proposalType === 'provider_call' ? 'proposal' : 'not_provider_call');
        const proofCostUsd = providerRoute?.estimatedCostUsd ?? proposal.estimatedCostUsd;
        const budgetWithinLimit = proofCostUsd <= receipt.budget.maxCostUsd;
        const execution: SwarmExecutionReceipt = {
            version: 1,
            executionId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`,
            turnId: receipt.turnId,
            proposalId: proposal.proposalId,
            createdAt: new Date().toISOString(),
            dryRun,
            proposalType: proposal.proposalType,
            targetPaths: proposal.targetPaths,
            status,
            writesApplied,
            terminalCommandsRun,
            providerCallsRun,
            providerCallLimit,
            provider: providerRoute?.provider,
            tier: providerRoute?.tier,
            model: providerRoute?.model,
            promptTokens: providerRoute?.promptTokens,
            completionTokens: providerRoute?.completionTokens,
            proposalEstimatedCostUsd: proposal.estimatedCostUsd,
            estimatedCostUsd: providerRoute?.estimatedCostUsd,
            costBudgetUsd: receipt.budget.maxCostUsd,
            costBudgetRemainingUsd: proposal.proposalType === 'provider_call' || typeof providerRoute?.estimatedCostUsd === 'number' ? Math.max(0, receipt.budget.maxCostUsd - proofCostUsd) : undefined,
            budgetWithinLimit,
            costEstimateSource,
            budgetProof: [
                `proposal estimated cost $${proposal.estimatedCostUsd.toFixed(6)} <= plan budget $${receipt.budget.maxCostUsd.toFixed(6)}`,
                providerRoute ? `actual estimated cost $${providerRoute.estimatedCostUsd.toFixed(6)} from ${providerRoute.promptTokens} prompt token(s) and ${providerRoute.completionTokens} completion token(s)` : `${proposal.proposalType} execution did not run a provider call`,
                `budget verdict: ${budgetWithinLimit ? 'within_budget' : 'over_budget'} using ${costEstimateSource}`,
                `writes ${writesApplied}/${receipt.budget.maxWrites}; terminal commands ${terminalCommandsRun}/${receipt.budget.maxTerminalCommands}; provider calls ${providerCallsRun}/${providerCallLimit}`,
            ],
            output,
            validationPlan: proposal.validationPlan
        };
        if (!dryRun && status === 'executed') {
            proposal.applied = true;
            proposal.notes = [...proposal.notes, `Executed by ${execution.executionId} at ${execution.createdAt}.`];
            await updateEscrowProposal(proposal);
        }
        const shouldWrite = options.input.write_receipt !== false;
        const writtenPath = shouldWrite ? await writeExecutionReceipt(execution) : undefined;
        const skippedWrite = shouldWrite ? undefined : 'Execution receipt write disabled by input.';
        if (writtenPath) execution.receiptPath = writtenPath;
        if (options.input.format === 'json') return textResult(JSON.stringify({ preflight, checks, execution, writtenPath, skippedWrite }, null, 2));
        return textResult(`${formatPreflight(preflight)}\n\n${formatExecution(execution, writtenPath, skippedWrite)}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmExecuteInput>) {
        return {
            invocationMessage: `Executing guarded swarm proposal${options.input.dry_run ? ' (dry run)' : ''}`,
            confirmationMessages: {
                title: options.input.dry_run ? 'Dry-run swarm execution?' : 'Execute guarded swarm proposal?',
                message: new vscode.MarkdownString('Harmony wants to consume one swarm escrow proposal under operation locks. Patch, terminal, and provider actions are limited by the execution_guarded receipt and will write a private execution receipt under `.harmony/swarm`.')
            }
        };
    }
}

async function listEscrowProposals(turnId: string, proposalIds: string[] | undefined, limit: number): Promise<SwarmEscrowProposal[]> {
    const root = workspaceRoot();
    if (!root) return [];
    const cleanIds = (proposalIds ?? []).map(id => id.trim()).filter(Boolean);
    if (cleanIds.length) {
        const found: SwarmEscrowProposal[] = [];
        for (const id of cleanIds.slice(0, limit)) {
            const proposal = await readEscrowProposal(turnId, id);
            if (proposal) found.push(proposal);
        }
        return found;
    }
    const safeTurnId = turnId.replace(/[^a-zA-Z0-9._-]/g, '');
    const dir = path.join(root, SWARM_DIR, safeTurnId, 'escrow');
    const entries: Array<{ name: string; isFile(): boolean }> = await fs.readdir(dir, { withFileTypes: true }).catch((): Array<{ name: string; isFile(): boolean }> => []);
    const proposals: SwarmEscrowProposal[] = [];
    for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).slice(-50)) {
        try {
            proposals.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')) as SwarmEscrowProposal);
        } catch {
            // Ignore malformed proposal receipts so one bad file cannot hide the rest.
        }
    }
    return proposals
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
}

function proposalPayloadsById(input: SwarmAutonomyRunInput): Map<string, SwarmProposalExecutionPayload> {
    const map = new Map<string, SwarmProposalExecutionPayload>();
    for (const payload of input.proposal_payloads ?? []) {
        const id = payload.proposal_id?.trim();
        if (id) map.set(id, payload);
    }
    return map;
}

async function gitPorcelainStatus(root: string): Promise<ProcessRun> {
    return execFile('git', ['status', '--porcelain'], root, 60000);
}

function autonomyRunId(): string {
    return `swarm-autonomy-run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

async function writeAutonomyRunReceipt(receipt: SwarmAutonomyRunReceipt): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, receipt.turnId, 'autonomy-runs');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${receipt.runId}.json`);
    const payload = JSON.stringify(receipt, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(root, SWARM_DIR, receipt.turnId, 'latest-autonomy-run.json'), payload, 'utf8');
    return relPath(target);
}

async function writeCommitProposalReceipt(receipt: SwarmAutonomyRunReceipt, input: SwarmAutonomyRunInput): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, receipt.turnId, 'commit-proposals');
    await fs.mkdir(dir, { recursive: true });
    const gitStatus = await runGit(['status', '--short']);
    const proposal = {
        version: 1,
        commitProposalId: `swarm-commit-proposal-${receipt.runId}`,
        createdAt: new Date().toISOString(),
        runId: receipt.runId,
        turnId: receipt.turnId,
        message: input.commit_message?.trim() || `Harmony swarm: ${receipt.steps.map(step => step.proposalId).join(', ')}`,
        includedProposalIds: receipt.steps.filter(step => step.status === 'executed' || step.status === 'dry_run' || step.status === 'planned').map(step => step.proposalId),
        validationCommand: receipt.validationCommand ?? null,
        gitStatus,
        note: 'Commit proposal only. Harmony did not run git add, git commit, git push, reset, clean, or branch switching for this receipt.'
    };
    const target = path.join(dir, `${receipt.runId}.json`);
    const payload = JSON.stringify(proposal, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(dir, 'latest-commit-proposal.json'), payload, 'utf8');
    return relPath(target);
}

async function readAutonomyRunReceipt(turnId: string, runId?: string): Promise<SwarmAutonomyRunReceipt | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const safeTurnId = safeSwarmId(turnId);
    const target = runId?.trim()
        ? path.join(root, SWARM_DIR, safeTurnId, 'autonomy-runs', `${safeSwarmId(runId.trim())}.json`)
        : path.join(root, SWARM_DIR, safeTurnId, 'latest-autonomy-run.json');
    try {
        return JSON.parse(await fs.readFile(target, 'utf8')) as SwarmAutonomyRunReceipt;
    } catch {
        return undefined;
    }
}

async function readCommitDryRunReceipt(turnId: string, dryRunId?: string, receiptPath?: string): Promise<SwarmCommitDryRunReceipt | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    if (receiptPath?.trim()) {
        const target = resolveWorkspaceContainedPath(root, receiptPath.trim());
        if (!target) return undefined;
        try {
            return JSON.parse(await fs.readFile(target, 'utf8')) as SwarmCommitDryRunReceipt;
        } catch {
            return undefined;
        }
    }
    const safeTurnId = safeSwarmId(turnId);
    const target = dryRunId?.trim()
        ? path.join(root, SWARM_DIR, safeTurnId, 'commit-dry-runs', `${safeSwarmId(dryRunId.trim())}.json`)
        : path.join(root, SWARM_DIR, safeTurnId, 'commit-dry-runs', 'latest-commit-dry-run.json');
    try {
        return JSON.parse(await fs.readFile(target, 'utf8')) as SwarmCommitDryRunReceipt;
    } catch {
        return undefined;
    }
}

async function writeCommitDryRunReceipt(receipt: SwarmCommitDryRunReceipt): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, receipt.turnId, 'commit-dry-runs');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${receipt.dryRunId}.json`);
    const payload = JSON.stringify(receipt, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(dir, 'latest-commit-dry-run.json'), payload, 'utf8');
    return relPath(target);
}

async function writeCommitExecutionReceipt(receipt: SwarmCommitExecutionReceipt): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, receipt.turnId, 'commit-executions');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${receipt.executionId}.json`);
    const payload = JSON.stringify(receipt, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(dir, 'latest-commit-execution.json'), payload, 'utf8');
    return relPath(target);
}

async function validateCommitSnapshotReceipt(root: string, receiptPath: string, manifestPaths: string[]): Promise<SnapshotReceiptValidation> {
    const validation: SnapshotReceiptValidation = {
        status: 'invalid',
        receiptPath: normalizeScopePath(receiptPath),
        copiedPaths: [],
        missingManifestPaths: [],
        issues: [],
    };
    const target = resolveWorkspaceContainedPath(root, receiptPath);
    if (!target) {
        validation.issues.push('snapshot_receipt_path must resolve inside the active workspace');
        return validation;
    }
    validation.manifestPath = relPath(target);
    let raw = '';
    try {
        raw = await fs.readFile(target, 'utf8');
    } catch {
        validation.issues.push(`snapshot receipt does not exist: ${receiptPath}`);
        return validation;
    }
    let manifest: any;
    try {
        manifest = JSON.parse(raw);
    } catch {
        validation.issues.push('snapshot receipt must be parseable JSON');
        return validation;
    }
    if (manifest?.version !== 1) validation.issues.push('snapshot manifest version must be 1');
    if (typeof manifest?.id !== 'string' || !manifest.id.trim()) validation.issues.push('snapshot manifest id is missing');
    else {
        validation.snapshotId = manifest.id.trim();
        validation.restoreCommand = `node bin/harmony-cli.js --workspace "${root}" snapshot restore --id ${validation.snapshotId} --all --confirm`;
    }
    if (!Array.isArray(manifest?.files)) {
        validation.issues.push('snapshot manifest files array is missing');
        return validation;
    }
    validation.copiedPaths = uniqueSorted(manifest.files
        .filter((file: any) => file?.copied === true && typeof file.path === 'string')
        .map((file: any) => file.path));
    const copied = new Set(validation.copiedPaths.map(normalizeScopePath));
    validation.missingManifestPaths = manifestPaths.filter(targetPath => !copied.has(normalizeScopePath(targetPath)));
    if (validation.missingManifestPaths.length) {
        validation.issues.push(`snapshot manifest does not contain copied restore entries for manifest path(s): ${validation.missingManifestPaths.join(', ')}`);
    }
    validation.status = validation.issues.length ? 'invalid' : 'valid';
    return validation;
}

async function runCommitDryRunGit(root: string, manifestPaths: string[]): Promise<Record<string, ProcessRun>> {
    const pathspec = ['--', ...manifestPaths];
    return {
        status: await execFile('git', ['status', '--porcelain'], root, 60000),
        manifestDiffNameOnly: await execFile('git', ['diff', '--name-only', ...pathspec], root, 60000),
        manifestDiffStat: await execFile('git', ['diff', '--stat', ...pathspec], root, 60000),
        manifestDiffCheck: await execFile('git', ['diff', '--check', ...pathspec], root, 60000),
        stagedNameOnly: await execFile('git', ['diff', '--cached', '--name-only', ...pathspec], root, 60000),
        stagedDiffCheck: await execFile('git', ['diff', '--cached', '--check', ...pathspec], root, 60000),
        addDryRun: await execFile('git', ['add', '--dry-run', ...pathspec], root, 60000),
    };
}

function commitDryRunId(): string {
    return `swarm-commit-dry-run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

function commitExecutionId(): string {
    return `swarm-commit-execute-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

function formatCommitDryRun(receipt: SwarmCommitDryRunReceipt, writtenPath?: string, skippedWrite?: string): string {
    const gitRows = Object.entries(receipt.git).map(([name, result]) => `${name}: ${result.ok ? 'ok' : 'failed'}${result.error ? ` (${result.error})` : ''}`);
    return [
        '# Harmony Swarm Commit Dry Run',
        '',
        `Dry run id: ${receipt.dryRunId}`,
        `Turn id: ${receipt.turnId}`,
        receipt.autonomyRunId ? `Autonomy run id: ${receipt.autonomyRunId}` : 'Autonomy run id: none',
        `Status: ${receipt.status}`,
        `Commit message: ${receipt.commitMessage}`,
        writtenPath ? `Receipt written: ${writtenPath}` : (skippedWrite ?? 'Receipt not written.'),
        '',
        section('Included Proposals', receipt.includedProposalIds),
        '',
        section('Manifest Paths', receipt.manifestPaths),
        '',
        section('Checks', receipt.checks),
        '',
        section('Unexpected Status Paths', receipt.unexpectedStatusPaths),
        '',
        section('Blocked Paths', receipt.blockedPaths),
        '',
        section('Git Dry-Run Commands', gitRows),
        '',
        section('Snapshot Requirement', [
            `required: ${receipt.snapshotRequirement.required ? 'yes' : 'no'}`,
            `status: ${receipt.snapshotRequirement.status}`,
            `receipt: ${receipt.snapshotRequirement.receiptPath ?? '(none)'}`
        ]),
        '',
        section('Notes', receipt.notes),
    ].join('\n');
}

function formatCommitExecution(receipt: SwarmCommitExecutionReceipt, writtenPath?: string, skippedWrite?: string): string {
    const gitRows = Object.entries(receipt.git).map(([name, result]) => `${name}: ${result.ok ? 'ok' : 'failed'}${result.error ? ` (${result.error})` : ''}`);
    const snapshotRows = receipt.snapshotReceipt ? [
        `status: ${receipt.snapshotReceipt.status}`,
        `manifest: ${receipt.snapshotReceipt.manifestPath ?? receipt.snapshotReceipt.receiptPath}`,
        `snapshot id: ${receipt.snapshotReceipt.snapshotId ?? '(missing)'}`,
        `copied manifest paths: ${receipt.snapshotReceipt.copiedPaths.length}`,
        `missing manifest paths: ${receipt.snapshotReceipt.missingManifestPaths.length ? receipt.snapshotReceipt.missingManifestPaths.join(', ') : '(none)'}`,
        `restore command: ${receipt.snapshotReceipt.restoreCommand ?? '(unavailable)'}`,
    ] : [`receipt: ${receipt.snapshotReceiptPath || '(missing)'}`];
    return [
        '# Harmony Swarm Commit Execution',
        '',
        `Execution id: ${receipt.executionId}`,
        `Turn id: ${receipt.turnId}`,
        `Dry-run id: ${receipt.dryRunId}`,
        `Status: ${receipt.status}`,
        `Commit message: ${receipt.commitMessage}`,
        receipt.commitHash ? `Commit hash: ${receipt.commitHash}` : 'Commit hash: none',
        writtenPath ? `Receipt written: ${writtenPath}` : (skippedWrite ?? 'Receipt not written.'),
        '',
        section('Manifest Paths', receipt.manifestPaths),
        '',
        section('Checks', receipt.checks),
        '',
        section('Staged Paths', receipt.stagedPaths),
        '',
        section('Unexpected Status Paths', receipt.unexpectedStatusPaths),
        '',
        section('Blocked Paths', receipt.blockedPaths),
        '',
        section('Git Commands', gitRows),
        '',
        section('Snapshot Receipt', snapshotRows),
        '',
        section('Validation', receipt.validationOutput ?? '(not run)'),
        '',
        section('Recovery Notes', receipt.notes),
    ].join('\n');
}

interface SwarmCommitFixtureReport {
    version: 1;
    fixtureId: string;
    createdAt: string;
    status: 'passed' | 'failed';
    workspaceRoot: string;
    tempRootRemoved: boolean;
    turnId?: string;
    proposalId?: string;
    dryRunId?: string;
    executionId?: string;
    commitHash?: string;
    reportPath?: string;
    snapshotManifest?: string;
    toolSteps: Array<{ tool: string; status: 'ok' | 'failed'; textPreview: string }>;
    checks: string[];
    error?: string;
}

interface SwarmDeepSeekLiveFixtureReport {
    version: 1;
    fixtureId: string;
    createdAt: string;
    status: 'passed' | 'failed';
    workspaceRoot?: string;
    provider: 'deepseek';
    tier: 'coding';
    expectedModel: 'deepseek-v4-flash';
    maxProviderCalls: 1;
    turnId?: string;
    proposalId?: string;
    executionId?: string;
    providerCallsRun?: number;
    providerCallLimit?: number;
    model?: string;
    proposalEstimatedCostUsd?: number;
    estimatedCostUsd?: number;
    costBudgetUsd?: number;
    costBudgetRemainingUsd?: number;
    budgetWithinLimit?: boolean;
    costEstimateSource?: string;
    budgetProof?: string[];
    outputSha256?: string;
    reportPath?: string;
    checks: string[];
    error?: string;
}

function toolResultText(result: vscode.LanguageModelToolResult): string {
    return result.content.map((part: any) => typeof part?.value === 'string' ? part.value : JSON.stringify(part?.value ?? part)).join('\n');
}

async function invokeFixtureTool(tool: string, input: Record<string, unknown>, report: SwarmCommitFixtureReport): Promise<any> {
    const result = await vscode.lm.invokeTool(tool, { toolInvocationToken: undefined, input });
    const text = toolResultText(result);
    const step = { tool, status: 'ok' as 'ok' | 'failed', textPreview: text.slice(0, 2000) };
    try {
        const parsed = JSON.parse(text);
        report.toolSteps.push(step);
        return parsed;
    } catch (error: any) {
        step.status = 'failed';
        report.toolSteps.push(step);
        throw new Error(`${tool} did not return parseable JSON: ${error?.message ?? String(error)}`);
    }
}

async function requireFixtureGit(root: string, args: string[], label: string): Promise<ProcessRun> {
    const result = await execFile('git', args, root, 120000);
    if (!result.ok) throw new Error(`${label} failed: ${result.error ?? result.stderr}`.trim());
    return result;
}

function fixtureSnapshotCopyName(relativePath: string): string {
    const normalized = normalizeScopePath(relativePath);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
    return `${hash}-${path.basename(normalized).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'file'}`;
}

async function createFixtureSnapshot(root: string, relativePath: string): Promise<{ id: string; manifestPath: string; relativeManifestPath: string }> {
    const normalized = normalizeScopePath(relativePath);
    const target = resolveWorkspaceContainedPath(root, normalized);
    if (!target) throw new Error(`fixture snapshot target escapes workspace: ${relativePath}`);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`fixture snapshot target is not a file: ${relativePath}`);
    const id = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const snapshotDir = path.join(root, '.harmony', 'snapshots', id);
    const filesDir = path.join(snapshotDir, 'files');
    await fs.mkdir(filesDir, { recursive: true });
    const copyName = fixtureSnapshotCopyName(normalized);
    await fs.copyFile(target, path.join(filesDir, copyName));
    const manifest = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        mode: 'small-text-copy',
        note: 'Disposable VS Code swarm commit fixture pre-action snapshot.',
        limits: { maxFiles: 1, maxBytes: 256 * 1024 },
        excludes: [],
        files: [{
            path: normalized,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            copied: true,
            copyPath: `files/${copyName}`,
        }],
    };
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { id, manifestPath, relativeManifestPath: normalizeScopePath(path.relative(root, manifestPath)) };
}

async function withFixtureWorkspace<T>(root: string, safetySwitches: Record<string, boolean>, task: () => Promise<T>): Promise<T> {
    if (fixtureWorkspaceRoot) throw new Error('another Harmony swarm fixture is already running');
    fixtureWorkspaceRoot = root;
    fixtureSafetySwitches = safetySwitches;
    try {
        return await task();
    } finally {
        fixtureWorkspaceRoot = undefined;
        fixtureSafetySwitches = undefined;
    }
}

async function writeSwarmFixtureReport(hostRoot: string | undefined, report: { fixtureId: string; reportPath?: string }): Promise<string | undefined> {
    const reportRoot = process.env.HARMONY_FIXTURE_REPORT_ROOT?.trim();
    const base = reportRoot || hostRoot || os.tmpdir();
    const dir = path.join(base, '.harmony', 'smoke');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${report.fixtureId}.json`);
    report.reportPath = reportRoot || hostRoot ? normalizeScopePath(path.relative(base, target)) : target;
    await fs.writeFile(target, JSON.stringify(report, null, 2), 'utf8');
    return report.reportPath;
}

async function runDisposableSwarmCommitFixture(): Promise<SwarmCommitFixtureReport> {
    const hostRoot = workspaceFoldersByPriority()[0]?.uri.fsPath;
    const fixtureId = `vscode-swarm-commit-fixture-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${fixtureId}-`));
    const report: SwarmCommitFixtureReport = {
        version: 1,
        fixtureId,
        createdAt: new Date().toISOString(),
        status: 'failed',
        workspaceRoot: tempRoot,
        tempRootRemoved: false,
        toolSteps: [],
        checks: [],
    };
    try {
        await fs.writeFile(path.join(tempRoot, '.gitignore'), '.harmony/\n', 'utf8');
        await fs.writeFile(path.join(tempRoot, 'fixture.txt'), 'base\n', 'utf8');
        await requireFixtureGit(tempRoot, ['init'], 'git init');
        await requireFixtureGit(tempRoot, ['config', 'user.email', 'harmony-fixture@example.invalid'], 'git config user.email');
        await requireFixtureGit(tempRoot, ['config', 'user.name', 'Harmony Fixture'], 'git config user.name');
        await requireFixtureGit(tempRoot, ['add', '.gitignore', 'fixture.txt'], 'git add base');
        await requireFixtureGit(tempRoot, ['commit', '-m', 'fixture base'], 'git commit base');
        const snapshot = await createFixtureSnapshot(tempRoot, 'fixture.txt');
        report.snapshotManifest = snapshot.relativeManifestPath;
        const commitMessage = 'Harmony fixture: direct swarm commit tool path';
        const validationCommand = 'node -e "process.exit(0)"';
        let dryRunReceiptPath = '';

        await withFixtureWorkspace(tempRoot, {
            'mutationExecution.enabled': true,
            'patchExecution.enabled': true,
            'terminalExecution.enabled': true,
            'commitExecution.enabled': true,
        }, async () => {
            const plan = await invokeFixtureTool('harmony_swarm_plan', {
                objective: 'Disposable VS Code tool-path swarm commit fixture.',
                mode: 'execution_guarded',
                scope_paths: ['fixture.txt'],
                max_writes: 1,
                max_terminal_commands: 0,
                write_receipt: true,
                format: 'json',
            }, report);
            report.turnId = plan?.receipt?.turnId;
            if (!report.turnId) throw new Error('fixture swarm plan did not produce a turn id');

            const escrow = await invokeFixtureTool('harmony_swarm_escrow', {
                turn_id: report.turnId,
                title: 'Apply fixture text change',
                proposal_type: 'patch',
                target_paths: ['fixture.txt'],
                summary: 'Append one line to a disposable fixture file.',
                validation_plan: ['node -e "process.exit(0)"'],
                rollback_plan: `Restore with node bin/harmony-cli.js snapshot restore --id ${snapshot.id} --all --confirm`,
                write_proposal: true,
                format: 'json',
            }, report);
            report.proposalId = escrow?.proposal?.proposalId;
            if (!report.proposalId) throw new Error('fixture escrow did not produce a proposal id');

            const patchText = [
                'diff --git a/fixture.txt b/fixture.txt',
                '--- a/fixture.txt',
                '+++ b/fixture.txt',
                '@@ -1 +1,2 @@',
                ' base',
                '+from VS Code registered Harmony swarm tools',
                '',
            ].join('\n');
            const execution = await invokeFixtureTool('harmony_swarm_execute', {
                turn_id: report.turnId,
                proposal_id: report.proposalId,
                dry_run: false,
                patch_text: patchText,
                write_receipt: true,
                format: 'json',
            }, report);
            if (execution?.execution?.status !== 'executed') throw new Error(`fixture patch execution did not execute: ${execution?.execution?.status ?? 'unknown'}`);
            if (execution?.execution?.budgetWithinLimit !== true || execution?.execution?.costEstimateSource !== 'not_provider_call') throw new Error('fixture patch execution receipt did not record an explicit non-provider budget verdict');
            if (execution?.execution?.providerCallLimit !== 0 || !execution?.execution?.budgetProof?.some((line: string) => line.includes('budget verdict: within_budget'))) throw new Error('fixture patch execution receipt did not record provider-call limit and budget proof');

            const dryRun = await invokeFixtureTool('harmony_swarm_commit_dry_run', {
                turn_id: report.turnId,
                proposal_ids: [report.proposalId],
                commit_message: commitMessage,
                validation_command: validationCommand,
                snapshot_receipt_path: snapshot.relativeManifestPath,
                require_clean_manifest: true,
                write_receipt: true,
                format: 'json',
            }, report);
            report.dryRunId = dryRun?.receipt?.dryRunId;
            if (dryRun?.receipt?.status !== 'ready') throw new Error(`fixture commit dry-run was not ready: ${dryRun?.receipt?.status ?? 'unknown'}`);
            dryRunReceiptPath = dryRun?.receipt?.receiptPath ?? `.harmony/swarm/${safeSwarmId(report.turnId)}/commit-dry-runs/latest-commit-dry-run.json`;

            const commit = await invokeFixtureTool('harmony_swarm_commit_execute', {
                turn_id: report.turnId,
                dry_run_receipt_path: dryRunReceiptPath,
                commit_message: commitMessage,
                validation_command: validationCommand,
                snapshot_receipt_path: snapshot.relativeManifestPath,
                require_clean_manifest: true,
                confirm_execute: true,
                write_receipt: true,
                format: 'json',
            }, report);
            report.executionId = commit?.receipt?.executionId;
            report.commitHash = commit?.receipt?.commitHash;
            if (commit?.receipt?.status !== 'committed') throw new Error(`fixture commit execution did not commit: ${commit?.receipt?.status ?? 'unknown'}`);
        });

        await withFixtureWorkspace(tempRoot, {
            'mutationExecution.enabled': true,
            'patchExecution.enabled': true,
            'terminalExecution.enabled': false,
            'autonomyExecution.enabled': true,
            'commitExecution.enabled': true,
        }, async () => {
            const autonomyBlocked = await invokeFixtureTool('harmony_swarm_autonomy_run', {
                turn_id: report.turnId,
                proposal_ids: [report.proposalId],
                mode: 'execute',
                confirm_execute: true,
                validation_command: validationCommand,
                write_receipt: true,
                format: 'json',
            }, report);
            const autonomyText = JSON.stringify(autonomyBlocked);
            if (autonomyBlocked?.run?.status !== 'blocked' || !autonomyText.includes('swarm validation command execution')) {
                throw new Error(`fixture autonomy validation gate did not block with terminal execution disabled: ${autonomyBlocked?.run?.status ?? 'unknown'}`);
            }

            const commitBlocked = await invokeFixtureTool('harmony_swarm_commit_execute', {
                turn_id: report.turnId,
                dry_run_receipt_path: dryRunReceiptPath,
                commit_message: commitMessage,
                validation_command: validationCommand,
                snapshot_receipt_path: snapshot.relativeManifestPath,
                require_clean_manifest: true,
                confirm_execute: true,
                write_receipt: true,
                format: 'json',
            }, report);
            const commitText = JSON.stringify(commitBlocked);
            if (commitBlocked?.receipt?.status !== 'blocked' || !commitText.includes('swarm validation command execution')) {
                throw new Error(`fixture commit validation gate did not block with terminal execution disabled: ${commitBlocked?.receipt?.status ?? 'unknown'}`);
            }

            const providerBudgetBlocked = await invokeFixtureTool('harmony_swarm_escrow', {
                turn_id: report.turnId,
                title: 'Reject zero-estimate provider call',
                proposal_type: 'provider_call',
                target_paths: [],
                summary: 'This no-network edge case must be blocked because provider calls require an explicit positive cost estimate.',
                validation_plan: ['Blocked provider-call proposals do not write or call providers.'],
                estimated_cost_usd: 0,
                write_proposal: true,
                format: 'json',
            }, report);
            const providerBudgetText = JSON.stringify(providerBudgetBlocked);
            if (!providerBudgetText.includes('positive estimated_cost_usd')) {
                throw new Error('fixture provider-call escrow did not block the missing positive cost estimate');
            }
        });

        const status = await requireFixtureGit(tempRoot, ['status', '--porcelain'], 'git status after fixture commit');
        if (status.stdout.trim()) throw new Error(`fixture repo was not clean after commit: ${status.stdout.trim()}`);
        const latestSubject = await requireFixtureGit(tempRoot, ['log', '-1', '--pretty=%s'], 'git log after fixture commit');
        if (latestSubject.stdout.trim() !== 'Harmony fixture: direct swarm commit tool path') throw new Error(`unexpected fixture commit subject: ${latestSubject.stdout.trim()}`);
        report.checks.push('registered VS Code LM tool path invoked plan, escrow, execute, commit dry-run, and commit execute tools');
        report.checks.push('bounded autonomy and commit execution validation commands block when terminal execution is disabled');
        report.checks.push('provider-call escrow without a positive cost estimate is blocked without network calls');
        report.checks.push('fixture commit touched only fixture.txt in a disposable git repo');
        report.checks.push('fixture repo ended with clean git status');
        report.status = 'passed';
    } catch (error: any) {
        report.error = error?.message ?? String(error);
    } finally {
        if (report.status === 'passed') {
            await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
            report.tempRootRemoved = true;
        }
        await writeSwarmFixtureReport(hostRoot, report);
    }
    return report;
}

function parseFixtureJsonResult(result: vscode.LanguageModelToolResult, label: string): any {
    const text = toolResultText(result);
    try {
        return JSON.parse(text);
    } catch (error: any) {
        throw new Error(`${label} did not return parseable JSON: ${error?.message ?? String(error)}`);
    }
}

async function runDisposableSwarmDeepSeekLiveFixture(secrets: vscode.SecretStorage): Promise<SwarmDeepSeekLiveFixtureReport> {
    const hostRoot = workspaceFoldersByPriority()[0]?.uri.fsPath;
    const fixtureId = `vscode-swarm-deepseek-live-fixture-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const report: SwarmDeepSeekLiveFixtureReport = {
        version: 1,
        fixtureId,
        createdAt: new Date().toISOString(),
        status: 'failed',
        workspaceRoot: hostRoot,
        provider: 'deepseek',
        tier: 'coding',
        expectedModel: 'deepseek-v4-flash',
        maxProviderCalls: 1,
        checks: [],
    };
    try {
        if (!hostRoot) throw new Error('no workspace folder is open for live DeepSeek swarm fixture');
        const pricingDir = path.join(hostRoot, '.harmony', 'provider-pricing');
        await fs.mkdir(pricingDir, { recursive: true });
        await fs.writeFile(path.join(pricingDir, 'latest.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), staleAfterDays: 7 }, null, 2), 'utf8');
        report.checks.push('fresh disposable pricing snapshot written');

        await withFixtureWorkspace(hostRoot, {
            'mutationExecution.enabled': true,
            'providerCalls.enabled': true,
        }, async () => {
            const planResult = await new SwarmPlanTool().invoke({
                toolInvocationToken: undefined,
                input: {
                    objective: 'Live fixture: ask DeepSeek V4 Flash one tiny bounded swarm provider-call question.',
                    mode: 'execution_guarded',
                    roles: ['coordinator', 'cost_sentinel'],
                    max_cost_usd: 0.01,
                    max_steps: 1,
                    max_writes: 0,
                    max_terminal_commands: 0,
                    write_receipt: true,
                    format: 'json',
                },
            } as any);
            const plan = parseFixtureJsonResult(planResult, 'harmony_swarm_plan');
            report.turnId = plan?.receipt?.turnId;
            if (!report.turnId) throw new Error('live fixture swarm plan did not produce a turn id');

            const escrowResult = await new SwarmEscrowTool().invoke({
                toolInvocationToken: undefined,
                input: {
                    turn_id: report.turnId,
                    title: 'Live DeepSeek V4 Flash provider check',
                    proposal_type: 'provider_call',
                    target_paths: [],
                    summary: 'Ask DeepSeek V4 Flash to answer a fixed low-token smoke prompt.',
                    validation_plan: ['Provider-call receipt records providerCallsRun=1 and deepseek-v4-flash model.'],
                    estimated_cost_usd: 0.001,
                    write_proposal: true,
                    format: 'json',
                },
            } as any);
            const escrow = parseFixtureJsonResult(escrowResult, 'harmony_swarm_escrow');
            report.proposalId = escrow?.proposal?.proposalId;
            if (!report.proposalId) throw new Error('live fixture swarm escrow did not produce a provider-call proposal id');

            const tokenSource = new vscode.CancellationTokenSource();
            try {
                const executeResult = await new SwarmExecuteTool(secrets).invoke({
                    toolInvocationToken: undefined,
                    input: {
                        turn_id: report.turnId,
                        proposal_id: report.proposalId,
                        dry_run: false,
                        provider: 'deepseek',
                        tier: 'coding',
                        question: 'Reply with exactly: Harmony DeepSeek V4 Flash swarm live check passed.',
                        max_tokens: 128,
                        write_receipt: true,
                        format: 'json',
                    },
                } as any, tokenSource.token);
                const execution = parseFixtureJsonResult(executeResult, 'harmony_swarm_execute')?.execution;
                if (execution?.status !== 'executed') throw new Error(`live fixture execution did not execute: ${execution?.status ?? 'unknown'}`);
                if (execution.providerCallsRun !== 1) throw new Error(`live fixture provider call count was ${execution.providerCallsRun ?? 'unknown'}, expected 1`);
                if (!/^\[deepseek\/deepseek-v4-flash\]/.test(execution.output || '')) throw new Error('live fixture did not use deepseek-v4-flash');
                if (execution.provider !== 'deepseek' || execution.tier !== 'coding' || execution.model !== 'deepseek-v4-flash') throw new Error('live fixture execution receipt did not record the exact provider/tier/model route');
                if (typeof execution.estimatedCostUsd !== 'number' || execution.estimatedCostUsd < 0 || execution.estimatedCostUsd > execution.costBudgetUsd) throw new Error('live fixture execution receipt did not record an in-budget provider cost estimate');
                if (execution.providerCallLimit !== 1 || execution.budgetWithinLimit !== true || execution.costEstimateSource !== 'actual_estimate') throw new Error('live fixture execution receipt did not record explicit provider-call budget verdict fields');
                if (!Array.isArray(execution.budgetProof) || !execution.budgetProof.some((line: string) => line.includes('actual estimated cost'))) throw new Error('live fixture execution receipt did not include actual cost budget proof');
                report.executionId = execution.executionId;
                report.providerCallsRun = execution.providerCallsRun;
                report.providerCallLimit = execution.providerCallLimit;
                report.model = 'deepseek-v4-flash';
                report.proposalEstimatedCostUsd = execution.proposalEstimatedCostUsd;
                report.estimatedCostUsd = execution.estimatedCostUsd;
                report.costBudgetUsd = execution.costBudgetUsd;
                report.costBudgetRemainingUsd = execution.costBudgetRemainingUsd;
                report.budgetWithinLimit = execution.budgetWithinLimit;
                report.costEstimateSource = execution.costEstimateSource;
                report.budgetProof = execution.budgetProof;
                report.outputSha256 = crypto.createHash('sha256').update(execution.output || '', 'utf8').digest('hex');
                report.checks.push('live swarm provider-call execution used deepseek-v4-flash exactly once with cost/budget proof');
            } finally {
                tokenSource.dispose();
            }
        });
        report.status = 'passed';
    } catch (error: any) {
        report.error = error?.message ?? String(error);
    } finally {
        await writeSwarmFixtureReport(hostRoot, report);
    }
    return report;
}

function blockedStep(proposal: SwarmEscrowProposal, output: string): SwarmAutonomyStepResult {
    return {
        proposalId: proposal.proposalId,
        proposalType: proposal.proposalType,
        status: 'blocked',
        output,
        writesApplied: 0,
        terminalCommandsRun: 0,
        providerCallsRun: 0,
    };
}

function missingPayloadMessage(proposal: SwarmEscrowProposal): string | undefined {
    if (proposal.proposalType === 'patch') return 'patch_text is required in proposal_payloads for patch proposals.';
    if (proposal.proposalType === 'terminal') return 'terminal_command is required in proposal_payloads for terminal proposals.';
    return undefined;
}

async function executeAutonomyProposal(root: string, proposal: SwarmEscrowProposal, payload: SwarmProposalExecutionPayload | undefined, mode: 'plan' | 'dry_run' | 'execute', secrets: vscode.SecretStorage, token: vscode.CancellationToken): Promise<SwarmAutonomyStepResult> {
    if (mode === 'plan') {
        return {
            proposalId: proposal.proposalId,
            proposalType: proposal.proposalType,
            status: 'planned',
            output: `${proposal.title}: ${proposal.summary}`,
            writesApplied: 0,
            terminalCommandsRun: 0,
            providerCallsRun: 0,
        };
    }
    const missing = missingPayloadMessage(proposal);
    if (missing && !payload) return blockedStep(proposal, missing);
    if (proposal.proposalType === 'patch' && !payload?.patch_text?.trim()) return blockedStep(proposal, 'patch_text is required for this patch proposal.');
    if (proposal.proposalType === 'terminal' && !payload?.terminal_command?.trim()) return blockedStep(proposal, 'terminal_command is required for this terminal proposal.');
    if (mode === 'execute') {
        const switchBlock = swarmProposalExecutionBlock(proposal.proposalType);
        if (switchBlock) return blockedStep(proposal, switchBlock);
    }
    let output = '';
    let writesApplied = 0;
    let terminalCommandsRun = 0;
    let providerCallsRun = 0;
    let status: SwarmAutonomyStepResult['status'] = mode === 'dry_run' ? 'dry_run' : 'executed';
    try {
        output = await withOperationLock(root, `swarm:${proposal.turnId}:${proposal.proposalId}`, 'swarm autonomy proposal step', { proposalType: proposal.proposalType, mode }, async () => {
            if (token.isCancellationRequested) return 'cancelled before execution';
            if (proposal.proposalType === 'patch') {
                const result = await executePatch(root, proposal, payload?.patch_text ?? '', mode === 'dry_run');
                if (mode === 'execute' && result.startsWith('patch applied')) writesApplied = 1;
                return result;
            }
            if (proposal.proposalType === 'terminal') {
                const result = await executeTerminal(root, payload?.terminal_command ?? '', mode === 'dry_run');
                if (mode === 'execute' && !/^(error:|terminal command failed)/i.test(result)) terminalCommandsRun = 1;
                return result;
            }
            const provider = payload?.provider ?? 'deepseek';
            const tier = payload?.tier ?? 'light';
            const question = payload?.question?.trim() || proposal.summary;
            if (mode === 'dry_run') return `provider dry-run: ${provider}/${tier}\nquestion: ${question}`;
            const response = await consult(secrets, { provider, tier, question, maxTokens: Math.max(128, Math.min(4096, Math.floor(Number(payload?.max_tokens) || 900))) }, token);
            providerCallsRun = 1;
            return `[${response.provider}/${response.model}]\n\n${response.text}`;
        }, 5 * 60_000);
        if (/^(error:|patch check failed|patch apply failed|terminal command failed|cancelled|execution failed)/i.test(output.trim())) status = 'failed';
    } catch (error: any) {
        status = 'failed';
        output = `execution failed: ${error?.message ?? String(error)}`;
    }
    return { proposalId: proposal.proposalId, proposalType: proposal.proposalType, status, output, writesApplied, terminalCommandsRun, providerCallsRun };
}

async function runValidation(root: string, command: string | undefined): Promise<{ ok: boolean; output: string; terminalCommandsRun: number }> {
    const raw = command?.trim();
    if (!raw) return { ok: true, output: 'validation skipped: no validation_command supplied.', terminalCommandsRun: 0 };
    const result = await runShell(raw, root, 10 * 60_000);
    return {
        ok: result.ok,
        output: [
            result.ok ? `validation passed: ${raw}` : `validation failed: ${raw}`,
            result.stdout.trim(),
            result.stderr.trim() ? `[stderr]\n${result.stderr.trim()}` : '',
            result.error ? `[error]\n${result.error}` : ''
        ].filter(Boolean).join('\n'),
        terminalCommandsRun: 1,
    };
}

function finishRunStatus(receipt: SwarmAutonomyRunReceipt): SwarmAutonomyRunReceipt['status'] {
    if (receipt.steps.some(step => step.status === 'validation_failed')) return 'validation_failed';
    if (receipt.steps.some(step => step.status === 'failed')) return 'failed';
    if (receipt.steps.some(step => step.status === 'blocked')) return 'blocked';
    if (receipt.mode === 'plan') return 'planned';
    return 'completed';
}

function formatAutonomyRun(receipt: SwarmAutonomyRunReceipt, writtenPath?: string, skippedWrite?: string): string {
    const stepRows = receipt.steps.map(step => [
        `### ${step.proposalId}`,
        '',
        `Type: ${step.proposalType}`,
        `Status: ${step.status}`,
        `Writes applied: ${step.writesApplied}`,
        `Terminal commands run: ${step.terminalCommandsRun}`,
        `Provider calls run: ${step.providerCallsRun}`,
        '',
        section('Output', step.output || '(no output)'),
        step.validationOutput ? '\n' + section('Validation', step.validationOutput) : '',
    ].filter(Boolean).join('\n'));
    return [
        '# Harmony Swarm Autonomy Run',
        '',
        `Run id: ${receipt.runId}`,
        `Turn id: ${receipt.turnId}`,
        `Mode: ${receipt.mode}`,
        `Status: ${receipt.status}`,
        `Max proposals: ${receipt.maxProposals}`,
        `Require clean git: ${receipt.requireCleanGit ? 'yes' : 'no'}`,
        `Commit mode: ${receipt.commitMode}`,
        receipt.commitProposalPath ? `Commit proposal: ${receipt.commitProposalPath}` : 'Commit proposal: none',
        writtenPath ? `Run receipt written: ${writtenPath}` : (skippedWrite ?? 'Run receipt not written.'),
        '',
        section('Totals', [
            `writes applied: ${receipt.totals.writesApplied}`,
            `terminal commands run: ${receipt.totals.terminalCommandsRun}`,
            `provider calls run: ${receipt.totals.providerCallsRun}`
        ]),
        '',
        section('Budgets', [
            `max proposals: ${receipt.budgets.maxProposals}`,
            `max steps: ${receipt.budgets.maxSteps}`,
            `max provider calls: ${receipt.budgets.maxProviderCalls}`,
            `max runtime seconds: ${receipt.budgets.maxRuntimeSeconds}`
        ]),
        '',
        section('Checkpoints', receipt.checkpoints.length
            ? receipt.checkpoints.map(item => `${item.at}: ${item.reason} (${item.stepCount} step${item.stepCount === 1 ? '' : 's'})${item.receiptPath ? ` -> ${item.receiptPath}` : ''}`)
            : ['No checkpoints written yet.']),
        '',
        section('Hard Stops', receipt.hardStops),
        '',
        section('Notes', receipt.notes),
        '',
        section('Resume Guidance', receipt.resumeHint),
        '',
        ...stepRows,
    ].join('\n');
}

class SwarmAutonomyRunTool implements vscode.LanguageModelTool<SwarmAutonomyRunInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmAutonomyRunInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const mode = options.input.mode ?? 'plan';
        const turnId = options.input.turn_id?.trim() || 'latest';
        const plan = await readReceiptById(turnId);
        if (!plan) return textResult(`error: swarm receipt not found: ${turnId}`);
        const maxProposals = Math.floor(clamp(Number(options.input.max_proposals ?? 2), 1, 5));
        const maxSteps = Math.floor(clamp(Number(options.input.max_steps ?? maxProposals), 1, maxProposals));
        const maxProviderCalls = Math.floor(clamp(Number(options.input.max_provider_calls ?? (options.input.allow_provider_calls ? 1 : 0)), 0, 5));
        const maxRuntimeSeconds = Math.floor(clamp(Number(options.input.max_runtime_seconds ?? 600), 30, 900));
        const startedAtMs = Date.now();
        const receipt: SwarmAutonomyRunReceipt = {
            version: 1,
            runId: autonomyRunId(),
            turnId: plan.turnId,
            createdAt: new Date().toISOString(),
            mode,
            status: mode === 'plan' ? 'planned' : 'completed',
            maxProposals,
            budgets: { maxProposals, maxSteps, maxProviderCalls, maxRuntimeSeconds },
            validationCommand: options.input.validation_command?.trim() || undefined,
            requireCleanGit: options.input.require_clean_git !== false,
            commitMode: options.input.commit_mode ?? 'none',
            steps: [],
            totals: { writesApplied: 0, terminalCommandsRun: 0, providerCallsRun: 0 },
            checkpoints: [],
            hardStops: [
                'Requires execution_guarded swarm receipt and executable escrow proposals.',
                'Real execution requires confirm_execute=true and a validation_command.',
                'Stops on blocked proposals, execution failures, validation failures, exhausted step/write/terminal/provider/runtime budgets, plan-only mode, dirty git when require_clean_git=true, or cancellation.',
                'Commit mode writes proposal receipts only; it never runs git add, git commit, git push, reset, clean, or branch switching.'
            ],
            notes: [
                'This is a bounded multi-proposal runner. It is not an unbounded autonomous loop.',
                'Use mode=plan or mode=dry_run before mode=execute for new proposal sets.',
                options.input.checkpoint_each_step === false ? 'Checkpoint writes after each step are disabled by input.' : 'Checkpoint writes after each step are enabled when receipt writing is enabled.'
            ],
            resumeHint: 'Resume by re-running harmony_swarm_autonomy_run with the same turn_id and explicit proposal_ids for unapplied proposals after reviewing the latest autonomy-run receipt. Do not use unbounded loops.',
        };

        const preflight = await runPreflight(plan, { turn_id: plan.turnId, intended_action: mode === 'plan' ? 'mutation_escrow' : 'execution', require_fresh_pricing: options.input.allow_provider_calls === true });
        const root = workspaceRoot();
        const block = async (message: string) => {
            receipt.status = 'blocked';
            receipt.notes.push(message);
            const writtenPath = options.input.write_receipt !== false ? await writeAutonomyRunReceipt(receipt) : undefined;
            const skippedWrite = options.input.write_receipt === false ? 'Run receipt write disabled by input.' : undefined;
            if (writtenPath) receipt.receiptPath = writtenPath;
            if (options.input.format === 'json') return textResult(JSON.stringify({ preflight, run: receipt, writtenPath, skippedWrite }, null, 2));
            return textResult(`${formatPreflight(preflight)}\n\n${formatAutonomyRun(receipt, writtenPath, skippedWrite)}`);
        };

        if (!root) return block('No workspace folder is open.');
        const writeCheckpoint = async (reason: string) => {
            const checkpoint: SwarmAutonomyCheckpoint = {
                at: new Date().toISOString(),
                reason,
                stepCount: receipt.steps.length,
                totals: { ...receipt.totals },
            };
            receipt.checkpoints.push(checkpoint);
            if (options.input.write_receipt !== false && options.input.checkpoint_each_step !== false) {
                const writtenPath = await writeAutonomyRunReceipt(receipt);
                if (writtenPath) {
                    receipt.receiptPath = writtenPath;
                    checkpoint.receiptPath = writtenPath;
                }
            }
        };
        if (preflight.decision === 'NO-GO') return block('Preflight returned NO-GO.');
        if (planOnlyMode() && mode !== 'plan') return block('Plan-only mode is enabled; dry_run/execute autonomy runs are blocked.');
        if (mode === 'execute' && !swarmSafetySwitch('autonomyExecution.enabled')) return block(disabledSwarmSwitchMessage('autonomyExecution.enabled', 'bounded swarm autonomy execute mode'));
        if (mode === 'execute' && options.input.confirm_execute !== true) return block('Real execution requires confirm_execute=true.');
        if (mode === 'execute' && !receipt.validationCommand) return block('Real execution requires validation_command so the run can stop on failed validation.');
        if (mode === 'execute' && receipt.validationCommand) {
            const validationBlock = validationCommandExecutionBlock();
            if (validationBlock) return block(validationBlock);
        }
        if (mode === 'execute' && receipt.requireCleanGit) {
            const gitStatus = await gitPorcelainStatus(root);
            if (!gitStatus.ok) return block(`Could not inspect git status before execution. ${gitStatus.error ?? gitStatus.stderr}`.trim());
            if (gitStatus.stdout.trim()) return block(`Working tree is not clean. Commit/stash/review current changes first, or set require_clean_git=false intentionally.\n${gitStatus.stdout.trim()}`);
        }

        const proposals = await listEscrowProposals(plan.turnId, options.input.proposal_ids, maxProposals);
        if (!proposals.length) return block('No escrow proposals were found for this swarm turn.');
        const payloads = proposalPayloadsById(options.input);

        await withOperationLock(root, `swarm-autonomy-run:${plan.turnId}`, 'swarm bounded autonomy run', { mode, maxProposals }, async () => {
            for (const proposal of proposals.slice(0, maxProposals)) {
                if (token.isCancellationRequested) {
                    receipt.notes.push('Run stopped because cancellation was requested.');
                    await writeCheckpoint('stopped: cancellation requested');
                    break;
                }
                if (receipt.steps.length >= maxSteps) {
                    receipt.notes.push(`Run stopped because max_steps budget was reached: ${maxSteps}.`);
                    await writeCheckpoint('stopped: max_steps budget reached');
                    break;
                }
                if ((Date.now() - startedAtMs) / 1000 > maxRuntimeSeconds) {
                    receipt.notes.push(`Run stopped because max_runtime_seconds budget was reached: ${maxRuntimeSeconds}.`);
                    await writeCheckpoint('stopped: max_runtime_seconds budget reached');
                    break;
                }
                if (proposal.applied) {
                    receipt.steps.push({ proposalId: proposal.proposalId, proposalType: proposal.proposalType, status: 'skipped', output: 'Proposal was already applied/executed.', writesApplied: 0, terminalCommandsRun: 0, providerCallsRun: 0 });
                    await writeCheckpoint(`after skipped proposal ${proposal.proposalId}`);
                    continue;
                }
                if (proposal.proposalType === 'terminal' && options.input.allow_terminal_proposals !== true) {
                    receipt.steps.push(blockedStep(proposal, 'Terminal proposals require allow_terminal_proposals=true.'));
                    await writeCheckpoint(`blocked terminal proposal ${proposal.proposalId}`);
                    break;
                }
                if (proposal.proposalType === 'provider_call' && options.input.allow_provider_calls !== true) {
                    receipt.steps.push(blockedStep(proposal, 'Provider-call proposals require allow_provider_calls=true.'));
                    await writeCheckpoint(`blocked provider proposal ${proposal.proposalId}`);
                    break;
                }
                if (proposal.proposalType === 'provider_call' && mode === 'execute' && receipt.totals.providerCallsRun >= maxProviderCalls) {
                    receipt.steps.push(blockedStep(proposal, `Provider-call budget exhausted: ${maxProviderCalls}.`));
                    await writeCheckpoint(`blocked provider proposal ${proposal.proposalId}: provider budget exhausted`);
                    break;
                }
                const checks = validateEscrowProposal(plan, proposal);
                if (checks.some(check => check.status === 'block')) {
                    receipt.steps.push(blockedStep(proposal, formatChecks(checks).join('\n')));
                    await writeCheckpoint(`blocked proposal ${proposal.proposalId}: escrow validation`);
                    break;
                }
                if (proposal.proposalType === 'patch' && mode === 'execute' && receipt.totals.writesApplied >= plan.budget.maxWrites) {
                    receipt.steps.push(blockedStep(proposal, `Write budget exhausted: ${plan.budget.maxWrites}.`));
                    await writeCheckpoint(`blocked patch proposal ${proposal.proposalId}: write budget exhausted`);
                    break;
                }
                if (proposal.proposalType === 'terminal' && mode === 'execute' && receipt.totals.terminalCommandsRun >= plan.budget.maxTerminalCommands) {
                    receipt.steps.push(blockedStep(proposal, `Terminal command budget exhausted: ${plan.budget.maxTerminalCommands}.`));
                    await writeCheckpoint(`blocked terminal proposal ${proposal.proposalId}: terminal budget exhausted`);
                    break;
                }
                const step = await executeAutonomyProposal(root, proposal, payloads.get(proposal.proposalId), mode, this.secrets, token);
                receipt.steps.push(step);
                receipt.totals.writesApplied += step.writesApplied;
                receipt.totals.terminalCommandsRun += step.terminalCommandsRun;
                receipt.totals.providerCallsRun += step.providerCallsRun;
                if (mode === 'execute' && step.status === 'executed') {
                    if (receipt.validationCommand) {
                        if (receipt.totals.terminalCommandsRun >= plan.budget.maxTerminalCommands) {
                            step.status = 'validation_failed';
                            step.validationOutput = `Validation command could not run because terminal command budget is exhausted: ${plan.budget.maxTerminalCommands}.`;
                            proposal.notes = [...proposal.notes, `Executed by bounded autonomy run ${receipt.runId}, but validation could not run because the terminal budget was exhausted. Proposal was not marked applied.`];
                            await updateEscrowProposal(proposal);
                            await writeCheckpoint(`after proposal ${proposal.proposalId}: validation blocked by terminal budget`);
                            break;
                        }
                        const validation = await runValidation(root, receipt.validationCommand);
                        step.validationOutput = validation.output;
                        receipt.totals.terminalCommandsRun += validation.terminalCommandsRun;
                        if (!validation.ok) {
                            step.status = 'validation_failed';
                            proposal.notes = [...proposal.notes, `Executed by bounded autonomy run ${receipt.runId}, but validation failed. Proposal was not marked applied.`];
                            await updateEscrowProposal(proposal);
                            await writeCheckpoint(`after proposal ${proposal.proposalId}: validation failed`);
                            break;
                        }
                    }
                    proposal.applied = true;
                    proposal.notes = [...proposal.notes, `Executed by bounded autonomy run ${receipt.runId} at ${new Date().toISOString()} after validation passed.`];
                    await updateEscrowProposal(proposal);
                }
                await writeCheckpoint(`after proposal ${proposal.proposalId}`);
                if (step.status === 'failed' || step.status === 'blocked' || step.status === 'validation_failed') break;
            }
        }, 10 * 60_000);

        receipt.status = finishRunStatus(receipt);
        if (receipt.commitMode === 'proposal_receipt' && receipt.steps.length > 0) {
            receipt.commitProposalPath = await writeCommitProposalReceipt(receipt, options.input);
        }
        const shouldWrite = options.input.write_receipt !== false;
        const writtenPath = shouldWrite ? await writeAutonomyRunReceipt(receipt) : undefined;
        const skippedWrite = shouldWrite ? undefined : 'Run receipt write disabled by input.';
        if (writtenPath) receipt.receiptPath = writtenPath;
        if (options.input.format === 'json') return textResult(JSON.stringify({ preflight, run: receipt, writtenPath, skippedWrite }, null, 2));
        return textResult(`${formatPreflight(preflight)}\n\n${formatAutonomyRun(receipt, writtenPath, skippedWrite)}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmAutonomyRunInput>) {
        const mode = options.input.mode ?? 'plan';
        if (mode !== 'execute') return { invocationMessage: `Preparing bounded swarm autonomy ${mode}` };
        return {
            invocationMessage: 'Running bounded swarm autonomy execution',
            confirmationMessages: {
                title: 'Execute bounded multi-proposal swarm run?',
                message: new vscode.MarkdownString('Harmony wants to consume multiple escrow proposals under operation locks. This requires `confirm_execute=true`, a validation command, and writes private receipts under `.harmony/swarm`. It will not run git commit or git push; commit_mode can write proposal receipts only.')
            }
        };
    }
}

class SwarmCommitDryRunTool implements vscode.LanguageModelTool<SwarmCommitDryRunInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmCommitDryRunInput>): Promise<vscode.LanguageModelToolResult> {
        const turnId = options.input.turn_id?.trim() || 'latest';
        const plan = await readReceiptById(turnId);
        if (!plan) return textResult(`error: swarm receipt not found: ${turnId}`);
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');

        const autonomyRun = await readAutonomyRunReceipt(plan.turnId, options.input.autonomy_run_id);
        const explicitProposalIds = uniqueSorted(options.input.proposal_ids ?? []);
        const runProposalIds = autonomyRun
            ? autonomyRun.steps.filter(step => step.status === 'executed').map(step => step.proposalId)
            : [];
        const proposalIds = explicitProposalIds.length ? explicitProposalIds : uniqueSorted(runProposalIds);
        const proposals: SwarmEscrowProposal[] = [];
        const checks: string[] = [];
        const blockedPaths: string[] = [];
        const preflight = await runPreflight(plan, { turn_id: plan.turnId, intended_action: 'execution' });
        checks.push(...formatChecks(preflight.checks));
        if (!proposalIds.length) checks.push('BLOCK: No proposal ids were provided and no executed proposals were found in the latest autonomy run.');
        for (const id of proposalIds) {
            const proposal = await readEscrowProposal(plan.turnId, id);
            if (!proposal) {
                checks.push(`BLOCK: Escrow proposal not found: ${id}`);
                continue;
            }
            proposals.push(proposal);
            if (!proposal.applied) checks.push(`BLOCK: Proposal ${id} is not marked applied/executed; commit dry-run expects already-applied proposal receipts.`);
        }
        const manifestPaths = uniqueSorted(proposals.flatMap(proposal => proposal.targetPaths));
        if (!manifestPaths.length) checks.push('BLOCK: Commit manifest is empty.');
        for (const targetPath of manifestPaths) {
            if (isBlockedScopePath(targetPath) || isSecretLookingPath(targetPath)) blockedPaths.push(targetPath);
        }
        if (blockedPaths.length) checks.push(`BLOCK: Commit manifest includes blocked/private/secret-looking path(s): ${blockedPaths.join(', ')}`);
        const snapshotReceiptPath = options.input.snapshot_receipt_path?.trim();
        if (!snapshotReceiptPath) checks.push('BLOCK: snapshot_receipt_path is required before a future commit execution can stage or commit this manifest.');

        const git = manifestPaths.length ? await runCommitDryRunGit(root, manifestPaths) : {};
        const statusPaths = parsePorcelainPaths(git.status?.stdout ?? '');
        const unexpectedStatusPaths = statusPaths.filter(statusPath => !pathInManifest(statusPath, manifestPaths));
        const requireCleanManifest = options.input.require_clean_manifest !== false;
        if (requireCleanManifest && unexpectedStatusPaths.length) {
            checks.push(`BLOCK: Git status contains paths outside this commit manifest: ${unexpectedStatusPaths.join(', ')}`);
        }
        for (const [name, result] of Object.entries(git)) {
            if (!result.ok) checks.push(`BLOCK: git dry-run check failed (${name}): ${result.error ?? result.stderr}`.trim());
        }
        const status: SwarmCommitDryRunReceipt['status'] = checks.some(check => check.startsWith('BLOCK:') || check.startsWith('BLOCK')) || preflight.decision === 'NO-GO'
            ? 'blocked'
            : 'ready';
        const receipt: SwarmCommitDryRunReceipt = {
            version: 1,
            dryRunId: commitDryRunId(),
            turnId: plan.turnId,
            autonomyRunId: autonomyRun?.runId,
            createdAt: new Date().toISOString(),
            status,
            commitMessage: options.input.commit_message?.trim() || `Harmony swarm: ${proposalIds.join(', ') || plan.turnId}`,
            includedProposalIds: proposalIds,
            manifestPaths,
            validationCommand: options.input.validation_command?.trim() || autonomyRun?.validationCommand,
            snapshotRequirement: {
                required: true,
                status: snapshotReceiptPath ? 'provided' : 'missing',
                receiptPath: snapshotReceiptPath,
            },
            preflightDecision: preflight.decision,
            checks,
            git,
            unexpectedStatusPaths,
            blockedPaths,
            notes: [
                'Dry-run only. Harmony did not run git add, git commit, git push, reset, clean, restore, checkout, or branch switching.',
                'The only git staging command used here is git add --dry-run with explicit manifest pathspecs.',
                'Future commit execution must rerun validation, create/verify pre-action snapshots, acquire a Hub lock, stage only manifest paths, and ask for final confirmation.'
            ],
        };
        const shouldWrite = options.input.write_receipt !== false && !planOnlyMode();
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (shouldWrite) {
            writtenPath = await withOperationLock(root, `swarm-commit-dry-run:${plan.turnId}`, 'swarm commit dry-run receipt', { proposalIds, manifestPaths }, () => writeCommitDryRunReceipt(receipt), 60_000);
            if (writtenPath) receipt.receiptPath = writtenPath;
        } else {
            skippedWrite = planOnlyMode() && options.input.write_receipt !== false
                ? 'Plan-only mode is enabled; commit dry-run receipt write was skipped.'
                : 'Commit dry-run receipt write disabled by input.';
        }
        if (options.input.format === 'json') return textResult(JSON.stringify({ preflight, receipt, writtenPath, skippedWrite }, null, 2));
        return textResult(`${formatPreflight(preflight)}\n\n${formatCommitDryRun(receipt, writtenPath, skippedWrite)}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmCommitDryRunInput>) {
        if (options.input.write_receipt === false) return { invocationMessage: 'Preparing swarm commit dry-run manifest' };
        return {
            invocationMessage: 'Writing swarm commit dry-run receipt',
            confirmationMessages: {
                title: 'Write guarded swarm commit dry-run receipt?',
                message: new vscode.MarkdownString('Harmony will inspect existing swarm receipts and run read-only git checks plus `git add --dry-run` for explicit manifest paths. It will not stage, commit, push, reset, clean, restore, checkout, or switch branches.')
            }
        };
    }
}

class SwarmCommitExecuteTool implements vscode.LanguageModelTool<SwarmCommitExecuteInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmCommitExecuteInput>): Promise<vscode.LanguageModelToolResult> {
        const turnId = options.input.turn_id?.trim() || 'latest';
        const plan = await readReceiptById(turnId);
        if (!plan) return textResult(`error: swarm receipt not found: ${turnId}`);
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const dryRun = await readCommitDryRunReceipt(plan.turnId, options.input.dry_run_id, options.input.dry_run_receipt_path);
        if (!dryRun) return textResult('error: commit dry-run receipt not found. Run harmony_swarm_commit_dry_run first.');

        const commitMessage = (options.input.commit_message?.trim() || dryRun.commitMessage || '').trim();
        const snapshotReceiptPath = (options.input.snapshot_receipt_path?.trim() || dryRun.snapshotRequirement.receiptPath || '').trim();
        const validationCommand = (options.input.validation_command?.trim() || dryRun.validationCommand || '').trim();
        const manifestPaths = uniqueSorted(dryRun.manifestPaths);
        const checks: string[] = [];
        const git: Record<string, ProcessRun> = {};
        let validationOutput: string | undefined;
        let stagedPaths: string[] = [];
        let unexpectedStatusPaths: string[] = [];
        const blockedPaths = manifestPaths.filter(targetPath => isBlockedScopePath(targetPath) || isSecretLookingPath(targetPath));
        const preflight = await runPreflight(plan, { turn_id: plan.turnId, intended_action: 'execution' });
        checks.push(...formatChecks(preflight.checks));
        if (!swarmSafetySwitch('commitExecution.enabled')) checks.push(disabledSwarmSwitchMessage('commitExecution.enabled', 'swarm commit execution').replace(/^error: /, 'BLOCK: '));
        if (preflight.decision !== 'GO') checks.push(`BLOCK: Execution requires a GO preflight decision; current decision is ${preflight.decision}.`);
        if (!options.input.confirm_execute) checks.push('BLOCK: confirm_execute=true is required before Harmony may stage and commit a swarm manifest.');
        if (dryRun.status !== 'ready') checks.push(`BLOCK: Dry-run receipt status must be ready; current status is ${dryRun.status}.`);
        if (!commitMessage) checks.push('BLOCK: commit_message is required.');
        if (!validationCommand) checks.push('BLOCK: validation_command is required and must pass immediately before staging.');
        if (validationCommand) {
            const validationBlock = validationCommandExecutionBlock();
            if (validationBlock) checks.push(validationBlock.replace(/^error: /, 'BLOCK: '));
        }
        if (!snapshotReceiptPath) checks.push('BLOCK: snapshot_receipt_path is required.');
        if (!manifestPaths.length) checks.push('BLOCK: commit manifest is empty.');
        if (blockedPaths.length) checks.push(`BLOCK: Commit manifest includes blocked/private/secret-looking path(s): ${blockedPaths.join(', ')}`);
        const snapshotReceipt = snapshotReceiptPath ? await validateCommitSnapshotReceipt(root, snapshotReceiptPath, manifestPaths) : undefined;
        if (snapshotReceipt) checks.push(...snapshotReceipt.issues.map(issue => `BLOCK: ${issue}.`));

        const requireCleanManifest = options.input.require_clean_manifest !== false;
        if (manifestPaths.length) {
            git.statusBefore = await execFile('git', ['status', '--porcelain'], root, 60000);
            git.stagedBefore = await execFile('git', ['diff', '--cached', '--name-only'], root, 60000);
            git.manifestDiffCheck = await execFile('git', ['diff', '--check', '--', ...manifestPaths], root, 60000);
            git.addDryRun = await execFile('git', ['add', '--dry-run', '--', ...manifestPaths], root, 60000);
            unexpectedStatusPaths = parsePorcelainPaths(git.statusBefore.stdout).filter(statusPath => !pathInManifest(statusPath, manifestPaths));
            const stagedBefore = uniqueSorted(git.stagedBefore.stdout.split(/\r?\n/).filter(Boolean));
            if (stagedBefore.length) checks.push(`BLOCK: Git index already has staged path(s); commit execution will not include hidden staged changes: ${stagedBefore.join(', ')}`);
            if (requireCleanManifest && unexpectedStatusPaths.length) checks.push(`BLOCK: Git status contains paths outside this commit manifest: ${unexpectedStatusPaths.join(', ')}`);
            for (const [name, result] of Object.entries(git)) {
                if (!result.ok) checks.push(`BLOCK: git pre-commit check failed (${name}): ${result.error ?? result.stderr}`.trim());
            }
        }

        let receipt: SwarmCommitExecutionReceipt = {
            version: 1,
            executionId: commitExecutionId(),
            turnId: plan.turnId,
            dryRunId: dryRun.dryRunId,
            createdAt: new Date().toISOString(),
            status: checks.some(check => check.startsWith('BLOCK:') || check.startsWith('BLOCK')) ? 'blocked' : 'failed',
            commitMessage,
            manifestPaths,
            snapshotReceiptPath,
            snapshotReceipt,
            validationCommand,
            validationOutput,
            preflightDecision: preflight.decision,
            checks,
            git,
            stagedPaths,
            unexpectedStatusPaths,
            blockedPaths,
            notes: [
                'Guarded commit execution stages only the explicit manifest paths from a ready dry-run receipt.',
                'Harmony never pushes, resets, cleans, restores, checks out, switches branches, or force-mutates history in this tool.',
                snapshotReceipt?.restoreCommand ? `Restore from the pre-action snapshot with: ${snapshotReceipt.restoreCommand}` : 'Recovery requires a valid copied text-file snapshot manifest before staging.',
                'If staging succeeds but commit fails, inspect the receipt and git status before deciding whether to unstage or retry.'
            ],
        };

        const shouldWrite = options.input.write_receipt !== false && !planOnlyMode();
        const writeReceipt = async (target: SwarmCommitExecutionReceipt): Promise<string | undefined> => shouldWrite ? writeCommitExecutionReceipt(target) : undefined;
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (receipt.status === 'blocked') {
            writtenPath = await writeReceipt(receipt);
            if (writtenPath) receipt.receiptPath = writtenPath;
            if (!shouldWrite) skippedWrite = planOnlyMode() && options.input.write_receipt !== false ? 'Plan-only mode is enabled; commit execution receipt write was skipped.' : 'Commit execution receipt write disabled by input.';
            if (options.input.format === 'json') return textResult(JSON.stringify({ preflight, receipt, writtenPath, skippedWrite }, null, 2));
            return textResult(`${formatPreflight(preflight)}\n\n${formatCommitExecution(receipt, writtenPath, skippedWrite)}`);
        }

        try {
            await withOperationLock(root, `swarm-commit-execute:${plan.turnId}`, 'swarm guarded commit execution', { dryRunId: dryRun.dryRunId, manifestPaths }, async () => {
                const validation = await runValidation(root, validationCommand);
                validationOutput = validation.output;
                receipt.validationOutput = validationOutput;
                if (!validation.ok) {
                    receipt.status = 'validation_failed';
                    receipt.checks.push('BLOCK: validation_command failed before staging; no git add or git commit was run.');
                    return;
                }
                git.statusAfterValidation = await execFile('git', ['status', '--porcelain'], root, 60000);
                git.stagedBeforeAfterValidation = await execFile('git', ['diff', '--cached', '--name-only'], root, 60000);
                const unexpectedAfterValidation = parsePorcelainPaths(git.statusAfterValidation.stdout).filter(statusPath => !pathInManifest(statusPath, manifestPaths));
                const stagedAfterValidation = uniqueSorted(git.stagedBeforeAfterValidation.stdout.split(/\r?\n/).filter(Boolean));
                if (!git.statusAfterValidation.ok || !git.stagedBeforeAfterValidation.ok || (requireCleanManifest && unexpectedAfterValidation.length) || stagedAfterValidation.length) {
                    receipt.status = 'blocked';
                    if (!git.statusAfterValidation.ok) receipt.checks.push(`BLOCK: post-validation git status failed: ${git.statusAfterValidation.error ?? git.statusAfterValidation.stderr}`.trim());
                    if (!git.stagedBeforeAfterValidation.ok) receipt.checks.push(`BLOCK: post-validation staged check failed: ${git.stagedBeforeAfterValidation.error ?? git.stagedBeforeAfterValidation.stderr}`.trim());
                    if (requireCleanManifest && unexpectedAfterValidation.length) receipt.checks.push(`BLOCK: validation changed or revealed paths outside the manifest: ${unexpectedAfterValidation.join(', ')}`);
                    if (stagedAfterValidation.length) receipt.checks.push(`BLOCK: validation left staged path(s); no git add or git commit was run: ${stagedAfterValidation.join(', ')}`);
                    receipt.unexpectedStatusPaths = unexpectedAfterValidation;
                    return;
                }
                git.add = await execFile('git', ['add', '--', ...manifestPaths], root, 60000);
                if (!git.add.ok) {
                    receipt.status = 'failed';
                    receipt.checks.push(`BLOCK: git add failed: ${git.add.error ?? git.add.stderr}`.trim());
                    return;
                }
                git.stagedAfter = await execFile('git', ['diff', '--cached', '--name-only'], root, 60000);
                stagedPaths = uniqueSorted(git.stagedAfter.stdout.split(/\r?\n/).filter(Boolean));
                receipt.stagedPaths = stagedPaths;
                const unexpectedStagedPaths = stagedPaths.filter(statusPath => !pathInManifest(statusPath, manifestPaths));
                if (!stagedPaths.length || unexpectedStagedPaths.length) {
                    receipt.status = 'failed';
                    receipt.checks.push(unexpectedStagedPaths.length
                        ? `BLOCK: Staged paths outside manifest after git add: ${unexpectedStagedPaths.join(', ')}`
                        : 'BLOCK: No staged paths were produced from the manifest.');
                    return;
                }
                git.stagedDiffCheck = await execFile('git', ['diff', '--cached', '--check'], root, 60000);
                if (!git.stagedDiffCheck.ok) {
                    receipt.status = 'failed';
                    receipt.checks.push(`BLOCK: staged diff check failed: ${git.stagedDiffCheck.error ?? git.stagedDiffCheck.stderr}`.trim());
                    return;
                }
                git.commitDryRun = await execFile('git', ['commit', '--dry-run', '--short'], root, 60000);
                if (!git.commitDryRun.ok) {
                    receipt.status = 'failed';
                    receipt.checks.push(`BLOCK: git commit --dry-run failed: ${git.commitDryRun.error ?? git.commitDryRun.stderr}`.trim());
                    return;
                }
                git.commit = await execFile('git', ['commit', '-m', commitMessage], root, 120000);
                if (!git.commit.ok) {
                    receipt.status = 'failed';
                    receipt.checks.push(`BLOCK: git commit failed: ${git.commit.error ?? git.commit.stderr}`.trim());
                    return;
                }
                git.revParse = await execFile('git', ['rev-parse', '--short', 'HEAD'], root, 60000);
                receipt.commitHash = git.revParse.stdout.trim() || undefined;
                receipt.status = 'committed';
            }, 10 * 60_000);
        } catch (error: any) {
            receipt.status = 'failed';
            receipt.checks.push(`BLOCK: commit execution failed before completion: ${error?.message ?? String(error)}`);
        }

        writtenPath = await writeReceipt(receipt);
        if (writtenPath) receipt.receiptPath = writtenPath;
        if (!shouldWrite) skippedWrite = planOnlyMode() && options.input.write_receipt !== false ? 'Plan-only mode is enabled; commit execution receipt write was skipped.' : 'Commit execution receipt write disabled by input.';
        if (options.input.format === 'json') return textResult(JSON.stringify({ preflight, receipt, writtenPath, skippedWrite }, null, 2));
        return textResult(`${formatPreflight(preflight)}\n\n${formatCommitExecution(receipt, writtenPath, skippedWrite)}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmCommitExecuteInput>) {
        return {
            invocationMessage: options.input.confirm_execute ? 'Preparing guarded swarm commit execution' : 'Checking guarded swarm commit execution request',
            confirmationMessages: {
                title: 'Run guarded swarm commit execution?',
                message: new vscode.MarkdownString('Harmony may run `git add -- <manifest paths>` and `git commit -m <message>` only when `confirm_execute` is true and all guards pass. It will not push, reset, clean, restore, checkout, switch branches, or stage paths outside the manifest.')
            }
        };
    }
}

function buildAutonomyDesign(input: SwarmAutonomyDesignInput) {
    const maxParallelProposals = clamp(Math.floor(Number(input.max_parallel_proposals) || 1), 1, 5);
    const commitExecutionDesign = {
        status: 'design_only',
        enabledInThisRelease: false,
        requestedByInput: input.allow_commits === true,
        nonGoals: [
            'No git commit, push, reset, clean, restore, checkout, or branch switching is enabled by this design receipt.',
            'No automatic staging of all files; any future commit execution must stage only manifest-listed paths.',
            'No recovery through destructive git commands; recovery starts from the pre-action snapshot and explicit restore instructions.'
        ],
        requiredInputs: [
            'turn_id for the swarm plan/autonomy run being committed',
            'autonomy_run_id with completed or planned steps selected for commit',
            'explicit proposal_ids to include',
            'explicit commit_message',
            'validation_command that passed after the final included mutation',
            'confirm_commit=true plus VS Code confirmation at invocation time'
        ],
        preconditions: [
            'Latest included autonomy or execution receipt exists and is readable.',
            'Every included proposal has a receipt and target path manifest.',
            'Git status contains only expected manifest paths, with no private, secret, generated, .harmony, .git, or blocked files.',
            'A pre-action snapshot exists for every included tracked text path and a receipt records restore instructions.',
            'Hub operation lock is acquired for the workspace commit operation before staging starts.',
            'Validation command is rerun immediately before staging and must pass.'
        ],
        dryRunChecks: [
            'git status --porcelain for current workspace state',
            'git diff --name-only and git diff --stat scoped to manifest paths',
            'git diff --check scoped to manifest paths',
            'future git add --dry-run scoped only to manifest paths',
            'receipt diff check: manifest paths must match included proposal target paths'
        ],
        futureExecutionSequence: [
            'Start operation-ledger entry and acquire Hub lock.',
            'Create pre-action snapshot and write commit manifest receipt.',
            'Rerun validation_command and stop if it fails.',
            'Run dry-run checks and stop on any unexpected path or whitespace error.',
            'Stage only manifest-listed paths with explicit pathspecs.',
            'Inspect staged diff with git diff --cached --check and git diff --cached --stat.',
            'Run git commit with the explicit commit_message only after final confirmation.',
            'Write commit receipt with commit hash, staged paths, validation output, and restore guidance.',
            'Release Hub lock and finish operation-ledger entry.'
        ],
        stopConditions: [
            'Dirty git state outside the manifest.',
            'Missing or stale validation receipt.',
            'Missing pre-action snapshot or restore receipt.',
            'Hub lock cannot be acquired.',
            'Any blocked/private/secret-looking path appears in the manifest or git status.',
            'git diff --check reports whitespace errors.',
            'Commit hook or git commit fails.',
            'Cancellation is requested.'
        ],
        receipts: [
            'commit design receipt',
            'pre-action snapshot receipt',
            'commit manifest receipt',
            'validation rerun receipt',
            'dry-run check receipt',
            'final commit receipt with commit hash if a future release enables execution'
        ],
        recovery: [
            'Before commit: unstage only manifest-listed paths, then restore from snapshot if requested.',
            'After commit: do not reset automatically; write revert/restore instructions and require a separate guarded recovery action.',
            'Always preserve the failed commit manifest and operation-ledger entry for audit.'
        ]
    };
    return {
        version: 1,
        designId: `swarm-autonomy-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        objective: input.objective?.trim() || 'Design a future autonomous swarm loop without enabling execution in this release.',
        status: 'design_only',
        maxParallelProposals,
        commitsAllowed: false,
        requestedCommitsAllowed: input.allow_commits === true,
        stateMachine: [
            'intake_objective',
            'create_execution_guarded_receipt',
            'dispatch_read_only_role_probes',
            'rank_candidate_proposals',
            'write_mutation_escrow_for_each_candidate',
            'preflight_each_candidate',
            'execute_at_most_one_proposal',
            'run_validation_plan',
            'append_execution_receipt',
            'stop_or_request_user_approval_for_next_proposal'
        ],
        hardStops: [
            'No loop may execute more than one proposal without an explicit new user approval checkpoint.',
            'No in-swarm commits, pushes, resets, cleans, or branch switches in the autonomous loop.',
            'No terminal command runs unless it belongs to one approved escrow proposal and passes execution preflight.',
            'No provider fan-out when pricing is stale or maxCostUsd is exhausted.',
            'No mutation outside receipt scope paths or into blocked/private paths.',
            'Any validation failure stops the loop and records the failure before asking the user.'
        ],
        requiredReceipts: [
            'swarm plan receipt',
            'dispatch receipt for read-only role probes',
            'escrow proposal per candidate mutation',
            'preflight result per proposal',
            'execution receipt for the single consumed proposal',
            'operation ledger snapshot after validation'
        ],
        futureImplementationPhases: [
            'Phase A: read-only ranking of multiple escrow proposals.',
            'Phase B: user-approved one-at-a-time loop around existing harmony_swarm_execute.',
            'Phase C: validation-aware stop/resume receipts.',
            'Phase D: guarded commit execution design receipts, still outside autonomous execution.',
            'Phase E: only after extensive smoke tests, consider bounded multi-step autonomy.'
        ],
        commitExecutionDesign,
        note: 'This tool intentionally does not execute, schedule, commit, or mutate swarm proposals. It records the safety contract for a future autonomous loop.'
    };
}

async function writeAutonomyDesign(design: ReturnType<typeof buildAutonomyDesign>): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = path.join(root, SWARM_DIR, 'autonomy');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${design.designId}.json`);
    const payload = JSON.stringify(design, null, 2);
    await fs.writeFile(target, payload, 'utf8');
    await fs.writeFile(path.join(dir, 'latest-autonomy-design.json'), payload, 'utf8');
    return relPath(target);
}

function formatAutonomyDesign(design: ReturnType<typeof buildAutonomyDesign>, writtenPath?: string, skippedWrite?: string): string {
    const commitDesign = design.commitExecutionDesign;
    const formatCommitDesign = [
        `Status: ${commitDesign.status}`,
        `Enabled in this release: ${commitDesign.enabledInThisRelease ? 'yes' : 'no'}`,
        `Requested by input: ${commitDesign.requestedByInput ? 'yes' : 'no'}`,
        '',
        section('Commit Design Non-Goals', commitDesign.nonGoals),
        '',
        section('Commit Design Required Inputs', commitDesign.requiredInputs),
        '',
        section('Commit Design Preconditions', commitDesign.preconditions),
        '',
        section('Commit Design Dry-Run Checks', commitDesign.dryRunChecks),
        '',
        section('Commit Design Future Execution Sequence', commitDesign.futureExecutionSequence),
        '',
        section('Commit Design Stop Conditions', commitDesign.stopConditions),
        '',
        section('Commit Design Receipts', commitDesign.receipts),
        '',
        section('Commit Design Recovery', commitDesign.recovery),
    ].join('\n');
    return [
        '# Swarm Autonomous Loop Design',
        '',
        `Design id: ${design.designId}`,
        `Status: ${design.status}`,
        `Max parallel proposals in design: ${design.maxParallelProposals}`,
        `Commits allowed: ${design.commitsAllowed ? 'yes' : 'no'}${design.requestedCommitsAllowed ? ' (requested but blocked)' : ''}`,
        writtenPath ? `Written: ${writtenPath}` : (skippedWrite ?? 'Written: no'),
        '',
        section('Objective', design.objective),
        '',
        section('State Machine', design.stateMachine),
        '',
        section('Hard Stops', design.hardStops),
        '',
        section('Required Receipts', design.requiredReceipts),
        '',
        section('Future Implementation Phases', design.futureImplementationPhases),
        '',
        section('Guarded In-Swarm Commit Execution Design', formatCommitDesign),
        '',
        design.note,
    ].join('\n');
}

class SwarmAutonomyDesignTool implements vscode.LanguageModelTool<SwarmAutonomyDesignInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SwarmAutonomyDesignInput>) {
        const design = buildAutonomyDesign(options.input);
        const shouldWrite = options.input.write_design !== false && !planOnlyMode();
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (shouldWrite) {
            const root = workspaceRoot();
            if (!root) return textResult('error: no workspace folder is open');
            writtenPath = await withOperationLock(root, 'swarm-autonomy-design', 'write swarm autonomy design', { designId: design.designId }, () => writeAutonomyDesign(design), 60_000);
        } else if (options.input.write_design !== false && planOnlyMode()) {
            skippedWrite = 'Plan-only mode is enabled; autonomy design write was skipped.';
        } else {
            skippedWrite = 'Design write disabled by input.';
        }
        if (options.input.format === 'json') return textResult(JSON.stringify({ design, writtenPath, skippedWrite }, null, 2));
        return textResult(formatAutonomyDesign(design, writtenPath, skippedWrite));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SwarmAutonomyDesignInput>) {
        if (options.input.write_design === false) return { invocationMessage: 'Drafting swarm autonomy design' };
        return {
            invocationMessage: 'Writing swarm autonomy design receipt',
            confirmationMessages: {
                title: 'Write swarm autonomy design?',
                message: new vscode.MarkdownString('Harmony wants to write a design-only autonomy receipt under `.harmony/swarm/autonomy`. It will not execute proposals or commits.')
            }
        };
    }
}

export function registerSwarmTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_swarm_plan', new SwarmPlanTool()),
        vscode.lm.registerTool('harmony_swarm_receipts', new SwarmReceiptsTool()),
        vscode.lm.registerTool('harmony_swarm_preflight', new SwarmPreflightTool()),
        vscode.lm.registerTool('harmony_swarm_dispatch', new SwarmDispatchTool(context.secrets)),
        vscode.lm.registerTool('harmony_swarm_escrow', new SwarmEscrowTool()),
        vscode.lm.registerTool('harmony_swarm_execute', new SwarmExecuteTool(context.secrets)),
        vscode.lm.registerTool('harmony_swarm_autonomy_run', new SwarmAutonomyRunTool(context.secrets)),
        vscode.lm.registerTool('harmony_swarm_commit_dry_run', new SwarmCommitDryRunTool()),
        vscode.lm.registerTool('harmony_swarm_commit_execute', new SwarmCommitExecuteTool()),
        vscode.lm.registerTool('harmony_swarm_autonomy_design', new SwarmAutonomyDesignTool()),
        vscode.commands.registerCommand('harmony.runSwarmCommitFixture', async () => {
            const report = await runDisposableSwarmCommitFixture();
            const message = report.status === 'passed'
                ? `Harmony swarm commit fixture passed. Report: ${report.reportPath ?? '(not written)'}`
                : `Harmony swarm commit fixture failed. Report: ${report.reportPath ?? '(not written)'}`;
            if (report.status === 'passed') vscode.window.showInformationMessage(message);
            else vscode.window.showErrorMessage(message);
            return report;
        }),
        vscode.commands.registerCommand('harmony.runSwarmDeepSeekLiveFixture', async () => {
            const report = await runDisposableSwarmDeepSeekLiveFixture(context.secrets);
            const message = report.status === 'passed'
                ? `Harmony live DeepSeek swarm fixture passed. Report: ${report.reportPath ?? '(not written)'}`
                : `Harmony live DeepSeek swarm fixture failed. Report: ${report.reportPath ?? '(not written)'}`;
            if (report.status === 'passed') vscode.window.showInformationMessage(message);
            else vscode.window.showErrorMessage(message);
            return report;
        }),
    );
}