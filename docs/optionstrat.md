# OptionStrat Provider

OptionStrat is used as an option-position logging provider. It opens and closes saved multi-leg option strategies through the OptionStrat API; it does not route exchange orders.

## Setup

The `app/services/optionstrat` service registers its execution defaults with brokerage at startup:

```json
{
  "byInstrumentType": {
    "OPT": "optionstrat"
  },
  "providers": {
    "optionstrat": {
      "adapter": "optionstrat",
      "baseURL": "https://optionstrat.com/api",
      "cookie": "${ENV:OPTIONSTRAT_COOKIE}",
      "account": "${ENV:OPTIONSTRAT_ACCOUNT}",
      "timeoutMs": 10000
    }
  }
}
```

The base brokerage defaults intentionally do not hard-code `OPT` or the `optionstrat` provider. User overrides in `config/execution.json` still win over these module defaults.

The OptionStrat manifest also registers a `PositionInputAdapter`. It maps OptionStrat-like incoming
rows and order payloads to stable position ID seeds and `card.type: "option"` metadata before the
generic positions application service creates the snapshot.

The same API fields are also exposed in the `OptionStrat` settings section:

- `cookie`: full `Cookie` header value from an authorized OptionStrat session.
- `account`: collection/account id where created strategies are saved.
- `baseURL`: defaults to `https://optionstrat.com/api`.
- `timeoutMs`: API request timeout.
- `valuationRefreshMs`: refresh interval for open strategy live P/L, default `5000`.
- `displayFields`: toggles visible OptionStrat card fields: `pl`, `value`, `maxLoss`, `maxProfit`, `change`, and `rr`.

Values saved in the `OptionStrat` settings section are read by the adapter at request time and are sent on chain, open, and close API calls. If both execution config and `OptionStrat` settings are present, the `OptionStrat` settings value wins.

The settings panel saves dirty forms when it is closed with either the close button or `Esc`.

## Commands

OptionStrat user commands live in `app/services/optionstrat/config/optionstrat.json` and can be overridden through the settings UI.

Example:

```json
{
  "commands": [
    {
      "enabled": true,
      "command": "bcs {s1} {s2} {q}",
      "name": "BCS {s1}/{s2}",
      "ticker": "SPY",
      "root": "",
      "expiration": "0DTE",
      "provider": "optionstrat",
      "instantExecution": false,
      "legs": [
        { "option": "CALL", "side": "buy", "strike": "{s1}", "quantity": "{q}" },
        { "option": "CALL", "side": "sell", "strike": "{s2}", "quantity": "{q}" }
      ]
    }
  ]
}
```

Running `bcs 755 756 10` creates one `OPT` card named `BCS 755/756` with two call legs. Buy legs are sent with positive quantity; sell legs are sent with negative quantity. The `q` placeholder is optional and defaults to `1`, so `bcs 755 756` opens the same structure with one contract per leg.

Command templates also expose range aliases for numeric strategy arguments. `{min}` resolves to the smallest numeric argument and `{max}` resolves to the largest numeric argument, independent of input order. The optional `{q}` quantity argument is excluded from this range, so `bcs 756 755 10` can still render strikes as `{min}/{max}` => `755/756` while keeping quantity `10`.

If `instantExecution` is `true`, the renderer opens the OptionStrat position immediately after creating the card.

`root` is optional. When present, the live option chain request uses `root`, while strategy symbols still use `ticker`. For example `ticker: "SPXW"` and `root: "SPX"` fetches `/quote/chain/live/SPX` but creates legs like `.SPXW260531C755`.

## Expiration And Pricing

`expiration` uses `{n}DTE` format. `0DTE` resolves to today's UTC expiration, `1DTE` to tomorrow, and so on. If the live chain does not contain the target expiration, the order is rejected with a clear reason.

Opening and closing both read `GET /quote/chain/live/{TICKER}`. If OptionStrat returns `X-Protect: 1`, the adapter decodes the protected raw-DEFLATE payload before parsing JSON.

For each leg, the adapter uses mid price `(bid + ask) / 2`. If bid or ask is missing, that leg is rejected instead of guessing.

## Live Valuation

After an OptionStrat position is successfully opened, the renderer polls `GET /quote/chain/live/{TICKER}` through the adapter and shows the strategy value change in a compact details row on the card.

The calculation is:

- Initial value: `sum(open basis * signed quantity * 100)`.
- Current value: `sum(current mid * signed quantity * 100)`.
- P/L: `current value - initial value`.
- Percent: `P/L / abs(initial value)`.

The polling interval is controlled by `valuationRefreshMs` in the `OptionStrat` settings section. Set it to milliseconds; for example `5000` means every five seconds.

The details row can show P/L, Value, Max Loss, Max Profit, Change, RR, Opened, and Closed. Field visibility is controlled by `displayFields`; Opened and Closed are shown whenever the renderer has those timestamps. The compact row keeps the tail fields in this order: Change, RR, Opened, Closed.

When the strategy is closed successfully, live polling stops and the green final card keeps the valuation calculated from the same close prices sent in `items[].close`. If the final close valuation cannot be calculated for some reason, the card keeps the last known live valuation instead of blocking the close flow.

## Open And Close

Opening posts to `POST /strategy` and stores the returned `code` as the provider order id. The UI keeps the card in placed status.

Clicking the placed status calls the existing `execution:cancel-order` path. For OptionStrat this means `PUT /strategy/{dealId}` with the original strategy items plus `revision: 1` and fresh `close` prices from the current live chain.
