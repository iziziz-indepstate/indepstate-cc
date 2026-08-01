const { EventEmitter } = require('events');
const {
  PositionAggregate,
  PositionCommand,
  PositionEvent,
  createPositionBehaviorRegistry,
  createOpeningPolicyRegistry
} = require('../../domain/positions');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class InMemoryPositionRepository {
  constructor(initial = [], opts = {}) {
    this.behaviorRegistry = opts.behaviorRegistry;
    this.openingPolicyRegistry = opts.openingPolicyRegistry;
    this.positions = new Map();
    for (const snapshot of initial || []) {
      if (snapshot?.id) this.positions.set(snapshot.id, clone(snapshot));
    }
  }

  get(id) {
    const snapshot = this.positions.get(id);
    return snapshot ? new PositionAggregate(snapshot, {
      behaviorRegistry: this.behaviorRegistry,
      openingPolicyRegistry: this.openingPolicyRegistry
    }) : null;
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
        return new PositionAggregate(snapshot, {
          behaviorRegistry: this.behaviorRegistry,
          openingPolicyRegistry: this.openingPolicyRegistry
        });
      }
    }
    return null;
  }

  findByRequestId(requestId) {
    const id = String(requestId || '').trim();
    if (!id) return null;
    for (const snapshot of this.positions.values()) {
      if (
        snapshot.executionIntent?.meta?.requestId === id
        || snapshot.executionIntent?.requestId === id
        || snapshot.source?.meta?.requestId === id
        || snapshot.source?.requestId === id
      ) {
        return new PositionAggregate(snapshot, {
          behaviorRegistry: this.behaviorRegistry,
          openingPolicyRegistry: this.openingPolicyRegistry
        });
      }
      for (const child of snapshot.children || []) {
        if (
          child.requestId === id
          || child.childRequestId === id
          || child.parentRequestId === id
          || child.pendingId === id
          || child.cid === id
          || child.ticket === id
          || child.providerOrderId === id
        ) return new PositionAggregate(snapshot, {
          behaviorRegistry: this.behaviorRegistry,
          openingPolicyRegistry: this.openingPolicyRegistry
        });
      }
    }
    return null;
  }

  list() {
    return Array.from(this.positions.values())
      .map(snapshot => new PositionAggregate(snapshot, {
        behaviorRegistry: this.behaviorRegistry,
        openingPolicyRegistry: this.openingPolicyRegistry
      }).snapshot());
  }
}

class PositionApplicationService {
  constructor({ repository, eventBus, executor, clock, behaviorRegistry, positionBehaviors, openingPolicyRegistry, openingPolicies } = {}) {
    this.behaviorRegistry = behaviorRegistry || createPositionBehaviorRegistry(positionBehaviors || []);
    this.openingPolicyRegistry = openingPolicyRegistry || createOpeningPolicyRegistry(openingPolicies || []);
    this.repository = repository || new InMemoryPositionRepository([], {
      behaviorRegistry: this.behaviorRegistry,
      openingPolicyRegistry: this.openingPolicyRegistry
    });
    if (repository && !repository.behaviorRegistry) repository.behaviorRegistry = this.behaviorRegistry;
    if (repository && !repository.openingPolicyRegistry) repository.openingPolicyRegistry = this.openingPolicyRegistry;
    this.eventBus = eventBus;
    this.executor = executor || null;
    this.clock = clock || (() => Date.now());
    this.events = new EventEmitter();
  }

  registerBehavior(behavior) {
    return this.behaviorRegistry.register(behavior);
  }

  registerOpeningPolicy(kind, factory) {
    return this.openingPolicyRegistry.register(kind, factory);
  }

