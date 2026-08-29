import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeSemantics, findBarBySemantics } from '../src/core/copilot/time.js';

// fixed reference now: 2025-08-20 12:00 NY
const refNow = Math.floor(Date.UTC(2025, 7, 20, 16, 0, 0) / 1000); // 12 NY = 16 UTC (EDT)
const visibleRange = { from: 1723000000, to: 1724000000 };

function mkBars(n = 10) {
  const bars = [];
  let t = 1723000000;
  for (let i = 0; i < n; i++) {
    bars.push({ time: t + i * 86400, open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i, volume: 1000 + i * 100 });
  }
  return bars;
}

describe('parseTimeSemantics', () => {
  it('显式 ISO 日期 2025-08-20', () => {
    const r = parseTimeSemantics('2025-08-20', { now: refNow });
    assert.equal(typeof r.from, 'number');
    assert.equal(typeof r.to, 'number');
    assert.ok(r.to > r.from);
    assert.ok(r.label.includes('2025-08-20'));
    assert.equal(r.confidence, 'high');
  });

  it('区间 中文 到', () => {
    const r = parseTimeSemantics('2025-08-01到2025-08-15', { now: refNow });
    assert.ok(r.from < r.to);
    assert.ok(r.label.includes('到'));
    assert.equal(r.confidence, 'high');
  });

  it('区间 英文 to', () => {
    const r = parseTimeSemantics('2025-08-01 to 2025-08-15', { now: refNow });
    assert.ok(r.from < r.to);
    assert.equal(r.confidence, 'high');
  });

  it('区间 hyphen -', () => {
    const r = parseTimeSemantics('2025-08-01 - 2025-08-15', { now: refNow });
    assert.ok(r.from < r.to);
    assert.equal(r.confidence, 'high');
  });

  it('最近50根 无 bars 兜底日历', () => {
    const r = parseTimeSemantics('最近50根', { now: refNow });
    assert.equal(typeof r.from, 'number');
    assert.equal(typeof r.to, 'number');
    assert.ok(r.label.includes('50'));
  });

  it('最近50根 有 bars', () => {
    const bars = mkBars(60);
    const r = parseTimeSemantics('最近50根', { now: refNow, bars });
    assert.equal(r.from, bars[10].time);
    assert.equal(r.to, bars[59].time);
    assert.equal(r.anchorBarIndex, 10);
  });

  it('近7天', () => {
    const r = parseTimeSemantics('近7天', { now: refNow });
    assert.equal(typeof r.from, 'number');
    assert.equal(typeof r.to, 'number');
  });

  it('last 20 bars 英文', () => {
    const bars = mkBars(30);
    const r = parseTimeSemantics('last 20 bars', { now: refNow, bars });
    assert.equal(r.from, bars[10].time);
  });

  it('上周', () => {
    const r = parseTimeSemantics('上周', { now: refNow });
    assert.equal(typeof r.from, 'number');
    assert.ok(r.label.includes('上周') || r.label.includes('week'));
  });

  it('昨天', () => {
    const r = parseTimeSemantics('昨天', { now: refNow });
    assert.equal(typeof r.from, 'number');
    assert.ok(r.to > r.from);
  });

  it('今天', () => {
    const r = parseTimeSemantics('今天', { now: refNow });
    assert.equal(typeof r.from, 'number');
  });

  it('纽约开盘', () => {
    const r = parseTimeSemantics('纽约开盘', { now: refNow });
    assert.equal(typeof r.from, 'number');
    assert.equal(typeof r.to, 'number');
  });

  it('NY open 英文', () => {
    const r = parseTimeSemantics('NY open', { now: refNow });
    assert.equal(typeof r.from, 'number');
  });

  it('空串 兜底 visibleRange', () => {
    const r = parseTimeSemantics('', { now: refNow, visibleRange });
    assert.equal(r.from, visibleRange.from);
    assert.equal(r.to, visibleRange.to);
    assert.equal(r.confidence, 'low');
  });

  it('非法串 兜底', () => {
    const r = parseTimeSemantics('@@@', { now: refNow, visibleRange });
    assert.equal(r.confidence, 'low');
  });

  it('非字符串 兜底', () => {
    const r = parseTimeSemantics(null, { now: refNow, visibleRange });
    assert.equal(r.confidence, 'low');
  });

  it('DST 边界 2025-03-09', () => {
    const before = parseTimeSemantics('2025-03-09', { now: refNow });
    const after = parseTimeSemantics('2025-03-10', { now: refNow });
    assert.notEqual(before.from, after.from);
  });
});

describe('findBarBySemantics', () => {
  it('大阳线', () => {
    const bars = [
      { time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
      { time: 2, open: 100, high: 110, low: 100, close: 109, volume: 2000 },
      { time: 3, open: 100, high: 101, low: 99, close: 99.5, volume: 1000 },
    ];
    const hit = findBarBySemantics(bars, '大阳线');
    assert.equal(hit.index, 1);
  });

  it('大阴线', () => {
    const bars = [
      { time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
      { time: 2, open: 110, high: 110, low: 100, close: 101, volume: 2000 },
      { time: 3, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
    ];
    const hit = findBarBySemantics(bars, '大阴线');
    assert.equal(hit.index, 1);
  });

  it('放量', () => {
    const bars = [
      { time: 1, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { time: 2, open: 100, high: 101, low: 99, close: 100, volume: 9000 },
      { time: 3, open: 100, high: 101, low: 99, close: 100, volume: 1100 },
    ];
    const hit = findBarBySemantics(bars, '放量');
    assert.equal(hit.index, 1);
  });

  it('长上影', () => {
    const bars = [
      { time: 1, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { time: 2, open: 100, high: 115, low: 99, close: 101, volume: 1000 },
      { time: 3, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    ];
    const hit = findBarBySemantics(bars, '长上影');
    assert.equal(hit.index, 1);
  });

  it('无匹配返回 null', () => {
    const bars = [{ time: 1, open: 100, high: 101, low: 99, close: 100, volume: 1000 }];
    const hit = findBarBySemantics(bars, '无关描述');
    assert.equal(hit, null);
  });
});
