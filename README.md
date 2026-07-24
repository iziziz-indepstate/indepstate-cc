# Order Execution Gateway

Electron application that executes trading orders received from various sources through pluggable adapters. Order cards remain in the interface after an order is placed and collapse to a header with a colored status dot that reflects the position lifecycle:

- **blue** – order placed, waiting for fill
- **yellow** – position opened
- **gray** – position closed but broker-reported realized P&L is unavailable
- **green/red** – position closed in profit/loss

A lightweight event bus emits `order:placed`, `position:opened`, `position:closed` and `order:cancelled` so other parts of the app can react to changes.

## Configuration

Default configuration files live in each service's `config/` directory (for example `app/services/orderCards/config`). To customize any of them, copy the file to a `config/` directory in the project root and adjust as needed. On startup the application deep‑merges local overrides onto the bundled defaults.

Example:

```bash
mkdir -p config
cp app/services/orderCards/config/order-cards.json config/order-cards.json
```

Notable configuration files include:

- [`app/services/brokerage/config/execution.json`](app/services/brokerage/config/execution.json) – execution providers and adapter settings.
- [`app/services/orderCards/config/order-cards.json`](app/services/orderCards/config/order-cards.json) – sources for incoming order cards.
- [`app/services/tradeRules/config/trade-rules.json`](app/services/tradeRules/config/trade-rules.json) – validation rules applied before orders are sent.
- [`app/services/dealTrackers/config/deal-trackers.json`](app/services/dealTrackers/config/deal-trackers.json) – trackers invoked when positions close.
- [`app/services/dealTrackers-source-tv-log/config/tv-logs.json`](app/services/dealTrackers-source-tv-log/config/tv-logs.json) – directories containing TradingView CSV logs.
- [`app/services/dealTrackers-source-mt5-log/config/mt5-logs.json`](app/services/dealTrackers-source-mt5-log/config/mt5-logs.json) – directories containing MetaTrader reports.
- [`app/services/dealTrackers-chartImages/config/chart-images.json`](app/services/dealTrackers-chartImages/config/chart-images.json) – chart screenshot service settings.
- [`app/services/instrumentInfo/config/tick-sizes.json`](app/services/instrumentInfo/config/tick-sizes.json) – tick size overrides for instrument metadata and point calculations.

## Services

- **Execution Adapters** – registry that builds and caches connectors to execution providers. [Details](docs/execution-adapters.md)
- **Order Cards** – loads cards from sources like webhooks or files. [Details](app/services/orderCards/README.md)
- **Trade Rules** – validates orders before execution. [Details](app/services/tradeRules/README.md)
- **Deal Trackers** – persist closed trades or forward them elsewhere. [Details](app/services/dealTrackers/README.md)
- **Deal Trackers: Chart Images** – queues chart screenshots for use in notes. [Details](app/services/dealTrackers-chartImages/README.md)
- **Deal Trackers: TradingView Log Source** – turns TradingView order logs into closed trade events. [Details](app/services/dealTrackers-source-tv-log/README.md)
- **Deal Trackers: MT5 Log Source** – parses MetaTrader 5 reports for closed trades. [Details](app/services/dealTrackers-source-mt5-log/README.md)
- **Webhooks** – converts raw webhook payloads into order card rows. [Details](app/services/webhooks/README.md)
- **Command Line** – text interface for quick actions. [Details](docs/command-line.md)
- **Instrument information** – centralizes quotes, trading metadata, tick-size overrides, and point conversion. [Details](docs/instrument-info.md)
- **Order Calculator** – shared stop-loss, take-profit and position sizing math. [Details](docs/order-calculator.md)
- **Event Bus** – broadcasts order lifecycle events. [Details](docs/events.md)
- **Actions Bus** – routes service events to command runners for automation. [Details](docs/actions-bus.md)
- **TV Listener** – watches TradingView messages and surfaces automation hooks. [Details](docs/tv-listener.md)

## Documentation

See [docs/](docs/README.md) for an overview of the codebase and additional documentation.
