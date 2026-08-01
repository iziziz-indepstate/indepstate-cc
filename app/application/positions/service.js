const { EventEmitter } = require('events');
const {
  PositionAggregate,
  PositionCommand,
  PositionEvent
} = require('../../domain/positions');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class InMemoryPositionRepository {
  constructor(initial = []) {
    this.positions = new Map();
    for (const snapshot of initial || []) {
      if (snapshot?.id) this.positions.set(snapshot.id, clone(snapshot));
    }
  }

  get(id) {
    const snapshot = this.positions.get(id);
    return snapshot ? new PositionAggregate(snapshot) : null;
  }

  save(position) {
    const snapshot = typeof position.snapshot === 'function' ? position.snapshot() : clone(position);
    this.positions.set(snapshot.id, clone(snapshot));
    return snapshot;
  }

  delete(id) {
    return this.positions.delete(id);
  }

  findByTicket(ticket, provider) {
    const normalizedTicket = String(ticket || '').trim();
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!normalizedTicket) return null;
    for (const snapshot of this.positions.values()) {
      if (normalizedProvider && String(snapshot.provider || '').toLowerCase() !== normalizedProvider) continue;
      const tickets = Array.isArray(snapshot.tickets) ? snapshot.tickets : [];
      if (tickets.map(String).includes(normalizedTicket) || String(snapshot.primaryTicket || '') === normalizedTicket) {
        return new PositionAggregate(snapshot);
      }
    }
    return null;
  }

  findByRequestId(requestId) {
    const id = String(requestId || '').trim();
    if (!id) return null;
    for (const snapshot of this.positions.values()) {
      if (snapshot.executionIntent?.meta?.requestId === id || snapshot.source?.meta?.requestId === id) {
        return new PositionAggregate(snapshot);
      }
      for (const child of snapshot.children || []) {
        if (child.requestId === id || child.childRequestId === id) return new PositionAggregate(snapshot);
      }
    }
    return null;
  }

  list() {
    return Array.from(this.positions.values()).map(clone);
  }
}

class PositionApplicationService {
  constructor({ repository, eventBus, executor, clock } = {}) {
    this.repository = repository || new InMemoryPositionRepository();
    this.eventBus = eventBus;
    this.executor = executor || null;
    this.clock = clock || (() => Date.now());
    this.events = new EventEmitter();
  }

  handle(command = {}) {
    const normalized = { ...command, time: Number.isFinite(command.time) ? command.time : this.clock() };
    let aggregate;
    if (normalized.type === PositionCommand.CREATE) {
      aggregate = PositionAggregate.create(normalized);
    } else {
      aggregate = this.repository.get(normalized.positionId || normalized.id);
      if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    }

    const result = aggregate.handle(normalized);
    const snapshot = this.repository.save(aggregate);
    this.#publish(result.events, result.integrationCommands, snapshot);
    if ((result.events || []).some(event => event.type === PositionEvent.REMOVED)) {
      this.repository.delete(snapshot.id);
    }
    return { ok: true, position: snapshot, events: result.events, integrationCommands: result.integrationCommands };
  }

  remove({ positionId, id, reason } = {}) {
    return this.handle({
      type: PositionCommand.REMOVE,
      positionId: positionId || id,
      reason
    });
  }

  createAndOpen(command = {}) {
    const createResult = this.handle({ ...command, type: PositionCommand.CREATE });
    if (!createResult.ok) return createResult;
    const openResult = this.handle({
      ...command,
      type: PositionCommand.OPEN,
      positionId: createResult.position.id,
      payload: command.payload || command.executionIntent || command.source
    });
    return {
      ok: openResult.ok,
      position: openResult.position,
      events: [...createResult.events, ...openResult.events],
      integrationCommands: openResult.integrationCommands
    };
  }

  recordPlaced({ positionId, requestId, ticket, providerOrderId, provider, result, payload } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(requestId) || this.repository.findByTicket(ticket || providerOrderId, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_PLACED,
      positionId: aggregate.id,
      requestId,
      ticket: ticket || providerOrderId || result?.providerOrderId,
      providerOrderId: providerOrderId || result?.providerOrderId,
      provider: provider || result?.provider,
      payload
    });
  }

  recordOpened({ positionId, requestId, ticket, provider, order, origOrder } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(requestId || origOrder?.meta?.requestId) || this.repository.findByTicket(ticket, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_OPENED,
      positionId: aggregate.id,
      requestId: requestId || origOrder?.meta?.requestId,
      ticket,
      provider,
      payload: order,
      origOrder
    });
  }

  recordClosed({ positionId, ticket, provider, trade, profit, final = true } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByTicket(ticket, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_CLOSED,
      positionId: aggregate.id,
      ticket,
      provider,
      trade,
      profit,
      final
    });
  }

  recordCancelled({ positionId, ticket, provider } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByTicket(ticket, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_CANCELLED,
      positionId: aggregate.id,
      ticket,
      provider
    });
  }

  recordRejected({ positionId, requestId, provider, reason, result } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(requestId);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_REJECTED,
      positionId: aggregate.id,
      provider,
      reason: reason || result?.reason
    });
  }

  recordFailed({ positionId, requestId, provider, reason } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(requestId);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_FAILED,
      positionId: aggregate.id,
      provider,
      reason
    });
  }

  snapshot() {
    return { positions: this.repository.list() };
  }

  #publish(events, integrationCommands, snapshot) {
    for (const event of events || []) {
      this.events.emit(event.type, event, snapshot);
      this.events.emit('event', event, snapshot);
      if (this.eventBus && typeof this.eventBus.emit === 'function') {
        this.eventBus.emit(event.type, event);
      }
    }
    for (const command of integrationCommands || []) {
      this.events.emit('integrationCommand', command, snapshot);
      if (this.executor && typeof this.executor.execute === 'function') {
        Promise.resolve(this.executor.execute(command, snapshot)).catch(err => {
          this.events.emit(PositionEvent.FAILED, {
            type: PositionEvent.FAILED,
            positionId: snapshot.id,
            reason: err?.message || String(err)
          }, snapshot);
        });
      }
    }
  }
}

function createPositionApplicationService(opts = {}) {
  return new PositionApplicationService(opts);
}

module.exports = {
  InMemoryPositionRepository,
  PositionApplicationService,
  createPositionApplicationService
};
