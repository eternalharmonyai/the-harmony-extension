import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ProviderId, Tier } from './providers';

export type UsageProviderId = ProviderId | 'vscode-lm';
export type UsageTier = Tier | 'native';

export const UNOFFICIAL_COST_ESTIMATE_DISCLAIMER =
    '⚠️ UNOFFICIAL CLIENT-SIDE ESTIMATE ONLY — THIS MAY BE WRONG OR INCOMPLETE (RATES, CREDITS, CACHING & TAXES VARY). NOT A BILLING STATEMENT — CHECK YOUR PROVIDER BILLING CONSOLE BETWEEN MESSAGES TO BE SURE.';

/**
 * In-memory cost & usage tracking for the current VS Code session.
 *
 * We don't try to compute exact dollar costs (rates change weekly and vary
 * by tier and region). Instead we track raw token counts per provider/tier
 * and per call. The sidebar surfaces this so the user can see what Harmony
 * is spending where. Cost-aware behavior is then a user decision.
 *
 * Session = process lifetime. Cleared on extension reload by design \u2014
 * persistence would invite stale numbers.
 */

export interface UsageRecord {
    timestamp: string;
    provider: UsageProviderId;
    tier: UsageTier;
    model: string;
    promptTokens: number;
    completionTokens: number;
    /** Number of prompt tokens served from provider prefix cache (DeepSeek or Gemini). */
    cachedPromptTokens?: number;
    /** Number of thinking/reasoning tokens billed as output (e.g. Gemini thoughtsTokenCount). */
    thoughtsTokens?: number;
    /** Characters of the outbound prompt view (the messages array as sent), measured pre-send. */
    promptChars?: number;
    /** CJK characters within promptChars (Han + Kana + Hangul). */
    promptCjkChars?: number;
    /** Serialized tool-schema characters sent with the request. */
    toolSchemaChars?: number;
    /** Number of tool schemas advertised on the request. */
    toolCount?: number;
    /** Prompt-estimator generation id ('none' = no estimate ran for this route). */
    estimatorVersion?: string;
    /** Opaque id grouping ledger rows by agent turn. */
    turnId?: string;
    /** 1-based step index within the turn. */
    stepId?: number;
    /** Whether the provider reported usage (separates failed/unreported rows from real 0s). */
    usageReported?: boolean;
    /**
     * True when the request was retried WITHOUT its tools after a rejection. A row
     * carrying this is a degraded answer, not a normal call.
     */
    toolsDroppedForRetry?: boolean;
    /** Short, server-derived reason for the rejection that forced the tool-less retry. */
    degradationReason?: string;
    /** Whether the step completed or failed. */
    stepOutcome?: 'completed' | 'failed';
    /** Provider-reported served model id (best-effort). */
    servedModel?: string;
    /** Epistemic verdict for the step ('verified' | 'hypothesis' | 'probe_error' | 'not-in-verified-set'). */
    verdict?: 'verified' | 'hypothesis' | 'probe_error' | 'not-in-verified-set';
    /** Optional hash/receipt reference supporting a 'verified' verdict. */
    evidenceHash?: string;
    durationMs?: number;
    billableUnits?: number;
    billableUnitLabel?: string;
    estimatedCostDollars?: number;
}

const records: UsageRecord[] = [];
const listeners = new Set<() => void>();
const LEDGER_DIR = '.harmony/provider-usage';
const LEDGER_FILE = 'ledger.jsonl';
const MAX_LEDGER_LINES = 2000;
const PROVIDER_LATENCY_DELAYED_MS = 8000;
const PROVIDER_LATENCY_SLOW_MS = 20000;

interface ProviderPolicySnapshot {
    enabled: boolean;
    accountingEnabled: boolean;
    allowedProviders: string[];
    deniedProviders: string[];
    allowedModelsByProvider: Record<string, string[]>;
    deniedModelsByProvider: Record<string, string[]>;
    maxSessionCalls: number;
    maxSessionEstimatedCostUsd: number;
    maxCallsByProvider: Record<string, number>;
    maxEstimatedCostUsdByProvider: Record<string, number>;
    ledgerPath?: string;
}

