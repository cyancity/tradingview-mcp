/**
 * Core TradingView paper-trading panel automation (EXPERIMENTAL).
 *
 * NOTE: This domain automates the LIVE paper-trading order ticket via CDP DOM
 * manipulation (window.TradingViewApi exposes no verified broker/orders
 * namespace; _replayApi trades the Replay simulation, NOT the live paper
 * account, and is deliberately excluded). No verified public code path exists
 * for live paper-order placement — every selector below is best-known but
 * UNVERIFIED and MUST be calibrated at runtime via trade_probe. This may break
 * with any TradingView UI update and never touches real brokerage accounts.
 *
 * Safety: every real submission is gated behind an isPaperMode() detection
 * step. When paper mode cannot be detected the tool refuses to submit unless
 * dry_run=true, and dry_run NEVER dispatches the submit/confirm click.
 *
 * React controlled inputs are set via the native HTMLInputElement value setter
 * followed by dispatched input/change events (React's synthetic event system
 * ignores direct value assignment). Every user-provided value interpolated into
 * a CDP evaluate() expression is passed through JSON.stringify.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient } from '../connection.js';

export const ORDER_TYPES = ['market', 'limit', 'stop', 'close'];

// Best-known selectors, verified against TradingView Desktop (2026-08). The
// order ticket is opened from the chart context menu ("Create limit order…")
// and exposes Market/Limit/Stop tabs, a side (Buy/Sell) control, price + qty
// inputs and a submit button — all in the MAIN window DOM.
export const SELECTORS = {
  container: {
    // In modern TradingView Desktop the trading panel is an overlay opened by
    // the bottom-left "Paper Trading" account button (aria "Open account manager").
    panel: { data_name: ['trading-panel', 'order-panel', 'order-ticket'], aria_label: ['Order panel', 'Trading panel', 'Open account manager'] },
    // The active-account button shows the current account label, e.g. "Paper Trading".
    account_switcher: { data_name: ['account-switcher', 'accounts-button', 'open-account-manager'], aria_label: ['Paper trading', 'Paper trading account', 'Open account manager'], text: ['Paper trading', 'Paper'] },
    positions: { data_name: ['Paper.positions-table', 'positions', 'positions-widget', 'account-manager-positions'], aria_label: ['Positions'] },
    open_orders: { data_name: ['Paper.orders-table', 'open-orders', 'orders-list'] },
  },
  ticket: {
    container: '[class*="orderTicket"]',
    // Right-click the chart → this context-menu item opens the order ticket.
    context_menu_item: 'Create limit order…',
    // Buy/Sell control inside the ticket.
    side: { sell: 'Sell', buy: 'Buy' },
    // Order-type tabs inside the ticket.
    type_tabs: { market: 'Market', limit: 'Limit', stop: 'Stop' },
    // Price input has "price" in its class; qty is the first size-small input
    // that is NOT the price input (the one under the "Units" label).
    price_input: 'input[class*="price"]',
    qty_input: 'input.input-H0xdCnFS.size-small-H0xdCnFS:not([class*="price"])',
    // The submit button carries the order summary text ("Buy 0 NQ1! @ … LIMIT").
    submit: 'button[class*="button-e3ECpiMr"]',
    confirm: { text: ['Confirm', 'OK'], data_name: ['confirm-order'] },
  },
  // The one-click SELL/BUY ticket (top-left of the chart, main window DOM).
  // qty is a button that opens an inline qty editor; sell/buy place MARKET
  // orders immediately at the current price with the set qty.
  one_click: {
    sell: 'div[class*="sellButton-"]',
    buy: 'div[class*="buyButton-"]',
    qty: 'div[class*="qty-"]',
    qty_input: 'input[class*="input-H0xdCnFS"]',
  },
  order_type: {
    dropdown: { data_name: ['order-type', 'order-type-selector', 'order-type-dropdown'], aria_label: ['Order type'] },
    options: {
      market: { text: ['Market'] },
      limit: { text: ['Limit'] },
      stop: { text: ['Stop'] },
    },
  },
  inputs: {
    qty: { data_name: ['quantity', 'qty', 'volume'], aria_label: ['Quantity'] },
    price: { data_name: ['price', 'limit-price', 'stop-price'], aria_label: ['Price'] },
  },
  submit: {
    buy: { text: ['Buy'], data_name: ['buy-button', 'submit-buy'] },
    sell: { text: ['Sell'], data_name: ['sell-button', 'submit-sell'] },
    confirm: { text: ['Confirm', 'OK'], data_name: ['confirm-order'] },
  },
  // The position row's close button. Scoped to a position row by the caller
  // (closePosition searches the positions container first).
  close: { data_name: ['close-settings-cell-button', 'close-position', 'close-position-button'], aria_label: ['Close'], text: ['Close', 'Close long', 'Close short'] },
};

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

// Generic DOM element finder injected into evaluate() expressions. Tries text
// match, then aria-label, then data-name, then class-contains.
const FINDER_JS = `
function findByAttr(name, value) {
  var all = document.querySelectorAll('[' + name + ']');
  for (var i = 0; i < all.length; i++) { if (all[i].getAttribute(name) === value) return all[i]; }
  return null;
}
function findEl(s) {
  var text = s.text || [];
  var dataNames = s.data_name || [];
  var ariaLabels = s.aria_label || [];
  var classes = s.class || [];
  var el = null;
  for (var i = 0; i < text.length && !el; i++) {
    var cands = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
    for (var j = 0; j < cands.length; j++) {
      var t = (cands[j].textContent || '').trim();
      if (t === text[i] || t.toLowerCase() === text[i].toLowerCase()) { el = cands[j]; break; }
    }
  }
  if (!el) { for (var a = 0; a < ariaLabels.length && !el; a++) el = findByAttr('aria-label', ariaLabels[a]); }
  if (!el) { for (var d = 0; d < dataNames.length && !el; d++) el = findByAttr('data-name', dataNames[d]); }
  if (!el) {
    for (var c = 0; c < classes.length && !el; c++) {
      var all = document.querySelectorAll('[class]');
      for (var i = 0; i < all.length; i++) { var cl = all[i].getAttribute('class') || ''; if (cl.indexOf(classes[c]) !== -1) { el = all[i]; break; } }
    }
  }
  return el;
}
`;

function clickExpr(spec) {
  return `(function() { ${FINDER_JS}
    var spec = ${JSON.stringify(spec)};
    var el = findEl(spec);
    if (!el) return { found: false };
    el.click();
    return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), data_name: el.getAttribute('data-name') || null, aria_label: el.getAttribute('aria-label') || null };
  })()`;
}

function containerRowsExpr(spec, key) {
  return `(function() { ${FINDER_JS}
    var spec = ${JSON.stringify(spec)};
    var container = findEl(spec);
    if (!container) return { container: false, ${key}: [] };
    var rows = container.querySelectorAll('tbody tr, [data-name*="row"]:not(thead *)');
    var out = [];
    for (var i = 0; i < rows.length && i < 100; i++) {
      var r2 = rows[i];
      if (r2.closest && r2.closest('thead')) continue;
      var parsed = parseRow(r2);
      // Drop placeholder/empty rows (e.g. "no positions" rows with blank cells).
      if (parsed.symbol || parsed.side || parsed.qty || parsed.price || parsed.pnl) out.push(parsed);
    }
    return { container: true, ${key}: out };
    function parseRow(row) {
      // Use only direct <td> and [data-name] elements. The previous selector also
      // matched [class*="cell"], which hit nested wrapper divs inside every <td>
      // and produced duplicate/empty cells that corrupted the numeric parsing.
      var cells = row.querySelectorAll('td, [data-name]');
      var obj = { symbol: null, side: null, qty: null, price: null, pnl: null };
      var sides = ['buy', 'sell', 'long', 'short'];
      for (var j = 0; j < cells.length && j < 12; j++) {
        var cell = cells[j];
        var dn = (cell.getAttribute('data-name') || '').toLowerCase();
        var t = (cell.textContent || '').trim();
        if (!t) continue;
        var assigned = false;
        if (/symbol|ticker/.test(dn)) { obj.symbol = t; assigned = true; }
        else if (/side/.test(dn)) { obj.side = t; assigned = true; }
        else if (/qty|volume|amount/.test(dn)) { obj.qty = t; assigned = true; }
        else if (/price/.test(dn)) { obj.price = t; assigned = true; }
        else if (/pnl|profit/.test(dn)) { obj.pnl = t; assigned = true; }
        if (assigned) continue;
        if (!obj.symbol && /^[A-Z][A-Z0-9_:!.\-]{0,19}$/.test(t) && !/^[-+0-9.]/.test(t)) obj.symbol = t;
        else if (!obj.side && sides.indexOf(t.toLowerCase()) !== -1) obj.side = t;
        else if (!obj.qty && /^\d{1,7}([.,]\d+)?$/.test(t)) obj.qty = t;
        else if (!obj.price && /^[-+]?[\d,]+(\.\d+)?$/.test(t)) obj.price = t;
        else if (!obj.pnl && /^[-+]?[\d,]+(\.\d+)?%?$/.test(t)) obj.pnl = t;
      }
      return obj;
    }
  })()`;
}

/**
 * Best-effort paper-mode detection. Runs fresh on EVERY call (never cached):
 * caching across submissions lets a stale "paper mode" verdict pass a REAL
 * order after the user switches to a live account mid-session.
 *
 * Signal priority (most reliable first):
 *   1. The account manager tables are named `{AccountName}.{table}` — e.g.
 *      "Paper.positions-table", "Paper.orders-table". A "Paper." prefix is
 *      present whenever the active account is the paper account, regardless
 *      of whether the panel-trigger button still exists. STRONGEST signal.
 *   2. The account switcher / trigger button ("Open account manager",
 *      text "Paper Trading") — only present when the panel is closed.
 *   3. Fallback: a paper badge scoped to the trading panel container.
 * Returns { paper_mode: boolean }.
 */
