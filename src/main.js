// Main window: Mixer (devices, apps with native + mirror routing), Routing graph, Settings.
const devicesEl = document.getElementById('devices');
const appsEl = document.getElementById('apps');
const devRows = new Map();
const appRows = new Map();
let lastState = { devices: [], apps: [] };

// ---------- storage helpers ----------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------- settings ----------
const settings = Object.assign({ closeToTray: true, remember: true, onTop: false, delay: 30, viewMode: 'cards' }, load('svm.settings.v1', {}));
const saveSettings = () => save('svm.settings.v1', settings);

// ---------- custom title bar ----------
const win = TAURI && TAURI.window.getCurrentWindow();
document.getElementById('wc-min').onclick = () => win && win.minimize();
document.getElementById('wc-max').onclick = () => win && win.toggleMaximize();
document.getElementById('wc-close').onclick = () => {
  if (!TAURI) return;
  if (settings.closeToTray) win.hide(); // keeps running in the tray
  else TAURI.core.invoke('quit_app');
};
const syncCloseMode = () => TAURI && TAURI.core.invoke('set_close_to_tray', { enabled: settings.closeToTray }).catch(() => {});
syncCloseMode();
if (win && settings.onTop) win.setAlwaysOnTop(true).catch(() => {});

// ---------- tabs ----------
let activeTab = 'mixer';
document.querySelectorAll('#tabs .tab').forEach((t) => {
  t.onclick = () => {
    activeTab = t.dataset.v;
    document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.toggle('on', x === t));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + activeTab));
    if (activeTab === 'routing') renderGraph(true);
    if (activeTab === 'eq' && lastState) renderEq(lastState);
  };
});

// ---------- remembered mirrors ----------
const SAVE_KEY = 'svm.mirrors.v1';
function persist(a, mirrors) {
  if (!settings.remember) return;
  const s = load(SAVE_KEY, {});
  if (mirrors.length) s[a.name + '|' + a.sub] = mirrors; else delete s[a.name + '|' + a.sub];
  save(SAVE_KEY, s);
}
const restored = new Set();

function setMirrors(a, mirrors) {
  persist(a, mirrors);
  return guard(api.setMirrors(a.pid, mirrors));
}
const mirrorList = (a) => a.mirrors.map((m) => ({ device_id: m.device_id, volume: m.volume, delay_ms: m.delay_ms }));

// ---------- routing actions (shared by chips and the graph) ----------
async function makeNative(a, devId) {
  if (a.device_id === devId) return;
  const next = mirrorList(a).filter((m) => m.device_id !== devId);
  next.push({ device_id: a.device_id, volume: 1, delay_ms: 0 });
  await guard(api.setRoute(a.id, devId));
  setMirrors(a, next);
}
function toggleMirror(a, devId) {
  const list = mirrorList(a);
  if (a.device_id === devId) return toast('This is where the app plays natively. Make another output native with its ★ first.');
  if (list.some((m) => m.device_id === devId)) setMirrors(a, list.filter((m) => m.device_id !== devId));
  else setMirrors(a, [...list, { device_id: devId, volume: 1, delay_ms: settings.delay }]);
}

// ---------- app selection (used by the routing graph) ----------
let selectedKey = null;
const keyOf = (a) => (a.pid ? 'p' + a.pid : a.id);
const selApp = () => lastState.apps.find((a) => keyOf(a) === selectedKey);
function select(a) {
  selectedKey = selectedKey === keyOf(a) ? null : keyOf(a);
  for (const o of appRows.values()) o.el.classList.toggle('selected', o.key === selectedKey);
  const s = selApp();
  renderGraph(true);
}

// ---------- devices ----------
function makeDevice(d) {
  const el = document.createElement('div');
  el.className = 'dev';
  el.innerHTML = `<div class="row"><div class="ico"></div><div style="min-width:0"><div class="nm"></div><div class="sub"></div></div><div class="tags"><span class="badge" hidden>DEFAULT</span><span class="tag" hidden></span></div></div>`;
  const row = document.createElement('div');
  row.className = 'row';
  const big = document.createElement('div');
  big.className = 'big';
  const slider = makeSlider((v) => { big.innerHTML = Math.round(v * 100) + '<small>%</small>'; guard(api.setVolume(d.id, v)); });
  const mute = document.createElement('button');
  mute.className = 'mbtn mute';
  mute.textContent = '🔇';
  mute.onclick = () => { const m = !mute.classList.contains('act'); mute.classList.toggle('act', m); guard(api.setMute(d.id, m)); };
  row.append(big, slider.el, mute);
  const meter = makeMeter();
  el.append(row, meter.el);
  devicesEl.append(el);
  return { el, big, slider, mute, meter, ico: el.querySelector('.ico'), nm: el.querySelector('.nm'), sub: el.querySelector('.sub'), badge: el.querySelector('.badge'), tag: el.querySelector('.tag') };
}

// ---------- apps ----------
function makeApp() {
  const el = document.createElement('div');
  el.className = 'app';
  const top = document.createElement('div');
  top.className = 'top';
  top.innerHTML = `<div class="id" title="Click to select this app (for the routing graph)"><div class="logo2"></div><div style="min-width:0"><div class="nm"></div><div class="sub"></div></div></div>`;
  const ctl = document.createElement('div');
  ctl.className = 'ctl';
  const l1 = document.createElement('div');
  l1.className = 'l1';
  const pct = document.createElement('div');
  pct.className = 'pct';
  const o = { el, pct, open: false, sig: '', app: null, key: '' };
  o.slider = makeSlider((v) => { pct.textContent = Math.round(v * 100) + '%'; guard(api.setVolume(o.app.id, v)); });
  const mute = document.createElement('button');
  mute.className = 'mbtn mute';
  mute.textContent = '🔇';
  mute.onclick = () => { const m = !el.classList.contains('muted'); el.classList.toggle('muted', m); mute.classList.toggle('act', m); guard(api.setMute(o.app.id, m)); };
  const solo = document.createElement('button');
  solo.className = 'mbtn solo';
  solo.textContent = 'S';
  solo.title = 'Solo: mute the other apps on this output';
  solo.onclick = () => toggleSolo(o.app);
  o.solo = solo;
  l1.append(o.slider.el, pct, mute, solo);
  o.meter = makeMeter();
  ctl.append(l1, o.meter.el);
  top.append(ctl);
  o.routes = document.createElement('div');
  o.routes.className = 'routes';
  o.fine = document.createElement('div');
  o.fine.className = 'fine';
  el.append(top, o.routes, o.fine);
  top.querySelector('.id').onclick = () => select(o.app);
  appsEl.append(el);
  Object.assign(o, { mute, logo: el.querySelector('.logo2'), nm: el.querySelector('.nm'), sub: el.querySelector('.sub') });
  return o;
}

function rebuildRoutes(o, a, devices) {
  const byId = Object.fromEntries(devices.map((d) => [d.id, d]));
  const isMirror = (id) => a.mirrors.some((m) => m.device_id === id);
  o.routes.innerHTML = '<span class="lbl">Output</span>';
  devices.forEach((d) => {
    const native = d.id === a.device_id;
    const mir = isMirror(d.id);
    const chip = document.createElement('div');
    chip.className = 'chip' + (native || mir ? ' on' : '') + (native ? ' pri' : '') + (mir ? ' mir' : '');
    chip.innerHTML = `${deviceIcon(d.name + ' ' + d.sub)} ${d.name}<span class="star" title="Play natively here (lowest latency)">★</span>`;
    chip.onclick = (e) => {
      const cur = o.app; // latest state of this stream
      if (e.target.classList.contains('star')) makeNative(cur, d.id);
      else toggleMirror(cur, d.id);
    };
    o.routes.append(chip);
  });
  const ex = document.createElement('div');
  ex.className = 'exp';
  ex.textContent = o.open ? 'Fine tune ▴' : 'Fine tune ▾';
  ex.onclick = () => { o.open = !o.open; o.el.classList.toggle('open', o.open); ex.textContent = o.open ? 'Fine tune ▴' : 'Fine tune ▾'; };
  o.routes.append(ex);

  o.fine.innerHTML = '';
  if (!a.mirrors.length) o.fine.innerHTML = '<div class="sub">No mirrored outputs. Click another output above to play this app there too.</div>';
  a.mirrors.forEach((m) => {
    const d = byId[m.device_id];
    if (!d) return;
    const row = document.createElement('div');
    row.className = 'fl';
    row.innerHTML = `<div>${deviceIcon(d.name + ' ' + d.sub)} ${d.name}</div>`;
    let cur = { ...m };
    const send = () => {
      const app = o.app;
      const list = mirrorList(app).map((x) => (x.device_id === cur.device_id ? cur : x));
      app.mirrors = list;
      setMirrors(app, list);
    };
    const p = document.createElement('span');
    p.style.textAlign = 'right';
    p.textContent = Math.round(m.volume * 100) + '%';
    const sl = makeSlider((v) => { cur.volume = v; p.textContent = Math.round(v * 100) + '%'; send(); });
    sl.set(m.volume);
    const stp = document.createElement('div');
    stp.className = 'stp';
    stp.innerHTML = `<span>−</span><b>${m.delay_ms} ms</b><span>+</span>`;
    const [minus, plus] = stp.querySelectorAll('span');
    const b = stp.querySelector('b');
    const bump = (dlt) => { cur.delay_ms = Math.max(0, Math.min(1000, cur.delay_ms + dlt)); b.textContent = cur.delay_ms + ' ms'; send(); };
    minus.onclick = () => bump(-5);
    plus.onclick = () => bump(5);
    row.append(sl.el, p, stp);
    o.fine.append(row);
  });
}

