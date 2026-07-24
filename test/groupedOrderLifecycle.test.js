const assert = require('assert');
const {
  GroupedOrderLifecycleRegistry
} = require('../app/services/brokerage/comps/groupedOrderLifecycle');

const registry = new GroupedOrderLifecycleRegistry();

registry.registerTicket('group-1', {
  provider: 'provider-a',
  symbol: 'TEST',
  expectedCount: 2,
  ticket: 'ticket-1',
  cid: 'cid-1',
  qty: 1
});
registry.markOpened('group-1', {
  ticket: 'ticket-1',
  expectedCount: 2,
  qty: 1
});

assert.strictEqual(registry.takeReadySnapshot('group-1'), null);
assert.deepStrictEqual(registry.getUnopenedTickets('group-1'), []);

registry.registerTicket('group-1', {
  ticket: 'ticket-2',
  expectedCount: 2,
  cid: 'cid-2',
  qty: 2
});
assert.deepStrictEqual(registry.getUnopenedTickets('group-1'), ['ticket-2']);

registry.markOpened('group-1', {
  ticket: 'ticket-2',
  expectedCount: 2,
  qty: 2
});

const ready = registry.takeReadySnapshot('group-1');
assert.deepStrictEqual(ready, {
  id: 'group-1',
  provider: 'provider-a',
  symbol: 'TEST',
  expectedCount: 2,
  expectedQty: 3,
  foundQty: 3,
  tickets: ['ticket-1', 'ticket-2'],
  openedTickets: ['ticket-1', 'ticket-2'],
  cids: ['cid-1', 'cid-2']
});
assert.strictEqual(registry.takeReadySnapshot('group-1'), null);
assert.strictEqual(registry.getByTicket('ticket-2', 'provider-a').id, 'group-1');

registry.removeTicket('ticket-1', 'provider-a');
assert.strictEqual(registry.getByTicket('ticket-1', 'provider-a'), undefined);
assert.strictEqual(registry.get('group-1').tickets.has('ticket-1'), false);

registry.removeTicket('ticket-2', 'provider-a');
assert.strictEqual(registry.get('group-1'), undefined);

const raceRegistry = new GroupedOrderLifecycleRegistry();
raceRegistry.markOpened('group-race', {
  provider: 'provider-b',
  symbol: 'RACE',
  expectedCount: 2,
  ticket: 'ticket-a',
  cid: 'cid-a',
  qty: 4
});
raceRegistry.markOpened('group-race', {
  expectedCount: 2,
  ticket: 'ticket-b',
  cid: 'cid-b',
  qty: 6
});
assert.strictEqual(raceRegistry.takeReadySnapshot('group-race').expectedQty, 10);

const collisionRegistry = new GroupedOrderLifecycleRegistry();
collisionRegistry.registerTicket('provider-a-group', { provider: 'provider-a', ticket: '42' });
collisionRegistry.registerTicket('provider-b-group', { provider: 'provider-b', ticket: '42' });
collisionRegistry.removeTicket('42', 'provider-a');
assert.strictEqual(collisionRegistry.get('provider-a-group'), undefined);
assert.strictEqual(collisionRegistry.getByTicket('42', 'provider-b').id, 'provider-b-group');

console.log('groupedOrderLifecycle tests passed');
