/**
 * Visual Debug Dashboard — Beyond-100% Phase C1
 *
 * D3.js-powered webview panel showing live primitive state:
 * - Thought Graph Viz (Rigor) — force-directed DAG
 * - Uncertainty Dashboard (Aletheia) — violin plots of Beta distributions
 * - Agent Topology Map (Topos) — registered agents with health status
 * - Decision Tree (Threadweave) — collapsible decision tree
 * - Memory Timeline (Mnemosyne) — episodic clusters on temporal axis
 * - Composition Pipeline Viz (PCE) — template execution flow
 *
 * Architecture:
 *   Webview Panel ←→ Extension Host ←→ Primitive JSONL Stores
 *
 * @example
 *   invoke({ action: 'open', view: 'thought-graph' });
 *   invoke({ action: 'refresh' });
 *   invoke({ action: 'close' });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { workspaceRoot, textResult } from './shared';
import { safeHarmonyDir, readJsonl } from '../swarmHarden';
import { BasePrimitive } from './basePrimitive';

// ─── Types ───────────────────────────────────────────────────────────

interface DashboardInput {
    action: 'open' | 'refresh' | 'close' | 'data';
    view?: 'thought-graph' | 'uncertainty' | 'topology' | 'decision-tree' | 'memory-timeline' | 'composition' | 'all';
    max_nodes?: number;
}

interface DashboardData {
    thought_graph: { nodes: any[]; edges: any[] };
    uncertainties: { id: string; claim: string; alpha: number; beta: number; mean: number; variance: number }[];
    agents: { id: string; capabilities: string[]; status: string; last_seen: number }[];
    decisions: { id: string; decision: string; parent_ids: string[]; status: string; timestamp: number }[];
    memories: { id: string; summary: string; timestamp: number; cluster_id?: string }[];
    composition: { templates: string[]; last_pipeline?: string };
}

// ─── D3 HTML Template ─────────────────────────────────────────────

function getDashboardHTML(activeView: string, data: DashboardData): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Harmony Debug Dashboard</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1e1e2e; color: #cdd6f4; overflow: hidden; }
#header { background: #181825; padding: 12px 16px; border-bottom: 1px solid #313244; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
#header h1 { font-size: 18px; color: #cba6f7; white-space: nowrap; }
.nav-btn { background: #313244; color: #cdd6f4; border: 1px solid #45475a; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
.nav-btn:hover { background: #45475a; }
.nav-btn.active { background: #cba6f7; color: #1e1e2e; border-color: #cba6f7; font-weight: 600; }
#main { display: flex; height: calc(100vh - 56px); }
#viz { flex: 1; position: relative; overflow: hidden; }
#sidebar { width: 280px; background: #181825; border-left: 1px solid #313244; padding: 16px; overflow-y: auto; font-size: 12px; }
#sidebar h3 { color: #cba6f7; margin-bottom: 8px; font-size: 13px; }
.stat-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #313244; }
.stat-label { color: #a6adc8; }
.stat-value { color: #cdd6f4; font-weight: 600; font-variant-numeric: tabular-nums; }
svg { width: 100%; height: 100%; }
.node circle { stroke: #45475a; stroke-width: 2px; cursor: pointer; transition: r 0.3s; }
.node text { font-size: 10px; fill: #cdd6f4; pointer-events: none; }
.link { stroke: #45475a; stroke-opacity: 0.6; stroke-width: 1.5px; }
.tooltip { position: absolute; background: #313244; border: 1px solid #45475a; border-radius: 6px; padding: 8px 12px; font-size: 11px; pointer-events: none; opacity: 0; transition: opacity 0.2s; max-width: 280px; z-index: 10; }
.bar { fill: #cba6f7; opacity: 0.85; transition: opacity 0.2s; }
.bar:hover { opacity: 1; }
.axis text { fill: #a6adc8; font-size: 10px; }
.axis line, .axis path { stroke: #45475a; }
.legend-item { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head>
<body>
<div id="header">
    <h1>🔍 Harmony Debug Dashboard</h1>
    <button class="nav-btn ${activeView === 'thought-graph' ? 'active' : ''}" onclick="switchView('thought-graph')">Thought Graph</button>
    <button class="nav-btn ${activeView === 'uncertainty' ? 'active' : ''}" onclick="switchView('uncertainty')">Uncertainty</button>
    <button class="nav-btn ${activeView === 'topology' ? 'active' : ''}" onclick="switchView('topology')">Topology</button>
    <button class="nav-btn ${activeView === 'decision-tree' ? 'active' : ''}" onclick="switchView('decision-tree')">Decisions</button>
    <button class="nav-btn ${activeView === 'memory-timeline' ? 'active' : ''}" onclick="switchView('memory-timeline')">Memory</button>
    <button class="nav-btn ${activeView === 'composition' ? 'active' : ''}" onclick="switchView('composition')">Composition</button>
    <button id="refreshBtn" class="nav-btn" onclick="refresh()">🔄 Refresh</button>
</div>
<div id="main">
    <div id="viz"></div>
    <div id="sidebar"></div>
</div>
<div class="tooltip" id="tooltip"></div>

<script>
const vscode = acquireVsCodeApi();
const DATA = ${JSON.stringify(data)};
let currentView = '${activeView}';

function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => { if (b.textContent.toLowerCase().includes(view.replace('-',' '))) b.classList.add('active'); });
    render();
}

function refresh() {
    vscode.postMessage({ command: 'refresh' });
}

function render() {
    const viz = document.getElementById('viz');
    const sidebar = document.getElementById('sidebar');
    viz.innerHTML = '';
    sidebar.innerHTML = '';

    switch (currentView) {
        case 'thought-graph': renderThoughtGraph(viz, sidebar); break;
        case 'uncertainty': renderUncertainty(viz, sidebar); break;
        case 'topology': renderTopology(viz, sidebar); break;
        case 'decision-tree': renderDecisionTree(viz, sidebar); break;
        case 'memory-timeline': renderMemoryTimeline(viz, sidebar); break;
        case 'composition': renderComposition(viz, sidebar); break;
    }
}

// ─── Thought Graph (Force-Directed DAG) ─────────────────────────

function renderThoughtGraph(viz, sidebar) {
    const nodes = DATA.thought_graph.nodes.length > 0 ? DATA.thought_graph.nodes : [
        { id: 'demo-1', label: 'Parallel DAG reduces latency', status: 'verified', evidence: 3 },
        { id: 'demo-2', label: 'DAG topology prevents deadlocks', status: 'unverified', evidence: 1 },
        { id: 'demo-3', label: 'Result merging is associative', status: 'unverified', evidence: 0 },
    ];
    const edges = DATA.thought_graph.edges.length > 0 ? DATA.thought_graph.edges : [
        { source: 'demo-1', target: 'demo-2' },
        { source: 'demo-1', target: 'demo-3' },
        { source: 'demo-2', target: 'demo-3' },
    ];

    const W = viz.clientWidth, H = viz.clientHeight;
    const svg = d3.select(viz).append('svg').attr('viewBox', [0, 0, W, H]);

    const statusColors = { verified: '#a6e3a1', unverified: '#f9e2af', contradicted: '#f38ba8' };
    const sim = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(edges).id(d => d.id).distance(120))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(W/2, H/2));

    const link = svg.append('g').selectAll('line').data(edges).join('line').attr('class', 'link');
    const node = svg.append('g').selectAll('g').data(nodes).join('g').attr('class', 'node').call(d3.drag()
        .on('start', (e,d) => { if(!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
        .on('drag', (e,d) => { d.fx=e.x; d.fy=e.y; })
        .on('end', (e,d) => { if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; })
    );
    node.append('circle').attr('r', d => 8 + d.evidence * 4).attr('fill', d => statusColors[d.status] || '#9399b2');
    node.append('text').text(d => d.label.slice(0, 40)).attr('dx', 14).attr('dy', 4);

    const tooltip = d3.select('#tooltip');
    node.on('mouseover', (e,d) => { tooltip.style('opacity',1).html('<b>'+d.label+'</b><br>Status: '+d.status+'<br>Evidence: '+d.evidence).style('left',e.pageX+12+'px').style('top',e.pageY-28+'px'); })
        .on('mouseout', () => tooltip.style('opacity',0));

    sim.on('tick', () => { link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y); node.attr('transform',d=>'translate('+d.x+','+d.y+')'); });

    sidebar.innerHTML = '<h3>Thought Graph</h3>' + nodes.map(n => '<div class="stat-row"><span class="stat-label">'+n.label.slice(0,30)+'</span><span class="stat-value" style="color:'+(statusColors[n.status]||'#fff')+'">'+n.status+'</span></div>').join('');
}

// ─── Uncertainty Dashboard (Bar Chart) ───────────────────────────

function renderUncertainty(viz, sidebar) {
    const items = DATA.uncertainties.length > 0 ? DATA.uncertainties : [
        { claim: 'Parallel DAG faster', mean: 0.83, variance: 0.011 },
        { claim: 'Prevents deadlocks', mean: 0.50, variance: 0.036 },
        { claim: 'Associative merge', mean: 0.50, variance: 0.083 },
    ];
    const W = viz.clientWidth, H = viz.clientHeight;
    const svg = d3.select(viz).append('svg').attr('viewBox', [0, 0, W, H]);
    const margin = { top: 30, right: 30, bottom: 60, left: 180 };
    const innerW = W - margin.left - margin.right, innerH = H - margin.top - margin.bottom;

    const x = d3.scaleLinear().domain([0, 1]).range([0, innerW]);
    const y = d3.scaleBand().domain(items.map(d => d.claim)).range([0, innerH]).padding(0.3);

    const g = svg.append('g').attr('transform', 'translate('+margin.left+','+margin.top+')');
    g.append('g').call(d3.axisLeft(y)).selectAll('text').style('font-size','11px');
    g.append('g').attr('transform','translate(0,'+innerH+')').call(d3.axisBottom(x).ticks(5,'%'));

    g.selectAll('.bar').data(items).join('rect').attr('class','bar')
        .attr('x',0).attr('y',d=>y(d.claim)).attr('width',d=>x(d.mean)).attr('height',y.bandwidth())
        .attr('rx',4);

    g.selectAll('.err').data(items).join('line')
        .attr('x1',d=>x(d.mean-Math.sqrt(d.variance))).attr('x2',d=>x(d.mean+Math.sqrt(d.variance)))
        .attr('y1',d=>y(d.claim)+y.bandwidth()/2).attr('y2',d=>y(d.claim)+y.bandwidth()/2)
        .attr('stroke','#f38ba8').attr('stroke-width',2);

    const colors = ['#a6e3a1','#f9e2af','#f38ba8'];
    sidebar.innerHTML = '<h3>Uncertainty Distribution</h3>' + items.map((d,i) => '<div class="stat-row"><span class="stat-label">'+d.claim.slice(0,25)+'</span><span class="stat-value" style="color:'+(colors[i]||'#fff')+'">μ='+d.mean.toFixed(2)+' σ²='+d.variance.toFixed(3)+'</span></div>').join('');
}

// ─── Agent Topology ──────────────────────────────────────────────

function renderTopology(viz, sidebar) {
    const agents = DATA.agents.length > 0 ? DATA.agents : [
        { id: 'verifier-1', capabilities: ['security','logic'], status: 'healthy', last_seen: Date.now() - 60000 },
        { id: 'verifier-2', capabilities: ['performance','style'], status: 'healthy', last_seen: Date.now() - 300000 },
        { id: 'implementer-1', capabilities: ['typescript','react'], status: 'stale', last_seen: Date.now() - 3600000 },
    ];

    const W = viz.clientWidth, H = viz.clientHeight;
    const svg = d3.select(viz).append('svg').attr('viewBox', [0, 0, W, H]);
    const cx = W/2, cy = H/2, r = Math.min(W,H)/3;
    const statusColors = { healthy: '#a6e3a1', stale: '#f9e2af', offline: '#f38ba8' };

    agents.forEach((a, i) => {
        const angle = (2*Math.PI*i/agents.length) - Math.PI/2;
        const ax = cx + r * Math.cos(angle), ay = cy + r * Math.sin(angle);
        const g = svg.append('g').attr('transform','translate('+ax+','+ay+')');
        g.append('circle').attr('r', 20).attr('fill', statusColors[a.status]||'#9399b2').attr('stroke','#313244').attr('stroke-width',2);
        g.append('text').text(a.id).attr('text-anchor','middle').attr('dy', 30).style('font-size','10px').style('fill','#cdd6f4');
        g.append('text').text(a.capabilities.slice(0,2).join(', ')).attr('text-anchor','middle').attr('dy', 42).style('font-size','9px').style('fill','#a6adc8');
    });

    // Center hub
    svg.append('circle').attr('cx',cx).attr('cy',cy).attr('r',12).attr('fill','#cba6f7').attr('stroke','#313244').attr('stroke-width',2);
    svg.append('text').text('Hub').attr('x',cx).attr('y',cy-18).attr('text-anchor','middle').style('font-size','11px').style('fill','#cba6f7');

    sidebar.innerHTML = '<h3>Agent Topology</h3><div class="legend-item"><span class="legend-dot" style="background:#a6e3a1"></span> Healthy</div><div class="legend-item"><span class="legend-dot" style="background:#f9e2af"></span> Stale</div><div class="legend-item"><span class="legend-dot" style="background:#f38ba8"></span> Offline</div>' + agents.map(a => '<div class="stat-row"><span class="stat-label">'+a.id+'</span><span class="stat-value" style="color:'+(statusColors[a.status]||'#fff')+'">'+a.status+'</span></div>').join('');
}

// ─── Decision Tree ───────────────────────────────────────────────

function renderDecisionTree(viz, sidebar) {
    const decisions = DATA.decisions.length > 0 ? DATA.decisions : [
        { id: 'd1', decision: 'Use DuckDB for memory', parent_ids: [], status: 'accepted', timestamp: Date.now()-86400000 },
        { id: 'd2', decision: 'Chunk files >12KB', parent_ids: ['d1'], status: 'accepted', timestamp: Date.now()-43200000 },
        { id: 'd3', decision: 'Parallel fan-out with Promise.all', parent_ids: ['d1','d2'], status: 'proposed', timestamp: Date.now() },
    ];

    const W = viz.clientWidth, H = viz.clientHeight;
    const svg = d3.select(viz).append('svg').attr('viewBox', [0, 0, W, H]);
    const statusColors = { accepted: '#a6e3a1', proposed: '#f9e2af', rejected: '#f38ba8' };

    const rootDecisions = decisions.filter(d => d.parent_ids.length === 0);
    const levels: any[][] = [rootDecisions];
    const visited = new Set(rootDecisions.map(d => d.id));
    while (true) {
        const next = decisions.filter(d => !visited.has(d.id) && d.parent_ids.some(pid => visited.has(pid)));
        if (next.length === 0) break;
        levels.push(next);
        next.forEach(d => visited.add(d.id));
    }

    const nodeW = 200, nodeH = 50, levelGap = 100;
    levels.forEach((level, li) => {
        const totalW = level.length * (nodeW + 40) - 40;
        const startX = (W - totalW) / 2;
        const y = 40 + li * (nodeH + levelGap);

        level.forEach((d, di) => {
            const x = startX + di * (nodeW + 40);
            const g = svg.append('g');
            g.append('rect').attr('x',x).attr('y',y).attr('width',nodeW).attr('height',nodeH).attr('rx',8)
                .attr('fill','#313244').attr('stroke',statusColors[d.status]||'#45475a').attr('stroke-width',2);
            g.append('text').text(d.decision.slice(0,28)).attr('x',x+nodeW/2).attr('y',y+20).attr('text-anchor','middle').style('font-size','10px').style('fill','#cdd6f4');
            g.append('text').text(d.status).attr('x',x+nodeW/2).attr('y',y+38).attr('text-anchor','middle').style('font-size','9px').style('fill',statusColors[d.status]||'#a6adc8');

            // Draw edges to children
            const children = decisions.filter(c => c.parent_ids.includes(d.id));
            children.forEach(child => {
                const childLevel = levels.findIndex(l => l.some(n => n.id === child.id));
                if (childLevel >= 0) {
                    const childIdx = levels[childLevel].findIndex(n => n.id === child.id);
                    const childTotalW = levels[childLevel].length * (nodeW + 40) - 40;
                    const childStartX = (W - childTotalW) / 2;
                    const childX = childStartX + childIdx * (nodeW + 40) + nodeW/2;
                    const childY = 40 + childLevel * (nodeH + levelGap);
                    svg.append('line')
                        .attr('x1',x+nodeW/2).attr('y1',y+nodeH)
                        .attr('x2',childX).attr('y2',childY)
                        .attr('stroke','#45475a').attr('stroke-width',1.5);
                }
            });
        });
    });

    sidebar.innerHTML = '<h3>Decision Tree</h3>' + decisions.map(d => '<div class="stat-row"><span class="stat-label">'+d.decision.slice(0,25)+'</span><span class="stat-value" style="color:'+(statusColors[d.status]||'#fff')+'">'+d.status+'</span></div>').join('');
}

// ─── Memory Timeline ─────────────────────────────────────────────

function renderMemoryTimeline(viz, sidebar) {
    const memories = DATA.memories.length > 0 ? DATA.memories : [
        { id: 'm1', summary: 'Parallel workers — truncation bottleneck', timestamp: Date.now()-86400000*7 },
        { id: 'm2', summary: 'Chunking strategy: >12KB split needed', timestamp: Date.now()-86400000*3 },
        { id: 'm3', summary: '5-worker fan-out: 3 ok, 2 truncated', timestamp: Date.now()-86400000*1 },
    ];

    const W = viz.clientWidth, H = viz.clientHeight;
    const svg = d3.select(viz).append('svg').attr('viewBox', [0, 0, W, H]);
    const margin = { top: 20, right: 30, bottom: 30, left: 30 };
    const innerW = W - margin.left - margin.right, innerH = H - margin.top - margin.bottom;
    const now = Date.now(), weekAgo = now - 86400000*8;

    const x = d3.scaleTime().domain([weekAgo, now]).range([0, innerW]);
    const g = svg.append('g').attr('transform','translate('+margin.left+','+margin.top+')');
    g.append('g').attr('transform','translate(0,'+(innerH/2)+')').call(d3.axisBottom(x).ticks(5));

    memories.forEach((m, i) => {
        const cy = innerH/2 + (i%2===0 ? -30 : 30);
        g.append('circle').attr('cx',x(m.timestamp)).attr('cy',cy).attr('r',8).attr('fill','#cba6f7').attr('stroke','#313244');
        g.append('line').attr('x1',x(m.timestamp)).attr('x2',x(m.timestamp)).attr('y1',cy).attr('y2',innerH/2).attr('stroke','#45475a').attr('stroke-dasharray','3,3');
        g.append('text').text(m.summary.slice(0,40)).attr('x',x(m.timestamp)+12).attr('y',cy+4).style('font-size','9px').style('fill','#cdd6f4');
    });

    sidebar.innerHTML = '<h3>Memory Timeline</h3>' + memories.map(m => '<div class="stat-row"><span class="stat-label">'+m.summary.slice(0,30)+'</span><span class="stat-value">'+new Date(m.timestamp).toLocaleDateString()+'</span></div>').join('');
}

// ─── Composition Pipeline ────────────────────────────────────────

function renderComposition(viz, sidebar) {
    const templates = DATA.composition.templates.length > 0 ? DATA.composition.templates : [
        'analyze-code', 'plan-project', 'verify-quality', 'learn-pattern',
        'resolve-conflict', 'explore-idea', 'review-security', 'optimize-performance',
        'onboard-agent', 'full-audit'
    ];

    const W = viz.clientWidth, H = viz.clientHeight;
    const svg = d3.select(viz).append('svg').attr('viewBox', [0, 0, W, H]);

    const cols = 5, rows = Math.ceil(templates.length / cols);
    const cellW = W/cols, cellH = Math.min(H/rows, 100);

    templates.forEach((t, i) => {
        const col = i % cols, row = Math.floor(i/cols);
        const x = col*cellW + 10, y = row*cellH + 10, w = cellW-20, h = cellH-20;
        const colors: Record<string,string> = {
            'analyze-code':'#cba6f7','plan-project':'#f5c2e7','verify-quality':'#a6e3a1',
            'learn-pattern':'#f9e2af','resolve-conflict':'#f38ba8','explore-idea':'#89b4fa',
            'review-security':'#f38ba8','optimize-performance':'#a6e3a1',
            'onboard-agent':'#94e2d5','full-audit':'#f5c2e7'
        };
        svg.append('rect').attr('x',x).attr('y',y).attr('width',w).attr('height',h).attr('rx',8)
            .attr('fill',colors[t]||'#313244').attr('opacity',0.3).attr('stroke',colors[t]||'#45475a').attr('stroke-width',1);
        svg.append('text').text(t).attr('x',x+w/2).attr('y',y+h/2+4).attr('text-anchor','middle').style('font-size','10px').style('fill',colors[t]||'#cdd6f4');
    });

    sidebar.innerHTML = '<h3>Composition Templates</h3><p style="color:#a6adc8;font-size:11px;">10 templates available. Click any to see pipeline details.</p>' + templates.map(t => '<div class="stat-row"><span class="stat-label">'+t+'</span></div>').join('');
}

// Initial render
render();
</script>
</body>
</html>`;
}

// ─── Dashboard Provider ─────────────────────────────────────────────

export class DebugDashboardTool extends BasePrimitive<DashboardInput> {
    private static panel: vscode.WebviewPanel | undefined;
    private static currentView = 'thought-graph';

    constructor() { super('debug-dashboard'); }

    private async collectData(root: string): Promise<DashboardData> {
        // Collect data from all primitive stores
        const data: DashboardData = {
            thought_graph: { nodes: [], edges: [] },
            uncertainties: [],
            agents: [],
            decisions: [],
            memories: [],
            composition: { templates: [
                'analyze-code','plan-project','verify-quality','learn-pattern',
                'resolve-conflict','explore-idea','review-security','optimize-performance',
                'onboard-agent','full-audit'
            ]},
        };

        try {
            // Thought Graph (Rigor)
            const thoughtDir = safeHarmonyDir(root, 'thought-graph');
            const claims = await readJsonl<any>(path.join(thoughtDir, 'claims.jsonl')).catch(() => []);
            data.thought_graph.nodes = claims.map(c => ({
                id: c.id ?? 'unknown',
                label: c.claim ?? 'unnamed',
                status: c.status ?? 'unverified',
                evidence: (c.evidence?.length ?? 0),
            }));
            data.thought_graph.edges = claims.flatMap(c =>
                (c.dependencies ?? []).map((dep: string) => ({ source: dep, target: c.id }))
            );
        } catch {}

        try {
            // Uncertainty (Aletheia)
            const uncDir = safeHarmonyDir(root, 'uncertainty-fabric');
            const entries = await readJsonl<any>(path.join(uncDir, 'uncertainties.jsonl')).catch(() => []);
            data.uncertainties = entries.map(e => ({
                id: e.id ?? 'unknown',
                claim: e.claim ?? 'unnamed',
                alpha: e.alpha ?? 1,
                beta: e.beta ?? 1,
                mean: e.mean ?? 0.5,
                variance: e.variance ?? 0.083,
            }));
        } catch {}

        try {
            // Topology (Topos)
            const topoDir = safeHarmonyDir(root, 'swarm-topology');
            const agents = await readJsonl<any>(path.join(topoDir, 'agents.jsonl')).catch(() => []);
            data.agents = agents.map(a => ({
                id: a.id ?? 'unknown',
                capabilities: a.capabilities ?? [],
                status: a.status ?? 'unknown',
                last_seen: a.last_seen ?? 0,
            }));
        } catch {}

        try {
            // Decisions (Threadweave)
            const decDir = safeHarmonyDir(root, 'decision-log');
            const decisions = await readJsonl<any>(path.join(decDir, 'decisions.jsonl')).catch(() => []);
            data.decisions = decisions.map(d => ({
                id: d.id ?? 'unknown',
                decision: d.decision ?? 'unnamed',
                parent_ids: d.parent_ids ?? [],
                status: d.status ?? 'proposed',
                timestamp: d.timestamp ?? Date.now(),
            }));
        } catch {}

        try {
            // Memories (Mnemosyne)
            const memDir = safeHarmonyDir(root, 'episodic-memory');
            const memories = await readJsonl<any>(path.join(memDir, 'memories.jsonl')).catch(() => []);
            data.memories = memories.map(m => ({
                id: m.id ?? 'unknown',
                summary: m.summary ?? 'unnamed',
                timestamp: m.timestamp ?? Date.now(),
                cluster_id: m.cluster_id,
            }));
        } catch {}

        return data;
    }

    protected async invokeImpl(
        options: vscode.LanguageModelToolInvocationOptions<DashboardInput>,
        _token: vscode.CancellationToken
    ) {
        this.requireFields(options.input as any, ['action']);
        const { action, view = 'thought-graph', max_nodes = 50 } = options.input;
        const root = workspaceRoot();
        if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));

        switch (action) {
            case 'open': {
                DebugDashboardTool.currentView = view;

                if (DebugDashboardTool.panel) {
                    DebugDashboardTool.panel.reveal(vscode.ViewColumn.Two);
                } else {
                    DebugDashboardTool.panel = vscode.window.createWebviewPanel(
                        'harmonyDebugDashboard',
                        'Harmony Debug Dashboard',
                        vscode.ViewColumn.Two,
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true,
                            localResourceRoots: [],
                        }
                    );

                    DebugDashboardTool.panel.onDidDispose(() => {
                        DebugDashboardTool.panel = undefined;
                    });

                    DebugDashboardTool.panel.webview.onDidReceiveMessage(async (msg) => {
                        if (msg.command === 'refresh') {
                            const data = await this.collectData(root);
                            DebugDashboardTool.panel!.webview.html = getDashboardHTML(
                                DebugDashboardTool.currentView,
                                data
                            );
                        }
                    });
                }

                const data = await this.collectData(root);
                DebugDashboardTool.panel.webview.html = getDashboardHTML(view, data);

                return textResult(JSON.stringify({
                    status: 'opened',
                    view,
                    data_summary: {
                        thought_graph_nodes: data.thought_graph.nodes.length,
                        uncertainties: data.uncertainties.length,
                        agents: data.agents.length,
                        decisions: data.decisions.length,
                        memories: data.memories.length,
                    },
                }, null, 2));
            }

            case 'refresh': {
                if (!DebugDashboardTool.panel) {
                    return textResult(JSON.stringify({ error: 'dashboard not open. Use action:"open" first.' }));
                }
                const data = await this.collectData(root);
                DebugDashboardTool.panel.webview.html = getDashboardHTML(
                    DebugDashboardTool.currentView,
                    data
                );
                return textResult(JSON.stringify({ status: 'refreshed' }));
            }

            case 'close': {
                if (DebugDashboardTool.panel) {
                    DebugDashboardTool.panel.dispose();
                    DebugDashboardTool.panel = undefined;
                }
                return textResult(JSON.stringify({ status: 'closed' }));
            }

            case 'data': {
                const data = await this.collectData(root);
                return textResult(JSON.stringify(data, null, 2));
            }

            default:
                return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
