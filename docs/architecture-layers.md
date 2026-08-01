# Architecture Layers

This project uses layered module boundaries for core app code and for extension services.

## Layers

- `domain/` describes an isolated business area. Domain code must not know about Electron, IPC, broker SDKs, files, timers, HTTP, or UI. It owns entities, aggregates, value objects, domain commands, domain events, invariants, and pure state transitions.
- `application/` describes use cases: how a task is solved with the domain model. Application code may depend on `domain/`, but should not own Electron IPC registration, DOM rendering, or provider SDK wiring.
- `infrastructure/` describes the outside world and how use cases are reflected there. IPC handlers, broker/provider adapters, file/log adapters, timers, and external event bridges belong here. Infrastructure may depend on `application/`.
- `interfaces/` describes user-facing or machine-facing entry points such as UI, web, REST, CLI, or renderer adapters. Interfaces accept requests, call applications, and present feedback.

## Dependency Rule

Dependencies flow inward by business meaning and outward by composition:

- `domain` is fully isolated.
- `application` may use `domain`.
- `infrastructure` may use `application`.
- `interfaces` may call `application` and may connect to `infrastructure` adapters to receive external feedback.
- `main.js` is the composition root: it creates services, wires dependencies, and registers infrastructure/interface adapters.

Avoid importing Electron, renderer modules, provider SDKs, or filesystem adapters from `domain/` or `application/`.

## Extension Services

Extension services under `app/services/<serviceName>/` may mirror the same layer structure recursively:

```text
app/services/levelOrder/
  domain/
  application/
  infrastructure/
  interfaces/
```

A service should keep its extension-specific domain/application/infrastructure code inside its own service folder. Core folders under `app/domain`, `app/application`, `app/infrastructure`, and `app/interfaces` are reserved for cross-extension app concepts.

For example, `LevelOrder` is an extension. Its application service and runtime helpers live under `app/services/levelOrder/application`, while generic execution orchestration lives under `app/application/execution`.

Renderer code follows the same boundary. `app/renderer.js` may host the legacy shell, shared DOM helpers, renderer-wide stores, and card/action registries, but extension-specific card bodies, snapshot-card renderers, action payload mapping, and validation UI should live with the extension, for example `app/services/levelOrder/renderer.js`. Pass shared renderer dependencies into those modules instead of importing the whole renderer from a service.

Extension-specific renderer registrations should be declared by the owning service manifest, not hard-coded in `app/renderer.js`. A service can export renderer position handler installers, such as `rendererPositionHandlers`, that receive shell dependencies and register card renderers, action handlers, and removal handlers by `card.type`. The renderer shell should expose registry functions and consume manifest registrations; it should not build per-extension registry entries inline.

Generic application services should be extended by composition, not by adding card-specific branches. If a core service such as `app/application/execution` needs extension-specific decisions, inject small controllers/policies from the owning service folder. The owning service manifest should register those controllers into a shared registry such as `servicesApi.executionCardControllers`; the composition root then passes the registry to the generic application service. `ExecutionApplicationService` should not know about `levelOrder`, `limitBidTrade`, or any other extension-specific strategy names.

## Current Migration Notes

- `app/main.js` is being reduced to an Electron composition root.
- Generic execution use cases live in `app/application/execution`.
- Extension-specific execution decisions are registered by service manifests and injected into generic execution use cases through service-local controllers/policies.
- Execution IPC registration lives in `app/infrastructure/execution`.
- Generic Electron IPC registration, such as window state and order-list read models, lives in `app/infrastructure/electron`.
- Level-order use cases live in `app/services/levelOrder/application`.
- Level-order renderer/card-specific UI lives in `app/services/levelOrder/renderer.js`; keep new level-order UI behavior there and let `app/services/levelOrder/manifest.js` register it into renderer registries.
- Level-order execution policy hooks live under `app/services/levelOrder/application`; the level-order manifest registers them and core execution receives them through dependency injection.
- Pending-order IPC registration lives in `app/services/pendingOrders/infrastructure`.
- Some legacy service manifests still register IPC directly. Future refactoring should move those handlers into each service's `infrastructure/` or `interfaces/` layer.
