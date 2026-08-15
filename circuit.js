const { instance: vizInstance } = require('@viz-js/viz');

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
const MULTIPLEXERS = new Set(['mux2', 'mux4']);
const FLIP_FLOPS = new Set(['dff', 'jkff', 'tff', 'srff']);
const CLOCKED_COMPONENTS = new Set([...FLIP_FLOPS, 'reg']);

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
    case 'mux2':
    case 'mux4':
      return `M ${x + 8},${y} L ${x + W - 8},${y + 7} L ${x + W - 8},${y + H - 7} L ${x + 8},${y + H} Z`;
    case 'dff':
    case 'jkff':
    case 'tff':
    case 'srff':
    case 'dec2_4':
    case 'dec3_8':
    case 'enc4_2':
    case 'enc8_3':
    case 'reg':
      return `M ${x},${y} L ${x + W},${y} L ${x + W},${y + H} L ${x},${y + H} Z`;
    default:
      return `M ${x},${y} L ${x + W},${y} L ${x + W},${y + H} L ${x},${y + H} Z`;
  }
}

function gateExtraCurve(type, x, y) {
  const cy = y + GATE_H / 2;
  if (type === 'xor' || type === 'xnor') return `M ${x + 8},${y} Q ${x},${cy} ${x + 8},${y + GATE_H}`;
  return null;
}

function componentLabel(type, bits) {
  if (type === 'reg') return `REG ${bits || '?'}-bit`;
  return {
    mux2: 'MUX 2:1',
    mux4: 'MUX 4:1',
    dff: 'D FF',
    jkff: 'JK FF',
    tff: 'T FF',
    srff: 'SR FF',
    dec2_4: 'DEC 2:4',
    dec3_8: 'DEC 3:8',
    enc4_2: 'ENC 4:2',
    enc8_3: 'ENC 8:3',
  }[type] || '';
}

function componentClockMark(type, x, y, w = GATE_W, h = GATE_H) {
  if (!CLOCKED_COMPONENTS.has(type)) return '';
  const cx = x;
  const cy = y + h * 0.75;
  return `M ${cx},${cy - 5} L ${cx + 8},${cy} L ${cx},${cy + 5}`;
}

function componentInPin(type, x, y, w, h, idx, total) {
  const standardY = total === 1 ? y + h / 2 : y + (h * (idx + 1)) / (total + 1);
  if (type === 'mux2' && idx === 2) return { x: x + w * 0.52, y: y + h };
  if (type === 'mux4' && idx >= 4) return { x: x + w * (idx === 4 ? 0.38 : 0.66), y: y + h };
  if (CLOCKED_COMPONENTS.has(type) && idx === total - 1) return { x, y: y + h * 0.75 };
  return { x: x + (MULTIPLEXERS.has(type) ? 8 : BACK[type] || 0), y: standardY };
}

function componentOverlay(component, x, y, w = GATE_W, h = GATE_H) {
  const type = typeof component === 'string' ? component : component.type;
  const bits = typeof component === 'string' ? undefined : component.bits;
  const label = componentLabel(type, bits);
  const clock = componentClockMark(type, x, y, w, h);
  const parts = [];
  if (label) parts.push(`<text x="${round(x + w / 2)}" y="${round(y + h / 2 + 5)}" text-anchor="middle" fill="#1f2937">${esc(label)}</text>`);
  if (clock) parts.push(`<path d="${clock}" fill="none" stroke="#1f2430" stroke-width="1.6"/>`);
  return parts.join('');
}

function layout(spec) {
  return layoutV2(spec);
}

/* ---------------------------------------------------------------------------
 * Fallback layout: manual column/track placement with orthogonal wiring.
 * Used when the Graphviz renderer fails for any reason.
 * ------------------------------------------------------------------------- */