export async function isPaperMode({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`(function() {
    // 1. Strongest: account-manager tables named "Paper.*"
    var named = document.querySelectorAll('[data-name]');
    for (var n = 0; n < named.length; n++) {
      var dn = named[n].getAttribute('data-name') || '';
      if (/^paper\\./i.test(dn) || /^paper$/i.test(dn)) return { paper_mode: true, source: dn };
    }
    // 2. Account switcher / trigger button (only when panel closed)
    var spec = ${JSON.stringify(SELECTORS.container.account_switcher)};
    var dataNames = spec.data_name || [];
    var ariaLabels = spec.aria_label || [];
    var found = null;
    for (var i = 0; i < dataNames.length && !found; i++) {
      var el = document.querySelector('[data-name="' + dataNames[i] + '"]');
      if (el) {
        var own = (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
        if (/paper/i.test(own)) found = el;
      }
    }
    for (var j = 0; j < ariaLabels.length && !found; j++) {
      var el2 = document.querySelector('[aria-label="' + ariaLabels[j] + '"]');
      if (el2) { var own2 = (el2.textContent || '') + ' ' + (el2.getAttribute('title') || '') + ' ' + (el2.getAttribute('aria-label') || ''); if (/paper/i.test(own2)) found = el2; }
    }
    if (found) return { paper_mode: true, source: (found.getAttribute('data-name') || found.getAttribute('aria-label') || (found.textContent||'').trim().substring(0,40)) };
    // 3. Fallback: paper badge in the trading panel container
    var panelSpec = ${JSON.stringify(SELECTORS.container.panel)};
    var container = null;
    for (var c = 0; c < panelSpec.data_name.length && !container; c++) {
      container = document.querySelector('[data-name="' + panelSpec.data_name[c] + '"]');
    }
    for (var c2 = 0; c2 < panelSpec.aria_label.length && !container; c2++) {
      container = document.querySelector('[aria-label="' + panelSpec.aria_label[c2] + '"]');
    }
    var scope = container || document;
    var all = scope.querySelectorAll('[data-name], [aria-label], button');
    for (var m = 0; m < all.length && !found; m++) {
      var attr = all[m].getAttribute('data-name') || all[m].getAttribute('aria-label') || '';
      var t = (all[m].textContent || '').trim();
      if (/paper/i.test(attr) || /^paper($|\\s)/i.test(t)) found = all[m];
    }
    return { paper_mode: !!found, source: found ? (found.getAttribute('data-name') || found.getAttribute('aria-label') || (found.textContent||'').trim().substring(0,40)) : null };
  })()`);
  return { paper_mode: !!(result && result.paper_mode) };
}