interface ProviderLedgerEntry {
    version: 1;
    kind: 'usage' | 'policy_block' | 'route_guard' | 'fallback';
    timestamp: string;
    provider: UsageProviderId;
    tier: UsageTier;
    model: string;
    status: 'recorded' | 'blocked' | 'guarded' | 'fallback';
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedPromptTokens?: number;
    thoughtsTokens?: number;
    promptChars?: number;
    promptCjkChars?: number;
    toolSchemaChars?: number;
    toolCount?: number;
    estimatorVersion?: string;
    turnId?: string;
    stepId?: number;
    usageReported?: boolean;
    stepOutcome?: 'completed' | 'failed';
    servedModel?: string;
    verdict?: 'verified' | 'hypothesis' | 'probe_error' | 'not-in-verified-set';
    evidenceHash?: string;
    durationMs?: number;
    latencyBand?: 'normal' | 'delayed' | 'slow';
    billableUnits?: number;
    billableUnitLabel?: string;
    estimatedCostDollars?: number;
    estimatedCostKnown?: boolean;
    reason?: string;
    policy: ProviderPolicySnapshot;
}

export interface ProviderPolicyDecision {
    allowed: boolean;
    reason?: string;
    policy: ProviderPolicySnapshot;
}

export interface ProviderAccountingSummary {
    enabled: boolean;
    accountingEnabled: boolean;
    directCalls: number;
    directEstimatedCostDollars: number;
    directEstimatedCostKnown: boolean;
    ledgerPath?: string;
    allowedProviders: string[];
    deniedProviders: string[];
    allowedModelsByProvider: Record<string, string[]>;
    deniedModelsByProvider: Record<string, string[]>;
    maxSessionCalls: number;
    maxSessionEstimatedCostUsd: number;
    maxCallsByProvider: Record<string, number>;
    maxEstimatedCostUsdByProvider: Record<string, number>;
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function ledgerPath(): string | undefined {
    const root = workspaceRoot();
    return root ? path.join(root, LEDGER_DIR, LEDGER_FILE) : undefined;
}

function relLedgerPath(): string | undefined {
    return workspaceRoot() ? `${LEDGER_DIR}/${LEDGER_FILE}` : undefined;
}

async function ensureHarmonyIgnored(): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    const excludePath = path.join(root, '.git', 'info', 'exclude');
    try {
        const existing = await fs.readFile(excludePath, 'utf8');
        if (!existing.split(/\r?\n/).some(line => line.trim() === '.harmony/' || line.trim() === '.harmony/**')) {
            await fs.appendFile(excludePath, `${existing.endsWith('\n') ? '' : '\n'}.harmony/\n`, 'utf8');
        }
    } catch { /* not a git repo or exclude unavailable */ }
}

function numberMapConfig(key: string): Record<string, number> {
    const raw = vscode.workspace.getConfiguration('harmony').get<Record<string, unknown>>(key) ?? {};
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw)) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) out[name] = n;
    }
    return out;
}

function stringArrayMapConfig(key: string): Record<string, string[]> {
    const raw = vscode.workspace.getConfiguration('harmony').get<Record<string, unknown>>(key) ?? {};
    const out: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(raw)) {
        if (!Array.isArray(value)) continue;
        const values = value.map(item => String(item).trim()).filter(Boolean);
        if (values.length > 0) out[name.toLowerCase()] = values;
    }
    return out;
}

function modelMatchesPattern(model: string, pattern: string): boolean {
    const normalizedModel = model.trim().toLowerCase();
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedPattern) return false;
    if (normalizedPattern === normalizedModel) return true;
    if (!normalizedPattern.includes('*')) return false;
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(normalizedModel);
}

