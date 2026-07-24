# AGENTS.md

## Project Snapshot
- This repo is an Electron/Node.js trading control panel (`ISCC`).
- The app collects trade-intent signals from manual input, webhooks, files, TradingView/MT5 logs, API-like service events, and algorithmic triggers.
- It turns those signals into order cards, validates/sizes orders, selects a broker/provider, and submits/cancels/tracks execution from one UI.
- It also supports deferred/pending execution rules such as waiting for bar events, consolidation/false-break/limit-by-current strategies, and retry/confirmation flows.

## Runtime Shape
- Main process entrypoint: `app/main.js`; renderer/UI: `app/renderer.js`, `app/index.html`, `app/preload.js`.
- Services live under `app/services/*`; most service docs are either in `docs/*.md` or the service's own `README.md`.
- Tests are plain Node scripts under `test/*.test.js`; `npm test` runs the project test suite.
- Packaging/build is Electron Builder: `npm run build`; local app run is `npm start`.

## Module System
- Modules are service folders listed in `app/services/settings/config/services.json`.
- Startup calls `loadServices()` in `app/main.js`; each listed service is loaded via `app/services/<name>/manifest.js`.
- A manifest usually exports `initService(servicesApi)` and either:
  - attaches APIs to shared `app/services/servicesApi.js` (for example `servicesApi.brokerage`), or
  - registers factories/commands/settings as side effects.
- Service config defaults live in each service's `config/*.json`; descriptors live beside them as `*-settings-descriptor.json`.
- Local/user overrides are loaded by `app/config/load.js` from `config/` in the repo/app root and user config roots, deep-merged onto defaults.

## Order Flow
- Order card sources are configured in `app/services/orderCards/config/order-cards.json`.
- Webhook payloads are parsed by `app/services/webhooks/*`; file/webhook sources become rows emitted to the renderer as `orders:new`.
- The UI queues execution over IPC (`queue-place-order` or `queue-place-pending`).
- `app/main.js` normalizes payloads, assigns `cid`, validates required fields, computes risk-based qty when possible, checks trade rules, and calls a brokerage adapter.
- Lifecycle events are emitted through `app/services/events.js`: `order:placed`, `position:opened`, `position:closed`, `order:cancelled`.
- Execution records are JSONL logs in Electron userData logs, notably `executions.jsonl`.

## Broker/Provider Adapters
- Provider selection comes from `app/services/brokerage/config/execution.json` (`default`, `byInstrumentType`, `providers`).
- `app/services/brokerage/adapterRegistry.js` builds and caches adapters by provider name.
- Adapter factories register into `app/services/brokerage/brokerageAdapters.js`.
- Broker adapter modules follow `app/services/brokerage-adapter-*`; examples: `ccxt`, `dwx`, `j2t`, `simulated`.
- Adapter surface is documented by `app/services/brokerage/comps/base.js`: at minimum `placeOrder(order)`, often `getQuote`, `cancelOrder`, `listOpenOrders`, `listClosedPositions`, `getHistoricBars`, and event emitter hooks.
- If adding a broker, create a `brokerage-adapter-<name>` service with `manifest.js`, register a lowercase factory key, add config, and document it.

## Commands And Automation
- Text commands are implemented in `app/services/commands/*`; current core commands include add/remove.
- `app/services/commandLine/index.js` resolves command names/aliases and can accept extra command objects.
- The actions bus (`app/services/actions-bus`) maps service events to command strings and runtime UI toggles. See `docs/actions-bus.md`.
- TradingView automation uses `tvProxy`/`tvListener` services; see `docs/tv-proxy.md` and `docs/tv-listener.md`.

## Pending Orders
- Pending execution is coordinated by `app/services/pendingOrders/hub.js`.
- Strategy construction is in `app/services/pendingOrders/factory.js`; built-ins include `consolidation`, `falseBreak`, and `limitByCurrent`.
- Strategy defaults are in `app/services/pendingOrders/config/pending-strategies.json`.
- Pending orders subscribe to provider/symbol bar data, react to `bar` events, and call the normal order queue once trigger rules are satisfied.

## Important Docs
- Repo overview: `README.md`, `docs/README.md`.
- Execution adapters: `docs/execution-adapters.md`.
- Order cards: `app/services/orderCards/README.md`, `docs/OrderCardsConfig.md`.
- Level-order cards: `docs/level-order.md`.
- Trade rules: `app/services/tradeRules/README.md`.
- Order math: `docs/order-calculator.md`.
- Events: `docs/events.md`.
- Deal trackers/log sources: `app/services/dealTrackers*/README.md`.

## Working Conventions
- Keep this `AGENTS.md` short and high-signal; if future notes need more detail, put extensions under `docs/AGENTS.md.parts/` and link them from here.
- Put user-facing feature docs in `docs/*.md`; use service-local `README.md` mainly for low-level service, adapter, or source-specific details.
- Use CommonJS style (`require`, `module.exports`) unless a touched area already differs.
- Keep service changes modular: prefer adding/extending a service, manifest, config, and docs instead of hard-wiring behavior in unrelated files.
- Preserve config override behavior; do not edit user/root `config/*.json` unless explicitly requested.
- When adding service settings, update both default config and `*-settings-descriptor.json`, and register it through the settings service if it should appear in UI/config tools.
- Add focused Node tests in `test/*.test.js` for new parsing, command, strategy, adapter-registry, settings, or execution behavior.
- Before finishing code changes, run the smallest relevant test first; use `npm test` when behavior touches shared execution/order flow.
- For GitHub releases, verify `dist/latest.yml` references asset filenames that exactly match the uploaded release assets before publishing; electron-updater depends on those names.
