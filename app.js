import * as T from './src/triage.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ic = (n, cls = '') => `<svg class="svg ${cls}" aria-hidden="true"><use href="#icon-${n}"/></svg>`;
const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const prob = (x) => (x >= 0.9995 ? '>99.9%' : pct(x, x < 0.001 ? 2 : 1));
const LS = 'verda-fabric-triage:v1';

const app = { data: null, results: null, cluster: null, store: null, sims: {} };

// ---------- persistence ----------
function loadStore() {
  try { const s = JSON.parse(localStorage.getItem(LS)); if (s && s.v === 1) return s; } catch { /* ignore */ }
  return { v: 1, preset: 'silent-hca', rounds: {}, drained: [], repairs: [], activity: [], ncclRecheck: null };
}
const save = () => localStorage.setItem(LS, JSON.stringify(app.store));

// ---------- simulation (deterministic replay from seed + rounds run) ----------
function presetById(id) { return app.data.presets.find((p) => p.id === id) || app.data.presets[0]; }
function idleAt(k) {
  const held = new Set();
  for (const j of app.data.jobs) if (k < j.untilRound) j.nodes.forEach((n) => held.add(n));
  app.store.drained.forEach((n) => held.add(n));
  return new Set(app.cluster.nodes.map((n) => n.id).filter((n) => !held.has(n)));
}
function sim(presetId) {
  const p = presetById(presetId);
  const want = app.store.rounds[p.id] || 0;
  let s = app.sims[p.id];
  if (!s || s.st.rounds.length > want) {
    const st = T.createState(app.cluster);
    T.addObservation(st, p.trigger);
    s = app.sims[p.id] = { p, st, r: T.rng(p.seed * 977 + 1) };
  }
  while (s.st.rounds.length < want && s.st.status === 'running') T.runRound(s.st, idleAt(s.st.rounds.length), p.faults, s.r);
  return s;
}
function step(presetId, untilDone = false) {
  const s = sim(presetId);
  let n = 0;
  do {
    if (s.st.status !== 'running') break;
    T.runRound(s.st, idleAt(s.st.rounds.length), s.p.faults, s.r); n++;
  } while (untilDone && n < 40);
  app.store.rounds[presetId] = s.st.rounds.length; save();
  return s;
}

// ---------- shell ----------
const NAV = [
  { label: 'Compute', items: [['instance', 'Instances'], ['cluster', 'Instant clusters', true]] },
  { label: 'Inference', chip: 'preview', featured: true, items: [['generate', 'Models'], ['bar-chart', 'Usage']] },
  { label: 'Serverless', items: [['containers-container', 'Containers'], ['batch-jobs', 'Batch jobs']] },
  { label: 'Networking', items: [['private-networks', 'Private networks', false, 'beta']] },
  { label: 'Storage', items: [['block-volume', 'Block volumes'], ['shared-fs', 'Shared filesystems'], ['object-storage', 'Object storage', false, 'beta'], ['container-registry', 'Container registry']] },
  { label: 'Project management', items: [['key', 'Credentials'], ['team', 'Team'], ['billing-dollar', 'Billing'], ['edit-notifications', 'Notification settings'], ['list-alt', 'Audit logs']] },
];
function shell() {
  const nav = NAV.map((g) => {
    const items = g.items.map(([icon, label, active, chip]) => `<li><a href="${active ? '#/health' : 'javascript:void 0'}" class="${active ? 'active' : ''}" ${active ? 'aria-current="page"' : 'aria-disabled="true"'}><span class="l">${ic(icon)}<span class="t">${label}</span></span>${chip ? `<span class="chip">${chip}</span>` : ''}</a></li>`).join('');
    const lab = `<div class="nav-group-label"><span>${g.label}</span>${g.chip ? `<span class="chip">${g.chip}</span>` : ''}</div>`;
    return g.featured ? `<div class="nav-group featured"><div class="band">${lab}</div><ul>${items}</ul></div>` : `<div class="nav-group">${lab}<ul>${items}</ul></div>`;
  }).join('');
  document.body.insertAdjacentHTML('afterbegin', `
  <header class="topbar">
    <a href="#/health" aria-label="Verda console home"><img class="logo" src="assets/verda-logo.svg" alt="verda"></a>
    <div class="topbar-actions">
      <div class="theme-switch" role="group" aria-label="Theme"><span class="on" title="Light">${ic('light-mode')}</span><span title="Dark">${ic('dark-mode')}</span></div>
      <a class="tb-link" href="https://docs.verda.com/clusters/instant-clusters/kubernetes/health-checks/" target="_blank" rel="noopener">${ic('file')}Resources${ic('keyboard-arrow-down')}</a>
      <span class="bell" aria-label="Notifications">${ic('notifications')}<i></i></span>
      <span class="tb-link">${ic('person-outlined')}Demo User${ic('keyboard-arrow-down')}</span>
    </div>
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="Project navigation">
      <div class="sb-header">
        <div class="sb-project"><div><b>Orbit Labs</b><small>infra@orbit-labs.ai</small></div>${ic('keyboard-arrow-down')}</div>
        <div class="sb-balance"><span>Project balance:</span><b>€18,420.55</b></div>
      </div>
      <nav class="nav">${nav}</nav>
    </aside>
    <main class="main" id="main" tabindex="-1"></main>
  </div>`);
}

