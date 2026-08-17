# Card Runtime

The card runtime is the renderer infrastructure subsystem that adapts application read models into shell cards.

It is not a domain abstraction. Positions and order aggregates remain the source of lifecycle truth. The card runtime only describes how snapshots, actions, and transitional legacy rows are presented and controlled in the renderer shell.

## Architectural Role

The runtime belongs to the infrastructure/interface side of the app:

- It maps position snapshots, application read models, and legacy order rows into renderer view models and DOM.
- It defines reusable card concepts such as controls, views, shapes, and card type registration.
- It owns renderer-local compatibility state while that state still exists.
- It sends commands through application or IPC boundaries when users act.
- It does not enforce domain invariants, decide aggregate transitions, or treat UI state as lifecycle truth.

The dependency direction should be:

```text
domain/application aggregates and read models
  -> renderer shell card runtime
       <- orderCards registers regular/legacy mappings
       <- optionstrat registers option mappings
       <- levelOrder registers level-order mappings
```

`orderCards` is therefore one module using the runtime. It should not be the owner of generic card infrastructure.

## Shell-Owned Concepts

The renderer shell owns the generic runtime surface:

- **Card type registry**: selects a card definition by `card.type`, instrument type, or a transitional legacy row match.
- **Control registry**: reusable action controls such as open, close, remove, cancel pending, retry, or module-defined controls.
- **View registry**: reusable visual fragments such as status badges, identity headers, order detail fields, option legs, payoff summaries, valuation fields, and position data grids.
- **Shape registry**: reusable card composers that arrange views and controls into concrete layouts.
- **Renderer state facades**: compatibility stores for pending requests, placed orders, visual state, and ticket bindings.
- **Legacy row presentation adapter**: transitional status, pending/placed/profit/loss, compact-card, retry, cancel/close, restore, and handler-hook reconciliation for row-backed cards.
- **Lifecycle slots**: shared hooks for render, validate, act, reconcile, restore, and remove behavior.

These concepts should be exposed through narrow registration APIs and injected dependencies rather than by importing a specific card module.

Conceptual API shape:

```js
cardRuntime.registerCardType({
  type: 'option',
  match: snapshotOrRow => snapshotOrRow.card?.type === 'option',
  shape: 'trade-card',
  views: ['identity', 'optionLegs', 'payoff', 'valuation', 'status'],
  controls: ['openOption', 'closeOption', 'remove'],
  legacyInstrumentTypes: ['OPT'],
  legacyCardTypes: ['option', 'optionstrat'],
  legacyRow: {
    title: ({ row }) => row.name || row.ticker,
    matchesExistingRow: ({ incomingRow, existingRow, rowKey }) => rowKey(incomingRow) === rowKey(existingRow)
  },
  actions: {
    open: context => context.commands.send('position.open', context.payload),
    close: context => context.commands.send('position.close', context.payload)
  }
});

cardRuntime.registerCardView('optionLegs', renderer);
cardRuntime.registerCardControl('closeOption', factory);
cardRuntime.registerCardShape('trade-card', composer);
```

This is a registry/composition contract, not a base-class hierarchy. A service can reuse library views, controls, and shapes, or register specialized ones when its card semantics require them.

### Snapshot Card Composition

`cardRuntime.createPositionCard(position, context)` is the shell-facing snapshot composition helper. It resolves the card definition with `resolveCardType(position, { kind: 'position' })`, resolves the named `view`, every named entry in `controls`, and the named `shape`, then calls the shape with the composed parts.

The stable snapshot definition fields are:

- `type` and/or `match` for selection;
- `view` for the service-owned body renderer;
- `controls` for service-owned or shared controls;
- `shape` for final DOM composition;
- optional `onRemovePosition(position, context)` for renderer cleanup.

The shape receives `position`, `key`, `title`, `body`/`view`, snapshot `actions`, resolved `controls`, `requestRemove`, `createActionsFromSnapshot`, and injected renderer dependencies. The shell may build `createActionsFromSnapshot` from its generic `dispatchPositionAction` helper, but shapes should depend on the composed callback name. If the definition or any named component required for composition is absent, `createPositionCard()` returns `undefined`; the shell then uses the transitional `positionCardRenderers` fallback. The helper composes presentation only and does not store or infer lifecycle state.

## Built-In Card Library

The shell-owned library in `app/infrastructure/renderer/cardRuntime/library.js` provides the shared DOM composition used by regular cards:

```js
const { createCardRuntimeLibrary } = require('../../infrastructure/renderer/cardRuntime/library');

const library = createCardRuntimeLibrary({
  el,
  btn,
  document,
  formatValue,
  createActionButton
});
```

Its public surface is grouped by responsibility:

