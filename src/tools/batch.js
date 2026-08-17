import { z } from 'zod';
import * as core from '../core/batch.js';

export const group = 'batch';

export const tools = [
  {
    name: 'batch_run',
    description: 'Run an action across multiple symbols and/or timeframes',
    schema: {
      symbols: z.array(z.string()).describe('Array of symbols to iterate (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
      timeframes: z.array(z.string()).optional().describe('Array of timeframes (e.g., ["D", "60", "15"])'),
      action: z.string().describe('Action to run: screenshot, get_ohlcv, get_strategy_results'),
      delay_ms: z.coerce.number().optional().describe('Delay between iterations in ms (default 2000)'),
      ohlcv_count: z.coerce.number().optional().describe('Bar count for get_ohlcv action (default 100)'),
    },
    handler: ({ symbols, timeframes, action, delay_ms, ohlcv_count }) =>
      core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }),
  },
];
