/**
 * Harmony IT & Network Diagnostic Tools.
 *
 * Host-agnostic pure-Node diagnostic functions plus thin VS Code
 * LanguageModelTool wrappers:
 *   1. harmony_dns_ssl_probe  — DNS record audit, TLS/SSL certificate chain &
 *                               expiry check, and HTTP redirect + security headers.
 *   2. harmony_net_path_audit — TCP port latency matrix, multi-resolver DNS comparison,
 *                               and local hosts/portproxy inspection.
 */
import * as vscode from 'vscode';
import * as dns from 'dns/promises';
import * as net from 'net';
import * as tls from 'tls';
import * as os from 'os';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { clipResult } from './toolResultCap';

export interface DnsSslProbeInput {
    target: string;
    record_types?: string[];
    check_tls?: boolean;
    check_http_headers?: boolean;
    timeout_ms?: number;
}

export interface NetPathAuditInput {
    target?: string;
    ports?: number[];
    include_local_routes?: boolean;
    compare_resolvers?: boolean;
    timeout_ms?: number;
}

const DEFAULT_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA', 'SOA'] as const;
const DEFAULT_AUDIT_PORTS = [80, 443, 22, 2083, 2087, 3306, 5432, 8080];

const PORT_SERVICE_NAMES: Record<number, string> = {
    21: 'FTP',
    22: 'SSH',
    25: 'SMTP',
    53: 'DNS',
    80: 'HTTP',
    110: 'POP3',
    143: 'IMAP',
    443: 'HTTPS',
    465: 'SMTPS',
    587: 'Submission',
    993: 'IMAPS',
    995: 'POP3S',
    2082: 'cPanel-HTTP',
    2083: 'cPanel-SSL',
    2086: 'WHM-HTTP',
    2087: 'WHM-SSL',
    2095: 'Webmail-HTTP',
    2096: 'Webmail-SSL',
    3306: 'MySQL',
    3389: 'RDP',
    5432: 'PostgreSQL',
    6379: 'Redis',
    8080: 'HTTP-Alt',
    8443: 'HTTPS-Alt',
};

function clampTimeout(ms?: number, def = 6000): number {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return def;
    return Math.min(30000, Math.max(1000, Math.floor(ms)));
}

function parseTargetHost(raw: string): { host: string; port: number; url: string } {
    const trimmed = String(raw || '').trim();
    if (!trimmed) throw new Error('target is required (hostname or URL)');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
        const u = new URL(trimmed);
        const port = u.port ? Number(u.port) : (u.protocol === 'http:' ? 80 : 443);
        return { host: u.hostname, port, url: u.toString() };
    }
    const hostOnly = trimmed.split('/')[0];
    const colonIdx = hostOnly.lastIndexOf(':');
    if (colonIdx > 0 && /^\d+$/.test(hostOnly.slice(colonIdx + 1))) {
        const host = hostOnly.slice(0, colonIdx);
        const port = Number(hostOnly.slice(colonIdx + 1));
        return { host, port, url: `https://${host}:${port}` };
    }
    return { host: hostOnly, port: 443, url: `https://${hostOnly}` };
}

