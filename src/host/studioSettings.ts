/**
 * Shared settings contract for Harmony's chat surfaces.
 *
 * Why this file exists
 * --------------------
 * The Studio chat panel (VS Code webview) and the external Studio (loopback HTTP
 * server) used to reach settings by two separate routes, and one of those routes
 * kept a private shadow file. The same setting could therefore report two
 * different values depending on which surface asked, and a third value if the
 * headless host had written its own configuration. Nothing was broken in
 * isolation; the surfaces simply disagreed.
 *
 * This module is the single allowlist and the single reader/writer for every
 * surface. It enforces four rules:
 *
 * 1. Allowlist only. A key that is not declared in STUDIO_SETTINGS cannot be read
 *    or written through any surface. The external Studio is HTTP-reachable, so a
 *    wildcard settings writer would be a real hole rather than a convenience.
 *
 * 2. One logical store with a durable mirror. VS Code configuration is
 *    authoritative when the real extension host is present; `.harmony/settings.json`
 *    is always written too, because the headless host keeps its configuration
 *    there and reads only from there. Writing both is what makes one change
 *    visible to both hosts.
 *
 * 3. Legacy input is honoured, never silently dropped. `.harmony/cost-shield.json`
 *    is still read when nothing newer exists, so values written by older builds
 *    survive the migration. It is no longer written - only read.
 *
 * 4. No invented values. Every resolved value reports its `origin`. If nothing
 *    resolves, the value is null and the origin is 'unresolved', so the panel can
 *    say "not set" instead of displaying a number we made up.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isRunningInRealVscodeHost } from './vscodeHostShim';

export type StudioSettingType = 'enum' | 'number' | 'boolean' | 'string';

export interface StudioSettingOption {
    value: string;
    label: string;
}

export interface StudioSettingSpec {
    /** Key without the `harmony.` prefix, e.g. `costShield.mode`. */
    key: string;
    type: StudioSettingType;
    /** Grouping label used by the panel; ordering follows declaration order. */
    group: string;
    label: string;
    description?: string;
    options?: StudioSettingOption[];
    min?: number;
    max?: number;
    /** Allow empty string ('') as a valid value (e.g. optional project ID or custom URL). */
    allowEmpty?: boolean;
    /** Only set where the declared default is actually known. */
    default?: string | number | boolean;
}

export type StudioSettingOrigin =
    | 'vscode-config'
    | 'workspace-settings'
    | 'legacy-cost-shield'
    | 'schema-default'
    | 'unresolved';

export interface StudioSettingValue {
    key: string;
    type: StudioSettingType;
    group: string;
    label: string;
    description?: string;
    options?: StudioSettingOption[];
    min?: number;
    max?: number;
    value: string | number | boolean | null;
    /** Where the effective value came from, so the panel can disclose it. */
    origin: StudioSettingOrigin;
}

export interface StudioSettingWriteResult {
    ok: boolean;
    key?: string;
    value?: string | number | boolean;
    origin?: StudioSettingOrigin;
    error?: string;
}

export const STUDIO_SETTINGS_FILE = path.join('.harmony', 'settings.json');
export const LEGACY_COST_SHIELD_FILE = path.join('.harmony', 'cost-shield.json');

const PROVIDER_OPTIONS: StudioSettingOption[] = [
    { value: 'vscode-lm', label: 'VS Code Language Model' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'claude', label: 'Claude' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'kimiCode', label: 'Kimi Code' },
    { value: 'zhipu-coding', label: 'Zhipu GLM' },
    { value: 'alibaba', label: 'Alibaba Qwen' },
    { value: 'moonshot', label: 'Moonshot Kimi' },
    { value: 'tencent', label: 'Tencent' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'harmony-backend', label: 'Harmony Backend (HTTP)' },
    { value: 'auto', label: 'Auto (VS Code first, backend fallback)' },
];

const COLLABORATOR_ROUTE_OPTIONS: StudioSettingOption[] = [
    { value: 'agentsProfile', label: 'Auto Profile' },
    { value: 'deepseek:coding', label: 'DeepSeek V4.1' },
    { value: 'deepseek:light', label: 'DeepSeek Light' },
    { value: 'gemini:light', label: 'Gemini Flash' },
    { value: 'gemini:coding', label: 'Gemini Coding' },
    { value: 'claude:coding', label: 'Claude Coding' },
    { value: 'openai:coding', label: 'OpenAI Coding' },
];

const COST_SHIELD_OPTIONS: StudioSettingOption[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'manual', label: 'Manual' },
    { value: 'off', label: 'Off' },
];

