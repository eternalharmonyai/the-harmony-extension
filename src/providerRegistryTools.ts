import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { PROVIDER_DEFAULTS, ProviderId } from './providers';

const MAX_RESULT_CHARS = 60000;
const PRICING_DIR = '.harmony/provider-pricing';
const STALE_AFTER_DAYS = 7;

type RegistryProviderId = ProviderId;

interface PricingSource {
    label: string;
    url: string;
}

interface ProviderCapability {
    chat: string;
    toolCalling: string;
    vision: string;
    image: string;
    search: string;
    context: string;
}

interface ProviderRegistryEntry {
    id: RegistryProviderId;
    label: string;
    execution: string;
    configuredModels: string[];
    strengths: string[];
    cautions: string[];
    capabilities: ProviderCapability;
    pricingSources: PricingSource[];
    snippetTerms: string[];
}

interface PricingSourceFetch {
    provider: RegistryProviderId;
    label: string;
    url: string;
    finalUrl: string;
    fetchedAt: string;
    ok: boolean;
    status: number;
    contentType: string;
    lastModified?: string;
    title?: string;
    sha256: string;
    snippets: string[];
    pricingSignals: ParsedPricingSignal[];
    error?: string;
}

interface ParsedPricingSignal {
    amount: number;
    currency: string;
    unit: string;
    direction: 'input' | 'output' | 'cache' | 'batch' | 'image' | 'unknown';
    model?: string;
    context: string;
}

interface PricingSnapshot {
    version: 1;
    fetchedAt: string;
    staleAfterDays: number;
    providers: RegistryProviderId[];
    sources: PricingSourceFetch[];
}

interface ProviderStatusInput {
    provider?: string;
    include_pricing_snapshot?: boolean;
    format?: 'markdown' | 'json';
}

interface PricingRefreshInput {
    providers?: string[];
    max_chars_per_source?: number;
    timeout_ms?: number;
    write_snapshot?: boolean;
    format?: 'markdown' | 'json';
}

const PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
    {
        id: 'deepseek',
        label: 'DeepSeek',
        execution: 'Direct provider supported by Harmony primary model settings and harmony_consult_model.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.deepseek),
        strengths: ['low-cost coding/reasoning route', 'OpenAI-compatible API shape', 'good default for routine Harmony work'],
        cautions: ['model availability and names can change quickly', 'reasoning-heavy models need explicit retry/budget handling'],
        capabilities: {
            chat: 'yes',
            toolCalling: 'OpenAI-compatible; model dependent',
            vision: 'not assumed in Harmony registry',
            image: 'no primary Harmony image route',
            search: 'external tools required',
            context: 'model dependent; verify against current docs'
        },
        pricingSources: [{ label: 'DeepSeek API pricing', url: 'https://api-docs.deepseek.com/quick_start/pricing' }],
        snippetTerms: ['pricing', 'input', 'output', 'cache', 'deepseek-chat', 'deepseek-reasoner', 'tokens']
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        execution: 'Direct harmony_consult_model route for text and existing Gemini vision/image helpers where configured.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.gemini),
        strengths: ['large context options', 'vision/multimodal ecosystem', 'good fit for screenshots and design review'],
        cautions: ['pricing varies by model, context tier, caching, and grounding/search features', 'preview model names should be treated as unstable'],
        capabilities: {
            chat: 'yes',
            toolCalling: 'yes for supported Gemini models/APIs',
            vision: 'yes for multimodal models',
            image: 'yes through separate image-generation route when configured',
            search: 'grounding/search availability is model/API dependent',
            context: 'large-context models; verify per model'
        },
        pricingSources: [{ label: 'Gemini API pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing' }],
        snippetTerms: ['pricing', 'input', 'output', 'cached', 'context', 'gemini', 'tokens', 'batch']
    },
    {
        id: 'claude',
        label: 'Anthropic (Claude models)',
        execution: 'Direct harmony_consult_model route when Anthropic key is configured.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.claude),
        strengths: ['strong long-form reasoning and writing', 'high-quality code review and architecture work'],
        cautions: ['extended thinking can add substantial extra token cost', 'premium Opus-class calls need explicit budget gates'],
        capabilities: {
            chat: 'yes',
            toolCalling: 'yes for supported Messages API models',
            vision: 'yes for supported models',
            image: 'no primary Harmony image route',
            search: 'external tools required unless a hosted feature is enabled separately',
            context: 'model dependent; verify against current docs'
        },
        pricingSources: [{ label: 'Claude pricing', url: 'https://docs.anthropic.com/en/docs/about-claude/pricing' }],
        snippetTerms: ['pricing', 'input', 'output', 'cache', 'thinking', 'haiku', 'sonnet', 'opus']
    },
    {
        id: 'openai',
        label: 'OpenAI',
        execution: 'Direct harmony_consult_model route when OpenAI key is configured.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.openai),
        strengths: ['broad model/platform ecosystem', 'strong structured output and tool-use support'],
        cautions: ['reasoning, cached input, batch, and tool-feature pricing can diverge by model', 'model names and tiers should be refreshed before budgeting'],
        capabilities: {
            chat: 'yes',
            toolCalling: 'yes for supported Responses/Chat models',
            vision: 'yes for supported multimodal models',
            image: 'yes through separate image APIs when configured',
            search: 'hosted and external search options vary by API',
            context: 'model dependent; verify against current docs'
        },
        pricingSources: [{ label: 'OpenAI API pricing', url: 'https://openai.com/api/pricing/' }],
        snippetTerms: ['pricing', 'input', 'output', 'cached', 'reasoning', 'gpt', 'tokens', 'batch']
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        execution: 'Direct harmony_consult_model route with model fallback support when OpenRouter key is configured.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.openrouter),
        strengths: ['multi-provider routing', 'fallback experiments', 'good place to compare third-party hosted models'],
        cautions: ['provider routing can change cost/latency/behavior', 'free routes and model availability are especially volatile'],
        capabilities: {
            chat: 'yes',
            toolCalling: 'model/provider dependent',
            vision: 'model/provider dependent',
            image: 'model/provider dependent; not primary Harmony image route',
            search: 'external tools or provider-specific routes required',
            context: 'model/provider dependent'
        },
        pricingSources: [
            { label: 'OpenRouter models/pricing', url: 'https://openrouter.ai/models' },
            { label: 'OpenRouter routing docs', url: 'https://openrouter.ai/docs/features/model-routing' }
        ],
        snippetTerms: ['pricing', 'prompt', 'completion', 'free', 'routing', 'provider', 'tokens']
    },
    {
        id: 'moonshot',
        label: 'Moonshot / Kimi',
        execution: 'Direct harmony_consult_model route through the Moonshot/Kimi OpenAI-compatible API when key is configured.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.moonshot),
        strengths: ['candidate for swarm research/coding roles', 'worth tracking for long-context and cost experiments'],
        cautions: ['model names and direct pricing need source verification before budgeting', 'base URL may need adjustment if Moonshot changes API routing'],
        capabilities: {
            chat: 'yes when API key/base URL are configured',
            toolCalling: 'verify current API docs',
            vision: 'verify current API docs',
            image: 'not assumed',
            search: 'external tools required unless provider docs say otherwise',
            context: 'verify current docs'
        },
        pricingSources: [{ label: 'Moonshot/Kimi pricing', url: 'https://platform.moonshot.ai/docs/pricing/chat' }],
        snippetTerms: ['pricing', 'kimi', 'input', 'output', 'cache', 'tokens', 'moonshot']
    },
    {
        id: 'kimiCode',
        label: 'KimiCode',
        execution: 'Direct harmony_consult_model route through the KimiCode OpenAI-compatible API (api.moonshot.cn) when key is configured.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.kimiCode),
        strengths: ['separate API key path from Moonshot platform', 'same kimi-k2 model line'],
        cautions: ['model names and pricing need source verification', 'base URL uses api.moonshot.cn by default, may differ from Moonshot'],
        capabilities: {
            chat: 'yes when API key/base URL are configured',
            toolCalling: 'verify current API docs',
            vision: 'verify current API docs',
            image: 'not assumed',
            search: 'external tools required',
            context: 'verify current docs'
        },
        pricingSources: [{ label: 'KimiCode pricing', url: 'https://platform.moonshot.ai/docs/pricing/chat' }],
        snippetTerms: ['pricing', 'kimi', 'input', 'output', 'cache', 'tokens', 'kimiCode']
    },
    {
        id: 'alibaba',
        label: 'Alibaba Cloud Model Studio / Qwen',
        execution: 'Direct harmony_consult_model route through the Alibaba DashScope/Model Studio OpenAI-compatible API when key is configured.',
        configuredModels: Object.values(PROVIDER_DEFAULTS.alibaba),
        strengths: ['Qwen models are important for coding/provider diversity', 'candidate for low-cost swarm roles'],
        cautions: ['regional availability, endpoint, and billing pages need explicit verification', 'model IDs vary across accounts/regions; use live model discovery when possible'],
        capabilities: {
            chat: 'yes when API key/base URL are configured',
            toolCalling: 'verify per DashScope/Model Studio API',
            vision: 'model dependent',
            image: 'separate model line; not assumed in registry',
            search: 'external tools required unless provider docs say otherwise',
            context: 'model dependent; verify current docs'
        },
        pricingSources: [{ label: 'Alibaba Cloud Model Studio pricing', url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing' }],
        snippetTerms: ['pricing', 'qwen', 'input', 'output', 'tokens', 'model studio', 'dashscope']
    }
];

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
    return workspaceFoldersByPriority()[0]?.uri.fsPath;
}

