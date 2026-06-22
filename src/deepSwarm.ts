import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { consult, ProviderId, Tier, providerDisplayName, modelFor, secretKeyFor, PROVIDER_IDS } from './providers';
import { estimateCost } from './costTracker';

// Lazy-loaded PDF parser — avoids startup overhead for non-PDF workflows
let _pdfParse: ((buf: Buffer) => Promise<{ text: string; numpages: number }>) | null = null;
async function pdfParse(buf: Buffer): Promise<{ text: string; numpages: number }> {
    if (!_pdfParse) {
        try {
            // pdf-parse v1.x: import the module, then call it as a function
            const pdfModule: any = await import('pdf-parse');
            _pdfParse = (typeof pdfModule.default === 'function')
                ? pdfModule.default
                : pdfModule.PDFParse
                    ? (b: Buffer) => new pdfModule.PDFParse({ data: b }).then((r: any) => ({ text: r.text || '', numpages: r.numpages || 1 }))
                    : pdfModule;
        } catch {
            throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
        }
    }
    return _pdfParse!(buf);
}

// ── Data Structures ──────────────────────────────────────────────

export interface DeepSwarmPipeline {
    id: string;
    name: string;
    description: string;
    steps: DeepSwarmStep[];
    isTemplate: boolean;
}

export interface DeepSwarmStep {
    id: string;
    label: string;
    mode: 'thorough' | 'scrutinize' | 'pioneer';
    /** When true, primary provider resolves from harmony.vision.provider config. Users without Gemini access can set 'alibaba' for Qwen. */
    visualStep?: boolean;
    providers: {
        primary: ProviderTier;
        parallel?: ProviderTier[];
        reviewers?: ProviderTier[];
    };
    promptTemplate: string;
    focusHint: string;
    checklist: string[];
    /** Override max output tokens per provider call. Defaults: 2048 (thorough/scrutinize primary), 1024 (reviewers). Set to 8192+ for synthesis steps. */
    maxTokens?: number;
}

export interface ProviderTier {
    provider: ProviderId;
    tier: Tier;
}

export interface StepResult {
    stepId: string;
    label: string;
    mode: string;
    primaryResult: string;
    parallelResults?: string[];
    reviewerNotes?: string[];
    costEstimateDollars: number;
    durationMs: number;
}

export interface PipelineResult {
    pipelineId: string;
    pipelineName: string;
    steps: StepResult[];
    totalCostDollars: number;
    totalDurationMs: number;
    finalSynthesis: string;
}

// ── Translation fallback order (configurable via settings) ─────
function getTranslationFallbackOrder(): ProviderId[] {
    const config = vscode.workspace.getConfiguration('harmony.translation');
    const order: string[] = config.get<string[]>('fallbackOrder', ['deepseek', 'alibaba', 'gemini', 'moonshot', 'claude']);
    return order.filter(p => (PROVIDER_IDS as readonly string[]).includes(p)) as ProviderId[];
}

// ── Pipeline Templates ───────────────────────────────────────────