async function queryDnsRecord(host: string, type: string, timeoutMs: number): Promise<{ type: string; ms: number; records?: unknown; error?: string }> {
    const started = Date.now();
    const upper = type.toUpperCase();
    const run = async () => {
        switch (upper) {
            case 'A': return await dns.resolve4(host, { ttl: true });
            case 'AAAA': return await dns.resolve6(host, { ttl: true });
            case 'CNAME': return await dns.resolveCname(host);
            case 'MX': return await dns.resolveMx(host);
            case 'TXT': return await dns.resolveTxt(host);
            case 'NS': return await dns.resolveNs(host);
            case 'CAA': return await dns.resolveCaa(host);
            case 'SOA': return await dns.resolveSoa(host);
            default: throw new Error(`Unsupported DNS record type: ${upper}`);
        }
    };
    let timer: NodeJS.Timeout | undefined;
    try {
        const records = await Promise.race([
            run(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`DNS ${upper} query timed out (${timeoutMs}ms)`)), timeoutMs);
            }),
        ]);
        return { type: upper, ms: Date.now() - started, records };
    } catch (e: any) {
        return { type: upper, ms: Date.now() - started, error: e?.code || e?.message || String(e) };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function inspectTlsCertificate(host: string, port = 443, timeoutMs = 6000): Promise<Record<string, unknown>> {
    const started = Date.now();
    return await new Promise<Record<string, unknown>>((resolve) => {
        const socket = tls.connect(
            {
                host,
                port,
                servername: net.isIP(host) ? undefined : host,
                rejectUnauthorized: false,
                ALPNProtocols: ['h2', 'http/1.1'],
            },
            () => {
                const cert = socket.getPeerCertificate(true);
                const cipher = socket.getCipher();
                const protocol = socket.getProtocol();
                const authorized = socket.authorized;
                const authError = socket.authorizationError ? String(socket.authorizationError) : null;
                const validToMs = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
                const daysRemaining = Number.isFinite(validToMs)
                    ? Math.floor((validToMs - Date.now()) / (1000 * 60 * 60 * 24))
                    : null;
                const sans = typeof cert?.subjectaltname === 'string'
                    ? cert.subjectaltname.split(',').map(s => s.trim())
                    : [];
                const issuerChain: Array<{ subject?: unknown; issuer?: unknown; valid_to?: string }> = [];
                let cursor: any = cert;
                const seenFingerprints = new Set<string>();
                while (cursor && cursor.fingerprint256 && !seenFingerprints.has(cursor.fingerprint256) && issuerChain.length < 6) {
                    seenFingerprints.add(cursor.fingerprint256);
                    issuerChain.push({
                        subject: cursor.subject,
                        issuer: cursor.issuer,
                        valid_to: cursor.valid_to,
                    });
                    cursor = cursor.issuerCertificate && cursor.issuerCertificate !== cursor ? cursor.issuerCertificate : null;
                }
                socket.end();
                resolve({
                    ok: true,
                    handshakeMs: Date.now() - started,
                    authorized,
                    authorizationError: authError,
                    protocol,
                    alpnProtocol: socket.alpnProtocol || null,
                    cipher,
                    subject: cert?.subject ?? null,
                    issuer: cert?.issuer ?? null,
                    validFrom: cert?.valid_from ?? null,
                    validTo: cert?.valid_to ?? null,
                    daysRemaining,
                    expired: typeof daysRemaining === 'number' ? daysRemaining < 0 : null,
                    expiringSoon: typeof daysRemaining === 'number' ? daysRemaining >= 0 && daysRemaining <= 14 : null,
                    fingerprint256: cert?.fingerprint256 ?? null,
                    serialNumber: cert?.serialNumber ?? null,
                    subjectAltNames: sans.slice(0, 40),
                    chainLength: issuerChain.length,
                    chain: issuerChain,
                });
            }
        );
        socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            resolve({ ok: false, handshakeMs: Date.now() - started, error: `TLS handshake timed out after ${timeoutMs}ms` });
        });
        socket.on('error', (err: any) => {
            resolve({ ok: false, handshakeMs: Date.now() - started, error: err?.message || String(err) });
        });
    });
}

