import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { getCatalog, registerTools, resolveSelection } from '../src/tools/registry.js';
import { jsonResult } from '../src/tools/_format.js';

const catalog = getCatalog();

function mockServer() {
  const tools = [];
  return {
    tools,
    tool(name, description, schema, handler) {
      tools.push({ name, description, schema, handler });
    },
  };
}

const ACTIVE_TOOLS = [
  // health
  'tv_health_check', 'tv_ui_state', 'tv_launch', 'tv_update',
  // chart
  'chart_get_state', 'chart_set', 'chart_goto', 'chart_get_visible_range', 'symbol_info', 'symbol_search',
  // indicators
  'indicator',
  // data
  'data_get_ohlcv', 'data_get_study', 'data_get_pine_drawings', 'quote_get', 'depth_get',
  'data_get_strategy_results', 'data_get_trades', 'data_get_equity',
  // capture
  'capture_screenshot',
  // pine
  'pine_source', 'pine_compile', 'pine_diagnostics', 'pine_script', 'pine_analyze', 'pine_check',
  // tab
  'tab_list', 'tab_new', 'tab_close', 'tab_switch',
  // pane / replay / drawing
  'pane', 'replay', 'draw',
  // alerts / watchlist
  'alert_create', 'alert_manage', 'watchlist_get', 'watchlist_add', 'watchlist_remove',
  // ui
  'ui_input', 'ui_find_element', 'ui_evaluate', 'layout_list', 'layout_switch', 'layout_active',
  // batch
  'batch_run',
  // copilot
  'copilot_fast', 'copilot_analyze',
];

test('catalog: unique names and valid legacy replacement pointers', () => {
  const names = catalog.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names in catalog');
  const byName = new Set(names);
  for (const t of catalog) {
    if (t.legacy) assert.ok(byName.has(t.legacy), `${t.name}: legacy target "${t.legacy}" missing`);
  }
});

test('catalog: v3 active surface matches the documented tool list', () => {
  const active = catalog.filter((t) => !t.legacy).map((t) => t.name).sort();
  assert.deepEqual(active, [...ACTIVE_TOOLS].sort());
});

test('catalog: every schema converts to JSON schema', () => {
  for (const t of catalog) {
    assert.doesNotThrow(() => z.toJSONSchema(z.object(t.schema ?? {})), `${t.name}: invalid zod schema`);
  }
});

test('default env registers all active tools, no legacy aliases', () => {
  const server = mockServer();
  const { registered } = registerTools(server, {});
  const names = server.tools.map((t) => t.name);
  assert.equal(registered, ACTIVE_TOOLS.length);
  assert.ok(names.includes('chart_set'));
  assert.ok(!names.includes('chart_set_symbol'));
  assert.ok(!names.includes('data_get_pine_lines'));
  // deterministic order follows catalog order
  const expected = catalog.filter((t) => !t.legacy).map((t) => t.name);
  assert.deepEqual(names, expected);
});

test('TV_MCP_LEGACY=1 adds pre-v3 aliases', () => {
  const server = mockServer();
  const { registered } = registerTools(server, { TV_MCP_LEGACY: '1' });
  const names = new Set(server.tools.map((t) => t.name));
  assert.equal(registered, catalog.length);
  assert.ok(names.has('chart_set_symbol'));
  assert.ok(names.has('pine_smart_compile'));
  assert.ok(names.has('layout_new'));
});

test('TV_MCP_PROFILE=data exposes only data + health tools', () => {
  const { selected } = resolveSelection({ TV_MCP_PROFILE: 'data' });
  const defs = catalog.filter((t) => selected.has(t.name));
  assert.ok(defs.length > 0);
  for (const d of defs) assert.ok(['data', 'health'].includes(d.group), `${d.name} in group ${d.group}`);
});

test('TV_MCP_PROFILE=quant covers data/chart/indicators/capture/batch/health', () => {
  const { selected } = resolveSelection({ TV_MCP_PROFILE: 'quant' });
  const groups = new Set(catalog.filter((t) => selected.has(t.name)).map((t) => t.group));
  assert.deepEqual([...groups].sort(), ['batch', 'capture', 'chart', 'copilot', 'data', 'health', 'indicators']);
});

test('TV_MCP_PROFILE=minimal is the curated high-frequency set', () => {
  const { selected } = resolveSelection({ TV_MCP_PROFILE: 'minimal' });
  const names = [...selected].sort();
  assert.deepEqual(names, [
    'batch_run', 'capture_screenshot', 'chart_get_state', 'chart_set', 'data_get_ohlcv',
    'data_get_pine_drawings', 'data_get_study', 'quote_get', 'symbol_search', 'tab_list',
    'tv_health_check',
  ]);
});

test('TV_MCP_TOOLS supports exact names and prefix globs, unioned with profile', () => {
  const { selected } = resolveSelection({ TV_MCP_TOOLS: 'data_get_ohlcv,tab_*' });
  assert.ok(selected.has('data_get_ohlcv'));
  assert.ok(selected.has('tab_list'));
  assert.ok(selected.has('tab_switch'));
  assert.ok(!selected.has('chart_get_state'));

  const both = resolveSelection({ TV_MCP_PROFILE: 'minimal', TV_MCP_TOOLS: 'replay' });
  assert.ok(both.selected.has('replay'));
  assert.ok(both.selected.has('chart_get_state'));
});

test('TV_MCP_TOOLS exact name bypasses the legacy gate', () => {
  const { selected } = resolveSelection({ TV_MCP_TOOLS: 'chart_set_symbol' });
  assert.ok(selected.has('chart_set_symbol'));
});

test('TV_MCP_PROFILE=lazy registers meta tools + core set only', () => {
  const server = mockServer();
  const { registered, selection } = registerTools(server, { TV_MCP_PROFILE: 'lazy' });
  const names = server.tools.map((t) => t.name);
  assert.ok(selection.lazy);
  assert.equal(registered, 7); // 2 meta + 5 core
  assert.ok(names.includes('tv_call'));
  assert.ok(names.includes('tv_tools_catalog'));
  assert.ok(names.includes('chart_get_state'));
  assert.ok(!names.includes('pine_source'));
});

test('unknown profile/tool tokens produce warnings', () => {
  const { warnings } = resolveSelection({ TV_MCP_PROFILE: 'bogus', TV_MCP_TOOLS: 'nope' });
  assert.equal(warnings.length, 2);
});

test('merged tool: chart_set requires at least one field', async () => {
  const server = mockServer();
  registerTools(server, {});
  const h = server.tools.find((t) => t.name === 'chart_set').handler;
  const res = await h({});
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('at least one'));
});

test('tv_call rejects unknown tools', async () => {
  const server = mockServer();
  registerTools(server, { TV_MCP_PROFILE: 'lazy' });
  const h = server.tools.find((t) => t.name === 'tv_call').handler;
  const res = await h({ tool: 'does_not_exist' });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('Unknown tool'));
});

test('tv_call dispatches to a catalog tool and surfaces its errors', async () => {
  const server = mockServer();
  registerTools(server, { TV_MCP_PROFILE: 'lazy' });
  const h = server.tools.find((t) => t.name === 'tv_call').handler;
  // chart_set with no args throws inside the inner handler (no CDP access needed)
  const res = await h({ tool: 'chart_set', args: {} });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('at least one'));
});

test('jsonResult emits compact JSON by default', () => {
  const res = jsonResult({ a: 1, b: [1, 2] });
  assert.equal(res.content[0].text, '{"a":1,"b":[1,2]}');
  assert.equal(res.isError, undefined);
});
