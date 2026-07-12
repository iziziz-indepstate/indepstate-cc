# Command Line Service

The bottom of the application window includes a text input that accepts simple commands. The renderer forwards entered strings to the main process where `app/services/commandLine.js` resolves the command name and executes the corresponding handler.

Commands are case-insensitive and may define multiple names (aliases).

If a command fails (e.g. due to validation error), the entered text remains in the input field so you can quickly correct and retry. Successful commands clear the input.

## Shortcuts

`app/services/commandLine/config/command-line.json` may define a `shortcuts` array. When no text input is focused and a pressed key matches one of these commands, it executes immediately without waiting for `Enter`. When the command line input is focused, shortcuts are ignored and `Enter` must be used to run a command. Executing a shortcut does not move focus to the command line input.

The service manifest exports `hookRenderer(ipcRenderer)` which the renderer calls on startup. This hook wires the shortcut handler into the UI. Other services can also provide a `hookRenderer` function in their manifest to register renderer-side behavior.

## Commands

### add (alias: a)

```
add {ticker} {price} [sl] [tp] [risk]
```

Creates a new order card with the given ticker, entry price and stop loss. `sl` defaults to `10` points when omitted. `tp` and `risk` are optional. If `tp` is omitted, the card computes it automatically from the provided stop loss.

`sl` and `tp` accept either raw point values or absolute prices containing a decimal dot. When a dotted value is supplied, it is interpreted as a price level and converted to points relative to the entry price (same logic as the input field).

### last (alias: l)

```
last [tp] [risk]
```

Creates a card from the latest TradingView horizontal line captured by the `tvListener` service. The service stores the symbol and price from incoming `LineToolHorzLine` updates and the command reuses them as the ticker and entry price. Optional arguments follow the `add` command semantics: the first argument overrides the take-profit (`tp`) and the second overrides the `risk` value.

When the TradingView payload includes the line identifier, the resulting card receives a `producingLineId` field matching that ID. Automation rules and manual commands can use the field to correlate cards with the TradingView objects that created them.

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