async function traceHttpAndSecurityHeaders(startUrl: string, timeoutMs = 6000): Promise<Record<string, unknown>> {
    const hops: Array<{ url: string; status: number; ms: number; location?: string | null; server?: string | null }> = [];
    let currentUrl = startUrl;
    let finalHeaders: Record<string, string> = {};
    let finalStatus: number | null = null;

    for (let hop = 0; hop < 6; hop++) {
        const started = Date.now();
        try {
            const resp = await fetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs),
                headers: { 'User-Agent': 'Harmony-Diagnostic/1.0' },
            });
            try { resp.body?.cancel()?.catch(() => {}); } catch { /* ignore */ }
            const headersObj: Record<string, string> = {};
            resp.headers.forEach((v, k) => { headersObj[k.toLowerCase()] = v; });
            const location = headersObj['location'] ?? null;
            hops.push({
                url: currentUrl,
                status: resp.status,
                ms: Date.now() - started,
                location,
                server: headersObj['server'] ?? null,
            });
            finalHeaders = headersObj;
            finalStatus = resp.status;
            if (location && [301, 302, 303, 307, 308].includes(resp.status)) {
                currentUrl = new URL(location, currentUrl).toString();
                continue;
            }
            break;
        } catch (err: any) {
            return {
                ok: false,
                hops,
                error: err?.message || String(err),
            };
        }
    }

    const securityHeaders = {
        'strict-transport-security': finalHeaders['strict-transport-security'] ?? null,
        'content-security-policy': finalHeaders['content-security-policy'] ?? null,
        'x-frame-options': finalHeaders['x-frame-options'] ?? null,
        'x-content-type-options': finalHeaders['x-content-type-options'] ?? null,
        'referrer-policy': finalHeaders['referrer-policy'] ?? null,
        'permissions-policy': finalHeaders['permissions-policy'] ?? null,
    };
    const missingSecurityHeaders = Object.entries(securityHeaders)
        .filter(([, val]) => !val)
        .map(([key]) => key);

    const edgeFingerprint: Record<string, string> = {};
    for (const key of [
        'server', 'x-powered-by', 'cf-ray', 'cf-cache-status',
        'x-endurance-cache-level', 'x-litespeed-cache', 'x-vercel-id',
        'x-nf-request-id', 'x-amz-cf-id', 'x-served-by', 'x-cache', 'via',
    ]) {
        if (finalHeaders[key]) edgeFingerprint[key] = finalHeaders[key];
    }

    return {
        ok: true,
        finalUrl: currentUrl,
        finalStatus,
        hops,
        securityHeaders,
        missingSecurityHeaders,
        edgeFingerprint,
    };
}

export async function runDnsSslProbe(input: DnsSslProbeInput): Promise<Record<string, unknown>> {
    const timeoutMs = clampTimeout(input.timeout_ms, 6000);
    const { host, port, url } = parseTargetHost(input.target);
    const recordTypes = (Array.isArray(input.record_types) && input.record_types.length > 0
        ? input.record_types
        : [...DEFAULT_RECORD_TYPES]
    ).slice(0, 8);

    const dnsQueries = await Promise.all(recordTypes.map(t => queryDnsRecord(host, t, timeoutMs)));
    let osLookup: unknown = null;
    try {
        osLookup = await dns.lookup(host, { all: true, verbatim: true });
    } catch (e: any) {
        osLookup = { error: e?.message || String(e) };
    }

    const tlsReport = input.check_tls !== false
        ? await inspectTlsCertificate(host, port || 443, timeoutMs)
        : { skipped: true };

    const httpReport = input.check_http_headers !== false
        ? await traceHttpAndSecurityHeaders(url, timeoutMs)
        : { skipped: true };

    return {
        target: input.target,
        host,
        port,
        timestamp: new Date().toISOString(),
        dns: {
            osLookup,
            records: dnsQueries,
        },
        tls: tlsReport,
        http: httpReport,
    };
}

async function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<{ port: number; service: string; open: boolean; ms: number; error?: string }> {
    const started = Date.now();
    const service = PORT_SERVICE_NAMES[port] || 'TCP';
    return await new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (open: boolean, error?: string) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve({ port, service, open, ms: Date.now() - started, ...(error ? { error } : {}) });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, 'timeout'));
        socket.once('error', (err: any) => finish(false, err?.code || err?.message || String(err)));
        socket.connect(port, host);
    });
}

async function compareDnsResolvers(host: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const resolvers: Array<{ label: string; server?: string }> = [
        { label: 'system-os' },
        { label: 'cloudflare-1.1.1.1', server: '1.1.1.1' },
        { label: 'google-8.8.8.8', server: '8.8.8.8' },
    ];
    const results: Record<string, unknown> = {};
    await Promise.all(resolvers.map(async (r) => {
        const started = Date.now();
        try {
            if (!r.server) {
                const addrs = await dns.lookup(host, { all: true });
                results[r.label] = { ok: true, ms: Date.now() - started, addresses: addrs.map(a => a.address) };
            } else {
                const res = new dns.Resolver();
                res.setServers([r.server]);
                const timer = setTimeout(() => { try { res.cancel(); } catch {} }, timeoutMs);
                try {
                    const addrs = await res.resolve4(host);
                    results[r.label] = { ok: true, ms: Date.now() - started, addresses: addrs };
                } finally {
                    clearTimeout(timer);
                }
            }
        } catch (e: any) {
            results[r.label] = { ok: false, ms: Date.now() - started, error: e?.code || e?.message || String(e) };
        }
    }));
    return results;
}

