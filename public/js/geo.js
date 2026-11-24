// Geodesy helpers: distance, bearing, WGS84 <-> UTM.
const R = 6371008.8;
export const rad = d => d * Math.PI / 180;
export const deg = r => r * 180 / Math.PI;

export function dist(a, b) {
  const dφ = rad(b.lat - a.lat), dλ = rad(b.lon - a.lon);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = b => CARD[Math.round(b / 22.5) % 16];
export const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;

// WGS84 ellipsoid, Transverse Mercator series (Snyder). Accurate to well under a metre inside a zone.
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);

export const utmZone = lon => Math.min(60, Math.floor((lon + 180) / 6) + 1);

export function toUTM(lat, lon, forceZone) {
  const zone = forceZone || utmZone(lon);
  const λ0 = rad((zone - 1) * 6 - 180 + 3);
  const φ = rad(lat), λ = rad(lon);
  const sin = Math.sin(φ), cos = Math.cos(φ), tan = Math.tan(φ);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan, C = EP2 * cos * cos, Aa = cos * (λ - λ0);
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * φ
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * φ)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * φ)
    - (35 * e6 / 3072) * Math.sin(6 * φ));
  const easting = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
  let northing = K0 * (M + N * tan * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  const hemi = lat < 0 ? 'S' : 'N';
  if (lat < 0) northing += 10000000;
  return { zone, hemi, easting, northing };
}

export function fromUTM(easting, northing, zone, hemi = 'N') {
  const x = easting - 500000;
  const y = String(hemi).toUpperCase().startsWith('S') ? northing - 10000000 : northing;
  const λ0 = rad((zone - 1) * 6 - 180 + 3);
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const φ1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sin = Math.sin(φ1), cos = Math.cos(φ1), tan = Math.tan(φ1);
  const N1 = A / Math.sqrt(1 - E2 * sin * sin);
  const T1 = tan * tan, C1 = EP2 * cos * cos;
  const R1 = A * (1 - E2) / Math.pow(1 - E2 * sin * sin, 1.5);
  const D = x / (N1 * K0);
  const lat = φ1 - (N1 * tan / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = λ0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / cos;
  return { lat: deg(lat), lon: deg(lon) };
}

// Mean position and spread (metres) of a set of fixes, weighting each fix by 1/accuracy².
export function averageFixes(fixes) {
  if (!fixes.length) return null;
  let sw = 0, la = 0, lo = 0;
  for (const f of fixes) { const w = 1 / Math.max(1, f.acc) ** 2; sw += w; la += f.lat * w; lo += f.lon * w; }
  const mean = { lat: la / sw, lon: lo / sw };
  const sd = Math.sqrt(fixes.reduce((s, f) => s + dist(mean, f) ** 2, 0) / fixes.length);
  const alts = fixes.map(f => f.alt).filter(a => a != null);
  return {
    lat: mean.lat, lon: mean.lon, n: fixes.length, sd,
    acc: Math.min(...fixes.map(f => f.acc)),
    alt: alts.length ? alts.reduce((a, b) => a + b, 0) / alts.length : null,
  };
}
