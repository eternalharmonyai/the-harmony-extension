import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import { registerHarmonyTools } from './lmTools';
import { registerVisualTools } from './visualTools';
import { registerCompanyTools } from './companyTools';
import { registerOpsTools } from './opsTools';
import { registerSelfTools } from './selfTools';
import { registerCognitionTools } from './cognitionTools';
import { registerRepairRestore } from './repairRestore';
import { registerEvidenceTools } from './evidenceTools';
import { registerResearchUpgradeTools } from './researchTools';
import { initializeErrorLearning } from './careBloom';
import { registerProviderRegistryTools } from './providerRegistryTools';
import { buildQuickPickEntries } from './providerModels';
import { registerSwarmTools } from './swarmTools';
import { registerDeepOrchestrate } from './deepOrchestrate';
import { getTemplateById, listTemplateIds, runPipeline, formatPipelineResult, detectPipelineType, checkSourceAuthenticity, generateDiffViewer, autoResolveTermDisputes, generateDisputeLedger, processBatch, convertFileToMarkdown, type DeepSwarmPipeline, type ProviderStrategy, type BatchSummary, getStrategyPreset } from './deepSwarm';
import { buildWebsiteContext, type WebsiteSourceType } from './websiteContextBuilder';
import { detectWorkspaceProject, offerDevServer, startDevServer, stopDevServer } from './projectAutoDetect';
import { registerSymbolTools } from './symbolTools';
import { registerChatHistoryProvider } from './chatHistory';
import { registerHarmonyParticipant } from './chatParticipant';
import { registerDeepSeekProvider } from './deepseekProvider';
import { registerHarmonyView } from './sidebar';
import { openComposeView } from './composeView';
import { CollabDirectProvider, CollabModelPreset, collabTierForPreset, consult, countProviderKeys, discoverModels, EndpointProviderId, getCollabDirectProvider, getCollabModelPreset, getProviderKeys, invalidateKeyCache, isProviderId, KEY_SLOTS, migrateLegacyToSlots, modelFor, providerDisplayName, providerEndpointInfo, PROVIDER_IDS, ProviderId, resolveCollabModel, secretKeyFor, setProviderKeys, Tier } from './providers';
import { clearUsage, onUsageChange, summarize as summarizeUsage, totalCalls, totalTokens } from './costTracker';
import { listSessions, deleteSession } from './sessions';
import { createHandoffPacket } from './memory';
import { harmonySelfCleanup, formatBytes } from './cleanup';
import { writeWhisper, readUnread, markAllRead, markRead, getUnreadCount, onWhisperChange, formatWhispersForPrompt, Whisper } from './whisperInbox';
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import { initSecrets, initBundledCreativePath } from './toolExecutor';
import { setCollabSecrets } from './localAgent';

type ProviderEnvImport = {
    provider: ProviderId;
    label: string;
    secretKey: string;
    envNames: string[];
    /** Multi-key slot mapping: {slotIndex: [envVarNames]}. 0=Chat, 1=Agents, 2=External, 3=Vision. */
    slotEnvNames?: Record<number, string[]>;
    pairedKey?: string;
    pairedEnvNames?: string[];
};

const PROVIDER_ENV_IMPORTS: ProviderEnvImport[] = [
    {
        provider: 'deepseek',
        label: 'DeepSeek',
        secretKey: 'harmony.deepseekApiKey',
        envNames: ['HARMONY_DEEPSEEK_API_KEY', 'DEEPSEEK_AGENT_API_KEY', 'DEEPSEEK_EXTERNAL_API_KEY', 'EXTERNAL_UI_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'],
        slotEnvNames: {
            0: ['DEEPSEEK_API_KEY'],
            1: ['DEEPSEEK_AGENT_API_KEY'],
            2: ['DEEPSEEK_EXTERNAL_API_KEY']
        }
    },
    {
        provider: 'alibaba',
        label: 'Alibaba / Qwen',
        secretKey: 'harmony.alibaba.apiKey',
        envNames: ['HARMONY_ALIBABA_API_KEY', 'ALIBABA_AGENT_API_KEY', 'ALIBABA_EXTERNAL_API_KEY', 'ALIBABA_API_KEY', 'ALIBABA_VISION_API_KEY', 'DASHSCOPE_API_KEY', 'Alibaba_API_KEY'],
        slotEnvNames: {
            0: ['ALIBABA_API_KEY'],
            1: ['ALIBABA_AGENT_API_KEY'],
            2: ['ALIBABA_EXTERNAL_API_KEY'],
            3: ['ALIBABA_VISION_API_KEY']
        }
    },
    {
        provider: 'moonshot',
        label: 'Moonshot / Kimi',
        secretKey: 'harmony.moonshot.apiKey',
        envNames: ['HARMONY_MOONSHOT_API_KEY', 'MOONSHOT_AGENT_API_KEY', 'MOONSHOT_EXTERNAL_API_KEY', 'MOONSHOT_API_KEY', 'Moonshot_API_KEY'],
        slotEnvNames: {
            0: ['MOONSHOT_API_KEY'],
            1: ['MOONSHOT_AGENT_API_KEY'],
            2: ['MOONSHOT_EXTERNAL_API_KEY']
        }
    },
    {
        provider: 'kimiCode' as ProviderId,
        label: 'KimiCode',
        secretKey: 'harmony.kimiCode.apiKey',
        envNames: ['HARMONY_KIMICODE_API_KEY', 'KIMICODE_AGENT_API_KEY', 'KIMICODE_EXTERNAL_API_KEY', 'KIMICODE_API_KEY'],
        slotEnvNames: {
            0: ['KIMICODE_API_KEY'],
            1: ['KIMICODE_AGENT_API_KEY'],
            2: ['KIMICODE_EXTERNAL_API_KEY']
        }
    },
    {
        provider: 'zhipu' as ProviderId,
        label: 'Zhipu (Z.AI / GLM)',
        secretKey: 'harmony.zhipu.apiKey',
        envNames: ['HARMONY_ZHIPU_API_KEY', 'Z_API_KEY', 'Z_AGENT_API_KEY', 'Z_VISION_API_KEY', 'Z_EXTERNAL_API_KEY'],
        slotEnvNames: {
            0: ['Z_API_KEY'],
            1: ['Z_AGENT_API_KEY'],
            2: ['Z_EXTERNAL_API_KEY'],
            3: ['Z_VISION_API_KEY']
        }
    },
    {
        provider: 'gemini' as ProviderId,
        label: 'Gemini',
        secretKey: 'harmony.geminiApiKey',
        envNames: ['GEMINI_API_KEY'],
        slotEnvNames: {
            0: ['GEMINI_API_KEY']
        }
    },
    {
        provider: 'openrouter' as ProviderId,
        label: 'OpenRouter',
        secretKey: 'harmony.openrouter.apiKey',
        envNames: ['OPENROUTER_API_KEY'],
        slotEnvNames: {
            0: ['OPENROUTER_API_KEY']
        }
    },
    {
        provider: 'openai' as ProviderId,
        label: 'OpenAI',
        secretKey: 'harmony.openaiApiKey',
        envNames: ['openai_api_key', 'OPENAI_API_KEY'],
        slotEnvNames: {
            0: ['openai_api_key', 'OPENAI_API_KEY']
        }
    },
    {
        provider: 'claude' as ProviderId,
        label: 'Anthropic (Claude)',
        secretKey: 'harmony.claudeApiKey',
        envNames: ['Claude', 'CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'],
        slotEnvNames: {
            0: ['Claude', 'CLAUDE_API_KEY']
        }
    },
    {
        provider: 'tencent' as ProviderId,
        label: 'Tencent / Hunyuan (OpenAI-compatible)',
        secretKey: 'harmony.tencent.apiKey',
        envNames: ['HARMONY_TENCENT_API_KEY', 'TENCENT_API_KEY', 'TENCENT_AGENT_API_KEY', 'TENCENT_EXTERNAL_API_KEY', 'TENCENT_VISION_API_KEY']
    },
    {
        provider: 'tencent' as ProviderId,
        label: 'Tencent / Hunyuan (native SecretId+SecretKey)',
        secretKey: 'harmony.tencent.secretId',
        pairedKey: 'harmony.tencent.secretKey',
        envNames: ['TENCENT_SecretID', 'TENCENT_SecretID_AGENT', 'TENCENT_AGENT_SecretId', 'TENCENT_SecretID_EXTERNAL', 'TENCENT_SecretID_VISION'],
        pairedEnvNames: ['TENCENT_SecretKey', 'TENCENT_SecretKey_AGENT', 'TENCENT_AGENT_SecretKey', 'TENCENT_SecretKey_EXTERNAL', 'TENCENT_SecretKey_VISION']
    }
];

function normalizeImportedProviderKey(value: string | undefined): string {
    return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, '').trim();
}

function parseDotenvEntry(line: string): { name: string; value: string } | undefined {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return undefined;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = withoutExport.indexOf('=');
    if (equalsIndex <= 0) return undefined;
    const name = withoutExport.slice(0, equalsIndex).trim();
    let value = withoutExport.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return { name, value: normalizeImportedProviderKey(value) };
}

function parseDotenvEntries(text: string): Map<string, string> {
    const entries = new Map<string, string>();
    for (const entry of text.replace(/^\uFEFF/, '').split(/\r?\n/).map(parseDotenvEntry).filter(Boolean) as { name: string; value: string }[]) {
        if (entry.value && !entries.has(entry.name)) entries.set(entry.name, entry.value);
    }
    return entries;
}

function summarizeHubLogTail(text: string, maxLines = 8): string {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(-maxLines)
        .join(' | ');
}

const OOM_DIAGNOSTIC_MAX_LOG_SESSIONS = 12;
const OOM_DIAGNOSTIC_MAX_LOG_FILES = 120;
const OOM_DIAGNOSTIC_MAX_FILE_BYTES = 2_000_000;
const OOM_DIAGNOSTIC_MAX_MATCHES = 500;
const OOM_DIAGNOSTIC_MAX_LINE_LENGTH = 1000;

type OomDiagnosticLogMatch = {
    product: string;
    filePath: string;
    line: number;
    modifiedAt: string;
    text: string;
};

type OomDiagnosticCrashReport = {
    product: string;
    filePath: string;
    modifiedAt: string;
    sizeBytes: number;
};

type OomDiagnosticReport = {
    version: number;
    generatedAt: string;
    appName: string;
    workspaceRoot: string;
    logRootsScanned: string[];
    limits: Record<string, number>;
    summary: {
        logMatches: number;
        rendererOomMatches: number;
        harmonyActivationMatches: number;
        extensionHostTerminationMatches: number;
        crashReports: number;
    };
    crashReports: OomDiagnosticCrashReport[];
    logMatches: OomDiagnosticLogMatch[];
    notes: string[];
};

const OOM_DIAGNOSTIC_PATTERNS = [
    /reason:\s*'?oom/i,
    /renderer process gone/i,
    /out of memory/i,
    /heap/i,
    /CodeWindow/i,
    /Extension host terminating/i,
    /terminate message from renderer/i,
    /harmony\.harmony-extension/i,
    /harmony\.controlPanel/i,
    /onView:harmony\.controlPanel/i,
    /\[HUD\]|harmony[-.]?hud/i,
    /ms-edgedevtools/i,
    /unresponsive/i,
    /chat session/i,
    /agent files from provider/i,
];

function sanitizeDiagnosticLine(line: string): string {
    return line
        .replace(/(authorization\s*[:=]\s*)\S+/ig, '$1[redacted]')
        .replace(/(api[-_ ]?key\s*[:=]\s*)\S+/ig, '$1[redacted]')
        .replace(/(token\s*[:=]\s*)\S+/ig, '$1[redacted]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[redacted]')
        .slice(0, OOM_DIAGNOSTIC_MAX_LINE_LENGTH);
}

function isOomDiagnosticLine(line: string): boolean {
    return OOM_DIAGNOSTIC_PATTERNS.some(pattern => pattern.test(line));
}

async function safeStat(filePath: string): Promise<{ mtime: Date; size: number; isDirectory: () => boolean; isFile: () => boolean } | undefined> {
    try {
        return await fs.stat(filePath);
    } catch {
        return undefined;
    }
}

async function listLogFilesBounded(root: string, maxFiles: number): Promise<string[]> {
    const files: string[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
        if (files.length >= maxFiles || depth > 5) return;
        let entries: import('fs').Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= maxFiles) return;
            const next = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(next, depth + 1);
                continue;
            }
            if (entry.isFile() && /\.(log|txt|json|jsonl)$/i.test(entry.name)) files.push(next);
        }
    }
    await walk(root, 0);
    return files;
}

async function collectOomLogMatches(product: string, appRoot: string): Promise<{ rootsScanned: string[]; matches: OomDiagnosticLogMatch[] }> {
    const logsRoot = path.join(appRoot, 'logs');
    const rootsScanned: string[] = [];
    const matches: OomDiagnosticLogMatch[] = [];
    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(logsRoot, { withFileTypes: true });
    } catch {
        return { rootsScanned, matches };
    }
    const sessions: { fullPath: string; mtime: Date }[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(logsRoot, entry.name);
        const stat = await safeStat(fullPath);
        if (stat) sessions.push({ fullPath, mtime: stat.mtime });
    }
    sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    for (const session of sessions.slice(0, OOM_DIAGNOSTIC_MAX_LOG_SESSIONS)) {
        rootsScanned.push(session.fullPath);
        const files = await listLogFilesBounded(session.fullPath, OOM_DIAGNOSTIC_MAX_LOG_FILES);
        for (const filePath of files) {
            if (matches.length >= OOM_DIAGNOSTIC_MAX_MATCHES) return { rootsScanned, matches };
            const stat = await safeStat(filePath);
            if (!stat || stat.size > OOM_DIAGNOSTIC_MAX_FILE_BYTES) continue;
            let text = '';
            try {
                text = await fs.readFile(filePath, 'utf8');
            } catch {
                continue;
            }
            const lines = text.split(/\r?\n/);
            for (let index = 0; index < lines.length; index++) {
                if (!isOomDiagnosticLine(lines[index])) continue;
                matches.push({
                    product,
                    filePath,
                    line: index + 1,
                    modifiedAt: stat.mtime.toISOString(),
                    text: sanitizeDiagnosticLine(lines[index].trim()),
                });
                if (matches.length >= OOM_DIAGNOSTIC_MAX_MATCHES) return { rootsScanned, matches };
            }
        }
    }
    return { rootsScanned, matches };
}

async function collectCrashReports(product: string, appRoot: string): Promise<OomDiagnosticCrashReport[]> {
    const reportsRoot = path.join(appRoot, 'Crashpad', 'reports');
    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(reportsRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    const reports: OomDiagnosticCrashReport[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(reportsRoot, entry.name);
        const stat = await safeStat(fullPath);
        if (!stat) continue;
        reports.push({ product, filePath: fullPath, modifiedAt: stat.mtime.toISOString(), sizeBytes: stat.size });
    }
    reports.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    return reports.slice(0, 20);
}

function formatOomDiagnosticMarkdown(report: OomDiagnosticReport, jsonPath: string): string {
    const lines = [
        '# Harmony OOM Diagnostic Report',
        '',
        `Generated: ${report.generatedAt}`,
        `App: ${report.appName}`,
        `Workspace: ${report.workspaceRoot}`,
        `JSON: ${jsonPath}`,
        '',
        '## Summary',
        '',
        `- Matching log lines: ${report.summary.logMatches}`,
        `- Renderer/OOM matches: ${report.summary.rendererOomMatches}`,
        `- Harmony activation matches: ${report.summary.harmonyActivationMatches}`,
        `- Extension-host termination matches: ${report.summary.extensionHostTerminationMatches}`,
        `- Crashpad reports listed: ${report.summary.crashReports}`,
        '',
        '## Read This First',
        '',
        '- Renderer OOM means the VS Code window process ran out of memory. The extension host can then exit cleanly because the renderer closed the connection.',
        '- This report is bounded and redacts obvious authorization/token/API-key patterns. It records matching log lines and dump metadata, not dump contents.',
        '- A Harmony activation line near an OOM is timing evidence only. It is not proof that Harmony caused the renderer memory spike.',
        '',
        '## Crashpad Reports',
        '',
        report.crashReports.length ? report.crashReports.map(item => `- ${item.modifiedAt} | ${item.product} | ${item.sizeBytes} bytes | ${item.filePath}`).join('\n') : '- None found in recent report folders.',
        '',
        '## Matching Log Lines',
        '',
        report.logMatches.length ? report.logMatches.map(item => `- ${item.product} | ${item.filePath}:${item.line} | ${item.text}`).join('\n') : '- No matching log lines found.',
        '',
        '## Log Roots Scanned',
        '',
        report.logRootsScanned.length ? report.logRootsScanned.map(item => `- ${item}`).join('\n') : '- No VS Code/Cursor log roots found.',
        '',
        '## Notes',
        '',
        ...report.notes.map(note => `- ${note}`),
        '',
    ];
    return lines.join('\n');
}

async function writeOomDiagnosticReport(context: vscode.ExtensionContext): Promise<string> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath;
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const products = [
        { name: 'VS Code', root: path.join(appData, 'Code') },
        { name: 'Cursor', root: path.join(appData, 'Cursor') },
    ];
    const logRootsScanned: string[] = [];
    const logMatches: OomDiagnosticLogMatch[] = [];
    const crashReports: OomDiagnosticCrashReport[] = [];
    for (const product of products) {
        const rootStat = await safeStat(product.root);
        if (!rootStat || !rootStat.isDirectory()) continue;
        const logs = await collectOomLogMatches(product.name, product.root);
        logRootsScanned.push(...logs.rootsScanned);
        logMatches.push(...logs.matches);
        crashReports.push(...await collectCrashReports(product.name, product.root));
    }
    crashReports.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    const report: OomDiagnosticReport = {
        version: 1,
        generatedAt: new Date().toISOString(),
        appName: vscode.env.appName,
        workspaceRoot,
        logRootsScanned,
        limits: {
            maxLogSessions: OOM_DIAGNOSTIC_MAX_LOG_SESSIONS,
            maxLogFiles: OOM_DIAGNOSTIC_MAX_LOG_FILES,
            maxFileBytes: OOM_DIAGNOSTIC_MAX_FILE_BYTES,
            maxMatches: OOM_DIAGNOSTIC_MAX_MATCHES,
        },
        summary: {
            logMatches: logMatches.length,
            rendererOomMatches: logMatches.filter(item => /oom|out of memory|renderer process gone/i.test(item.text)).length,
            harmonyActivationMatches: logMatches.filter(item => /harmony\.harmony-extension|harmony\.controlPanel/i.test(item.text)).length,
            extensionHostTerminationMatches: logMatches.filter(item => /Extension host terminating|terminate message from renderer/i.test(item.text)).length,
            crashReports: crashReports.length,
        },
        crashReports: crashReports.slice(0, 20),
        logMatches,
        notes: [
            'If the newest Crashpad report timestamp is just before a fresh log session, the crash likely happened before that session was created.',
            'Use low-memory sidebar mode while isolating renderer OOMs, then switch back to full mode after the crash source is known.',
            'If OOM repeats with Harmony disabled or unopened, compare extension activation timing and repeated errors from other extensions in this report.',
        ],
    };
    const reportDir = path.join(workspaceRoot, '.harmony', 'diagnostics');
    await fs.mkdir(reportDir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    const jsonPath = path.join(reportDir, `oom-diagnostics-${stamp}.json`);
    const markdownPath = path.join(reportDir, `oom-diagnostics-${stamp}.md`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await fs.writeFile(markdownPath, formatOomDiagnosticMarkdown(report, jsonPath), 'utf8');
    return markdownPath;
}

async function findHarmonySourceWorkspace(): Promise<string | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const root = folder.uri.fsPath;
        try {
            const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
            const checkpointScript = path.join(root, 'scripts', 'run-self-update-checkpoint.js');
            if (pkg?.name === 'harmony-extension' && await safeStat(checkpointScript)) return root;
        } catch {
            // Not the Harmony source workspace.
        }
    }
    return undefined;
}

async function prepareSelfUpdateCheckpoint(): Promise<boolean> {
    const root = await findHarmonySourceWorkspace();
    if (!root) {
        vscode.window.showErrorMessage('Open the HarmonyExtension source workspace before preparing a self-update checkpoint. This command does not run from the installed extension copy.');
        return false;
    }
    const choice = await vscode.window.showWarningMessage(
        'Prepare a package-only Harmony self-update checkpoint? This runs fixed compile/smoke/package/privacy/dry-run receipt steps. It does not install the VSIX, reload editors, call paid providers, or mutate git.',
        { modal: true },
        'Start Checkpoint',
        'Cancel'
    );
    if (choice !== 'Start Checkpoint') return false;
    const terminal = vscode.window.createTerminal({ name: 'Harmony Self-Update Checkpoint', cwd: root });
    terminal.show(true);
    terminal.sendText('npm run self-update:checkpoint');
    return true;
}

async function createSeatHandoffBundle(): Promise<boolean> {
    const root = await findHarmonySourceWorkspace();
    if (!root) {
        vscode.window.showErrorMessage('Open the HarmonyExtension source workspace before creating a seat handoff bundle. This command does not run from the installed extension copy.');
        return false;
    }
    const choice = await vscode.window.showWarningMessage(
        'Create a Harmony seat handoff bundle? This writes compact Markdown/JSON under .harmony/handoffs with self-update commands, rollback notes, and bounded resume pointers. It does not install VSIX files, reload editors, call providers, or mutate git.',
        { modal: true },
        'Create Handoff',
        'Cancel'
    );
    if (choice !== 'Create Handoff') return false;
    const terminal = vscode.window.createTerminal({ name: 'Harmony Seat Handoff', cwd: root });
    terminal.show(true);
    terminal.sendText('npm run self-update:handoff');
    return true;
}

async function createResumeBrief(): Promise<boolean> {
    const root = await findHarmonySourceWorkspace();
    if (!root) {
        vscode.window.showErrorMessage('Open the HarmonyExtension source workspace before creating a resume brief. This command does not run from the installed extension copy.');
        return false;
    }
    const choice = await vscode.window.showWarningMessage(
        'Create a bounded Harmony resume brief? This writes compact Markdown/JSON under .harmony/resume-briefs from continuity, handoffs, diagnostics, and metadata only. It does not read whole chat logs, install VSIX files, reload editors, call providers, mutate git, or print secrets.',
        { modal: true },
        'Create Resume Brief',
        'Cancel'
    );
    if (choice !== 'Create Resume Brief') return false;
    const terminal = vscode.window.createTerminal({ name: 'Harmony Resume Brief', cwd: root });
    terminal.show(true);
    terminal.sendText('npm run self-update:resume-brief');
    return true;
}

const LOW_MEMORY_SAFETY_SNAPSHOT_KEY = 'harmony.lowMemorySafety.previousSettings';
const LOW_MEMORY_SAFETY_SETTINGS = [
    'sidebar.mode',
    'hub.autoStart',
    'hub.startOnMessage',
    'logRawStream',
    'deepseekShowThinking',
    'enableDebugLogging',
    'deepseekMaxHistoryMessages',
    'deepseekMaxHistoryChars',
] as const;

