const GATE_TYPES = new Set(['and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor', 'buffer']);
const SIGNAL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

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

function validateCircuitSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Circuit data must be an object.');

  const inputs = uniqueIdentifiers(spec.inputs, 'Inputs', 1, 16);
  const outputs = uniqueIdentifiers(spec.outputs, 'Outputs', 1, 16);
  if (!Array.isArray(spec.gates) || spec.gates.length < 1 || spec.gates.length > 32) {
    throw new Error('A circuit must contain between 1 and 32 gates.');
  }

  const knownSignals = new Set(inputs);
  const gateIds = new Set();
  const gateOutputs = new Set();
  const gates = spec.gates.map((gate, index) => {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error(`Gate ${index + 1} is invalid.`);
    const id = identifier(gate.id, `Gate ${index + 1} id`);
    const type = String(gate.type || '').toLowerCase().trim();
    const output = identifier(gate.output, `Gate ${index + 1} output`);
    if (!GATE_TYPES.has(type)) throw new Error(`Gate ${id} uses an unsupported gate type.`);
    if (gateIds.has(id)) throw new Error(`Gate id ${id} is duplicated.`);
    if (gateOutputs.has(output) || knownSignals.has(output)) throw new Error(`Signal ${output} is duplicated.`);

    const unaryGate = type === 'not' || type === 'buffer';
    const validInputCount = Array.isArray(gate.inputs) && (unaryGate ? gate.inputs.length === 1 : gate.inputs.length >= 2 && gate.inputs.length <= 4);
    if (!validInputCount) {
      throw new Error(unaryGate
        ? `Gate ${id} requires exactly one input.`
        : `Gate ${id} requires between two and four inputs.`);
    }
    const gateInputs = gate.inputs.map((signal, inputIndex) => identifier(signal, `Gate ${id} input ${inputIndex + 1}`));
    for (const signal of gateInputs) {
      if (!knownSignals.has(signal)) throw new Error(`Gate ${id} refers to unavailable signal ${signal}. List gates in dependency order.`);
    }

    gateIds.add(id);
    gateOutputs.add(output);
    knownSignals.add(output);
    return { id, type, inputs: gateInputs, output };
  });

  for (const output of outputs) {
    if (!knownSignals.has(output)) throw new Error(`Output ${output} is not produced by the circuit.`);
  }

  return { inputs, outputs, gates };
}

module.exports = { GATE_TYPES, validateCircuitSpec };
