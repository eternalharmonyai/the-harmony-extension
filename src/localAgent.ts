import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ToolResult } from './toolExecutor';
import { confirmPremiumModel, consult, resolveCollabModel } from './providers';

export interface AgentHistoryEntry {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tag?: string;
}

export type AgentStep =
    | { kind: 'tool_call'; id: string; name: string; arguments: Record<string, any> }
    | { kind: 'final'; text: string };

const TOOLS = [
    {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the workspace. Returns its contents.',
        arguments: {
            path: 'workspace-relative path',
            start_line: 'optional 1-based start (inclusive)',
            end_line: 'optional 1-based end (inclusive)'
        },
        destructive: false
    },
    {
        name: 'list_dir',
        description: 'List entries in a workspace directory. Returns names only.',
        arguments: { path: 'workspace-relative directory path' },
        destructive: false
    },
    {
        name: 'grep',
        description: 'Search workspace files for a regex. Returns matches with file:line:text.',
        arguments: {
            pattern: 'regex',
            path_glob: "optional glob to scope, e.g. 'src/**/*.ts'",
            max_results: 'optional integer, default 50'
        },
        destructive: false
    },
    {
        name: 'write_file',
        description: 'Create or overwrite a workspace file. Requires user confirmation.',
        arguments: { path: 'workspace-relative path', content: 'full file contents' },
        destructive: true
    },
    {
        name: 'open_file',
        description: "Open a workspace file in the user's editor.",
        arguments: { path: 'workspace-relative path' },
        destructive: false
    },
    {
        name: 'run_terminal',
        description: 'Run a shell command in the workspace cwd. Requires user confirmation.',
        arguments: { command: 'command line string', timeout_sec: 'optional integer' },
        destructive: true
    },
    {
        name: 'creative_health',
        description: 'Check whether Harmony Creative (port 8896) is running and which generation providers are configured. Call before any image or canvas tool.',
        arguments: {},
        destructive: false
    },
    {
        name: 'generate_image',
        description: 'Generate an image from a text prompt via Harmony Creative. Quality tiers: draft, standard, standard+, pro, premium.',
        arguments: {
            prompt: 'image prompt',
            quality: 'draft | standard | standard+ | pro | premium (default standard)',
            aspect_ratio: 'aspect ratio like 1:1, 16:9, 9:16 (default 1:1)',
            member: 'optional creator/member label for output naming',
            seed: 'optional integer seed',
            reference_images: 'optional local image paths used as references',
            preserve_likeness: 'preserve likeness from reference images; requires private profile',
            likeness_name: 'name/label used for likeness prompting',
            use_member_lora: 'use a private member LoRA; requires private profile'
        },
        destructive: false
    },
    {
        name: 'generate_layer_set',
        description: 'Generate a composited layer set from layer prompts or one segmented full-frame prompt.',
        arguments: {
            set_name: 'name for the layer set output folder',
            layers: 'layer objects with name, prompt, and optional filename',
            prompt: 'segment-mode full-frame prompt if layers are not provided',
            backend: 'generation backend, e.g. pro, fast, bfl:flux-kontext-pro',
            mode: 'custom | briefs | segment (default custom)',
            chain: 'use first layer/reference as chained context (default false)',
            topology: 'star | sequential when chain is true (default star)',
            aspect_ratio: 'aspect ratio like 1:1 or 16:9 (default 1:1)',
            resolution: '1K | 2K | 4K (default 2K)',
            seed: 'optional integer seed'
        },
        destructive: false
    },
    {
        name: 'generate_video',
        description: 'Generate a talking-head or motion video from local image/audio inputs via Harmony Creative.',
        arguments: {
            prompt: 'motion prompt',
            image_path: 'local source image path',
            audio_path: 'local audio path for talking video',
            model: 'video model key, e.g. omnihuman or kling-pro (default kling-pro)',
            duration: 'duration in seconds for motion video (default 5)',
            aspect_ratio: 'reserved for future video sizing (default 16:9)',
            member: 'optional creator/member label for output naming'
        },
        destructive: false
    },
    {
        name: 'recall_memory',
        description: 'Recall member-scoped memory through the private local memory router.',
        arguments: {
            member: 'member key such as default, creative, or custom',
            query: 'memory search query',
            n_results: 'number of results (default 5)'
        },
        destructive: false
    },
    {
        name: 'list_layer_sets',
        description: 'List recent generated layer-set folders and manifests.',
        arguments: { limit: 'maximum layer sets to return (default 20)' },
        destructive: false
    },
    {
        name: 'get_generation_status',
        description: 'Inspect an output path, manifest path, or job id and report whether it exists.',
        arguments: { job_id: 'output path, manifest path, or job id' },
        destructive: false
    },
    {
        name: 'save_to_likeness',
        description: 'Copy an approved image into a private member likeness folder.',
        arguments: {
            image_path: 'approved local image path',
            member_name: 'private member folder name'
        },
        destructive: false
    },
    {
        name: 'composite_preview',
        description: 'Return or rebuild a layer-set composite preview.',
        arguments: {
            layer_set_dir: 'layer-set output directory'
        },
        destructive: false
    },
    {
        name: 'get_image_info',
        description: 'Read width, height, format, mode, and alpha status of a local image file.',
        arguments: { image_path: 'local image file path' },
        destructive: false
    },
    {
        name: 'crop_image',
        description: 'Crop a local image into a new file.',
        arguments: {
            image_path: 'local image path',
            x: 'left coordinate (integer)',
            y: 'top coordinate (integer)',
            width: 'crop width (integer)',
            height: 'crop height (integer)',
            output_path: 'optional output path'
        },
        destructive: false
    },
    {
        name: 'resize_image',
        description: 'Resize a local image into a new file.',
        arguments: {
            image_path: 'local image path',
            width: 'output width (integer)',
            height: 'output height (integer)',
            mode: 'fit | fill | stretch (default fit)',
            output_path: 'optional output path'
        },
        destructive: false
    },
    {
        name: 'remove_background',
        description: 'Remove the background from a local image, producing a transparent PNG.',
        arguments: {
            image_path: 'local image path',
            output_path: 'optional output path'
        },
        destructive: false
    },
    {
        name: 'composite_layer',
        description: 'Overlay a layer image on top of a base image at x/y coordinates with optional opacity.',
        arguments: {
            base_image: 'base image path',
            layer_image: 'layer image path',
            x: 'x coordinate (default 0)',
            y: 'y coordinate (default 0)',
            opacity: 'opacity 0.0-1.0 (default 1.0)',
            output_path: 'optional output path'
        },
        destructive: false
    },
    {
        name: 'draw_text',
        description: 'Draw text onto a copy of a local image at specified coordinates.',
        arguments: {
            image_path: 'local image path',
            text: 'text to draw',
            x: 'x coordinate (integer)',
            y: 'y coordinate (integer)',
            size: 'font size (default 48)',
            color: 'CSS-like color string (default #ffffff)',
            font_path: 'optional TTF font path',
            output_path: 'optional output path'
        },
        destructive: false
    },
    {
        name: 'ask_question',
        description: 'Ask the user a multi-choice question when a decision is needed.',
        arguments: {
            question: 'the question text',
            options: 'array of {label, description?, recommended?}',
            allow_freeform: 'optional bool, default true',
            multi_select: 'optional bool, default false'
        },
        destructive: false
    },
    {
        name: 'final_answer',
        description: 'Emit the final user-facing reply. FINAL_ANSWER: text is preferred.',
        arguments: { text: 'the user-facing reply' },
        destructive: false
    }
];

