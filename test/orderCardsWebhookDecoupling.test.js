const assert = require('assert');
const fs = require('fs');
const path = require('path');

function collectFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function run() {
  const orderCardsDir = path.join(__dirname, '..', 'app', 'services', 'orderCards');
  assert.strictEqual(
    fs.existsSync(path.join(orderCardsDir, 'webhook.js')),
    false,
    'orderCards must not contain a webhook source implementation'
  );

  const forbidden = ['../webhooks', 'parseWebhook', 'WebhookOrderCardsSource'];
  for (const file of collectFiles(orderCardsDir)) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const token of forbidden) {
      assert.strictEqual(
        contents.includes(token),
        false,
        `${path.relative(orderCardsDir, file)} must not contain ${token}`
      );
    }
  }

  const { createOrderCardService, isOrderCardSourceType } = require('../app/services/orderCards');
  assert.strictEqual(isOrderCardSourceType('webhook'), false);
  assert.throws(
    () => createOrderCardService({ type: 'webhook' }),
    /Unknown order card source: webhook/
  );

  console.log('orderCardsWebhookDecoupling tests passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
