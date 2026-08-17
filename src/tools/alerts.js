import { z } from 'zod';
import * as core from '../core/alerts.js';

// Consolidated tool definitions. Entries with `legacy: '<replacement>'` are
// pre-v3 tool names, registered only when TV_MCP_LEGACY=1.
export const group = 'alerts';

export const tools = [
  {
    name: 'alert_create',
    description: 'Create a price alert on the current chart symbol via TradingView\'s alert API',
    schema: {
      condition: z.string().describe('Alert condition: "crossing", "greater_than", or "less_than"'),
      price: z.coerce.number().describe('Price level for the alert'),
      message: z.string().optional().describe('Alert message'),
    },
    handler: ({ condition, price, message }) => core.create({ condition, price, message }),
  },
  {
    name: 'alert_manage',
    description: 'action=list → active alerts. action=delete → delete by `alert_id` (from list) or `delete_all`=true.',
    schema: {
      action: z.enum(['list', 'delete']).describe('Alert management operation'),
      alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_manage action=list)'),
      delete_all: z.coerce.boolean().optional().describe('Delete all active alerts (action=delete)'),
    },
    handler: async ({ action, alert_id, delete_all }) => {
      if (action === 'list') return core.list();
      return core.deleteAlerts({ alert_id, delete_all });
    },
  },

  // --- legacy aliases (TV_MCP_LEGACY=1) ---
  {
    name: 'alert_list',
    description: 'List active alerts',
    legacy: 'alert_manage',
    schema: {},
    handler: () => core.list(),
  },
  {
    name: 'alert_delete',
    description: 'Delete a specific alert by id, or all active alerts',
    legacy: 'alert_manage',
    schema: {
      alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_list)'),
      delete_all: z.coerce.boolean().optional().describe('Delete all active alerts'),
    },
    handler: ({ alert_id, delete_all }) => core.deleteAlerts({ alert_id, delete_all }),
  },
];