function sync(map, items, make) {
  const seen = new Set();
  items.forEach((it) => { seen.add(it.id); if (!map.has(it.id)) map.set(it.id, make(it)); });
  for (const [id, o] of map) if (!seen.has(id)) { o.el.remove(); map.delete(id); }
}

// ---------- equalizer (10-band) + take-over ----------
const EQ_FREQS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  Loudness: [5, 3, 0, -1, -1, 0, 0, 2, 4, 3],
  Rock: [4, 3, 2, -1, -2, -1, 2, 3, 4, 4],
  Electronic: [4, 3, 0, -2, -1, 1, 0, 3, 4, 3],
};
const EQ_KEY = 'svm.eq.v1';
const restoredEq = new Set();

function saveEq(a, p) {
  if (!settings.remember) return;
  const s = load(EQ_KEY, {});
  s[a.name + '|' + a.sub] = { enabled: p.enabled, preamp: p.preamp, gains: p.gains };
  save(EQ_KEY, s);
}

// An output nothing else uses: the app is parked there (muted) while an equalised copy plays on its own output.
function pickPark(a, prefer) {
  if (!lastState) return '';
  const busy = new Set();
  lastState.apps.forEach((x) => {
    if (x.id === a.id) return;
    busy.add(x.device_id);
    x.mirrors.forEach((mm) => busy.add(mm.device_id));
    if (x.takeover) busy.add(x.takeover.park_device);
  });
  busy.add(a.device_id);
  a.mirrors.forEach((mm) => busy.add(mm.device_id));
  const free = lastState.devices.filter((d) => !busy.has(d.id));
  const pick = (id) => free.find((d) => d.id === id);
  return (pick(prefer) || pick(settings.parkDevice) || free.find((d) => !d.is_default) || free[0] || {}).id || '';
}
function autoTakeover(a, on, prefer) {
  if (!a || !a.pid) return;
  if (on && !a.takeover) {
    const id = pickPark(a, prefer);
    if (!id) return toast('No spare output to park this app on. The equalizer needs an output nothing else uses.');
    settings.parkDevice = id; saveSettings();
    guard(api.setTakeover(a.pid, a.id, id, true));
  } else if (!on && a.takeover) guard(api.setTakeover(a.pid, a.id, '', false));
}

function makeEqPanel(o) {
  const el = document.createElement('div');
  el.className = 'eqpanel';
  const p = { el, enabled: false, preamp: 0, gains: Array(10).fill(0), localUntil: 0, sig: '' };

  const head = document.createElement('div');
  head.className = 'eqhead';
  const tg = document.createElement('span');
  tg.className = 'tg';
  const tgl = document.createElement('span');
  tgl.className = 'eqlbl';
  tgl.textContent = 'Equalizer';
  const preset = { value: 'Custom' };
  const preLbl = document.createElement('span');
  preLbl.className = 'sub';
  preLbl.textContent = 'Preamp';
  const pre = makeSlider(() => {});
  pre.input.min = -12; pre.input.max = 12; pre.input.step = 0.5;
  const preVal = document.createElement('span');
  preVal.className = 'eqval';
  const reset = document.createElement('button');
  reset.className = 'eqreset';
  reset.textContent = 'Reset';
  const sp0 = document.createElement('span');
  sp0.style.flex = '1';
  head.append(tg, tgl, sp0, preLbl, pre.el, preVal, reset);
  const chips = document.createElement('div');
  chips.className = 'eqchips';
  const chipEls = {};
  Object.keys(EQ_PRESETS).forEach((n) => {
    const c = document.createElement('button');
    c.className = 'eqchip';
    c.textContent = n;
    c.onclick = () => { preset.value = n; p.gains = [...EQ_PRESETS[n]]; p.enabled = true; touch(); };
    chipEls[n] = c;
    chips.append(c);
  });
  const curve = document.createElement('div');
  curve.className = 'eqcurve';
  curve.innerHTML = '<svg viewBox="0 0 640 110" preserveAspectRatio="none" role="img" aria-label="Frequency response"><line x1="0" y1="55" x2="640" y2="55" class="z"/><line x1="0" y1="18" x2="640" y2="18" class="g"/><line x1="0" y1="92" x2="640" y2="92" class="g"/><text x="4" y="14">+12</text><text x="4" y="52">0</text><text x="4" y="106">-12</text><path class="fill"/><path class="line"/></svg>';
  const curveFill = curve.querySelector('.fill');
  const curveLine = curve.querySelector('.line');

  const bands = document.createElement('div');
  bands.className = 'eqbands';
  const sl = [], vals = [];
  EQ_FREQS.forEach((f, i) => {
    const col = document.createElement('div');
    col.className = 'eqband';
    const v = document.createElement('div');
    v.className = 'eqval';
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = -12; inp.max = 12; inp.step = 0.5; inp.value = 0;
    inp.className = 'eqs';
    const lb = document.createElement('div');
    lb.className = 'sub';
    lb.textContent = f;
    col.append(v, inp, lb);
    bands.append(col);
    sl.push(inp); vals.push(v);
    inp.oninput = () => { p.gains[i] = +inp.value; preset.value = 'Custom'; if (!p.enabled) p.enabled = true; touch(); };
    inp.ondblclick = () => { inp.value = 0; p.gains[i] = 0; touch(); };
  });

  const take = document.createElement('div');
  take.className = 'eqtake';
  const ttg = document.createElement('span');
  ttg.className = 'tg';
  const tinfo = document.createElement('div');
  tinfo.style.flex = '1';
  tinfo.innerHTML = '<div class="nm">Main output <span class="eqpill"></span></div><div class="sub tstat"></div>';
  const park = document.createElement('select');
  park.className = 'eqsel';
  park.title = 'Silent output';
  take.append(tinfo, document.createElement('span'), park);
  enhanceSelect(park);
  take.children[1].className = 'sub';
  take.children[1].textContent = 'Silent output';
  const note = document.createElement('div');
  note.className = 'sub eqnote';
  el.append(head, chips, curve, bands, take, note);

  let timer;
  function paint() {
    tg.classList.toggle('on', p.enabled);
    sl.forEach((s, i) => { s.value = p.gains[i]; s.style.setProperty('--v', ((p.gains[i] + 12) / 24) * 100 + '%'); vals[i].textContent = (p.gains[i] > 0 ? '+' : '') + p.gains[i]; });
    pre.input.value = p.preamp; preVal.textContent = (p.preamp > 0 ? '+' : '') + p.preamp + ' dB';
    el.classList.toggle('off', !p.enabled);
    Object.entries(chipEls).forEach(([n, c]) => c.classList.toggle('on', EQ_PRESETS[n].every((x, i) => x === p.gains[i])));
    const pts = p.gains.map((g, i) => [32 + (i * 576) / 9, 55 - g * (37 / 12)]);
    let d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + ' ' + p2[0] + ' ' + p2[1];
    }
    curveLine.setAttribute('d', d);
    curveFill.setAttribute('d', d + ' L' + pts[9][0] + ' 110 L' + pts[0][0] + ' 110Z');
  }
  reset.onclick = () => { p.gains = Array(10).fill(0); p.preamp = 0; preset.value = 'Flat'; touch(); };
  function touch() {
    p.localUntil = Date.now() + 900;
    paint();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const a = o.app;
      if (!a || !a.pid) return;
      guard(api.setEq(a.pid, p.enabled, p.preamp, p.gains));
      saveEq(a, p);
      const want = p.enabled || dynPanel.on();
      if (!want || Date.now() > (p.takeBusy || 0)) { p.takeBusy = Date.now() + 2500; autoTakeover(a, want, park.value); }
    }, 40);
  }
  tg.onclick = () => { p.enabled = !p.enabled; touch(); };
  pre.input.oninput = () => { p.preamp = +pre.input.value; touch(); };
  p.update = (a, devices) => {
    if (Date.now() > p.localUntil && a.eq) {
      p.enabled = a.eq.enabled; p.preamp = a.eq.preamp; p.gains = [...a.eq.gains];
      const m = Object.entries(EQ_PRESETS).find(([, g]) => g.every((x, i) => x === p.gains[i]));
      preset.value = m ? m[0] : 'Custom';
      paint();
    } else if (!a.eq && !p.sig) paint();
    const byId = Object.fromEntries(devices.map((d) => [d.id, d]));
    const tstat = take.querySelector('.tstat');
    const pill = take.querySelector('.eqpill');
    pill.textContent = a.takeover ? 'Active' : p.enabled ? 'Starting…' : 'Off';
    pill.classList.toggle('on', !!a.takeover);
    if (a.takeover) {
      const o2 = byId[a.takeover.orig_device], pk = byId[a.takeover.park_device];
      tstat.textContent = `Playing through the EQ on ${o2 ? o2.name : '?'}; the app itself is parked on ${pk ? pk.name : '?'} (muted).`;
    } else tstat.textContent = 'Automatic: when the equalizer is on, the app is parked on an unused output (muted) and an equalised copy plays on its normal output. Adds a little delay.';
    const nativeId = a.takeover ? a.takeover.orig_device : a.device_id;
    const used = new Set([nativeId, ...a.mirrors.map((m) => m.device_id)]);
    const sig = devices.map((d) => d.id + d.name).join(',') + [...used].join(',') + !!a.takeover;
    if (sig !== p.sig) {
      p.sig = sig;
      park.innerHTML = '<option value="">Auto</option>';
      devices.filter((d) => !used.has(d.id) || (a.takeover && d.id === a.takeover.park_device)).forEach((d) => {
        const op = document.createElement('option'); op.value = d.id; op.textContent = d.name; park.append(op);
      });
      park.value = a.takeover ? a.takeover.park_device : '';
      park.disabled = !!a.takeover;
    }
    const noSpare = (p.enabled || dynPanel.on()) && !a.takeover && !a.mirrors.length && !pickPark(a, park.value);
    note.classList.toggle('eqwarn', noSpare);
    note.textContent = noSpare ? 'No spare output: the equalizer needs an output nothing else uses to park this app on. Mirror the app to another device instead.' : '';
  };
  paint();
  return p;
}

