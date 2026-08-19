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

import * as vscode from 'vscode';
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
    /**
     * Featured/current models appear in the SIDEBAR DROPDOWN (curated).
     * Legacy models set featured:false stay available in the model selector
     * (QuickPick shows ALL models, old + new) but are hidden from the dropdown.
     * Defaults to true.
     */
    featured?: boolean;
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
    { id: 'gemini-3.6-flash', label: 'gemini-3.6-flash (fast, multimodal)', labelZh: 'gemini-3.6-flash（快速，多模态）', aliases: ['gemini-3.6', 'g36'], detail: 'Google Gemini 3.6 Flash. Uses your Gemini API key.' },
    { id: 'gemini-3.7-flash', label: 'gemini-3.7-flash (newest, fast, multimodal)', labelZh: 'gemini-3.7-flash（最新，快速，多模态）', aliases: ['gemini-3.7', 'g37'], detail: 'Google Gemini 3.7 Flash — newest release. Uses your Gemini API key.' },
    { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (lightest, cheapest)', labelZh: 'gemini-3.1-flash-lite（最轻量）', aliases: ['gemini-lite', 'glite'], detail: 'Lightest Gemini model for routine tasks.' },
    { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (most capable)', labelZh: 'gemini-3.1-pro-preview（综合最强）', aliases: ['gemini-pro', 'gpro'], detail: 'Most capable Gemini Pro model.' },
];

const ZHIPU_MODELS: ModelMeta[] = [
    { id: 'glm-5.1', label: 'glm-5.1 (fast, light)', labelZh: 'glm-5.1（快速轻量）' },
    { id: 'glm-5.2', label: 'glm-5.2 (balanced, capable)', labelZh: 'glm-5.2（均衡强大）', aliases: ['glm', 'zhipu'] },
    { id: 'glm-5.3', label: 'glm-5.3 (flagship, heavy/coding)', labelZh: 'glm-5.3（旗舰，重推理/编程）', aliases: ['glm-5.3', 'glm5.3'], detail: 'GLM 5.3 flagship for heavy reasoning and coding. Uses your Zhipu API key.' },
    { id: 'glm-4-plus', label: 'glm-4-plus (legacy flagship, heavy)', labelZh: 'glm-4-plus（上一代旗舰）', aliases: ['glm-4', 'zhipu-4'], detail: 'Older GLM flagship. Available in the model selector; hidden from the dropdown.', featured: false },
];

const ZHIPU_CODING_MODELS: ModelMeta[] = [
    { id: 'glm-5.3', label: 'glm-5.3 (coding flagship)', labelZh: 'glm-5.3（编程旗舰）' },
    { id: 'glm-5.2', label: 'glm-5.2 (coding plan, cost-efficient)', labelZh: 'glm-5.2（代码优选，高性价比）' },
    { id: 'glm-5.1', label: 'glm-5.1 (fast, light)', labelZh: 'glm-5.1（快速轻量）' },
];

const OPENAI_MODELS: ModelMeta[] = [
    { id: 'gpt-5-mini', label: 'gpt-5-mini (fast, efficient)', labelZh: 'gpt-5-mini（快速高效）', aliases: ['gpt', 'openai'] },
    { id: 'gpt-5.5', label: 'gpt-5.5 (balanced mid)', labelZh: 'gpt-5.5（均衡实用）', aliases: ['gpt-5.5'], detail: 'Current OpenAI mid-tier model. Uses your OpenAI API key.' },
    { id: 'gpt-5.6', label: 'gpt-5.6 (flagship heavy)', labelZh: 'gpt-5.6（旗舰，综合最强）', aliases: ['gpt-5.6'], detail: 'Current OpenAI flagship for the heaviest turns. Uses your OpenAI API key.' },
    { id: 'gpt-5', label: 'gpt-5 (previous flagship)', labelZh: 'gpt-5（上一代旗舰）', aliases: ['gpt-5'], detail: 'Previous-generation OpenAI flagship. Kept for compatibility; prefer gpt-5.5/5.6.' },
    { id: 'o4', label: 'o4 (legacy reasoning, heavy)', labelZh: 'o4（上一代推理旗舰）', aliases: ['o4'], detail: 'Legacy GPT-5 reasoning model. Available in the model selector; hidden from the dropdown.', featured: false },
];

const CLAUDE_MODELS: ModelMeta[] = [
    { id: 'claude-opus-4', label: 'claude-opus-4 (most capable)', labelZh: 'claude-opus-4（综合最强）', aliases: ['claude-opus', 'opus'], detail: 'Most capable Anthropic model for hardest reasoning. Uses your Anthropic API key.' },
    { id: 'claude-sonnet-4', label: 'claude-sonnet-4 (balanced, coding)', labelZh: 'claude-sonnet-4（均衡，编程强）', aliases: ['claude', 'claude-sonnet-4'] },
    { id: 'claude-haiku-4', label: 'claude-haiku-4 (fast, light)', labelZh: 'claude-haiku-4（快速轻量）', aliases: ['claude-haiku-4'] },
];

const OPENROUTER_MODELS: ModelMeta[] = [
    { id: 'Qwen/Qwen3-235B-A22B-fp8-tput', label: 'Qwen3-235B (routed)', labelZh: 'Qwen3-235B（路由）', aliases: ['openrouter'] },
    { id: 'tencent/hy3-preview', label: 'Tencent HY3 (routed)', labelZh: '腾讯 HY3（路由）', detail: 'Tencent Hunyuan 3 via OpenRouter. Uses your OpenRouter API key.' },
    { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 free (routed)', labelZh: 'DeepSeek R1 免费版（路由）', detail: 'Free DeepSeek R1 via OpenRouter. Rate-limited; uses your OpenRouter API key.' },
];

const DOUBAO_MODELS: ModelMeta[] = [
    { id: 'doubao-seed-evolving', label: 'Seed-Evolving (always latest, weekly updates)', labelZh: 'Seed-Evolving（持续更新，每周迭代）', aliases: ['doubao', 'seed-evolving'], detail: 'ByteDance flagship — auto-updates to the latest version weekly (not version-pinned; outputs may drift). Activate in Ark console (火山方舟) first. ¥6/M input, ¥30/M output.' },
    { id: 'doubao-seed-2-1-pro', label: 'Seed-2.1-pro (flagship, stable)', labelZh: 'Seed-2.1-pro（旗舰稳定版）', aliases: ['seed-pro', 'doubao-pro'], detail: 'Stable flagship snapshot. Best quality for hard reasoning tasks. Activate in Ark console first. ¥6/M input, ¥30/M output.' },
    { id: 'doubao-seed-2-1-turbo', label: 'Seed-2.1-turbo (fast, cost-efficient)', labelZh: 'Seed-2.1-turbo（速度快，性价比高）', aliases: ['seed-turbo', 'doubao-turbo'], detail: 'Faster, lower-cost version. Activate in Ark console first. ¥3/M input, ¥15/M output — excellent value (高性价比) for routine tasks.' },
    { id: 'doubao-seed-code', label: 'Seed-Code (coding-specialized, Coding Plan)', labelZh: 'Seed-Code（编程专精，编码计划）', aliases: ['doubao-code', 'seed-code'], detail: 'Coding-specialized Doubao model. ~256K context, optimized for agentic programming. Available via the Volcano Engine Coding Plan (编程计划) — same base URL and key as standard Doubao. Verify exact model ID via Discover Models.' },
];

const DOUBAO_REWARDS_MODELS: ModelMeta[] = [
    { id: 'ep-rewards-placeholder', label: 'Your Rewards endpoint ID (ep-xxx)', labelZh: '协作激励接入点 ID（ep-xxx）', aliases: ['doubao-rewards', 'rewards'], detail: 'Paste your Volcano Engine inference endpoint ID (ep-xxxxxxxx). Create it in the Ark console (火山方舟) after joining the Rewards Program (奖励计划). Uses the same ByteDance API key.' },
];

const DOUBAO_CODING_MODELS: ModelMeta[] = [
    { id: 'doubao-seed-2-1-pro', label: 'Seed-2.1-pro (flagship, newest)', labelZh: 'Seed-2.1-pro（旗舰稳定版，最新）', aliases: ['seed-pro', 'doubao-pro'], detail: 'Stable flagship snapshot. Best quality for hard reasoning tasks. Uses the Volcano Engine Coding Plan (编程计划) — subscription-based, same base URL and key as standard Doubao.' },
    { id: 'doubao-seed-code', label: 'Seed-Code (coding-specialized)', labelZh: 'Seed-Code（编程专精）', aliases: ['doubao-code', 'seed-code'], detail: 'Coding-specialized Doubao model (2.0 generation). ~256K context, optimized for agentic programming. Uses the Volcano Engine Coding Plan (编程计划) — subscription-based, same base URL and key as standard Doubao.' },
];

const STEPFUN_MODELS: ModelMeta[] = [
    { id: 'step-3.7-flash', label: 'step-3.7-flash (MoE, multimodal, agent/coding)', labelZh: 'step-3.7-flash（MoE，多模态，智能体/编程）', aliases: ['stepfun', 'step-flash'], detail: 'StepFun (阶跃星辰) flagship. 198B MoE architecture, 256K context, native image/video, tool calling, reasoning effort control. $0.20/M input, $1.15/M output. Verify exact model ID via Discover Models.' },
];

const BYTEPLUS_MODELS: ModelMeta[] = [
    { id: 'seed-2-0-pro-260328', label: 'Seed 2.0 Pro (flagship)', labelZh: 'Seed 2.0 Pro（旗舰）', aliases: ['seed-pro', 'byteplus-pro', 'doubao-pro'], detail: 'BytePlus ModelArk flagship (ap-southeast-1). Best quality for hard reasoning. USD billing.' },
    { id: 'seed-2-0-lite-260428', label: 'Seed 2.0 Lite (fast, balanced)', labelZh: 'Seed 2.0 Lite（快速均衡）', aliases: ['seed-lite', 'byteplus', 'doubao-turbo'], detail: 'Faster, lower-cost Seed model. Great for routine tasks. USD billing.' },
    { id: 'seed-2-0-mini-260428', label: 'Seed 2.0 Mini (lightest)', labelZh: 'Seed 2.0 Mini（最轻量）', aliases: ['seed-mini'], detail: 'Lightest/fastest Seed model for quick tasks. USD billing.' },
    { id: 'seed-2-0-code-preview-260328', label: 'Seed 2.0 Code (coding, preview)', labelZh: 'Seed 2.0 Code（编程，预览版）', aliases: ['seed-code', 'byteplus-code'], detail: 'Coding-specialized Seed model (preview). USD billing.' },
    { id: 'dola-seed-2-1-turbo-260628', label: 'Seed 2.1 Turbo (newest)', labelZh: 'Seed 2.1 Turbo（最新）', aliases: ['dola', 'seed-turbo'], detail: 'Newest Seed 2.1 Turbo model. USD billing.' },
];

const BYTEPLUS_CODING_MODELS: ModelMeta[] = [
    { id: 'seed-2-0-pro-260328', label: 'Seed 2.0 Pro (flagship)', labelZh: 'Seed 2.0 Pro（旗舰）', aliases: ['seed-pro', 'byteplus-pro'], detail: 'Stable flagship model. Best quality for hard reasoning. Uses the BytePlus Coding Plan (编程计划) — subscription-based, USD billing.' },
    { id: 'seed-2-0-code-preview-260328', label: 'Seed 2.0 Code (coding-specialized, preview)', labelZh: 'Seed 2.0 Code（编程专精，预览版）', aliases: ['seed-code', 'byteplus-code'], detail: 'Coding-specialized Seed model (preview). Uses the BytePlus Coding Plan (编程计划) — subscription-based, USD billing.' },
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
        displayNameZh: 'Kimi 编程版 — 专注编程任务',
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
        displayNameZh: 'Google Gemini — 多模态，海外服务',
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
        displayNameZh: '智谱编程计划 (Z.AI Coding Plan) — 编程专精，订阅制',
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
        id: 'doubao',
        displayName: 'Doubao / Volcengine (Mainland China)',
        displayNameZh: '豆包（字节跳动）— 性价比极高，国内生态',
        secretKey: 'harmony.bytedance.apiKey',
        models: DOUBAO_MODELS,
    },
    {
        id: 'doubao-coding',
        displayName: 'Doubao Coding Plan',
        displayNameZh: '豆包编程计划 (Coding Plan) — 编程专精，订阅制',
        secretKey: 'harmony.bytedance.apiKey',
        models: DOUBAO_CODING_MODELS,
    },
    {
        id: 'doubao-rewards',
        displayName: 'Doubao Rewards',
        displayNameZh: '豆包奖励计划 (Rewards) — 免费额度，需接入点 ID',
        secretKey: 'harmony.bytedance.apiKey',
        models: DOUBAO_REWARDS_MODELS,
    },
    {
        id: 'byteplus',
        displayName: 'BytePlus / Doubao (International)',
        displayNameZh: 'BytePlus 豆包 — 国际版，美元计费',
        secretKey: 'harmony.byteplus.apiKey',
        models: BYTEPLUS_MODELS,
    },
    {
        id: 'byteplus-coding',
        displayName: 'ByteDance Coding Plan (Intl)',
        displayNameZh: 'BytePlus 编程计划 — 国际版，编程专精',
        secretKey: 'harmony.byteplus.apiKey',
        models: BYTEPLUS_CODING_MODELS,
    },
    {
        id: 'stepfun',
        displayName: 'StepFun',
        displayNameZh: '阶跃星辰 (StepFun) — MoE 多模态，智能体/编程优化',
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

// ── Canonical DeepSeek Model (single source of truth) ───────────────
// The active DeepSeek model is stored in ONE place: the `harmony.deepseekModel`
// config setting. Previously, config and workspaceState (`harmony.primaryModel.deepseek`)
// could desync because different writers updated only one of the two stores,
// producing a chat label that disagreed with the sidebar dropdown. All read/write
// paths for the DeepSeek model now route through these two functions.

const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

/** Read the active DeepSeek model. Config is the single source of truth. */
export function getDeepSeekModel(): string {
    return vscode.workspace.getConfiguration('harmony').get<string>('deepseekModel') ?? DEEPSEEK_DEFAULT_MODEL;
}

/** Write the active DeepSeek model. Updates the authoritative config setting. */
export async function setDeepSeekModel(model: string): Promise<void> {
    await vscode.workspace.getConfiguration('harmony').update('deepseekModel', model, vscode.ConfigurationTarget.Global);
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
        // Sidebar dropdown shows current/featured models only (curated).
        // The model selector (buildQuickPickEntries) shows ALL models, old + new.
        result[provider.id] = provider.models
            .filter(m => m.featured !== false)
            .map(m => ({
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
    // Note: Some providers intentionally share model families (e.g., Moonshot &
    // KimiCode both offer k3; Zhipu & Zhipu-Coding both offer glm-5.x).
    // These are expected, so we only flag aliases where the provider is genuinely
    // different (not a coding-plan / rewards variant of the same company).
    const aliasMap = buildAliasMap();
    const aliasCounts: Record<string, number> = {};
    const aliasProviders: Record<string, Set<string>> = {};
    // Provider families that share models intentionally
    const providerFamily: Record<string, string> = {
        'moonshot': 'moonshot', 'kimiCode': 'moonshot',
        'zhipu': 'zhipu', 'zhipu-coding': 'zhipu',
        'doubao': 'bytedance', 'doubao-coding': 'bytedance', 'doubao-rewards': 'bytedance',
        'byteplus': 'bytedance', 'byteplus-coding': 'bytedance',
    };
    for (const provider of PROVIDER_REGISTRY) {
        for (const model of provider.models) {
            const allNames = [model.id, ...(model.aliases ?? [])];
            for (const name of allNames) {
                const family = providerFamily[provider.id] ?? provider.id;
                if (!aliasProviders[name]) aliasProviders[name] = new Set();
                aliasProviders[name].add(family);
            }
        }
    }
    for (const [alias, families] of Object.entries(aliasProviders)) {
        if (families.size > 1) {
            issues.push(`Alias "${alias}" is mapped by ${families.size} different provider families — CLI /model ambiguity`);
        }
    }

    return { ok: issues.length === 0, issues };
}
