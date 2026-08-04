/**
 * Offline unit tests for the Pine editor "active tab" fix.
 * No TradingView connection needed — validates the pure logic and the
 * syntax of the JS snippets that get injected into the page via CDP.
 *
 * Run: node --test tests/pine_tab_logic.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  extractScriptTitle,
  tabMatches,
  tabMatchExpr,
  FIND_ACTIVE_MONACO,
  EDITOR_TABS,
  clickScriptTabExpr,
  openViaDropdownExpr,
} from '../src/core/pine.js';

describe('pine editor logic — offline', () => {
  it('injected snippets are syntactically valid JavaScript', () => {
    const snippets = [
      ['FIND_ACTIVE_MONACO', FIND_ACTIVE_MONACO],
      ['EDITOR_TABS', EDITOR_TABS],
      ['clickScriptTabExpr', clickScriptTabExpr('My Script')],
      ['openViaDropdownExpr', openViaDropdownExpr('My Script')],
    ];
    for (const [name, code] of snippets) {
      assert.doesNotThrow(() => new vm.Script(code), `${name} snippet must parse as JS`);
    }
  });

  it('FIND_ACTIVE_MONACO returns null gracefully when no pine editor exists', () => {
    // Mock a browser document with no .monaco-editor.pine-editor-monaco
    // containers: the injected snippet must return null without throwing.
    const ctx = {
      document: {
        querySelectorAll: () => ({ length: 0 }),
        querySelector: () => null,
      },
    };
    const result = vm.runInNewContext(FIND_ACTIVE_MONACO, ctx);
    assert.equal(result, null);
  });

  it('EDITOR_TABS reports an unscoped result without throwing', () => {
    const ctx = {
      document: {
        querySelector: () => null,
      },
    };
    const result = vm.runInNewContext(EDITOR_TABS, ctx);
    // Cross-realm objects never deepStrictEqual, so compare JSON.
    assert.equal(JSON.stringify(result), JSON.stringify({ scope_found: false, tabs: [], active: null }));
  });

  it('tabMatches: exact match wins, substring fallback, case-insensitive', () => {
    assert.ok(tabMatches('YOLO Cloud', 'YOLO Cloud'));
    assert.ok(tabMatches('YOLO Cloud', 'yolo cloud'));
    assert.ok(tabMatches('YOLO Cloud 2', 'yolo cloud'), 'substring match');
    assert.ok(tabMatches('  YOLO Cloud  ', 'yolo cloud'), 'whitespace trimmed');
    assert.ok(!tabMatches('Alerts', 'YOLO Cloud'), 'no false positive');
    assert.ok(!tabMatches('Anything', ''), 'empty name never matches');
  });

  it('tabMatchExpr generates a matcher equivalent to tabMatches', () => {
    const fn = vm.runInNewContext(`(${tabMatchExpr('YOLO Cloud')})`);
    const cases = ['YOLO Cloud', 'yolo cloud', 'YOLO Cloud 2', 'Alerts', '', 'Pine'];
    for (const text of cases) {
      assert.equal(fn(text), tabMatches(text, 'YOLO Cloud'), `matcher agrees on "${text}"`);
    }
  });

  it('extractScriptTitle parses indicator/strategy/library titles', () => {
    assert.equal(extractScriptTitle('//@version=6\nindicator("My script")\nplot(close)'), 'My script');
    assert.equal(extractScriptTitle('//@version=6\nstrategy("Strat 1", overlay=true)\n'), 'Strat 1');
    assert.equal(extractScriptTitle('//@version=6\nlibrary("Lib")\n'), 'Lib');
    assert.equal(extractScriptTitle('//@version=6\nindicator(\'Single\', overlay=true)\n'), 'Single');
    assert.equal(extractScriptTitle('//@version=6\nplot(close)'), null);
    assert.equal(extractScriptTitle(null), null);
    assert.equal(extractScriptTitle(''), null);
  });

  it('clickScriptTabExpr matches the requested name and not others', () => {
    const code = clickScriptTabExpr('YOLO Cloud');
    assert.ok(code.includes('role="tab"'), 'prefers role=tab elements');
    // The matcher embedded in the click snippet behaves like tabMatches.
    const m = code.match(/var match = (.+?);\n/);
    assert.ok(m, 'matcher is embedded in the snippet');
    const fn = vm.runInNewContext(`(${m[1]})`);
    assert.equal(fn('YOLO Cloud'), true);
    assert.equal(fn('yolo cloud (2)'), true);
    assert.equal(fn('Other Script'), false);
  });

  it('openViaDropdownExpr embeds the requested name safely (no injection)', () => {
    const code = openViaDropdownExpr('Lib" ; alert("xss")');
    assert.ok(code.includes('"Lib\\" ; alert(\\"xss\\")"'), 'name is JSON-escaped into the snippet');
    assert.doesNotThrow(() => new vm.Script(code));
  });
});