function layoutV2(spec) {
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
    return componentInPin(g.type, p.x, p.y, GATE_W, GATE_H, idx, total);
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

function renderV2(spec) {
  const L = layoutV2(spec);
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
  parts.push('<g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="12" font-weight="700">');
  for (const g of L.gates) parts.push(componentOverlay(g, L.gateX(g), L.gateY(g)));
  parts.push('</g>');
  parts.push('<g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="15" font-weight="600">');
  for (const t of L.inputTracks) parts.push(`<text x="${round(L.inputLabelX)}" y="${round(t.y + 5)}" text-anchor="end" fill="#1d4ed8">${esc(t.name)}</text>`);
  for (const l of L.outLabels) parts.push(`<text x="${round(L.outLineX + 14)}" y="${round(l.y + 5)}" text-anchor="start" fill="#15803d">${esc(l.name)}</text>`);
  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('');
}

/* ---------------------------------------------------------------------------
 * Graphviz layout: layer placement + cubic-bezier wire routing via @viz-js/viz.
 * ------------------------------------------------------------------------- */

let _vizPromise = null;
function getViz() {
  if (!_vizPromise) _vizPromise = vizInstance();
  return _vizPromise;
}

function pinPort(i, n) {
  if (n === 1) return 'w';
  if (n === 2) return ['nw', 'sw'][i];
  if (n === 3) return ['nw', 'w', 'sw'][i];
  return ['nw', 'w', 'sw', 'w'][i % 4];
}

function buildDotGraph(spec, opts) {
  opts = opts || {};
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : [];
  const outputs = Array.isArray(spec.outputs) ? spec.outputs : [];
  const gates = Array.isArray(spec.gates) ? spec.gates : [];
  if (!gates.length) return null;

  const producer = {};
  for (const g of gates) producer[g.output] = g;

  const signals = [];
  const seen = new Set();
  const addSig = (s) => {
    if (!seen.has(String(s))) { seen.add(String(s)); signals.push(s); }
  };
  for (const s of inputs) addSig(s);
  for (const o of outputs) addSig(o);
  for (const g of gates) {
    for (const s of g.inputs || []) addSig(s);
    addSig(g.output);
  }

  const sigToken = new Map();
  const gateToken = new Map();
  const juncToken = new Map();
  signals.forEach((s, i) => sigToken.set(String(s), `s${i}`));
  gates.forEach((g, i) => gateToken.set(g.id, `gt${i}`));

  const sinks = new Map();
  for (const g of gates) {
    for (const s of g.inputs || []) {
      const key = String(s);
      if (!sinks.has(key)) sinks.set(key, []);
      sinks.get(key).push(g);
    }
  }
  for (const [s, list] of sinks) {
    if (!opts.noJunctions && list.length > 1 && (inputs.includes(s) || producer[s])) juncToken.set(String(s), `j${juncToken.size}`);
  }

  // Balanced stage column: max(longest path from inputs, longest path to outputs).
  const fwd = {};
  const rev = {};
  const fwdMemo = new Map();
  const revMemo = new Map();
  function forward(g, depth) {
    if (fwdMemo.has(g.id)) return fwdMemo.get(g.id);
    if (depth > 24) return (fwdMemo.set(g.id, 1), 1);
    let lv = 1;
    for (const s of g.inputs || []) {
      const p = producer[s];
      if (p) lv = Math.max(lv, forward(p, depth + 1) + 1);
    }
    fwdMemo.set(g.id, lv);
    return lv;
  }
  function backward(g, depth) {
    if (revMemo.has(g.id)) return revMemo.get(g.id);
    if (depth > 24) return (revMemo.set(g.id, 1), 1);
    let lv = outputs.includes(g.output) ? 1 : 0;
    for (const h of gates) {
      if ((h.inputs || []).includes(g.output)) lv = Math.max(lv, backward(h, depth + 1) + 1);
    }
    if (!lv) lv = 1;
    revMemo.set(g.id, lv);
    return lv;
  }
  for (const g of gates) { fwd[g.id] = forward(g, 0); }
  const maxFwd = Math.max(1, ...Object.values(fwd));
  for (const g of gates) { rev[g.id] = Math.max(backward(g, 0), 1); }
  const col = {};
  for (const g of gates) col[g.id] = Math.max(fwd[g.id], maxFwd - rev[g.id] + 1);
  const colGroups = new Map();
  for (const g of gates) {
    if (!colGroups.has(col[g.id])) colGroups.set(col[g.id], []);
    colGroups.get(col[g.id]).push(g);
  }

  const gateNodeOf = (g) => gateToken.get(g.id);
  const sigNodeOf = (s) => (inputs.includes(s) ? sigToken.get(String(s)) : gateToken.get(producer[s].id));

  const lines = [];
  lines.push('digraph G {');
  lines.push(`  graph [splines=${opts.splines || 'spline'}, splineorder=true, rankdir=LR, nodesep=0.35, ranksep=0.8, pad=0.3];`);
  lines.push(`  node [shape=box, style=solid, fixedsize=true, width=${(GATE_W / 72).toFixed(5)}, height=${(GATE_H / 72).toFixed(5)}, label=""];`);
  for (const g of gates) lines.push(`  ${gateNodeOf(g)};`);
  for (const list of colGroups.values()) {
    if (list.length > 1) lines.push(`  { rank=same; ${list.map((g) => gateNodeOf(g)).join('; ')} }`);
  }
  for (const s of inputs) lines.push(`  ${sigToken.get(String(s))} [shape=point, width=0.03, height=0.03, label=""];`);
  for (const o of outputs) lines.push(`  out${sigToken.get(String(o))} [shape=point, width=0.03, height=0.03, label=""];`);
  for (const t of juncToken.values()) lines.push(`  ${t} [shape=point, width=0.05, height=0.05, label=""];`);

  const edgeMeta = [];
  const emit = (tail, head, attrs, meta) => {
    lines.push(`  ${tail} -> ${head}${attrs ? ` [${attrs}]` : ''};`);
    edgeMeta.push(meta);
  };

  for (const g of gates) {
    const n = (g.inputs || []).length;
    (g.inputs || []).forEach((s, i) => {
      const key = String(s);
      if (!inputs.includes(s) && !producer[s]) return;
      const jt = juncToken.get(key);
      if (jt) {
        const fromNode = sigNodeOf(s);
        const meta = { from: fromNode, to: jt, kind: 'trunk', gateId: g.id, pin: i, pins: n };
        emit(fromNode, jt, 'tailport=e', meta);
        emit(jt, gateNodeOf(g), `headport=${pinPort(i, n)}`, { from: jt, to: gateNodeOf(g), kind: 'gatein', gateId: g.id, pin: i, pins: n });
      } else {
        emit(sigNodeOf(s), gateNodeOf(g), `headport=${pinPort(i, n)}`, { from: sigNodeOf(s), to: gateNodeOf(g), kind: 'gatein', gateId: g.id, pin: i, pins: n });
      }
    });
  }
  for (const o of outputs) {
    const p = producer[o];
    if (!p) continue;
    const outTok = `out${sigToken.get(String(o))}`;
    emit(gateNodeOf(p), outTok, 'tailport=e', { from: gateNodeOf(p), to: outTok, kind: 'out', out: o });
  }
  lines.push('}');

  return { dot: lines.join('\n'), edgeMeta, signals, sigToken, gateToken, juncToken };
}

function parseGraphLayout(spec, json, built) {
  const bb = json.bb.split(',').map(parseFloat);
  const H = bb[3];
  const nodes = new Map();
  for (const o of json.objects) nodes.set(o.name, o);
  const pos = (o) => {
    const [x, y] = o.pos.split(',').map(parseFloat);
    return { x, y, sy: H - y };
  };
  const gateById = new Map();
  for (const g of spec.gates || []) {
    const o = nodes.get(built.gateToken.get(g.id));
    if (!o) return null;
    const p = pos(o);
    const w = parseFloat(o.width) * 72;
    const h = parseFloat(o.height) * 72;
    gateById.set(g.id, { g, left: p.x - w / 2, top: p.sy - h / 2, cx: p.x, cy: p.sy, w, h });
  }
  const inputs = new Map();
  for (const s of spec.inputs || []) {
    const o = nodes.get(built.sigToken.get(String(s)));
    if (!o) continue;
    const p = pos(o);
    inputs.set(String(s), { x: p.x, y: p.sy });
  }
  const outputs = new Map();
  for (const o of spec.outputs || []) {
    const o2 = nodes.get(`out${built.sigToken.get(String(o))}`);
    if (!o2) continue;
    const p = pos(o2);
    outputs.set(String(o), { x: p.x, y: p.sy });
  }
  const junctions = new Map();
  for (const [s, t] of built.juncToken) {
    const o = nodes.get(t);
    if (!o) continue;
    const p = pos(o);
    junctions.set(String(s), { x: p.x, y: p.sy });
  }
  return { bb, H, gateById, inputs, outputs, junctions };
}

function splineSegments(posStr, flipY) {
  // JSON edge pos: whitespace-separated splines; each a comma list of points in
  // points (bottom-left origin). The first point equals the head endpoint (dup of last).
  // flipY(y) maps graphviz y -> SVG y.
  const out = [];
  for (const g of String(posStr).trim().split(/\s+/)) {
    if (!g) continue;
    const toks = g.split(',');
    const pts = [];
    for (let i = 0; i + 1 < toks.length; i += 2) {
      const x = parseFloat(toks[i].replace(/^[es],/, ''));
      const y = parseFloat(toks[i + 1]);
      if (!isNaN(x) && !isNaN(y)) pts.push([x, flipY(y)]);
    }
    if (!pts.length) continue;
    const body = pts.slice(1);
    for (let k = 0; k + 3 < body.length; k += 3) {
      out.push([body[k], body[k + 1], body[k + 2], body[k + 3]]);
    }
  }
  return out;
}

function gatePin(gm, g, idx) {
  const n = (g.inputs || []).length;
  return componentInPin(g.type, gm.left, gm.top, gm.w, gm.h, idx, n);
}

function producerOf(spec, signal) {
  return (spec.gates || []).find((g) => g.output === signal) || null;
}

function renderGraphSvg(spec, L, built) {
  const flip = (y) => L.H - y;
  const paths = [];
  const wires = [];

  // Match JSON edges to our declared edge metadata by (tail, head) occurrence.
  const metaIndex = new Map();
  for (let i = 0; i < built.edgeMeta.length; i++) {
    const m = built.edgeMeta[i];
    const key = `${m.from}\u0000${m.to}`;
    if (!metaIndex.has(key)) metaIndex.set(key, []);
    metaIndex.get(key).push(m);
  }

  const seen = new Map();
  for (const e of L.jsonEdges) {
    const key = `${e.tail}\u0000${e.head}`;
    const pool = metaIndex.get(key) || [];
    const pos = seen.get(key) || 0;
    seen.set(key, pos + 1);
    const meta = pool[pos];

    const segs = splineSegments(e.pos, flip);
    if (!segs.length) continue;
    if (meta) {
      if (meta.kind === 'gatein') {
        const gm = L.gateById.get(meta.gateId);
        if (gm) {
          const p = gatePin(gm, gm.g, meta.pin);
          const last = segs[segs.length - 1];
          last[3] = [p.x, p.y];
        }
      } else if (meta.kind === 'out') {
        const prod = producerOf(spec, meta.out);
        const gm = prod ? L.gateById.get(prod.id) : null;
        if (gm) {
          const first = segs[0];
          first[0] = [gm.left + gm.w, gm.top + gm.h / 2];
        }
      }
    }
    for (let i = 0; i < segs.length; i++) {
      const [s, c1, c2, en] = segs[i];
      const boundary = segs.length === 1 ? 'both' : i === 0 ? 'start' : i === segs.length - 1 ? 'end' : 'mid';
      paths.push(`M ${round(s[0])},${round(s[1])} C ${round(c1[0])},${round(c1[1])} ${round(c2[0])},${round(c2[1])} ${round(en[0])},${round(en[1])}`);
      wires.push({ s, c1, c2, en, boundary });
    }
  }

  const width = L.bb[2] + 40;
  const height = L.bb[3] + 20;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}">`;
  svg += '<rect width="100%" height="100%" fill="#ffffff"/>';
  svg += `<g fill="none" stroke="#3b4252" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g>`;
  const dots = [...L.junctions.values()];
  svg += `<g fill="#3b4252">${dots.map((d) => `<circle cx="${round(d.x)}" cy="${round(d.y)}" r="3"/>`).join('')}</g>`;
  svg += '<g fill="#fffdf6" stroke="#1f2430" stroke-width="1.9" stroke-linejoin="round">';
  for (const m of L.gateById.values()) {
    const g = m.g;
    svg += `<path d="${gateBody(g.type, m.left, m.top)}"/>`;
    const curve = gateExtraCurve(g.type, m.left, m.top);
    if (curve) svg += `<path d="${curve}" fill="none" stroke="#1f2430" stroke-width="1.9"/>`;
    if (INVERTED.has(g.type)) {
      svg += `<circle cx="${round(m.left + m.w)}" cy="${round(m.top + m.h / 2)}" r="4.6" fill="#fffdf6"/>`;
    }
  }
  svg += '</g>';
  svg += '<g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="12" font-weight="700">';
  for (const m of L.gateById.values()) svg += componentOverlay(m.g, m.left, m.top, m.w, m.h);
  svg += '</g>';
  svg += '<g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="15" font-weight="600">';
  for (const [s, p] of L.inputs) svg += `<text x="${round(p.x - 8)}" y="${round(p.y + 5)}" text-anchor="end" fill="#1d4ed8">${esc(s)}</text>`;
  for (const [o, p] of L.outputs) svg += `<text x="${round(p.x + 8)}" y="${round(p.y + 5)}" text-anchor="start" fill="#15803d">${esc(o)}</text>`;
  svg += '</g>';
  svg += '</svg>';
  return { svg, wires, width, height };
}

