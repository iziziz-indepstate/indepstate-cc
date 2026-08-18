const assert = require('assert');
const {
  createOptionStratPositionInputAdapter,
  cardTypeForInput,
  isOptionStratLike,
  positionIdSeedForInput
} = require('../app/services/optionstrat/positionInputAdapter');
const {
  orderPayloadToCreatePositionCommand,
  rowToCreatePositionCommand,
  registerPositionInputAdapter,
  createPositionApplicationService
} = require('../app/application/positions');
const { normalizeOrderPayload, registerOrderPayloadPolicy } = require('../app/application/execution');
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

assert.strictEqual(isOptionStratLike(optionRow), true);
assert.strictEqual(isOptionStratLike({ ticker: 'AAPL', instrumentType: 'EQ', provider: 'j2t' }), false);
assert.strictEqual(cardTypeForInput({ ticker: 'SPY', instrumentType: 'OPT' }), 'option');
assert.strictEqual(cardTypeForInput({ ticker: 'SPY', provider: 'optionstrat' }), 'option');
assert.strictEqual(cardTypeForInput({ ticker: 'SPY', event: 'optionstrat' }), 'option');
assert.strictEqual(cardTypeForInput({ ticker: 'SPY', instrumentType: 'EQ', provider: 'j2t' }), null);
assert.strictEqual(positionIdSeedForInput(optionRow), 'SPY:optionstrat:1');

assert.strictEqual(rowToCreatePositionCommand(optionRow).cardType, 'regular');
registerPositionInputAdapter(createOptionStratPositionInputAdapter());
const rowCreate = rowToCreatePositionCommand(optionRow);
assert.strictEqual(rowCreate.cardType, 'option');

const orderCreate = orderPayloadToCreatePositionCommand({
  ...optionRow,
  meta: { requestId: 'execution-req-1' }
}, 'optionstrat');
assert.strictEqual(orderCreate.positionId, rowCreate.positionId);
assert.strictEqual(orderCreate.cardType, 'option');

registerOrderPayloadPolicy(createOptionStratExecutionPolicy());
const normalizedOrderCreate = orderPayloadToCreatePositionCommand(normalizeOrderPayload({
  ...optionRow,
  cardType: 'option',
  meta: { requestId: 'execution-req-2' }
}), 'optionstrat');
assert.strictEqual(normalizedOrderCreate.positionId, rowCreate.positionId);

const positions = createPositionApplicationService();
positions.handle(rowCreate);
positions.createAndOpen(normalizedOrderCreate);
positions.recordFailed({
  positionId: normalizedOrderCreate.positionId,
  requestId: 'execution-req-2',
  provider: 'optionstrat',
  reason: 'adapter error'
});
const snapshot = positions.snapshot();
assert.strictEqual(snapshot.positions.length, 1);
assert.strictEqual(snapshot.positions[0].card.type, 'option');
assert.strictEqual(snapshot.positions[0].state, 'failed');

console.log('optionstratPositionAdapter tests passed');
