import { z } from 'zod';
import * as core from '../core/pine.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
// Target selection (pine_list_targets/pine_select_target) moved to the tab group (tab_list/tab_switch).
export const group = 'pine';

export const tools = [
  {
    name: 'pine_source',
    description: 'Pine editor source code. action=get → read current code (can be 200KB+ for complex scripts — avoid unless editing). action=set → inject `source` code. action=save → Ctrl+S. Call tab_switch/pine verify first to assert the right script is open (see pine_script action=verify).',
    schema: {
      action: z.enum(['get', 'set', 'save']).describe('Editor operation'),
      source: z.string().optional().describe('Pine Script source code to inject (action=set)'),
    },
    handler: async ({ action, source }) => {
      if (action === 'get') return core.getSource();
      if (action === 'set') {
        if (!source) throw new Error('action=set requires `source`.');
        return core.setSource({ source });
      }
      return core.save();
    },
  },
  {
    name: 'pine_compile',
    description: 'Compile / add the current Pine Script to the chart. smart=true → intelligent compile: detects the button, compiles, checks errors, reports study changes (use after pine_source set).',
    schema: {
      smart: z.coerce.boolean().optional().describe('Run the smart compile flow (default false = plain compile)'),
    },
    handler: ({ smart }) => (smart ? core.smartCompile() : core.compile()),
  },
  {
    name: 'pine_diagnostics',
    description: 'Read Pine diagnostics. kind=errors → compilation errors from Monaco markers. kind=console → runtime/compile log output (log.info(), errors).',
    schema: {
      kind: z.enum(['errors', 'console']).describe('Which diagnostics to read'),
    },
    handler: ({ kind }) => (kind === 'errors' ? core.getErrors() : core.getConsole()),
  },
  {
    name: 'pine_script',
    description: 'Manage saved Pine scripts. action=new → create blank script (`type`: indicator/strategy/library). action=open → open saved script by `name` (case-insensitive). action=list → list saved scripts. action=verify → inspect the Pine editor state of the connected tab (editor visible, active script tab, buffer match) — call BEFORE pine_source set/save to prevent editing a detached buffer.',
    schema: {
      action: z.enum(['new', 'open', 'list', 'verify']).describe('Script management operation'),
      type: z.enum(['indicator', 'strategy', 'library']).optional().describe('Script type (action=new)'),
      name: z.string().optional().describe('Saved script name (action=open, case-insensitive match)'),
    },
    handler: async ({ action, type, name }) => {
      if (action === 'new') {
        if (!type) throw new Error('action=new requires `type` (indicator/strategy/library).');
        return core.newScript({ type });
      }
      if (action === 'open') {
        if (!name) throw new Error('action=open requires `name`.');
        return core.openScript({ name });
      }
      if (action === 'list') return core.listScripts();
      return core.verifyTab();
    },
  },
  {
    name: 'pine_analyze',
    description: 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.',
    schema: {
      source: z.string().describe('Pine Script source code to analyze'),
    },
    handler: ({ source }) => core.analyze({ source }),
  },
  {
    name: 'pine_check',
    description: 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.',
    schema: {
      source: z.string().describe('Pine Script source code to compile/validate'),
    },
    handler: ({ source }) => core.check({ source }),
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  // pine_compile is a superset of the old pine_compile (smart param optional) — no alias needed.
  {
    name: 'pine_get_source',
    description: 'Get current Pine Script source code from the editor',
    legacy: 'pine_source',
    schema: {},
    handler: () => core.getSource(),
  },
  {
    name: 'pine_set_source',
    description: 'Set Pine Script source code in the editor',
    legacy: 'pine_source',
    schema: { source: z.string().describe('Pine Script source code to inject') },
    handler: ({ source }) => core.setSource({ source }),
  },
  {
    name: 'pine_save',
    description: 'Save the current Pine Script (Ctrl+S)',
    legacy: 'pine_source',
    schema: {},
    handler: () => core.save(),
  },
  {
    name: 'pine_get_errors',
    description: 'Get Pine Script compilation errors from Monaco markers',
    legacy: 'pine_diagnostics',
    schema: {},
    handler: () => core.getErrors(),
  },
  {
    name: 'pine_get_console',
    description: 'Read Pine Script console/log output (compile messages, log.info(), errors)',
    legacy: 'pine_diagnostics',
    schema: {},
    handler: () => core.getConsole(),
  },
  {
    name: 'pine_smart_compile',
    description: 'Intelligent compile: detects button, compiles, checks errors, reports study changes',
    legacy: 'pine_compile',
    schema: {},
    handler: () => core.smartCompile(),
  },
  {
    name: 'pine_new',
    description: 'Create a new blank Pine Script',
    legacy: 'pine_script',
    schema: { type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create') },
    handler: ({ type }) => core.newScript({ type }),
  },
  {
    name: 'pine_open',
    description: 'Open a saved Pine Script by name',
    legacy: 'pine_script',
    schema: { name: z.string().describe('Name of the saved script to open (case-insensitive match)') },
    handler: ({ name }) => core.openScript({ name }),
  },
  {
    name: 'pine_list_scripts',
    description: 'List saved Pine Scripts',
    legacy: 'pine_script',
    schema: {},
    handler: () => core.listScripts(),
  },
  {
    name: 'pine_verify_tab',
    description: 'Inspect the Pine editor state of the CONNECTED tab',
    legacy: 'pine_script',
    schema: {},
    handler: () => core.verifyTab(),
  },
];
