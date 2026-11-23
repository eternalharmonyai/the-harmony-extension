import * as vscode from 'vscode';
import { clipResult } from './toolResultCap';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { analyzeSecurityPlaneMerge } from './securityPlane';

const COST_LEDGER_PATH = '.harmony/cost-ledger.json';

function clip(text: string): string {
    return clipResult(text);
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveWorkspacePath(inputPath: string): string | undefined {
    const root = workspaceRoot();
    if (!root) return undefined;
    const resolved = path.resolve(root, inputPath || '.');
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return resolved;
}

function relPath(abs: string): string {
    const root = workspaceRoot();
    return root ? path.relative(root, abs).replace(/\\/g, '/') : abs;
}

function list(items: string[]): string {
    return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : '- (none)';
}

function section(title: string, body: string | string[]): string {
    return `## ${title}\n\n${Array.isArray(body) ? list(body) : body}`;
}

function words(text: string): string[] {
    return Array.from(new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
        .filter(w => !new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'our', 'are', 'was', 'were', 'will', 'have', 'has', 'not']).has(w))));
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

async function fetchText(url: string, maxChars = 30000): Promise<string> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`only http(s) URLs are allowed: ${url}`);
    const response = await fetch(parsed.toString(), { headers: { 'User-Agent': 'Harmony-Research-Tools/0.2.18' } });
    const raw = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${raw.slice(0, 500)}`);
    const contentType = response.headers.get('content-type') ?? '';
    const text = contentType.includes('html') ? stripHtml(raw) : raw;
    return text.length > maxChars ? text.slice(0, maxChars) + `\n...[source clipped at ${maxChars} chars]` : text;
}

async function readTextIfExists(absPath: string): Promise<string | undefined> {
    try { return await fs.readFile(absPath, 'utf8'); } catch { return undefined; }
}

async function readJsonIfExists<T>(rel: string, fallback: T): Promise<T> {
    const abs = resolveWorkspacePath(rel);
    if (!abs) return fallback;
    try { return JSON.parse(await fs.readFile(abs, 'utf8')) as T; } catch { return fallback; }
}

async function writeJson(rel: string, value: unknown): Promise<void> {
    const abs = resolveWorkspacePath(rel);
    if (!abs) throw new Error(`path is outside workspace: ${rel}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(value, null, 2), 'utf8');
}

async function execGit(args: string[], cwd?: string): Promise<string> {
    return await new Promise((resolve) => {
        cp.execFile('git', args, { cwd: cwd ?? workspaceRoot(), windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
            resolve((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '') + (err ? `\n[git error]\n${err.message}` : ''));
        });
    });
}

interface ClientBriefInput {
    client_request: string;
    project_type?: string;
    audience?: string;
    budget_range?: string;
    timeline?: string;
    values?: string;
}

class ClientBriefTool implements vscode.LanguageModelTool<ClientBriefInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ClientBriefInput>) {
        const input = options.input;
        const request = (input.client_request ?? '').trim();
        if (!request) return textResult('error: missing argument: client_request');
        const lower = request.toLowerCase();
        const likelyNeeds = [
            lower.includes('website') || lower.includes('site') ? 'Website build or refresh with clear conversion path' : undefined,
            lower.includes('brand') || lower.includes('logo') ? 'Brand identity and asset system' : undefined,
            lower.includes('shop') || lower.includes('ecommerce') ? 'Product/catalog and checkout workflow' : undefined,
            lower.includes('access') || lower.includes('neuro') ? 'Accessibility and neurodivergent-friendly UX review' : undefined,
            lower.includes('research') ? 'Research translation, evidence review, or publication support' : undefined,
            lower.includes('ai') ? 'AI-assisted workflow, automation, or agent integration' : undefined,
        ].filter(Boolean) as string[];

        const deliverables = [
            'Plain-language scope summary that both sides can approve before work starts',
            'One discovery pass: audience, content, constraints, success criteria, and ethical boundaries',
            'Milestone-based implementation plan with acceptance checks per milestone',
            'Handoff package: what changed, how to maintain it, and what remains intentionally out of scope',
        ];
        const questions = [
            'What outcome would make this project feel successful 30 days after launch?',
            'Who is the primary audience, and what should they be able to do in under one minute?',
            'Are there legal, privacy, accessibility, or public-interest commitments that must shape the work?',
            'What assets already exist, and which ones are approved for public use?',
            'What is the hard deadline, and what can move to phase 2 if needed?',
        ];

        const risks = [
            'Unclear content ownership can delay launch even when the code is ready.',
            'Animation, AI, or research features need explicit review checkpoints so polish does not become scope drift.',
            'If pricing is tight, protect the core user journey first and move decorative extras to a later phase.',
        ];

        const lines = [
            '# Client Brief',
            '',
            `Project type: ${input.project_type || 'not specified'}`,
            `Audience: ${input.audience || 'not specified'}`,
            `Budget: ${input.budget_range || 'not specified'}`,
            `Timeline: ${input.timeline || 'not specified'}`,
            `Values / constraints: ${input.values || 'not specified'}`,
            '',
            section('Likely Needs', likelyNeeds.length ? likelyNeeds : ['Discovery needed before scope is reliable.']),
            '',
            section('Recommended Deliverables', deliverables),
            '',
            section('Questions To Ask Before Pricing', questions),
            '',
            section('Risks To Name Kindly', risks),
            '',
            section('Fair Next Step', 'Run a paid discovery or mini-scope first if the request is broad. Output should be a one-page scope, a quote range, and the first milestone definition.')
        ];
        return textResult(lines.join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Preparing client brief' }; }
}

interface AccessibilityAuditInput {
    content?: string;
    url?: string;
    audience?: string;
    focus?: string;
}

class AccessibilityAuditTool implements vscode.LanguageModelTool<AccessibilityAuditInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<AccessibilityAuditInput>) {
        const input = options.input;
        let content = input.content?.trim() ?? '';
        if (!content && input.url) content = await fetchText(input.url, 40000);
        if (!content) return textResult('error: provide content or url');
        const lower = content.toLowerCase();
        const checks = [
            { name: 'Plain next action', ok: /contact|start|get|download|read|learn|book|buy|try/.test(lower), fix: 'Add one obvious next action near the top of each major page.' },
            { name: 'Privacy reassurance', ok: /privacy|no ads|no data|data collection|tracking/.test(lower), fix: 'State the privacy posture explicitly where trust matters.' },
            { name: 'Free or low-cost path', ok: /free|scholarship|sliding|low-cost|no ads/.test(lower), fix: 'If affordability is part of the mission, make the free path findable without hunting.' },
            { name: 'Cognitive-load support', ok: /summary|tl;dr|steps|start here|overview/.test(lower), fix: 'Add a short overview and step-by-step path for readers who need orientation.' },
            { name: 'Motion sensitivity', ok: /reduced motion|prefers-reduced-motion|motion/.test(lower), fix: 'Support reduced-motion preferences for animations and avoid essential information only in motion.' },
            { name: 'Community accountability', ok: /accountability|transparent|sources|references|audit/.test(lower), fix: 'Show sources, update dates, and who to contact about corrections.' },
        ];
        const pass = checks.filter(c => c.ok).map(c => c.name);
        const fail = checks.filter(c => !c.ok).map(c => `${c.name}: ${c.fix}`);
        const lines = [
            '# Neurodivergent-Friendly Accessibility Audit',
            '',
            `Audience: ${input.audience || 'general / not specified'}`,
            `Focus: ${input.focus || 'clarity, trust, cognition, affordability, and motion safety'}`,
            '',
            section('Signals Present', pass),
            '',
            section('Needs Attention', fail),
            '',
            section('Recommended Review Method', [
                'Read the page once as a first-time visitor and write down every moment of uncertainty.',
                'Test keyboard navigation and visible focus order.',
                'Test at 200% zoom and on a narrow mobile viewport.',
                'Ask one neurodivergent reviewer to narrate where their attention goes and where friction appears.',
            ])
        ];
        return textResult(lines.join('\n'));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AccessibilityAuditInput>) {
        return { invocationMessage: `Auditing accessibility${options.input.url ? ` for ${options.input.url}` : ''}` };
    }
}

interface BrandAssetPackInput {
    brand_name: string;
    description: string;
    audience?: string;
    colors?: string;
    style?: string;
    deliverables?: string[];
}

