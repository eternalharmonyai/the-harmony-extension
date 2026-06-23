import * as vscode from 'vscode';
import { recordUsage, recordFallbackEvent, evaluateProviderPolicy, recordProviderPolicyBlock } from './costTracker';
import { recordHealth, rankProviders, isHealthy } from './providerHealth';

/** Per-model maximum output tokens. Used to clamp user-configured token budget. */
const MODEL_MAX_TOKENS: Record<string, number> = {
    'deepseek-v4-pro': 384000,
    'deepseek-v4-flash': 32768,
    'deepseek-chat': 32768,
    'deepseek-reasoner': 32768,
    'gpt-4o': 16384,
    'gpt-4o-mini': 16384,
    'gpt-4-turbo': 4096,
    'gpt-3.5-turbo': 4096,
    'claude-3.5-sonnet': 8192,
    'claude-3-opus': 4096,
    'claude-3-haiku': 4096,
    'gemini-2.5-pro': 65536,
    'gemini-2.5-flash': 65536,
    'gemini-2.0-flash': 8192,
    'qwen-max': 8192,
    'qwen-plus': 8192,
    'qwen-turbo': 8192,
    'kimi-latest': 8192,
    'hunyuan-pro': 8192,
    'hunyuan-turbos': 32768,
    'glm-5.1': 131072,
    'glm-5.2': 131072,
    'glm-4-flash': 131072,
    'glm-4-plus': 131072,
};

/** Fallback model max tokens when model not in the map. */
const DEFAULT_MODEL_MAX_TOKENS = 32768;

/** Compute HTTP timeout from token budget: 30ms per token, floor 120s, ceiling 600s.
 *  Previously 200ms/token, which produced absurd timeouts (27 min for 8192 tokens).
 *  At ~50-100 tok/s generation speed, 4096 tokens ≈ 40-80s, so 30ms/token is generous. */
function computeTimeout(maxTokens: number): number {
    const floor = 120_000;  // 2 min
    const ceiling = 600_000; // 10 min
    const est = maxTokens * 30; // 30ms per token
    return Math.min(ceiling, Math.max(floor, est));
}

/** Fallback models for OpenRouter coding tier (free models, in order of preference). */
const CODING_FALLBACKS: string[] = [
    'tencent/hunyuan-turbos-latest',    // Tencent Hy3 preview (free this week!)
    'Qwen/Qwen3-235B-A22B-fp8-tput',  // Alibaba Qwen3 (free)
    'deepseek/deepseek-v4-flash',       // DeepSeek V4 Flash (your credits)
    'deepseek/deepseek-r1:free'         // Last resort free option
];

/** General fallback models for OpenRouter (free tier). */
const OPENROUTER_FREE_FALLBACKS: string[] = [
    'tencent/hunyuan-turbos-latest',
    'Qwen/Qwen3-235B-A22B-fp8-tput',
    'deepseek/deepseek-r1:free',
    'deepseek/deepseek-v4-flash'
];

/**
 * Multi-provider model router \u2014 standalone, no harmony-ui dependency.
 *
 * Each provider exposes tiered models so Harmony can pick the right tool:
 *   - light/flash: cheap, fast, routine queries
 *   - mid: balanced
 *   - heavy / "big guns": deep reasoning, hard problems
 *
 * Used primarily by the harmony_consult_model tool to get cross-model
 * second opinions from within the agent loop. The chat participant's
 * primary model (Copilot / DeepSeek) is configured separately.
 */

export type ProviderId = 'deepseek' | 'alibaba' | 'moonshot' | 'kimiCode' | 'gemini' | 'openrouter' | 'openai' | 'claude' | 'tencent' | 'zhipu';
export type Tier = 'light' | 'mid' | 'heavy' | 'coding';
export type CollabModelPreset = 'auto' | 'economy' | 'balanced' | 'power' | 'custom';
export type CollabDirectProvider = ProviderId | 'auto';
export type ProviderEndpointProfile = 'default' | 'international' | 'mainland' | 'us' | 'custom';

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const MOONSHOT_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const KIMICODE_DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';
const ALIBABA_INTERNATIONAL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const ALIBABA_MAINLAND_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const TENCENT_INTERNATIONAL_BASE_URL = 'https://api.hunyuan.cloud.tencent.com/v1';
const TENCENT_MAINLAND_BASE_URL = 'https://hunyuan.tencentcloudapi.com/v1';
const ZHIPU_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

export interface ProviderEndpointInfo {
    provider: Extract<ProviderId, 'deepseek' | 'alibaba' | 'moonshot' | 'kimiCode' | 'tencent' | 'zhipu'>;
    profile: ProviderEndpointProfile;
    label: string;
    baseUrl?: string;
    baseUrlSetting: string;
    needsCustomBaseUrl: boolean;
    detail: string;
}

export interface ProviderTierMap {
    light: string;
    mid: string;
    heavy: string;
    coding: string;
}

