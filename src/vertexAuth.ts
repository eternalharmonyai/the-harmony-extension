import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vpnResilientFetch } from './vpnResilientTransport';

export const GEMINI_VERTEX_EXPRESS_BASE_URL = 'https://aiplatform.googleapis.com/v1beta1/publishers/google';
export const VERTEX_AUTH_SENTINEL = '__vertex_auth__';

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export type VertexAuthMode = 'bearer' | 'api-key' | 'none';

export type VertexAuthSource =
    | 'secret-bearer-token'
    | 'env-bearer-token'
    | 'secret-credentials-json'
    | 'harmony-vault'
    | 'env-credentials-json'
    | 'google-application-credentials'
    | 'secret-vertex-express-key'
    | 'env-vertex-api-key'
    | 'gcloud-adc'
    | 'gcloud-cli'
    | 'fallback-api-key'
    | 'none';

export interface ResolvedVertexAuth {
    mode: VertexAuthMode;
    source: VertexAuthSource;
    cacheKey?: string;
    bearerToken?: string;
    apiKey?: string;
    projectId: string;
    location: string;
    usingFallbackAizaKey?: boolean;
    diagnostics: string[];
}

export interface VertexAuthOptions {
    apiKey?: string;
    configuredProjectId?: string;
    configuredLocation?: string;
    env?: NodeJS.ProcessEnv;
    dotenv?: ReadonlyMap<string, string> | Record<string, string>;
    allowAmbientGcloud?: boolean;
    gcloudConfigDir?: string;
    vaultDir?: string;
    explicitProxySetting?: string;
    proxySupport?: string;
    fetchImpl?: typeof fetch;
    execCommandImpl?: (cmd: 'print-access-token' | 'get-project') => Promise<string>;
    bypassCache?: boolean;
    onGuardEvent?: (reason: string) => void;
}

export class VertexAuthConfigurationError extends Error {
    public readonly diagnostics: string[];
    constructor(message: string, diagnostics: string[] = []) {
        super(message);
        this.name = 'VertexAuthConfigurationError';
        this.diagnostics = diagnostics;
    }
}

export class VertexDedicatedVmBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VertexDedicatedVmBlockedError';
    }
}

const VERTEX_VAULT_FILENAME = 'vertex-credentials.json';
const HARMONY_APP_DIRNAME = 'Harmony';

function resolveVertexVaultPath(
    env: NodeJS.ProcessEnv = process.env,
    overrideVaultDir?: string,
    allowOsHomeFallback = env === process.env
): string {
    if (overrideVaultDir && overrideVaultDir.trim()) {
        return path.join(overrideVaultDir.trim(), VERTEX_VAULT_FILENAME);
    }
    if (process.platform === 'win32') {
        const base = env.LOCALAPPDATA || (allowOsHomeFallback ? path.join(os.homedir(), 'AppData', 'Local') : '');
        return base ? path.join(base, HARMONY_APP_DIRNAME, VERTEX_VAULT_FILENAME) : '';
    }
    const base = env.XDG_CONFIG_HOME || (allowOsHomeFallback ? path.join(os.homedir(), '.config') : '');
    return base ? path.join(base, 'harmony', VERTEX_VAULT_FILENAME) : '';
}

/**
 * Unexpanded display label for the cross-surface Vertex credential vault.
 * Never reveals the resolved OS account name in logs, errors, or UI.
 */
export function getVertexVaultDisplayPath(): string {
    if (process.platform === 'win32') {
        return `%LOCALAPPDATA%\\${HARMONY_APP_DIRNAME}\\${VERTEX_VAULT_FILENAME}`;
    }
    return `$XDG_CONFIG_HOME/harmony/${VERTEX_VAULT_FILENAME}`;
}

export interface VertexVaultSummary {
    present: boolean;
    displayPath: string;
    credentialType?: string;
    projectId?: string;
    clientEmail?: string;
}

export function isVertexVaultPresent(options: Pick<VertexAuthOptions, 'env' | 'vaultDir'> = {}): boolean {
    try {
        const filePath = resolveVertexVaultPath(options.env ?? process.env, options.vaultDir, options.env === undefined || options.env === process.env);
        if (!filePath || !fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        return stat.isFile() && stat.size > 10;
    } catch {
        return false;
    }
}

export function readVertexVaultSummary(options: Pick<VertexAuthOptions, 'env' | 'vaultDir'> = {}): VertexVaultSummary {
    const displayPath = getVertexVaultDisplayPath();
    const filePath = resolveVertexVaultPath(options.env ?? process.env, options.vaultDir);
    try {
        if (!fs.existsSync(filePath)) {
            return { present: false, displayPath };
        }
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) return { present: false, displayPath };
        const parsed = JSON.parse(raw);
        return {
            present: true,
            displayPath,
            credentialType: typeof parsed?.type === 'string' ? parsed.type : 'unknown',
            projectId: typeof parsed?.project_id === 'string'
                ? parsed.project_id
                : (typeof parsed?.quota_project_id === 'string' ? parsed.quota_project_id : undefined),
            clientEmail: typeof parsed?.client_email === 'string' ? parsed.client_email : undefined,
        };
    } catch {
        return { present: false, displayPath };
    }
}

