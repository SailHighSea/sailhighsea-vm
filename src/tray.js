// Tray popup: one section per output (the chosen "main" output is shown as a big hero card),
// the apps playing on each output listed under it. Drag an app onto another output to move it.
const pbody = document.getElementById('pbody');
const full = document.getElementById('full');
full.onclick = () => api.openMain();
full.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') api.openMain(); };

// Profiles saved in the main window (Settings -> Profiles): pick one here and the main window applies it
// (it holds the logic; the request travels through localStorage and its `storage` event).
const profbtn = document.getElementById('profbtn');
function pickProfile() {
  let all = {};
  try { all = JSON.parse(localStorage.getItem('svm.profiles.v1')) || {}; } catch {}
  const names = Object.keys(all);
  if (!names.length) return toast('No profiles yet. Save one in the mixer under Settings > Profiles.');
  openDdMenu(profbtn, names.map((n) => ({ value: n, text: n })), '', (n) => {
    try { localStorage.setItem('svm.profreq', JSON.stringify({ name: n, t: Date.now() })); } catch {}
    toast('Applying profile: ' + n + '…', true);
  });
}
profbtn.onclick = pickProfile;
profbtn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') pickProfile(); };

const P = {
  head: '<path d="M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1zM20 15h-3v5h2a1 1 0 0 0 1-1z"/>',
  spk: '<path d="M6 9H3v6h3l5 4V5zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  mon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  off: '<path d="M6 9H3v6h3l5 4V5zM16 9l5 6M21 9l-5 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  star: '<path d="M12 17.3l-5.2 2.7 1-5.8-4.2-4.1 5.8-.9L12 4l2.6 5.2 5.8.9-4.2 4.1 1 5.8z"/>',
};
const svg = (p, cls = '') => '<svg class="ico-s ' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' + p + '</svg>';
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function devPath(name) {
  const n = name.toLowerCase();
  if (/head(phone|set)|buds|airpods/.test(n)) return P.head;
  if (/hdmi|monitor|display|tv/.test(n)) return P.mon;
  if (/cable|virtual|voicemeeter|loopback|obs/.test(n)) return P.mic;
  return P.spk;
}
const muteIcon = (m) => svg(m ? P.off : P.spk);
const GCOL = ['#4fc3f7', '#b39dff', '#4ddb94', '#f2c744', '#ff9a73', '#f58fb4'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeVu(el, n, maxH) {
  el.innerHTML = '<i></i>'.repeat(n);
  const bars = [...el.children];
  return (peak) => {
    const lit = Math.round(Math.min(1, peak) * n);
    bars.forEach((b, i) => b.classList.toggle('hot', i < lit));
  };
}
function setMuted(el, btn, m) {
  el.classList.toggle('muted', m);
  btn.classList.toggle('act', m);
  btn.innerHTML = muteIcon(m);
}
function paintDef(btn, d) {
  btn.className = 'defbtn' + (d.is_default ? ' act' : '');
  btn.title = d.is_default ? 'This is the Windows default output' : 'Make this the default output';
  btn.innerHTML = svg(P.star) + '<span class="dl">' + (d.is_default ? 'Default' : 'Set default') + '</span>';
  btn.onclick = () => { if (!d.is_default) guard(api.setDefault(d.id)); };
}

let lastState = null;
const rows = new Map();
const groups = new Map();
let gSig = '';
let heroId = null;
try { heroId = localStorage.getItem('svm.popup.hero'); } catch {}

// ---------- moving an app to another output ----------
const loadJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const mirrorList = (a) => a.mirrors.map((m) => ({ device_id: m.device_id, volume: m.volume, delay_ms: m.delay_ms }));
const devNameOf = (id) => ((lastState && lastState.devices.find((d) => d.id === id)) || {}).name || 'output';
const sameApp = (a, x) => x.name === a.name && x.sub === a.sub;
async function allMoved(pids, names, devId) {
  const st = await api.state();
  return pids.every((pid) => st.apps.some((x) => (pid ? x.pid === pid : names.includes(x.name)) && x.device_id === devId));
}
async function moveApp(a, devId) {
  if (!a || a.device_id === devId) return;
  const to = devNameOf(devId);
  // multi-process apps (Teams, browsers...) have several streams: move all of them together
  const sibs = lastState.apps.filter((x) => sameApp(a, x) && x.device_id === a.device_id);
  const pids = [...new Set(sibs.map((x) => x.pid))];
  toast('Moving ' + a.name + ' to ' + to + '…', true);
  let ok = false;
  for (let i = 0; i < 2 && !ok; i++) {
    try {
      const done = new Set();
      for (const s of sibs) { if (done.has(s.pid)) continue; done.add(s.pid); await api.setRoute(s.id, devId); }
    } catch (e) { return toast(String(e)); }
    await sleep(i ? 1500 : 700);
    try { ok = await allMoved(pids, [a.name], devId); } catch { ok = false; }
  }
  if (!ok) return toast(a.name + ' did not switch to ' + to + '. Some apps keep their own output; check its audio settings.');
  const next = mirrorList(a).filter((m) => m.device_id !== devId);
  if (next.length !== a.mirrors.length) {
    if (loadJ('svm.settings.v1', {}).remember !== false) {
      const s = loadJ('svm.mirrors.v1', {});
      const k = a.name + '|' + a.sub;
      if (next.length) s[k] = next; else delete s[k];
      try { localStorage.setItem('svm.mirrors.v1', JSON.stringify(s)); } catch {}
    }
    guard(api.setMirrors(a.pid, next));
  }
  toast(a.name + ' now plays on ' + to, true);
}

// Output chip: shows which device the app plays on; click to choose another.
function makeOutBtn(getApp) {
  const b = document.createElement('button');
  b.className = 'chip-out';
  b.onclick = () => {
    const a = getApp();
    if (!a || !lastState) return;
    openDdMenu(b, lastState.devices.map((d) => ({ value: d.id, text: d.name })), a.device_id, (id) => moveApp(getApp(), id));
  };
  b.paint = (a) => {
    const i = lastState.devices.findIndex((x) => x.id === a.device_id);
    const d = lastState.devices[i];
    const sig = a.device_id + (d ? d.name : '');
    if (b.dataset.sig === sig) return;
    b.dataset.sig = sig;
    b.style.setProperty('--c', GCOL[(i < 0 ? 0 : i) % GCOL.length]);
    b.title = 'Plays on ' + (d ? d.name : 'output') + '. Click to choose another output, or drag the app onto one.';
    b.setAttribute('aria-label', 'Output for ' + a.name + ': ' + (d ? d.name : 'unknown'));
    b.innerHTML = svg(d ? devPath(d.name + ' ' + d.sub) : P.spk);
  };
  return b;
}

// ---------- app rows ----------
function makeRow(a) {
  const el = document.createElement('div');
  el.className = 'r';
  el.innerHTML = '<div class="logo2" title="Drag onto an output to move this app"></div><div class="mid"><div class="line"><span class="nm" title="Drag onto an output to move this app"></span><span class="adot" title="Playing audio"></span><span class="p"></span></div><div class="slot"></div></div>';
  const p = el.querySelector('.p');
  const slider = makeSlider((v) => { p.textContent = Math.round(v * 100) + '%'; guard(api.setVolume(a.id, v)); });
  el.querySelector('.slot').append(slider.el);
  const mute = document.createElement('button');
  mute.className = 'pmute';
  mute.innerHTML = muteIcon(false);
  mute.onclick = () => { const m = !mute.classList.contains('act'); setMuted(el, mute, m); guard(api.setMute(a.id, m)); };
  const out = makeOutBtn(() => rows.get(a.id) && rows.get(a.id).app);
  el.querySelector('.line').insertBefore(out, p);
  el.append(mute);
  const dot = el.querySelector('.adot');
  const vu = (peak) => dot.classList.toggle('on', peak > 0.02);
  return { el, p, slider, mute, out, app: a, vu, logo: el.querySelector('.logo2'), nm: el.querySelector('.nm') };
}
function updateRow(r, a) {
  paintLogo(r.logo, a);
  r.app = a;
  r.out.paint(a);
  r.nm.textContent = a.name;
  r.slider.set(a.volume);
  if (!r.slider.dragging) r.p.textContent = Math.round(a.volume * 100) + '%';
  setMuted(r.el, r.mute, a.muted);
  r.vu(a.muted ? 0 : a.peak);
}

// ---------- output sections ----------
function chooseHero(id) {
  heroId = id;
  try { localStorage.setItem('svm.popup.hero', id); } catch {}
  if (lastState) render(lastState);
}
function buildGroup(d, i) {
  const el = document.createElement('div');
  el.className = 'pgrp';
  el.dataset.dev = d.id;
  el.style.setProperty('--gc', GCOL[i % GCOL.length]);
  el.innerHTML =
    '<div class="gh2"><span class="gic"></span><button class="gname" title="Show this output as the main one"></button><button class="defbtn"></button><div class="gsl"></div><span class="gpc"></span><button class="pmute" aria-label="Mute"></button></div>' +
    '<div class="hc"><div class="hc-top"><span class="gic"></span><span class="gname2"></span><span class="sp"></span><button class="defbtn"></button><button class="pmute" aria-label="Mute"></button></div>' +
    '<div class="hbody"><div class="bn"><span class="big">0</span><span class="unit">%</span></div><div class="hr"><div class="hslot"></div><div class="vu"></div></div></div></div>' +
    '<div class="gb"></div>';
  const g = { el, gh: el.querySelector('.gh2'), hc: el.querySelector('.hc'), body: el.querySelector('.gb'), n: 0 };
  const defs = el.querySelectorAll('.defbtn');
  const mutes = el.querySelectorAll('.pmute');
  [g.def1, g.def2] = defs;
  [g.mute1, g.mute2] = mutes;
  const icon = devPath(d.name + ' ' + d.sub);
  el.querySelectorAll('.gic').forEach((x) => (x.innerHTML = svg(icon)));
  const nameBtn = el.querySelector('button.gname');
  nameBtn.textContent = d.name;
  nameBtn.onclick = () => chooseHero(d.id);
  el.querySelector('.gname2').textContent = d.name;
  g.pc = el.querySelector('.gpc');
  g.big = el.querySelector('.big');
  g.sl1 = makeSlider((v) => { g.pc.textContent = Math.round(v * 100); g.big.textContent = Math.round(v * 100); guard(api.setVolume(g.id, v)); });
  g.sl2 = makeSlider((v) => { g.pc.textContent = Math.round(v * 100); g.big.textContent = Math.round(v * 100); guard(api.setVolume(g.id, v)); });
  g.id = d.id;
  el.querySelector('.gsl').append(g.sl1.el);
  el.querySelector('.hslot').append(g.sl2.el);
  g.vu = makeVu(el.querySelector('.vu'), 12, 0);
  const muteFn = (btn) => () => { const m = !btn.classList.contains('act'); setMuted(g.gh, g.mute1, m); setMuted(g.hc, g.mute2, m); guard(api.setMute(d.id, m)); };
  g.mute1.onclick = muteFn(g.mute1);
  g.mute2.onclick = muteFn(g.mute2);
  g.mute1.innerHTML = g.mute2.innerHTML = muteIcon(false);
  return g;
}

function render(st) {
  lastState = st;
  if (!st.devices.length) return;
  const sig = st.devices.map((d) => d.id + d.name).join(',');
  if (sig !== gSig) {
    gSig = sig;
    pbody.innerHTML = '';
    groups.clear();
    st.devices.forEach((d, i) => { const g = buildGroup(d, i); groups.set(d.id, g); pbody.append(g.el); });
  }
  if (!heroId || !groups.has(heroId)) heroId = (st.devices.find((d) => d.is_default) || st.devices[0]).id;

  st.devices.forEach((d) => {
    const g = groups.get(d.id);
    const hero = d.id === heroId;
    g.el.classList.toggle('hero', hero);
    g.sl1.set(d.volume);
    g.sl2.set(d.volume);
    if (!g.sl1.dragging && !g.sl2.dragging) { g.pc.textContent = Math.round(d.volume * 100); g.big.textContent = Math.round(d.volume * 100); }
    paintDef(g.def1, d);
    paintDef(g.def2, d);
    setMuted(g.gh, g.mute1, d.muted);
    setMuted(g.hc, g.mute2, d.muted);
    if (hero) g.vu(d.muted ? 0 : d.peak);
    g.n = 0;
  });

  const seen = new Set(st.apps.map((a) => a.id));
  for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
  st.apps.forEach((a) => {
    const g = groups.get(a.device_id);
    if (!g) return;
    if (!rows.has(a.id)) rows.set(a.id, makeRow(a));
    const r = rows.get(a.id);
    updateRow(r, a);
    const moved = r.el.parentNode !== g.body;
    if (g.body.children[g.n] !== r.el) g.body.insertBefore(r.el, g.body.children[g.n] || null);
    g.n++;
    if (moved && r.el.dataset.placed) { r.el.classList.remove('landed'); void r.el.offsetWidth; r.el.classList.add('landed'); }
    r.el.dataset.placed = '1';
  });
  groups.forEach((g) => g.el.classList.toggle('empty', g.n === 0));
}

// ---------- drag an app onto an output ----------
(function () {
  let st = null; // { x, y, row, app, active, ghost, target, timer }
  const rowOf = (el) => { const re = el.closest('.r'); return re ? [...rows.values()].find((r) => r.el === re) : null; };
  const groupAt = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.closest('.pgrp'); };
  function end(drop) {
    if (!st) return;
    clearInterval(st.timer);
    if (st.ghost) st.ghost.remove();
    document.body.classList.remove('dragging');
    pbody.querySelectorAll('.dropok').forEach((g) => g.classList.remove('dropok'));
    st.row.el.classList.remove('dragsrc');
    const s = st;
    st = null;
    if (drop && s.active && s.target && s.target !== s.row.app.device_id) moveApp(s.row.app, s.target);
  }
  pbody.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.target.closest('.r .logo2, .r .line .nm')) return;
    const row = rowOf(e.target);
    if (row) st = { x: e.clientX, y: e.clientY, row, active: false, ghost: null, target: null, timer: 0, py: e.clientY };
  });
  window.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < 6) return;
      st.active = true;
      document.body.classList.add('dragging');
      st.row.el.classList.add('dragsrc');
      const g = document.createElement('div');
      g.className = 'ghost';
      g.innerHTML = '<span class="gl"></span><span class="gt"></span>';
      g.querySelector('.gl').style.background = st.row.logo.style.background;
      g.querySelector('.gt').textContent = st.row.app.name;
      document.body.append(g);
      st.ghost = g;
      // auto-scroll the list while dragging near its top or bottom edge
      st.timer = setInterval(() => {
        const r = pbody.getBoundingClientRect();
        if (st.py < r.top + 28) pbody.scrollTop -= 10;
        else if (st.py > r.bottom - 28) pbody.scrollTop += 10;
      }, 30);
    }
    st.py = e.clientY;
    st.ghost.style.transform = 'translate(' + (e.clientX + 10) + 'px,' + (e.clientY + 6) + 'px)';
    const g = groupAt(e.clientX, e.clientY);
    st.target = g ? g.dataset.dev : null;
    pbody.querySelectorAll('.pgrp').forEach((x) => x.classList.toggle('dropok', x === g && g.dataset.dev !== st.row.app.device_id));
  });
  window.addEventListener('pointerup', () => end(true));
  window.addEventListener('pointercancel', () => end(false));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') end(false); });
})();

poll(render, 120);
