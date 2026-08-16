const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function run() {
  const extensionFiles = [
    'app/services/levelOrder/manifest.js',
    'app/services/levelOrder/infrastructure/renderer/renderer.js',
    'app/services/optionstrat/manifest.js',
    'app/services/optionstrat/renderer.js'
  ];
  for (const file of extensionFiles) {
    const source = read(file);
    assert(!source.includes('legacyOrderStateApi'), `${file} must use narrow renderer state facades`);
  }
  for (const file of [
    'app/services/optionstrat/manifest.js',
    'app/services/optionstrat/renderer.js'
  ]) {
    const source = read(file);
    assert(!source.includes('orderCardsState'), `${file} must use cardRuntime legacy row facade`);
    assert(!source.includes('setLegacyOrderCardState'), `${file} must not use the legacy row visual setter`);
  }

  const rendererSource = read('app/renderer.js');
  assert(!rendererSource.includes("services/orderCards/rendererStateBridge"), 'renderer must not import generic state from orderCards');
  for (const name of ['pendingRequestLabels', 'placedOrderLookup', 'cardVisualState', 'ticketBinding']) {
    assert(rendererSource.includes(name), `renderer context should expose ${name}`);
  }

  const orderCardsManifest = read('app/services/orderCards/manifest.js');
  assert(!orderCardsManifest.includes("./rendererStateBridge"), 'orderCards must consume shell-owned card runtime state facades');
  for (const name of [
    'context.orderCardsState',
    'context.setLegacyOrderCardState',
    'context.orderCardHandlerFor'
  ]) {
    assert(!orderCardsManifest.includes(name), `orderCards must not publish ${name} in renderer context`);
  }

  console.log('rendererExtensionStateBridge tests passed');
}

run();
