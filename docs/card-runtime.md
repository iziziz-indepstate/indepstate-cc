# Card Runtime

The card runtime is renderer infrastructure that composes `Position` snapshots into shell cards.
It is not a domain abstraction: position aggregates and their application read models remain the
source of lifecycle truth.

## Architectural Role

The runtime sits on the infrastructure/interface side of the app:

- it resolves a snapshot renderer from `position.card.type` or a registered snapshot matcher;
- it composes registered views, controls, and shapes;
- it sends user actions through injected application or IPC boundaries;
- it invokes service-owned cleanup when a snapshot is removed;
- it does not accept or render order-card rows.

The dependency direction is:

```text
domain/application Position snapshots
  -> renderer shell card runtime
       <- orderCards registers regular snapshot composition
       <- optionstrat registers option snapshot composition
       <- levelOrder registers level-order snapshot composition
```

`orderCards` is one consumer of the runtime. Generic card infrastructure remains shell-owned.

## Registry API

Service manifests register snapshot components through:

```js
cardRuntime.registerCardView('option-snapshot', renderOptionSnapshot);
cardRuntime.registerCardControl('option-actions', createOptionActions);
cardRuntime.registerCardShape('option-card', composeOptionCard);
cardRuntime.registerCardType({
  type: 'option',
  view: 'option-snapshot',
  controls: ['option-actions'],
  shape: 'option-card'
});
```

The shell creates and cleans up cards through:

- `createPositionCard(position, context)`;
- `cleanupPositionCard(position, context)`.

There is no row-renderer connection API. Card definitions do not support `legacyRow`,
`legacyInstrumentTypes`, or `legacyCardTypes`, and the runtime does not expose legacy row lookup or
state mutation facades.

## Snapshot Composition

`createPositionCard()` resolves a definition with `resolveCardType(position, { kind: 'position' })`,
then resolves its named `view`, every named control, and its shape. Stable definition fields are:

- `type` and/or `match` for selection;
- `view` for the service-owned body renderer;
- `controls` for service-owned or shared controls;
- `shape` for final DOM composition;
- optional `onRemovePosition(position, context)` for cleanup.

Views, controls, and shapes receive a normalized context containing `position`, `key`, `title`,
`requestRemove`, `createActionsFromSnapshot`, and injected renderer dependencies. If the card type or
any required component is missing, `createPositionCard()` returns `undefined`; renderer diagnostics
then report that no runtime composition is available. An unknown `card.type` never falls back to a
row renderer.

## Built-In Library

`app/infrastructure/renderer/cardRuntime/library.js` provides reusable snapshot primitives:

- header, status, and data-grid views;
- remove, retry, and action-button controls;
- `createPositionCardShape` for the standard position shell.

During renderer bootstrap, `orderCards` registers:

| Registry | Name |
| --- | --- |
| Shape | `regular-position-card` |
| Control | `regular-position-actions` |
| View | `position-data-grid` |
| View | `regular-position-view` |

`optionstrat` and `levelOrder` register their own snapshot views, controls, shapes, and types from
their service manifests.

## State and Lifecycle

Renderer-local state may cache transient interaction details, but it must not become a second
aggregate model. Controls send commands; reconciliation comes from updated `Position` snapshots.
Periodic option valuation also enumerates current snapshots and updates their read-model data rather
than looking up mutable order-card rows.

`order-cards:changed` remains a source/read-model compatibility and diagnostic event. It is not a
card creation signal. Renderer card creation is driven exclusively by `positions:list` and
`positions:changed`.
