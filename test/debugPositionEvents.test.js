const assert = require('assert');
const Module = require('module');

async function run() {
  const previousDebugFlag = process.env.ISCC_DEBUG_POSITION_EVENTS;
  const previousWindow = global.window;
  const sent = [];
  const logs = [];
  const originalLog = console.log;

  process.env.ISCC_DEBUG_POSITION_EVENTS = '1';
  global.window = {};
  console.log = (...args) => logs.push(args);

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcRenderer: {
          send(channel, payload) {
            sent.push({ channel, payload });
          }
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const helperPath = require.resolve('../app/debugPositionEvents');
  delete require.cache[helperPath];

  try {
    const { debugPositionEvents } = require('../app/debugPositionEvents');
    debugPositionEvents('renderer.test.scope', { id: 'pos-test' });

    assert.deepStrictEqual(sent, [{
      channel: 'debug:position-events',
      payload: {
        scope: 'renderer.test.scope',
        details: { id: 'pos-test' },
        level: 'log'
      }
    }]);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0][0], '[position-events]');
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    delete require.cache[helperPath];
    if (previousDebugFlag === undefined) delete process.env.ISCC_DEBUG_POSITION_EVENTS;
    else process.env.ISCC_DEBUG_POSITION_EVENTS = previousDebugFlag;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }

  console.log('debugPositionEvents tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
