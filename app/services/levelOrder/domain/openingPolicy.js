const {
  OpeningPolicy
} = require('../../../domain/positions');
const {
  LevelOrderIntegrationCommand,
  LevelOrderPositionEvent
} = require('./types');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class LevelOrderOpeningPolicy extends OpeningPolicy {
  constructor(config = {}) {
    super('levelOrder', config);
  }

  buildOpenRequest(position, command = {}) {
    const children = Array.isArray(command.children)
      ? clone(command.children)
      : Array.isArray(this.config.children)
        ? clone(this.config.children)
        : [];
    const payload = clone(command.payload || position.executionIntent || position.source) || {};
    return {
      events: [{
        type: LevelOrderPositionEvent.CHILDREN_REQUESTED,
        positionId: position.id,
        provider: position.provider,
        expectedChildren: children.length,
        payload,
        children
      }],
      integrationCommands: [{
        type: LevelOrderIntegrationCommand.PLACE_CHILDREN,
        positionId: position.id,
        provider: position.provider,
        payload,
        children
      }]
    };
  }
}

function createLevelOrderOpeningPolicy(config = {}) {
  return new LevelOrderOpeningPolicy(config);
}

module.exports = {
  LevelOrderOpeningPolicy,
  createLevelOrderOpeningPolicy
};
