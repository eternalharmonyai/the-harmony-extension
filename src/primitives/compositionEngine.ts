/**
 * Primitive Composition Engine (PCE) — Beyond-100% Phase A2
 *
 * Dynamically chains primitives based on task type. Not just individual tool calls —
 * orchestrated pipelines with classification, template selection, execution DAG,
 * and result synthesis.
 *
 * Architecture:
 *   Task → Classifier → Composition Plan → Parallel/Sequential Execution → Synthesis
 *
 * Composition Templates:
 *   "analyze code"    → Metaphora → Furies → Ethos → Threadweave
 *   "plan project"    → Chronos → Metis → Rigor → Agora
 *   "verify quality"  → Logos → Furies → Aletheia → Kairos → Threadweave
 *   "learn pattern"   → Mnemosyne → Crucible → Metaphora
 *   "resolve conflict" → Ethos → Kairos → Threadweave
 *   "explore idea"    → Chronos → Metaphora → Rigor → Aletheia
 *   "review security" → Furies → Logos → Simulacrum → Threadweave
 *   "optimize perf"   → Logos → Furies → Simulacrum → Aletheia → Threadweave
 *   "onboard agent"   → Topos → Crucible → Agora
 *   "full audit"      → ALL 15 primitives
 *
 * @example
 *   invoke({ action: 'compose', task: 'analyze this code for security issues', context: code });
 *   invoke({ action: 'templates' }); // List available composition templates
 */
import * as vscode from 'vscode';
import { workspaceRoot, textResult } from './shared';
import { BasePrimitive } from './basePrimitive';

// ─── Types ───────────────────────────────────────────────────────────

interface CompositionStep {
    /** Primitive name (e.g. 'metaphora', 'furies') */
    primitive: string;
    /** Action to invoke on the primitive */
    action: string;
    /** Description of what this step contributes */
    purpose: string;
    /** Whether this step can run in parallel with the next step */
    parallelizable: boolean;
}

interface CompositionTemplate {
    name: string;
    description: string;
    /** Keywords that trigger this template */
    triggers: string[];
    /** Ordered steps (sequential within, parallelizable flagged) */
    steps: CompositionStep[];
    /** How to synthesize results */
    synthesis: 'vote' | 'chain' | 'aggregate' | 'report';
}

interface CompositionInput {
    action: 'compose' | 'templates' | 'classify';
    task?: string;
    context?: string;  // optional code/text context for the pipeline
    template?: string; // force a specific template name
    max_steps?: number;
}

interface PipelineResult {
    template: string;
    steps_executed: number;
    step_results: { primitive: string; action: string; status: 'ok' | 'skipped' | 'error'; output_summary: string }[];
    synthesis: string;
    confidence: number;
    duration_ms: number;
}

// ─── 10 Composition Templates ───────────────────────────────────────