// ---------- compressor + gate ----------
const DYN_KEY = 'svm.dyn.v1';
const DYN_DEFAULT = { comp_on: false, threshold: -18, ratio: 3, attack: 10, release: 120, makeup: 0, gate_on: false, gate_threshold: -50, gate_release: 150, limit_on: false, limit_ceiling: -1, pan: 0, mono: false };
const DYN_PRESETS = {
  Gentle: { comp_on: true, threshold: -20, ratio: 2, attack: 20, release: 200, makeup: 3 },
  'Voice / chat': { comp_on: true, threshold: -24, ratio: 4, attack: 5, release: 120, makeup: 6, gate_on: true, gate_threshold: -50, gate_release: 150 },
  'Night mode': { comp_on: true, threshold: -35, ratio: 8, attack: 3, release: 250, makeup: 12 },
  'Peak safe': { limit_on: true, limit_ceiling: -3 },
  'Tame loud ads': { comp_on: true, threshold: -28, ratio: 12, attack: 1, release: 80, makeup: 8 },
};
const DYN_FIELDS = [
  ['comp', 'threshold', 'Threshold', -60, 0, 0.5, ' dB'],
  ['comp', 'ratio', 'Ratio', 1, 20, 0.5, ':1'],
  ['comp', 'attack', 'Attack', 1, 200, 1, ' ms'],
  ['comp', 'release', 'Release', 10, 1000, 5, ' ms'],
  ['comp', 'makeup', 'Make-up gain', 0, 24, 0.5, ' dB'],
  ['gate', 'gate_threshold', 'Threshold', -80, -10, 1, ' dB'],
  ['gate', 'gate_release', 'Release', 10, 1000, 5, ' ms'],
  ['limit', 'limit_ceiling', 'Ceiling', -12, 0, 0.5, ' dB'],
  ['mix', 'pan', 'Balance', -1, 1, 0.05, '', (v) => (Math.abs(v) < 0.025 ? 'Centre' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100))],
];

function saveDyn(a, cfg) {
  if (!settings.remember) return;
  const s = load(DYN_KEY, {});
  s[a.name + '|' + a.sub] = cfg;
  save(DYN_KEY, s);
}

function makeDynPanel(o) {
  const el = document.createElement('div');
  el.className = 'eqpanel dynpanel';
  const p = { el, cfg: { ...DYN_DEFAULT }, localUntil: 0 };
  const inputs = {}, vals = {};
  const chipEls = {};

  const mkSection = (kind, title, hint) => {
    const sec = document.createElement('div');
    sec.className = 'dynsec';
    const head = document.createElement('div');
    head.className = 'eqhead';
    const tg = document.createElement('span');
    tg.className = 'tg';
    const lbl = document.createElement('span');
    lbl.className = 'eqlbl';
    lbl.textContent = title;
    const sp = document.createElement('span');
    sp.style.flex = '1';
    head.append(tg, lbl, sp);
    const h = document.createElement('div');
    h.className = 'sub';
    h.textContent = hint;
    const grid = document.createElement('div');
    grid.className = 'dyngrid';
    sec.append(head, h, grid);
    const onKey = kind === 'mix' ? 'mono' : kind + '_on';
    tg.onclick = () => { p.cfg[onKey] = !p.cfg[onKey]; touch(); };
    return { sec, tg, head, sp, grid, kind, onKey };
  };
  const comp = mkSection('comp', 'Compressor', 'Evens out loud and quiet parts: anything above the threshold is turned down by the ratio.');
  const gate = mkSection('gate', 'Noise gate', 'Silences the app while it is quieter than the threshold (background hiss, keyboard bleed).');

  const limit = mkSection('limit', 'Limiter', 'A hard ceiling: peaks never go above it, however loud the app gets.');
  const mix = mkSection('mix', 'Balance and mono', 'Shift the sound left or right. The toggle folds both channels into one (mono).');
  // gain-reduction meter in the compressor header
  const gr = document.createElement('div');
  gr.className = 'grmeter';
  gr.title = 'Gain reduction';
  gr.innerHTML = '<i></i><span>0 dB</span>';
  comp.head.append(gr);

  DYN_FIELDS.forEach(([sec, key, name, min, max, step, unit, fmt]) => {
    const row = document.createElement('label');
    row.className = 'dynrow';
    const n = document.createElement('span');
    n.className = 'sub';
    n.textContent = name;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step;
    inp.className = 'dynr';
    const v = document.createElement('span');
    v.className = 'eqval';
    row.append(n, inp, v);
    ({ comp, gate, limit, mix })[sec].grid.append(row);
    inputs[key] = inp; vals[key] = v;
    inp.oninput = () => { p.cfg[key] = +inp.value; if (sec !== 'mix' && !p.cfg[sec + '_on']) p.cfg[sec + '_on'] = true; touch(); };
    inp.ondblclick = () => { p.cfg[key] = DYN_DEFAULT[key]; touch(); };
    inp._unit = unit; inp._fmt = fmt;
  });

  const chips = document.createElement('div');
  chips.className = 'eqchips';
  Object.keys(DYN_PRESETS).forEach((n) => {
    const c = document.createElement('button');
    c.className = 'eqchip';
    c.textContent = n;
    c.onclick = () => { p.cfg = { ...DYN_DEFAULT, ...DYN_PRESETS[n] }; touch(); };
    chipEls[n] = c;
    chips.append(c);
  });
  const reset = document.createElement('button');
  reset.className = 'eqreset';
  reset.textContent = 'Reset';
  reset.onclick = () => { p.cfg = { ...DYN_DEFAULT }; touch(); };
  chips.append(reset);

  const note = document.createElement('div');
  note.className = 'sub eqnote';
  el.append(chips, comp.sec, gate.sec, limit.sec, mix.sec, note);

  function paint() {
    const c = p.cfg;
    [comp, gate, limit, mix].forEach((x) => { x.tg.classList.toggle('on', !!c[x.onKey]); x.sec.classList.toggle('off', !c[x.onKey] && x !== mix); });
    DYN_FIELDS.forEach(([, key, , min, max]) => {
      const inp = inputs[key];
      inp.value = c[key];
      inp.style.setProperty('--v', ((c[key] - min) / (max - min)) * 100 + '%');
      vals[key].textContent = inp._fmt ? inp._fmt(c[key]) : c[key] + inp._unit;
    });
    Object.entries(chipEls).forEach(([n, ch]) => {
      const t = { ...DYN_DEFAULT, ...DYN_PRESETS[n] };
      ch.classList.toggle('on', Object.keys(DYN_DEFAULT).every((k) => t[k] === c[k]));
    });
  }
  let timer;
  function touch() {
    p.localUntil = Date.now() + 900;
    paint();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const a = o.app;
      if (!a || !a.pid) return;
      guard(api.setDynamics(a.pid, p.cfg));
      saveDyn(a, p.cfg);
      // the processing happens on the captured copy: park the app (same mechanism as the equalizer)
      const want = p.on() || eqPanel.enabled;
      if (!want || Date.now() > (p.takeBusy || 0)) { p.takeBusy = Date.now() + 2500; autoTakeover(a, want); }
    }, 40);
  }
  p.on = () => p.cfg.comp_on || p.cfg.gate_on || p.cfg.limit_on || p.cfg.mono || Math.abs(p.cfg.pan) > 0.005;
  p.update = (a) => {
    if (Date.now() > p.localUntil && a.dynamics) {
      const { reduction, ...rest } = a.dynamics;
      p.cfg = { ...DYN_DEFAULT, ...rest };
      paint();
    }
    const red = a.dynamics && p.on() ? a.dynamics.reduction : 0;
    gr.querySelector('i').style.width = Math.min(100, (red / 24) * 100) + '%';
    gr.querySelector('span').textContent = red.toFixed(1) + ' dB';
    const noSpare = p.on() && !a.takeover && !a.mirrors.length && !pickPark(a, '');
    note.classList.toggle('eqwarn', noSpare);
    note.textContent = noSpare ? 'No spare output: the compressor and gate need an output nothing else uses to park this app on. Mirror the app to another device instead.' : '';
  };
  paint();
  return p;
}

