const GATE_TYPES = new Set([
  'and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor', 'buffer',
  'mux2', 'mux4', 'dff', 'jkff', 'tff', 'srff',
  'dec2_4', 'dec3_8', 'enc4_2', 'enc8_3', 'reg',
]);
const SIGNAL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

const COMPONENT_RULES = {
  and: { min: 2, max: 4, label: 'logic gate' },
  or: { min: 2, max: 4, label: 'logic gate' },
  xor: { min: 2, max: 4, label: 'logic gate' },
  nand: { min: 2, max: 4, label: 'logic gate' },
  nor: { min: 2, max: 4, label: 'logic gate' },
  xnor: { min: 2, max: 4, label: 'logic gate' },
  not: { exact: 1, label: 'NOT gate' },
  buffer: { exact: 1, label: 'buffer gate' },
  mux2: { exact: 3, label: '2:1 multiplexer (I0, I1, S)' },
  mux4: { exact: 6, label: '4:1 multiplexer (I0, I1, I2, I3, S0, S1)' },
  dff: { exact: 2, label: 'D flip-flop (D, CLK)' },
  jkff: { exact: 3, label: 'JK flip-flop (J, K, CLK)' },
  tff: { exact: 2, label: 'T flip-flop (T, CLK)' },
  srff: { exact: 3, label: 'SR flip-flop (S, R, CLK)' },
  dec2_4: { exact: 3, label: '2-to-4 decoder (A1, A0, EN)' },
  dec3_8: { exact: 4, label: '3-to-8 decoder (A2, A1, A0, EN)' },
  enc4_2: { exact: 4, label: '4-to-2 encoder (D0, D1, D2, D3)' },
  enc8_3: { exact: 8, label: '8-to-3 encoder (D0 through D7)' },
  reg: { exact: 2, label: 'multi-bit register (D_bus, CLK)' },
};

function identifier(value, label) {
  const text = String(value || '').trim();
  if (!SIGNAL_NAME.test(text)) throw new Error(`${label} must use letters, numbers, and underscores and start with a letter.`);
  return text;
}

function uniqueIdentifiers(values, label, min, max) {
  if (!Array.isArray(values) || values.length < min || values.length > max) {
    throw new Error(`${label} must contain between ${min} and ${max} signal names.`);
  }
  const normalized = values.map((value, index) => identifier(value, `${label} item ${index + 1}`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} cannot contain duplicate signal names.`);
  return normalized;
}

function validateInputCount(gate, inputs) {
  const rule = COMPONENT_RULES[gate.type];
  if (!rule) throw new Error(`Gate ${gate.id} uses an unsupported component type.`);
  if (rule.exact && inputs.length !== rule.exact) {
    throw new Error(`Gate ${gate.id} is a ${rule.label} and requires exactly ${rule.exact} inputs.`);
  }
  if (rule.min && (inputs.length < rule.min || inputs.length > rule.max)) {
    throw new Error(`Gate ${gate.id} is a ${rule.label} and requires between ${rule.min} and ${rule.max} inputs.`);
  }
}

function validateBits(gate, rawBits) {
  if (gate.type !== 'reg') {
    if (rawBits !== undefined) throw new Error(`Component ${gate.id} only supports the bits field for type reg.`);
    return undefined;
  }
  const bits = Number(rawBits);
  if (!Number.isInteger(bits) || bits < 2 || bits > 32) {
    throw new Error(`Register ${gate.id} requires an integer bits value from 2 to 32.`);
  }
  return bits;
}

function validateCircuitSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Circuit data must be an object.');

  const inputs = uniqueIdentifiers(spec.inputs, 'Inputs', 1, 24);
  const outputs = uniqueIdentifiers(spec.outputs, 'Outputs', 1, 16);
  if (!Array.isArray(spec.gates) || spec.gates.length < 1 || spec.gates.length > 40) {
    throw new Error('A circuit must contain between 1 and 40 components.');
  }

  const knownSignals = new Set(inputs);
  const gateIds = new Set();
  const gateOutputs = new Set();
  const gates = spec.gates.map((gate, index) => {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error(`Component ${index + 1} is invalid.`);
    const id = identifier(gate.id, `Component ${index + 1} id`);
    const type = String(gate.type || '').toLowerCase().trim();
    const output = identifier(gate.output, `Component ${index + 1} output`);
    if (!GATE_TYPES.has(type)) throw new Error(`Component ${id} uses an unsupported type.`);
    if (gateIds.has(id)) throw new Error(`Component id ${id} is duplicated.`);
    if (gateOutputs.has(output) || knownSignals.has(output)) throw new Error(`Signal ${output} is duplicated.`);
    if (!Array.isArray(gate.inputs)) throw new Error(`Component ${id} inputs must be an array.`);

    const gateInputs = gate.inputs.map((signal, inputIndex) => identifier(signal, `Component ${id} input ${inputIndex + 1}`));
    validateInputCount({ id, type }, gateInputs);
    const bits = validateBits({ id, type }, gate.bits);
    for (const signal of gateInputs) {
      if (!knownSignals.has(signal)) throw new Error(`Component ${id} refers to unavailable signal ${signal}. List components in dependency order.`);
    }

    gateIds.add(id);
    gateOutputs.add(output);
    knownSignals.add(output);
    return bits ? { id, type, inputs: gateInputs, output, bits } : { id, type, inputs: gateInputs, output };
  });

  for (const output of outputs) {
    if (!knownSignals.has(output)) throw new Error(`Output ${output} is not produced by the circuit.`);
  }

  return { inputs, outputs, gates };
}

module.exports = { COMPONENT_RULES, GATE_TYPES, validateCircuitSpec };