function pageHeader(tab) {
  const c = app.data;
  const created = new Date(c.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).replace(' at', ',');
  const tabs = [['overview', 'Overview'], ['storage', 'Storage'], ['activity', 'Activity'], ['health', 'Health', 'new']];
  return `
  <ol class="breadcrumbs" aria-label="Breadcrumbs"><li><a href="#/health">Projects</a></li><li><a href="#/health">Orbit Labs</a></li><li><a href="#/health">Instant clusters</a></li><li>${esc(c.hostname)}</li></ol>
  <div class="ph">
    <div>
      <div class="ph-row"><h2>${esc(c.hostname)}</h2><span class="badge model">${ic('nvidia')}${esc(c.model)}</span><span class="badge bg ok">${ic('check-circle')}Running</span></div>
      <div class="ph-meta"><span>Created ${created}</span>${ic('verda-slash')}<span>ID: <span class="copyable">${c.id}<button type="button" data-copy="${c.id}" aria-label="Copy ID">${ic('copy')}</button></span></span></div>
    </div>
    <div class="ph-actions">
      <button class="btn outlined secondary has-start has-end" type="button">${ic('settings')}Actions${ic('keyboard-arrow-down')}</button>
      <button class="btn outlined has-end" type="button" title="Opens Grafana on the cluster">Dashboard${ic('open-new-tab')}</button>
    </div>
  </div>
  <div class="tablist" role="tablist" aria-label="Cluster page tabs">${tabs.map(([id, l, chip]) => `<a class="tab" role="tab" href="#/${id}" aria-selected="${tab === id}">${l}${chip ? ` <span class="chip">${chip}</span>` : ''}</a>`).join('')}</div>`;
}

function subnav(cur) {
  const items = [['health', 'Checks'], ['health/triage', 'Fabric triage'], ['health/method', 'Method & backtest']];
  return `<div class="btn-group" role="navigation" aria-label="Health views" style="margin-bottom:var(--spacing-2xl)">${items.map(([h, l]) => `<a class="btn outlined ${cur === h ? '' : 'secondary'}" href="#/${h}" ${cur === h ? 'aria-current="page" style="background:var(--color-surface-brand)"' : ''}>${l}</a>`).join('')}</div>`;
}

