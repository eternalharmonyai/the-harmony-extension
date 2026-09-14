#!/usr/bin/env node
/**
 * Harmony Citation MCP server — stdio transport, zero dependencies.
 *
 * Usage:
 *   node bin/harmony-citation-mcp.js [citations-root]      (default: ./citations)
 *
 * Register with any MCP client, e.g. Claude Code:
 *   claude mcp add harmony-citation -- node /abs/path/bin/harmony-citation-mcp.js /abs/path/citations
 */
require('../out/citationMcpServer.js').main(process.argv.slice(2))
    .catch(err => { console.error('[harmony-citation-mcp]', err?.message ?? err); process.exit(1); });