- `views.createHeaderView`, `views.createStatusView`, and `views.createDataGridView` create standard card fragments and position field grids.
- `controls.createRemoveControl`, `controls.createRetryControl`, and `controls.createActionButtonsControl` preserve the standard close, retry, and `data-kind` action-button contracts.
- `shapes.createLegacyCardShape` and `shapes.createPositionCardShape` compose the regular legacy-order and position shells from injected bodies, actions, callbacks, status, compact mode, and attributes.

During renderer bootstrap, `orderCards` registers these reusable entries in `cardRuntime`:

| Registry | Name |
| --- | --- |
| Shape | `regular-order-legacy-card` |
| Shape | `regular-position-card` |
| Control | `standard-remove` |
| Control | `standard-retry` |
| Control | `standard-action-buttons` |
| View | `position-data-grid` |

Other renderer modules can resolve them through `getCardShape`, `getCardControl`, and `getCardView`. The library only owns generic DOM composition. `orderCards` continues to own the EQ/FX/CX input bodies, sizing and validation, placement, regular action semantics, legacy row ingestion, and private handler lookup. Specialized modules such as `optionstrat` and `levelOrder` may adopt the named library pieces independently.

When a card type declares `legacyInstrumentTypes` or `legacyCardTypes`, the runtime composes the transitional row handler from its registered `view`, `controls`, and `legacyRow` callbacks and connects it to the `orderCards` renderer automatically. The former public APIs `registerOrderCardInstrumentHandler` and `registerOrderCardTypeHandler` have been removed. Legacy row integration is available only through card type definitions registered with `registerCardType({ legacyInstrumentTypes, legacyCardTypes, view, controls, legacyRow })`.

`orderCards` no longer publishes legacy row state or handler APIs such as `orderCardsState`, `setLegacyOrderCardState`, `orderCardHandlerFor`, or `orderCardHandlerForKey` in the renderer context. It injects private row/card lookup, handler lookup, state facades, IPC, and shell callbacks into `cardRuntime/legacyRowPresentation.js`. The resulting shell-owned `setCardState` callback is shared by the regular renderer, `legacyOrderListRuntime`, and `cardRuntime.connectLegacyOrderCardRenderer({ renderer, getRows, rowKey, setCardState })`. Modules that still need transitional row access use the shell-owned `cardRuntime.legacyRows`, `cardRuntime.findLegacyRowByKey`, and `cardRuntime.setLegacyRowCardState` facades together with card type definitions.

## Service-Owned Registration

Each service owns the mappings that are specific to its aggregate, provider, strategy, or legacy adapter:

- `orderCards` registers regular/manual order cards and standard order controls, supplies legacy rows and the regular renderer implementation, and injects its private lookups into the shell-owned legacy row presentation adapter while row-backed cards still exist.
- `optionstrat` registers option card shapes, option legs views, payoff and valuation views, OptionStrat open/close controls, and option-specific reconciliation.
- `levelOrder` registers level-order controls, level input views, level-order position card views, and LB/LS action behavior.

The legacy `registerPositionCardRenderer`, `registerPositionActionHandler`, and `registerPositionRemovalHandler` methods remain transitional compatibility APIs for card types that have not completed this migration. New snapshot implementations should use the card type/view/control/shape registries and `onRemovePosition`.

Service manifests should populate the runtime registries during renderer bootstrap. Service-specific card bodies, validation UI, action payload mapping, and removal/reconciliation behavior should stay in the owning service.

## State And Lifecycle Rules

Position snapshots and application read models remain authoritative for lifecycle state. Renderer-local state may cache presentation details or bridge compatibility gaps, but it should not become a second aggregate model.

Controls should send commands or IPC requests and let application services and aggregates decide outcomes. They may optimistically mark renderer state as pending for feedback, but reconciliation must come from command results, provider events, or updated read models.

Legacy maps such as pending request labels, placed order lookup, card visual state, and ticket binding should live behind shell-owned runtime facades. During migration, modules may consume those facades through injection. Long term, durable lifecycle state should move into application read models or infrastructure bridges.

## Migration Direction

The current renderer still contains a row-backed legacy order-card path. Its generic presentation and reconciliation behavior now lives in the shell card runtime, while `orderCards` supplies rows and the regular renderer implementation. That path remains transitional.

The target migration is:

1. Keep generic renderer state, legacy row presentation, and legacy row access behind the shell card runtime facades.
2. Keep `orderCards` as the source for regular/manual order cards and legacy rows without exporting its private row state or handlers into renderer context.
3. Register `optionstrat`, `levelOrder`, and later card types through card runtime registries.
4. Promote stable registry contracts once multiple services use the same concepts.
5. Delete the remaining row-backed path, legacy guards, and transitional presentation adapter when snapshot-backed read models fully replace them.
