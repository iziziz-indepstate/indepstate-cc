function normalizeId(value) {
  return String(value || '').trim();
}

class PositionBehaviorRegistry {
  constructor(initial = []) {
    this.behaviors = new Map();
    for (const behavior of initial || []) this.register(behavior);
  }

  register(behavior = {}) {
    const id = normalizeId(behavior.id || behavior.type || behavior.kind);
    if (!id) return false;
    this.behaviors.set(id, behavior);
    return () => this.behaviors.delete(id);
  }

  get(id) {
    return this.behaviors.get(normalizeId(id)) || null;
  }

  resolve(position = {}, command = {}) {
    for (const behavior of this.behaviors.values()) {
      if (typeof behavior.matches === 'function' && behavior.matches(position, command)) {
        return behavior;
      }
    }
    return null;
  }

  deriveCard(position = {}, opts = {}) {
    const behavior = this.resolve(position, opts.command || {});
    if (behavior && typeof behavior.deriveCard === 'function') {
      return behavior.deriveCard(position, opts);
    }
    return null;
  }
}

function createPositionBehaviorRegistry(initial = []) {
  return new PositionBehaviorRegistry(initial);
}

const defaultPositionBehaviorRegistry = createPositionBehaviorRegistry();

module.exports = {
  PositionBehaviorRegistry,
  createPositionBehaviorRegistry,
  defaultPositionBehaviorRegistry
};
