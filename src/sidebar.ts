import * as vscode from 'vscode';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { recallMemory, currentWorkspaceFingerprint, memoryStats } from './memory';
import { getOrchestrateSessionStats } from './orchestrateMode';
import { loadTodos, onTodoChange } from './todoStore';
import { collabTierForPreset, countProviderKeys, EndpointProviderId, getCollabDirectProvider, getCollabModelPreset, hasKey, modelFor, providerDisplayName, providerDisplayNameZh, providerEndpointInfo, PROVIDER_IDS, ProviderId, resolveCollabModel, secretKeyFor, Tier } from './providers';
import { summarize as summarizeUsage, totalCalls, totalTokens, onUsageChange, getFallbackEvents, providerAccountingSummary } from './costTracker';
import type { ProviderAccountingSummary } from './costTracker';
import { listSessions } from './sessions';
import { getHarmonyFolderSize, getContextHealthSize } from './cleanup';
import { getUnreadCount, onWhisperChange, writeWhisper, isWhisperDisabled } from './whisperInbox';
import { concertCheck } from './concertHall';
import { getActiveDeliberations } from './deliberation';
import { getScore, getStatusLabel } from './providerHealth';
import { buildSidebarModelOptions, getDeepSeekModel, modelDisplayNameAny, setDeepSeekModel } from './providerModels';
import { globalMemoryStats, clearGlobalMemory } from './globalMemory';
import { LanguageManager } from './languageManager';
import { ProfileRegistry } from './profileRegistry';
const VIEW_ID = 'harmony.controlPanel';
const SIDEBAR_REFRESH_DELAY_MS = 150;
const SIDEBAR_MAX_USAGE_ROWS = 40;
const SIDEBAR_MAX_FALLBACK_EVENTS = 20;
const SIDEBAR_MAX_MODEL_FILTERS_PER_PROVIDER = 40;
type SidebarMode = 'full' | 'compact' | 'isolated';

function cappedModelFilterMap(map: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(map).map(([provider, values]) => [
    provider,
    values.slice(0, SIDEBAR_MAX_MODEL_FILTERS_PER_PROVIDER)
  ]));
}

function cappedAccountingSummary(summary: ProviderAccountingSummary): ProviderAccountingSummary {
  return {
    ...summary,
    allowedModelsByProvider: cappedModelFilterMap(summary.allowedModelsByProvider),
    deniedModelsByProvider: cappedModelFilterMap(summary.deniedModelsByProvider),
  };
}

/**
 * Return a stable hash of sidebar state, excluding transient live counters,
 * timestamps, and byte-size fluctuations that change on every refresh.
 * This prevents full sidebar re-renders when only usage counters or
 * context-health byte counts have changed — the webview still receives
 * the full state (with live counters) when a meaningful field changes.
 */
function stableHashForSidebarState(state: Record<string, unknown>): string {
  const s = { ...state } as Record<string, unknown>;
  // Strip live usage counters (increment on every LLM call, even mid-session)
  if (s.usage && typeof s.usage === 'object') {
    const u = { ...s.usage as Record<string, unknown> };
    delete u.calls;
    delete u.total;
    s.usage = u;
  }
  // Strip transient context-health byte count (fluctuates with every file write)
  if (s.contextHealth && typeof s.contextHealth === 'object') {
    const ch = { ...s.contextHealth as Record<string, unknown> };
    delete ch.harmonyBytes;
    s.contextHealth = ch;
  }
  // Strip concert board messages (timestamps change, always fresh)
  delete s.concertBoard;
  // Strip memory entry timestamps (change even when content is identical)
  if (Array.isArray(s.memory)) {
    s.memory = (s.memory as Array<Record<string, unknown>>).map(m => {
      const { ts, ...rest } = m;
      return rest;
    });
  }
  // Strip transient provider health score/attempts
  if (s.providerHealth && typeof s.providerHealth === 'object') {
    const ph = { ...s.providerHealth as Record<string, unknown> };
    delete ph.score;
    delete ph.attempts;
    s.providerHealth = ph;
  }
  // Strip live memory stats counters
  if (s.memoryStats && typeof s.memoryStats === 'object') {
    const ms = { ...s.memoryStats as Record<string, unknown> };
    delete ms.activeEntries;
    delete ms.totalPrompts;
    delete ms.totalTokens;
    s.memoryStats = ms;
  }
  // Strip orchestrateBudget — contains sessionAgeMinutes that changes every minute
  delete s.orchestrateBudget;
  return JSON.stringify(s);
}

// Primary model options — now sourced from the central providerModels.ts registry.
// To add/remove/rename a model, edit PROVIDER_REGISTRY in src/providerModels.ts ONLY.
const PRIMARY_MODEL_OPTIONS = buildSidebarModelOptions();

