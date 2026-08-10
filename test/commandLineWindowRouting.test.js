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
      commands: [{
        name: 'ping',
        run(args) {
          calls.push(args);
          return { ok: true, args };
        }
      }]
    };
    const commandLine = initService(servicesApi);
    assert.deepStrictEqual(commandLine.run('ping one two'), { ok: true, args: ['one', 'two'] });
    assert.deepStrictEqual(calls, [['one', 'two']]);
  }

  {
    const commandLine = initService({ commands: [] });
    assert.deepStrictEqual(commandLine.run('add AAPL 100 10'), {
      ok: false,
      error: 'Unknown command: add'
    });
    assert.deepStrictEqual(commandLine.run('rm producingLineId:line-1'), {
      ok: false,
      error: 'Unknown command: rm'
    });
  }

  console.log('commandLine window routing tests passed');
} finally {
  Module._load = originalLoad;
}
