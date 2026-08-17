import { z } from 'zod';
import * as core from '../core/indicators.js';
import * as chartCore from '../core/chart.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'indicators';

export const tools = [
  {
    name: 'indicator',
    description: 'Manage chart indicators/studies. action=add: pass full built-in name via `indicator` (e.g. "Relative Strength Index") OR search-and-add any script via `query` (+ optional `match`, `section` — works for strategies/community scripts). action=remove: pass `entity_id`. action=search: `query` + `limit`. action=set_inputs: `entity_id` + `inputs` JSON. action=toggle: `entity_id` + `visible`.',
    schema: {
      action: z.enum(['add', 'remove', 'search', 'set_inputs', 'toggle']).describe('Operation to perform'),
      indicator: z.string().optional().describe('Full built-in indicator name for add (e.g., "Moving Average Exponential"). Short names like RSI/EMA do NOT work — use `query` search path for those.'),
      query: z.string().optional().describe('Search keyword (for action=add via dialog search, or action=search)'),
      match: z.string().optional().describe('Exact title to add (action=add via search; default: the query). Case-insensitive; falls back to first title containing it.'),
      section: z.string().optional().describe('Restrict search to a section: "Technicals", "Community", "My scripts", etc.'),
      limit: z.coerce.number().optional().describe('Max search results (action=search, default 25)'),
      entity_id: z.string().optional().describe('Entity ID of the study (from chart_get_state) — required for remove/set_inputs/toggle'),
      inputs: z.string().optional().describe('JSON string of input overrides (set_inputs), e.g. \'{"length": 50, "source": "close"}\''),
      visible: z.coerce.boolean().optional().describe('true to show, false to hide (action=toggle)'),
    },
    handler: async ({ action, indicator, query, match, section, limit, entity_id, inputs, visible }) => {
      if (action === 'add') {
        if (indicator) return chartCore.manageIndicator({ action: 'add', indicator });
        if (query) return core.addStudyFromSearch({ query, match, section });
        throw new Error('action=add requires `indicator` (built-in full name) or `query` (dialog search).');
      }
      if (action === 'remove') {
        if (!entity_id) throw new Error('action=remove requires `entity_id`.');
        return chartCore.manageIndicator({ action: 'remove', entity_id });
      }
      if (action === 'search') {
        if (!query) throw new Error('action=search requires `query`.');
        return core.searchStudies({ query, limit });
      }
      if (action === 'set_inputs') {
        if (!entity_id || !inputs) throw new Error('action=set_inputs requires `entity_id` and `inputs`.');
        return core.setInputs({ entity_id, inputs });
      }
      if (action === 'toggle') {
        if (!entity_id || visible === undefined) throw new Error('action=toggle requires `entity_id` and `visible`.');
        return core.toggleVisibility({ entity_id, visible });
      }
      throw new Error(`Unknown action: ${action}`);
    },
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'chart_manage_indicator',
    description: 'Add or remove an indicator/study on the chart',
    legacy: 'indicator',
    schema: {
      action: z.enum(['add', 'remove']).describe('Action: add or remove'),
      indicator: z.string().optional().describe('Full indicator name (required for add)'),
      entity_id: z.string().optional().describe('Entity ID (from chart_get_state). Required for remove.'),
      inputs: z.string().optional().describe('JSON string of input overrides'),
    },
    handler: async ({ action, indicator, entity_id, inputs }) => {
      if (action === 'add' && !indicator) throw new Error('indicator name is required for add action.');
      return chartCore.manageIndicator({ action, indicator, entity_id, inputs });
    },
  },
  {
    name: 'indicator_add',
    description: 'Search the Indicators dialog and add a result to the chart by name',
    legacy: 'indicator',
    schema: {
      query: z.string().describe('Search keyword to find the indicator/strategy'),
      match: z.string().optional().describe('Exact title to add (default: the query)'),
      section: z.string().optional().describe('Restrict to a section'),
    },
    handler: ({ query, match, section }) => core.addStudyFromSearch({ query, match, section }),
  },
  {
    name: 'indicator_search',
    description: 'Search TradingView\'s Indicators dialog by keyword',
    legacy: 'indicator',
    schema: {
      query: z.string().describe('Search keyword, e.g. "RSI", "supertrend", "order block"'),
      limit: z.coerce.number().optional().describe('Max results to return (default 25)'),
    },
    handler: ({ query, limit }) => core.searchStudies({ query, limit }),
  },
  {
    name: 'indicator_set_inputs',
    description: 'Change indicator/study input values (e.g., length, source, period)',
    legacy: 'indicator',
    schema: {
      entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
      inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50}\''),
    },
    handler: ({ entity_id, inputs }) => core.setInputs({ entity_id, inputs }),
  },
  {
    name: 'indicator_toggle_visibility',
    description: 'Show or hide an indicator/study on the chart',
    legacy: 'indicator',
    schema: {
      entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
      visible: z.coerce.boolean().describe('true to show, false to hide'),
    },
    handler: ({ entity_id, visible }) => core.toggleVisibility({ entity_id, visible }),
  },
];
