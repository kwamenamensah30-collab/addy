// Addy: collect classified ground points and ground-truth validation points.
import { dist, bearing, cardinal, fmtDist, toUTM, fromUTM, averageFixes } from './geo.js';
import { parseCSV, toCSV, guessColumns, pointsFromGeoJSON, kmlToGeoJSON, toGeoJSON, toKML, toGPXWaypoints, trackToGPX, download } from './io.js';
import { store } from './db.js';
import { PRESETS, toClasses, parseClassText, classText } from './presets.js';
import { Router, buildGraph, polylinesFromOverpass, polylinesFromGeoJSON, polylinesFromOsmXml, downloadOsmRoads, onlineRoute, progressOn, remaining, fmtDuration, MODES, OFFROAD_KMH, CLASSES } from './route.js';

// ================= small helpers =================
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const slug = s => String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'project';
const fmtTime = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
const round = (v, n) => v == null || v === '' || !Number.isFinite(+v) ? '' : +(+v).toFixed(n);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let toastT;
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

// ================= state =================
const APP_BUILD = '2026-11-25.1';
const SETTINGS_KEY = 'addy.settings', AUTH_KEY = 'addy.auth';
const settings = Object.assign({ base: 'osm', labels: true, track: true, alert: true, arrive: 20, avgN: 10, mode: 'collect', lastProject: null, activeDs: {}, target: {}, travel: 'walk', onlineRoute: true, showRoads: false },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const S = {
  // {user} kept so the app opens offline. The session itself is an HttpOnly cookie the page cannot read.
  // Older versions also stored {token}; it is sent once more as a Bearer header, the server moves it into the cookie, and it is dropped.
  auth: JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'),
  online: navigator.onLine,
  projects: [],
  project: null,
  points: new Map(),     // id -> point (incl. soft-deleted)
  datasets: new Map(),   // id -> dataset with .targets
  mode: settings.mode,
  dsId: null,
  targetId: null,
  me: null,              // last GPS fix
  follow: true,
  track: [],
  overlays: [],          // [{id,name,geojson,on}]
  syncing: false,
  syncErr: null,
  router: null,          // offline road router for this project
  roadsMeta: null,       // {ways, nodes, source, fetched_at, bbox}
  roadsBusy: false,
  roadsAuto: false,      // auto-download already tried this session
  route: null,           // current route to the target
  routeBusy: false,
  navAim: null,          // point ahead on the road the arrow aims at
};
const user = () => S.auth && S.auth.user;
const canManage = () => user() && user().role !== 'collector';
// admins and managers edit any project; anyone else edits the ones they created (the server checks this too)
const canEditProject = p => !!p && !!user() && (canManage() || p.created_by === user().id || p.can_edit === true);
function saveAuth(u) {
  S.auth = { user: u };
  localStorage.setItem(AUTH_KEY, JSON.stringify(S.auth));
}
function clearAuth() { S.auth = null; localStorage.removeItem(AUTH_KEY); }

// ================= API =================
async function api(method, url, body) {
  // X-Addy marks the request as coming from this app; the server refuses cookie requests without it
  const headers = { 'Content-Type': 'application/json', 'X-Addy': '1' };
  const legacy = S.auth && S.auth.token;
  if (legacy) headers.Authorization = 'Bearer ' + legacy;
  let r;
  try { r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'same-origin' }); }
  catch (e) { const err = new Error('No connection to the server.'); err.offline = true; throw err; }
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) { const e = new Error((j && j.error) || `Server error (${r.status})`); e.status = r.status; throw e; }
  // the server has now put the old token into the session cookie
  if (legacy && S.auth && S.auth.token === legacy) { delete S.auth.token; localStorage.setItem(AUTH_KEY, JSON.stringify(S.auth)); }
  return j;
}

// ================= reveal / hide with a transition =================
// Elements start [hidden]; .show is added on the next frame so the CSS transition runs, and [hidden] returns after it ends.
function reveal(el) {
  if (!el) return;
  clearTimeout(el._hideT);
  el.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
}
function conceal(el, ms = 220) {
  if (!el || el.hidden) return;
  el.classList.remove('show');
  clearTimeout(el._hideT);
  el._hideT = setTimeout(() => { el.hidden = true; }, ms);
}
function hideSplash() { const s = $('#splash'); if (s && !s.classList.contains('gone')) { s.classList.add('gone'); setTimeout(() => s.remove(), 500); } }

// ================= sign in, first-run setup, first password =================
// login:  username + password.
// setup:  the very first visit to a new server; creates the admin account (step 1 of 2; step 2 is the first project).
// change: an account an admin created (or reset) must choose its own password at its first sign-in.
let authMode = 'login', pendingPw = '';
function showAuth(mode, msg) {
  authMode = mode;
  hideSplash();
  conceal($('#hub'));
  reveal($('#auth'));
  const setup = mode === 'setup', change = mode === 'change';
  const u = user();
  $('#authSteps').hidden = !setup;
  $('#authNameRow').hidden = !setup;
  $('#authUserRow').hidden = change;
  $('#authCurRow').hidden = !(change && !pendingPw);
  $('#authPass2Row').hidden = !(setup || change);
  $('#pwMeter').hidden = !(setup || change);
  $('#authRememberRow').hidden = change;
  $('#authPass').autocomplete = setup || change ? 'new-password' : 'current-password';
  $('#authPassLbl').textContent = change ? 'New password' : 'Password';
  $('#authBtnTxt').textContent = setup ? 'Create admin account' : change ? 'Save password and continue' : 'Sign in';
  $('#authHeading').textContent = setup ? 'Welcome to Addy' : change ? `Welcome${u ? ', ' + u.name.split(' ')[0] : ''}` : 'Welcome back';
  $('#authIntro').textContent = setup
    ? 'This server is new. Create the administrator account for your team to get started.'
    : change ? 'This is your first sign-in. Choose your own password to replace the temporary one your admin gave you.'
      : 'Sign in with the account your team admin gave you.';
  const callout = $('#authCallout');
  callout.hidden = !setup;
  callout.innerHTML = setup ? '<svg class="ic sm"><use href="#i-shield"/></svg><span>You are the first person here, so this account becomes the <b>admin</b>. You can then add collectors and managers, and anyone on the team can create projects.</span>' : '';
  $('#authFoot').textContent = setup || change ? '' : 'No account? Ask your project admin to add you.';
  $('#authErr').textContent = msg || '';
  $('#authPass').value = $('#authPass2').value = $('#authCur').value = '';
  pwMeter();
  if (!localStorage.getItem('addy.cookieOk')) reveal($('#cookieNote'));
  setTimeout(() => (setup ? $('#authName') : change ? (pendingPw ? $('#authPass') : $('#authCur')) : $('#authUser')).focus(), 80);
}
function hideAuth() { conceal($('#auth'), 320); conceal($('#cookieNote')); }

// password strength: length and variety, shown as four bars
function pwScore(pw) {
  if (!pw) return 0;
  let s = pw.length >= 6 ? 1 : 0;
  if (pw.length >= 10) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  else if (/\d|[^A-Za-z0-9]/.test(pw) && pw.length >= 12) s++;
  return Math.min(4, s);
}
function pwMeter() {
  const pw = $('#authPass').value, s = pwScore(pw);
  $('#pwMeter').dataset.s = String(s);
  $('#pwMeterTxt').textContent = !pw ? 'At least 6 characters' : pw.length < 6 ? 'Too short' : ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s];
}
$('#authPass').addEventListener('input', pwMeter);
$$('.pwEye').forEach(b => b.addEventListener('click', () => {
  const i = $('#' + b.dataset.eye), show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  b.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
  i.focus();
}));
$('#cookieOk').addEventListener('click', () => { localStorage.setItem('addy.cookieOk', '1'); conceal($('#cookieNote')); });

function setAuthBusy(on) { $('#authBtn').disabled = on; $('#authBtn').classList.toggle('busy', on); }
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('#authUser').value.trim(), password = $('#authPass').value, remember = $('#authRemember').checked;
  const fail = (msg, el) => { $('#authErr').textContent = msg; $('#authForm').classList.remove('shake'); void $('#authForm').offsetWidth; $('#authForm').classList.add('shake'); if (el) el.focus(); };
  $('#authErr').textContent = '';
  if (authMode === 'setup' && !$('#authName').value.trim()) return fail('Enter your full name.', $('#authName'));
  if (authMode !== 'change' && !username) return fail('Enter your username.', $('#authUser'));
  if (authMode === 'setup' && !/^[A-Za-z0-9._-]{2,40}$/.test(username)) return fail('Username: 2–40 letters, numbers, dot, dash or underscore (no spaces).', $('#authUser'));
  if (!password) return fail('Enter a password.', $('#authPass'));
  if ((authMode === 'setup' || authMode === 'change') && password.length < 6) return fail('Password must be at least 6 characters.', $('#authPass'));
  if ((authMode === 'setup' || authMode === 'change') && password !== $('#authPass2').value) return fail('The two passwords do not match.', $('#authPass2'));
  setAuthBusy(true);
  try {
    if (authMode === 'change') {
      const current = pendingPw || $('#authCur').value;
      const r = await api('POST', '/api/me/password', { current, next: password });
      pendingPw = '';
      saveAuth(r.user);
      hideAuth();
      toast('Password saved. Welcome to Addy.');
      await afterLogin({ fresh: true });
      return;
    }
    const r = authMode === 'setup'
      ? await api('POST', '/api/setup', { name: $('#authName').value.trim(), username, password, remember })
      : await api('POST', '/api/login', { username, password, remember });
    saveAuth(r.user);
    if (r.user.must_change) { pendingPw = password; showAuth('change'); return; }
    const wasSetup = authMode === 'setup';
    hideAuth();
    await afterLogin({ fresh: true, firstRun: wasSetup });
  } catch (err) {
    fail(err.offline ? 'Cannot reach the server. Connect to the internet or your team Wi-Fi to sign in the first time.' : err.message);
  } finally { setAuthBusy(false); $('#authPass').value = $('#authPass2').value = ''; pwMeter(); }
});

async function logout() {
  const unsynced = [...S.points.values()].filter(p => p.dirty).length + [...S.datasets.values()].filter(d => d.dirty).length;
  if (unsynced) {
    const ok = await dialog({ title: 'Sign out?', text: `${unsynced} item(s) on this device have not reached the server yet. They stay on this device and will be sent the next time someone signs in here with signal. Sign out anyway?`, okText: 'Sign out' });
    if (!ok) return;
  }
  try { await api('POST', '/api/logout'); } catch { /* offline is fine */ }
  clearAuth();
  closeSheets();
  location.reload();
}

// ================= dialog =================
function dialog({ title, text = '', fields = [], okText = 'OK', cancelText = 'Cancel', validate }) {
  return new Promise(resolve => {
    $('#dlgTitle').textContent = title; $('#dlgText').textContent = text; $('#dlgErr').textContent = '';
    $('#dlgCancel').textContent = cancelText;
    $('#dlgOk').textContent = okText;
    const box = $('#dlgFields'); box.innerHTML = '';
    for (const f of fields) {
      const l = document.createElement('label'); l.textContent = f.label;
      const i = document.createElement('input'); i.type = f.type || 'text'; i.id = 'dlg_' + f.id; i.value = f.value || ''; if (f.autocomplete) i.autocomplete = f.autocomplete;
      l.appendChild(i); box.appendChild(l);
    }
    reveal($('#dlg'));
    setTimeout(() => (box.querySelector('input') || $('#dlgOk')).focus(), 60);
    const finish = v => { conceal($('#dlg'), 180); $('#dlgForm').onsubmit = null; $('#dlgCancel').onclick = null; resolve(v); };
    $('#dlgCancel').onclick = () => finish(null);
    $('#dlgForm').onsubmit = async e => {
      e.preventDefault();
      const vals = Object.fromEntries(fields.map(f => [f.id, $('#dlg_' + f.id).value]));
      if (validate) { const err = await validate(vals); if (err) { $('#dlgErr').textContent = err; return; } }
      finish(fields.length ? vals : true);
    };
  });
}