class BrandAssetPackTool implements vscode.LanguageModelTool<BrandAssetPackInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BrandAssetPackInput>) {
        const input = options.input;
        if (!input.brand_name || !input.description) return textResult('error: brand_name and description are required');
        const deliverables = input.deliverables?.length ? input.deliverables : ['logo mark', 'favicon', 'social preview', 'hero banner', 'button/icon set', 'brand texture'];
        const basePrompt = `${input.brand_name}: ${input.description}. Audience: ${input.audience || 'mission-aligned public audience'}. Colors: ${input.colors || 'derive an accessible balanced palette'}. Style: ${input.style || 'polished, ethical, memorable, not generic stock art'}.`;
        const prompts = deliverables.map(d => `${d}: ${basePrompt} Create a production-ready ${d} with clear composition, accessible contrast, and no text unless explicitly requested.`);
        const names = deliverables.map(d => `.harmony/assets/${input.brand_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${d.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
        return textResult([
            '# Brand Asset Pack',
            '',
            section('Recommended Assets', deliverables),
            '',
            section('Suggested Output Paths', names),
            '',
            '## Image Generation Prompts',
            '',
            prompts.map((p, i) => `${i + 1}. ${p}`).join('\n\n'),
            '',
            section('Quality Checks', [
                'Works on light and dark backgrounds.',
                'Still recognizable at favicon size.',
                'No illegible text baked into small images.',
                'No visual clichés that weaken the mission.',
                'Palette is not one-note; include neutral, accent, and action colors.',
            ])
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Creating brand asset prompt pack' }; }
}

interface CostItem {
    label?: string;
    quantity?: number;
    unit_cost?: number;
    hours?: number;
    hourly_rate?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    rate_prompt_per_million?: number;
    rate_completion_per_million?: number;
}

interface CostEstimatorInput {
    action?: 'estimate' | 'add' | 'summary';
    project?: string;
    items?: CostItem[];
    notes?: string;
}

interface CostLedgerEntry {
    ts: string;
    project: string;
    notes?: string;
    items: CostItem[];
    total: number;
}

function itemCost(item: CostItem): number {
    const quantity = Number(item.quantity ?? 1);
    const direct = quantity * Number(item.unit_cost ?? 0);
    const labor = Number(item.hours ?? 0) * Number(item.hourly_rate ?? 0);
    const prompt = Number(item.prompt_tokens ?? 0) / 1_000_000 * Number(item.rate_prompt_per_million ?? 0);
    const completion = Number(item.completion_tokens ?? 0) / 1_000_000 * Number(item.rate_completion_per_million ?? 0);
    return direct + labor + prompt + completion;
}

class CostEstimatorTool implements vscode.LanguageModelTool<CostEstimatorInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CostEstimatorInput>) {
        const action = options.input.action ?? 'estimate';
        const items = options.input.items ?? [];
        const total = items.reduce((sum, item) => sum + itemCost(item), 0);
        if (action === 'summary') {
            const ledger = await readJsonIfExists<CostLedgerEntry[]>(COST_LEDGER_PATH, []);
            const byProject = new Map<string, number>();
            for (const entry of ledger) byProject.set(entry.project, (byProject.get(entry.project) ?? 0) + entry.total);
            return textResult([
                '# Cost Ledger Summary',
                '',
                `Entries: ${ledger.length}`,
                '',
                '| Project | Total |',
                '|---|---:|',
                ...Array.from(byProject.entries()).map(([project, value]) => `| ${project} | $${value.toFixed(2)} |`)
            ].join('\n'));
        }
        if (action === 'add') {
            const project = options.input.project?.trim() || 'default';
            const ledger = await readJsonIfExists<CostLedgerEntry[]>(COST_LEDGER_PATH, []);
            ledger.push({ ts: new Date().toISOString(), project, notes: options.input.notes, items, total });
            await writeJson(COST_LEDGER_PATH, ledger);
        }
        const lines = [
            action === 'add' ? '# Cost Entry Added' : '# Cost Estimate',
            '',
            `Project: ${options.input.project || 'not specified'}`,
            `Total estimate: $${total.toFixed(2)}`,
            '',
            '| Item | Cost |',
            '|---|---:|',
            ...items.map((item, i) => `| ${item.label || `Item ${i + 1}`} | $${itemCost(item).toFixed(2)} |`),
            '',
            'Note: use explicit rates for exact accounting. Without rates, unknown provider costs remain $0 in this estimate.'
        ];
        return textResult(lines.join('\n'));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CostEstimatorInput>) {
        const base = { invocationMessage: `${options.input.action ?? 'estimate'} project cost` };
        if (options.input.action !== 'add') return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Add cost ledger entry?',
                message: new vscode.MarkdownString(`Harmony wants to append a cost entry to \`${COST_LEDGER_PATH}\`.`)
            }
        };
    }
}

interface DeployCheckInput { project_path?: string; url?: string; include_git_status?: boolean; }

