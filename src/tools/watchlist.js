import { z } from 'zod';
import * as core from '../core/watchlist.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'watchlist';

async function dismissOpenInput() {
  // Best-effort close of any open search/input dialog after a failed add.
  try {
    const { getClient } = await import('../connection.js');
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  } catch (_) {}
}

export const tools = [
  {
    name: 'watchlist_get',
    description: 'Get all symbols from the current TradingView watchlist with last price, change, and change%',
    schema: {},
    handler: () => core.get(),
  },
  {
    name: 'watchlist_add',
    description: 'Add one or more symbols to the TradingView watchlist. Pass `symbols` array, or a single `symbol` string.',
    schema: {
      symbols: z.array(z.string()).optional().describe('Symbols to add (e.g., ["AAPL", "ES1!", "NYMEX:CL1!"])'),
      symbol: z.string().optional().describe('Single symbol to add (e.g., AAPL, BTCUSD, ES1!)'),
    },
    handler: async ({ symbols, symbol }) => {
      const list = symbols ?? (symbol ? [symbol] : []);
      if (list.length === 0) throw new Error('Provide `symbols` array or a single `symbol`.');
      if (list.length === 1) {
        try {
          return await core.add({ symbol: list[0] });
        } catch (err) {
          await dismissOpenInput();
          throw err;
        }
      }
      return core.addBulk({ symbols: list });
    },
  },
  {
    name: 'watchlist_remove',
    description: 'Remove one or more symbols from the active TradingView watchlist',
    schema: {
      symbols: z.array(z.string()).describe('Symbols to remove — bare (AAPL) or full (NASDAQ:AAPL)'),
    },
    handler: ({ symbols }) => core.remove({ symbols }),
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  // watchlist_add is a superset of the old watchlist_add / watchlist_add_bulk — no aliases needed.
];