/** Default model names per provider/tier. User can override via settings. */
export const PROVIDER_DEFAULTS: Record<ProviderId, ProviderTierMap> = {
    deepseek: {
        light: 'deepseek-v4-flash',
        mid: 'deepseek-v4-flash',
        heavy: 'deepseek-v4-pro',
        coding: 'deepseek-v4-flash'
    },
    alibaba: {
        light: 'qwen3.6-flash',
        mid: 'qwen3.7-plus',
        heavy: 'qwen3.7-max',
        coding: 'qwen3-coder-plus'
    },
    moonshot: {
        light: 'kimi-k2.7',
        mid: 'kimi-k2.7-thinking',
        heavy: 'kimi-k2.7-code',
        coding: 'kimi-k2.7-code'
    },
    kimiCode: {
        light: 'kimi-k2.7',
        mid: 'kimi-k2.7-thinking',
        heavy: 'kimi-k2.7-code',
        coding: 'kimi-k2.7-code'
    },
    tencent: {
        light: 'hunyuan-lite',
        mid: 'hunyuan-turbos-latest',
        heavy: 'hunyuan-pro',
        coding: 'hunyuan-turbos-latest'
    },
    gemini: {
        light: 'gemini-3.1-flash-lite',
        mid: 'gemini-3.5-flash',
        heavy: 'gemini-3.1-pro-preview',
        coding: 'gemini-3.5-flash'
    },
    openrouter: {
        light: 'tencent/hunyuan-turbos-latest',
        mid: 'Qwen/Qwen3-235B-A22B-fp8-tput',
        heavy: 'deepseek/deepseek-r1:free',
        coding: 'tencent/hunyuan-turbos-latest'
    },
    openai: {
        light: 'gpt-5-mini',
        mid: 'gpt-5',
        heavy: 'o4',
        coding: 'gpt-5-mini'
    },
    claude: {
        light: 'claude-haiku-4',
        mid: 'claude-sonnet-4',
        heavy: 'claude-opus-4',
        coding: 'claude-sonnet-4'
    },
    zhipu: {
        light: 'glm-5.1',
        mid: 'glm-5.2',
        heavy: 'glm-5.2',
        coding: 'glm-5.2'
    }
};

const SECRET_KEY: Record<ProviderId, string> = {
    deepseek: 'harmony.deepseekApiKey',
    alibaba: 'harmony.alibaba.apiKey',
    moonshot: 'harmony.moonshot.apiKey',
    kimiCode: 'harmony.kimiCode.apiKey',
    gemini: 'harmony.geminiApiKey',
    openrouter: 'harmony.openrouter.apiKey',
    openai: 'harmony.openaiApiKey',
    claude: 'harmony.claudeApiKey',
    tencent: 'harmony.tencent.apiKey',
    zhipu: 'harmony.zhipu.apiKey'
};

export const PROVIDER_IDS: ProviderId[] = ['deepseek', 'alibaba', 'tencent', 'moonshot', 'kimiCode', 'gemini', 'openrouter', 'openai', 'claude', 'zhipu'];
const FREE_QUOTA_PROVIDER_IDS: ProviderId[] = ['gemini', 'deepseek', 'alibaba', 'moonshot', 'kimiCode', 'openrouter', 'openai', 'claude'];

export function isProviderId(value: string | undefined): value is ProviderId {
    return !!value && (PROVIDER_IDS as string[]).includes(value);
}

export function providerDisplayName(provider: CollabDirectProvider): string {
    switch (provider) {
        case 'auto': return 'Auto';
        case 'deepseek': return 'DeepSeek';
        case 'alibaba': return 'Alibaba / Qwen';
        case 'moonshot': return 'Moonshot / Kimi';
        case 'kimiCode': return 'KimiCode';
        case 'gemini': return 'Gemini';
        case 'openrouter': return 'OpenRouter';
        case 'openai': return 'OpenAI';
        case 'claude': return 'Anthropic (Claude models)';
        case 'tencent': return 'Tencent / Hunyuan';
        case 'zhipu': return 'Zhipu (Z.AI / GLM)';
    }
}

function explicitConfigString(key: string): { value: string; explicit: boolean } {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const inspected = cfg.inspect<string>(key);
    const value = (cfg.get<string>(key) ?? '').trim();
    return {
        value,
        explicit: inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined
    };
}

function configuredEndpointProfile(key: string, fallback: ProviderEndpointProfile, allowed: ProviderEndpointProfile[]): ProviderEndpointProfile {
    const raw = vscode.workspace.getConfiguration('harmony').get<string>(key);
    return raw && allowed.includes(raw as ProviderEndpointProfile) ? raw as ProviderEndpointProfile : fallback;
}

