import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';

const MAX_RESULT_CHARS = 60000;
const COST_LEDGER_PATH = '.harmony/cost-ledger.json';

function clip(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
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
    );
}