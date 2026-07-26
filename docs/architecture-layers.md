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

## Current Migration Notes

- `app/main.js` is being reduced to an Electron composition root.
- Generic execution use cases live in `app/application/execution`.
- Execution IPC registration lives in `app/infrastructure/execution`.
- Generic Electron IPC registration, such as window state and order-list read models, lives in `app/infrastructure/electron`.
- Level-order use cases live in `app/services/levelOrder/application`.
- Pending-order IPC registration lives in `app/services/pendingOrders/infrastructure`.
- Some legacy service manifests still register IPC directly. Future refactoring should move those handlers into each service's `infrastructure/` or `interfaces/` layer.
