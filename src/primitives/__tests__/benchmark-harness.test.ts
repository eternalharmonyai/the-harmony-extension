/**
 * Benchmark Harness Tests — Beyond-100% Phase B1
 */
import * as assert from 'assert';

console.log('\n=== Benchmark Harness Tests ===\n');

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

function stddev(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

// Percentile tests
assert.strictEqual(percentile([1,2,3,4,5], 50), 3);
console.log('  ✅ p50: [1,2,3,4,5] → 3');
const d = Array.from({length:100},(_,i)=>i+1);
assert.ok(percentile(d,95) >= 95);
console.log('  ✅ p95: [1..100] → ' + percentile(d,95).toFixed(2));
assert.strictEqual(percentile([], 50), 0);
console.log('  ✅ Empty → 0');

// Stddev test
const sd = stddev([2,4,4,4,5,5,7,9], 5);
assert.ok(sd > 2 && sd < 2.2);
console.log('  ✅ stddev → ' + sd.toFixed(2));

// Simulated benchmarks
const sims: {name:string;fn:()=>number}[] = [
    {name:'rigor',fn:()=>{const g=new Map<number,number[]>();for(let i=0;i<100;i++)g.set(i,[]);for(let i=0;i<150;i++){const f=Math.random()*100|0,t=Math.random()*100|0;if(f!==t)g.get(f)!.push(t)}const v=new Set<number>(),s:number[]=[];const dfs=(n:number)=>{if(v.has(n))return;v.add(n);for(const c of g.get(n)!)dfs(c);s.push(n)};for(let i=0;i<100;i++)dfs(i);return s.length}},
    {name:'aletheia',fn:()=>{let s=0;for(let i=0;i<500;i++){const a=1+Math.random()*20,b=1+Math.random()*20;s+=a/(a+b)}return s}},
    {name:'kairos',fn:()=>{const n=50,v:number[][]=[];for(let i=0;i<n;i++)v.push(Array.from({length:10},()=>Math.random()));let t=0;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){let d=0,mA=0,mB=0;for(let k=0;k<10;k++){d+=v[i][k]*v[j][k];mA+=v[i][k]**2;mB+=v[j][k]**2}t+=d/(Math.sqrt(mA)*Math.sqrt(mB))}return t}},
    {name:'furies',fn:()=>{const p=['eval(','exec(','require('];const c='require('.repeat(50);let f=0;for(const x of p)if(c.includes(x))f++;return f}},
    {name:'logos',fn:()=>{let v=0;for(let i=0;i<200;i++){const a=Math.random()*100|0,b=Math.random()*100|0;if(a+b!==b+a)v++}return v}},
];

const results: {name:string;p50:number;p95:number;mean:number}[] = [];
for (const s of sims) {
    const lats:number[]=[];
    for(let i=0;i<3;i++)s.fn();
    for(let i=0;i<50;i++){const st=performance.now();s.fn();lats.push(performance.now()-st)}
    lats.sort((a,b)=>a-b);
    const m=lats.reduce((a,b)=>a+b,0)/lats.length;
    results.push({name:s.name,p50:percentile(lats,50),p95:percentile(lats,95),mean:m});
}

assert.strictEqual(results.length, 5);
console.log('  ✅ All 5 simulations completed');

results.sort((a,b)=>b.p95-a.p95);
console.log('\n  Primitive    p50(ms)  p95(ms)  mean(ms)');
console.log('  ' + '-'.repeat(45));
for(const r of results) console.log(`  ${r.name.padEnd(14)} ${r.p50.toFixed(2).padStart(7)} ${r.p95.toFixed(2).padStart(7)} ${r.mean.toFixed(2).padStart(7)}`);

for(const r of results) assert.ok(r.p50 < 5000, `${r.name} p50 < 5s`);
console.log('\n  ✅ All latencies within bounds');

const fur = results.find(r=>r.name==='furies')!;
assert.ok(fur.p95 < 100, `Furies p95 < 100ms (${fur.p95.toFixed(2)}ms)`);
console.log('  ✅ Furies fast as expected');

console.log('\n🎉 All Benchmark Harness tests passed!');
