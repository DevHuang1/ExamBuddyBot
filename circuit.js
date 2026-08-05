const GATE_W = 84;
const GATE_H = 44;
const COL_GAP = 150;
const TRACK_GAP = 56;
const MIN_GATE_GAP = 24;
const MIN_Y = 16;
const PIN_STUB = 16;

const INVERTED = new Set(['not', 'nand', 'nor', 'xnor']);
const OUT_EXTRA = { and: 0, or: 0, xor: 0, buffer: 0, not: 10, nand: 10, nor: 10, xnor: 10 };
const BACK = { or: 6, nor: 6, xor: 4, xnor: 4 };

function round(n) {
  return Math.round(n * 10) / 10;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function gateBody(type, x, y) {
  const W = GATE_W;
  const H = GATE_H;
  const cy = y + H / 2;
  switch (type) {
    case 'and':
    case 'nand':
      return `M ${x},${y} L ${x + W / 2},${y} A ${W / 2},${H / 2} 0 0 1 ${x + W / 2},${y + H} L ${x},${y + H} Z`;
    case 'or':
    case 'nor':
      return `M ${x + W},${cy} Q ${x + W - 7},${y} ${x + 14},${y} Q ${x},${cy} ${x + 14},${y + H} Q ${x + W - 7},${y + H} ${x + W},${cy} Z`;
    case 'xor':
    case 'xnor':
      return `M ${x + W},${cy} Q ${x + W - 7},${y} ${x + 22},${y} Q ${x + 14},${cy} ${x + 22},${y + H} Q ${x + W - 7},${y + H} ${x + W},${cy} Z`;
    case 'not':
    case 'buffer':
      return `M ${x},${y} L ${x + W},${cy} L ${x},${y + H} Z`;
    default:
      return `M ${x},${y} L ${x + W},${y} L ${x + W},${y + H} L ${x},${y + H} Z`;
  }
}

function gateExtraCurve(type, x, y) {
  const cy = y + GATE_H / 2;
  if (type === 'xor' || type === 'xnor') return `M ${x + 8},${y} Q ${x},${cy} ${x + 8},${y + GATE_H}`;
  return null;
}

function layout(spec) {
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : [];
  const outputs = Array.isArray(spec.outputs) ? spec.outputs : [];
  const gates = Array.isArray(spec.gates) ? spec.gates : [];
  if (!gates.length) return null;

  const producer = {};
  for (const g of gates) producer[g.output] = g;

  const level = {};
  const visited = new Set();
  function gateLevel(g, depth) {
    if (visited.has(g.id)) return level[g.id] || 1;
    visited.add(g.id);
    if (depth > 24) return (level[g.id] = 1);
    let lv = 1;
    for (const inp of g.inputs || []) {
      const p = producer[inp];
      if (p) lv = Math.max(lv, gateLevel(p, depth + 1) + 1);
    }
    level[g.id] = lv;
    return lv;
  }
  for (const g of gates) gateLevel(g, 0);

  const cols = new Map();
  for (const g of gates) {
    const l = level[g.id] || 1;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(g);
  }
  const maxLevel = cols.size ? Math.max(...cols.keys()) : 0;
  for (const list of cols.values()) list.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const labelW = (s) => Math.max(5, String(s).length) * 8 + 8;
  const inputMaxW = inputs.length ? Math.max(...inputs.map(labelW)) : 0;
  const outputMaxW = outputs.length ? Math.max(...outputs.map(labelW)) : 0;
  const INPUT_X = 10 + inputMaxW + 16;
  const inputLabelX = INPUT_X - 12;

  const gateLeft = (l) => INPUT_X + (l - 1) * (GATE_W + COL_GAP) + PIN_STUB;
  const trunkX = (l) => INPUT_X + (l - 1) * (GATE_W + COL_GAP);

  const trackY = {};
  const inputTracks = [];
  inputs.forEach((s, i) => {
    const y = MIN_Y + 40 + i * TRACK_GAP;
    trackY[s] = y;
    inputTracks.push({ name: s, y });
  });

  const gatePos = {};
  for (let l = 1; l <= maxLevel; l++) {
    const list = cols.get(l) || [];
    const desired = list.map((g) => {
      const ys = (g.inputs || []).map((s) => trackY[s]).filter((y) => typeof y === 'number');
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    });
    const placed = [];
    let prevBottom = -Infinity;
    for (let i = 0; i < list.length; i++) {
      let cy = desired[i];
      if (cy === null) cy = prevBottom === -Infinity ? MIN_Y + 40 + GATE_H / 2 : prevBottom + MIN_GATE_GAP + GATE_H / 2;
      if (prevBottom !== -Infinity) cy = Math.max(cy, prevBottom + MIN_GATE_GAP + GATE_H / 2);
      cy = Math.max(cy, MIN_Y + GATE_H / 2);
      placed.push(cy);
      prevBottom = cy + GATE_H / 2;
    }
    const nonNull = desired.filter((d) => d !== null);
    if (placed.length > 1 && nonNull.length) {
      const avgPlaced = placed.reduce((a, b) => a + b, 0) / placed.length;
      const avgDesired = nonNull.reduce((a, b) => a + b, 0) / nonNull.length;
      let shift = avgDesired - avgPlaced;
      const minTop = Math.min(...placed) - GATE_H / 2;
      if (minTop + shift < MIN_Y) shift = MIN_Y - minTop;
      for (let i = 0; i < placed.length; i++) placed[i] += shift;
    }
    list.forEach((g, i) => {
      const x = gateLeft(l);
      const cy = placed[i];
      gatePos[g.id] = { x, y: cy - GATE_H / 2, cy };
      trackY[g.output] = cy;
    });
  }

  const back = (t) => BACK[t] || 0;
  const inPin = (g, idx, total) => {
    const p = gatePos[g.id];
    const cy = total === 1 ? p.cy : p.y + (GATE_H * (idx + 1)) / (total + 1);
    return { x: p.x + back(g.type), y: cy };
  };
  const outPin = (g) => {
    const p = gatePos[g.id];
    return { x: p.x + GATE_W + (OUT_EXTRA[g.type] || 0), y: p.cy };
  };

  const wireSegs = [];
  const dots = [];
  const pushPath = (x1, y1, x2, y2) => {
    wireSegs.push({ x1, y1, x2, y2 });
  };

  const srcPoint = new Map();
  for (const s of inputs) srcPoint.set(s, { x: INPUT_X, y: trackY[s] });
  for (const g of gates) srcPoint.set(g.output, outPin(g));

  const dests = new Map();
  for (const g of gates) {
    const total = (g.inputs || []).length;
    (g.inputs || []).forEach((sig, idx) => {
      if (!srcPoint.has(sig)) return;
      const p = inPin(g, idx, total);
      const l = level[g.id] || 1;
      if (!dests.has(sig)) dests.set(sig, []);
      dests.get(sig).push({ tx: p.x, ty: p.y, trunk: trunkX(l) });
    });
  }

  for (const [sig, list] of dests) {
    const src = srcPoint.get(sig);
    if (!src) continue;
    const groups = new Map();
    for (const d of list) {
      if (!groups.has(d.trunk)) groups.set(d.trunk, []);
      groups.get(d.trunk).push(d);
    }
    for (const [txT, gl] of groups) {
      const sameY = gl.every((d) => d.ty === src.y);
      if (sameY) {
        for (const d of gl) pushPath(src.x, src.y, d.tx, d.ty);
        continue;
      }
      if (txT !== src.x) pushPath(src.x, src.y, txT, src.y);
      if (gl.length > 1) dots.push({ x: txT, y: src.y });
      for (const d of gl) {
        if (d.ty === src.y) pushPath(txT, src.y, d.tx, d.ty);
        else pushPath(txT, src.y, txT, d.ty);
        if (txT !== d.tx) pushPath(txT, d.ty, d.tx, d.ty);
      }
    }
  }

  let rightmost = 0;
  for (const g of gates) rightmost = Math.max(rightmost, outPin(g).x);
  const outLineX = rightmost + 28;
  const outLabels = [];
  for (const o of outputs) {
    const src = producer[o];
    if (!src) {
      outLabels.push({ name: o, y: MIN_Y + 40 });
      continue;
    }
    const p = outPin(src);
    pushPath(p.x, p.y, outLineX, p.y);
    outLabels.push({ name: o, y: p.y });
  }

  const outByY = new Map();
  for (const l of outLabels) {
    if (!outByY.has(l.y)) outByY.set(l.y, []);
    outByY.get(l.y).push(l.name);
  }
  const finalOutLabels = [];
  for (const [y, names] of outByY) {
    names.forEach((name, i) => {
      finalOutLabels.push({ name, y: y + (i - (names.length - 1) / 2) * 17 });
    });
  }

  const width = outLineX + 14 + outputMaxW;
  let maxBottom = MIN_Y + 40 + Math.max(0, inputs.length - 1) * TRACK_GAP + 10;
  for (const g of gates) maxBottom = Math.max(maxBottom, gatePos[g.id].y + GATE_H);
  const height = maxBottom + 22;

  return {
    inputs, outputs, gates, inputTracks, outLabels: finalOutLabels,
    inputLabelX, outLineX, width, height,
    gateBody: (g) => gateBody(g.type, gatePos[g.id].x, gatePos[g.id].y),
    gateCurve: (g) => gateExtraCurve(g.type, gatePos[g.id].x, gatePos[g.id].y),
    gateX: (g) => gatePos[g.id].x,
    gateY: (g) => gatePos[g.id].y,
    gateType: (g) => g.type,
    isInverted: (g) => INVERTED.has(g.type),
    bubbleX: (g) => gatePos[g.id].x + GATE_W + 5,
    bubbleY: (g) => gatePos[g.id].cy,
    wires: wireSegs,
    dots,
    gateRects: gates.map((g) => {
      const p = gatePos[g.id];
      return { id: g.id, x: p.x, y: p.y, w: GATE_W, h: GATE_H };
    }),
  };
}

function renderCircuit(spec) {
  const L = layout(spec);
  if (!L) return null;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  parts.push(`<g fill="none" stroke="#3b4252" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${L.wires.map((w) => `M ${round(w.x1)},${round(w.y1)} L ${round(w.x2)},${round(w.y2)}`).join('')}</g>`);
  if (L.dots && L.dots.length) {
    parts.push(`<g fill="#3b4252">${L.dots.map((d) => `<circle cx="${round(d.x)}" cy="${round(d.y)}" r="2.8"/>`).join('')}</g>`);
  }
  parts.push('<g fill="#fffdf6" stroke="#1f2430" stroke-width="1.8" stroke-linejoin="round">');
  for (const g of L.gates) {
    parts.push(`<path d="${L.gateBody(g)}"/>`);
    const curve = L.gateCurve(g);
    if (curve) parts.push(`<path d="${curve}" fill="none" stroke="#1f2430" stroke-width="1.8"/>`);
    if (L.isInverted(g)) parts.push(`<circle cx="${round(L.bubbleX(g))}" cy="${round(L.bubbleY(g))}" r="4.4" fill="#fffdf6"/>`);
  }
  parts.push('</g>');
  parts.push('<g font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="600">');
  for (const t of L.inputTracks) parts.push(`<text x="${round(L.inputLabelX)}" y="${round(t.y + 5)}" text-anchor="end" fill="#1d4ed8">${esc(t.name)}</text>`);
  for (const l of L.outLabels) parts.push(`<text x="${round(L.outLineX + 14)}" y="${round(l.y + 5)}" text-anchor="start" fill="#15803d">${esc(l.name)}</text>`);
  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('');
}

module.exports = { renderCircuit, layout };