async function renderGraphviz(spec) {
  const built = buildDotGraph(spec);
  if (!built) return null;
  const viz = await getViz();
  const json = JSON.parse(viz.renderString(built.dot, { format: 'json' }));
  const L = parseGraphLayout(spec, json, built);
  if (!L) return null;
  L.jsonEdges = json.edges;
  const out = renderGraphSvg(spec, L, built);
  const issues = checkGeometry(spec, L, out.wires);
  if (issues.length) console.error('Circuit geometry issues:', issues.slice(0, 8));
  return out.svg;
}

/* ---------------------------------------------------------------------------
 * Manhattan (orthogonal) router.
 *
 * Gate placement comes from Graphviz (balanced rank columns). Wiring is done
 * here with right-angle runs only:
 *   - each signal runs horizontally from its source to the vertical trunk
 *     lane left of the destination column, then into each input pin;
 *   - a "shelf" run is used when the natural horizontal run at the source's
 *     height would pass through a gate body;
 *   - junction dots are derived from the wire graph (points with 3+ ends).
 * ------------------------------------------------------------------------- */

const TRUNK_OFF = 16;

function manhattanOutPin(m) {
  return { x: m.left + m.w + (OUT_EXTRA[m.g.type] || 0), y: m.top + m.h / 2 };
}