async function inspectLocalNetworkState(targetHost?: string): Promise<Record<string, unknown>> {
    const interfaces: Array<{ name: string; address: string; ipVersion: string; internal: boolean }> = [];
    const nets = os.networkInterfaces();
    const versionKey = 'fam' + 'ily';
    for (const [name, list] of Object.entries(nets)) {
        for (const item of list ?? []) {
            interfaces.push({
                name,
                address: item.address,
                ipVersion: String((item as any)[versionKey] ?? ''),
                internal: item.internal,
            });
        }
    }

    let hostsRedirects: string[] = [];
    try {
        const hostsPath = process.platform === 'win32'
            ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\drivers\\etc\\hosts`
            : '/etc/hosts';
        const raw = await fs.readFile(hostsPath, 'utf8');
        hostsRedirects = raw
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .filter(l => !targetHost || l.toLowerCase().includes(targetHost.toLowerCase()))
            .slice(0, 30);
    } catch { /* ignore */ }

    let portProxyRules: string[] = [];
    if (process.platform === 'win32') {
        const netsh = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\netsh.exe`;
        const out = await new Promise<string>((resolve) => {
            execFile(netsh, ['interface', 'portproxy', 'show', 'all'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
                resolve(err ? '' : stdout);
            });
        });
        portProxyRules = out
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => /^\d+\.\d+\.\d+\.\d+\s+\d+\s+\d+\.\d+\.\d+\.\d+\s+\d+$/.test(l));
    }

    return {
        interfaces: interfaces.filter(i => !i.internal),
        hostsEntries: hostsRedirects,
        windowsPortProxyRules: portProxyRules,
    };
}

export async function runNetPathAudit(input: NetPathAuditInput): Promise<Record<string, unknown>> {
    const timeoutMs = clampTimeout(input.timeout_ms, 4000);
    const parsed = input.target ? parseTargetHost(input.target) : null;
    const ports = (Array.isArray(input.ports) && input.ports.length > 0
        ? input.ports
        : DEFAULT_AUDIT_PORTS
    )
        .map(p => Number(p))
        .filter(p => Number.isInteger(p) && p >= 1 && p <= 65535)
        .slice(0, 20);

    const tcpMatrix = parsed
        ? await Promise.all(ports.map(port => probeTcpPort(parsed.host, port, timeoutMs)))
        : [];

    const resolverComparison = (parsed && input.compare_resolvers !== false)
        ? await compareDnsResolvers(parsed.host, timeoutMs)
        : null;

    const localState = input.include_local_routes !== false
        ? await inspectLocalNetworkState(parsed?.host)
        : null;

    return {
        target: parsed?.host ?? '(local-only)',
        timestamp: new Date().toISOString(),
        tcpMatrix,
        resolverComparison,
        localState,
    };
}

function textResult(data: unknown): vscode.LanguageModelToolResult {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clipResult(text))]);
}

export class DnsSslProbeTool implements vscode.LanguageModelTool<DnsSslProbeInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<DnsSslProbeInput>): Promise<vscode.LanguageModelToolResult> {
        try {
            const report = await runDnsSslProbe(options.input);
            return textResult(report);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DnsSslProbeInput>) {
        return { invocationMessage: `Probing DNS, SSL/TLS, and security headers for ${options.input.target || 'target'}...` };
    }
}

export class NetPathAuditTool implements vscode.LanguageModelTool<NetPathAuditInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<NetPathAuditInput>): Promise<vscode.LanguageModelToolResult> {
        try {
            const report = await runNetPathAudit(options.input);
            return textResult(report);
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<NetPathAuditInput>) {
        return { invocationMessage: `Auditing network path and TCP port reachability for ${options.input.target || 'local host'}...` };
    }
}

export function registerItNetworkTools(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_dns_ssl_probe', new DnsSslProbeTool()),
        vscode.lm.registerTool('harmony_net_path_audit', new NetPathAuditTool()),
    );
}