// ---------- equalizer tab ----------
const eqList = document.getElementById('eq-list');
const eqHost = document.getElementById('eq-host');
const eqCtx = { app: null };
const eqPanel = makeEqPanel(eqCtx);
eqHost.append(eqPanel.el);
eqPanel.el.style.display = 'flex';
const dynCtx = eqCtx;
const dynPanel = makeDynPanel(dynCtx);
eqHost.append(dynPanel.el);
dynPanel.el.style.display = 'flex';
let eqSel = null;     // { id, pid, name, sub } of the selected app; an app's id changes when it is parked, its pid does not
const eqMatch = (st, s) => !s ? null : st.apps.find((a) => a.id === s.id) || st.apps.find((a) => a.pid && a.pid === s.pid) || st.apps.find((a) => a.name === s.name && a.sub === s.sub) || null;
const eqRef = (a) => ({ id: a.id, pid: a.pid, name: a.name, sub: a.sub });
let eqShown = null;   // key the panel currently shows
let eqSig = '';
const eqRows = new Map();
function renderEq(st) {
  if (activeTab !== 'eq') return;
  const keys = st.apps.map((a) => a.id);
  const cur = eqMatch(st, eqSel) || st.apps[0] || null;
  eqSel = cur ? eqRef(cur) : null;
  const sig = keys.join(',');
  if (sig !== eqSig) {
    eqSig = sig;
    eqList.innerHTML = '';
    eqRows.clear();
    st.apps.forEach((a) => {
      const b = document.createElement('div');
      b.className = 'eqapp';
      b.innerHTML = '<div class="logo2"></div><span class="nm"></span><i class="eqdot" title="Equalizer is on"></i>';
      b.onclick = () => { eqSel = eqRef(eqRows.get(b).app); renderEq(lastState); };
      eqList.append(b);
      eqRows.set(b, { app: a, logo: b.querySelector('.logo2'), nm: b.querySelector('.nm'), dot: b.querySelector('.eqdot') });
    });
  }
  const rows = [...eqRows.entries()];
  st.apps.forEach((a, i) => {
    const [b, r] = rows[i];
    r.app = a;
    paintLogo(r.logo, a);
    r.nm.textContent = a.name;
    r.dot.classList.toggle('on', !!(a.eq && a.eq.enabled));
    b.classList.toggle('on', !!cur && a.id === cur.id);
  });
  const app = cur;
  eqHost.classList.toggle('none', !app);
  document.getElementById('eq-empty').hidden = !!app;
  if (!app) return;
  eqCtx.app = app;
  const shownKey = app.pid ? 'p' + app.pid : app.id;
  if (eqShown !== shownKey) {
    eqShown = shownKey;
    Object.assign(eqPanel, { enabled: false, preamp: 0, gains: Array(10).fill(0), localUntil: 0, sig: '' });
    Object.assign(dynPanel, { cfg: { ...DYN_DEFAULT }, localUntil: 0 });
  }
  document.getElementById('eq-title').textContent = app.name + ' on ' + ((st.devices.find((d) => d.id === app.device_id) || {}).name || 'output');
  eqPanel.update(app, st.devices);
  dynPanel.update(app);
}

// ---------- routing graph ----------
const graphEl = document.getElementById('graph');
const wiresEl = document.getElementById('wires');
let graphSig = '';
function renderGraph(force) {
  if (activeTab !== 'routing') return;
  const devices = lastState.devices;
  const seenKeys = new Set();
  const apps = lastState.apps.filter((a) => !seenKeys.has(keyOf(a)) && seenKeys.add(keyOf(a)));
  const sig = JSON.stringify([selectedKey, apps.map((a) => [keyOf(a), a.device_id, a.mirrors.map((m) => m.device_id), a.volume]), devices.map((d) => d.id + d.name)]) + graphEl.clientWidth;
  if (!force && sig === graphSig) return;
  graphSig = sig;
  graphEl.querySelectorAll('.node').forEach((n) => n.remove());
  const rows = Math.max(apps.length, devices.length, 2);
  const H = Math.max(320, rows * 64 + 40);
  graphEl.style.height = H + 'px';
  const W = graphEl.clientWidth;
  const pos = (i, n) => 24 + i * ((H - 48 - 46) / Math.max(1, n - 1));
  const NW = 210;
  const selected = selApp();
  apps.forEach((a, i) => {
    const n = document.createElement('div');
    n.className = 'node l' + (keyOf(a) === selectedKey ? ' sel' : '');
    n.style.top = pos(i, apps.length) + 'px';
    n.innerHTML = `<div class="logo2" style="background:${appColor(a.name)}">${(a.name[0] || '?').toUpperCase()}</div><div style="min-width:0"><div class="nm"></div><div class="sub">${Math.round(a.volume * 100)}%</div></div>`;
    paintLogo(n.querySelector('.logo2'), a);
    n.querySelector('.nm').textContent = a.name;
    n.onclick = () => select(a);
    graphEl.append(n);
  });
  devices.forEach((d, i) => {
    const n = document.createElement('div');
    n.className = 'node r';
    n.style.top = pos(i, devices.length) + 'px';
    n.innerHTML = `<div class="ico">${deviceIcon(d.name + ' ' + d.sub)}</div><div style="min-width:0"><div class="nm"></div><div class="sub"></div></div>`;
    n.querySelector('.nm').textContent = d.name;
    n.querySelector('.sub').textContent = d.sub;
    n.onclick = () => { const a = selApp(); if (!a) return toast('Select an app on the left first.'); toggleMirror(a, d.id); };
    n.oncontextmenu = (e) => { e.preventDefault(); const a = selApp(); if (!a) return toast('Select an app on the left first.'); makeNative(a, d.id); };
    graphEl.append(n);
  });
  let svg = '';
  apps.forEach((a, i) => {
    const targets = [[a.device_id, true], ...a.mirrors.map((m) => [m.device_id, false])];
    targets.forEach(([id, native]) => {
      const j = devices.findIndex((d) => d.id === id);
      if (j < 0) return;
      const x1 = 24 + NW, y1 = pos(i, apps.length) + 22, x2 = W - 24 - NW, y2 = pos(j, devices.length) + 22, mx = (x1 + x2) / 2;
      const dim = selected && keyOf(a) !== selectedKey;
      svg += `<path d="M${x1} ${y1} C${mx} ${y1},${mx} ${y2},${x2} ${y2}" fill="none" stroke="${appColor(a.name)}" stroke-width="3" stroke-linecap="round" opacity="${dim ? 0.2 : 0.95}" ${native ? '' : 'stroke-dasharray="7 6"'}/>`;
    });
  });
  wiresEl.innerHTML = svg;
  const hint = document.getElementById('graphhint');
  hint.textContent = selected
    ? `${selected.name}: ${[selected.device_id, ...selected.mirrors.map((m) => m.device_id)].map((id) => (devices.find((d) => d.id === id) || {}).name).filter(Boolean).join(' + ')}  ·  solid = native, dashed = mirrored`
    : 'Select an app on the left.';
}
window.addEventListener('resize', () => renderGraph(true));

