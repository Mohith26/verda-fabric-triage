import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../src/triage.js';

const cl = T.makeCluster();
const data = JSON.parse(readFileSync(new URL('../data/cluster.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const all = new Set(cl.nodes.map((n) => n.id));

test('hypothesis space: 128 HCA paths + 16 nodes + 32 uplinks + transient, priors sum to 1', () => {
  const H = T.enumerateHypotheses(cl);
  assert.equal(H.length, 1 + 128 + 16 + 32);
  assert.ok(Math.abs(H.reduce((a, h) => a + h.prior, 0) - 1) < 1e-12);
  assert.equal(new Set(H.map((h) => h.id)).size, H.length);
});

test('affects(): HCA faults need node+rail, uplinks need cross-leaf traffic, 1-node tests see no fabric', () => {
  const path = { kind: 'path', node: 5, rail: 3 }, up = { kind: 'uplink', su: 1, rail: 2 };
  assert.ok(T.affects(path, { nodes: [5, 9], rails: null }, cl));
  assert.ok(!T.affects(path, { nodes: [5, 9], rails: [0, 1] }, cl));
  assert.ok(T.affects(path, { nodes: [5, 9], rails: [3] }, cl));
  assert.ok(!T.affects(path, { nodes: [5], rails: null }, cl));
  assert.ok(!T.affects(up, { nodes: [4, 5], rails: null }, cl), 'same leaf group never crosses the uplink');
  assert.ok(T.affects(up, { nodes: [4, 8], rails: [2] }, cl));
  assert.ok(!T.affects(up, { nodes: [0, 8], rails: null }, cl));
});

test('baseline busbw is ~92.8% of 400 GB/s for two nodes and scales with the HCA count', () => {
  assert.ok(Math.abs(T.baseline(2, null) - 371.2) < 0.01);
  assert.ok(Math.abs(T.baseline(2, [0]) * 8 - T.baseline(2, null)) < 1e-9);
  assert.ok(T.baseline(16, null) < T.baseline(4, null));
});

test('likelihood is maximised near the true bandwidth fraction (randomized)', () => {
  const r = T.rng(5);
  for (let k = 0; k < 200; k++) {
    const f = 0.45 + 0.5 * r(), base = 371.2;
    const y = base * f * (1 + T.CV_ALL * r.normal());
    let best = 0;
    T.SEV_GRID.forEach((s, j) => { if (T.logLik(y, base, s, T.CV_ALL) > T.logLik(y, base, T.SEV_GRID[best], T.CV_ALL)) best = j; });
    assert.ok(Math.abs(T.SEV_GRID[best] - f) < 0.06, `f=${f} best=${T.SEV_GRID[best]}`);
  }
});

test('planner only uses idle nodes and never double-books a (node, HCA) slot (randomized)', () => {
  const r = T.rng(11);
  for (let k = 0; k < 25; k++) {
    const st = T.createState(cl);
    const truth = T.randomTruth(cl, r);
    const trig = T.triggerFor(cl, truth, r);
    if (!trig) continue;
    T.addObservation(st, trig);
    const idle = new Set([...all].filter(() => r() < 0.6));
    const plan = T.planRound(st, idle);
    const seen = new Set();
    for (const t of plan) {
      assert.ok(t.nodes.every((n) => idle.has(n)));
      for (const x of T.slotsOf(t)) { assert.ok(!seen.has(x)); seen.add(x); }
    }
  }
});

test('greedy information gains are non-increasing within a round (entropy is submodular)', () => {
  const r = T.rng(17);
  for (let k = 0; k < 15; k++) {
    const st = T.createState(cl);
    const tr = T.triggerFor(cl, T.randomTruth(cl, r), r);
    if (!tr) continue;
    T.addObservation(st, tr);
    const plan = T.planRound(st, all);
    for (let i = 1; i < plan.length; i++) assert.ok(plan[i].gain <= plan[i - 1].gain + 1e-9);
  }
});

test('every demo preset is localized to exactly its injected faults', () => {
  for (const p of data.presets) {
    const st = T.createState(cl);
    T.addObservation(st, p.trigger);
    const r = T.rng(p.seed * 977 + 1);
    // same idle schedule as the UI: customer jobs hold nodes for their first rounds
    const idleAt = (k) => new Set([...all].filter((n) => !data.jobs.some((j) => k < j.untilRound && j.nodes.includes(n))));
    for (let k = 0; k < 40 && st.status === 'running'; k++) T.runRound(st, idleAt(k), p.faults, r);
    const got = st.findings.map((f) => f.h.id).sort();
    assert.deepEqual(got, p.faults.map((f) => f.h.id).sort(), p.id);
    assert.equal(st.status, p.faults.length ? 'localized' : 'clear', p.id);
  }
});

test('severity posterior brackets the true bandwidth fraction', () => {
  const p = data.presets.find((x) => x.id === 'silent-hca');
  const st = T.createState(cl); T.addObservation(st, p.trigger);
  const r = T.rng(3);
  for (let k = 0; k < 20 && st.status === 'running'; k++) T.runRound(st, all, p.faults, r);
  const f = st.findings[0];
  assert.ok(f.sev.lo - 0.01 <= 0.88 && 0.88 <= f.sev.hi + 0.01, JSON.stringify(f.sev));
});

test('a confirmed node-wide fault masks extra HCA hypotheses on that node', () => {
  const st = T.createState(cl);
  st.K.push({ h: { id: 'node:4', kind: 'node', node: 4 }, s: 0.8 });
  T.resetPosterior(st);
  const P = T.marginals(st);
  st.hyps.forEach((h, i) => { if (h.kind === 'path' && h.node === 4) assert.equal(P[i], 0); });
});

test('candidate tests avoid components already confirmed faulty', () => {
  const K = [{ h: { id: 'path:2:0', kind: 'path', node: 2, rail: 0 }, s: 0.6 }];
  for (const t of T.candidateTests(cl, all, K)) assert.equal(T.factorFor(K, t, cl), 1);
});

test('stop rule is calibrated: when it claims 99%, it is right at least ~98% of the time (randomized)', () => {
  const rows = T.backtest({ scenarios: 120, seed: 123, cluster: cl, methods: ['adaptive'] }).adaptive;
  const conf = rows.filter((x) => x.confident);
  assert.ok(conf.length / rows.length > 0.9);
  assert.ok(conf.filter((x) => x.exact).length / conf.length >= 0.98);
});

test('idle schedule holds the requested share of nodes', () => {
  const s = T.idleSchedule(cl, T.rng(2), 30, 0.5);
  for (const idle of s) assert.equal(idle.size, 8);
  assert.equal(T.idleSchedule(cl, T.rng(2), 3, 0)[0].size, 16);
});

test('evidence export and CSV carry every observation and finding', () => {
  const p = data.presets.find((x) => x.id === 'leaf-uplink');
  const st = T.createState(cl); T.addObservation(st, p.trigger);
  const r = T.rng(p.seed * 977 + 1);
  for (let k = 0; k < 40 && st.status === 'running'; k++) T.runRound(st, all, p.faults, r);
  const ev = T.evidence(st);
  assert.equal(ev.observations.length, st.obs.length);
  assert.equal(ev.findings[0].id, 'uplink:2:6');
  const csv = T.toCSV(st).split('\n');
  assert.equal(csv.length - 1, st.rounds.reduce((a, rd) => a + rd.tests.length, 0));
});

test('headline numbers in data/results.json reproduce exactly from the seeded backtest', { timeout: 600000 }, () => {
  const N = results.scenarios.idle;
  const s = T.summarize(T.backtest({ scenarios: N, seed: 7, busyFrac: 0, cluster: cl, methods: ['adaptive', 'bisection'] }));
  assert.equal(s.adaptive.exact, results.idle.adaptive.exact);
  assert.equal(s.adaptive.roundsMedian, results.idle.adaptive.roundsMedian);
  assert.equal(s.bisection.exact, results.idle.bisection.exact);
  assert.equal(s.adaptive.n, 1000);
  assert.ok(results.idle.adaptive.exact > results.idle.bisection.exact + 0.15);
});
