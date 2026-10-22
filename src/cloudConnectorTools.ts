/**
 * Harmony Multi-Cloud & BaaS Connector Tool (harmony_cloud_connector).
 *
 * Host-agnostic pure-Node diagnostic & API connector for:
 *   - Supabase   (project_health, openapi_tables + RLS exposure check, edge_function_probe)
 *   - Cloudflare (verify_token, zones_list, dns_records, ssl_setting)
 *   - Netlify    (sites_list, deploys_list, site_status)
 *   - Firebase   (hosting_site_probe, firestore_rules_probe)
 *   - GCP        (gcp_api_enablement — including Vertex / Agent Platform aiplatform.googleapis.com
 *                 enablement URL + gcloud command, and cloud_run_probe)
 *
 * Zero credential leakage: API tokens are read from environment variables and
 * never echoed in tool outputs.
 */
import * as vscode from 'vscode';
import { clipResult } from './toolResultCap';

export type CloudProvider = 'supabase' | 'cloudflare' | 'netlify' | 'firebase' | 'gcp';

export interface CloudConnectorInput {
    provider: CloudProvider;
    action: string;
    project_id?: string;
    target?: string;
    api_service?: string;
    token_env?: string;
    dry_run?: boolean;
    timeout_ms?: number;
}

const DEFAULT_TOKEN_ENV: Record<CloudProvider, string[]> = {
    supabase: ['SUPABASE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    cloudflare: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
    netlify: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_TOKEN'],
    firebase: ['FIREBASE_TOKEN', 'GOOGLE_API_KEY'],
    gcp: ['GCP_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN'],
};

function clampTimeout(ms?: number, def = 10000): number {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return def;
    return Math.min(30000, Math.max(1000, Math.floor(ms)));
}

function resolveCloudToken(provider: CloudProvider, explicitEnv?: string): { token?: string; sourceEnv?: string } {
    const candidates = explicitEnv ? [explicitEnv] : (DEFAULT_TOKEN_ENV[provider] ?? []);
    for (const envName of candidates) {
        const val = process.env[envName];
        if (val && val.trim()) {
            return { token: val.trim(), sourceEnv: envName };
        }
    }
    return {};
}

async function jsonFetch(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; timeoutMs: number }
): Promise<{ ok: boolean; status?: number; ms: number; headers: Record<string, string>; data?: any; rawText?: string; error?: string }> {
    const started = Date.now();
    try {
        const resp = await fetch(url, {
            method: opts.method ?? 'GET',
            headers: {
                'User-Agent': 'Harmony-Cloud-Connector/1.0',
                'Accept': 'application/json',
                ...(opts.headers ?? {}),
            },
            signal: AbortSignal.timeout(opts.timeoutMs),
        });
        const ms = Date.now() - started;
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const text = (await resp.text()).slice(0, 50_000);
        let data: any;
        try { data = JSON.parse(text); } catch { /* leave undefined */ }
        return {
            ok: resp.ok,
            status: resp.status,
            ms,
            headers,
            data,
            rawText: data === undefined ? text.slice(0, 4000) : undefined,
        };
    } catch (e: any) {
        return {
            ok: false,
            ms: Date.now() - started,
            headers: {},
            error: e?.message || String(e),
        };
    }
}

