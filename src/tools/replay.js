import { z } from 'zod';
import * as core from '../core/replay.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'replay';

export const tools = [
  {
    name: 'replay',
    description: 'Bar replay control. action=start (optionally at `date` YYYY-MM-DD) | step (advance one bar) | autoplay (set `speed` ms or just toggle) | trade (`trade_action`: buy/sell/close) | status | stop (return to realtime).',
    schema: {
      action: z.enum(['start', 'step', 'autoplay', 'stop', 'trade', 'status']).describe('Replay operation'),
      date: z.string().optional().describe('Date to start replay from, YYYY-MM-DD (action=start). If omitted, selects first available date.'),
      speed: z.coerce.number().optional().describe('Autoplay delay in ms (action=autoplay). Valid: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Leave empty to just toggle.'),
      trade_action: z.string().optional().describe('Trade to execute (action=trade): buy, sell, or close'),
    },
    handler: async ({ action, date, speed, trade_action }) => {
      if (action === 'start') return core.start({ date });
      if (action === 'step') return core.step();
      if (action === 'autoplay') return core.autoplay({ speed });
      if (action === 'stop') return core.stop();
      if (action === 'trade') {
        if (!trade_action) throw new Error('action=trade requires `trade_action` (buy/sell/close).');
        return core.trade({ action: trade_action });
      }
      return core.status();
    },
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'replay_start',
    description: 'Start bar replay mode, optionally at a specific date',
    legacy: 'replay',
    schema: { date: z.string().optional().describe('Date to start replay from (YYYY-MM-DD)') },
    handler: ({ date }) => core.start({ date }),
  },
  {
    name: 'replay_step',
    description: 'Advance one bar in replay mode',
    legacy: 'replay',
    schema: {},
    handler: () => core.step(),
  },
  {
    name: 'replay_autoplay',
    description: 'Toggle autoplay in replay mode, optionally set speed',
    legacy: 'replay',
    schema: { speed: z.coerce.number().optional().describe('Autoplay delay in ms') },
    handler: ({ speed }) => core.autoplay({ speed }),
  },
  {
    name: 'replay_stop',
    description: 'Stop replay and return to realtime',
    legacy: 'replay',
    schema: {},
    handler: () => core.stop(),
  },
  {
    name: 'replay_trade',
    description: 'Execute a trade action in replay mode (buy, sell, or close position)',
    legacy: 'replay',
    schema: { action: z.string().describe('Trade action: buy, sell, or close') },
    handler: ({ action }) => core.trade({ action }),
  },
  {
    name: 'replay_status',
    description: 'Get current replay mode status',
    legacy: 'replay',
    schema: {},
    handler: () => core.status(),
  },
];
