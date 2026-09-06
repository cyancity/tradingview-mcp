import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// A fast facts snapshot starts several read-only CDP calls at once. Keep the
// first connection attempt shared so those calls do not all scan /json/list,
// probe visible tabs, and attach separate clients concurrently.
let connecting = null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9223;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Hard deadlines on every CDP interaction. TradingView's debug port keeps
// answering HTTP even when its renderers have crashed or been frozen by
// macOS (App Nap when launched detached from a background process), so an
// unbounded Runtime.evaluate can block forever and wedge the whole MCP
// session. Nothing in this file may await a CDP promise bare.
const EVAL_TIMEOUT = 15000;
const CONNECT_TIMEOUT = 5000;
const PROBE_TIMEOUT = 2500;
const HTTP_TIMEOUT = 3000;

export function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label} timed out after ${ms}ms — TradingView is not responding. ` +
      `Its renderer may have crashed or been suspended by macOS; ` +
      `restart TradingView Desktop (tv launch) and retry.`
    )), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await withTimeout(
        client.Runtime.evaluate({ expression: '1', returnByValue: true }),
        PROBE_TIMEOUT, 'Liveness check'
      );
      return client;
    } catch {
      try { await client.close(); } catch {}
      client = null;
      targetInfo = null;
    }
  }
  if (!connecting) {
    const pending = connect();
    connecting = pending;
    pending.then(() => {
      if (connecting === pending) connecting = null;
    }, () => {
      if (connecting === pending) connecting = null;
    });
  }
  return connecting;
}

export async function connect(targetId = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId ? await findTargetById(targetId) : await findChartTarget();
      if (!target) {
        throw new Error(targetId
          ? `CDP target ${targetId} not found — is the tab still open?`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await withTimeout(
        CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id }),
        CONNECT_TIMEOUT, 'CDP attach'
      );

      // Enable required domains
      await withTimeout(
        Promise.all([client.Runtime.enable(), client.Page.enable(), client.DOM.enable()]),
        CONNECT_TIMEOUT, 'CDP domain enable'
      );

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId) {
  if (client) {
    try { await client.close(); } catch { /* already gone */ }
    client = null;
    targetInfo = null;
  }
  return connect(targetId);
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`,
    { signal: AbortSignal.timeout(HTTP_TIMEOUT) });
  const targets = await resp.json();
  const charts = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (charts.length === 0) return null;
  if (charts.length === 1) return charts[0];

  // Multiple chart tabs exist. /json/list order is NOT guaranteed to match the
  // foreground tab, and there is no "active" field — so probing every chart
  // target for document.visibilityState === 'visible' is the reliable way to
  // find the tab the user is actually looking at. This is the ROOT CAUSE fix
  // for "operations landing on the wrong chart" (tv state flipping symbols,
  // pine edits hitting the wrong layout, layout switch going to a random tab).
  for (const t of charts) {
    let c = null;
    try {
      c = await withTimeout(
        CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id }),
        CONNECT_TIMEOUT, 'CDP attach'
      );
      await c.Runtime.enable();
      const r = await withTimeout(
        c.Runtime.evaluate({ expression: 'document.visibilityState', returnByValue: true }),
        PROBE_TIMEOUT, 'Renderer probe'
      );
      if (r?.result?.value === 'visible') return t;
    } catch { /* probe failed, skip */ }
    finally {
      if (c) { try { await c.close(); } catch { /* ignore */ } }
    }
  }
  // No foreground chart found (app minimized / active tab is not a chart):
  // fall back to the first chart target.
  return charts[0];
}

async function findTargetById(id) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`,
    { signal: AbortSignal.timeout(HTTP_TIMEOUT) });
  const targets = await resp.json();
  return targets.find(t => t.id === id) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const { timeoutMs, ...cdpOpts } = opts;
  let result;
  try {
    result = await withTimeout(
      c.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: cdpOpts.awaitPromise ?? false,
        ...cdpOpts,
      }),
      timeoutMs ?? EVAL_TIMEOUT, 'Runtime.evaluate'
    );
  } catch (err) {
    // Drop the cached client on timeout so the next call re-probes targets
    // instead of piling more calls onto a dead renderer.
    if (/timed out/.test(err.message)) {
      try { await c.close(); } catch {}
      client = null;
      targetInfo = null;
    }
    throw err;
  }
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (connecting) {
    try { await connecting; } catch { /* allow a later call to reconnect */ }
  }
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
