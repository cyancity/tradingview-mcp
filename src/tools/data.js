import { z } from 'zod';
import * as core from '../core/data.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'data';

const studyFilter = z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.');

export const tools = [
  {
    name: 'data_get_ohlcv',
    description: 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).',
    schema: {
      count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
      summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
    },
    handler: ({ count, summary }) => core.getOhlcv({ count, summary }),
  },
  {
    name: 'data_get_study',
    description: 'Read study/indicator data. No args → current values of ALL visible studies (data window: RSI, MACD, EMAs, custom plots). `entity_id` → inputs and metadata of one study. `entity_id` + series=true → raw plot values for the last N bars, including display.none plots the Data Window hides (rows keyed by plot titles; na = null).',
    schema: {
      entity_id: z.string().optional().describe('Study entity ID (from chart_get_state). Omit to read all visible studies from the data window.'),
      series: z.coerce.boolean().optional().describe('With entity_id: return raw plot series rows instead of just study info'),
      count: z.coerce.number().optional().describe('Number of trailing bars (series mode, default 1, max 500)'),
    },
    handler: async ({ entity_id, series, count }) => {
      if (!entity_id) return core.getStudyValues();
      if (series) return core.getStudySeries({ entity_id, count });
      return core.getIndicator({ entity_id });
    },
  },
  {
    name: 'data_get_pine_drawings',
    description: 'Read objects drawn by custom Pine indicators. kind=line → horizontal price levels (line.new, deduplicated); kind=label → text annotations with prices; kind=table → table rows (session stats, dashboards); kind=box → {high, low} price zones. ALWAYS pass study_filter when you know the target indicator. Indicator must be VISIBLE on the chart.',
    schema: {
      kind: z.enum(['line', 'label', 'table', 'box']).describe('Type of Pine drawing to read'),
      study_filter: studyFilter,
      max_labels: z.coerce.number().optional().describe('Max labels per study (kind=label, default 50)'),
      verbose: z.coerce.boolean().optional().describe('Return raw data with IDs, coordinates, colors (default false — returns unique levels/zones/text only)'),
    },
    handler: ({ kind, study_filter, max_labels, verbose }) => {
      if (kind === 'line') return core.getPineLines({ study_filter, verbose });
      if (kind === 'label') return core.getPineLabels({ study_filter, max_labels, verbose });
      if (kind === 'table') return core.getPineTables({ study_filter });
      return core.getPineBoxes({ study_filter, verbose });
    },
  },
  {
    name: 'quote_get',
    description: 'Get real-time quote data for a symbol (price, OHLC, volume). If symbol is provided and differs from the current chart, the chart is briefly switched to fetch the quote and then restored — adds ~1-2s and serializes parallel calls.',
    schema: {
      symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol). Non-blank values cause a chart switch + restore.'),
    },
    handler: ({ symbol }) => core.getQuote({ symbol }),
  },
  {
    name: 'depth_get',
    description: 'Get order book / DOM (Depth of Market) data from the chart. The DOM panel must be open in TradingView.',
    schema: {},
    hint: 'Open the DOM panel in TradingView before using this tool.',
    handler: () => core.getDepth(),
  },
  {
    name: 'data_get_strategy_results',
    description: 'Get strategy performance metrics from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy (TradingView never computes reports for hidden strategies); result includes unhidden_strategies when that happened.',
    schema: {},
    handler: () => core.getStrategyResults(),
  },
  {
    name: 'data_get_trades',
    description: 'Get trade list from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy.',
    schema: {
      max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
    },
    handler: ({ max_trades }) => core.getTrades({ max_trades }),
  },
  {
    name: 'data_get_equity',
    description: 'Get equity curve data from Strategy Tester',
    schema: {},
    handler: () => core.getEquity(),
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'data_get_indicator',
    description: 'Get indicator/study info and input values',
    legacy: 'data_get_study',
    schema: { entity_id: z.string().describe('Study entity ID (from chart_get_state)') },
    handler: ({ entity_id }) => core.getIndicator({ entity_id }),
  },
  {
    name: 'data_get_study_series',
    description: 'Read raw plot values from a study data series for the last N bars',
    legacy: 'data_get_study',
    schema: {
      entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
      count: z.coerce.number().optional().describe('Number of trailing bars (default 1, max 500)'),
    },
    handler: ({ entity_id, count }) => core.getStudySeries({ entity_id, count }),
  },
  {
    name: 'data_get_study_values',
    description: 'Get current indicator values from the data window for all visible studies',
    legacy: 'data_get_study',
    schema: {},
    handler: () => core.getStudyValues(),
  },
  {
    name: 'data_get_pine_lines',
    description: 'Read horizontal price levels drawn by Pine Script indicators (line.new)',
    legacy: 'data_get_pine_drawings',
    schema: { study_filter: studyFilter, verbose: z.coerce.boolean().optional().describe('Return raw line data (default false)') },
    handler: ({ study_filter, verbose }) => core.getPineLines({ study_filter, verbose }),
  },
  {
    name: 'data_get_pine_labels',
    description: 'Read text labels drawn by Pine Script indicators (label.new)',
    legacy: 'data_get_pine_drawings',
    schema: {
      study_filter: studyFilter,
      max_labels: z.coerce.number().optional().describe('Max labels per study (default 50)'),
      verbose: z.coerce.boolean().optional().describe('Return raw label data (default false)'),
    },
    handler: ({ study_filter, max_labels, verbose }) => core.getPineLabels({ study_filter, max_labels, verbose }),
  },
  {
    name: 'data_get_pine_tables',
    description: 'Read table data drawn by Pine Script indicators (table.new)',
    legacy: 'data_get_pine_drawings',
    schema: { study_filter: studyFilter },
    handler: ({ study_filter }) => core.getPineTables({ study_filter }),
  },
  {
    name: 'data_get_pine_boxes',
    description: 'Read box/zone boundaries drawn by Pine Script indicators (box.new)',
    legacy: 'data_get_pine_drawings',
    schema: {
      study_filter: studyFilter,
      verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false)'),
    },
    handler: ({ study_filter, verbose }) => core.getPineBoxes({ study_filter, verbose }),
  },
];