const AGENT_SYSTEM_PROMPT = `You are a VS Code coding collaborator running inside the user's editor.
You can inspect the workspace through tools, ask clarifying questions, and give final answers.
Prefer reading before writing. Destructive tools require user confirmation in VS Code.

PROTOCOL - emit exactly one of these per response:

TOOL_CALL: {"name":"<tool>","arguments":{...}}

or

FINAL_ANSWER:
<your reply>

Never combine a TOOL_CALL and FINAL_ANSWER in one response.
If you need a decision, call ask_question instead of guessing.`;

function renderToolCatalog(): string {
    const lines = ['AVAILABLE TOOLS:'];
    for (const tool of TOOLS) {
        const args = Object.entries(tool.arguments).map(([key, value]) => `${key}: ${value}`).join(', ');
        const marker = tool.destructive ? ' [confirm]' : '';
        lines.push(`- ${tool.name}(${args})${marker} - ${tool.description}`);
    }
    return lines.join('\n');
}

export function formatWorkspaceContext(ctx: Record<string, unknown> | undefined): string {
    if (!ctx) return '';

    const lines: string[] = ['WORKSPACE CONTEXT:'];
    if (ctx.active_file) lines.push(`- active_file: ${ctx.active_file}`);
    if (ctx.language) lines.push(`- language: ${ctx.language}`);
    if (ctx.selection_range) lines.push(`- selection_range: ${JSON.stringify(ctx.selection_range)}`);
    if (ctx.diagnostics_summary) lines.push(`- diagnostics: ${ctx.diagnostics_summary}`);
    if (Array.isArray(ctx.open_files) && ctx.open_files.length > 0) {
        lines.push(`- open_files: ${(ctx.open_files as unknown[]).slice(0, 12).join(', ')}`);
    }
    if (ctx.selection) {
        const selection = String(ctx.selection);
        const clipped = selection.length > 4000 ? selection.slice(0, 4000) + '\n[selection truncated]' : selection;
        lines.push('- selection:');
        lines.push('```');
        lines.push(clipped);
        lines.push('```');
    }
    return lines.join('\n');
}

