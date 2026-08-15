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
