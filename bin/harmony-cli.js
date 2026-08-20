#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const childProcess = require('child_process');
const crypto = require('crypto');

const DEFAULT_HUB_URL = 'http://127.0.0.1:7878';
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000;
const NATIVE_ACTION_PREVIEW_TTL_MS = 10 * 60 * 1000;

function joinPieces(...parts) {
    return parts.join('');
}

function parseOptions(argv) {
    const options = { _: [] };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith('--')) {
            options._.push(arg);
            continue;
        }
        const raw = arg.slice(2);
        const eq = raw.indexOf('=');
        if (eq >= 0) {
            options[raw.slice(0, eq)] = raw.slice(eq + 1);
            continue;
        }
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            options[raw] = next;
            index++;
        } else {
            options[raw] = true;
        }
    }
    return options;
}

function extensionRoot() {
    return path.resolve(__dirname, '..');
}

function workspaceRoot(options) {
    return path.resolve(String(options.workspace || process.env.HARMONY_WORKSPACE || process.cwd()));
}

function harmonyPath(root, ...parts) {
    return path.join(root, '.harmony', ...parts);
}

function outsidePolicyPath(root) {
    return harmonyPath(root, 'policy', 'outside-vs-policy.json');
}

function terminalAskDir(root) {
    return harmonyPath(root, 'terminal-ask');
}

function providerBrokerDir(root) {
    return harmonyPath(root, 'provider-broker');
}

function providerSecretsDir(root) {
    return harmonyPath(root, 'secrets', 'providers');
}

function snapshotsDir(root) {
    return harmonyPath(root, 'snapshots');
}

function normalizePath(value) {
    return String(value).replace(/\\/g, '/');
}

function ageMs(timestamp) {
    const parsed = Date.parse(timestamp || '');
    return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}

function formatDuration(ms) {
    if (!Number.isFinite(ms)) return 'unknown';
    if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

const PROVIDER_LATENCY_DELAYED_MS = 8000;
const PROVIDER_LATENCY_SLOW_MS = 20000;

function providerLatencyBand(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown';
    if (ms >= PROVIDER_LATENCY_SLOW_MS) return 'slow';
    if (ms >= PROVIDER_LATENCY_DELAYED_MS) return 'delayed';
    return 'normal';
}

function providerLatencySummary(ms) {
    return Number.isFinite(ms) && ms >= 0 ? `${formatDuration(ms)} ${providerLatencyBand(ms)}` : 'unknown';
}

function printJson(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + os.EOL);
}

async function pathExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readJson(filePath) {
    try {
        return JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

function defaultOutsidePolicy(root) {
    return {
        version: 1,
        mode: 'observe',
        workspace: root,
        updatedAt: new Date().toISOString(),
        permissions: {
            readWorkspace: true,
            writeFiles: false,
            runCommands: false,
            paidProviderCalls: false,
            gitMutations: false,
            autonomousLoops: false,
        },
        confirmations: {
            beforeWrite: true,
            beforeCommand: true,
            beforePaidProvider: true,
            beforeGitMutation: true,
        },
        budgets: {
            maxAutonomousSteps: 0,
            maxCommandSeconds: 0,
            maxEstimatedUsd: 0,
        },
        notes: [
            'Default outside-VS policy is observe-only.',
            'Enable individual permissions deliberately before terminal or floating Harmony performs agentic actions.',
        ],
    };
}

async function readOutsidePolicy(root) {
    return await readJson(outsidePolicyPath(root));
}

async function readDirSafe(dirPath) {
    try {
        return await fsp.readdir(dirPath);
    } catch {
        return [];
    }
}

async function readJsonRecords(dirPath, limit = 100) {
    const names = (await readDirSafe(dirPath)).filter(name => name.endsWith('.json')).slice(-limit);
    const records = [];
    for (const name of names) {
        const filePath = path.join(dirPath, name);
        const value = await readJson(filePath);
        if (value && typeof value === 'object') records.push({ file: name, ...value });
        else records.push({ file: name, malformed: true });
    }
    return records;
}

async function readTail(filePath, limit = 20) {
    try {
        const lines = (await fsp.readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean);
        return lines.slice(-limit);
    } catch {
        return [];
    }
}

function isPidAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
    try {
        process.kill(numericPid, 0);
        return true;
    } catch (error) {
        return error && error.code === 'EPERM';
    }
}

async function requestJson(rawUrl, timeoutMs = 1500) {
    const url = new URL(rawUrl);
    const lib = url.protocol === 'https:' ? https : http;
    return await new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            timeout: timeoutMs,
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { resolve(data); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.end();
    });
}

async function postJson(rawUrl, payload, timeoutMs = 1500) {
    const url = new URL(rawUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    return await new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
            },
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { resolve(data); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.write(body);
        req.end();
    });
}

function hubBaseUrl(options) {
    const base = String(options['hub-url'] || process.env.HARMONY_HUB_URL || DEFAULT_HUB_URL).trim() || DEFAULT_HUB_URL;
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `http://${base}`);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

function hubEndpointUrl(options, endpoint) {
    return new URL(endpoint.replace(/^\//, ''), hubBaseUrl(options));
}

const CLI_PROVIDER_DEFAULTS = {
    deepseek: { model: 'deepseek-v4-flash', env: ['HARMONY_DEEPSEEK_API_KEY', 'DEEPSEEK_AGENT_API_KEY', 'DEEPSEEK_EXTERNAL_API_KEY', 'EXTERNAL_UI_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'], executable: true, baseUrl: 'https://api.deepseek.com/v1' },
    alibaba: { model: 'qwen-turbo-latest', env: ['HARMONY_ALIBABA_API_KEY', 'ALIBABA_AGENT_API_KEY', 'ALIBABA_EXTERNAL_API_KEY', 'ALIBABA_API_KEY', 'DASHSCOPE_API_KEY', 'Alibaba_API_KEY'], executable: true, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    moonshot: { model: 'kimi-k2.6', env: ['HARMONY_MOONSHOT_API_KEY', 'MOONSHOT_AGENT_API_KEY', 'MOONSHOT_EXTERNAL_API_KEY', 'MOONSHOT_API_KEY', 'Moonshot_API_KEY'], executable: true, baseUrl: 'https://api.moonshot.ai/v1' },
    gemini: { model: 'gemini-3.1-flash-lite', env: ['HARMONY_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'], executable: true },
    openrouter: { model: 'deepseek/deepseek-r1:free', env: ['HARMONY_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], executable: true, baseUrl: 'https://openrouter.ai/api/v1' },
    openai: { model: 'gpt-4o-mini', env: ['HARMONY_OPENAI_API_KEY', 'OPENAI_API_KEY'], executable: true, baseUrl: 'https://api.openai.com/v1' },
    claude: { model: 'claude-sonnet-4', env: ['HARMONY_CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'], executable: false },
    kimiCode: { model: 'kimi-for-coding', env: ['HARMONY_KIMICODE_API_KEY', 'KIMICODE_API_KEY'], executable: true, baseUrl: 'https://api.kimi.com/coding/v1' },
    tencent: { model: 'hy3-preview', env: ['HARMONY_TENCENT_API_KEY', 'TENCENT_API_KEY'], executable: true, baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
    zhipu: { model: 'glm-5.3', env: ['HARMONY_ZHIPU_API_KEY', 'ZHIPU_API_KEY'], executable: true, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    'zhipu-coding': { model: 'glm-5.3', env: ['HARMONY_ZHIPU_API_KEY', 'ZHIPU_API_KEY'], executable: true, baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    doubao: { model: 'doubao-seed-2-1-turbo', env: ['HARMONY_BYTEDANCE_API_KEY', 'DOUBAO_API_KEY', 'ARK_API_KEY'], executable: true, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    'doubao-coding': { model: 'doubao-seed-code', env: ['HARMONY_BYTEDANCE_API_KEY', 'DOUBAO_API_KEY', 'ARK_API_KEY'], executable: true, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    byteplus: { model: 'seed-2-0-lite-260428', env: ['HARMONY_BYTEPLUS_API_KEY', 'BYTEPLUS_API_KEY'], executable: true, baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3' },
    'byteplus-coding': { model: 'seed-2-0-code-preview-260328', env: ['HARMONY_BYTEPLUS_API_KEY', 'BYTEPLUS_API_KEY'], executable: true, baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3' },
    stepfun: { model: 'step-3.7-flash', env: ['HARMONY_STEPFUN_API_KEY', 'STEPFUN_API_KEY'], executable: true, baseUrl: 'https://api.stepfun.ai/v1' },
};

const CLI_PROVIDER_ORDER = ['deepseek', 'alibaba', 'moonshot', 'kimiCode', 'gemini', 'openrouter', 'openai', 'claude', 'tencent', 'zhipu', 'zhipu-coding', 'doubao', 'doubao-coding', 'byteplus', 'byteplus-coding', 'stepfun'];
const CLI_ALIBABA_ENDPOINTS = {
    international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    mainland: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};
let WINDOWS_ENV_VALUE_CACHE;

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/$/, '');
}

function windowsEnvironmentCandidateNames(extraName) {
    const names = new Set();
    for (const [provider, config] of Object.entries(CLI_PROVIDER_DEFAULTS)) {
        for (const name of config.env || []) names.add(name);
        names.add(`HARMONY_${provider.toUpperCase()}_ENDPOINT_PROFILE`);
        names.add(`${provider.toUpperCase()}_ENDPOINT_PROFILE`);
        names.add(`HARMONY_${provider.toUpperCase()}_BASE_URL`);
        names.add(`${provider.toUpperCase()}_BASE_URL`);
    }
    names.add('DASHSCOPE_BASE_URL');
    if (extraName) names.add(extraName);
    return Array.from(names).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

function loadWindowsEnvironmentValues(extraName) {
    if (process.platform !== 'win32') return new Map();
    const names = windowsEnvironmentCandidateNames(extraName);
    const script = `$names = ${powerShellSingleQuoted(JSON.stringify(names))} | ConvertFrom-Json; $out = @(); foreach ($name in $names) { $scope='User'; $value=[Environment]::GetEnvironmentVariable($name,'User'); if ([string]::IsNullOrWhiteSpace($value)) { $scope='Machine'; $value=[Environment]::GetEnvironmentVariable($name,'Machine') }; if (![string]::IsNullOrWhiteSpace($value)) { $out += [pscustomobject]@{ name=$name; scope=$scope; value=$value } } }; $out | ConvertTo-Json -Compress`;
    const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    const cache = new Map();
    if (!result.error && result.status === 0 && String(result.stdout || '').trim()) {
        try {
            const parsed = JSON.parse(String(result.stdout || '').trim());
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            for (const row of rows) {
                const key = String(row.name || '').trim();
                const value = normalizeProviderCredentialValue(row.value);
                if (key && value) cache.set(key, { name: key, value, scope: String(row.scope || '').toLowerCase() === 'machine' ? 'machine-env' : 'user-env' });
            }
        } catch {
            // Keep the lookup fail-closed and no-echo; status will fall back to DPAPI metadata.
        }
    }
    return cache;
}

function readWindowsEnvironmentVariable(name) {
    if (process.platform !== 'win32') return undefined;
    const key = String(name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
    if (!WINDOWS_ENV_VALUE_CACHE) WINDOWS_ENV_VALUE_CACHE = loadWindowsEnvironmentValues(key);
    return WINDOWS_ENV_VALUE_CACHE.get(key);
}

function readEnvironmentVariable(name) {
    const key = String(name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
    const processValue = normalizeProviderCredentialValue(process.env[key]);
    if (processValue) return { name: key, value: processValue, scope: 'process-env' };
    return readWindowsEnvironmentVariable(key);
}

function firstEnvValue(names) {
    for (const name of names) {
        const found = readEnvironmentVariable(name);
        if (found?.value) return found;
    }
    return undefined;
}

function cliProviderEndpointProfile(provider, options = {}) {
    const explicit = String(options['endpoint-profile'] || options.endpointProfile || '').toLowerCase().trim();
    const envProfile = firstEnvValue([`HARMONY_${provider.toUpperCase()}_ENDPOINT_PROFILE`, `${provider.toUpperCase()}_ENDPOINT_PROFILE`])?.value.toLowerCase().trim();
    const requested = explicit || envProfile || (provider === 'alibaba' ? 'international' : 'default');
    const allowed = provider === 'alibaba' ? ['international', 'mainland', 'us', 'custom'] : ['default', 'custom'];
    if (!allowed.includes(requested)) throw new Error(`${provider} endpoint profile must be one of: ${allowed.join(', ')}`);
    return requested;
}

function cliProviderCustomBaseUrl(provider, options = {}) {
    const optionValue = normalizeBaseUrl(options['base-url'] || options.baseUrl);
    if (optionValue) return { source: '--base-url', value: optionValue };
    const env = firstEnvValue([
        `HARMONY_${provider.toUpperCase()}_BASE_URL`,
        `${provider.toUpperCase()}_BASE_URL`,
        provider === 'alibaba' ? 'DASHSCOPE_BASE_URL' : ''
    ].filter(Boolean));
    if (env?.value) return { source: env.name, value: normalizeBaseUrl(env.value) };
    return undefined;
}

function cliProviderEndpointInfo(provider, options = {}) {
    const config = CLI_PROVIDER_DEFAULTS[provider];
    if (!config) return { provider, profile: 'unknown', baseUrl: '', detail: 'unknown provider', configured: false };
    if (provider === 'gemini') return { provider, profile: 'model-derived', baseUrl: '', detail: 'Gemini API endpoint is model-derived', configured: true };
    const profile = cliProviderEndpointProfile(provider, options);
    if (provider === 'alibaba') {
        if (profile === 'international') return { provider, profile, baseUrl: CLI_ALIBABA_ENDPOINTS.international, detail: 'Alibaba international/Singapore/global endpoint', configured: true };
        if (profile === 'mainland') return { provider, profile, baseUrl: CLI_ALIBABA_ENDPOINTS.mainland, detail: 'Alibaba mainland China/Beijing endpoint', configured: true };
        if (profile === 'us') {
            const custom = cliProviderCustomBaseUrl(provider, options);
            return {
                provider,
                profile,
                baseUrl: custom?.value || CLI_ALIBABA_ENDPOINTS.international,
                detail: custom?.value ? `Alibaba US/Virginia endpoint override from ${custom.source}` : 'Alibaba US/Virginia endpoint via shared international OpenAI-compatible URL',
                configured: true,
            };
        }
        const custom = cliProviderCustomBaseUrl(provider, options);
        return {
            provider,
            profile,
            baseUrl: custom?.value || '',
            detail: custom?.value ? `Alibaba ${profile} endpoint from ${custom.source}` : `Alibaba ${profile} endpoint needs --base-url, HARMONY_ALIBABA_BASE_URL, ALIBABA_BASE_URL, or DASHSCOPE_BASE_URL`,
            configured: Boolean(custom?.value),
        };
    }
    if (profile === 'custom') {
        const custom = cliProviderCustomBaseUrl(provider, options);
        return {
            provider,
            profile,
            baseUrl: custom?.value || '',
            detail: custom?.value ? `${provider} custom endpoint from ${custom.source}` : `${provider} custom endpoint needs --base-url or HARMONY_${provider.toUpperCase()}_BASE_URL`,
            configured: Boolean(custom?.value),
        };
    }
    return { provider, profile, baseUrl: normalizeBaseUrl(config.baseUrl), detail: `${provider} default endpoint`, configured: Boolean(config.baseUrl) };
}

function cliProviderBaseUrl(provider, options = {}) {
    const endpoint = cliProviderEndpointInfo(provider, options);
    if (!endpoint.baseUrl) throw new Error(`${provider} endpoint profile ${endpoint.profile} is missing a base URL. ${endpoint.detail}`);
    return endpoint.baseUrl;
}

function providerSecretPath(root, provider) {
    return path.join(providerSecretsDir(root), `${provider}.json`);
}

function assertKnownProvider(provider) {
    if (!CLI_PROVIDER_DEFAULTS[provider]) throw new Error(`unknown provider: ${provider}`);
}

function runPowerShellDpapi(script, input) {
    if (process.platform !== 'win32') throw new Error('Harmony secret store currently supports Windows DPAPI only');
    const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        input,
        encoding: 'utf8',
        windowsHide: false,
        maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `PowerShell exited ${result.status}`).trim());
    return String(result.stdout || '').trim();
}

function powerShellSingleQuoted(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function dpapiProtect(secret) {
    return runPowerShellDpapi('Add-Type -AssemblyName System.Security; $plain=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($plain); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($protected)', secret);
}

function dpapiProtectFromPrompt(provider) {
    if (!process.stdin.isTTY) throw new Error('secret prompt requires an interactive terminal; use --from-env <ENV_NAME> for non-interactive import');
    const label = provider.replace(/[^a-zA-Z0-9._-]+/g, ' ');
    const outPath = path.join(os.tmpdir(), `harmony-dpapi-secret-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
    const script = `Add-Type -AssemblyName System.Security; $secure=Read-Host -Prompt 'Harmony ${label} API key' -AsSecureString; $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr); $bytes=[Text.Encoding]::UTF8.GetBytes($plain); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllText(${powerShellSingleQuoted(outPath)}, [Convert]::ToBase64String($protected), [Text.Encoding]::UTF8) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }`;
    const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        stdio: 'inherit',
        windowsHide: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PowerShell exited ${result.status}`);
    try {
        return fs.readFileSync(outPath, 'utf8').trim();
    } finally {
        fs.rmSync(outPath, { force: true });
    }
}

function dpapiUnprotect(ciphertext) {
    return runPowerShellDpapi('Add-Type -AssemblyName System.Security; $encrypted=[Console]::In.ReadToEnd(); $protected=[Convert]::FromBase64String($encrypted.Trim()); $bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)', ciphertext);
}

function readStoredProviderSecret(root, provider) {
    const filePath = providerSecretPath(root, provider);
    if (!fs.existsSync(filePath)) return undefined;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return undefined; }
    if (payload.provider !== provider || payload.encryption !== 'windows-dpapi-current-user' || !payload.ciphertext) return undefined;
    return { ...payload, filePath };
}

function normalizeProviderCredentialValue(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, '').trim();
}

async function readProviderCredentialImportFile(root, rawPath) {
    const filePath = path.resolve(root, String(rawPath || '').trim());
    if (!filePath) throw new Error('secrets set --from-file requires a path');
    const stat = await fsp.stat(filePath).catch(() => undefined);
    if (!stat || !stat.isFile()) throw new Error(`secret import file not found: ${normalizePath(filePath)}`);
    if (stat.size > 64 * 1024) throw new Error('secret import file is too large; expected a single API key under 64KB');
    const raw = await fsp.readFile(filePath, 'utf8');
    const value = normalizeProviderCredentialValue(raw.replace(/^\uFEFF/, ''));
    if (!value) throw new Error('secret import file is empty after header-safe normalization');
    return { filePath, value };
}

function parseDotenvLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return undefined;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = withoutExport.indexOf('=');
    if (equalsIndex <= 0) return undefined;
    const name = withoutExport.slice(0, equalsIndex).trim();
    let value = withoutExport.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return { name, value: normalizeProviderCredentialValue(value) };
}

async function readProviderCredentialDotenvFile(root, provider, rawPath, requestedName) {
    const filePath = path.resolve(root, String(rawPath || '').trim());
    if (!filePath) throw new Error('secrets set --from-dotenv requires a path');
    const stat = await fsp.stat(filePath).catch(() => undefined);
    if (!stat || !stat.isFile()) throw new Error(`dotenv import file not found: ${normalizePath(filePath)}`);
    if (stat.size > 128 * 1024) throw new Error('dotenv import file is too large; expected a small local env file under 128KB');
    const config = CLI_PROVIDER_DEFAULTS[provider];
    const allowedNames = requestedName ? [requestedName] : (config?.env || []);
    const parsed = (await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).map(parseDotenvLine).filter(Boolean);
    const found = allowedNames.map(name => parsed.find(item => item.name === name)).find(Boolean);
    if (!found?.value) throw new Error(`no matching ${provider} key found in dotenv file. Looked for: ${allowedNames.join(', ')}`);
    return { filePath, envName: found.name, value: found.value };
}

function providerCredentialMetadata(provider, root) {
    const config = CLI_PROVIDER_DEFAULTS[provider];
    if (!config) return undefined;
    for (const name of config.env) {
        const env = readEnvironmentVariable(name);
        if (env?.value) return { source: env.scope, name };
    }
    if (root) {
        const stored = readStoredProviderSecret(root, provider);
        if (stored) {
            const value = normalizeProviderCredentialValue(dpapiUnprotect(stored.ciphertext));
            if (value) return { source: 'harmony-secret-store', name: 'windows-dpapi-current-user' };
        }
    }
    return undefined;
}

function providerCredential(provider, root) {
    const config = CLI_PROVIDER_DEFAULTS[provider];
    if (!config) return undefined;
    for (const name of config.env) {
        const env = readEnvironmentVariable(name);
        if (env?.value) return { source: env.scope, name, value: env.value };
    }
    if (root) {
        const stored = readStoredProviderSecret(root, provider);
        if (stored) {
            const value = normalizeProviderCredentialValue(dpapiUnprotect(stored.ciphertext));
            if (value) return { source: 'harmony-secret-store', name: 'windows-dpapi-current-user', value };
        }
    }
    return undefined;
}

function recentTerminalAskLatencyByProvider(root) {
    const out = new Map();
    try {
        const dir = terminalAskDir(root);
        if (!fs.existsSync(dir)) return out;
        const files = fs.readdirSync(dir)
            .filter(name => name.endsWith('.json'))
            .map(name => {
                const filePath = path.join(dir, name);
                let mtimeMs = 0;
                try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ignore stale entry */ }
                return { name, filePath, mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, 100);
        for (const file of files) {
            try {
                const receipt = JSON.parse(fs.readFileSync(file.filePath, 'utf8'));
                const provider = String(receipt.provider || '').toLowerCase().trim();
                const durationMs = Number(receipt.latency?.durationMs ?? receipt.durationMs);
                if (!provider || out.has(provider) || !Number.isFinite(durationMs) || durationMs < 0) continue;
                out.set(provider, {
                    durationMs,
                    band: String(receipt.latency?.band || providerLatencyBand(durationMs)),
                    at: receipt.completedAt || receipt.createdAt,
                    receiptId: receipt.id || path.basename(file.name, '.json'),
                });
            } catch { /* ignore unreadable or older receipt shape */ }
        }
    } catch { /* provider status must never fail because receipt history is unavailable */ }
    return out;
}

function providerStatusRows(root) {
    const recentLatency = recentTerminalAskLatencyByProvider(root);
    return CLI_PROVIDER_ORDER.map(provider => {
        const config = CLI_PROVIDER_DEFAULTS[provider];
        const credential = providerCredentialMetadata(provider, root);
        const stored = root ? readStoredProviderSecret(root, provider) : undefined;
        const endpoint = cliProviderEndpointInfo(provider, {});
        const latency = recentLatency.get(provider);
        return {
            provider,
            executable: Boolean(config.executable),
            configured: Boolean(credential),
            credentialSource: credential ? credential.source : undefined,
            credentialName: credential ? credential.name : undefined,
            stored: Boolean(stored),
            storedUpdatedAt: stored?.updatedAt,
            envCandidates: config.env,
            recommendedEnvName: config.env[0],
            secretImportCommand: `node bin/harmony-cli.js secrets set --provider ${provider} --from-env ${config.env[0]} --confirm`,
            interactiveSecretCommand: `node bin/harmony-cli.js secrets set --provider ${provider} --confirm`,
            defaultModel: config.model,
            endpointProfile: endpoint.profile,
            baseUrl: endpoint.baseUrl || undefined,
            endpointDetail: endpoint.detail,
            lastLatencyMs: latency?.durationMs,
            lastLatencyBand: latency?.band,
            lastLatencyAt: latency?.at,
            lastLatencyReceiptId: latency?.receiptId,
        };
    });
}

function providerLiveHarnessProviders(options) {
    const raw = String(options.providers || options.provider || CLI_PROVIDER_ORDER.join(','));
    const providers = raw.split(/[\s,]+/).map(item => item.toLowerCase().trim()).filter(Boolean);
    return Array.from(new Set(providers.length ? providers : CLI_PROVIDER_ORDER));
}

function providerLiveHarnessPlannedCommand(root, provider, model, options = {}) {
    const safeRoot = String(root).replace(/"/g, '\\"');
    const endpoint = provider === 'gemini' ? undefined : cliProviderEndpointInfo(provider, options);
    const endpointProfileArg = endpoint?.profile ? ` --endpoint-profile ${endpoint.profile}` : '';
    return `node bin/harmony-cli.js --workspace "${safeRoot}" ask "Harmony live provider smoke for ${provider}: reply with HARMONY_PROVIDER_OK." --execute --confirm --provider ${provider}${endpointProfileArg} --model ${model} --max-tokens 64 --timeout 30000`;
}

function buildProviderLiveHarnessReport(root, options = {}) {
    const providers = providerLiveHarnessProviders(options);
    const providerPlans = providers.map(provider => {
        const config = CLI_PROVIDER_DEFAULTS[provider];
        const credential = config ? providerCredentialMetadata(provider, root) : undefined;
        const endpoint = config ? cliProviderEndpointInfo(provider, options) : { profile: 'unknown', baseUrl: '', detail: 'unknown provider', configured: false };
        const checks = [
            { name: 'known_provider', status: config ? 'passed' : 'failed', detail: provider },
            { name: 'executable_provider_route', status: config?.executable === true ? 'passed' : 'failed', detail: config?.executable === true ? 'CLI provider route is executable when explicitly confirmed later' : 'provider is not executable from CLI' },
            { name: 'default_model_present', status: config?.model ? 'passed' : 'failed', detail: config?.model || 'missing default model' },
            { name: 'endpoint_configured', status: provider === 'gemini' || Boolean(endpoint.baseUrl) ? 'passed' : 'failed', detail: endpoint.detail || 'missing OpenAI-compatible base URL' },
            { name: 'network_not_called', status: 'passed', detail: 'dry-run harness only; no provider HTTP request is made' },
            { name: 'secret_value_not_included', status: 'passed', detail: credential ? `credential metadata only: ${credential.source}/${credential.name}` : 'no credential value read into report' },
        ];
        return {
            provider,
            status: checks.every(check => check.status === 'passed') ? 'ready-for-later-live-smoke' : 'blocked',
            model: config?.model || '',
            endpointProfile: endpoint.profile,
            endpoint: provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent' : (endpoint.baseUrl ? `${String(endpoint.baseUrl).replace(/\/$/, '')}/chat/completions` : ''),
            envCandidates: config?.env || [],
            credential: credential ? { configured: true, source: credential.source, name: credential.name } : { configured: false, source: 'missing', name: '' },
            credentialRequiredBeforeLiveCall: true,
            liveCall: { performed: false, reason: 'provider live harness does not call providers' },
            plannedLiveCommand: config ? providerLiveHarnessPlannedCommand(root, provider, config.model, options) : '',
            checks,
        };
    });
    const checks = [
        { name: 'requested_providers_present', status: providerPlans.length ? 'passed' : 'failed', detail: providerPlans.map(item => item.provider).join(', ') || 'none' },
        { name: 'provider_calls_disabled', status: 'passed', detail: 'providerCalls=false for this harness run' },
        { name: 'network_disabled', status: 'passed', detail: 'no HTTP request is issued by provider live harness' },
        { name: 'requested_providers_known', status: providers.every(p => Boolean(CLI_PROVIDER_DEFAULTS[p])) ? 'passed' : 'failed', detail: providers.join(', ') },
    ];
    return {
        version: 1,
        id: `provider-live-harness-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
        kind: 'smoke.providerLiveHarness',
        createdAt: new Date().toISOString(),
        workspace: root,
        status: providerPlans.every(item => item.status !== 'blocked') && checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
        posture: 'provider-live-smoke-harness-no-provider-calls',
        authority: {
            providerCalls: false,
            networkRequests: false,
            sourceFileWrites: false,
            terminalCommands: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        approvalPlan: {
            status: 'not-approved-not-executed',
            requiredBeforeAnyLiveProviderCall: [
                'User explicitly approves a live provider smoke in chat or the native UI.',
                'Operator confirms provider keys are present in the intended store: VS Code Secret Storage for extension-side calls, Windows DPAPI or env for CLI/native calls.',
                'Operator confirms a small budget cap for the smoke run.',
                'Operator runs a separate command that includes --execute --confirm; smoke/provider-live-harness never upgrades itself into a live call.',
            ],
            recommendedInitialBudgetUsd: 1,
            plannedProviders: providers,
            plannedPrompt: 'Harmony live provider smoke: reply with HARMONY_PROVIDER_OK.',
        },
        providers: providerPlans,
        checks,
        notes: [
            'This harness prepares live smoke metadata for the configured CLI providers.',
            'It does not call provider APIs, spend budget, print key values, write source files, run terminal commands, mutate git, install packages, reload editors, or delete chats.',
            'Later live smoke requires an explicit separate command with --execute --confirm after keys and budget are approved.',
        ],
    };
}

async function writeProviderLiveHarnessReport(root, report) {
    const dir = harmonyPath(root, 'smoke');
    await fsp.mkdir(dir, { recursive: true });
    const reportPath = path.join(dir, `${report.id}.json`);
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'smoke.providerLiveHarness',
        label: `Provider live harness ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(reportPath),
        providers: report.providers.map(item => item.provider),
    });
    return reportPath;
}

function selectCliProvider(options, root) {
    const requested = String(options.provider || 'auto').toLowerCase().trim();
    if (requested && requested !== 'auto') {
        if (!CLI_PROVIDER_DEFAULTS[requested]) throw new Error(`unknown provider: ${requested}`);
        return requested;
    }
    for (const provider of CLI_PROVIDER_ORDER) {
        const config = CLI_PROVIDER_DEFAULTS[provider];
        if (config.executable && providerCredential(provider, root)) return provider;
    }
    return 'deepseek';
}

async function postJsonWithHeaders(rawUrl, payload, headers = {}, timeoutMs = 30000) {
    const url = new URL(rawUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    return await new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                ...headers,
            },
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 1200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { resolve(data); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.write(body);
        req.end();
    });
}

async function callGeminiFromCli(apiKey, model, prompt, options) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await postJsonWithHeaders(url, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: Number(options['max-tokens'] || 1024) },
    }, {}, Number(options.timeout || 30000));
    const text = (response.candidates || []).flatMap(candidate => ((candidate.content || {}).parts || []).map(part => part.text || '')).join('\n').trim();
    return { text, usage: response.usageMetadata || undefined, rawStatus: response.promptFeedback || undefined };
}

async function callOpenAiCompatFromCli(provider, apiKey, model, prompt, options) {
    const baseUrl = cliProviderBaseUrl(provider, options);
    const payload = {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: Number(options['max-tokens'] || 1024),
    };
    if (provider === 'deepseek' && options.thinking !== true && options['enable-thinking'] !== true) {
        payload.thinking = { type: 'disabled' };
    }
    const response = await postJsonWithHeaders(`${baseUrl}/chat/completions`, payload, {
        authorization: `Bearer ${apiKey}`,
        'http-referer': 'https://github.com/harmony-extension',
        'x-title': 'Harmony Extension Terminal Ask',
    }, Number(options.timeout || 30000));
    const text = (((response.choices || [])[0] || {}).message || {}).content || '';
    return { text: String(text).trim(), usage: response.usage || undefined, rawStatus: response.id ? { id: response.id } : undefined };
}

async function executeTerminalAsk(root, prompt, options) {
    const provider = selectCliProvider(options, root);
    const config = CLI_PROVIDER_DEFAULTS[provider];
    if (!config.executable) throw new Error(`${provider} is visible in provider status but is not executable from the CLI yet`);
    const credential = providerCredential(provider, root);
    if (!credential) throw new Error(`missing ${provider} API key. Set one of: ${config.env.join(', ')}, or run: node bin/harmony-cli.js secrets set --provider ${provider} --from-env <ENV_NAME> --confirm`);
    const model = String(options.model || config.model);
    const startedAt = Date.now();
    const result = provider === 'gemini'
        ? await callGeminiFromCli(credential.value, model, prompt, options)
        : await callOpenAiCompatFromCli(provider, credential.value, model, prompt, options);
    const durationMs = Date.now() - startedAt;
    return {
        provider,
        model,
        credentialSource: credential.source,
        credentialName: credential.name,
        text: result.text,
        usage: result.usage,
        rawStatus: result.rawStatus,
        durationMs,
        latency: { durationMs, band: providerLatencyBand(durationMs) },
    };
}

async function writeBrokerRequest(root, receipt, prompt, options) {
    const provider = String(options.provider && options.provider !== 'auto' ? options.provider : 'gemini').toLowerCase().trim();
    if (!CLI_PROVIDER_DEFAULTS[provider]) throw new Error(`unknown provider for VS Code broker request: ${provider}`);
    const tier = String(options.tier || 'coding').toLowerCase().trim();
    if (!['light', 'mid', 'heavy', 'coding'].includes(tier)) throw new Error('broker ask --tier must be light, mid, heavy, or coding');
    const dir = path.join(providerBrokerDir(root), 'requests');
    await fsp.mkdir(dir, { recursive: true });
    const requestPath = path.join(dir, `${receipt.id}.json`);
    const request = {
        version: 1,
        id: receipt.id,
        kind: 'ask',
        status: 'queued_for_vscode_broker',
        workspace: root,
        provider,
        tier,
        prompt,
        maxTokens: Number(options['max-tokens'] || 1024),
        createdAt: new Date().toISOString(),
        source: 'harmony-cli',
    };
    await fsp.writeFile(requestPath, JSON.stringify(request, null, 2), 'utf8');
    return { request, requestPath };
}

function brokerTimeoutSeconds(options) {
    const raw = options['broker-timeout'] ?? options['broker-timeout-seconds'] ?? options['wait-for-broker'];
    if (raw === undefined || raw === false) return 0;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--broker-timeout must be a non-negative number of seconds');
    return Math.min(Math.floor(seconds), 600);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForBrokerResponse(root, requestId, timeoutSeconds) {
    const responsePath = path.join(providerBrokerDir(root), 'responses', `${requestId}.json`);
    const deadline = Date.now() + (timeoutSeconds * 1000);
    while (Date.now() <= deadline) {
        const response = await readJson(responsePath);
        if (response) return { response, responsePath: normalizePath(responsePath), timedOut: false };
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(500, remaining));
    }
    return { response: undefined, responsePath: normalizePath(responsePath), timedOut: true };
}

async function readBrokerState(root) {
    const baseDir = providerBrokerDir(root);
    const readRecords = async (subdir) => {
        const dir = path.join(baseDir, subdir);
        const names = (await fsp.readdir(dir).catch(() => [])).filter(name => name.endsWith('.json')).sort();
        const records = [];
        for (const name of names) {
            const filePath = path.join(dir, name);
            const payload = await readJson(filePath) || {};
            records.push({
                id: payload.id || path.basename(name, '.json'),
                provider: payload.provider,
                tier: payload.tier,
                status: payload.status,
                createdAt: payload.createdAt,
                age: formatDuration(ageMs(payload.createdAt)),
                path: normalizePath(filePath),
                error: payload.error,
            });
        }
        return records;
    };
    const pending = await readRecords('requests');
    const responses = await readRecords('responses');
    const processed = await readRecords('processed');
    return {
        version: 1,
        workspace: root,
        brokerDir: normalizePath(baseDir),
        pending,
        responses,
        processed,
        noVsCodeBehavior: pending.length
            ? 'Pending requests remain queued until VS Code/Cursor is open with this workspace and Harmony: Process Provider Broker Queue runs.'
            : 'No pending VS Code SecretStorage broker requests.',
    };
}

async function commandBroker(root, subcommand, options) {
    if (subcommand && subcommand !== 'status') throw new Error('broker supports: status');
    const state = await readBrokerState(root);
    if (options.json) {
        printJson(state);
        return 0;
    }
    const lines = [
        'VS Code SecretStorage broker status',
        `Workspace: ${root}`,
        `Pending: ${state.pending.length}`,
        `Responses: ${state.responses.length}`,
        `Processed: ${state.processed.length}`,
        state.noVsCodeBehavior,
    ];
    if (state.pending.length) {
        lines.push('', 'Pending requests:');
        for (const request of state.pending.slice(0, Number(options.limit || 20))) {
            lines.push(`- ${request.id}: provider=${request.provider || '?'} tier=${request.tier || '?'} age=${request.age}`);
        }
    }
    lines.push('');
    process.stdout.write(lines.join(os.EOL));
    return 0;
}

function splitCommandLine(commandLine) {
    const parts = [];
    let current = '';
    let quote = '';
    let escaped = false;
    for (const char of String(commandLine)) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) quote = '';
            else current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                parts.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (quote) throw new Error('command line has an unterminated quote');
    if (escaped) current += '\\';
    if (current) parts.push(current);
    return parts;
}

function truncateText(value, max = 12000) {
    const text = String(value || '');
    return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

async function executeValidationCommand(root, options, policy) {
    const commandLine = String(options.command || options.cmd || '').trim();
    if (!commandLine) throw new Error('run-fail-fix --execute requires --command "<validation command>"');
    const parts = splitCommandLine(commandLine);
    if (!parts.length) throw new Error('run-fail-fix command is empty');
    const budgetSeconds = Number(policy?.budgets?.maxCommandSeconds || 0);
    const timeoutSeconds = Number(options['command-timeout'] || options.seconds || Math.min(30, budgetSeconds || 30));
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('run-fail-fix --command-timeout requires a positive number of seconds');
    if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error('outside-VS policy budget maxCommandSeconds must be greater than 0 before command execution');
    if (timeoutSeconds > budgetSeconds) throw new Error(`requested command timeout ${timeoutSeconds}s exceeds policy maxCommandSeconds ${budgetSeconds}s`);
    return await new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = childProcess.spawn(parts[0], parts.slice(1), {
            cwd: root,
            shell: false,
            windowsHide: true,
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, Math.ceil(timeoutSeconds * 1000));
        child.stdout.on('data', chunk => { stdout = truncateText(stdout + chunk.toString()); });
        child.stderr.on('data', chunk => { stderr = truncateText(stderr + chunk.toString()); });
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (exitCode, signal) => {
            clearTimeout(timer);
            resolve({
                command: parts[0],
                args: parts.slice(1),
                commandLine,
                cwd: root,
                startedAt,
                finishedAt: new Date().toISOString(),
                timeoutSeconds,
                timedOut,
                exitCode,
                signal,
                stdout: truncateText(stdout),
                stderr: truncateText(stderr),
            });
        });
    });
}

function statusUrl(options) {
    return hubEndpointUrl(options, 'status').toString();
}

async function checkHub(options) {
    const url = statusUrl(options);
    try {
        const response = await requestJson(url, Number(options.timeout || 1500));
        return { url, online: true, response };
    } catch (error) {
        return { url, online: false, error: error && error.message ? error.message : String(error) };
    }
}

function hubSupervisorUrl(root, options) {
    const url = hubEndpointUrl(options, 'supervisor');
    url.searchParams.set('workspace', root);
    return url.toString();
}

function hubLocksUrl(root, options) {
    const url = hubEndpointUrl(options, 'locks');
    url.searchParams.set('workspace', root);
    return url.toString();
}

function hubOperationsUrl(root, options) {
    const url = hubEndpointUrl(options, 'operations');
    url.searchParams.set('workspace', root);
    if (options.limit) url.searchParams.set('limit', String(options.limit));
    return url.toString();
}

function hubSecretsUrl(root, options) {
    const url = hubEndpointUrl(options, 'secrets');
    url.searchParams.set('workspace', root);
    return url.toString();
}

async function checkHubSupervisor(root, options) {
    const url = hubSupervisorUrl(root, options);
    try {
        const response = await requestJson(url, Number(options.timeout || 1500));
        return { url, online: true, response };
    } catch (error) {
        return { url, online: false, error: error && error.message ? error.message : String(error) };
    }
}

async function readSupervisor(root) {
    const records = await readJsonRecords(harmonyPath(root, 'supervisor', 'heartbeats'));
    return records.map(record => {
        const elapsed = ageMs(record.updatedAt);
        const staleAfterMs = Number(record.staleAfterMs || DEFAULT_STALE_AFTER_MS);
        return {
            ...record,
            ageMs: elapsed,
            status: elapsed <= staleAfterMs ? 'active' : 'stale',
            processAlive: isPidAlive(record.pid),
        };
    }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function readLocks(root) {
    const records = await readJsonRecords(harmonyPath(root, 'locks'));
    const now = Date.now();
    return records.map(record => {
        const expiresAt = Date.parse(record.expiresAt || '');
        return {
            ...record,
            expired: Number.isFinite(expiresAt) ? expiresAt <= now : undefined,
        };
    });
}

async function readManagedProcesses(root) {
    const records = await readJsonRecords(harmonyPath(root, 'processes', 'managed'));
    return records.map(record => ({ ...record, processAlive: isPidAlive(record.pid) }));
}

async function readLedger(root, limit = 20) {
    const ledgerPath = harmonyPath(root, 'operations', 'ledger.json');
    const ledger = await readJson(ledgerPath);
    const entries = Array.isArray(ledger && ledger.entries) ? ledger.entries.slice(-limit).reverse() : [];
    return { path: ledgerPath, updatedAt: ledger && ledger.updatedAt, entries };
}

async function appendLedgerEntry(root, entry) {
    const ledgerPath = harmonyPath(root, 'operations', 'ledger.json');
    const ledger = await readJson(ledgerPath) || {};
    const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
    const timestamp = new Date().toISOString();
    const record = {
        id: `op-${timestamp.replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`,
        timestamp,
        surface: 'harmony-cli',
        ...entry,
    };
    await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fsp.writeFile(ledgerPath, JSON.stringify({ version: 1, updatedAt: timestamp, entries: [...entries.slice(-499), record] }, null, 2), 'utf8');
    return { path: ledgerPath, entry: record };
}

function operationIdFromOptions(options) {
    return String(options['operation-id'] || options.id || options._[2] || '').trim();
}

function parseResourceList(value) {
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean).map(normalizePath);
}

async function readContinuity(root, limit = 10) {
    const ledgerPath = harmonyPath(root, 'continuity', 'ledger.jsonl');
    const lines = await readTail(ledgerPath, limit);
    const entries = lines.map(line => {
        try { return JSON.parse(line); }
        catch { return { malformed: true, raw: line.slice(0, 200) }; }
    }).reverse();
    return { path: ledgerPath, entries };
}

async function readPackage() {
    return await readJson(path.join(extensionRoot(), 'package.json')) || {};
}

async function readSnapshotSummaries(root, limit = 10) {
    const baseDir = snapshotsDir(root);
    const names = (await readDirSafe(baseDir)).filter(name => name.startsWith('snapshot-')).sort().reverse().slice(0, limit);
    const summaries = [];
    for (const name of names) {
        const snapshotDir = path.join(baseDir, name);
        const manifestPath = path.join(snapshotDir, 'manifest.json');
        const manifest = await readJson(manifestPath);
        const files = Array.isArray(manifest?.files) ? manifest.files : [];
        summaries.push({
            id: name,
            createdAt: manifest?.createdAt || '',
            reason: manifest?.reason || '',
            fileCount: files.length,
            copied: files.filter(file => file && file.copied).length,
            skipped: files.filter(file => file && !file.copied).length,
            coverage: `${files.filter(file => file && file.copied).length}/${files.length}`,
            restoreCommand: `node bin/harmony-cli.js --workspace "${String(root).replace(/"/g, '\\"')}" snapshot restore --id ${name} --all --confirm`,
            manifestPath,
        });
    }
    return summaries;
}

async function readSmokeReportSummaries(root, limit = 10) {
    const dir = harmonyPath(root, 'smoke');
    const names = (await readDirSafe(dir)).filter(name => name.endsWith('.json'));
    const reports = [];
    for (const name of names) {
        const filePath = path.join(dir, name);
        const report = await readJson(filePath) || {};
        const steps = Array.isArray(report.steps) ? report.steps : [];
        reports.push({
            id: report.id || path.basename(name, '.json'),
            createdAt: report.createdAt || '',
            status: report.status || 'unknown',
            passed: steps.filter(step => step && step.status === 'passed').length,
            failed: steps.filter(step => step && step.status === 'failed').length,
            path: normalizePath(filePath),
        });
    }
    return reports
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, limit);
}

function providerSecretMetadataRows(root) {
    return CLI_PROVIDER_ORDER.map(provider => {
        const stored = readStoredProviderSecret(root, provider);
        return {
            provider,
            stored: Boolean(stored),
            encryption: stored?.encryption,
            createdAt: stored?.createdAt,
            updatedAt: stored?.updatedAt,
            importedFromEnv: stored?.importedFromEnv,
            path: stored ? normalizePath(stored.filePath) : undefined,
        };
    });
}

function compareVersionStrings(left, right) {
    const leftParts = String(left || '').split('.').map(part => Number(part.replace(/\D.*$/, '')) || 0);
    const rightParts = String(right || '').split('.').map(part => Number(part.replace(/\D.*$/, '')) || 0);
    const max = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < max; index++) {
        const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
        if (diff) return diff;
    }
    return String(left || '').localeCompare(String(right || ''));
}

function installedExtensionDir(editor) {
    const home = os.homedir();
    return editor === 'cursor'
        ? path.join(home, '.cursor', 'extensions')
        : path.join(home, '.vscode', 'extensions');
}

async function scanInstalledHarmonyExtension(editor, expectedVersion) {
    const dir = installedExtensionDir(editor);
    const names = await readDirSafe(dir);
    const installed = names
        .map(name => {
            const match = /^harmony\.harmony-extension-(.+)$/i.exec(name);
            return match ? { version: match[1], extensionPath: path.join(dir, name) } : undefined;
        })
        .filter(Boolean)
        .sort((left, right) => compareVersionStrings(right.version, left.version));
    const latest = installed[0];
    return {
        editor,
        extensionsDir: dir,
        installed: Boolean(latest),
        version: latest?.version,
        matchesExpected: latest ? latest.version === expectedVersion : false,
        extensionPath: latest?.extensionPath,
        allVersions: installed.map(item => item.version),
    };
}

function readBundledHubVersion() {
    const filePath = hubExePath();
    if (!fs.existsSync(filePath)) return { exists: false, path: filePath };
    const result = childProcess.spawnSync(filePath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    return {
        exists: true,
        path: filePath,
        exitCode: result.status === null ? 1 : result.status,
        version: String(result.stdout || '').trim() || undefined,
        error: result.error ? result.error.message : String(result.stderr || '').trim() || undefined,
    };
}

async function nativeBackendSummary(options) {
    const host = String(options.host || '127.0.0.1');
    const port = Number(options._actualUiPort || options.port || 8788);
    const url = `http://${host}:${port}/`;
    if (options._servingUi) return { url, healthUrl: `${url}healthz`, online: true, source: 'current ui serve process' };
    if (!options['check-native-backend']) return { url, healthUrl: `${url}healthz`, online: undefined, source: 'not checked' };
    try {
        const response = await requestJson(`${url}healthz`, Number(options.timeout || 1500));
        return { url, healthUrl: `${url}healthz`, online: true, response };
    } catch (error) {
        return { url, healthUrl: `${url}healthz`, online: false, error: error && error.message ? error.message : String(error) };
    }
}

async function crossSurfaceSummary(root, options, pkg, broker, providerSecrets, switches) {
    const expectedVersion = pkg.version || 'unknown';
    const [vscode, cursor, nativeBackend] = await Promise.all([
        scanInstalledHarmonyExtension('vscode', expectedVersion),
        scanInstalledHarmonyExtension('cursor', expectedVersion),
        nativeBackendSummary(options),
    ]);
    return {
        expectedVersion,
        installedEditors: [vscode, cursor],
        bundledHub: readBundledHubVersion(),
        nativeBackend,
        broker: {
            pending: broker.pending.length,
            responses: broker.responses.length,
            processed: broker.processed.length,
            noVsCodeBehavior: broker.noVsCodeBehavior,
        },
        secretStore: {
            storedProviders: providerSecrets.filter(item => item.stored).length,
            totalProviders: providerSecrets.length,
            providers: providerSecrets,
        },
        safetySwitches: {
            failClosed: switches.filter(item => item.failClosed).length,
            total: switches.length,
            allFailClosed: switches.every(item => item.failClosed),
        },
        workspace: root,
    };
}

function swarmSafetySwitchRows(pkg) {
    const properties = pkg?.contributes?.configuration?.properties || {};
    const switches = [
        ['harmony.swarm.mutationExecution.enabled', 'Mutation execution'],
        ['harmony.swarm.patchExecution.enabled', 'Patch execution'],
        ['harmony.swarm.terminalExecution.enabled', 'Terminal execution'],
        ['harmony.swarm.providerCalls.enabled', 'Provider calls'],
        ['harmony.swarm.autonomyExecution.enabled', 'Autonomy execute mode'],
        ['harmony.swarm.commitExecution.enabled', 'Commit execution'],
    ];
    return switches.map(([key, label]) => {
        const property = properties[key] || {};
        return {
            key,
            label,
            defaultValue: property.default,
            failClosed: property.default === false,
            enabledByDefault: property.default === true,
            description: property.description || '',
        };
    });
}

function swarmDefaultStatus(pkg, switches) {
    const properties = pkg?.contributes?.configuration?.properties || {};
    const provider = properties['harmony.swarm.defaultProvider']?.default || 'deepseek';
    const tier = properties['harmony.swarm.defaultTier']?.default || 'coding';
    const enabledRiskDefaults = switches.filter(item => item.enabledByDefault).map(item => item.label || item.key);
    return {
        mode: 'plan-only launcher default',
        provider,
        tier,
        riskySwitchCount: switches.length,
        riskySwitchesOnByDefault: enabledRiskDefaults,
        riskySwitchesOffByDefault: switches.filter(item => item.failClosed).map(item => item.label || item.key),
        source: 'packaged extension defaults',
        liveSettingsNote: 'The VS Code sidebar shows live configured switch values for the active editor workspace.',
    };
}

function hubExePath() {
    const exe = process.platform === 'win32' ? 'harmonyhub.exe' : 'harmonyhub';
    return path.join(extensionRoot(), 'bin', exe);
}

async function collectState(root, options) {
    const pkg = await readPackage();
    const limit = Number(options.limit || 20);
    const [hub, hubSupervisor, heartbeats, locks, managedProcesses, operationLedger, continuity, outsidePolicy, terminalAskReceipts, snapshots, broker, smokeReports] = await Promise.all([
        checkHub(options),
        checkHubSupervisor(root, options),
        readSupervisor(root),
        readLocks(root),
        readManagedProcesses(root),
        readLedger(root, limit),
        readContinuity(root, Math.min(limit, 10)),
        readOutsidePolicy(root),
        readJsonRecords(terminalAskDir(root), Math.min(limit, 10)),
        readSnapshotSummaries(root, Math.min(limit, 10)),
        readBrokerState(root),
        readSmokeReportSummaries(root, Math.min(limit, 10)),
    ]);
    const providerSecrets = providerSecretMetadataRows(root);
    const swarmSafetySwitches = swarmSafetySwitchRows(pkg);
    const swarmDefaults = swarmDefaultStatus(pkg, swarmSafetySwitches);
    const state = {
        generatedAt: new Date().toISOString(),
        cliVersion: pkg.version || 'unknown',
        extensionRoot: extensionRoot(),
        workspace: root,
        hub,
        hubSupervisor,
        supervisor: {
            heartbeats,
            active: heartbeats.filter(item => item.status === 'active').length,
            stale: heartbeats.filter(item => item.status === 'stale').length,
        },
        locks,
        managedProcesses,
        operationLedger,
        continuity,
        providerStatus: providerStatusRows(root),
        providerSecrets,
        outsidePolicy,
        terminalAskReceipts,
        snapshots,
        broker,
        smokeReports,
        swarmSafetySwitches,
        swarmDefaultStatus: swarmDefaults,
        paths: {
            supervisor: harmonyPath(root, 'supervisor'),
            locks: harmonyPath(root, 'locks'),
            operations: harmonyPath(root, 'operations', 'ledger.json'),
            managedProcesses: harmonyPath(root, 'processes', 'managed'),
            continuity: harmonyPath(root, 'continuity', 'ledger.jsonl'),
            outsidePolicy: outsidePolicyPath(root),
            terminalAsk: terminalAskDir(root),
            snapshots: snapshotsDir(root),
            smoke: harmonyPath(root, 'smoke'),
            broker: providerBrokerDir(root),
            secrets: providerSecretsDir(root),
            hubExe: hubExePath(),
        },
    };
    state.health = summarizeStateHealth(state);
    state.crossSurface = await crossSurfaceSummary(root, options, pkg, broker, providerSecrets, swarmSafetySwitches);
    return state;
}

function summarizeStateHealth(state) {
    const warnings = [];
    const blocks = [];
    const hubSnapshot = state.hubSupervisor.response || {};
    const hubStale = Number(hubSnapshot.stale || 0);
    const expiredLocalLocks = state.locks.filter(item => item.expired).length;
    const expiredHubLocks = Array.isArray(hubSnapshot.locks) ? hubSnapshot.locks.filter(item => item.expired).length : 0;
    const policy = state.outsidePolicy;
    const permissions = policy?.permissions || {};
    const budgets = policy?.budgets || {};

    if (!state.hub.online) warnings.push('HarmonyHub endpoint is offline; Hub-owned locks and supervisor snapshots are unavailable.');
    if (!state.hubSupervisor.online) warnings.push('Hub supervisor snapshot is unavailable; allow this workspace in Hub policy before relying on cross-surface coordination.');
    if (!policy) warnings.push('Outside-VS policy is missing; run `harmony policy init` before enabling terminal/floating actions.');
    if (state.supervisor.stale > 0) warnings.push(`${state.supervisor.stale} local supervisor heartbeat(s) are stale.`);
    if (hubStale > 0) warnings.push(`${hubStale} Hub supervisor heartbeat(s) are stale.`);
    if (expiredLocalLocks > 0) warnings.push(`${expiredLocalLocks} local lock record(s) are expired and should be released or cleaned after review.`);
    if (expiredHubLocks > 0) warnings.push(`${expiredHubLocks} Hub lock record(s) are expired and should be released or cleaned after review.`);
    if (policy?.mode === 'autonomous' && !permissions.autonomousLoops) blocks.push('Policy mode is autonomous but autonomousLoops permission is disabled.');
    if (permissions.autonomousLoops && Number(budgets.maxAutonomousSteps || 0) <= 0) blocks.push('autonomousLoops is enabled but maxAutonomousSteps is zero.');
    if (permissions.runCommands && Number(budgets.maxCommandSeconds || 0) <= 0) blocks.push('runCommands is enabled but maxCommandSeconds is zero.');
    if (permissions.paidProviderCalls && Number(budgets.maxEstimatedUsd || 0) <= 0) warnings.push('paidProviderCalls is enabled with a zero estimated spend budget.');

    return {
        status: blocks.length ? 'block' : warnings.length ? 'warn' : 'ok',
        blocks,
        warnings,
    };
}

function printStatus(state) {
    const latestOperation = state.operationLedger.entries[0];
    const latestContinuity = state.continuity.entries[0];
    const hubSnapshot = state.hubSupervisor.response || {};
    const configuredProviders = state.providerStatus.filter(item => item.configured).length;
    const executableProviders = state.providerStatus.filter(item => item.executable).length;
    process.stdout.write([
        `Harmony CLI ${state.cliVersion}`,
        `Workspace: ${state.workspace}`,
        `Hub: ${state.hub.online ? 'online' : 'offline'} (${state.hub.url})`,
        `Hub supervisor API: ${state.hubSupervisor.online ? `online (${hubSnapshot.active || 0} active, ${hubSnapshot.stale || 0} stale, ${(hubSnapshot.locks || []).length} locks, ${(hubSnapshot.managedProcesses || []).length} managed)` : 'offline'}`,
        `Health: ${state.health.status.toUpperCase()} (${state.health.blocks.length} block, ${state.health.warnings.length} warning)`,
        `Surfaces: ${state.supervisor.active} active, ${state.supervisor.stale} stale`,
        `Locks: ${state.locks.length}`,
        `Managed processes: ${state.managedProcesses.length}`,
        `CLI providers: ${configuredProviders}/${state.providerStatus.length} configured, ${executableProviders} executable adapters`,
        `Key stores: CLI/native provider calls use environment variables or Windows DPAPI current-user secrets; VS Code extension routes use VS Code Secret Storage separately`,
        latestOperation ? `Latest operation: ${latestOperation.timestamp || '?'} | ${latestOperation.status || '?'} | ${latestOperation.label || latestOperation.kind || '?'}` : 'Latest operation: none',
        latestContinuity ? `Latest continuity: ${latestContinuity.ts || '?'} | ${latestContinuity.summary || latestContinuity.kind || '?'}` : 'Latest continuity: none',
        '',
    ].join(os.EOL));
}

function printSupervisor(state) {
    const hubSnapshot = state.hubSupervisor.response || {};
    const lines = [
        `Harmony Supervisor - ${state.workspace}`,
        `Generated: ${state.generatedAt}`,
        `Hub supervisor: ${state.hubSupervisor.online ? `${hubSnapshot.active || 0} active, ${hubSnapshot.stale || 0} stale, ${(hubSnapshot.locks || []).length} locks, ${(hubSnapshot.managedProcesses || []).length} managed` : state.hubSupervisor.error}`,
        '',
        'Surfaces:',
        ...(
            state.supervisor.heartbeats.length
                ? state.supervisor.heartbeats.map(item => `- ${item.surface || '?'} pid=${item.pid || '?'} ${item.status} alive=${item.processAlive ? 'yes' : 'no'} age=${formatDuration(item.ageMs)} label=${item.label || '?'}`)
                : ['- none']
        ),
        '',
        'Locks:',
        ...(
            state.locks.length
                ? state.locks.map(item => `- ${item.file}: ${item.operation || item.resource || 'unknown'} expired=${item.expired === undefined ? '?' : item.expired ? 'yes' : 'no'}`)
                : ['- none']
        ),
        '',
    ];
    process.stdout.write(lines.join(os.EOL));
}

function commandExists(command) {
    const lookup = process.platform === 'win32' ? 'where' : 'command';
    const args = process.platform === 'win32' ? [command] : ['-v', command];
    const result = childProcess.spawnSync(lookup, args, { encoding: 'utf8', windowsHide: true, timeout: 3000, shell: process.platform !== 'win32' });
    return result.status === 0;
}

async function commandHealth(root, options) {
    const pkg = await readPackage();
    const hub = await checkHub(options);
    const exe = hubExePath();
    const checks = [
        { name: 'node', ok: true, detail: process.version },
        { name: 'git', ok: commandExists('git'), detail: 'required for git-backed workflows' },
        { name: 'rg', ok: commandExists('rg'), detail: 'recommended for fast local search' },
        { name: 'harmonyhub binary', ok: await pathExists(exe), detail: exe },
        { name: 'hub endpoint', ok: hub.online, detail: hub.online ? hub.url : `${hub.url} (${hub.error})` },
        { name: 'workspace', ok: await pathExists(root), detail: root },
        { name: '.harmony writable parent', ok: true, detail: harmonyPath(root) },
    ];
    try {
        await fsp.access(root, fs.constants.W_OK);
    } catch (error) {
        checks[6].ok = false;
        checks[6].detail = error && error.message ? error.message : String(error);
    }
    const payload = { generatedAt: new Date().toISOString(), cliVersion: pkg.version || 'unknown', workspace: root, checks };
    if (options.json) {
        printJson(payload);
        return checks.every(check => check.ok) ? 0 : 1;
    }
    process.stdout.write(`Harmony CLI health ${payload.cliVersion}${os.EOL}`);
    for (const check of checks) {
        process.stdout.write(`${check.ok ? '[ok]' : '[warn]'} ${check.name}: ${check.detail}${os.EOL}`);
    }
    return checks.every(check => check.ok) ? 0 : 1;
}

async function appendSupervisorEvent(root, payload) {
    const dir = harmonyPath(root, 'supervisor');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify(payload) + os.EOL, 'utf8');
}

async function writeHeartbeat(root, options) {
    const surface = String(options.surface || 'terminal');
    const label = String(options.label || 'Harmony terminal CLI');
    const staleAfterMs = Math.max(5000, Number(options['stale-after'] || DEFAULT_STALE_AFTER_MS));
    const heartbeat = {
        version: 1,
        surface,
        label,
        pid: process.pid,
        workspace: root,
        updatedAt: new Date().toISOString(),
        staleAfterMs,
    };
    const dir = harmonyPath(root, 'supervisor', 'heartbeats');
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${surface}-${process.pid}.json`);
    const text = JSON.stringify(heartbeat, null, 2);
    await fsp.writeFile(filePath, text, 'utf8');
    await fsp.writeFile(harmonyPath(root, 'supervisor', 'latest-heartbeat.json'), text, 'utf8');
    await appendSupervisorEvent(root, { timestamp: heartbeat.updatedAt, kind: 'heartbeat', surface, pid: process.pid, label });
    return filePath;
}

async function commandHeartbeat(root, options) {
    const filePath = await writeHeartbeat(root, options);
    if (options.json) printJson({ writtenPath: filePath, pid: process.pid });
    else process.stdout.write(`Heartbeat written: ${normalizePath(filePath)}${os.EOL}`);
}

async function commandHubHeartbeat(root, options) {
    const payload = {
        workspace: root,
        surface: String(options.surface || 'terminal'),
        label: String(options.label || 'Harmony CLI via HarmonyHub'),
        staleAfterMs: Math.max(5000, Number(options['stale-after'] || DEFAULT_STALE_AFTER_MS)),
    };
    const response = await postJson(hubEndpointUrl(options, 'supervisor/heartbeat').toString(), payload, Number(options.timeout || 1500));
    if (options.json) printJson(response);
    else process.stdout.write(`Hub heartbeat written: ${normalizePath(response.writtenPath || response.written_path || '?')}${os.EOL}`);
}

async function commandHubSupervisor(root, options) {
    const snapshot = await checkHubSupervisor(root, options);
    if (options.json) {
        printJson(snapshot.online ? snapshot.response : snapshot);
        return snapshot.online ? 0 : 1;
    }
    if (!snapshot.online) {
        process.stdout.write(`Hub supervisor unavailable: ${snapshot.error}${os.EOL}`);
        return 1;
    }
    const response = snapshot.response || {};
    process.stdout.write([
        `Hub Supervisor - ${root}`,
        `Generated: ${response.generatedAt || '?'}`,
        `Heartbeats: ${(response.heartbeats || []).length} (${response.active || 0} active, ${response.stale || 0} stale)`,
        `Locks: ${(response.locks || []).length}`,
        `Managed processes: ${(response.managedProcesses || []).length}`,
        `Operations ledger: ${response.operationLedger ? 'present' : 'missing'}`,
        '',
    ].join(os.EOL));
    return 0;
}

async function commandHubLocks(root, options) {
    const url = hubLocksUrl(root, options);
    const response = await requestJson(url, Number(options.timeout || 1500));
    if (options.json) {
        printJson(response);
        return 0;
    }
    const locks = Array.isArray(response.locks) ? response.locks : [];
    process.stdout.write([
        `Hub Locks - ${root}`,
        locks.length ? locks.map(item => `- ${item.lock?.resource || '?'} id=${item.lock?.id || '?'} expired=${item.expired ? 'yes' : 'no'} op=${item.lock?.operation || '?'}`).join(os.EOL) : 'No Hub locks found.',
        '',
    ].join(os.EOL));
    return 0;
}

async function commandHubOperations(root, options) {
    const response = await requestJson(hubOperationsUrl(root, options), Number(options.timeout || 1500));
    if (options.json) {
        printJson(response);
        return 0;
    }
    const entries = Array.isArray(response.entries) ? response.entries : [];
    process.stdout.write([`Hub Operations - ${root}`, entries.length ? entries.map(item => `- ${item.timestamp || '?'} | ${item.status || '?'} | ${item.operationId || item.id || '?'} | ${item.label || item.kind || '?'}`).join(os.EOL) : 'No Hub operation entries found.', ''].join(os.EOL));
    return 0;
}

async function commandHubSecrets(root, options) {
    const response = await requestJson(hubSecretsUrl(root, options), Number(options.timeout || 1500));
    if (options.json) {
        printJson(response);
        return 0;
    }
    const providers = Array.isArray(response.providers) ? response.providers : [];
    process.stdout.write('HarmonyHub secret metadata (values are never returned)' + os.EOL);
    if (!providers.length) process.stdout.write('- no stored provider secrets reported' + os.EOL);
    for (const item of providers) {
        process.stdout.write(`- ${item.provider}: stored=${item.stored ? 'yes' : 'no'} encryption=${item.encryption || '?'} updated=${item.updatedAt || '?'}${os.EOL}`);
    }
    return 0;
}

async function commandHubOperation(root, subcommand, options) {
    if (subcommand === 'start') {
        const payload = {
            workspace: root,
            kind: String(options.kind || 'manual.operation'),
            label: String(options.label || options.kind || 'Harmony Hub operation'),
            ownerSurface: String(options.surface || 'terminal'),
            resources: parseResourceList(options.resource || options.resources),
            details: { source: 'harmony-cli' },
        };
        const response = await postJson(hubEndpointUrl(options, 'operations/start').toString(), payload, Number(options.timeout || 1500));
        if (options.json) printJson(response);
        else process.stdout.write(`Hub operation started: ${response.operationId || '?'}${os.EOL}`);
        return 0;
    }
    if (subcommand === 'finish') {
        const operationId = String(options['operation-id'] || options.id || '').trim();
        if (!operationId) throw new Error('hub-operation finish requires --operation-id <id>');
        const payload = {
            workspace: root,
            operationId,
            label: options.label ? String(options.label) : undefined,
            result: options.result ? { summary: String(options.result) } : undefined,
            details: { source: 'harmony-cli' },
        };
        const response = await postJson(hubEndpointUrl(options, 'operations/finish').toString(), payload, Number(options.timeout || 1500));
        if (options.json) printJson(response);
        else process.stdout.write(`Hub operation completed: ${response.operationId || operationId}${os.EOL}`);
        return 0;
    }
    if (subcommand === 'fail') {
        const operationId = String(options['operation-id'] || options.id || '').trim();
        if (!operationId) throw new Error('hub-operation fail requires --operation-id <id>');
        const payload = {
            workspace: root,
            operationId,
            label: options.label ? String(options.label) : undefined,
            error: String(options.error || options.result || 'operation failed'),
            details: { source: 'harmony-cli' },
        };
        const response = await postJson(hubEndpointUrl(options, 'operations/fail').toString(), payload, Number(options.timeout || 1500));
        if (options.json) printJson(response);
        else process.stdout.write(`Hub operation failed: ${response.operationId || operationId}${os.EOL}`);
        return 0;
    }
    return await commandHubOperations(root, options);
}

async function commandHubLock(root, subcommand, options) {
    if (subcommand === 'acquire') {
        const resource = String(options.resource || '').trim();
        if (!resource) throw new Error('hub-lock acquire requires --resource <name>');
        const payload = {
            workspace: root,
            resource,
            operation: String(options.operation || options.label || 'Harmony CLI operation'),
            ownerSurface: String(options.surface || 'terminal'),
            ttlMs: options.ttl ? Number(options.ttl) : undefined,
            details: { source: 'harmony-cli' },
        };
        const response = await postJson(hubEndpointUrl(options, 'locks/acquire').toString(), payload, Number(options.timeout || 1500));
        if (options.json) printJson(response);
        else process.stdout.write(`${response.acquired ? 'Hub lock acquired' : 'Hub lock denied'}: ${response.message || ''}${response.lock?.id ? ` (${response.lock.id})` : ''}${os.EOL}`);
        return response.acquired ? 0 : 2;
    }
    if (subcommand === 'release') {
        const operationId = String(options['operation-id'] || options.id || '').trim();
        if (!operationId) throw new Error('hub-lock release requires --operation-id <id>');
        const payload = {
            workspace: root,
            operationId,
            resource: options.resource ? String(options.resource) : undefined,
        };
        const response = await postJson(hubEndpointUrl(options, 'locks/release').toString(), payload, Number(options.timeout || 1500));
        if (options.json) printJson(response);
        else process.stdout.write(`${response.released ? 'Hub lock released' : 'Hub lock not released'}: ${response.message || ''}${os.EOL}`);
        return response.released ? 0 : 2;
    }
    return await commandHubLocks(root, options);
}

function buildRepairProposalPrompt(root, basePrompt, commandResult) {
    return [
        'You are Harmony producing a repair proposal for a failed terminal validation command.',
        'Do not claim to have edited files. Do not produce a final patch unless the evidence is enough; prefer a careful proposal with likely files/symbols to inspect, minimal change strategy, and validation steps.',
        '',
        `Workspace: ${root}`,
        `Original request: ${basePrompt || '(none)'}`,
        `Command: ${commandResult.commandLine}`,
        `Exit code: ${commandResult.exitCode}`,
        `Timed out: ${commandResult.timedOut ? 'yes' : 'no'}`,
        '',
        'stdout:',
        truncateText(commandResult.stdout || '(empty)', 6000),
        '',
        'stderr:',
        truncateText(commandResult.stderr || '(empty)', 6000),
        '',
        'Return sections: likely cause, proposed repair, files to inspect, validation plan, residual risk.',
    ].join('\n');
}

async function resolvePatchFile(root, options) {
    const rawPatchFile = String(options['patch-file'] || options.patchFile || options.patch || '').trim();
    if (!rawPatchFile) throw new Error('run-fail-fix --apply requires --patch-file <workspace-relative .patch/.diff file>');
    const resolvedPath = path.resolve(root, rawPatchFile);
    const relativePath = path.relative(root, resolvedPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error('run-fail-fix --patch-file must resolve inside the workspace');
    const normalized = normalizePath(relativePath);
    if (shouldSkipSnapshotPath(normalized)) throw new Error('run-fail-fix --patch-file cannot target excluded, secret, credential, or key-looking paths');
    const ext = path.extname(normalized).toLowerCase();
    if (!['.patch', '.diff'].includes(ext)) throw new Error('run-fail-fix --patch-file must end in .patch or .diff');
    let stat;
    try { stat = await fsp.stat(resolvedPath); }
    catch { throw new Error(`run-fail-fix --patch-file not found: ${normalized}`); }
    if (!stat.isFile()) throw new Error('run-fail-fix --patch-file must be a file');
    const maxBytes = Number(options['max-patch-bytes'] || 512 * 1024);
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('--max-patch-bytes must be a positive number');
    if (stat.size > maxBytes) throw new Error(`run-fail-fix --patch-file exceeds max patch size (${stat.size} > ${maxBytes})`);
    const content = await fsp.readFile(resolvedPath);
    return {
        path: resolvedPath,
        relativePath: normalized,
        bytes: stat.size,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
}

function applyTimeoutSeconds(options, policy) {
    const budgetSeconds = Number(policy?.budgets?.maxCommandSeconds || 0);
    const timeoutSeconds = Number(options['apply-timeout'] || options['command-timeout'] || Math.min(30, budgetSeconds || 30));
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('run-fail-fix --apply-timeout requires a positive number of seconds');
    if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error('outside-VS policy budget maxCommandSeconds must be greater than 0 before apply execution');
    if (timeoutSeconds > budgetSeconds) throw new Error(`requested apply timeout ${timeoutSeconds}s exceeds policy maxCommandSeconds ${budgetSeconds}s`);
    return timeoutSeconds;
}

async function runProcessCapture(root, command, args, timeoutSeconds) {
    return await new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = childProcess.spawn(command, args, {
            cwd: root,
            shell: false,
            windowsHide: true,
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, Math.ceil(timeoutSeconds * 1000));
        child.stdout.on('data', chunk => { stdout = truncateText(stdout + chunk.toString()); });
        child.stderr.on('data', chunk => { stderr = truncateText(stderr + chunk.toString()); });
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (exitCode, signal) => {
            clearTimeout(timer);
            resolve({
                command,
                args,
                commandLine: [command, ...args].join(' '),
                cwd: root,
                startedAt,
                finishedAt: new Date().toISOString(),
                timeoutSeconds,
                timedOut,
                exitCode,
                signal,
                stdout: truncateText(stdout),
                stderr: truncateText(stderr),
            });
        });
    });
}

async function tryAcquireApplyHubLock(root, options, receipt, patchFile) {
    if (options['no-hub-lock']) return { status: 'skipped', reason: '--no-hub-lock' };
    const operationId = `${receipt.id}-apply`;
    const payload = {
        workspace: root,
        resource: 'workspace-write',
        operation: operationId,
        ownerSurface: 'terminal',
        ttlMs: Number(options['lock-ttl-ms'] || 120000),
        details: { source: 'harmony-cli', patchFile: patchFile.relativePath },
    };
    try {
        const response = await postJson(hubEndpointUrl(options, 'locks/acquire').toString(), payload, Number(options.timeout || 1500));
        if (!response.acquired) return { status: 'blocked', operationId, response };
        return { status: 'acquired', operationId, response };
    } catch (error) {
        return { status: 'unavailable', operationId, error: error && error.message ? error.message : String(error) };
    }
}

async function releaseApplyHubLock(root, options, lock) {
    if (!lock || lock.status !== 'acquired') return undefined;
    try {
        return await postJson(hubEndpointUrl(options, 'locks/release').toString(), {
            workspace: root,
            operationId: lock.operationId,
            resource: 'workspace-write',
        }, Number(options.timeout || 1500));
    } catch (error) {
        return { released: false, error: error && error.message ? error.message : String(error) };
    }
}

async function writePatchManifest(root, receipt, manifest) {
    const dir = harmonyPath(root, 'run-fail-fix');
    await fsp.mkdir(dir, { recursive: true });
    const manifestPath = path.join(dir, `${receipt.id}-patch-manifest.json`);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return manifestPath;
}

async function applyRunFailFixPatch(root, options, policy, receipt, initialCommand) {
    const patchFile = await resolvePatchFile(root, options);
    const timeoutSeconds = applyTimeoutSeconds(options, policy);
    const applyReceipt = {
        status: 'started',
        patchFile,
        startedAt: new Date().toISOString(),
        snapshot: undefined,
        hubLock: undefined,
        manifestPath: undefined,
        check: undefined,
        apply: undefined,
        rerun: undefined,
        restoreCommand: undefined,
        error: undefined,
    };
    await appendLedgerEntry(root, {
        kind: 'terminal.run_fail_fix.apply',
        label: 'Run-fail-fix guarded patch apply started',
        status: 'started',
        operationId: receipt.id,
        patchFile: patchFile.relativePath,
        patchSha256: patchFile.sha256,
    });
    try {
        const snapshot = await createSnapshot(root, {
            ...options,
            reason: 'run-fail-fix apply pre-action snapshot',
            note: 'Pre-action snapshot before guarded run-fail-fix patch apply.',
            'max-files': options['snapshot-max-files'] || options['max-files'] || 500,
        });
        applyReceipt.snapshot = {
            id: snapshot.id,
            manifestPath: normalizePath(snapshot.manifestPath),
            fileCount: snapshot.fileCount,
            copied: snapshot.copied,
        };
        applyReceipt.restoreCommand = `node bin/harmony-cli.js --workspace "${root}" snapshot restore --id ${snapshot.id} --all --confirm`;
        const hubLock = await tryAcquireApplyHubLock(root, options, receipt, patchFile);
        applyReceipt.hubLock = hubLock;
        if (hubLock.status === 'blocked') {
            applyReceipt.status = 'lock_blocked';
            await appendLedgerEntry(root, {
                kind: 'terminal.run_fail_fix.apply',
                label: 'Run-fail-fix apply blocked by Hub lock conflict',
                status: 'failed',
                operationId: receipt.id,
                patchFile: patchFile.relativePath,
                hubLock,
            });
            return applyReceipt;
        }
        const manifestPath = await writePatchManifest(root, receipt, {
            version: 1,
            createdAt: new Date().toISOString(),
            operationId: receipt.id,
            workspace: root,
            patchFile,
            initialCommand: {
                commandLine: initialCommand.commandLine,
                exitCode: initialCommand.exitCode,
                timedOut: initialCommand.timedOut,
            },
            snapshot: applyReceipt.snapshot,
            hubLock,
            restoreCommand: applyReceipt.restoreCommand,
        });
        applyReceipt.manifestPath = normalizePath(manifestPath);
        const check = await runProcessCapture(root, 'git', ['apply', '--check', patchFile.path], timeoutSeconds);
        applyReceipt.check = check;
        if (check.exitCode !== 0 || check.timedOut) {
            applyReceipt.status = 'check_failed';
            await appendLedgerEntry(root, {
                kind: 'terminal.run_fail_fix.apply',
                label: 'Run-fail-fix git apply check failed',
                status: 'failed',
                operationId: receipt.id,
                patchFile: patchFile.relativePath,
                exitCode: check.exitCode,
                timedOut: check.timedOut,
                manifestPath: applyReceipt.manifestPath,
            });
            return applyReceipt;
        }
        const apply = await runProcessCapture(root, 'git', ['apply', patchFile.path], timeoutSeconds);
        applyReceipt.apply = apply;
        if (apply.exitCode !== 0 || apply.timedOut) {
            applyReceipt.status = 'apply_failed';
            await appendLedgerEntry(root, {
                kind: 'terminal.run_fail_fix.apply',
                label: 'Run-fail-fix git apply failed',
                status: 'failed',
                operationId: receipt.id,
                patchFile: patchFile.relativePath,
                exitCode: apply.exitCode,
                timedOut: apply.timedOut,
                manifestPath: applyReceipt.manifestPath,
                snapshotId: applyReceipt.snapshot.id,
            });
            return applyReceipt;
        }
        const rerun = await executeValidationCommand(root, options, policy);
        applyReceipt.rerun = rerun;
        applyReceipt.status = rerun.exitCode === 0 && !rerun.timedOut ? 'completed' : 'validation_failed';
        await appendLedgerEntry(root, {
            kind: 'terminal.run_fail_fix.apply',
            label: applyReceipt.status === 'completed' ? 'Run-fail-fix apply validated' : 'Run-fail-fix apply did not fix validation',
            status: applyReceipt.status === 'completed' ? 'completed' : 'failed',
            operationId: receipt.id,
            patchFile: patchFile.relativePath,
            manifestPath: applyReceipt.manifestPath,
            snapshotId: applyReceipt.snapshot.id,
            rerunExitCode: rerun.exitCode,
            rerunTimedOut: rerun.timedOut,
            restoreCommand: applyReceipt.restoreCommand,
        });
        return applyReceipt;
    } catch (error) {
        applyReceipt.status = 'failed';
        applyReceipt.error = error && error.message ? error.message : String(error);
        await appendLedgerEntry(root, {
            kind: 'terminal.run_fail_fix.apply',
            label: 'Run-fail-fix guarded patch apply failed before completion',
            status: 'failed',
            operationId: receipt.id,
            patchFile: patchFile.relativePath,
            error: applyReceipt.error,
        });
        return applyReceipt;
    } finally {
        const release = await releaseApplyHubLock(root, options, applyReceipt.hubLock);
        if (release) applyReceipt.hubLockRelease = release;
        applyReceipt.finishedAt = new Date().toISOString();
    }
}

async function commandPolicy(root, subcommand, options) {
    const filePath = outsidePolicyPath(root);
    if (subcommand === 'init') {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const exists = await pathExists(filePath);
        if (exists && !options.force) {
            if (options.json) printJson({ created: false, path: filePath, message: 'policy already exists' });
            else process.stdout.write(`Policy already exists: ${normalizePath(filePath)}${os.EOL}`);
            return 0;
        }
        const policy = defaultOutsidePolicy(root);
        await fsp.writeFile(filePath, JSON.stringify(policy, null, 2), 'utf8');
        if (options.json) printJson({ created: true, path: filePath, policy });
        else process.stdout.write(`Policy written: ${normalizePath(filePath)}${os.EOL}`);
        return 0;
    }

    const policy = await readOutsidePolicy(root);
    if (!policy) {
        if (options.json) printJson({ exists: false, path: filePath, defaultPolicy: defaultOutsidePolicy(root) });
        else process.stdout.write(`No outside-VS policy found. Run: node bin/harmony-cli.js policy init --workspace ${root}${os.EOL}`);
        return 1;
    }

    if (subcommand === 'check') {
        const permission = String(options.permission || '').trim();
        if (!permission) throw new Error('policy check requires --permission <name>');
        const allowed = Boolean(policy.permissions && policy.permissions[permission]);
        if (options.json) printJson({ permission, allowed, mode: policy.mode, path: filePath });
        else process.stdout.write(`${permission}: ${allowed ? 'allowed' : 'blocked'} (${policy.mode || 'unknown'} mode)${os.EOL}`);
        return allowed ? 0 : 2;
    }

    if (subcommand === 'set') {
        if (!options.confirm) throw new Error('policy set requires --confirm so permission changes are deliberate');
        const updated = { ...policy, permissions: { ...(policy.permissions || {}) }, budgets: { ...(policy.budgets || {}) } };
        const permission = String(options.permission || '').trim();
        if (permission) {
            const rawValue = String(options.value || '').toLowerCase();
            if (!['true', 'false'].includes(rawValue)) throw new Error('policy set --permission requires --value true|false');
            updated.permissions[permission] = rawValue === 'true';
        }
        if (options.mode) {
            const mode = String(options.mode).trim();
            if (!['observe', 'confirm', 'autonomous'].includes(mode)) throw new Error('policy set --mode must be observe, confirm, or autonomous');
            updated.mode = mode;
        }
        for (const key of ['maxAutonomousSteps', 'maxCommandSeconds', 'maxEstimatedUsd']) {
            if (options[key] !== undefined) {
                const value = Number(options[key]);
                if (!Number.isFinite(value) || value < 0) throw new Error(`policy set --${key} requires a non-negative number`);
                updated.budgets[key] = value;
            }
        }
        if (!permission && !options.mode && options.maxAutonomousSteps === undefined && options.maxCommandSeconds === undefined && options.maxEstimatedUsd === undefined) {
            throw new Error('policy set needs --permission, --mode, or a budget option');
        }
        updated.updatedAt = new Date().toISOString();
        await fsp.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');
        if (options.json) printJson({ updated: true, path: filePath, policy: updated });
        else process.stdout.write(`Policy updated: ${normalizePath(filePath)}${os.EOL}`);
        return 0;
    }

    if (options.json) printJson({ exists: true, path: filePath, policy });
    else process.stdout.write(JSON.stringify(policy, null, 2) + os.EOL);
    return 0;
}

async function commandAskDesign(root, options, kind = 'ask') {
    const commandText = String(options.command || options.cmd || '').trim();
    const prompt = String(options.prompt || options._.slice(1).join(' ') || commandText).trim();
    if (kind === 'ask' && !prompt) throw new Error(`${kind} requires a prompt. Use --prompt "..." or put text after the command.`);
    if (kind === 'run-fail-fix' && !prompt && !commandText) throw new Error('run-fail-fix requires --command "<validation command>" or a prompt.');
    const policy = await readOutsidePolicy(root);
    const policyPath = outsidePolicyPath(root);
    const canCallProviders = Boolean(policy?.permissions?.paidProviderCalls);
    const canRunCommands = Boolean(policy?.permissions?.runCommands);
    const canWriteFiles = Boolean(policy?.permissions?.writeFiles);
    const execute = Boolean(options.execute || options.run);
    const wantsRepairProposal = kind === 'run-fail-fix' && Boolean(options.propose || options['repair-proposal'] || options.proposal);
    const wantsApply = kind === 'run-fail-fix' && Boolean(options.apply);
    if (wantsApply && wantsRepairProposal) throw new Error('run-fail-fix --apply cannot be combined with --propose. Generate/review a proposal first, save a patch file, then apply that file.');
    const useVsCodeBroker = String(options['credential-source'] || '').toLowerCase() === 'vscode' || Boolean(options.broker);
    const confirmationRequired = Boolean(policy?.confirmations?.beforePaidProvider !== false);
    const commandConfirmationRequired = Boolean(policy?.confirmations?.beforeCommand !== false);
    const writeConfirmationRequired = Boolean(policy?.confirmations?.beforeWrite !== false);
    let status = (kind === 'ask' ? canCallProviders : canRunCommands) ? 'ready_for_executor' : 'blocked_by_policy';
    const receipt = {
        version: 1,
        id: `${kind}-${Date.now()}-${process.pid}`,
        kind,
        status,
        workspace: root,
        prompt,
        createdAt: new Date().toISOString(),
        policyPath,
        requiredPermissions: kind === 'ask'
            ? ['paidProviderCalls']
            : wantsApply ? ['runCommands', 'writeFiles'] : wantsRepairProposal ? ['runCommands', 'paidProviderCalls'] : ['runCommands'],
        observedPermissions: {
            paidProviderCalls: canCallProviders,
            runCommands: canRunCommands,
            writeFiles: canWriteFiles,
        },
        nextSteps: [
            'Without --execute this command writes a receipt only; no model call or tool execution happens.',
            'Enable policy deliberately before terminal/floating Harmony performs agentic work.',
            'Use --execute --confirm for a policy-gated terminal model call via explicit environment credentials.',
        ],
    };
    if (execute) {
        if (kind === 'run-fail-fix') {
            if (!policy) throw new Error(`outside-VS policy is missing. Run: node bin/harmony-cli.js policy init --workspace ${root}`);
            if (!canRunCommands) throw new Error('outside-VS policy blocks runCommands');
            if (commandConfirmationRequired && !options.confirm) throw new Error('run-fail-fix --execute requires --confirm while beforeCommand confirmation is enabled');
            if (wantsApply && !canWriteFiles) throw new Error('run-fail-fix --apply requires outside-VS policy permission writeFiles');
            if (wantsApply && writeConfirmationRequired && !options.confirm) throw new Error('run-fail-fix --apply requires --confirm while beforeWrite confirmation is enabled');
            receipt.status = 'running';
            await appendLedgerEntry(root, {
                kind: 'terminal.run_fail_fix',
                label: 'Terminal run-fail-fix validation command started',
                status: 'started',
                operationId: receipt.id,
                command: commandText,
            });
            try {
                const commandResult = await executeValidationCommand(root, options, policy);
                receipt.status = commandResult.exitCode === 0 && !commandResult.timedOut ? 'completed' : 'command_failed';
                receipt.command = commandResult;
                receipt.nextSteps = commandResult.exitCode === 0 && !commandResult.timedOut
                    ? ['Validation command passed. No model call, patch, or file edit was performed.']
                    : wantsRepairProposal
                        ? ['Validation command failed. A repair proposal may be generated or queued, but no patch or file edit will be applied.']
                        : wantsApply
                            ? ['Validation command failed. A guarded patch-file apply will run only after snapshot, lock attempt, and git apply --check.']
                            : ['Validation command failed. Re-run with --propose to request a guarded repair proposal, or --apply --patch-file after reviewing a patch.'];
                await appendLedgerEntry(root, {
                    kind: 'terminal.run_fail_fix',
                    label: receipt.status === 'completed' ? 'Terminal validation command passed' : 'Terminal validation command failed',
                    status: receipt.status === 'completed' ? 'completed' : 'failed',
                    operationId: receipt.id,
                    command: commandResult.commandLine,
                    exitCode: commandResult.exitCode,
                    timedOut: commandResult.timedOut,
                });
                if (wantsApply) {
                    if (receipt.status === 'completed') {
                        receipt.apply = { status: 'skipped', reason: 'validation command passed before apply; no patch was applied' };
                    } else {
                        receipt.apply = await applyRunFailFixPatch(root, options, policy, receipt, commandResult);
                        if (receipt.apply.status === 'completed') {
                            receipt.status = 'completed_after_apply';
                            receipt.nextSteps = ['Patch applied from explicit patch file, validation reran successfully, and restore instructions are recorded in the receipt.'];
                        } else if (receipt.apply.status === 'validation_failed') {
                            receipt.status = 'apply_validation_failed';
                            receipt.nextSteps = ['Patch applied, but validation still failed. Use the recorded restore command if you want to roll back copied text files from the pre-action snapshot.'];
                        } else if (receipt.apply.status === 'check_failed') {
                            receipt.status = 'apply_check_failed';
                            receipt.nextSteps = ['git apply --check failed, so no patch was applied. Review the patch file and command evidence.'];
                        } else if (receipt.apply.status === 'lock_blocked') {
                            receipt.status = 'apply_lock_blocked';
                            receipt.nextSteps = ['Hub lock conflict blocked apply before file mutation. Inspect Hub locks before retrying.'];
                        } else {
                            receipt.status = 'apply_failed';
                            receipt.nextSteps = ['Guarded apply failed. Check the apply receipt and use restore instructions if any workspace changes occurred.'];
                        }
                    }
                }
                if (wantsRepairProposal && receipt.status === 'command_failed') {
                    const proposalPrompt = buildRepairProposalPrompt(root, prompt, commandResult);
                    if (!canCallProviders) {
                        receipt.repairProposal = {
                            status: 'blocked_by_policy',
                            reason: 'outside-VS policy blocks paidProviderCalls',
                        };
                    } else if (confirmationRequired && !options.confirm) {
                        receipt.repairProposal = {
                            status: 'blocked_by_confirmation',
                            reason: 'beforePaidProvider confirmation is enabled',
                        };
                    } else if (useVsCodeBroker) {
                        const proposalReceipt = { ...receipt, id: `${receipt.id}-proposal` };
                        const broker = await writeBrokerRequest(root, proposalReceipt, proposalPrompt, { ...options, tier: options.tier || 'coding' });
                        receipt.repairProposal = {
                            status: 'queued_for_vscode_broker',
                            provider: broker.request.provider,
                            tier: broker.request.tier,
                            requestPath: normalizePath(broker.requestPath),
                        };
                        await appendLedgerEntry(root, {
                            kind: 'terminal.run_fail_fix.proposal',
                            label: `Repair proposal queued for VS Code broker via ${broker.request.provider}`,
                            status: 'queued',
                            operationId: receipt.id,
                            provider: broker.request.provider,
                            tier: broker.request.tier,
                            requestPath: normalizePath(broker.requestPath),
                        });
                    } else {
                        try {
                            const execution = await executeTerminalAsk(root, proposalPrompt, options);
                            receipt.repairProposal = {
                                status: 'completed',
                                provider: execution.provider,
                                model: execution.model,
                                credentialSource: execution.credentialSource,
                                credentialName: execution.credentialName,
                                output: execution.text,
                                usage: execution.usage,
                                providerStatus: execution.rawStatus,
                                latency: execution.latency,
                            };
                            await appendLedgerEntry(root, {
                                kind: 'terminal.run_fail_fix.proposal',
                                label: `Repair proposal completed via ${execution.provider}`,
                                status: 'completed',
                                operationId: receipt.id,
                                provider: execution.provider,
                                model: execution.model,
                                outputLength: execution.text.length,
                                usage: execution.usage,
                                latency: execution.latency,
                            });
                        } catch (error) {
                            receipt.repairProposal = {
                                status: 'failed',
                                error: error && error.message ? error.message : String(error),
                            };
                            await appendLedgerEntry(root, {
                                kind: 'terminal.run_fail_fix.proposal',
                                label: 'Repair proposal failed',
                                status: 'failed',
                                operationId: receipt.id,
                                provider: String(options.provider || 'auto'),
                                error: receipt.repairProposal.error,
                            });
                        }
                    }
                }
            } catch (error) {
                receipt.status = 'failed';
                receipt.error = error && error.message ? error.message : String(error);
                await appendLedgerEntry(root, {
                    kind: 'terminal.run_fail_fix',
                    label: 'Terminal run-fail-fix command failed before completion',
                    status: 'failed',
                    operationId: receipt.id,
                    command: commandText,
                    error: receipt.error,
                });
            }
        } else {
        if (!policy) throw new Error(`outside-VS policy is missing. Run: node bin/harmony-cli.js policy init --workspace ${root}`);
        if (!canCallProviders) throw new Error('outside-VS policy blocks paidProviderCalls');
        if (confirmationRequired && !options.confirm) throw new Error('ask --execute requires --confirm while beforePaidProvider confirmation is enabled');
        if (useVsCodeBroker) {
            const broker = await writeBrokerRequest(root, receipt, prompt, options);
            receipt.status = 'queued_for_vscode_broker';
            receipt.provider = broker.request.provider;
            receipt.tier = broker.request.tier;
            receipt.credentialSource = 'vscode-secretstorage-broker';
            receipt.requestPath = normalizePath(broker.requestPath);
            receipt.nextSteps = [
                'Open VS Code/Cursor with this workspace and run: Harmony: Process Provider Broker Queue.',
                'The request contains no API key material; VS Code Harmony will use SecretStorage if a matching provider key is saved.',
            ];
            await appendLedgerEntry(root, {
                kind: 'terminal.ask.broker',
                label: `Terminal ask queued for VS Code broker via ${broker.request.provider}`,
                status: 'queued',
                operationId: receipt.id,
                provider: broker.request.provider,
                tier: broker.request.tier,
                requestPath: normalizePath(broker.requestPath),
            });
            const waitSeconds = brokerTimeoutSeconds(options);
            if (waitSeconds > 0) {
                receipt.brokerWait = { timeoutSeconds: waitSeconds, status: 'waiting' };
                const brokerWait = await waitForBrokerResponse(root, broker.request.id, waitSeconds);
                receipt.brokerWait = { timeoutSeconds: waitSeconds, status: brokerWait.timedOut ? 'timed_out' : 'completed', responsePath: brokerWait.responsePath };
                if (brokerWait.response) {
                    receipt.responsePath = brokerWait.responsePath;
                    if (brokerWait.response.status === 'completed') {
                        receipt.status = 'completed';
                        receipt.output = brokerWait.response.output;
                        receipt.provider = brokerWait.response.provider || receipt.provider;
                        receipt.model = brokerWait.response.model;
                        receipt.usage = brokerWait.response.usage;
                        receipt.latency = brokerWait.response.latency;
                        receipt.nextSteps = [];
                    } else {
                        receipt.status = 'failed';
                        receipt.error = brokerWait.response.error || 'VS Code broker request failed';
                    }
                } else {
                    receipt.nextSteps.push(`Timed out after ${waitSeconds}s waiting for VS Code/Cursor. This is expected if VS Code/Cursor is closed; the request remains queued.`);
                }
                await appendLedgerEntry(root, {
                    kind: 'terminal.ask.broker.wait',
                    label: brokerWait.response ? 'Terminal ask broker wait received response' : 'Terminal ask broker wait timed out',
                    status: brokerWait.response ? String(brokerWait.response.status || 'completed') : 'timed_out',
                    operationId: receipt.id,
                    provider: broker.request.provider,
                    tier: broker.request.tier,
                    requestPath: normalizePath(broker.requestPath),
                    responsePath: brokerWait.responsePath,
                });
            }
        } else {
        receipt.status = 'running';
        await appendLedgerEntry(root, {
            kind: 'terminal.ask',
            label: 'Terminal ask provider call started',
            status: 'started',
            operationId: receipt.id,
            provider: String(options.provider || 'auto'),
            promptLength: prompt.length,
        });
        try {
            const execution = await executeTerminalAsk(root, prompt, options);
            receipt.status = 'completed';
            receipt.provider = execution.provider;
            receipt.model = execution.model;
            receipt.credentialSource = execution.credentialSource;
            receipt.credentialName = execution.credentialName;
            receipt.output = execution.text;
            receipt.usage = execution.usage;
            receipt.providerStatus = execution.rawStatus;
            receipt.latency = execution.latency;
            receipt.completedAt = new Date().toISOString();
            await appendLedgerEntry(root, {
                kind: 'terminal.ask',
                label: `Terminal ask completed via ${execution.provider}`,
                status: 'completed',
                operationId: receipt.id,
                provider: execution.provider,
                model: execution.model,
                outputLength: execution.text.length,
                usage: execution.usage,
                latency: execution.latency,
            });
        } catch (error) {
            receipt.status = 'failed';
            receipt.error = error && error.message ? error.message : String(error);
            await appendLedgerEntry(root, {
                kind: 'terminal.ask',
                label: 'Terminal ask failed',
                status: 'failed',
                operationId: receipt.id,
                provider: String(options.provider || 'auto'),
                error: receipt.error,
            });
        }
        }
        }
    } else if (status === 'ready_for_executor') {
        receipt.status = 'receipt_only';
        status = receipt.status;
    }
    const dir = terminalAskDir(root);
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${receipt.id}.json`);
    await fsp.writeFile(filePath, JSON.stringify(receipt, null, 2), 'utf8');
    if (options.json) printJson({ writtenPath: filePath, receipt });
    else {
        const lines = [`Terminal ${kind} receipt written: ${normalizePath(filePath)}`, `Status: ${receipt.status}`];
        if (receipt.latency?.durationMs !== undefined) lines.push(`Provider latency: ${providerLatencySummary(Number(receipt.latency.durationMs))}`);
        if (receipt.output) lines.push('', receipt.output);
        if (receipt.command) {
            lines.push('', `Command: ${receipt.command.commandLine}`, `Exit: ${receipt.command.exitCode}${receipt.command.timedOut ? ' (timed out)' : ''}`);
            if (receipt.command.stdout) lines.push('', 'stdout:', receipt.command.stdout);
            if (receipt.command.stderr) lines.push('', 'stderr:', receipt.command.stderr);
        }
        if (receipt.repairProposal) {
            lines.push('', `Repair proposal: ${receipt.repairProposal.status}`);
            if (receipt.repairProposal.requestPath) lines.push(`Broker request: ${receipt.repairProposal.requestPath}`);
            if (receipt.repairProposal.output) lines.push('', receipt.repairProposal.output);
            if (receipt.repairProposal.error) lines.push(`Proposal error: ${receipt.repairProposal.error}`);
            if (receipt.repairProposal.reason) lines.push(`Proposal reason: ${receipt.repairProposal.reason}`);
        }
        if (receipt.apply) {
            lines.push('', `Apply: ${receipt.apply.status}`);
            if (receipt.apply.patchFile) lines.push(`Patch: ${receipt.apply.patchFile.relativePath} (${receipt.apply.patchFile.sha256})`);
            if (receipt.apply.snapshot) lines.push(`Snapshot: ${receipt.apply.snapshot.id}`);
            if (receipt.apply.manifestPath) lines.push(`Patch manifest: ${receipt.apply.manifestPath}`);
            if (receipt.apply.check) lines.push(`git apply --check exit: ${receipt.apply.check.exitCode}${receipt.apply.check.timedOut ? ' (timed out)' : ''}`);
            if (receipt.apply.apply) lines.push(`git apply exit: ${receipt.apply.apply.exitCode}${receipt.apply.apply.timedOut ? ' (timed out)' : ''}`);
            if (receipt.apply.rerun) lines.push(`Validation rerun exit: ${receipt.apply.rerun.exitCode}${receipt.apply.rerun.timedOut ? ' (timed out)' : ''}`);
            if (receipt.apply.restoreCommand) lines.push(`Restore command: ${receipt.apply.restoreCommand}`);
            if (receipt.apply.error) lines.push(`Apply error: ${receipt.apply.error}`);
        }
        else if (!execute) lines.push('No model call or tool execution was performed.');
        if (receipt.error) lines.push(`Error: ${receipt.error}`);
        if (receipt.responsePath) lines.push(`Broker response: ${receipt.responsePath}`);
        if (receipt.brokerWait) lines.push(`Broker wait: ${receipt.brokerWait.status} (${receipt.brokerWait.timeoutSeconds}s)`);
        if (Array.isArray(receipt.nextSteps) && receipt.nextSteps.length) lines.push('', 'Next steps:', ...receipt.nextSteps.map(step => `- ${step}`));
        lines.push('');
        process.stdout.write(lines.join(os.EOL));
    }
    return ['failed', 'command_failed', 'blocked_by_policy', 'apply_check_failed', 'apply_failed', 'apply_validation_failed', 'apply_lock_blocked'].includes(receipt.status) ? 2 : 0;
}

async function commandProviderLiveHarness(root, options) {
    const report = buildProviderLiveHarnessReport(root, options);
    const reportPath = await writeProviderLiveHarnessReport(root, report);
    if (options.json) {
        printJson({ reportPath, report });
    } else {
        const missing = report.providers.filter(item => !item.credential.configured).map(item => item.provider);
        process.stdout.write([
            `Harmony provider live harness: ${report.status}`,
            `Report: ${normalizePath(reportPath)}`,
            `Provider calls performed: no`,
            `Network requests performed: no`,
            `Providers: ${report.providers.map(item => `${item.provider}/${item.model}`).join(', ')}`,
            missing.length ? `Missing keys before later live call: ${missing.join(', ')}` : 'Keys detected for all planned providers; values were not printed.',
            '',
        ].join(os.EOL));
    }
    return report.status === 'passed' ? 0 : 2;
}

async function commandProviders(root, subcommand, options) {
    const action = subcommand || 'status';
    if (action === 'live-harness' || action === 'live-smoke-harness' || action === 'live-smoke-plan' || action === 'live-approval-plan') return await commandProviderLiveHarness(root, options);
    if (action !== 'status' && action !== 'list') throw new Error('providers supports: status, live-harness, live-approval-plan');
    const rows = providerStatusRows(root);
    if (options.json) {
        printJson({ credentialStrategy: 'process env first, then Windows User/Machine env, then Windows DPAPI Harmony secret store; VS Code SecretStorage broker remains separate', providers: rows });
        return 0;
    }
    process.stdout.write('Harmony CLI provider status (keys are never printed)' + os.EOL);
    process.stdout.write('Key stores: CLI/native uses process env, Windows User/Machine env, or Windows DPAPI current-user secrets. VS Code extension Primary/Agents/swarm routes use VS Code Secret Storage separately.' + os.EOL);
    for (const row of rows) {
        const endpointText = row.baseUrl ? ` | endpoint=${row.endpointProfile} ${row.baseUrl}` : ` | endpoint=${row.endpointProfile}`;
        const latencyText = Number.isFinite(row.lastLatencyMs) ? ` | last latency=${providerLatencySummary(row.lastLatencyMs)}` : '';
        const setupText = row.configured ? '' : ` | import: ${row.secretImportCommand}`;
        process.stdout.write(`- ${row.provider}: ${row.configured ? `configured via ${row.credentialSource}/${row.credentialName}` : `missing (${row.envCandidates.join(' | ')})`} | stored=${row.stored ? 'yes' : 'no'} | executable=${row.executable ? 'yes' : 'not yet'} | default=${row.defaultModel}${endpointText}${latencyText}${setupText}${os.EOL}`);
    }
    return 0;
}

async function commandSecrets(root, subcommand, options) {
    const action = subcommand || 'status';
    const provider = String(options.provider || '').toLowerCase().trim();
    if ((action === 'set' || action === 'test' || action === 'delete' || action === 'remove' || action === 'clear') && !provider) throw new Error(`secrets ${action} requires --provider <name>`);
    if (provider) assertKnownProvider(provider);
    if (action === 'status' || action === 'list') {
        const rows = CLI_PROVIDER_ORDER.map(name => {
            const stored = readStoredProviderSecret(root, name);
            return {
                provider: name,
                stored: Boolean(stored),
                encryption: stored?.encryption,
                createdAt: stored?.createdAt,
                updatedAt: stored?.updatedAt,
                importedFromEnv: stored?.importedFromEnv,
                path: stored ? normalizePath(stored.filePath) : undefined,
            };
        });
        if (options.json) printJson({ version: 1, workspace: root, secretsDir: normalizePath(providerSecretsDir(root)), providers: rows });
        else {
            const lines = ['Harmony provider secret store (values are never printed):'];
            for (const row of rows) lines.push(`- ${row.provider}: stored=${row.stored ? 'yes' : 'no'}${row.updatedAt ? ` updated=${row.updatedAt}` : ''}`);
            process.stdout.write(lines.join(os.EOL) + os.EOL);
        }
        return 0;
    }
    if (action === 'set') {
        if (!options.confirm) throw new Error('secrets set requires --confirm so credential storage is deliberate');
        const envName = String(options['from-env'] || options.env || '').trim();
        const fileName = String(options['from-file'] || options.file || '').trim();
        const dotenvName = String(options['from-dotenv'] || options.dotenv || options.envFile || '').trim();
        const dotenvKey = String(options['dotenv-key'] || options.dotenvKey || '').trim();
        const selectedSources = [envName && '--from-env', fileName && '--from-file', dotenvName && '--from-dotenv'].filter(Boolean);
        if (selectedSources.length > 1) throw new Error('secrets set accepts only one secret source: --from-env, --from-file, or --from-dotenv');
        const importedFile = fileName ? await readProviderCredentialImportFile(root, fileName) : undefined;
        const importedDotenv = dotenvName ? await readProviderCredentialDotenvFile(root, provider, dotenvName, dotenvKey) : undefined;
        const importedEnv = envName ? readEnvironmentVariable(envName) : undefined;
        const ciphertext = envName ? (() => {
            if (!importedEnv?.value) throw new Error(`environment variable is not set or empty: ${envName}`);
            return dpapiProtect(importedEnv.value);
        })() : importedFile ? dpapiProtect(importedFile.value) : importedDotenv ? dpapiProtect(importedDotenv.value) : dpapiProtectFromPrompt(provider);
        if (!normalizeProviderCredentialValue(dpapiUnprotect(ciphertext))) throw new Error(`stored ${provider} secret is empty after header-safe normalization; re-enter the API key without surrounding quotes or control characters`);
        const now = new Date().toISOString();
        const existing = readStoredProviderSecret(root, provider);
        const payload = {
            version: 1,
            provider,
            encryption: 'windows-dpapi-current-user',
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            importedFromEnv: envName || importedDotenv?.envName || undefined,
            importedFromEnvScope: importedEnv?.scope,
            importedFromFile: importedFile ? normalizePath(importedFile.filePath) : undefined,
            importedFromDotenv: importedDotenv ? normalizePath(importedDotenv.filePath) : undefined,
            ciphertext,
        };
        await fsp.mkdir(providerSecretsDir(root), { recursive: true });
        await fsp.writeFile(providerSecretPath(root, provider), JSON.stringify(payload, null, 2), 'utf8');
        let sourceDeleted = false;
        if ((importedFile || importedDotenv) && (options['delete-source'] || options.deleteSource)) {
            await fsp.rm((importedFile || importedDotenv).filePath, { force: true });
            sourceDeleted = true;
        }
        await appendLedgerEntry(root, {
            kind: 'secret.store.set',
            label: `Provider secret stored for ${provider}`,
            status: 'completed',
            provider,
            encryption: payload.encryption,
            importedFromEnv: envName || importedDotenv?.envName || undefined,
            importedFromEnvScope: importedEnv?.scope,
            importedFromFile: importedFile ? normalizePath(importedFile.filePath) : undefined,
            importedFromDotenv: importedDotenv ? normalizePath(importedDotenv.filePath) : undefined,
            sourceDeleted,
        });
        if (options.json) printJson({ stored: true, provider, encryption: payload.encryption, path: normalizePath(providerSecretPath(root, provider)), updatedAt: now, importedFromEnv: envName || importedDotenv?.envName || undefined, importedFromEnvScope: importedEnv?.scope, importedFromFile: importedFile ? normalizePath(importedFile.filePath) : undefined, importedFromDotenv: importedDotenv ? normalizePath(importedDotenv.filePath) : undefined, sourceDeleted });
        else process.stdout.write(`Stored ${provider} secret with Windows DPAPI current-user encryption. Value was not printed.${sourceDeleted ? ' Source file deleted.' : ''}${os.EOL}`);
        return 0;
    }
    if (action === 'test') {
        const stored = readStoredProviderSecret(root, provider);
        if (!stored) throw new Error(`no stored provider secret found for ${provider}`);
        let decryptable = false;
        let error;
        try {
            decryptable = Boolean(normalizeProviderCredentialValue(dpapiUnprotect(stored.ciphertext)));
        } catch (err) {
            error = err && err.message ? err.message : String(err);
        }
        await appendLedgerEntry(root, {
            kind: 'secret.store.test',
            label: `Provider secret decrypt test for ${provider}`,
            status: decryptable ? 'completed' : 'failed',
            provider,
            encryption: stored.encryption,
            error,
        });
        if (options.json) printJson({ provider, stored: true, decryptable, encryption: stored.encryption, updatedAt: stored.updatedAt, error });
        else process.stdout.write(`Stored ${provider} secret decrypt test: ${decryptable ? 'ok' : 'failed'}. Value was not printed.${os.EOL}${error ? `Error: ${error}${os.EOL}` : ''}`);
        return decryptable ? 0 : 2;
    }
    if (action === 'delete' || action === 'remove' || action === 'clear') {
        if (!options.confirm) throw new Error(`secrets ${action} requires --confirm`);
        const filePath = providerSecretPath(root, provider);
        await fsp.rm(filePath, { force: true });
        await appendLedgerEntry(root, {
            kind: 'secret.store.delete',
            label: `Provider secret deleted for ${provider}`,
            status: 'completed',
            provider,
        });
        if (options.json) printJson({ deleted: true, provider, path: normalizePath(filePath) });
        else process.stdout.write(`Deleted stored ${provider} secret metadata/ciphertext. Value was not printed.${os.EOL}`);
        return 0;
    }
    throw new Error('secrets supports: status, set, test, delete');
}

function runSmokeCli(workspace, args, extra = {}) {
    const env = { ...process.env, ...(extra.env || {}) };
    const result = childProcess.spawnSync(process.execPath, [__filename, '--workspace', workspace, ...args], {
        cwd: extensionRoot(),
        encoding: 'utf8',
        env,
        windowsHide: true,
        timeout: extra.timeoutMs || 120000,
        maxBuffer: 1024 * 1024,
    });
    return {
        command: `node bin/harmony-cli.js --workspace <temp> ${args.join(' ')}`,
        exitCode: result.status === null ? 1 : result.status,
        signal: result.signal || undefined,
        stdout: truncateText(result.stdout || '', 4000),
        stderr: truncateText(result.stderr || '', 4000),
        error: result.error ? result.error.message : undefined,
    };
}

function runSmokeProcess(command, args, cwd, extra = {}) {
    const result = childProcess.spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...(extra.env || {}) },
        windowsHide: true,
        timeout: extra.timeoutMs || 300000,
        maxBuffer: 1024 * 1024,
    });
    return {
        command: [command, ...args].join(' '),
        exitCode: result.status === null ? 1 : result.status,
        signal: result.signal || undefined,
        stdout: truncateText(result.stdout || '', 4000),
        stderr: truncateText(result.stderr || '', 4000),
        error: result.error ? result.error.message : undefined,
    };
}

function smokeStep(name, result, allowedExitCodes = [0]) {
    return {
        name,
        status: allowedExitCodes.includes(result.exitCode) && !result.error ? 'passed' : 'failed',
        allowedExitCodes,
        result,
    };
}

function runNativeUiCorsContractSmoke() {
    const summary = {
        devOriginAllowed: allowedUiCorsOrigin('http://127.0.0.1:1420') === 'http://127.0.0.1:1420',
        localhostAllowed: allowedUiCorsOrigin('http://localhost:1420') === 'http://localhost:1420',
        tauriLocalhostAllowed: allowedUiCorsOrigin('http://tauri.localhost') === 'http://tauri.localhost',
        nonLocalBlocked: allowedUiCorsOrigin('https://example.com') === '',
        nullBlocked: allowedUiCorsOrigin('null') === '',
    };
    const ok = Object.values(summary).every(Boolean);
    return { exitCode: ok ? 0 : 1, summary };
}

async function runNativeActionReceiptSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        staleReceiptRejected: false,
        freshPreviewReceiptId: '',
        executeReceiptId: '',
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleDiagnosticsAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleDiagnosticsAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const previewPath = nativeActionReceiptPath(workspace, summary.previewReceiptId, 'preview');
        const staleReceipt = await readJson(previewPath);
        staleReceipt.expiresAt = new Date(Date.now() - 1000).toISOString();
        await fsp.writeFile(previewPath, JSON.stringify(staleReceipt, null, 2), 'utf8');
        try {
            await handleDiagnosticsAction(workspace, {}, {
                mode: 'execute',
                confirmation: preview.preview.requiredConfirmation,
                previewReceiptId: summary.previewReceiptId,
            });
        } catch (error) {
            summary.staleReceiptRejected = error?.statusCode === 409 && /stale/i.test(error.message || '');
        }

        const freshPreview = await handleDiagnosticsAction(workspace, {}, { mode: 'preview' });
        summary.freshPreviewReceiptId = freshPreview?.preview?.previewReceipt?.id || '';
        const executed = await handleDiagnosticsAction(workspace, {}, {
            mode: 'execute',
            confirmation: freshPreview.preview.requiredConfirmation,
            previewReceiptId: summary.freshPreviewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && summary.staleReceiptRejected
            && Boolean(summary.freshPreviewReceiptId)
            && Boolean(summary.executeReceiptId)
            && summary.executeReceiptWritten;
        return {
            command: 'native diagnostics controlled-action receipt spine',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native controlled-action receipt spine failed',
        };
    } catch (error) {
        return {
            command: 'native diagnostics controlled-action receipt spine',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeSnapshotDrillSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        restored: false,
        cleanedUp: false,
        disposableFileRemoved: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleSnapshotDrillAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleSnapshotDrillAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleSnapshotDrillAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.restored = Boolean(executed?.drill?.restored);
        summary.cleanedUp = Boolean(executed?.drill?.cleanedUp);
        summary.disposableFileRemoved = !(await pathExists(path.join(workspace, '_harmony_native_snapshot_drill.txt')));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.restored
            && summary.cleanedUp
            && summary.disposableFileRemoved
            && summary.executeReceiptWritten;
        return {
            command: 'native snapshot drill controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native snapshot drill controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native snapshot drill controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativePolicyReportSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        policyExists: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handlePolicyReportAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handlePolicyReportAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handlePolicyReportAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.policyExists = Boolean(executed?.report?.exists);
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.policyExists
            && summary.executeReceiptWritten;
        return {
            command: 'native outside-VS policy report controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native policy report controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native outside-VS policy report controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeBrokerProviderReportSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        providerStatusRows: 0,
        brokerMetadata: false,
        noSecretValues: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleBrokerProviderReportAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleBrokerProviderReportAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleBrokerProviderReportAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.providerStatusRows = Array.isArray(executed?.report?.providerStatus) ? executed.report.providerStatus.length : 0;
        summary.brokerMetadata = Boolean(executed?.report?.broker);
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const reportText = summary.reportPath ? await fsp.readFile(summary.reportPath, 'utf8') : '';
        summary.noSecretValues = !/fake-secret-for-phase3-smoke/i.test(reportText) && !/"ciphertext"\s*:/i.test(reportText);

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.providerStatusRows > 0
            && summary.brokerMetadata
            && summary.noSecretValues
            && summary.executeReceiptWritten;
        return {
            command: 'native broker/provider report controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native broker/provider report controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native broker/provider report controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeGitSafetyReportSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        insideWorkTree: false,
        statusCount: 0,
        diffStatsPresent: false,
        noPatchText: false,
        executeReceiptWritten: false,
    };
    const repo = path.join(workspace, 'git-safety-smoke');
    try {
        await fsp.mkdir(repo, { recursive: true });
        let setup = runSmokeProcess('git', ['init'], repo);
        if (setup.exitCode !== 0) throw new Error(setup.stderr || setup.stdout || 'git init failed');
        await fsp.writeFile(path.join(repo, 'tracked.txt'), 'before\n', 'utf8');
        setup = runSmokeProcess('git', ['add', '--', 'tracked.txt'], repo);
        if (setup.exitCode !== 0) throw new Error(setup.stderr || setup.stdout || 'git add failed');
        await fsp.writeFile(path.join(repo, 'tracked.txt'), 'after\n', 'utf8');
        await fsp.writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');

        const preview = await handleGitSafetyReportAction(repo, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleGitSafetyReportAction(repo, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleGitSafetyReportAction(repo, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.insideWorkTree = Boolean(executed?.report?.metadata?.insideWorkTree);
        summary.statusCount = executed?.report?.metadata?.statusCount || 0;
        summary.diffStatsPresent = Boolean((executed?.report?.metadata?.diffStats || []).length || (executed?.report?.metadata?.stagedDiffStats || []).length);
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const reportText = summary.reportPath ? await fsp.readFile(summary.reportPath, 'utf8') : '';
        summary.noPatchText = !/^diff --git /m.test(reportText) && !/^@@ /m.test(reportText);

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.insideWorkTree
            && summary.statusCount > 0
            && summary.diffStatsPresent
            && summary.noPatchText
            && summary.executeReceiptWritten;
        return {
            command: 'native git safety report controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native git safety report controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native git safety report controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeTerminalCommandReportSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        policyPresent: false,
        environmentNamesOnly: false,
        recentOperationsPresent: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleTerminalCommandReportAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleTerminalCommandReportAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleTerminalCommandReportAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.policyPresent = Boolean(executed?.report?.policy?.permissions && executed?.report?.policy?.budgets);
        summary.recentOperationsPresent = Array.isArray(executed?.report?.recentOperations);
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const envNames = executed?.report?.environment?.envNames || [];
        summary.environmentNamesOnly = Array.isArray(envNames)
            && envNames.length > 0
            && envNames.every(item => item && typeof item.name === 'string' && typeof item.present === 'boolean' && item.valueIncluded === false && !Object.prototype.hasOwnProperty.call(item, 'value'));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.policyPresent
            && summary.recentOperationsPresent
            && summary.environmentNamesOnly
            && summary.executeReceiptWritten;
        return {
            command: 'native terminal/command report controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native terminal/command report controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native terminal/command report controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeSelfHealingReportSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        packageVersion: '',
        toolCount: 0,
        notesConfirmNoMutation: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleSelfHealingReportAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleSelfHealingReportAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleSelfHealingReportAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.packageVersion = executed?.report?.metadata?.package?.version || '';
        summary.toolCount = executed?.report?.metadata?.package?.harmonyToolCount || 0;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const notes = executed?.report?.metadata?.notes || [];
        summary.notesConfirmNoMutation = notes.some(note => /No files were edited/i.test(note)) && notes.some(note => /no commands were executed/i.test(note));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && Boolean(summary.packageVersion)
            && summary.toolCount > 0
            && summary.notesConfirmNoMutation
            && summary.executeReceiptWritten;
        return {
            command: 'native self-healing report controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native self-healing report controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native self-healing report controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeSelfHealingGateSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        blockedAuthorityCount: 0,
        requiredBeforeMutation: 0,
        notesConfirmNoMutation: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleSelfHealingGateAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleSelfHealingGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleSelfHealingGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.blockedAuthorityCount = executed?.report?.contract?.blockedAuthorityClasses?.length || 0;
        summary.requiredBeforeMutation = executed?.report?.contract?.requiredBeforeMutation?.length || 0;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const notes = executed?.report?.contract?.notes || [];
        summary.notesConfirmNoMutation = notes.some(note => /does not compile/i.test(note))
            && notes.some(note => /separate named actions/i.test(note));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.blockedAuthorityCount >= 6
            && summary.requiredBeforeMutation >= 7
            && summary.notesConfirmNoMutation
            && summary.executeReceiptWritten;
        return {
            command: 'native self-healing gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native self-healing gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native self-healing gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeSelfHealingPackagePreflightSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        commandCount: 0,
        includesPackage: false,
        includesNoInstallGuard: false,
    };
    try {
        const preview = await handleSelfHealingPackagePreflightAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        summary.commandCount = preview?.preview?.target?.commandCount || 0;
        summary.includesPackage = (preview?.preview?.commands || []).some(step => /npm run package/i.test(step.commandLine || ''));
        summary.includesNoInstallGuard = (preview?.preview?.checks || []).some(check => /does not install/i.test(check));
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleSelfHealingPackagePreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const passed = summary.missingReceiptRejected
            && summary.commandCount >= 7
            && summary.includesPackage
            && summary.includesNoInstallGuard;
        return {
            command: 'native self-healing package preflight preview guard',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native self-healing package preflight preview guard failed',
        };
    } catch (error) {
        return {
            command: 'native self-healing package preflight preview guard',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleReportSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        posture: '',
        noStartStop: false,
        blockedAuthorityCount: 0,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleReportAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleReportAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleReportAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.posture = executed?.report?.metadata?.lifecycleContract?.posture || '';
        summary.blockedAuthorityCount = executed?.report?.metadata?.lifecycleContract?.blockedAuthorityClasses?.length || 0;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const notes = executed?.report?.metadata?.notes || [];
        summary.noStartStop = notes.some(note => /No daemon was started, stopped, killed, restarted, or relaunched/i.test(note));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.posture === 'outside-native-first'
            && summary.blockedAuthorityCount >= 4
            && summary.noStartStop
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle report controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle report controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle report controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecyclePreflightSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        lockReleased: false,
        noStartStop: false,
        checkCount: 0,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecyclePreflightAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecyclePreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecyclePreflightAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = executed?.report?.status || '';
        summary.lockReleased = Boolean(executed?.report?.lockRelease?.released);
        summary.checkCount = executed?.report?.checks?.length || 0;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const notes = executed?.report?.notes || [];
        summary.noStartStop = notes.some(note => /No daemon was started, stopped, killed, restarted, relaunched, or opened/i.test(note));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'passed'
            && summary.lockReleased
            && summary.checkCount >= 7
            && summary.noStartStop
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleStartGateSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        posture: '',
        latestPreflightStatus: '',
        blockedAuthorityCount: 0,
        startStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleStartGateAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleStartGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleStartGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.posture = contract.posture || '';
        summary.latestPreflightStatus = contract.latestPreflight?.status || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.startStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /starting daemon or opening native windows/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.posture === 'expert-gated-default-off'
            && summary.latestPreflightStatus === 'passed'
            && summary.blockedAuthorityCount >= 4
            && summary.startStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle start gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle start gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle start gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleStopGateSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        posture: '',
        latestPreflightStatus: '',
        blockedAuthorityCount: 0,
        stopStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleStopGateAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleStopGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleStopGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.posture = contract.posture || '';
        summary.latestPreflightStatus = contract.latestPreflight?.status || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.stopStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /stopping, killing, or restarting/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.posture === 'expert-gated-default-off'
            && summary.latestPreflightStatus === 'passed'
            && summary.blockedAuthorityCount >= 4
            && summary.stopStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle stop gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle stop gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle stop gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleReconnectGateSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        posture: '',
        latestPreflightStatus: '',
        healthProbeStatus: '',
        blockedAuthorityCount: 0,
        reconnectStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleReconnectGateAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleReconnectGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleReconnectGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.posture = contract.posture || '';
        summary.latestPreflightStatus = contract.latestPreflight?.status || '';
        summary.healthProbeStatus = contract.healthProbe?.status || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.reconnectStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /spawning, stopping, killing, restarting, or relaunching/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.posture === 'expert-gated-default-off'
            && summary.latestPreflightStatus === 'passed'
            && Boolean(summary.healthProbeStatus)
            && summary.blockedAuthorityCount >= 4
            && summary.reconnectStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle reconnect gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle reconnect gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle reconnect gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleStartPreflightSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        fixedCommandDigest: '',
        portPlanStatus: '',
        blockedAuthorityCount: 0,
        startStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleStartPreflightAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleStartPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleStartPreflightAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = executed?.report?.status || '';
        summary.fixedCommandDigest = contract.commandPlan?.digest || '';
        summary.portPlanStatus = contract.portPlan?.status || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.startStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /starting daemon or opening native windows/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'passed'
            && Boolean(summary.fixedCommandDigest)
            && ['available', 'existing-healthy-backend'].includes(summary.portPlanStatus)
            && summary.blockedAuthorityCount >= 4
            && summary.startStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle start preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle start preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle start preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleStopPreflightSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        fixedStopPlanDigest: '',
        targetPlanStatus: '',
        blockedAuthorityCount: 0,
        stopStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleStopPreflightAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleStopPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleStopPreflightAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = executed?.report?.status || '';
        summary.fixedStopPlanDigest = contract.stopPlan?.digest || '';
        summary.targetPlanStatus = contract.targetPlan?.status || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.stopStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /stopping, killing, or restarting/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'passed'
            && Boolean(summary.fixedStopPlanDigest)
            && ['owned-health-target-candidate', 'no-running-target'].includes(summary.targetPlanStatus)
            && summary.blockedAuthorityCount >= 4
            && summary.stopStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle stop preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle stop preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle stop preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleReconnectPreflightSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        reconnectPlanDigest: '',
        reconnectTargetStatus: '',
        blockedAuthorityCount: 0,
        reconnectStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleReconnectPreflightAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleReconnectPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleReconnectPreflightAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = executed?.report?.status || '';
        summary.reconnectPlanDigest = contract.reconnectPlan?.digest || '';
        summary.reconnectTargetStatus = contract.reconnectTarget?.status || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.reconnectStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /spawning, stopping, killing, restarting/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'passed'
            && Boolean(summary.reconnectPlanDigest)
            && ['existing-healthy-backend', 'no-backend-to-reconnect'].includes(summary.reconnectTargetStatus)
            && summary.blockedAuthorityCount >= 4
            && summary.reconnectStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle reconnect preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle reconnect preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle reconnect preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleRestartPreflightSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        restartPlanDigest: '',
        recoveryMode: '',
        blockedAuthorityCount: 0,
        restartStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleRestartPreflightAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleRestartPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleRestartPreflightAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = executed?.report?.status || '';
        summary.restartPlanDigest = contract.restartPlan?.digest || '';
        summary.recoveryMode = contract.recovery?.mode || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.restartStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /stopping, killing, signaling, spawning, or restarting/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'passed'
            && Boolean(summary.restartPlanDigest)
            && ['owned-stop-then-fixed-start', 'start-only-recovery'].includes(summary.recoveryMode)
            && summary.blockedAuthorityCount >= 5
            && summary.restartStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle restart preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle restart preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle restart preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleRestartExecuteGateSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        restartPlanDigest: '',
        recoveryMode: '',
        blockedAuthorityCount: 0,
        executeStillBlocked: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleNativeLifecycleRestartExecuteGateAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleRestartExecuteGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleRestartExecuteGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = executed?.report?.status || '';
        summary.restartPlanDigest = contract.proposedFutureExecute?.restartPlanDigest || '';
        summary.recoveryMode = contract.proposedFutureExecute?.mode || '';
        summary.blockedAuthorityCount = contract.blockedAuthorityClasses?.length || 0;
        summary.executeStillBlocked = (contract.blockedAuthorityClasses || []).some(item => /stopping, killing, signaling, spawning, or restarting/i.test(item));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'passed'
            && Boolean(summary.restartPlanDigest)
            && ['owned-stop-then-fixed-start', 'start-only-recovery'].includes(summary.recoveryMode)
            && summary.blockedAuthorityCount >= 5
            && summary.executeStillBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'native lifecycle restart execute gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle restart execute gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle restart execute gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runNativeLifecycleRestartExecuteSmoke(workspace) {
    const isolatedWorkspace = path.join(workspace, 'restart-execute-blocked-fixture');
    await fsp.mkdir(isolatedWorkspace, { recursive: true });
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        resultStatus: '',
        recoveryMode: '',
        lockedAndReleased: false,
        executeReceiptWritten: false,
        noProcessMutation: false,
    };
    try {
        const preview = await handleNativeLifecycleRestartExecuteAction(isolatedWorkspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeLifecycleRestartExecuteAction(isolatedWorkspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeLifecycleRestartExecuteAction(isolatedWorkspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const report = executed?.report || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = report.status || '';
        summary.resultStatus = report.result?.status || 'none';
        summary.recoveryMode = report.contractBefore?.recoveryMode || '';
        summary.lockedAndReleased = Boolean(report.lock?.token && report.lockRelease?.released);
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.noProcessMutation = !report.result?.stop && !report.result?.start;

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'blocked'
            && summary.resultStatus === 'none'
            && summary.lockedAndReleased
            && summary.executeReceiptWritten
            && summary.noProcessMutation;
        return {
            command: 'native lifecycle restart execute controlled action blocked path',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native lifecycle restart execute controlled action blocked path failed',
        };
    } catch (error) {
        return {
            command: 'native lifecycle restart execute controlled action blocked path',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatNoteSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        changedMessageRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        messageHashMatches: false,
        noProviderOrToolCall: false,
        executeReceiptWritten: false,
    };
    const message = 'Harmony floating chat ask-only smoke note.';
    try {
        const preview = await handleFloatingChatNoteAction(workspace, {}, { mode: 'preview', message });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatNoteAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, message });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        try {
            await handleFloatingChatNoteAction(workspace, {}, {
                mode: 'execute',
                confirmation: preview.preview.requiredConfirmation,
                previewReceiptId: summary.previewReceiptId,
                message: `${message} changed`,
            });
        } catch (error) {
            summary.changedMessageRejected = error?.statusCode === 409;
        }

        const executed = await handleFloatingChatNoteAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
            message,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.messageHashMatches = executed?.report?.message?.sha256 === floatingChatNoteHash(message);
        const notes = executed?.report?.notes || [];
        summary.noProviderOrToolCall = notes.some(note => /No provider call, tool execution/i.test(note));

        const passed = summary.missingReceiptRejected
            && summary.changedMessageRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.messageHashMatches
            && summary.noProviderOrToolCall
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat note controlled action',
            exitCode: passed ? 0 : 1,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat note controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat note controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatTurnSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        changedMessageRejected: false,
        changedConversationRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        conversationWritten: false,
        responseRequestWritten: false,
        messageHashMatches: false,
        responseStillBlocked: false,
        noProviderOrToolCall: false,
        executeReceiptWritten: false,
    };
    const message = 'Harmony floating chat conversation turn smoke.';
    const conversationId = 'smoke-conversation';
    try {
        const preview = await handleFloatingChatTurnAction(workspace, {}, { mode: 'preview', message, conversationId });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatTurnAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, message, conversationId });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        try {
            await handleFloatingChatTurnAction(workspace, {}, {
                mode: 'execute',
                confirmation: preview.preview.requiredConfirmation,
                previewReceiptId: summary.previewReceiptId,
                message: `${message} changed`,
                conversationId,
            });
        } catch (error) {
            summary.changedMessageRejected = error?.statusCode === 409;
        }

        try {
            await handleFloatingChatTurnAction(workspace, {}, {
                mode: 'execute',
                confirmation: preview.preview.requiredConfirmation,
                previewReceiptId: summary.previewReceiptId,
                message,
                conversationId: 'other-smoke-conversation',
            });
        } catch (error) {
            summary.changedConversationRejected = error?.statusCode === 409;
        }

        const executed = await handleFloatingChatTurnAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
            message,
            conversationId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.conversationWritten = Boolean(executed?.report?.conversation?.path && await pathExists(executed.report.conversation.path));
        summary.responseRequestWritten = Boolean(executed?.report?.responseRequest?.path && await pathExists(executed.report.responseRequest.path));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.messageHashMatches = executed?.report?.turn?.message?.sha256 === floatingChatTurnHash(message);
        summary.responseStillBlocked = executed?.report?.responseRequest?.status === 'queued-needs-explicit-response-gate';
        const notes = executed?.report?.notes || [];
        summary.noProviderOrToolCall = notes.some(note => /No provider call, tool execution/i.test(note));

        const passed = summary.missingReceiptRejected
            && summary.changedMessageRejected
            && summary.changedConversationRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.conversationWritten
            && summary.responseRequestWritten
            && summary.messageHashMatches
            && summary.responseStillBlocked
            && summary.noProviderOrToolCall
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat turn controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat turn controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat turn controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatResponseGateSmoke(workspace) {
    const summary = {
        responseRequestCreated: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        responseRequestCited: false,
        responseExecuteStillBlocked: false,
        providerMetadataOnly: false,
        noProviderOrToolCall: false,
        executeReceiptWritten: false,
    };
    try {
        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat response gate smoke turn.', 'response-gate-smoke');
        summary.responseRequestCreated = Boolean(turn?.report?.responseRequest?.path && await pathExists(turn.report.responseRequest.path));

        const preview = await handleFloatingChatResponseGateAction(workspace, {}, { mode: 'preview', conversationId: 'response-gate-smoke' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatResponseGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, conversationId: 'response-gate-smoke' });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatResponseGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
            conversationId: 'response-gate-smoke',
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.responseRequestCited = executed?.report?.contract?.latestResponseRequest?.conversationId === 'response-gate-smoke';
        summary.responseExecuteStillBlocked = executed?.report?.contract?.responseExecuteCurrentlyAllowed === false;
        const providers = executed?.report?.contract?.providerDisclosure?.providers || [];
        summary.providerMetadataOnly = providers.length > 0 && providers.every(provider => !Object.prototype.hasOwnProperty.call(provider, 'value'));
        const notes = executed?.report?.contract?.notes || [];
        summary.noProviderOrToolCall = notes.some(note => /No provider call, tool execution/i.test(note));

        const passed = summary.responseRequestCreated
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.responseRequestCited
            && summary.responseExecuteStillBlocked
            && summary.providerMetadataOnly
            && summary.noProviderOrToolCall
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat response gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat response gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat response gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatResponsePreflightSmoke(workspace) {
    const summary = {
        responseRequestCreated: false,
        responseGateRecorded: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        responseRequestCited: false,
        responseGateCited: false,
        policyChecked: false,
        responseExecuteStillBlocked: false,
        providerMetadataOnly: false,
        noProviderOrToolCall: false,
        executeReceiptWritten: false,
    };
    const conversationId = 'response-preflight-smoke';
    try {
        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat response preflight smoke turn.', conversationId);
        summary.responseRequestCreated = Boolean(turn?.report?.responseRequest?.path && await pathExists(turn.report.responseRequest.path));
        const gate = await commandFloatingChatResponseGate(workspace, {}, { conversationId });
        summary.responseGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));

        const preview = await handleFloatingChatResponsePreflightAction(workspace, {}, { mode: 'preview', conversationId });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatResponsePreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, conversationId });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatResponsePreflightAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
            conversationId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.responseRequestCited = executed?.report?.contract?.latestResponseRequest?.conversationId === conversationId;
        summary.responseGateCited = Boolean(executed?.report?.contract?.latestResponseGate?.file);
        summary.policyChecked = executed?.report?.contract?.policy?.mode === 'observe';
        summary.responseExecuteStillBlocked = executed?.report?.contract?.responseExecuteCurrentlyAllowed === false;
        const providers = executed?.report?.contract?.providerDisclosure?.providers || [];
        summary.providerMetadataOnly = providers.length > 0 && providers.every(provider => !Object.prototype.hasOwnProperty.call(provider, 'value'));
        const notes = executed?.report?.contract?.notes || [];
        summary.noProviderOrToolCall = notes.some(note => /No provider call, tool execution/i.test(note));

        const passed = summary.responseRequestCreated
            && summary.responseGateRecorded
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.responseRequestCited
            && summary.responseGateCited
            && summary.policyChecked
            && summary.responseExecuteStillBlocked
            && summary.providerMetadataOnly
            && summary.noProviderOrToolCall
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat response preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat response preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat response preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runAutonomyCommitGateSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        posture: '',
        autonomousLoops: true,
        gitMutations: true,
        requiredBeforeAutonomy: 0,
        requiredBeforeCommit: 0,
        notesConfirmNoMutation: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleAutonomyCommitGateAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleAutonomyCommitGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleAutonomyCommitGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        const contract = executed?.report?.contract || {};
        summary.posture = contract.posture || '';
        summary.autonomousLoops = Boolean(contract.currentPermissions?.autonomousLoops);
        summary.gitMutations = Boolean(contract.currentPermissions?.gitMutations);
        summary.requiredBeforeAutonomy = contract.requiredBeforeAutonomy?.length || 0;
        summary.requiredBeforeCommit = contract.requiredBeforeCommit?.length || 0;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const notes = contract.notes || [];
        summary.notesConfirmNoMutation = notes.some(note => /does not run autonomous loops/i.test(note));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.posture === 'expert-gated-default-off'
            && summary.autonomousLoops === false
            && summary.gitMutations === false
            && summary.requiredBeforeAutonomy >= 5
            && summary.requiredBeforeCommit >= 6
            && summary.notesConfirmNoMutation
            && summary.executeReceiptWritten;
        return {
            command: 'autonomy commit gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'autonomy commit gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'autonomy commit gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runOutsideToolPolicyGateSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        status: '',
        toolClassCount: 0,
        requiredBeforeToolExecution: 0,
        chatDeletionBlocked: false,
        reportOnlyAuthority: false,
        executeReceiptWritten: false,
    };
    try {
        const preview = await handleOutsideToolPolicyGateAction(workspace, {}, { mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleOutsideToolPolicyGateAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleOutsideToolPolicyGateAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        const contract = executed?.report?.contract || {};
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.status = executed?.report?.status || '';
        summary.toolClassCount = contract.toolClasses?.length || 0;
        summary.requiredBeforeToolExecution = contract.requiredBeforeToolExecution?.length || 0;
        summary.chatDeletionBlocked = (contract.blockedAuthorityClasses || []).some(item => /chat deletion/i.test(item));
        summary.reportOnlyAuthority = contract.authority?.reportWritesOnly === true && contract.authority?.toolExecution === false;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.status === 'recorded'
            && summary.toolClassCount >= 6
            && summary.requiredBeforeToolExecution >= 6
            && summary.chatDeletionBlocked
            && summary.reportOnlyAuthority
            && summary.executeReceiptWritten;
        return {
            command: 'outside tool policy gate controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'outside tool policy gate controlled action failed',
        };
    } catch (error) {
        return {
            command: 'outside tool policy gate controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function writeSmokeReport(root, report) {
    const dir = harmonyPath(root, 'smoke');
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${report.id}.json`);
    await fsp.writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'smoke.phase3',
        label: `Phase 3 disposable smoke ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(filePath),
        tempWorkspace: report.tempWorkspace,
        steps: report.steps.map(step => ({ name: step.name, status: step.status, exitCode: step.result.exitCode })),
    });
    return filePath;
}

async function commandProviderLiveHarnessSmoke(root, options) {
    const providers = providerLiveHarnessProviders(options);
    const fakeByProvider = new Map();
    const previousByEnv = new Map();
    try {
        for (const provider of providers) {
            const config = CLI_PROVIDER_DEFAULTS[provider];
            const envName = config?.env?.[0];
            if (!envName) continue;
            const fake = `fake-${provider}-live-harness-secret-value`;
            fakeByProvider.set(provider, fake);
            previousByEnv.set(envName, process.env[envName]);
            process.env[envName] = fake;
        }
        const report = buildProviderLiveHarnessReport(root, options);
        const serializedBeforeSecretCheck = JSON.stringify(report);
        const leakedFakes = [...fakeByProvider.values()].filter(fake => serializedBeforeSecretCheck.includes(fake));
        report.checks.push({
            name: 'secret_values_excluded_from_report',
            status: leakedFakes.length === 0 ? 'passed' : 'failed',
            detail: leakedFakes.length === 0 ? 'fake provider key values are not present in harness report JSON' : `leaked fake provider values: ${leakedFakes.join(', ')}`,
        });
        report.checks.push({
            name: 'planned_commands_are_not_executed',
            status: report.providers.every(item => item.liveCall?.performed === false && item.plannedLiveCommand.includes('--execute --confirm')) ? 'passed' : 'failed',
            detail: 'live commands are represented as future explicit commands only',
        });
        report.status = report.providers.every(item => item.status !== 'blocked') && report.checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
        const reportPath = await writeProviderLiveHarnessReport(root, report);
        if (options.json) printJson({ reportPath, report });
        else {
            process.stdout.write([
                `Provider live harness smoke: ${report.status}`,
                `Report: ${normalizePath(reportPath)}`,
                'Provider calls performed: no',
                'Network requests performed: no',
                '',
            ].join(os.EOL));
        }
        return report.status === 'passed' ? 0 : 2;
    } finally {
        for (const [envName, previous] of previousByEnv) {
            if (previous === undefined) delete process.env[envName];
            else process.env[envName] = previous;
        }
    }
}

async function commandAuthorityMatrixSmoke(root, options) {
    const id = `authority-matrix-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const tempWorkspace = path.join(os.tmpdir(), id);
    const steps = [];
    await fsp.mkdir(tempWorkspace, { recursive: true });
    try {
        steps.push(smokeStep('provider report-only action blocks provider calls', await runNativeBrokerProviderReportSmoke(tempWorkspace)));
        steps.push(smokeStep('git safety report-only action blocks git mutation', await runNativeGitSafetyReportSmoke(tempWorkspace)));
        steps.push(smokeStep('terminal report-only action blocks shell execution', await runNativeTerminalCommandReportSmoke(tempWorkspace)));

        const cli = await fsp.readFile(__filename, 'utf8');
        const nativeUi = await fsp.readFile(path.join(extensionRoot(), 'native-ui', 'src', 'main.ts'), 'utf8');
        const forbiddenExecuteMarkers = [
            ['/actions/terminal-command', 'execute'].join('-'),
            ['terminal-command', 'execute'].join('-'),
            ['commandTerminal', 'CommandExecute'].join(''),
            ['/actions/provider-call-loop', 'execute'].join('-'),
            ['provider-call-loop', 'execute'].join('-'),
            ['commandProviderCall', 'LoopExecute'].join(''),
            ['/actions/git-mutation', 'execute'].join('-'),
            ['git-mutation', 'execute'].join('-'),
            ['commandGit', 'MutationExecute'].join(''),
        ];
        const foundForbidden = forbiddenExecuteMarkers.filter(marker => cli.includes(marker) || nativeUi.includes(marker));
        steps.push(smokeStep('terminal provider git execute surfaces absent', {
            command: 'static authority execute surface scan',
            exitCode: foundForbidden.length ? 2 : 0,
            stdout: foundForbidden.length ? `found ${foundForbidden.join(', ')}` : 'No terminal/provider/git execute route or command markers found.',
            stderr: '',
        }));
    } finally {
        if (!options.keep) await fsp.rm(tempWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
    const report = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        tempWorkspace: normalizePath(tempWorkspace),
        tempWorkspaceKept: Boolean(options.keep),
        status: steps.every(step => step.status === 'passed') ? 'passed' : 'failed',
        posture: 'terminal-provider-git-authority-matrix-report-only',
        authority: {
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            sourceFileWrites: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        steps,
    };
    const reportPath = await writeSmokeReport(root, report);
    if (options.json) printJson({ reportPath, report });
    else {
        process.stdout.write([
            `Authority matrix smoke: ${report.status}`,
            `Report: ${normalizePath(reportPath)}`,
            `Temp workspace: ${report.tempWorkspaceKept ? report.tempWorkspace : `${report.tempWorkspace} (removed)`}`,
            '',
            ...report.steps.map(step => `- ${step.status === 'passed' ? 'PASS' : 'FAIL'} ${step.name}`),
            '',
        ].join(os.EOL));
    }
    return report.status === 'passed' ? 0 : 2;
}

async function commandSmoke(root, subcommand, options) {
    const target = subcommand || 'phase3';
    if (target === 'source-write-execute') return await commandSourceWriteExecuteSmoke(root, options);
    if (target === 'provider-live-harness') return await commandProviderLiveHarnessSmoke(root, options);
    if (target === 'authority-matrix') return await commandAuthorityMatrixSmoke(root, options);
    if (target !== 'phase3') throw new Error('smoke supports: phase3, source-write-execute, provider-live-harness, authority-matrix');
    const id = `phase3-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const tempWorkspace = path.join(os.tmpdir(), id);
    const steps = [];
    await fsp.mkdir(tempWorkspace, { recursive: true });
    try {
        await fsp.writeFile(path.join(tempWorkspace, 'target.txt'), 'broken\n', 'utf8');
        await fsp.writeFile(path.join(tempWorkspace, 'check-smoke.js'), "const fs=require('fs'); const text=fs.readFileSync('target.txt','utf8'); if (!text.includes('fixed')) { console.error('target is not fixed'); process.exit(1); }\n", 'utf8');
        await fsp.writeFile(path.join(tempWorkspace, 'fix.patch'), ['diff --git a/target.txt b/target.txt', '--- a/target.txt', '+++ b/target.txt', '@@ -1 +1 @@', '-broken', '+fixed', ''].join('\n'), 'utf8');

        steps.push(smokeStep('policy init', runSmokeCli(tempWorkspace, ['policy', 'init'])));
        steps.push(smokeStep('allow runCommands', runSmokeCli(tempWorkspace, ['policy', 'set', '--permission', 'runCommands', '--value', 'true', '--confirm'])));
        steps.push(smokeStep('allow writeFiles', runSmokeCli(tempWorkspace, ['policy', 'set', '--permission', 'writeFiles', '--value', 'true', '--confirm'])));
        steps.push(smokeStep('allow paidProviderCalls', runSmokeCli(tempWorkspace, ['policy', 'set', '--permission', 'paidProviderCalls', '--value', 'true', '--confirm'])));
        steps.push(smokeStep('set command budget', runSmokeCli(tempWorkspace, ['policy', 'set', '--maxCommandSeconds', '15', '--confirm'])));
        steps.push(smokeStep('snapshot drill', runSmokeCli(tempWorkspace, ['snapshot', 'drill', '--path', 'smoke-drill.txt', '--confirm'])));
        steps.push(smokeStep('secret set fake', runSmokeCli(tempWorkspace, ['secrets', 'set', '--provider', 'gemini', '--from-env', 'HARMONY_PHASE3_FAKE_KEY', '--confirm'], { env: { HARMONY_PHASE3_FAKE_KEY: 'fake-secret-for-phase3-smoke' } })));
        steps.push(smokeStep('secret decrypt test', runSmokeCli(tempWorkspace, ['secrets', 'test', '--provider', 'gemini'])));
        steps.push(smokeStep('secret clear', runSmokeCli(tempWorkspace, ['secrets', 'clear', '--provider', 'gemini', '--confirm'])));
        steps.push(smokeStep('broker timeout', runSmokeCli(tempWorkspace, ['ask', 'phase3 broker timeout smoke', '--execute', '--broker', '--confirm', '--broker-timeout', '1'])));
        steps.push(smokeStep('guarded patch apply', runSmokeCli(tempWorkspace, ['run-fail-fix', '--execute', '--apply', '--command', 'node check-smoke.js', '--patch-file', 'fix.patch', '--confirm', '--command-timeout', '10', '--apply-timeout', '10'])));

        const commitWorkspace = path.join(tempWorkspace, 'commit-smoke');
        await fsp.mkdir(commitWorkspace, { recursive: true });
        await fsp.writeFile(path.join(commitWorkspace, 'commit-target.txt'), 'before\n', 'utf8');
        await fsp.writeFile(path.join(commitWorkspace, 'check-commit.js'), "const fs=require('fs'); const text=fs.readFileSync('commit-target.txt','utf8'); if (text !== 'after\\n') { console.error('commit target did not validate'); process.exit(1); }\n", 'utf8');
        steps.push(smokeStep('commit smoke git init', runSmokeProcess('git', ['init'], commitWorkspace)));
        steps.push(smokeStep('commit smoke git user email', runSmokeProcess('git', ['config', 'user.email', 'harmony-smoke@example.invalid'], commitWorkspace)));
        steps.push(smokeStep('commit smoke git user name', runSmokeProcess('git', ['config', 'user.name', 'Harmony Smoke'], commitWorkspace)));
        steps.push(smokeStep('commit smoke base add', runSmokeProcess('git', ['add', 'commit-target.txt'], commitWorkspace)));
        steps.push(smokeStep('commit smoke base commit', runSmokeProcess('git', ['commit', '-m', 'phase3 smoke base'], commitWorkspace)));
        await fsp.writeFile(path.join(commitWorkspace, 'commit-target.txt'), 'after\n', 'utf8');
        steps.push(smokeStep('commit smoke targeted snapshot', runSmokeCli(commitWorkspace, ['snapshot', 'create', '--path', 'commit-target.txt'])));
        steps.push(smokeStep('commit smoke validation', runSmokeProcess(process.execPath, ['check-commit.js'], commitWorkspace)));
        steps.push(smokeStep('commit smoke diff check', runSmokeProcess('git', ['diff', '--check', '--', 'commit-target.txt'], commitWorkspace)));
        steps.push(smokeStep('commit smoke add dry-run', runSmokeProcess('git', ['add', '--dry-run', '--', 'commit-target.txt'], commitWorkspace)));
        steps.push(smokeStep('commit smoke manifest add', runSmokeProcess('git', ['add', '--', 'commit-target.txt'], commitWorkspace)));
        const staged = runSmokeProcess('git', ['diff', '--cached', '--name-only'], commitWorkspace);
        const stagedPaths = staged.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
        steps.push({
            name: 'commit smoke staged path check',
            status: staged.exitCode === 0 && stagedPaths.length === 1 && stagedPaths[0] === 'commit-target.txt' ? 'passed' : 'failed',
            allowedExitCodes: [0],
            result: { ...staged, expectedPaths: ['commit-target.txt'], stagedPaths },
        });
        steps.push(smokeStep('commit smoke cached diff check', runSmokeProcess('git', ['diff', '--cached', '--check'], commitWorkspace)));
        steps.push(smokeStep('commit smoke dry-run commit', runSmokeProcess('git', ['commit', '--dry-run', '--short'], commitWorkspace)));
        steps.push(smokeStep('commit smoke manifest commit', runSmokeProcess('git', ['commit', '-m', 'phase3 smoke manifest commit'], commitWorkspace)));
        const committed = runSmokeProcess('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], commitWorkspace);
        const committedPaths = committed.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
        steps.push({
            name: 'commit smoke committed path check',
            status: committed.exitCode === 0 && committedPaths.length === 1 && committedPaths[0] === 'commit-target.txt' ? 'passed' : 'failed',
            allowedExitCodes: [0],
            result: { ...committed, expectedPaths: ['commit-target.txt'], committedPaths },
        });

        const packagePath = path.join(extensionRoot(), 'package.json');
        const pkg = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
        const properties = pkg?.contributes?.configuration?.properties || {};
        const switchKeys = [
            'harmony.swarm.mutationExecution.enabled',
            'harmony.swarm.patchExecution.enabled',
            'harmony.swarm.terminalExecution.enabled',
            'harmony.swarm.providerCalls.enabled',
            'harmony.swarm.autonomyExecution.enabled',
            'harmony.swarm.commitExecution.enabled',
        ];
        const missingOrEnabled = switchKeys.filter(key => properties[key]?.default !== false);
        steps.push({
            name: 'swarm dangerous switches default off',
            status: missingOrEnabled.length ? 'failed' : 'passed',
            allowedExitCodes: [0],
            result: {
                command: 'static package.json configuration check',
                exitCode: missingOrEnabled.length ? 2 : 0,
                stdout: missingOrEnabled.length ? `Missing/default-enabled switch(es): ${missingOrEnabled.join(', ')}` : 'All dangerous swarm switches default to false.',
                stderr: '',
            },
        });
        const stateContractRaw = childProcess.spawnSync(process.execPath, [__filename, '--workspace', tempWorkspace, 'status', '--json', '--limit', '3'], {
            cwd: extensionRoot(),
            encoding: 'utf8',
            env: process.env,
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
        });
        const stateContract = {
            command: 'node bin/harmony-cli.js --workspace <temp> status --json --limit 3',
            exitCode: stateContractRaw.status === null ? 1 : stateContractRaw.status,
            signal: stateContractRaw.signal || undefined,
            stdout: truncateText(stateContractRaw.stdout || '', 4000),
            stderr: truncateText(stateContractRaw.stderr || '', 4000),
            error: stateContractRaw.error ? stateContractRaw.error.message : undefined,
        };
        let stateContractError = '';
        let parsedState = {};
        try {
            parsedState = JSON.parse(stateContractRaw.stdout || '{}');
        } catch (error) {
            stateContractError = error && error.message ? error.message : String(error);
        }
        const stateContractOk = stateContract.exitCode === 0
            && Array.isArray(parsedState.snapshots)
            && parsedState.snapshots.length > 0
            && parsedState.snapshots.every(item => item && item.restoreCommand && item.coverage)
            && parsedState.broker && Array.isArray(parsedState.broker.pending)
            && Array.isArray(parsedState.providerSecrets)
            && Array.isArray(parsedState.smokeReports)
            && parsedState.crossSurface && parsedState.crossSurface.safetySwitches && parsedState.crossSurface.broker
            && Array.isArray(parsedState.swarmSafetySwitches)
            && parsedState.swarmSafetySwitches.length === switchKeys.length
            && parsedState.swarmSafetySwitches.every(item => item && item.failClosed === true)
            && parsedState.swarmDefaultStatus?.mode === 'plan-only launcher default'
            && parsedState.swarmDefaultStatus?.riskySwitchesOnByDefault?.length === 0;
        steps.push({
            name: 'native state contract panels',
            status: stateContractOk ? 'passed' : 'failed',
            allowedExitCodes: [0],
            result: {
                ...stateContract,
                parsed: {
                    snapshots: Array.isArray(parsedState.snapshots) ? parsedState.snapshots.length : 'missing',
                    brokerPending: parsedState.broker?.pending?.length ?? 'missing',
                    providerSecrets: Array.isArray(parsedState.providerSecrets) ? parsedState.providerSecrets.length : 'missing',
                    smokeReports: Array.isArray(parsedState.smokeReports) ? parsedState.smokeReports.length : 'missing',
                    crossSurface: parsedState.crossSurface ? 'present' : 'missing',
                    swarmSafetySwitches: Array.isArray(parsedState.swarmSafetySwitches) ? parsedState.swarmSafetySwitches.length : 'missing',
                },
                error: stateContractError,
            },
        });
        steps.push(smokeStep('native UI CORS contract', runNativeUiCorsContractSmoke()));
        steps.push(smokeStep('native controlled-action receipt spine', await runNativeActionReceiptSmoke(tempWorkspace)));
        steps.push(smokeStep('native snapshot drill action', await runNativeSnapshotDrillSmoke(tempWorkspace)));
        steps.push(smokeStep('native policy report action', await runNativePolicyReportSmoke(tempWorkspace)));
        steps.push(smokeStep('native broker/provider report action', await runNativeBrokerProviderReportSmoke(tempWorkspace)));
        steps.push(smokeStep('native git safety report action', await runNativeGitSafetyReportSmoke(tempWorkspace)));
        steps.push(smokeStep('native terminal/command report action', await runNativeTerminalCommandReportSmoke(tempWorkspace)));
        steps.push(smokeStep('native self-healing report action', await runNativeSelfHealingReportSmoke(tempWorkspace)));
        steps.push(smokeStep('native self-healing gate action', await runNativeSelfHealingGateSmoke(tempWorkspace)));
        if (!options['skip-self-healing-package-preflight']) steps.push(smokeStep('native self-healing package preflight guard', await runNativeSelfHealingPackagePreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle report action', await runNativeLifecycleReportSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle preflight action', await runNativeLifecyclePreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle start gate action', await runNativeLifecycleStartGateSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle stop gate action', await runNativeLifecycleStopGateSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle reconnect gate action', await runNativeLifecycleReconnectGateSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle start preflight action', await runNativeLifecycleStartPreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle stop preflight action', await runNativeLifecycleStopPreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle reconnect preflight action', await runNativeLifecycleReconnectPreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle restart preflight action', await runNativeLifecycleRestartPreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle restart execute gate action', await runNativeLifecycleRestartExecuteGateSmoke(tempWorkspace)));
        steps.push(smokeStep('native lifecycle restart execute action blocked path', await runNativeLifecycleRestartExecuteSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat note action', await runFloatingChatNoteSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat turn action', await runFloatingChatTurnSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat response gate action', await runFloatingChatResponseGateSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat response preflight action', await runFloatingChatResponsePreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat response execute action', await runFloatingChatResponseExecuteSmoke(tempWorkspace)));
        steps.push(smokeStep('autonomy commit gate action', await runAutonomyCommitGateSmoke(tempWorkspace)));
        steps.push(smokeStep('outside tool policy gate action', await runOutsideToolPolicyGateSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat provider tool preflight action', await runFloatingChatToolPreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat provider tool-loop preflight action', await runFloatingChatToolLoopPreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat provider tool-loop one-step execute action', await runFloatingChatToolLoopExecuteSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat autonomy next action', await runFloatingChatAutonomyNextSmoke(tempWorkspace)));
        steps.push(smokeStep('floating chat read-only tool execute action', await runFloatingChatToolExecuteSmoke(tempWorkspace)));
        steps.push(smokeStep('native file write controlled action', await runNativeFileWriteSmoke(tempWorkspace)));
        steps.push(smokeStep('source-write preflight report-only action', await runSourceWritePreflightSmoke(tempWorkspace)));
        steps.push(smokeStep('autonomy dry-run action', await runAutonomyDryRunSmoke(tempWorkspace)));
        const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
        const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm --prefix native-ui run build'] : ['--prefix', 'native-ui', 'run', 'build'];
        steps.push(smokeStep('native UI frontend build', runSmokeProcess(npmCommand, npmArgs, extensionRoot(), { timeoutMs: 300000 })));
        steps.push(smokeStep('native UI Tauri cargo check', runSmokeProcess('cargo', ['check', '--manifest-path', path.join(extensionRoot(), 'native-ui', 'src-tauri', 'Cargo.toml')], extensionRoot(), { timeoutMs: 600000 })));
    } finally {
        if (!options.keep) await fsp.rm(tempWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
    const report = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        tempWorkspace: normalizePath(tempWorkspace),
        tempWorkspaceKept: Boolean(options.keep),
        status: steps.every(step => step.status === 'passed') ? 'passed' : 'failed',
        steps,
    };
    const reportPath = await writeSmokeReport(root, report);
    if (options.json) printJson({ reportPath, report });
    else {
        const lines = [
            `Phase 3 disposable smoke: ${report.status}`,
            `Report: ${normalizePath(reportPath)}`,
            `Temp workspace: ${report.tempWorkspaceKept ? report.tempWorkspace : `${report.tempWorkspace} (removed)`}`,
            '',
            ...report.steps.map(step => `- ${step.status === 'passed' ? 'PASS' : 'FAIL'} ${step.name}`),
            '',
        ];
        process.stdout.write(lines.join(os.EOL));
    }
    return report.status === 'passed' ? 0 : 2;
}

function gitPreviewTimeout(options) {
    const value = Number(options['git-timeout'] || options.seconds || 15);
    if (!Number.isFinite(value) || value <= 0) throw new Error('--git-timeout requires a positive number of seconds');
    return value;
}

function parseNameStatus(text) {
    return String(text || '').split(/\r?\n/).filter(Boolean).map(line => {
        const parts = line.split(/\t+/);
        return { status: parts[0] || '?', path: normalizePath(parts.slice(1).join('\t') || '') };
    }).filter(item => item.path);
}

function parseCleanPreview(text) {
    return String(text || '').split(/\r?\n/).filter(Boolean).map(line => line.replace(/^Would remove\s+/, '').trim()).filter(Boolean).map(normalizePath);
}

function parseConflictStatus(text) {
    return String(text || '').split(/\r?\n/).filter(Boolean).map(line => {
        const status = line.slice(0, 2);
        const file = line.slice(3).trim();
        return { status, path: normalizePath(file) };
    }).filter(item => item.path && (/U/.test(item.status) || ['AA', 'DD'].includes(item.status)));
}

async function commandGitPreview(root, subcommand, options) {
    const timeoutSeconds = gitPreviewTimeout(options);
    const mode = String(subcommand || 'status').toLowerCase();
    let payload;
    if (mode === 'reset') {
        const [status, unstaged, staged] = await Promise.all([
            runProcessCapture(root, 'git', ['status', '--short'], timeoutSeconds),
            runProcessCapture(root, 'git', ['diff', '--name-status'], timeoutSeconds),
            runProcessCapture(root, 'git', ['diff', '--cached', '--name-status'], timeoutSeconds),
        ]);
        payload = {
            mode,
            description: 'Read-only preview of tracked/staged changes that a reset could affect. No reset was run.',
            git: { status, unstaged, staged },
            trackedChanges: parseNameStatus(unstaged.stdout),
            stagedChanges: parseNameStatus(staged.stdout),
            statusLines: String(status.stdout || '').split(/\r?\n/).filter(Boolean),
        };
    } else if (mode === 'clean') {
        const cleanMode = options.all ? 'all-untracked-and-ignored' : options.ignored ? 'ignored-only' : 'untracked-only';
        const args = options.all ? ['clean', '-ndx'] : options.ignored ? ['clean', '-ndX'] : ['clean', '-nd'];
        const clean = await runProcessCapture(root, 'git', args, timeoutSeconds);
        payload = {
            mode,
            cleanMode,
            description: 'Read-only git clean dry-run preview. No files were deleted.',
            git: { clean },
            wouldRemove: parseCleanPreview(clean.stdout),
        };
    } else if (mode === 'conflicts') {
        const [unmerged, status] = await Promise.all([
            runProcessCapture(root, 'git', ['diff', '--name-only', '--diff-filter=U'], timeoutSeconds),
            runProcessCapture(root, 'git', ['status', '--porcelain=v1'], timeoutSeconds),
        ]);
        payload = {
            mode,
            description: 'Read-only preview of unmerged/conflicted files. No conflict resolution was attempted.',
            git: { unmerged, status },
            unmergedFiles: String(unmerged.stdout || '').split(/\r?\n/).filter(Boolean).map(normalizePath),
            conflictEntries: parseConflictStatus(status.stdout),
        };
    } else {
        throw new Error('git-preview supports: reset, clean, conflicts');
    }
    const failedCommands = Object.values(payload.git || {}).filter(result => result && (result.exitCode !== 0 || result.timedOut));
    const receipt = await appendLedgerEntry(root, {
        kind: `git.preview.${mode}`,
        label: `Dangerous git ${mode} preview`,
        status: failedCommands.length ? 'failed' : 'completed',
        mode,
        readOnly: true,
        failedCommands: failedCommands.length,
    });
    const result = {
        version: 1,
        workspace: root,
        readOnly: true,
        generatedAt: new Date().toISOString(),
        receiptPath: normalizePath(receipt.path),
        receiptId: receipt.entry.id,
        ...payload,
    };
    if (options.json) printJson(result);
    else {
        process.stdout.write(`Git ${mode} preview (read-only)${os.EOL}`);
        if (mode === 'reset') {
            process.stdout.write(`Tracked changes: ${result.trackedChanges.length}${os.EOL}Staged changes: ${result.stagedChanges.length}${os.EOL}`);
            for (const item of [...result.stagedChanges, ...result.trackedChanges].slice(0, Number(options.limit || 50))) process.stdout.write(`- ${item.status} ${item.path}${os.EOL}`);
        } else if (mode === 'clean') {
            process.stdout.write(`Would remove: ${result.wouldRemove.length}${os.EOL}`);
            for (const item of result.wouldRemove.slice(0, Number(options.limit || 50))) process.stdout.write(`- ${item}${os.EOL}`);
        } else {
            process.stdout.write(`Conflicts: ${result.conflictEntries.length || result.unmergedFiles.length}${os.EOL}`);
            for (const item of result.conflictEntries.slice(0, Number(options.limit || 50))) process.stdout.write(`- ${item.status} ${item.path}${os.EOL}`);
        }
    }
    return failedCommands.length ? 2 : 0;
}

async function commandDaemon(root, options) {
    const intervalMs = Math.max(5000, Number(options.interval || 30000));
    const label = String(options.label || 'Harmony terminal supervisor daemon');
    const daemonOptions = { ...options, label, surface: options.surface || 'terminal' };
    await appendSupervisorEvent(root, { timestamp: new Date().toISOString(), kind: 'daemon-start', surface: daemonOptions.surface, pid: process.pid, label });
    await writeHeartbeat(root, daemonOptions);
    process.stdout.write(`Harmony terminal daemon running for ${root}${os.EOL}`);
    process.stdout.write(`Heartbeat interval: ${intervalMs}ms. Press Ctrl+C to stop.${os.EOL}`);
    const timer = setInterval(() => {
        writeHeartbeat(root, daemonOptions).catch(error => {
            process.stderr.write(`heartbeat failed: ${error && error.message ? error.message : String(error)}${os.EOL}`);
        });
    }, intervalMs);
    const stop = async (signal) => {
        clearInterval(timer);
        await appendSupervisorEvent(root, { timestamp: new Date().toISOString(), kind: 'daemon-stop', surface: daemonOptions.surface, pid: process.pid, label, signal }).catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', () => { void stop('SIGINT'); });
    process.on('SIGTERM', () => { void stop('SIGTERM'); });
}

async function commandContinuity(root, options) {
    const continuity = await readContinuity(root, Number(options.limit || 10));
    if (options.json) {
        printJson(continuity);
        return;
    }
    process.stdout.write(`Harmony continuity tail: ${normalizePath(continuity.path)}${os.EOL}`);
    if (!continuity.entries.length) {
        process.stdout.write('- none' + os.EOL);
        return;
    }
    for (const entry of continuity.entries) {
        process.stdout.write(`- ${entry.ts || '?'} | ${entry.kind || '?'} | ${entry.summary || entry.id || '(no summary)'}${os.EOL}`);
    }
    return 0;
}

function redactResumeText(value) {
    return String(value || '')
        .replace(/(authorization\s*[:=]\s*)\S+/ig, '$1[redacted]')
        .replace(/(api[-_ ]?key\s*[:=]\s*)\S+/ig, '$1[redacted]')
        .replace(/(token\s*[:=]\s*)\S+/ig, '$1[redacted]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[redacted]');
}

async function newestFiles(dirPath, pattern, limit = 5) {
    const names = await readDirSafe(dirPath);
    const files = [];
    for (const name of names) {
        if (pattern && !pattern.test(name)) continue;
        const filePath = path.join(dirPath, name);
        const stat = await fsp.stat(filePath).catch(() => undefined);
        if (!stat?.isFile()) continue;
        files.push({ name, path: filePath, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    files.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    return files.slice(0, limit).map(item => ({ ...item, path: normalizePath(item.path) }));
}

async function readBoundedTail(filePath, maxBytes) {
    const stat = await fsp.stat(filePath).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`resume source is not a file: ${normalizePath(filePath)}`);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - bytesToRead);
    const handle = await fsp.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytesToRead);
        await handle.read(buffer, 0, bytesToRead, start);
        let text = buffer.toString('utf8');
        if (start > 0) text = text.replace(/^.*?(\r?\n|$)/, '');
        return { text, sizeBytes: stat.size, readBytes: bytesToRead, truncated: start > 0, modifiedAt: stat.mtime.toISOString() };
    } finally {
        await handle.close();
    }
}

function summarizeResumeTail(text, maxLines, maxLineChars) {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(-maxLines)
        .map(line => redactResumeText(line).slice(0, maxLineChars));
}

async function collectResumeBrief(root, options) {
    const maxTailBytes = Math.max(16 * 1024, Math.min(Number(options['max-tail-bytes'] || 256 * 1024), 512 * 1024));
    const maxLines = Math.max(2, Math.min(Number(options['max-lines'] || 20), 60));
    const maxLineChars = Math.max(120, Math.min(Number(options['max-line-chars'] || 1000), 2000));
    const continuity = await readContinuity(root, Number(options.limit || 8));
    const handoffs = await newestFiles(harmonyPath(root, 'handoffs'), /\.(json|md)$/i, 6);
    const floatingConversations = await newestFiles(harmonyPath(root, 'floating-chat', 'conversations'), /\.json$/i, 6);
    const diagnostics = await newestFiles(harmonyPath(root, 'diagnostics'), /\.(json|md)$/i, 6);
    const optionalSources = [];
    const sourcePaths = [options[joinPieces('trans', 'cript')], options.source, options.file].filter(Boolean).map(item => path.resolve(root, String(item)));
    for (const sourcePath of sourcePaths.slice(0, 3)) {
        const tail = await readBoundedTail(sourcePath, maxTailBytes);
        optionalSources.push({
            path: normalizePath(sourcePath),
            sizeBytes: tail.sizeBytes,
            modifiedAt: tail.modifiedAt,
            readBytes: tail.readBytes,
            truncated: tail.truncated,
            redactedTailLines: summarizeResumeTail(tail.text, maxLines, maxLineChars),
            sha256Tail: crypto.createHash('sha256').update(tail.text).digest('hex'),
        });
    }
    const brief = {
        version: 1,
        kind: 'resume.brief',
        id: `resume-brief-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
        createdAt: new Date().toISOString(),
        workspace: normalizePath(root),
        note: String(options.note || `Bounded Harmony/Copilot/HarmonyHub resume brief. Designed to avoid whole-${joinPieces('trans', 'cript')} reads and invalid string length failures.`),
        limits: { maxTailBytes, maxLines, maxLineChars, continuityEntries: continuity.entries.length, handoffFiles: handoffs.length, floatingConversationFiles: floatingConversations.length },
        sourcesChecked: [
            { label: 'continuity tail', path: normalizePath(continuity.path), entries: continuity.entries.length },
            { label: 'handoffs newest files', path: normalizePath(harmonyPath(root, 'handoffs')), files: handoffs.length },
            { label: 'floating chat newest files', path: normalizePath(harmonyPath(root, 'floating-chat', 'conversations')), files: floatingConversations.length },
            { label: 'diagnostics newest files', path: normalizePath(harmonyPath(root, 'diagnostics')), files: diagnostics.length },
            ...optionalSources.map(source => ({ label: 'optional bounded source tail', path: source.path, readBytes: source.readBytes, truncated: source.truncated })),
        ],
        recoveredState: {
            latestContinuity: continuity.entries.slice(0, 8).map(entry => ({ ts: entry.ts, kind: entry.kind, summary: entry.summary, id: entry.id, nextActions: entry.nextActions })),
            latestHandoffs: handoffs,
            latestFloatingConversations: floatingConversations,
            latestDiagnostics: diagnostics,
            optionalSources,
        },
        nextSeatInstructions: [
            'Read this resume brief first, then only bounded nearby files needed for the current task.',
            `Do not parse whole Copilot/Harmony ${joinPieces('trans', 'cripts')} by default; use max-tail-bytes and source timestamps to disambiguate.`,
            `Use vscode_askQuestions if multiple ${joinPieces('trans', 'cript')}/source tails plausibly match the requested continuation.`,
            'Do not expose provider key values; use .env, VS Code Secret Storage, or Windows DPAPI import paths.',
            'Treat package-only VSIX checkpoints as not installed until install receipts prove otherwise.',
        ],
    };
    return brief;
}

function formatResumeBriefMarkdown(brief, jsonPath) {
    const latestContinuity = brief.recoveredState.latestContinuity || [];
    const sourceRows = (brief.sourcesChecked || []).map(source => `- ${source.label}: ${source.path || ''}${source.entries !== undefined ? ` (${source.entries} entr${source.entries === 1 ? 'y' : 'ies'})` : ''}${source.files !== undefined ? ` (${source.files} file${source.files === 1 ? '' : 's'})` : ''}${source.readBytes !== undefined ? ` (${source.readBytes} bytes read${source.truncated ? ', tail only' : ''})` : ''}`);
    return [
        '# Harmony Resume Brief',
        '',
        `Created: ${brief.createdAt}`,
        `Workspace: ${brief.workspace}`,
        `JSON: ${normalizePath(jsonPath)}`,
        '',
        '## Limits',
        '',
        `- Tail cap: ${brief.limits.maxTailBytes} bytes`,
        `- Tail lines: ${brief.limits.maxLines}`,
        `- Line cap: ${brief.limits.maxLineChars} chars`,
        '',
        '## Sources Checked',
        '',
        ...(sourceRows.length ? sourceRows : ['- none']),
        '',
        '## Latest Continuity',
        '',
        ...(latestContinuity.length ? latestContinuity.map(entry => `- ${entry.ts || '?'} | ${entry.kind || '?'} | ${entry.summary || entry.id || '(no summary)'}`) : ['- none']),
        '',
        '## Next Seat Instructions',
        '',
        ...(brief.nextSeatInstructions || []).map(item => `- ${item}`),
        '',
        '## Optional Source Tail Preview',
        '',
        ...((brief.recoveredState.optionalSources || []).flatMap(source => [
            `### ${source.path}`,
            '',
            ...(source.redactedTailLines.length ? source.redactedTailLines.map(line => `- ${line}`) : ['- no non-empty tail lines captured']),
            '',
        ])),
    ].join(os.EOL);
}

async function commandResumeBrief(root, subcommand, options) {
    if (subcommand && subcommand !== 'create' && subcommand !== 'latest') throw new Error('resume-brief supports: create, latest');
    const dir = harmonyPath(root, 'resume-briefs');
    await fsp.mkdir(dir, { recursive: true });
    if (subcommand === 'latest') {
        const latest = (await newestFiles(dir, /\.json$/i, 1))[0];
        if (!latest) {
            if (options.json) printJson({ status: 'missing', path: normalizePath(dir) });
            else process.stdout.write(`No resume briefs found in ${normalizePath(dir)}${os.EOL}`);
            return 1;
        }
        if (options.json) printJson(await readJson(latest.path) || latest);
        else process.stdout.write(`Latest resume brief: ${latest.path}${os.EOL}`);
        return 0;
    }
    const brief = await collectResumeBrief(root, options);
    const jsonPath = path.join(dir, `${brief.id}.json`);
    const markdownPath = path.join(dir, `${brief.id}.md`);
    await fsp.writeFile(jsonPath, JSON.stringify(brief, null, 2), 'utf8');
    await fsp.writeFile(markdownPath, formatResumeBriefMarkdown(brief, jsonPath), 'utf8');
    await appendLedgerEntry(root, { kind: 'resume.brief', label: 'Bounded resume brief created', status: 'completed', reportPath: normalizePath(jsonPath), markdownPath: normalizePath(markdownPath), sources: brief.sourcesChecked.length });
    if (options.json) printJson({ ...brief, jsonPath: normalizePath(jsonPath), markdownPath: normalizePath(markdownPath) });
    else process.stdout.write(`Harmony resume brief created:${os.EOL}Markdown: ${normalizePath(markdownPath)}${os.EOL}JSON: ${normalizePath(jsonPath)}${os.EOL}`);
    return 0;
}

async function seatHandoffVsixArtifacts(version) {
    const names = (await readDirSafe(extensionRoot())).filter(name => /^harmony-extension-.+\.vsix$/i.test(name));
    const artifacts = [];
    for (const name of names) {
        const filePath = path.join(extensionRoot(), name);
        const stat = await fsp.stat(filePath).catch(() => undefined);
        if (!stat?.isFile()) continue;
        const match = /^harmony-extension-(.+)\.vsix$/i.exec(name);
        artifacts.push({
            name,
            version: match?.[1] || 'unknown',
            path: normalizePath(filePath),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            sha256: crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex'),
            currentVersion: match?.[1] === version,
        });
    }
    artifacts.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    return artifacts.slice(0, 8);
}

function summarizeReportFile(item) {
    if (!item) return undefined;
    return {
        path: normalizePath(item.path),
        id: item.json?.id,
        kind: item.json?.kind,
        status: item.json?.status,
        createdAt: item.json?.createdAt || item.json?.generatedAt || item.json?.finishedAt,
        checks: Array.isArray(item.json?.checks) ? item.json.checks.length : undefined,
    };
}

async function collectSeatHandoffBundle(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const git = await collectGitSafetyMetadata(root);
    const continuity = await readContinuity(root, Number(options.limit || 5));
    const vsixArtifacts = await seatHandoffVsixArtifacts(version);
    const previousVsix = vsixArtifacts.find(item => item.version !== version);
    const installedEditors = await Promise.all([
        scanInstalledHarmonyExtension('vscode', version),
        scanInstalledHarmonyExtension('cursor', version),
    ]);
    const latestRelease = summarizeReportFile(await latestJsonFile(harmonyPath(root, 'release'), `release-receipt-${version}-`));
    const latestInstallDryRun = summarizeReportFile(await latestJsonFile(harmonyPath(root, 'release'), `install-dry-run-${version}-`));
    const latestPrivacy = summarizeReportFile(await latestJsonFile(harmonyPath(root, 'privacy-scan'), 'privacy-scan-'));
    const latestOom = summarizeReportFile(await latestJsonFile(harmonyPath(root, 'diagnostics'), 'oom-diagnostics-'));
    const currentVsix = vsixArtifacts.find(item => item.currentVersion);
    return {
        version: 1,
        kind: 'seat.handoff',
        id: `seat-handoff-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
        createdAt: new Date().toISOString(),
        workspace: normalizePath(root),
        sourceRoot: normalizePath(extensionRoot()),
        package: { name: pkg.name, publisher: pkg.publisher, version },
        git: {
            insideWorkTree: git.insideWorkTree,
            branch: git.branch,
            head: git.head,
            statusCount: git.statusCount || 0,
            status: (git.status || []).slice(0, 50),
            diffStats: (git.diffStats || []).slice(0, 25),
            stagedDiffStats: (git.stagedDiffStats || []).slice(0, 25),
        },
        installedEditors,
        artifacts: {
            currentVsix,
            previousVsix,
            vsixArtifacts,
            latestRelease,
            latestInstallDryRun,
            latestPrivacy,
            latestOom,
        },
        continuity: {
            path: normalizePath(continuity.path),
            entries: continuity.entries.slice(0, 5).map(entry => ({ ts: entry.ts, kind: entry.kind, summary: entry.summary, id: entry.id, nextActions: entry.nextActions })),
        },
        requiredToolsForNextSeat: [
            'terminal for npm/node/git verification commands',
            'bounded file read for this handoff JSON/Markdown and nearby source files',
            'patch/edit tool for source changes only after a focused validation target is known',
            'vscode_askQuestions for any ambiguous branch, rollback, install, or live-provider decision',
        ],
        resumeSourcesInOrder: [
            'this seat handoff Markdown/JSON',
            '.harmony/resume-briefs newest files',
            '.harmony/continuity/ledger.jsonl tail',
            '.harmony/handoffs newest files',
            '.harmony/floating-chat/conversations newest files',
            `bounded Copilot ${joinPieces('trans', 'cript')} tail only if needed`,
        ],
        selfUpdateCommands: {
            packageOnlyCheckpoint: 'npm run self-update:checkpoint',
            createSeatHandoff: 'npm run self-update:handoff',
            createResumeBrief: 'npm run self-update:resume-brief',
            installBothEditors: 'npm run install:vsix:both',
            finalReceipt: `node bin/harmony-cli.js release-receipt --vsix harmony-extension-${version}.vsix`,
        },
        rollbackPlan: {
            posture: 'manual-reviewed, reversible-first',
            sourceRollback: git.statusCount
                ? 'uncommitted WIP: inspect git diff first; restore only reviewed files or revert the future release commit after it exists'
                : git.head ? `git revert --no-edit ${git.head}` : 'git revert the release commit after reviewing git status',
            packageRollback: previousVsix ? `node scripts/install-vsix.js --editor both --vsix ${previousVsix.name}` : 'previous VSIX not found in source root; use backup VSIX or rebuild the desired version first',
            firstCheck: 'git status --short',
            notes: [
                'Do not run destructive git reset/checkout/clean for handoff rollback.',
                'Install rollback still requires editor reload before the older extension host is active.',
                'This handoff writes only local .harmony files and operation ledger entries.',
            ],
        },
    };
}

function formatSeatHandoffMarkdown(bundle, jsonPath) {
    const lines = [
        '# Harmony Seat Handoff Bundle',
        '',
        `Created: ${bundle.createdAt}`,
        `Workspace: ${bundle.workspace}`,
        `Source root: ${bundle.sourceRoot}`,
        `Package: ${bundle.package.publisher}.${bundle.package.name}@${bundle.package.version}`,
        `JSON: ${normalizePath(jsonPath)}`,
        '',
        '## Current State',
        '',
        `- Git branch/head: ${bundle.git.branch || '?'} / ${bundle.git.head || '?'}`,
        `- Git status rows: ${bundle.git.statusCount}`,
        `- VSIX: ${bundle.artifacts.currentVsix?.name || 'missing'}`,
        `- Latest release receipt: ${bundle.artifacts.latestRelease?.path || 'missing'}`,
        `- Latest OOM diagnostics: ${bundle.artifacts.latestOom?.path || 'missing'}`,
        '',
        '## Resume Sources',
        '',
        ...bundle.resumeSourcesInOrder.map((item, index) => `${index + 1}. ${item}`),
        '',
        '## Tools The Next Seat Needs',
        '',
        ...bundle.requiredToolsForNextSeat.map(item => `- ${item}`),
        '',
        '## Self-Update Commands',
        '',
        `- Package-only checkpoint: \`${bundle.selfUpdateCommands.packageOnlyCheckpoint}\``,
        `- Create another handoff: \`${bundle.selfUpdateCommands.createSeatHandoff}\``,
        `- Create bounded resume brief: \`${bundle.selfUpdateCommands.createResumeBrief}\``,
        `- Install both editors: \`${bundle.selfUpdateCommands.installBothEditors}\``,
        `- Final receipt: \`${bundle.selfUpdateCommands.finalReceipt}\``,
        '',
        '## Rollback Plan',
        '',
        `- First check: \`${bundle.rollbackPlan.firstCheck}\``,
        `- Source rollback: \`${bundle.rollbackPlan.sourceRollback}\``,
        `- Package rollback: \`${bundle.rollbackPlan.packageRollback}\``,
        ...bundle.rollbackPlan.notes.map(item => `- ${item}`),
        '',
        '## Recent Continuity',
        '',
        bundle.continuity.entries.length ? bundle.continuity.entries.map(entry => `- ${entry.ts || '?'} | ${entry.kind || '?'} | ${entry.summary || entry.id || '(no summary)'}`).join('\n') : '- No continuity entries found.',
        '',
        '## Privacy',
        '',
        `This bundle contains paths, report metadata, command text, git summary rows, and continuity summaries. It does not include provider key values, hidden reasoning, or full ${joinPieces('trans', 'cript')} dumps.`,
        '',
    ];
    return lines.join('\n');
}

async function commandSeatHandoff(root, subcommand, options) {
    if (subcommand && subcommand !== 'create') throw new Error('seat-handoff supports: create');
    const bundle = await collectSeatHandoffBundle(root, options);
    const dir = harmonyPath(root, 'handoffs');
    await fsp.mkdir(dir, { recursive: true });
    const jsonPath = path.join(dir, `${bundle.id}.json`);
    const markdownPath = path.join(dir, `${bundle.id}.md`);
    await fsp.writeFile(jsonPath, JSON.stringify({ ...bundle, reportPath: normalizePath(jsonPath), markdownPath: normalizePath(markdownPath) }, null, 2), 'utf8');
    await fsp.writeFile(markdownPath, formatSeatHandoffMarkdown(bundle, jsonPath), 'utf8');
    await appendLedgerEntry(root, { kind: 'seat.handoff', label: 'Seat handoff bundle created', status: 'completed', reportPath: normalizePath(jsonPath), markdownPath: normalizePath(markdownPath), version: bundle.package.version, gitHead: bundle.git.head, gitStatusCount: bundle.git.statusCount });
    if (options.json) printJson({ reportPath: normalizePath(jsonPath), markdownPath: normalizePath(markdownPath), bundle });
    else process.stdout.write(`Harmony seat handoff created:${os.EOL}Markdown: ${normalizePath(markdownPath)}${os.EOL}JSON: ${normalizePath(jsonPath)}${os.EOL}`);
    return 0;
}

async function commandOperations(root, subcommand, options) {
        const ledger = await readLedger(root, Number(options.limit || 20));
        if (!subcommand || subcommand === 'list') {
            if (options.json) printJson(ledger);
            else {
                process.stdout.write(`Harmony operations ledger: ${normalizePath(ledger.path)}${os.EOL}`);
                if (!ledger.entries.length) {
                    process.stdout.write('No operation entries found.' + os.EOL);
                    return 0;
                }
                for (const entry of ledger.entries) {
                    process.stdout.write(`- ${entry.timestamp || '?'} | ${entry.status || '?'} | ${entry.operationId || entry.id || '?'} | ${entry.label || entry.kind || '?'}${os.EOL}`);
                }
            }
            return 0;
        }
        if (subcommand === 'show') {
            const id = operationIdFromOptions(options);
            if (!id) throw new Error('operations show requires --id <operation-id-or-entry-id>');
            const entry = ledger.entries.find(item => item.id === id) || ledger.entries.find(item => item.operationId === id);
            if (!entry) throw new Error(`operation not found: ${id}`);
            if (options.json) printJson(entry);
            else process.stdout.write(JSON.stringify(entry, null, 2) + os.EOL);
            return 0;
        }
        if (subcommand === 'start') {
            const operationId = String(options['operation-id'] || options.id || `cli-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`).trim();
            const result = await appendLedgerEntry(root, {
                kind: String(options.kind || 'manual.operation'),
                label: String(options.label || options.kind || 'Manual Harmony CLI operation'),
                status: 'started',
                operationId,
                resources: parseResourceList(options.resource || options.resources),
            });
            if (options.json) printJson(result);
            else process.stdout.write(`Operation started: ${operationId}${os.EOL}`);
            return 0;
        }
        if (subcommand === 'finish' || subcommand === 'fail') {
            const operationId = operationIdFromOptions(options);
            if (!operationId) throw new Error(`operations ${subcommand} requires --operation-id <id>`);
            const status = subcommand === 'finish' ? 'completed' : 'failed';
            const result = await appendLedgerEntry(root, {
                kind: `operation.${subcommand}`,
                label: String(options.label || `Operation ${status}: ${operationId}`),
                status,
                operationId,
                result: options.result ? String(options.result) : undefined,
                error: options.error ? String(options.error) : undefined,
            });
            if (options.json) printJson(result);
            else process.stdout.write(`Operation ${status}: ${operationId}${os.EOL}`);
            return 0;
        }
        throw new Error('operations supports: list, show, start, finish, fail');
}

async function commandTools(options) {
    const pkg = await readPackage();
    const tools = (((pkg.contributes || {}).languageModelTools) || []).filter(tool => String(tool.name || '').startsWith('harmony_'));
    if (options.json) {
        printJson({ version: pkg.version || 'unknown', count: tools.length, tools });
        return;
    }
    process.stdout.write(`Harmony tools (${tools.length}) from package ${pkg.version || 'unknown'}${os.EOL}`);
    for (const tool of tools) {
        const tags = Array.isArray(tool.tags) ? tool.tags.join(', ') : '';
        process.stdout.write(`- ${tool.name}${tags ? ` [${tags}]` : ''}: ${tool.displayName || ''}${os.EOL}`);
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderDashboard(state) {
    const hubSnapshot = state.hubSupervisor.response || {};
    const healthItems = [...state.health.blocks.map(text => ({ kind: 'block', text })), ...state.health.warnings.map(text => ({ kind: 'warn', text }))];
    const healthRows = healthItems.map(item => `<li><strong>${escapeHtml(item.kind.toUpperCase())}</strong> ${escapeHtml(item.text)}</li>`).join('') || '<li><strong>OK</strong> No coordination warnings detected in this snapshot.</li>';
    const surfaceRows = state.supervisor.heartbeats.map(item => `<tr><td>${escapeHtml(item.surface || '?')}</td><td>${escapeHtml(item.pid || '?')}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.processAlive ? 'yes' : 'no')}</td><td>${escapeHtml(formatDuration(item.ageMs))}</td><td>${escapeHtml(item.label || '')}</td></tr>`).join('') || '<tr><td colspan="6">No heartbeats yet.</td></tr>';
    const lockRows = state.locks.map(item => `<tr><td>${escapeHtml(item.file)}</td><td>${escapeHtml(item.operation || item.resource || 'unknown')}</td><td>${escapeHtml(item.expiresAt || '')}</td><td>${escapeHtml(item.expired === undefined ? '?' : item.expired ? 'yes' : 'no')}</td></tr>`).join('') || '<tr><td colspan="4">No lock files.</td></tr>';
    const hubLockRows = (hubSnapshot.locks || []).map(item => `<tr><td>${escapeHtml(item.file)}</td><td>${escapeHtml(item.lock?.resource || '?')}</td><td>${escapeHtml(item.lock?.operation || '?')}</td><td>${escapeHtml(item.expired ? 'yes' : 'no')}</td></tr>`).join('') || '<tr><td colspan="4">No Hub lock records.</td></tr>';
    const operationRows = state.operationLedger.entries.slice(0, 10).map(item => `<li>${escapeHtml(item.timestamp || '?')} | ${escapeHtml(item.status || '?')} | ${escapeHtml(item.label || item.kind || '?')}</li>`).join('') || '<li>No operation entries.</li>';
    const askRows = state.terminalAskReceipts.map(item => `<tr><td>${escapeHtml(item.kind || '?')}</td><td>${escapeHtml(item.status || '?')}</td><td>${escapeHtml(item.createdAt || '?')}</td><td>${escapeHtml(item.latency?.durationMs !== undefined ? providerLatencySummary(Number(item.latency.durationMs)) : '')}</td><td>${escapeHtml(item.prompt || '').slice(0, 160)}</td></tr>`).join('') || '<tr><td colspan="5">No terminal ask receipts.</td></tr>';
    const providerRows = state.providerStatus.map(item => `<tr><td>${escapeHtml(item.provider)}</td><td>${escapeHtml(item.configured ? 'yes' : 'no')}</td><td>${escapeHtml(item.credentialName || '')}</td><td>${escapeHtml(item.executable ? 'yes' : 'not yet')}</td><td>${escapeHtml(item.defaultModel || '')}</td><td>${escapeHtml(item.lastLatencyMs !== undefined ? providerLatencySummary(Number(item.lastLatencyMs)) : '')}</td></tr>`).join('') || '<tr><td colspan="6">No provider status available.</td></tr>';
    const configuredProviders = state.providerStatus.filter(item => item.configured).length;
    const policy = state.outsidePolicy || {};
    const permissions = policy.permissions || {};
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harmony Supervisor Dashboard</title>
<style>
:root{--bg:#f6f2ea;--ink:#23201b;--muted:#6e675e;--line:#d8cfc0;--accent:#166a5a;--warn:#9b4c16;--danger:#8f1d1d;--panel:#fffaf0}
*{box-sizing:border-box}body{margin:0;font-family:Georgia,'Times New Roman',serif;background:linear-gradient(135deg,#f6f2ea,#e7f0ea);color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:32px}h1{font-size:34px;margin:0 0 8px}h2{font-size:20px;margin:24px 0 10px}.meta{color:var(--muted);margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}.metric strong{display:block;font-size:24px;color:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{text-align:left;border-bottom:1px solid var(--line);padding:9px 10px}th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0}
section{margin-top:22px}code{background:#eee5d7;padding:2px 5px;border-radius:4px}ul{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:0;padding:14px 14px 14px 30px}
.health{border:1px solid var(--line);border-left:6px solid var(--accent);background:var(--panel);border-radius:8px;padding:14px;margin:18px 0}.health.warn{border-left-color:var(--warn)}.health.block{border-left-color:var(--danger)}.health strong{color:var(--accent)}.health.warn strong{color:var(--warn)}.health.block strong{color:var(--danger)}
@media(max-width:760px){main{padding:20px}.grid{grid-template-columns:1fr 1fr}table{font-size:13px}}
</style>
</head>
<body><main>
<h1>Harmony Supervisor Dashboard</h1>
<p class="meta">Snapshot generated ${escapeHtml(state.generatedAt)} for <code>${escapeHtml(state.workspace)}</code>. Refresh with <code>node bin/harmony-cli.js ui</code>.</p>
<div class="health ${escapeHtml(state.health.status)}"><strong>Health: ${escapeHtml(state.health.status.toUpperCase())}</strong><ul>${healthRows}</ul></div>
<div class="grid">
<div class="metric"><span>Hub</span><strong>${state.hub.online ? 'online' : 'offline'}</strong></div>
<div class="metric"><span>Active surfaces</span><strong>${state.supervisor.active}</strong></div>
<div class="metric"><span>Locks</span><strong>${state.locks.length}</strong></div>
<div class="metric"><span>Managed processes</span><strong>${state.managedProcesses.length}</strong></div>
<div class="metric"><span>Hub locks</span><strong>${(hubSnapshot.locks || []).length}</strong></div>
<div class="metric"><span>Outside policy</span><strong>${escapeHtml(policy.mode || 'missing')}</strong></div>
<div class="metric"><span>Terminal asks</span><strong>${state.terminalAskReceipts.length}</strong></div>
<div class="metric"><span>CLI providers</span><strong>${configuredProviders}/${state.providerStatus.length}</strong></div>
</div>
<section><h2>Outside-VS Policy</h2><table><thead><tr><th>Permission</th><th>Allowed</th></tr></thead><tbody>${Object.keys(permissions).map(key => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(permissions[key] ? 'yes' : 'no')}</td></tr>`).join('') || '<tr><td colspan="2">No policy file found.</td></tr>'}</tbody></table></section>
<section><h2>CLI Provider Status</h2><table><thead><tr><th>Provider</th><th>Configured</th><th>Credential Source</th><th>Executable</th><th>Default Model</th><th>Last Latency</th></tr></thead><tbody>${providerRows}</tbody></table></section>
<section><h2>Surfaces</h2><table><thead><tr><th>Surface</th><th>PID</th><th>Status</th><th>Alive</th><th>Age</th><th>Label</th></tr></thead><tbody>${surfaceRows}</tbody></table></section>
<section><h2>Locks</h2><table><thead><tr><th>File</th><th>Operation</th><th>Expires</th><th>Expired</th></tr></thead><tbody>${lockRows}</tbody></table></section>
<section><h2>Hub Locks</h2><table><thead><tr><th>File</th><th>Resource</th><th>Operation</th><th>Expired</th></tr></thead><tbody>${hubLockRows}</tbody></table></section>
<section><h2>Recent Operations</h2><ul>${operationRows}</ul></section>
<section><h2>Terminal Ask Receipts</h2><table><thead><tr><th>Kind</th><th>Status</th><th>Created</th><th>Latency</th><th>Prompt</th></tr></thead><tbody>${askRows}</tbody></table></section>
<section><h2>Scaffold Notes</h2><ul><li>This is a generated snapshot, not the final live Tauri window.</li><li>The companion JSON state file beside this HTML is the future floating UI handoff surface.</li><li>Agentic outside-VS actions remain blocked until policy and Hub locks explicitly allow them.</li></ul></section>
</main></body></html>`;
}

function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function renderLiveDashboardShell(initialState, options) {
    const refreshMs = Math.max(1000, Number(options.refresh || 2000));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harmony Floating Shell</title>
<style>
:root{--bg:#101411;--panel:#f8f3e8;--ink:#1f251f;--muted:#6f766e;--line:#d4c8b6;--accent:#1d7663;--warn:#aa611d;--danger:#b02a32;--chip:#e8efe6}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Optima,Candara,'Segoe UI',sans-serif;background:radial-gradient(circle at 20% 10%,#dfeee4 0,#f6f1e7 34%,#d7e2dc 100%);color:var(--ink)}
main{max-width:1180px;margin:0 auto;padding:24px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.title h1{font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1;margin:0 0 8px}.title p{margin:0;color:var(--muted)}
.badge{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(29,118,99,.35);background:rgba(248,243,232,.76);border-radius:999px;padding:8px 12px;font-size:13px}.dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(29,118,99,.14)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric,.panel{background:rgba(248,243,232,.9);border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 32px rgba(31,37,31,.08)}.metric{padding:14px}.metric span{display:block;color:var(--muted);font-size:13px}.metric strong{display:block;font-family:Georgia,'Times New Roman',serif;font-size:26px;margin-top:4px;color:var(--accent)}
.panel{margin-top:14px;padding:16px}.panel h2{font-size:17px;margin:0 0 10px}.health{border-left:6px solid var(--accent)}.health.warn{border-left-color:var(--warn)}.health.block{border-left-color:var(--danger)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid var(--line);padding:8px 6px;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:0}tr:last-child td{border-bottom:0}.list{display:grid;gap:7px;margin:0;padding:0;list-style:none}.list li{background:var(--chip);border-radius:6px;padding:8px 10px}.muted{color:var(--muted)}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}button{border:1px solid var(--accent);background:var(--accent);color:white;border-radius:6px;padding:8px 12px;font:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:default}code{background:#efe7d8;border-radius:4px;padding:2px 5px}
@media(max-width:860px){main{padding:16px}.top{display:block}.badge{margin-top:12px}.grid{grid-template-columns:1fr 1fr}table{font-size:13px}}
@media(max-width:560px){.grid{grid-template-columns:1fr}.title h1{font-size:28px}}
</style>
</head>
<body>
<main>
<div class="top"><div class="title"><h1>Harmony Floating Shell</h1><p id="workspace"></p></div><div class="toolbar"><span class="badge"><span class="dot"></span><span id="liveLabel">live read-only</span></span><button id="refreshButton" type="button">Refresh</button></div></div>
<section id="health" class="panel health"></section>
<div class="grid" id="metrics"></div>
<section class="panel"><h2>Surfaces</h2><div id="surfaces"></div></section>
<section class="panel"><h2>Operations</h2><ul class="list" id="operations"></ul></section>
<section class="panel"><h2>Locks</h2><div id="locks"></div></section>
<section class="panel"><h2>Providers</h2><div id="providers"></div></section>
<section class="panel"><h2>Snapshots</h2><div id="snapshots"></div></section>
<section class="panel"><h2>Swarm Safety</h2><div id="swarmSafety"></div></section>
</main>
<script>
const initialState = ${jsonForScript(initialState)};
const refreshMs = ${JSON.stringify(refreshMs)};
const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const count = value => Array.isArray(value) ? value.length : 0;
function metric(label, value) { return '<div class="metric"><span>'+h(label)+'</span><strong>'+h(value)+'</strong></div>'; }
function table(headers, rows, empty) {
  if (!rows.length) return '<p class="muted">'+h(empty)+'</p>';
  return '<table><thead><tr>'+headers.map(item => '<th>'+h(item)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>';
}
function render(state) {
  document.getElementById('workspace').innerHTML = '<code>'+h(state.workspace)+'</code> · generated '+h(state.generatedAt);
  const health = state.health || { status:'ok', warnings:[], blocks:[] };
  const healthItems = [...(health.blocks || []).map(text => ['Block', text]), ...(health.warnings || []).map(text => ['Warn', text])];
  const healthNode = document.getElementById('health');
  healthNode.className = 'panel health '+h(health.status || 'ok');
  healthNode.innerHTML = '<h2>Health: '+h(String(health.status || 'ok').toUpperCase())+'</h2>' + (healthItems.length ? '<ul class="list">'+healthItems.map(item => '<li><strong>'+h(item[0])+'</strong> '+h(item[1])+'</li>').join('')+'</ul>' : '<p class="muted">No coordination warnings detected.</p>');
  const hubSnapshot = state.hubSupervisor?.response || {};
  const configuredProviders = (state.providerStatus || []).filter(item => item.configured).length;
  document.getElementById('metrics').innerHTML = [
    metric('Hub', state.hub?.online ? 'online' : 'offline'),
    metric('Active surfaces', state.supervisor?.active || 0),
    metric('Local locks', count(state.locks)),
    metric('Hub locks', count(hubSnapshot.locks)),
    metric('Managed processes', count(state.managedProcesses)),
    metric('Operations', count(state.operationLedger?.entries)),
    metric('Policy', state.outsidePolicy?.mode || 'missing'),
        metric('CLI providers', configuredProviders + '/' + count(state.providerStatus)),
        metric('Snapshots', count(state.snapshots)),
        metric('Safety switches', (state.swarmSafetySwitches || []).filter(item => item.failClosed).length + '/' + count(state.swarmSafetySwitches))
  ].join('');
  const surfaceRows = (state.supervisor?.heartbeats || []).map(item => '<tr><td>'+h(item.surface || '?')+'</td><td>'+h(item.pid || '?')+'</td><td>'+h(item.status || '?')+'</td><td>'+h(item.processAlive ? 'yes' : 'no')+'</td><td>'+h(item.label || '')+'</td></tr>');
  document.getElementById('surfaces').innerHTML = table(['Surface','PID','Status','Alive','Label'], surfaceRows, 'No active surface heartbeats yet.');
  const operationRows = (state.operationLedger?.entries || []).slice(0, 8).map(item => '<li>'+h(item.timestamp || '?')+' · '+h(item.status || '?')+' · '+h(item.label || item.kind || '?')+'</li>');
  document.getElementById('operations').innerHTML = operationRows.join('') || '<li>No operation entries.</li>';
  const lockRows = (state.locks || []).map(item => '<tr><td>'+h(item.file)+'</td><td>'+h(item.operation || item.resource || '?')+'</td><td>'+h(item.expired ? 'yes' : 'no')+'</td></tr>');
  document.getElementById('locks').innerHTML = table(['File','Operation','Expired'], lockRows, 'No local lock files.');
  const providerRows = (state.providerStatus || []).map(item => '<tr><td>'+h(item.provider)+'</td><td>'+h(item.configured ? 'yes' : 'no')+'</td><td>'+h(item.executable ? 'yes' : 'not yet')+'</td><td>'+h(item.defaultModel || '')+'</td></tr>');
  document.getElementById('providers').innerHTML = table(['Provider','Configured','Executable','Default Model'], providerRows, 'No provider status available.');
    const snapshotRows = (state.snapshots || []).map(item => '<tr><td>'+h(item.id || '?')+'</td><td>'+h(item.createdAt || '')+'</td><td>'+h(item.fileCount || 0)+'</td><td>'+h(item.copied || 0)+'</td><td>'+h(item.reason || '')+'</td></tr>');
    document.getElementById('snapshots').innerHTML = table(['Snapshot','Created','Files','Copied','Reason'], snapshotRows, 'No snapshots recorded.');
    const switchRows = (state.swarmSafetySwitches || []).map(item => '<tr><td>'+h(item.label || item.key)+'</td><td>'+h(item.defaultValue === false ? 'off' : String(item.defaultValue))+'</td><td>'+h(item.failClosed ? 'yes' : 'no')+'</td></tr>');
    document.getElementById('swarmSafety').innerHTML = table(['Switch','Default','Fail closed'], switchRows, 'No swarm safety switch metadata available.');
  document.getElementById('liveLabel').textContent = 'live read-only · '+new Date().toLocaleTimeString();
}
async function refresh() {
  const button = document.getElementById('refreshButton');
  button.disabled = true;
  try {
    const response = await fetch('/state', { cache: 'no-store' });
    render(await response.json());
  } catch (error) {
    document.getElementById('liveLabel').textContent = 'disconnected';
  } finally {
    button.disabled = false;
  }
}
document.getElementById('refreshButton').addEventListener('click', refresh);
render(initialState);
setInterval(refresh, refreshMs);
</script>
</body>
</html>`;
}

function sendHttp(res, status, contentType, body, headOnly = false) {
    const text = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
    res.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': text.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    if (headOnly) res.end();
    else res.end(text);
}

function sendJsonHttp(res, status, payload, headOnly = false) {
    sendHttp(res, status, 'application/json; charset=utf-8', JSON.stringify(payload, null, 2), headOnly);
}

function allowedUiCorsOrigin(origin) {
    if (!origin || origin === 'null') return '';
    try {
        const parsed = new URL(origin);
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (isLoopbackUiHost(parsed.hostname) || parsed.hostname === 'tauri.localhost')) return parsed.origin;
        if (parsed.protocol === 'tauri:' && isLoopbackUiHost(parsed.hostname)) return origin;
    } catch {
        return '';
    }
    return '';
}

function applyUiCorsHeaders(req, res) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return { hasOrigin: false, allowed: true };
    const allowedOrigin = allowedUiCorsOrigin(origin);
    if (!allowedOrigin) return { hasOrigin: true, allowed: false };
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    return { hasOrigin: true, allowed: true };
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', chunk => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(text));
            } catch {
                reject(new Error('Invalid JSON request body'));
            }
        });
        req.on('error', reject);
    });
}

function isLoopbackUiHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function releaseReceiptConfirmation(version) {
    return `CREATE RELEASE RECEIPT ${version}`;
}

function privacyScanConfirmation(version) {
    return `RUN PRIVACY SCAN ${version}`;
}

function diagnosticsConfirmation(version) {
    return `RUN DIAGNOSTICS ${version}`;
}

function snapshotDrillConfirmation(relativePath) {
    return `RUN SNAPSHOT DRILL ${relativePath}`;
}

function policyReportConfirmation(version) {
    return `CREATE POLICY REPORT ${version}`;
}

function brokerProviderReportConfirmation(version) {
    return `CREATE BROKER PROVIDER REPORT ${version}`;
}

function gitSafetyReportConfirmation(version) {
    return `CREATE GIT SAFETY REPORT ${version}`;
}

function terminalCommandReportConfirmation(version) {
    return `CREATE TERMINAL COMMAND REPORT ${version}`;
}

function selfHealingReportConfirmation(version) {
    return `CREATE SELF HEALING REPORT ${version}`;
}

function selfHealingGateConfirmation(version) {
    return `CREATE SELF HEALING EXECUTION GATE ${version}`;
}

function selfHealingPackagePreflightConfirmation(version) {
    return `RUN SELF HEALING PACKAGE PREFLIGHT ${version}`;
}

function nativeLifecycleReportConfirmation(version) {
    return `CREATE NATIVE LIFECYCLE REPORT ${version}`;
}

function nativeLifecyclePreflightConfirmation(version) {
    return `RUN NATIVE LIFECYCLE PREFLIGHT ${version}`;
}

function nativeLifecycleStartGateConfirmation(version) {
    return `CREATE NATIVE LIFECYCLE START GATE ${version}`;
}

function nativeLifecycleStopGateConfirmation(version) {
    return `CREATE NATIVE LIFECYCLE STOP GATE ${version}`;
}

function nativeLifecycleReconnectGateConfirmation(version) {
    return `CREATE NATIVE LIFECYCLE RECONNECT GATE ${version}`;
}

function nativeLifecycleStartPreflightConfirmation(version) {
    return `RUN NATIVE LIFECYCLE START PREFLIGHT ${version}`;
}

function nativeLifecycleDaemonStartConfirmation(contract) {
    return `START NATIVE BACKEND ${String(contract?.commandPlan?.digest || '').slice(0, 12).toUpperCase()}`;
}

function nativeLifecycleWindowOpenConfirmation(contract) {
    return `OPEN NATIVE WINDOW ${String(contract?.windowPlan?.digest || '').slice(0, 12).toUpperCase()}`;
}

function nativeLifecycleStopExecuteConfirmation(contract) {
    return `STOP NATIVE LIFECYCLE ${String(contract?.stopPlan?.digest || '').slice(0, 12).toUpperCase()}`;
}

function nativeLifecycleReconnectExecuteConfirmation(contract) {
    return `RECONNECT NATIVE BACKEND ${String(contract?.reconnectPlan?.digest || '').slice(0, 12).toUpperCase()}`;
}

function nativeLifecycleStopPreflightConfirmation(version) {
    return `RUN NATIVE LIFECYCLE STOP PREFLIGHT ${version}`;
}

function nativeLifecycleReconnectPreflightConfirmation(version) {
    return `RUN NATIVE LIFECYCLE RECONNECT PREFLIGHT ${version}`;
}

function nativeLifecycleRestartPreflightConfirmation(version) {
    return `RUN NATIVE LIFECYCLE RESTART PREFLIGHT ${version}`;
}

function nativeLifecycleRestartExecuteGateConfirmation(version) {
    return `CREATE NATIVE LIFECYCLE RESTART EXECUTE GATE ${version}`;
}

function nativeLifecycleRestartExecuteConfirmation(contract) {
    return `RESTART NATIVE BACKEND ${String(contract?.restartPlan?.digest || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatNoteConfirmation(hash) {
    return `SAVE FLOATING CHAT NOTE ${String(hash || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatTurnConfirmation(hash) {
    return `CAPTURE FLOATING CHAT TURN ${String(hash || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatResponseGateConfirmation(version) {
    return `CREATE FLOATING CHAT RESPONSE GATE ${version}`;
}

function floatingChatResponsePreflightConfirmation(version) {
    return `RUN FLOATING CHAT RESPONSE PREFLIGHT ${version}`;
}

function floatingChatResponseExecuteConfirmation(contract) {
    return `CALL PROVIDER ${String(contract?.provider?.provider || 'UNKNOWN').toUpperCase()} FOR FLOATING CHAT ${String(contract?.prompt?.sha256 || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatToolExecuteConfirmation(contract) {
    return `RUN FLOATING CHAT TOOL ${String(contract?.tool?.name || 'UNKNOWN').toUpperCase()} ${String(contract?.digest || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatToolPreflightConfirmation(contract) {
    return `PREFLIGHT FLOATING CHAT TOOL ${String(contract?.candidate?.tool || 'UNKNOWN').toUpperCase()} ${String(contract?.digest || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatToolLoopPreflightConfirmation(contract) {
    return `PREFLIGHT FLOATING CHAT TOOL LOOP ${String(contract?.digest || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatToolLoopExecuteConfirmation(contract) {
    return `RUN FLOATING CHAT TOOL LOOP STEP ${String(contract?.digest || '').slice(0, 12).toUpperCase()}`;
}

function floatingChatAutonomyNextConfirmation(contract) {
    return `PLAN FLOATING CHAT AUTONOMY NEXT ${String(contract?.digest || '').slice(0, 12).toUpperCase()}`;
}

function autonomyCommitGateConfirmation(version) {
    return `CREATE AUTONOMY COMMIT GATE ${version}`;
}

function outsideToolPolicyGateConfirmation(version) {
    return `CREATE OUTSIDE TOOL POLICY GATE ${version}`;
}

function autonomyDryRunConfirmation(contract) {
    return `RUN AUTONOMY DRY RUN ${String(contract?.version || 'UNKNOWN')} ${String(contract?.digest || '').slice(0, 12).toUpperCase()}`;
}

function nativeActionReceiptDir(root) {
    return harmonyPath(root, 'native-actions');
}

function nativeActionReceiptPath(root, id, phase) {
    if (!/^native-(preview|execute)-[a-z0-9-]+$/.test(id)) {
        const error = new Error('Invalid native action receipt id. Preview again before executing.');
        error.statusCode = 409;
        throw error;
    }
    const dir = path.resolve(nativeActionReceiptDir(root));
    const filePath = path.resolve(dir, `${id}.${phase}.json`);
    if (!filePath.startsWith(dir + path.sep)) {
        const error = new Error('Native action receipt path escaped the workspace receipt directory.');
        error.statusCode = 409;
        throw error;
    }
    return filePath;
}

function nativeActionReceiptSummary(receipt) {
    return {
        id: receipt.id,
        path: receipt.path,
        expiresAt: receipt.expiresAt,
        status: receipt.status,
        ledgerEntryId: receipt.ledgerEntryId,
        previewReceiptId: receipt.previewReceiptId,
    };
}

function nativeActionPreviewFingerprint(preview) {
    return JSON.stringify({
        action: preview?.action,
        version: preview?.version,
        workspace: preview?.workspace,
        vsix: preview?.vsix,
        path: preview?.path,
        target: preview?.target,
        requiredConfirmation: preview?.requiredConfirmation,
        writes: preview?.writes || [],
        checks: preview?.checks || [],
    });
}

async function writeNativeActionPreviewReceipt(root, action, preview, options = {}) {
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + NATIVE_ACTION_PREVIEW_TTL_MS).toISOString();
    const id = `native-preview-${action}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const receiptPath = nativeActionReceiptPath(root, id, 'preview');
    const ledger = await appendLedgerEntry(root, {
        kind: 'native.action.preview',
        label: `Native ${action} preview`,
        status: 'previewed',
        action,
        receiptId: id,
        receiptPath: normalizePath(receiptPath),
        expiresAt,
    });
    const receipt = {
        version: 1,
        kind: 'native.action.preview',
        id,
        action,
        riskLevel: options.riskLevel || 'low',
        status: 'previewed',
        createdAt,
        expiresAt,
        workspace: normalizePath(root),
        path: normalizePath(receiptPath),
        preview,
        ledgerEntryId: ledger.entry.id,
    };
    await fsp.mkdir(path.dirname(receiptPath), { recursive: true });
    await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
    return { ...preview, previewReceipt: nativeActionReceiptSummary(receipt) };
}

async function requireNativeActionPreviewReceipt(root, action, body, currentPreview) {
    const previewReceiptId = String(body?.previewReceiptId || body?.preview_receipt_id || '').trim();
    if (!previewReceiptId) {
        const error = new Error('Preview receipt id required. Preview the native action again before executing.');
        error.statusCode = 409;
        throw error;
    }
    const receiptPath = nativeActionReceiptPath(root, previewReceiptId, 'preview');
    const receipt = await readJson(receiptPath);
    if (!receipt || receipt.kind !== 'native.action.preview') {
        const error = new Error('Preview receipt not found. Preview the native action again before executing.');
        error.statusCode = 409;
        throw error;
    }
    if (receipt.action !== action || normalizePath(receipt.workspace) !== normalizePath(root)) {
        const error = new Error('Preview receipt does not match this action or workspace. Preview again before executing.');
        error.statusCode = 409;
        throw error;
    }
    const expiresAt = Date.parse(receipt.expiresAt || '');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        const error = new Error('Preview receipt is stale. Preview the native action again before executing.');
        error.statusCode = 409;
        throw error;
    }
    if (nativeActionPreviewFingerprint(receipt.preview) !== nativeActionPreviewFingerprint(currentPreview)) {
        const error = new Error('Preview receipt no longer matches current action state. Preview again before executing.');
        error.statusCode = 409;
        throw error;
    }
    if (String(body?.confirmation || '') !== currentPreview.requiredConfirmation) {
        const error = new Error(`Exact confirmation required: ${currentPreview.requiredConfirmation}`);
        error.statusCode = 409;
        throw error;
    }
    return receipt;
}

async function writeNativeActionExecuteReceipt(root, action, previewReceipt, result) {
    const createdAt = new Date().toISOString();
    const id = `native-execute-${action}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const receiptPath = nativeActionReceiptPath(root, id, 'execute');
    const exitCode = Number.isFinite(result?.exitCode) ? result.exitCode : undefined;
    const status = exitCode === 0 ? 'completed' : exitCode === 1 ? 'warning' : 'failed';
    const reportPath = result?.receipt?.reportPath || result?.report?.reportPath || result?.reportPath;
    const ledger = await appendLedgerEntry(root, {
        kind: 'native.action.execute',
        label: `Native ${action} ${status}`,
        status,
        action,
        receiptId: id,
        previewReceiptId: previewReceipt.id,
        receiptPath: normalizePath(receiptPath),
        reportPath,
    });
    const receipt = {
        version: 1,
        kind: 'native.action.execute',
        id,
        action,
        status,
        createdAt,
        workspace: normalizePath(root),
        path: normalizePath(receiptPath),
        previewReceiptId: previewReceipt.id,
        reportPath,
        exitCode,
        ledgerEntryId: ledger.entry.id,
    };
    await fsp.mkdir(path.dirname(receiptPath), { recursive: true });
    await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
    return receipt;
}

async function diagnosticsActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    return {
        action: 'diagnostics',
        version,
        workspace: normalizePath(root),
        requiredConfirmation: diagnosticsConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'diagnostics', 'diagnostic-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
        ],
        checks: [
            'collects cross-surface state without printing provider keys',
            'reports VS Code/Cursor install, Hub, broker, native backend, secret metadata, and safety switch status',
            'private diagnostics report is written under .harmony/diagnostics',
            'operation-ledger entry records report path and recommendation count',
        ],
    };
}

async function privacyScanActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const vsixPath = path.resolve(String(options.vsix || `harmony-extension-${version}.vsix`));
    return {
        action: 'privacy-scan',
        version,
        workspace: normalizePath(root),
        vsix: {
            path: normalizePath(vsixPath),
            exists: await pathExists(vsixPath),
        },
        requiredConfirmation: privacyScanConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'privacy-scan', 'privacy-scan-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
        ],
        checks: [
            'VSIX exists before scan',
            'packaged paths do not include private Harmony state, smoke artifacts, or local secret-store files',
            'packaged text files do not contain likely plaintext API tokens',
            'private scan report is written under .harmony/privacy-scan',
        ],
    };
}

async function releaseReceiptActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const vsixPath = path.resolve(String(options.vsix || `harmony-extension-${version}.vsix`));
    const packageOnly = Boolean(options['package-only'] || options.packageOnly);
    return {
        action: 'release-receipt',
        version,
        workspace: normalizePath(root),
        mode: packageOnly ? 'package-only' : 'installed-release',
        vsix: {
            path: normalizePath(vsixPath),
            exists: await pathExists(vsixPath),
        },
        requiredConfirmation: releaseReceiptConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'release', `release-receipt-${version}-<timestamp>.json`)),
            normalizePath(harmonyPath(root, 'release', 'latest-release-receipt.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
        ],
        checks: [
            'VSIX exists and SHA-256 is recorded',
            'latest privacy scan passed',
            'phase3 smoke report passed',
            'native UI visual smoke passed or browser-unavailable skip is recorded',
            'sidebar provider dropdown smoke passed',
            'source-write execute smoke suite passed with receipt-gated native UI execute surface',
            'terminal/provider/git authority boundaries smoke passed',
            'direct VS Code swarm fixture smoke passed',
            packageOnly ? 'VS Code and Cursor installed extension versions are recorded without failing this package-only checkpoint' : 'VS Code and Cursor installed extension versions match package version',
        ],
    };
}

async function snapshotDrillActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const relativePath = '_harmony_native_snapshot_drill.txt';
    const target = safeWorkspaceRestoreTarget(root, relativePath);
    const targetExists = target.ok ? await pathExists(target.targetPath) : false;
    return {
        action: 'snapshot-drill',
        version,
        workspace: normalizePath(root),
        path: relativePath,
        target: {
            path: target.ok ? normalizePath(target.targetPath) : '',
            allowed: target.ok,
            exists: targetExists,
            reason: target.ok ? undefined : target.reason,
        },
        requiredConfirmation: snapshotDrillConfirmation(relativePath),
        writes: [
            target.ok ? normalizePath(target.targetPath) : normalizePath(path.join(root, relativePath)),
            normalizePath(harmonyPath(root, 'snapshots', 'snapshot-<timestamp>', 'manifest.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-snapshot-drill-<timestamp>.execute.json')),
        ],
        checks: [
            'uses the existing backend snapshot drill implementation',
            'refuses to overwrite the disposable drill file if it already exists',
            'creates a disposable text file, snapshots it, modifies it, restores it, verifies restored content, and cleans it up',
            'writes snapshot.drill and native.action.execute operation-ledger entries',
        ],
    };
}

async function policyReportActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const policyPath = outsidePolicyPath(root);
    const policy = await readOutsidePolicy(root);
    return {
        action: 'policy-report',
        version,
        workspace: normalizePath(root),
        policy: {
            path: normalizePath(policyPath),
            exists: Boolean(policy),
            mode: policy?.mode || 'missing',
            permissions: policy?.permissions || {},
            budgets: policy?.budgets || {},
        },
        requiredConfirmation: policyReportConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'policy-reports', 'policy-report-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-policy-report-<timestamp>.execute.json')),
        ],
        checks: [
            'reads outside-VS policy without editing permissions or budgets',
            'reports missing policy as a warning instead of creating or changing policy',
            'writes a private policy report under .harmony/policy-reports',
            'writes native action preview/execute receipts and operation-ledger entries',
        ],
    };
}

async function commandPolicyReport(root) {
    const policyPath = outsidePolicyPath(root);
    const policy = await readOutsidePolicy(root);
    const payload = {
        version: 1,
        kind: 'policy.report',
        generatedAt: new Date().toISOString(),
        workspace: root,
        policyPath: normalizePath(policyPath),
        exists: Boolean(policy),
        policy: policy || undefined,
        defaultPolicy: policy ? undefined : defaultOutsidePolicy(root),
        notes: policy
            ? ['Report only. No outside-VS policy values were changed.']
            : ['Outside-VS policy is missing. Run policy init from the CLI before enabling outside-VS actions.'],
    };
    const dir = harmonyPath(root, 'policy-reports');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `policy-report-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'policy.report',
        label: policy ? 'Outside-VS policy report' : 'Outside-VS policy missing report',
        status: policy ? 'completed' : 'warning',
        reportPath: normalizePath(outPath),
        policyPath: normalizePath(policyPath),
        exists: Boolean(policy),
        mode: policy?.mode || 'missing',
    });
    return { exitCode: policy ? 0 : 1, report: { ...payload, reportPath: normalizePath(outPath) } };
}

async function brokerProviderReportActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const state = await collectState(root, options);
    return {
        action: 'broker-provider-report',
        version,
        workspace: normalizePath(root),
        summary: {
            brokerPending: Array.isArray(state.broker?.pending) ? state.broker.pending.length : 0,
            brokerResponses: Array.isArray(state.broker?.responses) ? state.broker.responses.length : 0,
            brokerProcessed: Array.isArray(state.broker?.processed) ? state.broker.processed.length : 0,
            configuredProviders: (state.providerStatus || []).filter(item => item.configured).length,
            totalProviders: Array.isArray(state.providerStatus) ? state.providerStatus.length : 0,
            storedSecrets: state.crossSurface?.secretStore?.storedProviders ?? 0,
            totalSecrets: state.crossSurface?.secretStore?.totalProviders ?? 0,
        },
        requiredConfirmation: brokerProviderReportConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'provider-reports', 'broker-provider-report-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-broker-provider-report-<timestamp>.execute.json')),
        ],
        checks: [
            'reads provider status, broker queue metadata, and secret metadata without decrypting or printing keys',
            'does not process broker requests or call providers',
            'does not include prompt, response, ciphertext, or API key values',
            'writes a private broker/provider report under .harmony/provider-reports',
        ],
    };
}

async function commandBrokerProviderReport(root, options) {
    const state = await collectState(root, options);
    const payload = {
        version: 1,
        kind: 'broker-provider.report',
        generatedAt: new Date().toISOString(),
        workspace: root,
        broker: state.broker,
        providerStatus: state.providerStatus,
        providerSecrets: state.providerSecrets,
        crossSurface: {
            broker: state.crossSurface?.broker,
            secretStore: state.crossSurface?.secretStore,
        },
        notes: [
            'Report only. No broker requests were processed and no provider calls were made.',
            'Provider secret values, ciphertext, prompts, and responses are not included.',
        ],
    };
    const dir = harmonyPath(root, 'provider-reports');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `broker-provider-report-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'broker-provider.report',
        label: 'Broker/provider metadata report',
        status: 'completed',
        reportPath: normalizePath(outPath),
        brokerPending: Array.isArray(state.broker?.pending) ? state.broker.pending.length : 0,
        configuredProviders: (state.providerStatus || []).filter(item => item.configured).length,
        storedSecrets: state.crossSurface?.secretStore?.storedProviders ?? 0,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

function runGitReportCommand(root, args, allowedExitCodes = [0, 1, 128]) {
    const result = childProcess.spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
    });
    const exitCode = result.status === null ? 1 : result.status;
    return {
        command: ['git', ...args].join(' '),
        exitCode,
        ok: allowedExitCodes.includes(exitCode) && !result.error,
        stdout: truncateText(result.stdout || '', 12000),
        stderr: truncateText(result.stderr || '', 4000),
        error: result.error ? result.error.message : undefined,
    };
}

async function collectGitSafetyMetadata(root) {
    const insideProbe = runGitReportCommand(root, ['rev-parse', '--is-inside-work-tree']);
    const insideWorkTree = insideProbe.exitCode === 0 && String(insideProbe.stdout || '').trim() === 'true';
    if (!insideWorkTree) {
        return {
            insideWorkTree: false,
            commands: [insideProbe],
            status: [],
            diffStats: [],
            stagedDiffStats: [],
            notes: ['Workspace is not inside a Git work tree. No diff metadata collected.'],
        };
    }
    const branch = runGitReportCommand(root, ['branch', '--show-current']);
    const head = runGitReportCommand(root, ['rev-parse', '--short', 'HEAD']);
    const status = runGitReportCommand(root, ['status', '--short']);
    const diffNameStatus = runGitReportCommand(root, ['diff', '--name-status']);
    const diffStat = runGitReportCommand(root, ['diff', '--stat']);
    const stagedNameStatus = runGitReportCommand(root, ['diff', '--cached', '--name-status']);
    const stagedDiffStat = runGitReportCommand(root, ['diff', '--cached', '--stat']);
    const statusRows = String(status.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const diffStats = String(diffStat.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const stagedDiffStats = String(stagedDiffStat.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const unstagedPaths = String(diffNameStatus.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const stagedPaths = String(stagedNameStatus.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return {
        insideWorkTree: true,
        branch: String(branch.stdout || '').trim() || undefined,
        head: head.exitCode === 0 ? String(head.stdout || '').trim() || undefined : undefined,
        statusCount: statusRows.length,
        unstagedCount: unstagedPaths.length,
        stagedCount: stagedPaths.length,
        status: statusRows,
        unstagedPaths,
        stagedPaths,
        diffStats,
        stagedDiffStats,
        commands: [insideProbe, branch, head, status, diffNameStatus, diffStat, stagedNameStatus, stagedDiffStat],
        notes: [
            'Report only. No git add, commit, checkout, reset, clean, stash, merge, rebase, or push commands were run.',
            'Diff output is stat/name metadata only; patch text is not included.',
        ],
    };
}

async function gitSafetyReportActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const metadata = await collectGitSafetyMetadata(root);
    return {
        action: 'git-safety-report',
        version,
        workspace: normalizePath(root),
        summary: {
            insideWorkTree: metadata.insideWorkTree,
            branch: metadata.branch,
            head: metadata.head,
            statusCount: metadata.statusCount || 0,
            unstagedCount: metadata.unstagedCount || 0,
            stagedCount: metadata.stagedCount || 0,
        },
        requiredConfirmation: gitSafetyReportConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'git-reports', 'git-safety-report-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-git-safety-report-<timestamp>.execute.json')),
        ],
        checks: [
            'runs read-only git status/rev-parse/diff metadata commands',
            'does not stage, commit, checkout, reset, clean, stash, merge, rebase, push, or pull',
            'writes status rows, path lists, and diff stats only; no patch text',
        ],
    };
}

async function commandGitSafetyReport(root, options) {
    const metadata = await collectGitSafetyMetadata(root);
    const payload = {
        version: 1,
        kind: 'git-safety.report',
        generatedAt: new Date().toISOString(),
        workspace: root,
        metadata,
    };
    const dir = harmonyPath(root, 'git-reports');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `git-safety-report-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'git-safety.report',
        label: 'Git safety metadata report',
        status: 'completed',
        reportPath: normalizePath(outPath),
        insideWorkTree: metadata.insideWorkTree,
        statusCount: metadata.statusCount || 0,
        unstagedCount: metadata.unstagedCount || 0,
        stagedCount: metadata.stagedCount || 0,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

function commandEnvironmentMetadata() {
    const names = ['ComSpec', 'PSModulePath', 'PATH', 'PATHEXT', 'SHELL', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP'];
    return {
        platform: process.platform,
        arch: process.arch,
        nodeMajor: Number(process.versions.node.split('.')[0]) || 0,
        envNames: names.map(name => ({ name, present: Object.prototype.hasOwnProperty.call(process.env, name), valueIncluded: false })),
        notes: ['Environment variable values are intentionally not included.'],
    };
}

async function terminalCommandReportActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const state = await collectState(root, { ...options, limit: Math.min(Number(options.limit || 20), 20) });
    const policy = state.outsidePolicy || defaultOutsidePolicy(root);
    const recentOperations = Array.isArray(state.operationLedger?.entries) ? state.operationLedger.entries : [];
    return {
        action: 'terminal-command-report',
        version,
        workspace: normalizePath(root),
        summary: {
            policyMode: policy.mode || 'missing',
            runCommands: Boolean(policy.permissions?.runCommands),
            maxCommandSeconds: policy.budgets?.maxCommandSeconds ?? 0,
            terminalAskReceipts: Array.isArray(state.terminalAskReceipts) ? state.terminalAskReceipts.length : 0,
            activeLocks: Array.isArray(state.locks) ? state.locks.filter(item => !item.expired).length : 0,
            recentOperations: recentOperations.length,
        },
        requiredConfirmation: terminalCommandReportConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'command-reports', 'terminal-command-report-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-terminal-command-report-<timestamp>.execute.json')),
        ],
        checks: [
            'reads outside-VS command policy and budgets',
            'includes recent operation ledger metadata and terminal confirmation receipt metadata',
            'includes shell/environment names and presence flags only, not values',
            'does not execute shell commands or mutate policy',
        ],
    };
}

async function commandTerminalCommandReport(root, options) {
    const state = await collectState(root, { ...options, limit: Math.min(Number(options.limit || 20), 20) });
    const policy = state.outsidePolicy || defaultOutsidePolicy(root);
    const recentOperations = Array.isArray(state.operationLedger?.entries) ? state.operationLedger.entries : [];
    const payload = {
        version: 1,
        kind: 'terminal-command.report',
        generatedAt: new Date().toISOString(),
        workspace: root,
        policy: {
            path: outsidePolicyPath(root),
            mode: policy.mode,
            permissions: policy.permissions,
            budgets: policy.budgets,
        },
        terminalAskReceipts: state.terminalAskReceipts,
        locks: state.locks,
        operationLedger: state.operationLedger,
        recentOperations,
        smokeReports: state.smokeReports,
        environment: commandEnvironmentMetadata(),
        notes: [
            'Report only. No shell command was executed by this action.',
            'Environment variable values, command output beyond existing ledger metadata, and secrets are not included.',
        ],
    };
    const dir = harmonyPath(root, 'command-reports');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `terminal-command-report-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'terminal-command.report',
        label: 'Terminal/command metadata report',
        status: 'completed',
        reportPath: normalizePath(outPath),
        policyMode: policy.mode,
        runCommands: Boolean(policy.permissions?.runCommands),
        maxCommandSeconds: policy.budgets?.maxCommandSeconds ?? 0,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

async function newestFileMtime(dirPath) {
    if (!await pathExists(dirPath)) return undefined;
    let newest;
    async function walk(current) {
        const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const child = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(child);
            } else if (entry.isFile()) {
                const stat = await fsp.stat(child).catch(() => undefined);
                if (stat && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { path: child, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() };
            }
        }
    }
    await walk(dirPath);
    return newest;
}

function packageToolNames(pkg) {
    const tools = pkg?.contributes?.languageModelTools;
    return Array.isArray(tools)
        ? tools.map(tool => tool && tool.name).filter(name => typeof name === 'string' && name.startsWith('harmony_')).sort()
        : [];
}

async function collectSelfHealingMetadata(root, options) {
    const sourceRoot = extensionRoot();
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const vsixPath = path.resolve(String(options.vsix || `harmony-extension-${version}.vsix`));
    const srcNewest = await newestFileMtime(path.join(sourceRoot, 'src'));
    const outPath = path.join(sourceRoot, 'out', 'extension.js');
    const outStat = await fsp.stat(outPath).catch(() => undefined);
    const smokeReports = await readSmokeReportSummaries(root, 20);
    const latestPrivacy = await latestJsonFile(harmonyPath(root, 'privacy-scan'), 'privacy-scan-');
    const latestRelease = await latestJsonFile(harmonyPath(root, 'release'), 'release-receipt-');
    const installedEditors = await Promise.all([
        scanInstalledHarmonyExtension('vscode', version),
        scanInstalledHarmonyExtension('cursor', version),
    ]);
    const scripts = pkg.scripts || {};
    const toolNames = packageToolNames(pkg);
    const hasPhase3Smoke = smokeReports.some(report => String(report.id || '').startsWith('phase3-smoke') && report.status === 'passed');
    const checks = [
        { name: 'source_package_found', status: pkg.name === 'harmony-extension' ? 'ok' : 'warn', detail: pkg.name || 'missing package name' },
        { name: 'tool_manifest_present', status: toolNames.length > 0 ? 'ok' : 'warn', detail: `${toolNames.length} harmony tools in package manifest` },
        { name: 'compile_script_present', status: scripts.compile ? 'ok' : 'warn', detail: scripts.compile || 'missing' },
        { name: 'package_script_present', status: scripts.package ? 'ok' : 'warn', detail: scripts.package || 'missing' },
        { name: 'install_script_present', status: scripts['install:vsix:both'] ? 'ok' : 'warn', detail: scripts['install:vsix:both'] || 'missing' },
        { name: 'compiled_output_present', status: outStat ? 'ok' : 'warn', detail: normalizePath(outPath) },
        { name: 'compiled_output_current', status: srcNewest && outStat && srcNewest.mtimeMs > outStat.mtimeMs ? 'warn' : 'ok', detail: srcNewest && outStat ? `newest source ${srcNewest.mtime}; out ${outStat.mtime.toISOString()}` : 'insufficient mtime data' },
        { name: 'vsix_exists', status: await pathExists(vsixPath) ? 'ok' : 'warn', detail: normalizePath(vsixPath) },
        { name: 'phase3_smoke_passed', status: hasPhase3Smoke ? 'ok' : 'warn', detail: hasPhase3Smoke ? 'passed phase3 smoke found' : 'no passed phase3 smoke found' },
        { name: 'privacy_scan_passed', status: latestPrivacy?.json?.status === 'passed' ? 'ok' : 'warn', detail: latestPrivacy ? normalizePath(latestPrivacy.path) : 'missing' },
        { name: 'release_receipt_passed', status: latestRelease?.json?.status === 'passed' ? 'ok' : 'warn', detail: latestRelease ? normalizePath(latestRelease.path) : 'missing' },
        ...installedEditors.map(item => ({ name: `${item.editor}_installed_version`, status: item.matchesExpected ? 'ok' : 'warn', detail: item.version || 'missing' })),
    ];
    const warnings = checks.filter(check => check.status !== 'ok');
    return {
        version,
        sourceRoot: normalizePath(sourceRoot),
        package: {
            name: pkg.name || 'unknown',
            version,
            scripts: {
                compile: scripts.compile || undefined,
                package: scripts.package || undefined,
                installBoth: scripts['install:vsix:both'] || undefined,
            },
            harmonyToolCount: toolNames.length,
        },
        compiledOutput: {
            path: normalizePath(outPath),
            exists: Boolean(outStat),
            mtime: outStat?.mtime?.toISOString(),
            newestSource: srcNewest ? { path: normalizePath(srcNewest.path), mtime: srcNewest.mtime } : undefined,
            sourceNewerThanOutput: Boolean(srcNewest && outStat && srcNewest.mtimeMs > outStat.mtimeMs),
        },
        vsix: { path: normalizePath(vsixPath), exists: await pathExists(vsixPath) },
        installedEditors,
        latestPrivacyScan: latestPrivacy ? { path: normalizePath(latestPrivacy.path), status: latestPrivacy.json.status } : undefined,
        latestReleaseReceipt: latestRelease ? { path: normalizePath(latestRelease.path), status: latestRelease.json.status } : undefined,
        smokeReports,
        checks,
        readiness: {
            status: warnings.length ? 'warning' : 'ready',
            warnings: warnings.map(check => `${check.name}: ${check.detail}`),
        },
        notes: [
            'Report only. No files were edited, no commands were executed, no VSIX was packaged or installed, and no repair script was run.',
            'Use this as the control-panel spine before adding self-update or self-repair execution gates.',
        ],
    };
}

async function selfHealingReportActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const metadata = await collectSelfHealingMetadata(root, options);
    return {
        action: 'self-healing-report',
        version,
        workspace: normalizePath(root),
        summary: {
            readiness: metadata.readiness.status,
            warnings: metadata.readiness.warnings.length,
            sourceRoot: metadata.sourceRoot,
            toolCount: metadata.package.harmonyToolCount,
            vsixExists: metadata.vsix.exists,
            installedMatches: metadata.installedEditors.filter(item => item.matchesExpected).length,
        },
        requiredConfirmation: selfHealingReportConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'self-healing', 'self-healing-report-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-self-healing-report-<timestamp>.execute.json')),
        ],
        checks: [
            'reads Harmony package, source/output timestamps, tool manifest counts, VSIX presence, smoke/privacy/release receipt metadata, and installed editor metadata',
            'does not compile, package, install, reload, edit files, run repair scripts, or mutate settings',
            'writes a private self-healing report under .harmony/self-healing',
        ],
    };
}

async function commandSelfHealingReport(root, options) {
    const metadata = await collectSelfHealingMetadata(root, options);
    const payload = {
        version: 1,
        kind: 'self-healing.report',
        generatedAt: new Date().toISOString(),
        workspace: root,
        metadata,
    };
    const dir = harmonyPath(root, 'self-healing');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `self-healing-report-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'self-healing.report',
        label: `Self-healing report ${metadata.readiness.status}`,
        status: metadata.readiness.status === 'ready' ? 'completed' : 'warning',
        reportPath: normalizePath(outPath),
        version: metadata.version,
        warningCount: metadata.readiness.warnings.length,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

function selfHealingGateContract(metadata) {
    return {
        posture: 'expert-gated-default-off',
        mutationStatus: 'blocked-until-a-specific-future-execution-action-uses-this-contract',
        allowedFutureActions: [
            'compile-check',
            'native-ui-build-check',
            'phase3-smoke-check',
            'package-vsix',
            'privacy-scan',
            'release-receipt',
            'install-versioned-vsix',
            'restore-extension-engine',
        ],
        blockedAuthorityClasses: [
            'arbitrary shell command execution',
            'source file edits from the native UI',
            'outside-VS policy mutation',
            'provider/model processing',
            'git staging, commit, checkout, reset, clean, merge, rebase, pull, or push',
            'memory/chat deletion',
        ],
        requiredBeforeMutation: [
            'fresh Self-Healing Report for the exact source version',
            'fresh preview receipt for the exact future execution action',
            'exact confirmation phrase for that future action',
            'pre-mutation state capture: package version, VSIX path, installed editor versions, smoke/privacy/release report paths',
            'rollback path: previous VSIX path or restore script path must be captured before install or repair',
            'write scoped execute receipt containing every command or file path touched',
            'post-action release receipt or failure receipt before any further gated action can run',
        ],
        currentReadiness: {
            status: metadata.readiness.status,
            warnings: metadata.readiness.warnings,
            version: metadata.version,
            installedMatches: metadata.installedEditors.filter(item => item.matchesExpected).length,
        },
        notes: [
            'This gate is a contract only. It does not compile, package, install, reload, run repair scripts, mutate git, call providers, or edit source files.',
            'Future self-healing execution must be implemented as separate named actions that cite this contract and produce their own preview and execute receipts.',
        ],
    };
}

async function selfHealingGateActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const metadata = await collectSelfHealingMetadata(root, options);
    const contract = selfHealingGateContract(metadata);
    return {
        action: 'self-healing-gate',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'self-healing.executionGate',
            readiness: metadata.readiness.status,
            blockedAuthorityClasses: contract.blockedAuthorityClasses.length,
        },
        summary: {
            readiness: metadata.readiness.status,
            warnings: metadata.readiness.warnings.length,
            allowedFutureActions: contract.allowedFutureActions.length,
            blockedAuthorityClasses: contract.blockedAuthorityClasses.length,
            requiredBeforeMutation: contract.requiredBeforeMutation.length,
        },
        requiredConfirmation: selfHealingGateConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'self-healing', 'self-healing-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-self-healing-gate-<timestamp>.execute.json')),
        ],
        checks: [
            'reads current Self-Healing Report metadata inputs and writes a future-execution contract',
            'keeps self-repair and self-update mutation blocked until a separate named action implements this contract',
            'does not compile, package, install, reload, edit source files, run repair scripts, mutate git, call providers, or delete chats',
        ],
        contract,
    };
}

async function commandSelfHealingGate(root, options) {
    const metadata = await collectSelfHealingMetadata(root, options);
    const contract = selfHealingGateContract(metadata);
    const payload = {
        version: 1,
        kind: 'self-healing.executionGate',
        generatedAt: new Date().toISOString(),
        workspace: root,
        metadata,
        contract,
    };
    const dir = harmonyPath(root, 'self-healing');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `self-healing-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'self-healing.executionGate',
        label: 'Self-healing execution gate contract',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version: metadata.version,
        mutationStatus: contract.mutationStatus,
        blockedAuthorityCount: contract.blockedAuthorityClasses.length,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

function selfHealingPackagePreflightLockPath(root) {
    return harmonyPath(root, 'self-healing', 'self-healing-package-preflight.lock.json');
}

async function acquireSelfHealingPackagePreflightLock(root, options) {
    const lockPath = selfHealingPackagePreflightLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 45 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'self-healing.packagePreflight.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'self-healing.packagePreflight',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Self-healing package preflight is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseSelfHealingPackagePreflightLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function shellStep(commandLine, timeoutSeconds) {
    if (process.platform === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', commandLine], commandLine, timeoutSeconds };
    return { command: 'sh', args: ['-c', commandLine], commandLine, timeoutSeconds };
}

function selfHealingPackagePreflightSteps(root, version) {
    const vsixPath = path.resolve(`harmony-extension-${version}.vsix`);
    return [
        { name: 'node syntax check', command: process.execPath, args: ['--check', path.join(extensionRoot(), 'bin', 'harmony-cli.js')], commandLine: 'node --check bin/harmony-cli.js', timeoutSeconds: 60 },
        shellStep('npm run compile', 300),
        shellStep('npm --prefix native-ui run build', 300),
        shellStep('git diff --check', 120),
        { name: 'phase3 smoke', command: process.execPath, args: [path.join(extensionRoot(), 'bin', 'harmony-cli.js'), 'smoke', 'phase3', '--skip-self-healing-package-preflight'], commandLine: 'node bin/harmony-cli.js smoke phase3 --skip-self-healing-package-preflight', timeoutSeconds: 1200 },
        shellStep('npm run package', 900),
        { name: 'privacy scan', command: process.execPath, args: [path.join(extensionRoot(), 'bin', 'harmony-cli.js'), '--workspace', root, 'privacy-scan', '--vsix', vsixPath, '--json'], commandLine: `node bin/harmony-cli.js --workspace <workspace> privacy-scan --vsix ${path.basename(vsixPath)} --json`, timeoutSeconds: 300 },
    ].map(step => ({ ...step, cwd: extensionRoot() }));
}

async function captureSelfHealingPackageRollback(root, version) {
    const vsixPath = path.resolve(`harmony-extension-${version}.vsix`);
    const exists = await pathExists(vsixPath);
    if (!exists) return { vsixPath: normalizePath(vsixPath), existed: false };
    const stat = await fsp.stat(vsixPath).catch(() => undefined);
    const backupDir = harmonyPath(root, 'self-healing', 'backups');
    await fsp.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${path.basename(vsixPath)}.${Date.now()}.bak`);
    await fsp.copyFile(vsixPath, backupPath);
    return {
        vsixPath: normalizePath(vsixPath),
        existed: true,
        size: stat?.size,
        backupPath: normalizePath(backupPath),
        sha256: crypto.createHash('sha256').update(await fsp.readFile(vsixPath)).digest('hex'),
    };
}

async function selfHealingPackagePreflightActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const metadata = await collectSelfHealingMetadata(root, options);
    const commands = selfHealingPackagePreflightSteps(root, version).map(step => ({ name: step.name, commandLine: step.commandLine, timeoutSeconds: step.timeoutSeconds }));
    const commandsDigest = crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex');
    return {
        action: 'self-healing-package-preflight',
        version,
        workspace: normalizePath(root),
        target: {
            kind: 'self-healing.packagePreflight',
            commandCount: commands.length,
            commandsDigest,
            vsix: normalizePath(path.resolve(`harmony-extension-${version}.vsix`)),
            installedEditorVersions: metadata.installedEditors.map(item => `${item.editor}:${item.version || 'missing'}`),
        },
        summary: {
            readiness: metadata.readiness.status,
            warnings: metadata.readiness.warnings.length,
            commandCount: commands.length,
            lockPath: normalizePath(selfHealingPackagePreflightLockPath(root)),
            installs: false,
            reloadsEditors: false,
        },
        requiredConfirmation: selfHealingPackagePreflightConfirmation(version),
        writes: [
            normalizePath(path.resolve(`harmony-extension-${version}.vsix`)),
            normalizePath(harmonyPath(root, 'self-healing', 'self-healing-package-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'self-healing', 'self-healing-package-preflight.lock.json')),
            normalizePath(harmonyPath(root, 'self-healing', 'backups', `harmony-extension-${version}.vsix.<timestamp>.bak`)),
            normalizePath(harmonyPath(root, 'privacy-scan', 'privacy-scan-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-self-healing-package-preflight-<timestamp>.execute.json')),
        ],
        checks: [
            'acquires an atomic single-owner lock before running fixed commands',
            'captures existing VSIX rollback copy before packaging if one exists',
            'runs only the fixed command list shown in preview',
            'does not install VSIX, reload editors, run repair scripts, mutate git, call providers, or delete chats',
            'writes a post-action self-healing package preflight receipt and privacy scan report',
        ],
        commands,
    };
}

async function commandSelfHealingPackagePreflight(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const report = {
        version: 1,
        kind: 'self-healing.packagePreflight',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        rollback: undefined,
        preState: undefined,
        commands: [],
        postState: undefined,
        notes: [
            'No VSIX was installed, no editor was reloaded, no repair script was run, no provider was called, no git mutation was performed, and no chats were deleted.',
            'This action packages and scans only. Final install must remain a separate explicit checkpoint.',
        ],
    };
    let lock;
    try {
        lock = await acquireSelfHealingPackagePreflightLock(root, options);
        report.lock = lock;
        report.rollback = await captureSelfHealingPackageRollback(root, version);
        report.preState = await collectSelfHealingMetadata(root, options);
        for (const step of selfHealingPackagePreflightSteps(root, version)) {
            const result = await runProcessCapture(step.cwd || extensionRoot(), step.command, step.args, step.timeoutSeconds);
            report.commands.push({ name: step.name, ...result });
            if (result.exitCode !== 0) break;
        }
        report.postState = await collectSelfHealingMetadata(root, options);
        report.status = report.commands.length === selfHealingPackagePreflightSteps(root, version).length && report.commands.every(step => step.exitCode === 0) ? 'passed' : 'failed';
    } finally {
        if (lock) report.lockRelease = await releaseSelfHealingPackagePreflightLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'self-healing');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `self-healing-package-preflight-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'self-healing.packagePreflight',
        label: `Self-healing package preflight ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version,
        commandCount: report.commands.length,
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

async function commandSelfHealing(root, subcommand, options) {
    const action = subcommand || 'status';
    if (action === 'status') {
        const metadata = await collectSelfHealingMetadata(root, options);
        if (options.json) printJson({ version: 1, kind: 'self-healing.status', workspace: normalizePath(root), metadata });
        else {
            process.stdout.write([
                `Harmony self-healing status: ${metadata.readiness.status}`,
                `Version: ${metadata.version}`,
                `VSIX: ${metadata.vsix.exists ? 'present' : 'missing'} ${metadata.vsix.path ? normalizePath(metadata.vsix.path) : ''}`.trim(),
                `Installed matches: ${metadata.installedEditors.filter(item => item.matchesExpected).length}/${metadata.installedEditors.length}`,
                metadata.readiness.warnings.length ? `Warnings: ${metadata.readiness.warnings.join(' | ')}` : 'Warnings: none',
                '',
            ].join(os.EOL));
        }
        return 0;
    }
    if (action === 'report') {
        const result = await commandSelfHealingReport(root, options);
        if (options.json) printJson(result.report);
        else process.stdout.write(`Self-healing report written: ${result.report.reportPath} (${result.report.metadata.readiness.status})${os.EOL}`);
        return result.exitCode;
    }
    if (action === 'gate') {
        const result = await commandSelfHealingGate(root, options);
        if (options.json) printJson(result.report);
        else process.stdout.write(`Self-healing gate written: ${result.report.reportPath}${os.EOL}`);
        return result.exitCode;
    }
    if (action === 'package-preflight' || action === 'preflight') {
        if (!options.confirm) {
            const preview = await selfHealingPackagePreflightActionPreview(root, options);
            if (options.json) printJson({ version: 1, kind: 'self-healing.packagePreflight.preview', preview });
            else process.stdout.write([
                'Self-healing package preflight preview only. No commands were run.',
                `Version: ${preview.version}`,
                `Commands: ${preview.commands.length}`,
                `Required confirmation: ${preview.requiredConfirmation}`,
                'Run with: node bin/harmony-cli.js self-healing package-preflight --confirm',
                '',
            ].join(os.EOL));
            return 0;
        }
        const result = await commandSelfHealingPackagePreflight(root, options);
        if (options.json) printJson(result.report);
        else process.stdout.write(`Self-healing package preflight ${result.report.status}: ${result.report.reportPath}${os.EOL}`);
        return result.exitCode;
    }
    throw new Error('self-healing supports: status, report, gate, package-preflight');
}

async function collectNativeLifecycleMetadata(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const host = String(options.host || '127.0.0.1');
    const port = Number(options.port || 8788);
    const state = await collectState(root, { ...options, limit: Math.min(Number(options.limit || 20), 20) });
    const tauriConfigPath = path.join(extensionRoot(), 'native-ui', 'src-tauri', 'tauri.conf.json');
    const tauriConfig = await pathExists(tauriConfigPath) ? await readJson(tauriConfigPath) : undefined;
    const tauriWindow = Array.isArray(tauriConfig?.app?.windows) ? tauriConfig.app.windows[0] : undefined;
    return {
        version,
        generatedBy: {
            pid: process.pid,
            ppid: process.ppid,
            platform: process.platform,
            node: process.version,
            execPath: normalizePath(process.execPath),
        },
        backend: {
            host,
            port,
            expectedUrl: `http://${host}:${port}/`,
            currentRequestProcessOwnsReport: true,
            healthEndpoint: `http://${host}:${port}/healthz`,
        },
        tauri: {
            configPath: normalizePath(tauriConfigPath),
            configExists: Boolean(tauriConfig),
            productName: tauriConfig?.productName || 'unknown',
            version: tauriConfig?.version || 'unknown',
            identifier: tauriConfig?.identifier || 'unknown',
            mainWindow: tauriWindow ? {
                label: tauriWindow.label,
                title: tauriWindow.title,
                width: tauriWindow.width,
                height: tauriWindow.height,
                minWidth: tauriWindow.minWidth,
                minHeight: tauriWindow.minHeight,
            } : undefined,
        },
        supervisor: {
            active: state.supervisor?.active || 0,
            stale: state.supervisor?.stale || 0,
            heartbeats: state.supervisor?.heartbeats || [],
            managedProcesses: state.supervisor?.managedProcesses || [],
        },
        lifecycleContract: {
            posture: 'outside-native-first',
            vscodeRole: 'coordinated surface through shared state and broker metadata',
            currentStatus: 'report-only; native start, stop, restart, and relaunch controls are not implemented in this action',
            requiredBeforeStartStop: [
                'single-owner daemon lock under .harmony/native-lifecycle',
                'durable pid/port/heartbeat receipt before reporting started',
                'stale heartbeat detection before restart',
                'exact-confirmed stop/restart preview receipt',
                'rollback path that can reconnect to an already-running backend without killing VS Code',
            ],
            blockedAuthorityClasses: [
                'starting background processes from this report action',
                'stopping or killing processes from this report action',
                'launching VS Code or Cursor from this report action',
                'editing files outside .harmony reports and receipts',
            ],
        },
        notes: [
            'Report only. No daemon was started, stopped, killed, restarted, or relaunched.',
            'The intended lifecycle owner is the native app/daemon, with VS Code and Cursor coordinating through shared state rather than owning the native lifecycle.',
        ],
    };
}

async function nativeLifecycleReportActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const metadata = await collectNativeLifecycleMetadata(root, options);
    return {
        action: 'native-lifecycle-report',
        version,
        workspace: normalizePath(root),
        summary: {
            posture: metadata.lifecycleContract.posture,
            currentStatus: metadata.lifecycleContract.currentStatus,
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
            tauriWindow: metadata.tauri.mainWindow?.title || metadata.tauri.productName,
        },
        requiredConfirmation: nativeLifecycleReportConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-report-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-report-<timestamp>.execute.json')),
        ],
        checks: [
            'reads current ui serve process, Tauri window configuration, supervisor heartbeats, and managed process metadata',
            'does not start, stop, kill, restart, relaunch, or open editor processes',
            'writes the outside-native-first lifecycle contract under .harmony/native-lifecycle',
        ],
        contract: metadata.lifecycleContract,
    };
}

async function commandNativeLifecycleReport(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    const payload = {
        version: 1,
        kind: 'native-lifecycle.report',
        generatedAt: new Date().toISOString(),
        workspace: root,
        metadata,
    };
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-report-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.report',
        label: 'Native daemon/window lifecycle report',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version: metadata.version,
        activeHeartbeats: metadata.supervisor.active,
        staleHeartbeats: metadata.supervisor.stale,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

function nativeLifecyclePreflightLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-preflight.lock.json');
}

async function acquireNativeLifecyclePreflightLock(root, options) {
    const lockPath = nativeLifecyclePreflightLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.preflight.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.preflight',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle preflight is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecyclePreflightLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

async function nativeLifecyclePreflightChecks(root, metadata) {
    const contract = metadata.lifecycleContract || {};
    const blocked = contract.blockedAuthorityClasses || [];
    const required = contract.requiredBeforeStartStop || [];
    const notes = metadata.notes || [];
    return [
        {
            name: 'loopback backend host',
            status: isLoopbackUiHost(metadata.backend?.host || '') ? 'passed' : 'failed',
            detail: metadata.backend?.expectedUrl || 'unknown',
        },
        {
            name: 'tauri config present',
            status: metadata.tauri?.configExists ? 'passed' : 'failed',
            detail: metadata.tauri?.configPath || 'unknown',
        },
        {
            name: 'main window declared',
            status: metadata.tauri?.mainWindow?.label && metadata.tauri?.mainWindow?.title ? 'passed' : 'failed',
            detail: metadata.tauri?.mainWindow?.title || 'missing',
        },
        {
            name: 'outside native lifecycle posture',
            status: contract.posture === 'outside-native-first' ? 'passed' : 'failed',
            detail: contract.posture || 'missing',
        },
        {
            name: 'single-owner lock requirement present',
            status: required.some(item => /single-owner daemon lock/i.test(item)) ? 'passed' : 'failed',
            detail: normalizePath(nativeLifecyclePreflightLockPath(root)),
        },
        {
            name: 'start authority still blocked',
            status: blocked.some(item => /starting background processes/i.test(item)) ? 'passed' : 'failed',
            detail: 'future start controls remain separate',
        },
        {
            name: 'stop kill authority still blocked',
            status: blocked.some(item => /stopping or killing processes/i.test(item)) ? 'passed' : 'failed',
            detail: 'future stop controls remain separate',
        },
        {
            name: 'editor launch authority still blocked',
            status: blocked.some(item => /launching VS Code or Cursor/i.test(item)) ? 'passed' : 'failed',
            detail: 'no editor reload or relaunch',
        },
        {
            name: 'no lifecycle mutation note present',
            status: notes.some(note => /No daemon was started, stopped, killed, restarted, or relaunched/i.test(note)) ? 'passed' : 'failed',
            detail: 'report-only lifecycle note retained',
        },
    ];
}

async function nativeLifecyclePreflightActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const metadata = await collectNativeLifecycleMetadata(root, options);
    const checks = await nativeLifecyclePreflightChecks(root, metadata);
    const checksDigest = crypto.createHash('sha256').update(JSON.stringify(checks.map(check => check.name))).digest('hex');
    return {
        action: 'native-lifecycle-preflight',
        version,
        workspace: normalizePath(root),
        target: {
            kind: 'native-lifecycle.preflight',
            lockPath: normalizePath(nativeLifecyclePreflightLockPath(root)),
            reportPath: normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-preflight-<timestamp>.json')),
            checks: checks.length,
            checksDigest,
            authority: 'report-and-preflight-only',
        },
        summary: {
            posture: metadata.lifecycleContract.posture,
            currentStatus: metadata.lifecycleContract.currentStatus,
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
            tauriWindow: metadata.tauri.mainWindow?.title || metadata.tauri.productName,
            blockedAuthorityClasses: metadata.lifecycleContract.blockedAuthorityClasses.length,
        },
        requiredConfirmation: nativeLifecyclePreflightConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-preflight.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-preflight-<timestamp>.execute.json')),
        ],
        checks: checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'acquires an atomic single-owner lock before writing the preflight report',
            'runs only non-mutating lifecycle readiness checks',
            'does not start, stop, kill, restart, relaunch, open editors, install VSIX packages, or delete chats',
        ],
        contract: metadata.lifecycleContract,
    };
}

async function commandNativeLifecyclePreflight(root, options) {
    const metadataBefore = await collectNativeLifecycleMetadata(root, options);
    const report = {
        version: 1,
        kind: 'native-lifecycle.preflight',
        generatedAt: new Date().toISOString(),
        workspace: root,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        metadataBefore,
        checks: [],
        metadataAfter: undefined,
        notes: [
            'No daemon was started, stopped, killed, restarted, relaunched, or opened.',
            'No VSIX was installed, no editor was reloaded, no repair script was run, no provider was called, no git mutation was performed, and no chats were deleted.',
            'This preflight only validates the lifecycle contract needed before future start/stop actions exist.',
        ],
    };
    let lock;
    try {
        lock = await acquireNativeLifecyclePreflightLock(root, options);
        report.lock = lock;
        report.checks = await nativeLifecyclePreflightChecks(root, metadataBefore);
        report.metadataAfter = await collectNativeLifecycleMetadata(root, options);
        report.status = report.checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecyclePreflightLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-preflight-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.preflight',
        label: `Native daemon/window lifecycle preflight ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version: metadataBefore.version,
        checks: report.checks.length,
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

async function nativeLifecycleStartGateContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    const latestPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-preflight-');
    const preflightJson = latestPreflight?.json;
    return {
        posture: 'expert-gated-default-off',
        startStatus: 'blocked-until-a-specific-future-start-action-uses-this-contract',
        currentLifecycle: {
            backend: metadata.backend.expectedUrl,
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
            tauriWindow: metadata.tauri.mainWindow?.title || metadata.tauri.productName,
        },
        latestPreflight: latestPreflight ? {
            path: normalizePath(latestPreflight.path),
            status: preflightJson?.status || 'unknown',
            version: preflightJson?.metadataBefore?.version || preflightJson?.metadataAfter?.version || 'unknown',
            checks: Array.isArray(preflightJson?.checks) ? preflightJson.checks.length : 0,
        } : undefined,
        allowedFutureActions: [
            'native-daemon-start-preflight',
            'native-daemon-start-execute',
            'native-window-open-preflight',
            'native-backend-reconnect',
        ],
        requiredBeforeStart: [
            'fresh Native Lifecycle Preflight must pass for the exact package version',
            'fresh preview receipt and exact confirmation phrase for the dedicated future start action',
            'single-owner native lifecycle lock must be acquired before any process spawn or window open attempt',
            'fixed executable and argument list must be shown in preview; no arbitrary command input is allowed',
            'pre-start state capture must include existing heartbeats, managed process metadata, port plan, pid plan, and rollback/reconnect path',
            'post-start receipt must prove heartbeat freshness and /healthz reachability before reporting started',
            'failure receipt must include lock release status and must not kill unrelated VS Code, Cursor, terminal, or native UI processes',
        ],
        blockedAuthorityClasses: [
            'starting daemon or opening native windows from this gate action',
            'stopping, killing, restarting, or relaunching processes from this gate action',
            'installing VSIX packages or reloading editors from this gate action',
            'provider calls, source edits, git mutations, or chat deletion from this gate action',
        ],
        notes: [
            'This gate is contract-only. It does not start a daemon, open a native window, spawn processes, install packages, reload editors, or kill anything.',
            'Future daemon/window start actions must cite this contract and produce their own preview and execute receipts.',
        ],
    };
}

async function nativeLifecycleStartGateActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleStartGateContract(root, options);
    return {
        action: 'native-lifecycle-start-gate',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.startGate',
            startCurrentlyAllowed: false,
            latestPreflightStatus: contract.latestPreflight?.status || 'missing',
        },
        summary: {
            posture: contract.posture,
            startStatus: contract.startStatus,
            requiredBeforeStart: contract.requiredBeforeStart.length,
            blockedAuthorityClasses: contract.blockedAuthorityClasses.length,
            latestPreflightStatus: contract.latestPreflight?.status || 'missing',
        },
        requiredConfirmation: nativeLifecycleStartGateConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-start-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-start-gate-<timestamp>.execute.json')),
        ],
        checks: [
            'reads current lifecycle metadata and latest Native Lifecycle Preflight status before writing the start contract',
            'keeps daemon start, native window open, process stop, process kill, install, and reload authority blocked',
            'writes the future start requirements under .harmony/native-lifecycle without spawning any process',
        ],
        contract,
    };
}

async function commandNativeLifecycleStartGate(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleStartGateContract(root, options);
    const payload = {
        version: 1,
        kind: 'native-lifecycle.startGate',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        contract,
    };
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-start-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.startGate',
        label: 'Native daemon/window start gate contract',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version,
        latestPreflightStatus: contract.latestPreflight?.status || 'missing',
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

async function nativeLifecycleStopGateContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    const latestPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-preflight-');
    const latestStartGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-start-gate-');
    const preflightJson = latestPreflight?.json;
    const startGateJson = latestStartGate?.json;
    return {
        posture: 'expert-gated-default-off',
        stopStatus: 'blocked-until-a-specific-future-stop-action-uses-this-contract',
        currentLifecycle: {
            backend: metadata.backend.expectedUrl,
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
            managedProcesses: Array.isArray(metadata.supervisor.managedProcesses) ? metadata.supervisor.managedProcesses.length : 0,
        },
        latestPreflight: latestPreflight ? {
            path: normalizePath(latestPreflight.path),
            status: preflightJson?.status || 'unknown',
            version: preflightJson?.metadataBefore?.version || preflightJson?.metadataAfter?.version || 'unknown',
            checks: Array.isArray(preflightJson?.checks) ? preflightJson.checks.length : 0,
        } : undefined,
        latestStartGate: latestStartGate ? {
            path: normalizePath(latestStartGate.path),
            posture: startGateJson?.contract?.posture || 'unknown',
            version: startGateJson?.packageVersion || 'unknown',
        } : undefined,
        allowedFutureActions: [
            'native-daemon-stop-preflight',
            'native-daemon-graceful-stop-execute',
            'native-daemon-restart-preflight',
            'native-backend-reconnect-after-stop',
        ],
        requiredBeforeStop: [
            'fresh Native Lifecycle Preflight must pass for the exact package version',
            'fresh preview receipt and exact confirmation phrase for the dedicated future stop or restart action',
            'target process must be proven Harmony-owned with workspace, pid, command digest, heartbeat receipt, and lifecycle lock token',
            'stop plan must be graceful first and must define a timeout without kill authority unless a separate kill gate exists',
            'pre-stop state capture must include active heartbeats, managed process metadata, current health endpoint status, and reconnect plan',
            'post-stop receipt must include heartbeat status, health endpoint result, lock release status, and clear restart/reconnect instructions',
            'future stop action must refuse unknown, stale, unrelated, editor, terminal, or non-Harmony-owned processes',
        ],
        blockedAuthorityClasses: [
            'stopping, killing, or restarting processes from this gate action',
            'stopping unknown or unowned processes from any future action',
            'starting daemon or opening native windows from this gate action',
            'installing VSIX packages or reloading editors from this gate action',
            'provider calls, source edits, git mutations, or chat deletion from this gate action',
        ],
        notes: [
            'This gate is contract-only. It does not stop, kill, restart, spawn, open windows, install packages, reload editors, or mutate process state.',
            'Future stop/restart actions must cite this contract and produce their own preview and execute receipts.',
        ],
    };
}

async function nativeLifecycleStopGateActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleStopGateContract(root, options);
    return {
        action: 'native-lifecycle-stop-gate',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.stopGate',
            stopCurrentlyAllowed: false,
            latestPreflightStatus: contract.latestPreflight?.status || 'missing',
        },
        summary: {
            posture: contract.posture,
            stopStatus: contract.stopStatus,
            requiredBeforeStop: contract.requiredBeforeStop.length,
            blockedAuthorityClasses: contract.blockedAuthorityClasses.length,
            latestPreflightStatus: contract.latestPreflight?.status || 'missing',
        },
        requiredConfirmation: nativeLifecycleStopGateConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-stop-gate-<timestamp>.execute.json')),
        ],
        checks: [
            'reads current lifecycle metadata, latest Native Lifecycle Preflight, and latest Start Gate before writing the stop/restart contract',
            'keeps daemon stop, kill, restart, start, install, and reload authority blocked',
            'writes the future stop/restart requirements under .harmony/native-lifecycle without touching any process',
        ],
        contract,
    };
}

async function commandNativeLifecycleStopGate(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleStopGateContract(root, options);
    const payload = {
        version: 1,
        kind: 'native-lifecycle.stopGate',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        contract,
    };
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-stop-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.stopGate',
        label: 'Native daemon/window stop gate contract',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version,
        latestPreflightStatus: contract.latestPreflight?.status || 'missing',
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

async function probeNativeLifecycleHealth(metadata, options) {
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    if (!isLoopbackUiHost(host)) return { status: 'skipped', reason: 'health probes are limited to loopback hosts', host, port };
    if (!Number.isFinite(port) || port < 1 || port > 65535) return { status: 'failed', reason: 'invalid backend port', host, port };
    const timeoutMs = Math.max(500, Math.min(5000, Number(options['health-timeout-ms'] || 2000)));
    return await new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const request = http.request({ host, port, path: '/healthz', method: 'GET', timeout: timeoutMs }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
                if (body.length > 8192) request.destroy(new Error('health response too large'));
            });
            response.on('end', () => {
                let parsed;
                try {
                    parsed = body ? JSON.parse(body) : undefined;
                } catch {
                    finish({ status: 'failed', statusCode: response.statusCode, host, port, endpoint: `http://${host}:${port}/healthz`, error: 'health response was not valid JSON' });
                    return;
                }
                const workspaceMatches = parsed?.workspace ? normalizePath(parsed.workspace) === normalizePath(metadata.generatedBy?.workspace || parsed.workspace) : undefined;
                finish({
                    status: response.statusCode === 200 ? 'passed' : 'failed',
                    statusCode: response.statusCode,
                    host,
                    port,
                    endpoint: `http://${host}:${port}/healthz`,
                    workspace: parsed?.workspace ? normalizePath(parsed.workspace) : undefined,
                    workspaceMatches,
                    heartbeatPath: parsed?.heartbeatPath ? normalizePath(parsed.heartbeatPath) : undefined,
                });
            });
        });
        request.on('timeout', () => request.destroy(new Error(`health probe timed out after ${timeoutMs}ms`)));
        request.on('error', error => finish({ status: 'unreachable', host, port, endpoint: `http://${host}:${port}/healthz`, error: error && error.message ? error.message : String(error) }));
        request.end();
    });
}

async function nativeLifecycleReconnectGateContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const latestPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-preflight-');
    const latestStartGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-start-gate-');
    const latestStopGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-stop-gate-');
    const preflightJson = latestPreflight?.json;
    const startGateJson = latestStartGate?.json;
    const stopGateJson = latestStopGate?.json;
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    return {
        posture: 'expert-gated-default-off',
        reconnectStatus: 'blocked-until-a-specific-future-reconnect-or-start-preflight-action-uses-this-contract',
        currentLifecycle: {
            backend: metadata.backend.expectedUrl,
            healthEndpoint: metadata.backend.healthEndpoint,
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
            managedProcesses: Array.isArray(metadata.supervisor.managedProcesses) ? metadata.supervisor.managedProcesses.length : 0,
        },
        healthProbe,
        latestPreflight: latestPreflight ? {
            path: normalizePath(latestPreflight.path),
            status: preflightJson?.status || 'unknown',
            version: preflightJson?.metadataBefore?.version || preflightJson?.metadataAfter?.version || 'unknown',
            checks: Array.isArray(preflightJson?.checks) ? preflightJson.checks.length : 0,
        } : undefined,
        latestStartGate: latestStartGate ? {
            path: normalizePath(latestStartGate.path),
            posture: startGateJson?.contract?.posture || 'unknown',
            version: startGateJson?.packageVersion || 'unknown',
        } : undefined,
        latestStopGate: latestStopGate ? {
            path: normalizePath(latestStopGate.path),
            posture: stopGateJson?.contract?.posture || 'unknown',
            version: stopGateJson?.packageVersion || 'unknown',
        } : undefined,
        allowedFutureActions: [
            'native-backend-reconnect-preflight',
            'native-backend-reconnect-execute',
            'native-daemon-start-preflight',
            'native-health-monitor-report',
        ],
        requiredBeforeReconnect: [
            'fresh Native Lifecycle Preflight must pass for the exact package version',
            'loopback health probe must show either an existing healthy backend or a clearly unreachable backend before start authority is considered',
            'workspace returned by /healthz must match the target workspace before reconnect reports success',
            'reconnect action must not spawn, stop, kill, restart, install, reload, call providers, mutate git, or delete chats',
            'future reconnect execute receipt must include backend URL, health endpoint status, heartbeat path, stale heartbeat count, and fallback instructions',
            'if health is unreachable, future start preflight may proceed only after fixed executable/port checks pass and no conflicting owner is detected',
        ],
        blockedAuthorityClasses: [
            'spawning, stopping, killing, restarting, or relaunching processes from this gate action',
            'opening native windows or editors from this gate action',
            'installing VSIX packages or reloading editors from this gate action',
            'provider calls, source edits, git mutations, or chat deletion from this gate action',
        ],
        notes: [
            'This gate may probe the loopback /healthz endpoint only. It does not spawn, stop, kill, restart, open windows, install packages, reload editors, or mutate process state.',
            'Future reconnect/start-preflight actions must cite this contract and produce their own preview and execute receipts.',
        ],
    };
}

async function nativeLifecycleReconnectGateActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleReconnectGateContract(root, options);
    return {
        action: 'native-lifecycle-reconnect-gate',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.reconnectGate',
            reconnectCurrentlyAllowed: false,
            latestPreflightStatus: contract.latestPreflight?.status || 'missing',
            healthProbeStatus: contract.healthProbe?.status || 'unknown',
        },
        summary: {
            posture: contract.posture,
            reconnectStatus: contract.reconnectStatus,
            healthProbeStatus: contract.healthProbe?.status || 'unknown',
            requiredBeforeReconnect: contract.requiredBeforeReconnect.length,
            blockedAuthorityClasses: contract.blockedAuthorityClasses.length,
            latestPreflightStatus: contract.latestPreflight?.status || 'missing',
        },
        requiredConfirmation: nativeLifecycleReconnectGateConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-reconnect-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-reconnect-gate-<timestamp>.execute.json')),
        ],
        checks: [
            'reads current lifecycle metadata, latest lifecycle gates, and loopback /healthz status before writing the reconnect contract',
            'allows only loopback health probing and keeps spawn, stop, kill, install, and reload authority blocked',
            'writes the future reconnect/start-preflight requirements under .harmony/native-lifecycle without mutating process state',
        ],
        contract,
    };
}

async function commandNativeLifecycleReconnectGate(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleReconnectGateContract(root, options);
    const payload = {
        version: 1,
        kind: 'native-lifecycle.reconnectGate',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        contract,
    };
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-reconnect-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.reconnectGate',
        label: 'Native backend reconnect and health gate contract',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version,
        latestPreflightStatus: contract.latestPreflight?.status || 'missing',
        healthProbeStatus: contract.healthProbe?.status || 'unknown',
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleStartPreflightLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-start-preflight.lock.json');
}

async function acquireNativeLifecycleStartPreflightLock(root, options) {
    const lockPath = nativeLifecycleStartPreflightLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.startPreflight.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.startPreflight',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle start preflight is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleStartPreflightLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function nativeLifecycleStartCommandPlan(root, metadata) {
    const cliPath = path.join(extensionRoot(), 'bin', 'harmony-cli.js');
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    const args = [cliPath, '--workspace', root, 'ui', 'serve', '--host', host, '--port', String(port)];
    const digest = crypto.createHash('sha256').update(JSON.stringify({
        executable: normalizePath(process.execPath),
        script: normalizePath(cliPath),
        cwd: normalizePath(extensionRoot()),
        args: args.map((arg, index) => index === 2 ? '<workspace>' : arg),
    })).digest('hex');
    return {
        executable: normalizePath(process.execPath),
        script: normalizePath(cliPath),
        cwd: normalizePath(extensionRoot()),
        args: args.map(arg => normalizePath(arg)),
        display: `node bin/harmony-cli.js --workspace <workspace> ui serve --host ${host} --port ${port}`,
        digest,
        mutableUserInput: false,
    };
}

async function probeNativeLifecyclePortAvailability(metadata) {
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    if (!isLoopbackUiHost(host)) return { status: 'failed', reason: 'port checks are limited to loopback hosts', host, port };
    if (!Number.isFinite(port) || port < 1 || port > 65535) return { status: 'failed', reason: 'invalid backend port', host, port };
    return await new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const server = net.createServer();
        server.unref();
        server.once('error', error => finish({
            status: error?.code === 'EADDRINUSE' ? 'occupied' : 'failed',
            host,
            port,
            code: error?.code,
            error: error && error.message ? error.message : String(error),
        }));
        server.listen({ host, port, exclusive: true }, () => {
            server.close(() => finish({ status: 'available', host, port }));
        });
    });
}

function nativeLifecyclePreflightVersion(preflightJson) {
    return preflightJson?.metadataBefore?.version || preflightJson?.metadataAfter?.version || 'unknown';
}

async function nativeLifecycleStartPreflightContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const latestPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-preflight-');
    const latestStartGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-start-gate-');
    const latestStopGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-stop-gate-');
    const latestReconnectGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-reconnect-gate-');
    const preflightJson = latestPreflight?.json;
    const startGateJson = latestStartGate?.json;
    const stopGateJson = latestStopGate?.json;
    const reconnectGateJson = latestReconnectGate?.json;
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const portProbe = await probeNativeLifecyclePortAvailability(metadata);
    const commandPlan = nativeLifecycleStartCommandPlan(root, metadata);
    const executableExists = await pathExists(process.execPath);
    const scriptExists = await pathExists(path.join(extensionRoot(), 'bin', 'harmony-cli.js'));
    const packageVersion = metadata.version;
    const latestPreflightSummary = latestPreflight ? {
        path: normalizePath(latestPreflight.path),
        status: preflightJson?.status || 'unknown',
        version: nativeLifecyclePreflightVersion(preflightJson),
        checks: Array.isArray(preflightJson?.checks) ? preflightJson.checks.length : 0,
    } : undefined;
    const latestStartGateSummary = latestStartGate ? {
        path: normalizePath(latestStartGate.path),
        posture: startGateJson?.contract?.posture || 'unknown',
        version: startGateJson?.packageVersion || 'unknown',
    } : undefined;
    const latestStopGateSummary = latestStopGate ? {
        path: normalizePath(latestStopGate.path),
        posture: stopGateJson?.contract?.posture || 'unknown',
        version: stopGateJson?.packageVersion || 'unknown',
    } : undefined;
    const latestReconnectGateSummary = latestReconnectGate ? {
        path: normalizePath(latestReconnectGate.path),
        posture: reconnectGateJson?.contract?.posture || 'unknown',
        version: reconnectGateJson?.packageVersion || 'unknown',
        healthProbeStatus: reconnectGateJson?.contract?.healthProbe?.status || 'unknown',
    } : undefined;
    const existingHealthyBackend = healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false;
    const portAvailable = portProbe.status === 'available';
    const portPlanStatus = existingHealthyBackend ? 'existing-healthy-backend' : (portAvailable ? 'available' : 'blocked');
    const checks = [
        {
            name: 'fresh lifecycle preflight passed for package version',
            status: latestPreflightSummary?.status === 'passed' && latestPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestPreflightSummary ? `${latestPreflightSummary.status || 'unknown'} ${latestPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'start gate contract present for package version',
            status: latestStartGateSummary?.posture === 'expert-gated-default-off' && latestStartGateSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStartGateSummary ? `${latestStartGateSummary.posture || 'unknown'} ${latestStartGateSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'reconnect health gate present for package version',
            status: latestReconnectGateSummary?.posture === 'expert-gated-default-off' && latestReconnectGateSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestReconnectGateSummary ? `${latestReconnectGateSummary.posture || 'unknown'} ${latestReconnectGateSummary.version || 'unknown'} health=${latestReconnectGateSummary.healthProbeStatus || 'unknown'}` : 'missing',
        },
        {
            name: 'fixed node executable exists',
            status: executableExists ? 'passed' : 'failed',
            detail: commandPlan.executable,
        },
        {
            name: 'fixed harmony cli script exists',
            status: scriptExists ? 'passed' : 'failed',
            detail: commandPlan.script,
        },
        {
            name: 'fixed command digest recorded',
            status: commandPlan.digest ? 'passed' : 'failed',
            detail: commandPlan.digest,
        },
        {
            name: 'loopback port is free or already healthy for this workspace',
            status: portPlanStatus === 'available' || portPlanStatus === 'existing-healthy-backend' ? 'passed' : 'failed',
            detail: `${metadata.backend.expectedUrl} port=${portProbe.status} health=${healthProbe.status}`,
        },
        {
            name: 'health workspace is absent or matches target workspace',
            status: healthProbe.workspaceMatches === false ? 'failed' : 'passed',
            detail: healthProbe.workspace || 'no workspace returned',
        },
        {
            name: 'start authority still blocked',
            status: 'passed',
            detail: 'this action does not spawn, open windows, install, reload, stop, kill, call providers, mutate git, or delete chats',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
    return {
        posture: 'expert-gated-default-off',
        startPreflightStatus: status,
        startStatus: 'blocked-until-a-separate-future-start-execute-action-cites-this-preflight',
        commandPlan,
        portPlan: {
            status: portPlanStatus,
            host: metadata.backend.host,
            port: metadata.backend.port,
            portProbe,
            ownership: existingHealthyBackend ? 'current-loopback-backend-matches-workspace' : (portAvailable ? 'no-current-owner-detected' : 'blocked-or-unknown-owner'),
        },
        healthProbe,
        latestPreflight: latestPreflightSummary,
        latestStartGate: latestStartGateSummary,
        latestStopGate: latestStopGateSummary,
        latestReconnectGate: latestReconnectGateSummary,
        checks,
        requiredBeforeStartExecute: [
            'fresh Native Lifecycle Start Preflight must pass for the exact package version',
            'future start execute must use this fixed command plan digest with no arbitrary command input',
            'single-owner native lifecycle start lock must be acquired before any process spawn attempt',
            'port plan must be available or already healthy for this exact workspace before start execution',
            'post-start receipt must prove /healthz reachability, workspace match, heartbeat path, pid, port, command digest, and lock release status',
            'start failure must not kill or restart unrelated VS Code, Cursor, terminal, native UI, or non-Harmony processes',
        ],
        blockedAuthorityClasses: [
            'starting daemon or opening native windows from this preflight action',
            'stopping, killing, restarting, or relaunching processes from this preflight action',
            'installing VSIX packages or reloading editors from this preflight action',
            'provider calls, source edits, git mutations, or chat deletion from this preflight action',
        ],
        notes: [
            'This preflight records the fixed future start command, executable checks, loopback port plan, health probe, and ownership decision only.',
            'No daemon was started, stopped, killed, restarted, relaunched, or opened; no VSIX was installed and no editor was reloaded.',
        ],
    };
}

async function nativeLifecycleStartPreflightActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleStartPreflightContract(root, options);
    return {
        action: 'native-lifecycle-start-preflight',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.startPreflight',
            startExecuteCurrentlyAllowed: false,
            startPreflightStatus: contract.startPreflightStatus,
            portPlanStatus: contract.portPlan.status,
            commandDigest: contract.commandPlan.digest,
        },
        summary: {
            posture: contract.posture,
            startPreflightStatus: contract.startPreflightStatus,
            portPlanStatus: contract.portPlan.status,
            healthProbeStatus: contract.healthProbe?.status || 'unknown',
            fixedCommandDigest: contract.commandPlan.digest,
            checksPassed: contract.checks.filter(check => check.status === 'passed').length,
            checks: contract.checks.length,
        },
        requiredConfirmation: nativeLifecycleStartPreflightConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-start-preflight.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-start-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-start-preflight-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'acquires an atomic single-owner start-preflight lock before writing the report',
            'checks only fixed executable, fixed script, command digest, loopback health, port ownership, and lifecycle receipts',
            'does not spawn, stop, kill, restart, open windows/editors, install, reload, call providers, mutate git, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleStartPreflight(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const report = {
        version: 1,
        kind: 'native-lifecycle.startPreflight',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contract: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleStartPreflightLock(root, options);
        report.lock = lock;
        report.contract = await nativeLifecycleStartPreflightContract(root, options);
        report.status = report.contract.startPreflightStatus;
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleStartPreflightLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-start-preflight-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.startPreflight',
        label: `Native daemon/window start preflight ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version,
        portPlanStatus: report.contract?.portPlan?.status || 'unknown',
        healthProbeStatus: report.contract?.healthProbe?.status || 'unknown',
        fixedCommandDigest: report.contract?.commandPlan?.digest || '',
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleDaemonStartLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-daemon-start.lock.json');
}

function nativeLifecycleFilePart(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function nativeLifecycleBackendOwnerPath(root, host, port) {
    return harmonyPath(root, 'native-lifecycle', `native-backend-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}.owner.json`);
}

function nativeLifecycleBackendManagedProcessPath(root, host, port) {
    return harmonyPath(root, 'processes', 'managed', `native-backend-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}.json`);
}

async function acquireNativeLifecycleDaemonStartLock(root, options) {
    const lockPath = nativeLifecycleDaemonStartLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.daemonStart.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.daemonStart',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle daemon start is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleDaemonStartLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function nativeLifecycleDaemonStartSpawnPlan(root, metadata) {
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    const cliPath = path.join(extensionRoot(), 'bin', 'harmony-cli.js');
    const args = [cliPath, '--workspace', root, 'ui', 'serve', '--host', host, '--port', String(port)];
    const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = harmonyPath(root, 'native-lifecycle', 'logs');
    return {
        host,
        port,
        backendUrl: `http://${host}:${port}/`,
        healthEndpoint: `http://${host}:${port}/healthz`,
        command: process.execPath,
        args,
        cwd: extensionRoot(),
        stdoutPath: path.join(logDir, `native-backend-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}-${startedAt}.stdout.log`),
        stderrPath: path.join(logDir, `native-backend-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}-${startedAt}.stderr.log`),
    };
}

async function nativeLifecycleDaemonStartContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const latestStartPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-start-preflight-');
    const startPreflightJson = latestStartPreflight?.json;
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const portProbe = await probeNativeLifecyclePortAvailability(metadata);
    const commandPlan = nativeLifecycleStartCommandPlan(root, metadata);
    const spawnPlan = nativeLifecycleDaemonStartSpawnPlan(root, metadata);
    const packageVersion = metadata.version;
    const latestStartPreflightSummary = latestStartPreflight ? {
        path: normalizePath(latestStartPreflight.path),
        status: startPreflightJson?.status || 'unknown',
        version: startPreflightJson?.packageVersion || 'unknown',
        commandDigest: startPreflightJson?.contract?.commandPlan?.digest || '',
        portPlanStatus: startPreflightJson?.contract?.portPlan?.status || 'unknown',
    } : undefined;
    const existingHealthyBackend = healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false;
    const portAvailable = portProbe.status === 'available';
    const checks = [
        {
            name: 'fresh native lifecycle start preflight passed for package version',
            status: latestStartPreflightSummary?.status === 'passed' && latestStartPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStartPreflightSummary ? `${latestStartPreflightSummary.status || 'unknown'} ${latestStartPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'start preflight command digest matches execute command digest',
            status: latestStartPreflightSummary?.commandDigest === commandPlan.digest ? 'passed' : 'failed',
            detail: commandPlan.digest,
        },
        {
            name: 'loopback backend host',
            status: isLoopbackUiHost(metadata.backend?.host || '') ? 'passed' : 'failed',
            detail: metadata.backend?.expectedUrl || 'unknown',
        },
        {
            name: 'valid backend port',
            status: Number.isFinite(metadata.backend?.port) && metadata.backend.port >= 1 && metadata.backend.port <= 65535 ? 'passed' : 'failed',
            detail: String(metadata.backend?.port || 'unknown'),
        },
        {
            name: 'fixed command inputs only',
            status: commandPlan.mutableUserInput === false ? 'passed' : 'failed',
            detail: commandPlan.display,
        },
        {
            name: 'loopback port is free or already healthy for this workspace',
            status: existingHealthyBackend || portAvailable ? 'passed' : 'failed',
            detail: `${metadata.backend.expectedUrl} port=${portProbe.status} health=${healthProbe.status}`,
        },
        {
            name: 'backend health workspace is absent or matches target workspace',
            status: healthProbe.workspaceMatches === false ? 'failed' : 'passed',
            detail: healthProbe.workspace || 'no workspace returned',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    return {
        posture: 'expert-gated-backend-only',
        startExecuteStatus: status,
        packageVersion,
        commandPlan,
        spawnPlan: {
            command: normalizePath(spawnPlan.command),
            args: spawnPlan.args.map(arg => normalizePath(arg)),
            cwd: normalizePath(spawnPlan.cwd),
            stdoutPath: normalizePath(spawnPlan.stdoutPath),
            stderrPath: normalizePath(spawnPlan.stderrPath),
        },
        ownerRecordPath: normalizePath(nativeLifecycleBackendOwnerPath(root, spawnPlan.host, spawnPlan.port)),
        managedProcessPath: normalizePath(nativeLifecycleBackendManagedProcessPath(root, spawnPlan.host, spawnPlan.port)),
        portPlan: {
            host: spawnPlan.host,
            port: spawnPlan.port,
            status: existingHealthyBackend ? 'existing-healthy-backend' : (portAvailable ? 'available' : 'blocked'),
            portProbe,
        },
        healthProbe,
        latestStartPreflight: latestStartPreflightSummary,
        checks,
        authority: {
            startsLocalBackend: status === 'passed' && !existingHealthyBackend,
            reusesExistingBackend: existingHealthyBackend,
            opensNativeWindow: false,
            stopsOrKillsProcesses: false,
            providerCalls: false,
            toolExecution: false,
            gitMutation: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        blockedAuthorityClasses: [
            'opening native windows from this backend-only action',
            'stopping, killing, restarting, or relaunching processes from this action',
            'installing VSIX packages or reloading editors from this action',
            'provider calls, source edits, git mutations, arbitrary commands, or chat deletion from this action',
        ],
        notes: [
            'This execute action may start or claim only the loopback Harmony UI backend using the fixed command plan from Native Lifecycle Start Preflight.',
            'It does not open a native window, stop or kill processes, install packages, reload editors, call providers, mutate git, run arbitrary tools, or delete chats.',
        ],
    };
}

async function readNativeLifecycleBackendHeartbeat(healthProbe) {
    if (!healthProbe?.heartbeatPath) return undefined;
    const heartbeat = await readJson(healthProbe.heartbeatPath);
    if (!heartbeat) return undefined;
    return {
        ...heartbeat,
        path: normalizePath(healthProbe.heartbeatPath),
        workspace: heartbeat.workspace ? normalizePath(heartbeat.workspace) : undefined,
    };
}

async function writeNativeLifecycleBackendOwner(root, contract, result, lock) {
    const host = contract.portPlan.host;
    const port = contract.portPlan.port;
    const ownerPath = nativeLifecycleBackendOwnerPath(root, host, port);
    const managedProcessPath = nativeLifecycleBackendManagedProcessPath(root, host, port);
    const updatedAt = new Date().toISOString();
    const owner = {
        version: 1,
        kind: 'native-lifecycle.backendDaemon.owner',
        workspace: normalizePath(root),
        host,
        port,
        backendUrl: `http://${host}:${port}/`,
        healthEndpoint: `http://${host}:${port}/healthz`,
        status: 'running',
        mode: result.mode,
        pid: result.pid,
        processAlive: isPidAlive(result.pid),
        heartbeatPath: result.heartbeat?.path,
        heartbeatUpdatedAt: result.heartbeat?.updatedAt,
        commandDigest: contract.commandPlan.digest,
        commandDisplay: contract.commandPlan.display,
        logs: result.logs,
        startedAt: result.startedAt,
        claimedAt: updatedAt,
        lockToken: lock?.token,
        source: 'native-lifecycle-daemon-start',
    };
    const managed = {
        version: 1,
        kind: 'harmony.managedProcess',
        category: 'native-backend',
        label: 'Harmony native backend daemon',
        workspace: normalizePath(root),
        pid: result.pid,
        processAlive: owner.processAlive,
        status: owner.status,
        host,
        port,
        url: owner.backendUrl,
        healthEndpoint: owner.healthEndpoint,
        command: contract.commandPlan.display,
        commandDigest: contract.commandPlan.digest,
        stdoutPath: result.logs?.stdoutPath,
        stderrPath: result.logs?.stderrPath,
        heartbeatPath: owner.heartbeatPath,
        startedAt: result.startedAt,
        updatedAt,
        ownerPath: normalizePath(ownerPath),
    };
    await fsp.mkdir(path.dirname(ownerPath), { recursive: true });
    await fsp.mkdir(path.dirname(managedProcessPath), { recursive: true });
    await fsp.writeFile(ownerPath, JSON.stringify(owner, null, 2), 'utf8');
    await fsp.writeFile(managedProcessPath, JSON.stringify(managed, null, 2), 'utf8');
    return { owner: { ...owner, path: normalizePath(ownerPath) }, managedProcess: { ...managed, path: normalizePath(managedProcessPath) } };
}

async function runNativeLifecycleDaemonStart(root, contract, options) {
    const beforeHealth = contract.healthProbe || {};
    let mode = 'started';
    let spawnedPid;
    let logs;
    let startedAt;
    if (beforeHealth.status === 'passed' && beforeHealth.workspaceMatches !== false) {
        mode = 'reused';
    } else {
        const spawnPlan = nativeLifecycleDaemonStartSpawnPlan(root, { backend: { host: contract.portPlan.host, port: contract.portPlan.port } });
        await fsp.mkdir(path.dirname(spawnPlan.stdoutPath), { recursive: true });
        const stdoutFd = fs.openSync(spawnPlan.stdoutPath, 'a');
        const stderrFd = fs.openSync(spawnPlan.stderrPath, 'a');
        try {
            const child = childProcess.spawn(spawnPlan.command, spawnPlan.args, {
                cwd: spawnPlan.cwd,
                detached: true,
                stdio: ['ignore', stdoutFd, stderrFd],
                windowsHide: true,
            });
            spawnedPid = child.pid;
            startedAt = new Date().toISOString();
            child.unref();
        } finally {
            fs.closeSync(stdoutFd);
            fs.closeSync(stderrFd);
        }
        logs = { stdoutPath: normalizePath(spawnPlan.stdoutPath), stderrPath: normalizePath(spawnPlan.stderrPath) };
        await waitForLocalHttpOk(spawnPlan.healthEndpoint, Number(options['ready-timeout-ms'] || 20000));
    }
    const healthMetadata = {
        backend: { host: contract.portPlan.host, port: contract.portPlan.port },
        generatedBy: { workspace: normalizePath(root) },
    };
    const healthProbe = await probeNativeLifecycleHealth(healthMetadata, options);
    if (healthProbe.status !== 'passed' || healthProbe.workspaceMatches === false) throw new Error(`Native backend health proof failed after daemon start: ${healthProbe.status}`);
    const heartbeat = await readNativeLifecycleBackendHeartbeat(healthProbe);
    const pid = Number(heartbeat?.pid || spawnedPid);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error('Native backend did not produce a usable heartbeat pid.');
    if (!isPidAlive(pid)) throw new Error(`Native backend pid is not alive: ${pid}`);
    return { mode, pid, spawnedPid, startedAt, logs, healthProbe, heartbeat };
}

async function nativeLifecycleDaemonStartActionPreview(root, options) {
    const contract = await nativeLifecycleDaemonStartContract(root, options);
    return {
        action: 'native-lifecycle-daemon-start',
        version: contract.packageVersion,
        workspace: normalizePath(root),
        target: {
            allowed: contract.startExecuteStatus === 'passed',
            kind: 'native-lifecycle.backendDaemonStart',
            startExecuteStatus: contract.startExecuteStatus,
            portPlanStatus: contract.portPlan.status,
            commandDigest: contract.commandPlan.digest,
            backendUrl: `http://${contract.portPlan.host}:${contract.portPlan.port}/`,
        },
        summary: {
            posture: contract.posture,
            startExecuteStatus: contract.startExecuteStatus,
            portPlanStatus: contract.portPlan.status,
            healthProbeStatus: contract.healthProbe?.status || 'unknown',
            latestStartPreflightStatus: contract.latestStartPreflight?.status || 'missing',
            authority: contract.authority,
        },
        requiredConfirmation: nativeLifecycleDaemonStartConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-daemon-start.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-daemon-start-<timestamp>.json')),
            contract.ownerRecordPath,
            contract.managedProcessPath,
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-daemon-start-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'requires a passed Native Lifecycle Start Preflight for the same package version and command digest',
            'acquires an atomic single-owner daemon-start lock before any spawn or ownership write',
            'starts or reuses only a loopback Harmony UI backend and proves /healthz plus heartbeat pid before reporting running',
            'does not open native windows, stop, kill, restart, install, reload, call providers, mutate git, run arbitrary commands, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleDaemonStart(root, options) {
    const report = {
        version: 1,
        kind: 'native-lifecycle.daemonStart',
        generatedAt: new Date().toISOString(),
        workspace: root,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contractBefore: undefined,
        result: undefined,
        owner: undefined,
        managedProcess: undefined,
        error: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleDaemonStartLock(root, options);
        report.lock = lock;
        const contract = await nativeLifecycleDaemonStartContract(root, options);
        report.contractBefore = contract;
        if (contract.startExecuteStatus !== 'passed') {
            report.status = 'blocked';
            report.error = 'Native backend daemon start checks did not pass.';
        } else {
            const result = await runNativeLifecycleDaemonStart(root, contract, options);
            const ownerRecords = await writeNativeLifecycleBackendOwner(root, contract, result, lock);
            await appendSupervisorEvent(root, { timestamp: new Date().toISOString(), kind: `native-daemon-${result.mode}`, surface: 'native-backend', pid: result.pid, label: 'Harmony native backend daemon', host: contract.portPlan.host, port: contract.portPlan.port });
            report.result = result;
            report.owner = ownerRecords.owner;
            report.managedProcess = ownerRecords.managedProcess;
            report.status = 'passed';
        }
    } catch (error) {
        report.status = 'failed';
        report.error = error && error.message ? error.message : String(error);
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleDaemonStartLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-daemon-start-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.daemonStart',
        label: `Native backend daemon start ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version: report.contractBefore?.packageVersion || 'unknown',
        mode: report.result?.mode || 'none',
        pid: report.result?.pid,
        backendUrl: report.owner?.backendUrl,
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleWindowOpenLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-window-open.lock.json');
}

function nativeLifecycleWindowOwnerPath(root, host, port) {
    return harmonyPath(root, 'native-lifecycle', `native-window-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}.owner.json`);
}

function nativeLifecycleWindowManagedProcessPath(root, host, port) {
    return harmonyPath(root, 'processes', 'managed', `native-window-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}.json`);
}

async function acquireNativeLifecycleWindowOpenLock(root, options) {
    const lockPath = nativeLifecycleWindowOpenLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.windowOpen.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.windowOpen',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle window open is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleWindowOpenLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function nativeLifecycleWindowOpenPlan(root, host, port) {
    const native = nativeUiNpmSpawn();
    const backendUrl = `http://${host}:${port}/`;
    const openedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = harmonyPath(root, 'native-lifecycle', 'logs');
    const plan = {
        command: native.command,
        args: native.args,
        cwd: extensionRoot(),
        commandLine: nativeUiNpmCommandLine(),
        backendUrl,
        stdoutPath: path.join(logDir, `native-window-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}-${openedAt}.stdout.log`),
        stderrPath: path.join(logDir, `native-window-${nativeLifecycleFilePart(host)}-${nativeLifecycleFilePart(port)}-${openedAt}.stderr.log`),
    };
    return {
        ...plan,
        digest: crypto.createHash('sha256').update(JSON.stringify({
            command: plan.command,
            args: plan.args,
            cwd: normalizePath(plan.cwd),
            backendUrl,
            env: ['HARMONY_NATIVE_BACKEND_URL', 'VITE_HARMONY_NATIVE_BACKEND_URL'],
        })).digest('hex'),
    };
}

async function nativeLifecycleWindowOpenContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    const backendOwnerPath = nativeLifecycleBackendOwnerPath(root, host, port);
    const backendOwner = await readJson(backendOwnerPath);
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const windowPlan = nativeLifecycleWindowOpenPlan(root, host, port);
    const windowOwnerPath = nativeLifecycleWindowOwnerPath(root, host, port);
    const existingWindowOwner = await readJson(windowOwnerPath);
    const nativePackageExists = await pathExists(path.join(extensionRoot(), 'native-ui', 'package.json'));
    const tauriConfigExists = await pathExists(path.join(extensionRoot(), 'native-ui', 'src-tauri', 'tauri.conf.json'));
    const backendOwnerAlive = backendOwner?.pid ? isPidAlive(backendOwner.pid) : false;
    const existingWindowAlive = existingWindowOwner?.pid ? isPidAlive(existingWindowOwner.pid) : false;
    const checks = [
        {
            name: 'backend daemon owner record exists for host and port',
            status: backendOwner ? 'passed' : 'failed',
            detail: normalizePath(backendOwnerPath),
        },
        {
            name: 'backend daemon owner pid is alive',
            status: backendOwnerAlive ? 'passed' : 'failed',
            detail: String(backendOwner?.pid || 'missing'),
        },
        {
            name: 'backend health passes for target workspace',
            status: healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false ? 'passed' : 'failed',
            detail: `${healthProbe.endpoint || 'unknown'} ${healthProbe.status || 'unknown'}`,
        },
        {
            name: 'native ui package exists',
            status: nativePackageExists ? 'passed' : 'failed',
            detail: normalizePath(path.join(extensionRoot(), 'native-ui', 'package.json')),
        },
        {
            name: 'tauri config exists',
            status: tauriConfigExists ? 'passed' : 'failed',
            detail: normalizePath(path.join(extensionRoot(), 'native-ui', 'src-tauri', 'tauri.conf.json')),
        },
        {
            name: 'fixed native window command digest recorded',
            status: windowPlan.digest ? 'passed' : 'failed',
            detail: windowPlan.digest,
        },
        {
            name: 'window owner is absent or already Harmony-owned',
            status: !existingWindowOwner || existingWindowOwner.source === 'native-lifecycle-window-open' ? 'passed' : 'failed',
            detail: existingWindowOwner ? `${existingWindowOwner.source || 'unknown'} pid=${existingWindowOwner.pid || 'unknown'} alive=${existingWindowAlive ? 'yes' : 'no'}` : 'none',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    return {
        posture: 'expert-gated-window-open',
        windowOpenStatus: status,
        packageVersion: metadata.version,
        backend: {
            host,
            port,
            url: `http://${host}:${port}/`,
            ownerPath: normalizePath(backendOwnerPath),
            ownerPid: backendOwner?.pid,
            ownerAlive: backendOwnerAlive,
            healthProbe,
        },
        windowPlan: {
            command: normalizePath(windowPlan.command),
            args: windowPlan.args.map(arg => normalizePath(arg)),
            cwd: normalizePath(windowPlan.cwd),
            commandLine: windowPlan.commandLine,
            backendUrl: windowPlan.backendUrl,
            stdoutPath: normalizePath(windowPlan.stdoutPath),
            stderrPath: normalizePath(windowPlan.stderrPath),
            digest: windowPlan.digest,
        },
        existingWindow: existingWindowOwner ? {
            ownerPath: normalizePath(windowOwnerPath),
            pid: existingWindowOwner.pid,
            processAlive: existingWindowAlive,
            source: existingWindowOwner.source,
        } : undefined,
        ownerRecordPath: normalizePath(windowOwnerPath),
        managedProcessPath: normalizePath(nativeLifecycleWindowManagedProcessPath(root, host, port)),
        checks,
        authority: {
            opensNativeWindow: status === 'passed' && !existingWindowAlive,
            reusesExistingWindow: existingWindowAlive,
            startsLocalBackend: false,
            stopsOrKillsProcesses: false,
            providerCalls: false,
            toolExecution: false,
            gitMutation: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        blockedAuthorityClasses: [
            'starting or restarting the backend from this window action',
            'stopping, killing, restarting, or relaunching processes from this action',
            'installing VSIX packages or reloading editors from this action',
            'provider calls, source edits, git mutations, arbitrary commands, or chat deletion from this action',
        ],
    };
}

async function writeNativeLifecycleWindowOwner(root, contract, result, lock) {
    const host = contract.backend.host;
    const port = contract.backend.port;
    const ownerPath = nativeLifecycleWindowOwnerPath(root, host, port);
    const managedProcessPath = nativeLifecycleWindowManagedProcessPath(root, host, port);
    const updatedAt = new Date().toISOString();
    const owner = {
        version: 1,
        kind: 'native-lifecycle.window.owner',
        workspace: normalizePath(root),
        host,
        port,
        backendUrl: contract.backend.url,
        status: 'running',
        mode: result.mode,
        pid: result.pid,
        processAlive: isPidAlive(result.pid),
        commandDigest: contract.windowPlan.digest,
        commandLine: contract.windowPlan.commandLine,
        logs: result.logs,
        openedAt: result.openedAt,
        claimedAt: updatedAt,
        lockToken: lock?.token,
        backendOwnerPath: contract.backend.ownerPath,
        source: 'native-lifecycle-window-open',
    };
    const managed = {
        version: 1,
        kind: 'harmony.managedProcess',
        category: 'native-window',
        label: 'Harmony native control window',
        workspace: normalizePath(root),
        pid: result.pid,
        processAlive: owner.processAlive,
        status: owner.status,
        host,
        port,
        backendUrl: owner.backendUrl,
        command: contract.windowPlan.commandLine,
        commandDigest: contract.windowPlan.digest,
        stdoutPath: result.logs?.stdoutPath,
        stderrPath: result.logs?.stderrPath,
        openedAt: result.openedAt,
        updatedAt,
        ownerPath: normalizePath(ownerPath),
    };
    await fsp.mkdir(path.dirname(ownerPath), { recursive: true });
    await fsp.mkdir(path.dirname(managedProcessPath), { recursive: true });
    await fsp.writeFile(ownerPath, JSON.stringify(owner, null, 2), 'utf8');
    await fsp.writeFile(managedProcessPath, JSON.stringify(managed, null, 2), 'utf8');
    return { owner: { ...owner, path: normalizePath(ownerPath) }, managedProcess: { ...managed, path: normalizePath(managedProcessPath) } };
}

async function runNativeLifecycleWindowOpen(root, contract, options) {
    if (contract.existingWindow?.processAlive) {
        return { mode: 'reused', pid: Number(contract.existingWindow.pid), logs: undefined, openedAt: undefined };
    }
    const host = contract.backend.host;
    const port = contract.backend.port;
    const plan = nativeLifecycleWindowOpenPlan(root, host, port);
    await fsp.mkdir(path.dirname(plan.stdoutPath), { recursive: true });
    const stdoutFd = fs.openSync(plan.stdoutPath, 'a');
    const stderrFd = fs.openSync(plan.stderrPath, 'a');
    let pid;
    let openedAt;
    try {
        const child = childProcess.spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            detached: true,
            stdio: ['ignore', stdoutFd, stderrFd],
            windowsHide: false,
            env: {
                ...process.env,
                HARMONY_NATIVE_BACKEND_URL: plan.backendUrl,
                VITE_HARMONY_NATIVE_BACKEND_URL: plan.backendUrl,
            },
        });
        pid = child.pid;
        openedAt = new Date().toISOString();
        child.unref();
    } finally {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
    }
    const proofDelayMs = Math.max(500, Math.min(5000, Number(options['window-proof-ms'] || 2000)));
    await new Promise(resolve => setTimeout(resolve, proofDelayMs));
    if (!Number.isFinite(Number(pid)) || !isPidAlive(pid)) throw new Error(`Native window command did not remain alive long enough to record ownership: ${pid || 'missing pid'}`);
    return {
        mode: 'opened',
        pid,
        openedAt,
        logs: { stdoutPath: normalizePath(plan.stdoutPath), stderrPath: normalizePath(plan.stderrPath) },
    };
}

async function nativeLifecycleWindowOpenActionPreview(root, options) {
    const contract = await nativeLifecycleWindowOpenContract(root, options);
    return {
        action: 'native-lifecycle-window-open',
        version: contract.packageVersion,
        workspace: normalizePath(root),
        target: {
            allowed: contract.windowOpenStatus === 'passed',
            kind: 'native-lifecycle.windowOpen',
            windowOpenStatus: contract.windowOpenStatus,
            backendUrl: contract.backend.url,
            commandDigest: contract.windowPlan.digest,
        },
        summary: {
            posture: contract.posture,
            windowOpenStatus: contract.windowOpenStatus,
            backendHealthStatus: contract.backend.healthProbe?.status || 'unknown',
            backendOwnerAlive: contract.backend.ownerAlive,
            existingWindowAlive: Boolean(contract.existingWindow?.processAlive),
            authority: contract.authority,
        },
        requiredConfirmation: nativeLifecycleWindowOpenConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-window-open.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-window-open-<timestamp>.json')),
            contract.ownerRecordPath,
            contract.managedProcessPath,
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-window-open-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'requires a running Harmony-owned backend daemon owner record and matching /healthz workspace proof',
            'acquires an atomic single-owner window-open lock before any window spawn or ownership write',
            'opens or reuses only the fixed Tauri native window command with the proven backend URL',
            'does not start backends, stop, kill, restart, install, reload, call providers, mutate git, run arbitrary commands, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleWindowOpen(root, options) {
    const report = {
        version: 1,
        kind: 'native-lifecycle.windowOpen',
        generatedAt: new Date().toISOString(),
        workspace: root,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contractBefore: undefined,
        result: undefined,
        owner: undefined,
        managedProcess: undefined,
        error: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleWindowOpenLock(root, options);
        report.lock = lock;
        const contract = await nativeLifecycleWindowOpenContract(root, options);
        report.contractBefore = contract;
        if (contract.windowOpenStatus !== 'passed') {
            report.status = 'blocked';
            report.error = 'Native window open checks did not pass.';
        } else {
            const result = await runNativeLifecycleWindowOpen(root, contract, options);
            const ownerRecords = await writeNativeLifecycleWindowOwner(root, contract, result, lock);
            await appendSupervisorEvent(root, { timestamp: new Date().toISOString(), kind: `native-window-${result.mode}`, surface: 'native-window', pid: result.pid, label: 'Harmony native control window', host: contract.backend.host, port: contract.backend.port });
            report.result = result;
            report.owner = ownerRecords.owner;
            report.managedProcess = ownerRecords.managedProcess;
            report.status = 'passed';
        }
    } catch (error) {
        report.status = 'failed';
        report.error = error && error.message ? error.message : String(error);
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleWindowOpenLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-window-open-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.windowOpen',
        label: `Native window open ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version: report.contractBefore?.packageVersion || 'unknown',
        mode: report.result?.mode || 'none',
        pid: report.result?.pid,
        backendUrl: report.owner?.backendUrl,
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleStopPreflightLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-preflight.lock.json');
}

async function acquireNativeLifecycleStopPreflightLock(root, options) {
    const lockPath = nativeLifecycleStopPreflightLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.stopPreflight.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.stopPreflight',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle stop preflight is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleStopPreflightLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function nativeLifecycleStopPlan(root, metadata) {
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    const plan = {
        method: 'future-owned-target-graceful-stop-only',
        workspace: normalizePath(root),
        healthEndpoint: `http://${host}:${port}/healthz`,
        requiresOwnedHeartbeat: true,
        requiresPidReceipt: true,
        killAllowed: false,
        restartAllowed: false,
        arbitraryPidInputAllowed: false,
    };
    return {
        ...plan,
        digest: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    };
}

async function nativeLifecycleStopPreflightContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const latestPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-preflight-');
    const latestStopGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-stop-gate-');
    const latestStartPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-start-preflight-');
    const preflightJson = latestPreflight?.json;
    const stopGateJson = latestStopGate?.json;
    const startPreflightJson = latestStartPreflight?.json;
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const portProbe = await probeNativeLifecyclePortAvailability(metadata);
    const stopPlan = nativeLifecycleStopPlan(root, metadata);
    const packageVersion = metadata.version;
    const latestPreflightSummary = latestPreflight ? {
        path: normalizePath(latestPreflight.path),
        status: preflightJson?.status || 'unknown',
        version: nativeLifecyclePreflightVersion(preflightJson),
        checks: Array.isArray(preflightJson?.checks) ? preflightJson.checks.length : 0,
    } : undefined;
    const latestStopGateSummary = latestStopGate ? {
        path: normalizePath(latestStopGate.path),
        posture: stopGateJson?.contract?.posture || 'unknown',
        version: stopGateJson?.packageVersion || 'unknown',
    } : undefined;
    const latestStartPreflightSummary = latestStartPreflight ? {
        path: normalizePath(latestStartPreflight.path),
        status: startPreflightJson?.status || 'unknown',
        version: startPreflightJson?.packageVersion || 'unknown',
        portPlanStatus: startPreflightJson?.contract?.portPlan?.status || 'unknown',
    } : undefined;
    const existingHealthyBackend = healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false;
    const noRunningTarget = portProbe.status === 'available' && healthProbe.status !== 'passed';
    const targetPlanStatus = existingHealthyBackend ? 'owned-health-target-candidate' : (noRunningTarget ? 'no-running-target' : 'blocked');
    const checks = [
        {
            name: 'fresh lifecycle preflight passed for package version',
            status: latestPreflightSummary?.status === 'passed' && latestPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestPreflightSummary ? `${latestPreflightSummary.status || 'unknown'} ${latestPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'stop gate contract present for package version',
            status: latestStopGateSummary?.posture === 'expert-gated-default-off' && latestStopGateSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStopGateSummary ? `${latestStopGateSummary.posture || 'unknown'} ${latestStopGateSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'start preflight passed for package version',
            status: latestStartPreflightSummary?.status === 'passed' && latestStartPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStartPreflightSummary ? `${latestStartPreflightSummary.status || 'unknown'} ${latestStartPreflightSummary.version || 'unknown'} port=${latestStartPreflightSummary.portPlanStatus || 'unknown'}` : 'missing',
        },
        {
            name: 'fixed stop plan digest recorded',
            status: stopPlan.digest ? 'passed' : 'failed',
            detail: stopPlan.digest,
        },
        {
            name: 'target is healthy workspace backend or no running target exists',
            status: targetPlanStatus === 'owned-health-target-candidate' || targetPlanStatus === 'no-running-target' ? 'passed' : 'failed',
            detail: `${metadata.backend.expectedUrl} target=${targetPlanStatus} port=${portProbe.status} health=${healthProbe.status}`,
        },
        {
            name: 'health workspace is absent or matches target workspace',
            status: healthProbe.workspaceMatches === false ? 'failed' : 'passed',
            detail: healthProbe.workspace || 'no workspace returned',
        },
        {
            name: 'stop authority still blocked',
            status: 'passed',
            detail: 'this action does not stop, kill, restart, signal, install, reload, call providers, mutate git, or delete chats',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
    return {
        posture: 'expert-gated-default-off',
        stopPreflightStatus: status,
        stopStatus: 'blocked-until-a-separate-future-stop-execute-action-cites-this-preflight',
        stopPlan,
        targetPlan: {
            status: targetPlanStatus,
            ownership: existingHealthyBackend ? 'current-loopback-backend-matches-workspace' : (noRunningTarget ? 'no-running-target-detected' : 'blocked-or-unknown-owner'),
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
            managedProcesses: Array.isArray(metadata.supervisor.managedProcesses) ? metadata.supervisor.managedProcesses.length : 0,
        },
        portProbe,
        healthProbe,
        latestPreflight: latestPreflightSummary,
        latestStopGate: latestStopGateSummary,
        latestStartPreflight: latestStartPreflightSummary,
        checks,
        requiredBeforeStopExecute: [
            'fresh Native Lifecycle Stop Preflight must pass for the exact package version',
            'future stop execute must cite this fixed stop plan digest with no arbitrary pid or command input',
            'target process must be proven Harmony-owned with workspace, pid, command digest, heartbeat path, and lifecycle lock token',
            'single-owner native lifecycle stop lock must be acquired before any graceful stop attempt',
            'future stop execute must be graceful only unless a separate kill gate exists and is exact-confirmed',
            'post-stop receipt must include health result, heartbeat result, lock release status, and reconnect instructions',
        ],
        blockedAuthorityClasses: [
            'stopping, killing, or restarting processes from this preflight action',
            'signaling unknown, stale, unrelated, editor, terminal, or non-Harmony-owned processes from this preflight action',
            'starting daemon or opening native windows from this preflight action',
            'installing VSIX packages or reloading editors from this preflight action',
            'provider calls, source edits, git mutations, or chat deletion from this preflight action',
        ],
        notes: [
            'This preflight records the future stop plan digest, health probe, port/target ownership decision, and lifecycle receipt citations only.',
            'No daemon was stopped, killed, restarted, signaled, spawned, relaunched, or opened; no VSIX was installed and no editor was reloaded.',
        ],
    };
}

async function nativeLifecycleStopPreflightActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleStopPreflightContract(root, options);
    return {
        action: 'native-lifecycle-stop-preflight',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.stopPreflight',
            stopExecuteCurrentlyAllowed: false,
            stopPreflightStatus: contract.stopPreflightStatus,
            targetPlanStatus: contract.targetPlan.status,
            stopPlanDigest: contract.stopPlan.digest,
        },
        summary: {
            posture: contract.posture,
            stopPreflightStatus: contract.stopPreflightStatus,
            targetPlanStatus: contract.targetPlan.status,
            healthProbeStatus: contract.healthProbe?.status || 'unknown',
            stopPlanDigest: contract.stopPlan.digest,
            checksPassed: contract.checks.filter(check => check.status === 'passed').length,
            checks: contract.checks.length,
        },
        requiredConfirmation: nativeLifecycleStopPreflightConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-preflight.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-stop-preflight-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'acquires an atomic single-owner stop-preflight lock before writing the report',
            'checks only fixed stop plan digest, loopback health, target ownership posture, and lifecycle receipts',
            'does not stop, kill, restart, signal, spawn, open windows/editors, install, reload, call providers, mutate git, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleStopPreflight(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const report = {
        version: 1,
        kind: 'native-lifecycle.stopPreflight',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contract: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleStopPreflightLock(root, options);
        report.lock = lock;
        report.contract = await nativeLifecycleStopPreflightContract(root, options);
        report.status = report.contract.stopPreflightStatus;
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleStopPreflightLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-stop-preflight-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.stopPreflight',
        label: `Native daemon/window stop preflight ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version,
        targetPlanStatus: report.contract?.targetPlan?.status || 'unknown',
        healthProbeStatus: report.contract?.healthProbe?.status || 'unknown',
        stopPlanDigest: report.contract?.stopPlan?.digest || '',
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleStopExecuteLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-execute.lock.json');
}

async function acquireNativeLifecycleStopExecuteLock(root, options) {
    const lockPath = nativeLifecycleStopExecuteLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.stopExecute.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.stopExecute',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle stop execute is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleStopExecuteLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function nativeLifecycleOwnerWorkspaceMatches(owner, root) {
    return owner?.workspace && normalizePath(owner.workspace) === normalizePath(root);
}

function nativeLifecycleOwnedTarget(kind, ownerPath, managedPath, owner, expected) {
    if (!owner) return undefined;
    const allowedBackendSources = new Set(['native-lifecycle-daemon-start', 'native-lifecycle-reconnect-execute']);
    const allowedWindowSources = new Set(['native-lifecycle-window-open']);
    const sourceAllowed = kind === 'backend' ? allowedBackendSources.has(owner.source) : allowedWindowSources.has(owner.source);
    return {
        kind,
        ownerPath: normalizePath(ownerPath),
        managedPath: normalizePath(managedPath),
        pid: Number(owner.pid),
        source: owner.source || 'unknown',
        status: owner.status || 'unknown',
        workspaceMatches: expected.workspaceMatches,
        commandDigestMatches: expected.commandDigestMatches,
        sourceAllowed,
        processAlive: isPidAlive(owner.pid),
        owner,
    };
}

function nativeLifecycleBackendFromHealthEndpoint(endpoint) {
    try {
        const url = new URL(endpoint);
        return { host: url.hostname || '127.0.0.1', port: Number(url.port || 8788) };
    } catch {
        return { host: '127.0.0.1', port: 8788 };
    }
}

async function nativeLifecycleStopExecuteContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    const stopPlan = nativeLifecycleStopPlan(root, metadata);
    const commandPlan = nativeLifecycleStartCommandPlan(root, metadata);
    const latestStopPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-stop-preflight-');
    const stopPreflightJson = latestStopPreflight?.json;
    const latestStopPreflightSummary = latestStopPreflight ? {
        path: normalizePath(latestStopPreflight.path),
        status: stopPreflightJson?.status || 'unknown',
        version: stopPreflightJson?.packageVersion || 'unknown',
        stopPlanDigest: stopPreflightJson?.contract?.stopPlan?.digest || '',
        targetPlanStatus: stopPreflightJson?.contract?.targetPlan?.status || 'unknown',
    } : undefined;
    const backendOwnerPath = nativeLifecycleBackendOwnerPath(root, host, port);
    const windowOwnerPath = nativeLifecycleWindowOwnerPath(root, host, port);
    const backendManagedPath = nativeLifecycleBackendManagedProcessPath(root, host, port);
    const windowManagedPath = nativeLifecycleWindowManagedProcessPath(root, host, port);
    const backendOwner = await readJson(backendOwnerPath);
    const windowOwner = await readJson(windowOwnerPath);
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const backendTarget = nativeLifecycleOwnedTarget('backend', backendOwnerPath, backendManagedPath, backendOwner, {
        workspaceMatches: nativeLifecycleOwnerWorkspaceMatches(backendOwner, root),
        commandDigestMatches: backendOwner?.commandDigest === commandPlan.digest,
    });
    const windowTarget = nativeLifecycleOwnedTarget('window', windowOwnerPath, windowManagedPath, windowOwner, {
        workspaceMatches: nativeLifecycleOwnerWorkspaceMatches(windowOwner, root),
        commandDigestMatches: Boolean(windowOwner?.commandDigest),
    });
    const targets = [windowTarget, backendTarget].filter(target => target && target.processAlive);
    const healthyBackendWithoutAliveOwner = healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false && (!backendTarget || !backendTarget.processAlive);
    const invalidTargets = [windowTarget, backendTarget].filter(target => target && (!target.sourceAllowed || !target.workspaceMatches || !target.commandDigestMatches || !Number.isFinite(target.pid) || target.pid <= 0));
    const checks = [
        {
            name: 'fresh native lifecycle stop preflight passed for package version',
            status: latestStopPreflightSummary?.status === 'passed' && latestStopPreflightSummary.version === metadata.version ? 'passed' : 'failed',
            detail: latestStopPreflightSummary ? `${latestStopPreflightSummary.status || 'unknown'} ${latestStopPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'stop preflight digest matches execute stop plan digest',
            status: latestStopPreflightSummary?.stopPlanDigest === stopPlan.digest ? 'passed' : 'failed',
            detail: stopPlan.digest,
        },
        {
            name: 'only Harmony-owned targets are selected',
            status: invalidTargets.length === 0 && !healthyBackendWithoutAliveOwner ? 'passed' : 'failed',
            detail: `targets=${targets.length} invalid=${invalidTargets.length} healthyBackendWithoutAliveOwner=${healthyBackendWithoutAliveOwner ? 'yes' : 'no'}`,
        },
        {
            name: 'graceful stop only',
            status: stopPlan.killAllowed === false && stopPlan.restartAllowed === false ? 'passed' : 'failed',
            detail: 'SIGTERM only; no force kill and no restart',
        },
        {
            name: 'no arbitrary pid input',
            status: stopPlan.arbitraryPidInputAllowed === false ? 'passed' : 'failed',
            detail: 'targets come only from owner records',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    return {
        posture: 'expert-gated-graceful-stop-only',
        stopExecuteStatus: status,
        packageVersion: metadata.version,
        stopPlan,
        healthProbe,
        latestStopPreflight: latestStopPreflightSummary,
        targets: targets.map(target => ({
            kind: target.kind,
            pid: target.pid,
            source: target.source,
            ownerPath: target.ownerPath,
            managedPath: target.managedPath,
            processAlive: target.processAlive,
        })),
        checks,
        authority: {
            gracefulStopOwnedProcesses: status === 'passed' && targets.length > 0,
            forceKill: false,
            restart: false,
            startsLocalBackend: false,
            opensNativeWindow: false,
            providerCalls: false,
            toolExecution: false,
            gitMutation: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        blockedAuthorityClasses: [
            'force killing processes from this action',
            'stopping unknown, stale, unrelated, editor, terminal, or non-Harmony-owned processes',
            'starting daemon or opening native windows from this action',
            'installing VSIX packages or reloading editors from this action',
            'provider calls, source edits, git mutations, arbitrary commands, or chat deletion from this action',
        ],
    };
}

async function waitForPidExit(pid, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return !isPidAlive(pid);
}

async function updateNativeLifecycleStoppedOwner(target, result) {
    const owner = await readJson(target.ownerPath) || target.owner || {};
    const managed = await readJson(target.managedPath) || {};
    const updatedAt = new Date().toISOString();
    const status = result.afterAlive ? 'stop-requested' : 'stopped';
    const stopFields = {
        status,
        processAlive: result.afterAlive,
        stopRequestedAt: result.requestedAt,
        stoppedAt: result.afterAlive ? undefined : updatedAt,
        lastStopResult: result,
    };
    await fsp.mkdir(path.dirname(target.ownerPath), { recursive: true });
    await fsp.mkdir(path.dirname(target.managedPath), { recursive: true });
    await fsp.writeFile(target.ownerPath, JSON.stringify({ ...owner, ...stopFields }, null, 2), 'utf8');
    await fsp.writeFile(target.managedPath, JSON.stringify({ ...managed, ...stopFields, updatedAt }, null, 2), 'utf8');
    return { ownerPath: target.ownerPath, managedPath: target.managedPath, status };
}

async function runNativeLifecycleStopExecute(root, contract, options) {
    const graceMs = Math.max(1000, Math.min(30000, Number(options['grace-ms'] || 5000)));
    const results = [];
    for (const target of contract.targets) {
        const beforeAlive = isPidAlive(target.pid);
        const requestedAt = new Date().toISOString();
        const deferredSelfStop = target.pid === process.pid;
        let signalSent = false;
        let signalError;
        if (beforeAlive && !deferredSelfStop) {
            try {
                process.kill(target.pid, 'SIGTERM');
                signalSent = true;
            } catch (error) {
                signalError = error && error.message ? error.message : String(error);
            }
        }
        const exited = signalSent ? await waitForPidExit(target.pid, graceMs) : !beforeAlive;
        const afterAlive = isPidAlive(target.pid);
        const result = {
            kind: target.kind,
            pid: target.pid,
            ownerPath: target.ownerPath,
            managedPath: target.managedPath,
            beforeAlive,
            signal: signalSent ? 'SIGTERM' : undefined,
            signalSent,
            signalError,
            graceMs,
            exited,
            afterAlive,
            deferredSelfStop,
            requestedAt,
            status: deferredSelfStop ? 'deferred-self-stop' : (afterAlive ? 'stop-requested' : 'stopped'),
        };
        result.recordUpdate = await updateNativeLifecycleStoppedOwner(target, result).catch(error => ({ error: error && error.message ? error.message : String(error) }));
        results.push(result);
    }
    const backend = nativeLifecycleBackendFromHealthEndpoint(contract.stopPlan.healthEndpoint);
    const postHealth = await probeNativeLifecycleHealth({ backend, generatedBy: { workspace: normalizePath(root) } }, options);
    const hasDeferredSelfStop = results.some(result => result.deferredSelfStop);
    const allTargetsSatisfied = results.every(result => !result.afterAlive || result.deferredSelfStop);
    return {
        status: hasDeferredSelfStop && allTargetsSatisfied ? 'deferred-self-stop' : (allTargetsSatisfied && postHealth.status !== 'passed' ? 'stopped' : 'partial'),
        results,
        postHealth,
        fallback: 'If a target remains alive, this action will not force kill it. Use the owner path and OS process tools only after manual confirmation.',
    };
}

async function nativeLifecycleStopExecuteActionPreview(root, options) {
    const contract = await nativeLifecycleStopExecuteContract(root, options);
    return {
        action: 'native-lifecycle-stop-execute',
        version: contract.packageVersion,
        workspace: normalizePath(root),
        target: {
            allowed: contract.stopExecuteStatus === 'passed',
            kind: 'native-lifecycle.stopExecute',
            stopExecuteStatus: contract.stopExecuteStatus,
            stopPlanDigest: contract.stopPlan.digest,
            targets: contract.targets.length,
        },
        summary: {
            posture: contract.posture,
            stopExecuteStatus: contract.stopExecuteStatus,
            targets: contract.targets.map(target => `${target.kind}:${target.pid}`),
            authority: contract.authority,
        },
        requiredConfirmation: nativeLifecycleStopExecuteConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-execute.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-execute-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-stop-execute-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'requires a passed Native Lifecycle Stop Preflight for the same package version and stop-plan digest',
            'acquires an atomic single-owner stop-execute lock before any graceful stop request',
            'targets only Harmony-owned owner records; no arbitrary pid or command input is accepted',
            'uses SIGTERM only and never force kills, restarts, installs, reloads, calls providers, mutates git, or deletes chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleStopExecute(root, options) {
    const report = {
        version: 1,
        kind: 'native-lifecycle.stopExecute',
        generatedAt: new Date().toISOString(),
        workspace: root,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contractBefore: undefined,
        result: undefined,
        error: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleStopExecuteLock(root, options);
        report.lock = lock;
        const contract = await nativeLifecycleStopExecuteContract(root, options);
        report.contractBefore = contract;
        if (contract.stopExecuteStatus !== 'passed') {
            report.status = 'blocked';
            report.error = 'Native lifecycle stop execute checks did not pass.';
        } else {
            report.result = await runNativeLifecycleStopExecute(root, contract, options);
            report.status = report.result.status === 'stopped' || report.result.status === 'deferred-self-stop' || contract.targets.length === 0 ? 'passed' : 'partial';
        }
    } catch (error) {
        report.status = 'failed';
        report.error = error && error.message ? error.message : String(error);
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleStopExecuteLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-stop-execute-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.stopExecute',
        label: `Native lifecycle stop execute ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version: report.contractBefore?.packageVersion || 'unknown',
        targets: report.contractBefore?.targets?.length || 0,
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function scheduleNativeLifecycleDeferredSelfStop(result) {
    const shouldStopSelf = result?.report?.result?.results?.some(item => item?.deferredSelfStop);
    if (!shouldStopSelf) return;
    const timer = setTimeout(() => {
        try {
            process.kill(process.pid, 'SIGTERM');
        } catch {
            process.exitCode = process.exitCode || 0;
        }
    }, 250);
    if (typeof timer.unref === 'function') timer.unref();
}

function nativeLifecycleReconnectPreflightLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-reconnect-preflight.lock.json');
}

async function acquireNativeLifecycleReconnectPreflightLock(root, options) {
    const lockPath = nativeLifecycleReconnectPreflightLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.reconnectPreflight.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.reconnectPreflight',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle reconnect preflight is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleReconnectPreflightLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function nativeLifecycleReconnectPlan(root, metadata) {
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    const plan = {
        method: 'future-reattach-existing-healthy-backend-only',
        workspace: normalizePath(root),
        healthEndpoint: `http://${host}:${port}/healthz`,
        requiresWorkspaceMatch: true,
        requiresHeartbeatPath: true,
        spawnAllowed: false,
        stopAllowed: false,
        arbitraryUrlInputAllowed: false,
    };
    return {
        ...plan,
        digest: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    };
}

async function nativeLifecycleReconnectPreflightContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const latestPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-preflight-');
    const latestReconnectGate = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-reconnect-gate-');
    const latestStartPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-start-preflight-');
    const latestStopPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-stop-preflight-');
    const preflightJson = latestPreflight?.json;
    const reconnectGateJson = latestReconnectGate?.json;
    const startPreflightJson = latestStartPreflight?.json;
    const stopPreflightJson = latestStopPreflight?.json;
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const portProbe = await probeNativeLifecyclePortAvailability(metadata);
    const reconnectPlan = nativeLifecycleReconnectPlan(root, metadata);
    const packageVersion = metadata.version;
    const latestPreflightSummary = latestPreflight ? {
        path: normalizePath(latestPreflight.path),
        status: preflightJson?.status || 'unknown',
        version: nativeLifecyclePreflightVersion(preflightJson),
        checks: Array.isArray(preflightJson?.checks) ? preflightJson.checks.length : 0,
    } : undefined;
    const latestReconnectGateSummary = latestReconnectGate ? {
        path: normalizePath(latestReconnectGate.path),
        posture: reconnectGateJson?.contract?.posture || 'unknown',
        version: reconnectGateJson?.packageVersion || 'unknown',
        healthProbeStatus: reconnectGateJson?.contract?.healthProbe?.status || 'unknown',
    } : undefined;
    const latestStartPreflightSummary = latestStartPreflight ? {
        path: normalizePath(latestStartPreflight.path),
        status: startPreflightJson?.status || 'unknown',
        version: startPreflightJson?.packageVersion || 'unknown',
    } : undefined;
    const latestStopPreflightSummary = latestStopPreflight ? {
        path: normalizePath(latestStopPreflight.path),
        status: stopPreflightJson?.status || 'unknown',
        version: stopPreflightJson?.packageVersion || 'unknown',
    } : undefined;
    const existingHealthyBackend = healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false;
    const noBackendToReconnect = portProbe.status === 'available' && healthProbe.status !== 'passed';
    const reconnectTargetStatus = existingHealthyBackend ? 'existing-healthy-backend' : (noBackendToReconnect ? 'no-backend-to-reconnect' : 'blocked');
    const checks = [
        {
            name: 'fresh lifecycle preflight passed for package version',
            status: latestPreflightSummary?.status === 'passed' && latestPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestPreflightSummary ? `${latestPreflightSummary.status || 'unknown'} ${latestPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'reconnect gate contract present for package version',
            status: latestReconnectGateSummary?.posture === 'expert-gated-default-off' && latestReconnectGateSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestReconnectGateSummary ? `${latestReconnectGateSummary.posture || 'unknown'} ${latestReconnectGateSummary.version || 'unknown'} health=${latestReconnectGateSummary.healthProbeStatus || 'unknown'}` : 'missing',
        },
        {
            name: 'start preflight passed for package version',
            status: latestStartPreflightSummary?.status === 'passed' && latestStartPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStartPreflightSummary ? `${latestStartPreflightSummary.status || 'unknown'} ${latestStartPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'stop preflight passed for package version',
            status: latestStopPreflightSummary?.status === 'passed' && latestStopPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStopPreflightSummary ? `${latestStopPreflightSummary.status || 'unknown'} ${latestStopPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'fixed reconnect plan digest recorded',
            status: reconnectPlan.digest ? 'passed' : 'failed',
            detail: reconnectPlan.digest,
        },
        {
            name: 'target is existing healthy backend or no backend exists',
            status: reconnectTargetStatus === 'existing-healthy-backend' || reconnectTargetStatus === 'no-backend-to-reconnect' ? 'passed' : 'failed',
            detail: `${metadata.backend.expectedUrl} target=${reconnectTargetStatus} port=${portProbe.status} health=${healthProbe.status}`,
        },
        {
            name: 'health workspace is absent or matches target workspace',
            status: healthProbe.workspaceMatches === false ? 'failed' : 'passed',
            detail: healthProbe.workspace || 'no workspace returned',
        },
        {
            name: 'reconnect authority still blocked',
            status: 'passed',
            detail: 'this action does not reconnect editors, spawn, stop, kill, restart, install, reload, call providers, mutate git, or delete chats',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
    return {
        posture: 'expert-gated-default-off',
        reconnectPreflightStatus: status,
        reconnectStatus: 'blocked-until-a-separate-future-reconnect-execute-action-cites-this-preflight',
        reconnectPlan,
        reconnectTarget: {
            status: reconnectTargetStatus,
            ownership: existingHealthyBackend ? 'current-loopback-backend-matches-workspace' : (noBackendToReconnect ? 'no-backend-to-reconnect' : 'blocked-or-unknown-owner'),
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
        },
        portProbe,
        healthProbe,
        latestPreflight: latestPreflightSummary,
        latestReconnectGate: latestReconnectGateSummary,
        latestStartPreflight: latestStartPreflightSummary,
        latestStopPreflight: latestStopPreflightSummary,
        checks,
        requiredBeforeReconnectExecute: [
            'fresh Native Lifecycle Reconnect Preflight must pass for the exact package version',
            'future reconnect execute must cite this fixed reconnect plan digest with no arbitrary URL or command input',
            'target backend must return a matching workspace and heartbeat path from /healthz before reconnect reports success',
            'if no backend exists, reconnect execute must refuse and point to the separate start preflight/start execute path',
            'post-reconnect receipt must include backend URL, health status, heartbeat path, workspace match, and fallback instructions',
        ],
        blockedAuthorityClasses: [
            'spawning, stopping, killing, restarting, or relaunching processes from this preflight action',
            'opening native windows or editors from this preflight action',
            'installing VSIX packages or reloading editors from this preflight action',
            'provider calls, source edits, git mutations, or chat deletion from this preflight action',
        ],
        notes: [
            'This preflight records the future reconnect plan digest, health probe, backend ownership decision, and lifecycle receipt citations only.',
            'No reconnect was performed, no daemon was started, stopped, killed, restarted, relaunched, or opened; no VSIX was installed and no editor was reloaded.',
        ],
    };
}

async function nativeLifecycleReconnectPreflightActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleReconnectPreflightContract(root, options);
    return {
        action: 'native-lifecycle-reconnect-preflight',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.reconnectPreflight',
            reconnectExecuteCurrentlyAllowed: false,
            reconnectPreflightStatus: contract.reconnectPreflightStatus,
            reconnectTargetStatus: contract.reconnectTarget.status,
            reconnectPlanDigest: contract.reconnectPlan.digest,
        },
        summary: {
            posture: contract.posture,
            reconnectPreflightStatus: contract.reconnectPreflightStatus,
            reconnectTargetStatus: contract.reconnectTarget.status,
            healthProbeStatus: contract.healthProbe?.status || 'unknown',
            reconnectPlanDigest: contract.reconnectPlan.digest,
            checksPassed: contract.checks.filter(check => check.status === 'passed').length,
            checks: contract.checks.length,
        },
        requiredConfirmation: nativeLifecycleReconnectPreflightConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-reconnect-preflight.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-reconnect-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-reconnect-preflight-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'acquires an atomic single-owner reconnect-preflight lock before writing the report',
            'checks only fixed reconnect plan digest, loopback health, backend ownership posture, and lifecycle receipts',
            'does not reconnect editors, spawn, stop, kill, restart, open windows/editors, install, reload, call providers, mutate git, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleReconnectPreflight(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const report = {
        version: 1,
        kind: 'native-lifecycle.reconnectPreflight',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contract: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleReconnectPreflightLock(root, options);
        report.lock = lock;
        report.contract = await nativeLifecycleReconnectPreflightContract(root, options);
        report.status = report.contract.reconnectPreflightStatus;
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleReconnectPreflightLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-reconnect-preflight-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.reconnectPreflight',
        label: `Native backend reconnect preflight ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version,
        reconnectTargetStatus: report.contract?.reconnectTarget?.status || 'unknown',
        healthProbeStatus: report.contract?.healthProbe?.status || 'unknown',
        reconnectPlanDigest: report.contract?.reconnectPlan?.digest || '',
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleRestartPreflightLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-restart-preflight.lock.json');
}

async function acquireNativeLifecycleRestartPreflightLock(root, options) {
    const lockPath = nativeLifecycleRestartPreflightLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.restartPreflight.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.restartPreflight',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle restart preflight is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleRestartPreflightLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function nativeLifecycleRestartPlan(root, metadata) {
    const stopPlan = nativeLifecycleStopPlan(root, metadata);
    const startPlan = nativeLifecycleStartCommandPlan(root, metadata);
    const plan = {
        method: 'future-owned-graceful-stop-then-fixed-start-or-start-only-recovery',
        workspace: normalizePath(root),
        healthEndpoint: stopPlan.healthEndpoint,
        stopPlanDigest: stopPlan.digest,
        startCommandDigest: startPlan.digest,
        requiresOwnedStopTarget: true,
        allowsStartOnlyRecoveryWhenNoBackend: true,
        forceKillAllowed: false,
        arbitraryPidInputAllowed: false,
        arbitraryCommandInputAllowed: false,
        installAllowed: false,
        editorReloadAllowed: false,
    };
    return {
        ...plan,
        digest: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    };
}

async function nativeLifecycleRestartPreflightContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const lifecycleDir = harmonyPath(root, 'native-lifecycle');
    const latestPreflight = await latestJsonFile(lifecycleDir, 'native-lifecycle-preflight-');
    const latestStartGate = await latestJsonFile(lifecycleDir, 'native-lifecycle-start-gate-');
    const latestStopGate = await latestJsonFile(lifecycleDir, 'native-lifecycle-stop-gate-');
    const latestStartPreflight = await latestJsonFile(lifecycleDir, 'native-lifecycle-start-preflight-');
    const latestStopPreflight = await latestJsonFile(lifecycleDir, 'native-lifecycle-stop-preflight-');
    const latestReconnectPreflight = await latestJsonFile(lifecycleDir, 'native-lifecycle-reconnect-preflight-');
    const preflightJson = latestPreflight?.json;
    const startGateJson = latestStartGate?.json;
    const stopGateJson = latestStopGate?.json;
    const startPreflightJson = latestStartPreflight?.json;
    const stopPreflightJson = latestStopPreflight?.json;
    const reconnectPreflightJson = latestReconnectPreflight?.json;
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const portProbe = await probeNativeLifecyclePortAvailability(metadata);
    const restartPlan = nativeLifecycleRestartPlan(root, metadata);
    const stopPlan = nativeLifecycleStopPlan(root, metadata);
    const startCommandPlan = nativeLifecycleStartCommandPlan(root, metadata);
    const packageVersion = metadata.version;
    const latestPreflightSummary = latestPreflight ? {
        path: normalizePath(latestPreflight.path),
        status: preflightJson?.status || 'unknown',
        version: nativeLifecyclePreflightVersion(preflightJson),
    } : undefined;
    const latestStartGateSummary = latestStartGate ? {
        path: normalizePath(latestStartGate.path),
        posture: startGateJson?.contract?.posture || 'unknown',
        version: startGateJson?.packageVersion || 'unknown',
    } : undefined;
    const latestStopGateSummary = latestStopGate ? {
        path: normalizePath(latestStopGate.path),
        posture: stopGateJson?.contract?.posture || 'unknown',
        version: stopGateJson?.packageVersion || 'unknown',
    } : undefined;
    const latestStartPreflightSummary = latestStartPreflight ? {
        path: normalizePath(latestStartPreflight.path),
        status: startPreflightJson?.status || 'unknown',
        version: startPreflightJson?.packageVersion || 'unknown',
        commandDigest: startPreflightJson?.contract?.commandPlan?.digest || '',
    } : undefined;
    const latestStopPreflightSummary = latestStopPreflight ? {
        path: normalizePath(latestStopPreflight.path),
        status: stopPreflightJson?.status || 'unknown',
        version: stopPreflightJson?.packageVersion || 'unknown',
        stopPlanDigest: stopPreflightJson?.contract?.stopPlan?.digest || '',
    } : undefined;
    const latestReconnectPreflightSummary = latestReconnectPreflight ? {
        path: normalizePath(latestReconnectPreflight.path),
        status: reconnectPreflightJson?.status || 'unknown',
        version: reconnectPreflightJson?.packageVersion || 'unknown',
    } : undefined;
    const existingHealthyBackend = healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false;
    const noRunningBackend = portProbe.status === 'available' && healthProbe.status !== 'passed';
    const recoveryMode = existingHealthyBackend ? 'owned-stop-then-fixed-start' : (noRunningBackend ? 'start-only-recovery' : 'blocked');
    const checks = [
        {
            name: 'fresh lifecycle preflight passed for package version',
            status: latestPreflightSummary?.status === 'passed' && latestPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestPreflightSummary ? `${latestPreflightSummary.status || 'unknown'} ${latestPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'start gate contract present for package version',
            status: latestStartGateSummary?.posture === 'expert-gated-default-off' && latestStartGateSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStartGateSummary ? `${latestStartGateSummary.posture || 'unknown'} ${latestStartGateSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'stop gate contract present for package version',
            status: latestStopGateSummary?.posture === 'expert-gated-default-off' && latestStopGateSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestStopGateSummary ? `${latestStopGateSummary.posture || 'unknown'} ${latestStopGateSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'start preflight passed and command digest matches',
            status: latestStartPreflightSummary?.status === 'passed' && latestStartPreflightSummary.version === packageVersion && latestStartPreflightSummary.commandDigest === startCommandPlan.digest ? 'passed' : 'failed',
            detail: latestStartPreflightSummary ? `${latestStartPreflightSummary.status || 'unknown'} ${latestStartPreflightSummary.version || 'unknown'} digest=${latestStartPreflightSummary.commandDigest || 'missing'}` : 'missing',
        },
        {
            name: 'stop preflight passed and stop digest matches',
            status: latestStopPreflightSummary?.status === 'passed' && latestStopPreflightSummary.version === packageVersion && latestStopPreflightSummary.stopPlanDigest === stopPlan.digest ? 'passed' : 'failed',
            detail: latestStopPreflightSummary ? `${latestStopPreflightSummary.status || 'unknown'} ${latestStopPreflightSummary.version || 'unknown'} digest=${latestStopPreflightSummary.stopPlanDigest || 'missing'}` : 'missing',
        },
        {
            name: 'reconnect preflight available for fallback instructions',
            status: latestReconnectPreflightSummary?.status && latestReconnectPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestReconnectPreflightSummary ? `${latestReconnectPreflightSummary.status || 'unknown'} ${latestReconnectPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'fixed restart plan digest recorded',
            status: restartPlan.digest ? 'passed' : 'failed',
            detail: restartPlan.digest,
        },
        {
            name: 'target is owned healthy backend or start-only recovery is possible',
            status: recoveryMode === 'owned-stop-then-fixed-start' || recoveryMode === 'start-only-recovery' ? 'passed' : 'failed',
            detail: `${metadata.backend.expectedUrl} mode=${recoveryMode} port=${portProbe.status} health=${healthProbe.status}`,
        },
        {
            name: 'health workspace is absent or matches target workspace',
            status: healthProbe.workspaceMatches === false ? 'failed' : 'passed',
            detail: healthProbe.workspace || 'no workspace returned',
        },
        {
            name: 'restart authority still blocked',
            status: 'passed',
            detail: 'this action does not stop, kill, signal, spawn, restart, install, reload, call providers, mutate git, or delete chats',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
    return {
        posture: 'expert-gated-default-off',
        restartPreflightStatus: status,
        restartStatus: 'blocked-until-a-separate-future-restart-execute-action-cites-this-preflight',
        restartPlan,
        stopPlan,
        startCommandPlan,
        recovery: {
            mode: recoveryMode,
            canStopThenStart: recoveryMode === 'owned-stop-then-fixed-start',
            canStartOnlyRecover: recoveryMode === 'start-only-recovery',
            activeHeartbeats: metadata.supervisor.active,
            staleHeartbeats: metadata.supervisor.stale,
            managedProcesses: Array.isArray(metadata.supervisor.managedProcesses) ? metadata.supervisor.managedProcesses.length : 0,
        },
        portProbe,
        healthProbe,
        latestPreflight: latestPreflightSummary,
        latestStartGate: latestStartGateSummary,
        latestStopGate: latestStopGateSummary,
        latestStartPreflight: latestStartPreflightSummary,
        latestStopPreflight: latestStopPreflightSummary,
        latestReconnectPreflight: latestReconnectPreflightSummary,
        checks,
        requiredBeforeRestartExecute: [
            'fresh Native Lifecycle Restart Preflight must pass for the exact package version',
            'future restart execute must cite this restart plan digest, stop plan digest, and start command digest with no arbitrary pid, URL, or command input',
            'if a backend is running, target process must be proven Harmony-owned with matching workspace, pid, heartbeat, command digest, and owner record before graceful stop',
            'if no backend is running, restart execute must take the explicit start-only recovery branch and cite the start preflight/daemon-start requirements',
            'single-owner native lifecycle restart lock must be acquired before any future stop/start attempt',
            'future restart execute must use graceful stop only; force kill, editor reload, package install, and unrelated process control remain blocked',
            'post-restart receipt must include pre-health, stop result or start-only reason, start result, post-health, heartbeat path, lock release, and reconnect fallback instructions',
        ],
        blockedAuthorityClasses: [
            'stopping, killing, signaling, spawning, or restarting processes from this preflight action',
            'using arbitrary PID, URL, command, shell, or package input from this preflight action',
            'opening native windows or editors from this preflight action',
            'installing VSIX packages or reloading editors from this preflight action',
            'provider calls, source edits, git mutations, or chat deletion from this preflight action',
        ],
        notes: [
            'This preflight records a fixed restart/recovery plan digest, lifecycle receipt citations, loopback health, port status, and target ownership decision only.',
            'No daemon was stopped, killed, signaled, spawned, restarted, relaunched, or opened; no VSIX was installed and no editor was reloaded.',
        ],
    };
}

async function nativeLifecycleRestartPreflightActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleRestartPreflightContract(root, options);
    return {
        action: 'native-lifecycle-restart-preflight',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.restartPreflight',
            restartExecuteCurrentlyAllowed: false,
            restartPreflightStatus: contract.restartPreflightStatus,
            recoveryMode: contract.recovery.mode,
            restartPlanDigest: contract.restartPlan.digest,
        },
        summary: {
            posture: contract.posture,
            restartPreflightStatus: contract.restartPreflightStatus,
            recoveryMode: contract.recovery.mode,
            healthProbeStatus: contract.healthProbe?.status || 'unknown',
            restartPlanDigest: contract.restartPlan.digest,
            checksPassed: contract.checks.filter(check => check.status === 'passed').length,
            checks: contract.checks.length,
        },
        requiredConfirmation: nativeLifecycleRestartPreflightConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-restart-preflight.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-restart-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-restart-preflight-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'acquires an atomic single-owner restart-preflight lock before writing the report',
            'checks only fixed restart plan digest, lifecycle receipts, loopback health, port status, and ownership posture',
            'does not stop, kill, signal, spawn, restart, open windows/editors, install, reload, call providers, mutate git, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleRestartPreflight(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const report = {
        version: 1,
        kind: 'native-lifecycle.restartPreflight',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contract: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleRestartPreflightLock(root, options);
        report.lock = lock;
        report.contract = await nativeLifecycleRestartPreflightContract(root, options);
        report.status = report.contract.restartPreflightStatus;
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleRestartPreflightLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-restart-preflight-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.restartPreflight',
        label: `Native backend restart preflight ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version,
        recoveryMode: report.contract?.recovery?.mode || 'unknown',
        healthProbeStatus: report.contract?.healthProbe?.status || 'unknown',
        restartPlanDigest: report.contract?.restartPlan?.digest || '',
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

async function nativeLifecycleRestartExecuteGateContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const packageVersion = metadata.version;
    const latestRestartPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-restart-preflight-');
    const restartPreflightJson = latestRestartPreflight?.json;
    const preflightContract = restartPreflightJson?.contract || {};
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const latestRestartPreflightSummary = latestRestartPreflight ? {
        path: normalizePath(latestRestartPreflight.path),
        status: restartPreflightJson?.status || 'unknown',
        version: restartPreflightJson?.packageVersion || 'unknown',
        restartPlanDigest: preflightContract.restartPlan?.digest || '',
        recoveryMode: preflightContract.recovery?.mode || 'unknown',
    } : undefined;
    const checks = [
        {
            name: 'restart preflight passed for package version',
            status: latestRestartPreflightSummary?.status === 'passed' && latestRestartPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestRestartPreflightSummary ? `${latestRestartPreflightSummary.status || 'unknown'} ${latestRestartPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'restart preflight recorded fixed restart plan digest',
            status: latestRestartPreflightSummary?.restartPlanDigest ? 'passed' : 'failed',
            detail: latestRestartPreflightSummary?.restartPlanDigest || 'missing',
        },
        {
            name: 'restart recovery mode is explicit',
            status: ['owned-stop-then-fixed-start', 'start-only-recovery'].includes(latestRestartPreflightSummary?.recoveryMode || '') ? 'passed' : 'failed',
            detail: latestRestartPreflightSummary?.recoveryMode || 'missing',
        },
        {
            name: 'current health is not an unrelated workspace',
            status: healthProbe.workspaceMatches === false ? 'failed' : 'passed',
            detail: healthProbe.workspace || 'no workspace returned',
        },
        {
            name: 'restart execute authority still blocked',
            status: 'passed',
            detail: 'this gate does not stop, kill, signal, spawn, restart, install, reload, call providers, mutate git, or delete chats',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
    return {
        posture: 'expert-gated-default-off',
        restartExecuteGateStatus: status,
        restartExecuteStatus: 'blocked-until-a-separate-future-restart-execute-action-cites-this-gate-and-the-restart-preflight',
        latestRestartPreflight: latestRestartPreflightSummary,
        currentHealthProbe: healthProbe,
        proposedFutureExecute: {
            mode: latestRestartPreflightSummary?.recoveryMode || 'unknown',
            restartPlanDigest: latestRestartPreflightSummary?.restartPlanDigest || '',
            forceKillAllowed: false,
            arbitraryPidInputAllowed: false,
            arbitraryCommandInputAllowed: false,
            installAllowed: false,
            editorReloadAllowed: false,
        },
        checks,
        requiredBeforeRestartExecute: [
            'fresh Restart Execute Gate must pass for the exact package version',
            'future execute must cite both the gate receipt and the latest Restart Preflight receipt with matching restart plan digest',
            'future execute must acquire a single-owner restart-execute lock before any process action',
            'future execute must re-probe health immediately before acting and refuse unrelated workspace backends',
            'owned-stop-then-fixed-start mode may gracefully stop only Harmony-owned target records, then use the fixed start command digest',
            'start-only-recovery mode may start only through the existing daemon-start path and must refuse arbitrary command input',
            'future execute must write a post-action receipt with pre-health, stop/start results, post-health, heartbeat path, lock release, and reconnect fallback instructions',
        ],
        blockedAuthorityClasses: [
            'stopping, killing, signaling, spawning, or restarting processes from this gate action',
            'using arbitrary PID, URL, command, shell, or package input from this gate action',
            'opening native windows or editors from this gate action',
            'installing VSIX packages or reloading editors from this gate action',
            'provider calls, source edits, git mutations, or chat deletion from this gate action',
        ],
        notes: [
            'This gate is report-only. It validates restart preflight evidence and records future execute requirements only.',
            'No daemon was stopped, killed, signaled, spawned, restarted, relaunched, or opened; no VSIX was installed and no editor was reloaded.',
        ],
    };
}

async function nativeLifecycleRestartExecuteGateActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleRestartExecuteGateContract(root, options);
    return {
        action: 'native-lifecycle-restart-execute-gate',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'native-lifecycle.restartExecuteGate',
            restartExecuteCurrentlyAllowed: false,
            restartExecuteGateStatus: contract.restartExecuteGateStatus,
            recoveryMode: contract.proposedFutureExecute.mode,
            restartPlanDigest: contract.proposedFutureExecute.restartPlanDigest,
        },
        summary: {
            posture: contract.posture,
            restartExecuteGateStatus: contract.restartExecuteGateStatus,
            recoveryMode: contract.proposedFutureExecute.mode,
            restartPlanDigest: contract.proposedFutureExecute.restartPlanDigest,
            checksPassed: contract.checks.filter(check => check.status === 'passed').length,
            checks: contract.checks.length,
        },
        requiredConfirmation: nativeLifecycleRestartExecuteGateConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-restart-execute-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-restart-execute-gate-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'cites the latest restart preflight and fixed restart plan digest',
            'does not stop, kill, signal, spawn, restart, open windows/editors, install, reload, call providers, mutate git, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleRestartExecuteGate(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await nativeLifecycleRestartExecuteGateContract(root, options);
    const report = {
        version: 1,
        kind: 'native-lifecycle.restartExecuteGate',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        status: contract.restartExecuteGateStatus,
        contract,
    };
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-restart-execute-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.restartExecuteGate',
        label: `Native restart execute gate ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version,
        recoveryMode: contract.proposedFutureExecute.mode,
        restartPlanDigest: contract.proposedFutureExecute.restartPlanDigest,
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleRestartExecuteLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-restart-execute.lock.json');
}

async function acquireNativeLifecycleRestartExecuteLock(root, options) {
    const lockPath = nativeLifecycleRestartExecuteLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.restartExecute.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.restartExecute',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle restart execute is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleRestartExecuteLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

async function nativeLifecycleRestartExecuteContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const packageVersion = metadata.version;
    const lifecycleDir = harmonyPath(root, 'native-lifecycle');
    const latestRestartPreflight = await latestJsonFile(lifecycleDir, 'native-lifecycle-restart-preflight-');
    const latestRestartExecuteGate = await latestJsonFile(lifecycleDir, 'native-lifecycle-restart-execute-gate-');
    const restartPreflightJson = latestRestartPreflight?.json;
    const restartExecuteGateJson = latestRestartExecuteGate?.json;
    const preflightContract = restartPreflightJson?.contract || {};
    const gateContract = restartExecuteGateJson?.contract || {};
    const restartPlan = nativeLifecycleRestartPlan(root, metadata);
    const stopPlan = nativeLifecycleStopPlan(root, metadata);
    const startCommandPlan = nativeLifecycleStartCommandPlan(root, metadata);
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const portProbe = await probeNativeLifecyclePortAvailability(metadata);
    const stopExecuteContract = await nativeLifecycleStopExecuteContract(root, options);
    const daemonStartContract = await nativeLifecycleDaemonStartContract(root, options);
    const latestRestartPreflightSummary = latestRestartPreflight ? {
        path: normalizePath(latestRestartPreflight.path),
        status: restartPreflightJson?.status || 'unknown',
        version: restartPreflightJson?.packageVersion || 'unknown',
        restartPlanDigest: preflightContract.restartPlan?.digest || '',
        stopPlanDigest: preflightContract.restartPlan?.stopPlanDigest || '',
        startCommandDigest: preflightContract.restartPlan?.startCommandDigest || '',
        recoveryMode: preflightContract.recovery?.mode || 'unknown',
    } : undefined;
    const latestRestartExecuteGateSummary = latestRestartExecuteGate ? {
        path: normalizePath(latestRestartExecuteGate.path),
        status: restartExecuteGateJson?.status || 'unknown',
        version: restartExecuteGateJson?.packageVersion || 'unknown',
        restartPlanDigest: gateContract.proposedFutureExecute?.restartPlanDigest || '',
        recoveryMode: gateContract.proposedFutureExecute?.mode || 'unknown',
    } : undefined;
    const recoveryMode = latestRestartExecuteGateSummary?.recoveryMode || latestRestartPreflightSummary?.recoveryMode || 'unknown';
    const selfTarget = (stopExecuteContract.targets || []).some(target => Number(target.pid) === process.pid);
    const ownedStopThenStart = recoveryMode === 'owned-stop-then-fixed-start';
    const startOnlyRecovery = recoveryMode === 'start-only-recovery';
    const checks = [
        {
            name: 'restart preflight passed for package version',
            status: latestRestartPreflightSummary?.status === 'passed' && latestRestartPreflightSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestRestartPreflightSummary ? `${latestRestartPreflightSummary.status || 'unknown'} ${latestRestartPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'restart execute gate passed for package version',
            status: latestRestartExecuteGateSummary?.status === 'passed' && latestRestartExecuteGateSummary.version === packageVersion ? 'passed' : 'failed',
            detail: latestRestartExecuteGateSummary ? `${latestRestartExecuteGateSummary.status || 'unknown'} ${latestRestartExecuteGateSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'restart plan digest matches preflight and gate',
            status: latestRestartPreflightSummary?.restartPlanDigest === restartPlan.digest && latestRestartExecuteGateSummary?.restartPlanDigest === restartPlan.digest ? 'passed' : 'failed',
            detail: restartPlan.digest,
        },
        {
            name: 'stop and start plan digests match current fixed plans',
            status: latestRestartPreflightSummary?.stopPlanDigest === stopPlan.digest && latestRestartPreflightSummary?.startCommandDigest === startCommandPlan.digest ? 'passed' : 'failed',
            detail: `stop=${stopPlan.digest} start=${startCommandPlan.digest}`,
        },
        {
            name: 'restart recovery mode is currently executable',
            status: (ownedStopThenStart && healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false) || (startOnlyRecovery && portProbe.status === 'available' && healthProbe.status !== 'passed') ? 'passed' : 'failed',
            detail: `mode=${recoveryMode} health=${healthProbe.status} port=${portProbe.status}`,
        },
        {
            name: 'owned stop branch has stop-execute readiness',
            status: !ownedStopThenStart || stopExecuteContract.stopExecuteStatus === 'passed' ? 'passed' : 'failed',
            detail: ownedStopThenStart ? `${stopExecuteContract.stopExecuteStatus} targets=${(stopExecuteContract.targets || []).length}` : 'not needed for start-only recovery',
        },
        {
            name: 'start branch has daemon-start readiness',
            status: daemonStartContract.startExecuteStatus === 'passed' ? 'passed' : 'failed',
            detail: `${daemonStartContract.startExecuteStatus} port=${daemonStartContract.portPlan?.status || 'unknown'}`,
        },
        {
            name: 'restart execute does not target the current request process',
            status: ownedStopThenStart && selfTarget ? 'failed' : 'passed',
            detail: selfTarget ? 'current backend process requires a separate deferred restart helper' : 'no self-target selected',
        },
        {
            name: 'no arbitrary pid, url, command, install, editor, provider, git, or chat authority',
            status: restartPlan.forceKillAllowed === false
                && restartPlan.arbitraryPidInputAllowed === false
                && restartPlan.arbitraryCommandInputAllowed === false
                && restartPlan.installAllowed === false
                && restartPlan.editorReloadAllowed === false ? 'passed' : 'failed',
            detail: 'restart compose uses existing stop-execute and daemon-start contracts only',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    return {
        posture: 'expert-gated-owned-restart',
        restartExecuteStatus: status,
        packageVersion,
        recoveryMode,
        restartPlan,
        stopPlan,
        startCommandPlan,
        currentHealthProbe: healthProbe,
        currentPortProbe: portProbe,
        latestRestartPreflight: latestRestartPreflightSummary,
        latestRestartExecuteGate: latestRestartExecuteGateSummary,
        stopExecuteContract: {
            stopExecuteStatus: stopExecuteContract.stopExecuteStatus,
            latestStopPreflight: stopExecuteContract.latestStopPreflight,
            targets: stopExecuteContract.targets,
            checks: stopExecuteContract.checks,
        },
        daemonStartContract: {
            startExecuteStatus: daemonStartContract.startExecuteStatus,
            latestStartPreflight: daemonStartContract.latestStartPreflight,
            portPlan: daemonStartContract.portPlan,
            commandPlan: daemonStartContract.commandPlan,
            checks: daemonStartContract.checks,
        },
        checks,
        authority: {
            gracefulStopOwnedProcesses: status === 'passed' && ownedStopThenStart,
            startsLocalBackend: status === 'passed',
            startOnlyRecovery: status === 'passed' && startOnlyRecovery,
            forceKill: false,
            opensNativeWindow: false,
            providerCalls: false,
            toolExecution: false,
            gitMutation: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        blockedAuthorityClasses: [
            'force killing processes from this restart action',
            'stopping unknown, stale, unrelated, editor, terminal, or non-Harmony-owned processes',
            'using arbitrary PID, URL, command, shell, package, provider, git, or chat-deletion input',
            'opening native windows or editors from this restart action',
            'installing VSIX packages or reloading editors from this restart action',
        ],
        notes: [
            'This execute action composes the existing graceful stop-execute and fixed daemon-start paths under a separate restart lock.',
            'When the selected backend target is the current HTTP process, execution is blocked until a deferred helper exists; this prevents returning a false restart receipt.',
        ],
    };
}

async function runNativeLifecycleRestartExecute(root, contract, options) {
    const result = {
        mode: contract.recoveryMode,
        preHealth: contract.currentHealthProbe,
        stop: undefined,
        start: undefined,
        postHealth: undefined,
        fallback: 'If restart fails, run native-lifecycle reconnect against an existing healthy backend or rerun start-preflight then daemon-start.',
        status: 'failed',
    };
    if (contract.recoveryMode === 'owned-stop-then-fixed-start') {
        result.stop = await commandNativeLifecycleStopExecute(root, options);
        if (result.stop.exitCode !== 0) {
            result.status = 'partial';
            return result;
        }
    } else if (contract.recoveryMode !== 'start-only-recovery') {
        result.status = 'blocked';
        return result;
    }
    result.start = await commandNativeLifecycleDaemonStart(root, options);
    const backend = { host: contract.currentPortProbe?.host || '127.0.0.1', port: contract.currentPortProbe?.port || 8788 };
    result.postHealth = await probeNativeLifecycleHealth({ backend, generatedBy: { workspace: normalizePath(root) } }, options);
    const startOk = result.start.exitCode === 0;
    const healthOk = result.postHealth.status === 'passed' && result.postHealth.workspaceMatches !== false;
    result.status = startOk && healthOk ? (contract.recoveryMode === 'start-only-recovery' ? 'started' : 'restarted') : 'partial';
    return result;
}

async function nativeLifecycleRestartExecuteActionPreview(root, options) {
    const contract = await nativeLifecycleRestartExecuteContract(root, options);
    return {
        action: 'native-lifecycle-restart-execute',
        version: contract.packageVersion,
        workspace: normalizePath(root),
        target: {
            allowed: contract.restartExecuteStatus === 'passed',
            kind: 'native-lifecycle.restartExecute',
            restartExecuteStatus: contract.restartExecuteStatus,
            recoveryMode: contract.recoveryMode,
            restartPlanDigest: contract.restartPlan.digest,
            stopTargets: contract.stopExecuteContract.targets.length,
        },
        summary: {
            posture: contract.posture,
            restartExecuteStatus: contract.restartExecuteStatus,
            recoveryMode: contract.recoveryMode,
            restartPlanDigest: contract.restartPlan.digest,
            healthProbeStatus: contract.currentHealthProbe?.status || 'unknown',
            authority: contract.authority,
        },
        requiredConfirmation: nativeLifecycleRestartExecuteConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-restart-execute.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-restart-execute-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-stop-execute-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-daemon-start-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-restart-execute-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'requires a passed Restart Preflight and Restart Execute Gate for the same package version and restart plan digest',
            'acquires an atomic single-owner restart-execute lock before composing stop/start actions',
            'uses only the existing owner-record stop-execute and fixed-command daemon-start paths',
            'never force kills, opens windows/editors, installs, reloads, calls providers, mutates git, runs arbitrary commands, or deletes chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleRestartExecute(root, options) {
    const report = {
        version: 1,
        kind: 'native-lifecycle.restartExecute',
        generatedAt: new Date().toISOString(),
        workspace: root,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contractBefore: undefined,
        result: undefined,
        error: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleRestartExecuteLock(root, options);
        report.lock = lock;
        const contract = await nativeLifecycleRestartExecuteContract(root, options);
        report.contractBefore = contract;
        if (contract.restartExecuteStatus !== 'passed') {
            report.status = 'blocked';
            report.error = 'Native lifecycle restart execute checks did not pass.';
        } else {
            report.result = await runNativeLifecycleRestartExecute(root, contract, options);
            report.status = ['restarted', 'started'].includes(report.result.status) ? 'passed' : 'partial';
        }
    } catch (error) {
        report.status = 'failed';
        report.error = error && error.message ? error.message : String(error);
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleRestartExecuteLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-restart-execute-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.restartExecute',
        label: `Native lifecycle restart execute ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version: report.contractBefore?.packageVersion || 'unknown',
        recoveryMode: report.contractBefore?.recoveryMode || 'unknown',
        restartPlanDigest: report.contractBefore?.restartPlan?.digest || '',
        resultStatus: report.result?.status || 'none',
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function nativeLifecycleReconnectExecuteLockPath(root) {
    return harmonyPath(root, 'native-lifecycle', 'native-lifecycle-reconnect-execute.lock.json');
}

async function acquireNativeLifecycleReconnectExecuteLock(root, options) {
    const lockPath = nativeLifecycleReconnectExecuteLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'native-lifecycle.reconnectExecute.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'native-lifecycle.reconnectExecute',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Native lifecycle reconnect execute is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseNativeLifecycleReconnectExecuteLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

async function nativeLifecycleReconnectExecuteContract(root, options) {
    const metadata = await collectNativeLifecycleMetadata(root, options);
    metadata.generatedBy.workspace = normalizePath(root);
    const host = String(metadata.backend?.host || '127.0.0.1');
    const port = Number(metadata.backend?.port || 8788);
    const reconnectPlan = nativeLifecycleReconnectPlan(root, metadata);
    const latestReconnectPreflight = await latestJsonFile(harmonyPath(root, 'native-lifecycle'), 'native-lifecycle-reconnect-preflight-');
    const reconnectPreflightJson = latestReconnectPreflight?.json;
    const latestReconnectPreflightSummary = latestReconnectPreflight ? {
        path: normalizePath(latestReconnectPreflight.path),
        status: reconnectPreflightJson?.status || 'unknown',
        version: reconnectPreflightJson?.packageVersion || 'unknown',
        reconnectPlanDigest: reconnectPreflightJson?.contract?.reconnectPlan?.digest || '',
        reconnectTargetStatus: reconnectPreflightJson?.contract?.reconnectTarget?.status || 'unknown',
    } : undefined;
    const healthProbe = await probeNativeLifecycleHealth(metadata, options);
    const commandPlan = nativeLifecycleStartCommandPlan(root, metadata);
    const existingHealthyBackend = healthProbe.status === 'passed' && healthProbe.workspaceMatches !== false && Boolean(healthProbe.heartbeatPath);
    const checks = [
        {
            name: 'fresh native lifecycle reconnect preflight passed for package version',
            status: latestReconnectPreflightSummary?.status === 'passed' && latestReconnectPreflightSummary.version === metadata.version ? 'passed' : 'failed',
            detail: latestReconnectPreflightSummary ? `${latestReconnectPreflightSummary.status || 'unknown'} ${latestReconnectPreflightSummary.version || 'unknown'}` : 'missing',
        },
        {
            name: 'reconnect preflight digest matches execute reconnect plan digest',
            status: latestReconnectPreflightSummary?.reconnectPlanDigest === reconnectPlan.digest ? 'passed' : 'failed',
            detail: reconnectPlan.digest,
        },
        {
            name: 'existing healthy backend with heartbeat path',
            status: existingHealthyBackend ? 'passed' : 'failed',
            detail: `${healthProbe.endpoint || 'unknown'} ${healthProbe.status || 'unknown'} heartbeat=${healthProbe.heartbeatPath || 'missing'}`,
        },
        {
            name: 'reconnect does not spawn or stop processes',
            status: reconnectPlan.spawnAllowed === false && reconnectPlan.stopAllowed === false ? 'passed' : 'failed',
            detail: 'reattach existing healthy backend only',
        },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    return {
        posture: 'expert-gated-reconnect-existing-backend-only',
        reconnectExecuteStatus: status,
        packageVersion: metadata.version,
        reconnectPlan,
        commandPlan,
        backend: {
            host,
            port,
            url: `http://${host}:${port}/`,
            healthProbe,
            ownerRecordPath: normalizePath(nativeLifecycleBackendOwnerPath(root, host, port)),
            managedProcessPath: normalizePath(nativeLifecycleBackendManagedProcessPath(root, host, port)),
        },
        latestReconnectPreflight: latestReconnectPreflightSummary,
        checks,
        authority: {
            reconnectsExistingBackend: status === 'passed',
            startsLocalBackend: false,
            opensNativeWindow: false,
            stopsOrKillsProcesses: false,
            providerCalls: false,
            toolExecution: false,
            gitMutation: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        blockedAuthorityClasses: [
            'spawning a missing backend from this reconnect action',
            'stopping, killing, restarting, or relaunching processes from this reconnect action',
            'opening native windows or editors from this reconnect action',
            'installing VSIX packages or reloading editors from this reconnect action',
            'provider calls, source edits, git mutations, arbitrary commands, or chat deletion from this reconnect action',
        ],
        fallback: 'If no healthy backend exists, run native-lifecycle start-preflight and native-lifecycle daemon-start for the same port.',
    };
}

async function runNativeLifecycleReconnectExecute(root, contract, lock) {
    const heartbeat = await readNativeLifecycleBackendHeartbeat(contract.backend.healthProbe);
    const pid = Number(heartbeat?.pid);
    if (!Number.isFinite(pid) || pid <= 0 || !isPidAlive(pid)) throw new Error('Reconnect target heartbeat pid is missing or not alive.');
    const result = {
        mode: 'reconnected',
        pid,
        healthProbe: contract.backend.healthProbe,
        heartbeat,
        startedAt: heartbeat?.updatedAt,
        logs: undefined,
    };
    const ownerRecords = await writeNativeLifecycleBackendOwner(root, {
        portPlan: { host: contract.backend.host, port: contract.backend.port },
        commandPlan: contract.commandPlan,
    }, result, lock);
    const ownerPath = ownerRecords.owner.path;
    const managedProcessPath = ownerRecords.managedProcess.path;
    const owner = { ...ownerRecords.owner, source: 'native-lifecycle-reconnect-execute', mode: 'reconnected' };
    const managedProcess = { ...ownerRecords.managedProcess, status: 'running' };
    delete owner.path;
    delete managedProcess.path;
    await fsp.writeFile(ownerPath, JSON.stringify(owner, null, 2), 'utf8');
    await fsp.writeFile(managedProcessPath, JSON.stringify(managedProcess, null, 2), 'utf8');
    ownerRecords.owner = { ...owner, path: ownerPath };
    ownerRecords.managedProcess = { ...managedProcess, path: managedProcessPath };
    return { ...result, owner: ownerRecords.owner, managedProcess: ownerRecords.managedProcess };
}

async function nativeLifecycleReconnectExecuteActionPreview(root, options) {
    const contract = await nativeLifecycleReconnectExecuteContract(root, options);
    return {
        action: 'native-lifecycle-reconnect-execute',
        version: contract.packageVersion,
        workspace: normalizePath(root),
        target: {
            allowed: contract.reconnectExecuteStatus === 'passed',
            kind: 'native-lifecycle.reconnectExecute',
            reconnectExecuteStatus: contract.reconnectExecuteStatus,
            backendUrl: contract.backend.url,
            reconnectPlanDigest: contract.reconnectPlan.digest,
        },
        summary: {
            posture: contract.posture,
            reconnectExecuteStatus: contract.reconnectExecuteStatus,
            healthProbeStatus: contract.backend.healthProbe?.status || 'unknown',
            authority: contract.authority,
        },
        requiredConfirmation: nativeLifecycleReconnectExecuteConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-reconnect-execute.lock.json')),
            normalizePath(harmonyPath(root, 'native-lifecycle', 'native-lifecycle-reconnect-execute-<timestamp>.json')),
            contract.backend.ownerRecordPath,
            contract.backend.managedProcessPath,
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-lifecycle-reconnect-execute-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => check.name),
        guards: [
            'requires a fresh backend-issued preview receipt plus exact confirmation phrase',
            'requires a passed Native Lifecycle Reconnect Preflight for the same package version and reconnect-plan digest',
            'reattaches only to an existing healthy loopback backend with matching workspace and heartbeat path',
            'does not spawn, stop, kill, restart, open windows/editors, install, reload, call providers, mutate git, or delete chats',
        ],
        contract,
    };
}

async function commandNativeLifecycleReconnectExecute(root, options) {
    const report = {
        version: 1,
        kind: 'native-lifecycle.reconnectExecute',
        generatedAt: new Date().toISOString(),
        workspace: root,
        status: 'failed',
        lock: undefined,
        lockRelease: undefined,
        contractBefore: undefined,
        result: undefined,
        owner: undefined,
        managedProcess: undefined,
        error: undefined,
    };
    let lock;
    try {
        lock = await acquireNativeLifecycleReconnectExecuteLock(root, options);
        report.lock = lock;
        const contract = await nativeLifecycleReconnectExecuteContract(root, options);
        report.contractBefore = contract;
        if (contract.reconnectExecuteStatus !== 'passed') {
            report.status = 'blocked';
            report.error = contract.fallback;
        } else {
            const result = await runNativeLifecycleReconnectExecute(root, contract, lock);
            await appendSupervisorEvent(root, { timestamp: new Date().toISOString(), kind: 'native-daemon-reconnected', surface: 'native-backend', pid: result.pid, label: 'Harmony native backend daemon', host: contract.backend.host, port: contract.backend.port });
            report.result = result;
            report.owner = result.owner;
            report.managedProcess = result.managedProcess;
            report.status = 'passed';
        }
    } catch (error) {
        report.status = 'failed';
        report.error = error && error.message ? error.message : String(error);
    } finally {
        if (lock) report.lockRelease = await releaseNativeLifecycleReconnectExecuteLock(lock).catch(error => ({ released: false, error: error && error.message ? error.message : String(error) }));
    }
    const dir = harmonyPath(root, 'native-lifecycle');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-lifecycle-reconnect-execute-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'native-lifecycle.reconnectExecute',
        label: `Native backend reconnect execute ${report.status}`,
        status: report.status === 'passed' ? 'completed' : 'failed',
        reportPath: normalizePath(outPath),
        version: report.contractBefore?.packageVersion || 'unknown',
        backendUrl: report.owner?.backendUrl,
        pid: report.result?.pid,
    });
    return { exitCode: report.status === 'passed' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function floatingChatNoteMessage(body) {
    const message = String(body?.message || body?.text || '').replace(/\r\n/g, '\n');
    if (!message.trim()) {
        const error = new Error('Floating chat note requires message text.');
        error.statusCode = 400;
        throw error;
    }
    if (message.length > 8000) {
        const error = new Error('Floating chat note is too large. Keep it under 8000 characters.');
        error.statusCode = 400;
        throw error;
    }
    return message;
}

function floatingChatNoteHash(message) {
    return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

function floatingChatTurnHash(message) {
    return floatingChatNoteHash(message);
}

function floatingChatTurnMessage(body) {
    const message = String(body?.message || body?.text || '').replace(/\r\n/g, '\n');
    if (!message.trim()) {
        const error = new Error('Floating chat turn requires message text.');
        error.statusCode = 400;
        throw error;
    }
    if (message.length > 8000) {
        const error = new Error('Floating chat turn is too large. Keep it under 8000 characters.');
        error.statusCode = 400;
        throw error;
    }
    return message;
}

function floatingChatConversationId(body) {
    const raw = String(body?.conversationId || body?.conversation_id || '').trim();
    if (!raw) return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw)) {
        const error = new Error('Floating chat conversation id must be 1-64 path-safe characters: letters, numbers, dot, underscore, or dash.');
        error.statusCode = 400;
        throw error;
    }
    return raw;
}

async function floatingChatNoteActionPreview(root, options, body) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const message = floatingChatNoteMessage(body);
    const hash = floatingChatNoteHash(message);
    return {
        action: 'floating-chat-note',
        version,
        workspace: normalizePath(root),
        target: {
            kind: 'floating-chat.note',
            messageHash: hash,
            messageChars: message.length,
            status: 'captured-for-outside-vs-review',
        },
        summary: {
            messageChars: message.length,
            messageHash: hash.slice(0, 12),
            status: 'ask-only capture; no provider calls or tool execution',
        },
        requiredConfirmation: floatingChatNoteConfirmation(hash),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-note-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-note-<timestamp>.execute.json')),
        ],
        checks: [
            'locks the exact message hash into the preview receipt before saving',
            'does not call providers, execute tools, mutate git, run shell commands, or delete chats',
            'writes an ask-only note under .harmony/floating-chat for later review or broker handoff',
        ],
    };
}

async function commandFloatingChatNote(root, options, message) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const hash = floatingChatNoteHash(message);
    const payload = {
        version: 1,
        kind: 'floating-chat.note',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        message: {
            text: message,
            chars: message.length,
            sha256: hash,
        },
        status: 'captured-for-outside-vs-review',
        retention: {
            deletePolicy: 'never-delete-chat-from-this-action',
            menuClearBehavior: 'hide-only-when-a-future-menu-surface-exists',
        },
        notes: [
            'Ask-only capture. No provider call, tool execution, shell command, git mutation, or chat deletion was performed.',
            'Future floating chat response workflows must use separate preview receipts and explicit authority gates.',
        ],
    };
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-note-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'floating-chat.note',
        label: 'Floating chat ask-only note captured',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version,
        messageHash: hash,
        messageChars: message.length,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

async function floatingChatTurnActionPreview(root, options, body) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const message = floatingChatTurnMessage(body);
    const conversationId = floatingChatConversationId(body);
    const conversationTarget = conversationId || '<new-conversation-id>';
    const hash = floatingChatTurnHash(message);
    return {
        action: 'floating-chat-turn',
        version,
        workspace: normalizePath(root),
        target: {
            kind: 'floating-chat.turn',
            conversationId: conversationTarget,
            messageHash: hash,
            messageChars: message.length,
            responseAuthority: 'blocked-until-explicit-future-gate',
            status: 'conversation-turn-capture-only',
        },
        summary: {
            conversationId: conversationTarget,
            messageChars: message.length,
            messageHash: hash.slice(0, 12),
            status: 'turn capture plus queued response handoff; no provider calls or tool execution',
        },
        requiredConfirmation: floatingChatTurnConfirmation(hash),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'conversations', `${conversationTarget}.json`)),
            normalizePath(harmonyPath(root, 'floating-chat', 'response-requests', 'floating-chat-response-request-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-turn-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-turn-<timestamp>.execute.json')),
        ],
        checks: [
            'locks the exact message hash and conversation target into the preview receipt before saving',
            'records a conversation turn and response handoff request without calling providers or tools',
            'does not mutate git, run shell commands, reload editors, install packages, or delete chats',
        ],
    };
}

async function commandFloatingChatTurn(root, options, message, requestedConversationId) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const hash = floatingChatTurnHash(message);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const conversationId = requestedConversationId || `floating-chat-${timestamp}-${hash.slice(0, 8)}`;
    const turnId = `turn-${timestamp}-${hash.slice(0, 8)}`;
    const baseDir = harmonyPath(root, 'floating-chat');
    const conversationsDir = path.join(baseDir, 'conversations');
    const responseRequestsDir = path.join(baseDir, 'response-requests');
    const conversationPath = path.join(conversationsDir, `${conversationId}.json`);
    await fsp.mkdir(conversationsDir, { recursive: true });
    await fsp.mkdir(responseRequestsDir, { recursive: true });

    const existingConversation = await pathExists(conversationPath);
    let conversation = existingConversation ? await readJson(conversationPath) : undefined;
    if (existingConversation && (!conversation || conversation.kind !== 'floating-chat.conversation' || conversation.conversationId !== conversationId || !Array.isArray(conversation.turns))) {
        const error = new Error('Existing floating chat conversation file is not a valid Harmony conversation record.');
        error.statusCode = 409;
        throw error;
    }
    if (!conversation) {
        conversation = {
            version: 1,
            kind: 'floating-chat.conversation',
            conversationId,
            workspace: root,
            packageVersion: version,
            createdAt: generatedAt,
            updatedAt: generatedAt,
            turns: [],
            retention: {
                deletePolicy: 'never-delete-chat-from-this-action',
                menuClearBehavior: 'hide-only-when-a-future-menu-surface-exists',
            },
        };
    }

    const turn = {
        id: turnId,
        role: 'user',
        createdAt: generatedAt,
        source: 'native-floating-chat',
        message: {
            text: message,
            chars: message.length,
            sha256: hash,
        },
        response: {
            status: 'queued-needs-explicit-response-gate',
            providerCall: 'not-performed',
            toolExecution: 'not-performed',
        },
    };
    conversation.packageVersion = version;
    conversation.updatedAt = generatedAt;
    conversation.turns.push(turn);
    await fsp.writeFile(conversationPath, JSON.stringify(conversation, null, 2), 'utf8');

    const responseRequestPath = path.join(responseRequestsDir, `floating-chat-response-request-${timestamp}.json`);
    const responseRequest = {
        version: 1,
        kind: 'floating-chat.responseRequest',
        generatedAt,
        workspace: root,
        packageVersion: version,
        conversationId,
        turnId,
        messageHash: hash,
        status: 'queued-needs-explicit-response-gate',
        blockedAuthorityClasses: ['provider-call', 'tool-execution', 'shell-command', 'git-mutation', 'chat-deletion'],
        requiredBeforeResponse: [
            'explicit response preview receipt',
            'outside-VS policy and budget check',
            'provider credential source disclosure without secret values',
            'exact user confirmation before any provider call',
        ],
    };
    await fsp.writeFile(responseRequestPath, JSON.stringify(responseRequest, null, 2), 'utf8');

    const report = {
        version: 1,
        kind: 'floating-chat.turn',
        generatedAt,
        workspace: root,
        packageVersion: version,
        conversation: {
            id: conversationId,
            path: normalizePath(conversationPath),
            created: !existingConversation,
            turnCount: conversation.turns.length,
        },
        turn,
        responseRequest: {
            status: responseRequest.status,
            path: normalizePath(responseRequestPath),
            requiredBeforeResponse: responseRequest.requiredBeforeResponse,
        },
        retention: conversation.retention,
        notes: [
            'Conversation turn capture. No provider call, tool execution, shell command, git mutation, editor reload, package install, or chat deletion was performed.',
            'The response request is a durable handoff record only; future response execution must use a separate preview receipt and explicit authority gate.',
        ],
    };
    const reportPath = path.join(baseDir, `floating-chat-turn-${timestamp}.json`);
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'floating-chat.turn',
        label: 'Floating chat conversation turn captured',
        status: 'completed',
        reportPath: normalizePath(reportPath),
        version,
        conversationId,
        turnId,
        messageHash: hash,
        messageChars: message.length,
        responseRequestStatus: responseRequest.status,
    });
    return { exitCode: 0, report: { ...report, reportPath: normalizePath(reportPath) } };
}

async function latestFloatingChatResponseRequest(root, requestedConversationId) {
    const dir = harmonyPath(root, 'floating-chat', 'response-requests');
    const records = await readJsonRecords(dir, 100);
    const valid = records
        .filter(record => record.kind === 'floating-chat.responseRequest')
        .filter(record => !requestedConversationId || record.conversationId === requestedConversationId)
        .sort((left, right) => Date.parse(left.generatedAt || '') - Date.parse(right.generatedAt || ''));
    const latest = valid[valid.length - 1];
    if (!latest) return undefined;
    return {
        file: latest.file,
        path: normalizePath(path.join(dir, latest.file)),
        generatedAt: latest.generatedAt,
        conversationId: latest.conversationId,
        turnId: latest.turnId,
        messageHash: latest.messageHash,
        status: latest.status,
        requiredBeforeResponse: latest.requiredBeforeResponse || [],
        blockedAuthorityClasses: latest.blockedAuthorityClasses || [],
    };
}

async function floatingChatResponseGateContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const conversationId = floatingChatConversationId(body);
    const latestResponseRequest = await latestFloatingChatResponseRequest(root, conversationId);
    const providerRows = providerStatusRows(root).map(provider => ({
        provider: provider.provider,
        configured: provider.configured,
        executable: provider.executable,
        credentialSource: provider.credentialSource,
        credentialName: provider.credentialName,
        stored: provider.stored,
        storedUpdatedAt: provider.storedUpdatedAt,
        defaultModel: provider.defaultModel,
    }));
    const configuredProviders = providerRows.filter(provider => provider.configured).length;
    const checks = [
        { name: 'response_request_present', status: latestResponseRequest ? 'passed' : 'warning', detail: latestResponseRequest ? latestResponseRequest.path : 'no queued response request found' },
        { name: 'provider_metadata_disclosed_without_secret_values', status: 'passed', detail: `${configuredProviders}/${providerRows.length} providers configured` },
        { name: 'response_execute_authority_blocked', status: 'passed', detail: 'no provider call or response generation is allowed by this gate' },
        { name: 'tool_and_shell_authority_blocked', status: 'passed', detail: 'no tool execution, shell command, git mutation, install, reload, or chat deletion is allowed' },
    ];
    return {
        version,
        posture: latestResponseRequest ? 'response-gate-ready-for-future-execute-design' : 'response-gate-waiting-for-turn-capture',
        requestedConversationId: conversationId || undefined,
        latestResponseRequest,
        providerDisclosure: {
            configuredProviders,
            totalProviders: providerRows.length,
            providers: providerRows,
            secretValuesIncluded: false,
        },
        responseExecuteCurrentlyAllowed: false,
        requiredBeforeResponseExecute: [
            'fresh response preview receipt that cites a specific response request',
            'outside-VS policy and budget check immediately before provider execution',
            'provider/model selection and credential source disclosure without secret values',
            'explicit user confirmation for the exact provider call',
            'durable response receipt and operation-ledger entry',
        ],
        blockedAuthorityClasses: ['provider-call', 'tool-execution', 'shell-command', 'git-mutation', 'editor-reload', 'package-install', 'chat-deletion'],
        checks,
        notes: [
            'No provider call, tool execution, shell command, git mutation, editor reload, package install, or chat deletion was performed.',
            'This gate is a contract and readiness report only; a future response execute action must use its own preview receipt and explicit confirmation.',
        ],
    };
}

async function floatingChatResponseGateActionPreview(root, options, body) {
    const contract = await floatingChatResponseGateContract(root, options, body);
    const version = contract.version;
    return {
        action: 'floating-chat-response-gate',
        version,
        workspace: normalizePath(root),
        target: {
            kind: 'floating-chat.responseGate',
            posture: contract.posture,
            requestedConversationId: contract.requestedConversationId || '',
            latestResponseRequestFile: contract.latestResponseRequest?.file || '',
            responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
            configuredProviders: contract.providerDisclosure.configuredProviders,
        },
        summary: {
            posture: contract.posture,
            responseRequestStatus: contract.latestResponseRequest?.status || 'none',
            configuredProviders: contract.providerDisclosure.configuredProviders,
            totalProviders: contract.providerDisclosure.totalProviders,
            responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
        },
        requiredConfirmation: floatingChatResponseGateConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-response-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-response-gate-<timestamp>.execute.json')),
        ],
        checks: [
            'cites the latest queued response request when one exists',
            'discloses provider credential metadata without secret values',
            'keeps provider calls, tools, shell commands, git mutation, installs, reloads, and chat deletion blocked',
        ],
        contract,
    };
}

async function commandFloatingChatResponseGate(root, options, body) {
    const contract = await floatingChatResponseGateContract(root, options, body);
    const generatedAt = new Date().toISOString();
    const report = {
        version: 1,
        kind: 'floating-chat.responseGate',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: 'passed',
        contract,
    };
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-response-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'floating-chat.responseGate',
        label: 'Floating chat response gate recorded',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version: contract.version,
        posture: contract.posture,
        responseRequestFile: contract.latestResponseRequest?.file || '',
        responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
    });
    return { exitCode: 0, report: { ...report, reportPath: normalizePath(outPath) } };
}

async function latestFloatingChatResponseGate(root, requestedConversationId) {
    const dir = harmonyPath(root, 'floating-chat');
    const records = await readJsonRecords(dir, 100);
    const valid = records
        .filter(record => record.kind === 'floating-chat.responseGate')
        .filter(record => !requestedConversationId || record.contract?.latestResponseRequest?.conversationId === requestedConversationId)
        .sort((left, right) => Date.parse(left.generatedAt || '') - Date.parse(right.generatedAt || ''));
    const latest = valid[valid.length - 1];
    if (!latest) return undefined;
    return {
        file: latest.file,
        path: normalizePath(path.join(dir, latest.file)),
        generatedAt: latest.generatedAt,
        status: latest.status,
        posture: latest.contract?.posture,
        responseRequestFile: latest.contract?.latestResponseRequest?.file || '',
        responseExecuteCurrentlyAllowed: latest.contract?.responseExecuteCurrentlyAllowed,
    };
}

async function floatingChatResponsePreflightContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const conversationId = floatingChatConversationId(body);
    const latestResponseRequest = await latestFloatingChatResponseRequest(root, conversationId);
    const latestResponseGate = await latestFloatingChatResponseGate(root, conversationId);
    const policy = await readOutsidePolicy(root) || defaultOutsidePolicy(root);
    const providerRows = providerStatusRows(root).map(provider => ({
        provider: provider.provider,
        configured: provider.configured,
        executable: provider.executable,
        credentialSource: provider.credentialSource,
        credentialName: provider.credentialName,
        stored: provider.stored,
        storedUpdatedAt: provider.storedUpdatedAt,
        defaultModel: provider.defaultModel,
    }));
    const configuredProviders = providerRows.filter(provider => provider.configured).length;
    const executableConfiguredProviders = providerRows.filter(provider => provider.configured && provider.executable).length;
    const paidProviderAllowed = policy.permissions?.paidProviderCalls === true;
    const hasBudget = Number(policy.budgets?.maxEstimatedUsd || 0) > 0;
    const readyForFutureExecute = Boolean(latestResponseRequest && latestResponseGate && paidProviderAllowed && hasBudget && executableConfiguredProviders > 0);
    const checks = [
        { name: 'response_request_present', status: latestResponseRequest ? 'passed' : 'blocked', detail: latestResponseRequest ? latestResponseRequest.path : 'capture a floating chat turn first' },
        { name: 'response_gate_present', status: latestResponseGate ? 'passed' : 'blocked', detail: latestResponseGate ? latestResponseGate.path : 'record a response gate first' },
        { name: 'outside_policy_allows_paid_provider_calls', status: paidProviderAllowed ? 'passed' : 'blocked', detail: paidProviderAllowed ? 'paid provider calls allowed by policy' : 'paid provider calls disabled by outside-VS policy' },
        { name: 'provider_budget_available', status: hasBudget ? 'passed' : 'blocked', detail: hasBudget ? `maxEstimatedUsd=${policy.budgets?.maxEstimatedUsd}` : 'maxEstimatedUsd is 0 or missing' },
        { name: 'configured_executable_provider_available', status: executableConfiguredProviders > 0 ? 'passed' : 'blocked', detail: `${executableConfiguredProviders}/${providerRows.length} configured executable providers` },
        { name: 'response_execute_authority_still_blocked', status: 'passed', detail: 'this preflight does not call providers or generate responses' },
    ];
    return {
        version,
        status: readyForFutureExecute ? 'ready-for-future-response-execute-design' : 'blocked-until-response-requirements-met',
        requestedConversationId: conversationId || undefined,
        latestResponseRequest,
        latestResponseGate,
        policy: {
            mode: policy.mode || 'observe',
            paidProviderCalls: paidProviderAllowed,
            beforePaidProvider: policy.confirmations?.beforePaidProvider !== false,
            maxEstimatedUsd: Number(policy.budgets?.maxEstimatedUsd || 0),
        },
        providerDisclosure: {
            configuredProviders,
            executableConfiguredProviders,
            totalProviders: providerRows.length,
            providers: providerRows,
            secretValuesIncluded: false,
        },
        responseExecuteCurrentlyAllowed: false,
        readyForFutureExecute,
        requiredBeforeResponseExecute: [
            'new response execute action with its own preview receipt',
            'fresh policy, budget, provider, and response request checks at execute time',
            'exact user confirmation naming the provider/model and estimated budget',
            'durable prompt/response receipt that still avoids tool execution unless separately gated',
        ],
        blockedAuthorityClasses: ['provider-call', 'tool-execution', 'shell-command', 'git-mutation', 'editor-reload', 'package-install', 'chat-deletion'],
        checks,
        notes: [
            'No provider call, tool execution, shell command, git mutation, editor reload, package install, or chat deletion was performed.',
            'This preflight can report readiness, but response execution remains unavailable until a separate gated action is built and explicitly confirmed.',
        ],
    };
}

async function floatingChatResponsePreflightActionPreview(root, options, body) {
    const contract = await floatingChatResponsePreflightContract(root, options, body);
    const version = contract.version;
    return {
        action: 'floating-chat-response-preflight',
        version,
        workspace: normalizePath(root),
        target: {
            kind: 'floating-chat.responsePreflight',
            status: contract.status,
            requestedConversationId: contract.requestedConversationId || '',
            latestResponseRequestFile: contract.latestResponseRequest?.file || '',
            latestResponseGateFile: contract.latestResponseGate?.file || '',
            responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
            readyForFutureExecute: contract.readyForFutureExecute,
        },
        summary: {
            status: contract.status,
            responseRequestStatus: contract.latestResponseRequest?.status || 'none',
            responseGateStatus: contract.latestResponseGate?.status || 'none',
            paidProviderCalls: contract.policy.paidProviderCalls,
            executableConfiguredProviders: contract.providerDisclosure.executableConfiguredProviders,
            responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
        },
        requiredConfirmation: floatingChatResponsePreflightConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-response-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-response-preflight-<timestamp>.execute.json')),
        ],
        checks: [
            'cites queued response request and response gate records when present',
            'checks outside-VS paid provider policy and budget without changing them',
            'discloses provider metadata without secret values and performs no provider call',
        ],
        contract,
    };
}

async function commandFloatingChatResponsePreflight(root, options, body) {
    const contract = await floatingChatResponsePreflightContract(root, options, body);
    const generatedAt = new Date().toISOString();
    const report = {
        version: 1,
        kind: 'floating-chat.responsePreflight',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.status,
        contract,
    };
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-response-preflight-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'floating-chat.responsePreflight',
        label: `Floating chat response preflight ${contract.status}`,
        status: 'completed',
        reportPath: normalizePath(outPath),
        version: contract.version,
        responsePreflightStatus: contract.status,
        responseRequestFile: contract.latestResponseRequest?.file || '',
        responseGateFile: contract.latestResponseGate?.file || '',
        responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
    });
    return { exitCode: 0, report: { ...report, reportPath: normalizePath(outPath) } };
}

async function floatingChatResponsePromptData(root, responseRequest) {
    if (!responseRequest?.conversationId) return undefined;
    const conversationPath = path.join(harmonyPath(root, 'floating-chat', 'conversations'), `${responseRequest.conversationId}.json`);
    const conversation = await readJson(conversationPath);
    if (!conversation || conversation.kind !== 'floating-chat.conversation' || conversation.conversationId !== responseRequest.conversationId || !Array.isArray(conversation.turns)) {
        return { valid: false, conversationPath: normalizePath(conversationPath), error: 'conversation record missing or invalid' };
    }
    const targetTurn = conversation.turns.find(turn => turn?.id === responseRequest.turnId);
    if (!targetTurn || targetTurn.message?.sha256 !== responseRequest.messageHash) {
        return { valid: false, conversationPath: normalizePath(conversationPath), error: 'response request does not match a conversation turn' };
    }
    const recentTurns = conversation.turns.slice(-12).map(turn => {
        const role = turn.role === 'assistant' ? 'assistant' : 'user';
        const text = String(turn.message?.text || '').trim();
        return `${role.toUpperCase()}: ${text}`;
    }).filter(Boolean);
    const promptText = [
        'You are Harmony floating chat replying outside VS Code.',
        'Answer the latest user turn directly and concisely.',
        'Do not claim that you executed tools, shell commands, git actions, editor reloads, package installs, or chat deletion.',
        'Conversation:',
        ...recentTurns,
    ].join('\n\n');
    const promptHash = crypto.createHash('sha256').update(promptText).digest('hex');
    return {
        valid: true,
        conversationPath: normalizePath(conversationPath),
        conversation,
        targetTurn,
        promptText,
        prompt: {
            chars: promptText.length,
            sha256: promptHash,
            latestTurnChars: String(targetTurn.message?.text || '').length,
            recentTurnCount: recentTurns.length,
        },
    };
}

async function floatingChatResponseExecuteContract(root, options, body = {}) {
    const preflight = await floatingChatResponsePreflightContract(root, options, body);
    const requestedProvider = String(body?.provider || options.provider || 'auto').toLowerCase().trim() || 'auto';
    const provider = requestedProvider === 'auto' ? selectCliProvider({ ...options, provider: 'auto' }, root) : requestedProvider;
    const providerConfig = CLI_PROVIDER_DEFAULTS[provider];
    const credential = providerConfig ? providerCredential(provider, root) : undefined;
    const model = String(body?.model || options.model || providerConfig?.model || '').trim();
    const maxTokensRaw = Number(body?.maxTokens || body?.['max-tokens'] || options['max-tokens'] || 512);
    const maxTokens = Number.isFinite(maxTokensRaw) ? Math.max(1, Math.min(4096, Math.floor(maxTokensRaw))) : 512;
    const promptData = await floatingChatResponsePromptData(root, preflight.latestResponseRequest);
    const checks = [
        ...(preflight.checks || []),
        { name: 'response_prompt_integrity', status: promptData?.valid ? 'passed' : 'blocked', detail: promptData?.valid ? `prompt ${promptData.prompt.sha256.slice(0, 12)}` : (promptData?.error || 'no prompt can be built') },
        { name: 'provider_known', status: providerConfig ? 'passed' : 'blocked', detail: providerConfig ? provider : `unknown provider ${provider}` },
        { name: 'provider_cli_executable', status: providerConfig?.executable ? 'passed' : 'blocked', detail: providerConfig?.executable ? `${provider} can run from terminal Harmony` : `${provider} is not executable from terminal Harmony` },
        { name: 'provider_credential_available', status: credential ? 'passed' : 'blocked', detail: credential ? `${credential.source}:${credential.name}` : `missing ${provider} credential` },
        { name: 'tool_shell_git_authority_blocked', status: 'passed', detail: 'response execution can call one provider only; tools, shell, git, install, reload, and chat deletion remain blocked' },
    ];
    const responseExecuteCurrentlyAllowed = Boolean(
        preflight.latestResponseRequest
        && preflight.latestResponseGate
        && preflight.policy?.paidProviderCalls
        && Number(preflight.policy?.maxEstimatedUsd || 0) > 0
        && providerConfig?.executable
        && credential
        && promptData?.valid
    );
    return {
        version: preflight.version,
        status: responseExecuteCurrentlyAllowed ? 'ready-for-provider-call' : 'blocked-before-provider-call',
        requestedConversationId: preflight.requestedConversationId,
        latestResponseRequest: preflight.latestResponseRequest,
        latestResponseGate: preflight.latestResponseGate,
        policy: preflight.policy,
        provider: {
            requestedProvider,
            provider,
            model,
            maxTokens,
            executable: Boolean(providerConfig?.executable),
            configured: Boolean(credential),
            credentialSource: credential?.source,
            credentialName: credential?.name,
            secretValueIncluded: false,
        },
        prompt: promptData?.valid ? promptData.prompt : undefined,
        conversationPath: promptData?.conversationPath,
        responseExecuteCurrentlyAllowed,
        blockedAuthorityClasses: ['tool-execution', 'shell-command', 'git-mutation', 'editor-reload', 'package-install', 'chat-deletion'],
        checks,
        notes: [
            'This action may call exactly one configured provider after exact confirmation. It does not execute tools or shell commands.',
            'No provider secret value is written to previews, reports, receipts, or ledgers.',
        ],
    };
}

async function floatingChatResponseExecuteActionPreview(root, options, body) {
    const contract = await floatingChatResponseExecuteContract(root, options, body);
    const version = contract.version;
    return {
        action: 'floating-chat-response-execute',
        version,
        workspace: normalizePath(root),
        target: {
            kind: 'floating-chat.responseExecute',
            status: contract.status,
            conversationId: contract.latestResponseRequest?.conversationId || '',
            turnId: contract.latestResponseRequest?.turnId || '',
            responseRequestFile: contract.latestResponseRequest?.file || '',
            responseGateFile: contract.latestResponseGate?.file || '',
            provider: contract.provider.provider,
            model: contract.provider.model,
            maxTokens: contract.provider.maxTokens,
            promptHash: contract.prompt?.sha256 || '',
            responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
        },
        summary: {
            status: contract.status,
            provider: contract.provider.provider,
            model: contract.provider.model,
            maxTokens: contract.provider.maxTokens,
            promptHash: contract.prompt?.sha256?.slice(0, 12) || 'none',
            paidProviderCalls: contract.policy?.paidProviderCalls,
            budget: contract.policy?.maxEstimatedUsd,
            responseExecuteCurrentlyAllowed: contract.responseExecuteCurrentlyAllowed,
        },
        requiredConfirmation: floatingChatResponseExecuteConfirmation(contract),
        writes: [
            normalizePath(contract.conversationPath || harmonyPath(root, 'floating-chat', 'conversations', '<conversation-id>.json')),
            normalizePath(contract.latestResponseRequest?.path || harmonyPath(root, 'floating-chat', 'response-requests', '<response-request>.json')),
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-response-execute-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-response-execute-<timestamp>.execute.json')),
        ],
        checks: [
            'requires a fresh preview receipt and exact confirmation before any provider call',
            'requires response request, response gate, paid-provider policy, nonzero budget, executable provider, and credential metadata',
            'writes provider/model/usage metadata without secret values and keeps tools, shell, git, install, reload, and chat deletion blocked',
        ],
        contract,
    };
}

async function commandFloatingChatResponseExecute(root, options, body) {
    const contract = await floatingChatResponseExecuteContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-response-execute-${timestamp}.json`);
    const baseReport = {
        version: 1,
        kind: 'floating-chat.responseExecute',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.responseExecuteCurrentlyAllowed ? 'running-provider-call' : 'blocked-before-provider-call',
        contract,
    };
    if (!contract.responseExecuteCurrentlyAllowed) {
        const report = {
            ...baseReport,
            status: 'blocked-before-provider-call',
            providerCall: { performed: false, reason: 'response execution prerequisites are not all satisfied' },
            notes: ['No provider call was made because one or more response execution checks are blocked.'],
        };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.responseExecute', label: 'Floating chat response execute blocked', status: 'blocked', reportPath: normalizePath(outPath), version: contract.version, provider: contract.provider.provider, model: contract.provider.model });
        return { exitCode: 1, report: { ...report, reportPath: normalizePath(outPath) } };
    }

    const promptData = await floatingChatResponsePromptData(root, contract.latestResponseRequest);
    if (!promptData?.valid) throw new Error(promptData?.error || 'Could not rebuild floating chat response prompt.');
    try {
        const execution = await executeTerminalAsk(root, promptData.promptText, {
            ...options,
            provider: contract.provider.provider,
            model: contract.provider.model,
            'max-tokens': contract.provider.maxTokens,
        });
        const responseText = String(execution.text || '').trim();
        if (!responseText) throw new Error('Provider returned an empty response.');
        const responseHash = crypto.createHash('sha256').update(responseText).digest('hex');
        const responseTurnId = `response-${timestamp}-${responseHash.slice(0, 8)}`;
        const conversation = promptData.conversation;
        const targetTurn = conversation.turns.find(turn => turn?.id === contract.latestResponseRequest.turnId);
        const responseTurn = {
            id: responseTurnId,
            role: 'assistant',
            createdAt: generatedAt,
            source: 'native-floating-chat-provider',
            responseToTurnId: contract.latestResponseRequest.turnId,
            provider: {
                provider: execution.provider,
                model: execution.model,
                credentialSource: execution.credentialSource,
                credentialName: execution.credentialName,
            },
            message: { text: responseText, chars: responseText.length, sha256: responseHash },
            usage: execution.usage,
            rawStatus: execution.rawStatus,
            toolExecution: 'not-performed',
        };
        if (targetTurn) targetTurn.response = { status: 'completed', responseTurnId, provider: execution.provider, model: execution.model, toolExecution: 'not-performed' };
        conversation.packageVersion = contract.version;
        conversation.updatedAt = generatedAt;
        conversation.turns.push(responseTurn);
        await fsp.writeFile(promptData.conversationPath, JSON.stringify(conversation, null, 2), 'utf8');
        if (contract.latestResponseRequest?.path) {
            const requestRecord = await readJson(contract.latestResponseRequest.path);
            if (requestRecord) {
                requestRecord.status = 'completed';
                requestRecord.completedAt = generatedAt;
                requestRecord.responseTurnId = responseTurnId;
                requestRecord.provider = execution.provider;
                requestRecord.model = execution.model;
                await fsp.writeFile(contract.latestResponseRequest.path, JSON.stringify(requestRecord, null, 2), 'utf8');
            }
        }
        const report = {
            ...baseReport,
            status: 'completed',
            providerCall: { performed: true, provider: execution.provider, model: execution.model, credentialSource: execution.credentialSource, credentialName: execution.credentialName, secretValueIncluded: false },
            response: responseTurn,
            conversation: { id: conversation.conversationId, path: promptData.conversationPath, turnCount: conversation.turns.length },
            notes: ['Provider response was written to the floating chat conversation. No tools, shell commands, git mutation, package install, editor reload, or chat deletion were performed.'],
        };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.responseExecute', label: 'Floating chat provider response completed', status: 'completed', reportPath: normalizePath(outPath), version: contract.version, provider: execution.provider, model: execution.model, responseTurnId, responseChars: responseText.length });
        return { exitCode: 0, report: { ...report, reportPath: normalizePath(outPath) } };
    } catch (error) {
        const report = {
            ...baseReport,
            status: 'failed',
            providerCall: { performed: true, provider: contract.provider.provider, model: contract.provider.model, secretValueIncluded: false, error: error && error.message ? error.message : String(error) },
            notes: ['Provider response failed. No tools, shell commands, git mutation, package install, editor reload, or chat deletion were performed.'],
        };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.responseExecute', label: 'Floating chat provider response failed', status: 'failed', reportPath: normalizePath(outPath), version: contract.version, provider: contract.provider.provider, model: contract.provider.model });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
}

function floatingChatToolName(body) {
    const raw = String(body?.tool || body?.toolName || body?.tool_name || 'list-dir').trim().toLowerCase();
    const aliases = new Map([
        ['list', 'list-dir'],
        ['list-dir', 'list-dir'],
        ['ls', 'list-dir'],
        ['read', 'read-file'],
        ['read-file', 'read-file'],
        ['cat', 'read-file'],
        ['grep', 'grep'],
        ['search', 'grep'],
    ]);
    const tool = aliases.get(raw);
    if (!tool) {
        const error = new Error('Floating chat tool must be one of: list-dir, read-file, grep.');
        error.statusCode = 400;
        throw error;
    }
    return tool;
}

function safeWorkspaceToolTarget(root, requestedPath) {
    const raw = String(requestedPath || '.').trim() || '.';
    if (path.isAbsolute(raw)) return { ok: false, reason: 'absolute paths are not allowed' };
    const normalized = normalizePath(raw).replace(/^\/+/, '').replace(/^\.\//, '') || '.';
    if (normalized.split('/').includes('..')) return { ok: false, reason: 'parent directory traversal is not allowed' };
    if (normalized !== '.' && shouldSkipSnapshotPath(normalized)) return { ok: false, reason: 'path is excluded by private/secret restore policy' };
    const targetPath = normalized === '.' ? path.resolve(root) : path.resolve(root, normalized);
    const relative = path.relative(root, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'target resolves outside workspace' };
    return { ok: true, relativePath: normalizePath(relative || '.'), targetPath };
}

function floatingChatToolRequest(root, body) {
    const tool = floatingChatToolName(body);
    const conversationId = floatingChatConversationId(body);
    const requestedPath = String(body?.path || body?.targetPath || (tool === 'grep' ? '.' : '')).trim() || (tool === 'grep' || tool === 'list-dir' ? '.' : '');
    const target = safeWorkspaceToolTarget(root, requestedPath);
    if (!target.ok) return { ok: false, tool, conversationId, path: requestedPath, reason: target.reason };
    const pattern = String(body?.pattern || body?.query || '').trim();
    if (tool === 'grep' && !pattern) return { ok: false, tool, conversationId, path: target.relativePath, reason: 'grep requires pattern' };
    const maxChars = Math.max(1000, Math.min(60000, Math.floor(Number(body?.maxChars || body?.max_chars || 12000))));
    const maxMatches = Math.max(1, Math.min(200, Math.floor(Number(body?.maxMatches || body?.max_matches || 80))));
    return { ok: true, tool, conversationId, path: target.relativePath, targetPath: target.targetPath, pattern, maxChars, maxMatches };
}

async function floatingChatConversationRecord(root, conversationId) {
    if (!conversationId) return { valid: false, error: 'conversation id is required before running a floating chat tool' };
    const conversationPath = path.join(harmonyPath(root, 'floating-chat', 'conversations'), `${conversationId}.json`);
    const conversation = await readJson(conversationPath);
    if (!conversation || conversation.kind !== 'floating-chat.conversation' || conversation.conversationId !== conversationId || !Array.isArray(conversation.turns)) {
        return { valid: false, conversationPath: normalizePath(conversationPath), error: 'conversation record missing or invalid' };
    }
    return { valid: true, conversationPath, conversation };
}

async function latestOutsideToolPolicyGate(root) {
    const latest = await latestJsonFile(harmonyPath(root, 'tool-policy'), 'outside-tool-policy-gate-');
    if (!latest) return undefined;
    const contract = latest.json?.contract || {};
    return {
        path: normalizePath(latest.path),
        status: latest.json?.status || 'unknown',
        version: latest.json?.packageVersion || 'unknown',
        posture: contract.posture || 'unknown',
        readOnlyClass: (contract.toolClasses || []).find(item => item?.id === 'read-only-workspace'),
        reportOnlyAuthority: contract.authority?.reportWritesOnly === true,
    };
}

function floatingChatToolDigest(contract) {
    const stable = {
        version: contract.version,
        workspace: contract.workspace,
        conversationId: contract.conversationId,
        tool: contract.tool,
        latestToolPolicyGate: contract.latestToolPolicyGate,
        checks: contract.checks,
    };
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function floatingChatToolPreflightDigest(contract) {
    const stable = {
        version: contract.version,
        workspace: contract.workspace,
        conversationId: contract.conversationId,
        source: contract.source,
        candidate: contract.candidate,
        latestToolPolicyGate: contract.latestToolPolicyGate,
        checks: contract.checks,
    };
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function parseFloatingChatToolCandidate(text) {
    const raw = String(text || '').trim();
    if (!raw) return { found: false, reason: 'no tool request text found' };
    const candidates = [];
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) candidates.push(fenced[1]);
    candidates.push(raw);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate.trim());
            const source = parsed.tool ? parsed : parsed.tool_request || parsed.toolRequest || parsed.action || parsed;
            if (source?.tool || source?.toolName || source?.name) {
                return {
                    found: true,
                    tool: String(source.tool || source.toolName || source.name || '').trim(),
                    path: String(source.path || source.targetPath || source.target || '.').trim(),
                    pattern: String(source.pattern || source.query || '').trim(),
                    maxChars: source.maxChars || source.max_chars,
                    maxMatches: source.maxMatches || source.max_matches,
                    sourceFormat: 'json',
                };
            }
        } catch { /* try text form */ }
    }
    const tool = raw.match(/\btool\s*[:=]\s*([A-Za-z0-9_-]+)/i)?.[1]
        || raw.match(/\b(list-dir|read-file|grep)\b/i)?.[1];
    if (!tool) return { found: false, reason: 'no supported tool name found' };
    const pathValue = raw.match(/\bpath\s*[:=]\s*([^\n;]+)/i)?.[1]?.trim() || '.';
    const pattern = raw.match(/\bpattern\s*[:=]\s*([^\n;]+)/i)?.[1]?.trim()
        || raw.match(/\bquery\s*[:=]\s*([^\n;]+)/i)?.[1]?.trim()
        || '';
    return { found: true, tool, path: pathValue, pattern, sourceFormat: 'text' };
}

function latestAssistantToolRequest(conversation) {
    const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
    const assistant = [...turns].reverse().find(turn => turn?.role === 'assistant' && turn?.message?.text);
    if (!assistant) return undefined;
    return {
        turnId: assistant.id,
        chars: String(assistant.message.text || '').length,
        sha256: assistant.message.sha256,
        text: String(assistant.message.text || ''),
    };
}

async function floatingChatToolPreflightContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const conversationId = floatingChatConversationId(body);
    const conversation = conversationId ? await floatingChatConversationRecord(root, conversationId) : { valid: false, error: 'conversation id is required before preflighting provider tool requests' };
    const latestToolPolicyGate = await latestOutsideToolPolicyGate(root);
    const suppliedText = String(body?.toolRequest || body?.tool_request || body?.requestText || body?.request_text || '').trim();
    const assistantSource = conversation.valid ? latestAssistantToolRequest(conversation.conversation) : undefined;
    const sourceText = suppliedText || assistantSource?.text || '';
    const candidate = parseFloatingChatToolCandidate(sourceText);
    let request;
    if (candidate.found) {
        try {
            request = floatingChatToolRequest(root, {
                conversationId,
                tool: candidate.tool,
                path: candidate.path,
                pattern: candidate.pattern,
                maxChars: candidate.maxChars,
                maxMatches: candidate.maxMatches,
            });
        } catch (error) {
            request = { ok: false, tool: candidate.tool || 'unknown', conversationId, path: candidate.path || '', reason: error && error.message ? error.message : String(error) };
        }
    } else {
        request = { ok: false, tool: candidate.tool || 'unknown', conversationId, path: candidate.path || '', reason: candidate.reason || 'no candidate' };
    }
    const checks = [
        { name: 'floating chat conversation exists', status: conversation.valid ? 'passed' : 'blocked', detail: conversation.valid ? normalizePath(conversation.conversationPath) : conversation.error },
        { name: 'tool request source exists', status: sourceText ? 'passed' : 'blocked', detail: suppliedText ? 'supplied request text' : assistantSource ? `assistant turn ${assistantSource.turnId}` : 'no assistant response or supplied request text' },
        { name: 'tool request parses to supported read-only tool', status: candidate.found ? 'passed' : 'blocked', detail: candidate.found ? `${candidate.tool} from ${candidate.sourceFormat}` : candidate.reason },
        { name: 'tool request path and arguments are safe', status: request.ok ? 'passed' : 'blocked', detail: request.ok ? `${request.tool} ${request.path}` : request.reason },
        { name: 'outside tool policy gate recorded', status: latestToolPolicyGate?.status === 'recorded' && latestToolPolicyGate.version === version ? 'passed' : 'blocked', detail: latestToolPolicyGate ? `${latestToolPolicyGate.status} ${latestToolPolicyGate.version}` : 'missing' },
        { name: 'read-only tool class is present', status: latestToolPolicyGate?.readOnlyClass ? 'passed' : 'blocked', detail: latestToolPolicyGate?.readOnlyClass ? 'read-only-workspace' : 'missing' },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'ready' : 'blocked';
    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'floating-chat-provider-tool-preflight',
        status,
        conversationId,
        conversationPath: conversation.conversationPath ? normalizePath(conversation.conversationPath) : undefined,
        latestToolPolicyGate,
        source: {
            kind: suppliedText ? 'supplied-tool-request-text' : assistantSource ? 'latest-assistant-turn' : 'missing',
            turnId: assistantSource?.turnId,
            chars: sourceText.length,
            sha256: sourceText ? crypto.createHash('sha256').update(sourceText, 'utf8').digest('hex') : undefined,
        },
        candidate: candidate.found ? {
            tool: request.tool,
            path: request.path,
            pattern: request.pattern || undefined,
            maxChars: request.maxChars,
            maxMatches: request.maxMatches,
            sourceFormat: candidate.sourceFormat,
        } : { tool: candidate.tool || 'unknown', path: candidate.path || '', reason: candidate.reason },
        authority: {
            preflightOnly: true,
            toolExecution: false,
            sourceFileWrites: false,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        checks,
        requiredBeforeToolExecution: [
            'separate floating-chat-tool-execute preview receipt',
            'exact user confirmation for the concrete tool call',
            'workspace-contained path check at execution time',
            'bounded output size and no secret-looking target paths',
        ],
        notes: [
            'This action only converts a provider/supplied tool request into a checked plan. It does not execute the tool.',
            'Automatic provider-driven tool execution remains unavailable.',
        ],
    };
    contract.digest = floatingChatToolPreflightDigest(contract);
    return contract;
}

async function floatingChatToolPreflightActionPreview(root, options, body) {
    const contract = await floatingChatToolPreflightContract(root, options, body);
    return {
        action: 'floating-chat-tool-preflight',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: contract.status === 'ready',
            kind: 'floating-chat.toolPreflight',
            conversationId: contract.conversationId,
            tool: contract.candidate?.tool || 'unknown',
            path: contract.candidate?.path || '',
            digest: contract.digest,
        },
        summary: {
            status: contract.status,
            source: contract.source.kind,
            tool: contract.candidate?.tool || 'unknown',
            path: contract.candidate?.path || '',
            policyGate: contract.latestToolPolicyGate?.status || 'missing',
            toolExecution: false,
        },
        requiredConfirmation: floatingChatToolPreflightConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-tool-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-tool-preflight-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandFloatingChatToolPreflight(root, options, body) {
    const contract = await floatingChatToolPreflightContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-tool-preflight-${timestamp}.json`);
    const report = {
        version: 1,
        kind: 'floating-chat.toolPreflight',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.status,
        contract,
        toolExecution: { performed: false, reason: 'preflight-only action' },
        providerCall: { performed: false, reason: 'preflight reads existing/supplied text only' },
        notes: ['Provider-driven tool requests are preflighted only. Use a separate Floating Chat Read-Only Tool execute action for any concrete read-only inspection.'],
    };
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, { kind: 'floating-chat.toolPreflight', label: 'Floating chat provider tool preflight recorded', status: contract.status, reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, tool: contract.candidate?.tool || 'unknown' });
    return { exitCode: contract.status === 'ready' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function parseFloatingChatToolLoopCandidates(text, maxSteps = 5) {
    const raw = String(text || '').trim();
    if (!raw) return { found: false, reason: 'no tool loop request text found', candidates: [] };
    const jsonCandidates = [];
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) jsonCandidates.push(fenced[1]);
    jsonCandidates.push(raw);
    const normalizeCandidate = (source) => {
        if (!source || typeof source !== 'object') return undefined;
        const request = source.tool ? source : source.tool_request || source.toolRequest || source.action || source;
        if (!request?.tool && !request?.toolName && !request?.name) return undefined;
        return {
            tool: String(request.tool || request.toolName || request.name || '').trim(),
            path: String(request.path || request.targetPath || request.target || '.').trim(),
            pattern: String(request.pattern || request.query || '').trim(),
            maxChars: request.maxChars || request.max_chars,
            maxMatches: request.maxMatches || request.max_matches,
            sourceFormat: 'json',
        };
    };
    const collect = (value, out) => {
        if (Array.isArray(value)) {
            for (const item of value) collect(item, out);
            return;
        }
        if (!value || typeof value !== 'object') return;
        const arrays = [value.tool_calls, value.toolCalls, value.tools, value.steps, value.actions, value.loop];
        const nested = arrays.find(Array.isArray);
        if (nested) {
            collect(nested, out);
            return;
        }
        const candidate = normalizeCandidate(value);
        if (candidate) out.push(candidate);
    };
    for (const jsonText of jsonCandidates) {
        try {
            const parsed = JSON.parse(jsonText.trim());
            const collected = [];
            collect(parsed, collected);
            if (collected.length) return { found: true, sourceFormat: 'json', candidates: collected.slice(0, maxSteps), truncated: collected.length > maxSteps };
        } catch { /* try next form */ }
    }
    const single = parseFloatingChatToolCandidate(raw);
    if (!single.found) return { found: false, reason: single.reason || 'no supported tool loop request found', candidates: [] };
    return { found: true, sourceFormat: single.sourceFormat || 'text', candidates: [single], truncated: false };
}

function floatingChatToolLoopPreflightDigest(contract) {
    const stable = {
        version: contract.version,
        workspace: contract.workspace,
        conversationId: contract.conversationId,
        source: contract.source,
        maxSteps: contract.policy?.maxAutonomousSteps || 0,
        plannedSteps: contract.plannedSteps.map(step => ({ index: step.index, status: step.status, tool: step.tool, path: step.path, pattern: step.pattern, reason: step.reason })),
        checks: contract.checks,
    };
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

async function floatingChatToolLoopPreflightContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const conversationId = floatingChatConversationId(body);
    const conversation = conversationId ? await floatingChatConversationRecord(root, conversationId) : { valid: false, error: 'conversation id is required before preflighting provider tool loops' };
    const latestToolPolicyGate = await latestOutsideToolPolicyGate(root);
    const policy = await readOutsidePolicy(root) || defaultOutsidePolicy(root);
    const policyMaxSteps = Math.max(0, Math.min(10, Math.floor(Number(policy.budgets?.maxAutonomousSteps || 0))));
    const requestedMaxSteps = Math.max(1, Math.min(5, Math.floor(Number(body.maxSteps || body.max_steps || options['max-steps'] || 3))));
    const maxSteps = Math.max(1, Math.min(requestedMaxSteps, policyMaxSteps || requestedMaxSteps));
    const suppliedText = String(body?.toolLoopRequest || body?.tool_loop_request || body?.toolRequest || body?.requestText || body?.request_text || '').trim();
    const assistantSource = conversation.valid ? latestAssistantToolRequest(conversation.conversation) : undefined;
    const sourceText = suppliedText || assistantSource?.text || '';
    const parsed = parseFloatingChatToolLoopCandidates(sourceText, maxSteps);
    const plannedSteps = [];
    if (parsed.found) {
        for (const [index, candidate] of parsed.candidates.entries()) {
            let request;
            try {
                request = floatingChatToolRequest(root, {
                    conversationId,
                    tool: candidate.tool,
                    path: candidate.path,
                    pattern: candidate.pattern,
                    maxChars: candidate.maxChars,
                    maxMatches: candidate.maxMatches,
                });
            } catch (error) {
                request = { ok: false, tool: candidate.tool || 'unknown', conversationId, path: candidate.path || '', reason: error && error.message ? error.message : String(error) };
            }
            plannedSteps.push({
                index: index + 1,
                status: request.ok ? 'planned' : 'blocked',
                tool: request.tool || candidate.tool || 'unknown',
                path: request.path || candidate.path || '',
                pattern: request.pattern || candidate.pattern || undefined,
                maxChars: request.maxChars,
                maxMatches: request.maxMatches,
                reason: request.ok ? undefined : request.reason,
                requiresSeparateExecuteReceipt: true,
            });
        }
    }
    const blockedSteps = plannedSteps.filter(step => step.status === 'blocked').length;
    const ready = Boolean(conversation.valid
        && sourceText
        && parsed.found
        && plannedSteps.length
        && blockedSteps === 0
        && latestToolPolicyGate?.status === 'recorded'
        && latestToolPolicyGate.version === version
        && latestToolPolicyGate?.readOnlyClass
        && policy.permissions?.autonomousLoops === true
        && policyMaxSteps > 0);
    const checks = [
        { name: 'floating chat conversation exists', status: conversation.valid ? 'passed' : 'blocked', detail: conversation.valid ? normalizePath(conversation.conversationPath) : conversation.error },
        { name: 'provider tool-loop source exists', status: sourceText ? 'passed' : 'blocked', detail: suppliedText ? 'supplied loop request text' : assistantSource ? `assistant turn ${assistantSource.turnId}` : 'no assistant response or supplied request text' },
        { name: 'provider tool-loop parses', status: parsed.found ? 'passed' : 'blocked', detail: parsed.found ? `${plannedSteps.length} step(s) from ${parsed.sourceFormat}` : parsed.reason },
        { name: 'all loop steps are safe read-only tool plans', status: plannedSteps.length && blockedSteps === 0 ? 'passed' : 'blocked', detail: plannedSteps.length ? `${plannedSteps.length - blockedSteps}/${plannedSteps.length} planned` : 'no planned steps' },
        { name: 'outside tool policy gate recorded', status: latestToolPolicyGate?.status === 'recorded' && latestToolPolicyGate.version === version ? 'passed' : 'blocked', detail: latestToolPolicyGate ? `${latestToolPolicyGate.status} ${latestToolPolicyGate.version}` : 'missing' },
        { name: 'read-only tool class is present', status: latestToolPolicyGate?.readOnlyClass ? 'passed' : 'blocked', detail: latestToolPolicyGate?.readOnlyClass ? 'read-only-workspace' : 'missing' },
        { name: 'outside policy allows autonomous loop planning', status: policy.permissions?.autonomousLoops === true && policyMaxSteps > 0 ? 'passed' : 'blocked', detail: `autonomousLoops=${Boolean(policy.permissions?.autonomousLoops)} maxAutonomousSteps=${policyMaxSteps}` },
        { name: 'loop execution remains separately gated', status: 'passed', detail: 'this action writes only a plan/report; every tool step still requires floating-chat-tool-execute preview and confirmation' },
    ];
    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'provider-driven-tool-loop-preflight-only',
        status: ready ? 'ready' : 'blocked',
        conversationId,
        conversationPath: conversation.conversationPath ? normalizePath(conversation.conversationPath) : undefined,
        latestToolPolicyGate,
        policy: {
            autonomousLoops: Boolean(policy.permissions?.autonomousLoops),
            maxAutonomousSteps: policyMaxSteps,
            requestedMaxSteps,
            effectiveMaxSteps: maxSteps,
        },
        source: {
            kind: suppliedText ? 'supplied-tool-loop-request-text' : assistantSource ? 'latest-assistant-turn' : 'missing',
            turnId: assistantSource?.turnId,
            chars: sourceText.length,
            sha256: sourceText ? crypto.createHash('sha256').update(sourceText, 'utf8').digest('hex') : undefined,
            truncated: Boolean(parsed.truncated),
        },
        plannedSteps,
        authority: {
            preflightOnly: true,
            loopExecution: false,
            toolExecution: false,
            sourceFileWrites: false,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
            reportWritesOnly: true,
        },
        checks,
        requiredBeforeLoopExecution: [
            'fresh provider-driven tool-loop execute design with its own preview receipt',
            'per-step floating-chat-tool-execute preview receipt and exact confirmation or a future bounded batch receipt',
            'workspace-contained path check at each step execution time',
            'bounded output per step and stop-after-each-step review until explicitly expanded',
        ],
        notes: [
            'This is a provider-driven tool-loop preflight only. It does not execute provider calls or tools.',
            'The plan is limited by outside-VS autonomousLoops and maxAutonomousSteps policy, but execution remains separately unavailable.',
        ],
    };
    contract.digest = floatingChatToolLoopPreflightDigest(contract);
    return contract;
}

async function floatingChatToolLoopPreflightActionPreview(root, options, body) {
    const contract = await floatingChatToolLoopPreflightContract(root, options, body);
    return {
        action: 'floating-chat-tool-loop-preflight',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: contract.status === 'ready',
            kind: 'floating-chat.toolLoopPreflight',
            conversationId: contract.conversationId,
            plannedSteps: contract.plannedSteps.length,
            digest: contract.digest,
        },
        summary: {
            status: contract.status,
            source: contract.source.kind,
            plannedSteps: contract.plannedSteps.length,
            autonomousLoops: contract.policy.autonomousLoops,
            maxAutonomousSteps: contract.policy.maxAutonomousSteps,
            loopExecution: false,
        },
        requiredConfirmation: floatingChatToolLoopPreflightConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-tool-loop-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-tool-loop-preflight-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandFloatingChatToolLoopPreflight(root, options, body) {
    const contract = await floatingChatToolLoopPreflightContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-tool-loop-preflight-${timestamp}.json`);
    const report = {
        version: 1,
        kind: 'floating-chat.toolLoopPreflight',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.status,
        contract,
        toolExecution: { performed: false, reason: 'loop preflight-only action' },
        providerCall: { performed: false, reason: 'preflight reads existing/supplied provider text only' },
        notes: ['Provider-driven tool loops are planned only. Concrete tool execution remains separated behind floating-chat-tool-execute receipts.'],
    };
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, { kind: 'floating-chat.toolLoopPreflight', label: 'Floating chat provider tool-loop preflight recorded', status: contract.status, reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, plannedSteps: contract.plannedSteps.length });
    return { exitCode: contract.status === 'ready' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function floatingChatToolLoopExecuteDigest(contract) {
    const stable = {
        version: contract.version,
        workspace: contract.workspace,
        conversationId: contract.conversationId,
        source: contract.source,
        policy: contract.policy,
        selectedStep: contract.selectedStep,
        checks: contract.checks,
    };
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

async function floatingChatToolLoopExecuteContract(root, options, body = {}) {
    const preflight = await floatingChatToolLoopPreflightContract(root, options, body);
    const requestedStepIndex = Math.max(1, Math.min(5, Math.floor(Number(body.stepIndex || body.step_index || options['step-index'] || 1))));
    const maxResultCharsPerStep = Math.max(1000, Math.min(20000, Math.floor(Number(body.maxResultChars || body.max_result_chars || options['max-result-chars'] || 12000))));
    const selectedPlanStep = (preflight.plannedSteps || []).find(step => Number(step.index) === requestedStepIndex);
    const selectedStep = selectedPlanStep ? {
        index: selectedPlanStep.index,
        status: selectedPlanStep.status,
        tool: {
            name: selectedPlanStep.tool,
            path: selectedPlanStep.path,
            pattern: selectedPlanStep.pattern,
            maxChars: Math.min(Number(selectedPlanStep.maxChars || maxResultCharsPerStep), maxResultCharsPerStep),
            maxMatches: selectedPlanStep.maxMatches,
        },
        reason: selectedPlanStep.reason,
    } : {
        index: requestedStepIndex,
        status: 'blocked',
        tool: { name: 'unknown', path: '' },
        reason: `planned step ${requestedStepIndex} was not found`,
    };
    const checks = [
        { name: 'loop preflight is ready', status: preflight.status === 'ready' ? 'passed' : 'blocked', detail: preflight.status },
        { name: 'one planned step is selected', status: selectedPlanStep?.status === 'planned' ? 'passed' : 'blocked', detail: selectedPlanStep ? `step ${selectedPlanStep.index}: ${selectedPlanStep.tool} ${selectedPlanStep.path}` : selectedStep.reason },
        { name: 'one-step execution limit is enforced', status: 'passed', detail: 'this action executes at most one read-only tool step per preview receipt' },
        { name: 'per-step output is bounded', status: 'passed', detail: `maxResultCharsPerStep=${maxResultCharsPerStep}` },
        { name: 'provider and mutation authority remain blocked', status: 'passed', detail: 'no provider call, source write, terminal command, git mutation, package install, editor reload, or chat deletion authority' },
    ];
    const status = preflight.status === 'ready' && selectedPlanStep?.status === 'planned' ? 'passed' : 'blocked';
    const contract = {
        version: preflight.version,
        workspace: preflight.workspace,
        posture: 'provider-driven-read-only-tool-loop-one-step-execute',
        loopExecuteStatus: status,
        conversationId: preflight.conversationId,
        conversationPath: preflight.conversationPath,
        latestToolPolicyGate: preflight.latestToolPolicyGate,
        policy: {
            ...preflight.policy,
            oneStepPerReceipt: true,
            requestedStepIndex,
            maxResultCharsPerStep,
        },
        source: preflight.source,
        plannedStepCount: preflight.plannedSteps.length,
        selectedStep,
        authority: {
            loopExecution: status === 'passed',
            readOnlyWorkspaceInspection: status === 'passed',
            toolExecution: status === 'passed',
            sourceFileWrites: false,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        preflightChecks: preflight.checks,
        checks,
        stopConditions: [
            'stop after exactly one selected read-only tool step',
            'stop before execution if the loop preflight is not ready',
            'stop before execution if the selected step is missing or blocked',
            'stop after failure and write a failed report without continuing',
            'truncate any oversized step output to maxResultCharsPerStep',
        ],
        notes: [
            'This action executes one already planned read-only workspace inspection step and appends the result to the floating chat conversation.',
            'Run a fresh preview and exact confirmation for each additional loop step.',
        ],
    };
    contract.digest = floatingChatToolLoopExecuteDigest(contract);
    return contract;
}

async function floatingChatToolLoopExecuteActionPreview(root, options, body) {
    const contract = await floatingChatToolLoopExecuteContract(root, options, body);
    return {
        action: 'floating-chat-tool-loop-execute',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: contract.loopExecuteStatus === 'passed',
            kind: 'floating-chat.toolLoopExecute',
            conversationId: contract.conversationId,
            stepIndex: contract.selectedStep.index,
            tool: contract.selectedStep.tool?.name || 'unknown',
            path: contract.selectedStep.tool?.path || '',
            digest: contract.digest,
        },
        summary: {
            status: contract.loopExecuteStatus,
            plannedSteps: contract.plannedStepCount,
            stepIndex: contract.selectedStep.index,
            tool: contract.selectedStep.tool?.name || 'unknown',
            path: contract.selectedStep.tool?.path || '',
            readOnly: contract.authority.readOnlyWorkspaceInspection,
            oneStepPerReceipt: contract.policy.oneStepPerReceipt,
        },
        requiredConfirmation: floatingChatToolLoopExecuteConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'conversations', `${contract.conversationId || '<conversation-id>'}.json`)),
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-tool-loop-execute-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-tool-loop-execute-<timestamp>.execute.json')),
        ],
        checks: [...contract.preflightChecks, ...contract.checks].map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandFloatingChatToolLoopExecute(root, options, body) {
    const contract = await floatingChatToolLoopExecuteContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-tool-loop-execute-${timestamp}.json`);
    const baseReport = {
        version: 1,
        kind: 'floating-chat.toolLoopExecute',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.loopExecuteStatus === 'passed' ? 'failed' : 'blocked-before-tool-execution',
        contract,
        loopExecution: { performed: false, executedSteps: 0, stepIndex: contract.selectedStep.index },
        toolExecution: { performed: false, tool: contract.selectedStep.tool?.name || 'unknown' },
        providerCall: { performed: false, reason: 'tool-loop execution uses existing/supplied tool plan only' },
    };
    if (contract.loopExecuteStatus !== 'passed') {
        const report = { ...baseReport, notes: ['One-step read-only loop execution was blocked before touching the conversation.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.toolLoopExecute', label: 'Floating chat read-only loop step blocked', status: 'blocked', reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, stepIndex: contract.selectedStep.index, tool: contract.selectedStep.tool?.name || 'unknown' });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
    try {
        const conversationData = await floatingChatConversationRecord(root, contract.conversationId);
        if (!conversationData.valid) throw new Error(conversationData.error || 'conversation missing');
        const result = await runFloatingChatReadOnlyTool(root, { ...contract, tool: contract.selectedStep.tool });
        const rawText = String(result.text || '');
        const truncated = rawText.length > contract.policy.maxResultCharsPerStep;
        const text = truncated ? rawText.slice(0, contract.policy.maxResultCharsPerStep) : rawText;
        const resultHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        const toolTurn = {
            id: `tool-loop-${timestamp}-${contract.selectedStep.index}-${resultHash.slice(0, 8)}`,
            role: 'tool',
            createdAt: generatedAt,
            source: 'native-floating-chat-read-only-tool-loop',
            loop: {
                digest: contract.digest,
                stepIndex: contract.selectedStep.index,
                plannedStepCount: contract.plannedStepCount,
                oneStepPerReceipt: true,
            },
            tool: {
                name: contract.selectedStep.tool.name,
                path: contract.selectedStep.tool.path,
                pattern: contract.selectedStep.tool.pattern,
                digest: contract.digest,
            },
            message: { text, chars: text.length, sha256: resultHash },
            result: { status: result.status, meta: { ...(result.meta || {}), truncatedByLoopExecutor: truncated } },
        };
        const conversation = conversationData.conversation;
        conversation.packageVersion = contract.version;
        conversation.updatedAt = generatedAt;
        conversation.turns.push(toolTurn);
        await fsp.writeFile(conversationData.conversationPath, JSON.stringify(conversation, null, 2), 'utf8');
        const report = {
            ...baseReport,
            status: 'completed',
            loopExecution: { performed: true, executedSteps: 1, stepIndex: contract.selectedStep.index, stopped: true, stopReason: 'one-step-per-receipt limit' },
            toolExecution: { performed: true, tool: contract.selectedStep.tool.name, path: contract.selectedStep.tool.path, resultHash, resultChars: text.length, meta: toolTurn.result.meta },
            conversation: { id: contract.conversationId, path: normalizePath(conversationData.conversationPath), turnCount: conversation.turns.length, toolTurnId: toolTurn.id },
            notes: ['One read-only loop step was appended to the floating chat conversation. Run a fresh preview and exact confirmation for the next step.'],
        };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.toolLoopExecute', label: 'Floating chat read-only loop step completed', status: 'completed', reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, stepIndex: contract.selectedStep.index, tool: contract.selectedStep.tool.name, resultChars: text.length });
        return { exitCode: 0, report: { ...report, reportPath: normalizePath(outPath) } };
    } catch (error) {
        const report = { ...baseReport, status: 'failed', error: error && error.message ? error.message : String(error), notes: ['One-step read-only loop execution failed and did not continue to another step.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.toolLoopExecute', label: 'Floating chat read-only loop step failed', status: 'failed', reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, stepIndex: contract.selectedStep.index, tool: contract.selectedStep.tool?.name || 'unknown' });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
}

function floatingChatAutonomyNextDigest(contract) {
    const stable = {
        version: contract.version,
        workspace: contract.workspace,
        conversationId: contract.conversationId,
        latestTurn: contract.latestTurn,
        proposedNextAction: contract.proposedNextAction,
        checks: contract.checks,
    };
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

async function floatingChatAutonomyNextContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const conversationId = floatingChatConversationId(body);
    const conversation = conversationId ? await floatingChatConversationRecord(root, conversationId) : { valid: false, error: 'conversation id is required before planning floating chat autonomy' };
    const policy = await readOutsidePolicy(root) || defaultOutsidePolicy(root);
    const latestResponseRequest = await latestFloatingChatResponseRequest(root, conversationId);
    const latestResponseGate = await latestFloatingChatResponseGate(root, conversationId);
    const latestToolPolicyGate = await latestOutsideToolPolicyGate(root);
    const turns = Array.isArray(conversation?.conversation?.turns) ? conversation.conversation.turns : [];
    const latestTurn = turns.length ? turns[turns.length - 1] : undefined;
    const assistantSource = conversation.valid ? latestAssistantToolRequest(conversation.conversation) : undefined;
    const loopCandidate = assistantSource ? parseFloatingChatToolLoopCandidates(assistantSource.text, Math.max(1, Math.min(5, Number(policy.budgets?.maxAutonomousSteps || 1)))) : { found: false, candidates: [] };
    const autonomousLoopsReady = Boolean(policy.permissions?.autonomousLoops === true && Number(policy.budgets?.maxAutonomousSteps || 0) > 0);
    const proposedNextAction = (() => {
        if (!conversation.valid) return { kind: 'blocked', reason: conversation.error || 'conversation missing' };
        if (assistantSource && loopCandidate.found && autonomousLoopsReady) {
            return {
                kind: 'floating-chat-tool-loop-preflight',
                reason: 'latest assistant turn contains provider-suggested tool steps and autonomy planning budget is enabled',
                conversationId,
                plannedSteps: Math.min(loopCandidate.candidates.length, Number(policy.budgets?.maxAutonomousSteps || 0)),
                route: '/actions/floating-chat-tool-loop-preflight',
                requiresSeparateExecuteReceipt: true,
            };
        }
        if (latestResponseRequest && !latestResponseGate) {
            return { kind: 'floating-chat-response-gate', reason: 'latest user turn has a response request but no response gate report yet', conversationId, route: '/actions/floating-chat-response-gate', requiresSeparateExecuteReceipt: true };
        }
        if (latestResponseRequest && latestResponseGate) {
            return { kind: 'floating-chat-response-preflight', reason: 'response request and gate exist; provider readiness can be preflighted', conversationId, route: '/actions/floating-chat-response-preflight', requiresSeparateExecuteReceipt: true };
        }
        return { kind: 'idle', reason: 'no eligible next action found', conversationId };
    })();
    const checks = [
        { name: 'floating chat conversation exists', status: conversation.valid ? 'passed' : 'blocked', detail: conversation.valid ? normalizePath(conversation.conversationPath) : conversation.error },
        { name: 'autonomy planning stays report-only', status: 'passed', detail: 'no provider call, tool execution, source write, terminal command, git mutation, package install, editor reload, or chat deletion' },
        { name: 'autonomous loop budget available when loop is proposed', status: proposedNextAction.kind !== 'floating-chat-tool-loop-preflight' || autonomousLoopsReady ? 'passed' : 'blocked', detail: `autonomousLoops=${Boolean(policy.permissions?.autonomousLoops)} maxAutonomousSteps=${policy.budgets?.maxAutonomousSteps || 0}` },
        { name: 'tool policy gate visible for loop follow-up', status: proposedNextAction.kind !== 'floating-chat-tool-loop-preflight' || latestToolPolicyGate?.status === 'recorded' ? 'passed' : 'blocked', detail: latestToolPolicyGate ? `${latestToolPolicyGate.status} ${latestToolPolicyGate.version}` : 'missing' },
        { name: 'next action remains separately receipted', status: proposedNextAction.requiresSeparateExecuteReceipt === true || proposedNextAction.kind === 'idle' || proposedNextAction.kind === 'blocked' ? 'passed' : 'blocked', detail: proposedNextAction.kind },
    ];
    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'floating-chat-autonomy-next-report-only',
        status: proposedNextAction.kind === 'blocked' || checks.some(check => check.status === 'blocked') ? 'blocked' : proposedNextAction.kind === 'idle' ? 'idle' : 'planned',
        conversationId,
        conversationPath: conversation.conversationPath ? normalizePath(conversation.conversationPath) : undefined,
        latestTurn: latestTurn ? { id: latestTurn.id, role: latestTurn.role, source: latestTurn.source, messageSha256: latestTurn.message?.sha256, messageChars: latestTurn.message?.chars } : undefined,
        latestResponseRequest,
        latestResponseGate,
        latestToolPolicyGate,
        proposedNextAction,
        authority: {
            reportWritesOnly: true,
            providerCalls: false,
            toolExecution: false,
            sourceFileWrites: false,
            terminalCommands: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        checks,
        requiredBeforeAutonomousFollowUp: [
            'call the proposed action separately',
            'require that proposed action preview receipt and exact confirmation',
            'keep per-step provider/tool/write/terminal/git permissions separated by action class',
        ],
        notes: [
            'This planner makes floating chat more autonomous by choosing the next safe action, but it executes nothing itself.',
            'Chat deletion remains unavailable; retention stays clear-menu-only.',
        ],
    };
    contract.digest = floatingChatAutonomyNextDigest(contract);
    return contract;
}

async function floatingChatAutonomyNextActionPreview(root, options, body) {
    const contract = await floatingChatAutonomyNextContract(root, options, body);
    return {
        action: 'floating-chat-autonomy-next',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: contract.status === 'planned' || contract.status === 'idle',
            kind: 'floating-chat.autonomyNext',
            status: contract.status,
            conversationId: contract.conversationId,
            proposedNextAction: contract.proposedNextAction.kind,
            digest: contract.digest,
        },
        summary: {
            status: contract.status,
            proposedNextAction: contract.proposedNextAction.kind,
            reason: contract.proposedNextAction.reason,
            providerCalls: false,
            toolExecution: false,
        },
        requiredConfirmation: floatingChatAutonomyNextConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-autonomy-next-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-autonomy-next-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandFloatingChatAutonomyNext(root, options, body) {
    const contract = await floatingChatAutonomyNextContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-autonomy-next-${timestamp}.json`);
    const report = {
        version: 1,
        kind: 'floating-chat.autonomyNext',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.status,
        contract,
        providerCall: { performed: false, reason: 'autonomy next-step planner only' },
        toolExecution: { performed: false, reason: 'autonomy next-step planner only' },
        notes: ['Floating chat autonomy next-step planning completed without executing the proposed action.'],
    };
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, { kind: 'floating-chat.autonomyNext', label: `Floating chat autonomy next ${contract.status}`, status: contract.status, reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, proposedNextAction: contract.proposedNextAction.kind });
    return { exitCode: contract.status === 'blocked' ? 2 : 0, report: { ...report, reportPath: normalizePath(outPath) } };
}

async function floatingChatToolExecuteContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const request = floatingChatToolRequest(root, body);
    const latestToolPolicyGate = await latestOutsideToolPolicyGate(root);
    const conversation = request.conversationId ? await floatingChatConversationRecord(root, request.conversationId) : { valid: false, error: 'conversation id is required before running a floating chat tool' };
    const checks = [
        { name: 'tool request is supported and path scoped', status: request.ok ? 'passed' : 'blocked', detail: request.ok ? `${request.tool} ${request.path}` : request.reason },
        { name: 'floating chat conversation exists', status: conversation.valid ? 'passed' : 'blocked', detail: conversation.valid ? normalizePath(conversation.conversationPath) : conversation.error },
        { name: 'outside tool policy gate recorded', status: latestToolPolicyGate?.status === 'recorded' && latestToolPolicyGate.version === version ? 'passed' : 'blocked', detail: latestToolPolicyGate ? `${latestToolPolicyGate.status} ${latestToolPolicyGate.version}` : 'missing' },
        { name: 'read-only tool class is present', status: latestToolPolicyGate?.readOnlyClass ? 'passed' : 'blocked', detail: latestToolPolicyGate?.readOnlyClass ? 'read-only-workspace' : 'missing' },
        { name: 'mutation authority remains blocked', status: latestToolPolicyGate?.reportOnlyAuthority === true ? 'passed' : 'blocked', detail: 'tool gate itself must be report-only; this action only performs read-only workspace inspection' },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'floating-chat-read-only-tool-execute',
        toolExecuteStatus: status,
        conversationId: request.conversationId || '',
        conversationPath: conversation.conversationPath ? normalizePath(conversation.conversationPath) : undefined,
        latestToolPolicyGate,
        tool: request.ok ? {
            name: request.tool,
            path: request.path,
            pattern: request.pattern || undefined,
            maxChars: request.maxChars,
            maxMatches: request.maxMatches,
        } : { name: request.tool || 'unknown', path: request.path || '', error: request.reason },
        authority: {
            readOnlyWorkspaceInspection: status === 'passed',
            toolExecution: status === 'passed',
            sourceFileWrites: false,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        checks,
        blockedAuthorityClasses: ['file writes', 'terminal commands', 'provider calls', 'git mutation', 'package install', 'editor reload', 'chat deletion/archive'],
        notes: [
            'This action can run only one read-only workspace tool and append the result to an existing floating chat conversation.',
            'It does not call providers, write source files, run shell commands, mutate git, install packages, reload editors, or delete chats.',
        ],
    };
    contract.digest = floatingChatToolDigest(contract);
    return contract;
}

async function collectToolGrepFiles(root, targetPath, maxFiles) {
    const files = [];
    async function visit(current) {
        if (files.length >= maxFiles) return;
        const stat = await fsp.stat(current).catch(() => undefined);
        if (!stat) return;
        const rel = normalizePath(path.relative(root, current) || '.');
        if (rel !== '.' && shouldSkipSnapshotPath(rel)) return;
        if (stat.isFile()) {
            if (SNAPSHOT_TEXT_EXTS.has(path.extname(current).toLowerCase())) files.push(current);
            return;
        }
        if (!stat.isDirectory()) return;
        const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            await visit(path.join(current, entry.name));
            if (files.length >= maxFiles) break;
        }
    }
    await visit(targetPath);
    return files;
}

async function runFloatingChatReadOnlyTool(root, contract) {
    const tool = contract.tool || {};
    const target = safeWorkspaceToolTarget(root, tool.path || '.');
    if (!target.ok) throw new Error(target.reason || 'invalid tool target');
    if (tool.name === 'list-dir') {
        const entries = await fsp.readdir(target.targetPath, { withFileTypes: true });
        const lines = entries
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 200)
            .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
        return { status: 'completed', text: lines.join(os.EOL) || '(empty directory)', meta: { entries: entries.length } };
    }
    if (tool.name === 'read-file') {
        const stat = await fsp.stat(target.targetPath);
        if (!stat.isFile()) throw new Error('read-file target is not a file');
        if (stat.size > Number(tool.maxChars || 12000) * 4) throw new Error('read-file target is too large for this controlled read');
        if (!SNAPSHOT_TEXT_EXTS.has(path.extname(target.targetPath).toLowerCase())) throw new Error('read-file target is not a supported text file');
        const text = await fsp.readFile(target.targetPath, 'utf8');
        return { status: 'completed', text: text.slice(0, Number(tool.maxChars || 12000)), meta: { chars: text.length, truncated: text.length > Number(tool.maxChars || 12000) } };
    }
    if (tool.name === 'grep') {
        const regex = new RegExp(String(tool.pattern || ''), 'i');
        const files = await collectToolGrepFiles(root, target.targetPath, 200);
        const matches = [];
        for (const filePath of files) {
            const rel = normalizePath(path.relative(root, filePath));
            const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
            const lines = text.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
                if (regex.test(lines[index])) matches.push(`${rel}:${index + 1}: ${lines[index].trim()}`);
                if (matches.length >= Number(tool.maxMatches || 80)) break;
            }
            if (matches.length >= Number(tool.maxMatches || 80)) break;
        }
        return { status: 'completed', text: matches.join(os.EOL) || '(no matches)', meta: { filesScanned: files.length, matches: matches.length } };
    }
    throw new Error(`unsupported floating chat tool: ${tool.name || 'unknown'}`);
}

async function floatingChatToolExecuteActionPreview(root, options, body) {
    const contract = await floatingChatToolExecuteContract(root, options, body);
    return {
        action: 'floating-chat-tool-execute',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: contract.toolExecuteStatus === 'passed',
            kind: 'floating-chat.toolExecute',
            conversationId: contract.conversationId,
            tool: contract.tool?.name || 'unknown',
            path: contract.tool?.path || '',
            digest: contract.digest,
        },
        summary: {
            status: contract.toolExecuteStatus,
            tool: contract.tool?.name || 'unknown',
            path: contract.tool?.path || '',
            policyGate: contract.latestToolPolicyGate?.status || 'missing',
            readOnly: contract.authority.readOnlyWorkspaceInspection,
        },
        requiredConfirmation: floatingChatToolExecuteConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'floating-chat', 'conversations', `${contract.conversationId || '<conversation-id>'}.json`)),
            normalizePath(harmonyPath(root, 'floating-chat', 'floating-chat-tool-execute-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-floating-chat-tool-execute-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandFloatingChatToolExecute(root, options, body) {
    const contract = await floatingChatToolExecuteContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const baseReport = {
        version: 1,
        kind: 'floating-chat.toolExecute',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.toolExecuteStatus === 'passed' ? 'failed' : 'blocked-before-tool-execution',
        contract,
        toolExecution: { performed: false, tool: contract.tool?.name || 'unknown' },
    };
    const dir = harmonyPath(root, 'floating-chat');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `floating-chat-tool-execute-${timestamp}.json`);
    if (contract.toolExecuteStatus !== 'passed') {
        const report = { ...baseReport, notes: ['Read-only tool execution was blocked before touching the conversation.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.toolExecute', label: 'Floating chat read-only tool blocked', status: 'blocked', reportPath: normalizePath(outPath), version: contract.version, tool: contract.tool?.name || 'unknown' });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
    try {
        const conversationData = await floatingChatConversationRecord(root, contract.conversationId);
        if (!conversationData.valid) throw new Error(conversationData.error || 'conversation missing');
        const result = await runFloatingChatReadOnlyTool(root, contract);
        const resultHash = crypto.createHash('sha256').update(result.text, 'utf8').digest('hex');
        const toolTurn = {
            id: `tool-${timestamp}-${resultHash.slice(0, 8)}`,
            role: 'tool',
            createdAt: generatedAt,
            source: 'native-floating-chat-read-only-tool',
            tool: {
                name: contract.tool.name,
                path: contract.tool.path,
                pattern: contract.tool.pattern,
                digest: contract.digest,
            },
            message: { text: result.text, chars: result.text.length, sha256: resultHash },
            result: { status: result.status, meta: result.meta },
        };
        const conversation = conversationData.conversation;
        conversation.packageVersion = contract.version;
        conversation.updatedAt = generatedAt;
        conversation.turns.push(toolTurn);
        await fsp.writeFile(conversationData.conversationPath, JSON.stringify(conversation, null, 2), 'utf8');
        const report = {
            ...baseReport,
            status: 'completed',
            toolExecution: { performed: true, tool: contract.tool.name, path: contract.tool.path, resultHash, resultChars: result.text.length, meta: result.meta },
            conversation: { id: contract.conversationId, path: normalizePath(conversationData.conversationPath), turnCount: conversation.turns.length, toolTurnId: toolTurn.id },
            notes: ['Read-only tool result was appended to the floating chat conversation. No provider call, source write, shell command, git mutation, package install, editor reload, or chat deletion was performed.'],
        };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.toolExecute', label: 'Floating chat read-only tool completed', status: 'completed', reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, tool: contract.tool.name, resultChars: result.text.length });
        return { exitCode: 0, report: { ...report, reportPath: normalizePath(outPath) } };
    } catch (error) {
        const report = { ...baseReport, status: 'failed', error: error && error.message ? error.message : String(error), notes: ['Read-only tool execution failed. No provider call, source write, shell command, git mutation, package install, editor reload, or chat deletion was performed.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'floating-chat.toolExecute', label: 'Floating chat read-only tool failed', status: 'failed', reportPath: normalizePath(outPath), version: contract.version, conversationId: contract.conversationId, tool: contract.tool?.name || 'unknown' });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
}

function nativeFileWriteDigest(contract) {
    return crypto.createHash('sha256').update(JSON.stringify({
        version: contract.version,
        workspace: contract.workspace,
        path: contract.target?.path || '',
        contentSha256: contract.content?.sha256 || '',
        contentChars: contract.content?.chars || 0,
    })).digest('hex');
}

function nativeFileWriteConfirmation(contract) {
    return `WRITE NATIVE FILE ${String(contract.version || 'UNKNOWN')} ${String(contract.digest || '').slice(0, 12).toUpperCase()}`;
}

async function nativeFileWriteContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const relativePath = normalizePath(String(body.path || body.relativePath || '').trim());
    const content = String(body.content ?? '');
    const target = relativePath ? safeWorkspaceRestoreTarget(root, relativePath) : { ok: false, reason: 'path is required' };
    const policy = await readOutsidePolicy(root) || defaultOutsidePolicy(root);
    const stat = target.ok ? await fsp.stat(target.targetPath).catch(() => undefined) : undefined;
    const extension = target.ok ? path.extname(target.targetPath).toLowerCase() : '';
    const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const checks = [
        { name: 'outside policy allows writeFiles', status: policy?.permissions?.writeFiles ? 'passed' : 'blocked', detail: `writeFiles=${Boolean(policy?.permissions?.writeFiles)}` },
        { name: 'target path is workspace-contained', status: target.ok ? 'passed' : 'blocked', detail: target.ok ? target.relativePath : target.reason },
        { name: 'target is an existing file', status: stat?.isFile() ? 'passed' : 'blocked', detail: stat ? `size=${stat.size}` : 'missing target; first guarded write slice is overwrite-only' },
        { name: 'target is supported text', status: target.ok && stat?.isFile() && SNAPSHOT_TEXT_EXTS.has(extension) ? 'passed' : 'blocked', detail: extension || '(no extension)' },
        { name: 'content is bounded', status: content.length <= 20000 ? 'passed' : 'blocked', detail: `${content.length}/20000 chars` },
        { name: 'private/secret-looking paths are blocked', status: target.ok && !shouldSkipSnapshotPath(target.relativePath) ? 'passed' : 'blocked', detail: target.ok ? target.relativePath : target.reason },
    ];
    const status = checks.every(check => check.status === 'passed') ? 'ready' : 'blocked';
    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'native-guarded-text-file-overwrite',
        status,
        target: {
            allowed: target.ok && status === 'ready',
            path: target.ok ? target.relativePath : relativePath,
            absolutePath: target.ok ? normalizePath(target.targetPath) : '',
            exists: Boolean(stat),
            isFile: Boolean(stat?.isFile()),
            extension,
            reason: target.ok ? undefined : target.reason,
        },
        content: {
            chars: content.length,
            sha256: contentHash,
        },
        policy: {
            path: normalizePath(outsidePolicyPath(root)),
            mode: policy?.mode || 'missing',
            writeFiles: Boolean(policy?.permissions?.writeFiles),
        },
        authority: {
            sourceFileWrites: status === 'ready',
            snapshotRequired: true,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        checks,
        notes: [
            'This first write-capable native action is overwrite-only for existing small text files.',
            'It requires outside policy writeFiles=true, a preview receipt, exact confirmation, and a pre-action snapshot before writing.',
            'It does not run terminal commands, call providers, mutate git, install packages, reload editors, or delete chats.',
        ],
    };
    contract.digest = nativeFileWriteDigest(contract);
    return contract;
}

async function nativeFileWriteActionPreview(root, options, body) {
    const contract = await nativeFileWriteContract(root, options, body);
    return {
        action: 'native-file-write',
        version: contract.version,
        workspace: normalizePath(root),
        path: contract.target.path,
        target: {
            allowed: contract.status === 'ready',
            kind: 'native.fileWrite',
            path: contract.target.path,
            contentSha256: contract.content.sha256,
            digest: contract.digest,
            reason: contract.target.reason,
        },
        summary: {
            status: contract.status,
            path: contract.target.path,
            contentChars: contract.content.chars,
            writeFiles: contract.policy.writeFiles,
            snapshotRequired: true,
        },
        requiredConfirmation: nativeFileWriteConfirmation(contract),
        writes: [
            contract.target.absolutePath || normalizePath(path.join(root, contract.target.path || '<path>')),
            normalizePath(harmonyPath(root, 'snapshots', 'snapshot-<timestamp>', 'manifest.json')),
            normalizePath(harmonyPath(root, 'native-file-write', 'native-file-write-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-native-file-write-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandNativeFileWrite(root, options, body = {}) {
    const contract = await nativeFileWriteContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'native-file-write');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `native-file-write-${timestamp}.json`);
    const baseReport = {
        version: 1,
        kind: 'native.fileWrite',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.status === 'ready' ? 'failed' : 'blocked-before-write',
        contract,
        write: { performed: false, path: contract.target.path, contentSha256: contract.content.sha256 },
    };
    if (contract.status !== 'ready') {
        const report = { ...baseReport, notes: ['Native file write was blocked before touching the target file.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'native.fileWrite', label: 'Native file write blocked', status: 'blocked', reportPath: normalizePath(outPath), path: contract.target.path, version: contract.version });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
    try {
        const snapshot = await createSnapshot(root, {
            path: contract.target.path,
            reason: 'native file write pre-action snapshot',
            note: 'Pre-action snapshot before guarded native file overwrite.',
            'max-files': 1,
        });
        const target = safeWorkspaceRestoreTarget(root, contract.target.path);
        if (!target.ok) throw new Error(target.reason || 'target rejected at execution time');
        const content = String(body.content ?? '');
        await fsp.writeFile(target.targetPath, content, 'utf8');
        const writtenHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
        const report = {
            ...baseReport,
            status: 'completed',
            write: {
                performed: true,
                path: contract.target.path,
                absolutePath: normalizePath(target.targetPath),
                contentChars: content.length,
                contentSha256: writtenHash,
            },
            snapshot: {
                id: snapshot.id,
                manifestPath: normalizePath(snapshot.manifestPath),
                fileCount: snapshot.fileCount,
                copied: snapshot.copied,
                restoreCommand: `node bin/harmony-cli.js --workspace "${String(root).replace(/"/g, '\\"')}" snapshot restore --id ${snapshot.id} --all --confirm`,
            },
            notes: ['Guarded native text-file overwrite completed after a pre-action snapshot.'],
        };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'native.fileWrite', label: 'Native file write completed', status: 'completed', reportPath: normalizePath(outPath), path: contract.target.path, snapshotId: snapshot.id, version: contract.version });
        return { exitCode: 0, report: { ...report, reportPath: normalizePath(outPath) } };
    } catch (error) {
        const report = { ...baseReport, status: 'failed', error: error && error.message ? error.message : String(error), notes: ['Native file write failed.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'native.fileWrite', label: 'Native file write failed', status: 'failed', reportPath: normalizePath(outPath), path: contract.target.path, version: contract.version });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
}

function sourceWritePreflightDigest(contract) {
    return crypto.createHash('sha256').update(JSON.stringify({
        version: contract.version,
        workspace: contract.workspace,
        conversationId: contract.conversationId,
        motivator: contract.motivator,
        target: contract.target,
        proposedContentSha256: contract.proposedContent?.sha256 || '',
        validationCommandSha256: contract.validationPlan?.sha256 || '',
    })).digest('hex');
}

function sourceWritePreflightConfirmation(contract) {
    return `PREFLIGHT SOURCE WRITE ${String(contract.version || 'UNKNOWN')} ${String(contract.digest || '').slice(0, 12).toUpperCase()}`;
}

function sourceWriteDiffPreview(relativePath, beforeText, afterText) {
    const beforeLines = String(beforeText || '').split(/\r?\n/);
    const afterLines = String(afterText || '').split(/\r?\n/);
    let sharedPrefix = 0;
    while (sharedPrefix < beforeLines.length && sharedPrefix < afterLines.length && beforeLines[sharedPrefix] === afterLines[sharedPrefix]) sharedPrefix++;
    let sharedSuffix = 0;
    while (sharedSuffix + sharedPrefix < beforeLines.length
        && sharedSuffix + sharedPrefix < afterLines.length
        && beforeLines[beforeLines.length - 1 - sharedSuffix] === afterLines[afterLines.length - 1 - sharedSuffix]) {
        sharedSuffix++;
    }
    const removedLines = beforeLines.slice(sharedPrefix, beforeLines.length - sharedSuffix);
    const addedLines = afterLines.slice(sharedPrefix, afterLines.length - sharedSuffix);
    const contextBefore = beforeLines.slice(Math.max(0, sharedPrefix - 3), sharedPrefix);
    const contextAfterStart = beforeLines.length - sharedSuffix;
    const contextAfter = beforeLines.slice(contextAfterStart, Math.min(beforeLines.length, contextAfterStart + 3));
    const maxPreviewLines = 80;
    const previewLines = [`--- a/${relativePath}`, `+++ b/${relativePath}`, `@@ preview around line ${sharedPrefix + 1} @@`];
    for (const line of contextBefore) previewLines.push(` ${line}`);
    for (const line of removedLines.slice(0, maxPreviewLines)) previewLines.push(`-${line}`);
    if (removedLines.length > maxPreviewLines) previewLines.push(`-... ${removedLines.length - maxPreviewLines} removed line(s) omitted`);
    for (const line of addedLines.slice(0, maxPreviewLines)) previewLines.push(`+${line}`);
    if (addedLines.length > maxPreviewLines) previewLines.push(`+... ${addedLines.length - maxPreviewLines} added line(s) omitted`);
    for (const line of contextAfter) previewLines.push(` ${line}`);
    return {
        changed: beforeText !== afterText,
        removedLines: removedLines.length,
        addedLines: addedLines.length,
        preview: truncateText(previewLines.join('\n'), 12000),
        truncated: previewLines.join('\n').length > 12000,
    };
}

async function sourceWritePreflightContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const conversationId = floatingChatConversationId(body);
    const conversation = conversationId ? await floatingChatConversationRecord(root, conversationId) : { valid: false, error: 'conversation id is required before source-write preflight' };
    const toolResultId = String(body.toolResultId || body.tool_result_id || '').trim();
    const toolReportPathRaw = String(body.toolReportPath || body.tool_report_path || body.reportPath || '').trim();
    const relativePath = normalizePath(String(body.path || body.targetPath || body.target || '').trim());
    const proposedContent = String(body.proposedContent ?? body.proposed_content ?? body.content ?? '');
    const validationCommand = String(body.validationCommand || body.validation_command || '').trim();
    const target = relativePath ? safeWorkspaceRestoreTarget(root, relativePath) : { ok: false, reason: 'path is required' };
    const stat = target.ok ? await fsp.stat(target.targetPath).catch(() => undefined) : undefined;
    const extension = target.ok ? path.extname(target.targetPath).toLowerCase() : '';
    const beforeText = target.ok && stat?.isFile() ? await fsp.readFile(target.targetPath, 'utf8').catch(() => '') : '';
    const beforeHash = crypto.createHash('sha256').update(beforeText, 'utf8').digest('hex');
    const proposedHash = crypto.createHash('sha256').update(proposedContent, 'utf8').digest('hex');
    const validationHash = validationCommand ? crypto.createHash('sha256').update(validationCommand, 'utf8').digest('hex') : '';
    const turns = Array.isArray(conversation?.conversation?.turns) ? conversation.conversation.turns : [];
    const matchingToolTurn = toolResultId ? turns.find(turn => turn?.role === 'tool' && turn?.id === toolResultId) : undefined;
    let toolReport = { provided: false, ok: false, relativePath: '', reason: 'not supplied' };
    if (toolReportPathRaw) {
        const absoluteReportPath = path.isAbsolute(toolReportPathRaw) ? path.resolve(toolReportPathRaw) : path.resolve(root, toolReportPathRaw);
        const relativeReportPath = normalizePath(path.relative(root, absoluteReportPath));
        const contained = Boolean(relativeReportPath && !relativeReportPath.startsWith('..') && !path.isAbsolute(relativeReportPath));
        const exists = contained ? await pathExists(absoluteReportPath) : false;
        toolReport = { provided: true, ok: contained && exists, relativePath: relativeReportPath, reason: contained ? (exists ? 'report exists' : 'report missing') : 'report path is outside workspace' };
    }
    const motivatorOk = Boolean(matchingToolTurn || toolReport.ok);
    const git = await collectGitSafetyMetadata(root);
    const diff = sourceWriteDiffPreview(target.ok ? target.relativePath : relativePath || '<path>', beforeText, proposedContent);
    const checks = [
        { name: 'floating chat conversation exists', status: conversation.valid ? 'passed' : 'blocked', detail: conversation.valid ? normalizePath(conversation.conversationPath) : conversation.error },
        { name: 'motivating read-only result is identified', status: motivatorOk ? 'passed' : 'blocked', detail: matchingToolTurn ? `tool turn ${toolResultId}` : toolReport.provided ? `${toolReport.relativePath}: ${toolReport.reason}` : 'toolResultId or toolReportPath is required' },
        { name: 'target path is workspace-contained', status: target.ok ? 'passed' : 'blocked', detail: target.ok ? target.relativePath : target.reason },
        { name: 'target is an existing file', status: stat?.isFile() ? 'passed' : 'blocked', detail: stat ? `size=${stat.size}` : 'missing target; source-write preflight is existing-file only' },
        { name: 'target is supported text', status: target.ok && stat?.isFile() && SNAPSHOT_TEXT_EXTS.has(extension) ? 'passed' : 'blocked', detail: extension || '(no extension)' },
        { name: 'private/secret-looking paths are blocked', status: target.ok && !shouldSkipSnapshotPath(target.relativePath) ? 'passed' : 'blocked', detail: target.ok ? target.relativePath : target.reason },
        { name: 'proposed content is bounded', status: proposedContent.length > 0 && proposedContent.length <= 30000 ? 'passed' : 'blocked', detail: `${proposedContent.length}/30000 chars` },
        { name: 'proposed content changes target', status: beforeHash !== proposedHash ? 'passed' : 'blocked', detail: beforeHash === proposedHash ? 'proposed content matches current file' : `${diff.removedLines} removed line(s), ${diff.addedLines} added line(s)` },
        { name: 'validation command is report-only', status: validationCommand.length <= 300 ? 'passed' : 'blocked', detail: validationCommand ? `recorded only, sha256=${validationHash.slice(0, 12)}` : 'none supplied' },
        { name: 'git status summarized', status: 'passed', detail: git.insideWorkTree ? `${git.statusCount || 0} status row(s)` : 'not a git work tree' },
        { name: 'source writes remain disabled', status: 'passed', detail: 'this preflight writes only report/receipt/ledger artifacts' },
    ];
    const status = checks.some(check => check.status === 'blocked') ? 'blocked' : 'ready';
    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'source-write-preflight-report-only',
        status,
        conversationId,
        conversationPath: conversation.conversationPath ? normalizePath(conversation.conversationPath) : undefined,
        motivator: {
            toolResultId,
            toolTurnFound: Boolean(matchingToolTurn),
            toolReportPath: toolReport.provided ? toolReport.relativePath : '',
            toolReportFound: Boolean(toolReport.ok),
        },
        target: {
            path: target.ok ? target.relativePath : relativePath,
            absolutePath: target.ok ? normalizePath(target.targetPath) : '',
            exists: Boolean(stat),
            isFile: Boolean(stat?.isFile()),
            extension,
            beforeSha256: beforeHash,
        },
        proposedContent: {
            chars: proposedContent.length,
            sha256: proposedHash,
        },
        diffPreview: diff,
        validationPlan: {
            command: validationCommand,
            sha256: validationHash,
            executionAuthority: false,
        },
        snapshotPlan: {
            requiredBeforeExecute: true,
            targetPath: target.ok ? target.relativePath : relativePath,
            reason: 'future source-write execute pre-action snapshot',
        },
        rollbackPlan: {
            requiresSnapshotIdFromFutureExecute: true,
            restoreCommandTemplate: `node bin/harmony-cli.js --workspace "${String(root).replace(/"/g, '\\"')}" snapshot restore --id <snapshot-id> --all --confirm`,
        },
        git: {
            insideWorkTree: Boolean(git.insideWorkTree),
            branch: git.branch,
            head: git.head,
            statusCount: git.statusCount || 0,
            status: (git.status || []).slice(0, 20),
            warning: git.insideWorkTree && git.statusCount ? `git status has ${git.statusCount} row(s); future write execute must not hide existing user work` : 'no blocking git warning from preflight',
        },
        authority: {
            reportWritesOnly: true,
            sourceWritePreflight: status === 'ready',
            sourceFileWrites: false,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        requiredBeforeSourceWriteExecute: [
            'separate source-write execute action and route',
            'fresh source-write execute preview receipt and exact confirmation',
            'pre-action snapshot for every target file',
            'diff digest match between preflight and execute',
            'single-operation lock proof',
            'explicit validation plan and rollback instructions',
        ],
        checks,
        notes: [
            'This action does not write source files. It only records whether a future source-write execute action may be offered.',
            'Floating Chat Tool Loop Execute remains read-only and cannot call this action automatically.',
        ],
    };
    contract.digest = sourceWritePreflightDigest(contract);
    return contract;
}

async function sourceWritePreflightActionPreview(root, options, body) {
    const contract = await sourceWritePreflightContract(root, options, body);
    return {
        action: 'source-write-preflight',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: contract.status === 'ready',
            kind: 'source.writePreflight',
            path: contract.target.path,
            proposedContentSha256: contract.proposedContent.sha256,
            diffChanged: contract.diffPreview.changed,
            digest: contract.digest,
        },
        summary: {
            status: contract.status,
            path: contract.target.path,
            proposedContentChars: contract.proposedContent.chars,
            removedLines: contract.diffPreview.removedLines,
            addedLines: contract.diffPreview.addedLines,
            sourceFileWrites: false,
            reportOnly: true,
        },
        requiredConfirmation: sourceWritePreflightConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'source-write-preflight', 'source-write-preflight-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-source-write-preflight-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandSourceWritePreflight(root, options, body = {}) {
    const contract = await sourceWritePreflightContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'source-write-preflight');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `source-write-preflight-${timestamp}.json`);
    const report = {
        version: 1,
        kind: 'source.writePreflight',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.status,
        contract,
        write: { performed: false, reason: 'source-write preflight is report-only' },
        providerCall: { performed: false, reason: 'source-write preflight does not call providers' },
        terminalCommand: { performed: false, reason: 'validation command is recorded only' },
    };
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, { kind: 'source.writePreflight', label: 'Source-write preflight recorded', status: contract.status, reportPath: normalizePath(outPath), path: contract.target.path, version: contract.version, sourceFileWrites: false });
    return { exitCode: contract.status === 'ready' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

function sourceWriteExecuteLockPath(root) {
    return harmonyPath(root, 'source-write-execute', 'source-write-execute.lock.json');
}

async function readSourceWriteExecuteActiveLock(root) {
    const lockPath = sourceWriteExecuteLockPath(root);
    const lock = await readJson(lockPath);
    if (!lock) return { active: false, path: normalizePath(lockPath) };
    const expiresAt = Date.parse(lock.expiresAt || '');
    const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
    return { active: !expired, expired, lock: { ...lock, path: normalizePath(lockPath) }, path: normalizePath(lockPath) };
}

async function acquireSourceWriteExecuteLock(root, options) {
    const lockPath = sourceWriteExecuteLockPath(root);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const ttlMs = Math.max(5 * 60 * 1000, Number(options['lock-ttl-ms'] || 30 * 60 * 1000));
    const lock = {
        version: 1,
        kind: 'source.writeExecute.lock',
        token: crypto.randomBytes(8).toString('hex'),
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        workspace: normalizePath(root),
        operation: 'source.writeExecute',
    };
    async function writeLock() {
        const handle = await fsp.open(lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(lock, null, 2), 'utf8');
        } finally {
            await handle.close();
        }
        return { ...lock, path: normalizePath(lockPath), acquired: true };
    }
    try {
        return await writeLock();
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readJson(lockPath);
        const expired = existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now();
        if (!expired) {
            const blocked = new Error('Source-write execute is already running. Wait for the existing lock to expire or finish.');
            blocked.statusCode = 409;
            blocked.lock = existing ? { ...existing, path: normalizePath(lockPath) } : { path: normalizePath(lockPath) };
            throw blocked;
        }
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return await writeLock();
    }
}

async function releaseSourceWriteExecuteLock(lock) {
    if (!lock?.path || !lock?.token) return { released: false, reason: 'missing lock' };
    const lockPath = path.resolve(lock.path);
    const current = await readJson(lockPath);
    if (current?.token !== lock.token) return { released: false, reason: 'lock token mismatch', path: normalizePath(lockPath) };
    await fsp.rm(lockPath, { force: true });
    return { released: true, path: normalizePath(lockPath) };
}

function sourceWriteExecuteDigest(contract) {
    return crypto.createHash('sha256').update(JSON.stringify({
        version: contract.version,
        workspace: contract.workspace,
        preflightReportPath: contract.preflight?.reportPath || '',
        preflightDigest: contract.preflight?.digest || '',
        target: contract.target,
        proposedContentSha256: contract.proposedContent?.sha256 || '',
    })).digest('hex');
}

function sourceWriteExecuteConfirmation(contract) {
    return `EXECUTE SOURCE WRITE ${String(contract.version || 'UNKNOWN')} ${String(contract.digest || '').slice(0, 12).toUpperCase()}`;
}

async function readSourceWritePreflightReportForExecute(root, body = {}) {
    const raw = String(body.preflightReportPath || body.preflight_report_path || body.preflightPath || body.reportPath || '').trim();
    if (!raw) return { ok: false, reason: 'preflightReportPath is required before source-write execute' };
    const absolutePath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    const relativePath = normalizePath(path.relative(root, absolutePath));
    const contained = Boolean(relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    if (!contained) return { ok: false, reason: 'preflight report path is outside workspace', absolutePath, relativePath };
    const report = await readJson(absolutePath);
    if (!report) return { ok: false, reason: 'preflight report is missing or invalid JSON', absolutePath, relativePath };
    return { ok: true, absolutePath, relativePath, report };
}

async function sourceWriteExecuteContract(root, options, body = {}) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const preflight = await readSourceWritePreflightReportForExecute(root, body);
    const preflightReport = preflight.ok ? preflight.report : undefined;
    const preflightContract = preflightReport?.contract || {};
    let preflightDigest = '';
    try { preflightDigest = preflightContract?.digest ? sourceWritePreflightDigest(preflightContract) : ''; }
    catch { preflightDigest = ''; }
    const preflightDigestMatches = Boolean(preflightContract?.digest && preflightDigest === preflightContract.digest);
    const targetPath = normalizePath(String(preflightContract?.target?.path || body.path || body.targetPath || body.target || '').trim());
    const target = targetPath ? safeWorkspaceRestoreTarget(root, targetPath) : { ok: false, reason: 'target path is missing from preflight report' };
    const stat = target.ok ? await fsp.stat(target.targetPath).catch(() => undefined) : undefined;
    const extension = target.ok ? path.extname(target.targetPath).toLowerCase() : '';
    const currentText = target.ok && stat?.isFile() ? await fsp.readFile(target.targetPath, 'utf8').catch(() => '') : '';
    const currentHash = crypto.createHash('sha256').update(currentText, 'utf8').digest('hex');
    const proposedContent = String(body.proposedContent ?? body.proposed_content ?? body.content ?? '');
    const proposedHash = crypto.createHash('sha256').update(proposedContent, 'utf8').digest('hex');
    const activeLock = await readSourceWriteExecuteActiveLock(root);
    const expectedBeforeHash = String(preflightContract?.target?.beforeSha256 || '');
    const expectedProposedHash = String(preflightContract?.proposedContent?.sha256 || '');
    const checks = [
        { name: 'source-write preflight report exists', status: preflight.ok ? 'passed' : 'blocked', detail: preflight.ok ? preflight.relativePath : preflight.reason },
        { name: 'source-write preflight report is ready', status: preflightReport?.kind === 'source.writePreflight' && preflightReport?.status === 'ready' && preflightContract?.status === 'ready' ? 'passed' : 'blocked', detail: preflightReport ? `kind=${preflightReport.kind || 'unknown'}, status=${preflightReport.status || 'unknown'}` : 'missing report' },
        { name: 'preflight digest matches report', status: preflightDigestMatches ? 'passed' : 'blocked', detail: preflightContract?.digest ? preflightContract.digest : 'missing preflight digest' },
        { name: 'target path is workspace-contained', status: target.ok ? 'passed' : 'blocked', detail: target.ok ? target.relativePath : target.reason },
        { name: 'target is an existing file', status: stat?.isFile() ? 'passed' : 'blocked', detail: stat ? `size=${stat.size}` : 'missing target' },
        { name: 'target is supported text', status: target.ok && stat?.isFile() && SNAPSHOT_TEXT_EXTS.has(extension) ? 'passed' : 'blocked', detail: extension || '(no extension)' },
        { name: 'target has not changed since preflight', status: expectedBeforeHash && currentHash === expectedBeforeHash ? 'passed' : 'blocked', detail: expectedBeforeHash ? `current=${currentHash.slice(0, 12)}, preflight=${expectedBeforeHash.slice(0, 12)}` : 'missing preflight beforeSha256' },
        { name: 'proposed content matches preflight digest', status: expectedProposedHash && proposedHash === expectedProposedHash ? 'passed' : 'blocked', detail: expectedProposedHash ? `proposed=${proposedHash.slice(0, 12)}, preflight=${expectedProposedHash.slice(0, 12)}` : 'missing preflight proposed content hash' },
        { name: 'source-write execute lock is available', status: activeLock.active ? 'blocked' : 'passed', detail: activeLock.active ? `active lock at ${activeLock.path}` : activeLock.path },
        { name: 'terminal/provider/git authority remains separate', status: 'passed', detail: 'this action writes one source file only; terminal commands, provider calls, and git mutations remain false' },
    ];
    const status = checks.some(check => check.status === 'blocked') ? 'blocked' : 'ready';
    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'source-write-execute-single-file-receipted',
        status,
        preflight: {
            reportPath: preflight.ok ? preflight.relativePath : '',
            reportAbsolutePath: preflight.ok ? normalizePath(preflight.absolutePath) : '',
            digest: String(preflightContract?.digest || ''),
            digestMatches: preflightDigestMatches,
        },
        target: {
            path: target.ok ? target.relativePath : targetPath,
            absolutePath: target.ok ? normalizePath(target.targetPath) : '',
            exists: Boolean(stat),
            isFile: Boolean(stat?.isFile()),
            extension,
            beforeSha256: expectedBeforeHash,
            currentSha256: currentHash,
        },
        proposedContent: {
            chars: proposedContent.length,
            sha256: proposedHash,
        },
        validationPlan: {
            command: preflightContract?.validationPlan?.command || '',
            sha256: preflightContract?.validationPlan?.sha256 || '',
            executionAuthority: false,
        },
        lock: {
            path: activeLock.path,
            active: Boolean(activeLock.active),
            existing: activeLock.active ? activeLock.lock : undefined,
        },
        snapshotPlan: {
            requiredBeforeWrite: true,
            targetPath: target.ok ? target.relativePath : targetPath,
            reason: 'source-write execute pre-action snapshot',
        },
        rollbackPlan: {
            requiresSnapshotIdFromExecute: true,
            restoreCommandTemplate: `node bin/harmony-cli.js --workspace "${String(root).replace(/"/g, '\\"')}" snapshot restore --id <snapshot-id> --all --confirm`,
        },
        authority: {
            sourceWriteExecute: status === 'ready',
            sourceFileWrites: status === 'ready',
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
        checks,
        notes: [
            'This action can write exactly one existing text file after a matching source-write preflight report.',
            'It does not run terminal commands, call providers, mutate git, install packages, reload editors, or delete chats.',
            'No native UI execute button is exposed until the smoke suite remains green after implementation.',
        ],
    };
    contract.digest = sourceWriteExecuteDigest(contract);
    return contract;
}

async function sourceWriteExecuteActionPreview(root, options, body) {
    const contract = await sourceWriteExecuteContract(root, options, body);
    return {
        action: 'source-write-execute',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: contract.status === 'ready',
            kind: 'source.writeExecute',
            path: contract.target.path,
            preflightDigest: contract.preflight.digest,
            proposedContentSha256: contract.proposedContent.sha256,
            digest: contract.digest,
        },
        summary: {
            status: contract.status,
            path: contract.target.path,
            proposedContentChars: contract.proposedContent.chars,
            sourceFileWrites: contract.status === 'ready',
            snapshotRequired: true,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
        },
        requiredConfirmation: sourceWriteExecuteConfirmation(contract),
        writes: [
            contract.target.absolutePath || normalizePath(path.join(root, contract.target.path || '<path>')),
            normalizePath(harmonyPath(root, 'snapshots', 'snapshot-<timestamp>', 'manifest.json')),
            normalizePath(harmonyPath(root, 'source-write-execute', 'source-write-execute-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-source-write-execute-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandSourceWriteExecute(root, options, body = {}) {
    const contract = await sourceWriteExecuteContract(root, options, body);
    const timestamp = Date.now();
    const generatedAt = new Date(timestamp).toISOString();
    const dir = harmonyPath(root, 'source-write-execute');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `source-write-execute-${timestamp}.json`);
    const baseReport = {
        version: 1,
        kind: 'source.writeExecute',
        generatedAt,
        workspace: root,
        packageVersion: contract.version,
        status: contract.status === 'ready' ? 'failed' : 'blocked-before-write',
        contract,
        write: { performed: false, path: contract.target.path, proposedContentSha256: contract.proposedContent.sha256 },
        providerCall: { performed: false, reason: 'source-write execute does not call providers' },
        terminalCommand: { performed: false, reason: 'validation command remains report-only until terminal authority is separate' },
        gitMutation: { performed: false, reason: 'source-write execute does not mutate git' },
    };
    if (contract.status !== 'ready') {
        const report = { ...baseReport, notes: ['Source-write execute was blocked before touching the target file.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'source.writeExecute', label: 'Source-write execute blocked', status: 'blocked', reportPath: normalizePath(outPath), path: contract.target.path, version: contract.version });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    }
    let lock;
    try {
        lock = await acquireSourceWriteExecuteLock(root, options);
        const target = safeWorkspaceRestoreTarget(root, contract.target.path);
        if (!target.ok) throw new Error(target.reason || 'target rejected at execution time');
        const currentText = await fsp.readFile(target.targetPath, 'utf8');
        const currentHash = crypto.createHash('sha256').update(currentText, 'utf8').digest('hex');
        if (currentHash !== contract.target.currentSha256 || currentHash !== contract.target.beforeSha256) throw new Error('target changed after preview; run source-write preflight again');
        const proposedContent = String(body.proposedContent ?? body.proposed_content ?? body.content ?? '');
        const proposedHash = crypto.createHash('sha256').update(proposedContent, 'utf8').digest('hex');
        if (proposedHash !== contract.proposedContent.sha256) throw new Error('proposed content changed after preview; run source-write execute preview again');
        const snapshot = await createSnapshot(root, {
            path: contract.target.path,
            reason: 'source-write execute pre-action snapshot',
            note: 'Pre-action snapshot before source-write execute overwrite.',
            'max-files': 1,
        });
        await fsp.writeFile(target.targetPath, proposedContent, 'utf8');
        const writtenText = await fsp.readFile(target.targetPath, 'utf8');
        const writtenHash = crypto.createHash('sha256').update(writtenText, 'utf8').digest('hex');
        if (writtenHash !== proposedHash) throw new Error('post-write hash verification failed');
        const report = {
            ...baseReport,
            status: 'completed',
            write: {
                performed: true,
                path: contract.target.path,
                absolutePath: normalizePath(target.targetPath),
                contentChars: proposedContent.length,
                beforeSha256: contract.target.beforeSha256,
                contentSha256: writtenHash,
            },
            snapshot: {
                id: snapshot.id,
                manifestPath: normalizePath(snapshot.manifestPath),
                fileCount: snapshot.fileCount,
                copied: snapshot.copied,
                restoreCommand: `node bin/harmony-cli.js --workspace "${String(root).replace(/"/g, '\\"')}" snapshot restore --id ${snapshot.id} --all --confirm`,
            },
            lock: { acquired: true, path: lock.path, token: lock.token, expiresAt: lock.expiresAt },
            notes: ['Source-write execute completed after preflight digest, preview receipt, exact confirmation, lock, snapshot, and post-write hash verification.'],
        };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'source.writeExecute', label: 'Source-write execute completed', status: 'completed', reportPath: normalizePath(outPath), path: contract.target.path, snapshotId: snapshot.id, version: contract.version });
        return { exitCode: 0, report: { ...report, reportPath: normalizePath(outPath) } };
    } catch (error) {
        const report = { ...baseReport, status: 'failed', lock: lock ? { acquired: true, path: lock.path, expiresAt: lock.expiresAt } : undefined, error: error && error.message ? error.message : String(error), notes: ['Source-write execute failed before completion.'] };
        await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
        await appendLedgerEntry(root, { kind: 'source.writeExecute', label: 'Source-write execute failed', status: 'failed', reportPath: normalizePath(outPath), path: contract.target.path, version: contract.version });
        return { exitCode: 2, report: { ...report, reportPath: normalizePath(outPath) } };
    } finally {
        if (lock) await releaseSourceWriteExecuteLock(lock).catch(() => undefined);
    }
}

async function runNativeFileWriteSmoke(workspace) {
    const summary = {
        policyAllowsWriteFiles: false,
        targetCreated: false,
        previewReceiptId: '',
        requiredConfirmation: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        snapshotWritten: false,
        targetChanged: false,
        sourceWriteAuthority: false,
        noTerminalAuthority: false,
        noProviderAuthority: false,
        noGitAuthority: false,
        noChatDeletionAuthority: false,
        executeReceiptWritten: false,
    };
    try {
        const targetPath = 'native-file-write-smoke.txt';
        const nextContent = 'after guarded native write\n';
        await fsp.writeFile(path.join(workspace, targetPath), 'before guarded native write\n', 'utf8');
        summary.targetCreated = await pathExists(path.join(workspace, targetPath));

        const policy = await readOutsidePolicy(workspace) || defaultOutsidePolicy(workspace);
        policy.permissions = { ...(policy.permissions || {}), writeFiles: true };
        policy.updatedAt = new Date().toISOString();
        await fsp.mkdir(path.dirname(outsidePolicyPath(workspace)), { recursive: true });
        await fsp.writeFile(outsidePolicyPath(workspace), JSON.stringify(policy, null, 2), 'utf8');
        summary.policyAllowsWriteFiles = Boolean(policy.permissions.writeFiles);

        const body = { path: targetPath, content: nextContent };
        const preview = await handleNativeFileWriteAction(workspace, {}, { ...body, mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        summary.requiredConfirmation = preview?.preview?.requiredConfirmation || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleNativeFileWriteAction(workspace, {}, { ...body, mode: 'execute', confirmation: summary.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleNativeFileWriteAction(workspace, {}, {
            ...body,
            mode: 'execute',
            confirmation: summary.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.snapshotWritten = Boolean(executed?.report?.snapshot?.manifestPath && await pathExists(executed.report.snapshot.manifestPath));
        summary.targetChanged = await fsp.readFile(path.join(workspace, targetPath), 'utf8') === nextContent;
        summary.sourceWriteAuthority = executed?.report?.contract?.authority?.sourceFileWrites === true;
        summary.noTerminalAuthority = executed?.report?.contract?.authority?.terminalCommands === false;
        summary.noProviderAuthority = executed?.report?.contract?.authority?.providerCalls === false;
        summary.noGitAuthority = executed?.report?.contract?.authority?.gitMutations === false;
        summary.noChatDeletionAuthority = executed?.report?.contract?.authority?.chatDeletion === false;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.policyAllowsWriteFiles
            && summary.targetCreated
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.snapshotWritten
            && summary.targetChanged
            && summary.sourceWriteAuthority
            && summary.noTerminalAuthority
            && summary.noProviderAuthority
            && summary.noGitAuthority
            && summary.noChatDeletionAuthority
            && summary.executeReceiptWritten;
        return {
            command: 'native file write controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'native file write controlled action failed',
        };
    } catch (error) {
        return {
            command: 'native file write controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runSourceWritePreflightSmoke(workspace) {
    const summary = {
        conversationCreated: false,
        toolPolicyGateRecorded: false,
        readOnlyToolResultCreated: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        targetUnchanged: false,
        diffPreviewPresent: false,
        sourceWriteAuthorityBlocked: false,
        noTerminalAuthority: false,
        noProviderAuthority: false,
        noGitAuthority: false,
        noChatDeletionAuthority: false,
        executeReceiptWritten: false,
    };
    const conversationId = 'source-write-preflight-smoke';
    const targetPath = 'source-write-preflight-target.txt';
    const sourcePath = 'source-write-preflight-source.txt';
    const originalContent = 'alpha source write preflight\nbeta unchanged\n';
    const proposedContent = 'alpha source write preflight\nbeta changed by preflight proposal\n';
    try {
        await fsp.writeFile(path.join(workspace, targetPath), originalContent, 'utf8');
        await fsp.writeFile(path.join(workspace, sourcePath), 'tool evidence for source write preflight\n', 'utf8');
        const policy = defaultOutsidePolicy(workspace);
        policy.permissions.autonomousLoops = true;
        policy.budgets.maxAutonomousSteps = 2;
        policy.updatedAt = new Date().toISOString();
        await fsp.mkdir(path.dirname(outsidePolicyPath(workspace)), { recursive: true });
        await fsp.writeFile(outsidePolicyPath(workspace), JSON.stringify(policy, null, 2), 'utf8');

        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony source-write preflight smoke turn.', conversationId);
        summary.conversationCreated = Boolean(turn?.report?.conversation?.path && await pathExists(turn.report.conversation.path));
        const gate = await commandOutsideToolPolicyGate(workspace, {}, { reason: 'source-write preflight smoke' });
        summary.toolPolicyGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));
        const loopJson = JSON.stringify({ tool_calls: [{ tool: 'read-file', path: sourcePath, maxChars: 4000 }] });
        const loopStep = await commandFloatingChatToolLoopExecute(workspace, {}, { conversationId, toolLoopRequest: loopJson, maxSteps: 2, stepIndex: 1, maxResultChars: 12000 });
        const toolResultId = loopStep?.report?.conversation?.toolTurnId || '';
        summary.readOnlyToolResultCreated = loopStep.exitCode === 0 && Boolean(toolResultId);

        const body = { conversationId, toolResultId, path: targetPath, proposedContent, validationCommand: 'npm run compile' };
        const preview = await handleSourceWritePreflightAction(workspace, {}, { ...body, mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        const requiredConfirmation = preview?.preview?.requiredConfirmation || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleSourceWritePreflightAction(workspace, {}, { ...body, mode: 'execute', confirmation: requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleSourceWritePreflightAction(workspace, {}, { ...body, mode: 'execute', confirmation: requiredConfirmation, previewReceiptId: summary.previewReceiptId });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.targetUnchanged = await fsp.readFile(path.join(workspace, targetPath), 'utf8') === originalContent;
        summary.diffPreviewPresent = typeof executed?.report?.contract?.diffPreview?.preview === 'string' && executed.report.contract.diffPreview.preview.includes('beta changed by preflight proposal');
        summary.sourceWriteAuthorityBlocked = executed?.report?.contract?.authority?.sourceFileWrites === false && executed?.report?.write?.performed === false;
        summary.noTerminalAuthority = executed?.report?.contract?.authority?.terminalCommands === false && executed?.report?.terminalCommand?.performed === false;
        summary.noProviderAuthority = executed?.report?.contract?.authority?.providerCalls === false && executed?.report?.providerCall?.performed === false;
        summary.noGitAuthority = executed?.report?.contract?.authority?.gitMutations === false;
        summary.noChatDeletionAuthority = executed?.report?.contract?.authority?.chatDeletion === false;
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));

        const passed = summary.conversationCreated
            && summary.toolPolicyGateRecorded
            && summary.readOnlyToolResultCreated
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.targetUnchanged
            && summary.diffPreviewPresent
            && summary.sourceWriteAuthorityBlocked
            && summary.noTerminalAuthority
            && summary.noProviderAuthority
            && summary.noGitAuthority
            && summary.noChatDeletionAuthority
            && summary.executeReceiptWritten;
        return {
            command: 'source-write preflight report-only action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'source-write preflight report-only action failed',
        };
    } catch (error) {
        return {
            command: 'source-write preflight report-only action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

function sourceWriteExecuteSmokeResult(name, summary, passed, error) {
    return {
        name,
        status: passed ? 'passed' : 'failed',
        allowedExitCodes: [0],
        result: {
            command: name,
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : (error?.message || error || `${name} failed`),
            error: error?.message || undefined,
        },
    };
}

async function prepareSourceWriteExecuteFixture(workspace, name, options = {}) {
    const caseWorkspace = path.join(workspace, name);
    await fsp.mkdir(caseWorkspace, { recursive: true });
    const conversationId = `${name}-conversation`;
    const targetPath = `${name}-target.txt`;
    const evidencePath = `${name}-evidence.json`;
    const originalContent = options.originalContent || `alpha ${name}\nbeta original\n`;
    const proposedContent = options.proposedContent || `alpha ${name}\nbeta executed\n`;
    await fsp.writeFile(path.join(caseWorkspace, targetPath), originalContent, 'utf8');
    await fsp.writeFile(path.join(caseWorkspace, evidencePath), JSON.stringify({ kind: 'source-write-smoke-evidence', name }, null, 2), 'utf8');
    await commandFloatingChatTurn(caseWorkspace, {}, `Harmony ${name} source-write execute smoke turn.`, conversationId);
    const body = { conversationId, toolReportPath: evidencePath, path: targetPath, proposedContent, validationCommand: 'npm run compile' };
    const preview = await handleSourceWritePreflightAction(caseWorkspace, {}, { ...body, mode: 'preview' });
    const preflight = await handleSourceWritePreflightAction(caseWorkspace, {}, {
        ...body,
        mode: 'execute',
        confirmation: preview.preview.requiredConfirmation,
        previewReceiptId: preview.preview.previewReceipt.id,
    });
    if (preflight.exitCode === 2 || preflight.ok === false) throw new Error(`source-write preflight fixture failed for ${name}`);
    return {
        workspace: caseWorkspace,
        conversationId,
        targetPath,
        evidencePath,
        originalContent,
        proposedContent,
        preflightReportPath: preflight.reportPath,
    };
}

async function runSourceWriteExecuteApprovedOverwriteSmoke(workspace) {
    const summary = { previewReceiptId: '', executeReceiptId: '', reportPath: '', targetChanged: false, snapshotWritten: false, executeReceiptWritten: false, sourceFileWrites: false };
    try {
        const fixture = await prepareSourceWriteExecuteFixture(workspace, 'source-write-execute-approved-overwrite');
        const body = { preflightReportPath: fixture.preflightReportPath, proposedContent: fixture.proposedContent };
        const preview = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'preview' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        const executed = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: summary.previewReceiptId });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.targetChanged = await fsp.readFile(path.join(fixture.workspace, fixture.targetPath), 'utf8') === fixture.proposedContent;
        summary.snapshotWritten = Boolean(executed?.report?.snapshot?.manifestPath && await pathExists(executed.report.snapshot.manifestPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.sourceFileWrites = executed?.report?.contract?.authority?.sourceFileWrites === true && executed?.report?.write?.performed === true;
        const passed = executed.ok === true && Boolean(summary.executeReceiptId) && summary.targetChanged && summary.snapshotWritten && summary.executeReceiptWritten && summary.sourceFileWrites;
        return sourceWriteExecuteSmokeResult('source-write-execute-approved-overwrite', summary, passed);
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-approved-overwrite', summary, false, error);
    }
}

async function runSourceWriteExecuteStaleTargetBlockSmoke(workspace) {
    const summary = { previewBlocked: false, executeBlocked: false, targetUnchangedByExecute: false };
    try {
        const fixture = await prepareSourceWriteExecuteFixture(workspace, 'source-write-execute-stale-target-block');
        const staleContent = `${fixture.originalContent}stale mutation before execute\n`;
        await fsp.writeFile(path.join(fixture.workspace, fixture.targetPath), staleContent, 'utf8');
        const body = { preflightReportPath: fixture.preflightReportPath, proposedContent: fixture.proposedContent };
        const preview = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'preview' });
        summary.previewBlocked = preview?.preview?.summary?.status === 'blocked';
        const executed = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: preview.preview.previewReceipt.id });
        summary.executeBlocked = executed.ok === false && executed?.report?.status === 'blocked-before-write';
        summary.targetUnchangedByExecute = await fsp.readFile(path.join(fixture.workspace, fixture.targetPath), 'utf8') === staleContent;
        return sourceWriteExecuteSmokeResult('source-write-execute-stale-target-block', summary, summary.previewBlocked && summary.executeBlocked && summary.targetUnchangedByExecute);
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-stale-target-block', summary, false, error);
    }
}

async function runSourceWriteExecuteWrongConfirmationBlockSmoke(workspace) {
    const summary = { previewReady: false, wrongConfirmationRejected: false, targetUnchanged: false };
    try {
        const fixture = await prepareSourceWriteExecuteFixture(workspace, 'source-write-execute-wrong-confirmation-block');
        const body = { preflightReportPath: fixture.preflightReportPath, proposedContent: fixture.proposedContent };
        const preview = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'preview' });
        summary.previewReady = preview?.preview?.summary?.status === 'ready';
        try {
            await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'execute', confirmation: 'WRONG CONFIRMATION', previewReceiptId: preview.preview.previewReceipt.id });
        } catch (error) {
            summary.wrongConfirmationRejected = error?.statusCode === 409 && /Exact confirmation required/i.test(error.message || '');
        }
        summary.targetUnchanged = await fsp.readFile(path.join(fixture.workspace, fixture.targetPath), 'utf8') === fixture.originalContent;
        return sourceWriteExecuteSmokeResult('source-write-execute-wrong-confirmation-block', summary, summary.previewReady && summary.wrongConfirmationRejected && summary.targetUnchanged);
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-wrong-confirmation-block', summary, false, error);
    }
}

async function runSourceWriteExecuteDigestMismatchBlockSmoke(workspace) {
    const summary = { previewBlocked: false, executeBlocked: false, targetUnchanged: false };
    try {
        const fixture = await prepareSourceWriteExecuteFixture(workspace, 'source-write-execute-digest-mismatch-block');
        const body = { preflightReportPath: fixture.preflightReportPath, proposedContent: `${fixture.proposedContent}tampered\n` };
        const preview = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'preview' });
        summary.previewBlocked = preview?.preview?.summary?.status === 'blocked';
        const executed = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: preview.preview.previewReceipt.id });
        summary.executeBlocked = executed.ok === false && executed?.report?.status === 'blocked-before-write';
        summary.targetUnchanged = await fsp.readFile(path.join(fixture.workspace, fixture.targetPath), 'utf8') === fixture.originalContent;
        return sourceWriteExecuteSmokeResult('source-write-execute-digest-mismatch-block', summary, summary.previewBlocked && summary.executeBlocked && summary.targetUnchanged);
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-digest-mismatch-block', summary, false, error);
    }
}

async function runSourceWriteExecuteLockBlockSmoke(workspace) {
    const summary = { lockCreated: false, previewBlocked: false, executeBlocked: false, targetUnchanged: false };
    try {
        const fixture = await prepareSourceWriteExecuteFixture(workspace, 'source-write-execute-lock-block');
        const lockPath = sourceWriteExecuteLockPath(fixture.workspace);
        await fsp.mkdir(path.dirname(lockPath), { recursive: true });
        await fsp.writeFile(lockPath, JSON.stringify({ version: 1, kind: 'source.writeExecute.lock', token: 'smoke-lock', pid: process.pid, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), workspace: normalizePath(fixture.workspace), operation: 'source.writeExecute' }, null, 2), 'utf8');
        summary.lockCreated = await pathExists(lockPath);
        const body = { preflightReportPath: fixture.preflightReportPath, proposedContent: fixture.proposedContent };
        const preview = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'preview' });
        summary.previewBlocked = preview?.preview?.summary?.status === 'blocked';
        const executed = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: preview.preview.previewReceipt.id });
        summary.executeBlocked = executed.ok === false && executed?.report?.status === 'blocked-before-write';
        summary.targetUnchanged = await fsp.readFile(path.join(fixture.workspace, fixture.targetPath), 'utf8') === fixture.originalContent;
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        return sourceWriteExecuteSmokeResult('source-write-execute-lock-block', summary, summary.lockCreated && summary.previewBlocked && summary.executeBlocked && summary.targetUnchanged);
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-lock-block', summary, false, error);
    }
}

async function runSourceWriteExecuteRollbackProofSmoke(workspace) {
    const summary = { targetChanged: false, snapshotId: '', restoreExitCode: undefined, targetRestored: false };
    try {
        const fixture = await prepareSourceWriteExecuteFixture(workspace, 'source-write-execute-rollback-proof');
        const body = { preflightReportPath: fixture.preflightReportPath, proposedContent: fixture.proposedContent };
        const preview = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'preview' });
        const executed = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: preview.preview.previewReceipt.id });
        summary.targetChanged = await fsp.readFile(path.join(fixture.workspace, fixture.targetPath), 'utf8') === fixture.proposedContent;
        summary.snapshotId = executed?.report?.snapshot?.id || '';
        summary.restoreExitCode = summary.snapshotId ? await commandSnapshot(fixture.workspace, 'restore', { id: summary.snapshotId, all: true, confirm: true, json: true }) : 2;
        summary.targetRestored = await fsp.readFile(path.join(fixture.workspace, fixture.targetPath), 'utf8') === fixture.originalContent;
        return sourceWriteExecuteSmokeResult('source-write-execute-rollback-proof', summary, summary.targetChanged && Boolean(summary.snapshotId) && summary.restoreExitCode === 0 && summary.targetRestored);
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-rollback-proof', summary, false, error);
    }
}

async function runSourceWriteExecuteAuthorityBlockSmoke(workspace) {
    const summary = { sourceWriteAuthority: false, terminalBlocked: false, providerBlocked: false, gitBlocked: false, packageInstallBlocked: false, editorReloadBlocked: false, chatDeletionBlocked: false };
    try {
        const fixture = await prepareSourceWriteExecuteFixture(workspace, 'source-write-execute-authority-block');
        const body = { preflightReportPath: fixture.preflightReportPath, proposedContent: fixture.proposedContent };
        const preview = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'preview' });
        const executed = await handleSourceWriteExecuteAction(fixture.workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: preview.preview.previewReceipt.id });
        const authority = executed?.report?.contract?.authority || {};
        summary.sourceWriteAuthority = authority.sourceFileWrites === true && executed?.report?.write?.performed === true;
        summary.terminalBlocked = authority.terminalCommands === false && executed?.report?.terminalCommand?.performed === false;
        summary.providerBlocked = authority.providerCalls === false && executed?.report?.providerCall?.performed === false;
        summary.gitBlocked = authority.gitMutations === false && executed?.report?.gitMutation?.performed === false;
        summary.packageInstallBlocked = authority.packageInstall === false;
        summary.editorReloadBlocked = authority.editorReload === false;
        summary.chatDeletionBlocked = authority.chatDeletion === false;
        return sourceWriteExecuteSmokeResult('source-write-execute-authority-block', summary, Object.values(summary).every(Boolean));
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-authority-block', summary, false, error);
    }
}

async function runSourceWriteExecuteNativeUiPresentSmoke() {
    const summary = { requiredMarkers: [], missingMarkers: [], forbiddenMarkers: [], nativeUiChecked: false };
    try {
        const nativeUiPath = path.join(extensionRoot(), 'native-ui', 'src', 'main.ts');
        const source = await fsp.readFile(nativeUiPath, 'utf8');
        summary.nativeUiChecked = true;
        summary.requiredMarkers = ['/actions/source-write-execute', 'preview-source-write-execute', 'execute-source-write-execute', 'Source-Write Execute', 'sourceWriteExecuteAction', 'sourceWriteExecutePreflightReportPath', 'previewReceiptId', 'source-write-execute-confirmation'];
        summary.missingMarkers = summary.requiredMarkers.filter(marker => !source.includes(marker));
        summary.forbiddenMarkers = ['terminalCommandAction =', 'providerCallAction =', 'gitMutationAction =', 'packageInstallAction =', 'editorReloadAction =', 'chatDeletionAction ='].filter(marker => source.includes(marker));
        return sourceWriteExecuteSmokeResult('source-write-execute-native-ui-receipt-gated', summary, summary.nativeUiChecked && summary.missingMarkers.length === 0 && summary.forbiddenMarkers.length === 0);
    } catch (error) {
        return sourceWriteExecuteSmokeResult('source-write-execute-native-ui-receipt-gated', summary, false, error);
    }
}

async function commandSourceWriteExecuteSmoke(root, options) {
    const id = `source-write-execute-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const tempWorkspace = path.join(os.tmpdir(), id);
    await fsp.mkdir(tempWorkspace, { recursive: true });
    const steps = [];
    try {
        steps.push(await runSourceWriteExecuteApprovedOverwriteSmoke(tempWorkspace));
        steps.push(await runSourceWriteExecuteStaleTargetBlockSmoke(tempWorkspace));
        steps.push(await runSourceWriteExecuteWrongConfirmationBlockSmoke(tempWorkspace));
        steps.push(await runSourceWriteExecuteDigestMismatchBlockSmoke(tempWorkspace));
        steps.push(await runSourceWriteExecuteLockBlockSmoke(tempWorkspace));
        steps.push(await runSourceWriteExecuteRollbackProofSmoke(tempWorkspace));
        steps.push(await runSourceWriteExecuteAuthorityBlockSmoke(tempWorkspace));
        steps.push(await runSourceWriteExecuteNativeUiPresentSmoke());
    } finally {
        if (!options.keep) await fsp.rm(tempWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
    const report = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        tempWorkspace: normalizePath(tempWorkspace),
        tempWorkspaceKept: Boolean(options.keep),
        status: steps.every(step => step.status === 'passed') ? 'passed' : 'failed',
        posture: 'source-write-execute-smoke-suite-native-ui-receipt-gated',
        steps,
    };
    const reportPath = await writeSmokeReport(root, report);
    await appendLedgerEntry(root, { kind: 'smoke.sourceWriteExecute', label: `Source-write execute smoke ${report.status}`, status: report.status === 'passed' ? 'completed' : 'failed', reportPath: normalizePath(reportPath), tempWorkspace: report.tempWorkspace });
    if (options.json) printJson({ reportPath, report });
    else {
        const lines = [
            `Source-write execute smoke: ${report.status}`,
            `Report: ${normalizePath(reportPath)}`,
            `Temp workspace: ${report.tempWorkspaceKept ? report.tempWorkspace : `${report.tempWorkspace} (removed)`}`,
            '',
            ...report.steps.map(step => `- ${step.status === 'passed' ? 'PASS' : 'FAIL'} ${step.name}`),
            '',
        ];
        process.stdout.write(lines.join(os.EOL));
    }
    return report.status === 'passed' ? 0 : 2;
}

async function runFloatingChatResponseExecuteSmoke(workspace) {
    const summary = {
        responseRequestCreated: false,
        responseGateRecorded: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        providerCallBlocked: false,
        noSecretValues: false,
        executeReceiptWritten: false,
    };
    const conversationId = 'response-execute-smoke';
    try {
        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat response execute smoke turn.', conversationId);
        summary.responseRequestCreated = Boolean(turn?.report?.responseRequest?.path && await pathExists(turn.report.responseRequest.path));
        const gate = await commandFloatingChatResponseGate(workspace, {}, { conversationId });
        summary.responseGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));

        const preview = await handleFloatingChatResponseExecuteAction(workspace, {}, { mode: 'preview', conversationId, provider: 'gemini' });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatResponseExecuteAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, conversationId, provider: 'gemini' });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatResponseExecuteAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
            conversationId,
            provider: 'gemini',
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.providerCallBlocked = executed?.report?.providerCall?.performed === false && executed?.report?.status === 'blocked-before-provider-call';
        const reportText = summary.reportPath ? await fsp.readFile(summary.reportPath, 'utf8').catch(() => '') : '';
        summary.noSecretValues = !/fake-secret-for-phase3-smoke/i.test(reportText) && !/api[_-]?key/i.test(reportText);

        const passed = summary.responseRequestCreated
            && summary.responseGateRecorded
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.providerCallBlocked
            && summary.noSecretValues
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat response execute controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat response execute controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat response execute controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatToolExecuteSmoke(workspace) {
    const summary = {
        conversationCreated: false,
        policyGateRecorded: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        conversationUpdated: false,
        readOnlyToolPerformed: false,
        mutationAuthorityBlocked: false,
        executeReceiptWritten: false,
    };
    const conversationId = 'tool-execute-smoke';
    try {
        const targetPath = path.join(workspace, 'tool-smoke.txt');
        await fsp.writeFile(targetPath, 'alpha smoke line\nbeta tool line\n', 'utf8');
        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat tool execute smoke turn.', conversationId);
        summary.conversationCreated = Boolean(turn?.report?.conversation?.path && await pathExists(turn.report.conversation.path));
        const gate = await commandOutsideToolPolicyGate(workspace, {}, { reason: 'floating chat tool execute smoke' });
        summary.policyGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));

        const body = { mode: 'preview', conversationId, tool: 'grep', path: 'tool-smoke.txt', pattern: 'tool' };
        const preview = await handleFloatingChatToolExecuteAction(workspace, {}, body);
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatToolExecuteAction(workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatToolExecuteAction(workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: summary.previewReceiptId });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.readOnlyToolPerformed = executed?.report?.toolExecution?.performed === true && executed?.report?.toolExecution?.tool === 'grep';
        summary.mutationAuthorityBlocked = executed?.report?.contract?.authority?.sourceFileWrites === false
            && executed?.report?.contract?.authority?.terminalCommands === false
            && executed?.report?.contract?.authority?.providerCalls === false
            && executed?.report?.contract?.authority?.gitMutations === false
            && executed?.report?.contract?.authority?.chatDeletion === false;
        const conversation = await readJson(path.join(workspace, '.harmony', 'floating-chat', 'conversations', `${conversationId}.json`));
        summary.conversationUpdated = Array.isArray(conversation?.turns) && conversation.turns.some(turnRecord => turnRecord.role === 'tool' && turnRecord.tool?.name === 'grep');

        const passed = summary.conversationCreated
            && summary.policyGateRecorded
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.conversationUpdated
            && summary.readOnlyToolPerformed
            && summary.mutationAuthorityBlocked
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat read-only tool execute controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat read-only tool execute controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat read-only tool execute controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatToolPreflightSmoke(workspace) {
    const summary = {
        conversationCreated: false,
        assistantToolRequestAdded: false,
        policyGateRecorded: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        preflightReady: false,
        noToolExecuted: false,
        executeReceiptWritten: false,
    };
    const conversationId = 'tool-preflight-smoke';
    try {
        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat tool preflight smoke turn.', conversationId);
        const conversationPath = turn?.report?.conversation?.path;
        summary.conversationCreated = Boolean(conversationPath && await pathExists(conversationPath));
        const conversation = await readJson(conversationPath);
        const toolRequestText = JSON.stringify({ tool: 'grep', path: 'package.json', pattern: 'harmony-extension', maxMatches: 5 }, null, 2);
        const toolRequestHash = crypto.createHash('sha256').update(toolRequestText, 'utf8').digest('hex');
        conversation.turns.push({
            id: `assistant-tool-request-${toolRequestHash.slice(0, 8)}`,
            role: 'assistant',
            createdAt: new Date().toISOString(),
            source: 'phase3-smoke-provider-tool-request',
            message: { text: toolRequestText, chars: toolRequestText.length, sha256: toolRequestHash },
            toolExecution: 'not-performed',
        });
        await fsp.writeFile(conversationPath, JSON.stringify(conversation, null, 2), 'utf8');
        summary.assistantToolRequestAdded = true;
        const gate = await commandOutsideToolPolicyGate(workspace, {}, { reason: 'floating chat tool preflight smoke' });
        summary.policyGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));

        const preview = await handleFloatingChatToolPreflightAction(workspace, {}, { mode: 'preview', conversationId });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatToolPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, conversationId });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatToolPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: summary.previewReceiptId, conversationId });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.preflightReady = executed?.report?.status === 'ready' && executed?.report?.contract?.candidate?.tool === 'grep';
        summary.noToolExecuted = executed?.report?.toolExecution?.performed === false && executed?.report?.contract?.authority?.toolExecution === false;

        const passed = summary.conversationCreated
            && summary.assistantToolRequestAdded
            && summary.policyGateRecorded
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.preflightReady
            && summary.noToolExecuted
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat provider tool preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat provider tool preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat provider tool preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatToolLoopPreflightSmoke(workspace) {
    const summary = {
        conversationCreated: false,
        assistantLoopRequestAdded: false,
        autonomyPolicyEnabled: false,
        policyGateRecorded: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        loopPreflightReady: false,
        plannedStepCount: 0,
        noToolExecuted: false,
        noProviderCall: false,
        noMutationAuthority: false,
        executeReceiptWritten: false,
    };
    const conversationId = 'tool-loop-preflight-smoke';
    try {
        await fsp.writeFile(path.join(workspace, 'tool-loop-source.txt'), 'alpha loop line\nbeta loop line\n', 'utf8');
        const policy = await readOutsidePolicy(workspace) || defaultOutsidePolicy(workspace);
        policy.permissions = { ...(policy.permissions || {}), autonomousLoops: true };
        policy.budgets = { ...(policy.budgets || {}), maxAutonomousSteps: 3 };
        policy.updatedAt = new Date().toISOString();
        await fsp.mkdir(path.dirname(outsidePolicyPath(workspace)), { recursive: true });
        await fsp.writeFile(outsidePolicyPath(workspace), JSON.stringify(policy, null, 2), 'utf8');
        summary.autonomyPolicyEnabled = Boolean(policy.permissions.autonomousLoops && policy.budgets.maxAutonomousSteps >= 2);

        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat tool loop preflight smoke turn.', conversationId);
        const conversationPath = turn?.report?.conversation?.path;
        summary.conversationCreated = Boolean(conversationPath && await pathExists(conversationPath));
        const conversation = await readJson(conversationPath);
        const loopRequestText = JSON.stringify({
            tool_calls: [
                { tool: 'read-file', path: 'tool-loop-source.txt', maxChars: 4000 },
                { tool: 'grep', path: 'tool-loop-source.txt', pattern: 'loop', maxMatches: 5 },
            ],
        }, null, 2);
        const loopRequestHash = crypto.createHash('sha256').update(loopRequestText, 'utf8').digest('hex');
        conversation.turns.push({
            id: `assistant-tool-loop-${loopRequestHash.slice(0, 8)}`,
            role: 'assistant',
            createdAt: new Date().toISOString(),
            source: 'phase3-smoke-provider-tool-loop-request',
            message: { text: loopRequestText, chars: loopRequestText.length, sha256: loopRequestHash },
            toolExecution: 'not-performed',
        });
        await fsp.writeFile(conversationPath, JSON.stringify(conversation, null, 2), 'utf8');
        summary.assistantLoopRequestAdded = true;
        const gate = await commandOutsideToolPolicyGate(workspace, {}, { reason: 'floating chat tool loop preflight smoke' });
        summary.policyGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));

        const preview = await handleFloatingChatToolLoopPreflightAction(workspace, {}, { mode: 'preview', conversationId, maxSteps: 3 });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatToolLoopPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, conversationId, maxSteps: 3 });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatToolLoopPreflightAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: summary.previewReceiptId, conversationId, maxSteps: 3 });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.loopPreflightReady = executed?.report?.status === 'ready';
        summary.plannedStepCount = executed?.report?.contract?.plannedSteps?.length || 0;
        summary.noToolExecuted = executed?.report?.toolExecution?.performed === false && executed?.report?.contract?.authority?.toolExecution === false;
        summary.noProviderCall = executed?.report?.providerCall?.performed === false && executed?.report?.contract?.authority?.providerCalls === false;
        summary.noMutationAuthority = executed?.report?.contract?.authority?.sourceFileWrites === false
            && executed?.report?.contract?.authority?.terminalCommands === false
            && executed?.report?.contract?.authority?.gitMutations === false
            && executed?.report?.contract?.authority?.chatDeletion === false;

        const passed = summary.conversationCreated
            && summary.assistantLoopRequestAdded
            && summary.autonomyPolicyEnabled
            && summary.policyGateRecorded
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.loopPreflightReady
            && summary.plannedStepCount === 2
            && summary.noToolExecuted
            && summary.noProviderCall
            && summary.noMutationAuthority
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat provider tool-loop preflight controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat provider tool-loop preflight controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat provider tool-loop preflight controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatToolLoopExecuteSmoke(workspace) {
    const summary = {
        conversationCreated: false,
        assistantLoopRequestAdded: false,
        autonomyPolicyEnabled: false,
        policyGateRecorded: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        executeReceiptWritten: false,
        oneStepExecuted: false,
        conversationUpdated: false,
        secondStepNotExecuted: false,
        noProviderCall: false,
        noMutationAuthority: false,
    };
    const conversationId = 'tool-loop-execute-smoke';
    try {
        await fsp.writeFile(path.join(workspace, 'tool-loop-execute-source.txt'), 'alpha loop execute line\nbeta loop execute line\n', 'utf8');
        const policy = await readOutsidePolicy(workspace) || defaultOutsidePolicy(workspace);
        policy.permissions = { ...(policy.permissions || {}), autonomousLoops: true };
        policy.budgets = { ...(policy.budgets || {}), maxAutonomousSteps: 3 };
        policy.updatedAt = new Date().toISOString();
        await fsp.mkdir(path.dirname(outsidePolicyPath(workspace)), { recursive: true });
        await fsp.writeFile(outsidePolicyPath(workspace), JSON.stringify(policy, null, 2), 'utf8');
        summary.autonomyPolicyEnabled = Boolean(policy.permissions.autonomousLoops && policy.budgets.maxAutonomousSteps >= 2);

        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat tool loop execute smoke turn.', conversationId);
        const conversationPath = turn?.report?.conversation?.path;
        summary.conversationCreated = Boolean(conversationPath && await pathExists(conversationPath));
        const conversation = await readJson(conversationPath);
        const loopRequestText = JSON.stringify({
            tool_calls: [
                { tool: 'read-file', path: 'tool-loop-execute-source.txt', maxChars: 4000 },
                { tool: 'grep', path: 'tool-loop-execute-source.txt', pattern: 'loop', maxMatches: 5 },
            ],
        }, null, 2);
        const loopRequestHash = crypto.createHash('sha256').update(loopRequestText, 'utf8').digest('hex');
        conversation.turns.push({
            id: `assistant-tool-loop-execute-${loopRequestHash.slice(0, 8)}`,
            role: 'assistant',
            createdAt: new Date().toISOString(),
            source: 'phase3-smoke-provider-tool-loop-execute-request',
            message: { text: loopRequestText, chars: loopRequestText.length, sha256: loopRequestHash },
            toolExecution: 'not-performed',
        });
        await fsp.writeFile(conversationPath, JSON.stringify(conversation, null, 2), 'utf8');
        summary.assistantLoopRequestAdded = true;
        const gate = await commandOutsideToolPolicyGate(workspace, {}, { reason: 'floating chat tool loop execute smoke' });
        summary.policyGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));

        const body = { mode: 'preview', conversationId, maxSteps: 3, stepIndex: 1 };
        const preview = await handleFloatingChatToolLoopExecuteAction(workspace, {}, body);
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatToolLoopExecuteAction(workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatToolLoopExecuteAction(workspace, {}, { ...body, mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: summary.previewReceiptId });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.oneStepExecuted = executed?.report?.loopExecution?.executedSteps === 1
            && executed?.report?.loopExecution?.stopReason === 'one-step-per-receipt limit'
            && executed?.report?.toolExecution?.tool === 'read-file';
        summary.noProviderCall = executed?.report?.providerCall?.performed === false && executed?.report?.contract?.authority?.providerCalls === false;
        summary.noMutationAuthority = executed?.report?.contract?.authority?.sourceFileWrites === false
            && executed?.report?.contract?.authority?.terminalCommands === false
            && executed?.report?.contract?.authority?.gitMutations === false
            && executed?.report?.contract?.authority?.chatDeletion === false;
        const updatedConversation = await readJson(path.join(workspace, '.harmony', 'floating-chat', 'conversations', `${conversationId}.json`));
        const loopToolTurns = Array.isArray(updatedConversation?.turns)
            ? updatedConversation.turns.filter(turnRecord => turnRecord.role === 'tool' && turnRecord.source === 'native-floating-chat-read-only-tool-loop')
            : [];
        summary.conversationUpdated = loopToolTurns.length === 1 && loopToolTurns[0]?.tool?.name === 'read-file';
        summary.secondStepNotExecuted = !loopToolTurns.some(turnRecord => turnRecord.tool?.name === 'grep');

        const passed = summary.conversationCreated
            && summary.assistantLoopRequestAdded
            && summary.autonomyPolicyEnabled
            && summary.policyGateRecorded
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.executeReceiptWritten
            && summary.oneStepExecuted
            && summary.conversationUpdated
            && summary.secondStepNotExecuted
            && summary.noProviderCall
            && summary.noMutationAuthority;
        return {
            command: 'floating chat provider tool-loop one-step execute controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat provider tool-loop one-step execute controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat provider tool-loop one-step execute controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function runFloatingChatAutonomyNextSmoke(workspace) {
    const summary = {
        conversationCreated: false,
        assistantLoopRequestAdded: false,
        autonomyPolicyEnabled: false,
        policyGateRecorded: false,
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        statusPlanned: false,
        proposedLoopPreflight: false,
        noProviderCall: false,
        noToolExecution: false,
        noMutationAuthority: false,
        executeReceiptWritten: false,
    };
    const conversationId = 'autonomy-next-smoke';
    try {
        const policy = await readOutsidePolicy(workspace) || defaultOutsidePolicy(workspace);
        policy.permissions = { ...(policy.permissions || {}), autonomousLoops: true };
        policy.budgets = { ...(policy.budgets || {}), maxAutonomousSteps: 2 };
        policy.updatedAt = new Date().toISOString();
        await fsp.mkdir(path.dirname(outsidePolicyPath(workspace)), { recursive: true });
        await fsp.writeFile(outsidePolicyPath(workspace), JSON.stringify(policy, null, 2), 'utf8');
        summary.autonomyPolicyEnabled = Boolean(policy.permissions.autonomousLoops && policy.budgets.maxAutonomousSteps >= 2);

        const turn = await commandFloatingChatTurn(workspace, {}, 'Harmony floating chat autonomy next smoke turn.', conversationId);
        const conversationPath = turn?.report?.conversation?.path;
        summary.conversationCreated = Boolean(conversationPath && await pathExists(conversationPath));
        const conversation = await readJson(conversationPath);
        const loopRequestText = JSON.stringify({ steps: [
            { tool: 'list-dir', path: '.', maxChars: 4000 },
            { tool: 'grep', path: '.', pattern: 'Harmony', maxMatches: 5 },
        ] }, null, 2);
        const loopRequestHash = crypto.createHash('sha256').update(loopRequestText, 'utf8').digest('hex');
        conversation.turns.push({
            id: `assistant-autonomy-next-${loopRequestHash.slice(0, 8)}`,
            role: 'assistant',
            createdAt: new Date().toISOString(),
            source: 'phase3-smoke-floating-chat-autonomy-next',
            message: { text: loopRequestText, chars: loopRequestText.length, sha256: loopRequestHash },
            toolExecution: 'not-performed',
        });
        await fsp.writeFile(conversationPath, JSON.stringify(conversation, null, 2), 'utf8');
        summary.assistantLoopRequestAdded = true;
        const gate = await commandOutsideToolPolicyGate(workspace, {}, { reason: 'floating chat autonomy next smoke' });
        summary.policyGateRecorded = Boolean(gate?.report?.reportPath && await pathExists(gate.report.reportPath));

        const preview = await handleFloatingChatAutonomyNextAction(workspace, {}, { mode: 'preview', conversationId });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleFloatingChatAutonomyNextAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, conversationId });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleFloatingChatAutonomyNextAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, previewReceiptId: summary.previewReceiptId, conversationId });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        summary.statusPlanned = executed?.report?.status === 'planned';
        summary.proposedLoopPreflight = executed?.report?.contract?.proposedNextAction?.kind === 'floating-chat-tool-loop-preflight';
        summary.noProviderCall = executed?.report?.providerCall?.performed === false && executed?.report?.contract?.authority?.providerCalls === false;
        summary.noToolExecution = executed?.report?.toolExecution?.performed === false && executed?.report?.contract?.authority?.toolExecution === false;
        summary.noMutationAuthority = executed?.report?.contract?.authority?.sourceFileWrites === false
            && executed?.report?.contract?.authority?.terminalCommands === false
            && executed?.report?.contract?.authority?.gitMutations === false
            && executed?.report?.contract?.authority?.chatDeletion === false;

        const passed = summary.conversationCreated
            && summary.assistantLoopRequestAdded
            && summary.autonomyPolicyEnabled
            && summary.policyGateRecorded
            && summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.statusPlanned
            && summary.proposedLoopPreflight
            && summary.noProviderCall
            && summary.noToolExecution
            && summary.noMutationAuthority
            && summary.executeReceiptWritten;
        return {
            command: 'floating chat autonomy next controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'floating chat autonomy next controlled action failed',
        };
    } catch (error) {
        return {
            command: 'floating chat autonomy next controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

function swarmReceiptDir(root) {
    return harmonyPath(root, 'swarm');
}

function autonomySafeId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

function autonomyNormalizePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim();
}

function autonomySplitList(value) {
    if (Array.isArray(value)) return value.flatMap(item => autonomySplitList(item));
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function autonomyPrivatePath(value) {
    const lower = autonomyNormalizePath(value).toLowerCase();
    return lower.startsWith('.harmony/')
        || lower.includes('/.harmony/')
        || lower.startsWith('.git/')
        || lower.includes('/.git/')
        || lower.endsWith(`.${'fa'}${'mily'}.md`);
}

function autonomySecretLookingPath(value) {
    const lower = autonomyNormalizePath(value).toLowerCase();
    return lower === '.env'
        || lower.endsWith('/.env')
        || lower.includes('secret')
        || lower.includes('token')
        || lower.includes('credential')
        || lower.includes('apikey')
        || lower.includes('api-key')
        || lower.includes('private')
        || lower.includes('id_rsa');
}

function uniqueAutonomyPaths(paths) {
    return Array.from(new Set(paths.map(autonomyNormalizePath).filter(Boolean))).sort();
}

async function readSwarmPlanReceipt(root, turnId) {
    const requested = String(turnId || 'latest').trim() || 'latest';
    const target = requested === 'latest'
        ? path.join(swarmReceiptDir(root), 'latest-plan.json')
        : path.join(swarmReceiptDir(root), autonomySafeId(requested), 'plan.json');
    const plan = await readJson(target);
    return plan ? { plan, path: normalizePath(target) } : { plan: undefined, path: normalizePath(target) };
}

async function readSwarmEscrowProposal(root, turnId, proposalId) {
    const target = path.join(swarmReceiptDir(root), autonomySafeId(turnId), 'escrow', `${autonomySafeId(proposalId)}.json`);
    const proposal = await readJson(target);
    return proposal ? { proposal, path: normalizePath(target) } : undefined;
}

async function listSwarmEscrowProposals(root, turnId, proposalIds, limit) {
    const selected = autonomySplitList(proposalIds);
    if (selected.length) {
        const proposals = [];
        for (const id of selected.slice(0, limit)) {
            const found = await readSwarmEscrowProposal(root, turnId, id);
            if (found) proposals.push(found);
        }
        return proposals;
    }
    const dir = path.join(swarmReceiptDir(root), autonomySafeId(turnId), 'escrow');
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const proposals = [];
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json')).slice(-50)) {
        const target = path.join(dir, entry.name);
        const proposal = await readJson(target);
        if (proposal) proposals.push({ proposal, path: normalizePath(target) });
    }
    return proposals
        .sort((a, b) => String(a.proposal?.createdAt || '').localeCompare(String(b.proposal?.createdAt || '')))
        .slice(0, limit);
}

function autonomyDecision(checks) {
    if (checks.some(check => check.status === 'block')) return 'blocked';
    if (checks.some(check => check.status === 'warn')) return 'caution';
    return 'ready';
}

function autonomyDigest(contract) {
    const stable = {
        version: contract.version,
        workspace: contract.workspace,
        turnId: contract.swarm.turnId,
        planFound: contract.swarm.planFound,
        planMode: contract.swarm.planMode,
        executionEnabled: contract.swarm.executionEnabled,
        selectedProposalIds: contract.swarm.selectedProposalIds,
        limits: contract.limits,
        checks: contract.checks,
        simulatedSteps: contract.simulatedSteps.map(step => ({ proposalId: step.proposalId, proposalType: step.proposalType, status: step.status, stopReason: step.stopReason, targetPaths: step.targetPaths })),
    };
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

async function autonomyDryRunContract(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const policy = await readOutsidePolicy(root) || defaultOutsidePolicy(root);
    const git = await collectGitSafetyMetadata(root);
    const requestedTurnId = String(options['turn-id'] || options.turnId || options.turn_id || 'latest').trim() || 'latest';
    const maxProposals = Math.max(1, Math.min(5, Math.floor(Number(options['max-proposals'] || options.maxProposals || 3))));
    const maxSteps = Math.max(0, Math.min(20, Math.floor(Number(policy.budgets?.maxAutonomousSteps ?? 0))));
    const { plan, path: planPath } = await readSwarmPlanReceipt(root, requestedTurnId);
    const turnId = String(plan?.turnId || requestedTurnId);
    const proposalIds = autonomySplitList(options['proposal-ids'] || options.proposalIds || options.proposal_id || options.proposalId);
    const proposalRecords = plan ? await listSwarmEscrowProposals(root, turnId, proposalIds, maxProposals) : [];
    const checks = [];
    checks.push(plan
        ? { status: 'pass', name: 'swarm_plan', detail: `Loaded swarm plan ${turnId}.` }
        : { status: 'block', name: 'swarm_plan', detail: `No swarm plan receipt found at ${planPath}.` });
    if (plan) {
        checks.push(plan.requestedMode === 'execution_guarded' && plan.executionEnabled
            ? { status: 'pass', name: 'execution_guarded', detail: 'Plan is execution_guarded and executionEnabled=true.' }
            : { status: 'block', name: 'execution_guarded', detail: `Autonomy dry-run expects an execution_guarded plan; current mode=${plan.requestedMode || 'unknown'}, executionEnabled=${Boolean(plan.executionEnabled)}.` });
        if (Array.isArray(plan.blockedScopePaths) && plan.blockedScopePaths.length) {
            checks.push({ status: 'block', name: 'blocked_scope', detail: `Plan includes blocked private scope path(s): ${plan.blockedScopePaths.join(', ')}` });
        }
    }
    checks.push(policy.permissions?.autonomousLoops && maxSteps > 0
        ? { status: 'pass', name: 'outside_policy_autonomy', detail: `autonomousLoops=true with maxAutonomousSteps=${maxSteps}.` }
        : { status: 'block', name: 'outside_policy_autonomy', detail: 'outside-VS policy must explicitly allow autonomousLoops with a nonzero maxAutonomousSteps budget before real autonomy execution.' });
    checks.push(policy.permissions?.writeFiles
        ? { status: 'warn', name: 'write_files_policy', detail: 'writeFiles is enabled; dry-run still does not write workspace files outside reports/receipts.' }
        : { status: 'pass', name: 'write_files_policy', detail: 'writeFiles is disabled; dry-run will not request file mutation authority.' });
    checks.push(policy.permissions?.runCommands
        ? { status: 'warn', name: 'run_commands_policy', detail: 'runCommands is enabled; dry-run still does not run validation or shell commands.' }
        : { status: 'pass', name: 'run_commands_policy', detail: 'runCommands is disabled; dry-run will not request command authority.' });
    checks.push(policy.permissions?.paidProviderCalls
        ? { status: 'warn', name: 'provider_policy', detail: 'paidProviderCalls is enabled; dry-run still does not call providers.' }
        : { status: 'pass', name: 'provider_policy', detail: 'paidProviderCalls is disabled; dry-run will not request provider authority.' });
    checks.push(git.insideWorkTree
        ? { status: git.statusCount ? 'warn' : 'pass', name: 'git_status', detail: git.statusCount ? `Git status has ${git.statusCount} row(s); real execution should start from an intentional clean/checkpointed state.` : 'Git status is clean.' }
        : { status: 'warn', name: 'git_status', detail: 'Workspace is not inside a Git work tree; commit follow-up will remain unavailable.' });
    if (plan && proposalRecords.length === 0) checks.push({ status: 'block', name: 'escrow_proposals', detail: proposalIds.length ? `Requested proposal id(s) not found: ${proposalIds.join(', ')}` : 'No escrow proposals found for this swarm turn.' });

    const simulatedSteps = [];
    let stepsRemaining = maxSteps;
    for (const { proposal, path: proposalPath } of proposalRecords) {
        const targetPaths = uniqueAutonomyPaths(Array.isArray(proposal.targetPaths) ? proposal.targetPaths : []);
        const blockedTargets = uniqueAutonomyPaths([...(Array.isArray(proposal.blockedTargetPaths) ? proposal.blockedTargetPaths : []), ...targetPaths.filter(target => autonomyPrivatePath(target) || autonomySecretLookingPath(target))]);
        const stepChecks = [];
        if (proposal.applied) stepChecks.push('proposal is already marked applied/executed');
        if (!proposal.executionEnabled) stepChecks.push('proposal executionEnabled=false');
        if (blockedTargets.length) stepChecks.push(`blocked/private/secret-looking target path(s): ${blockedTargets.join(', ')}`);
        if (proposal.proposalType === 'patch' && targetPaths.length === 0) stepChecks.push('patch proposal has no target paths');
        if (Number(proposal.estimatedCostUsd || 0) > Number(policy.budgets?.maxEstimatedUsd || 0) && Number(policy.budgets?.maxEstimatedUsd || 0) > 0) stepChecks.push(`estimated cost ${proposal.estimatedCostUsd} exceeds policy maxEstimatedUsd ${policy.budgets.maxEstimatedUsd}`);
        if (stepsRemaining <= 0) stepChecks.push(`maxAutonomousSteps budget exhausted before this proposal (${maxSteps})`);
        const status = stepChecks.length ? 'blocked' : 'would_run';
        if (status === 'would_run') stepsRemaining -= 1;
        simulatedSteps.push({
            proposalId: String(proposal.proposalId || path.basename(proposalPath, '.json')),
            proposalPath,
            proposalType: String(proposal.proposalType || 'unknown'),
            title: String(proposal.title || ''),
            status,
            stopReason: stepChecks.join('; ') || undefined,
            targetPaths,
            validationPlan: Array.isArray(proposal.validationPlan) ? proposal.validationPlan : [],
            estimatedCostUsd: Number(proposal.estimatedCostUsd || 0),
            applied: Boolean(proposal.applied),
        });
    }
    if (simulatedSteps.some(step => step.status === 'blocked')) checks.push({ status: 'block', name: 'proposal_simulation', detail: 'One or more selected proposals would be blocked before real execution.' });
    if (simulatedSteps.some(step => step.status === 'would_run')) checks.push({ status: 'pass', name: 'proposal_simulation', detail: `${simulatedSteps.filter(step => step.status === 'would_run').length} proposal(s) would be eligible for a future bounded execute action if all separate execution gates remain satisfied.` });

    const contract = {
        version,
        workspace: normalizePath(root),
        posture: 'bounded-dry-run-default-off',
        generatedAt: new Date().toISOString(),
        policy: {
            mode: policy.mode || 'observe',
            permissions: {
                autonomousLoops: Boolean(policy.permissions?.autonomousLoops),
                writeFiles: Boolean(policy.permissions?.writeFiles),
                runCommands: Boolean(policy.permissions?.runCommands),
                paidProviderCalls: Boolean(policy.permissions?.paidProviderCalls),
                gitMutations: Boolean(policy.permissions?.gitMutations),
            },
            budgets: {
                maxAutonomousSteps: policy.budgets?.maxAutonomousSteps ?? 0,
                maxCommandSeconds: policy.budgets?.maxCommandSeconds ?? 0,
                maxEstimatedUsd: policy.budgets?.maxEstimatedUsd ?? 0,
            },
        },
        repository: {
            insideWorkTree: Boolean(git.insideWorkTree),
            branch: git.branch || '',
            statusCount: git.statusCount || 0,
            stagedCount: git.stagedCount || 0,
            unstagedCount: git.unstagedCount || 0,
        },
        swarm: {
            requestedTurnId,
            turnId,
            planFound: Boolean(plan),
            planPath,
            planMode: plan?.requestedMode || '',
            executionEnabled: Boolean(plan?.executionEnabled),
            objective: String(plan?.objective || ''),
            proposalCount: proposalRecords.length,
            selectedProposalIds: simulatedSteps.map(step => step.proposalId),
            requestedProposalIds: proposalIds,
        },
        limits: {
            maxProposals,
            maxSteps,
            maxRuntimeSeconds: Math.max(30, Math.min(900, Math.floor(Number(options['max-runtime-seconds'] || options.maxRuntimeSeconds || 300)))),
        },
        simulatedSteps,
        authority: {
            providerCalls: false,
            sourceFileWrites: false,
            terminalCommands: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
            reportWritesOnly: true,
        },
        checks,
        decision: autonomyDecision(checks),
        notes: [
            'Dry-run only. This action reads swarm receipts, outside-VS policy, and git metadata, then writes a report/receipt.',
            'It does not call providers, apply patches, run validation commands, stage files, commit, push, install packages, reload editors, or delete chats.',
            'A future real execute action must require its own preview receipt, exact confirmation, budgets, snapshots, operation locks, validation, and stop conditions.',
        ],
    };
    contract.digest = autonomyDigest(contract);
    return contract;
}

async function autonomyDryRunActionPreview(root, options) {
    const contract = await autonomyDryRunContract(root, options);
    return {
        action: 'autonomy-dry-run',
        version: contract.version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'autonomy.dryRun',
            decision: contract.decision,
            planFound: contract.swarm.planFound,
            proposalCount: contract.swarm.proposalCount,
        },
        summary: {
            posture: contract.posture,
            decision: contract.decision,
            autonomousLoops: contract.policy.permissions.autonomousLoops,
            maxAutonomousSteps: contract.policy.budgets.maxAutonomousSteps,
            proposalCount: contract.swarm.proposalCount,
            wouldRun: contract.simulatedSteps.filter(step => step.status === 'would_run').length,
            blocked: contract.simulatedSteps.filter(step => step.status === 'blocked').length,
        },
        requiredConfirmation: autonomyDryRunConfirmation(contract),
        writes: [
            normalizePath(harmonyPath(root, 'autonomy', 'autonomy-dry-run-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-autonomy-dry-run-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandAutonomyDryRun(root, options) {
    const contract = await autonomyDryRunContract(root, options);
    const report = {
        version: 1,
        kind: 'autonomy.dryRun',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: contract.version,
        status: contract.decision,
        contract,
    };
    const dir = harmonyPath(root, 'autonomy');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `autonomy-dry-run-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'autonomy.dryRun',
        label: `Autonomy dry-run ${contract.decision}`,
        status: contract.decision === 'ready' ? 'completed' : contract.decision,
        reportPath: normalizePath(outPath),
        version: contract.version,
        turnId: contract.swarm.turnId,
        proposals: contract.swarm.proposalCount,
        wouldRun: contract.simulatedSteps.filter(step => step.status === 'would_run').length,
        blocked: contract.simulatedSteps.filter(step => step.status === 'blocked').length,
    });
    return { exitCode: contract.decision === 'ready' ? 0 : 2, report: { ...report, reportPath: normalizePath(outPath) } };
}

async function runAutonomyDryRunSmoke(workspace) {
    const summary = {
        previewReceiptId: '',
        missingReceiptRejected: false,
        executeReceiptId: '',
        reportPath: '',
        reportWritten: false,
        statusBlocked: false,
        noPlanBlock: false,
        noProviderCalls: false,
        noSourceFileWrites: false,
        noTerminalCommands: false,
        noGitMutations: false,
        noPackageInstall: false,
        noEditorReload: false,
        noChatDeletion: false,
        executeReceiptWritten: false,
        fixturePreviewReceiptId: '',
        fixtureExecuteReceiptId: '',
        fixtureReportPath: '',
        fixtureDecision: '',
        fixturePlanFound: false,
        fixtureProposalCount: 0,
        fixtureWouldRun: 0,
        fixtureBlocked: 0,
        fixtureSecretBlocked: false,
        fixturePolicyAllowed: false,
        fixtureAuthorityStillBlocked: false,
    };
    try {
        const preview = await handleAutonomyDryRunAction(workspace, {}, { mode: 'preview', turnId: 'latest', maxProposals: 3 });
        summary.previewReceiptId = preview?.preview?.previewReceipt?.id || '';
        if (!summary.previewReceiptId) throw new Error('preview did not return preview.previewReceipt.id');

        try {
            await handleAutonomyDryRunAction(workspace, {}, { mode: 'execute', confirmation: preview.preview.requiredConfirmation, turnId: 'latest', maxProposals: 3 });
        } catch (error) {
            summary.missingReceiptRejected = error?.statusCode === 409 && /Preview receipt id required/i.test(error.message || '');
        }

        const executed = await handleAutonomyDryRunAction(workspace, {}, {
            mode: 'execute',
            confirmation: preview.preview.requiredConfirmation,
            previewReceiptId: summary.previewReceiptId,
            turnId: 'latest',
            maxProposals: 3,
        });
        summary.executeReceiptId = executed?.executeReceipt?.id || '';
        summary.reportPath = executed?.reportPath || '';
        summary.reportWritten = Boolean(summary.reportPath && await pathExists(summary.reportPath));
        summary.executeReceiptWritten = Boolean(executed?.executeReceipt?.path && await pathExists(executed.executeReceipt.path));
        const contract = executed?.report?.contract || {};
        summary.statusBlocked = executed?.report?.status === 'blocked' && contract.decision === 'blocked';
        summary.noPlanBlock = Array.isArray(contract.checks) && contract.checks.some(check => check?.status === 'block' && check?.name === 'swarm_plan');
        summary.noProviderCalls = contract.authority?.providerCalls === false;
        summary.noSourceFileWrites = contract.authority?.sourceFileWrites === false;
        summary.noTerminalCommands = contract.authority?.terminalCommands === false;
        summary.noGitMutations = contract.authority?.gitMutations === false;
        summary.noPackageInstall = contract.authority?.packageInstall === false;
        summary.noEditorReload = contract.authority?.editorReload === false;
        summary.noChatDeletion = contract.authority?.chatDeletion === false;

        const policy = await readOutsidePolicy(workspace) || defaultOutsidePolicy(workspace);
        policy.permissions = { ...(policy.permissions || {}), autonomousLoops: true };
        policy.budgets = { ...(policy.budgets || {}), maxAutonomousSteps: 2, maxEstimatedUsd: 0.05 };
        policy.updatedAt = new Date().toISOString();
        await fsp.mkdir(path.dirname(outsidePolicyPath(workspace)), { recursive: true });
        await fsp.writeFile(outsidePolicyPath(workspace), JSON.stringify(policy, null, 2), 'utf8');

        const turnId = 'autonomy-fixture-turn';
        const turnDir = path.join(swarmReceiptDir(workspace), turnId);
        const escrowDir = path.join(turnDir, 'escrow');
        await fsp.mkdir(escrowDir, { recursive: true });
        const plan = {
            version: 1,
            turnId,
            objective: 'phase3 autonomy dry-run fixture',
            requestedMode: 'execution_guarded',
            executionEnabled: true,
            blockedScopePaths: [],
            createdAt: new Date().toISOString(),
        };
        await fsp.writeFile(path.join(turnDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
        await fsp.writeFile(path.join(swarmReceiptDir(workspace), 'latest-plan.json'), JSON.stringify(plan, null, 2), 'utf8');
        const readyProposal = {
            version: 1,
            turnId,
            proposalId: 'ready-patch',
            proposalType: 'patch',
            title: 'Ready patch fixture',
            executionEnabled: true,
            targetPaths: ['src/ready-fixture.txt'],
            validationPlan: ['node check-ready-fixture.js'],
            estimatedCostUsd: 0.01,
            applied: false,
            createdAt: '2026-01-01T00:00:00.000Z',
        };
        const blockedProposal = {
            version: 1,
            turnId,
            proposalId: 'secret-path-patch',
            proposalType: 'patch',
            title: 'Secret path block fixture',
            executionEnabled: true,
            targetPaths: ['.env'],
            validationPlan: ['node check-secret-fixture.js'],
            estimatedCostUsd: 0.01,
            applied: false,
            createdAt: '2026-01-01T00:00:01.000Z',
        };
        await fsp.writeFile(path.join(escrowDir, 'ready-patch.json'), JSON.stringify(readyProposal, null, 2), 'utf8');
        await fsp.writeFile(path.join(escrowDir, 'secret-path-patch.json'), JSON.stringify(blockedProposal, null, 2), 'utf8');

        const fixturePreview = await handleAutonomyDryRunAction(workspace, {}, { mode: 'preview', turnId, proposalIds: 'ready-patch,secret-path-patch', maxProposals: 3 });
        summary.fixturePreviewReceiptId = fixturePreview?.preview?.previewReceipt?.id || '';
        if (!summary.fixturePreviewReceiptId) throw new Error('fixture preview did not return preview.previewReceipt.id');
        const fixtureExecuted = await handleAutonomyDryRunAction(workspace, {}, {
            mode: 'execute',
            confirmation: fixturePreview.preview.requiredConfirmation,
            previewReceiptId: summary.fixturePreviewReceiptId,
            turnId,
            proposalIds: 'ready-patch,secret-path-patch',
            maxProposals: 3,
        });
        const fixtureContract = fixtureExecuted?.report?.contract || {};
        const fixtureSteps = Array.isArray(fixtureContract.simulatedSteps) ? fixtureContract.simulatedSteps : [];
        summary.fixtureExecuteReceiptId = fixtureExecuted?.executeReceipt?.id || '';
        summary.fixtureReportPath = fixtureExecuted?.reportPath || '';
        summary.fixtureDecision = fixtureContract.decision || '';
        summary.fixturePlanFound = Boolean(fixtureContract.swarm?.planFound);
        summary.fixtureProposalCount = fixtureContract.swarm?.proposalCount || 0;
        summary.fixtureWouldRun = fixtureSteps.filter(step => step.status === 'would_run').length;
        summary.fixtureBlocked = fixtureSteps.filter(step => step.status === 'blocked').length;
        summary.fixtureSecretBlocked = fixtureSteps.some(step => step.proposalId === 'secret-path-patch' && /secret-looking|blocked\/private/i.test(step.stopReason || ''));
        summary.fixturePolicyAllowed = fixtureContract.policy?.permissions?.autonomousLoops === true && Number(fixtureContract.policy?.budgets?.maxAutonomousSteps || 0) === 2;
        summary.fixtureAuthorityStillBlocked = fixtureContract.authority?.providerCalls === false
            && fixtureContract.authority?.sourceFileWrites === false
            && fixtureContract.authority?.terminalCommands === false
            && fixtureContract.authority?.gitMutations === false
            && fixtureContract.authority?.chatDeletion === false;

        const passed = summary.missingReceiptRejected
            && Boolean(summary.executeReceiptId)
            && summary.reportWritten
            && summary.statusBlocked
            && summary.noPlanBlock
            && summary.noProviderCalls
            && summary.noSourceFileWrites
            && summary.noTerminalCommands
            && summary.noGitMutations
            && summary.noPackageInstall
            && summary.noEditorReload
            && summary.noChatDeletion
            && summary.executeReceiptWritten
            && Boolean(summary.fixtureExecuteReceiptId)
            && Boolean(summary.fixtureReportPath && await pathExists(summary.fixtureReportPath))
            && summary.fixtureDecision === 'blocked'
            && summary.fixturePlanFound
            && summary.fixtureProposalCount === 2
            && summary.fixtureWouldRun === 1
            && summary.fixtureBlocked === 1
            && summary.fixtureSecretBlocked
            && summary.fixturePolicyAllowed
            && summary.fixtureAuthorityStillBlocked;
        return {
            command: 'autonomy dry-run controlled action',
            exitCode: passed ? 0 : 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: passed ? '' : 'autonomy dry-run controlled action failed',
        };
    } catch (error) {
        return {
            command: 'autonomy dry-run controlled action',
            exitCode: 2,
            stdout: JSON.stringify(summary, null, 2),
            stderr: error && error.message ? error.message : String(error),
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function autonomyCommitGateContract(root, options) {
    const policy = await readOutsidePolicy(root) || defaultOutsidePolicy(root);
    const git = await collectGitSafetyMetadata(root);
    return {
        posture: 'expert-gated-default-off',
        currentPermissions: {
            autonomousLoops: Boolean(policy.permissions?.autonomousLoops),
            gitMutations: Boolean(policy.permissions?.gitMutations),
            runCommands: Boolean(policy.permissions?.runCommands),
            writeFiles: Boolean(policy.permissions?.writeFiles),
        },
        budgets: {
            maxAutonomousSteps: policy.budgets?.maxAutonomousSteps ?? 0,
            maxCommandSeconds: policy.budgets?.maxCommandSeconds ?? 0,
            maxEstimatedUsd: policy.budgets?.maxEstimatedUsd ?? 0,
        },
        repository: {
            insideWorkTree: Boolean(git.insideWorkTree),
            branch: git.branch || '',
            statusCount: git.statusCount || 0,
            stagedCount: git.stagedCount || 0,
            unstagedCount: git.unstagedCount || 0,
        },
        allowedFutureActions: [
            'multi-proposal-dry-run',
            'proposal-comparison-report',
            'manifest-only-commit-dry-run',
            'manifest-only-commit-execute',
        ],
        requiredBeforeAutonomy: [
            'outside-VS policy must explicitly allow autonomousLoops with a nonzero maxAutonomousSteps budget',
            'provider/tool registry report must be fresh and must not include secret values',
            'each proposal must write an isolated plan, diff summary, validation result, and rollback path',
            'the user must select exactly one proposal before any write, command, provider, or git authority runs',
            'every autonomous loop must stop at budget exhaustion, validation failure, or missing preview receipt',
        ],
        requiredBeforeCommit: [
            'outside-VS policy must explicitly allow gitMutations',
            'fresh Git Safety Report must show the target branch and status rows before staging',
            'commit must be manifest-only and path-scoped to files listed in the selected proposal receipt',
            'pre-commit snapshot or restore path must be captured before staging',
            'dry-run cached diff and staged path checks must pass before commit execution',
            'post-commit receipt must include commit hash, staged paths, validation status, and rollback instructions',
        ],
        blockedAuthorityClasses: [
            'autonomous multi-step execution from this gate action',
            'provider calls from this gate action',
            'file writes outside .harmony reports and receipts from this gate action',
            'git add, commit, checkout, reset, clean, merge, rebase, pull, or push from this gate action',
        ],
        notes: [
            'This gate is contract-only. It does not run autonomous loops, call providers, edit source files, stage files, commit, or push.',
            'Future autonomy and commit actions must cite this contract and produce their own preview and execute receipts.',
        ],
    };
}

async function autonomyCommitGateActionPreview(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await autonomyCommitGateContract(root, options);
    return {
        action: 'autonomy-commit-gate',
        version,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'autonomy.commitGate',
            autonomousLoopsCurrentlyAllowed: contract.currentPermissions.autonomousLoops,
            gitMutationsCurrentlyAllowed: contract.currentPermissions.gitMutations,
        },
        summary: {
            posture: contract.posture,
            autonomousLoops: contract.currentPermissions.autonomousLoops,
            gitMutations: contract.currentPermissions.gitMutations,
            requiredBeforeAutonomy: contract.requiredBeforeAutonomy.length,
            requiredBeforeCommit: contract.requiredBeforeCommit.length,
            blockedAuthorityClasses: contract.blockedAuthorityClasses.length,
        },
        requiredConfirmation: autonomyCommitGateConfirmation(version),
        writes: [
            normalizePath(harmonyPath(root, 'autonomy', 'autonomy-commit-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-autonomy-commit-gate-<timestamp>.execute.json')),
        ],
        checks: [
            'reads outside-VS policy and read-only Git metadata before writing the autonomy/commit contract',
            'does not run autonomous loops, call providers, edit source files, stage, commit, or push',
            'keeps multi-proposal execution and in-swarm commits default-off until separate gated actions exist',
        ],
        contract,
    };
}

async function commandAutonomyCommitGate(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const contract = await autonomyCommitGateContract(root, options);
    const payload = {
        version: 1,
        kind: 'autonomy.commitGate',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: version,
        contract,
    };
    const dir = harmonyPath(root, 'autonomy');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `autonomy-commit-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'autonomy.commitGate',
        label: 'Autonomy and commit expert gate contract',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version,
        autonomousLoops: contract.currentPermissions.autonomousLoops,
        gitMutations: contract.currentPermissions.gitMutations,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

function toolPolicyExamples(toolNames, patterns, limit = 8) {
    const regexes = patterns.map(pattern => new RegExp(pattern, 'i'));
    return toolNames.filter(name => regexes.some(regex => regex.test(name))).slice(0, limit);
}

async function outsideToolPolicyGateContract(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const storedPolicy = await readOutsidePolicy(root);
    const policy = storedPolicy || defaultOutsidePolicy(root);
    const git = await collectGitSafetyMetadata(root);
    const toolNames = packageToolNames(pkg);
    const permissions = policy.permissions || {};
    const budgets = policy.budgets || {};
    const toolClasses = [
        {
            id: 'read-only-workspace',
            label: 'Read-only workspace tools',
            currentlyAllowed: true,
            examples: toolPolicyExamples(toolNames, ['read', 'list', 'grep', 'status', 'report', 'scan', 'brief', 'matrix', 'outline']),
            requirements: ['fresh action preview receipt', 'workspace-contained paths', 'no secret value disclosure', 'bounded output size'],
        },
        {
            id: 'file-mutation',
            label: 'File write/edit/patch tools',
            currentlyAllowed: Boolean(permissions.writeFiles),
            examples: toolPolicyExamples(toolNames, ['write', 'edit', 'patch', 'apply', 'surgery', 'visual', 'canvas']),
            requirements: ['outside-VS policy writeFiles=true', 'fresh pre-action snapshot manifest', 'path manifest with no private/secret-looking paths', 'post-write validation receipt'],
        },
        {
            id: 'terminal-command',
            label: 'Terminal and validation commands',
            currentlyAllowed: Boolean(permissions.runCommands) && Number(budgets.maxCommandSeconds || 0) > 0,
            examples: toolPolicyExamples(toolNames, ['terminal', 'command', 'run', 'validation', 'smoke']),
            requirements: ['outside-VS policy runCommands=true', 'nonzero maxCommandSeconds budget', 'fixed command allowlist or exact command preview', 'captured stdout/stderr receipt'],
        },
        {
            id: 'provider-call',
            label: 'Provider calls',
            currentlyAllowed: Boolean(permissions.paidProviderCalls) && Number(budgets.maxEstimatedUsd || 0) > 0,
            examples: toolPolicyExamples(toolNames, ['provider', 'pricing', 'response']),
            requirements: ['outside-VS policy paidProviderCalls=true', 'budget check before call', 'credential metadata without secret values', 'model/provider/cost receipt'],
        },
        {
            id: 'git-mutation',
            label: 'Git mutation tools',
            currentlyAllowed: Boolean(permissions.gitMutations) && Boolean(git.insideWorkTree),
            examples: toolPolicyExamples(toolNames, ['git', 'commit', 'stash', 'restore', 'revert']),
            requirements: ['outside-VS policy gitMutations=true', 'fresh git safety report', 'manifest-only staging', 'pre-commit snapshot or restore path', 'no push/reset/clean/checkout unless separately named'],
        },
        {
            id: 'package-editor-lifecycle',
            label: 'Package install and editor reload',
            currentlyAllowed: false,
            examples: ['npm run package', 'install:vsix', 'editor reload'],
            requirements: ['separate final-install checkpoint', 'release receipt', 'explicit user-selected install path'],
        },
        {
            id: 'chat-retention',
            label: 'Chat retention and menu clearing',
            currentlyAllowed: false,
            examples: ['clear from menu only', 'no archive/delete authority'],
            requirements: ['chat content deletion remains unavailable', 'menu clearing must not remove saved conversation records'],
        },
    ];
    const checks = [
        { name: 'tool manifest present', status: toolNames.length > 0 ? 'passed' : 'failed', detail: `${toolNames.length} Harmony tools in package manifest` },
        { name: 'outside-VS policy loaded', status: storedPolicy ? 'passed' : 'blocked', detail: storedPolicy ? normalizePath(outsidePolicyPath(root)) : 'using observe-only default because policy file is missing' },
        { name: 'write tools require snapshots', status: 'passed', detail: 'file mutation class requires fresh pre-action snapshot manifest before future execution' },
        { name: 'terminal commands require bounded budget', status: Boolean(permissions.runCommands) && Number(budgets.maxCommandSeconds || 0) > 0 ? 'passed' : 'blocked', detail: `runCommands=${Boolean(permissions.runCommands)} maxCommandSeconds=${budgets.maxCommandSeconds || 0}` },
        { name: 'provider calls require paid-provider budget', status: Boolean(permissions.paidProviderCalls) && Number(budgets.maxEstimatedUsd || 0) > 0 ? 'passed' : 'blocked', detail: `paidProviderCalls=${Boolean(permissions.paidProviderCalls)} maxEstimatedUsd=${budgets.maxEstimatedUsd || 0}` },
        { name: 'chat deletion remains blocked', status: 'passed', detail: 'clear-from-menu is not archive/delete authority' },
    ];
    return {
        posture: 'outside-vs-tool-policy-contract-only',
        packageVersion: version,
        generatedAt: new Date().toISOString(),
        workspace: normalizePath(root),
        policy: {
            exists: Boolean(storedPolicy),
            mode: policy.mode || 'observe',
            path: normalizePath(outsidePolicyPath(root)),
            permissions: {
                autonomousLoops: Boolean(permissions.autonomousLoops),
                writeFiles: Boolean(permissions.writeFiles),
                runCommands: Boolean(permissions.runCommands),
                paidProviderCalls: Boolean(permissions.paidProviderCalls),
                gitMutations: Boolean(permissions.gitMutations),
            },
            budgets: {
                maxAutonomousSteps: budgets.maxAutonomousSteps ?? 0,
                maxCommandSeconds: budgets.maxCommandSeconds ?? 0,
                maxEstimatedUsd: budgets.maxEstimatedUsd ?? 0,
            },
        },
        repository: {
            insideWorkTree: Boolean(git.insideWorkTree),
            branch: git.branch || '',
            statusCount: git.statusCount || 0,
            stagedCount: git.stagedCount || 0,
            unstagedCount: git.unstagedCount || 0,
        },
        packageTools: {
            count: toolNames.length,
            sample: toolNames.slice(0, 25),
        },
        toolClasses,
        requiredBeforeToolExecution: [
            'fresh outside tool policy gate receipt for the current package version',
            'fresh floating-chat response gate/preflight receipt for the exact conversation turn',
            'per-tool preview receipt and exact confirmation phrase before any mutation-capable tool runs',
            'workspace-contained manifest with no private, secret-looking, .git, or .harmony target paths',
            'pre-action snapshot manifest before file mutation, git staging, or restore-like operations',
            'bounded command/provider budgets checked immediately before execution',
            'operation lock for command, file, git, package, editor, or autonomy classes',
            'post-action receipt with touched paths, validation results, and rollback/restore command',
        ],
        blockedAuthorityClasses: [
            'tool execution from this gate action',
            'file writes from this gate action',
            'terminal commands from this gate action',
            'provider calls from this gate action',
            'git mutation from this gate action',
            'package install or editor reload from this gate action',
            'chat deletion or archive from any outside-VS tool-policy path',
        ],
        authority: {
            toolExecution: false,
            sourceFileWrites: false,
            terminalCommands: false,
            providerCalls: false,
            gitMutations: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
            reportWritesOnly: true,
        },
        checks,
        notes: [
            'This gate records policy and tool-class requirements only. It does not execute tools or grant authority by itself.',
            'Future tool-capable floating chat must cite this report and then use separate per-tool preview and execute receipts.',
        ],
    };
}

async function outsideToolPolicyGateActionPreview(root, options) {
    const contract = await outsideToolPolicyGateContract(root, options);
    return {
        action: 'outside-tool-policy-gate',
        version: contract.packageVersion,
        workspace: normalizePath(root),
        target: {
            allowed: true,
            kind: 'outside.toolPolicyGate',
            policyMode: contract.policy.mode,
            toolClasses: contract.toolClasses.length,
        },
        summary: {
            posture: contract.posture,
            policyExists: contract.policy.exists,
            toolCount: contract.packageTools.count,
            writeFiles: contract.policy.permissions.writeFiles,
            runCommands: contract.policy.permissions.runCommands,
            paidProviderCalls: contract.policy.permissions.paidProviderCalls,
            gitMutations: contract.policy.permissions.gitMutations,
            reportOnlyAuthority: contract.authority.reportWritesOnly,
        },
        requiredConfirmation: outsideToolPolicyGateConfirmation(contract.packageVersion),
        writes: [
            normalizePath(harmonyPath(root, 'tool-policy', 'outside-tool-policy-gate-<timestamp>.json')),
            normalizePath(harmonyPath(root, 'operations', 'ledger.json')),
            normalizePath(harmonyPath(root, 'native-actions', 'native-execute-outside-tool-policy-gate-<timestamp>.execute.json')),
        ],
        checks: contract.checks.map(check => `${String(check.status).toUpperCase()}: ${check.name}: ${check.detail}`),
        contract,
    };
}

async function commandOutsideToolPolicyGate(root, options) {
    const contract = await outsideToolPolicyGateContract(root, options);
    const payload = {
        version: 1,
        kind: 'outside.toolPolicyGate',
        generatedAt: new Date().toISOString(),
        workspace: root,
        packageVersion: contract.packageVersion,
        status: 'recorded',
        contract,
    };
    const dir = harmonyPath(root, 'tool-policy');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `outside-tool-policy-gate-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'outside.toolPolicyGate',
        label: 'Outside-VS tool policy gate contract',
        status: 'completed',
        reportPath: normalizePath(outPath),
        version: contract.packageVersion,
        toolClasses: contract.toolClasses.length,
        toolCount: contract.packageTools.count,
    });
    return { exitCode: 0, report: { ...payload, reportPath: normalizePath(outPath) } };
}

async function handleReleaseReceiptAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const actionOptions = { ...options, packageOnly: Boolean(body?.packageOnly || body?.['package-only'] || options['package-only']) };
    const preview = await releaseReceiptActionPreview(root, actionOptions);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'release-receipt', preview) };
    if (mode !== 'execute') throw new Error('release-receipt action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'release-receipt', body, preview);
    const result = await commandReleaseReceipt(root, {
        ...options,
        packageOnly: actionOptions.packageOnly,
        notes: 'Created from native UI controlled action.',
        returnReceipt: true,
    });
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'release-receipt', previewReceipt, result);
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        receipt: result.receipt,
        reportPath: result.receipt?.reportPath,
    };
}

async function handlePrivacyScanAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await privacyScanActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'privacy-scan', preview) };
    if (mode !== 'execute') throw new Error('privacy-scan action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'privacy-scan', body, preview);
    const result = await commandPrivacyScan(root, { ...options, returnReport: true });
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'privacy-scan', previewReceipt, result);
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleDiagnosticsAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await diagnosticsActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'diagnostics', preview) };
    if (mode !== 'execute') throw new Error('diagnostics action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'diagnostics', body, preview);
    const result = await commandDiagnose(root, { ...options, returnReport: true, recordLedger: true });
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'diagnostics', previewReceipt, result);
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleSnapshotDrillAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await snapshotDrillActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'snapshot-drill', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('snapshot-drill action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'snapshot-drill', body, preview);
    if (!preview.target?.allowed) {
        const error = new Error(`Snapshot drill target is not allowed: ${preview.target?.reason || 'unknown reason'}`);
        error.statusCode = 409;
        throw error;
    }
    if (preview.target?.exists) {
        const error = new Error(`Snapshot drill refuses to overwrite existing path: ${preview.path}`);
        error.statusCode = 409;
        throw error;
    }
    const result = await commandSnapshot(root, 'drill', { path: preview.path, confirm: true, returnResult: true });
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'snapshot-drill', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.result?.manifestPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        drill: result.result,
        reportPath: result.result?.manifestPath,
    };
}

async function handlePolicyReportAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await policyReportActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'policy-report', preview) };
    if (mode !== 'execute') throw new Error('policy-report action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'policy-report', body, preview);
    const result = await commandPolicyReport(root);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'policy-report', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleBrokerProviderReportAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await brokerProviderReportActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'broker-provider-report', preview) };
    if (mode !== 'execute') throw new Error('broker-provider-report action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'broker-provider-report', body, preview);
    const result = await commandBrokerProviderReport(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'broker-provider-report', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleGitSafetyReportAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await gitSafetyReportActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'git-safety-report', preview) };
    if (mode !== 'execute') throw new Error('git-safety-report action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'git-safety-report', body, preview);
    const result = await commandGitSafetyReport(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'git-safety-report', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleTerminalCommandReportAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await terminalCommandReportActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'terminal-command-report', preview) };
    if (mode !== 'execute') throw new Error('terminal-command-report action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'terminal-command-report', body, preview);
    const result = await commandTerminalCommandReport(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'terminal-command-report', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleSelfHealingReportAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await selfHealingReportActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'self-healing-report', preview) };
    if (mode !== 'execute') throw new Error('self-healing-report action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'self-healing-report', body, preview);
    const result = await commandSelfHealingReport(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'self-healing-report', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleSelfHealingGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await selfHealingGateActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'self-healing-gate', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('self-healing-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'self-healing-gate', body, preview);
    const result = await commandSelfHealingGate(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'self-healing-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleSelfHealingPackagePreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await selfHealingPackagePreflightActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'self-healing-package-preflight', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('self-healing-package-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'self-healing-package-preflight', body, preview);
    const result = await commandSelfHealingPackagePreflight(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'self-healing-package-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleReportAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleReportActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-report', preview) };
    if (mode !== 'execute') throw new Error('native-lifecycle-report action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-report', body, preview);
    const result = await commandNativeLifecycleReport(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-report', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecyclePreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecyclePreflightActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-preflight', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-preflight', body, preview);
    const result = await commandNativeLifecyclePreflight(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleStartGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleStartGateActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-start-gate', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-start-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-start-gate', body, preview);
    const result = await commandNativeLifecycleStartGate(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-start-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleStopGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleStopGateActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-stop-gate', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-stop-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-stop-gate', body, preview);
    const result = await commandNativeLifecycleStopGate(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-stop-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleReconnectGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleReconnectGateActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-reconnect-gate', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-reconnect-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-reconnect-gate', body, preview);
    const result = await commandNativeLifecycleReconnectGate(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-reconnect-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleStartPreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleStartPreflightActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-start-preflight', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-start-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-start-preflight', body, preview);
    const result = await commandNativeLifecycleStartPreflight(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-start-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleDaemonStartAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleDaemonStartActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-daemon-start', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-daemon-start action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-daemon-start', body, preview);
    const result = await commandNativeLifecycleDaemonStart(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-daemon-start', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        mode: result.report?.result?.mode,
        pid: result.report?.result?.pid,
        backendUrl: result.report?.owner?.backendUrl,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleWindowOpenAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleWindowOpenActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-window-open', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-window-open action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-window-open', body, preview);
    const result = await commandNativeLifecycleWindowOpen(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-window-open', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        mode: result.report?.result?.mode,
        pid: result.report?.result?.pid,
        backendUrl: result.report?.owner?.backendUrl,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleStopPreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleStopPreflightActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-stop-preflight', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-stop-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-stop-preflight', body, preview);
    const result = await commandNativeLifecycleStopPreflight(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-stop-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleStopExecuteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleStopExecuteActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-stop-execute', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-stop-execute action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-stop-execute', body, preview);
    const result = await commandNativeLifecycleStopExecute(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-stop-execute', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        targets: result.report?.contractBefore?.targets?.length || 0,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleReconnectPreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleReconnectPreflightActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-reconnect-preflight', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-reconnect-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-reconnect-preflight', body, preview);
    const result = await commandNativeLifecycleReconnectPreflight(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-reconnect-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleRestartPreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleRestartPreflightActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-restart-preflight', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-restart-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-restart-preflight', body, preview);
    const result = await commandNativeLifecycleRestartPreflight(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-restart-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        recoveryMode: result.report?.contract?.recovery?.mode || 'unknown',
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleRestartExecuteGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleRestartExecuteGateActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-restart-execute-gate', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-restart-execute-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-restart-execute-gate', body, preview);
    const result = await commandNativeLifecycleRestartExecuteGate(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-restart-execute-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        recoveryMode: result.report?.contract?.proposedFutureExecute?.mode || 'unknown',
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleRestartExecuteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleRestartExecuteActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-restart-execute', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-restart-execute action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-restart-execute', body, preview);
    const result = await commandNativeLifecycleRestartExecute(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-restart-execute', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        recoveryMode: result.report?.contractBefore?.recoveryMode || 'unknown',
        resultStatus: result.report?.result?.status || 'none',
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeLifecycleReconnectExecuteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeLifecycleReconnectExecuteActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-lifecycle-reconnect-execute', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('native-lifecycle-reconnect-execute action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-lifecycle-reconnect-execute', body, preview);
    const result = await commandNativeLifecycleReconnectExecute(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-lifecycle-reconnect-execute', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        pid: result.report?.result?.pid,
        backendUrl: result.report?.owner?.backendUrl,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatNoteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const message = floatingChatNoteMessage(body);
    const preview = await floatingChatNoteActionPreview(root, options, { ...body, message });
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-note', preview) };
    if (mode !== 'execute') throw new Error('floating-chat-note action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-note', body, preview);
    const result = await commandFloatingChatNote(root, options, message);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-note', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatTurnAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const message = floatingChatTurnMessage(body);
    const conversationId = floatingChatConversationId(body);
    const preview = await floatingChatTurnActionPreview(root, options, { ...body, message, conversationId });
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-turn', preview) };
    if (mode !== 'execute') throw new Error('floating-chat-turn action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-turn', body, preview);
    const result = await commandFloatingChatTurn(root, options, message, conversationId);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-turn', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatResponseGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatResponseGateActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-response-gate', preview) };
    if (mode !== 'execute') throw new Error('floating-chat-response-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-response-gate', body, preview);
    const result = await commandFloatingChatResponseGate(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-response-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatResponsePreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatResponsePreflightActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-response-preflight', preview) };
    if (mode !== 'execute') throw new Error('floating-chat-response-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-response-preflight', body, preview);
    const result = await commandFloatingChatResponsePreflight(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-response-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatResponseExecuteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatResponseExecuteActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-response-execute', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('floating-chat-response-execute action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-response-execute', body, preview);
    const result = await commandFloatingChatResponseExecute(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-response-execute', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatToolExecuteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatToolExecuteActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-tool-execute', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('floating-chat-tool-execute action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-tool-execute', body, preview);
    const result = await commandFloatingChatToolExecute(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-tool-execute', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleNativeFileWriteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await nativeFileWriteActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'native-file-write', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('native-file-write action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'native-file-write', body, preview);
    const result = await commandNativeFileWrite(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'native-file-write', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        path: result.report?.write?.path,
        snapshotId: result.report?.snapshot?.id,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleSourceWritePreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await sourceWritePreflightActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'source-write-preflight', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('source-write-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'source-write-preflight', body, preview);
    const result = await commandSourceWritePreflight(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'source-write-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        path: result.report?.contract?.target?.path,
        sourceFileWrites: false,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleSourceWriteExecuteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await sourceWriteExecuteActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'source-write-execute', preview, { riskLevel: 'high' }) };
    if (mode !== 'execute') throw new Error('source-write-execute action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'source-write-execute', body, preview);
    const result = await commandSourceWriteExecute(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'source-write-execute', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        path: result.report?.write?.path,
        sourceFileWrites: result.report?.write?.performed === true,
        snapshotId: result.report?.snapshot?.id,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatToolPreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatToolPreflightActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-tool-preflight', preview, { riskLevel: 'low' }) };
    if (mode !== 'execute') throw new Error('floating-chat-tool-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-tool-preflight', body, preview);
    const result = await commandFloatingChatToolPreflight(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-tool-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatToolLoopPreflightAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatToolLoopPreflightActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-tool-loop-preflight', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('floating-chat-tool-loop-preflight action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-tool-loop-preflight', body, preview);
    const result = await commandFloatingChatToolLoopPreflight(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-tool-loop-preflight', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        plannedSteps: result.report?.contract?.plannedSteps?.length || 0,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatToolLoopExecuteAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatToolLoopExecuteActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-tool-loop-execute', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('floating-chat-tool-loop-execute action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-tool-loop-execute', body, preview);
    const result = await commandFloatingChatToolLoopExecute(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-tool-loop-execute', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        stepIndex: result.report?.contract?.selectedStep?.index,
        tool: result.report?.contract?.selectedStep?.tool?.name,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleFloatingChatAutonomyNextAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await floatingChatAutonomyNextActionPreview(root, options, body);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'floating-chat-autonomy-next', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('floating-chat-autonomy-next action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'floating-chat-autonomy-next', body, preview);
    const result = await commandFloatingChatAutonomyNext(root, options, body);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'floating-chat-autonomy-next', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        proposedNextAction: result.report?.contract?.proposedNextAction?.kind,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleAutonomyCommitGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await autonomyCommitGateActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'autonomy-commit-gate', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('autonomy-commit-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'autonomy-commit-gate', body, preview);
    const result = await commandAutonomyCommitGate(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'autonomy-commit-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleOutsideToolPolicyGateAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const preview = await outsideToolPolicyGateActionPreview(root, options);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'outside-tool-policy-gate', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('outside-tool-policy-gate action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'outside-tool-policy-gate', body, preview);
    const result = await commandOutsideToolPolicyGate(root, options);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'outside-tool-policy-gate', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
        status: result.report?.status,
        toolClasses: result.report?.contract?.toolClasses?.length || 0,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function handleAutonomyDryRunAction(root, options, body) {
    const mode = String(body?.mode || 'preview').toLowerCase();
    const actionOptions = { ...options, ...body };
    const preview = await autonomyDryRunActionPreview(root, actionOptions);
    if (mode === 'preview') return { ok: true, mode, preview: await writeNativeActionPreviewReceipt(root, 'autonomy-dry-run', preview, { riskLevel: 'medium' }) };
    if (mode !== 'execute') throw new Error('autonomy-dry-run action supports mode preview or execute');
    const previewReceipt = await requireNativeActionPreviewReceipt(root, 'autonomy-dry-run', body, preview);
    const result = await commandAutonomyDryRun(root, actionOptions);
    const executeReceipt = await writeNativeActionExecuteReceipt(root, 'autonomy-dry-run', previewReceipt, {
        exitCode: result.exitCode,
        reportPath: result.report?.reportPath,
    });
    return {
        ok: result.exitCode === 0,
        mode,
        preview: { ...preview, previewReceipt: nativeActionReceiptSummary(previewReceipt) },
        executeReceipt: nativeActionReceiptSummary(executeReceipt),
        report: result.report,
        reportPath: result.report?.reportPath,
    };
}

async function commandUiServe(root, options) {
    const host = String(options.host || '127.0.0.1');
    const port = Number(options.port || 8788);
    if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error('ui serve requires --port between 0 and 65535');
    const refreshMs = Math.max(1000, Number(options.refresh || 2000));
    let heartbeatPath = '';
    let heartbeatTimer;
    const heartbeatOptions = {
        ...options,
        surface: 'floating',
        label: String(options.label || 'Harmony floating UI shell'),
        'stale-after': Math.max(DEFAULT_STALE_AFTER_MS, refreshMs * 4),
    };
    if (!options['no-heartbeat']) {
        heartbeatPath = await writeHeartbeat(root, heartbeatOptions);
        heartbeatTimer = setInterval(() => {
            writeHeartbeat(root, heartbeatOptions).catch(() => undefined);
        }, Math.max(5000, refreshMs * 2));
    }
    const server = http.createServer(async (req, res) => {
        const method = String(req.method || 'GET').toUpperCase();
        const headOnly = method === 'HEAD';
        const cors = applyUiCorsHeaders(req, res);
        if (cors.hasOrigin && !cors.allowed) {
            sendJsonHttp(res, 403, { error: 'Harmony UI backend only accepts localhost or Tauri origins.' }, headOnly);
            return;
        }
        if (method === 'OPTIONS') {
            sendHttp(res, 204, 'text/plain; charset=utf-8', '', true);
            return;
        }
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
            sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
            return;
        }
        try {
            const requestUrl = new URL(req.url || '/', `http://${host}`);
            if (requestUrl.pathname === '/actions/release-receipt') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleReleaseReceiptAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/privacy-scan') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handlePrivacyScanAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/diagnostics') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleDiagnosticsAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/snapshot-drill') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleSnapshotDrillAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/policy-report') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handlePolicyReportAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/broker-provider-report') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleBrokerProviderReportAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/git-safety-report') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleGitSafetyReportAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/terminal-command-report') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleTerminalCommandReportAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/self-healing-report') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleSelfHealingReportAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/self-healing-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleSelfHealingGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/self-healing-package-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleSelfHealingPackagePreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-report') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleReportAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecyclePreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-start-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleStartGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-stop-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleStopGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-reconnect-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleReconnectGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-start-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleStartPreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-daemon-start') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleDaemonStartAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-window-open') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleWindowOpenAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-stop-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleStopPreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-stop-execute') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleStopExecuteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                scheduleNativeLifecycleDeferredSelfStop(result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-reconnect-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleReconnectPreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-restart-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleRestartPreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-restart-execute-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleRestartExecuteGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-restart-execute') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleRestartExecuteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-lifecycle-reconnect-execute') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeLifecycleReconnectExecuteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-note') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatNoteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-turn') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatTurnAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-response-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatResponseGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-response-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatResponsePreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-response-execute') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatResponseExecuteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-tool-execute') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatToolExecuteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/native-file-write') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleNativeFileWriteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/source-write-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleSourceWritePreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/source-write-execute') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleSourceWriteExecuteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-tool-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatToolPreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-tool-loop-preflight') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatToolLoopPreflightAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-tool-loop-execute') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatToolLoopExecuteAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/floating-chat-autonomy-next') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleFloatingChatAutonomyNextAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/autonomy-commit-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleAutonomyCommitGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/outside-tool-policy-gate') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleOutsideToolPolicyGateAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (requestUrl.pathname === '/actions/autonomy-dry-run') {
                if (method !== 'POST') {
                    sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                    return;
                }
                if (!isLoopbackUiHost(host)) {
                    sendJsonHttp(res, 403, { error: 'Controlled native actions require ui serve to bind to localhost.' });
                    return;
                }
                const body = await readJsonBody(req);
                const result = await handleAutonomyDryRunAction(root, options, body);
                sendJsonHttp(res, 200, result);
                return;
            }
            if (method !== 'GET' && method !== 'HEAD') {
                sendHttp(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', headOnly);
                return;
            }
            if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
                const state = await collectState(root, options);
                sendHttp(res, 200, 'text/html; charset=utf-8', renderLiveDashboardShell(state, { ...options, refresh: refreshMs }), headOnly);
                return;
            }
            if (requestUrl.pathname === '/state') {
                const state = await collectState(root, options);
                sendHttp(res, 200, 'application/json; charset=utf-8', JSON.stringify(state, null, 2), headOnly);
                return;
            }
            if (requestUrl.pathname === '/healthz') {
                sendHttp(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, workspace: root, heartbeatPath }), headOnly);
                return;
            }
            sendHttp(res, 404, 'text/plain; charset=utf-8', 'Not found', headOnly);
        } catch (error) {
            sendJsonHttp(res, error?.statusCode || 500, { error: error && error.message ? error.message : String(error) }, headOnly);
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host}:${actualPort}/`;
    if (options.json) printJson({ url, workspace: root, heartbeatPath: heartbeatPath || undefined, refreshMs, mode: 'read-only-plus-controlled-actions' });
    else process.stdout.write(`Harmony floating UI shell: ${url}${os.EOL}Workspace: ${root}${os.EOL}Mode: read-only plus preview-receipted release/privacy/diagnostics/snapshot-drill/policy-report/broker-provider-report/git-safety-report/terminal-command-report/self-healing-report/self-healing-gate/self-healing-package-preflight/native-lifecycle-report/native-lifecycle-preflight/native-lifecycle-start-gate/native-lifecycle-stop-gate/native-lifecycle-reconnect-gate/native-lifecycle-start-preflight/native-lifecycle-daemon-start/native-lifecycle-window-open/native-lifecycle-stop-preflight/native-lifecycle-stop-execute/native-lifecycle-reconnect-preflight/native-lifecycle-restart-preflight/native-lifecycle-restart-execute-gate/native-lifecycle-reconnect-execute/floating-chat-note/floating-chat-turn/floating-chat-response-gate/floating-chat-response-preflight/floating-chat-response-execute/floating-chat-tool-preflight/floating-chat-tool-loop-preflight/floating-chat-tool-loop-execute/floating-chat-autonomy-next/floating-chat-tool-execute/native-file-write/source-write-preflight/source-write-execute/autonomy-commit-gate/autonomy-dry-run actions${os.EOL}`);
    if (options.open) {
        const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        childProcess.spawn(opener, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    await new Promise(resolve => {
        const shutdown = () => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            server.close(resolve);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    });
}

function localHttpJson(url, timeoutMs = 1500) {
    return new Promise(resolve => {
        const request = http.get(url, { timeout: timeoutMs }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                let json;
                try { json = JSON.parse(body); } catch { json = undefined; }
                resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode, json, body });
            });
        });
        request.on('timeout', () => {
            request.destroy(new Error('timeout'));
        });
        request.on('error', error => resolve({ ok: false, error: error && error.message ? error.message : String(error) }));
    });
}

async function waitForLocalHttpOk(url, timeoutMs = 15000) {
    const startedAt = Date.now();
    let lastProbe = { ok: false, error: 'not checked' };
    while (Date.now() - startedAt < timeoutMs) {
        lastProbe = await localHttpJson(url, 1200);
        if (lastProbe.ok) return lastProbe;
        await new Promise(resolve => setTimeout(resolve, 350));
    }
    const error = new Error(`Timed out waiting for ${url}: ${lastProbe.error || lastProbe.statusCode || 'not ready'}`);
    error.statusCode = 2;
    throw error;
}

function nativeUiNpmCommandLine() {
    return 'npm --prefix native-ui run tauri:dev';
}

function nativeUiNpmSpawn() {
    if (process.platform === 'win32') {
        return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', nativeUiNpmCommandLine()] };
    }
    return { command: 'npm', args: ['--prefix', 'native-ui', 'run', 'tauri:dev'] };
}

function uiNativeLaunchPlan(root, options) {
    const host = String(options.host || '127.0.0.1');
    const port = Number(options.port || 8788);
    const backendUrl = `http://${host}:${port}/`;
    const healthUrl = `${backendUrl}healthz`;
    const cliPath = path.join(extensionRoot(), 'bin', 'harmony-cli.js');
    const nativeDir = path.join(extensionRoot(), 'native-ui');
    const backendArgs = [cliPath, '--workspace', root, 'ui', 'serve', '--host', host, '--port', String(port), '--label', 'Harmony native floating chat backend'];
    const nativeSpawn = nativeUiNpmSpawn();
    return {
        workspace: normalizePath(root),
        backendUrl,
        healthUrl,
        host,
        port,
        nativeDir: normalizePath(nativeDir),
        prerequisites: {
            nativePackageJson: normalizePath(path.join(nativeDir, 'package.json')),
            tauriConfig: normalizePath(path.join(nativeDir, 'src-tauri', 'tauri.conf.json')),
        },
        backend: {
            command: process.execPath,
            args: backendArgs,
            commandLine: `${process.execPath} ${backendArgs.map(item => JSON.stringify(item)).join(' ')}`,
        },
        nativeWindow: {
            command: nativeSpawn.command,
            args: nativeSpawn.args,
            commandLine: nativeUiNpmCommandLine(),
        },
        authority: {
            startsLocalBackend: true,
            opensNativeWindow: true,
            providerCalls: false,
            toolExecution: false,
            gitMutation: false,
            packageInstall: false,
            editorReload: false,
            chatDeletion: false,
        },
    };
}

async function commandUiNative(root, options) {
    const plan = uiNativeLaunchPlan(root, options);
    if (!isLoopbackUiHost(plan.host)) throw new Error('ui native only supports localhost or 127.0.0.1 backends.');
    if (!Number.isFinite(plan.port) || plan.port < 1 || plan.port > 65535) throw new Error('ui native requires --port between 1 and 65535.');
    const nativePackageExists = await pathExists(plan.prerequisites.nativePackageJson);
    const tauriConfigExists = await pathExists(plan.prerequisites.tauriConfig);
    const planned = { ...plan, prerequisites: { ...plan.prerequisites, nativePackageExists, tauriConfigExists } };
    if (options['dry-run']) {
        if (options.json) printJson(planned);
        else process.stdout.write(`Harmony native floating chat launch plan:${os.EOL}- Backend: ${planned.backendUrl}${os.EOL}- Window: ${planned.nativeWindow.commandLine}${os.EOL}`);
        return 0;
    }
    if (!nativePackageExists) throw new Error(`Missing native-ui package.json at ${plan.prerequisites.nativePackageJson}`);
    if (!tauriConfigExists) throw new Error(`Missing Tauri config at ${plan.prerequisites.tauriConfig}`);

    let backendChild;
    let backendOwned = false;
    let shuttingDown = false;
    const existingBackend = await localHttpJson(plan.healthUrl, 1200);
    if (existingBackend.ok) {
        process.stdout.write(`Using existing Harmony backend at ${plan.backendUrl}${os.EOL}`);
    } else {
        backendOwned = true;
        backendChild = childProcess.spawn(plan.backend.command, plan.backend.args, {
            cwd: extensionRoot(),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        backendChild.stdout.on('data', chunk => process.stdout.write(String(chunk)));
        backendChild.stderr.on('data', chunk => process.stderr.write(String(chunk)));
        backendChild.once('exit', (code, signal) => {
            if (!shuttingDown) process.stderr.write(`Harmony backend exited before native window closed (code=${code ?? 'null'}, signal=${signal || 'none'}).${os.EOL}`);
        });
        await waitForLocalHttpOk(plan.healthUrl, Number(options['ready-timeout-ms'] || 20000));
    }

    const native = nativeUiNpmSpawn();
    process.stdout.write(`Opening Harmony native floating chat window.${os.EOL}Backend: ${plan.backendUrl}${os.EOL}Close the native window or press Ctrl+C here to stop the launcher.${os.EOL}`);
    const nativeChild = childProcess.spawn(native.command, native.args, {
        cwd: extensionRoot(),
        stdio: 'inherit',
        windowsHide: false,
        env: { ...process.env, HARMONY_NATIVE_BACKEND_URL: plan.backendUrl, VITE_HARMONY_NATIVE_BACKEND_URL: plan.backendUrl },
    });

    const stop = () => {
        shuttingDown = true;
        if (nativeChild && !nativeChild.killed) nativeChild.kill('SIGTERM');
        if (backendOwned && backendChild && !backendChild.killed) backendChild.kill('SIGTERM');
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return await new Promise(resolve => {
        nativeChild.once('exit', (code, signal) => {
            shuttingDown = true;
            if (backendOwned && backendChild && !backendChild.killed) backendChild.kill('SIGTERM');
            process.stdout.write(`Harmony native floating chat window closed (code=${code ?? 'null'}, signal=${signal || 'none'}).${os.EOL}`);
            resolve(code || 0);
        });
    });
}

async function commandUi(root, options) {
    const state = await collectState(root, options);
    const html = renderDashboard(state);
    const outPath = path.resolve(String(options.output || harmonyPath(root, 'supervisor', 'floating-dashboard.html')));
    const statePath = path.join(path.dirname(outPath), 'floating-dashboard-state.json');
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, html, 'utf8');
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
    if (options.json) printJson({ writtenPath: outPath, statePath, health: state.health });
    else process.stdout.write(`Floating dashboard snapshot written: ${normalizePath(outPath)} (${state.health.status}, ${state.health.warnings.length} warning, ${state.health.blocks.length} block)${os.EOL}`);
    if (options.open) {
        const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', outPath] : [outPath];
        childProcess.spawn(opener, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
}

async function commandNativeLifecycle(root, subcommand, options) {
    const commands = {
        report: commandNativeLifecycleReport,
        preflight: commandNativeLifecyclePreflight,
        'start-gate': commandNativeLifecycleStartGate,
        'stop-gate': commandNativeLifecycleStopGate,
        'reconnect-gate': commandNativeLifecycleReconnectGate,
        'start-preflight': commandNativeLifecycleStartPreflight,
        'stop-preflight': commandNativeLifecycleStopPreflight,
        stop: commandNativeLifecycleStopExecute,
        'stop-execute': commandNativeLifecycleStopExecute,
        'reconnect-preflight': commandNativeLifecycleReconnectPreflight,
        'restart-preflight': commandNativeLifecycleRestartPreflight,
        'restart-execute-gate': commandNativeLifecycleRestartExecuteGate,
        restart: commandNativeLifecycleRestartExecute,
        'restart-execute': commandNativeLifecycleRestartExecute,
        reconnect: commandNativeLifecycleReconnectExecute,
        'reconnect-execute': commandNativeLifecycleReconnectExecute,
        'daemon-start': commandNativeLifecycleDaemonStart,
        'window-open': commandNativeLifecycleWindowOpen,
    };
    const action = commands[subcommand];
    if (!action) throw new Error('native-lifecycle supports: report, preflight, start-gate, stop-gate, reconnect-gate, start-preflight, stop-preflight, stop, reconnect-preflight, restart-preflight, restart-execute-gate, restart, reconnect, daemon-start, window-open');
    const result = await action(root, options);
    if (subcommand === 'daemon-start') {
        if (options.json) printJson(result.report);
        else process.stdout.write([
            `Native backend daemon start: ${result.report.status}`,
            `Mode: ${result.report.result?.mode || 'none'}`,
            `Backend: ${result.report.owner?.backendUrl || result.report.contractBefore?.spawnPlan?.healthEndpoint || 'unknown'}`,
            `PID: ${result.report.result?.pid || 'unknown'}`,
            `Report: ${result.report.reportPath}`,
            '',
        ].join(os.EOL));
        return result.exitCode;
    }
    if (subcommand === 'window-open') {
        if (options.json) printJson(result.report);
        else process.stdout.write([
            `Native window open: ${result.report.status}`,
            `Mode: ${result.report.result?.mode || 'none'}`,
            `Backend: ${result.report.owner?.backendUrl || result.report.contractBefore?.backend?.url || 'unknown'}`,
            `PID: ${result.report.result?.pid || 'unknown'}`,
            `Report: ${result.report.reportPath}`,
            '',
        ].join(os.EOL));
        return result.exitCode;
    }
    if (subcommand === 'stop' || subcommand === 'stop-execute') {
        if (options.json) printJson(result.report);
        else process.stdout.write([
            `Native lifecycle stop: ${result.report.status}`,
            `Targets: ${result.report.contractBefore?.targets?.length || 0}`,
            `Report: ${result.report.reportPath}`,
            '',
        ].join(os.EOL));
        return result.exitCode;
    }
    if (subcommand === 'reconnect' || subcommand === 'reconnect-execute') {
        if (options.json) printJson(result.report);
        else process.stdout.write([
            `Native backend reconnect: ${result.report.status}`,
            `Backend: ${result.report.owner?.backendUrl || result.report.contractBefore?.backend?.url || 'unknown'}`,
            `PID: ${result.report.result?.pid || 'unknown'}`,
            `Report: ${result.report.reportPath}`,
            '',
        ].join(os.EOL));
        return result.exitCode;
    }
    if (subcommand === 'restart' || subcommand === 'restart-execute') {
        if (options.json) printJson(result.report);
        else process.stdout.write([
            `Native backend restart: ${result.report.status}`,
            `Mode: ${result.report.contractBefore?.recoveryMode || 'unknown'}`,
            `Result: ${result.report.result?.status || 'none'}`,
            `Report: ${result.report.reportPath}`,
            '',
        ].join(os.EOL));
        return result.exitCode;
    }
    if (options.json) printJson(result.report);
    else process.stdout.write([
        `Native lifecycle ${subcommand}: ${result.report?.status || 'completed'}`,
        `Report: ${result.report?.reportPath || 'unknown'}`,
        '',
    ].join(os.EOL));
    return result.exitCode || 0;
}

async function commandAutonomy(root, subcommand, options) {
    if (subcommand === 'tool-policy-gate' || subcommand === 'tool-policy') {
        const result = await commandOutsideToolPolicyGate(root, options);
        if (options.json) printJson(result.report);
        else process.stdout.write([
            `Outside tool policy gate: ${result.report.status}`,
            `Tool classes: ${result.report.contract?.toolClasses?.length || 0}`,
            `Tool count: ${result.report.contract?.packageTools?.count || 0}`,
            `Report: ${result.report.reportPath}`,
            '',
        ].join(os.EOL));
        return result.exitCode || 0;
    }
    if (subcommand !== 'dry-run' && subcommand !== 'dryrun') throw new Error('autonomy supports: dry-run, tool-policy-gate');
    const result = await commandAutonomyDryRun(root, options);
    if (options.json) printJson(result.report);
    else process.stdout.write([
        `Autonomy dry-run: ${result.report.status}`,
        `Turn: ${result.report.contract?.swarm?.turnId || 'unknown'}`,
        `Proposals: ${result.report.contract?.swarm?.proposalCount || 0}`,
        `Would run: ${(result.report.contract?.simulatedSteps || []).filter(step => step.status === 'would_run').length}`,
        `Blocked: ${(result.report.contract?.simulatedSteps || []).filter(step => step.status === 'blocked').length}`,
        `Report: ${result.report.reportPath}`,
        '',
    ].join(os.EOL));
    return result.exitCode || 0;
}

function installedExtensionCandidates(version) {
    const home = os.homedir();
    return [
        {
            editor: 'vscode',
            extensionPath: path.join(home, '.vscode', 'extensions', `harmony.harmony-extension-${version}`),
        },
        {
            editor: 'cursor',
            extensionPath: path.join(home, '.cursor', 'extensions', `harmony.harmony-extension-${version}`),
        },
    ];
}

async function commandDiagnose(root, options) {
    const state = await collectState(root, options);
    const pkg = await readPackage();
    const version = pkg.version || 'unknown';
    const installedExtensions = [];
    for (const candidate of installedExtensionCandidates(version)) {
        const hubPath = path.join(candidate.extensionPath, 'bin', process.platform === 'win32' ? 'harmonyhub.exe' : 'harmonyhub');
        installedExtensions.push({
            editor: candidate.editor,
            extensionPath: candidate.extensionPath,
            exists: await pathExists(candidate.extensionPath),
            hubExists: await pathExists(hubPath),
            hubPath,
        });
    }
    const recommendations = [];
    if (!state.hub.online) recommendations.push('Start HarmonyHub before relying on Hub-owned supervisor, lock, or snapshot APIs.');
    if (!state.outsidePolicy) recommendations.push('Run `node bin/harmony-cli.js policy init` before enabling outside-VS actions.');
    if (!state.hubSupervisor.online) recommendations.push('Allow the workspace in HarmonyHub policy before expecting Hub supervisor snapshots.');
    recommendations.push(...state.health.blocks, ...state.health.warnings);
    if (!installedExtensions.every(item => item.exists && item.hubExists)) recommendations.push('Reinstall the latest VSIX if an editor install is missing the bundled Hub binary.');

    const payload = {
        version: 1,
        generatedAt: new Date().toISOString(),
        cliVersion: version,
        workspace: root,
        installedExtensions,
        state,
        recommendations,
    };
    const dir = harmonyPath(root, 'diagnostics');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `diagnostic-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    const report = { ...payload, reportPath: normalizePath(outPath), recommendationsCount: recommendations.length };
    const exitCode = recommendations.length ? 1 : 0;
    if (options.recordLedger) {
        await appendLedgerEntry(root, {
            kind: 'diagnostics.report',
            label: recommendations.length ? `Diagnostics completed with ${recommendations.length} recommendations` : 'Diagnostics completed cleanly',
            status: recommendations.length ? 'warning' : 'completed',
            reportPath: normalizePath(outPath),
            recommendations: recommendations.length,
        });
    }
    if (options.returnReport) return { exitCode, report };
    if (options.json) printJson({ writtenPath: outPath, payload });
    else {
        const cross = state.crossSurface || {};
        const editorLines = (cross.installedEditors || []).map(item => `${item.editor}=${item.version || 'missing'}${item.matchesExpected ? '' : ' (mismatch)'}`).join(', ');
        process.stdout.write([
            `Harmony diagnostic written: ${normalizePath(outPath)}`,
            `Hub: ${state.hub.online ? 'online' : 'offline'}`,
            `Hub supervisor: ${state.hubSupervisor.online ? 'online' : 'offline'}`,
            `Installed editors: ${editorLines || installedExtensions.map(item => `${item.editor}=${item.exists ? 'yes' : 'no'}`).join(', ')}`,
            `Bundled Hub: ${cross.bundledHub?.version || (cross.bundledHub?.exists ? 'present' : 'missing')}`,
            `Native backend: ${cross.nativeBackend?.online === undefined ? cross.nativeBackend?.source || 'not checked' : cross.nativeBackend?.online ? 'online' : 'offline'} (${cross.nativeBackend?.url || 'unknown'})`,
            `Broker: ${cross.broker?.pending ?? 0} pending, ${cross.broker?.responses ?? 0} response, ${cross.broker?.processed ?? 0} processed`,
            `Secret store: ${cross.secretStore?.storedProviders ?? 0}/${cross.secretStore?.totalProviders ?? 0} providers stored`,
            `Safety switches: ${cross.safetySwitches?.failClosed ?? 0}/${cross.safetySwitches?.total ?? 0} fail closed`,
            recommendations.length ? `Recommendations: ${recommendations.length}` : 'Recommendations: none',
            '',
        ].join(os.EOL));
    }
    return exitCode;
}

function powershellQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function walkFilesRecursive(rootDir) {
    const files = [];
    async function visit(currentDir) {
        const entries = await fsp.readdir(currentDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const filePath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) await visit(filePath);
            else if (entry.isFile()) files.push(filePath);
        }
    }
    await visit(rootDir);
    return files;
}

function extractVsixArchive(vsixPath, extractDir) {
    const tarResult = childProcess.spawnSync('tar', ['-xf', vsixPath, '-C', extractDir], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (tarResult.status === 0 && !tarResult.error) return { tool: 'tar', exitCode: 0 };
    if (process.platform !== 'win32') {
        return { tool: 'tar', exitCode: tarResult.status === null ? 1 : tarResult.status, error: tarResult.error?.message || tarResult.stderr || 'tar extraction failed' };
    }
    const zipPath = path.join(path.dirname(extractDir), 'package.zip');
    fs.copyFileSync(vsixPath, zipPath);
    const command = `Expand-Archive -LiteralPath ${powershellQuote(zipPath)} -DestinationPath ${powershellQuote(extractDir)} -Force`;
    const psResult = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return {
        tool: 'powershell Expand-Archive',
        exitCode: psResult.status === null ? 1 : psResult.status,
        error: psResult.error?.message || psResult.stderr || undefined,
    };
}

function privacyScanTokenMatches(text) {
    const patterns = [
        ['openai_style_key', /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{18,}\b/g],
        ['anthropic_style_key', /\bsk-ant-[A-Za-z0-9_-]{18,}\b/g],
        ['google_ai_studio_key', /\bAIza[A-Za-z0-9_-]{20,}\b/g],
        ['github_token', /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g],
        ['jwt_like_token', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
    ];
    const matches = [];
    for (const [kind, regex] of patterns) {
        const found = text.match(regex) || [];
        if (found.length) matches.push({ kind, count: found.length });
    }
    return matches;
}

async function commandPrivacyScan(root, options) {
    const pkg = await readPackage();
    const version = pkg.version || 'unknown';
    const vsixPath = path.resolve(String(options.vsix || `harmony-extension-${version}.vsix`));
    if (!await pathExists(vsixPath)) throw new Error(`VSIX not found for privacy scan: ${vsixPath}`);
    const tempDir = path.join(os.tmpdir(), `harmony-privacy-scan-${Date.now()}-${process.pid}`);
    const extractDir = path.join(tempDir, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    const result = {
        version: 1,
        generatedAt: new Date().toISOString(),
        workspace: root,
        vsixPath: normalizePath(vsixPath),
        status: 'failed',
        extractedFileCount: 0,
        pathIssues: [],
        contentIssues: [],
        extraction: undefined,
    };
    try {
        result.extraction = extractVsixArchive(vsixPath, extractDir);
        if (result.extraction.exitCode !== 0) throw new Error(result.extraction.error || 'VSIX extraction failed');
        const files = await walkFilesRecursive(extractDir);
        result.extractedFileCount = files.length;
        const forbiddenPathFragments = [
            '/.harmony/',
            '/provider-broker/',
            '/terminal-ask/',
            '/smoke/phase3-smoke-',
            '/secrets/providers/',
            '/workspace' + 'Storage/',
            '/App' + 'Data/Roaming/Code/',
        ];
        const forbiddenPathNames = new Set(['.env', '.env.local', '.env.production']);
        for (const filePath of files) {
            const relative = normalizePath(path.relative(extractDir, filePath));
            const comparable = `/${relative}`;
            const baseName = path.basename(filePath);
            const fragment = forbiddenPathFragments.find(item => comparable.includes(item));
            if (fragment || forbiddenPathNames.has(baseName)) {
                result.pathIssues.push({ path: relative, reason: fragment ? `forbidden packaged path fragment ${fragment}` : `forbidden packaged file ${baseName}` });
            }
            const stat = await fsp.stat(filePath).catch(() => undefined);
            if (!stat || stat.size > 1024 * 1024) continue;
            const ext = path.extname(filePath).toLowerCase();
            if (!SNAPSHOT_TEXT_EXTS.has(ext) && !['.js', '.json', '.md', '.txt', '.html', '.css', '.toml', '.rs', '.xml'].includes(ext)) continue;
            const text = await fsp.readFile(filePath, 'utf8').catch(() => '');
            const matches = privacyScanTokenMatches(text);
            if (matches.length) result.contentIssues.push({ path: relative, matches });
        }
        result.status = result.pathIssues.length || result.contentIssues.length ? 'failed' : 'passed';
    } finally {
        if (!options.keep) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const dir = harmonyPath(root, 'privacy-scan');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `privacy-scan-${Date.now()}.json`);
    await fsp.writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'release.privacy_scan',
        label: `VSIX privacy scan ${result.status}`,
        status: result.status === 'passed' ? 'completed' : 'failed',
        vsixPath: normalizePath(vsixPath),
        reportPath: normalizePath(outPath),
        pathIssues: result.pathIssues.length,
        contentIssues: result.contentIssues.length,
    });
    const report = { ...result, reportPath: normalizePath(outPath) };
    const exitCode = result.status === 'passed' ? 0 : 2;
    if (options.returnReport) return { exitCode, report };
    if (options.json) printJson(report);
    else process.stdout.write([
        `Harmony VSIX privacy scan: ${result.status}`,
        `VSIX: ${normalizePath(vsixPath)}`,
        `Files scanned: ${result.extractedFileCount}`,
        `Path issues: ${result.pathIssues.length}`,
        `Content token issues: ${result.contentIssues.length}`,
        `Report: ${normalizePath(outPath)}`,
        '',
    ].join(os.EOL));
    return exitCode;
}

async function latestJsonFile(dir, prefix) {
    const names = (await readDirSafe(dir)).filter(name => name.endsWith('.json') && (!prefix || name.startsWith(prefix))).sort().reverse();
    for (const name of names) {
        const filePath = path.join(dir, name);
        const parsed = await readJson(filePath);
        if (parsed) return { path: filePath, json: parsed };
    }
    return undefined;
}

function nativeUiVisualSmokeBrowserAvailable() {
    const candidates = [];
    if (process.env.HARMONY_BROWSER_EXECUTABLE) candidates.push(process.env.HARMONY_BROWSER_EXECUTABLE);
    if (process.platform === 'win32') {
        const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
        for (const base of bases) {
            candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
            candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        }
        candidates.push('msedge', 'chrome');
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        candidates.push('microsoft-edge', 'google-chrome', 'chromium');
    } else {
        candidates.push('microsoft-edge', 'msedge', 'google-chrome', 'chromium-browser', 'chromium');
    }
    for (const candidate of Array.from(new Set(candidates))) {
        if (!candidate) continue;
        const looksLikePath = candidate.includes(path.sep) || candidate.includes('/');
        if (looksLikePath && fs.existsSync(candidate)) return true;
        if (!looksLikePath) {
            const result = childProcess.spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (result.status === 0) return true;
        }
    }
    return false;
}

async function commandReleaseReceipt(root, options) {
    const pkg = await readPackage();
    const version = String(options.version || pkg.version || 'unknown');
    const vsixPath = path.resolve(String(options.vsix || `harmony-extension-${version}.vsix`));
    const packageOnly = Boolean(options['package-only'] || options.packageOnly);
    const vsixExists = await pathExists(vsixPath);
    const vsixStat = vsixExists ? await fsp.stat(vsixPath).catch(() => undefined) : undefined;
    const vsixSha256 = vsixExists ? crypto.createHash('sha256').update(await fsp.readFile(vsixPath)).digest('hex') : undefined;
    const latestPrivacy = await latestJsonFile(harmonyPath(root, 'privacy-scan'), 'privacy-scan-');
    const latestInstallDryRun = await latestJsonFile(harmonyPath(root, 'release'), `install-dry-run-${version}-`);
    const smokeReports = await readSmokeReportSummaries(root, 20);
    const installed = await Promise.all([
        scanInstalledHarmonyExtension('vscode', version),
        scanInstalledHarmonyExtension('cursor', version),
    ]);
    const hasPhase3Smoke = smokeReports.some(report => String(report.id || '').startsWith('phase3-smoke') && report.status === 'passed');
    const hasVsCodeSwarmFixture = smokeReports.some(report => String(report.id || '').startsWith('vscode-swarm-commit-fixture') && report.status === 'passed');
    const hasVsCodeProviderKeyImportFixture = smokeReports.some(report => String(report.id || '').startsWith('vscode-provider-key-import-fixture') && report.status === 'passed');
    const hasNativeUiVisualSmoke = smokeReports.some(report => String(report.id || '').startsWith('native-ui-visual-smoke') && report.status === 'passed');
    const hasSidebarProviderSmoke = smokeReports.some(report => String(report.id || '').startsWith('sidebar-provider-smoke') && report.status === 'passed');
    const hasSourceWriteExecuteSmoke = smokeReports.some(report => String(report.id || '').startsWith('source-write-execute-smoke') && report.status === 'passed');
    const hasAuthorityBoundariesSmoke = smokeReports.some(report => String(report.id || '').startsWith('authority-boundaries-smoke') && report.status === 'passed');
    const hasAuthorityMatrixSmoke = smokeReports.some(report => String(report.id || '').startsWith('authority-matrix-smoke') && report.status === 'passed');
    const hasProviderLiveHarnessSmoke = smokeReports.some(report => String(report.id || '').startsWith('provider-live-harness') && report.status === 'passed');
    const canRunNativeUiVisualSmoke = hasNativeUiVisualSmoke || nativeUiVisualSmokeBrowserAvailable();
    const checks = [
        { name: 'vsix_exists', status: vsixExists ? 'passed' : 'failed', detail: normalizePath(vsixPath) },
        { name: 'vsix_sha256', status: vsixSha256 ? 'passed' : 'failed', detail: vsixSha256 },
        { name: 'privacy_scan_passed', status: latestPrivacy?.json?.status === 'passed' ? 'passed' : 'failed', detail: latestPrivacy ? normalizePath(latestPrivacy.path) : 'missing' },
        { name: 'install_dry_run_passed', status: latestInstallDryRun?.json?.status === 'passed' && latestInstallDryRun?.json?.installed === false && latestInstallDryRun?.json?.reloadedEditors === false ? 'passed' : 'failed', detail: latestInstallDryRun ? normalizePath(latestInstallDryRun.path) : 'missing install dry-run receipt; run npm run install:vsix:both:dry-run' },
        { name: 'phase3_smoke_passed', status: hasPhase3Smoke ? 'passed' : 'failed', detail: hasPhase3Smoke ? 'latest passed phase3 smoke found' : 'missing passed phase3 smoke' },
        { name: 'native_ui_visual_smoke_passed', status: hasNativeUiVisualSmoke ? 'passed' : (canRunNativeUiVisualSmoke ? 'failed' : 'skipped'), detail: hasNativeUiVisualSmoke ? 'latest passed native UI visual smoke found' : (canRunNativeUiVisualSmoke ? 'missing passed native UI visual smoke; run npm run smoke:native-ui-visual' : 'skipped: no headless Chromium-compatible browser found; set HARMONY_BROWSER_EXECUTABLE to enable') },
        { name: 'sidebar_provider_smoke_passed', status: hasSidebarProviderSmoke ? 'passed' : 'failed', detail: hasSidebarProviderSmoke ? 'latest passed sidebar provider smoke found' : 'missing passed sidebar provider smoke; run npm run smoke:sidebar-provider' },
        { name: 'source_write_execute_smoke_passed', status: hasSourceWriteExecuteSmoke ? 'passed' : 'failed', detail: hasSourceWriteExecuteSmoke ? 'latest passed source-write execute smoke suite found' : 'missing passed source-write execute smoke suite; run npm run smoke:source-write-execute' },
        { name: 'authority_boundaries_smoke_passed', status: hasAuthorityBoundariesSmoke ? 'passed' : 'failed', detail: hasAuthorityBoundariesSmoke ? 'latest passed authority boundaries smoke found' : 'missing passed authority boundaries smoke; run npm run smoke:authority-boundaries' },
        { name: 'authority_matrix_smoke_passed', status: hasAuthorityMatrixSmoke ? 'passed' : 'failed', detail: hasAuthorityMatrixSmoke ? 'latest passed authority matrix smoke found' : 'missing passed authority matrix smoke; run npm run smoke:authority-matrix' },
        { name: 'provider_live_harness_smoke_passed', status: hasProviderLiveHarnessSmoke ? 'passed' : 'failed', detail: hasProviderLiveHarnessSmoke ? 'latest passed provider live harness smoke found' : 'missing passed provider live harness smoke; run npm run smoke:provider-live-harness' },
        { name: 'vscode_swarm_fixture_passed', status: hasVsCodeSwarmFixture ? 'passed' : 'failed', detail: hasVsCodeSwarmFixture ? 'latest passed VS Code swarm fixture found' : 'missing passed VS Code swarm fixture' },
        { name: 'vscode_provider_key_import_fixture_passed', status: hasVsCodeProviderKeyImportFixture ? 'passed' : 'failed', detail: hasVsCodeProviderKeyImportFixture ? 'latest passed VS Code provider key import fixture found' : 'missing passed VS Code provider key import fixture; run npm run smoke:vscode-provider-key-import' },
        ...installed.map(item => ({
            name: `${item.editor}_installed_version`,
            status: packageOnly ? 'skipped' : item.matchesExpected ? 'passed' : 'failed',
            detail: packageOnly ? `${item.version || 'missing'} recorded for package-only checkpoint` : item.version || 'missing',
        })),
    ];
    const receiptStatus = checks.every(check => check.status === 'passed' || check.status === 'skipped') ? 'passed' : 'failed';
    const notes = String(options.notes || '').trim() ? [String(options.notes).trim()] : [];
    if (packageOnly) notes.push('Package-only checkpoint: installed editor versions are recorded but not required to match until the final install checkpoint.');
    const receipt = {
        version: 1,
        kind: 'release.receipt',
        generatedAt: new Date().toISOString(),
        workspace: root,
        mode: packageOnly ? 'package-only' : 'installed-release',
        package: { name: pkg.name || 'harmony-extension', version },
        vsix: {
            path: normalizePath(vsixPath),
            exists: vsixExists,
            size: vsixStat?.size,
            sha256: vsixSha256,
        },
        privacyScan: latestPrivacy ? {
            path: normalizePath(latestPrivacy.path),
            status: latestPrivacy.json.status,
            pathIssues: Array.isArray(latestPrivacy.json.pathIssues) ? latestPrivacy.json.pathIssues.length : undefined,
            contentIssues: Array.isArray(latestPrivacy.json.contentIssues) ? latestPrivacy.json.contentIssues.length : undefined,
        } : undefined,
        smokeReports,
        installedEditors: installed,
        checks,
        status: receiptStatus,
        notes,
    };
    const dir = harmonyPath(root, 'release');
    await fsp.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `release-receipt-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fsp.writeFile(outPath, JSON.stringify(receipt, null, 2), 'utf8');
    await fsp.writeFile(path.join(dir, 'latest-release-receipt.json'), JSON.stringify({ ...receipt, reportPath: normalizePath(outPath) }, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'release.receipt',
        label: `Release receipt ${version} ${receipt.status}`,
        status: receipt.status === 'passed' ? 'completed' : 'failed',
        version,
        reportPath: normalizePath(outPath),
        checks: checks.map(check => `${check.name}:${check.status}`),
    });
    const receiptWithPath = { ...receipt, reportPath: normalizePath(outPath) };
    if (options.returnReceipt) return { exitCode: receipt.status === 'passed' ? 0 : 2, receipt: receiptWithPath };
    if (options.json) printJson(receiptWithPath);
    else process.stdout.write([
        `Harmony release receipt: ${receipt.status}`,
        `Version: ${version}`,
        `VSIX: ${normalizePath(vsixPath)}`,
        `Checks: ${checks.filter(check => check.status === 'passed').length}/${checks.length} passed, ${checks.filter(check => check.status === 'skipped').length} skipped`,
        `Report: ${normalizePath(outPath)}`,
        '',
    ].join(os.EOL));
    return receipt.status === 'passed' ? 0 : 2;
}

const SNAPSHOT_EXCLUDED_PARTS = new Set([
    '.git', '.harmony', 'node_modules', 'out', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache',
]);
const SNAPSHOT_TEXT_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.ps1', '.css', '.html', '.rs', '.py', '.cs', '.go', '.java', '.xml',
]);

function shouldSkipSnapshotPath(relativePath) {
    const parts = normalizePath(relativePath).split('/').filter(Boolean).map(part => part.toLowerCase());
    return parts.some(part => SNAPSHOT_EXCLUDED_PARTS.has(part) || part.includes('secret') || part.includes('credential') || part.includes('key'));
}

function safeWorkspaceRestoreTarget(root, relativePath) {
    const normalized = normalizePath(relativePath || '').replace(/^\/+/, '');
    if (!normalized) return { ok: false, reason: 'empty path' };
    if (path.isAbsolute(relativePath || '')) return { ok: false, reason: 'absolute paths are not restorable' };
    if (normalized.split('/').includes('..')) return { ok: false, reason: 'parent directory traversal is not restorable' };
    if (shouldSkipSnapshotPath(normalized)) return { ok: false, reason: 'path is excluded from snapshot restore policy' };
    const targetPath = path.resolve(root, normalized);
    const relative = path.relative(root, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'target resolves outside workspace' };
    return { ok: true, relativePath: normalizePath(relative), targetPath };
}

function safeSnapshotSource(snapshotDir, copyPath) {
    const normalized = normalizePath(copyPath || '').replace(/^\/+/, '');
    if (!normalized) return { ok: false, reason: 'missing copied file path' };
    if (path.isAbsolute(copyPath || '')) return { ok: false, reason: 'absolute copied file path is not allowed' };
    if (normalized.split('/').includes('..')) return { ok: false, reason: 'copied file escapes snapshot directory' };
    const sourcePath = path.resolve(snapshotDir, normalized);
    const relative = path.relative(snapshotDir, sourcePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'source resolves outside snapshot directory' };
    return { ok: true, sourcePath };
}

async function resolveSnapshot(root, options) {
    const baseDir = snapshotsDir(root);
    let id = String(options.id || options.snapshot || options._[2] || '').trim();
    if (options.latest || id === 'latest') {
        const names = (await readDirSafe(baseDir)).filter(name => name.startsWith('snapshot-')).sort().reverse();
        id = names[0] || '';
    }
    if (!id) throw new Error('snapshot show/restore requires --id <snapshot-id> or --latest');
    if (id.includes('/') || id.includes('\\') || id.includes('..')) throw new Error('snapshot id must be a snapshot directory name, not a path');
    const snapshotDir = path.join(baseDir, id);
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    if (!manifest || !Array.isArray(manifest.files)) throw new Error(`snapshot manifest not found or invalid: ${normalizePath(manifestPath)}`);
    return { id, baseDir, snapshotDir, manifestPath, manifest };
}

async function listSnapshots(baseDir) {
    return (await readDirSafe(baseDir)).filter(name => name.startsWith('snapshot-')).sort().reverse();
}

async function buildRestorePlan(root, snapshot) {
    const plan = [];
    for (const file of snapshot.manifest.files) {
        const target = safeWorkspaceRestoreTarget(root, file.path);
        if (!target.ok) {
            plan.push({ path: normalizePath(file.path || '?'), action: 'skip', reason: target.reason });
            continue;
        }
        if (!file.copied || !file.copyPath) {
            plan.push({ path: target.relativePath, action: 'skip', reason: file.reason || 'file was metadata-only in this snapshot' });
            continue;
        }
        const source = safeSnapshotSource(snapshot.snapshotDir, file.copyPath);
        if (!source.ok) {
            plan.push({ path: target.relativePath, action: 'skip', reason: source.reason });
            continue;
        }
        if (!(await pathExists(source.sourcePath))) {
            plan.push({ path: target.relativePath, action: 'skip', reason: 'copied snapshot file is missing' });
            continue;
        }
        plan.push({
            path: target.relativePath,
            action: 'restore',
            sourcePath: source.sourcePath,
            targetPath: target.targetPath,
            targetExists: await pathExists(target.targetPath),
        });
    }
    return plan;
}

function printRestorePlan(snapshot, plan, applied, options) {
    const restorable = plan.filter(item => item.action === 'restore');
    const skipped = plan.filter(item => item.action !== 'restore');
    if (options.json) {
        printJson({ snapshotId: snapshot.id, manifestPath: snapshot.manifestPath, mode: applied ? 'applied' : 'preview', restorable: restorable.length, skipped: skipped.length, plan: plan.map(item => ({ ...item, sourcePath: item.sourcePath && normalizePath(item.sourcePath), targetPath: item.targetPath && normalizePath(item.targetPath) })) });
        return;
    }
    const limit = Number(options.limit || 50);
    const lines = [
        `Snapshot restore ${applied ? 'applied' : 'preview'}: ${snapshot.id}`,
        `Manifest: ${normalizePath(snapshot.manifestPath)}`,
        `Restorable copied text files: ${restorable.length}`,
        `Skipped files: ${skipped.length}`,
        '',
        ...restorable.slice(0, limit).map(item => `- ${applied ? 'restored' : 'would restore'} ${item.path}${item.targetExists ? '' : ' (target does not currently exist)'}`),
        ...(skipped.length ? ['', 'Skipped:', ...skipped.slice(0, limit).map(item => `- ${item.path}: ${item.reason}`)] : []),
        '',
    ];
    process.stdout.write(lines.join(os.EOL));
}

function filterRestorePlan(plan, options) {
    const requestedPath = options.path ? normalizePath(String(options.path)).replace(/^\/+/, '') : '';
    if (!requestedPath) return plan;
    return plan.filter(item => item.path === requestedPath);
}

function snapshotCopyName(relativePath) {
    const hash = crypto.createHash('sha1').update(normalizePath(relativePath)).digest('hex').slice(0, 12);
    return `${hash}-${path.basename(relativePath).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'file'}`;
}

async function addSnapshotFile(root, fullPath, relativePath, manifest, options) {
    let stat;
    try { stat = await fsp.stat(fullPath); }
    catch { return; }
    if (!stat.isFile()) return;
    const ext = path.extname(fullPath).toLowerCase();
    const record = {
        path: normalizePath(relativePath),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        copied: false,
        copyPath: undefined,
        reason: undefined,
    };
    if (!options.metadataOnly && stat.size <= options.maxBytes && SNAPSHOT_TEXT_EXTS.has(ext)) {
        const copyName = snapshotCopyName(relativePath);
        const copyPath = path.join(options.filesDir, copyName);
        await fsp.copyFile(fullPath, copyPath).catch(error => { record.reason = error.message || String(error); });
        if (!record.reason) {
            record.copied = true;
            record.copyPath = normalizePath(path.relative(options.snapshotDir, copyPath));
        }
    } else {
        record.reason = options.metadataOnly ? 'metadata-only' : 'not small text file';
    }
    manifest.files.push(record);
}

async function walkSnapshot(root, currentDir, manifest, options) {
    if (manifest.files.length >= options.maxFiles) return;
    let entries = [];
    try { entries = await fsp.readdir(currentDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
        if (manifest.files.length >= options.maxFiles) return;
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(root, fullPath);
        if (!relativePath || shouldSkipSnapshotPath(relativePath)) continue;
        if (entry.isDirectory()) {
            await walkSnapshot(root, fullPath, manifest, options);
            continue;
        }
        await addSnapshotFile(root, fullPath, relativePath, manifest, options);
    }
}

async function createSnapshot(root, options) {
    const baseDir = snapshotsDir(root);
    const id = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const snapshotDir = path.join(baseDir, id);
    const filesDir = path.join(snapshotDir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });
    const manifest = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace: root,
        mode: options['metadata-only'] ? 'metadata-only' : 'small-text-copy',
        note: String(options.note || 'Wave 12 rollback groundwork: manifest plus optional small text-file copies. Restore supports preview/apply for copied text files only.'),
        limits: {
            maxFiles: Number(options['max-files'] || 200),
            maxBytes: Number(options['max-bytes'] || 256 * 1024),
        },
        excludes: Array.from(SNAPSHOT_EXCLUDED_PARTS),
        files: [],
    };
    const walkOptions = {
        snapshotDir,
        filesDir,
        maxFiles: manifest.limits.maxFiles,
        maxBytes: manifest.limits.maxBytes,
        metadataOnly: Boolean(options['metadata-only']),
    };
    if (options.path) {
        const target = safeWorkspaceRestoreTarget(root, String(options.path));
        if (!target.ok) throw new Error(`snapshot create --path is not allowed: ${target.reason}`);
        const stat = await fsp.stat(target.targetPath).catch(() => undefined);
        if (!stat) throw new Error(`snapshot create --path not found: ${target.relativePath}`);
        if (stat.isDirectory()) await walkSnapshot(root, target.targetPath, manifest, walkOptions);
        else await addSnapshotFile(root, target.targetPath, target.relativePath, manifest, walkOptions);
    } else {
        await walkSnapshot(root, root, manifest, walkOptions);
    }
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await appendLedgerEntry(root, {
        kind: 'snapshot.create',
        label: `Snapshot created: ${id}`,
        status: 'completed',
        snapshotId: id,
        fileCount: manifest.files.length,
        copied: manifest.files.filter(file => file.copied).length,
        manifestPath: normalizePath(manifestPath),
        reason: options.reason ? String(options.reason) : undefined,
    });
    return { id, snapshotDir, manifestPath, fileCount: manifest.files.length, copied: manifest.files.filter(file => file.copied).length };
}

async function commandSnapshot(root, subcommand, options) {
    const baseDir = snapshotsDir(root);
    if (subcommand === 'list') {
        const names = await listSnapshots(baseDir);
        if (options.json) printJson({ path: baseDir, snapshots: names });
        else process.stdout.write((names.length ? names.map(name => `- ${name}`).join(os.EOL) : 'No snapshots found.') + os.EOL);
        return 0;
    }
    if (subcommand === 'show') {
        const snapshot = await resolveSnapshot(root, options);
        const copied = snapshot.manifest.files.filter(file => file.copied).length;
        if (options.json) printJson({ id: snapshot.id, manifestPath: snapshot.manifestPath, manifest: snapshot.manifest });
        else process.stdout.write([
            `Snapshot: ${snapshot.id}`,
            `Created: ${snapshot.manifest.createdAt || '?'}`,
            `Mode: ${snapshot.manifest.mode || '?'}`,
            `Files: ${snapshot.manifest.files.length} (${copied} copied)`,
            `Manifest: ${normalizePath(snapshot.manifestPath)}`,
            '',
        ].join(os.EOL));
        return 0;
    }
    if (subcommand === 'restore') {
        const snapshot = await resolveSnapshot(root, options);
        const plan = filterRestorePlan(await buildRestorePlan(root, snapshot), options);
        const apply = options.confirm === true && options.preview !== true;
        if (apply && !options.path && options.all !== true) {
            throw new Error('snapshot restore --confirm requires --path <workspace-relative-file> or --all for an intentional broad restore');
        }
        if (apply) {
            for (const item of plan.filter(entry => entry.action === 'restore')) {
                await fsp.mkdir(path.dirname(item.targetPath), { recursive: true });
                await fsp.copyFile(item.sourcePath, item.targetPath);
            }
            await appendLedgerEntry(root, {
                kind: 'snapshot.restore',
                label: `Snapshot restore applied: ${snapshot.id}`,
                status: 'completed',
                snapshotId: snapshot.id,
                restored: plan.filter(entry => entry.action === 'restore').length,
                skipped: plan.filter(entry => entry.action !== 'restore').length,
                scope: options.path ? 'path' : 'all',
                path: options.path ? normalizePath(options.path) : undefined,
                manifestPath: normalizePath(snapshot.manifestPath),
            });
        }
        printRestorePlan(snapshot, plan, apply, options);
        if (!apply && !options.json) process.stdout.write(`Apply one file with: node bin/harmony-cli.js snapshot restore --id ${snapshot.id} --path <workspace-relative-file> --confirm${os.EOL}`);
        return 0;
    }
    if (subcommand === 'prune') {
        const retain = Number(options.retain || 20);
        if (!Number.isFinite(retain) || retain < 1) throw new Error('snapshot prune requires --retain <positive-number>');
        const names = await listSnapshots(baseDir);
        const keep = names.slice(0, retain);
        const remove = names.slice(retain);
        const apply = options.confirm === true && options.preview !== true;
        if (apply) {
            for (const name of remove) {
                await fsp.rm(path.join(baseDir, name), { recursive: true, force: true });
            }
            await appendLedgerEntry(root, {
                kind: 'snapshot.prune',
                label: `Snapshot retention prune: kept ${keep.length}, removed ${remove.length}`,
                status: 'completed',
                retained: keep.length,
                removed: remove.length,
                removedSnapshots: remove,
            });
        }
        if (options.json) printJson({ path: baseDir, mode: apply ? 'applied' : 'preview', retain, kept: keep, remove });
        else process.stdout.write([
            `Snapshot prune ${apply ? 'applied' : 'preview'}: retain ${retain}`,
            `Kept: ${keep.length}`,
            `Would remove: ${apply ? 0 : remove.length}`,
            ...(remove.length ? ['', ...remove.map(name => `- ${apply ? 'removed' : 'would remove'} ${name}`)] : []),
            '',
        ].join(os.EOL));
        if (!apply && !options.json) process.stdout.write(`Apply with: node bin/harmony-cli.js snapshot prune --retain ${retain} --confirm${os.EOL}`);
        return 0;
    }
    if (subcommand === 'drill') {
        const drillId = `snapshot-drill-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
        const requestedPath = options.path ? normalizePath(String(options.path)).replace(/^\/+/, '') : `${drillId}.txt`;
        const target = safeWorkspaceRestoreTarget(root, requestedPath);
        if (!target.ok) throw new Error(`snapshot drill path is not allowed: ${target.reason}`);
        if (!options.confirm) {
            const preview = {
                version: 1,
                mode: 'preview',
                workspace: root,
                path: target.relativePath,
                willWriteDisposableFile: true,
                willCreateSnapshot: true,
                willModifyDisposableFile: true,
                willRestoreFromSnapshot: true,
                willRemoveDisposableFileAfterSuccess: options.keep !== true,
                runCommand: `node bin/harmony-cli.js snapshot drill --path ${target.relativePath} --confirm`,
            };
            if (options.json) printJson(preview);
            else process.stdout.write([
                'Snapshot restore drill preview',
                `Path: ${target.relativePath}`,
                'No files were written. Re-run with --confirm to create, snapshot, modify, restore, verify, and clean up the disposable file.',
                `Command: ${preview.runCommand}`,
                '',
            ].join(os.EOL));
            return 0;
        }
        if (await pathExists(target.targetPath)) throw new Error(`snapshot drill refuses to overwrite existing path: ${target.relativePath}`);
        const originalText = `Harmony snapshot drill original\n${drillId}\n`;
        const modifiedText = `Harmony snapshot drill modified\n${drillId}\n`;
        let snapshot;
        const result = {
            version: 1,
            mode: 'applied',
            workspace: root,
            path: target.relativePath,
            drillId,
            status: 'failed',
            snapshotId: undefined,
            manifestPath: undefined,
            restored: false,
            cleanedUp: false,
            error: undefined,
        };
        try {
            await fsp.writeFile(target.targetPath, originalText, 'utf8');
            snapshot = await createSnapshot(root, {
                ...options,
                path: target.relativePath,
                reason: 'snapshot restore drill',
                note: 'Disposable snapshot restore drill for Phase 1 recovery automation.',
                'max-files': 5,
                'max-bytes': 64 * 1024,
            });
            result.snapshotId = snapshot.id;
            result.manifestPath = normalizePath(snapshot.manifestPath);
            await fsp.writeFile(target.targetPath, modifiedText, 'utf8');
            const resolved = await resolveSnapshot(root, { id: snapshot.id });
            const plan = filterRestorePlan(await buildRestorePlan(root, resolved), { path: target.relativePath });
            const restoreItem = plan.find(item => item.action === 'restore');
            if (!restoreItem) throw new Error('snapshot drill could not find a restorable copied text file in the snapshot');
            await fsp.copyFile(restoreItem.sourcePath, restoreItem.targetPath);
            const restoredText = await fsp.readFile(target.targetPath, 'utf8');
            if (restoredText !== originalText) throw new Error('snapshot drill restore verification failed: restored content did not match original content');
            result.restored = true;
            result.status = 'completed';
            if (options.keep !== true) {
                await fsp.rm(target.targetPath, { force: true });
                result.cleanedUp = true;
            }
        } catch (error) {
            result.error = error && error.message ? error.message : String(error);
            throw error;
        } finally {
            await appendLedgerEntry(root, {
                kind: 'snapshot.drill',
                label: `Snapshot restore drill: ${target.relativePath}`,
                status: result.status,
                snapshotId: result.snapshotId,
                manifestPath: result.manifestPath,
                path: target.relativePath,
                restored: result.restored,
                cleanedUp: result.cleanedUp,
                error: result.error,
            }).catch(() => undefined);
        }
        if (options.json) printJson(result);
        else if (options.returnResult) return { exitCode: result.status === 'completed' ? 0 : 2, result };
        else process.stdout.write([
            `Snapshot restore drill ${result.status}: ${target.relativePath}`,
            `Snapshot: ${result.snapshotId}`,
            `Manifest: ${result.manifestPath}`,
            `Restored: ${result.restored ? 'yes' : 'no'}`,
            `Cleaned up disposable file: ${result.cleanedUp ? 'yes' : 'no'}`,
            '',
        ].join(os.EOL));
        return result.status === 'completed' ? 0 : 2;
    }
    if (subcommand !== 'create') {
        throw new Error('snapshot supports: create, list, show, restore, prune, drill');
    }
    const result = await createSnapshot(root, options);
    if (options.json) printJson(result);
    else process.stdout.write(`Snapshot manifest written: ${normalizePath(result.manifestPath)} (${result.fileCount} files, ${result.copied} copied)${os.EOL}`);
    return 0;
}

function printHelp() {
    process.stdout.write(`Harmony terminal CLI

Usage:
  harmony <command> [options]
  node bin/harmony-cli.js <command> [options]

Commands:
  status              Show Hub, supervisor, locks, operations, and continuity summary.
  health              Check local CLI/daemon prerequisites.
  supervisor          Show shared supervisor heartbeats and lock files.
    hub-supervisor      Show HarmonyHub's policy-gated supervisor snapshot.
  locks               List active lock records.
    hub-locks           List HarmonyHub policy-gated lock records.
    hub-lock acquire    Acquire a HarmonyHub lock. Requires --resource.
    hub-lock release    Release a HarmonyHub lock. Requires --operation-id.
    hub-operations      List HarmonyHub operation ledger entries.
    hub-operation start Append a Hub operation start record.
    hub-operation finish Append a Hub operation completion record. Requires --operation-id.
    hub-operation fail  Append a Hub operation failure record. Requires --operation-id.
    hub-secrets         Show HarmonyHub provider secret metadata; never returns values.
    policy init         Create observe-only outside-VS policy under .harmony/policy.
    policy show         Show outside-VS policy.
    policy check        Check a permission. Requires --permission.
    policy set          Update policy with --confirm and explicit fields.
    ask                 Record a safe terminal ask receipt; no model execution yet.
    ask --execute       Run a policy-gated terminal model call via env credentials. Requires --confirm.
    ask --broker        Queue a provider call for VS Code SecretStorage broker processing. Requires --execute --confirm.
    broker status       Show queued/processed VS Code SecretStorage broker requests and no-VS behavior.
    secrets status      Show Windows DPAPI provider secret-store metadata without values.
    secrets set         Store a provider key with Windows DPAPI. Requires --provider and --confirm; use --from-env <ENV>, --from-file <PATH>, --from-dotenv <PATH> [--dotenv-key <ENV>], or type into terminal prompt.
    secrets test        Verify a stored provider key decrypts without printing it. Requires --provider.
    secrets delete      Delete a stored provider key ciphertext. Requires --provider and --confirm. Alias: secrets clear.
    smoke phase3        Run disposable smoke tests for recovery, broker, secret-store, patch-apply, manifest-scoped commit guards, swarm switch guards, autonomy dry-run, and native UI readiness.
    smoke source-write-execute
                        Run the dedicated source-write execute authority smoke suite.
    smoke provider-live-harness
                        Write a dry-run Alibaba/Moonshot live-smoke harness report without provider calls.
    smoke authority-matrix
                        Run focused terminal/provider/git report-only authority checks.
    run-fail-fix        Record a safe run/fail/fix receipt; command execution requires --execute --confirm --command. Add --propose for proposal-only guidance or --apply --patch-file for guarded patch-file apply.
        git-preview reset   Read-only preview of tracked/staged changes a reset could affect.
        git-preview clean   Read-only git clean dry-run preview. Use --all or --ignored to change dry-run scope.
        git-preview conflicts Read-only preview of unmerged/conflicted files.
  heartbeat           Write one terminal heartbeat under .harmony/supervisor.
    hub-heartbeat       Ask HarmonyHub to write a policy-gated supervisor heartbeat.
  daemon              Run a terminal heartbeat daemon until Ctrl+C.
    diagnose            Write a cross-perspective diagnostics report.
        privacy-scan        Scan the packaged VSIX for bundled private state, smoke artifacts, and likely plaintext API tokens.
        release-receipt     Write a private release receipt tying VSIX hash, privacy scan, smoke reports, and installed editor versions together. Use --package-only before final install.
    snapshot create     Create a conservative local rollback snapshot manifest. Add --path <file-or-folder> for a targeted snapshot.
    snapshot list       List local rollback snapshot manifests.
    snapshot show       Show one snapshot manifest. Requires --id <id> or --latest.
    snapshot restore    Preview/apply copied text-file restore. Requires --id <id> or --latest; apply requires --confirm plus --path <file> or --all.
    snapshot prune      Preview/apply snapshot retention cleanup. Default --retain 20; apply requires --confirm.
    snapshot drill      Disposable create/modify/restore verification for snapshot recovery. Apply requires --confirm.
    self-healing status Show source/package/install readiness without mutation.
    self-healing report Write a private self-healing readiness report.
    self-healing gate   Write the self-healing future-execution gate contract.
    self-healing package-preflight
                        Preview fixed package/scan checks; run them only with --confirm. Does not install or reload editors.
    continuity tail     Show recent .harmony/continuity entries.
    resume-brief create
                        Write a bounded cross-seat resume brief from continuity, handoffs, diagnostics, and optional tail-limited sources.
        seat-handoff create
                                                Write a compact cross-seat handoff bundle with self-update commands and rollback notes.
    operations list     Show recent operation-ledger entries.
        operations show     Show one operation by --id.
        operations start    Append a started operation receipt.
        operations finish   Append a completed operation receipt. Requires --operation-id.
        operations fail     Append a failed operation receipt. Requires --operation-id.
    providers status    Show CLI provider credential status without printing keys.
    providers live-harness
                        Write planned Alibaba/Moonshot live smoke metadata without provider calls or secret values.
    providers live-approval-plan
                        Alias for live-harness; records the later approval/budget checklist without provider calls.
  tools list          List Harmony LM tools from package.json.
    ui                  Write a local floating dashboard HTML snapshot.
        ui serve          Start a localhost live floating UI shell with read-only state plus controlled release/privacy/diagnostics actions.
        ui native         Start/reuse the localhost backend and open the native floating chat/control window.
    native-lifecycle restart-preflight  Write a locked restart/recovery preflight report without stopping, starting, or restarting processes.
    native-lifecycle restart-execute-gate  Write a report-only future restart execute gate without process mutation.
        native-lifecycle restart-execute  Restart through owned stop-execute plus fixed daemon-start when current receipts allow it.
    autonomy dry-run  Read swarm plan/proposal receipts and write a bounded autonomy dry-run report without providers, commands, file edits, or git mutations.

Options:
  --workspace <path>  Workspace root. Defaults to current directory.
  --hub-url <url>     HarmonyHub URL. Defaults to ${DEFAULT_HUB_URL}.
  --json              Print JSON where supported.
  --limit <n>         Limit recent rows.
  --label <text>      Heartbeat/daemon label.
  --interval <ms>     Daemon heartbeat interval. Default 30000.
  --open              Open dashboard after writing it.
    --port <n>          UI server port. Default 8788; use 0 for an ephemeral port.
    --refresh <ms>      UI live-state refresh interval. Default 2000.
    --dry-run           For ui native, print the launch plan without starting processes.

Safety:
    This CLI does not run git commit, reset, clean, push, or apply model text directly.
    run-fail-fix --apply only reads an explicit workspace patch file after policy, snapshot, lock attempt, and git apply --check.
    Most commands write only local coordination state and dashboard snapshots under .harmony.
    snapshot restore can restore copied text files to the workspace only with --confirm.
`);
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    const command = options._[0] || 'help';
    const subcommand = options._[1] || '';
    const root = workspaceRoot(options);
    if (command === 'help' || command === '--help' || command === '-h') {
        printHelp();
        return 0;
    }
    if (command === 'status') {
        const state = await collectState(root, options);
        if (options.json) printJson(state);
        else printStatus(state);
        return 0;
    }
    if (command === 'health') return await commandHealth(root, options);
    if (command === 'supervisor') {
        const state = await collectState(root, options);
        if (options.json) printJson(state.supervisor);
        else printSupervisor(state);
        return 0;
    }
    if (command === 'hub-supervisor') return await commandHubSupervisor(root, options);
    if (command === 'hub-locks') return await commandHubLocks(root, options);
    if (command === 'hub-lock') return await commandHubLock(root, subcommand, options);
    if (command === 'hub-operations') return await commandHubOperations(root, options);
    if (command === 'hub-operation') return await commandHubOperation(root, subcommand || 'list', options);
    if (command === 'hub-secrets') return await commandHubSecrets(root, options);
    if (command === 'policy') return await commandPolicy(root, subcommand || 'show', options);
    if (command === 'ask') return await commandAskDesign(root, options, 'ask');
    if (command === 'run-fail-fix') return await commandAskDesign(root, options, 'run-fail-fix');
    if (command === 'broker') return await commandBroker(root, subcommand || 'status', options);
    if (command === 'providers') return await commandProviders(root, subcommand || 'status', options);
    if (command === 'secrets') return await commandSecrets(root, subcommand || 'status', options);
    if (command === 'smoke') return await commandSmoke(root, subcommand || 'phase3', options);
    if (command === 'git-preview') return await commandGitPreview(root, subcommand || 'reset', options);
    if (command === 'diagnose') return await commandDiagnose(root, options);
    if (command === 'privacy-scan' || command === 'release-scan') return await commandPrivacyScan(root, options);
    if (command === 'release-receipt') return await commandReleaseReceipt(root, options);
    if (command === 'snapshot') return await commandSnapshot(root, subcommand || 'list', options);
    if (command === 'self-healing') return await commandSelfHealing(root, subcommand || 'status', options);
    if (command === 'operations') return await commandOperations(root, subcommand || 'list', options);
    if (command === 'native-lifecycle') return await commandNativeLifecycle(root, subcommand || 'daemon-start', options);
    if (command === 'autonomy') return await commandAutonomy(root, subcommand || 'dry-run', options);
    if (command === 'locks') {
        const locks = await readLocks(root);
        if (options.json) printJson(locks);
        else process.stdout.write((locks.length ? locks.map(item => `- ${item.file}: ${item.operation || item.resource || 'unknown'} expired=${item.expired === undefined ? '?' : item.expired ? 'yes' : 'no'}`).join(os.EOL) : 'No lock files.') + os.EOL);
        return 0;
    }
    if (command === 'heartbeat') {
        await commandHeartbeat(root, options);
        return 0;
    }
    if (command === 'hub-heartbeat') {
        await commandHubHeartbeat(root, options);
        return 0;
    }
    if (command === 'daemon') {
        await commandDaemon(root, options);
        return 0;
    }
    if (command === 'continuity' && (subcommand === 'tail' || !subcommand)) {
        await commandContinuity(root, options);
        return 0;
    }
    if (command === 'resume-brief') return await commandResumeBrief(root, subcommand || 'create', options);
    if (command === 'seat-handoff') return await commandSeatHandoff(root, subcommand || 'create', options);
    if (command === 'tools' && (subcommand === 'list' || !subcommand)) {
        await commandTools(options);
        return 0;
    }
    if (command === 'ui') {
        if (subcommand === 'native' || subcommand === 'launch') return await commandUiNative(root, options);
        if (subcommand === 'serve' || options.serve || options.live) return await commandUiServe(root, options);
        await commandUi(root, options);
        return 0;
    }
    process.stderr.write(`Unknown command: ${command}${subcommand ? ' ' + subcommand : ''}${os.EOL}${os.EOL}`);
    printHelp();
    return 2;
}

main().then(code => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
}).catch(error => {
    process.stderr.write(`Harmony CLI error: ${error && error.stack ? error.stack : String(error)}${os.EOL}`);
    process.exitCode = 1;
});