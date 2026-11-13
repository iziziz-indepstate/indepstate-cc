const assert = require('assert');
const { RemoveCommand } = require('../app/services/commands/remove');

async function run() {
  const calls = [];
  const cmd = new RemoveCommand({
    onRemove(filter) {
      calls.push(filter);
      return { ok: true, removed: 1 };
    }
  });

  let res = cmd.run([]);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Usage: rm criterion');

  res = cmd.run(['foo']);
  assert.strictEqual(res.ok, false);

  res = cmd.run(['producingLineId:abc']);
  assert.deepStrictEqual(res, { ok: true, removed: 1 });
  assert.deepStrictEqual(calls, [{ producingLineId: 'abc' }]);

  res = cmd.run(['completed']);
  assert.deepStrictEqual(res, { ok: true, removed: 1 });
  assert.deepStrictEqual(calls.at(-1), { completed: true });
  assert.strictEqual(cmd.run(['completed', 'extra']).ok, false);

  const asyncCmd = new RemoveCommand({
    onRemove() {
      return Promise.resolve({ ok: true, removed: 2 });
    }
  });

  res = await asyncCmd.run(['producingLineId:xyz']);
  assert.deepStrictEqual(res, { ok: true, removed: 2 });

  assert.deepStrictEqual(await asyncCmd.run(['completed']), { ok: true, removed: 2 });

  const { createCommandService } = require('../app/services/commandLine');
  const service = createCommandService({ onRemove: filter => ({ ok: true, filter }) });
  assert.deepStrictEqual(service.run('rm completed'), { ok: true, filter: { completed: true } });

  const missingHandlerCmd = new RemoveCommand();
  res = missingHandlerCmd.run(['producingLineId:abc']);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Remove handler not available');

  res = cmd.run(['unknown:zzz']);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Unknown criterion: unknown');

  console.log('removeCommand tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