export const PIPELINE_TEMPLATES: DeepSwarmPipeline[] = [
    // 1. Code Review
    {
        id: 'code-review',
        name: '🔍 Code Review',
        description: 'Multi-angle code review: structure, security, performance, readability.',
        isTemplate: true,
        steps: [
            {
                id: 'cr-structure',
                label: '1. Structure Analysis',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Analyze the following code for structure, patterns, readability, and organization.\n\nFocus: {focus}\n\nCode:\n{code}',
                focusHint: 'Code organization, design patterns, naming conventions, modularity.',
                checklist: ['Is the code well-organized?', 'Are design patterns used appropriately?', 'Are names clear and consistent?', 'Is the code modular?'],
            },
            {
                id: 'cr-security',
                label: '2. Security Audit',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }, { provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Audit the following code for security issues.\n\nFocus: {focus}\n\nCode:\n{code}',
                focusHint: 'Vulnerabilities, injection, auth, data leaks, input validation.',
                checklist: ['SQL/command injection risks?', 'Authentication/authorization gaps?', 'Sensitive data exposure?', 'Input validation sufficient?'],
            },
            {
                id: 'cr-performance',
                label: '3. Performance Scan',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Scan the following code for performance issues.\n\nFocus: {focus}\n\nCode:\n{code}',
                focusHint: 'Bottlenecks, N+1 queries, memory leaks, algorithmic complexity.',
                checklist: ['N+1 query patterns?', 'Memory leak risks?', 'Inefficient algorithms?', 'Unnecessary work in loops?'],
            },
            {
                id: 'cr-synthesis',
                label: '4. Synthesis',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Synthesize the following code review findings into a prioritized report.\n\nFindings:\n{findings}\n\nProduce a unified review with: 1) Critical issues, 2) Important improvements, 3) Nice-to-haves.',
                focusHint: 'Prioritize by severity and actionability.',
                checklist: ['Are critical issues clearly identified?', 'Are recommendations actionable?', 'Is the report well-organized?'],
            },
        ],
    },

    // 2. Architecture Review
    {
        id: 'architecture',
        name: '🏗️ Architecture Review',
        description: 'Analyze architecture patterns, alternatives, scaling, and trade-offs.',
        isTemplate: true,
        steps: [
            {
                id: 'arch-patterns',
                label: '1. Pattern Analysis',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Analyze the architecture patterns in the following code.\n\nFocus: {focus}\n\nCode:\n{code}',
                focusHint: 'Design patterns, SOLID principles, coupling/cohesion, architectural style.',
                checklist: ['What architectural style is used?', 'Are SOLID principles followed?', 'How coupled are the components?', 'Is the architecture scalable?'],
            },
            {
                id: 'arch-alternatives',
                label: '2. Alternative Approaches',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'alibaba', tier: 'mid' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Propose alternative architectural approaches for the following code.\n\nFocus: {focus}\n\nCode:\n{code}',
                focusHint: 'Different architectures, trade-offs, what would change.',
                checklist: ['What alternatives exist?', 'What are the trade-offs?', 'What is the migration cost?', 'Which is most pragmatic?'],
            },
            {
                id: 'arch-scaling',
                label: '3. Scaling Analysis',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Analyze the scaling characteristics of the following code.\n\nFocus: {focus}\n\nCode:\n{code}',
                focusHint: 'Bottlenecks, horizontal vs vertical scaling, data flow at scale.',
                checklist: ['Where are the scaling bottlenecks?', 'Can it scale horizontally?', 'What breaks at 10x load?', 'Database scaling concerns?'],
            },
            {
                id: 'arch-synthesis',
                label: '4. Synthesis',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Synthesize architecture findings into a recommendation with trade-off matrix.\n\nFindings:\n{findings}',
                focusHint: 'Clear recommendation with trade-offs.',
                checklist: ['Is the recommendation clear?', 'Are trade-offs explicit?', 'Is it actionable?'],
            },
        ],
    },

    // 3. Bug Hunt
    {
        id: 'bug-hunt',
        name: '🐛 Bug Hunt',
        description: 'Root cause analysis, edge cases, fix strategies, regression risk.',
        isTemplate: true,
        steps: [
            {
                id: 'bug-root',
                label: '1. Root Cause',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }, { provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Find the root cause of this bug.\n\nFocus: {focus}\n\nContext:\n{code}',
                focusHint: 'Trace the bug to its origin, not just the symptom.',
                checklist: ['What is the actual root cause?', 'Why was it introduced?', 'What assumption was violated?', 'Is this a class of bug?'],
            },
            {
                id: 'bug-edges',
                label: '2. Edge Cases',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'alibaba', tier: 'mid' },
                    parallel: [{ provider: 'tencent', tier: 'mid' }],
                },
                promptTemplate: 'Identify edge cases and boundary conditions.\n\nFocus: {focus}\n\nContext:\n{code}',
                focusHint: 'Race conditions, null/undefined, boundary values, concurrency.',
                checklist: ['Race condition risks?', 'Null/undefined handling?', 'Boundary values tested?', 'Concurrency issues?'],
            },
            {
                id: 'bug-fix',
                label: '3. Fix Strategies',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Propose fix strategies for this bug.\n\nFocus: {focus}\n\nContext:\n{code}',
                focusHint: 'Minimal fix vs refactor, regression risk, test coverage.',
                checklist: ['Minimal fix approach?', 'Broader refactor warranted?', 'Regression risk?', 'Test coverage for the fix?'],
            },
            {
                id: 'bug-verify',
                label: '4. Verify',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }, { provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Triple-check the proposed fix.\n\nFix:\n{fix}\n\nOriginal bug:\n{bug}',
                focusHint: 'Does the fix actually solve the root cause? Any side effects?',
                checklist: ['Does the fix solve the root cause?', 'Are there side effects?', 'Is the fix complete?', 'What testing is needed?'],
            },
        ],
    },

    // 4. Brainstorm
    {
        id: 'brainstorm',
        name: '💡 Brainstorm',
        description: 'Wild ideas → constraint check → top ideas synthesis.',
        isTemplate: true,
        steps: [
            {
                id: 'brain-ideas',
                label: '1. Wild Ideas',
                mode: 'pioneer',
                providers: {
                    primary: { provider: 'deepseek', tier: 'mid' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }, { provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Generate wild, creative ideas for: {focus}\n\nGo beyond obvious solutions. What would a breakthrough look like? What assumptions can we challenge?\n\nContext:\n{code}',
                focusHint: 'Unconstrained ideation — no idea is too wild.',
                checklist: ['Are ideas genuinely creative?', 'Do they challenge assumptions?', 'Are they diverse in approach?', 'Any breakthrough potential?'],
            },
            {
                id: 'brain-constraints',
                label: '2. Constraint Check',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Evaluate these ideas against realistic constraints.\n\nIdeas:\n{ideas}\n\nConstraints: time, budget, technical feasibility, existing codebase.\n\nWhich ideas survive?',
                focusHint: 'Which ideas survive real-world constraints?',
                checklist: ['Which ideas are feasible?', 'What are the blockers?', 'Can constrained versions work?', 'Which has best effort/impact ratio?'],
            },
            {
                id: 'brain-synthesis',
                label: '3. Synthesis',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Select and refine the top 3-5 ideas.\n\nIdeas:\n{ideas}\n\nProvide: idea name, one-line description, why it wins, key risks, next step.',
                focusHint: 'Top 3-5 ideas with clear next steps.',
                checklist: ['Top ideas clearly identified?', 'Why they win explained?', 'Risks noted?', 'Next steps actionable?'],
            },
        ],
    },

    // 5. Pioneer Deep Dive
    {
        id: 'pioneer',
        name: '🔬 Pioneer Deep Dive',
        description: 'Map boundaries → question assumptions → explore beyond → synthesize.',
        isTemplate: true,
        steps: [
            {
                id: 'pioneer-map',
                label: '1. Map Known Boundaries',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Map the known boundaries of: {focus}\n\nWhat do we know for certain? What are the hard constraints? What are the current best practices?\n\nContext:\n{code}',
                focusHint: 'Define what we know and what the edges are.',
                checklist: ['What is definitely known?', 'What are the hard constraints?', 'What are current best practices?', 'Where is the boundary?'],
            },
            {
                id: 'pioneer-question',
                label: '2. Question Assumptions',
                mode: 'pioneer',
                providers: {
                    primary: { provider: 'alibaba', tier: 'mid' },
                    parallel: [{ provider: 'deepseek', tier: 'mid' }, { provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Question every assumption about: {focus}\n\nWhat if the core constraint didn\'t exist? What if the problem is framed wrong? What paradigm shift changes everything?\n\nBoundaries:\n{boundaries}',
                focusHint: 'Challenge fundamental assumptions.',
                checklist: ['Which assumptions are truly necessary?', 'What if the constraint is removed?', 'Is the problem framed correctly?', 'What paradigm shift is possible?'],
            },
            {
                id: 'pioneer-explore',
                label: '3. Explore Adjacent',
                mode: 'pioneer',
                providers: {
                    primary: { provider: 'alibaba', tier: 'mid' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Explore one step beyond the known boundaries.\n\nFocus: {focus}\n\nAssumptions challenged:\n{assumptions}\n\nWhat lies just beyond? What new territory opens up?',
                focusHint: 'What\'s one step beyond current knowledge?',
                checklist: ['What new territory opens?', 'What new capabilities emerge?', 'What new problems arise?', 'Is this a dead end or a frontier?'],
            },
            {
                id: 'pioneer-synthesis',
                label: '4. Synthesize',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Create a new territory map.\n\nFindings:\n{findings}\n\nMap: known → challenged → adjacent → new territory. What did we discover?',
                focusHint: 'Synthesize into a coherent new-territory map.',
                checklist: ['What did we discover?', 'Is the map coherent?', 'What are the next exploration steps?', 'What changed our understanding?'],
            },
        ],
    },

    // 6. Triple-Check Audit
    {
        id: 'triple-check',
        name: '🛡️ Triple-Check Audit',
        description: '3-pass safety audit: orchestrator scan → direct inspection → grep verification. Produces a GO/NO-GO verdict for every file.',
        isTemplate: true,
        steps: [
            {
                id: 'tc-orchestrator',
                label: '1. Orchestrator Scan',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'You are auditing code changes before they ship. Scan the following code and produce a structured audit plan.\n\nFor each file, list:\n1. What to check (secrets, private terms, broken patterns, type errors)\n2. Risk level (low/medium/high)\n3. Specific grep patterns to verify\n\nCode:\n{code}\n\nFocus: {focus}',
                focusHint: 'Security, privacy, correctness, and pattern integrity.',
                checklist: ['Any leaked secrets or API keys?', 'Any private/internal/personal terms?', 'Any TypeScript patterns that could break at runtime?', 'Any import paths that might not resolve?'],
            },
            {
                id: 'tc-inspection',
                label: '2. Direct Inspection',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }, { provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Read this code file directly and verify every finding from the orchestration pass against the actual source.\n\nOrchestrator findings:\n{findings}\n\nCode:\n{code}\n\nFor each finding, confirm: FOUND (the issue exists at line X), NOT FOUND (the issue is not present), or AMBIGUOUS (needs human review).',
                focusHint: 'Verify every claim against actual source code. Be precise about line numbers.',
                checklist: ['Is each finding confirmed against actual code?', 'Are line numbers precise?', 'Are ambiguous findings flagged for human review?', 'Were any new issues discovered during inspection?'],
            },
            {
                id: 'tc-grep',
                label: '3. Grep Verification',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'mid' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Design targeted regex patterns to verify code safety. For each pattern, explain what it catches and why it matters.\n\nCode:\n{code}\n\nInspection findings:\n{findings}\n\nProduce a list of regex patterns that would catch: private terms, secrets, broken patterns, and import issues.',
                focusHint: 'Pattern-based verification — design grep patterns that catch what inspection might miss.',
                checklist: ['Would this pattern catch leaked secrets?', 'Would it catch private/internal terms?', 'Would it catch TypeScript artifacts in compiled JS?', 'Would it catch broken import patterns?'],
            },
            {
                id: 'tc-verdict',
                label: '4. Final Verdict',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Synthesize all audit findings into a final GO/NO-GO verdict.\n\nFindings from all passes:\n{findings}\n\nProduce a table with each file, every check, and a clear GO/NO-GO status. Ambiguous findings must be flagged for human review.',
                focusHint: 'Clear, actionable verdict — no false positives, no missed issues.',
                checklist: ['Is every file covered?', 'Is every finding addressed?', 'Are ambiguous items clearly flagged?', 'Is the overall verdict clear and justified?'],
            },
        ],
    },

    // 7. Website Analysis
    {
        id: 'website-analysis',
        name: '🌐 Website Analysis',
        description: 'Comprehensive website review: design, accessibility, performance, content, and SEO — analyzed in parallel by providers playing to their strengths.',
        isTemplate: true,
        steps: [
            {
                id: 'wa-design',
                label: '1. Design & UX Review',
                mode: 'thorough',
                visualStep: true,
                providers: {
                    primary: { provider: 'gemini', tier: 'mid' },
                    parallel: [{ provider: 'deepseek', tier: 'mid' }],
                },
                promptTemplate: 'Analyze the following website for design and user experience.\n\nFocus: {focus}\n\nWebsite context:\n{website_context}\n\nEvaluate: visual hierarchy, layout consistency, color harmony, typography, responsive design, navigation clarity, call-to-action placement, whitespace usage, and overall aesthetic quality.',
                focusHint: 'Visual hierarchy, layout, typography, color, responsive design, navigation.',
                checklist: ['Is the visual hierarchy clear?', 'Is the layout consistent across pages?', 'Are colors harmonious and accessible?', 'Is typography readable and well-scaled?', 'Is navigation intuitive?', 'Are CTAs well-placed and clear?'],
            },
            {
                id: 'wa-accessibility',
                label: '2. Accessibility Audit',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Audit the following website for accessibility.\n\nFocus: {focus}\n\nWebsite context:\n{website_context}\n\nEvaluate: WCAG 2.1 AA compliance, color contrast, keyboard navigation, screen reader compatibility, alt text, ARIA labels, form accessibility, focus indicators, motion safety (prefers-reduced-motion), and cognitive accessibility.',
                focusHint: 'WCAG compliance, screen readers, keyboard nav, contrast, ARIA, motion safety.',
                checklist: ['Are color contrasts sufficient (4.5:1 minimum)?', 'Is the site keyboard-navigable?', 'Are images missing alt text?', 'Are ARIA labels present where needed?', 'Are forms accessible?', 'Is motion safe for vestibular disorders?'],
            },
            {
                id: 'wa-performance',
                label: '3. Performance & SEO',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'mid' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: 'Analyze the following website for performance and SEO.\n\nFocus: {focus}\n\nWebsite context:\n{website_context}\n\nEvaluate: load time factors (image optimization, bundle size, render-blocking resources), Core Web Vitals signals, meta tags (title, description, OG), semantic HTML structure, heading hierarchy, internal linking, mobile-friendliness, and structured data.',
                focusHint: 'Load performance, Core Web Vitals, meta tags, semantic HTML, SEO best practices.',
                checklist: ['Are images properly optimized?', 'Are there render-blocking resources?', 'Are meta tags complete and unique?', 'Is heading hierarchy logical?', 'Is the site mobile-friendly?', 'Is structured data present?'],
            },
            {
                id: 'wa-content',
                label: '4. Content & Messaging',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'alibaba', tier: 'mid' },
                    parallel: [{ provider: 'deepseek', tier: 'mid' }],
                },
                promptTemplate: 'Review the following website content and messaging.\n\nFocus: {focus}\n\nWebsite context:\n{website_context}\n\nEvaluate: clarity of messaging, tone consistency, readability level, call-to-action effectiveness, trust signals (testimonials, social proof), inclusivity of language, value proposition clarity, and neurodivergent-friendly communication patterns.',
                focusHint: 'Messaging clarity, tone, readability, trust signals, inclusive language, ND-friendly communication.',
                checklist: ['Is the value proposition clear within 5 seconds?', 'Is the tone consistent throughout?', 'Is the reading level appropriate for the audience?', 'Are trust signals present and authentic?', 'Is the language inclusive and welcoming?', 'Is the content scannable (headings, bullets, short paragraphs)?'],
            },
            {
                id: 'wa-synthesis',
                label: '5. Prioritized Recommendations',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: 'Synthesize all website analysis findings into a prioritized action plan.\n\nFindings from all passes:\n{findings}\n\nProduce: 1) Critical issues (must fix before launch), 2) Important improvements (next iteration), 3) Nice-to-haves (future). For each item, include: the issue, why it matters, which provider(s) flagged it, and a suggested fix.',
                focusHint: 'Prioritize by impact and urgency. Be specific about what to fix and why.',
                checklist: ['Are critical launch-blockers clearly identified?', 'Are recommendations specific and actionable?', 'Is each finding attributed to the provider(s) that flagged it?', 'Is the prioritization logical (critical → important → nice-to-have)?', 'Are suggested fixes practical?'],
            },
        ],
    },

    // 8. Sequential Design Review (Sequential Chain)
    {
        id: 'sequential-design-review',
        name: '🐝 Sequential Design Review',
        description: 'Sequential chain: Aesthetic Analyst → UX Analyst → Technical Analyst → Lead Synthesizer. Each step builds on the previous analysis for cohesive web design critique.',
        isTemplate: true,
        steps: [
            {
                id: 'design-aesthetics',
                label: '1. Aesthetic Analyst',
                mode: 'thorough',
                visualStep: true,
                providers: {
                    primary: { provider: 'gemini', tier: 'mid' },
                    parallel: [{ provider: 'deepseek', tier: 'mid' }],
                },
                promptTemplate: `You are the Aesthetic Analyst. Your purpose is to perceive beauty, visual harmony, and emotional resonance in website design.

Analyze the following website through the lens of aesthetics and visual design:

Website context:
{website_context}

Focus area: {focus}

Evaluate:
1. Color palette — harmony, contrast, emotional tone, brand alignment
2. Typography — font choices, hierarchy, readability, character
3. Spacing & rhythm — whitespace, grid alignment, visual flow
4. Imagery & iconography — quality, consistency, emotional impact
5. Animation & motion — subtlety, purpose, delight factor
6. Overall aesthetic identity — what personality does this site project?

Be poetic but precise. Describe what you SEE, not what should be fixed. Your observations will be built upon by the UX Analyst.`,
                focusHint: 'Color palette, typography, spacing, imagery, motion, aesthetic identity.',
                checklist: ['Is the color palette harmonious?', 'Is typography well-chosen and readable?', 'Is spacing consistent and rhythmic?', 'Is imagery high-quality and coherent?', 'Is animation purposeful, not distracting?', 'Is the aesthetic identity clear and memorable?'],
            },
            {
                id: 'design-ux',
                label: '2. UX Analyst',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: `You are the UX Analyst. Your purpose is to understand how users move through, interact with, and experience a website.

The Aesthetic Analyst has already reviewed the visual design. BUILD ON their observations — do not repeat them, but reference and extend:

Previous analysis (Aesthetic Analyst):
{findings}

Now analyze the user experience of this website:

Website context:
{website_context}

Focus area: {focus}

Evaluate:
1. Information architecture — is content organized intuitively?
2. Navigation — clarity, consistency, discoverability
3. User flows — common tasks, friction points, dead ends
4. Cognitive load — is the interface overwhelming or guiding?
5. Accessibility signals — keyboard reachability, focus order, color reliance
6. Responsive behavior — how does the layout adapt across viewports?
7. Micro-interactions — feedback, affordances, delight moments

Connect your UX findings back to the Aesthetic Analyst's observations. Does beauty support usability here, or is there tension? Be specific.`,
                focusHint: 'Information architecture, navigation, user flows, cognitive load, accessibility signals, responsive behavior.',
                checklist: ['Is information organized intuitively?', 'Is navigation consistent and discoverable?', 'Are common user flows smooth?', 'Is cognitive load well-managed?', 'Are accessibility basics addressed?', 'Does visual beauty support usability?'],
            },
            {
                id: 'design-technical',
                label: '3. Technical Analyst',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: `You are the Technical Analyst. Your purpose is to inspect the underlying structure, performance, and technical integrity of a website.

The Aesthetic Analyst reviewed visual design, and the UX Analyst reviewed user experience. BUILD ON both of their observations:

Previous analyses:
{findings}

Now perform a technical audit of this website:

Website context:
{website_context}

Focus area: {focus}

Evaluate:
1. HTML structure — semantic elements, heading hierarchy, landmark regions
2. CSS architecture — selector specificity, repetition, responsive breakpoints
3. Performance signals — image sizes, resource count, render-blocking patterns
4. SEO fundamentals — meta tags, structured data, canonical links
5. Accessibility implementation — ARIA usage, alt text coverage, form labels
6. Security basics — external resources, form handling indicators
7. Technical debt signals — inline styles, !important usage, commented-out code

Where the Aesthetic Analyst and UX Analyst identified issues, note the ROOT TECHNICAL CAUSE. Connect the dots: why does the UX friction found exist at the code level? Why might the aesthetic concerns stem from CSS architecture choices?`,
                focusHint: 'Semantic HTML, CSS quality, performance, SEO, accessibility implementation, technical debt.',
                checklist: ['Is HTML semantic with proper landmarks?', 'Is CSS well-structured (no excess specificity)?', 'Are performance basics addressed?', 'Are SEO fundamentals in place?', 'Is accessibility properly implemented?', 'Are technical causes identified for UX/aesthetic issues?'],
            },
            {
                id: 'design-synthesis',
                label: '4. Lead Synthesizer',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: `You are the Lead Synthesizer. Your purpose is to weave together the observations of the Aesthetic Analyst, UX Analyst, and Technical Analyst into one cohesive, encouraging, and actionable blueprint.

All previous swarm analyses:
{findings}

Focus area: {focus}

Your task:
1. **Weave the narrative** — Connect the Aesthetic Analyst's visual observations, the UX Analyst's experience insights, and the Technical Analyst's structural findings. Show how they relate, not just list them.
2. **Identify the harmony** — What is working beautifully? What strengths should be preserved and celebrated?
3. **Name the tensions** — Where are aesthetics, UX, and technical reality in conflict? Be honest but kind.
4. **Prioritized recommendations** — What should change first, second, third? For each: what the change is, which agent(s) flagged it, why it matters, and a suggested approach.
5. **The harmonious vision** — End with a warm, encouraging summary of what this website could become.

Format your response as a cohesive narrative, not bullet points. Reference the three analysts' perspectives naturally throughout. Be specific, be practical, be kind.`,
                focusHint: 'Weave all three perspectives into one cohesive, prioritized, encouraging blueprint.',
                checklist: ['Are all three analysts\' perspectives woven together?', 'Is the narrative cohesive, not just a list?', 'Are strengths celebrated?', 'Are tensions named honestly but kindly?', 'Are recommendations prioritized and actionable?', 'Does the vision end on an encouraging note?', 'Is each recommendation attributed to the analyst(s) that flagged it?'],
                maxTokens: 32768,
            },
        ],
    },

    // 8. English ↔ Chinese Translation
    {
        id: 'translation',
        name: '🌉 EN ↔ ZH Translation',
        description: '5-phase translation swarm: glossary → bulk translate → cultural polish → QA → bilingual assembly. Optimized for formal business/technical Chinese.',
        isTemplate: true,
        steps: [
            {
                id: 'trans-glossary',
                label: '1. Glossary Builder',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: `You are building a professional English↔Chinese translation glossary from the following source material. This is for a formal business/technical document destined for a Chinese-speaking audience.

Source text:
{code}

Focus: {focus}

Your task:
1. Extract ALL domain-specific terms, technical jargon, proper names, organization names, product names, and concepts that need CONSISTENT Chinese translation
2. For each term, provide:
   - English original
   - Recommended Chinese translation (use 简体中文)
   - Why this translation (tone, industry convention, precision)
   - Category (Technical | Business | Organization | Concept | Product)
3. Identify any culturally sensitive terms that need special handling
4. Note any English idioms or metaphors that won't translate literally and need cultural adaptation

Format as a structured glossary table. Group by category. This glossary will be used by the bulk translator and QA reviewer.`,
                focusHint: 'Extract domain terms from the source, build a precise, consistent EN↔ZH glossary for formal business use.',
                checklist: ['All domain terms extracted?', 'Chinese translations precise and industry-appropriate?', 'Categories assigned?', 'Culturally sensitive terms flagged?', 'Idioms/metaphors noted for adaptation?', 'Glossary formatted for downstream use?'],
            },
            {
                id: 'trans-bulk',
                label: '2. Bulk Translation',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    parallel: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: `You are translating a formal business/technical document from English to Chinese (简体中文). This is a PROFESSIONAL, HIGH-STAKES translation.

Glossary and context from Phase 1:
{findings}

Source text to translate:
{code}

Focus: {focus}

Translation requirements:
1. **Use the glossary** — Every term in the glossary MUST be translated consistently as specified
2. **Tone: 公文风格** — Formal Chinese business/official document style. Professional, precise, respectful
3. **Preserve structure** — Keep all headings, lists, tables, paragraphs intact
4. **Technical accuracy** — Technical terms must be translated precisely; when in doubt, include the English original in parentheses on first use
5. **Cultural adaptation** — English idioms and metaphors should be adapted to natural Chinese equivalents, not translated literally
6. **Completeness** — Translate EVERY sentence. Nothing omitted. Nothing summarized.

Output the complete Chinese translation. Do not include the English original unless it\'s a first-use technical term in parentheses.`,
                focusHint: 'Translate the full source text into formal Chinese using the glossary. Professional, complete, culturally natural.',
                checklist: ['Every glossary term used consistently?', 'Formal 公文风格 tone throughout?', 'All structure preserved?', 'Technical terms handled correctly?', 'Idioms culturally adapted?', 'Complete — nothing omitted?'],
            },
            {
                id: 'trans-polish',
                label: '3. Cultural Polish',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'alibaba', tier: 'mid' },
                    reviewers: [{ provider: 'deepseek', tier: 'coding' }],
                },
                promptTemplate: `You are a native Chinese business communications expert. Review and elevate this translation to formal Chinese business presentation standards.

Previous translation and context:
{findings}

Focus: {focus}

Your review criteria:
1. **公文风格 authenticity** — Does this read like a real Chinese business document? Improve phrasing, sentence flow, and formal register
2. **Honorifics and respect** — Are titles, organizations, and relationships expressed with appropriate Chinese honorifics and respect language?
3. **Industry conventions** — Would a Chinese data center / technology professional find this natural and professional?
4. **Idiom quality** — Review all culturally adapted passages. Are the Chinese idioms natural and appropriate?
5. **Flow and rhythm** — Chinese business prose has a characteristic rhythm. Adjust for natural Chinese cadence

For each section, provide:
- What works well (keep)
- What needs improvement (specific changes)
- The improved Chinese text

Do NOT retranslate. Polish and elevate what exists.`,
                focusHint: 'Polish the Chinese translation to authentic formal business Chinese (公文风格). Honorifics, idioms, professional flow.',
                checklist: ['Authentic 公文风格 achieved?', 'Honorifics and respect language appropriate?', 'Industry conventions followed?', 'Idioms natural and appropriate?', 'Chinese prose rhythm natural?', 'All improvements specific and actionable?'],
            },
            {
                id: 'trans-qa',
                label: '4. QA Cross-Check',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'gemini', tier: 'mid' },
                    reviewers: [{ provider: 'deepseek', tier: 'coding' }],
                },
                promptTemplate: `You are a bilingual QA reviewer. Cross-check the Chinese translation against the original English for completeness, accuracy, and quality.

All previous work:
{findings}

Focus: {focus}

QA checklist — verify EVERY item:
1. **Completeness check** — Is every paragraph, sentence, bullet point, table row, and heading from the original present in the translation? List anything missing.
2. **Glossary adherence** — Were all glossary terms used consistently? Flag any deviations.
3. **Technical accuracy** — Are technical claims, numbers, specifications, and proper names translated correctly?
4. **Tone consistency** — Is the formal business tone consistent throughout? Flag any sections that read too casual or too academic.
5. **Cultural appropriateness** — Would anything in this translation confuse, offend, or seem strange to a target-language business audience?
6. **Structure preservation** — Are headings, lists, emphasis, and document structure preserved?

Verdict: PASS (ready for final assembly) or NEEDS FIXES (list specific items).

If NEEDS FIXES, provide the exact Chinese text corrections needed.`,
                focusHint: 'Cross-check Chinese translation against original English. Verify completeness, accuracy, glossary, tone, and cultural fit.',
                checklist: ['Completeness verified — nothing missing?', 'Glossary terms used consistently?', 'Technical accuracy confirmed?', 'Tone consistent throughout?', 'Culturally appropriate for target-language business audience?', 'Structure preserved?', 'Clear PASS/NEEDS FIXES verdict with specifics?'],
            },
            {
                id: 'trans-assembly',
                label: '5. Final Assembly',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'coding' },
                    reviewers: [{ provider: 'alibaba', tier: 'mid' }],
                },
                promptTemplate: `You are assembling the final bilingual deliverable for a formal presentation.

All previous swarm analyses and translations:
{findings}

Focus: {focus}

Produce THREE deliverables:

## 1. Bilingual Side-by-Side
Present the original English and final Chinese in parallel sections. This builds trust — the audience can verify our translation.

## 2. Clean Chinese Executive Version
A standalone Chinese document suitable for formal presentation. No English. Polished to perfection.

## 3. Translator's Notes Appendix
Document key translation decisions:
- Why specific terms were chosen (especially contested ones)
- Cultural adaptations made and why
- Any nuances that differ between languages
- Notes for the presenter about tone and emphasis

Format everything in clean Markdown. The bilingual version should be clearly sectioned with EN/ZH labels. The clean Chinese version should flow as a natural document.`,
                focusHint: 'Assemble bilingual side-by-side, clean Chinese executive version, and translator\'s notes appendix.',
                checklist: ['Bilingual version clear and well-formatted?', 'Clean Chinese version flows naturally?', 'Translator\'s notes document key decisions?', 'Cultural adaptations explained?', 'Presenter notes included?', 'All three deliverables complete?'],
                maxTokens: 32768,
            },
        ],
    },
    // 9. Standard EN→ZH Translation
    {
        id: 'convergence-translation',
        name: '⚖️ Standard EN→ZH Translation',
        description: 'Multi-model consensus EN→ZH: Flash intake → Jargon resolution → Multi-model convergence (Qwen+DeepSeek+Gemini) → Adjudication → Guardrail QA. Self-verifying — no human bilingual reviewer needed.',
        isTemplate: true,
        steps: [
            {
                id: 'conv-intake',
                label: '1. Context Intake',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'gemini', tier: 'mid' },
                },
                promptTemplate: `You are a document structure and terminology analyst preparing an English document for professional Chinese translation.

Source text:
{code}

Focus: {focus}

Your task — do NOT translate. Instead, produce a structured analysis:

## 1. Document Structure Map
List every section heading, subheading, list, table, and special formatting element. Preserve the hierarchy.

## 2. Terminology Inventory
Extract EVERY domain-specific term, technical acronym, proper name, organization name, product name, and concept. For each:
- English term
- Category (Technical | Business | Organization | Concept | Product | Legal)
- Context sentence (the sentence it appears in)
- Is it in a standard glossary? (Unknown — flag for Stage 2)

## 3. Ambiguity Flags
Identify any terms, phrases, idioms, or metaphors that could have MULTIPLE valid Chinese translations. Flag them with:
- The ambiguous text
- Possible interpretations
- Why it matters for translation

## 4. Cultural Sensitivity Flags
Identify any content that needs careful cultural handling for a target-language business audience.

Output everything as structured Markdown. This feeds directly into the translation pipeline.`,
                focusHint: 'Analyze document structure, inventory all terms, flag ambiguities and cultural sensitivities. Do NOT translate.',
                checklist: ['Document structure fully mapped?', 'All domain terms inventoried with categories?', 'Ambiguous terms flagged with interpretations?', 'Cultural sensitivities identified?', 'Output structured for downstream pipeline use?'],
                maxTokens: 16384,
            },
            {
                id: 'conv-jargon',
                label: '2. Jargon Resolution',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: `You are a technical terminology specialist resolving ambiguous terms before Chinese translation.

Previous analysis (Stage 1 — Context Intake):
{findings}

Original source text:
{code}

Focus: {focus}

Your task:

## 1. Resolve Every Ambiguous Term
For each term flagged in Stage 1, use chain-of-thought reasoning:
- What does context tell us about the intended meaning?
- Are there Chinese industry standards (GB/T, YD/T) that define the canonical translation?
- For data center / green energy terms: cross-reference GB 40879-2021 (Data Center Energy Efficiency) and related standards
- If multiple translations exist, which is most appropriate for THIS document's audience?

## 2. Build the Definitive Glossary
For EVERY term (not just ambiguous ones), produce:
| English | Chinese (简体中文) | Category | Confidence | Reasoning |
|:---|:---|:---|:---|:---|
| PUE | 电能利用效率 | Technical | ★★★★★ | GB 40879-2021 §3.1 |
| ... | ... | ... | ... | ... |

Confidence scale:
- ★★★★★ = Industry standard exists, universally accepted
- ★★★★☆ = Strong consensus among target-language professionals
- ★★★☆☆ = Multiple valid options, this is our recommendation
- ★★☆☆☆ = Uncertain, needs human review
- ★☆☆☆☆ = Best guess, flag for expert review

## 3. DNT (Do Not Translate) List
Identify terms that should REMAIN in English:
- Registered trademarks
- Product codes/version numbers
- Standards document numbers (e.g., "GB 40879-2021")
- Proper names that have no standard Chinese equivalent

## 4. First-Mention Rules
For acronyms, define the expansion rule:
- First mention in each SECTION: "PUE (电能利用效率, Power Usage Effectiveness)"
- Subsequent mentions: "PUE"

Output everything as structured Markdown. This glossary is the SINGLE SOURCE OF TRUTH for all subsequent translation stages.`,
                focusHint: 'Resolve all ambiguous terms, build definitive glossary with confidence scores, define DNT list and first-mention rules.',
                checklist: ['Every ambiguous term resolved with reasoning?', 'GB standards cross-referenced where applicable?', 'Confidence scores assigned to every term?', 'DNT list complete?', 'First-mention rules defined?', 'Glossary formatted as single source of truth?'],
                maxTokens: 16384,
            },
            {
                id: 'conv-translate',
                label: '3. Multi-Model Convergence',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'alibaba', tier: 'heavy' },
                    parallel: [
                        { provider: 'deepseek', tier: 'heavy' },
                        { provider: 'gemini', tier: 'heavy' },
                    ],
                },
                promptTemplate: `You are translating a formal business/technical document from English to Chinese (简体中文).

ALL THREE MODELS will translate the SAME text independently. Your translations will be compared for consensus. Where all three agree, confidence is highest. Where they differ, disputes will be adjudicated in the next stage.

─── RESOURCES ───

Glossary and context from previous stages:
{findings}

Original source text to translate:
{code}

Focus: {focus}

─── TRANSLATION REQUIREMENTS ───

1. **USE THE GLOSSARY** — Every term from the Definitive Glossary MUST be used exactly as specified. This is non-negotiable.

2. **DNT List** — Terms on the Do Not Translate list MUST remain in English.

3. **Tone: 公文风格** — Formal Chinese business/official document style. Professional, precise, respectful. This is for a target-language professional audience.

4. **Preserve structure** — Headings, lists, tables, paragraphs, emphasis — all structure must be preserved exactly.

5. **Technical precision** — Numbers, specifications, standards references, and proper names must be translated with absolute accuracy.

6. **Cultural naturalness** — The Chinese should read as if ORIGINALLY WRITTEN in Chinese, not translated from English. Avoid 翻译腔 (translationese).

7. **Completeness** — Translate EVERY sentence. Nothing omitted. Nothing summarized. Nothing paraphrased.

8. **First-mention rules** — Apply the first-mention expansion rules from Stage 2.

Output the COMPLETE Chinese translation. Do not include the English original except where DNT terms or first-mention expansions require it.`,
                focusHint: 'Translate the ENTIRE source text into formal Chinese using the definitive glossary. Native fluency, technical precision, cultural naturalness.',
                checklist: ['Every glossary term used exactly as specified?', 'DNT terms preserved in English?', 'Formal 公文风格 tone throughout?', 'All structure preserved?', 'Technical specifications accurate?', 'Reads like native Chinese, not translationese?', 'Complete — nothing omitted?', 'First-mention rules applied?'],
                maxTokens: 32768,
            },
            {
                id: 'conv-adjudicate',
                label: '4. Adjudication',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    reviewers: [
                        { provider: 'alibaba', tier: 'heavy' },
                        { provider: 'gemini', tier: 'heavy' },
                    ],
                },
                promptTemplate: `You are the chief adjudicator for a multi-model translation consensus system.

Three independent AI models (Qwen 3.7 Max, DeepSeek V4 Pro, Gemini 3.1 Pro) have each translated the same English document into Chinese. Your job: compare all three, identify disagreements, and produce the SINGLE BEST translation.

─── INPUTS ───

All previous stage outputs (glossary, jargon resolution, and ALL THREE translations):
{findings}

─── ADJUDICATION PROCESS ───

## Step 1: Identify Agreement Zones
Where do all three translations agree? These are ★★★★★ high-confidence segments. Mark them as CONFIRMED.

## Step 2: Identify Disagreements
Where do the translations differ? For EACH disagreement:
- Quote the differing translations side-by-side
- Classify the disagreement type:
  - TERMINOLOGY: Different Chinese terms used for the same concept
  - STRUCTURE: Different sentence/paragraph organization
  - TONE: Different formality register
  - CULTURAL: Different cultural adaptation choices
  - OMISSION: One model missed content another included
- Cross-reference against the Definitive Glossary
- Cross-reference against GB standards where applicable

## Step 3: Adjudicate Each Disagreement
For each dispute, provide:
- **Ruling**: Which translation is correct (or synthesize a better one)
- **Reasoning**: Why — citing glossary, GB standards, Chinese business conventions
- **Confidence**: ★★★★★ to ★☆☆☆☆ for THIS specific segment
- **Model Attribution**: Which model(s) got it right

## Step 4: Produce the Unified Translation
Assemble all confirmed + adjudicated segments into ONE complete, polished Chinese translation.

## Step 5: Produce the Confidence Report
For every section/paragraph, assign a confidence score based on model agreement:
- ★★★★★ = All 3 models agree
- ★★★★☆ = 2 models agree, 3rd had minor stylistic difference
- ★★★☆☆ = 2 models agree, 3rd had meaningful difference (adjudicated)
- ★★☆☆☆ = Models split, adjudication was challenging
- ★☆☆☆☆ = Significant disagreement, recommend HUMAN REVIEW

Output format:
1. First: The unified Chinese translation (complete, polished)
2. Then: ## Adjudication Log (all disputes and rulings)
3. Finally: ## Confidence Report (per-section scores with explanations)`,
                focusHint: 'Compare all 3 translations, identify and classify disagreements, adjudicate each dispute, produce unified translation with confidence scores.',
                checklist: ['All 3 translations compared thoroughly?', 'All agreement zones identified?', 'Every disagreement classified by type?', 'Each dispute adjudicated with reasoning?', 'Glossary and GB standards cross-referenced in rulings?', 'Unified translation assembled correctly?', 'Confidence scores assigned to every section?', 'Low-confidence segments flagged for human review?'],
                maxTokens: 32768,
            },
            {
                id: 'conv-guardrail',
                label: '5. Guardrail QA',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    reviewers: [{ provider: 'alibaba', tier: 'heavy' }],
                },
                promptTemplate: `You are the FINAL guardrail reviewer for a target-language business translation. This is the last stage before delivery. Your review determines if the translation is safe, compliant, and publication-ready for a target audience.

─── INPUTS ───

All previous stages including the adjudicated translation and confidence report:
{findings}

─── GUARDRAIL CHECKS ───

## 1. Compliance Check
- Does the translation comply with local regulations and sensitivities?
- Are there any politically sensitive phrasings that need adjustment?
- Are references to geopolitical references handled with regional accuracy?
- Are any organizational names or titles expressed with appropriate respect?

## 2. Cultural Taboo Check
- Would ANYTHING in this translation confuse, offend, or seem strange to a target-language business audience?
- Are there unintended negative connotations in any word choices?
- Are numbers, colors, or symbols used in ways that might have unintended cultural meanings?

## 3. Terminology Final Audit
- Spot-check: Are glossary terms used consistently throughout?
- DNT list compliance: Are all DNT terms still in English?
- First-mention rules: Are acronyms expanded correctly on first use per section?

## 4. Tone & Register
- Is the 公文风格 (formal business document style) consistent throughout?
- Are honorifics and respect language appropriate?
- Does the document read as if ORIGINALLY WRITTEN by a native Chinese business professional?

## 5. Structure & Completeness
- Compare against the original English: is every section, paragraph, list item, and table present?
- Are headings, numbering, and formatting preserved?
- Are cross-references and citations intact?

─── OUTPUT ───

## Final Translation
The complete, finalized Chinese text. Publication-ready.

## Guardrail Report
- Compliance: PASS / ADJUSTED (list changes)
- Cultural Safety: PASS / ADJUSTED (list changes)
- Terminology Audit: PASS / ISSUES FOUND (list them)
- Tone & Register: PASS / NOTES
- Structure: PASS / GAPS FOUND (list them)

## Executive Summary
One paragraph summarizing the translation quality, any adjustments made, and the overall confidence level for publication without human bilingual review.`,
                focusHint: 'Final guardrail QA: compliance, cultural safety, terminology audit, tone review, structure verification. Publication-ready output.',
                checklist: ['Compliance checked against mainland regulations?', 'Cultural taboos screened?', 'Terminology spot-checked for consistency?', 'DNT list compliance verified?', 'First-mention rules confirmed?', '公文风格 tone consistent?', 'Structure and completeness verified against original?', 'Executive summary with publication confidence level?'],
                maxTokens: 32768,
            },
        ],
    },
    // 9b. Faithful EN→ZH Translation (Literal Mode — no enhancements)
    {
        id: 'convergence-translation-literal',
        name: '📋 Faithful EN→ZH Translation',
        description: 'STRICT translation: EN→ZH with multi-model consensus. Identical pipeline to Standard EN→ZH, but Guardrail QA verifies fidelity ONLY — no content enhancements, no metric changes, no version bumps. For formal submissions where the source document must not be modified.',
        isTemplate: true,
        steps: [
            {
                id: 'conv-lit-intake',
                label: '1. Context Intake',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'gemini', tier: 'mid' },
                },
                promptTemplate: `You are a document structure and terminology analyst preparing an English document for professional Chinese translation.

Source text:
{code}

Focus: {focus}

Your task — do NOT translate. Instead, produce a structured analysis:

## 1. Document Structure Map
List every section heading, subheading, list, table, and special formatting element. Preserve the hierarchy.

## 2. Terminology Inventory
Extract EVERY domain-specific term, technical acronym, proper name, organization name, product name, and concept. For each:
- English term
- Category (Technical | Business | Organization | Concept | Product | Legal)
- Context sentence (the sentence it appears in)
- Is it in a standard glossary? (Unknown — flag for Stage 2)

## 3. Ambiguity Flags
Identify any terms, phrases, idioms, or metaphors that could have MULTIPLE valid Chinese translations. Flag them with:
- The ambiguous text
- Possible interpretations
- Why it matters for translation

## 4. Cultural Sensitivity Flags
Identify any content that needs careful cultural handling for a target-language business audience.

Output everything as structured Markdown. This feeds directly into the translation pipeline.`,
                focusHint: 'Analyze document structure, inventory all terms, flag ambiguities and cultural sensitivities. Do NOT translate.',
                checklist: ['Document structure fully mapped?', 'All domain terms inventoried with categories?', 'Ambiguous terms flagged with interpretations?', 'Cultural sensitivities identified?', 'Output structured for downstream pipeline use?'],
                maxTokens: 16384,
            },
            {
                id: 'conv-lit-jargon',
                label: '2. Jargon Resolution',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: `You are a technical terminology specialist resolving ambiguous terms before Chinese translation.

Previous analysis (Stage 1 — Context Intake):
{findings}

Original source text:
{code}

Focus: {focus}

Your task:

## 1. Resolve Every Ambiguous Term
For each term flagged in Stage 1, use chain-of-thought reasoning:
- What does context tell us about the intended meaning?
- Are there Chinese industry standards (GB/T, YD/T) that define the canonical translation?
- For data center / green energy terms: cross-reference GB 40879-2021 (Data Center Energy Efficiency) and related standards
- If multiple translations exist, which is most appropriate for THIS document's audience?

## 2. Build the Definitive Glossary
For EVERY term (not just ambiguous ones), produce:
| English | Chinese (简体中文) | Category | Confidence | Reasoning |
|:---|:---|:---|:---|:---|
| PUE | 电能利用效率 | Technical | ★★★★★ | GB 40879-2021 §3.1 |
| ... | ... | ... | ... | ... |

Confidence scale:
- ★★★★★ = Industry standard exists, universally accepted
- ★★★★☆ = Strong consensus among target-language professionals
- ★★★☆☆ = Multiple valid options, this is our recommendation
- ★★☆☆☆ = Uncertain, needs human review
- ★☆☆☆☆ = Best guess, flag for expert review

## 3. DNT (Do Not Translate) List
Identify terms that should REMAIN in English:
- Registered trademarks
- Product codes/version numbers
- Standards document numbers (e.g., "GB 40879-2021")
- Proper names that have no standard Chinese equivalent

## 4. First-Mention Rules
For acronyms, define the expansion rule:
- First mention in each SECTION: "PUE (电能利用效率, Power Usage Effectiveness)"
- Subsequent mentions: "PUE"

Output everything as structured Markdown. This glossary is the SINGLE SOURCE OF TRUTH for all subsequent translation stages.`,
                focusHint: 'Resolve all ambiguous terms, build definitive glossary with confidence scores, define DNT list and first-mention rules.',
                checklist: ['Every ambiguous term resolved with reasoning?', 'GB standards cross-referenced where applicable?', 'Confidence scores assigned to every term?', 'DNT list complete?', 'First-mention rules defined?', 'Glossary formatted as single source of truth?'],
                maxTokens: 16384,
            },
            {
                id: 'conv-lit-translate',
                label: '3. Multi-Model Convergence',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'alibaba', tier: 'heavy' },
                    parallel: [
                        { provider: 'deepseek', tier: 'heavy' },
                        { provider: 'gemini', tier: 'heavy' },
                    ],
                },
                promptTemplate: `You are translating a formal business/technical document from English to Chinese (简体中文). This is a FAITHFUL TRANSLATION — translate exactly what the source says. Do not add, remove, or modify any content.

ALL THREE MODELS will translate the SAME text independently. Your translations will be compared for consensus. Where all three agree, confidence is highest. Where they differ, disputes will be adjudicated in the next stage.

─── RESOURCES ───

Glossary and context from previous stages:
{findings}

Original source text to translate:
{code}

Focus: {focus}

─── TRANSLATION REQUIREMENTS ───

1. **USE THE GLOSSARY** — Every term from the Definitive Glossary MUST be used exactly as specified. This is non-negotiable.

2. **DNT List** — Terms on the Do Not Translate list MUST remain in English.

3. **Tone: 公文风格** — Formal Chinese business/official document style. Professional, precise, respectful. This is for a target-language professional audience.

4. **Preserve structure** — Headings, lists, tables, paragraphs, emphasis — all structure must be preserved exactly.

5. **Technical precision** — Numbers, specifications, standards references, and proper names must be translated with absolute accuracy. DO NOT change any numerical values, percentages, formulas, fund amounts, employment targets, or version numbers.

6. **Cultural naturalness** — The Chinese should read as if ORIGINALLY WRITTEN in Chinese, not translated from English. Avoid 翻译腔 (translationese).

7. **Completeness** — Translate EVERY sentence. Nothing omitted. Nothing summarized. Nothing paraphrased.

8. **First-mention rules** — Apply the first-mention expansion rules from Stage 2.

9. **NO ENHANCEMENTS** — This is a literal/faithful translation. Do NOT add missing requirements, improve metrics, or fill perceived gaps. If something seems incomplete in the original, TRANSLATE IT AS-IS.

Output the COMPLETE Chinese translation. Do not include the English original except where DNT terms or first-mention expansions require it.`,
                focusHint: 'FAITHFUL translation — translate exactly, no additions, no improvements, no metric changes. Native fluency, technical precision.',
                checklist: ['Every glossary term used exactly as specified?', 'DNT terms preserved in English?', 'Formal 公文风格 tone throughout?', 'All structure preserved?', 'Technical specifications accurate and UNCHANGED?', 'Reads like native Chinese, not translationese?', 'Complete — nothing omitted?', 'First-mention rules applied?', 'NO content added or modified beyond translation?'],
                maxTokens: 32768,
            },
            {
                id: 'conv-lit-adjudicate',
                label: '4. Adjudication',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    reviewers: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: `You are the chief adjudicator for a multi-model Chinese translation. Three independent models have translated the same document. Your job: compare, resolve disagreements, and produce ONE unified translation with confidence scores.

─── INPUTS ───

All previous stages:
{findings}

─── ADJUDICATION WORKFLOW ───

## 1. Three-Way Comparison
Read all three translations carefully. Identify:
- **Agreement zones**: where all three match (high confidence)
- **Minor variation**: same meaning, different wording (medium confidence)
- **Meaning divergence**: different interpretations (low confidence — needs ruling)
- **Error zones**: one model clearly wrong (correctable)

## 2. Dispute Classification
Classify every divergence:
- **Glossary dispute**: term translation (resolve using glossary from Stage 2)
- **Tone dispute**: formality level, register
- **Structure dispute**: heading/section/layout differences
- **Semantic dispute**: different understanding of the source

## 3. Adjudication Rules (in priority order)
1. Glossary from Stage 2 is authoritative — use it.
2. Chinese industry standards (GB/T, YD/T) take precedence for technical terms.
3. Where consensus exists (2/3 or 3/3 agree), use the majority translation.
4. Where all three disagree AND no glossary exists, choose the most technically precise option.
5. Where cultural sensitivity is at stake, prefer the SAFER option.
6. **Do NOT introduce new content, add requirements, or modify metrics.** Translate what exists, nothing more.

## 4. Confidence Scoring
Score every section (H2 heading and its content) on a scale:
- ★★★★★ 95-100%: all three agree, glossary confirms, no disputes
- ★★★★☆ 85-94%: minor wording variations, meaning preserved
- ★★★☆☆ 70-84%: at least one disagreement resolved by glossary/rules
- ★★☆☆☆ 50-69%: significant interpretation difference, adjudication needed
- ★☆☆☆☆ <50%: fundamental disagreement, flag for HUMAN REVIEW

─── OUTPUT ───

1. First: The unified Chinese translation (complete, polished, FAITHFUL — no enhancements)
2. Then: ## Adjudication Log (all disputes and rulings)
3. Finally: ## Confidence Report (per-section scores with explanations)`,
                focusHint: 'Compare all 3 translations, identify and classify disagreements, adjudicate each dispute, produce faithful unified translation with confidence scores.',
                checklist: ['All 3 translations compared thoroughly?', 'All agreement zones identified?', 'Every disagreement classified by type?', 'Each dispute adjudicated with reasoning?', 'Glossary and GB standards cross-referenced in rulings?', 'Unified translation assembled correctly — NO enhancements?', 'Confidence scores assigned to every section?', 'Low-confidence segments flagged for human review?'],
                maxTokens: 32768,
            },
            {
                id: 'conv-lit-guardrail',
                label: '5. Fidelity Guardrail',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    reviewers: [{ provider: 'alibaba', tier: 'heavy' }],
                },
                promptTemplate: `You are the FINAL FIDELITY VERIFIER for a Chinese translation. Your ONLY job is to verify that the Chinese text is a faithful, accurate, and complete translation of the English original. You are NOT an editor, NOT an improver, NOT a subject-matter expert adding value. You are a TRANSLATION ACCURACY AUDITOR.

─── INPUTS ───

All previous stages including the adjudicated translation and confidence report:
{findings}

─── FIDELITY VERIFICATION (NOT enhancement) ───

## 1. Accuracy Audit
- Are ALL numerical values (percentages, dollar amounts, MW ratings, dates, version numbers) IDENTICAL to the original? Flag ANY deviation, even if the new value seems "better."
- Are ALL formulas and calculations (e.g., "2% of gross revenue") preserved EXACTLY as written in the original?
- Are ALL compliance tier requirements present at the same thresholds as the original?

## 2. Completeness Audit
- Is every section, paragraph, bullet point, and table row from the original present in the translation?
- Are any sections condensed, summarized, or paraphrased?
- Are any sections ADDED that don't exist in the original?

## 3. Compliance Check (translation accuracy only)
- Does the translation comply with local regulations in how it EXPRESSES the original content?
- Are there any politically sensitive phrasings that need adjustment?
- Are references to Taiwan, Hong Kong, Tibet, or other sensitive topics handled correctly?

## 4. Structure & Formatting
- Are headings, numbering, and formatting preserved EXACTLY?
- Are cross-references and citations intact?
- Are units of measurement preserved (miles stay miles, dollars stay dollars)?

## 5. Enhancement Watch — CRITICAL
- **Any content not present in the English original is a TRANSLATION ERROR**, not an improvement.
- Flag as ERRORS: added requirements, changed metrics, version bumps, "improved" formulas, new compliance tiers, additional footnotes, regulatory commentary.
- If you believe something is genuinely missing from the original, put it in a separate **"Author's Review Notes"** section — do NOT add it to the translation.

─── OUTPUT ───

## Final Translation
The complete, finalized Chinese text. MUST be faithful to the original in content, metrics, and structure.

## Fidelity Report
- Numerical Accuracy: PASS / DEVIATIONS FOUND (list every deviation)
- Completeness: PASS / GAPS or ADDITIONS (list them)
- Enhancement Watch: PASS / CONTENT ADDED (list every addition)
- Compliance: PASS / ADJUSTED (list only phrasing adjustments, not content changes)
- Structure: PASS / ISSUES (list them)

## Author's Review Notes (if applicable)
Any observations about the original document that the author may want to consider — presented SEPARATELY, not integrated into the translation.`,
                focusHint: 'VERIFY ONLY — no improvements, no additions. Check every number against original. Flag any deviation as an error. Separate review suggestions from the translation.',
                checklist: ['All numerical values verified against original?', 'No content added beyond what exists in original?', 'No metrics/formulas/thresholds changed?', 'No version bump?', 'Compliance checked (phrasing only)?', 'Structure preserved exactly?', 'Enhancement Watch: any additions flagged as errors?', "Author's Review Notes separated from translation?"],
                maxTokens: 32768,
            },
        ],
    },
    // 10. Bilingual Document
    {
        id: 'semantic-compilation',
        name: '📦 Bilingual Document',
        description: 'Docs-as-code: EN→ZH converge + compile bilingual deliverable with YAML frontmatter, glossary, and budget report. Outputs EN/ZH side-by-side + clean ZH to out/.',
        isTemplate: true,
        steps: [
            {
                id: 'sem-intake',
                label: '1. Context Intake',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'gemini', tier: 'mid' },
                },
                promptTemplate: `You are a document structure and terminology analyst preparing an English document for professional Chinese translation.

Source text:
{code}

Focus: {focus}

Your task — do NOT translate. Instead, produce a structured analysis:

## 1. Document Structure Map
List every section heading, subheading, list, table, and special formatting element. Preserve the hierarchy.

## 2. Terminology Inventory
Extract EVERY domain-specific term, technical acronym, proper name, organization name, product name, and concept. For each:
- English term
- Category (Technical | Business | Organization | Concept | Product | Legal)
- Context sentence (the sentence it appears in)
- Is it in a standard glossary? (Unknown — flag for Stage 2)

## 3. Ambiguity Flags
Identify any terms, phrases, idioms, or metaphors that could have MULTIPLE valid Chinese translations. Flag them with:
- The ambiguous text
- Possible interpretations
- Why it matters for translation

## 4. Cultural Sensitivity Flags
Identify any content that needs careful cultural handling for a target-language business audience.

Output everything as structured Markdown. This feeds directly into the compilation pipeline.`,
                focusHint: 'Analyze document structure, inventory all terms, flag ambiguities and cultural sensitivities. Do NOT translate.',
                checklist: ['Document structure fully mapped?', 'All domain terms inventoried with categories?', 'Ambiguous terms flagged with interpretations?', 'Cultural sensitivities identified?', 'Output structured for downstream pipeline use?'],
                maxTokens: 16384,
            },
            {
                id: 'sem-jargon',
                label: '2. Jargon Resolution',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    parallel: [{ provider: 'gemini', tier: 'mid' }],
                },
                promptTemplate: `You are a technical terminology specialist resolving ambiguous terms before Chinese translation.

Previous analysis (Stage 1 — Context Intake):
{findings}

Original source text:
{code}

Focus: {focus}

Your task:

## 1. Resolve Every Ambiguous Term
For each term flagged in Stage 1, use chain-of-thought reasoning:
- What does context tell us about the intended meaning?
- Are there Chinese industry standards (GB/T, YD/T) that define the canonical translation?
- For data center / green energy terms: cross-reference GB 40879-2021 (Data Center Energy Efficiency) and related standards
- If multiple translations exist, which is most appropriate for THIS document's audience?

## 2. Build the Definitive Glossary
For EVERY term (not just ambiguous ones), produce:
| English | Chinese (简体中文) | Category | Confidence | Reasoning |
|:---|:---|:---|:---|:---|
| PUE | 电能利用效率 | Technical | ★★★★★ | GB 40879-2021 §3.1 |
| ... | ... | ... | ... | ... |

Confidence scale:
- ★★★★★ = Industry standard exists, universally accepted
- ★★★★☆ = Strong consensus among target-language professionals
- ★★★☆☆ = Multiple valid options, this is our recommendation
- ★★☆☆☆ = Uncertain, needs human review
- ★☆☆☆☆ = Best guess, flag for expert review

## 3. DNT (Do Not Translate) List
Identify terms that should REMAIN in English:
- Registered trademarks
- Product codes/version numbers
- Standards document numbers (e.g., "GB 40879-2021")
- Proper names that have no standard Chinese equivalent

## 4. First-Mention Rules
For acronyms, define the expansion rule:
- First mention in each SECTION: "PUE (电能利用效率, Power Usage Effectiveness)"
- Subsequent mentions: "PUE"

Output everything as structured Markdown. This glossary is the SINGLE SOURCE OF TRUTH for all subsequent compilation stages.`,
                focusHint: 'Resolve all ambiguous terms, build definitive glossary with confidence scores, define DNT list and first-mention rules.',
                checklist: ['Every ambiguous term resolved with reasoning?', 'GB standards cross-referenced where applicable?', 'Confidence scores assigned to every term?', 'DNT list complete?', 'First-mention rules defined?', 'Glossary formatted as single source of truth?'],
                maxTokens: 16384,
            },
            {
                id: 'sem-translate',
                label: '3. Multi-Model Convergence',
                mode: 'thorough',
                providers: {
                    primary: { provider: 'alibaba', tier: 'heavy' },
                    parallel: [
                        { provider: 'deepseek', tier: 'heavy' },
                        { provider: 'gemini', tier: 'heavy' },
                    ],
                },
                promptTemplate: `You are translating a formal business/technical document from English to Chinese (简体中文).

ALL THREE MODELS will translate the SAME text independently. Your translations will be compared for consensus.

─── RESOURCES ───

Glossary and context from previous stages:
{findings}

Original source text to translate:
{code}

Focus: {focus}

─── TRANSLATION REQUIREMENTS ───

1. **USE THE GLOSSARY** — Every term from the Definitive Glossary MUST be used exactly as specified.

2. **DNT List** — Terms on the Do Not Translate list MUST remain in English.

3. **Tone: 公文风格** — Formal Chinese business/official document style.

4. **Preserve structure** — Headings, lists, tables, paragraphs, emphasis.

5. **Technical precision** — Numbers, specifications, standards references, and proper names must be translated with absolute accuracy.

6. **Cultural naturalness** — The Chinese should read as if ORIGINALLY WRITTEN in Chinese, not translated from English. Avoid 翻译腔 (translationese).

7. **Completeness** — Translate EVERY sentence. Nothing omitted. Nothing summarized.

8. **First-mention rules** — Apply the first-mention expansion rules from Stage 2.

Output the COMPLETE Chinese translation.`,
                focusHint: 'Translate the ENTIRE source text into formal Chinese using the definitive glossary.',
                checklist: ['Every glossary term used exactly as specified?', 'DNT terms preserved in English?', 'Formal 公文风格 tone throughout?', 'All structure preserved?', 'Technical specifications accurate?', 'Reads like native Chinese?', 'Complete — nothing omitted?'],
                maxTokens: 32768,
            },
            {
                id: 'sem-adjudicate',
                label: '4. Adjudication',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    reviewers: [
                        { provider: 'alibaba', tier: 'heavy' },
                        { provider: 'gemini', tier: 'heavy' },
                    ],
                },
                promptTemplate: `You are the chief adjudicator for a multi-model translation consensus system.

Three independent AI models have each translated the same English document into Chinese. Your job: compare all three, identify disagreements, and produce the SINGLE BEST translation.

─── INPUTS ───

All previous stage outputs (glossary, jargon resolution, and ALL THREE translations):
{findings}

─── ADJUDICATION PROCESS ───

## Step 1: Identify Agreement Zones
Where do all three translations agree? These are ★★★★★ high-confidence segments. Mark them as CONFIRMED.

## Step 2: Identify Disagreements
For EACH disagreement:
- Quote the differing translations side-by-side
- Classify: TERMINOLOGY / STRUCTURE / TONE / CULTURAL / OMISSION
- Cross-reference against the Definitive Glossary
- Cross-reference against GB standards where applicable

## Step 3: Adjudicate Each Disagreement
For each dispute, produce:
- The RECOMMENDED Chinese text
- Reasoning: which model was right and why
- Confidence: 1-5 stars

## Step 4: Produce the Consolidated Translation
The SINGLE BEST Chinese translation combining all adjudicated decisions.

## Step 5: Confidence Report
| Section | Agreement | Confidence | Notes |
|:---|:---|:---|:---|

## Step 6: Overconfidence Self-Check
Before finalizing, answer honestly:
- Are there any translations where we are GUESSING rather than KNOWING?
- Are there any passages a native Chinese speaker would still flag?
- Is the claim "ready to publish without human bilingual review" honest?

Output everything as structured Markdown.`,
                focusHint: 'Compare all three translations, adjudicate every disagreement, produce consolidated best translation with confidence report.',
                checklist: ['All three translations compared?', 'Every disagreement identified and classified?', 'Each dispute adjudicated with reasoning?', 'Consolidated translation complete?', 'Confidence report accurate?', 'Honest overconfidence self-check?'],
                maxTokens: 32768,
            },
            {
                id: 'sem-compile',
                label: '5. Bilingual Compilation',
                mode: 'scrutinize',
                providers: {
                    primary: { provider: 'deepseek', tier: 'heavy' },
                    reviewers: [{ provider: 'alibaba', tier: 'heavy' }],
                },
                promptTemplate: `You are compiling the final bilingual deliverable for docs-as-code publication.

All previous stage outputs (glossary, translations, adjudication):
{findings}

Original English source:
{code}

Focus: {focus}

Produce a structured bilingual compilation:

## 1. YAML Frontmatter (bilingual)
Extract or create frontmatter with title, author, date, version, and description in BOTH languages.

## 2. Bilingual Side-by-Side
Present each section with English original followed by Chinese translation. Use clear EN/ZH labels.

## 3. Glossary Appendix
The definitive glossary table with all terms, Chinese translations, confidence scores, and reasoning.

## 4. Compilation Notes
- Key translation decisions
- Cultural adaptations and why
- Any sections flagged for human review
- Character budget compliance

Output everything in clean, publishable Markdown with proper YAML frontmatter.`,
                focusHint: 'Compile bilingual deliverable with YAML frontmatter, side-by-side EN/ZH, glossary appendix, and compilation notes.',
                checklist: ['YAML frontmatter bilingual?', 'Side-by-side EN/ZH clear?', 'Glossary appendix complete?', 'Compilation notes thorough?', 'Output publishable as-is?'],
                maxTokens: 32768,
            },
        ],
    },
];

