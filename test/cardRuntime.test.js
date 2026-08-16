const assert = require('assert');
const {
  createCardRuntime,
  createOrderStateFacades,
  createLegacyOrderStateCompatApi
} = require('../app/infrastructure/renderer/cardRuntime');

function run() {
  function assertBridgeCall(call, kind, key, handler) {
    assert.strictEqual(call?.[0], kind);
    assert.strictEqual(call?.[1], key);
    assert.strictEqual(call?.[2]?.id, handler.id);
  }

  const uiState = new Map([['old', { expanded: true }]]);
  const shellState = { filter: '' };
  const runtime = createCardRuntime({ state: shellState, uiState });

  runtime.stateApi.setCardState('old', 'pending');
  runtime.stateApi.setPendingExecLabel('old', 'bar-close');
  runtime.stateApi.markPlacedOrder('old', { ticket: 't1', nested: { keepReference: true } });
  runtime.stateApi.markPendingRequest('req-1', 'old', { retryCount: 2, pendingId: 'p1' });
  runtime.stateApi.bindTicket('t1', 'old');
  runtime.stateApi.migrateKey('old', 'new');

  assert.strictEqual(runtime.stateApi.getCardState('new'), 'pending');
  assert.strictEqual(runtime.stateApi.getPendingExecLabel('new'), 'bar-close');
  assert.strictEqual(runtime.stateApi.resolvePendingKey('req-1'), 'new');
  assert.strictEqual(runtime.stateApi.getPendingId('req-1'), 'p1');
  assert.strictEqual(runtime.stateApi.getRetryCount('req-1'), 2);
  assert.strictEqual(runtime.stateApi.resolveTicketKey('t1'), 'new');
  assert.deepStrictEqual(uiState.get('new'), { expanded: true });

  runtime.stateFacades.cardVisualState.clearExecutionStateByKey('new');
  assert.strictEqual(runtime.stateFacades.cardVisualState.getCardState('new'), undefined);
  assert.strictEqual(runtime.stateFacades.placedOrderLookup.getPlacedOrder('new'), undefined);
  assert.strictEqual(runtime.stateFacades.ticketBinding.resolveTicketKey('t1'), undefined);

  runtime.stateApi.setFilter('OPT');
  assert.strictEqual(shellState.filter, 'OPT');

  const unregisterType = runtime.registerCardType({ type: 'option', shape: 'trade-card' });
  runtime.registerCardType({ type: 'fallback', match: card => card.kind === 'fallback' });
  assert.strictEqual(runtime.resolveCardType({ card: { type: 'option' } }).shape, 'trade-card');
  assert.strictEqual(runtime.resolveCardType({ kind: 'fallback' }).type, 'fallback');
  unregisterType();
  assert.strictEqual(runtime.resolveCardType({ card: { type: 'option' } }), undefined);

  const view = () => 'view';
  const control = () => 'control';
  const shape = () => 'shape';
  const unregisterView = runtime.registerCardView('identity', view);
  const unregisterControl = runtime.registerCardControl('remove', control);
  const unregisterShape = runtime.registerCardShape('trade-card', shape);
  assert.strictEqual(runtime.getCardView('identity'), view);
  assert.strictEqual(runtime.getCardControl('remove'), control);
  assert.strictEqual(runtime.getCardShape('trade-card'), shape);
  unregisterView();
  unregisterControl();
  unregisterShape();
  assert.strictEqual(runtime.getCardView('identity'), undefined);
  assert.strictEqual(runtime.getCardControl('remove'), undefined);
  assert.strictEqual(runtime.getCardShape('trade-card'), undefined);

  const bridgeCalls = [];
  const legacyRows = [
    { key: 'opt-1', instrumentType: 'OPT', ticker: 'SPY' },
    { key: 'eq-1', instrumentType: 'EQ', ticker: 'AAPL' }
  ];
  const optHandlerBefore = { id: 'opt-before', createBody: () => ({}) };
  const optHandlerAfter = { id: 'opt-after', createBody: () => ({}) };
  const optHandlerLatest = { id: 'opt-latest', createBody: () => ({}) };
  const cardTypeHandlerBefore = { id: 'card-before', createBody: () => ({ type: 'before' }) };
  const cardTypeHandlerAfter = { id: 'card-after', createBody: () => ({ type: 'after' }) };
  const cardTypeHandlerLatest = { id: 'card-latest', createBody: () => ({ type: 'latest' }) };
  const unregisterOptBefore = runtime.registerOrderCardInstrumentHandler('OPT', optHandlerBefore);
  const unregisterCardTypeBefore = runtime.registerOrderCardTypeHandler('option', cardTypeHandlerBefore);
  const disconnectLegacy = runtime.connectLegacyOrderCardRenderer({
    renderer: {
      registerInstrumentHandler(instrumentType, handler) {
        bridgeCalls.push(['registerInstrumentHandler', instrumentType, handler]);
        return () => bridgeCalls.push(['unregisterInstrumentHandler', instrumentType, handler]);
      },
      registerCardTypeHandler(cardType, handler) {
        bridgeCalls.push(['registerCardTypeHandler', cardType, handler]);
        return () => bridgeCalls.push(['unregisterCardTypeHandler', cardType, handler]);
      }
    },
    getRows: () => legacyRows,
    rowKey: row => row.key,
    setCardState: (key, stateName) => {
      bridgeCalls.push(['setCardState', key, stateName]);
      return true;
    }
  });
  assert.strictEqual(bridgeCalls[0][0], 'registerInstrumentHandler');
  assert.strictEqual(bridgeCalls[0][1], 'OPT');
  assert.strictEqual(bridgeCalls[0][2], optHandlerBefore);
  assert.strictEqual(bridgeCalls[1][0], 'registerCardTypeHandler');
  assert.strictEqual(bridgeCalls[1][1], 'option');
  assert.strictEqual(bridgeCalls[1][2], cardTypeHandlerBefore);
  assert.strictEqual(runtime.legacyRows(), legacyRows);
  assert.deepStrictEqual(runtime.findLegacyRowByKey('opt-1'), legacyRows[0]);
  assert.strictEqual(runtime.findLegacyRowByKey('missing'), undefined);
  assert.strictEqual(runtime.setLegacyRowCardState('opt-1', 'placed'), true);
  assert.deepStrictEqual(bridgeCalls[2], ['setCardState', 'opt-1', 'placed']);
  const unregisterOptAfter = runtime.registerOrderCardInstrumentHandler('OPT', optHandlerAfter);
  assertBridgeCall(bridgeCalls[3], 'unregisterInstrumentHandler', 'OPT', optHandlerBefore);
  assert.strictEqual(bridgeCalls[4][0], 'registerInstrumentHandler');
  assert.strictEqual(bridgeCalls[4][1], 'OPT');
  assert.strictEqual(bridgeCalls[4][2], optHandlerAfter);
  runtime.registerOrderCardInstrumentHandler('OPT', optHandlerLatest);
  assertBridgeCall(bridgeCalls[5], 'unregisterInstrumentHandler', 'OPT', optHandlerAfter);
  assert.strictEqual(bridgeCalls[6][0], 'registerInstrumentHandler');
  assert.strictEqual(bridgeCalls[6][1], 'OPT');
  assert.strictEqual(bridgeCalls[6][2], optHandlerLatest);
  unregisterOptBefore();
  assert.strictEqual(bridgeCalls.length, 7);
  unregisterOptAfter();
  assert.strictEqual(bridgeCalls.length, 7);
  assert.strictEqual(runtime.legacyOrderCardInstrumentHandlers.OPT, optHandlerLatest);
  const unregisterCardTypeAfter = runtime.registerOrderCardTypeHandler('option', cardTypeHandlerAfter);
  assertBridgeCall(bridgeCalls[7], 'unregisterCardTypeHandler', 'option', cardTypeHandlerBefore);
  assert.strictEqual(bridgeCalls[8][0], 'registerCardTypeHandler');
  assert.strictEqual(bridgeCalls[8][1], 'option');
  assert.strictEqual(bridgeCalls[8][2], cardTypeHandlerAfter);
  runtime.registerOrderCardTypeHandler('option', cardTypeHandlerLatest);
  assertBridgeCall(bridgeCalls[9], 'unregisterCardTypeHandler', 'option', cardTypeHandlerAfter);
  assert.strictEqual(bridgeCalls[10][0], 'registerCardTypeHandler');
  assert.strictEqual(bridgeCalls[10][1], 'option');
  assert.strictEqual(bridgeCalls[10][2], cardTypeHandlerLatest);
  unregisterCardTypeBefore();
  assert.strictEqual(bridgeCalls.length, 11);
  unregisterCardTypeAfter();
  assert.strictEqual(bridgeCalls.length, 11);
  assert.strictEqual(runtime.legacyOrderCardTypeHandlers.option, cardTypeHandlerLatest);
  disconnectLegacy();
  assertBridgeCall(bridgeCalls[11], 'unregisterInstrumentHandler', 'OPT', optHandlerLatest);
  assertBridgeCall(bridgeCalls[12], 'unregisterCardTypeHandler', 'option', cardTypeHandlerLatest);

  const compositionCalls = [];
  const compositionRuntime = createCardRuntime();
  const composedView = (row, key) => {
    compositionCalls.push(['view', row, key]);
    return { row, key };
  };
  const preparePlace = () => 'prepared';
  const afterPlaceOk = () => 'placed';
  const scheduleInstantExecution = () => 'scheduled';
  const closePlacedOrder = () => 'closed';
  const resetButtons = () => 'reset';
  compositionRuntime.registerCardView('option-view', composedView);
  compositionRuntime.registerCardControl('option-open', () => ({
    buttons: row => [{ label: `OPEN ${row.ticker}` }],
    preparePlace,
    afterPlaceOk,
    scheduleInstantExecution
  }));
  compositionRuntime.registerCardControl('option-close', () => ({
    placedStatusTitle: 'Close option',
    placedButton: { label: 'CLOSE' },
    closePlacedOrder,
    shouldKeepFullCardOnState: ({ state }) => state === 'placed',
    shouldEnableButtonOnState: ({ state }) => state === 'placed',
    shouldHideButtonsOnState: ({ state }) => state === 'profit',
    resetButtons
  }));
  const onCreateCard = () => 'created';
  const unregisterComposedBeforeConnect = compositionRuntime.registerCardType({
    type: 'option',
    view: 'option-view',
    controls: ['option-open', 'option-close'],
    legacyInstrumentTypes: ['OPT'],
    legacyCardTypes: ['option', 'optionstrat'],
    legacyRow: {
      title: ({ row }) => row.name,
      onCreateCard
    }
  });
  const disconnectComposition = compositionRuntime.connectLegacyOrderCardRenderer({
    registerInstrumentHandler(instrumentType, handler) {
      compositionCalls.push(['registerInstrumentHandler', instrumentType, handler]);
      return () => compositionCalls.push(['unregisterInstrumentHandler', instrumentType, handler]);
    },
    registerCardTypeHandler(cardType, handler) {
      compositionCalls.push(['registerCardTypeHandler', cardType, handler]);
      return () => compositionCalls.push(['unregisterCardTypeHandler', cardType, handler]);
    }
  });
  assert.strictEqual(compositionCalls[0][0], 'registerInstrumentHandler');
  assert.strictEqual(compositionCalls[0][1], 'OPT');
  assert.strictEqual(compositionCalls[1][0], 'registerCardTypeHandler');
  assert.strictEqual(compositionCalls[1][1], 'option');
  assert.strictEqual(compositionCalls[2][1], 'optionstrat');
  const composedHandler = compositionCalls[0][2];
  const composedRow = { ticker: 'SPY', name: 'Option spread' };
  assert.deepStrictEqual(composedHandler.createBody(composedRow, 'opt-1'), { row: composedRow, key: 'opt-1' });
  assert.deepStrictEqual(compositionCalls[3], ['view', composedRow, 'opt-1']);
  assert.deepStrictEqual(composedHandler.buttons(composedRow), [{ label: 'OPEN SPY' }]);
  assert.strictEqual(composedHandler.title({ row: composedRow }), 'Option spread');
  assert.strictEqual(composedHandler.onCreateCard, onCreateCard);
  assert.strictEqual(composedHandler.preparePlace, preparePlace);
  assert.strictEqual(composedHandler.afterPlaceOk, afterPlaceOk);
  assert.strictEqual(composedHandler.scheduleInstantExecution, scheduleInstantExecution);
  assert.strictEqual(composedHandler.placedStatusTitle, 'Close option');
  assert.deepStrictEqual(composedHandler.placedButton, { label: 'CLOSE' });
  assert.strictEqual(composedHandler.closePlacedOrder, closePlacedOrder);
  assert.strictEqual(composedHandler.shouldKeepFullCardOnState({ state: 'placed' }), true);
  assert.strictEqual(composedHandler.shouldEnableButtonOnState({ state: 'ready' }), false);
  assert.strictEqual(composedHandler.shouldHideButtonsOnState({ state: 'profit' }), true);
  assert.strictEqual(composedHandler.resetButtons, resetButtons);
  unregisterComposedBeforeConnect();
  const unregisterCount = compositionCalls.length;
  assert.strictEqual(compositionCalls.slice(-3).every(call => call[0].startsWith('unregister')), true);
  unregisterComposedBeforeConnect();
  assert.strictEqual(compositionCalls.length, unregisterCount);

  const unregisterComposedAfterConnect = compositionRuntime.registerCardType({
    type: 'crypto',
    legacyInstrumentTypes: ['CX'],
    legacyCardTypes: ['crypto']
  });
  assert.strictEqual(compositionCalls[unregisterCount][0], 'registerInstrumentHandler');
  assert.strictEqual(compositionCalls[unregisterCount][1], 'CX');
  assert.strictEqual(compositionCalls[unregisterCount + 1][0], 'registerCardTypeHandler');
  assert.strictEqual(compositionCalls[unregisterCount + 1][1], 'crypto');
  unregisterComposedAfterConnect();
  const afterConnectedUnregisterCount = compositionCalls.length;
  unregisterComposedAfterConnect();
  assert.strictEqual(compositionCalls.length, afterConnectedUnregisterCount);
  disconnectComposition();

  const legacyApi = {
    getCardState: key => (key === 'legacy' ? 'placed' : undefined),
    listPlacedOrders: () => [{ key: 'legacy', orderInfo: { ticket: 'l1' }, state: 'placed' }]
  };
  const facades = createOrderStateFacades(legacyApi, runtime.stateApi);
  const compat = createLegacyOrderStateCompatApi(facades);
  assert.strictEqual(compat.getCardState('legacy'), 'placed');
  assert.deepStrictEqual(compat.listPlacedOrders(), [{ key: 'legacy', orderInfo: { ticket: 'l1' }, state: 'placed' }]);

  console.log('cardRuntime tests passed');
}

run();
