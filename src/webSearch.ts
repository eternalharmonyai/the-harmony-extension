/**
 * Web Search tool — the VS Code-facing wrapper for the host-agnostic search core.
 * Reads `harmony.*` config + SecretStorage, calls webSearchCore, and formats a
 * citation-candidate result shaped for verbatim-or-abstain.
 */
import * as vscode from 'vscode';
import { clipResult } from './toolResultCap';
import { runSearch, institutionalDomains, meterSnapshot, SearchHost, SearchOutcome, SearchInput } from './webSearchCore';
import { engineProvenance } from './provenance';

const MAX_DISPLAY_CITATIONS = 40;

function clip(text: string): string {
    return clipResult(text);
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function formatOutcome(out: SearchOutcome): string {
    const lines: string[] = [];
    lines.push(`# Web Search (${out.mode})`);
    lines.push('');
    lines.push(`- Query: ${out.query}`);
    lines.push(`- Generated: ${out.generated}`);
    lines.push(`- Engines used: ${out.enginesUsed.length ? out.enginesUsed.join(', ') : '(none)'}`);
    if (out.enginesSkipped.length) {
        lines.push(`- Engines skipped: ${out.enginesSkipped.map(s => `${s.engine} (${s.reason})`).join('; ')}`);
    }
    if (out.note) lines.push(`- ${out.note}`);
    if (out.primaryDomainsTried?.length) lines.push(`- Primary domains tried: ${out.primaryDomainsTried.join(', ')}`);

    if (out.mode === 'corroborate') {
        lines.push('');
        lines.push('## Triangulation — do NOT merge; the non-overlap is the finding');
        lines.push(`- consensus (>= 2 independent indexes): ${Object.keys(out.consensus ?? {}).length} url(s)`);
        for (const [u, engines] of Object.entries(out.consensus ?? {})) lines.push(`  - ${u} [${engines.join(', ')}]`);
        lines.push(`- divergent (unique to one index): ${Object.keys(out.divergent ?? {}).length ? '' : 'none'}`);
        for (const [engine, urls] of Object.entries(out.divergent ?? {})) {
            lines.push(`  - ${engine}: ${urls.length} unique`);
            for (const u of urls) lines.push(`    - ${u}`);
        }
        lines.push(`- absent (index returned nothing): ${out.absent?.length ? out.absent.join(', ') : 'none'}`);
        if (out.jurisdictions && Object.keys(out.jurisdictions).length) {
            lines.push('');
            lines.push('## Jurisdictions — cross-jurisdiction divergence is signal');
            for (const [jur, info] of Object.entries(out.jurisdictions)) {
                lines.push(`- ${jur} (${info.engines.join(', ')}): ${info.urls.length} url(s)`);
                for (const u of info.urls) lines.push(`    - ${u}`);
            }
            const jc = out.jurisdictionConsensus ?? {};
            if (Object.keys(jc).length) {
                lines.push(`- cross-jurisdiction consensus (>= 2 jurisdictions): ${Object.keys(jc).length} url(s)`);
                for (const [u, jurs] of Object.entries(jc)) lines.push(`  - ${u} [${jurs.join(', ')}]`);
            }
            const jd = out.jurisdictionDivergent ?? {};
            if (Object.keys(jd).length) {
                lines.push(`- jurisdiction-divergent (only one jurisdiction found it):`);
                for (const [jur, urls] of Object.entries(jd)) {
                    lines.push(`  - ${jur}: ${urls.length} unique`);
                    for (const u of urls) lines.push(`    - ${u}`);
                }
            }
        }
    }

    const citations = out.citations.slice(0, MAX_DISPLAY_CITATIONS);
    const truncated = out.citations.length - citations.length;

    lines.push('');
    lines.push('## Citations');
    lines.push('| # | tier | engine | jurisdiction | title | source |');
    lines.push('|---:|---|---|---|---|---|');
    citations.forEach((c, i) => {
        const title = (c.title ?? '').replace(/\|/g, '/').slice(0, 80);
        lines.push(`| ${i + 1} | ${c.evidence_tier} | ${c.engine} | ${c.jurisdiction} | ${title} | ${c.source.replace(/\|/g, '/')} |`);
    });
    if (truncated > 0) lines.push(`_(showing first ${MAX_DISPLAY_CITATIONS} of ${out.citations.length} citations)_`);

    lines.push('');
    lines.push('## Verbatim (evidence)');
    citations.forEach((c, i) => {
        lines.push(`### ${i + 1}. [${c.engine}] ${c.title ?? c.source}`);
        lines.push(`- source: ${c.source}`);
        lines.push(`- retrieved: ${c.retrieved}`);
        lines.push(`- evidence_tier: ${c.evidence_tier}${c.evidence_tier === 'snippet' ? ' (LEAD — fetch with harmony_fetch_url before citing)' : ' (operative text — citable)'}`);
        lines.push('');
        lines.push(`> ${c.verbatim.slice(0, 400) || '(no verbatim text)'}`);
        lines.push('');
    });

    lines.push('## How to cite this output');
    lines.push('- `evidence_tier: content` may be cited as an authority — verbatim + source + retrieved are present.');
    lines.push('- `evidence_tier: snippet` is a LEAD. Fetch the source with harmony_fetch_url and quote operative text before citing.');
    lines.push('- Cite the exact source that supports each claim. Divergence across indexes/jurisdictions is signal — do not average it away.');
    lines.push('- Primary-source domains available via `site: "<domain>"` (or `site: "primary"`):');
    for (const [domain, label] of Object.entries(institutionalDomains())) lines.push(`  - ${domain} (${label})`);

    if (out.enginesUsed.length) {
        lines.push('');
        lines.push('## Engine provenance (uniform label)');
        for (const engine of out.enginesUsed) {
            const p = engineProvenance(engine);
            lines.push(`- \`${engine}\`: ${p.index} — ${p.operator} (${p.jurisdiction}) — retrieval class: ${p.retrievalClass}`);
        }
    }

    const meter = meterSnapshot();
    if (Object.keys(meter).length) {
        lines.push('');
        lines.push(`- Session query meter: ${Object.entries(meter).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    return lines.join('\n');
}

interface WebSearchInput extends SearchInput {}

class WebSearchTool implements vscode.LanguageModelTool<WebSearchInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<WebSearchInput>) {
        const query = options.input.query?.trim();
        if (!query) return textResult('error: missing argument: query');

        const host: SearchHost = {
            getConfig: <T,>(key: string, dflt?: T) => vscode.workspace.getConfiguration('harmony').get<T>(key) ?? dflt,
            getSecret: (key) => Promise.resolve(this.secrets.get(key)),
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        };

        try {
            const outcome = await runSearch(host, options.input as SearchInput);
            return textResult(formatOutcome(outcome));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WebSearchInput>) {
        const mode = options.input.mode === 'corroborate' ? 'corroborating across indexes' : 'searching';
        return { invocationMessage: `Web ${mode}: ${options.input.query}` };
    }
}

export function registerWebSearchTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_web_search', new WebSearchTool(context.secrets)),
    );
}