export class HarmonyViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = VIEW_ID;

    private view?: vscode.WebviewView;
    private disposables: vscode.Disposable[] = [];
    private memoryHiddenFromPanel = false;
    private refreshInFlight = false;
    private refreshQueued = false;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private lastRefreshTime = 0;
    private lastStateHash = '';
    private lastPostedHash = '';
    private lastHubStatusHash = '';
    private lastSentState: any = null;
    private webviewShellRendered = false;
    private lastWebview: vscode.Webview | null = null;
    private webviewListenerAttached = false;
    private lastConcertEnrichTime = 0;
    private static MIN_REFRESH_INTERVAL_MS = 500;
    private static CONCERT_ENRICH_INTERVAL_MS = 15_000;

    private sidebarMode(): SidebarMode {
      const raw = vscode.workspace.getConfiguration('harmony').get<string>('sidebar.mode');
      return raw === 'isolated' || raw === 'compact' ? raw : 'full';
    }

    constructor(private readonly context: vscode.ExtensionContext) {
        // Re-render when relevant settings change.
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('harmony')) this.scheduleRefresh();
            }),
          onTodoChange(() => this.scheduleRefresh()),
          onUsageChange(() => this.scheduleRefresh()),
          onWhisperChange.event(() => this.scheduleRefresh())
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        // VS Code can destroy and recreate the webview when the sidebar is
        // hidden and shown again (e.g. tab switch). When the webview object
        // changes, the new webview is blank — no HTML, no JavaScript — so
        // postMessage would go into the void. Detect this and force a full
        // HTML reset to reinitialize the webview's JavaScript runtime.
        const webviewRecreated = view.webview !== this.lastWebview;
        this.lastWebview = view.webview;
        if (!this.webviewShellRendered || webviewRecreated) {
            view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
            view.webview.html = this.renderShell(view.webview);
            this.webviewShellRendered = true;
        }
        // Reset state hashes so Phase 1 re-posts and Phase 3 re-posts
        // whether this is a fresh webview (first render) or preserved DOM (re-show).
        this.lastStateHash = '';
        this.lastPostedHash = '';

        // Only register message listener on fresh webviews. On re-shows of
        // the same webview, the existing listener is still active — attaching
        // another creates duplicate handlers that fire N times per message.
        if (webviewRecreated) {
          view.webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg?.type) {
                    case 'openChat':
                        await vscode.commands.executeCommand('harmony.openChat');
                        break;
                    case 'openCompose':
                      await vscode.commands.executeCommand('harmony.compose');
                      break;
                    case 'openSwarmLauncher':
                      await vscode.commands.executeCommand('harmony.openSwarm');
                      break;
                    case 'openSwarmDirectControls':
                      await vscode.commands.executeCommand('harmony.swarmDirectControls');
                      break;
                    case 'configureSwarmDefaults':
                      await vscode.commands.executeCommand('harmony.configureSwarmDefaults');
                      break;
                    case 'selectDeepSwarmMode':
                      // Update hints when mode selected
                      await this.updateDeepSwarmHints(msg.value as string);
                      break;
                    case 'selectDeepSwarmStrategy':
                      await this.context.workspaceState.update('harmony.deepswarmStrategy', msg.value);
                      await this.updateDeepSwarmStrategyHints(msg.value as string);
                      break;
                    case 'selectDeepSwarmProvider':
                      await this.context.workspaceState.update('harmony.deepswarmProvider', msg.value);
                      break;
                    case 'selectDeepSwarmTier':
                      await this.context.workspaceState.update('harmony.deepswarmTier', msg.value);
                      break;
                    case 'setTokenBudget':
                      await vscode.workspace.getConfiguration('harmony').update('tokenBudget', Number(msg.value), true);
                      break;
                    case 'runDeepSwarm':
                      await vscode.commands.executeCommand('harmony.runDeepSwarm', msg.pipelineId || '', msg.mode || 'thorough', msg.strategy || 'cost-optimized', msg.provider || 'auto', msg.tier || 'auto');
                      break;
                    case 'setProfile':
                        await vscode.workspace.getConfiguration('harmony').update('defaultProfile', msg.value, true);
                        await this.context.workspaceState.update('harmony.activeProfile', msg.value);
                        break;
                    case 'setProvider':
                        await vscode.workspace.getConfiguration('harmony').update('modelProvider', msg.value, true);
                        break;
                    case 'setPrimaryModel':
                        await this.context.workspaceState.update(`harmony.primaryModel.${msg.provider}`, msg.value);
                        // Also update deepseekModel setting for backward compat with /model command
                        if (msg.provider === 'deepseek') {
                            await setDeepSeekModel(msg.value);
                        } else {
                            // Keep the chat route in sync: chatParticipant resolves the model via
                            // modelFor(provider, 'coding'), which reads providers.<provider>.coding.
                            // Without this, the sidebar dropdown choice is ignored by the chat request.
                            await vscode.workspace.getConfiguration('harmony').update(`providers.${msg.provider}.coding`, msg.value, true);
                        }
                        vscode.commands.executeCommand('harmony.refreshStatusBar');
                        break;
                    case 'setAgentMaxSteps': {
                      const raw = Number(msg.value);
                      if (Number.isFinite(raw)) {
                        const next = Math.floor(raw);
                        if (next === -1 || (next >= 1 && next <= 5000)) {
                          await vscode.workspace.getConfiguration('harmony')
                            .update('agentMaxSteps', next, true);
                        }
                      }
                      break;
                    }
                    case 'toggleAutoApprove':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('autoApproveTools', !!msg.value, true);
                        break;
                    case 'togglePlanOnly':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('planOnlyMode', !!msg.value, true);
                        break;
                    case 'setKey':
                        await vscode.commands.executeCommand('harmony.setDeepSeekApiKey');
                        break;
                    case 'setProviderKey':
                        await vscode.commands.executeCommand('harmony.editProviderSlots', msg.provider);
                        break;
                    case 'setProviderSlotKey':
                        await vscode.commands.executeCommand('harmony.setProviderSlotKey', msg.provider, msg.slotIndex);
                        break;
                    case 'setBigGunsMode':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('bigGunsMode', msg.value, true);
                        break;
                    case 'togglePlannerEnforced':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('plannerEnforced', !!msg.value, true);
                        break;
                    case 'toggleCheckpoint':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('checkpointMode', !!msg.value, true);
                        break;
                    case 'toggleOrchestrateMode':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('orchestrateMode.enabled', !!msg.value, true);
                        void this.refresh();
                        break;
                    case 'toggleDeepOrchestrateMode':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('deepOrchestrate.enabled', !!msg.value, true);
                        void this.refresh();
                        break;
                    case 'deepOrchestrate':
                        await vscode.commands.executeCommand('harmony.deepOrchestrateApprove');
                        break;
                    case 'togglePreActionChecklist':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('contextPersistence.preActionChecklist', !!msg.value, true);
                        break;
                    case 'toggleSwarmVerifier':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('contextPersistence.swarmVerifier', !!msg.value, true);
                        break;
                    case 'toggleSwarmProviderFanout':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('swarm.providerCalls.enabled', !!msg.value, true);
                        break;
                    case 'setActiveBatchSize':
                        const n = Number(msg.value);
                        if (n >= 1 && n <= 50) {
                            await vscode.workspace.getConfiguration('harmony')
                                .update('contextPersistence.activeBatchSize', n, true);
                        }
                        break;
                    case 'toggleToolRoutingGuard':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('toolRoutingGuard', !!msg.value, true);
                        break;
                    case 'toggleAutoRetry':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('autoRetry', !!msg.value, true);
                        break;
                    case 'toggleOcrOnly':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('vision.ocrOnly', !!msg.value, true);
                        break;
                    case 'toggleSkipOcr':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('vision.skipOcr', !!msg.value, true);
                        break;
                    case 'toggleErrorLearning':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('errorLearning.enabled', !!msg.value, true);
                        break;
                    case 'toggleFlowState':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('flowState', !!msg.value, true);
                        break;
                    case 'toggleLocalFirst':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('vision.localFirst', !!msg.value, true);
                        break;
                    case 'toggleDiagnostics':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('showDiagnosticsOnError', !!msg.value, true);
                      break;
                    case 'toggleTripleCheckAuto':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('tripleCheck.autoReminder', !!msg.value, true);
                      break;
                    case 'toggleDeepSeekTrace':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('deepseekShowThinking', !!msg.value, true);
                      break;
                    case 'toggleDeepSeekThinking':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('deepseekThinking', !!msg.value, true);
                      break;
                    case 'toggleSidebarCompact':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('sidebar.mode', msg.value ? 'compact' : 'full', true);
                      break;
                    case 'setLanguage':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('language', msg.value, true);
                      if (this.view) this.view.webview.html = this.renderShell(this.view.webview);
                      break;
                    case 'disableSidebarIsolation':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('sidebar.mode', 'compact', true);
                      if (this.view) this.view.webview.html = this.renderShell(this.view.webview);
                      break;
                    case 'configureSidebarMode':
                      await vscode.commands.executeCommand('harmony.configureSidebarMode');
                      break;
                    case 'writeOomDiagnostics':
                      await vscode.commands.executeCommand('harmony.writeOomDiagnostics');
                      break;
                    case 'enableLowMemorySafetyMode':
                      await vscode.commands.executeCommand('harmony.enableLowMemorySafetyMode');
                      break;
                    case 'reloadProfiles':
                      await ProfileRegistry.getInstance().loadAll();
                      if (this.view) this.view.webview.html = this.renderShell(this.view.webview);
                      break;
                    case 'createProfile':
                      await this.createProfileWizard();
                      break;
                    case 'restoreLowMemorySafetySettings':
                      await vscode.commands.executeCommand('harmony.restoreLowMemorySafetySettings');
                      break;
                    case 'prepareSelfUpdateCheckpoint':
                      await vscode.commands.executeCommand('harmony.prepareSelfUpdateCheckpoint');
                      break;
                    case 'createSeatHandoffBundle':
                      await vscode.commands.executeCommand('harmony.createSeatHandoffBundle');
                      break;
                    case 'createResumeBrief':
                      await vscode.commands.executeCommand('harmony.createResumeBrief');
                      break;
                    case 'setVisionModel': {
                      const v = msg.value as string;
                      if (v === 'auto') {
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.provider', 'auto', true);
                      } else if (v === 'gemini') {
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.provider', 'gemini', true);
                      } else if (v === 'zhipu') {
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.provider', 'zhipu', true);
                      } else if (v === 'alibaba') {
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.provider', 'alibaba', true);
                      } else if (v.startsWith('qwen')) {
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.provider', 'alibaba', true);
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.qwenModel', v, true);
                      } else if (v.startsWith('glm')) {
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.provider', 'zhipu', true);
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.zhipuModel', v, true);
                      } else {
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.provider', 'gemini', true);
                        await vscode.workspace.getConfiguration('harmony')
                          .update('vision.geminiModel', v, true);
                      }
                      break;
                    }
                    case 'visionFallbackReorder': {
                      const { id, direction } = msg as any;
                      const cfg = vscode.workspace.getConfiguration('harmony');
                      const order: string[] = [...(cfg.get<string[]>('vision.fallbackOrder') ?? ['gemini', 'zhipu', 'alibaba'])];
                      const idx = order.indexOf(id);
                      if (direction === 'up' && idx > 0) {
                        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
                      } else if (direction === 'down' && idx < order.length - 1) {
                        [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
                      }
                      await cfg.update('vision.fallbackOrder', order, true);
                      break;
                    }
                    case 'visionFallbackReset':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('vision.fallbackOrder', undefined, true);
                      break;
                    case 'setAutoGeminiModel':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('vision.autoGeminiModel', msg.value as string, true);
                      break;
                    case 'setAutoQwenModel':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('vision.autoQwenModel', msg.value as string, true);
                      break;
                    case 'setImageGenProvider':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('imageGen.provider', msg.value === 'openai' ? 'openai' : msg.value === 'alibaba' ? 'alibaba' : 'gemini', true);
                      break;
                    case 'toggleImageGenAutoApprove':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('imageGen.autoApprove', !!msg.value, true);
                      break;
                    case 'sendWhisper': {
                        const body = (msg.body || '').trim();
                        if (body) {
                            const w = await writeWhisper(body, 'sidebar');
                            vscode.window.showInformationMessage(LanguageManager.getInstance().getString('notify.whisperSaved') + ` (${w.id.slice(0, 8)})`);
                            this.scheduleRefresh();
                        }
                        break;
                    }
                    case 'clearGlobalMemory': {
                        const answer = await vscode.window.showWarningMessage(
                            'Clear ALL cross-workspace global memory? This removes all stored patterns from all workspaces.',
                            { modal: true },
                            'Clear All'
                        );
                        if (answer === 'Clear All') {
                            await clearGlobalMemory(this.context);
                            vscode.window.showInformationMessage(LanguageManager.getInstance().getString('notify.globalMemoryCleared'));
                            this.scheduleRefresh();
                        }
                        break;
                    }
                    case 'checkWhispers':
                        await vscode.commands.executeCommand('harmony.whisperCheck');
                        this.scheduleRefresh();
                        break;
                    case 'refreshConcertBoard':
                        this.scheduleRefresh();
                        break;
                    case 'addCustomRole':
                        await vscode.commands.executeCommand('harmony.addCustomRole');
                        break;
                    case 'editCustomRolesJson':
                        await vscode.commands.executeCommand('harmony.editCustomRolesJson');
                        break;
                    case 'refreshCustomRoles':
                        this.scheduleRefresh();
                        break;
                    case 'deleteCustomRole':
                        await vscode.commands.executeCommand('harmony.deleteCustomRole', msg.index);
                        this.scheduleRefresh();
                        break;
                    case 'toggleWhisperDisabled':
                        await vscode.workspace.getConfiguration('harmony')
                            .update('whisper.disabled', !!msg.value, true);
                        break;
                    case 'discoverModels':
                        await vscode.commands.executeCommand('harmony.discoverModels');
                        break;
                    case 'openModelDiscoveryGuide':
                      await vscode.commands.executeCommand('harmony.openModelDiscoveryGuide');
                      break;
                    case 'showAgentsProviderStatus':
                      await vscode.commands.executeCommand('harmony.showAgentsProviderStatus');
                      break;
                    case 'configureProviderEndpoints':
                      await vscode.commands.executeCommand('harmony.selectProviderEndpointProfile');
                      break;
                    case 'importProviderKeysFromEnv':
                      await vscode.commands.executeCommand('harmony.importProviderKeysFromEnv');
                      break;
                    case 'toggleSelfHealEnv':
                      await vscode.workspace.getConfiguration('harmony')
                        .update('providers.selfHealFromEnv', !!msg.value, true);
                      break;
                    case 'resetUsage':
                        await vscode.commands.executeCommand('harmony.resetCostCounters');
                        break;
                    case 'runCleanup':
                        await vscode.commands.executeCommand('harmony.runCleanup');
                        break;
                    case 'manageSessions':
                        await vscode.commands.executeCommand('harmony.listSessions');
                        break;
                    case 'restoreEngine':
                      await vscode.commands.executeCommand('harmony.restoreExtensionEngine');
                      break;
                    case 'allowHubFolder':
                        await vscode.commands.executeCommand('harmony.allowHubFolder');
                        break;
                    case 'manageHubRoots':
                        await vscode.commands.executeCommand('harmony.manageHubRoots');
                        break;
                    case 'startHub':
                        await vscode.commands.executeCommand('harmony.startHub');
                        break;
                    case 'stopHub':
                      await vscode.commands.executeCommand('harmony.stopHub');
                      break;
                    case 'toggleHubAutoStart':
                      await vscode.commands.executeCommand('harmony.toggleHubAutoStart');
                      break;
                    case 'indexWorkspace':
                        await vscode.commands.executeCommand('harmony.indexWorkspace');
                        break;
                    case 'refresh':
                        // Webview just loaded its JavaScript — safe to postMessage now.
                        // Replay cached state so the blank webview shows real data immediately
                        // while postCurrentState collects fresh state asynchronously.
                        if (this.lastSentState) {
                            view.webview.postMessage({ type: 'state', value: this.lastSentState });
                            this.lastStateHash = '__replayed__';
                            this.lastPostedHash = '__replayed__';
                        }
                        break;
                    case 'hideMemoryPanel': {
                      this.memoryHiddenFromPanel = true;
                      vscode.window.showInformationMessage(LanguageManager.getInstance().getString('notify.memoryHidden'));
                      break;
                    }
                    case 'showMemoryPanel': {
                      this.memoryHiddenFromPanel = false;
                      break;
                    }
                    case 'recallEntry':
                        // Open chat with the prior prompt as a starting point.
                        try {
                            await vscode.commands.executeCommand('workbench.action.chat.open', {
                                query: '@harmony ' + (msg.value ?? ''),
                                isPartialQuery: true
                            });
                        } catch { /* ignore */ }
                        break;
                }
                this.scheduleRefresh(0);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Harmony panel: ${e?.message ?? String(e)}`);
            }
          });
        }

        // Replay last-known state immediately so tab-switch shows cached data
        // instead of placeholders while the full refresh runs asynchronously.
        // SKIP when webview was recreated: view.webview.html = ... is async in VS Code,
        // so postMessage here would race against the webview's JavaScript initialization
        // and be silently dropped. Instead, the 'refresh' message handler (registered
        // above for new webviews) replays lastSentState when the webview signals readiness.
        if (this.lastSentState && !webviewRecreated) {
            view.webview.postMessage({ type: 'state', value: this.lastSentState });
            // Set a sentinel hash so Phase 1 in postCurrentState does NOT overwrite
            // the replayed real state with placeholder fastState (loading:true).
            // Phase 3 will see the sentinel ≠ stableHash and re-post full state.
            this.lastStateHash = '__replayed__';
            this.lastPostedHash = '__replayed__';
        }
        // Initial paint.
        this.scheduleRefresh(0);
    }

    private scheduleRefresh(delayMs = SIDEBAR_REFRESH_DELAY_MS): void {
      if (this.sidebarMode() === 'isolated') {
        if (this.view) this.view.webview.html = this.renderShell(this.view.webview);
        return;
      }
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        void this.refresh();
      }, Math.max(0, delayMs));
    }

    private async updateDeepSwarmHints(mode: string): Promise<void> {
      if (!this.view || !mode) return;
      const descriptions: Record<string, { desc: string; steps: string; cost: string }> = {
        thorough: { desc: '2–3 providers analyze in parallel, results combined for consensus.', steps: 'Parallel fan-out → cross-reference → synthesized answer', cost: '●○○ Low' },
        scrutinize: { desc: 'Primary drafts → reviewer critiques → primary revises → final answer.', steps: 'Draft → Review → Revise → Re-review → Final', cost: '●●○ Medium' },
        pioneer: { desc: 'Exploratory parallel analysis with broader, open-ended framing.', steps: 'Parallel exploration → divergence mapping → creative synthesis', cost: '●○○ Low' },
      };
      const info = descriptions[mode];
      if (!info) return;
      void this.view.webview.postMessage({
        type: 'deepswarm-hints',
        description: info.desc,
        steps: info.steps,
        cost: info.cost,
      });
    }

    private async updateDeepSwarmStrategyHints(strategy: string): Promise<void> {
      if (!this.view || !strategy) return;
      const descriptions: Record<string, string> = {
        'cost-optimized': 'DeepSeek primary, Gemini + Qwen for visual. Light tiers, low cost.',
        'balanced': 'Best per role: Gemini + Qwen for visual, DeepSeek for technical, Qwen for cross-review. Mid tiers.',
        'maximum-quality': '⚠️ ALL providers called on every step at pro/heavy tiers. High cost — critical work only.',
      };
      const desc = descriptions[strategy];
      if (!desc) return;
      void this.view.webview.postMessage({
        type: 'deepswarm-strategy-hints',
        description: desc,
      });
    }

    public async refresh(): Promise<void> {
      if (this.sidebarMode() === 'isolated') {
        if (this.view) this.view.webview.html = this.renderShell(this.view.webview);
        return;
      }
      // Throttle: prevent rapid consecutive refreshes (sidebar flashing)
      const now = Date.now();
      if (now - this.lastRefreshTime < HarmonyViewProvider.MIN_REFRESH_INTERVAL_MS) {
        this.refreshQueued = true;
        return;
      }
      if (this.refreshInFlight) {
        this.refreshQueued = true;
        return;
      }
        if (!this.view) return;
      this.lastRefreshTime = now;
      this.refreshInFlight = true;
      try {
        do {
          const view: vscode.WebviewView | undefined = this.view;
          if (!view) return;
          this.refreshQueued = false;
          try {
            await this.postCurrentState(view);
          } catch (err: any) {
            console.warn('[Harmony] Sidebar refresh failed: ' + (err?.message || err) + ' — posting loading:false fallback');
            // Always dismiss the loading spinner, even if postCurrentState throws
            if (this.view === view) {
              view.webview.postMessage({ type: 'loadingState', value: false });
            }
          }
        } while (this.refreshQueued);
      } finally {
        this.refreshInFlight = false;
      }
    }

    private async postCurrentState(view: vscode.WebviewView): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const sidebarMode = this.sidebarMode();
        const compactSidebar = sidebarMode === 'compact';
        const providers: ProviderId[] = PROVIDER_IDS;
        const endpointProviders: Array<EndpointProviderId> = ['deepseek', 'alibaba', 'tencent', 'moonshot', 'kimiCode', 'zhipu', 'zhipu-coding', 'stepfun', 'doubao', 'byteplus'];
        const endpointStatesRaw = Object.fromEntries(endpointProviders.map(provider => [provider, providerEndpointInfo(provider)]));
        // ZH localization for endpoint labels
        const zhEndpointLabels: Record<string, Record<string, string>> = {
          default: { deepseek: 'DeepSeek 默认端点', moonshot: 'Moonshot 默认端点', kimiCode: 'KimiCode 默认端点', zhipu: '智谱(Z.AI) 默认端点', 'zhipu-coding': '智谱编程计划 端点' },
          custom: { deepseek: 'DeepSeek 自定义端点', moonshot: 'Moonshot 自定义端点', kimiCode: 'KimiCode 自定义端点', zhipu: '智谱(Z.AI) 自定义端点' },
          international: { alibaba: '阿里云 国际端点', tencent: '腾讯混元 国际端点', stepfun: '阶跃星辰 国际端点' },
          mainland: { alibaba: '阿里云 中国大陆端点', tencent: '腾讯混元 中国大陆端点', stepfun: '阶跃星辰 中国大陆端点' },
          us: { alibaba: '阿里云 美国/弗吉尼亚端点' },
          beijing: { doubao: '豆包/火山方舟 北京端点' },
        };
        const zhEndpointDetails: Record<string, Record<string, string>> = {
          default: { deepseek: '使用 DeepSeek 标准 OpenAI 兼容端点', moonshot: '使用 Moonshot/Kimi 标准 OpenAI 兼容端点', kimiCode: '使用 KimiCode 标准 OpenAI 兼容端点 (api.kimi.com/coding/v1)', zhipu: '使用智谱(Z.AI) 标准 OpenAI 兼容端点', 'zhipu-coding': '使用 Z.AI 编程计划端点 (api.z.ai)' },
          custom: { deepseek: '使用 harmony.deepseekBaseUrl', moonshot: '使用 harmony.moonshot.baseUrl', kimiCode: '使用 harmony.kimiCode.baseUrl', zhipu: '使用 harmony.zhipu.baseUrl', stepfun: '使用 harmony.stepfun.baseUrl', doubao: '使用 harmony.bytedance.baseUrl', byteplus: '使用 harmony.byteplus.baseUrl' },
          international: { alibaba: '使用国际 DashScope 端点 (新加坡/全球路由)', tencent: '使用国际混元 OpenAI 兼容端点', stepfun: '使用国际 StepFun 端点 (api.stepfun.ai)' },
          mainland: { alibaba: '使用中国大陆 DashScope 端点 (北京/中国账号路由)', tencent: '使用中国大陆混元端点 (北京/中国账号路由)', stepfun: '使用中国大陆 StepFun 端点 (api.stepfun.com)' },
          us: { alibaba: '使用美国/弗吉尼亚端点' },
          beijing: { doubao: '使用火山引擎 Ark 端点 (北京区域)。需先在 Ark 控制台激活模型。' },
        };
        const endpointStates = LanguageManager.getInstance().getCurrentLang() === 'zh'
          ? Object.fromEntries(endpointProviders.map(provider => {
              const info = endpointStatesRaw[provider];
              const zhLabel = zhEndpointLabels[info.profile]?.[provider];
              const zhDetail = zhEndpointDetails[info.profile]?.[provider];
              return [provider, zhLabel || zhDetail ? { ...info, label: zhLabel || info.label, detail: zhDetail || info.detail } : info];
            }))
          : endpointStatesRaw;
        const usage = summarizeUsage();
        const accounting = cappedAccountingSummary(providerAccountingSummary());
        const hubRoots = cfg.get<string[]>('hub.allowedRoots') ?? [];
        const rawSwarmProvider = cfg.get<string>('swarm.defaultProvider');
        const swarmProvider: ProviderId = PROVIDER_IDS.includes(rawSwarmProvider as ProviderId) ? rawSwarmProvider as ProviderId : 'deepseek';
        const rawSwarmTier = cfg.get<string>('swarm.defaultTier');
        const swarmTier: Tier = rawSwarmTier === 'light' || rawSwarmTier === 'mid' || rawSwarmTier === 'heavy' || rawSwarmTier === 'coding' ? rawSwarmTier : 'coding';
        const collabPreset = getCollabModelPreset();
        const collabProvider = getCollabDirectProvider();
        const collabTier = collabTierForPreset(collabPreset);
        const swarmRiskSwitches = [
          { key: 'swarm.mutationExecution.enabled', label: 'mutation execution', enabled: !!cfg.get<boolean>('swarm.mutationExecution.enabled') },
          { key: 'swarm.patchExecution.enabled', label: 'patch execution', enabled: !!cfg.get<boolean>('swarm.patchExecution.enabled') },
          { key: 'swarm.terminalExecution.enabled', label: 'terminal execution', enabled: !!cfg.get<boolean>('swarm.terminalExecution.enabled') },
          { key: 'swarm.providerCalls.enabled', label: 'provider calls', enabled: !!cfg.get<boolean>('swarm.providerCalls.enabled') },
          { key: 'swarm.autonomyExecution.enabled', label: 'autonomy execute', enabled: !!cfg.get<boolean>('swarm.autonomyExecution.enabled') },
          { key: 'swarm.commitExecution.enabled', label: 'commit execution', enabled: !!cfg.get<boolean>('swarm.commitExecution.enabled') },
        ];
        const enabledSwarmRiskSwitches = swarmRiskSwitches.filter(item => item.enabled);

        // ── Phase 1: Post immediate synchronous state with loading flag ──
        const placeholderProviderStates: Record<string, boolean> = Object.fromEntries(providers.map(p => [p, false]));
        const fastState = {
            loading: true,
            version: this.context.extension.packageJSON.version ?? '?',
            sidebarMode,
            workspace: currentWorkspaceFingerprint() ?? '(no workspace)',
            profile: this.context.workspaceState.get<string>('harmony.activeProfile')
                ?? cfg.get<string>('defaultProfile') ?? 'default',
            provider: cfg.get<string>('modelProvider') ?? 'vscode-lm',
            deepseekModel: getDeepSeekModel(),
            alibabaPrimaryModel: this.context.workspaceState.get<string>('harmony.primaryModel.alibaba')
                ?? modelFor('alibaba', 'coding'),
            moonshotPrimaryModel: this.context.workspaceState.get<string>('harmony.primaryModel.moonshot')
                ?? modelFor('moonshot', 'coding'),
            kimiCodePrimaryModel: this.context.workspaceState.get<string>('harmony.primaryModel.kimiCode')
                ?? modelFor('kimiCode', 'coding'),
            tencentPrimaryModel: this.context.workspaceState.get<string>('harmony.primaryModel.tencent')
                ?? modelFor('tencent', 'coding'),
            zhipuModel: this.context.workspaceState.get<string>('harmony.primaryModel.zhipu')
                ?? modelFor('zhipu', 'coding'),
            zhipuCodingModel: this.context.workspaceState.get<string>('harmony.primaryModel.zhipu-coding')
                ?? modelFor('zhipu-coding', 'coding'),
            // Generic per-provider model map — covers ALL providers including new ones
            primaryModels: Object.fromEntries(providers.map(p => [p, p === 'deepseek' ? getDeepSeekModel() : (this.context.workspaceState.get<string>(`harmony.primaryModel.${p}`) ?? modelFor(p, 'coding'))])),
            agentMaxSteps: cfg.get<number>('agentMaxSteps') ?? 1,
            autoApprove: !!cfg.get<boolean>('autoApproveTools'),
            planOnly: !!cfg.get<boolean>('planOnlyMode'),
            bigGunsMode: cfg.get<string>('bigGunsMode') || (cfg.get<boolean>('bigGunsAutoApprove') ? 'all' : 'off'),
            plannerEnforced: !!cfg.get<boolean>('plannerEnforced'),
            checkpoint: !!cfg.get<boolean>('checkpointMode'),
            language: cfg.get<string>('language') || 'en',
            orchestrateMode: !!cfg.get<boolean>('orchestrateMode.enabled'),
            orchestrateBudget: (() => {
                const lm = LanguageManager.getInstance();
                const stats = getOrchestrateSessionStats();
                if (stats.budget > 0) return lm.getString('orchestrate.callCount') + ' ' + stats.calls + ' / ' + stats.budget + ' · ' + stats.sessionAgeMinutes + 'm ago';
                return stats.calls > 0 ? lm.getString('orchestrate.callCount') + ' ' + stats.calls + ' · ' + lm.getString('agentSteps.unlimited').toLowerCase() + ' · ' + stats.sessionAgeMinutes + 'm ago' : lm.getString('orchestrate.unlimited');
            })(),
            deepOrchestrateMode: !!cfg.get<boolean>('deepOrchestrate.enabled'),
            preActionChecklist: cfg.get<boolean>('contextPersistence.preActionChecklist') ?? true,
            swarmVerifier: cfg.get<boolean>('contextPersistence.swarmVerifier') ?? false,
            swarmProviderFanout: cfg.get<boolean>('swarm.providerCalls.enabled') ?? false,
            activeBatchSize: cfg.get<number>('contextPersistence.activeBatchSize') ?? 5,
            toolRoutingGuard: cfg.get<boolean>('toolRoutingGuard') ?? true,
            autoRetry: cfg.get<boolean>('autoRetry') ?? true,
            showDiagnostics: cfg.get<boolean>('showDiagnosticsOnError') ?? true,
            showDeepSeekTrace: !!cfg.get<boolean>('deepseekShowThinking'),
            deepseekThinking: cfg.get<boolean>('deepseekThinking') ?? true,
            visionModel: (() => {
              const provider = cfg.get<string>('vision.provider') ?? 'auto';
              if (provider === 'auto') return 'auto';
              if (provider === 'zhipu') return cfg.get<string>('vision.zhipuModel') || 'glm-5v-turbo';
              if (provider === 'alibaba') return cfg.get<string>('vision.qwenModel') || 'qwen3.8-max';
              return cfg.get<string>('vision.geminiModel') || 'gemini-3.8-flash';
            })(),
            autoGeminiModel: cfg.get<string>('vision.autoGeminiModel') ?? 'gemini-3.8-flash',
            autoQwenModel: cfg.get<string>('vision.autoQwenModel') ?? 'qwen3.8-max',
            visionFallbackOrder: cfg.get<string[]>('vision.fallbackOrder') ?? ['gemini', 'zhipu', 'alibaba'],
            contextHealth: { harmonyBytes: 0, healthStatus: 'ok' },
            imageGenProvider: cfg.get<string>('imageGen.provider') ?? 'gemini',
            imageGenAutoApprove: !!cfg.get<boolean>('imageGen.autoApprove'),
            flowState: !!cfg.get<boolean>('flowState'),
            errorLearning: !!cfg.get<boolean>('errorLearning.enabled'),
            ocrOnly: !!cfg.get<boolean>('vision.ocrOnly'),
            skipOcr: !!cfg.get<boolean>('vision.skipOcr'),
            localFirst: !!cfg.get<boolean>('vision.localFirst'),
            selfHealEnv: !!cfg.get<boolean>('providers.selfHealFromEnv'),
            providerHealth: null,
            swarmProvider: providerDisplayName(swarmProvider),
            swarmTier,
            swarmModel: modelFor(swarmProvider, swarmTier),
            swarmDefaultMode: 'plan-only launcher',
            swarmGlobalPlanOnly: !!cfg.get<boolean>('planOnlyMode'),
            swarmProviderCallsEnabled: !!cfg.get<boolean>('swarm.providerCalls.enabled'),
            swarmRiskSwitchCount: enabledSwarmRiskSwitches.length,
            swarmRiskSwitchLabels: enabledSwarmRiskSwitches.map(item => item.label),
            deepswarmMode: compactSidebar ? '' : (this.context.workspaceState.get<string>('harmony.deepswarmMode') || 'thorough'),
            deepswarmStrategy: compactSidebar ? '' : (this.context.workspaceState.get<string>('harmony.deepswarmStrategy') || 'cost-optimized'),
            deepswarmProvider: compactSidebar ? '' : (this.context.workspaceState.get<string>('harmony.deepswarmProvider') || 'auto'),
            deepswarmTier: compactSidebar ? '' : (this.context.workspaceState.get<string>('harmony.deepswarmTier') || 'auto'),
            tokenBudget: cfg.get<number>('tokenBudget') ?? 32768,
            tripleCheckAuto: !!cfg.get<boolean>('tripleCheck.autoReminder'),
            agentsPreset: collabPreset,
            agentsProvider: collabProvider === 'auto' ? 'auto' : providerDisplayName(collabProvider),
            agentsTier: collabTier,
            agentsResolvedProvider: '',
            agentsResolvedModel: '',
            backendUrl: cfg.get<string>('backendUrl') ?? '(unset)',
            tencentKeySaved: false,
            hasKey: false,
            primaryProviderKeys: placeholderProviderStates,
            providers: placeholderProviderStates,
            providerOrder: providers,
            providerLabels: Object.fromEntries(providers.map(provider => [provider, LanguageManager.getInstance().getCurrentLang() === 'zh' ? providerDisplayNameZh(provider) : providerDisplayName(provider)])),
            providerSecretKeys: Object.fromEntries(providers.map(provider => [provider, secretKeyFor(provider)])),
            providerEndpoints: endpointStates,
            memoryHidden: this.memoryHiddenFromPanel,
            memoryCount: 0,
            memoryStats: { activeEntries: 0, totalPrompts: 0, totalTokens: 0, totalSummaries: 0, summarizedTokens: 0, removedTokens: 0, pruneCount: 0, oldestEntry: null, newestEntry: null },
            memory: [],
            todos: [],
            sessions: [],
            hubRoots: compactSidebar ? [] : hubRoots.slice(0, 20),
            hubRootCount: hubRoots.length,
            hubStatus: { online: false },
            whisperCount: 0,
            whisperDisabled: false,
            concertBoard: { messages: [], lastCheck: 0 },
            customRoles: [],
            profiles: ProfileRegistry.getInstance().list().map(p => ({ id: p.id, name: p.name, role: p.role, capsules: p.knowledge_capsules?.length ?? 0 })),
            globalMemory: { totalPatterns: 0, uniqueWorkspaces: 0, topTags: [] },
            hubAutoStart: cfg.get<boolean>('hub.autoStart') ?? true,
            hubStartOnMessage: cfg.get<string>('hub.startOnMessage') ?? 'prompt',
            usage: { calls: totalCalls(), total: totalTokens(), rows: usage.slice(0, SIDEBAR_MAX_USAGE_ROWS), accounting },
            fallbackEvents: getFallbackEvents().slice(-SIDEBAR_MAX_FALLBACK_EVENTS).map(f => ({
                originalModel: modelDisplayNameAny(f.originalModel),
                fallbackModel: modelDisplayNameAny(f.fallbackModel)
            }))
        };
        // Phase 1 posting strategy:
        // - On first render (lastStateHash empty): post full fastState to populate the shell immediately.
        // - On subsequent refreshes (queued from refreshHubBar etc.): only post loading:true
        //   to avoid overwriting valid provider/key state with placeholder (all-false) data.
        //   The placeholder fastState would set providers/hasKey to false, and if Phase 3
        //   matches lastStateHash and skips, the sidebar shows permanent red lights.
        if (this.view === view) {
            if (!this.lastStateHash) {
                // First render — post fast shell state with loading flag
                view.webview.postMessage({ type: 'state', value: fastState });
            }
            // Subsequent refreshes: skip Phase 1 loading-indicator postMessage.
            // Posting loadingState:true here caused sidebar flashing because
            // onUsageChange fires on every tool call (totalCalls/totalTokens
            // increment), triggering a full postCurrentState cycle where the
            // loading overlay briefly covers the sidebar content and then
            // disappears in Phase 3 — visible flicker on every LLM call.
            // The sidebar already shows valid data from the last render;
            // Phase 2 gathers new data silently, and Phase 3 posts only
            // when the stable hash actually differs.
        }

        // ── Phase 2: Gather ALL slow async data in parallel ──
        // ── Every operation wrapped in .catch() so a single failure never blocks Phase 3 ──
        // ── Outer 15s timeout prevents indefinite hang on slow OS operations (Windows Defender, disk I/O) ──
        const PHASE2_TIMEOUT_MS = 15_000;
        const t0 = Date.now();
        const safeDefault: any = undefined;
        const raw: any[] = await Promise.race([
            Promise.all([
                compactSidebar ? [] : recallMemory(5).catch(() => []),
                memoryStats().catch(() => ({ activeEntries: 0, preservedFiles: 0 })),
                compactSidebar ? [] : loadTodos().catch(() => []),
                (async (): Promise<Record<string, boolean>> => {
                    const s: Record<string, boolean> = {};
                    await Promise.all(providers.map(async (p) => { try { s[p] = await hasKey(this.context.secrets, p); } catch (_err) { s[p] = false; } }));
                    return s;
                })().catch(() => Object.fromEntries(providers.map(p => [p, false])) as Record<string, boolean>),
                (async (): Promise<Record<string, number>> => {
                    const s: Record<string, number> = {};
                    await Promise.all(providers.map(async (p) => { try { s[p] = await countProviderKeys(this.context.secrets, p); } catch (_err) { s[p] = 0; } }));
                    return s;
                })().catch(() => Object.fromEntries(providers.map(p => [p, 0])) as Record<string, number>),
                compactSidebar ? [] : listSessions().catch(() => []),
                getContextHealthSize().catch(() => 0),
                resolveCollabModel(this.context.secrets).catch(() => safeDefault),
                compactSidebar ? 0 : getUnreadCount().catch(() => 0),
                compactSidebar ? { totalPatterns: 0, uniqueWorkspaces: 0, topTags: [] as {tag: string; count: number}[] } : (async () => {
                    try { return globalMemoryStats(this.context); } catch { return { totalPatterns: 0, uniqueWorkspaces: 0, topTags: [] as {tag: string; count: number}[] }; }
                })(),
                (async (): Promise<{ online: boolean; model?: string; vectors?: number; indexedPathCount?: number }> => {
                    try {
                        const u = (cfg.get<string>('hub.url') ?? 'http://127.0.0.1:7878') + '/status';
                        const ctl = new AbortController();
                        const t = setTimeout(() => ctl.abort(), 800);
                        const res = await fetch(u, { signal: ctl.signal });
                        clearTimeout(t);
                        if (res.ok) {
                            const j: any = await res.json();
                            const ip = Array.isArray(j.indexed_paths) ? j.indexed_paths : [];
                            return { online: true, model: j.model, vectors: j.vectors, indexedPathCount: ip.length };
                        }
                    } catch { /* daemon offline */ }
                    return { online: false };
                })(),
                (async () => {
                    const tk = await this.context.secrets.get('harmony.tencent.apiKey');
                    if (tk) return tk;
                    const sid = await this.context.secrets.get('harmony.tencent.secretId');
                    const sk = await this.context.secrets.get('harmony.tencent.secretKey');
                    return (sid && sk) ? 'native' : undefined;
                })(),
                // Concert Board and Custom Roles moved to Phase 4 (non-blocking) —
                // concertCheck and file I/O are non-critical for sidebar display
                // and should never block the loading spinner from dismissing.
                Promise.resolve({ messages: [], lastCheck: 0 }),
                Promise.resolve([]),
            ]),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Phase 2 sidebar gather timed out')), PHASE2_TIMEOUT_MS))
        ]).catch(() => {
            const elapsed = Date.now() - t0;
            console.warn('[Harmony] Sidebar Phase 2 timed out after ' + elapsed + 'ms — using fallback state');
            return [] as any[];
        });
        // Diagnostic: log Phase 2 gather duration for troubleshooting slow sidebar loads
        const phase2Elapsed = Date.now() - t0;
        if (phase2Elapsed > 3000) {
            console.warn('[Harmony] Sidebar Phase 2 gather took ' + phase2Elapsed + 'ms — investigate slow operations');
        }
        // Destructure with fallbacks if Phase 2 timed out or returned undefined
        const [
            recent = [], memorySummary = { activeEntries: 0, preservedFiles: 0 }, todos = [],
            providerStates = Object.fromEntries(providers.map(p => [p, false])) as Record<string, boolean>,
            providerSlotCounts = Object.fromEntries(providers.map(p => [p, 0])) as Record<string, number>,
            sessions = [], harmonyBytes = 0, resolvedCollab = safeDefault,
            whisperCount = 0, globalMemoryData = { totalPatterns: 0, uniqueWorkspaces: 0, topTags: [] as {tag: string; count: number}[] },
            hubStatus = { online: false },
            tencentKeySecret,
            concertData = { messages: [], lastCheck: 0 },
            customRoles = [],
        ] = raw;

        // ── Phase 3: Post full enriched state ──
        const fullState = {
            ...fastState,
            loading: false,
            contextHealth: { harmonyBytes, healthStatus: harmonyBytes > 20 * 1024 * 1024 ? 'critical' : harmonyBytes > 10 * 1024 * 1024 ? 'warning' : 'ok' },
            providerHealth: (() => {
                const mp = cfg.get<string>('modelProvider') ?? 'vscode-lm';
                if (mp === 'vscode-lm') return null;
                const provider = mp as ProviderId;
                const tier: Tier = 'light';
                const score = getScore(provider, tier);
                return { provider: providerDisplayName(provider), tier, score: score.score, label: getStatusLabel(provider, tier), attempts: score.totalAttempts };
            })(),
            agentsResolvedProvider: resolvedCollab ? providerDisplayName(resolvedCollab.provider) : '',
            agentsResolvedModel: resolvedCollab?.model || '',
            tencentKeySaved: !!tencentKeySecret,
            hasKey: providerStates.deepseek,
            primaryProviderKeys: providerStates,
            providers: providerStates,
            providerSlotCounts,
            memoryCount: memorySummary.activeEntries,
            memoryStats: memorySummary,
            memory: this.memoryHiddenFromPanel || compactSidebar ? [] : recent.map((e: any) => ({
                ts: e.ts.slice(0, 16).replace('T', ' '),
                preview: (e.prompt.split('\n')[0] ?? '').slice(0, 80)
            })),
            todos: todos.slice(0, 20).map((t: any) => ({ id: t.id, text: t.text, done: t.done })),
            sessions: sessions.slice(0, 10),
            hubStatus,
            whisperCount,
            concertBoard: concertData,
            customRoles,
            globalMemory: globalMemoryData,
            whisperDisabled: cfg.get<boolean>('whisper.disabled') ?? false,
        };
        if (this.view === view) {
            // Skip re-posting identical state to prevent webview flicker.
            // Compare a STABLE subset (excluding live counters, timestamps, and
            // transient byte counts) so that usage-tracking updates and
            // context-health fluctuations don't trigger full sidebar re-renders.
            let stableHash: string;
            let hashFailed = false;
            try {
                stableHash = stableHashForSidebarState(fullState);
            } catch (hashErr: any) {
                console.warn('[Harmony] Sidebar stable hash failed: ' + (hashErr?.message || hashErr) + ' — forcing full render');
                stableHash = '';
                hashFailed = true;
            }
            if (hashFailed || stableHash !== this.lastStateHash || stableHash !== this.lastPostedHash) {
                this.lastStateHash = stableHash;
                this.lastPostedHash = stableHash;
                this.lastSentState = fullState;
                view.webview.postMessage({ type: 'state', value: fullState });
            } else {
                // State unchanged — just dismiss the loading spinner from
                // the queued refresh's Phase 1 postMessage.
                view.webview.postMessage({ type: 'loadingState', value: false });
            }
            // Only send hub status when it actually changed (prevents mini-render on every refresh)
            let hubHash: string;
            try {
                hubHash = JSON.stringify(hubStatus);
            } catch {
                hubHash = '{}';
            }
            if (hubHash !== this.lastHubStatusHash) {
                this.lastHubStatusHash = hubHash;
                view.webview.postMessage({ type: 'hubStatus', value: hubStatus });
            }

            // ── Phase 4: Non-blocking concert board + custom roles ──
            // Throttled: concertCheck (file I/O + optional AI summary) only runs
            // every CONCERT_ENRICH_INTERVAL_MS to prevent DOM jitter from rapid
            // innerHTML replacements during LLM call bursts.
            const now = Date.now();
            if (now - this.lastConcertEnrichTime >= HarmonyViewProvider.CONCERT_ENRICH_INTERVAL_MS) {
                this.lastConcertEnrichTime = now;
                void (async () => {
                    let concertData: { messages: any[]; lastCheck: number } = { messages: [], lastCheck: 0 };
                    let customRoles: any[] = [];
                    try {
                        const check = await concertCheck(undefined, true);
                        concertData = { messages: check.messages.slice(-20), lastCheck: Date.now() };
                    } catch { /* concert hall unavailable */ }
                    try {
                        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        if (root) {
                            const sep = root.includes('\\') ? '\\' : '/';
                            const p = `${root}${sep}.harmony${sep}swarm${sep}custom-roles.json`;
                            const raw = await fsPromises.readFile(p, 'utf8');
                            customRoles = JSON.parse(raw);
                        }
                    } catch { /* no custom roles file */ }
                    if (this.view === view) {
                        let activeDels: any[] = [];
                        try { activeDels = await getActiveDeliberations(); } catch { /* deliberations unavailable */ }
                        view.webview.postMessage({
                            type: 'enrich',
                            value: { concertBoard: concertData, customRoles, activeDeliberations: activeDels.slice(0, 20) }
                        });
                    }
                })();
            }
        }
    }

    public dispose() {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
        for (const d of this.disposables) d.dispose();
    }

    private renderShell(webview: vscode.Webview): string {
        const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        const lm = LanguageManager.getInstance();
        const lang = lm.getCurrentLang();
        if (this.sidebarMode() === 'isolated') {
          return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; font-size: 12px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 7px 10px; border-radius: 2px; cursor: pointer; width: 100%; font-size: 12px; }
  button + button { margin-top: 6px; }
  button.subtle { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); text-align: left; }
  .status { opacity: 0.72; font-size: 11px; line-height: 1.4; margin: 8px 0; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 2px; }
</style>
</head>
<body>
  <button id="open-chat">${lm.getString('isolation.openChat')}</button>
  <div class="status">${lm.getString('isolation.title')}</div>
  <button class="subtle" id="disable-isolation">${lm.getString('isolation.switchCompact')}</button>
  <button class="subtle" id="write-oom-diagnostics">${lm.getString('steering.writeOomReport')}</button>
  <button class="subtle" id="restore-low-memory-safety">${lm.getString('steering.restoreSettings')}</button>
  <div class="status">${lm.getString('isolation.desc')}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('open-chat').addEventListener('click', () => vscode.postMessage({ type: 'openChat' }));
  document.getElementById('disable-isolation').addEventListener('click', () => vscode.postMessage({ type: 'disableSidebarIsolation' }));
  document.getElementById('write-oom-diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'writeOomDiagnostics' }));
  document.getElementById('restore-low-memory-safety').addEventListener('click', () => vscode.postMessage({ type: 'restoreLowMemorySafetySettings' }));
</script>
</body>
</html>`;
        }
        return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; font-size: 12px; }
  h3 { margin: 12px 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.75; font-weight: 600; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 10px; border-radius: 2px; cursor: pointer; width: 100%;
    font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.primary { padding: 8px 10px; font-weight: 600; }
  button.cta-chat, button.cta-compose {
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.12);
    padding: 9px 10px;
    font-weight: 650;
    line-height: 1.35;
    text-align: center;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08) inset;
  }
  button.cta-chat { background: #2f7d4a; }
  button.cta-chat:hover { background: #388a55; }
  button.cta-compose { background: #6c4ab6; }
  button.cta-compose:hover { background: #7856c4; }
  button.subtle {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    text-align: left; padding: 4px 6px; font-size: 11px; line-height: 1.3;
  }
  button.subtle:hover { background: var(--vscode-list-hoverBackground); }
  select {
    width: 100%; padding: 4px; background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border); border-radius: 2px;
    font-size: 12px;
  }
  /* Neon glow for provider/model selection — subtle but distinctive */
  #provider, #primary-model {
    box-shadow:
      0 0 6px rgba(0, 210, 255, 0.25),
      0 0 14px rgba(0, 210, 255, 0.10);
    border-color: rgba(0, 210, 255, 0.35);
    transition: box-shadow 0.4s ease, border-color 0.4s ease;
  }
  #provider:hover, #primary-model:hover,
  #provider:focus, #primary-model:focus {
    box-shadow:
      0 0 10px rgba(0, 210, 255, 0.45),
      0 0 22px rgba(0, 210, 255, 0.18);
    border-color: rgba(0, 210, 255, 0.55);
  }
  input[type="number"] {
    width: 100%; padding: 4px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 2px;
    font-size: 12px; box-sizing: border-box;
  }
  .inline-row { display: flex; gap: 4px; align-items: center; }
  .inline-row input { flex: 1; }
  .inline-row button { width: auto; white-space: nowrap; }
  label.row { display: flex; align-items: center; gap: 6px; padding: 4px 0; cursor: pointer; width: fit-content; }
  label.row input { margin: 0; }
  .stack > * + * { margin-top: 4px; }
  .memory-item { display: block; margin-bottom: 4px; }
  .memory-item .ts { opacity: 0.6; font-size: 10px; }
  .status { opacity: 0.6; font-size: 10px; line-height: 1.4; }
  .status code { background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 2px; }
  .pill {
    display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .empty { opacity: 0.5; font-style: italic; font-size: 11px; }
  .hint { opacity: 0.5; font-weight: normal; text-transform: none; letter-spacing: 0; }
  .disclaimer { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 10px; line-height: 1.3; margin-top: 0px; margin-bottom: 4px; margin-left: 22px; }
  .segmented-control { display: inline-flex; border: 1px solid var(--vscode-input-border); border-radius: 4px; overflow: hidden; }
  .seg-btn { padding: 2px 10px; font-size: 11px; border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; }
  .seg-btn + .seg-btn { border-left: 1px solid var(--vscode-input-border); }
  .seg-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .provider-row { display: flex; align-items: center; gap: 6px; }
  .provider-row .name { flex: 1; }
  .provider-row .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-red); }
  .provider-row .dot.on { background: var(--vscode-charts-green); }
  .fb-item { display: flex; align-items: center; gap: 4px; padding: 3px 4px; font-size: 11px; border-radius: 3px; }
  .fb-item:hover { background: var(--vscode-list-hoverBackground); }
  .fb-item .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-red); }
  .fb-item .dot.on { background: var(--vscode-charts-green); }
  .todo-item { display: flex; align-items: flex-start; gap: 4px; font-size: 11px; line-height: 1.3; }
  .todo-item.done { opacity: 0.5; text-decoration: line-through; }
  #sidebar-loading { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--vscode-sideBar-background); z-index: 100; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
  #sidebar-loading .spinner { width: 28px; height: 28px; border: 3px solid var(--vscode-input-border); border-top-color: var(--vscode-progressBar-background); border-radius: 50%; animation: hspin 0.7s linear infinite; }
  @keyframes hspin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div id="sidebar-loading"><div class="spinner"></div><span style="font-size:12px;opacity:0.8;">${lm.getString('sidebar.loading')}</span></div>
  <div style="margin-bottom:6px;">
    <div style="font-size:11px; margin-bottom:2px;">🌐 ${lm.getString('language.label')}</div>
    <div class="segmented-control" id="language-segmented">
      <button class="seg-btn" data-lang="en">${lm.getString('language.en')}</button>
      <button class="seg-btn" data-lang="zh">${lm.getString('language.zh')}</button>
    </div>
  </div>
  <button class="primary cta-chat" id="open-chat">\uD83D\uDCAC ${lm.getString('top.openChat')}</button>
  <button class="primary cta-compose" id="open-compose" style="margin-top:6px;">${lm.getString('top.compose')}</button>
  <div class="status" id="checkpoint-status" style="margin-top:6px;">${lm.getString('top.loadingCheckpoint')}</div>
  <button class="subtle" id="prepare-self-update" style="margin-top:6px;">${lm.getString('top.prepareSelfUpdate')}</button>
  <button class="subtle" id="create-seat-handoff" style="margin-top:6px;">${lm.getString('top.createSeatHandoff')}</button>
  <button class="subtle" id="create-resume-brief" style="margin-top:6px;">${lm.getString('top.createResumeBrief')}</button>

  <h3>🎯 ${lm.getString('token.title')}</h3>
  <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
    <input type="range" id="token-budget" min="4096" max="65536" step="4096" value="32768" style="flex:1;">
    <span id="token-budget-label" style="font-size:11px;white-space:nowrap;">32,768 tokens</span>
  </div>
  <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
    <button class="subtle token-preset" data-value="4096" style="font-size:10px;padding:2px 6px;">💬4K</button>
    <button class="subtle token-preset" data-value="8192" style="font-size:10px;padding:2px 6px;">📝8K</button>
    <button class="subtle token-preset" data-value="16384" style="font-size:10px;padding:2px 6px;">📄16K</button>
    <button class="subtle token-preset" data-value="32768" style="font-size:10px;padding:2px 6px;">📚32K</button>
    <button class="subtle token-preset" data-value="65536" style="font-size:10px;padding:2px 6px;">🚀65K</button>
  </div>
  <div class="hint" id="token-budget-hint" style="margin-top:2px;">${lm.getString('token.desc')}</div>

  <h3>${lm.getString('swarm.title')}</h3>
  <button class="subtle" id="open-swarm-launcher" style="margin-top:4px;">${lm.getString('swarm.openLauncher')}</button>
  <button class="subtle" id="open-swarm-direct" style="margin-top:4px;">${lm.getString('swarm.directControls')}</button>
  <button class="subtle" id="configure-swarm-defaults" style="margin-top:4px;">${lm.getString('swarm.configureDefaults')}</button>
  <div class="hint" id="swarm-default" style="margin-top:4px;">${lm.getString('swarm.defaultLoading')}</div>

  <h3>⚡ ${lm.getString('orchestrate.title')}</h3>
  <label class="row"><input type="checkbox" id="orchestrate-mode"> ${lm.getString('orchestrate.preApprove')} <span class="hint">${lm.getString('orchestrate.preApproveHint')}</span></label>
  <div class="disclaimer">⚠️ ${lm.getString('orchestrate.preApproveDisclaimer')}</div>
  <div class="hint" id="orchestrate-budget" style="margin-top:2px;">${lm.getString('orchestrate.confirmHint')}</div>
  <label class="row"><input type="checkbox" id="deep-orchestrate-mode"> 🏗️ ${lm.getString('orchestrate.deepTitle')}</label>
  <div class="hint" id="deep-orchestrate-status" style="margin-top:2px;">${lm.getString('orchestrate.deepDesc')}</div>
  <div class="hint" style="margin-top:4px;opacity:0.7;font-style:italic;">${lm.getString('orchestrate.costWarning')}</div>

  <h3>🎻 ${lm.getString('symphony.title')}</h3>
  <div id="symphony-profiles" class="stack" style="margin-bottom:4px;">
    <div class="empty">${lm.getString('symphony.noProfiles')}</div>
  </div>
  <button class="subtle" id="reload-profiles" style="margin-top:2px;">${lm.getString('symphony.reload')}</button>
  <button class="subtle" id="create-profile" style="margin-top:2px;">${lm.getString('symphony.newProfile')}</button>
  <div class="hint" style="margin-top:2px;">${lm.getString('symphony.invokeHint')}</div>

  <h3>🧠 ${lm.getString('deepswarm.title')}</h3>
  <div style="display:flex;gap:4px;margin-top:4px;">
    <select id="deepswarm-provider" style="flex:1;">
      <option value="auto">🤖 ${lm.getString('deepswarm.auto')}</option>
      <option value="deepseek">🐋 DeepSeek</option>
      <option value="gemini">💎 Gemini</option>
      <option value="alibaba">☁️ Qwen (Alibaba)</option>
      <option value="moonshot">🌙 Kimi (Moonshot)</option>
      <option value="kimiCode">🌙 KimiCode (direct)</option>
      <option value="tencent">🔷 Hunyuan (Tencent)</option>
    </select>
    <select id="deepswarm-tier" style="width:90px;">
      <option value="auto">Auto tier</option>
      <option value="light">Light</option>
      <option value="mid">Mid</option>
      <option value="heavy">Heavy</option>
      <option value="coding">Coding</option>
    </select>
  </div>
  <select id="deepswarm-strategy" style="width:100%;margin-top:4px;">
    <option value="cost-optimized">${lm.getString('deepswarm.costOptimized')}</option>
    <option value="balanced">${lm.getString('deepswarm.balanced')}</option>
    <option value="maximum-quality">${lm.getString('deepswarm.maxQuality')}</option>
  </select>
  <div class="hint" id="deepswarm-strategy-desc" style="margin-top:2px;"></div>
  <select id="deepswarm-mode" style="width:100%;margin-top:4px;">
    <option value="thorough">${lm.getString('deepswarm.thorough')}</option>
    <option value="scrutinize">${lm.getString('deepswarm.scrutinize')}</option>
    <option value="pioneer">${lm.getString('deepswarm.pioneer')}</option>
  </select>
  <div class="hint" id="deepswarm-desc" style="margin-top:2px;"></div>
  <button class="subtle" id="run-deepswarm" style="margin-top:4px;">${lm.getString('deepswarm.chooseRun')}</button>

  <h3>🎭 ${lm.getString('customRoles.title')}</h3>
  <div class="hint" style="margin-bottom:4px;">${lm.getString('customRoles.desc')}</div>
  <div id="custom-roles-list" class="stack"><div class="empty">${lm.getString('customRoles.none')}</div></div>
  <button class="btn" id="add-custom-role" style="margin-top:4px;">${lm.getString('customRoles.add')}</button>
  <button class="subtle" id="edit-custom-roles-json" style="margin-top:4px;">📝 ${lm.getString('customRoles.edit')}</button>
  <button class="subtle" id="refresh-custom-roles" style="margin-top:4px;">${lm.getString('customRoles.refresh')}</button>

  <h3>⚖️ ${lm.getString('deliberations.title')}</h3>
  <div id="active-deliberations" class="stack"><div class="empty">${lm.getString('deliberations.none')}</div></div>

  <h3>${lm.getString('profile.title')}</h3>
  <select id="profile">
    <option value="default">default</option>
    <option value="coder">coder</option>
    <option value="reviewer">reviewer</option>
  </select>

  <h3>${lm.getString('provider.title')}</h3>
  <select id="provider">
    <option value="vscode-lm">VS Code LM (Copilot)</option>
