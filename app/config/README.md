# Configuration

This directory contains helpers for loading configuration files. Service
modules bundle their default configs under `app/services/<name>/config/`. To
customize any of them, copy the desired file to a `config` directory inside the
application's local data path (on Windows `%LOCALAPPDATA%/ISCC`, elsewhere
Electron's `app.getPath('userData')`) and edit it there. Files in this local
`config` folder override the bundled defaults; values are deep‑merged during
load. A `config` folder alongside the application (or the project root when
running from source) is also checked for overrides, but settings under the
local data path take precedence.

Example (PowerShell):

```powershell
mkdir "$env:LOCALAPPDATA/ISCC/config"
copy app/services/orderCards/config/order-cards.json "$env:LOCALAPPDATA/ISCC/config/order-cards.json"
```

Changes made by directly editing `config/order-cards.json` (and other override
files) take effect on the next application start. Saves made through the in-app
Settings panel are applied immediately for settings that can be changed without
interrupting active trading work. The Settings button and panel show a restart
notice when a saved field controls a startup resource such as a broker provider,
listening port, proxy, tunnel, file watcher, or enabled service list. Existing
pending strategies keep their trigger configuration, while the resulting order
still uses the latest sizing and trade-rule safety settings.

The `config` directory under the local data path is ignored
by git so personal settings aren't tracked. To log which configuration files are
used to `logs/app.txt` in the local data path, set the `CONFIG_LOG` environment
variable to `1` or `true` (logging is disabled by default).

## Loading configuration in code

Application modules should load configuration files via the helper in
`app/config/load.js`:

```js
const loadConfig = require('./config/load');
const orderCards = loadConfig('../services/orderCards/config/order-cards.json');
```

`loadConfig()` looks for an override in the local data `config` directory and
deep‑merges its contents onto the defaults from the given path.

## Settings descriptors

User-facing descriptions for configuration options are stored in files named
`*-settings-descriptor.json` alongside the default configs. Each descriptor file
contains two top-level keys:

- `properties` - optional metadata about the section itself. Supported fields
  include `name` to override the displayed section title and `group` to
  categorize related sections. Sections sharing the same group are separated
  with a divider in the Settings panel.
- `options` - an object mirroring the structure of the corresponding config
  file. Every field provides at least a `type` and human-readable
  `description`. Nested objects and arrays are supported, so deeply structured
  configs like `pending-strategies.json` use
  `pending-strategies-settings-descriptor.json` to describe their inner
  fields.

These descriptors are consumed by the in-app Settings panel to render editable forms. When user overrides are merged with the defaults, any unknown keys are normally ignored. To allow an object to accept arbitrary keys (for example a map of provider names), mark the descriptor for that object with `"__allowUnknown": true`.

## Order Card Source Configuration

The `order-cards.json` file lists every source that can feed order cards into the
application. The file contains a single object with a `sources` array and optional
settings for how to treat events for cards already in a final state and which
action buttons to show on each card:

```json
{
  "sources": [
    { "type": "webhook" },
    { "type": "file", "pathEnvVar": "ORDER_CARDS_PATH", "pollMs": 1000 }
  ],
  "closedCardEventStrategy": "ignore",
  "buttons": [
    { "label": "BL",  "action": "BL",  "style": "bl" },
    { "label": "BC",  "action": "BC",  "style": "bc" },
    { "label": "BFB", "action": "BFB", "style": "bc" },
    { "label": "SL",  "action": "SL",  "style": "sl" },
    { "label": "SC",  "action": "SC",  "style": "sc" },
    { "label": "SFB", "action": "SFB", "style": "sc" }
  ]
}
```

Each entry in `sources` is an object with a `type` field and additional options
depending on the type. Multiple sources can be defined and their orders are
merged together.

Default Risk $ values for regular and level-order cards are configured in
`order-calculator.json`, including instrument-type defaults and symbol overrides.
The `DEFAULT_EQUITY_STOP_USD` and `DEFAULT_CX_STOP_USD` environment variables
override their corresponding instrument-type defaults.

Older overrides containing those risk fields in `order-cards.json` are migrated
to `order-calculator.json` automatically on startup. Existing new-format values
are preserved.

`closedCardEventStrategy` determines how the app handles a new order event for a
ticker whose card is already closed (`take`/`stop`). When set to `"ignore"`
(default) such events are discarded. Setting it to `"revive"` reactivates the
card with the fresh data, making it ready for a new order.

`buttons` lets you customize the set of buttons rendered on each order card.
Each entry specifies the button text (`label`), the action (`action`) sent when
it is clicked and an optional `style` class applied to the button. When `style`
is omitted, the lowercase action is used. If `buttons` is omitted entirely, the
default buttons are `BL`, `BC`, `BFB`, `SL`, `SC` and `SFB`.


