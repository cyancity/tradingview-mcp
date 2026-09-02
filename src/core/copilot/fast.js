/**
 * Fast current-chart copilot path.
 *
 * This module intentionally keeps the CDP boundary small: one CLI/MCP call,
 * one cached connection, one read-only anchor batch, and one optional Pine /
 * drawing batch. ICT is pure JavaScript and runs locally after the reads.
 */
import { performance } from 'node:perf_hooks';
import * as chart from '../chart.js';
import * as data from '../data.js';
import * as drawing from '../drawing.js';
import * as ui from '../ui.js';
import { analyzeICT } from './ict.js';

const DEFAULT_FILTER = 'iFVG';
const DEFAULT_MAX_BARS = 100;
const MAX_BARS = 500;
const MAX_DRAWINGS = 20;
const MAX_RECENT_BARS = 8;
const MAX_PINE_LABELS = 20;
const MAX_PINE_TABLE_ROWS = 16;
const MAX_ICT_ITEMS = 12;

const roundMs = (value) => Math.max(0, Math.round(value));

function clampBars(value) {
  return Math.min(Math.max(Number(value) || DEFAULT_MAX_BARS, 1), MAX_BARS);
}

function getClock(_deps) {
  return typeof _deps?.clock === 'function' ? _deps.clock : () => performance.now();
}

function asStudies(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.studies)) return value.studies;
  return [];
}

function matchesFilter(name, filter) {
  if (!filter) return true;
  return String(name || '').toLowerCase().includes(String(filter).toLowerCase());
}

function compactText(value, max = 180) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  const text = String(value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value !== 'object') return compactText(value);
  if (depth >= 2) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactValue(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    result[key] = compactValue(item, depth + 1);
  }
  return result;
}

/**
 * Strip inputs/protected blobs and keep only current data-window values.
 * This is deliberately exported so the redaction contract can be unit tested.
 */
export function compactIndicatorValues(value, studyFilter) {
  const studies = asStudies(value)
    .filter((study) => matchesFilter(study?.name, studyFilter))
    .map((study) => ({
      id: study?.id ?? null,
      name: study?.name ?? null,
      values: compactValue(study?.values || {}),
    }));

  // Keep compatibility with injected/offline mocks that use values as a map.
  if (studies.length === 0 && value?.values && !Array.isArray(value.values)) {
    return {
      success: value.success !== false,
      study_count: 1,
      studies: [{ id: null, name: 'data window', values: compactValue(value.values) }],
    };
  }

  return {
    success: value?.success !== false,
    study_count: studies.length,
    studies,
  };
}

function compactPine(value, kind, studyFilter) {
  const studies = asStudies(value).filter((study) => matchesFilter(study?.name, studyFilter));
  const output = studies.map((study) => {
    if (kind === 'tables') {
      return {
        name: study?.name ?? null,
        tables: (study?.tables || []).slice(0, 20).map((table) => ({
          rows: (table?.rows || []).slice(0, MAX_PINE_TABLE_ROWS).map((row) => compactText(row)),
        })),
      };
    }
    if (kind === 'labels') {
      return {
        name: study?.name ?? null,
        total_labels: study?.total_labels ?? study?.labels?.length ?? 0,
        labels: (study?.labels || []).slice(-MAX_PINE_LABELS).map((label) => ({
          text: compactText(label?.text),
          price: label?.price ?? null,
        })),
      };
    }
    if (kind === 'boxes') {
      return {
        name: study?.name ?? null,
        total_boxes: study?.total_boxes ?? study?.zones?.length ?? 0,
        zones: (study?.zones || []).slice(0, MAX_ICT_ITEMS).map((zone) => ({
          high: zone?.high ?? null,
          low: zone?.low ?? null,
        })),
      };
    }
    return {
      name: study?.name ?? null,
      total_lines: study?.total_lines ?? study?.horizontal_levels?.length ?? 0,
      horizontal_levels: (study?.horizontal_levels || []).slice(0, MAX_ICT_ITEMS),
    };
  });

  return { success: value?.success !== false, study_count: output.length, studies: output };
}

