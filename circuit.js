const GATE_W = 80;
const GATE_H = 44;
const COL_GAP = 110;
const ROW_GAP = 50;
const X0 = 40;
const Y0 = 30;
const IN_W = 70;

const OUT_EXTRA = { and: 0, or: 0, xor: 0, buffer: 0, not: 10, nand: 10, nor: 10, xnor: 10 };
const INVERTED = new Set(['not', 'nand', 'nor', 'xnor']);

function gateParts(type, gx, gy) {
  const W = GATE_W;
  const H = GATE_H;
  const cy = gy + H / 2;
  switch (type) {
    case 'and':
    case 'nand':
      return { fill: `M ${gx},${gy} L ${gx + W / 2},${gy} A ${H / 2},${H / 2} 0 0 1 ${gx + W / 2},${gy + H} L ${gx},${gy + H} Z`, lines: [] };
    case 'or':
    case 'nor':
      return { fill: `M ${gx + W},${cy} Q ${gx + W - 8},${gy} ${gx + 8},${gy} Q ${gx},${cy} ${gx + 8},${gy + H} Q ${gx + W - 8},${gy + H} ${gx + W},${cy} Z`, lines: [] };
    case 'xor':
    case 'xnor':
      return {
        fill: `M ${gx + W},${cy} Q ${gx + W - 8},${gy} ${gx + 14},${gy} Q ${gx + 6},${cy} ${gx + 14},${gy + H} Q ${gx + W - 8},${gy + H} ${gx + W},${cy} Z`,
        lines: [`M ${gx + 6},${gy} Q ${gx - 2},${cy} ${gx + 6},${gy + H}`],
      };
    case 'not':
    case 'buffer':
      return { fill: `M ${gx},${gy} L ${gx + W},${cy} L ${gx},${gy + H} Z`, lines: [] };
    default:
      return { fill: `M ${gx},${gy} L ${gx + W},${gy} L ${gx + W},${gy + H} L ${gx},${gy + H} Z`, lines: [] };
  }
}

function wirePath(ax, ay, bx, by) {
  if (ay === by) return `M ${ax},${ay} L ${bx},${by}`;
  const midx = (ax + bx) / 2;
  return `M ${ax},${ay} L ${midx},${ay} L ${midx},${by} L ${bx},${by}`;
}

function renderCircuit(spec) {
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : [];
  const outputs = Array.isArray(spec.outputs) ? spec.outputs : [];
  const gates = Array.isArray(spec.gates) ? spec.gates : [];

  const producer = {};
  for (const g of gates) producer[g.output] = g;

  const level = {};
  function gateLevel(g) {
    if (level[g.id] !== undefined) return level[g.id];
    let lv = 1;
    for (const inp of g.inputs || []) {
      const p = producer[inp];
      if (p) lv = Math.max(lv, gateLevel(p) + 1);
    }
    level[g.id] = lv;
    return lv;
  }
  for (const g of gates) gateLevel(g);

  const cols = new Map();
  for (const g of gates) {
    const l = level[g.id] || 1;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(g);
  }
  const maxLevel = cols.size ? Math.max(...cols.keys()) : 0;

  const gatePos = {};
  let maxRows = 1;
  for (const [l, list] of cols) {
    list.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
    maxRows = Math.max(maxRows, list.length);
    list.forEach((g, r) => {
      gatePos[g.id] = { x: X0 + IN_W + (l - 1) * (GATE_W + COL_GAP), y: Y0 + r * (GATE_H + ROW_GAP) };
    });
  }

  const pin = (gate, idx, total) => {
    const p = gatePos[gate.id];
    const t = gate.type;
    const back = t === 'or' || t === 'nor' || t === 'xor' || t === 'xnor' ? 2 : 0;
    const y = total === 1 ? p.y + GATE_H / 2 : p.y + (GATE_H * (idx + 1)) / (total + 1);
    return { x: p.x + back, y };
  };

  const outPin = (gate) => {
    const p = gatePos[gate.id];
    return { x: p.x + GATE_W + (OUT_EXTRA[gate.type] || 0), y: p.y + GATE_H / 2 };
  };

  const wires = [];
  const firstConsumerY = {};

  for (const g of gates) {
    const total = (g.inputs || []).length;
    (g.inputs || []).forEach((sig, idx) => {
      const target = pin(g, idx, total);
      const src = producer[sig];
      if (src) {
        const s = outPin(src);
        wires.push(wirePath(s.x, s.y, target.x, target.y));
      } else if (inputs.includes(sig)) {
        if (firstConsumerY[sig] === undefined) firstConsumerY[sig] = target.y;
        wires.push(wirePath(X0, firstConsumerY[sig], target.x, target.y));
      }
    });
  }

  const rightX = X0 + IN_W + maxLevel * (GATE_W + COL_GAP) + GATE_W;
  for (const o of outputs) {
    const src = producer[o];
    if (!src) continue;
    const s = outPin(src);
    wires.push(wirePath(s.x, s.y, rightX, s.y));
  }

  const width = rightX + IN_W;
  const height = Y0 + maxRows * (GATE_H + ROW_GAP) + 20;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<g fill="none" stroke="#222" stroke-width="1.5">${wires.join('')}</g>`);
  parts.push('<g fill="#fff" stroke="#1a1a1a" stroke-width="1.5">');
  for (const g of gates) {
    const p = gatePos[g.id];
    const { fill, lines } = gateParts(g.type, p.x, p.y);
    parts.push(`<path d="${fill}" fill="#fff8dc"/>`);
    for (const ln of lines) {
      parts.push(`<path d="${ln}" fill="none" stroke="#1a1a1a" stroke-width="1.5"/>`);
    }
    if (INVERTED.has(g.type)) {
      parts.push(`<circle cx="${p.x + GATE_W + 6}" cy="${p.y + GATE_H / 2}" r="4" fill="#fff"/>`);
    }
  }
  parts.push('</g>');
  parts.push('<g fill="#111" font-family="Helvetica, Arial, sans-serif" font-size="14">');
  for (const sig of inputs) {
    const y = firstConsumerY[sig];
    if (y !== undefined) parts.push(`<text x="${X0 - 10}" y="${y + 5}" text-anchor="end">${esc(sig)}</text>`);
  }
  for (const o of outputs) {
    const src = producer[o];
    const y = src ? outPin(src).y : Y0;
    parts.push(`<text x="${rightX + 10}" y="${y + 5}" text-anchor="start">${esc(o)}</text>`);
  }
  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { renderCircuit };
