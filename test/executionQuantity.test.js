const assert = require('assert');
const {
  normalizeOrderQty,
  isValidOrderQty,
  resolveQuantityStep
} = require('../app/services/executionQuantity');

assert.strictEqual(resolveQuantityStep({}), 1);
assert.strictEqual(resolveQuantityStep({ minLot: 0.1 }), 0.1);
assert.strictEqual(resolveQuantityStep({ quantityStep: 0.01, minLot: 0.1 }), 0.01);

assert.strictEqual(normalizeOrderQty(0.6, 'EQ', {}), 0);
assert.strictEqual(isValidOrderQty(0.6, 'EQ', {}), false);

assert.strictEqual(normalizeOrderQty(0.6, 'EQ', { minLot: 0.1 }), 0.6);
assert.strictEqual(isValidOrderQty(0.6, 'EQ', { minLot: 0.1 }), true);

assert.strictEqual(normalizeOrderQty(1.9, 'EQ', {}), 1);
assert.strictEqual(isValidOrderQty(1, 'EQ', {}), true);

assert.strictEqual(normalizeOrderQty(0.25, 'FX', {}), 0.25);
assert.strictEqual(isValidOrderQty(0.25, 'FX', {}), true);

console.log('executionQuantity tests passed');