type LowMemorySafetySettingKey = typeof LOW_MEMORY_SAFETY_SETTINGS[number];
type LowMemorySafetySnapshot = {
    version: 1;
    savedAt: string;
    settings: Array<{ key: LowMemorySafetySettingKey; hadGlobalValue: boolean; globalValue?: unknown; effectiveValue?: unknown }>;
};

function captureLowMemorySafetySnapshot(cfg: vscode.WorkspaceConfiguration): LowMemorySafetySnapshot {
    return {
        version: 1,
        savedAt: new Date().toISOString(),
        settings: LOW_MEMORY_SAFETY_SETTINGS.map(key => {
            const inspected = cfg.inspect<unknown>(key);
            return {
                key,
                hadGlobalValue: inspected?.globalValue !== undefined,
                globalValue: inspected?.globalValue,
                effectiveValue: cfg.get(key),
            };
        }),
    };
}

async function enableLowMemorySafetyMode(context: vscode.ExtensionContext): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
        'Enable Harmony low-memory safety mode? This switches the sidebar to isolation mode, prevents automatic Hub startup, keeps Hub start-on-message prompting, disables verbose/raw visible diagnostics, and lowers direct-provider history replay caps. It does not delete data, install updates, reload editors, call providers, or mutate git.',
        { modal: true },
        'Enable Safety Mode',
        'Cancel'
    );
    if (choice !== 'Enable Safety Mode') return false;
    const cfg = vscode.workspace.getConfiguration('harmony');
    await context.globalState.update(LOW_MEMORY_SAFETY_SNAPSHOT_KEY, captureLowMemorySafetySnapshot(cfg));
    await cfg.update('sidebar.mode', 'isolated', vscode.ConfigurationTarget.Global);
    await cfg.update('hub.autoStart', false, vscode.ConfigurationTarget.Global);
    await cfg.update('hub.startOnMessage', 'prompt', vscode.ConfigurationTarget.Global);
    await cfg.update('logRawStream', false, vscode.ConfigurationTarget.Global);
    await cfg.update('deepseekShowThinking', false, vscode.ConfigurationTarget.Global);
    await cfg.update('enableDebugLogging', false, vscode.ConfigurationTarget.Global);
    const historyMessages = cfg.get<number>('deepseekMaxHistoryMessages') ?? 40;
    const historyChars = cfg.get<number>('deepseekMaxHistoryChars') ?? 60000;
    if (historyMessages > 20) await cfg.update('deepseekMaxHistoryMessages', 20, vscode.ConfigurationTarget.Global);
    if (historyChars > 30000) await cfg.update('deepseekMaxHistoryChars', 30000, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Harmony low-memory safety mode enabled. Sidebar isolation is active; restart/reload is not required.');
    return true;
}

async function restoreLowMemorySafetySettings(context: vscode.ExtensionContext): Promise<boolean> {
    const snapshot = context.globalState.get<LowMemorySafetySnapshot>(LOW_MEMORY_SAFETY_SNAPSHOT_KEY);
    if (!snapshot?.settings?.length) {
        vscode.window.showWarningMessage('No Harmony low-memory safety settings snapshot was found in this extension host.');
        return false;
    }
    const choice = await vscode.window.showWarningMessage(
        `Restore Harmony settings from the low-memory safety snapshot saved ${snapshot.savedAt}? This restores the global values Harmony changed, including raw DeepSeek trace if it was on before safety mode.`,
        { modal: true },
        'Restore Settings',
        'Cancel'
    );
    if (choice !== 'Restore Settings') return false;
    const cfg = vscode.workspace.getConfiguration('harmony');
    for (const item of snapshot.settings) {
        await cfg.update(item.key, item.hadGlobalValue ? item.globalValue : undefined, vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(LOW_MEMORY_SAFETY_SNAPSHOT_KEY, undefined);
    vscode.window.showInformationMessage('Harmony low-memory safety settings restored from snapshot.');
    return true;
}

// ─── Hub helpers ─────────────────────────────────────────────────────────────

function hubUrl(): string {
    return vscode.workspace.getConfiguration('harmony').get<string>('hub.url') ?? 'http://127.0.0.1:7878';
}

function hubEndpoint(endpoint: string): URL {
    const raw = hubUrl().trim() || 'http://127.0.0.1:7878';
    const base = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    base.search = '';
    base.hash = '';
    return new URL(endpoint.replace(/^\/+/, ''), base);
}

async function hubPost(path: string, body: unknown, timeoutMs = 15000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const url = hubEndpoint(path);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                    reject(new Error(`Hub HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); } catch { resolve(data); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Hub timeout')); });
        req.write(payload);
        req.end();
    });
}

async function hubGet(endpoint: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const url = hubEndpoint(endpoint);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'GET', timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                    reject(new Error(`Hub HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); } catch { resolve(data); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Hub timeout')); });
        req.end();
    });
}

/** Poll Hub /status until it responds (ready to accept requests). */
async function waitForHubReady(timeoutMs = 45000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await hubGet('/status');
            return true;
        } catch {
            // Hub not ready yet — wait and retry
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return false;
}

async function isDaemonRunning(): Promise<boolean> {
    try {
        await hubGet('/status');
        return true;
    } catch { return false; }
}

async function waitForDaemonOffline(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!await isDaemonRunning()) return true;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return !await isDaemonRunning();
}

/** Sync allowedRoots config to the daemon. Silent if daemon is not running.
 *  Also strips any path that matches the auto-index blocklist (privacy cleanup). */
async function syncAllowedRoots(): Promise<void> {
    // Wait for Hub to be ready (accepting requests) before syncing policy.
    // Hub can take 30-40s to load its embedding model on first startup.
    const ready = await waitForHubReady(45000);
    if (!ready) {
        console.warn('[Harmony] syncAllowedRoots: Hub not ready after 45s, policy sync skipped');
        return;
    }
    const cfg = vscode.workspace.getConfiguration('harmony');
    let roots = cfg.get<string[]>('hub.allowedRoots') ?? [];
    // Remove paths blocked by privacy rules
    const cleaned = roots.filter(r => !isAutoIndexBlocked(r));
    // Remove phantom paths that no longer exist on disk
    const extant = cleaned.filter(r => {
        try { realpathSync(r); return true; } catch { return false; }
    });
    if (extant.length !== roots.length) {
        await cfg.update('hub.allowedRoots', extant, vscode.ConfigurationTarget.Global);
        // Tell the daemon to forget removed paths
        for (const r of roots.filter(r => !extant.includes(r))) {
            try { await hubPost('/policy/unallow', { path: r }); } catch { /* ok */ }
        }
        roots = extant;
    }
    let synced = 0;
    for (const root of roots) {
        try {
            await hubPost('/policy/allow', { path: root });
            synced++;
        } catch { /* daemon offline — ok */ }
    }
    if (synced > 0 || roots.length === 0) {
        console.log(`[Harmony] syncAllowedRoots: synced ${synced}/${roots.length} root(s) to Hub policy`);
    }
}

/** Generic folder name substrings that are NEVER auto-indexed for privacy/safety. */
const AUTO_INDEX_BLOCKLIST = [
    'central',
    'private',
    'journal',
    'archive',
    'secret',
    'takeout',
    '.git',
    '.venv',
    'node_modules',
];

