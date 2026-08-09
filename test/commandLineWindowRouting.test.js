const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle() {} }
    };
  }
  return originalLoad(request, parent, isMain);
};

try {
  const manifestPath = require.resolve('../app/services/commandLine/manifest');
  delete require.cache[manifestPath];
  const { initService } = require('../app/services/commandLine/manifest');

  {
    const calls = [];
    const servicesApi = {
      commands: [],
      orderCards: {
        ingestRow(row, context) {
          calls.push({ method: 'ingestRow', row, context });
          return row;
        },
        remove(filter) {
          calls.push({ method: 'remove', filter });
          return { ok: true };
        }
      }
    };
    const commandLine = initService(servicesApi);
    assert.deepStrictEqual(commandLine.run('add AAPL 100 10'), { ok: true });
    assert.strictEqual(calls[0].method, 'ingestRow');
    assert.strictEqual(calls[0].row.ticker, 'AAPL');
    assert.deepStrictEqual(calls[0].context, { source: 'commandLine' });
    assert.deepStrictEqual(commandLine.run('rm producingLineId:line-1'), { ok: true });
    assert.deepStrictEqual(calls[1], { method: 'remove', filter: { producingLineId: 'line-1' } });
  }

  {
    const commandLine = initService({ commands: [] });
    assert.deepStrictEqual(commandLine.run('add AAPL 100 10'), {
      ok: false,
      error: 'Order cards service unavailable'
    });
    assert.deepStrictEqual(commandLine.run('rm producingLineId:line-1'), {
      ok: false,
      error: 'Order cards service unavailable'
    });
  }

  console.log('commandLine window routing tests passed');
} finally {
  Module._load = originalLoad;
}
