# Renderer Extension Points

Renderer behavior is registered by service manifests. The shell in `app/renderer.js` loads each
`app/services/<service>/manifest.js`, calls `hookRenderer(ipcRenderer)` when present, then calls
objects in `rendererHandlers` and `rendererPositionHandlers` with `handler.register(context)`.

Manifests must be renderer-safe at top level. Load main-only dependencies lazily inside hooks such as
`registerMainApplicationServices()`.

## Shell API

Common snapshot extension points are:

- `cardRuntime.registerCardType(definition)` selects a runtime-composed snapshot type;
- `cardRuntime.registerCardView(name, renderer)` registers a snapshot body/view;
- `cardRuntime.registerCardControl(name, factory)` registers action controls;
- `cardRuntime.registerCardShape(name, composer)` registers the final card layout;
- `cardRuntime.createPositionCard(position, context)` composes a registered snapshot;
- `cardRuntime.cleanupPositionCard(position, context)` invokes `onRemovePosition` when defined;
- `registerInstrumentDisplayPolicy(policy)` contributes shared bid/ask/spread policy;
- `registerCardStateHook(hook)` contributes transient card-state refresh behavior;
- `registerPositionSnapshotHook(hook)` observes accepted `positions:changed` snapshots;
- `registerPositionRemovedHook(hook)` handles cleanup when a snapshot is removed or archived.

The context also injects helpers such as `ipcRenderer`, `btn`, `render`, `toast`, `positionKey`,
`positionCardTitle`, `getPositionSnapshots`, `dispatchPositionAction`, `requestRemovePosition`,
settings, instrument helpers, and transient card-state APIs. Services should not import
`app/renderer.js`.

Instrument helpers such as `instrumentInfoFor`, `ensureInstrument`, `tickSize`, and quote/spread
formatters are migration compatibility APIs for existing renderers. New renderer extensions should
not use them to make business decisions. Quote-derived action availability, tick-size-dependent
validation, provider metadata checks, risk checks, and trade-rule errors should come from snapshots
or action preview/validation responses.

The shell does not expose renderer row providers, row render layers, or legacy renderer guards.
`order-cards:changed` is not a card creation extension point.

## Examples

Regular cards are registered by `app/services/orderCards/manifest.js`:

```js
const rendererHandlers = [{
  cardType: 'regular',
  register(context = {}) {
    const runtime = context.cardRuntime;
    runtime.registerCardView('regular-position-view', createRegularPositionView);
    runtime.registerCardControl('regular-position-actions', createRegularPositionActionsControl);
    runtime.registerCardShape('regular-position-card', createRegularPositionCard);
    runtime.registerCardType({
      type: 'regular',
      view: 'regular-position-view',
      controls: ['regular-position-actions'],
      shape: 'regular-position-card'
    });
  }
}];
```

Level-order and option cards follow the same registry contract from their owning manifests. A card
type may define a snapshot `match` function and `onRemovePosition`, but it may not define row
matching or row lifecycle callbacks.

## Rules

- Do not import `app/renderer.js` from services.
- Do not add module-specific card logic directly to the renderer shell.
- Keep main-only top-level imports out of renderer-loaded manifests.
- Prefer service-local renderer modules for module UI and action mapping.
- Register every snapshot card through a card type plus named view, controls, and shape.
- Treat `Position` snapshots as lifecycle truth.
- Treat application/read-model validation as action truth. Renderer code may do shallow UX checks on
  local draft input, but it must display trading validation errors and disabled action reasons from
  `card.validation`, `card.actions`, or preview responses.
- Do not add new direct renderer dependencies on trading rule validators or new quote/tick/provider
  metadata checks that decide whether a business action is allowed.

## Troubleshooting

Set `ISCC_DEBUG_POSITION_EVENTS=1` in development to trace manifest loading, handler registration,
`positions:changed`, snapshot composition, and missing renderer mappings.
