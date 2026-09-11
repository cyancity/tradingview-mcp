import { register } from '../router.js';
import * as core from '../../core/drawing.js';

register('draw', {
  description: 'Drawing tools (shape, list, get, remove, clear)',
  subcommands: new Map([
    ['shape', {
      description: 'Draw a shape on the chart',
      options: {
        type: { type: 'string', short: 't', description: 'Shape type: horizontal_line, vertical_line, trend_line, rectangle, ray, long_position, short_position, text, arrow' },
        price: { type: 'string', short: 'p', description: 'Price level' },
        time: { type: 'string', description: 'Unix timestamp' },
        price2: { type: 'string', description: 'Second point price (for trend_line, rectangle)' },
        time2: { type: 'string', description: 'Second point time (for trend_line, rectangle)' },
        points: { type: 'string', description: 'JSON array of {time, price}; takes precedence over --time/--price. Length per shape: 1 horizontal_line/vertical_line/text, 2 trend_line/rectangle/ray/arrow, 3 long_position/short_position' },
        text: { type: 'string', description: 'Text content (for text shapes)' },
        overrides: { type: 'string', description: 'JSON style overrides (e.g. \'{"stopLevel":83,"profitLevel":440,"qty":6}\')' },
      },
      handler: (opts) => {
        // `--points` wins over the legacy --time/--price pair so 3-anchor tools
        // (long_position / short_position) are reachable without the MCP profile.
        if (opts.points) {
          let points;
          try { points = JSON.parse(opts.points); } catch (e) { throw new Error('--points must be valid JSON: ' + e.message); }
          return core.drawShape({ shape: opts.type, points, overrides: opts.overrides, text: opts.text });
        }
        const point = { time: Number(opts.time), price: Number(opts.price) };
        const point2 = opts.price2 ? { time: Number(opts.time2), price: Number(opts.price2) } : undefined;
        return core.drawShape({ shape: opts.type || 'horizontal_line', point, point2, overrides: opts.overrides, text: opts.text });
      },
    }],
    ['list', {
      description: 'List all drawings on the chart',
      handler: () => core.listDrawings(),
    }],
    ['get', {
      description: 'Get properties of a drawing',
      handler: (opts, positionals) => core.getProperties({ entity_id: positionals[0] }),
    }],
    ['remove', {
      description: 'Remove a drawing by entity ID',
      handler: (opts, positionals) => core.removeOne({ entity_id: positionals[0] }),
    }],
    ['clear', {
      description: 'Remove all drawings',
      handler: () => core.clearAll(),
    }],
  ]),
});
