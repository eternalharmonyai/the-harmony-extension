/**
 * DeepSeek Language Model Chat Provider for VS Code Copilot Chat.
 *
 * Registers deepseek-flash (V4.1), deepseek-v4-flash, deepseek-v4-pro, and deepseek-v4-flash-vision-exp
 * as native models in Copilot Chat's model picker. All requests go directly to DeepSeek API
 * — no TLS interception, no DNS hacking, no rate limits.
 *
 * This file is ISOLATED: it never touches existing Harmony code.
 * If it fails, it just doesn't register — Harmony works as before.
 *
 * ALSO REQUIRES: package.json contribution point "languageModelChatProviders"
 */
import * as vscode from 'vscode';

const VENDOR = 'deepseek';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

interface DeepSeekModelInfo extends vscode.LanguageModelChatInformation {
    apiModel: string; // actual DeepSeek API model name
}

const MODELS: DeepSeekModelInfo[] = [
    {
        id: 'deepseek-flash',
        name: 'DeepSeek Flash (V4.1)',
        family: VENDOR,
        version: 'v4.1-flash',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true },
        apiModel: 'deepseek-flash',
    },
    {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        family: VENDOR,
        version: 'v4-flash',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true },
        apiModel: 'deepseek-v4-flash',
    },
    {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        family: VENDOR,
        version: 'v4-pro',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true },
        apiModel: 'deepseek-v4-pro',
    },
    {
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision (exp)',
        family: VENDOR,
        version: 'v4-flash-vision-exp',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true, imageInput: true },
        apiModel: 'deepseek-v4-flash-vision-exp',
    },
];

/**
 * Extract text content from a LanguageModelChatRequestMessage.
 * Content can be a string (older API) or array of parts.
 */
function extractTextContent(msg: vscode.LanguageModelChatRequestMessage): string {
    const content = msg.content;
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (part instanceof vscode.LanguageModelTextPart) return part.value;
                if (part && typeof (part as any).value === 'string') return (part as any).value;
                return '';
            })
            .join('\n');
    }
    return String(content);
}

/**
 * Map VS Code message role to DeepSeek role string.
 */
/**
 * Sanitize content for safe JSON serialization.
 * Handles lone surrogate pairs and control characters.
 */
