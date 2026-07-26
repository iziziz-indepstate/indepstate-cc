# Command Line Service

The bottom of the application window includes a text input that accepts simple commands. The renderer forwards entered strings to the main process where `app/services/commandLine.js` resolves the command name and executes the corresponding handler.

Commands are case-insensitive and may define multiple names (aliases).

If a command fails (e.g. due to validation error), the entered text remains in the input field so you can quickly correct and retry. Successful commands clear the input.

## Shortcuts

`app/services/commandLine/config/command-line.json` may define a `shortcuts` array. When no text input is focused and a pressed key matches one of these commands, it executes immediately without waiting for `Enter`. When the command line input is focused, shortcuts are ignored and `Enter` must be used to run a command. Executing a shortcut does not move focus to the command line input.

The service manifest exports `hookRenderer(ipcRenderer)` which the renderer calls on startup. This hook wires the shortcut handler into the UI. Other services can also provide a `hookRenderer` function in their manifest to register renderer-side behavior.

## Alias templates

`command-line.json` may define an `aliases` array. Alias matching applies to the first command token before normal command resolution. The template can include `{args}` to insert the remaining input arguments; when `{args}` is omitted, the remaining arguments are appended to the template.

```json
{
  "shortcuts": [],
  "aliases": [
    { "enabled": true, "from": "u", "to": "lo ustec {args}" }
  ]
}
```

With this config, `u 28900` runs as `lo ustec 28900`.

## Commands

### add (alias: a)

```
add {ticker} {price} [sl] [tp] [risk]
```

Creates a new order card with the given ticker, entry price and stop loss. `sl` defaults to `10` points when omitted. `tp` and `risk` are optional. If `tp` is omitted, the card computes it automatically from the provided stop loss.

`sl` and `tp` accept either raw point values or absolute prices containing a decimal dot. When a dotted value is supplied, it is interpreted as a price level and converted to points relative to the entry price (same logic as the input field).

### last (alias: l)

```
last [sl] [tp] [risk]
```

Creates a card from the latest TradingView horizontal line captured by the `tvListener` service. The service stores the symbol and price from incoming `LineToolHorzLine` updates and the command reuses them as the ticker and entry price. Optional arguments follow the `add` command semantics: the first argument overrides the stop-loss (`sl`), the second overrides the take-profit (`tp`), and the third overrides the `risk` value. The stop-loss defaults to `10` points when omitted; when TP is omitted, the card calculates it automatically from the stop-loss.

When the TradingView payload includes the line identifier, the resulting card automatically receives a `producingLineId` field matching that ID. Automation rules and manual commands can use the field to correlate cards with the TradingView objects that created them. Unlike `levelOrder`, `last` does not accept a `props=` argument.

### levelOrder (alias: lo)

```
levelOrder {ticker} {level}
lo {ticker} {level}
```

Creates a level-order card for trading from a price level. The card exposes `LB` and `LS` buttons for limit buy / limit sell at current bid, sizes the full position from total risk, splits child orders by `maxLot`, and waits for the grouped position lifecycle before moving to running status.

See [level-order.md](level-order.md) for settings and execution details.

### levelOrder-buy / levelOrder-sell (aliases: lo-lb / lo-ls)

```
levelOrder-buy {ticker} {level} {levelOffset} {risk}
levelOrder-sell {ticker} {level} {levelOffset} {risk}
```

Immediately places the LB or LS level-order strategy for the specified ticker. Unlike `levelOrder`,
this command does not create a card; it sends the same grouped orders that the level-order card's
LB/LS buttons would send. `level` is the traded level, `levelOffset` is the stop offset in points,
and `risk` is risk in dollars. The command applies the same `level-order` settings defaults for max
lot, min lot, take profit, and price sources.

Example:

```
levelOrder-sell MNQ 28125 1 500
lo-ls SPX f:levelTrack:spx-main 10 500
```

`level` may also be a functional reference in the form `f:levelTrack:<key>`. In that case the
`levelTrack` service refreshes the configured group, returns its current active level, and the order
is rejected before execution if the group has no active level.

### levelTrack (alias: lt)

```
levelTrack
```

Opens the LevelTrack window. The window manages saved groups with `key`, `ticker`, `levels`, and
`maxOffset`, shows the current quote-derived active level, and persists groups through the
`level-track` settings section.

### rm

```
rm producingLineId:{id}
```

Removes cards that match a specified criterion. Criteria are written as `key:value` pairs. The first supported key is `producingLineId`, which deletes the card created from the TradingView line with the given identifier. The command returns a validation error when the criterion is missing or malformed.

Additional criteria may be added in the future; attempting to use an unknown key results in `Unknown criterion: {key}`.

### limit-current (alias: lc)

```
limit-current {symbol} {buy|sell} {qty} [provider] [instrumentType]
```

Places a hedge-style limit order at the current quote. Buy orders use ask, sell orders use bid, and both fall back to the quote price. `provider` is optional and defaults from execution config for the instrument type; `instrumentType` defaults to `EQ`.

### market-current (alias: mc)

```
market-current {symbol} {buy|sell} {qty} [provider] [instrumentType]
```

Places a hedge-style market order for the given side and quantity. It uses the same provider and instrument defaults as `limit-current`.
