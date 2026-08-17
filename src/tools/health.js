import { z } from 'zod';
import * as core from '../core/health.js';
import { update } from '../core/update.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'health';

export const tools = [
  {
    name: 'tv_health_check',
    description: 'Check CDP connection to TradingView and return current chart state. discover=true → also report which known TradingView internal API paths are available and their methods.',
    schema: {
      discover: z.coerce.boolean().optional().describe('Also list available internal API paths (default false)'),
    },
    hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.',
    handler: ({ discover }) => (discover ? core.discover() : core.healthCheck()),
  },
  {
    name: 'tv_ui_state',
    description: 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled',
    schema: {},
    handler: () => core.uiState(),
  },
  {
    name: 'tv_launch',
    description: 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux, including Windows MSIX/Store installs. If a Store install blocks the debug port, automatically relaunches from a local package copy (result then includes msix_local_copy: true; the first fallback launch copies ~330MB one time, so it can take a minute).',
    schema: {
      port: z.coerce.number().optional().describe('CDP port (default 9223)'),
      kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
    },
    handler: ({ port, kill_existing }) => core.launch({ port, kill_existing }),
  },
  {
    name: 'tv_update',
    description: 'Update this MCP server to the latest version: git fast-forward of origin/main + npm ci when dependencies changed. Safe by design — refuses on non-git installs, dirty working trees, non-main branches, or diverged history. After a successful update the MCP server must be restarted to load the new code.',
    schema: {},
    handler: () => update({}),
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  // tv_health_check is a superset of the old tv_discover — no alias needed.
];