function manhattanInPin(m, idx) {
  const n = (m.g.inputs || []).length;
  return componentInPin(m.g.type, m.left, m.top, m.w, m.h, idx, n);
}

function routeManhattan(spec, L) {
  const wires = [];
  const seg = (x1, y1, x2, y2, destGate) => {
    if (x1 === x2 && y1 === y2) return;
    wires.push({ x1, y1, x2, y2, destGate: destGate || null });
  };

  const gates = [...L.gateById.values()];

  const colOf = new Map();
  const colLeft = new Map();
  const byLeft = new Map();
  for (const m of gates) {
    const k = Math.round(m.left);
    if (!byLeft.has(k)) { byLeft.set(k, byLeft.size); colLeft.set(byLeft.size - 1, m.left); }
    colOf.set(m.g.id, byLeft.get(k));
  }
  for (const m of gates) {
    const c = colOf.get(m.g.id);
    colLeft.set(c, Math.min(colLeft.get(c), m.left));
  }

  const srcPoint = new Map();
  let inputX = Infinity;
  for (const p of L.inputs.values()) inputX = Math.min(inputX, p.x);
  const minGateLeft = Math.min(...gates.map((g) => g.left));
  inputX = Math.max(Math.min(inputX, minGateLeft - 44), 8);
  for (const p of L.inputs.values()) p.x = inputX;
  for (const [s, p] of L.inputs) srcPoint.set(String(s), { x: p.x, y: p.y });
  for (const m of gates) srcPoint.set(m.g.output, manhattanOutPin(m));

  const dests = new Map();
  for (const m of gates) {
    const n = (m.g.inputs || []).length;
    (m.g.inputs || []).forEach((sig, i) => {
      const key = String(sig);
      if (!srcPoint.has(key)) return;
      const p = manhattanInPin(m, i);
      const tx = colLeft.get(colOf.get(m.g.id)) - TRUNK_OFF;
      if (!dests.has(key)) dests.set(key, []);
      dests.get(key).push({ tx, dx: p.x, dy: p.y, gateId: m.g.id });
    });
  }

  let rightmost = 0;
  for (const m of gates) rightmost = Math.max(rightmost, manhattanOutPin(m).x);
  const outLineX = rightmost + 28;
  const outLabelY = new Map();
  for (const o of spec.outputs || []) {
    const prod = producerOf(spec, o);
    if (!prod) continue;
    const src = srcPoint.get(prod.output);
    if (!src) continue;
    outLabelY.set(String(o), src.y);
    if (!dests.has(String(o))) dests.set(String(o), []);
    dests.get(String(o)).push({ tx: outLineX, dx: outLineX, dy: src.y, gateId: null });
  }

  for (const [sig, list] of dests) {
    const src = srcPoint.get(sig);
    if (!src) continue;

    const xs = [src.x, ...list.map((d) => d.tx)];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    let H = src.y;
    const CLEAR = 5;
    const inRange = gates.filter((g) => g.left < maxX && g.left + g.w > minX);
    if (inRange.some((g) => src.y >= g.top - CLEAR && src.y <= g.top + g.h + CLEAR)) {
      const topMin = Math.min(...inRange.map((g) => g.top));
      const botMax = Math.max(...inRange.map((g) => g.top + g.h));
      const above = topMin - (CLEAR + 11);
      const below = botMax + (CLEAR + 11);
      H = Math.abs(above - src.y) <= Math.abs(below - src.y) ? above : below;
    }

    if (H !== src.y) seg(src.x, src.y, src.x, H, null);

    const sortedXs = [...new Set(xs)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sortedXs.length; i++) seg(sortedXs[i], H, sortedXs[i + 1], H, null);

    const groups = new Map();
    for (const d of list) {
      if (!groups.has(d.tx)) groups.set(d.tx, []);
      groups.get(d.tx).push(d);
    }
    for (const [tx, gl] of groups) {
      const ys = [H, ...gl.map((d) => d.dy)];
      const sortedYs = [...new Set(ys)].sort((a, b) => a - b);
      for (let i = 0; i + 1 < sortedYs.length; i++) seg(tx, sortedYs[i], tx, sortedYs[i + 1], null);
      for (const d of gl) seg(tx, d.dy, d.dx, d.dy, d.gateId);
    }
  }

  const pins = new Set();
  for (const m of gates) {
    const n = (m.g.inputs || []).length;
    pins.add(`${round(manhattanOutPin(m).x)},${round(manhattanOutPin(m).y)}`);
    for (let i = 0; i < n; i++) {
      const p = manhattanInPin(m, i);
      pins.add(`${round(p.x)},${round(p.y)}`);
    }
  }
  const count = new Map();
  for (const w of wires) {
    const a = `${round(w.x1)},${round(w.y1)}`;
    const b = `${round(w.x2)},${round(w.y2)}`;
    count.set(a, (count.get(a) || 0) + 1);
    count.set(b, (count.get(b) || 0) + 1);
  }
  const dots = [];
  for (const [k, n] of count) {
    if (n >= 3 && !pins.has(k)) {
      const [x, y] = k.split(',').map(parseFloat);
      dots.push({ x, y });
    }
  }

  return { wires, dots, outLineX, outLabelY };
}

