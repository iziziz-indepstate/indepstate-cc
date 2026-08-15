# Renderer Extension Points

Renderer behavior is registered by service manifests. The shell in `app/renderer.js` loads each
`app/services/<service>/manifest.js`, calls `hookRenderer(ipcRenderer)` when present, then calls
each object in `rendererHandlers` and `rendererPositionHandlers` with `handler.register(context)`.

Manifests must be renderer-safe at top level. Keep main-only dependencies out of top-level imports
and load them lazily inside main hooks such as `registerMainApplicationServices()`.

## Shell API

The `context` object passed to `handler.register(context)` exposes shell-owned dependencies and
registration functions. Common extension points are:

- `registerPositionCardRenderer(cardType, renderer)` selects a card renderer by `position.card.type`.
- `registerPositionActionHandler(cardType, handler)` handles actions from snapshot-backed cards.
- `registerPositionRemovalHandler(cardType, handler)` handles cleanup when a snapshot disappears.
- `registerInstrumentDisplayPolicy(policy)` contributes shared bid/ask/spread display policy.
- `registerCardStateHook(hook)` contributes card-state refresh behavior.
- `registerRendererLayer(layer)` adds a shell render pass. The layer receives `{ grid }` and may
  append service-owned DOM nodes.
- `registerRendererRowProvider(provider)` exposes service-owned rows to shared renderer utilities
  such as instrument refresh and legacy guard context.
- `registerPositionSnapshotHook(hook)` observes every `positions:changed` snapshot accepted by the
  shell, before the shell decides whether to render it.
- `registerPositionRemovedHook(hook)` handles service cleanup when a position snapshot is removed
  or archived.
- `registerRendererLegacyGuard(guard)` installs compatibility filters for legacy rows/events.

The context also injects renderer helpers such as `ipcRenderer`, `btn`, `render`, `toast`,
`positionKey`, `positionCardTitle`, `dispatchPositionAction`, `requestRemovePosition`, config
loading, settings runtime, instrument helpers, and generic card-state APIs for snapshot cards.
Treat these as injected dependencies from the shell; services should not import `app/renderer.js`.

## Minimal Examples

Regular cards are registered by `app/services/orderCards/manifest.js`:

```js
const rendererHandlers = [{
  cardType: 'regular',
  register(context = {}) {
    const rows = [];
    context.registerRendererRowProvider?.(() => rows);
    context.registerRendererLayer?.(({ grid } = {}) => {
      for (const row of rows) grid.appendChild(createLegacyOrderCard(row));
    });
    context.registerPositionSnapshotHook?.((position) => {
      removeRowsOwnedByPosition(position);
    });
    context.registerPositionRemovedHook?.((position) => {
      return removeRowsOwnedByPosition(position);
    });
    context.registerPositionCardRenderer?.('regular', (position) => {
      return createRegularPositionCard({ position });
    });
  }
}];
```

Level-order cards are registered by `app/services/levelOrder/manifest.js`:

```js
const rendererPositionHandlers = [{
  cardType: 'levelOrder',
  register(context = {}) {
    context.registerPositionActionHandler?.('levelOrder', actionHandler);
    context.registerPositionCardRenderer?.('levelOrder', positionRenderer);
    context.registerPositionRemovalHandler?.('levelOrder', removalHandler);
  }
}];
```

Option strategy cards register their supported card types from `app/services/optionstrat/manifest.js`:

```js
const rendererPositionHandlers = [{
  cardType: 'option',
  register(context = {}) {
    for (const cardType of ['option', 'optionstrat']) {
      context.registerPositionCardRenderer?.(cardType, renderOptionPosition);
    }
  }
}];
```

## Rules

- Do not import `app/renderer.js` from services.
- Do not add module-specific card logic directly to the renderer shell.
- Do not keep main-only top-level imports in a manifest that the renderer can load.
- Prefer service-local renderer modules for module UI and action mapping.
- Use `rendererLegacyGuards` only as transitional compatibility glue.

## Troubleshooting

Set `ISCC_DEBUG_POSITION_EVENTS=1` in development to trace renderer manifest loading, handler
registration, `positions:changed`, `order-cards:changed`, and related boot/event failures.
