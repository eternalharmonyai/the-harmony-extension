import * as vscode from 'vscode';
import { ComposeImage } from './composeQueue';
import { recordUsage } from './costTracker';
import { confirmPremiumModel, resolveProviderKey } from './providers';

/**
 * Vision routing for compose-attached images.
 *
 * Multi-provider with automatic fallback:
 *   1. Gemini (primary) — fast, excellent at code/UI screenshots
 *   2. Alibaba Qwen-VL (fallback) — strong code/document vision, credit-friendly
 *
 * Privacy gates honor `harmony.localEngine.enabled` and `harmony.privacyRouting`.
 * Future: local ONNX/Ollama route for zero-network privacy.
 */

export interface VisionRouteResult {
    /** Plain-text description suitable for inlining into a chat prompt. */
    description: string;
    /** Which provider/model handled it, for transparency. */
    routedTo: string;
    /** True if any image failed and we returned a partial description. */
    partial: boolean;
}

// ── Gemini ──────────────────────────────────────────────────────────

const GEMINI_VISION_MODEL_DEFAULT = 'gemini-3.7-flash';

function geminiTierForModel(model: string): 'light' | 'mid' | 'heavy' {
    const lower = model.toLowerCase();
    if (lower.includes('flash-lite')) return 'light';
    if (lower.includes('pro') || lower.includes('preview')) return 'heavy';
    if (lower.includes('flash')) return 'mid';
    return 'mid';
}

function recordGeminiVisionUsage(model: string, usage?: any): void {
    recordUsage({
        timestamp: new Date().toISOString(),
        provider: 'gemini',
        tier: geminiTierForModel(model),
        model,
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0
    });
}