const GEMINI_ENDPOINT_OPTIONS: StudioSettingOption[] = [
    { value: 'ai-studio', label: 'Google AI Studio (generativelanguage.googleapis.com)' },
    { value: 'vertex', label: 'Google Cloud Vertex AI (GCP Billing & Credits)' },
    { value: 'custom', label: 'Custom Gemini / Vertex URL' },
];

/**
 * The curated set exposed by every Studio surface. Deliberately small: these are
 * the keys a person actually changes mid-session. Adding a key here is the only
 * way to make it reachable from the panel, which keeps the write surface audited.
 */
export const STUDIO_SETTINGS: StudioSettingSpec[] = [
    {
        key: 'modelProvider',
        type: 'enum',
        group: 'Models',
        label: 'Default provider',
        description: 'Which provider Harmony reaches for on a new turn.',
        options: PROVIDER_OPTIONS,
    },
    {
        key: 'defaultProfile',
        type: 'string',
        group: 'Models',
        label: 'Default profile',
        description: 'Profile whose local history this surface loads on start.',
    },
    {
        key: 'gemini.endpointProfile',
        type: 'enum',
        group: 'Models',
        label: 'Gemini backend (AI Studio vs Vertex AI)',
        description: 'Route Gemini calls through Google AI Studio or Google Cloud Vertex AI (billed to GCP invoice/credits, no prepay top-up).',
        options: GEMINI_ENDPOINT_OPTIONS,
        default: 'ai-studio',
    },
    {
        key: 'gemini.vertexProjectId',
        type: 'string',
        group: 'Models',
        label: 'Vertex AI GCP Project ID (optional)',
        description: 'Optional GCP project ID for Vertex AI regional routing (leave blank for Vertex AI Express / API Key mode).',
        allowEmpty: true,
        default: '',
    },
    {
        key: 'gemini.vertexLocation',
        type: 'string',
        group: 'Models',
        label: 'Vertex AI GCP Location',
        description: 'Vertex AI region (e.g. global, us-central1, europe-west4). Defaults to global.',
        default: 'global',
    },
    {
        key: 'gemini.allowDedicatedVmEndpoints',
        type: 'boolean',
        group: 'Models',
        label: 'Allow dedicated Vertex VM endpoints (road-lock)',
        description: 'Off by default: blocks dedicated GPU VM endpoints (/endpoints/<id>) so only serverless pay-per-token Model Garden / Publisher APIs can stream.',
        default: false,
    },
    {
        key: 'gemini.baseUrl',
        type: 'string',
        group: 'Models',
        label: 'Gemini custom base URL (optional)',
        description: 'Custom base URL used when Gemini backend is set to Custom.',
        allowEmpty: true,
        default: '',
    },
    {
        key: 'costShield.mode',
        type: 'enum',
        group: 'Costs',
        label: 'Context Shield mode',
        description: 'Auto deduplicates and compacts superseded tool results before they reach the model.',
        options: COST_SHIELD_OPTIONS,
        default: 'auto',
    },
    {
        key: 'costShield.workerRoute',
        type: 'enum',
        group: 'Costs',
        label: 'Collaborator route',
        description: 'Provider and tier a Collaborator uses when brought onto a task.',
        options: COLLABORATOR_ROUTE_OPTIONS,
        default: 'agentsProfile',
    },
    {
        key: 'orchestrateMode.enabled',
        type: 'boolean',
        group: 'Orchestration',
        label: 'Orchestrate Mode (pre-approve read-only fan-out)',
        description: 'Pre-approves read-only orchestration calls (harmony_parallel, orchestrate_codebase, consult_model, spawn_worker). File writes and terminal commands still require confirmation.',
        default: false,
    },
    {
        key: 'orchestrateMode.fleetEnabled',
        type: 'boolean',
        group: 'Orchestration',
        label: 'Fleet Mode (Conductor + Collaborator offload)',
        description: 'Sub-option under Orchestrate Mode: instructs the Conductor seat to actively fan out parallel read-only Collaborators via the Context Shield Collaborator route. Auto-enables parent Orchestrate Mode when turned on.',
        default: false,
    },
    {
        key: 'tokenBudget',
        type: 'number',
        group: 'Budgets',
        label: 'Token budget',
        description: 'Prompt token budget that Context Shield compacts toward.',
        min: 1000,
        max: 2000000,
    },
    {
        key: 'toolResultMaxChars',
        type: 'number',
        group: 'Budgets',
        label: 'Tool result max chars',
        description: 'Hard cap on a single tool result before it is truncated.',
        min: 500,
        max: 500000,
    },
    {
        key: 'agentMaxSteps',
        type: 'number',
        group: 'Budgets',
        label: 'Max agent steps (-1 = unlimited)',
        description: 'How many tool steps one turn may take before stopping.',
        min: -1,
        max: 5000,
    },
    {
        key: 'sessions.preambleTargetChars',
        type: 'number',
        group: 'Sessions',
        label: 'Session preamble target (chars)',
        description: 'Soft budget for a resumed-session preamble. Under this size it is injected verbatim with no annotation.',
        min: 500,
        max: 200000,
        default: 8000,
    },
    {
        key: 'sessions.preambleCeilingChars',
        type: 'number',
        group: 'Sessions',
        label: 'Session preamble ceiling (chars)',
        description: 'Hard ceiling for a resumed-session preamble. Never exceeded.',
        min: 500,
        max: 500000,
        default: 24000,
    },
];

