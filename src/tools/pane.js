import { z } from 'zod';
import * as core from '../core/pane.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'pane';

export const tools = [
  {
    name: 'pane',
    description: 'Manage chart panes/layouts. action=list → panes with symbols and active state. action=set_layout → change grid (`layout`: s, 2h, 2v, 4, 6, 8, single, 2x1, quad...). action=focus → focus pane by `index`. action=set_symbol → set `symbol` on pane `index`.',
    schema: {
      action: z.enum(['list', 'set_layout', 'focus', 'set_symbol']).describe('Pane operation'),
      layout: z.string().optional().describe('Layout code (action=set_layout): s (single), 2h, 2v, 2-1, 1-2, 3h, 3v, 4 (2x2), 6, 8; also single, 2x1, 1x2, 2x2, quad'),
      index: z.coerce.number().optional().describe('Pane index, 0-based from pane list (action=focus/set_symbol)'),
      symbol: z.string().optional().describe('Symbol to set (action=set_symbol, e.g., NQ1!, ES1!, AAPL)'),
    },
    handler: async ({ action, layout, index, symbol }) => {
      if (action === 'list') return core.list();
      if (action === 'set_layout') {
        if (!layout) throw new Error('action=set_layout requires `layout`.');
        return core.setLayout({ layout });
      }
      if (action === 'focus') {
        if (index === undefined) throw new Error('action=focus requires `index`.');
        return core.focus({ index });
      }
      if (index === undefined || !symbol) throw new Error('action=set_symbol requires `index` and `symbol`.');
      return core.setSymbol({ index, symbol });
    },
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'pane_list',
    description: 'List all chart panes in the current layout with their symbols and active state',
    legacy: 'pane',
    schema: {},
    handler: () => core.list(),
  },
  {
    name: 'pane_set_layout',
    description: 'Change the chart grid layout (e.g., single, 2x2, 2h, 3v)',
    legacy: 'pane',
    schema: { layout: z.string().describe('Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8') },
    handler: ({ layout }) => core.setLayout({ layout }),
  },
  {
    name: 'pane_focus',
    description: 'Focus a specific chart pane by index (0-based)',
    legacy: 'pane',
    schema: { index: z.coerce.number().describe('Pane index (0-based, from pane_list)') },
    handler: ({ index }) => core.focus({ index }),
  },
  {
    name: 'pane_set_symbol',
    description: 'Set the symbol on a specific pane by index',
    legacy: 'pane',
    schema: {
      index: z.coerce.number().describe('Pane index (0-based)'),
      symbol: z.string().describe('Symbol to set (e.g., NQ1!, ES1!, AAPL)'),
    },
    handler: ({ index, symbol }) => core.setSymbol({ index, symbol }),
  },
];
