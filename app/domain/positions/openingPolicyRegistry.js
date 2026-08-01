function normalizeKind(value) {
  return String(value || '').trim();
}

class OpeningPolicyRegistry {
  constructor(initial = []) {
    this.factories = new Map();
    for (const entry of initial || []) {
      this.register(entry.kind || entry.type || entry.id, entry.factory || entry.create || entry);
    }
  }

  register(kind, factory) {
    const key = normalizeKind(kind);
    if (!key || typeof factory !== 'function') return false;
    this.factories.set(key, factory);
    return () => this.factories.delete(key);
  }

  create(spec = {}) {
    const kind = normalizeKind(spec.kind || spec.type || 'regular');
    const config = spec.config || spec;
    const factory = this.factories.get(kind);
    return factory ? factory(config, spec) : null;
  }
}

function createOpeningPolicyRegistry(initial = []) {
  return new OpeningPolicyRegistry(initial);
}

module.exports = {
  OpeningPolicyRegistry,
  createOpeningPolicyRegistry
};
