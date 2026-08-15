const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCircuitSpec } = require('./circuit-spec');
const { renderCircuit } = require('./circuit');

test('renders a labelled 2:1 multiplexer with its select input', async () => {
  const spec = validateCircuitSpec({
    inputs: ['I0', 'I1', 'S'],
    outputs: ['Y'],
    gates: [{ id: 'select', type: 'mux2', inputs: ['I0', 'I1', 'S'], output: 'Y' }],
  });

  const svg = await renderCircuit(spec);

  assert.match(svg, /MUX 2:1/);
  assert.match(svg, /<path d="M [^"]+ L [^"]+ L [^"]+ L [^"]+ Z"\/>/);
  assert.match(svg, />S<\/text>/);
});

test('renders a labelled D flip-flop with a clock marker', async () => {
  const spec = validateCircuitSpec({
    inputs: ['D', 'CLK'],
    outputs: ['Q'],
    gates: [{ id: 'state', type: 'dff', inputs: ['D', 'CLK'], output: 'Q' }],
  });

  const svg = await renderCircuit(spec);

  assert.match(svg, /D FF/);
  assert.match(svg, /stroke-width="1\.6"/);
  assert.match(svg, />CLK<\/text>/);
});

test('renders labelled decoder and encoder symbols', async () => {
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

  assert.match(await renderCircuit(decoder), /DEC 2:4/);
  assert.match(await renderCircuit(encoder), /ENC 4:2/);
});

test('renders a labelled multi-bit register with clock-edge marker', async () => {
  const register = validateCircuitSpec({
    inputs: ['Dbus', 'CLK'],
    outputs: ['Qbus'],
    gates: [{ id: 'store', type: 'reg', bits: 16, inputs: ['Dbus', 'CLK'], output: 'Qbus' }],
  });

  const svg = await renderCircuit(register);

  assert.match(svg, /REG 16-bit/);
  assert.match(svg, /stroke-width="1\.6"/);
  assert.match(svg, />Qbus<\/text>/);
});
