// Smoke test: boot the real MCP server over stdio, list tools, print counts.
// Usage: node scripts/smoke-test.mjs [TV_MCP_PROFILE=value ...]
import { spawn } from 'node:child_process';

const env = { ...process.env, TV_MCP_PROFILE: process.env.TV_MCP_PROFILE || 'full' };
const child = spawn('node', ['src/server.js'], { env });

let buf = '';
const pending = [];
child.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) pending.push(JSON.parse(line));
  }
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const waitResp = async (id) => {
  for (let i = 0; i < 100; i++) {
    const found = pending.find((m) => m.id === id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no response for id ${id}`);
};

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
await waitResp(1);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const resp = await waitResp(2);
if (resp.error) { console.error('tools/list error:', resp.error); process.exit(1); }
const tools = resp.result.tools;
const chars = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
console.log(`profile=${env.TV_MCP_PROFILE}  tools=${tools.length}  manifest=${Math.round(chars / 1024)}KB  ~${Math.round(chars / 4)} tokens`);
console.log(tools.map((t) => t.name).join('\n'));
child.kill();
process.exit(0);
