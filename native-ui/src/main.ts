import './styles.css';

const DEFAULT_BACKEND = 'http://127.0.0.1:8788';
const STORAGE_KEY = 'harmony.native.backendUrl';
const REFRESH_MS = 2500;
const MAX_OFFLINE_POLLS = 3;
const LAUNCH_BACKEND = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_HARMONY_NATIVE_BACKEND_URL;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing app root.');
const appRoot = app;

type HealthState = {
  status?: string;
  warnings?: string[];
  blocks?: string[];
};

type SurfaceRecord = {
  surface?: string;
  pid?: string | number;
  status?: string;
  processAlive?: boolean;
  ageMs?: number;
  label?: string;
};

type LockRecord = {
  file?: string;
  operation?: string;
  resource?: string;
  expired?: boolean;
  expiresAt?: string;
};

type OperationRecord = {
  timestamp?: string;
  status?: string;
  label?: string;
  kind?: string;
};

type ProviderRecord = {
  provider?: string;
  configured?: boolean;
  executable?: boolean;
  credentialName?: string;
  credentialSource?: string;
  defaultModel?: string;
  lastLatencyMs?: number;
};

type SnapshotRecord = {
  id?: string;
  createdAt?: string;
  fileCount?: number;
  copied?: number;
  skipped?: number;
  coverage?: string;
  reason?: string;
  restoreCommand?: string;
};

type SwarmSwitchRecord = {
  key?: string;
  label?: string;
  defaultValue?: unknown;
  failClosed?: boolean;
  enabledByDefault?: boolean;
};

type SwarmDefaultStatus = {
  mode?: string;
  provider?: string;
  tier?: string;
  riskySwitchCount?: number;
  riskySwitchesOnByDefault?: string[];
  riskySwitchesOffByDefault?: string[];
  source?: string;
  liveSettingsNote?: string;
};

type OutsidePolicy = {
  mode?: string;
  permissions?: Record<string, unknown>;
  budgets?: Record<string, unknown>;
};

type BrokerState = {
  pending?: Array<{ id?: string; provider?: string; tier?: string; status?: string; age?: string }>;
  responses?: unknown[];
  processed?: unknown[];
  noVsCodeBehavior?: string;
};

type SmokeReportRecord = {
  id?: string;
  createdAt?: string;
  status?: string;
  passed?: number;
  failed?: number;
  path?: string;
};

type CrossSurfaceState = {
  expectedVersion?: string;
  installedEditors?: Array<{ editor?: string; installed?: boolean; version?: string; matchesExpected?: boolean; extensionPath?: string }>;
  bundledHub?: { exists?: boolean; version?: string; path?: string; error?: string };
  nativeBackend?: { url?: string; healthUrl?: string; online?: boolean; source?: string; error?: string };
  broker?: { pending?: number; responses?: number; processed?: number; noVsCodeBehavior?: string };
  secretStore?: { storedProviders?: number; totalProviders?: number };
  safetySwitches?: { failClosed?: number; total?: number; allFailClosed?: boolean };
};

type HarmonyState = {
  generatedAt?: string;
  cliVersion?: string;
  workspace?: string;
  hub?: { online?: boolean; url?: string };
  hubSupervisor?: { online?: boolean; error?: string; response?: { locks?: unknown[]; active?: number; stale?: number } };
  supervisor?: { active?: number; stale?: number; heartbeats?: SurfaceRecord[] };
  locks?: LockRecord[];
  managedProcesses?: unknown[];
  operationLedger?: { entries?: OperationRecord[] };
  providerStatus?: ProviderRecord[];
  providerSecrets?: Array<{ provider?: string; stored?: boolean; encryption?: string; updatedAt?: string; importedFromEnv?: string }>;
  outsidePolicy?: OutsidePolicy | null;
  snapshots?: SnapshotRecord[];
  broker?: BrokerState;
  smokeReports?: SmokeReportRecord[];
  swarmSafetySwitches?: SwarmSwitchRecord[];
  swarmDefaultStatus?: SwarmDefaultStatus;
  crossSurface?: CrossSurfaceState;
  health?: HealthState;
};

type NativeActionReceipt = {
  id?: string;
  path?: string;
  expiresAt?: string;
  status?: string;
  ledgerEntryId?: string;
  previewReceiptId?: string;
};

type ReleaseReceiptPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  vsix?: { path?: string; exists?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type ReleaseReceiptAction = {
  ok?: boolean;
  mode?: string;
  preview?: ReleaseReceiptPreview;
  executeReceipt?: NativeActionReceipt;
  receipt?: { status?: string; reportPath?: string; checks?: Array<{ name?: string; status?: string; detail?: string }> };
  reportPath?: string;
  error?: string;
};

type PrivacyScanPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  vsix?: { path?: string; exists?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type PrivacyScanAction = {
  ok?: boolean;
  mode?: string;
  preview?: PrivacyScanPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { status?: string; reportPath?: string; pathIssues?: unknown[]; contentIssues?: unknown[]; extractedFileCount?: number };
  reportPath?: string;
  error?: string;
};

type DiagnosticsPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type DiagnosticsAction = {
  ok?: boolean;
  mode?: string;
  preview?: DiagnosticsPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; recommendations?: string[]; recommendationsCount?: number; state?: HarmonyState };
  reportPath?: string;
  error?: string;
};

type SnapshotDrillPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  path?: string;
  target?: { path?: string; allowed?: boolean; exists?: boolean; reason?: string };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type SnapshotDrillAction = {
  ok?: boolean;
  mode?: string;
  preview?: SnapshotDrillPreview;
  executeReceipt?: NativeActionReceipt;
  drill?: { status?: string; path?: string; snapshotId?: string; manifestPath?: string; restored?: boolean; cleanedUp?: boolean; error?: string };
  reportPath?: string;
  error?: string;
};

type NativeFileWriteContract = {
  status?: string;
  target?: { path?: string; extension?: string; exists?: boolean; isFile?: boolean; reason?: string };
  content?: { chars?: number; sha256?: string };
  policy?: { writeFiles?: boolean; mode?: string };
  authority?: { sourceFileWrites?: boolean; terminalCommands?: boolean; providerCalls?: boolean; gitMutations?: boolean; chatDeletion?: boolean };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  notes?: string[];
};

type NativeFileWritePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { status?: string; path?: string; contentChars?: number; writeFiles?: boolean; snapshotRequired?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: NativeFileWriteContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeFileWriteAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeFileWritePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: NativeFileWriteContract; write?: { performed?: boolean; path?: string; contentChars?: number; contentSha256?: string }; snapshot?: { id?: string; manifestPath?: string; fileCount?: number } };
  reportPath?: string;
  error?: string;
};

type SourceWritePreflightContract = {
  status?: string;
  target?: { path?: string; extension?: string; exists?: boolean; isFile?: boolean; beforeSha256?: string };
  proposedContent?: { chars?: number; sha256?: string };
  diffPreview?: { changed?: boolean; removedLines?: number; addedLines?: number; preview?: string; truncated?: boolean };
  validationPlan?: { command?: string; sha256?: string; executionAuthority?: boolean };
  snapshotPlan?: { requiredBeforeExecute?: boolean; targetPath?: string; reason?: string };
  rollbackPlan?: { requiresSnapshotIdFromFutureExecute?: boolean; restoreCommandTemplate?: string };
  git?: { insideWorkTree?: boolean; branch?: string; head?: string; statusCount?: number; warning?: string };
  authority?: { reportWritesOnly?: boolean; sourceWritePreflight?: boolean; sourceFileWrites?: boolean; terminalCommands?: boolean; providerCalls?: boolean; gitMutations?: boolean; packageInstall?: boolean; editorReload?: boolean; chatDeletion?: boolean };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  requiredBeforeSourceWriteExecute?: string[];
  notes?: string[];
};

type SourceWritePreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { status?: string; path?: string; proposedContentChars?: number; removedLines?: number; addedLines?: number; sourceFileWrites?: boolean; reportOnly?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: SourceWritePreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type SourceWritePreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: SourceWritePreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: SourceWritePreflightContract; write?: { performed?: boolean; reason?: string }; providerCall?: { performed?: boolean; reason?: string }; terminalCommand?: { performed?: boolean; reason?: string } };
  reportPath?: string;
  error?: string;
};

type SourceWriteExecuteContract = SourceWritePreflightContract & {
  posture?: string;
  preflight?: { reportPath?: string; digest?: string; fresh?: boolean };
  authority?: { sourceWriteExecute?: boolean; sourceFileWrites?: boolean; terminalCommands?: boolean; providerCalls?: boolean; gitMutations?: boolean; packageInstall?: boolean; editorReload?: boolean; chatDeletion?: boolean };
};

type SourceWriteExecutePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { status?: string; path?: string; proposedContentChars?: number; sourceFileWrites?: boolean; snapshotRequired?: boolean; lockRequired?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: SourceWriteExecuteContract;
  previewReceipt?: NativeActionReceipt;
};

type SourceWriteExecuteAction = {
  ok?: boolean;
  mode?: string;
  preview?: SourceWriteExecutePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: SourceWriteExecuteContract; write?: { performed?: boolean; path?: string; contentChars?: number; contentSha256?: string }; snapshot?: { id?: string; manifestPath?: string; fileCount?: number }; providerCall?: { performed?: boolean; reason?: string }; terminalCommand?: { performed?: boolean; reason?: string }; gitMutation?: { performed?: boolean; reason?: string } };
  reportPath?: string;
  error?: string;
};

type PolicyReportPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  policy?: { path?: string; exists?: boolean; mode?: string; permissions?: Record<string, unknown>; budgets?: Record<string, unknown> };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type PolicyReportAction = {
  ok?: boolean;
  mode?: string;
  preview?: PolicyReportPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; exists?: boolean; policy?: OutsidePolicy; defaultPolicy?: OutsidePolicy; notes?: string[] };
  reportPath?: string;
  error?: string;
};

type BrokerProviderReportPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { brokerPending?: number; brokerResponses?: number; brokerProcessed?: number; configuredProviders?: number; totalProviders?: number; storedSecrets?: number; totalSecrets?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type BrokerProviderReportAction = {
  ok?: boolean;
  mode?: string;
  preview?: BrokerProviderReportPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; broker?: BrokerState; providerStatus?: ProviderRecord[]; providerSecrets?: HarmonyState['providerSecrets']; crossSurface?: HarmonyState['crossSurface']; notes?: string[] };
  reportPath?: string;
  error?: string;
};

type GitSafetyReportPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { insideWorkTree?: boolean; branch?: string; head?: string; statusCount?: number; unstagedCount?: number; stagedCount?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type GitSafetyReportAction = {
  ok?: boolean;
  mode?: string;
  preview?: GitSafetyReportPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; metadata?: { insideWorkTree?: boolean; branch?: string; head?: string; statusCount?: number; unstagedCount?: number; stagedCount?: number; status?: string[]; diffStats?: string[]; stagedDiffStats?: string[]; notes?: string[] } };
  reportPath?: string;
  error?: string;
};

type TerminalCommandReportPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { policyMode?: string; runCommands?: boolean; maxCommandSeconds?: number; terminalAskReceipts?: number; activeLocks?: number; recentOperations?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type TerminalCommandReportAction = {
  ok?: boolean;
  mode?: string;
  preview?: TerminalCommandReportPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; policy?: { mode?: string; permissions?: Record<string, unknown>; budgets?: Record<string, unknown> }; terminalAskReceipts?: unknown[]; locks?: unknown[]; recentOperations?: unknown[]; smokeReports?: unknown[]; environment?: { platform?: string; arch?: string; nodeMajor?: number; envNames?: Array<{ name?: string; present?: boolean; valueIncluded?: boolean }> } };
  reportPath?: string;
  error?: string;
};

type SelfHealingReportPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { readiness?: string; warnings?: number; sourceRoot?: string; toolCount?: number; vsixExists?: boolean; installedMatches?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type SelfHealingReportAction = {
  ok?: boolean;
  mode?: string;
  preview?: SelfHealingReportPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; metadata?: { package?: { version?: string; harmonyToolCount?: number }; readiness?: { status?: string; warnings?: string[] }; compiledOutput?: { exists?: boolean; sourceNewerThanOutput?: boolean }; vsix?: { exists?: boolean; path?: string }; installedEditors?: Array<{ editor?: string; version?: string; matchesExpected?: boolean }> } };
  reportPath?: string;
  error?: string;
};

type SelfHealingGateContract = {
  posture?: string;
  mutationStatus?: string;
  allowedFutureActions?: string[];
  blockedAuthorityClasses?: string[];
  requiredBeforeMutation?: string[];
  notes?: string[];
};

type SelfHealingGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; readiness?: string; blockedAuthorityClasses?: number };
  summary?: { readiness?: string; warnings?: number; allowedFutureActions?: number; blockedAuthorityClasses?: number; requiredBeforeMutation?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: SelfHealingGateContract;
  previewReceipt?: NativeActionReceipt;
};

type SelfHealingGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: SelfHealingGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; contract?: SelfHealingGateContract; metadata?: { readiness?: { status?: string; warnings?: string[] } } };
  reportPath?: string;
  error?: string;
};

type SelfHealingPackagePreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { kind?: string; commandCount?: number; commandsDigest?: string; vsix?: string; installedEditorVersions?: string[] };
  summary?: { readiness?: string; warnings?: number; commandCount?: number; lockPath?: string; installs?: boolean; reloadsEditors?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  commands?: Array<{ name?: string; commandLine?: string; timeoutSeconds?: number }>;
  previewReceipt?: NativeActionReceipt;
};

type SelfHealingPackagePreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: SelfHealingPackagePreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; packageVersion?: string; lock?: { path?: string }; rollback?: { existed?: boolean; backupPath?: string }; commands?: Array<{ name?: string; exitCode?: number; commandLine?: string }>; notes?: string[] };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleContract = {
  posture?: string;
  vscodeRole?: string;
  currentStatus?: string;
  requiredBeforeStartStop?: string[];
  blockedAuthorityClasses?: string[];
};

type NativeLifecycleReportPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  summary?: { posture?: string; currentStatus?: string; activeHeartbeats?: number; staleHeartbeats?: number; tauriWindow?: string };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: NativeLifecycleContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleReportAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleReportPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; metadata?: { backend?: { expectedUrl?: string; healthEndpoint?: string }; tauri?: { productName?: string; mainWindow?: { title?: string } }; supervisor?: { active?: number; stale?: number }; lifecycleContract?: NativeLifecycleContract } };
  reportPath?: string;
  error?: string;
};

type NativeLifecyclePreflightCheck = {
  name?: string;
  status?: string;
  detail?: string;
};

type NativeLifecyclePreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { kind?: string; lockPath?: string; reportPath?: string; checks?: number; checksDigest?: string; authority?: string };
  summary?: { posture?: string; currentStatus?: string; activeHeartbeats?: number; staleHeartbeats?: number; tauriWindow?: string; blockedAuthorityClasses?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: NativeLifecycleContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecyclePreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecyclePreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; lock?: { path?: string }; lockRelease?: { released?: boolean; path?: string; reason?: string; error?: string }; checks?: NativeLifecyclePreflightCheck[]; notes?: string[] };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleStartGateContract = {
  posture?: string;
  startStatus?: string;
  currentLifecycle?: { backend?: string; activeHeartbeats?: number; staleHeartbeats?: number; tauriWindow?: string };
  latestPreflight?: { path?: string; status?: string; version?: string; checks?: number };
  allowedFutureActions?: string[];
  requiredBeforeStart?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleStartGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; startCurrentlyAllowed?: boolean; latestPreflightStatus?: string };
  summary?: { posture?: string; startStatus?: string; requiredBeforeStart?: number; blockedAuthorityClasses?: number; latestPreflightStatus?: string };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: NativeLifecycleStartGateContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleStartGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleStartGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; contract?: NativeLifecycleStartGateContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleStopGateContract = {
  posture?: string;
  stopStatus?: string;
  currentLifecycle?: { backend?: string; activeHeartbeats?: number; staleHeartbeats?: number; managedProcesses?: number };
  latestPreflight?: { path?: string; status?: string; version?: string; checks?: number };
  latestStartGate?: { path?: string; posture?: string; version?: string };
  allowedFutureActions?: string[];
  requiredBeforeStop?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleStopGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; stopCurrentlyAllowed?: boolean; latestPreflightStatus?: string };
  summary?: { posture?: string; stopStatus?: string; requiredBeforeStop?: number; blockedAuthorityClasses?: number; latestPreflightStatus?: string };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: NativeLifecycleStopGateContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleStopGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleStopGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; contract?: NativeLifecycleStopGateContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleReconnectGateContract = {
  posture?: string;
  reconnectStatus?: string;
  currentLifecycle?: { backend?: string; healthEndpoint?: string; activeHeartbeats?: number; staleHeartbeats?: number; managedProcesses?: number };
  healthProbe?: { status?: string; statusCode?: number; endpoint?: string; workspace?: string; workspaceMatches?: boolean; heartbeatPath?: string; error?: string };
  latestPreflight?: { path?: string; status?: string; version?: string; checks?: number };
  latestStartGate?: { path?: string; posture?: string; version?: string };
  latestStopGate?: { path?: string; posture?: string; version?: string };
  allowedFutureActions?: string[];
  requiredBeforeReconnect?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleReconnectGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; reconnectCurrentlyAllowed?: boolean; latestPreflightStatus?: string; healthProbeStatus?: string };
  summary?: { posture?: string; reconnectStatus?: string; healthProbeStatus?: string; requiredBeforeReconnect?: number; blockedAuthorityClasses?: number; latestPreflightStatus?: string };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: NativeLifecycleReconnectGateContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleReconnectGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleReconnectGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; contract?: NativeLifecycleReconnectGateContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleStartPreflightCheck = { name?: string; status?: string; detail?: string };

type NativeLifecycleStartPreflightContract = {
  posture?: string;
  startPreflightStatus?: string;
  startStatus?: string;
  commandPlan?: { executable?: string; script?: string; cwd?: string; display?: string; digest?: string; mutableUserInput?: boolean };
  portPlan?: { status?: string; host?: string; port?: number; ownership?: string; portProbe?: { status?: string; error?: string } };
  healthProbe?: { status?: string; statusCode?: number; endpoint?: string; workspace?: string; workspaceMatches?: boolean; heartbeatPath?: string; error?: string };
  latestPreflight?: { path?: string; status?: string; version?: string; checks?: number };
  latestStartGate?: { path?: string; posture?: string; version?: string };
  latestStopGate?: { path?: string; posture?: string; version?: string };
  latestReconnectGate?: { path?: string; posture?: string; version?: string; healthProbeStatus?: string };
  checks?: NativeLifecycleStartPreflightCheck[];
  requiredBeforeStartExecute?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleStartPreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; startExecuteCurrentlyAllowed?: boolean; startPreflightStatus?: string; portPlanStatus?: string; commandDigest?: string };
  summary?: { posture?: string; startPreflightStatus?: string; portPlanStatus?: string; healthProbeStatus?: string; fixedCommandDigest?: string; checksPassed?: number; checks?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: NativeLifecycleStartPreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleStartPreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleStartPreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; lockRelease?: { released?: boolean }; contract?: NativeLifecycleStartPreflightContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleStopPreflightCheck = { name?: string; status?: string; detail?: string };

type NativeLifecycleStopPreflightContract = {
  posture?: string;
  stopPreflightStatus?: string;
  stopStatus?: string;
  stopPlan?: { method?: string; healthEndpoint?: string; digest?: string; killAllowed?: boolean; restartAllowed?: boolean; arbitraryPidInputAllowed?: boolean };
  targetPlan?: { status?: string; ownership?: string; activeHeartbeats?: number; staleHeartbeats?: number; managedProcesses?: number };
  portProbe?: { status?: string; error?: string };
  healthProbe?: { status?: string; statusCode?: number; endpoint?: string; workspace?: string; workspaceMatches?: boolean; heartbeatPath?: string; error?: string };
  latestPreflight?: { path?: string; status?: string; version?: string; checks?: number };
  latestStopGate?: { path?: string; posture?: string; version?: string };
  latestStartPreflight?: { path?: string; status?: string; version?: string; portPlanStatus?: string };
  checks?: NativeLifecycleStopPreflightCheck[];
  requiredBeforeStopExecute?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleStopPreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; stopExecuteCurrentlyAllowed?: boolean; stopPreflightStatus?: string; targetPlanStatus?: string; stopPlanDigest?: string };
  summary?: { posture?: string; stopPreflightStatus?: string; targetPlanStatus?: string; healthProbeStatus?: string; stopPlanDigest?: string; checksPassed?: number; checks?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: NativeLifecycleStopPreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleStopPreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleStopPreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; lockRelease?: { released?: boolean }; contract?: NativeLifecycleStopPreflightContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleStopExecutePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; stopExecuteStatus?: string; stopPlanDigest?: string; targets?: number };
  summary?: { posture?: string; stopExecuteStatus?: string; targets?: string[]; authority?: Record<string, unknown> };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: { stopExecuteStatus?: string; stopPlan?: { digest?: string; healthEndpoint?: string }; targets?: Array<{ kind?: string; pid?: number; processAlive?: boolean }>; checks?: Array<{ name?: string; status?: string; detail?: string }> };
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleStopExecuteAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleStopExecutePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; error?: string; contractBefore?: NativeLifecycleStopExecutePreview['contract']; result?: { status?: string; postHealth?: { status?: string; endpoint?: string; error?: string }; results?: Array<{ kind?: string; pid?: number; status?: string; afterAlive?: boolean; deferredSelfStop?: boolean }> } };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleReconnectPreflightCheck = { name?: string; status?: string; detail?: string };

type NativeLifecycleReconnectPreflightContract = {
  posture?: string;
  reconnectPreflightStatus?: string;
  reconnectStatus?: string;
  reconnectPlan?: { method?: string; healthEndpoint?: string; digest?: string; spawnAllowed?: boolean; stopAllowed?: boolean; arbitraryUrlInputAllowed?: boolean };
  reconnectTarget?: { status?: string; ownership?: string; activeHeartbeats?: number; staleHeartbeats?: number };
  portProbe?: { status?: string; error?: string };
  healthProbe?: { status?: string; statusCode?: number; endpoint?: string; workspace?: string; workspaceMatches?: boolean; heartbeatPath?: string; error?: string };
  latestPreflight?: { path?: string; status?: string; version?: string; checks?: number };
  latestReconnectGate?: { path?: string; posture?: string; version?: string; healthProbeStatus?: string };
  latestStartPreflight?: { path?: string; status?: string; version?: string };
  latestStopPreflight?: { path?: string; status?: string; version?: string };
  checks?: NativeLifecycleReconnectPreflightCheck[];
  requiredBeforeReconnectExecute?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleReconnectPreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; reconnectExecuteCurrentlyAllowed?: boolean; reconnectPreflightStatus?: string; reconnectTargetStatus?: string; reconnectPlanDigest?: string };
  summary?: { posture?: string; reconnectPreflightStatus?: string; reconnectTargetStatus?: string; healthProbeStatus?: string; reconnectPlanDigest?: string; checksPassed?: number; checks?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: NativeLifecycleReconnectPreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleReconnectPreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleReconnectPreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; lockRelease?: { released?: boolean }; contract?: NativeLifecycleReconnectPreflightContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleRestartPreflightCheck = { name?: string; status?: string; detail?: string };

type NativeLifecycleRestartPreflightContract = {
  posture?: string;
  restartPreflightStatus?: string;
  restartStatus?: string;
  restartPlan?: { method?: string; healthEndpoint?: string; digest?: string; stopPlanDigest?: string; startCommandDigest?: string; forceKillAllowed?: boolean; arbitraryPidInputAllowed?: boolean; arbitraryCommandInputAllowed?: boolean };
  recovery?: { mode?: string; canStopThenStart?: boolean; canStartOnlyRecover?: boolean; activeHeartbeats?: number; staleHeartbeats?: number; managedProcesses?: number };
  portProbe?: { status?: string; error?: string };
  healthProbe?: { status?: string; statusCode?: number; endpoint?: string; workspace?: string; workspaceMatches?: boolean; heartbeatPath?: string; error?: string };
  checks?: NativeLifecycleRestartPreflightCheck[];
  requiredBeforeRestartExecute?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleRestartPreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; restartExecuteCurrentlyAllowed?: boolean; restartPreflightStatus?: string; recoveryMode?: string; restartPlanDigest?: string };
  summary?: { posture?: string; restartPreflightStatus?: string; recoveryMode?: string; healthProbeStatus?: string; restartPlanDigest?: string; checksPassed?: number; checks?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: NativeLifecycleRestartPreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleRestartPreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleRestartPreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; lockRelease?: { released?: boolean }; contract?: NativeLifecycleRestartPreflightContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleRestartExecuteGateContract = {
  posture?: string;
  restartExecuteGateStatus?: string;
  restartExecuteStatus?: string;
  latestRestartPreflight?: { path?: string; status?: string; version?: string; restartPlanDigest?: string; recoveryMode?: string };
  proposedFutureExecute?: { mode?: string; restartPlanDigest?: string; forceKillAllowed?: boolean; arbitraryPidInputAllowed?: boolean; arbitraryCommandInputAllowed?: boolean; installAllowed?: boolean; editorReloadAllowed?: boolean };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  requiredBeforeRestartExecute?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleRestartExecuteGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; restartExecuteCurrentlyAllowed?: boolean; restartExecuteGateStatus?: string; recoveryMode?: string; restartPlanDigest?: string };
  summary?: { posture?: string; restartExecuteGateStatus?: string; recoveryMode?: string; restartPlanDigest?: string; checksPassed?: number; checks?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: NativeLifecycleRestartExecuteGateContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleRestartExecuteGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleRestartExecuteGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: NativeLifecycleRestartExecuteGateContract };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleRestartExecuteContract = {
  posture?: string;
  restartExecuteStatus?: string;
  recoveryMode?: string;
  restartPlan?: { digest?: string; stopPlanDigest?: string; startCommandDigest?: string };
  currentHealthProbe?: { status?: string; endpoint?: string; workspaceMatches?: boolean; error?: string };
  currentPortProbe?: { status?: string; host?: string; port?: number; error?: string };
  latestRestartPreflight?: { path?: string; status?: string; version?: string; restartPlanDigest?: string; recoveryMode?: string };
  latestRestartExecuteGate?: { path?: string; status?: string; version?: string; restartPlanDigest?: string; recoveryMode?: string };
  stopExecuteContract?: { stopExecuteStatus?: string; targets?: Array<{ kind?: string; pid?: number; processAlive?: boolean }>; checks?: Array<{ name?: string; status?: string; detail?: string }> };
  daemonStartContract?: { startExecuteStatus?: string; portPlan?: { status?: string; host?: string; port?: number }; checks?: Array<{ name?: string; status?: string; detail?: string }> };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  authority?: Record<string, unknown>;
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type NativeLifecycleRestartExecutePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; restartExecuteStatus?: string; recoveryMode?: string; restartPlanDigest?: string; stopTargets?: number };
  summary?: { posture?: string; restartExecuteStatus?: string; recoveryMode?: string; restartPlanDigest?: string; healthProbeStatus?: string; authority?: Record<string, unknown> };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: NativeLifecycleRestartExecuteContract;
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleRestartExecuteAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleRestartExecutePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; error?: string; lock?: { token?: string; path?: string }; lockRelease?: { released?: boolean }; contractBefore?: NativeLifecycleRestartExecuteContract; result?: { mode?: string; status?: string; preHealth?: { status?: string }; postHealth?: { status?: string; endpoint?: string; error?: string }; stop?: { exitCode?: number; report?: { status?: string } }; start?: { exitCode?: number; report?: { status?: string } }; fallback?: string } };
  reportPath?: string;
  error?: string;
};

type NativeLifecycleReconnectExecutePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; reconnectExecuteStatus?: string; backendUrl?: string; reconnectPlanDigest?: string };
  summary?: { posture?: string; reconnectExecuteStatus?: string; healthProbeStatus?: string; authority?: Record<string, unknown> };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  guards?: string[];
  contract?: { reconnectExecuteStatus?: string; reconnectPlan?: { digest?: string; healthEndpoint?: string }; backend?: { url?: string; healthProbe?: { status?: string; endpoint?: string; heartbeatPath?: string } }; checks?: Array<{ name?: string; status?: string; detail?: string }>; fallback?: string };
  previewReceipt?: NativeActionReceipt;
};

type NativeLifecycleReconnectExecuteAction = {
  ok?: boolean;
  mode?: string;
  preview?: NativeLifecycleReconnectExecutePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; error?: string; contractBefore?: NativeLifecycleReconnectExecutePreview['contract']; result?: { mode?: string; pid?: number }; owner?: { backendUrl?: string; pid?: number; processAlive?: boolean }; managedProcess?: { path?: string; status?: string } };
  reportPath?: string;
  error?: string;
};

type FloatingChatNotePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { kind?: string; messageHash?: string; messageChars?: number; status?: string };
  summary?: { messageChars?: number; messageHash?: string; status?: string };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatNoteAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatNotePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; message?: { chars?: number; sha256?: string }; retention?: { deletePolicy?: string } };
  reportPath?: string;
  error?: string;
};

type FloatingChatTurnPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { kind?: string; conversationId?: string; messageHash?: string; messageChars?: number; responseAuthority?: string; status?: string };
  summary?: { conversationId?: string; messageChars?: number; messageHash?: string; status?: string };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatTurnAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatTurnPreview;
  executeReceipt?: NativeActionReceipt;
  report?: {
    reportPath?: string;
    conversation?: { id?: string; path?: string; created?: boolean; turnCount?: number };
    turn?: { id?: string; message?: { chars?: number; sha256?: string }; response?: { status?: string; providerCall?: string; toolExecution?: string } };
    responseRequest?: { status?: string; path?: string; requiredBeforeResponse?: string[] };
    retention?: { deletePolicy?: string };
  };
  reportPath?: string;
  error?: string;
};

type FloatingChatResponseGateContract = {
  posture?: string;
  requestedConversationId?: string;
  latestResponseRequest?: { file?: string; path?: string; generatedAt?: string; conversationId?: string; turnId?: string; status?: string };
  providerDisclosure?: { configuredProviders?: number; totalProviders?: number; secretValuesIncluded?: boolean };
  responseExecuteCurrentlyAllowed?: boolean;
  requiredBeforeResponseExecute?: string[];
  blockedAuthorityClasses?: string[];
  checks?: { name?: string; status?: string; detail?: string }[];
  notes?: string[];
};

type FloatingChatResponseGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { kind?: string; posture?: string; requestedConversationId?: string; latestResponseRequestFile?: string; responseExecuteCurrentlyAllowed?: boolean; configuredProviders?: number };
  summary?: { posture?: string; responseRequestStatus?: string; configuredProviders?: number; totalProviders?: number; responseExecuteCurrentlyAllowed?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatResponseGateContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatResponseGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatResponseGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatResponseGateContract };
  reportPath?: string;
  error?: string;
};

type FloatingChatResponsePreflightContract = FloatingChatResponseGateContract & {
  status?: string;
  latestResponseGate?: { file?: string; path?: string; status?: string; posture?: string };
  policy?: { mode?: string; paidProviderCalls?: boolean; beforePaidProvider?: boolean; maxEstimatedUsd?: number };
  providerDisclosure?: { configuredProviders?: number; executableConfiguredProviders?: number; totalProviders?: number; secretValuesIncluded?: boolean };
  readyForFutureExecute?: boolean;
};

type FloatingChatResponsePreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { kind?: string; status?: string; requestedConversationId?: string; latestResponseRequestFile?: string; latestResponseGateFile?: string; responseExecuteCurrentlyAllowed?: boolean; readyForFutureExecute?: boolean };
  summary?: { status?: string; responseRequestStatus?: string; responseGateStatus?: string; paidProviderCalls?: boolean; executableConfiguredProviders?: number; responseExecuteCurrentlyAllowed?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatResponsePreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatResponsePreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatResponsePreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatResponsePreflightContract };
  reportPath?: string;
  error?: string;
};

type FloatingChatResponseExecuteContract = FloatingChatResponsePreflightContract & {
  provider?: { requestedProvider?: string; provider?: string; model?: string; maxTokens?: number; executable?: boolean; configured?: boolean; credentialSource?: string; credentialName?: string; secretValueIncluded?: boolean };
  prompt?: { chars?: number; sha256?: string; latestTurnChars?: number; recentTurnCount?: number };
  conversationPath?: string;
};

type FloatingChatResponseExecutePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { kind?: string; status?: string; conversationId?: string; turnId?: string; responseRequestFile?: string; responseGateFile?: string; provider?: string; model?: string; maxTokens?: number; promptHash?: string; responseExecuteCurrentlyAllowed?: boolean };
  summary?: { status?: string; provider?: string; model?: string; maxTokens?: number; promptHash?: string; paidProviderCalls?: boolean; budget?: number; responseExecuteCurrentlyAllowed?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatResponseExecuteContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatResponseExecuteAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatResponseExecutePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatResponseExecuteContract; providerCall?: { performed?: boolean; provider?: string; model?: string; credentialSource?: string; credentialName?: string; error?: string }; response?: { id?: string; message?: { text?: string; chars?: number; sha256?: string } }; conversation?: { id?: string; path?: string; turnCount?: number } };
  reportPath?: string;
  error?: string;
};

type FloatingChatToolExecuteContract = {
  posture?: string;
  toolExecuteStatus?: string;
  conversationId?: string;
  conversationPath?: string;
  latestToolPolicyGate?: { path?: string; status?: string; version?: string; posture?: string; reportOnlyAuthority?: boolean };
  tool?: { name?: string; path?: string; pattern?: string; maxChars?: number; maxMatches?: number; error?: string };
  authority?: { readOnlyWorkspaceInspection?: boolean; toolExecution?: boolean; sourceFileWrites?: boolean; terminalCommands?: boolean; providerCalls?: boolean; gitMutations?: boolean; packageInstall?: boolean; editorReload?: boolean; chatDeletion?: boolean };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  blockedAuthorityClasses?: string[];
  notes?: string[];
  digest?: string;
};

type FloatingChatToolExecutePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; conversationId?: string; tool?: string; path?: string; digest?: string };
  summary?: { status?: string; tool?: string; path?: string; policyGate?: string; readOnly?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatToolExecuteContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatToolExecuteAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatToolExecutePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatToolExecuteContract; toolExecution?: { performed?: boolean; tool?: string; path?: string; resultHash?: string; resultChars?: number; meta?: Record<string, unknown> }; conversation?: { id?: string; path?: string; turnCount?: number; toolTurnId?: string }; error?: string };
  reportPath?: string;
  error?: string;
};

type FloatingChatToolPreflightContract = {
  posture?: string;
  status?: string;
  conversationId?: string;
  conversationPath?: string;
  latestToolPolicyGate?: { path?: string; status?: string; version?: string; posture?: string; reportOnlyAuthority?: boolean };
  source?: { kind?: string; turnId?: string; chars?: number; sha256?: string };
  candidate?: { tool?: string; path?: string; pattern?: string; maxChars?: number; maxMatches?: number; sourceFormat?: string; reason?: string };
  authority?: { preflightOnly?: boolean; toolExecution?: boolean; sourceFileWrites?: boolean; terminalCommands?: boolean; providerCalls?: boolean; gitMutations?: boolean; packageInstall?: boolean; editorReload?: boolean; chatDeletion?: boolean };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  requiredBeforeToolExecution?: string[];
  notes?: string[];
  digest?: string;
};

type FloatingChatToolPreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; conversationId?: string; tool?: string; path?: string; digest?: string };
  summary?: { status?: string; source?: string; tool?: string; path?: string; policyGate?: string; toolExecution?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatToolPreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatToolPreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatToolPreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatToolPreflightContract; toolExecution?: { performed?: boolean; reason?: string }; providerCall?: { performed?: boolean; reason?: string } };
  reportPath?: string;
  error?: string;
};

type FloatingChatToolLoopPreflightContract = {
  posture?: string;
  status?: string;
  conversationId?: string;
  latestToolPolicyGate?: { path?: string; status?: string; version?: string; posture?: string; reportOnlyAuthority?: boolean };
  policy?: { autonomousLoops?: boolean; maxAutonomousSteps?: number; requestedMaxSteps?: number; effectiveMaxSteps?: number };
  source?: { kind?: string; turnId?: string; chars?: number; sha256?: string; truncated?: boolean };
  plannedSteps?: Array<{ index?: number; status?: string; tool?: string; path?: string; pattern?: string; reason?: string; requiresSeparateExecuteReceipt?: boolean }>;
  authority?: { preflightOnly?: boolean; loopExecution?: boolean; toolExecution?: boolean; sourceFileWrites?: boolean; terminalCommands?: boolean; providerCalls?: boolean; gitMutations?: boolean; packageInstall?: boolean; editorReload?: boolean; chatDeletion?: boolean };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  requiredBeforeLoopExecution?: string[];
  notes?: string[];
  digest?: string;
};

type FloatingChatToolLoopPreflightPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; conversationId?: string; plannedSteps?: number; digest?: string };
  summary?: { status?: string; source?: string; plannedSteps?: number; autonomousLoops?: boolean; maxAutonomousSteps?: number; loopExecution?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatToolLoopPreflightContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatToolLoopPreflightAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatToolLoopPreflightPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatToolLoopPreflightContract; toolExecution?: { performed?: boolean; reason?: string }; providerCall?: { performed?: boolean; reason?: string } };
  reportPath?: string;
  error?: string;
};

type FloatingChatToolLoopExecuteContract = {
  posture?: string;
  loopExecuteStatus?: string;
  conversationId?: string;
  policy?: { autonomousLoops?: boolean; maxAutonomousSteps?: number; requestedMaxSteps?: number; effectiveMaxSteps?: number; oneStepPerReceipt?: boolean; requestedStepIndex?: number; maxResultCharsPerStep?: number };
  source?: { kind?: string; turnId?: string; chars?: number; sha256?: string; truncated?: boolean };
  plannedStepCount?: number;
  selectedStep?: { index?: number; status?: string; tool?: { name?: string; path?: string; pattern?: string; maxChars?: number; maxMatches?: number }; reason?: string };
  authority?: { loopExecution?: boolean; readOnlyWorkspaceInspection?: boolean; toolExecution?: boolean; sourceFileWrites?: boolean; terminalCommands?: boolean; providerCalls?: boolean; gitMutations?: boolean; packageInstall?: boolean; editorReload?: boolean; chatDeletion?: boolean };
  preflightChecks?: Array<{ name?: string; status?: string; detail?: string }>;
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  stopConditions?: string[];
  notes?: string[];
  digest?: string;
};

type FloatingChatToolLoopExecutePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; conversationId?: string; stepIndex?: number; tool?: string; path?: string; digest?: string };
  summary?: { status?: string; plannedSteps?: number; stepIndex?: number; tool?: string; path?: string; readOnly?: boolean; oneStepPerReceipt?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatToolLoopExecuteContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatToolLoopExecuteAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatToolLoopExecutePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatToolLoopExecuteContract; loopExecution?: { performed?: boolean; executedSteps?: number; stepIndex?: number; stopped?: boolean; stopReason?: string }; toolExecution?: { performed?: boolean; tool?: string; path?: string; resultHash?: string; resultChars?: number; meta?: Record<string, unknown> }; providerCall?: { performed?: boolean; reason?: string }; conversation?: { id?: string; path?: string; turnCount?: number; toolTurnId?: string }; error?: string };
  reportPath?: string;
  error?: string;
};

type FloatingChatAutonomyNextContract = {
  posture?: string;
  status?: string;
  conversationId?: string;
  latestTurn?: { id?: string; role?: string; source?: string; messageSha256?: string; messageChars?: number };
  proposedNextAction?: { kind?: string; reason?: string; conversationId?: string; route?: string; plannedSteps?: number; requiresSeparateExecuteReceipt?: boolean };
  authority?: { reportWritesOnly?: boolean; providerCalls?: boolean; toolExecution?: boolean; sourceFileWrites?: boolean; terminalCommands?: boolean; gitMutations?: boolean; packageInstall?: boolean; editorReload?: boolean; chatDeletion?: boolean };
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  requiredBeforeAutonomousFollowUp?: string[];
  notes?: string[];
  digest?: string;
};

type FloatingChatAutonomyNextPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; status?: string; conversationId?: string; proposedNextAction?: string; digest?: string };
  summary?: { status?: string; proposedNextAction?: string; reason?: string; providerCalls?: boolean; toolExecution?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: FloatingChatAutonomyNextContract;
  previewReceipt?: NativeActionReceipt;
};

type FloatingChatAutonomyNextAction = {
  ok?: boolean;
  mode?: string;
  preview?: FloatingChatAutonomyNextPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: FloatingChatAutonomyNextContract; providerCall?: { performed?: boolean; reason?: string }; toolExecution?: { performed?: boolean; reason?: string } };
  reportPath?: string;
  error?: string;
};

type AutonomyCommitGateContract = {
  posture?: string;
  currentPermissions?: { autonomousLoops?: boolean; gitMutations?: boolean; runCommands?: boolean; writeFiles?: boolean };
  budgets?: { maxAutonomousSteps?: number; maxCommandSeconds?: number; maxEstimatedUsd?: number };
  repository?: { insideWorkTree?: boolean; branch?: string; statusCount?: number; stagedCount?: number; unstagedCount?: number };
  requiredBeforeAutonomy?: string[];
  requiredBeforeCommit?: string[];
  blockedAuthorityClasses?: string[];
  notes?: string[];
};

type AutonomyCommitGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; autonomousLoopsCurrentlyAllowed?: boolean; gitMutationsCurrentlyAllowed?: boolean };
  summary?: { posture?: string; autonomousLoops?: boolean; gitMutations?: boolean; requiredBeforeAutonomy?: number; requiredBeforeCommit?: number; blockedAuthorityClasses?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: AutonomyCommitGateContract;
  previewReceipt?: NativeActionReceipt;
};

type AutonomyCommitGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: AutonomyCommitGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; contract?: AutonomyCommitGateContract };
  reportPath?: string;
  error?: string;
};

type OutsideToolPolicyGateContract = {
  posture?: string;
  policy?: { exists?: boolean; mode?: string; permissions?: { autonomousLoops?: boolean; writeFiles?: boolean; runCommands?: boolean; paidProviderCalls?: boolean; gitMutations?: boolean }; budgets?: { maxAutonomousSteps?: number; maxCommandSeconds?: number; maxEstimatedUsd?: number } };
  repository?: { insideWorkTree?: boolean; branch?: string; statusCount?: number; stagedCount?: number; unstagedCount?: number };
  packageTools?: { count?: number; sample?: string[] };
  toolClasses?: Array<{ id?: string; label?: string; currentlyAllowed?: boolean; examples?: string[]; requirements?: string[] }>;
  requiredBeforeToolExecution?: string[];
  blockedAuthorityClasses?: string[];
  authority?: Record<string, unknown>;
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
  notes?: string[];
};

type OutsideToolPolicyGatePreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; policyMode?: string; toolClasses?: number };
  summary?: { posture?: string; policyExists?: boolean; toolCount?: number; writeFiles?: boolean; runCommands?: boolean; paidProviderCalls?: boolean; gitMutations?: boolean; reportOnlyAuthority?: boolean };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: OutsideToolPolicyGateContract;
  previewReceipt?: NativeActionReceipt;
};

type OutsideToolPolicyGateAction = {
  ok?: boolean;
  mode?: string;
  preview?: OutsideToolPolicyGatePreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: OutsideToolPolicyGateContract };
  reportPath?: string;
  error?: string;
};

type AutonomyDryRunStep = {
  proposalId?: string;
  proposalType?: string;
  title?: string;
  status?: string;
  stopReason?: string;
  targetPaths?: string[];
  estimatedCostUsd?: number;
  applied?: boolean;
};

type AutonomyDryRunContract = {
  posture?: string;
  decision?: string;
  policy?: { permissions?: { autonomousLoops?: boolean; writeFiles?: boolean; runCommands?: boolean; paidProviderCalls?: boolean; gitMutations?: boolean }; budgets?: { maxAutonomousSteps?: number; maxCommandSeconds?: number; maxEstimatedUsd?: number } };
  repository?: { insideWorkTree?: boolean; branch?: string; statusCount?: number; stagedCount?: number; unstagedCount?: number };
  swarm?: { requestedTurnId?: string; turnId?: string; planFound?: boolean; planPath?: string; planMode?: string; executionEnabled?: boolean; objective?: string; proposalCount?: number; selectedProposalIds?: string[]; requestedProposalIds?: string[] };
  limits?: { maxProposals?: number; maxSteps?: number; maxRuntimeSeconds?: number };
  simulatedSteps?: AutonomyDryRunStep[];
  checks?: Array<{ status?: string; name?: string; detail?: string }>;
  notes?: string[];
  digest?: string;
};

type AutonomyDryRunPreview = {
  action?: string;
  version?: string;
  workspace?: string;
  target?: { allowed?: boolean; kind?: string; decision?: string; planFound?: boolean; proposalCount?: number };
  summary?: { posture?: string; decision?: string; autonomousLoops?: boolean; maxAutonomousSteps?: number; proposalCount?: number; wouldRun?: number; blocked?: number };
  requiredConfirmation?: string;
  writes?: string[];
  checks?: string[];
  contract?: AutonomyDryRunContract;
  previewReceipt?: NativeActionReceipt;
};

type AutonomyDryRunAction = {
  ok?: boolean;
  mode?: string;
  preview?: AutonomyDryRunPreview;
  executeReceipt?: NativeActionReceipt;
  report?: { reportPath?: string; status?: string; contract?: AutonomyDryRunContract };
  reportPath?: string;
  error?: string;
};

let backendUrl = normalizeBackendUrl(initialBackendUrl());
let refreshTimer: number | undefined;
let offlinePolls = 0;
let latestState: HarmonyState | undefined;
let releaseReceiptAction: ReleaseReceiptAction | undefined;
let privacyScanAction: PrivacyScanAction | undefined;
let diagnosticsAction: DiagnosticsAction | undefined;
let snapshotDrillAction: SnapshotDrillAction | undefined;
let nativeFileWriteAction: NativeFileWriteAction | undefined;
let nativeFileWritePath = '';
let nativeFileWriteContent = '';
let sourceWritePreflightAction: SourceWritePreflightAction | undefined;
let sourceWritePreflightConversationId = '';
let sourceWritePreflightToolResultId = '';
let sourceWritePreflightTargetPath = '';
let sourceWritePreflightProposedContent = '';
let sourceWritePreflightValidationCommand = '';
let sourceWriteExecuteAction: SourceWriteExecuteAction | undefined;
let sourceWriteExecutePreflightReportPath = '';
let sourceWriteExecuteProposedContent = '';
let policyReportAction: PolicyReportAction | undefined;
let brokerProviderReportAction: BrokerProviderReportAction | undefined;
let gitSafetyReportAction: GitSafetyReportAction | undefined;
let terminalCommandReportAction: TerminalCommandReportAction | undefined;
let selfHealingReportAction: SelfHealingReportAction | undefined;
let selfHealingGateAction: SelfHealingGateAction | undefined;
let selfHealingPackagePreflightAction: SelfHealingPackagePreflightAction | undefined;
let nativeLifecycleReportAction: NativeLifecycleReportAction | undefined;
let nativeLifecyclePreflightAction: NativeLifecyclePreflightAction | undefined;
let nativeLifecycleStartGateAction: NativeLifecycleStartGateAction | undefined;
let nativeLifecycleStopGateAction: NativeLifecycleStopGateAction | undefined;
let nativeLifecycleReconnectGateAction: NativeLifecycleReconnectGateAction | undefined;
let nativeLifecycleStartPreflightAction: NativeLifecycleStartPreflightAction | undefined;
let nativeLifecycleStopPreflightAction: NativeLifecycleStopPreflightAction | undefined;
let nativeLifecycleStopExecuteAction: NativeLifecycleStopExecuteAction | undefined;
let nativeLifecycleReconnectPreflightAction: NativeLifecycleReconnectPreflightAction | undefined;
let nativeLifecycleRestartPreflightAction: NativeLifecycleRestartPreflightAction | undefined;
let nativeLifecycleRestartExecuteGateAction: NativeLifecycleRestartExecuteGateAction | undefined;
let nativeLifecycleRestartExecuteAction: NativeLifecycleRestartExecuteAction | undefined;
let nativeLifecycleReconnectExecuteAction: NativeLifecycleReconnectExecuteAction | undefined;
let floatingChatNoteAction: FloatingChatNoteAction | undefined;
let floatingChatDraft = '';
let floatingChatTurnAction: FloatingChatTurnAction | undefined;
let floatingChatTurnDraft = '';
let floatingChatConversationId = '';
let floatingChatResponseGateAction: FloatingChatResponseGateAction | undefined;
let floatingChatResponseGateConversationId = '';
let floatingChatResponsePreflightAction: FloatingChatResponsePreflightAction | undefined;
let floatingChatResponsePreflightConversationId = '';
let floatingChatResponseExecuteAction: FloatingChatResponseExecuteAction | undefined;
let floatingChatResponseExecuteConversationId = '';
let floatingChatResponseExecuteProvider = 'auto';
let floatingChatResponseExecuteModel = '';
let floatingChatResponseExecuteMaxTokens = '512';
let floatingChatToolPreflightAction: FloatingChatToolPreflightAction | undefined;
let floatingChatToolPreflightConversationId = '';
let floatingChatToolPreflightRequest = '';
let floatingChatToolLoopPreflightAction: FloatingChatToolLoopPreflightAction | undefined;
let floatingChatToolLoopPreflightConversationId = '';
let floatingChatToolLoopPreflightRequest = '';
let floatingChatToolLoopPreflightMaxSteps = '3';
let floatingChatToolLoopExecuteAction: FloatingChatToolLoopExecuteAction | undefined;
let floatingChatToolLoopExecuteConversationId = '';
let floatingChatToolLoopExecuteRequest = '';
let floatingChatToolLoopExecuteMaxSteps = '3';
let floatingChatToolLoopExecuteStepIndex = '1';
let floatingChatToolLoopExecuteMaxResultChars = '12000';
let floatingChatAutonomyNextAction: FloatingChatAutonomyNextAction | undefined;
let floatingChatAutonomyNextConversationId = '';
let floatingChatToolExecuteAction: FloatingChatToolExecuteAction | undefined;
let floatingChatToolExecuteConversationId = '';
let floatingChatToolExecuteTool = 'list-dir';
let floatingChatToolExecutePath = '.';
let floatingChatToolExecutePattern = '';
let floatingChatToolExecuteMaxChars = '12000';
let floatingChatToolExecuteMaxMatches = '80';
let autonomyCommitGateAction: AutonomyCommitGateAction | undefined;
let outsideToolPolicyGateAction: OutsideToolPolicyGateAction | undefined;
let autonomyDryRunAction: AutonomyDryRunAction | undefined;
let autonomyDryRunTurnId = 'latest';
let autonomyDryRunProposalIds = '';
let autonomyDryRunMaxProposals = '3';

function initialBackendUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('backend');
  return fromQuery || LAUNCH_BACKEND || localStorage.getItem(STORAGE_KEY) || DEFAULT_BACKEND;
}

function normalizeBackendUrl(value: string): string {
  const trimmed = value.trim() || DEFAULT_BACKEND;
  const url = new URL(trimmed.startsWith('http') ? trimmed : `http://${trimmed}`);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Harmony native control only connects to localhost backends.');
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function endpoint(path: string): string {
  return `${backendUrl}${path}`;
}

function setBackendUrl(next: string, persist: boolean): void {
  backendUrl = normalizeBackendUrl(next);
  if (persist) localStorage.setItem(STORAGE_KEY, backendUrl);
  else localStorage.removeItem(STORAGE_KEY);
  offlinePolls = 0;
  const input = document.querySelector<HTMLInputElement>('#backend-url');
  if (input) input.value = backendUrl;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char);
}