export function writeVertexVaultCredentials(
    rawJson: string,
    options: Pick<VertexAuthOptions, 'env' | 'vaultDir'> = {}
): VertexVaultSummary {
    const trimmed = String(rawJson ?? '').trim();
    if (!trimmed) {
        throw new Error('Vertex credential JSON cannot be empty.');
    }
    let parsed: any;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error('Invalid JSON: paste or select a valid Google Cloud Service Account or ADC JSON file.');
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Vertex credential payload must be a JSON object.');
    }
    if (parsed.type === 'service_account') {
        if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@')) {
            throw new Error('Service Account JSON is missing a valid "client_email".');
        }
        if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('BEGIN PRIVATE KEY')) {
            throw new Error('Service Account JSON is missing a valid PEM "private_key".');
        }
    } else if (parsed.type === 'authorized_user') {
        if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
            throw new Error('Authorized User JSON is missing client_id, client_secret, or refresh_token.');
        }
    } else {
        throw new Error(`Unsupported GCP credential type "${String(parsed.type ?? 'missing')}". Expected "service_account" (recommended, non-interactive) or "authorized_user".`);
    }

    const env = options.env ?? process.env;
    const filePath = resolveVertexVaultPath(env, options.vaultDir);
    const dirPath = path.dirname(filePath);
    fs.mkdirSync(dirPath, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    const normalized = JSON.stringify(parsed, null, 2);
    fs.writeFileSync(tmpPath, normalized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* POSIX mode; Windows locked via icacls below */ }

    if (process.platform === 'win32' && !options.vaultDir) {
        const username = env.USERNAME || os.userInfo().username;
        if (username && /^[A-Za-z0-9_. -]+$/.test(username)) {
            try {
                cp.execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:F`], {
                    windowsHide: true,
                    stdio: 'ignore',
                    timeout: 4000,
                });
            } catch { /* best-effort ACL tightening */ }
        }
    }

    invalidateVertexTokenCache();
    return {
        present: true,
        displayPath: getVertexVaultDisplayPath(),
        credentialType: parsed.type,
        projectId: typeof parsed.project_id === 'string'
            ? parsed.project_id
            : (typeof parsed.quota_project_id === 'string' ? parsed.quota_project_id : undefined),
        clientEmail: typeof parsed.client_email === 'string' ? parsed.client_email : undefined,
    };
}

export function clearVertexVaultCredentials(options: Pick<VertexAuthOptions, 'env' | 'vaultDir'> = {}): boolean {
    const filePath = resolveVertexVaultPath(options.env ?? process.env, options.vaultDir);
    invalidateVertexTokenCache();
    try {
        if (!fs.existsSync(filePath)) return false;
        fs.unlinkSync(filePath);
        return true;
    } catch {
        return false;
    }
}

export function isVertexInvalidRaptError(errorOrMessage: unknown): boolean {
    const msg = typeof errorOrMessage === 'string'
        ? errorOrMessage
        : String((errorOrMessage as any)?.message ?? errorOrMessage ?? '');
    const diags = Array.isArray((errorOrMessage as any)?.diagnostics)
        ? (errorOrMessage as any).diagnostics.join(' ')
        : '';
    return /invalid_rapt|reauth related error/i.test(`${msg} ${diags}`);
}

/**
 * Hard road-lock preventing accidental routing to dedicated GPU/VM Vertex endpoints.
 * Serverless Publisher / Model Garden MaaS (`/publishers/<org>/models/<id>`) and
 * serverless `/endpoints/openapi` are allowed; `/endpoints/<dedicated-id>` is blocked
 * unless `allowDedicatedVmEndpoints === true`.
 */
export function assertVertexServerlessEndpointUrl(
    targetUrl: string,
    allowDedicatedVmEndpoints = false
): void {
    if (allowDedicatedVmEndpoints) return;
    const raw = String(targetUrl ?? '').trim();
    if (!raw) return;
    // Match .../locations/<loc>/endpoints/<id> where <id> is NOT "openapi"
    const match = raw.match(/\/locations\/[^/?#]+\/endpoints\/([^/?#:]+)/i);
    if (match && match[1].toLowerCase() !== 'openapi') {
        throw new VertexDedicatedVmBlockedError(
            `Blocked dedicated Vertex AI VM endpoint ("/endpoints/${match[1]}"). ` +
            `Harmony locks Vertex AI to serverless pay-per-token Publisher / Model Garden endpoints by default so dedicated GPU VMs can never stream accidentally. ` +
            `To intentionally call a self-deployed VM endpoint, enable "harmony.gemini.allowDedicatedVmEndpoints".`
        );
    }
}

interface CachedVertexToken {
    accessToken: string;
    expiresAtMs: number;
    projectId?: string;
}

const vertexTokenCache = new Map<string, CachedVertexToken>();
let gcloudCliNegativeUntilMs = 0;

export function invalidateVertexTokenCache(cacheKey?: string): void {
    if (cacheKey) {
        vertexTokenCache.delete(cacheKey);
    } else {
        vertexTokenCache.clear();
    }
    gcloudCliNegativeUntilMs = 0;
}

export function redactUrlCredentials(input: string): string {
    if (!input) return input;
    return input
        .replace(/([?&](?:key|access_token|refresh_token|client_secret|token)=)[^&#\s"']+/gi, '$1[REDACTED]')
        .replace(/(\b(?:access_token|refresh_token|client_secret)\s*["']?\s*[:=]\s*["']?)[^"'\s&#,}]+/gi, '$1[REDACTED]')
        .replace(/(\bBearer\s+)(?:ya29\.[A-Za-z0-9._~+/=-]+|eyJ[A-Za-z0-9._~+/=-]+|AIza[A-Za-z0-9_-]+|AQ\.[A-Za-z0-9._~+/=-]+|[A-Za-z0-9._~+/=-]{24,})/gi, '$1[REDACTED]')
        .replace(/(\bx-goog-api-key\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]');
}

function base64UrlEncode(input: string | Buffer): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function lookupEnvValue(
    names: readonly string[],
    env: NodeJS.ProcessEnv,
    dotenv?: ReadonlyMap<string, string> | Record<string, string>
): string {
    for (const name of names) {
        const procVal = env[name];
        if (typeof procVal === 'string' && procVal.trim()) {
            return procVal.trim();
        }
    }
    if (dotenv) {
        for (const name of names) {
            const val = typeof (dotenv as ReadonlyMap<string, string>).get === 'function'
                ? (dotenv as ReadonlyMap<string, string>).get(name)
                : (dotenv as Record<string, string>)[name];
            if (typeof val === 'string' && val.trim()) {
                return val.trim();
            }
        }
    }
    return '';
}

export function getGcloudConfigDir(env: NodeJS.ProcessEnv = process.env, overrideDir?: string): string {
    if (overrideDir && overrideDir.trim()) return overrideDir.trim();
    if (env.CLOUDSDK_CONFIG && env.CLOUDSDK_CONFIG.trim()) return env.CLOUDSDK_CONFIG.trim();
    if (process.platform === 'win32') {
        const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'gcloud');
    }
    return path.join(os.homedir(), '.config', 'gcloud');
}

export function readGcloudDefaultProjectSync(gcloudDir: string): string {
    try {
        let activeConfig = 'default';
        const activePath = path.join(gcloudDir, 'active_config');
        if (fs.existsSync(activePath)) {
            const rawActive = fs.readFileSync(activePath, 'utf8').trim();
            if (rawActive && /^[A-Za-z0-9_-]+$/.test(rawActive)) {
                activeConfig = rawActive;
            }
        }
        const cfgPath = path.join(gcloudDir, 'configurations', `config_${activeConfig}`);
        if (!fs.existsSync(cfgPath)) return '';
        const content = fs.readFileSync(cfgPath, 'utf8');
        const match = content.match(/^\s*project\s*=\s*([^\r\n#;]+)/m);
        if (!match) return '';
        const proj = match[1].trim();
        return proj && proj !== '(unset)' ? proj : '';
    } catch {
        return '';
    }
}

/**
 * Fast (<0.5ms) synchronous check for ambient GCP / Vertex credentials.
 * Never spawns subprocesses or performs network I/O — safe on UI / sidebar hot paths.
 */
export function hasVertexAmbientCredentialsSync(options: Pick<VertexAuthOptions, 'env' | 'dotenv' | 'gcloudConfigDir' | 'vaultDir'> = {}): boolean {
    const env = options.env ?? process.env;
    if (isVertexVaultPresent({ env, vaultDir: options.vaultDir })) return true;
    const directEnv = lookupEnvValue(
        [
            'HARMONY_VERTEX_ACCESS_TOKEN',
            'VERTEX_ACCESS_TOKEN',
            'GOOGLE_OAUTH_ACCESS_TOKEN',
            'CLOUDSDK_AUTH_ACCESS_TOKEN',
            'HARMONY_VERTEX_CREDENTIALS_JSON',
            'VERTEX_CREDENTIALS_JSON',
            'HARMONY_VERTEX_API_KEY',
            'VERTEX_API_KEY',
            'GOOGLE_CLOUD_API_KEY',
        ],
        env,
        options.dotenv
    );
    if (directEnv) return true;

    const gacPath = lookupEnvValue(['GOOGLE_APPLICATION_CREDENTIALS'], env, options.dotenv);
    if (gacPath) {
        try {
            if (fs.existsSync(gacPath)) return true;
        } catch { /* ignore */ }
    }

    const gcloudDir = getGcloudConfigDir(env, options.gcloudConfigDir);
    try {
        if (fs.existsSync(path.join(gcloudDir, 'application_default_credentials.json'))) return true;
        if (fs.existsSync(path.join(gcloudDir, 'credentials.db'))) return true;
    } catch { /* ignore */ }

    return false;
}

async function mintTokenFromCredentialsObject(
    creds: any,
    cacheKeyPrefix: string,
    fetchFn: typeof fetch,
    bypassCache?: boolean
): Promise<{ accessToken: string; projectId?: string; cacheKey: string }> {
    const credType = String(creds?.type ?? '').trim();

    if (credType === 'service_account' || (creds?.client_email && creds?.private_key)) {
        const clientEmail = String(creds.client_email ?? '').trim();
        const privateKey = String(creds.private_key ?? '').replace(/\\n/g, '\n').trim();
        const tokenUri = String(creds.token_uri || GOOGLE_TOKEN_URI).trim();
        const projectId = typeof creds.project_id === 'string' ? creds.project_id.trim() : undefined;
        if (!clientEmail || !privateKey) {
            throw new Error('Service Account JSON is missing client_email or private_key.');
        }
        const cacheKey = `${cacheKeyPrefix}:sa:${clientEmail}`;
        const cached = !bypassCache ? vertexTokenCache.get(cacheKey) : undefined;
        if (cached && cached.expiresAtMs > Date.now()) {
            return { accessToken: cached.accessToken, projectId: cached.projectId ?? projectId, cacheKey };
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const payloadB64 = base64UrlEncode(JSON.stringify({
            iss: clientEmail,
            scope: CLOUD_PLATFORM_SCOPE,
            aud: tokenUri,
            iat: nowSec,
            exp: nowSec + 3600,
        }));
        const unsignedJwt = `${headerB64}.${payloadB64}`;
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(unsignedJwt);
        signer.end();
        const signatureB64 = base64UrlEncode(signer.sign(privateKey));
        const assertion = `${unsignedJwt}.${signatureB64}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Vertex OAuth token exchange timed out (10s).')), 10_000);
        try {
            const body = new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion,
            }).toString();
            const res = await fetchFn(tokenUri, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: controller.signal as any,
            });
            const text = await res.text();
            if (!res.ok) {
                throw new Error(`Service Account OAuth HTTP ${res.status}: ${redactUrlCredentials(text).slice(0, 300)}`);
            }
            const json = JSON.parse(text);
            const accessToken = String(json?.access_token ?? '').trim();
            if (!accessToken) {
                throw new Error('Service Account OAuth token response contained no access_token.');
            }
            const expiresInSec = Number(json?.expires_in) || 3600;
            const ttlMs = Math.max(60, expiresInSec - 300) * 1000;
            vertexTokenCache.set(cacheKey, {
                accessToken,
                expiresAtMs: Date.now() + ttlMs,
                projectId,
            });
            return { accessToken, projectId, cacheKey };
        } finally {
            clearTimeout(timer);
        }
    }

    if (credType === 'authorized_user' || (creds?.client_id && creds?.client_secret && creds?.refresh_token)) {
        const clientId = String(creds.client_id ?? '').trim();
        const clientSecret = String(creds.client_secret ?? '').trim();
        const refreshToken = String(creds.refresh_token ?? '').trim();
        const tokenUri = String(creds.token_uri || GOOGLE_TOKEN_URI).trim();
        const projectId = typeof creds.quota_project_id === 'string' && creds.quota_project_id.trim()
            ? creds.quota_project_id.trim()
            : (typeof creds.project_id === 'string' ? creds.project_id.trim() : undefined);
        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error('Authorized User ADC JSON is missing client_id, client_secret, or refresh_token.');
        }
        const fingerprint = crypto.createHash('sha256').update(`${clientId}:${refreshToken}`).digest('hex').slice(0, 16);
        const cacheKey = `${cacheKeyPrefix}:adc:${fingerprint}`;
        const cached = !bypassCache ? vertexTokenCache.get(cacheKey) : undefined;
        if (cached && cached.expiresAtMs > Date.now()) {
            return { accessToken: cached.accessToken, projectId: cached.projectId ?? projectId, cacheKey };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Vertex ADC refresh-token exchange timed out (10s).')), 10_000);
        try {
            const body = new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }).toString();
            const res = await fetchFn(tokenUri, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: controller.signal as any,
            });
            const text = await res.text();
            if (!res.ok) {
                throw new Error(`ADC OAuth HTTP ${res.status}: ${redactUrlCredentials(text).slice(0, 300)}`);
            }
            const json = JSON.parse(text);
            const accessToken = String(json?.access_token ?? '').trim();
            if (!accessToken) {
                throw new Error('ADC OAuth token response contained no access_token.');
            }
            const expiresInSec = Number(json?.expires_in) || 3600;
            const ttlMs = Math.max(60, expiresInSec - 300) * 1000;
            vertexTokenCache.set(cacheKey, {
                accessToken,
                expiresAtMs: Date.now() + ttlMs,
                projectId,
            });
            return { accessToken, projectId, cacheKey };
        } finally {
            clearTimeout(timer);
        }
    }

    throw new Error(`Unsupported Google credentials JSON type "${credType || 'unknown'}" (expected "service_account" or "authorized_user").`);
}