function relPath(absPath: string): string {
    const root = workspaceRoot();
    return root ? path.relative(root, absPath).replace(/\\/g, '/') || '.' : absPath;
}

function planOnlyMode(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
}

function section(title: string, body: string | string[]): string {
    return `## ${title}\n\n${Array.isArray(body) ? (body.length ? body.map(item => `- ${item}`).join('\n') : '- (none)') : body}`;
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function htmlTitle(raw: string): string | undefined {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    return match ? stripHtml(match[1]).slice(0, 180) : undefined;
}

function snippetsFor(terms: string[], text: string, maxSnippets: number): string[] {
    const normalizedTerms = Array.from(new Set(terms.map(term => term.toLowerCase()).filter(term => term.length > 2)));
    const chunks = text
        .split(/(?<=[.!?])\s+|\n{2,}/)
        .map(chunk => chunk.trim())
        .filter(chunk => chunk.length >= 40);
    const scored = chunks.map(chunk => {
        const lower = chunk.toLowerCase();
        const score = normalizedTerms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
        return { chunk, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.chunk.length - a.chunk.length);
    const picked = (scored.length ? scored.map(item => item.chunk) : chunks).slice(0, maxSnippets);
    return picked.map(chunk => chunk.length > 900 ? chunk.slice(0, 900) + '...' : chunk);
}

function sha256(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function extractPricingSignals(text: string): ParsedPricingSignal[] {
    const chunks = text
        .split(/(?<=[.!?])\s+|\n+|\s{2,}/)
        .map(chunk => chunk.trim())
        .filter(chunk => /(?:\$|usd|price|pricing|input|output|prompt|completion|cache|image|token)/i.test(chunk));
    const signals: ParsedPricingSignal[] = [];
    for (const chunk of chunks) {
        const matches = Array.from(chunk.matchAll(/(?:(USD|US\$|\$)\s*)([0-9]+(?:\.[0-9]+)?)/gi));
        for (const match of matches) {
            const amount = Number(match[2]);
            if (!Number.isFinite(amount)) continue;
            const lower = chunk.toLowerCase();
            const direction: ParsedPricingSignal['direction'] = /cache|cached/.test(lower)
                ? 'cache'
                : /batch/.test(lower)
                    ? 'batch'
                    : /image|img|picture/.test(lower)
                        ? 'image'
                        : /output|completion|response/.test(lower)
                            ? 'output'
                            : /input|prompt/.test(lower)
                                ? 'input'
                                : 'unknown';
            const unit = /(1m|1 m|million|1,000,000).*token|per\s+million/i.test(chunk)
                ? 'per 1M tokens'
                : /image/i.test(chunk)
                    ? 'per image'
                    : /token/i.test(chunk)
                        ? 'token-related'
                        : 'unknown';
            const model = /\b(deepseek[-\w.]+|gemini[-\w. ]+|gpt[-\w.]+|claude[-\w.]+|qwen[-\w.]+|kimi[-\w.]+|o\d[-\w.]*)\b/i.exec(chunk)?.[1]?.trim();
            signals.push({
                amount,
                currency: match[1]?.toUpperCase() === 'USD' ? 'USD' : 'USD',
                unit,
                direction,
                model,
                context: chunk.slice(0, 500),
            });
            if (signals.length >= 40) return signals;
        }
    }
    return signals;
}

async function readJsonFile<T>(absPath: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.readFile(absPath, 'utf8')) as T; } catch { return undefined; }
}

function pricingDir(root: string): string {
    return path.join(root, PRICING_DIR);
}

async function readLatestSnapshot(): Promise<PricingSnapshot | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    return readJsonFile<PricingSnapshot>(path.join(pricingDir(root), 'latest.json'));
}

function selectedProviders(inputProviders?: string[], fallbackAll = true): ProviderRegistryEntry[] {
    if (!inputProviders || inputProviders.length === 0) return fallbackAll ? PROVIDER_REGISTRY : [];
    const wanted = new Set(inputProviders.map(provider => provider.trim().toLowerCase()).filter(Boolean));
    return PROVIDER_REGISTRY.filter(provider => wanted.has(provider.id) || wanted.has(provider.label.toLowerCase()));
}

function snapshotAge(snapshot?: PricingSnapshot): string {
    if (!snapshot) return 'No local pricing snapshot found. Run harmony_pricing_refresh before making cost-sensitive routing choices.';
    const ageMs = Date.now() - new Date(snapshot.fetchedAt).getTime();
    if (!Number.isFinite(ageMs)) return `Latest pricing snapshot: ${snapshot.fetchedAt} (age unknown; refresh recommended).`;
    const ageDays = ageMs / 86400000;
    const stale = ageDays > snapshot.staleAfterDays ? 'stale; refresh before quoting costs' : 'fresh enough for rough routing';
    return `Latest pricing snapshot: ${snapshot.fetchedAt} (${ageDays < 1 ? `${Math.max(0, ageDays * 24).toFixed(1)} hours old` : `${ageDays.toFixed(1)} days old`}; ${stale}).`;
}

function snapshotSourcesFor(snapshot: PricingSnapshot | undefined, provider: RegistryProviderId): PricingSourceFetch[] {
    return snapshot?.sources.filter(source => source.provider === provider) ?? [];
}

async function fetchPricingSource(provider: ProviderRegistryEntry, source: PricingSource, maxChars: number, timeoutMs: number, token: vscode.CancellationToken): Promise<PricingSourceFetch> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const sub = token.onCancellationRequested(() => controller.abort());
    const fetchedAt = new Date().toISOString();
    try {
        const response = await fetch(source.url, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.8,*/*;q=0.5',
                'User-Agent': 'HarmonyExtension/0.2 provider-pricing-refresh'
            },
            signal: controller.signal as any
        });
        const raw = await response.text();
        const contentType = response.headers.get('content-type') ?? '';
        const text = contentType.includes('html') ? stripHtml(raw) : raw.replace(/\s+/g, ' ').trim();
        const retained = text.slice(0, maxChars);
        return {
            provider: provider.id,
            label: source.label,
            url: source.url,
            finalUrl: response.url || source.url,
            fetchedAt,
            ok: response.ok,
            status: response.status,
            contentType,
            lastModified: response.headers.get('last-modified') ?? undefined,
            title: contentType.includes('html') ? htmlTitle(raw) : undefined,
            sha256: sha256(raw),
            snippets: snippetsFor(provider.snippetTerms, retained, 10),
            pricingSignals: extractPricingSignals(retained),
            error: response.ok ? undefined : `HTTP ${response.status}`
        };
    } catch (error: any) {
        return {
            provider: provider.id,
            label: source.label,
            url: source.url,
            finalUrl: source.url,
            fetchedAt,
            ok: false,
            status: 0,
            contentType: '',
            sha256: '',
            snippets: [],
            pricingSignals: [],
            error: error?.name === 'AbortError' ? 'Fetch timed out or was cancelled.' : (error?.message ?? String(error))
        };
    } finally {
        clearTimeout(timeout);
        sub.dispose();
    }
}

async function writeSnapshot(snapshot: PricingSnapshot): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) return undefined;
    const dir = pricingDir(root);
    await fs.mkdir(dir, { recursive: true });
    const filename = `provider-pricing-${snapshot.fetchedAt.replace(/[:.]/g, '-')}.json`;
    const absPath = path.join(dir, filename);
    const payload = JSON.stringify(snapshot, null, 2);
    await fs.writeFile(absPath, payload, 'utf8');
    await fs.writeFile(path.join(dir, 'latest.json'), payload, 'utf8');
    return relPath(absPath);
}

function formatProvider(provider: ProviderRegistryEntry, snapshot?: PricingSnapshot): string {
    const sources = snapshotSourcesFor(snapshot, provider.id);
    const sourceRows = sources.length
        ? sources.map(source => `${source.ok ? 'ok' : 'failed'} ${source.label}: HTTP ${source.status || 'n/a'} fetched ${source.fetchedAt}${source.error ? ` (${source.error})` : ''}`)
        : provider.pricingSources.map(source => `not fetched yet: ${source.label} - ${source.url}`);
    return [
        `### ${provider.label}`,
        '',
        `Provider id: ${provider.id}`,
        `Execution: ${provider.execution}`,
        `Configured models: ${Array.from(new Set(provider.configuredModels)).join(', ')}`,
        '',
        section('Capabilities', [
            `chat: ${provider.capabilities.chat}`,
            `tool calling: ${provider.capabilities.toolCalling}`,
            `vision: ${provider.capabilities.vision}`,
            `image: ${provider.capabilities.image}`,
            `search: ${provider.capabilities.search}`,
            `context: ${provider.capabilities.context}`,
        ]),
        '',
        section('Strengths', provider.strengths),
        '',
        section('Cost / Safety Cautions', provider.cautions),
        '',
        section('Pricing Sources', provider.pricingSources.map(source => `${source.label}: ${source.url}`)),
        '',
        section('Latest Source Status', sourceRows),
    ].join('\n');
}

function formatSnapshot(snapshot: PricingSnapshot, writtenPath?: string, skippedWrite?: string): string {
    const sourceRows = snapshot.sources.map(source => {
        const title = source.title ? ` - ${source.title}` : '';
        return `${source.ok ? 'ok' : 'failed'} ${source.provider}: ${source.label} HTTP ${source.status || 'n/a'}${title}${source.error ? ` (${source.error})` : ''}`;
    });
    const snippets = snapshot.sources.flatMap(source => {
        if (!source.snippets.length) return [`${source.provider}/${source.label}: no pricing snippets extracted.`];
        return source.snippets.slice(0, 3).map(snippet => `${source.provider}/${source.label}: ${snippet}`);
    });
    const structuredSignals = snapshot.sources.flatMap(source =>
        source.pricingSignals.slice(0, 8).map(signal => `${source.provider}: ${signal.model ? `${signal.model} ` : ''}${signal.direction} ${signal.currency} ${signal.amount} ${signal.unit} - ${signal.context}`)
    );
    return [
        '# Harmony Provider Pricing Refresh',
        '',
        `Fetched: ${snapshot.fetchedAt}`,
        `Providers: ${snapshot.providers.join(', ')}`,
        writtenPath ? `Snapshot written: ${writtenPath}` : (skippedWrite ?? 'Snapshot was not written.'),
        '',
        section('Source Status', sourceRows),
        '',
        section('Extracted Pricing Signals', snippets),
        '',
        section('Structured Numeric Price Candidates', structuredSignals.length ? structuredSignals : ['No structured numeric price candidates extracted. Use snippets/source page for manual verification.']),
        '',
        section('Use Notes', [
            'Structured numeric price candidates are parser hints, not final billing truth. Verify exact row/model/region before quoting costs.',
            'Refresh before premium, long-context, extended-thinking, image, video, batch, or swarm work.',
            'Treat failed fetches as blockers for cost quotes on that provider.'
        ])
    ].join('\n');
}

class ProviderStatusTool implements vscode.LanguageModelTool<ProviderStatusInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ProviderStatusInput>): Promise<vscode.LanguageModelToolResult> {
        const providers = selectedProviders(options.input.provider ? [options.input.provider] : undefined);
        const snapshot = options.input.include_pricing_snapshot === false ? undefined : await readLatestSnapshot();
        if (options.input.format === 'json') {
            return textResult(JSON.stringify({
                generatedAt: new Date().toISOString(),
                staleAfterDays: STALE_AFTER_DAYS,
                latestPricingSnapshot: snapshot,
                providers
            }, null, 2));
        }
        const body = [
            '# Harmony Provider Status',
            '',
            snapshotAge(snapshot),
            '',
            section('Routing Principle', [
                'Use low-cost/default routes for routine work and reserve premium reasoning, long context, image, video, and swarm fan-out for explicit need.',
                'Provider registry status is advisory; execution still depends on configured API keys, current model availability, and Harmony tool support.',
                'OpenRouter, Moonshot, Alibaba, and preview models should be refreshed before budgeting because availability and prices move quickly.'
            ]),
            '',
            providers.map(provider => formatProvider(provider, snapshot)).join('\n\n')
        ].join('\n');
        return textResult(body);
    }

    async prepareInvocation() { return { invocationMessage: 'Checking provider registry and pricing freshness' }; }
}

class PricingRefreshTool implements vscode.LanguageModelTool<PricingRefreshInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PricingRefreshInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const providers = selectedProviders(options.input.providers);
        if (options.input.providers && providers.length === 0) {
            return textResult(`error: no supported providers matched: ${options.input.providers.join(', ')}`);
        }
        const maxChars = Math.max(2000, Math.min(50000, Math.floor(options.input.max_chars_per_source ?? 16000)));
        const timeoutMs = Math.max(3000, Math.min(60000, Math.floor(options.input.timeout_ms ?? 15000)));
        const sources: PricingSourceFetch[] = [];
        for (const provider of providers) {
            for (const source of provider.pricingSources) {
                sources.push(await fetchPricingSource(provider, source, maxChars, timeoutMs, token));
            }
        }
        const snapshot: PricingSnapshot = {
            version: 1,
            fetchedAt: new Date().toISOString(),
            staleAfterDays: STALE_AFTER_DAYS,
            providers: providers.map(provider => provider.id),
            sources
        };
        const shouldWrite = options.input.write_snapshot !== false && !planOnlyMode();
        let writtenPath: string | undefined;
        let skippedWrite: string | undefined;
        if (shouldWrite) {
            writtenPath = await writeSnapshot(snapshot);
            skippedWrite = writtenPath ? undefined : 'Snapshot was not written because no workspace root is open.';
        } else {
            skippedWrite = planOnlyMode() && options.input.write_snapshot !== false
                ? 'Plan-only mode is enabled; snapshot write was skipped.'
                : 'Snapshot write disabled by input.';
        }
        if (options.input.format === 'json') {
            return textResult(JSON.stringify({ snapshot, writtenPath, skippedWrite }, null, 2));
        }
        return textResult(formatSnapshot(snapshot, writtenPath, skippedWrite));
    }

    async prepareInvocation() { return { invocationMessage: 'Refreshing provider pricing sources' }; }
}

export function registerProviderRegistryTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_provider_status', new ProviderStatusTool()),
        vscode.lm.registerTool('harmony_pricing_refresh', new PricingRefreshTool()),
    );
}