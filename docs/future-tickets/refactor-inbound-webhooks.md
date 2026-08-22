# Future Ticket: Refactor Inbound Webhooks as Platform Input Module

## Context

The legacy inbound webhook-to-card flow is intentionally disabled. `orderCards` no longer hosts
`POST /webhook`, imports webhook parsers, reads `webhooks.jsonl`, or treats inbound webhook payloads
as a card/position source.

TradingView forwarding may still target `/webhook` through legacy configuration, but there is
currently no order-card endpoint behind it.

## Goal

Build inbound webhooks as a standalone platform input module. It must own its interface lifecycle
and translate accepted payloads into platform commands or events without depending on `orderCards`.

## Scope

- Own the inbound HTTP endpoint, startup, shutdown, and diagnostics.
- Own the parser registry, inbound logs, and settings.
- Normalize accepted payloads into platform commands/events.
- Route future position creation through `positions.createFromInput` or the command bus, never
  through `orderCards.ingestRow`.
- Decide and document which payloads:
  - create positions;
  - only publish platform events;
  - feed automation/actions.
- Reconcile or migrate legacy `tvListener` forwarding configuration.
- Add focused parsing, lifecycle, routing, and architecture regression tests.
- Document inbound behavior separately from outbound webhooks.

## Out of Scope

- Restoring an inbound webhook source under `orderCards`.
- Changing outbound webhook delivery behavior.
- Treating every accepted payload as a position/card request by default.

## Acceptance Criteria

- The inbound module can be enabled, disabled, started, and stopped without loading `orderCards`.
- HTTP parsing and logging are covered by focused tests.
- Routing uses platform commands/events and follows the documented payload policy.
- The inbound module has no dependency on `app/services/orderCards`.
- No inbound webhook path calls `orderCards.ingestRow`.
- Documentation distinguishes inbound and outbound webhooks and explains migration from the disabled
  legacy flow.