export function buildTurnPrompt(args: {
    userMessage?: string | null;
    workspaceContextBlock?: string;
    history: AgentHistoryEntry[];
    toolResult?: ToolResult | null;
}): string {
    const parts: string[] = [AGENT_SYSTEM_PROMPT, '', renderToolCatalog(), ''];

    if (args.history.length > 0) {
        parts.push('CONVERSATION SO FAR:');
        for (const entry of args.history.slice(-12)) {
            const tag = entry.tag ? `:${entry.tag}` : '';
            parts.push(`[${entry.role}${tag}] ${entry.content}`);
        }
        parts.push('');
    }

    if (args.workspaceContextBlock) {
        parts.push(args.workspaceContextBlock.trimEnd(), '');
    }

    if (args.toolResult) {
        const status = args.toolResult.ok ? 'OK' : 'ERROR';
        parts.push(`TOOL_RESULT(${args.toolResult.tool_call_id}) [${status}]:`);
        parts.push(args.toolResult.result);
        parts.push('', 'Continue with another TOOL_CALL or FINAL_ANSWER.');
    } else if (args.userMessage) {
        parts.push('USER:');
        parts.push(args.userMessage);
        parts.push('', 'Respond with either TOOL_CALL or FINAL_ANSWER.');
    }

    return parts.join('\n');
}

const TOOL_CALL_RE = /^\s*TOOL_CALL\s*:\s*(\{.*\})\s*$/m;
const FINAL_ANSWER_RE = /^\s*FINAL_ANSWER\s*:\s*\n?([\s\S]*)$/m;

