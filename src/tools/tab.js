import { z } from 'zod';
import * as core from '../core/tab.js';
import * as pineCore from '../core/pine.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
// tab_switch also absorbed pine_select_target (CDP target re-attach).
export const group = 'tab';

export const tools = [
  {
    name: 'tab_list',
    description: 'List open TradingView chart tabs. targets=true → instead list all browser tabs (CDP targets) with ids, so you can point the server at the tab that shows the Pine editor.',
    schema: {
      targets: z.coerce.boolean().optional().describe('List CDP targets (with target ids for tab_switch target_id) instead of chart tabs'),
    },
    handler: ({ targets }) => (targets ? pineCore.listTargets() : core.list()),
  },
  {
    name: 'tab_new',
    description: 'Open a new chart tab. Optionally pick what to load in it: layout "new" creates a named blank layout, or pass a saved layout name to open it.',
    schema: {
      layout: z.string().optional().describe('"new" for a blank new layout, or a saved layout name (substring match). Omit to leave the tab on the layout picker.'),
      name: z.string().optional().describe('Name for the new layout (used with layout: "new"; default "New layout")'),
    },
    handler: ({ layout, name }) => core.newTab({ layout, name }),
  },
  {
    name: 'tab_close',
    description: 'Close the current chart tab',
    schema: {},
    handler: () => core.closeTab(),
  },
  {
    name: 'tab_switch',
    description: 'Switch the MCP connection to another tab: by chart tab `index` (from tab_list), or by CDP `target_id` (from tab_list targets=true — use this to point pine_* tools at the tab that shows the Pine editor). Subsequent operations act on the selected tab.',
    schema: {
      index: z.coerce.number().optional().describe('Chart tab index (0-based, from tab_list)'),
      target_id: z.string().optional().describe('CDP target id (from tab_list with targets=true)'),
    },
    handler: async ({ index, target_id }) => {
      if (target_id) return pineCore.selectTarget({ targetId: target_id });
      if (index !== undefined) return core.switchTab({ index });
      throw new Error('Provide either `index` or `target_id`.');
    },
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'layout_new',
    description: 'Create a new named blank chart layout (opens in a new tab)',
    legacy: 'tab_new',
    schema: { name: z.string().optional().describe('Layout name (default "New layout")') },
    handler: ({ name }) => core.newTab({ layout: 'new', name }),
  },
  {
    name: 'pine_list_targets',
    description: 'List all TradingView browser tabs (CDP targets)',
    legacy: 'tab_list',
    schema: {},
    handler: () => pineCore.listTargets(),
  },
  {
    name: 'pine_select_target',
    description: 'Point all subsequent operations at a specific browser tab (CDP target id)',
    legacy: 'tab_switch',
    schema: { target_id: z.string().describe('CDP target id from pine_list_targets') },
    handler: ({ target_id }) => pineCore.selectTarget({ targetId: target_id }),
  },
];