// ---------- settings view ----------
(function buildSettings() {
  const el = document.getElementById('settings');
  const row = (title, sub, control) => {
    const r = document.createElement('div');
    r.className = 'setrow';
    r.innerHTML = `<div style="flex:1"><div class="nm">${title}</div><div class="sub">${sub}</div></div>`;
    r.append(control);
    el.append(r);
  };
  const toggle = (key, onChange) => {
    const t = document.createElement('span');
    t.className = 'tg' + (settings[key] ? ' on' : '');
    t.onclick = () => { settings[key] = !settings[key]; t.classList.toggle('on', settings[key]); saveSettings(); onChange && onChange(settings[key]); };
    return t;
  };
  // Start with Windows (real state lives in the OS, not localStorage)
  const auto = document.createElement('span');
  auto.className = 'tg';
  if (TAURI) TAURI.core.invoke('plugin:autostart|is_enabled').then((v) => auto.classList.toggle('on', !!v)).catch(() => {});
  auto.onclick = async () => {
    const want = !auto.classList.contains('on');
    try { await TAURI.core.invoke(want ? 'plugin:autostart|enable' : 'plugin:autostart|disable'); auto.classList.toggle('on', want); }
    catch (e) { toast(String(e)); }
  };
  const seg = document.createElement('div');
  seg.className = 'seg';
  [['system', 'System'], ['light', 'Light'], ['dark', 'Dark'], ['classic', 'Classic']].forEach(([v, t]) => {
    const b = document.createElement('span');
    b.textContent = t;
    b.classList.toggle('on', (settings.theme || 'system') === v);
    b.onclick = () => { settings.theme = v; saveSettings(); applyTheme(); seg.querySelectorAll('span').forEach((x) => x.classList.toggle('on', x === b)); };
    seg.append(b);
  });
  row('Theme', 'System follows your Windows light/dark setting', seg);
  const tseg = document.createElement('div');
  tseg.className = 'seg';
  const pushTray = () => { if (TAURI) TAURI.core.invoke('set_tray_style', { style: settings.trayIcon || 'tile' }).catch(() => {}); };
  [['tile', 'Bars'], ['faders', 'Faders']].forEach(([v, t]) => {
    const b = document.createElement('span');
    b.textContent = t;
    b.classList.toggle('on', (settings.trayIcon || 'tile') === v);
    b.onclick = () => { settings.trayIcon = v; saveSettings(); pushTray(); tseg.querySelectorAll('span').forEach((x) => x.classList.toggle('on', x === b)); };
    tseg.append(b);
  });
  pushTray();
  row('Tray icon', 'Single-colour icon; white or black to match the taskbar', tseg);
  row('Start with Windows', 'Launch at sign-in, minimised to the tray', auto);
  row('Close button goes to tray', 'Off: the X button quits the app. Use the tray icon to reopen when on', toggle('closeToTray', syncCloseMode));
  row('Remember mirrors per app', 'Restore mirrored outputs when an app starts again', toggle('remember'));
  row('Always on top', 'Keep this window above others', toggle('onTop', (v) => win && win.setAlwaysOnTop(v).catch((e) => toast(String(e)))));
  const stp = document.createElement('div');
  stp.className = 'stp';
  stp.innerHTML = `<span>−</span><b>${settings.delay} ms</b><span>+</span>`;
  const [m, p] = stp.querySelectorAll('span');
  const b = stp.querySelector('b');
  const bump = (d) => { settings.delay = Math.max(0, Math.min(500, settings.delay + d)); b.textContent = settings.delay + ' ms'; saveSettings(); };
  m.onclick = () => bump(-5);
  p.onclick = () => bump(5);
  row('Default mirror delay', 'Delay applied to a newly added mirror', stp);
})();


// ---------- about ----------
const GH_URL = 'https://github.com/SailHighSea/sailhighsea-vm';
(function buildAbout() {
  const card = document.getElementById('ab-card');
  const ua = navigator.userAgent;
  const guessOs = /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'macos' : 'linux';
  const OS_NAME = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
  const info = { version: '0.0.1-dev1', os: guessOs, arch: '', tauri: '', dir: '(shown in the app, not in a browser)' };
  const rows = () => [
    ['Version', info.version],
    ['Platform', (OS_NAME[info.os] || info.os) + (info.arch ? ' ' + info.arch : '')],
    ['Engine', 'Rust + Tauri' + (info.tauri ? ' ' + info.tauri : '')],
    ['Audio', info.os === 'windows' ? 'WASAPI (process loopback for mirrors)' : info.os === 'linux' ? 'PulseAudio / PipeWire (pactl)' : 'AppleScript (default output only)'],
    ['Copyright', '© 2026 SailHighSea'],
    ['GitHub', GH_URL.replace('https://', '')],
    ['Data folder', info.dir],
  ];
  const paint = () => {
    document.getElementById('ab-ver').textContent = 'Version ' + info.version;
    card.innerHTML = '';
    rows().forEach(([k, v]) => {
      const r = document.createElement('div');
      r.className = 'abrow';
      const a = document.createElement('span'); a.className = 'sub'; a.textContent = k;
      const b = document.createElement('span'); b.className = 'abval'; b.textContent = v; b.title = v;
      r.append(a, b);
      card.append(r);
    });
  };
  paint();
  if (TAURI) TAURI.core.invoke('about_info').then((i) => { Object.assign(info, i); paint(); }).catch(() => {});
  document.getElementById('ab-folder').onclick = () => TAURI ? TAURI.core.invoke('open_data_folder').catch((e) => toast(String(e))) : toast('Only available in the app.');
  const openUrl = (u) => TAURI ? TAURI.core.invoke('open_url', { url: u }).catch((e) => toast(String(e))) : window.open(u, '_blank');
  document.getElementById('ab-gh').onclick = () => openUrl(GH_URL);
  const msg = document.getElementById('ab-upd-msg');
  const btn = document.getElementById('ab-upd');
  // version compare: 0.0.1-dev2 > 0.0.1-dev1 > ..., and a release (no suffix) beats its dev builds
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/i, '').split('-');
    return { n: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre === undefined ? Infinity : parseInt((pre.match(/\d+/) || [0])[0], 10) };
  };
  const newer = (a, b) => {
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) > (y.n[i] || 0);
    return x.pre > y.pre;
  };
  async function checkUpdates(silent) {
    if (!silent) { btn.disabled = true; msg.textContent = 'Checking for updates…'; }
    try {
      const res = await fetch('https://api.github.com/repos/SailHighSea/sailhighsea-vm/releases?per_page=10', { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('GitHub answered ' + res.status);
      const rel = (await res.json()).filter((r) => !r.draft && r.tag_name).find((r) => newer(r.tag_name, info.version));
      if (rel) {
        msg.textContent = 'Update available: ' + rel.tag_name + '. ';
        const a = document.createElement('a');
        a.href = '#'; a.textContent = 'Open the release page';
        a.onclick = (e) => { e.preventDefault(); openUrl(rel.html_url); };
        msg.append(a);
        if (silent) toast('Update available: ' + rel.tag_name + '. See the About tab.', true);
      } else if (!silent) msg.textContent = 'You have the latest version (' + info.version + ').';
    } catch (e) {
      if (!silent) msg.textContent = 'Could not check for updates (' + (e.message || e) + ').';
    }
    btn.disabled = false;
  }
  btn.onclick = () => checkUpdates(false);
  setTimeout(() => checkUpdates(true), 8000);
  document.getElementById('ab-copy').onclick = () => {
    const text = rows().map(([k, v]) => k + ': ' + v).join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText('SailHighSea VM\n' + text) : Promise.reject()).then(() => toast('Version info copied.')).catch(() => toast('Could not copy.'));
  };
})();

// ---------- classic (vertical fader) mixer ----------
// Device tabs on top; one strip per app playing natively on the selected device; master on the right.
const dbText = (v) => (v <= 0.001 ? '-∞ dB' : (20 * Math.log10(v)).toFixed(1) + ' dB');
const clApps = document.getElementById('cl-apps');
const clMaster = document.getElementById('cl-master');
const clTabs = document.getElementById('cl-tabs');
const strips = new Map();
const ALL = '__all__';
let clDevice = null;     // selected device id, or ALL
let clTabSig = '';
const OUTCOL = ['#4fc3f7', '#b39dff', '#4ddb94', '#f2c744', '#ff9a73', '#f58fb4'];
const SCALE = [[1, '0'], [0.5, '-6'], [0.251, '-12'], [0.063, '-24'], [0, '-∞']];

// Vertical fader: rail + fill + knob, value 0..1 (same scale as the Windows volume scalar).
function makeVFader(onChange) {
  const el = document.createElement('div');
  el.className = 'vf';
  el.innerHTML = '<div class="scale"></div><div class="rail"><div class="in"><div class="fill"></div><div class="knob"></div></div></div>';
  const scale = el.querySelector('.scale');
  SCALE.forEach(([v, t]) => { const s = document.createElement('span'); s.textContent = t; s.style.top = (1 - v) * 100 + '%'; scale.append(s); });
  const inn = el.querySelector('.in');
  const f = { el, dragging: false, v: 0 };
  f.set = (v) => { f.v = v; el.style.setProperty('--p', v); };
  const move = (e) => {
    const r = inn.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    f.set(v);
    onChange(v);
  };
  el.querySelector('.rail').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    f.dragging = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    move(e);
    const rail = e.currentTarget;
    const mv = (m) => move(m);
    const up = () => { f.dragging = false; rail.removeEventListener('pointermove', mv); rail.removeEventListener('pointerup', up); };
    rail.addEventListener('pointermove', mv);
    rail.addEventListener('pointerup', up);
  });
  return f;
}

