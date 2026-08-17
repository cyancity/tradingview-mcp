#!/usr/bin/env node
/**
 * Report tool-manifest size per TV_MCP_PROFILE preset.
 * Estimates the tools/list JSON payload the MCP SDK emits (name + description
 * + zod->JSON-schema input schema) at ~4 chars/token.
 *
 * Usage:
 *   node scripts/manifest-report.js            # table of all presets + current env config
 *   node scripts/manifest-report.js --markdown # tool catalog as a markdown table
 */
import { z } from 'zod';
import { getCatalog, PROFILES, resolveSelection } from '../src/tools/registry.js';

const catalog = getCatalog();

function toolManifestJson(def) {
  let inputSchema;
  try {
    inputSchema = z.toJSONSchema(z.object(def.schema ?? {}));
  } catch {
    inputSchema = { type: 'object' };
  }
  return JSON.stringify({ name: def.name, description: def.description, inputSchema });
}

function estimateTokens(defs) {
  const chars = defs.reduce((n, d) => n + toolManifestJson(d).length + 6, 0);
  return Math.round(chars / 4);
}

function profileDefs(profileEnv, toolsEnv, legacyEnv) {
  const sel = resolveSelection({
    TV_MCP_PROFILE: profileEnv,
    TV_MCP_TOOLS: toolsEnv,
    TV_MCP_LEGACY: legacyEnv,
  });
  const defs = catalog.filter(
    (d) => sel.selected.has(d.name) && (!d.legacy || sel.legacy || sel.explicit.has(d.name)),
  );
  return { defs, sel };
}

const rows = [];
const current = profileDefs(
  process.env.TV_MCP_PROFILE,
  process.env.TV_MCP_TOOLS,
  process.env.TV_MCP_LEGACY,
);
rows.push([
  `current env (${process.env.TV_MCP_PROFILE || 'full'}${process.env.TV_MCP_TOOLS ? ` + TV_MCP_TOOLS` : ''}${current.sel.legacy ? ', legacy' : ''})`,
  current.defs,
]);

const presets = Object.keys(PROFILES).filter((p) => p !== 'full');
const full = catalog.filter((d) => !d.legacy);
const fullLegacy = catalog.filter((d) => d.legacy);
rows.push(['full (default)', full]);
for (const p of presets) rows.push([p, profileDefs(p === 'lazy' ? 'lazy' : p).defs]);
rows.push(['full + TV_MCP_LEGACY=1', [...full, ...fullLegacy]]);

console.log('\nTool manifest size per profile (estimate: manifest chars / 4):\n');
console.log('  profile                          tools   ~tokens');
console.log('  -------------------------------  -----  -------');
for (const [label, defs] of rows) {
  console.log(`  ${label.padEnd(31)}  ${String(defs.length).padStart(5)}  ${String(estimateTokens(defs)).padStart(7)}`);
}
if (current.sel.lazy) console.log('\n  (lazy profile also registers tv_call + tv_tools_catalog)');

if (process.argv.includes('--markdown')) {
  console.log('\n## Tool catalog\n');
  console.log('| tool | group | status |');
  console.log('|---|---|---|');
  for (const d of catalog) {
    console.log(`| \`${d.name}\` | ${d.group} | ${d.legacy ? `legacy → \`${d.legacy}\`` : 'active'} |`);
  }
}