// ── Provider Strategy ─────────────────────────────────────────────

export type ProviderStrategy = 'cost-optimized' | 'balanced' | 'maximum-quality';

export interface StrategyPreset {
    id: ProviderStrategy;
    name: string;
    description: string;
    costLabel: string;
    costWarning?: string;
    /** Step ID → provider overrides. Applied per-step before execution. */
    overrides: Record<string, {
        primary?: ProviderTier;
        parallel?: ProviderTier[];
        reviewers?: ProviderTier[];
    }>;
}

/**
 * Provider strategy presets.
 *
 * Cost-Optimized: DeepSeek primary everywhere, Gemini + Qwen for visual steps, lowest cost.
 * Balanced: Best per role — Gemini + Qwen for visual/aesthetics, DeepSeek for technical, Qwen for cross-review.
 * Maximum Quality: Pro/heavy tiers everywhere, ALL providers called on every step. ⚠️ Significant cost.
 */
export const PROVIDER_STRATEGIES: Record<ProviderStrategy, StrategyPreset> = {
    'cost-optimized': {
        id: 'cost-optimized',
        name: '●○○ Cost-Optimized',
        description: 'DeepSeek primary everywhere, Gemini + Qwen for visual. Light tiers, low cost.',
        costLabel: '●○○ Low',
        overrides: {
            'design-aesthetics': { primary: { provider: 'deepseek', tier: 'coding' }, parallel: [{ provider: 'gemini', tier: 'mid' }] },
            'design-ux': { primary: { provider: 'deepseek', tier: 'coding' }, parallel: [{ provider: 'gemini', tier: 'mid' }] },
            'design-technical': { primary: { provider: 'deepseek', tier: 'coding' }, parallel: [{ provider: 'alibaba', tier: 'mid' }] },
            'design-synthesis': { primary: { provider: 'deepseek', tier: 'coding' }, reviewers: [{ provider: 'gemini', tier: 'mid' }] },
            // Convergence Translation — degraded (not recommended)
            'conv-intake': { primary: { provider: 'gemini', tier: 'light' } },
            'conv-jargon': { primary: { provider: 'deepseek', tier: 'mid' } },
            'conv-translate': { primary: { provider: 'alibaba', tier: 'mid' }, parallel: [{ provider: 'deepseek', tier: 'mid' }] },
            'conv-adjudicate': { primary: { provider: 'deepseek', tier: 'mid' }, reviewers: [{ provider: 'alibaba', tier: 'mid' }] },
            'conv-guardrail': { primary: { provider: 'deepseek', tier: 'mid' } },
        },
    },
    'balanced': {
        id: 'balanced',
        name: '●●○ Balanced',
        description: 'Best per role: Gemini + Qwen for visual, DeepSeek for technical, Qwen for cross-review. Mid tiers.',
        costLabel: '●●○ Medium',
        overrides: {
            'design-aesthetics': { primary: { provider: 'gemini', tier: 'mid' }, parallel: [{ provider: 'deepseek', tier: 'mid' }, { provider: 'alibaba', tier: 'mid' }] },
            'design-ux': { primary: { provider: 'deepseek', tier: 'coding' }, parallel: [{ provider: 'gemini', tier: 'mid' }] },
            'design-technical': { primary: { provider: 'deepseek', tier: 'coding' }, parallel: [{ provider: 'alibaba', tier: 'mid' }] },
            'design-synthesis': { primary: { provider: 'deepseek', tier: 'coding' }, reviewers: [{ provider: 'gemini', tier: 'mid' }, { provider: 'alibaba', tier: 'mid' }] },
            // Convergence Translation
            'conv-intake': { primary: { provider: 'gemini', tier: 'mid' } },
            'conv-jargon': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'mid' }] },
            'conv-translate': { primary: { provider: 'alibaba', tier: 'heavy' }, parallel: [{ provider: 'deepseek', tier: 'heavy' }, { provider: 'gemini', tier: 'mid' }] },
            'conv-adjudicate': { primary: { provider: 'deepseek', tier: 'heavy' }, reviewers: [{ provider: 'alibaba', tier: 'mid' }, { provider: 'gemini', tier: 'mid' }] },
            'conv-guardrail': { primary: { provider: 'deepseek', tier: 'heavy' }, reviewers: [{ provider: 'alibaba', tier: 'mid' }] },
        },
    },
    'maximum-quality': {
        id: 'maximum-quality',
        name: '●●● Maximum Quality ⚠️',
        description: 'Pro/heavy tiers, ALL providers called on every step. High cost — critical work only.',
        costLabel: '●●● Significant',
        costWarning: '⚠️ Maximum Quality uses heavy/pro tiers on all steps with full reviewer panels. Estimated cost is significantly higher than other strategies.',
        overrides: {
            // Sequential Design Review
            'design-aesthetics': { primary: { provider: 'gemini', tier: 'heavy' }, parallel: [{ provider: 'deepseek', tier: 'heavy' }, { provider: 'alibaba', tier: 'mid' }] },
            'design-ux': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'heavy' }] },
            'design-technical': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'alibaba', tier: 'heavy' }] },
            'design-synthesis': { primary: { provider: 'deepseek', tier: 'heavy' }, reviewers: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'alibaba', tier: 'heavy' }] },
            // Website Analysis
            'wa-design': { primary: { provider: 'gemini', tier: 'heavy' }, parallel: [{ provider: 'deepseek', tier: 'heavy' }, { provider: 'alibaba', tier: 'mid' }] },
            'wa-accessibility': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'alibaba', tier: 'mid' }] },
            'wa-performance': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'heavy' }] },
            'wa-content': { primary: { provider: 'alibaba', tier: 'heavy' }, parallel: [{ provider: 'deepseek', tier: 'heavy' }, { provider: 'gemini', tier: 'mid' }] },
            'wa-synthesis': { primary: { provider: 'deepseek', tier: 'heavy' }, reviewers: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'alibaba', tier: 'heavy' }] },
            // Translation
            'trans-glossary': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'alibaba', tier: 'mid' }] },
            'trans-bulk': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'alibaba', tier: 'mid' }] },
            'trans-polish': { primary: { provider: 'alibaba', tier: 'heavy' }, reviewers: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'deepseek', tier: 'heavy' }] },
            'trans-qa': { primary: { provider: 'gemini', tier: 'heavy' }, reviewers: [{ provider: 'deepseek', tier: 'heavy' }] },
            'trans-assembly': { primary: { provider: 'deepseek', tier: 'heavy' }, reviewers: [{ provider: 'gemini', tier: 'heavy' }, { provider: 'alibaba', tier: 'heavy' }] },
            // Convergence Translation — minimum Balanced recommended
            'conv-intake': { primary: { provider: 'gemini', tier: 'mid' } },
            'conv-jargon': { primary: { provider: 'deepseek', tier: 'heavy' }, parallel: [{ provider: 'gemini', tier: 'mid' }] },
            'conv-translate': { primary: { provider: 'alibaba', tier: 'heavy' }, parallel: [{ provider: 'deepseek', tier: 'heavy' }, { provider: 'gemini', tier: 'heavy' }] },
            'conv-adjudicate': { primary: { provider: 'deepseek', tier: 'heavy' }, reviewers: [{ provider: 'alibaba', tier: 'heavy' }, { provider: 'gemini', tier: 'heavy' }] },
            'conv-guardrail': { primary: { provider: 'deepseek', tier: 'heavy' }, reviewers: [{ provider: 'alibaba', tier: 'heavy' }] },
        },
    },
};