function sanitizeContent(str: string): string {
    return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function mapRole(role: vscode.LanguageModelChatMessageRole): string {
    switch (role) {
        case vscode.LanguageModelChatMessageRole.User: return 'user';
        case vscode.LanguageModelChatMessageRole.Assistant: return 'assistant';
        default: return 'user';
    }
}

/**
 * Build the API message content for a native chat request. When the model is
 * image-capable AND the message carries image parts, emit an OpenAI multimodal
 * content array (text + image_url). Otherwise emit sanitized text as before.
 */
function buildNativeChatContent(model: DeepSeekModelInfo, msg: vscode.LanguageModelChatRequestMessage): string | any[] {
    const raw = msg.content;
    if (!Array.isArray(raw)) return sanitizeContent(extractTextContent(msg));
    const imageParts = raw.filter((p: any) =>
        p && typeof p === 'object'
        && typeof (p as any).mimeType === 'string'
        && (p as any).data !== undefined
        && !(p instanceof vscode.LanguageModelTextPart)
    );
    if (imageParts.length === 0 || model.apiModel !== 'deepseek-v4-flash-vision-exp') {
        return sanitizeContent(extractTextContent(msg));
    }
    const parts: any[] = [];
    const text = sanitizeContent(extractTextContent(msg));
    if (text) parts.push({ type: 'text', text });
    for (const ip of imageParts) {
        const img = ip as any;
        const data = typeof img.data === 'string' ? img.data : Buffer.from(img.data).toString('base64');
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType || 'image/png'};base64,${data}` } });
    }
    return parts;
}

export function registerDeepSeekProvider(context: vscode.ExtensionContext) {
    const provider: vscode.LanguageModelChatProvider<DeepSeekModelInfo> = {
        // ── List available models ──────────────────────
        provideLanguageModelChatInformation(
            _options: vscode.PrepareLanguageModelChatModelOptions,
            _token: vscode.CancellationToken
        ): vscode.ProviderResult<DeepSeekModelInfo[]> {
            return MODELS;
        },

        // ── Handle chat requests ───────────────────────
        async provideLanguageModelChatResponse(
            model: DeepSeekModelInfo,
            messages: readonly vscode.LanguageModelChatRequestMessage[],
            options: vscode.ProvideLanguageModelChatResponseOptions,
            progress: vscode.Progress<vscode.LanguageModelResponsePart>,
            token: vscode.CancellationToken
        ): Promise<void> {
            // Get API key
            let apiKey = await context.secrets.get('harmony.deepseekApiKey');
            if (!apiKey) {
                apiKey = process.env.DEEPSEEK_COPILOT_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';
            }
            if (!apiKey) {
                progress.report(new vscode.LanguageModelTextPart(
                    '[DeepSeek] ❌ API key not configured.\n\n' +
                    'Set Harmony: Deepseek Api Key in VS Code settings, or run the Harmony "Select Model" command.'
                ));
                return;
            }

            const baseUrl = vscode.workspace.getConfiguration('harmony').get<string>('deepseekBaseUrl') ?? DEEPSEEK_BASE;
            const cleanBase = baseUrl.replace(/\/$/, '');

            // Build DeepSeek API messages
            const deepseekMessages = messages
                .filter(m => m.role === vscode.LanguageModelChatMessageRole.User || m.role === vscode.LanguageModelChatMessageRole.Assistant)
                .map(m => ({
                    role: mapRole(m.role),
                    content: buildNativeChatContent(model, m),
                }));

            const requestBody = {
                model: model.apiModel,
                messages: deepseekMessages,
                stream: false,
                max_tokens: 393216,
            };

            // Safe JSON serialization with fallback for edge cases
            let body: string;
            try {
                body = JSON.stringify(requestBody);
            } catch (jsonErr) {
                console.warn('[DeepSeek Provider] JSON.stringify failed, retrying with aggressive sanitization:', jsonErr);
                const safeMessages = deepseekMessages.map(m => ({
                    ...m,
                    content: typeof m.content === 'string'
                        ? m.content.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                        : m.content,
                }));
                body = JSON.stringify({ ...requestBody, messages: safeMessages });
            }

            const controller = new AbortController();
            const cancelSub = token.onCancellationRequested(() => controller.abort());

            try {
                const response = await fetch(`${cleanBase}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: body,
                    signal: controller.signal as AbortSignal,
                });

                if (!response.ok) {
                    const text = await response.text();
                    progress.report(new vscode.LanguageModelTextPart(
                        `[DeepSeek] ❌ HTTP ${response.status}: ${text.slice(0, 500)}`
                    ));
                    return;
                }

                const data = await response.json() as any;
                const content: string = data.choices?.[0]?.message?.content ?? '';
                const modelUsed: string = data.model ?? model.apiModel;

                // 🎀 Foolproof ribbon
                progress.report(new vscode.LanguageModelTextPart(
                    `[DeepSeek ${modelUsed}] ${content}`
                ));
            } catch (e) {
                if (token.isCancellationRequested) return;
                progress.report(new vscode.LanguageModelTextPart(
                    `[DeepSeek] ❌ ${e instanceof Error ? e.message : String(e)}`
                ));
            } finally {
                cancelSub.dispose();
            }
        },

        // ── Token counting (approximate) ───────────────
        async provideTokenCount(
            _model: DeepSeekModelInfo,
            text: string | vscode.LanguageModelChatRequestMessage,
            _token: vscode.CancellationToken
        ): Promise<number> {
            const str = typeof text === 'string' ? text : extractTextContent(text);
            // ~4 chars per token — DeepSeek uses similar tokenization
            return Math.ceil(str.length / 4);
        },
    };

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
    );

    console.log('[DeepSeek Provider] ✅ Registered — vendor: deepseek, models: flash (V4.1), v4-flash, v4-pro, v4-flash-vision-exp');

    // ── DIAGNOSTIC (on-demand): verify models actually landed in the LM registry ──
    // Queries the same registry the model picker reads, then surfaces the
    // result as a visible message (exthost.log does not capture console.log).
    // Runs ONLY when invoked as "Harmony: LM Check" from the command palette —
    // no popup on every activation.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.lmCheck', async () => {
            try {
                const apiOk = typeof (vscode.lm as any).registerLanguageModelChatProvider === 'function';
                const mine = await vscode.lm.selectChatModels({ vendor: VENDOR });
                const all = await vscode.lm.selectChatModels({});
                const summary =
                    `API ${apiOk ? '✅' : '❌'} | deepseek models: ${mine.length}` +
                    `${mine.length ? ' (' + mine.map(m => m.id).join(', ') + ')' : ''}` +
                    ` | total registry: ${all.length}`;
                console.log('[DeepSeek Provider] DIAG:', summary);
                vscode.window.showInformationMessage(`Harmony LM check → ${summary}`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error('[DeepSeek Provider] DIAG FAILED:', msg);
                vscode.window.showErrorMessage(`Harmony LM check FAILED → ${msg}`);
            }
        })
    );
}
