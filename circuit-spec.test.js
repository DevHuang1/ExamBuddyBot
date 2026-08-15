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
    /unsupported gate type/,
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