const SETTINGS_BY_KEY = new Map<string, StudioSettingSpec>(
    STUDIO_SETTINGS.map((spec) => [spec.key, spec])
);

/** True only for keys declared in this module. Every route must check this. */
export function isAllowedSettingKey(key: string): boolean {
    return SETTINGS_BY_KEY.has(String(key ?? '').trim());
}

export function settingDefaults(): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const spec of STUDIO_SETTINGS) {
        if (spec.default !== undefined) out[spec.key] = spec.default;
    }
    return out;
}

/**
 * Resolve the host configuration object without assuming which host we are in.
 * Returns null when no configuration service is reachable, so callers degrade to
 * the workspace mirror instead of throwing.
 */
function resolveHostConfiguration(): { get: (key: string) => unknown; update: (key: string, value: unknown) => Promise<void> } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode') as typeof import('vscode');
        const cfg: any = vscode?.workspace?.getConfiguration?.('harmony');
        if (!cfg) return null;
        return {
            get: (key: string) => {
                try { return cfg.get(key); } catch { return undefined; }
            },
            update: async (key: string, value: unknown) => {
                await cfg.update(key, value, true);
            },
        };
    } catch {
        return null;
    }
}

function settingsFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, STUDIO_SETTINGS_FILE);
}

function readJsonObject(file: string): Record<string, unknown> {
    try {
        if (!fs.existsSync(file)) return {};
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as Record<string, unknown>;
    } catch {
        return {};
    }
}

function writeJsonObject(file: string, data: Record<string, unknown>): boolean {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const serialized = JSON.stringify(data, null, 2);
        const tmpFile = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        fs.writeFileSync(tmpFile, serialized, 'utf8');
        try {
            fs.renameSync(tmpFile, file);
        } catch {
            fs.writeFileSync(file, serialized, 'utf8');
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
        return true;
    } catch {
        return false;
    }
}

function coerce(spec: StudioSettingSpec, raw: unknown): { ok: boolean; value?: string | number | boolean; error?: string } {
    switch (spec.type) {
        case 'enum': {
            const text = String(raw ?? '').trim();
            const allowed = (spec.options ?? []).map((option) => option.value);
            if (!allowed.includes(text)) {
                return { ok: false, error: `"${text}" is not a valid value for ${spec.key}. Allowed: ${allowed.join(', ')}` };
            }
            return { ok: true, value: text };
        }
        case 'number': {
            const num = Number(raw);
            if (!Number.isFinite(num)) return { ok: false, error: `${spec.key} must be a finite number.` };
            let bounded = Math.floor(num);
            if (spec.min !== undefined && bounded < spec.min) bounded = spec.min;
            if (spec.max !== undefined && bounded > spec.max) bounded = spec.max;
            return { ok: true, value: bounded };
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return { ok: true, value: raw };
            const text = String(raw ?? '').trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(text)) return { ok: true, value: true };
            if (['false', '0', 'no', 'off'].includes(text)) return { ok: true, value: false };
            return { ok: false, error: `${spec.key} must be a boolean.` };
        }
        case 'string':
        default: {
            const text = String(raw ?? '').trim();
            if (!text && !spec.allowEmpty) return { ok: false, error: `${spec.key} must not be empty.` };
            return { ok: true, value: text.slice(0, 200) };
        }
    }
}

/**
 * Read one setting, resolving through the order that keeps both hosts agreeing.
 * The real host prefers its own configuration; the headless host prefers the
 * workspace mirror it actually writes to. Legacy cost-shield values are read
 * last, and only for the two keys that file ever held.
 */
