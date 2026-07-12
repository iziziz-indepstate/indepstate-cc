# Actions Bus

The actions bus bridges service events and command execution. Services emit named events on
`servicesApi.actionBus` and the bus resolves them into runnable commands using the configuration in
`app/services/actions-bus/config/actions-bus.json`.

When the renderer loads, a toggle strip appears next to the settings button. Each configured action
with a `name` exposes a checkbox that enables or disables the action at runtime.

## Configuration

```json
{
  "enabled": true,
  "actions": [
    {
      "name": "TradingView automation",
      "label": "TV auto-lines",
      "bindings": [
        {
          "event": "tv-tool-horzline",
          "action": "commandLine:add {symbol} {price}"
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
  - `bindings` (optional) – array of `{ event, action }` objects. Each binding inherits the parent's
    `name` and `label` and runs only when the toggle is enabled.

The configuration order determines the toggle order in the UI. Removing an action from the config also
removes its toggle on the next reload.

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
updated state so the UI re-renders. When no named actions exist the container remains hidden.

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
