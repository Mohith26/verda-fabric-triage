// Fabric triage: Bayesian adaptive localization of a degraded InfiniBand path,
// node or leaf uplink from small NCCL all_reduce_perf runs on idle nodes.
//
// Everything here is plain ES2020 with no dependencies, so the same module runs
// in the browser (index.html) and in Node (`node --test`, scripts/generate.mjs).

export const RAILS = 8;                 // 8x ConnectX HCAs per HGX node (one per GPU)
export const HCA_GBPS = 50;             // 400 Gbit/s NDR per HCA = 50 GB/s
export const BUS_EFF = 0.928;           // ~92-93% of line rate is the healthy busbw target
export const CV_ALL = 0.012;            // run-to-run noise, all 8 rails
export const CV_RAIL = 0.018;           // run-to-run noise, rail-masked runs (NCCL_IB_HCA)
export const NU = 5;                    // Student-t degrees of freedom (robust to flukes)
export const TEST_MIN = 1.0;            // minutes per test incl. launch (all_reduce_perf -b 1G -e 2G)
export const DEGRADED_RATIO = 0.95;     // registry review threshold for inter-node-nccl
export const CONFIDENCE = 0.99;         // stop when one explanation holds >= 99% posterior
export const SEV_GRID = Array.from({ length: 58 }, (_, i) => Math.round((0.40 + 0.01 * i) * 100) / 100);
export const MASKS = [
  null,
  [0, 1, 2, 3], [4, 5, 6, 7],
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0], [1], [2], [3], [4], [5], [6], [7],
];

// ---------- deterministic RNG ----------
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.int = (n) => Math.floor(next() * n);
  return next;
}

// ---------- cluster + hypotheses ----------
export function makeCluster({ hostname = 'orbit-pretrain', nodes = 16, suSize = 4 } = {}) {
  return {
    hostname, rails: RAILS, suSize, sus: Math.ceil(nodes / suSize),
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: i, name: `${hostname}-${String(i + 1).padStart(2, '0')}`, su: Math.floor(i / suSize),
    })),
  };
}

export const railName = (r) => `mlx5_${r}`;
export const suName = (s) => `leaf-${String.fromCharCode(65 + s)}`;

export function enumerateHypotheses(cluster) {
  const N = cluster.nodes.length, R = cluster.rails, U = cluster.sus;
  const hyps = [{ id: 'none', kind: 'none', prior: 0.10 }];
  for (let n = 0; n < N; n++) for (let r = 0; r < R; r++)
    hyps.push({ id: `path:${n}:${r}`, kind: 'path', node: n, rail: r, prior: 0.55 / (N * R) });
  for (let n = 0; n < N; n++) hyps.push({ id: `node:${n}`, kind: 'node', node: n, prior: 0.15 / N });
  for (let s = 0; s < U; s++) for (let r = 0; r < R; r++)
    hyps.push({ id: `uplink:${s}:${r}`, kind: 'uplink', su: s, rail: r, prior: 0.20 / (U * R) });
  return hyps;
}

export function describe(h, cluster) {
  if (!h || h.kind === 'none') return 'No persistent fault';
  if (h.kind === 'path') return `${cluster.nodes[h.node].name} · ${railName(h.rail)}`;
  if (h.kind === 'node') return `${cluster.nodes[h.node].name} · all rails`;
  return `${suName(h.su)} uplinks · rail ${h.rail}`;
}

export function kindLabel(h) {
  return { none: 'Transient', path: 'HCA / cable path', node: 'Node-wide', uplink: 'Leaf uplink' }[h.kind];
}

// Does fault hypothesis h slow down test t?  A test is {nodes:[...], rails:null|[...]}.
export function affects(h, t, cluster) {
  if (!h || h.kind === 'none' || t.nodes.length < 2) return false;
  if (h.kind === 'path') return t.nodes.includes(h.node) && (!t.rails || t.rails.includes(h.rail));
  if (h.kind === 'node') return t.nodes.includes(h.node);
  if (t.rails && !t.rails.includes(h.rail)) return false;
  let has = false, other = false;
  for (const n of t.nodes) { if (cluster.nodes[n].su === h.su) has = true; else other = true; }
  return has && other;
}

