/**
 * Core copilot context — parallel facts extraction.
 *
 * Collects chart state, OHLCV, indicators, Pine drawings, quote and
 * user drawings in parallel via dependency-injected core functions.
 * Single-source failures are degraded to warnings, never thrown.
 */

import * as chart from '../chart.js';
import * as data from '../data.js';
import * as drawing from '../drawing.js';

/**
 * Collect chart facts in parallel.
 *
 * @param {object} opts
 * @param {{from?:number,to?:number}|null} opts.timeRange - unix seconds range to filter bars
 * @param {boolean} [opts.includeDrawings=true]
 * @param {boolean} [opts.includeIndicators=true]
 * @param {number} [opts.maxBars=200]
 * @param {object} [opts._deps] - injectable core fns for mocking
 * @param {Function} [opts._deps.getState]
 * @param {Function} [opts._deps.getVisibleRange]
 * @param {Function} [opts._deps.getOhlcv]
 * @param {Function} [opts._deps.getStudyValues]
 * @param {Function} [opts._deps.getPineLines]
 * @param {Function} [opts._deps.getPineLabels]
 * @param {Function} [opts._deps.getPineBoxes]
 * @param {Function} [opts._deps.getPineTables]
 * @param {Function} [opts._deps.listDrawings]
 * @param {Function} [opts._deps.getProperties]
 * @param {Function} [opts._deps.getQuote]
 * @returns {Promise<object>} standardized facts
 */
