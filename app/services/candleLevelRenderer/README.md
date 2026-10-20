# Candle level renderer integration

`attach({ servicesApi, settings, root, getEnabled })` is called by TV Listener and returns `acceptSource`, `acceptBars`, `status` and `stop`. The caller passes each source to `acceptSource` before ordinary line-to-card actions; `true` means the source belongs to this renderer. Disabled or unmapped sources retain the ordinary behavior. Shutdown stops the reader, timer and optional stdio child.

Settings use `config/candle-renderer.json` and its settings descriptor. State is stored under the host's user-data root in `candle-level-renderer-state.json`. Default mappings and subprocess commands are empty. The default upstream configuration uses the candle-only stdio receiver.

The LevelTrack publisher uses `update(transform)` to read the latest configuration inside its serialized save queue. It updates only groups marked `source: tv-mt5-candles`, keeping manual groups and their settings. The transport facade exposes only candle requests even if the host adapter supports additional operations.

User setup and behavior: [docs/candle-level-renderer.md](../../../docs/candle-level-renderer.md).
