# Target Architecture

This document describes the target shape of the refactoring. It is the north star for moving from legacy order cards toward positions, commands, events, and composable UI.

See [architecture-layers.md](architecture-layers.md) for the layer dependency rules.

## Core Idea

The app is centered around `Position`.

A `Position` is a domain aggregate describing one logical broker position. It owns state transitions and invariants, but it does not call broker providers, Electron IPC, the renderer, files, or network APIs.

Former "cards" become different position compositions. A level-order card is not a subclass of `Position`; it is a `Position` with a level-order opening policy and card metadata.

## Position Snapshot

Each position exposes a snapshot for read models and UI rendering:

```js
{
  id,
  status,
  symbol,
  qty,
  provider,
  pnlSnapshot,
  timestamps,
  card: {
    type,
    actions,
    data
  }
}
```

- `card.type` selects the card renderer.
- `card.actions` describes commands available from the current state.
- `card.data` describes readable fields for renderer components.

The snapshot is not a DOM contract. It is an application read model that interface adapters can map into renderer view models.

## Command And Event Flow

Commands request work. Events describe facts that already happened.

- UI, CLI, webhooks, files, and other interfaces send commands.
- Application services route commands to factories or aggregates.
- Aggregates validate invariants and return domain events or integration commands.
- Infrastructure executes integration commands through providers.
- Providers report external events back.
- Application services map external events into aggregate commands.
- Aggregates update state and emit domain events.
- Interfaces react to read-model updates and re-render.

The domain never emits IPC events directly. IPC, provider payloads, JSON logs, and renderer events are mapping concerns in infrastructure or interfaces.

## Composition Root

`app/main.js` should be a composition root:

- create the Electron window;
- load extension services;
- create domain/application services;
- create infrastructure adapters;
- connect buses, providers, IPC, logs, and read-model publishers;
- avoid owning trading decisions or position lifecycle logic.

## Extension Services

Extension modules may recursively mirror the base architecture:

```text
app/services/<extension>/
  domain/
  application/
  infrastructure/
  interfaces/
```

Extension-specific position policies, factories, provider bridges, and UI adapters belong inside that extension. Cross-extension concepts belong under top-level `app/domain`, `app/application`, `app/infrastructure`, or `app/interfaces`.

`LevelOrder` is an extension. Its target shape is:

```text
app/services/levelOrder/
  application/
    LevelOrderApplicationService.js
    levelOrderRuntime.js
  domain/
    LevelOrderOpeningPolicy.js
  infrastructure/
    providerBridge.js
  interfaces/
    cardRenderer.js
```

The exact files can evolve, but the dependency direction should not.

## Target LevelOrder Flow

Canonical flow:

1. The application starts and `main.js` composes the level-order extension factory.
2. A command like `levelOrder ADAUSDT ...` enters through an interface adapter.
3. The command is routed to the level-order factory.
4. The factory creates a new `Position` with `LevelOrderOpeningPolicy`.
5. The position emits a `position.created` domain event.
6. A read-model publisher exposes the position snapshot.
7. The UI receives the snapshot and asks the card renderer registry for `card.type === "levelOrder"`.
8. The renderer builds a composite card from available `card.actions` and `card.data`.
9. The user presses `LB`.
10. The action control sends an open-level command through the bus.
11. The aggregate checks invariants and emits an opening request event/integration command.
12. Infrastructure listens, calls the configured provider, and submits broker orders.
13. The provider reports placement/opening/closing feedback.
14. Infrastructure maps provider feedback into application commands.
15. The application routes commands back to the related aggregate.
16. The aggregate updates state and emits domain events.
17. Read models and interfaces update the card.

## Target Card Rendering

The renderer should become a composite renderer:

- Card renderer registry selects by `card.type`.
- Data renderers select by available `card.data` keys.
- Action renderers select by available `card.actions`.
- Controls do not mutate lifecycle state locally. They send commands.
- Renderer state can cache view details, but aggregate snapshots are the source of lifecycle truth.

Legacy renderer maps such as `cardStates`, `pendingByReqId`, `ticketToKey`, and `placedOrderByKey` should gradually move into application read models or infrastructure bridges.

## Target Provider Boundary

Providers are infrastructure adapters.

- Application services produce execution commands.
- Provider bridges translate those commands into adapter calls such as `placeOrder`, `cancelOrder`, `closePosition`, `getQuote`, and `getHistoricBars`.
- Provider events are mapped back into application commands or external-event DTOs.
- Provider payloads should not leak into domain aggregates.

## Current Migration Direction

The current codebase is moving toward this target in slices:

- `Position` domain and snapshots are being introduced first.
- Generic execution orchestration is being extracted from `main.js`.
- IPC registration is moving to `infrastructure/`.
- `LevelOrder` application logic is moving under `app/services/levelOrder/application`.
- Renderer compatibility events stay in place until the composite renderer and read models are ready.