export function baseline(k, rails) {
  const eff = BUS_EFF * (1 - 0.006 * Math.log2(Math.max(2, k) / 2));
  return HCA_GBPS * (rails ? rails.length : RAILS) * eff;
}
export const cvOf = (t) => (t.rails ? CV_RAIL : CV_ALL);

// Bottleneck model: a ring/tree collective runs at the speed of its slowest
// participating path, so the measured fraction is the min over affected faults.
export function factorFor(faults, t, cluster) {
  let f = 1;
  for (const { h, s } of faults) if (affects(h, t, cluster)) f = Math.min(f, s);
  return f;
}

// log Student-t density of a multiplicative measurement y = base * f * (1 + cv*e)
// Student-t kernel normaliser for NU=5: Gamma(3)/(Gamma(2.5)*sqrt(5*pi))
const T_NORM = Math.log(0.37960669);
export const TRANSIENT_RATE = 0.03;     // share of runs slowed by unrelated congestion
export function logLik(y, base, f, cv) {
  const z = (y / (base * f) - 1) / cv;
  const lt = T_NORM - ((NU + 1) / 2) * Math.log(1 + (z * z) / NU) - Math.log(base * f * cv);
  // transient congestion: the run is slowed to U(0.85, 0.97) of what the fabric can do
  const q = y / (base * f);
  const lg = q > 0.83 && q < 0.99 ? Math.log(1 / (0.16 * base * f)) : -Infinity;
  const a = Math.log(1 - TRANSIENT_RATE) + lt, b = Math.log(TRANSIENT_RATE) + lg;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

// ---------- posterior ----------
function sevLogPrior() {
  // 40%: a link that trained at half rate (NDR->HDR) or half width; 60%: anything.
  const w = SEV_GRID.map((s) => 0.4 * Math.exp(-0.5 * ((s - 0.5) / 0.03) ** 2) / (0.03 * Math.sqrt(2 * Math.PI)) + 0.6 / 0.58);
  const Z = w.reduce((a, b) => a + b, 0);
  return w.map((x) => Math.log(x / Z));
}
const SEV_LP = sevLogPrior();

export function createState(cluster, opts = {}) {
  const hyps = enumerateHypotheses(cluster);
  const st = {
    cluster, hyps, K: [], obs: [], rounds: [], findings: [],
    status: 'running', maxRounds: opts.maxRounds ?? 40, maxFaults: opts.maxFaults ?? 3,
    lp: null, lpNone: 0,
  };
  resetPosterior(st);
  return st;
}

// Hypotheses already confirmed, or masked by a confirmed node-wide fault (every
// test that could reveal an extra HCA fault on that node is bottlenecked by it).
function excluded(st, i) {
  const h = st.hyps[i];
  return st.K.some((k) => k.h.id === h.id || (k.h.kind === 'node' && h.kind === 'path' && h.node === k.h.node));
}

export function resetPosterior(st) {
  const H = st.hyps.length, S = SEV_GRID.length;
  st.lp = new Float64Array(H * S).fill(-Infinity);
  for (let i = 1; i < H; i++) {
    if (excluded(st, i)) continue;
    const lpr = Math.log(st.hyps[i].prior);
    for (let j = 0; j < S; j++) st.lp[i * S + j] = lpr + SEV_LP[j];
  }
  st.lpNone = Math.log(st.hyps[0].prior);
  for (const o of st.obs) applyObs(st, o);
}

function applyObs(st, o) {
  const S = SEV_GRID.length, H = st.hyps.length, cl = st.cluster;
  const fK = factorFor(st.K, o, cl);
  const cv = cvOf(o);
  // 'none' = nothing beyond the faults already confirmed in K
  if (o.kind === 'trigger' && st.K.length === 0) st.lpNone += Math.log(1 / (0.47 * o.base)); // transient slowdown ~U(0.5,0.97)
  else st.lpNone += logLik(o.y, o.base, fK, cv);
  const llUn = logLik(o.y, o.base, fK, cv);
  for (let i = 1; i < H; i++) {
    const h = st.hyps[i];
    if (st.lp[i * S] === -Infinity && st.lp[i * S + S - 1] === -Infinity) continue;
    if (!affects(h, o, cl)) { for (let j = 0; j < S; j++) st.lp[i * S + j] += llUn; continue; }
    for (let j = 0; j < S; j++) st.lp[i * S + j] += logLik(o.y, o.base, Math.min(fK, SEV_GRID[j]), cv);
  }
}

export function addObservation(st, o) { st.obs.push(o); applyObs(st, o); }

// Marginal posterior over hypotheses (severity integrated out) + severity summaries.
export function marginals(st) {
  const S = SEV_GRID.length, H = st.hyps.length;
  let mx = st.lpNone;
  for (let k = 0; k < st.lp.length; k++) if (st.lp[k] > mx) mx = st.lp[k];
  const p = new Float64Array(H);
  p[0] = Math.exp(st.lpNone - mx);
  let Z = p[0];
  for (let i = 1; i < H; i++) {
    let s = 0;
    for (let j = 0; j < S; j++) { const v = st.lp[i * S + j]; if (v > -Infinity) s += Math.exp(v - mx); }
    p[i] = s; Z += s;
  }
  for (let i = 0; i < H; i++) p[i] /= Z;
  return p;
}

export function severityPosterior(st, i) {
  const S = SEV_GRID.length;
  let mx = -Infinity;
  for (let j = 0; j < S; j++) mx = Math.max(mx, st.lp[i * S + j]);
  const w = SEV_GRID.map((_, j) => Math.exp(st.lp[i * S + j] - mx));
  const Z = w.reduce((a, b) => a + b, 0);
  const p = w.map((x) => x / Z);
  let mean = 0; p.forEach((x, j) => { mean += x * SEV_GRID[j]; });
  let c = 0, lo = SEV_GRID[0], hi = SEV_GRID[S - 1], gotLo = false;
  for (let j = 0; j < S; j++) {
    c += p[j];
    if (!gotLo && c >= 0.05) { lo = SEV_GRID[j]; gotLo = true; }
    if (c >= 0.95) { hi = SEV_GRID[j]; break; }
  }
  let mode = 0; p.forEach((x, j) => { if (x > p[mode]) mode = j; });
  return { mean, lo, hi, mode: SEV_GRID[mode], p };
}

export function topHypotheses(st, k = 5) {
  const p = marginals(st);
  return [...p.keys()].map((i) => ({ i, h: st.hyps[i], p: p[i] }))
    .sort((a, b) => b.p - a.p).slice(0, k);
}

// ---------- planner: greedy information-optimal batch on idle nodes ----------
export function entropy(weights) {
  let H = 0; for (const w of weights) if (w > 0) H -= w * Math.log2(w); return H;
}


export function candidateTests(cluster, idle, K = []) {
  const out = [];
  const ids = [...idle].sort((a, b) => a - b);
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++)
    for (const m of MASKS) out.push({ nodes: [ids[a], ids[b]], rails: m });
  for (let s = 0; s < cluster.sus; s++) {
    const g = ids.filter((n) => cluster.nodes[n].su === s);
    if (g.length >= 3) for (const m of MASKS.slice(0, 3)) out.push({ nodes: g, rails: m });
  }
  // a test that crosses an already-confirmed fault is bottlenecked by it and tells us nothing new
  return K.length ? out.filter((t) => factorFor(K, t, cluster) === 1) : out;
}

