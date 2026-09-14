/**
 * Shared Hub HTTP client — the single source of truth for Hub authentication.
 *
 * The daemon gates EVERY route (including /status and /ext/v1/health) behind a
 * Bearer token. A caller that used a plain `fetch` without that token gets a 401
 * and would misreport a perfectly healthy Hub as "offline". So every Hub request
 * must go through this module — the sidebar, the chat participant, the LM tools,
 * the self-tools and the extension host all resolve the SAME token here.
 *
 * The token is generated once and shared by the extension, the CLI and the daemon
 * via a stable path (HARMONY_HUB_TOKEN_FILE, else ~/.harmony/hub-auth.token).
 */
import * as os from 'os';
import * as path from 'path';
import { workspace } from 'vscode';

/** Canonical token directory shared by the extension, the CLI, and the daemon. */
export function hubTokenDir(): string {
    const override = process.env.HARMONY_HUB_TOKEN_FILE;
    if (override && override.trim()) return path.dirname(override);
    return path.join(os.homedir(), '.harmony');
}

export function hubTokenFilePath(): string {
    const override = process.env.HARMONY_HUB_TOKEN_FILE;
    if (override && override.trim()) return override;
    return path.join(hubTokenDir(), 'hub-auth.token');
}

/** Shared Hub auth token (created once, reused across VS Code windows). */
let cachedHubToken: string | undefined;

/** Drop the cached token so the next read re-reads the file (used after a 401). */
export function clearHubTokenCache(): void {
    cachedHubToken = undefined;
}

export function hubAuthToken(): string | undefined {
    if (cachedHubToken !== undefined) return cachedHubToken;
    const fsMod = require('fs') as typeof import('fs');
    const cryptoMod = require('crypto') as typeof import('crypto');
    try {
        const tokenPath = hubTokenFilePath();
        const dir = path.dirname(tokenPath);
        try {
            const existing = fsMod.readFileSync(tokenPath, 'utf-8').trim();
            if (existing) { cachedHubToken = existing; return cachedHubToken; }
        } catch { /* not created yet */ }
        fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const token = cryptoMod.randomBytes(32).toString('hex');
        try {
            // Atomic create: fails if another window already won the race.
            fsMod.writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
            cachedHubToken = token;
        } catch {
            const winner = fsMod.readFileSync(tokenPath, 'utf-8').trim();
            cachedHubToken = winner || token;
        }
        return cachedHubToken;
    } catch {
        return undefined;
    }
}

/** Authorization header for Hub requests, when a token exists. */
export function hubAuthHeaders(): Record<string, string> {
    const token = hubAuthToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

/** Base Hub URL from config, with any trailing slash removed. */
export function hubBaseUrl(): string {
    return (workspace.getConfiguration('harmony').get<string>('hub.url') ?? 'http://127.0.0.1:7878').replace(/\/+$/, '');
}

/**
 * fetch() against the Hub with the Bearer token attached.
 * Accepts either a path ('/status') or a full URL.
 */
export async function hubFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(pathOrUrl)
        ? pathOrUrl
        : hubBaseUrl() + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
    const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
        ...hubAuthHeaders(),
    };
    return fetch(url, { ...init, headers });
}
