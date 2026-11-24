// Starting class schemes. Codes are integers so exports drop straight into
// Google Earth Engine, QGIS or R classifiers as training labels.
export const PRESETS = {
  lulc: {
    label: 'Land use / land cover (general)',
    classes: [
      [1, 'Dense forest', '#1b5e20'], [2, 'Open / degraded forest', '#66bb6a'], [3, 'Shrub / grassland', '#c0ca33'],
      [4, 'Cropland / farm', '#f9a825'], [5, 'Tree crop (cocoa, oil palm, rubber)', '#8d6e00'], [6, 'Built-up / settlement', '#d32f2f'],
      [7, 'Bare soil / rock', '#a1887f'], [8, 'Water', '#1e88e5'], [9, 'Wetland', '#26a69a'], [10, 'Mining', '#6a1b9a'],
    ],
  },
  mining: {
    label: 'Mining ground-truth (galamsey)',
    classes: [
      [1, 'Mining - active', '#c62828'], [2, 'Mining - abandoned', '#8e24aa'], [3, 'Mining - recovering', '#f9a825'],
      [4, 'Not mining', '#2e7d32'], [5, 'Mining pond / turbid water', '#0277bd'],
    ],
  },
  forest: {
    label: 'Forest condition',
    classes: [
      [1, 'Intact closed forest', '#1b5e20'], [2, 'Degraded forest', '#7cb342'], [3, 'Selectively logged', '#9e9d24'],
      [4, 'Burnt', '#3e2723'], [5, 'Plantation', '#00897b'], [6, 'Cleared / farm', '#f9a825'],
    ],
  },
  habitat: {
    label: 'Habitat survey (herps / biodiversity)',
    classes: [
      [1, 'Primary forest', '#1b5e20'], [2, 'Secondary forest', '#558b2f'], [3, 'Riparian / stream', '#0288d1'],
      [4, 'Swamp / wetland', '#26a69a'], [5, 'Farmbush', '#c0ca33'], [6, 'Farm / plantation', '#f9a825'], [7, 'Rocky outcrop', '#8d6e63'],
    ],
  },
};

export const toClasses = list => list.map(([code, name, color]) => ({ code, name, color }));

// "code, name, #colour" per line; code and colour are optional.
const PALETTE = ['#1b5e20', '#f9a825', '#1e88e5', '#d32f2f', '#6a1b9a', '#00897b', '#8d6e63', '#c0ca33', '#ef6c00', '#5c6bc0', '#ad1457', '#455a64'];
export function parseClassText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.split(/[,;\t]/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    let code = null, color = null;
    if (/^-?\d+$/.test(parts[0])) code = +parts.shift();
    if (parts.length && /^#[0-9a-f]{6}$/i.test(parts[parts.length - 1])) color = parts.pop();
    const name = parts.join(', ');
    if (!name) continue;
    out.push({ code: code ?? out.length + 1, name, color: color || PALETTE[out.length % PALETTE.length] });
  }
  return out;
}
export const classText = classes => classes.map(c => `${c.code}, ${c.name}, ${c.color}`).join('\n');