${PROVIDER_IDS.map(p => {
  const label = lang === 'zh' ? providerDisplayNameZh(p) : providerDisplayName(p);
  return `    <option value="${p}">${label} (direct)</option>`;
}).join('\n')}
  </select>
  <div id="direct-primary-block" class="hint" style="display:none; margin-top:4px;"></div>
  <button class="subtle" id="set-key" style="display:none; margin-top:4px;">${lm.getString('provider.setKey')}</button>
  <div id="primary-model-block" style="display:none; margin-top:4px;">
    <select id="primary-model"></select>
  </div>
  <div id="rewards-input-block" style="display:none; margin-top:4px;">
    <input type="text" id="rewards-endpoint-id" placeholder="ep-xxxxxxxx" style="width:65%; font-size:11px;" />
    <button class="subtle" id="rewards-save-btn" style="width:30%; font-size:11px;">${lm.getString('provider.save')}</button>
    <div class="hint" style="font-size:10px; margin-top:2px;">${lm.getString('provider.rewardsHint')}</div>
  </div>

  <h3>${lm.getString('steering.title')}</h3>
  <div class="status" id="steering-status" style="margin-bottom:6px;"></div>
  <div class="stack">
    <label class="row"><input type="checkbox" id="auto-approve"> ${lm.getString('steering.autoApprove')}</label>
    <div class="disclaimer">⚠️ ${lm.getString('steering.autoApproveDisclaimer')}</div>
    <label class="row"><input type="checkbox" id="plan-only"> ${lm.getString('steering.planOnly')}</label>
    <div style="margin-bottom:4px;">
      <div style="font-size:11px; margin-bottom:2px;">💥 ${lm.getString('steering.bigGuns')}</div>
      <div class="disclaimer">⚠️ ${lm.getString('steering.bigGunsWarning')}</div>
      <select id="big-guns-mode">
        <option value="off">${lm.getString('steering.bigGunsOff')}</option>
        <option value="deepseek-only">${lm.getString('steering.bigGunsDeepSeek')}</option>
        <option value="all">${lm.getString('steering.bigGunsAll')}</option>
      </select>
    </div>
    <label class="row"><input type="checkbox" id="flow-state"> 🧠 ${lm.getString('steering.flowState')}</label>
    <div class="disclaimer">⚠️ ${lm.getString('steering.flowStateDisclaimer')}</div>
    <label class="row"><input type="checkbox" id="planner-enforced"> ${lm.getString('steering.plannerEnforced')}</label>
    <label class="row"><input type="checkbox" id="checkpoint"> ${lm.getString('steering.checkpoint')}</label>
    <div class="disclaimer">⚠️ ${lm.getString('steering.checkpointDisclaimer')}</div>
    <div style="margin-bottom:4px;">
      <div style="font-size:11px; margin-bottom:2px;">🧠 ${lm.getString('steering.contextPersistence')}</div>
      <label class="row"><input type="checkbox" id="pre-action-checklist"> ${lm.getString('steering.preActionChecklist')} <span class="hint">${lm.getString('steering.preActionChecklistHint')}</span></label>
      <label class="row"><input type="checkbox" id="swarm-verifier"> ${lm.getString('steering.swarmVerifier')} <span class="hint">${lm.getString('steering.swarmVerifierHint')}</span></label>
      <label class="row"><input type="checkbox" id="swarm-provider-fanout"> ${lm.getString('steering.swarmFanout')} <span class="hint">${lm.getString('steering.swarmFanoutHint')}</span></label>
      <label class="row"><input type="checkbox" id="triple-check-auto"> ${lm.getString('steering.tripleCheck')} <span class="hint">${lm.getString('steering.tripleCheckHint')}</span></label>
      <label class="row">${lm.getString('steering.batchSize')} <input type="number" id="active-batch-size" min="1" max="50" step="1" style="width:50px;"> <span class="hint">${lm.getString('steering.batchSizeHint')}</span></label>
    </div>
    <label class="row"><input type="checkbox" id="tool-routing-guard"> ${lm.getString('steering.toolGuard')} <span class="hint">${lm.getString('steering.toolGuardHint')}</span></label>
    <label class="row"><input type="checkbox" id="auto-retry"> ${lm.getString('steering.autoRetry')} <span class="hint">${lm.getString('steering.autoRetryHint')}</span></label>
    <label class="row"><input type="checkbox" id="diagnostics"> ${lm.getString('steering.diagnostics')}</label>
    <label class="row"><input type="checkbox" id="deepseek-trace"> ${lm.getString('steering.deepseekTrace')}</label>
    <label class="row"><input type="checkbox" id="deepseek-thinking"> 🧠 ${lm.getString('steering.deepseekThinking')} <span class="hint">${lm.getString('steering.deepseekThinkingHint')}</span></label>
    <label class="row"><input type="checkbox" id="sidebar-compact"> ${lm.getString('steering.lowMemory')}</label>
    <label class="row"><input type="checkbox" id="error-learning"> 🌸 ${lm.getString('steering.errorLearning')} <span class="hint">${lm.getString('steering.errorLearningHint')}</span></label>
    <div class="disclaimer" id="error-learning-warning" style="display:none;">⚠️ ${lm.getString('steering.errorLearningWarning')}</div>
    <button class="subtle" id="configure-sidebar-mode">${lm.getString('steering.sidebarDisplay')}</button>
    <button class="subtle" id="write-oom-diagnostics">${lm.getString('steering.writeOomReport')}</button>
    <button class="subtle" id="enable-low-memory-safety">${lm.getString('steering.enableLowMemory')}</button>
    <button class="subtle" id="restore-low-memory-safety">${lm.getString('steering.restoreSettings')}</button>
  </div>

  <h3>${lm.getString('agentSteps.title')}</h3>
  <div class="inline-row">
    <input type="number" id="agent-steps" min="-1" max="5000" step="1" title="${lm.getString('agentSteps.titleAttr')}">
    <button class="subtle" id="agent-steps-1">1</button>
    <button class="subtle" id="agent-steps-11">11</button>
    <button class="subtle" id="agent-steps-1111">1111</button>
    <button class="subtle" id="agent-steps-unlimited">${lm.getString('agentSteps.unlimited')}</button>
  </div>
  <div class="hint" style="margin-top:4px;">${lm.getString('agentSteps.desc')}</div>

  <h3>${lm.getString('consult.title')} <span class="hint">${lm.getString('consult.titleHint')}</span></h3>
  <div class="status" id="routing-summary" style="margin-bottom:6px;"></div>
  <div id="providers" class="stack"></div>
  <button class="subtle" id="show-provider-status" style="margin-top:4px;">${lm.getString('consult.showStatus')}</button>
  <button class="subtle" id="configure-provider-endpoints" style="margin-top:4px;">${lm.getString('consult.configureEndpoints')}</button>
  <button class="subtle" id="import-provider-env" style="margin-top:4px;">${lm.getString('consult.importKeys')}</button>
  <label class="row" style="margin-top:6px;"><input type="checkbox" id="self-heal-env"> ${lm.getString('consult.selfHealEnv')} <span class="hint">${lm.getString('consult.selfHealEnvHint')}</span></label>
  <button class="subtle" id="discover-models" style="margin-top:4px;">${lm.getString('consult.discoverModels')}</button>
  <button class="subtle" id="model-discovery-guide" style="margin-top:4px;">${lm.getString('consult.updateGuide')}</button>

  <h3>${lm.getString('visual.title')}</h3>
  <div style="margin-bottom:8px;">
    <div style="font-size:11px; margin-bottom:2px;">${lm.getString('visual.visionModel')}</div>
    <select id="vision-model">
      <option value="auto">${lm.getString('visual.autoFallback')}</option>
      <option value="gemini">🔮 Gemini only</option>
      <option value="zhipu">🧠 Zhipu / GLM only</option>
      <option value="alibaba">☁️ Alibaba / Qwen only</option>
      <optgroup label="Gemini">
        <option value="gemini-3.8-flash">gemini-3.8-flash (default, newest Flash)</option>
        <option value="gemini-3.7-flash">gemini-3.7-flash</option>
        <option value="gemini-3.6-flash">gemini-3.6-flash</option>
        <option value="gemini-3.5-flash">gemini-3.5-flash</option>
        <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (cheapest Flash-Lite)</option>
        <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (heavy, detailed)</option>
      </optgroup>
      <optgroup label="Zhipu / GLM">
        <option value="glm-5v-turbo">glm-5v-turbo (fast, capable)</option>
        <option value="glm-5v">glm-5v (standard)</option>
      </optgroup>
      <optgroup label="Alibaba / Qwen-VL">
        <option value="qwen3.8-max">qwen3.8-max (best, multimodal)</option>
        <option value="qwen3.7-plus">qwen3.7-plus (faster, cheaper)</option>
        <option value="qwen-vl-max">qwen-vl-max (legacy)</option>
        <option value="qwen-vl-plus">qwen-vl-plus (legacy)</option>
      </optgroup>
    </select>
    <div id="vision-fallback-order" style="display:none; margin-top:6px;">
      <div style="font-size:10px; margin-bottom:3px;">${lm.getString('visual.fallbackOrder')}</div>
      <div id="fallback-list"></div>
      <button class="subtle" id="reset-fallback-order" style="margin-top:4px; font-size:10px;">${lm.getString('visual.resetFallback')}</button>
    </div>
    <div id="auto-vision-models" style="display:none; margin-top:4px; margin-left:8px;">
      <div style="font-size:10px; margin-bottom:2px;">${lm.getString('visual.autoGeminiModel')}</div>
      <select id="auto-gemini-model">
        <option value="gemini-3.8-flash">gemini-3.8-flash</option>
        <option value="gemini-3.7-flash">gemini-3.7-flash</option>
        <option value="gemini-3.6-flash">gemini-3.6-flash</option>
        <option value="gemini-3.5-flash">gemini-3.5-flash</option>
        <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
        <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
      </select>
      <div style="font-size:10px; margin-bottom:2px; margin-top:4px;">${lm.getString('visual.autoQwenModel')}</div>
      <select id="auto-qwen-model">
        <option value="qwen3.8-max">qwen3.8-max</option>
        <option value="qwen3.7-plus">qwen3.7-plus</option>
        <option value="qwen-vl-max">qwen-vl-max</option>
        <option value="qwen-vl-plus">qwen-vl-plus</option>
      </select>
    </div>
  </div>
  <div style="margin-bottom:8px;">
    <div style="font-size:11px; margin-bottom:2px;">${lm.getString('visual.imgGenProvider')}</div>
    <select id="image-gen-provider">
      <option value="gemini">${lm.getString('visual.geminiGen')}</option>
      <option value="openai">${lm.getString('visual.openaiGen')}</option>
      <option value="alibaba">${lm.getString('visual.alibabaGen')}</option>
    </select>
  </div>
  <label class="row"><input type="checkbox" id="image-gen-auto"> ${lm.getString('visual.autoAllowPaid')}</label>
  <label class="row"><input type="checkbox" id="ocr-only"> ${lm.getString('visual.ocrOnly')}</label>
  <label class="row"><input type="checkbox" id="skip-ocr"> ${lm.getString('visual.skipOcr')}</label>
  <label class="row"><input type="checkbox" id="local-first"> ${lm.getString('visual.localAnalysis')}</label>
  <div class="hint">${lm.getString('visual.freeTip')}</div>
  <div class="hint">${lm.getString('visual.skipOcrTip')}</div>
  <div class="hint">${lm.getString('visual.availableHint')}</div>

  <h3>${lm.getString('plan.title')}</h3>
  <div id="todos" class="stack"><div class="empty">${lm.getString('plan.none')}</div></div>

  <h3>${lm.getString('usage.title')}</h3>
  <div id="usage"></div>

  <h3>${lm.getString('contextHealth.title')}</h3>
  <div id="context-health"><div class="empty">${lm.getString('contextHealth.loading')}</div></div>
  <button class="subtle" id="run-cleanup" style="margin-top:4px;">${lm.getString('contextHealth.runCleanup')}</button>

  <h3>${lm.getString('sessions.title')}</h3>
  <div id="sessions" class="stack"><div class="empty">${lm.getString('sessions.none')}</div></div>
  <button class="subtle" id="manage-sessions" style="margin-top:4px;">${lm.getString('sessions.manage')}</button>

  <h3>${lm.getString('whisper.title')}</h3>
  <label class="row" style="margin-bottom:6px;"><input type="checkbox" id="whisper-disabled"> ${lm.getString('whisper.disable')} <span class="hint">${lm.getString('whisper.disableHint')}</span></label>
  <div id="whisper-inbox" class="stack"><div class="empty">${lm.getString('whisper.noPending')}</div></div>
  <textarea id="whisper-input" placeholder="${lm.getString('whisper.placeholder')}" rows="2" style="width:100%;margin-top:4px;padding:6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit;resize:vertical;box-sizing:border-box;" maxlength="8000"></textarea>
  <button class="btn" id="send-whisper" style="margin-top:4px;width:100%;">${lm.getString('whisper.send')}</button>
  <button class="subtle" id="check-whispers" style="margin-top:4px;">${lm.getString('whisper.check')}</button>

  <h3>${lm.getString('concert.title')} <span id="concert-board-badge" style="font-weight:normal;font-size:10px;"></span></h3>
  <div class="hint" style="margin-bottom:4px;">${lm.getString('concert.hint')}</div>
  <div id="concert-board" class="stack"><div class="empty">${lm.getString('concert.quiet')}</div></div>
  <button class="subtle" id="refresh-concert-board" style="margin-top:4px;">${lm.getString('concert.refresh')}</button>

  <h3>${lm.getString('globalMemory.title')} <span id="global-memory-badge" style="font-weight:normal;font-size:10px;"></span></h3>
  <div id="global-memory" class="stack"><div class="empty">${lm.getString('globalMemory.noPatterns')}</div></div>

  <h3>${lm.getString('repair.title')}</h3>
  <button class="subtle" id="restore-engine" style="margin-top:4px;">${lm.getString('repair.restore')}</button>

  <h3>${lm.getString('hub.fullTitle')}</h3>
  <div id="hub-status" style="margin-bottom:6px;font-size:11px;"></div>
  <div id="hub-roots" class="stack"><div class="empty">${lm.getString('hub.noFolders')}</div></div>
  <button class="btn" id="allow-hub-folder" style="margin-top:6px;">${lm.getString('hub.addFolder')}</button>
  <button class="subtle" id="index-workspace" style="margin-top:4px;">${lm.getString('hub.reindex')}</button>
  <button class="subtle" id="start-hub" style="margin-top:4px;">${lm.getString('hub.start')}</button>
  <button class="subtle" id="stop-hub" style="margin-top:4px;">${lm.getString('hub.stop')}</button>
  <button class="subtle" id="toggle-hub-autostart" style="margin-top:4px;">Hub auto-restart: ON</button>
  <button class="subtle" id="manage-hub-roots" style="margin-top:4px;">${lm.getString('hub.manageFolders')}</button>

  <h3>${lm.getString('workspaceMemory.title')}</h3>
  <div id="memory-meta" class="hint" style="margin-bottom:4px;">${lm.getString('memory.meta')}</div>
  <div id="memory" class="stack"><div class="empty">${lm.getString('memory.none')}</div></div>
  <button class="subtle" id="toggle-memory-panel" style="margin-top:4px;">${lm.getString('memory.hide')}</button>

  <h3>${lm.getString('status.title')} <span id="status-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#666;vertical-align:middle;margin-left:6px;" title="Script OK"></span></h3>
  <div class="status" id="status"></div>

