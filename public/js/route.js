// Road routing on OpenStreetMap-style road networks, computed on the device so it works without signal.
// Roads come from an Overpass download (OSM) or an imported GeoJSON/KML road file.
import { dist } from './geo.js';

// ---------- road classes and travel speeds (km/h) ----------
export const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'service', 'track', 'path', 'footway', 'bridleway', 'cycleway', 'steps', 'pedestrian', 'road'];
const C = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
// index order matches CLASSES; null = not usable in that mode
const SPEEDS = {
  walk: [null, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.2, 3.6, 4.5, 3.6, 4.5, 2.0, 4.5, 4.5],
  moto: [70, 60, 50, 45, 40, 32, 28, 15, 20, 18, 8, 6, 8, 10, null, 6, 25],
  car: [90, 70, 60, 50, 40, 30, 25, 10, 15, 12, null, null, null, null, null, null, 20],
};
export const OFFROAD_KMH = 2.5; // walking through farm bush / forest without a path
export const MODES = {
  walk: { label: 'Walk', verb: 'walk' },
  moto: { label: 'Motorbike', verb: 'by motorbike' },
  car: { label: 'Car', verb: 'drive' },
};
const MAX_SPEED = { walk: 4.5, moto: 70, car: 90 };

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// Map a highway/fclass value to one of CLASSES (OSM tags, Geofabrik shapefile fclass, or free text).
export function normClass(v) {
  let s = String(v || '').toLowerCase().trim().replace(/_link$/, '');
  if (s.startsWith('track')) return C.track;              // Geofabrik: track_grade1..5
  if (s === 'living street') s = 'living_street';
  if (s in C) return C[s];
  if (/foot|walk|trail/.test(s)) return C.footway;
  if (/path/.test(s)) return C.path;
  if (/motorway|highway|national/.test(s)) return C.trunk;
  if (/main|major|arterial|regional/.test(s)) return C.primary;
  if (/feeder|district|collector|minor/.test(s)) return C.tertiary;
  if (/street|urban|town/.test(s)) return C.residential;
  if (/dirt|unpaved|earth|gravel|laterite|farm|bush|logging/.test(s)) return C.track;
  return C.road;
}
function normOneway(v, tags = {}) {
  const s = String(v ?? '').toLowerCase();
  if (s === 'yes' || s === 'true' || s === '1' || s === 't') return 1;
  if (s === '-1' || s === 'reverse' || s === 'f') return -1;   // Geofabrik "F" = against digitising direction
  if (tags.junction === 'roundabout') return 1;
  return 0;
}
// flags: 1 = no motor vehicles, 2 = no pedestrians
function accessFlags(t) {
  let f = 0;
  const no = v => v === 'no' || v === 'private';
  if (no(t.access) || no(t.motor_vehicle) || no(t.vehicle)) f |= 1;
  if (no(t.foot) || (no(t.access) && !t.foot)) f |= 2;
  return f;
}

// ---------- reading road sources into polylines {c:[[lat,lon],...], cls, one, flags} ----------
export function polylinesFromOverpass(json) {
  const nodes = new Map();
  for (const e of json.elements || []) if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
  const out = [];
  for (const e of json.elements || []) {
    if (e.type !== 'way' || !e.tags || !e.tags.highway) continue;
    const c = e.geometry ? e.geometry.map(g => [g.lat, g.lon]) : (e.nodes || []).map(id => nodes.get(id)).filter(Boolean);
    if (c.length < 2) continue;
    out.push({ c, cls: normClass(e.tags.highway), one: normOneway(e.tags.oneway, e.tags), flags: accessFlags(e.tags), name: e.tags.name || e.tags.ref || '' });
  }
  return out;
}
export function polylinesFromGeoJSON(fc) {
  const out = [];
  const feats = fc.type === 'FeatureCollection' ? fc.features : fc.type === 'Feature' ? [fc] : [];
  for (const f of feats) {
    const g = f && f.geometry; if (!g) continue;
    const p = f.properties || {};
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const clsVal = p.highway ?? p.fclass ?? p.HIGHWAY ?? p.FCLASS ?? p.class ?? p.type ?? p.road_type ?? p.CLASS ?? p.TYPE ?? '';
    for (const l of lines) {
      const c = l.filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1])).map(x => [x[1], x[0]]);
      if (c.length >= 2) out.push({ c, cls: normClass(clsVal), one: normOneway(p.oneway ?? p.ONEWAY, p), flags: accessFlags(p), name: p.name || p.NAME || p.ref || '' });
    }
  }
  return out;
}

