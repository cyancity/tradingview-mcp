/**
 * Central tool registry.
 *
 * Every domain file exports `group` and `tools` (tool definitions). This module
 * owns the full catalog and the selection logic driven by env vars:
 *
 *   TV_MCP_PROFILE  Comma-separated profile/group tokens. Presets: full, quant,
 *                   data, chart, pine, ui, minimal, lazy. Group names are also
 *                   valid tokens (e.g. "data,chart,capture"). Default: full.
 *   TV_MCP_TOOLS    Explicit allowlist: exact tool names or `prefix_*` globs
 *                   (e.g. "data_get_ohlcv,tab_*"). Unioned with the profile.
 *                   Exact names bypass the legacy gate.
 *   TV_MCP_LEGACY   1 = also register pre-v3 tool names (marked legacy in
 *                   domain files). Default: 0.
 *
 * Tool order is deterministic (domain import order, file order) which keeps
 * tools/list stable across restarts — better LLM prompt-cache hit rates.
 */
import { z } from 'zod';
import { wrap } from './_format.js';
import * as health from './health.js';
import * as chart from './chart.js';
import * as indicators from './indicators.js';
import * as data from './data.js';
import * as capture from './capture.js';
import * as pine from './pine.js';
import * as tab from './tab.js';
import * as pane from './pane.js';
import * as replay from './replay.js';
import * as drawing from './drawing.js';
import * as alerts from './alerts.js';
import * as watchlist from './watchlist.js';
import * as ui from './ui.js';
import * as batch from './batch.js';

// Fixed order = registration order = tools/list order.
const DOMAINS = [health, chart, indicators, data, capture, pine, tab, pane, replay, drawing, alerts, watchlist, ui, batch];

// Tools always exposed in lazy mode next to tv_call/tv_tools_catalog.
const LAZY_CORE = [
  'chart_get_state',
  'chart_set',
  'data_get_ohlcv',
  'data_get_study',
  'capture_screenshot',
];

// high-frequency starter set for the minimal profile.
const MINIMAL = [
  ...LAZY_CORE,
  'data_get_study',
  'data_get_pine_drawings',
  'quote_get',
  'symbol_search',
  'tv_health_check',
  'tab_list',
  'batch_run',
];

// Presets map to tokens: group names, tool names, or other presets.
export const PROFILES = {
  full: null, // all groups (default)
  quant: ['data', 'chart', 'indicators', 'capture', 'batch', 'health'],
  data: ['data', 'health'],
  chart: ['chart', 'indicators', 'tab', 'pane', 'capture', 'health'],
  pine: ['pine', 'tab', 'health'],
  ui: ['ui', 'health'],
  minimal: MINIMAL,
  lazy: 'lazy', // handled specially: tv_call + tv_tools_catalog + LAZY_CORE
};

const GROUP_NAMES = new Set(DOMAINS.map((d) => d.group));

// Full catalog in deterministic order: [{ name, description, schema, handler,
// group, legacy?, hint? }]. Legacy entries carry the name of their v3 replacement.
const catalog = DOMAINS.flatMap((d) => d.tools.map((t) => ({ group: d.group, ...t })));
const catalogIndex = new Map(catalog.map((t) => [t.name, t]));

export function getCatalog() {
  return catalog;
}

export function getCatalogIndex() {
  return catalogIndex;
}

const flag = (v) => /^(1|true|yes)$/i.test(v ?? '');

/**
 * Resolve which tool names to register from env-like input.
 * Returns { selected, explicit, legacy, lazy, warnings }.
 */