## Pending Order Strategies

`pending-strategies.json` defines default options for pending‑order execution
strategies. Each top‑level key corresponds to a strategy name and its value
contains options that are merged with per‑order parameters. Some options, such
as `rangeRule`, `dealPriceRule` and `stoppLossRule`, may be specified as the name of
a built‑in helper function:

```json
{ 
  "consolidation": {
    "bars": 3,
    "rangeRule": "B1_RANGE_CONSOLIDATION",
    "dealPriceRule": "KNOWN_EXTREMUM",
    "stoppLossRule": "B1_TAIL"
  },
  "falseBreak": { "tickSize": 0.01 },
  "limitByCurrent": {
    "stoppLossRule": "B1_TAIL"
  }
}
```

Built-in helper functions:

- `B1_RANGE_CONSOLIDATION` – validates that subsequent bars stay within the
  range of the breakout bar.
- `KNOWN_EXTREMUM` – picks the highest high (for longs) or lowest low (for
  shorts) from the observed bars as the target price.
- `B1_TAIL` – uses the opposite-direction extremum of the bar that pierced the
  level as the stop price.
- `LEVEL_OFFSET` – anchors the stop beyond the card level using the normalized
  order-card `SL` value as an extra offset in points. For longs the stop is
  `level - SL * tickSize`; for shorts it is `level + SL * tickSize`. The final
  risk distance is measured from the strategy's actual entry to that stop.
- `B1_10p_GAP` – sets the limit price at the entry level plus 10% of the
  breakout bar's range (at least 0.01) and an extra 0.02 for longs (subtracts
  for shorts).

`LEVEL_OFFSET` is opt-in for the `consolidation` (`BC`/`SC`) and
`limitByCurrent` (`BP`/`SP`) strategies:

```json
{
  "consolidation": {
    "stoppLossRule": "LEVEL_OFFSET"
  },
  "limitByCurrent": {
    "stoppLossRule": "LEVEL_OFFSET"
  }
}
```

With this rule selected, `SL` remains a normal stop distance for direct
`BL`/`SL` orders, but pending buttons use it as the extra offset beyond the
watched card level.

Override this file in `config/pending-strategies.json` to customize the defaults.

## Source types

### `webhook`
Accepts order cards pushed via HTTP webhook. No extra options are required.

### `file`
Watches a plain text file for order descriptions. Options:

- `pathEnvVar` – name of the environment variable that holds the path to the
  file. Defaults to `ORDER_CARDS_PATH`.
- `pollMs` – interval in milliseconds between file polls. Defaults to `1000`.

Each non-empty line in the file must be formatted as:

```
{TICKER} {PRICE} {SL POINTS} {TP POINTS} {QTY}
```

`TICKER` and `PRICE` are required. `SL` and `TP` points are optional, but `TP`
may only be specified when `SL` is also given. `QTY` is optional and may only be
specified when both `SL` and `TP` are present.

Example:

```
AAPL 185.5 50 100 1.5
MSFT 325
```


## Trade Rules

`trade-rules.json` enables and configures validation rules that guard order
placement. The file contains a `rules` object; each key corresponds to a rule
name and its value holds that rule's options. Clients invoke the aggregated
`TradeRules` service without needing to know which concrete rules are enabled.

### `maxOrderPriceDeviation`
Limits how far an order's price may deviate from the latest quote:

```json
{
  "rules": {
    "maxOrderPriceDeviation": {
      "maxPriceDeviationPct": 0.5
    }
  }
}
```

### `minStopPoints`
Ensures a stop-loss is not set too close to the entry price. The rule can be
configured with a global default, per‑instrument overrides and even a custom
function evaluated for each order:

```json
{
  "rules": {
    "minStopPoints": {
      "default": 6,
      "byInstrumentType": { "FX": 4 },
      "fn": "if(card.sl < 10) return {ok:false, reason:'SL \u2265 10'}; return {ok:true};"
    }
  }
}
```

If `fn` is supplied it receives the order `card` and current `quote` and should
return either a boolean or an object with an `ok` flag and optional `reason`.

### `maxQty`
Restricts the maximum quantity allowed per order. A global default can be
overridden for specific instrument types:

```json
{
  "rules": {
    "maxQty": {
      "default": 1000,
      "byInstrumentType": { "CX": 10, "FX": 100, "EQ": 1000 }
    }
  }
}
```

Additional rules can be added over time and wired up in `trade-rules.json`
without requiring changes to callers.