// A test occupies (node, rail) slots: a rail-masked run pins GPU r <-> HCA r
// (CUDA_VISIBLE_DEVICES + NCCL_IB_HCA), so runs on disjoint rails can share a node.
export function slotsOf(t) {
  const rails = t.rails || [0, 1, 2, 3, 4, 5, 6, 7];
  const out = [];
  for (const n of t.nodes) for (const r of rails) out.push(n * RAILS + r);
  return out;
}

export function planRound(st, idle, { lambda = 0.004, maxTests = 16, minGain = 0.002 } = {}) {
  const p = marginals(st);
  const live = [];
  for (let i = 0; i < p.length; i++) if (p[i] > 1e-7) live.push(i);
  const L = live.length;
  const w = Float64Array.from(live, (i) => p[i]);
  const cands = candidateTests(st.cluster, idle, st.K);
  // affected bitmap per candidate over live hypotheses (computed once per round)
  const aff = cands.map((t) => Uint8Array.from(live, (i) => (affects(st.hyps[i], t, st.cluster) ? 1 : 0)));
  const slots = cands.map(slotsOf);
  const used = new Set();
  let cls = new Int32Array(L); let nCls = 1; // current partition of live hypotheses
  let H0 = 0;
  const acc = new Float64Array(2 * L + 2);
  const batch = [];
  while (batch.length < maxTests) {
    let best = -1, bestScore = -Infinity, bestH = 0;
    for (let c = 0; c < cands.length; c++) {
      if (slots[c].some((x) => used.has(x))) continue;
      acc.fill(0, 0, 2 * nCls);
      const a = aff[c];
      for (let k = 0; k < L; k++) acc[2 * cls[k] + a[k]] += w[k];
      let H = 0;
      for (let q = 0; q < 2 * nCls; q++) { const v = acc[q]; if (v > 0) H -= v * Math.log2(v); }
      const t = cands[c];
      const score = (H - H0) - lambda * gpuShare(t) * TEST_MIN;
      if (score > bestScore + 1e-12) { bestScore = score; best = c; bestH = H; }
    }
    if (best < 0 || bestH - H0 < minGain) break;
    batch.push({ ...cands[best], gain: bestH - H0 });
    slots[best].forEach((x) => used.add(x));
    // relabel classes
    const map = new Map(); const nc = new Int32Array(L);
    for (let k = 0; k < L; k++) { const key = 2 * cls[k] + aff[best][k]; if (!map.has(key)) map.set(key, map.size); nc[k] = map.get(key); }
    cls = nc; nCls = map.size; H0 = bestH;
  }
  return batch;
}

