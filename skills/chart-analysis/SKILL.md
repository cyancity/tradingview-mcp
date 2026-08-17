---
name: chart-analysis
description: Analyze a chart — set up symbol/timeframe, add indicators, scroll to key dates, annotate, and screenshot. Use when the user wants technical analysis or chart review.
---

# Chart Analysis Workflow

You are performing technical analysis on a TradingView chart.

## Step 1: Set Up the Chart

1. `chart_set` — switch to the requested symbol and timeframe (one call: `symbol` + `timeframe`)
2. Wait for the chart to load (the tool handles this)

## Step 2: Add Indicators

Use `indicator` with action "add" to add studies. Common names (must use FULL names):
- "Relative Strength Index" (not RSI)
- "Moving Average Exponential" (not EMA)
- "Moving Average" (for SMA)
- "MACD"
- "Bollinger Bands"
- "Volume"
- "VWAP"
- "Average True Range"

After adding, use `indicator` with action "set_inputs" to customize settings (e.g., change EMA length to 200).

## Step 3: Navigate to Key Areas

- `chart_goto` with a date — jump to a specific date of interest
- `chart_goto` with from/to — zoom to a specific date window
- `chart_get_visible_range` — check what's currently visible

## Step 4: Annotate

Use drawing tools to mark up the chart:
- `draw` (action "shape") with `horizontal_line` for support/resistance
- `draw` (action "shape") with `trend_line` for trend channels (needs two points)
- `draw` (action "shape") with `text` for annotations

## Step 5: Capture and Analyze

1. `capture_screenshot` — screenshot the annotated chart
2. `data_get_ohlcv` — pull recent price data for quantitative analysis
3. `quote_get` — get the current real-time price
4. `symbol_info` — get symbol metadata (exchange, type, session)

## Step 6: Report

Provide the analysis:
- Current price and recent range
- Key support/resistance levels identified
- Indicator readings (RSI overbought/oversold, MACD crossover, etc.)
- Overall bias (bullish/bearish/neutral) with reasoning

## Cleanup

If you added indicators the user didn't ask for, remove them:
- `indicator` with action "remove" and the entity_id
- `draw` (action "clear") to remove all drawings if they were temporary
