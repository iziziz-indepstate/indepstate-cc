# Webhook Parsers

Legacy parser-only module for converting raw inbound webhook payloads into normalized rows.
Registered parsers are tried in order until one succeeds.

This module is currently not wired to HTTP ingestion, card creation, or position snapshot creation.
It is retained only for a future inbound-webhook refactor. New integrations must not call
`orderCards.ingestRow` from this module.
