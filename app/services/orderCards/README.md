# Order Cards Service

Loads order card definitions from pluggable sources and turns supported rows into position
snapshots for the renderer.

## Application Flow

The main-process application service is registered from `manifest.js` during the
`before-window` application-service phase.

Flow:

1. A source emits a row from a webhook, watched file, command-line command, or another service.
2. `orderCards.ingestRow(row, context)` normalizes `ticker`/`symbol`, detects
   `instrumentType`, and resolves the execution provider.
3. Every normalized row is adapted into a `PositionCommand.CREATE` command through
   `rowToCreatePositionCommand` and sent to the positions application service, which creates the
   `Position` snapshot.
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
not be hard-coded in `app/renderer.js`.

## Configuration

Sources are defined in `app/services/orderCards/config/order-cards.json`.
Copy this file to the `config` directory under the application's user data path to override the
defaults.

Each entry declares a `type` and options.

### Source Types

- `webhook` - accepts rows parsed by the [webhooks service](../webhooks/README.md).
- `file` - watches a JSON file and emits cards when it changes.

## Regression Coverage

- `test/commandLineAddPositionIntegration.test.js` covers `commandLine` -> `orderCards.ingestRow` -> positions -> IPC publishing.
- `test/orderCardsApplicationService.test.js` covers unconditional snapshot creation, including an
  unregistered renderer type.

For development troubleshooting, set `ISCC_DEBUG_POSITION_EVENTS=1` to trace order-card ingestion,
routing, `order-cards:changed`, and related position events.
