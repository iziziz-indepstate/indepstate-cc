# Actions Bus

The actions bus bridges service events and command execution. Services emit named events on
`servicesApi.actionBus` and the bus resolves them into runnable commands using the configuration in
`app/services/actions-bus/config/actions-bus.json`.

When the renderer loads, a toggle strip appears next to the settings button. Each configured action
with a `name` exposes a checkbox that enables or disables the action at runtime.

## Configuration

Open **Settings > Actions bus** to edit this configuration. The section opens in the structured
**Form** view; select **Actions JSON** to edit or replace only the `actions` array as strict JSON.
The bus-level `enabled` option remains in the Form view and is preserved when editing actions as JSON.
Switching between the views preserves unsaved changes.

Use **Add action JSON** to append a copied action object or an array of action objects without
replacing the existing actions. Invalid JSON and non-action snippet values are shown inline and are
not saved. Saving through Settings updates future actions and refreshes the toolbar toggles
immediately.

For example, the Actions JSON editor accepts:

```json
[
  {
    "event": "order:placed",
    "action": "commandLine:notify order {id}",
    "name": "Notify on new orders"
  }
]
```

Edits made directly to an Actions bus override JSON file are only loaded during application startup
and therefore require a restart.

```json
{
  "enabled": true,
  "actions": [
    {
      "name": "TradingView automation",
      "label": "TV auto-lines",
      "enabled": false,
      "bindings": [
        {
          "event": "tv-tool-horzline",
          "action": "commandLine:lo stripSymbol({symbol}) {price} props=producingLineId:{lineId}"
        },
        {
          "event": "tv-tool-horzline-remove",
          "action": "commandLine:rm producingLineId:{lineId}"
        }
      ]
    },
    {
      "event": "order:placed",
      "action": "commandLine:notify order {id}",
      "name": "Notify on new orders"
    }
  ]
}
```

- `enabled` – disables the service entirely when `false`.
- `actions` – array describing event bindings. Each item can be a single binding or a group:
  - `event` – emitter event name (`bus.emit(eventName, payload)`).
  - `action` – command template. Values wrapped in `{curlyBraces}` are replaced with properties from
the emitted payload. Nested paths are not supported, but any top-level property can be referenced.
Objects are stringified and missing values resolve to empty strings.
  - `name` (optional) – identifier that groups bindings under a toggle. Named actions run only when
    the corresponding checkbox is enabled in the toolbar.
  - `label` (optional) – display name for the toggle. Defaults to `name` when omitted.
  - `enabled` (optional) – initial state for a named action when no saved toggle state exists.
    Defaults to `true`. A state saved through the toolbar takes precedence on later starts.
  - `bindings` (optional) – array of `{ event, action }` objects. Each binding inherits the parent's
    `name`, `label`, and `enabled` default and runs only when the toggle is enabled.

The configuration order determines the toggle order in the UI. Removing an action through Settings
also removes its toggle after the settings are saved.

## Function expressions

Command templates can call small registered helper functions:

```json
{
  "event": "tv-tool-horzline",
  "action": "commandLine:lo stripSymbol({symbol}) {price} props=producingLineId:{lineId}"
}
```

Function arguments are resolved from payload placeholders before invocation. The actions bus provides
only the generic `add(a, b, ...)` and `dist(a, b)` helpers itself. Other services register the helpers
that describe their payloads or capabilities: TradingView registers `stripSymbol(value)`, instrument
information registers `distPts(a, b)` and `distPtsPlus(a, b, extra)`, and OptionStrat registers
`optionLegs(legs)` and `optionLegPair(legs)`. `stripSymbol` removes an exchange prefix before `:`, so
`NYSE:AAA` becomes `AAA`; symbols without a prefix pass through unchanged. `distPts(a, b)` converts
the absolute price difference through the instrument-information tick size and action payload symbol,
which is useful for templates such as `stopOffsetPts:distPts({price},{rayPrice})`.
`distPtsPlus(a, b, extra)` does the same conversion and adds an extra point value in one direct helper
call, avoiding unsupported nested expressions.

`distPts` and `distPtsPlus` resolve tick size through the shared instrument-information service. A
warm provider/symbol snapshot remains synchronous. On a cold cache the action waits for one metadata
lookup (up to five seconds), then uses configured symbol/default fallback if the adapter has no
authoritative metadata. Async helper resolution preserves binding order for the event. Snapshot
changes are available to configured actions as `instrument-info:updated`.

The expression layer is intentionally small: it supports direct calls such as
`functionName({field})` or `functionName({a}, {b})`. It does not execute JavaScript and does not
support nested function calls. Unknown functions render as an empty string and are reported through
the actions bus error handler without stopping other actions.

Services extend the registry from their manifests during `initService`:

```js
servicesApi.actionBus.registerActionFunction('myHelper', (value, payload, entry) => {
  return String(value || '').trim();
});
```

The registration call returns a disposer, and `unregisterActionFunction(name)` is also available.

## OptionStrat lifecycle placeholders

The OptionStrat service enriches successful OptionStrat `order:placed` events with `{optionOpenLegsText}` and
`{optionOpenNetPrice}`. Successful `order:closed` events expose
`{optionCloseLegsText}`, `{optionCloseNetPrice}`, and `{optionPnl}` when the close
result includes leg prices and valuation change.