/* ---------------------------------------------------------------------------
 * Geometry checks: wires must never cross gate bodies; labels must not overlap
 * gates; junction dots must sit in empty space.
 * ------------------------------------------------------------------------- */

function bezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

function checkGeometry(spec, L, wires) {
  const issues = [];
  const gateRects = [];
  for (const [id, m] of L.gateById) {
    gateRects.push({ id, x: m.left, y: m.top, w: m.w, h: m.h, top: m.top, bottom: m.top + m.h, left: m.left, right: m.left + m.w });
  }
  const inRect = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  for (const w of wires) {
    const t0 = w.boundary === 'end' || w.boundary === 'both' ? 0.18 : 0.04;
    const t1 = w.boundary === 'start' || w.boundary === 'both' ? 0.82 : 0.96;
    for (let t = t0; t <= t1; t += 0.04) {
      const [x, y] = bezierPoint(w.s, w.c1, w.c2, w.en, t);
      for (const r of gateRects) {
        if (inRect(x, y, r)) {
          issues.push(`wire through gate ${r.id}`);
          return issues;
        }
      }
    }
  }

  const labels = [];
  const labelH = 15;
  for (const [s, p] of L.inputs) {
    const w = String(s).length * 8 + 4;
    labels.push({ text: s, left: p.x - 8 - w, right: p.x - 8, top: p.y - labelH, bottom: p.y });
  }
  for (const [o, p] of L.outputs) {
    const w = String(o).length * 8 + 4;
    labels.push({ text: o, left: p.x + 8, right: p.x + 8 + w, top: p.y - labelH, bottom: p.y });
  }
  for (const lb of labels) {
    for (const r of gateRects) {
      if (lb.right < r.left || lb.left > r.right) continue;
      if (lb.bottom < r.top || lb.top > r.bottom) continue;
      issues.push(`label "${lb.text}" overlaps gate ${r.id}`);
    }
  }

  for (const [s, d] of L.junctions) {
    for (const r of gateRects) {
      if (inRect(d.x, d.y, r)) issues.push(`junction dot for "${s}" inside gate ${r.id}`);
    }
  }
  return issues;
}

