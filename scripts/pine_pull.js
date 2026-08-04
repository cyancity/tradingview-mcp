#!/usr/bin/env node
// Pull current Pine Script source from TradingView editor → scripts/current.pine
import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'fs';
import { FIND_ACTIVE_MONACO } from '../src/core/pine.js';

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const src = (await c.Runtime.evaluate({
  expression: `(function(){var m=${FIND_ACTIVE_MONACO};if(!m)return null;return m.editor.getValue()})()`,
  returnByValue: true,
})).result?.value;

if (!src) { console.error('Could not read Pine editor'); await c.close(); process.exit(1); }

const outPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
writeFileSync(outPath, src);
console.log(`Pulled ${src.split('\n').length} lines → scripts/current.pine`);
await c.close();