function makeVMeters() {
  const wrap = document.createElement('div');
  wrap.className = 'vms';
  wrap.innerHTML = '<div class="vm"><i></i></div><div class="vm"><i></i></div>';
  const bars = [...wrap.querySelectorAll('i')];
  return { el: wrap, set(p) { const h = Math.min(100, p * 100) + '%'; bars.forEach((b) => { b.style.height = h; b.style.setProperty('--full', b.parentElement.clientHeight + 'px'); }); } };
}

function makeStrip(isMaster) {
  const el = document.createElement('div');
  el.className = 'cs' + (isMaster ? ' master' : '');
  el.innerHTML = '<div class="logo2"></div><div class="nm2"></div><div class="db"></div><div class="fwrap"></div>';
  const o = { el, isMaster, item: null, sig: '', logo: el.querySelector('.logo2'), nm: el.querySelector('.nm2'), db: el.querySelector('.db') };
  o.fader = makeVFader((v) => { o.db.textContent = dbText(v); guard(api.setVolume(o.item.id, v)); });
  o.meters = makeVMeters();
  el.querySelector('.fwrap').append(o.fader.el, o.meters.el);
  if (!isMaster) {
    o.out = document.createElement('button');
    o.out.className = 'outbtn';
    o.out.onclick = () => openDdMenu(o.out, (o.devs || []).map((d) => ({ value: d.id, text: d.name })), o.item.device_id, (id) => moveNative(o.item, id));
    o.badge = document.createElement('div');
    o.badge.className = 'mirbadge';
    el.append(o.out, o.badge);
    o.logo.onclick = () => select(o.item);
    o.logo.title = 'Select (for the routing graph)';
  }
  const btns = document.createElement('div');
  btns.className = 'cbtns';
  o.mute = document.createElement('button');
  o.mute.className = 'mbtn mute';
  o.mute.textContent = 'M';
  o.mute.title = 'Mute';
  o.mute.onclick = () => { const m = !o.mute.classList.contains('act'); o.mute.classList.toggle('act', m); guard(api.setMute(o.item.id, m)); };
  btns.append(o.mute);
  if (isMaster) {
    o.def = document.createElement('button');
    o.def.className = 'mbtn defb';
    o.def.onclick = () => { if (!o.item.is_default) guard(api.setDefault(o.item.id)); };
    el.append(o.def);
  }
  if (!isMaster) {
    o.solo = document.createElement('button');
    o.solo.className = 'mbtn solo';
    o.solo.textContent = 'S';
    o.solo.title = 'Solo: mute the other apps on this output';
    o.solo.onclick = () => toggleSolo(o.item);
    btns.append(o.solo);
  }
  el.append(btns);
  return o;
}

// move = change the native output without leaving a mirror behind
async function moveNative(a, devId) {
  if (!a || a.device_id === devId) return;
  const next = mirrorList(a).filter((m) => m.device_id !== devId);
  const dn = (lastState.devices.find((d) => d.id === devId) || {}).name || 'output';
  try { await api.setRoute(a.id, devId); } catch (e) { return toast(String(e)); }
  toast(a.name + ' set to ' + dn + (a.peak > 0.001 ? '' : ' (it will switch when it next plays sound)'), true);
  if (next.length !== a.mirrors.length) setMirrors(a, next);
}

// solo: mute everything else on the same device, restore on release
const soloState = new Map(); // deviceId -> { appId, restore: Map(appId -> wasMuted) }
function releaseSolo(devId) {
  const s = soloState.get(devId);
  if (!s) return;
  s.restore.forEach((wasMuted, id) => { if (!wasMuted) guard(api.setMute(id, false)); });
  soloState.delete(devId);
}
function toggleSolo(a) {
  const dev = a.device_id;
  const cur = soloState.get(dev);
  releaseSolo(dev);
  if (cur && cur.appId === a.id) return;
  const restore = new Map();
  lastState.apps.filter((x) => x.device_id === dev && x.id !== a.id).forEach((x) => { restore.set(x.id, x.muted); if (!x.muted) guard(api.setMute(x.id, true)); });
  if (a.muted) guard(api.setMute(a.id, false));
  soloState.set(dev, { appId: a.id, restore });
}

function updateStrip(o, it, isMaster, isAll, st) {
  o.item = it;
  o.nm.textContent = isMaster && !isAll ? 'Master' : it.name;
  o.nm.title = it.name;
  if (isMaster) { o.logo.textContent = 'M'; o.logo.style.background = 'linear-gradient(135deg,#4cc2ff,#7c6cff)'; } else paintLogo(o.logo, it);
  o.el.classList.toggle('muted', it.muted);
  o.mute.classList.toggle('act', it.muted);
  o.fader.set(it.volume);
  if (isMaster) {
    o.def.classList.toggle('act', !!it.is_default);
    o.def.textContent = it.is_default ? '★ Default' : 'Set default';
    o.def.title = it.is_default ? 'This is the Windows default output' : 'Make this the default output';
  }
  if (!o.fader.dragging) o.db.textContent = dbText(it.volume);
  o.meters.set(it.muted ? 0 : it.peak);
  if (!isMaster) {
    o.el.classList.toggle('selected', keyOf(it) === selectedKey);
    o.devs = st.devices;
    const di = st.devices.findIndex((d) => d.id === it.device_id);
    const dv = st.devices[di];
    const osig = it.device_id + (dv ? dv.name : '');
    if (osig !== o.sig) {
      o.sig = osig;
      o.out.textContent = dv ? deviceIcon(dv.name + ' ' + dv.sub) : '?';
      o.out.title = 'Plays on ' + (dv ? dv.name : 'an unknown output') + '. Click to choose another output, or drag the strip onto a lane.';
      o.out.setAttribute('aria-label', 'Output for ' + it.name + ': ' + (dv ? dv.name : 'unknown'));
      o.out.style.setProperty('--c', OUTCOL[(di < 0 ? 0 : di) % OUTCOL.length]);
    }
    o.badge.textContent = it.mirrors.length ? '+' + it.mirrors.length + ' mirror' + (it.mirrors.length > 1 ? 's' : '') : '';
    const s = soloState.get(it.device_id);
    o.solo.classList.toggle('act', !!s && s.appId === it.id);
  }
}

function renderClassic(st) {
  if (!st.devices.length) return;
  if (!clDevice || (clDevice !== ALL && !st.devices.some((d) => d.id === clDevice))) clDevice = (st.devices.find((d) => d.is_default) || st.devices[0]).id;

  // tabs
  const tsig = st.devices.map((d) => d.id + d.name).join(',') + clDevice;
  if (tsig !== clTabSig) {
    clTabSig = tsig;
    clTabs.innerHTML = '';
    const all = document.createElement('div');
    all.className = 'cltab' + (clDevice === ALL ? ' on' : '');
    all.textContent = '☰ All';
    all.onclick = () => { clDevice = ALL; clTabSig = ''; renderClassic(lastState); applyCardsFilter(); };
    clTabs.append(all);
    st.devices.forEach((d) => {
      const t = document.createElement('div');
      t.className = 'cltab' + (d.id === clDevice ? ' on' : '');
      t.dataset.dev = d.id;
      t.textContent = deviceIcon(d.name + ' ' + d.sub) + ' ' + d.name;
      t.onclick = () => { clDevice = d.id; clTabSig = ''; renderClassic(lastState); applyCardsFilter(); };
      clTabs.append(t);
    });
  }

  const isAll = clDevice === ALL;
  const items = [
    ...st.apps.filter((a) => isAll || a.device_id === clDevice).map((a) => [a, false]),
    ...(isAll ? st.devices : [st.devices.find((d) => d.id === clDevice)]).map((d) => [d, true]),
  ];
  const seen = new Set();
  items.forEach(([it, isMaster]) => {
    const key = (isMaster ? 'M:' : 'A:') + it.id;
    seen.add(key);
    if (!strips.has(key)) { const s = makeStrip(isMaster); strips.set(key, s); (isMaster ? clMaster : clApps).append(s.el); }
    updateStrip(strips.get(key), it, isMaster, isAll, st);
  });
  for (const [k, o] of strips) if (!seen.has(k)) { o.el.remove(); strips.delete(k); }
  if (settings.viewMode === 'lanes') renderLanes(st);
}

