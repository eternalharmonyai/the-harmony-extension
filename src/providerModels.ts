/**
 * providerModels.ts — Single source of truth for provider + model metadata.
 *
 * ════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ════════════════════════════════════════════════════════════════════
 * Previously, model labels, display names, dropdown entries, CLI aliases,
 * and QuickPick items were duplicated across 5 files:
 *   - providers.ts     (tier defaults, display names)
 *   - sidebar.ts       (dropdown labels EN + ZH)
 *   - extension.ts     (QuickPick model picker)
 *   - chatParticipant.ts (/model CLI aliases + help text)
 *   - package.json     (enum lists)
 *
 * Adding or renaming a model required touching ALL of them — which led to
 * drift (e.g., Gemini had no sidebar entry, fallback events showed raw IDs,
 * /model help text referenced old names).
 *
 * This file is the ONE place to update. Everything else imports from here.
 * ════════════════════════════════════════════════════════════════════
 */

import type { ProviderId, Tier, ProviderTierMap } from './providers';

// ── Types ────────────────────────────────────────────────────────────

export interface ModelMeta {
    /** Model ID used in API calls (e.g. 'deepseek-v4-flash') */
    id: string;
    /** Short English label for dropdowns (e.g. 'deepseek-v4-flash (fast, thinking ON)') */
    label: string;
    /** Short Chinese label for dropdowns (e.g. 'deepseek-v4-flash（快速，支持思考）') */
    labelZh: string;
    /** Optional CLI aliases for the /model command (e.g. ['flash', 'v4-flash']) */
    aliases?: string[];
    /** Longer description for QuickPick details panel */
    detail?: string;
}

export interface ProviderDisplayMeta {
    /** Provider ID (e.g. 'deepseek') */
    id: ProviderId;
    /** English display name (e.g. 'DeepSeek') */
    displayName: string;
    /** Chinese display name with subtitle (e.g. '深度求索 DeepSeek — 推理能力强，性价比高') */
    displayNameZh: string;
    /** VS Code secret key path (e.g. 'harmony.deepseekApiKey') */
    secretKey: string;
    /** All models available for this provider's dropdown */
    models: ModelMeta[];
}

// ── Model Definitions ────────────────────────────────────────────────
// Each model appears here ONCE. Labels are used by sidebar dropdown,
// QuickPick, and any other surface that needs a human-readable name.

const DEEPSEEK_MODELS: ModelMeta[] = [
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash (fast, thinking ON)', labelZh: 'deepseek-v4-flash（快速，支持思考）', aliases: ['flash', 'v4-flash'], detail: 'Fast, inexpensive default direct route. Uses your DeepSeek API key.' },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro (most capable)', labelZh: 'deepseek-v4-pro（综合最强）', aliases: ['pro', 'v4-pro'], detail: 'Most capable DeepSeek route. Uses your DeepSeek API key, independent of Copilot plan limits.' },
];

