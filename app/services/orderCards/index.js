// services/orderCards/index.js
// Factory for order card sources. Supports 'webhook' and 'file'.

const { OrderCardsSource } = require('./base');
const sources = {
  webhook: require('./webhook').WebhookOrderCardsSource,
  file: require('./file').FileOrderCardsSource,
};
const { createOrderCardsApplicationService } = require('./applicationService');

function createOrderCardService(opts = {}) {
  const type = opts.type || 'webhook';
  const Source = sources[type];
  if (!Source) throw new Error(`Unknown order card source: ${type}`);
  return new Source(opts);
}

module.exports = { createOrderCardService, createOrderCardsApplicationService, OrderCardsSource };