class DeployCheckTool implements vscode.LanguageModelTool<DeployCheckInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<DeployCheckInput>) {
        const root = resolveWorkspacePath(options.input.project_path ?? '.');
        if (!root) return textResult('error: project path is outside workspace or no workspace is open');
        const packageJson = await readTextIfExists(path.join(root, 'package.json'));
        const pkg = packageJson ? JSON.parse(packageJson) : undefined;
        const files = await fs.readdir(root).catch((): string[] => []);
        const scripts = pkg?.scripts ?? {};
        const checks = [
            { name: 'Build script', ok: !!scripts.build, fix: 'Add or document a build command.' },
            { name: 'Start/dev script', ok: !!(scripts.dev || scripts.start), fix: 'Add or document how to run the app locally.' },
            { name: 'Environment example', ok: files.some(f => f.toLowerCase().startsWith('.env.example') || f.toLowerCase() === 'env.example'), fix: 'Add .env.example with names only, never secrets.' },
            { name: 'Public README', ok: files.some(f => /^readme\.md$/i.test(f)), fix: 'Add a short README with setup, build, deploy, and support notes.' },
            { name: 'License', ok: files.some(f => /^license/i.test(f)), fix: 'Add or confirm the intended license.' },
        ];
        let git = '';
        if (options.input.include_git_status ?? true) git = await execGit(['status', '--short'], root);
        const lines = [
            '# Deploy Check',
            '',
            `Project: ${relPath(root)}`,
            options.input.url ? `URL: ${options.input.url}` : '',
            '',
            '| Check | Status | Next Step |',
            '|---|---|---|',
            ...checks.map(c => `| ${c.name} | ${c.ok ? 'OK' : 'Needs work'} | ${c.ok ? '' : c.fix} |`),
            '',
            section('Suggested Preflight Order', [
                scripts.build ? `Run ${JSON.stringify('npm run build')} and fix build errors.` : 'Define the build command before deployment.',
                'Verify environment variables are present in the hosting platform.',
                'Run Lighthouse after deployment for performance and accessibility.',
                'Check contact forms, analytics/privacy posture, and 404 behavior.',
            ]),
            git.trim() ? `\n## Git Status\n\n\`\`\`text\n${git.trim()}\n\`\`\`` : ''
        ].filter(Boolean);
        return textResult(lines.join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Running deploy preflight check' }; }
}

interface EthicsLicenseInput { project_path?: string; public_project?: boolean; }

class EthicsLicenseCheckTool implements vscode.LanguageModelTool<EthicsLicenseInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<EthicsLicenseInput>) {
        const root = resolveWorkspacePath(options.input.project_path ?? '.');
        if (!root) return textResult('error: project path is outside workspace or no workspace is open');
        const files = await fs.readdir(root).catch((): string[] => []);
        const license = files.find(f => /^license/i.test(f));
        const readme = files.find(f => /^readme\.md$/i.test(f));
        const pkgText = await readTextIfExists(path.join(root, 'package.json'));
        const pkg = pkgText ? JSON.parse(pkgText) : undefined;
        const deps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
        const tracking = deps.filter(d => /analytics|segment|mixpanel|amplitude|hotjar|sentry|posthog|google-tag|gtag/i.test(d));
        const licenseText = license ? (await readTextIfExists(path.join(root, license)) ?? '') : '';
        const checks = [
            { name: 'License file present', ok: !!license, fix: 'Add the intended license file.' },
            { name: 'Hippocratic or ethical-source alignment visible', ok: /hippocratic|ethical source|human rights|do no harm/i.test(licenseText), fix: 'If this is public-interest open source, make ethical-use terms explicit.' },
            { name: 'README present', ok: !!readme, fix: 'Add README with purpose, setup, privacy, and contribution expectations.' },
            { name: 'Tracking dependencies disclosed', ok: tracking.length === 0, fix: `Review/disclose tracking or telemetry dependencies: ${tracking.join(', ')}` },
            { name: 'Public project clarity', ok: !options.input.public_project || !!license && !!readme, fix: 'Public projects need license + README before sharing.' },
        ];
        return textResult([
            '# Ethics / License Check',
            '',
            `Project: ${relPath(root)}`,
            '',
            '| Check | Status | Next Step |',
            '|---|---|---|',
            ...checks.map(c => `| ${c.name} | ${c.ok ? 'OK' : 'Needs work'} | ${c.ok ? '' : c.fix} |`),
            '',
            section('Recommended Public-Interest Additions', [
                'Plain-language purpose statement.',
                'Privacy statement: what is collected, what is not collected, and why.',
                'Accessibility commitment and contact path for barriers.',
                'Ethical-use boundary tied to the project license.',
                'Citation/reference page for factual claims.',
            ])
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Checking ethics/license posture' }; }
}

interface InvoiceProposalInput {
    client_name?: string;
    project_name: string;
    client_request: string;
    deliverables?: string[];
    timeline?: string;
    hourly_rate?: number;
    fixed_price?: number;
    nonprofit_discount_percent?: number;
}

class InvoiceProposalTool implements vscode.LanguageModelTool<InvoiceProposalInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<InvoiceProposalInput>) {
        const input = options.input;
        if (!input.project_name || !input.client_request) return textResult('error: project_name and client_request are required');
        const deliverables = input.deliverables?.length ? input.deliverables : ['Discovery and scope confirmation', 'Implementation', 'Review revisions', 'Launch handoff'];
        const base = Number(input.fixed_price ?? 0);
        const discount = Math.max(0, Math.min(100, Number(input.nonprofit_discount_percent ?? 0)));
        const final = base > 0 ? base * (1 - discount / 100) : 0;
        return textResult([
            '# Proposal / Invoice Draft',
            '',
            `Client: ${input.client_name || '(client name)'}`,
            `Project: ${input.project_name}`,
            `Timeline: ${input.timeline || 'to be confirmed'}`,
            '',
            section('Scope Summary', input.client_request.trim()),
            '',
            section('Deliverables', deliverables),
            '',
            section('Milestones', deliverables.map((d, i) => `${i + 1}. ${d} - acceptance check agreed before work begins`)),
            '',
            '| Pricing Item | Amount |',
            '|---|---:|',
            input.hourly_rate ? `| Hourly rate, if used | $${Number(input.hourly_rate).toFixed(2)} / hr |` : '| Hourly rate, if used | n/a |',
            base ? `| Fixed project price | $${base.toFixed(2)} |` : '| Fixed project price | to be confirmed |',
            discount ? `| Mission/nonprofit discount | -${discount}% |` : '| Mission/nonprofit discount | n/a |',
            final ? `| Estimated total | $${final.toFixed(2)} |` : '| Estimated total | to be confirmed |',
            '',
            section('Plain-Language Terms To Confirm', [
                'What counts as one revision round.',
                'What is out of scope for this phase.',
                'Payment timing and pause conditions.',
                'Who owns final assets and source files.',
                'Accessibility, privacy, and ethical-use expectations.',
            ])
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Drafting proposal/invoice' }; }
}

interface ResearchBriefInput {
    topic: string;
    thesis?: string;
    audience?: string;
    output_type?: string;
    source_urls?: string[];
}

class ResearchBriefTool implements vscode.LanguageModelTool<ResearchBriefInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ResearchBriefInput>) {
        const input = options.input;
        if (!input.topic) return textResult('error: missing argument: topic');
        const sources: string[] = [];
        for (const url of input.source_urls ?? []) {
            try { sources.push(`Source ${sources.length + 1}: ${url}\n${(await fetchText(url, 6000)).slice(0, 6000)}`); }
            catch (e: any) { sources.push(`Source ${sources.length + 1}: ${url}\n[fetch failed: ${e?.message ?? String(e)}]`); }
        }
        return textResult([
            '# Research Brief',
            '',
            `Topic: ${input.topic}`,
            `Audience: ${input.audience || 'public-interest / research audience'}`,
            `Output type: ${input.output_type || 'article, whitepaper, or literature-backed brief'}`,
            `Working thesis: ${input.thesis || 'to be refined after evidence review'}`,
            '',
            section('Core Research Questions', [
                `What is the strongest evidence for the main claim about ${input.topic}?`,
                'Which claims are empirical, which are ethical, and which are implementation proposals?',
                'What would a skeptical but fair reviewer challenge first?',
                'What communities are affected, and what safeguards would make the work accountable to them?',
            ]),
            '',
            section('Evidence Buckets', [
                'Peer-reviewed or institutional research.',
                'Government, municipal, utility, or standards documents.',
                'First-person / qualitative reports, handled ethically and anonymized when needed.',
                'Technical feasibility evidence and implementation precedents.',
            ]),
            '',
            sources.length ? section('Fetched Source Notes', sources) : section('Next Source Step', 'Run harmony_literature_scan and harmony_evidence_matrix for the strongest claims.')
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Preparing research brief' }; }
}

interface LiteratureScanInput { query: string; max_results?: number; source?: 'semantic_scholar' | 'crossref' | 'both'; }

class LiteratureScanTool implements vscode.LanguageModelTool<LiteratureScanInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<LiteratureScanInput>) {
        const query = options.input.query?.trim();
        if (!query) return textResult('error: missing argument: query');
        const max = Math.max(1, Math.min(20, Number(options.input.max_results) || 8));
        const source = options.input.source ?? 'both';
        const rows: string[] = [];
        if (source === 'semantic_scholar' || source === 'both') {
            try {
                const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${max}&fields=title,authors,year,url,abstract,venue,citationCount,externalIds`;
                const json: any = await (await fetch(url)).json();
                for (const paper of json?.data ?? []) {
                    const authors = Array.isArray(paper.authors) ? paper.authors.slice(0, 3).map((a: any) => a.name).filter(Boolean).join(', ') : '';
                    const doi = paper.externalIds?.DOI ? ` DOI: ${paper.externalIds.DOI}` : '';
                    rows.push(`| Semantic Scholar | ${paper.year ?? '?'} | ${String(paper.title ?? '').replace(/\|/g, '/')} | ${authors} | ${paper.citationCount ?? 0} | ${paper.url ?? ''}${doi} |`);
                }
            } catch (e: any) {
                rows.push(`| Semantic Scholar | error | ${String(e?.message ?? e).replace(/\|/g, '/')} |  |  |  |`);
            }
        }
        if (source === 'crossref' || source === 'both') {
            try {
                const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${max}`;
                const json: any = await (await fetch(url)).json();
                for (const item of json?.message?.items ?? []) {
                    const title = Array.isArray(item.title) ? item.title[0] : item.title;
                    const year = item.issued?.['date-parts']?.[0]?.[0] ?? '?';
                    const authors = Array.isArray(item.author) ? item.author.slice(0, 3).map((a: any) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).join(', ') : '';
                    rows.push(`| Crossref | ${year} | ${String(title ?? '').replace(/\|/g, '/')} | ${authors} | ${item['is-referenced-by-count'] ?? 0} | ${item.URL ?? ''} |`);
                }
            } catch (e: any) {
                rows.push(`| Crossref | error | ${String(e?.message ?? e).replace(/\|/g, '/')} |  |  |  |`);
            }
        }
        return textResult([
            `# Literature Scan: ${query}`,
            '',
            '| Source | Year | Title | Authors | Citations | Link |',
            '|---|---:|---|---|---:|---|',
            ...rows,
            '',
            'Review note: these are search results, not proof. Use them to choose sources, then read the original papers before citing.'
        ].join('\n'));
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<LiteratureScanInput>) {
        return { invocationMessage: `Scanning literature for ${options.input.query}` };
    }
}

interface EvidenceMatrixInput { claims?: string[]; source_urls?: string[]; notes?: string; }

class EvidenceMatrixTool implements vscode.LanguageModelTool<EvidenceMatrixInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<EvidenceMatrixInput>) {
        const claims = (options.input.claims ?? []).map(c => c.trim()).filter(Boolean);
        const sources: Array<{ url: string; text: string }> = [];
        for (const url of options.input.source_urls ?? []) {
            try { sources.push({ url, text: await fetchText(url, 20000) }); }
            catch (e: any) { sources.push({ url, text: `[fetch failed: ${e?.message ?? String(e)}]` }); }
        }
        if (claims.length === 0 && sources.length === 0 && !options.input.notes) return textResult('error: provide claims, source_urls, or notes');
        const rows = claims.map(claim => {
            const claimWords = words(claim);
            const hits = sources.map(source => {
                const sourceWords = new Set(words(source.text));
                const overlap = claimWords.filter(w => sourceWords.has(w));
                return { url: source.url, overlap };
            }).sort((a, b) => b.overlap.length - a.overlap.length);
            const best = hits[0];
            const status = best && best.overlap.length >= Math.min(4, claimWords.length) ? 'candidate support' : 'needs source';
            return `| ${claim.replace(/\|/g, '/')} | ${status} | ${best?.url ?? ''} | ${best?.overlap.slice(0, 8).join(', ') ?? ''} |`;
        });
        return textResult([
            '# Evidence Matrix',
            '',
            '| Claim | Status | Best Source Candidate | Keyword Overlap |',
            '|---|---|---|---|',
            ...(rows.length ? rows : ['| (no explicit claims provided) | needs extraction |  |  |']),
            '',
            options.input.notes ? section('Research Notes', options.input.notes) : '',
            '',
            section('Next Review Step', [
                'Open each candidate source and verify it directly supports the claim.',
                'Separate evidence from interpretation.',
                'Add publication year, author/institution, and link/DOI before public citation.',
            ])
        ].filter(Boolean).join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Building evidence matrix' }; }
}

interface QualitativeCoderInput { raw_text: string; source_context?: string; coding_frame?: string[]; anonymize?: boolean; }

function anonymizeText(text: string): string {
    return text
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/https?:\/\/\S+/gi, '[url]')
        .replace(/@\w+/g, '@[handle]')
        .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, '[phone]');
}