export function getStrategyPreset(strategy: ProviderStrategy): StrategyPreset {
    return PROVIDER_STRATEGIES[strategy];
}

export function applyStrategy(pipeline: DeepSwarmPipeline, strategy: ProviderStrategy): DeepSwarmPipeline {
    const preset = PROVIDER_STRATEGIES[strategy];
    if (!preset) return pipeline;

    const overriddenSteps = pipeline.steps.map(step => {
        const override = preset.overrides[step.id];
        if (!override) return step;
        return {
            ...step,
            providers: {
                primary: override.primary ?? step.providers.primary,
                parallel: override.parallel ?? step.providers.parallel,
                reviewers: override.reviewers ?? step.providers.reviewers,
            },
        };
    });

    return { ...pipeline, steps: overriddenSteps };
}

// ── Lookup ────────────────────────────────────────────────────────

export function getTemplateById(id: string): DeepSwarmPipeline | undefined {
    return PIPELINE_TEMPLATES.find(t => t.id === id);
}

export function listTemplateIds(): { id: string; name: string; description: string }[] {
    return PIPELINE_TEMPLATES.map(t => ({ id: t.id, name: t.name, description: t.description }));
}

// ── Step Execution ────────────────────────────────────────────────

// ── Retry helpers ──────────────────────────────────────────────

/** Error messages that indicate a transient failure worth retrying. */
const TRANSIENT_PATTERNS: RegExp[] = [
    /\bterminated\b/i,         // Connection dropped mid-stream
    /\bECONNRESET\b/i,         // TCP reset
    /\bETIMEDOUT\b/i,          // Socket timeout
    /\babort(?:ed)?\b/i,       // AbortError / operation aborted
    /\bsocket hang up\b/i,     // Connection hangup
    /\b5\d{2}\b/,              // HTTP 500-599 server errors
    /\b429\b/,                 // Rate limit (worth retrying after backoff)
    /\bnetwork\s+error\b/i,    // Generic network error
    /\bTLS\s+error\b/i,        // TLS/SSL transient failure
];

function isTransient(err: Error): boolean {
    const msg = err.message ?? '';
    return TRANSIENT_PATTERNS.some(p => p.test(msg));
}

// ── Prompt Truncation ─────────────────────────────────────────────

/** Maximum prompt size in characters before truncation kicks in.
 *  80KB ≈ 20K tokens — above this, models slow down and error risk increases.
 *  For convergence pipelines (source doc + Stage 1 findings + jargon instructions),
 *  prompts routinely hit 30-50KB. */
const MAX_PROMPT_CHARS = 80_000;

/** Soft ceiling — above 120KB, we drop the middle aggressively. */
const SOFT_CEILING_CHARS = 120_000;

/**
 * Truncate an oversized prompt while preserving the most important parts.
 * Strategy:
 *   - Keep the first 30% (setup / instructions / role / checklist)
 *   - Keep the last 70% (the actual content to process)
 *   - Drop the middle if above soft ceiling
 *   - Add a truncation notice so the model knows content was trimmed
 */
function truncatePrompt(prompt: string): string {
    if (prompt.length <= MAX_PROMPT_CHARS) return prompt;

    const keepStart = Math.floor(prompt.length * 0.30);
    const keepEnd = prompt.length > SOFT_CEILING_CHARS
        ? Math.floor(prompt.length * 0.50)
        : Math.floor(prompt.length * 0.70);

    const start = prompt.slice(0, keepStart);
    const end = prompt.slice(-keepEnd);
    const notice = `\n\n⚠️ [Content truncated: ${prompt.length.toLocaleString()} chars → ${(keepStart + keepEnd).toLocaleString()} chars. Front-loaded instructions and tail content preserved.]\n\n`;

    return start + notice + end;
}

// ── Privacy Sanitizer ─────────────────────────────────────────────

/** Patterns that look like API keys, tokens, or secrets. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
    { name: 'OpenAI key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replacement: 'sk-•••[redacted]' },
    { name: 'Gemini key', re: /AIza[A-Za-z0-9_-]{30,}/g, replacement: 'AIza•••[redacted]' },
    { name: 'DeepSeek key', re: /sk-[a-z0-9]{32,}/gi, replacement: 'sk-•••[redacted]' },
    { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9_\-\.=]{20,}/gi, replacement: 'Bearer •••[redacted]' },
    { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '•••[JWT redacted]' },
    { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA•••[redacted]' },
    { name: 'Private key header', re: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/g, replacement: '-----BEGIN ••• PRIVATE KEY----- [redacted]' },
    { name: 'Generic hex secret', re: /\b[a-f0-9]{64,}\b/gi, replacement: '•••[hex secret redacted]' },
];

/**
 * Scan pipeline output for accidental API key / secret / private-term leakage.
 * Returns a sanitized copy. Also reports what was found.
 */
function sanitizePipelineOutput(text: string): { sanitized: string; found: string[] } {
    const found: string[] = [];
    let sanitized = text;
    for (const p of SECRET_PATTERNS) {
        const matches = text.match(p.re);
        if (matches && matches.length > 0) {
            found.push(`${p.name}: ${matches.length} instance(s)`);
            sanitized = sanitized.replace(p.re, p.replacement);
        }
    }
    return { sanitized, found };
}

/** Call a provider with up to 3 retries on transient failures, using exponential backoff. */
async function callWithRetry(
    secrets: vscode.SecretStorage,
    provider: ProviderId,
    tier: Tier,
    prompt: string,
    systemPrompt: string,
    maxTokens: number,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void,
    label: string
): Promise<string> {
    const promptKB = (prompt.length / 1024).toFixed(1);
    reportProgress(`📤 ${label} — prompt: ${promptKB}KB`);

    // Truncate oversized prompts to reduce timeout/overload risk
    const truncated = truncatePrompt(prompt);
    if (truncated !== prompt) {
        const truncatedKB = (truncated.length / 1024).toFixed(1);
        reportProgress(`✂️ ${label} — truncated: ${promptKB}KB → ${truncatedKB}KB`);
    }

    // Circuit breaker check — skip if provider is tripped
    if (isProviderBlocked(provider)) {
        reportProgress(`🔌 ${label} — circuit breaker BLOCKED: ${getCircuitStatus(provider)}`);
        return `[${label} blocked: circuit breaker tripped after ${CIRCUIT_FAILURE_THRESHOLD} consecutive failures]`;
    }

    let lastError: Error | null = null;
    const maxAttempts = 3;
    const baseDelay = 2000; // 2s

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (token.isCancellationRequested) {
            return `[${label} cancelled]`;
        }
        try {
            const r = await consult(secrets, {
                provider,
                tier,
                question: truncated,
                system: systemPrompt,
                maxTokens,
            }, token);
            // Success — reset circuit breaker
            recordProviderSuccess(provider);
            if (attempt > 1) {
                reportProgress(`✅ ${label} recovered on attempt ${attempt}`);
            }
            return r.text;
        } catch (err: any) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const isTrans = isTransient(lastError);
            const isExhausted = attempt === maxAttempts;

            // Record failure for circuit breaker
            if (isTrans) {
                recordProviderFailure(provider);
            }

            if (!isTrans || isExhausted) {
                if (isExhausted) {
                    reportProgress(`❌ ${label} — exhausted ${maxAttempts} retries: ${lastError.message}`);
                    // Final failure also counts toward circuit breaker
                    recordProviderFailure(provider);
                } else {
                    reportProgress(`❌ ${label} — non-retryable: ${lastError.message}`);
                }
                return `[${label} error: ${lastError.message}]`;
            }

            const delay = baseDelay * Math.pow(2, attempt - 1); // 2s, 4s, 8s
            reportProgress(`🔄 ${label} retry ${attempt}/${maxAttempts} in ${delay / 1000}s — ${lastError.message}`);
            await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, delay);
                const sub = token.onCancellationRequested(() => { clearTimeout(t); resolve(); });
                // Clean up listener if timeout fires first
                setTimeout(() => sub.dispose(), delay + 100);
            });
        }
    }
    // Should never reach here, but TypeScript needs it
    return `[${label} error: ${lastError?.message ?? 'unknown'}]`;
}

async function executeThoroughStep(
    secrets: vscode.SecretStorage,
    step: DeepSwarmStep,
    prompt: string,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void
): Promise<{ primaryResult: string; parallelResults: string[]; costDollars: number; durationMs: number }> {
    const started = Date.now();
    const { primary, parallel = [] } = step.providers;
    const allProviders = [primary, ...parallel];
    const providerLabels = allProviders.map(p => `${providerDisplayName(p.provider)}/${modelFor(p.provider, p.tier)}`).join(', ');

    reportProgress(`🧠 Thorough: ${allProviders.length} models analyzing (${providerLabels})...`);

    // Fire all providers in parallel — each with its own retry loop
    const stepMaxTokens = step.maxTokens || 2048;
    const systemPrompt = `You are an expert ${step.focusHint}. ${step.checklist.map((c, i) => `${i + 1}. ${c}`).join(' ')}`;
    const calls = allProviders.map(p =>
        callWithRetry(
            secrets,
            p.provider,
            p.tier,
            prompt,
            systemPrompt,
            stepMaxTokens,
            token,
            reportProgress,
            `${providerDisplayName(p.provider)}/${modelFor(p.provider, p.tier)}`
        )
    );

    const results = await Promise.all(calls);
    const durationMs = Date.now() - started;

    // ── Provider Fallback: if primary failed but a parallel succeeded, rotate ──
    let primaryResult = results[0];
    let parallelResults = results.slice(1);
    const isError = (r: string) => r.startsWith('[') && r.includes('error');
    const isPrimaryError = isError(primaryResult);
    
    if (isPrimaryError && parallelResults.length > 0) {
        // Find first non-error parallel result to promote as primary
        const firstHealthy = parallelResults.findIndex(r => !isError(r));
        if (firstHealthy >= 0) {
            const fallbackProvider = parallel[firstHealthy];
            reportProgress(`🔄 Provider fallback: ${providerDisplayName(primary.provider)} failed → rotating to ${providerDisplayName(fallbackProvider.provider)} as primary`);
            // Swap: promote healthy parallel to primary, demote failed primary to parallel
            const healthyResult = parallelResults[firstHealthy];
            parallelResults[firstHealthy] = primaryResult;
            primaryResult = healthyResult;
        }
    }

    // ── Provider Backfill: retry any still-failed models with alternative providers ──
    const allResults = [primaryResult, ...parallelResults];
    const allProviderDefs = [primary, ...parallel];
    
    for (let i = 0; i < allResults.length; i++) {
        if (!isError(allResults[i])) continue;
        
        const failedProvider = allProviderDefs[i].provider;
        const failedTier = allProviderDefs[i].tier;
        
        // Determine best fallback: prefer DeepSeek (native CN, good pricing),
        // then Qwen, then Gemini. Exclude the already-failed provider.
        const fallbackOrder = getTranslationFallbackOrder();
        const alreadyTried = new Set(allProviderDefs.map(p => p.provider));
        const candidate = fallbackOrder.find(p => !alreadyTried.has(p));
        
        if (candidate) {
            reportProgress(`🔄 Backfill: ${providerDisplayName(failedProvider)} failed → retrying with ${providerDisplayName(candidate)}`);
            try {
                const r = await callWithRetry(
                    secrets,
                    candidate,
                    failedTier,
                    prompt,
                    systemPrompt,
                    stepMaxTokens,
                    token,
                    reportProgress,
                    `${providerDisplayName(candidate)}/${modelFor(candidate, failedTier)} (backfill)`
                );
                if (!isError(r)) {
                    if (i === 0) primaryResult = r;
                    else parallelResults[i - 1] = r;
                    reportProgress(`✅ Backfill: ${providerDisplayName(candidate)} succeeded for ${providerDisplayName(failedProvider)}`);
                }
            } catch {
                reportProgress(`⚠️ Backfill: ${providerDisplayName(candidate)} also failed for ${providerDisplayName(failedProvider)}`);
            }
        }
    }

    // Estimate cost (rough: $0.01 per call for light, $0.03 for mid, $0.05 for coding/heavy)
    const tierCost: Record<string, number> = { light: 0.005, mid: 0.02, heavy: 0.05, coding: 0.05 };
    const costDollars = allProviders.reduce((sum, p) => sum + (tierCost[p.tier] ?? 0.02), 0);

    return {
        primaryResult,
        parallelResults,
        costDollars,
        durationMs,
    };
}

async function executeScrutinizeStep(
    secrets: vscode.SecretStorage,
    step: DeepSwarmStep,
    prompt: string,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void
): Promise<{ primaryResult: string; reviewerNotes: string[]; costDollars: number; durationMs: number }> {
    const started = Date.now();
    const { primary, reviewers = [] } = step.providers;

    const stepMaxTokens = step.maxTokens || 2048;
    const reviewerMaxTokens = Math.max(1024, Math.floor(stepMaxTokens / 2));

    // Step 1: Primary drafts
    reportProgress(`📝 Scrutinize: ${providerDisplayName(primary.provider)} drafting...`);
    const draft = await consult(secrets, {
        provider: primary.provider,
        tier: primary.tier,
        question: prompt,
        system: 'You are a careful, thorough analyst. Draft a complete answer.',
        maxTokens: stepMaxTokens,
    }, token);

    // Step 2: Reviewers critique sequentially
    const reviewerNotes: string[] = [];
    for (const reviewer of reviewers) {
        if (token.isCancellationRequested) break;
        reportProgress(`🔍 Scrutinize: ${providerDisplayName(reviewer.provider)} reviewing...`);
        const review = await consult(secrets, {
            provider: reviewer.provider,
            tier: reviewer.tier,
            question: `Review the following draft critically. Find issues, gaps, unclear reasoning, or missing considerations.\n\nDraft:\n${draft.text}\n\nBe specific. What should be changed or improved?`,
            system: 'You are a critical reviewer. Find problems and suggest improvements. Be specific.',
            maxTokens: reviewerMaxTokens,
        }, token);
        reviewerNotes.push(`[${providerDisplayName(reviewer.provider)}]: ${review.text}`);
    }

    // Step 3: Primary revises with all feedback
    if (reviewerNotes.length > 0 && !token.isCancellationRequested) {
        reportProgress(`✏️ Scrutinize: ${providerDisplayName(primary.provider)} revising...`);
        const feedback = reviewerNotes.join('\n\n---\n\n');
        const revised = await consult(secrets, {
            provider: primary.provider,
            tier: primary.tier,
            question: `Revise your draft based on the following feedback. Address each point.\n\nOriginal draft:\n${draft.text}\n\nFeedback:\n${feedback}\n\nProvide the revised, improved version.`,
            system: 'You are revising based on critical feedback. Address every point. Improve clarity and correctness.',
            maxTokens: stepMaxTokens,
        }, token);
        draft.text = revised.text;
    }

    const costDollars = 0.02 + reviewers.length * 0.02 + (reviewerNotes.length > 0 ? 0.02 : 0); // draft + reviews + revision
    const durationMs = Date.now() - started;

    return { primaryResult: draft.text, reviewerNotes, costDollars, durationMs };
}

// ── Vision Provider Resolution ──────────────────────────────────

/**
 * Resolve primary provider for visualStep steps from user's harmony.vision.provider config.
 * Users who prefer or need Qwen vision (regional accessibility, preference) can set
 * 'alibaba' or 'auto-qwen-first'. Parallel provider is the other vision provider.
 */
function resolveVisionProvider(pipeline: DeepSwarmPipeline): DeepSwarmPipeline {
    const visionConfig = vscode.workspace.getConfiguration('harmony.vision').get<string>('provider', 'auto');
    if (visionConfig === 'auto' || visionConfig === 'gemini') return pipeline; // default — Gemini primary, no change needed

    // Determine the vision primary provider
    let visionPrimary: ProviderId;
    if (visionConfig === 'alibaba' || visionConfig === 'auto-qwen-first') {
        visionPrimary = 'alibaba';
    } else {
        return pipeline; // unknown value, keep defaults
    }

    const overriddenSteps = pipeline.steps.map(step => {
        if (!step.visualStep) return step;
        const tier = step.providers.primary.tier;
        const otherVision: ProviderId = visionPrimary === 'alibaba' ? 'gemini' : 'alibaba';
        return {
            ...step,
            providers: {
                primary: { provider: visionPrimary, tier },
                parallel: [{ provider: otherVision, tier }],
                reviewers: step.providers.reviewers,
            },
        };
    });

    return { ...pipeline, steps: overriddenSteps };
}

// ── Pipeline Runner ───────────────────────────────────────────────

// ── Checkpointing ─────────────────────────────────────────────────

interface DeepSwarmCheckpoint {
    pipelineId: string;
    completedStepCount: number;
    stepResults: StepResult[];
    cumulativeFindings: string;
    totalCostSoFar: number;
    startedAt: number;
    savedAt: number;
}

function checkpointPath(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.join(ws, '.harmony', 'deepswarm-checkpoint.json');
}

async function saveCheckpoint(checkpoint: DeepSwarmCheckpoint): Promise<void> {
    try {
        const dir = path.dirname(checkpointPath());
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(checkpointPath(), JSON.stringify({ ...checkpoint, savedAt: Date.now() }, null, 2), 'utf8');
    } catch { /* non-critical */ }
}

async function loadCheckpoint(): Promise<DeepSwarmCheckpoint | null> {
    try {
        const raw = await fs.readFile(checkpointPath(), 'utf8');
        return JSON.parse(raw) as DeepSwarmCheckpoint;
    } catch { return null; }
}

async function deleteCheckpoint(): Promise<void> {
    try { await fs.unlink(checkpointPath()); } catch { /* may not exist */ }
}

// ── Provider Circuit Breaker ────────────────────────────────────

interface CircuitState {
    consecutiveFailures: number;
    lastFailureTime: number;
    blockedUntil: number; // epoch ms, 0 = not blocked
}

const circuitBreakers = new Map<ProviderId, CircuitState>();
const CIRCUIT_FAILURE_THRESHOLD = 5;     // consecutive failures before tripping
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes for counting failures
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes blocked after tripping

function isProviderBlocked(provider: ProviderId): boolean {
    const state = circuitBreakers.get(provider);
    if (!state || !state.blockedUntil) return false;
    if (Date.now() > state.blockedUntil) {
        // Cooldown expired — reset circuit
        circuitBreakers.delete(provider);
        return false;
    }
    return true;
}

function recordProviderSuccess(provider: ProviderId): void {
    circuitBreakers.delete(provider);
}

function recordProviderFailure(provider: ProviderId): void {
    const state = circuitBreakers.get(provider) || { consecutiveFailures: 0, lastFailureTime: 0, blockedUntil: 0 };
    const now = Date.now();
    
    // Reset counter if outside the window
    if (now - state.lastFailureTime > CIRCUIT_WINDOW_MS) {
        state.consecutiveFailures = 0;
    }
    
    state.consecutiveFailures++;
    state.lastFailureTime = now;
    
    if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        state.blockedUntil = now + CIRCUIT_COOLDOWN_MS;
        console.log(`[CircuitBreaker] 🔌 ${providerDisplayName(provider)} tripped — ${state.consecutiveFailures} failures in ${CIRCUIT_WINDOW_MS / 60000}min. Blocked for ${CIRCUIT_COOLDOWN_MS / 60000}min.`);
    }
    
    circuitBreakers.set(provider, state);
}

function getCircuitStatus(provider: ProviderId): string {
    if (isProviderBlocked(provider)) {
        const state = circuitBreakers.get(provider)!;
        const remaining = Math.round((state.blockedUntil - Date.now()) / 1000);
        return `🔌 BLOCKED (${remaining}s remaining)`;
    }
    const state = circuitBreakers.get(provider);
    if (state && state.consecutiveFailures > 0) {
        return `⚠️ ${state.consecutiveFailures}/${CIRCUIT_FAILURE_THRESHOLD} failures`;
    }
    return '🟢 healthy';
}

// ── At-Rest Encryption ───────────────────────────────────────────
// AES-256-GCM: encrypts .harmony/ files so they can't be read
// if exfiltrated. Key is derived from machine hostname + app salt.
// Not bulletproof against a determined attacker with full disk
// access, but protects against casual snooping and file theft.

const ENC_SALT = Buffer.from('HarmonyExt:at-rest:v1:salt', 'utf8');
const ENC_ALGO = 'aes-256-gcm';
const ENC_IV_LEN = 12;
const ENC_TAG_LEN = 16;

let _encKey: Buffer | null = null;
function getEncryptionKey(): Buffer {
    if (_encKey) return _encKey;
    const hostname = os.hostname();
    const username = (os.userInfo().username || 'unknown').toLowerCase();
    const material = `harmony-at-rest//${hostname}//${username}//v1//app-pepper-2026`;
    _encKey = crypto.scryptSync(material, ENC_SALT, 32);
    return _encKey;
}

function encryptAtRest(plaintext: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(ENC_IV_LEN);
    const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptAtRest(encoded: string): string {
    const key = getEncryptionKey();
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length < ENC_IV_LEN + ENC_TAG_LEN + 1) {
        throw new Error('Ciphertext too short');
    }
    const iv = buf.subarray(0, ENC_IV_LEN);
    const tag = buf.subarray(ENC_IV_LEN, ENC_IV_LEN + ENC_TAG_LEN);
    const ct = buf.subarray(ENC_IV_LEN + ENC_TAG_LEN);
    const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

async function writeEncryptedFile(filePath: string, plaintext: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, encryptAtRest(plaintext), 'utf8');
}

async function readEncryptedFile(filePath: string): Promise<string> {
    const raw = await fs.readFile(filePath, 'utf8');
    // Detect if file is encrypted (base64 format) vs legacy plaintext JSON
    if (raw.startsWith('{') || raw.startsWith('[')) {
        return raw; // legacy unencrypted — transparent upgrade on next write
    }
    return decryptAtRest(raw);
}

// ── Persistent Glossary ──────────────────────────────────────────

const GLOSSARY_PATH = '.harmony/glossary.json';
const GLOSSARY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface GlossaryMetadata {
    generatedAt: string;
    pipelineId: string;
    termCount?: number;
    contentFingerprint?: string; // first 200 chars of glossary, for domain matching
    content: string;
}

/** Quick fingerprint for domain-aware glossary matching. */
function fingerprintGlossary(text: string): string {
    // Extract just the term|translation table rows for domain matching
    const tableRows = (text.match(/\| ([^|]+) \| ([^|]+) \|/g) || []).join('\n');
    if (tableRows.length < 50) return text.slice(0, 200).replace(/\s+/g, ' ').trim();
    return tableRows.slice(0, 300);
}

/** Estimate how many glossary terms are in the output. */
function countGlossaryTerms(text: string): number {
    const matches = text.match(/\| [^|]+ \| [^|]+ \| [^|]+ \| [★☆]+ \|/g);
    return matches ? matches.length : 0;
}

async function saveGlossary(glossaryText: string): Promise<void> {
    try {
        const payload = JSON.stringify({
            generatedAt: new Date().toISOString(),
            pipelineId: 'convergence-translation',
            termCount: countGlossaryTerms(glossaryText),
            contentFingerprint: fingerprintGlossary(glossaryText),
            content: glossaryText,
        } as GlossaryMetadata, null, 2);
        await writeEncryptedFile(GLOSSARY_PATH, payload);
    } catch { /* non-critical */ }
}

