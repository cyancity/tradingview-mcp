#!/usr/bin/env node
// Push scripts/current.pine → TradingView editor, then compile
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';
import { FIND_ACTIVE_MONACO } from '../src/core/pine.js';

const srcPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const src = readFileSync(srcPath, 'utf-8');

const targets = await (await fetch('http://localhost:9223/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9223, target: t.id });
await c.Runtime.enable();

// Inject source into the VISIBLE (active) editor — the old finder picked
// editors[0] of the first .monaco-editor.pine-editor-monaco in DOM order,
// which can be a hidden/other script tab's editor.
const escaped = JSON.stringify(src);
const set = (await c.Runtime.evaluate({
  expression: `(function(){var m=${FIND_ACTIVE_MONACO};if(!m)return false;m.editor.setValue(${escaped});return true})()`,
  returnByValue: true,
})).result?.value;

if (!set) { console.error('Could not inject into Pine editor'); await c.close(); process.exit(1); }
console.log(`Pushed ${src.split('\n').length} lines → Pine editor`);

// Click compile button
const clicked = (await c.Runtime.evaluate({
  expression: '(function(){var btns=document.querySelectorAll("button");for(var i=0;i<btns.length;i++){var t=btns[i].textContent.trim();if(/save and add to chart/i.test(t)){btns[i].click();return t}if(/^(Add to chart|Update on chart)/i.test(t)){btns[i].click();return t}}for(var i=0;i<btns.length;i++){if(btns[i].className.indexOf("saveButton")!==-1&&btns[i].offsetParent!==null){btns[i].click();return "Pine Save"}}return null})()',
  returnByValue: true,
})).result?.value;

console.log('Compile:', clicked || 'keyboard fallback');
if (!clicked) {
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
}

// Wait then check errors
await new Promise(r => setTimeout(r, 3000));
const errors = (await c.Runtime.evaluate({
  expression: `(function(){var m=${FIND_ACTIVE_MONACO};if(!m)return[];var model=m.editor.getModel();if(!model)return[];var markers=m.env.editor.getModelMarkers({resource:model.uri});return markers.map(function(x){return{line:x.startLineNumber,msg:x.message}})})()`,
  returnByValue: true,
})).result?.value || [];

if (errors.length === 0) {
  console.log('✅ Compiled clean — 0 errors');
} else {
  console.log(`❌ ${errors.length} errors:`);
  errors.forEach(e => console.log(`  Line ${e.line}: ${e.msg}`));
}

await c.close();
