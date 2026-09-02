import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFast, compactIndicatorValues, summarizeBars } from '../src/core/copilot/fast.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bars(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    time: 1723000000 + index * 3600,
    open: 100 + index,
    high: 105 + index,
    low: 95 + index,
    close: 102 + index,
    volume: 1000 + index,
  }));
}

function deps(overrides = {}) {
  const data = bars();
  return {
    getState: async () => ({ symbol: 'CME_MINI:MNQ1!', resolution: '30', studies: [] }),
    getActiveLayout: async () => ({ success: true, active: { layout: 'StrategyTester' } }),
    getQuote: async () => ({ success: true, symbol: 'CME_MINI:MNQ1!', last: 111 }),
    getOhlcv: async () => ({ success: true, bars: data }),
    getPineTables: async () => ({ success: true, study_count: 1, studies: [{ name: 'YOLO iFVG Model', tables: [{ rows: ['Setup | LONG', 'Entry | 110'] }] }] }),
    getPineLines: async () => ({ success: true, studies: [{ name: 'YOLO iFVG Model', total_lines: 1, horizontal_levels: [110] }] }),
    getPineLabels: async () => ({ success: true, studies: [{ name: 'YOLO iFVG Model', total_labels: 1, labels: [{ text: 'Entry', price: 110 }] }] }),
    getPineBoxes: async () => ({ success: true, studies: [{ name: 'YOLO iFVG Model', total_boxes: 1, zones: [{ high: 111, low: 110 }] }] }),
    getStudyValues: async () => ({ success: true, studies: [{ id: 'secret', name: 'YOLO iFVG Model', inputs: { text: 'protected blob' }, values: { RSI: 55 } }] }),
    listDrawings: async () => ({ success: true, count: 1, shapes: [{ id: 'shape-1', name: 'rectangle' }] }),
    getProperties: async () => ({ success: true, name: 'rectangle', points: [{ time: data[0].time, price: 100 }, { time: data[1].time, price: 110 }], properties: { secret: 'omit' } }),
    ...overrides,
  };
}

describe('copilot fast path', () => {
  it('并发 anchor/aux，默认不触发慢路径', async () => {
    let active = 0;
    let maxActive = 0;
    const tracked = (fn) => async (arg) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try { await wait(10); return fn(arg); } finally { active--; }
    };
    const base = deps();
    const r = await analyzeFast({ _deps: Object.fromEntries(Object.entries(base).map(([key, fn]) => [key, tracked(fn)])) });
    assert.equal(r.success, true);
    assert.ok(maxActive >= 3, 'expected concurrent reads, saw ' + maxActive);
    assert.equal(r.meta.one_connection_batch, true);
    assert.equal(r.drawings.enabled, false);
    assert.equal(r.pine.tables.studies.length, 1);
    assert.equal(r.indicators, null);
    assert.ok(r.timings_ms.slowest.length > 0);
  });

  it('可按需并发 visuals/indicators/drawings，并去掉保护性输入', async () => {
    const r = await analyzeFast({ include_visuals: true, include_indicators: true, include_drawings: true, include_bars: true, _deps: deps() });
    assert.equal(r.bars.length, 12);
    assert.equal(r.pine.lines.studies.length, 1);
    assert.equal(r.pine.labels.studies.length, 1);
    assert.equal(r.pine.boxes.studies.length, 1);
    assert.equal(r.indicators.studies[0].values.RSI, 55);
    assert.equal('inputs' in r.indicators.studies[0], false);
    assert.equal(r.drawings.items[0].points[1].price, 110);
    assert.equal('properties' in r.drawings.items[0], false);
  });

  it('layout guard 只校验、不自动切换', async () => {
    await assert.rejects(
      () => analyzeFast({ require_layout: 'iFVG', _deps: deps() }),
      /requires layout "iFVG"/,
    );
  });

  it('纯函数摘要和指标脱敏稳定', () => {
    const data = bars(2);
    assert.equal(summarizeBars(data).count, 2);
    assert.equal(summarizeBars(data).high, 106);
    const compact = compactIndicatorValues({ studies: [{ name: 'YOLO iFVG', inputs: { text: 'secret' }, values: { Entry: 100 } }] }, 'ifvg');
    assert.deepEqual(compact.studies[0].values, { Entry: 100 });
    assert.equal('inputs' in compact.studies[0], false);
  });
});