<script nonce="${nonce}">
  const diagEl = document.getElementById('status-dot');
  // 🔴 NUCLEAR TEST: if script runs, dot turns YELLOW
  if (diagEl) { diagEl.style.background = '#ffcc00'; diagEl.title = 'NUCLEAR: script started'; }
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    if (!s && s !== 0) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const vscode = acquireVsCodeApi();
  const PRIMARY_MODEL_OPTIONS = ${JSON.stringify(PRIMARY_MODEL_OPTIONS)};
  const LOC = ${JSON.stringify({
    concert_quiet: lm.getString('concert.quiet'),
    concert_messages: lm.getString('concert.messages'),
    custom_roles_none: lm.getString('customRoles.none'),
    custom_roles_unnamed: lm.getString('customRoles.unnamed'),
    plan_none: lm.getString('plan.none'),
    loading: lm.getString('contextHealth.loading'),
    sessions_hidden_compact: lm.getString('sessions.hiddenCompact'),
    sessions_none: lm.getString('sessions.none'),
    deliberations_none: lm.getString('deliberations.none'),
    memory_none: lm.getString('memory.none'),
    memory_hidden: lm.getString('memory.hidden'),
    memory_hidden_compact: lm.getString('memory.hiddenCompact'),
    memory_show: lm.getString('memory.show'),
    memory_hide: lm.getString('memory.hide'),
    hub_no_folders: lm.getString('hub.noFolders'),
    hub_hidden_compact: lm.getString('hub.hiddenCompact'),
    hub_more_folders: lm.getString('hub.moreFolders'),
    hub_online: lm.getString('hub.online'),
    hub_offline: lm.getString('hub.offline'),
    hub_paused: lm.getString('hub.paused'),
    hub_click_start: lm.getString('hub.clickStart'),
    hub_on_demand_paused: lm.getString('hub.onDemandPaused'),
    hub_auto_start_on: lm.getString('hub.autoStartOn'),
    hub_auto_start_off: lm.getString('hub.autoStartOff'),
    hub_indexed: lm.getString('hub.indexed'),
    hub_model: lm.getString('hub.model'),
    hub_vectors: lm.getString('hub.vectors'),
    hub_message_start: lm.getString('hub.messageStart'),
    model_fallback: lm.getString('model.fallback'),
    provider_set_key_short: lm.getString('provider.setKey.short'),
    provider_replace_key: lm.getString('provider.replaceKey'),
    provider_secret_storage: lm.getString('provider.secretStorage'),
    sidebar_display: lm.getString('steering.sidebarDisplay'),
    switch_to_full: lm.getString('steering.switchToFull'),
    switch_to_compact: lm.getString('steering.switchToCompact'),
    flow_state: lm.getString('steering.flowState'),
    planner_enforced: lm.getString('steering.plannerEnforced'),
    checkpoint: lm.getString('steering.checkpoint'),
    on_label: lm.getCurrentLang() === 'zh' ? '开' : 'on',
    off_label: lm.getCurrentLang() === 'zh' ? '关' : 'off',
    // Expanded dynamic strings
    usage_no_calls: lm.getString('usage.noCalls'),
    usage_total: lm.getString('usage.total'),
    usage_reset: lm.getString('usage.reset'),
    orchestrate_unlimited: lm.getString('orchestrate.unlimited'),
    orchestrate_call_count: lm.getString('orchestrate.callCount'),
    context_health_no_folder: lm.getString('contextHealth.noFolder'),
    context_health_context: lm.getString('contextHealth.context'),
    context_health_large: lm.getString('contextHealth.large'),
    context_health_growing: lm.getString('contextHealth.growing'),
    global_memory_no_patterns: lm.getString('globalMemory.noPatterns'),
    global_memory_patterns: lm.getString('globalMemory.patterns'),
    global_memory_workspaces: lm.getString('globalMemory.workspaces'),
    whisper_no_pending: lm.getString('whisper.noPending'),
    whisper_unread: lm.getString('whisper.unread'),
    whisper_send: lm.getString('whisper.send'),
    symphony_no_profiles: lm.getString('symphony.noProfiles'),
    cost_low: lm.getString('cost.low'),
    cost_medium: lm.getString('cost.medium'),
    cost_significant: lm.getString('cost.significant'),
    cost_unknown: lm.getString('cost.unknown'),
    accounting_title: lm.getString('accounting.title'),
    accounting_policy: lm.getString('accounting.policy'),
    accounting_ledger: lm.getString('accounting.ledger'),
    accounting_direct_calls: lm.getString('accounting.directCalls'),
    accounting_allowed: lm.getString('accounting.allowed'),
    accounting_denied: lm.getString('accounting.denied'),
    accounting_model_filters: lm.getString('accounting.modelFilters'),
    accounting_deny_filters: lm.getString('accounting.denyFilters'),
    accounting_session_quotas: lm.getString('accounting.sessionQuotas'),
    accounting_calls: lm.getString('accounting.calls'),
    accounting_cost: lm.getString('accounting.cost'),
    accounting_any_provider: lm.getString('accounting.anyProvider'),
    accounting_none: lm.getString('accounting.none'),
    accounting_partly_unknown: lm.getString('accounting.partlyUnknown'),
    routing_primary_route: lm.getString('routing.primaryRoute'),
    routing_agents_route: lm.getString('routing.agentsRoute'),
    routing_swarm_default: lm.getString('routing.swarmDefault'),
    routing_primary_endpoint: lm.getString('routing.primaryEndpoint'),
    routing_key_stores: lm.getString('routing.keyStores'),
    routing_key_stores_detail: lm.getString('routing.keyStoresDetail'),
    swarm_config_default: lm.getString('swarm.configDefault'),
    swarm_config_model: lm.getString('swarm.configModel'),
    swarm_config_mode: lm.getString('swarm.configMode'),
    swarm_config_loop: lm.getString('swarm.configLoop'),
    swarm_config_loop_val: lm.getString('swarm.configLoopVal'),
    swarm_config_global_plan_only: lm.getString('swarm.configGlobalPlanOnly'),
    swarm_config_risky_switches: lm.getString('swarm.configRiskySwitches'),
    swarm_config_all_off: lm.getString('swarm.configAllOff'),
    swarm_config_enabled: lm.getString('swarm.configEnabled'),
    steering_summary_title: lm.getString('steering.summaryTitle'),
    steering_plan_only_label: lm.getString('steering.planOnlyLabel'),
    steering_planner_enforced_label: lm.getString('steering.plannerEnforcedLabel'),
    steering_checkpoint_label: lm.getString('steering.checkpointLabel'),
    steering_tool_routing_guard_label: lm.getString('steering.toolRoutingGuardLabel'),
    steering_auto_retry_label: lm.getString('steering.autoRetryLabel'),
    steering_auto_approve_label: lm.getString('steering.autoApproveLabel'),
    sidebar_checkpoint: lm.getString('sidebar.checkpoint'),
    sidebar_compose: lm.getString('sidebar.compose'),
    sidebar_compose_hint: lm.getString('sidebar.composeHint'),
    sidebar_workspace: lm.getString('sidebar.workspace'),
    sidebar_backend: lm.getString('sidebar.backend'),
    sidebar_key: lm.getString('sidebar.key'),
    sidebar_key_set: lm.getString('sidebar.keySet'),
    sidebar_key_none: lm.getString('sidebar.keyNone'),
    orchestrate_confirm_hint: lm.getString('orchestrate.confirmHint'),
    deepswarm_relative_cost: lm.getString('deepswarm.relativeCost'),
    deepswarm_strategy: lm.getString('deepswarm.strategy'),
    token_unit: lm.getString('token.unit'),
    memory_meta: lm.getString('memory.meta'),
    provider_primary_model: lm.getString('provider.primaryModel'),
    provider_key_set_in_vscode: lm.getString('provider.keySetInVscode'),
    provider_key_none_in_vscode: lm.getString('provider.keyNoneInVscode'),
    provider_endpoint_label: lm.getString('provider.endpointLabel'),
    provider_endpoint_switch: lm.getString('provider.endpointSwitch'),
    provider_base_label: lm.getString('provider.baseLabel'),
    provider_secret_label: lm.getString('provider.secretLabel'),
    provider_import_hint: lm.getString('provider.importHint'),
    provider_na: lm.getString('provider.na'),
    provider_needs_base_url: lm.getString('provider.needsBaseUrl'),
    status_provider_label: lm.getString('status.providerLabel'),
    status_model_label: lm.getString('status.modelLabel'),
    routing_no_key_resolved: lm.getString('routing.noKeyResolved'),
    routing_enabled: lm.getString('routing.enabled'),
    routing_disabled: lm.getString('routing.disabled'),
    memory_active_entries: lm.getString('memory.activeEntries'),
    memory_preserved_files_label: lm.getString('memory.preservedFilesLabel'),
  })};
  try {
  function renderProviderAccounting(a) {
    if (!a) return '';
    const allowed = Array.isArray(a.allowedProviders) && a.allowedProviders.length ? a.allowedProviders.join(', ') : LOC.accounting_any_provider;
    const denied = Array.isArray(a.deniedProviders) && a.deniedProviders.length ? a.deniedProviders.join(', ') : LOC.accounting_none;
    const allowedModels = a.allowedModelsByProvider && Object.keys(a.allowedModelsByProvider).length ? Object.keys(a.allowedModelsByProvider).join(', ') : LOC.accounting_none;
    const deniedModels = a.deniedModelsByProvider && Object.keys(a.deniedModelsByProvider).length ? Object.keys(a.deniedModelsByProvider).join(', ') : LOC.accounting_none;
    const callLimit = a.maxSessionCalls > 0 ? String(a.maxSessionCalls) : LOC.off_label;
    const costLimit = a.maxSessionEstimatedCostUsd > 0 ? costLabel(a.maxSessionEstimatedCostUsd) : LOC.off_label;
    return '<div style="margin-top:8px;border-top:1px solid var(--vscode-panel-border);padding-top:6px;font-size:10px;line-height:1.45;opacity:0.78;">' +
      '<div style="font-weight:600;opacity:0.9;">' + LOC.accounting_title + '</div>' +
      '<div>' + LOC.accounting_policy + ' ' + (a.enabled ? LOC.on_label : LOC.off_label) + ' · ' + LOC.accounting_ledger + ' ' + (a.accountingEnabled ? LOC.on_label : LOC.off_label) + '</div>' +
      '<div>' + LOC.accounting_direct_calls + ' ' + a.directCalls + ' · est: ' + (a.directEstimatedCostKnown ? costLabel(a.directEstimatedCostDollars) : LOC.accounting_partly_unknown) + '</div>' +
      '<div>' + LOC.accounting_allowed + ' ' + escapeHtml(allowed) + '</div>' +
      '<div>' + LOC.accounting_denied + ' ' + escapeHtml(denied) + '</div>' +
      '<div>' + LOC.accounting_model_filters + ' ' + escapeHtml(allowedModels) + ' · ' + LOC.accounting_deny_filters + ' ' + escapeHtml(deniedModels) + '</div>' +
      '<div>' + LOC.accounting_session_quotas + ' ' + LOC.accounting_calls + ' ' + escapeHtml(callLimit) + ' · ' + LOC.accounting_cost + ' ' + escapeHtml(costLimit) + '</div>' +
      (a.accountingEnabled && a.ledgerPath ? '<div>' + LOC.accounting_ledger + ' <code>' + escapeHtml(a.ledgerPath) + '</code></div>' : '') +
      '</div>';
  }

  function costLabel(amount) {
    if (amount === undefined || amount === null) return LOC.cost_unknown;
    if (amount < 0.05) return LOC.cost_low;
    if (amount < 0.20) return LOC.cost_medium;
    return LOC.cost_significant;
  }

  function formatLatency(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1000) return Math.round(n) + 'ms';
    return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  }

  function render(s) {
    // Loading indicator — show/hide based on state.loading flag
    const loadingEl = $('sidebar-loading');
    if (loadingEl) {
      loadingEl.style.display = s.loading ? 'flex' : 'none';
    }
    window.__harmonyMemoryHidden = !!s.memoryHidden;
    // Token Budget: set slider + label from state (overrides HTML defaults)
    var tbSlider = $('token-budget');
    var tbLabel = $('token-budget-label');
    if (tbSlider && tbLabel && s.tokenBudget) {
      tbSlider.value = s.tokenBudget;
      tbLabel.textContent = Number(s.tokenBudget).toLocaleString() + ' ' + LOC.token_unit;
    }
    // Token Budget event handlers (slider + presets)
    if (tbSlider && tbLabel) {
      tbSlider.addEventListener('input', function() {
        tbLabel.textContent = Number(this.value).toLocaleString() + ' ' + LOC.token_unit;
      });
      tbSlider.addEventListener('change', function() {
        vscode.postMessage({ type: 'setTokenBudget', value: this.value });
      });
      var presets = document.querySelectorAll('.token-preset');
      for (var i = 0; i < presets.length; i++) {
        presets[i].addEventListener('click', function() {
          var val = this.getAttribute('data-value');
          tbSlider.value = val;
          tbLabel.textContent = Number(val).toLocaleString() + ' ' + LOC.token_unit;
          vscode.postMessage({ type: 'setTokenBudget', value: val });
        });
      }
    }
    // ── Belt-and-suspenders: dynamically inject DeepSwarm provider/tier dropdowns if missing ──
    (function ensureDeepSwarmDropdowns() {
      const h3 = document.querySelector('h3');
      let deepswarmHeader = null;
      for (const h of document.querySelectorAll('h3')) {
        if (h.textContent && h.textContent.includes('DeepSwarm')) { deepswarmHeader = h; break; }
      }
      if (!deepswarmHeader) return;
      if (!document.getElementById('deepswarm-provider')) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;margin-top:4px;';
        const dsProviders = ${JSON.stringify(PROVIDER_IDS.map(p => ({ id: p, label: providerDisplayName(p) })))};
        const dsProviderOpts = '<option value="auto">\uD83E\uDD16 Auto (strategy picks)</option>' + dsProviders.map(p => '<option value="' + p.id + '">' + p.label + '</option>').join('');
        row.innerHTML = '<select id="deepswarm-provider" style="flex:1;">' + dsProviderOpts + '</select><select id="deepswarm-tier" style="width:90px;"><option value="auto">Auto tier</option><option value="light">Light</option><option value="mid">Mid</option><option value="heavy">Heavy</option><option value="coding">Coding</option></select>';
        deepswarmHeader.insertAdjacentElement('afterend', row);
        // Wire event listeners
        document.getElementById('deepswarm-provider').addEventListener('change', function(e) { vscode.postMessage({ type: 'selectDeepSwarmProvider', value: e.target.value }); });
        document.getElementById('deepswarm-tier').addEventListener('change', function(e) { vscode.postMessage({ type: 'selectDeepSwarmTier', value: e.target.value }); });
        // Update the run button to include provider/tier values
        const runBtn = document.getElementById('run-deepswarm');
        if (runBtn) {
          const origClick = runBtn.onclick;
          runBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'runDeepSwarm', pipelineId: '', mode: $('deepswarm-mode').value, strategy: $('deepswarm-strategy').value, provider: $('deepswarm-provider').value, tier: $('deepswarm-tier').value });
          });
        }
      }
      if (!document.getElementById('deepswarm-tier')) {
        const provSel = document.getElementById('deepswarm-provider');
        if (provSel && provSel.parentElement) {
          const tierSel = document.createElement('select');
          tierSel.id = 'deepswarm-tier';
          tierSel.style.cssText = 'width:90px;';
          tierSel.innerHTML = '<option value="auto">Auto tier</option><option value="light">Light</option><option value="mid">Mid</option><option value="heavy">Heavy</option><option value="coding">Coding</option>';
          provSel.parentElement.appendChild(tierSel);
          tierSel.addEventListener('change', function(e) { vscode.postMessage({ type: 'selectDeepSwarmTier', value: e.target.value }); });
        }
      }
    })();
    // ── End dynamic injection ──
    $('profile').value = s.profile;
    $('provider').value = s.provider;
    const PROVIDER_IDS = ${JSON.stringify(PROVIDER_IDS)};
    const primaryDirect = PROVIDER_IDS.includes(s.provider);
    const primaryModel = s.primaryModels ? (s.primaryModels[s.provider] || '') : (s.provider === 'deepseek' ? s.deepseekModel : '');
    const primaryKeySaved = !!(s.primaryProviderKeys && s.primaryProviderKeys[s.provider]);
    const primarySecretKey = s.providerSecretKeys && s.providerSecretKeys[s.provider] ? s.providerSecretKeys[s.provider] : '';
    const primaryEndpoint = s.providerEndpoints && s.providerEndpoints[s.provider] ? s.providerEndpoints[s.provider] : null;
    // Populate primary model dropdown dynamically
    const primaryModelSel = $('primary-model');
    const primaryModelBlock = $('primary-model-block');
    const rewardsBlock = $('rewards-input-block');
    const isRewards = (s.provider === 'doubao-rewards');
    const modelOptions = PRIMARY_MODEL_OPTIONS[s.provider];
    if (modelOptions && primaryDirect && !isRewards) {
      const isZh = (s.language === 'zh');
      primaryModelSel.innerHTML = modelOptions.map(m => '<option value="' + m.value + '">' + escapeHtml(isZh && m.labelZh ? m.labelZh : m.label) + '</option>').join('');
      primaryModelSel.value = primaryModel;
      primaryModelBlock.style.display = 'block';
    } else {
      primaryModelBlock.style.display = 'none';
    }
    rewardsBlock.style.display = (isRewards && primaryDirect) ? 'block' : 'none';
    if (isRewards) {
      $('rewards-endpoint-id').value = primaryModel && primaryModel !== 'ep-rewards-placeholder' ? primaryModel : '';
    }
    $('direct-primary-block').style.display = primaryDirect ? 'block' : 'none';
    const endpointSwitchable = ['alibaba', 'tencent', 'stepfun', 'doubao', 'doubao-coding', 'byteplus', 'byteplus-coding'].includes(s.provider);
    const endpointLabelHtml = primaryEndpoint
      ? '<br>' + LOC.provider_endpoint_label + ' ' + (endpointSwitchable
          ? '<a href="#" id="switch-endpoint-link" style="cursor:pointer;"><code>' + escapeHtml(primaryEndpoint.label) + '</code> → ' + LOC.provider_endpoint_switch + '</a>'
          : '<code>' + escapeHtml(primaryEndpoint.label) + '</code>')
        + (primaryEndpoint.baseUrl ? '<br>' + LOC.provider_base_label + ' <code>' + escapeHtml(primaryEndpoint.baseUrl) + '</code>' : (!endpointSwitchable ? '<br><em>' + escapeHtml(primaryEndpoint.detail) + '</em>' : ''))
      : '';
    $('direct-primary-block').innerHTML = primaryDirect
      ? LOC.provider_primary_model + ' <code>' + escapeHtml(primaryModel) + '</code><br>' +
        LOC.sidebar_key + ' ' + (primaryKeySaved ? LOC.provider_key_set_in_vscode : '<em>' + LOC.provider_key_none_in_vscode + '</em>') +
        endpointLabelHtml +
        (primarySecretKey ? '<br>' + LOC.provider_secret_label + ' <code>' + escapeHtml(primarySecretKey) + '</code>' : '') +
        (!primaryKeySaved && s.provider !== 'vscode-lm' ? '<br>' + LOC.provider_import_hint : '')
      : '';
    // Wire up endpoint switch link if present
    const switchLink = document.getElementById('switch-endpoint-link');
    if (switchLink) {
      switchLink.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'configureProviderEndpoints' });
      });
    }
    $('set-key').style.display = primaryDirect ? 'block' : 'none';
    $('agent-steps').value = String(s.agentMaxSteps ?? 1);
    $('auto-approve').checked = !!s.autoApprove;
    $('plan-only').checked = !!s.planOnly;
    $('big-guns-mode').value = s.bigGunsMode || 'off';
    $('planner-enforced').checked = !!s.plannerEnforced;
    $('checkpoint').checked = !!s.checkpoint;
    $('orchestrate-mode').checked = !!s.orchestrateMode;
    $('orchestrate-budget').textContent = s.orchestrateBudget || LOC.orchestrate_confirm_hint;
    $('deep-orchestrate-mode').checked = !!s.deepOrchestrateMode;
    $('pre-action-checklist').checked = s.preActionChecklist ?? true;
    $('swarm-verifier').checked = s.swarmVerifier ?? false;
    $('swarm-provider-fanout').checked = s.swarmProviderFanout ?? false;
    $('active-batch-size').value = String(s.activeBatchSize ?? 5);
    $('tool-routing-guard').checked = s.toolRoutingGuard ?? true;
    $('auto-retry').checked = s.autoRetry ?? true;
    $('diagnostics').checked = !!s.showDiagnostics;
