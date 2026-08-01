const crypto = require('crypto');
const { PositionState, PositionCommand, PositionEvent } = require('./types');
const { createOpeningPolicy, createClosingPolicy } = require('./policies');
const { derivePositionCard } = require('./cardMetadata');
const { defaultPositionBehaviorRegistry } = require('./behaviorRegistry');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function idFromSeed(seed) {
  const text = String(seed || '').trim();
  if (text) return text;
  return `pos_${crypto.randomBytes(8).toString('hex')}`;
}

function now(command) {
  return Number.isFinite(command?.time) ? command.time : Date.now();
}

function normalizeTicket(ticket) {
  const text = String(ticket || '').trim();
  return text || '';
}

function childKey(child = {}) {
  return String(child.childRequestId || child.requestId || child.pendingId || child.cid || child.ticket || child.providerOrderId || '').trim();
}

class PositionAggregate {
  constructor(snapshot = {}, opts = {}) {
    this.behaviorRegistry = opts.behaviorRegistry || defaultPositionBehaviorRegistry;
    this.id = idFromSeed(snapshot.id);
    this.state = snapshot.state || PositionState.DRAFT;
    this.ticker = snapshot.ticker || snapshot.symbol || '';
    this.symbol = snapshot.symbol || snapshot.ticker || '';
    this.instrumentType = snapshot.instrumentType || '';
    this.qty = snapshot.qty ?? snapshot.volume ?? null;
    this.provider = snapshot.provider || '';
    this.side = snapshot.side || '';
    this.source = clone(snapshot.source) || {};
    if (snapshot.cardType && !this.source.cardType) this.source.cardType = snapshot.cardType;
    this.cardSpec = clone(snapshot.card || snapshot.cardSpec) || {};
    if (snapshot.cardType && !this.cardSpec.type) this.cardSpec.type = snapshot.cardType;
    this.executionIntent = clone(snapshot.executionIntent) || null;
    this.openingPolicy = createOpeningPolicy(snapshot.openingPolicy || { kind: snapshot.cardType || 'regular' });
    this.closingPolicy = createClosingPolicy(snapshot.closingPolicy || { kind: 'regular' });
    this.primaryTicket = snapshot.primaryTicket || '';
    this.tickets = new Set(Array.isArray(snapshot.tickets) ? snapshot.tickets.map(normalizeTicket).filter(Boolean) : []);
    if (this.primaryTicket) this.tickets.add(this.primaryTicket);
    this.children = new Map();
    for (const child of snapshot.children || []) {
      const key = childKey(child);
      if (key) this.children.set(key, clone(child));
    }
    this.expectedChildren = Number.isFinite(Number(snapshot.expectedChildren)) ? Number(snapshot.expectedChildren) : this.children.size;
    this.pnlSnapshot = clone(snapshot.pnlSnapshot) || { status: 'unavailable' };
    this.timestamps = {
      createdAt: snapshot.timestamps?.createdAt || snapshot.createdAt || null,
      openingAt: snapshot.timestamps?.openingAt || snapshot.openingAt || null,
      placedAt: snapshot.timestamps?.placedAt || snapshot.placedAt || null,
      openedAt: snapshot.timestamps?.openedAt || snapshot.openedAt || null,
      closingAt: snapshot.timestamps?.closingAt || snapshot.closingAt || null,
      closedAt: snapshot.timestamps?.closedAt || snapshot.closedAt || null,
      archivedAt: snapshot.timestamps?.archivedAt || snapshot.archivedAt || null
    };
    this.lastReason = snapshot.lastReason || '';
    this.version = Number(snapshot.version) || 0;
  }

  static create(command = {}, opts = {}) {
    return new PositionAggregate({
      id: command.positionId || command.id,
      ticker: command.ticker || command.symbol,
      symbol: command.symbol || command.ticker,
      instrumentType: command.instrumentType,
      qty: command.qty,
      provider: command.provider,
      side: command.side,
      source: command.source || command.payload || {},
      card: command.card,
      executionIntent: command.executionIntent || command.payload || null,
      openingPolicy: command.openingPolicy,
      closingPolicy: command.closingPolicy,
      cardType: command.cardType
    }, opts);
  }

