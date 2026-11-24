// File input/output: CSV, GeoJSON, KML and GPX.

// ---------- CSV ----------
export function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = [',', ';', '\t', '|'].map(d => [d, first.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const d = detectDelimiter(text);
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (!rows.length) return { headers: [], rows: [] };
  const seen = {};
  const headers = rows[0].map((h, i) => {
    let n = h.trim() || `column_${i + 1}`;
    if (seen[n]) n = `${n}_${++seen[n]}`; else seen[n] = 1;
    return n;
  });
  return {
    headers,
    rows: rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))),
  };
}

const csvEsc = v => {
  v = v == null ? '' : String(v);
  return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
export function toCSV(cols, rows) {
  return [cols.join(',')].concat(rows.map(r => cols.map(c => csvEsc(r[c])).join(','))).join('\r\n') + '\r\n';
}

// Suggest which columns hold IDs, coordinates and the mapped class.
const PAT = {
  lat: /^(lat|latitude|lat_?dd|lat_?wgs84|point_?y|y|ycoord|y_coord|decimal_?latitude|gps_?lat(itude)?)$/i,
  lon: /^(lon|long|lng|longitude|lon_?dd|long_?dd|lon_?wgs84|point_?x|x|xcoord|x_coord|decimal_?longitude|gps_?lon(gitude)?)$/i,
  east: /^(e|east|easting|utm_?e(ast(ing)?)?|x_?utm|x_?m)$/i,
  north: /^(n|north|northing|utm_?n(orth(ing)?)?|y_?utm|y_?m)$/i,
  id: /^(id|fid|objectid|oid|point_?id|pt_?id|gt_?id|plot_?id|plot|sample_?id|name|label|code|pid|station)$/i,
  cls: /(class|landcover|land_cover|lulc|lc_|predict|mapped|map_?val|classname|category|type|value)/i,
};
export function guessColumns(headers, rows) {
  const find = re => headers.find(h => re.test(h.trim())) || '';
  let lat = find(PAT.lat), lon = find(PAT.lon);
  let east = find(PAT.east), north = find(PAT.north);
  // x/y columns holding projected metres are UTM, not degrees
  const sample = col => rows.slice(0, 50).map(r => parseFloat(r[col])).filter(Number.isFinite);
  if (lat && lon) {
    const ys = sample(lat), xs = sample(lon);
    if (ys.some(v => Math.abs(v) > 90) || xs.some(v => Math.abs(v) > 180)) { east = east || lon; north = north || lat; lat = lon = ''; }
  }
  const crs = lat && lon ? 'wgs84' : (east && north ? 'utm' : 'wgs84');
  const id = find(PAT.id);
  const cls = headers.find(h => h !== id && PAT.cls.test(h)) || '';
  return { id, lat, lon, east, north, cls, crs };
}

// ---------- GeoJSON / KML ----------
// Returns point features as {props, lat, lon}. Polygons and lines are ignored for target import.
export function pointsFromGeoJSON(obj) {
  const feats = obj.type === 'FeatureCollection' ? obj.features : obj.type === 'Feature' ? [obj] : [];
  const out = [];
  for (const f of feats) {
    const g = f && f.geometry;
    if (!g) continue;
    const coords = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [];
    for (const c of coords) out.push({ props: f.properties || {}, lon: +c[0], lat: +c[1] });
  }
  return out;
}

export function kmlToGeoJSON(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This KML file could not be read.');
  const parseCoords = s => s.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && c.every(Number.isFinite)).map(c => [c[0], c[1]]);
  const features = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const props = {};
    const nm = pm.getElementsByTagName('name')[0];
    if (nm) props.name = nm.textContent.trim();
    const desc = pm.getElementsByTagName('description')[0];
    if (desc) props.description = desc.textContent.trim();
    for (const d of pm.getElementsByTagName('Data')) { const v = d.getElementsByTagName('value')[0]; props[d.getAttribute('name')] = v ? v.textContent.trim() : ''; }
    for (const d of pm.getElementsByTagName('SimpleData')) props[d.getAttribute('name')] = d.textContent.trim();
    const geoms = [];
    for (const p of pm.getElementsByTagName('Point')) { const c = parseCoords(p.getElementsByTagName('coordinates')[0]?.textContent || ''); if (c[0]) geoms.push({ type: 'Point', coordinates: c[0] }); }
    for (const l of pm.getElementsByTagName('LineString')) geoms.push({ type: 'LineString', coordinates: parseCoords(l.getElementsByTagName('coordinates')[0]?.textContent || '') });
    for (const pg of pm.getElementsByTagName('Polygon')) {
      const rings = [];
      for (const b of pg.querySelectorAll('outerBoundaryIs, innerBoundaryIs')) rings.push(parseCoords(b.getElementsByTagName('coordinates')[0]?.textContent || ''));
      if (rings.length) geoms.push({ type: 'Polygon', coordinates: rings });
    }
    for (const g of geoms) features.push({ type: 'Feature', properties: props, geometry: g });
  }
  return { type: 'FeatureCollection', features };
}

// ---------- exports ----------
const xmlEsc = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function toGeoJSON(rows, { photos = false } = {}) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: rows.map(r => {
      const props = { ...r };
      delete props.photo_data;
      if (photos && r.photo_data) props.photo = r.photo_data;
      return { type: 'Feature', geometry: { type: 'Point', coordinates: r.alt_m !== '' && r.alt_m != null ? [r.lon, r.lat, r.alt_m] : [r.lon, r.lat] }, properties: props };
    }),
  });
}

export function toKML(rows, name, colorFor) {
  const styles = new Map();
  for (const r of rows) {
    const hex = (colorFor(r) || '#607d8b').replace('#', '');
    styles.set(hex, `<Style id="c${hex}"><IconStyle><color>ff${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}</color><scale>0.9</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`);
  }
  const pm = rows.map(r => {
    const hex = (colorFor(r) || '#607d8b').replace('#', '');
    const data = Object.entries(r).filter(([k]) => k !== 'photo_data').map(([k, v]) => `<Data name="${xmlEsc(k)}"><value>${xmlEsc(v)}</value></Data>`).join('');
    return `<Placemark><name>${xmlEsc(r.label || r.class)}</name><description>${xmlEsc([r.class, r.notes].filter(Boolean).join(' — '))}</description><styleUrl>#c${hex}</styleUrl><ExtendedData>${data}</ExtendedData><Point><coordinates>${r.lon},${r.lat}${r.alt_m !== '' && r.alt_m != null ? ',' + r.alt_m : ''}</coordinates></Point></Placemark>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEsc(name)}</name>${[...styles.values()].join('')}\n${pm}\n</Document></kml>\n`;
}

export function toGPXWaypoints(rows, name) {
  const w = rows.map(r => `<wpt lat="${r.lat}" lon="${r.lon}">${r.alt_m !== '' && r.alt_m != null ? `<ele>${r.alt_m}</ele>` : ''}<time>${xmlEsc(r.created_at)}</time><name>${xmlEsc(r.label)}</name><desc>${xmlEsc([r.class, r.notes].filter(Boolean).join(' — '))}</desc><type>${xmlEsc(r.class)}</type></wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Addy" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${xmlEsc(name)}</name></metadata>\n${w}\n</gpx>\n`;
}

export function trackToGPX(track, name) {
  const t = track.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Addy" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${xmlEsc(name)}</name><trkseg>${t}</trkseg></trk></gpx>\n`;
}

export function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
