const events = require('../events');
const { createPositionApplicationService } = require('../../application/positions');

function initService(servicesApi = {}) {
  const service = createPositionApplicationService({ eventBus: events });
  servicesApi.positions = service;
  return service;
}

module.exports = { initService };