function normalizeSupabaseBaseUrl(input: CloudConnectorInput): string {
    const raw = (input.target || input.project_id || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
    if (!raw) {
        throw new Error('Supabase requires target (https://<ref>.supabase.co) or project_id (<ref>) or SUPABASE_URL env var.');
    }
    if (/^https?:\/\//i.test(raw)) {
        return raw.replace(/\/+$/, '');
    }
    return `https://${raw.replace(/\.supabase\.co$/i, '')}.supabase.co`;
}

async function handleSupabase(input: CloudConnectorInput, timeoutMs: number): Promise<Record<string, unknown>> {
    const baseUrl = normalizeSupabaseBaseUrl(input);
    const { token, sourceEnv } = resolveCloudToken('supabase', input.token_env);
    const authHeaders: Record<string, string> = token
        ? { apikey: token, Authorization: `Bearer ${token}` }
        : {};

    switch (input.action) {
        case 'project_health': {
            const [authHealth, restRoot] = await Promise.all([
                jsonFetch(`${baseUrl}/auth/v1/health`, { headers: authHeaders, timeoutMs }),
                jsonFetch(`${baseUrl}/rest/v1/`, { headers: authHeaders, timeoutMs }),
            ]);
            return {
                provider: 'supabase',
                action: 'project_health',
                baseUrl,
                tokenPresent: Boolean(token),
                tokenSourceEnv: sourceEnv ?? null,
                authHealth: {
                    ok: authHealth.ok,
                    status: authHealth.status,
                    ms: authHealth.ms,
                    data: authHealth.data ?? authHealth.rawText ?? null,
                    error: authHealth.error ?? null,
                },
                restEndpoint: {
                    ok: restRoot.ok,
                    status: restRoot.status,
                    ms: restRoot.ms,
                    error: restRoot.error ?? null,
                },
            };
        }
        case 'openapi_tables': {
            const spec = await jsonFetch(`${baseUrl}/rest/v1/`, {
                headers: { ...authHeaders, Accept: 'application/openapi+json,application/json' },
                timeoutMs,
            });
            const pathsObj = spec.data?.paths && typeof spec.data.paths === 'object' ? spec.data.paths : {};
            const tables = Object.keys(pathsObj)
                .filter(p => p !== '/' && !p.startsWith('/rpc/'))
                .map(p => p.replace(/^\/+/, ''));
            const rpcs = Object.keys(pathsObj)
                .filter(p => p.startsWith('/rpc/'))
                .map(p => p.replace(/^\/rpc\//, ''));
            return {
                provider: 'supabase',
                action: 'openapi_tables',
                baseUrl,
                status: spec.status,
                ms: spec.ms,
                tokenSourceEnv: sourceEnv ?? null,
                exposedTableCount: tables.length,
                exposedTables: tables.slice(0, 60),
                exposedRpcCount: rpcs.length,
                exposedRpcs: rpcs.slice(0, 40),
                securityNote: tables.length > 0
                    ? 'Verify Row Level Security (RLS) is enabled on all public schema tables exposed via PostgREST.'
                    : 'No tables listed in PostgREST OpenAPI schema (or anon key required).',
            };
        }
        case 'edge_function_probe': {
            const fnName = (input.api_service || '').trim();
            if (!fnName) throw new Error('api_service (Edge Function slug) is required for edge_function_probe');
            const fnUrl = `${baseUrl}/functions/v1/${fnName.replace(/^\/+/, '')}`;
            const probe = await jsonFetch(fnUrl, { method: 'OPTIONS', headers: authHeaders, timeoutMs });
            return {
                provider: 'supabase',
                action: 'edge_function_probe',
                functionUrl: fnUrl,
                status: probe.status,
                ms: probe.ms,
                corsAllowOrigin: probe.headers['access-control-allow-origin'] ?? null,
                error: probe.error ?? null,
            };
        }
        default:
            throw new Error(`Unsupported Supabase action "${input.action}". Supported: project_health, openapi_tables, edge_function_probe`);
    }
}

async function handleCloudflare(input: CloudConnectorInput, timeoutMs: number): Promise<Record<string, unknown>> {
    const { token, sourceEnv } = resolveCloudToken('cloudflare', input.token_env);
    if (!token) {
        return {
            provider: 'cloudflare',
            action: input.action,
            ok: false,
            tokenPresent: false,
            note: 'Set CLOUDFLARE_API_TOKEN (or pass token_env) to query Cloudflare API v4 endpoints.',
        };
    }
    const headers = { Authorization: `Bearer ${token}` };
    const apiBase = 'https://api.cloudflare.com/client/v4';

    switch (input.action) {
        case 'verify_token': {
            const res = await jsonFetch(`${apiBase}/user/tokens/verify`, { headers, timeoutMs });
            return {
                provider: 'cloudflare',
                action: 'verify_token',
                ok: res.ok && Boolean(res.data?.success),
                status: res.status,
                ms: res.ms,
                tokenSourceEnv: sourceEnv,
                result: res.data?.result ?? null,
                errors: res.data?.errors ?? null,
            };
        }
        case 'zones_list': {
            const res = await jsonFetch(`${apiBase}/zones?per_page=20`, { headers, timeoutMs });
            const zones = Array.isArray(res.data?.result)
                ? res.data.result.map((z: any) => ({
                    id: z.id,
                    name: z.name,
                    status: z.status,
                    plan: z.plan?.name ?? null,
                    nameServers: z.name_servers ?? [],
                }))
                : [];
            return {
                provider: 'cloudflare',
                action: 'zones_list',
                ok: res.ok && Boolean(res.data?.success),
                status: res.status,
                ms: res.ms,
                zoneCount: zones.length,
                zones,
            };
        }
        case 'dns_records': {
            const zoneId = (input.project_id || input.target || '').trim();
            if (!zoneId) throw new Error('project_id or target (Cloudflare Zone ID) is required for dns_records');
            const res = await jsonFetch(`${apiBase}/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=50`, { headers, timeoutMs });
            const records = Array.isArray(res.data?.result)
                ? res.data.result.map((r: any) => ({
                    id: r.id,
                    type: r.type,
                    name: r.name,
                    content: r.content,
                    proxied: r.proxied,
                    ttl: r.ttl,
                }))
                : [];
            return {
                provider: 'cloudflare',
                action: 'dns_records',
                zoneId,
                ok: res.ok && Boolean(res.data?.success),
                recordCount: records.length,
                records,
            };
        }
        case 'ssl_setting': {
            const zoneId = (input.project_id || input.target || '').trim();
            if (!zoneId) throw new Error('project_id or target (Cloudflare Zone ID) is required for ssl_setting');
            const res = await jsonFetch(`${apiBase}/zones/${encodeURIComponent(zoneId)}/settings/ssl`, { headers, timeoutMs });
            return {
                provider: 'cloudflare',
                action: 'ssl_setting',
                zoneId,
                ok: res.ok && Boolean(res.data?.success),
                sslMode: res.data?.result?.value ?? null,
                modifiedOn: res.data?.result?.modified_on ?? null,
                recommendation: res.data?.result?.value === 'flexible'
                    ? 'Cloudflare SSL is set to "flexible", which can cause HTTPS redirect loops with WordPress/Bluehost origins that enforce HTTPS. Switch to "Full (strict)" when a valid origin certificate is installed.'
                    : null,
            };
        }
        default:
            throw new Error(`Unsupported Cloudflare action "${input.action}". Supported: verify_token, zones_list, dns_records, ssl_setting`);
    }
}

async function handleNetlify(input: CloudConnectorInput, timeoutMs: number): Promise<Record<string, unknown>> {
    const { token, sourceEnv } = resolveCloudToken('netlify', input.token_env);
    const apiBase = 'https://api.netlify.com/api/v1';

    if (input.action === 'site_status' && input.target) {
        const url = /^https?:\/\//i.test(input.target) ? input.target : `https://${input.target}`;
        const res = await jsonFetch(url, { timeoutMs });
        return {
            provider: 'netlify',
            action: 'site_status',
            target: url,
            ok: res.ok,
            status: res.status,
            ms: res.ms,
            nfRequestId: res.headers['x-nf-request-id'] ?? null,
            server: res.headers['server'] ?? null,
            cacheStatus: res.headers['cache-status'] ?? null,
        };
    }

    if (!token) {
        return {
            provider: 'netlify',
            action: input.action,
            ok: false,
            tokenPresent: false,
            note: 'Set NETLIFY_AUTH_TOKEN (or pass token_env) to query Netlify REST API endpoints.',
        };
    }
    const headers = { Authorization: `Bearer ${token}` };

    switch (input.action) {
        case 'sites_list': {
            const res = await jsonFetch(`${apiBase}/sites?per_page=20`, { headers, timeoutMs });
            const sites = Array.isArray(res.data)
                ? res.data.map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    url: s.ssl_url || s.url,
                    customDomain: s.custom_domain ?? null,
                    updatedAt: s.updated_at ?? null,
                }))
                : [];
            return {
                provider: 'netlify',
                action: 'sites_list',
                ok: res.ok,
                tokenSourceEnv: sourceEnv,
                siteCount: sites.length,
                sites,
            };
        }
        case 'deploys_list': {
            const siteId = (input.project_id || input.target || '').trim();
            if (!siteId) throw new Error('project_id or target (Netlify Site ID) is required for deploys_list');
            const res = await jsonFetch(`${apiBase}/sites/${encodeURIComponent(siteId)}/deploys?per_page=5`, { headers, timeoutMs });
            const deploys = Array.isArray(res.data)
                ? res.data.map((d: any) => ({
                    id: d.id,
                    state: d.state,
                    branch: d.branch,
                    commitRef: d.commit_ref,
                    errorMessage: d.error_message ?? null,
                    createdAt: d.created_at,
                    deploySslUrl: d.deploy_ssl_url,
                }))
                : [];
            return {
                provider: 'netlify',
                action: 'deploys_list',
                siteId,
                ok: res.ok,
                deploys,
            };
        }
        default:
            throw new Error(`Unsupported Netlify action "${input.action}". Supported: sites_list, deploys_list, site_status`);
    }
}