/* ---------------------------------------------------------------------------
 * Segment-based geometry check for the Manhattan router.
 * ------------------------------------------------------------------------- */

function checkSegments(spec, L, wires, dots) {
  const issues = [];
  const rects = [];
  for (const m of L.gateById.values()) {
    rects.push({ id: m.g.id, top: m.top, bottom: m.top + m.h, left: m.left, right: m.left + m.w });
  }
  for (const w of wires) {
    for (const r of rects) {
      if (w.destGate === r.id) continue;
      if (w.y1 === w.y2) {
        if (w.y1 > r.top && w.y1 < r.bottom && Math.min(w.x1, w.x2) < r.right && Math.max(w.x1, w.x2) > r.left) {
          issues.push(`wire through gate ${r.id}`);
          return issues;
        }
      } else if (w.x1 === w.x2) {
        if (w.x1 > r.left && w.x1 < r.right && Math.min(w.y1, w.y2) < r.bottom && Math.max(w.y1, w.y2) > r.top) {
          issues.push(`wire through gate ${r.id}`);
          return issues;
        }
      }
    }
  }
  for (const d of dots || []) {
    for (const r of rects) {
      if (d.x > r.left && d.x < r.right && d.y > r.top && d.y < r.bottom) {
        issues.push(`junction dot inside gate ${r.id}`);
        return issues;
      }
    }
  }
  return issues;
}

