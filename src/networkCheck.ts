/**
 * Harmony Network Check — proves the network beneath Harmony's providers is
 * intact, and names the artifact when it is not.
 *
 * Detects local conditions that can silently stall provider API calls:
 * hosts-file/DNS redirects of API hostnames to this machine, and stale Windows
 * port-forward rules. Runs at startup (forwards + DNS only) and on demand
 * (full report with reachability). Silent when healthy.
 *
 * Three layers:
 *   1. Forwards  — does a Windows port-forward rule own a local port?
 *   2. DNS       — does a public API hostname resolve to this machine?
 *   3. Reach     — does each endpoint answer, and how fast?
 */
import * as vscode from 'vscode';
import * as dns from 'dns';
import { execFile } from 'child_process';
import { LanguageManager } from './languageManager';
import { providerEndpointInfo, type EndpointProviderId } from './providers';

const tr = (key: string) => LanguageManager.getInstance().getString(key);

/**
 * Last hijack reported to the user, so the popup fires on a change of condition
 * rather than on every activation. Cleared when the condition resolves, so a
 * recurrence is reported again instead of being silently suppressed forever.
 */
const HIJACK_SIGNATURE_KEY = 'harmony.networkCheck.lastHijackSignature';

/** Endpoints Copilot Chat itself depends on. A redirect here hangs the chat with no error. */
const COPILOT_HOSTS = [
    'api.githubcopilot.com',
    'api.individual.githubcopilot.com',
    'api.business.githubcopilot.com',
    'api.enterprise.githubcopilot.com',
];

/** Providers whose base URL is user-configurable, so a redirect is possible. */
const ENDPOINT_PROVIDERS: EndpointProviderId[] = [
    'deepseek', 'alibaba', 'moonshot', 'kimiCode', 'tencent',
    'zhipu', 'zhipu-coding', 'stepfun', 'doubao', 'byteplus',
];

/** Providers with fixed endpoints — still worth probing for reachability. */
const STATIC_ENDPOINTS: Array<{ label: string; url: string }> = [
    { label: 'gemini', url: 'https://generativelanguage.googleapis.com' },
    { label: 'openai', url: 'https://api.openai.com' },
    { label: 'claude', url: 'https://api.anthropic.com' },
];

interface Endpoint {
    label: string;
    host: string;
    url: string;
    /** True when the user deliberately pointed this provider at their own machine. */
    intentionalLocal: boolean;
}

export interface NetworkFinding {
    severity: 'hijack' | 'forward' | 'unreachable';
    detail: string;
}

/** Loopback / unspecified literals. A public API host resolving here is a redirect. */
function isLoopbackAddress(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::' || lower === '0.0.0.0') return true;
    return /^127\./.test(lower);
}

