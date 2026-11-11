// Shared helpers: backend API (with a browser mock fallback), slider + meter utils.
const TAURI = window.__TAURI__;

// ---- theme: System / Light / Dark (setting `theme` in svm.settings.v1; the tray popup follows via the storage event) ----
function applyTheme() {
  let pref = 'system';
  try { pref = (JSON.parse(localStorage.getItem('svm.settings.v1')) || {}).theme || 'system'; } catch {}
  const classic = pref === 'classic';
  const light = pref === 'light' || (pref !== 'dark' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = classic ? 'classic' : light ? 'light' : 'dark';
  const sb = document.getElementById('sb-theme');
  if (sb) sb.textContent = pref === 'system' ? 'System' : pref === 'light' ? 'Light' : pref === 'classic' ? 'Windows classic' : 'Dark';
}
applyTheme();
try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme); } catch {}
window.addEventListener('storage', (e) => { if (!e.key || e.key === 'svm.settings.v1') applyTheme(); });

// ---- settings .ini next to the exe + crash log (the Rust side injects window.__SVM_INI__ before page scripts) ----
(function () {
  const RE = /^svm\.([a-z]+)\.v\d+$/;
  const rawSet = Storage.prototype.setItem;
  const rawRm = Storage.prototype.removeItem;
  const decode = (v) => { try { return JSON.parse(v); } catch { return v; } };
  const word = (v) => typeof v === 'string' && /^[A-Za-z][\w-]*$/.test(v) && !['true', 'false', 'null'].includes(v);
  const ini = window.__SVM_INI__ || {};
  const hasIni = Object.keys(ini).length > 0;
  for (const [sec, kv] of Object.entries(ini)) {
    const o = {};
    for (const [k, v] of Object.entries(kv)) { try { o[decodeURIComponent(k)] = decode(v); } catch {} }
    rawSet.call(localStorage, 'svm.' + sec + '.v1', JSON.stringify(o));
  }
  function build() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (RE.test(k)) keys.push(k); }
    let out = '; SailHighSea VM settings. Edit while the app is closed.\n';
    for (const k of keys.sort()) {
      let o; try { o = JSON.parse(localStorage.getItem(k)); } catch { continue; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      out += '\n[' + RE.exec(k)[1] + ']\n';
      for (const [f, v] of Object.entries(o)) out += encodeURIComponent(f) + '=' + (word(v) ? v : JSON.stringify(v)) + '\n';
    }
    return out;
  }
  let t;
  const schedule = () => { if (!TAURI) return; clearTimeout(t); t = setTimeout(() => TAURI.core.invoke('save_ini', { text: build() }).catch(() => {}), 400); };
  Storage.prototype.setItem = function (k, v) { rawSet.call(this, k, v); if (this === localStorage && RE.test(k)) schedule(); };
  Storage.prototype.removeItem = function (k) { rawRm.call(this, k); if (this === localStorage && RE.test(k)) schedule(); };
  if (!hasIni) schedule();

  const seen = new Map();
  const logCrash = (kind, message) => {
    if (!TAURI) return;
    const key = kind + message.slice(0, 200), now = Date.now();
    if (now - (seen.get(key) || 0) < 10000) return; // don't flood the log
    seen.set(key, now);
    TAURI.core.invoke('log_crash', { kind, message }).catch(() => {});
  };
  window.addEventListener('error', (e) => logCrash('JS ERROR (' + location.pathname.split('/').pop() + ')', `${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}\n${(e.error && e.error.stack) || ''}`));
  window.addEventListener('unhandledrejection', (e) => logCrash('JS UNHANDLED REJECTION (' + location.pathname.split('/').pop() + ')', String((e.reason && e.reason.stack) || e.reason)));
})();

