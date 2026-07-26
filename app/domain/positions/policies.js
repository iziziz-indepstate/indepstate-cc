const { IntegrationCommand, PositionEvent } = require('./types');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class OpeningPolicy {
  constructor(kind, config = {}) {
    this.kind = kind || 'regular';
    this.config = clone(config) || {};
  }

  buildOpenRequest(_position, _command) {
    throw new Error('OpeningPolicy.buildOpenRequest is not implemented');
  }

  snapshot() {
    return { kind: this.kind, config: clone(this.config) || {} };
  }
}

class RegularOpeningPolicy extends OpeningPolicy {
  constructor(config = {}) {
    super('regular', config);
  }

  buildOpenRequest(position, command = {}) {
    const payload = clone(command.payload || position.executionIntent || position.source) || {};
    return {
      events: [{
        type: PositionEvent.EXECUTION_REQUESTED,
        positionId: position.id,
        provider: position.provider,
        payload
      }],
      integrationCommands: [{
        type: IntegrationCommand.PLACE_ORDER,
        positionId: position.id,
        provider: position.provider,
        payload
      }]
    };
  }
}

class PendingOpeningPolicy extends OpeningPolicy {
  constructor(config = {}) {
    super(config.strategy ? 'pending' : 'pending', config);
  }

  buildOpenRequest(position, command = {}) {
    const payload = clone(command.payload || position.executionIntent || position.source) || {};
    if (this.config.strategy && payload.strategy == null) payload.strategy = this.config.strategy;
    return {
      events: [{
        type: PositionEvent.PENDING_OPEN_REQUESTED,
        positionId: position.id,
        provider: position.provider,
        payload
      }],
      integrationCommands: [{
        type: IntegrationCommand.PLACE_PENDING_ORDER,
        positionId: position.id,
        provider: position.provider,
        payload
      }]
    };
  }
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
        type: PositionEvent.LEVEL_CHILDREN_REQUESTED,
        positionId: position.id,
        provider: position.provider,
        expectedChildren: children.length,
        payload,
        children
      }],
      integrationCommands: [{
        type: IntegrationCommand.PLACE_LEVEL_CHILDREN,
        positionId: position.id,
        provider: position.provider,
        payload,
        children
      }]
    };
  }
}

function createOpeningPolicy(spec = {}) {
  if (spec instanceof OpeningPolicy) return spec;
  const kind = String(spec.kind || spec.type || 'regular');
  const config = spec.config || spec;
  if (kind === 'levelOrder') return new LevelOrderOpeningPolicy(config);
  if (kind === 'pending' || kind === 'consolidation' || kind === 'falseBreak' || kind === 'limitByCurrent') {
    return new PendingOpeningPolicy({ ...config, strategy: config.strategy || (kind === 'pending' ? undefined : kind) });
  }
  return new RegularOpeningPolicy(config);
}

class ClosingPolicy {
  constructor(kind = 'regular', config = {}) {
    this.kind = kind;
    this.config = clone(config) || {};
  }

  buildCloseRequest(position, command = {}) {
    const payload = clone(command.payload || {}) || {};
    const commandType = position.state === 'placed'
      ? IntegrationCommand.CANCEL_ORDER
      : IntegrationCommand.CLOSE_POSITION;
    return {
      events: [{
        type: PositionEvent.CLOSE_REQUESTED,
        positionId: position.id,
        provider: position.provider,
        ticket: command.ticket || position.primaryTicket,
        payload
      }],
      integrationCommands: [{
        type: commandType,
        positionId: position.id,
        provider: position.provider,
        ticket: command.ticket || position.primaryTicket,
        payload
      }]
    };
  }

  snapshot() {
    return { kind: this.kind, config: clone(this.config) || {} };
  }
}

function createClosingPolicy(spec = {}) {
  if (spec instanceof ClosingPolicy) return spec;
  return new ClosingPolicy(spec.kind || spec.type || 'regular', spec.config || spec);
}

module.exports = {
  OpeningPolicy,
  RegularOpeningPolicy,
  PendingOpeningPolicy,
  LevelOrderOpeningPolicy,
  ClosingPolicy,
  createOpeningPolicy,
  createClosingPolicy
};