  handle(command = {}) {
    switch (command.type) {
      case PositionCommand.CREATE:
        return this.#create(command);
      case PositionCommand.OPEN:
        return this.#open(command);
      case PositionCommand.CLOSE:
        return this.#close(command);
      case PositionCommand.REMOVE:
        return this.#remove(command);
      case PositionCommand.PROVIDER_PLACED:
        return this.#providerPlaced(command);
      case PositionCommand.PROVIDER_OPENED:
        return this.#providerOpened(command);
      case PositionCommand.PROVIDER_CLOSED:
        return this.#providerClosed(command);
      case PositionCommand.PROVIDER_CANCELLED:
        return this.#providerCancelled(command);
      case PositionCommand.PROVIDER_REJECTED:
        return this.#providerRejected(command);
      case PositionCommand.PROVIDER_FAILED:
        return this.#providerFailed(command);
      case PositionCommand.PNL_UPDATED:
        return this.#pnlUpdated(command);
      default:
        return { events: [], integrationCommands: [] };
    }
  }

  #touch() {
    this.version += 1;
  }

  #event(type, data = {}) {
    return {
      type,
      positionId: this.id,
      state: this.state,
      provider: this.provider,
      ticker: this.ticker,
      symbol: this.symbol,
      ...data
    };
  }

  #behavior(command = {}) {
    return this.behaviorRegistry?.resolve?.(this, command) || null;
  }

  #behaviorContext() {
    return {
      clone,
      now,
      normalizeTicket,
      normalizePnlSnapshot,
      event: (type, data) => this.#event(type, data),
      touch: () => this.#touch()
    };
  }

  #create(command) {
    if (!this.timestamps.createdAt) this.timestamps.createdAt = now(command);
    this.#touch();
    return {
      events: [this.#event(PositionEvent.CREATED, { source: clone(this.source), timestamp: this.timestamps.createdAt })],
      integrationCommands: []
    };
  }

  #open(command) {
    if ([PositionState.ACTIVE, PositionState.OPENING, PositionState.PLACED, PositionState.CLOSING, PositionState.CLOSED].includes(this.state)) {
      return { events: [], integrationCommands: [] };
    }
    this.state = PositionState.OPENING;
    this.timestamps.openingAt = now(command);
    this.executionIntent = clone(command.payload || command.executionIntent || this.executionIntent || this.source);
    if (command.openingPolicy) this.openingPolicy = createOpeningPolicy(command.openingPolicy);
    const built = this.openingPolicy.buildOpenRequest(this, command);
    this.#touch();
    return {
      events: [this.#event(PositionEvent.OPEN_REQUESTED, { timestamp: this.timestamps.openingAt }), ...built.events],
      integrationCommands: built.integrationCommands
    };
  }

  #close(command) {
    if ([PositionState.CLOSED, PositionState.CANCELLED, PositionState.REJECTED, PositionState.ARCHIVED].includes(this.state)) {
      return { events: [], integrationCommands: [] };
    }
    this.state = PositionState.CLOSING;
    this.timestamps.closingAt = now(command);
    const built = this.closingPolicy.buildCloseRequest(this, command);
    this.#touch();
    return built;
  }

  #remove(command) {
    if ([PositionState.DRAFT, PositionState.REJECTED, PositionState.CANCELLED].includes(this.state)) {
      this.state = PositionState.CANCELLED;
      this.#touch();
      return { events: [this.#event(PositionEvent.REMOVED, { timestamp: now(command) })], integrationCommands: [] };
    }
    if (this.state === PositionState.CLOSED) {
      this.state = PositionState.ARCHIVED;
      this.timestamps.archivedAt = now(command);
      this.#touch();
      return { events: [this.#event(PositionEvent.ARCHIVED, { timestamp: this.timestamps.archivedAt })], integrationCommands: [] };
    }
    return this.#close(command);
  }

  #providerPlaced(command) {
    const behavior = this.#behavior(command);
    if (behavior?.providerPlaced) return behavior.providerPlaced(this, command, this.#behaviorContext());
    const ticket = normalizeTicket(command.ticket || command.providerOrderId);
    if (ticket && this.tickets.has(ticket) && [PositionState.PLACED, PositionState.ACTIVE, PositionState.CLOSING, PositionState.CLOSED].includes(this.state)) {
      return { events: [], integrationCommands: [] };
    }
    if (ticket) {
      this.primaryTicket = this.primaryTicket || ticket;
      this.tickets.add(ticket);
    }
    if (![PositionState.ACTIVE, PositionState.CLOSING, PositionState.CLOSED].includes(this.state)) {
      this.state = PositionState.PLACED;
      this.timestamps.placedAt = this.timestamps.placedAt || now(command);
    }
    this.#touch();
    return { events: [this.#event(PositionEvent.PLACED, { ticket, timestamp: this.timestamps.placedAt })], integrationCommands: [] };
  }

  #providerOpened(command) {
    const behavior = this.#behavior(command);
    if (behavior?.providerOpened) return behavior.providerOpened(this, command, this.#behaviorContext());
    const ticket = normalizeTicket(command.ticket || command.providerOrderId);
    if (ticket && this.tickets.has(ticket) && [PositionState.ACTIVE, PositionState.CLOSING, PositionState.CLOSED].includes(this.state)) {
      return { events: [], integrationCommands: [] };
    }
    if (ticket) {
      this.primaryTicket = this.primaryTicket || ticket;
      this.tickets.add(ticket);
    }
    this.state = PositionState.ACTIVE;
    this.timestamps.openedAt = this.timestamps.openedAt || now(command);
    this.#touch();
    return { events: [this.#event(PositionEvent.OPENED, { ticket, timestamp: this.timestamps.openedAt })], integrationCommands: [] };
  }

  #providerClosed(command) {
    const behavior = this.#behavior(command);
    if (behavior?.providerClosed) return behavior.providerClosed(this, command, this.#behaviorContext());
    const ticket = normalizeTicket(command.ticket || command.providerOrderId);
    if (command.pnlSnapshot || command.profit != null || command.trade) {
      this.pnlSnapshot = normalizePnlSnapshot(command);
    }
    this.state = PositionState.CLOSED;
    this.timestamps.closedAt = this.timestamps.closedAt || now(command);
    this.#touch();
    return { events: [this.#event(PositionEvent.CLOSED, { ticket, pnlSnapshot: clone(this.pnlSnapshot), timestamp: this.timestamps.closedAt })], integrationCommands: [] };
  }

  #providerCancelled(command) {
    const behavior = this.#behavior(command);
    if (behavior?.providerCancelled) return behavior.providerCancelled(this, command, this.#behaviorContext());
    const ticket = normalizeTicket(command.ticket || command.providerOrderId);
    if (ticket) this.tickets.delete(ticket);
    this.state = PositionState.CANCELLED;
    this.#touch();
    return { events: [this.#event(PositionEvent.CANCELLED, { ticket, timestamp: now(command) })], integrationCommands: [] };
  }

  #providerRejected(command) {
    const behavior = this.#behavior(command);
    if (behavior?.providerRejected) return behavior.providerRejected(this, command, this.#behaviorContext());
    this.state = PositionState.REJECTED;
    this.lastReason = command.reason || '';
    this.#touch();
    return { events: [this.#event(PositionEvent.REJECTED, { reason: this.lastReason, timestamp: now(command) })], integrationCommands: [] };
  }

  #providerFailed(command) {
    const behavior = this.#behavior(command);
    if (behavior?.providerFailed) return behavior.providerFailed(this, command, this.#behaviorContext());
    this.state = PositionState.FAILED;
    this.lastReason = command.reason || '';
    this.#touch();
    return { events: [this.#event(PositionEvent.FAILED, { reason: this.lastReason, timestamp: now(command) })], integrationCommands: [] };
  }

  #pnlUpdated(command) {
    this.pnlSnapshot = normalizePnlSnapshot(command);
    this.#touch();
    return { events: [this.#event(PositionEvent.PNL_UPDATED, { pnlSnapshot: clone(this.pnlSnapshot), timestamp: now(command) })], integrationCommands: [] };
  }

  snapshot() {
    const snapshot = {
      id: this.id,
      state: this.state,
      ticker: this.ticker,
      symbol: this.symbol,
      instrumentType: this.instrumentType,
      qty: this.qty,
      provider: this.provider,
      side: this.side,
      source: clone(this.source),
      executionIntent: clone(this.executionIntent),
      openingPolicy: this.openingPolicy.snapshot(),
      closingPolicy: this.closingPolicy.snapshot(),
      primaryTicket: this.primaryTicket,
      tickets: Array.from(this.tickets),
      children: Array.from(this.children.values()).map(clone),
      expectedChildren: this.expectedChildren,
      pnlSnapshot: clone(this.pnlSnapshot),
      timestamps: clone(this.timestamps),
      lastReason: this.lastReason,
      version: this.version
    };
    snapshot.card = derivePositionCard(snapshot, { card: this.cardSpec, behaviorRegistry: this.behaviorRegistry });
    return snapshot;
  }
}

function normalizePnlSnapshot(command = {}) {
  if (command.pnlSnapshot) return clone(command.pnlSnapshot);
  const profit = command.profit ?? command.trade?.profit;
  if (Number.isFinite(Number(profit))) {
    return { status: 'reported', value: Number(profit), source: command.source || 'provider', raw: clone(command.trade) || null };
  }
  if (command.trade?.pnlStatus) {
    return { status: command.trade.pnlStatus, source: command.source || 'provider', raw: clone(command.trade) };
  }
  return { status: 'unavailable', source: command.source || 'provider', raw: clone(command.trade) || null };
}

module.exports = {
  PositionAggregate,
  clone,
  now,
  normalizeTicket,
  normalizePnlSnapshot
};
