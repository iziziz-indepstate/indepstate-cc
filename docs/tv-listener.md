# tv-listener Service

The `tv-listener` service subscribes to TradingView traffic exposed by the `tv-proxy` service. It
parses horizontal line updates from `LineToolHorzLine` payloads and horizontal ray updates
from `LineToolHorzRay` payloads. The listener emits one action-bus event per drawing update and keeps only the latest horizontal line for the `last` command. The `tvAggregatorListener` service stores line/ray state separately per symbol for automation.

## Configuration

Configure the service via `app/services/tvListener/config/tv-listener.json`:

- `enabled` (boolean, default `true`) – disables the service when set to `false`.
- `webhook.enabled` (boolean, default `false`) – forwards selected TradingView messages to an HTTP
  endpoint when enabled.
- `webhook.port` (number) – port used to build the webhook URL when `webhook.url` is empty. The
  service posts to `http://localhost:{port}/webhook`.
- `webhook.url` (string) – explicit URL for webhook deliveries. Takes precedence over `port`.

The webhook integration forwards TradingView messages that contain `@ATR` in their text body using an
HTTP `POST` request with the raw message as the payload.

## Command Line Integration

`tv-listener` registers the `last` command, which reuses the most recent horizontal line event to
create a card. Horizontal rays do not overwrite this line-backed value. When TradingView provides a line identifier, the created card receives a
`producingLineId` property so later automation can correlate the card with the TradingView object
that produced it.

## Action Bus Integration

`tvListener` emits the `tv-tool-horzline` event whenever TradingView sends a horizontal line update.
The payload matches the last activity used by the `last` command and includes
`{ symbol, price, lineId?, toolType, serverUpdateTime? }`. When TradingView provides a persistent
identifier, the payload includes `lineId` so downstream automation can correlate follow-up events.

Horizontal rays emit `tv-tool-horzray` with
`{ symbol, rayPrice, price, rayId?, toolType, serverUpdateTime? }`. The `price` alias on ray events is
kept for simple templates, while composite line/ray templates should prefer `{rayPrice}` for clarity.
A ray update never replaces the latest line activity used by the `last` command.

To create a Level Order card from a new horizontal line, bind the event through the actions bus:

```json
{
  "event": "tv-tool-horzline",
  "action": "commandLine:lo stripSymbol({symbol}) {price} props=producingLineId:{lineId}"
}
```



The separate `tvAggregatorListener` service listens to `tv-tool-horzline` and `tv-tool-horzray`. When it has both a latest horizontal line and a latest horizontal ray for the same symbol,
it emits the composite `tv-tool-horzline-ray` event. This event is designed for action-bus templates
that need both values at once:

```json
{
  "event": "tv-tool-horzline-ray",
  "action": "commandLine:lo stripSymbol({symbol}) {price} props=stopOffsetPts:distPts({price},{rayPrice});producingLineId:{lineId}"
}
```

The composite payload includes `{ symbol, price, linePrice, lineId?, rayPrice, rayId?,
lineServerUpdateTime?, rayServerUpdateTime? }`. `{price}` and `{linePrice}` both refer to the
horizontal line level; `{rayPrice}` refers to the horizontal ray level. State is keyed by the full
TradingView symbol, so rays from another symbol do not combine with the current line.

`stripSymbol({symbol})` removes the TradingView exchange prefix, matching the ticker cleanup used by
the `last` command, `{price}` is the horizontal line level, and `props=producingLineId:{lineId}`
keeps the card linked to the TradingView object for later removal.

When TradingView deletes a horizontal line, `tvListener` emits `tv-tool-horzline-remove` with the
payload `{ lineId }`. When TradingView deletes a known horizontal ray, it emits
`tv-tool-horzray-remove` with `{ rayId }`. Binding that event to `commandLine:rm producingLineId:{lineId}` removes the card
that originated from the deleted line, keeping the UI in sync with TradingView.