function providerPolicySnapshot(): ProviderPolicySnapshot {
    const cfg = vscode.workspace.getConfiguration('harmony');
    return {
        enabled: cfg.get<boolean>('providerPolicy.enabled') ?? true,
        accountingEnabled: cfg.get<boolean>('providerAccounting.enabled') ?? true,
        allowedProviders: cfg.get<string[]>('providerPolicy.allowedProviders') ?? [],
        deniedProviders: cfg.get<string[]>('providerPolicy.deniedProviders') ?? [],
        allowedModelsByProvider: stringArrayMapConfig('providerPolicy.allowedModelsByProvider'),
        deniedModelsByProvider: stringArrayMapConfig('providerPolicy.deniedModelsByProvider'),
        maxSessionCalls: Math.max(0, Math.floor(Number(cfg.get<number>('providerPolicy.maxSessionCalls') ?? 0))),
        maxSessionEstimatedCostUsd: Math.max(0, Number(cfg.get<number>('providerPolicy.maxSessionEstimatedCostUsd') ?? 0)),
        maxCallsByProvider: numberMapConfig('providerPolicy.maxCallsByProvider'),
        maxEstimatedCostUsdByProvider: numberMapConfig('providerPolicy.maxEstimatedCostUsdByProvider'),
        ledgerPath: relLedgerPath(),
    };
}

// Track usage ledger write health so failures surface once per session.
let ledgerWriteFailureCount = 0;
let ledgerWriteFailureLast: string | undefined;
let ledgerWriteFailureWarned = false;

/** Health snapshot for the usage ledger writer (visible, not silent). */
export function getLedgerWriteHealth(): { failures: number; lastError?: string } {
    return { failures: ledgerWriteFailureCount, lastError: ledgerWriteFailureLast };
}

async function appendProviderLedger(entry: ProviderLedgerEntry): Promise<void> {
    if (!entry.policy.accountingEnabled) return;
    const target = ledgerPath();
    if (!target) return;
    try {
        await ensureHarmonyIgnored();
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, JSON.stringify(entry) + '\n', 'utf8');
        const lines = (await fs.readFile(target, 'utf8')).split('\n').filter(Boolean);
        if (lines.length > MAX_LEDGER_LINES) {
            await fs.writeFile(target, lines.slice(-MAX_LEDGER_LINES).join('\n') + '\n', 'utf8');
        }
    } catch (err: any) {
        // Accounting never breaks a provider response, but a failing ledger write
        // surfaces a one-time warning per session.
        ledgerWriteFailureCount += 1;
        ledgerWriteFailureLast = err?.message ?? String(err);
        if (!ledgerWriteFailureWarned) {
            ledgerWriteFailureWarned = true;
            void vscode.window.showWarningMessage(
                `Harmony: the usage ledger could not be written (${ledgerWriteFailureLast}). Cost accounting may be incomplete this session.`
            );
        }
    }
}

function notifyUsageListeners(): void {
    for (const cb of listeners) {
        try { cb(); } catch { /* ignore */ }
    }
}

function latencyBand(durationMs: number | undefined): 'normal' | 'delayed' | 'slow' | undefined {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
    if (durationMs >= PROVIDER_LATENCY_SLOW_MS) return 'slow';
    if (durationMs >= PROVIDER_LATENCY_DELAYED_MS) return 'delayed';
    return 'normal';
}

export function recordUsage(rec: UsageRecord): void {
    records.push(rec);
    const estimate = typeof rec.estimatedCostDollars === 'number'
        ? rec.estimatedCostDollars
        : estimateCost(rec.provider, rec.model, rec.promptTokens, rec.completionTokens, rec.cachedPromptTokens);
    void appendProviderLedger({
        version: 1,
        kind: 'usage',
        timestamp: rec.timestamp,
        provider: rec.provider,
        tier: rec.tier,
        model: rec.model,
        status: 'recorded',
        promptTokens: rec.promptTokens,
        completionTokens: rec.completionTokens,
        totalTokens: rec.promptTokens + rec.completionTokens,
        cachedPromptTokens: rec.cachedPromptTokens,
        thoughtsTokens: rec.thoughtsTokens,
        promptChars: rec.promptChars,
        promptCjkChars: rec.promptCjkChars,
        toolSchemaChars: rec.toolSchemaChars,
        toolCount: rec.toolCount,
        estimatorVersion: rec.estimatorVersion,
        turnId: rec.turnId,
        stepId: rec.stepId,
        usageReported: rec.usageReported,
        stepOutcome: rec.stepOutcome,
        servedModel: rec.servedModel,
        verdict: rec.verdict,
        evidenceHash: rec.evidenceHash,
        durationMs: rec.durationMs,
        latencyBand: latencyBand(rec.durationMs),
        billableUnits: rec.billableUnits,
        billableUnitLabel: rec.billableUnitLabel,
        estimatedCostDollars: estimate,
        estimatedCostKnown: estimate !== undefined,
        policy: providerPolicySnapshot(),
    });
    notifyUsageListeners();
}

