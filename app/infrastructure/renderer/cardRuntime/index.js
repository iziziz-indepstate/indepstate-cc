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
  const legacyDefinitionHandlers = new Map();
  let legacyOrderCardAdapter = null;
  const legacyInstrumentHandlerUnregisters = {};
  const legacyCardTypeHandlerUnregisters = {};
  const bridgedLegacyInstrumentHandlers = {};
  const bridgedLegacyCardTypeHandlers = {};

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

  function legacyKeys(values) {
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
  }

  function controlDefinitionsFor(definition, context = {}) {
    const names = Array.isArray(definition.controls) ? definition.controls : [];
    return names.map(name => {
      const factory = cardControls.get(name);
      if (typeof factory !== 'function') return factory;
      return factory({ definition, runtime, ...context });
    }).filter(Boolean);
  }

  function controlProperty(definition, property, context = {}) {
    const controls = controlDefinitionsFor(definition, context);
    for (let index = controls.length - 1; index >= 0; index -= 1) {
      if (controls[index]?.[property] !== undefined) return controls[index][property];
    }
    return undefined;
  }

  function createLegacyHandler(definition) {
    const handler = {
      ...(definition.legacyRow || {}),
      createBody(row, key) {
        const view = cardViews.get(definition.view);
        return typeof view === 'function' ? view(row, key) : undefined;
      },
      buttons(row) {
        return controlDefinitionsFor(definition, { row }).flatMap(control => {
          const buttons = typeof control?.buttons === 'function' ? control.buttons(row) : control?.buttons;
          if (Array.isArray(buttons)) return buttons;
          return buttons ? [buttons] : [];
        });
      }
    };
    const controlProperties = [
      'preparePlace',
      'afterPlaceOk',
      'scheduleInstantExecution',
      'placedStatusTitle',
      'placedButton',
      'closePlacedOrder',
      'shouldKeepFullCardOnState',
      'shouldEnableButtonOnState',
      'shouldHideButtonsOnState',
      'resetButtons'
    ];
    for (const property of controlProperties) {
      Object.defineProperty(handler, property, {
        configurable: true,
        enumerable: true,
        get() {
          return controlProperty(definition, property);
        }
      });
    }
    return handler;
  }

  function definitionHandlerFor(kind, key) {
    const field = kind === 'instrument' ? 'legacyInstrumentTypes' : 'legacyCardTypes';
    for (let index = cardTypeDefinitions.length - 1; index >= 0; index -= 1) {
      const definition = cardTypeDefinitions[index];
      if (legacyKeys(definition[field]).includes(key)) return legacyDefinitionHandlers.get(definition);
    }
    return undefined;
  }

  function syncLegacyBridge(kind, key) {
    const unregisters = kind === 'instrument'
      ? legacyInstrumentHandlerUnregisters
      : legacyCardTypeHandlerUnregisters;
    const bridgedHandlers = kind === 'instrument'
      ? bridgedLegacyInstrumentHandlers
      : bridgedLegacyCardTypeHandlers;
    const desired = definitionHandlerFor(kind, key);
    if (bridgedHandlers[key] === desired) return;
    if (typeof unregisters[key] === 'function') unregisters[key]();
    delete unregisters[key];
    delete bridgedHandlers[key];
    if (!legacyOrderCardAdapter || !desired) return;
    const unregister = kind === 'instrument'
      ? bridgeLegacyInstrumentHandler(key, desired)
      : bridgeLegacyCardTypeHandler(key, desired);
    unregisters[key] = onceUnregister(unregister);
    bridgedHandlers[key] = desired;
  }

  function syncAllLegacyBridges() {
    const instrumentKeys = new Set(Object.keys(bridgedLegacyInstrumentHandlers));
    const cardTypeKeys = new Set(Object.keys(bridgedLegacyCardTypeHandlers));
    for (const definition of cardTypeDefinitions) {
      legacyKeys(definition.legacyInstrumentTypes).forEach(key => instrumentKeys.add(key));
      legacyKeys(definition.legacyCardTypes).forEach(key => cardTypeKeys.add(key));
    }
    instrumentKeys.forEach(key => syncLegacyBridge('instrument', key));
    cardTypeKeys.forEach(key => syncLegacyBridge('cardType', key));
  }

  function disconnectLegacyBridges() {
    for (const unregister of Object.values(legacyInstrumentHandlerUnregisters)) {
      if (typeof unregister === 'function') unregister();
    }
    for (const unregister of Object.values(legacyCardTypeHandlerUnregisters)) {
      if (typeof unregister === 'function') unregister();
    }
    for (const key of Object.keys(legacyInstrumentHandlerUnregisters)) delete legacyInstrumentHandlerUnregisters[key];
    for (const key of Object.keys(legacyCardTypeHandlerUnregisters)) delete legacyCardTypeHandlerUnregisters[key];
    for (const key of Object.keys(bridgedLegacyInstrumentHandlers)) delete bridgedLegacyInstrumentHandlers[key];
    for (const key of Object.keys(bridgedLegacyCardTypeHandlers)) delete bridgedLegacyCardTypeHandlers[key];
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
      disconnectLegacyBridges();
      const connectedAdapter = adapter?.renderer ? adapter : { renderer: adapter };
      legacyOrderCardAdapter = connectedAdapter;
      syncAllLegacyBridges();
      return () => {
        if (legacyOrderCardAdapter !== connectedAdapter) return;
        disconnectLegacyBridges();
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

    registerCardType(definition = {}) {
      if (!definition || typeof definition !== 'object') return false;
      if (!definition.type && typeof definition.match !== 'function') return false;
      this.cardTypeDefinitions.push(definition);
      legacyDefinitionHandlers.set(definition, createLegacyHandler(definition));
      legacyKeys(definition.legacyInstrumentTypes).forEach(key => syncLegacyBridge('instrument', key));
      legacyKeys(definition.legacyCardTypes).forEach(key => syncLegacyBridge('cardType', key));
      let unregistered = false;
      return () => {
        if (unregistered) return;
        unregistered = true;
        unregisterFrom(this.cardTypeDefinitions, definition);
        legacyDefinitionHandlers.delete(definition);
        legacyKeys(definition.legacyInstrumentTypes).forEach(key => syncLegacyBridge('instrument', key));
        legacyKeys(definition.legacyCardTypes).forEach(key => syncLegacyBridge('cardType', key));
      };
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