$('triple-check-auto').checked = !!s.tripleCheckAuto;
    $('deepseek-trace').checked = !!s.showDeepSeekTrace;
    $('deepseek-thinking').checked = s.deepseekThinking ?? true;
    $('sidebar-compact').checked = s.sidebarMode === 'compact';
    // Initialize language segmented control
    document.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === (s.language || 'en'));
    });
    $('configure-sidebar-mode').textContent = s.sidebarMode === 'compact' ? LOC.switch_to_full : LOC.switch_to_compact;
    $('steering-status').innerHTML =
      '<strong>' + LOC.steering_summary_title + '</strong><br>' +
      LOC.steering_plan_only_label + ' <code>' + (s.planOnly ? LOC.on_label : LOC.off_label) + '</code><br>' +
      LOC.steering_planner_enforced_label + ' <code>' + (s.plannerEnforced ? LOC.on_label : LOC.off_label) + '</code><br>' +
      LOC.steering_checkpoint_label + ' <code>' + (s.checkpoint ? LOC.on_label : LOC.off_label) + '</code><br>' +
      LOC.steering_tool_routing_guard_label + ' <code>' + (s.toolRoutingGuard !== false ? LOC.on_label : LOC.off_label) + '</code><br>' +
      LOC.steering_auto_retry_label + ' <code>' + (s.autoRetry !== false ? LOC.on_label : LOC.off_label) + '</code><br>' +
      LOC.steering_auto_approve_label + ' <code>' + (s.autoApprove ? LOC.on_label : LOC.off_label) + '</code>';
    $('vision-model').value = s.visionModel || 'gemini-3.8-flash';
    // Show/hide fallback order when auto is selected
    (() => { const v = s.visionModel || ''; $('vision-fallback-order').style.display = (v === 'auto') ? '' : 'none'; })();
    // Render fallback order list
    (() => {
      const list = $('fallback-list');
      if (!list) return;
      const order = (s.visionFallbackOrder && s.visionFallbackOrder.length > 0) ? s.visionFallbackOrder : ['gemini', 'zhipu', 'alibaba'];
      const icons = { gemini: '\uD83D\uDD2E', zhipu: '\uD83E\uDDE0', alibaba: '\u2601\uFE0F' };
      const names = { gemini: 'Gemini', zhipu: 'Zhipu / GLM', alibaba: 'Alibaba / Qwen' };
      list.innerHTML = order.map((id, i) => {
        const hasKey = !!(s.providers && s.providers[id]);
        return '<div class="fb-item" data-id="' + id + '">' +
          '<span style="width:14px;text-align:center;opacity:0.5;">' + (i + 1) + '.</span>' +
          '<span>' + (icons[id] || '\uD83D\uDD39') + '</span>' +
          '<span style="flex:1;">' + (names[id] || id) + '</span>' +
          '<span class="dot ' + (hasKey ? 'on' : '') + '" style="margin:0 3px;" title="' + (hasKey ? 'Key set' : 'No key') + '"></span>' +
          '<button class="fb-up" data-id="' + id + '" ' + (i === 0 ? 'disabled' : '') + ' style="padding:0 4px;font-size:10px;opacity:' + (i === 0 ? '0.3' : '0.7') + ';">\u25B2</button>' +
          '<button class="fb-down" data-id="' + id + '" ' + (i === order.length - 1 ? 'disabled' : '') + ' style="padding:0 4px;font-size:10px;opacity:' + (i === order.length - 1 ? '0.3' : '0.7') + ';">\u25BC</button>' +
          '</div>';
      }).join('');
      // Wire up/down buttons
      list.querySelectorAll('.fb-up,.fb-down').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var dir = btn.classList.contains('fb-up') ? 'up' : 'down';
          vscode.postMessage({ type: 'visionFallbackReorder', id: btn.dataset.id, direction: dir });
        });
      });
    })();
    // Wire reset fallback button
    (() => {
      const btn = $('reset-fallback-order');
      if (btn) btn.addEventListener('click', function() { vscode.postMessage({ type: 'visionFallbackReset' }); });
    })();
    $('image-gen-provider').value = s.imageGenProvider || 'gemini';
    $('image-gen-auto').checked = !!s.imageGenAutoApprove;
    $('flow-state').checked = !!s.flowState;
    (function() {
      var el = $('error-learning');
      var warn = $('error-learning-warning');
      if (el) el.checked = !!s.errorLearning;
      if (warn && el && el.checked) warn.style.display = 'block';
    })();
    $('ocr-only').checked = !!s.ocrOnly;
    $('skip-ocr').checked = !!s.skipOcr;
      $('local-first').checked = !!s.localFirst;
    $('self-heal-env').checked = !!s.selfHealEnv;
    const wEl = $('whisper-inbox');
    if (s.whisperCount > 0) wEl.innerHTML = '<div class="item">' + s.whisperCount + ' ' + LOC.whisper_unread + '</div>';
    else wEl.innerHTML = '<div class="empty">' + LOC.whisper_no_pending + '</div>';
    $('whisper-disabled').checked = !!s.whisperDisabled;

    // ── Concert Board rendering ──
    // Always render from state data; Phase 4 enrich will overlay if needed.
    const cbEl = $('concert-board');
    const cbBadge = $('concert-board-badge');
    if (s.concertBoard && s.concertBoard.messages && s.concertBoard.messages.length > 0) {
        const msgs = s.concertBoard.messages;
        if (cbBadge) cbBadge.textContent = '(' + msgs.length + ' messages)';
        cbEl.innerHTML = msgs.map(m => {
            const time = new Date(m.timestamp).toISOString().slice(11, 16);
            const fromEmoji = m.from === 'coordinator' ? '🎼' : m.from === 'verifier' ? '🔍' : m.from === 'researcher' ? '📚' : m.from === 'implementer' ? '🔧' : m.from === 'scout' ? '🔭' : m.from === 'designer' ? '🎨' : m.from === 'critic' ? '⚖️' : '🎻';
            const roomLabel = m.room.replace('swarm-', '').slice(0, 12);
            const bodyPreview = m.body.length > 120 ? m.body.slice(0, 120) + '…' : m.body;
            return '<div class="todo-item" style="font-size:10px;line-height:1.4;">' +
                '<span style="flex:1">' + fromEmoji + ' <b>' + escapeHtml(m.from) + '</b> <span style="opacity:0.5">' + escapeHtml(time) + '</span><br>' +
                '<span style="opacity:0.7;font-size:9px;">' + escapeHtml(roomLabel) + '</span><br>' +
                '<span style="word-break:break-word;">' + escapeHtml(bodyPreview) + '</span></span></div>';
        }).join('');
    } else {
        if (cbBadge) cbBadge.textContent = '';
        cbEl.innerHTML = '<div class="empty">' + LOC.concert_quiet + '</div>';
    }

    // ── Custom Roles rendering ──
    const crEl = $('custom-roles-list');
    if (s.customRoles && Array.isArray(s.customRoles) && s.customRoles.length > 0) {
        crEl.innerHTML = s.customRoles.map((r, i) => {
            const label = r.label || r.id || LOC.custom_roles_unnamed;
            const purpose = r.purpose || '';
            return '<div class="todo-item" style="align-items:flex-start;">' +
                '<span style="flex:1;font-size:11px;"><b>' + escapeHtml(label) + '</b>' +
                (purpose ? '<br><span style="opacity:0.6;font-size:10px;">' + escapeHtml(purpose.slice(0, 100)) + '</span>' : '') +
                '</span>' +
                '<button class="subtle" data-delete-role="' + i + '" style="padding:1px 4px;font-size:10px;" title="Delete">✕</button></div>';
        }).join('');
        crEl.querySelectorAll('[data-delete-role]').forEach(btn => {
            btn.addEventListener('click', function() {
                vscode.postMessage({ type: 'deleteCustomRole', index: parseInt(this.dataset.deleteRole) });
            });
        });
    } else {
        crEl.innerHTML = '<div class="empty">No custom roles defined yet.</div>';
    }

    // ── Symphony Profiles rendering ──
    const spEl = $('symphony-profiles');
    if (s.profiles && Array.isArray(s.profiles) && s.profiles.length > 0) {
        spEl.innerHTML = s.profiles.map((p) => {
            return '<div class="todo-item" style="align-items:flex-start;">' +
                '<span style="flex:1;font-size:11px;"><b>' + escapeHtml(p.name) + '</b> — ' + escapeHtml(p.role) +
                (p.capsules > 0 ? '<br><span style="opacity:0.6;font-size:10px;">📚 ' + p.capsules + ' capsule(s)</span>' : '') +
                '</span></div>';
        }).join('');
    } else {
        spEl.innerHTML = '<div class="empty">' + LOC.symphony_no_profiles + '</div>';
    }

    const gmEl = $('global-memory');
    const gmb = $('global-memory-badge');
    if (s.globalMemory && s.globalMemory.totalPatterns > 0) {
      gmb.textContent = '(' + s.globalMemory.totalPatterns + ' ' + LOC.global_memory_patterns + ' ' + s.globalMemory.uniqueWorkspaces + ' ' + LOC.global_memory_workspaces + ')';
      gmEl.innerHTML = '<div class="item">' + s.globalMemory.totalPatterns + ' ' + LOC.global_memory_patterns + ' ' + s.globalMemory.uniqueWorkspaces + ' ' + LOC.global_memory_workspaces + '</div>' +
        (s.globalMemory.topTags.length > 0 ? '<div style="font-size:10px;margin-top:2px;">Top tags: ' + s.globalMemory.topTags.slice(0, 8).map(t => t.tag).join(', ') + '</div>' : '');
    } else {
      gmb.textContent = '';
      gmEl.innerHTML = '<div class="empty">' + LOC.global_memory_no_patterns + '</div>';
    }

    const usageEl = $('usage');
    const accountingHtml = renderProviderAccounting(s.usage && s.usage.accounting);
    if (s.sidebarMode === 'compact') {
      usageEl.innerHTML = '<div class="empty">' + LOC.sessions_hidden_compact + '</div>' + accountingHtml;
    } else if (!s.usage || s.usage.calls === 0) {
      usageEl.innerHTML = '<div class="empty">' + LOC.usage_no_calls + '</div>' + accountingHtml;
    } else {
      const rowsHtml = s.usage.rows.map(r => {
        const units = r.billableUnits > 0 ? ' / ' + r.billableUnits + ' ' + escapeHtml(r.billableUnitLabel || 'unit') + (r.billableUnits === 1 ? '' : 's') : '';
        const latency = r.measuredCalls > 0
          ? ' / last ' + formatLatency(r.lastDurationMs) + ' / avg ' + formatLatency(r.averageDurationMs) + (r.slowCalls > 0 ? ' / slow ' + r.slowCalls : (r.delayedCalls > 0 ? ' / delayed ' + r.delayedCalls : ''))
          : '';
        // Cost display with relative indicators
        let costStr = r.estCostKnown ? ' / ' + costLabel(r.estCostDollars) : ' / cost unknown';
        if (r.provider === 'deepseek' && r.cachedPromptTokens > 0 && r.worstCaseCostDollars !== undefined && r.worstCaseCostDollars > (r.estCostDollars || 0) * 1.1) {
          costStr = ' / ' + costLabel(r.estCostDollars) + ' (worst-case ' + costLabel(r.worstCaseCostDollars) + ') ⚡cache';
        }
        return '<div class="todo-item"><span style="flex:1">' + escapeHtml(r.provider) + '/' + escapeHtml(r.tier) + '<br><span style="opacity:0.65">' + escapeHtml(r.model || 'unknown') + '</span></span>' +
        '<span style="opacity:0.7">' + r.calls + ' calls / ' + r.totalTokens + ' tok' + units + latency + costStr + '</span></div>';
      }).join('');
      usageEl.innerHTML = rowsHtml +
        '<div style="margin-top:4px;font-size:10px;opacity:0.6">' + LOC.usage_total + ' ' + s.usage.calls + ' calls / ' + s.usage.total + ' tok</div>' +
        '<button class="subtle" id="reset-usage" style="margin-top:4px;">' + LOC.usage_reset + '</button>' + accountingHtml;
      const reset = document.getElementById('reset-usage');
      if (reset) reset.addEventListener('click', () => vscode.postMessage({ type: 'resetUsage' }));
    }

    // Context health rendering
    const healthEl = $('context-health');
    if (healthEl) {
      if (!s.contextHealth || s.contextHealth.harmonyBytes === 0) {
        healthEl.innerHTML = '<div class="empty">' + LOC.context_health_no_folder + '</div>';
      } else {
        const sizeText = s.contextHealth.harmonyBytes < 1024 * 1024
          ? (s.contextHealth.harmonyBytes / 1024).toFixed(1) + ' KB'
          : (s.contextHealth.harmonyBytes / (1024 * 1024)).toFixed(1) + ' MB';
        let dotColor, label, labelColor;
        if (s.contextHealth.healthStatus === 'critical') {
          dotColor = '#f14c4c';
          label = LOC.context_health_large;
          labelColor = '#f14c4c';
        } else if (s.contextHealth.healthStatus === 'warning') {
          dotColor = '#e5c07b';
          label = LOC.context_health_growing;
          labelColor = '#e5c07b';
        } else {
          dotColor = '#89b869';
          label = '';
          labelColor = '#89b869';
        }
        const dotHtml = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + dotColor + ';margin-right:5px;vertical-align:middle;"></span>';
        healthEl.innerHTML = '<div style="font-size:11px;">' + dotHtml + LOC.context_health_context + ' ' + sizeText + '</div>' +
          (label ? '<div style="font-size:10px;color:' + labelColor + ';margin-top:2px;margin-left:13px;">' + label + '</div>' : '');
      }
    }

    // Fallback log section
    const fallbackEl = $('fallback-log') || document.createElement('div');
    if (!fallbackEl.id) {
      fallbackEl.id = 'fallback-log';
      usageEl.parentNode?.insertBefore(fallbackEl, usageEl.nextSibling);
    }
    if (!s.fallbackEvents || s.fallbackEvents.length === 0) {
      fallbackEl.innerHTML = '';
    } else {
      fallbackEl.innerHTML = '<div style="margin-top:8px;font-size:10px;color:var(--vscode-charts-orange);">' + LOC.model_fallback + '</div>' +
        s.fallbackEvents.map(f =>
          '<div style="font-size:10px;opacity:0.8;padding:2px 0;">' +
          escapeHtml(f.originalModel) + ' → ' + escapeHtml(f.fallbackModel) +
          '</div>'
        ).join('');
    }

    const sessEl = $('sessions');
    if (s.sidebarMode === 'compact') {
      sessEl.innerHTML = '<div class="empty">' + LOC.sessions_hidden_compact + '</div>';
    } else if (!s.sessions || s.sessions.length === 0) {
      sessEl.innerHTML = '<div class="empty">' + LOC.sessions_none + '</div>';
    } else {
      sessEl.innerHTML = s.sessions.map(name =>
        '<div class="todo-item"><span>📄</span><span>' + escapeHtml(name) + '</span></div>'
      ).join('');
    }

    const hubEl = $('hub-roots');
    if (s.sidebarMode === 'compact') {
      hubEl.innerHTML = '<div class="empty">' + LOC.hub_hidden_compact + '</div>';
    } else if (!s.hubRoots || s.hubRoots.length === 0) {
      hubEl.innerHTML = '<div class="empty">No folders indexed yet. Open a project or click + Add folder.</div>';
    } else {
      const hiddenRootCount = Math.max(0, Number(s.hubRootCount || s.hubRoots.length) - s.hubRoots.length);
      hubEl.innerHTML = s.hubRoots.map(p =>
        '<div class="todo-item"><span>📂</span><span style="font-size:11px;word-break:break-all;">' + escapeHtml(p) + '</span></div>'
      ).join('') + (hiddenRootCount ? '<div class="hint">+' + hiddenRootCount + ' ' + LOC.hub_more_folders + '</div>' : '');
    }
    const hubStatus = $('hub-status');
    if (hubStatus) {
      const hs = s.hubStatus || { online: false };
      if (hs.online) {
        const indexedPathCount = hs.indexedPathCount ?? ((hs.indexedPaths || []).length);
        hubStatus.innerHTML =
          '<div style="color:var(--vscode-charts-green);">' + LOC.hub_online + '</div>' +
          '<div style="opacity:0.75;">' + LOC.hub_model + ' ' + escapeHtml(hs.model || '?') + '</div>' +
          '<div style="opacity:0.75;">' + (hs.vectors ?? 0) + ' ' + LOC.hub_vectors + ' · ' + indexedPathCount + ' ' + LOC.hub_indexed + '</div>';
      } else {
        hubStatus.innerHTML = s.hubAutoStart
          ? '<div style="color:var(--vscode-charts-orange);">' + LOC.hub_offline + '</div><div style="opacity:0.75;">' + LOC.hub_click_start + ' ' + LOC.hub_message_start + ' ' + escapeHtml(s.hubStartOnMessage || 'prompt') + '.</div>'
          : '<div style="color:var(--vscode-charts-orange);">' + LOC.hub_paused + '</div><div style="opacity:0.75;">' + LOC.hub_on_demand_paused + ' ' + LOC.hub_message_start + ' ' + escapeHtml(s.hubStartOnMessage || 'prompt') + '.</div>';
      }
    }
    const autoStartBtn = $('toggle-hub-autostart');
    if (autoStartBtn) autoStartBtn.textContent = s.hubAutoStart ? LOC.hub_auto_start_on : LOC.hub_auto_start_off;

    const providers = $('providers');
    const provList = s.providerOrder || ['deepseek', 'alibaba', 'tencent', 'moonshot', 'kimiCode', 'zhipu', 'gemini', 'openrouter', 'openai', 'claude'];
    const providerLabels = s.providerLabels || {};
    const slotCounts = s.providerSlotCounts || {};
    const slotLabels = ['C', 'A', 'E', 'V']; // Chat, Agents, External, Vision
    const slotTitles = ['Chat key', 'Agents key', 'External key', 'Vision key'];
    providers.innerHTML = provList.map(p => {
      const on = !!(s.providers && s.providers[p]);
      const label = providerLabels[p] || p;
      const secret = s.providerSecretKeys && s.providerSecretKeys[p] ? s.providerSecretKeys[p] : '';
      const endpoint = s.providerEndpoints && s.providerEndpoints[p] ? s.providerEndpoints[p] : null;
      const count = slotCounts[p] ?? (on ? 1 : 0);
      const isTencent = p === 'tencent';
      // Generate slot pills: clickable, green=set, blue=fallback, gray=missing
      const slotPills = isTencent
        ? '<span class="slot-pill tencent" title="Native SecretId+SecretKey dual auth">🔑</span>'
        : slotLabels.map((letter, i) => {
            const filled = i < count;
            const color = filled ? (i === 0 ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-blue)') : 'var(--vscode-descriptionForeground)';
            const title = filled ? slotTitles[i] + ' set (click to change)' : slotTitles[i] + ' not set (click to add)';
            return '<button class="slot-pill-btn" data-provider="' + p + '" data-slot="' + i + '" style="background:' + color + ';color:#fff;font-size:9px;padding:0 3px;border-radius:2px;margin:0 1px;border:none;cursor:pointer;font-family:monospace;" title="' + title + '">' + letter + '</button>';
          }).join('');
      return '<div class="provider-row">' +
        '<span class="dot ' + (on ? 'on' : '') + '"></span>' +
        '<span class="name">' + escapeHtml(label) + '<br><span class="hint">' + LOC.provider_secret_storage + ' ' + escapeHtml(secret || LOC.provider_na) + '</span>' +
        (endpoint ? '<br><span class="hint">' + LOC.provider_endpoint_label + ' ' + escapeHtml(endpoint.label) + (endpoint.needsCustomBaseUrl ? ' ' + LOC.provider_needs_base_url : '') + '</span>' : '') +
        '</span>' +
        '<span class="slot-indicators">' + slotPills + '</span>' +
        '<button class="subtle" data-provider="' + p + '" style="width:auto;padding:2px 6px;">' +
        (on ? LOC.provider_replace_key : LOC.provider_set_key_short) +
        '</button></div>';
    }).join('');
    providers.querySelectorAll('button[data-provider]').forEach(btn => {
      btn.addEventListener('click', () => vscode.postMessage({ type: 'setProviderKey', provider: btn.dataset.provider }));
    });
    // Wire slot pill clicks
    providers.querySelectorAll('.slot-pill-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const provider = btn.dataset.provider;
        const slotIndex = parseInt(btn.dataset.slot || '0', 10);
        vscode.postMessage({ type: 'setProviderSlotKey', provider, slotIndex });
      });
    });

    const td = $('todos');
    if (!s.todos || s.todos.length === 0) {
      td.innerHTML = '<div class="empty">' + LOC.plan_none + '</div>';
    } else {
      td.innerHTML = s.todos.map(t =>
        '<div class="todo-item' + (t.done ? ' done' : '') + '">' +
        '<span>' + (t.done ? '✓' : '○') + '</span>' +
        '<span>' + escapeHtml(t.text) + '</span></div>'
      ).join('');
    }

    const mem = $('memory');
    const toggleMemory = $('toggle-memory-panel');
    const memoryMeta = $('memory-meta');
    if (memoryMeta) {
      const ms = s.memoryStats || {};
      const preserved = ms.preservedFiles ? ' ' + LOC.memory_preserved_files_label + ' ' + ms.preservedFiles + (ms.lastPreservedPath ? ' (' + escapeHtml(ms.lastPreservedPath) + ')' : '') + '.' : '';
      memoryMeta.innerHTML = LOC.memory_meta + ' ' + LOC.memory_active_entries + ' ' + escapeHtml(ms.activeEntries ?? 0) + '.' + preserved;
    }
    if (s.memoryHidden) {
      mem.innerHTML = '<div class="empty">' + LOC.memory_hidden + '</div>';
      if (toggleMemory) toggleMemory.textContent = LOC.memory_show;
    } else if (s.sidebarMode === 'compact') {
      mem.innerHTML = '<div class="empty">' + LOC.memory_hidden_compact + '</div>';
      if (toggleMemory) toggleMemory.textContent = LOC.memory_hide;
    } else if (!s.memory || s.memory.length === 0) {
      mem.innerHTML = '<div class="empty">' + LOC.memory_none + '</div>';
      if (toggleMemory) toggleMemory.textContent = LOC.memory_hide;
    } else {
      mem.innerHTML = s.memory.map(m =>
        '<button class="subtle memory-item" data-prompt="' + escapeHtml(m.preview) + '">' +
        '<span class="ts">' + escapeHtml(m.ts) + '</span><br>' +
        escapeHtml(m.preview) + '</button>'
      ).join('');
      if (toggleMemory) toggleMemory.textContent = LOC.memory_hide;
      mem.querySelectorAll('.memory-item').forEach(el => {
        el.addEventListener('click', () => vscode.postMessage({ type: 'recallEntry', value: el.dataset.prompt }));
      });
    }

    $('status').innerHTML =
      'Harmony <span class="pill">v' + escapeHtml(s.version) + '</span> <span style="font-size:9px;opacity:0.5;">[' + escapeHtml(s.branch || 'provider-dropdowns') + ']</span><br>' +
      LOC.sidebar_workspace + ' <code>' + escapeHtml(s.workspace) + '</code><br>' +
      LOC.sidebar_backend + ' <code>' + escapeHtml(s.backendUrl) + '</code><br>' +
      LOC.status_provider_label + ' <code>' + escapeHtml(s.provider) + '</code><br>' +
      (primaryDirect ? (LOC.sidebar_key + ' ' + (primaryKeySaved ? LOC.sidebar_key_set : '<em>' + LOC.sidebar_key_none + '</em>') + '<br>') : '');
    $('routing-summary').innerHTML =
      '<strong>' + LOC.routing_primary_route + '</strong>: <code>' + escapeHtml(s.provider) + '</code>' + (primaryDirect ? ' / <code>' + escapeHtml(primaryModel) + '</code>' : ' / VS Code Chat dropdown') + '<br>' +
      '<strong>' + LOC.routing_agents_route + '</strong>: <code>' + escapeHtml(s.agentsPreset || 'auto') + '</code> / <code>' + escapeHtml(s.agentsProvider || 'auto') + '</code> / <code>' + escapeHtml(s.agentsTier || 'coding') + '</code>' + (s.agentsResolvedModel ? ' -> <code>' + escapeHtml(s.agentsResolvedProvider) + ' / ' + escapeHtml(s.agentsResolvedModel) + '</code>' : ' -> <em>' + LOC.routing_no_key_resolved + '</em>') + '<br>' +
      '<strong>' + LOC.routing_swarm_default + '</strong>: <code>' + escapeHtml(s.swarmProvider) + '</code> / <code>' + escapeHtml(s.swarmTier) + '</code> / <code>' + escapeHtml(s.swarmModel) + '</code>; provider calls <code>' + (s.swarmProviderCallsEnabled ? LOC.routing_enabled : LOC.routing_disabled) + '</code><br>' +
      (primaryEndpoint ? '<strong>' + LOC.routing_primary_endpoint + '</strong>: <code>' + escapeHtml(primaryEndpoint.label) + '</code>' + (primaryEndpoint.baseUrl ? ' / <code>' + escapeHtml(primaryEndpoint.baseUrl) + '</code>' : ' / <em>' + escapeHtml(primaryEndpoint.detail) + '</em>') + '<br>' : '') +
      '<strong>' + LOC.routing_key_stores + '</strong>: ' + LOC.routing_key_stores_detail;
    $('checkpoint-status').innerHTML = LOC.sidebar_checkpoint + ' <code>v' + escapeHtml(s.version) + '</code><br>' + LOC.sidebar_compose + ' <code>' + LOC.sidebar_compose_hint + '</code>';
    $('swarm-default').innerHTML =
      LOC.swarm_config_default + ' <code>' + escapeHtml(s.swarmProvider) + '</code> / <code>' + escapeHtml(s.swarmTier) + '</code><br>' +
      LOC.swarm_config_model + ' <code>' + escapeHtml(s.swarmModel) + '</code><br>' +
      LOC.swarm_config_mode + ' <code>' + escapeHtml(s.swarmDefaultMode) + '</code><br>' +
      LOC.swarm_config_loop + ' <code>' + LOC.swarm_config_loop_val + '</code><br>' +
      LOC.swarm_config_global_plan_only + ' <code>' + (s.swarmGlobalPlanOnly ? LOC.on_label : LOC.off_label) + '</code><br>' +
      LOC.swarm_config_risky_switches + ' <code>' + (s.swarmRiskSwitchCount ? escapeHtml(String(s.swarmRiskSwitchCount) + ' ' + LOC.on_label) : LOC.swarm_config_all_off) + '</code>' +
      (s.swarmRiskSwitchCount ? '<br>' + LOC.swarm_config_enabled + ' <code>' + escapeHtml(s.swarmRiskSwitchLabels.join(', ')) + '</code>' : '');

    // DeepSwarm mode dropdown already populated in HTML — restore selection from state
    const dsSelect = $('deepswarm-mode');
    if (s.deepswarmMode && dsSelect) dsSelect.value = s.deepswarmMode;
    // Restore strategy selection from state
    const dsStrategySelect = $('deepswarm-strategy');
    if (s.deepswarmStrategy && dsStrategySelect) dsStrategySelect.value = s.deepswarmStrategy;
    // Restore provider + tier from state
    const dsProviderSelect = $('deepswarm-provider');
    if (s.deepswarmProvider && dsProviderSelect) dsProviderSelect.value = s.deepswarmProvider;
    const dsTierSelect = $('deepswarm-tier');
    if (s.deepswarmTier && dsTierSelect) dsTierSelect.value = s.deepswarmTier;
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'state') render(e.data.value);
    if (e.data?.type === 'loadingState') {
      const el = $('sidebar-loading');
      if (el) el.style.display = e.data.value ? 'flex' : 'none';
      // Clear safety timeout on any loadingState message
      if (window.__harmonyLoadingTimer) { clearTimeout(window.__harmonyLoadingTimer); window.__harmonyLoadingTimer = 0; }
    }
    // Safety timeout: auto-hide loading spinner after 25s to prevent perpetual loading.
    // Arms on EVERY state message (not just loading:true) in case messages arrive
    // out of order or the initial fastState post is skipped.
    if (e.data?.type === 'state') {
      if (window.__harmonyLoadingTimer) clearTimeout(window.__harmonyLoadingTimer);
      window.__harmonyLoadingTimer = setTimeout(() => {
        const el = $('sidebar-loading');
        if (el && el.style.display !== 'none') {
          console.warn('[Harmony Sidebar] Loading spinner safety timeout — auto-hiding after 25s');
          el.style.display = 'none';
        }
      }, 25_000);
    }
    // Handle Phase 4 enrichments (concert board, custom roles) — non-blocking updates
    // that arrive after the main state is already rendered. Direct DOM updates
    // avoid corrupting form fields that render() would reset with partial state.
    if (e.data?.type === 'enrich' && e.data.value) {
      // Defer DOM updates to the next animation frame to batch visual changes
      // and prevent layout thrashing from rapid concert board refreshes.
      requestAnimationFrame(function() {
      const v = e.data.value;
      if (v.concertBoard) {
        window.__concertBoardEnriched = true;
        const cb = v.concertBoard;
        const cbEl = $('concert-board');
        const cbBadge = $('concert-board-badge');
        if (cbEl) {
          if (cb.messages && cb.messages.length > 0) {
            if (cbBadge) cbBadge.textContent = '(' + cb.messages.length + ' ' + LOC.concert_messages + ')';
            cbEl.innerHTML = cb.messages.map(function(m) {
              var time = new Date(m.timestamp).toISOString().slice(11, 16);
              var emoji = m.from === 'coordinator' ? '🎼' : m.from === 'verifier' ? '🔍' : m.from === 'researcher' ? '📚' : m.from === 'implementer' ? '🔧' : m.from === 'scout' ? '🔭' : m.from === 'designer' ? '🎨' : m.from === 'critic' ? '⚖️' : '🎻';
              var roomLabel = m.room.replace('swarm-', '').slice(0, 12);
              var preview = m.body.length > 120 ? m.body.slice(0, 120) + '\u2026' : m.body;
              return '<div class="todo-item" style="font-size:10px;line-height:1.4;">' +
                '<span style="flex:1">' + emoji + ' <b>' + escapeHtml(m.from) + '</b> <span style="opacity:0.5">' + escapeHtml(time) + '</span><br>' +
                '<span style="opacity:0.7;font-size:9px;">' + escapeHtml(roomLabel) + '</span><br>' +
                '<span style="word-break:break-word;">' + escapeHtml(preview) + '</span></span></div>';
            }).join('');
          } else {
            if (cbBadge) cbBadge.textContent = '';
            cbEl.innerHTML = '<div class="empty">' + LOC.concert_quiet + '</div>';
          }
        }
      }
      if (v.customRoles) {
        const crEl = $('custom-roles-list');
        if (crEl) {
          if (v.customRoles.length > 0) {
            crEl.innerHTML = v.customRoles.map(function(r, i) {
              var label = r.label || r.id || LOC.custom_roles_unnamed;
              var purpose = r.purpose || '';
              return '<div class="todo-item" style="align-items:flex-start;">' +
                '<span style="flex:1;font-size:11px;"><b>' + escapeHtml(label) + '</b>' +
                (purpose ? '<br><span style="opacity:0.6;font-size:10px;">' + escapeHtml(purpose.slice(0, 100)) + '</span>' : '') +
                '</span>' +
                '<button class="subtle" data-delete-role="' + i + '" style="padding:1px 4px;font-size:10px;" title="Delete">\u2715</button></div>';
            }).join('');
            crEl.querySelectorAll('[data-delete-role]').forEach(function(btn) {
              btn.addEventListener('click', function() {
                vscode.postMessage({ type: 'deleteCustomRole', index: parseInt(this.dataset.deleteRole) });
              });
            });
          } else {
            crEl.innerHTML = '<div class="empty">' + LOC.custom_roles_none + '</div>';
          }
        }
      }
      if (v.activeDeliberations) {
        const delEl = $('active-deliberations');
        if (delEl) {
          const dels = v.activeDeliberations;
          if (dels.length > 0) {
            delEl.innerHTML = dels.map(function(d) {
              var sevColor = d.severity === 'critical' ? '#e74856' : d.severity === 'high' ? '#f9a825' : d.severity === 'medium' ? '#64b5f6' : '#81c784';
              return '<div class="todo-item" style="font-size:10px;line-height:1.4;">' +
                '<span style="flex:1">' +
                '<span style="color:' + sevColor + ';font-weight:600;">' + escapeHtml(d.severity.toUpperCase()) + '</span> ' +
                '<b>' + escapeHtml(d.sourceRole) + '</b> → <b>' + escapeHtml(d.targetRole) + '</b><br>' +
                '<span style="opacity:0.7;">[' + escapeHtml(d.status) + '] ' + escapeHtml((d.description || '').slice(0, 100)) + '</span></span></div>';
            }).join('');
          } else {
            delEl.innerHTML = '<div class="empty">' + LOC.deliberations_none + '</div>';
          }
        }
      }
      });
    }
    if (e.data?.type === 'deepswarm-hints') {
      if (e.data.description) $('deepswarm-desc').textContent = e.data.description;
      if (e.data.steps) $('deepswarm-steps').textContent = LOC.deepswarm_steps + ' ' + e.data.steps;
      if (e.data.cost) $('deepswarm-cost').textContent = LOC.deepswarm_relative_cost + ' ' + e.data.cost;
    }
    if (e.data?.type === 'deepswarm-strategy-hints') {
      if (e.data.description) $('deepswarm-strategy-desc').textContent = LOC.deepswarm_strategy + ': ' + e.data.description;
    }
  });

  $('open-chat').addEventListener('click', () => vscode.postMessage({ type: 'openChat' }));
  $('open-compose').addEventListener('click', () => vscode.postMessage({ type: 'openCompose' }));
  $('prepare-self-update').addEventListener('click', () => vscode.postMessage({ type: 'prepareSelfUpdateCheckpoint' }));
  $('create-seat-handoff').addEventListener('click', () => vscode.postMessage({ type: 'createSeatHandoffBundle' }));
  $('create-resume-brief').addEventListener('click', () => vscode.postMessage({ type: 'createResumeBrief' }));
  $('open-swarm-launcher').addEventListener('click', () => vscode.postMessage({ type: 'openSwarmLauncher' }));
  $('open-swarm-direct').addEventListener('click', () => vscode.postMessage({ type: 'openSwarmDirectControls' }));
  $('configure-swarm-defaults').addEventListener('click', () => vscode.postMessage({ type: 'configureSwarmDefaults' }));
  $('orchestrate-mode').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleOrchestrateMode', value: e.target.checked }));
  $('deep-orchestrate-mode').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleDeepOrchestrateMode', value: e.target.checked }));
  $('deepswarm-provider').addEventListener('change', (e) => vscode.postMessage({ type: 'selectDeepSwarmProvider', value: e.target.value }));
  $('deepswarm-tier').addEventListener('change', (e) => vscode.postMessage({ type: 'selectDeepSwarmTier', value: e.target.value }));
  $('deepswarm-strategy').addEventListener('change', (e) => vscode.postMessage({ type: 'selectDeepSwarmStrategy', value: e.target.value }));
  $('deepswarm-mode').addEventListener('change', (e) => vscode.postMessage({ type: 'selectDeepSwarmMode', value: e.target.value }));
  $('run-deepswarm').addEventListener('click', () => vscode.postMessage({ type: 'runDeepSwarm', pipelineId: '', mode: $('deepswarm-mode').value, strategy: $('deepswarm-strategy').value, provider: $('deepswarm-provider').value, tier: $('deepswarm-tier').value }));
  $('profile').addEventListener('change', (e) => vscode.postMessage({ type: 'setProfile', value: e.target.value }));
  $('provider').addEventListener('change', (e) => vscode.postMessage({ type: 'setProvider', value: e.target.value }));
  $('primary-model').addEventListener('change', (e) => vscode.postMessage({ type: 'setPrimaryModel', provider: $('provider').value, value: e.target.value }));
  $('rewards-save-btn').addEventListener('click', () => {
    const epId = $('rewards-endpoint-id').value.trim();
    if (epId) vscode.postMessage({ type: 'setPrimaryModel', provider: 'doubao-rewards', value: epId });
  });
  $('agent-steps').addEventListener('change', (e) => vscode.postMessage({ type: 'setAgentMaxSteps', value: e.target.value }));
  $('agent-steps-1').addEventListener('click', () => { $('agent-steps').value = '1'; vscode.postMessage({ type: 'setAgentMaxSteps', value: 1 }); });
  $('agent-steps-11').addEventListener('click', () => { $('agent-steps').value = '11'; vscode.postMessage({ type: 'setAgentMaxSteps', value: 11 }); });
  $('agent-steps-1111').addEventListener('click', () => { $('agent-steps').value = '1111'; vscode.postMessage({ type: 'setAgentMaxSteps', value: 1111 }); });
  $('agent-steps-unlimited').addEventListener('click', () => { $('agent-steps').value = '-1'; vscode.postMessage({ type: 'setAgentMaxSteps', value: -1 }); });
  $('auto-approve').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleAutoApprove', value: e.target.checked }));
  $('plan-only').addEventListener('change', (e) => vscode.postMessage({ type: 'togglePlanOnly', value: e.target.checked }));
  $('big-guns-mode').addEventListener('change', (e) => vscode.postMessage({ type: 'setBigGunsMode', value: e.target.value }));
  $('planner-enforced').addEventListener('change', (e) => vscode.postMessage({ type: 'togglePlannerEnforced', value: e.target.checked }));
  $('checkpoint').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleCheckpoint', value: e.target.checked }));
  $('pre-action-checklist').addEventListener('change', (e) => vscode.postMessage({ type: 'togglePreActionChecklist', value: e.target.checked }));
  $('swarm-verifier').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleSwarmVerifier', value: e.target.checked }));
  $('swarm-provider-fanout').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleSwarmProviderFanout', value: e.target.checked }));
  $('active-batch-size').addEventListener('change', (e) => vscode.postMessage({ type: 'setActiveBatchSize', value: Number(e.target.value) }));
  $('tool-routing-guard').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleToolRoutingGuard', value: e.target.checked }));
    $('auto-retry').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleAutoRetry', value: e.target.checked }));
  $('diagnostics').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleDiagnostics', value: e.target.checked }));
  $('triple-check-auto').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleTripleCheckAuto', value: e.target.checked }));
  $('deepseek-trace').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleDeepSeekTrace', value: e.target.checked }));
  $('deepseek-thinking').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleDeepSeekThinking', value: e.target.checked }));
  $('sidebar-compact').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleSidebarCompact', value: e.target.checked }));
  try { $('language-select').addEventListener('change', (e) => vscode.postMessage({ type: 'setLanguage', value: e.target.value })); } catch { /* language-select may not exist if using segmented control */ }
  // Segmented language control
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const lang = this.dataset.lang;
      if (!lang) return;
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      vscode.postMessage({ type: 'setLanguage', value: lang });
    });
  });
  $('reload-profiles').addEventListener('click', () => vscode.postMessage({ type: 'reloadProfiles' }));
  $('create-profile').addEventListener('click', () => vscode.postMessage({ type: 'createProfile' }));
  $('configure-sidebar-mode').addEventListener('click', () => vscode.postMessage({ type: 'configureSidebarMode' }));
  $('write-oom-diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'writeOomDiagnostics' }));
  $('enable-low-memory-safety').addEventListener('click', () => vscode.postMessage({ type: 'enableLowMemorySafetyMode' }));
  $('restore-low-memory-safety').addEventListener('click', () => vscode.postMessage({ type: 'restoreLowMemorySafetySettings' }));
  $('vision-model').addEventListener('change', (e) => { vscode.postMessage({ type: 'setVisionModel', value: e.target.value }); $('vision-fallback-order').style.display = (e.target.value === 'auto') ? '' : 'none'; });
  $('auto-gemini-model').addEventListener('change', (e) => vscode.postMessage({ type: 'setAutoGeminiModel', value: e.target.value }));
  $('auto-qwen-model').addEventListener('change', (e) => vscode.postMessage({ type: 'setAutoQwenModel', value: e.target.value }));
  $('image-gen-provider').addEventListener('change', (e) => vscode.postMessage({ type: 'setImageGenProvider', value: e.target.value }));
  $('image-gen-auto').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleImageGenAutoApprove', value: e.target.checked }));
  $('flow-state').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleFlowState', value: e.target.checked }));
    (function() {
      var el = $('error-learning');
      if (el) el.addEventListener('change', function(e) {
        vscode.postMessage({ type: 'toggleErrorLearning', value: e.target.checked });
        var warn = $('error-learning-warning');
        if (warn) warn.style.display = e.target.checked ? 'block' : 'none';
      });
    })();
  $('ocr-only').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleOcrOnly', value: e.target.checked }));
  $('skip-ocr').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleSkipOcr', value: e.target.checked }));
  $('local-first').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleLocalFirst', value: e.target.checked }));
  $('self-heal-env').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleSelfHealEnv', value: e.target.checked }));
  $('check-whispers').addEventListener('click', () => vscode.postMessage({ type: 'checkWhispers' }));
  $('refresh-concert-board').addEventListener('click', () => vscode.postMessage({ type: 'refreshConcertBoard' }));
  $('add-custom-role').addEventListener('click', () => vscode.postMessage({ type: 'addCustomRole' }));
  $('edit-custom-roles-json').addEventListener('click', () => vscode.postMessage({ type: 'editCustomRolesJson' }));
  $('refresh-custom-roles').addEventListener('click', () => vscode.postMessage({ type: 'refreshCustomRoles' }));
  $('whisper-disabled').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleWhisperDisabled', value: e.target.checked }));
  // Clear global memory is now a VS Code command only (harmony.clearGlobalMemory) — safer than a sidebar button.
  $('send-whisper').addEventListener('click', () => {
    const input = $('whisper-input');
    const body = (input.value || '').trim();
    if (!body) return;
    vscode.postMessage({ type: 'sendWhisper', body });
    input.value = '';
    $('send-whisper').textContent = '✉️ Sent!';
    setTimeout(() => { $('send-whisper').textContent = LOC.whisper_send; }, 1500);
  });
  $('whisper-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('send-whisper').click();
    }
  });
  $('discover-models').addEventListener('click', () => vscode.postMessage({ type: 'discoverModels' }));
  $('model-discovery-guide').addEventListener('click', () => vscode.postMessage({ type: 'openModelDiscoveryGuide' }));
  $('show-provider-status').addEventListener('click', () => vscode.postMessage({ type: 'showAgentsProviderStatus' }));
  $('configure-provider-endpoints').addEventListener('click', () => vscode.postMessage({ type: 'configureProviderEndpoints' }));
  $('import-provider-env').addEventListener('click', () => vscode.postMessage({ type: 'importProviderKeysFromEnv' }));
  $('manage-sessions').addEventListener('click', () => vscode.postMessage({ type: 'manageSessions' }));
  $('toggle-memory-panel').addEventListener('click', () => vscode.postMessage({ type: window.__harmonyMemoryHidden ? 'showMemoryPanel' : 'hideMemoryPanel' }));
  $('restore-engine').addEventListener('click', () => vscode.postMessage({ type: 'restoreEngine' }));
  $('allow-hub-folder').addEventListener('click', () => vscode.postMessage({ type: 'allowHubFolder' }));
  $('manage-hub-roots').addEventListener('click', () => vscode.postMessage({ type: 'manageHubRoots' }));
  $('start-hub').addEventListener('click', () => vscode.postMessage({ type: 'startHub' }));
  $('stop-hub').addEventListener('click', () => vscode.postMessage({ type: 'stopHub' }));
  $('toggle-hub-autostart').addEventListener('click', () => vscode.postMessage({ type: 'toggleHubAutoStart' }));
  $('index-workspace').addEventListener('click', () => vscode.postMessage({ type: 'indexWorkspace' }));
  $('run-cleanup').addEventListener('click', () => vscode.postMessage({ type: 'runCleanup' }));
  $('set-key').addEventListener('click', () => vscode.postMessage({ type: 'setProviderKey', provider: $('provider').value }));

  // Ask for initial state.
  vscode.postMessage({ type: 'refresh' });
  if (diagEl) { diagEl.style.background = '#66ff66'; diagEl.title = 'Script OK'; }
  } catch(e) {
    if (diagEl) { diagEl.style.background = '#ff4444'; diagEl.title = 'CRASH: ' + e.message; }
  if (diagEl) { document.getElementById('status').textContent = '⚠️ Script error — sidebar may be incomplete. See DevTools console (Ctrl+Shift+I) for details.'; }
    throw e;
  }
