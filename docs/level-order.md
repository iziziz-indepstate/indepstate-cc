# Level Order

Level Order creates custom "trade from level" cards and executes them through the normal provider routing path.

## Commands

```text
levelOrder {ticker} {level}
lo {ticker} {level}
lo {ticker} {level} props=key:value;key2:value2
```

The command creates a row with `cardType: "levelOrder"`, the normalized ticker, the level, `event: "levelOrder"`, and the current timestamp.

Ticker normalization follows the existing command style: the base ticker is uppercased, while suffixes such as `.cfd` are preserved.

The optional `props=` argument attaches custom string properties to the created card row. It accepts
semicolon-delimited `key:value` pairs without spaces. Core row fields such as `ticker`, `level`,
`event`, `time`, and `cardType` are preserved and cannot be overwritten by props. This is useful for
automation metadata such as `producingLineId`.

Examples:

```text
levelOrder ADAUSDT.cfd 0.164
lo ES.cfd 6500
lo ES.cfd 6500 props=producingLineId:tv-line-123
```

## Settings

The settings section is registered as `Level orders`.

Config shape:

```json
{
  "defaults": {
    "maxLot": 0,
    "minLot": 1,
    "stopOffsetPts": 10,
    "takeProfitPts": null,
    "buyPriceSource": "bid",
    "sellPriceSource": "bid"
  },
  "symbols": []
}
```

- `maxLot`: max quantity for one child order. `0` disables splitting.
- `minLot`: minimum quantity step for sizing and split remainders. `1` keeps whole-number sizing; `0.01` allows quantities like `12.34`.
- `stopOffsetPts`: stop offset from the level, in points.
- `takeProfitPts`: optional take-profit distance in points. `null` or blank means no TP is sent.
- `buyPriceSource`: quote side used by `LB`; one of `bid`, `ask`, or `mid`. Default is `bid`.
- `sellPriceSource`: quote side used by `LS`; one of `bid`, `ask`, or `mid`. Default is `bid`.
- `symbols`: ticker-specific overrides with the same fields plus `ticker`.

The Risk $ field uses the shared order-calculator risk configuration. An explicit `riskUsd` on the incoming row wins over an order-calculator symbol override, which wins over the instrument-type default. See [order-calculator.md](order-calculator.md).

`mid` is calculated as `(bid + ask) / 2` and requires both quote sides.

Example:

```json
{
  "symbols": [
    {
      "ticker": "ADAUSDT.cfd",
      "maxLot": 200,
      "minLot": 0.01,
      "stopOffsetPts": 4,
      "takeProfitPts": null,
      "buyPriceSource": "bid",
      "sellPriceSource": "bid"
    }
  ]
}
```

## Card

A level-order card shows:

- `Level`
- `Risk $`
- `Stop off`
- `Max lot`
- `TP pts`
- `Pt`, a compact point-price override beside the ticker

`Pt` is optional. When blank, the app uses the normal tick-size resolution path. When set, it overrides the point price for this card. For example, `Pt = 0.001` means `3` points equals `0.003`.

Buttons:

- `LB`: limit buy at the configured buy price source. Default: current bid.
- `LS`: limit sell at the configured sell price source. Default: current bid.

## Execution

The renderer sends `level-order:place` to the main process. The main process runs the level-order flow:

1. Resolve provider through regular execution routing.
2. Get quote through `adapter.getQuote(symbol)`.
3. Resolve the button's configured quote source: `bid`, `ask`, or `mid`.
4. Require the selected quote side. `mid` requires both bid and ask.
5. For `LB`, reject when the selected price is below level.
6. For `LS`, reject when the selected price is above level.
7. Compute level distance in points: `abs(selectedPrice - level) / tickSize`.
8. Add `stopOffsetPts` to get the full stop distance.
9. Compute stop price:
   - buy: `level - stopOffsetPts * tickSize`
   - sell: `level + stopOffsetPts * tickSize`
10. Size total quantity from `riskUsd` and full stop distance.
11. Round total quantity down to the configured `minLot` step.
12. Split total quantity by `maxLot` when `maxLot > 0`, preserving the final remainder at the same `minLot` step.
13. Submit every child order through the existing `queue-place-order` normalization path.

Each child order is a limit order at the selected quote price. Metadata includes `strategy: "limitBidTrade"`, `strategyId`, `parentRequestId`, `childIndex`, `childCount`, `fixedQty: true`, `bid`, `ask`, `priceSource`, and `referencePrice`.

`fixedQty: true` prevents the normal order queue from resizing child orders again.

## Stop And TP

Protective orders are best-effort and provider-agnostic.

The strategy passes stop points and optional TP points through the standard adapter contract. Adapters that support bracket/protective orders attach them. Adapters that only support basic orders keep their current behavior.

When `takeProfitPts` is blank or null, TP is not sent to the provider.

## Split Lifecycle

Split level orders are treated as one logical card.

The card stays in the pre-execution state while child orders are being accepted or confirmed. It must not transition to running after the first child result.

For providers that emit reliable `position:opened` events, the renderer can move the card to running after all related child tickets are opened.

For DWX/MT5-style providers, a filled group may appear as one aggregated terminal position rather than one position per child order. The main process starts a position monitor after all child orders are accepted by the adapter. The monitor polls `adapter.listOpenOrders()` and marks the card running only when:

- the terminal position symbol matches the card ticker;
- the terminal position size is at least the sum of all child quantities;
- the terminal position identifiers/comment contain at least one cid or provider ticket from the child order group.

This matches MT5 behavior where the open position comment may contain only one child order cid even though the position size includes the whole split group.

The main process emits `level-order:positions-ready` when this predicate is satisfied.

If the monitor times out, it logs `[LEVEL][POSITIONS_TIMEOUT]` with a visible terminal-position sample and the scan result.

## Files

- `app/services/levelOrder/command.js`: command parsing and row creation.
- `app/services/levelOrder/strategy.js`: default resolution, sizing, stop math, and split math.
- `app/services/levelOrder/manifest.js`: settings and command registration.
- `app/main.js`: `level-order:place`, child submission, and terminal-position monitoring.
- `app/renderer.js`: card UI, IPC payload, grouped child lifecycle, and status transitions.
- `test/levelOrder.test.js`: command and strategy tests.
- `test/levelOrderRenderer.test.js`: renderer/card lifecycle tests.
