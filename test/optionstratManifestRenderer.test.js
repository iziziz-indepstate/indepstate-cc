const assert = require('assert');
const Module = require('module');

async function run() {
  const originalLoad = Module._load;
  const rendererCalls = [];
  const handlers = new Map();
  let rendererDeps = null;
  const runtimeCalls = [];
  let renderCount = 0;

  Module._load = function(request, parent, isMain) {
    if (request === './renderer' && String(parent?.filename || '').replace(/\\/g, '/').endsWith('app/services/optionstrat/manifest.js')) {
      return {
        createOptionStratRenderer(deps) {
          rendererDeps = deps;
          const orderCardHandler = {
            createBody: () => ({ type: 'option' }),
            buttons: () => [{ label: 'OPEN', action: 'OPEN', style: 'bl' }],
            preparePlace: () => ({ request: true }),
            afterPlaceOk: () => true,
            scheduleInstantExecution: () => true
          };
          return {
            pendingOptionValuations: new Set(),
            createOrderCardHandler() {
              rendererCalls.push(['createOrderCardHandler']);
              return orderCardHandler;
            },
            createOptionBody: orderCardHandler.createBody,
            createOptionPositionView: context => ({ type: 'option-snapshot-view', context }),
            createOptionSnapshotActionsControl: context => ({ type: 'option-snapshot-actions', context }),
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
    pendingRequestLabels: {
      clearPendingRequest: () => {}
    },
    placedOrderLookup: {
      markPlacedOrder: () => {},
      getPlacedOrder: () => undefined,
      listPlacedOrders: () => [],
      deletePlacedOrder: () => {}
    },
    cardVisualState: {
      getCardState: () => undefined
    },
    ticketBinding: {
      bindTicket: () => {},
      unbindTicket: () => {}
    },
    setCardState: () => {},
    cardRuntime: {
      findLegacyRowByKey: () => undefined,
      legacyRows: () => [],
      registerCardType(definition) {
        runtimeCalls.push(['registerCardType', definition]);
      },
      registerCardView(name, renderer) {
        runtimeCalls.push(['registerCardView', name, renderer]);
      },
      registerCardControl(name, factory) {
        runtimeCalls.push(['registerCardControl', name, factory]);
      },
      registerCardShape(name, composer) {
        runtimeCalls.push(['registerCardShape', name, composer]);
      },
    },
    settingsRuntime: {
      onApply(name, fn) {
        handlers.set(name, fn);
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(rendererDeps.legacyRows.findLegacyRowByKey('missing'), undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rendererDeps, 'orderCardsState'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rendererDeps, 'setLegacyOrderCardState'), false);
  const legacyDefinition = runtimeCalls.find(call => call[0] === 'registerCardType' && call[1].type === 'option-legacy-row')?.[1];
  assert(legacyDefinition);
  assert.deepStrictEqual(legacyDefinition.legacyInstrumentTypes, ['OPT']);
  assert.deepStrictEqual(legacyDefinition.legacyCardTypes, ['option', 'optionstrat']);
  const legacyRow = legacyDefinition.legacyRow;
  assert.strictEqual(legacyRow.title({ row: { ticker: 'SPY', name: 'LCS 755/756' } }), 'LCS 755/756');
  assert.strictEqual(legacyRow.title({ row: { ticker: 'SPY' } }), 'SPY');
  assert.strictEqual(legacyRow.matchesExistingRow({
    incomingRow: { ticker: 'SPY', event: 'optionstrat', time: 1, price: 2 },
    existingRow: { ticker: 'SPY', event: 'optionstrat', time: 1, price: 2 },
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`
  }), true);
  assert.strictEqual(legacyRow.matchesExistingRow({
    incomingRow: { ticker: 'SPY', event: 'optionstrat', time: 1, price: 2 },
    existingRow: { ticker: 'SPY', event: 'optionstrat', time: 2, price: 2 },
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`
  }), false);
  assert.strictEqual(legacyRow.shouldScheduleInstantExecution({ row: { instantExecution: true } }), true);
  assert.strictEqual(legacyRow.shouldScheduleInstantExecution({ row: { instantExecution: false } }), false);
  const openedRow = {};
  legacyRow.onExecutionResultOk({ row: openedRow, openedAt: 123 });
  legacyRow.onExecutionResultOk({ row: openedRow, openedAt: 456 });
  assert.strictEqual(openedRow.openedAt, 123);
  assert(rendererCalls.some(call => call[0] === 'createOrderCardHandler'));
  assert(rendererCalls.some(call => call[0] === 'setValuationRefreshMs' && call[1] === 7000));
  assert(rendererCalls.some(call => call[0] === 'setDisplayFields' && call[1].pl === true));
  assert(rendererCalls.some(call => call[0] === 'startValuationRefresh'));
  const optionDefinition = runtimeCalls.find(call => call[0] === 'registerCardType' && call[1].type === 'option')?.[1];
  const optionStratDefinition = runtimeCalls.find(call => call[0] === 'registerCardType' && call[1].type === 'optionstrat')?.[1];
  for (const definition of [optionDefinition, optionStratDefinition]) {
    assert(definition);
    assert.strictEqual(definition.view, 'option-snapshot-payoff-valuation');
    assert.deepStrictEqual(definition.controls, ['option-snapshot-actions']);
    assert.strictEqual(definition.shape, 'option-snapshot-position-card');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(definition, 'legacyRow'), false);
  }
  assert(runtimeCalls.some(call => call[0] === 'registerCardView' && call[1] === 'option-legacy-row-view'));
  assert(runtimeCalls.some(call => call[0] === 'registerCardView' && call[1] === 'option-snapshot-payoff-valuation'));
  assert(runtimeCalls.some(call => call[0] === 'registerCardControl' && call[1] === 'option-legacy-open'));
  assert(runtimeCalls.some(call => call[0] === 'registerCardControl' && call[1] === 'option-legacy-close-remove'));
  assert(runtimeCalls.some(call => call[0] === 'registerCardControl' && call[1] === 'option-snapshot-actions'));
  assert(runtimeCalls.some(call => call[0] === 'registerCardShape' && call[1] === 'option-snapshot-position-card'));
  assert.strictEqual(runtimeCalls.some(call => call[0] === 'registerPositionCardRenderer'), false);

  const openControl = runtimeCalls.find(call => call[0] === 'registerCardControl' && call[1] === 'option-legacy-open')[2]();
  assert.deepStrictEqual(openControl.buttons({ ticker: 'SPY' }), [{ label: 'OPEN', action: 'OPEN', style: 'bl' }]);
  assert.strictEqual(typeof openControl.preparePlace, 'function');
  assert.strictEqual(typeof openControl.afterPlaceOk, 'function');
  assert.strictEqual(typeof openControl.scheduleInstantExecution, 'function');
  const closeControl = runtimeCalls.find(call => call[0] === 'registerCardControl' && call[1] === 'option-legacy-close-remove')[2]();
  assert.strictEqual(closeControl.placedButton.label, 'CLOSE');
  assert.strictEqual(typeof closeControl.closePlacedOrder, 'function');
  assert.strictEqual(typeof closeControl.shouldKeepFullCardOnState, 'function');
  assert.strictEqual(typeof closeControl.shouldEnableButtonOnState, 'function');
  assert.strictEqual(typeof closeControl.shouldHideButtonsOnState, 'function');
  assert.strictEqual(typeof closeControl.resetButtons, 'function');

  legacyRow.onCreateCard({ row: { ticker: 'SPY', instrumentType: 'OPT' } });
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
