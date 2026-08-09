const assert = require('assert');
const { createPositionsRenderer } = require('../app/services/positions/renderer');

async function run() {
  const handlers = {};
  let resolveInitialList;
  let renderCount = 0;
  const ipcRenderer = {
    on(channel, handler) {
      handlers[channel] = handler;
    },
    invoke(channel) {
      if (channel === 'positions:list') {
        return new Promise(resolve => {
          resolveInitialList = resolve;
        });
      }
      return Promise.resolve([]);
    }
  };

  const renderer = createPositionsRenderer({
    ipcRenderer,
    el: () => ({ appendChild() {}, setAttribute() {} }),
    createPositionDataGrid: () => ({}),
    createPositionActions: () => ({}),
    positionKey: position => `position|${position.id}`,
    positionCardTitle: position => position.ticker,
    render: () => { renderCount += 1; },
    positionCardRenderers: {
      regular: () => ({ classList: { contains: () => true } })
    }
  });

  renderer.mount();
  handlers['positions:changed'](null, {
    event: { type: 'position.created' },
    position: {
      id: 'pos-live',
      ticker: 'ADAUSDT.cfd',
      card: { type: 'regular', data: { ticker: 'ADAUSDT.cfd' } }
    }
  });
  assert.strictEqual(renderer.positionsById.has('pos-live'), true);

  resolveInitialList([]);
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(renderer.positionsById.has('pos-live'), true);
  assert.strictEqual(renderCount, 2);

  console.log('positionsRendererInitialListRace tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