// OSM XML (.osm), e.g. from the Export button on openstreetmap.org or from JOSM. Browser only (DOMParser).
export function polylinesFromOsmXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This .osm file could not be read.');
  const nodes = new Map();
  for (const n of doc.getElementsByTagName('node')) nodes.set(n.getAttribute('id'), [+n.getAttribute('lat'), +n.getAttribute('lon')]);
  const out = [];
  for (const w of doc.getElementsByTagName('way')) {
    const tags = {};
    for (const t of w.getElementsByTagName('tag')) tags[t.getAttribute('k')] = t.getAttribute('v');
    if (!tags.highway || tags.area === 'yes' || /^(proposed|construction|abandoned|platform)$/.test(tags.highway)) continue;
    const c = [...w.getElementsByTagName('nd')].map(nd => nodes.get(nd.getAttribute('ref'))).filter(Boolean);
    if (c.length >= 2) out.push({ c, cls: normClass(tags.highway), one: normOneway(tags.oneway, tags), flags: accessFlags(tags), name: tags.name || tags.ref || '' });
  }
  return out;
}

// ---------- graph ----------
// Lines join wherever they share a vertex (to ~0.1 m), as OSM ways do.
export function buildGraph(polys, meta = {}) {
  const key = (la, lo) => Math.round(la * 1e6) + ':' + Math.round(lo * 1e6);
  const idx = new Map(), lat = [], lon = [];
  const ea = [], eb = [], ecls = [], eone = [], eflag = [], elen = [];
  const wnodes = [], woff = [0], wcls = [];
  const node = (la, lo) => { const k = key(la, lo); let i = idx.get(k); if (i === undefined) { i = lat.length; idx.set(k, i); lat.push(la); lon.push(lo); } return i; };
  for (const p of polys) {
    let prev = -1;
    for (const [la, lo] of p.c) {
      const i = node(la, lo);
      wnodes.push(i);
      if (prev >= 0 && prev !== i) {
        ea.push(prev); eb.push(i); ecls.push(p.cls); eone.push(p.one); eflag.push(p.flags);
        elen.push(dist({ lat: lat[prev], lon: lon[prev] }, { lat: la, lon: lo }));
      }
      prev = i;
    }
    woff.push(wnodes.length); wcls.push(p.cls);
  }
  let s = 90, w = 180, n = -90, e = -180;
  for (let i = 0; i < lat.length; i++) { if (lat[i] < s) s = lat[i]; if (lat[i] > n) n = lat[i]; if (lon[i] < w) w = lon[i]; if (lon[i] > e) e = lon[i]; }
  return {
    v: 1, ...meta, bbox: lat.length ? [s, w, n, e] : null, ways: polys.length,
    lat: Float64Array.from(lat), lon: Float64Array.from(lon),
    ea: Int32Array.from(ea), eb: Int32Array.from(eb), ecls: Uint8Array.from(ecls), eone: Int8Array.from(eone), eflag: Uint8Array.from(eflag), elen: Float32Array.from(elen),
    wnodes: Int32Array.from(wnodes), woff: Int32Array.from(woff), wcls: Uint8Array.from(wcls),
  };
}

// ---------- binary heap keyed by float ----------
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, topK = k[0], topV = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    this.lastKey = topK; return topV;
  }
}

