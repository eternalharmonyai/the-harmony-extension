/**
 * Harmony WordPress & Shared Hosting (Bluehost / cPanel) Diagnostic & REST Tools.
 *
 * Host-agnostic pure-Node functions plus thin VS Code LanguageModelTool wrappers:
 *   1. harmony_wp_site_diagnostic — Read-only WordPress & shared hosting probe
 *      (TTFB, Bluehost/Endurance/Cloudflare/LiteSpeed cache headers, /wp-json/
 *      discovery, /wp-login.php redirect behavior, /xmlrpc.php brute-force
 *      exposure, /wp-cron.php status, active theme & plugin slugs, mixed content,
 *      and WP fatal/DB error detection).
 *   2. harmony_wp_rest_client     — Authenticated WordPress REST API client using
 *      Application Passwords (HARMONY_WP_APP_PASSWORD / HARMONY_WP_USERNAME) with
 *      dry_run=true default for mutations and core setting safety guards.
 */
import * as vscode from 'vscode';
import { clipResult } from './toolResultCap';

export interface WpSiteDiagnosticInput {
    site_url: string;
    check_endpoints?: boolean;
    check_assets?: boolean;
    timeout_ms?: number;
}

export type WpRestAction =
    | 'site_info'
    | 'posts'
    | 'pages'
    | 'plugins'
    | 'themes'
    | 'users_me'
    | 'site_health'
    | 'custom';

export interface WpRestClientInput {
    site_url: string;
    action: WpRestAction;
    endpoint?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, unknown>;
    username?: string;
    app_password_env?: string;
    dry_run?: boolean;
    timeout_ms?: number;
}

const BLOCKED_WP_SETTINGS = new Set([
    'siteurl',
    'home',
    'users_can_register',
    'default_role',
    'admin_email',
]);

function clampTimeout(ms?: number, def = 10000): number {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return def;
    return Math.min(30000, Math.max(1000, Math.floor(ms)));
}