// ---------- lanes view: one lane per output = master strip + the app strips playing on it; drag a strip to another lane ----------
const lanesEl = document.getElementById('lanes');
const lanes = new Map();
const lstrips = new Map();
function renderLanes(st) {
  const isAll = clDevice === ALL;
  const devs = isAll ? st.devices : st.devices.filter((d) => d.id === clDevice);
  const seenL = new Set();
  const seenS = new Set();
  devs.forEach((d, i) => {
    seenL.add(d.id);
    let L = lanes.get(d.id);
    if (!L) {
      const el = document.createElement('div');
      el.className = 'lane';
      el.dataset.dev = d.id;
      el.innerHTML = '<div class="lm"></div><div class="la"></div><div class="lempty">No apps. Drag a strip here.</div>';
      L = { el, lm: el.querySelector('.lm'), la: el.querySelector('.la') };
      lanes.set(d.id, L);
    }
    if (lanesEl.children[i] !== L.el) lanesEl.insertBefore(L.el, lanesEl.children[i] || null);
    L.el.classList.toggle('hero', !!d.is_default);
    const mk = 'M:' + d.id;
    seenS.add(mk);
    if (!lstrips.has(mk)) { const s = makeStrip(true); lstrips.set(mk, s); L.lm.append(s.el); }
    updateStrip(lstrips.get(mk), d, true, true, st);
    const apps = st.apps.filter((a) => a.device_id === d.id);
    L.el.classList.toggle('empty', !apps.length);
    apps.forEach((a, j) => {
      const k = 'A:' + a.id;
      seenS.add(k);
      if (!lstrips.has(k)) lstrips.set(k, makeStrip(false));
      const o = lstrips.get(k);
      if (L.la.children[j] !== o.el) L.la.insertBefore(o.el, L.la.children[j] || null);
      updateStrip(o, a, false, false, st);
    });
  });
  for (const [id, L] of lanes) if (!seenL.has(id)) { L.el.remove(); lanes.delete(id); }
  for (const [k, o] of lstrips) if (!seenS.has(k)) { o.el.remove(); lstrips.delete(k); }
}
(function () {
  let dg = null;
  const laneAt = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.closest('.lane, .cltab[data-dev]'); };
  const board = document.getElementById('board');
  function end(drop) {
    if (!dg) return;
    if (dg.ghost) dg.ghost.remove();
    document.body.classList.remove('dragging');
    document.querySelectorAll('#v-mixer .dropok').forEach((l) => l.classList.remove('dropok'));
    dg.o.el.classList.remove('dragsrc');
    const d = dg;
    dg = null;
    if (drop && d.active && d.target && d.target !== d.o.item.device_id) moveNative(d.o.item, d.target);
  }
  // grab a whole strip (anywhere except its faders and buttons); drop it on a lane, or on an output tab in Classic
  const start = (map) => (e) => {
    const el = e.target.closest('.cs:not(.master)');
    if (e.button !== 0 || !el || e.target.closest('.vf, button, select, .fwrap')) return;
    const o = [...map.values()].find((s) => s.el === el);
    if (o) dg = { x: e.clientX, y: e.clientY, o, active: false, ghost: null, target: null };
  };
  lanesEl.addEventListener('pointerdown', start(lstrips));
  board.addEventListener('pointerdown', start(strips));
  window.addEventListener('pointermove', (e) => {
    if (!dg) return;
    if (!dg.active) {
      if (Math.hypot(e.clientX - dg.x, e.clientY - dg.y) < 6) return;
      dg.active = true;
      document.body.classList.add('dragging');
      dg.o.el.classList.add('dragsrc');
      getSelection().removeAllRanges();
      const g = document.createElement('div');
      g.className = 'ghost';
      g.innerHTML = '<span class="gl"></span><span class="gt"></span>';
      g.querySelector('.gl').style.background = dg.o.logo.style.background;
      g.querySelector('.gt').textContent = dg.o.item.name;
      document.body.append(g);
      dg.ghost = g;
    }
    dg.ghost.style.transform = 'translate(' + (e.clientX + 10) + 'px,' + (e.clientY + 6) + 'px)';
    const l = laneAt(e.clientX, e.clientY);
    dg.target = l ? l.dataset.dev : null;
    document.querySelectorAll('#v-mixer .lane, #v-mixer .cltab').forEach((x) => x.classList.toggle('dropok', x === l && l.dataset.dev !== dg.o.item.device_id));
  });
  window.addEventListener('pointerup', () => end(true));
  window.addEventListener('pointercancel', () => end(false));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') end(false); });
})();

// Cards view uses the same device tabs: only the selected output's card and its apps are shown.
function applyCardsFilter() {
  const filt = settings.viewMode === 'cards' && !!clDevice && clDevice !== ALL;
  for (const [id, o] of devRows) o.el.style.display = !filt || id === clDevice ? '' : 'none';
  let shown = 0;
  lastState.apps.forEach((a) => {
    const o = appRows.get(a.id);
    if (!o) return;
    const vis = !filt || a.device_id === clDevice;
    o.el.style.display = vis ? '' : 'none';
    if (vis) shown++;
  });
  appsEl.querySelector('.empty')?.remove();
  if (!shown) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = filt && lastState.apps.length ? 'No apps play on this output.' : 'Nothing is playing audio right now.';
    appsEl.append(e);
  }
}

// ---------- layout toggle ----------
const mixerView = document.getElementById('v-mixer');
const applyMode = () => {
  const m = ['classic', 'lanes'].includes(settings.viewMode) ? settings.viewMode : 'cards';
  ['classic', 'lanes', 'cards'].forEach((x) => mixerView.classList.toggle('mode-' + x, x === m));
  document.querySelectorAll('#viewmode span').forEach((s) => s.classList.toggle('on', s.dataset.m === m));
};
document.querySelectorAll('#viewmode span').forEach((s) => (s.onclick = () => { settings.viewMode = s.dataset.m; saveSettings(); applyMode(); if (lastState) { renderClassic(lastState); applyCardsFilter(); } }));
applyMode();

// ---------- main render ----------
function render(st) {
  lastState = st;
  sync(devRows, st.devices, makeDevice);
  sync(appRows, st.apps, (a) => makeApp(a));

  const nativeIds = new Set(st.apps.map((a) => a.device_id));
  const mirrorIds = new Set(st.apps.flatMap((a) => a.mirrors.map((m) => m.device_id)));
  const mirrorCount = st.apps.reduce((n, a) => n + a.mirrors.length, 0);
  document.getElementById('devcount').textContent = st.devices.length + ' active';
  const eng = document.getElementById('engine');
  eng.classList.toggle('live', mirrorCount > 0);
  eng.querySelector('span').textContent = mirrorCount ? `Mirroring ${mirrorCount} stream${mirrorCount === 1 ? '' : 's'}` : 'Engine running';
  document.getElementById('sb-out').textContent = st.devices.length + (st.devices.length === 1 ? ' output' : ' outputs');
  document.getElementById('sb-apps').textContent = st.apps.length + (st.apps.length === 1 ? ' app' : ' apps');
  const def = st.devices.find((d) => d.is_default);
  document.getElementById('sb-def').textContent = def ? 'Default: ' + def.name : 'No default';
  const maxDelay = Math.max(0, ...st.apps.flatMap((a) => a.mirrors.map((m) => m.delay_ms)));
  const sbDelay = document.getElementById('sb-delay');
  sbDelay.hidden = !mirrorCount;
  sbDelay.querySelector('span').textContent = '+' + maxDelay + ' ms mirror';
  document.getElementById('sb-eq').hidden = !st.apps.some((a) => a.eq && a.eq.enabled);
  const dy = (f) => st.apps.some((a) => a.dynamics && f(a.dynamics));
  const dynParts = [dy((d) => d.comp_on) && 'Comp', dy((d) => d.gate_on) && 'gate', dy((d) => d.limit_on) && 'limiter', dy((d) => d.mono || Math.abs(d.pan) > 0.005) && 'mix'].filter(Boolean);
  const sbDyn = document.getElementById('sb-dyn');
  sbDyn.hidden = !dynParts.length;
  const dynText = dynParts.join(' + ');
  sbDyn.querySelector('span').textContent = dynText.charAt(0).toUpperCase() + dynText.slice(1);
  document.getElementById('sb-vol').querySelector('span').textContent = def ? Math.round(def.volume * 100) + '%' + (def.muted ? ' (muted)' : '') : '-';
  document.getElementById('sb-ver').textContent = document.getElementById('ver').textContent;
  document.getElementById('sb-themebtn').onclick = () => document.querySelector('.tab[data-v="settings"]').click();

  st.devices.forEach((d) => {
    const o = devRows.get(d.id);
    o.el.classList.toggle('default', d.is_default);
    o.badge.hidden = false;
    o.badge.textContent = d.is_default ? 'DEFAULT' : 'SET DEFAULT';
    o.badge.classList.toggle('act', !d.is_default);
    o.badge.title = d.is_default ? 'This is the Windows default output' : 'Make this the default output';
    o.badge.onclick = d.is_default ? null : () => guard(api.setDefault(d.id));
    o.ico.textContent = deviceIcon(d.name + ' ' + d.sub);
    o.nm.textContent = d.name;
    o.sub.textContent = d.sub;
    const role = nativeIds.has(d.id) ? 'p' : mirrorIds.has(d.id) ? 'm' : '';
    o.tag.hidden = !role;
    o.tag.className = 'tag ' + role;
    o.tag.textContent = role === 'p' ? 'NATIVE' : 'MIRROR';
    o.slider.set(d.volume);
    if (!o.slider.dragging) o.big.innerHTML = Math.round(d.volume * 100) + '<small>%</small>';
    o.mute.classList.toggle('act', d.muted);
    o.meter.set(d.muted ? 0 : d.peak);
  });

  const saved = load(SAVE_KEY, {});
  st.apps.forEach((a) => {
    const o = appRows.get(a.id);
    o.app = a;
    o.key = keyOf(a);
    o.el.classList.toggle('selected', o.key === selectedKey);
    o.el.classList.toggle('muted', a.muted);
    o.mute.classList.toggle('act', a.muted);
    const sl = soloState.get(a.device_id);
    o.solo.classList.toggle('act', !!sl && sl.appId === a.id);
    paintLogo(o.logo, a);
    o.nm.textContent = a.name;
    o.sub.textContent = a.sub;
    o.slider.set(a.volume);
    if (!o.slider.dragging) o.pct.textContent = Math.round(a.volume * 100) + '%';
    o.meter.set(a.muted ? 0 : a.peak);

    const key = a.name + '|' + a.sub;
    if (settings.remember && !restored.has(a.id) && a.pid) {
      restored.add(a.id);
      const want = (saved[key] || []).filter((m) => m.device_id !== a.device_id && st.devices.some((d) => d.id === m.device_id));
      if (!a.mirrors.length && want.length) api.setMirrors(a.pid, want).catch(() => {});
    }

    const sig = [a.device_id, a.mirrors.map((m) => m.device_id).join('+'), st.devices.map((d) => d.id + d.name).join(',')].join('|');
    if (sig !== o.sig && !document.activeElement?.closest?.('.fine')) {
      o.sig = sig;
      rebuildRoutes(o, a, st.devices);
    }
    if (settings.remember && a.pid && !restoredEq.has(a.id)) {
      restoredEq.add(a.id);
      const se = load(EQ_KEY, {})[key];
      if (se && !a.eq) api.setEq(a.pid, se.enabled, se.preamp, se.gains).then(() => { if (se.enabled) autoTakeover(a, true); }).catch(() => {});
      const sd = load(DYN_KEY, {})[key];
      if (sd && !a.dynamics) api.setDynamics(a.pid, { ...DYN_DEFAULT, ...sd }).then(() => { if ((sd.comp_on || sd.gate_on) && !(se && se.enabled)) autoTakeover(a, true); }).catch(() => {});
    }
  });

  renderGraph(false);
  renderEq(st);
  renderClassic(st);
  applyCardsFilter();
}