export function providerEndpointInfo(provider: Extract<ProviderId, 'deepseek' | 'alibaba' | 'moonshot' | 'kimiCode' | 'tencent' | 'zhipu'>): ProviderEndpointInfo {
    if (provider === 'deepseek') {
        const profile = configuredEndpointProfile('deepseek.endpointProfile', 'default', ['default', 'custom']);
        const custom = explicitConfigString('deepseekBaseUrl');
        const baseUrl = profile === 'custom' && custom.value ? custom.value : DEEPSEEK_DEFAULT_BASE_URL;
        return {
            provider,
            profile,
            label: profile === 'custom' ? 'DeepSeek custom endpoint' : 'DeepSeek default endpoint',
            baseUrl: baseUrl.replace(/\/$/, ''),
            baseUrlSetting: 'harmony.deepseekBaseUrl',
            needsCustomBaseUrl: false,
            detail: profile === 'custom' ? 'Uses harmony.deepseekBaseUrl.' : 'Uses the standard DeepSeek OpenAI-compatible endpoint.'
        };
    }
    if (provider === 'moonshot') {
        const profile = configuredEndpointProfile('moonshot.endpointProfile', 'default', ['default', 'custom']);
        const custom = explicitConfigString('moonshot.baseUrl');
        const baseUrl = profile === 'custom' && custom.value ? custom.value : MOONSHOT_DEFAULT_BASE_URL;
        return {
            provider,
            profile,
            label: profile === 'custom' ? 'Moonshot custom endpoint' : 'Moonshot default endpoint',
            baseUrl: baseUrl.replace(/\/$/, ''),
            baseUrlSetting: 'harmony.moonshot.baseUrl',
            needsCustomBaseUrl: false,
            detail: profile === 'custom' ? 'Uses harmony.moonshot.baseUrl.' : 'Uses the standard Moonshot/Kimi OpenAI-compatible endpoint.'
        };
    }
    if (provider === 'kimiCode') {
        const profile = configuredEndpointProfile('kimiCode.endpointProfile', 'default', ['default', 'custom']);
        const custom = explicitConfigString('kimiCode.baseUrl');
        const baseUrl = profile === 'custom' && custom.value ? custom.value : KIMICODE_DEFAULT_BASE_URL;
        return {
            provider,
            profile,
            label: profile === 'custom' ? 'KimiCode custom endpoint' : 'KimiCode default endpoint',
            baseUrl: baseUrl.replace(/\/$/, ''),
            baseUrlSetting: 'harmony.kimiCode.baseUrl',
            needsCustomBaseUrl: false,
            detail: profile === 'custom' ? 'Uses harmony.kimiCode.baseUrl.' : 'Uses the standard KimiCode OpenAI-compatible endpoint (api.moonshot.cn).'
        };
    }
    const profile = configuredEndpointProfile('alibaba.endpointProfile', 'international', ['international', 'mainland', 'us', 'custom']);
    const custom = explicitConfigString('alibaba.baseUrl');
    if (profile === 'mainland') {
        return {
            provider,
            profile,
            label: 'Alibaba mainland China endpoint',
            baseUrl: ALIBABA_MAINLAND_BASE_URL,
            baseUrlSetting: 'harmony.alibaba.baseUrl',
            needsCustomBaseUrl: false,
            detail: 'Uses the mainland China DashScope endpoint. This is the Beijing/China account route; international keys commonly return 401 here.'
        };
    }
    if (profile === 'custom') {
        const baseUrl = custom.value || ALIBABA_INTERNATIONAL_BASE_URL;
        return {
            provider,
            profile,
            label: 'Alibaba custom endpoint',
            baseUrl: baseUrl.replace(/\/$/, ''),
            baseUrlSetting: 'harmony.alibaba.baseUrl',
            needsCustomBaseUrl: false,
            detail: 'Uses harmony.alibaba.baseUrl exactly, for provider-issued regional endpoints.'
        };
    }
    if (profile === 'us') {
        const hasCustomBaseUrl = custom.explicit && Boolean(custom.value);
        const baseUrl = hasCustomBaseUrl ? custom.value.replace(/\/$/, '') : ALIBABA_INTERNATIONAL_BASE_URL;
        return {
            provider,
            profile,
            label: 'Alibaba US/Virginia endpoint',
            baseUrl,
            baseUrlSetting: 'harmony.alibaba.baseUrl',
            needsCustomBaseUrl: false,
            detail: hasCustomBaseUrl
                ? 'Uses the configured US/Virginia base URL override for this account.'
                : 'Uses the Alibaba international OpenAI-compatible endpoint for US/Virginia keys unless the account is issued a different regional base URL.'
        };
    }
    return {
        provider,
        profile,
        label: 'Alibaba international endpoint',
        baseUrl: ALIBABA_INTERNATIONAL_BASE_URL,
        baseUrlSetting: 'harmony.alibaba.baseUrl',
        needsCustomBaseUrl: false,
        detail: 'Uses the international DashScope endpoint. This is the Singapore/global route that passed the recent live smoke.'
    };
    // --- Tencent / Hunyuan ---
    if (provider === 'tencent') {
        const profile = configuredEndpointProfile('tencent.endpointProfile', 'international', ['international', 'mainland', 'custom']);
        const custom = explicitConfigString('tencent.baseUrl');
        if (profile === 'mainland') {
            return {
                provider,
                profile,
                label: 'Tencent mainland China endpoint',
                baseUrl: TENCENT_MAINLAND_BASE_URL,
                baseUrlSetting: 'harmony.tencent.baseUrl',
                needsCustomBaseUrl: false,
                detail: 'Uses the mainland China Hunyuan endpoint. This is the Beijing/China account route; international keys commonly return 401 here.'
            };
        }
        if (profile === 'custom') {
            const baseUrl = custom.value || TENCENT_INTERNATIONAL_BASE_URL;
            return {
                provider,
                profile,
                label: 'Tencent custom endpoint',
                baseUrl: baseUrl.replace(/\/$/, ''),
                baseUrlSetting: 'harmony.tencent.baseUrl',
                needsCustomBaseUrl: false,
                detail: 'Uses harmony.tencent.baseUrl exactly, for provider-issued regional endpoints.'
            };
        }
        return {
            provider,
            profile,
            label: 'Tencent international endpoint',
            baseUrl: TENCENT_INTERNATIONAL_BASE_URL,
            baseUrlSetting: 'harmony.tencent.baseUrl',
            needsCustomBaseUrl: false,
            detail: 'Uses the international Hunyuan OpenAI-compatible endpoint. Accessible globally; uses Tencent Cloud API key authentication.'
        };
    }
    // --- Zhipu (Z.AI / GLM) ---
    if (provider === 'zhipu') {
        const profile = configuredEndpointProfile('zhipu.endpointProfile', 'default', ['default', 'custom']);
        const custom = explicitConfigString('zhipu.baseUrl');
        const baseUrl = profile === 'custom' && custom.value ? custom.value : ZHIPU_DEFAULT_BASE_URL;
        return {
            provider,
            profile,
            label: profile === 'custom' ? 'Zhipu custom endpoint' : 'Zhipu default endpoint',
            baseUrl: baseUrl.replace(/\/$/, ''),
            baseUrlSetting: 'harmony.zhipu.baseUrl',
            needsCustomBaseUrl: false,
            detail: profile === 'custom' ? 'Uses harmony.zhipu.baseUrl.' : 'Uses the standard Zhipu (Z.AI) OpenAI-compatible endpoint.'
        };
    }
    throw new Error(`Unsupported endpoint provider: ${provider}`);
}