export function normalizeWpSiteUrl(raw: string): string {
    const trimmed = String(raw || '').trim();
    if (!trimmed) throw new Error('site_url is required');
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    const cleanPath = u.pathname
        .replace(/\/wp-admin(\/.*)?$/i, '')
        .replace(/\/wp-login\.php$/i, '')
        .replace(/\/wp-cron\.php$/i, '')
        .replace(/\/xmlrpc\.php$/i, '')
        .replace(/\/wp-json(\/.*)?$/i, '')
        .replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${cleanPath}`;
}

async function fetchProbe(
    url: string,
    opts: { method?: string; timeoutMs: number; redirect?: 'follow' | 'error' | 'manual'; headers?: Record<string, string>; body?: string; maxBodyChars?: number }
): Promise<{
    url: string;
    ok: boolean;
    status?: number;
    statusText?: string;
    ttfbMs: number;
    headers: Record<string, string>;
    body?: string;
    error?: string;
}> {
    const started = Date.now();
    try {
        const resp = await fetch(url, {
            method: opts.method ?? 'GET',
            redirect: opts.redirect ?? 'manual',
            signal: AbortSignal.timeout(opts.timeoutMs),
            headers: {
                'User-Agent': 'Harmony-WP-Diagnostic/1.0',
                'Accept': 'text/html,application/json,*/*',
                ...(opts.headers ?? {}),
            },
            body: opts.body,
        });
        const ttfbMs = Date.now() - started;
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        let body: string | undefined;
        if ((opts.maxBodyChars ?? 0) > 0) {
            const rawText = await resp.text();
            body = rawText.slice(0, opts.maxBodyChars);
        } else {
            try { resp.body?.cancel()?.catch(() => {}); } catch { /* ignore */ }
        }
        return {
            url,
            ok: true,
            status: resp.status,
            statusText: resp.statusText,
            ttfbMs,
            headers,
            body,
        };
    } catch (e: any) {
        return {
            url,
            ok: false,
            ttfbMs: Date.now() - started,
            headers: {},
            error: e?.message || String(e),
        };
    }
}

function analyzeWpHomepageHtml(html: string, isHttps: boolean): Record<string, unknown> {
    const generatorMatch = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(html)
        || /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i.exec(html);
    const wpGenerator = generatorMatch ? generatorMatch[1].trim() : null;

    const themeSlugs = new Set<string>();
    const themeRe = /\/wp-content\/themes\/([a-zA-Z0-9._-]+)\//g;
    let m: RegExpExecArray | null;
    while ((m = themeRe.exec(html)) !== null && themeSlugs.size < 10) {
        themeSlugs.add(m[1]);
    }

    const pluginSlugs = new Set<string>();
    const pluginRe = /\/wp-content\/plugins\/([a-zA-Z0-9._-]+)\//g;
    while ((m = pluginRe.exec(html)) !== null && pluginSlugs.size < 50) {
        pluginSlugs.add(m[1]);
    }

    const mixedContentUrls: string[] = [];
    if (isHttps) {
        const mixedRe = /(?:src|href)=["'](http:\/\/[^"'\s>]+)["']/gi;
        while ((m = mixedRe.exec(html)) !== null && mixedContentUrls.length < 15) {
            const u = m[1];
            if (/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|ttf)(\?|$)/i.test(u) || u.includes('/wp-content/') || u.includes('/wp-includes/')) {
                mixedContentUrls.push(u);
            }
        }
    }

    const errorSignatures: string[] = [];
    const knownErrors: Array<[RegExp, string]> = [
        [/Error establishing a database connection/i, 'Database connection failure (check wp-config.php DB credentials & MySQL status in Bluehost/cPanel)'],
        [/There has been a critical error on this website/i, 'WordPress PHP fatal error recovery screen (enable WP_DEBUG_LOG or inspect error_log)'],
        [/Briefly unavailable for scheduled maintenance/i, 'Stuck .maintenance file in WordPress root directory'],
        [/Allowed memory size of \d+ bytes exhausted/i, 'PHP memory_limit exhausted (increase WP_MEMORY_LIMIT / php.ini memory_limit)'],
        [/502 Bad Gateway|504 Gateway Time-out/i, 'Upstream PHP-FPM / origin timeout behind proxy/CDN'],
    ];
    for (const [re, desc] of knownErrors) {
        if (re.test(html)) errorSignatures.push(desc);
    }

    return {
        wpGenerator,
        activeThemes: [...themeSlugs],
        detectedPlugins: [...pluginSlugs],
        mixedContentCount: mixedContentUrls.length,
        mixedContentSample: mixedContentUrls,
        errorSignatures,
    };
}

export async function runWpSiteDiagnostic(input: WpSiteDiagnosticInput): Promise<Record<string, unknown>> {
    const timeoutMs = clampTimeout(input.timeout_ms, 10000);
    const baseUrl = normalizeWpSiteUrl(input.site_url);
    const isHttps = baseUrl.startsWith('https://');

    const home = await fetchProbe(baseUrl, {
        method: 'GET',
        redirect: 'follow',
        timeoutMs,
        maxBodyChars: 500_000,
    });

    const hostingFingerprint: Record<string, string | null> = {
        server: home.headers['server'] ?? null,
        xPoweredBy: home.headers['x-powered-by'] ?? null,
        cfRay: home.headers['cf-ray'] ?? null,
        cfCacheStatus: home.headers['cf-cache-status'] ?? null,
        enduranceCacheLevel: home.headers['x-endurance-cache-level'] ?? null,
        litespeedCache: home.headers['x-litespeed-cache'] ?? null,
        kinstaCache: home.headers['x-kinsta-cache'] ?? null,
        wpeBackend: home.headers['x-wpe-backend'] ?? null,
        xCache: home.headers['x-cache'] ?? null,
        linkHeader: home.headers['link'] ?? null,
    };

    const inferredHost = hostingFingerprint.enduranceCacheLevel !== null
        ? 'Bluehost / Newfold Digital (Endurance Page Cache detected)'
        : hostingFingerprint.litespeedCache !== null
            ? 'LiteSpeed Web Server / Shared Hosting'
            : hostingFingerprint.wpeBackend !== null
                ? 'WP Engine'
                : hostingFingerprint.kinstaCache !== null
                    ? 'Kinsta'
                    : hostingFingerprint.cfRay !== null
                        ? 'Cloudflare-proxied origin'
                        : hostingFingerprint.server ?? 'Unknown hosting stack';

    const htmlAnalysis = home.body ? analyzeWpHomepageHtml(home.body, isHttps) : null;

    let endpoints: Record<string, unknown> | null = null;
    if (input.check_endpoints !== false) {
        const [wpJson, wpLogin, xmlrpc, wpCron] = await Promise.all([
            fetchProbe(`${baseUrl}/wp-json/`, { method: 'GET', redirect: 'follow', timeoutMs, maxBodyChars: 250_000 }),
            fetchProbe(`${baseUrl}/wp-login.php`, { method: 'GET', redirect: 'manual', timeoutMs, maxBodyChars: 20_000 }),
            fetchProbe(`${baseUrl}/xmlrpc.php`, { method: 'GET', redirect: 'manual', timeoutMs, maxBodyChars: 5_000 }),
            fetchProbe(`${baseUrl}/wp-cron.php`, { method: 'GET', redirect: 'manual', timeoutMs, maxBodyChars: 2_000 }),
        ]);

        let restMeta: Record<string, unknown> = { status: wpJson.status, ttfbMs: wpJson.ttfbMs };
        if (wpJson.body) {
            try {
                const parsed = JSON.parse(wpJson.body);
                restMeta = {
                    status: wpJson.status,
                    ttfbMs: wpJson.ttfbMs,
                    name: parsed.name ?? null,
                    description: parsed.description ?? null,
                    url: parsed.url ?? null,
                    home: parsed.home ?? null,
                    gmtOffset: parsed.gmt_offset ?? null,
                    timezoneString: parsed.timezone_string ?? null,
                    namespaces: Array.isArray(parsed.namespaces) ? parsed.namespaces.slice(0, 40) : [],
                };
            } catch {
                restMeta.parseError = 'Non-JSON response on /wp-json/';
            }
        }

        const xmlrpcExposed = xmlrpc.status === 405 || (xmlrpc.body ?? '').includes('XML-RPC server accepts POST requests only');

        endpoints = {
            wpJson: restMeta,
            wpLogin: {
                status: wpLogin.status,
                ttfbMs: wpLogin.ttfbMs,
                location: wpLogin.headers['location'] ?? null,
            },
            xmlRpc: {
                status: xmlrpc.status,
                ttfbMs: xmlrpc.ttfbMs,
                exposed: xmlrpcExposed,
                recommendation: xmlrpcExposed
                    ? 'XML-RPC is publicly enabled (status 405 / POST accepted). Consider disabling XML-RPC or blocking /xmlrpc.php via .htaccess / Cloudflare WAF to prevent brute-force amplification.'
                    : 'XML-RPC appears restricted or disabled.',
            },
            wpCron: {
                status: wpCron.status,
                ttfbMs: wpCron.ttfbMs,
            },
        };
    }

    return {
        siteUrl: baseUrl,
        timestamp: new Date().toISOString(),
        homepage: {
            ok: home.ok,
            status: home.status,
            ttfbMs: home.ttfbMs,
            inferredHostingStack: inferredHost,
            hostingFingerprint,
            error: home.error ?? null,
        },
        htmlAnalysis,
        endpoints,
    };
}

function resolveRestEndpoint(action: WpRestAction, customEndpoint?: string): string {
    switch (action) {
        case 'site_info': return '/wp-json/';
        case 'posts': return customEndpoint || '/wp-json/wp/v2/posts?per_page=10';
        case 'pages': return customEndpoint || '/wp-json/wp/v2/pages?per_page=10';
        case 'plugins': return customEndpoint || '/wp-json/wp/v2/plugins';
        case 'themes': return customEndpoint || '/wp-json/wp/v2/themes';
        case 'users_me': return '/wp-json/wp/v2/users/me?context=edit';
        case 'site_health': return customEndpoint || '/wp-json/wp-site-health/v1/tests/background-updates';
        case 'custom': {
            if (!customEndpoint || !customEndpoint.trim()) {
                throw new Error('endpoint is required when action is "custom" (e.g. "/wp-json/wp/v2/settings")');
            }
            const clean = customEndpoint.trim();
            return clean.startsWith('/wp-json') ? clean : `/wp-json/${clean.replace(/^\/+/, '')}`;
        }
    }
}

export async function runWpRestClient(input: WpRestClientInput): Promise<Record<string, unknown>> {
    const baseUrl = normalizeWpSiteUrl(input.site_url);
    const method = (input.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE';
    const isMutation = method !== 'GET';
    const dryRun = input.dry_run ?? isMutation;
    const timeoutMs = clampTimeout(input.timeout_ms, 15000);
    const relEndpoint = resolveRestEndpoint(input.action, input.endpoint);
    const targetUrl = `${baseUrl}${relEndpoint.startsWith('/') ? '' : '/'}${relEndpoint}`;

    if (isMutation && input.body && typeof input.body === 'object') {
        for (const key of Object.keys(input.body)) {
            if (BLOCKED_WP_SETTINGS.has(key.toLowerCase())) {
                return {
                    ok: false,
                    blocked: true,
                    reason: `Modifying core WordPress setting "${key}" is blocked by Harmony safety guard to prevent accidental site lockout.`,
                };
            }
        }
    }

    const user = input.username || process.env.HARMONY_WP_USERNAME || '';
    const passEnvName = input.app_password_env || 'HARMONY_WP_APP_PASSWORD';
    const appPassword = process.env[passEnvName] || '';

    if (dryRun && isMutation) {
        return {
            ok: true,
            dryRun: true,
            method,
            targetUrl,
            authConfigured: Boolean(user && appPassword),
            bodyPreview: input.body ?? null,
            note: 'dry_run is enabled (default for non-GET requests). Pass dry_run: false to execute this WordPress REST mutation.',
        };
    }

    const headers: Record<string, string> = {};
    if (user && appPassword) {
        const token = Buffer.from(`${user}:${appPassword}`, 'utf8').toString('base64');
        headers['Authorization'] = `Basic ${token}`;
    }
    if (input.body && isMutation) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetchProbe(targetUrl, {
        method,
        redirect: 'follow',
        timeoutMs,
        headers,
        body: (input.body && isMutation) ? JSON.stringify(input.body) : undefined,
        maxBodyChars: 40_000,
    });

    let parsedBody: unknown = res.body ?? null;
    if (res.body) {
        try { parsedBody = JSON.parse(res.body); } catch { /* leave as string */ }
    }

    return {
        ok: res.ok && (res.status ?? 500) < 400,
        status: res.status,
        statusText: res.statusText,
        ttfbMs: res.ttfbMs,
        targetUrl,
        authUsed: Boolean(user && appPassword),
        wpTotal: res.headers['x-wp-total'] ?? null,
        wpTotalPages: res.headers['x-wp-totalpages'] ?? null,
        data: parsedBody,
        error: res.error ?? null,
    };
}

function textResult(data: unknown): vscode.LanguageModelToolResult {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clipResult(text))]);
}

export class WpSiteDiagnosticTool implements vscode.LanguageModelTool<WpSiteDiagnosticInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<WpSiteDiagnosticInput>): Promise<vscode.LanguageModelToolResult> {
        try {
            const report = await runWpSiteDiagnostic(options.input);
            return textResult(report);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WpSiteDiagnosticInput>) {
        return { invocationMessage: `Diagnosing WordPress / shared hosting site: ${options.input.site_url || 'site'}...` };
    }
}

export class WpRestClientTool implements vscode.LanguageModelTool<WpRestClientInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<WpRestClientInput>): Promise<vscode.LanguageModelToolResult> {
        try {
            const report = await runWpRestClient(options.input);
            return textResult(report);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WpRestClientInput>) {
        const method = (options.input.method ?? 'GET').toUpperCase();
        const isMutation = method !== 'GET' && options.input.dry_run === false;
        return {
            invocationMessage: `Calling WordPress REST API (${options.input.action}) on ${options.input.site_url}...`,
            ...(isMutation ? {
                confirmationMessages: {
                    title: 'Execute WordPress REST API mutation?',
                    message: new vscode.MarkdownString(`Harmony wants to send a **${method}** request to \`${options.input.site_url}\` (${options.input.action}).`),
                }
            } : {}),
        };
    }
}

export function registerWpHostingTools(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_wp_site_diagnostic', new WpSiteDiagnosticTool()),
        vscode.lm.registerTool('harmony_wp_rest_client', new WpRestClientTool()),
    );
}