function isLocalHostname(host: string): boolean {
    const h = host.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

function hostOf(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
}

/**
 * Build the endpoint list: Copilot's own API, every configurable provider base
 * URL, and the fixed-endpoint providers. A provider the user has deliberately
 * pointed at localhost is marked intentional so it is never reported as a hijack.
 */
function collectEndpoints(skipped: string[] = []): Endpoint[] {
    const endpoints: Endpoint[] = COPILOT_HOSTS.map(host => ({
        label: 'copilot', host, url: `https://${host}`, intentionalLocal: false,
    }));

    for (const provider of ENDPOINT_PROVIDERS) {
        let url: string | undefined;
        try {
            url = providerEndpointInfo(provider).baseUrl;
        } catch (e: any) {
            skipped.push(`${provider}: ${e?.message ?? String(e)}`);
            continue;
        }
        if (!url) { skipped.push(`${provider}: no base URL resolved`); continue; }
        const host = hostOf(url);
        endpoints.push({ label: provider, host, url, intentionalLocal: isLocalHostname(host) });
    }

    const openrouter = vscode.workspace.getConfiguration('harmony').get<string>('openrouter.baseUrl');
    if (openrouter) {
        const host = hostOf(openrouter);
        endpoints.push({ label: 'openrouter', host, url: openrouter, intentionalLocal: isLocalHostname(host) });
    }

    for (const s of STATIC_ENDPOINTS) {
        endpoints.push({ label: s.label, host: hostOf(s.url), url: s.url, intentionalLocal: false });
    }

    // De-duplicate by host — several providers can share one endpoint.
    const seen = new Set<string>();
    return endpoints.filter(e => (seen.has(e.host) ? false : (seen.add(e.host), true)));
}

/**
 * Resolve a hostname to every address, so a partial redirect is still caught.
 * dns.lookup() uses the OS resolver, which is what honours the hosts file —
 * dns.resolve4() queries DNS directly and would miss the exact redirect this
 * check exists to find. It also has no timeout of its own, so bound it here:
 * an unbounded await at activation would be a silent stall of its own.
 */
async function resolveAll(host: string, timeoutMs = 5000): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lookup = dns.promises.lookup(host, { all: true, verbatim: true });
    lookup.catch(() => { /* raced out — absorb so it never surfaces unhandled */ });
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });
    try {
        const entries = await Promise.race([lookup, timeout]);
        return entries.map(e => e.address);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Read Windows port-forward rules. These persist across reboots and are served
 * by the IP Helper service, so a stale rule keeps owning a local port long after
 * whatever it forwarded to is gone — accepting connections, then resetting them.
 * Non-Windows returns an empty list.
 */
async function portProxyRules(): Promise<string[]> {
    if (process.platform !== 'win32') return [];
    // Absolute path, never bare 'netsh': a binary of that name earlier in PATH
    // would otherwise run with the extension host's privileges.
    const netsh = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\netsh.exe`;
    const stdout = await new Promise<string>((resolve) => {
        execFile(netsh, ['interface', 'portproxy', 'show', 'all'],
            { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
            (err, out) => resolve(err ? '' : out));
    });
    return stdout.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^\d+\.\d+\.\d+\.\d+\s+\d+\s+\d+\.\d+\.\d+\.\d+\s+\d+$/.test(line));
}

/** Probe reachability. Any HTTP answer means the path is clear; the status does not matter. */
async function probe(url: string): Promise<{ ok: boolean; detail: string; ms: number }> {
    const startedAt = Date.now();
    try {
        const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
        // Release the socket without buffering a body we never read. cancel()
        // returns a promise that can reject — absorb it, never let it escape.
        try { r.body?.cancel()?.catch(() => { /* already closed */ }); } catch { /* no body */ }
        return { ok: true, detail: `HTTP ${r.status}`, ms: Date.now() - startedAt };
    } catch (e: any) {
        const cause = e?.cause?.code ?? e?.cause?.message ?? '';
        return { ok: false, detail: `${e?.message ?? String(e)}${cause ? ` (${cause})` : ''}`, ms: Date.now() - startedAt };
    }
}

/**
 * Run the check. `dnsOnly` skips the HTTP probes for the cheap startup pass —
 * port-forward and DNS inspection are local and fast, and they are what catch
 * the silent-redirect class on their own.
 */
export async function runNetworkCheck(
    options: { dnsOnly?: boolean; channel?: vscode.OutputChannel } = {}
): Promise<NetworkFinding[]> {
    const { dnsOnly = false, channel } = options;
    const findings: NetworkFinding[] = [];
    const log = (line: string) => channel?.appendLine(line);

    log(`=== Harmony Network Check — ${new Date().toISOString()} ===`);

    // -- 1. Port forwards -------------------------------------------------
    log('\n[1] Port-forward rules');
    const rules = await portProxyRules();
    if (process.platform !== 'win32') {
        log('    (skipped — Windows only)');
    } else if (rules.length === 0) {
        log('    OK  none');
    } else {
        for (const rule of rules) {
            log(`    !!  ${rule}`);
            findings.push({ severity: 'forward', detail: rule });
        }
        log('    A stale rule accepts connections and resets them — an indefinite hang with no error.');
    }

    // -- 2. DNS -----------------------------------------------------------
    log('\n[2] DNS resolution');
    const skipped: string[] = [];
    const endpoints = collectEndpoints(skipped);
    for (const s of skipped) log(`    --  skipped ${s}`);
    // Resolved in parallel: seventeen serial lookups is a slow startup pass on a
    // cold resolver, and each is independently bounded anyway.
    const resolved = await Promise.all(endpoints.map(async ep => {
        try { return { ep, addresses: await resolveAll(ep.host), error: undefined as string | undefined }; }
        catch (e: any) { return { ep, addresses: [] as string[], error: e?.message ?? String(e) }; }
    }));
    for (const { ep, addresses, error } of resolved) {
        if (error) {
            log(`    ??  ${ep.host.padEnd(42)} lookup failed: ${error}`);
            continue;
        }
        const redirected = addresses.filter(isLoopbackAddress);
        if (redirected.length > 0 && !ep.intentionalLocal) {
            log(`    !!  ${ep.host.padEnd(42)} -> ${addresses.join(', ')}  [${ep.label}] HOSTS REDIRECT`);
            findings.push({ severity: 'hijack', detail: `${ep.host} -> ${redirected.join(', ')} (${ep.label})` });
        } else if (redirected.length > 0) {
            log(`    --  ${ep.host.padEnd(42)} -> ${addresses.join(', ')}  [${ep.label}] local by configuration`);
        } else {
            log(`    OK  ${ep.host.padEnd(42)} -> ${addresses.join(', ')}  [${ep.label}]`);
        }
    }
    if (findings.some(f => f.severity === 'hijack')) {
        log('    A public API hostname resolving to this machine is a hosts-file redirect.');
    }

    // -- 3. Reachability --------------------------------------------------
    if (dnsOnly) {
        log('\n[3] Reachability — skipped (startup pass)');
        return findings;
    }
    log('\n[3] Reachability');
    const results = await Promise.all(endpoints.map(async ep => ({ ep, r: await probe(ep.url) })));
    for (const { ep, r } of results) {
        const status = (r.ok ? r.detail : 'FAIL').padEnd(10);
        log(`    ${r.ok ? 'OK ' : '!! '} ${status} ${`${r.ms}ms`.padEnd(8)} ${ep.url}  [${ep.label}]`);
        if (!r.ok) findings.push({ severity: 'unreachable', detail: `${ep.url} — ${r.detail}` });
    }

    log(`\n=== ${findings.length === 0 ? 'All clear' : `${findings.length} problem(s) found`} ===`);
    if (findings.length > 0) {
        const fixCommands = buildFixCommands(findings);
        if (fixCommands) log(`\n${fixCommands}\n`);
    }
    return findings;
}

/**
 * Build the ready-to-run fix block for the current findings. The header is
 * localized; the commands themselves are language-neutral.
 */
export function buildFixCommands(findings: NetworkFinding[]): string | undefined {
    const forwards = findings.filter(f => f.severity === 'forward');
    const redirects = findings.filter(f => f.severity === 'hijack');
    if (forwards.length === 0 && redirects.length === 0) return undefined;

    const lines: string[] = [tr('notify.networkCheckFixHeader')];
    let index = 1;
    if (forwards.length > 0) {
        lines.push('');
        lines.push(`[${index}] Remove the port-forward rule (elevated terminal):`);
        for (const f of forwards) {
            const m = f.detail.match(/^(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)$/);
            if (m) lines.push(`    netsh interface portproxy delete v4tov4 listenaddress=${m[1]} listenport=${m[2]}`);
            else lines.push(`    netsh interface portproxy delete v4tov4 listenaddress=<addr> listenport=<port>   # rule: ${f.detail}`);
        }
        index++;
    }
    if (redirects.length > 0) {
        lines.push('');
        lines.push(`[${index}] Remove the hosts-file redirect (edit the file as administrator):`);
        lines.push('    C:\\Windows\\System32\\drivers\\etc\\hosts');
        lines.push('    remove or comment the lines mapping these hosts to 127.0.0.1:');
        for (const f of redirects) {
            const host = f.detail.split(' -> ')[0].trim();
            lines.push(`      - ${host}`);
        }
        lines.push('    then run:  ipconfig /flushdns');
    }
    return lines.join('\n');
}