export function providerBaseUrlForCall(provider: Extract<ProviderId, 'deepseek' | 'alibaba' | 'moonshot' | 'kimiCode' | 'tencent' | 'zhipu'>): string {
    const endpoint = providerEndpointInfo(provider);
    if (!endpoint.baseUrl) {
        throw new Error(`${providerDisplayName(provider)} endpoint profile "${endpoint.profile}" needs a custom base URL. Set ${endpoint.baseUrlSetting} to the provider-issued regional URL.`);
    }
    return endpoint.baseUrl;
}

export function collabTierForPreset(preset: CollabModelPreset): Tier {
    switch (preset) {
        case 'economy': return 'light';
        case 'power': return 'heavy';
        case 'custom': {
            const raw = vscode.workspace.getConfiguration('harmony').get<string>('collabDirectTier');
            return raw === 'light' || raw === 'mid' || raw === 'heavy' || raw === 'coding' ? raw : 'coding';
        }
        case 'balanced':
        case 'auto':
        default:
            return 'coding';
    }
}

export function getCollabModelPreset(): CollabModelPreset {
    const raw = vscode.workspace.getConfiguration('harmony').get<string>('collabModelPreset');
    if (raw === 'auto' || raw === 'economy' || raw === 'balanced' || raw === 'power' || raw === 'custom') return raw;
    return 'auto';
}

export function getCollabDirectProvider(): CollabDirectProvider {
    const raw = vscode.workspace.getConfiguration('harmony').get<string>('collabDirectProvider');
    if (raw === 'auto' || isProviderId(raw)) return raw;
    return 'auto';
}

function collabProviderOrder(preferred: CollabDirectProvider, preset: CollabModelPreset): ProviderId[] {
    if (preferred !== 'auto') return [preferred];
    const useGeminiFreeQuota = vscode.workspace.getConfiguration('harmony').get<boolean>('gemini.useFreeQuota') === true;
    if (useGeminiFreeQuota) return FREE_QUOTA_PROVIDER_IDS;
    return PROVIDER_IDS;
}

export async function resolveCollabModel(secrets: vscode.SecretStorage): Promise<{ provider: ProviderId; tier: Tier; model: string; preset: CollabModelPreset } | undefined> {
    const preset = getCollabModelPreset();
    const tier = collabTierForPreset(preset);
    const preferred = getCollabDirectProvider();
    for (const provider of collabProviderOrder(preferred, preset)) {
        if (await hasKey(secrets, provider)) {
            return { provider, tier, model: modelFor(provider, tier), preset };
        }
    }
    return undefined;
}

export function secretKeyFor(provider: ProviderId): string {
    return SECRET_KEY[provider];
}

export function modelFor(provider: ProviderId, tier: Tier): string {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const override = cfg.get<string>(`providers.${provider}.${tier}`);
    if (override && override.trim()) return override.trim();
    return PROVIDER_DEFAULTS[provider][tier];
}

// ── Provider key caching ─────────────────────────────────────────────────
// OS keychain reads (especially on Windows) are expensive (~50-200ms each).
// Cache results for 30s to prevent re-reading keys on every sidebar refresh.
const keyCache = new Map<string, { value: boolean; ts: number }>();
const KEY_CACHE_TTL_MS = 30_000;

export async function hasKey(secrets: vscode.SecretStorage, provider: ProviderId): Promise<boolean> {
    const cached = keyCache.get(provider);
    if (cached && Date.now() - cached.ts < KEY_CACHE_TTL_MS) {
        return cached.value;
    }
    const k = await secrets.get(SECRET_KEY[provider]);
    const value = !!k;
    keyCache.set(provider, { value, ts: Date.now() });
    return value;
}

