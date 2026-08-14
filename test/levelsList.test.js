const assert = require('assert');
const { createCommandService } = require('../app/services/commandLine');
const {
  LevelsListCommand,
  buildLevelsList
} = require('../app/services/levelsList');

const rows = [
  { ticker: 'USTEC', level: 24100, price: 24090 },
  { ticker: 'SPX', price: '6500.25' },
  { ticker: 'EURUSD', level: '1,2345' },
  { ticker: '', level: 10 },
  { ticker: 'BAD', level: 'x', price: null }
];

(function testDefaultIncludesLevelAndPrice() {
  const res = buildLevelsList(rows, { sources: ['level', 'price'] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 3);
  assert.strictEqual(res.text, 'EURUSD 1.23\nSPX 6500.25\nUSTEC 24100\n');
})();

(function testLevelModeSkipsPriceOnlyRows() {
  const res = buildLevelsList(rows, { mode: 'level', sources: ['level', 'price'] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.text, 'EURUSD 1.23\nUSTEC 24100\n');
})();

(function testPriceModeSkipsLevelOnlyRows() {
  const res = buildLevelsList(rows, { mode: 'price', sources: ['level', 'price'] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.text, 'SPX 6500.25\nUSTEC 24090\n');
})();

(function testPriorityChoosesLevelOverPrice() {
  const res = buildLevelsList([{ ticker: 'NQ', level: 24100, price: 24090 }], { sources: ['level', 'price'] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.text, 'NQ 24100\n');
})();

async function run() {
  {
    let copied = null;
    const sender = { id: 'window-1' };
    const service = createCommandService({
      commands: [new LevelsListCommand({
        getConfig: () => ({ sources: ['level', 'price'] }),
        getRows(context) {
          assert.strictEqual(context.sender, sender);
          return rows;
        },
        writeText(text) {
          copied = text;
        }
      })]
    });

    const res = await service.run('levelsList', { sender });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.count, 3);
    assert.strictEqual(copied, 'EURUSD 1.23\nSPX 6500.25\nUSTEC 24100\n');
  }

  {
    const cmd = new LevelsListCommand({
      getConfig: () => ({ sources: ['level', 'price'] }),
      writeText() {}
    });
    const res = await cmd.run([]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'Order cards reader is not available');
  }

  console.log('levelsList tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
