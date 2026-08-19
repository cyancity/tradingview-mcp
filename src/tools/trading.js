import { z } from 'zod';
import * as core from '../core/trading.js';

// EXPERIMENTAL domain: no verified public code path exists for live
// paper-order placement via CDP DOM automation. Selectors must be calibrated
// at runtime with trade_probe, may break with any TradingView UI update, and
// this domain never touches real brokerage accounts.
const EXPERIMENTAL_WARNING =
  'EXPERIMENTAL — no verified public code path exists for live paper-order placement; selectors must be calibrated with trade_probe; this may break with any TradingView UI update; it never touches real brokerage accounts.';

export const group = 'trading';

export const tools = [
  {
    name: 'trade',
    description: `Automate the live TradingView paper-trading order ticket via CDP DOM automation. action=market|limit|stop|close; for action=close, side must be provided to close long or short (qty/price optional and may be omitted). side=buy|sell required for market/limit/stop. qty is a coerced positive finite number (required for market/limit/stop, optional for close). price is a coerced number required for limit/stop (price of the limit/stop trigger). symbol is an optional string used only to focus the chart/symbol search before opening the panel; if omitted the current chart symbol is used. dry_run (default false) probes all required elements (paper mode detection, panel open, order-type selector, qty/price inputs, submit button) but never clicks submit and never dispatches the confirming click; when dry_run=true the tool proceeds even if paper mode is not detected. Returns { success, action, side, qty, price, order_type, submitted, dry_run, paper_mode, error? }. ${EXPERIMENTAL_WARNING}`,
    schema: {
      action: z.enum(['market', 'limit', 'stop', 'close']).describe('Order type action to execute'),
      side: z.enum(['buy', 'sell']).optional().describe('Trade side; required for market/limit/stop, optional for close'),
      qty: z.coerce.number().optional().describe('Quantity as a positive finite number; required for market/limit/stop'),
      price: z.coerce.number().optional().describe('Limit/stop trigger price; required when action is limit or stop'),
      symbol: z.string().optional().describe('Symbol to focus before opening the panel; defaults to current chart symbol'),
      dry_run: z.coerce.boolean().optional().describe('When true, probe the whole flow but never submit (bypasses paper-mode safety gate)'),
    },
    handler: async (args) => core.trade(args),
  },
  {
    name: 'trade_probe',
    description: `Dump the visible order-ticket/trading-panel DOM for selector calibration. No params. Enumerates all elements inside the trading panel container that carry data-name or aria-label attributes (plus buttons/inputs by tag and text), returning a list of { tag, data_name, aria_label, class, text } entries, and also probes window.TradingViewApi for any broker/orders/account/trading namespace returning the discovered method names. Use the output to update SELECTORS in src/core/trading.js. Returns { success, elements, api_namespaces, panel_open, paper_mode }. ${EXPERIMENTAL_WARNING}`,
    schema: {},
    handler: async (args) => core.probe(args),
  },
  {
    name: 'trade_status',
    description: `Read current paper-trading account state: open positions and open orders from the live panel's position/order lists. No params. Finds the positions widget and the open-orders section in the bottom widget bar, enumerates rows by data-name/aria-label, and returns each as { symbol, side, qty, price, pnl? }. Returns { success, paper_mode, positions, orders }. ${EXPERIMENTAL_WARNING}`,
    schema: {},
    handler: async (args) => core.status(args),
  },
];