/** Copy the fix block and confirm with the localized toast. */
async function copyFixCommands(text: string) {
    try {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage(tr('notify.networkCheckFixCommandsCopied'));
    } catch (e: any) {
        void vscode.window.showErrorMessage(tr('notify.networkCheckFailed').replace('{error}', e?.message ?? String(e)));
    }
}

export function registerNetworkCheck(context: vscode.ExtensionContext) {
    let channel: vscode.OutputChannel | undefined;
    const getChannel = () => {
        if (!channel) {
            channel = vscode.window.createOutputChannel('Harmony Network Check');
            context.subscriptions.push(channel);
        }
        return channel;
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.networkCheck', async () => {
            const ch = getChannel();
            ch.clear();
            ch.show(true);
            try {
                const findings = await runNetworkCheck({ channel: ch });
                if (findings.length === 0) {
                    vscode.window.showInformationMessage(tr('notify.networkCheckClear'));
                    return;
                }
                const show = tr('notify.networkCheckShowDetails');
                const copy = tr('notify.networkCheckCopyFixCommands');
                const fixCommands = buildFixCommands(findings);
                const buttons = fixCommands ? [show, copy] : [show];
                const choice = await vscode.window.showWarningMessage(
                    tr('notify.networkCheckProblems').replace('{count}', String(findings.length)),
                    ...buttons
                );
                if (choice === show) ch.show(true);
                if (choice === copy && fixCommands) await copyFixCommands(fixCommands);
            } catch (e: any) {
                const msg = e?.message ?? String(e);
                ch.appendLine(`\nNetwork check failed: ${msg}`);
                vscode.window.showErrorMessage(tr('notify.networkCheckFailed').replace('{error}', msg));
            }
        })
    );

    // Startup pass: port forwards + DNS only (local, fast, no HTTP).
    //
    // Surface policy — display on state, notify on transition:
    //   • A redirect is a standing, machine-global condition. It does not change
    //     between window opens, reloads or reinstalls, so a popup on every
    //     activation would repeat information the user already has. That is how
    //     a warning gets trained into background noise.
    //   • So the standing condition lives in the status bar, where it persists
    //     without interrupting, and the popup fires only when the condition
    //     CHANGES — first appearance, or a different host than last seen.
    //   • A port-forward rule alone never warrants either: WSL2 uses them
    //     routinely. Forwards appear in the full report, where context makes
    //     them meaningful.
    const enabled = vscode.workspace.getConfiguration('harmony').get<boolean>('networkCheckOnStartup') ?? true;
    if (!enabled) return;

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 92);
    statusBar.command = 'harmony.networkCheck';
    context.subscriptions.push(statusBar);

    void (async () => {
        try {
            const findings = await runNetworkCheck({ dnsOnly: true, channel: getChannel() });
            const hijacks = findings.filter(f => f.severity === 'hijack');

            if (hijacks.length === 0) {
                // Resolved (or never present). Clear the remembered signature so a
                // recurrence is reported as new rather than silently swallowed.
                statusBar.hide();
                await context.globalState.update(HIJACK_SIGNATURE_KEY, undefined);
                return;
            }

            statusBar.text = `$(globe) Harmony: network issue`;
            statusBar.tooltip = new vscode.MarkdownString(
                `**${tr('notify.networkCheckStatusTitle')}**\n\n`
                + hijacks.map(h => `- \`${h.detail}\``).join('\n')
                + `\n\n${tr('notify.networkCheckStatusBody')}`
            );
            statusBar.show();

            const signature = hijacks.map(h => h.detail).sort().join('|');
            if (context.globalState.get<string>(HIJACK_SIGNATURE_KEY) === signature) return;
            await context.globalState.update(HIJACK_SIGNATURE_KEY, signature);

            const show = tr('notify.networkCheckShowDetails');
            const copy = tr('notify.networkCheckCopyFixCommands');
            const fixCommands = buildFixCommands(findings);
            const buttons = fixCommands ? [show, copy] : [show];
            const choice = await vscode.window.showWarningMessage(
                tr('notify.networkCheckStartupWarning').replace('{detail}', hijacks[0].detail),
                ...buttons
            );
            if (choice === show) getChannel().show(true);
            if (choice === copy && fixCommands) await copyFixCommands(fixCommands);
        } catch { /* a diagnostic must never break activation */ }
    })();
}