function defaultExecGcloudCommand(
    cmd: 'print-access-token' | 'get-project',
    env: NodeJS.ProcessEnv
): Promise<string> {
    return new Promise((resolve, reject) => {
        const subArgs = cmd === 'print-access-token'
            ? ['auth', 'print-access-token']
            : ['config', 'get-value', 'project'];
        if (process.platform === 'win32') {
            // Node 20.12+ throws EINVAL when spawning .cmd directly without cmd.exe.
            // Arguments are 100% static literals here — never user input.
            const comspec = env.ComSpec || 'cmd.exe';
            const fixedCmd = cmd === 'print-access-token'
                ? 'gcloud auth print-access-token'
                : 'gcloud config get-value project';
            cp.execFile(
                comspec,
                ['/d', '/s', '/c', fixedCmd],
                { timeout: 5000, windowsHide: true, env },
                (err, stdout) => {
                    if (err) return reject(err);
                    resolve(String(stdout ?? '').trim());
                }
            );
        } else {
            cp.execFile(
                'gcloud',
                subArgs,
                { timeout: 5000, env },
                (err, stdout) => {
                    if (err) return reject(err);
                    resolve(String(stdout ?? '').trim());
                }
            );
        }
    });
}

async function mintFromGcloudCli(
    gcloudDir: string,
    env: NodeJS.ProcessEnv,
    execImpl?: (cmd: 'print-access-token' | 'get-project') => Promise<string>,
    bypassCache?: boolean
): Promise<{ accessToken: string; projectId?: string; cacheKey: string }> {
    const cacheKey = 'gcloud-cli:default';
    const cached = !bypassCache ? vertexTokenCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAtMs > Date.now()) {
        return { accessToken: cached.accessToken, projectId: cached.projectId, cacheKey };
    }
    if (!bypassCache && gcloudCliNegativeUntilMs > Date.now()) {
        throw new Error('gcloud CLI unavailable (cached cooldown).');
    }

    const runner = execImpl ?? ((c) => defaultExecGcloudCommand(c, env));
    try {
        const rawOut = await runner('print-access-token');
        const firstLine = rawOut.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
        if (!firstLine || firstLine.length < 20 || /\s/.test(firstLine)) {
            throw new Error('gcloud auth print-access-token did not return a valid token.');
        }
        let projectId = readGcloudDefaultProjectSync(gcloudDir);
        if (!projectId) {
            try {
                const cliProj = (await runner('get-project')).split(/\r?\n/)[0]?.trim() ?? '';
                if (cliProj && cliProj !== '(unset)') {
                    projectId = cliProj;
                }
            } catch { /* project lookup is best-effort */ }
        }
        // gcloud access tokens last up to 60m; cache for 45m so mid-life tokens refresh safely
        vertexTokenCache.set(cacheKey, {
            accessToken: firstLine,
            expiresAtMs: Date.now() + 45 * 60 * 1000,
            projectId: projectId || undefined,
        });
        return { accessToken: firstLine, projectId: projectId || undefined, cacheKey };
    } catch (err) {
        gcloudCliNegativeUntilMs = Date.now() + 60_000;
        throw err;
    }
}

