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
    openingPolicy.js
  infrastructure/
    providerBridge.js
  interfaces/
    renderer/
      renderer.js
```

The exact files can evolve, but the dependency direction should not. During the renderer migration, service-local renderer modules such as `app/services/levelOrder/infrastructure/renderer/renderer.js` are the home for extension-specific card rendering and action mapping; the top-level renderer composes them through registries populated from service manifests.

Generic services are open for extension through composition. A card type that needs special execution behavior should provide a small service-local controller/policy and register it from its manifest. `main.js` should inject the accumulated controller registry into the generic application service. The generic execution service should ask those controllers for decisions instead of branching on `card.type`, strategy names, or service-specific metadata.

The position application adapter maps incoming rows and order payloads into position commands.
`orderCards.ingestRow` uses `rowToCreatePositionCommand` to adapt source rows into `Position`
snapshots. Services can register a `PositionInputAdapter` for service-owned ID, card-type, or opening
policy metadata. These adapters belong to ingestion/application mapping only; they are not renderer
extension points and must not decide whether a snapshot or a row owns the UI.

Service manifests are loaded by both the main process and the renderer. A manifest must therefore be renderer-safe at top level: do not `require()` Electron main-process modules, provider adapters, filesystem-only infrastructure, or other main-only dependencies while the manifest is being imported. Load those dependencies lazily inside main-only hooks such as `registerMainApplicationServices()` or IPC registration hooks.

Implemented main extension points:

- `mainApplicationServicePhase` selects when a manifest's application service is registered. The default phase is `after-execution`; services that must exist earlier, such as orderCards, can declare `before-window`.
- `registerMainApplicationServicesForManifests()` in `app/services/serviceMainRegistration.js` walks loaded service manifests and calls matching `registerMainApplicationServices(context)` hooks for the active phase.

Implemented renderer extension points:

- `hookRenderer(ipcRenderer)` for small renderer boot hooks such as keyboard shortcuts.
- `rendererHandlers` for general renderer service bootstrap.
- `rendererPositionHandlers` for position/card UI behavior.
- `registerCardType`, `registerCardView`, `registerCardControl`, and `registerCardShape` for runtime-composed position cards.
- `createPositionCard(position, context)` to resolve and compose a snapshot card exclusively from its registered type, view, controls, and shape.
- `onRemovePosition` on a card type definition for service-owned renderer cleanup.
- `registerInstrumentDisplayPolicy(policy)` to contribute shared instrument refresh/display behavior.
- `registerCardStateHook(hook)` to run shared card-state refresh hooks from a service-local runtime.

See [renderer-extension-points.md](renderer-extension-points.md) for the renderer shell API used by `handler.register(context)`.

## Target LevelOrder Flow

Canonical flow:

1. The application starts and service manifests register extension commands, execution controllers, and renderer handlers.
2. A command like `levelOrder ADAUSDT ...` enters through an interface adapter.
3. The command is routed to the level-order factory.
4. The factory creates a new `Position` with `LevelOrderOpeningPolicy`.
5. The position emits a `position.created` domain event.
6. A read-model publisher exposes the position snapshot.
7. The UI receives the snapshot and asks the manifest-populated card renderer registry for `card.type === "levelOrder"`.
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

The renderer should become a composite renderer backed by a shell-owned card runtime. See
[card-runtime.md](card-runtime.md) for the target infrastructure/interface subsystem that maps
position snapshots and application read models into shell cards.

- Card type registry selects by `card.type` or a service-owned snapshot matcher.
- View renderers select by available `card.data` keys and service-registered view names.
- Control renderers select by available `card.actions` and service-registered control names.
- Shape composers arrange reusable views and controls into concrete card layouts.
- Service manifests register extension-owned card types, views, controls, shapes, action handlers,
  and removal/reconciliation handlers into renderer registries.
- Controls do not mutate lifecycle state locally. They send commands.
- Renderer state can cache view details, but aggregate snapshots are the source of lifecycle truth.

Compact snapshot cards may render only identity and lifecycle status without action controls. For regular cards, missing compact-mode buttons does not violate `card.actions` as long as actions remain present in the snapshot and an expanded/full-card path or other control surface exists for invoking them.

Renderer-local maps such as `cardStates`, `pendingByReqId`, `ticketToKey`, and `placedOrderByKey`
remain transient interaction state behind shell-owned APIs. They do not own card rows or lifecycle
truth; reconciliation comes from `Position` snapshots.

`app/renderer.js` remains the shell/composition layer. New card-specific renderer behavior should be
added in service-local renderer modules and registered from the owning service manifest through
dependency injection from the shell. Do not add new level-order-only helpers, action flows, or
snapshot filters directly to `app/renderer.js`.

## Target Execution Extension Points

The generic execution application service owns shared order normalization, validation, provider selection, adapter calls, logs, and generic lifecycle events. It should not own card-specific meanings.

Extension services can contribute execution controllers with narrow hooks such as:

- how to normalize and validate module-specific execution payloads;
- whether an execution payload should create a standalone `Position`;
- how child execution records relate to a parent position/card;
- how a provider-specific close flow maps back into generic `order:closed` and position state;
- whether a provider event should be interpreted by an extension read model before generic lifecycle handling.

These controllers should live under the owning service, for example `app/services/levelOrder/application`, be registered by the service manifest, and be passed into the generic execution service as an accumulated registry.

Controller registration should also be manifest-owned. A service manifest should add its controllers to a shared registry, for example `servicesApi.executionCardControllers`, during `initService`. The composition root consumes that registry; it should not import each extension controller directly.

Implemented extension registries include:

- `servicesApi.executionPayloadPolicies` for module-specific payload normalization and validation.
- `servicesApi.executionCloseControllers` for provider/card-specific close post-processing.
- renderer registries populated from service manifests for card creation, action controls, and snapshot rendering.

## Target Provider Boundary

Providers are infrastructure adapters.

- Application services produce execution commands.
- Provider bridges translate those commands into adapter calls such as `placeOrder`, `cancelOrder`, `closePosition`, `getQuote`, and `getHistoricBars`.
- Provider events are mapped back into application commands or external-event DTOs.
- Provider payloads should not leak into domain aggregates.

Provider modules register infrastructure through `servicesApi.brokerage.registerAdapterFactory()`.
Provider-owned execution defaults, routing, and Settings descriptor fields are registered with
`servicesApi.brokerage.registerExecutionProviderDefaults()`. Shared brokerage config should not
hard-code defaults for optional provider modules.

## Target Settings And Automation Extension Points

Settings sections are registered by service manifests. Module-specific live/restart apply behavior
belongs in the fourth `settings.register()` argument, not in the central settings service.

Shared settings sections may accept module-owned default and descriptor fragments. These fragments
fill only missing values so user overrides keep priority.

Automation payload enrichment is also extension-owned. Shared outbound webhook code builds generic
lifecycle payload fields, while modules add provider/card-specific placeholders through
`servicesApi.outboundWebhooks.registerLifecycleEnricher()`.

## Current Migration Direction

The current codebase is moving toward this target in slices. The status below records what is already
true in the code and what remains.

### Completed

- `LevelOrder` is isolated as an extension-owned service with application logic, renderer handling,
  command registration, and manifest-owned wiring.
- `commandLine` is manifest-wired and creates snapshot-backed cards through `orderCards.ingestRow`
  for card-creating commands.
- The renderer dispatches snapshot cards through a manifest-populated registry keyed by
  `position.card.type`.
- The renderer has a shell-owned card runtime with card type, view, control, and shape registries.
- `orderCards` no longer owns generic card runtime infrastructure. It supplies regular snapshot
  bodies and actions while reusable card primitives live under the shell card runtime.
- Legacy order-card public APIs such as `registerOrderCardInstrumentHandler`,
  `registerOrderCardTypeHandler`, `orderCardsState`, `setLegacyOrderCardState`, and
  `orderCardHandlerFor*` have been removed from renderer context.
- `OptionStrat` is isolated as an extension-owned service. Its adapter, snapshot renderer behavior,
  IPC handlers, execution payload policy, close controller, settings policy, lifecycle
  enrichment, action helpers, and execution defaults live under `app/services/optionstrat`.
- Brokerage no longer hard-codes OptionStrat provider defaults. Optional provider modules register
  adapter factories and execution config defaults from their manifests.
- Settings no longer hard-codes OptionStrat apply policy. Module settings can declare live/restart
  behavior at registration time.
- Outbound webhooks no longer know OptionStrat payload shape. Module-specific lifecycle placeholders
  are contributed through lifecycle enrichers.
- `riskManager` base defaults no longer include OptionStrat, while unknown provider overrides remain
  supported by descriptor policy.
- Generic execution orchestration, IPC wiring, and renderer registries now have
  extension points that can be reused by later modules.
- `orderCards.ingestRow` always adapts source rows through `rowToCreatePositionCommand` and creates a
  `Position` snapshot. The legacy row renderer, routing split, runtime bridge, presentation adapter,
  and renderer guards have been removed.

### Remaining

- Continue moving order-card and position workflows from `app/main.js` and `app/renderer.js` into
  application/infrastructure/interface modules.
- Promote mature registries into clearer typed contracts once more modules use them.
- Apply the same isolation pass to the next module: move provider-specific config, rendering,
  payload mapping, lifecycle handling, settings policy, and automation enrichment into the owning
  service manifest.
- Keep documentation current as each extension point becomes stable enough for reuse.

## Regression Coverage

- `test/commandLineAddPositionIntegration.test.js` covers `commandLine` -> `orderCards.ingestRow` -> positions -> IPC publishing.
- `test/positionsRenderer.test.js` covers renderer dispatch by `position.card.type`.
- `test/orderCardsApplicationService.test.js` covers unconditional snapshot creation, including an
  unknown renderer type.
- `test/cardRuntime.test.js` and `test/cardRuntimeLibrary.test.js` cover snapshot registry
  composition and reusable card primitives.
- `test/orderCardsManifestRenderer.test.js` covers `orderCards` snapshot renderer bootstrap and
  built-in card runtime registrations.

For boot/event troubleshooting during development, set `ISCC_DEBUG_POSITION_EVENTS=1`. The trace logs renderer manifest loading, handler registration, position/order-card event routing, and related failures. Keep it dev-only; it is intended for diagnosing boot and event ordering issues, not normal user output.
