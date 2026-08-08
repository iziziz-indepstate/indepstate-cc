# Outbound Webhooks

The outbound webhooks service sends configured HTTP targets from command-line actions and lifecycle
events. Actions usually reach it through the actions bus with `webhook:send ...`.

## Lifecycle Enrichers

Modules can add lifecycle payload fields without coupling `outboundWebhooks` to module-specific
payload shapes. Register an enricher from the owning service manifest after `outboundWebhooks` has
loaded:

```js
servicesApi.outboundWebhooks.registerLifecycleEnricher(({ eventName, payload, enriched }) => {
  if (eventName !== 'order:placed') return null;
  if (payload?.result?.provider !== 'my-provider') return null;
  return {
    myProviderTicket: payload.result.providerOrderId
  };
});
```

The enricher receives:

- `eventName`: lifecycle event being bridged, such as `order:placed` or `order:closed`.
- `payload`: original event payload from the app event bus.
- `enriched`: generic payload already built by outbound webhooks.

Return an object with extra fields to merge into the outgoing lifecycle payload. The enricher may also
return `null` or `undefined` when it does not apply. Exceptions are logged and do not stop the
lifecycle bridge or other enrichers.

The registration call returns a disposer. Tests can use `resetLifecycleEnrichers()` from the manifest
to clear global registration state.

OptionStrat uses this mechanism for `{optionOpenLegsText}`, `{optionOpenNetPrice}`,
`{optionCloseLegsText}`, `{optionCloseNetPrice}`, and `{optionPnl}` placeholders.
