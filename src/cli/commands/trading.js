import { register } from '../router.js';
import * as core from '../../core/trading.js';

register('trading', {
  description: 'EXPERIMENTAL — TradingView paper-trading panel automation (DOM)',
  subcommands: new Map([
    ['trade', {
      description: 'Place a paper trade via the order ticket (action=market|limit|stop|close; pass --dry-run to probe without submitting)',
      options: {
        action: { type: 'string', description: 'Order action: market, limit, stop, or close' },
        side: { type: 'string', description: 'Trade side: buy or sell (required for market/limit/stop and close)' },
        qty: { type: 'string', description: 'Quantity (positive number)' },
        price: { type: 'string', description: 'Limit/stop trigger price' },
        symbol: { type: 'string', description: 'Symbol to focus before opening the panel' },
        'dry-run': { type: 'boolean', short: 'd', description: 'Probe the whole flow without submitting' },
      },
      handler: (opts) => core.trade({
        action: opts.action,
        side: opts.side,
        qty: opts.qty !== undefined ? Number(opts.qty) : undefined,
        price: opts.price !== undefined ? Number(opts.price) : undefined,
        symbol: opts.symbol,
        dry_run: opts['dry-run'],
      }),
    }],
    ['probe', {
      description: 'Dump trading panel DOM + TradingViewApi namespaces for selector calibration',
      handler: () => core.probe({}),
    }],
    ['status', {
      description: 'Read paper-trading positions and open orders from the panel',
      handler: () => core.status({}),
    }],
  ]),
});