export async function describeImagesViaGemini(
    images: ComposeImage[],
    userNote: string,
    secrets: vscode.SecretStorage,
    token: vscode.CancellationToken,
    modelOverride?: string
): Promise<VisionRouteResult> {
    if (images.length === 0) {
        return { description: '', routedTo: 'none', partial: false };
    }

    const cfg = vscode.workspace.getConfiguration('harmony');
    const model = modelOverride ?? cfg.get<string>('vision.geminiModel') ?? GEMINI_VISION_MODEL_DEFAULT;
    const tier = geminiTierForModel(model);

    const apiKey = await resolveProviderKey(secrets, 'gemini', 3); // Vision slot
    if (!apiKey) {
        return {
            description: `[Vision: no Gemini API key set.]`,
            routedTo: 'none',
            partial: true
        };
    }

    const allowed = await confirmPremiumModel('gemini', tier, model, 'vision/image analysis');
    if (!allowed) {
        return {
            description: `[Vision routing cancelled before calling ${model}.]`,
            routedTo: `gemini/${model}`,
            partial: true
        };
    }

    const prompt =
        (userNote && userNote.trim().length > 0
            ? `User context for these images:\n${userNote.trim()}\n\n`
            : '') +
        `Describe each image in detail. For UI/code screenshots, transcribe visible text faithfully ` +
        `(error messages, code, paths, line numbers, button labels). For diagrams, capture structure ` +
        `and labels. Number each image (Image 1, Image 2, ...). Be thorough but concise — this ` +
        `description will be passed to another model that cannot see the images directly.`;

    const parts: any[] = [{ text: prompt }];
    for (const img of images) {
        parts.push({
            inlineData: {
                mimeType: img.mimeType || 'image/png',
                data: img.base64
            }
        });
    }

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.2 }
    };

    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        `:generateContent?key=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const text = await r.text();
        if (!r.ok) {
            recordGeminiVisionUsage(model);
            return {
                description: `[Gemini vision: HTTP ${r.status}. ${text.slice(0, 400)}]`,
                routedTo: `gemini/${model}`,
                partial: true
            };
        }
        const json = JSON.parse(text);
        recordGeminiVisionUsage(model, json?.usageMetadata);
        const respParts = json?.candidates?.[0]?.content?.parts ?? [];
        const description = respParts
            .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
            .join('\n')
            .trim();
        if (!description) {
            return {
                description: `[Gemini vision returned no text for ${images.length} image(s).]`,
                routedTo: `gemini/${model}`,
                partial: true
            };
        }
        return {
            description,
            routedTo: `gemini/${model}`,
            partial: false
        };
    } catch (e: any) {
        return {
            description: `[Gemini vision error: ${e?.message ?? String(e)}]`,
            routedTo: `gemini/${model}`,
            partial: true
        };
    } finally {
        sub.dispose();
    }
}

// ── Alibaba Qwen-VL ─────────────────────────────────────────────────

const QWEN_VISION_MODEL_DEFAULT = 'qwen3.8-max';
const QWEN_VISION_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

function qwenTierForModel(model: string): 'light' | 'mid' | 'heavy' {
    const lower = model.toLowerCase();
    if (lower.includes('flash')) return 'light';
    if (lower.includes('max')) return 'heavy';
    if (lower.includes('plus')) return 'mid';
    if (lower.includes('72b')) return 'heavy';
    return 'mid';
}

function recordQwenVisionUsage(model: string, usage?: any): void {
    recordUsage({
        timestamp: new Date().toISOString(),
        provider: 'alibaba',
        tier: qwenTierForModel(model),
        model,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0
    });
}

export async function describeImagesViaQwen(
    images: ComposeImage[],
    userNote: string,
    secrets: vscode.SecretStorage,
    token: vscode.CancellationToken,
    modelOverride?: string
): Promise<VisionRouteResult> {
    if (images.length === 0) {
        return { description: '', routedTo: 'none', partial: false };
    }

    const cfg = vscode.workspace.getConfiguration('harmony');
    const model = modelOverride ?? cfg.get<string>('vision.qwenModel') ?? QWEN_VISION_MODEL_DEFAULT;

    const apiKey = await resolveProviderKey(secrets, 'alibaba', 3); // Vision slot
    if (!apiKey) {
        return {
            description: `[Vision: no Alibaba API key set. Set harmony.alibaba.apiKey in SecretStorage or ALIBABA_VISION_API_KEY in .env.]`,
            routedTo: 'none',
            partial: true
        };
    }

    const allowed = await confirmPremiumModel('alibaba', qwenTierForModel(model), model, 'vision/image analysis');
    if (!allowed) {
        return {
            description: `[Vision routing cancelled before calling ${model}.]`,
            routedTo: `alibaba/${model}`,
            partial: true
        };
    }

    const prompt =
        (userNote && userNote.trim().length > 0
            ? `User context for these images:\n${userNote.trim()}\n\n`
            : '') +
        `Describe each image in detail. For UI/code screenshots, transcribe visible text faithfully ` +
        `(error messages, code, paths, line numbers, button labels). For diagrams, capture structure ` +
        `and labels. Number each image (Image 1, Image 2, ...). Be thorough but concise.`;

    // Build OpenAI-compatible multimodal content array
    const content: any[] = [{ type: 'text', text: prompt }];
    for (const img of images) {
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:${img.mimeType || 'image/png'};base64,${img.base64}`
            }
        });
    }

    const body = {
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 4096,
        temperature: 0.2
    };

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        const r = await fetch(QWEN_VISION_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const text = await r.text();
        if (!r.ok) {
            recordQwenVisionUsage(model);
            return {
                description: `[Qwen vision: HTTP ${r.status}. ${text.slice(0, 400)}]`,
                routedTo: `alibaba/${model}`,
                partial: true
            };
        }
        const json = JSON.parse(text);
        recordQwenVisionUsage(model, json?.usage);
        const description = json?.choices?.[0]?.message?.content?.trim() ?? '';
        if (!description) {
            return {
                description: `[Qwen vision returned no text for ${images.length} image(s).]`,
                routedTo: `alibaba/${model}`,
                partial: true
            };
        }
        return {
            description,
            routedTo: `alibaba/${model}`,
            partial: false
        };
    } catch (e: any) {
        return {
            description: `[Qwen vision error: ${e?.message ?? String(e)}]`,
            routedTo: `alibaba/${model}`,
            partial: true
        };
    } finally {
        sub.dispose();
    }
}

// ── Zhipu GLM-5v-Turbo ────────────────────────────────────────────

const ZHIPU_VISION_MODEL_DEFAULT = 'glm-5v-turbo';
const ZHIPU_VISION_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

function zhipuVisionTierForModel(model: string): 'light' | 'mid' | 'heavy' {
    const lower = model.toLowerCase();
    if (lower.includes('flash') || lower.includes('turbo')) return 'light';
    if (lower.includes('plus') || lower.includes('pro')) return 'mid';
    return 'mid';
}

