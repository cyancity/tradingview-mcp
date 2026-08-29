import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, buildVisualDrawings } from '../src/core/copilot/analyzer.js';
import { analyzeICT } from '../src/core/copilot/ict.js';

function mkBar(time, open, high, low, close, volume = 1000) { return { time, open, high, low, close, volume }; }

function mockDeps() {
  const bars = [];
  let t = 1723000000;
  for (let i = 0; i < 10; i++) bars.push(mkBar(t + i * 86400, 100 + i, 105 + i, 95 + i, 102 + i));
  // make one bull FVG: bars[0].low 95+? actually need low > high gap; craft explicit
  bars[0] = mkBar(t, 100, 110, 105, 107);
  bars[1] = mkBar(t + 86400, 107, 108, 106, 107);
  bars[2] = mkBar(t + 86400 * 2, 102, 104, 100, 101);
  return {
    getState: async () => ({ symbol: 'BINANCE:BTCUSDT', resolution: '60' }),
    getVisibleRange: async () => ({ from: bars[0].time, to: bars[bars.length - 1].time, count: bars.length }),
    getOhlcv: async ({ count }) => ({ bars: bars.slice(-count), count: bars.length }),
    getStudyValues: async () => ({ count: 1, values: { 'RSI': 65 } }),
    getPineLines: async () => [],
    getPineLabels: async () => [],
    getPineBoxes: async () => [],
    getPineTables: async () => [],
    listDrawings: async () => ({ success: true, count: 2, shapes: [{ id: '1', name: 'rectangle' }, { id: '2', name: 'trend_line' }] }),
    getProperties: async ({ entity_id }) => {
      if (entity_id === '1') return { success: true, entity_id, points: [{ time: bars[0].time, price: 100 }, { time: bars[2].time, price: 110 }], name: 'rectangle' };
      return { success: true, entity_id, points: [{ time: bars[0].time, price: 100 }, { time: bars[5].time, price: 110 }], name: 'trend_line' };
    },
    getQuote: async () => ({ price: 105 }),
    _bars: bars,
  };
}

describe('analyzer.analyze', () => {
  it('基础 成功且报告含关键段落', async () => {
    const deps = mockDeps();
    const r = await analyze({ question: '分析这个矩形内流动性', time: '最近50根', use_ict: true, _deps: deps });
    assert.equal(r.success, true);
    assert.ok(r.report.includes('Trading Copilot'));
    assert.ok(r.report.includes('事实摘要'));
    assert.ok(r.report.includes('ICT 解读'));
    assert.ok(r.report.includes('免责') || r.report.includes('不构成'));
    assert.ok(r.report.includes('流动性') || r.ict);
    assert.ok(Array.isArray(r.drawingsToCreate));
    // 视觉一致性：每个 drawing 的 price 等于 ict fvg top/bottom
    if (r.ict && r.ict.fvg.length) {
      const fvg = r.ict.fvg.find(f => !f.mitigated);
      if (fvg) {
        const rect = r.drawingsToCreate.find(d => d.meta && d.meta.kind === 'fvg');
        if (rect) {
          assert.equal(rect.points[0].price, fvg.top);
          assert.equal(rect.points[1].price, fvg.bottom);
        }
      }
    }
  });

  it('use_ict=false 走通用', async () => {
    const deps = mockDeps();
    const r = await analyze({ question: '支撑阻力怎么看', use_ict: false, _deps: deps });
    assert.equal(r.success, true);
    assert.ok(r.report.includes('通用') || r.generic);
    assert.equal(r.ict, null);
  });

  it('多周期 warnings', async () => {
    const deps = mockDeps();
    const r = await analyze({ question: '多周期怎么看 日线结构', _deps: deps });
    assert.ok(r.warnings.some(w => w.includes('多周期')));
  });

  it('单根语义 anchorBarIndex', async () => {
    const deps = mockDeps();
    // bars 中第二根是大阳，question 含大阳线
    const r = await analyze({ question: '大阳线怎么看', _deps: deps });
    assert.equal(r.success, true);
    // anchorBarIndex 可能有值（若 findBar命中）
    assert.ok(r.timeRange);
  });

  it('空 question 抛错', async () => {
    const deps = mockDeps();
    await assert.rejects(() => analyze({ question: '', _deps: deps }), /question/);
  });
});

describe('buildVisualDrawings 严格一致', () => {
  it('FVG/OB 价格严格相等', () => {
    const bars = [];
    let t = 1723000000;
    for (let i = 0; i < 10; i++) bars.push(mkBar(t + i * 3600, 100, 105, 95, 102));
    bars[0] = mkBar(t, 100, 110, 105, 107);
    bars[1] = mkBar(t + 3600, 107, 108, 106, 107);
    bars[2] = mkBar(t + 7200, 102, 104, 100, 101);
    const facts = { bars };
    const ict = analyzeICT(facts);
    // inject at least one unmitigated FVG
    if (ict.fvg.length === 0) {
      ict.fvg = [{ type: 'bull', top: 105, bottom: 104, leftTime: t, rightTime: t + 7200, leftIndex: 0, rightIndex: 2, mitigated: false }];
    } else {
      ict.fvg[0].mitigated = false;
    }
    ict.orderBlocks = [{ type: 'bull', zone: { high: 110, low: 105 }, formedAt: t, formedIndex: 0 }];
    const drawings = buildVisualDrawings(ict, facts);
    const fvgDraw = drawings.find(d => d.meta.kind === 'fvg');
    assert.ok(fvgDraw);
    assert.equal(fvgDraw.points[0].price, ict.fvg.find(f=>!f.mitigated).top);
    assert.equal(fvgDraw.points[1].price, ict.fvg.find(f=>!f.mitigated).bottom);
    const obDraw = drawings.find(d => d.meta.kind === 'ob');
    assert.equal(obDraw.points[0].price, 110);
    assert.equal(obDraw.points[1].price, 105);
  });
});
