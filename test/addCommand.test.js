const assert = require('assert');
const { AddCommand } = require('../app/services/commands/add');

async function run() {
  let row;
  const cmd = new AddCommand({ onAdd: r => { row = r; } });

  // default SL
  let res = cmd.run(['AAA', '100']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.sl, 10);

  // raw points
  res = cmd.run(['AAA', '100', '20']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.sl, 20);

  // price with decimal dot -> convert relative to entry price (tick 0.01)
  res = cmd.run(['AAA', '100', '99.75']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.sl, 25);

  // ticker preserves case without dot
  res = cmd.run(['bbb', '100', '20']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'bbb');

  // ticker preserves case with dot suffix
  res = cmd.run(['ccc.def', '100', '20']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'ccc.def');

  console.log('addCommand tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