// ================= map =================
const map = L.map('map', { zoomControl: false, attributionControl: false, preferCanvas: true, maxZoom: 20 }).setView([7.95, -1.03], 7);
L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
$('#zoomInBtn').addEventListener('click', () => map.zoomIn());
$('#zoomOutBtn').addEventListener('click', () => map.zoomOut());
const renderer = L.canvas({ padding: 0.3 });
const BASES = {
  // OSM tile policy: send a Referer, keep the attribution visible, no bulk or offline caching of these tiles
  osm: () => [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' })],
  sat: () => [L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' })],
  hyb: () => [
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 })],
  topo: () => [L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)' })],
  none: () => [],
};
let baseLayers = [];
function setBase(key) {
  if (!BASES[key]) key = 'osm';
  baseLayers.forEach(l => map.removeLayer(l));
  baseLayers = BASES[key]();
  baseLayers.forEach(l => { l.addTo(map); l.bringToBack(); });
  settings.base = key; saveSettings();
  $$('#baseSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === key)));
}

const overlayGroup = L.layerGroup().addTo(map);
const trackLine = L.polyline([], { color: '#1a73e8', weight: 3, opacity: 0.7, dashArray: '2 6', interactive: false });
const pointLayer = L.layerGroup().addTo(map);
const targetLayer = L.layerGroup().addTo(map);
const youIcon = L.divIcon({ className: '', html: '<div class="youDot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const youMarker = L.marker([0, 0], { icon: youIcon, interactive: false, zIndexOffset: 1000, keyboard: false });
const accCircle = L.circle([0, 0], { radius: 1, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false });

map.on('dragstart', () => setFollow(false));
map.on('move', updatePosCard);
map.on('zoomend', labelVis);

function labelVis() {
  const show = settings.labels && map.getZoom() >= 16;
  for (const g of [pointLayer, targetLayer]) g.eachLayer(m => { const t = m.getTooltip && m.getTooltip(); const el = t && t.getElement && t.getElement(); if (el) el.style.display = show ? '' : 'none'; });
}

// ================= project data =================
const classes = () => (S.project ? S.project.classes : []);
const classByName = name => classes().find(c => norm(c.name) === norm(name));
function matchClass(value) {
  const v = norm(value);
  if (!v) return null;
  return classes().find(c => norm(c.name) === v || String(c.code) === v) || null;
}
const colorOf = name => (classByName(name) || {}).color || '#607d8b';
const livePoints = () => [...S.points.values()].filter(p => !p.deleted);
const liveDatasets = () => [...S.datasets.values()].filter(d => !d.deleted).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
const activeDs = () => (S.dsId && S.datasets.get(S.dsId) && !S.datasets.get(S.dsId).deleted ? S.datasets.get(S.dsId) : null);
const targetById = id => { const ds = activeDs(); return ds ? ds.targets.find(t => t.id === id) : null; };
// Latest validation visit for each target of a dataset.
function visitsFor(ds) {
  const m = new Map();
  if (!ds) return m;
  for (const p of S.points.values()) {
    if (p.deleted || p.kind !== 'validation' || p.dataset_id !== ds.id) continue;
    const cur = m.get(p.target_id);
    if (!cur || cur.created_at < p.created_at) m.set(p.target_id, p);
  }
  return m;
}
function canEdit(p) {
  const u = user();
  return !!u && (u.role !== 'collector' || p.observer_id === u.id);
}

async function loadProjects() {
  try {
    const r = await api('GET', '/api/projects');
    S.projects = r.projects; await store.set('projects', r.projects); S.online = true;
  } catch (e) {
    if (e.status === 401) throw e;
    S.projects = await store.get('projects', []);
  }
}
const visibleProjects = () => S.projects.filter(p => !p.archived || canManage());

async function openProject(id) {
  const p = S.projects.find(x => x.id === id);
  if (!p) return;
  S.project = p;
  settings.lastProject = id; saveSettings();
  $('#projName').textContent = p.name;
  S.points = new Map((await store.all('points', id)).map(x => [x.id, x]));
  S.datasets = new Map((await store.all('datasets', id)).map(x => [x.id, x]));
  S.dsId = settings.activeDs[id] || (liveDatasets()[0] || {}).id || null;
  S.targetId = settings.target[id] || null;
  S.overlays = await store.get('overlays:' + id, []);
  S.route = null; S.roadsAuto = false;
  await loadRoads(id);
  renderOverlays();
  renderAll(true);
  sync();
}

// ================= rendering =================
function pointPopup(p) {
  const el = document.createElement('div');
  const u = p.utm || (Number.isFinite(p.lat) ? toUTM(p.lat, p.lon) : null);
  const kindTxt = { training: 'Training sample', new: 'New point (ground truthing)', validation: 'Validation visit' }[p.kind] || p.kind;
  el.innerHTML = `<b>${esc(p.label)}</b><br>${esc(kindTxt)}<br>
    <span style="color:${esc(colorOf(p.cls))}">●</span> ${esc(p.cls || '—')}${p.conf ? ` · ${esc(p.conf)} confidence` : ''}<br>
    ${round(p.lat, 6)}, ${round(p.lon, 6)}${u ? `<br>UTM ${u.zone}${u.hemi} ${Math.round(u.easting)} E ${Math.round(u.northing)} N` : ''}<br>
    ${p.acc != null && p.acc !== '' ? `±${Math.round(p.acc)} m` : ''}${p.n_fix > 1 ? ` · ${p.n_fix} fixes averaged` : ''}${p.src === 'map' ? ' · placed on map' : ''}<br>
    ${p.notes ? esc(p.notes) + '<br>' : ''}<small>${esc(p.observer || '')} · ${esc(fmtTime(p.created_at))}${p.dirty ? ' · not synced yet' : ''}</small>`;
  if (p.photo) { const img = document.createElement('img'); img.src = p.photo; img.alt = 'Photo'; img.style.cssText = 'width:100%;max-width:220px;border-radius:8px;margin-top:6px;display:block'; el.appendChild(img); }
  if (canEdit(p)) {
    const b = document.createElement('div'); b.className = 'popBtns';
    const eb = document.createElement('button'); eb.className = 'chipBtn'; eb.type = 'button'; eb.textContent = 'Edit';
    eb.onclick = () => { map.closePopup(); openRecord({ edit: p }); };
    b.appendChild(eb); el.appendChild(b);
  }
  return el;
}

function renderPoints() {
  pointLayer.clearLayers();
  for (const p of livePoints()) {
    if (p.kind === 'validation' || !Number.isFinite(p.lat)) continue;
    const color = colorOf(p.cls);
    let m;
    if (p.kind === 'new') {
      m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="sqIcon" style="background:${esc(color)}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) });
    } else {
      m = L.circleMarker([p.lat, p.lon], { renderer, radius: 6.5, color: '#fff', weight: 1.8, fillColor: color, fillOpacity: 1 });
    }
    m.bindPopup(() => pointPopup(p), { maxWidth: 260 });
    m.bindTooltip(p.label || '', { permanent: true, direction: 'top', offset: [0, -6], className: 'lbl' });
    m.addTo(pointLayer);
  }
}

function targetStyle(t, v) {
  const isT = t.id === S.targetId;
  const mapped = matchClass(t.mapped);
  let fill = '#ffffff', fillOpacity = 0.85, color = mapped ? mapped.color : css('--pt') || '#1d4e89', weight = 3;
  if (v) {
    if (v.access === 'not reached') { fill = '#9e9e9e'; fillOpacity = 1; }
    else { fill = colorOf(v.cls); fillOpacity = 1; }
    if (v.agree === false) color = '#e53935';
  }
  if (isT) { color = '#e0661b'; weight = 5; }
  return { radius: isT ? 10 : 7.5, color, weight, fillColor: fill, fillOpacity };
}
const targetMarkers = new Map();
function renderTargets() {
  targetLayer.clearLayers(); targetMarkers.clear();
  const ds = activeDs();
  if (!ds || S.mode !== 'truth') return;
  const visits = visitsFor(ds);
  for (const t of ds.targets) {
    const v = visits.get(t.id);
    const m = L.circleMarker([t.lat, t.lon], { renderer, ...targetStyle(t, v) });
    m.bindTooltip(t.label, { permanent: true, direction: 'top', offset: [0, -8], className: 'lbl' });
    m.on('click', () => {
      setTarget(t.id, false);
      const el = document.createElement('div');
      el.innerHTML = `<b>${esc(t.label)}</b>${t.mapped ? `<br>Map says: ${esc(t.mapped)}` : ''}<br>${round(t.lat, 6)}, ${round(t.lon, 6)}
        ${v ? `<br>Visited: ${v.access === 'not reached' ? 'could not reach' : esc(v.cls)}${v.agree === false ? ' <b style="color:#e53935">· disagrees</b>' : v.agree ? ' · agrees' : ''}<br><small>${esc(v.observer || '')} · ${esc(fmtTime(v.created_at))}</small>` : '<br>Not visited yet'}`;
      const b = document.createElement('div'); b.className = 'popBtns';
      const rb = document.createElement('button'); rb.className = 'chipBtn'; rb.type = 'button'; rb.textContent = v ? 'Record again' : 'Record visit';
      rb.onclick = () => { map.closePopup(); openRecord({ kind: 'validation', target: t }); };
      b.appendChild(rb);
      if (v && canEdit(v)) { const eb = document.createElement('button'); eb.className = 'chipBtn'; eb.type = 'button'; eb.textContent = 'Edit visit'; eb.onclick = () => { map.closePopup(); openRecord({ edit: v }); }; b.appendChild(eb); }
      el.appendChild(b);
      L.popup({ maxWidth: 260, offset: [0, -4] }).setLatLng([t.lat, t.lon]).setContent(el).openOn(map);
    });
    m.addTo(targetLayer);
    targetMarkers.set(t.id, m);
  }
  if (S.targetId && targetMarkers.get(S.targetId)) targetMarkers.get(S.targetId).bringToFront();
}

function renderAll(fit) {
  setModeUI();
  renderPoints(); renderTargets(); labelVis();
  updateNav(); updatePosCard(); updateSyncChip();
  if ($('#listSheet').classList.contains('open')) renderList();
  if ($('#dataSheet').classList.contains('open')) renderDataSheet();
  if (fit) fitProject();
}
function fitProject() {
  const ll = [];
  if (S.mode === 'truth' && activeDs()) activeDs().targets.forEach(t => ll.push([t.lat, t.lon]));
  else livePoints().forEach(p => Number.isFinite(p.lat) && ll.push([p.lat, p.lon]));
  if (!ll.length) S.overlays.filter(o => o.on).forEach(o => { try { const b = L.geoJSON(o.geojson).getBounds(); if (b.isValid()) { ll.push(b.getSouthWest(), b.getNorthEast()); } } catch { /* ignore */ } });
  if (ll.length) map.fitBounds(L.latLngBounds(ll), { padding: [50, 50], maxZoom: 16 });
}

// ================= modes =================
function setMode(m) {
  S.mode = m; settings.mode = m; saveSettings();
  if (m === 'truth' && !activeDs()) {
    toast(liveDatasets().length ? 'Choose a validation dataset in Data.' : 'Upload validation points first: Data → Upload points file.', 4200);
  }
  renderAll(false);
}
function setModeUI() {
  const truth = S.mode === 'truth';
  $$('.modeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
  $('#nav').hidden = !truth;
  $('#recLbl').textContent = truth ? (S.targetId && targetById(S.targetId) ? 'Verify' : 'New point') : 'Record';
  $('#listLbl').textContent = truth ? 'Targets' : 'Points';
  updateCrosshair();
}
$$('.modeSeg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
function updateCrosshair() {
  $('#crosshair').hidden = !(S.mode === 'collect' && !(S.me && S.follow));
}

// ================= status bar (coordinates of GPS or map centre) =================
let posT = 0, posTimer = null;
function updatePosCard() {
  // map 'move' fires every frame; refresh at most ~15 times a second, and once more when movement stops
  const nowT = performance.now();
  clearTimeout(posTimer);
  if (nowT - posT < 66) { posTimer = setTimeout(updatePosCard, 70); return; }
  posT = nowT;
  const gps = S.me && S.follow;
  const c = gps ? S.me : (() => { const m = map.getCenter(); return { lat: m.lat, lon: m.lng }; })();
  $('#posLbl').textContent = gps ? 'GPS' : 'Map centre';
  $('#posLL').textContent = `${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
  const u = toUTM(c.lat, c.lon);
  $('#posUTM').textContent = `UTM ${u.zone}${u.hemi} ${Math.round(u.easting)} E ${Math.round(u.northing)} N`;
  const pts = livePoints();
  const today = new Date().toDateString();
  const n = pts.filter(p => new Date(p.created_at).toDateString() === today && p.observer_id === (user() || {}).id).length;
  $('#posCount').textContent = `${pts.length} points · ${n} by you today`;
}
$('#coordBtn').addEventListener('click', async () => {
  const text = $('#posLL').textContent;
  try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`); } catch { toast(text); }
});

// ================= navigation (ground truth) =================
function setTarget(id, fly) {
  S.targetId = id;
  S.route = null;
  if (id && S.mode === 'truth' && !S.router && !S.roadsAuto && !S.roadsBusy && navigator.onLine) { S.roadsAuto = true; downloadRoads(true); }
  if (S.project) { settings.target[S.project.id] = id; saveSettings(); }
  lastBand = null;
  renderTargets(); labelVis();
  const t = id && targetById(id);
  if (fly && t) map.setView([t.lat, t.lon], Math.max(map.getZoom(), 16));
  updateNav(); setModeUI();
  if ($('#listSheet').classList.contains('open')) renderList();
}
function nearestUnvisited() {
  const ds = activeDs();
  if (!ds) return null;
  const from = S.me || (() => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; })();
  const visits = visitsFor(ds);
  let best = null, bd = Infinity;
  for (const t of ds.targets) if (!visits.has(t.id)) { const d = dist(from, t); if (d < bd) { bd = d; best = t.id; } }
  return best;
}
let lastBand = null;
function bandFor(d, acc) {
  const eff = Math.max(0, d - Math.min(acc || 0, 30) * 0.5);
  const arrive = +settings.arrive || 20;
  if (eff <= arrive) return 'here'; if (eff <= 50) return 'close'; if (eff <= 200) return 'near'; return 'far';
}
const BAND_TXT = { far: 'Heading there', near: 'Within 200 m', close: 'Within 50 m', here: 'Arrived' };
const rank = b => ({ far: 0, near: 1, close: 2, here: 3 })[b];
// ---------- road routing ----------
// Routes follow OSM roads. Offline: roads downloaded for the project area, routed on the device.
// Online fallback (no roads downloaded): FOSSGIS OSRM at routing.openstreetmap.de.
const routeGroup = L.layerGroup().addTo(map);
let routeLegA = null;
const travel = () => (MODES[settings.travel] ? settings.travel : 'walk');
function drawRoute(r) {
  routeGroup.clearLayers(); routeLegA = null;
  if (!r) return;
  if (r.kind === 'direct') {
    routeLegA = L.polyline(r.coords, { color: '#d4621a', weight: 3, dashArray: '8 6', opacity: 0.95, interactive: false }).addTo(routeGroup);
    return;
  }
  L.polyline(r.road, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(routeGroup);
  L.polyline(r.road, { color: '#1a73e8', weight: 5, opacity: 1, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(routeGroup);
  routeLegA = L.polyline([r.coords[0], r.road[0]], { color: '#1a73e8', weight: 3, dashArray: '2 7', opacity: 0.9, interactive: false }).addTo(routeGroup);
  L.polyline([r.road[r.road.length - 1], r.coords[r.coords.length - 1]], { color: '#d4621a', weight: 3, dashArray: '2 7', opacity: 0.95, interactive: false }).addTo(routeGroup);
}
// Keep a route for the current target; recompute when it goes stale.
function currentRoute(t) {
  const mode = travel(), now = Date.now(), R0 = S.route;
  const same = R0 && R0.targetId === t.id && R0.mode === mode && R0.router === S.router;
  let prog = same && R0.result ? progressOn(R0.result.coords, S.me) : null;
  if (S.router && (S.router.covers(S.me) || S.router.covers(t))) {
    // routing on the device takes milliseconds, so re-plan whenever we have moved a little
    const stale = !same || !prog || prog.off > 30 || dist(S.me, R0.from) > 15 || now - R0.at > 20000;
    if (stale && (!same || now - R0.at > 1000)) {
      const result = S.router.route(S.me, t, mode);
      S.route = { targetId: t.id, mode, router: S.router, at: now, from: { ...S.me }, result, source: 'offline' };
      drawRoute(result);
      prog = progressOn(result.coords, S.me);
    }
  } else if (settings.onlineRoute && navigator.onLine) {
    const stale = !same || (prog && prog.off > 60) || !R0.result;
    if (stale && !S.routeBusy && (!same || now - R0.at > 20000)) {
      S.routeBusy = true;
      const req = { targetId: t.id, mode, router: S.router, at: now, from: { ...S.me }, result: same ? R0.result : null, source: 'online' };
      S.route = req;
      onlineRoute(S.me, t, mode).then(result => {
        if (S.route !== req) return;
        req.result = result; drawRoute(result); updateNav();
      }).catch(() => { if (S.route === req) req.failed = true; }).finally(() => { S.routeBusy = false; });
    }
  } else if (!same || !R0.result) {
    S.route = { targetId: t.id, mode, router: S.router, at: now, result: null, source: 'none' };
  }
  if (S.route && S.route.result && !prog) prog = progressOn(S.route.result.coords, S.me);
  return { r: S.route && S.route.result, prog, source: S.route ? S.route.source : 'none', failed: S.route && S.route.failed };
}
function clearRoute() { S.route = null; drawRoute(null); }
// Bearing the arrow should show: along the road ahead, or straight at the target when close / off-road.
function navBearing(t) {
  if (S.navAim) return bearing(S.me, S.navAim);
  return bearing(S.me, t);
}

function updateNav() {
  if (S.mode !== 'truth') { clearRoute(); return; }
  const ds = activeDs();
  const t = S.targetId && targetById(S.targetId);
  const nav = $('#nav');
  const idle = (title, meta, brg = '') => {
    $('#tgtId').textContent = title; $('#tgtMeta').textContent = meta;
    $('#dist').textContent = '—'; $('#brg').textContent = brg; $('#eta').textContent = ''; $('#routeInfo').textContent = '';
    nav.dataset.band = 'far'; $('#band').textContent = S.me ? 'GPS on' : 'GPS off'; clearRoute(); setArrow(null); S.navAim = null;
  };
  if (!ds) return idle('No dataset', 'Data → Upload points file');
  const visits = visitsFor(ds);
  if (!t) return idle(ds.name, `${visits.size} of ${ds.targets.length} visited · tap a target or Nearest`);
  const v = visits.get(t.id);
  $('#tgtId').textContent = t.label;
  const metaBits = [t.mapped ? `Map: ${t.mapped}` : '', v ? (v.access === 'not reached' ? 'not reached' : `visited: ${v.cls}`) : '', `${visits.size}/${ds.targets.length} done`];
  if (!S.me) { idle(t.label, metaBits.filter(Boolean).join(' · '), 'Start GPS to navigate'); $('#tgtId').textContent = t.label; return; }

  const d = dist(S.me, t), b = bearing(S.me, t);
  const band = bandFor(d, S.me.acc);
  nav.dataset.band = band; $('#band').textContent = BAND_TXT[band];
  $('#tgtMeta').textContent = [`Straight ${fmtDist(d)} ${Math.round(b)}° ${cardinal(b)}`, ...metaBits].filter(Boolean).join(' · ');
  const m = MODES[travel()];
  $('#travelBtn').textContent = m.label;

  if (d < 60) {
    // last stretch: go straight for the point
    S.navAim = null; drawRoute({ kind: 'direct', coords: [[S.me.lat, S.me.lon], [t.lat, t.lon]] }); S.route = null;
    $('#dist').textContent = fmtDist(d);
    $('#brg').textContent = d < 8 ? 'You are at the point' : `${Math.round(b)}° ${cardinal(b)}`;
    $('#eta').textContent = `±${Math.round(S.me.acc)} m GPS`;
    $('#routeInfo').textContent = 'Walk straight to the point';
  } else {
    const { r, prog, source, failed } = currentRoute(t);
    if (r && prog) {
      const rem = r.kind === 'road' ? remaining(r, prog) : { dist: d, time: d / (OFFROAD_KMH / 3.6), road: 0 };
      $('#dist').textContent = fmtDist(rem.dist);
      const toRoad = r.kind === 'road' && prog.onFirstLeg ? dist(S.me, { lat: r.road[0][0], lon: r.road[0][1] }) : 0;
      const walking = toRoad + (r.kind === 'road' ? r.offB : 0);
      const how = r.kind !== 'road' || travel() === 'walk' ? 'walk' : walking > 150 ? `${m.verb} + walk` : m.verb;
      $('#brg').textContent = `${fmtDuration(rem.time)} ${how}`;
      $('#eta').textContent = `arrive ${new Date(Date.now() + rem.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (r.kind === 'road') {
        S.navAim = prog.onFinalLeg ? null : prog.aim;
        const parts = [];
        if (toRoad > 25) parts.push(`walk ${fmtDist(toRoad)} to the road`);
        if (rem.road > 25) parts.push(`${fmtDist(rem.road)} by road`);
        if (r.offB > 25) parts.push(`${fmtDist(r.offB)} off-road to the point`);
        $('#routeInfo').textContent = parts.join(', then ').replace(/^./, c => c.toUpperCase()) + (source === 'online' ? ' (online route)' : '');
        if (routeLegA) routeLegA.setLatLngs([[S.me.lat, S.me.lon], r.road[0]]);
      } else {
        S.navAim = null;
        $('#routeInfo').textContent = { 'direct-faster': 'Straight line is quicker than the roads here', 'no-road': 'No road within 3 km · straight line', 'no-connection': 'Roads here do not connect · straight line' }[r.reason] || 'Straight line';
        if (routeLegA) routeLegA.setLatLngs([[S.me.lat, S.me.lon], [t.lat, t.lon]]);
      }
    } else {
      S.navAim = null;
      drawRoute({ kind: 'direct', coords: [[S.me.lat, S.me.lon], [t.lat, t.lon]] });
      $('#dist').textContent = fmtDist(d);
      $('#brg').textContent = `${fmtDuration(d / (OFFROAD_KMH / 3.6))} walk`;
      $('#eta').textContent = '';
      $('#routeInfo').textContent = S.roadsBusy ? 'Downloading roads… straight line for now'
        : source === 'online' && !failed ? 'Finding a road route…'
        : 'Straight line · download roads (Map layers) for road routes';
    }
  }
  setArrow(navBearing(t));
  if (lastBand !== null && band !== lastBand && rank(band) > rank(lastBand)) alertBand(band, t);
  lastBand = band;
}
$('#travelBtn').addEventListener('click', () => {
  const order = ['walk', 'moto', 'car'];
  settings.travel = order[(order.indexOf(travel()) + 1) % order.length]; saveSettings();
  if ($('#optTravel')) $('#optTravel').value = settings.travel;
  S.route = null; updateNav();
  toast(`Travel mode: ${MODES[settings.travel].label}`);
});
function setArrow(b) {
  const arrow = $('#arrow');
  if (b == null) { arrow.style.transform = ''; $('#compassTag').textContent = 'north up'; return; }
  const h = compassOn && heading != null ? heading : (S.me && S.me.heading != null && S.me.speed > 0.6 ? S.me.heading : null);
  $('#compassTag').textContent = h != null ? (compassOn && heading != null ? 'compass' : 'walking dir') : 'north up';
  arrow.style.transform = `rotate(${(b - (h ?? 0) + 360) % 360}deg)`;
}
$('#nextBtn').addEventListener('click', () => {
  const n = nearestUnvisited();
  if (n) { setTarget(n, true); toast(`Target: ${targetById(n).label}`); }
  else toast(activeDs() ? 'Every target in this dataset has been visited.' : 'Upload validation points first.');
});

// ================= roads for routing =================
const roadsLayer = L.layerGroup().addTo(map);
async function loadRoads(pid) {
  S.router = null; S.roadsMeta = null; roadsLayer.clearLayers();
  const g = await store.get('roads:' + pid, null);
  if (g && g.lat) { useRoads(g); }
  renderRoadsNote();
}
function useRoads(g) {
  S.router = new Router(g);
  S.roadsMeta = { ways: g.ways, nodes: g.lat.length, edges: g.ea.length, source: g.source, fetched_at: g.fetched_at, bbox: g.bbox };
  S.route = null;
  renderRoadsLayer(); renderRoadsNote();
}
// Area to fetch: everything this project touches (targets, points, reference layers, my position), padded ~4 km.
function projectBBox() {
  const ll = [];
  for (const ds of liveDatasets()) for (const t of ds.targets) ll.push([t.lat, t.lon]);
  for (const p of livePoints()) if (Number.isFinite(p.lat)) ll.push([p.lat, p.lon]);
  for (const o of S.overlays) { try { const b = L.geoJSON(o.geojson).getBounds(); if (b.isValid()) ll.push([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]); } catch { /* skip */ } }
  if (S.me) ll.push([S.me.lat, S.me.lon]);
  let b = ll.length ? L.latLngBounds(ll) : map.getBounds();
  b = L.latLngBounds([b.getSouth() - 0.04, b.getWest() - 0.04], [b.getNorth() + 0.04, b.getEast() + 0.04]);
  if (b.getNorth() - b.getSouth() > 1.2 || b.getEast() - b.getWest() > 1.2) {
    // too large for one download: use what is on screen instead
    const v = map.getBounds();
    if (v.getNorth() - v.getSouth() > 1.2 || v.getEast() - v.getWest() > 1.2) return null;
    b = L.latLngBounds([v.getSouth() - 0.02, v.getWest() - 0.02], [v.getNorth() + 0.02, v.getEast() + 0.02]);
  }
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}
async function downloadRoads(auto) {
  if (!S.project || S.roadsBusy) return;
  if (!navigator.onLine) { if (!auto) toast('Downloading roads needs a connection. Do it before going to the field.'); return; }
  const bbox = projectBBox();
  if (!bbox) { toast('The area is too large. Zoom in to the part you need and try again.', 5000); return; }
  const pid = S.project.id;
  S.roadsBusy = true; renderRoadsNote('Downloading roads from OpenStreetMap…'); updateNav();
  if (auto) toast('Downloading roads for this area so routes follow the road network…', 4000);
  try {
    const { json, source } = await downloadOsmRoads(bbox, msg => renderRoadsNote(msg));
    const polys = polylinesFromOverpass(json);
    if (!polys.length) throw new Error('OpenStreetMap has no roads mapped in this area.');
    const g = buildGraph(polys, { source: 'OpenStreetMap via ' + source, fetched_at: new Date().toISOString(), area: bbox });
    await store.set('roads:' + pid, g);
    if (S.project && S.project.id === pid) { useRoads(g); toast(`Roads ready: ${polys.length.toLocaleString()} road segments saved on this device for offline routing.`, 5000); }
  } catch (e) {
    toast(e.message || 'Road download failed.', 6000);
  } finally { S.roadsBusy = false; renderRoadsNote(); updateNav(); }
}
async function importRoadsFile(file) {
  const text = await file.text();
  let polys;
  if (/\.osm$/i.test(file.name)) polys = polylinesFromOsmXml(text);
  else if (/\.kml$/i.test(file.name)) polys = polylinesFromGeoJSON(kmlToGeoJSON(text));
  else { const j = JSON.parse(text); polys = j.elements ? polylinesFromOverpass(j) : polylinesFromGeoJSON(j); }
  if (!polys.length) throw new Error('No road lines found in that file.');
  const g = buildGraph(polys, { source: file.name, fetched_at: new Date().toISOString() });
  if (!g.bbox || Math.abs(g.bbox[0]) > 90 || Math.abs(g.bbox[1]) > 180) throw new Error('Coordinates are not longitude/latitude. Reproject to WGS84 (EPSG:4326) first.');
  await store.set('roads:' + S.project.id, g);
  useRoads(g);
  return polys.length;
}
function renderRoadsNote(busyMsg) {
  const el = $('#roadsNote'); if (!el) return;
  if (busyMsg || S.roadsBusy) { el.textContent = busyMsg || 'Downloading roads…'; $('#roadsDlBtn').disabled = true; return; }
  $('#roadsDlBtn').disabled = false;
  const m = S.roadsMeta;
  el.textContent = m
    ? `${m.ways.toLocaleString()} roads and paths saved on this device (${m.source}, ${new Date(m.fetched_at).toLocaleDateString()}). Routes work offline inside this area.`
    : 'No roads saved for this project yet. Download them while you have a connection so routes work offline in the field.';
  $('#roadsDlBtn').lastChild.textContent = m ? 'Update' : 'Download';
}
const ROAD_STYLE = cls => {
  const c = CLASSES[cls];
  if (['motorway', 'trunk', 'primary'].includes(c)) return { color: '#e8833a', weight: 4 };
  if (['secondary', 'tertiary'].includes(c)) return { color: '#f3cf5a', weight: 3.5 };
  if (['unclassified', 'residential', 'living_street', 'service', 'road'].includes(c)) return { color: '#9e9686', weight: 2.2 };
  if (c === 'track') return { color: '#8a5a2b', weight: 2, dashArray: '6 4' };
  return { color: '#8a5a2b', weight: 1.5, dashArray: '2 4' };
};
function renderRoadsLayer() {
  roadsLayer.clearLayers();
  if (!settings.showRoads || !S.router || map.getZoom() < 12) return;
  const g = S.router.g, b = map.getBounds().pad(0.2);
  const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
  let shown = 0;
  for (let k = 0; k < g.wcls.length && shown < 6000; k++) {
    const pts = [];
    let hit = false;
    for (let j = g.woff[k]; j < g.woff[k + 1]; j++) {
      const i = g.wnodes[j], la = g.lat[i], lo = g.lon[i];
      if (la >= s && la <= n && lo >= w && lo <= e) hit = true;
      pts.push([la, lo]);
    }
    if (!hit) continue;
    L.polyline(pts, { renderer, interactive: false, opacity: 0.95, lineCap: 'round', ...ROAD_STYLE(g.wcls[k]) }).addTo(roadsLayer);
    shown++;
  }
}
map.on('moveend', () => { if (settings.showRoads) renderRoadsLayer(); });

// ================= alerts =================
let actx = null;
function beep(times) {
  if (!settings.alert) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * 0.22;
      o.frequency.value = 880 + i * 220; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.2);
    }
  } catch { /* no audio */ }
}
function alertBand(band, t) {
  if (settings.alert && navigator.vibrate) navigator.vibrate(band === 'here' ? [200, 100, 200, 100, 400] : band === 'close' ? [200, 100, 200] : [250]);
  beep(rank(band));
  toast(band === 'here' ? `Arrived at ${t.label}. Tap Verify to record what is on the ground.` : `${BAND_TXT[band]} of ${t.label}`);
}

// ================= GPS =================
let watchId = null;
function startGPS() {
  if (!('geolocation' in navigator)) { toast('This browser has no location access.'); return; }
  if (!window.isSecureContext) { toast('GPS needs https:// (or localhost). Ask your admin for the https address of the server.', 6000); }
  if (watchId != null) return;
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume && actx.resume(); } catch { /* ignore */ }
  watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  S.follow = true;
  gpsBtnUI(); $('#gpsBadge').textContent = 'Searching…'; $('#gpsBadge').className = 'sbGps num';
}
function stopGPS() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; S.me = null;
  map.removeLayer(youMarker); map.removeLayer(accCircle);
  $('#gpsBadge').textContent = 'GPS off'; $('#gpsBadge').className = 'sbGps num';
  gpsBtnUI(); updateNav(); updatePosCard(); updateCrosshair();
}
function gpsBtnUI() {
  const b = $('#gpsBtn'), on = watchId != null;
  const state = !on ? 'off' : !S.me ? 'search' : S.follow ? 'follow' : 'on';
  const label = { off: 'Start GPS', search: 'Searching for GPS (tap to stop)', follow: 'Following your position (tap to stop GPS)', on: 'Centre on my position' }[state];
  b.dataset.state = state; b.title = label; b.setAttribute('aria-label', label);
}
function setFollow(v) {
  S.follow = v; gpsBtnUI(); updateCrosshair(); updatePosCard();
  if (v && S.me) map.setView([S.me.lat, S.me.lon], Math.max(map.getZoom(), 16));
}
$('#gpsBtn').addEventListener('click', () => {
  if (watchId == null) startGPS();
  else if (!S.follow) setFollow(true);
  else { stopGPS(); toast('GPS off'); }
});
function onPos(pos) {
  const c = pos.coords, first = !S.me;
  S.me = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, ts: pos.timestamp, speed: c.speed, heading: c.heading != null && !isNaN(c.heading) ? c.heading : null };
  youMarker.setLatLng([S.me.lat, S.me.lon]).addTo(map);
  accCircle.setLatLng([S.me.lat, S.me.lon]).setRadius(S.me.acc).addTo(map);
  const g = $('#gpsBadge'); g.textContent = `GPS ±${Math.round(S.me.acc)} m`; g.className = 'sbGps num ' + (S.me.acc <= 10 ? 'ok' : S.me.acc <= 30 ? 'weak' : 'bad');
  // track: add a vertex after moving >8 m or every 30 s
  const last = S.track[S.track.length - 1];
  if (S.me.acc <= 50 && (!last || dist({ lat: last[0], lon: last[1] }, S.me) > 8 || pos.timestamp - last[2] > 30000)) {
    S.track.push([+S.me.lat.toFixed(6), +S.me.lon.toFixed(6), pos.timestamp, Math.round(S.me.acc)]);
    if (S.track.length > 30000) S.track.shift();
    trackLine.addLatLng([S.me.lat, S.me.lon]); saveTrackSoon();
  }
  if (avg) collectAvg(S.me);
  if (first) {
    if (S.mode === 'truth' && !S.targetId) { const n = nearestUnvisited(); if (n) setTarget(n, false); }
    map.setView([S.me.lat, S.me.lon], Math.max(map.getZoom(), 16));
  } else if (S.follow) map.panTo([S.me.lat, S.me.lon], { animate: true });
  updateNav(); updatePosCard(); updateCrosshair(); gpsBtnUI();
  if ($('#recSheet').classList.contains('open')) updateFixBox();
  if ($('#listSheet').classList.contains('open')) renderListSoon();
}
let lastErrToast = 0;
function onErr(e) {
  if (e.code === 1) { $('#gpsBadge').textContent = 'GPS blocked'; $('#gpsBadge').className = 'sbGps num bad'; toast('Location permission was refused. Allow location for this site in the browser settings.', 5000); stopGPS(); return; }
  if (S.me && Date.now() - S.me.ts < 30000) return; // brief dropouts under canopy are normal
  $('#gpsBadge').textContent = 'Searching…'; $('#gpsBadge').className = 'sbGps num bad';
  if (Date.now() - lastErrToast > 60000) { lastErrToast = Date.now(); toast('Searching for satellites… step into the open if you can.'); }
}
let trackT;
function saveTrackSoon() { clearTimeout(trackT); trackT = setTimeout(() => store.set('track', S.track), 3000); }

// ================= compass =================
let heading = null, compassOn = false;
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  heading = (h + so + 360) % 360;
  const t = S.targetId && targetById(S.targetId);
  if (t && S.me) setArrow(navBearing(t));
}
async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') { toast('Compass permission refused.'); return; }
      window.addEventListener('deviceorientation', onOrient, true);
    } else if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient, true);
    else window.addEventListener('deviceorientation', onOrient, true);
    compassOn = true; $('#compassBtn').textContent = 'Compass on (hold phone flat)'; toast('Compass on. Hold the phone flat, away from metal.');
  } catch { toast('This phone did not allow the compass.'); }
}
$('#compassBtn').addEventListener('click', enableCompass);

// ================= record =================
let R = null;     // the form being filled
let avg = null;   // {fixes:[], need}
function segSet(sel, v) { $$(sel + ' button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }
$$('#confSeg button').forEach(b => b.addEventListener('click', () => { R.conf = R.conf === b.dataset.v ? '' : b.dataset.v; segSet('#confSeg', R.conf); }));
$$('#accessSeg button').forEach(b => b.addEventListener('click', () => { R.access = b.dataset.v; segSet('#accessSeg', R.access); clsGridState(); }));

function buildClassGrid() {
  const g = $('#clsGrid'); g.innerHTML = '';
  for (const c of classes()) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.v = c.name;
    b.innerHTML = `<i style="background:${esc(c.color)}"></i><span>${esc(c.name)}</span>`;
    b.setAttribute('aria-pressed', String(R.cls === c.name));
    b.addEventListener('click', () => { R.cls = c.name; $$('#clsGrid button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
    g.appendChild(b);
  }
}
function clsGridState() { $('#clsGrid').classList.toggle('off', R.kind === 'validation' && R.access === 'not reached'); }

function nextLabel(kind) {
  const u = user();
  const prefix = (kind === 'new' ? 'NP' : 'TR') + '-' + (u ? u.username.slice(0, 6).toUpperCase() : 'X');
  let n = 0;
  for (const p of S.points.values()) if (p.label && p.label.startsWith(prefix + '-')) n = Math.max(n, parseInt(p.label.slice(prefix.length + 1), 10) || 0);
  return `${prefix}-${String(n + 1).padStart(4, '0')}`;
}

function openRecord(opts = {}) {
  if (!S.project) { toast('Open a project first (Menu → Projects).'); return; }
  const e = opts.edit || null;
  let kind = e ? e.kind : opts.kind;
  let target = e && e.kind === 'validation' ? (S.datasets.get(e.dataset_id)?.targets || []).find(t => t.id === e.target_id) || { id: e.target_id, label: e.target_label, mapped: e.mapped, lat: e.target_lat, lon: e.target_lon } : opts.target || null;
  if (!kind) {
    if (S.mode === 'truth') { target = S.targetId && targetById(S.targetId); kind = target ? 'validation' : 'new'; }
    else kind = 'training';
  }
  stopAvg();
  R = {
    kind, target, edit: e,
    cls: e ? e.cls : '', conf: e ? e.conf || '' : '', access: e ? e.access || 'reached' : 'reached',
    photo: e ? e.photo || null : null,
    loc: e && Number.isFinite(e.lat) ? { lat: e.lat, lon: e.lon, acc: e.acc, n: e.n_fix || 1, sd: e.sd_m, alt: e.alt, src: e.src } : null,
  };
  if (!R.loc) {
    if (S.me && Date.now() - S.me.ts < 30000) useGps();
    else if (kind === 'training' || kind === 'new') useMapCentre(true);
  }
  $('#recTitle').textContent = e ? `Edit ${e.label}` : kind === 'validation' ? `Verify ${target.label}` : kind === 'new' ? 'New point' : 'Record training sample';
  $('#recTarget').hidden = kind !== 'validation';
  if (kind === 'validation') {
    const d = S.me ? dist(S.me, target) : null;
    $('#recTarget').innerHTML = `Target <b>${esc(target.label)}</b>${target.mapped ? ` · map says <b>${esc(target.mapped)}</b>` : ''}${d != null ? ` · you are ${fmtDist(d)} away` : ''}
      <div class="btnRow"><button class="chipBtn" type="button" id="asNewBtn">Record a new point here instead</button></div>`;
    $('#asNewBtn').onclick = () => openRecord({ kind: 'new' });
  }
  $('#accessRow').hidden = kind !== 'validation';
  segSet('#accessSeg', R.access);
  $('#clsLabel').textContent = kind === 'validation' ? 'What is actually on the ground?' : 'Class on the ground';
  buildClassGrid(); clsGridState();
  segSet('#confSeg', R.conf);
  $('#recLabel').value = e ? e.label : kind === 'validation' ? target.label : nextLabel(kind);
  $('#recLabel').readOnly = kind === 'validation';
  $('#recRadius').value = e && e.radius_m != null ? e.radius_m : '';
  $('#recNotes').value = e ? e.notes || '' : '';
  showPhoto();
  $('#delBtn').hidden = !e;
  $('#saveBtn').textContent = e ? 'Save changes' : kind === 'validation' ? 'Save visit' : 'Save point';
  openSheet('#recSheet');
  updateFixBox();
}
function useGps() {
  if (!S.me) { toast('No GPS fix yet. Start GPS, or use the map centre.'); return; }
  stopAvg();
  R.loc = { lat: S.me.lat, lon: S.me.lon, acc: S.me.acc, n: 1, sd: null, alt: S.me.alt, src: 'gps' };
  updateFixBox();
}
function useMapCentre(quiet) {
  stopAvg();
  const c = map.getCenter();
  R.loc = { lat: c.lat, lon: c.lng, acc: null, n: 0, sd: null, alt: null, src: 'map' };
  if (!quiet) toast(window.innerWidth >= 900 ? 'Using the map centre. Pan the map to adjust, then press Map centre again.' : 'Using the map centre. To adjust it, cancel, pan the map under the crosshair and record again.', 5000);
  updateFixBox();
}
function startAvg() {
  if (watchId == null) { startGPS(); }
  avg = { fixes: [], need: +settings.avgN || 10 };
  $('#avgBtn').textContent = 'Stop averaging';
  updateFixBox();
}
function stopAvg() {
  if (!avg) return;
  if (avg.fixes.length && R) { const a = averageFixes(avg.fixes); R.loc = { lat: a.lat, lon: a.lon, acc: a.acc, n: a.n, sd: a.sd, alt: a.alt, src: a.n > 1 ? 'gps-avg' : 'gps' }; }
  avg = null; $('#avgBtn').textContent = 'Average fixes';
  if (R) updateFixBox();
}
function collectAvg(fix) {
  if (fix.acc > 50) return;
  avg.fixes.push({ lat: fix.lat, lon: fix.lon, acc: fix.acc, alt: fix.alt });
  if (avg.fixes.length >= avg.need) { stopAvg(); if (navigator.vibrate) navigator.vibrate(120); toast('Averaging finished.'); }
  else updateFixBox();
}
function updateFixBox() {
  if (!R) return;
  const box = $('#fixBox');
  if (avg) {
    const a = averageFixes(avg.fixes);
    box.innerHTML = `<b>Averaging… ${avg.fixes.length} of ${avg.need} fixes.</b> Hold still.${a ? `<br>${a.lat.toFixed(6)}, ${a.lon.toFixed(6)} · spread ${a.sd.toFixed(1)} m` : ''}`;
    return;
  }
  if (!R.loc) { box.innerHTML = 'No location yet. Start GPS, or use the map centre.' + (R.kind === 'validation' ? ' If you save without one, the target\'s position is used.' : ''); return; }
  const l = R.loc, u = toUTM(l.lat, l.lon);
  const src = { gps: 'GPS, single fix', 'gps-avg': `GPS, ${l.n} fixes averaged`, map: 'Placed at map centre', target: 'Target position' }[l.src] || l.src;
  const td = R.kind === 'validation' && R.target ? ` · ${fmtDist(dist(l, R.target))} from target` : '';
  box.innerHTML = `<b>${l.lat.toFixed(6)}, ${l.lon.toFixed(6)}</b>${l.acc != null ? ` · ±${Math.round(l.acc)} m` : ''}${l.sd != null ? ` · spread ${(+l.sd).toFixed(1)} m` : ''}<br>
    UTM ${u.zone}${u.hemi} ${Math.round(u.easting)} E ${Math.round(u.northing)} N · ${esc(src)}${td}`;
}
$('#useGpsBtn').addEventListener('click', useGps);
$('#useMapBtn').addEventListener('click', () => useMapCentre(false));
$('#avgBtn').addEventListener('click', () => (avg ? stopAvg() : startAvg()));

// photos are shrunk on the phone before saving so they sync over weak signal
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  } finally { URL.revokeObjectURL(url); }
}
$('#recPhoto').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { R.photo = await shrinkPhoto(f); showPhoto(); } catch { toast('That photo could not be read.'); }
});
$('#recPhotoDel').addEventListener('click', () => { R.photo = null; showPhoto(); });
function showPhoto() { $('#recPhotoPrev').hidden = !R.photo; $('#recPhotoDel').hidden = !R.photo; if (R.photo) $('#recPhotoPrev').src = R.photo; }

$('#saveBtn').addEventListener('click', async () => {
  stopAvg();
  const reached = !(R.kind === 'validation' && R.access === 'not reached');
  if (reached && !R.cls) { toast('Choose a class first.'); return; }
  let loc = R.loc;
  if (!loc) {
    if (R.kind === 'validation') loc = { lat: R.target.lat, lon: R.target.lon, acc: null, n: 0, sd: null, alt: null, src: 'target' };
    else { toast('No location yet. Start GPS or use the map centre.'); return; }
  }
  const u = user(), nowIso = new Date().toISOString(), e = R.edit;
  const c = reached ? classByName(R.cls) : null;
  const p = {
    ...(e || {}),
    id: e ? e.id : uuid(),
    project_id: S.project.id,
    kind: R.kind,
    label: $('#recLabel').value.trim() || (R.kind === 'validation' ? R.target.label : nextLabel(R.kind)),
    cls: reached ? R.cls : '', cls_code: c ? c.code : '',
    conf: R.conf,
    lat: +loc.lat.toFixed(7), lon: +loc.lon.toFixed(7),
    acc: loc.acc != null ? Math.round(loc.acc * 10) / 10 : null, n_fix: loc.n, sd_m: loc.sd != null ? Math.round(loc.sd * 10) / 10 : null,
    alt: loc.alt != null ? Math.round(loc.alt * 10) / 10 : null, src: loc.src,
    radius_m: $('#recRadius').value === '' ? null : +$('#recRadius').value,
    notes: $('#recNotes').value.trim(),
    photo: R.photo || null,
    observer: e ? e.observer : u.name, observer_id: e ? e.observer_id : u.id,
    created_at: e ? e.created_at : nowIso,
    updated_at: Date.now(), deleted: false, dirty: true,
  };
  if (R.kind === 'validation') {
    const ds = S.datasets.get(e ? e.dataset_id : S.dsId);
    Object.assign(p, {
      access: R.access, dataset_id: ds ? ds.id : e.dataset_id, dataset_name: ds ? ds.name : e.dataset_name,
      target_id: R.target.id, target_label: R.target.label, target_lat: R.target.lat, target_lon: R.target.lon,
      mapped: R.target.mapped || '', dist_m: Math.round(dist(loc, R.target)),
    });
    const mc = matchClass(p.mapped);
    p.agree = !reached || !p.mapped ? null : mc ? mc.name === p.cls : norm(p.mapped) === norm(p.cls);
  }
  S.points.set(p.id, p);
  await store.put('points', p);
  closeSheets();
  renderAll(false);
  if (R.kind === 'validation' && !e) {
    const n = nearestUnvisited();
    toast(`Saved ${p.label}${p.agree === false ? ' (disagrees with map)' : ''}.` + (n ? ` Next nearest: ${targetById(n).label}.` : ' All targets visited!'), 4000);
    if (n) setTarget(n, false);
  } else toast(`Saved ${p.label}.`);
  R = null;
  syncSoon();
});
$('#delBtn').addEventListener('click', async () => {
  const p = R.edit;
  const ok = await dialog({ title: `Delete ${p.label}?`, text: 'The point is removed for the whole team after the next sync.', okText: 'Delete' });
  if (!ok) return;
  const d = { ...p, deleted: true, photo: null, updated_at: Date.now(), dirty: true };
  S.points.set(d.id, d); await store.put('points', d);
  closeSheets(); renderAll(false); toast('Point deleted.'); R = null; syncSoon();
});
$('#recBtn').addEventListener('click', () => {
  if (S.mode === 'truth' && !activeDs()) { openRecord({ kind: 'new' }); return; }
  openRecord();
});

// ================= list =================
let listT;
function renderListSoon() { clearTimeout(listT); listT = setTimeout(renderList, 400); }
function fillClassFilter() {
  const sel = $('#clsSel'), cur = sel.value;
  sel.innerHTML = '<option value="">All classes</option>' + classes().map(c => `<option>${esc(c.name)}</option>`).join('');
  sel.value = cur;
}
function renderList() {
  const truth = S.mode === 'truth';
  $('#dsSel').hidden = !truth; $('#statusSel').hidden = !truth; $('#kindSel').hidden = truth;
  $('#listTitle').textContent = truth ? 'Validation targets' : 'Collected points';
  const q = norm($('#q').value), cls = $('#clsSel').value;
  const el = $('#list'); el.innerHTML = '';
  const from = S.me;
  const frag = document.createDocumentFragment();
  if (truth) {
    const dsSel = $('#dsSel');
    dsSel.innerHTML = liveDatasets().map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('') || '<option value="">No datasets yet</option>';
    dsSel.value = S.dsId || '';
    const ds = activeDs();
    if (!ds) { el.innerHTML = '<p class="note">No validation dataset yet. Go to Data → Upload points file.</p>'; $('#progress').textContent = ''; return; }
    const visits = visitsFor(ds), st = $('#statusSel').value;
    let rows = ds.targets.filter(t => {
      const v = visits.get(t.id);
      if (q && !norm(`${t.label} ${t.mapped} ${v ? v.cls + ' ' + v.notes : ''}`).includes(q)) return false;
      if (cls && norm(t.mapped) !== norm(cls) && !(v && v.cls === cls)) return false;
      if (st === 'todo' && v) return false;
      if (st === 'done' && !v) return false;
      if (st === 'disagree' && !(v && v.agree === false)) return false;
      if (st === 'unreached' && !(v && v.access === 'not reached')) return false;
      return true;
    }).map(t => ({ t, v: visits.get(t.id), d: from ? dist(from, t) : null }));
    if (from) rows.sort((a, b) => a.d - b.d);
    for (const { t, v, d } of rows.slice(0, 1500)) {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'rowBtn' + (t.id === S.targetId ? ' isTarget' : '');
      const mc = matchClass(t.mapped);
      const dot = v ? `<span class="dot" style="background:${v.access === 'not reached' ? '#9e9e9e' : esc(colorOf(v.cls))}"></span>` : `<span class="dot ring" style="border-color:${esc(mc ? mc.color : '#1d4e89')}"></span>`;
      const res = v ? (v.access === 'not reached' ? 'could not reach' : esc(v.cls)) + (v.agree === false ? ' <span class="flag">≠ map</span>' : '') : 'not visited';
      b.innerHTML = `${dot}<span><span class="rid">${esc(t.label)}</span><span class="rmeta">${t.mapped ? 'Map: ' + esc(t.mapped) + ' · ' : ''}${res}</span></span>
        <span class="rdist num">${d != null ? fmtDist(d) : ''}<small>${d != null ? Math.round(bearing(from, t)) + '° ' + cardinal(bearing(from, t)) : t.lat.toFixed(5) + ', ' + t.lon.toFixed(5)}</small></span>`;
      b.addEventListener('click', () => { setTarget(t.id, true); closeSheets(); });
      frag.appendChild(b);
    }
    $('#progress').textContent = `${visits.size} of ${ds.targets.length} visited`;
  } else {
    const kind = $('#kindSel').value;
    let rows = livePoints().filter(p => (!kind || p.kind === kind) && (!cls || p.cls === cls)
      && (!q || norm(`${p.label} ${p.cls} ${p.notes} ${p.observer}`).includes(q)))
      .map(p => ({ p, d: from && Number.isFinite(p.lat) ? dist(from, p) : null }));
    rows.sort(from ? (a, b) => a.d - b.d : (a, b) => (b.p.created_at || '').localeCompare(a.p.created_at || ''));
    for (const { p, d } of rows.slice(0, 1500)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'rowBtn';
      b.innerHTML = `<span class="dot${p.kind === 'new' ? ' sq' : ''}" style="background:${p.access === 'not reached' ? '#9e9e9e' : esc(colorOf(p.cls))}"></span>
        <span><span class="rid">${esc(p.label)}</span><span class="rmeta">${esc(p.cls || (p.access === 'not reached' ? 'Not reached' : '—'))} · ${esc(p.observer || '')} · ${esc(fmtTime(p.created_at))}${p.dirty ? ' · not synced' : ''}</span></span>
        <span class="rdist num">${d != null ? fmtDist(d) : ''}<small>${p.kind === 'training' ? 'training' : p.kind === 'new' ? 'new point' : 'validation'}</small></span>`;
      b.addEventListener('click', () => {
        closeSheets();
        if (p.kind === 'validation') { openRecord({ edit: p }); return; }
        map.setView([p.lat, p.lon], Math.max(map.getZoom(), 17));
        setFollow(false);
        L.popup({ maxWidth: 260 }).setLatLng([p.lat, p.lon]).setContent(pointPopup(p)).openOn(map);
      });
      frag.appendChild(b);
    }
    const n = livePoints().length;
    $('#progress').textContent = `${rows.length} of ${n}`;
  }
  el.appendChild(frag);
  if (!el.children.length) el.innerHTML = '<p class="note">Nothing matches.</p>';
}
['input', 'change'].forEach(ev => ['#q', '#kindSel', '#statusSel', '#clsSel'].forEach(s => $(s).addEventListener(ev, renderList)));
$('#dsSel').addEventListener('change', e => setDataset(e.target.value));
$('#listBtn').addEventListener('click', () => toggleSection('#listSheet', () => { fillClassFilter(); renderList(); openSheet('#listSheet'); }));

function setDataset(id) {
  S.dsId = id || null;
  settings.activeDs[S.project.id] = S.dsId; saveSettings();
  S.targetId = null;
  renderAll(false);
  fitProject();
}

// ================= data sheet =================
function renderDataSheet() {
  const box = $('#dsList'); box.innerHTML = '';
  const dss = liveDatasets();
  if (!dss.length) box.innerHTML = '<p class="note">No validation datasets in this project yet.</p>';
  for (const ds of dss) {
    const v = visitsFor(ds);
    const row = document.createElement('div'); row.className = 'itemRow' + (ds.id === S.dsId ? ' active' : '');
    row.innerHTML = `<div class="grow"><b>${esc(ds.name)}</b><small>${ds.targets.length} targets · ${v.size} visited${ds.mapped_field ? ` · map class from “${esc(ds.mapped_field)}”` : ' · no map class column'}${ds.dirty ? ' · not synced' : ''}</small></div>`;
    const use = document.createElement('button'); use.className = 'chipBtn'; use.type = 'button'; use.textContent = ds.id === S.dsId && S.mode === 'truth' ? 'In use' : 'Ground truth';
    use.onclick = () => { setDataset(ds.id); if (S.mode !== 'truth') setMode('truth'); closeSheets(); };
    row.appendChild(use);
    if (canManage() || ds.created_by_id === (user() || {}).id) {
      const del = document.createElement('button'); del.className = 'chipBtn danger'; del.type = 'button'; del.textContent = 'Remove';
      del.onclick = async () => {
        const ok = await dialog({ title: `Remove “${ds.name}”?`, text: `The ${ds.targets.length} targets disappear for the whole team. Visits already recorded (${v.size}) are kept and still export.`, okText: 'Remove' });
        if (!ok) return;
        const d = { ...ds, deleted: true, targets: [], updated_at: Date.now(), dirty: true };
        S.datasets.set(d.id, d); await store.put('datasets', d);
        if (S.dsId === d.id) S.dsId = (liveDatasets()[0] || {}).id || null;
        renderAll(false); syncSoon();
      };
      row.appendChild(del);
    }
    box.appendChild(row);
  }
  // overlays
  const ob = $('#ovList'); ob.innerHTML = '';
  for (const o of S.overlays) {
    const row = document.createElement('div'); row.className = 'itemRow';
    row.innerHTML = `<div class="grow"><b>${esc(o.name)}</b><small>${o.geojson.features.length} feature(s)</small></div>`;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = o.on; cb.setAttribute('aria-label', 'Show ' + o.name);
    cb.onchange = async () => { o.on = cb.checked; await store.set('overlays:' + S.project.id, S.overlays); renderOverlays(); };
    const zoom = document.createElement('button'); zoom.className = 'chipBtn'; zoom.type = 'button'; zoom.textContent = 'Zoom';
    zoom.onclick = () => { const b = L.geoJSON(o.geojson).getBounds(); if (b.isValid()) { map.fitBounds(b, { padding: [30, 30] }); setFollow(false); closeSheets(); } };
    const del = document.createElement('button'); del.className = 'chipBtn danger'; del.type = 'button'; del.textContent = 'Remove';
    del.onclick = async () => { S.overlays = S.overlays.filter(x => x !== o); await store.set('overlays:' + S.project.id, S.overlays); renderOverlays(); renderDataSheet(); };
    row.append(cb, zoom, del); ob.appendChild(row);
  }
  $('#trackNote').textContent = `${S.track.length} track points saved on this device.`;
  const n = livePoints().length;
  $('#expNote').textContent = `${n} point(s) in this project · ${livePoints().filter(p => p.dirty).length} not synced yet. Coordinates are WGS84 (EPSG:4326) with UTM columns added.`;
}
$('#dataBtn').addEventListener('click', () => toggleSection('#dataSheet', () => { renderDataSheet(); openSheet('#dataSheet'); }));

// ---------- reference overlays ----------
const OV_COLORS = ['#ff6f00', '#6a1b9a', '#00838f', '#c2185b', '#2e7d32'];
function renderOverlays() {
  overlayGroup.clearLayers();
  S.overlays.forEach((o, i) => {
    if (!o.on) return;
    const col = OV_COLORS[i % OV_COLORS.length];
    L.geoJSON(o.geojson, {
      renderer, style: { color: col, weight: 2.5, fillColor: col, fillOpacity: 0.08 },
      pointToLayer: (f, ll) => L.circleMarker(ll, { renderer, radius: 4, color: col, weight: 2, fillOpacity: 0.5 }),
      onEachFeature: (f, l) => { const pr = f.properties || {}; const name = pr.name || pr.NAME || pr.Name || o.name; l.bindPopup(`<b>${esc(name)}</b><br><small>${esc(o.name)}</small>`); },
    }).addTo(overlayGroup);
  });
}
$('#overlayFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    const gj = /\.kml$/i.test(f.name) ? kmlToGeoJSON(text) : JSON.parse(text);
    const fc = gj.type === 'FeatureCollection' ? gj : gj.type === 'Feature' ? { type: 'FeatureCollection', features: [gj] } : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: gj }] };
    if (!fc.features.length) throw new Error('No features found in that file.');
    const b = L.geoJSON(fc).getBounds();
    if (!b.isValid() || Math.abs(b.getNorth()) > 90 || Math.abs(b.getEast()) > 180) throw new Error('Coordinates are not in longitude/latitude. Reproject the file to WGS84 (EPSG:4326) first.');
    S.overlays.push({ id: uuid(), name: f.name.replace(/\.(geo)?json$|\.kml$/i, ''), geojson: fc, on: true });
    await store.set('overlays:' + S.project.id, S.overlays);
    renderOverlays(); renderDataSheet(); map.fitBounds(b, { padding: [30, 30] }); setFollow(false);
    toast(`Added ${f.name}.`);
  } catch (err) { toast(err.message || 'That file could not be read.', 5000); }
});

// ---------- import validation points ----------
let IMP = null; // {name, headers, rows, native}
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!S.project) { toast('Open a project first.'); return; }
  try {
    const text = await f.text();
    let headers, rows, native = false;
    if (/\.(geo)?json$/i.test(f.name) || /\.kml$/i.test(f.name)) {
      const gj = /\.kml$/i.test(f.name) ? kmlToGeoJSON(text) : JSON.parse(text);
      const pts = pointsFromGeoJSON(gj);
      if (!pts.length) throw new Error('No point features found. Polygons can be added under Reference layers instead.');
      headers = [...new Set(pts.flatMap(p => Object.keys(p.props)))];
      rows = pts.map(p => ({ ...Object.fromEntries(headers.map(h => [h, p.props[h] == null ? '' : String(p.props[h])])), __lat: p.lat, __lon: p.lon }));
      native = true;
    } else ({ headers, rows } = parseCSV(text));
    if (!rows.length) throw new Error('The file has no data rows.');
    IMP = { name: f.name.replace(/\.[^.]+$/, ''), file: f.name, headers, rows, native };
    openImportSheet();
  } catch (err) { toast(err.message || 'That file could not be read.', 5000); }
});
function fillSel(sel, headers, val, optional) {
  sel.innerHTML = (optional ? '<option value="">— none —</option>' : '') + headers.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
  sel.value = val || (optional ? '' : headers[0] || '');
}
function openImportSheet() {
  const { headers, rows, native } = IMP;
  const g = guessColumns(headers, rows);
  $('#impSummary').textContent = `${IMP.file}: ${rows.length} rows, ${headers.length} columns.` + (native ? ' Coordinates come from the file geometry.' : '');
  const cols = headers.slice(0, 12);
  $('#impPreview').innerHTML = `<tr>${cols.map(h => `<th>${esc(h)}</th>`).join('')}</tr>` + rows.slice(0, 5).map(r => `<tr>${cols.map(h => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('');
  $('#impName').value = IMP.name;
  fillSel($('#impId'), headers, g.id, true);
  fillSel($('#impCls'), headers, g.cls, true);
  fillSel($('#impLat'), headers, g.lat); fillSel($('#impLon'), headers, g.lon);
  fillSel($('#impE'), headers, g.east); fillSel($('#impN'), headers, g.north);
  $('#impCrs').value = g.crs;
  if (S.me || map.getCenter()) { const c = S.me || { lon: map.getCenter().lng, lat: map.getCenter().lat }; $('#impZone').value = toUTM(c.lat, c.lon).zone; $('#impHemi').value = c.lat < 0 ? 'S' : 'N'; }
  $('#impCrs').closest('label').hidden = native; $('#impLL').hidden = native || g.crs !== 'wgs84'; $('#impUTM').hidden = native || g.crs !== 'utm';
  $('#impErr').textContent = '';
  openSheet('#mapSheet');
}
$('#impCrs').addEventListener('change', e => { $('#impLL').hidden = e.target.value !== 'wgs84'; $('#impUTM').hidden = e.target.value !== 'utm'; });
$('#impGo').addEventListener('click', async () => {
  const { rows, native } = IMP;
  const idCol = $('#impId').value, clsCol = $('#impCls').value, crs = $('#impCrs').value;
  const zone = +$('#impZone').value, hemi = $('#impHemi').value;
  if (!native && crs === 'utm' && !(zone >= 1 && zone <= 60)) { $('#impErr').textContent = 'Enter a UTM zone between 1 and 60.'; return; }
  const num = v => parseFloat(String(v).replace(',', '.'));
  const targets = []; let bad = 0;
  rows.forEach((r, i) => {
    let lat, lon;
    if (native) { lat = r.__lat; lon = r.__lon; }
    else if (crs === 'wgs84') { lat = num(r[$('#impLat').value]); lon = num(r[$('#impLon').value]); }
    else { const e = num(r[$('#impE').value]), n = num(r[$('#impN').value]); if (Number.isFinite(e) && Number.isFinite(n)) ({ lat, lon } = fromUTM(e, n, zone, hemi)); }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) { bad++; return; }
    const attrs = { ...r }; delete attrs.__lat; delete attrs.__lon;
    targets.push({ id: uuid().slice(0, 13), label: (idCol && r[idCol]) || `P${i + 1}`, lat: +lat.toFixed(7), lon: +lon.toFixed(7), mapped: clsCol ? r[clsCol] || '' : '', attrs });
  });
  if (!targets.length) { $('#impErr').textContent = `None of the ${rows.length} rows has usable coordinates. Check the coordinate columns and system.`; return; }
  const b = L.latLngBounds(targets.map(t => [t.lat, t.lon]));
  const ds = {
    id: uuid(), project_id: S.project.id, name: $('#impName').value.trim() || IMP.name, source_file: IMP.file,
    mapped_field: clsCol || '', id_field: idCol || '', columns: IMP.headers, targets,
    created_at: new Date().toISOString(), created_by: user().name, created_by_id: user().id, updated_at: Date.now(), deleted: false, dirty: true,
  };
  S.datasets.set(ds.id, ds); await store.put('datasets', ds);
  closeSheets();
  setDataset(ds.id);
  if (S.mode !== 'truth') setMode('truth');
  map.fitBounds(b, { padding: [50, 50], maxZoom: 16 }); setFollow(false);
  let msg = `Imported ${targets.length} targets` + (bad ? ` (${bad} rows skipped: no valid coordinates)` : '') + '.';
  if (clsCol) {
    const unmatched = [...new Set(targets.map(t => t.mapped).filter(v => v && !matchClass(v)))];
    if (unmatched.length) msg += ` ${unmatched.length} map class value(s) do not match project classes (e.g. “${unmatched[0]}”); match names or codes for a clean accuracy report.`;
  }
  toast(msg, 7000);
  syncSoon();
});

// ---------- export ----------
function exportRows(scope, withTargets) {
  const u = user();
  let pts = livePoints();
  if (scope === 'training') pts = pts.filter(p => p.kind === 'training');
  if (scope === 'validation') pts = pts.filter(p => p.kind === 'validation');
  if (scope === 'new') pts = pts.filter(p => p.kind === 'new');
  if (scope === 'mine') pts = pts.filter(p => p.observer_id === u.id);
  pts.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const rows = pts.map(p => {
    const t = toUTM(p.lat, p.lon);
    return {
      id: p.id, label: p.label, kind: p.kind, class: p.cls || '', class_code: p.cls_code ?? '', confidence: p.conf || '',
      lat: p.lat, lon: p.lon, utm_zone: `${t.zone}${t.hemi}`, easting: round(t.easting, 2), northing: round(t.northing, 2),
      acc_m: round(p.acc, 1), n_fixes: p.n_fix ?? '', spread_m: round(p.sd_m, 1), alt_m: round(p.alt, 1), location_source: p.src || '',
      radius_m: p.radius_m ?? '', access: p.access || '',
      dataset: p.dataset_name || '', target_label: p.target_label || '', target_lat: p.target_lat ?? '', target_lon: p.target_lon ?? '',
      mapped_class: p.mapped || '', agree: p.agree == null ? '' : p.agree ? 'yes' : 'no', dist_to_target_m: p.dist_m ?? '',
      notes: p.notes || '', observer: p.observer || '', created_at: p.created_at || '', has_photo: p.photo ? 'yes' : 'no', project: S.project.name,
      photo_data: p.photo || '',
    };
  });
  if (withTargets && scope !== 'training' && scope !== 'new' && scope !== 'mine') {
    for (const ds of liveDatasets()) {
      const v = visitsFor(ds);
      for (const t of ds.targets) if (!v.has(t.id)) {
        const u2 = toUTM(t.lat, t.lon);
        rows.push({ id: t.id, label: t.label, kind: 'target_not_visited', class: '', class_code: '', confidence: '', lat: t.lat, lon: t.lon, utm_zone: `${u2.zone}${u2.hemi}`, easting: round(u2.easting, 2), northing: round(u2.northing, 2),
          acc_m: '', n_fixes: '', spread_m: '', alt_m: '', location_source: 'imported', radius_m: '', access: '', dataset: ds.name, target_label: t.label, target_lat: t.lat, target_lon: t.lon,
          mapped_class: t.mapped || '', agree: '', dist_to_target_m: '', notes: '', observer: '', created_at: '', has_photo: 'no', project: S.project.name, photo_data: '' });
      }
    }
  }
  return rows;
}
const EXPORT_COLS = ['id', 'label', 'kind', 'class', 'class_code', 'confidence', 'lat', 'lon', 'utm_zone', 'easting', 'northing', 'acc_m', 'n_fixes', 'spread_m', 'alt_m', 'location_source', 'radius_m', 'access', 'dataset', 'target_label', 'target_lat', 'target_lon', 'mapped_class', 'agree', 'dist_to_target_m', 'notes', 'observer', 'created_at', 'has_photo', 'project'];
function buildExport() {
  const scope = $('#expScope').value, fmt = $('#expFmt').value;
  const rows = exportRows(scope, $('#expTargets').checked);
  if (!rows.length) { toast('No points to export for that choice.'); return null; }
  const base = `${slug(S.project.name)}_${scope}_${stamp()}`;
  if (fmt === 'csv') return { name: base + '.csv', text: '﻿' + toCSV(EXPORT_COLS, rows), type: 'text/csv' };
  if (fmt === 'geojson') return { name: base + '.geojson', text: toGeoJSON(rows, { photos: $('#expPhotos').checked }), type: 'application/geo+json' };
  if (fmt === 'kml') return { name: base + '.kml', text: toKML(rows, `${S.project.name} (${scope})`, r => colorOf(r.class)), type: 'application/vnd.google-earth.kml+xml' };
  return { name: base + '.gpx', text: toGPXWaypoints(rows, S.project.name), type: 'application/gpx+xml' };
}
$('#exportBtn').addEventListener('click', () => { const x = buildExport(); if (x) { download(x.name, x.text, x.type); toast(`Downloaded ${x.name}`); } });
$('#shareBtn').addEventListener('click', async () => {
  const x = buildExport(); if (!x) return;
  const f = new File([x.text], x.name, { type: x.type });
  try { if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: x.name }); else download(x.name, x.text, x.type); }
  catch (e) { if (e.name !== 'AbortError') download(x.name, x.text, x.type); }
});
$('#trackExportBtn').addEventListener('click', () => { if (!S.track.length) { toast('No track recorded yet.'); return; } download(`track_${stamp()}.gpx`, trackToGPX(S.track, 'Addy track'), 'application/gpx+xml'); });
$('#clearTrackBtn').addEventListener('click', async () => {
  const ok = await dialog({ title: 'Clear the GPS track?', text: 'This removes the track stored on this device. Export it first if you need it.', okText: 'Clear' });
  if (!ok) return;
  S.track = []; trackLine.setLatLngs([]); await store.set('track', []); renderDataSheet(); toast('Track cleared.');
});

// ================= accuracy report =================
function confusion(ds) {
  const visits = visitsFor(ds);
  const pairs = [];
  for (const t of ds.targets) {
    const v = visits.get(t.id);
    if (!v || v.access === 'not reached' || !v.cls || !t.mapped) continue;
    const mc = matchClass(t.mapped);
    pairs.push([mc ? mc.name : String(t.mapped).trim(), v.cls]);
  }
  const order = classes().map(c => c.name);
  for (const [m, r] of pairs) for (const x of [m, r]) if (!order.includes(x)) order.push(x);
  const used = order.filter(c => pairs.some(([m, r]) => m === c || r === c));
  const idx = Object.fromEntries(used.map((c, i) => [c, i]));
  const M = used.map(() => used.map(() => 0));
  for (const [m, r] of pairs) M[idx[m]][idx[r]]++;
  const n = pairs.length;
  const rowT = M.map(r => r.reduce((a, b) => a + b, 0));
  const colT = used.map((_, j) => M.reduce((a, r) => a + r[j], 0));
  const diag = used.reduce((a, _, i) => a + M[i][i], 0);
  const oa = n ? diag / n : 0;
  const pe = n ? used.reduce((a, _, i) => a + rowT[i] * colT[i], 0) / (n * n) : 0;
  const kappa = n && pe < 1 ? (oa - pe) / (1 - pe) : 0;
  const ci = n ? 1.96 * Math.sqrt(oa * (1 - oa) / n) : 0;
  return { cls: used, M, n, rowT, colT, diag, oa, kappa, ci, visits };
}
const pct = v => (v * 100).toFixed(1) + '%';
function renderReport() {
  const body = $('#reportBody');
  const pts = livePoints();
  const tr = pts.filter(p => p.kind === 'training'), nw = pts.filter(p => p.kind === 'new'), va = pts.filter(p => p.kind === 'validation');
  const people = new Set(pts.map(p => p.observer).filter(Boolean));
  let h = `<div class="kpis"><div class="kpi"><b>${tr.length}</b><small>training samples</small></div><div class="kpi"><b>${nw.length}</b><small>new points from ground truthing</small></div>
    <div class="kpi"><b>${va.length}</b><small>validation visits</small></div><div class="kpi"><b>${people.size}</b><small>people collecting</small></div></div>`;
  // samples per class (training + new points both make usable training data)
  const counts = classes().map(c => ({ c, n: tr.filter(p => p.cls === c.name).length, nn: nw.filter(p => p.cls === c.name).length }));
  const max = Math.max(1, ...counts.map(x => x.n + x.nn));
  h += `<h3>Samples per class</h3><p class="note">Training samples plus new points recorded while ground truthing. Classes with fewer than 50 are marked: a common minimum per class for training and accuracy work.</p><div class="bars">`;
  for (const { c, n, nn } of counts) h += `<div class="bar"><span>${esc(c.code)} · ${esc(c.name)}${n + nn < 50 ? ' <span class="pill">&lt;50</span>' : ''}</span><span class="tr"><i style="width:${((n + nn) / max) * 100}%;background:${esc(c.color)}"></i></span><span class="num">${n}${nn ? '+' + nn : ''}</span></div>`;
  h += '</div>';
  // per dataset
  const dss = liveDatasets();
  if (!dss.length) h += '<h3>Validation</h3><p class="note">Upload validation points (Data → Upload points file) to track ground-truthing progress and get an accuracy assessment.</p>';
  dss.forEach((ds, k) => {
    const cm = confusion(ds);
    const unreached = [...cm.visits.values()].filter(v => v.access === 'not reached').length;
    const disagree = [...cm.visits.values()].filter(v => v.agree === false).length;
    h += `<h3>${esc(ds.name)}</h3><p class="note">${cm.visits.size} of ${ds.targets.length} targets visited (${pct(ds.targets.length ? cm.visits.size / ds.targets.length : 0)}) · ${unreached} could not be reached · ${disagree} disagree with the map.</p>`;
    if (!ds.mapped_field) { h += '<p class="note">This dataset has no map class column, so there is no accuracy matrix. Re-upload it with the classified value of each point to get one.</p>'; return; }
    if (!cm.n) { h += '<p class="note">No visits with a class yet.</p>'; return; }
    h += `<div class="kpis"><div class="kpi"><b>${pct(cm.oa)}</b><small>overall accuracy (±${pct(cm.ci)}, 95%)</small></div><div class="kpi"><b>${cm.kappa.toFixed(3)}</b><small>Cohen's kappa</small></div><div class="kpi"><b>${cm.n}</b><small>points in matrix</small></div></div>`;
    h += `<p class="note">Rows: class on the map. Columns: class found on the ground (reference). User's accuracy = row diagonal / row total; producer's accuracy = column diagonal / column total.</p>`;
    h += `<div class="tableWrap"><table class="cm"><tr><th class="rowh">Map ↓ / Ground →</th>${cm.cls.map(c => `<th>${esc(c)}</th>`).join('')}<th class="tot">Total</th><th>User's acc.</th></tr>`;
    cm.cls.forEach((c, i) => {
      h += `<tr><th class="rowh">${esc(c)}</th>${cm.M[i].map((v, j) => `<td class="${i === j ? 'diag' : ''}">${v || ''}</td>`).join('')}<td class="tot">${cm.rowT[i]}</td><td>${cm.rowT[i] ? pct(cm.M[i][i] / cm.rowT[i]) : '—'}</td></tr>`;
    });
    h += `<tr><th class="rowh tot">Total</th>${cm.colT.map(v => `<td class="tot">${v}</td>`).join('')}<td class="tot">${cm.n}</td><td></td></tr>`;
    h += `<tr><th class="rowh">Producer's acc.</th>${cm.cls.map((_, j) => `<td>${cm.colT[j] ? pct(cm.M[j][j] / cm.colT[j]) : '—'}</td>`).join('')}<td>${pct(cm.oa)}</td><td></td></tr></table></div>`;
    h += `<div class="btnRow"><button class="ghostBtn" type="button" data-cm="${k}">Download matrix (CSV)</button><button class="ghostBtn" type="button" data-dis="${k}">Show disagreements on map</button></div>`;
  });
  // contributors
  if (people.size) {
    h += '<h3>By person</h3><div class="tableWrap"><table class="mini"><tr><th>Person</th><th>Training</th><th>New</th><th>Validation</th><th>Last point</th></tr>';
    for (const name of [...people].sort()) {
      const mine = pts.filter(p => p.observer === name);
      const last = mine.map(p => p.created_at).sort().pop();
      h += `<tr><td>${esc(name)}</td><td>${mine.filter(p => p.kind === 'training').length}</td><td>${mine.filter(p => p.kind === 'new').length}</td><td>${mine.filter(p => p.kind === 'validation').length}</td><td>${esc(fmtTime(last))}</td></tr>`;
    }
    h += '</table></div>';
  }
  body.innerHTML = h;
  body.querySelectorAll('[data-cm]').forEach(b => b.addEventListener('click', () => {
    const ds = dss[+b.dataset.cm], cm = confusion(ds);
    const lines = [['map \\ ground', ...cm.cls, 'total', 'users_accuracy']];
    cm.cls.forEach((c, i) => lines.push([c, ...cm.M[i], cm.rowT[i], cm.rowT[i] ? (cm.M[i][i] / cm.rowT[i]).toFixed(4) : '']));
    lines.push(['total', ...cm.colT, cm.n, '']);
    lines.push(['producers_accuracy', ...cm.cls.map((_, j) => cm.colT[j] ? (cm.M[j][j] / cm.colT[j]).toFixed(4) : ''), cm.oa.toFixed(4), '']);
    lines.push([]); lines.push(['overall_accuracy', cm.oa.toFixed(4)]); lines.push(['oa_95ci_halfwidth', cm.ci.toFixed(4)]); lines.push(['kappa', cm.kappa.toFixed(4)]); lines.push(['n', cm.n]);
    const text = '﻿' + lines.map(r => r.map(v => /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\r\n') + '\r\n';
    download(`${slug(S.project.name)}_${slug(ds.name)}_confusion_${stamp()}.csv`, text, 'text/csv');
  }));
  body.querySelectorAll('[data-dis]').forEach(b => b.addEventListener('click', () => {
    const ds = dss[+b.dataset.dis];
    setDataset(ds.id); if (S.mode !== 'truth') setMode('truth');
    closeSheets(); $('#statusSel').value = 'disagree'; fillClassFilter(); renderList(); openSheet('#listSheet');
  }));
}
$('#reportBtn').addEventListener('click', () => { renderReport(); openSheet('#reportSheet'); });

// ================= menu, projects, team =================
function renderMenu() {
  const u = user();
  $('#whoBox').innerHTML = `<div class="av">${esc((u.name || u.username).slice(0, 1).toUpperCase())}</div><div><b>${esc(u.name)}</b><small>${esc(u.username)} · ${esc(u.role)}${S.online ? '' : ' · offline'}</small></div>`;
  const pl = $('#projList'); pl.innerHTML = '';
  const vis = visibleProjects();
  if (!vis.length) pl.innerHTML = '<p class="note">No projects yet. Create one to start collecting.</p>';
  for (const p of vis) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'itemRow' + (S.project && S.project.id === p.id ? ' active' : '');
    row.innerHTML = `<div class="grow"><b>${esc(p.name)}${p.archived ? ' <span class="pill">archived</span>' : ''}</b><small>${p.classes.length} classes${p.description ? ' · ' + esc(p.description.slice(0, 90)) : ''}</small></div>${S.project && S.project.id === p.id ? '<span class="pill ok">open</span>' : ''}`;
    row.onclick = () => { closeSheets(); if (!S.project || S.project.id !== p.id) openProject(p.id); };
    pl.appendChild(row);
  }
  $('#editProjBtn').hidden = !canEditProject(S.project);
  $('#teamBtn').hidden = u.role !== 'admin';
  $('#optLabels').checked = settings.labels; $('#optTrack').checked = settings.track; $('#optAlert').checked = settings.alert;
  $('#optArrive').value = String(settings.arrive); $('#optAvgN').value = String(settings.avgN);
  $('#optTravel').value = travel(); $('#optOnline').checked = !!settings.onlineRoute;
}
$('#menuBtn').addEventListener('click', () => toggleSection('#menuSheet', () => { renderMenu(); openSheet('#menuSheet'); }));
$('#projBtn').addEventListener('click', () => openHub());
$('#hubBtn').addEventListener('click', () => openHub());
$('#allProjBtn').addEventListener('click', () => openHub());
$$('#baseSeg button').forEach(b => b.addEventListener('click', () => setBase(b.dataset.v)));
$('#optLabels').addEventListener('change', e => { settings.labels = e.target.checked; saveSettings(); labelVis(); });
$('#optTrack').addEventListener('change', e => { settings.track = e.target.checked; saveSettings(); e.target.checked ? trackLine.addTo(map) : map.removeLayer(trackLine); });
$('#optAlert').addEventListener('change', e => { settings.alert = e.target.checked; saveSettings(); });
$('#optArrive').addEventListener('change', e => { settings.arrive = +e.target.value; saveSettings(); updateNav(); });
$('#optAvgN').addEventListener('change', e => { settings.avgN = +e.target.value; saveSettings(); });
$('#optTravel').addEventListener('change', e => { settings.travel = e.target.value; saveSettings(); S.route = null; updateNav(); });
$('#optOnline').addEventListener('change', e => { settings.onlineRoute = e.target.checked; saveSettings(); S.route = null; updateNav(); });
$('#optRoads').addEventListener('change', e => { settings.showRoads = e.target.checked; saveSettings(); renderRoadsLayer(); if (e.target.checked && map.getZoom() < 12) toast('Zoom in closer to see the saved roads.'); });
$('#roadsDlBtn').addEventListener('click', () => downloadRoads(false));
$('#roadsFile').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !S.project) return;
  try { const n = await importRoadsFile(file); toast(`Imported ${n.toLocaleString()} road lines from ${file.name}. Routes now use them.`, 5000); updateNav(); }
  catch (err) { toast(err.message || 'That road file could not be read.', 6000); }
});
let wake = null;
$('#optWake').addEventListener('change', async e => {
  if (e.target.checked) { try { wake = await navigator.wakeLock.request('screen'); } catch { e.target.checked = false; toast('This device did not allow keeping the screen on.'); } }
  else if (wake) { wake.release(); wake = null; }
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if ($('#optWake').checked && (!wake || wake.released)) { try { wake = await navigator.wakeLock.request('screen'); } catch { /* ignore */ } }
    syncSoon();
  }
});
$('#logoutBtn').addEventListener('click', logout);
$('#pwBtn').addEventListener('click', async () => {
  closeSheets();
  await dialog({
    title: 'Change password', okText: 'Change',
    fields: [{ id: 'cur', label: 'Current password', type: 'password', autocomplete: 'current-password' }, { id: 'nw', label: 'New password (6+ characters)', type: 'password', autocomplete: 'new-password' }, { id: 'nw2', label: 'Repeat new password', type: 'password', autocomplete: 'new-password' }],
    validate: async v => {
      if (v.nw !== v.nw2) return 'The new passwords do not match.';
      try { const r = await api('POST', '/api/me/password', { current: v.cur, next: v.nw }); if (r.user) saveAuth(r.user); toast('Password changed. Other devices have been signed out.'); return null; } catch (e) { return e.message; }
    },
  });
});

// ---------- project editor ----------
let editingProject = null;
function openProjectEditor(p) {
  editingProject = p;
  $('#projSheetTitle').textContent = p ? `Edit ${p.name}` : 'New project';
  $('#pName').value = p ? p.name : ''; $('#pDesc').value = p ? p.description : '';
  $('#pPreset').innerHTML = (p ? '<option value="">Keep current classes</option>' : '') + Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('') + '<option value="custom">Start empty (type my own)</option>';
  $('#pPreset').value = p ? '' : 'lulc';
  $('#pClasses').value = classText(p ? p.classes : toClasses(PRESETS.lulc.classes));
  $('#pArchRow').hidden = !p; $('#pArchived').checked = !!(p && p.archived);
  $('#pOwnerNote').hidden = !!p;
  $('#pSave').textContent = p ? 'Save changes' : 'Create project';
  $('#pErr').textContent = '';
  swatches(); openSheet('#projSheet');
  if (!p) setTimeout(() => $('#pName').focus({ preventScroll: true }), 260);
}
function swatches() { $('#pSwatches').innerHTML = parseClassText($('#pClasses').value).map(c => `<span><i style="background:${esc(c.color)}"></i>${esc(c.code)} ${esc(c.name)}</span>`).join(''); }
$('#pClasses').addEventListener('input', swatches);
$('#pPreset').addEventListener('change', e => {
  const k = e.target.value;
  if (k === 'custom') $('#pClasses').value = '';
  else if (PRESETS[k]) $('#pClasses').value = classText(toClasses(PRESETS[k].classes));
  else if (editingProject) $('#pClasses').value = classText(editingProject.classes);
  swatches();
});
$('#newProjBtn').addEventListener('click', () => openProjectEditor(null));
$('#editProjBtn').addEventListener('click', () => openProjectEditor(S.project));
$('#pSave').addEventListener('click', async () => {
  const cls = parseClassText($('#pClasses').value);
  if (!$('#pName').value.trim()) { $('#pErr').textContent = 'Give the project a name.'; return; }
  if (!cls.length) { $('#pErr').textContent = 'Add at least one class.'; return; }
  const codes = cls.map(c => c.code);
  if (new Set(codes).size !== codes.length) { $('#pErr').textContent = 'Two classes share the same code. Give each class its own number.'; return; }
  const body = { name: $('#pName').value.trim(), description: $('#pDesc').value.trim(), classes: cls };
  if (editingProject) body.archived = $('#pArchived').checked;
  $('#pSave').disabled = true;
  try {
    const r = editingProject ? await api('PATCH', '/api/projects/' + editingProject.id, body) : await api('POST', '/api/projects', body);
    await loadProjects();
    closeSheets();
    if (!editingProject) { closeHub(); await openProject(r.project.id); }
    else if (S.project && S.project.id === r.project.id) await openProject(r.project.id);
    if (!$('#hub').hidden) renderHub();
    toast(editingProject ? 'Project saved.' : `Project “${r.project.name}” created. You can start collecting.`);
  } catch (e) { $('#pErr').textContent = e.offline ? 'Projects can only be created or edited with a connection to the server.' : e.message; }
  finally { $('#pSave').disabled = false; }
});

// ---------- projects hub ----------
// The home screen: every project as a card with its figures, a search, and a button to start a new one.
const initials = s => String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
function ago(t) {
  if (!t || !Number.isFinite(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  const units = [[60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = s / 60;
  for (const [n, name] of units) { if (v < n) { const k = Math.floor(v); return `${k} ${name}${k === 1 ? '' : 's'} ago`; } v /= n; }
  return '';
}
let hubFilter = 'all';
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function renderHub() {
  const u = user();
  if (!u) return;
  $('#hubAv').textContent = initials(u.name || u.username);
  $('#hubUName').textContent = u.name;
  $('#hubURole').textContent = u.role[0].toUpperCase() + u.role.slice(1) + (S.online ? '' : ' · offline');
  $('#hubTeam').hidden = u.role !== 'admin';
  $('#hubDate').textContent = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  $('#hubGreet').textContent = `${greeting()}, ${u.name.split(' ')[0]}`;
  $('#hubBack').hidden = !S.project;
  const all = visibleProjects();
  const active = all.filter(p => !p.archived);
  const tot = all.reduce((a, p) => { const s = p.stats || {}; a.points += s.points || 0; a.mine += s.mine || 0; a.datasets += s.datasets || 0; return a; }, { points: 0, mine: 0, datasets: 0 });
  $('#hubSub').textContent = !all.length
    ? 'Create your first project to start collecting ground points.'
    : `${active.length} active project${active.length === 1 ? '' : 's'}. Pick one to open it on the map, or start a new one.`;
  const stat = (ic, n, label) => `<div class="statCard"><span class="statIc"><svg class="ic"><use href="#${ic}"/></svg></span><span><b class="num">${n.toLocaleString()}</b><small>${label}</small></span></div>`;
  $('#hubStats').innerHTML = all.length ? [
    stat('i-grid', active.length, 'Active projects'),
    stat('i-pin', tot.points, 'Points collected'),
    stat('i-leaf', tot.mine, 'Collected by you'),
    stat('i-target', tot.datasets, 'Validation datasets'),
  ].join('') : '';
  $('#hubStats').hidden = !all.length;
  $$('#hubTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === hubFilter)));
  const q = norm($('#hubQ').value);
  let list = all.filter(p => hubFilter === 'archived' ? p.archived : !p.archived);
  if (hubFilter === 'mine') list = list.filter(p => p.created_by === u.id);
  if (q) list = list.filter(p => norm(p.name + ' ' + p.description + ' ' + (p.created_by_name || '')).includes(q));
  const grid = $('#projGrid'); grid.innerHTML = '';
  if (!all.length) {
    grid.innerHTML = `<div class="emptyState"><span class="emptyArt"><svg class="ic"><use href="#i-leaf"/></svg></span>
      <h2>No projects yet</h2><p>A project holds a class list (for example land-cover classes), the points your team collects, and any validation datasets.</p>
      <button class="btn primary lg" type="button" data-new><svg class="ic sm"><use href="#i-plus"/></svg>Create your first project</button></div>`;
  } else if (!list.length) {
    grid.innerHTML = `<div class="emptyState slim"><p>${q ? 'No projects match your search.' : hubFilter === 'archived' ? 'No archived projects.' : hubFilter === 'mine' ? 'You have not created a project yet.' : 'No active projects.'}</p></div>`;
  }
  list.forEach((p, i) => {
    const s = p.stats || {};
    const open = S.project && S.project.id === p.id;
    const card = document.createElement('article');
    card.className = 'projCard' + (open ? ' isOpen' : '') + (p.archived ? ' isArchived' : '');
    card.style.setProperty('--i', String(Math.min(i, 12)));
    const strip = p.classes.slice(0, 12).map(c => `<i style="background:${esc(c.color)}" title="${esc(c.name)}"></i>`).join('');
    const when = s.last_activity ? 'Active ' + ago(s.last_activity) : 'Created ' + ago(Date.parse(p.created_at));
    const mine = p.created_by === u.id;
    card.innerHTML = `
      <div class="pcStrip">${strip}</div>
      <div class="pcBody">
        <div class="pcHead">
          <h3>${esc(p.name)}</h3>
          ${open ? '<span class="badge ok">Open</span>' : ''}${p.archived ? '<span class="badge">Archived</span>' : ''}
        </div>
        ${p.created_by_name ? `<p class="pcBy">by ${mine ? 'you' : esc(p.created_by_name)}</p>` : ''}
        <p class="pcDesc">${p.description ? esc(p.description) : '<span class="muted">No description</span>'}</p>
        <div class="pcStats">
          <span title="Points"><svg class="ic sm"><use href="#i-pin"/></svg><b class="num">${(s.points || 0).toLocaleString()}</b> points</span>
          <span title="Validation datasets"><svg class="ic sm"><use href="#i-target"/></svg><b class="num">${s.datasets || 0}</b> datasets</span>
          <span title="People who collected"><svg class="ic sm"><use href="#i-users"/></svg><b class="num">${s.people || 0}</b></span>
        </div>
      </div>
      <footer class="pcFoot">
        <span class="pcMeta"><svg class="ic sm"><use href="#i-clock"/></svg>${esc(when)}</span>
        <span class="pcActions">
          ${canEditProject(p) ? '<button class="iconBtn sm" type="button" data-edit aria-label="Edit project" title="Edit project"><svg class="ic sm"><use href="#i-edit"/></svg></button>' : ''}
          <button class="btn sm ${open ? '' : 'primary'}" type="button" data-open>${open ? 'Back to map' : 'Open'}<svg class="ic sm"><use href="#i-arrow"/></svg></button>
        </span>
      </footer>`;
    card.addEventListener('click', e => {
      if (e.target.closest('[data-edit]')) { openProjectEditor(p); return; }
      closeHub();
      if (!open) openProject(p.id);
    });
    grid.appendChild(card);
  });
  grid.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => openProjectEditor(null)));
}
async function openHub() {
  closeSheets();
  document.body.classList.add('hub-open');
  renderHub();
  reveal($('#hub'));
  $('#hubBtn').setAttribute('aria-current', 'true');
  // refresh the figures in the background
  try { await loadProjects(); if (!$('#hub').hidden) renderHub(); } catch { /* offline: cached list */ }
}
function closeHub() {
  if ($('#hub').hidden) return;
  if (!$('#projSheet').classList.contains('open')) closeSheets();
  document.body.classList.remove('hub-open');
  conceal($('#hub'), 260);
  $('#hubBtn').removeAttribute('aria-current');
  setTimeout(() => map.invalidateSize({ pan: false }), 280);
}
$('#hubNew').addEventListener('click', () => openProjectEditor(null));
$('#hubBack').addEventListener('click', closeHub);
$('#hubSignOut').addEventListener('click', logout);
$('#hubTeam').addEventListener('click', () => { closeHub(); openAccounts(); });
$('#hubQ').addEventListener('input', renderHub);
$$('#hubTabs button').forEach(b => b.addEventListener('click', () => { hubFilter = b.dataset.f; renderHub(); }));

// ---------- team ----------
async function renderTeam() {
  const box = $('#teamList'); box.innerHTML = '<p class="note">Loading…</p>';
  let users;
  try { users = (await api('GET', '/api/users')).users; } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  box.innerHTML = '';
  for (const u of users) {
    const row = document.createElement('div'); row.className = 'itemRow';
    const seen = u.must_change ? 'Not signed in yet' : u.last_login ? 'Last sign-in ' + ago(Date.parse(u.last_login)) : '';
    row.innerHTML = `<span class="av sm">${esc(initials(u.name || u.username))}</span><div class="grow"><b>${esc(u.name)}${u.id === user().id ? ' (you)' : ''}${u.active ? '' : ' <span class="pill">disabled</span>'}</b><small>${esc(u.username)}${seen ? ' · ' + esc(seen) : ''}</small></div>`;
    const role = document.createElement('select'); role.setAttribute('aria-label', 'Role for ' + u.name); role.style.width = 'auto';
    role.innerHTML = ['collector', 'manager', 'admin'].map(r => `<option${r === u.role ? ' selected' : ''}>${r}</option>`).join('');
    role.onchange = async () => { try { await api('PATCH', '/api/users/' + u.id, { role: role.value }); toast('Role updated.'); } catch (e) { toast(e.message); } renderTeam(); };
    const pw = document.createElement('button'); pw.className = 'chipBtn'; pw.type = 'button'; pw.textContent = 'Reset password';
    pw.onclick = async () => {
      await dialog({ title: `New password for ${u.name}`, text: 'They will be signed out on all devices and must use this password next time.', okText: 'Set password',
        fields: [{ id: 'pw', label: 'New password (6+ characters)', type: 'text', autocomplete: 'off' }],
        validate: async v => { try { await api('PATCH', '/api/users/' + u.id, { password: v.pw }); toast('Password reset.'); return null; } catch (e) { return e.message; } } });
    };
    const act = document.createElement('button'); act.className = 'chipBtn' + (u.active ? ' danger' : ''); act.type = 'button'; act.textContent = u.active ? 'Disable' : 'Enable';
    act.onclick = async () => { try { await api('PATCH', '/api/users/' + u.id, { active: !u.active }); } catch (e) { toast(e.message); } renderTeam(); };
    row.append(role, pw, act); box.appendChild(row);
  }
}
// ---------- accounts (admin) ----------
function setRole(v) {
  $('#tRole').value = v;
  $$('#tRoleList button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v)));
}
$$('#tRoleList button').forEach(b => b.addEventListener('click', () => setRole(b.dataset.v)));
function openAccounts() {
  if (!user() || user().role !== 'admin') { toast('Only an admin can create accounts.'); return; }
  $('#tErr').textContent = '';
  setRole($('#tRole').value || 'collector');
  renderTeam();
  openSheet('#teamSheet');
  $('#teamSheet .sheetBody').scrollTop = 0;
  setTimeout(() => $('#tName').focus({ preventScroll: true }), 250);
}
function updateAdminBtn() { $('#adminBtn').hidden = !(user() && user().role === 'admin'); }
$('#adminBtn').addEventListener('click', () => toggleSection('#teamSheet', openAccounts));
$('#teamBtn').addEventListener('click', openAccounts);

// readable temporary password: no 0/O, 1/l/I look-alikes
function makePassword(n = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(n));
  return [...r].map(x => abc[x % abc.length]).join('');
}
$('#tGen').addEventListener('click', () => { $('#tPass').value = makePassword(); });
// suggest a username from the full name until the admin types one
let userTouched = false;
$('#tUser').addEventListener('input', () => { userTouched = $('#tUser').value.trim() !== ''; });
$('#tName').addEventListener('input', () => {
  if (userTouched) return;
  const parts = $('#tName').value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
  $('#tUser').value = parts.length ? (parts[0] + (parts.length > 1 ? '.' + parts[parts.length - 1] : '')).replace(/[^a-z0-9._-]/g, '').slice(0, 40) : '';
});
$('#tAdd').addEventListener('click', async () => {
  $('#tErr').textContent = '';
  const name = $('#tName').value.trim(), username = $('#tUser').value.trim(), password = $('#tPass').value, role = $('#tRole').value;
  if (!name) { $('#tErr').textContent = 'Enter the person\'s full name.'; $('#tName').focus(); return; }
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) { $('#tErr').textContent = 'Username: 2–40 letters, numbers, dot, dash or underscore (no spaces).'; $('#tUser').focus(); return; }
  if (password.length < 6) { $('#tErr').textContent = 'Password must be at least 6 characters. Tap Generate for one.'; $('#tPass').focus(); return; }
  $('#tAdd').disabled = true;
  try {
    await api('POST', '/api/users', { name, username, password, role });
    $('#tName').value = $('#tUser').value = $('#tPass').value = ''; userTouched = false; setRole('collector');
    renderTeam();
    // show the sign-in details once so the admin can pass them on
    const address = location.origin;
    const details = `Addy: ${address}\nUsername: ${username}\nPassword: ${password}\nRole: ${role}`;
    const shown = dialog({ title: `Account created for ${name}`, text: 'Give them these sign-in details. The password is temporary: Addy asks them to choose their own the first time they sign in, and it is not shown again here.', okText: 'Copy details', cancelText: 'Done' });
    const box = document.createElement('div'); box.className = 'credBox'; box.textContent = details; $('#dlgFields').appendChild(box);
    if (await shown) { try { await navigator.clipboard.writeText(details); toast('Sign-in details copied.'); } catch { toast('Select the details and copy them manually.'); } }
  } catch (e) { $('#tErr').textContent = e.offline ? 'Creating accounts needs a connection to the server.' : e.message; }
  finally { $('#tAdd').disabled = false; }
});

// ================= sheets =================
const SECTION_OF = { '#listSheet': '#listBtn', '#dataSheet': '#dataBtn', '#mapSheet': '#dataBtn', '#reportSheet': '#reportNavBtn', '#menuSheet': '#menuBtn', '#projSheet': '#menuBtn', '#teamSheet': '#menuBtn' };
let resizeT;
function mapResized() { clearTimeout(resizeT); resizeT = setTimeout(() => map.invalidateSize({ pan: false }), 240); }
function openSheet(sel) {
  const el = $(sel);
  $$('.sheet').forEach(s => s !== el && s.classList.remove('open'));
  el.classList.add('open');
  document.body.classList.add('panel-open');
  document.body.classList.toggle('panel-wide', el.classList.contains('wide'));
  document.body.classList.toggle('recording', sel === '#recSheet');
  $$('.tool').forEach(t => t.removeAttribute('aria-current'));
  if (SECTION_OF[sel]) $(SECTION_OF[sel]).setAttribute('aria-current', 'true');
  mapResized();
}
function closeSheets() {
  const wasOpen = document.body.classList.contains('panel-open');
  $$('.sheet').forEach(s => s.classList.remove('open'));
  document.body.classList.remove('panel-open', 'panel-wide', 'recording');
  $$('.tool').forEach(t => t.removeAttribute('aria-current'));
  if (avg) stopAvg();
  if (wasOpen) mapResized();
}
// tapping the active section again closes it
function toggleSection(sel, open) { if ($(sel).classList.contains('open')) closeSheets(); else open(); }
$('#reportNavBtn').addEventListener('click', () => toggleSection('#reportSheet', () => { renderReport(); openSheet('#reportSheet'); }));
$('#layersBtn').addEventListener('click', () => toggleSection('#layersSheet', () => { renderDataSheet(); setBase(settings.base); $('#optRoads').checked = !!settings.showRoads; renderRoadsNote(); openSheet('#layersSheet'); }));
$$('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#dlg').hidden) closeSheets(); });

// ================= sync =================
function updateSyncChip() {
  const n = [...S.points.values()].filter(p => p.dirty).length + [...S.datasets.values()].filter(d => d.dirty).length;
  const chip = $('#syncChip');
  let s, txt;
  if (S.syncing) { s = 'busy'; txt = 'Syncing…'; }
  else if (!S.online) { s = 'offline'; txt = n ? `Offline · ${n} to send` : 'Offline'; }
  else if (S.syncErr) { s = 'error'; txt = 'Sync failed'; }
  else if (n) { s = 'pending'; txt = `${n} to send`; }
  else { s = 'ok'; txt = 'Synced'; }
  chip.dataset.s = s; $('#syncTxt').textContent = txt;
  chip.title = S.syncErr ? `Last sync failed: ${S.syncErr}. Tap to retry.` : `${txt}. Tap to sync now.`;
}
let syncT;
function syncSoon() { clearTimeout(syncT); syncT = setTimeout(() => sync(), 1500); updateSyncChip(); }
async function sync(manual) {
  if (!S.project || S.syncing || !S.auth) return;
  S.syncing = true; S.syncErr = null; updateSyncChip();
  const pid = S.project.id;
  try {
    const dirtyPts = [...S.points.values()].filter(p => p.dirty);
    const dirtyDs = [...S.datasets.values()].filter(d => d.dirty);
    // send in chunks so photos don't make one giant request; pull changes on the last one
    const chunks = [];
    let cur = [], size = 0;
    for (const p of dirtyPts) {
      const sz = (p.photo ? p.photo.length : 0) + 1000;
      if (cur.length && (size + sz > 6e6 || cur.length >= 300)) { chunks.push(cur); cur = []; size = 0; }
      cur.push(p); size += sz;
    }
    chunks.push(cur);
    let since = await store.get('seq:' + pid, 0), res;
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const sent = chunks[i];
      res = await api('POST', `/api/projects/${pid}/sync`, { since: last ? since : Number.MAX_SAFE_INTEGER, points: sent.map(stripLocal), datasets: i === 0 ? dirtyDs.map(stripLocal) : [] });
      if (!S.project || S.project.id !== pid) return; // switched project mid-sync
      const ok = new Set(res.accepted);
      const rej = new Map(res.rejected.map(r => [r.id, r.why]));
      const save = [];
      for (const p of sent) {
        const now = S.points.get(p.id);
        if (!now || now.updated_at !== p.updated_at) continue; // edited again while sending
        if (ok.has(p.id) || rej.has(p.id)) { now.dirty = false; if (rej.has(p.id)) now.sync_error = rej.get(p.id); save.push(now); }
      }
      if (save.length) await store.put('points', save);
      if (i === 0) {
        const dsave = [];
        for (const d of dirtyDs) { const n = S.datasets.get(d.id); if (n && n.updated_at === d.updated_at && (ok.has(d.id) || rej.has(d.id))) { n.dirty = false; dsave.push(n); } }
        if (dsave.length) await store.put('datasets', dsave);
      }
      if (res.rejected.length) toast(`${res.rejected.length} item(s) were refused by the server: ${res.rejected[0].why}.`, 6000);
    }
    // merge what others sent
    const ps = [];
    for (const sp of res.points) {
      const loc = S.points.get(sp.id);
      if (loc && loc.dirty && loc.updated_at > sp.updated_at) continue;
      const p = { ...sp, dirty: false }; S.points.set(p.id, p); ps.push(p);
    }
    if (ps.length) await store.put('points', ps);
    const ds = [];
    for (const sd of res.datasets) {
      const loc = S.datasets.get(sd.id);
      if (loc && loc.dirty && loc.updated_at > sd.updated_at) continue;
      const d = { ...sd, dirty: false }; S.datasets.set(d.id, d); ds.push(d);
    }
    if (ds.length) await store.put('datasets', ds);
    await store.set('seq:' + pid, res.seq);
    let projChanged = false;
    // the sync reply carries the core project fields; keep the list's extras (stats, owner name)
    const core = p => p && JSON.stringify([p.name, p.description, p.classes, p.archived, p.updated_at]);
    if (res.project && core(res.project) !== core(S.project)) {
      projChanged = true;
      S.project = { ...S.project, ...res.project }; S.projects = S.projects.map(p => p.id === pid ? S.project : p); await store.set('projects', S.projects);
      $('#projName').textContent = S.project.name;
    }
    if (S.dsId && !activeDs()) S.dsId = (liveDatasets()[0] || {}).id || null;
    if (!S.dsId && liveDatasets().length) S.dsId = liveDatasets()[0].id;
    S.online = true;
    if (ps.length || ds.length || projChanged) renderAll(false);
    if (manual) toast(ps.length || ds.length ? `Synced. ${ps.length + ds.length} update(s) from the team.` : 'Synced. Everything is up to date.');
  } catch (e) {
    if (e.offline) { S.online = false; if (manual) toast('No connection to the server. Your points are safe on this device.'); }
    else if (e.status === 401) { S.syncErr = 'signed out'; showAuth('login', 'Your session has ended. Sign in again; your unsynced points are kept on this device.'); }
    else if (e.status === 404) { S.syncErr = e.message; toast(e.message, 5000); }
    else { S.syncErr = e.message; if (manual) toast('Sync failed: ' + e.message, 5000); }
  } finally { S.syncing = false; updateSyncChip(); }
}
function stripLocal(x) { const c = { ...x }; delete c.dirty; delete c.sync_error; return c; }
$('#syncChip').addEventListener('click', () => sync(true));
window.addEventListener('online', () => { S.online = true; syncSoon(); });
window.addEventListener('offline', () => { S.online = false; updateSyncChip(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);

// ================= boot =================
// fresh: the person has just signed in, so show the projects hub. Otherwise reopen the last project straight away (field use).
// firstRun: the admin account was just created; step 2 of setup is the first project.
async function afterLogin({ fresh = false, firstRun = false } = {}) {
  updateAdminBtn();
  try { await loadProjects(); }
  catch (e) { if (e.status === 401) { clearAuth(); showAuth('login', 'Please sign in again.'); return; } }
  hideSplash();
  const vis = visibleProjects();
  const pick = vis.find(p => p.id === settings.lastProject) || vis.find(p => !p.archived);
  if (pick && !fresh) { await openProject(pick.id); return; }
  if (pick) await openProject(pick.id);
  else { $('#projName').textContent = 'No project'; renderAll(false); }
  await openHub();
  if (firstRun) {
    openProjectEditor(null);
    toast('Admin account ready. Step 2: name your first project and choose a class scheme.', 6000);
  }
}

async function boot() {
  setBase(settings.base);
  S.track = await store.get('track', []);
  trackLine.setLatLngs(S.track.map(t => [t[0], t[1]]));
  if (settings.track) trackLine.addTo(map);
  let status = null;
  try { status = await api('GET', '/api/status'); S.online = true; $('#appVersion').textContent = `Version ${status.version} · build ${APP_BUILD}`; } catch { S.online = false; }
  if (status && status.needsSetup) { clearAuth(); showAuth('setup'); return; }
  if (S.online) {
    // the cookie decides whether we are signed in, whatever this device remembers
    try { const r = await api('GET', '/api/me'); saveAuth(r.user); }
    catch (e) {
      if (e.status === 401) { const had = !!S.auth; clearAuth(); showAuth('login', had ? 'Your session has ended. Please sign in again.' : ''); return; }
      if (!S.auth) { showAuth('login', 'Cannot reach the server. Connect to sign in the first time.'); return; }
    }
  } else if (!S.auth) { showAuth('login', 'Cannot reach the server. Connect to sign in the first time.'); return; }
  if (user().must_change && S.online) { showAuth('change'); return; }
  $('#auth').hidden = true;
  await afterLogin();
  hideSplash();
}
boot().catch(e => { console.error(e); hideSplash(); toast('Addy could not start properly. Reload the page.'); });

// Offline cache. Always re-check sw.js with the server, and reload once when a newer version takes over,
// so phones pick up updates without having to clear anything.
if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => reg.update()).catch(() => {});
}
