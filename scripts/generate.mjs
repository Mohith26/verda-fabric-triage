// Seeded data + backtest for the demo. Run: node scripts/generate.mjs
import { writeFileSync } from 'node:fs';
import * as T from '../src/triage.js';

const cluster = T.makeCluster({ hostname: 'orbit-pretrain', nodes: 16, suSize: 4 });
const at = (h) => new Date(Date.UTC(2026, 10, 11, 6, 0, 0) - h * 3600e3).toISOString();

// Incident presets the UI can replay (hidden truth; measurements are drawn live, seeded)
const presets = [
  { id: 'silent-hca', label: 'Silent HCA slowdown', seed: 11, faults: [{ h: { kind: 'path', node: 6, rail: 3 }, s: 0.88 }] },
  { id: 'half-rate', label: 'Link trained at half rate', seed: 21, faults: [{ h: { kind: 'path', node: 12, rail: 5 }, s: 0.5 }] },
  { id: 'leaf-uplink', label: 'Leaf uplink degraded', seed: 31, faults: [{ h: { kind: 'uplink', su: 2, rail: 6 }, s: 0.72 }] },
  { id: 'node-wide', label: 'Node-wide (PCIe / NUMA)', seed: 41, faults: [{ h: { kind: 'node', node: 9 }, s: 0.81 }] },
  { id: 'transient', label: 'False alarm (transient congestion)', seed: 51, faults: [], transient: true },
  { id: 'two-faults', label: 'Two faults at once', seed: 61, faults: [{ h: { kind: 'path', node: 2, rail: 0 }, s: 0.66 }, { h: { kind: 'path', node: 14, rail: 7 }, s: 0.9 }] },
];
for (const p of presets) for (const f of p.faults) f.h.id = f.h.kind === 'path' ? `path:${f.h.node}:${f.h.rail}` : f.h.kind === 'node' ? `node:${f.h.node}` : `uplink:${f.h.su}:${f.h.rail}`;
for (const p of presets) {
  const tr = T.triggerFor(cluster, p, T.rng(p.seed));
  if (!tr) throw new Error('preset does not trip the registry: ' + p.id);
  p.trigger = tr;
}

// Customer jobs holding nodes (Slurm view) - the planner may only use idle nodes
const jobs = [
  { id: 41827, name: 'sft-llama-70b', user: 'mkoskinen', nodes: [0, 1, 2, 3, 4, 5], start: at(9.2), state: 'RUNNING', untilRound: 5 },
  { id: 41833, name: 'eval-harness', user: 'jlaine', nodes: [10, 11], start: at(1.4), state: 'RUNNING', untilRound: 2 },
];

const registry = [
  { check: 'active-node-suite', scope: 'Node', kind: 'Owning', scheduler: 'slurm', result: 'Healthy', freshness: 'Fresh', age: '2h 11m', lastRun: at(2.18) },
  { check: 'passive-node-suite', scope: 'Node', kind: 'Observing', scheduler: 'slurm', result: 'Healthy', freshness: 'Fresh', age: '1m', lastRun: at(0.02) },
  { check: 'gpud-node-agent', scope: 'Node', kind: 'Observing', scheduler: 'slurm', result: 'Healthy', freshness: 'Fresh', age: '1m', lastRun: at(0.02) },
  { check: 'dcgm-exporter', scope: 'Node', kind: 'Observing', scheduler: 'slurm', result: 'Healthy', freshness: 'Fresh', age: '30s', lastRun: at(0.01) },
  { check: 'inter-node-nccl', scope: 'Fleet', kind: 'Owning', scheduler: 'slurm', result: 'Degraded', freshness: 'Fresh', age: '38m', lastRun: at(0.63) },
  { check: 'prolog-epilog-job-checks', scope: 'Node', kind: 'Owning', scheduler: 'slurm', result: 'Healthy', freshness: 'Fresh', age: '1h 02m', lastRun: at(1.03) },
  { check: 'weekly-training-benchmark', scope: 'Fleet', kind: 'Owning', scheduler: 'slurm', result: 'Healthy', freshness: 'Fresh', age: '3d 4h', lastRun: at(76) },
  { check: 'weekly-io-benchmark', scope: 'Node', kind: 'Owning', scheduler: 'slurm', result: 'Healthy', freshness: 'Fresh', age: '2d 19h', lastRun: at(67) },
];

const clusterDoc = {
  id: '6f1c2a9e-4b7d-4e15-9a3c-2d8e0f7b51c4', hostname: cluster.hostname, model: '128× B200 SXM6', template: '128B200',
  status: 'running', created_at: '2026-10-28T09:12:00Z', ip: '135.181.40.17', location: 'FIN-03', orchestrator: 'Slinky (Slurm on Kubernetes)',
  fabric: { hcasPerNode: 8, hcaGbit: 400, leafGroups: cluster.sus, nodesPerLeaf: cluster.suSize, note: 'rail-optimized: one leaf per rail per group of 4 nodes, spine above' },
  nodes: cluster.nodes, jobs, registry, presets,
};
writeFileSync(new URL('../data/cluster.json', import.meta.url), JSON.stringify(clusterDoc, null, 1));

// ---------- backtest ----------
const N = +(process.env.N || 1000);
const t0 = Date.now();
const idle = T.summarize(T.backtest({ scenarios: N, seed: 7, busyFrac: 0, cluster }));
const busy = T.summarize(T.backtest({ scenarios: Math.round(N / 2), seed: 8, busyFrac: 0.5, cluster }));
T.SIM.transientRate = 0.08; // misspecified: 8% flaky runs while the model assumes 3%
const flaky = T.summarize(T.backtest({ scenarios: Math.round(N / 2), seed: 9, busyFrac: 0, cluster, methods: ['adaptive'] }));
T.SIM.transientRate = 0.03;
const results = {
  generated: 'node scripts/generate.mjs (seeded; deterministic)', scenarios: { idle: N, busy: Math.round(N / 2), flaky: Math.round(N / 2) },
  assumptions: { nodes: 16, hcasPerNode: 8, leafGroups: 4, testMinutes: T.TEST_MIN, cvAllRails: T.CV_ALL, cvOneRail: T.CV_RAIL, transientRate: 0.03, degradedRatio: T.DEGRADED_RATIO, confidence: T.CONFIDENCE, bisectionThreshold: 0.93 },
  idle, busy, flaky, seconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(results, null, 1));
const fmt = (s) => Object.entries(s).map(([m, v]) => `${m.padEnd(10)} exact ${(100 * v.exact).toFixed(1)}%  node ${(100 * v.node).toFixed(1)}%  rounds p50 ${v.roundsMedian} p90 ${v.roundsP90}  node-min p50 ${v.nodeMinMedian}${v.exactWhenConfident != null ? `  conf ${(100 * v.confidentShare).toFixed(1)}% exact|conf ${(100 * v.exactWhenConfident).toFixed(1)}%` : ''}`).join('\n');
console.log('IDLE\n' + fmt(idle) + '\nBUSY\n' + fmt(busy) + '\nFLAKY\n' + fmt(flaky) + `\n${results.seconds}s`);