export function resolveSelection(env = process.env) {
  const warnings = [];
  const legacy = flag(env.TV_MCP_LEGACY);
  const explicit = new Set(); // exact names from TV_MCP_TOOLS (bypass legacy gate)
  const selected = new Set();
  let lazy = false;

  const addTool = (name) => {
    const def = catalogIndex.get(name);
    if (!def) return warnings.push(`TV_MCP_TOOLS: unknown tool "${name}" — skipped`);
    if (def.legacy && !legacy && !explicit.has(name)) return; // gated
    selected.add(name);
  };

  const profileRaw = (env.TV_MCP_PROFILE ?? '').trim();
  const toolsRaw = (env.TV_MCP_TOOLS ?? '').trim();
  // Neither set → full. Only TV_MCP_TOOLS set → start from an empty base so the
  // allowlist gives exact control. Both set → union.
  const tokens = profileRaw
    ? profileRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : (toolsRaw ? [] : ['full']);

  for (const token of tokens) {
    if (token === 'lazy') {
      lazy = true;
      LAZY_CORE.forEach((n) => addTool(n));
      continue;
    }
    if (token === 'full' || PROFILES[token] === null) {
      DOMAINS.forEach((d) => d.tools.forEach((t) => addTool(t.name)));
      continue;
    }
    const preset = PROFILES[token];
    if (preset) {
      for (const sub of preset) {
        if (GROUP_NAMES.has(sub)) {
          catalog.filter((t) => t.group === sub).forEach((t) => addTool(t.name));
        } else {
          addTool(sub);
        }
      }
      continue;
    }
    if (GROUP_NAMES.has(token)) {
      catalog.filter((t) => t.group === token).forEach((t) => addTool(t.name));
      continue;
    }
    warnings.push(`TV_MCP_PROFILE: unknown token "${token}" — skipped (valid: ${[...GROUP_NAMES].join(', ')}, or presets: ${Object.keys(PROFILES).join(', ')})`);
  }

  // Explicit allowlist (exact names or prefix_* globs), unioned on top.
  if (toolsRaw) {
    for (const entry of toolsRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (entry.endsWith('*')) {
        const prefix = entry.slice(0, -1);
        let matched = false;
        for (const t of catalog) {
          if (t.name.startsWith(prefix)) { matched = true; explicit.add(t.name); addTool(t.name); }
        }
        if (!matched) warnings.push(`TV_MCP_TOOLS: glob "${entry}" matched nothing — skipped`);
      } else {
        explicit.add(entry);
        addTool(entry);
      }
    }
  }

  return { selected, explicit, legacy, lazy, warnings };
}

// --- lazy-mode meta tools (group: meta, registered only in lazy profile) ---

function catalogText(includeLegacy) {
  const lines = catalog
    .filter((t) => includeLegacy || !t.legacy)
    .map((t) => {
      const params = Object.keys(t.schema ?? {}).join(', ');
      return `${t.name}(${params})${t.legacy ? ' [legacy]' : ''} — ${t.description}`;
    });
  return `TradingView MCP tool catalog (${lines.length} tools). Call any of them via tv_call:\n${lines.join('\n')}`;
}

const lazyTools = [
  {
    name: 'tv_tools_catalog',
    group: 'meta',
    description: 'List ALL available TradingView MCP tools (name, params, description) as compact text. Use this to discover tools in lazy mode, then invoke them with tv_call.',
    schema: {},
    handler: () => catalogText(flag(process.env.TV_MCP_LEGACY)),
  },
  {
    name: 'tv_call',
    group: 'meta',
    description: 'Invoke any tool from the TradingView MCP catalog by name with a JSON args object. Discover names/params via tv_tools_catalog. Prefer direct tools when they are already listed.',
    schema: {
      tool: z.string().describe('Tool name from tv_tools_catalog'),
      args: z.record(z.string(), z.any()).optional().describe('Arguments object for the tool'),
    },
    handler: async ({ tool, args }) => {
      const def = catalogIndex.get(tool);
      if (!def) throw new Error(`Unknown tool: ${tool}. Use tv_tools_catalog to list available tools.`);
      return def.handler(args ?? {});
    },
  },
];

/**
 * Register tools on an MCP server according to env selection.
 * Returns { registered, selection } for callers/tests.
 */
export function registerTools(server, env = process.env) {
  const selection = resolveSelection(env);
  for (const w of selection.warnings) process.stderr.write(`⚠ tradingview-mcp: ${w}\n`);

  let registered = 0;
  const register = (def) => {
    server.tool(def.name, def.description, def.schema, wrap(def.handler, def.hint && { hint: def.hint }));
    registered++;
  };

  if (selection.lazy) {
    for (const def of lazyTools) register(def);
    for (const name of LAZY_CORE) {
      if (selection.selected.has(name)) register(catalogIndex.get(name));
    }
    return { registered, selection };
  }

  for (const def of catalog) {
    if (!selection.selected.has(def.name)) continue;
    if (def.legacy && !selection.legacy && !selection.explicit.has(def.name)) continue;
    register(def);
  }
  return { registered, selection };
}