/**
 * Open the Paper Trading account manager (the bottom panel that holds the
 * positions list and account stats). In modern TradingView Desktop the order
 * ticket itself is a one-click canvas, so the "trading panel" the tool
 * interacts with is the account manager. Returns { success, panel_open } or
 * throws when the account manager cannot be opened.
 */
export async function openPanel({ symbol, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  if (symbol) await focusSymbol(symbol, evaluateAsync);
  const opened = await evaluate(`(function(){
    var tabs = document.querySelector('#id_account-manager-tabs');
    if (tabs && tabs.offsetParent !== null) return { already_open: true };
    var btn = document.querySelector('button[aria-label="Open account manager"]');
    if (btn) { btn.click(); return { clicked: true }; }
    return { opened: false };
  })()`);
  // Give the panel a moment to animate in.
  await new Promise((r) => setTimeout(r, 250));
  const verify = await evaluate(`(function(){
    var tabs = document.querySelector('#id_account-manager-tabs');
    if (tabs && tabs.offsetParent !== null) return { open: true, kind: 'account-manager' };
    var tp = document.querySelector('[aria-label="Trading panel"]');
    if (tp && tp.getBoundingClientRect().width > 50) return { open: true, kind: 'right-rail' };
    return { open: false };
  })()`);
  if (!verify || !verify.open) {
    throw new Error('Account manager / Trading panel not found. Open the Paper Trading account panel in TradingView (bottom-left "Paper Trading" button), then run trade_probe to calibrate selectors.');
  }
  return { success: true, panel_open: true, ...(opened && opened.clicked ? { clicked_open: true } : {}) };
}

async function focusSymbol(symbol, evaluateAsync) {
  const result = await evaluateAsync(`new Promise(function(resolve) { ${FINDER_JS}
    function findInput() {
      var direct = document.querySelector('[data-name="symbol-search-input"]') || document.querySelector('[data-role="search"]');
      if (direct) return direct;
      var inputs = document.querySelectorAll('input[type="text"], input[type="search"]');
      for (var i = 0; i < inputs.length; i++) {
        var ph = inputs[i].getAttribute('placeholder') || '';
        if (/symbol|search/i.test(ph)) return inputs[i];
      }
      return null;
    }
    function setSymbol(input) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(symbol)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    }
    var input = findInput();
    if (input) { resolve(setSymbol(input)); return; }
    var btn = document.querySelector('[data-name="header-symbol-search"]') || document.querySelector('[data-name="symbol-search"]');
    if (!btn) { resolve(false); return; }
    btn.click();
    setTimeout(function() {
      var i2 = findInput();
      if (i2) resolve(setSymbol(i2)); else resolve(false);
    }, 400);
  })`);
  return !!result;
}

/**
 * Open the DOM order ticket: right-click the chart pane, then click the
 * context menu's "Create limit order…" item. The ticket exposes Market/Limit/
 * Stop tabs, a Buy/Sell side control, price + qty inputs and a submit button —
 * all in the main window DOM (verified 2026-08).
 */
export async function openOrderTicket({ _deps } = {}) {
  const { evaluate, evaluateAsync, getClient } = _resolve(_deps);
  const existing = await evaluate(`(function(){
    var t = document.querySelector(${JSON.stringify(SELECTORS.ticket.container)});
    return { open: !!(t && t.offsetParent !== null) };
  })()`);
  if (existing && existing.open) return { success: true, opened: false };

  // Right-click the chart pane to open the context menu.
  const c = await getClient();
  const pt = await evaluate(`(function(){
    var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
    if (!el) return { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: pt.x, y: pt.y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: pt.x, y: pt.y, button: 'right', buttons: 2, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: pt.x, y: pt.y, button: 'right' });
  await new Promise((r) => setTimeout(r, 500));

  // Click an order-creating context-menu item. Two variants exist depending on
  // where the chart was right-clicked:
  //   1. "Create limit order…" (generic, opens the ticket dialog)
  //   2. "Sell 1 NQ1! @ 29,554.75 limit" / "Buy 1 NQ1! @ … stop" (price-based,
  //      also opens the ticket dialog for confirmation)
  const clicked = await evaluateAsync(`new Promise(function(resolve) {
    var label = ${JSON.stringify(SELECTORS.ticket.context_menu_item)};
    var all = document.querySelectorAll('div, span, button, a');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      var r = all[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      var orderItem = t === label || t.indexOf('Create limit order') === 0 ||
        /^(Buy|Sell)\\s+\\d+\\s+[^@]+@\\s+[\\d,.]+\\s+(limit|market|stop)$/i.test(t);
      if (orderItem) { all[i].click(); resolve({ found: true, text: t }); return; }
    }
    resolve({ found: false });
  })`);
  if (!clicked || !clicked.found) {
    throw new Error('Order ticket menu item not found. Right-click the chart manually and check for "Create limit order…".');
  }
  await new Promise((r) => setTimeout(r, 1000));

  const verify = await evaluate(`(function(){
    var t = document.querySelector(${JSON.stringify(SELECTORS.ticket.container)});
    return { open: !!(t && t.offsetParent !== null) };
  })()`);
  if (!verify || !verify.open) {
    throw new Error('Order ticket did not open. Run trade_probe to inspect the DOM.');
  }
  return { success: true, opened: true };
}

/** Click the Buy/Sell side control inside the order ticket. */
export async function setSide({ side, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const label = SELECTORS.ticket.side[side];
  if (!label) throw new Error(`Invalid side: ${side}`);
  const result = await evaluateAsync(`new Promise(function(resolve) { ${FINDER_JS}
    var ticket = document.querySelector(${JSON.stringify(SELECTORS.ticket.container)});
    if (!ticket) { resolve({ found: false, step: 'ticket' }); return; }
    var sideCtl = ticket.querySelector('[class*="sideControl"]');
    var scope = sideCtl || ticket;
    var els = scope.querySelectorAll('div, span, button');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (t === ${JSON.stringify(label)}) {
        var r = els[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { els[i].click(); resolve({ found: true }); return; }
      }
    }
    resolve({ found: false });
  })`);
  if (!result || !result.found) {
    throw new Error(`Side control not found in order ticket: ${side}.`);
  }
  return { success: true, side };
}

/**
 * Click the Market/Limit/Stop tab inside the order ticket. The close action
 * short-circuits (it uses the dedicated Close button in the positions list).
 */
export async function setOrderType({ action, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  if (action === 'close') return { success: true };
  const label = SELECTORS.ticket.type_tabs[action];
  if (!label) throw new Error(`Invalid order type: ${action}`);
  const result = await evaluateAsync(`new Promise(function(resolve) { ${FINDER_JS}
    var ticket = document.querySelector(${JSON.stringify(SELECTORS.ticket.container)});
    if (!ticket) { resolve({ found: false, step: 'ticket' }); return; }
    var els = ticket.querySelectorAll('button');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (t === ${JSON.stringify(label)}) {
        var r = els[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { els[i].click(); resolve({ found: true }); return; }
      }
    }
    resolve({ found: false });
  })`);
  if (!result || !result.found) {
    throw new Error(`Order type tab not found in ticket: ${action}.`);
  }
  // Let the ticket re-render the inputs for the selected type.
  await new Promise((r) => setTimeout(r, 300));
  return { success: true, order_type: action };
}

/** Set the quantity input (inside the order ticket) via native setter + events. */
export async function setQty({ qty, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) throw new Error('qty must be a positive finite number');
  const result = await evaluate(`(function() {
    var ticket = document.querySelector(${JSON.stringify(SELECTORS.ticket.container)});
    if (!ticket) return { found: false, step: 'ticket' };
    var inputs = ticket.querySelectorAll(${JSON.stringify(SELECTORS.ticket.qty_input)});
    // The price input is excluded by :not([class*="price"]); first match is qty.
    var el = inputs[0];
    if (!el) return { found: false, step: 'qty' };
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(n)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, value: el.value };
  })()`);
  if (!result || !result.found) {
    throw new Error(`Quantity input not found in order ticket (step=${result && result.step}). Run trade_probe to inspect.`);
  }
  return { success: true, value: n };
}

/** Set the price input (inside the order ticket) via native setter + events (limit/stop only). */
export async function setPrice({ price, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error('price must be a positive finite number');
  const result = await evaluate(`(function() {
    var ticket = document.querySelector(${JSON.stringify(SELECTORS.ticket.container)});
    if (!ticket) return { found: false, step: 'ticket' };
    var el = ticket.querySelector(${JSON.stringify(SELECTORS.ticket.price_input)});
    if (!el) return { found: false, step: 'price' };
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(n)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, value: el.value };
  })()`);
  if (!result || !result.found) {
    throw new Error(`Price input not found in order ticket (step=${result && result.step}). Run trade_probe to inspect.`);
  }
  return { success: true, value: n };
}

/**
 * Click the order ticket's submit button, then any confirmation dialog
 * (best-effort). Returns { submitted: true, summary }.
 */
export async function submit({ side, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const clicked = await evaluate(`(function() {
    var ticket = document.querySelector(${JSON.stringify(SELECTORS.ticket.container)});
    if (!ticket) return { found: false, step: 'ticket' };
    var btn = ticket.querySelector(${JSON.stringify(SELECTORS.ticket.submit)});
    if (!btn) return { found: false, step: 'submit' };
    btn.click();
    return { found: true, text: (btn.textContent || '').trim().substring(0, 60) };
  })()`);
  if (!clicked || !clicked.found) {
    throw new Error(`Submit button not found in order ticket (step=${clicked && clicked.step}). Run trade_probe to inspect.`);
  }
  // Confirmation dialogs vary across builds — best-effort, never fatal.
  await evaluate(clickExpr(SELECTORS.ticket.confirm));
  return { submitted: true, summary: clicked.text };
}

// ── One-click ticket (market orders) ──────────────────────────────────────

/**
 * Open the one-click ticket's qty editor (click the qty control), then set the
 * qty via native setter + input/change events + Enter. The one-click Buy/Sell
 * buttons then place a MARKET order at the current price with this qty.
 */
export async function setQtyOneClick({ qty, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) throw new Error('qty must be a positive finite number');
  const opened = await evaluate(`(function() {
    var q = document.querySelector(${JSON.stringify(SELECTORS.one_click.qty)});
    if (!q) return { found: false };
    q.click();
    return { found: true };
  })()`);
  if (!opened || !opened.found) throw new Error('One-click qty control not found.');
  await new Promise((r) => setTimeout(r, 400));
  const res = await evaluate(`(function() {
    var inputs = document.querySelectorAll(${JSON.stringify(SELECTORS.one_click.qty_input)});
    var input = null;
    for (var i = 0; i < inputs.length; i++) { if (inputs[i].offsetParent !== null) { input = inputs[i]; break; } }
    if (!input) return { found: false };
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(n)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return { found: true, value: input.value };
  })()`);
  if (!res || !res.found) throw new Error('One-click qty input not found.');
  return { success: true, value: n };
}

/**
 * Click the one-click ticket's Buy/Sell button — places a MARKET order at the
 * current price with the qty set via setQtyOneClick.
 */
export async function submitOneClick({ side, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const sel = side === 'buy' ? SELECTORS.one_click.buy : SELECTORS.one_click.sell;
  const res = await evaluate(`(function() {
    var btn = document.querySelector(${JSON.stringify(sel)});
    if (!btn) return { found: false };
    btn.click();
    return { found: true, text: (btn.textContent || '').trim().substring(0, 40) };
  })()`);
  if (!res || !res.found) throw new Error(`One-click ${side} button not found.`);
  return { submitted: true, summary: res.text };
}

/**
 * Click the Close position / "Close long" | "Close short" button in the
 * positions list for the given side. Returns { submitted: true, position? } or
 * throws when no matching position exists.
 */
export async function closePosition({ side, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const sideText = side === 'buy' ? 'Close long' : 'Close short';
  const res = await evaluateAsync(`new Promise(function(resolve) { ${FINDER_JS}
    var positionsSpec = ${JSON.stringify(SELECTORS.container.positions)};
    var closeDataNames = ${JSON.stringify(SELECTORS.close.data_name)};
    var sideText = ${JSON.stringify(sideText)};
    var container = findEl(positionsSpec);
    var btn = null;
    if (container) {
      // 1. Prefer a close button INSIDE the positions container. 'Close' alone
      //    is acceptable here because it is scoped to the positions list.
      var closeBtns = container.querySelectorAll('button, a, [role="button"]');
      for (var i = 0; i < closeBtns.length && !btn; i++) {
        var t = (closeBtns[i].textContent || '').trim();
        if (t === 'Close long' || t === 'Close short' || t === 'Close' || /^close/i.test(t)) btn = closeBtns[i];
      }
      if (!btn) {
        for (var d = 0; d < closeDataNames.length && !btn; d++) btn = container.querySelector('[data-name="' + closeDataNames[d] + '"]');
      }
    }
    // 2. Document-wide fallback ONLY with the side-specific label — never the
    //    bare 'Close', which could hit an unrelated dialog/tab/panel close.
    if (!btn) btn = findEl({ data_name: closeDataNames, text: [sideText] });
    if (!btn) { resolve({ found: false }); return; }
    var row = btn.closest('[data-name="position-row"], [data-name="row"], tr, [class*="row"]');
    var rowText = row ? (row.textContent || '').trim().substring(0, 200) : (btn.parentElement ? (btn.parentElement.textContent || '').trim().substring(0, 200) : '');
    btn.click();
    resolve({ found: true, row: rowText });
  })`);
  if (!res || !res.found) {
    throw new Error(`No ${sideText} position found to close. Run trade_probe to calibrate selectors.`);
  }
  await evaluate(clickExpr(SELECTORS.submit.confirm));
  return { submitted: true, position: res.row ? { row: res.row } : undefined };
}

/**
 * Runtime DOM + API namespace discovery for selector calibration (trade_probe).
 * Dumps the account manager area (tabs + position/order action buttons) and
 * probes window.TradingViewApi for any broker/orders/account/trading
 * namespace. Returns { elements, api_namespaces, panel_open, paper_mode }.
 */
export async function probe({ _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const pm = await isPaperMode({ _deps });
  const panel = await openPanel({ _deps });
  const elementsRes = await evaluateAsync(`(function() {
    // Scope to the whole account manager panel (tabs + content/positions table),
    // not just the tabs bar — the close button lives in the content area.
    var tabs = document.querySelector('#id_account-manager-tabs');
    var scope = null;
    if (tabs) {
      scope = tabs;
      // Walk up to the account manager root that contains both tabs and rows.
      var p = tabs.parentElement;
      for (var up = 0; up < 6 && p && p !== document.body; up++) {
        if ((p.getAttribute('class') || '').indexOf('accountManager') !== -1) { scope = p; break; }
        p = p.parentElement;
      }
      if (scope === tabs) {
        // Fall back to the bottom layout area which holds the whole panel.
        var bottom = document.querySelector('[class*="layout__area--bottom"]');
        if (bottom && tabs.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_CONTAINED_BY) scope = bottom;
      }
    }
    if (!scope) {
      var am = document.querySelector('[class*="accountManager"]');
      scope = am || document.querySelector('[class*="layout__area--bottom"]') || document;
    }
    var els = scope.querySelectorAll('button[data-name], [data-name], button[aria-label], [aria-label]');
    var out = [];
    for (var i = 0; i < els.length && i < 300; i++) {
      var e = els[i];
      var r = e.getBoundingClientRect();
      out.push({
        tag: e.tagName.toLowerCase(),
        data_name: e.getAttribute('data-name'),
        aria: e.getAttribute('aria-label'),
        cls: (e.getAttribute('class') || '').split(' ').filter(function(c){ return c.indexOf('button')!==-1 || c.indexOf('cell')!==-1; }).slice(0, 3).join(' '),
        text: (e.textContent || '').trim().substring(0, 60),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        visible: e.offsetParent !== null
      });
    }
    return { container: !!tabs, scope_kind: tabs ? (scope === tabs ? 'tabs' : 'account-manager') : 'fallback', elements: out };
  })()`);
  const api = await evaluate(`(function() {
    var api = window.TradingViewApi;
    var out = [];
    if (!api) return out;
    var names = Object.getOwnPropertyNames(api);
    for (var i = 0; i < names.length; i++) {
      if (/broker|order|account|trade|position/i.test(names[i])) {
        var v = api[names[i]];
        out.push({ name: names[i], type: typeof v, method: typeof v === 'function' });
      }
    }
    return out;
  })()`);
  return {
    success: true,
    scope: (elementsRes && elementsRes.scope_kind) || 'unknown',
    elements: (elementsRes && elementsRes.elements) || [],
    api_namespaces: api || [],
    panel_open: !!(panel && panel.panel_open),
    paper_mode: pm.paper_mode,
  };
}

/**
 * Read paper-trading account state from the bottom widget bar lists:
 * positions + open orders. Returns { positions, orders, paper_mode }.
 * Throws when neither container is discoverable.
 */
export async function status({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const pm = await isPaperMode({ _deps });
  const positionsRes = await evaluateAsync(containerRowsExpr(SELECTORS.container.positions, 'positions'));
  const ordersRes = await evaluateAsync(containerRowsExpr(SELECTORS.container.open_orders, 'orders'));
  if ((!positionsRes || !positionsRes.container) && (!ordersRes || !ordersRes.container)) {
    throw new Error('Neither the positions nor the open-orders panel was found. Run trade_probe to calibrate selectors.');
  }
  return {
    success: true,
    paper_mode: pm.paper_mode,
    positions: (positionsRes && positionsRes.positions) || [],
    orders: (ordersRes && ordersRes.orders) || [],
  };
}

/**
 * Shared response builder. Failures never reach this helper — they throw and
 * the registry wrap() converts them to { success:false, error }.
 */
export function formatResponse({ action, side, qty, price, order_type, submitted, dry_run, paper_mode, position } = {}) {
  return {
    success: true,
    action,
    side: side || null,
    qty: qty !== undefined && qty !== null && qty !== '' ? Number(qty) : null,
    price: price !== undefined && price !== null && price !== '' ? Number(price) : null,
    order_type,
    submitted: !!submitted,
    dry_run: !!dry_run,
    paper_mode: !!paper_mode,
    ...(position ? { position } : {}),
  };
}

/**
 * Execute a paper trade.
 *
 * For market/limit/stop: opens the DOM order ticket (chart right-click →
 * "Create limit order…"), sets side, order-type tab, qty and price, then
 * submits. For close: clicks the Close button in the account manager. When
 * dry_run=true every DOM step runs exactly as live except the submit/confirm
 * click, which is never dispatched.
 */
export async function trade({ action, side, qty, price, symbol, dry_run, _deps } = {}) {
  // (1) Validate before any CDP call.
  if (!ORDER_TYPES.includes(action)) throw new Error(`Invalid action: ${action}. Use: market, limit, stop, close`);
  const isClose = action === 'close';
  // qty is REQUIRED for market/limit/stop — omitting it would submit whatever
  // stale/default value sits in the quantity input.
  if (!isClose) {
    if (qty === undefined || qty === null || qty === '') {
      throw new Error('qty is required for market/limit/stop orders');
    }
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) throw new Error('qty must be a positive finite number');
  }
  if (action === 'limit' || action === 'stop') {
    const p = Number(price);
    if (price === undefined || price === null || price === '' || !Number.isFinite(p) || p <= 0) {
      throw new Error('price is required for limit/stop orders and must be a positive finite number');
    }
  }
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(isClose ? 'side is required to close a long or short position' : 'side is required');
  }

  // (2) Paper-mode safety gate — skipped for dry_run. Re-checked fresh on every
  // submission (never cached) so an account switch mid-session is caught.
  let paper_mode = false;
  if (!dry_run) {
    const pm = await isPaperMode({ _deps });
    paper_mode = pm.paper_mode;
    if (!paper_mode) {
      throw new Error('Refusing to execute: paper trading mode not detected. Run trade_probe to inspect the panel, or pass dry_run=true to validate the flow without submitting.');
    }
  }

  // (3) Close position path — uses the account manager's Close button.
  if (isClose) {
    let submitted = false;
    let position;
    if (!dry_run) {
      const res = await closePosition({ side, _deps });
      submitted = res.submitted;
      position = res.position;
    }
    return formatResponse({ action, side, order_type: action, submitted, dry_run, paper_mode, position });
  }

  // (4) Order placement.
  let submitted = false;
  let summary;
  if (symbol) {
    const { evaluateAsync } = _resolve(_deps);
    await focusSymbol(symbol, evaluateAsync);
  }
  if (action === 'market') {
    // Market orders use the one-click ticket (verified main-window DOM):
    // set qty, then click Buy/Sell to place a market order at the current price.
    await setQtyOneClick({ qty, _deps });
    if (!dry_run) {
      const res = await submitOneClick({ side, _deps });
      submitted = res.submitted;
      summary = res.summary;
    }
  } else {
    // limit/stop → open the DOM order ticket (right-click → "Create limit order…")
    // and drive its side control, Market/Limit/Stop tabs, qty/price inputs.
    await openOrderTicket({ _deps });
    await setSide({ side, _deps });
    await setOrderType({ action, _deps });
    await setQty({ qty, _deps });
    if (action === 'limit' || action === 'stop') await setPrice({ price, _deps });
    if (!dry_run) {
      const res = await submit({ side, _deps });
      submitted = res.submitted;
      summary = res.summary;
    }
  }

  // (6) Response.
  const resp = formatResponse({ action, side, qty, price, order_type: action, submitted, dry_run, paper_mode });
  return summary ? { ...resp, summary } : resp;
}