// ---------- measurement (simulated) ----------
export const SIM = { transientRate: 0.03 };   // simulator knob (model assumes TRANSIENT_RATE)
export function measure(test, truth, cluster, r, { transientRate = SIM.transientRate } = {}) {
  const base = baseline(test.nodes.length, test.rails);
  let f = factorFor(truth, test, cluster);
  if (r() < transientRate) f *= 0.85 + 0.12 * r();
  const y = base * f * (1 + cvOf(test) * r.normal());
  return { ...test, base, y: Math.round(y * 10) / 10, ratio: y / base };
}

// ---------- one adaptive round: plan -> run -> update -> maybe confirm ----------
export function decide(st) {
  for (let guard = 0; guard < st.maxFaults + 1; guard++) {
    const p = marginals(st);
    let top = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[top]) top = i;
    if (p[top] < CONFIDENCE) return false;
    if (top === 0) { st.status = st.K.length ? 'localized' : 'clear'; return true; }
    const sev = severityPosterior(st, top);
    const h = st.hyps[top];
    st.findings.push({ h, prob: p[top], sev, round: st.rounds.length });
    st.K.push({ h, s: sev.mode });
    if (st.K.length >= st.maxFaults) { st.status = 'localized'; return true; }
    resetPosterior(st);
  }
  return false;
}

export function runRound(st, idle, truth, r) {
  if (st.status !== 'running') return null;
  const tests = planRound(st, idle);
  if (!tests.length) {
    st.rounds.push({ tests: [], idle: [...idle], skipped: true });
    if (st.rounds.length >= st.maxRounds) st.status = 'inconclusive';
    return st.rounds.at(-1);
  }
  const results = tests.map((t) => measure(t, truth, st.cluster, r));
  results.forEach((o, k) => { o.gain = tests[k].gain; addObservation(st, { ...o, kind: 'test' }); });
  st.rounds.push({ tests: results, idle: [...idle] });
  decide(st);
  if (st.status === 'running' && st.rounds.length >= st.maxRounds) st.status = 'inconclusive';
  return st.rounds.at(-1);
}

export function triggerObservation(cluster, truth, r) {
  const t = { nodes: cluster.nodes.map((n) => n.id), rails: null };
  const o = measure(t, truth, cluster, r, { transientRate: 0 });
  return { ...o, kind: 'trigger' };
}

