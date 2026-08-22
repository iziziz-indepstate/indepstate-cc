# Order Cards Service

Loads order card definitions from pluggable sources and turns supported rows into position
snapshots for the renderer.

## Application Flow

The main-process application service is registered from `manifest.js` during the
`before-window` application-service phase.

Flow:

1. A regular-card source emits a row from a webhook, watched file, `add` command, or another legacy
   source adapter.
2. `orderCards.ingestRow(row, context)` normalizes `ticker`/`symbol`, detects
   `instrumentType`, and resolves the execution provider.
3. The facade calls `positions.createFromInput(row, context)`, which applies registered
   `PositionInputAdapter`s, adapts the row into `PositionCommand.CREATE`, and creates the snapshot.
4. After successful position creation, the row read model is updated and `order-cards:changed` is
   published for source compatibility and diagnostics.
5. Position creation/update publishes `positions:changed`; the renderer chooses the card UI by
   `position.card.type`.

## Snapshot Contract

All rows create position snapshots, including the built-in card types:

- `regular`
- `levelOrder`
- `option`
- `optionstrat`

Unknown `cardType` values are preserved on the snapshot. If no renderer mapping is registered for
that type, card runtime diagnostics report the missing composition; there is no fallback renderer.

## Renderer Runtime

`orderCards` owns the shared renderer config runtime for regular snapshot cards. The service-local
renderer bootstrap in `manifest.js` registers:

- regular position-card rendering;
- card button rows and button config;
- bid/ask and spread display policy;
- card-state refresh hooks.

Module-specific card renderers should be registered by their owning service manifests. They should
not be hard-coded in `app/renderer.js`. Module commands can also call `positions.createFromInput`
directly; they do not depend on the `orderCards` service.

## Configuration

Sources are defined in `app/services/orderCards/config/order-cards.json`.
Copy this file to the `config` directory under the application's user data path to override the
defaults.

Each entry declares a `type` and options.

### Source Types

- `webhook` - accepts rows parsed by the [webhooks service](../webhooks/README.md).
- `file` - watches a JSON file and emits cards when it changes.

## Regression Coverage

- `test/commandLineAddPositionIntegration.test.js` covers module command ingestion without
  `orderCards`, plus the regular compatibility facade and positions IPC publishing.
- `test/orderCardsApplicationService.test.js` covers unconditional snapshot creation, including an
  unregistered renderer type.

For development troubleshooting, set `ISCC_DEBUG_POSITION_EVENTS=1` to trace order-card ingestion,
routing, `order-cards:changed`, and related position events.
