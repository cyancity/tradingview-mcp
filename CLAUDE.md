# TradingView MCP — Claude Instructions

44 consolidated tools (v3) for reading and controlling a live TradingView Desktop chart via CDP (port 9223).
Older docs/prompts may reference pre-v3 names (chart_set_symbol, data_get_pine_lines, ...) — they map to the tools below, or run the server with `TV_MCP_LEGACY=1` to restore the old names.

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study` (no args) → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use `data_get_pine_drawings` with `kind`:

1. `kind=line` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `kind=label` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `kind=table` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `kind=box` → price zones / ranges as {high, low} pairs

Always pass `study_filter` to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study` (no args) → all indicator readings
3. `data_get_pine_drawings` `kind=line` → key price levels from custom indicators
4. `data_get_pine_drawings` `kind=label` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_drawings` `kind=table` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set` → switch ticker / resolution / chart style in one call (`symbol`, `timeframe`, `chart_type`; e.g. "AAPL", "D", "HeikinAshi")
- `indicator` `action=add` → add studies (built-ins via `indicator` full name; any script via `query` search)
- `indicator` `action=remove` → remove by `entity_id`
- `chart_goto` → jump to a `date` (ISO format "2025-01-15") or zoom to a `from`/`to` range (unix seconds)

### "Work on Pine Script"
0. `pine_script` `action=verify` → FIRST: assert the connected tab shows the Pine editor and the ACTIVE script tab is the one you intend to edit. With many browser tabs open the CLI/MCP can be pinned to a different tab than the visible one; use `tab_list` `targets=true` + `tab_switch` `target_id` (or `tv pine targets` + `--target <id>`) to pick the tab.
1. `pine_source` `action=set` → inject code into the VISIBLE editor (verifies after writing)
2. `pine_compile` `smart=true` → compile with auto-detection + error check
3. `pine_diagnostics` `kind=errors` → read compilation errors (from the visible editor)
4. `pine_diagnostics` `kind=console` → read log.info() output
5. `pine_source` `action=get` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_source` `action=save` → save to TradingView cloud (Ctrl+S dispatched to the focused active editor)
7. `pine_script` `action=new` → create blank indicator/strategy/library in the ACTIVE tab
8. `pine_script` `action=open` → load a saved script by name: activates its tab in the editor tab bar, loads the source, and verifies; fails loudly if the script is not open and cannot be opened automatically
- Offline: `pine_analyze` (static analysis, no connection needed) and `pine_check` (compile via TradingView server API, no chart needed) validate code before injecting.

### "Practice trading with replay"
`replay` with `action`:
1. `action=start` + `date: "2025-03-01"` → enter replay mode
2. `action=step` → advance one bar
3. `action=autoplay` → auto-advance (set speed with `speed` param in ms)
4. `action=trade` + `trade_action: "buy"/"sell"/"close"` → execute trades
5. `action=status` → check position, P&L, current date
6. `action=stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
`draw` with `action`:
- `action=shape` → horizontal_line, vertical_line, trend_line, rectangle, text (pass `point` + optional `point2`)
- `action=list` → see what's drawn
- `action=remove` → remove by `entity_id`
- `action=clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_manage` `action=list` → view active alerts
- `alert_manage` `action=delete` → remove alerts (`alert_id` or `delete_all`)

### "Navigate the UI"
- `ui_input` `action=panel` → open/close/toggle pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_input` `action=click` → click buttons by aria-label, text, or data-name
- `ui_input` `action=keyboard/type/scroll/mouse_click/fullscreen` → other input
- `layout_switch` → load a saved layout by name
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working (`discover=true` also lists available internal API paths)

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on `data_get_pine_drawings` when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine drawing reads unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid `pine_source action=get`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid `data_get_study` with `entity_id`** on protected/encrypted indicators — their inputs are encoded blobs. Call it with no args instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study` (no args) | ~500 bytes (all indicators) |
| `data_get_pine_drawings` `kind=line` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_drawings` `kind=label` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_drawings` `kind=table` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_drawings` `kind=box` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }` (compact JSON; set `TV_MCP_PRETTY=1` for readable output)
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics reads to work
- `indicator` `action=add` with built-in names requires **full names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB" — or use the `query` search path
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Manifest Size (env vars)

The server registers 44 tools by default. For context-sensitive clients:
- `TV_MCP_PROFILE` presets: `quant`, `data`, `chart`, `pine`, `ui`, `minimal` (11 tools), `lazy` (`tv_call` dispatcher + catalog + 5 core)
- `TV_MCP_TOOLS` explicit allowlist (exact names or `tab_*` globs)
- `TV_MCP_LEGACY=1` registers the pre-v3 names (55 aliases) alongside the new tools
- Compare sizes: `pnpm tools:report`

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9223) ←→ TradingView Desktop (Electron)
```

Tool layer: `src/tools/*.js` export declarative definitions (name/description/schema/handler) → `src/tools/registry.js` applies TV_MCP_PROFILE / TV_MCP_TOOLS / TV_MCP_LEGACY filtering → `src/server.js` registers the selected tools over stdio.

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
