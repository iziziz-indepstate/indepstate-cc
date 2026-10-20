# Candle levels: TradingView → MT5 → LevelTrack

The optional renderer transfers a horizontal line or horizontal ray anchored to the High or Low of a closed TradingView candle. MT5 resolves the corresponding price over the same candle window and draws a native full horizontal line. LevelTrack receives the price only after the indicator acknowledges the chart object.

The feature starts disabled, with empty symbol mappings and no connection settings. It does not submit orders. Publishing prices to LevelTrack can affect existing rules that use those groups, so check those rules before enabling publication.

## Configure

1. Open the **Отрисовщик уровней** settings section. Add explicit pairs of full TradingView symbols and exact, case-sensitive MT5 symbol names.
2. Keep the TradingView connector running. The chart reader uses its local debugger on port 9222 and only reads editable TradingView chart tabs. The source candle's period and date must already be loaded; the reader does not change the chart or start history subscriptions.
3. The default `stdio` receiver runs alongside an already connected MT5 terminal on Windows. Copy `extensions/candleLevelRenderer/receiver/` to a local directory outside the packaged application, install its `requirements.txt`, and copy `config.example.json` to a private directory. Set your terminal executable, expected terminal data directory and verified historical broker clock model. No account number or password is stored in this configuration.
4. Set `readerCommand` to a JSON array containing the Python executable, the absolute path to `read_only.py`, `--config`, and the absolute path to your private configuration. Arguments remain separate; no command shell is used. On a Mac, use a configured existing bridge or your own protected command channel to a compatible MT5 environment. Local Wine/Python compatibility is not asserted by this change.
5. Compile `extensions/candleLevelRenderer/mt5/ISCC Addon Levels.mq5` (indicator 1.15) in MetaEditor and keep it attached to one chart of the selected terminal. It draws the transferred levels across matching open charts. Open the desired symbol charts yourself; the indicator never opens or reopens chart tabs.
6. Enable the renderer and verify High, Low, move, recolor, delete and restart with automatic trading disabled. Enable `publishToLT` only if you want the confirmed prices in LevelTrack.

The optional `iscc` mode reuses an existing host-provided `servicesApi.mt5VPS` adapter. That adapter must advertise `candle-levels`, `candle-levels-window` and `candle-levels-color`. This mode uses the original `ISCC Candle Levels.mq5` protocol. It is not required by the standalone candle receiver and does not add a trading adapter to this project.

## Behavior

- Candle time, source period and selected High/Low are retained. A neighboring candle or the chart's current period is never substituted.
- Opening-range marks use the corresponding MT5 candle's High/Low. An arbitrary TradingView price is rejected before history reads or drawing.
- Closed intervals with different TV/broker session boundaries use minute history only when it reproduces the hourly coverage and extremes. Incomplete history remains unpublished. Broker timezone rules are explicit recipient settings, with no owner-specific broker assumption.
- Source colors are retained in state; white is displayed red in MT5, while source reds `#F23645` and `#FF0000` are displayed purple `#673AB7`. These display changes preserve candle period, time, side and price. Both TV lines and rays become native full horizontal MT5 levels with the platform price-scale label.
- Missing or closed charts stay closed and their markers remain pending. Unchanged levels are verified without rewriting object properties or forcing redraws; changed levels trigger one redraw per chart. Deleted or edited owned objects are repaired, and failed reads remain pending.
- Moves, color-only changes, duplicate prices, source revisions and late replies are handled without creating duplicate LevelTrack prices. Deletion waits for physical indicator acknowledgement.
- The stdio indicator owns only `ISCC_ADDON_TV_` objects and exchanges `iscc-addon-levels.csv` / `iscc-addon-levels-ack.csv`. Its load receipt is `iscc-addon-levels-indicator-status.csv`. Manual chart objects and manual LevelTrack groups are preserved.
- Source deletion must be observed by the running TradingView connector. Absence from a page snapshot is not proof of deletion. A deletion made while disconnected needs to be transmitted again through the normal TV event.
- An acknowledged object may lie outside the visible chart scale. Check its actual visibility in MT5 rather than treating acknowledgement as a screenshot check.

The receiver exposes only health and candle-level messages over stdin/stdout. It checks the selected terminal and session before each request, stores candle revisions locally and reads history in one bounded worker. It does not open a network listener, read order/position lists, log in with a password, or invoke trading APIs.

## Development checks

```sh
node --test test/candleRendererCore.test.js test/candleRendererAddon.test.js
python -m unittest discover -s test/candle-renderer-python -p "test_*.py"
```

The full `npm test` also includes the JavaScript renderer tests. The Python suite executes the indicator timer through a bounded C++ fake-chart harness when a C++ compiler is available. CI exercises both indicator namespaces, including missing/closed charts, manual objects, acknowledgements and batched redraws. These offline tests do not launch MT5 or an Electron window. Compile the indicator and verify the terminal and broker calendar separately before use.

The separately installable addon and checkbox selector are maintained at https://github.com/Ivan25rus/iscc-level-renderer . The application integration in this change does not run that installer or modify users' external configuration files.
