import { z } from 'zod';
import * as core from '../core/chart.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'chart';

export const tools = [
  {
    name: 'chart_get_state',
    description: 'Get current chart state (symbol, timeframe, chart type, indicators with entity IDs). Call this first.',
    schema: {},
    handler: () => core.getState(),
  },
  {
    name: 'chart_set',
    description: 'Change chart symbol, timeframe and/or chart type in one atomic call. Provide at least one field; multiple fields apply in order symbol → timeframe → chart_type.',
    schema: {
      symbol: z.string().optional().describe('Symbol (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
      timeframe: z.string().optional().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
      chart_type: z.string().optional().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — name or number'),
    },
    handler: async ({ symbol, timeframe, chart_type }) => {
      if (!symbol && !timeframe && !chart_type) throw new Error('Provide at least one of: symbol, timeframe, chart_type.');
      const applied = {};
      if (symbol) applied.symbol = await core.setSymbol({ symbol });
      if (timeframe) applied.timeframe = await core.setTimeframe({ timeframe });
      if (chart_type) applied.chart_type = await core.setType({ chart_type });
      return { success: true, applied };
    },
  },
  {
    name: 'chart_goto',
    description: 'Navigate the chart view: center on a date, or zoom to an explicit date range (unix seconds).',
    schema: {
      date: z.string().optional().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string — centers the view on this date'),
      from: z.coerce.number().optional().describe('Range start (unix seconds) — use together with `to`'),
      to: z.coerce.number().optional().describe('Range end (unix seconds)'),
    },
    handler: async ({ date, from, to }) => {
      if (date) return core.scrollToDate({ date });
      if (from !== undefined && to !== undefined) return core.setVisibleRange({ from, to });
      throw new Error('Provide either `date`, or both `from` and `to`.');
    },
  },
  {
    name: 'chart_get_visible_range',
    description: 'Get the visible date range (unix timestamps) and bars range on the chart',
    schema: {},
    handler: () => core.getVisibleRange(),
  },
  {
    name: 'symbol_info',
    description: 'Get detailed metadata about the current symbol (name, exchange, type, description)',
    schema: {},
    handler: () => core.symbolInfo(),
  },
  {
    name: 'symbol_search',
    description: 'Search for symbols by name or keyword',
    schema: {
      query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
      type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
    },
    handler: ({ query, type }) => core.symbolSearch({ query, type }),
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'chart_set_symbol',
    description: 'Change the chart symbol',
    legacy: 'chart_set',
    schema: { symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)') },
    handler: ({ symbol }) => core.setSymbol({ symbol }),
  },
  {
    name: 'chart_set_timeframe',
    description: 'Change the chart timeframe/resolution',
    legacy: 'chart_set',
    schema: { timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)') },
    handler: ({ timeframe }) => core.setTimeframe({ timeframe }),
  },
  {
    name: 'chart_set_type',
    description: 'Change chart type',
    legacy: 'chart_set',
    schema: { chart_type: z.string().describe('Chart type name or number 0-9') },
    handler: ({ chart_type }) => core.setType({ chart_type }),
  },
  {
    name: 'chart_set_visible_range',
    description: 'Zoom the chart to a specific date range (unix timestamps)',
    legacy: 'chart_goto',
    schema: {
      from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
      to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
    },
    handler: ({ from, to }) => core.setVisibleRange({ from, to }),
  },
  {
    name: 'chart_scroll_to_date',
    description: 'Jump the chart view to center on a specific date',
    legacy: 'chart_goto',
    schema: { date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string') },
    handler: ({ date }) => core.scrollToDate({ date }),
  },
];