  handle(command = {}) {
    const normalized = { ...command, time: Number.isFinite(command.time) ? command.time : this.clock() };
    let aggregate;
    if (normalized.type === PositionCommand.CREATE) {
      aggregate = PositionAggregate.create(normalized, {
        behaviorRegistry: this.behaviorRegistry,
        openingPolicyRegistry: this.openingPolicyRegistry
      });
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

  recordPlaced({ positionId, requestId, parentRequestId, childIndex, childCount, pendingId, cid, ticket, providerOrderId, provider, result, payload, order, origOrder, reason } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(parentRequestId || requestId) || this.repository.findByTicket(ticket || providerOrderId, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_PLACED,
      positionId: aggregate.id,
      requestId,
      parentRequestId,
      childIndex,
      childCount,
      pendingId,
      cid,
      ticket: ticket || providerOrderId || result?.providerOrderId,
      providerOrderId: providerOrderId || result?.providerOrderId,
      provider: provider || result?.provider,
      payload: payload || order || origOrder,
      order,
      origOrder,
      reason
    });
  }

  recordOpened({ positionId, requestId, parentRequestId, childIndex, childCount, pendingId, cid, ticket, provider, order, origOrder } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(parentRequestId || requestId || origOrder?.meta?.parentRequestId || origOrder?.meta?.requestId) || this.repository.findByTicket(ticket, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_OPENED,
      positionId: aggregate.id,
      requestId: requestId || origOrder?.meta?.requestId,
      parentRequestId: parentRequestId || origOrder?.meta?.parentRequestId,
      childIndex: childIndex ?? origOrder?.meta?.childIndex,
      childCount: childCount ?? origOrder?.meta?.childCount,
      pendingId,
      cid: cid || origOrder?.meta?.cid,
      ticket,
      provider,
      payload: order,
      origOrder
    });
  }

  recordClosed({ positionId, requestId, parentRequestId, childIndex, childCount, pendingId, cid, ticket, provider, trade, profit, final = true, order, origOrder } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(parentRequestId || requestId || origOrder?.meta?.parentRequestId || origOrder?.meta?.requestId) || this.repository.findByTicket(ticket, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_CLOSED,
      positionId: aggregate.id,
      requestId: requestId || origOrder?.meta?.requestId,
      parentRequestId: parentRequestId || origOrder?.meta?.parentRequestId,
      childIndex: childIndex ?? origOrder?.meta?.childIndex,
      childCount: childCount ?? origOrder?.meta?.childCount,
      pendingId,
      cid: cid || origOrder?.meta?.cid,
      ticket,
      provider,
      trade,
      profit,
      final,
      payload: order || origOrder,
      order,
      origOrder
    });
  }

  recordCancelled({ positionId, requestId, parentRequestId, childIndex, childCount, pendingId, cid, ticket, provider, order, origOrder } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(parentRequestId || requestId || origOrder?.meta?.parentRequestId || origOrder?.meta?.requestId) || this.repository.findByTicket(ticket, provider);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_CANCELLED,
      positionId: aggregate.id,
      requestId: requestId || origOrder?.meta?.requestId,
      parentRequestId: parentRequestId || origOrder?.meta?.parentRequestId,
      childIndex: childIndex ?? origOrder?.meta?.childIndex,
      childCount: childCount ?? origOrder?.meta?.childCount,
      pendingId,
      cid: cid || origOrder?.meta?.cid,
      ticket,
      provider,
      payload: order || origOrder,
      order,
      origOrder
    });
  }

  recordRejected({ positionId, requestId, parentRequestId, childIndex, childCount, pendingId, cid, provider, reason, result, payload, order, origOrder } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(parentRequestId || requestId);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_REJECTED,
      positionId: aggregate.id,
      requestId,
      parentRequestId,
      childIndex,
      childCount,
      pendingId,
      cid,
      provider,
      providerOrderId: result?.providerOrderId,
      reason: reason || result?.reason,
      payload: payload || order || origOrder,
      order,
      origOrder
    });
  }

  recordFailed({ positionId, requestId, parentRequestId, childIndex, childCount, pendingId, cid, provider, reason, result, payload, order, origOrder } = {}) {
    const aggregate = positionId
      ? this.repository.get(positionId)
      : this.repository.findByRequestId(parentRequestId || requestId);
    if (!aggregate) return { ok: false, reason: 'Position not found', events: [], integrationCommands: [] };
    return this.handle({
      type: PositionCommand.PROVIDER_FAILED,
      positionId: aggregate.id,
      requestId,
      parentRequestId,
      childIndex,
      childCount,
      pendingId,
      cid,
      provider,
      providerOrderId: result?.providerOrderId,
      reason: reason || result?.reason,
      payload: payload || order || origOrder,
      order,
      origOrder
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
