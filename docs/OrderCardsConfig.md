# Order Cards Config (order-cards.json)

This file defines event sources and display options for order cards in the UI.

## Parameters

- `sources`: list of event sources. The built-in source type is `file`.
- `closedCardEventStrategy`: reaction to a new event for a ticker whose card is already closed (`ignore` or `revive`).

Default Risk $ values and symbol overrides are configured in the shared order-calculator settings. See [order-calculator.md](order-calculator.md).

### File source

The default configuration watches the path stored in `ORDER_CARDS_PATH`:

```json
{
  "sources": [
    { "type": "file", "pathEnvVar": "ORDER_CARDS_PATH", "pollMs": 1000 }
  ]
}
```

- `pathEnvVar`: environment variable containing the watched plain-text file path.
- `pollMs`: polling interval in milliseconds.

Each non-empty line uses `TICKER PRICE [SL_POINTS TP_POINTS QTY]`. An empty `sources` array is valid
and starts no source. Unknown source types are ignored with a warning.

Inbound webhooks are not supported as an order-card source. They do not start an HTTP endpoint or
create position snapshots through `orderCards`.

### Display options
- `showBidAsk`: boolean, default `false`. When `true`, the card header shows the Bid/Ask price pair next to the ticker and updates with quotes.
- `showSpread`: boolean, default `false`. When `true`, the right side of the header shows the spread in points in the `current/avg10/avg100` format and keeps the last 100 values. Spread values are shown only for cards in the "ready to send" state ("готово к отправке").
- `buttons`: list of action buttons rendered on each card. Each entry is an object
  with a button text (`label`), an action (`action`) sent on click and an optional
  `style` class. When `style` is omitted, the lowercase action is used as the class
  name. If `buttons` is not provided, the default buttons are `BL`, `BC`, `BFB`,
  `SL`, `SC` and `SFB`.
