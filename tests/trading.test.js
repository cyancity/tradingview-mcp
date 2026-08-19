/**
 * Tests for the EXPERIMENTAL trading core (src/core/trading.js).
 * No live CDP — every CDP call goes through injected _deps mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  trade,
  probe,
  status,
  isPaperMode,
  openPanel,
  setOrderType,
  setQty,
  setPrice,
  submit,
  closePosition,
  SELECTORS,
} from '../src/core/trading.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock CDP evaluate function that returns scripted values.
 * Calls are tracked in .calls array.
 * @param {object} responses — map of substring→return value. First matching key wins.
 * @param {Array} [sequence] — if provided, override responses with sequential returns
 */
function mockEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

// Both evaluate and evaluateAsync share the same mock instance so every CDP
// expression (regardless of entry point) is visible on evaluate.calls.
function mockDeps(responses = {}, sequence) {
  const evaluate = mockEvaluate(responses, sequence);
  const getClient = async () => ({ Input: { dispatchMouseEvent: async () => {} } });
  return { _deps: { evaluate, evaluateAsync: evaluate, getClient }, evaluate };
}

// ── isPaperMode() ────────────────────────────────────────────────────────

describe('isPaperMode() — paper-mode detection', () => {
  it('detects paper trading from the account switcher', async () => {
    const { _deps } = mockDeps({ 'Paper': { paper_mode: true, badge: false } });
    const result = await isPaperMode({ _deps });
    assert.equal(result.paper_mode, true);
  });

  it('returns false when paper mode is not present', async () => {
    const { _deps } = mockDeps({ 'Paper': { paper_mode: false, badge: false } });
    const result = await isPaperMode({ _deps });
    assert.equal(result.paper_mode, false);
  });
});

// ── trade() safety gate ──────────────────────────────────────────────────

describe('trade() — paper-mode safety gate', () => {
  it('refuses a market order when paper mode is not detected and dry_run=false', async () => {
    const { _deps, evaluate } = mockDeps({ 'Paper': { paper_mode: false, badge: false } });
    await assert.rejects(
      () => trade({ action: 'market', side: 'buy', qty: 1, _deps }),
      (err) => {
        assert.ok(err.message.includes('paper'), 'message mentions paper mode');
        assert.ok(err.message.includes('dry_run'), 'message suggests dry_run=true');
        return true;
      },
    );
    // The gate throws before any submit selector is ever touched.
    const submitCall = evaluate.calls.find(c => c.includes('buy-button') || c.includes('submit-buy') || c.includes('sell-button') || c.includes('submit-sell'));
    assert.equal(submitCall, undefined, 'no submit selector was ever reached');
  });

  it('dry_run=true returns submitted:false and never dispatches the submit click', async () => {
    const { _deps, evaluate } = mockDeps({}, [
      { found: true },  // setQtyOneClick: open qty editor
      { found: true },  // setQtyOneClick: set qty input
    ]);
    const result = await trade({ action: 'market', side: 'buy', qty: 10, dry_run: true, _deps });
    assert.equal(result.success, true);
    assert.equal(result.submitted, false);
    assert.equal(result.dry_run, true);
    assert.equal(result.paper_mode, false);
    const submitCall = evaluate.calls.find(c => c.includes('buyButton-'));
    assert.equal(submitCall, undefined, 'dry_run must never dispatch the one-click buy click');
  });
});

// ── trade() validation ───────────────────────────────────────────────────