/** Load glossary if it exists AND is fresh (< 30 days). Returns null if stale or missing. */
async function loadGlossary(): Promise<{ content: string; ageDays: number; termCount: number } | null> {
    try {
        const decrypted = await readEncryptedFile(GLOSSARY_PATH);
        const parsed: GlossaryMetadata = JSON.parse(decrypted);
        if (!parsed.content || !parsed.generatedAt) return null;
        const ageMs = Date.now() - new Date(parsed.generatedAt).getTime();
        const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
        if (ageMs > GLOSSARY_MAX_AGE_MS) {
            console.log(`[Glossary] Stale: ${ageDays}d old > 30d max — will regenerate`);
            return null;
        }
        return {
            content: parsed.content,
            ageDays,
            termCount: parsed.termCount || countGlossaryTerms(parsed.content),
        };
    } catch { return null; }
}

// ── Deterministic Post-Processors ────────────────────────────────

interface ValidationIssue {
    severity: 'error' | 'warning' | 'info';
    type: string;
    detail: string;
    location?: string;
}

interface ValidationReport {
    passed: boolean;
    issues: ValidationIssue[];
    summary: string;
}

/**
 * First-Mention Rule Validator.
 * Checks that acronyms are expanded on first use per section and used
 * acronym-only thereafter. Deterministic regex-based — no AI needed.
 */
