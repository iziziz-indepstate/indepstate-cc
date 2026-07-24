const assert = require('assert');
const {
  levelOrderRetryStopMatches,
  collectRetryStopEntries,
  getRetryStopParentIds
} = require('../app/services/levelOrder/retryStop');

const pendingIndex = new Map([
  ['cid-1', {
    reqId: 'parent_1',
    cid: 'cid-1',
    order: { meta: { parentRequestId: 'parent', cid: 'cid-1' } }
  }],
  ['cid-2', {
    reqId: 'parent_2',
    cid: 'cid-2',
    order: { meta: { parentRequestId: 'parent', cid: 'cid-2' } }
  }],
  ['cid-other', {
    reqId: 'other_1',
    cid: 'cid-other',
    order: { meta: { parentRequestId: 'other', cid: 'cid-other' } }
  }]
]);

assert.strictEqual(levelOrderRetryStopMatches('parent', 'cid-1', pendingIndex.get('cid-1')), true);
assert.strictEqual(levelOrderRetryStopMatches('parent_1', 'cid-1', pendingIndex.get('cid-1')), true);
assert.strictEqual(levelOrderRetryStopMatches('cid-1', 'cid-1', pendingIndex.get('cid-1')), true);
assert.strictEqual(levelOrderRetryStopMatches('missing', 'cid-1', pendingIndex.get('cid-1')), false);

let matches = collectRetryStopEntries(pendingIndex, 'parent');
assert.deepStrictEqual(matches.map(m => m.pendingId), ['cid-1', 'cid-2']);
assert.deepStrictEqual(getRetryStopParentIds('parent', matches), ['parent']);

matches = collectRetryStopEntries(pendingIndex, 'parent_1');
assert.deepStrictEqual(matches.map(m => m.pendingId), ['cid-1']);
assert.deepStrictEqual(getRetryStopParentIds('parent_1', matches), ['parent_1', 'parent']);

matches = collectRetryStopEntries(pendingIndex, 'cid-2');
assert.deepStrictEqual(matches.map(m => m.pendingId), ['cid-2']);

console.log('levelOrderRetryStop tests passed');