// ---------- profiles: save / recall the whole mixer setup ----------
const PROF_KEY = 'svm.profiles.v1';
const appKey = (a) => a.name + '|' + a.sub;

function captureProfile(st) {
  const p = { apps: {}, devices: {}, default: (st.devices.find((d) => d.is_default) || {}).id || '' };
  st.devices.forEach((d) => { p.devices[d.id] = { volume: d.volume, muted: d.muted }; });
  st.apps.forEach((a) => {
    p.apps[appKey(a)] = {
      volume: a.volume,
      muted: a.muted,
      device: a.takeover ? a.takeover.orig_device : a.device_id,
      mirrors: mirrorList(a),
      eq: a.eq ? { enabled: a.eq.enabled, preamp: a.eq.preamp, gains: [...a.eq.gains] } : null,
      dyn: a.dynamics ? (({ reduction, ...rest }) => rest)(a.dynamics) : null,
    };
  });
  return p;
}

async function applyProfile(name) {
  const p = load(PROF_KEY, {})[name];
  const st = lastState;
  if (!p || !st) return;
  const has = (id) => st.devices.some((d) => d.id === id);
  // 1. devices
  for (const [id, d] of Object.entries(p.devices || {})) if (has(id)) { guard(api.setVolume(id, d.volume)); guard(api.setMute(id, d.muted)); }
  if (p.default && has(p.default) && !(st.devices.find((d) => d.id === p.default) || {}).is_default) guard(api.setDefault(p.default));
  // 2. apps: remember for apps that start later, apply live to the ones running now
  const mir = load(SAVE_KEY, {}), eqs = load(EQ_KEY, {}), dyns = load(DYN_KEY, {});
  for (const [key, s] of Object.entries(p.apps || {})) {
    if (settings.remember) {
      if (s.mirrors && s.mirrors.length) mir[key] = s.mirrors; else delete mir[key];
      if (s.eq) eqs[key] = s.eq;
      if (s.dyn) dyns[key] = s.dyn;
    }
    const a = st.apps.find((x) => appKey(x) === key);
    if (!a) continue;
    guard(api.setVolume(a.id, s.volume));
    guard(api.setMute(a.id, s.muted));
    if (!a.pid) continue;
    if (!a.takeover && s.device && s.device !== a.device_id && has(s.device)) { try { await api.setRoute(a.id, s.device); } catch {} }
    const native = a.takeover ? a.takeover.orig_device : s.device && has(s.device) ? s.device : a.device_id;
    setMirrors(a, (s.mirrors || []).filter((m) => has(m.device_id) && m.device_id !== native));
    if (s.eq) guard(api.setEq(a.pid, s.eq.enabled, s.eq.preamp, s.eq.gains));
    if (s.dyn) guard(api.setDynamics(a.pid, { ...DYN_DEFAULT, ...s.dyn }));
    const dynOn = s.dyn && (s.dyn.comp_on || s.dyn.gate_on || s.dyn.limit_on || s.dyn.mono || Math.abs(s.dyn.pan || 0) > 0.005);
    autoTakeover(a, !!((s.eq && s.eq.enabled) || dynOn));
  }
  if (settings.remember) { save(SAVE_KEY, mir); save(EQ_KEY, eqs); save(DYN_KEY, dyns); }
  toast('Profile applied: ' + name, true);
}

(function buildProfiles() {
  const host = document.createElement('section');
  host.style.maxWidth = '560px';
  host.innerHTML = '<h2>Profiles <em>save the current volumes, routing, mirrors, equalizer and dynamics, and bring them back with one click</em></h2><div class="card setlist" id="profiles"></div>';
  document.getElementById('v-settings').append(host);
  const box = host.querySelector('#profiles');
  const make = document.createElement('div');
  make.className = 'setrow profnew';
  const inp = document.createElement('input');
  inp.className = 'ginput';
  inp.placeholder = 'Profile name, for example Calls or Movie night';
  inp.maxLength = 40;
  const saveBtn = document.createElement('button');
  saveBtn.className = 'eqreset';
  saveBtn.textContent = 'Save current';
  make.append(inp, saveBtn);
  const list = document.createElement('div');
  box.append(make, list);
  function paintList() {
    const all = load(PROF_KEY, {});
    list.innerHTML = '';
    const names = Object.keys(all);
    if (!names.length) { const e = document.createElement('div'); e.className = 'sub setrow'; e.textContent = 'No profiles yet. Set your mixer up the way you like it, then save it here.'; list.append(e); return; }
    names.forEach((n) => {
      const r = document.createElement('div');
      r.className = 'setrow';
      const apps = Object.keys(all[n].apps || {}).length;
      r.innerHTML = '<div style="flex:1;min-width:0"><div class="nm"></div><div class="sub"></div></div>';
      r.querySelector('.nm').textContent = n;
      r.querySelector('.sub').textContent = apps + ' app' + (apps === 1 ? '' : 's');
      const ap = document.createElement('button');
      ap.className = 'eqchip';
      ap.textContent = 'Apply';
      ap.onclick = () => applyProfile(n);
      const up = document.createElement('button');
      up.className = 'eqreset';
      up.textContent = 'Update';
      up.title = 'Overwrite this profile with the current setup';
      up.onclick = () => { const a2 = load(PROF_KEY, {}); a2[n] = captureProfile(lastState); save(PROF_KEY, a2); paintList(); toast('Profile updated: ' + n, true); };
      const del = document.createElement('button');
      del.className = 'eqreset';
      del.textContent = 'Delete';
      del.onclick = () => { const a2 = load(PROF_KEY, {}); delete a2[n]; save(PROF_KEY, a2); paintList(); };
      r.append(ap, up, del);
      list.append(r);
    });
  }
  saveBtn.onclick = () => {
    const name = inp.value.trim();
    if (!name) return toast('Enter a name for the profile first.');
    if (!lastState) return toast('The mixer has not loaded yet.');
    const all = load(PROF_KEY, {});
    all[name] = captureProfile(lastState);
    save(PROF_KEY, all);
    inp.value = '';
    paintList();
    toast('Profile saved: ' + name, true);
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') saveBtn.onclick(); };
  paintList();
})();

// the tray popup asks for a profile through localStorage (key svm.profreq)
window.addEventListener('storage', (e) => {
  if (e.key !== 'svm.profreq' || !e.newValue) return;
  try { const r = JSON.parse(e.newValue); if (r && r.name) applyProfile(r.name); } catch {}
});

poll(render);