class QualitativeCoderTool implements vscode.LanguageModelTool<QualitativeCoderInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<QualitativeCoderInput>) {
        const raw = options.input.raw_text ?? '';
        if (!raw.trim()) return textResult('error: missing argument: raw_text');
        const text = options.input.anonymize === false ? raw : anonymizeText(raw);
        const frame = options.input.coding_frame?.length ? options.input.coding_frame : [
            'agency', 'trust', 'overload', 'clarity', 'executive function', 'masking', 'belonging', 'accessibility', 'AI companionship', 'learning support'
        ];
        const paragraphs = text.split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z])/).map(p => p.trim()).filter(p => p.length > 20);
        const themeRows = frame.map(code => {
            const keyWords = words(code);
            const hits = paragraphs.filter(p => keyWords.some(w => p.toLowerCase().includes(w))).slice(0, 3);
            return `| ${code.replace(/\|/g, '/')} | ${hits.length} | ${hits.map(h => h.slice(0, 180).replace(/\|/g, '/')).join('<br>')} |`;
        });
        const quotes = paragraphs.slice(0, 8).map(p => p.length > 280 ? p.slice(0, 280) + '...' : p);
        return textResult([
            '# Qualitative Coding Pass',
            '',
            `Source context: ${options.input.source_context || 'not specified'}`,
            `Anonymized: ${options.input.anonymize === false ? 'no' : 'yes'}`,
            '',
            '| Code | Candidate Matches | Example Excerpts |',
            '|---|---:|---|',
            ...themeRows,
            '',
            section('Representative Excerpts For Human Review', quotes),
            '',
            section('Ethics Notes', [
                'Treat social posts and personal stories as lived-experience signals, not clinical proof by themselves.',
                'Do not expose handles, names, or identifying details without consent.',
                'Use this as a first coding pass; a human reviewer should confirm or revise codes before publication.',
            ])
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Coding qualitative experience text' }; }
}

interface PublicationOutlineInput { topic: string; findings?: string; audience?: string; format?: string; sources?: string[]; }

class PublicationOutlineTool implements vscode.LanguageModelTool<PublicationOutlineInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PublicationOutlineInput>) {
        const input = options.input;
        if (!input.topic) return textResult('error: missing argument: topic');
        return textResult([
            '# Publication Outline',
            '',
            `Topic: ${input.topic}`,
            `Audience: ${input.audience || 'public-interest readers, researchers, and practitioners'}`,
            `Format: ${input.format || 'research-backed article / whitepaper'}`,
            '',
            section('Recommended Structure', [
                'Opening: the concrete problem and why now.',
                'Context: what is already known and what remains under-addressed.',
                'Evidence: strongest sourced findings, separated from lived-experience observations.',
                'Framework: proposed interpretation, standard, method, or intervention.',
                'Limitations: what this does not prove yet.',
                'Call to action: what communities, researchers, builders, or institutions can do next.',
            ]),
            '',
            section('Findings To Place', input.findings || 'No findings supplied yet.'),
            '',
            section('Source Slots', input.sources?.length ? input.sources : [
                'Peer-reviewed literature.',
                'Government or standards source.',
                'Community / lived-experience source with ethical handling.',
                'Technical feasibility precedent.',
            ]),
            '',
            section('Pre-Publish Checks', [
                'Every numerical claim has a source.',
                'Every lived-experience claim is anonymized or consented.',
                'The article distinguishes evidence, interpretation, and proposal.',
                'The conclusion offers a constructive path, not just critique.',
            ])
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Outlining publication' }; }
}

interface ResearchBacklogInput { project: string; ideas: string[]; priority_lens?: string; }

class ResearchBacklogTool implements vscode.LanguageModelTool<ResearchBacklogInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ResearchBacklogInput>) {
        const input = options.input;
        if (!input.project || !Array.isArray(input.ideas)) return textResult('error: project and ideas[] are required');
        const rows = input.ideas.map((idea, i) => {
            const priority = /urgent|launch|publish|blocked|grant|client|deadline/i.test(idea) ? 'High' : (i < 3 ? 'Medium' : 'Backlog');
            return `| ${i + 1} | ${idea.replace(/\|/g, '/')} | ${priority} | literature scan, evidence matrix, qualitative coding if relevant |`;
        });
        return textResult([
            `# Research Backlog: ${input.project}`,
            '',
            `Priority lens: ${input.priority_lens || 'impact, evidence readiness, public usefulness, and feasibility'}`,
            '',
            '| # | Idea | Priority | Next Research Move |',
            '|---:|---|---|---|',
            ...rows
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Organizing research backlog' }; }
}

interface PatchPreflightInput { files: Array<{ path: string; hunks: Array<{ old_string: string; new_string?: string }> }>; }

class PatchPreflightTool implements vscode.LanguageModelTool<PatchPreflightInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PatchPreflightInput>) {
        const rows: string[] = [];
        for (const file of options.input.files ?? []) {
            const abs = resolveWorkspacePath(file.path);
            if (!abs) { rows.push(`| ${file.path} | error | outside workspace |  |`); continue; }
            let text = '';
            try { text = await fs.readFile(abs, 'utf8'); } catch (e: any) { rows.push(`| ${file.path} | error | ${String(e?.message ?? e).replace(/\|/g, '/')} |  |`); continue; }
            const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
            for (let i = 0; i < (file.hunks ?? []).length; i++) {
                const old = file.hunks[i].old_string ?? '';
                const count = old ? text.split(old).length - 1 : 0;
                rows.push(`| ${file.path} | hunk ${i + 1} | ${count} occurrence(s) | ${hash} |`);
            }
        }
        return textResult([
            '# Patch Preflight',
            '',
            '| File | Hunk | Old String Matches | Current SHA256 |',
            '|---|---|---:|---|',
            ...(rows.length ? rows : ['| (none) |  |  |  |']),
            '',
            'Safe edit rule: each intended hunk should normally show exactly 1 occurrence before using harmony_apply_patch.'
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Checking patch preflight' }; }
}

interface CodeSurgeryPlanInput { goal: string; files: string[]; risk_level?: 'low' | 'medium' | 'high'; }

class CodeSurgeryPlanTool implements vscode.LanguageModelTool<CodeSurgeryPlanInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CodeSurgeryPlanInput>) {
        const input = options.input;
        if (!input.goal || !Array.isArray(input.files) || input.files.length === 0) return textResult('error: goal and files[] are required');
        const summaries: string[] = [];
        for (const rel of input.files.slice(0, 12)) {
            const abs = resolveWorkspacePath(rel);
            if (!abs) { summaries.push(`${rel}: outside workspace`); continue; }
            const text = await readTextIfExists(abs);
            if (!text) { summaries.push(`${rel}: unreadable or missing`); continue; }
            summaries.push(`${rel}: ${text.split(/\r?\n/).length} lines, ${text.length} chars, sha256 ${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`);
        }
        return textResult([
            '# Code Surgery Plan',
            '',
            `Goal: ${input.goal}`,
            `Risk level: ${input.risk_level || 'medium'}`,
            '',
            section('Files Read / Fingerprinted', summaries),
            '',
            section('Recommended Order', [
                'Read the smallest directly affected file first and identify the exact behavior boundary.',
                'Use harmony_patch_preflight for any old_string/new_string hunks before writing.',
                'Use harmony_apply_patch for multiple hunks in the same file so validation is atomic.',
                'Run the narrowest compile/test command that proves the changed surface.',
                'Only broaden tests if the change touches shared contracts or user-facing flows.',
            ]),
            '',
            section('Failure Plan', [
                'If a hunk has 0 matches, re-read the file and rebuild the patch from current contents.',
                'If a hunk has multiple matches, add more surrounding context before editing.',
                'If compile fails outside touched files, report it separately instead of refactoring unrelated code.',
            ])
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Planning precise code surgery' }; }
}

interface RepoHealthScanInput { include_git_status?: boolean; include_diagnostics?: boolean; max_files?: number; }

class RepoHealthScanTool implements vscode.LanguageModelTool<RepoHealthScanInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RepoHealthScanInput>) {
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace is open');
        const files = await fs.readdir(root).catch((): string[] => []);
        const pkgText = await readTextIfExists(path.join(root, 'package.json'));
        const pyproject = await readTextIfExists(path.join(root, 'pyproject.toml'));
        const requirements = await readTextIfExists(path.join(root, 'requirements.txt'));
        const diagnostics = options.input.include_diagnostics === false ? [] : vscode.languages.getDiagnostics()
            .flatMap(([uri, list]) => list.map(d => `${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1}: ${vscode.DiagnosticSeverity[d.severity]}: ${d.message}`))
            .slice(0, Math.max(1, Math.min(100, Number(options.input.max_files) || 25)));
        const git = options.input.include_git_status === false ? '' : await execGit(['status', '--short'], root);
        const scripts = pkgText ? Object.keys(JSON.parse(pkgText)?.scripts ?? {}) : [];
        return textResult([
            '# Repo Health Scan',
            '',
            `Workspace: ${path.basename(root)}`,
            '',
            section('Detected Stack', [
                pkgText ? `Node/package.json with scripts: ${scripts.join(', ') || '(none)'}` : 'No package.json at workspace root.',
                pyproject ? 'Python pyproject.toml present.' : 'No pyproject.toml at workspace root.',
                requirements ? 'Python requirements.txt present.' : 'No requirements.txt at workspace root.',
                files.includes('.github') ? 'GitHub workflow/config folder present.' : 'No .github folder at workspace root.',
            ]),
            '',
            diagnostics.length ? section('Top Diagnostics', diagnostics) : section('Diagnostics', 'No VS Code diagnostics reported or diagnostics scan disabled.'),
            '',
            git.trim() ? `## Git Status\n\n\`\`\`text\n${git.trim()}\n\`\`\`` : section('Git Status', 'No status output or git scan disabled.'),
            '',
            section('Suggested Next Health Actions', [
                'Identify the primary build/test command and save it in project notes or scripts.',
                'Keep generated assets, screenshots, and private research notes out of public commits unless intentionally shared.',
                'Use patch preflight before risky edits and run the narrowest verification command after each change.',
            ])
        ].join('\n'));
    }
    async prepareInvocation() { return { invocationMessage: 'Scanning repository health' }; }
}

interface RulePredicate {
    field: string;
    op: 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'not_contains';
    value: unknown;
    label?: string;
}

interface DeclarativeRuleTier {
    id: string;
    name: string;
    priority_label: string;
    /** Lower number = higher priority. Orders qualified tiers deterministically; defaults to array position. */
    priority?: number;
    predicates: RulePredicate[];
    capacity_formula?: {
        base_field: string;
        multiplier: number;
        max_cap?: number;
    };
    required_artifacts: string[];
    notes: string;
}

const DEFAULT_RD_RULE_TIERS: DeclarativeRuleTier[] = [
    {
        id: 'tier1-high-assurance-production',
        name: 'Tier 1 High-Assurance Production Route',
        priority: 1,
        priority_label: 'Tier 1 (High-Assurance / Mission-Critical SLA)',
        predicates: [
            { field: 'reliability_score', op: 'gte', value: 95, label: 'reliability_score >= 95' },
            { field: 'uptime_months', op: 'gte', value: 12, label: 'uptime_months >= 12' },
            { field: 'incident_count_90d', op: 'lte', value: 1, label: 'incident_count_90d <= 1' },
            { field: 'category', op: 'not_in', value: ['unverified_sandbox', 'deprecated'], label: 'category not restricted' },
        ],
        capacity_formula: {
            base_field: 'baseline_throughput',
            multiplier: 1.5,
            max_cap: 500000,
        },
        required_artifacts: [
            'Deterministic regression & verification receipt',
            'Architecture & separation-of-duties review sign-off',
            'Rollback snapshot & operational runbook',
        ],
        notes: 'Highest-assurance execution tier with maximum throughput budget and lowest operational risk.',
    },
    {
        id: 'tier2-standard-production',
        name: 'Tier 2 Standard Managed Route',
        priority: 2,
        priority_label: 'Tier 2 (Standard Production / Growth SLA)',
        predicates: [
            { field: 'reliability_score', op: 'gte', value: 80, label: 'reliability_score >= 80' },
            { field: 'uptime_months', op: 'gte', value: 6, label: 'uptime_months >= 6' },
            { field: 'incident_count_90d', op: 'lte', value: 4, label: 'incident_count_90d <= 4' },
        ],
        capacity_formula: {
            base_field: 'baseline_throughput',
            multiplier: 1.25,
            max_cap: 250000,
        },
        required_artifacts: [
            'Automated compile & unit test verification receipt',
            'Service health & rate-limit configuration check',
        ],
        notes: 'Balanced production route optimized for steady operational throughput and rapid iteration.',
    },
    {
        id: 'tier3-guarded-staging',
        name: 'Tier 3 Guarded Staging / Evaluation Route',
        priority: 3,
        priority_label: 'Tier 3 (Guarded Evaluation / Bridge SLA)',
        predicates: [
            { field: 'reliability_score', op: 'gte', value: 60, label: 'reliability_score >= 60' },
            { field: 'incident_count_90d', op: 'lte', value: 10, label: 'incident_count_90d <= 10' },
        ],
        capacity_formula: {
            base_field: 'baseline_throughput',
            multiplier: 1.0,
            max_cap: 100000,
        },
        required_artifacts: [
            'Canary telemetry & bounded quota guard',
            'Explicit human checkpoint approval',
        ],
        notes: 'Designed for emerging or recovering workloads that require tighter guardrails while building operational history.',
    },
];

/** Fallback policy file used only when the profile-specific matrix file is absent. */
const GENERIC_POLICY_PATH = '.harmony/policies/matrix.json';

/** Operators the evaluator actually implements. Anything else is a policy defect, not a knockout. */
const SUPPORTED_PREDICATE_OPS = new Set<string>([
    'gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'in', 'not_in', 'contains', 'not_contains',
]);

function evaluatePredicate(entity: Record<string, unknown>, pred: RulePredicate): { passed: boolean; reason: string } {
    const actual = entity[pred.field];
    const label = pred.label || `${pred.field} ${pred.op} ${JSON.stringify(pred.value)}`;
    switch (pred.op) {
        case 'gte': {
            const ok = typeof actual === 'number' && typeof pred.value === 'number' && actual >= pred.value;
            return { passed: ok, reason: `${label} (actual: ${actual ?? 'undefined'})` };
        }
        case 'lte': {
            const ok = typeof actual === 'number' && typeof pred.value === 'number' && actual <= pred.value;
            return { passed: ok, reason: `${label} (actual: ${actual ?? 'undefined'})` };
        }
        case 'gt': {
            const ok = typeof actual === 'number' && typeof pred.value === 'number' && actual > pred.value;
            return { passed: ok, reason: `${label} (actual: ${actual ?? 'undefined'})` };
        }
        case 'lt': {
            const ok = typeof actual === 'number' && typeof pred.value === 'number' && actual < pred.value;
            return { passed: ok, reason: `${label} (actual: ${actual ?? 'undefined'})` };
        }
        case 'eq': {
            const ok = actual === pred.value;
            return { passed: ok, reason: `${label} (actual: ${JSON.stringify(actual)})` };
        }
        case 'neq': {
            const ok = actual !== pred.value;
            return { passed: ok, reason: `${label} (actual: ${JSON.stringify(actual)})` };
        }
        case 'in': {
            const list = Array.isArray(pred.value) ? pred.value.map(v => String(v).toLowerCase()) : [];
            const ok = actual !== undefined && list.includes(String(actual).toLowerCase());
            return { passed: ok, reason: `${label} (actual: ${JSON.stringify(actual)})` };
        }
        case 'not_in': {
            const list = Array.isArray(pred.value) ? pred.value.map(v => String(v).toLowerCase()) : [];
            const ok = actual === undefined || !list.includes(String(actual).toLowerCase());
            return { passed: ok, reason: `${label} (actual: ${JSON.stringify(actual)})` };
        }
        case 'contains': {
            // Accept a single value or an array so `contains` and `not_contains` stay complementary.
            const list = (Array.isArray(pred.value) ? pred.value : [pred.value])
                .map(entry => String(entry ?? '').toLowerCase())
                .filter(entry => entry.length > 0);
            const actualStr = String(actual ?? '').toLowerCase();
            const ok = list.length > 0 && list.some(entry => actualStr.includes(entry));
            return { passed: ok, reason: `${label} (actual: ${JSON.stringify(actual)})` };
        }
        case 'not_contains': {
            const target = String(pred.value ?? '').toLowerCase();
            const list = Array.isArray(pred.value) ? pred.value.map(v => String(v).toLowerCase()) : [target];
            const actualStr = String(actual ?? '').toLowerCase();
            const ok = !list.some(item => item && actualStr.includes(item));
            return { passed: ok, reason: `${label} (actual: ${JSON.stringify(actual)})` };
        }
        default:
            return { passed: false, reason: `Unsupported operator: ${pred.op}` };
    }
}

interface RuleMatrixEvalInput {
    action?: 'evaluate' | 'init_template';
    entity_name?: string;
    profile?: string;
    policy_path?: string;
    entity?: Record<string, unknown>;
    tiers?: DeclarativeRuleTier[];
}

class RuleMatrixEvalTool implements vscode.LanguageModelTool<RuleMatrixEvalInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RuleMatrixEvalInput>) {
        const input = options.input ?? {};
        const profile = (input.profile || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
        const relPath = input.policy_path?.trim() || `.harmony/policies/${profile}.matrix.json`;

        if (input.action === 'init_template') {
            const templateTiers = input.tiers?.length ? input.tiers : DEFAULT_RD_RULE_TIERS;
            await writeJson(relPath, templateTiers);
            return textResult([
                `# Declarative Rule Matrix Template Initialized`,
                '',
                `- **Profile:** \`${profile}\``,
                `- **Workspace Policy Path:** \`${relPath}\``,
                `- **Tiers Configured:** ${templateTiers.length}`,
                '',
                'Any workspace can customize this JSON file with domain-specific fields, predicates (`gte`, `lte`, `eq`, `neq`, `in`, `not_in`, `contains`, `not_contains`), capacity formulas, and required artifacts while keeping the core extension 100% domain-agnostic.',
            ].join('\n'));
        }

        const entity = input.entity ?? {};

        // Track which file actually supplied the tiers so the reported provenance is never wrong.
        const profileTiers = await readJsonIfExists<DeclarativeRuleTier[]>(relPath, []);
        const genericTiers = profileTiers.length ? [] : await readJsonIfExists<DeclarativeRuleTier[]>(GENERIC_POLICY_PATH, []);
        const loadedTiers = profileTiers.length ? profileTiers : genericTiers;
        const loadedPath = profileTiers.length ? relPath : (genericTiers.length ? GENERIC_POLICY_PATH : undefined);
        const tiers = input.tiers?.length ? input.tiers : (loadedTiers.length ? loadedTiers : DEFAULT_RD_RULE_TIERS);
        const sourceLabel = input.tiers?.length
            ? 'inline `tiers` payload'
            : (loadedPath ? `workspace policy (\`${loadedPath}\`)` : 'built-in AI R&D default tiers');
        const explicitlyPrioritized = tiers.filter(t => Number.isFinite(t.priority)).length;
        const orderingBasis = tiers.length > 0 && explicitlyPrioritized === tiers.length
            ? 'explicit `priority` field (lowest number wins)'
            : explicitlyPrioritized === 0
                ? 'tier array order (no explicit `priority` set)'
                : 'mixed — explicit `priority` first (lowest wins), then remaining tiers in array order';

        // Policy health: surface everything that makes this rule set untrustworthy, instead of
        // letting it degrade quietly. A policy you cannot trust has to say so out loud.
        const policyHealth: string[] = [];

        for (const candidate of [relPath, GENERIC_POLICY_PATH]) {
            const candidateAbs = resolveWorkspacePath(candidate);
            if (!candidateAbs) continue;
            const rawPolicy = await readTextIfExists(candidateAbs);
            if (rawPolicy === undefined) continue;
            try {
                JSON.parse(rawPolicy);
            } catch (error) {
                policyHealth.push(`\`${candidate}\` exists but is not valid JSON (${(error as Error).message}), so it was ignored.`);
            }
        }
        if (!input.tiers?.length && !loadedPath) {
            policyHealth.push('No readable workspace policy file was found, so the built-in default tiers are in use. Run with action "init_template" to author a workspace policy.');
        }
        if (tiers.length === 0) {
            policyHealth.push('The resolved policy declares zero tiers, so no entity can ever qualify.');
        }

        const tierIdCounts = new Map<string, number>();
        for (const tier of tiers) tierIdCounts.set(tier.id, (tierIdCounts.get(tier.id) ?? 0) + 1);
        for (const [id, count] of tierIdCounts) {
            if (count > 1) policyHealth.push(`Duplicate tier id \`${id}\` appears ${count} times, so results for it are ambiguous.`);
        }

        for (const tier of tiers) {
            if (!tier.predicates || tier.predicates.length === 0) {
                policyHealth.push(`Tier \`${tier.id}\` has no predicates, so it qualifies for every entity. Add a predicate or remove the tier.`);
            }
            for (const pred of tier.predicates ?? []) {
                if (!SUPPORTED_PREDICATE_OPS.has(String(pred.op))) {
                    policyHealth.push(`Tier \`${tier.id}\` uses unsupported operator \`${String(pred.op)}\`, which is applied as a knockout.`);
                }
            }
            if (tier.capacity_formula) {
                if (!Number.isFinite(Number(tier.capacity_formula.multiplier))) {
                    policyHealth.push(`Tier \`${tier.id}\` has a non-numeric capacity multiplier, so its capacity limit cannot be computed.`);
                }
                const baseValue = entity[tier.capacity_formula.base_field];
                if (baseValue !== undefined && !Number.isFinite(Number(baseValue))) {
                    policyHealth.push(`Tier \`${tier.id}\` reads capacity base field \`${tier.capacity_formula.base_field}\`, whose supplied value is not numeric.`);
                }
            }
        }
        if (explicitlyPrioritized > 0 && explicitlyPrioritized < tiers.length) {
            policyHealth.push(`Mixed priorities: ${explicitlyPrioritized} of ${tiers.length} tiers declare \`priority\` while the rest fall back to array order.`);
        }

        const evaluations = tiers.map((tier, index) => {
            const failedReasons: string[] = [];
            for (const pred of tier.predicates ?? []) {
                const res = evaluatePredicate(entity, pred);
                if (!res.passed) failedReasons.push(res.reason);
            }
            // Unprioritized tiers sort after every explicitly prioritized tier instead of
            // colliding with them on the same number line.
            return { tier, index, order: Number.isFinite(tier.priority) ? Number(tier.priority) : Number.POSITIVE_INFINITY, failedReasons };
        });

        const qualified = evaluations
            .filter(e => e.failedReasons.length === 0)
            .sort((a, b) => a.order - b.order || a.index - b.index);

        const matches = qualified.map(({ tier }) => {
            let capacityNote = '';
            if (tier.capacity_formula) {
                const baseVal = Number(entity[tier.capacity_formula.base_field]);
                const multiplier = Number(tier.capacity_formula.multiplier);
                if (Number.isFinite(baseVal) && Number.isFinite(multiplier)) {
                    const rawCap = Math.max(0, Math.round(baseVal * multiplier));
                    const finalCap = tier.capacity_formula.max_cap !== undefined ? Math.min(tier.capacity_formula.max_cap, rawCap) : rawCap;
                    capacityNote = ` — Computed capacity limit: **${finalCap.toLocaleString()}**`;
                } else {
                    capacityNote = ` — Capacity not computed (base field or multiplier was missing or non-numeric).`;
                }
            }
            return `**${tier.name}** (${tier.priority_label})${capacityNote}. ${tier.notes}`;
        });

        const knockouts = evaluations
            .filter(e => e.failedReasons.length > 0)
            .map(({ tier, failedReasons }) => `**${tier.name}**: Knocked out by → ${failedReasons.join('; ')}`);

        // Artifacts must come from the genuinely highest-priority qualified tier, not merely the first one seen.
        const topArtifacts = qualified.length > 0 ? (qualified[0].tier.required_artifacts ?? []) : [];

        const entitySummary = Object.entries(entity)
            .map(([k, v]) => `**${k}:** ${typeof v === 'number' ? v.toLocaleString() : JSON.stringify(v)}`)
            .join(' | ');

        return textResult([
            `# Deterministic Rule Matrix Evaluation${input.entity_name ? ` — ${input.entity_name}` : ''}`,
            '',
            `- **Policy Source:** ${sourceLabel}`,
            `- **Ordering Basis:** ${orderingBasis}`,
            `- **Entity Attributes:** ${entitySummary || '(none provided)'}`,
            '',
            section('Qualified Tiers (Highest Priority First)', matches.length ? matches : ['No tier matched all predicates — inspect knockout diagnostics below or evaluate an exception path.']),
            '',
            section('Deterministic Knockout Diagnostics (Failed Predicates)', knockouts.length ? knockouts : ['All evaluated tiers matched.']),
            '',
            section('Policy Health', policyHealth.length ? policyHealth : ['No policy-health issues detected.']),
            '',
            section('Required Artifacts / Preconditions for Top Qualified Tier', topArtifacts.length ? topArtifacts : ['Standard verification receipt']),
            '',
            section('Workspace Policy Pack Adaptability', [
                `To customize rules for this specific workspace without modifying extension code, run with \`action: "init_template"\` or place a declarative tier array in \`${relPath}\`.`,
            ]),
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RuleMatrixEvalInput>) {
        return { invocationMessage: `Evaluating declarative rule matrix${options.input.entity_name ? ` for ${options.input.entity_name}` : ''}` };
    }
}

interface ArchitectureRiskAuditInput {
    proposal_name: string;
    proposal_summary: string;
    security_plane_stack?: string;
    security_plane_terms?: string[];
    sensitive_assets?: string[];
    consolidates_security_and_app_plane?: boolean;
    policy_path?: string;
}

// Security-plane vocabulary, verb lists and scoring now live in ./securityPlane (decision-grade).

// Security-plane detection moved to ./securityPlane — see analyzeSecurityPlaneMerge for the decision-grade scoring.

class ArchitectureRiskAuditTool implements vscode.LanguageModelTool<ArchitectureRiskAuditInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ArchitectureRiskAuditInput>) {
        const input = options.input;
        if (!input.proposal_name || !input.proposal_summary) return textResult('error: proposal_name and proposal_summary are required');
        const summaryLower = input.proposal_summary.toLowerCase();
        const securityStack = input.security_plane_stack || 'Independent EDR / MDR / SIEM Security Plane';
        const customPolicy = await readJsonIfExists<{ invariants?: string[]; questions?: string[]; security_plane_terms?: string[] }>(
            input.policy_path?.trim() || '.harmony/policies/architecture.json',
            {}
        );
        const extraPlaneTerms = (input.security_plane_terms ?? customPolicy.security_plane_terms ?? []).filter(Boolean);
        const declaredConsolidation = input.consolidates_security_and_app_plane === true;
        const planeSignal = analyzeSecurityPlaneMerge(summaryLower, extraPlaneTerms);
        const mergesSecurityPlane = declaredConsolidation || planeSignal.level === 'confirmed';
        const planeNeedsVerification = !declaredConsolidation && planeSignal.level === 'likely';