function resolveOne(
    spec: StudioSettingSpec,
    workspaceRoot: string,
    hostCfg: ReturnType<typeof resolveHostConfiguration>,
    workspaceSettings: Record<string, unknown>,
    realHost: boolean,
    legacyCostShield: Record<string, unknown>
): StudioSettingValue {
    const base = {
        key: spec.key,
        type: spec.type,
        group: spec.group,
        label: spec.label,
        description: spec.description,
        options: spec.options,
        min: spec.min,
        max: spec.max,
    };

    const fromWorkspace = (): { value: unknown; origin: StudioSettingOrigin } | null => {
        const full = workspaceSettings[`harmony.${spec.key}`];
        if (full !== undefined && full !== null) return { value: full, origin: 'workspace-settings' };
        const bare = workspaceSettings[spec.key];
        if (bare !== undefined && bare !== null) return { value: bare, origin: 'workspace-settings' };
        return null;
    };

    const fromHost = (): { value: unknown; origin: StudioSettingOrigin } | null => {
        if (!hostCfg) return null;
        const raw = hostCfg.get(spec.key);
        if (raw === undefined || raw === null || (raw === '' && !spec.allowEmpty)) return null;
        return { value: raw, origin: 'vscode-config' };
    };

    const ordered = realHost ? [fromHost, fromWorkspace] : [fromWorkspace, fromHost];
    for (const read of ordered) {
        const hit = read();
        if (!hit) continue;
        const coerced = coerce(spec, hit.value);
        if (coerced.ok) return { ...base, value: coerced.value!, origin: hit.origin };
    }

    if (spec.key === 'costShield.mode' || spec.key === 'costShield.workerRoute') {
        const legacyKey = spec.key === 'costShield.mode' ? 'mode' : 'workerRoute';
        const legacyValue = legacyCostShield[legacyKey];
        if (legacyValue !== undefined && legacyValue !== null) {
            const coerced = coerce(spec, legacyValue);
            if (coerced.ok) return { ...base, value: coerced.value!, origin: 'legacy-cost-shield' };
        }
    }

    if (spec.default !== undefined) {
        return { ...base, value: spec.default, origin: 'schema-default' };
    }

    return { ...base, value: null, origin: 'unresolved' };
}

/** Snapshot every allowlisted setting with its effective value and origin. */
export function readStudioSettings(workspaceRoot: string): StudioSettingValue[] {
    const root = workspaceRoot || process.cwd();
    const hostCfg = resolveHostConfiguration();
    const realHost = isRunningInRealVscodeHost();
    const workspaceSettings = readJsonObject(settingsFilePath(root));
    const legacyCostShield = readJsonObject(path.join(root, LEGACY_COST_SHIELD_FILE));
    const rows = STUDIO_SETTINGS.map((spec) => resolveOne(spec, root, hostCfg, workspaceSettings, realHost, legacyCostShield));
    // Enforce parent/child coupling invariant at the read boundary as well:
    // if parent `orchestrateMode.enabled` is false (e.g. hand-edited JSON), `fleetEnabled` cannot report true.
    const orchRow = rows.find((r) => r.key === 'orchestrateMode.enabled');
    const fleetRow = rows.find((r) => r.key === 'orchestrateMode.fleetEnabled');
    if (orchRow && fleetRow && !orchRow.value && fleetRow.value === true) {
        fleetRow.value = false;
    }
    return rows;
}

/** Convenience map form for callers that only need effective values. */
export function readStudioSettingValues(workspaceRoot: string): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const item of readStudioSettings(workspaceRoot)) out[item.key] = item.value;
    return out;
}

/**
 * Pure coupled state machine for Orchestrate Mode (parent) and Fleet Mode (sub-option):
 * - Turning ON `orchestrateMode.fleetEnabled` auto-enables `orchestrateMode.enabled`
 *   so parallel Collaborator fan-outs do not stall on manual confirmation popups.
 * - Turning OFF `orchestrateMode.fleetEnabled` leaves parent `orchestrateMode.enabled` as-is.
 * - Turning OFF parent `orchestrateMode.enabled` cleanly pauses `orchestrateMode.fleetEnabled`.
 */
