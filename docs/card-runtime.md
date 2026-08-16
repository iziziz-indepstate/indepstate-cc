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

When a card type declares `legacyInstrumentTypes` or `legacyCardTypes`, the runtime composes the transitional row handler from its registered `view`, `controls`, and `legacyRow` callbacks and connects it to the `orderCards` renderer automatically. Services should not call `registerOrderCardInstrumentHandler` or `registerOrderCardTypeHandler`; those methods are deprecated internal compatibility bridges for unmigrated services and tests.

## Service-Owned Registration

Each service owns the mappings that are specific to its aggregate, provider, strategy, or legacy adapter:

- `orderCards` registers regular/manual order cards, standard order controls, and the legacy row adapter while row-backed cards still exist.
- `optionstrat` registers option card shapes, option legs views, payoff and valuation views, OptionStrat open/close controls, and option-specific reconciliation.
- `levelOrder` registers level-order controls, level input views, level-order position card views, and LB/LS action behavior.

Service manifests should populate the runtime registries during renderer bootstrap. Service-specific card bodies, validation UI, action payload mapping, and removal/reconciliation behavior should stay in the owning service.

## State And Lifecycle Rules

Position snapshots and application read models remain authoritative for lifecycle state. Renderer-local state may cache presentation details or bridge compatibility gaps, but it should not become a second aggregate model.

Controls should send commands or IPC requests and let application services and aggregates decide outcomes. They may optimistically mark renderer state as pending for feedback, but reconciliation must come from command results, provider events, or updated read models.

Legacy maps such as pending request labels, placed order lookup, card visual state, and ticket binding should live behind shell-owned runtime facades. During migration, modules may consume those facades through injection. Long term, durable lifecycle state should move into application read models or infrastructure bridges.

## Migration Direction

The current renderer still contains legacy order-card runtime behavior, and `orderCards` still exposes some generic-looking state bridges. That is transitional.

The target migration is:

1. Move generic renderer state facades out of `orderCards` and into the shell card runtime.
2. Keep `orderCards` as the adapter for regular/manual order cards and legacy rows.
3. Register `optionstrat`, `levelOrder`, and later card types through card runtime registries.
4. Promote stable registry contracts once multiple services use the same concepts.
5. Delete legacy guards and row adapters when snapshot-backed read models fully replace them.