function listCount(value: unknown[] | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

function boolLabel(value: boolean | undefined): string {
  return value ? 'yes' : 'no';
}

function latencyLabel(durationMs: unknown): string {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const band = ms >= 20000 ? 'slow' : ms >= 8000 ? 'delayed' : 'normal';
  const value = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${value} ${band}`;
}

function providerDisplayName(provider: string | undefined): string {
  switch (provider) {
    case 'deepseek': return 'DeepSeek';
    case 'alibaba': return 'Alibaba / Qwen';
    case 'moonshot': return 'Moonshot / Kimi';
    case 'gemini': return 'Gemini';
    case 'openrouter': return 'OpenRouter';
    case 'openai': return 'OpenAI';
    case 'claude': return 'Anthropic (Claude models)';
    default: return provider || '?';
  }
}

function metric(label: string, value: unknown): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function table(headers: string[], rows: string[], empty: string): string {
  if (!rows.length) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function renderPreviewReceipt(receipt: NativeActionReceipt | undefined): string {
  if (!receipt) return '';
  return `
    <div class="kv"><span>Preview receipt</span><code>${escapeHtml(receipt.id || '')}</code></div>
    <div class="kv"><span>Expires</span><strong>${escapeHtml(receipt.expiresAt || '')}</strong></div>
  `;
}

function renderExecuteReceipt(receipt: NativeActionReceipt | undefined): string {
  if (!receipt) return '';
  return `<div class="kv"><span>Execute receipt</span><code>${escapeHtml(receipt.path || receipt.id || '')}</code></div>`;
}

async function postBackendJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(parsed.error || `Backend returned HTTP ${response.status}`);
  return parsed as T;
}

function updateNotice(message: string): void {
  const notice = document.querySelector<HTMLElement>('#notice');
  if (notice) notice.textContent = message;
}

function renderControlledActions(): string {
  const preview = releaseReceiptAction?.preview;
  const receipt = releaseReceiptAction?.receipt;
  const writes = preview?.writes || [];
  const checks = preview?.checks || [];
  const receiptChecks = receipt?.checks || [];
  const privacyPreview = privacyScanAction?.preview;
  const privacyReport = privacyScanAction?.report;
  const privacyWrites = privacyPreview?.writes || [];
  const privacyChecks = privacyPreview?.checks || [];
  const diagnosticsPreview = diagnosticsAction?.preview;
  const diagnosticsReport = diagnosticsAction?.report;
  const diagnosticsWrites = diagnosticsPreview?.writes || [];
  const diagnosticsChecks = diagnosticsPreview?.checks || [];
  const diagnosticsRecommendationCount = diagnosticsReport?.recommendationsCount ?? diagnosticsReport?.recommendations?.length ?? 0;
  const snapshotDrillPreview = snapshotDrillAction?.preview;
  const snapshotDrillResult = snapshotDrillAction?.drill;
  const snapshotDrillWrites = snapshotDrillPreview?.writes || [];
  const snapshotDrillChecks = snapshotDrillPreview?.checks || [];
  const nativeFileWritePreview = nativeFileWriteAction?.preview;
  const nativeFileWriteReport = nativeFileWriteAction?.report;
  const nativeFileWriteWrites = nativeFileWritePreview?.writes || [];
  const nativeFileWriteChecks = nativeFileWritePreview?.checks || [];
  const nativeFileWriteContract = nativeFileWriteReport?.contract || nativeFileWritePreview?.contract;
  const sourceWritePreflightPreview = sourceWritePreflightAction?.preview;
  const sourceWritePreflightReport = sourceWritePreflightAction?.report;
  const sourceWritePreflightWrites = sourceWritePreflightPreview?.writes || [];
  const sourceWritePreflightChecks = sourceWritePreflightPreview?.checks || [];
  const sourceWritePreflightContract = sourceWritePreflightReport?.contract || sourceWritePreflightPreview?.contract;
  const sourceWriteExecutePreview = sourceWriteExecuteAction?.preview;
  const sourceWriteExecuteReport = sourceWriteExecuteAction?.report;
  const sourceWriteExecuteWrites = sourceWriteExecutePreview?.writes || [];
  const sourceWriteExecuteChecks = sourceWriteExecutePreview?.checks || [];
  const sourceWriteExecuteContract = sourceWriteExecuteReport?.contract || sourceWriteExecutePreview?.contract;
  const policyReportPreview = policyReportAction?.preview;
  const policyReport = policyReportAction?.report;
  const policyReportWrites = policyReportPreview?.writes || [];
  const policyReportChecks = policyReportPreview?.checks || [];
  const policyReportMode = policyReport?.policy?.mode || policyReport?.defaultPolicy?.mode || policyReportPreview?.policy?.mode || 'missing';
  const brokerProviderPreview = brokerProviderReportAction?.preview;
  const brokerProviderReport = brokerProviderReportAction?.report;
  const brokerProviderWrites = brokerProviderPreview?.writes || [];
  const brokerProviderChecks = brokerProviderPreview?.checks || [];
  const gitSafetyPreview = gitSafetyReportAction?.preview;
  const gitSafetyReport = gitSafetyReportAction?.report;
  const gitSafetyWrites = gitSafetyPreview?.writes || [];
  const gitSafetyChecks = gitSafetyPreview?.checks || [];
  const gitSafetyMetadata = gitSafetyReport?.metadata;
  const terminalCommandPreview = terminalCommandReportAction?.preview;
  const terminalCommandReport = terminalCommandReportAction?.report;
  const terminalCommandWrites = terminalCommandPreview?.writes || [];
  const terminalCommandChecks = terminalCommandPreview?.checks || [];
  const selfHealingPreview = selfHealingReportAction?.preview;
  const selfHealingReport = selfHealingReportAction?.report;
  const selfHealingWrites = selfHealingPreview?.writes || [];
  const selfHealingChecks = selfHealingPreview?.checks || [];
  const selfHealingMetadata = selfHealingReport?.metadata;
  const selfHealingGatePreview = selfHealingGateAction?.preview;
  const selfHealingGateReport = selfHealingGateAction?.report;
  const selfHealingGateWrites = selfHealingGatePreview?.writes || [];
  const selfHealingGateChecks = selfHealingGatePreview?.checks || [];
  const selfHealingGateContract = selfHealingGateReport?.contract || selfHealingGatePreview?.contract;
  const selfHealingPackagePreflightPreview = selfHealingPackagePreflightAction?.preview;
  const selfHealingPackagePreflightReport = selfHealingPackagePreflightAction?.report;
  const selfHealingPackagePreflightWrites = selfHealingPackagePreflightPreview?.writes || [];
  const selfHealingPackagePreflightChecks = selfHealingPackagePreflightPreview?.checks || [];
  const selfHealingPackagePreflightCommands = selfHealingPackagePreflightPreview?.commands || [];
  const nativeLifecyclePreview = nativeLifecycleReportAction?.preview;
  const nativeLifecycleReport = nativeLifecycleReportAction?.report;
  const nativeLifecycleWrites = nativeLifecyclePreview?.writes || [];
  const nativeLifecycleChecks = nativeLifecyclePreview?.checks || [];
  const nativeLifecycleMetadata = nativeLifecycleReport?.metadata;
  const nativeLifecycleContract = nativeLifecycleMetadata?.lifecycleContract || nativeLifecyclePreview?.contract;
  const nativeLifecyclePreflightPreview = nativeLifecyclePreflightAction?.preview;
  const nativeLifecyclePreflightReport = nativeLifecyclePreflightAction?.report;
  const nativeLifecyclePreflightWrites = nativeLifecyclePreflightPreview?.writes || [];
  const nativeLifecyclePreflightChecks = nativeLifecyclePreflightPreview?.checks || [];
  const nativeLifecyclePreflightGuards = nativeLifecyclePreflightPreview?.guards || [];
  const nativeLifecyclePreflightContract = nativeLifecyclePreflightPreview?.contract;
  const nativeLifecycleStartGatePreview = nativeLifecycleStartGateAction?.preview;
  const nativeLifecycleStartGateReport = nativeLifecycleStartGateAction?.report;
  const nativeLifecycleStartGateWrites = nativeLifecycleStartGatePreview?.writes || [];
  const nativeLifecycleStartGateChecks = nativeLifecycleStartGatePreview?.checks || [];
  const nativeLifecycleStartGateContract = nativeLifecycleStartGateReport?.contract || nativeLifecycleStartGatePreview?.contract;
  const nativeLifecycleStopGatePreview = nativeLifecycleStopGateAction?.preview;
  const nativeLifecycleStopGateReport = nativeLifecycleStopGateAction?.report;
  const nativeLifecycleStopGateWrites = nativeLifecycleStopGatePreview?.writes || [];
  const nativeLifecycleStopGateChecks = nativeLifecycleStopGatePreview?.checks || [];
  const nativeLifecycleStopGateContract = nativeLifecycleStopGateReport?.contract || nativeLifecycleStopGatePreview?.contract;
  const nativeLifecycleReconnectGatePreview = nativeLifecycleReconnectGateAction?.preview;
  const nativeLifecycleReconnectGateReport = nativeLifecycleReconnectGateAction?.report;
  const nativeLifecycleReconnectGateWrites = nativeLifecycleReconnectGatePreview?.writes || [];
  const nativeLifecycleReconnectGateChecks = nativeLifecycleReconnectGatePreview?.checks || [];
  const nativeLifecycleReconnectGateContract = nativeLifecycleReconnectGateReport?.contract || nativeLifecycleReconnectGatePreview?.contract;
  const nativeLifecycleStartPreflightPreview = nativeLifecycleStartPreflightAction?.preview;
  const nativeLifecycleStartPreflightReport = nativeLifecycleStartPreflightAction?.report;
  const nativeLifecycleStartPreflightWrites = nativeLifecycleStartPreflightPreview?.writes || [];
  const nativeLifecycleStartPreflightChecks = nativeLifecycleStartPreflightPreview?.checks || [];
  const nativeLifecycleStartPreflightGuards = nativeLifecycleStartPreflightPreview?.guards || [];
  const nativeLifecycleStartPreflightContract = nativeLifecycleStartPreflightReport?.contract || nativeLifecycleStartPreflightPreview?.contract;
  const nativeLifecycleStopPreflightPreview = nativeLifecycleStopPreflightAction?.preview;
  const nativeLifecycleStopPreflightReport = nativeLifecycleStopPreflightAction?.report;
  const nativeLifecycleStopPreflightWrites = nativeLifecycleStopPreflightPreview?.writes || [];
  const nativeLifecycleStopPreflightChecks = nativeLifecycleStopPreflightPreview?.checks || [];
  const nativeLifecycleStopPreflightGuards = nativeLifecycleStopPreflightPreview?.guards || [];
  const nativeLifecycleStopPreflightContract = nativeLifecycleStopPreflightReport?.contract || nativeLifecycleStopPreflightPreview?.contract;
  const nativeLifecycleStopExecutePreview = nativeLifecycleStopExecuteAction?.preview;
  const nativeLifecycleStopExecuteReport = nativeLifecycleStopExecuteAction?.report;
  const nativeLifecycleStopExecuteWrites = nativeLifecycleStopExecutePreview?.writes || [];
  const nativeLifecycleStopExecuteChecks = nativeLifecycleStopExecutePreview?.checks || [];
  const nativeLifecycleStopExecuteGuards = nativeLifecycleStopExecutePreview?.guards || [];
  const nativeLifecycleStopExecuteContract = nativeLifecycleStopExecuteReport?.contractBefore || nativeLifecycleStopExecutePreview?.contract;
  const nativeLifecycleReconnectPreflightPreview = nativeLifecycleReconnectPreflightAction?.preview;
  const nativeLifecycleReconnectPreflightReport = nativeLifecycleReconnectPreflightAction?.report;
  const nativeLifecycleReconnectPreflightWrites = nativeLifecycleReconnectPreflightPreview?.writes || [];
  const nativeLifecycleReconnectPreflightChecks = nativeLifecycleReconnectPreflightPreview?.checks || [];
  const nativeLifecycleReconnectPreflightGuards = nativeLifecycleReconnectPreflightPreview?.guards || [];
  const nativeLifecycleReconnectPreflightContract = nativeLifecycleReconnectPreflightReport?.contract || nativeLifecycleReconnectPreflightPreview?.contract;
  const nativeLifecycleRestartPreflightPreview = nativeLifecycleRestartPreflightAction?.preview;
  const nativeLifecycleRestartPreflightReport = nativeLifecycleRestartPreflightAction?.report;
  const nativeLifecycleRestartPreflightWrites = nativeLifecycleRestartPreflightPreview?.writes || [];
  const nativeLifecycleRestartPreflightChecks = nativeLifecycleRestartPreflightPreview?.checks || [];
  const nativeLifecycleRestartPreflightGuards = nativeLifecycleRestartPreflightPreview?.guards || [];
  const nativeLifecycleRestartPreflightContract = nativeLifecycleRestartPreflightReport?.contract || nativeLifecycleRestartPreflightPreview?.contract;
  const nativeLifecycleRestartExecuteGatePreview = nativeLifecycleRestartExecuteGateAction?.preview;
  const nativeLifecycleRestartExecuteGateReport = nativeLifecycleRestartExecuteGateAction?.report;
  const nativeLifecycleRestartExecuteGateWrites = nativeLifecycleRestartExecuteGatePreview?.writes || [];
  const nativeLifecycleRestartExecuteGateChecks = nativeLifecycleRestartExecuteGatePreview?.checks || [];
  const nativeLifecycleRestartExecuteGateGuards = nativeLifecycleRestartExecuteGatePreview?.guards || [];
  const nativeLifecycleRestartExecuteGateContract = nativeLifecycleRestartExecuteGateReport?.contract || nativeLifecycleRestartExecuteGatePreview?.contract;
  const nativeLifecycleRestartExecutePreview = nativeLifecycleRestartExecuteAction?.preview;
  const nativeLifecycleRestartExecuteReport = nativeLifecycleRestartExecuteAction?.report;
  const nativeLifecycleRestartExecuteWrites = nativeLifecycleRestartExecutePreview?.writes || [];
  const nativeLifecycleRestartExecuteChecks = nativeLifecycleRestartExecutePreview?.checks || [];
  const nativeLifecycleRestartExecuteGuards = nativeLifecycleRestartExecutePreview?.guards || [];
  const nativeLifecycleRestartExecuteContract = nativeLifecycleRestartExecuteReport?.contractBefore || nativeLifecycleRestartExecutePreview?.contract;
  const nativeLifecycleReconnectExecutePreview = nativeLifecycleReconnectExecuteAction?.preview;
  const nativeLifecycleReconnectExecuteReport = nativeLifecycleReconnectExecuteAction?.report;
  const nativeLifecycleReconnectExecuteWrites = nativeLifecycleReconnectExecutePreview?.writes || [];
  const nativeLifecycleReconnectExecuteChecks = nativeLifecycleReconnectExecutePreview?.checks || [];
  const nativeLifecycleReconnectExecuteGuards = nativeLifecycleReconnectExecutePreview?.guards || [];
  const nativeLifecycleReconnectExecuteContract = nativeLifecycleReconnectExecuteReport?.contractBefore || nativeLifecycleReconnectExecutePreview?.contract;
  const floatingChatPreview = floatingChatNoteAction?.preview;
  const floatingChatReport = floatingChatNoteAction?.report;
  const floatingChatWrites = floatingChatPreview?.writes || [];
  const floatingChatChecks = floatingChatPreview?.checks || [];
  const floatingChatTurnPreview = floatingChatTurnAction?.preview;
  const floatingChatTurnReport = floatingChatTurnAction?.report;
  const floatingChatTurnWrites = floatingChatTurnPreview?.writes || [];
  const floatingChatTurnChecks = floatingChatTurnPreview?.checks || [];
  const floatingChatResponseGatePreview = floatingChatResponseGateAction?.preview;
  const floatingChatResponseGateReport = floatingChatResponseGateAction?.report;
  const floatingChatResponseGateWrites = floatingChatResponseGatePreview?.writes || [];
  const floatingChatResponseGateChecks = floatingChatResponseGatePreview?.checks || [];
  const floatingChatResponseGateContract = floatingChatResponseGateReport?.contract || floatingChatResponseGatePreview?.contract;
  const floatingChatResponsePreflightPreview = floatingChatResponsePreflightAction?.preview;
  const floatingChatResponsePreflightReport = floatingChatResponsePreflightAction?.report;
  const floatingChatResponsePreflightWrites = floatingChatResponsePreflightPreview?.writes || [];
  const floatingChatResponsePreflightChecks = floatingChatResponsePreflightPreview?.checks || [];
  const floatingChatResponsePreflightContract = floatingChatResponsePreflightReport?.contract || floatingChatResponsePreflightPreview?.contract;
  const floatingChatResponseExecutePreview = floatingChatResponseExecuteAction?.preview;
  const floatingChatResponseExecuteReport = floatingChatResponseExecuteAction?.report;
  const floatingChatResponseExecuteWrites = floatingChatResponseExecutePreview?.writes || [];
  const floatingChatResponseExecuteChecks = floatingChatResponseExecutePreview?.checks || [];
  const floatingChatResponseExecuteContract = floatingChatResponseExecuteReport?.contract || floatingChatResponseExecutePreview?.contract;
  const floatingChatToolPreflightPreview = floatingChatToolPreflightAction?.preview;
  const floatingChatToolPreflightReport = floatingChatToolPreflightAction?.report;
  const floatingChatToolPreflightWrites = floatingChatToolPreflightPreview?.writes || [];
  const floatingChatToolPreflightChecks = floatingChatToolPreflightPreview?.checks || [];
  const floatingChatToolPreflightContract = floatingChatToolPreflightReport?.contract || floatingChatToolPreflightPreview?.contract;
  const floatingChatToolLoopPreflightPreview = floatingChatToolLoopPreflightAction?.preview;
  const floatingChatToolLoopPreflightReport = floatingChatToolLoopPreflightAction?.report;
  const floatingChatToolLoopPreflightWrites = floatingChatToolLoopPreflightPreview?.writes || [];
  const floatingChatToolLoopPreflightChecks = floatingChatToolLoopPreflightPreview?.checks || [];
  const floatingChatToolLoopPreflightContract = floatingChatToolLoopPreflightReport?.contract || floatingChatToolLoopPreflightPreview?.contract;
  const floatingChatToolLoopPreflightSteps = floatingChatToolLoopPreflightContract?.plannedSteps || [];
  const floatingChatToolLoopExecutePreview = floatingChatToolLoopExecuteAction?.preview;
  const floatingChatToolLoopExecuteReport = floatingChatToolLoopExecuteAction?.report;
  const floatingChatToolLoopExecuteWrites = floatingChatToolLoopExecutePreview?.writes || [];
  const floatingChatToolLoopExecuteChecks = floatingChatToolLoopExecutePreview?.checks || [];
  const floatingChatToolLoopExecuteContract = floatingChatToolLoopExecuteReport?.contract || floatingChatToolLoopExecutePreview?.contract;
  const floatingChatToolLoopExecutedStep = Number(floatingChatToolLoopExecuteReport?.loopExecution?.stepIndex || floatingChatToolLoopExecuteContract?.selectedStep?.index || 0);
  const floatingChatToolLoopPlannedSteps = Number(floatingChatToolLoopExecuteContract?.plannedStepCount || floatingChatToolLoopExecutePreview?.summary?.plannedSteps || 0);
  const floatingChatToolLoopNextStep = floatingChatToolLoopExecutedStep + 1;
  const floatingChatToolLoopHasNextStep = Boolean(floatingChatToolLoopExecuteReport?.status === 'completed' && floatingChatToolLoopNextStep <= floatingChatToolLoopPlannedSteps);
  const floatingChatAutonomyNextPreview = floatingChatAutonomyNextAction?.preview;
  const floatingChatAutonomyNextReport = floatingChatAutonomyNextAction?.report;
  const floatingChatAutonomyNextWrites = floatingChatAutonomyNextPreview?.writes || [];
  const floatingChatAutonomyNextChecks = floatingChatAutonomyNextPreview?.checks || [];
  const floatingChatAutonomyNextContract = floatingChatAutonomyNextReport?.contract || floatingChatAutonomyNextPreview?.contract;
  const floatingChatToolExecutePreview = floatingChatToolExecuteAction?.preview;
  const floatingChatToolExecuteReport = floatingChatToolExecuteAction?.report;
  const floatingChatToolExecuteWrites = floatingChatToolExecutePreview?.writes || [];
  const floatingChatToolExecuteChecks = floatingChatToolExecutePreview?.checks || [];
  const floatingChatToolExecuteContract = floatingChatToolExecuteReport?.contract || floatingChatToolExecutePreview?.contract;
  const autonomyCommitPreview = autonomyCommitGateAction?.preview;
  const autonomyCommitReport = autonomyCommitGateAction?.report;
  const autonomyCommitWrites = autonomyCommitPreview?.writes || [];
  const autonomyCommitChecks = autonomyCommitPreview?.checks || [];
  const autonomyCommitContract = autonomyCommitReport?.contract || autonomyCommitPreview?.contract;
  const outsideToolPolicyPreview = outsideToolPolicyGateAction?.preview;
  const outsideToolPolicyReport = outsideToolPolicyGateAction?.report;
  const outsideToolPolicyWrites = outsideToolPolicyPreview?.writes || [];
  const outsideToolPolicyChecks = outsideToolPolicyPreview?.checks || [];
  const outsideToolPolicyContract = outsideToolPolicyReport?.contract || outsideToolPolicyPreview?.contract;
  const autonomyDryRunPreview = autonomyDryRunAction?.preview;
  const autonomyDryRunReport = autonomyDryRunAction?.report;
  const autonomyDryRunWrites = autonomyDryRunPreview?.writes || [];
  const autonomyDryRunChecks = autonomyDryRunPreview?.checks || [];
  const autonomyDryRunContract = autonomyDryRunReport?.contract || autonomyDryRunPreview?.contract;
  const autonomyDryRunSteps = autonomyDryRunContract?.simulatedSteps || [];
  return `
    <section class="action-section action-section-feature" id="floating-chat-overview">
      <div class="action-section-title">
        <h3>Floating Chat</h3>
        <p>Native outside-VS conversation capture with response execution still gated.</p>
      </div>
      <div class="chat-status-grid">
        <div class="kv"><span>Window</span><strong>native</strong></div>
        <div class="kv"><span>Latest turn</span><strong>${escapeHtml(floatingChatTurnReport ? 'captured' : 'none')}</strong></div>
        <div class="kv"><span>Response gate</span><strong>${escapeHtml(floatingChatResponseGateReport ? 'recorded' : 'not run')}</strong></div>
        <div class="kv"><span>Response execute</span><strong>${escapeHtml(floatingChatResponseExecuteReport?.status || (floatingChatResponseExecuteContract?.responseExecuteCurrentlyAllowed ? 'ready' : 'gated'))}</strong></div>
      </div>
      <a class="button-link" href="#floating-chat-section">Open Floating Chat Controls</a>
    </section>
    <section class="action-section">
      <div class="action-section-title">
        <h3>Release And Privacy</h3>
        <p>Package receipts and VSIX disclosure checks.</p>
      </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Release Receipt</h3>
          <p>Backend-owned private receipt creation with preview and exact confirmation.</p>
        </div>
        <button id="preview-release-receipt" type="button">Preview</button>
      </div>
      ${preview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(preview.version || '?')}</strong></div>
          <div class="kv"><span>VSIX</span><strong>${escapeHtml(preview.vsix?.exists ? 'present' : 'missing')}</strong><code>${escapeHtml(preview.vsix?.path || '')}</code></div>
          ${renderPreviewReceipt(preview.previewReceipt)}
          ${table(['Writes'], writes.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], checks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="release-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(preview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="release-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-release-receipt" type="button">Create Receipt</button>
            <button id="clear-release-receipt" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${receipt ? `
        <div class="action-result ${releaseReceiptAction?.ok ? 'ok' : 'danger'}">
          <strong>Receipt ${escapeHtml(receipt.status || (releaseReceiptAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(releaseReceiptAction?.reportPath || receipt.reportPath || '')}</code>
          ${renderExecuteReceipt(releaseReceiptAction?.executeReceipt)}
          ${table(['Check', 'Status', 'Detail'], receiptChecks.map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No receipt checks returned.')}
        </div>` : ''}
      ${releaseReceiptAction?.error ? `<p class="action-error">${escapeHtml(releaseReceiptAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Privacy Scan</h3>
          <p>Backend-owned VSIX privacy scan with preview and exact confirmation.</p>
        </div>
        <button id="preview-privacy-scan" type="button">Preview</button>
      </div>
      ${privacyPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(privacyPreview.version || '?')}</strong></div>
          <div class="kv"><span>VSIX</span><strong>${escapeHtml(privacyPreview.vsix?.exists ? 'present' : 'missing')}</strong><code>${escapeHtml(privacyPreview.vsix?.path || '')}</code></div>
          ${renderPreviewReceipt(privacyPreview.previewReceipt)}
          ${table(['Writes'], privacyWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], privacyChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="privacy-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(privacyPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="privacy-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-privacy-scan" type="button">Run Scan</button>
            <button id="clear-privacy-scan" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${privacyReport ? `
        <div class="action-result ${privacyScanAction?.ok ? 'ok' : 'danger'}">
          <strong>Privacy scan ${escapeHtml(privacyReport.status || (privacyScanAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(privacyScanAction?.reportPath || privacyReport.reportPath || '')}</code>
          ${renderExecuteReceipt(privacyScanAction?.executeReceipt)}
          <div>Files scanned: ${escapeHtml(privacyReport.extractedFileCount || 0)}</div>
          <div>Path issues: ${escapeHtml(Array.isArray(privacyReport.pathIssues) ? privacyReport.pathIssues.length : 0)}</div>
          <div>Content token issues: ${escapeHtml(Array.isArray(privacyReport.contentIssues) ? privacyReport.contentIssues.length : 0)}</div>
        </div>` : ''}
      ${privacyScanAction?.error ? `<p class="action-error">${escapeHtml(privacyScanAction.error)}</p>` : ''}
    </div>
    </section>
    <section class="action-section">
      <div class="action-section-title">
        <h3>Safety And Recovery</h3>
        <p>Diagnostics, restore drills, and outside-VS policy visibility.</p>
      </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Diagnostics</h3>
          <p>Backend-owned cross-surface diagnostics report with preview and exact confirmation.</p>
        </div>
        <button id="preview-diagnostics" type="button">Preview</button>
      </div>
      ${diagnosticsPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(diagnosticsPreview.version || '?')}</strong></div>
          <div class="kv"><span>Workspace</span><code>${escapeHtml(diagnosticsPreview.workspace || '')}</code></div>
          ${renderPreviewReceipt(diagnosticsPreview.previewReceipt)}
          ${table(['Writes'], diagnosticsWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], diagnosticsChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="diagnostics-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(diagnosticsPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="diagnostics-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-diagnostics" type="button">Run Diagnostics</button>
            <button id="clear-diagnostics" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${diagnosticsReport ? `
        <div class="action-result ${diagnosticsAction?.ok ? 'ok' : 'warn'}">
          <strong>Diagnostics ${diagnosticsAction?.ok ? 'clean' : 'completed with recommendations'}</strong>
          <code>${escapeHtml(diagnosticsAction?.reportPath || diagnosticsReport.reportPath || '')}</code>
          ${renderExecuteReceipt(diagnosticsAction?.executeReceipt)}
          <div>Recommendations: ${escapeHtml(diagnosticsRecommendationCount)}</div>
          <div>Hub: ${escapeHtml(diagnosticsReport.state?.hub?.online ? 'online' : 'offline')}</div>
          <div>Secret metadata: ${escapeHtml(diagnosticsReport.state?.crossSurface?.secretStore?.storedProviders ?? 0)}/${escapeHtml(diagnosticsReport.state?.crossSurface?.secretStore?.totalProviders ?? 0)} providers stored</div>
        </div>` : ''}
      ${diagnosticsAction?.error ? `<p class="action-error">${escapeHtml(diagnosticsAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Snapshot Drill</h3>
          <p>Backend-owned disposable restore drill with preview receipt and exact confirmation.</p>
        </div>
        <button id="preview-snapshot-drill" type="button">Preview</button>
      </div>
      ${snapshotDrillPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(snapshotDrillPreview.version || '?')}</strong></div>
          <div class="kv"><span>Disposable path</span><code>${escapeHtml(snapshotDrillPreview.path || '')}</code></div>
          <div class="kv"><span>Target exists</span><strong>${escapeHtml(snapshotDrillPreview.target?.exists ? 'yes' : 'no')}</strong></div>
          ${renderPreviewReceipt(snapshotDrillPreview.previewReceipt)}
          ${table(['Writes'], snapshotDrillWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], snapshotDrillChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="snapshot-drill-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(snapshotDrillPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="snapshot-drill-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-snapshot-drill" type="button">Run Drill</button>
            <button id="clear-snapshot-drill" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${snapshotDrillResult ? `
        <div class="action-result ${snapshotDrillAction?.ok ? 'ok' : 'danger'}">
          <strong>Snapshot drill ${escapeHtml(snapshotDrillResult.status || (snapshotDrillAction?.ok ? 'completed' : 'failed'))}</strong>
          <code>${escapeHtml(snapshotDrillAction?.reportPath || snapshotDrillResult.manifestPath || '')}</code>
          ${renderExecuteReceipt(snapshotDrillAction?.executeReceipt)}
          <div>Restored: ${escapeHtml(snapshotDrillResult.restored ? 'yes' : 'no')}</div>
          <div>Cleaned up: ${escapeHtml(snapshotDrillResult.cleanedUp ? 'yes' : 'no')}</div>
        </div>` : ''}
      ${snapshotDrillAction?.error ? `<p class="action-error">${escapeHtml(snapshotDrillAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native File Write</h3>
          <p>Guarded overwrite for an existing small text file with policy, preview receipt, exact confirmation, and pre-action snapshot.</p>
        </div>
        <button id="preview-native-file-write" type="button">Preview</button>
      </div>
      <input id="native-file-write-path" autocomplete="off" spellcheck="false" maxlength="220" placeholder="Existing workspace text file" value="${escapeHtml(nativeFileWritePath)}" />
      <textarea id="native-file-write-content" rows="5" maxlength="20000" placeholder="Replacement text content">${escapeHtml(nativeFileWriteContent)}</textarea>
      ${nativeFileWritePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeFileWritePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeFileWritePreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Path</span><code>${escapeHtml(nativeFileWritePreview.summary?.path || '')}</code></div>
          <div class="kv"><span>Chars</span><strong>${escapeHtml(nativeFileWritePreview.summary?.contentChars ?? 0)}</strong></div>
          <div class="kv"><span>Write policy</span><strong>${boolLabel(nativeFileWritePreview.summary?.writeFiles)}</strong></div>
          <div class="kv"><span>Snapshot</span><strong>${boolLabel(nativeFileWritePreview.summary?.snapshotRequired)}</strong></div>
          ${renderPreviewReceipt(nativeFileWritePreview.previewReceipt)}
          ${table(['Writes'], nativeFileWriteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeFileWriteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (nativeFileWriteContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No native file write checks reported.')}
          <label class="confirm-label" for="native-file-write-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeFileWritePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-file-write-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-file-write" type="button">Write File</button>
            <button id="clear-native-file-write" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeFileWriteReport ? `
        <div class="action-result ${nativeFileWriteAction?.ok ? 'ok' : 'warn'}">
          <strong>Native file write ${escapeHtml(nativeFileWriteReport.status || 'unknown')}</strong>
          <code>${escapeHtml(nativeFileWriteAction?.reportPath || nativeFileWriteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeFileWriteAction?.executeReceipt)}
          <div>Performed: ${boolLabel(nativeFileWriteReport.write?.performed)}</div>
          <div>Path: ${escapeHtml(nativeFileWriteReport.write?.path || nativeFileWriteContract?.target?.path || '')}</div>
          <div>Snapshot: ${escapeHtml(nativeFileWriteReport.snapshot?.id || 'none')}</div>
        </div>` : ''}
      ${nativeFileWriteAction?.error ? `<p class="action-error">${escapeHtml(nativeFileWriteAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Policy Report</h3>
          <p>Backend-owned outside-VS policy report with preview receipt and exact confirmation.</p>
        </div>
        <button id="preview-policy-report" type="button">Preview</button>
      </div>
      ${policyReportPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(policyReportPreview.version || '?')}</strong></div>
          <div class="kv"><span>Policy</span><strong>${escapeHtml(policyReportPreview.policy?.exists ? 'present' : 'missing')}</strong><code>${escapeHtml(policyReportPreview.policy?.path || '')}</code></div>
          <div class="kv"><span>Mode</span><strong>${escapeHtml(policyReportPreview.policy?.mode || 'missing')}</strong></div>
          ${renderPreviewReceipt(policyReportPreview.previewReceipt)}
          ${table(['Writes'], policyReportWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], policyReportChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="policy-report-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(policyReportPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="policy-report-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-policy-report" type="button">Create Report</button>
            <button id="clear-policy-report" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${policyReport ? `
        <div class="action-result ${policyReportAction?.ok ? 'ok' : 'warn'}">
          <strong>Policy report ${policyReport.exists ? 'created' : 'created with missing policy'}</strong>
          <code>${escapeHtml(policyReportAction?.reportPath || policyReport.reportPath || '')}</code>
          ${renderExecuteReceipt(policyReportAction?.executeReceipt)}
          <div>Mode: ${escapeHtml(policyReportMode)}</div>
          <div>Policy exists: ${escapeHtml(policyReport.exists ? 'yes' : 'no')}</div>
        </div>` : ''}
      ${policyReportAction?.error ? `<p class="action-error">${escapeHtml(policyReportAction.error)}</p>` : ''}
    </div>
    </section>
    <section class="action-section">
      <div class="action-section-title">
        <h3>Providers And Repository</h3>
        <p>Provider metadata and read-only Git safety reports.</p>
      </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Broker/Provider Report</h3>
          <p>Backend-owned broker queue and provider metadata report with no provider execution.</p>
        </div>
        <button id="preview-broker-provider-report" type="button">Preview</button>
      </div>
      ${brokerProviderPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(brokerProviderPreview.version || '?')}</strong></div>
          <div class="kv"><span>Providers</span><strong>${escapeHtml(`${brokerProviderPreview.summary?.configuredProviders ?? 0}/${brokerProviderPreview.summary?.totalProviders ?? 0} configured`)}</strong></div>
          <div class="kv"><span>Secrets</span><strong>${escapeHtml(`${brokerProviderPreview.summary?.storedSecrets ?? 0}/${brokerProviderPreview.summary?.totalSecrets ?? 0} stored`)}</strong></div>
          <div class="kv"><span>Broker</span><strong>${escapeHtml(`${brokerProviderPreview.summary?.brokerPending ?? 0} pending`)}</strong></div>
          ${renderPreviewReceipt(brokerProviderPreview.previewReceipt)}
          ${table(['Writes'], brokerProviderWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], brokerProviderChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="broker-provider-report-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(brokerProviderPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="broker-provider-report-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-broker-provider-report" type="button">Create Report</button>
            <button id="clear-broker-provider-report" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${brokerProviderReport ? `
        <div class="action-result ${brokerProviderReportAction?.ok ? 'ok' : 'warn'}">
          <strong>Broker/provider report created</strong>
          <code>${escapeHtml(brokerProviderReportAction?.reportPath || brokerProviderReport.reportPath || '')}</code>
          ${renderExecuteReceipt(brokerProviderReportAction?.executeReceipt)}
          <div>Providers: ${escapeHtml((brokerProviderReport.providerStatus || []).filter((item) => item.configured).length)}/${escapeHtml(listCount(brokerProviderReport.providerStatus))} configured</div>
          <div>Secrets: ${escapeHtml(brokerProviderReport.crossSurface?.secretStore?.storedProviders ?? 0)}/${escapeHtml(brokerProviderReport.crossSurface?.secretStore?.totalProviders ?? 0)} stored</div>
          <div>Broker pending: ${escapeHtml(listCount(brokerProviderReport.broker?.pending))}</div>
        </div>` : ''}
      ${brokerProviderReportAction?.error ? `<p class="action-error">${escapeHtml(brokerProviderReportAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Git Safety Report</h3>
          <p>Backend-owned read-only Git status and diff-stat report with no Git mutations.</p>
        </div>
        <button id="preview-git-safety-report" type="button">Preview</button>
      </div>
      ${gitSafetyPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(gitSafetyPreview.version || '?')}</strong></div>
          <div class="kv"><span>Work tree</span><strong>${escapeHtml(gitSafetyPreview.summary?.insideWorkTree ? 'yes' : 'no')}</strong></div>
          <div class="kv"><span>Branch</span><strong>${escapeHtml(gitSafetyPreview.summary?.branch || 'detached or unavailable')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(`${gitSafetyPreview.summary?.statusCount ?? 0} rows`)}</strong></div>
          ${renderPreviewReceipt(gitSafetyPreview.previewReceipt)}
          ${table(['Writes'], gitSafetyWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], gitSafetyChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="git-safety-report-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(gitSafetyPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="git-safety-report-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-git-safety-report" type="button">Create Report</button>
            <button id="clear-git-safety-report" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${gitSafetyReport ? `
        <div class="action-result ${gitSafetyReportAction?.ok ? 'ok' : 'warn'}">
          <strong>Git safety report created</strong>
          <code>${escapeHtml(gitSafetyReportAction?.reportPath || gitSafetyReport.reportPath || '')}</code>
          ${renderExecuteReceipt(gitSafetyReportAction?.executeReceipt)}
          <div>Work tree: ${escapeHtml(gitSafetyMetadata?.insideWorkTree ? 'yes' : 'no')}</div>
          <div>Status rows: ${escapeHtml(gitSafetyMetadata?.statusCount ?? 0)}</div>
          <div>Unstaged/staged: ${escapeHtml(gitSafetyMetadata?.unstagedCount ?? 0)}/${escapeHtml(gitSafetyMetadata?.stagedCount ?? 0)}</div>
        </div>` : ''}
      ${gitSafetyReportAction?.error ? `<p class="action-error">${escapeHtml(gitSafetyReportAction.error)}</p>` : ''}
    </div>
    </section>
    <section class="action-section">
      <div class="action-section-title">
        <h3>Daemon And Window</h3>
        <p>Outside-native lifecycle visibility before start or stop controls exist.</p>
      </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Report</h3>
          <p>Backend-owned daemon/window lifecycle contract with no process start, stop, or kill.</p>
        </div>
        <button id="preview-native-lifecycle-report" type="button">Preview</button>
      </div>
      ${nativeLifecyclePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecyclePreview.version || '?')}</strong></div>
          <div class="kv"><span>Posture</span><strong>${escapeHtml(nativeLifecyclePreview.summary?.posture || 'unknown')}</strong></div>
          <div class="kv"><span>Heartbeats</span><strong>${escapeHtml(`${nativeLifecyclePreview.summary?.activeHeartbeats ?? 0} active / ${nativeLifecyclePreview.summary?.staleHeartbeats ?? 0} stale`)}</strong></div>
          <div class="kv"><span>Window</span><strong>${escapeHtml(nativeLifecyclePreview.summary?.tauriWindow || 'unknown')}</strong></div>
          ${renderPreviewReceipt(nativeLifecyclePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Required Before Start/Stop'], (nativeLifecycleContract?.requiredBeforeStartStop || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No lifecycle requirements reported.')}
          <label class="confirm-label" for="native-lifecycle-report-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecyclePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-report-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-report" type="button">Create Report</button>
            <button id="clear-native-lifecycle-report" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleReport ? `
        <div class="action-result ${nativeLifecycleReportAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle report created</strong>
          <code>${escapeHtml(nativeLifecycleReportAction?.reportPath || nativeLifecycleReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleReportAction?.executeReceipt)}
          <div>Backend: ${escapeHtml(nativeLifecycleMetadata?.backend?.expectedUrl || 'unknown')}</div>
          <div>Status: ${escapeHtml(nativeLifecycleMetadata?.lifecycleContract?.currentStatus || 'unknown')}</div>
          <div>Heartbeats: ${escapeHtml(nativeLifecycleMetadata?.supervisor?.active ?? 0)} active / ${escapeHtml(nativeLifecycleMetadata?.supervisor?.stale ?? 0)} stale</div>
        </div>` : ''}
      ${nativeLifecycleReportAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleReportAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Preflight</h3>
          <p>Locked daemon/window readiness checks before any start, stop, kill, install, or reload controls exist.</p>
        </div>
        <button id="preview-native-lifecycle-preflight" type="button">Preview</button>
      </div>
      ${nativeLifecyclePreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecyclePreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Authority</span><strong>${escapeHtml(nativeLifecyclePreflightPreview.target?.authority || 'unknown')}</strong></div>
          <div class="kv"><span>Checks</span><strong>${escapeHtml(nativeLifecyclePreflightPreview.target?.checks ?? 0)}</strong></div>
          <div class="kv"><span>Window</span><strong>${escapeHtml(nativeLifecyclePreflightPreview.summary?.tauriWindow || 'unknown')}</strong></div>
          ${renderPreviewReceipt(nativeLifecyclePreflightPreview.previewReceipt)}
          ${table(['Writes'], nativeLifecyclePreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecyclePreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecyclePreflightGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Required Before Start/Stop'], (nativeLifecyclePreflightContract?.requiredBeforeStartStop || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No lifecycle requirements reported.')}
          <label class="confirm-label" for="native-lifecycle-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecyclePreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-preflight" type="button">Run Preflight</button>
            <button id="clear-native-lifecycle-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecyclePreflightReport ? `
        <div class="action-result ${nativeLifecyclePreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle preflight ${escapeHtml(nativeLifecyclePreflightReport.status || (nativeLifecyclePreflightAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(nativeLifecyclePreflightAction?.reportPath || nativeLifecyclePreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecyclePreflightAction?.executeReceipt)}
          <div>Checks passed: ${escapeHtml((nativeLifecyclePreflightReport.checks || []).filter((item) => item.status === 'passed').length)}/${escapeHtml(listCount(nativeLifecyclePreflightReport.checks))}</div>
          <div>Lock released: ${escapeHtml(nativeLifecyclePreflightReport.lockRelease?.released ? 'yes' : 'no')}</div>
        </div>` : ''}
      ${nativeLifecyclePreflightAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecyclePreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Start Gate</h3>
          <p>Future daemon/window start contract. It records requirements but does not spawn or open anything.</p>
        </div>
        <button id="preview-native-lifecycle-start-gate" type="button">Preview</button>
      </div>
      ${nativeLifecycleStartGatePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleStartGatePreview.version || '?')}</strong></div>
          <div class="kv"><span>Posture</span><strong>${escapeHtml(nativeLifecycleStartGatePreview.summary?.posture || 'unknown')}</strong></div>
          <div class="kv"><span>Preflight</span><strong>${escapeHtml(nativeLifecycleStartGatePreview.summary?.latestPreflightStatus || 'missing')}</strong></div>
          <div class="kv"><span>Start Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleStartGatePreview.target?.startCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleStartGatePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleStartGateWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleStartGateChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Required Before Future Start'], (nativeLifecycleStartGateContract?.requiredBeforeStart || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No start requirements reported.')}
          <label class="confirm-label" for="native-lifecycle-start-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleStartGatePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-start-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-start-gate" type="button">Create Gate</button>
            <button id="clear-native-lifecycle-start-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleStartGateReport ? `
        <div class="action-result ${nativeLifecycleStartGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle start gate created</strong>
          <code>${escapeHtml(nativeLifecycleStartGateAction?.reportPath || nativeLifecycleStartGateReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleStartGateAction?.executeReceipt)}
          <div>Preflight: ${escapeHtml(nativeLifecycleStartGateContract?.latestPreflight?.status || 'missing')}</div>
          <div>Required before start: ${escapeHtml(listCount(nativeLifecycleStartGateContract?.requiredBeforeStart))}</div>
          <div>Blocked authority classes: ${escapeHtml(listCount(nativeLifecycleStartGateContract?.blockedAuthorityClasses))}</div>
        </div>` : ''}
      ${nativeLifecycleStartGateAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleStartGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Stop Gate</h3>
          <p>Future graceful stop/restart contract. It records requirements but does not stop or kill anything.</p>
        </div>
        <button id="preview-native-lifecycle-stop-gate" type="button">Preview</button>
      </div>
      ${nativeLifecycleStopGatePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleStopGatePreview.version || '?')}</strong></div>
          <div class="kv"><span>Posture</span><strong>${escapeHtml(nativeLifecycleStopGatePreview.summary?.posture || 'unknown')}</strong></div>
          <div class="kv"><span>Preflight</span><strong>${escapeHtml(nativeLifecycleStopGatePreview.summary?.latestPreflightStatus || 'missing')}</strong></div>
          <div class="kv"><span>Stop Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleStopGatePreview.target?.stopCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleStopGatePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleStopGateWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleStopGateChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Required Before Future Stop'], (nativeLifecycleStopGateContract?.requiredBeforeStop || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No stop requirements reported.')}
          <label class="confirm-label" for="native-lifecycle-stop-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleStopGatePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-stop-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-stop-gate" type="button">Create Gate</button>
            <button id="clear-native-lifecycle-stop-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleStopGateReport ? `
        <div class="action-result ${nativeLifecycleStopGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle stop gate created</strong>
          <code>${escapeHtml(nativeLifecycleStopGateAction?.reportPath || nativeLifecycleStopGateReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleStopGateAction?.executeReceipt)}
          <div>Preflight: ${escapeHtml(nativeLifecycleStopGateContract?.latestPreflight?.status || 'missing')}</div>
          <div>Required before stop: ${escapeHtml(listCount(nativeLifecycleStopGateContract?.requiredBeforeStop))}</div>
          <div>Blocked authority classes: ${escapeHtml(listCount(nativeLifecycleStopGateContract?.blockedAuthorityClasses))}</div>
        </div>` : ''}
      ${nativeLifecycleStopGateAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleStopGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Reconnect Gate</h3>
          <p>Loopback health and reconnect contract before any daemon start or process mutation.</p>
        </div>
        <button id="preview-native-lifecycle-reconnect-gate" type="button">Preview</button>
      </div>
      ${nativeLifecycleReconnectGatePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleReconnectGatePreview.version || '?')}</strong></div>
          <div class="kv"><span>Posture</span><strong>${escapeHtml(nativeLifecycleReconnectGatePreview.summary?.posture || 'unknown')}</strong></div>
          <div class="kv"><span>Health</span><strong>${escapeHtml(nativeLifecycleReconnectGatePreview.summary?.healthProbeStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Reconnect Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleReconnectGatePreview.target?.reconnectCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleReconnectGatePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleReconnectGateWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleReconnectGateChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Required Before Future Reconnect'], (nativeLifecycleReconnectGateContract?.requiredBeforeReconnect || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No reconnect requirements reported.')}
          <label class="confirm-label" for="native-lifecycle-reconnect-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleReconnectGatePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-reconnect-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-reconnect-gate" type="button">Create Gate</button>
            <button id="clear-native-lifecycle-reconnect-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleReconnectGateReport ? `
        <div class="action-result ${nativeLifecycleReconnectGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle reconnect gate created</strong>
          <code>${escapeHtml(nativeLifecycleReconnectGateAction?.reportPath || nativeLifecycleReconnectGateReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleReconnectGateAction?.executeReceipt)}
          <div>Health: ${escapeHtml(nativeLifecycleReconnectGateContract?.healthProbe?.status || 'unknown')}</div>
          <div>Endpoint: ${escapeHtml(nativeLifecycleReconnectGateContract?.healthProbe?.endpoint || nativeLifecycleReconnectGateContract?.currentLifecycle?.healthEndpoint || 'unknown')}</div>
          <div>Required before reconnect: ${escapeHtml(listCount(nativeLifecycleReconnectGateContract?.requiredBeforeReconnect))}</div>
        </div>` : ''}
      ${nativeLifecycleReconnectGateAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleReconnectGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Start Preflight</h3>
          <p>Fixed executable, port, ownership, and health checks before any future daemon start action.</p>
        </div>
        <button id="preview-native-lifecycle-start-preflight" type="button">Preview</button>
      </div>
      ${nativeLifecycleStartPreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleStartPreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleStartPreflightPreview.summary?.startPreflightStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Port</span><strong>${escapeHtml(nativeLifecycleStartPreflightPreview.summary?.portPlanStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Start Execute Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleStartPreflightPreview.target?.startExecuteCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleStartPreflightPreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleStartPreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleStartPreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleStartPreflightGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Start Check', 'Status', 'Detail'], (nativeLifecycleStartPreflightContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No start preflight checks reported.')}
          ${table(['Required Before Future Start Execute'], (nativeLifecycleStartPreflightContract?.requiredBeforeStartExecute || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No start execute requirements reported.')}
          <div class="kv"><span>Command Digest</span><strong>${escapeHtml(nativeLifecycleStartPreflightContract?.commandPlan?.digest || nativeLifecycleStartPreflightPreview.summary?.fixedCommandDigest || 'unknown')}</strong></div>
          <div class="kv"><span>Fixed Command</span><strong>${escapeHtml(nativeLifecycleStartPreflightContract?.commandPlan?.display || 'unknown')}</strong></div>
          <label class="confirm-label" for="native-lifecycle-start-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleStartPreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-start-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-start-preflight" type="button">Run Preflight</button>
            <button id="clear-native-lifecycle-start-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleStartPreflightReport ? `
        <div class="action-result ${nativeLifecycleStartPreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle start preflight ${escapeHtml(nativeLifecycleStartPreflightReport.status || (nativeLifecycleStartPreflightAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(nativeLifecycleStartPreflightAction?.reportPath || nativeLifecycleStartPreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleStartPreflightAction?.executeReceipt)}
          <div>Port plan: ${escapeHtml(nativeLifecycleStartPreflightContract?.portPlan?.status || 'unknown')}</div>
          <div>Health: ${escapeHtml(nativeLifecycleStartPreflightContract?.healthProbe?.status || 'unknown')}</div>
          <div>Lock released: ${escapeHtml(nativeLifecycleStartPreflightReport.lockRelease?.released ? 'yes' : 'no')}</div>
        </div>` : ''}
      ${nativeLifecycleStartPreflightAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleStartPreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Stop Preflight</h3>
          <p>Fixed stop-plan, health, target ownership, and lifecycle checks before any future stop action.</p>
        </div>
        <button id="preview-native-lifecycle-stop-preflight" type="button">Preview</button>
      </div>
      ${nativeLifecycleStopPreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleStopPreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleStopPreflightPreview.summary?.stopPreflightStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Target</span><strong>${escapeHtml(nativeLifecycleStopPreflightPreview.summary?.targetPlanStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Stop Execute Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleStopPreflightPreview.target?.stopExecuteCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleStopPreflightPreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleStopPreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleStopPreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleStopPreflightGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Stop Check', 'Status', 'Detail'], (nativeLifecycleStopPreflightContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No stop preflight checks reported.')}
          ${table(['Required Before Future Stop Execute'], (nativeLifecycleStopPreflightContract?.requiredBeforeStopExecute || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No stop execute requirements reported.')}
          <div class="kv"><span>Stop Plan Digest</span><strong>${escapeHtml(nativeLifecycleStopPreflightContract?.stopPlan?.digest || nativeLifecycleStopPreflightPreview.summary?.stopPlanDigest || 'unknown')}</strong></div>
          <div class="kv"><span>Ownership</span><strong>${escapeHtml(nativeLifecycleStopPreflightContract?.targetPlan?.ownership || 'unknown')}</strong></div>
          <label class="confirm-label" for="native-lifecycle-stop-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleStopPreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-stop-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-stop-preflight" type="button">Run Preflight</button>
            <button id="clear-native-lifecycle-stop-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleStopPreflightReport ? `
        <div class="action-result ${nativeLifecycleStopPreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle stop preflight ${escapeHtml(nativeLifecycleStopPreflightReport.status || (nativeLifecycleStopPreflightAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(nativeLifecycleStopPreflightAction?.reportPath || nativeLifecycleStopPreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleStopPreflightAction?.executeReceipt)}
          <div>Target plan: ${escapeHtml(nativeLifecycleStopPreflightContract?.targetPlan?.status || 'unknown')}</div>
          <div>Health: ${escapeHtml(nativeLifecycleStopPreflightContract?.healthProbe?.status || 'unknown')}</div>
          <div>Lock released: ${escapeHtml(nativeLifecycleStopPreflightReport.lockRelease?.released ? 'yes' : 'no')}</div>
        </div>` : ''}
      ${nativeLifecycleStopPreflightAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleStopPreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Stop Execute</h3>
          <p>Gracefully stops only Harmony-owned native window and backend targets after a passing stop preflight.</p>
        </div>
        <button id="preview-native-lifecycle-stop-execute" type="button">Preview</button>
      </div>
      ${nativeLifecycleStopExecutePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleStopExecutePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleStopExecutePreview.summary?.stopExecuteStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Targets</span><strong>${escapeHtml(nativeLifecycleStopExecutePreview.target?.targets ?? 0)}</strong></div>
          <div class="kv"><span>Stop Digest</span><strong>${escapeHtml(nativeLifecycleStopExecuteContract?.stopPlan?.digest || nativeLifecycleStopExecutePreview.target?.stopPlanDigest || 'unknown')}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleStopExecutePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleStopExecuteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleStopExecuteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleStopExecuteGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Target', 'PID', 'Alive'], (nativeLifecycleStopExecuteContract?.targets || []).map((item) => `<tr><td>${escapeHtml(item.kind || '')}</td><td>${escapeHtml(item.pid || '')}</td><td>${escapeHtml(boolLabel(item.processAlive))}</td></tr>`), 'No stop targets selected.')}
          <label class="confirm-label" for="native-lifecycle-stop-execute-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleStopExecutePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-stop-execute-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-stop-execute" type="button">Stop Owned Targets</button>
            <button id="clear-native-lifecycle-stop-execute" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleStopExecuteReport ? `
        <div class="action-result ${nativeLifecycleStopExecuteAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle stop ${escapeHtml(nativeLifecycleStopExecuteReport.status || 'unknown')}</strong>
          <code>${escapeHtml(nativeLifecycleStopExecuteAction?.reportPath || nativeLifecycleStopExecuteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleStopExecuteAction?.executeReceipt)}
          <div>Result: ${escapeHtml(nativeLifecycleStopExecuteReport.result?.status || 'unknown')}</div>
          <div>Post health: ${escapeHtml(nativeLifecycleStopExecuteReport.result?.postHealth?.status || 'unknown')}</div>
          <div>Targets: ${escapeHtml((nativeLifecycleStopExecuteReport.result?.results || []).map((item) => `${item.kind}:${item.status}`).join(', ') || 'none')}</div>
        </div>` : ''}
      ${nativeLifecycleStopExecuteAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleStopExecuteAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Reconnect Preflight</h3>
          <p>Fixed reconnect-plan, health, backend ownership, and lifecycle checks before any future reconnect action.</p>
        </div>
        <button id="preview-native-lifecycle-reconnect-preflight" type="button">Preview</button>
      </div>
      ${nativeLifecycleReconnectPreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleReconnectPreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleReconnectPreflightPreview.summary?.reconnectPreflightStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Target</span><strong>${escapeHtml(nativeLifecycleReconnectPreflightPreview.summary?.reconnectTargetStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Reconnect Execute Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleReconnectPreflightPreview.target?.reconnectExecuteCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleReconnectPreflightPreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleReconnectPreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleReconnectPreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleReconnectPreflightGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Reconnect Check', 'Status', 'Detail'], (nativeLifecycleReconnectPreflightContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No reconnect preflight checks reported.')}
          ${table(['Required Before Future Reconnect Execute'], (nativeLifecycleReconnectPreflightContract?.requiredBeforeReconnectExecute || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No reconnect execute requirements reported.')}
          <div class="kv"><span>Reconnect Plan Digest</span><strong>${escapeHtml(nativeLifecycleReconnectPreflightContract?.reconnectPlan?.digest || nativeLifecycleReconnectPreflightPreview.summary?.reconnectPlanDigest || 'unknown')}</strong></div>
          <div class="kv"><span>Ownership</span><strong>${escapeHtml(nativeLifecycleReconnectPreflightContract?.reconnectTarget?.ownership || 'unknown')}</strong></div>
          <label class="confirm-label" for="native-lifecycle-reconnect-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleReconnectPreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-reconnect-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-reconnect-preflight" type="button">Run Preflight</button>
            <button id="clear-native-lifecycle-reconnect-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleReconnectPreflightReport ? `
        <div class="action-result ${nativeLifecycleReconnectPreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle reconnect preflight ${escapeHtml(nativeLifecycleReconnectPreflightReport.status || (nativeLifecycleReconnectPreflightAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(nativeLifecycleReconnectPreflightAction?.reportPath || nativeLifecycleReconnectPreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleReconnectPreflightAction?.executeReceipt)}
          <div>Reconnect target: ${escapeHtml(nativeLifecycleReconnectPreflightContract?.reconnectTarget?.status || 'unknown')}</div>
          <div>Health: ${escapeHtml(nativeLifecycleReconnectPreflightContract?.healthProbe?.status || 'unknown')}</div>
          <div>Lock released: ${escapeHtml(nativeLifecycleReconnectPreflightReport.lockRelease?.released ? 'yes' : 'no')}</div>
        </div>` : ''}
      ${nativeLifecycleReconnectPreflightAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleReconnectPreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Restart Preflight</h3>
          <p>Fixed restart/recovery plan checks before any future stop-then-start or start-only recovery action.</p>
        </div>
        <button id="preview-native-lifecycle-restart-preflight" type="button">Preview</button>
      </div>
      ${nativeLifecycleRestartPreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleRestartPreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleRestartPreflightPreview.summary?.restartPreflightStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Recovery</span><strong>${escapeHtml(nativeLifecycleRestartPreflightPreview.summary?.recoveryMode || 'unknown')}</strong></div>
          <div class="kv"><span>Restart Execute Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleRestartPreflightPreview.target?.restartExecuteCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleRestartPreflightPreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleRestartPreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleRestartPreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleRestartPreflightGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Restart Check', 'Status', 'Detail'], (nativeLifecycleRestartPreflightContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No restart preflight checks reported.')}
          ${table(['Required Before Future Restart Execute'], (nativeLifecycleRestartPreflightContract?.requiredBeforeRestartExecute || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No restart execute requirements reported.')}
          <div class="kv"><span>Restart Plan Digest</span><strong>${escapeHtml(nativeLifecycleRestartPreflightContract?.restartPlan?.digest || nativeLifecycleRestartPreflightPreview.summary?.restartPlanDigest || 'unknown')}</strong></div>
          <div class="kv"><span>Health</span><strong>${escapeHtml(nativeLifecycleRestartPreflightContract?.healthProbe?.status || 'unknown')}</strong></div>
          <label class="confirm-label" for="native-lifecycle-restart-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleRestartPreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-restart-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-restart-preflight" type="button">Run Preflight</button>
            <button id="clear-native-lifecycle-restart-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleRestartPreflightReport ? `
        <div class="action-result ${nativeLifecycleRestartPreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle restart preflight ${escapeHtml(nativeLifecycleRestartPreflightReport.status || (nativeLifecycleRestartPreflightAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(nativeLifecycleRestartPreflightAction?.reportPath || nativeLifecycleRestartPreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleRestartPreflightAction?.executeReceipt)}
          <div>Recovery: ${escapeHtml(nativeLifecycleRestartPreflightContract?.recovery?.mode || 'unknown')}</div>
          <div>Health: ${escapeHtml(nativeLifecycleRestartPreflightContract?.healthProbe?.status || 'unknown')}</div>
          <div>Lock released: ${escapeHtml(nativeLifecycleRestartPreflightReport.lockRelease?.released ? 'yes' : 'no')}</div>
        </div>` : ''}
      ${nativeLifecycleRestartPreflightAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleRestartPreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Restart Execute Gate</h3>
          <p>Report-only gate for future restart execute, citing restart preflight and fixed plan digest.</p>
        </div>
        <button id="preview-native-lifecycle-restart-execute-gate" type="button">Preview</button>
      </div>
      ${nativeLifecycleRestartExecuteGatePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleRestartExecuteGatePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleRestartExecuteGatePreview.summary?.restartExecuteGateStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Recovery</span><strong>${escapeHtml(nativeLifecycleRestartExecuteGatePreview.summary?.recoveryMode || 'unknown')}</strong></div>
          <div class="kv"><span>Restart Execute Allowed</span><strong>${escapeHtml(boolLabel(nativeLifecycleRestartExecuteGatePreview.target?.restartExecuteCurrentlyAllowed))}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleRestartExecuteGatePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleRestartExecuteGateWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleRestartExecuteGateChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleRestartExecuteGateGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Gate Check', 'Status', 'Detail'], (nativeLifecycleRestartExecuteGateContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No restart execute gate checks reported.')}
          ${table(['Required Before Future Restart Execute'], (nativeLifecycleRestartExecuteGateContract?.requiredBeforeRestartExecute || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No restart execute requirements reported.')}
          <div class="kv"><span>Restart Plan Digest</span><strong>${escapeHtml(nativeLifecycleRestartExecuteGateContract?.proposedFutureExecute?.restartPlanDigest || nativeLifecycleRestartExecuteGatePreview.summary?.restartPlanDigest || 'unknown')}</strong></div>
          <label class="confirm-label" for="native-lifecycle-restart-execute-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleRestartExecuteGatePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-restart-execute-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-restart-execute-gate" type="button">Create Gate</button>
            <button id="clear-native-lifecycle-restart-execute-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleRestartExecuteGateReport ? `
        <div class="action-result ${nativeLifecycleRestartExecuteGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle restart execute gate ${escapeHtml(nativeLifecycleRestartExecuteGateReport.status || (nativeLifecycleRestartExecuteGateAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(nativeLifecycleRestartExecuteGateAction?.reportPath || nativeLifecycleRestartExecuteGateReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleRestartExecuteGateAction?.executeReceipt)}
          <div>Recovery: ${escapeHtml(nativeLifecycleRestartExecuteGateContract?.proposedFutureExecute?.mode || 'unknown')}</div>
          <div>Preflight: ${escapeHtml(nativeLifecycleRestartExecuteGateContract?.latestRestartPreflight?.status || 'unknown')}</div>
        </div>` : ''}
      ${nativeLifecycleRestartExecuteGateAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleRestartExecuteGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Restart Execute</h3>
          <p>High-risk controlled restart. It composes only the approved stop execute and fixed daemon start paths when current receipts allow it.</p>
        </div>
        <button id="preview-native-lifecycle-restart-execute" type="button">Preview</button>
      </div>
      ${nativeLifecycleRestartExecutePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleRestartExecutePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleRestartExecutePreview.summary?.restartExecuteStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Recovery</span><strong>${escapeHtml(nativeLifecycleRestartExecutePreview.summary?.recoveryMode || 'unknown')}</strong></div>
          <div class="kv"><span>Stop Targets</span><strong>${escapeHtml(nativeLifecycleRestartExecutePreview.target?.stopTargets ?? 0)}</strong></div>
          <div class="kv"><span>Restart Plan Digest</span><strong>${escapeHtml(nativeLifecycleRestartExecuteContract?.restartPlan?.digest || nativeLifecycleRestartExecutePreview.summary?.restartPlanDigest || 'unknown')}</strong></div>
          <div class="kv"><span>Health</span><strong>${escapeHtml(nativeLifecycleRestartExecuteContract?.currentHealthProbe?.status || nativeLifecycleRestartExecutePreview.summary?.healthProbeStatus || 'unknown')}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleRestartExecutePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleRestartExecuteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleRestartExecuteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleRestartExecuteGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Restart Execute Check', 'Status', 'Detail'], (nativeLifecycleRestartExecuteContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No restart execute checks reported.')}
          <label class="confirm-label" for="native-lifecycle-restart-execute-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleRestartExecutePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-restart-execute-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-restart-execute" type="button">Restart Backend</button>
            <button id="clear-native-lifecycle-restart-execute" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleRestartExecuteReport ? `
        <div class="action-result ${nativeLifecycleRestartExecuteAction?.ok ? 'ok' : 'warn'}">
          <strong>Native lifecycle restart ${escapeHtml(nativeLifecycleRestartExecuteReport.status || (nativeLifecycleRestartExecuteAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(nativeLifecycleRestartExecuteAction?.reportPath || nativeLifecycleRestartExecuteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleRestartExecuteAction?.executeReceipt)}
          <div>Result: ${escapeHtml(nativeLifecycleRestartExecuteReport.result?.status || 'none')}</div>
          <div>Recovery: ${escapeHtml(nativeLifecycleRestartExecuteContract?.recoveryMode || nativeLifecycleRestartExecuteReport.result?.mode || 'unknown')}</div>
          <div>Post health: ${escapeHtml(nativeLifecycleRestartExecuteReport.result?.postHealth?.status || 'unknown')}</div>
          <div>Lock released: ${escapeHtml(nativeLifecycleRestartExecuteReport.lockRelease?.released ? 'yes' : 'no')}</div>
          ${nativeLifecycleRestartExecuteReport.error ? `<div>Error: ${escapeHtml(nativeLifecycleRestartExecuteReport.error)}</div>` : ''}
        </div>` : ''}
      ${nativeLifecycleRestartExecuteAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleRestartExecuteAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Native Lifecycle Reconnect Execute</h3>
          <p>Reattaches to an already healthy Harmony backend with matching workspace and heartbeat proof.</p>
        </div>
        <button id="preview-native-lifecycle-reconnect-execute" type="button">Preview</button>
      </div>
      ${nativeLifecycleReconnectExecutePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(nativeLifecycleReconnectExecutePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(nativeLifecycleReconnectExecutePreview.summary?.reconnectExecuteStatus || 'unknown')}</strong></div>
          <div class="kv"><span>Backend</span><strong>${escapeHtml(nativeLifecycleReconnectExecutePreview.target?.backendUrl || nativeLifecycleReconnectExecuteContract?.backend?.url || 'unknown')}</strong></div>
          <div class="kv"><span>Health</span><strong>${escapeHtml(nativeLifecycleReconnectExecuteContract?.backend?.healthProbe?.status || nativeLifecycleReconnectExecutePreview.summary?.healthProbeStatus || 'unknown')}</strong></div>
          ${renderPreviewReceipt(nativeLifecycleReconnectExecutePreview.previewReceipt)}
          ${table(['Writes'], nativeLifecycleReconnectExecuteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], nativeLifecycleReconnectExecuteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Guards'], nativeLifecycleReconnectExecuteGuards.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No guards reported.')}
          ${table(['Reconnect Check', 'Status', 'Detail'], (nativeLifecycleReconnectExecuteContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No reconnect checks reported.')}
          <label class="confirm-label" for="native-lifecycle-reconnect-execute-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(nativeLifecycleReconnectExecutePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="native-lifecycle-reconnect-execute-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-native-lifecycle-reconnect-execute" type="button">Reconnect Backend</button>
            <button id="clear-native-lifecycle-reconnect-execute" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${nativeLifecycleReconnectExecuteReport ? `
        <div class="action-result ${nativeLifecycleReconnectExecuteAction?.ok ? 'ok' : 'warn'}">
          <strong>Native backend reconnect ${escapeHtml(nativeLifecycleReconnectExecuteReport.status || 'unknown')}</strong>
          <code>${escapeHtml(nativeLifecycleReconnectExecuteAction?.reportPath || nativeLifecycleReconnectExecuteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(nativeLifecycleReconnectExecuteAction?.executeReceipt)}
          <div>Mode: ${escapeHtml(nativeLifecycleReconnectExecuteReport.result?.mode || 'none')}</div>
          <div>PID: ${escapeHtml(nativeLifecycleReconnectExecuteReport.result?.pid || nativeLifecycleReconnectExecuteReport.owner?.pid || 'unknown')}</div>
          <div>Backend: ${escapeHtml(nativeLifecycleReconnectExecuteReport.owner?.backendUrl || nativeLifecycleReconnectExecuteContract?.backend?.url || 'unknown')}</div>
        </div>` : ''}
      ${nativeLifecycleReconnectExecuteAction?.error ? `<p class="action-error">${escapeHtml(nativeLifecycleReconnectExecuteAction.error)}</p>` : ''}
    </div>
    </section>
    <section class="action-section" id="floating-chat-section">
      <div class="action-section-title">
        <h3>Floating Chat</h3>
        <p>Ask-only outside-VS note capture before response or tool authority exists.</p>
      </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Note</h3>
          <p>Saves a receipt-locked message without provider calls, tools, commands, Git, or deletion.</p>
        </div>
        <button id="preview-floating-chat-note" type="button">Preview</button>
      </div>
      <textarea id="floating-chat-note-message" rows="5" maxlength="8000" placeholder="Write the outside-VS note to capture.">${escapeHtml(floatingChatDraft)}</textarea>
      ${floatingChatPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatPreview.version || '?')}</strong></div>
          <div class="kv"><span>Message</span><strong>${escapeHtml(`${floatingChatPreview.summary?.messageChars ?? 0} chars`)}</strong></div>
          <div class="kv"><span>Hash</span><strong>${escapeHtml(floatingChatPreview.summary?.messageHash || 'unknown')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatPreview.summary?.status || 'unknown')}</strong></div>
          ${renderPreviewReceipt(floatingChatPreview.previewReceipt)}
          ${table(['Writes'], floatingChatWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="floating-chat-note-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-note-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-note" type="button">Save Note</button>
            <button id="clear-floating-chat-note" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatReport ? `
        <div class="action-result ${floatingChatNoteAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat note saved</strong>
          <code>${escapeHtml(floatingChatNoteAction?.reportPath || floatingChatReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatNoteAction?.executeReceipt)}
          <div>Status: ${escapeHtml(floatingChatReport.status || 'unknown')}</div>
          <div>Message: ${escapeHtml(floatingChatReport.message?.chars ?? 0)} chars</div>
          <div>Retention: ${escapeHtml(floatingChatReport.retention?.deletePolicy || 'unknown')}</div>
        </div>` : ''}
      ${floatingChatNoteAction?.error ? `<p class="action-error">${escapeHtml(floatingChatNoteAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Turn</h3>
          <p>Captures a conversation turn and queues a response handoff while response authority stays blocked.</p>
        </div>
        <button id="preview-floating-chat-turn" type="button">Preview</button>
      </div>
      <input id="floating-chat-turn-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID (optional)" value="${escapeHtml(floatingChatConversationId)}" />
      <textarea id="floating-chat-turn-message" rows="5" maxlength="8000" placeholder="Write the outside-VS conversation turn.">${escapeHtml(floatingChatTurnDraft)}</textarea>
      ${floatingChatTurnPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatTurnPreview.version || '?')}</strong></div>
          <div class="kv"><span>Conversation</span><strong>${escapeHtml(floatingChatTurnPreview.summary?.conversationId || 'new')}</strong></div>
          <div class="kv"><span>Message</span><strong>${escapeHtml(`${floatingChatTurnPreview.summary?.messageChars ?? 0} chars`)}</strong></div>
          <div class="kv"><span>Hash</span><strong>${escapeHtml(floatingChatTurnPreview.summary?.messageHash || 'unknown')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatTurnPreview.summary?.status || 'unknown')}</strong></div>
          ${renderPreviewReceipt(floatingChatTurnPreview.previewReceipt)}
          ${table(['Writes'], floatingChatTurnWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatTurnChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="floating-chat-turn-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatTurnPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-turn-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-turn" type="button">Capture Turn</button>
            <button id="clear-floating-chat-turn" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatTurnReport ? `
        <div class="action-result ${floatingChatTurnAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat turn captured</strong>
          <code>${escapeHtml(floatingChatTurnAction?.reportPath || floatingChatTurnReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatTurnAction?.executeReceipt)}
          <div>Conversation: ${escapeHtml(floatingChatTurnReport.conversation?.id || 'unknown')}</div>
          <div>Turns: ${escapeHtml(floatingChatTurnReport.conversation?.turnCount ?? 0)}</div>
          <div>Response: ${escapeHtml(floatingChatTurnReport.responseRequest?.status || 'unknown')}</div>
          <div>Retention: ${escapeHtml(floatingChatTurnReport.retention?.deletePolicy || 'unknown')}</div>
        </div>` : ''}
      ${floatingChatTurnAction?.error ? `<p class="action-error">${escapeHtml(floatingChatTurnAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Response Gate</h3>
          <p>Records response-readiness requirements while provider calls and tool execution stay blocked.</p>
        </div>
        <button id="preview-floating-chat-response-gate" type="button">Preview</button>
      </div>
      <input id="floating-chat-response-gate-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID (optional)" value="${escapeHtml(floatingChatResponseGateConversationId)}" />
      ${floatingChatResponseGatePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatResponseGatePreview.version || '?')}</strong></div>
          <div class="kv"><span>Posture</span><strong>${escapeHtml(floatingChatResponseGatePreview.summary?.posture || 'unknown')}</strong></div>
          <div class="kv"><span>Response request</span><strong>${escapeHtml(floatingChatResponseGatePreview.summary?.responseRequestStatus || 'none')}</strong></div>
          <div class="kv"><span>Providers</span><strong>${escapeHtml(`${floatingChatResponseGatePreview.summary?.configuredProviders ?? 0}/${floatingChatResponseGatePreview.summary?.totalProviders ?? 0}`)}</strong></div>
          <div class="kv"><span>Response execute</span><strong>${boolLabel(floatingChatResponseGatePreview.summary?.responseExecuteCurrentlyAllowed)}</strong></div>
          ${renderPreviewReceipt(floatingChatResponseGatePreview.previewReceipt)}
          ${table(['Writes'], floatingChatResponseGateWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatResponseGateChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (floatingChatResponseGateContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No contract checks reported.')}
          <label class="confirm-label" for="floating-chat-response-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatResponseGatePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-response-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-response-gate" type="button">Record Gate</button>
            <button id="clear-floating-chat-response-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatResponseGateReport ? `
        <div class="action-result ${floatingChatResponseGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat response gate recorded</strong>
          <code>${escapeHtml(floatingChatResponseGateAction?.reportPath || floatingChatResponseGateReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatResponseGateAction?.executeReceipt)}
          <div>Posture: ${escapeHtml(floatingChatResponseGateContract?.posture || 'unknown')}</div>
          <div>Response request: ${escapeHtml(floatingChatResponseGateContract?.latestResponseRequest?.file || 'none')}</div>
          <div>Response execute: ${boolLabel(floatingChatResponseGateContract?.responseExecuteCurrentlyAllowed)}</div>
        </div>` : ''}
      ${floatingChatResponseGateAction?.error ? `<p class="action-error">${escapeHtml(floatingChatResponseGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Response Preflight</h3>
          <p>Checks response request, gate, policy, budget, and provider metadata without executing a response.</p>
        </div>
        <button id="preview-floating-chat-response-preflight" type="button">Preview</button>
      </div>
      <input id="floating-chat-response-preflight-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID (optional)" value="${escapeHtml(floatingChatResponsePreflightConversationId)}" />
      ${floatingChatResponsePreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatResponsePreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatResponsePreflightPreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Request</span><strong>${escapeHtml(floatingChatResponsePreflightPreview.summary?.responseRequestStatus || 'none')}</strong></div>
          <div class="kv"><span>Gate</span><strong>${escapeHtml(floatingChatResponsePreflightPreview.summary?.responseGateStatus || 'none')}</strong></div>
          <div class="kv"><span>Paid providers</span><strong>${boolLabel(floatingChatResponsePreflightPreview.summary?.paidProviderCalls)}</strong></div>
          <div class="kv"><span>Executable providers</span><strong>${escapeHtml(floatingChatResponsePreflightPreview.summary?.executableConfiguredProviders ?? 0)}</strong></div>
          <div class="kv"><span>Response execute</span><strong>${boolLabel(floatingChatResponsePreflightPreview.summary?.responseExecuteCurrentlyAllowed)}</strong></div>
          ${renderPreviewReceipt(floatingChatResponsePreflightPreview.previewReceipt)}
          ${table(['Writes'], floatingChatResponsePreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatResponsePreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (floatingChatResponsePreflightContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No preflight checks reported.')}
          <label class="confirm-label" for="floating-chat-response-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatResponsePreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-response-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-response-preflight" type="button">Run Preflight</button>
            <button id="clear-floating-chat-response-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatResponsePreflightReport ? `
        <div class="action-result ${floatingChatResponsePreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat response preflight recorded</strong>
          <code>${escapeHtml(floatingChatResponsePreflightAction?.reportPath || floatingChatResponsePreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatResponsePreflightAction?.executeReceipt)}
          <div>Status: ${escapeHtml(floatingChatResponsePreflightContract?.status || floatingChatResponsePreflightReport.status || 'unknown')}</div>
          <div>Gate: ${escapeHtml(floatingChatResponsePreflightContract?.latestResponseGate?.file || 'none')}</div>
          <div>Response execute: ${boolLabel(floatingChatResponsePreflightContract?.responseExecuteCurrentlyAllowed)}</div>
        </div>` : ''}
      ${floatingChatResponsePreflightAction?.error ? `<p class="action-error">${escapeHtml(floatingChatResponsePreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Response Execute</h3>
          <p>Calls one configured provider after preview receipt, exact confirmation, policy, budget, and credential checks.</p>
        </div>
        <button id="preview-floating-chat-response-execute" type="button">Preview</button>
      </div>
      <div class="response-input-grid">
        <input id="floating-chat-response-execute-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID (optional)" value="${escapeHtml(floatingChatResponseExecuteConversationId)}" />
        <input id="floating-chat-response-execute-provider" autocomplete="off" spellcheck="false" maxlength="40" placeholder="Provider: auto, gemini, openrouter..." value="${escapeHtml(floatingChatResponseExecuteProvider)}" />
        <input id="floating-chat-response-execute-model" autocomplete="off" spellcheck="false" maxlength="120" placeholder="Model override (optional)" value="${escapeHtml(floatingChatResponseExecuteModel)}" />
        <input id="floating-chat-response-execute-max-tokens" autocomplete="off" inputmode="numeric" maxlength="5" placeholder="Max tokens" value="${escapeHtml(floatingChatResponseExecuteMaxTokens)}" />
      </div>
      ${floatingChatResponseExecutePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatResponseExecutePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatResponseExecutePreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Provider</span><strong>${escapeHtml(providerDisplayName(floatingChatResponseExecutePreview.summary?.provider))}</strong></div>
          <div class="kv"><span>Model</span><strong>${escapeHtml(floatingChatResponseExecutePreview.summary?.model || 'default')}</strong></div>
          <div class="kv"><span>Prompt</span><strong>${escapeHtml(floatingChatResponseExecutePreview.summary?.promptHash || 'none')}</strong></div>
          <div class="kv"><span>Budget</span><strong>${escapeHtml(floatingChatResponseExecutePreview.summary?.budget ?? 0)}</strong></div>
          <div class="kv"><span>Provider call</span><strong>${boolLabel(floatingChatResponseExecutePreview.summary?.responseExecuteCurrentlyAllowed)}</strong></div>
          ${renderPreviewReceipt(floatingChatResponseExecutePreview.previewReceipt)}
          ${table(['Writes'], floatingChatResponseExecuteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatResponseExecuteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (floatingChatResponseExecuteContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No response execute checks reported.')}
          <label class="confirm-label" for="floating-chat-response-execute-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatResponseExecutePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-response-execute-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-response-execute" type="button">Call Provider</button>
            <button id="clear-floating-chat-response-execute" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatResponseExecuteReport ? `
        <div class="action-result ${floatingChatResponseExecuteAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat response ${escapeHtml(floatingChatResponseExecuteReport.status || 'unknown')}</strong>
          <code>${escapeHtml(floatingChatResponseExecuteAction?.reportPath || floatingChatResponseExecuteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatResponseExecuteAction?.executeReceipt)}
          <div>Provider call: ${escapeHtml(floatingChatResponseExecuteReport.providerCall?.performed ? 'performed' : 'not performed')}</div>
          <div>Provider: ${escapeHtml(providerDisplayName(floatingChatResponseExecuteReport.providerCall?.provider || floatingChatResponseExecuteContract?.provider?.provider))}</div>
          <div>Model: ${escapeHtml(floatingChatResponseExecuteReport.providerCall?.model || floatingChatResponseExecuteContract?.provider?.model || 'unknown')}</div>
          <div>Conversation: ${escapeHtml(floatingChatResponseExecuteReport.conversation?.id || 'unknown')}</div>
          ${floatingChatResponseExecuteReport.providerCall?.error ? `<p class="action-error">${escapeHtml(floatingChatResponseExecuteReport.providerCall.error)}</p>` : ''}
          ${floatingChatResponseExecuteReport.response?.message?.text ? `<pre class="response-output">${escapeHtml(floatingChatResponseExecuteReport.response.message.text)}</pre>` : ''}
        </div>` : ''}
      ${floatingChatResponseExecuteAction?.error ? `<p class="action-error">${escapeHtml(floatingChatResponseExecuteAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Tool Preflight</h3>
          <p>Checks a provider-suggested or pasted tool request without running the tool.</p>
        </div>
        <button id="preview-floating-chat-tool-preflight" type="button">Preview</button>
      </div>
      <input id="floating-chat-tool-preflight-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID" value="${escapeHtml(floatingChatToolPreflightConversationId)}" />
      <textarea id="floating-chat-tool-preflight-request" rows="4" placeholder='Optional tool request JSON, for example { "tool": "grep", "path": "package.json", "pattern": "harmony-extension" }'>${escapeHtml(floatingChatToolPreflightRequest)}</textarea>
      ${floatingChatToolPreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatToolPreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatToolPreflightPreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Source</span><strong>${escapeHtml(floatingChatToolPreflightPreview.summary?.source || 'unknown')}</strong></div>
          <div class="kv"><span>Tool</span><strong>${escapeHtml(floatingChatToolPreflightPreview.summary?.tool || 'unknown')}</strong></div>
          <div class="kv"><span>Path</span><code>${escapeHtml(floatingChatToolPreflightPreview.summary?.path || '')}</code></div>
          <div class="kv"><span>Policy gate</span><strong>${escapeHtml(floatingChatToolPreflightPreview.summary?.policyGate || 'missing')}</strong></div>
          <div class="kv"><span>Executes tool</span><strong>${boolLabel(floatingChatToolPreflightPreview.summary?.toolExecution)}</strong></div>
          ${renderPreviewReceipt(floatingChatToolPreflightPreview.previewReceipt)}
          ${table(['Writes'], floatingChatToolPreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatToolPreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (floatingChatToolPreflightContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No tool preflight checks reported.')}
          ${table(['Required Before Tool Execution'], (floatingChatToolPreflightContract?.requiredBeforeToolExecution || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No execution requirements reported.')}
          <label class="confirm-label" for="floating-chat-tool-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatToolPreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-tool-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-tool-preflight" type="button">Record Preflight</button>
            <button id="clear-floating-chat-tool-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatToolPreflightReport ? `
        <div class="action-result ${floatingChatToolPreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat tool preflight ${escapeHtml(floatingChatToolPreflightReport.status || 'unknown')}</strong>
          <code>${escapeHtml(floatingChatToolPreflightAction?.reportPath || floatingChatToolPreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatToolPreflightAction?.executeReceipt)}
          <div>Tool: ${escapeHtml(floatingChatToolPreflightContract?.candidate?.tool || 'unknown')}</div>
          <div>Tool execution: ${boolLabel(floatingChatToolPreflightReport.toolExecution?.performed)}</div>
          <div>Provider call: ${boolLabel(floatingChatToolPreflightReport.providerCall?.performed)}</div>
        </div>` : ''}
      ${floatingChatToolPreflightAction?.error ? `<p class="action-error">${escapeHtml(floatingChatToolPreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Tool Loop Preflight</h3>
          <p>Plans provider-suggested read-only tool steps without running providers or tools.</p>
        </div>
        <button id="preview-floating-chat-tool-loop-preflight" type="button">Preview</button>
      </div>
      <input id="floating-chat-tool-loop-preflight-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID" value="${escapeHtml(floatingChatToolLoopPreflightConversationId)}" />
      <textarea id="floating-chat-tool-loop-preflight-request" rows="5" placeholder='Optional loop JSON, for example { "tool_calls": [{ "tool": "read-file", "path": "package.json" }] }'>${escapeHtml(floatingChatToolLoopPreflightRequest)}</textarea>
      <input id="floating-chat-tool-loop-preflight-max-steps" autocomplete="off" inputmode="numeric" maxlength="2" placeholder="Max steps" value="${escapeHtml(floatingChatToolLoopPreflightMaxSteps)}" />
      ${floatingChatToolLoopPreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatToolLoopPreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatToolLoopPreflightPreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Source</span><strong>${escapeHtml(floatingChatToolLoopPreflightPreview.summary?.source || 'unknown')}</strong></div>
          <div class="kv"><span>Planned steps</span><strong>${escapeHtml(floatingChatToolLoopPreflightPreview.summary?.plannedSteps ?? 0)}</strong></div>
          <div class="kv"><span>Autonomous loops</span><strong>${boolLabel(floatingChatToolLoopPreflightPreview.summary?.autonomousLoops)}</strong></div>
          <div class="kv"><span>Executes loop</span><strong>${boolLabel(floatingChatToolLoopPreflightPreview.summary?.loopExecution)}</strong></div>
          ${renderPreviewReceipt(floatingChatToolLoopPreflightPreview.previewReceipt)}
          ${table(['Writes'], floatingChatToolLoopPreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatToolLoopPreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Step', 'Status', 'Tool', 'Path', 'Pattern'], floatingChatToolLoopPreflightSteps.map((item) => `<tr><td>${escapeHtml(item.index || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.tool || '')}</td><td><code>${escapeHtml(item.path || '')}</code></td><td>${escapeHtml(item.pattern || '')}</td></tr>`), 'No loop steps planned.')}
          ${table(['Required Before Loop Execution'], (floatingChatToolLoopPreflightContract?.requiredBeforeLoopExecution || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No loop execution requirements reported.')}
          <label class="confirm-label" for="floating-chat-tool-loop-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatToolLoopPreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-tool-loop-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-tool-loop-preflight" type="button">Record Loop Plan</button>
            <button id="clear-floating-chat-tool-loop-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatToolLoopPreflightReport ? `
        <div class="action-result ${floatingChatToolLoopPreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat tool-loop preflight ${escapeHtml(floatingChatToolLoopPreflightReport.status || 'unknown')}</strong>
          <code>${escapeHtml(floatingChatToolLoopPreflightAction?.reportPath || floatingChatToolLoopPreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatToolLoopPreflightAction?.executeReceipt)}
          <div>Planned steps: ${escapeHtml(floatingChatToolLoopPreflightSteps.length)}</div>
          <div>Tool execution: ${boolLabel(floatingChatToolLoopPreflightReport.toolExecution?.performed)}</div>
          <div>Provider call: ${boolLabel(floatingChatToolLoopPreflightReport.providerCall?.performed)}</div>
        </div>` : ''}
      ${floatingChatToolLoopPreflightAction?.error ? `<p class="action-error">${escapeHtml(floatingChatToolLoopPreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Tool Loop Execute</h3>
          <p>Runs one approved read-only loop step per preview receipt, then stops.</p>
        </div>
        <button id="preview-floating-chat-tool-loop-execute" type="button">Preview</button>
      </div>
      <input id="floating-chat-tool-loop-execute-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID" value="${escapeHtml(floatingChatToolLoopExecuteConversationId || floatingChatToolLoopPreflightConversationId)}" />
      <textarea id="floating-chat-tool-loop-execute-request" rows="5" placeholder='Optional loop JSON, for example { "tool_calls": [{ "tool": "read-file", "path": "package.json" }] }'>${escapeHtml(floatingChatToolLoopExecuteRequest || floatingChatToolLoopPreflightRequest)}</textarea>
      <div class="input-grid">
        <input id="floating-chat-tool-loop-execute-max-steps" autocomplete="off" inputmode="numeric" maxlength="2" placeholder="Max planned steps" value="${escapeHtml(floatingChatToolLoopExecuteMaxSteps)}" />
        <input id="floating-chat-tool-loop-execute-step-index" autocomplete="off" inputmode="numeric" maxlength="2" placeholder="Step index" value="${escapeHtml(floatingChatToolLoopExecuteStepIndex)}" />
        <input id="floating-chat-tool-loop-execute-max-result-chars" autocomplete="off" inputmode="numeric" maxlength="5" placeholder="Max result chars" value="${escapeHtml(floatingChatToolLoopExecuteMaxResultChars)}" />
      </div>
      ${floatingChatToolLoopExecutePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatToolLoopExecutePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatToolLoopExecutePreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Selected step</span><strong>${escapeHtml(floatingChatToolLoopExecutePreview.summary?.stepIndex ?? 0)}</strong></div>
          <div class="kv"><span>Tool</span><strong>${escapeHtml(floatingChatToolLoopExecutePreview.summary?.tool || 'unknown')}</strong></div>
          <div class="kv"><span>Path</span><code>${escapeHtml(floatingChatToolLoopExecutePreview.summary?.path || '')}</code></div>
          <div class="kv"><span>One step per receipt</span><strong>${boolLabel(floatingChatToolLoopExecutePreview.summary?.oneStepPerReceipt)}</strong></div>
          <div class="kv"><span>Read-only</span><strong>${boolLabel(floatingChatToolLoopExecutePreview.summary?.readOnly)}</strong></div>
          ${renderPreviewReceipt(floatingChatToolLoopExecutePreview.previewReceipt)}
          ${table(['Writes'], floatingChatToolLoopExecuteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatToolLoopExecuteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Stop Condition'], (floatingChatToolLoopExecuteContract?.stopConditions || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No stop conditions reported.')}
          <label class="confirm-label" for="floating-chat-tool-loop-execute-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatToolLoopExecutePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-tool-loop-execute-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-tool-loop-execute" type="button">Run One Step</button>
            <button id="clear-floating-chat-tool-loop-execute" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatToolLoopExecuteReport ? `
        <div class="action-result ${floatingChatToolLoopExecuteAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat tool-loop execute ${escapeHtml(floatingChatToolLoopExecuteReport.status || 'unknown')}</strong>
          <code>${escapeHtml(floatingChatToolLoopExecuteAction?.reportPath || floatingChatToolLoopExecuteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatToolLoopExecuteAction?.executeReceipt)}
          <div>Executed steps: ${escapeHtml(floatingChatToolLoopExecuteReport.loopExecution?.executedSteps ?? 0)}</div>
          <div>Stop reason: ${escapeHtml(floatingChatToolLoopExecuteReport.loopExecution?.stopReason || '')}</div>
          <div>Tool: ${escapeHtml(floatingChatToolLoopExecuteReport.toolExecution?.tool || 'unknown')}</div>
          <div>Tool result id: ${escapeHtml(floatingChatToolLoopExecuteReport.conversation?.toolTurnId || '')}</div>
          <div>Provider call: ${boolLabel(floatingChatToolLoopExecuteReport.providerCall?.performed)}</div>
          ${floatingChatToolLoopExecuteReport.conversation?.toolTurnId ? `<button id="use-loop-result-for-source-write-preflight" class="secondary" type="button">Use for Source Preflight</button>` : ''}
          ${floatingChatToolLoopHasNextStep ? `<button id="use-next-floating-chat-tool-loop-step" class="secondary" type="button">Set Step ${escapeHtml(floatingChatToolLoopNextStep)}</button>` : ''}
        </div>` : ''}
      ${floatingChatToolLoopExecuteAction?.error ? `<p class="action-error">${escapeHtml(floatingChatToolLoopExecuteAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Source-Write Preflight</h3>
          <p>Report-only diff preview for a possible source edit after a read-only tool result.</p>
        </div>
        <button id="preview-source-write-preflight" type="button">Preview</button>
      </div>
      <input id="source-write-preflight-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID" value="${escapeHtml(sourceWritePreflightConversationId || floatingChatToolLoopExecuteConversationId)}" />
      <input id="source-write-preflight-tool-result" autocomplete="off" spellcheck="false" maxlength="160" placeholder="Tool result id" value="${escapeHtml(sourceWritePreflightToolResultId)}" />
      <input id="source-write-preflight-target" autocomplete="off" spellcheck="false" maxlength="220" placeholder="Existing workspace text file" value="${escapeHtml(sourceWritePreflightTargetPath)}" />
      <input id="source-write-preflight-validation" autocomplete="off" spellcheck="false" maxlength="300" placeholder="Optional validation command text" value="${escapeHtml(sourceWritePreflightValidationCommand)}" />
      <textarea id="source-write-preflight-proposed-content" rows="6" maxlength="30000" placeholder="Proposed full replacement content for preflight only">${escapeHtml(sourceWritePreflightProposedContent)}</textarea>
      ${sourceWritePreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(sourceWritePreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(sourceWritePreflightPreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Path</span><code>${escapeHtml(sourceWritePreflightPreview.summary?.path || '')}</code></div>
          <div class="kv"><span>Report only</span><strong>${boolLabel(sourceWritePreflightPreview.summary?.reportOnly)}</strong></div>
          <div class="kv"><span>Source writes</span><strong>${boolLabel(sourceWritePreflightPreview.summary?.sourceFileWrites)}</strong></div>
          <div class="kv"><span>Diff</span><strong>${escapeHtml(`${sourceWritePreflightPreview.summary?.removedLines ?? 0} removed / ${sourceWritePreflightPreview.summary?.addedLines ?? 0} added`)}</strong></div>
          ${renderPreviewReceipt(sourceWritePreflightPreview.previewReceipt)}
          ${table(['Writes'], sourceWritePreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], sourceWritePreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (sourceWritePreflightContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No source-write preflight checks reported.')}
          <pre class="response-output">${escapeHtml(sourceWritePreflightContract?.diffPreview?.preview || '')}</pre>
          <label class="confirm-label" for="source-write-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(sourceWritePreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="source-write-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-source-write-preflight" type="button">Record Preflight</button>
            <button id="clear-source-write-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${sourceWritePreflightReport ? `
        <div class="action-result ${sourceWritePreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Source-write preflight ${escapeHtml(sourceWritePreflightReport.status || 'unknown')}</strong>
          <code>${escapeHtml(sourceWritePreflightAction?.reportPath || sourceWritePreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(sourceWritePreflightAction?.executeReceipt)}
          <div>Write performed: ${boolLabel(sourceWritePreflightReport.write?.performed)}</div>
          <div>Provider call: ${boolLabel(sourceWritePreflightReport.providerCall?.performed)}</div>
          <div>Terminal command: ${boolLabel(sourceWritePreflightReport.terminalCommand?.performed)}</div>
          <div>Git warning: ${escapeHtml(sourceWritePreflightContract?.git?.warning || '')}</div>
          <button id="use-preflight-for-source-write-execute" class="secondary" type="button">Use for Source Execute</button>
        </div>` : ''}
      ${sourceWritePreflightAction?.error ? `<p class="action-error">${escapeHtml(sourceWritePreflightAction.error)}</p>` : ''}
    </div>
    <div class="action-card high-risk">
      <div class="action-header">
        <div>
          <h3>Source-Write Execute</h3>
          <p>High-risk single-file write from a recorded source-write preflight report.</p>
        </div>
        <button id="preview-source-write-execute" type="button">Preview</button>
      </div>
      <input id="source-write-execute-preflight-report" autocomplete="off" spellcheck="false" maxlength="260" placeholder="Source-write preflight report path" value="${escapeHtml(sourceWriteExecutePreflightReportPath || sourceWritePreflightAction?.reportPath || '')}" />
      <textarea id="source-write-execute-proposed-content" rows="6" maxlength="30000" placeholder="Exact proposed replacement content from the preflight">${escapeHtml(sourceWriteExecuteProposedContent || sourceWritePreflightProposedContent)}</textarea>
      ${sourceWriteExecutePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(sourceWriteExecutePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(sourceWriteExecutePreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Path</span><code>${escapeHtml(sourceWriteExecutePreview.summary?.path || '')}</code></div>
          <div class="kv"><span>Source writes</span><strong>${boolLabel(sourceWriteExecutePreview.summary?.sourceFileWrites)}</strong></div>
          <div class="kv"><span>Snapshot required</span><strong>${boolLabel(sourceWriteExecutePreview.summary?.snapshotRequired)}</strong></div>
          <div class="kv"><span>Lock required</span><strong>${boolLabel(sourceWriteExecutePreview.summary?.lockRequired)}</strong></div>
          ${renderPreviewReceipt(sourceWriteExecutePreview.previewReceipt)}
          ${table(['Writes'], sourceWriteExecuteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], sourceWriteExecuteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (sourceWriteExecuteContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No source-write execute checks reported.')}
          <label class="confirm-label" for="source-write-execute-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(sourceWriteExecutePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="source-write-execute-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-source-write-execute" type="button">Execute Source Write</button>
            <button id="clear-source-write-execute" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${sourceWriteExecuteReport ? `
        <div class="action-result ${sourceWriteExecuteAction?.ok ? 'ok' : 'warn'}">
          <strong>Source-write execute ${escapeHtml(sourceWriteExecuteReport.status || 'unknown')}</strong>
          <code>${escapeHtml(sourceWriteExecuteAction?.reportPath || sourceWriteExecuteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(sourceWriteExecuteAction?.executeReceipt)}
          <div>Write performed: ${boolLabel(sourceWriteExecuteReport.write?.performed)}</div>
          <div>Snapshot: ${escapeHtml(sourceWriteExecuteReport.snapshot?.id || '')}</div>
          <div>Provider call: ${boolLabel(sourceWriteExecuteReport.providerCall?.performed)}</div>
          <div>Terminal command: ${boolLabel(sourceWriteExecuteReport.terminalCommand?.performed)}</div>
          <div>Git mutation: ${boolLabel(sourceWriteExecuteReport.gitMutation?.performed)}</div>
        </div>` : ''}
      ${sourceWriteExecuteAction?.error ? `<p class="action-error">${escapeHtml(sourceWriteExecuteAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Autonomy Next</h3>
          <p>Chooses the next safe floating-chat action without executing it.</p>
        </div>
        <button id="preview-floating-chat-autonomy-next" type="button">Preview</button>
      </div>
      <input id="floating-chat-autonomy-next-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID" value="${escapeHtml(floatingChatAutonomyNextConversationId)}" />
      ${floatingChatAutonomyNextPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatAutonomyNextPreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatAutonomyNextPreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Next action</span><strong>${escapeHtml(floatingChatAutonomyNextPreview.summary?.proposedNextAction || 'unknown')}</strong></div>
          <div class="kv"><span>Provider calls</span><strong>${boolLabel(floatingChatAutonomyNextPreview.summary?.providerCalls)}</strong></div>
          <div class="kv"><span>Tool execution</span><strong>${boolLabel(floatingChatAutonomyNextPreview.summary?.toolExecution)}</strong></div>
          <div class="kv"><span>Reason</span><span>${escapeHtml(floatingChatAutonomyNextPreview.summary?.reason || '')}</span></div>
          ${renderPreviewReceipt(floatingChatAutonomyNextPreview.previewReceipt)}
          ${table(['Writes'], floatingChatAutonomyNextWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatAutonomyNextChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Required Before Follow-up'], (floatingChatAutonomyNextContract?.requiredBeforeAutonomousFollowUp || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No follow-up requirements reported.')}
          <label class="confirm-label" for="floating-chat-autonomy-next-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatAutonomyNextPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-autonomy-next-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-autonomy-next" type="button">Record Next Step</button>
            <button id="clear-floating-chat-autonomy-next" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatAutonomyNextReport ? `
        <div class="action-result ${floatingChatAutonomyNextAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat autonomy next ${escapeHtml(floatingChatAutonomyNextReport.status || 'unknown')}</strong>
          <code>${escapeHtml(floatingChatAutonomyNextAction?.reportPath || floatingChatAutonomyNextReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatAutonomyNextAction?.executeReceipt)}
          <div>Next action: ${escapeHtml(floatingChatAutonomyNextContract?.proposedNextAction?.kind || 'unknown')}</div>
          <div>Provider call: ${boolLabel(floatingChatAutonomyNextReport.providerCall?.performed)}</div>
          <div>Tool execution: ${boolLabel(floatingChatAutonomyNextReport.toolExecution?.performed)}</div>
        </div>` : ''}
      ${floatingChatAutonomyNextAction?.error ? `<p class="action-error">${escapeHtml(floatingChatAutonomyNextAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Floating Chat Read-Only Tool</h3>
          <p>Runs one workspace inspection tool through the outside tool policy gate, then appends the result to an existing conversation.</p>
        </div>
        <button id="preview-floating-chat-tool-execute" type="button">Preview</button>
      </div>
      <div class="response-input-grid">
        <input id="floating-chat-tool-execute-conversation" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Conversation ID" value="${escapeHtml(floatingChatToolExecuteConversationId)}" />
        <input id="floating-chat-tool-execute-tool" autocomplete="off" spellcheck="false" maxlength="20" placeholder="Tool: list-dir, read-file, grep" value="${escapeHtml(floatingChatToolExecuteTool)}" />
        <input id="floating-chat-tool-execute-path" autocomplete="off" spellcheck="false" maxlength="200" placeholder="Workspace path" value="${escapeHtml(floatingChatToolExecutePath)}" />
        <input id="floating-chat-tool-execute-pattern" autocomplete="off" spellcheck="false" maxlength="120" placeholder="Pattern for grep" value="${escapeHtml(floatingChatToolExecutePattern)}" />
        <input id="floating-chat-tool-execute-max-chars" autocomplete="off" inputmode="numeric" maxlength="6" placeholder="Max chars" value="${escapeHtml(floatingChatToolExecuteMaxChars)}" />
        <input id="floating-chat-tool-execute-max-matches" autocomplete="off" inputmode="numeric" maxlength="4" placeholder="Max matches" value="${escapeHtml(floatingChatToolExecuteMaxMatches)}" />
      </div>
      ${floatingChatToolExecutePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(floatingChatToolExecutePreview.version || '?')}</strong></div>
          <div class="kv"><span>Status</span><strong>${escapeHtml(floatingChatToolExecutePreview.summary?.status || 'unknown')}</strong></div>
          <div class="kv"><span>Tool</span><strong>${escapeHtml(floatingChatToolExecutePreview.summary?.tool || 'unknown')}</strong></div>
          <div class="kv"><span>Path</span><code>${escapeHtml(floatingChatToolExecutePreview.summary?.path || '')}</code></div>
          <div class="kv"><span>Policy gate</span><strong>${escapeHtml(floatingChatToolExecutePreview.summary?.policyGate || 'missing')}</strong></div>
          <div class="kv"><span>Read only</span><strong>${boolLabel(floatingChatToolExecutePreview.summary?.readOnly)}</strong></div>
          ${renderPreviewReceipt(floatingChatToolExecutePreview.previewReceipt)}
          ${table(['Writes'], floatingChatToolExecuteWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], floatingChatToolExecuteChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Check', 'Status', 'Detail'], (floatingChatToolExecuteContract?.checks || []).map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`), 'No tool checks reported.')}
          <label class="confirm-label" for="floating-chat-tool-execute-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(floatingChatToolExecutePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="floating-chat-tool-execute-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-floating-chat-tool-execute" type="button">Run Tool</button>
            <button id="clear-floating-chat-tool-execute" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${floatingChatToolExecuteReport ? `
        <div class="action-result ${floatingChatToolExecuteAction?.ok ? 'ok' : 'warn'}">
          <strong>Floating chat tool ${escapeHtml(floatingChatToolExecuteReport.status || 'unknown')}</strong>
          <code>${escapeHtml(floatingChatToolExecuteAction?.reportPath || floatingChatToolExecuteReport.reportPath || '')}</code>
          ${renderExecuteReceipt(floatingChatToolExecuteAction?.executeReceipt)}
          <div>Tool: ${escapeHtml(floatingChatToolExecuteReport.toolExecution?.tool || floatingChatToolExecuteContract?.tool?.name || 'unknown')}</div>
          <div>Performed: ${boolLabel(floatingChatToolExecuteReport.toolExecution?.performed)}</div>
          <div>Conversation: ${escapeHtml(floatingChatToolExecuteReport.conversation?.id || floatingChatToolExecuteContract?.conversationId || 'unknown')}</div>
          <div>Result chars: ${escapeHtml(floatingChatToolExecuteReport.toolExecution?.resultChars ?? 0)}</div>
          ${floatingChatToolExecuteReport.error ? `<p class="action-error">${escapeHtml(floatingChatToolExecuteReport.error)}</p>` : ''}
        </div>` : ''}
      ${floatingChatToolExecuteAction?.error ? `<p class="action-error">${escapeHtml(floatingChatToolExecuteAction.error)}</p>` : ''}
    </div>
    </section>
    <section class="action-section">
      <div class="action-section-title">
        <h3>Autonomy And Commits</h3>
        <p>Expert-gated multi-proposal and manifest-only commit contracts.</p>
      </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Autonomy/Commit Gate</h3>
          <p>Creates the default-off contract for future autonomous loops and in-swarm commits.</p>
        </div>
        <button id="preview-autonomy-commit-gate" type="button">Preview</button>
      </div>
      ${autonomyCommitPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(autonomyCommitPreview.version || '?')}</strong></div>
          <div class="kv"><span>Posture</span><strong>${escapeHtml(autonomyCommitPreview.summary?.posture || 'unknown')}</strong></div>
          <div class="kv"><span>Autonomy</span><strong>${escapeHtml(autonomyCommitPreview.summary?.autonomousLoops ? 'allowed' : 'blocked')}</strong></div>
          <div class="kv"><span>Git mutations</span><strong>${escapeHtml(autonomyCommitPreview.summary?.gitMutations ? 'allowed' : 'blocked')}</strong></div>
          ${renderPreviewReceipt(autonomyCommitPreview.previewReceipt)}
          ${table(['Writes'], autonomyCommitWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], autonomyCommitChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Required Before Autonomy'], (autonomyCommitContract?.requiredBeforeAutonomy || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No autonomy requirements reported.')}
          ${table(['Required Before Commit'], (autonomyCommitContract?.requiredBeforeCommit || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No commit requirements reported.')}
          <label class="confirm-label" for="autonomy-commit-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(autonomyCommitPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="autonomy-commit-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-autonomy-commit-gate" type="button">Create Gate</button>
            <button id="clear-autonomy-commit-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${autonomyCommitReport ? `
        <div class="action-result ${autonomyCommitGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Autonomy/commit gate created</strong>
          <code>${escapeHtml(autonomyCommitGateAction?.reportPath || autonomyCommitReport.reportPath || '')}</code>
          ${renderExecuteReceipt(autonomyCommitGateAction?.executeReceipt)}
          <div>Posture: ${escapeHtml(autonomyCommitReport.contract?.posture || 'unknown')}</div>
          <div>Autonomy: ${escapeHtml(autonomyCommitReport.contract?.currentPermissions?.autonomousLoops ? 'allowed' : 'blocked')}</div>
          <div>Git mutations: ${escapeHtml(autonomyCommitReport.contract?.currentPermissions?.gitMutations ? 'allowed' : 'blocked')}</div>
        </div>` : ''}
      ${autonomyCommitGateAction?.error ? `<p class="action-error">${escapeHtml(autonomyCommitGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Outside Tool Policy Gate</h3>
          <p>Classifies future outside-VS tool authority without executing tools, commands, providers, git, package installs, editor reloads, or chat deletion.</p>
        </div>
        <button id="preview-outside-tool-policy-gate" type="button">Preview</button>
      </div>
      ${outsideToolPolicyPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(outsideToolPolicyPreview.version || '?')}</strong></div>
          <div class="kv"><span>Policy</span><strong>${escapeHtml(outsideToolPolicyPreview.summary?.policyExists ? 'present' : 'missing')}</strong></div>
          <div class="kv"><span>Tools</span><strong>${escapeHtml(outsideToolPolicyPreview.summary?.toolCount ?? 0)}</strong></div>
          <div class="kv"><span>Report Only</span><strong>${escapeHtml(boolLabel(outsideToolPolicyPreview.summary?.reportOnlyAuthority))}</strong></div>
          ${renderPreviewReceipt(outsideToolPolicyPreview.previewReceipt)}
          ${table(['Writes'], outsideToolPolicyWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], outsideToolPolicyChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Tool Class', 'Allowed', 'Requirements'], (outsideToolPolicyContract?.toolClasses || []).map((item) => `<tr><td>${escapeHtml(item.label || item.id || '')}</td><td>${escapeHtml(boolLabel(item.currentlyAllowed))}</td><td>${escapeHtml((item.requirements || []).join('; '))}</td></tr>`), 'No tool classes reported.')}
          ${table(['Required Before Tool Execution'], (outsideToolPolicyContract?.requiredBeforeToolExecution || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No future execution requirements reported.')}
          <label class="confirm-label" for="outside-tool-policy-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(outsideToolPolicyPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="outside-tool-policy-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-outside-tool-policy-gate" type="button">Create Gate</button>
            <button id="clear-outside-tool-policy-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${outsideToolPolicyReport ? `
        <div class="action-result ${outsideToolPolicyGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Outside tool policy gate ${escapeHtml(outsideToolPolicyReport.status || 'recorded')}</strong>
          <code>${escapeHtml(outsideToolPolicyGateAction?.reportPath || outsideToolPolicyReport.reportPath || '')}</code>
          ${renderExecuteReceipt(outsideToolPolicyGateAction?.executeReceipt)}
          <div>Tool classes: ${escapeHtml(outsideToolPolicyContract?.toolClasses?.length || 0)}</div>
          <div>Blocked authority classes: ${escapeHtml(listCount(outsideToolPolicyContract?.blockedAuthorityClasses))}</div>
        </div>` : ''}
      ${outsideToolPolicyGateAction?.error ? `<p class="action-error">${escapeHtml(outsideToolPolicyGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Autonomy Dry-Run</h3>
          <p>Simulates bounded proposal readiness from swarm receipts without providers, commands, file edits, or git mutations.</p>
        </div>
        <button id="preview-autonomy-dry-run" type="button">Preview</button>
      </div>
      <div class="field-grid">
        <label>Turn id <input id="autonomy-dry-run-turn-id" value="${escapeHtml(autonomyDryRunTurnId)}" placeholder="latest" /></label>
        <label>Proposal ids <input id="autonomy-dry-run-proposal-ids" value="${escapeHtml(autonomyDryRunProposalIds)}" placeholder="comma-separated or blank" /></label>
        <label>Max proposals <input id="autonomy-dry-run-max-proposals" type="number" min="1" max="5" value="${escapeHtml(autonomyDryRunMaxProposals)}" /></label>
      </div>
      ${autonomyDryRunPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(autonomyDryRunPreview.version || '?')}</strong></div>
          <div class="kv"><span>Decision</span><strong>${escapeHtml(autonomyDryRunPreview.summary?.decision || 'unknown')}</strong></div>
          <div class="kv"><span>Would run</span><strong>${escapeHtml(autonomyDryRunPreview.summary?.wouldRun ?? 0)}</strong></div>
          <div class="kv"><span>Blocked</span><strong>${escapeHtml(autonomyDryRunPreview.summary?.blocked ?? 0)}</strong></div>
          ${renderPreviewReceipt(autonomyDryRunPreview.previewReceipt)}
          ${table(['Writes'], autonomyDryRunWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], autonomyDryRunChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Proposal', 'Type', 'Status', 'Targets'], autonomyDryRunSteps.map((item) => `<tr><td>${escapeHtml(item.proposalId || '?')}</td><td>${escapeHtml(item.proposalType || '?')}</td><td>${escapeHtml(item.status || '?')}${item.stopReason ? `<br><small>${escapeHtml(item.stopReason)}</small>` : ''}</td><td>${escapeHtml((item.targetPaths || []).join(', ') || '-')}</td></tr>`), 'No proposal steps simulated.')}
          <label class="confirm-label" for="autonomy-dry-run-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(autonomyDryRunPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="autonomy-dry-run-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-autonomy-dry-run" type="button">Create Dry-Run</button>
            <button id="clear-autonomy-dry-run" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${autonomyDryRunReport ? `
        <div class="action-result ${autonomyDryRunAction?.ok ? 'ok' : 'warn'}">
          <strong>Autonomy dry-run ${escapeHtml(autonomyDryRunReport.status || 'written')}</strong>
          <code>${escapeHtml(autonomyDryRunAction?.reportPath || autonomyDryRunReport.reportPath || '')}</code>
          ${renderExecuteReceipt(autonomyDryRunAction?.executeReceipt)}
          <div>Decision: ${escapeHtml(autonomyDryRunReport.contract?.decision || 'unknown')}</div>
          <div>Turn: ${escapeHtml(autonomyDryRunReport.contract?.swarm?.turnId || 'unknown')}</div>
          <div>Proposals: ${escapeHtml(autonomyDryRunReport.contract?.swarm?.proposalCount ?? 0)}</div>
        </div>` : ''}
      ${autonomyDryRunAction?.error ? `<p class="action-error">${escapeHtml(autonomyDryRunAction.error)}</p>` : ''}
    </div>
    </section>
    <section class="action-section">
      <div class="action-section-title">
        <h3>Commands And Self-Healing</h3>
        <p>Command authority reports and default-off self-repair gates.</p>
      </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Terminal/Command Report</h3>
          <p>Backend-owned command policy and environment-name report with no shell execution.</p>
        </div>
        <button id="preview-terminal-command-report" type="button">Preview</button>
      </div>
      ${terminalCommandPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(terminalCommandPreview.version || '?')}</strong></div>
          <div class="kv"><span>Policy</span><strong>${escapeHtml(terminalCommandPreview.summary?.policyMode || 'missing')}</strong></div>
          <div class="kv"><span>Run commands</span><strong>${escapeHtml(terminalCommandPreview.summary?.runCommands ? 'allowed' : 'blocked')}</strong></div>
          <div class="kv"><span>Budget</span><strong>${escapeHtml(`${terminalCommandPreview.summary?.maxCommandSeconds ?? 0}s`)}</strong></div>
          ${renderPreviewReceipt(terminalCommandPreview.previewReceipt)}
          ${table(['Writes'], terminalCommandWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], terminalCommandChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="terminal-command-report-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(terminalCommandPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="terminal-command-report-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-terminal-command-report" type="button">Create Report</button>
            <button id="clear-terminal-command-report" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${terminalCommandReport ? `
        <div class="action-result ${terminalCommandReportAction?.ok ? 'ok' : 'warn'}">
          <strong>Terminal/command report created</strong>
          <code>${escapeHtml(terminalCommandReportAction?.reportPath || terminalCommandReport.reportPath || '')}</code>
          ${renderExecuteReceipt(terminalCommandReportAction?.executeReceipt)}
          <div>Run commands: ${escapeHtml(terminalCommandReport.policy?.permissions?.runCommands ? 'allowed' : 'blocked')}</div>
          <div>Recent operations: ${escapeHtml(listCount(terminalCommandReport.recentOperations))}</div>
          <div>Environment names: ${escapeHtml(listCount(terminalCommandReport.environment?.envNames))}</div>
        </div>` : ''}
      ${terminalCommandReportAction?.error ? `<p class="action-error">${escapeHtml(terminalCommandReportAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Self-Healing Report</h3>
          <p>Backend-owned Harmony source/package/install readiness report with no self-mutation.</p>
        </div>
        <button id="preview-self-healing-report" type="button">Preview</button>
      </div>
      ${selfHealingPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(selfHealingPreview.version || '?')}</strong></div>
          <div class="kv"><span>Readiness</span><strong>${escapeHtml(selfHealingPreview.summary?.readiness || 'unknown')}</strong></div>
          <div class="kv"><span>Warnings</span><strong>${escapeHtml(selfHealingPreview.summary?.warnings ?? 0)}</strong></div>
          <div class="kv"><span>Tools</span><strong>${escapeHtml(selfHealingPreview.summary?.toolCount ?? 0)}</strong></div>
          ${renderPreviewReceipt(selfHealingPreview.previewReceipt)}
          ${table(['Writes'], selfHealingWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], selfHealingChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          <label class="confirm-label" for="self-healing-report-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(selfHealingPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="self-healing-report-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-self-healing-report" type="button">Create Report</button>
            <button id="clear-self-healing-report" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${selfHealingReport ? `
        <div class="action-result ${selfHealingReportAction?.ok ? 'ok' : 'warn'}">
          <strong>Self-healing report created</strong>
          <code>${escapeHtml(selfHealingReportAction?.reportPath || selfHealingReport.reportPath || '')}</code>
          ${renderExecuteReceipt(selfHealingReportAction?.executeReceipt)}
          <div>Readiness: ${escapeHtml(selfHealingMetadata?.readiness?.status || 'unknown')}</div>
          <div>Warnings: ${escapeHtml(listCount(selfHealingMetadata?.readiness?.warnings))}</div>
          <div>Installed matches: ${escapeHtml((selfHealingMetadata?.installedEditors || []).filter((item) => item.matchesExpected).length)}/${escapeHtml(listCount(selfHealingMetadata?.installedEditors))}</div>
        </div>` : ''}
      ${selfHealingReportAction?.error ? `<p class="action-error">${escapeHtml(selfHealingReportAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Self-Healing Gate</h3>
          <p>Creates the reversible contract future self-update or repair actions must satisfy.</p>
        </div>
        <button id="preview-self-healing-gate" type="button">Preview</button>
      </div>
      ${selfHealingGatePreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(selfHealingGatePreview.version || '?')}</strong></div>
          <div class="kv"><span>Readiness</span><strong>${escapeHtml(selfHealingGatePreview.summary?.readiness || 'unknown')}</strong></div>
          <div class="kv"><span>Blocked authorities</span><strong>${escapeHtml(selfHealingGatePreview.summary?.blockedAuthorityClasses ?? 0)}</strong></div>
          <div class="kv"><span>Mutation requirements</span><strong>${escapeHtml(selfHealingGatePreview.summary?.requiredBeforeMutation ?? 0)}</strong></div>
          ${renderPreviewReceipt(selfHealingGatePreview.previewReceipt)}
          ${table(['Writes'], selfHealingGateWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], selfHealingGateChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Blocked Authority'], (selfHealingGateContract?.blockedAuthorityClasses || []).map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No blocked authority classes reported.')}
          <label class="confirm-label" for="self-healing-gate-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(selfHealingGatePreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="self-healing-gate-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-self-healing-gate" type="button">Create Gate</button>
            <button id="clear-self-healing-gate" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${selfHealingGateReport ? `
        <div class="action-result ${selfHealingGateAction?.ok ? 'ok' : 'warn'}">
          <strong>Self-healing gate created</strong>
          <code>${escapeHtml(selfHealingGateAction?.reportPath || selfHealingGateReport.reportPath || '')}</code>
          ${renderExecuteReceipt(selfHealingGateAction?.executeReceipt)}
          <div>Posture: ${escapeHtml(selfHealingGateReport.contract?.posture || 'unknown')}</div>
          <div>Mutation status: ${escapeHtml(selfHealingGateReport.contract?.mutationStatus || 'unknown')}</div>
          <div>Future actions: ${escapeHtml(listCount(selfHealingGateReport.contract?.allowedFutureActions))}</div>
        </div>` : ''}
      ${selfHealingGateAction?.error ? `<p class="action-error">${escapeHtml(selfHealingGateAction.error)}</p>` : ''}
    </div>
    <div class="action-card">
      <div class="action-header">
        <div>
          <h3>Self-Healing Package Preflight</h3>
          <p>Runs fixed compile/build/smoke/package/scan steps under a single-owner lock. No install or reload.</p>
        </div>
        <button id="preview-self-healing-package-preflight" type="button">Preview</button>
      </div>
      ${selfHealingPackagePreflightPreview ? `
        <div class="action-detail">
          <div class="kv"><span>Version</span><strong>${escapeHtml(selfHealingPackagePreflightPreview.version || '?')}</strong></div>
          <div class="kv"><span>Readiness</span><strong>${escapeHtml(selfHealingPackagePreflightPreview.summary?.readiness || 'unknown')}</strong></div>
          <div class="kv"><span>Commands</span><strong>${escapeHtml(selfHealingPackagePreflightPreview.summary?.commandCount ?? 0)}</strong></div>
          <div class="kv"><span>Installs</span><strong>${escapeHtml(selfHealingPackagePreflightPreview.summary?.installs ? 'yes' : 'no')}</strong></div>
          ${renderPreviewReceipt(selfHealingPackagePreflightPreview.previewReceipt)}
          ${table(['Writes'], selfHealingPackagePreflightWrites.map((item) => `<tr><td><code>${escapeHtml(item)}</code></td></tr>`), 'No write targets reported.')}
          ${table(['Checks'], selfHealingPackagePreflightChecks.map((item) => `<tr><td>${escapeHtml(item)}</td></tr>`), 'No checks reported.')}
          ${table(['Step', 'Command', 'Timeout'], selfHealingPackagePreflightCommands.map((item) => `<tr><td>${escapeHtml(item.name || '')}</td><td><code>${escapeHtml(item.commandLine || '')}</code></td><td>${escapeHtml(item.timeoutSeconds ?? '')}</td></tr>`), 'No commands reported.')}
          <label class="confirm-label" for="self-healing-package-preflight-confirmation">Confirmation phrase</label>
          <code class="confirmation-phrase">${escapeHtml(selfHealingPackagePreflightPreview.requiredConfirmation || '')}</code>
          <div class="confirm-row">
            <input id="self-healing-package-preflight-confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact phrase" />
            <button id="execute-self-healing-package-preflight" type="button">Run Preflight</button>
            <button id="clear-self-healing-package-preflight" class="secondary" type="button">Clear</button>
          </div>
        </div>` : ''}
      ${selfHealingPackagePreflightReport ? `
        <div class="action-result ${selfHealingPackagePreflightAction?.ok ? 'ok' : 'warn'}">
          <strong>Package preflight ${escapeHtml(selfHealingPackagePreflightReport.status || (selfHealingPackagePreflightAction?.ok ? 'passed' : 'failed'))}</strong>
          <code>${escapeHtml(selfHealingPackagePreflightAction?.reportPath || selfHealingPackagePreflightReport.reportPath || '')}</code>
          ${renderExecuteReceipt(selfHealingPackagePreflightAction?.executeReceipt)}
          <div>Version: ${escapeHtml(selfHealingPackagePreflightReport.packageVersion || 'unknown')}</div>
          <div>Commands passed: ${escapeHtml((selfHealingPackagePreflightReport.commands || []).filter((item) => item.exitCode === 0).length)}/${escapeHtml(listCount(selfHealingPackagePreflightReport.commands))}</div>
          <div>Rollback backup: ${escapeHtml(selfHealingPackagePreflightReport.rollback?.backupPath || (selfHealingPackagePreflightReport.rollback?.existed ? 'captured' : 'not needed'))}</div>
        </div>` : ''}
      ${selfHealingPackagePreflightAction?.error ? `<p class="action-error">${escapeHtml(selfHealingPackagePreflightAction.error)}</p>` : ''}
    </div>
    </section>
  `;
}

function readAutonomyDryRunInputs(): { turnId: string; proposalIds: string; maxProposals: number } {
  autonomyDryRunTurnId = document.querySelector<HTMLInputElement>('#autonomy-dry-run-turn-id')?.value.trim() || 'latest';
  autonomyDryRunProposalIds = document.querySelector<HTMLInputElement>('#autonomy-dry-run-proposal-ids')?.value.trim() || '';
  autonomyDryRunMaxProposals = document.querySelector<HTMLInputElement>('#autonomy-dry-run-max-proposals')?.value.trim() || '3';
  return {
    turnId: autonomyDryRunTurnId,
    proposalIds: autonomyDryRunProposalIds,
    maxProposals: Math.max(1, Math.min(5, Number(autonomyDryRunMaxProposals) || 3)),
  };
}

function wireControlledActions(): void {
  document.querySelector<HTMLButtonElement>('#preview-release-receipt')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing release receipt action...');
      releaseReceiptAction = await postBackendJson<ReleaseReceiptAction>('/actions/release-receipt', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Release receipt preview ready.');
    } catch (error) {
      releaseReceiptAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-release-receipt')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#release-confirmation')?.value || '';
    const previewReceiptId = releaseReceiptAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating release receipt...');
      releaseReceiptAction = await postBackendJson<ReleaseReceiptAction>('/actions/release-receipt', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(releaseReceiptAction.ok ? 'Release receipt created.' : 'Release receipt created with failed checks.');
    } catch (error) {
      releaseReceiptAction = { ...releaseReceiptAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-release-receipt')?.addEventListener('click', () => {
    releaseReceiptAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-privacy-scan')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing privacy scan action...');
      privacyScanAction = await postBackendJson<PrivacyScanAction>('/actions/privacy-scan', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Privacy scan preview ready.');
    } catch (error) {
      privacyScanAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-privacy-scan')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#privacy-confirmation')?.value || '';
    const previewReceiptId = privacyScanAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running privacy scan...');
      privacyScanAction = await postBackendJson<PrivacyScanAction>('/actions/privacy-scan', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(privacyScanAction.ok ? 'Privacy scan passed.' : 'Privacy scan finished with issues.');
    } catch (error) {
      privacyScanAction = { ...privacyScanAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-privacy-scan')?.addEventListener('click', () => {
    privacyScanAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-diagnostics')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing diagnostics action...');
      diagnosticsAction = await postBackendJson<DiagnosticsAction>('/actions/diagnostics', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Diagnostics preview ready.');
    } catch (error) {
      diagnosticsAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-diagnostics')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#diagnostics-confirmation')?.value || '';
    const previewReceiptId = diagnosticsAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running diagnostics...');
      diagnosticsAction = await postBackendJson<DiagnosticsAction>('/actions/diagnostics', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(diagnosticsAction.ok ? 'Diagnostics completed cleanly.' : 'Diagnostics completed with recommendations.');
    } catch (error) {
      diagnosticsAction = { ...diagnosticsAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-diagnostics')?.addEventListener('click', () => {
    diagnosticsAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-snapshot-drill')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing snapshot drill action...');
      snapshotDrillAction = await postBackendJson<SnapshotDrillAction>('/actions/snapshot-drill', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Snapshot drill preview ready.');
    } catch (error) {
      snapshotDrillAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-snapshot-drill')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#snapshot-drill-confirmation')?.value || '';
    const previewReceiptId = snapshotDrillAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running snapshot drill...');
      snapshotDrillAction = await postBackendJson<SnapshotDrillAction>('/actions/snapshot-drill', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(snapshotDrillAction.ok ? 'Snapshot drill completed.' : 'Snapshot drill failed.');
    } catch (error) {
      snapshotDrillAction = { ...snapshotDrillAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-snapshot-drill')?.addEventListener('click', () => {
    snapshotDrillAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#native-file-write-path')?.addEventListener('input', (event) => {
    nativeFileWritePath = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#native-file-write-content')?.addEventListener('input', (event) => {
    nativeFileWriteContent = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-native-file-write')?.addEventListener('click', async () => {
    const targetPath = document.querySelector<HTMLInputElement>('#native-file-write-path')?.value || nativeFileWritePath;
    const content = document.querySelector<HTMLTextAreaElement>('#native-file-write-content')?.value ?? nativeFileWriteContent;
    nativeFileWritePath = targetPath;
    nativeFileWriteContent = content;
    try {
      updateNotice('Previewing guarded native file write...');
      nativeFileWriteAction = await postBackendJson<NativeFileWriteAction>('/actions/native-file-write', { mode: 'preview', path: targetPath, content });
      if (latestState) renderState(latestState);
      updateNotice('Native file write preview ready.');
    } catch (error) {
      nativeFileWriteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-file-write')?.addEventListener('click', async () => {
    const targetPath = document.querySelector<HTMLInputElement>('#native-file-write-path')?.value || nativeFileWritePath;
    const content = document.querySelector<HTMLTextAreaElement>('#native-file-write-content')?.value ?? nativeFileWriteContent;
    const confirmation = document.querySelector<HTMLInputElement>('#native-file-write-confirmation')?.value || '';
    const previewReceiptId = nativeFileWriteAction?.preview?.previewReceipt?.id || '';
    nativeFileWritePath = targetPath;
    nativeFileWriteContent = content;
    try {
      updateNotice('Running guarded native file write...');
      nativeFileWriteAction = await postBackendJson<NativeFileWriteAction>('/actions/native-file-write', { mode: 'execute', confirmation, previewReceiptId, path: targetPath, content });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeFileWriteAction.ok ? 'Native file write completed.' : 'Native file write blocked or failed.');
    } catch (error) {
      nativeFileWriteAction = { ...nativeFileWriteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-file-write')?.addEventListener('click', () => {
    nativeFileWritePath = '';
    nativeFileWriteContent = '';
    nativeFileWriteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-policy-report')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing policy report action...');
      policyReportAction = await postBackendJson<PolicyReportAction>('/actions/policy-report', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Policy report preview ready.');
    } catch (error) {
      policyReportAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-policy-report')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#policy-report-confirmation')?.value || '';
    const previewReceiptId = policyReportAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating policy report...');
      policyReportAction = await postBackendJson<PolicyReportAction>('/actions/policy-report', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(policyReportAction.ok ? 'Policy report created.' : 'Policy report created with warnings.');
    } catch (error) {
      policyReportAction = { ...policyReportAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-policy-report')?.addEventListener('click', () => {
    policyReportAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-broker-provider-report')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing broker/provider report action...');
      brokerProviderReportAction = await postBackendJson<BrokerProviderReportAction>('/actions/broker-provider-report', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Broker/provider report preview ready.');
    } catch (error) {
      brokerProviderReportAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-broker-provider-report')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#broker-provider-report-confirmation')?.value || '';
    const previewReceiptId = brokerProviderReportAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating broker/provider report...');
      brokerProviderReportAction = await postBackendJson<BrokerProviderReportAction>('/actions/broker-provider-report', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(brokerProviderReportAction.ok ? 'Broker/provider report created.' : 'Broker/provider report created with warnings.');
    } catch (error) {
      brokerProviderReportAction = { ...brokerProviderReportAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-broker-provider-report')?.addEventListener('click', () => {
    brokerProviderReportAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-git-safety-report')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing git safety report action...');
      gitSafetyReportAction = await postBackendJson<GitSafetyReportAction>('/actions/git-safety-report', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Git safety report preview ready.');
    } catch (error) {
      gitSafetyReportAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-git-safety-report')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#git-safety-report-confirmation')?.value || '';
    const previewReceiptId = gitSafetyReportAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating git safety report...');
      gitSafetyReportAction = await postBackendJson<GitSafetyReportAction>('/actions/git-safety-report', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(gitSafetyReportAction.ok ? 'Git safety report created.' : 'Git safety report created with warnings.');
    } catch (error) {
      gitSafetyReportAction = { ...gitSafetyReportAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-git-safety-report')?.addEventListener('click', () => {
    gitSafetyReportAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-terminal-command-report')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing terminal/command report action...');
      terminalCommandReportAction = await postBackendJson<TerminalCommandReportAction>('/actions/terminal-command-report', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Terminal/command report preview ready.');
    } catch (error) {
      terminalCommandReportAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-terminal-command-report')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#terminal-command-report-confirmation')?.value || '';
    const previewReceiptId = terminalCommandReportAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating terminal/command report...');
      terminalCommandReportAction = await postBackendJson<TerminalCommandReportAction>('/actions/terminal-command-report', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(terminalCommandReportAction.ok ? 'Terminal/command report created.' : 'Terminal/command report created with warnings.');
    } catch (error) {
      terminalCommandReportAction = { ...terminalCommandReportAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-terminal-command-report')?.addEventListener('click', () => {
    terminalCommandReportAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-self-healing-report')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing self-healing report action...');
      selfHealingReportAction = await postBackendJson<SelfHealingReportAction>('/actions/self-healing-report', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Self-healing report preview ready.');
    } catch (error) {
      selfHealingReportAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-self-healing-report')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#self-healing-report-confirmation')?.value || '';
    const previewReceiptId = selfHealingReportAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating self-healing report...');
      selfHealingReportAction = await postBackendJson<SelfHealingReportAction>('/actions/self-healing-report', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(selfHealingReportAction.ok ? 'Self-healing report created.' : 'Self-healing report created with warnings.');
    } catch (error) {
      selfHealingReportAction = { ...selfHealingReportAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-self-healing-report')?.addEventListener('click', () => {
    selfHealingReportAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-self-healing-gate')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing self-healing gate action...');
      selfHealingGateAction = await postBackendJson<SelfHealingGateAction>('/actions/self-healing-gate', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Self-healing gate preview ready.');
    } catch (error) {
      selfHealingGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-self-healing-gate')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#self-healing-gate-confirmation')?.value || '';
    const previewReceiptId = selfHealingGateAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating self-healing gate...');
      selfHealingGateAction = await postBackendJson<SelfHealingGateAction>('/actions/self-healing-gate', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(selfHealingGateAction.ok ? 'Self-healing gate created.' : 'Self-healing gate created with warnings.');
    } catch (error) {
      selfHealingGateAction = { ...selfHealingGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-self-healing-gate')?.addEventListener('click', () => {
    selfHealingGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-self-healing-package-preflight')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing self-healing package preflight...');
      selfHealingPackagePreflightAction = await postBackendJson<SelfHealingPackagePreflightAction>('/actions/self-healing-package-preflight', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Self-healing package preflight preview ready.');
    } catch (error) {
      selfHealingPackagePreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-self-healing-package-preflight')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#self-healing-package-preflight-confirmation')?.value || '';
    const previewReceiptId = selfHealingPackagePreflightAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running self-healing package preflight...');
      selfHealingPackagePreflightAction = await postBackendJson<SelfHealingPackagePreflightAction>('/actions/self-healing-package-preflight', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(selfHealingPackagePreflightAction.ok ? 'Self-healing package preflight passed.' : 'Self-healing package preflight completed with failures.');
    } catch (error) {
      selfHealingPackagePreflightAction = { ...selfHealingPackagePreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-self-healing-package-preflight')?.addEventListener('click', () => {
    selfHealingPackagePreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-report')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle report action...');
      nativeLifecycleReportAction = await postBackendJson<NativeLifecycleReportAction>('/actions/native-lifecycle-report', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle report preview ready.');
    } catch (error) {
      nativeLifecycleReportAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-report')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-report-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleReportAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating native lifecycle report...');
      nativeLifecycleReportAction = await postBackendJson<NativeLifecycleReportAction>('/actions/native-lifecycle-report', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleReportAction.ok ? 'Native lifecycle report created.' : 'Native lifecycle report created with warnings.');
    } catch (error) {
      nativeLifecycleReportAction = { ...nativeLifecycleReportAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-report')?.addEventListener('click', () => {
    nativeLifecycleReportAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-preflight')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle preflight...');
      nativeLifecyclePreflightAction = await postBackendJson<NativeLifecyclePreflightAction>('/actions/native-lifecycle-preflight', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle preflight preview ready.');
    } catch (error) {
      nativeLifecyclePreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-preflight')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-preflight-confirmation')?.value || '';
    const previewReceiptId = nativeLifecyclePreflightAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running native lifecycle preflight...');
      nativeLifecyclePreflightAction = await postBackendJson<NativeLifecyclePreflightAction>('/actions/native-lifecycle-preflight', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecyclePreflightAction.ok ? 'Native lifecycle preflight passed.' : 'Native lifecycle preflight completed with failures.');
    } catch (error) {
      nativeLifecyclePreflightAction = { ...nativeLifecyclePreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-preflight')?.addEventListener('click', () => {
    nativeLifecyclePreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-start-gate')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle start gate...');
      nativeLifecycleStartGateAction = await postBackendJson<NativeLifecycleStartGateAction>('/actions/native-lifecycle-start-gate', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle start gate preview ready.');
    } catch (error) {
      nativeLifecycleStartGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-start-gate')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-start-gate-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleStartGateAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating native lifecycle start gate...');
      nativeLifecycleStartGateAction = await postBackendJson<NativeLifecycleStartGateAction>('/actions/native-lifecycle-start-gate', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleStartGateAction.ok ? 'Native lifecycle start gate created.' : 'Native lifecycle start gate created with warnings.');
    } catch (error) {
      nativeLifecycleStartGateAction = { ...nativeLifecycleStartGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-start-gate')?.addEventListener('click', () => {
    nativeLifecycleStartGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-stop-gate')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle stop gate...');
      nativeLifecycleStopGateAction = await postBackendJson<NativeLifecycleStopGateAction>('/actions/native-lifecycle-stop-gate', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle stop gate preview ready.');
    } catch (error) {
      nativeLifecycleStopGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-stop-gate')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-stop-gate-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleStopGateAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating native lifecycle stop gate...');
      nativeLifecycleStopGateAction = await postBackendJson<NativeLifecycleStopGateAction>('/actions/native-lifecycle-stop-gate', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleStopGateAction.ok ? 'Native lifecycle stop gate created.' : 'Native lifecycle stop gate created with warnings.');
    } catch (error) {
      nativeLifecycleStopGateAction = { ...nativeLifecycleStopGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-stop-gate')?.addEventListener('click', () => {
    nativeLifecycleStopGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-reconnect-gate')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle reconnect gate...');
      nativeLifecycleReconnectGateAction = await postBackendJson<NativeLifecycleReconnectGateAction>('/actions/native-lifecycle-reconnect-gate', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle reconnect gate preview ready.');
    } catch (error) {
      nativeLifecycleReconnectGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-reconnect-gate')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-reconnect-gate-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleReconnectGateAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating native lifecycle reconnect gate...');
      nativeLifecycleReconnectGateAction = await postBackendJson<NativeLifecycleReconnectGateAction>('/actions/native-lifecycle-reconnect-gate', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleReconnectGateAction.ok ? 'Native lifecycle reconnect gate created.' : 'Native lifecycle reconnect gate created with warnings.');
    } catch (error) {
      nativeLifecycleReconnectGateAction = { ...nativeLifecycleReconnectGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-reconnect-gate')?.addEventListener('click', () => {
    nativeLifecycleReconnectGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-start-preflight')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle start preflight...');
      nativeLifecycleStartPreflightAction = await postBackendJson<NativeLifecycleStartPreflightAction>('/actions/native-lifecycle-start-preflight', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle start preflight preview ready.');
    } catch (error) {
      nativeLifecycleStartPreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-start-preflight')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-start-preflight-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleStartPreflightAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running native lifecycle start preflight...');
      nativeLifecycleStartPreflightAction = await postBackendJson<NativeLifecycleStartPreflightAction>('/actions/native-lifecycle-start-preflight', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleStartPreflightAction.ok ? 'Native lifecycle start preflight passed.' : 'Native lifecycle start preflight completed with failures.');
    } catch (error) {
      nativeLifecycleStartPreflightAction = { ...nativeLifecycleStartPreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-start-preflight')?.addEventListener('click', () => {
    nativeLifecycleStartPreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-stop-preflight')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle stop preflight...');
      nativeLifecycleStopPreflightAction = await postBackendJson<NativeLifecycleStopPreflightAction>('/actions/native-lifecycle-stop-preflight', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle stop preflight preview ready.');
    } catch (error) {
      nativeLifecycleStopPreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-stop-preflight')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-stop-preflight-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleStopPreflightAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running native lifecycle stop preflight...');
      nativeLifecycleStopPreflightAction = await postBackendJson<NativeLifecycleStopPreflightAction>('/actions/native-lifecycle-stop-preflight', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleStopPreflightAction.ok ? 'Native lifecycle stop preflight passed.' : 'Native lifecycle stop preflight completed with failures.');
    } catch (error) {
      nativeLifecycleStopPreflightAction = { ...nativeLifecycleStopPreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-stop-preflight')?.addEventListener('click', () => {
    nativeLifecycleStopPreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-stop-execute')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle stop execute...');
      nativeLifecycleStopExecuteAction = await postBackendJson<NativeLifecycleStopExecuteAction>('/actions/native-lifecycle-stop-execute', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle stop execute preview ready.');
    } catch (error) {
      nativeLifecycleStopExecuteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-stop-execute')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-stop-execute-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleStopExecuteAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Stopping Harmony-owned native lifecycle targets...');
      nativeLifecycleStopExecuteAction = await postBackendJson<NativeLifecycleStopExecuteAction>('/actions/native-lifecycle-stop-execute', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      updateNotice(nativeLifecycleStopExecuteAction.ok ? 'Native lifecycle stop receipt written. Backend may now be offline.' : 'Native lifecycle stop completed with warnings.');
    } catch (error) {
      nativeLifecycleStopExecuteAction = { ...nativeLifecycleStopExecuteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-stop-execute')?.addEventListener('click', () => {
    nativeLifecycleStopExecuteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-reconnect-preflight')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle reconnect preflight...');
      nativeLifecycleReconnectPreflightAction = await postBackendJson<NativeLifecycleReconnectPreflightAction>('/actions/native-lifecycle-reconnect-preflight', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle reconnect preflight preview ready.');
    } catch (error) {
      nativeLifecycleReconnectPreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-reconnect-preflight')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-reconnect-preflight-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleReconnectPreflightAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running native lifecycle reconnect preflight...');
      nativeLifecycleReconnectPreflightAction = await postBackendJson<NativeLifecycleReconnectPreflightAction>('/actions/native-lifecycle-reconnect-preflight', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleReconnectPreflightAction.ok ? 'Native lifecycle reconnect preflight passed.' : 'Native lifecycle reconnect preflight completed with failures.');
    } catch (error) {
      nativeLifecycleReconnectPreflightAction = { ...nativeLifecycleReconnectPreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-reconnect-preflight')?.addEventListener('click', () => {
    nativeLifecycleReconnectPreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-restart-preflight')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle restart preflight...');
      nativeLifecycleRestartPreflightAction = await postBackendJson<NativeLifecycleRestartPreflightAction>('/actions/native-lifecycle-restart-preflight', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle restart preflight preview ready.');
    } catch (error) {
      nativeLifecycleRestartPreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-restart-preflight')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-restart-preflight-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleRestartPreflightAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Running native lifecycle restart preflight...');
      nativeLifecycleRestartPreflightAction = await postBackendJson<NativeLifecycleRestartPreflightAction>('/actions/native-lifecycle-restart-preflight', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleRestartPreflightAction.ok ? 'Native lifecycle restart preflight passed.' : 'Native lifecycle restart preflight completed with failures.');
    } catch (error) {
      nativeLifecycleRestartPreflightAction = { ...nativeLifecycleRestartPreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-restart-preflight')?.addEventListener('click', () => {
    nativeLifecycleRestartPreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-restart-execute-gate')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle restart execute gate...');
      nativeLifecycleRestartExecuteGateAction = await postBackendJson<NativeLifecycleRestartExecuteGateAction>('/actions/native-lifecycle-restart-execute-gate', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle restart execute gate preview ready.');
    } catch (error) {
      nativeLifecycleRestartExecuteGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-restart-execute-gate')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-restart-execute-gate-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleRestartExecuteGateAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating native lifecycle restart execute gate...');
      nativeLifecycleRestartExecuteGateAction = await postBackendJson<NativeLifecycleRestartExecuteGateAction>('/actions/native-lifecycle-restart-execute-gate', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleRestartExecuteGateAction.ok ? 'Native lifecycle restart execute gate created.' : 'Native lifecycle restart execute gate completed with failures.');
    } catch (error) {
      nativeLifecycleRestartExecuteGateAction = { ...nativeLifecycleRestartExecuteGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-restart-execute-gate')?.addEventListener('click', () => {
    nativeLifecycleRestartExecuteGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-restart-execute')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle restart execute...');
      nativeLifecycleRestartExecuteAction = await postBackendJson<NativeLifecycleRestartExecuteAction>('/actions/native-lifecycle-restart-execute', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle restart execute preview ready.');
    } catch (error) {
      nativeLifecycleRestartExecuteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-restart-execute')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-restart-execute-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleRestartExecuteAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Restarting Harmony native backend...');
      nativeLifecycleRestartExecuteAction = await postBackendJson<NativeLifecycleRestartExecuteAction>('/actions/native-lifecycle-restart-execute', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      updateNotice(nativeLifecycleRestartExecuteAction.ok ? 'Native lifecycle restart completed.' : 'Native lifecycle restart blocked or completed with warnings.');
    } catch (error) {
      nativeLifecycleRestartExecuteAction = { ...nativeLifecycleRestartExecuteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-restart-execute')?.addEventListener('click', () => {
    nativeLifecycleRestartExecuteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-native-lifecycle-reconnect-execute')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing native lifecycle reconnect execute...');
      nativeLifecycleReconnectExecuteAction = await postBackendJson<NativeLifecycleReconnectExecuteAction>('/actions/native-lifecycle-reconnect-execute', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Native lifecycle reconnect execute preview ready.');
    } catch (error) {
      nativeLifecycleReconnectExecuteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-native-lifecycle-reconnect-execute')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#native-lifecycle-reconnect-execute-confirmation')?.value || '';
    const previewReceiptId = nativeLifecycleReconnectExecuteAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Reconnecting to Harmony native backend...');
      nativeLifecycleReconnectExecuteAction = await postBackendJson<NativeLifecycleReconnectExecuteAction>('/actions/native-lifecycle-reconnect-execute', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(nativeLifecycleReconnectExecuteAction.ok ? 'Native backend reconnected.' : 'Native backend reconnect completed with warnings.');
    } catch (error) {
      nativeLifecycleReconnectExecuteAction = { ...nativeLifecycleReconnectExecuteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-native-lifecycle-reconnect-execute')?.addEventListener('click', () => {
    nativeLifecycleReconnectExecuteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLTextAreaElement>('#floating-chat-note-message')?.addEventListener('input', (event) => {
    floatingChatDraft = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-note')?.addEventListener('click', async () => {
    const message = document.querySelector<HTMLTextAreaElement>('#floating-chat-note-message')?.value || floatingChatDraft;
    floatingChatDraft = message;
    try {
      updateNotice('Previewing floating chat note action...');
      floatingChatNoteAction = await postBackendJson<FloatingChatNoteAction>('/actions/floating-chat-note', { mode: 'preview', message });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat note preview ready.');
    } catch (error) {
      floatingChatNoteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-note')?.addEventListener('click', async () => {
    const message = document.querySelector<HTMLTextAreaElement>('#floating-chat-note-message')?.value || floatingChatDraft;
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-note-confirmation')?.value || '';
    const previewReceiptId = floatingChatNoteAction?.preview?.previewReceipt?.id || '';
    floatingChatDraft = message;
    try {
      updateNotice('Saving floating chat note...');
      floatingChatNoteAction = await postBackendJson<FloatingChatNoteAction>('/actions/floating-chat-note', { mode: 'execute', confirmation, previewReceiptId, message });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatNoteAction.ok ? 'Floating chat note saved.' : 'Floating chat note saved with warnings.');
    } catch (error) {
      floatingChatNoteAction = { ...floatingChatNoteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-note')?.addEventListener('click', () => {
    floatingChatDraft = '';
    floatingChatNoteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-turn-conversation')?.addEventListener('input', (event) => {
    floatingChatConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#floating-chat-turn-message')?.addEventListener('input', (event) => {
    floatingChatTurnDraft = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-turn')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-turn-conversation')?.value || floatingChatConversationId;
    const message = document.querySelector<HTMLTextAreaElement>('#floating-chat-turn-message')?.value || floatingChatTurnDraft;
    floatingChatConversationId = conversationId;
    floatingChatTurnDraft = message;
    try {
      updateNotice('Previewing floating chat turn action...');
      floatingChatTurnAction = await postBackendJson<FloatingChatTurnAction>('/actions/floating-chat-turn', { mode: 'preview', conversationId, message });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat turn preview ready.');
    } catch (error) {
      floatingChatTurnAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-turn')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-turn-conversation')?.value || floatingChatConversationId;
    const message = document.querySelector<HTMLTextAreaElement>('#floating-chat-turn-message')?.value || floatingChatTurnDraft;
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-turn-confirmation')?.value || '';
    const previewReceiptId = floatingChatTurnAction?.preview?.previewReceipt?.id || '';
    floatingChatConversationId = conversationId;
    floatingChatTurnDraft = message;
    try {
      updateNotice('Capturing floating chat turn...');
      floatingChatTurnAction = await postBackendJson<FloatingChatTurnAction>('/actions/floating-chat-turn', { mode: 'execute', confirmation, previewReceiptId, conversationId, message });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatTurnAction.ok ? 'Floating chat turn captured.' : 'Floating chat turn captured with warnings.');
    } catch (error) {
      floatingChatTurnAction = { ...floatingChatTurnAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-turn')?.addEventListener('click', () => {
    floatingChatConversationId = '';
    floatingChatTurnDraft = '';
    floatingChatTurnAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-response-gate-conversation')?.addEventListener('input', (event) => {
    floatingChatResponseGateConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-response-gate')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-response-gate-conversation')?.value || floatingChatResponseGateConversationId;
    floatingChatResponseGateConversationId = conversationId;
    try {
      updateNotice('Previewing floating chat response gate...');
      floatingChatResponseGateAction = await postBackendJson<FloatingChatResponseGateAction>('/actions/floating-chat-response-gate', { mode: 'preview', conversationId });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat response gate preview ready.');
    } catch (error) {
      floatingChatResponseGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-response-gate')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-response-gate-conversation')?.value || floatingChatResponseGateConversationId;
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-response-gate-confirmation')?.value || '';
    const previewReceiptId = floatingChatResponseGateAction?.preview?.previewReceipt?.id || '';
    floatingChatResponseGateConversationId = conversationId;
    try {
      updateNotice('Recording floating chat response gate...');
      floatingChatResponseGateAction = await postBackendJson<FloatingChatResponseGateAction>('/actions/floating-chat-response-gate', { mode: 'execute', confirmation, previewReceiptId, conversationId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatResponseGateAction.ok ? 'Floating chat response gate recorded.' : 'Floating chat response gate recorded with warnings.');
    } catch (error) {
      floatingChatResponseGateAction = { ...floatingChatResponseGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-response-gate')?.addEventListener('click', () => {
    floatingChatResponseGateConversationId = '';
    floatingChatResponseGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-response-preflight-conversation')?.addEventListener('input', (event) => {
    floatingChatResponsePreflightConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-response-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-response-preflight-conversation')?.value || floatingChatResponsePreflightConversationId;
    floatingChatResponsePreflightConversationId = conversationId;
    try {
      updateNotice('Previewing floating chat response preflight...');
      floatingChatResponsePreflightAction = await postBackendJson<FloatingChatResponsePreflightAction>('/actions/floating-chat-response-preflight', { mode: 'preview', conversationId });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat response preflight preview ready.');
    } catch (error) {
      floatingChatResponsePreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-response-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-response-preflight-conversation')?.value || floatingChatResponsePreflightConversationId;
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-response-preflight-confirmation')?.value || '';
    const previewReceiptId = floatingChatResponsePreflightAction?.preview?.previewReceipt?.id || '';
    floatingChatResponsePreflightConversationId = conversationId;
    try {
      updateNotice('Running floating chat response preflight...');
      floatingChatResponsePreflightAction = await postBackendJson<FloatingChatResponsePreflightAction>('/actions/floating-chat-response-preflight', { mode: 'execute', confirmation, previewReceiptId, conversationId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatResponsePreflightAction.ok ? 'Floating chat response preflight recorded.' : 'Floating chat response preflight recorded with warnings.');
    } catch (error) {
      floatingChatResponsePreflightAction = { ...floatingChatResponsePreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-response-preflight')?.addEventListener('click', () => {
    floatingChatResponsePreflightConversationId = '';
    floatingChatResponsePreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-response-execute-conversation')?.addEventListener('input', (event) => {
    floatingChatResponseExecuteConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>('#floating-chat-response-execute-provider')?.addEventListener('input', (event) => {
    floatingChatResponseExecuteProvider = (event.target as HTMLInputElement).value || 'auto';
  });
  document.querySelector<HTMLInputElement>('#floating-chat-response-execute-model')?.addEventListener('input', (event) => {
    floatingChatResponseExecuteModel = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>('#floating-chat-response-execute-max-tokens')?.addEventListener('input', (event) => {
    floatingChatResponseExecuteMaxTokens = (event.target as HTMLInputElement).value || '512';
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-response-execute')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-conversation')?.value || floatingChatResponseExecuteConversationId;
    const provider = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-provider')?.value || floatingChatResponseExecuteProvider || 'auto';
    const model = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-model')?.value || floatingChatResponseExecuteModel;
    const maxTokens = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-max-tokens')?.value || floatingChatResponseExecuteMaxTokens || '512';
    floatingChatResponseExecuteConversationId = conversationId;
    floatingChatResponseExecuteProvider = provider;
    floatingChatResponseExecuteModel = model;
    floatingChatResponseExecuteMaxTokens = maxTokens;
    try {
      updateNotice('Previewing floating chat response execute...');
      floatingChatResponseExecuteAction = await postBackendJson<FloatingChatResponseExecuteAction>('/actions/floating-chat-response-execute', { mode: 'preview', conversationId, provider, model, maxTokens: Number(maxTokens) });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat response execute preview ready.');
    } catch (error) {
      floatingChatResponseExecuteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-response-execute')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-conversation')?.value || floatingChatResponseExecuteConversationId;
    const provider = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-provider')?.value || floatingChatResponseExecuteProvider || 'auto';
    const model = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-model')?.value || floatingChatResponseExecuteModel;
    const maxTokens = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-max-tokens')?.value || floatingChatResponseExecuteMaxTokens || '512';
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-response-execute-confirmation')?.value || '';
    const previewReceiptId = floatingChatResponseExecuteAction?.preview?.previewReceipt?.id || '';
    floatingChatResponseExecuteConversationId = conversationId;
    floatingChatResponseExecuteProvider = provider;
    floatingChatResponseExecuteModel = model;
    floatingChatResponseExecuteMaxTokens = maxTokens;
    try {
      updateNotice('Calling floating chat provider...');
      floatingChatResponseExecuteAction = await postBackendJson<FloatingChatResponseExecuteAction>('/actions/floating-chat-response-execute', { mode: 'execute', confirmation, previewReceiptId, conversationId, provider, model, maxTokens: Number(maxTokens) });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatResponseExecuteAction.ok ? 'Floating chat response completed.' : 'Floating chat response blocked or failed.');
    } catch (error) {
      floatingChatResponseExecuteAction = { ...floatingChatResponseExecuteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-response-execute')?.addEventListener('click', () => {
    floatingChatResponseExecuteConversationId = '';
    floatingChatResponseExecuteProvider = 'auto';
    floatingChatResponseExecuteModel = '';
    floatingChatResponseExecuteMaxTokens = '512';
    floatingChatResponseExecuteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-preflight-conversation')?.addEventListener('input', (event) => {
    floatingChatToolPreflightConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-preflight-request')?.addEventListener('input', (event) => {
    floatingChatToolPreflightRequest = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-tool-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-preflight-conversation')?.value || floatingChatToolPreflightConversationId;
    const toolRequest = document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-preflight-request')?.value || floatingChatToolPreflightRequest;
    floatingChatToolPreflightConversationId = conversationId;
    floatingChatToolPreflightRequest = toolRequest;
    try {
      updateNotice('Previewing floating chat tool preflight...');
      floatingChatToolPreflightAction = await postBackendJson<FloatingChatToolPreflightAction>('/actions/floating-chat-tool-preflight', { mode: 'preview', conversationId, toolRequest });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat tool preflight preview ready.');
    } catch (error) {
      floatingChatToolPreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-tool-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-preflight-conversation')?.value || floatingChatToolPreflightConversationId;
    const toolRequest = document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-preflight-request')?.value || floatingChatToolPreflightRequest;
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-tool-preflight-confirmation')?.value || '';
    const previewReceiptId = floatingChatToolPreflightAction?.preview?.previewReceipt?.id || '';
    floatingChatToolPreflightConversationId = conversationId;
    floatingChatToolPreflightRequest = toolRequest;
    try {
      updateNotice('Recording floating chat tool preflight...');
      floatingChatToolPreflightAction = await postBackendJson<FloatingChatToolPreflightAction>('/actions/floating-chat-tool-preflight', { mode: 'execute', confirmation, previewReceiptId, conversationId, toolRequest });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatToolPreflightAction.ok ? 'Floating chat tool preflight recorded.' : 'Floating chat tool preflight blocked.');
    } catch (error) {
      floatingChatToolPreflightAction = { ...floatingChatToolPreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-tool-preflight')?.addEventListener('click', () => {
    floatingChatToolPreflightConversationId = '';
    floatingChatToolPreflightRequest = '';
    floatingChatToolPreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-preflight-conversation')?.addEventListener('input', (event) => {
    floatingChatToolLoopPreflightConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-loop-preflight-request')?.addEventListener('input', (event) => {
    floatingChatToolLoopPreflightRequest = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-preflight-max-steps')?.addEventListener('input', (event) => {
    floatingChatToolLoopPreflightMaxSteps = (event.target as HTMLInputElement).value || '3';
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-tool-loop-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-preflight-conversation')?.value || floatingChatToolLoopPreflightConversationId;
    const toolLoopRequest = document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-loop-preflight-request')?.value || floatingChatToolLoopPreflightRequest;
    const maxSteps = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-preflight-max-steps')?.value || floatingChatToolLoopPreflightMaxSteps || '3';
    floatingChatToolLoopPreflightConversationId = conversationId;
    floatingChatToolLoopPreflightRequest = toolLoopRequest;
    floatingChatToolLoopPreflightMaxSteps = maxSteps;
    try {
      updateNotice('Previewing floating chat tool-loop preflight...');
      floatingChatToolLoopPreflightAction = await postBackendJson<FloatingChatToolLoopPreflightAction>('/actions/floating-chat-tool-loop-preflight', { mode: 'preview', conversationId, toolLoopRequest, maxSteps: Number(maxSteps) });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat tool-loop preflight preview ready.');
    } catch (error) {
      floatingChatToolLoopPreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-tool-loop-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-preflight-conversation')?.value || floatingChatToolLoopPreflightConversationId;
    const toolLoopRequest = document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-loop-preflight-request')?.value || floatingChatToolLoopPreflightRequest;
    const maxSteps = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-preflight-max-steps')?.value || floatingChatToolLoopPreflightMaxSteps || '3';
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-preflight-confirmation')?.value || '';
    const previewReceiptId = floatingChatToolLoopPreflightAction?.preview?.previewReceipt?.id || '';
    floatingChatToolLoopPreflightConversationId = conversationId;
    floatingChatToolLoopPreflightRequest = toolLoopRequest;
    floatingChatToolLoopPreflightMaxSteps = maxSteps;
    try {
      updateNotice('Recording floating chat tool-loop preflight...');
      floatingChatToolLoopPreflightAction = await postBackendJson<FloatingChatToolLoopPreflightAction>('/actions/floating-chat-tool-loop-preflight', { mode: 'execute', confirmation, previewReceiptId, conversationId, toolLoopRequest, maxSteps: Number(maxSteps) });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatToolLoopPreflightAction.ok ? 'Floating chat tool-loop preflight recorded.' : 'Floating chat tool-loop preflight blocked.');
    } catch (error) {
      floatingChatToolLoopPreflightAction = { ...floatingChatToolLoopPreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-tool-loop-preflight')?.addEventListener('click', () => {
    floatingChatToolLoopPreflightConversationId = '';
    floatingChatToolLoopPreflightRequest = '';
    floatingChatToolLoopPreflightMaxSteps = '3';
    floatingChatToolLoopPreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-conversation')?.addEventListener('input', (event) => {
    floatingChatToolLoopExecuteConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-loop-execute-request')?.addEventListener('input', (event) => {
    floatingChatToolLoopExecuteRequest = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-max-steps')?.addEventListener('input', (event) => {
    floatingChatToolLoopExecuteMaxSteps = (event.target as HTMLInputElement).value || '3';
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-step-index')?.addEventListener('input', (event) => {
    floatingChatToolLoopExecuteStepIndex = (event.target as HTMLInputElement).value || '1';
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-max-result-chars')?.addEventListener('input', (event) => {
    floatingChatToolLoopExecuteMaxResultChars = (event.target as HTMLInputElement).value || '12000';
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-tool-loop-execute')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-conversation')?.value || floatingChatToolLoopExecuteConversationId || floatingChatToolLoopPreflightConversationId;
    const toolLoopRequest = document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-loop-execute-request')?.value || floatingChatToolLoopExecuteRequest || floatingChatToolLoopPreflightRequest;
    const maxSteps = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-max-steps')?.value || floatingChatToolLoopExecuteMaxSteps || '3';
    const stepIndex = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-step-index')?.value || floatingChatToolLoopExecuteStepIndex || '1';
    const maxResultChars = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-max-result-chars')?.value || floatingChatToolLoopExecuteMaxResultChars || '12000';
    floatingChatToolLoopExecuteConversationId = conversationId;
    floatingChatToolLoopExecuteRequest = toolLoopRequest;
    floatingChatToolLoopExecuteMaxSteps = maxSteps;
    floatingChatToolLoopExecuteStepIndex = stepIndex;
    floatingChatToolLoopExecuteMaxResultChars = maxResultChars;
    try {
      updateNotice('Previewing floating chat tool-loop one-step execute...');
      floatingChatToolLoopExecuteAction = await postBackendJson<FloatingChatToolLoopExecuteAction>('/actions/floating-chat-tool-loop-execute', { mode: 'preview', conversationId, toolLoopRequest, maxSteps: Number(maxSteps), stepIndex: Number(stepIndex), maxResultChars: Number(maxResultChars) });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat tool-loop one-step execute preview ready.');
    } catch (error) {
      floatingChatToolLoopExecuteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-tool-loop-execute')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-conversation')?.value || floatingChatToolLoopExecuteConversationId || floatingChatToolLoopPreflightConversationId;
    const toolLoopRequest = document.querySelector<HTMLTextAreaElement>('#floating-chat-tool-loop-execute-request')?.value || floatingChatToolLoopExecuteRequest || floatingChatToolLoopPreflightRequest;
    const maxSteps = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-max-steps')?.value || floatingChatToolLoopExecuteMaxSteps || '3';
    const stepIndex = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-step-index')?.value || floatingChatToolLoopExecuteStepIndex || '1';
    const maxResultChars = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-max-result-chars')?.value || floatingChatToolLoopExecuteMaxResultChars || '12000';
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-tool-loop-execute-confirmation')?.value || '';
    const previewReceiptId = floatingChatToolLoopExecuteAction?.preview?.previewReceipt?.id || '';
    floatingChatToolLoopExecuteConversationId = conversationId;
    floatingChatToolLoopExecuteRequest = toolLoopRequest;
    floatingChatToolLoopExecuteMaxSteps = maxSteps;
    floatingChatToolLoopExecuteStepIndex = stepIndex;
    floatingChatToolLoopExecuteMaxResultChars = maxResultChars;
    try {
      updateNotice('Running one floating chat tool-loop step...');
      floatingChatToolLoopExecuteAction = await postBackendJson<FloatingChatToolLoopExecuteAction>('/actions/floating-chat-tool-loop-execute', { mode: 'execute', confirmation, previewReceiptId, conversationId, toolLoopRequest, maxSteps: Number(maxSteps), stepIndex: Number(stepIndex), maxResultChars: Number(maxResultChars) });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatToolLoopExecuteAction.ok ? 'Floating chat tool-loop step completed.' : 'Floating chat tool-loop step blocked.');
    } catch (error) {
      floatingChatToolLoopExecuteAction = { ...floatingChatToolLoopExecuteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-tool-loop-execute')?.addEventListener('click', () => {
    floatingChatToolLoopExecuteConversationId = '';
    floatingChatToolLoopExecuteRequest = '';
    floatingChatToolLoopExecuteMaxSteps = '3';
    floatingChatToolLoopExecuteStepIndex = '1';
    floatingChatToolLoopExecuteMaxResultChars = '12000';
    floatingChatToolLoopExecuteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#use-next-floating-chat-tool-loop-step')?.addEventListener('click', () => {
    const currentStep = Number(floatingChatToolLoopExecuteAction?.report?.loopExecution?.stepIndex || floatingChatToolLoopExecuteAction?.report?.contract?.selectedStep?.index || floatingChatToolLoopExecuteStepIndex || 0);
    const plannedSteps = Number(floatingChatToolLoopExecuteAction?.report?.contract?.plannedStepCount || 0);
    const nextStep = currentStep + 1;
    if (plannedSteps && nextStep > plannedSteps) {
      updateNotice('No additional planned loop step is available.');
      return;
    }
    floatingChatToolLoopExecuteStepIndex = String(nextStep);
    floatingChatToolLoopExecuteAction = undefined;
    updateNotice(`Step ${nextStep} selected. Preview again to create a fresh receipt.`);
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#use-loop-result-for-source-write-preflight')?.addEventListener('click', () => {
    sourceWritePreflightConversationId = floatingChatToolLoopExecuteAction?.report?.conversation?.id || floatingChatToolLoopExecuteConversationId || floatingChatToolLoopPreflightConversationId;
    sourceWritePreflightToolResultId = floatingChatToolLoopExecuteAction?.report?.conversation?.toolTurnId || '';
    sourceWritePreflightAction = undefined;
    updateNotice('Loop tool result selected for source-write preflight. Add a target path and proposed content, then preview.');
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#source-write-preflight-conversation')?.addEventListener('input', (event) => {
    sourceWritePreflightConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>('#source-write-preflight-tool-result')?.addEventListener('input', (event) => {
    sourceWritePreflightToolResultId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>('#source-write-preflight-target')?.addEventListener('input', (event) => {
    sourceWritePreflightTargetPath = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>('#source-write-preflight-validation')?.addEventListener('input', (event) => {
    sourceWritePreflightValidationCommand = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#source-write-preflight-proposed-content')?.addEventListener('input', (event) => {
    sourceWritePreflightProposedContent = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-source-write-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#source-write-preflight-conversation')?.value || sourceWritePreflightConversationId || floatingChatToolLoopExecuteConversationId || floatingChatToolLoopPreflightConversationId;
    const toolResultId = document.querySelector<HTMLInputElement>('#source-write-preflight-tool-result')?.value || sourceWritePreflightToolResultId;
    const targetPath = document.querySelector<HTMLInputElement>('#source-write-preflight-target')?.value || sourceWritePreflightTargetPath;
    const validationCommand = document.querySelector<HTMLInputElement>('#source-write-preflight-validation')?.value || sourceWritePreflightValidationCommand;
    const proposedContent = document.querySelector<HTMLTextAreaElement>('#source-write-preflight-proposed-content')?.value ?? sourceWritePreflightProposedContent;
    sourceWritePreflightConversationId = conversationId;
    sourceWritePreflightToolResultId = toolResultId;
    sourceWritePreflightTargetPath = targetPath;
    sourceWritePreflightValidationCommand = validationCommand;
    sourceWritePreflightProposedContent = proposedContent;
    try {
      updateNotice('Previewing source-write preflight...');
      sourceWritePreflightAction = await postBackendJson<SourceWritePreflightAction>('/actions/source-write-preflight', { mode: 'preview', conversationId, toolResultId, path: targetPath, proposedContent, validationCommand });
      if (latestState) renderState(latestState);
      updateNotice('Source-write preflight preview ready.');
    } catch (error) {
      sourceWritePreflightAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-source-write-preflight')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#source-write-preflight-conversation')?.value || sourceWritePreflightConversationId || floatingChatToolLoopExecuteConversationId || floatingChatToolLoopPreflightConversationId;
    const toolResultId = document.querySelector<HTMLInputElement>('#source-write-preflight-tool-result')?.value || sourceWritePreflightToolResultId;
    const targetPath = document.querySelector<HTMLInputElement>('#source-write-preflight-target')?.value || sourceWritePreflightTargetPath;
    const validationCommand = document.querySelector<HTMLInputElement>('#source-write-preflight-validation')?.value || sourceWritePreflightValidationCommand;
    const proposedContent = document.querySelector<HTMLTextAreaElement>('#source-write-preflight-proposed-content')?.value ?? sourceWritePreflightProposedContent;
    const confirmation = document.querySelector<HTMLInputElement>('#source-write-preflight-confirmation')?.value || '';
    const previewReceiptId = sourceWritePreflightAction?.preview?.previewReceipt?.id || '';
    sourceWritePreflightConversationId = conversationId;
    sourceWritePreflightToolResultId = toolResultId;
    sourceWritePreflightTargetPath = targetPath;
    sourceWritePreflightValidationCommand = validationCommand;
    sourceWritePreflightProposedContent = proposedContent;
    try {
      updateNotice('Recording source-write preflight...');
      sourceWritePreflightAction = await postBackendJson<SourceWritePreflightAction>('/actions/source-write-preflight', { mode: 'execute', confirmation, previewReceiptId, conversationId, toolResultId, path: targetPath, proposedContent, validationCommand });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(sourceWritePreflightAction.ok ? 'Source-write preflight recorded.' : 'Source-write preflight blocked.');
    } catch (error) {
      sourceWritePreflightAction = { ...sourceWritePreflightAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-source-write-preflight')?.addEventListener('click', () => {
    sourceWritePreflightConversationId = '';
    sourceWritePreflightToolResultId = '';
    sourceWritePreflightTargetPath = '';
    sourceWritePreflightProposedContent = '';
    sourceWritePreflightValidationCommand = '';
    sourceWritePreflightAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#use-preflight-for-source-write-execute')?.addEventListener('click', () => {
    sourceWriteExecutePreflightReportPath = sourceWritePreflightAction?.reportPath || sourceWritePreflightAction?.report?.reportPath || '';
    sourceWriteExecuteProposedContent = sourceWritePreflightProposedContent;
    sourceWriteExecuteAction = undefined;
    updateNotice('Source-write preflight report selected for execute. Preview the high-risk action before executing.');
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#source-write-execute-preflight-report')?.addEventListener('input', (event) => {
    sourceWriteExecutePreflightReportPath = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#source-write-execute-proposed-content')?.addEventListener('input', (event) => {
    sourceWriteExecuteProposedContent = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-source-write-execute')?.addEventListener('click', async () => {
    const preflightReportPath = document.querySelector<HTMLInputElement>('#source-write-execute-preflight-report')?.value || sourceWriteExecutePreflightReportPath || sourceWritePreflightAction?.reportPath || '';
    const proposedContent = document.querySelector<HTMLTextAreaElement>('#source-write-execute-proposed-content')?.value ?? (sourceWriteExecuteProposedContent || sourceWritePreflightProposedContent);
    sourceWriteExecutePreflightReportPath = preflightReportPath;
    sourceWriteExecuteProposedContent = proposedContent;
    try {
      updateNotice('Previewing high-risk source-write execute...');
      sourceWriteExecuteAction = await postBackendJson<SourceWriteExecuteAction>('/actions/source-write-execute', { mode: 'preview', preflightReportPath, proposedContent });
      if (latestState) renderState(latestState);
      updateNotice('Source-write execute preview ready. Exact confirmation is required before any file write.');
    } catch (error) {
      sourceWriteExecuteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-source-write-execute')?.addEventListener('click', async () => {
    const preflightReportPath = document.querySelector<HTMLInputElement>('#source-write-execute-preflight-report')?.value || sourceWriteExecutePreflightReportPath || sourceWritePreflightAction?.reportPath || '';
    const proposedContent = document.querySelector<HTMLTextAreaElement>('#source-write-execute-proposed-content')?.value ?? (sourceWriteExecuteProposedContent || sourceWritePreflightProposedContent);
    const confirmation = document.querySelector<HTMLInputElement>('#source-write-execute-confirmation')?.value || '';
    const previewReceiptId = sourceWriteExecuteAction?.preview?.previewReceipt?.id || '';
    sourceWriteExecutePreflightReportPath = preflightReportPath;
    sourceWriteExecuteProposedContent = proposedContent;
    try {
      updateNotice('Executing source write with receipt and exact confirmation...');
      sourceWriteExecuteAction = await postBackendJson<SourceWriteExecuteAction>('/actions/source-write-execute', { mode: 'execute', confirmation, previewReceiptId, preflightReportPath, proposedContent });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(sourceWriteExecuteAction.ok ? 'Source-write execute completed with receipts.' : 'Source-write execute blocked before write.');
    } catch (error) {
      sourceWriteExecuteAction = { ...sourceWriteExecuteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-source-write-execute')?.addEventListener('click', () => {
    sourceWriteExecutePreflightReportPath = '';
    sourceWriteExecuteProposedContent = '';
    sourceWriteExecuteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-autonomy-next-conversation')?.addEventListener('input', (event) => {
    floatingChatAutonomyNextConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-autonomy-next')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-autonomy-next-conversation')?.value || floatingChatAutonomyNextConversationId;
    floatingChatAutonomyNextConversationId = conversationId;
    try {
      updateNotice('Previewing floating chat autonomy next step...');
      floatingChatAutonomyNextAction = await postBackendJson<FloatingChatAutonomyNextAction>('/actions/floating-chat-autonomy-next', { mode: 'preview', conversationId });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat autonomy next-step preview ready.');
    } catch (error) {
      floatingChatAutonomyNextAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-autonomy-next')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-autonomy-next-conversation')?.value || floatingChatAutonomyNextConversationId;
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-autonomy-next-confirmation')?.value || '';
    const previewReceiptId = floatingChatAutonomyNextAction?.preview?.previewReceipt?.id || '';
    floatingChatAutonomyNextConversationId = conversationId;
    try {
      updateNotice('Recording floating chat autonomy next step...');
      floatingChatAutonomyNextAction = await postBackendJson<FloatingChatAutonomyNextAction>('/actions/floating-chat-autonomy-next', { mode: 'execute', confirmation, previewReceiptId, conversationId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatAutonomyNextAction.ok ? 'Floating chat autonomy next step recorded.' : 'Floating chat autonomy next step blocked.');
    } catch (error) {
      floatingChatAutonomyNextAction = { ...floatingChatAutonomyNextAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-autonomy-next')?.addEventListener('click', () => {
    floatingChatAutonomyNextConversationId = '';
    floatingChatAutonomyNextAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-conversation')?.addEventListener('input', (event) => {
    floatingChatToolExecuteConversationId = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-tool')?.addEventListener('input', (event) => {
    floatingChatToolExecuteTool = (event.target as HTMLInputElement).value || 'list-dir';
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-path')?.addEventListener('input', (event) => {
    floatingChatToolExecutePath = (event.target as HTMLInputElement).value || '.';
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-pattern')?.addEventListener('input', (event) => {
    floatingChatToolExecutePattern = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-max-chars')?.addEventListener('input', (event) => {
    floatingChatToolExecuteMaxChars = (event.target as HTMLInputElement).value || '12000';
  });
  document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-max-matches')?.addEventListener('input', (event) => {
    floatingChatToolExecuteMaxMatches = (event.target as HTMLInputElement).value || '80';
  });
  document.querySelector<HTMLButtonElement>('#preview-floating-chat-tool-execute')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-conversation')?.value || floatingChatToolExecuteConversationId;
    const tool = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-tool')?.value || floatingChatToolExecuteTool || 'list-dir';
    const targetPath = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-path')?.value || floatingChatToolExecutePath || '.';
    const pattern = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-pattern')?.value || floatingChatToolExecutePattern;
    const maxChars = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-max-chars')?.value || floatingChatToolExecuteMaxChars || '12000';
    const maxMatches = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-max-matches')?.value || floatingChatToolExecuteMaxMatches || '80';
    floatingChatToolExecuteConversationId = conversationId;
    floatingChatToolExecuteTool = tool;
    floatingChatToolExecutePath = targetPath;
    floatingChatToolExecutePattern = pattern;
    floatingChatToolExecuteMaxChars = maxChars;
    floatingChatToolExecuteMaxMatches = maxMatches;
    try {
      updateNotice('Previewing floating chat read-only tool...');
      floatingChatToolExecuteAction = await postBackendJson<FloatingChatToolExecuteAction>('/actions/floating-chat-tool-execute', { mode: 'preview', conversationId, tool, path: targetPath, pattern, maxChars: Number(maxChars), maxMatches: Number(maxMatches) });
      if (latestState) renderState(latestState);
      updateNotice('Floating chat read-only tool preview ready.');
    } catch (error) {
      floatingChatToolExecuteAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-floating-chat-tool-execute')?.addEventListener('click', async () => {
    const conversationId = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-conversation')?.value || floatingChatToolExecuteConversationId;
    const tool = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-tool')?.value || floatingChatToolExecuteTool || 'list-dir';
    const targetPath = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-path')?.value || floatingChatToolExecutePath || '.';
    const pattern = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-pattern')?.value || floatingChatToolExecutePattern;
    const maxChars = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-max-chars')?.value || floatingChatToolExecuteMaxChars || '12000';
    const maxMatches = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-max-matches')?.value || floatingChatToolExecuteMaxMatches || '80';
    const confirmation = document.querySelector<HTMLInputElement>('#floating-chat-tool-execute-confirmation')?.value || '';
    const previewReceiptId = floatingChatToolExecuteAction?.preview?.previewReceipt?.id || '';
    floatingChatToolExecuteConversationId = conversationId;
    floatingChatToolExecuteTool = tool;
    floatingChatToolExecutePath = targetPath;
    floatingChatToolExecutePattern = pattern;
    floatingChatToolExecuteMaxChars = maxChars;
    floatingChatToolExecuteMaxMatches = maxMatches;
    try {
      updateNotice('Running floating chat read-only tool...');
      floatingChatToolExecuteAction = await postBackendJson<FloatingChatToolExecuteAction>('/actions/floating-chat-tool-execute', { mode: 'execute', confirmation, previewReceiptId, conversationId, tool, path: targetPath, pattern, maxChars: Number(maxChars), maxMatches: Number(maxMatches) });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(floatingChatToolExecuteAction.ok ? 'Floating chat read-only tool completed.' : 'Floating chat read-only tool blocked or failed.');
    } catch (error) {
      floatingChatToolExecuteAction = { ...floatingChatToolExecuteAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-floating-chat-tool-execute')?.addEventListener('click', () => {
    floatingChatToolExecuteConversationId = '';
    floatingChatToolExecuteTool = 'list-dir';
    floatingChatToolExecutePath = '.';
    floatingChatToolExecutePattern = '';
    floatingChatToolExecuteMaxChars = '12000';
    floatingChatToolExecuteMaxMatches = '80';
    floatingChatToolExecuteAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-autonomy-commit-gate')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing autonomy/commit gate action...');
      autonomyCommitGateAction = await postBackendJson<AutonomyCommitGateAction>('/actions/autonomy-commit-gate', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Autonomy/commit gate preview ready.');
    } catch (error) {
      autonomyCommitGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-autonomy-commit-gate')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#autonomy-commit-gate-confirmation')?.value || '';
    const previewReceiptId = autonomyCommitGateAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating autonomy/commit gate...');
      autonomyCommitGateAction = await postBackendJson<AutonomyCommitGateAction>('/actions/autonomy-commit-gate', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(autonomyCommitGateAction.ok ? 'Autonomy/commit gate created.' : 'Autonomy/commit gate created with warnings.');
    } catch (error) {
      autonomyCommitGateAction = { ...autonomyCommitGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-autonomy-commit-gate')?.addEventListener('click', () => {
    autonomyCommitGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-outside-tool-policy-gate')?.addEventListener('click', async () => {
    try {
      updateNotice('Previewing outside tool policy gate...');
      outsideToolPolicyGateAction = await postBackendJson<OutsideToolPolicyGateAction>('/actions/outside-tool-policy-gate', { mode: 'preview' });
      if (latestState) renderState(latestState);
      updateNotice('Outside tool policy gate preview ready.');
    } catch (error) {
      outsideToolPolicyGateAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-outside-tool-policy-gate')?.addEventListener('click', async () => {
    const confirmation = document.querySelector<HTMLInputElement>('#outside-tool-policy-gate-confirmation')?.value || '';
    const previewReceiptId = outsideToolPolicyGateAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating outside tool policy gate...');
      outsideToolPolicyGateAction = await postBackendJson<OutsideToolPolicyGateAction>('/actions/outside-tool-policy-gate', { mode: 'execute', confirmation, previewReceiptId });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(outsideToolPolicyGateAction.ok ? 'Outside tool policy gate created.' : 'Outside tool policy gate created with warnings.');
    } catch (error) {
      outsideToolPolicyGateAction = { ...outsideToolPolicyGateAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-outside-tool-policy-gate')?.addEventListener('click', () => {
    outsideToolPolicyGateAction = undefined;
    if (latestState) renderState(latestState);
  });
  document.querySelector<HTMLButtonElement>('#preview-autonomy-dry-run')?.addEventListener('click', async () => {
    const input = readAutonomyDryRunInputs();
    try {
      updateNotice('Previewing autonomy dry-run...');
      autonomyDryRunAction = await postBackendJson<AutonomyDryRunAction>('/actions/autonomy-dry-run', { mode: 'preview', ...input });
      if (latestState) renderState(latestState);
      updateNotice('Autonomy dry-run preview ready.');
    } catch (error) {
      autonomyDryRunAction = { error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#execute-autonomy-dry-run')?.addEventListener('click', async () => {
    const input = readAutonomyDryRunInputs();
    const confirmation = document.querySelector<HTMLInputElement>('#autonomy-dry-run-confirmation')?.value || '';
    const previewReceiptId = autonomyDryRunAction?.preview?.previewReceipt?.id || '';
    try {
      updateNotice('Creating autonomy dry-run report...');
      autonomyDryRunAction = await postBackendJson<AutonomyDryRunAction>('/actions/autonomy-dry-run', { mode: 'execute', confirmation, previewReceiptId, ...input });
      if (latestState) renderState(latestState);
      await refreshState();
      updateNotice(autonomyDryRunAction.ok ? 'Autonomy dry-run report created.' : 'Autonomy dry-run report created with blocks.');
    } catch (error) {
      autonomyDryRunAction = { ...autonomyDryRunAction, error: error instanceof Error ? error.message : String(error) };
      if (latestState) renderState(latestState);
    }
  });
  document.querySelector<HTMLButtonElement>('#clear-autonomy-dry-run')?.addEventListener('click', () => {
    autonomyDryRunAction = undefined;
    if (latestState) renderState(latestState);
  });
}

function statusClass(status: string | undefined): string {
  if (status === 'block') return 'danger';
  if (status === 'warn') return 'warn';
  return 'ok';
}

function formatDefault(value: unknown): string {
  if (value === false) return 'off';
  if (value === true) return 'on';
  return String(value ?? 'missing');
}

function render(backendValue: string): void {
  appRoot.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <h1>Harmony Native Control</h1>
          <p id="workspace-line">Outside-VS control window with floating chat actions</p>
        </div>
        <div class="connection" aria-label="Harmony backend connection">
          <input id="backend-url" value="${escapeHtml(backendValue)}" aria-label="Backend URL" />
          <button id="connect" type="button">Connect</button>
          <button id="reset-backend" type="button">Reset</button>
          <button id="reload" type="button" aria-label="Reload backend view">Reload</button>
          <button id="open-backend" type="button">Open</button>
        </div>
      </header>
      <section class="notice" id="notice">Connecting to ${escapeHtml(backendValue)}</section>
      <section class="actions" aria-label="Safe read-only actions">
        <button type="button" data-panel-target="#policy">Refresh policy</button>
        <button type="button" data-panel-target="#broker">Broker queue</button>
        <button type="button" data-panel-target="#snapshots">Restore commands</button>
        <button type="button" data-panel-target="#smoke-reports">Smoke reports</button>
        <button type="button" data-panel-target="#cross-surface">Diagnostics</button>
        <button type="button" data-panel-target="#controlled-actions">Floating chat and actions</button>
      </section>
      <section class="health-panel" id="health-panel"></section>
      <section class="metrics" id="metrics"></section>
      <section class="panel-grid">
        <article class="panel wide"><h2>Floating Chat And Controlled Actions</h2><div id="controlled-actions"></div></article>
        <article class="panel wide"><h2>Cross-Surface</h2><div id="cross-surface"></div></article>
        <article class="panel"><h2>Policy</h2><div id="policy"></div></article>
        <article class="panel"><h2>Providers</h2><div id="providers"></div></article>
        <article class="panel wide"><h2>Broker Queue</h2><div id="broker"></div></article>
        <article class="panel wide"><h2>Operations</h2><div id="operations"></div></article>
        <article class="panel"><h2>Locks</h2><div id="locks"></div></article>
        <article class="panel"><h2>Snapshots</h2><div id="snapshots"></div></article>
        <article class="panel wide"><h2>Smoke Reports</h2><div id="smoke-reports"></div></article>
        <article class="panel wide"><h2>Swarm Safety</h2><div id="swarm-safety"></div></article>
        <article class="panel wide"><h2>Surfaces</h2><div id="surfaces"></div></article>
      </section>
    </section>
  `;

  const input = document.querySelector<HTMLInputElement>('#backend-url');
  const connect = document.querySelector<HTMLButtonElement>('#connect');
  const resetBackend = document.querySelector<HTMLButtonElement>('#reset-backend');
  const reload = document.querySelector<HTMLButtonElement>('#reload');
  const openBackend = document.querySelector<HTMLButtonElement>('#open-backend');
  const notice = document.querySelector<HTMLElement>('#notice');
  if (!input || !connect || !resetBackend || !reload || !openBackend || !notice) return;

  connect.addEventListener('click', () => {
    try {
      setBackendUrl(input.value, true);
      notice.textContent = `Connected to ${backendUrl}`;
      startRefresh();
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  resetBackend.addEventListener('click', () => {
    setBackendUrl(DEFAULT_BACKEND, false);
    notice.textContent = `Reset to ${backendUrl}`;
    startRefresh();
  });

  reload.addEventListener('click', () => {
    offlinePolls = 0;
    void refreshState();
  });

  openBackend.addEventListener('click', () => {
    window.open(backendUrl, '_blank', 'noopener,noreferrer');
  });

  document.querySelectorAll<HTMLButtonElement>('[data-panel-target]').forEach((button) => {
    button.addEventListener('click', () => {
      void refreshState();
      const target = document.querySelector<HTMLElement>(button.dataset.panelTarget || '');
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  startRefresh();
}

function renderState(state: HarmonyState): void {
  latestState = state;
  const workspaceLine = document.querySelector<HTMLElement>('#workspace-line');
  const notice = document.querySelector<HTMLElement>('#notice');
  const healthPanel = document.querySelector<HTMLElement>('#health-panel');
  const metrics = document.querySelector<HTMLElement>('#metrics');
  const controlledActions = document.querySelector<HTMLElement>('#controlled-actions');
  const policy = document.querySelector<HTMLElement>('#policy');
  const crossSurface = document.querySelector<HTMLElement>('#cross-surface');
  const providers = document.querySelector<HTMLElement>('#providers');
  const broker = document.querySelector<HTMLElement>('#broker');
  const operations = document.querySelector<HTMLElement>('#operations');
  const locks = document.querySelector<HTMLElement>('#locks');
  const snapshots = document.querySelector<HTMLElement>('#snapshots');
  const smokeReports = document.querySelector<HTMLElement>('#smoke-reports');
  const swarmSafety = document.querySelector<HTMLElement>('#swarm-safety');
  const surfaces = document.querySelector<HTMLElement>('#surfaces');
  if (!workspaceLine || !notice || !healthPanel || !metrics || !controlledActions || !policy || !crossSurface || !providers || !broker || !operations || !locks || !snapshots || !smokeReports || !swarmSafety || !surfaces) return;

  const health = state.health || { status: 'ok', warnings: [], blocks: [] };
  const hubLocks = listCount(state.hubSupervisor?.response?.locks);
  const configuredProviders = (state.providerStatus || []).filter((item) => item.configured).length;
  const failClosed = (state.swarmSafetySwitches || []).filter((item) => item.failClosed).length;
  const brokerPending = listCount(state.broker?.pending);

  workspaceLine.textContent = `${state.workspace || 'unknown workspace'} · ${state.cliVersion || 'unknown version'}`;
  notice.textContent = `Live ${backendUrl} · ${state.generatedAt || 'no timestamp'}`;
  healthPanel.className = `health-panel ${statusClass(health.status)}`;
  const healthItems = [...(health.blocks || []).map((text) => ['Block', text]), ...(health.warnings || []).map((text) => ['Warn', text])];
  healthPanel.innerHTML = `<div><span>Health</span><strong>${escapeHtml(String(health.status || 'ok').toUpperCase())}</strong></div>${healthItems.length ? `<ul>${healthItems.map(([kind, text]) => `<li><b>${escapeHtml(kind)}</b> ${escapeHtml(text)}</li>`).join('')}</ul>` : '<p>No coordination warnings detected.</p>'}`;
  metrics.innerHTML = [
    metric('Hub', state.hub?.online ? 'online' : 'offline'),
    metric('Active surfaces', state.supervisor?.active || 0),
    metric('Local locks', listCount(state.locks)),
    metric('Hub locks', hubLocks),
    metric('Operations', listCount(state.operationLedger?.entries)),
    metric('Providers', `${configuredProviders}/${listCount(state.providerStatus)}`),
    metric('Broker pending', brokerPending),
    metric('Snapshots', listCount(state.snapshots)),
    metric('Smoke reports', listCount(state.smokeReports)),
    metric('Safety', `${failClosed}/${listCount(state.swarmSafetySwitches)}`),
  ].join('');

  controlledActions.innerHTML = renderControlledActions();
  wireControlledActions();

  const editorRows = (state.crossSurface?.installedEditors || []).map((item) => `<tr><td>${escapeHtml(item.editor || '?')}</td><td>${escapeHtml(item.installed ? 'yes' : 'no')}</td><td>${escapeHtml(item.version || '')}</td><td>${escapeHtml(boolLabel(item.matchesExpected))}</td></tr>`);
  const diagnosticRows = [
    `<tr><td>Expected extension</td><td>${escapeHtml(state.crossSurface?.expectedVersion || state.cliVersion || '')}</td></tr>`,
    `<tr><td>Bundled Hub</td><td>${escapeHtml(state.crossSurface?.bundledHub?.version || (state.crossSurface?.bundledHub?.exists ? 'present' : 'missing'))}</td></tr>`,
    `<tr><td>Native backend</td><td>${escapeHtml(state.crossSurface?.nativeBackend?.online === undefined ? state.crossSurface?.nativeBackend?.source || 'not checked' : state.crossSurface?.nativeBackend?.online ? 'online' : 'offline')}</td></tr>`,
    `<tr><td>Secret store</td><td>${escapeHtml(`${state.crossSurface?.secretStore?.storedProviders ?? 0}/${state.crossSurface?.secretStore?.totalProviders ?? 0} stored`)}</td></tr>`,
    `<tr><td>Safety switches</td><td>${escapeHtml(`${state.crossSurface?.safetySwitches?.failClosed ?? 0}/${state.crossSurface?.safetySwitches?.total ?? 0} fail closed`)}</td></tr>`,
  ];
  crossSurface.innerHTML = `${table(['Editor', 'Installed', 'Version', 'Expected'], editorRows, 'No editor install metadata available.')}${table(['Signal', 'Value'], diagnosticRows, 'No cross-surface diagnostics available.')}`;

  const permissions = state.outsidePolicy?.permissions || {};
  const budgets = state.outsidePolicy?.budgets || {};
  const permissionRows = Object.entries(permissions).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(String(value))}</td></tr>`);
  const budgetRows = Object.entries(budgets).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(String(value))}</td></tr>`);
  policy.innerHTML = `<div class="kv"><span>Mode</span><strong>${escapeHtml(state.outsidePolicy?.mode || 'missing')}</strong></div>${table(['Permission', 'Value'], permissionRows, 'No policy permissions recorded.')}${table(['Budget', 'Value'], budgetRows, 'No budgets recorded.')}`;

  const providerRows = (state.providerStatus || []).map((item) => `<tr><td>${escapeHtml(providerDisplayName(item.provider))}</td><td>${escapeHtml(boolLabel(item.configured))}</td><td>${escapeHtml(item.credentialName || item.credentialSource || '')}</td><td>${escapeHtml(item.executable ? 'yes' : 'not yet')}</td><td>${escapeHtml(item.defaultModel || '')}</td><td>${escapeHtml(latencyLabel(item.lastLatencyMs))}</td></tr>`);
  const secretRows = (state.providerSecrets || []).map((item) => `<tr><td>${escapeHtml(providerDisplayName(item.provider))}</td><td>${escapeHtml(boolLabel(item.stored))}</td><td>${escapeHtml(item.encryption || '')}</td><td>${escapeHtml(item.updatedAt || '')}</td></tr>`);
  providers.innerHTML = `${table(['Provider', 'Configured', 'Credential', 'Executable', 'Default Model', 'Last Latency'], providerRows, 'No provider status available.')}${table(['Secret Provider', 'Stored', 'Encryption', 'Updated'], secretRows, 'No local secret metadata available.')}`;

  const pendingRows = (state.broker?.pending || []).map((item) => `<tr><td>${escapeHtml(item.id || '?')}</td><td>${escapeHtml(item.provider || '')}</td><td>${escapeHtml(item.tier || '')}</td><td>${escapeHtml(item.age || '')}</td></tr>`);
  broker.innerHTML = `<p class="empty">${escapeHtml(state.broker?.noVsCodeBehavior || 'No broker status available.')}</p>${table(['Request', 'Provider', 'Tier', 'Age'], pendingRows, 'No pending broker requests.')}`;

  const operationRows = (state.operationLedger?.entries || []).slice(0, 10).map((item) => `<tr><td>${escapeHtml(item.timestamp || '?')}</td><td>${escapeHtml(item.status || '?')}</td><td>${escapeHtml(item.label || item.kind || '?')}</td></tr>`);
  operations.innerHTML = table(['Time', 'Status', 'Label'], operationRows, 'No operation entries.');

  const lockRows = (state.locks || []).map((item) => `<tr><td>${escapeHtml(item.file || '')}</td><td>${escapeHtml(item.operation || item.resource || '?')}</td><td>${escapeHtml(item.expiresAt || '')}</td><td>${escapeHtml(boolLabel(item.expired))}</td></tr>`);
  locks.innerHTML = table(['File', 'Operation', 'Expires', 'Expired'], lockRows, 'No local locks.');

  const snapshotRows = (state.snapshots || []).map((item) => `<tr><td>${escapeHtml(item.id || '?')}</td><td>${escapeHtml(item.createdAt || '')}</td><td>${escapeHtml(item.coverage || `${item.copied ?? 0}/${item.fileCount ?? 0}`)}</td><td><code>${escapeHtml(item.restoreCommand || '')}</code></td><td>${escapeHtml(item.reason || '')}</td></tr>`);
  snapshots.innerHTML = table(['Snapshot', 'Created', 'Coverage', 'Restore Command', 'Reason'], snapshotRows, 'No snapshots recorded.');

  const smokeRows = (state.smokeReports || []).map((item) => `<tr><td>${escapeHtml(item.id || '?')}</td><td>${escapeHtml(item.createdAt || '')}</td><td>${escapeHtml(item.status || '')}</td><td>${escapeHtml(`${item.passed ?? 0}/${(item.passed ?? 0) + (item.failed ?? 0)}`)}</td><td>${escapeHtml(item.path || '')}</td></tr>`);
  smokeReports.innerHTML = table(['Report', 'Created', 'Status', 'Passed', 'Path'], smokeRows, 'No smoke reports recorded.');

  const swarmDefaults = state.swarmDefaultStatus || {};
  const riskyDefaults = swarmDefaults.riskySwitchesOnByDefault || [];
  const swarmSummaryRows = [
    `<tr><td>Default mode</td><td>${escapeHtml(swarmDefaults.mode || 'plan-only launcher default')}</td></tr>`,
    `<tr><td>Default provider</td><td>${escapeHtml(`${swarmDefaults.provider || 'deepseek'} / ${swarmDefaults.tier || 'coding'}`)}</td></tr>`,
    `<tr><td>Risk switches default</td><td>${escapeHtml(riskyDefaults.length ? riskyDefaults.join(', ') : 'all off')}</td></tr>`,
    `<tr><td>Status source</td><td>${escapeHtml(swarmDefaults.source || 'packaged extension defaults')}</td></tr>`,
    `<tr><td>Live settings</td><td>${escapeHtml(swarmDefaults.liveSettingsNote || 'Open the VS Code sidebar for active workspace switch values.')}</td></tr>`,
  ];
  const switchRows = (state.swarmSafetySwitches || []).map((item) => `<tr><td>${escapeHtml(item.label || item.key || '?')}</td><td>${escapeHtml(formatDefault(item.defaultValue))}</td><td>${escapeHtml(boolLabel(item.failClosed))}</td><td>${escapeHtml(boolLabel(item.enabledByDefault))}</td></tr>`);
  swarmSafety.innerHTML = `${table(['Signal', 'Value'], swarmSummaryRows, 'No swarm default safety summary available.')}${table(['Switch', 'Default', 'Fail Closed', 'Enabled By Default'], switchRows, 'No swarm safety switch metadata available.')}`;

  const surfaceRows = (state.supervisor?.heartbeats || []).map((item) => `<tr><td>${escapeHtml(item.surface || '?')}</td><td>${escapeHtml(item.pid || '?')}</td><td>${escapeHtml(item.status || '?')}</td><td>${escapeHtml(boolLabel(item.processAlive))}</td><td>${escapeHtml(item.label || '')}</td></tr>`);
  surfaces.innerHTML = table(['Surface', 'PID', 'Status', 'Alive', 'Label'], surfaceRows, 'No surface heartbeats yet.');
}

function renderOffline(error: unknown): void {
  const notice = document.querySelector<HTMLElement>('#notice');
  const healthPanel = document.querySelector<HTMLElement>('#health-panel');
  if (notice) {
    const detail = error instanceof Error ? error.message : String(error);
    notice.textContent = offlinePolls >= MAX_OFFLINE_POLLS
      ? `${backendUrl} is offline; polling paused. Start a backend or reset to ${DEFAULT_BACKEND}. Last error: ${detail}`
      : `${backendUrl} is offline. ${detail}`;
  }
  if (healthPanel) {
    healthPanel.className = 'health-panel danger';
    healthPanel.innerHTML = '<div><span>Health</span><strong>OFFLINE</strong></div><p>Localhost backend is unavailable.</p>';
  }
}

async function refreshState(): Promise<void> {
  try {
    const response = await fetch(endpoint('/state'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`);
    const state = await response.json() as HarmonyState;
    offlinePolls = 0;
    renderState(state);
  } catch (error) {
    offlinePolls += 1;
    renderOffline(error);
    if (offlinePolls >= MAX_OFFLINE_POLLS && refreshTimer !== undefined) {
      window.clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }
}

function startRefresh(): void {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  void refreshState();
  refreshTimer = window.setInterval(() => void refreshState(), REFRESH_MS);
}

render(backendUrl);