function recordZhipuVisionUsage(model: string, usage?: any): void {
    recordUsage({
        timestamp: new Date().toISOString(),
        provider: 'zhipu',
        tier: zhipuVisionTierForModel(model),
        model,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0
    });
}

export async function describeImagesViaZhipu(
    images: ComposeImage[],
    userNote: string,
    secrets: vscode.SecretStorage,
    token: vscode.CancellationToken,
    modelOverride?: string
): Promise<VisionRouteResult> {
    if (images.length === 0) {
        return { description: '', routedTo: 'none', partial: false };
    }

    const cfg = vscode.workspace.getConfiguration('harmony');
    const model = modelOverride ?? cfg.get<string>('vision.zhipuModel') ?? ZHIPU_VISION_MODEL_DEFAULT;

    const apiKey = await resolveProviderKey(secrets, 'zhipu', 3); // Vision slot
    if (!apiKey) {
        return {
            description: `[Vision: no Zhipu API key set. Set harmony.zhipu.apiKey in SecretStorage or Z_VISION_API_KEY in .env.]`,
            routedTo: 'none',
            partial: true
        };
    }

    const prompt =
        (userNote && userNote.trim().length > 0
            ? `User context for these images:\n${userNote.trim()}\n\n`
            : '') +
        `Describe each image in detail. For UI/code screenshots, transcribe visible text faithfully ` +
        `(error messages, code, paths, line numbers, button labels). For diagrams, capture structure ` +
        `and labels. Number each image (Image 1, Image 2, ...). Be thorough but concise.`;

    // Build OpenAI-compatible multimodal content array
    const content: any[] = [{ type: 'text', text: prompt }];
    for (const img of images) {
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:${img.mimeType || 'image/png'};base64,${img.base64}`
            }
        });
    }

    const body = {
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 4096,
        temperature: 0.2
    };

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        const r = await fetch(ZHIPU_VISION_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const text = await r.text();
        if (!r.ok) {
            recordZhipuVisionUsage(model);
            return {
                description: `[Zhipu vision: HTTP ${r.status}. ${text.slice(0, 400)}]`,
                routedTo: `zhipu/${model}`,
                partial: true
            };
        }
        const json = JSON.parse(text);
        recordZhipuVisionUsage(model, json?.usage);
        const description = json?.choices?.[0]?.message?.content?.trim() ?? '';
        if (!description) {
            return {
                description: `[Zhipu vision returned no text for ${images.length} image(s).]`,
                routedTo: `zhipu/${model}`,
                partial: true
            };
        }
        return {
            description,
            routedTo: `zhipu/${model}`,
            partial: false
        };
    } catch (e: any) {
        return {
            description: `[Zhipu vision error: ${e?.message ?? String(e)}]`,
            routedTo: `zhipu/${model}`,
            partial: true
        };
    } finally {
        sub.dispose();
    }
}

// ── Smart router with configurable fallback order ───────────────────

type VisionProviderFn = (
    images: ComposeImage[],
    userNote: string,
    secrets: vscode.SecretStorage,
    token: vscode.CancellationToken,
    modelOverride?: string
) => Promise<VisionRouteResult>;

interface VisionProviderEntry {
    id: string;
    fn: VisionProviderFn;
    displayName: string;
}

const VISION_PROVIDERS: Record<string, VisionProviderEntry> = {
    gemini: { id: 'gemini', fn: describeImagesViaGemini, displayName: 'Gemini' },
    zhipu: { id: 'zhipu', fn: describeImagesViaZhipu, displayName: 'Zhipu (GLM)' },
    alibaba: { id: 'alibaba', fn: describeImagesViaQwen, displayName: 'Alibaba (Qwen-VL)' },
};

const DEFAULT_FALLBACK_ORDER: string[] = ['gemini', 'zhipu', 'alibaba'];

/**
 * Route image description through the best available provider.
 *
 * Uses configurable fallback order (`harmony.vision.fallbackOrder`) —
 * tries each provider in sequence, returns the first successful result.
 * Single-provider modes (`gemini`, `alibaba`, `zhipu`) are still supported
 * via the `harmony.vision.provider` setting for backward compatibility.
 */
export async function describeImages(
    images: ComposeImage[],
    userNote: string,
    secrets: vscode.SecretStorage,
    token: vscode.CancellationToken
): Promise<VisionRouteResult> {
    if (images.length === 0) {
        return { description: '', routedTo: 'none', partial: false };
    }

    const cfg = vscode.workspace.getConfiguration('harmony');

    // ── Local-first: zero-cost algorithmic analysis ────────────────
    // Runs informative CPU analysis when enabled, then continues to
    // provider routing for actual vision. Local results are prepended
    // to the final description so you always see what CPU detected.
    let localNote = '';
    if (cfg.get<boolean>('vision.localFirst')) {
        try {
            const { decodePng, summarizeLocalAnalysis } = await import('./visualTools');
            const buf = Buffer.from(images[0].base64, 'base64');
            const decoded = decodePng(buf);
            if (decoded) {
                const summary = summarizeLocalAnalysis(decoded.rgba, decoded.width, decoded.height);
                if (summary) {
                    localNote = '🧠 Local CPU analysis (free): ' + summary + '\n\n';
                }
            }
        } catch { /* continue to provider routing */ }
    }

    const provider = cfg.get<string>('vision.provider') ?? 'auto';

    // Single-provider modes: use only that provider, no fallback
    if (provider === 'gemini') {
        const result = await describeImagesViaGemini(images, userNote, secrets, token);
        if (localNote) { result.description = localNote + result.description; result.routedTo = 'local CPU + ' + result.routedTo; }
        return result;
    }
    if (provider === 'alibaba') {
        const result = await describeImagesViaQwen(images, userNote, secrets, token);
        if (localNote) { result.description = localNote + result.description; result.routedTo = 'local CPU + ' + result.routedTo; }
        return result;
    }
    if (provider === 'zhipu') {
        const result = await describeImagesViaZhipu(images, userNote, secrets, token);
        if (localNote) { result.description = localNote + result.description; result.routedTo = 'local CPU + ' + result.routedTo; }
        return result;
    }

    // Legacy: auto-qwen-first maps to alibaba-first fallback order
    const isQwenFirst = provider === 'auto-qwen-first';

    // Read configurable fallback order (default: gemini → zhipu → alibaba)
    const rawOrder: string[] = cfg.get<string[]>('vision.fallbackOrder') ?? DEFAULT_FALLBACK_ORDER;
    let order = rawOrder.filter(id => id in VISION_PROVIDERS);
    if (order.length === 0) order = [...DEFAULT_FALLBACK_ORDER];
    if (isQwenFirst) {
        // Move alibaba to front if it's in the list
        order = order.filter(id => id !== 'alibaba');
        order.unshift('alibaba');
    }

    // Collect errors for aggregate reporting
    const errors: string[] = [];

    // Try each provider in order, return first success
    for (const providerId of order) {
        if (token.isCancellationRequested) break;
        const entry = VISION_PROVIDERS[providerId];
        if (!entry) continue;

        const result = await entry.fn(images, userNote, secrets, token);
        if (!result.partial) {
            if (localNote) { result.description = localNote + result.description; result.routedTo = 'local CPU + ' + result.routedTo; }
            return result;
        }
        errors.push(`${entry.displayName}: ${result.description}`);
        if (token.isCancellationRequested) break;
    }

    // All providers failed — aggregate errors
    const fallbackDesc = localNote +
        `[Vision routing failed after trying ${order.length} provider(s):\n` +
        errors.map(e => `  ${e}`).join('\n') + `\n]`;
    return {
        description: fallbackDesc,
        routedTo: localNote ? 'local CPU + all-failed' : 'all-failed',
        partial: true
    };
}

// ── Formatting ──────────────────────────────────────────────────────

/**
 * Format a vision result + compose text into a markdown context block
 * that can be prepended to the user's chat prompt.
 */
export function formatComposeContext(
    composeText: string,
    filePaths: string[],
    visionDescription: string,
    routedTo: string
): string {
    const lines: string[] = [];
    lines.push('━━━ Harmony Compose attachment ━━━');
    if (composeText && composeText.trim().length > 0) {
        lines.push('');
        lines.push('**Note from compose panel:**');
        lines.push(composeText.trim());
    }
    if (filePaths.length > 0) {
        lines.push('');
        lines.push('**Attached files (read with harmony_read_file as needed):**');
        for (const fp of filePaths) lines.push(`- ${fp}`);
    }
    if (visionDescription) {
        lines.push('');
        lines.push(`**Image analysis (via ${routedTo}):**`);
        lines.push(visionDescription);
    }
    lines.push('━━━ end attachment ━━━');
    lines.push('');
    return lines.join('\n');
}
