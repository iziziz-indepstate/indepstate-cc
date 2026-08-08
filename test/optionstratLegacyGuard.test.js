const assert = require('assert');
const {
  createOptionStratLegacyGuard,
  cardTypeForLegacy,
  isOptionStratLegacyRow,
  isOptionStratPosition,
  positionIdSeedForLegacy,
  shouldRemoveLegacyRowForPosition
} = require('../app/services/optionstrat/legacyGuard');
const {
  legacyOrderPayloadToCreateCommand,
  legacyRowToCreateCommand,
  registerLegacyPositionGuard,
  createPositionApplicationService
} = require('../app/application/positions');
const {
  normalizeOrderPayload,
  registerOrderPayloadPolicy
} = require('../app/application/execution');
const { createOptionStratExecutionPolicy } = require('../app/services/optionstrat/executionPolicy');

const optionRow = {
  instrumentType: 'OPT',
  provider: 'optionstrat',
  event: 'optionstrat',
  ticker: 'SPY',
  symbol: 'SPY',
  time: 1,
  requestId: 'req-1',
  name: 'LCS 755/756',
  legs: [
    { option: 'CALL', side: 'buy', strike: 755, quantity: 1 },
    { option: 'CALL', side: 'sell', strike: 756, quantity: 1 }
  ]
};

const optionPosition = {
  id: 'pos-1',
  state: 'placed',
  instrumentType: 'OPT',
  provider: 'optionstrat',
  ticker: 'SPY',
  source: {
    ...optionRow,
    cardType: 'option'
  },
  card: {
    type: 'option',
    data: {
      provider: 'optionstrat',
      ticker: 'SPY',
      instrumentType: 'OPT'
    }
  }
};

assert.strictEqual(isOptionStratLegacyRow(optionRow), true);
assert.strictEqual(isOptionStratLegacyRow({ ticker: 'AAPL', instrumentType: 'EQ', provider: 'j2t' }), false);
assert.strictEqual(isOptionStratLegacyRow({ ticker: 'BTCUSDT', instrumentType: 'CX', provider: 'ccxt' }), false);
assert.strictEqual(cardTypeForLegacy({ ticker: 'SPY', instrumentType: 'OPT' }), 'option');
assert.strictEqual(cardTypeForLegacy({ ticker: 'SPY', provider: 'optionstrat' }), 'option');
assert.strictEqual(cardTypeForLegacy({ ticker: 'SPY', event: 'optionstrat' }), 'option');
assert.strictEqual(cardTypeForLegacy({ ticker: 'SPY', cardType: 'optionstrat' }), 'option');
assert.strictEqual(cardTypeForLegacy({ ticker: 'SPY', instrumentType: 'EQ', provider: 'j2t' }), null);
assert.strictEqual(cardTypeForLegacy({ ticker: 'BTCUSDT', instrumentType: 'CX', provider: 'ccxt' }), null);
assert.strictEqual(isOptionStratPosition(optionPosition), true);
assert.strictEqual(shouldRemoveLegacyRowForPosition(optionPosition, optionRow), true);
assert.strictEqual(shouldRemoveLegacyRowForPosition({
  ...optionPosition,
  source: { ...optionPosition.source, requestId: 'different', time: 2 }
}, optionRow), true);
assert.strictEqual(shouldRemoveLegacyRowForPosition({
  ...optionPosition,
  ticker: 'QQQ',
  source: { ...optionPosition.source, ticker: 'QQQ', symbol: 'QQQ', requestId: 'different', time: 2, legs: [] },
  card: { ...optionPosition.card, data: { ...optionPosition.card.data, ticker: 'QQQ' } }
}, optionRow), false);