export class Router {
  constructor(g) {
    this.g = g;
    const n = g.lat.length, m = g.ea.length;
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) { deg[g.ea[e] + 1]++; deg[g.eb[e] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const fill = deg.slice(0, n);
    this.off = deg; this.adjN = new Int32Array(2 * m); this.adjE = new Int32Array(2 * m); this.adjD = new Int8Array(2 * m);
    for (let e = 0; e < m; e++) {
      const a = g.ea[e], b = g.eb[e];
      let k = fill[a]++; this.adjN[k] = b; this.adjE[k] = e; this.adjD[k] = 1;
      k = fill[b]++; this.adjN[k] = a; this.adjE[k] = e; this.adjD[k] = -1;
    }
    // spatial grid of edges for snapping
    this.cell = 0.01;
    this.grid = new Map();
    for (let e = 0; e < m; e++) {
      const a = g.ea[e], b = g.eb[e];
      const r0 = Math.floor(Math.min(g.lat[a], g.lat[b]) / this.cell), r1 = Math.floor(Math.max(g.lat[a], g.lat[b]) / this.cell);
      const c0 = Math.floor(Math.min(g.lon[a], g.lon[b]) / this.cell), c1 = Math.floor(Math.max(g.lon[a], g.lon[b]) / this.cell);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const k = r * 100000 + c; let arr = this.grid.get(k); if (!arr) this.grid.set(k, arr = []); arr.push(e);
      }
    }
  }
  covers(p, marginDeg = 0.02) { const b = this.g.bbox; return !!b && p.lat >= b[0] - marginDeg && p.lat <= b[2] + marginDeg && p.lon >= b[1] - marginDeg && p.lon <= b[3] + marginDeg; }
  // travel speed (m/s) along edge e in direction dir (+1 = a→b), or 0 if not allowed
  speed(e, dir, mode) {
    const g = this.g, kmh = SPEEDS[mode][g.ecls[e]];
    if (!kmh) return 0;
    if (mode === 'walk') { if (g.eflag[e] & 2) return 0; }
    else { if (g.eflag[e] & 1) return 0; const o = g.eone[e]; if ((o === 1 && dir < 0) || (o === -1 && dir > 0)) return 0; }
    return kmh / 3.6;
  }
  // nearest point on a usable road within maxM metres
  snap(p, mode, maxM = 3000) {
    const g = this.g, cosφ = Math.cos(p.lat * Math.PI / 180), my = 110540, mx = 111320 * cosφ;
    const r = Math.ceil(maxM / (this.cell * 110540)) + 1;
    const pr = Math.floor(p.lat / this.cell), pc = Math.floor(p.lon / this.cell);
    let best = null, bd = maxM, seen = new Set();
    for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) {
      const arr = this.grid.get((pr + dr) * 100000 + (pc + dc)); if (!arr) continue;
      for (const e of arr) {
        if (seen.has(e)) continue; seen.add(e);
        if (!this.speed(e, 1, mode) && !this.speed(e, -1, mode)) continue;
        const a = g.ea[e], b = g.eb[e];
        const ax = (g.lon[a] - p.lon) * mx, ay = (g.lat[a] - p.lat) * my, bx = (g.lon[b] - p.lon) * mx, by = (g.lat[b] - p.lat) * my;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(qx, qy);
        if (d < bd) { bd = d; best = { e, t, d, lat: p.lat + qy / my, lon: p.lon + qx / mx }; }
      }
    }
    return best;
  }
  // Fastest route from `from` to `to`. Off-road legs at both ends are walked.
  route(from, to, mode = 'walk') {
    const g = this.g, vOff = OFFROAD_KMH / 3.6;
    const straight = dist(from, to);
    const direct = { kind: 'direct', coords: [[from.lat, from.lon], [to.lat, to.lon]], dist: straight, time: straight / vOff, offA: 0, offB: straight, roadDist: 0 };
    const S = this.snap(from, mode, 3000), T = this.snap(to, mode, 3000);
    if (!S || !T) return { ...direct, reason: 'no-road' };
    const n = g.lat.length, gs = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const heap = new Heap();
    const vmax = MAX_SPEED[mode] / 3.6;
    const h = i => dist({ lat: g.lat[i], lon: g.lon[i] }, T) / vmax;
    const seed = (node, cost) => { if (cost < gs[node]) { gs[node] = cost; heap.push(cost + h(node), node); } };
    const Le = g.elen[S.e], sF = this.speed(S.e, 1, mode), sB = this.speed(S.e, -1, mode);
    if (sB) seed(g.ea[S.e], Le * S.t / sB);
    if (sF) seed(g.eb[S.e], Le * (1 - S.t) / sF);
    const Lf = g.elen[T.e], fa = g.ea[T.e], fb = g.eb[T.e];
    const tF = this.speed(T.e, 1, mode), tB = this.speed(T.e, -1, mode);
    const endA = tF ? Lf * T.t / tF : Infinity;        // from node a along a→b to Q
    const endB = tB ? Lf * (1 - T.t) / tB : Infinity;  // from node b along b→a to Q
    let best = Infinity, bestEnd = -1;
    if (S.e === T.e) {
      const L = Le, dt = T.t - S.t;
      if (dt >= 0 && sF) { best = L * dt / sF; bestEnd = -2; }
      else if (dt < 0 && sB) { best = L * -dt / sB; bestEnd = -2; }
    }
    let iter = 0;
    while (heap.size) {
      const u = heap.pop(), fk = heap.lastKey;
      if (fk >= best) break;
      if (++iter > 3e6) break;
      const gu = gs[u];
      if (fk - h(u) > gu + 1e-6) continue; // stale entry
      if (u === fa && gu + endA < best) { best = gu + endA; bestEnd = fa; }
      if (u === fb && gu + endB < best) { best = gu + endB; bestEnd = fb; }
      for (let k = this.off[u]; k < this.off[u + 1]; k++) {
        const e = this.adjE[k], sp = this.speed(e, this.adjD[k], mode);
        if (!sp) continue;
        const v = this.adjN[k], ng = gu + g.elen[e] / sp;
        if (ng < gs[v]) { gs[v] = ng; prev[v] = u; heap.push(ng + h(v), v); }
      }
    }
    if (!Number.isFinite(best)) return { ...direct, reason: 'no-connection' };
    const nodes = [];
    if (bestEnd >= 0) { for (let x = bestEnd; x >= 0; x = prev[x]) nodes.push(x); nodes.reverse(); }
    const road = [[S.lat, S.lon], ...nodes.map(i => [g.lat[i], g.lon[i]]), [T.lat, T.lon]];
    let roadDist = 0;
    for (let i = 1; i < road.length; i++) roadDist += dist({ lat: road[i - 1][0], lon: road[i - 1][1] }, { lat: road[i][0], lon: road[i][1] });
    const offA = S.d, offB = T.d;
    const time = offA / vOff + best + offB / vOff;
    const res = { kind: 'road', coords: [[from.lat, from.lon], ...road, [to.lat, to.lon]], road, dist: offA + roadDist + offB, time, offA, offB, roadDist, straight };
    // walking straight there can beat a long detour along the network
    if (direct.time <= time) return { ...direct, reason: 'direct-faster', roadAlt: res };
    return res;
  }
}