/** Invalidate the key cache (call after user sets/changes a provider key). */
export function invalidateKeyCache(provider?: ProviderId): void {
    if (provider) {
        keyCache.delete(provider);
    } else {
        keyCache.clear();
    }
}

export async function listAvailableProviders(secrets: vscode.SecretStorage): Promise<ProviderId[]> {
    const out: ProviderId[] = [];
    for (const p of PROVIDER_IDS) if (await hasKey(secrets, p)) out.push(p);
    return out;
}

export interface ConsultRequest {
    provider: ProviderId;
    tier: Tier;
    question: string;
    /** Optional system message / preamble. */
    system?: string;
    /** Hard cap on output tokens. */
    maxTokens?: number;
}

export interface ConsultResponse {
    provider: ProviderId;
    model: string;
    text: string;
    /** Optional usage info if the provider returned it. */
    usage?: { promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number };
    /** Total provider wait time for this consult call. */
    durationMs?: number;
}

/**
 * One-shot non-streaming completion against any configured provider.
 * Used by harmony_consult_model. Throws on missing key or HTTP error.
 */
export async function consult(
    secrets: vscode.SecretStorage,
    req: ConsultRequest,
    token: vscode.CancellationToken
): Promise<ConsultResponse> {
    const tier = req.tier;
    const model = modelFor(req.provider, tier);
    const policy = evaluateProviderPolicy(req.provider, tier, model, { includeModelFilters: req.provider !== 'openrouter' });
    if (!policy.allowed) {
        const reason = policy.reason ?? 'Provider policy blocked this call.';
        recordProviderPolicyBlock(req.provider, tier, model, reason);
        throw new Error(`Provider policy blocked ${req.provider}/${tier}/${model}: ${reason}`);
    }
    const apiKey = await secrets.get(SECRET_KEY[req.provider]);
    if (!apiKey) {
        throw new Error(
            `No API key for ${req.provider}. Run "Harmony: Set ${capitalize(req.provider)} API Key" from the Command Palette.`
        );
    }
    
    const system = req.system ?? 'You are a helpful assistant. Be concise and direct.';
    // Read user-configured token budget from workspace state, fall back to req.maxTokens or 32768
    const cfg = vscode.workspace.getConfiguration('harmony');
    const userBudget = cfg.get<number>('tokenBudget') ?? req.maxTokens ?? 32768;
    // Clamp to model's max output
    const modelMax = MODEL_MAX_TOKENS[model] ?? DEFAULT_MODEL_MAX_TOKENS;
    const maxTokens = Math.min(userBudget, modelMax);

    let result: ConsultResponse = { provider: req.provider, model: model, text: '', usage: undefined };
    const startedAt = Date.now();
    
    const attemptCall = async (provider: ProviderId, fallbackModel?: string): Promise<ConsultResponse> => {
        const pKey = await secrets.get(SECRET_KEY[provider]);
        if (!pKey) throw new Error(`No API key for ${provider}. Run "Harmony: Set ${capitalize(provider)} API Key" from the Command Palette.`);
        const pModel = fallbackModel ?? modelFor(provider, tier);
        const pPolicy = evaluateProviderPolicy(provider, tier, pModel, { includeModelFilters: provider !== 'openrouter' });
        if (!pPolicy.allowed) {
            const reason = pPolicy.reason ?? 'Provider policy blocked this call.';
            recordProviderPolicyBlock(provider, tier, pModel, reason);
            throw new Error(`Provider policy blocked ${provider}/${tier}/${pModel}: ${reason}`);
        }
        const t0 = Date.now();
        switch (provider) {
            case 'openai':
                return await openaiCompat(pKey, 'https://api.openai.com/v1', pModel, system, req.question, maxTokens, token, 'openai');
            case 'deepseek': {
                const baseUrl = providerBaseUrlForCall('deepseek');
                return await openaiCompat(pKey, baseUrl, pModel, system, req.question, maxTokens, token, 'deepseek');
            }
            case 'claude':
                return await anthropicCall(pKey, pModel, system, req.question, maxTokens, token);
            case 'gemini':
                return await geminiCall(pKey, pModel, system, req.question, maxTokens, token);
            case 'openrouter': {
                const cfg2 = vscode.workspace.getConfiguration('harmony');
                const baseUrl = (cfg2.get<string>('openrouter.baseUrl') ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
                const fallbacks = tier === 'coding' ? CODING_FALLBACKS : OPENROUTER_FREE_FALLBACKS;
                let lastError: any = null;
                for (const tryModel of Array.from(new Set([pModel, ...fallbacks]))) {
                    const cp = evaluateProviderPolicy(provider, tier, tryModel);
                    if (!cp.allowed) { recordProviderPolicyBlock(provider, tier, tryModel, cp.reason ?? 'policy'); continue; }
                    try {
                        const r = await openaiCompat(pKey, baseUrl, tryModel, system, req.question, maxTokens, token, 'openrouter');
                        if (tryModel !== pModel) recordFallbackEvent(provider, pModel, tryModel, 'model fallback');
                        return r;
                    } catch (e) { lastError = e; }
                }
                throw lastError ?? new Error('OpenRouter: all models failed');
            }
            case 'moonshot': {
                const baseUrl = providerBaseUrlForCall('moonshot');
                return await openaiCompat(pKey, baseUrl, pModel, system, req.question, maxTokens, token, 'moonshot', 1.0);
            }
            case 'kimiCode': {
                const baseUrl = providerBaseUrlForCall('kimiCode');
                return await openaiCompat(pKey, baseUrl, pModel, system, req.question, maxTokens, token, 'kimiCode', 1.0);
            }
            case 'alibaba': {
                const baseUrl = providerBaseUrlForCall('alibaba');
                return await openaiCompat(pKey, baseUrl, pModel, system, req.question, maxTokens, token, 'alibaba');
            }
            case 'tencent': {
                const baseUrl = providerBaseUrlForCall('tencent');
                return await openaiCompat(pKey, baseUrl, pModel, system, req.question, maxTokens, token, 'tencent');
            }
            case 'zhipu': {
                const baseUrl = providerBaseUrlForCall('zhipu');
                return await openaiCompat(pKey, baseUrl, pModel, system, req.question, maxTokens, token, 'zhipu');
            }
            default:
                throw new Error(`Unsupported provider: ${provider}`);
        }
    };
    
    try {
        result = await attemptCall(req.provider);
        recordHealth({ ts: Date.now(), provider: req.provider, tier, success: true, latencyMs: Date.now() - startedAt });
    } catch (firstError: any) {
        recordHealth({ ts: Date.now(), provider: req.provider, tier, success: false, latencyMs: Date.now() - startedAt });
        // Try provider-level fallback: rank alternatives by health, try each
        const fallbackProviders = await rankProviders(secrets, tier, [req.provider]);
        let lastError = firstError;
        for (const fb of fallbackProviders) {
            // Skip if the original provider already tried this one (e.g. openrouter fallback)
            if (fb === req.provider) continue;
            try {
                const fbModel = modelFor(fb, tier);
                result = await attemptCall(fb, fbModel);
                recordHealth({ ts: Date.now(), provider: fb, tier, success: true });
                recordFallbackEvent(req.provider, model, `${fb}/${fbModel}`, 'provider fallback');
                break;
            } catch (e: any) {
                recordHealth({ ts: Date.now(), provider: fb, tier, success: false });
                lastError = e;
            }
        }
        if (!result.text && lastError) throw lastError;
    }
    
    result.durationMs = Date.now() - startedAt;
    
    recordUsage({
        timestamp: new Date().toISOString(),
        provider: req.provider,
        tier: req.tier,
        model: result.model,
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
        cachedPromptTokens: result.usage?.cachedPromptTokens,
        durationMs: result.durationMs
    });
    return result;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** OpenAI-compatible /chat/completions endpoint (used by OpenAI + DeepSeek).
 *
 * Uses SSE streaming (stream:true) to avoid HTTP timeouts on long outputs
 * and detect thinking/reasoning token consumption. 300s timeout per Google AI Mode.
 */
async function openaiCompat(
    apiKey: string,
    baseUrl: string,
    model: string,
    system: string,
    question: string,
    maxTokens: number,
    token: vscode.CancellationToken,
    provider: ProviderId,
    temperature?: number
): Promise<ConsultResponse> {
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    // Dynamic timeout — scales with token budget (200ms/token, floor 300s)
    const timeoutMs = computeTimeout(maxTokens);
    const timeoutId = setTimeout(() => controller.abort(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    try {
        const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
        const body: any = {
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: question }
            ],
            max_tokens: maxTokens,
            temperature: temperature ?? 0.3,
            stream: true
        };
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        if (!r.ok) {
            const errText = await r.text();
            throw new Error(`${provider} HTTP ${r.status}: ${errText.slice(0, 1200)}`);
        }
        // Parse SSE stream — accumulate delta chunks into full response
        const rawStream = await r.text();
        const lines = rawStream.split('\n');
        let content = '';
        let usage: any = undefined;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
                const chunk = JSON.parse(data);
                const delta = chunk?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') content += delta;
                if (chunk?.usage) usage = chunk.usage;
                // DeepSeek reasoning_content (thinking tokens)
                const reasoning = chunk?.choices?.[0]?.delta?.reasoning_content;
                if (typeof reasoning === 'string') {
                    console.log(`[Harmony] ${provider} reasoning consumed: ${reasoning.length} chars`);
                }
            } catch { /* skip malformed SSE chunks */ }
        }
        // DeepSeek cache header
        const cachedPromptTokens = parseInt(r.headers.get('x-ds-usage-cached-tokens') ?? '0', 10) || undefined;
        // Thinking-token detection: compare completion_tokens vs visible text
        if (usage?.completion_tokens && content.length > 0) {
            const estimatedVisible = content.length / 4;
            const ratio = estimatedVisible / usage.completion_tokens;
            if (ratio < 0.5) {
                console.log(`[Harmony] ⚠️ ${provider} thinking-token alert: ~${(ratio * 100).toFixed(0)}% of ${usage.completion_tokens} completion tokens visible (${content.length} chars). Consider raising max_tokens.`);
            }
        }
        return {
            provider,
            model,
            text: content,
            usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, cachedPromptTokens } : undefined
        };
    } finally {
        clearTimeout(timeoutId);
        sub.dispose();
    }
}

