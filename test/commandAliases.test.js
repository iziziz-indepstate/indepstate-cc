const assert = require('assert');
const { createCommandService } = require('../app/services/commandLine');
const { LevelOrderCommand } = require('../app/services/levelOrder/command');

function createService(aliases) {
  let row;
  const service = createCommandService({
    aliases,
    commands: [new LevelOrderCommand({ now: () => 123 })],
    onAdd: r => { row = r; }
  });
  return {
    run: cmd => service.run(cmd),
    get row() { return row; }
  };
}

(function testAliasWithArgsPlaceholder() {
  const cmd = createService([
    { enabled: true, from: 'u', to: 'lo ustec {args}' }
  ]);
  const res = cmd.run('u 28900');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(cmd.row, {
    cardType: 'levelOrder',
    ticker: 'USTEC',
    level: 28900,
    event: 'levelOrder',
    time: 123
  });
})();

(function testAliasWithMultipleArgsPlaceholder() {
  const cmd = createService([
    { enabled: true, from: 'up', to: 'lo ustec {args}' }
  ]);
  const res = cmd.run('up 28900 props=source:test');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(cmd.row.ticker, 'USTEC');
  assert.strictEqual(cmd.row.level, 28900);
  assert.strictEqual(cmd.row.source, 'test');
})();

(function testAliasAppendsArgsWhenPlaceholderMissing() {
  const cmd = createService([
    { enabled: true, from: 'u', to: 'lo ustec' }
  ]);
  const res = cmd.run('u 28900');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(cmd.row.ticker, 'USTEC');
  assert.strictEqual(cmd.row.level, 28900);
})();

(function testDisabledAliasIgnored() {
  const cmd = createService([
    { enabled: false, from: 'u', to: 'lo ustec {args}' }
  ]);
  const res = cmd.run('u 28900');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Unknown command: u');
})();

(function testAliasLoopDetected() {
  const cmd = createService([
    { enabled: true, from: 'u', to: 'x {args}' },
    { enabled: true, from: 'x', to: 'u {args}' }
  ]);
  const res = cmd.run('u 28900');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Command alias loop detected');
})();

(function testExistingCommandAliasStillWorks() {
  const cmd = createService([]);
  const res = cmd.run('lo ustec 28900');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(cmd.row.ticker, 'USTEC');
  assert.strictEqual(cmd.row.level, 28900);
})();

console.log('commandAliases tests passed');