</script>
</body>
</html>`;
    }

    private async createProfileWizard(): Promise<void> {
        const lm = LanguageManager.getInstance();
        const MAX_NAME = 100;
        const MAX_ROLE = 200;
        const MAX_PERSONALITY = 10000;

        // Step 1/4: Profile name
        const name = await vscode.window.showInputBox({
            prompt: lm.getString('profile.wizard.stepNamePrompt'),
            placeHolder: lm.getString('profile.wizard.namePlaceholder'),
            validateInput: (v) => {
                if (!v.trim()) return lm.getString('profile.wizard.nameRequired');
                if (v.length > MAX_NAME) return lm.getString('profile.wizard.nameTooLong').replace('{0}', String(MAX_NAME));
                return undefined;
            }
        });
        if (!name) return;

        // Step 2/4: Role
        const role = await vscode.window.showInputBox({
            prompt: lm.getString('profile.wizard.stepRolePrompt'),
            placeHolder: lm.getString('profile.wizard.rolePlaceholder'),
            validateInput: (v) => {
                if (!v.trim()) return lm.getString('profile.wizard.roleRequired');
                if (v.length > MAX_ROLE) return lm.getString('profile.wizard.roleTooLong').replace('{0}', String(MAX_ROLE));
                return undefined;
            }
        });
        if (!role) return;

        // Step 3/4: Personality / system prompt
        const personality = await vscode.window.showInputBox({
            prompt: lm.getString('profile.wizard.stepPersonalityPrompt'),
            placeHolder: lm.getString('profile.wizard.personalityPlaceholder'),
            validateInput: (v) => {
                if (!v.trim()) return lm.getString('profile.wizard.personalityRequired');
                if (v.length > MAX_PERSONALITY) return lm.getString('profile.wizard.personalityTooLong').replace('{0}', String(MAX_PERSONALITY));
                return undefined;
            }
        });
        if (!personality) return;

        // Step 4/4: Optional capsules
        const registry = ProfileRegistry.getInstance();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const capsulesDir = path.join(workspaceRoot, '.harmony', 'capsules');
        let availableCapsules: string[] = [];
        try {
            const entries = await fsPromises.readdir(capsulesDir);
            availableCapsules = entries.filter(e => e.endsWith('.md'));
        } catch { /* no capsules yet */ }

        let selectedCapsules: string[] = [];
        if (availableCapsules.length > 0) {
            const picks = await vscode.window.showQuickPick(
                availableCapsules.map(c => ({ label: c, picked: false })),
                { canPickMany: true, placeHolder: lm.getString('profile.wizard.capsulesStep') }
            );
            if (picks) selectedCapsules = picks.map(p => p.label);
        }

        // Generate YAML — sanitize ID: only lowercase alphanumeric + underscores
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'profile';
        const capsulesYaml = selectedCapsules.length > 0
            ? '\nknowledge_capsules:\n' + selectedCapsules.map(c => `  - ${c}`).join('\n')
            : '';
        const yaml = `id: ${id}