function normalizeFsPath(fsPath: string): string {
    return fsPath.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

function configuredCentralHubPath(): string | undefined {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const configured = (cfg.get<string>('centralHubPath') ?? '').trim();
    const fromEnv = (process.env.HARMONY_CENTRAL_HUB ?? process.env.EHAI_CENTRAL_PATH ?? '').trim();
    return configured || fromEnv || undefined;
}

function isAutoIndexBlocked(fsPath: string): boolean {
    const lower = normalizeFsPath(fsPath);
    const centralHub = configuredCentralHubPath();
    if (centralHub) {
        const central = normalizeFsPath(path.resolve(centralHub));
        if (lower === central || lower.startsWith(central + '/')) return true;
    }
    return AUTO_INDEX_BLOCKLIST.some(needle => lower.includes(needle));
}

async function indexWorkspaceFolders(): Promise<{ indexed: string[]; skipped: string[]; failed: string[] }> {
    const folders = vscode.workspace.workspaceFolders;
    const result = { indexed: [] as string[], skipped: [] as string[], failed: [] as string[] };
    if (!folders || folders.length === 0) { return result; }
    // Re-verify Hub is responsive before sending heavy indexing requests.
    // A previous failed index can leave Hub in a broken state.
    const hubReady = await waitForHubReady(15000);
    if (!hubReady) {
        for (const folder of folders) {
            result.failed.push(`${folder.uri.fsPath}: Hub not responsive before indexing`);
        }
        return result;
    }
    for (const folder of folders) {
        // Normalize path to resolve Windows case-sensitivity and symlinks
        let fsPath = folder.uri.fsPath;
        try { fsPath = realpathSync(fsPath); } catch { /* keep original if realpath fails */ }
        if (isAutoIndexBlocked(fsPath)) {
            result.skipped.push(fsPath);
            continue;
        }
        const cfg = vscode.workspace.getConfiguration('harmony');
        const existing = cfg.get<string[]>('hub.allowedRoots') ?? [];
        const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
        if (!existing.some(r => norm(r) === norm(fsPath))) {
            await cfg.update('hub.allowedRoots', [...existing, fsPath], vscode.ConfigurationTarget.Global);
        }
        try {
            await hubPost('/policy/allow', { path: fsPath });
            // Index with a 60s timeout — kill and restart Hub if it hangs
            const indexResult = await Promise.race([
                hubPost('/index', { path: fsPath, scope: 'all' }, 60000),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Indexing timed out after 60s — Hub may be stalled')), 60000))
            ]);
            if (indexResult && typeof indexResult === 'object' && (indexResult as any).indexed_files === 0) {
                // Hub accepted the request but indexed 0 files — likely a path/permissions issue
                console.warn(`[Harmony] Hub indexed 0 files for ${fsPath}. Path may not exist or be excluded.`);
            }
            result.indexed.push(fsPath);
        } catch (error: any) {
            result.failed.push(`${fsPath}: ${error?.message ?? 'Hub request failed'}`);
            // If Hub times out, it may be stalled — the caller or next
            // startHub command will force-stop it before restarting.
            if (error?.message?.includes('timed out') || error?.message?.includes('stalled')) {
                console.warn(`[Harmony] Hub indexing timed out for ${fsPath}. Hub may need restart.`);
            }
        }
    }
    return result;
}

// ── Creative token loader ────────────────────────────────────────────────────
async function loadCreativeToken(secrets: vscode.SecretStorage): Promise<void> {
    const tokenFile = (
        process.env.HARMONY_CREATIVE_TOKEN_FILE ||
        path.join(process.env.HARMONY_CREATIVE_HOME || path.join(os.homedir(), '.harmony_creative'), 'local_service.token')
    );
    const token = (await fs.readFile(tokenFile, 'utf-8')).trim();
    if (token) {
        await secrets.store('harmony.creativeToken', token);
    }
}

interface ProviderBrokerRequest {
    id?: string;
    kind?: string;
    workspace?: string;
    provider?: string;
    tier?: string;
    prompt?: string;
    maxTokens?: number;
}

function providerBrokerPath(root: string, ...parts: string[]): string {
    return path.join(root, '.harmony', 'provider-broker', ...parts);
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

async function appendCliOperationLedger(root: string, entry: Record<string, unknown>): Promise<void> {
    const ledgerPath = path.join(root, '.harmony', 'operations', 'ledger.json');
    const ledger = await readJsonFile<{ entries?: unknown[] }>(ledgerPath) ?? {};
    const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
    const timestamp = new Date().toISOString();
    const record = {
        id: `op-${timestamp.replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp,
        surface: 'vscode-broker',
        ...entry,
    };
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, JSON.stringify({ version: 1, updatedAt: timestamp, entries: [...entries.slice(-499), record] }, null, 2), 'utf8');
}

async function outsideVsPolicyAllowsProviderCall(root: string): Promise<{ allowed: boolean; reason?: string }> {
    const policyPath = path.join(root, '.harmony', 'policy', 'outside-vs-policy.json');
    const policy = await readJsonFile<{ permissions?: { paidProviderCalls?: boolean } }>(policyPath);
    if (!policy) return { allowed: false, reason: 'outside-VS policy is missing' };
    if (!policy.permissions?.paidProviderCalls) return { allowed: false, reason: 'outside-VS policy blocks paidProviderCalls' };
    return { allowed: true };
}

async function processProviderBrokerQueue(context: vscode.ExtensionContext): Promise<{ processed: number; failed: number; skipped: number }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let queued = 0;
    for (const folder of folders) {
        const requestDir = providerBrokerPath(folder.uri.fsPath, 'requests');
        const names = await fs.readdir(requestDir).catch(() => [] as string[]);
        queued += names.filter(name => name.endsWith('.json')).length;
    }
    if (!queued) {
        vscode.window.showInformationMessage('Harmony: no provider broker requests found.');
        return { processed: 0, failed: 0, skipped: 0 };
    }
    const confirm = await vscode.window.showWarningMessage(
        `Harmony: process ${queued} queued provider broker request(s) using saved VS Code SecretStorage keys?`,
        { modal: true },
        'Process Requests'
    );
    if (confirm !== 'Process Requests') return { processed: 0, failed: 0, skipped: queued };

    let processed = 0;
    let failed = 0;
    let skipped = 0;
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const requestDir = providerBrokerPath(root, 'requests');
        const responseDir = providerBrokerPath(root, 'responses');
        const processedDir = providerBrokerPath(root, 'processed');
        await fs.mkdir(responseDir, { recursive: true });
        await fs.mkdir(processedDir, { recursive: true });
        const names = (await fs.readdir(requestDir).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
        for (const name of names) {
            const requestPath = path.join(requestDir, name);
            const request = await readJsonFile<ProviderBrokerRequest>(requestPath);
            const id = request?.id || path.basename(name, '.json');
            const responsePath = path.join(responseDir, `${id}.json`);
            const writeResponse = async (status: 'completed' | 'failed', payload: Record<string, unknown>) => {
                await fs.writeFile(responsePath, JSON.stringify({ version: 1, id, status, createdAt: new Date().toISOString(), requestPath, ...payload }, null, 2), 'utf8');
                await appendCliOperationLedger(root, {
                    kind: 'terminal.ask.broker',
                    label: status === 'completed' ? 'VS Code broker request completed' : 'VS Code broker request failed',
                    status,
                    operationId: id,
                    provider: request?.provider,
                    responsePath,
                    error: payload.error,
                });
            };
            try {
                if (!request || request.kind !== 'ask') throw new Error('broker request must be kind=ask');
                if (!isProviderId(request.provider)) throw new Error(`unsupported provider: ${request.provider || '?'}`);
                const tier = request.tier === 'light' || request.tier === 'mid' || request.tier === 'heavy' || request.tier === 'coding' ? request.tier as Tier : 'coding';
                const prompt = String(request.prompt || '').trim();
                if (!prompt) throw new Error('broker request prompt is empty');
                const policy = await outsideVsPolicyAllowsProviderCall(root);
                if (!policy.allowed) throw new Error(policy.reason || 'outside-VS policy blocks provider calls');
                const cts = new vscode.CancellationTokenSource();
                try {
                    const result = await consult(context.secrets, {
                        provider: request.provider as ProviderId,
                        tier,
                        question: prompt,
                        maxTokens: Number(request.maxTokens || 1024),
                        system: 'You are Harmony responding to a terminal/floating UI brokered request. Be concise, accurate, and avoid exposing secrets.',
                    }, cts.token);
                    await writeResponse('completed', { provider: result.provider, model: result.model, output: result.text, usage: result.usage });
                    processed++;
                } finally {
                    cts.dispose();
                }
            } catch (error) {
                await writeResponse('failed', { error: error instanceof Error ? error.message : String(error) });
                failed++;
            }
            await fs.rename(requestPath, path.join(processedDir, name)).catch(async () => {
                await fs.unlink(requestPath).catch(() => {});
            });
        }
    }
    vscode.window.showInformationMessage(`Harmony: broker queue processed ${processed}, failed ${failed}, skipped ${skipped}.`);
    return { processed, failed, skipped };
}

// ── Translation Tools TreeView Provider ─────────────────────────

class TranslationTool extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly commandId: string,
        public readonly icon: string,
        public readonly description: string,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);
        this.tooltip = description;
        this.description = description;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = { command: commandId, title: label };
    }
}

class TranslationToolsProvider implements vscode.TreeDataProvider<TranslationTool> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TranslationTool | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TranslationTool): vscode.TreeItem {
        return element;
    }

    getChildren(): TranslationTool[] {
        return [
            new TranslationTool(
                '🚀 Translate Document',
                'harmony.translate',
                'globe',
                'EN↔ZH — Auto-detect & translate current file ⚠️ Costs vary (cents–dollars)',
            ),
            new TranslationTool(
                '📂 Batch Translate',
                'harmony.batchTranslate',
                'folder-library',
                'EN↔ZH — Batch translate a folder ⚠️ Costs vary by size/model',
            ),
            new TranslationTool(
                '📊 View Diff',
                'harmony.openTranslationDiff',
                'diff',
                'Open latest EN→ZH diff viewer',
            ),
            new TranslationTool(
                '🔎 Check Authenticity',
                'harmony.checkAuthenticity',
                'shield',
                'Verify source document is plausible',
            ),
            new TranslationTool(
                '📋 Dispute Ledger',
                'harmony.openDisputeLedger',
                'checklist',
                'Review term dispute audit trail',
            ),
            new TranslationTool(
                '🎯 Orchestrate Translation',
                'harmony.translationOrchestrate',
                'debug-step-over',
                'Step-by-step with review between each stage',
            ),
            new TranslationTool(
                '📋 Faithful EN→ZH',
                'harmony.faithfulTranslate',
                'lock',
                'Strict translation — no content changes (literal mode)',
            ),
            new TranslationTool(
                '⚙️ Run Pipeline...',
                'harmony.runDeepSwarm',
                'play',
                'EN↔ZH — Choose pipeline manually ⚠️ Costs vary by size/model',
            ),
        ];
    }
}

// ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    // 0. Wire secrets + bundled creative path + load creative token.
    initSecrets(context.secrets);
    initBundledCreativePath(context.extensionUri.fsPath);
    loadCreativeToken(context.secrets).catch(() => {});
    
    // 0b. One-time migration: legacy single keys → multi-key slot arrays.
    // Idempotent — skips providers that already have slots.
    for (const p of PROVIDER_IDS) {
        migrateLegacyToSlots(context.secrets, p).catch(() => {});
    }
    
    // 0c. Initialize error pattern learning (reads saved config + listens for changes).
    initializeErrorLearning();
    
    registerChatHistoryProvider(context);

    // Register DeepSeek as a native language model provider in Copilot Chat.
    // Models deepseek-v4-flash and deepseek-v4-pro will appear in the model picker.
    // Safe: if this fails, the error is caught and Harmony continues normally.
    try {
        registerDeepSeekProvider(context);
    } catch (e) {
        console.error('[Harmony] DeepSeek provider registration failed:', e);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.processProviderBrokerQueue', async () => {
            try {
                await processProviderBrokerQueue(context);
            } catch (error) {
                vscode.window.showErrorMessage(`Harmony: provider broker queue failed - ${error instanceof Error ? error.message : String(error)}`);
            }
        }),
        vscode.commands.registerCommand('harmony.refreshCreativeToken', async () => {
            try {
                await loadCreativeToken(context.secrets);
                vscode.window.showInformationMessage('Harmony: creative token refreshed.');
            } catch (e) {
                vscode.window.showErrorMessage(`Harmony: could not load creative token — ${(e as Error).message}`);
            }
        })
    );

    // 0b. Register command to manually start Harmony Creative service.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.startCreativeService', async () => {
            const { startCreativeService } = await import('./toolExecutor');
            try {
                await startCreativeService();
                vscode.window.showInformationMessage('Harmony: Creative service is running.');
            } catch (e) {
                vscode.window.showErrorMessage(`Harmony: could not start Creative service — ${(e as Error).message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.selectModel', async () => {
            const cfg = vscode.workspace.getConfiguration('harmony');
            const currentProvider = cfg.get<string>('modelProvider') ?? 'vscode-lm';
            const currentDeepSeek = cfg.get<string>('deepseekModel') ?? 'deepseek-v4-flash';
            type ModelPick = vscode.QuickPickItem & { action?: 'set' | 'discover'; provider?: 'vscode-lm' | 'deepseek' | 'alibaba' | 'tencent' | 'moonshot' | 'kimiCode' | 'zhipu' | 'zhipu-coding' | 'openai' | 'openrouter' | 'gemini' | 'claude' | 'doubao' | 'doubao-coding' | 'doubao-rewards' | 'byteplus' | 'byteplus-coding' | 'stepfun'; model?: string };
            // Build model entries from the central registry (providerModels.ts).
            // This replaces ~100 lines of hardcoded per-model entries.
            const registryEntries = buildQuickPickEntries(currentProvider, (p) => {
                if (p === 'deepseek') return currentDeepSeek;
                return modelFor(p, 'coding');
            });
            const picks: ModelPick[] = [
                ...registryEntries.map(e => ({
                    label: e.label,
                    description: e.description,
                    detail: e.detail,
                    provider: e.provider,
                    model: e.model,
                    picked: currentProvider === e.provider
                })),
                {
                    label: 'VS Code / Copilot dropdown',
                    description: 'VS Code Language Model API',
                    detail: 'Uses whatever model/account access VS Code Chat provides. Requires the relevant Copilot plan for premium models.',
                    provider: 'vscode-lm',
                    picked: currentProvider === 'vscode-lm'
                },
                {
                    label: 'Discover provider models live...',
                    description: 'Advanced exact IDs',
                    detail: 'Query a saved-key provider /models endpoint, pick an exact model ID, and assign it to light, mid, heavy, or coding tier overrides.',
                    action: 'discover'
                }
            ];
            const pick = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Choose Harmony primary model source',
                title: 'Harmony Model Selector'
            });
            if (!pick) return;
            if (pick.action === 'discover') {
                await vscode.commands.executeCommand('harmony.discoverModels');
                return;
            }
            if (!pick.provider) return;
            await cfg.update('modelProvider', pick.provider, vscode.ConfigurationTarget.Global);
            if (pick.provider === 'deepseek' && pick.model) {
                await cfg.update('deepseekModel', pick.model, vscode.ConfigurationTarget.Global);
            } else if (pick.provider && pick.provider !== 'vscode-lm' && pick.model) {
                await cfg.update(`providers.${pick.provider}.coding`, pick.model, vscode.ConfigurationTarget.Global);
            }
            const summary = pick.provider === 'vscode-lm'
                ? 'Harmony model: VS Code / Copilot dropdown'
                : `Harmony model: ${providerDisplayName(pick.provider)} / ${pick.model}`;
            vscode.window.showInformationMessage(summary);
            view.refresh();
            return summary;
        })
    );

    // 1. Register native LanguageModelTools (read/list/grep/write/edit/patch/open/run/ask).
    registerHarmonyTools(context);
    registerVisualTools(context);
    registerCompanyTools(context);
    registerOpsTools(context);
    registerSelfTools(context);
    registerCognitionTools(context);
    registerRepairRestore(context);
    registerEvidenceTools(context);
    registerResearchUpgradeTools(context);
    registerProviderRegistryTools(context);
    registerSwarmTools(context);
    registerDeepOrchestrate(context);
    registerSymbolTools(context);

    // 2. Register the @harmony chat participant (lives in the native Chat panel).
    registerHarmonyParticipant(context);

    // 3. Register the Harmony sidebar control panel.
    const view = registerHarmonyView(context);

    // 3b. Register Translation Tools TreeView in the same sidebar.
    const translationToolsProvider = new TranslationToolsProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('harmony.translationTools', translationToolsProvider)
    );

    // Re-render the sidebar on workspace state changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('harmony')) {
                view.refresh();
                if (e.affectsConfiguration('harmony.hub.allowedRoots')) {
                    syncAllowedRoots();
                }
            }
        })
    );

    // When user opens a new folder in VS Code, allow-list it but do not auto-index.
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
            for (const added of e.added) {
                const fsPath = added.uri.fsPath;
                if (isAutoIndexBlocked(fsPath)) { continue; }
                const cfg = vscode.workspace.getConfiguration('harmony');
                const existing = cfg.get<string[]>('hub.allowedRoots') ?? [];
                const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
                if (!existing.some(r => norm(r) === norm(fsPath))) {
                    await cfg.update('hub.allowedRoots', [...existing, fsPath], vscode.ConfigurationTarget.Global);
                }
                if (await isDaemonRunning()) {
                    await hubPost('/policy/allow', { path: fsPath }).catch(() => {});
                }
            }
            view.refresh();
        })
    );

    // ── Provider Sync Checker ───────────────────────────────────────
    // Verifies that all provider/model surfaces (sidebar, QuickPick, CLI
    // aliases) are consistent with the central providerModels.ts registry.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.checkProviderSync', async () => {
            const { checkProviderSync } = await import('./providerModels');
            const result = checkProviderSync();
            if (result.ok) {
                vscode.window.showInformationMessage(
                    '✅ Provider Sync: All model surfaces are consistent with the central registry.'
                );
            } else {
                const msg = `⚠️ Provider Sync Issues (${result.issues.length}):\n\n${result.issues.join('\n')}`;
                const doc = await vscode.workspace.openTextDocument({ content: msg });
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.openChat', async () => {
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open');
                try { await vscode.commands.executeCommand('cursorTop'); } catch { /* best effort */ }
                try { await vscode.commands.executeCommand('cursorHome'); } catch { /* best effort */ }
                await vscode.commands.executeCommand('type', { text: '@harmony ' });
            } catch {
                await vscode.commands.executeCommand('workbench.action.chat.open');
                vscode.window.showInformationMessage('Harmony opened Chat without replacing your draft. If needed, place @harmony at the start of the message before sending.');
            }
        })
    );

    function swarmDefaultProvider(): ProviderId {
        const raw = vscode.workspace.getConfiguration('harmony').get<string>('swarm.defaultProvider');
        return isProviderId(raw) ? raw : 'deepseek';
    }

    function swarmDefaultTier(): Tier {
        const raw = vscode.workspace.getConfiguration('harmony').get<string>('swarm.defaultTier');
        return raw === 'light' || raw === 'mid' || raw === 'heavy' || raw === 'coding' ? raw : 'coding';
    }

    function swarmDefaultSummary(): string {
        const provider = swarmDefaultProvider();
        const tier = swarmDefaultTier();
        return `${providerDisplayName(provider)} ${tier} (${modelFor(provider, tier)})`;
    }

    function swarmToolResultText(result: vscode.LanguageModelToolResult): string {
        return result.content.map((part: any) => typeof part?.value === 'string' ? part.value : JSON.stringify(part?.value ?? part)).join('\n');
    }

    async function showSwarmControlResult(title: string, toolName: string, input: Record<string, unknown>) {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: false },
            () => vscode.lm.invokeTool(toolName, { toolInvocationToken: undefined, input })
        );
        const text = swarmToolResultText(result);
        const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: `# ${title}\n\nTool: ${toolName}\n\n${text}`,
        });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    function parseScopePaths(raw: string | undefined): string[] | undefined {
        const paths = (raw ?? '')
            .split(/[\n,]/g)
            .map(item => item.trim())
            .filter(Boolean);
        return paths.length ? paths : undefined;
    }

    async function promptSwarmObjective(title: string): Promise<string | undefined> {
        const objective = await vscode.window.showInputBox({
            title,
            prompt: 'What should the swarm focus on?',
            placeHolder: 'Example: audit provider routing and propose the safest next slice',
            ignoreFocusOut: true,
        });
        return objective?.trim() || undefined;
    }

    async function promptSwarmScopePaths(): Promise<string[] | undefined> {
        const raw = await vscode.window.showInputBox({
            title: 'Harmony Swarm Scope',
            prompt: 'Optional: comma-separated workspace paths the swarm may reason about. Leave blank for broad read-only planning.',
            placeHolder: 'src/extension.ts, src/swarmTools.ts, package.json',
            ignoreFocusOut: true,
        });
        return parseScopePaths(raw);
    }

    async function configureSwarmDefaults() {
        type SwarmProviderPick = vscode.QuickPickItem & { provider: ProviderId; tier: Tier; useGeminiFreeQuota?: boolean };
        const current = `${swarmDefaultProvider()}:${swarmDefaultTier()}`;
        const picks: SwarmProviderPick[] = [
            {
                label: 'DeepSeek V4 Flash',
                description: 'Recommended default for swarm',
                detail: 'Sets provider deepseek + coding tier. Current model resolves to deepseek-v4-flash.',
                provider: 'deepseek',
                tier: 'coding',
                picked: current === 'deepseek:coding',
            },
            {
                label: 'Gemini Flash Free Quota',
                description: 'Use when your Gemini key/free quota is available',
                detail: 'Sets provider gemini + light tier and enables harmony.gemini.useFreeQuota.',
                provider: 'gemini',
                tier: 'light',
                useGeminiFreeQuota: true,
                picked: current === 'gemini:light',
            },
            {
                label: 'Alibaba / Qwen Flash',
                description: 'For later, after key/funding is ready',
                detail: 'Sets provider alibaba + light tier. Provider calls still require the swarm provider-calls switch.',
                provider: 'alibaba',
                tier: 'light',
                picked: current === 'alibaba:light',
            },
            {
                label: 'Tencent / Hunyuan Turbo',
                description: 'For later, after key/funding is ready',
                detail: 'Sets provider tencent + light tier. OpenAI-compatible, good for mainland China users. Provider calls still require the swarm provider-calls switch.',
                provider: 'tencent',
                tier: 'light',
                picked: current === 'tencent:light',
            },
            {
                label: 'Moonshot / Kimi',
                description: 'For later, after key/funding is ready',
                detail: 'Sets provider moonshot + light tier. Provider calls still require the swarm provider-calls switch.',
                provider: 'moonshot',
                tier: 'light',
                picked: current === 'moonshot:light',
            },
            {
                label: 'OpenRouter Free/Cheap Route',
                description: 'Uses configured OpenRouter light tier',
                detail: 'Provider policy allow/deny lists still apply before HTTP calls.',
                provider: 'openrouter',
                tier: 'light',
                picked: current === 'openrouter:light',
            },
        ];
        const pick = await vscode.window.showQuickPick(picks, {
            title: 'Harmony Swarm Defaults',
            placeHolder: 'Choose the default provider/tier for direct swarm controls and launcher prompts',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!pick) return;
        const cfg = vscode.workspace.getConfiguration('harmony');
        await cfg.update('swarm.defaultProvider', pick.provider, vscode.ConfigurationTarget.Global);
        await cfg.update('swarm.defaultTier', pick.tier, vscode.ConfigurationTarget.Global);
        if (pick.useGeminiFreeQuota) {
            await cfg.update('gemini.useFreeQuota', true, vscode.ConfigurationTarget.Global);
        }
        vscode.window.showInformationMessage(`Harmony swarm default: ${providerDisplayName(pick.provider)} ${pick.tier} (${modelFor(pick.provider, pick.tier)}).`);
        view.refresh();
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.openSwarm', async () => {
            type SwarmPick = { label: string; description: string; query: (objective?: string) => string; needsObjective?: boolean };
            const picks: SwarmPick[] = [
                {
                    label: 'Create safe swarm plan',
                    description: `Plan-only, no execution. Current default: ${swarmDefaultSummary()}.`,
                    needsObjective: true,
                    query: (objective) => `Please create a safe plan-only Harmony swarm for this objective:\n\n${objective}\n\nPlease use harmony_swarm_plan with mode plan_only. Current swarm default is ${swarmDefaultSummary()}. Treat Alibaba/Qwen and Moonshot as available only after explicit cost/key confirmation. Please do not execute, escrow, patch, run terminal commands, call paid providers, commit, or mutate files. Thank you for your care and collaboration!`,
                },
                {
                    label: 'Open direct swarm controls',
                    description: 'Invoke safe swarm tools directly from VS Code UI, without relying on chat tool selection.',
                    query: () => '',
                },
                {
                    label: 'Review swarm receipts',
                    description: 'List latest private swarm receipts and explain what is safe to do next.',
                    query: () => 'Please use harmony_swarm_receipts to review the latest private swarm receipts. Summarize the current swarm state, safety posture, budgets, blocked actions, and the safest next step. Please do not execute, patch, run terminal commands, call providers, commit, or mutate files. Thank you!',
                },
                {
                    label: 'Preflight latest swarm',
                    description: 'Run read-only safety checks for the latest swarm receipt.',
                    query: () => 'Please use harmony_swarm_preflight on the latest swarm receipt for intended_action read_only_probe. Explain GO/CAUTION/NO-GO plainly and please do not execute, escrow, patch, run terminal commands, call providers, commit, or mutate files. Thank you!',
                },
                {
                    label: 'Dispatch read-only roles',
                    description: 'Run safe read-only role probes from an existing plan.',
                    query: () => 'Please use harmony_swarm_dispatch on the latest swarm plan for read-only roles only. Keep provider summarization off unless I explicitly confirm cost and provider. Please do not apply patches, run terminal commands, commit, install packages, or mutate files. Thank you!',
                },
                {
                    label: 'Autonomy dry-run',
                    description: 'Simulate proposal readiness without executing proposals.',
                    query: () => 'Please use harmony_swarm_autonomy_run in dry_run mode on the latest eligible execution_guarded swarm receipts. Simulate only, report blocked reasons, and please do not execute proposals, edit files, run commands, call providers, commit, or mutate git. Thank you!',
                },
                {
                    label: 'Show swarm tools',
                    description: 'Open the tool ledger filtered to swarm capabilities.',
                    query: () => 'Please use harmony_tool_ledger with category swarm and include_commands true. Show the swarm tools, what each one is allowed to do, and which ones are execution-capable but disabled by default. Thank you!',
                },
            ];
            const pick = await vscode.window.showQuickPick(picks, {
                title: 'Harmony Swarm',
                placeHolder: 'Choose a safe swarm workflow',
                matchOnDescription: true,
            });
            if (!pick) return;
            if (pick.label === 'Open direct swarm controls') {
                await vscode.commands.executeCommand('harmony.swarmDirectControls');
                return;
            }
            let objective = '';
            if (pick.needsObjective) {
                const value = await vscode.window.showInputBox({
                    title: 'Harmony Swarm Objective',
                    prompt: 'What should the swarm plan?',
                    placeHolder: 'Example: audit provider routing and propose the safest next implementation slice',
                    ignoreFocusOut: true,
                });
                if (!value?.trim()) return;
                objective = value.trim();
            }
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: `@harmony ${pick.query(objective)}`,
                    isPartialQuery: false,
                });
            } catch {
                await vscode.commands.executeCommand('workbench.action.chat.open');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.configureSwarmDefaults', configureSwarmDefaults),
        vscode.commands.registerCommand('harmony.swarmDirectControls', async () => {
            type SwarmControlPick = vscode.QuickPickItem & { run: () => Promise<void> };
            const picks: SwarmControlPick[] = [
                {
                    label: 'Create plan-only receipt',
                    description: 'Directly invokes harmony_swarm_plan. No execution.',
                    run: async () => {
                        const objective = await promptSwarmObjective('Harmony Swarm Plan');
                        if (!objective) return;
                        const scopePaths = await promptSwarmScopePaths();
                        await showSwarmControlResult('Harmony Swarm Plan', 'harmony_swarm_plan', {
                            objective,
                            mode: 'plan_only',
                            scope_paths: scopePaths,
                            risk_tolerance: 'low',
                            max_cost_usd: 0.25,
                            max_steps: 5,
                            max_writes: 0,
                            max_terminal_commands: 0,
                            write_receipt: true,
                            format: 'markdown',
                        });
                    },
                },
                {
                    label: 'Review receipts',
                    description: 'Directly invokes harmony_swarm_receipts. Read-only.',
                    run: () => showSwarmControlResult('Harmony Swarm Receipts', 'harmony_swarm_receipts', {
                        action: 'list',
                        limit: 10,
                        format: 'markdown',
                    }),
                },
                {
                    label: 'Preflight latest receipt',
                    description: 'Directly invokes harmony_swarm_preflight. Read-only safety check.',
                    run: () => showSwarmControlResult('Harmony Swarm Preflight', 'harmony_swarm_preflight', {
                        turn_id: 'latest',
                        intended_action: 'read_only_probes',
                        require_fresh_pricing: false,
                        format: 'markdown',
                    }),
                },
                {
                    label: 'Dispatch read-only roles',
                    description: 'Directly invokes harmony_swarm_dispatch without provider fan-out.',
                    run: () => showSwarmControlResult('Harmony Swarm Dispatch', 'harmony_swarm_dispatch', {
                        turn_id: 'latest',
                        roles: ['coordinator', 'project_scout', 'verifier', 'cost_sentinel', 'researcher'],
                        provider: swarmDefaultProvider(),
                        tier: swarmDefaultTier(),
                        enable_provider_fanout: false,
                        write_receipt: true,
                        format: 'markdown',
                    }),
                },
                {
                    label: 'Autonomy dry-run',
                    description: 'Directly invokes harmony_swarm_autonomy_run in dry-run mode only.',
                    run: () => showSwarmControlResult('Harmony Swarm Autonomy Dry-Run', 'harmony_swarm_autonomy_run', {
                        turn_id: 'latest',
                        mode: 'dry_run',
                        max_steps: 3,
                        max_proposals: 3,
                        max_provider_calls: 0,
                        max_runtime_seconds: 60,
                        allow_terminal_proposals: false,
                        allow_provider_calls: false,
                        commit_mode: 'none',
                        confirm_execute: false,
                        write_receipt: true,
                        format: 'markdown',
                    }),
                },
                {
                    label: 'Create autonomy design',
                    description: 'Directly invokes harmony_swarm_autonomy_design. Design/report only.',
                    run: async () => {
                        const objective = await promptSwarmObjective('Harmony Swarm Autonomy Design');
                        if (!objective) return;
                        await showSwarmControlResult('Harmony Swarm Autonomy Design', 'harmony_swarm_autonomy_design', {
                            objective,
                            max_parallel_proposals: 3,
                            allow_commits: false,
                            write_design: true,
                            format: 'markdown',
                        });
                    },
                },
                {
                    label: 'Configure swarm defaults',
                    description: `Current: ${swarmDefaultSummary()}`,
                    run: configureSwarmDefaults,
                },
            ];
            const pick = await vscode.window.showQuickPick(picks, {
                title: 'Harmony Swarm Direct Controls',
                placeHolder: 'Choose a direct safe swarm action',
                matchOnDescription: true,
            });
            if (!pick) return;
            try {
                await pick.run();
            } catch (error) {
                vscode.window.showErrorMessage(`Harmony swarm control failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.runDeepSwarm', async (pipelineId?: string, mode?: string, strategy?: string, providerOverride?: string, tierOverride?: string, sourceContent?: string, sourceLabel?: string) => {
            // Persist mode + strategy + provider + tier selection for sidebar restoration
            if (mode) {
                await context.workspaceState.update('harmony.deepswarmMode', mode);
            }
            if (strategy) {
                await context.workspaceState.update('harmony.deepswarmStrategy', strategy);
            }
            if (providerOverride !== undefined) {
                await context.workspaceState.update('harmony.deepswarmProvider', providerOverride);
            }
            if (tierOverride !== undefined) {
                await context.workspaceState.update('harmony.deepswarmTier', tierOverride);
            }
            let pipeline: DeepSwarmPipeline | undefined;
            if (pipelineId) {
                pipeline = getTemplateById(pipelineId);
                if (!pipeline) {
                    vscode.window.showWarningMessage(`Unknown DeepSwarm pipeline: ${pipelineId}`);
                    return;
                }
            } else {
                // ── Auto-Detect Pipeline from editor content ──
                const editor = vscode.window.activeTextEditor;
                const editorContent = editor?.document.getText() || '';
                let autoDetected: string | undefined;
                
                if (editorContent.length > 50) {
                    const detection = detectPipelineType(editorContent);
                    if (detection.confidence >= 60) {
                        // High confidence — auto-select without showing picker
                        autoDetected = detection.pipelineId;
                        console.log(`[AutoDetect] 🤖 Auto-detected: ${detection.pipelineName} (${detection.confidence}% confidence — ${detection.reasons.join('; ')})`);
                    } else if (detection.confidence >= 30) {
                        console.log(`[AutoDetect] 🤖 Suggested: ${detection.pipelineName} (${detection.confidence}% confidence)`);
                    }
                }
                
                if (autoDetected && getTemplateById(autoDetected)) {
                    pipeline = getTemplateById(autoDetected)!;
                } else {
                    // Show pipeline picker (with suggestion if available)
                    const templates = listTemplateIds();
                    if (!templates.length) {
                        vscode.window.showWarningMessage('No DeepSwarm pipeline templates available.');
                        return;
                    }
                    // Sort: put the detected pipeline first if any
                    const sorted = autoDetected
                        ? [...templates].sort((a, b) => a.id === autoDetected ? -1 : b.id === autoDetected ? 1 : 0)
                        : templates;
                    const pick = await vscode.window.showQuickPick(
                        sorted.map(t => ({
                            label: t.id === autoDetected ? `⭐ ${t.name} (recommended)` : t.name,
                            description: t.description,
                            id: t.id,
                        })),
                        { placeHolder: 'Choose a DeepSwarm pipeline...', matchOnDescription: true }
                    );
                    if (!pick) return;
                    pipeline = getTemplateById(pick.id);
                }
                if (!pipeline) return;
            }

            // ── Convergence Translation: pick source file ──────────────
            let contextCode = '';
            let devProcess: import('child_process').ChildProcess | undefined;

            if (pipeline.id === 'convergence-translation' || pipeline.id === 'semantic-compilation') {
                if (sourceContent && sourceContent.trim().length > 10) {
                    // Content was pre-loaded by harmony.translate — skip the redundant file picker
                    contextCode = sourceContent;
                    if (!sourceLabel) sourceLabel = 'source-document.md';
                    vscode.window.showInformationMessage(`📄 Using pre-loaded document${sourceLabel ? ': ' + sourceLabel : ''}`);
                } else {
                    // Show file picker so the source document content is injected into the pipeline
                    // (LLMs cannot read local files — we must provide the content)
                    const sourceFiles = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            'Documents': ['md', 'txt', 'html', 'pdf', 'docx', 'json', 'yaml', 'yml', 'csv'],
                            'All Files': ['*'],
                        },
                        openLabel: 'Select Source Document',
                        title: 'Select the English document to translate to Chinese',
                    });
                    if (!sourceFiles?.length) return;
                    const sourceUri = sourceFiles[0];
                    contextCode = (await fs.readFile(sourceUri.fsPath, 'utf-8'));
                    sourceLabel = path.basename(sourceUri.fsPath);
                }
            }

            // ── Website Analysis: gather real context first ────────────
            if (pipeline.id === 'website-analysis') {
                // Auto-detect current workspace project
                let projectName: string | undefined;
                let devScripts: Array<{ name: string; command: string }> = [];
                let projectRoot: string | undefined;
                try {
                    const detection = detectWorkspaceProject();
                    projectName = detection.packageJson?.name;
                    devScripts = detection.devScripts;
                    projectRoot = detection.projectRoot;
                } catch {
                    // No workspace open — that's fine, continue with other options
                }

                const sourceOptions: Array<{ label: string; description: string; id: string }> = [];
                if (devScripts.length > 0) {
                    sourceOptions.push({
                        label: '🏠 Current Project (auto-detect)',
                        description: `Auto-start dev server for ${projectName || 'workspace'} + live Playwright capture`,
                        id: 'auto',
                    });
                }
                sourceOptions.push(
                    { label: '🌐 Live URL', description: 'Analyze a deployed website via Playwright (rendered DOM, a11y tree, SEO meta)', id: 'url' },
                    { label: '📁 Local folder', description: 'Gather HTML, CSS, JS files from a local project folder', id: 'folder' },
                    { label: '📄 Current file', description: 'Use the active editor file (quick but limited)', id: 'current-file' },
                );

                const sourcePick = await vscode.window.showQuickPick(
                    sourceOptions,
                    { placeHolder: 'Where should the website analysis get content from?' }
                );
                if (!sourcePick) return;

                let target = '';
                let isUrlInspection = false;
                if (sourcePick.id === 'auto') {
                    // Offer to start dev server
                    const chosenScript = await offerDevServer(devScripts, projectName);
                    if (!chosenScript) {
                        // User declined — fall back to folder analysis
                        target = projectRoot!;
                    } else {
                        // Start dev server
                        try {
                            await vscode.window.withProgress(
                                { location: vscode.ProgressLocation.Notification, title: `🚀 Starting dev server (npm run ${chosenScript})...`, cancellable: false },
                                async () => {
                                    const started = await startDevServer(projectRoot!, chosenScript);
                                    target = started.url;
                                    devProcess = started.process;
                                }
                            );
                            sourcePick.id = 'url'; // now use URL mode for Playwright capture
                            isUrlInspection = true;
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Dev server failed: ${err.message}`);
                            return;
                        }
                    }
                } else if (sourcePick.id === 'url') {
                    isUrlInspection = true;
                    target = await vscode.window.showInputBox({
                        prompt: 'Enter the website URL (e.g. https://example.com or localhost:3000)',
                        placeHolder: 'https://example.com',
                    }) ?? '';
                    if (!target) return;
                } else if (sourcePick.id === 'folder') {
                    const folderUri = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false,
                        openLabel: 'Select Website Folder',
                    });
                    if (!folderUri?.length) return;
                    target = folderUri[0].fsPath;
                }
                // current-file: target stays empty

                // Build context (this may take a moment for URL inspection)
                const effectiveSourceType = (sourcePick.id === 'auto' ? 'folder' : sourcePick.id) as WebsiteSourceType;
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `🔍 Gathering website context...`, cancellable: false },
                    async (progress) => {
                        progress.report({ message: isUrlInspection ? `Inspecting ${target}...` : 'Reading files...' });
                        const ctx = await buildWebsiteContext(target, effectiveSourceType, new vscode.CancellationTokenSource().token);
                        contextCode = ctx.context;
                        sourceLabel = ctx.sourceLabel;
                    }
                );
            } else if (pipeline.id === 'triple-check') {
                // Triple-check: always prefer git diff (audits changed files, not whatever editor is open)
                try {
                    const changedFiles = child_process.execSync('git diff --name-only HEAD', { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, encoding: 'utf8', timeout: 5000 }).trim();
                    if (changedFiles) {
                        const diffContent = child_process.execSync('git diff HEAD', { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 });
                        contextCode = diffContent.slice(0, 50000); // cap at 50KB
                        sourceLabel = `${changedFiles.split('\n').length} changed file(s)`;
                    }
                } catch {
                    // Git failed or no repo — fall back to active editor
                }
                if (!contextCode) {
                    const editor = vscode.window.activeTextEditor;
                    contextCode = editor?.document.getText() ?? '';
                }
            } else if (!contextCode) {
                // Non-website pipelines: use active editor as before
                // (only if convergence/website/triple-check didn't already set contextCode)
                const editor = vscode.window.activeTextEditor;
                contextCode = editor?.document.getText() ?? '';
            }

            const focus = await vscode.window.showInputBox({
                prompt: pipeline.id === 'website-analysis'
                    ? `What should this website analysis focus on? (e.g. "responsiveness and accessibility")`
                    : 'What should this pipeline focus on? (e.g. "src/deepSwarm.ts security")',
                placeHolder: pipeline.id === 'website-analysis' ? 'e.g. responsiveness and accessibility' : 'e.g. src/deepSwarm.ts security review',
                value: pipeline.id === 'triple-check'
                    ? (context.workspaceState.get<string>('harmony.lastAuditSummary') ?? '')
                    : undefined,
            });
            if (focus === undefined) return; // cancelled

            // Show cost warning for Maximum Quality strategy
            if (strategy === 'maximum-quality') {
                const preset = getStrategyPreset('maximum-quality');
                const proceed = await vscode.window.showWarningMessage(
                    preset.costWarning ?? 'Maximum Quality uses heavy/pro tiers on all steps. Higher cost.',
                    { modal: true },
                    'Proceed Anyway',
                    'Switch to Balanced'
                );
                if (!proceed) return;
                if (proceed === 'Switch to Balanced') {
                    strategy = 'balanced';
                }
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `🧠 DeepSwarm: ${pipeline.name}${sourceLabel ? ` (${sourceLabel})` : ''}`, cancellable: true },
                async (progress, token) => {
                    try {
                        const result = await runPipeline(
                            context.secrets,
                            pipeline,
                            contextCode,
                            focus,
                            token,
                            (msg) => progress.report({ message: msg }),
                            strategy as ProviderStrategy | undefined,
                            providerOverride && providerOverride !== 'auto' ? providerOverride : undefined,
                            tierOverride && tierOverride !== 'auto' ? tierOverride as Tier | undefined : undefined,
                        );

                        // Show result in a new untitled document
                        const doc = await vscode.workspace.openTextDocument({
                            content: formatPipelineResult(result),
                            language: 'markdown',
                        });
                        await vscode.window.showTextDocument(doc, { preview: false });

                        const costLabel = result.totalCostDollars < 0.05 ? '●○○ Low' : result.totalCostDollars < 0.20 ? '●●○ Medium' : '●●● Significant';
                        vscode.window.showInformationMessage(
                            `🧠 DeepSwarm "${pipeline.name}" complete — ${result.steps.length} steps, ${costLabel}, ${(result.totalDurationMs / 1000).toFixed(1)}s`
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            `DeepSwarm failed: ${error instanceof Error ? error.message : String(error)}`
                        );
                    } finally {
                        // Clean up auto-started dev server
                        if (devProcess) {
                            stopDevServer(devProcess);
                        }
                    }
                }
            );
        })
    );

    // ── Translation Disclaimer (first-use modal) ────────────────────
    async function showTranslationDisclaimer(): Promise<boolean> {
        const key = 'harmony.translate.disclaimerAccepted';
        if (context.globalState.get(key)) return true;
        const choice = await vscode.window.showInformationMessage(
            '🌐 Harmony Translation Tools — EN↔ZH\n\n' +
            '• Translates between English and Chinese (EN↔ZH)\n' +
            '• Uses cloud AI models (DeepSeek, Qwen, Gemini, and others)\n' +
            '• Multi-model translation incurs API charges across 2–4 providers\n' +
            '  per document — costs vary significantly by document size,\n' +
            '  provider, model tier, and current provider pricing\n' +
            '• Best-effort cost guardrails are in place, but provider pricing\n' +
            '  can change without notice — guardrails may not prevent all charges\n' +
            '• Content is transmitted to AI providers for processing only;\n' +
            '  no data is retained by Harmony or the providers\n' +
            '• Translations are AI-generated — review by a qualified\n' +
            '  human translator for critical, legal, or technical content\n' +
            '• 🎯 Orchestration Mode: step-by-step multi-model review\n' +
            '  with human oversight at each stage — use \"Harmony:\n' +
            '  Orchestrate Translation\" or ask Harmony in chat\n\n' +
            'By continuing, you acknowledge these costs and limitations.',
            { modal: true },
            'I Understand — Continue',
            'Cancel'
        );
        if (choice === 'I Understand — Continue') {
            await context.globalState.update(key, true);
            return true;
        }
        return false;
    }

    // ── Chinese-content gate (autonomous mode) ────────────────────
    /** Returns true if content is >30% CJK characters (already Chinese). */
    function isAlreadyChinese(content: string): boolean {
        const cjk = (content.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
        return cjk > 0 && (cjk / Math.max(content.length, 1)) > 0.30;
    }

    // ── Unified Translation Hub ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.translate', async () => {
            // First-use disclaimer
            if (!(await showTranslationDisclaimer())) return;

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                // No editor open — pick a file AND read its content, then auto-detect & run
                const sourceFiles = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: { 'Documents': ['md', 'txt', 'html', 'pdf', 'docx', 'json', 'yaml', 'yml', 'csv'], 'All Files': ['*'] },
                    openLabel: 'Select Document to Translate',
                    title: 'Harmony Translate — Select Source Document',
                });
                if (!sourceFiles?.length) return;
                const sourceUri = sourceFiles[0];
                const sourcePath = sourceUri.fsPath;
                const sourceName = path.basename(sourcePath);

                // Read the file content (handle non-UTF-8 formats via converter if needed)
                let content: string;
                const ext = path.extname(sourcePath).toLowerCase();
                if (ext === '.pdf' || ext === '.docx') {
                    // Use the multi-format converter
                    const converted = await convertFileToMarkdown(sourcePath);
                    content = converted.markdown;
                } else {
                    content = (await fs.readFile(sourcePath, 'utf-8'));
                }

                // Chinese-content gate: warn before auto-adapting already-Chinese docs
                if (isAlreadyChinese(content)) {
                    const gateChoice = await vscode.window.showWarningMessage(
                        '⚠️ This document appears to be primarily Chinese.\n\n' +
                        'The Standard EN→ZH pipeline includes an adaptation step designed for English→Chinese conversion. ' +
                        'Running it on already-Chinese content may produce unwanted changes (version bumps, structural rewrites, softened requirements).\n\n' +
                        'Use 📋 Faithful EN→ZH for literal translation, or continue with caution.',
                        { modal: true },
                        '📋 Use Faithful EN→ZH',
                        '⚠️ Continue Anyway',
                        'Cancel'
                    );
                    if (!gateChoice || gateChoice === 'Cancel') return;
                    if (gateChoice === '📋 Use Faithful EN→ZH') {
                        await vscode.commands.executeCommand('harmony.faithfulTranslate');
                        return;
                    }
                    // Continue Anyway — proceed with caution
                }

                // Authenticity check
                const auth = checkSourceAuthenticity(content);
                if (!auth.plausible) {
                    const proceed = await vscode.window.showWarningMessage(
                        `⚠️ Source authenticity concerns:\n\n${auth.warnings.join('\n')}\n\nContinue anyway?`,
                        { modal: true },
                        'Continue Anyway',
                        'Cancel'
                    );
                    if (!proceed || proceed === 'Cancel') return;
                }

                // Auto-detect pipeline
                const detection = detectPipelineType(content);
                const pipelineId = detection.confidence >= 30 ? detection.pipelineId : 'convergence-translation';
                if (!getTemplateById(pipelineId)) {
                    await vscode.commands.executeCommand('harmony.runDeepSwarm', undefined, undefined, undefined, undefined, undefined, content, sourceName);
                    return;
                }

                if (detection.confidence >= 60) {
                    vscode.window.showInformationMessage(
                        `🤖 Auto-detected: ${detection.pipelineName} — running now...`
                    );
                    await vscode.commands.executeCommand('harmony.runDeepSwarm', pipelineId, undefined, undefined, undefined, undefined, content, sourceName);
                } else {
                    const choice = await vscode.window.showInformationMessage(
                        `🤖 Suggested: ${detection.pipelineName} (${detection.confidence}% confidence)`,
                        'Run',
                        'Choose Different'
                    );
                    if (choice === 'Run') {
                        await vscode.commands.executeCommand('harmony.runDeepSwarm', pipelineId, undefined, undefined, undefined, undefined, content, sourceName);
                    } else if (choice === 'Choose Different') {
                        await vscode.commands.executeCommand('harmony.runDeepSwarm', undefined, undefined, undefined, undefined, undefined, content, sourceName);
                    }
                }
                return;
            }

            const content = editor.document.getText();
            const sourceName = path.basename(editor.document.fileName);

            // Authenticity check first
            const auth = checkSourceAuthenticity(content);
            if (!auth.plausible) {
                const proceed = await vscode.window.showWarningMessage(
                    `⚠️ Source authenticity concerns:\n\n${auth.warnings.join('\n')}\n\nContinue anyway?`,
                    { modal: true },
                    'Continue Anyway',
                    'Cancel'
                );
                if (!proceed || proceed === 'Cancel') return;
            }

            // Auto-detect pipeline
            const detection = detectPipelineType(content);
            const pipelineId = detection.confidence >= 30 ? detection.pipelineId : 'convergence-translation';

            let pipeline = getTemplateById(pipelineId);
            if (!pipeline) pipeline = getTemplateById('convergence-translation')!;

            if (detection.confidence >= 30) {
                const msg = detection.confidence >= 60
                    ? `🤖 Auto-detected: ${detection.pipelineName} (${detection.confidence}% confidence)`
                    : `🤖 Suggested: ${detection.pipelineName} (${detection.confidence}% confidence)`;
                vscode.window.showInformationMessage(msg, 'Run', 'Choose Different').then(async (choice) => {
                    if (choice === 'Run') {
                        await vscode.commands.executeCommand('harmony.runDeepSwarm', pipelineId, undefined, undefined, undefined, undefined, content, sourceName);
                    } else if (choice === 'Choose Different') {
                        await vscode.commands.executeCommand('harmony.runDeepSwarm', undefined, undefined, undefined, undefined, undefined, content, sourceName);
                    }
                });
            } else {
                // Low confidence — just open the full picker but pass content
                await vscode.commands.executeCommand('harmony.runDeepSwarm', undefined, undefined, undefined, undefined, undefined, content, sourceName);
            }
        })
    );

    // ── Batch Translation ─────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.batchTranslate', async () => {
            // First-use disclaimer
            if (!(await showTranslationDisclaimer())) return;

            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Folder to Translate',
                title: 'Batch Translate — Select Document Folder',
            });
            if (!folderUri?.length) return;

            const folderPath = folderUri[0].fsPath;

            // Quick pipeline picker
            const pipelinePick = await vscode.window.showQuickPick(
                [
                    { label: '⚖️ Standard EN→ZH Translation', description: 'Multi-model EN→ZH with consensus adjudication', id: 'convergence-translation' },
                    { label: '📦 Bilingual Document', description: 'Bilingual deliverable with YAML frontmatter', id: 'semantic-compilation' },
                ],
                { placeHolder: 'Choose translation pipeline for batch...' }
            );
            if (!pipelinePick) return;

            const focus = await vscode.window.showInputBox({
                prompt: 'Optional focus for batch translation (e.g. "green building standards")',
                placeHolder: 'e.g. Technical documentation translation',
            });
            if (focus === undefined) return;

            // Cost confirmation
            const proceed = await vscode.window.showInformationMessage(
                `📂 Batch translate folder: ${path.basename(folderPath)}\n\nPipeline: ${pipelinePick.label}\nMulti-model translation incurs API charges across 2–4 providers per file. Best-effort guardrails are in place but provider pricing can change without notice.\n\nProceed?`,
                { modal: true },
                'Start Batch',
                'Cancel'
            );
            if (!proceed || proceed === 'Cancel') return;

            let summary: BatchSummary | undefined;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `📂 Batch Translate: ${path.basename(folderPath)}`, cancellable: true },
                async (progress, token) => {
                    try {
                        summary = await processBatch(
                            context.secrets,
                            folderPath,
                            pipelinePick.id,
                            focus,
                            token,
                            (msg) => progress.report({ message: msg }),
                        );
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Batch translation failed: ${err.message}`);
                    }
                }
            );

            if (summary) {
                const costLabel = summary.totalCostDollars < 1.00 ? '●○○ Low' : summary.totalCostDollars < 5.00 ? '●●○ Medium' : '●●● Significant';
                const resultDoc = await vscode.workspace.openTextDocument({
                    content: [
                        '# 📂 Batch Translation Report',
                        '',
                        `**Folder**: \`${folderPath}\``,
                        `**Pipeline**: \`${pipelinePick.id}\``,
                        `**Results**: ${summary.succeeded}/${summary.totalFiles} succeeded, ${summary.failed} failed`,
                        `**Cost**: ${costLabel} — ${summary.totalCostDollars.toFixed(2)} total`,
                        `**Duration**: ${(summary.totalDurationMs / 1000).toFixed(1)}s`,
                        '',
                        '---',
                        '',
                        '| File | Status | Cost | Duration | Artifacts |',
                        '|:---|:---|:---|:---|:---|',
                        ...summary.results.map(r =>
                            `| ${r.file} | ${r.success ? '✅' : '❌'} | ${r.costDollars.toFixed(2)} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.outputPaths.length > 0 ? r.outputPaths.map(p => path.basename(p)).join(', ') : r.error || '—'} |`
                        ),
                        '',
                        `*Generated by Harmony DeepSwarm Batch • ${summary.totalFiles} files • ${summary.totalCostDollars.toFixed(2)} total*`,
                    ].join('\n'),
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(resultDoc, { preview: false });
                vscode.window.showInformationMessage(
                    `📂 Batch complete: ${summary.succeeded}/${summary.totalFiles} files, ${summary.totalCostDollars.toFixed(2)} total`
                );
            }
        })
    );

    // ── Orchestrate Translation (step-by-step with review) ─────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.translationOrchestrate', async () => {
            if (!(await showTranslationDisclaimer())) return;

            // Pick pipeline
            const templates = listTemplateIds();
            const pick = await vscode.window.showQuickPick(
                templates.map(t => ({
                    label: t.name,
                    description: t.description,
                    id: t.id,
                })),
                { placeHolder: '🎯 Choose a pipeline for step-by-step orchestration...', matchOnDescription: true }
            );
            if (!pick) return;
            const pipeline = getTemplateById(pick.id);
            if (!pipeline) return;

            // Pick source file
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Choose Source Document',
                filters: { Documents: ['md', 'txt', 'html', 'pdf'] },
                title: 'Orchestrate: Select source document for step-by-step translation',
            });
            if (!fileUris?.length) return;

            const filePath = fileUris[0].fsPath;
            const sourceName = path.basename(filePath);
            let content: string;
            try {
                const ext = path.extname(filePath).toLowerCase();
                if (ext === '.pdf' || ext === '.docx') {
                    const converted = await convertFileToMarkdown(filePath);
                    content = converted.markdown;
                    if (!content.trim()) { vscode.window.showErrorMessage('Could not extract text.'); return; }
                } else {
                    content = (await require('fs').promises.readFile(filePath, 'utf-8')).trim();
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Cannot read file: ${err.message}`);
                return;
            }

            const focus = await vscode.window.showInputBox({
                prompt: 'Optional focus for orchestrated translation',
                placeHolder: 'e.g. green building standards',
            });
            if (focus === undefined) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `🎯 Orchestrating: ${sourceName}`, cancellable: true },
                async (progress, token) => {
                    try {
                        const result = await runPipeline(
                            context.secrets, pipeline, content, focus || '', token,
                            (msg) => { progress.report({ message: msg }); },
                            undefined, undefined, undefined,
                            // Step callback — pause after each step
                            async (stepIndex, stepResult, totalSteps) => {
                                const stepLabel = pipeline.steps[stepIndex]?.label || `Step ${stepIndex + 1}`;
                                const durationSec = (stepResult.durationMs / 1000).toFixed(1);
                                const preview = stepResult.primaryResult?.slice(0, 200) || '(no output)';

                                const choice = await vscode.window.showInformationMessage(
                                    `🎯 Step ${stepIndex + 1}/${totalSteps}: ${stepLabel}\n\n⏱ ${durationSec}s | $${stepResult.costEstimateDollars.toFixed(2)}\n📝 ${preview}...`,
                                    { modal: true },
                                    'Continue →',
                                    '⏸️ Abort'
                                );
                                if (!choice || choice === '⏸️ Abort') {
                                    vscode.window.showInformationMessage(`⏸️ Orchestration paused at step ${stepIndex + 1}/${totalSteps}`);
                                    return false;
                                }
                                return true;
                            }
                        );
                        const doc = await vscode.workspace.openTextDocument({
                            content: formatPipelineResult(result),
                            language: 'markdown',
                        });
                        await vscode.window.showTextDocument(doc, { preview: false });
                        vscode.window.showInformationMessage(
                            `✅ Orchestration complete: ${result.steps.length} steps, $${result.totalCostDollars.toFixed(2)} total`
                        );
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Orchestration failed: ${err.message}`);
                    }
                }
            );
        })
    );

    // ── Orchestration Demo ────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.showOrchestrationDemo', async () => {
            const caseStudyPath = path.join(context.extensionUri.fsPath, '..', '..', '.harmony', 'case-study-orchestration.md');
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const wsCaseStudy = wsRoot ? path.join(wsRoot, '.harmony', 'case-study-orchestration.md') : null;

            // Try workspace case study first, then extension-bundled
            let docPath = wsCaseStudy;
            try {
                if (wsCaseStudy) await fs.stat(wsCaseStudy);
                else throw new Error('no workspace');
            } catch {
                try {
                    await fs.stat(caseStudyPath);
                    docPath = caseStudyPath;
                } catch {
                    vscode.window.showInformationMessage(
                        '🎯 Orchestration Mode lets you collaborate step-by-step with multiple AI models.\n\n' +
                        'How to use it:\n' +
                        '• Click 🎯 Orchestrate Translation in the Translation Tools panel\n' +
                        '• Or ask Harmony in chat: "Harmony, please orchestrate a translation"\n' +
                        '• Review each pipeline step before proceeding\n' +
                        '• Discuss changes and build consensus across models\n\n' +
                        'See README.md #orchestration-mode for the full case study.',
                        { modal: true },
                        'Got it!'
                    );
                    return;
                }
            }

            const doc = await vscode.workspace.openTextDocument(docPath!);
            await vscode.window.showTextDocument(doc, { preview: false });
            vscode.window.showInformationMessage(
                '🎯 This case study shows how Orchestration Mode built the jurisdiction-specific edition — 3 AI models + human author reaching consensus on every change.',
                'Learn More in README'
            ).then(choice => {
                if (choice === 'Learn More in README') {
                    vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(path.join(wsRoot || '', 'README.md')));
                }
            });
        })
    );

    // ── Faithful EN→ZH Translation (literal mode) ─────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.faithfulTranslate', async () => {
            if (!(await showTranslationDisclaimer())) return;

            // Pick source file
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Choose Document for Faithful Translation',
                filters: { Documents: ['md', 'txt', 'html', 'pdf'] },
                title: 'Faithful Translation: Literal, no content changes',
            });
            if (!fileUris?.length) return;

            const filePath = fileUris[0].fsPath;
            const sourceName = path.basename(filePath);
            let content: string;
            try {
                const ext = path.extname(filePath).toLowerCase();
                if (ext === '.pdf' || ext === '.docx') {
                    const converted = await convertFileToMarkdown(filePath);
                    content = converted.markdown;
                    if (!content.trim()) { vscode.window.showErrorMessage('Could not extract text.'); return; }
                } else {
                    content = (await require('fs').promises.readFile(filePath, 'utf-8')).trim();
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Cannot read file: ${err.message}`);
                return;
            }

            const focus = await vscode.window.showInputBox({
                prompt: 'Optional focus for faithful translation',
                placeHolder: 'e.g. technical standard v0.1',
            });
            if (focus === undefined) return;

            const pipeline = getTemplateById('convergence-translation-literal');
            if (!pipeline) {
                vscode.window.showErrorMessage('Faithful translation pipeline not found.');
                return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `📋 Faithful EN→ZH: ${sourceName}`, cancellable: true },
                async (progress, token) => {
                    try {
                        const result = await runPipeline(
                            context.secrets, pipeline, content, focus || '', token,
                            (msg) => { progress.report({ message: msg }); },
                        );
                        const doc = await vscode.workspace.openTextDocument({
                            content: formatPipelineResult(result),
                            language: 'markdown',
                        });
                        await vscode.window.showTextDocument(doc, { preview: false });
                        vscode.window.showInformationMessage(
                            `📋 Faithful Translation complete: ${result.totalCostDollars.toFixed(2)} — content preserved, no enhancements`
                        );
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Faithful translation failed: ${err.message}`);
                    }
                }
            );
        })
    );

    // ── Sidepanel: Open latest diff viewer ────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.openTranslationDiff', async () => {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }
            try {
                const outDir = path.join(wsRoot, 'out');
                const files = await require('fs').promises.readdir(outDir);
                const diffs = files.filter((f: string) => f.startsWith('diff-') && f.endsWith('.md')).sort().reverse();
                if (!diffs.length) {
                    vscode.window.showInformationMessage('No diff viewer files found. Run a translation first.');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(path.join(outDir, diffs[0]));
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch {
                vscode.window.showInformationMessage('No diff viewer outputs yet. Run a translation first.');
            }
        })
    );

    // ── Sidepanel: Open latest dispute ledger ─────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.openDisputeLedger', async () => {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }
            try {
                const outDir = path.join(wsRoot, 'out');
                const files = await require('fs').promises.readdir(outDir);
                const ledgers = files.filter((f: string) => f.startsWith('dispute-ledger-') && f.endsWith('.md')).sort().reverse();
                if (!ledgers.length) {
                    vscode.window.showInformationMessage('No dispute ledgers found. Run a translation first.');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(path.join(outDir, ledgers[0]));
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch {
                vscode.window.showInformationMessage('No dispute ledger outputs yet. Run a translation first.');
            }
        })
    );

    // ── Sidepanel: Check document authenticity ────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.checkAuthenticity', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No document open. Open a file to check authenticity.');
                return;
            }
            const content = editor.document.getText();
            const auth = checkSourceAuthenticity(content);

            const flagList = auth.flags.length > 0
                ? auth.flags.map(f => `| ${f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🟢'} | **${f.type}** | ${f.detail} |`).join('\n')
                : '| ✅ | No issues detected | — |';

            const reportDoc = await vscode.workspace.openTextDocument({
                content: [
                    '# 🔎 Source Authenticity Report',
                    '',
                    `| Field | Value |`,
                    `|:---|:---|`,
                    `| Domain | ${auth.domain} |`,
                    `| Plausible | ${auth.plausible ? '✅ Yes' : '🔴 No'} |`,
                    `| Confidence | ${auth.confidence}% |`,
                    '',
                    auth.warnings.length > 0 ? `⚠️ **Warnings**:\n${auth.warnings.map(w => `- ${w}`).join('\n')}` : '✅ No warnings',
                    '',
                    '## Flags',
                    '',
                    '| Level | Type | Detail |',
                    '|:---|:---|:---|',
                    flagList,
                    '',
                ].join('\n'),
                language: 'markdown',
            });
            await vscode.window.showTextDocument(reportDoc, { preview: false });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.testDeepSeekTokenLimit', async () => {
            const apiKey = await context.secrets.get('harmony.deepseekApiKey');
            if (!apiKey) {
                vscode.window.showErrorMessage('No DeepSeek API key set.');
                return;
            }
            const testLimits = [8192, 16384, 32768, 65536, 131072, 262144, 384000];
            const results: string[] = [];
            for (const limit of testLimits) {
                const body = JSON.stringify({
                    model: 'deepseek-v4-pro',
                    messages: [{ role: 'user', content: 'Say exactly "OK" and nothing else.' }],
                    max_tokens: limit,
                    temperature: 0
                });
                try {
                    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                        body,
                        signal: AbortSignal.timeout(15000)
                    });
                    const text = await resp.text();
                    if (resp.ok) {
                        const j = JSON.parse(text);
                        results.push(`✅ ${limit.toLocaleString()} — ACCEPTED (used: ${j.usage?.completion_tokens ?? '?'} tokens)`);
                    } else {
                        const j = JSON.parse(text);
                        results.push(`❌ ${limit.toLocaleString()} — REJECTED: ${j.error?.message ?? text.slice(0, 200)}`);
                        break;
                    }
                } catch (e: any) {
                    results.push(`⚠️ ${limit.toLocaleString()} — ERROR: ${e.message}`);
                    break;
                }
            }
            const msg = results.join('\n');
            vscode.window.showInformationMessage('DeepSeek Token Limit Test', { modal: true, detail: msg });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.continueLastTurn', async () => {
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: '@harmony Please continue from where the previous Harmony response hit the agent step limit. Use the current chat history and finish the outstanding work.',
                    isPartialQuery: false
                });
            } catch {
                await vscode.commands.executeCommand('workbench.action.chat.open');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.restoreLastPrompt', async () => {
            const lastPrompt: string | undefined = context.workspaceState.get('harmony.lastPrompt');
            if (lastPrompt) {
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: `@harmony ${lastPrompt}`,
                    isPartialQuery: false
                });
                vscode.window.showInformationMessage('💾 Last prompt restored. Review and submit when ready.');
            } else {
                vscode.window.showInformationMessage('No saved prompt to restore. Your last prompt is auto-saved when you submit a Harmony chat message.');
            }
        })
    );

    const harmonyStatusPriority = {
        route: 98,
        primary: 97,
        agents: 96,
        usage: 95,
        hub: 94,
        whisper: 93,
    };

    // Persistent status bar launcher — always visible at the bottom of VS Code.
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, harmonyStatusPriority.primary);
    const DIRECT_PRIMARY = PROVIDER_IDS;
    const refreshHarmonyBar = () => {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const provider = cfg.get<string>('modelProvider') ?? 'vscode-lm';
        if (DIRECT_PRIMARY.includes(provider as ProviderId)) {
            const label = providerDisplayName(provider as CollabDirectProvider);
            // Read per-provider model: DeepSeek from config setting, others from workspaceState
            let model: string;
            if (provider === 'deepseek') {
                model = cfg.get<string>('deepseekModel') ?? modelFor('deepseek', 'coding');
            } else {
                model = context.workspaceState.get<string>(`harmony.primaryModel.${provider}`) ?? modelFor(provider as ProviderId, 'coding');
            }
            statusBar.text = `$(comment-discussion) Harmony: ${label}`;
            statusBar.tooltip = `Open Harmony chat (Ctrl+Alt+H). Primary route: ${label} / ${model}`;
        } else if (isProviderId(provider)) {
            const label = providerDisplayName(provider);
            statusBar.text = `$(comment-discussion) Harmony: ${label}`;
            statusBar.tooltip = `Open Harmony chat (Ctrl+Alt+H). Primary route: ${label}`;
        } else {
            statusBar.text = '$(comment-discussion) Harmony: VS Code';
            statusBar.tooltip = 'Open Harmony chat (Ctrl+Alt+H). Primary route: VS Code Chat model.';
        }
    };
    refreshHarmonyBar();
    statusBar.command = 'harmony.openChat';
    statusBar.show();
    context.subscriptions.push(statusBar);
    context.subscriptions.push(vscode.commands.registerCommand('harmony.refreshStatusBar', () => refreshHarmonyBar()));
    // Keep status bar in sync when the user changes modelProvider or any direct-provider model
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('harmony.modelProvider') || e.affectsConfiguration('harmony.deepseekModel')) {
            refreshHarmonyBar();
        }
    }));

    const providerLabel = (provider: CollabDirectProvider) => {
        return providerDisplayName(provider);
    };
    const presetLabel = (preset: CollabModelPreset, provider: CollabDirectProvider, tier: Tier) => {
        if (preset === 'economy') return 'Fast';
        if (preset === 'balanced') return 'Balanced';
        if (preset === 'power') return 'Power';
        if (preset === 'custom') return `${providerLabel(provider)} ${tier}`;
        return 'Auto';
    };

    // Collaborative routing toggle — controls sub-agent/local-agent model source only.
    const routeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, harmonyStatusPriority.route);
    const refreshRouteBar = () => {
        const mode = vscode.workspace.getConfiguration('harmony').get<string>('collabProvider') ?? 'mix';
        const label = mode === 'harmony' ? 'Harmony' : mode === 'vscode' ? 'VS Code' : 'Mix';
        routeBar.text = `$(arrow-swap) Route: ${label}`;
        routeBar.tooltip = new vscode.MarkdownString(
            `**Collaborative routing** controls where Harmony sub-agents / local agents call.\n\n` +
            `- **Harmony** — sub-agent LM calls use the selected **Agents:** direct provider.\n` +
            `- **VS Code** — sub-agents use the VS Code Language Model API.\n` +
            `- **Mix** — prefer VS Code LM, then fall back to the selected **Agents:** direct provider when VS Code LM is unavailable.\n\n` +
            `Current: **${label}**. This does not change the primary **Harmony:** model or the **Agents:** model profile.`
        );
    };
    refreshRouteBar();
    routeBar.command = 'harmony.selectCollabProvider';
    routeBar.show();
    context.subscriptions.push(routeBar);

    const agentsBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, harmonyStatusPriority.agents);
    const refreshAgentsBar = async () => {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const preset = getCollabModelPreset();
        const provider = getCollabDirectProvider();
        const tier = collabTierForPreset(preset);
        const resolved = await resolveCollabModel(context.secrets);
        agentsBar.text = `$(hubot) Agents: ${presetLabel(preset, provider, tier)}`;
        const resolvedLine = resolved
            ? `Resolved now: **${providerLabel(resolved.provider)} / ${resolved.tier} / ${resolved.model}**.`
            : `Resolved now: **no matching provider key saved**.`;
        const geminiFreeQuota = cfg.get<boolean>('gemini.useFreeQuota') === true ? 'enabled' : 'disabled';
        agentsBar.tooltip = new vscode.MarkdownString(
            `**Collaborative Agents model profile** controls the model group/tier used by Harmony direct sub-agent calls and default worker agents.\n\n` +
            `${resolvedLine}\n\n` +
            `Route source still comes from **Route:**. Primary chat model still comes from **Harmony:**.\n\n` +
            `Gemini uses the Google Generative Language / AI Studio key stored as \`harmony.geminiApiKey\`. Vertex AI uses a different auth path and is not wired here yet. Gemini free-quota mode is **${geminiFreeQuota}**.`
        );
    };
    void refreshAgentsBar();
    agentsBar.command = 'harmony.selectCollabModel';
    agentsBar.show();
    context.subscriptions.push(agentsBar);

    // Collaborative agent / sub-agent routing command.
    setCollabSecrets(context.secrets);
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.selectCollabProvider', async () => {
            const current = vscode.workspace.getConfiguration('harmony').get<string>('collabProvider') ?? 'mix';
            type Pick = vscode.QuickPickItem & { value: 'harmony' | 'vscode' | 'mix' };
            const picks: Pick[] = [
                { label: 'Harmony', description: 'Agents direct provider only', detail: 'Sub-agents never call VS Code LM. Uses the selected Agents model provider/key.', value: 'harmony', picked: current === 'harmony' },
                { label: 'VS Code', description: 'VS Code Language Model API only', detail: 'Sub-agents always use the model VS Code chat resolves.', value: 'vscode', picked: current === 'vscode' },
                { label: 'Mix', description: 'Prefer VS Code, fall back to Agents', detail: 'Current default behavior.', value: 'mix', picked: current === 'mix' },
            ];
            const pick = await vscode.window.showQuickPick(picks, {
                title: 'Harmony Collaborative Routing',
                placeHolder: `Current: ${current}. Choose which provider sub-agents should use.`
            });
            if (!pick) return;
            await vscode.workspace.getConfiguration('harmony').update('collabProvider', pick.value, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Harmony collab routing: ${pick.label}`);
        })
    );

    const showGeminiStatus = async () => {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const keySaved = !!(await context.secrets.get('harmony.geminiApiKey'));
        if (!keySaved) {
            const action = await vscode.window.showWarningMessage(
                'No Gemini API key is saved. Harmony uses an AI Studio / Google Generative Language API key for Gemini; Vertex AI is a separate future auth path.',
                'Set Gemini API Key'
            );
            if (action) await vscode.commands.executeCommand('harmony.setGeminiApiKey');
            return;
        }

        let models: string[] = [];
        let apiStatus = 'not checked';
        try {
            models = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Checking Gemini API status…' },
                (_progress, token) => discoverModels(context.secrets, 'gemini', token)
            );
            apiStatus = `${models.length} model${models.length === 1 ? '' : 's'} returned`;
        } catch (e: any) {
            apiStatus = `check failed: ${e?.message ?? String(e)}`;
        }

        const freeQuotaEnabled = cfg.get<boolean>('gemini.useFreeQuota') === true;
        type GeminiPick = vscode.QuickPickItem & { action?: 'toggleFreeQuota' | 'assignModel' | 'setKey' | 'clearKey' };
        const picks: GeminiPick[] = [
            { label: 'Gemini API key', description: 'saved', detail: 'Stored in VS Code Secret Storage as harmony.geminiApiKey. Key value is never displayed.' },
            { label: 'Gemini API status', description: apiStatus, detail: 'Checked with Google Generative Language / AI Studio /models endpoint, not Vertex AI.' },
            { label: 'Gemini free-quota mode', description: freeQuotaEnabled ? 'enabled' : 'disabled', detail: 'When enabled, Auto/Balanced Agents can prefer Gemini first and quota errors are surfaced clearly.', action: 'toggleFreeQuota' },
            { label: 'Assign discovered Gemini model to tier…', description: models.length ? `${models.length} discovered` : 'no discovered models', detail: 'Pick a model from the live /models response and save it as a Gemini tier override.', action: 'assignModel' },
            { label: 'Set Gemini API Key', description: 'replace saved key', detail: 'Stores a new AI Studio / Gemini API key.', action: 'setKey' },
            { label: 'Clear Gemini API Key', description: 'remove saved key', detail: 'Deletes harmony.geminiApiKey from VS Code Secret Storage.', action: 'clearKey' },
            { label: 'Gemini light tier', description: modelFor('gemini', 'light'), detail: 'Used by Economy/Fast when Gemini is selected.' },
            { label: 'Gemini mid tier', description: modelFor('gemini', 'mid'), detail: 'Available for explicit custom routing.' },
            { label: 'Gemini coding tier', description: modelFor('gemini', 'coding'), detail: 'Used by Auto/Balanced when Gemini is selected or free-quota mode makes Gemini first.' },
            { label: 'Gemini heavy tier', description: modelFor('gemini', 'heavy'), detail: 'Premium/cost guards apply before heavy calls.' },
        ];

        const picked = await vscode.window.showQuickPick(picks, {
            title: 'Harmony Gemini Status',
            placeHolder: 'AI Studio / Gemini API key status, free-quota mode, and tier model IDs.'
        });
        if (!picked?.action) return;
        if (picked.action === 'toggleFreeQuota') {
            await cfg.update('gemini.useFreeQuota', !freeQuotaEnabled, vscode.ConfigurationTarget.Global);
            void refreshAgentsBar();
            vscode.window.showInformationMessage(`Gemini free-quota mode: ${!freeQuotaEnabled ? 'enabled' : 'disabled'}`);
            return;
        }
        if (picked.action === 'setKey') {
            await vscode.commands.executeCommand('harmony.setGeminiApiKey');
            return;
        }
        if (picked.action === 'clearKey') {
            await vscode.commands.executeCommand('harmony.setGeminiApiKey.clear');
            return;
        }
        if (picked.action === 'assignModel') {
            if (models.length === 0) {
                vscode.window.showWarningMessage('No Gemini models were discovered. Check the saved key or try again later.');
                return;
            }
            const model = await vscode.window.showQuickPick(models, { title: 'Assign Gemini Model', placeHolder: 'Choose a discovered Gemini model.' });
            if (!model) return;
            const tier = await vscode.window.showQuickPick(['light', 'mid', 'coding', 'heavy'], { title: 'Gemini Tier Override', placeHolder: 'Choose the tier to override.' }) as Tier | undefined;
            if (!tier) return;
            await cfg.update(`providers.gemini.${tier}`, model, vscode.ConfigurationTarget.Global);
            void refreshAgentsBar();
            view.refresh();
            vscode.window.showInformationMessage(`Gemini ${tier} → ${model}`);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.checkGeminiStatus', showGeminiStatus)
    );

    const showAgentsProviderStatus = async () => {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const tier = collabTierForPreset(getCollabModelPreset());
        const primaryProvider = cfg.get<string>('modelProvider') ?? 'vscode-lm';
        const collabPreset = getCollabModelPreset();
        const collabProvider = getCollabDirectProvider();
        const collabTier = collabTierForPreset(collabPreset);
        const resolvedCollab = await resolveCollabModel(context.secrets);
        const rawSwarmProvider = cfg.get<string>('swarm.defaultProvider');
        const swarmProvider: ProviderId = PROVIDER_IDS.includes(rawSwarmProvider as ProviderId) ? rawSwarmProvider as ProviderId : 'deepseek';
        const rawSwarmTier = cfg.get<string>('swarm.defaultTier');
        const swarmTier: Tier = rawSwarmTier === 'light' || rawSwarmTier === 'mid' || rawSwarmTier === 'heavy' || rawSwarmTier === 'coding' ? rawSwarmTier : 'coding';
        const freeQuota = cfg.get<boolean>('gemini.useFreeQuota') === true ? 'enabled' : 'disabled';
        type StatusPick = vscode.QuickPickItem & { command?: string };
        const rows: StatusPick[] = [];
        for (const provider of PROVIDER_IDS) {
            const secretKey = secretKeyFor(provider);
            const saved = !!(await context.secrets.get(secretKey));
            const scopeDetail = `VS Code Secret Storage key: ${secretKey}. CLI/native provider keys use Windows DPAPI or env and are separate from this status.`;
            const endpoint = provider === 'deepseek' || provider === 'alibaba' || provider === 'tencent' || provider === 'moonshot' || provider === 'kimiCode' ? providerEndpointInfo(provider) : undefined;
            const endpointDetail = endpoint ? ` Endpoint: ${endpoint.label}${endpoint.baseUrl ? ` (${endpoint.baseUrl})` : ''}. ${endpoint.detail}` : '';
            rows.push({
                label: providerLabel(provider),
                description: saved ? 'key saved' : 'no key saved',
                detail: provider === 'gemini'
                    ? `Gemini uses the Google Generative Language / AI Studio API key stored as harmony.geminiApiKey; Vertex AI is separate. ${scopeDetail} Free-quota mode: ${freeQuota}. Current ${tier} model: ${modelFor(provider, tier)}.`
                    : provider === 'claude'
                    ? `Uses an Anthropic API key stored as harmony.claudeApiKey for Claude model calls. This is not a Claude.ai account login. ${scopeDetail} Current ${tier} model: ${modelFor(provider, tier)}.`
                    : provider === 'alibaba' || provider === 'tencent' || provider === 'moonshot' || provider === 'zhipu'
                    ? `${scopeDetail} Import from .env supports uppercase aliases first plus legacy mixed-case aliases. Current ${tier} model: ${modelFor(provider, tier)}.${endpointDetail}`
                    : `${scopeDetail} Current ${tier} model: ${modelFor(provider, tier)}.${endpointDetail}`
            });
        }
        rows.unshift({ label: 'Endpoint profiles', description: 'DeepSeek / Alibaba / Moonshot / Zhipu / StepFun / ByteDance', detail: 'Choose regional provider endpoint profiles (international vs mainland China).', command: 'harmony.selectProviderEndpointProfile' });
        rows.unshift({ label: 'KimiCode context window', description: '256k Moderato / 1M Allegretto+', detail: 'Set the KimiCode context window. Default 262144 (256k) works on all plans; 1048576 (1M) requires Allegretto+. Run this if KimiCode returns HTTP 401.', command: 'harmony.selectKimiCodeContextWindow' });
        rows.unshift({ label: 'Import Provider Keys From .env', description: 'VS Code Secret Storage', detail: 'Imports DeepSeek, Alibaba/Qwen, Moonshot/Kimi, Tencent, and Zhipu/GLM keys into the extension-side store without printing values.', command: 'harmony.importProviderKeysFromEnv' });
        rows.unshift({ label: 'Set Tencent / Hunyuan API Key', description: 'VS Code Secret Storage', detail: 'Stores harmony.tencent.apiKey for primary and Agents routes.', command: 'harmony.setTencentApiKey' });
        rows.unshift({ label: 'Set Zhipu / GLM API Key', description: 'VS Code Secret Storage', detail: 'Stores harmony.zhipu.apiKey for primary and Agents routes.', command: 'harmony.setZhipuApiKey' });
        rows.unshift({ label: 'Set Moonshot / Kimi API Key', description: 'VS Code Secret Storage', detail: 'Stores harmony.moonshot.apiKey for primary and Agents routes.', command: 'harmony.setMoonshotApiKey' });
        rows.unshift({ label: 'Set KimiCode API Key', description: 'VS Code Secret Storage', detail: 'Stores harmony.kimiCode.apiKey for primary and Agents routes. Separate from Moonshot.', command: 'harmony.setKimiCodeApiKey' });
        rows.unshift({ label: 'Set Alibaba / Qwen API Key', description: 'VS Code Secret Storage', detail: 'Stores harmony.alibaba.apiKey for primary and Agents routes.', command: 'harmony.setAlibabaApiKey' });
        rows.unshift({ label: 'Check Gemini API Status', description: 'live /models check', detail: 'Verifies the saved AI Studio / Gemini API key and manages free-quota mode.', command: 'harmony.checkGeminiStatus' });
        rows.unshift({ label: 'Set Gemini API Key', description: 'AI Studio / Gemini API key', detail: 'Stores the key in VS Code Secret Storage as harmony.geminiApiKey.', command: 'harmony.setGeminiApiKey' });
        rows.unshift({ label: 'Discover Provider Models', description: 'Query /models with saved key', detail: 'Use this to verify exact model IDs and assign provider tier overrides.', command: 'harmony.discoverModels' });
        rows.unshift({ label: 'Key stores', description: 'VS Code Secret Storage != Windows DPAPI', detail: 'Primary, Agents, and VS Code swarm provider calls use extension-side VS Code Secret Storage. Terminal/native provider calls use environment variables or the separate Windows DPAPI Harmony secret store.' });
        rows.unshift({ label: 'Swarm default', description: `${providerLabel(swarmProvider)} / ${swarmTier}`, detail: `Default swarm model: ${modelFor(swarmProvider, swarmTier)}. Provider calls are ${cfg.get<boolean>('swarm.providerCalls.enabled') ? 'enabled' : 'disabled'} and still use VS Code Secret Storage when invoked from the extension.` });
        rows.unshift({ label: 'Agents route', description: `${collabPreset} / ${providerLabel(collabProvider)} / ${collabTier}`, detail: resolvedCollab ? `Resolved now: ${providerLabel(resolvedCollab.provider)} / ${resolvedCollab.tier} / ${resolvedCollab.model}. Uses VS Code Secret Storage.` : 'No saved extension-side provider key currently resolves for Agents.' });
        rows.unshift({ label: 'Primary route', description: primaryProvider === 'vscode-lm' ? 'VS Code Chat dropdown' : primaryProvider, detail: primaryProvider === 'vscode-lm' ? 'Primary Harmony turns use the selected VS Code/Copilot chat model, not a Harmony provider key.' : `Primary Harmony turns use ${primaryProvider} via VS Code Secret Storage when that provider is selected.` });
        const picked = await vscode.window.showQuickPick(rows, {
            title: 'Harmony Agents Provider Status',
            placeHolder: 'Shows extension-side VS Code Secret Storage status; CLI/native DPAPI keys are separate.'
        });
        if (picked?.command) {
            await vscode.commands.executeCommand(picked.command);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.showAgentsProviderStatus', showAgentsProviderStatus)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.selectProviderEndpointProfile', async (providerArg?: ProviderId) => {
            const cfg = vscode.workspace.getConfiguration('harmony');
            const directProviders: Array<EndpointProviderId> = ['deepseek', 'alibaba', 'tencent', 'moonshot', 'kimiCode', 'stepfun', 'doubao', 'byteplus'];
            const provider = directProviders.includes(providerArg as any)
                ? providerArg as EndpointProviderId
                : (await vscode.window.showQuickPick(directProviders.map(value => ({ label: providerLabel(value), value })), {
                    title: 'Harmony Provider Endpoint Profile',
                    placeHolder: 'Choose the provider whose endpoint/region you want to configure.'
                }))?.value;
            if (!provider) return;
            const current = providerEndpointInfo(provider);
            type EndpointPick = vscode.QuickPickItem & { profile: 'default' | 'international' | 'mainland' | 'us' | 'beijing' | 'asia' | 'europe' | 'custom'; needsUrl?: boolean };
            const picks: EndpointPick[] = provider === 'alibaba'
                ? [
                    { label: 'Alibaba international', description: current.profile === 'international' ? 'current' : 'Singapore/global', detail: 'Use this for international DashScope/Model Studio keys. This is the endpoint that passed the recent live smoke.', profile: 'international' },
                    { label: 'Alibaba mainland China', description: current.profile === 'mainland' ? 'current' : 'China/Beijing default', detail: 'Use this for mainland China DashScope keys. International keys commonly return 401 here.', profile: 'mainland' },
                    { label: 'Alibaba US/Virginia', description: current.profile === 'us' ? 'current' : 'shared international URL', detail: 'Use this for US/Virginia-issued keys. It uses the international OpenAI-compatible endpoint unless harmony.alibaba.baseUrl is set.', profile: 'us' },
                    { label: 'Alibaba custom base URL', description: current.profile === 'custom' ? 'current' : 'advanced', detail: 'Use an exact regional base URL from Alibaba/Model Studio only when issued for the account.', profile: 'custom', needsUrl: true },
                ]
                : provider === 'tencent'
                ? [
                    { label: 'Tencent international', description: current.profile === 'international' ? 'current' : 'api.hunyuan.cloud.tencent.com', detail: 'Use this for international Tencent Hunyuan keys. OpenAI-compatible endpoint.', profile: 'international' },
                    { label: 'Tencent mainland China', description: current.profile === 'mainland' ? 'current' : 'China mainland endpoint', detail: 'Use this for mainland China Tencent Cloud Hunyuan keys.', profile: 'mainland' },
                    { label: 'Tencent custom base URL', description: current.profile === 'custom' ? 'current' : 'advanced', detail: 'Use an exact regional base URL from Tencent Cloud only when issued for the account.', profile: 'custom', needsUrl: true },
                ]
                : provider === 'stepfun'
                ? [
                    { label: 'StepFun international', description: current.profile === 'international' ? 'current' : 'api.stepfun.ai', detail: 'Use this for international StepFun keys. Accessible globally; recommended for non-China users.', profile: 'international' },
                    { label: 'StepFun mainland China', description: current.profile === 'mainland' ? 'current' : 'api.stepfun.com', detail: 'Use this for mainland China StepFun keys.', profile: 'mainland' },
                    { label: 'StepFun custom base URL', description: current.profile === 'custom' ? 'current' : 'advanced', detail: 'Use an exact regional base URL from StepFun only when issued for the account.', profile: 'custom', needsUrl: true },
                ]
                : provider === 'doubao'
                ? [
                    { label: 'Doubao / Volcengine Beijing (default)', description: current.profile === 'beijing' ? 'current' : 'ark.cn-beijing.volces.com', detail: 'Standard Volcano Engine Ark endpoint. Activate models in the Ark console first.', profile: 'beijing' },
                    { label: 'Doubao / Volcengine custom base URL', description: current.profile === 'custom' ? 'current' : 'advanced', detail: 'Use an exact regional Volcano Engine Ark base URL.', profile: 'custom', needsUrl: true },
                ]
                : provider === 'byteplus'
                ? [
                    { label: 'BytePlus Asia Pacific (default)', description: current.profile === 'asia' ? 'current' : 'ark.ap-southeast.bytepluses.com', detail: 'BytePlus ModelArk Asia Pacific (ap-southeast-1) endpoint. USD billing.', profile: 'asia' },
                    { label: 'BytePlus Europe', description: current.profile === 'europe' ? 'current' : 'ark.eu.bytepluses.com', detail: 'BytePlus ModelArk Europe (eu-west-1) endpoint. USD billing.', profile: 'europe' },
                    { label: 'BytePlus custom base URL', description: current.profile === 'custom' ? 'current' : 'advanced', detail: 'Use an exact regional BytePlus base URL.', profile: 'custom', needsUrl: true },
                ]
                : [
                    { label: `${providerLabel(provider)} default`, description: current.profile === 'default' ? 'current' : 'standard endpoint', detail: current.detail, profile: 'default' },
                    { label: `${providerLabel(provider)} custom base URL`, description: current.profile === 'custom' ? 'current' : 'advanced', detail: `Use ${current.baseUrlSetting} exactly.`, profile: 'custom', needsUrl: true },
                ];
            const picked = await vscode.window.showQuickPick(picks, {
                title: `${providerLabel(provider)} Endpoint Profile`,
                placeHolder: `Current: ${current.label}${current.baseUrl ? ` (${current.baseUrl})` : ''}`
            });
            if (!picked) return;
            if (picked.needsUrl) {
                const baseUrl = await vscode.window.showInputBox({
                    title: `${providerLabel(provider)} Base URL`,
                    prompt: 'Paste the exact OpenAI-compatible base URL for this provider account.',
                    value: current.baseUrl || '',
                    ignoreFocusOut: true,
                    validateInput: value => /^https:\/\/.+\/v\d+\/?$/i.test(value.trim()) ? undefined : 'Use a full https://.../v1 style base URL.'
                });
                if (!baseUrl) return;
                await cfg.update(current.baseUrlSetting.replace(/^harmony\./, ''), baseUrl.replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
            }
            const settingKey = provider === 'deepseek' ? 'deepseek.endpointProfile' : `${provider}.endpointProfile`;
            await cfg.update(settingKey, picked.profile, vscode.ConfigurationTarget.Global);
            const next = providerEndpointInfo(provider);
            void refreshAgentsBar();
            view.refresh();
            vscode.window.showInformationMessage(`${providerLabel(provider)} endpoint: ${next.label}${next.baseUrl ? ` (${next.baseUrl})` : ''}`);
            return next;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.selectKimiCodeContextWindow', async () => {
            const cfg = vscode.workspace.getConfiguration('harmony');
            const current = cfg.get<number>('kimiCode.contextWindow') ?? 262144;
            type CtxPick = vscode.QuickPickItem & { value: number };
            const picks: CtxPick[] = [
                {
                    label: '256k (262,144 tokens)',
                    description: current === 262144 ? 'current' : 'recommended',
                    detail: 'Works on all KimiCode plans including Moderato. This is the safe default.',
                    value: 262144,
                    picked: current === 262144
                },
                {
                    label: '1M (1,048,576 tokens)',
                    description: current === 1048576 ? 'current' : 'Allegretto+ only',
                    detail: 'Full K3 context. Requires an Allegretto or higher KimiCode plan; lower plans return HTTP 401.',
                    value: 1048576,
                    picked: current === 1048576
                },
                {
                    label: 'Custom value…',
                    description: 'advanced',
                    detail: 'Enter an exact token count from your KimiCode plan documentation.',
                    value: -1
                }
            ];
            const picked = await vscode.window.showQuickPick(picks, {
                title: 'KimiCode Context Window',
                placeHolder: `Current: ${current.toLocaleString()} tokens`
            });
            if (!picked) return;
            let value = picked.value;
            if (value === -1) {
                const raw = await vscode.window.showInputBox({
                    title: 'KimiCode Context Window',
                    prompt: 'Enter the context window in tokens (e.g. 262144 for 256k, 1048576 for 1M).',
                    value: String(current),
                    ignoreFocusOut: true,
                    validateInput: v => {
                        const n = Number(v.trim());
                        return Number.isInteger(n) && n >= 8192 && n <= 1048576 ? undefined : 'Enter a whole number between 8,192 and 1,048,576.';
                    }
                });
                if (!raw) return;
                value = Number(raw.trim());
            }
            await cfg.update('kimiCode.contextWindow', value, vscode.ConfigurationTarget.Global);
            view.refresh();
            vscode.window.showInformationMessage(`KimiCode context window: ${value.toLocaleString()} tokens`);
            return value;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.selectCollabModel', async () => {
            const cfg = vscode.workspace.getConfiguration('harmony');
            const currentPreset = getCollabModelPreset();
            const currentProvider = getCollabDirectProvider();
            const currentTier = collabTierForPreset(currentPreset);
            const geminiKeySaved = !!(await context.secrets.get('harmony.geminiApiKey'));
            const alibabaKeySaved = !!(await context.secrets.get('harmony.alibaba.apiKey'));
            const moonshotKeySaved = !!(await context.secrets.get('harmony.moonshot.apiKey'));
            const kimiCodeKeySaved = !!(await context.secrets.get('harmony.kimiCode.apiKey'));
            const tencentKeySaved = !!(await context.secrets.get('harmony.tencent.apiKey'))
                || (!!(await context.secrets.get('harmony.tencent.secretId')) && !!(await context.secrets.get('harmony.tencent.secretKey')));
            const zhipuKeySaved = !!(await context.secrets.get('harmony.zhipu.apiKey'));
            type AgentPick = vscode.QuickPickItem & { action: 'set' | 'custom' | 'status'; preset?: CollabModelPreset; provider?: CollabDirectProvider; tier?: Tier; modelOverride?: string };
            const picks: AgentPick[] = [
                { label: 'Auto / Balanced', description: 'Recommended default', detail: 'Uses a coding-tier direct provider when Route needs Harmony. Prefers Gemini only when Gemini free-quota mode is enabled.', action: 'set', preset: 'auto', provider: 'auto', tier: 'coding', picked: currentPreset === 'auto' },
                { label: 'Economy / Fast', description: 'Light models', detail: 'Best for routine scouts and low-intensity sessions.', action: 'set', preset: 'economy', provider: 'auto', tier: 'light', picked: currentPreset === 'economy' },
                { label: 'Power / Hard Sessions', description: 'Heavy models with cost guard', detail: 'Best for intense planning/review. Premium guards still ask before expensive calls unless allowed.', action: 'set', preset: 'power', provider: 'auto', tier: 'heavy', picked: currentPreset === 'power' },
                { label: 'Gemini Flash / Coding', description: geminiKeySaved ? 'Gemini key saved' : 'Gemini key not saved', detail: 'Uses the Google Generative Language / AI Studio key. Good long-context collaborative worker route.', action: 'set', preset: 'custom', provider: 'gemini', tier: 'coding', picked: currentPreset === 'custom' && currentProvider === 'gemini' && currentTier === 'coding' },
                { label: 'Gemini Pro / Heavy', description: geminiKeySaved ? 'Gemini key saved' : 'Gemini key not saved', detail: 'Uses Gemini heavy tier. Premium/cost guards apply.', action: 'set', preset: 'custom', provider: 'gemini', tier: 'heavy', picked: currentPreset === 'custom' && currentProvider === 'gemini' && currentTier === 'heavy' },
                { label: 'DeepSeek Flash', description: 'DeepSeek light tier', detail: 'Fast, inexpensive direct provider route.', action: 'set', preset: 'custom', provider: 'deepseek', tier: 'light', picked: currentPreset === 'custom' && currentProvider === 'deepseek' && currentTier === 'light' },
                { label: 'DeepSeek Pro', description: 'DeepSeek heavy tier', detail: 'Most capable DeepSeek route. Premium/cost guards apply.', action: 'set', preset: 'custom', provider: 'deepseek', tier: 'heavy', picked: currentPreset === 'custom' && currentProvider === 'deepseek' && currentTier === 'heavy' },
                { label: 'Alibaba / Qwen Turbo Latest', description: alibabaKeySaved ? 'Alibaba key saved' : 'Alibaba key not saved', detail: 'Sets Agents to Alibaba light tier and uses the curated flash-equivalent qwen-turbo-latest route.', action: 'set', preset: 'custom', provider: 'alibaba', tier: 'light', modelOverride: 'qwen-turbo-latest', picked: currentPreset === 'custom' && currentProvider === 'alibaba' && currentTier === 'light' && modelFor('alibaba', 'light') === 'qwen-turbo-latest' },
                { label: 'Alibaba / Qwen3 Coder Plus', description: alibabaKeySaved ? 'Alibaba key saved' : 'Alibaba key not saved', detail: 'Sets Agents to Alibaba coding tier and uses qwen3-coder-plus.', action: 'set', preset: 'custom', provider: 'alibaba', tier: 'coding', modelOverride: 'qwen3-coder-plus', picked: currentPreset === 'custom' && currentProvider === 'alibaba' && currentTier === 'coding' && modelFor('alibaba', 'coding') === 'qwen3-coder-plus' },
                { label: 'Alibaba / Qwen3 Max', description: alibabaKeySaved ? 'Alibaba key saved' : 'Alibaba key not saved', detail: 'Sets Agents to Alibaba heavy tier and uses qwen3-max. Premium/cost guards apply.', action: 'set', preset: 'custom', provider: 'alibaba', tier: 'heavy', modelOverride: 'qwen3-max', picked: currentPreset === 'custom' && currentProvider === 'alibaba' && currentTier === 'heavy' && modelFor('alibaba', 'heavy') === 'qwen3-max' },
                { label: 'Tencent / Hy3 Preview', description: tencentKeySaved ? 'Tencent key saved' : 'Tencent key not saved', detail: 'Sets Agents to Tencent coding tier and uses hy3-preview. OpenAI-compatible, good for mainland China users.', action: 'set', preset: 'custom', provider: 'tencent', tier: 'coding', modelOverride: 'hy3-preview', picked: currentPreset === 'custom' && currentProvider === 'tencent' && currentTier === 'coding' && modelFor('tencent', 'coding') === 'hy3-preview' },
                { label: 'Tencent / Hy3 Preview Heavy', description: tencentKeySaved ? 'Tencent key saved' : 'Tencent key not saved', detail: 'Sets Agents to Tencent heavy tier and uses hy3-preview. Premium/cost guards apply.', action: 'set', preset: 'custom', provider: 'tencent', tier: 'heavy', modelOverride: 'hy3-preview', picked: currentPreset === 'custom' && currentProvider === 'tencent' && currentTier === 'heavy' && modelFor('tencent', 'heavy') === 'hy3-preview' },
                { label: 'Zhipu / GLM-5.2 Coding', description: zhipuKeySaved ? 'Zhipu key saved' : 'Zhipu key not saved', detail: 'Sets Agents to Zhipu coding tier and uses GLM-5.2. OpenAI-compatible, great for mainland China users.', action: 'set', preset: 'custom', provider: 'zhipu', tier: 'coding', modelOverride: 'glm-5.2', picked: currentPreset === 'custom' && currentProvider === 'zhipu' && currentTier === 'coding' && modelFor('zhipu', 'coding') === 'glm-5.2' },
                { label: 'Zhipu / GLM-5.2 Heavy', description: zhipuKeySaved ? 'Zhipu key saved' : 'Zhipu key not saved', detail: 'Sets Agents to Zhipu heavy tier and uses GLM-5.2. Premium/cost guards apply.', action: 'set', preset: 'custom', provider: 'zhipu', tier: 'heavy', modelOverride: 'glm-5.2', picked: currentPreset === 'custom' && currentProvider === 'zhipu' && currentTier === 'heavy' && modelFor('zhipu', 'heavy') === 'glm-5.2' },
                { label: 'Moonshot / Kimi K3 Flagship', description: moonshotKeySaved ? 'Moonshot key saved' : 'Moonshot key not saved', detail: 'Sets Agents to Moonshot heavy tier with Kimi K3 — 1M context, reasoning_effort:max.', action: 'set', preset: 'custom', provider: 'moonshot', tier: 'heavy', modelOverride: 'kimi-k3', picked: currentPreset === 'custom' && currentProvider === 'moonshot' && currentTier === 'heavy' && modelFor('moonshot', 'heavy') === 'kimi-k3' },
                { label: 'Moonshot / Kimi K2.7 Code', description: moonshotKeySaved ? 'Moonshot key saved' : 'Moonshot key not saved', detail: 'Sets Agents to Moonshot mid tier with Kimi K2.7 Code — stable coding, thinking ON.', action: 'set', preset: 'custom', provider: 'moonshot', tier: 'mid', modelOverride: 'kimi-k2.7-code', picked: currentPreset === 'custom' && currentProvider === 'moonshot' && currentTier === 'mid' && modelFor('moonshot', 'mid') === 'kimi-k2.7-code' },
                { label: 'KimiCode / K3', description: kimiCodeKeySaved ? 'KimiCode key saved' : 'KimiCode key not saved', detail: 'Sets Agents to KimiCode coding tier with K3 (membership platform).', action: 'set', preset: 'custom', provider: 'kimiCode', tier: 'coding', modelOverride: 'k3', picked: currentPreset === 'custom' && currentProvider === 'kimiCode' && currentTier === 'coding' && modelFor('kimiCode', 'coding') === 'k3' },
                { label: 'KimiCode / K2.7 Code', description: kimiCodeKeySaved ? 'KimiCode key saved' : 'KimiCode key not saved', detail: 'Sets Agents to KimiCode mid tier with K2.7 Code (membership platform).', action: 'set', preset: 'custom', provider: 'kimiCode', tier: 'mid', modelOverride: 'kimi-for-coding', picked: currentPreset === 'custom' && currentProvider === 'kimiCode' && currentTier === 'mid' && modelFor('kimiCode', 'mid') === 'kimi-for-coding' },
                { label: 'Custom provider / tier…', description: 'Pick exact provider and tier', detail: 'Use this for DeepSeek, Alibaba/Qwen, Moonshot/Kimi, Gemini, OpenRouter, OpenAI, or Anthropic Claude models.', action: 'custom' },
                { label: 'Show provider/key status…', description: 'Interactive status', detail: 'Shows which provider keys are saved and how Gemini/AI Studio is wired.', action: 'status' },
            ];
            const pick = await vscode.window.showQuickPick(picks, {
                title: 'Harmony Agents Model Selector',
                placeHolder: `Current: ${presetLabel(currentPreset, currentProvider, currentTier)}. Choose the model profile for collaborative agents.`
            });
            if (!pick) return;
            if (pick.action === 'status') {
                await showAgentsProviderStatus();
                return;
            }
            let nextPreset = pick.preset;
            let nextProvider = pick.provider;
            let nextTier = pick.tier;
            if (pick.action === 'custom') {
                const providerPick = await vscode.window.showQuickPick(
                    ['auto', ...PROVIDER_IDS].map(value => ({ label: providerLabel(value as CollabDirectProvider), value })),
                    { title: 'Harmony Agents Provider', placeHolder: 'Choose a direct provider for collaborative agents.' }
                );
                if (!providerPick) return;
                const tierPick = await vscode.window.showQuickPick(['light', 'mid', 'coding', 'heavy'], {
                    title: 'Harmony Agents Tier',
                    placeHolder: 'Choose collaborative agent model tier.'
                });
                if (!tierPick) return;
                nextPreset = 'custom';
                nextProvider = isProviderId(providerPick.value) ? providerPick.value : 'auto';
                nextTier = tierPick as Tier;
            }
            if (!nextPreset || !nextProvider || !nextTier) return;
            await cfg.update('collabModelPreset', nextPreset, vscode.ConfigurationTarget.Global);
            await cfg.update('collabDirectProvider', nextProvider, vscode.ConfigurationTarget.Global);
            await cfg.update('collabDirectTier', nextTier, vscode.ConfigurationTarget.Global);
            if (pick.modelOverride && isProviderId(nextProvider)) {
                await cfg.update(`providers.${nextProvider}.${nextTier}`, pick.modelOverride, vscode.ConfigurationTarget.Global);
            }
            void refreshAgentsBar();
            view.refresh();
            const resolved = await resolveCollabModel(context.secrets);
            const summary = resolved
                ? `Harmony Agents: ${providerLabel(resolved.provider)} ${resolved.tier} (${resolved.model})`
                : `Harmony Agents: ${presetLabel(nextPreset, nextProvider, nextTier)} selected, but no matching provider key is saved.`;
            if (nextProvider === 'gemini' && !geminiKeySaved) {
                const action = await vscode.window.showWarningMessage(`${summary} Set a Gemini API key to enable this route.`, 'Set Gemini API Key');
                if (action) await vscode.commands.executeCommand('harmony.setGeminiApiKey');
            } else if (nextProvider === 'alibaba' && !alibabaKeySaved) {
                const action = await vscode.window.showWarningMessage(`${summary} Set an Alibaba / Qwen API key to enable this route.`, 'Set Alibaba / Qwen API Key');
                if (action) await vscode.commands.executeCommand('harmony.setAlibabaApiKey');
            } else if (nextProvider === 'moonshot' && !moonshotKeySaved) {
                const action = await vscode.window.showWarningMessage(`${summary} Set a Moonshot / Kimi API key to enable this route.`, 'Set Moonshot / Kimi API Key');
                if (action) await vscode.commands.executeCommand('harmony.setMoonshotApiKey');
            } else if (nextProvider === 'tencent' && !tencentKeySaved) {
                const action = await vscode.window.showWarningMessage(`${summary} Set a Tencent / Hunyuan API key to enable this route.`, 'Set Tencent / Hunyuan API Key');
                if (action) await vscode.commands.executeCommand('harmony.setTencentApiKey');
            } else if (nextProvider === 'zhipu' && !zhipuKeySaved) {
                const action = await vscode.window.showWarningMessage(`${summary} Set a Zhipu / GLM API key to enable this route.`, 'Set Zhipu / GLM API Key');
                if (action) await vscode.commands.executeCommand('harmony.setZhipuApiKey');
            } else {
                vscode.window.showInformationMessage(summary);
            }
            return summary;
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('harmony.modelProvider') || e.affectsConfiguration('harmony.deepseekModel')) {
                refreshHarmonyBar();
            }
            if (e.affectsConfiguration('harmony.collabProvider')) {
                refreshRouteBar();
            }
            if (e.affectsConfiguration('harmony.collabModelPreset') || e.affectsConfiguration('harmony.collabDirectProvider') || e.affectsConfiguration('harmony.collabDirectTier') || e.affectsConfiguration('harmony.providers') || e.affectsConfiguration('harmony.gemini.useFreeQuota')) {
                void refreshAgentsBar();
            }
        })
    );

    // Quiet API call tracker. Hidden until there is usage this extension can measure.
    const usageBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, harmonyStatusPriority.usage);
    const refreshUsageBar = () => {
        const calls = totalCalls();
        if (calls === 0) {
            usageBar.hide();
            return;
        }

        const tokens = totalTokens();
        const rows = summarizeUsage();
        const promptTokens = rows.reduce((sum, row) => sum + row.promptTokens, 0);
        const completionTokens = rows.reduce((sum, row) => sum + row.completionTokens, 0);
        usageBar.text = `$(pulse) ${calls} call${calls === 1 ? '' : 's'}`;
        usageBar.tooltip = [
            `Harmony session usage`,
            `${calls} API call${calls === 1 ? '' : 's'}`,
            `${tokens} total token${tokens === 1 ? '' : 's'} (${promptTokens} prompt / ${completionTokens} completion)`,
            '',
            ...rows.map(row => {
                const units = row.billableUnits > 0 ? `, ${row.billableUnits} ${row.billableUnitLabel ?? 'unit'}${row.billableUnits === 1 ? '' : 's'}` : '';
                return `${row.provider}/${row.tier}/${row.model}: ${row.calls} call${row.calls === 1 ? '' : 's'}, ${row.totalTokens} tokens${units}`;
            }),
            '',
            'Use @harmony /usage for the full table, or Harmony: Reset Session Cost Counters to clear this session.'
        ].join('\n');
        usageBar.command = 'harmony.openChat';
        usageBar.show();
    };
    refreshUsageBar();
    context.subscriptions.push(usageBar, onUsageChange(refreshUsageBar));

    // Hub status indicator — second status bar item, shows daemon state.
    const hubBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, harmonyStatusPriority.hub);
    let lastHubStatusKey = '';
    const refreshHubBar = async () => {
        const hubAutoStart = vscode.workspace.getConfiguration('harmony').get<boolean>('hub.autoStart') ?? true;
        let newKey: string;
        if (await isDaemonRunning()) {
            hubBar.text = '$(database) Hub';
            hubBar.tooltip = 'HarmonyHub is running. Click to re-index workspace.';
            hubBar.command = 'harmony.indexWorkspace';
            hubBar.color = undefined;
            newKey = 'online';
        } else if (!hubAutoStart) {
            hubBar.text = '$(database) Hub paused';
            hubBar.tooltip = 'HarmonyHub is offline and on-demand starts are paused. Click to resume on-demand starts.';
            hubBar.command = 'harmony.toggleHubAutoStart';
            hubBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
            newKey = 'paused';
        } else {
            hubBar.text = '$(database) Hub $(warning)';
            hubBar.tooltip = 'HarmonyHub is offline. Click to start it.';
            hubBar.command = 'harmony.startHub';
            hubBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
            newKey = 'offline';
        }
        // Only refresh sidebar when Hub status actually changes to prevent flicker
        if (newKey !== lastHubStatusKey) {
            lastHubStatusKey = newKey;
            view.refresh();
        }
    };
    refreshHubBar();
    // Poll hub state every 30s so the indicator stays current without being noisy.
    const hubPollInterval = setInterval(refreshHubBar, 30_000);
    context.subscriptions.push({ dispose: () => clearInterval(hubPollInterval) });
    hubBar.show();
    context.subscriptions.push(hubBar);
    // Kill Hub daemon on extension deactivation to prevent zombie ports
    context.subscriptions.push({ dispose: () => { stopDaemon().catch(() => {}); } });

    // Whisper inbox counter — real-time unread indicator in status bar.
    const whisperBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, harmonyStatusPriority.whisper);
    const refreshWhisperBar = async () => {
        const count = await getUnreadCount();
        if (count === 0) {
            whisperBar.hide();
            return;
        }
        whisperBar.text = `$(mail) ${count}`;
        whisperBar.tooltip = `${count} unread whisper${count === 1 ? '' : 's'} in .harmony/inbox/. Click to see inbox.`;
        whisperBar.command = 'harmony.openInbox';
        whisperBar.show();
    };
    refreshWhisperBar();
    context.subscriptions.push(whisperBar, onWhisperChange.event(() => refreshWhisperBar()));
    // File watcher: detect whispers written externally (bypassing writeWhisper API)
    // so the status bar and unread count stay accurate even for manual file writes.
    const inboxPattern = new vscode.RelativePattern(
        vscode.workspace.workspaceFolders?.[0] ?? vscode.Uri.file(context.extensionPath),
        '.harmony/inbox/*.json'
    );
    const inboxWatcher = vscode.workspace.createFileSystemWatcher(inboxPattern, false, true, false);
    const onInboxChange = () => { onWhisperChange.fire(); };
    inboxWatcher.onDidCreate(onInboxChange);
    inboxWatcher.onDidChange(onInboxChange);
    context.subscriptions.push(inboxWatcher);

    // ── Daemon lifecycle helpers ─────────────────────────────────────────────
    /** Resolve daemon exe: bundled binary first, then user config, then PATH. */
    function resolveHubExe(): string | undefined {
        const fs = require('fs') as typeof import('fs');
        const exeName = process.platform === 'win32' ? 'harmonyhub.exe' : 'harmonyhub';
        // 1. Bundled inside the VSIX (production path — works for any user).
        const bundled = path.join(context.extensionPath, 'bin', exeName);
        if (fs.existsSync(bundled)) { return bundled; }
        // 2. User-configured path.
        const cfg = vscode.workspace.getConfiguration('harmony').get<string>('hub.exePath') ?? '';
        if (cfg && fs.existsSync(cfg)) { return cfg; }
        // 3. PATH lookup for users who install HarmonyHub separately.
        for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
            if (!dir) continue;
            const candidate = path.join(dir, exeName);
            if (fs.existsSync(candidate)) { return candidate; }
        }
        return undefined;
    }

    interface SpawnDaemonOptions {
        silent?: boolean;
        indexOnReady?: boolean;
        reason?: string;
    }

    function currentWorkspaceForSupervisor(): string | undefined {
        const fsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!fsPath || isAutoIndexBlocked(fsPath)) return undefined;
        return fsPath;
    }

    async function writeHubSupervisorHeartbeat(): Promise<void> {
        const workspace = currentWorkspaceForSupervisor();
        if (!workspace) return;
        try {
            await hubPost('/supervisor/heartbeat', {
                workspace,
                surface: 'harmonyhub',
                label: 'HarmonyHub daemon',
                staleAfterMs: 120_000,
            }, 5_000);
        } catch {
            // Hub supervisor heartbeats are best-effort; policy may not allow the workspace yet.
        }
    }

    let daemonStartPromise: Promise<boolean> | undefined;
    let daemonStopPromise: Promise<boolean> | undefined;
    let daemonStartGeneration = 0;
    let daemonProcess: child_process.ChildProcess | undefined;

    function spawnDaemon(options: SpawnDaemonOptions | boolean = {}): Promise<boolean> {
        const opts = typeof options === 'boolean' ? { silent: options } : options;
        const silent = opts.silent ?? false;
        const indexOnReady = opts.indexOnReady ?? false;

        if (daemonStartPromise) {
            if (!silent) vscode.window.showInformationMessage('HarmonyHub is already starting. Waiting for it to become ready...');
            return daemonStartPromise;
        }

        daemonStartPromise = (async () => {
            const startGeneration = ++daemonStartGeneration;
            if (daemonStopPromise) await daemonStopPromise;
            if (startGeneration !== daemonStartGeneration) return false;

            if (await isDaemonRunning()) {
                if (startGeneration !== daemonStartGeneration) return false;
                await syncAllowedRoots();
                if (indexOnReady) await indexWorkspaceFolders();
                await writeHubSupervisorHeartbeat();
                refreshHubBar();
                view.refresh();
                if (!silent) vscode.window.showInformationMessage('HarmonyHub is already running.');
                return true;
            }

            const exePath = resolveHubExe();
            if (!exePath) {
                if (!silent) {
                    vscode.window.showErrorMessage(
                        'HarmonyHub binary not found. Set harmony.hub.exePath, install harmonyhub on PATH, or bundle the daemon with the extension.',
                        'Open Settings'
                    ).then(go => { if (go) vscode.commands.executeCommand('workbench.action.openSettings', 'harmony.hub.exePath'); });
                }
                return false;
            }
            const cfg = vscode.workspace.getConfiguration('harmony');
            const dataDir = cfg.get<string>('hub.dataDir') || path.join(context.globalStorageUri.fsPath, 'hub-data');
            // Ensure the data directory exists
            const fs = require('fs') as typeof import('fs');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            const hubLogPath = path.join(dataDir, 'harmonyhub-startup.log');
            const modelPath = path.join(dataDir, 'onnx', 'model.onnx');
            const firstRunLikely = !fs.existsSync(modelPath);
            if (!silent) {
                const reason = opts.reason ? ` to ${opts.reason}` : '';
                const firstRunNote = firstRunLikely ? ' First startup may take longer while the local embedding model/index becomes ready.' : '';
                vscode.window.showInformationMessage(`HarmonyHub is starting${reason}.${firstRunNote}`);
            }

            // Pre-spawn: verify port 7878 is free (catches zombie binds from crashed Hub)
            const portTaken = await (() => new Promise<boolean>(r => {
                const sock = require('net').createConnection({ host: '127.0.0.1', port: 7878 }, () => { sock.end(); r(true); });
                sock.on('error', () => r(false));
                sock.setTimeout(2000, () => { sock.destroy(); r(true); });
            }))();
            if (portTaken) {
                if (!silent) vscode.window.showWarningMessage('HarmonyHub port 7878 is occupied. Retrying…');
                for (let attempt = 0; attempt < 3; attempt++) {
                    await new Promise(r => setTimeout(r, 2000));
                    const stillTaken = await (() => new Promise<boolean>(r => {
                        const s = require('net').createConnection({ host: '127.0.0.1', port: 7878 }, () => { s.end(); r(true); });
                        s.on('error', () => r(false));
                        s.setTimeout(1000, () => { s.destroy(); r(true); });
                    }))();
                    if (!stillTaken) break;
                }
                const finalCheck = await (() => new Promise<boolean>(r => {
                    const s = require('net').createConnection({ host: '127.0.0.1', port: 7878 }, () => { s.end(); r(true); });
                    s.on('error', () => r(false));
                    s.setTimeout(1000, () => { s.destroy(); r(true); });
                }))();
                if (finalCheck) {
                    if (!silent) vscode.window.showErrorMessage('HarmonyHub cannot start: port 7878 is still occupied.');
                    return false;
                }
            }

            return await new Promise<boolean>((resolve) => {
                let settled = false;
                let retries = 0;
                let checking = false;
                let wait: NodeJS.Timeout | undefined;
                let proc: child_process.ChildProcess | undefined;
                let procExited = false;
                let hubOutput = '';
                let logStream: import('fs').WriteStream | undefined;
                const maxStartupChecks = firstRunLikely ? 180 : 30;

                try {
                    logStream = fs.createWriteStream(hubLogPath, { flags: 'a' });
                    logStream.write(`\n===== ${new Date().toISOString()} HarmonyHub start =====\n`);
                } catch {
                    logStream = undefined;
                }

                const appendHubLog = (chunk: string) => {
                    hubOutput += chunk;
                    if (hubOutput.length > 16000) hubOutput = hubOutput.slice(-16000);
                    try { logStream?.write(chunk); } catch { /* best effort */ }
                };

                const finish = (ok: boolean) => {
                    if (settled) return;
                    settled = true;
                    if (wait) clearInterval(wait);
                    if (!ok && proc && !procExited) {
                        try { proc.kill(); } catch { /* best effort */ }
                    }
                    try { logStream?.end(); } catch { /* best effort */ }
                    refreshHubBar();
                    view.refresh();
                    resolve(ok);
                };

                const daemonArgs = ['--data-dir', dataDir];
                const supervisorWorkspace = currentWorkspaceForSupervisor();
                if (supervisorWorkspace) daemonArgs.push('--supervisor-workspace', supervisorWorkspace);

                proc = child_process.spawn(exePath, daemonArgs, {
                    cwd: dataDir,
                    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
                    env: {
                        ...process.env,
                        'OMP_NUM_THREADS': '1',
                        'RAYON_NUM_THREADS': '1',
                        'MKL_NUM_THREADS': '1',
                        'TOKIO_WORKER_THREADS': '1',
                        'ORT_ARENA_ALLOCATOR': '0'
                    }
                });
                daemonProcess = proc;
                proc.stdout?.on('data', (chunk) => appendHubLog(String(chunk)));
                proc.stderr?.on('data', (chunk) => appendHubLog(String(chunk)));
                proc.on('exit', (code, signal) => {
                    procExited = true;
                    if (daemonProcess === proc) daemonProcess = undefined;
                    if (!settled) {
                        if (!silent) {
                            const tail = summarizeHubLogTail(hubOutput);
                            const detail = tail ? ` ${tail}` : ` See ${hubLogPath} for details.`;
                            vscode.window.showErrorMessage(`HarmonyHub exited before it became ready (${signal ?? code ?? 'unknown'}).${detail}`);
                        }
                        finish(false);
                    }
                });
                proc.on('error', (error) => {
                    if (!silent) vscode.window.showErrorMessage(`HarmonyHub could not start: ${error.message}. See ${hubLogPath} for details.`);
                    finish(false);
                });

                const checkReady = async () => {
                    if (checking || settled) return;
                    checking = true;
                    try {
                        if (startGeneration !== daemonStartGeneration) {
                            finish(false);
                            return;
                        }
                        retries++;
                        if (await isDaemonRunning()) {
                            await syncAllowedRoots();
                            if (indexOnReady) await indexWorkspaceFolders();
                            await writeHubSupervisorHeartbeat();
                            if (!silent) vscode.window.showInformationMessage(indexOnReady ? 'HarmonyHub started and workspace indexing was requested.' : 'HarmonyHub started.');
                            finish(true);
                        } else if (retries > maxStartupChecks) {
                            if (!silent) vscode.window.showErrorMessage(`HarmonyHub did not respond within ${maxStartupChecks}s. See ${hubLogPath} for startup details.`);
                            finish(false);
                        }
                    } finally {
                        checking = false;
                    }
                };

                wait = setInterval(() => { void checkReady(); }, 1000);
                void checkReady();
            });
        })().finally(() => {
            daemonStartPromise = undefined;
        });

        return daemonStartPromise;
    }

    async function ensureDaemonForAction(actionLabel: string, silent = false, indexOnReady = false): Promise<boolean> {
        if (await isDaemonRunning()) return true;
        const cfg = vscode.workspace.getConfiguration('harmony');
        const hubAutoStart = cfg.get<boolean>('hub.autoStart') ?? true;
        if (!hubAutoStart) {
            if (silent) {
                refreshHubBar();
                view.refresh();
                return false;
            }
            const go = await vscode.window.showWarningMessage(
                `HarmonyHub is paused. Start it now to ${actionLabel}?`,
                'Start Hub',
                'Cancel'
            );
            if (go !== 'Start Hub') {
                refreshHubBar();
                view.refresh();
                return false;
            }
        }
        const running = await spawnDaemon({ silent, indexOnReady, reason: actionLabel });
        refreshHubBar();
        view.refresh();
        if (!running && !silent) {
            vscode.window.showErrorMessage(`HarmonyHub is still offline, so Harmony could not ${actionLabel}.`);
        }
        return running;
    }

    function stopDaemon(): Promise<boolean> {
        if (daemonStopPromise) return daemonStopPromise;
        daemonStartGeneration++;
        daemonStartPromise = undefined;
        const stopping = (async () => {
            const pid = daemonProcess?.pid;
            if (!pid) {
                return !await isDaemonRunning();
            }
            const runStopCommand = async (command: string) => await new Promise<boolean>((resolve) => {
                child_process.exec(command, { windowsHide: true }, (err) => resolve(!err));
            });
            const gentleCommand = process.platform === 'win32' ? `taskkill /PID ${pid} /T` : `kill ${pid}`;
            await runStopCommand(gentleCommand);
            let offline = await waitForDaemonOffline();
            if (!offline) {
                const forceCommand = process.platform === 'win32' ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`;
                if (!await runStopCommand(forceCommand)) return false;
                offline = await waitForDaemonOffline();
            }
            if (offline) daemonProcess = undefined;
            return offline;
        })().finally(() => {
            daemonStopPromise = undefined;
        });
        daemonStopPromise = stopping;
        return stopping;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.startHub', async () => {
            if (await isDaemonRunning()) {
                vscode.window.showInformationMessage('HarmonyHub is already running.');
                refreshHubBar();
                view.refresh();
                return true;
            }
            return spawnDaemon({ silent: false, indexOnReady: false, reason: 'start Hub' });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.stopHub', async () => {
            if (!await isDaemonRunning() && !daemonStartPromise) {
                vscode.window.showInformationMessage('HarmonyHub is already stopped.');
                refreshHubBar();
                view.refresh();
                return;
            }
            const ok = await stopDaemon();
            refreshHubBar();
            view.refresh();
            vscode.window.showInformationMessage(ok ? 'HarmonyHub stopped.' : 'Could not stop HarmonyHub automatically.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.toggleHubAutoStart', async () => {
            const cfg = vscode.workspace.getConfiguration('harmony');
            const current = cfg.get<boolean>('hub.autoStart') ?? true;
            if (current) {
                // Turning OFF — show warning first
                const choice = await vscode.window.showWarningMessage(
                    'Turning off auto-start means HarmonyHub will NOT automatically restart when the connection drops. You will need to start it manually for local recall, indexing, and other Hub features.',
                    { modal: false },
                    'Turn Off',
                    'Cancel'
                );
                if (choice !== 'Turn Off') return;
            }
            await cfg.update('hub.autoStart', !current, vscode.ConfigurationTarget.Global);
            refreshHubBar();
            view.refresh();
            if (current) {
                vscode.window.showInformationMessage('HarmonyHub auto-start paused. Hub will not restart automatically. Use Start Hub daemon below to resume.');
            } else {
                vscode.window.showInformationMessage('HarmonyHub auto-start resumed. Hub will restart automatically when needed.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.ensureHubForChat', async (options?: { indexOnReady?: boolean }) => {
            return spawnDaemon({
                silent: false,
                indexOnReady: options?.indexOnReady ?? true,
                reason: 'prepare local recall for this message'
            });
        })
    );

    // Passive refresh only. HarmonyHub starts on explicit Hub-dependent actions.
    // If daemon is running with zero vectors, trigger a background re-index.
    (async () => {
        if (await isDaemonRunning()) {
            await syncAllowedRoots();
            // Check if index is empty — if so, trigger background re-index
            try {
                const status = await hubGet('/status') as any;
                if (status && (status.vectors ?? status.vector_count ?? status.indexed_files ?? 1) === 0) {
                    // Fire-and-forget background indexing — don't block startup
                    indexWorkspaceFolders().catch(() => {});
                }
            } catch { /* daemon may not support /status fields yet */ }
        }
        refreshHubBar();
        view.refresh();
    })();

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.indexWorkspace', async () => {
            if (!await ensureDaemonForAction('index the workspace')) return;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'HarmonyHub: indexing workspace…', cancellable: false },
                async () => {
                    await syncAllowedRoots();
                    const result = await indexWorkspaceFolders();
                    view.refresh();
                    if (result.failed.length > 0) {
                        vscode.window.showWarningMessage(`Hub indexing requested for ${result.indexed.length} folder(s); ${result.failed.length} failed.`);
                    } else {
                        vscode.window.showInformationMessage(`Hub indexing requested for ${result.indexed.length} folder(s). ${result.skipped.length} folder(s) skipped by privacy rules.`);
                    }
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.switchProfile', async () => {
            const profile = await vscode.window.showInputBox({
                prompt: 'Profile identifier (default | coder | reviewer)',
                value: vscode.workspace.getConfiguration('harmony').get<string>('defaultProfile') ?? 'default'
            });
            if (profile) {
                await vscode.workspace.getConfiguration('harmony').update('defaultProfile', profile, true);
                await context.workspaceState.update('harmony.activeProfile', profile);
                vscode.window.showInformationMessage(`Harmony profile set to ${profile}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.connectBackend', async () => {
            const url = await vscode.window.showInputBox({
                prompt: 'Backend URL',
                value: vscode.workspace.getConfiguration('harmony').get<string>('backendUrl') ?? 'http://127.0.0.1:8889'
            });
            if (url) {
                await vscode.workspace.getConfiguration('harmony').update('backendUrl', url, true);
                vscode.window.showInformationMessage(`Backend set to ${url}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.setDeepSeekApiKey', async () => {
            const apiKey = await vscode.window.showInputBox({
                prompt: 'Paste your DeepSeek API key. It will be stored in VS Code Secret Storage.',
                password: true,
                ignoreFocusOut: true
            });
            if (!apiKey) return;
            await context.secrets.store('harmony.deepseekApiKey', apiKey.trim());
            invalidateKeyCache();
            await vscode.workspace.getConfiguration('harmony').update('modelProvider', 'deepseek', true);
            vscode.window.showInformationMessage('DeepSeek key saved. Harmony will use DeepSeek for new chat turns.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.clearDeepSeekApiKey', async () => {
            await context.secrets.delete('harmony.deepseekApiKey');
            invalidateKeyCache();
            vscode.window.showInformationMessage('DeepSeek key cleared.');
        })
    );

    // Per-provider key commands. Each is independently optional.
    function registerProviderKeyCommand(providerLabel: string, secretKey: string, commandId: string) {
        context.subscriptions.push(
            vscode.commands.registerCommand(commandId, async () => {
                const apiKey = await vscode.window.showInputBox({
                    prompt: `Paste your ${providerLabel} API key. Stored in VS Code Secret Storage.`,
                    password: true,
                    ignoreFocusOut: true
                });
                if (!apiKey) return;
                await context.secrets.store(secretKey, apiKey.trim());
                invalidateKeyCache();
                vscode.window.showInformationMessage(`${providerLabel} key saved.`);
                view.refresh();
            }),
            vscode.commands.registerCommand(commandId + '.clear', async () => {
                await context.secrets.delete(secretKey);
                invalidateKeyCache();
                vscode.window.showInformationMessage(`${providerLabel} key cleared.`);
                view.refresh();
            })
        );
    }
    registerProviderKeyCommand('Alibaba / Qwen', 'harmony.alibaba.apiKey', 'harmony.setAlibabaApiKey');
    registerProviderKeyCommand('Moonshot / Kimi', 'harmony.moonshot.apiKey', 'harmony.setMoonshotApiKey');
    registerProviderKeyCommand('KimiCode', 'harmony.kimiCode.apiKey', 'harmony.setKimiCodeApiKey');
    registerProviderKeyCommand('Gemini', 'harmony.geminiApiKey', 'harmony.setGeminiApiKey');
    registerProviderKeyCommand('OpenRouter', 'harmony.openrouter.apiKey', 'harmony.setOpenRouterApiKey');
    registerProviderKeyCommand('OpenAI', 'harmony.openaiApiKey', 'harmony.setOpenAIApiKey');
    registerProviderKeyCommand('Anthropic API (Claude models)', 'harmony.claudeApiKey', 'harmony.setClaudeApiKey');
    registerProviderKeyCommand('Tencent / Hunyuan', 'harmony.tencent.apiKey', 'harmony.setTencentApiKey');
    registerProviderKeyCommand('Zhipu / GLM', 'harmony.zhipu.apiKey', 'harmony.setZhipuApiKey');

    // Tencent native auth (SecretId + SecretKey)
    registerProviderKeyCommand('Tencent Native (SecretId)', 'harmony.tencent.secretId', 'harmony.setTencentSecretId');
    registerProviderKeyCommand('Tencent Native (SecretKey)', 'harmony.tencent.secretKey', 'harmony.setTencentSecretKey');

    // Multi-key slot setting: set an individual slot (C/A/E/V) for a provider.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.setProviderSlotKey', async (provider: ProviderId, slotIndex: number) => {
            if (provider === 'tencent') {
                vscode.window.showInformationMessage('Tencent uses native SecretId+SecretKey auth — not slot-based.');
                return;
            }
            const slotLabels = ['Chat', 'Agents', 'External', 'Vision'];
            const label = slotLabels[slotIndex] ?? 'Slot ' + slotIndex;
            const currentSlots = await getProviderKeys(context.secrets, provider);
            const currentValue = currentSlots[slotIndex] ?? '';
            const apiKey = await vscode.window.showInputBox({
                prompt: `${providerDisplayName(provider)} — ${label} Key (slot ${slotIndex}). Leave empty to clear.`,
                password: true,
                ignoreFocusOut: true,
                value: currentValue ? '(stored — enter new key to replace)' : ''
            });
            if (apiKey === undefined) return; // user cancelled
            const newSlots = [...currentSlots];
            while (newSlots.length < 4) newSlots.push('');
            newSlots[slotIndex] = apiKey.trim();
            await setProviderKeys(context.secrets, provider, newSlots);
            // Also update legacy key for backward compat if slot 0 changed
            if (slotIndex === 0 && newSlots[0]) {
                await context.secrets.store(secretKeyFor(provider), newSlots[0]);
            }
            invalidateKeyCache(provider);
            vscode.window.showInformationMessage(
                apiKey.trim()
                    ? `${providerDisplayName(provider)} ${label} key saved.`
                    : `${providerDisplayName(provider)} ${label} key cleared.`
            );
            view.refresh();
        }),
        // Multi-key slot editor: opens a webview panel to edit all 4 slots at once.
        vscode.commands.registerCommand('harmony.editProviderSlots', async (provider: ProviderId) => {
            if (provider === 'tencent') {
                vscode.window.showInformationMessage('Tencent uses native SecretId+SecretKey auth — not slot-based.');
                return;
            }
            const currentSlots = await getProviderKeys(context.secrets, provider);
            const panel = vscode.window.createWebviewPanel(
                'harmonySlotEditor',
                `${providerDisplayName(provider)} — Key Slots`,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            const slotLabels = ['Chat', 'Agents', 'External', 'Vision'];
            const hasValueFlags = currentSlots.map(s => !!s);
            panel.webview.html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h2 { margin: 0 0 12px; }
  .hint { opacity: 0.7; font-size: 12px; margin-bottom: 16px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-weight: 600; margin-bottom: 4px; }
  .field input { width: 100%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: monospace; }
  .field .status { font-size: 11px; margin-top: 2px; }
  .set { color: var(--vscode-charts-green); }
  .empty { color: var(--vscode-descriptionForeground); }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  button { padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; }
  .save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .save:hover { background: var(--vscode-button-hoverBackground); }
  .cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style></head><body>
<h2>${providerDisplayName(provider)} — Key Slots</h2>
<div class="hint">Paste API keys for each slot. Leave a field empty to clear it. Slot 0 (Chat) is the default key all others fall back to.</div>
${slotLabels.map((label, i) => `
<div class="field">
  <label>Slot ${i}: ${label} Key</label>
  <input type="password" id="slot${i}" placeholder="${hasValueFlags[i] ? '(stored — enter new key to replace)' : 'Paste ' + label + ' key\u2026'}" autocomplete="off">
  <div class="status ${hasValueFlags[i] ? 'set' : 'empty'}">${hasValueFlags[i] ? '\u2713 Key set' : '\u25CB Not set (falls back to Chat key)'}</div>
</div>`).join('')}
<div class="actions">
  <button class="save" id="save">Save All Slots</button>
  <button class="cancel" id="cancel">Cancel</button>
</div>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('save').addEventListener('click', () => {
  const keys = [0,1,2,3].map(i => document.getElementById('slot'+i).value.trim());
  vscode.postMessage({ type: 'saveSlots', provider: '${provider}', keys });
});
document.getElementById('cancel').addEventListener('click', () => {
  vscode.postMessage({ type: 'cancel' });
});
<\/script>
</body></html>`;
            panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.type === 'cancel') {
                    panel.dispose();
                } else if (msg.type === 'saveSlots' && msg.provider === provider) {
                    const keys: string[] = Array.isArray(msg.keys) ? msg.keys : [];
                    await setProviderKeys(context.secrets, provider, keys);
                    if (keys[0]) {
                        await context.secrets.store(secretKeyFor(provider as ProviderId), keys[0]);
                    }
                    invalidateKeyCache(provider as ProviderId);
                    panel.dispose();
                    vscode.window.showInformationMessage(`${providerDisplayName(provider as ProviderId)} key slots saved.`);
                    view.refresh();
                }
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.importProviderKeysFromEnv', async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders || [];
            const candidates: vscode.Uri[] = [];
            for (const folder of workspaceFolders) {
                const candidate = vscode.Uri.file(path.join(folder.uri.fsPath, '.env'));
                try {
                    const stat = await fs.stat(candidate.fsPath);
                    if (stat.isFile()) candidates.push(candidate);
                } catch {
                    // Missing .env files are expected in many workspaces.
                }
            }

            let selected: vscode.Uri | undefined;
            if (candidates.length === 1) {
                selected = candidates[0];
            } else if (candidates.length > 1) {
                const picked = await vscode.window.showQuickPick(candidates.map(uri => ({ label: path.basename(path.dirname(uri.fsPath)), description: uri.fsPath, uri })), {
                    placeHolder: 'Choose the .env file to import provider keys from',
                    title: 'Harmony Provider Key Import'
                });
                selected = picked?.uri;
            } else {
                const picked = await vscode.window.showOpenDialog({
                    title: 'Choose .env file for Harmony provider key import',
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: { 'Environment files': ['env'], 'All files': ['*'] }
                });
                selected = picked?.[0];
            }
            if (!selected) return { status: 'skipped', reason: 'no dotenv file selected', imported: [], missing: [] };

            const entries = parseDotenvEntries(await fs.readFile(selected.fsPath, 'utf8'));
            const imported: string[] = [];
            const missing: string[] = [];
            for (const spec of PROVIDER_ENV_IMPORTS) {
                // ── Multi-key slot import (new system) ──
                if (spec.slotEnvNames && spec.provider !== 'tencent') {
                    const slots: string[] = ['', '', '', ''];
                    let anySlotFilled = false;
                    for (const [slotIdx, envVars] of Object.entries(spec.slotEnvNames)) {
                        const idx = Number(slotIdx);
                        if (idx >= 0 && idx < 4) {
                            const envName = (envVars as string[]).find(name => entries.has(name));
                            if (envName && entries.get(envName)) {
                                slots[idx] = entries.get(envName)!;
                                anySlotFilled = true;
                            }
                        }
                    }
                    if (anySlotFilled) {
                        await setProviderKeys(context.secrets, spec.provider, slots);
                        // Also store legacy single key for backward compat
                        if (slots[0]) {
                            await context.secrets.store(spec.secretKey, slots[0]);
                        }
                        const slotLabels = slots.map((v, i) => v ? `${['Chat','Agents','External','Vision'][i]}: ${v.slice(0,8)}…` : '').filter(Boolean);
                        imported.push(`${spec.label} (${slotLabels.length} keys: ${slotLabels.join(', ')})`);
                        continue;
                    }
                }
                // ── Legacy single-key import ──
                const envName = spec.envNames.find(name => entries.has(name));
                const value = envName ? entries.get(envName) : undefined;
                if (envName && value) {
                    await context.secrets.store(spec.secretKey, value);
                    // Handle paired key (e.g. Tencent SecretId + SecretKey)
                    if (spec.pairedKey && spec.pairedEnvNames) {
                        const pairedEnvName = spec.pairedEnvNames.find(name => entries.has(name));
                        const pairedValue = pairedEnvName ? entries.get(pairedEnvName) : undefined;
                        if (pairedEnvName && pairedValue) {
                            await context.secrets.store(spec.pairedKey, pairedValue);
                            imported.push(`${spec.label} (${envName} + ${pairedEnvName})`);
                            continue;
                        }
                    }
                    imported.push(`${spec.label} (${envName})`);
                } else {
                    const label = spec.pairedEnvNames
                        ? `${spec.label}: ${spec.envNames.join(', ')} | paired: ${spec.pairedEnvNames.join(', ')}`
                        : `${spec.label}: ${spec.envNames.join(', ')}`;
                    missing.push(label);
                }
            }

            invalidateKeyCache();
            view.refresh();
            if (imported.length) {
                vscode.window.showInformationMessage(`Harmony imported ${imported.join(' and ')} into VS Code Secret Storage. Values were not printed.`);
            }
            if (!imported.length) {
                vscode.window.showWarningMessage(`Harmony did not find any provider keys in ${selected.fsPath}. Looked for: ${missing.join(' | ')}`);
            }
            return { status: imported.length ? 'imported' : 'missing', filePath: selected.fsPath, imported, missing };
        })
    );

    // Discover models live from a provider's /models endpoint and offer to set per-tier overrides.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.discoverModels', async () => {
            const providers: ProviderId[] = PROVIDER_IDS;
            const provider = await vscode.window.showQuickPick(providers, { placeHolder: 'Provider to query' }) as ProviderId | undefined;
            if (!provider) return;
            try {
                const models = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Discovering ${provider} models…` },
                    (_p, tok) => discoverModels(context.secrets, provider, tok)
                );
                if (models.length === 0) {
                    vscode.window.showWarningMessage(`No models returned for ${provider}.`);
                    return;
                }
                const picked = await vscode.window.showQuickPick(models, {
                    placeHolder: `${models.length} models available on ${provider}. Pick one to assign to a tier.`
                });
                if (!picked) return;
                const tier = await vscode.window.showQuickPick(['light', 'mid', 'heavy', 'coding'], { placeHolder: 'Assign to which tier?' });
                if (!tier) return;
                await vscode.workspace.getConfiguration('harmony').update(`providers.${provider}.${tier}`, picked, true);
                vscode.window.showInformationMessage(`${provider} ${tier} \u2192 ${picked}`);
                view.refresh();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Discover failed: ${e?.message ?? e}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.openModelDiscoveryGuide', async () => {
            const guideUri = vscode.Uri.joinPath(context.extensionUri, 'docs', 'provider-model-discovery.md');
            try {
                await vscode.commands.executeCommand('markdown.showPreview', guideUri);
            } catch {
                const doc = await vscode.workspace.openTextDocument(guideUri);
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.clearGlobalMemory', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Clear ALL cross-workspace global memory? This removes all stored technical patterns from all workspaces. This action cannot be undone.',
                { modal: true },
                'Clear All'
            );
            if (answer === 'Clear All') {
                const { clearGlobalMemory } = await import('./globalMemory');
                await clearGlobalMemory(context);
                vscode.window.showInformationMessage('🌐 Global memory cleared.');
                vscode.commands.executeCommand('harmony.refreshSidebar');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.configureSidebarMode', async () => {
            const cfg = vscode.workspace.getConfiguration('harmony');
            const raw = cfg.get<string>('sidebar.mode');
            const current = raw === 'isolated' || raw === 'compact' ? raw : 'full';
            const picked = await vscode.window.showQuickPick([
                {
                    label: 'OOM isolation sidebar',
                    description: current === 'isolated' ? 'current' : 'minimum renderer footprint',
                    detail: 'Shows only chat/diagnostic/restore controls and does not fetch or render live Harmony state.',
                    mode: 'isolated' as const,
                },
                {
                    label: 'Low-memory compact sidebar',
                    description: current === 'compact' ? 'current' : 'hide heavier lists',
                    detail: 'Keeps status and controls visible while hiding memory, session, usage, and Hub folder detail lists.',
                    mode: 'compact' as const,
                },
                {
                    label: 'Full sidebar',
                    description: current === 'full' ? 'current' : 'show all bounded details',
                    detail: 'Shows the full Harmony sidebar with capped lists and throttled refreshes.',
                    mode: 'full' as const,
                },
            ], { placeHolder: `Harmony sidebar is currently ${current}. Choose display mode.` });
            if (!picked) return;
            await cfg.update('sidebar.mode', picked.mode, vscode.ConfigurationTarget.Global);
            view.refresh();
            vscode.window.showInformationMessage(`Harmony sidebar display mode: ${picked.mode}.`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.writeOomDiagnostics', async () => {
            try {
                const reportPath = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Writing Harmony OOM diagnostic report...', cancellable: false },
                    () => writeOomDiagnosticReport(context)
                );
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath));
                await vscode.window.showTextDocument(doc, { preview: false });
                vscode.window.showInformationMessage(`Harmony OOM diagnostic report written: ${reportPath}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`OOM diagnostic failed: ${e?.message ?? e}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.enableLowMemorySafetyMode', () => enableLowMemorySafetyMode(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.restoreLowMemorySafetySettings', () => restoreLowMemorySafetySettings(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.prepareSelfUpdateCheckpoint', prepareSelfUpdateCheckpoint)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.createSeatHandoffBundle', createSeatHandoffBundle)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.createResumeBrief', createResumeBrief)
    );

    // Reset per-session cost counters.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.resetCostCounters', () => {
            clearUsage();
            vscode.window.showInformationMessage('Harmony session usage counters reset.');
        })
    );

    // Run .harmony self-cleanup
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.runCleanup', async () => {
            const report = await harmonySelfCleanup();
            const totalSize = formatBytes(report.beforeBytes);
            const healthSize = formatBytes(report.contextHealthBytes ?? 0);
            const summary = report.actions.filter(a =>
              a.includes('Removed') || a.includes('Trimmed') || a.includes('Compacted')
            );
            const header = `🧹 Cleanup complete → Context: ${healthSize} (total .harmony: ${totalSize})`;
            const lines = summary.length > 0
              ? [header, ...summary]
              : [header, ...report.actions];
            const msg = lines.join('\n');
            vscode.window.showInformationMessage(msg, { modal: false }, 'OK');
            vscode.commands.executeCommand('harmony.refreshSidebar');
        })
    );

    // Manage saved sessions.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.listSessions', async () => {
            const names = await listSessions();
            if (names.length === 0) { vscode.window.showInformationMessage('No saved sessions in this workspace.'); return; }
            const action = await vscode.window.showQuickPick(
                names.map(n => ({ label: n, description: 'click to choose action' })),
                { placeHolder: 'Saved sessions' }
            );
            if (!action) return;
            const op = await vscode.window.showQuickPick(['Resume in chat', 'Delete'], { placeHolder: action.label });
            if (op === 'Resume in chat') {
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: `@harmony /resume ${action.label}`, isPartialQuery: false
                });
            } else if (op === 'Delete') {
                await deleteSession(action.label);
                vscode.window.showInformationMessage(`Deleted session: ${action.label}`);
                view.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.createHandoff', async () => {
            const notes = await vscode.window.showInputBox({
                prompt: 'Optional handoff note (what should future Harmony know first?)',
                ignoreFocusOut: true
            });
            if (notes === undefined) return;
            try {
                const rel = await createHandoffPacket(notes);
                const open = await vscode.window.showInformationMessage(`Harmony handoff created: ${rel}`, 'Open file');
                if (open) {
                    const ws = vscode.workspace.workspaceFolders?.[0];
                    if (ws) vscode.window.showTextDocument(vscode.Uri.file(path.join(ws.uri.fsPath, rel)), { preview: false });
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Handoff failed: ${e?.message ?? String(e)}`);
            }
        })
    );

    // ─── Whisper commands ────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.whisperCheck', async () => {
            try {
                const unread = await readUnread();
                if (unread.length === 0) {
                    vscode.window.showInformationMessage('📥 Whisper Inbox is empty — no unread whispers.');
                    return;
                }
                const markAction = 'Mark All Read';
                const items = unread.map((w, i) => ({
                    label: `$(comment) #${i + 1}`,
                    description: w.body.slice(0, 80) + (w.body.length > 80 ? '…' : ''),
                    detail: `${w.source} · ${new Date(w.createdAt).toLocaleString()}`,
                }));
                const pick = await vscode.window.showQuickPick(items, {
                    placeHolder: `${unread.length} unread whisper(s) — select to mark read, Esc to keep`,
                    matchOnDescription: true,
                });
                if (pick) {
                    const idx = items.indexOf(pick);
                    if (idx >= 0 && idx < unread.length) {
                        await markRead(unread[idx].id);
                        vscode.window.showInformationMessage(`Whisper #${idx + 1} marked read.`);
                    }
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Whisper check failed: ${e?.message ?? String(e)}`);
            }
        })
    );

    // ── Custom Swarm Roles Commands ──────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.addCustomRole', async () => {
            const id = await vscode.window.showInputBox({ prompt: 'Role ID (e.g., documenter, code_reviewer)', placeHolder: 'documenter' });
            if (!id) return;
            const label = await vscode.window.showInputBox({ prompt: 'Role label (e.g., 📝 Documenter)', placeHolder: '📝 Documenter' });
            if (!label) return;
            const purpose = await vscode.window.showInputBox({ prompt: 'Purpose (one sentence)', placeHolder: 'Creates clear documentation from swarm findings' });
            if (!purpose) return;
            try {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (!root) throw new Error('No workspace');
                const dir = vscode.Uri.joinPath(root, '.harmony', 'swarm');
                const file = vscode.Uri.joinPath(dir, 'custom-roles.json');
                await vscode.workspace.fs.createDirectory(dir);
                let roles: any[] = [];
                try { const buf = await vscode.workspace.fs.readFile(file); roles = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { /* new */ }
                roles.push({ id, label, purpose });
                await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(roles, null, 2), 'utf8'));
                vscode.window.showInformationMessage(`🎭 Custom role '${label}' added.`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to add role: ${e?.message ?? String(e)}`);
            }
        }),
        vscode.commands.registerCommand('harmony.editCustomRolesJson', async () => {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!root) { vscode.window.showErrorMessage('No workspace open.'); return; }
            const dir = vscode.Uri.joinPath(root, '.harmony', 'swarm');
            const file = vscode.Uri.joinPath(dir, 'custom-roles.json');
            await vscode.workspace.fs.createDirectory(dir);
            try { await vscode.workspace.fs.stat(file); } catch { await vscode.workspace.fs.writeFile(file, Buffer.from('[]', 'utf8')); }
            const doc = await vscode.workspace.openTextDocument(file);
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('harmony.deleteCustomRole', async (index?: number) => {
            if (index === undefined || index === null) return;
            try {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (!root) throw new Error('No workspace');
                const file = vscode.Uri.joinPath(root, '.harmony', 'swarm', 'custom-roles.json');
                const buf = await vscode.workspace.fs.readFile(file);
                const roles: any[] = JSON.parse(Buffer.from(buf).toString('utf8'));
                if (index < 0 || index >= roles.length) { vscode.window.showErrorMessage('Invalid role index.'); return; }
                const removed = roles[index];
                roles.splice(index, 1);
                await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(roles, null, 2), 'utf8'));
                vscode.window.showInformationMessage(`🎭 Role '${removed.label || removed.id}' deleted.`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to delete role: ${e?.message ?? String(e)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.whisperWrite', async () => {
            const body = await vscode.window.showInputBox({
                prompt: 'Whisper message (prefixed with @harmony in terminal)',
                placeHolder: 'e.g. Check the auth flow in login.ts',
                ignoreFocusOut: true,
            });
            if (!body || !body.trim()) return;
            try {
                const w = await writeWhisper(body.trim(), 'command');
                vscode.window.showInformationMessage(`📥 Whisper saved — read on next turn. (${w.id.slice(0, 8)})`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Whisper write failed: ${e?.message ?? String(e)}`);
            }
        }),

        vscode.commands.registerCommand('harmony.openInbox', async () => {
            try {
                const unread = await readUnread();
                if (unread.length === 0) {
                    vscode.window.showInformationMessage('📥 No unread whispers.');
                    return;
                }
                const items = unread.map((w, i) => ({
                    label: `$(comment) ${new Date(w.createdAt).toLocaleTimeString()}`,
                    description: w.body.slice(0, 80) + (w.body.length > 80 ? '…' : ''),
                    detail: `${w.source}`,
                }));
                const pick = await vscode.window.showQuickPick(items, {
                    placeHolder: `${unread.length} unread whisper(s) — click to mark read`,
                    matchOnDescription: true,
                });
                if (pick) {
                    const idx = items.indexOf(pick);
                    if (idx >= 0 && idx < unread.length) {
                        await markRead(unread[idx].id);
                        vscode.window.showInformationMessage(`✅ Whisper marked read.`);
                    }
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Inbox check failed: ${e?.message ?? String(e)}`);
            }
        })
    );

    // ─── Hub allow-list commands ──────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.allowHubFolder', async () => {
            // OS folder picker — no manual typing needed.
            const uris = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: true,
                openLabel: 'Allow for Hub indexing',
                title: 'Select folders HarmonyHub may index',
            });
            if (!uris || uris.length === 0) return;

            const cfg = vscode.workspace.getConfiguration('harmony');
            const existing = cfg.get<string[]>('hub.allowedRoots') ?? [];
            const newPaths = uris.map(u => u.fsPath);
            const merged = [...new Set([...existing, ...newPaths])];
            await cfg.update('hub.allowedRoots', merged, vscode.ConfigurationTarget.Global);

            // Immediately sync to running daemon.
            for (const p of newPaths) {
                try { await hubPost('/policy/allow', { path: p }); } catch { /* daemon offline */ }
            }

            vscode.window.showInformationMessage(
                `Hub: allowed ${newPaths.length} folder(s). They persist in settings and sync when Hub is running.`
            );
            view.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.manageHubRoots', async () => {
            const existing = vscode.workspace.getConfiguration('harmony').get<string[]>('hub.allowedRoots') ?? [];
            if (existing.length === 0) {
                const go = await vscode.window.showInformationMessage(
                    'No folders are currently allowed for Hub indexing.',
                    'Add folder…'
                );
                if (go) vscode.commands.executeCommand('harmony.allowHubFolder');
                return;
            }
            const items = [
                { label: '$(add) Add folder…', path: '__add__' },
                ...existing.map(p => ({ label: p, description: 'click to remove', path: p }))
            ];
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Allowed Hub folders — select one to remove, or add new',
                matchOnDescription: true,
            });
            if (!pick) return;
            if (pick.path === '__add__') {
                vscode.commands.executeCommand('harmony.allowHubFolder');
                return;
            }
            // Remove the selected root.
            const cfg = vscode.workspace.getConfiguration('harmony');
            const updated = existing.filter(p => p !== pick.path);
            await cfg.update('hub.allowedRoots', updated, vscode.ConfigurationTarget.Global);
            try { await hubPost('/policy/unallow', { path: pick.path }); } catch { /* daemon offline */ }
            vscode.window.showInformationMessage(`Hub: removed "${pick.path}" from allowed roots.`);
            view.refresh();
        })
    );

    // ── Harmony Compose: long-form input with image attach ───────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.compose', () => {
            openComposeView(context);
        })
    );

    // Final passive Hub refresh. Hub startup is demand-driven above.
    refreshHubBar();
    view.refresh();
}

export function deactivate() {}
