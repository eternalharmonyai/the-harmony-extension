/**
 * Hub start-policy resolution (shared, single source of truth).
 *
 * `harmony.hub.startPolicy` (never | onDemand | onWorkspaceOpen) is the forward control.
 * `harmony.hub.autoStart` (boolean) is the LEGACY control and is still honored whenever
 * startPolicy has not been explicitly set, so existing users keep their choice.
 *
 * This lives in its own module so the sidebar UI, the chat participant, the LM tools and
 * the extension host all resolve the SAME effective value — a setting and its UI must
 * never disagree.
 */
import * as vscode from 'vscode';

export type HubStartPolicy = 'never' | 'onDemand' | 'onWorkspaceOpen';

export const HUB_START_POLICIES: HubStartPolicy[] = ['never', 'onDemand', 'onWorkspaceOpen'];

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('harmony');
}

/** True when `hub.startPolicy` has been set explicitly at any scope. */
export function isStartPolicyExplicit(cfg: vscode.WorkspaceConfiguration = config()): boolean {
    const insp = cfg.inspect<string>('hub.startPolicy');
    if (!insp) return false;
    return insp.globalValue !== undefined
        || insp.workspaceValue !== undefined
        || insp.workspaceFolderValue !== undefined;
}

/**
 * The effective start policy. An explicit `hub.startPolicy` wins; otherwise the legacy
 * `hub.autoStart` boolean is migrated (false => never, true => on demand).
 */
export function hubStartPolicy(cfg: vscode.WorkspaceConfiguration = config()): HubStartPolicy {
    const raw = cfg.get<string>('hub.startPolicy');
    if (isStartPolicyExplicit(cfg) && (raw === 'never' || raw === 'onDemand' || raw === 'onWorkspaceOpen')) {
        return raw;
    }
    return (cfg.get<boolean>('hub.autoStart') ?? true) ? 'onDemand' : 'never';
}

/** True when Harmony is permitted to start the Hub (any policy except "never"). */
export function hubMayStart(cfg: vscode.WorkspaceConfiguration = config()): boolean {
    return hubStartPolicy(cfg) !== 'never';
}

/** True when the Hub should start automatically at workspace open (opt-in only). */
export function hubStartsOnWorkspaceOpen(cfg: vscode.WorkspaceConfiguration = config()): boolean {
    return hubStartPolicy(cfg) === 'onWorkspaceOpen';
}
