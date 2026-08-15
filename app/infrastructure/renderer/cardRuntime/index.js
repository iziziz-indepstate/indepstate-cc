const { createCardStateApi } = require('./cardStateApi');
const { createOrderStateFacades, createLegacyOrderStateCompatApi } = require('./stateFacades');

function unregisterFrom(list, item) {
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}

function createNamedRegistry() {
  const values = new Map();
  return {
    register(name, value) {
      const key = String(name || '').trim();
      if (!key || !value) return false;
      values.set(key, value);
      return () => {
        if (values.get(key) === value) values.delete(key);
      };
    },
    get(name) {
      return values.get(String(name || '').trim());
    },
    has(name) {
      return values.has(String(name || '').trim());
    },
    entries() {
      return Array.from(values.entries());
    },
    values
  };
}

function createCardRuntime(options = {}) {
  const stateApi = options.stateApi || createCardStateApi({
    state: options.state,
    uiState: options.uiState
  });
  const stateFacades = options.stateFacades || createOrderStateFacades(stateApi);
  const cardTypeDefinitions = [];
  const cardViews = createNamedRegistry();
  const cardControls = createNamedRegistry();
  const cardShapes = createNamedRegistry();
  const legacyOrderCardInstrumentHandlers = {};
  const legacyOrderCardTypeHandlers = {};
  let legacyOrderCardAdapter = null;
  const legacyInstrumentHandlerUnregisters = {};
  const legacyCardTypeHandlerUnregisters = {};

  function legacyRenderer() {
    return legacyOrderCardAdapter?.renderer || legacyOrderCardAdapter;
  }

  function bridgeLegacyInstrumentHandler(instrumentType, handler) {
    const renderer = legacyRenderer();
    if (!renderer || typeof renderer.registerInstrumentHandler !== 'function') return undefined;
    return renderer.registerInstrumentHandler(instrumentType, handler);
  }

  function bridgeLegacyCardTypeHandler(cardType, handler) {
    const renderer = legacyRenderer();
    if (!renderer || typeof renderer.registerCardTypeHandler !== 'function') return undefined;
    return renderer.registerCardTypeHandler(cardType, handler);
  }

  function onceUnregister(unregister) {
    if (typeof unregister !== 'function') return undefined;
    let called = false;
    return () => {
      if (called) return;
      called = true;
      unregister();
    };
  }

  const runtime = {
    stateApi,
    stateFacades,
    rendererExtensions: {
      instrumentDisplayPolicy: [],
      cardStateHook: []
    },
    rendererLayers: [],
    rendererRowProviders: [],
    positionSnapshotHooks: [],
    positionRemovedHooks: [],
    positionActionHandlers: {},
    positionCardRenderers: {},
    positionRemovalHandlers: {},
    rendererLegacyGuards: [],
    legacyOrderCardInstrumentHandlers,
    legacyOrderCardTypeHandlers,
    cardTypeDefinitions,
    cardViews: cardViews.values,
    cardControls: cardControls.values,
    cardShapes: cardShapes.values,

    registerRendererExtension(kind, extension) {
      if (!kind || !extension) return false;
      if (!this.rendererExtensions[kind]) this.rendererExtensions[kind] = [];
      this.rendererExtensions[kind].push(extension);
      return () => unregisterFrom(this.rendererExtensions[kind], extension);
    },

    registerInstrumentDisplayPolicy(policy) {
      if (!policy || typeof policy !== 'object') return false;
      return this.registerRendererExtension('instrumentDisplayPolicy', policy);
    },

    registerCardStateHook(hook) {
      if (typeof hook !== 'function') return false;
      return this.registerRendererExtension('cardStateHook', hook);
    },

    registerRendererLayer(layer) {
      if (typeof layer !== 'function') return false;
      this.rendererLayers.push(layer);
      return () => unregisterFrom(this.rendererLayers, layer);
    },

    registerRendererRowProvider(provider) {
      if (typeof provider !== 'function') return false;
      this.rendererRowProviders.push(provider);
      return () => unregisterFrom(this.rendererRowProviders, provider);
    },

    rendererRows() {
      return this.rendererRowProviders.flatMap(provider => {
        try {
          const rows = provider();
          return Array.isArray(rows) ? rows : [];
        } catch (err) {
          console.error('[rendererExtension] row provider failed', err?.message || err);
          return [];
        }
      });
    },

    registerPositionSnapshotHook(hook) {
      if (typeof hook !== 'function') return false;
      this.positionSnapshotHooks.push(hook);
      return () => unregisterFrom(this.positionSnapshotHooks, hook);
    },

    registerPositionRemovedHook(hook) {
      if (typeof hook !== 'function') return false;
      this.positionRemovedHooks.push(hook);
      return () => unregisterFrom(this.positionRemovedHooks, hook);
    },

    registerPositionCardRenderer(cardType, renderer) {
      if (!cardType || typeof renderer !== 'function') return false;
      this.positionCardRenderers[cardType] = renderer;
      return () => {
        if (this.positionCardRenderers[cardType] === renderer) delete this.positionCardRenderers[cardType];
      };
    },

    registerPositionActionHandler(cardType, handler) {
      if (!cardType || typeof handler !== 'function') return false;
      this.positionActionHandlers[cardType] = handler;
      return () => {
        if (this.positionActionHandlers[cardType] === handler) delete this.positionActionHandlers[cardType];
      };
    },

    registerPositionRemovalHandler(cardType, handler) {
      if (!cardType || typeof handler !== 'function') return false;
      this.positionRemovalHandlers[cardType] = handler;
      return () => {
        if (this.positionRemovalHandlers[cardType] === handler) delete this.positionRemovalHandlers[cardType];
      };
    },

    registerRendererLegacyGuard(guard = {}) {
      if (!guard || typeof guard !== 'object') return false;
      this.rendererLegacyGuards.push(guard);
      return () => unregisterFrom(this.rendererLegacyGuards, guard);
    },

    connectLegacyOrderCardRenderer(adapter = {}) {
      legacyOrderCardAdapter = adapter?.renderer ? adapter : { renderer: adapter };
      for (const [instrumentType, handler] of Object.entries(this.legacyOrderCardInstrumentHandlers)) {
        if (typeof legacyInstrumentHandlerUnregisters[instrumentType] === 'function') {
          legacyInstrumentHandlerUnregisters[instrumentType]();
        }
        legacyInstrumentHandlerUnregisters[instrumentType] = onceUnregister(
          bridgeLegacyInstrumentHandler(instrumentType, handler)
        );
      }
      for (const [cardType, handler] of Object.entries(this.legacyOrderCardTypeHandlers)) {
        if (typeof legacyCardTypeHandlerUnregisters[cardType] === 'function') {
          legacyCardTypeHandlerUnregisters[cardType]();
        }
        legacyCardTypeHandlerUnregisters[cardType] = onceUnregister(
          bridgeLegacyCardTypeHandler(cardType, handler)
        );
      }
      return () => {
        if (legacyOrderCardAdapter !== adapter && legacyOrderCardAdapter?.renderer !== adapter) return;
        for (const unregister of Object.values(legacyInstrumentHandlerUnregisters)) {
          if (typeof unregister === 'function') unregister();
        }
        for (const unregister of Object.values(legacyCardTypeHandlerUnregisters)) {
          if (typeof unregister === 'function') unregister();
        }
        legacyOrderCardAdapter = null;
      };
    },

    legacyRows() {
      try {
        const rows = legacyOrderCardAdapter?.getRows?.();
        return Array.isArray(rows) ? rows : [];
      } catch (err) {
        console.error('[cardRuntime] legacy row adapter failed', err?.message || err);
        return [];
      }
    },

    findLegacyRowByKey(key) {
      const rowKey = legacyOrderCardAdapter?.rowKey;
      if (typeof rowKey !== 'function') return undefined;
      return this.legacyRows().find(row => rowKey(row) === key);
    },

    setLegacyRowCardState(key, state) {
      return legacyOrderCardAdapter?.setCardState?.(key, state);
    },

    registerOrderCardInstrumentHandler(instrumentType, handler) {
      const key = String(instrumentType || '').trim();
      if (!key || !handler || typeof handler !== 'object') return false;
      this.legacyOrderCardInstrumentHandlers[key] = handler;
      if (typeof legacyInstrumentHandlerUnregisters[key] === 'function') {
        legacyInstrumentHandlerUnregisters[key]();
      }
      const unregisterAdapter = onceUnregister(bridgeLegacyInstrumentHandler(key, handler));
      legacyInstrumentHandlerUnregisters[key] = unregisterAdapter;
      return () => {
        if (this.legacyOrderCardInstrumentHandlers[key] === handler) delete this.legacyOrderCardInstrumentHandlers[key];
        if (typeof unregisterAdapter === 'function') unregisterAdapter();
        if (legacyInstrumentHandlerUnregisters[key] === unregisterAdapter) {
          delete legacyInstrumentHandlerUnregisters[key];
        }
      };
    },

    registerOrderCardTypeHandler(cardType, handler) {
      const key = String(cardType || '').trim();
      if (!key || !handler || typeof handler !== 'object') return false;
      this.legacyOrderCardTypeHandlers[key] = handler;
      if (typeof legacyCardTypeHandlerUnregisters[key] === 'function') {
        legacyCardTypeHandlerUnregisters[key]();
      }
      const unregisterAdapter = onceUnregister(bridgeLegacyCardTypeHandler(key, handler));
      legacyCardTypeHandlerUnregisters[key] = unregisterAdapter;
      return () => {
        if (this.legacyOrderCardTypeHandlers[key] === handler) delete this.legacyOrderCardTypeHandlers[key];
        if (typeof unregisterAdapter === 'function') unregisterAdapter();
        if (legacyCardTypeHandlerUnregisters[key] === unregisterAdapter) {
          delete legacyCardTypeHandlerUnregisters[key];
        }
      };
    },

    registerCardType(definition = {}) {
      if (!definition || typeof definition !== 'object') return false;
      if (!definition.type && typeof definition.match !== 'function') return false;
      this.cardTypeDefinitions.push(definition);
      return () => unregisterFrom(this.cardTypeDefinitions, definition);
    },

    resolveCardType(card = {}, context = {}) {
      for (let index = this.cardTypeDefinitions.length - 1; index >= 0; index -= 1) {
        const definition = this.cardTypeDefinitions[index];
        if (typeof definition.match === 'function') {
          try {
            if (definition.match(card, context)) return definition;
          } catch (_) {
            continue;
          }
        }
        const type = card.card?.type || card.type || card.source?.cardType || card.instrumentType;
        if (definition.type && String(definition.type) === String(type || '')) return definition;
      }
      return undefined;
    },

    registerCardView(name, renderer) {
      return cardViews.register(name, renderer);
    },

    getCardView(name) {
      return cardViews.get(name);
    },

    registerCardControl(name, factory) {
      return cardControls.register(name, factory);
    },

    getCardControl(name) {
      return cardControls.get(name);
    },

    registerCardShape(name, composer) {
      return cardShapes.register(name, composer);
    },

    getCardShape(name) {
      return cardShapes.get(name);
    }
  };

  return runtime;
}

module.exports = {
  createCardRuntime,
  createCardStateApi,
  createOrderStateFacades,
  createLegacyOrderStateCompatApi
};