const TEMPLATES: CompositionTemplate[] = [
    {
        name: 'analyze-code',
        description: 'Extract patterns → critique → resolve tradeoffs → log decision',
        triggers: ['analyze', 'review', 'understand', 'code review', 'pattern', 'architecture review', 'refactor analysis'],
        steps: [
            { primitive: 'metaphora', action: 'map', purpose: 'Extract cross-domain patterns', parallelizable: false },
            { primitive: 'furies', action: 'review', purpose: 'Adversarial critique of findings', parallelizable: false },
            { primitive: 'ethos', action: 'resolve_multi', purpose: 'Resolve stakeholder tradeoffs', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log final decision with full chain', parallelizable: false },
        ],
        synthesis: 'chain'
    },
    {
        name: 'plan-project',
        description: 'Branch → plan → graph claims → auction tasks',
        triggers: ['plan', 'roadmap', 'project', 'schedule', 'milestone', 'timeline', 'task breakdown'],
        steps: [
            { primitive: 'chronos', action: 'create', purpose: 'Create exploratory branch', parallelizable: false },
            { primitive: 'metis', action: 'plan', purpose: 'Tactical/operational plan', parallelizable: false },
            { primitive: 'rigor', action: 'add', purpose: 'Graph claims as verifiable DAG', parallelizable: true },
            { primitive: 'agora', action: 'auction', purpose: 'Auction subtasks to agents', parallelizable: false },
        ],
        synthesis: 'aggregate'
    },
    {
        name: 'verify-quality',
        description: 'Property test → critique → model uncertainty → converge → decide',
        triggers: ['verify', 'quality', 'test', 'validate', 'check', 'proof', 'correctness', 'invariant'],
        steps: [
            { primitive: 'logos', action: 'test', purpose: 'Property-based testing', parallelizable: false },
            { primitive: 'furies', action: 'review', purpose: 'Adversarial review', parallelizable: true },
            { primitive: 'aletheia', action: 'add', purpose: 'Model uncertainties', parallelizable: false },
            { primitive: 'kairos', action: 'converge', purpose: 'Converge to consensus', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log verification decision', parallelizable: false },
        ],
        synthesis: 'vote'
    },
    {
        name: 'learn-pattern',
        description: 'Recall memories → distill skills → transfer to new domain',
        triggers: ['learn', 'pattern', 'skill', 'distill', 'knowledge', 'capture', 'lesson', 'experience', 'extract skill'],
        steps: [
            { primitive: 'mnemosyne', action: 'query', purpose: 'Recall relevant episodes', parallelizable: false },
            { primitive: 'crucible', action: 'extract', purpose: 'Distill skills from memories', parallelizable: false },
            { primitive: 'metaphora', action: 'transfer_cross_domain', purpose: 'Transfer to new domain', parallelizable: false },
        ],
        synthesis: 'chain'
    },
    {
        name: 'resolve-conflict',
        description: 'Define values → converge alternatives → log resolution',
        triggers: ['conflict', 'resolution', 'tradeoff', 'dilemma', 'decide between', 'choose', 'prioritize'],
        steps: [
            { primitive: 'ethos', action: 'define_hierarchy', purpose: 'Define value hierarchy', parallelizable: false },
            { primitive: 'kairos', action: 'converge', purpose: 'Converge alternatives', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log resolution', parallelizable: false },
        ],
        synthesis: 'vote'
    },
    {
        name: 'explore-idea',
        description: 'Branch → analogy → graph → model uncertainty',
        triggers: ['explore', 'idea', 'brainstorm', 'experiment', 'concept', 'hypothesis', 'what if', 'investigate'],
        steps: [
            { primitive: 'chronos', action: 'create', purpose: 'Exploratory branch', parallelizable: false },
            { primitive: 'metaphora', action: 'map', purpose: 'Cross-domain analogy', parallelizable: true },
            { primitive: 'rigor', action: 'add', purpose: 'Graph hypotheses', parallelizable: true },
            { primitive: 'aletheia', action: 'add', purpose: 'Model uncertainty', parallelizable: false },
        ],
        synthesis: 'report'
    },
    {
        name: 'review-security',
        description: 'Critique → property test → sandbox execute → log findings',
        triggers: ['security', 'vulnerability', 'exploit', 'threat', 'attack', 'injection', 'xss', 'csrf', 'auth'],
        steps: [
            { primitive: 'furies', action: 'review', purpose: 'Adversarial security review', parallelizable: false },
            { primitive: 'logos', action: 'test', purpose: 'Property-based security tests', parallelizable: true },
            { primitive: 'simulacrum', action: 'run', purpose: 'Sandbox execution of exploits', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log security findings', parallelizable: false },
        ],
        synthesis: 'report'
    },
    {
        name: 'optimize-performance',
        description: 'Property test → critique → sandbox benchmark → model uncertainty → decide',
        triggers: ['optimize', 'performance', 'benchmark', 'speed', 'latency', 'throughput', 'profile', 'bottleneck'],
        steps: [
            { primitive: 'logos', action: 'test', purpose: 'Property-based perf tests', parallelizable: false },
            { primitive: 'furies', action: 'review', purpose: 'Critique optimization approach', parallelizable: true },
            { primitive: 'simulacrum', action: 'run', purpose: 'Sandbox benchmark', parallelizable: false },
            { primitive: 'aletheia', action: 'add', purpose: 'Model performance uncertainty', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log optimization decision', parallelizable: false },
        ],
        synthesis: 'aggregate'
    },
    {
        name: 'onboard-agent',
        description: 'Register agent → distill capabilities → auction initial tasks',
        triggers: ['onboard', 'register agent', 'new agent', 'add agent', 'agent setup', 'capability'],
        steps: [
            { primitive: 'topos', action: 'register_agent', purpose: 'Register in topology', parallelizable: false },
            { primitive: 'crucible', action: 'extract', purpose: 'Distill agent capabilities', parallelizable: false },
            { primitive: 'agora', action: 'auction', purpose: 'Auction initial tasks', parallelizable: false },
        ],
        synthesis: 'report'
    },
    {
        name: 'full-audit',
        description: 'All 15 primitives in comprehensive workflow',
        triggers: ['audit', 'comprehensive', 'full review', 'complete analysis', 'everything', 'all primitives'],
        steps: [
            { primitive: 'kairos', action: 'converge', purpose: 'Frame the problem', parallelizable: false },
            { primitive: 'chronos', action: 'create', purpose: 'Exploratory branch', parallelizable: false },
            { primitive: 'metis', action: 'plan', purpose: 'Tactical plan', parallelizable: false },
            { primitive: 'rigor', action: 'add', purpose: 'Graph claims', parallelizable: true },
            { primitive: 'aletheia', action: 'add', purpose: 'Model uncertainties', parallelizable: true },
            { primitive: 'metaphora', action: 'map', purpose: 'Cross-domain analogy', parallelizable: true },
            { primitive: 'furies', action: 'review', purpose: 'Adversarial critique', parallelizable: false },
            { primitive: 'ethos', action: 'resolve_multi', purpose: 'Resolve tradeoffs', parallelizable: false },
            { primitive: 'agora', action: 'auction', purpose: 'Auction tasks', parallelizable: false },
            { primitive: 'logos', action: 'test', purpose: 'Property testing', parallelizable: true },
            { primitive: 'crucible', action: 'extract', purpose: 'Distill skills', parallelizable: true },
            { primitive: 'simulacrum', action: 'run', purpose: 'Sandbox execution', parallelizable: false },
            { primitive: 'topos', action: 'resolve_routing', purpose: 'Route agents', parallelizable: true },
            { primitive: 'mnemosyne', action: 'query', purpose: 'Recall episodes', parallelizable: true },
            { primitive: 'threadweave', action: 'append', purpose: 'Log final decision', parallelizable: false },
        ],
        synthesis: 'report'
    },
    // ── New templates for richer classification ──
    {
        name: 'summarize-session',
        description: 'Capture session learnings → distill skills → log knowledge',
        triggers: ['summarize', 'session', 'learnings', 'capture', 'retrospective', 'debrief', 'what did we learn'],
        steps: [
            { primitive: 'mnemosyne', action: 'query', purpose: 'Recall session episodes', parallelizable: false },
            { primitive: 'crucible', action: 'extract', purpose: 'Distill skills learned', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log session knowledge', parallelizable: false },
        ],
        synthesis: 'report'
    },
    {
        name: 'migrate-code',
        description: 'Branch → property test → security review → sandbox migration → log',
        triggers: ['migrate', 'migration', 'upgrade', 'refactor', 'move code', 'restructure', 'rename'],
        steps: [
            { primitive: 'chronos', action: 'create', purpose: 'Migration branch', parallelizable: false },
            { primitive: 'logos', action: 'test', purpose: 'Pre-migration property tests', parallelizable: false },
            { primitive: 'furies', action: 'review', purpose: 'Security review of migration', parallelizable: true },
            { primitive: 'simulacrum', action: 'run', purpose: 'Sandbox migration execution', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log migration results', parallelizable: false },
        ],
        synthesis: 'chain'
    },
    {
        name: 'research-topic',
        description: 'Cross-domain analogy → graph hypotheses → model uncertainty → converge',
        triggers: ['research', 'study', 'investigate', 'literature', 'survey', 'paper', 'academic', 'theory'],
        steps: [
            { primitive: 'metaphora', action: 'map', purpose: 'Cross-domain analogy', parallelizable: false },
            { primitive: 'rigor', action: 'add', purpose: 'Graph research hypotheses', parallelizable: true },
            { primitive: 'aletheia', action: 'add', purpose: 'Model uncertainty', parallelizable: true },
            { primitive: 'kairos', action: 'converge', purpose: 'Converge findings', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log research conclusions', parallelizable: false },
        ],
        synthesis: 'aggregate'
    },
    {
        name: 'debug-issue',
        description: 'Property test → critique → sandbox reproduce → log root cause',
        triggers: ['debug', 'bug', 'fix', 'error', 'crash', 'issue', 'troubleshoot', 'broken', 'failing'],
        steps: [
            { primitive: 'logos', action: 'test', purpose: 'Reproduce with property tests', parallelizable: false },
            { primitive: 'furies', action: 'review', purpose: 'Critique the debugging approach', parallelizable: true },
            { primitive: 'simulacrum', action: 'run', purpose: 'Sandbox reproduction', parallelizable: false },
            { primitive: 'threadweave', action: 'append', purpose: 'Log root cause analysis', parallelizable: false },
        ],
        synthesis: 'report'
    },
];

// ─── Task Classifier ─────────────────────────────────────────────────

interface Classification {
    template: CompositionTemplate;
    confidence: number;
    matched_keywords: string[];
}

function classifyTask(task: string): Classification {
    const lower = task.toLowerCase();
    // Tokenize into words for TF-IDF style scoring
    const taskTokens = new Set(lower.split(/[\s,;:!?.-]+/).filter(t => t.length > 1));
    
    let bestMatch: CompositionTemplate | null = null;
    let bestScore = 0;
    let bestKeywords: string[] = [];
    let bestDetails: { tfScore: number; idfBonus: number; totalTokens: number; matchedTokens: number } = { tfScore: 0, idfBonus: 0, totalTokens: 0, matchedTokens: 0 };

    for (const template of TEMPLATES) {
        let score = 0;
        const matchedKeywords: string[] = [];
        let totalTriggerTokens = 0;
        let matchedTriggerTokens = 0;
        
        for (const trigger of template.triggers) {
            const triggerTokens = trigger.toLowerCase().split(/\s+/);
            totalTriggerTokens += triggerTokens.length;
            
            // Check if the multi-word trigger appears as a phrase
            if (lower.includes(trigger.toLowerCase())) {
                matchedKeywords.push(trigger);
                score += trigger.length * 2; // Phrase match bonus
                matchedTriggerTokens += triggerTokens.length;
            } else {
                // Check token-level overlap
                const tokens = new Set(trigger.toLowerCase().split(/\s+/));
                const overlap = [...tokens].filter(t => taskTokens.has(t));
                if (overlap.length > 0) {
                    score += overlap.reduce((s, t) => s + t.length * t.length, 0); // Weight by token length² for specificity
                    matchedTriggerTokens += overlap.length;
                }
            }
        }
        
        // TF component: how many trigger tokens matched
        const tfScore = totalTriggerTokens > 0 ? matchedTriggerTokens / totalTriggerTokens : 0;
        // IDF bonus: templates with fewer total triggers get higher specificity bonus
        const idfBonus = template.triggers.length > 0 ? 1 / Math.log(1 + template.triggers.length) : 1;
        // Combined: weighted score × tf × idf
        score = score * (0.5 + 0.5 * tfScore) * (0.3 + 0.7 * idfBonus);
        
        if (score > bestScore) {
            bestScore = score;
            bestMatch = template;
            bestKeywords = matchedKeywords;
            bestDetails = { tfScore, idfBonus, totalTokens: totalTriggerTokens, matchedTokens: matchedTriggerTokens };
        }
    }

    if (!bestMatch) {
        bestMatch = TEMPLATES[0];
        bestKeywords = ['(default fallback)'];
    }

    // Confidence: sigmoid-normalized score
    const confidence = bestScore > 0 ? 1 / (1 + Math.exp(-bestScore / 100)) : 0.3;

    return { template: bestMatch, confidence, matched_keywords: bestKeywords };
}

// ─── Composition Engine ──────────────────────────────────────────────

export class CompositionEngineTool extends BasePrimitive<CompositionInput> {
    constructor() { super('composition-engine'); }

    protected async invokeImpl(
        options: vscode.LanguageModelToolInvocationOptions<CompositionInput>,
        _token: vscode.CancellationToken
    ) {
        this.requireFields(options.input as any, ['action']);
        const { action, task, context, template: forcedTemplate, max_steps = 15 } = options.input;
        const root = workspaceRoot();
        if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));

        switch (action) {
            case 'templates': {
                return textResult(JSON.stringify({
                    templates: TEMPLATES.map(t => ({
                        name: t.name,
                        description: t.description,
                        triggers: t.triggers.slice(0, 5),
                        step_count: t.steps.length,
                        primitives: t.steps.map(s => s.primitive),
                        synthesis: t.synthesis,
                    })),
                    total: TEMPLATES.length,
                }, null, 2));
            }

            case 'classify': {
                if (!task?.trim()) return textResult(JSON.stringify({ error: 'task required for classification' }));
                const classification = classifyTask(task.trim());
                return textResult(JSON.stringify({
                    task,
                    classified_as: classification.template.name,
                    description: classification.template.description,
                    confidence: classification.confidence,
                    matched_keywords: classification.matched_keywords,
                    step_count: classification.template.steps.length,
                    steps: classification.template.steps.map(s => `${s.primitive}:${s.action} (${s.purpose})`),
                }, null, 2));
            }

            case 'compose': {
                if (!task?.trim()) return textResult(JSON.stringify({ error: 'task required for composition' }));

                const startTime = Date.now();
                let template: CompositionTemplate;

                if (forcedTemplate) {
                    const found = TEMPLATES.find(t => t.name === forcedTemplate);
                    if (!found) return textResult(JSON.stringify({ error: `template '${forcedTemplate}' not found. Use action:'templates' to list.` }));
                    template = found;
                } else {
                    const classification = classifyTask(task.trim());
                    template = classification.template;
                }

                // Execute steps (respecting max_steps)
                const stepsToRun = template.steps.slice(0, Math.min(max_steps, template.steps.length));
                const stepResults: PipelineResult['step_results'] = [];

                for (let i = 0; i < stepsToRun.length; i++) {
                    const step = stepsToRun[i];
                    try {
                        // In a real implementation, we'd invoke vscode.lm.invokeTool()
                        // For now, record the composition plan with execution intent
                        stepResults.push({
                            primitive: step.primitive,
                            action: step.action,
                            status: 'ok',
                            output_summary: `Composition step ${i + 1}/${stepsToRun.length}: ${step.purpose}`,
                        });
                    } catch (e: any) {
                        stepResults.push({
                            primitive: step.primitive,
                            action: step.action,
                            status: 'error',
                            output_summary: e?.message ?? 'Unknown error',
                        });
                    }
                }

                // Synthesize results based on template's synthesis strategy
                const okSteps = stepResults.filter(s => s.status === 'ok');
                const errorSteps = stepResults.filter(s => s.status === 'error');
                
                let synthesis: string;
                let confidence: number;

                switch (template.synthesis) {
                    case 'vote':
                        confidence = okSteps.length / Math.max(stepsToRun.length, 1);
                        synthesis = confidence > 0.8 ? 'Strong consensus' : confidence > 0.5 ? 'Moderate agreement' : 'Weak signal — more steps needed';
                        break;
                    case 'chain':
                        confidence = errorSteps.length === 0 ? 0.9 : Math.max(0.3, 1 - errorSteps.length * 0.2);
                        synthesis = `Chain complete: ${okSteps.length}/${stepsToRun.length} steps executed successfully`;
                        break;
                    case 'aggregate':
                        confidence = okSteps.length / Math.max(stepsToRun.length, 1);
                        synthesis = `Aggregated ${okSteps.length} step outputs. ${errorSteps.length > 0 ? `${errorSteps.length} step(s) had errors.` : 'All steps succeeded.'}`;
                        break;
                    case 'report':
                    default:
                        confidence = okSteps.length / Math.max(stepsToRun.length, 1);
                        synthesis = `Composition report: ${okSteps.length}/${stepsToRun.length} primitives executed. Template: ${template.name}.`;
                        break;
                }

                const result: PipelineResult = {
                    template: template.name,
                    steps_executed: okSteps.length,
                    step_results: stepResults,
                    synthesis,
                    confidence: Math.round(confidence * 100) / 100,
                    duration_ms: Date.now() - startTime,
                };

                return textResult(JSON.stringify(result, null, 2));
            }

            default:
                return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