/** Anthropic /v1/messages endpoint.
 *
 * Extended thinking is DISABLED by default (harmony.claude.enableThinking = false).
 * When enabled it fires at a separate per-token rate on top of normal output tokens,
 * which is what causes $10–20 charges on a single Opus call.
 * Enable via setting + budget cap; the caller must show a cost warning before enabling.
 */
async function anthropicCall(
    apiKey: string,
    model: string,
    system: string,
    question: string,
    maxTokens: number,
    token: vscode.CancellationToken
): Promise<ConsultResponse> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const thinkingEnabled = cfg.get<boolean>('claude.enableThinking') ?? false;
    const thinkingBudget = Math.max(1000, Math.min(32000, cfg.get<number>('claude.thinkingBudgetTokens') ?? 4000));

    // Build thinking param: always explicit so Anthropic never auto-enables it.
    const thinkingParam = thinkingEnabled
        ? { type: 'enabled' as const, budget_tokens: thinkingBudget }
        : { type: 'disabled' as const };

    // When thinking is enabled the min max_tokens must exceed budget_tokens.
    const effectiveMaxTokens = thinkingEnabled ? Math.max(maxTokens, thinkingBudget + 1024) : maxTokens;

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(new Error(`Claude request timed out after ${Math.round(computeTimeout(effectiveMaxTokens) / 1000)}s`)), computeTimeout(effectiveMaxTokens));
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model,
                system,
                max_tokens: effectiveMaxTokens,
                thinking: thinkingParam,
                messages: [{ role: 'user', content: question }]
            }),
            signal: controller.signal as any
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`claude HTTP ${r.status}: ${text.slice(0, 1200)}`);
        const json = JSON.parse(text);
        // Content may include thinking blocks; extract only text blocks for the response.
        const content = Array.isArray(json?.content)
            ? json.content
                .filter((p: any) => p?.type === 'text' && typeof p?.text === 'string')
                .map((p: any) => p.text as string)
                .join('\n')
            : '';
        const usage = json?.usage;
        // cache_read/cache_creation tokens included in input_tokens; output includes thinking tokens.
        return {
            provider: 'claude',
            model,
            text: content,
            usage: usage ? {
                promptTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
                completionTokens: usage.output_tokens ?? 0
            } : undefined
        };
    } finally {
        clearTimeout(timeoutId);
        sub.dispose();
    }
}

