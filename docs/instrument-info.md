# Instrument information service

`servicesApi.instrumentInfo` is the shared provider-aware source for live quotes and stable symbol
rules. Cache identity is the resolved lowercase provider plus the normalized uppercase symbol, so the
same ticker can safely use different brokers.

## Snapshot

`get(context, options)` returns:

```js
{
  provider: 'ccxt-binance-futures',
  symbol: 'BTCUSDT.P',
  instrumentType: 'CX',
  quote: { bid: 64000, ask: 64001, price: 64000.5, timestamp: 1780000000000 },
  metadata: {
    tickSize: 0.1,
    quantityStep: 0.001,
    minQty: 0.001,
    maxQty: 1000,
    minNotional: 5,
    contractSize: 1
  },
  sources: { tickSize: 'adapter:ccxt-binance-futures:binance-exchangeInfo' },
  quoteUpdatedAt: 1780000000000,
  metadataUpdatedAt: 1780000000000
}
```

Metadata fields other than the effective `tickSize` are optional. Raw provider responses are not part
of the public snapshot. Quotes are fresh for one second by default; metadata is fresh for five minutes.
Concurrent requests for one provider/symbol are coalesced.

At main-process startup, the CCXT service registers a Binance futures metadata prewarmer. It owns the
Binance and CX routing checks and injects the resulting callback through the generic instrument-info
prewarmer API. Startup does not wait for metadata and live quotes are never preloaded.

## API

- `get(context, options)` fetches stale sections. Options include `forceQuote`, `forceMetadata`,
  `quote: false`, `metadata: false`, custom maximum ages, and `timeoutMs`.
- `peek(context)` returns the current cached snapshot without I/O.
- `forget(context)` clears the cached quote and forwards `forgetQuote(symbol)` to the adapter while
  retaining stable metadata.
- `resolveTickSize(context, { explicitTickSize })` applies the common precedence policy.
- `getTickSizeResolution(...)` also returns the selected source.
- `toPoints(context, deltaPrice, options)` converts through that resolved tick size.
- `registerMetadataPrewarmer(name, callback)` schedules one named adapter-owned metadata prewarmer;
  duplicate names are ignored and failures are reported through the service error handler.
- `on('updated', handler)` subscribes to changed snapshots.

Tick-size precedence is: explicit request value, provider metadata, symbol/pattern configuration,
then the configured global default. Explicit values are never stored in the shared cache.

Tick-size defaults and symbol/pattern overrides live in
`app/services/instrumentInfo/config/tick-sizes.json`. A user override named `config/tick-sizes.json`
continues to merge onto those defaults and can be applied live through the `tick-sizes` setting.

## Adapter support

Adapters may implement `getInstrumentMetadata(symbol)` independently of `getQuote(symbol)`. The
service also extracts stable fields returned alongside legacy quotes. CCXT supplies exchange market
and filter rules, IBKR supplies contract details, and simulated/OptionStrat provide static rules. DWX
and J2T use tick-size configuration fallback because their integrations do not expose symbol specs.

For Binance futures, startup preload, quote symbol validation, and metadata lookup share one in-flight
exchange-info promise. The resulting all-symbol metadata map is cached for five minutes. Binance
metadata does not require CCXT `loadMarkets()`; non-Binance CCXT adapters retain their normal market
loading behavior.

Every changed snapshot is emitted on the actions bus as `instrument-info:updated`. Point helpers use
a warm snapshot synchronously; on a cold cache they wait up to five seconds for metadata and then
continue with configured fallback.