function compactQuote(value) {
  if (!value) return null;
  const keys = ['symbol', 'time', 'price', 'last', 'close', 'open', 'high', 'low', 'volume', 'bid', 'ask', 'header_price'];
  const result = {};
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) result[key] = value[key];
  }
  return result;
}

function normalizeBars(value, limit) {
  const raw = value?.bars || value?.data || [];
  if (!Array.isArray(raw)) return [];
  return raw.slice(-limit).map((bar) => ({
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume ?? 0,
  }));
}

export function summarizeBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { count: 0, from: null, to: null, high: null, low: null, range: null, change: null, change_pct: null, avg_volume: null };
  }
  const first = bars[0];
  const last = bars[bars.length - 1];
  const high = Math.max(...bars.map((bar) => bar.high));
  const low = Math.min(...bars.map((bar) => bar.low));
  const change = last.close - first.open;
  return {
    count: bars.length,
    from: first.time,
    to: last.time,
    open: first.open,
    close: last.close,
    high,
    low,
    range: high - low,
    change,
    change_pct: first.open ? Math.round((change / first.open) * 10000) / 100 : null,
    avg_volume: Math.round(bars.reduce((sum, bar) => sum + (Number(bar.volume) || 0), 0) / bars.length),
    latest: last,
  };
}

function compactList(value, limit = MAX_ICT_ITEMS) {
  return Array.isArray(value) ? value.slice(-limit) : [];
}

function compactStructureItems(items, limit = MAX_ICT_ITEMS) {
  return compactList(items, limit).map((item) => ({
    type: item?.type,
    price: item?.price,
    time: item?.time,
    level: item?.level,
    brokenAt: item?.brokenAt,
  }));
}

function compactBreaks(items, limit = 8) {
  return compactList(items, limit).map((item) => ({
    type: item?.type,
    level: item?.level,
    brokenAt: item?.brokenAt,
    kind: item?.kind,
  }));
}

function compactFvgs(items) {
  return compactList(items).map((item) => ({
    type: item?.type,
    top: item?.top,
    bottom: item?.bottom,
    leftTime: item?.leftTime,
    rightTime: item?.rightTime,
    mitigated: item?.mitigated,
  }));
}

function compactOrderBlocks(items) {
  return compactList(items, 8).map((item) => ({
    type: item?.type,
    zone: item?.zone,
    formedAt: item?.formedAt,
    bosLevel: item?.bosLevel,
  }));
}

function compactLiquidityItems(items) {
  return compactList(items, 8).map((item) => ({
    level: item?.level,
    times: item?.times,
  }));
}

function compactHunts(items) {
  return compactList(items, 8).map((item) => ({
    type: item?.type,
    time: item?.time,
    level: item?.level,
    prevLevel: item?.prevLevel,
  }));
}

function compactICT(ict) {
  const structure = ict?.structure || { trend: 'range', swings: [], bos: [], choch: [] };
  const fvg = Array.isArray(ict?.fvg) ? ict.fvg : [];
  const orderBlocks = Array.isArray(ict?.orderBlocks) ? ict.orderBlocks : [];
  const liquidity = ict?.liquidity || { equalHighs: [], equalLows: [], bsl: [], ssl: [], hunts: [] };
  return {
    structure: {
      trend: structure.trend,
      swings: compactStructureItems(structure.swings),
      bos: compactBreaks(structure.bos),
      choch: compactBreaks(structure.choch),
    },
    fvg: compactFvgs(fvg),
    orderBlocks: compactOrderBlocks(orderBlocks),
    liquidity: {
      equalHighs: compactLiquidityItems(liquidity.equalHighs),
      equalLows: compactLiquidityItems(liquidity.equalLows),
      bsl: liquidity.bsl || [],
      ssl: liquidity.ssl || [],
      hunts: compactHunts(liquidity.hunts),
    },
    premiumDiscount: ict?.premiumDiscount || null,
    killzones: (ict?.killzones || []).map((zone) => ({
      name: zone?.name,
      from: zone?.from,
      to: zone?.to,
      count: zone?.count ?? zone?.barsInZone ?? 0,
    })),
    meta: {
      ...(ict?.meta || {}),
      fvgCount: fvg.length,
      activeFvgCount: fvg.filter((item) => !item.mitigated).length,
      orderBlockCount: orderBlocks.length,
      bosCount: structure.bos?.length || 0,
      chochCount: structure.choch?.length || 0,
    },
  };
}

