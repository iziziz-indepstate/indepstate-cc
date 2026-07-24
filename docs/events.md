# Event Bus

A minimal event emitter used across the application. It broadcasts the following order lifecycle events:

- `order:placed`
- `order:closed`
- `position:opened`
- `position:closed`
- `order:cancelled`
- `execution:order-message`

Other services subscribe to these events to react to changes. `execution:order-message`
is emitted with the normalized order payload (including the cross-service `cid`
identifier and comment) right before it is handed to the execution adapter.

`order:closed` is emitted after a successful close flow. OptionStrat closes include
normalized close-leg fields for webhook/action templates when the adapter returns
leg prices.