        const assets = input.sensitive_assets?.length ? input.sensitive_assets : [
            'Core proprietary datasets, records, and customer/project documents',
            'Identity, authentication credentials, and access telemetry',
            'Workflow history, operational analytics, and routing metadata',
            'Endpoint / infrastructure security telemetry',
        ];

        const structuralRisks = [
            mergesSecurityPlane
                ? `🚨 **SEPARATION-OF-DUTIES VIOLATION (NIST SP 800-53 AC-5 / CIS / SOC 2)**: Proposal suggests replacing or merging the independent security/observability plane (${securityStack}) into an application/workflow vendor. Security monitoring and endpoint defense must remain strictly independent of business-application vendors.`
                : planeNeedsVerification
                    ? `⚠️ **NEEDS VERIFICATION — possible separation-of-duties concern (confidence ${planeSignal.score}/100)**: the proposal puts removal language near ambiguous security vocabulary. That is a lead to confirm, not a finding to act on.`
                    : `Verify that ${securityStack} remains 100% independent of ${input.proposal_name} with zero shared administrative blast radius.`,
            `🚨 **DATA SOVEREIGNTY & ECOSYSTEM CONFLICT OF INTEREST**: Centralizing proprietary records and operational pipelines inside an external vendor creates severe exfiltration and lock-in risk if that vendor (or its sub-processors/affiliates) operates adjacent or competing services.`,
            `🚨 **SINGLE-POINT-OF-FAILURE & VENDOR LOCK-IN**: Consolidating application workflows, communications, document storage, and security monitoring into a single proprietary platform means any outage, billing dispute, or breach impacts 100% of operations simultaneously.`,
            ...(customPolicy.invariants ?? []),
        ];