const fmtAgo = (iso) => { const m = Math.round((Date.parse('2026-11-11T06:00:00Z') - Date.parse(iso)) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m ago` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h ago`; };
const resultBadge = (r) => r === 'Healthy' ? `<span class="badge ok">${ic('check-circle')}Healthy</span>` : r === 'Degraded' ? `<span class="badge warn">${ic('warning-filled')}Degraded</span>` : `<span class="badge crit">${ic('error-filled')}${r}</span>`;
const nodeName = (n) => app.cluster.nodes[n].name;
const shortNode = (n) => `-${String(n + 1).padStart(2, '0')}`;
const hcas = (rails) => !rails ? 'all 8' : rails.length === 1 ? T.railName(rails[0]) : `mlx5_${rails[0]}–${rails.at(-1)}`;

// ---------- Health: checks registry ----------
function viewChecks() {
  const p = presetById(app.store.preset);
  const tr = p.trigger;
  const s = sim(p.id);
  const done = s.st.status !== 'running';
  const recheck = app.store.ncclRecheck;
  const rows = app.data.registry.map((r) => r.check === 'inter-node-nccl' && recheck ? { ...r, result: recheck.result, age: 'just now', lastRun: '2026-11-11T06:00:00Z' } : r);
  const alert = recheck && recheck.result === 'Healthy'
    ? `<div class="alert success">${ic('check-circle')}<div class="grow"><b>inter-node-nccl is Healthy again.</b><p>Re-run on ${recheck.nodes} nodes after draining ${recheck.drained.map(nodeName).join(', ')}: ${recheck.y.toFixed(1)} GB/s vs ${recheck.base.toFixed(1)} GB/s baseline (${pct(recheck.y / recheck.base)}).</p></div></div>`
    : `<div class="alert">${ic('warning-filled')}<div class="grow"><b>inter-node-nccl reported Degraded ${fmtAgo(rows.find((r) => r.check === 'inter-node-nccl').lastRun)}</b><p>16-node AllReduce bus bandwidth ${tr.y.toFixed(1)} GB/s vs ${tr.base.toFixed(1)} GB/s baseline (${pct(tr.ratio - 1)}). Intra-node checks are Healthy, so the slowdown is on the InfiniBand fabric. The full-cluster check cannot say which HCA, cable or uplink.</p></div><a class="btn primary has-end" href="#/health/triage">${done ? 'View triage' : 'Localize fault'}${ic('arrow-forward')}</a></div>`;
  return `${subnav('health')}${alert}
  <div class="sec-h"><div><h3>Registered checks</h3><p>One row per check, as in the Grafana “Cluster Active Health Check Overview”. Checks queue behind your jobs and never preempt them.</p></div></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Check</th><th>Scope</th><th>Kind</th><th>Scheduler</th><th>Result</th><th>Freshness</th><th>Age</th><th>Last run</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td class="mono" style="font-size:var(--font-size-xs)">${r.check}</td><td>${r.scope}</td><td>${r.kind}</td><td class="mono" style="font-size:var(--font-size-xs)">${r.scheduler}</td><td>${resultBadge(r.result)}</td><td><span class="badge muted">${r.freshness}</span></td><td>${r.age}</td><td>${new Date(r.lastRun).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}</td><td>${r.check === 'inter-node-nccl' && r.result === 'Degraded' ? `<a class="btn text" href="#/health/triage">Localize</a>` : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- Health: fabric triage ----------
function cellColor(p) {
  const x = Math.min(1, Math.sqrt(p));
  const stops = [[252, 252, 252], [186, 210, 249], [70, 142, 255], [29, 69, 135]];
  const t = x * 3, i = Math.min(2, Math.floor(t)), f = t - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c.join(',')})`;
}

function fabricMap(s) {
  const st = s.st, cl = app.cluster, P = T.marginals(st);
  const pIdx = new Map(st.hyps.map((h, i) => [h.id, i]));
  const tested = new Set();
  st.rounds.forEach((rd) => rd.tests.forEach((t) => T.slotsOf(t).forEach((x) => tested.add(x))));
  const found = new Set(st.findings.map((f) => f.h.id));
  const idle = idleAt(st.rounds.length);
  const N = cl.nodes.length, U = cl.sus;
  const cols = `5.2rem repeat(${N}, minmax(0,1fr))`;
  let h = `<div class="fmap" style="grid-template-columns:${cols}" role="grid" aria-label="Posterior probability by HCA path">`;
  h += `<div></div>`;
  for (let u = 0; u < U; u++) h += `<div class="gh" style="grid-column:${2 + u * cl.suSize}/span ${cl.suSize}">${T.suName(u)}</div>`;
  h += `<div></div>`;
  for (let n = 0; n < N; n++) h += `<div class="ch ${idle.has(n) ? '' : 'busy'}" title="${nodeName(n)}${idle.has(n) ? '' : ' (busy)'}">${String(n + 1).padStart(2, '0')}</div>`;
  const cell = (id, label, n, extra = '') => {
    const i = pIdx.get(id); const p = P[i];
    const drained = n != null && app.store.drained.includes(n);
    const cls = ['cell', n != null && !idle.has(n) ? 'busy' : '', extra, found.has(id) ? 'found' : '', drained ? 'drained' : ''].join(' ');
    return `<button class="${cls}" style="background-color:${cellColor(p)}" data-node="${n ?? ''}" title="${esc(label)}: ${pct(p, 2)}" aria-label="${esc(label)} ${pct(p, 2)}"></button>`;
  };
  for (let r = 0; r < 8; r++) {
    h += `<div class="rl">${T.railName(r)}</div>`;
    for (let n = 0; n < N; n++) h += cell(`path:${n}:${r}`, `${nodeName(n)} · ${T.railName(r)}`, n, tested.has(n * 8 + r) ? 'tested' : '');
  }
  h += `<div class="rl">node-wide</div>`;
  for (let n = 0; n < N; n++) h += cell(`node:${n}`, `${nodeName(n)} · all rails`, n);
  h += `</div><div class="fmap" style="grid-template-columns:5.2rem repeat(${U}, minmax(0,1fr));margin-top:var(--spacing-md)" aria-label="Leaf uplinks">`;
  h += `<div class="rl">uplinks</div>`;
  for (let u = 0; u < U; u++) {
    h += `<div style="display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:2px">`;
    for (let r = 0; r < 8; r++) h += cell(`uplink:${u}:${r}`, `${T.suName(u)} uplinks · rail ${r}`, null);
    h += `</div>`;
  }
  h += `</div><div class="legend"><span>P(fault)</span><span>0<span class="ramp"></span>1</span><span><span class="sw" style="background-image:repeating-linear-gradient(135deg,transparent 0 3px,#ebeff5 3px 4px)"></span>node busy (job running)</span><span><span class="sw" style="position:relative;background:#fcfcfc"><i style="position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px;border-radius:50%;background:#c3c7ce"></i></span>HCA exercised by a test</span><span><span class="sw" style="outline:2px solid #f67d51;outline-offset:-1px"></span>localized</span></div>`;
  return h;
}

function viewTriage(q) {
  if (q.get('preset') && app.data.presets.some((p) => p.id === q.get('preset')) && q.get('preset') !== app.store.preset) { app.store.preset = q.get('preset'); save(); }
  const s = sim(app.store.preset);
  const st = s.st, cl = app.cluster;
  const top = T.topHypotheses(st, 6);
  const nodeMin = st.rounds.reduce((a, rd) => a + rd.tests.reduce((b, t) => b + T.gpuShare(t) * T.TEST_MIN, 0), 0);
  const idleNow = idleAt(st.rounds.length);
  const running = st.status === 'running';
  const preview = running ? T.planRound(st, idleNow) : [];
  const lead = top[0];
  const sevTxt = (i) => { const sv = T.severityPosterior(st, i); return `${pct(sv.mean, 0)} of line rate (90%: ${pct(sv.lo, 0)}–${pct(sv.hi, 0)})`; };
  const kpi = (label, v, sub) => `<div class="card kpi"><label>${label}</label><div class="v">${v}</div><div class="sub">${sub}</div></div>`;
  const statusTxt = { running: 'Localizing', localized: 'Localized', clear: 'No persistent fault', inconclusive: 'Inconclusive' }[st.status];
  const findings = st.findings;
  let verdict = '';
  if (!running) {
    if (st.status === 'clear') verdict = `<div class="alert info">${ic('info-filled')}<div class="grow"><b>No persistent fault: the Degraded run was transient (probability ${prob(T.marginals(st)[0])}).</b><p>Every HCA path, node and leaf uplink tested at baseline after ${st.rounds.length} rounds. Nothing to drain. The next scheduled inter-node-nccl run will confirm.</p></div><button class="btn outlined has-start" data-act="export">${ic('download')}Export evidence</button></div>`;
    else verdict = findings.map((f) => {
      const h = f.h; const drainable = h.kind !== 'uplink'; const drained = drainable && app.store.drained.includes(h.node);
      const requested = app.store.repairs.includes(h.id);
      return `<div class="alert ${drained ? 'success' : ''}" style="${drained ? '' : 'border-color:var(--color-border-warning)'}">${ic(drained ? 'check-circle' : 'warning-filled')}<div class="grow"><b>${esc(T.describe(h, cl))}: ${esc(T.kindLabel(h))} at ${pct(f.sev.mean, 0)} of line rate</b><p>Posterior probability ${prob(f.prob)} after round ${f.round}. 90% interval for bandwidth ${pct(f.sev.lo, 0)}–${pct(f.sev.hi, 0)}. ${h.kind === 'uplink' ? 'Cross-leaf traffic on this rail is throttled; jobs inside one leaf group are unaffected.' : 'Every multi-node job that includes this node runs at this speed.'}</p></div><div class="toolbar">${drainable ? `<button class="btn outlined danger" data-act="drain" data-node="${h.node}" data-h="${h.id}" ${drained ? 'disabled' : ''}>${drained ? 'Drained' : 'Drain node'}</button>` : ''}<button class="btn outlined" data-act="repair" data-h="${h.id}" ${requested ? 'disabled' : ''}>${requested ? 'Repair requested' : 'Request repair'}</button></div></div>`;
    }).join('') + `<div class="toolbar" style="margin:-8px 0 var(--spacing-2xl)"><button class="btn text has-start" data-act="export">${ic('download')}Evidence (JSON)</button><button class="btn text has-start" data-act="csv">${ic('download')}Test log (CSV)</button></div>`;
  }
  const rowsHtml = [];
  rowsHtml.push(`<tr><td>0</td><td>Registry run</td><td>all 16</td><td>all 8</td><td class="num">—</td><td class="num">${st.obs[0].y.toFixed(1)}</td><td>${ratioCell(st.obs[0].y / st.obs[0].base)}</td><td><span class="badge warn">${ic('warning-filled')}Slow</span></td></tr>`);
  st.rounds.forEach((rd, k) => {
    if (!rd.tests.length) rowsHtml.push(`<tr><td>${k + 1}</td><td colspan="7" class="muted">Waiting: no informative test fits the idle nodes this round</td></tr>`);
    rd.tests.forEach((t, j) => rowsHtml.push(`<tr><td>${j ? '' : k + 1}</td><td class="mono" style="font-size:var(--font-size-xs)">all_reduce_perf</td><td>${t.nodes.map(shortNode).join(' ')}</td><td class="mono" style="font-size:var(--font-size-xs)">${hcas(t.rails)}</td><td class="num">${t.gain.toFixed(2)}</td><td class="num">${t.y.toFixed(1)}</td><td>${ratioCell(t.y / t.base)}</td><td>${t.y / t.base < 0.95 ? `<span class="badge warn">${ic('warning-filled')}Slow</span>` : `<span class="badge ok">${ic('check-circle')}Normal</span>`}</td></tr>`));
  });
  preview.forEach((t, j) => rowsHtml.push(`<tr style="background:var(--color-surface-brand)"><td>${j ? '' : st.rounds.length + 1}</td><td class="mono" style="font-size:var(--font-size-xs)">all_reduce_perf</td><td>${t.nodes.map(shortNode).join(' ')}</td><td class="mono" style="font-size:var(--font-size-xs)">${hcas(t.rails)}</td><td class="num">${t.gain.toFixed(2)}</td><td class="num muted">—</td><td class="muted">${T.baseline(t.nodes.length, t.rails).toFixed(1)} GB/s if healthy</td><td><span class="badge info">${ic('info-filled')}Queued</span></td></tr>`));

  return `${subnav('health/triage')}
  <div class="sec-h" style="margin-top:0"><div><h3>Fabric triage</h3><p>Triggered by inter-node-nccl (Degraded, ${pct(st.obs[0].ratio - 1)}). Plans the smallest NCCL runs on idle nodes that best separate the remaining explanations, then updates a Bayesian posterior after every round.</p></div>
    <div class="toolbar"><label class="sr" for="preset">Scenario</label><select id="preset" class="select" aria-label="What-if scenario">${app.data.presets.map((p) => `<option value="${p.id}" ${p.id === app.store.preset ? 'selected' : ''}>Scenario: ${esc(p.label)}</option>`).join('')}</select>
    <button class="btn text has-start" data-act="reset">${ic('restart')}Reset</button>
    <button class="btn outlined" data-act="auto" ${running ? '' : 'disabled'} aria-keyshortcuts="a" title="Shortcut: A">Run to 99%</button>
    <button class="btn primary has-start" data-act="next" ${running ? '' : 'disabled'} aria-keyshortcuts="n" title="Shortcut: N">${ic('play')}Run next round</button></div></div>
  ${verdict}
  <div class="kpis">
    ${kpi('Status', statusTxt, running ? `${preview.length} test${preview.length === 1 ? '' : 's'} queued for round ${st.rounds.length + 1}` : `after ${st.rounds.length} round${st.rounds.length === 1 ? '' : 's'}`)}
    ${kpi('Leading explanation', `${prob(lead.p)}`, esc(lead.h.kind === 'none' ? (findings.length ? 'Nothing beyond the localized fault' : 'Transient (no persistent fault)') : T.describe(lead.h, cl)))}
    ${kpi('Tests run', `${st.rounds.reduce((a, r) => a + r.tests.length, 0)} <small>in ${st.rounds.length} rounds</small>`, `${nodeMin.toFixed(1)} node-minutes of idle capacity`)}
    ${kpi('Idle nodes now', `${idleNow.size}<small> / 16</small>`, app.data.jobs.filter((j) => st.rounds.length < j.untilRound).map((j) => `${j.name} holds ${j.nodes.length}`).join(' · ') || 'All jobs finished')}
  </div>
  <div class="grid2">
    <div class="card"><div class="card-h"><h4>Posterior by component</h4><span class="muted" style="font-size:var(--font-size-xs)">4 leaf groups × 8 rails · click a node for details</span></div><div class="card-b">${fabricMap(s)}</div></div>
    <div class="card"><div class="card-h"><h4>Most likely explanations</h4><span class="muted" style="font-size:var(--font-size-xs)">${findings.length ? `beyond ${findings.length} localized` : 'single-fault model'}</span></div><div class="card-b" style="padding-top:var(--spacing-xs)">
      ${findings.map((f) => `<div class="hyp"><div class="n">${esc(T.describe(f.h, cl))}</div><div class="p" style="color:var(--color-text-success)">${prob(f.prob)}</div><div class="k">Localized · ${esc(T.kindLabel(f.h))} · ${pct(f.sev.mean, 0)} of line rate</div><div class="bar"><i style="width:100%;background:var(--color-green-600)"></i></div></div>`).join('')}
      ${top.map((x) => `<div class="hyp"><div class="n">${esc(x.h.kind === 'none' ? (findings.length ? 'No further fault' : 'No persistent fault (transient)') : T.describe(x.h, cl))}</div><div class="p">${prob(x.p)}</div><div class="k">${x.h.kind === 'none' ? (findings.length ? 'All other paths, nodes and uplinks at baseline' : 'Registry run was slowed by unrelated congestion') : esc(T.kindLabel(x.h)) + ' · ' + sevTxt(x.i)}</div><div class="bar"><i style="width:${(100 * x.p).toFixed(1)}%"></i></div></div>`).join('')}
    </div></div>
  </div>
  <div class="sec-h"><div><h3>Test plan &amp; results</h3><p>Each round runs NCCL all_reduce_perf (1–2 GiB, ~1 min) on disjoint idle (node, HCA) slots. Rail-masked runs pin GPU r to HCA r, so several can share a node. Highlighted rows are queued for the next round.</p></div></div>
  <div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Round</th><th>Test</th><th>Nodes</th><th>HCAs</th><th class="num">Expected info (bits)</th><th class="num">busbw (GB/s)</th><th>vs baseline</th><th>Result</th></tr></thead><tbody>${rowsHtml.join('')}</tbody></table></div>`;
}

function ratioCell(r) {
  return `<span class="ratio"><span class="rb"><i class="${r < 0.95 ? 'slow' : ''}" style="width:${Math.min(100, r * 100).toFixed(0)}%"></i></span>${pct(r, 1)}</span>`;
}

// ---------- Health: node drill-down ----------
function viewNode(n) {
  const s = sim(app.store.preset), st = s.st, cl = app.cluster;
  if (!(n >= 0 && n < cl.nodes.length)) return `<div class="empty"><b>Node not found</b>There is no worker ${esc(n + 1)} in this cluster. <a href="#/health/triage">Back to triage</a></div>`;
  const P = T.marginals(st); const idx = new Map(st.hyps.map((h, i) => [h.id, i]));
  const tests = st.obs.map((o, i) => ({ o, i })).filter(({ o }) => o.nodes.includes(n));
  const drained = app.store.drained.includes(n);
  const job = app.data.jobs.find((j) => j.nodes.includes(n) && st.rounds.length < j.untilRound);
  const rows = Array.from({ length: 8 }, (_, r) => {
    const rel = tests.filter(({ o }) => !o.rails || o.rails.includes(r));
    const ratios = rel.map(({ o }) => o.y / o.base);
    const worst = ratios.length ? Math.min(...ratios) : null;
    const p = P[idx.get(`path:${n}:${r}`)];
    return `<tr><td class="mono">${T.railName(r)}</td><td class="num">${rel.length}</td><td>${worst == null ? '<span class="muted">not tested</span>' : ratioCell(worst)}</td><td class="num">${pct(p, 2)}</td><td>${p > 0.5 ? `<span class="badge bg warn">${ic('warning-filled')}Suspect</span>` : worst != null && worst >= 0.95 ? `<span class="badge ok">${ic('check-circle')}Cleared</span>` : `<span class="badge muted">Unknown</span>`}</td></tr>`;
  }).join('');
  return `${subnav('health/triage')}
  <ol class="breadcrumbs" style="margin-top:-8px"><li><a href="#/health/triage">Fabric triage</a></li><li>${nodeName(n)}</li></ol>
  <div class="sec-h" style="margin-top:0"><div><h3>${ic('instance')}${nodeName(n)}</h3><p>${T.suName(cl.nodes[n].su)} · 8× B200 SXM6 · 8× ConnectX NDR 400 Gbit/s · ${drained ? 'drained' : job ? `running ${job.name} (job ${job.id})` : 'idle'}</p></div>
  <div class="toolbar">${drained ? `<span class="badge bg muted">Drained</span>` : `<button class="btn outlined danger" data-act="drain" data-node="${n}">Drain node</button>`}</div></div>
  <div class="two">
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>HCA</th><th class="num">Tests</th><th>Worst run</th><th class="num">P(fault)</th><th>Status</th></tr></thead><tbody>${rows}
    <tr><td>node-wide</td><td class="num">${tests.length}</td><td></td><td class="num">${pct(P[idx.get(`node:${n}`)], 2)}</td><td></td></tr></tbody></table></div>
    <div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Run</th><th>With</th><th>HCAs</th><th class="num">busbw</th><th>vs baseline</th></tr></thead><tbody>
    ${tests.length ? tests.map(({ o, i }) => `<tr><td>${o.kind === 'trigger' ? 'registry' : '#' + i}</td><td>${o.nodes.length > 4 ? 'all 16' : o.nodes.filter((m) => m !== n).map(shortNode).join(' ')}</td><td class="mono" style="font-size:var(--font-size-xs)">${hcas(o.rails)}</td><td class="num">${o.y.toFixed(1)}</td><td>${ratioCell(o.y / o.base)}</td></tr>`).join('') : `<tr><td colspan="5" class="muted">No tests have used this node yet.</td></tr>`}
    </tbody></table></div>
  </div>`;
}

// ---------- Health: method & backtest ----------
function viewMethod() {
  const R = app.results;
  const names = { adaptive: 'Fabric triage (this feature)', bisection: 'Threshold bisection', pairwise: 'All-pairs sweep' };
  const tbl = (set, title, note) => `<div class="sec-h"><div><h3>${title}</h3><p>${note}</p></div></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Method</th><th class="num">Exact component</th><th class="num">Right node or leaf</th><th class="num">Rounds p50</th><th class="num">Rounds p90</th><th class="num">Node-min p50</th><th class="num">Silent faults</th><th class="num">Leaf uplinks</th></tr></thead><tbody>${Object.entries(set).map(([m, v]) => `<tr class="${m === 'adaptive' ? 'sel' : ''}"><td>${names[m]}</td><td class="num"><b>${pct(v.exact)}</b></td><td class="num">${pct(v.node)}</td><td class="num">${v.roundsMedian}</td><td class="num">${v.roundsP90.toFixed(0)}</td><td class="num">${v.nodeMinMedian.toFixed(1)}</td><td class="num">${pct(v.byKind.silent.exact)}</td><td class="num">${pct(v.byKind.uplink.exact)}</td></tr>`).join('')}</tbody></table></div>`;
  const a = R.idle.adaptive;
  return `${subnav('health/method')}
  <div class="two how">
    <div class="card"><div class="card-h"><h4>How it works</h4></div><div class="card-b"><ol>
      <li><b>Hypotheses.</b> One degraded HCA/cable path per (node, rail): 128; node-wide faults: 16; leaf-uplink faults per (leaf group, rail): 32; or a transient false alarm. Severity is a free parameter (40–97% of line rate) with a bump at 50% for links that trained at half rate.</li>
      <li><b>Measurement model.</b> A ring/tree collective runs at the speed of its slowest participating path, so busbw = baseline × min(severity of affected faults) × noise (Student-t, 1.2% all rails / 1.8% one rail) with a 3% chance of unrelated transient congestion.</li>
      <li><b>Planner.</b> Each round greedily packs tests onto idle (node, HCA) slots to maximise the entropy of the predicted outcome pattern (expected information about which component is faulty), with a small node-minute cost. Busy nodes are never touched.</li>
      <li><b>Stop rule.</b> Confirm a component at ≥99% posterior, add it to the known faults, and keep testing until “nothing else is wrong” also reaches 99%. This handles two faults at once.</li>
    </ol></div></div>
    <div class="card"><div class="card-h"><h4>Headline</h4><button class="btn text has-start" data-act="bt-csv">${ic('download')}Backtest CSV</button></div><div class="card-b">
      <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr));margin:0">
        <div class="card kpi"><label>Exact component, idle cluster</label><div class="v">${pct(a.exact)}</div><div class="sub">${R.scenarios.idle.toLocaleString()} simulated incidents</div></div>
        <div class="card kpi"><label>Median rounds</label><div class="v">${a.roundsMedian} <small>vs ${R.idle.bisection.roundsMedian} bisection</small></div><div class="sub">p90 ${a.roundsP90.toFixed(0)} rounds of ~1 min</div></div>
        <div class="card kpi"><label>Right when it says 99%</label><div class="v">${pct(a.exactWhenConfident)}</div><div class="sub">calibration of the stop rule</div></div>
        <div class="card kpi"><label>With 8% flaky runs</label><div class="v">${pct(R.flaky.adaptive.exact)}</div><div class="sub">model still assumes 3%</div></div>
      </div></div></div>
  </div>
  ${tbl(R.idle, 'Backtest: idle cluster', `${R.scenarios.idle.toLocaleString()} random incidents that tripped the 0.95 registry threshold: 61% HCA paths, 17% node-wide, 22% leaf uplinks, 10% transient false alarms, 6% two faults. Same seeds and noise for every method. Silent faults = 6–15% slower than line rate.`)}
  ${tbl(R.busy, 'Backtest: busy cluster (half the nodes held by jobs)', `${R.scenarios.busy.toLocaleString()} incidents; jobs re-shuffle about every 3 rounds. Fixed plans must wait for their exact nodes; results counted within 60 rounds.`)}
  <p class="foot">Baselines: <b>threshold bisection</b> follows topology-aware halving with a fixed pass/fail ratio (0.93), confirmation pairs, cross-leaf probing and HCA halving, like NVIDIA Cluster Readiness Engine’s diagnose mode and common runbooks. <b>All-pairs sweep</b> runs every node pair (round-robin) plus per-HCA tests on the worst node, decoded with the same Bayesian posterior. Simulated fabric; numbers come from <span class="mono">data/results.json</span> generated by <span class="mono">scripts/generate.mjs</span>.</p>`;
}

// ---------- other cluster tabs ----------
function viewOverview() {
  const st = sim(app.store.preset).st;
  return `<div class="sec-h" style="margin-top:0"><div><h3>Worker nodes</h3><p>${esc(app.data.orchestrator)} · ${app.data.location} · ${app.data.fabric.hcasPerNode}× ${app.data.fabric.hcaGbit} Gbit/s InfiniBand per node, rail-optimized</p></div></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Hostname</th><th>Leaf group</th><th>GPUs</th><th>Slurm state</th><th>Job</th></tr></thead><tbody>
  ${app.cluster.nodes.map((n) => { const d = app.store.drained.includes(n.id); const j = app.data.jobs.find((x) => x.nodes.includes(n.id) && st.rounds.length < x.untilRound); return `<tr class="click" data-href="#/health/node/${n.id + 1}"><td><a href="#/health/node/${n.id + 1}">${n.name}</a></td><td class="mono" style="font-size:var(--font-size-xs)">${T.suName(n.su)}</td><td>8× B200</td><td>${d ? `<span class="badge bg muted">drain</span>` : j ? `<span class="badge bg info">allocated</span>` : `<span class="badge bg ok">idle</span>`}</td><td>${j ? `${j.name} <span class="muted">#${j.id}</span>` : '<span class="muted">—</span>'}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}
function viewStorage() {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Mounted at</th></tr></thead><tbody>
  <tr><td>orbit-pretrain-sfs</td><td>Shared filesystem</td><td>30 TB</td><td class="mono" style="font-size:var(--font-size-xs)">/home</td></tr>
  <tr><td>local NVMe (per worker)</td><td>Local storage</td><td>28 TB</td><td class="mono" style="font-size:var(--font-size-xs)">/mnt/local_disk</td></tr></tbody></table></div>`;
}
function viewActivity() {
  const base = [
    { t: '2026-11-11T05:22:00Z', e: 'Health check degraded', c: 'warn', who: 'inter-node-nccl', res: 'Cluster' },
    { t: '2026-10-28T09:31:00Z', e: 'Cluster validated', c: 'ok', who: 'Verda', res: 'Cluster' },
    { t: '2026-10-28T09:12:00Z', e: 'Cluster created', c: 'ok', who: 'Demo User', res: 'Cluster' },
  ];
  const all = [...app.store.activity, ...base];
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Event</th><th>Resource</th><th>Actor</th></tr></thead><tbody>
  ${all.map((a) => `<tr><td>${new Date(a.t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' })}</td><td><span class="badge ${a.c}">${ic(a.c === 'ok' ? 'check-circle' : a.c === 'warn' ? 'warning-filled' : 'info-filled')}${esc(a.e)}</span></td><td>${esc(a.res)}</td><td>${esc(a.who)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- actions ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  document.body.insertAdjacentHTML('beforeend', `<div class="toast" role="status">${ic('check-circle')}${esc(msg)}</div>`);
  setTimeout(() => document.querySelectorAll('.toast').forEach((t) => t.remove()), 3200);
}
function dialog(title, body, pre, confirmLabel, danger, onOk) {
  document.body.insertAdjacentHTML('beforeend', `<div class="dlg-back"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><h3 id="dlg-t">${esc(title)}</h3><p>${body}</p>${pre ? `<pre>${esc(pre)}</pre>` : ''}<div class="row"><button class="btn outlined secondary" data-dlg="cancel">Cancel</button><button class="btn ${danger ? 'primary' : 'primary'}" style="${danger ? 'background:var(--color-red-600);border-color:var(--color-red-600)' : ''}" data-dlg="ok">${esc(confirmLabel)}</button></div></div></div>`);
  const back = $('.dlg-back');
  const close = () => back.remove();
  back.addEventListener('click', (e) => { const b = e.target.closest('[data-dlg]'); if (e.target === back || (b && b.dataset.dlg === 'cancel')) close(); if (b && b.dataset.dlg === 'ok') { close(); onOk(); } });
  back.querySelector('[data-dlg=ok]').focus();
}
const stamp = () => new Date(Date.parse('2026-11-11T06:00:00Z') + (app.store.activity.length + 1) * 61000).toISOString();

function recheckNccl() {
  const p = presetById(app.store.preset);
  const nodes = app.cluster.nodes.map((n) => n.id).filter((n) => !app.store.drained.includes(n));
  const remaining = p.faults.filter((f) => !(f.h.kind !== 'uplink' && app.store.drained.includes(f.h.node)));
  const t = { nodes, rails: null };
  const r = T.rng(p.seed * 31 + app.store.drained.length);
  const m = T.measure(t, remaining, app.cluster, r, { transientRate: 0 });
  app.store.ncclRecheck = { result: m.ratio >= T.DEGRADED_RATIO ? 'Healthy' : 'Degraded', y: m.y, base: m.base, nodes: nodes.length, drained: [...app.store.drained] };
  app.store.activity.unshift({ t: stamp(), e: `inter-node-nccl ${app.store.ncclRecheck.result.toLowerCase()} on ${nodes.length} nodes`, c: m.ratio >= T.DEGRADED_RATIO ? 'ok' : 'warn', who: 'inter-node-nccl', res: 'Cluster' });
}

function onAction(btn) {
  const act = btn.dataset.act;
  const p = app.store.preset;
  if (act === 'next') { step(p, false); render(); }
  else if (act === 'auto') { step(p, true); render(); }
  else if (act === 'reset') { app.store.rounds[p] = 0; delete app.sims[p]; app.store.drained = []; app.store.repairs = []; app.store.ncclRecheck = null; save(); render(); }
  else if (act === 'export') download(`fabric-triage-${p}.json`, JSON.stringify(T.evidence(sim(p).st), null, 2), 'application/json');
  else if (act === 'csv') download(`fabric-triage-${p}.csv`, T.toCSV(sim(p).st), 'text/csv');
  else if (act === 'bt-csv') {
    const rows = [['setting', 'method', 'scenarios', 'exact', 'node_or_leaf', 'rounds_median', 'rounds_p90', 'node_minutes_median']];
    for (const k of ['idle', 'busy', 'flaky']) for (const [m, v] of Object.entries(app.results[k])) rows.push([k, m, v.n, v.exact.toFixed(4), v.node.toFixed(4), v.roundsMedian, v.roundsP90, v.nodeMinMedian]);
    download('fabric-triage-backtest.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
  } else if (act === 'drain') {
    const n = +btn.dataset.node; const f = sim(p).st.findings.find((x) => x.h.node === n);
    const reason = f ? `fabric-triage: ${T.describe(f.h, app.cluster)} at ${(f.sev.mean * 100).toFixed(0)}% line rate, p=${f.prob.toFixed(3)}` : 'fabric-triage: manual drain';
    dialog(`Drain ${nodeName(n)}?`, 'Running jobs finish; Slurm stops scheduling new work on this node. You can resume it from the jump host at any time.', `scontrol update NodeName=${nodeName(n)} State=DRAIN Reason="${reason}"`, 'Drain node', true, () => {
      if (!app.store.drained.includes(n)) app.store.drained.push(n);
      app.store.activity.unshift({ t: stamp(), e: `Node drained: ${nodeName(n)}`, c: 'info', who: 'Demo User', res: 'Cluster node' });
      recheckNccl(); save(); render(); toast(`${nodeName(n)} drained. inter-node-nccl re-run: ${app.store.ncclRecheck.result}.`);
    });
  } else if (act === 'repair') {
    const id = btn.dataset.h; const st = sim(p).st; const f = st.findings.find((x) => x.h.id === id);
    dialog('Request repair from Verda', 'Sends the localized component, posterior and every test result to Verda support, so the on-site team can reseat or replace the part.', `${T.describe(f.h, app.cluster)}\nkind: ${T.kindLabel(f.h)}\nP = ${f.prob.toFixed(4)}, bandwidth ${(f.sev.mean * 100).toFixed(0)}% (90%: ${(f.sev.lo * 100).toFixed(0)}–${(f.sev.hi * 100).toFixed(0)}%)\n${st.obs.length} NCCL runs attached`, 'Send request', false, () => {
      app.store.repairs.push(id);
      app.store.activity.unshift({ t: stamp(), e: `Repair requested: ${T.describe(f.h, app.cluster)}`, c: 'info', who: 'Demo User', res: 'Support ticket' });
      save(); render(); toast('Repair request sent with evidence attached.');
    });
  }
}

// ---------- router ----------
function render() {
  const main = $('#main');
  const [path, qs] = (location.hash.slice(2) || 'health').split('?');
  const q = new URLSearchParams(qs || '');
  const parts = path.split('/');
  const tab = ['overview', 'storage', 'activity'].includes(parts[0]) ? parts[0] : 'health';
  let body;
  try {
    if (tab === 'overview') body = viewOverview();
    else if (tab === 'storage') body = viewStorage();
    else if (tab === 'activity') body = viewActivity();
    else if (parts[1] === 'triage') body = viewTriage(q);
    else if (parts[1] === 'node') body = viewNode(+parts[2] - 1);
    else if (parts[1] === 'method') body = viewMethod();
    else body = viewChecks();
  } catch (e) {
    console.error(e);
    body = `<div class="empty"><b>Something went wrong</b>${esc(e.message)}</div>`;
  }
  main.innerHTML = pageHeader(tab) + body + `<p class="foot">Unofficial concept demo by Mohith Gajjela. Not affiliated with Verda. Synthetic data: simulated 16-node B200 cluster and fabric; NCCL results are drawn from a seeded fault model. <a href="https://github.com/Mohith26/verda-fabric-triage">Source</a></p>`;
  document.title = `${app.data.hostname} · ${tab === 'health' ? 'Health' : tab[0].toUpperCase() + tab.slice(1)} · Verda`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (b && !b.disabled) { onAction(b); return; }
  const c = e.target.closest('[data-copy]'); if (c) { navigator.clipboard?.writeText(c.dataset.copy).catch(() => {}); toast('ID copied'); return; }
  const cell = e.target.closest('.cell'); if (cell && cell.dataset.node !== '') { location.hash = `#/health/node/${+cell.dataset.node + 1}`; return; }
  const tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('a')) location.hash = tr.dataset.href;
});
document.addEventListener('change', (e) => { if (e.target.id === 'preset') { location.hash = `#/health/triage?preset=${e.target.value}`; } });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey || $('.dlg-back')) { if (e.key === 'Escape') $('.dlg-back')?.remove(); return; }
  if (!location.hash.includes('triage')) return;
  if (e.key === 'n') $('[data-act=next]:not([disabled])')?.click();
  if (e.key === 'a') $('[data-act=auto]:not([disabled])')?.click();
});
window.addEventListener('hashchange', () => { render(); $('#main')?.focus({ preventScroll: true }); window.scrollTo(0, 0); });

async function boot() {
  shell();
  $('#main').innerHTML = `<div class="skel" style="height:1rem;width:18rem;margin-bottom:1.5rem"></div><div class="skel" style="height:2.5rem;width:24rem;margin-bottom:2rem"></div><div class="skel" style="height:22rem"></div>`;
  try {
    const [d, r] = await Promise.all([fetch('data/cluster.json').then((x) => x.json()), fetch('data/results.json').then((x) => x.json())]);
    app.data = d; app.results = r; app.store = loadStore();
    app.cluster = T.makeCluster({ hostname: d.hostname, nodes: d.nodes.length, suSize: d.fabric.nodesPerLeaf });
    render();
  } catch (e) {
    console.error(e);
    $('#main').innerHTML = `<div class="empty"><b>Could not load cluster data</b>${esc(e.message)}. Serve this folder over HTTP (for example <span class="mono">python3 -m http.server</span>).</div>`;
  }
}
boot();
