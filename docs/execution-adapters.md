# Execution Adapters

The adapter registry builds and caches execution connectors based on entries in `app/services/brokerage/config/execution.json`.
Copy this file to the `config` directory under the application's user data path to override the bundled defaults.

Each provider entry selects an adapter implementation and its settings.
Use `getAdapter(name)` to obtain a ready-to-use instance and `getProviderConfig(name)` to read raw configuration.

Provider routing is resolved centrally in priority order: explicit `provider`, `bySymbol`, `byInstrumentType`, then `default`.
Use `bySymbol` for exact symbol-to-provider overrides, for example `"bySymbol": { "AAPL": "j2t" }`.

## Optional data methods

Adapters may expose read-only data methods in addition to execution methods. MCP data tools call these through the adapter layer instead of reaching into provider-specific clients directly.

## IBKR lifecycle tracking

The IBKR adapter tracks each app order as one logical position. Parent fills move its order card to `executing`; attached take-profit and stop-loss executions close the same parent ticket. Final `profit` or `loss` is based only on IBKR commission-report `realizedPNL`. If the report is still unavailable after `commissionReportTimeoutMs` (default `10000`), the card shows neutral `closed` and can still update if the report arrives later.

`trackExternalExecutions` enables conservative attribution of closes submitted directly in TWS or another API client. An execution is inferred only when exactly one app-created open card matches the account, contract, direction, remaining quantity, and there was no pre-existing position that would make attribution ambiguous. Unmatched executions are logged and do not change cards.

For complete external coverage, configure the provider with `clientId: 0` and set **Master API client ID** to `0` in TWS or IB Gateway. IBKR requires the master client to receive other clients' commission reports, while client ID `0` receives manual TWS trades. Lifecycle records survive socket reconnects within the running app but are not restored after an app restart.

- `getInstrumentMetadata(symbol)` returns any available stable `tickSize`, `quantityStep`, `minQty`, `maxQty`, `minNotional`, and `contractSize` rules. The shared instrument-information service caches these optional fields and records their provenance.
- `preloadInstrumentMetadata()` is an optional non-blocking creation hook for adapters that can safely warm metadata with one batch request. The registry invokes it after caching a new adapter and logs failures without failing adapter creation.
- `getHistoricBars({ symbol, timeframe, from, to, limit, timeoutMs })` returns normalized OHLCV bars sorted oldest to newest. `from` and `to` are JavaScript `Date` values or compatible inputs at the adapter boundary; public MCP input uses ISO strings. DWX implements this through `GET_HISTORIC_DATA`.