// Point `ahead` metres along a polyline [[lat,lon],...] from its start; used to aim the arrow along the road.
export function pointAlong(coords, ahead) {
  let left = ahead;
  for (let i = 1; i < coords.length; i++) {
    const a = { lat: coords[i - 1][0], lon: coords[i - 1][1] }, b = { lat: coords[i][0], lon: coords[i][1] };
    const d = dist(a, b);
    if (d >= left && d > 0) { const f = left / d; return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }; }
    left -= d;
  }
  const l = coords[coords.length - 1]; return { lat: l[0], lon: l[1] };
}
// distance (m) from p to the nearest point of a polyline
export function distToLine(p, coords) {
  const cosφ = Math.cos(p.lat * Math.PI / 180), my = 110540, mx = 111320 * cosφ;
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][1] - p.lon) * mx, ay = (coords[i - 1][0] - p.lat) * my, bx = (coords[i][1] - p.lon) * mx, by = (coords[i][0] - p.lat) * my;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// Where p sits along a route polyline: distance off the line, metres still to go, and a point `ahead` metres further on.
export function progressOn(coords, p, ahead = 35) {
  const cosφ = Math.cos(p.lat * Math.PI / 180), my = 110540, mx = 111320 * cosφ;
  let best = Infinity, bi = 1, bt = 0;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][1] - p.lon) * mx, ay = (coords[i - 1][0] - p.lat) * my, bx = (coords[i][1] - p.lon) * mx, by = (coords[i][0] - p.lat) * my;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) { best = d; bi = i; bt = t; }
  }
  const a = coords[bi - 1], b = coords[bi];
  const here = [a[0] + (b[0] - a[0]) * bt, a[1] + (b[1] - a[1]) * bt];
  const rest = [here, ...coords.slice(bi)];
  let remaining = 0;
  for (let i = 1; i < rest.length; i++) remaining += dist({ lat: rest[i - 1][0], lon: rest[i - 1][1] }, { lat: rest[i][0], lon: rest[i][1] });
  return { off: best, remaining, aim: pointAlong(rest, ahead), idx: bi, t: bt, onFirstLeg: bi === 1, onFinalLeg: bi === coords.length - 1 };
}

