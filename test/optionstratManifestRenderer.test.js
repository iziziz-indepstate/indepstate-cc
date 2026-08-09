const assert = require('assert');
const Module = require('module');

async function run() {
  const originalLoad = Module._load;
  const rendererCalls = [];
  const handlers = new Map();
  let registeredInstrument = null;
  let registeredHandler = null;
  let renderCount = 0;

  Module._load = function(request, parent, isMain) {
    if (request === './renderer' && String(parent?.filename || '').replace(/\\/g, '/').endsWith('app/services/optionstrat/manifest.js')) {
      return {
        createOptionStratRenderer() {
          const orderCardHandler = {
            createBody: () => ({ type: 'option' }),
            buttons: () => [{ label: 'OPEN', action: 'OPEN', style: 'bl' }],
            scheduleInstantExecution: () => true
          };
          return {
            pendingOptionValuations: new Set(),
            createOrderCardHandler() {
              rendererCalls.push(['createOrderCardHandler']);
              return orderCardHandler;
            },
            ensureOptionPayoff(row) {
              rendererCalls.push(['ensureOptionPayoff', row]);
            },
            setValuationRefreshMs(ms) {
              rendererCalls.push(['setValuationRefreshMs', ms]);
              return Number(ms);
            },
            setDisplayFields(fields) {
              rendererCalls.push(['setDisplayFields', fields]);
              return fields;
            },
            startValuationRefresh() {
              rendererCalls.push(['startValuationRefresh']);
            },
            createOptionPositionCard: () => ({}),
            markRowOpened: key => rendererCalls.push(['markRowOpened', key]),
            markRowClosed: key => rendererCalls.push(['markRowClosed', key]),
            emitButtonEvent: (action, row) => rendererCalls.push(['emitButtonEvent', action, row])
          };
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const manifestPath = '../app/services/optionstrat/manifest';
  delete require.cache[require.resolve(manifestPath)];
  const manifest = require(manifestPath);
  Module._load = originalLoad;

  manifest.rendererHandlers[0].register({
    ipcRenderer: {
      invoke: async (channel, payload) => {
        if (channel === 'settings:get' && payload === 'optionstrat') {
          return { valuationRefreshMs: 7000, displayFields: { pl: true } };
        }
        return {};
      }
    },
    el: () => ({}),
    state: { rows: [] },
    rowKey: row => row.key || row.ticker,
    render: () => { renderCount += 1; },
    legacyOrderStateApi: {
      getCardState: () => undefined,
      clearPendingRequest: () => {},
      markPlacedOrder: () => {},
      getPlacedOrder: () => undefined,
      bindTicket: () => {},
      listPlacedOrders: () => [],
      deletePlacedOrder: () => {},
      unbindTicket: () => {}
    },
    setCardState: () => {},
    registerOrderCardInstrumentHandler(instrumentType, handler) {
      registeredInstrument = instrumentType;
      registeredHandler = handler;
    },
    registerPositionCardRenderer() {},
    settingsRuntime: {
      onApply(name, fn) {
        handlers.set(name, fn);
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(registeredInstrument, 'OPT');
  assert.strictEqual(typeof registeredHandler.createBody, 'function');
  assert.strictEqual(registeredHandler.title({ row: { ticker: 'SPY', name: 'LCS 755/756' } }), 'LCS 755/756');
  assert.strictEqual(registeredHandler.title({ row: { ticker: 'SPY' } }), 'SPY');
  assert.strictEqual(registeredHandler.matchesExistingRow({
    incomingRow: { ticker: 'SPY', event: 'optionstrat', time: 1, price: 2 },
    existingRow: { ticker: 'SPY', event: 'optionstrat', time: 1, price: 2 },
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`
  }), true);
  assert.strictEqual(registeredHandler.matchesExistingRow({
    incomingRow: { ticker: 'SPY', event: 'optionstrat', time: 1, price: 2 },
    existingRow: { ticker: 'SPY', event: 'optionstrat', time: 2, price: 2 },
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`
  }), false);
  assert.strictEqual(registeredHandler.shouldScheduleInstantExecution({ row: { instantExecution: true } }), true);
  assert.strictEqual(registeredHandler.shouldScheduleInstantExecution({ row: { instantExecution: false } }), false);
  const openedRow = {};
  registeredHandler.onExecutionResultOk({ row: openedRow, openedAt: 123 });
  registeredHandler.onExecutionResultOk({ row: openedRow, openedAt: 456 });
  assert.strictEqual(openedRow.openedAt, 123);
  assert(rendererCalls.some(call => call[0] === 'createOrderCardHandler'));
  assert(rendererCalls.some(call => call[0] === 'setValuationRefreshMs' && call[1] === 7000));
  assert(rendererCalls.some(call => call[0] === 'setDisplayFields' && call[1].pl === true));
  assert(rendererCalls.some(call => call[0] === 'startValuationRefresh'));

  registeredHandler.onCreateCard({ row: { ticker: 'SPY', instrumentType: 'OPT' } });
  assert(rendererCalls.some(call => call[0] === 'ensureOptionPayoff' && call[1].ticker === 'SPY'));

  handlers.get('optionstrat')({
    config: {
      valuationRefreshMs: 9000,
      displayFields: { value: false }
    }
  });
  assert(rendererCalls.some(call => call[0] === 'setValuationRefreshMs' && call[1] === 9000));
  assert(rendererCalls.some(call => call[0] === 'setDisplayFields' && call[1].value === false));
  assert.strictEqual(renderCount, 1);

  console.log('optionstratManifestRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