// ---------- scenarios ----------
export function randomTruth(cluster, r, { allowDouble = true } = {}) {
  const u = r();
  const sev = () => {
    const v = r();
    if (v < 0.40) return Math.round((0.5 + 0.03 * r.normal()) * 1000) / 1000;
    if (v < 0.75) return Math.round((0.60 + 0.25 * r()) * 1000) / 1000;
    return Math.round((0.85 + 0.09 * r()) * 1000) / 1000;   // "silent": 6-15% slower
  };
  const one = () => {
    const k = r();
    if (k < 0.611) return { h: { kind: 'path', node: r.int(cluster.nodes.length), rail: r.int(RAILS) }, s: sev() };
    if (k < 0.778) return { h: { kind: 'node', node: r.int(cluster.nodes.length) }, s: sev() };
    return { h: { kind: 'uplink', su: r.int(cluster.sus), rail: r.int(RAILS) }, s: sev() };
  };
  const withId = (f) => ({ ...f, h: { ...f.h, id: f.h.kind === 'path' ? `path:${f.h.node}:${f.h.rail}` : f.h.kind === 'node' ? `node:${f.h.node}` : `uplink:${f.h.su}:${f.h.rail}` } });
  if (u < 0.10) return { faults: [], transient: true };
  const faults = [withId(one())];
  if (allowDouble && u > 0.94) {
    let g; do { g = withId(one()); } while (g.h.id === faults[0].h.id);
    faults.push(g);
  }
  return { faults, transient: false };
}

// Busy-cluster idle schedule: customer jobs hold contiguous blocks of nodes.
export function idleSchedule(cluster, r, rounds, busyFrac) {
  const N = cluster.nodes.length, out = [];
  let held = new Set();
  for (let k = 0; k < rounds; k++) {
    if (k === 0 || r() < 0.35) {
      held = new Set();
      const target = Math.round(busyFrac * N);
      while (held.size < target) {
        const len = 2 + r.int(5), start = r.int(N);
        for (let x = 0; x < len && held.size < target; x++) held.add((start + x) % N);
      }
    }
    out.push(new Set(cluster.nodes.map((n) => n.id).filter((n) => !held.has(n))));
  }
  return out;
}

export function triggerFor(cluster, truthObj, r) {
  // The registry run that fired the incident: full-cluster all_reduce, ratio < 0.95.
  for (let tries = 0; tries < 50; tries++) {
    const t = { nodes: cluster.nodes.map((n) => n.id), rails: null };
    const base = baseline(t.nodes.length, null);
    let f = factorFor(truthObj.faults, t, cluster);
    if (truthObj.transient) f *= 0.80 + 0.14 * r();
    const y = base * f * (1 + CV_ALL * r.normal());
    if (y / base < DEGRADED_RATIO) return { ...t, base, y: Math.round(y * 10) / 10, ratio: y / base, kind: 'trigger' };
  }
  return null;
}

// node-minutes charged for a test: a rail-masked run holds 1/8 of each node per rail
export const gpuShare = (t) => t.nodes.length * (t.rails ? t.rails.length : RAILS) / RAILS;

// ---------- methods compared in the backtest ----------
function sameFault(a, b) { return a && b && a.id === b.id; }

export function scoreOutcome(truthObj, reported) {
  const tf = truthObj.faults;
  if (!tf.length) return { exact: reported.length === 0, node: reported.length === 0 };
  const ids = new Set(reported.map((h) => h.id));
  const exact = tf.every((f) => ids.has(f.h.id)) && reported.length === tf.length;
  const nodeOf = (h) => (h.kind === 'uplink' ? `u${h.su}` : `n${h.node}`);
  const rn = new Set(reported.map(nodeOf));
  const node = tf.every((f) => rn.has(nodeOf(f.h)));
  return { exact, node };
}

export function runAdaptive(cluster, truthObj, trigger, sched, r) {
  const st = createState(cluster);
  addObservation(st, trigger);
  let k = 0, nodeMin = 0, tests = 0;
  while (st.status === 'running' && k < sched.length) {
    const rd = runRound(st, sched[k], truthObj.faults, r);
    k++;
    if (rd) for (const t of rd.tests) { nodeMin += gpuShare(t) * TEST_MIN; tests++; }
  }
  if (st.status === 'running') st.status = 'inconclusive';
  const reported = st.findings.map((f) => f.h);
  if (st.status === 'inconclusive') {
    const top = topHypotheses(st, 1)[0];
    if (top.h.kind !== 'none') reported.push(top.h);
  }
  return { reported, rounds: k, nodeMin, tests, status: st.status, confident: st.status !== 'inconclusive', st };
}