export async function collectFacts({
  timeRange,
  includeDrawings = true,
  includeIndicators = true,
  maxBars = 200,
  _deps,
} = {}) {
  const deps = {
    getState: _deps?.getState || chart.getState,
    getVisibleRange: _deps?.getVisibleRange || chart.getVisibleRange,
    getOhlcv: _deps?.getOhlcv || data.getOhlcv,
    getStudyValues: _deps?.getStudyValues || data.getStudyValues,
    getPineLines: _deps?.getPineLines || data.getPineLines,
    getPineLabels: _deps?.getPineLabels || data.getPineLabels,
    getPineBoxes: _deps?.getPineBoxes || data.getPineBoxes,
    getPineTables: _deps?.getPineTables || data.getPineTables,
    listDrawings: _deps?.listDrawings || drawing.listDrawings,
    getProperties: _deps?.getProperties || drawing.getProperties,
    getQuote: _deps?.getQuote || data.getQuote,
  };

  const warnings = [];
  const pineWarnings = [];

  // Clamp maxBars to sane range 1..500 (data layer max is 500)
  const limit = Math.min(Math.max(Number(maxBars) || 200, 1), 500);

  // Helper to wrap a fn call into a promise that never throws synchronously
  const safeCall = (fn, arg) => {
    try {
      return Promise.resolve(fn(arg));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  // Build parallel fetch map
  const fetchMap = {};

  fetchMap.state = safeCall(deps.getState, {});
  fetchMap.visibleRange = safeCall(deps.getVisibleRange, {});
  fetchMap.ohlcv = safeCall(deps.getOhlcv, { count: limit });
  fetchMap.quote = safeCall(deps.getQuote, {});

  if (includeIndicators) {
    fetchMap.studyValues = safeCall(deps.getStudyValues, {});
  }

  // Pine drawings: each kind once, degraded via warnings (always fetched)
  fetchMap.pineLines = safeCall(deps.getPineLines, {});
  fetchMap.pineLabels = safeCall(deps.getPineLabels, {});
  fetchMap.pineBoxes = safeCall(deps.getPineBoxes, {});
  fetchMap.pineTables = safeCall(deps.getPineTables, {});

  if (includeDrawings) {
    fetchMap.listDrawings = safeCall(deps.listDrawings, {});
  }
  const keys = Object.keys(fetchMap);
  const settled = await Promise.allSettled(Object.values(fetchMap));
  const resultMap = {};
  keys.forEach((k, i) => {
    resultMap[k] = settled[i];
  });

  // --- helpers to extract or warn ---
  const getFulfilled = (key) => {
    const r = resultMap[key];
    if (!r) return null;
    if (r.status === 'fulfilled') return r.value;
    const msg = r.reason?.message || String(r.reason);
    warnings.push(`${key} failed: ${msg}`);
    return null;
  };

  const getPineKind = (key, label) => {
    const r = resultMap[key];
    if (!r) return [];
    if (r.status === 'fulfilled' && r.value) {
      const v = r.value;
      // data.getPine* returns { studies: [...] } or { study_count, studies }
      if (Array.isArray(v)) return v;
      if (Array.isArray(v.studies)) return v.studies;
      if (Array.isArray(v.lines)) return v.lines;
      if (Array.isArray(v.labels)) return v.labels;
      if (Array.isArray(v.boxes)) return v.boxes;
      if (Array.isArray(v.tables)) return v.tables;
      // fallback: value itself is studies-like
      return v.studies ?? [];
    }
    const msg = r.reason?.message || String(r.reason);
    const w = `${label} failed: ${msg}`;
    pineWarnings.push(w);
    warnings.push(w);
    return [];
  };

  // --- state ---
  const stateVal = getFulfilled('state');
  const visibleRangeVal = getFulfilled('visibleRange');
  // visibleRange fetched for completeness / future use; warnings already recorded
  void visibleRangeVal;

  // --- quote ---
  const quoteVal = getFulfilled('quote');
  const quote = quoteVal || null;

  // --- ohlcv bars ---
  let bars = [];
  const ohlcvVal = getFulfilled('ohlcv');
  if (ohlcvVal) {
    const raw = ohlcvVal.bars || ohlcvVal.data || [];
    if (Array.isArray(raw)) bars = raw.slice();
    else warnings.push('ohlcv: unexpected bars shape');
  }

  // Enforce maxBars truncation (request count already limited, but be defensive)
  if (bars.length > limit) {
    bars = bars.slice(-limit);
    warnings.push(`bars truncated to maxBars=${limit}`);
  }

  // Time-range filtering
  if (timeRange && (timeRange.from != null || timeRange.to != null)) {
    const from = timeRange.from != null ? Number(timeRange.from) : -Infinity;
    const to = timeRange.to != null ? Number(timeRange.to) : Infinity;
    const filtered = bars.filter((b) => {
      const t = Number(b.time);
      return t >= from && t <= to;
    });
    // "过少" → keep recent 50 and warn
    if (filtered.length === 0 || filtered.length < 5) {
      const originalLen = filtered.length;
      const fallback = bars.slice(-50);
      warnings.push(
        `timeRange filter yielded ${originalLen} bars (from=${timeRange.from ?? '-'} to=${timeRange.to ?? '-'}), fallback to recent ${fallback.length} bars`,
      );
      bars = fallback;
    } else {
      bars = filtered;
      // ensure still within limit after fallback (50 is < limit normally)
      if (bars.length > limit) bars = bars.slice(-limit);
    }
  }

  // --- range & summary ---
  let range;
  let summary = null;
  if (bars.length > 0) {
    const first = bars[0];
    const last = bars[bars.length - 1];
    range = { from: first.time, to: last.time, barsCount: bars.length };
    let high = -Infinity;
    let low = Infinity;
    let volSum = 0;
    for (const b of bars) {
      if (typeof b.high === 'number' && b.high > high) high = b.high;
      if (typeof b.low === 'number' && b.low < low) low = b.low;
      if (typeof b.volume === 'number') volSum += b.volume;
    }
    if (!Number.isFinite(high)) high = null;
    if (!Number.isFinite(low)) low = null;
    const avgVolume = bars.length ? Math.round(volSum / bars.length) : null;
    summary = { high, low, avgVolume };
  } else {
    range = { from: null, to: null, barsCount: 0 };
  }

  // --- symbol / timeframe ---
  const symbol = stateVal?.symbol || stateVal?.actual_symbol || quote?.symbol || null;
  const timeframe = stateVal?.resolution || stateVal?.timeframe || null;

  // --- indicators ---
  let indicators = { count: 0, values: [] };
  if (includeIndicators) {
    const v = getFulfilled('studyValues');
    // getFulfilled already pushed warning on rejection; need to avoid double push
    // But we already consumed studyValues via getFulfilled which pushes warning if failed.
    // So handle success case only.
    if (v) {
      const studies = v.studies || v.values || [];
      const count = v.study_count ?? v.count ?? (Array.isArray(studies) ? studies.length : 0);
      indicators = { count, values: Array.isArray(studies) ? studies : [] };
    } else {
      // already warned; keep empty
      // Check if result was rejected we already warned, but getFulfilled returned null.
      // Ensure indicators stays empty.
      const r = resultMap.studyValues;
      if (r && r.status === 'rejected') {
        // warning already added by getFulfilled, avoid duplicate
      }
    }
  }

  // For pine, we already have helpers that push warnings; but we used getFulfilled for others.
  // For pine we use getPineKind which handles warnings internally, so we should not double-warn via getFulfilled.
  // Re-derive pine without using getFulfilled duplicate.
  const pine = {
    lines: getPineKind('pineLines', 'pineLines'),
    labels: getPineKind('pineLabels', 'pineLabels'),
    boxes: getPineKind('pineBoxes', 'pineBoxes'),
    tables: getPineKind('pineTables', 'pineTables'),
    warnings: pineWarnings.slice(),
  };

  // Adjust pine warnings dedup: getPineKind already pushed to warnings + pineWarnings
  // No extra action needed.

  // --- drawings ---
  let drawings = { count: 0, items: [] };
  if (includeDrawings) {
    const listVal = resultMap.listDrawings;
    if (listVal && listVal.status === 'fulfilled' && listVal.value) {
      const v = listVal.value;
      const shapes = v.shapes || v.drawings || [];
      const count = v.count ?? shapes.length;
      drawings.count = count;
      const toFetch = Array.isArray(shapes) ? shapes.slice(0, 20) : [];
      if (shapes.length > 20) {
        warnings.push(`drawings truncated to 20 of ${shapes.length}`);
      }
      if (toFetch.length > 0) {
        const propSettled = await Promise.allSettled(
          toFetch.map((s) => safeCall(deps.getProperties, { entity_id: s.id })),
        );
        const items = [];
        for (let i = 0; i < toFetch.length; i++) {
          const shp = toFetch[i];
          const pr = propSettled[i];
          if (pr.status === 'fulfilled' && pr.value) {
            const pv = pr.value;
            items.push({
              id: shp.id,
              name: shp.name ?? pv.name ?? null,
              points: pv.points ?? null,
              properties: pv.properties ?? pv ?? null,
            });
          } else {
            const msg = pr.reason?.message || String(pr.reason);
            warnings.push(`getProperties ${shp.id} failed: ${msg}`);
            items.push({
              id: shp.id,
              name: shp.name ?? null,
              points: null,
              properties: null,
            });
          }
        }
        drawings.items = items;
      }
    } else if (listVal && listVal.status === 'rejected') {
      // warning already added via getFulfilled? We didn't use getFulfilled for listDrawings to avoid double, so add now
      const msg = listVal.reason?.message || String(listVal.reason);
      warnings.push(`listDrawings failed: ${msg}`);
    } else {
      // fulfilled but empty or null
      const v = listVal?.value;
      if (!v) {
        // Check if we already warned for missing? Use getFulfilled path.
        // Fallback: treat as empty
        drawings.count = 0;
      }
    }
    // If we didn't handle via listVal rejected, but listVal is fulfilled with no warning, drawings stays.
    // Need to also handle case where listVal fulfilled but warning path for getFulfilled not used;
    // we already set count.
  }

  const meta = { collectedAt: Math.floor(Date.now() / 1000) };

  return {
    symbol,
    timeframe,
    range,
    bars,
    summary,
    indicators,
    pine,
    drawings,
    quote,
    warnings,
    meta,
  };
}