// ---- mock backend, used when opened in a plain browser (design preview) ----
const mock = {
  devices: [
    { id: 'dev|1', name: 'Speakers', sub: 'Realtek Audio', volume: .62, muted: false, peak: 0, is_default: true },
    { id: 'dev|2', name: 'Headphones', sub: 'USB DAC', volume: .48, muted: false, peak: 0, is_default: false },
    { id: 'dev|3', name: 'Monitor', sub: 'NVIDIA HDMI', volume: .8, muted: false, peak: 0, is_default: false },
  ],
  apps: [
    { id: 'app|1', name: 'Spotify', sub: 'spotify', volume: .7, muted: false, peak: 0, device_id: 'dev|1', pid: 11, mirrors: [{ device_id: 'dev|2', volume: 0.8, delay_ms: 35 }] },
    { id: 'app|2', name: 'Discord', sub: 'discord', volume: .85, muted: false, peak: 0, device_id: 'dev|2', pid: 12, mirrors: [] },
    { id: 'app|3', name: 'Chrome', sub: 'chrome', volume: .55, muted: false, peak: 0, device_id: 'dev|1', pid: 13, mirrors: [] },
  ],
  t: 0,
};
function mockState() {
  mock.t += 0.3;
  const jig = (i) => Math.max(0, (Math.sin(mock.t + i) * 0.5 + 0.5) * (0.4 + Math.random() * 0.6));
  mock.devices.forEach((d, i) => (d.peak = d.muted ? 0 : jig(i)));
  mock.apps.forEach((a, i) => (a.peak = a.muted ? 0 : jig(i + 3)));
  return JSON.parse(JSON.stringify({ devices: mock.devices, apps: mock.apps }));
}
const find = (id) => mock.devices.concat(mock.apps).find((x) => x.id === id);

const api = {
  state: () => (TAURI ? TAURI.core.invoke('get_state') : Promise.resolve(mockState())),
  setVolume: (id, volume) =>
    TAURI ? TAURI.core.invoke('set_volume', { id, volume }) : Promise.resolve((find(id).volume = volume)),
  setMute: (id, muted) =>
    TAURI ? TAURI.core.invoke('set_mute', { id, muted }) : Promise.resolve((find(id).muted = muted)),
  setRoute: (appId, deviceId) =>
    TAURI
      ? TAURI.core.invoke('set_route', { appId, deviceId })
      : Promise.resolve((find(appId).device_id = deviceId)),
  setMirrors: (pid, mirrors) =>
    TAURI
      ? TAURI.core.invoke('set_mirrors', { pid, mirrors })
      : Promise.resolve(mock.apps.filter((a) => a.pid === pid).forEach((a) => (a.mirrors = mirrors))),
  setEq: (pid, enabled, preamp, gains) =>
    TAURI ? TAURI.core.invoke('set_eq', { pid, enabled, preamp, gains }) : Promise.resolve(mock.apps.filter((a) => a.pid === pid).forEach((a) => (a.eq = { enabled, preamp, gains }))),
  setDynamics: (pid, cfg) =>
    TAURI ? TAURI.core.invoke('set_dynamics', { pid, cfg }) : Promise.resolve(mock.apps.filter((a) => a.pid === pid).forEach((a) => (a.dynamics = { ...cfg, reduction: cfg.comp_on ? Math.random() * 6 : 0 }))),
  setTakeover: (pid, appId, park, enable) =>
    TAURI ? TAURI.core.invoke('set_takeover', { pid, appId, park, enable }) : Promise.resolve(),
  setDefault: (id) =>
    TAURI ? TAURI.core.invoke('set_default_device', { id }) : Promise.resolve(mock.devices.forEach((d) => (d.is_default = d.id === id))),
  openMain: () => TAURI && TAURI.core.invoke('open_main'),
  appIcon: (pid) => (TAURI && pid ? TAURI.core.invoke('app_icon', { pid }) : Promise.resolve(null)),
};

function deviceIcon(name) {
  const n = name.toLowerCase();
  if (/head(phone|set)|buds|airpods/.test(n)) return '🎧';
  if (/hdmi|monitor|display|tv/.test(n)) return '🖥';
  if (/cable|virtual|voicemeeter|loopback|obs/.test(n)) return '🎙';
  return '🔊';
}
const appColors = ['#35d07f', '#7c6cff', '#f2c744', '#ff7a59', '#4cc2ff', '#ff6fb5', '#6fe3d2'];
function appColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return appColors[h % appColors.length];
}

// Real application icons (Windows): fetched once per app, cached; falls back to a coloured letter tile.
const iconCache = new Map(); // 'name|sub' -> data URL | null
const iconTry = new Map();
function paintLogo(el, a) {
  // keyed by the exe, not the title: players such as mpv put the track and time in the name
  const key = a.sub || a.name;
  const now = Date.now();
  if (!iconCache.has(key) || (!iconCache.get(key) && a.pid && now - (iconTry.get(key) || 0) > 4000)) {
    if (!iconCache.has(key)) iconCache.set(key, null);
    iconTry.set(key, now);
    api.appIcon(a.pid).then((u) => { if (u) iconCache.set(key, u); }).catch(() => {});
  }
  const url = iconCache.get(key);
  if (url) {
    if (el.dataset.ic !== url) {
      el.dataset.ic = url;
      el.textContent = '';
      el.style.background = 'url(' + url + ') center/contain no-repeat';
    }
  } else {
    el.dataset.ic = '';
    el.textContent = (a.name[0] || '?').toUpperCase();
    el.style.background = appColor(a.name);
  }
}

