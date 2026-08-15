const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCircuitSpec } = require('./circuit-spec');

test('accepts a dependency-ordered half-adder circuit', () => {
  const spec = validateCircuitSpec({
    inputs: ['A', 'B'],
    outputs: ['S', 'Cout'],
    gates: [
      { id: 'sum', type: 'xor', inputs: ['A', 'B'], output: 'S' },
      { id: 'carry', type: 'and', inputs: ['A', 'B'], output: 'Cout' },
    ],
  });

  assert.equal(spec.gates.length, 2);
  assert.equal(spec.gates[0].type, 'xor');
});

test('rejects a circuit with an unresolved signal', () => {
  assert.throws(
    () => validateCircuitSpec({
      inputs: ['A'],
      outputs: ['Y'],
      gates: [{ id: 'g1', type: 'and', inputs: ['A', 'B'], output: 'Y' }],
    }),
    /unavailable signal B/,
  );
});

test('rejects an unsupported gate type and missing output signal', () => {
  assert.throws(
    () => validateCircuitSpec({
      inputs: ['A'],
      outputs: ['Y'],
      gates: [{ id: 'g1', type: 'flipflop', inputs: ['A'], output: 'Y' }],
    }),
    /unsupported type/,
  );
  assert.throws(
    () => validateCircuitSpec({
      inputs: ['A'],
      outputs: ['Y'],
      gates: [{ id: 'g1', type: 'not', inputs: ['A'], output: 'N1' }],
    }),
    /Output Y is not produced/,
  );
});

test('accepts three-input combinational logic gates', () => {
  const spec = validateCircuitSpec({
    inputs: ['A', 'B', 'C'],
    outputs: ['Y'],
    gates: [{ id: 'majority', type: 'and', inputs: ['A', 'B', 'C'], output: 'Y' }],
  });

  assert.equal(spec.gates[0].inputs.length, 3);
});

test('accepts validated multiplexer and flip-flop components', () => {
  const mux = validateCircuitSpec({
    inputs: ['I0', 'I1', 'S'],
    outputs: ['Y'],
    gates: [{ id: 'select', type: 'mux2', inputs: ['I0', 'I1', 'S'], output: 'Y' }],
  });
  const dff = validateCircuitSpec({
    inputs: ['D', 'CLK'],
    outputs: ['Q'],
    gates: [{ id: 'state', type: 'dff', inputs: ['D', 'CLK'], output: 'Q' }],
  });

  assert.equal(mux.gates[0].type, 'mux2');
  assert.equal(dff.gates[0].type, 'dff');
});

test('rejects advanced components with an incorrect pin count', () => {
  assert.throws(
    () => validateCircuitSpec({
      inputs: ['I0', 'I1'],
      outputs: ['Y'],
      gates: [{ id: 'select', type: 'mux2', inputs: ['I0', 'I1'], output: 'Y' }],
    }),
    /2:1 multiplexer.*exactly 3 inputs/,
  );
  assert.throws(
    () => validateCircuitSpec({
      inputs: ['D'],
      outputs: ['Q'],
      gates: [{ id: 'state', type: 'dff', inputs: ['D'], output: 'Q' }],
    }),
    /D flip-flop.*exactly 2 inputs/,
  );
});

test('accepts a 4:1 multiplexer and supported flip-flop variants', () => {
  const mux4 = validateCircuitSpec({
    inputs: ['I0', 'I1', 'I2', 'I3', 'S0', 'S1'],
    outputs: ['Y'],
    gates: [{ id: 'select4', type: 'mux4', inputs: ['I0', 'I1', 'I2', 'I3', 'S0', 'S1'], output: 'Y' }],
  });
  const variants = [
    { type: 'jkff', inputs: ['J', 'K', 'CLK'] },
    { type: 'tff', inputs: ['T', 'CLK'] },
    { type: 'srff', inputs: ['S', 'R', 'CLK'] },
  ];

  assert.equal(mux4.gates[0].type, 'mux4');
  for (const variant of variants) {
    const spec = validateCircuitSpec({
      inputs: variant.inputs,
      outputs: ['Q'],
      gates: [{ id: 'state', type: variant.type, inputs: variant.inputs, output: 'Q' }],
    });
    assert.equal(spec.gates[0].type, variant.type);
  }
});

test('accepts decoder, encoder, and multi-bit register components', () => {
  const decoder = validateCircuitSpec({
    inputs: ['A1', 'A0', 'EN'],
    outputs: ['Ybus'],
    gates: [{ id: 'decode', type: 'dec2_4', inputs: ['A1', 'A0', 'EN'], output: 'Ybus' }],
  });
  const encoder = validateCircuitSpec({
    inputs: ['D0', 'D1', 'D2', 'D3'],
    outputs: ['Ybus'],
    gates: [{ id: 'encode', type: 'enc4_2', inputs: ['D0', 'D1', 'D2', 'D3'], output: 'Ybus' }],
  });
  const register = validateCircuitSpec({
    inputs: ['Dbus', 'CLK'],
    outputs: ['Qbus'],
    gates: [{ id: 'store', type: 'reg', bits: 8, inputs: ['Dbus', 'CLK'], output: 'Qbus' }],
  });

  assert.equal(decoder.gates[0].type, 'dec2_4');
  assert.equal(encoder.gates[0].type, 'enc4_2');
  assert.equal(register.gates[0].bits, 8);
});

test('rejects invalid component pin counts and register widths', () => {
  assert.throws(
    () => validateCircuitSpec({
      inputs: ['A1', 'A0'],
      outputs: ['Ybus'],
      gates: [{ id: 'decode', type: 'dec2_4', inputs: ['A1', 'A0'], output: 'Ybus' }],
    }),
    /2-to-4 decoder.*exactly 3 inputs/,
  );
  assert.throws(
    () => validateCircuitSpec({
      inputs: ['Dbus', 'CLK'],
      outputs: ['Qbus'],
      gates: [{ id: 'store', type: 'reg', bits: 1, inputs: ['Dbus', 'CLK'], output: 'Qbus' }],
    }),
    /bits value from 2 to 32/,
  );
});