/**
 * Superpositioned Vertex AI credential waterfall:
 * 1. Explicit ya29.* OAuth token in secret/arg
 * 2. Explicit Service Account / ADC JSON in secret/arg
 * 3. Explicit AQ.* Vertex Express key in secret/arg
 * 4. Env / .env OAuth Bearer token (never blocked by a saved AI Studio AIza* key!)
 * 5. Env / .env Service Account / ADC JSON string
 * 6. GOOGLE_APPLICATION_CREDENTIALS JSON file
 * 7. Dedicated VERTEX_API_KEY / HARMONY_VERTEX_API_KEY / GOOGLE_CLOUD_API_KEY
 * 8. Local gcloud Application Default Credentials (application_default_credentials.json)
 * 9. Local gcloud CLI (gcloud auth print-access-token)
 * 10. Fallback to rawKey as Vertex Express API key when configuredProjectId is blank
 */
export async function resolveVertexAuthAsync(options: VertexAuthOptions = {}): Promise<ResolvedVertexAuth> {
    const env = options.env ?? process.env;
    const dotenv = options.dotenv;
    const diagnostics: string[] = [];
    const fetchFn: typeof fetch = options.fetchImpl ?? ((urlInput, init) => vpnResilientFetch(String(urlInput), {
        method: init?.method ?? 'POST',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === 'string' || Buffer.isBuffer(init?.body) ? init.body : (init?.body ? String(init.body) : undefined),
        signal: init?.signal ?? undefined,
        connectTimeoutMs: 8_000,
        uploadTimeoutMs: 8_000,
        ttfbTimeoutMs: 10_000,
        label: 'Vertex OAuth',
        explicitProxySetting: options.explicitProxySetting,
        proxySupport: options.proxySupport,
        env,
        onGuardEvent: (reason) => {
            diagnostics.push(reason);
            options.onGuardEvent?.(reason);
        },
    }));
    const gcloudDir = getGcloudConfigDir(env, options.gcloudConfigDir);

    const rawKeyInput = (options.apiKey ?? '').trim();
    const rawKey = rawKeyInput === VERTEX_AUTH_SENTINEL ? '' : rawKeyInput;
    const configuredProjectId = (options.configuredProjectId ?? '').trim();
    const envProjectId = lookupEnvValue(
        ['HARMONY_VERTEX_PROJECT_ID', 'VERTEX_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT'],
        env,
        dotenv
    );
    let projectId = configuredProjectId || envProjectId;

    const configuredLocation = (options.configuredLocation ?? '').trim();
    const envLocation = lookupEnvValue(
        ['HARMONY_VERTEX_LOCATION', 'VERTEX_LOCATION', 'GOOGLE_CLOUD_LOCATION', 'CLOUD_ML_REGION'],
        env,
        dotenv
    );
    const location = configuredLocation || envLocation || 'global';

    const ensureProjectId = (): string => {
        if (projectId) return projectId;
        const fromGcloudCfg = readGcloudDefaultProjectSync(gcloudDir);
        if (fromGcloudCfg) {
            projectId = fromGcloudCfg;
        }
        return projectId;
    };

    // 1. Direct OAuth Bearer token in secret/arg
    if (/^ya29\./.test(rawKey)) {
        return {
            mode: 'bearer',
            source: 'secret-bearer-token',
            bearerToken: rawKey,
            projectId: ensureProjectId(),
            location,
            diagnostics,
        };
    }

    // 2. Direct JSON credential (Service Account or Authorized User) pasted as key
    if (rawKey.startsWith('{')) {
        try {
            const parsed = JSON.parse(rawKey);
            const minted = await mintTokenFromCredentialsObject(parsed, 'secret-json', fetchFn, options.bypassCache);
            if (!projectId && minted.projectId) projectId = minted.projectId;
            return {
                mode: 'bearer',
                source: 'secret-credentials-json',
                cacheKey: minted.cacheKey,
                bearerToken: minted.accessToken,
                projectId: ensureProjectId(),
                location,
                diagnostics,
            };
        } catch (err: any) {
            diagnostics.push(`Secret JSON credential failed: ${err?.message ?? String(err)}`);
        }
    }

    // 3. Explicit Vertex AI Express API key (AQ.*) in secret/arg when project is not forced
    if (/^AQ\./.test(rawKey) && !configuredProjectId) {
        return {
            mode: 'api-key',
            source: 'secret-vertex-express-key',
            apiKey: rawKey,
            projectId: '',
            location,
            diagnostics,
        };
    }

    // 4. Env / .env OAuth2 Bearer token (takes precedence over a saved AI Studio AIza* key!)
    const envBearer = lookupEnvValue(
        ['HARMONY_VERTEX_ACCESS_TOKEN', 'VERTEX_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN'],
        env,
        dotenv
    );
    if (envBearer) {
        return {
            mode: 'bearer',
            source: 'env-bearer-token',
            bearerToken: envBearer,
            projectId: ensureProjectId(),
            location,
            diagnostics,
        };
    }

    // 5. Env / .env Credentials JSON string
    const envCredsJson = lookupEnvValue(['HARMONY_VERTEX_CREDENTIALS_JSON', 'VERTEX_CREDENTIALS_JSON'], env, dotenv);
    if (envCredsJson) {
        try {
            const parsed = JSON.parse(envCredsJson);
            const minted = await mintTokenFromCredentialsObject(parsed, 'env-json', fetchFn, options.bypassCache);
            if (!projectId && minted.projectId) projectId = minted.projectId;
            return {
                mode: 'bearer',
                source: 'env-credentials-json',
                cacheKey: minted.cacheKey,
                bearerToken: minted.accessToken,
                projectId: ensureProjectId(),
                location,
                diagnostics,
            };
        } catch (err: any) {
            diagnostics.push(`VERTEX_CREDENTIALS_JSON failed: ${err?.message ?? String(err)}`);
        }
    }

    // 6. GOOGLE_APPLICATION_CREDENTIALS file path
    const gacPath = lookupEnvValue(['GOOGLE_APPLICATION_CREDENTIALS'], env, dotenv);
    if (gacPath) {
        try {
            const rawFile = await fs.promises.readFile(gacPath, 'utf8');
            const parsed = JSON.parse(rawFile);
            const minted = await mintTokenFromCredentialsObject(parsed, `gac:${gacPath}`, fetchFn, options.bypassCache);
            if (!projectId && minted.projectId) projectId = minted.projectId;
            return {
                mode: 'bearer',
                source: 'google-application-credentials',
                cacheKey: minted.cacheKey,
                bearerToken: minted.accessToken,
                projectId: ensureProjectId(),
                location,
                diagnostics,
            };
        } catch (err: any) {
            diagnostics.push(`GOOGLE_APPLICATION_CREDENTIALS (${gacPath}) failed: ${err?.message ?? String(err)}`);
        }
    }

    // 7. Dedicated Vertex API Key in env / .env
    const envVertexKey = lookupEnvValue(['HARMONY_VERTEX_API_KEY', 'VERTEX_API_KEY', 'GOOGLE_CLOUD_API_KEY'], env, dotenv);
    if (envVertexKey) {
        if (/^ya29\./.test(envVertexKey)) {
            return {
                mode: 'bearer',
                source: 'env-bearer-token',
                bearerToken: envVertexKey,
                projectId: ensureProjectId(),
                location,
                diagnostics,
            };
        }
        if (!configuredProjectId) {
            return {
                mode: 'api-key',
                source: 'env-vertex-api-key',
                apiKey: envVertexKey,
                projectId: '',
                location,
                diagnostics,
            };
        }
    }

    // 7.5. Cross-surface Harmony Sovereign Vault (%LOCALAPPDATA%\Harmony\vertex-credentials.json)
    // Precedes gcloud ADC/CLI and overrides saved AIza* Studio keys across VS Code, Standalone 8789 & CLI,
    // while yielding to explicit per-process env vars above and staying hermetic when allowAmbientGcloud===false.
    if (options.vaultDir || options.allowAmbientGcloud !== false) {
        const allowHomeFallback = options.env === undefined || options.env === process.env;
        const vaultPath = resolveVertexVaultPath(env, options.vaultDir, allowHomeFallback);
        if (vaultPath && fs.existsSync(vaultPath)) {
            try {
                const rawVault = await fs.promises.readFile(vaultPath, 'utf8');
                const parsedVault = JSON.parse(rawVault);
                const mintedVault = await mintTokenFromCredentialsObject(
                    parsedVault,
                    `harmony-vault:${options.vaultDir || getVertexVaultDisplayPath()}`,
                    fetchFn,
                    options.bypassCache
                );
                if (!projectId && mintedVault.projectId) projectId = mintedVault.projectId;
                return {
                    mode: 'bearer',
                    source: 'harmony-vault',
                    cacheKey: mintedVault.cacheKey,
                    bearerToken: mintedVault.accessToken,
                    projectId: ensureProjectId(),
                    location,
                    diagnostics,
                };
            } catch (err: any) {
                diagnostics.push(`Harmony Vertex Vault (${getVertexVaultDisplayPath()}) failed: ${err?.message ?? String(err)}`);
            }
        }
    }

    // 8 & 9. Ambient Google Cloud ADC file + gcloud CLI
    if (options.allowAmbientGcloud !== false) {
        const adcPath = path.join(gcloudDir, 'application_default_credentials.json');
        if (fs.existsSync(adcPath)) {
            try {
                const rawAdc = await fs.promises.readFile(adcPath, 'utf8');
                const parsedAdc = JSON.parse(rawAdc);
                const minted = await mintTokenFromCredentialsObject(parsedAdc, `adc-file:${adcPath}`, fetchFn, options.bypassCache);
                const resolvedProj = projectId || minted.projectId || readGcloudDefaultProjectSync(gcloudDir);
                if (resolvedProj || !rawKey || configuredProjectId) {
                    return {
                        mode: 'bearer',
                        source: 'gcloud-adc',
                        cacheKey: minted.cacheKey,
                        bearerToken: minted.accessToken,
                        projectId: resolvedProj || '',
                        location,
                        diagnostics,
                    };
                }
                diagnostics.push('gcloud ADC token minted, but no GCP project ID was configured; falling through.');
            } catch (err: any) {
                diagnostics.push(`gcloud ADC (${adcPath}) failed: ${err?.message ?? String(err)}`);
            }
        }

        // Try gcloud CLI if credentials.db exists or if we need OAuth (configuredProjectId set or no rawKey or rawKey is AIza*)
        const credsDbExists = fs.existsSync(path.join(gcloudDir, 'credentials.db'));
        if (credsDbExists || configuredProjectId || !rawKey) {
            try {
                const mintedCli = await mintFromGcloudCli(gcloudDir, env, options.execCommandImpl, options.bypassCache);
                const resolvedProj = projectId || mintedCli.projectId || '';
                if (resolvedProj || !rawKey || configuredProjectId) {
                    return {
                        mode: 'bearer',
                        source: 'gcloud-cli',
                        cacheKey: mintedCli.cacheKey,
                        bearerToken: mintedCli.accessToken,
                        projectId: resolvedProj,
                        location,
                        diagnostics,
                    };
                }
                diagnostics.push('gcloud CLI token minted, but no GCP project ID was found; falling through.');
            } catch (err: any) {
                if (credsDbExists) {
                    diagnostics.push(`gcloud CLI token lookup failed: ${err?.message ?? String(err)}`);
                }
            }
        }
    }

    // 10. Fallback to rawKey as Vertex Express API key ONLY when project-scoped Vertex is NOT forced
    if (!configuredProjectId && rawKey) {
        return {
            mode: 'api-key',
            source: 'fallback-api-key',
            apiKey: rawKey,
            projectId: '',
            location,
            usingFallbackAizaKey: /^AIza/.test(rawKey),
            diagnostics,
        };
    }

    // 11. No usable Vertex credentials (e.g. configuredProjectId is set, only an AIza* key or nothing exists)
    return {
        mode: 'none',
        source: 'none',
        projectId,
        location,
        usingFallbackAizaKey: /^AIza/.test(rawKey),
        diagnostics,
    };
}

