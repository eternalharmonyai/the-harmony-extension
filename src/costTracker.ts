import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ProviderId, Tier } from './providers';

export type UsageProviderId = ProviderId | 'vscode-lm';
export type UsageTier = Tier | 'native';

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
    /** Number of prompt tokens served from DeepSeek cache (from X-DS-Usage-Cached-Tokens header). */
    cachedPromptTokens?: number;
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
    kind: 'usage' | 'policy_block';
    timestamp: string;
    provider: UsageProviderId;
    tier: UsageTier;
    model: string;
    status: 'recorded' | 'blocked';
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
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
    const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
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
    } catch { /* accounting must never break a provider response */ }
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
    /** Cost if zero cache hits (worst-case). Only meaningful for DeepSeek. */
    worstCaseCostDollars?: number;
    cachedPromptTokens: number;
    billableUnits: number;
    billableUnitLabel?: string;
}

export function estimateCost(provider: UsageProviderId, model: string, prompt: number, completion: number, cachedPrompt?: number): number | undefined {
    let pM = 0; // Per million prompt
    let cM = 0; // Per million completion
    const lower = model.toLowerCase();
    
    if (provider === 'gemini') {
        if (lower.includes('flash')) {
            pM = 0.075; cM = 0.30;
        } else {
            pM = 1.25; cM = 5.00; // gemini-pro 
        }
    } else if (provider === 'deepseek') {
        if (lower.includes('pro') || lower.includes('reasoner') || lower.includes('r1')) {
            pM = 0.55; cM = 2.19;
        } else {
            // DeepSeek cache pricing: cached input ~90% off ($0.014/M vs $0.14/M)
            pM = 0.14; cM = 0.28;
        }
        // Apply cache discount for DeepSeek: cached prompt tokens are 10x cheaper
        if (cachedPrompt !== undefined && cachedPrompt > 0 && prompt > 0) {
            const missPrompt = Math.max(0, prompt - cachedPrompt);
            return (missPrompt / 1000000) * pM + (cachedPrompt / 1000000) * (pM * 0.1) + (completion / 1000000) * cM;
        }
    } else if (provider === 'openai') {
        if (lower.includes('dall-e') || lower.includes('image')) {
            return undefined;
        }
        if (lower.includes('gpt-4o-mini')) {
            pM = 0.15; cM = 0.60;
        } else if (lower.includes('gpt-4o')) {
            pM = 2.50; cM = 10.00;
        } else if (lower.includes('gpt-5-mini')) {
            pM = 0.25; cM = 2.00;
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
        } else if (lower.includes('opus')) {
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
        // Worst-case cost: what this would cost with zero DeepSeek cache hits
        if (r.provider === 'deepseek') {
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

export function recordFallbackEvent(provider: ProviderId, originalModel: string, fallbackModel: string, reason: string): void {
    fallbackEvents.push({
        timestamp: new Date().toISOString(),
        provider,
        originalModel,
        fallbackModel,
        reason
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
