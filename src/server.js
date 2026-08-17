import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools/registry.js';

const server = new McpServer(
  {
    name: 'tradingview',
    version: '3.0.0',
    description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
  },
  {
    instructions: `TradingView MCP — control a live TradingView Desktop chart via CDP.

QUICK START: call chart_get_state first (symbol, timeframe, indicator entity IDs), then data tools.
- Prices/bars: data_get_ohlcv (pass summary=true unless you need raw bars), quote_get
- Indicator values: data_get_study (no args = all visible studies; entity_id + series=true = raw plot rows)
- Custom Pine drawings: data_get_pine_drawings (kind=line/label/table/box; always pass study_filter)
- Change chart: chart_set (symbol/timeframe/chart_type), chart_goto (date or from/to range)
- Indicators: indicator (action=add/remove/search/set_inputs/toggle)
- Pine dev: pine_source (get/set/save), pine_compile (smart=true), pine_diagnostics (errors/console)
- Screenshot: capture_screenshot (regions: full/chart/strategy_tester)

CONTEXT RULES: prefer summary=true, study_filter, and screenshots over large raw datasets.
v3 consolidated tools — set TV_MCP_LEGACY=1 for pre-v3 tool names, TV_MCP_PROFILE to slim the toolset.`,
  }
);

// Register tools per TV_MCP_PROFILE / TV_MCP_TOOLS / TV_MCP_LEGACY (see src/tools/registry.js)
const { registered, selection } = registerTools(server, process.env);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n');
process.stderr.write(`   ${registered} tools registered (profile: ${process.env.TV_MCP_PROFILE || 'full'}${selection.legacy ? ', legacy on' : ''}${selection.lazy ? ', lazy' : ''})\n\n`);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