describe('trade() — validation', () => {
  for (const bad of [0, -1, NaN]) {
    it(`setQty throws on invalid qty ${bad}`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => setQty({ qty: bad, _deps }),
        (err) => err.message.includes('positive finite'),
      );
      assert.equal(evaluate.calls.length, 0, 'no CDP calls for invalid qty');
    });
  }

  for (const action of ['limit', 'stop']) {
    it(`requires price for ${action} orders`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => trade({ action, side: 'buy', qty: 1, _deps }),
        (err) => err.message.includes('price is required'),
      );
      assert.equal(evaluate.calls.length, 0, 'validation fails before any CDP call');
    });
  }

  it('requires qty for market orders', async () => {
    const { _deps, evaluate } = mockDeps({});
    await assert.rejects(
      () => trade({ action: 'market', side: 'buy', _deps }),
      (err) => err.message.includes('qty is required'),
    );
    assert.equal(evaluate.calls.length, 0, 'validation fails before any CDP call');
  });

  for (const action of ['limit', 'stop']) {
    it(`requires positive price for ${action} orders`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => trade({ action, side: 'buy', qty: 1, price: 0, _deps }),
        (err) => err.message.includes('positive finite'),
      );
      assert.equal(evaluate.calls.length, 0, 'validation fails before any CDP call');
    });
  }

  it('requires side for market orders', async () => {
    const { _deps, evaluate } = mockDeps({});
    await assert.rejects(
      () => trade({ action: 'market', qty: 1, _deps }),
      (err) => err.message.includes('side is required'),
    );
    assert.equal(evaluate.calls.length, 0, 'validation fails before any CDP call');
  });

  it('requires side to close a position', async () => {
    const { _deps, evaluate } = mockDeps({});
    await assert.rejects(
      () => trade({ action: 'close', _deps }),
      (err) => err.message.includes('side is required to close'),
    );
    assert.equal(evaluate.calls.length, 0, 'validation fails before any CDP call');
  });
});

// ── trade() happy path ───────────────────────────────────────────────────

describe('trade() — happy path', () => {
  it('dispatches native setter + input/change events and submits', async () => {
    const { _deps, evaluate } = mockDeps({}, [
      { paper_mode: true, badge: false },     // isPaperMode
      { found: true },                         // setQtyOneClick: open qty editor
      { found: true },                         // setQtyOneClick: set qty input
      { found: true, text: 'Buy 5 NQ1! @ 29530' }, // submitOneClick: click buy
    ]);
    const result = await trade({ action: 'market', side: 'buy', qty: 5, _deps });
    assert.equal(result.success, true);
    assert.equal(result.submitted, true);
    assert.equal(result.paper_mode, true);
    assert.equal(result.qty, 5);
    assert.equal(result.price, null);
    assert.equal(result.order_type, 'market');

    const setterCall = evaluate.calls.find(c => c.includes('Object.getOwnPropertyDescriptor'));
    assert.ok(setterCall, 'native value setter expression was used for qty');
    assert.ok(setterCall.includes('input'), 'input event dispatched on qty input');
    assert.ok(setterCall.includes('change'), 'change event dispatched on qty input');
    assert.ok(setterCall.includes('5'), 'qty value embedded');

    const submitCall = evaluate.calls.find(c => c.includes('buyButton-'));
    assert.ok(submitCall, 'one-click buy button was clicked');
  });

  it('close with dry_run=true returns submitted:false and never clicks close', async () => {
    // dry_run skips the paper gate AND the close click — no CDP calls at all.
    const { _deps, evaluate } = mockDeps({});
    const result = await trade({ action: 'close', side: 'buy', dry_run: true, _deps });
    assert.equal(result.success, true);
    assert.equal(result.submitted, false);
    assert.equal(result.dry_run, true);
    const closeCall = evaluate.calls.find(c => c.includes('close-position'));
    assert.equal(closeCall, undefined, 'dry_run close must not click close-position');
  });

  it('dry_run exercises qty/price entry but never submits', async () => {
    const { _deps, evaluate } = mockDeps({}, [
      { open: true },  // openOrderTicket
      { found: true }, // setSide
      { found: true }, // setOrderType limit tab
      { found: true }, // setQty
      { found: true }, // setPrice
    ]);
    const result = await trade({ action: 'limit', side: 'buy', qty: 3, price: 100, dry_run: true, _deps });
    assert.equal(result.success, true);
    assert.equal(result.submitted, false);
    const setterCalls = evaluate.calls.filter(c => c.includes('Object.getOwnPropertyDescriptor'));
    assert.equal(setterCalls.length, 2, 'both qty and price setters ran');
    const submitCall = evaluate.calls.find(c => c.includes('button-e3ECpiMr'));
    assert.equal(submitCall, undefined, 'no submit click in dry_run');
  });

  it('close flow dispatches the close-position click', async () => {
    const { _deps, evaluate } = mockDeps({
      'open-account-manager': { paper_mode: true, badge: false },
      'close-position': { found: true, row: 'AAPL BUY 10 @ 200.00' },
      'Confirm': { found: true },
    });
    const result = await trade({ action: 'close', side: 'buy', _deps });
    assert.equal(result.success, true);
    assert.equal(result.submitted, true);
    assert.equal(result.order_type, 'close');
    const closeCall = evaluate.calls.find(c => c.includes('close-position'));
    assert.ok(closeCall, 'close-position clicked');
  });
});