function validateFirstMentionRules(translation: string): ValidationReport {
    const issues: ValidationIssue[] = [];

    // Common EN→ZH acronym patterns to check
    // Format: [englishAcronym, chineseExpansion]
    const acronymPatterns: [string, string][] = [
        ['PUE', '电能利用效率'],
        ['CUE', '碳利用效率'],
        ['WUE', '水资源利用效率'],
        ['DCIE', '数据中心基础设施效率'],
        ['SLA', '服务等级协议'],
        ['KPI', '关键绩效指标'],
        ['ROI', '投资回报率'],
        ['GHG', '温室气体'],
        ['ESG', '环境、社会和治理'],
        ['AI', '人工智能'],
        ['ML', '机器学习'],
        ['IoT', '物联网'],
    ];

    // Split translation into sections by heading markers
    const sections = translation.split(/^#{1,3}\s+/m);

    for (const [acronym, expansion] of acronymPatterns) {
        // Count occurrences
        const acronymRegex = new RegExp(`\\b${acronym}\\b`, 'g');
        const totalMatches = translation.match(acronymRegex);
        const totalCount = totalMatches ? totalMatches.length : 0;

        if (totalCount === 0) continue; // Acronym not used

        // Check first occurrence in each section has expansion
        let sectionIndex = 0;
        for (const section of sections) {
            sectionIndex++;
            const sectionMatches = section.match(acronymRegex);
            if (!sectionMatches || sectionMatches.length === 0) continue;

            // Check if first occurrence in this section includes the expansion
            const firstOccurrenceIdx = section.search(acronymRegex);
            const contextAfter = section.slice(firstOccurrenceIdx, firstOccurrenceIdx + 80);

            const hasExpansion = contextAfter.includes(expansion) ||
                contextAfter.includes(acronym + '（' + expansion) ||
                contextAfter.includes(acronym + '(' + expansion);

            if (!hasExpansion && sectionMatches.length >= 1) {
                issues.push({
                    severity: 'warning',
                    type: 'first-mention',
                    detail: `${acronym} used ${sectionMatches.length}× in section ${sectionIndex} but first occurrence lacks expansion "${expansion}"`,
                    location: `Section ${sectionIndex}`,
                });
            }
        }

        // Check that after first expansion, subsequent uses are acronym-only
        // (no redundant expansions)
        const expansionRegex = new RegExp(`${acronym}[（(]${expansion}[）)]`, 'g');
        const expansionMatches = translation.match(expansionRegex);
        if (expansionMatches && expansionMatches.length > totalCount / 2 + 1) {
            issues.push({
                severity: 'info',
                type: 'over-expansion',
                detail: `${acronym} expanded ${expansionMatches.length}× — may be over-expanded (expected ~1 per section)`,
            });
        }
    }

    return {
        passed: issues.filter(i => i.severity === 'error').length === 0,
        issues,
        summary: issues.length === 0
            ? '✅ All first-mention rules satisfied'
            : `⚠️ ${issues.filter(i => i.severity === 'error').length} errors, ${issues.filter(i => i.severity === 'warning').length} warnings`,
    };
}

/**
 * Hierarchical Coherence Validator.
 * Checks that the translated document preserves the structure of the source.
 * Verifies: heading count, list item count, table presence.
 */
function validateHierarchicalCoherence(source: string, translation: string): ValidationReport {
    const issues: ValidationIssue[] = [];

    // Count headings by level
    const sourceH1 = (source.match(/^#\s+/gm) || []).length;
    const sourceH2 = (source.match(/^##\s+/gm) || []).length;
    const sourceH3 = (source.match(/^###\s+/gm) || []).length;
    const transH1 = (translation.match(/^#\s+/gm) || []).length;
    const transH2 = (translation.match(/^##\s+/gm) || []).length;
    const transH3 = (translation.match(/^###\s+/gm) || []).length;

    if (sourceH1 !== transH1) {
        issues.push({
            severity: 'error',
            type: 'heading-mismatch',
            detail: `H1 headings: source has ${sourceH1}, translation has ${transH1}`,
        });
    }
    if (sourceH2 !== transH2) {
        issues.push({
            severity: 'warning',
            type: 'heading-mismatch',
            detail: `H2 headings: source has ${sourceH2}, translation has ${transH2}`,
        });
    }
    if (sourceH3 !== transH3) {
        issues.push({
            severity: 'warning',
            type: 'heading-mismatch',
            detail: `H3 headings: source has ${sourceH3}, translation has ${transH3}`,
        });
    }

    // Count list items (bullet points and numbered items)
    const sourceBullets = (source.match(/^[\s]*[-*+]\s+/gm) || []).length;
    const sourceNumbered = (source.match(/^[\s]*\d+[.)]\s+/gm) || []).length;
    const transBullets = (translation.match(/^[\s]*[-*+]\s+/gm) || []).length;
    const transNumbered = (translation.match(/^[\s]*\d+[.)]\s+/gm) || []).length;

    if (Math.abs(sourceBullets - transBullets) > 1) {
        issues.push({
            severity: 'warning',
            type: 'list-mismatch',
            detail: `Bullet list items: source has ${sourceBullets}, translation has ${transBullets}`,
        });
    }
    if (Math.abs(sourceNumbered - transNumbered) > 1) {
        issues.push({
            severity: 'warning',
            type: 'list-mismatch',
            detail: `Numbered list items: source has ${sourceNumbered}, translation has ${transNumbered}`,
        });
    }

    // Check for tables (crude detection)
    const sourceTables = (source.match(/^\|.+\|$/gm) || []).length;
    const transTables = (translation.match(/^\|.+\|$/gm) || []).length;
    if (sourceTables > 0 && transTables === 0) {
        issues.push({
            severity: 'error',
            type: 'table-missing',
            detail: `Source has ${sourceTables} table rows but translation has none`,
        });
    }

    // Check for code blocks
    const sourceCodeBlocks = (source.match(/```/g) || []).length;
    const transCodeBlocks = (translation.match(/```/g) || []).length;
    if (sourceCodeBlocks !== transCodeBlocks) {
        issues.push({
            severity: 'warning',
            type: 'code-block-mismatch',
            detail: `Code blocks: source has ${sourceCodeBlocks / 2}, translation has ${transCodeBlocks / 2}`,
        });
    }

    return {
        passed: issues.filter(i => i.severity === 'error').length === 0,
        issues,
        summary: issues.length === 0
            ? '✅ Document structure preserved'
            : `⚠️ ${issues.filter(i => i.severity === 'error').length} errors, ${issues.filter(i => i.severity === 'warning').length} warnings`,
    };
}

// ── Section-Aware Translation ──────────────────────────────────

interface SourceSection {
    heading: string;    // e.g. "## 3. Power Usage Effectiveness (PUE)"
    level: number;      // heading level (1-6)
    body: string;       // section content after heading
    index: number;      // 0-based position in document
}

/**
 * Tokenize a Markdown source document by headings.
 * Splits on ## (level 2) headings for medium-sized translation chunks.
 * Sections < 200 chars are merged with the next section.
 * A preamble before the first heading becomes section 0.
 */
function tokenizeSourceByHeading(source: string): SourceSection[] {
    const MIN_SECTION_CHARS = 200;
    const lines = source.split('\n');
    const sections: SourceSection[] = [];
    let currentHeading = '';
    let currentLevel = 0;
    let currentBodyLines: string[] = [];
    let index = 0;

    for (const line of lines) {
        const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
        if (headingMatch) {
            // Save previous section if it has content
            const body = currentBodyLines.join('\n').trim();
            if (body || currentHeading) {
                sections.push({
                    heading: currentHeading,
                    level: currentLevel,
                    body,
                    index: sections.length,
                });
            }
            currentHeading = line.trim();
            currentLevel = headingMatch[1].length;
            currentBodyLines = [];
        } else {
            currentBodyLines.push(line);
        }
    }

    // Don't forget the last section
    const lastBody = currentBodyLines.join('\n').trim();
    if (lastBody || currentHeading) {
        sections.push({
            heading: currentHeading,
            level: currentLevel,
            body: lastBody,
            index: sections.length,
        });
    }

    // If no sections found (document has no headings), return as one section
    if (sections.length === 0) {
        return [{ heading: '', level: 0, body: source.trim(), index: 0 }];
    }

    // Merge undersized sections with the next one
    const merged: SourceSection[] = [];
    let carryBody = '';
    let carryHeading = '';

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const combinedBody = (carryBody + '\n\n' + (section.heading ? section.heading + '\n' : '') + section.body).trim();
        const isFirstOrLast = i === 0 || i === sections.length - 1;

        if (!isFirstOrLast && combinedBody.length < MIN_SECTION_CHARS && i < sections.length - 1) {
            // Too small — carry forward to next section
            carryBody = combinedBody;
            if (!carryHeading) carryHeading = section.heading;
        } else {
            merged.push({
                heading: carryHeading || section.heading,
                level: section.level,
                body: combinedBody,
                index: merged.length,
            });
            carryBody = '';
            carryHeading = '';
        }
    }

    // If there's still carry at the end, append to last section
    if (carryBody && merged.length > 0) {
        const last = merged[merged.length - 1];
        merged[merged.length - 1] = {
            ...last,
            body: (last.body + '\n\n' + carryBody).trim(),
        };
    }

    return merged;
}

/**
 * Execute section-aware translation for conv-translate step.
 * Instead of one giant prompt, splits source by headings and translates
 * each section with all 3 models independently. Keeps prompts ~2-4KB
 * instead of 30-50KB, preventing DeepSeek timeouts.
 */
async function executeSectionAwareTranslate(
    secrets: vscode.SecretStorage,
    step: DeepSwarmStep,
    source: string,
    glossaryFindings: string,  // Stage 1 + Stage 2 outputs
    focus: string,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void
): Promise<{
    primaryResult: string;
    parallelResults: string[];
    costDollars: number;
    durationMs: number;
    sectionCount: number;
}> {
    const started = Date.now();
    const sections = tokenizeSourceByHeading(source);
    const { primary, parallel = [] } = step.providers;
    const allProviders = [primary, ...parallel];
    const stepMaxTokens = Math.min(step.maxTokens || 32768, 8192); // Per-section cap

    reportProgress(`📑 Section-Aware: ${sections.length} sections → 3 models each (${sections.length * allProviders.length} calls)`);

    // Build the translation system prompt once (reused for all sections)
    const baseSystemPrompt = `You are translating a formal business/technical document from English to Chinese (简体中文).

CRITICAL RULES:
1. USE THE GLOSSARY — every term must match exactly. Non-negotiable.
2. DNT terms must REMAIN in English.
3. Tone: 公文风格 — formal Chinese business/official document style.
4. Preserve ALL structure: headings, lists, tables, paragraphs, emphasis.
5. Technical precision: numbers, specs, standards references must be exact.
6. Cultural naturalness: read as if ORIGINALLY WRITTEN in Chinese. Avoid 翻译腔.
7. Translate EVERY sentence. Nothing omitted. Nothing summarized.
8. Apply first-mention expansion rules from the glossary.`;

    // Translate each section with all models
    const primaryResults: string[] = [];
    const parallelResults: string[][] = allProviders.slice(1).map(() => []);

    for (let si = 0; si < sections.length; si++) {
        if (token.isCancellationRequested) break;

        const section = sections[si];
        const sectionLabel = section.heading
            ? section.heading.replace(/^#+\s*/, '').slice(0, 60)
            : `Section ${si + 1}`;
        reportProgress(`📑 [${si + 1}/${sections.length}] Translating: ${sectionLabel}...`);

        // Build section prompt: glossary + this section only
        const sectionBody = section.heading
            ? `${section.heading}\n${section.body}`
            : section.body;
        const sectionPrompt = `─── GLOSSARY (single source of truth) ───
${glossaryFindings}

─── TEXT TO TRANSLATE ───
${sectionBody}

─── INSTRUCTIONS ───
Translate the TEXT TO TRANSLATE section above into Chinese.
Focus: ${focus || 'Professional formal Chinese translation'}
Output ONLY the Chinese translation — no commentary, no English original except DNT terms.`;

        // Fire all models in parallel for this section
        const calls = allProviders.map(p =>
            callWithRetry(
                secrets,
                p.provider,
                p.tier,
                sectionPrompt,
                baseSystemPrompt,
                stepMaxTokens,
                token,
                reportProgress,
                `${providerDisplayName(p.provider)}/${modelFor(p.provider, p.tier)} §${si + 1}`
            )
        );

        const results = await Promise.all(calls);
        
        // ── Per-section Provider Backfill: retry failed models ──
        const isErr = (r: string) => r.startsWith('[') && r.includes('error');
        for (let ri = 0; ri < results.length; ri++) {
            if (!isErr(results[ri])) continue;
            const failedProvider = allProviders[ri].provider;
            const failedTier = allProviders[ri].tier;
            const fallbackOrder = getTranslationFallbackOrder();
            const alreadyTried = new Set(allProviders.map(p => p.provider));
            const candidate = fallbackOrder.find(p => !alreadyTried.has(p));
            if (candidate) {
                reportProgress(`🔄 Backfill §${si + 1}: ${providerDisplayName(failedProvider)} → ${providerDisplayName(candidate)}`);
                try {
                    const r = await callWithRetry(
                        secrets, candidate, failedTier, sectionPrompt, baseSystemPrompt,
                        stepMaxTokens, token, reportProgress,
                        `${providerDisplayName(candidate)}/${modelFor(candidate, failedTier)} §${si + 1} (backfill)`
                    );
                    if (!isErr(r)) {
                        results[ri] = r;
                        reportProgress(`✅ Backfill §${si + 1}: ${providerDisplayName(candidate)} succeeded`);
                    }
                } catch { /* backfill also failed — keep original error */ }
            }
        }
        
        primaryResults.push(results[0]);
        for (let pi = 0; pi < results.length - 1; pi++) {
            parallelResults[pi].push(results[pi + 1]);
        }
    }

    const durationMs = Date.now() - started;
    const tierCost: Record<string, number> = { light: 0.005, mid: 0.02, heavy: 0.05, coding: 0.05 };
    const costPerModel = allProviders.reduce((sum, p) => sum + (tierCost[p.tier] ?? 0.02), 0);
    const costDollars = costPerModel * sections.length;

    // Assemble results in order, preserving section headings
    const assemble = (results: string[]): string =>
        results.map((r, i) => {
            const h = sections[i]?.heading;
            // If the model preserved the heading, use as-is; otherwise prepend it
            if (h && !r.startsWith('#')) {
                return `## ${h.replace(/^#+\s*/, '')}\n\n${r}`;
            }
            return r;
        }).join('\n\n---\n\n');

    return {
        primaryResult: assemble(primaryResults),
        parallelResults: parallelResults.map(assemble),
        costDollars,
        durationMs,
        sectionCount: sections.length,
    };
}

// ── Character Budget + Layout Agent ─────────────────────────────

export interface SectionFootprint {
    index: number;
    heading: string;
    body: string;
    charCountCN: number;
    charCountEN: number;
    charCountTotal: number;
    lineCount: number;
}

export interface BudgetReport {
    sections: SectionFootprint[];
    oversized: SectionFootprint[];
    totalCN: number;
    totalEN: number;
    totalChars: number;
    maxChinesePerSection: number;
    maxTotalPerSection: number;
    sectionsRegenerated: number;
    sectionsSkipped: number;
    summary: string;
}

/** Count CJK (Chinese/Japanese/Korean) characters in a string. */
function countChineseChars(text: string): number {
    const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
    return cjk ? cjk.length : 0;
}

/** Count non-CJK, non-whitespace characters (Latin, digits, punctuation). */
function countLatinChars(text: string): number {
    const total = text.replace(/\s/g, '').length;
    const cjk = countChineseChars(text);
    return Math.max(0, total - cjk);
}

/**
 * Calculate character footprint per section.
 * Splits by ## headings, counts Chinese (CJK) characters, Latin/ASCII,
 * and total characters per section.
 */
function calculateCharFootprint(text: string): { sections: SectionFootprint[]; totalCN: number; totalEN: number; totalChars: number } {
    const headingRegex = /^(##\s+.+)$/gm;
    const headingMatches = [...text.matchAll(headingRegex)];

    if (headingMatches.length === 0) {
        const cn = countChineseChars(text);
        const en = countLatinChars(text);
        return {
            sections: [{
                index: 1,
                heading: '(entire document)',
                body: text,
                charCountCN: cn,
                charCountEN: en,
                charCountTotal: cn + en,
                lineCount: text.split('\n').length,
            }],
            totalCN: cn,
            totalEN: en,
            totalChars: cn + en,
        };
    }

    const sections: SectionFootprint[] = [];
    const headingPositions: { heading: string; start: number }[] = [];
    for (const m of headingMatches) {
        headingPositions.push({ heading: m[1], start: m.index! });
    }

    // Preamble before first heading
    if (headingPositions[0].start > 0) {
        const preamble = text.slice(0, headingPositions[0].start).trim();
        if (preamble.length > 50) {
            const cn = countChineseChars(preamble);
            const en = countLatinChars(preamble);
            sections.push({
                index: 0,
                heading: '(preamble)',
                body: preamble,
                charCountCN: cn,
                charCountEN: en,
                charCountTotal: cn + en,
                lineCount: preamble.split('\n').length,
            });
        }
    }

    // Each heading section
    for (let i = 0; i < headingPositions.length; i++) {
        const start = headingPositions[i].start;
        const end = (i < headingPositions.length - 1) ? headingPositions[i + 1].start : text.length;
        const body = text.slice(start, end).trim();
        const cn = countChineseChars(body);
        const en = countLatinChars(body);
        sections.push({
            index: i + 1,
            heading: headingPositions[i].heading.replace(/^##\s+/, ''),
            body,
            charCountCN: cn,
            charCountEN: en,
            charCountTotal: cn + en,
            lineCount: body.split('\n').length,
        });
    }

    const totalCN = sections.reduce((s, sec) => s + sec.charCountCN, 0);
    const totalEN = sections.reduce((s, sec) => s + sec.charCountEN, 0);

    return { sections, totalCN, totalEN, totalChars: totalCN + totalEN };
}

/**
 * Flag sections exceeding the character budget.
 * maxChinesePerSection: max CJK chars allowed per section (default 2000).
 * maxTotalPerSection: max total chars per section (default 3500).
 */
function identifyOversizedSections(
    footprint: { sections: SectionFootprint[] },
    maxChinesePerSection: number = 2000,
    maxTotalPerSection: number = 3500
): SectionFootprint[] {
    return footprint.sections.filter(s =>
        s.charCountCN > maxChinesePerSection || s.charCountTotal > maxTotalPerSection
    );
}

/**
 * Regenerate a single oversized section via LLM condensation.
 * Calls DeepSeek light to condense text to fit the character budget
 * while preserving all key info, glossary terms, and structure.
 */
async function regenerateOversizedSection(
    secrets: vscode.SecretStorage,
    section: SectionFootprint,
    glossary: string,
    maxChineseChars: number,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void
): Promise<string> {
    const prompt = `─── CONDENSATION TASK ───
This section exceeds its layout character budget:
- Chinese chars: ${section.charCountCN} / budget: ${maxChineseChars}
- Total chars: ${section.charCountTotal}
- Lines: ${section.lineCount}

YOUR JOB: Condense to ≤${maxChineseChars} Chinese characters while:
1. Preserving ALL key information, data, numbers, and terminology
2. Using glossary terms exactly as listed (non-negotiable)
3. Maintaining formal 公文 style
4. Keeping structural elements (headings, lists, tables) intact
5. Removing redundancy, wordiness, and filler phrases only
6. Merging short related sentences where natural

─── GLOSSARY ───
${glossary.slice(0, 3000)}

─── SECTION TO CONDENSE ───
${section.body}

─── OUTPUT ───
The condensed section ONLY. No commentary. Target: ≤${maxChineseChars} Chinese characters.`;

    try {
        const result = await callWithRetry(
            secrets,
            'deepseek',
            'light',
            prompt,
            'You are an expert Chinese technical editor. You condense formal documents to fit precise character budgets while preserving ALL technical accuracy, terminology, data, and structure. You remove ONLY redundancy — never content.',
            4096,
            token,
            reportProgress,
            `DeepSeek/light — condense §${section.index}`
        );

        const newCN = countChineseChars(result);
        const reduction = section.charCountCN - newCN;
        if (reduction > 0) {
            reportProgress(`📏 §${section.index}: ${section.charCountCN}→${newCN} CN chars (${reduction} saved, ${((reduction / section.charCountCN) * 100).toFixed(0)}%)`);
        } else {
            reportProgress(`⚠️ §${section.index}: no size reduction (${section.charCountCN}→${newCN}) — using original`);
            return section.body;
        }
        return result;
    } catch (err: any) {
        reportProgress(`⚠️ §${section.index}: condensation failed (${err.message}) — using original`);
        return section.body;
    }
}

/**
 * Character Budget + Layout Agent.
 *
 * Post-translation step that:
 * 1. Measures character footprint per section (CN/EN/total)
 * 2. Identifies sections exceeding the layout budget
 * 3. Regenerates oversized sections via lightweight LLM condensation
 * 4. Reassembles the document with all sections fitting the budget
 *
 * This ensures the translated document fits its intended layout
 * (e.g., printed handbook, web page, slide deck) without manual trimming.
 */
async function runCharacterBudgetAgent(
    secrets: vscode.SecretStorage,
    synthesis: string,
    glossary: string,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void,
    options?: {
        maxChinesePerSection?: number;
        maxTotalPerSection?: number;
        skipCondensation?: boolean;
    }
): Promise<{ adjustedSynthesis: string; budgetReport: BudgetReport }> {
    const maxCN = options?.maxChinesePerSection ?? 2000;
    const maxTotal = options?.maxTotalPerSection ?? 3500;

    reportProgress('📏 Character Budget Agent: measuring footprint...');

    // Step 1: Calculate footprint
    const footprint = calculateCharFootprint(synthesis);
    reportProgress(`📏 Footprint: ${footprint.totalCN} CN, ${footprint.totalEN} EN, ${footprint.totalChars} total — ${footprint.sections.length} sections`);

    // Step 2: Identify oversized sections
    const oversized = identifyOversizedSections(footprint, maxCN, maxTotal);

    if (oversized.length === 0) {
        reportProgress('✅ All sections within character budget');
        return {
            adjustedSynthesis: synthesis,
            budgetReport: {
                sections: footprint.sections,
                oversized: [],
                totalCN: footprint.totalCN,
                totalEN: footprint.totalEN,
                totalChars: footprint.totalChars,
                maxChinesePerSection: maxCN,
                maxTotalPerSection: maxTotal,
                sectionsRegenerated: 0,
                sectionsSkipped: footprint.sections.length,
                summary: `All ${footprint.sections.length} sections within budget (max ${maxCN} CN / ${maxTotal} total chars each)`,
            },
        };
    }

    reportProgress(`📏 ${oversized.length}/${footprint.sections.length} sections over budget — condensing...`);

    if (options?.skipCondensation) {
        reportProgress('⏭️ Skipping condensation (dry run)');
        return {
            adjustedSynthesis: synthesis,
            budgetReport: {
                sections: footprint.sections,
                oversized,
                totalCN: footprint.totalCN,
                totalEN: footprint.totalEN,
                totalChars: footprint.totalChars,
                maxChinesePerSection: maxCN,
                maxTotalPerSection: maxTotal,
                sectionsRegenerated: 0,
                sectionsSkipped: oversized.length,
                summary: `${oversized.length} sections over budget (dry run — no condensation applied)`,
            },
        };
    }

    // Step 3: Regenerate each oversized section
    const condensedMap = new Map<string, string>();
    let regenerated = 0;
    let skipped = 0;

    for (const section of oversized) {
        if (token.isCancellationRequested) break;
        const condensed = await regenerateOversizedSection(
            secrets, section, glossary, maxCN, token, reportProgress
        );
        condensedMap.set(section.body, condensed);
        if (condensed !== section.body) { regenerated++; } else { skipped++; }
    }

    // Step 4: Reassemble — replace each original section body with condensed version
    let adjustedSynthesis = synthesis;
    for (const [original, condensed] of condensedMap) {
        adjustedSynthesis = adjustedSynthesis.replace(original, condensed);
    }

    // Step 5: Re-measure to verify
    const adjustedFootprint = calculateCharFootprint(adjustedSynthesis);
    const stillOversized = identifyOversizedSections(adjustedFootprint, maxCN, maxTotal);

    const summary = stillOversized.length === 0
        ? `✅ Condensed ${regenerated} sections → all ${adjustedFootprint.sections.length} now within budget`
        : `⚠️ Condensed ${regenerated} sections, ${stillOversized.length} still over budget (${skipped} unchanged)`;

    reportProgress(`📏 Budget complete: ${summary}`);

    return {
        adjustedSynthesis,
        budgetReport: {
            sections: adjustedFootprint.sections,
            oversized: stillOversized,
            totalCN: adjustedFootprint.totalCN,
            totalEN: adjustedFootprint.totalEN,
            totalChars: adjustedFootprint.totalChars,
            maxChinesePerSection: maxCN,
            maxTotalPerSection: maxTotal,
            sectionsRegenerated: regenerated,
            sectionsSkipped: oversized.length - regenerated,
            summary,
        },
    };
}

export async function runPipeline(
    secrets: vscode.SecretStorage,
    pipeline: DeepSwarmPipeline,
    context: string,
    focus: string,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void,
    strategy?: ProviderStrategy,
    providerOverride?: string,
    tierOverride?: Tier,
    /** Optional: called after each step completes. If provided, pipeline pauses until callback resolves. Return false to abort. */
    onStepComplete?: (stepIndex: number, stepResult: StepResult, totalSteps: number) => Promise<boolean>,
): Promise<PipelineResult> {
    // Apply provider strategy if specified
    let effectivePipeline = strategy ? applyStrategy(pipeline, strategy) : pipeline;

    // Apply user-selected provider override (replaces ALL primary providers)
    if (providerOverride && PROVIDER_IDS.includes(providerOverride as ProviderId)) {
        const overridePid = providerOverride as ProviderId;
        const overrideTier = tierOverride || 'mid';
        effectivePipeline = {
            ...effectivePipeline,
            steps: effectivePipeline.steps.map(step => ({
                ...step,
                providers: {
                    ...step.providers,
                    primary: { provider: overridePid, tier: overrideTier },
                },
            })),
        };
        reportProgress(`🎯 Override: ${providerDisplayName(overridePid)}/${overrideTier} on all primary steps`);
    }

    // Show strategy in progress if applicable
    if (strategy) {
        const preset = getStrategyPreset(strategy);
        reportProgress(`🎯 Strategy: ${preset.name} — ${preset.description}`);
    }

    // Resolve vision provider from user config for visualStep steps
    effectivePipeline = resolveVisionProvider(effectivePipeline);

    // ── Checkpoint: resume if interrupted ──
    const checkpoint = await loadCheckpoint();
    const stepResults: StepResult[] = [];
    let cumulativeFindings = '';
    let started = Date.now();
    let startStepIndex = 0;

    // ── Cost Guardrails ──
    // Per-step cost estimates based on mode and provider tiers
    const STEP_COST_ESTIMATE: Record<string, number> = {
        'thorough-light': 0.01, 'thorough-mid': 0.03, 'thorough-heavy': 0.08, 'thorough-coding': 0.06,
        'scrutinize-light': 0.02, 'scrutinize-mid': 0.05, 'scrutinize-heavy': 0.12, 'scrutinize-coding': 0.09,
        'pioneer-light': 0.02, 'pioneer-mid': 0.06, 'pioneer-heavy': 0.15, 'pioneer-coding': 0.12,
    };
    const isConvergence = effectivePipeline.id === 'convergence-translation' || effectivePipeline.id === 'semantic-compilation';
    const MAX_COST_PER_RUN = isConvergence ? 10.00 : 5.00; // $10 for translation, $5 for everything else
    const COST_WARN_50 = MAX_COST_PER_RUN * 0.5;
    const COST_WARN_80 = MAX_COST_PER_RUN * 0.8;
    let accumulatedCost = checkpoint?.totalCostSoFar || 0;

    if (accumulatedCost >= MAX_COST_PER_RUN) {
        reportProgress(`💰 Cost cap reached: $${accumulatedCost.toFixed(2)} / $${MAX_COST_PER_RUN.toFixed(2)} — aborting pipeline`);
        throw new Error(`Pipeline cost exceeds $${MAX_COST_PER_RUN.toFixed(2)} cap. Accumulated: $${accumulatedCost.toFixed(2)}.`);
    }
    if (accumulatedCost > 0) {
        reportProgress(`💰 Resumed cost: $${accumulatedCost.toFixed(2)} / $${MAX_COST_PER_RUN.toFixed(2)}`);
    }

    if (checkpoint && checkpoint.pipelineId === effectivePipeline.id) {
        const elapsed = Date.now() - checkpoint.savedAt;
        // Only resume if checkpoint is < 1 hour old (stale checkpoints are ignored)
        if (elapsed < 3600000) {
            startStepIndex = checkpoint.completedStepCount;
            stepResults.push(...checkpoint.stepResults);
            cumulativeFindings = checkpoint.cumulativeFindings;
            started = checkpoint.startedAt;
            reportProgress(`🔄 Resuming from checkpoint: ${checkpoint.completedStepCount}/${effectivePipeline.steps.length} steps complete (saved ${Math.round(elapsed / 1000)}s ago)`);
        } else {
            await deleteCheckpoint();
        }
    }

    // ── Load persistent glossary for convergence pipelines ──
    let glossaryWarmStarted = false;
    if ((effectivePipeline.id === 'convergence-translation' || effectivePipeline.id === 'semantic-compilation') && !cumulativeFindings) {
        const saved = await loadGlossary();
        if (saved) {
            cumulativeFindings = `## 📖 Warm-Started Glossary (${saved.ageDays}d old, ${saved.termCount} terms)\n${saved.content}\n\n---\n`;
            glossaryWarmStarted = true;
            reportProgress(`📖 Warm-started glossary: ${saved.termCount} terms, ${saved.ageDays}d old — skipping Stage 2 jargon resolution`);
        }
    }

    for (let i = startStepIndex; i < effectivePipeline.steps.length; i++) {
        const step = effectivePipeline.steps[i];
        if (token.isCancellationRequested) break;

        // ── Glossary Warm-Start: skip jargon resolution if glossary is fresh ──
        if (glossaryWarmStarted && (step.id === 'conv-jargon' || step.id === 'sem-jargon')) {
            const skippedResult: StepResult = {
                stepId: step.id,
                label: `${step.label} (warm-started ⚡)`,
                mode: 'thorough',
                primaryResult: '⏭️ Skipped — warm-started from persistent glossary. Stage 1 intake will still run to analyze document structure.',
                costEstimateDollars: 0,
                durationMs: 0,
            };
            stepResults.push(skippedResult);
            reportProgress(`⚡ ${step.label}: skipped (warm-started glossary in use)`);
            continue;
        }

        reportProgress(`${step.label} (${step.mode})...`);

        // ── Cost Guardrail: estimate this step before running ──
        const estKey = `${step.mode}-${step.providers.primary.tier}`;
        const stepEstimate = STEP_COST_ESTIMATE[estKey] || 0.03;
        const projectedTotal = accumulatedCost + stepEstimate;
        if (projectedTotal > COST_WARN_80) {
            reportProgress(`💰 Cost warning: $${accumulatedCost.toFixed(2)} spent + ~$${stepEstimate.toFixed(2)} upcoming = $${projectedTotal.toFixed(2)} / $${MAX_COST_PER_RUN.toFixed(2)} cap`);
        }
        if (projectedTotal > MAX_COST_PER_RUN) {
            reportProgress(`🛑 Cost cap would be exceeded: $${projectedTotal.toFixed(2)} > $${MAX_COST_PER_RUN.toFixed(2)} — skipping step`);
            const skippedResult: StepResult = {
                stepId: step.id,
                label: `${step.label} (cost-capped 🛑)`,
                mode: step.mode,
                primaryResult: `⏭️ Skipped — would exceed $${MAX_COST_PER_RUN.toFixed(2)} cost cap. Accumulated: $${accumulatedCost.toFixed(2)}.`,
                costEstimateDollars: 0,
                durationMs: 0,
            };
            stepResults.push(skippedResult);
            continue;
        }

        // Build prompt from template
        let prompt = step.promptTemplate
            .replace('{focus}', focus || step.focusHint)
            .replace('{code}', context)
            .replace('{website_context}', context)
            .replace('{findings}', cumulativeFindings)
            .replace('{bug}', context)
            .replace('{fix}', cumulativeFindings)
            .replace('{ideas}', cumulativeFindings)
            .replace('{boundaries}', cumulativeFindings)
            .replace('{assumptions}', cumulativeFindings);

        // ── Context validation guard for convergence pipelines ──
        // If the source document wasn't loaded (user didn't select a file or
        // opened an empty editor), the LLM will hallucinate content instead of
        // translating the real document. Catch this early with a clear error.
        if ((effectivePipeline.id === 'convergence-translation' || effectivePipeline.id === 'semantic-compilation') && i === 0) {
            // Use context directly — it IS the document content that was placed into {code}.
            // Regex extraction from the prompt is fragile: Markdown documents contain ##
            // headings which falsely trigger the lookahead and truncate captured content.
            const codeContent = context.trim();
            const isTruncated = codeContent.length < 200 && (
                codeContent.includes('.md') ||
                codeContent.includes('.txt') ||
                codeContent.includes('C:\\') ||
                codeContent.includes('/') && !codeContent.includes(' ')
            );
            if (!codeContent || codeContent.length < 50 || isTruncated) {
                throw new Error(
                    `Convergence Translation needs the full source document.\n\n` +
                    `Instead I received: "${codeContent.slice(0, 100)}"\n\n` +
                    `Please select the source document file when prompted.\n` +
                    `The file content must be injected into the pipeline so models\n` +
                    `can translate it — LLMs cannot read files from your filesystem.`
                );
            }
            reportProgress(`📄 Source loaded: ${(codeContent.length / 1024).toFixed(1)}KB`);

            // ── Source Authenticity Check ──
            const auth = checkSourceAuthenticity(codeContent);
            if (!auth.plausible) {
                const warnMsg = `⚠️ Source authenticity check failed: ${auth.warnings.join('; ')}`;
                reportProgress(warnMsg);
                if (auth.flags.some(f => f.severity === 'high')) {
                    throw new Error(`Source document failed authenticity check:\n\n${auth.warnings.map(w => `• ${w}`).join('\n')}\n\nThe document may be garbled, fabricated, or corrupted. Please verify the source file and try again.`);
                }
            } else if (auth.warnings.length > 0) {
                reportProgress(`🔎 Authenticity: ${auth.domain} (${auth.confidence}% confidence) — ${auth.warnings.length} low-severity note(s)`);
            } else {
                reportProgress(`🔎 Authenticity: ${auth.domain} (${auth.confidence}% confidence) — passed`);
            }
        }

        let stepResult: StepResult;

        if (step.mode === 'thorough') {
            // ── Section-Aware Translation for convergence pipeline ──
            // Split large source documents by headings so each model call
            // handles ~2-4KB sections instead of 30-50KB monolithic prompts.
            if ((step.id === 'conv-translate' || step.id === 'sem-translate') && (effectivePipeline.id === 'convergence-translation' || effectivePipeline.id === 'semantic-compilation')) {
                const glossary = cumulativeFindings; // Stage 1 + Stage 2 outputs
                const r = await executeSectionAwareTranslate(
                    secrets, step, context, glossary,
                    focus || step.focusHint, token, reportProgress
                );
                stepResult = {
                    stepId: step.id,
                    label: `${step.label} (${r.sectionCount} sections)`,
                    mode: 'thorough',
                    primaryResult: r.primaryResult,
                    parallelResults: r.parallelResults,
                    costEstimateDollars: r.costDollars,
                    durationMs: r.durationMs,
                };
                // Aggregate section-aware results
                cumulativeFindings += `\n\n## ${step.label} (Section-Aware, ${r.sectionCount} sections)\n${r.primaryResult}\n`;
                if (r.parallelResults.length) {
                    cumulativeFindings += `\nParallel model translations:\n${r.parallelResults.map((p, i) => `[Model ${i + 2}]: ${p.slice(0, 500)}...(truncated)`).join('\n')}`;
                }
            } else {
                const r = await executeThoroughStep(secrets, step, prompt, token, reportProgress);
                stepResult = {
                    stepId: step.id,
                    label: step.label,
                    mode: 'thorough',
                    primaryResult: r.primaryResult,
                    parallelResults: r.parallelResults,
                    costEstimateDollars: r.costDollars,
                    durationMs: r.durationMs,
                };
                // Aggregate for next steps
                cumulativeFindings += `\n\n## ${step.label}\n${r.primaryResult}\n`;
                if (r.parallelResults.length) {
                    cumulativeFindings += `\nParallel perspectives:\n${r.parallelResults.map((p, i) => `[Model ${i + 2}]: ${p}`).join('\n')}`;
                }
            }
        } else if (step.mode === 'scrutinize') {
            const r = await executeScrutinizeStep(secrets, step, prompt, token, reportProgress);
            stepResult = {
                stepId: step.id,
                label: step.label,
                mode: 'scrutinize',
                primaryResult: r.primaryResult,
                reviewerNotes: r.reviewerNotes,
                costEstimateDollars: r.costDollars,
                durationMs: r.durationMs,
            };
            cumulativeFindings += `\n\n## ${step.label}\n${r.primaryResult}\n`;
            if (r.reviewerNotes.length) {
                cumulativeFindings += `\nReviewer feedback:\n${r.reviewerNotes.join('\n')}`;
            }
        } else {
            // Pioneer mode = thorough for now (exploratory parallel analysis)
            const r = await executeThoroughStep(secrets, step, prompt, token, reportProgress);
            stepResult = {
                stepId: step.id,
                label: step.label,
                mode: 'pioneer',
                primaryResult: r.primaryResult,
                parallelResults: r.parallelResults,
                costEstimateDollars: r.costDollars,
                durationMs: r.durationMs,
            };
            cumulativeFindings += `\n\n## ${step.label} (Pioneer)\n${r.primaryResult}\n`;
            if (r.parallelResults.length) {
                cumulativeFindings += `\nExploratory perspectives:\n${r.parallelResults.map((p, i) => `[Explorer ${i + 2}]: ${p}`).join('\n')}`;
            }
        }

        stepResults.push(stepResult);

        // ── Multi-model health check after translation ──
        if ((step.id === 'conv-translate' || step.id === 'sem-translate') && stepResult.mode === 'thorough') {
            const isError = (r: string) => r.startsWith('[') && r.includes('error');
            const allModelResults = [stepResult.primaryResult, ...(stepResult.parallelResults || [])];
            const healthy = allModelResults.filter(r => !!r && !isError(r));
            const total = allModelResults.length;
            const expected = 1 + (step.providers.parallel?.length || 0);
            if (healthy.length < expected) {
                const severity = healthy.length === 1 ? '⚠️ CRITICAL' : '⚠️ WARNING';
                const warning = `\n\n## ${severity}: Incomplete Multi-Model Consensus — ${healthy.length}/${expected} Models Responded\n**${expected - healthy.length} model(s) failed or timed out.**\n- 1-model consensus: **severely reduced reliability** — no cross-verification possible.\n- 2-model consensus: adjudication works but triangulation is limited.\n- *Review this translation carefully before publication.*\n`;
                cumulativeFindings += warning;
                reportProgress(`${severity}: Only ${healthy.length}/${expected} translation models responded — consensus weakened`);
            } else {
                reportProgress(`✅ Multi-model consensus healthy: all ${healthy.length}/${expected} models responded`);
            }
        }

        // ── Orchestration callback (step-by-step mode) ──
        if (onStepComplete) {
            const shouldContinue = await onStepComplete(i, stepResult, effectivePipeline.steps.length);
            if (!shouldContinue) {
                reportProgress(`⏸️ Orchestrator paused after step ${i + 1}/${effectivePipeline.steps.length}`);
                break;
            }
        }

        // ── Persist glossary after jargon resolution ──
        if (step.id === 'conv-jargon' || step.id === 'sem-jargon') {
            await saveGlossary(stepResult.primaryResult);
            reportProgress('💾 Glossary saved to .harmony/glossary.json');
        }

        // ── Generate Diff Viewer after adjudication ──
        if ((step.id === 'conv-adjudicate' || step.id === 'sem-adjudicate') && effectivePipeline.id !== 'triple-check') {
            try {
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
                const diffPath = await generateDiffViewer(context, stepResult.primaryResult, effectivePipeline.id, wsRoot);
                if (diffPath) {
                    stepResult.reviewerNotes = [...(stepResult.reviewerNotes || []), `📊 Diff viewer saved: ${diffPath}`];
                    reportProgress(`📊 Diff viewer saved to out/`);
                }
            } catch (e) {
                reportProgress(`⚠️ Diff viewer generation skipped: ${e}`);
            }
        }

        // ── Generate Dispute Ledger after adjudication ──
        if ((step.id === 'conv-adjudicate' || step.id === 'sem-adjudicate') && effectivePipeline.id !== 'triple-check') {
            try {
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
                const glossaryOutput = stepResults.find(s => s.stepId === 'conv-jargon' || s.stepId === 'sem-jargon')?.primaryResult || '';
                const ledger = autoResolveTermDisputes(stepResult.primaryResult, glossaryOutput);
                if (ledger.disputes.length > 0) {
                    const ledgerPath = await generateDisputeLedger(ledger, effectivePipeline.id, wsRoot);
                    if (ledgerPath) {
                        reportProgress(`📋 Dispute ledger: ${ledger.resolved}/${ledger.disputes.length} resolved — saved to out/`);
                    }
                } else {
                    reportProgress('📋 Dispute ledger: no disputes detected — all models agreed');
                }
            } catch (e) {
                reportProgress(`⚠️ Dispute ledger generation skipped: ${e}`);
            }

            // ── CN-Standard Numbering Preservation ──
            try {
                const numbering = validateCnStandardNumbering(context, stepResult.primaryResult);
                if (numbering.missing.length > 0) {
                    reportProgress(`🔢 CN-Standard: ${numbering.preserved.length}/${numbering.sourceNumbers.length} numbers preserved — ${numbering.missing.length} missing`);
                    if (numbering.cnPatternsDetected) {
                        stepResult.reviewerNotes = [...(stepResult.reviewerNotes || []), `🔢 CN-standard numbering: ${numbering.preserved.length}/${numbering.sourceNumbers.length} preserved. Missing: ${numbering.missing.slice(0, 5).join(', ')}${numbering.missing.length > 5 ? '...' : ''}`];
                    }
                } else if (numbering.sourceNumbers.length > 0) {
                    reportProgress(`🔢 CN-Standard: all ${numbering.sourceNumbers.length} section numbers preserved ✅`);
                }
            } catch (e) {
                // Non-critical — numbering check should never block pipeline
            }
        }

        // Save checkpoint after each step (resume on crash/restart)
        const totalSoFar = stepResults.reduce((sum, s) => sum + s.costEstimateDollars, 0);
        accumulatedCost = totalSoFar;
        
        // ── Cost milestone logging ──
        if (accumulatedCost > COST_WARN_50 && accumulatedCost - stepResult.costEstimateDollars <= COST_WARN_50) {
            reportProgress(`💰 Cost at 50%: $${accumulatedCost.toFixed(2)} / $${MAX_COST_PER_RUN.toFixed(2)}`);
        }
        
        await saveCheckpoint({
            pipelineId: effectivePipeline.id,
            completedStepCount: i + 1,
            stepResults: [...stepResults],
            cumulativeFindings,
            totalCostSoFar: totalSoFar,
            startedAt: started,
            savedAt: Date.now(),
        });
    }

    // Pipeline completed — clean up checkpoint
    await deleteCheckpoint();

    // ── Deterministic post-validation for convergence pipelines ──
    let validationSuffix = '';
    if (effectivePipeline.id === 'convergence-translation') {
        reportProgress('🔍 Running deterministic validators...');
        const firstMention = validateFirstMentionRules(cumulativeFindings);
        const coherence = validateHierarchicalCoherence(context, cumulativeFindings);

        validationSuffix = `\n\n---\n## 🔍 Deterministic Validation\n\n### First-Mention Rules\n${firstMention.summary}\n${firstMention.issues.map(i => `- ${i.severity === 'error' ? '❌' : i.severity === 'warning' ? '⚠️' : 'ℹ️'} **${i.type}**: ${i.detail}${i.location ? ` (${i.location})` : ''}`).join('\n')}\n\n### Hierarchical Coherence\n${coherence.summary}\n${coherence.issues.map(i => `- ${i.severity === 'error' ? '❌' : i.severity === 'warning' ? '⚠️' : 'ℹ️'} **${i.type}**: ${i.detail}`).join('\n')}`;

        reportProgress(`📋 Validation: ${firstMention.summary} | ${coherence.summary}`);
    }

    // ── Character Budget + Layout Agent (convergence pipelines only) ──
    let budgetReportSuffix = '';
    let finalSynthesisSource = cumulativeFindings;
    if (effectivePipeline.id === 'convergence-translation') {
        const { adjustedSynthesis, budgetReport } = await runCharacterBudgetAgent(
            secrets,
            cumulativeFindings,
            cumulativeFindings, // full pipeline output serves as glossary reference
            token,
            reportProgress
        );
        finalSynthesisSource = adjustedSynthesis;
        const budgetRows = budgetReport.sections.map(s => {
            const status = budgetReport.oversized.some(o => o.index === s.index) ? '🔴 Over' : '🟢 OK';
            return `| ${s.index}. ${s.heading.slice(0, 40)} | ${s.charCountCN} | ${s.charCountEN} | ${s.charCountTotal} | ${s.lineCount} | ${status} |`;
        }).join('\n');
        budgetReportSuffix = '\n\n---\n## 📏 Character Budget Report\n\n' +
            budgetReport.summary + '\n\n' +
            '| Section | CN Chars | EN Chars | Total | Lines | Status |\n' +
            '|:---|:---|:---|:---|:---|:---|\n' +
            budgetRows + '\n\n' +
            '**Total**: ' + budgetReport.totalCN + ' CN / ' + budgetReport.totalEN + ' EN / ' + budgetReport.totalChars + ' total chars';
        reportProgress(`📏 Budget: ${budgetReport.summary}`);
    }

    const totalDurationMs = Date.now() - started;
    const totalCost = stepResults.reduce((sum, s) => sum + s.costEstimateDollars, 0);
    
    // ── Cost summary + circuit breaker report ──
    const costPct = Math.round((totalCost / MAX_COST_PER_RUN) * 100);
    const costLabel = costPct <= 25 ? '●○○ Budget-friendly' : costPct <= 60 ? '●●○ Moderate' : costPct <= 90 ? '●●● Significant' : '⚠️ Near cap';
    reportProgress(`💰 Pipeline cost: $${totalCost.toFixed(2)} (${costPct}% of $${MAX_COST_PER_RUN.toFixed(2)} cap) — ${costLabel}`);
    
    // Report any tripped circuit breakers
    const trippedProviders: string[] = [];
    for (const [pid] of circuitBreakers) {
        if (isProviderBlocked(pid)) {
            trippedProviders.push(`${providerDisplayName(pid)}: ${getCircuitStatus(pid)}`);
        }
    }
    if (trippedProviders.length > 0) {
        reportProgress(`🔌 Circuit breakers tripped: ${trippedProviders.join(', ')}`);
    }

    const rawSynthesis = (finalSynthesisSource + validationSuffix + budgetReportSuffix).trim();

    // ── Privacy scan: redact accidental secrets before returning output ──
    const { sanitized, found } = sanitizePipelineOutput(rawSynthesis);
    if (found.length > 0) {
        reportProgress(`🔒 Privacy scan: redacted ${found.join(', ')}`);
    }

    // ── Bilingual Compilation: compile EN+ZH deliverable files ──
    let compiledPaths: { bilingualPath?: string; zhOnlyPath?: string } = {};
    if (effectivePipeline.id === 'semantic-compilation' || effectivePipeline.id === 'convergence-translation') {
        try {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
            reportProgress('📦 Compiling bilingual deliverable...');
            compiledPaths = await compileBilingualDeliverable(
                context, sanitized, effectivePipeline.id, wsRoot, reportProgress
            );
            // ── Git auto-commit compiled outputs ──
            if (compiledPaths.bilingualPath || compiledPaths.zhOnlyPath) {
                try {
                    await gitAutoCommitOutputs(
                        wsRoot,
                        compiledPaths,
                        effectivePipeline.id,
                        totalCost,
                        totalDurationMs,
                        reportProgress
                    );
                } catch (e) {
                    reportProgress(`⚠️ Git auto-commit skipped: ${e}`);
                }
            }
        } catch (e) {
            reportProgress(`⚠️ Bilingual compilation failed: ${e}`);
        }
    }

    return {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        steps: stepResults,
        totalCostDollars: Math.round(totalCost * 10000) / 10000,
        totalDurationMs,
        finalSynthesis: sanitized,
    };
}

// ── Git Auto-Commit for Compiled Outputs ─────────────────────────

async function gitAutoCommitOutputs(
    wsRoot: string,
    compiledPaths: { bilingualPath?: string; zhOnlyPath?: string },
    pipelineId: string,
    totalCost: number,
    totalDurationMs: number,
    reportProgress: (msg: string) => void
): Promise<void> {
    const { exec } = require('child_process') as typeof import('child_process');
    const filesToCommit: string[] = [];
    if (compiledPaths.bilingualPath) filesToCommit.push(path.relative(wsRoot, compiledPaths.bilingualPath));
    if (compiledPaths.zhOnlyPath) filesToCommit.push(path.relative(wsRoot, compiledPaths.zhOnlyPath));
    if (!filesToCommit.length) return;

    // Check git is available
    const gitAvailable = await new Promise<boolean>(resolve => {
        exec('git --version', { cwd: wsRoot, timeout: 5000 }, (err) => resolve(!err));
    });
    if (!gitAvailable) {
        reportProgress('📝 Git not available — skipping output versioning');
        return;
    }

    // Check we're in a git repo
    const isRepo = await new Promise<boolean>(resolve => {
        exec('git rev-parse --git-dir', { cwd: wsRoot, timeout: 5000 }, (err) => resolve(!err));
    });
    if (!isRepo) {
        reportProgress('📝 Not a git repository — skipping output versioning');
        return;
    }

    // Stage the output files
    const costStr = `$${totalCost.toFixed(2)}`;
    const durationStr = `${(totalDurationMs / 1000).toFixed(0)}s`;
    const dateStr = new Date().toISOString().slice(0, 10);
    const commitMsg = `📦 ${pipelineId} — ${dateStr} — ${costStr} — ${durationStr}`;

    await new Promise<void>((resolve, reject) => {
        const stageCmd = `git add ${filesToCommit.map(f => `"${f}"`).join(' ')}`;
        exec(stageCmd, { cwd: wsRoot, timeout: 10000 }, (err) => {
            if (err) {
                reportProgress(`📝 Git stage failed: ${err.message}`);
                resolve(); // non-blocking
                return;
            }
            exec(`git commit -m "${commitMsg}"`, { cwd: wsRoot, timeout: 15000 }, (commitErr, stdout) => {
                if (commitErr) {
                    // "nothing to commit" is OK (files unchanged)
                    if (commitErr.message.includes('nothing to commit') || commitErr.message.includes('nothing added')) {
                        reportProgress('📝 Git: outputs unchanged — nothing to commit');
                    } else {
                        reportProgress(`📝 Git commit skipped: ${commitErr.message}`);
                    }
                } else {
                    const shortHash = (stdout.match(/\[[\w-]+\s+([a-f0-9]{7})/) || [])[1] || '?';
                    reportProgress(`📝 Git commit: ${shortHash} — "${commitMsg}"`);
                }
                resolve();
            });
        });
    });
}

// ── Source Authenticity Check ───────────────────────────────────

export interface AuthenticityReport {
    domain: string;
    confidence: number;
    plausible: boolean;
    warnings: string[];
    flags: { type: string; detail: string; severity: 'low' | 'medium' | 'high' }[];
}

/**
 * Verify the pasted document is plausible before running expensive pipeline stages.
 * Checks: topic/domain detection, structure integrity, fabrication signals,
 * CN/GB standards awareness for relevant documents.
 */
export function checkSourceAuthenticity(content: string): AuthenticityReport {
    const text = content.trim();
    const warnings: string[] = [];
    const flags: AuthenticityReport['flags'] = [];

    // Empty or near-empty
    if (!text || text.length < 50) {
        return { domain: 'empty', confidence: 0, plausible: false, warnings: ['Document is empty or too short to analyze'], flags: [{ type: 'empty', detail: 'Content < 50 chars', severity: 'high' }] };
    }

    // ── Domain Detection ──
    const signals: Record<string, number> = {};
    const ci = text.toLowerCase();

    // CN / Chinese construction standards
    const cnTerms = ['cn-standard', 'gb/', 'gb/t', '\u56fd\u5bb6\u6807\u51c6', 'construction', 'building', '\u5efa\u7b51', '\u65bd\u5de5', '\u8bbe\u8ba1\u89c4\u8303', 'code for', 'standard for', 'technical specification'];
    for (const t of cnTerms) {
        if (ci.includes(t.toLowerCase())) signals['cn-standard'] = (signals['cn-standard'] || 0) + 1;
    }

    // General technical
    if (/^#{1,4}\s/.test(text)) signals['structured-doc'] = (signals['structured-doc'] || 0) + 5;
    if (/```[\s\S]*?```/.test(text)) signals['code-containing'] = (signals['code-containing'] || 0) + 1;
    if (/\|.*\|.*\|/.test(text)) signals['tables'] = (signals['tables'] || 0) + 2;
    if (/^\d+\.\s/.test(text)) signals['numbered-lists'] = (signals['numbered-lists'] || 0) + 2;

    // ── Structure Integrity ──
    if (!/^#{1,4}\s/.test(text) && text.length > 500) {
        warnings.push('Large document has no Markdown headings — structure may be flat or malformed');
        flags.push({ type: 'structure', detail: 'No headings in document > 500 chars', severity: 'low' });
    }

    // Check for heading hierarchy gaps (e.g., ### without ##)
    const h2s = (text.match(/^##\s/gm) || []).length;
    const h3s = (text.match(/^###\s/gm) || []).length;
    if (h3s > 0 && h2s === 0) {
        flags.push({ type: 'structure', detail: 'H3 headings found but no H2 — hierarchy may skip levels', severity: 'low' });
    }

    // ── Fabrication Signals ──
    // Very repetitive content
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length > 10) {
        const uniqueLines = new Set(lines.map(l => l.trim().slice(0, 80)));
        const repetitionRatio = uniqueLines.size / lines.length;
        if (repetitionRatio < 0.3 && lines.length > 20) {
            flags.push({ type: 'repetition', detail: `${(repetitionRatio * 100).toFixed(0)}% unique lines — highly repetitive`, severity: 'medium' });
            warnings.push('Document appears highly repetitive — may be generated filler or truncated');
        }
    }

    // Gibberish detection: high ratio of non-word characters
    const wordChars = (text.match(/[\w\u4e00-\u9fff]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    const wordRatio = totalChars > 0 ? wordChars / totalChars : 0;
    if (wordRatio < 0.5 && totalChars > 200) {
        flags.push({ type: 'gibberish', detail: `Only ${(wordRatio * 100).toFixed(0)}% word characters — may be garbled`, severity: 'high' });
        warnings.push('Document has very few readable characters — may be corrupted or garbled');
    }

    // All caps or no punctuation (possible paste error)
    const alphaChars = (text.match(/[a-zA-Z]/g) || []).length;
    const punctChars = (text.match(/[.,;:!?]/g) || []).length;
    if (alphaChars > 100 && punctChars === 0) {
        flags.push({ type: 'formatting', detail: 'No punctuation marks found in alphabetic text', severity: 'low' });
    }

    // ── CN/GB Standards Check ──
    const domain = signals['cn-standard'] >= 3 ? 'cn-standard' :
        signals['structured-doc'] >= 3 ? 'technical-document' :
        signals['code-containing'] >= 2 ? 'code-document' :
        'general-document';

    if (domain === 'cn-standard') {
        // Additional standards authenticity: check for standard numbering patterns
        const hasSectionNumbers = /\b\d+\.\d+\.\d+\b/.test(text) || /\b[A-Z]+\d+\b/.test(text);
        if (!hasSectionNumbers) {
            warnings.push('Document references CN/GB terms but lacks standard numbering patterns (e.g., 3.1.2, GB/T 50378)');
            flags.push({ type: 'cn-format', detail: 'Missing standard clause numbering', severity: 'low' });
        }
    }

    const plausible = !flags.some(f => f.severity === 'high');
    const confidence = domain === 'cn-standard' ? 85 : domain === 'technical-document' ? 70 : 50;

    return { domain, confidence, plausible, warnings, flags };
}

// ── CN-Standard Numbering Preservation ─────────────────────────────────

export interface NumberingReport {
    sourceNumbers: string[];
    translationNumbers: string[];
    preserved: string[];
    missing: string[];
    extra: string[];
    cnPatternsDetected: boolean;
    warnings: string[];
}

/**
 * Validate that section/clause numbers survive EN→ZH translation intact.
 * CN/GB standards use Arabic decimal numbering (e.g., 3.1.2, GB/T 50378),
 * which should be identical in both languages — Chinese standards use the
 * same numbering convention.
 *
 * This runs AFTER adjudication, comparing source to final translation output.
 * It is purely deterministic — no LLM calls.
 */
export function validateCnStandardNumbering(source: string, translation: string): NumberingReport {
    // Extract section numbers from source: patterns like 3.1.2, 5.2.1.3, A.1, GB/T 50378
    const numRegex = /\b(?:\d{1,3}\.)+\d{1,3}\b|GB\/T\s*\d[\d-]*|GB\s*\d[\d-]*|CJJ\s*\d[\d-]*|JGJ\s*\d[\d-]*|DB\s*\d[\d-]*/g;
    const srcNums = [...new Set(source.match(numRegex) || [])].sort();
    const trNums = [...new Set(translation.match(numRegex) || [])].sort();

    // Check which source numbers appear in translation
    const preserved: string[] = [];
    const missing: string[] = [];
    for (const num of srcNums) {
        if (translation.includes(num)) {
            preserved.push(num);
        } else {
            missing.push(num);
        }
    }

    // Translation numbers not in source (possible additions or chapter references)
    const extra = trNums.filter(n => !srcNums.includes(n));

    // Detect CN-standard patterns
    const cnPatternsDetected = /GB\/T|GB\s\d|CJJ|JGJ|DB\s\d/.test(source);

    const warnings: string[] = [];
    if (missing.length > 0) {
        const pct = srcNums.length > 0 ? Math.round((preserved.length / srcNums.length) * 100) : 100;
        warnings.push(`${missing.length}/${srcNums.length} section numbers missing from translation (${pct}% preserved)`);
        if (cnPatternsDetected && missing.some(n => /GB/.test(n))) {
            warnings.push('⚠️ CN standard reference numbers missing — translation may have dropped GB/T identifiers');
        }
    }

    return {
        sourceNumbers: srcNums,
        translationNumbers: trNums,
        preserved,
        missing,
        extra,
        cnPatternsDetected,
        warnings,
    };
}

// ── Diff Viewer ─────────────────────────────────────────────────

/**
 * Generate a side-by-side EN→ZH comparison file after adjudication.
 * Aligns sections by heading and shows original vs translated side by side.
 * Saved to out/ as a review artifact — no LLM calls, fully deterministic.
 */
export async function generateDiffViewer(
    source: string,
    translation: string,
    pipelineId: string,
    wsRoot: string
): Promise<string | undefined> {
    try {
        // Split both by ## headings
        const srcSections = splitByHeadings(source);
        const trSections = splitByHeadings(translation);

        const lines: string[] = [];
        lines.push('# 🔍 EN→ZH Translation Diff');
        lines.push('');
        lines.push(`**Pipeline**: \`${pipelineId}\` | **Generated**: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
        lines.push('');
        lines.push('> 💡 Left column = English source, Right column = Chinese translation');
        lines.push('> Sections are aligned by heading. Scroll to compare side by side.');
        lines.push('');
        lines.push('---');
        lines.push('');

        const maxSections = Math.max(srcSections.length, trSections.length);
        for (let i = 0; i < maxSections; i++) {
            const src = srcSections[i];
            const tr = trSections[i];

            if (src) {
                lines.push(`<details open>`);
                lines.push(`<summary>📖 ${src.heading || `Section ${i + 1}`}</summary>`);
                lines.push('');
                lines.push('<table>');
                lines.push('<tr><th width="50%">🇬🇧 English</th><th width="50%">🇨🇳 Chinese</th></tr>');
                lines.push('<tr>');
                lines.push(`<td>${escapeHtml(src.body.slice(0, 6000))}</td>`);
                lines.push(`<td>${escapeHtml((tr?.body || '—').slice(0, 6000))}</td>`);
                lines.push('</tr>');
                lines.push('</table>');
                lines.push('');
                lines.push('</details>');
                lines.push('');
            } else if (tr) {
                lines.push(`<details>`);
                lines.push(`<summary>📖 ${tr.heading} (no source match)</summary>`);
                lines.push('');
                lines.push(tr.body.slice(0, 4000));
                lines.push('');
                lines.push('</details>');
                lines.push('');
            }
        }

        lines.push('---');
        lines.push(`*Generated by Harmony DeepSwarm • ${srcSections.length} sections • ${(translation.length / 1024).toFixed(1)}KB output*`);

        // Write to out/
        const outDir = path.join(wsRoot, 'out');
        await fs.mkdir(outDir, { recursive: true });
        const dateStr = new Date().toISOString().slice(0, 10);
        const outPath = path.join(outDir, `diff-${pipelineId}-${dateStr}.md`);
        await fs.writeFile(outPath, lines.join('\n'), 'utf-8');
        return outPath;
    } catch (e) {
        console.error('[DiffViewer] Failed:', e);
        return undefined;
    }
}

function splitByHeadings(text: string): { heading: string; body: string }[] {
    const sections: { heading: string; body: string }[] = [];
    const parts = text.split(/^(?=##\s)/m);
    for (const part of parts) {
        const headingMatch = part.match(/^##\s+(.+)$/m);
        const heading = headingMatch ? headingMatch[1].trim() : '';
        const body = headingMatch ? part.replace(/^##\s+.+\n?/m, '').trim() : part.trim();
        if (body || heading) {
            sections.push({ heading, body });
        }
    }
    return sections;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Automated Tie-Breaking + Dispute Ledger ─────────────────────

export interface DisputeEntry {
    term: string;
    context: string;
    proposals: { model: string; translation: string; confidence?: string }[];
    winner: string;
    reason: string;
}

export interface DisputeLedger {
    disputes: DisputeEntry[];
    resolved: number;
    unresolved: number;
    strategy: string;
}

/**
 * Auto-resolve term disputes from adjudication output.
 * Strategy: glossary consistency > native-speaker priority > confidence-weighted voting.
 * DeepSeek weighted highest for Chinese, Gemini for technical terms, Qwen as tiebreaker.
 */
export function autoResolveTermDisputes(adjudicationOutput: string, glossary: string): DisputeLedger {
    const disputes: DisputeEntry[] = [];

    // Parse glossary for known terms
    const knownTerms = new Set<string>();
    const glossaryLines = glossary.split('\n');
    for (const line of glossaryLines) {
        const match = line.match(/^\|[^|]*\|\s*([^|]+)\s*\|/);
        if (match) knownTerms.add(match[1].trim().toLowerCase());
        // Also try key: value format
        const kv = line.match(/^[-*]\s+\*\*(.+?)\*\*\s*[:\-–]\s*(.+)$/);
        if (kv) knownTerms.add(kv[1].trim().toLowerCase());
    }

    // Find dispute blocks in adjudication output
    const disputePattern = /(?:dispute[d]?|conflict|disagree|divergent)\s*(?:term|translation)?\s*[:\-–]\s*(.+?)(?=\n(?:##|###|\n\n|---|$))/gis;
    const proposalPattern = /(?:deepseek|qwen|gemini|model)\s*[:\-–]\s*(.+?)(?=\n|$)/gi;

    let match;
    while ((match = disputePattern.exec(adjudicationOutput)) !== null) {
        const block = match[1] || match[0];
        const termMatch = block.match(/^\*\*(.+?)\*\*/);
        const term = termMatch ? termMatch[1] : 'unknown';
        const proposals: DisputeEntry['proposals'] = [];

        // Extract model proposals from the block
        let pm;
        while ((pm = proposalPattern.exec(block)) !== null) {
            const fullMatch = pm[0];
            const modelMatch = fullMatch.match(/^(deepseek|qwen|gemini|model)/i);
            const model = modelMatch ? modelMatch[1].charAt(0).toUpperCase() + modelMatch[1].slice(1) : 'Unknown';
            const translation = fullMatch.replace(/^(deepseek|qwen|gemini|model)\s*[:\-–]\s*/i, '').trim();
            if (translation.length < 200) {
                proposals.push({ model, translation });
            }
        }

        if (proposals.length < 2) continue;

        // ── Tie-Breaking Strategy ──
        let winner = '';
        let reason = '';

        // Rule 1: Glossary consistency — prefer term already in glossary
        const glossaryMatch = proposals.find(p => knownTerms.has(p.translation.toLowerCase()));
        if (glossaryMatch) {
            winner = glossaryMatch.translation;
            reason = `Glossary consistency: "${glossaryMatch.translation}" already in glossary`;
        }

        // Rule 2: Native-speaker priority for Chinese output
        if (!winner) {
            const deepseekProposal = proposals.find(p => p.model.toLowerCase().includes('deepseek'));
            if (deepseekProposal && deepseekProposal.translation) {
                winner = deepseekProposal.translation;
                reason = 'Native-speaker priority: DeepSeek (Chinese-native model) preferred for CN output';
            }
        }

        // Rule 3: Longest proposal (most likely complete)
        if (!winner) {
            proposals.sort((a, b) => b.translation.length - a.translation.length);
            winner = proposals[0].translation;
            reason = `Confidence-weighted: longest proposal selected (${proposals[0].model})`;
        }

        disputes.push({ term, context: block.slice(0, 200), proposals, winner, reason });
        proposalPattern.lastIndex = 0; // reset for next iteration
    }

    // If no structured disputes found, generate synthetic ones from parallel results
    if (disputes.length === 0) {
        // Check if adjudication mentions any disagreements at all
        const hasDisagreement = /disagree|conflict|differ|divergent|alternative/i.test(adjudicationOutput);
        if (hasDisagreement) {
            disputes.push({
                term: '(see adjudication)',
                context: 'Adjudication detected disagreements but could not parse structured disputes',
                proposals: [],
                winner: 'N/A',
                reason: 'Unstructured disagreement — manual review of adjudication output recommended'
            });
        }
    }

    const resolved = disputes.filter(d => d.winner && d.winner !== 'N/A').length;
    return {
        disputes,
        resolved,
        unresolved: disputes.length - resolved,
        strategy: 'Glossary consistency > Native-speaker priority (DeepSeek for CN) > Confidence-weighted voting'
    };
}

/**
 * Generate a dispute ledger Markdown file for audit trail.
 * Saved to out/ alongside the translation output.
 */
export async function generateDisputeLedger(
    ledger: DisputeLedger,
    pipelineId: string,
    wsRoot: string
): Promise<string | undefined> {
    if (ledger.disputes.length === 0) return undefined;

    try {
        const lines: string[] = [];
        lines.push('# 📋 Translation Dispute Ledger');
        lines.push('');
        lines.push(`**Pipeline**: \`${pipelineId}\` | **Date**: ${new Date().toISOString().slice(0, 10)}`);
        lines.push(`**Resolved**: ${ledger.resolved} | **Unresolved**: ${ledger.unresolved} | **Strategy**: ${ledger.strategy}`);
        lines.push('');
        lines.push('> This ledger catalogs every term dispute found during adjudication,');
        lines.push('> what each model proposed, which was chosen, and why.');
        lines.push('> Review this if you need to audit translation quality or retrain glossary.');
        lines.push('');
        lines.push('---');
        lines.push('');

        if (ledger.unresolved > 0) {
            lines.push(`⚠️ **${ledger.unresolved} dispute(s) could not be automatically resolved.**`);
            lines.push('Consider feeding these terms into the glossary for future runs.');
            lines.push('');
        }

        for (let i = 0; i < ledger.disputes.length; i++) {
            const d = ledger.disputes[i];
            const icon = d.winner && d.winner !== 'N/A' ? '✅' : '⚠️';
            lines.push(`### ${icon} Dispute ${i + 1}: **${d.term}**`);
            lines.push('');
            lines.push('| Model | Proposed Translation |');
            lines.push('|:---|:---|');
            for (const p of d.proposals) {
                lines.push(`| ${p.model} | ${p.translation.slice(0, 200)} |`);
            }
            if (d.proposals.length === 0) {
                lines.push(`| — | ${d.context.slice(0, 200)} |`);
            }
            lines.push('');
            lines.push(`**Winner**: ${d.winner}`);
            lines.push(`**Reason**: ${d.reason}`);
            lines.push('');
            lines.push('---');
            lines.push('');
        }

        const outDir = path.join(wsRoot, 'out');
        await fs.mkdir(outDir, { recursive: true });
        const dateStr = new Date().toISOString().slice(0, 10);
        const outPath = path.join(outDir, `dispute-ledger-${pipelineId}-${dateStr}.md`);
        await fs.writeFile(outPath, lines.join('\n'), 'utf-8');
        return outPath;
    } catch (e) {
        console.error('[DisputeLedger] Failed:', e);
        return undefined;
    }
}

// ── Batch Mode ──────────────────────────────────────────────────

export interface BatchFile {
    path: string;
    name: string;
    content: string;
    format: 'md' | 'txt' | 'html' | 'pdf' | 'docx';
}

export interface BatchResult {
    file: string;
    success: boolean;
    pipelineId: string;
    costDollars: number;
    durationMs: number;
    outputPaths: string[];
    error?: string;
}

export interface BatchSummary {
    totalFiles: number;
    succeeded: number;
    failed: number;
    totalCostDollars: number;
    totalDurationMs: number;
    results: BatchResult[];
}

/** Convert plain text to Markdown (wrap in code fence or preserve as-is) */
function txtToMarkdown(content: string): string {
    // If it looks structured, preserve; otherwise wrap for pipeline processing
    if (/^#{1,4}\s/m.test(content) || /^\*\s/m.test(content) || /^\d+\.\s/m.test(content)) {
        return content; // already markdown-ish
    }
    return `# Plain Text Document\n\n${content}`;
}

/** Naive HTML to Markdown (strip tags, preserve headings, lists, links) */
function htmlToMarkdown(content: string): string {
    let md = content
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
        .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n')
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
        .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
        .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
        .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
        .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
    return md.trim();
}

/**
 * Convert PDF to Markdown by extracting text layer.
 * Uses pdf-parse (Mozilla pdf.js wrapper) — no vision/OCR calls.
 * Each page becomes a ## heading section for pipeline compatibility.
 */
async function pdfToMarkdown(buf: Buffer): Promise<string> {
    const data = await pdfParse(buf);
    const lines: string[] = [];
    lines.push(`# PDF Document (${data.numpages} pages)`);
    lines.push('');
    // Split by form feeds (page breaks) and heading-like patterns
    const pages = data.text.split(/\f/);
    for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i].trim();
        if (!pageText) continue;
        // Try to detect a heading on the page
        const firstLine = pageText.split('\n')[0]?.trim() || '';
        const looksLikeHeading = firstLine.length < 100 && /^[A-Z\u4e00-\u9fff]/.test(firstLine);
        lines.push(`## Page ${i + 1}${looksLikeHeading ? ': ' + firstLine : ''}`);
        lines.push('');
        lines.push(pageText);
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * Convert DOCX to Markdown by extracting XML text from the ZIP archive.
 * DOCX files are ZIP archives containing word/document.xml.
 * No external libraries beyond Node.js built-ins needed.
 */
async function docxToMarkdown(buf: Buffer): Promise<string> {
    // DOCX is a ZIP file — use a simple ZIP reader approach
    // We read the raw bytes for the word/document.xml entry
    // ZIP local file header: PK\x03\x04 ... filename ... data
    const targetName = 'word/document.xml';
    const targetBytes = Buffer.from(targetName, 'utf-8');

    // Find the local file header for word/document.xml
    let offset = 0;
    while (offset < buf.length - 30) {
        // ZIP local file header signature
        if (buf[offset] !== 0x50 || buf[offset + 1] !== 0x4B || buf[offset + 2] !== 0x03 || buf[offset + 3] !== 0x04) {
            offset++;
            continue;
        }
        const nameLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);
        const nameStart = offset + 30;
        const nameEnd = nameStart + nameLen;
        if (nameEnd > buf.length) break;

        const entryName = buf.slice(nameStart, nameEnd).toString('utf-8');
        if (entryName === targetName) {
            const dataStart = nameEnd + extraLen;
            const compressedSize = buf.readUInt32LE(offset + 20);
            const compressionMethod = buf.readUInt16LE(offset + 8);

            let xmlBytes: Buffer;
            if (compressionMethod === 0) {
                // Stored (no compression)
                xmlBytes = buf.slice(dataStart, dataStart + compressedSize);
            } else if (compressionMethod === 8) {
                // Deflate — use Node.js zlib
                const zlib = await import('zlib');
                xmlBytes = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compressedSize));
            } else {
                throw new Error(`Unsupported DOCX compression method: ${compressionMethod}`);
            }

            const xml = xmlBytes.toString('utf-8');
            return extractDocxText(xml);
        }
        // Skip to next entry
        const compressedSize = buf.readUInt32LE(offset + 20);
        offset = nameEnd + extraLen + compressedSize;
    }

    throw new Error('word/document.xml not found in DOCX archive');
}

/** Extract human-readable text from DOCX word/document.xml */
function extractDocxText(xml: string): string {
    const lines: string[] = [];
    lines.push('# DOCX Document');
    lines.push('');

    // Extract paragraphs
    const paraRegex = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
    let paraMatch;
    while ((paraMatch = paraRegex.exec(xml)) !== null) {
        const paraXml = paraMatch[1];
        const textParts: string[] = [];
        const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        let textMatch;
        while ((textMatch = textRegex.exec(paraXml)) !== null) {
            textParts.push(textMatch[1]);
        }
        const text = textParts.join('');

        // Detect heading styles
        const styleMatch = paraXml.match(/<w:pStyle[^>]*w:val="([^"]*)"/);
        const style = styleMatch?.[1]?.toLowerCase() || '';

        if (text.trim()) {
            if (style.includes('heading1') || style === 'heading1') {
                lines.push(`# ${text.trim()}`);
            } else if (style.includes('heading2') || style === 'heading2') {
                lines.push(`## ${text.trim()}`);
            } else if (style.includes('heading3') || style === 'heading3') {
                lines.push(`### ${text.trim()}`);
            } else {
                lines.push(text.trim());
                lines.push('');
            }
        }
    }

    return lines.join('\n');
}

/**
 * Auto-detect and convert any supported file format to Markdown.
 * Supports: .md (pass-through), .txt, .html, .pdf, .docx
 */
export async function convertFileToMarkdown(
    filePath: string,
    content?: Buffer | string
): Promise<{ markdown: string; format: string; warnings: string[] }> {
    const ext = path.extname(filePath).toLowerCase();
    const warnings: string[] = [];

    if (!content) {
        content = await fs.readFile(filePath);
    }

    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const text = typeof content === 'string' ? content : buffer.toString('utf-8');

    switch (ext) {
        case '.md':
            return { markdown: text, format: 'md', warnings: [] };
        case '.txt':
            return { markdown: txtToMarkdown(text), format: 'txt', warnings };
        case '.html':
        case '.htm':
            return { markdown: htmlToMarkdown(text), format: 'html', warnings };
        case '.pdf':
            try {
                const pdfMd = await pdfToMarkdown(buffer);
                warnings.push(`PDF: ${(buffer.length / 1024).toFixed(0)}KB extracted — text-layer quality depends on source document`);
                return { markdown: pdfMd, format: 'pdf', warnings };
            } catch (err: any) {
                throw new Error(`PDF conversion failed: ${err.message}. Ensure pdf-parse is installed (npm install pdf-parse).`);
            }
        case '.docx':
            try {
                const docxMd = await docxToMarkdown(buffer);
                return { markdown: docxMd, format: 'docx', warnings };
            } catch (err: any) {
                throw new Error(`DOCX conversion failed: ${err.message}. The file may be corrupted or password-protected.`);
            }
        default:
            throw new Error(`Unsupported format: ${ext}. Supported: .md, .txt, .html, .pdf, .docx`);
    }
}

/**
 * Batch processor: translate all documents in a folder.
 * Respects cost caps, supports .md/.txt/.html, generates individual reports.
 */
export async function processBatch(
    secrets: vscode.SecretStorage,
    folderPath: string,
    pipelineId: string,
    focus: string,
    token: vscode.CancellationToken,
    reportProgress: (msg: string) => void,
    maxCostPerFile: number = 3.00,
    maxTotalCost: number = 20.00
): Promise<BatchSummary> {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const supportedExts = ['.md', '.txt', '.html', '.htm', '.pdf', '.docx'];
    const files: BatchFile[] = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!supportedExts.includes(ext)) continue;
        const fullPath = path.join(folderPath, entry.name);

        // Use convertFileToMarkdown for all formats
        const { markdown, format: detectedFormat, warnings } = await convertFileToMarkdown(fullPath);
        const format = detectedFormat as 'md' | 'txt' | 'html';

        if (warnings.length) {
            reportProgress(`  ⚠️ ${entry.name}: ${warnings.join('; ')}`);
        }

        files.push({ path: fullPath, name: entry.name, content: markdown, format });
    }

    if (!files.length) {
        throw new Error(`No supported files (.md/.txt/.html/.pdf/.docx) found in ${folderPath}`);
    }

    reportProgress(`📂 Batch: ${files.length} file(s) found in ${path.basename(folderPath)}`);

    const results: BatchResult[] = [];
    let totalCost = 0;
    let totalDuration = 0;

    for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) break;

        const file = files[i];

        // Cost guardrail
        if (totalCost >= maxTotalCost) {
            reportProgress(`🛑 Batch cost cap reached: ${totalCost.toFixed(2)} / ${maxTotalCost.toFixed(2)} — stopping`);
            break;
        }

        reportProgress(`📄 [${i + 1}/${files.length}] ${file.name} (${file.format})...`);

        try {
            const pipeline = getTemplateById(pipelineId);
            if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}`);

            const result = await runPipeline(
                secrets, pipeline, file.content, focus || 'Batch translation', token,
                (msg) => reportProgress(`  ${msg}`),
                undefined, undefined, undefined
            );

            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || folderPath;

            // Generate diff viewer
            const diffPath = await generateDiffViewer(file.content, result.finalSynthesis, pipelineId, wsRoot);

            // Generate dispute ledger from adjudication output
            const adjStep = result.steps.find(s => s.stepId === 'conv-adjudicate' || s.stepId === 'sem-adjudicate');
            let ledgerPath: string | undefined;
            if (adjStep) {
                const glossary = result.steps.find(s => s.stepId === 'conv-jargon' || s.stepId === 'sem-jargon')?.primaryResult || '';
                const ledger = autoResolveTermDisputes(adjStep.primaryResult, glossary);
                ledgerPath = await generateDisputeLedger(ledger, pipelineId, wsRoot);
            }

            const outputPaths = [];
            if (diffPath) outputPaths.push(diffPath);
            if (ledgerPath) outputPaths.push(ledgerPath);

            results.push({
                file: file.name,
                success: true,
                pipelineId,
                costDollars: result.totalCostDollars,
                durationMs: result.totalDurationMs,
                outputPaths,
            });

            totalCost += result.totalCostDollars;
            totalDuration += result.totalDurationMs;
            reportProgress(`  ✅ ${file.name}: ${result.totalCostDollars.toFixed(2)}, ${outputPaths.length} artifact(s)`);
        } catch (err: any) {
            results.push({
                file: file.name,
                success: false,
                pipelineId,
                costDollars: 0,
                durationMs: 0,
                outputPaths: [],
                error: err.message,
            });
            reportProgress(`  ❌ ${file.name}: ${err.message}`);
        }
    }

    const succeeded = results.filter(r => r.success).length;
    reportProgress(`📊 Batch complete: ${succeeded}/${files.length} succeeded, ${totalCost.toFixed(2)} total`);

    return {
        totalFiles: files.length,
        succeeded,
        failed: files.length - succeeded,
        totalCostDollars: Math.round(totalCost * 10000) / 10000,
        totalDurationMs: totalDuration,
        results,
    };
}

export function formatPipelineResult(result: PipelineResult): string {
    const lines: string[] = [];
    lines.push(`# 🧠 DeepSwarm: ${result.pipelineName}`);
    lines.push('');
    const costLabel = result.totalCostDollars < 0.05 ? '●○○ Low' : result.totalCostDollars < 0.20 ? '●●○ Medium' : '●●● Significant';
    lines.push(`**Pipeline**: \`${result.pipelineId}\` | **Steps**: ${result.steps.length} | **Cost**: ${costLabel} | **Duration**: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const step of result.steps) {
        const modeIcon = step.mode === 'thorough' ? '🔍' : step.mode === 'scrutinize' ? '🔬' : '🚀';
        lines.push(`## ${modeIcon} ${step.label} (${step.mode})`);
        lines.push(`> Duration: ${(step.durationMs / 1000).toFixed(1)}s`);
        lines.push('');
        lines.push('### Primary Analysis');
        lines.push(step.primaryResult);
        lines.push('');

        if (step.parallelResults?.length) {
            lines.push('### Parallel Perspectives');
            step.parallelResults.forEach((r, i) => {
                lines.push(`<details>`);
                lines.push(`<summary>Model ${i + 2}</summary>`);
                lines.push('');
                lines.push(r);
                lines.push('');
                lines.push(`</details>`);
                lines.push('');
            });
        }

        if (step.reviewerNotes?.length) {
            lines.push('### Reviewer Feedback');
            step.reviewerNotes.forEach(n => {
                lines.push(`> ${n.replace(/\n/g, '\n> ')}`);
                lines.push('');
            });
        }

        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

// ── Pipeline Auto-Detection ──────────────────────────────────────

export interface PipelineDetection {
    pipelineId: string;
    pipelineName: string;
    confidence: number; // 0-100
    reasons: string[];
}

/**
 * Detect which pipeline is best for the given document content.
 * Returns the recommended pipeline with confidence score and reasons.
 * Use to skip the manual pipeline picker when confidence is high.
 */
export function detectPipelineType(content: string): PipelineDetection {
    const text = content.trim();
    if (!text || text.length < 50) {
        return { pipelineId: '', pipelineName: 'Unknown', confidence: 0, reasons: ['Content too short to detect type'] };
    }

    const reasons: string[] = [];
    let scores: Record<string, number> = {
        'convergence-translation': 0,
        'semantic-compilation': 0,
        'code-review': 0,
        'architecture': 0,
        'bug-hunt': 0,
        'brainstorm': 0,
    };

    // YAML frontmatter → docs-as-code, strong signal
    const hasFrontmatter = /^---\s*\n[\s\S]*?\n---/.test(text);
    if (hasFrontmatter) {
        scores['semantic-compilation'] += 40;
        reasons.push('Contains YAML frontmatter');
    }

    // Heading structure → documentation/translation signal
    const headingCount = (text.match(/^#{1,3}\s/gm) || []).length;
    if (headingCount >= 3) {
        scores['semantic-compilation'] += 10;
        scores['convergence-translation'] += 10;
    }
    if (headingCount >= 5) {
        scores['semantic-compilation'] += 10;
        scores['convergence-translation'] += 10;
    }

    // Chinese standard references → convergence-translation
    const cnStandards = text.match(/GB\s*\d+[.-]?\d+|YD\/T\s*\d+|SJ\/T\s*\d+/gi);
    if (cnStandards && cnStandards.length >= 2) {
        scores['convergence-translation'] += 35;
        reasons.push(`${cnStandards.length} Chinese standard references detected (e.g., ${cnStandards[0]})`);
    } else if (cnStandards && cnStandards.length === 1) {
        scores['convergence-translation'] += 20;
        reasons.push('Chinese standard reference detected');
    }

    // Data center / green energy terms → convergence-translation
    const dcTerms = text.match(/\b(PUE|CUE|WUE|DCIE|CLF|ERF|Power Usage Effectiveness|Carbon Usage Effectiveness|Data Center|green energy|renewable energy|carbon neutral|碳中|数据中心|绿色能源)\b/gi);
    if (dcTerms && dcTerms.length >= 3) {
        scores['convergence-translation'] += 25;
        reasons.push('Data center / green energy terminology detected');
    }

    // High English content ratio → translation pipeline
    const totalChars = text.length;
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const englishRatio = (totalChars - cjkChars) / Math.max(totalChars, 1);
    if (englishRatio > 0.8 && totalChars > 500) {
        scores['convergence-translation'] += 15;
        scores['semantic-compilation'] += 10;
        reasons.push(`Primarily English content (${Math.round(englishRatio * 100)}%)`);
    }

    // Code signals → code-review
    const codeSignals = (text.match(/\b(function|class|const|let|var|import|export|async|await|return|if|for|while)\b/g) || []).length;
    if (codeSignals >= 10) {
        scores['code-review'] += 50;
        reasons.push('Source code detected (functions, classes, imports)');
    } else if (codeSignals >= 3) {
        scores['code-review'] += 20;
    }

    // Architecture/design discussion signals
    const archTerms = text.match(/\b(architecture|pattern|component|module|interface|dependency|scal|design pattern|SOLID|microservice|monolith)\b/gi);
    if (archTerms && archTerms.length >= 5) {
        scores['architecture'] += 30;
        reasons.push('Architecture discussion detected');
    }

    // Bug report signals
    const bugSignals = text.match(/\b(bug|error|crash|exception|fail|broken|unexpected|regression|race condition)\b/gi);
    if (bugSignals && bugSignals.length >= 4) {
        scores['bug-hunt'] += 30;
        reasons.push('Bug report signals detected');
    }

    // Find the highest scoring pipeline
    let bestId = '';
    let bestScore = 0;
    for (const [id, score] of Object.entries(scores)) {
        if (score > bestScore) {
            bestScore = score;
            bestId = id;
        }
    }

    // Confidence: 0-100 based on score and uniqueness
    const maxPossible = 70; // highest practical score
    let confidence = Math.min(Math.round((bestScore / maxPossible) * 100), 100);

    // Reduce confidence if no strong signal
    if (bestScore < 20) {
        confidence = Math.round(confidence * 0.5);
        reasons.unshift('Low confidence — multiple pipeline types possible');
    }

    // Map to display names
    const names: Record<string, string> = {
        'convergence-translation': '⚖️ Standard EN→ZH Translation',
        'semantic-compilation': '📦 Bilingual Document',
        'code-review': '🔍 Code Review',
        'architecture': '🏗️ Architecture Review',
        'bug-hunt': '🐛 Bug Hunt',
        'brainstorm': '💡 Brainstorm',
    };

    return {
        pipelineId: bestId,
        pipelineName: names[bestId] || bestId,
        confidence,
        reasons,
    };
}

// ── Bilingual Compilation ───────────────────────────────────────

/**
 * Extract YAML frontmatter from a Markdown string.
 * Returns { frontmatter: Record<string,string>, body: string } or null if no frontmatter.
 */
export function extractYamlFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } | null {
    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) return null;
    const frontmatter: Record<string, string> = {};
    const yamlBlock = match[1];
    const body = match[2];
    for (const line of yamlBlock.split('\n')) {
        const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
        if (kv) frontmatter[kv[1].trim()] = kv[2].trim();
    }
    return { frontmatter, body };
}

/**
 * Compile a bilingual Markdown deliverable from English source + Chinese translation.
 * Saves to out/ directory with side-by-side EN/ZH format.
 */
export async function compileBilingualDeliverable(
    englishSource: string,
    chineseTranslation: string,
    pipelineId: string,
    workspaceRoot: string,
    reportProgress: (msg: string) => void
): Promise<{ bilingualPath: string; zhOnlyPath: string }> {
    const outDir = path.join(workspaceRoot, 'out');
    await fs.mkdir(outDir, { recursive: true });

    // Extract YAML frontmatter from English source
    const yaml = extractYamlFrontmatter(englishSource);
    const sourceBody = yaml?.body || englishSource;
    const frontmatter = yaml?.frontmatter || {};

    // Generate filename from title or timestamp
    const docTitle = frontmatter.title || 'document';
    const safeName = docTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-').slice(0, 60);
    const timestamp = new Date().toISOString().slice(0, 10);

    // Build bilingual frontmatter
    const bilingualFrontmatter = [
        '---',
        `title: "${frontmatter.title || 'Untitled'}"`,
        `title_zh: "${frontmatter.title_zh || frontmatter.title || 'Untitled'}"`,
        `author: "${frontmatter.author || 'Harmony ⚖️ Convergence Translation'}"`,
        `date: "${frontmatter.date || timestamp}"`,
        `version: "${frontmatter.version || '1.0'}"`,
        `pipeline: "${pipelineId}"`,
        `compiled: "${new Date().toISOString()}"`,
        'language: bilingual',
        '---',
    ].join('\n');

    // Split English source into sections by ## headings
    const enSections = sourceBody.split(/(?=^## )/m);
    // Split Chinese translation into sections by ## headings
    const zhSections = chineseTranslation.split(/(?=^## )/m);

    // Build bilingual side-by-side
    const bilingualParts: string[] = [bilingualFrontmatter, '', '# 📦 Bilingual Compilation', ''];
    const maxSections = Math.max(enSections.length, zhSections.length);

    for (let i = 0; i < maxSections; i++) {
        const enSection = (enSections[i] || '').trim();
        const zhSection = (zhSections[i] || '').trim();
        if (!enSection && !zhSection) continue;

        // Try to extract a heading from the English section
        const headingMatch = enSection.match(/^## (.+)$/m);
        const sectionHeading = headingMatch ? headingMatch[1] : `Section ${i + 1}`;

        bilingualParts.push(`### ${sectionHeading}`);
        bilingualParts.push('');
        bilingualParts.push('<details open>');
        bilingualParts.push('<summary>🇬🇧 English</summary>');
        bilingualParts.push('');
        bilingualParts.push(enSection || '*(No English content)*');
        bilingualParts.push('');
        bilingualParts.push('</details>');
        bilingualParts.push('');
        bilingualParts.push('<details>');
        bilingualParts.push('<summary>🇨🇳 简体中文</summary>');
        bilingualParts.push('');
        bilingualParts.push(zhSection || '*(No Chinese translation)*');
        bilingualParts.push('');
        bilingualParts.push('</details>');
        bilingualParts.push('');
    }

    // Write bilingual file
    const bilingualPath = path.join(outDir, `${safeName}-bilingual-${timestamp}.md`);
    await fs.writeFile(bilingualPath, bilingualParts.join('\n'), 'utf-8');
    reportProgress(`📦 Bilingual deliverable: out/${path.basename(bilingualPath)}`);

    // Write clean ZH-only file
    const zhFrontmatter = [
        '---',
        `title: "${frontmatter.title_zh || frontmatter.title || 'Untitled'}"`,
        `author: "${frontmatter.author || 'Harmony ⚖️ Convergence Translation'}"`,
        `date: "${frontmatter.date || timestamp}"`,
        `version: "${frontmatter.version || '1.0'}"`,
        `pipeline: "${pipelineId}"`,
        `compiled: "${new Date().toISOString()}"`,
        'language: zh-CN',
        '---',
    ].join('\n');
    const zhOnlyPath = path.join(outDir, `${safeName}-zh-${timestamp}.md`);
    await fs.writeFile(zhOnlyPath, zhFrontmatter + '\n\n' + chineseTranslation, 'utf-8');
    reportProgress(`📦 ZH-only deliverable: out/${path.basename(zhOnlyPath)}`);

    return { bilingualPath, zhOnlyPath };
}

// ── Auto Triple-Check Audit ─────────────────────────────────────

let autoAuditRunning = false;

export interface AutoAuditResult {
    verdict: 'GO' | 'CAUTION' | 'NO-GO';
    summary: string;
    findings: string[];
    urgentIssues: string[];
}

/**
 * Run a lightweight single-pass audit on changed files.
 * Designed for the end-of-turn auto-reminder — much cheaper than the full pipeline.
 */
export async function runAutoTripleCheckAudit(
    secrets: vscode.SecretStorage,
    changedFiles: string[],
    userQuery: string,
    workspaceRoot: string,
    token: vscode.CancellationToken
): Promise<AutoAuditResult | null> {
    if (autoAuditRunning) return null; // race guard
    autoAuditRunning = true;

    try {
        // Skip .harmony/, node_modules/, dist/, and other gitignored paths
        const SKIP_PREFIXES = ['.harmony/', '.harmony-', 'node_modules/', 'dist/', 'out/', '.git/', '__pycache__/', '.vscode-test/'];
        const SKIP_FILES = new Set(['private-docs.md']); // intentional personal documents, not source code
        const filteredFiles = changedFiles.filter(f => !SKIP_PREFIXES.some(p => f.startsWith(p)) && !SKIP_FILES.has(f));

        if (filteredFiles.length === 0) return null;

        // Read changed files (cap ~50KB total)
        const MAX_TOTAL_BYTES = 50000;
        let totalBytes = 0;
        const fileContents: { file: string; content: string }[] = [];

        for (const relPath of filteredFiles.slice(0, 10)) {
            if (totalBytes >= MAX_TOTAL_BYTES) break;
            try {
                const absPath = path.resolve(workspaceRoot, relPath);
                const stat = await fs.stat(absPath);
                const readSize = Math.min(stat.size, MAX_TOTAL_BYTES - totalBytes, 15000);
                const buf = await fs.readFile(absPath);
                const content = buf.toString('utf-8').slice(0, readSize);
                fileContents.push({ file: relPath, content });
                totalBytes += Buffer.byteLength(content, 'utf-8');
            } catch {
                // Skip unreadable files
            }
        }

        if (!fileContents.length) return null;

        // Build focused audit prompt
        const codeBlock = fileContents
            .map(f => `### ${f.file}\n\`\`\`\n${f.content.slice(0, 8000)}\n\`\`\``)
            .join('\n\n');

        const prompt = `AUTOMATED SAFETY AUDIT — single pass, be brief.

⚠️ CRITICAL: Files below are BUDGET-TRUNCATED (max 8KB each). "[truncated]" markers are NORMAL and expected — they indicate the file was too large for this audit, NOT a bug. Do NOT flag truncation or partial code as errors.

You are checking code that was just changed in a chat turn for:
1. **Secrets/keys** — any API keys, tokens, passwords, or credentials accidentally left in code
2. **Private terms** — personal names, internal references, internal project names that shouldn't be public
3. **Logic issues** — obvious bugs, race conditions, null pointer risks (ignore truncation artifacts)

Original user request: ${userQuery.slice(0, 500)}

Changed files:
${codeBlock}

Return a JSON object with:
- "verdict": "GO" (all clear), "CAUTION" (minor issues), or "NO-GO" (secrets or critical bugs)
- "summary": one-line summary
- "findings": array of brief findings (max 5)
- "urgentIssues": array of issues that need immediate attention (empty if none)

ONLY return the JSON, no other text.`;

        const result = await consult(secrets, {
            provider: 'deepseek',
            tier: 'mid',
            question: prompt,
            system: 'You are a code safety auditor. Return only valid JSON. Be brief and precise.',
            maxTokens: 2048,
        }, token);

        // Parse the response — strip code fences first, then extract JSON
        let text = result.text.trim();
        // Remove markdown code fences if present (```json ... ``` or ``` ... ```)
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            text = fenceMatch[1].trim();
        }
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error('[TripleCheckAutoAudit] No JSON found in response:', text.slice(0, 500));
            return { verdict: 'CAUTION', summary: 'Audit response could not be parsed.', findings: [text.slice(0, 200)], urgentIssues: [] };
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                verdict: ['GO', 'CAUTION', 'NO-GO'].includes(parsed.verdict) ? parsed.verdict : 'CAUTION',
                summary: parsed.summary || 'Audit complete.',
                findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 5) : [],
                urgentIssues: Array.isArray(parsed.urgentIssues) ? parsed.urgentIssues.slice(0, 3) : [],
            };
        } catch (e: any) {
            console.error('[TripleCheckAutoAudit] JSON parse failed. Raw:', text.slice(0, 500), 'Error:', e?.message);
            return { verdict: 'CAUTION', summary: 'Audit response could not be parsed.', findings: [text.slice(0, 200)], urgentIssues: [] };
        }
    } catch (e: any) {
        if (e?.code === 'CANCELLED' || e?.name === 'CancellationError') return null;
        return { verdict: 'CAUTION', summary: `Audit failed: ${e?.message?.slice(0, 100) || 'unknown error'}`, findings: [], urgentIssues: [] };
    } finally {
        autoAuditRunning = false;
    }
}
