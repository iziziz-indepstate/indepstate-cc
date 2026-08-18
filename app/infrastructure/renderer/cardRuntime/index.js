const { createCardStateApi } = require('./cardStateApi');
const { createOrderStateFacades } = require('./stateFacades');

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
  const runtime = {
    stateApi,
    stateFacades,
    rendererExtensions: {
      instrumentDisplayPolicy: [],
      cardStateHook: []
    },
    positionSnapshotHooks: [],
    positionRemovedHooks: [],
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

    registerCardType(definition = {}) {
      if (!definition || typeof definition !== 'object') return false;
      if (!definition.type && typeof definition.match !== 'function') return false;
      this.cardTypeDefinitions.push(definition);
      let unregistered = false;
      return () => {
        if (unregistered) return;
        unregistered = true;
        unregisterFrom(this.cardTypeDefinitions, definition);
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
    },

    createPositionCard(position = {}, context = {}) {
      const resolutionContext = { ...context, kind: 'position' };
      const definition = this.resolveCardType(position, resolutionContext);
      if (!definition?.shape || !definition?.view) return undefined;
      if (!Array.isArray(definition.controls) || definition.controls.length === 0) return undefined;

      const shape = this.getCardShape(definition.shape);
      const viewRenderer = this.getCardView(definition.view);
      const controlFactories = definition.controls.map(name => this.getCardControl(name));
      if (typeof shape !== 'function' || typeof viewRenderer !== 'function') return undefined;
      if (controlFactories.some(factory => !factory)) return undefined;

      const requestRemove = context.requestRemove || context.requestRemovePosition;
      const createActionsFromSnapshot = context.createActionsFromSnapshot || context.dispatchPositionAction;
      const componentContext = {
        ...context,
        kind: 'position',
        position,
        definition,
        runtime: this,
        requestRemove,
        createActionsFromSnapshot
      };
      const body = viewRenderer(componentContext);
      if (!body) return undefined;
      const controls = controlFactories.map(factory => (
        typeof factory === 'function'
          ? factory({ ...componentContext, body, view: body })
          : factory
      ));
      if (controls.some(control => !control)) return undefined;

      const actions = Array.isArray(position.card?.actions) ? position.card.actions : [];
      return shape({
        ...componentContext,
        body,
        view: body,
        controls,
        actions,
        requestRemove,
        createActionsFromSnapshot,
        rendererDependencies: context.rendererDependencies || context
      });
    },

    cleanupPositionCard(position = {}, context = {}) {
      const definition = this.resolveCardType(position, { ...context, kind: 'position' });
      if (typeof definition?.onRemovePosition !== 'function') return false;
      return definition.onRemovePosition(position, {
        ...context,
        kind: 'position',
        definition,
        runtime: this
      });
    }
  };

  return runtime;
}

module.exports = {
  createCardRuntime,
  createCardStateApi,
  createOrderStateFacades
};
