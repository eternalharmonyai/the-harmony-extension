/**
 * Provenance tools — VS Code-facing wrappers for scholarly discovery, source discovery,
 * access diagnostics, and endpoint configuration.
 *
 * Each wraps a host-agnostic module (no `vscode` imports) and formats its result as text.
 */
import * as vscode from 'vscode';
import { clipResult } from './toolResultCap';
import {
    searchScholarly, resolveAccess, formatWorks, type ScholarlyOptions,
} from './scholarlyDiscovery';
import { discoverSources, planHarvest, formatPreflight } from './sourceDiscovery';
import { diagnoseAccess, formatDiagnostic } from './accessDiagnostic';
import { parseEndpointConfig, formatProblems, toInstitutionalSources, isPrivateHost } from './endpointConfig';

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clipResult(text))]);
}

function hostOf(value: string): string {
    try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname; } catch { return value; }
}

// ─── Scholarly discovery ────────────────────────────────────────────────────

interface ScholarlyInput {
    query?: string;
    doi?: string;
    mailto?: string;
    maxResults?: number;
}

class ScholarlyDiscoveryTool implements vscode.LanguageModelTool<ScholarlyInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ScholarlyInput>) {
        const { query, doi, mailto, maxResults } = options.input;
        const opts: ScholarlyOptions = { mailto: mailto || undefined, maxResults };
        try {
            if (doi?.trim()) {
                const route = await resolveAccess(doi, opts);
                const L = [`# Open-access route — ${route.doi}`, '', `landing page: ${route.landingPage}`];
                if (route.openAccess) {
                    L.push(`open copy: ${route.openAccess.url}`);
                    L.push(`  host: ${route.openAccess.hostType ?? '?'} · version: ${route.openAccess.version ?? '?'} · license: ${route.openAccess.license ?? '?'}`);
                } else {
                    L.push(route.handoff ?? 'no open-access copy found');
                }
                return textResult(L.join('\n'));
            }
            if (!query?.trim()) return textResult('error: provide either a query or a doi');
            const result = await searchScholarly(query, opts);
            return textResult(formatWorks(result, maxResults ?? 8));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ScholarlyInput>) {
        return {
            invocationMessage: options.input.doi?.trim()
                ? `Resolving open access for ${options.input.doi}`
                : `Searching scholarly sources for "${options.input.query}"`,
        };
    }
}

// ─── Source discovery ───────────────────────────────────────────────────────

interface SourceDiscoveryInput {
    domain?: string;
    maxRecords?: number;
}

class SourceDiscoveryTool implements vscode.LanguageModelTool<SourceDiscoveryInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SourceDiscoveryInput>) {
        const domain = options.input.domain?.trim();
        if (!domain) return textResult('error: missing argument: domain');
        const host = hostOf(domain);
        if (isPrivateHost(host)) return textResult(`error: refusing private/local host "${host}"`);
        try {
            const pre = await discoverSources(domain);
            const plan = pre.recommendation === 'sanctioned'
                ? planHarvest(pre, options.input.maxRecords ?? 500)
                : undefined;
            return textResult(formatPreflight(pre, plan));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SourceDiscoveryInput>) {
        return { invocationMessage: `Probing ${options.input.domain} for harvestable endpoints` };
    }
}

// ─── Access diagnostic ──────────────────────────────────────────────────────

interface AccessDiagnosticInput {
    url?: string;
    useControlProbe?: boolean;
}

class AccessDiagnosticTool implements vscode.LanguageModelTool<AccessDiagnosticInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<AccessDiagnosticInput>) {
        const url = options.input.url?.trim();
        if (!url) return textResult('error: missing argument: url');
        const host = hostOf(url);
        if (isPrivateHost(host)) return textResult(`error: refusing private/local host "${host}"`);
        try {
            const diag = await diagnoseAccess(url, { useControlProbe: options.input.useControlProbe ?? true });
            const L = ['# Access diagnostic', '', formatDiagnostic(diag), '', 'evidence:'];
            for (const e of diag.evidence) L.push(`  - ${e}`);
            if (diag.httpStatus !== undefined) L.push(`http status: ${diag.httpStatus}`);
            if (diag.networkHealthy !== undefined) L.push(`network healthy: ${diag.networkHealthy}`);
            return textResult(L.join('\n'));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AccessDiagnosticInput>) {
        return { invocationMessage: `Diagnosing access to ${options.input.url}` };
    }
}

// ─── Endpoint configuration ─────────────────────────────────────────────────

interface EndpointConfigInput {
    config?: string;
}

class EndpointConfigTool implements vscode.LanguageModelTool<EndpointConfigInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<EndpointConfigInput>) {
        const config = options.input.config?.trim();
        if (!config) return textResult('error: missing argument: config');
        try {
            const parsed = parseEndpointConfig(config);
            const L = ['# Endpoint configuration', '', formatProblems(parsed.problems)];
            if (parsed.ok) {
                L.push('', `Validated: ${parsed.config.institutional.length} institutional source(s), ${parsed.config.engines.length} engine(s).`);
                const sources = toInstitutionalSources(parsed.config);
                if (sources.length) {
                    L.push('', 'Institutional sources:');
                    for (const s of sources) L.push(`  - ${s.domain} (${s.strategy})`);
                }
            }
            return textResult(L.join('\n'));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<EndpointConfigInput>) {
        return { invocationMessage: 'Validating endpoint configuration' };
    }
}

export function registerProvenanceTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_scholarly_discovery', new ScholarlyDiscoveryTool()),
        vscode.lm.registerTool('harmony_source_discovery', new SourceDiscoveryTool()),
        vscode.lm.registerTool('harmony_access_diagnostic', new AccessDiagnosticTool()),
        vscode.lm.registerTool('harmony_endpoint_config', new EndpointConfigTool()),
    );
}