        const recommendedArchitecture = [
            `**Keep ${securityStack} Strictly Independent**: Security monitoring, endpoint protection, and infrastructure governance must stay under dedicated security tooling (${securityStack}) and internal stewardship — never inside a workflow/application vendor.`,
            `**Sovereign Data Layer**: Store core records, documents, and historical outcomes in organization-controlled encrypted storage with strict role-based access control (RBAC) and zero unauthorized bulk export.`,
            `**Deterministic Pre-Execution Policy Gate**: Enforce automated time-window, rate-limit, and opt-out/suppression invariants via \`harmony_policy_gate_check\` before any external dispatch leaves the system.`,
            `**Modular API Boundaries**: Connect external communication or processing providers through revocable API adapters so any vendor can be swapped in minutes without losing historical state.`,
        ];

        const dueDiligenceQuestions = customPolicy.questions?.length ? customPolicy.questions : [
            `1. "If we terminate our agreement with ${input.proposal_name} tomorrow, do we receive 100% of our raw SQL/JSON records, logs, and attachments within 24 hours with zero exit/ransom fees?"`,
            `2. "Does ${input.proposal_name}, its parent, or any affiliate operate competing services or monetize aggregated customer/workflow metadata?"`,
            `3. "Can ${input.proposal_name} provide a current SOC 2 Type II report and written security indemnification — and why would an application vendor ever recommend disabling independent security controls (${securityStack})?"`,
        ];