// Time and distance still to go on route r from progress `prog`, counting walked legs and road legs at their own speeds.
// r.coords = [from, ...road, to]: segment 1 and the last segment are walked off-road; the rest is road.
export function remaining(r, prog) {
  const vOff = OFFROAD_KMH / 3.6, c = r.coords, n = c.length;
  let walk = prog.off, road = 0;
  for (let i = prog.idx; i < n; i++) {
    let L = dist({ lat: c[i - 1][0], lon: c[i - 1][1] }, { lat: c[i][0], lon: c[i][1] });
    if (i === prog.idx) L *= 1 - prog.t;
    if (r.kind !== 'road' || i === 1 || i === n - 1) walk += L; else road += L;
  }
  const roadTime = Math.max(0, r.time - (r.offA + r.offB) / vOff);
  return { dist: walk + road, walk, road, time: walk / vOff + (r.roadDist > 0 ? roadTime * Math.min(1, road / r.roadDist) : 0) };
}

// ---------- getting roads ----------
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// Download OSM roads inside bbox [s, w, n, e]; tries several public Overpass servers in turn.
export async function downloadOsmRoads(bbox, onStatus = () => {}) {
  const [s, w, n, e] = bbox.map(v => v.toFixed(5));
  const q = `[out:json][timeout:120];(way["highway"]["highway"!~"^(proposed|construction|abandoned|platform|raceway|bus_stop|elevator|corridor|via_ferrata|rest_area|services)$"]["area"!="yes"](${s},${w},${n},${e}););out body qt;>;out skel qt;`;
  let lastErr;
  for (const url of OVERPASS) {
    const host = new URL(url).host;
    onStatus(`Asking ${host}…`);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 150000);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!r.ok) throw new Error(`${host} answered ${r.status}`);
      const json = await r.json();
      return { json, source: host };
    } catch (err) { lastErr = err.name === 'AbortError' ? new Error(`${host} timed out`) : err; }
    finally { clearTimeout(timer); }
  }
  throw new Error(`The OpenStreetMap road servers are busy (${lastErr ? lastErr.message : 'no answer'}). Try again in a few minutes.`);
}

// Online fallback: OSRM servers run by FOSSGIS on OpenStreetMap data. Sends both positions to routing.openstreetmap.de.
export async function onlineRoute(from, to, mode) {
  const profile = mode === 'walk' ? 'routed-foot' : 'routed-car';
  const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${from.lon.toFixed(6)},${from.lat.toFixed(6)};${to.lon.toFixed(6)},${to.lat.toFixed(6)}?overview=full&geometries=geojson`;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const j = await r.json();
    if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error(j.message || 'No route');
    const rt = j.routes[0];
    const road = rt.geometry.coordinates.map(c => [c[1], c[0]]);
    const vOff = OFFROAD_KMH / 3.6;
    const offA = dist(from, { lat: road[0][0], lon: road[0][1] }), offB = dist({ lat: road[road.length - 1][0], lon: road[road.length - 1][1] }, to);
    // OSRM's car profile is used for motorbikes; they are a little quicker on rough rural roads
    const roadTime = mode === 'moto' ? rt.duration * 0.85 : rt.duration;
    const straight = dist(from, to);
    const res = { kind: 'road', online: true, coords: [[from.lat, from.lon], ...road, [to.lat, to.lon]], road, roadDist: rt.distance, offA, offB,
      dist: offA + rt.distance + offB, time: offA / vOff + roadTime + offB / vOff, straight };
    if (straight / vOff <= res.time) return { kind: 'direct', coords: [[from.lat, from.lon], [to.lat, to.lon]], dist: straight, time: straight / vOff, offA: 0, offB: straight, roadDist: 0, reason: 'direct-faster', roadAlt: res };
    return res;
  } finally { clearTimeout(timer); }
}