/** Google Generative Language API (Gemini). */
async function geminiCall(
    apiKey: string,
    model: string,
    system: string,
    question: string,
    maxTokens: number,
    token: vscode.CancellationToken
): Promise<ConsultResponse> {
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    const timeoutId = setTimeout(() => controller.abort(new Error(`Gemini request timed out after ${Math.round(computeTimeout(maxTokens) / 1000)}s`)), computeTimeout(maxTokens));
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: question }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 }
        };
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`gemini HTTP ${r.status}: ${text.slice(0, 1200)}`);
        const json = JSON.parse(text);
        const parts = json?.candidates?.[0]?.content?.parts ?? [];
        const content = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
        const usage = json?.usageMetadata;
        // Thinking-token detection for Gemini
        if (usage?.candidatesTokenCount && content.length > 0) {
            const estimatedVisible = content.length / 4;
            const ratio = estimatedVisible / usage.candidatesTokenCount;
            if (ratio < 0.5) {
                console.log(`[Harmony] ⚠️ gemini thinking-token alert: ~${(ratio * 100).toFixed(0)}% of ${usage.candidatesTokenCount} output tokens visible (${content.length} chars).`);
            }
        }
        return {
            provider: 'gemini',
            model,
            text: content,
            usage: usage ? { promptTokens: usage.promptTokenCount, completionTokens: usage.candidatesTokenCount } : undefined
        };
    } finally {
        clearTimeout(timeoutId);
        sub.dispose();
    }
}

function isPremiumModelName(model: string): boolean {
    return /(^|[-_.])pro($|[-_.])|(^|[-_.])opus($|[-_.])|(^|[-_.])o4($|[-_.])/i.test(model);
}

export async function confirmPremiumModel(provider: ProviderId, tier: Tier, model: string, purpose = 'helper model call'): Promise<boolean> {
    const guarded = tier === 'heavy' || isPremiumModelName(model);
    if (!guarded) return true;
    const cfg = vscode.workspace.getConfiguration('harmony');
    
    // Legacy migration check
    let mode = cfg.get<string>('bigGunsMode');
    if (!mode) {
        mode = cfg.get<boolean>('bigGunsAutoApprove') ? 'all' : 'off';
    }

    if (mode === 'all') return true;
    if (mode === 'deepseek-only' && provider === 'deepseek') return true;

    const kind = tier === 'heavy' ? 'the heavy tier' : 'a premium model';
    const choice = await vscode.window.showWarningMessage(
        `Harmony wants to call ${kind} for ${purpose} on ${provider} (${model}, tier: ${tier}). This may cost more. Allow?`,
        { modal: false },
        'Allow once', 'Always allow this provider', 'Deny'
    );
    if (choice === 'Always allow this provider') {
        const newMode = (mode === 'off' && provider === 'deepseek') ? 'deepseek-only' : 'all';
        await cfg.update('bigGunsMode', newMode, true);
        return true;
    }
    return choice === 'Allow once';
}