        return textResult([
            `# Enterprise Architecture, Separation-of-Duties & Data-Sovereignty Audit: ${input.proposal_name}`,
            '',
            `- **Proposal Summary:** ${input.proposal_summary}`,
            `- **Independent Security Plane:** ${securityStack}`,
            '',
            section('Sensitive Assets & Planes in Scope', assets),
            '',
            section('Structural Risks & Governance Findings (NIST AC-5 / SOC 2)', structuralRisks),
            '',
            section('Separation-of-Duties Evidence Trail (Decision-Grade)', [
                `Signal level: **${declaredConsolidation ? 'confirmed (explicitly declared)' : planeSignal.level}**` + (declaredConsolidation ? '' : ` — confidence ${planeSignal.score}/100`),
                ...planeSignal.reasons,
                'Scoring: strong security vocabulary scores 70, ambiguous vocabulary 40; +15 for an explicit removal verb, +10 when two or more distinct terms match, +5 when strong and ambiguous corroborate. A negation or non-commitment cue suppresses the signal to none.',
            ]),
            '',
            section('Recommended Sovereign Architecture', recommendedArchitecture),
            '',
            section('Executive Due-Diligence Questions', dueDiligenceQuestions),
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ArchitectureRiskAuditInput>) {
        return { invocationMessage: `Auditing architecture & separation-of-duties for ${options.input.proposal_name}` };
    }
}

interface PolicyGateConfig {
    quiet_hours_start?: number;
    quiet_hours_end?: number;
    max_frequency_per_window?: number;
    blocked_patterns?: string[];
    restricted_regions?: string[];
    require_full_evidence?: boolean;
}

interface PolicyGateCheckInput {
    action_label?: string;
    channel?: string;
    region_or_timezone?: string;
    local_hour_24?: number;
    suppressed_or_opted_out?: boolean;
    recent_dispatch_count?: number;
    max_frequency_per_window?: number;
    quiet_hours_start?: number;
    quiet_hours_end?: number;
    payload_text?: string;
    blocked_patterns?: string[];
    policy_path?: string;
    require_full_evidence?: boolean;
}

type InvariantStatus = 'passed' | 'failed' | 'unevaluated';

/**
 * One record per gate invariant. The verdict, the reasoning paragraph and the remedy list are
 * ALL derived from these records, so they can never contradict each other. Previously the
 * gate kept three separate arrays and then hand-wrote a resolution path per verdict branch,
 * which meant the explanation could drift from the decision.
 */
interface InvariantRecord {
    label: string;
    status: InvariantStatus;
    /** Why this status was reached, in plain language. */
    detail: string;
    /** The concrete action that would change this record's status. */
    remedy: string;
    /** True when no input can fix this — a human decision owner must resolve it. */
    humanDecision: boolean;
}

class PolicyGateCheckTool implements vscode.LanguageModelTool<PolicyGateCheckInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PolicyGateCheckInput>) {
        const input = options.input ?? {};
        const filePolicy = await readJsonIfExists<PolicyGateConfig>(
            input.policy_path?.trim() || '.harmony/policies/gate.json',
            {}
        );

        const quietStart = input.quiet_hours_start ?? filePolicy.quiet_hours_start ?? 20; // 8 PM (20:00)
        const quietEnd = input.quiet_hours_end ?? filePolicy.quiet_hours_end ?? 8;       // 8 AM (08:00)
        const maxFreq = input.max_frequency_per_window ?? filePolicy.max_frequency_per_window ?? 3;
        const blockedPatterns = input.blocked_patterns?.length
            ? input.blocked_patterns
            : (filePolicy.blocked_patterns?.length ? filePolicy.blocked_patterns : ['guaranteed approval', 'act now', 'free money', '100% guaranteed']);
        const restrictedRegions = (filePolicy.restricted_regions ?? []).map(r => r.toUpperCase());
        const requireFullEvidence = input.require_full_evidence ?? filePolicy.require_full_evidence ?? false;

        const invariants: InvariantRecord[] = [];

        if (input.suppressed_or_opted_out === true) {
            invariants.push({
                label: 'Suppression / opt-out',
                status: 'failed',
                detail: 'Target is marked suppressed or opted out.',
                remedy: 'Remove this target from the dispatch. Cross-channel suppression is not overridable by a policy exception.',
                humanDecision: false,
            });
        } else if (input.suppressed_or_opted_out === false) {
            invariants.push({
                label: 'Suppression / opt-out',
                status: 'passed',
                detail: 'Target is not suppressed or opted out.',
                remedy: 'Nothing — supplying `true` here would flip this verdict to BLOCK.',
                humanDecision: false,
            });
        } else {
            invariants.push({
                label: 'Suppression / opt-out',
                status: 'unevaluated',
                detail: '`suppressed_or_opted_out` was not supplied.',
                remedy: 'Supply `suppressed_or_opted_out: true|false` for this target.',
                humanDecision: false,
            });
        }

        if (typeof input.local_hour_24 === 'number') {
            const hr = input.local_hour_24;
            const inQuietWindow = quietStart > quietEnd
                ? (hr >= quietStart || hr < quietEnd)
                : (hr >= quietStart && hr < quietEnd);
            invariants.push(inQuietWindow
                ? {
                    label: 'Quiet hours',
                    status: 'failed',
                    detail: `Local hour ${hr}:00 is inside the quiet window ${quietStart}:00–${quietEnd}:00${input.region_or_timezone ? ` (${input.region_or_timezone})` : ''}.`,
                    remedy: `Schedule the dispatch outside ${quietStart}:00–${quietEnd}:00 local time, or record a documented exception with a human owner.`,
                    humanDecision: false,
                }
                : {
                    label: 'Quiet hours',
                    status: 'passed',
                    detail: `Local hour ${hr}:00 is outside the quiet window ${quietStart}:00–${quietEnd}:00.`,
                    remedy: 'Nothing — moving the time into the quiet window would flip this verdict to BLOCK.',
                    humanDecision: false,
                });
        } else {
            invariants.push({
                label: 'Quiet hours',
                status: 'unevaluated',
                detail: '`local_hour_24` was not supplied.',
                remedy: 'Supply `local_hour_24` (0–23) in the real local time of the target.',
                humanDecision: false,
            });
        }

