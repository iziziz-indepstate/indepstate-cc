const assert = require('assert');
const {
  normalizeOrderPayload,
  validateOrder,
  registerOrderPayloadPolicy,
  _resetOrderPayloadPoliciesForTest
} = require('../app/application/execution');
const { createOptionStratExecutionPolicy } = require('../app/services/optionstrat/executionPolicy');

_resetOrderPayloadPoliciesForTest();
const servicesApi = require('../app/services/servicesApi');
assert.strictEqual(typeof servicesApi.executionPayloadPolicies?.register, 'function');
assert.strictEqual(Array.isArray(servicesApi.executionPayloadPolicies?.policies), true);

const optionPayload = {
  instrumentType: 'OPT',
  provider: 'optionstrat',
  event: 'optionstrat',
  ticker: 'SPY',
  cardType: 'option',
  name: 'LCS',
  expiration: 7,
  legs: [{ option: 'CALL', side: 'buy', strike: 755, quantity: 1 }]
};

const withoutPolicy = normalizeOrderPayload(optionPayload);
assert.strictEqual(withoutPolicy.symbol, 'SPY');
assert.strictEqual(withoutPolicy.ticker, undefined);
assert.strictEqual(withoutPolicy.type, undefined);
assert.strictEqual(withoutPolicy.legs, undefined);
assert.notStrictEqual(validateOrder(withoutPolicy).reason, 'OPT: ticker and legs required');

const unregister = registerOrderPayloadPolicy(createOptionStratExecutionPolicy());
const normalized = normalizeOrderPayload(optionPayload);
assert.strictEqual(normalized.instrumentType, 'OPT');
assert.strictEqual(normalized.symbol, 'SPY');
assert.strictEqual(normalized.ticker, 'SPY');
assert.strictEqual(normalized.provider, 'optionstrat');
assert.strictEqual(normalized.event, 'optionstrat');
assert.strictEqual(normalized.cardType, 'option');
assert.strictEqual(normalized.name, 'LCS');
assert.strictEqual(normalized.expirationDte, 7);
assert.deepStrictEqual(normalized.legs, optionPayload.legs);
assert.strictEqual(normalized.side, 'OPEN');
assert.strictEqual(normalized.type, 'strategy');
assert.strictEqual(normalized.qty, 1);
assert.strictEqual(normalized.price, 1);
assert.strictEqual(normalized.sl, 1);
assert.deepStrictEqual(validateOrder(normalized), { ok: true });

const noLegs = normalizeOrderPayload({ instrumentType: 'OPT', ticker: 'SPY' });
assert.deepStrictEqual(validateOrder(noLegs), {
  ok: false,
  reason: 'OPT: ticker and legs required'
});

unregister();

console.log('orderPayload tests passed');
