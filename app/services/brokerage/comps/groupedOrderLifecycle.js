function normalizeId(value) {
  return String(value == null ? '' : value).trim();
}

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function finiteQuantity(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function ticketKey(ticket, provider) {
  const normalizedTicket = normalizeId(ticket);
  if (!normalizedTicket) return '';
  return `${normalizeId(provider)}\u0000${normalizedTicket}`;
}

class GroupedOrderLifecycleRegistry {
  constructor() {
    this.groups = new Map();
    this.ticketToGroup = new Map();
  }

  ensure(groupId, metadata = {}) {
    const id = normalizeId(groupId);
    if (!id) return null;
    let group = this.groups.get(id);
    if (!group) {
      group = {
        id,
        provider: normalizeId(metadata.provider),
        symbol: normalizeId(metadata.symbol),
        expectedCount: positiveInteger(metadata.expectedCount),
        tickets: new Set(),
        openedTickets: new Set(),
        qtyByTicket: new Map(),
        cids: new Set(),
        readyEmitted: false
      };
      this.groups.set(id, group);
    } else {
      const nextProvider = normalizeId(metadata.provider);
      if (!group.provider && nextProvider) {
        for (const ticket of group.tickets) {
          this.ticketToGroup.delete(ticketKey(ticket, group.provider));
          this.ticketToGroup.set(ticketKey(ticket, nextProvider), group.id);
        }
        group.provider = nextProvider;
      }
      group.symbol = group.symbol || normalizeId(metadata.symbol);
      group.expectedCount = Math.max(
        positiveInteger(group.expectedCount),
        positiveInteger(metadata.expectedCount)
      );
    }
    return group;
  }

  registerTicket(groupId, record = {}) {
    const ticket = normalizeId(record.ticket);
    if (!ticket) return this.ensure(groupId, record);
    const group = this.ensure(groupId, record);
    if (!group) return null;
    group.tickets.add(ticket);
    const qty = finiteQuantity(record.qty);
    if (qty > 0 || !group.qtyByTicket.has(ticket)) group.qtyByTicket.set(ticket, qty);
    const cid = normalizeId(record.cid);
    if (cid) group.cids.add(cid);
    this.ticketToGroup.set(ticketKey(ticket, group.provider), group.id);
    return group;
  }

  markOpened(groupId, record = {}) {
    const ticket = normalizeId(record.ticket);
    const group = this.registerTicket(groupId, record);
    if (!group || !ticket) return group;
    group.openedTickets.add(ticket);
    return group;
  }

  get(groupId) {
    return this.groups.get(normalizeId(groupId));
  }

  getByTicket(ticket, provider) {
    const groupId = this.ticketToGroup.get(ticketKey(ticket, provider));
    return groupId ? this.groups.get(groupId) : undefined;
  }

  takeReadySnapshot(groupId) {
    const group = this.get(groupId);
    if (!group || group.readyEmitted) return null;
    if (
      group.tickets.size < group.expectedCount
      || group.openedTickets.size < group.expectedCount
      || group.openedTickets.size < group.tickets.size
    ) return null;
    group.readyEmitted = true;
    const expectedQty = Array.from(group.qtyByTicket.values())
      .reduce((sum, qty) => sum + finiteQuantity(qty), 0);
    const foundQty = Array.from(group.openedTickets)
      .reduce((sum, ticket) => sum + finiteQuantity(group.qtyByTicket.get(ticket)), 0);
    return {
      id: group.id,
      provider: group.provider,
      symbol: group.symbol,
      expectedCount: group.expectedCount,
      expectedQty,
      foundQty,
      tickets: Array.from(group.tickets),
      openedTickets: Array.from(group.openedTickets),
      cids: Array.from(group.cids)
    };
  }

  getUnopenedTickets(groupId) {
    const group = this.get(groupId);
    if (!group) return [];
    return Array.from(group.tickets).filter(ticket => !group.openedTickets.has(ticket));
  }

  removeTicket(ticket, provider) {
    const normalizedTicket = normalizeId(ticket);
    const key = ticketKey(normalizedTicket, provider);
    const groupId = this.ticketToGroup.get(key);
    if (!groupId) return null;
    this.ticketToGroup.delete(key);
    const group = this.groups.get(groupId);
    if (!group) return null;
    group.tickets.delete(normalizedTicket);
    group.openedTickets.delete(normalizedTicket);
    group.qtyByTicket.delete(normalizedTicket);
    if (group.tickets.size === 0) this.groups.delete(groupId);
    return group;
  }

  delete(groupId) {
    const id = normalizeId(groupId);
    const group = this.groups.get(id);
    if (!group) return false;
    for (const ticket of group.tickets) this.ticketToGroup.delete(ticketKey(ticket, group.provider));
    return this.groups.delete(id);
  }
}

module.exports = {
  GroupedOrderLifecycleRegistry
};