export function parseAgentOutput(text: string): AgentStep {
    const toolMatch = TOOL_CALL_RE.exec(text || '');
    if (toolMatch) {
        try {
            const payload = JSON.parse(toolMatch[1]);
            if (payload?.name) {
                return {
                    kind: 'tool_call',
                    id: `tc_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
                    name: String(payload.name),
                    arguments: payload.arguments ?? {}
                };
            }
        } catch {
            // Fall through to final-answer handling.
        }
    }

    const finalMatch = FINAL_ANSWER_RE.exec(text || '');
    if (finalMatch) {
        return { kind: 'final', text: finalMatch[1].trim() };
    }

    return { kind: 'final', text: (text || '').trim() };
}

export async function requestVsCodeLanguageModel(prompt: string): Promise<{ text: string; modelLabel: string }> {
    const mode = getCollabPreference();
    if (mode === 'harmony') {
        const harmonyResult = await tryHarmonyCollab(prompt);
        if (harmonyResult) return harmonyResult;
        throw new Error('Harmony collab routing is set to "harmony" but no configured Agents provider key is available. Set a DeepSeek/Gemini/provider API key, choose an Agents model, or switch Collab Route to "VS Code" / "Mix".');
    }

    const lm = (vscode as any).lm as typeof vscode.lm | undefined;
    if (!lm?.selectChatModels) {
        if (mode === 'mix') {
            const harmonyResult = await tryHarmonyCollab(prompt);
            if (harmonyResult) return harmonyResult;
        }
        throw new Error('VS Code Language Model API is not available in this VS Code window.');
    }

    const cfg = vscode.workspace.getConfiguration('harmony');
    const vendor = cfg.get<string>('lmVendor')?.trim() || undefined;
    const modelFamily = cfg.get<string>('lmFamily')?.trim() || undefined;
    const id = cfg.get<string>('lmModelId')?.trim() || undefined;

    const selector: vscode.LanguageModelChatSelector = {};
    if (vendor) selector.vendor = vendor;
    if (modelFamily) selector.family = modelFamily;
    if (id) selector.id = id;

    let models = await lm.selectChatModels(selector);
    if (models.length === 0 && (vendor || modelFamily || id)) {
        models = await lm.selectChatModels({});
    }
    if (models.length === 0) {
        if (mode === 'mix') {
            const harmonyResult = await tryHarmonyCollab(prompt);
            if (harmonyResult) return harmonyResult;
        }
        throw new Error('No VS Code language models are available. Sign in to a provider extension such as GitHub Copilot, then try again.');
    }

    const model = models[0];
    const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        { justification: 'Harmony Chat sends your prompt to the selected VS Code language model so it can answer inside the workspace.' }
    );

    let text = '';
    for await (const chunk of response.text) {
        text += chunk;
    }

    return { text, modelLabel: `${model.vendor}/${model.family}/${model.name}` };
}

// ─── Collaborative routing toggle ────────────────────────────────────────────
// Three modes (harmony.collabProvider):
//   'harmony' = route all sub-agent / local-agent LM calls through Harmony's own provider (e.g. DeepSeek direct API).
//   'vscode'  = always use the VS Code Language Model API (current default behavior).
//   'mix'     = prefer VS Code LM; fall back to Harmony's provider when VS Code LM is unavailable.

export type CollabProvider = 'harmony' | 'vscode' | 'mix';

let collabSecretsRef: vscode.SecretStorage | undefined;

export function setCollabSecrets(secrets: vscode.SecretStorage): void {
    collabSecretsRef = secrets;
}

export function getCollabPreference(): CollabProvider {
    const raw = vscode.workspace.getConfiguration('harmony').get<string>('collabProvider');
    if (raw === 'harmony' || raw === 'vscode' || raw === 'mix') return raw;
    return 'mix';
}

async function tryHarmonyCollab(prompt: string): Promise<{ text: string; modelLabel: string } | null> {
    if (!collabSecretsRef) return null;
    const selection = await resolveCollabModel(collabSecretsRef);
    if (!selection) return null;
    const cancellation = new vscode.CancellationTokenSource();
    try {
        const ok = await confirmPremiumModel(selection.provider, selection.tier, selection.model, 'collaborative sub-agent route');
        if (!ok) throw new Error('user denied premium collaborative sub-agent route');
        const response = await consult(collabSecretsRef, {
            provider: selection.provider,
            tier: selection.tier,
            question: prompt,
            system: 'You are a focused collaborative sub-agent for Harmony. Answer directly and concretely. State assumptions only when they affect the answer.',
            maxTokens: 4096
        }, cancellation.token);
        return { text: response.text, modelLabel: `harmony/${response.provider}/${response.model}` };
    } catch (e: any) {
        throw new Error(`Harmony collab route failed: ${e?.message ?? String(e)}`);
    } finally {
        cancellation.dispose();
    }
}