function compactDrawings(listValue, propertyBatch) {
  const shapes = listValue?.shapes || listValue?.drawings || [];
  const items = Array.isArray(shapes) ? shapes.slice(0, MAX_DRAWINGS).map((shape) => {
    const id = shape?.id ?? null;
    const prop = id == null ? null : propertyBatch?.values?.['drawing_' + id];
    return {
      id,
      name: shape?.name ?? prop?.name ?? null,
      points: prop?.points ?? shape?.points ?? null,
    };
  }) : [];
  return {
    count: listValue?.count ?? shapes.length,
    items,
    ...(shapes.length > MAX_DRAWINGS ? { truncated: true } : {}),
  };
}

/**
 * Run named functions concurrently and retain per-task timings/errors.
 * Promise.allSettled is intentional: a missing Pine primitive must not
 * discard the quote or OHLCV facts that are still usable.
 */
async function runBatch(tasks, clock) {
  const entries = Object.entries(tasks);
  const taskTimings = {};
  const promises = entries.map(([key, [fn, arg]]) => (async () => {
    const started = clock();
    try {
      return await fn(arg);
    } finally {
      taskTimings[key] = roundMs(clock() - started);
    }
  })());
  const settled = await Promise.allSettled(promises);
  const values = {};
  const errors = {};
  entries.forEach(([key], index) => {
    const result = settled[index];
    if (result.status === 'fulfilled') values[key] = result.value;
    else errors[key] = result.reason?.message || String(result.reason);
  });
  return { values, errors, taskTimings };
}

function readBatch(batch, key, warnings) {
  if (batch.errors[key]) {
    warnings.push(key + ' failed: ' + batch.errors[key]);
    return null;
  }
  return batch.values[key] ?? null;
}

function layoutName(activeLayout) {
  return activeLayout?.active?.layout || activeLayout?.layout || null;
}

/**
 * Fast, read-only current-chart snapshot plus local ICT analysis.
 *
 * Defaults are deliberately narrow: active pane, recent 100 bars, the iFVG
 * table, no user-drawing N+1 reads, no screenshot, and no protected inputs.
 */
