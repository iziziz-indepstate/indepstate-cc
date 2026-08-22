// services/orderCards/index.js
// Factory for order card sources.

const { OrderCardsSource } = require('./base');
const sources = {
  file: require('./file').FileOrderCardsSource
};
const { createOrderCardsApplicationService } = require('./applicationService');

function isOrderCardSourceType(type) {
  return Object.prototype.hasOwnProperty.call(sources, String(type || '').trim());
}

function createOrderCardService(opts = {}) {
  const type = String(opts.type || '').trim();
  const Source = sources[type];
  if (!Source) throw new Error(`Unknown order card source: ${type}`);
  return new Source(opts);
}

module.exports = {
  createOrderCardService,
  createOrderCardsApplicationService,
  isOrderCardSourceType,
  OrderCardsSource
};