Webhook actions can map an event payload field onto the parameter expected by the
target body with `targetParam:eventPayloadPath`. For example:

```json
{
  "event": "order:closed",
  "action": "webhook:send is-signal-relay legs:optionCloseLegsText price:optionCloseNetPrice"
}
```

If `optionCloseLegsText` is missing, the target still resolves `{legs}` from the
original event payload.

## Command runners

Every action expands to a command string which is executed by a registered runner:

- Without a prefix the action uses the default runner. The command line service installs itself as
the default runner, so `add {symbol}` or any other command line shortcuts work out-of-the-box.
- Prefixing the command with `runnerName:` routes the command to a specific runner. For example
  `commandLine:add {symbol} {price}` targets the command line service while `other:do-something`
  would call a runner registered under the name `other`.
- If an event fires before its runner is available the command is queued and executed once the runner
  registers.

Services attach new runners with `servicesApi.actionBus.registerCommandRunner(name, fn)` and can
optionally replace the default runner with `setCommandRunner(fn)`. The command handler receives three
arguments: the rendered command string, the action entry and the original payload.

## Renderer toggles

`actions-bus:hookRenderer` populates `<div id="actions-bus-toggles">` with one checkbox per named
action. Toggling a checkbox invokes `actions-bus:set-enabled` and the main process replies with the
updated state so the UI re-renders. Named toggle states are saved to `actions-bus-state.json` in
Electron's user-data directory and restored on the next application start. When no named actions
exist the container remains hidden. Delete the state file while the app is closed to reset all named
actions to their configured `enabled` defaults.

Service-specific integrations are documented alongside each service module. For TradingView
automation, see the [tv-listener service notes](tv-listener.md).

## OptionStrat hedge example

OptionStrat cards emit `optionstrat:open-clicked` and `optionstrat:close-clicked` when their Open and
Close controls are clicked. The event payload includes `hedgeSymbol`, `hedgeOpenSide`, and
`hedgeCloseSide`, so actions can place a linked hedge order without blocking the normal OptionStrat
operation.

```json
{
  "enabled": true,
  "actions": [
    {
      "name": "OptionStrat UPRO hedge",
      "label": "UPRO hedge",
      "bindings": [
        {
          "event": "optionstrat:open-clicked",
          "action": "commandLine:limit-current UPRO {hedgeOpenSide} 100"
        },
        {
          "event": "optionstrat:close-clicked",
          "action": "commandLine:market-current UPRO {hedgeCloseSide} 100"
        }
      ]
    }
  ]
}
```

## Example: automatic level-order and order-card creation from TradingView line events

The following config creates two named actions that listen to TradingView horizontal-line events and
automatically generate order cards via the command line:

```json
{
  "enabled": true,
  "actions": [
    {
      "name": "TV LO",
      "label": "TV LO",
      "bindings": [
        {
          "event": "tv-tool-horzline-ray",
          "action": "commandLine:lo stripSymbol({symbol}) {price} props=stopOffsetPts:distPtsPlus({price},{rayPrice}, 1);producingLineId:{lineId}"
        },
        {
          "event": "tv-tool-horzline-remove",
          "action": "commandLine:rm producingLineId:{lineId}"
        }
      ]
    },
    {
      "name": "TV OC",
      "label": "TV OC",
      "bindings": [
        {
          "event": "tv-tool-horzline-ray",
          "action": "commandLine:l distPtsPlus({price},{rayPrice}, 1)"
        },
        {
          "event": "tv-tool-horzline-remove",
          "action": "commandLine:rm producingLineId:{lineId}"
        }
      ]
    }
  ]
}
```

### How it works

Both actions subscribe to the same pair of TradingView line events:

| Event | Trigger |
|---|---|
| `tv-tool-horzline-ray` | A horizontal line and ray is drawn on the TradingView chart |
| `tv-tool-horzline-remove` | That line is deleted from the chart |

**TV LO** — level-order card creation:
- On draw: runs `lo <symbol> <price> props=stopOffsetPts:<dist+1pts>;producingLineId:<lineId>`.
  - `stripSymbol({symbol})` strips the exchange prefix (e.g. `NYSE:AAPL` → `AAPL`).
  - `distPtsPlus({price},{rayPrice}, 1)` computes the distance between the level price and the ray anchor price in points, then adds 1 point — used as the `stopOffsetPts` override so the stop is just beyond the line.
  - `producingLineId:{lineId}` tags the card with the TV line ID so it can be cancelled by line removal.
- On remove: runs `rm producingLineId:<lineId>` to cancel the level-order card tied to that line.

**TV OC** — plain order card creation (no symbol context, price-distance sizing):
- On draw: runs `l <distPtsPlus>`.
  - Passes the price distance (line-to-ray, +1 pt) as the first positional argument (`sl`); TP is omitted and calculated automatically from that stop distance.
  - The `l` command automatically attaches the latest horizontal line ID as `producingLineId`; it does not accept `props=`.
- On remove: same `rm` cleanup as TV LO.

Both actions appear as independent toggles in the toolbar, so either can be enabled/disabled at
runtime without touching the config file.