export async function analyzeFast({
  study_filter = DEFAULT_FILTER,
  max_bars = DEFAULT_MAX_BARS,
  include_indicators = false,
  include_visuals = false,
  include_drawings = false,
  include_bars = false,
  require_layout,
  _deps,
} = {}) {
  const clock = getClock(_deps);
  const started = clock();
  const limit = clampBars(max_bars);
  const filter = study_filter == null ? DEFAULT_FILTER : String(study_filter);
  const deps = {
    getState: _deps?.getState || chart.getState,
    getActiveLayout: _deps?.getActiveLayout || ui.getActiveLayout,
    getQuote: _deps?.getQuote || data.getQuote,
    getOhlcv: _deps?.getOhlcv || data.getOhlcv,
    getStudyValues: _deps?.getStudyValues || data.getStudyValues,
    getPineTables: _deps?.getPineTables || data.getPineTables,
    getPineLines: _deps?.getPineLines || data.getPineLines,
    getPineLabels: _deps?.getPineLabels || data.getPineLabels,
    getPineBoxes: _deps?.getPineBoxes || data.getPineBoxes,
    listDrawings: _deps?.listDrawings || drawing.listDrawings,
    getProperties: _deps?.getProperties || drawing.getProperties,
  };
  const warnings = [];

  const anchorStarted = clock();
  const anchor = await runBatch({
    state: [deps.getState, {}],
    activeLayout: [deps.getActiveLayout, {}],
    quote: [deps.getQuote, {}],
    ohlcv: [deps.getOhlcv, { count: limit }],
  }, clock);
  const anchorMs = roundMs(clock() - anchorStarted);
  const state = readBatch(anchor, 'state', warnings) || {};
  const activeLayout = readBatch(anchor, 'activeLayout', warnings);
  const quote = readBatch(anchor, 'quote', warnings);
  const bars = normalizeBars(readBatch(anchor, 'ohlcv', warnings), limit);

  const required = require_layout == null ? null : String(require_layout).trim();
  const actualLayout = layoutName(activeLayout);
  if (required && String(actualLayout || '').toLowerCase() !== required.toLowerCase()) {
    throw new Error('Fast analysis requires layout "' + required + '", active layout is "' + (actualLayout || 'unknown') + '". Switch layout explicitly and retry.');
  }

  const auxStarted = clock();
  const auxTasks = {};
  if (include_indicators) auxTasks.studyValues = [deps.getStudyValues, {}];
  if (filter !== null) auxTasks.pineTables = [deps.getPineTables, { study_filter: filter }];
  if (include_visuals) {
    auxTasks.pineLines = [deps.getPineLines, { study_filter: filter }];
    auxTasks.pineLabels = [deps.getPineLabels, { study_filter: filter, max_labels: MAX_PINE_LABELS }];
    auxTasks.pineBoxes = [deps.getPineBoxes, { study_filter: filter }];
  }
  if (include_drawings) auxTasks.listDrawings = [deps.listDrawings, {}];
  const aux = await runBatch(auxTasks, clock);
  const auxMs = roundMs(clock() - auxStarted);

  let propertyBatch = { values: {}, errors: {}, taskTimings: {} };
  let drawingDetailsMs = 0;
  const drawingList = include_drawings ? readBatch(aux, 'listDrawings', warnings) : null;
  if (include_drawings && drawingList) {
    const shapes = drawingList.shapes || drawingList.drawings || [];
    const toFetch = Array.isArray(shapes) ? shapes.slice(0, MAX_DRAWINGS).filter((shape) => shape?.id != null) : [];
    const propertyTasks = Object.fromEntries(toFetch.map((shape) => [
      'drawing_' + shape.id,
      [deps.getProperties, { entity_id: shape.id }],
    ]));
    const detailsStarted = clock();
    propertyBatch = await runBatch(propertyTasks, clock);
    drawingDetailsMs = roundMs(clock() - detailsStarted);
    for (const [key, message] of Object.entries(propertyBatch.errors)) warnings.push(key + ' failed: ' + message);
  }

  const ictStarted = clock();
  const ict = compactICT(analyzeICT({ bars }));
  const localAnalysisMs = roundMs(clock() - ictStarted);
  const tasks = { ...anchor.taskTimings, ...aux.taskTimings, ...propertyBatch.taskTimings };
  const slowest = Object.entries(tasks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([task, duration_ms]) => ({ task, duration_ms }));

  return {
    success: true,
    mode: 'fast_current_chart',
    symbol: state.symbol || quote?.symbol || null,
    timeframe: state.resolution || state.timeframe || null,
    active_layout: activeLayout?.active || activeLayout || null,
    quote: compactQuote(quote),
    summary: summarizeBars(bars),
    recent_bars: bars.slice(-MAX_RECENT_BARS),
    pine: filter === null ? null : {
      filter,
      tables: compactPine(readBatch(aux, 'pineTables', warnings), 'tables', filter),
      ...(include_visuals ? {
        lines: compactPine(readBatch(aux, 'pineLines', warnings), 'lines', filter),
        labels: compactPine(readBatch(aux, 'pineLabels', warnings), 'labels', filter),
        boxes: compactPine(readBatch(aux, 'pineBoxes', warnings), 'boxes', filter),
      } : {}),
    },
    indicators: include_indicators ? compactIndicatorValues(readBatch(aux, 'studyValues', warnings), filter) : null,
    drawings: include_drawings ? compactDrawings(drawingList, propertyBatch) : { enabled: false, count: 0, items: [] },
    ict,
    ...(include_bars ? { bars } : {}),
    warnings,
    timings_ms: {
      total: roundMs(clock() - started),
      anchor: anchorMs,
      auxiliary: auxMs,
      drawing_properties: drawingDetailsMs,
      local_analysis: localAnalysisMs,
      tasks,
      slowest,
    },
    meta: {
      max_bars: limit,
      study_filter: filter,
      include_indicators,
      include_visuals,
      include_drawings,
      include_bars,
      one_connection_batch: true,
    },
  };
}

export { DEFAULT_FILTER, DEFAULT_MAX_BARS };
