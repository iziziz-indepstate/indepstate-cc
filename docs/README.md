# Project Documentation

This directory contains high-level notes about the codebase.

## Overview
- `app/main.js` – Electron main process wiring adapters and relaying events to the renderer
- `app/renderer.js` – UI layer showing order cards and status indicators
- `app/services/events.js` – lightweight event bus for `order:placed`, `position:opened`, `position:closed` and `order:cancelled`
- `app/services/dealTrackers/*` – pluggable trackers invoked when a position closes. See `app/services/dealTrackers/README.md` for configuration.
- `app/services/dealTrackers-source-tv-log/*` – parses TradingView CSV order logs, watches account directories for new log files and emits closed trades to deal trackers. See `app/services/dealTrackers-source-tv-log/README.md` for details.
- `app/services/dealTrackers-source-mt5-log/*` – parses MetaTrader 5 HTML trade history reports, watches account directories for new report files and emits closed trades to deal trackers. See `app/services/dealTrackers-source-mt5-log/README.md` for details.
- `app/services/dealTrackers/config/deal-trackers.json` – local configuration for deal trackers
- `app/services/dealTrackers-source-tv-log/config/tv-logs.json` – tactic account configuration (with `enabled`, `pollMs`, `sessions`, per‑account `tactic` names and `skipExisting`) pointing to directories with order log CSV files
- `app/services/dealTrackers-source-mt5-log/config/mt5-logs.json` – tactic account configuration (with `enabled`, `pollMs`, `sessions`, per‑account `tactic` names and `skipExisting`) pointing to directories with MT5 HTML reports
- `app/services/settings/config/services.json` – ordered list of service modules loaded on startup
  - `app/services/tvProxy/config/tv-proxy.json` – configuration for the tv-proxy service (`enabled`, `log`, `proxyPort`)
  - `app/services/tvListener/config/tv-listener.json` – configuration for the tv-listener service (`enabled`, `webhook` `{enabled, port, url}`)
- `OBSIDIAN_INDEPSTATE_VAULT`, `OBSIDIAN_INDEPSTATE_DEALS_JOURNAL` and `OBSIDIAN_INDEPSTATE_DEALS_SEARCH` – environment variables consumed by the Obsidian deal tracker
- `app/services/brokerage/brokerageAdapters.js` – registry that adapter services extend
- `app/services/brokerage-adapter-*/comps/*` – execution adapters such as the DWX connector and the CCXT adapter; each can provide `listOpenOrders()` and `listClosedPositions()`
- `app/services/servicesApi.js` – global object that service manifests extend to expose their APIs (e.g. `servicesApi.brokerage` with adapter helpers)
- `app/services/commandLine.js` – parses text commands sent from the renderer. See [command-line.md](command-line.md) for available commands.
- `app/services/actions-bus/*` – automation bus connecting service events to command runners. See [actions-bus.md](actions-bus.md) for configuration and usage details.
- `app/services/instrumentInfo/*` – shared provider-aware quote and trading-metadata cache. See [instrument-info.md](instrument-info.md).
- `app/services/orderCalculator.js` – shared service computing stop-loss, take-profit and position size for cards and pending orders.
- `app/services/levelOrder/*` – custom level-trading card, `levelOrder` / `lo` command, split child order execution, and terminal-position readiness monitoring. See [level-order.md](level-order.md).
  - `app/services/tvProxy/*` – spawns a mitmdump proxy exposing TradingView traffic to listeners. See [tv-proxy.md](tv-proxy.md) for details.
  - `app/services/tvListener/*` – registers listeners for TradingView messages, storing the last horizontal line and optionally forwarding `@ATR` messages to a webhook. See [tv-listener.md](tv-listener.md) for service details and automation hooks.
- `app/services/autoUpdater/*` – GitHub-based auto-updater. See [auto-updater.md](auto-updater.md) for configuration and release instructions.