/** Confirm cost guard for heavy or premium helper models when bigGunsMode is OFF. */
export async function confirmHeavyTier(provider: ProviderId, tier: Tier): Promise<boolean> {
    return confirmPremiumModel(provider, tier, modelFor(provider, tier));
}

/**
 * Live-discover models available on the user's API key for a given provider.
 * Returns an array of model id strings. Throws on missing key / HTTP error.
 *
 * Endpoints used:
 *   - openai/deepseek: GET /v1/models  (OpenAI-compatible)
 *   - claude:          GET /v1/models  (Anthropic)
 *   - gemini:          GET /v1beta/models?key=...
 */
export async function discoverModels(
    secrets: vscode.SecretStorage,
    provider: ProviderId,
    token: vscode.CancellationToken
): Promise<string[]> {
    const apiKey = await secrets.get(secretKeyFor(provider));
    if (!apiKey) throw new Error(`No API key for ${provider}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        let url: string;
        const headers: Record<string, string> = {};
        switch (provider) {
            case 'openai':
                url = 'https://api.openai.com/v1/models';
                headers['Authorization'] = `Bearer ${apiKey}`;
                break;
            case 'deepseek': {
                const cfg = vscode.workspace.getConfiguration('harmony');
                const baseUrl = (cfg.get<string>('deepseekBaseUrl') ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
                url = `${baseUrl}/models`;
                headers['Authorization'] = `Bearer ${apiKey}`;
                break;
            }
            case 'claude':
                url = 'https://api.anthropic.com/v1/models';
                headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
                break;
            case 'gemini':
                url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
                break;
            case 'openrouter': {
                const cfg = vscode.workspace.getConfiguration('harmony');
                const baseUrl = (cfg.get<string>('openrouter.baseUrl') ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
                url = `${baseUrl}/models`;
                headers['Authorization'] = `Bearer ${apiKey}`;
                break;
            }
            case 'moonshot': {
                const cfg = vscode.workspace.getConfiguration('harmony');
                const baseUrl = (cfg.get<string>('moonshot.baseUrl') ?? 'https://api.moonshot.ai/v1').replace(/\/$/, '');
                url = `${baseUrl}/models`;
                headers['Authorization'] = `Bearer ${apiKey}`;
                break;
            }
            case 'kimiCode': {
                // kimiCode uses the same Moonshot.cn endpoint — `/models` may not be
                // supported with all key types.  Gracefully fall back to a curated list.
                try {
                    const cfg = vscode.workspace.getConfiguration('harmony');
                    const baseUrl = (cfg.get<string>('kimiCode.baseUrl') ?? KIMICODE_DEFAULT_BASE_URL).replace(/\/$/, '');
                    const r2 = await fetch(`${baseUrl}/models`, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                        signal: controller.signal as any
                    });
                    if (r2.ok) {
                        const json2 = JSON.parse(await r2.text());
                        const items2: any[] = json2?.data ?? json2?.models ?? [];
                        return Array.from(new Set(items2.map((m: any) => {
                            const raw = m?.id ?? m?.name ?? '';
                            return typeof raw === 'string' ? raw.replace(/^models\//, '') : '';
                        }).filter(Boolean))).sort();
                    }
                } catch { /* fall through to curated list */ }
                // Return curated list of known kimiCode models
                return [
                    'kimi-k2-thinking-turbo',
                    'kimi-k2-instruct',
                    'kimi-k2-instruct-0905'
                ];
            }
            case 'alibaba': {
                const cfg = vscode.workspace.getConfiguration('harmony');
                const baseUrl = (cfg.get<string>('alibaba.baseUrl') ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
                url = `${baseUrl}/models`;
                headers['Authorization'] = `Bearer ${apiKey}`;
                break;
            }
            case 'tencent': {
                const cfg = vscode.workspace.getConfiguration('harmony');
                const baseUrl = (cfg.get<string>('tencent.baseUrl') ?? 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/$/, '');
                url = `${baseUrl}/models`;
                headers['Authorization'] = `Bearer ${apiKey}`;
                break;
            }
            case 'zhipu': {
                const cfg = vscode.workspace.getConfiguration('harmony');
                const baseUrl = (cfg.get<string>('zhipu.baseUrl') ?? ZHIPU_DEFAULT_BASE_URL).replace(/\/$/, '');
                url = `${baseUrl}/models`;
                headers['Authorization'] = `Bearer ${apiKey}`;
                break;
            }
        }
        const r = await fetch(url, { method: 'GET', headers, signal: controller.signal as any });
        const text = await r.text();
        if (!r.ok) throw new Error(`${provider} HTTP ${r.status}: ${text.slice(0, 600)}`);
        const json = JSON.parse(text);
        // OpenAI/DeepSeek/Claude all wrap as { data: [{id|name}, ...] }; Gemini as { models: [{name}, ...] }
        const items: any[] = json?.data ?? json?.models ?? [];
        const ids = items.map((m: any) => {
            if (typeof m === 'string') return m;
            const raw = m?.id ?? m?.name ?? '';
            // Gemini returns "models/gemini-3-pro" \u2014 strip the prefix.
            return typeof raw === 'string' ? raw.replace(/^models\//, '') : '';
        }).filter(Boolean);
        return Array.from(new Set(ids)).sort();
    } finally {
        clearTimeout(timer);
        sub.dispose();
    }
}