// Practitioner baseline modelled on topology-aware threshold bisection
// (NVIDIA Cluster Readiness Engine "diagnose" mode / common runbooks):
// pass/fail at a fixed ratio, halve failing groups, confirm, then bisect HCAs.
export function runBisection(cluster, truthObj, sched, r, thr = 0.93) {
  let k = 0, nodeMin = 0, tests = 0;
  const run = (batch) => {
    // a fixed plan cannot swap nodes: each test waits until its own nodes are idle
    const res = Array(batch.length).fill(null);
    while (res.some((x) => x === null)) {
      if (k >= sched.length) return null;
      const idle = new Set(sched[k]);
      batch.forEach((t, i) => {
        if (res[i] !== null || !t.nodes.every((n) => idle.has(n))) return;
        t.nodes.forEach((n) => idle.delete(n));
        nodeMin += gpuShare(t) * TEST_MIN; tests++;
        res[i] = measure(t, truthObj.faults, cluster, r).ratio >= thr;
      });
      k++;
    }
    return res;
  };
  const bySu = Array.from({ length: cluster.sus }, (_, s) => cluster.nodes.filter((n) => n.su === s).map((n) => n.id));
  const out = (reported) => ({ reported, rounds: k, nodeMin, tests });
  const r1 = run(bySu.map((g) => ({ nodes: g, rails: null })));
  if (!r1) return out([]);
  const failing = bySu.filter((_, i) => !r1[i]);
  const railBisect = (pair) => {
    let rails = [0, 1, 2, 3, 4, 5, 6, 7];
    while (rails.length > 1) {
      const half = rails.slice(0, rails.length / 2);
      const res = run([{ nodes: pair, rails: half }]);
      if (!res) return null;
      rails = res[0] ? rails.slice(rails.length / 2) : half;
    }
    return rails[0];
  };
  if (!failing.length) {
    // cross-boundary probing: SU pairs, then HCA bisection on a failing pair
    const U = cluster.sus, failPairs = [];
    const sched3 = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
    for (const roundPairs of sched3) {
      const batch = roundPairs.map(([a, b]) => ({ nodes: [bySu[a][0], bySu[b][0]], rails: null }));
      const res = run(batch); if (!res) return out([]);
      res.forEach((ok, i) => { if (!ok) failPairs.push(roundPairs[i]); });
    }
    if (!failPairs.length) return out([]);
    const cnt = Array(U).fill(0); failPairs.forEach(([a, b]) => { cnt[a]++; cnt[b]++; });
    const su = cnt.indexOf(Math.max(...cnt));
    const fp = failPairs[0];
    const rail = railBisect([bySu[fp[0]][0], bySu[fp[1]][0]]);
    if (rail == null) return out([]);
    return out([{ kind: 'uplink', su, rail, id: `uplink:${su}:${rail}` }]);
  }
  const reported = [];
  for (const g of failing) {
    let cand = g;
    while (cand.length > 2) {
      const a = cand.slice(0, cand.length / 2), b = cand.slice(cand.length / 2);
      const res = run([{ nodes: a, rails: null }, { nodes: b, rails: null }]);
      if (!res) return out(reported);
      if (!res[0]) cand = a; else if (!res[1]) cand = b; else break; // both pass: noise, keep cand
    }
    if (cand.length > 2) cand = cand.slice(0, 2);
    const good = cluster.nodes.map((n) => n.id).filter((n) => !g.includes(n)).slice(0, 2);
    const res = run([{ nodes: [cand[0], good[0]], rails: null }, { nodes: [cand[1], good[1]], rails: null }]);
    if (!res) return out(reported);
    const node = !res[0] ? cand[0] : !res[1] ? cand[1] : cand[0];
    // node-wide vs single HCA: test the two rail halves; both failing => node-wide
    const hA = run([{ nodes: [node, good[0]], rails: [0, 1, 2, 3] }]);
    const hB = run([{ nodes: [node, good[0]], rails: [4, 5, 6, 7] }]);
    if (!hA || !hB) return out(reported);
    if (!hA[0] && !hB[0]) { reported.push({ kind: 'node', node, id: `node:${node}` }); continue; }
    let rails = !hA[0] ? [0, 1, 2, 3] : [4, 5, 6, 7];
    while (rails.length > 1) {
      const half = rails.slice(0, rails.length / 2);
      const rr = run([{ nodes: [node, good[0]], rails: half }]);
      if (!rr) return out(reported);
      rails = rr[0] ? rails.slice(rails.length / 2) : half;
    }
    reported.push({ kind: 'path', node, rail: rails[0], id: `path:${node}:${rails[0]}` });
  }
  return out(reported);
}

