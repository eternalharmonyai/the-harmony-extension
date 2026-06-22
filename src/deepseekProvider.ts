/**
 * DeepSeek Language Model Chat Provider for VS Code Copilot Chat.
 *
 * Registers deepseek-v4-flash and deepseek-v4-pro as native models
 * in Copilot Chat's model picker. All requests go directly to DeepSeek API
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
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        family: VENDOR,
        version: 'v4-flash',
        maxInputTokens: 128000,
        maxOutputTokens: 32768,
        capabilities: {},
        apiModel: 'deepseek-v4-flash',
    },
    {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        family: VENDOR,
        version: 'v4-pro',
        maxInputTokens: 128000,
        maxOutputTokens: 32768,
        capabilities: {},
        apiModel: 'deepseek-v4-pro',
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
function mapRole(role: vscode.LanguageModelChatMessageRole): string {
    switch (role) {
        case vscode.LanguageModelChatMessageRole.User: return 'user';
        case vscode.LanguageModelChatMessageRole.Assistant: return 'assistant';
        default: return 'user';
    }
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
                    content: extractTextContent(m),
                }));

            const requestBody = {
                model: model.apiModel,
                messages: deepseekMessages,
                stream: false,
                max_tokens: 32768,
            };

            const controller = new AbortController();
            const cancelSub = token.onCancellationRequested(() => controller.abort());

            try {
                const response = await fetch(`${cleanBase}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify(requestBody),
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

    console.log('[DeepSeek Provider] ✅ Registered — vendor: deepseek, models: v4-flash, v4-pro');
}