export function onUsageChange(cb: () => void): vscode.Disposable {
    listeners.add(cb);
    return new vscode.Disposable(() => listeners.delete(cb));
}

export interface UsageSummaryRow {
    provider: UsageProviderId;
    tier: UsageTier;
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    measuredCalls: number;
    totalDurationMs: number;
    averageDurationMs?: number;
    lastDurationMs?: number;
    maxDurationMs?: number;
    delayedCalls: number;
    slowCalls: number;
    estCostDollars: number;
    estCostKnown: boolean;
    /** Cost if zero cache hits (worst-case). Meaningful for DeepSeek and Gemini. */
    worstCaseCostDollars?: number;
    cachedPromptTokens: number;
    thoughtsTokens?: number;
    billableUnits: number;
    billableUnitLabel?: string;
}

export function estimateCost(provider: UsageProviderId, model: string, prompt: number, completion: number, cachedPrompt?: number): number | undefined {
    let pM = 0; // Per million prompt
    let cM = 0; // Per million completion
    const lower = model.toLowerCase();
    
    if (provider === 'gemini') {
        if (lower.includes('flash') || lower.includes('hydrogen')) {
            pM = 0.075; cM = 0.30; // gemini-flash / gemini-4-hydrogen (approximate local estimate)
        } else if (lower.includes('neon')) {
            pM = 0.60; cM = 2.50; // gemini-4-neon (Pareto-efficient frontier; approximate local estimate — check GCP/AI Studio console)
        } else {
            pM = 1.25; cM = 5.00; // gemini-pro / argon / carbon (approximate local estimate — check GCP/AI Studio console)
        }
        // Apply Gemini implicit/explicit prefix cache discount (75% off cached input tokens)
        if (cachedPrompt !== undefined && cachedPrompt > 0 && prompt > 0) {
            const clampedCached = Math.min(Math.max(0, cachedPrompt), prompt);
            const missPrompt = Math.max(0, prompt - clampedCached);
            return (missPrompt / 1000000) * pM + (clampedCached / 1000000) * (pM * 0.25) + (completion / 1000000) * cM;
        }
    } else if (provider === 'deepseek') {
        if (lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1')) {
            pM = 0.55; cM = 2.19;
        } else {
            // DeepSeek cache pricing: cached input is substantially cheaper than uncached
            pM = 0.14; cM = 0.28;
        }
        // Apply cache discount for DeepSeek: cached prompt tokens are 10x cheaper
        if (cachedPrompt !== undefined && cachedPrompt > 0 && prompt > 0) {
            const clampedCached = Math.min(Math.max(0, cachedPrompt), prompt);
            const missPrompt = Math.max(0, prompt - clampedCached);
            return (missPrompt / 1000000) * pM + (clampedCached / 1000000) * (pM * 0.1) + (completion / 1000000) * cM;
        }
    } else if (provider === 'openai') {
        if (lower.includes('dall-e') || lower.includes('image')) {
            return undefined;
        }
        if (lower.includes('gpt-4o-mini') || lower.includes('luna')) {
            pM = 0.15; cM = 0.60;
        } else if (lower.includes('gpt-4o')) {
            pM = 2.50; cM = 10.00;
        } else if (lower.includes('gpt-5-mini') || lower.includes('terra')) {
            pM = 0.25; cM = 2.00;
        } else if (lower.includes('astra') || lower.includes('gpt-6')) {
            pM = 2.50; cM = 15.00;
        } else if (lower.includes('gpt-5')) {
            pM = 1.25; cM = 10.00;
        } else if (/^o\d/.test(lower) || lower.includes('heavy')) {
            pM = 2.00; cM = 8.00;
        } else {
            return undefined;
        }
    } else if (provider === 'claude') {
        if (lower.includes('haiku')) {
            pM = 0.25; cM = 1.25;
        } else if (lower.includes('opus') || lower.includes('fable')) {
            pM = 15.00; cM = 75.00;
        } else {
            pM = 3.00; cM = 15.00;
        }
    } else if (provider === 'openrouter') {
        if (lower.includes(':free')) {
            pM = 0; cM = 0;
        } else {
            return undefined;
        }
    } else if (provider === 'alibaba') {
        if (lower.includes('flash')) {
            pM = 0.05; cM = 0.40;
        } else if (lower.includes('coder')) {
            pM = 0.30; cM = 1.50;
        } else if (lower.includes('plus')) {
            pM = 0.40; cM = 1.20;
        } else {
            return undefined;
        }
    } else if (provider === 'moonshot') {
        return undefined;
    } else {
        return undefined;
    }
    
    return (prompt / 1000000) * pM + (completion / 1000000) * cM;
}