async function handleFirebase(input: CloudConnectorInput, timeoutMs: number): Promise<Record<string, unknown>> {
    const projectId = (input.project_id || '').trim();
    switch (input.action) {
        case 'hosting_site_probe': {
            const rawTarget = (input.target || (projectId ? `https://${projectId}.web.app` : '')).trim();
            if (!rawTarget) throw new Error('target URL or project_id is required for hosting_site_probe');
            const baseUrl = (/^https?:\/\//i.test(rawTarget) ? rawTarget : `https://${rawTarget}`).replace(/\/+$/, '');
            const [home, initJson] = await Promise.all([
                jsonFetch(baseUrl, { timeoutMs }),
                jsonFetch(`${baseUrl}/__/firebase/init.json`, { timeoutMs }),
            ]);
            return {
                provider: 'firebase',
                action: 'hosting_site_probe',
                baseUrl,
                homeStatus: home.status,
                homeMs: home.ms,
                firebaseInitDiscovered: initJson.ok && typeof initJson.data === 'object',
                firebaseConfig: initJson.ok ? initJson.data : null,
            };
        }
        case 'firestore_rules_probe': {
            if (!projectId) throw new Error('project_id is required for firestore_rules_probe');
            const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
            const res = await jsonFetch(url, { timeoutMs });
            const publiclyReadable = res.status === 200;
            return {
                provider: 'firebase',
                action: 'firestore_rules_probe',
                projectId,
                status: res.status,
                ms: res.ms,
                unauthenticatedReadAllowed: publiclyReadable,
                securityVerdict: publiclyReadable
                    ? 'WARNING: Default Firestore database returned HTTP 200 to an unauthenticated list request. Review firestore.rules immediately.'
                    : 'OK: Unauthenticated root document listing is denied or requires auth.',
            };
        }
        default:
            throw new Error(`Unsupported Firebase action "${input.action}". Supported: hosting_site_probe, firestore_rules_probe`);
    }
}

async function handleGcp(input: CloudConnectorInput, timeoutMs: number): Promise<Record<string, unknown>> {
    const projectId = (input.project_id || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim();
    const service = (input.api_service || 'aiplatform.googleapis.com').trim();

    switch (input.action) {
        case 'gcp_api_enablement': {
            if (!projectId) {
                throw new Error('project_id (or GOOGLE_CLOUD_PROJECT env var) is required for gcp_api_enablement');
            }
            const enableUrl = `https://console.developers.google.com/apis/api/${encodeURIComponent(service)}/overview?project=${encodeURIComponent(projectId)}`;
            const gcloudCommand = `gcloud services enable ${service} --project=${projectId}`;
            const { token, sourceEnv } = resolveCloudToken('gcp', input.token_env);

            if (!token) {
                return {
                    provider: 'gcp',
                    action: 'gcp_api_enablement',
                    projectId,
                    service,
                    liveCheck: 'skipped (no GCP_ACCESS_TOKEN / GOOGLE_OAUTH_ACCESS_TOKEN set)',
                    enableConsoleUrl: enableUrl,
                    gcloudEnableCommand: gcloudCommand,
                    guidance: `If calls to ${service} fail with SERVICE_DISABLED / "API has not been used in project ${projectId} before or it is disabled", visit ${enableUrl} or run \`${gcloudCommand}\` and wait 2-3 minutes for propagation.`,
                };
            }

            const apiUrl = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(service)}`;
            const res = await jsonFetch(apiUrl, {
                headers: { Authorization: `Bearer ${token}` },
                timeoutMs,
            });
            const state = res.data?.state ?? 'UNKNOWN';
            return {
                provider: 'gcp',
                action: 'gcp_api_enablement',
                projectId,
                service,
                ok: res.ok,
                status: res.status,
                ms: res.ms,
                tokenSourceEnv: sourceEnv,
                serviceState: state,
                enabled: state === 'ENABLED',
                enableConsoleUrl: enableUrl,
                gcloudEnableCommand: gcloudCommand,
                error: res.data?.error?.message ?? res.error ?? null,
            };
        }
        case 'cloud_run_probe': {
            const rawUrl = (input.target || '').trim();
            if (!rawUrl) throw new Error('target (Cloud Run service URL) is required for cloud_run_probe');
            const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
            const res = await jsonFetch(url, { timeoutMs });
            return {
                provider: 'gcp',
                action: 'cloud_run_probe',
                target: url,
                ok: res.ok,
                status: res.status,
                ms: res.ms,
                server: res.headers['server'] ?? null,
                xCloudTraceContext: res.headers['x-cloud-trace-context'] ?? null,
                wwwAuthenticate: res.headers['www-authenticate'] ?? null,
            };
        }
        default:
            throw new Error(`Unsupported GCP action "${input.action}". Supported: gcp_api_enablement, cloud_run_probe`);
    }
}

export async function runCloudConnector(input: CloudConnectorInput): Promise<Record<string, unknown>> {
    const timeoutMs = clampTimeout(input.timeout_ms, 10000);
    switch (input.provider) {
        case 'supabase': return await handleSupabase(input, timeoutMs);
        case 'cloudflare': return await handleCloudflare(input, timeoutMs);
        case 'netlify': return await handleNetlify(input, timeoutMs);
        case 'firebase': return await handleFirebase(input, timeoutMs);
        case 'gcp': return await handleGcp(input, timeoutMs);
        default:
            throw new Error(`Unsupported cloud provider "${String(input.provider)}". Supported: supabase, cloudflare, netlify, firebase, gcp`);
    }
}

function textResult(data: unknown): vscode.LanguageModelToolResult {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clipResult(text))]);
}

export class CloudConnectorTool implements vscode.LanguageModelTool<CloudConnectorInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CloudConnectorInput>): Promise<vscode.LanguageModelToolResult> {
        try {
            const report = await runCloudConnector(options.input);
            return textResult(report);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CloudConnectorInput>) {
        return {
            invocationMessage: `Cloud connector (${options.input.provider}: ${options.input.action})...`,
        };
    }
}

export function registerCloudConnectorTools(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_cloud_connector', new CloudConnectorTool()),
    );
}