// ── direct core functions ────────────────────────────────────────────────

describe('direct core functions', () => {
  it('openPanel opens the trading panel', async () => {
    const { _deps, evaluate } = mockDeps({ 'id_account-manager-tabs': { open: true, kind: 'account-manager' } });
    const result = await openPanel({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.panel_open, true);
    const tabsCall = evaluate.calls.find(c => c.includes('id_account-manager-tabs'));
    assert.ok(tabsCall, 'account manager was probed');
  });

  it('setOrderType clicks the order-type tab', async () => {
    const { _deps, evaluate } = mockDeps({ 'Limit': { found: true } });
    const result = await setOrderType({ action: 'limit', _deps });
    assert.equal(result.success, true);
    const tabCall = evaluate.calls.find(c => c.includes('orderTicket') && c.includes('Limit'));
    assert.ok(tabCall, 'limit order-type tab was clicked');
  });

  it('openPanel throws when the account manager is not found', async () => {
    // Both openPanel evals return {open:false} so verify fails and it throws.
    const { _deps } = mockDeps({ 'id_account-manager-tabs': { open: false, kind: null } });
    await assert.rejects(
      () => openPanel({ _deps }),
      (err) => err.message.includes('Account manager') || err.message.includes('Trading panel'),
    );
  });

  it('setOrderType(action=close) short-circuits without CDP calls', async () => {
    const { _deps, evaluate } = mockDeps({});
    const result = await setOrderType({ action: 'close', _deps });
    assert.equal(result.success, true);
    assert.equal(evaluate.calls.length, 0, 'close must not touch the order-type dropdown');
  });

  it('setPrice requires a finite number', async () => {
    const { _deps, evaluate } = mockDeps({});
    await assert.rejects(
      () => setPrice({ price: Infinity, _deps }),
      (err) => err.message.includes('finite'),
    );
    assert.equal(evaluate.calls.length, 0, 'no CDP calls for invalid price');
  });

  it('submit clicks the ticket submit button', async () => {
    const { _deps, evaluate } = mockDeps({
      'button-e3ECpiMr': { found: true, text: 'Sell 1 NQ1! @ 29500 MARKET' },
      'Confirm': { found: true },
    });
    const result = await submit({ side: 'sell', _deps });
    assert.equal(result.submitted, true);
    const sellCall = evaluate.calls.find(c => c.includes('button-e3ECpiMr'));
    assert.ok(sellCall, 'ticket submit button was clicked');
  });

  it('closePosition dispatches the close click', async () => {
    const { _deps, evaluate } = mockDeps({
      'close-position': { found: true, row: 'AAPL BUY 10' },
      'Confirm': { found: true },
    });
    const result = await closePosition({ side: 'buy', _deps });
    assert.equal(result.submitted, true);
    const closeCall = evaluate.calls.find(c => c.includes('close-position'));
    assert.ok(closeCall, 'close-position clicked');
  });

  it('closePosition throws when no matching position exists', async () => {
    const { _deps, evaluate } = mockDeps({ 'close-position': { found: false } });
    await assert.rejects(
      () => closePosition({ side: 'sell', _deps }),
      (err) => err.message.includes('Close short'),
    );
    assert.equal(evaluate.calls.length, 1, 'only the position lookup ran');
  });
});

// ── status() / probe() ───────────────────────────────────────────────────

describe('status() — account state', () => {
  it('parses position rows and open orders', async () => {
    const { _deps } = mockDeps({
      'open-account-manager': { paper_mode: true, badge: false },
      'positions': { container: true, positions: [{ symbol: 'AAPL', side: 'buy', qty: 10, price: 200, pnl: 12.5 }] },
      'open-orders': { container: true, orders: [] },
    });
    const result = await status({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.paper_mode, true);
    assert.deepEqual(result.positions, [{ symbol: 'AAPL', side: 'buy', qty: 10, price: 200, pnl: 12.5 }]);
    assert.deepEqual(result.orders, []);
  });

  it('throws when neither container is discoverable', async () => {
    const { _deps } = mockDeps({
      'Paper': { paper_mode: false, badge: false },
      'positions': { container: false, positions: [] },
      'open-orders': { container: false, orders: [] },
    });
    await assert.rejects(
      () => status({ _deps }),
      (err) => err.message.includes('Neither the positions nor the open-orders'),
    );
  });
});

describe('probe() — selector calibration dump', () => {
  it('returns elements, api namespaces, and paper mode', async () => {
    const sequence = [
      { paper_mode: false, badge: false }, // isPaperMode
      { already_open: true },              // openPanel eval 1
      { open: true, kind: 'account-manager' }, // openPanel verify
      { container: true, scope_kind: 'account-manager-tabs', elements: [{ tag: 'button', data_name: 'close-settings-cell-button', aria: 'Close', cls: '', text: '', x: 0, y: 0, w: 0, h: 0, visible: true }] }, // container query
      [{ name: 'trade', type: 'function', method: true }], // TradingViewApi probe
    ];
    const { _deps } = mockDeps({}, sequence);
    const result = await probe({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.panel_open, true);
    assert.equal(result.paper_mode, false);
    assert.ok(Array.isArray(result.elements), 'elements is an array');
    assert.equal(result.elements[0].data_name, 'close-settings-cell-button');
    assert.ok(Array.isArray(result.api_namespaces), 'api_namespaces is an array');
    assert.equal(result.api_namespaces[0].name, 'trade');
  });
});

// ── injection safety ─────────────────────────────────────────────────────

describe('injection safety', () => {
  it('embeds a hostile symbol payload JSON-escaped (never raw concat)', async () => {
    const { _deps, evaluate } = mockDeps({
      'id_account-manager-tabs': { open: true, kind: 'account-manager' },
    });
    const hostile = `x'); alert(1)//`;
    await openPanel({ symbol: hostile, _deps });
    const escaped = JSON.stringify(hostile);
    const call = evaluate.calls.find(c => c.includes(escaped));
    assert.ok(call, `payload must appear JSON-escaped (${JSON.stringify(escaped)}). Expressions: ${evaluate.calls.join(' | ').slice(0, 400)}`);
    // The unquoted raw payload must not appear in a statement position
    // (raw concat would produce `input, x'); alert(1)//`).
    assert.ok(!call.includes("input, x');"), 'no raw unquoted payload in the setter call');
  });
});

// ── sanity: source exists & stays gated ──────────────────────────────────

describe('source sanity', () => {
  it('src/core/trading.js exists with the safety gate', () => {
    const source = readFileSync(new URL('../src/core/trading.js', import.meta.url), 'utf8');
    assert.ok(source.includes('paper trading mode not detected'), 'paper-mode refusal message present');
    assert.ok(source.includes('SELECTORS'), 'SELECTORS config exported');
  });

  it('never calls a Promise instance via trailing () (new Promise(...)())', () => {
    const source = readFileSync(new URL('../src/core/trading.js', import.meta.url), 'utf8');
    // A `new Promise(function(resolve) { ... })()` expression resolves the
    // promise and then tries to CALL it — TypeError "intermediate value is not
    // a function" AFTER the side-effect already ran. Regression guard for that
    // class of bug (was present in focusSymbol/setOrderType/closePosition).
    const OPENER = 'new Promise(function(resolve) {';
    let idx = 0;
    while ((idx = source.indexOf(OPENER, idx)) !== -1) {
      let depth = 0;
      let bad = false;
      for (let i = idx + OPENER.length; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          if (depth === 0) {
            // This } closes the Promise body; expect `)` + backtick, never `)(`.
            bad = source[i + 1] === ')' && source[i + 2] === '(';
            break;
          }
          depth--;
        }
      }
      assert.equal(bad, false, `new Promise(...)() call after "${OPENER}" — resolves then calls the Promise (TypeError)`);
      idx += OPENER.length;
    }
  });

  it('SELECTORS covers every panel interaction', () => {
    assert.ok(SELECTORS.container.panel.data_name.length > 0);
    assert.ok(SELECTORS.container.account_switcher.text.includes('Paper trading'));
    assert.ok(SELECTORS.order_type.options.market.text.includes('Market'));
    assert.ok(SELECTORS.inputs.qty.data_name.includes('quantity'));
    assert.ok(SELECTORS.submit.buy.data_name.includes('buy-button'));
    assert.ok(SELECTORS.close.data_name.includes('close-position'));
  });
});
