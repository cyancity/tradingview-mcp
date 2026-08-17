import { z } from 'zod';
import * as core from '../core/drawing.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'drawing';

export const tools = [
  {
    name: 'draw',
    description: 'Chart drawings. action=shape → draw with `shape` (horizontal_line, vertical_line, trend_line, rectangle, text) at `point` {time, price} (+ `point2` for two-point shapes, `text`, `overrides` JSON). action=list / clear / remove (`entity_id`) / properties (`entity_id`).',
    schema: {
      action: z.enum(['shape', 'list', 'clear', 'remove', 'properties']).describe('Drawing operation'),
      shape: z.string().optional().describe('Shape type (action=shape): horizontal_line, vertical_line, trend_line, rectangle, text'),
      point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('First point {time: unix_timestamp, price} (action=shape)'),
      point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Second point for two-point shapes (trend_line, rectangle)'),
      overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
      text: z.string().optional().describe('Text content for text shapes'),
      entity_id: z.string().optional().describe('Drawing entity id (action=remove/properties, from draw action=list)'),
    },
    handler: async ({ action, shape, point, point2, overrides, text, entity_id }) => {
      if (action === 'shape') {
        if (!shape || !point) throw new Error('action=shape requires `shape` and `point`.');
        return core.drawShape({ shape, point, point2, overrides, text });
      }
      if (action === 'list') return core.listDrawings();
      if (action === 'clear') return core.clearAll();
      if (!entity_id) throw new Error(`action=${action} requires \`entity_id\`.`);
      return action === 'remove'
        ? core.removeOne({ entity_id })
        : core.getProperties({ entity_id });
    },
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'draw_shape',
    description: 'Draw a shape/line on the chart',
    legacy: 'draw',
    schema: {
      shape: z.string().describe('Shape type: horizontal_line, vertical_line, trend_line, rectangle, text'),
      point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('{ time: unix_timestamp, price: number }'),
      point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Second point for two-point shapes'),
      overrides: z.string().optional().describe('JSON string of style overrides'),
      text: z.string().optional().describe('Text content for text shapes'),
    },
    handler: ({ shape, point, point2, overrides, text }) => core.drawShape({ shape, point, point2, overrides, text }),
  },
  {
    name: 'draw_list',
    description: 'List all shapes/drawings on the chart',
    legacy: 'draw',
    schema: {},
    handler: () => core.listDrawings(),
  },
  {
    name: 'draw_clear',
    description: 'Remove all drawings from the chart',
    legacy: 'draw',
    schema: {},
    handler: () => core.clearAll(),
  },
  {
    name: 'draw_remove_one',
    description: 'Remove a specific drawing by entity ID',
    legacy: 'draw',
    schema: { entity_id: z.string().describe('Entity ID of the drawing to remove (from draw_list)') },
    handler: ({ entity_id }) => core.removeOne({ entity_id }),
  },
  {
    name: 'draw_get_properties',
    description: 'Get properties and points of a specific drawing',
    legacy: 'draw',
    schema: { entity_id: z.string().describe('Entity ID of the drawing (from draw_list)') },
    handler: ({ entity_id }) => core.getProperties({ entity_id }),
  },
];