        if (typeof input.recent_dispatch_count === 'number') {
            invariants.push(input.recent_dispatch_count >= maxFreq
                ? {
                    label: 'Frequency cap',
                    status: 'failed',
                    detail: `${input.recent_dispatch_count} dispatch(es) already sent this window against a cap of ${maxFreq}.`,
                    remedy: 'Wait for the rate-limit window to roll over before dispatching again.',
                    humanDecision: false,
                }
                : {
                    label: 'Frequency cap',
                    status: 'passed',
                    detail: `${input.recent_dispatch_count} of ${maxFreq} allowed dispatch(es) used this window.`,
                    remedy: 'Nothing — reaching the cap would flip this verdict to BLOCK.',
                    humanDecision: false,
                });
        } else {
            invariants.push({
                label: 'Frequency cap',
                status: 'unevaluated',
                detail: '`recent_dispatch_count` was not supplied.',
                remedy: 'Supply `recent_dispatch_count` so it can be compared against `max_frequency_per_window`.',
                humanDecision: false,
            });
        }

        if (!input.region_or_timezone) {
            invariants.push({
                label: 'Restricted regions',
                status: 'unevaluated',
                detail: '`region_or_timezone` was not supplied.',
                remedy: 'Supply `region_or_timezone` so it can be compared against the workspace `restricted_regions` list.',
                humanDecision: false,
            });
        } else if (restrictedRegions.includes(input.region_or_timezone.trim().toUpperCase())) {
            invariants.push({
                label: 'Restricted regions',
                status: 'failed',
                detail: `'${input.region_or_timezone}' is on the workspace restricted_regions list.`,
                remedy: 'Do not dispatch to this region. Changing the workspace restricted list is a human policy decision, not a runtime one.',
                humanDecision: true,
            });
        } else if (restrictedRegions.length === 0) {
            invariants.push({
                label: 'Restricted regions',
                status: 'unevaluated',
                detail: `'${input.region_or_timezone}' supplied, but the workspace declares no restricted_regions list.`,
                remedy: 'Declare `restricted_regions` in `.harmony/policies/gate.json` if this workspace excludes any regions.',
                humanDecision: false,
            });
        } else {
            invariants.push({
                label: 'Restricted regions',
                status: 'passed',
                detail: `'${input.region_or_timezone}' is not on the workspace restricted_regions list.`,
                remedy: 'Nothing — adding this region to `restricted_regions` would flip this verdict to BLOCK.',
                humanDecision: false,
            });
        }

        if (input.payload_text) {
            const lower = input.payload_text.toLowerCase();
            const matched = blockedPatterns.filter(p => p && lower.includes(p.toLowerCase()));
            invariants.push(matched.length > 0
                ? {
                    label: 'Payload hygiene',
                    status: 'failed',
                    detail: `Payload matched blocked pattern(s): ${matched.map(m => `'${m}'`).join(', ')}.`,
                    remedy: 'Rewrite the payload to remove the prohibited claims. Do not reword only to evade the matcher — that defeats the gate.',
                    humanDecision: false,
                }
                : {
                    label: 'Payload hygiene',
                    status: 'passed',
                    detail: 'Payload matched zero blocked patterns.',
                    remedy: 'Nothing — introducing a blocked phrase would flip this verdict to BLOCK.',
                    humanDecision: false,
                });
        } else {
            invariants.push({
                label: 'Payload hygiene',
                status: 'unevaluated',
                detail: '`payload_text` was not supplied.',
                remedy: 'Supply `payload_text` so the outbound message body can be scanned.',
                humanDecision: false,
            });
        }

        const failedInvariants = invariants.filter(i => i.status === 'failed');
        const unevaluatedInvariants = invariants.filter(i => i.status === 'unevaluated');
        const passedInvariants = invariants.filter(i => i.status === 'passed');
        const verdict = failedInvariants.length > 0
            ? 'BLOCK'
            : (passedInvariants.length === 0 || (requireFullEvidence && unevaluatedInvariants.length > 0)
                ? 'INCONCLUSIVE'
                : 'ALLOW');

        const verdictBasis = verdict === 'BLOCK'
            ? `${failedInvariants.length} invariant(s) failed, which is decisive and cannot be averaged away by the ones that passed.`
            : verdict === 'INCONCLUSIVE'
                ? (passedInvariants.length === 0
                    ? 'No invariant could be evaluated at all, and an unevaluated gate is not approval.'
                    : `${unevaluatedInvariants.length} invariant(s) remain unevaluated while require_full_evidence is set, so approval is withheld.`)
                : `All ${passedInvariants.length} evaluated invariant(s) passed; ${unevaluatedInvariants.length} were never evaluated.`;

        // Remedies are read straight off the records, so the advice can never contradict the verdict.
        const whatWouldMoveIt = failedInvariants.length > 0
            ? [
                ...failedInvariants.map(i => `**${i.label}** — ${i.remedy}`),
                ...(failedInvariants.some(i => i.humanDecision)
                    ? ['At least one failure needs a human decision owner. Escalate it rather than re-running the gate with adjusted inputs.']
                    : []),
            ]
            : [
                ...unevaluatedInvariants.map(i => `**${i.label}** — ${i.remedy}`),
                ...passedInvariants.map(i => `**${i.label}** — ${i.remedy}`),
                'Supplying a failing value for any invariant above would flip this verdict to BLOCK. That is the purpose of the gate, so supply real evidence rather than whichever value happens to pass.',
            ];

        const statusGlyph = (status: InvariantStatus) => status === 'passed' ? '✅' : status === 'failed' ? '❌' : '⬜';

        return textResult([
            `# Deterministic Pre-Execution Policy Gate: **${verdict}**${input.action_label ? ` — ${input.action_label}` : ''}`,
            '',
            `- **Verdict:** **${verdict}**`,
            `- **Why:** ${verdictBasis}`,
            `- **Channel:** ${input.channel || 'general'} | **Region/TZ:** ${input.region_or_timezone || 'unspecified'}`,
            `- **Evidence Mode:** ${requireFullEvidence ? 'fail-closed — every invariant required' : 'fail-closed on zero evidence'}`,
            '',
            section('Verdict Reasoning (one record per invariant)', invariants.map(i => `${statusGlyph(i.status)} **${i.label}** — ${i.status.toUpperCase()}: ${i.detail}`)),
            '',
            section('What Would Move This Verdict', whatWouldMoveIt),
            '',
            section('Workspace Customization', [
                'Place custom quiet-hour bounds, frequency caps, restricted regions, blocked payload patterns, or `require_full_evidence: true` in `.harmony/policies/gate.json` to adapt this gate per workspace.',
            ]),
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<PolicyGateCheckInput>) {
        return { invocationMessage: `Checking pre-execution policy gate${options.input.action_label ? ` for ${options.input.action_label}` : ''}` };
    }
}

export function registerCompanyTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_client_brief', new ClientBriefTool()),
        vscode.lm.registerTool('harmony_accessibility_audit', new AccessibilityAuditTool()),
        vscode.lm.registerTool('harmony_brand_asset_pack', new BrandAssetPackTool()),
        vscode.lm.registerTool('harmony_cost_estimator', new CostEstimatorTool()),
        vscode.lm.registerTool('harmony_deploy_check', new DeployCheckTool()),
        vscode.lm.registerTool('harmony_ethics_license_check', new EthicsLicenseCheckTool()),
        vscode.lm.registerTool('harmony_invoice_proposal', new InvoiceProposalTool()),
        vscode.lm.registerTool('harmony_research_brief', new ResearchBriefTool()),
        vscode.lm.registerTool('harmony_literature_scan', new LiteratureScanTool()),
        vscode.lm.registerTool('harmony_evidence_matrix', new EvidenceMatrixTool()),
        vscode.lm.registerTool('harmony_qualitative_coder', new QualitativeCoderTool()),
        vscode.lm.registerTool('harmony_publication_outline', new PublicationOutlineTool()),
        vscode.lm.registerTool('harmony_research_backlog', new ResearchBacklogTool()),
        vscode.lm.registerTool('harmony_patch_preflight', new PatchPreflightTool()),
        vscode.lm.registerTool('harmony_code_surgery_plan', new CodeSurgeryPlanTool()),
        vscode.lm.registerTool('harmony_repo_health_scan', new RepoHealthScanTool()),
        vscode.lm.registerTool('harmony_rule_matrix_eval', new RuleMatrixEvalTool()),
        vscode.lm.registerTool('harmony_architecture_risk_audit', new ArchitectureRiskAuditTool()),
        vscode.lm.registerTool('harmony_policy_gate_check', new PolicyGateCheckTool()),
    );
}