const guard = createOptionStratLegacyGuard();
assert.strictEqual(guard.shouldHidePositionSnapshot(optionPosition), false);
assert.strictEqual(guard.shouldHidePositionSnapshot({
  ...optionPosition,
  state: 'draft',
  card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'draft' } }
}, { rows: [optionRow] }), true);
assert.strictEqual(guard.shouldRemoveLegacyRowForPosition({
  ...optionPosition,
  state: 'draft',
  card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'draft' } }
}, optionRow), false);
assert.strictEqual(guard.shouldHidePositionSnapshot({
  ...optionPosition,
  state: 'failed',
  card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'failed' } }
}, { rows: [optionRow] }), true);
assert.strictEqual(guard.shouldRemoveLegacyRowForPosition({
  ...optionPosition,
  state: 'failed',
  card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'failed' } }
}, optionRow), false);
assert.strictEqual(guard.shouldResetLegacyRowForPosition({
  ...optionPosition,
  state: 'failed',
  card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'failed' } }
}, optionRow), true);
assert.strictEqual(guard.shouldRemovePositionSnapshotForLegacyRowRemoval(optionRow, {
  ...optionPosition,
  state: 'failed',
  card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'failed' } }
}), true);
assert.strictEqual(guard.shouldRemovePositionSnapshotForLegacyRowRemoval(optionRow, optionPosition), false);
assert.strictEqual(guard.shouldIgnoreLegacyRowForExistingPosition(optionRow, {
  positions: [{
    ...optionPosition,
    state: 'draft',
    card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'draft' } }
  }]
}), false);
assert.strictEqual(guard.shouldIgnoreLegacyRowForExistingPosition(optionRow, {
  positions: [{
    ...optionPosition,
    state: 'failed',
    card: { ...optionPosition.card, data: { ...optionPosition.card.data, state: 'failed' } }
  }]
}), false);
assert.strictEqual(guard.shouldIgnoreLegacyRowForExistingPosition(optionRow, { positions: [optionPosition] }), true);
assert.strictEqual(guard.shouldIgnoreLegacyExecutionEvent({
  reqId: 'req-1',
  provider: 'optionstrat',
  order: optionRow
}, { positions: [] }), false);
assert.strictEqual(guard.shouldIgnoreLegacyExecutionEvent({
  reqId: 'req-1',
  provider: 'optionstrat',
  order: optionRow
}, { positions: [optionPosition] }), true);
assert.strictEqual(guard.shouldIgnoreLegacyPositionEvent({
  ticket: 'ticket-1',
  provider: 'optionstrat',
  origOrder: optionRow
}, { positions: [optionPosition] }), true);

assert.strictEqual(positionIdSeedForLegacy(optionRow), 'SPY:optionstrat:1');
assert.strictEqual(legacyRowToCreateCommand(optionRow).cardType, 'regular');
registerLegacyPositionGuard(guard);
const rowCreate = legacyRowToCreateCommand(optionRow);
assert.strictEqual(rowCreate.cardType, 'option');
const orderCreate = legacyOrderPayloadToCreateCommand({
  ...optionRow,
  cardType: 'option',
  meta: { requestId: 'execution-req-1' }
}, 'optionstrat');
assert.strictEqual(orderCreate.positionId, rowCreate.positionId);
assert.strictEqual(orderCreate.cardType, 'option');

const inferredOrderCreate = legacyOrderPayloadToCreateCommand({
  ...optionRow,
  meta: { requestId: 'execution-req-inferred' }
}, 'optionstrat');
assert.strictEqual(inferredOrderCreate.cardType, 'option');

registerOrderPayloadPolicy(createOptionStratExecutionPolicy());
const normalizedOrderCreate = legacyOrderPayloadToCreateCommand(normalizeOrderPayload({
  ...optionRow,
  cardType: 'option',
  meta: { requestId: 'execution-req-2' }
}), 'optionstrat');
assert.strictEqual(normalizedOrderCreate.positionId, rowCreate.positionId);
assert.strictEqual(normalizedOrderCreate.cardType, 'option');

const positions = createPositionApplicationService();
positions.handle(rowCreate);
positions.createAndOpen(normalizedOrderCreate);
let snapshot = positions.snapshot();
assert.strictEqual(snapshot.positions.length, 1);
assert.strictEqual(snapshot.positions[0].id, rowCreate.positionId);
positions.recordFailed({
  positionId: normalizedOrderCreate.positionId,
  requestId: 'execution-req-2',
  provider: 'optionstrat',
  reason: 'adapter error'
});
snapshot = positions.snapshot();
assert.strictEqual(snapshot.positions.length, 1);
assert.strictEqual(snapshot.positions[0].card.type, 'option');
assert.strictEqual(snapshot.positions[0].state, 'failed');

console.log('optionstratLegacyGuard tests passed');
