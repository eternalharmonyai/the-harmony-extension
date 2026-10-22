#!/usr/bin/env node
/**
 * Ensures the Hub's summarize/apply route has no active callers in src/.
 *
 * Run:  node scripts/check-no-summarize-callers.js
 * Exit: 0 when zero references; 1 when a reference appears.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const NEEDLE = 'summarize/apply';
const hits = [];

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes(NEEDLE)) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(NEEDLE)) {
                hits.push(`${path.relative(ROOT, full)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
            }
        }
    }
}

walk(SRC);

if (hits.length > 0) {
    console.error(`check-no-summarize-callers: FAIL — ${hits.length} reference(s) to "${NEEDLE}" found; the route must stay caller-free:`);
    for (const h of hits) console.error('  ' + h);
    process.exit(1);
}
console.log(`check-no-summarize-callers: OK — zero references to "${NEEDLE}" in src/.`);
