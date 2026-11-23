'use strict';
/**
 * Behavioural checks for the decision-grade separation-of-duties detector.
 *
 * IMPORTANT: this tests the REAL compiled module (out/securityPlane.js), not a hand-copied
 * mirror of the logic. An earlier version of this project verified a copy, which meant the
 * test could pass while the shipped code drifted. securityPlane.ts deliberately has no
 * `vscode` import so it stays plain-Node testable.
 *
 * Run: npm run compile && node scripts/check-security-plane-detector.js
 */

const { analyzeSecurityPlaneMerge } = require('../out/securityPlane.js');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
    const ok = actual === expected;
    if (ok) pass++;
    else failures.push({ name, actual, expected });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  level=${String(actual).padEnd(9)} want=${String(expected).padEnd(9)} ${name}`);
}

const level = (text, extra = []) => analyzeSecurityPlaneMerge(text, extra).level;
const score = (text, extra = []) => analyzeSecurityPlaneMerge(text, extra).score;

console.log('=== 1. BENIGN — must stay silent (level: none) ===');
check('plain "replace" with no security object', level('we propose to replace our legacy billing system with a modern one'), 'none');
check('remove an unrelated plugin', level('remove the outdated plugin from the marketing site'), 'none');
check('drop an unrelated process', level('drop the old paper intake process entirely'), 'none');
check('scrap a pricing page', level('scrap the current pricing page and rebuild it'), 'none');
check('replace a load balancer', level('replace the staging load balancer with a managed one'), 'none');
check('replace a CRM', level('replace the legacy crm with the vendor all-in-one platform'), 'none');
check('sentence boundary blocks the link', level('replace our accounting system. the security team was not involved'), 'none');
check('"replacement" is not a removal verb', level('we will schedule replacement of the endpoint certificate'), 'none');
check('bare "soc" (system-on-chip) is not security vocabulary', level('we will merge the soc design backlog into the silicon roadmap'), 'none');
check('"security deposit" is scrubbed', level('we will drop the security deposit requirement for returning tenants'), 'none');
check('"public defender" is not a security platform', level('we will replace the public defender with outside counsel'), 'none');

console.log('\n=== 2. NEGATION / NON-COMMITMENT — must stay silent ===');
check('"will not replace CrowdStrike"', level('we will not replace crowdstrike with the app logging stack'), 'none');
check('"never remove the SIEM"', level('we will never remove the siem'), 'none');
check('"without replacing the EDR"', level('we can simplify the stack without replacing the edr'), 'none');
check('"if we were to eliminate the SIEM"', level('if we were to eliminate the siem this quarter'), 'none');
check('"rather than replace CrowdStrike"', level('we will extend the crm rather than replace crowdstrike'), 'none');

console.log('\n=== 3. AMBIGUOUS-ONLY — must not confirm, may flag for verification ===');
check('"merge observability dashboards" is not a confirmed violation', level('we will merge the application observability dashboards'), 'likely');
check('"drop the deprecated endpoint" is not a confirmed violation', level('we will drop the deprecated endpoint from the public api'), 'likely');
check('"remove all endpoints" is not a confirmed violation', level('we will remove all endpoints from the vendor stack'), 'likely');
if (score('we will merge the application observability dashboards') >= 70) {
    failures.push({ name: 'ambiguous-only score', actual: score('we will merge the application observability dashboards'), expected: '<70' });
}

console.log('\n=== 4. GENUINE — must confirm (level: confirmed) ===');
check('cancel EDR + consolidate into CRM', level('we will cancel our edr subscription and consolidate everything into the crm'), 'confirmed');
check('replace two named platforms', level('replace huntress and crowdstrike with the vendor all-in-one platform'), 'confirmed');
check('remove security monitoring plane', level('remove the independent security monitoring plane to reduce cost'), 'confirmed');
check('consolidate security operations', level('consolidate security operations into a single application vendor'), 'confirmed');
check('decommission the SIEM', level('decommission the siem and fold it into the new crm workspace'), 'confirmed');
check('replace CrowdStrike Falcon, endpoint context', level('the crm vendor will replace crowdstrike falcon on every endpoint'), 'confirmed');
check('cancel SentinelOne + endpoint protection', level('cancel sentinelone and let the crm handle endpoint protection'), 'confirmed');
check('workspace-supplied term', level('we will retire foxguard and move that role into the crm', ['foxguard']), 'confirmed');

console.log('\n=== 5. MORPHOLOGY — plurals, hyphens, compounds, new verbs ===');
check('hyphenated "incident-response"', level('we will fold incident-response into the app team'), 'confirmed');
check('"cybersecurity" compound', level('we will fold cybersecurity into the application engineering team'), 'confirmed');
check('"terminate CrowdStrike"', level('we will terminate crowdstrike and move detection into the app platform'), 'confirmed');
check('"let the SIEM contract lapse"', level('we will let the siem contract lapse'), 'confirmed');
check('"offload EDR"', level('we will offload edr to the application team'), 'confirmed');
check('"handed off" + SIEM', level('security operations is handed off to the application team, including siem and edr'), 'confirmed');

console.log('\n=== 6. ROBUSTNESS — workspace terms must never throw or inject ===');
let threw = null;
try { analyzeSecurityPlaneMerge('anything', ['[']); } catch (error) { threw = error.constructor.name; }
const noThrow = threw === null;
if (noThrow) pass++; else failures.push({ name: 'extra term "["', actual: threw, expected: 'no throw' });
console.log(`  ${noThrow ? 'PASS' : 'FAIL'}  extra term "[" did not throw (threw=${threw})`);

let injected = null;
try { injected = level('we will merge an unrelated backlog', ['siem|edr']); } catch (error) { injected = error.constructor.name; }
const noInject = injected === 'none';
if (noInject) pass++; else failures.push({ name: 'alternation injection', actual: injected, expected: 'none' });
console.log(`  ${noInject ? 'PASS' : 'FAIL'}  term "siem|edr" did not inject an alternation (level=${injected})`);

check('parenthesised workspace term', level('we will cancel soc 2 (type ii) this quarter', ['SOC 2 (Type II)']), 'confirmed');
check('double-space workspace term', level('we will cancel soc 2 this quarter', ['SOC  2']), 'confirmed');

console.log('\n=== 7. EVIDENCE TRAIL — a score must always come with reasons ===');
const trail = analyzeSecurityPlaneMerge('we will cancel our edr subscription');
const hasReasons = Array.isArray(trail.reasons) && trail.reasons.length >= 2;
if (hasReasons) pass++; else failures.push({ name: 'evidence trail', actual: trail.reasons, expected: '>=2 reasons' });
console.log(`  ${hasReasons ? 'PASS' : 'FAIL'}  confirmed signal carries ${trail.reasons.length} reason(s)`);
console.log(`         ${trail.reasons.join(' | ')}`);

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
for (const failure of failures) {
    console.log(`  FAILED: ${failure.name} — got ${JSON.stringify(failure.actual)}, want ${JSON.stringify(failure.expected)}`);
}
process.exit(failures.length === 0 ? 0 : 1);
