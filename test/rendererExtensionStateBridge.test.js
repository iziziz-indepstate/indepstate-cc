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
  const optionStratManifest = read('app/services/optionstrat/manifest.js');
  assert(!optionStratManifest.includes('orderCardsState'), 'optionstrat manifest must use cardRuntime legacy row facade');
  assert(!optionStratManifest.includes('setLegacyOrderCardState'), 'optionstrat manifest must not close over legacy row visual setter');

  const rendererSource = read('app/renderer.js');
  assert(!rendererSource.includes("services/orderCards/rendererStateBridge"), 'renderer must not import generic state from orderCards');
  for (const name of ['pendingRequestLabels', 'placedOrderLookup', 'cardVisualState', 'ticketBinding']) {
    assert(rendererSource.includes(name), `renderer context should expose ${name}`);
  }

  const orderCardsManifest = read('app/services/orderCards/manifest.js');
  assert(!orderCardsManifest.includes("./rendererStateBridge"), 'orderCards must consume shell-owned card runtime state facades');

  console.log('rendererExtensionStateBridge tests passed');
}

run();
