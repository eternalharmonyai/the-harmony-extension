import * as vscode from 'vscode';
import { ComposeImage } from './composeQueue';
import { recordUsage } from './costTracker';
import { confirmPremiumModel } from './providers';

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

const GEMINI_VISION_MODEL_DEFAULT = 'gemini-3.5-flash';

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

    const apiKey = await secrets.get('harmony.geminiApiKey');
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

const QWEN_VISION_MODEL_DEFAULT = 'qwen-vl-max';
const QWEN_VISION_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

function qwenTierForModel(model: string): 'light' | 'mid' | 'heavy' {
    const lower = model.toLowerCase();
    if (lower.includes('plus')) return 'light';
    if (lower.includes('max')) return 'mid';
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

    const apiKey = await secrets.get('harmony.alibaba.apiKey') || process.env.ALIBABA_VISION_API_KEY;
    if (!apiKey) {
        return {
            description: `[Vision: no Alibaba API key set. Set harmony.alibaba.apiKey in SecretStorage or ALIBABA_VISION_API_KEY in .env.]`,
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

// ── Smart router with Gemini → Alibaba fallback ─────────────────────

/**
 * Route image description through the best available provider.
 *
 * Order: Gemini (primary) → Alibaba Qwen-VL (fallback).
 * If Gemini fails with any error (billing, auth, network), Alibaba is tried
 * automatically. The result's `routedTo` field shows which provider handled it.
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

    // Resolve auto-model configs for auto/auto-qwen-first modes
    const autoGeminiModel = cfg.get<string>('vision.autoGeminiModel') ?? 'gemini-3.5-flash';
    const autoQwenModel = cfg.get<string>('vision.autoQwenModel') ?? 'qwen-vl-max';

    // provider=alibaba: try Alibaba first, fall back to Gemini
    if (provider === 'alibaba') {
        const qwenResult = await describeImagesViaQwen(images, userNote, secrets, token);
        if (!qwenResult.partial) {
            if (localNote) { qwenResult.description = localNote + qwenResult.description; qwenResult.routedTo = 'local CPU + ' + qwenResult.routedTo; }
            return qwenResult;
        }
        if (token.isCancellationRequested) {
            if (localNote) qwenResult.description = localNote + qwenResult.description;
            return qwenResult;
        }
        const geminiResult = await describeImagesViaGemini(images, userNote, secrets, token);
        if (!geminiResult.partial) {
            if (localNote) { geminiResult.description = localNote + geminiResult.description; geminiResult.routedTo = 'local CPU + ' + geminiResult.routedTo; }
            return geminiResult;
        }
        const alibabaFallback = localNote +
            `[Vision routing failed:\n` +
            `  Alibaba: ${qwenResult.description}\n` +
            `  Gemini: ${geminiResult.description}]`;
        return {
            description: alibabaFallback,
            routedTo: localNote ? 'local CPU + alibaba+gemini' : 'alibaba+gemini',
            partial: true
        };
    }

    // provider=auto-qwen-first: try Alibaba first with auto model, fall back to Gemini with auto model
    if (provider === 'auto-qwen-first') {
        const qwenResult = await describeImagesViaQwen(images, userNote, secrets, token, autoQwenModel);
        if (!qwenResult.partial) {
            if (localNote) { qwenResult.description = localNote + qwenResult.description; qwenResult.routedTo = 'local CPU + ' + qwenResult.routedTo; }
            return qwenResult;
        }
        if (token.isCancellationRequested) {
            if (localNote) qwenResult.description = localNote + qwenResult.description;
            return qwenResult;
        }
        const geminiResult = await describeImagesViaGemini(images, userNote, secrets, token, autoGeminiModel);
        if (!geminiResult.partial) {
            if (localNote) { geminiResult.description = localNote + geminiResult.description; geminiResult.routedTo = 'local CPU + ' + geminiResult.routedTo; }
            return geminiResult;
        }
        const qwenFirstFallback = localNote +
            `[Vision routing failed:\n` +
            `  Alibaba (${autoQwenModel}): ${qwenResult.description}\n` +
            `  Gemini (${autoGeminiModel}): ${geminiResult.description}]`;
        return {
            description: qwenFirstFallback,
            routedTo: localNote ? 'local CPU + qwen+gemini' : 'qwen+gemini',
            partial: true
        };
    }

    // provider=gemini: only try Gemini, no fallback
    if (provider === 'gemini') {
        const geminiResult = await describeImagesViaGemini(images, userNote, secrets, token);
        if (localNote) { geminiResult.description = localNote + geminiResult.description; geminiResult.routedTo = 'local CPU + ' + geminiResult.routedTo; }
        return geminiResult;
    }

    // provider=auto (default): try Gemini first with auto model, fall back to Alibaba with auto model
    const geminiResult = await describeImagesViaGemini(images, userNote, secrets, token, autoGeminiModel);
    if (!geminiResult.partial) {
        if (localNote) { geminiResult.description = localNote + geminiResult.description; geminiResult.routedTo = 'local CPU + ' + geminiResult.routedTo; }
        return geminiResult;
    }
    if (token.isCancellationRequested) {
        if (localNote) geminiResult.description = localNote + geminiResult.description;
        return geminiResult;
    }
    const qwenResult = await describeImagesViaQwen(images, userNote, secrets, token, autoQwenModel);
    if (!qwenResult.partial) {
        if (localNote) { qwenResult.description = localNote + qwenResult.description; qwenResult.routedTo = 'local CPU + ' + qwenResult.routedTo; }
        return qwenResult;
    }
    const fallbackDesc = localNote +
        `[Vision routing failed:\n` +
        `  Gemini (${autoGeminiModel}): ${geminiResult.description}\n` +
        `  Alibaba (${autoQwenModel}): ${qwenResult.description}]`;
    return {
        description: fallbackDesc,
        routedTo: localNote ? 'local CPU + gemini+qwen' : 'gemini+qwen',
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