function fillSlider(input) {
  input.style.setProperty('--v', input.value + '%');
}

/** Slider that reports 0..1 and exposes `.dragging` so polling doesn't fight the user. */
function makeSlider(onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'sl';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = 0;
  input.max = 100;
  wrap.append(input);
  const s = { el: wrap, input, dragging: false };
  input.addEventListener('pointerdown', () => (s.dragging = true));
  window.addEventListener('pointerup', () => (s.dragging = false));
  input.addEventListener('input', () => {
    fillSlider(input);
    onChange(input.value / 100);
  });
  s.set = (v) => {
    if (s.dragging) return;
    input.value = Math.round(v * 100);
    fillSlider(input);
  };
  return s;
}

// Themed dropdown that drives a native <select> (kept hidden, so .value/.onchange/options still work).
const ddList = [];
let ddOpen = null;
function closeDd() { if (ddOpen) { ddOpen.menu.remove(); ddOpen.btn.classList.remove('open'); ddOpen = null; } }
document.addEventListener('pointerdown', (e) => { if (ddOpen && !ddOpen.menu.contains(e.target) && !ddOpen.btn.contains(e.target)) closeDd(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDd(); });
window.addEventListener('resize', closeDd);
document.addEventListener('scroll', closeDd, true);
// Open the themed menu under `btn`. items: [{value, text}], cur: current value, onPick(value).
function openDdMenu(btn, items, cur, onPick) {
  if (ddOpen && ddOpen.btn === btn) return closeDd();
  closeDd();
  const menu = document.createElement('div');
  menu.className = 'ddm';
  items.forEach((o) => {
    const it = document.createElement('div');
    it.className = 'ddi' + (o.value === cur ? ' sel' : '');
    it.textContent = o.text;
    it.onclick = () => { closeDd(); onPick(o.value); };
    menu.append(it);
  });
  document.body.append(menu);
  const r = btn.getBoundingClientRect();
  menu.style.minWidth = Math.max(r.width, 130) + 'px';
  const mh = menu.offsetHeight;
  const up = r.bottom + mh + 8 > window.innerHeight && r.top > mh + 8;
  menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)) + 'px';
  menu.style.top = (up ? r.top - mh - 4 : r.bottom + 4) + 'px';
  btn.classList.add('open');
  ddOpen = { menu, btn };
}
function enhanceSelect(sel) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ddb' + (sel.classList.contains('eqsel') ? ' eq' : '');
  btn.title = sel.title || '';
  btn.innerHTML = '<span class="ddl"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  sel.style.display = 'none';
  sel.after(btn);
  const label = btn.querySelector('.ddl');
  const sync = () => { const o = sel.options[sel.selectedIndex]; const t = o ? o.text : ''; if (label.textContent !== t) label.textContent = t; };
  btn.onclick = () => openDdMenu(btn, [...sel.options].map((o) => ({ value: o.value, text: o.text })), sel.value, (v) => { sel.value = v; sel.dispatchEvent(new Event('change')); sync(); });
  ddList.push({ sel, btn, sync });
  sync();
}
setInterval(() => { for (let i = ddList.length - 1; i >= 0; i--) { const d = ddList[i]; if (!d.btn.isConnected) ddList.splice(i, 1); else d.sync(); } }, 250);

function makeMeter() {
  const m = document.createElement('div');
  m.className = 'meter';
  const i = document.createElement('i');
  m.append(i);
  return { el: m, set: (p) => { i.style.width = Math.min(100, p * 100) + '%'; i.style.setProperty('--full', m.clientWidth + 'px'); } };
}

let toastTimer;
function toast(msg, info) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); }
  t.textContent = msg;
  t.classList.toggle('info', !!info);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
const guard = (p) => p.catch((e) => toast(String(e)));

function poll(render, ms = 90) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { render(await api.state()); } catch (e) { toast(String(e)); }
    busy = false;
  };
  setInterval(tick, ms);
  tick();
}