export function computeCoupledOrchestrateState(
    current: { orchestrateEnabled: boolean; fleetEnabled: boolean },
    change: { key: 'orchestrateMode.enabled' | 'orchestrateMode.fleetEnabled'; value: boolean }
): { orchestrateEnabled: boolean; fleetEnabled: boolean } {
    if (change.key === 'orchestrateMode.fleetEnabled') {
        if (change.value) {
            return { orchestrateEnabled: true, fleetEnabled: true };
        }
        return { orchestrateEnabled: !!current.orchestrateEnabled, fleetEnabled: false };
    }
    if (!change.value) {
        return { orchestrateEnabled: false, fleetEnabled: false };
    }
    return { orchestrateEnabled: true, fleetEnabled: !!current.fleetEnabled };
}

const workspaceWriteQueues = new Map<string, Promise<unknown>>();

function enqueueWorkspaceWrite<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const resolved = path.resolve(root);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const prev = workspaceWriteQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    workspaceWriteQueues.set(key, next.catch(() => {}));
    return next;
}

/**
 * Write one allowlisted setting.
 *
 * Both the host configuration and the workspace mirror are attempted. The mirror
 * is not a fallback - it is required, because the headless host reads only from
 * there and would otherwise show a stale value. A write only reports success when
 * it landed somewhere durable, and the origin says where.
 */
export async function writeStudioSetting(
    workspaceRoot: string,
    key: string,
    raw: unknown
): Promise<StudioSettingWriteResult> {
    const trimmedKey = String(key ?? '').trim();
    const spec = SETTINGS_BY_KEY.get(trimmedKey);
    if (!spec) {
        return { ok: false, key: trimmedKey, error: `Setting "${trimmedKey}" is not exposed by Harmony Studio.` };
    }
    const coerced = coerce(spec, raw);
    if (!coerced.ok || coerced.value === undefined) {
        return { ok: false, key: trimmedKey, error: coerced.error ?? 'Invalid value.' };
    }

    const root = workspaceRoot || process.cwd();
    return enqueueWorkspaceWrite(root, async () => {
        const hostCfg = resolveHostConfiguration();
        const currentVals = (trimmedKey === 'orchestrateMode.enabled' || trimmedKey === 'orchestrateMode.fleetEnabled')
            ? readStudioSettingValues(root)
            : null;
        const coupled = currentVals
            ? computeCoupledOrchestrateState(
                {
                    orchestrateEnabled: Boolean(currentVals['orchestrateMode.enabled']),
                    fleetEnabled: Boolean(currentVals['orchestrateMode.fleetEnabled']),
                },
                {
                    key: trimmedKey as 'orchestrateMode.enabled' | 'orchestrateMode.fleetEnabled',
                    value: Boolean(coerced.value),
                }
            )
            : null;

        // Write durable workspace mirror FIRST so disk and memory never diverge if disk fails.
        const file = settingsFilePath(root);
        const mirror = readJsonObject(file);
        if (coupled) {
            mirror['harmony.orchestrateMode.enabled'] = coupled.orchestrateEnabled;
            mirror['harmony.orchestrateMode.fleetEnabled'] = coupled.fleetEnabled;
        } else {
            mirror[`harmony.${trimmedKey}`] = coerced.value;
        }
        const mirrorWritten = writeJsonObject(file, mirror);

        let hostWritten = false;
        let hostError: string | undefined;
        if (hostCfg) {
            try {
                if (coupled) {
                    await hostCfg.update('orchestrateMode.enabled', coupled.orchestrateEnabled);
                    await hostCfg.update('orchestrateMode.fleetEnabled', coupled.fleetEnabled);
                } else {
                    await hostCfg.update(trimmedKey, coerced.value);
                }
                hostWritten = true;
            } catch (err: any) {
                hostError = err?.message ?? String(err);
            }
        }

        if (!hostWritten && !mirrorWritten) {
            return {
                ok: false,
                key: trimmedKey,
                error: hostError
                    ? `Could not write ${trimmedKey}: ${hostError}`
                    : `Could not write ${trimmedKey}: no configuration service and the workspace mirror is not writable.`,
            };
        }

        return {
            ok: true,
            key: trimmedKey,
            value: coerced.value,
            origin: hostWritten ? 'vscode-config' : 'workspace-settings',
        };
    });
}

/** Group the settings for rendering, preserving declaration order. */
export function studioSettingsGroups(): Array<{ group: string; settings: StudioSettingSpec[] }> {
    const order: string[] = [];
    const buckets = new Map<string, StudioSettingSpec[]>();
    for (const spec of STUDIO_SETTINGS) {
        if (!buckets.has(spec.group)) {
            buckets.set(spec.group, []);
            order.push(spec.group);
        }
        buckets.get(spec.group)!.push(spec);
    }
    return order.map((group) => ({ group, settings: buckets.get(group)! }));
}