const ALIBABA_MODELS: ModelMeta[] = [
    { id: 'qwen3.6-flash', label: 'qwen3.6-flash (fast, cheap)', labelZh: 'qwen3.6-flash（轻量高效）', aliases: ['qwen-flash', 'qwen-turbo', 'qwen-turbo-latest'], detail: 'Fast low-cost Alibaba text route. Curated flash-equivalent primary option.' },
    { id: 'qwen3.7-plus', label: 'qwen3.7-plus (balanced mid)', labelZh: 'qwen3.7-plus（均衡实用）', aliases: ['qwen-plus'], detail: 'Balanced Alibaba route for general tasks.' },
    { id: 'qwen3.7-max', label: 'qwen3.7-max (best quality)', labelZh: 'qwen3.7-max（效果最佳）', aliases: ['qwen-max', 'qwen3-max', 'qwen-max-latest'], detail: 'Higher-capability Qwen Max route for hard turns. Use deliberately; pricing is materially higher.' },
    { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus (coding specialist)', labelZh: 'qwen3-coder-plus（代码专精）', aliases: ['qwen', 'qwen-coder'], detail: 'Alibaba DashScope coding route. Uses your Alibaba / Qwen API key.' },
];

const MOONSHOT_MODELS: ModelMeta[] = [
    { id: 'kimi-k2.6', label: 'kimi-k2.6 (fast, general)', labelZh: 'kimi-k2.6（快速通用）', detail: 'Current Kimi multimodal/coding route with tool calls and 256k context. Uses your Moonshot / Kimi API key.' },
    { id: 'kimi-k2.7-code', label: 'kimi-k2.7-code (coding, thinking ON)', labelZh: 'kimi-k2.7-code（代码专精，支持思考）', aliases: ['kimi', 'kimi-k2.7'], detail: 'Kimi coding model with thinking enabled. Uses your Moonshot API key.' },
    { id: 'kimi-k2.7-code-highspeed', label: 'kimi-k2.7-code-highspeed (6× faster)', labelZh: 'kimi-k2.7-code-highspeed（6倍极速）', detail: 'High-speed variant of Kimi K2.7 Code.' },
    { id: 'kimi-k3', label: 'kimi-k3 (flagship, 1M context)', labelZh: 'kimi-k3（旗舰，1M 上下文）', aliases: ['kimi-k3', 'kimi-latest'], detail: 'Kimi K3 flagship with 1M context and reasoning_effort:max. Uses your Moonshot API key.' },
];

const KIMICODE_MODELS: ModelMeta[] = [
    { id: 'kimi-for-coding', label: 'kimi-for-coding (K2.7 Code stable)', labelZh: 'kimi-for-coding（K2.7 代码稳定版）', detail: 'Kimi Code stable coding route via api.kimi.com. Uses your KimiCode membership key.' },
    { id: 'kimi-for-coding-highspeed', label: 'kimi-for-coding-highspeed (6× faster)', labelZh: 'kimi-for-coding-highspeed（6倍极速）', detail: 'High-speed variant of Kimi Code.' },
    { id: 'k3', label: 'k3 (K3 flagship, reasoning: max)', labelZh: 'k3（K3 旗舰，极致推理）', aliases: ['k3'], detail: 'K3 flagship with reasoning_effort:max via api.kimi.com/coding/v1. Uses your KimiCode membership key.' },
];

const TENCENT_MODELS: ModelMeta[] = [
    { id: 'hy3-preview', label: 'hy3-preview (flagship)', labelZh: 'hy3-preview（旗舰预览版）', aliases: ['hunyuan', 'hunyuan-lite', 'hunyuan-turbos', 'hunyuan-turbos-latest'] },
];

const GEMINI_MODELS: ModelMeta[] = [
    { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash (fast, multimodal)', labelZh: 'gemini-3.5-flash（快速，多模态）', aliases: ['gemini', 'gemini-3.5'], detail: 'Google Gemini 3.5 Flash via OpenAI-compatible endpoint. Uses your Gemini API key.' },
    { id: 'gemini-3.6-flash', label: 'gemini-3.6-flash (newest, fast, multimodal)', labelZh: 'gemini-3.6-flash（最新，快速，多模态）', detail: 'Google Gemini 3.6 Flash — newest release. Uses your Gemini API key.' },
    { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (lightest, cheapest)', labelZh: 'gemini-3.1-flash-lite（最轻量）', detail: 'Lightest Gemini model for routine tasks.' },
    { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (most capable)', labelZh: 'gemini-3.1-pro-preview（综合最强）', detail: 'Most capable Gemini Pro model.' },
];

const ZHIPU_MODELS: ModelMeta[] = [
    { id: 'glm-5.1', label: 'glm-5.1 (fast, light)', labelZh: 'glm-5.1（快速轻量）' },
    { id: 'glm-5.2', label: 'glm-5.2 (balanced, capable)', labelZh: 'glm-5.2（均衡强大）', aliases: ['glm', 'zhipu'] },
];

const ZHIPU_CODING_MODELS: ModelMeta[] = [
    { id: 'glm-5.2', label: 'glm-5.2 (coding plan, cost-efficient)', labelZh: 'glm-5.2（代码优选，高性价比）' },
    { id: 'glm-5.1', label: 'glm-5.1 (fast, light)', labelZh: 'glm-5.1（快速轻量）' },
];

const OPENAI_MODELS: ModelMeta[] = [
    { id: 'gpt-5-mini', label: 'gpt-5-mini (fast, efficient)', labelZh: 'gpt-5-mini（快速高效）', aliases: ['gpt', 'openai'] },
    { id: 'gpt-5', label: 'gpt-5 (most capable)', labelZh: 'gpt-5（综合最强）', aliases: ['gpt-5'] },
];

const CLAUDE_MODELS: ModelMeta[] = [
    { id: 'claude-sonnet-4', label: 'claude-sonnet-4 (balanced, coding)', labelZh: 'claude-sonnet-4（均衡，编程强）', aliases: ['claude', 'claude-sonnet-4'] },
    { id: 'claude-haiku-4', label: 'claude-haiku-4 (fast, light)', labelZh: 'claude-haiku-4（快速轻量）', aliases: ['claude-haiku-4'] },
];

const OPENROUTER_MODELS: ModelMeta[] = [
    { id: 'Qwen/Qwen3-235B-A22B-fp8-tput', label: 'Qwen3-235B (routed)', labelZh: 'Qwen3-235B（路由）', aliases: ['openrouter'] },
];

const BYTEDANCE_MODELS: ModelMeta[] = [
    { id: 'doubao-seed-evolving', label: 'Seed-Evolving (always latest, weekly updates)', labelZh: 'Seed-Evolving（持续更新，每周迭代）', aliases: ['doubao', 'seed-evolving'], detail: 'ByteDance flagship model — auto-updates to the latest version weekly. Activate in Ark console first. 6¥/M input, 30¥/M output.' },
    { id: 'doubao-seed-2-1-pro', label: 'Seed-2.1-pro (flagship, stable)', labelZh: 'Seed-2.1-pro（旗舰稳定版）', aliases: ['seed-pro', 'doubao-pro'], detail: 'Stable flagship snapshot. Best quality for hard reasoning tasks. Activate in Ark console first. 6¥/M input, 30¥/M output.' },
    { id: 'doubao-seed-2-1-turbo', label: 'Seed-2.1-turbo (fast, cost-efficient)', labelZh: 'Seed-2.1-turbo（快速，高性价比）', aliases: ['seed-turbo', 'doubao-turbo'], detail: 'Faster, lower-cost version. Activate in Ark console first. 3¥/M input, 15¥/M output — excellent cost/quality for routine tasks.' },
];

const BYTEDANCE_REWARDS_MODELS: ModelMeta[] = [
    { id: 'ep-rewards-placeholder', label: 'Your Rewards endpoint ID (ep-xxx)', labelZh: '协作激励接入点 ID（ep-xxx）', aliases: ['doubao-rewards', 'rewards'], detail: 'Paste your Volcano Engine authorized access point ID (ep-xxxxxxxx). Get it from the Ark console after enabling the Collaboration Rewards Program. Uses the same ByteDance API key.' },
];

const STEPFUN_MODELS: ModelMeta[] = [
    { id: 'step-3.7-flash', label: 'step-3.7-flash (MoE, multimodal, agent/coding)', labelZh: 'step-3.7-flash（MoE，多模态，智能体/编程）', aliases: ['stepfun', 'step-flash'], detail: 'StepFun (阶跃星辰) flagship. 198B MoE architecture, 256K context, native image/video, tool calling, reasoning effort control. $0.20/M input, $1.15/M output. Verify exact model ID via Discover Models.' },
];

// ── Provider Registry ────────────────────────────────────────────────

export const PROVIDER_REGISTRY: ProviderDisplayMeta[] = [
    {
        id: 'deepseek',
        displayName: 'DeepSeek',
        displayNameZh: '深度求索 DeepSeek — 推理能力强，性价比高',
        secretKey: 'harmony.deepseekApiKey',
        models: DEEPSEEK_MODELS,
    },
    {
        id: 'alibaba',
        displayName: 'Alibaba / Qwen',
        displayNameZh: '阿里通义千问 — 多模态，国际/国内双端点',
        secretKey: 'harmony.alibaba.apiKey',
        models: ALIBABA_MODELS,
    },
    {
        id: 'moonshot',
        displayName: 'Moonshot / Kimi',
        displayNameZh: '月之暗面 Kimi — 长上下文，中文理解优秀',
        secretKey: 'harmony.moonshot.apiKey',
        models: MOONSHOT_MODELS,
    },
    {
        id: 'kimiCode',
        displayName: 'KimiCode',
        displayNameZh: 'Kimi 代码版 — 专注编程任务',
        secretKey: 'harmony.kimiCode.apiKey',
        models: KIMICODE_MODELS,
    },
    {
        id: 'tencent',
        displayName: 'Tencent / Hunyuan',
        displayNameZh: '腾讯混元 — 腾讯云生态集成',
        secretKey: 'harmony.tencent.apiKey',
        models: TENCENT_MODELS,
    },
    {
        id: 'gemini',
        displayName: 'Gemini',
        displayNameZh: 'Google Gemini — 多模态，国际化',
        secretKey: 'harmony.geminiApiKey',
        models: GEMINI_MODELS,
    },
    {
        id: 'zhipu',
        displayName: 'Zhipu / GLM (Z.AI)',
        displayNameZh: '智谱 GLM (Z.AI) — 通用大模型',
        secretKey: 'harmony.zhipu.apiKey',
        models: ZHIPU_MODELS,
    },
    {
        id: 'zhipu-coding',
        displayName: 'Zhipu Coding (Z.AI Coding Plan)',
        displayNameZh: '智谱编程计划 (Z.AI Coding Plan)',
        secretKey: 'harmony.zhipu.apiKey',
        models: ZHIPU_CODING_MODELS,
    },
    {
        id: 'openai',
        displayName: 'OpenAI',
        displayNameZh: 'OpenAI GPT — 通用大模型',
        secretKey: 'harmony.openaiApiKey',
        models: OPENAI_MODELS,
    },
    {
        id: 'claude',
        displayName: 'Anthropic (Claude models)',
        displayNameZh: 'Anthropic Claude — 推理与创作',
        secretKey: 'harmony.claudeApiKey',
        models: CLAUDE_MODELS,
    },
    {
        id: 'openrouter',
        displayName: 'OpenRouter',
        displayNameZh: 'OpenRouter — 多模型聚合路由',
        secretKey: 'harmony.openrouter.apiKey',
        models: OPENROUTER_MODELS,
    },
    {
        id: 'bytedance',
        displayName: 'ByteDance / Doubao',
        displayNameZh: '字节跳动豆包 — 性价比极高，国内生态',
        secretKey: 'harmony.bytedance.apiKey',
        models: BYTEDANCE_MODELS,
    },
    {
        id: 'bytedance-rewards',
        displayName: 'Doubao Rewards (协作激励计划)',
        displayNameZh: '豆包协作激励计划 — 免费额度，需使用接入点 ID',
        secretKey: 'harmony.bytedance.apiKey',
        models: BYTEDANCE_REWARDS_MODELS,
    },
    {
        id: 'stepfun',
        displayName: 'StepFun / 阶跃星辰',
        displayNameZh: '阶跃星辰 — MoE多模态，Agent/编程优化',
        secretKey: 'harmony.stepfun.apiKey',
        models: STEPFUN_MODELS,
    },
];

// ── Lookup Helpers ───────────────────────────────────────────────────

/** Get all model metadata for a provider, or empty array if not found. */
export function getProviderModels(provider: ProviderId): ModelMeta[] {
    return PROVIDER_REGISTRY.find(p => p.id === provider)?.models ?? [];
}

/** Get a friendly display name for a model ID (falls back to raw ID). */
export function modelDisplayName(provider: ProviderId, modelId: string): string {
    const models = getProviderModels(provider);
    const found = models.find(m => m.id === modelId);
    if (found) return found.label;
    return modelId;
}

/** Get a friendly display name for a model ID from any provider. */
export function modelDisplayNameAny(modelId: string): string {
    for (const provider of PROVIDER_REGISTRY) {
        const found = provider.models.find(m => m.id === modelId);
        if (found) return found.label;
    }
    return modelId;
}

/** Build a reverse-lookup map of CLI alias → { provider, model }. */
export function buildAliasMap(): Record<string, { provider: ProviderId; model: string }> {
    const map: Record<string, { provider: ProviderId; model: string }> = {};
    for (const provider of PROVIDER_REGISTRY) {
        for (const model of provider.models) {
            // Always map the model's own ID
            map[model.id] = { provider: provider.id, model: model.id };
            // Map any aliases
            if (model.aliases) {
                for (const alias of model.aliases) {
                    map[alias] = { provider: provider.id, model: model.id };
                }
            }
        }
    }
    return map;
}

/** Get display name for a provider. */
export function getProviderDisplayName(provider: ProviderId): string {
    return PROVIDER_REGISTRY.find(p => p.id === provider)?.displayName ?? provider;
}

/** Get Chinese display name for a provider. */
export function getProviderDisplayNameZh(provider: ProviderId): string {
    return PROVIDER_REGISTRY.find(p => p.id === provider)?.displayNameZh ?? provider;
}

/** Get the secret key path for a provider. */
export function getProviderSecretKey(provider: ProviderId): string {
    return PROVIDER_REGISTRY.find(p => p.id === provider)?.secretKey ?? '';
}

// ── Sidebar Dropdown Format ──────────────────────────────────────────
// Converts the registry into the format sidebar.ts expects.

export interface SidebarModelOption {
    value: string;
    label: string;
    labelZh: string;
}

/** Build PRIMARY_MODEL_OPTIONS for the sidebar from the central registry. */
export function buildSidebarModelOptions(): Record<string, SidebarModelOption[]> {
    const result: Record<string, SidebarModelOption[]> = {};
    for (const provider of PROVIDER_REGISTRY) {
        result[provider.id] = provider.models.map(m => ({
            value: m.id,
            label: m.label,
            labelZh: m.labelZh,
        }));
    }
    return result;
}

// ── QuickPick Format (for extension.ts model picker) ────────────────

export interface QuickPickModelEntry {
    label: string;
    description: string;
    detail: string;
    provider: ProviderId;
    model: string;
}

/**
 * Build QuickPick items from the central registry.
 * Each provider's first model becomes a QuickPick entry.
 * The label uses the provider's display name + the model's label.
 */
export function buildQuickPickEntries(
    currentProvider: string,
    currentModelForProvider: (provider: ProviderId) => string | undefined
): QuickPickModelEntry[] {
    const entries: QuickPickModelEntry[] = [];
    for (const provider of PROVIDER_REGISTRY) {
        for (const model of provider.models) {
            entries.push({
                label: `${provider.displayName} / ${model.label}`,
                description: 'Harmony direct API',
                detail: model.detail ?? provider.displayNameZh,
                provider: provider.id,
                model: model.id,
            });
        }
    }
    return entries;
}

// ── Sync Verification ────────────────────────────────────────────────
// Used by the "Harmony: Check Provider Sync" command to detect drift.

export interface SyncCheckResult {
    ok: boolean;
    issues: string[];
}

/**
 * Verify that the sidebar dropdown, QuickPick, and CLI aliases are all
 * consistent with the central registry. Returns a report of any drift.
 */
export function checkProviderSync(): SyncCheckResult {
    const issues: string[] = [];

    // ── Cross-file: verify PROVIDER_DEFAULTS (providers.ts) match registry ──
    // Dynamically import to avoid circular dependency at module load time
    try {
        const providersModule = require('./providers');
        const defaults: Record<string, Record<string, string>> = providersModule.PROVIDER_DEFAULTS;
        for (const [providerId, tiers] of Object.entries(defaults)) {
            const registryEntry = PROVIDER_REGISTRY.find(p => p.id === providerId);
            if (!registryEntry) continue; // provider not in registry yet — skip
            const registryModelIds = new Set(registryEntry.models.map(m => m.id));
            for (const [tier, modelId] of Object.entries(tiers)) {
                if (modelId === 'ep-rewards-placeholder') continue; // special placeholder
                if (!registryModelIds.has(modelId)) {
                    issues.push(`${providerId}.${tier} default "${modelId}" not found in providerModels.ts registry`);
                }
            }
        }
    } catch { /* module not loaded yet — skip cross-file check */ }

    // Verify every provider in PROVIDER_REGISTRY has at least one model
    for (const provider of PROVIDER_REGISTRY) {
        if (provider.models.length === 0) {
            issues.push(`${provider.displayName} (${provider.id}): no models defined`);
        }
    }

    // Verify no duplicate model IDs within a provider
    for (const provider of PROVIDER_REGISTRY) {
        const ids = provider.models.map(m => m.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length > 0) {
            issues.push(`${provider.displayName} (${provider.id}): duplicate model IDs: ${dupes.join(', ')}`);
        }
    }

    // Verify no alias collisions across providers
    const aliasMap = buildAliasMap();
    const aliasCounts: Record<string, number> = {};
    for (const provider of PROVIDER_REGISTRY) {
        for (const model of provider.models) {
            const allNames = [model.id, ...(model.aliases ?? [])];
            for (const name of allNames) {
                aliasCounts[name] = (aliasCounts[name] ?? 0) + 1;
            }
        }
    }
    for (const [alias, count] of Object.entries(aliasCounts)) {
        if (count > 1) {
            issues.push(`Alias "${alias}" is mapped by ${count} models — CLI /model ambiguity`);
        }
    }

    return { ok: issues.length === 0, issues };
}