name: ${name}
role: ${role}
personality: |
  ${personality.replace(/\n/g, '\n  ')}${capsulesYaml}
`;

        // Save to .harmony/profiles/ — validate path stays within workspace
        const profilesDir = path.join(workspaceRoot, '.harmony', 'profiles');
        await fsPromises.mkdir(profilesDir, { recursive: true });
        const resolvedProfilesDir = path.resolve(profilesDir);
        const filePath = path.join(profilesDir, `${id}.yaml`);
        // Security: prevent path traversal — resolved path must stay within profilesDir
        if (path.resolve(filePath).indexOf(resolvedProfilesDir) !== 0) {
            vscode.window.showErrorMessage(lm.getString('profile.wizard.invalidPath'));
            return;
        }
        await fsPromises.writeFile(filePath, yaml, 'utf-8');

        // Reload and refresh
        await registry.loadAll();
        if (this.view) this.view.webview.html = this.renderShell(this.view.webview);

        vscode.window.showInformationMessage(lm.getString('profile.wizard.created').replace('{0}', name).replace('{1}', id));
    }

}

export function registerHarmonyView(context: vscode.ExtensionContext): HarmonyViewProvider {
    // Register refresh command so cleanup and other commands can trigger a sidebar refresh
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.refreshSidebar', () => {
            vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
        })
    );
    const provider = new HarmonyViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(HarmonyViewProvider.viewId, provider),
        provider
    );
    return provider;
}
