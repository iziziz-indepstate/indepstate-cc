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

  const rendererSource = read('app/renderer.js');
  for (const name of ['pendingRequestLabels', 'placedOrderLookup', 'cardVisualState', 'ticketBinding']) {
    assert(rendererSource.includes(name), `renderer context should expose ${name}`);
  }

  console.log('rendererExtensionStateBridge tests passed');
}

run();
