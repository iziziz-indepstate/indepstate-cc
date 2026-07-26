# Risk Manager

Risk Manager is a protective watchdog for app-created open positions. It is disabled by default so a fresh install cannot close live positions before limits are reviewed.

Open the window with the command line:

```text
riskManager
```

or:

```text
rm
```

## Limits

Settings live in the `risk-manager` section. Each provider can define:

- `enabled`: enables monitoring for that provider when the global service is enabled.
- `maxStopRiskUsd`: maximum allowed estimated USD loss if the position reaches its stop.
- `maxOpenLossUsd`: maximum allowed current open loss.
- `symbols`: per-symbol overrides keyed by broker/app symbol.

Limits are ignored when missing, `null`, `0`, or negative. Symbol settings override provider settings.

## Behavior

Risk Manager tracks only orders and positions created by this app. Pending/working limit and stop orders are checked for maximum stop risk before they open; open positions are checked for both maximum stop risk and current open loss. Tracked items are removed on rejection, cancellation, or close events.

When critical data is missing, Risk Manager logs a warning and does not close the position. Automatic close is sent only when the stop-risk or open-loss calculation is reliable and exceeds a configured limit.

The trigger log separates item kind (`order` or `position`), breached check (`Stop size` or `Open loss`), action (`cancel pending`, `cancel order`, or `close position`), value/limit, and adapter result.