export function buildVertexGenerateContentEndpoint(
    modelId: string,
    method: 'generateContent' | 'streamGenerateContent',
    sse: boolean,
    auth: ResolvedVertexAuth,
    options?: { allowDedicatedVmEndpoints?: boolean }
): { url: string; headers: Record<string, string> } {
    if (auth.mode === 'none') {
        const diagSuffix = auth.diagnostics.length > 0 ? ` Diagnostics: ${auth.diagnostics.join(' | ')}` : '';
        const isRapt = isVertexInvalidRaptError(diagSuffix);
        const raptNote = isRapt
            ? 'Google Workspace ReAuth timer expired (invalid_rapt) on your human gcloud login. Run "Harmony: Configure Vertex AI Credentials (Service Account / ADC)" with a Service Account JSON for non-interactive auth, or click "Re-authenticate Google Cloud" to refresh gcloud ADC. '
            : '';
        const keyNote = auth.usingFallbackAizaKey
            ? 'Your saved Gemini key (AIza...) is scoped to Google AI Studio and is rejected by project-scoped Vertex AI endpoints. '
            : '';
        throw new VertexAuthConfigurationError(
            `Vertex AI${auth.projectId ? ` project "${auth.projectId}"` : ''} requires Google Cloud authentication. ${raptNote}${keyNote}` +
            `Authenticate using any one of: (1) run "Harmony: Configure Vertex AI Credentials (Service Account / ADC)" (${getVertexVaultDisplayPath()} — shared by VS Code, Standalone & CLI), ` +
            `(2) run "gcloud auth application-default login", ` +
            `(3) set GOOGLE_APPLICATION_CREDENTIALS to a GCP Service Account JSON path, ` +
            `(4) clear "harmony.gemini.vertexProjectId" and use a Vertex Express API key (AQ... / VERTEX_API_KEY), or ` +
            `(5) switch "harmony.gemini.endpointProfile" back to "ai-studio".${diagSuffix}`,
            auth.diagnostics
        );
    }

    if (auth.mode === 'bearer' && auth.bearerToken) {
        const loc = auth.location || 'global';
        const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
        const cleanModel = modelId.trim().replace(/^models\//, '');
        const base = cleanModel.startsWith('projects/')
            ? `https://${host}/v1beta1/${cleanModel}`
            : (auth.projectId
                ? `https://${host}/v1beta1/projects/${encodeURIComponent(auth.projectId)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(cleanModel)}`
                : `${GEMINI_VERTEX_EXPRESS_BASE_URL}/models/${encodeURIComponent(cleanModel)}`);
        const query = sse ? '?alt=sse' : '';
        const finalUrl = `${base}:${method}${query}`;
        assertVertexServerlessEndpointUrl(finalUrl, options?.allowDedicatedVmEndpoints);
        return {
            url: finalUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${auth.bearerToken}`,
            },
        };
    }

    // mode === 'api-key' (Vertex AI Express Mode)
    const key = auth.apiKey ?? '';
    const query = sse
        ? `?alt=sse&key=${encodeURIComponent(key)}`
        : `?key=${encodeURIComponent(key)}`;
    const expressUrl = `${GEMINI_VERTEX_EXPRESS_BASE_URL}/models/${encodeURIComponent(modelId)}:${method}${query}`;
    assertVertexServerlessEndpointUrl(expressUrl, options?.allowDedicatedVmEndpoints);
    return {
        url: expressUrl,
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
        },
    };
}

export function buildVertexOpenAiCompatEndpoint(
    modelId: string,
    auth: ResolvedVertexAuth,
    options?: { allowDedicatedVmEndpoints?: boolean }
): { baseUrl: string; bearerToken: string; model: string } | undefined {
    if (auth.mode !== 'bearer' || !auth.bearerToken || !auth.projectId) {
        return undefined;
    }
    const loc = auth.location || 'global';
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
    const baseUrl = `https://${host}/v1beta1/projects/${encodeURIComponent(auth.projectId)}/locations/${encodeURIComponent(loc)}/endpoints/openapi`;
    assertVertexServerlessEndpointUrl(baseUrl, options?.allowDedicatedVmEndpoints);
    const cleanId = modelId.trim().replace(/^models\//, '');
    const prefixedModel = cleanId.includes('/') ? cleanId : `google/${cleanId}`;
    return {
        baseUrl,
        bearerToken: auth.bearerToken,
        model: prefixedModel,
    };
}

export function enrichVertexHttpError(
    status: number,
    rawBody: string,
    model: string,
    auth?: ResolvedVertexAuth
): string {
    const cleanBody = redactUrlCredentials(rawBody).slice(0, 500);
    if (!auth) {
        return `Gemini Native (Vertex AI) HTTP ${status}: ${cleanBody}`;
    }

    const diagNote = auth.diagnostics.length > 0
        ? ` [Ambient auth notes: ${auth.diagnostics.join('; ')}]`
        : '';

    if (status === 401 || status === 403) {
        if (auth.usingFallbackAizaKey) {
            return `Gemini Native (Vertex AI) HTTP ${status}: ${cleanBody}\n\n` +
                `[Vertex Auth Guidance: Google AI Studio keys (AIza... from aistudio.google.com) only authenticate on the "ai-studio" backend (generativelanguage.googleapis.com). ` +
                `To use Google Cloud Vertex AI (aiplatform.googleapis.com), either: ` +
                `(1) run "gcloud auth application-default login" so Harmony auto-mints GCP OAuth tokens, ` +
                `(2) set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_OAUTH_ACCESS_TOKEN in .env, ` +
                `(3) set a Vertex AI Express key (AQ... or VERTEX_API_KEY), or ` +
                `(4) switch "harmony.gemini.endpointProfile" back to "ai-studio".]${diagNote}`;
        }
        if (auth.mode === 'bearer' && !auth.projectId) {
            return `Gemini Native (Vertex AI) HTTP ${status}: ${cleanBody}\n\n` +
                `[Vertex Auth Guidance: OAuth Bearer authentication on Vertex AI requires a GCP Project ID. Set "harmony.gemini.vertexProjectId" (or GOOGLE_CLOUD_PROJECT in .env) so requests route to projects/{projectId}/locations/${auth.location}.]${diagNote}`;
        }
        if (status === 403) {
            return `Gemini Native (Vertex AI) HTTP 403: ${cleanBody}\n\n` +
                `[Vertex Auth Guidance: Ensure the Vertex AI API (aiplatform.googleapis.com) is enabled on GCP project "${auth.projectId || '(active project)'}" and your credential has the "Vertex AI User" (roles/aiplatform.user) IAM role.]${diagNote}`;
        }
    }

    if (status === 404) {
        const targetDesc = auth.projectId
            ? `project="${auth.projectId}", location="${auth.location}"`
            : `Vertex AI Express (${auth.location})`;
        return `Gemini Native (Vertex AI) HTTP 404: ${cleanBody}\n\n` +
            `[Vertex Model Guidance: Model "${model}" was not found on ${targetDesc}. Frontier/preview Gemini IDs often require harmony.gemini.vertexLocation="global" (or "us-central1"), or may currently be published only on the "ai-studio" backend.]`;
    }

    return `Gemini Native (Vertex AI) HTTP ${status}: ${cleanBody}${diagNote}`;
}
