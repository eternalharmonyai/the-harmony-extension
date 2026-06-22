import * as vscode from 'vscode';

interface McpServerConfig {
    enabled?: boolean;
    transport?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    trust?: 'ask' | 'allow' | 'deny';
    permissions?: string[];
    timeoutSec?: number;
}

interface NormalizedMcpServer extends McpServerConfig {
    name: string;
}

function cfg() {
    return vscode.workspace.getConfiguration('harmony');
}

function configuredServers(): NormalizedMcpServer[] {
    const raw = cfg().get<Record<string, McpServerConfig>>('mcp.servers') ?? {};
    return Object.entries(raw).map(([name, value]) => ({ name, ...(value ?? {}) }));
}

export function mcpEnabled(): boolean {
    return cfg().get<boolean>('mcp.enabled') ?? false;
}

export function mcpStatusSummary(): string {
    const servers = configuredServers();
    const enabledServers = servers.filter(server => server.enabled !== false);
    if (!mcpEnabled()) return `disabled (${servers.length} configured)`;
    return `${enabledServers.length}/${servers.length} enabled`;
}

export function formatMcpStatus(): string {
    const servers = configuredServers();
    const lines: string[] = [];
    lines.push('**Harmony MCP Status**');
    lines.push('');
    lines.push(`Manager: **${mcpEnabled() ? 'enabled' : 'disabled'}**`);
    lines.push(`Configured servers: **${servers.length}**`);
    lines.push('');
    lines.push('This v1 is a permission/status layer. It does not spawn MCP servers yet; it makes configuration visible before runtime integration is added.');
    lines.push('');

    if (servers.length === 0) {
        lines.push('No MCP servers are configured under `harmony.mcp.servers`.');
        return lines.join('\n');
    }

    lines.push('| Server | State | Transport | Trust | Permissions | Target |');
    lines.push('|---|---|---|---|---|---|');
    for (const server of servers) {
        const state = server.enabled === false ? 'disabled' : 'enabled';
        const transport = server.transport ?? (server.url ? 'http' : 'stdio');
        const trust = server.trust ?? 'ask';
        const permissions = server.permissions?.length ? server.permissions.join(', ') : 'none';
        const target = transport === 'http' ? (server.url ?? '(missing url)') : [server.command ?? '(missing command)', ...(server.args ?? [])].join(' ');
        lines.push(`| ${server.name} | ${state} | ${transport} | ${trust} | ${permissions} | ${target.replace(/\|/g, '\\|')} |`);
    }
    return lines.join('\n');
}