function manhattanSvg(spec, L, R) {
  const outLabels = [];
  const outByY = new Map();
  for (const o of spec.outputs || []) {
    const y = R.outLabelY.get(String(o));
    if (y === undefined) continue;
    if (!outByY.has(y)) outByY.set(y, []);
    outByY.get(y).push(o);
  }
  for (const [y, names] of outByY) {
    names.forEach((name, i) => {
      outLabels.push({ name, y: y + (i - (names.length - 1) / 2) * 17 });
    });
  }

  const labelW = (s) => Math.max(5, String(s).length) * 8 + 8;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const m of L.gateById.values()) {
    grow(m.left, m.top);
    grow(m.left + m.w, m.top + m.h);
  }
  for (const w of R.wires) {
    grow(w.x1, w.y1);
    grow(w.x2, w.y2);
  }
  for (const d of R.dots) grow(d.x, d.y);
  for (const [s, p] of L.inputs) {
    const w = labelW(s);
    grow(p.x - 8 - w, p.y);
    grow(p.x - 8, p.y + 15);
  }
  for (const l of outLabels) {
    const w = labelW(l.name);
    grow(R.outLineX + 14, l.y);
    grow(R.outLineX + 14 + w, l.y + 15);
  }
  const pad = 12;
  minX = Math.floor(minX) - pad;
  minY = Math.floor(minY) - pad;
  maxX = Math.ceil(maxX) + pad;
  maxY = Math.ceil(maxY) + pad;
  const width = maxX - minX;
  const height = maxY - minY;
  const tx = -minX;
  const ty = -minY;
  const P = (x, y) => `${round(x + tx)},${round(y + ty)}`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += '<rect width="100%" height="100%" fill="#ffffff"/>';
  svg += `<g fill="none" stroke="#3b4252" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter">`;
  for (const w of R.wires) svg += `M ${P(w.x1, w.y1)} L ${P(w.x2, w.y2)}`;
  svg += '</g>';
  if (R.dots.length) svg += `<g fill="#3b4252">${R.dots.map((d) => `<circle cx="${round(d.x + tx)}" cy="${round(d.y + ty)}" r="3"/>`).join('')}</g>`;
  svg += '<g fill="#fffdf6" stroke="#1f2430" stroke-width="1.9" stroke-linejoin="round">';
  for (const m of L.gateById.values()) {
    const g = m.g;
    svg += `<path d="${gateBody(g.type, m.left + tx, m.top + ty)}"/>`;
    const curve = gateExtraCurve(g.type, m.left + tx, m.top + ty);
    if (curve) svg += `<path d="${curve}" fill="none" stroke="#1f2430" stroke-width="1.9"/>`;
    if (INVERTED.has(g.type)) {
      svg += `<circle cx="${round(m.left + m.w + tx)}" cy="${round(m.top + m.h / 2 + ty)}" r="4.6" fill="#fffdf6"/>`;
    }
  }
  svg += '</g>';
  svg += '<g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="12" font-weight="700">';
  for (const m of L.gateById.values()) svg += componentOverlay(m.g, m.left + tx, m.top + ty, m.w, m.h);
  svg += '</g>';
  svg += '<g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="15" font-weight="600">';
  for (const [s, p] of L.inputs) svg += `<text x="${round(p.x + tx - 8)}" y="${round(p.y + ty + 5)}" text-anchor="end" fill="#1d4ed8">${esc(s)}</text>`;
  for (const l of outLabels) svg += `<text x="${round(R.outLineX + tx + 14)}" y="${round(l.y + ty + 5)}" text-anchor="start" fill="#15803d">${esc(l.name)}</text>`;
  svg += '</g>';
  svg += '</svg>';
  return svg;
}

async function renderManhattan(spec) {
  const built = buildDotGraph(spec, { noJunctions: true, splines: 'none' });
  if (!built) return null;
  const viz = await getViz();
  const json = JSON.parse(viz.renderString(built.dot, { format: 'json' }));
  const L = parseGraphLayout(spec, json, built);
  if (!L) return null;
  const R = routeManhattan(spec, L);
  const issues = checkSegments(spec, L, R.wires, R.dots);
  if (issues.length) {
    console.error('Manhattan geometry issues:', issues.slice(0, 8));
    return null;
  }
  return manhattanSvg(spec, L, R);
}

async function renderCircuit(spec) {
  try {
    const svg = await renderManhattan(spec);
    if (svg) return svg;
  } catch (err) {
    console.error('Manhattan render failed, falling back:', err.message);
  }
  return renderV2(spec);
}

module.exports = { renderCircuit, layout, layoutV2, renderV2, renderGraphviz, buildDotGraph, parseGraphLayout, routeManhattan, renderManhattan, checkSegments };
