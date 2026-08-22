import { z } from 'zod';
import * as core from '../core/ui.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'ui';

const selector = {
  by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
  value: z.string().describe('Value to match against the chosen selector strategy'),
};

export const tools = [
  {
    name: 'ui_input',
    description: 'Generic UI input. action=click/hover → `by` + `value` selector. action=mouse_click → `x`,`y` (+ `button`, `double_click`). action=keyboard → `key` (+ `modifiers`, e.g. Alt+S, Ctrl+Z). action=type → `text` into focused element. action=scroll → `direction` (+ `amount`). action=panel → `panel` (pine-editor, strategy-tester, watchlist, alerts, trading) + `panel_action` (open/close/toggle). action=fullscreen → toggle fullscreen.',
    schema: {
      action: z.enum(['click', 'hover', 'mouse_click', 'keyboard', 'type', 'scroll', 'panel', 'fullscreen']).describe('Input operation'),
      by: selector.by.optional(),
      value: selector.value.optional().describe('Value to match (action=click/hover)'),
      x: z.coerce.number().optional().describe('X coordinate in pixels (action=mouse_click)'),
      y: z.coerce.number().optional().describe('Y coordinate in pixels (action=mouse_click)'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (action=mouse_click, default left)'),
      double_click: z.coerce.boolean().optional().describe('Double click (action=mouse_click)'),
      key: z.string().optional().describe('Key to press (action=keyboard, e.g. "Enter", "Escape", "ArrowUp", "a")'),
      modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys (action=keyboard)'),
      text: z.string().optional().describe('Text to type into the focused element (action=type)'),
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (action=scroll)'),
      amount: z.coerce.number().optional().describe('Scroll amount in pixels (action=scroll, default 300)'),
      panel: z.enum(['pine-editor', 'strategy-tester', 'watchlist', 'alerts', 'trading']).optional().describe('Panel name (action=panel)'),
      panel_action: z.enum(['open', 'close', 'toggle']).optional().describe('Panel operation (action=panel)'),
    },
    handler: async ({ action, by, value, x, y, button, double_click, key, modifiers, text, direction, amount, panel, panel_action }) => {
      if (action === 'click' || action === 'hover') {
        if (!by || !value) throw new Error(`action=${action} requires \`by\` and \`value\`.`);
        return action === 'click' ? core.click({ by, value }) : core.hover({ by, value });
      }
      if (action === 'mouse_click') {
        if (x === undefined || y === undefined) throw new Error('action=mouse_click requires `x` and `y`.');
        return core.mouseClick({ x, y, button, double_click });
      }
      if (action === 'keyboard') {
        if (!key) throw new Error('action=keyboard requires `key`.');
        return core.keyboard({ key, modifiers });
      }
      if (action === 'type') {
        if (!text) throw new Error('action=type requires `text`.');
        return core.typeText({ text });
      }
      if (action === 'scroll') {
        if (!direction) throw new Error('action=scroll requires `direction`.');
        return core.scroll({ direction, amount });
      }
      if (action === 'panel') {
        if (!panel) throw new Error('action=panel requires `panel` (and optionally `panel_action`, default toggle).');
        return core.openPanel({ panel, action: panel_action ?? 'toggle' });
      }
      return core.fullscreen();
    },
  },
  {
    name: 'ui_find_element',
    description: 'Find UI elements by text, aria-label, or CSS selector and return their positions',
    schema: {
      query: z.string().describe('Text content, aria-label value, or CSS selector to search for'),
      strategy: z.enum(['text', 'aria-label', 'css']).optional().describe('Search strategy (default: text)'),
    },
    handler: ({ query, strategy }) => core.findElement({ query, strategy }),
  },
  {
    name: 'ui_evaluate',
    description: 'Execute JavaScript code in the TradingView page context for advanced automation',
    schema: {
      expression: z.string().describe('JavaScript expression to evaluate in the page context. Wrap in IIFE for complex logic.'),
    },
    handler: ({ expression }) => core.uiEvaluate({ expression }),
  },
  {
    name: 'layout_list',
    description: 'List saved chart layouts',
    schema: {},
    handler: () => core.layoutList(),
  },
  {
    name: 'layout_switch',
    description: 'Switch to a saved chart layout by name or ID',
    schema: {
      name: z.string().describe('Name or ID of the layout to switch to'),
    },
    handler: ({ name }) => core.layoutSwitch({ name }),
  },
  {
    name: 'layout_active',
    description: 'Show which saved layout is currently active on the connected tab',
    schema: {},
    handler: () => core.getActiveLayout(),
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'ui_click',
    description: 'Click a UI element by aria-label, data-name, text content, or class substring',
    legacy: 'ui_input',
    schema: selector,
    handler: ({ by, value }) => core.click({ by, value }),
  },
  {
    name: 'ui_open_panel',
    description: 'Open, close, or toggle TradingView panels (pine-editor, strategy-tester, watchlist, alerts, trading)',
    legacy: 'ui_input',
    schema: {
      panel: z.enum(['pine-editor', 'strategy-tester', 'watchlist', 'alerts', 'trading']).describe('Panel name'),
      action: z.enum(['open', 'close', 'toggle']).describe('Action to perform'),
    },
    handler: ({ panel, action }) => core.openPanel({ panel, action }),
  },
  {
    name: 'ui_fullscreen',
    description: 'Toggle TradingView fullscreen mode',
    legacy: 'ui_input',
    schema: {},
    handler: () => core.fullscreen(),
  },
  {
    name: 'ui_keyboard',
    description: 'Press keyboard keys or shortcuts (e.g., Enter, Escape, Alt+S, Ctrl+Z)',
    legacy: 'ui_input',
    schema: {
      key: z.string().describe('Key to press'),
      modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys to hold'),
    },
    handler: ({ key, modifiers }) => core.keyboard({ key, modifiers }),
  },
  {
    name: 'ui_type_text',
    description: 'Type text into the currently focused input/textarea element',
    legacy: 'ui_input',
    schema: { text: z.string().describe('Text to type into the focused element') },
    handler: ({ text }) => core.typeText({ text }),
  },
  {
    name: 'ui_hover',
    description: 'Hover over a UI element by aria-label, data-name, or text content',
    legacy: 'ui_input',
    schema: selector,
    handler: ({ by, value }) => core.hover({ by, value }),
  },
  {
    name: 'ui_scroll',
    description: 'Scroll the chart or page up/down/left/right',
    legacy: 'ui_input',
    schema: {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
      amount: z.coerce.number().optional().describe('Scroll amount in pixels (default 300)'),
    },
    handler: ({ direction, amount }) => core.scroll({ direction, amount }),
  },
  {
    name: 'ui_mouse_click',
    description: 'Click at specific x,y coordinates on the TradingView window',
    legacy: 'ui_input',
    schema: {
      x: z.coerce.number().describe('X coordinate (pixels from left)'),
      y: z.coerce.number().describe('Y coordinate (pixels from top)'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
      double_click: z.coerce.boolean().optional().describe('Double click (default false)'),
    },
    handler: ({ x, y, button, double_click }) => core.mouseClick({ x, y, button, double_click }),
  },
];