// Exhaustive baseline: every node pair once (round-robin), then HCA tests on the
// worst node, decoded with the same Bayesian posterior (best decoding, fixed design).
export function runPairwise(cluster, truthObj, trigger, sched, r) {
  const st = createState(cluster);
  addObservation(st, trigger);
  const N = cluster.nodes.length;
  const pending = [];
  const ids = cluster.nodes.map((n) => n.id);
  for (let rd = 0; rd < N - 1; rd++) {
    const arr = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + rd) % (N - 1))])];
    for (let i = 0; i < N / 2; i++) pending.push({ nodes: [arr[i], arr[N - 1 - i]], rails: null });
  }
  let k = 0, nodeMin = 0, tests = 0;
  const exec = (list) => {
    while (list.length && k < sched.length) {
      const idle = new Set(sched[k]); const used = new Set(); const batch = [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.nodes.every((n) => idle.has(n)) && !slotsOf(t).some((x) => used.has(x))) { batch.push(t); slotsOf(t).forEach((x) => used.add(x)); list.splice(i, 1); i--; }
      }
      k++;
      for (const t of batch) { nodeMin += gpuShare(t) * TEST_MIN; tests++; addObservation(st, { ...measure(t, truthObj.faults, cluster, r), kind: 'test' }); }
    }
  };
  exec(pending);
  const top = topHypotheses(st, 1)[0];
  if (top.h.kind === 'path' || top.h.kind === 'node') {
    const good = ids.find((n) => n !== top.h.node && cluster.nodes[n].su !== cluster.nodes[top.h.node].su);
    exec(MASKS.slice(7).map((m) => ({ nodes: [top.h.node, good], rails: m })));
  } else if (top.h.kind === 'uplink') {
    const a = ids.find((n) => cluster.nodes[n].su === top.h.su), b = ids.find((n) => cluster.nodes[n].su !== top.h.su);
    exec(MASKS.slice(7).map((m) => ({ nodes: [a, b], rails: m })));
  }
  const reported = [];
  const p = marginals(st);
  // decode greedily: accept hypotheses until 'none' explains the rest
  let guard = 0;
  while (guard++ < 3) {
    const t1 = topHypotheses(st, 1)[0];
    if (t1.h.kind === 'none') break;
    reported.push(t1.h);
    st.K.push({ h: t1.h, s: severityPosterior(st, t1.i).mode });
    resetPosterior(st);
  }
  void p;
  return { reported, rounds: k, nodeMin, tests };
}

