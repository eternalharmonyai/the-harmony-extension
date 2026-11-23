#!/usr/bin/env node
/**
 * Harmony Standalone Desktop & CLI Launcher
 *
 * Runs Harmony outside VS Code using the compiled headless host shim (`out/host/vscodeHostShim.js`)
 * and standalone server (`out/host/standaloneServer.js`).
 *
 * Modes:
 *   1. Desktop UI + Local HTTP/MCP Server (default):
 *      node scripts/harmony-desktop.js [--port 8789] [--workspace <dir>] [--no-open]
 *
 *   2. Direct Headless Tool Invocation (any of the 196+ tools):
 *      node scripts/harmony-desktop.js --tool harmony_dns_ssl_probe --input '{"target":"example.com"}'
 *
 *   3. List All Headless Tools:
 *      node scripts/harmony-desktop.js --list-tools [--json]
 *
 *   4. One-Shot Standalone Agent Turn:
 *      node scripts/harmony-desktop.js --ask "Check git status and summarize" [--provider deepseek]
 *
 *   5. Stdio JSON-RPC 2.0 MCP Server (for Claude Desktop / Cursor / external hosts):
 *      node scripts/harmony-desktop.js --mcp-stdio [--workspace <dir>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BOOLEAN_DESKTOP_FLAGS = new Set([
    'help',
    'h',
    'no-open',
    'tauri',
    'list-tools',
    'mcp-stdio',
    'json',
]);

const VALUE_DESKTOP_FLAGS = new Set([
    'workspace',
    'port',
    'tool',
    'input',
    'ask',
    'provider',
    'tier',
]);

function parseArgs(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') {
            opts._.push(...argv.slice(i + 1));
            break;
        }
        if (a === '-h' || a === '-?') {
            opts.h = true;
            opts.help = true;
            continue;
        }
        if (!a.startsWith('--')) {
            opts._.push(a);
            continue;
        }
        const key = a.slice(2);
        const eq = key.indexOf('=');
        if (eq >= 0) {
            const flag = key.slice(0, eq);
            const val = key.slice(eq + 1);
            opts[flag] = BOOLEAN_DESKTOP_FLAGS.has(flag) ? val !== 'false' && val !== '0' : val;
            continue;
        }
        if (BOOLEAN_DESKTOP_FLAGS.has(key)) {
            opts[key] = true;
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && (VALUE_DESKTOP_FLAGS.has(key) || !next.startsWith('-'))) {
            opts[key] = next;
            i++;
        } else {
            opts[key] = true;
        }
    }
    return opts;
}

function readManifestToolCount() {
    try {
        const pkgPath = path.resolve(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const tools = (pkg.contributes && pkg.contributes.languageModelTools) || [];
        return Array.isArray(tools) ? tools.length : 196;
    } catch {
        return 196;
    }
}

function parseJsonObjectArg(raw, flagName) {
    if (typeof raw !== 'string' || !raw.trim()) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Invalid JSON for ${flagName}: ${err && err.message ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${flagName} must be a JSON object (e.g. '{"key":"value"}').`);
    }
    return parsed;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const workspaceRoot = path.resolve(String(opts.workspace || process.env.HARMONY_WORKSPACE || process.cwd()));

    if (opts.help || opts.h || opts._[0] === 'help') {
        const manifestCount = readManifestToolCount();
        console.log([
            `Harmony Standalone Desktop & CLI Runner (${manifestCount} Headless Tools)`,
            '',
            'Usage:',
            '  node scripts/harmony-desktop.js [options]',
            '',
            'Options:',
            '  --workspace <dir>       Workspace root (default: cwd)',
            '  --port <port>           Desktop HTTP/MCP server port (default: 8789)',
            '  --no-open               Do not auto-launch the native Edge/Chrome app window',
            '  --tauri                 Prefer Tauri control window when launching UI',
            '  --list-tools            List all registered headless tools',
            '  --tool <name>           Invoke one headless tool directly and exit',
            '  --input <json>          JSON input object for --tool (default: {})',
            '  --ask <prompt>          Run a standalone agent turn with full tool access',
            '  --provider <id>         Provider for --ask (default: deepseek)',
            '  --tier <tier>           Tier for --ask (coding|mid|light|heavy)',
            '  --mcp-stdio             Run as a stdio JSON-RPC 2.0 MCP server exposing all 196+ tools',
            '  --json                  Output machine-readable JSON',
            '  -h, --help              Show this help message and exit',
        ].join('\n'));
        return;
    }

    if (opts['mcp-stdio']) {
        // Keep stdout strictly reserved for JSON-RPC 2.0 frames.
        const writeStderr = (...args) => {
            process.stderr.write(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
        };
        console.log = writeStderr;
        console.info = writeStderr;
        console.warn = writeStderr;
    }

    const shimPath = path.resolve(__dirname, '..', 'out', 'host', 'vscodeHostShim.js');
    const standalonePath = path.resolve(__dirname, '..', 'out', 'host', 'standaloneServer.js');
    if (!fs.existsSync(shimPath) || !fs.existsSync(standalonePath)) {
        throw new Error('Compiled host files not found in out/host/. Run "npm run compile" first.');
    }

    const shim = require(shimPath);
    const standalone = require(standalonePath);

    shim.installVscodeHostShim(workspaceRoot);
    shim.ensureHeadlessHarmonyToolsRegistered(workspaceRoot);

    if (opts['list-tools']) {
        const catalog = standalone.loadStandaloneToolCatalog(workspaceRoot);
        if (opts.json) {
            console.log(JSON.stringify({ count: catalog.length, tools: catalog }, null, 2));
        } else {
            console.log(`Harmony Headless Tools (${catalog.length}):`);
            for (const t of catalog) {
                console.log(`  - ${t.name} [${t.category}]: ${t.displayName}`);
            }
        }
        return;
    }

    if (opts.tool) {
        const toolName = String(opts.tool).trim();
        if (!toolName) {
            throw new Error('--tool requires a tool name.');
        }
        const inputObj = parseJsonObjectArg(opts.input, '--input');
        const res = await shim.invokeHeadlessHarmonyTool(toolName, inputObj, workspaceRoot);
        if (opts.json) {
            console.log(JSON.stringify(res, null, 2));
        } else {
            console.log(res.result);
        }
        process.exitCode = res.ok ? 0 : 1;
        return;
    }

    if (opts.ask) {
        const turn = await standalone.runStandaloneAgentChatTurn({
            workspaceRoot,
            message: String(opts.ask),
            provider: typeof opts.provider === 'string' ? opts.provider : undefined,
            tier: typeof opts.tier === 'string' ? opts.tier : undefined,
        });
        if (opts.json) {
            console.log(JSON.stringify(turn, null, 2));
        } else {
            if (turn.toolTrace.length > 0) {
                console.log(`[Tools Invoked: ${turn.toolTrace.map(t => t.tool).join(', ')}]\n`);
            }
            console.log(turn.reply);
        }
        process.exitCode = turn.ok ? 0 : 1;
        return;
    }

    if (opts['mcp-stdio']) {
        const writeStdoutLine = (payload) => {
            try {
                process.stdout.write(JSON.stringify(payload) + '\n');
            } catch {
                // Ignore EPIPE if the stdio host closed the pipe early.
            }
        };
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        let chain = Promise.resolve();
        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            chain = chain.then(async () => {
                let req;
                try {
                    req = JSON.parse(trimmed);
                } catch (err) {
                    writeStdoutLine({
                        jsonrpc: '2.0',
                        id: null,
                        error: { code: -32700, message: err && err.message ? err.message : String(err) },
                    });
                    return;
                }
                try {
                    const resp = await standalone.handleStandaloneMcpJsonRpc(workspaceRoot, req);
                    if (resp !== null) {
                        writeStdoutLine(resp);
                    }
                } catch (err) {
                    const reqId = (req && typeof req === 'object' && !Array.isArray(req) && 'id' in req) ? req.id : null;
                    writeStdoutLine({
                        jsonrpc: '2.0',
                        id: reqId,
                        error: { code: -32603, message: err && err.message ? err.message : String(err) },
                    });
                }
            }).catch(() => {});
        });
        await new Promise((resolve) => {
            rl.once('close', () => {
                chain.then(resolve, resolve);
            });
        });
        return;
    }

    const rawPort = opts.port !== undefined ? String(opts.port).trim() : '8789';
    const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid --port value: ${opts.port}. Expected an integer between 0 and 65535.`);
    }
    const openAppWindow = !opts['no-open'];
    const handle = await standalone.startStandaloneDesktopServer({
        workspaceRoot,
        port,
        openAppWindow,
        preferTauriControlWindow: Boolean(opts.tauri),
    });

    if (opts.json) {
        console.log(JSON.stringify({
            ok: true,
            url: handle.url,
            mcpUrl: `${handle.url}/api/mcp`,
            port: handle.port,
            workspaceRoot: handle.workspaceRoot,
            toolCount: handle.toolCount,
            reused: Boolean(handle.reused),
        }, null, 2));
    } else if (handle.reused) {
        console.log([
            `Harmony Standalone Desktop is already running (reused existing server)!`,
            `  URL:        ${handle.url}`,
            `  MCP RPC:    ${handle.url}/api/mcp`,
            `  Workspace:  ${handle.workspaceRoot}`,
            `  Tools:      ${handle.toolCount} registered headless tools`,
        ].join('\n'));
    } else {
        console.log([
            `Harmony Standalone Desktop is live!`,
            `  URL:        ${handle.url}`,
            `  MCP RPC:    ${handle.url}/api/mcp`,
            `  Workspace:  ${handle.workspaceRoot}`,
            `  Tools:      ${handle.toolCount} registered headless tools`,
            `  Auth Token: saved to .harmony/standalone.token`,
            '',
            'Press Ctrl+C to stop.',
        ].join('\n'));
    }

    if (handle.reused) {
        return;
    }

    await new Promise((resolve) => {
        const shutdown = () => {
            handle.close().finally(resolve);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    });
}

main().catch((err) => {
    console.error('Harmony Standalone error:', err && err.stack ? err.stack : String(err));
    process.exit(1);
});