export function summarize(): UsageSummaryRow[] {
    const agg = new Map<string, UsageSummaryRow>();
    for (const r of records) {
        const k = `${r.provider}::${r.tier}::${r.model}`;
        let row = agg.get(k);
        if (!row) {
            row = {
                provider: r.provider, tier: r.tier, model: r.model,
                calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estCostDollars: 0, estCostKnown: true,
                cachedPromptTokens: 0,
                measuredCalls: 0, totalDurationMs: 0, delayedCalls: 0, slowCalls: 0,
                billableUnits: 0, billableUnitLabel: r.billableUnitLabel
            };
            agg.set(k, row);
        }
        row.calls += 1;
        row.promptTokens += r.promptTokens;
        row.completionTokens += r.completionTokens;
        row.totalTokens += r.promptTokens + r.completionTokens;
        if (typeof r.cachedPromptTokens === 'number' && r.cachedPromptTokens > 0) {
            row.cachedPromptTokens += r.cachedPromptTokens;
        }
        if (typeof r.thoughtsTokens === 'number' && r.thoughtsTokens > 0) {
            row.thoughtsTokens = (row.thoughtsTokens ?? 0) + r.thoughtsTokens;
        }
        if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0) {
            row.measuredCalls += 1;
            row.totalDurationMs += r.durationMs;
            row.averageDurationMs = Math.round(row.totalDurationMs / row.measuredCalls);
            row.lastDurationMs = r.durationMs;
            row.maxDurationMs = Math.max(row.maxDurationMs ?? 0, r.durationMs);
            const band = latencyBand(r.durationMs);
            if (band === 'delayed') row.delayedCalls += 1;
            if (band === 'slow') row.slowCalls += 1;
        }
        if (r.billableUnits) {
            row.billableUnits += r.billableUnits;
            row.billableUnitLabel = r.billableUnitLabel ?? row.billableUnitLabel;
        }
        const estimate = typeof r.estimatedCostDollars === 'number'
            ? r.estimatedCostDollars
            : estimateCost(r.provider, r.model, r.promptTokens, r.completionTokens, r.cachedPromptTokens);
        if (estimate === undefined) {
            row.estCostKnown = false;
        } else {
            row.estCostDollars += estimate;
        }
        // Worst-case cost: what this would cost with zero DeepSeek/Gemini cache hits
        if (r.provider === 'deepseek' || r.provider === 'gemini') {
            const worst = estimateCost(r.provider, r.model, r.promptTokens, r.completionTokens);
            if (worst !== undefined) {
                row.worstCaseCostDollars = (row.worstCaseCostDollars ?? 0) + worst;
            }
        }
    }
    return Array.from(agg.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

function directUsageRows(): UsageSummaryRow[] {
    return summarize().filter(row => row.provider !== 'vscode-lm');
}

export function providerAccountingSummary(): ProviderAccountingSummary {
    const policy = providerPolicySnapshot();
    const rows = directUsageRows();
    return {
        enabled: policy.enabled,
        accountingEnabled: policy.accountingEnabled,
        directCalls: rows.reduce((sum, row) => sum + row.calls, 0),
        directEstimatedCostDollars: rows.reduce((sum, row) => sum + row.estCostDollars, 0),
        directEstimatedCostKnown: rows.every(row => row.estCostKnown),
        ledgerPath: policy.ledgerPath,
        allowedProviders: policy.allowedProviders,
        deniedProviders: policy.deniedProviders,
        allowedModelsByProvider: policy.allowedModelsByProvider,
        deniedModelsByProvider: policy.deniedModelsByProvider,
        maxSessionCalls: policy.maxSessionCalls,
        maxSessionEstimatedCostUsd: policy.maxSessionEstimatedCostUsd,
        maxCallsByProvider: policy.maxCallsByProvider,
        maxEstimatedCostUsdByProvider: policy.maxEstimatedCostUsdByProvider,
    };
}

export function evaluateProviderPolicy(provider: ProviderId, tier: Tier, model: string, options?: { includeModelFilters?: boolean }): ProviderPolicyDecision {
    const policy = providerPolicySnapshot();
    if (!policy.enabled) return { allowed: true, policy };
    const includeModelFilters = options?.includeModelFilters !== false;
    const allowed = policy.allowedProviders.map(item => item.toLowerCase());
    const denied = policy.deniedProviders.map(item => item.toLowerCase());
    if (allowed.length > 0 && !allowed.includes(provider)) {
        return { allowed: false, reason: `${provider} is not in harmony.providerPolicy.allowedProviders.`, policy };
    }
    if (denied.includes(provider)) {
        return { allowed: false, reason: `${provider} is listed in harmony.providerPolicy.deniedProviders.`, policy };
    }
    if (includeModelFilters) {
        const allowedModels = policy.allowedModelsByProvider[provider] ?? [];
        const deniedModels = policy.deniedModelsByProvider[provider] ?? [];
        if (allowedModels.length > 0 && !allowedModels.some(pattern => modelMatchesPattern(model, pattern))) {
            return { allowed: false, reason: `${provider}/${model} is not allowed by harmony.providerPolicy.allowedModelsByProvider.`, policy };
        }
        if (deniedModels.some(pattern => modelMatchesPattern(model, pattern))) {
            return { allowed: false, reason: `${provider}/${model} is denied by harmony.providerPolicy.deniedModelsByProvider.`, policy };
        }
    }
    const directRows = directUsageRows();
    const directCalls = directRows.reduce((sum, row) => sum + row.calls, 0);
    if (policy.maxSessionCalls > 0 && directCalls >= policy.maxSessionCalls) {
        return { allowed: false, reason: `Direct provider session call quota reached: ${policy.maxSessionCalls}.`, policy };
    }
    const providerCalls = directRows.filter(row => row.provider === provider).reduce((sum, row) => sum + row.calls, 0);
    const providerCallLimit = policy.maxCallsByProvider[provider] ?? 0;
    if (providerCallLimit > 0 && providerCalls >= providerCallLimit) {
        return { allowed: false, reason: `${provider} call quota reached: ${providerCallLimit}.`, policy };
    }
    const directCost = directRows.reduce((sum, row) => sum + row.estCostDollars, 0);
    if (policy.maxSessionEstimatedCostUsd > 0 && directCost >= policy.maxSessionEstimatedCostUsd) {
        return { allowed: false, reason: `Direct provider session budget reached.`, policy };
    }
    const providerCost = directRows.filter(row => row.provider === provider).reduce((sum, row) => sum + row.estCostDollars, 0);
    const providerCostLimit = policy.maxEstimatedCostUsdByProvider[provider] ?? 0;
    if (providerCostLimit > 0 && providerCost >= providerCostLimit) {
        return { allowed: false, reason: `${provider} provider budget reached.`, policy };
    }
    return { allowed: true, policy };
}

export function recordProviderPolicyBlock(provider: ProviderId, tier: Tier, model: string, reason: string): void {
    void appendProviderLedger({
        version: 1,
        kind: 'policy_block',
        timestamp: new Date().toISOString(),
        provider,
        tier,
        model,
        status: 'blocked',
        reason,
        policy: providerPolicySnapshot(),
    });
    notifyUsageListeners();
}

export function totalTokens(): number {
    let n = 0;
    for (const r of records) n += r.promptTokens + r.completionTokens;
    return n;
}

export function totalCalls(): number {
    return records.length;
}

export function clearUsage(): void {
    records.length = 0;
    for (const cb of listeners) {
        try { cb(); } catch { /* ignore */ }
    }
}

export function recentCalls(limit = 10): UsageRecord[] {
    return records.slice(-limit).reverse();
}

export interface FallbackEvent {
    timestamp: string;
    provider: ProviderId;
    originalModel: string;
    fallbackModel: string;
    reason: string;
}

const fallbackEvents: FallbackEvent[] = [];
const fallbackListeners = new Set<() => void>();

export function recordRouteGuardEvent(provider: UsageProviderId, tier: UsageTier, model: string, reason: string): void {
    void appendProviderLedger({
        version: 1,
        kind: 'route_guard',
        timestamp: new Date().toISOString(),
        provider,
        tier,
        model,
        status: 'guarded',
        reason,
        policy: providerPolicySnapshot(),
    });
    notifyUsageListeners();
}

export function recordFallbackEvent(provider: ProviderId, originalModel: string, fallbackModel: string, reason: string): void {
    const timestamp = new Date().toISOString();
    fallbackEvents.push({
        timestamp,
        provider,
        originalModel,
        fallbackModel,
        reason
    });
    void appendProviderLedger({
        version: 1,
        kind: 'fallback',
        timestamp,
        provider,
        tier: 'coding',
        model: originalModel,
        servedModel: fallbackModel,
        status: 'fallback',
        reason,
        policy: providerPolicySnapshot(),
    });
    for (const cb of fallbackListeners) {
        try { cb(); } catch { /* ignore */ }
    }
}

export function onFallbackChange(cb: () => void): vscode.Disposable {
    fallbackListeners.add(cb);
    return new vscode.Disposable(() => fallbackListeners.delete(cb));
}

export function getFallbackEvents(): FallbackEvent[] {
    return [...fallbackEvents].slice(-10); // Last 10 events
}

// ── Self-Calibrating CJK-Aware Token Estimator (Ordinary Least Squares) ──
// Fits `promptTokens ≈ a * nonCjkChars + b * cjkChars` from real provider usage
// rows where `usageReported !== false`, `promptTokens > 0`, and `promptChars > 0`.
// Falls back to conservative seeds (`a = 1/3`, `b = 1.5`) until enough samples
// are collected or if the normal equations are near-collinear.

export interface CalibratedTokenCoefficients {
    /** Tokens per non-CJK character (clamped to [0.15, 0.75]). */
    nonCjkCoeff: number;
    /** Tokens per CJK character (clamped to [0.40, 2.50]). */
    cjkCoeff: number;
    /** Number of verified usage observations used in the fit. */
    sampleCount: number;
    /** True when OLS fit succeeded (>= minSamples), false when using seed priors. */
    calibrated: boolean;
    /** 99th-percentile relative underestimate safety margin ( >= 1.05 when calibrated ). */
    safetyMultiplier: number;
}

export const SEED_NON_CJK_COEFF = 1 / 3;
export const SEED_CJK_COEFF = 1.5;
const MIN_OLS_SAMPLES = 5;
const MAX_OLS_WINDOW = 200;

/**
 * Pure two-parameter OLS fitter (`tokens ≈ a * nonCjk + b * cjk`) with Ridge
 * regularization toward the seed priors so pure-English or pure-CJK sessions
 * never produce singular or wild coefficients.
 */
export function fitTokenEstimatorCoefficients(
    samples: ReadonlyArray<Pick<UsageRecord, 'promptTokens' | 'promptChars' | 'promptCjkChars' | 'usageReported'>>,
    minSamples: number = MIN_OLS_SAMPLES
): CalibratedTokenCoefficients {
    const valid = samples.filter(s =>
        s.usageReported !== false
        && typeof s.promptTokens === 'number' && s.promptTokens > 0
        && typeof s.promptChars === 'number' && s.promptChars > 0
    ).slice(-MAX_OLS_WINDOW);

    if (valid.length < minSamples) {
        return {
            nonCjkCoeff: SEED_NON_CJK_COEFF,
            cjkCoeff: SEED_CJK_COEFF,
            sampleCount: valid.length,
            calibrated: false,
            safetyMultiplier: 1.0,
        };
    }

    // Ridge penalty (lambda) anchors each parameter gently to its seed prior
    // when one character class (e.g., CJK in an all-English session) has near-zero variance.
    const lambda = 1e4;
    let sxx = lambda;
    let sxy = 0;
    let syy = lambda;
    let sxz = lambda * SEED_NON_CJK_COEFF;
    let syz = lambda * SEED_CJK_COEFF;

    for (const row of valid) {
        const cjk = Math.max(0, Math.min(row.promptChars!, row.promptCjkChars ?? 0));
        const nonCjk = Math.max(0, row.promptChars! - cjk);
        const y = row.promptTokens;
        sxx += nonCjk * nonCjk;
        sxy += nonCjk * cjk;
        syy += cjk * cjk;
        sxz += nonCjk * y;
        syz += cjk * y;
    }

    const det = sxx * syy - sxy * sxy;
    if (!Number.isFinite(det) || det <= 1e-6) {
        return {
            nonCjkCoeff: SEED_NON_CJK_COEFF,
            cjkCoeff: SEED_CJK_COEFF,
            sampleCount: valid.length,
            calibrated: false,
            safetyMultiplier: 1.0,
        };
    }

    const rawA = (syy * sxz - sxy * syz) / det;
    const rawB = (sxx * syz - sxy * sxz) / det;
    const nonCjkCoeff = Math.min(0.75, Math.max(0.15, rawA));
    const cjkCoeff = Math.min(2.50, Math.max(0.40, rawB));

    // Compute p99 actual/predicted ratio so the guard maintains an empirical safety margin.
    const ratios: number[] = [];
    for (const row of valid) {
        const cjk = Math.max(0, Math.min(row.promptChars!, row.promptCjkChars ?? 0));
        const nonCjk = Math.max(0, row.promptChars! - cjk);
        const pred = Math.max(1, nonCjk * nonCjkCoeff + cjk * cjkCoeff);
        ratios.push(row.promptTokens / pred);
    }
    ratios.sort((a, b) => a - b);
    const p99Idx = Math.min(ratios.length - 1, Math.floor(ratios.length * 0.99));
    const safetyMultiplier = Math.min(1.35, Math.max(1.05, ratios[p99Idx] ?? 1.05));

    return {
        nonCjkCoeff,
        cjkCoeff,
        sampleCount: valid.length,
        calibrated: true,
        safetyMultiplier,
    };
}

/**
 * Estimate prompt tokens for `(promptChars, promptCjkChars)` using the session's
 * self-calibrated OLS coefficients for `provider` (or global session records if
 * provider-specific rows are < MIN_OLS_SAMPLES), falling back to the seed formula.
 */
export function estimateCalibratedPromptTokens(
    promptChars: number,
    promptCjkChars: number,
    provider?: UsageProviderId,
    customRecords?: ReadonlyArray<Pick<UsageRecord, 'provider' | 'promptTokens' | 'promptChars' | 'promptCjkChars' | 'usageReported'>>
): number {
    const safeChars = Math.max(0, promptChars);
    const safeCjk = Math.max(0, Math.min(safeChars, promptCjkChars));
    const nonCjkChars = Math.max(0, safeChars - safeCjk);

    const pool = customRecords ?? records;
    const providerFiltered = provider ? pool.filter(r => r.provider === provider) : pool;
    const fit = fitTokenEstimatorCoefficients(
        providerFiltered.length >= MIN_OLS_SAMPLES ? providerFiltered : pool
    );

    if (!fit.calibrated) {
        return Math.ceil(nonCjkChars * SEED_NON_CJK_COEFF) + Math.ceil(safeCjk * SEED_CJK_COEFF);
    }
    return Math.ceil((nonCjkChars * fit.nonCjkCoeff + safeCjk * fit.cjkCoeff) * fit.safetyMultiplier);
}