// ---------- backtest ----------
export function quantile(xs, q) {
  const a = [...xs].sort((x, y) => x - y); if (!a.length) return NaN;
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function backtest({ scenarios = 400, seed = 7, busyFrac = 0, cluster = makeCluster(), methods = ['adaptive', 'bisection', 'pairwise'] } = {}) {
  const rows = { adaptive: [], bisection: [], pairwise: [] };
  for (let s = 0; s < scenarios; s++) {
    const rs = rng(seed * 100003 + s);
    const truthObj = randomTruth(cluster, rs);
    const trigger = triggerFor(cluster, truthObj, rs);
    if (!trigger) continue; // fault too mild to trip the registry (not an incident)
    const sched = idleSchedule(cluster, rng(seed * 7919 + s), 60, busyFrac);
    const sev = truthObj.faults[0]?.s ?? 1;
    const meta = { s, kind: truthObj.faults[0]?.h.kind ?? 'none', double: truthObj.faults.length > 1, silent: sev >= 0.85 && sev < 1 };
    if (methods.includes('adaptive')) { const o = runAdaptive(cluster, truthObj, trigger, sched, rng(seed * 31 + s)); rows.adaptive.push({ ...meta, ...scoreOutcome(truthObj, o.reported), rounds: o.rounds, nodeMin: o.nodeMin, tests: o.tests, confident: o.confident }); }
    if (methods.includes('bisection')) { const o = runBisection(cluster, truthObj, sched, rng(seed * 37 + s)); rows.bisection.push({ ...meta, ...scoreOutcome(truthObj, o.reported), rounds: o.rounds, nodeMin: o.nodeMin, tests: o.tests }); }
    if (methods.includes('pairwise')) { const o = runPairwise(cluster, truthObj, trigger, sched, rng(seed * 41 + s)); rows.pairwise.push({ ...meta, ...scoreOutcome(truthObj, o.reported), rounds: o.rounds, nodeMin: o.nodeMin, tests: o.tests }); }
  }
  return rows;
}

export function summarize(rows) {
  const f = (arr, pred) => { const a = arr.filter(pred); return a.length; };
  const out = {};
  for (const [m, arr] of Object.entries(rows)) {
    if (!arr.length) continue;
    const n = arr.length;
    const sub = (pred) => { const a = arr.filter(pred); return { n: a.length, exact: a.length ? a.filter((x) => x.exact).length / a.length : null }; };
    out[m] = {
      n, exact: f(arr, (x) => x.exact) / n, node: f(arr, (x) => x.node) / n,
      roundsMedian: quantile(arr.map((x) => x.rounds), 0.5), roundsP90: quantile(arr.map((x) => x.rounds), 0.9),
      nodeMinMedian: quantile(arr.map((x) => x.nodeMin), 0.5), nodeMinMean: arr.reduce((a, x) => a + x.nodeMin, 0) / n,
      testsMedian: quantile(arr.map((x) => x.tests), 0.5),
      byKind: { path: sub((x) => x.kind === 'path' && !x.double), node: sub((x) => x.kind === 'node' && !x.double), uplink: sub((x) => x.kind === 'uplink' && !x.double), none: sub((x) => x.kind === 'none'), double: sub((x) => x.double), silent: sub((x) => x.silent && !x.double) },
    };
    if (m === 'adaptive') {
      const conf = arr.filter((x) => x.confident);
      out[m].confidentShare = conf.length / n;
      out[m].exactWhenConfident = conf.length ? conf.filter((x) => x.exact).length / conf.length : null;
    }
  }
  return out;
}

// ---------- evidence export ----------
export function evidence(st) {
  return {
    cluster: st.cluster.hostname,
    status: st.status,
    findings: st.findings.map((f) => ({ component: describe(f.h, st.cluster), id: f.h.id, kind: f.h.kind, probability: +f.prob.toFixed(4), bandwidth_fraction: +f.sev.mean.toFixed(3), interval_90: [f.sev.lo, f.sev.hi], confirmed_after_round: f.round })),
    observations: st.obs.map((o, i) => ({ i, kind: o.kind, nodes: o.nodes.map((n) => st.cluster.nodes[n].name), hcas: o.rails ? o.rails.map(railName) : 'all', busbw_gbps: o.y, baseline_gbps: +o.base.toFixed(1), ratio: +(o.y / o.base).toFixed(4) })),
  };
}

export function toCSV(st) {
  const rows = [['round', 'test', 'nodes', 'hcas', 'busbw_gbps', 'baseline_gbps', 'ratio', 'expected_bits']];
  st.rounds.forEach((rd, k) => rd.tests.forEach((t, j) => rows.push([k + 1, j + 1, t.nodes.map((n) => st.cluster.nodes[n].name).join(' '), t.rails ? t.rails.map(railName).join(' ') : 'all', t.y, t.base.toFixed(1), (t.y / t.base).toFixed(4), (t.gain ?? 0).toFixed(3)])));
  return rows.map((r) => r.join(',')).join('\n');
}
