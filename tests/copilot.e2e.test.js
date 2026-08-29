import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeSemantics } from '../src/core/copilot/time.js';
import { collectFacts } from '../src/core/copilot/context.js';
import { analyzeICT } from '../src/core/copilot/ict.js';
import { analyze, buildVisualDrawings } from '../src/core/copilot/analyzer.js';
import { getCatalog, registerTools } from '../src/tools/registry.js';
import { readFileSync, existsSync } from 'node:fs';

describe('copilot e2e — 无 TV 集成', () => {
  it('全链路：time → facts → ict → analyzer → report 含 disclaimer', async () => {
    const bars = [];
    let t = 1723000000;
    for (let i = 0; i < 20; i++) bars.push({ time: t + i * 3600, open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i, volume: 1000 });
    // 制造 FVG
    bars[0] = { time: t, open: 100, high: 110, low: 105, close: 107, volume: 1000 };
    bars[1] = { time: t + 3600, open: 107, high: 108, low: 106, close: 107, volume: 1000 };
    bars[2] = { time: t + 7200, open: 102, high: 104, low: 100, close: 101, volume: 1000 };

    const mock = {
      getState: async () => ({ symbol: 'BINANCE:BTCUSDT', resolution: '60' }),
      getVisibleRange: async () => ({ from: bars[0].time, to: bars[bars.length - 1].time }),
      getOhlcv: async () => ({ bars }),
      getStudyValues: async () => ({ count: 1, values: { RSI: 55 } }),
      getPineLines: async () => [],
      getPineLabels: async () => [],
      getPineBoxes: async () => [],
      getPineTables: async () => [],
      listDrawings: async () => ({ success: true, count: 1, shapes: [{ id: '1', name: 'rectangle' }] }),
      getProperties: async () => ({ success: true, entity_id: '1', points: [{ time: t, price: 100 }, { time: t + 7200, price: 110 }], name: 'rectangle' }),
      getQuote: async () => ({ price: 105 }),
    };
    const time = parseTimeSemantics('最近10根', { bars, now: 1723100000 });
    assert.ok(time.from);

    const facts = await collectFacts({ timeRange: time, maxBars: 20, _deps: mock });
    assert.equal(facts.bars.length, 10);

    const ict = analyzeICT(facts);
    assert.ok(ict.structure);

    const res = await analyze({ question: '分析流动性和FVG', time: '最近10根', _deps: mock });
    assert.equal(res.success, true);
    assert.ok(res.report.includes('本分析仅基于'));
    assert.ok(res.report.includes('Trading Copilot'));
    assert.ok(Array.isArray(res.drawingsToCreate));
  });

  it('视觉一致性：FVG top/bottom == drawing points 价格', async () => {
    let t = 1723000000;
    const bars = [];
    for (let i = 0; i < 10; i++) bars.push({ time: t + i * 3600, open: 100, high: 105, low: 95, close: 102, volume: 1000 });
    bars[0] = { time: t, open: 100, high: 110, low: 105, close: 107, volume: 1000 };
    bars[1] = { time: t + 3600, open: 107, high: 108, low: 106, close: 107, volume: 1000 };
    bars[2] = { time: t + 7200, open: 102, high: 104, low: 100, close: 101, volume: 1000 };
    const facts = { bars };
    const ict = analyzeICT(facts);
    // 保证有未回补 FVG
    if (!ict.fvg.some(f => !f.mitigated)) {
      ict.fvg.push({ type: 'bull', top: 105, bottom: 104, leftTime: t, rightTime: t + 7200, leftIndex: 0, rightIndex: 2, mitigated: false });
    }
    ict.orderBlocks = [{ type: 'bull', zone: { high: 110, low: 105 }, formedAt: t }];

    const drawings = buildVisualDrawings(ict, facts);
    for (const d of drawings.filter(x => x.meta.kind === 'fvg')) {
      const src = d.meta.source;
      assert.equal(d.points[0].price, src.top);
      assert.equal(d.points[1].price, src.bottom);
      // 误差 <1e-8
      assert.ok(Math.abs(d.points[0].price - src.top) < 1e-8);
    }
    for (const d of drawings.filter(x => x.meta.kind === 'ob')) {
      const src = d.meta.source;
      assert.equal(d.points[0].price, src.zone.high);
      assert.equal(d.points[1].price, src.zone.low);
    }
  });

  it('CLI 注册：copilot analyze 已注册', async () => {
    const catalog = getCatalog();
    assert.ok(catalog.some(t => t.name === 'copilot_analyze'));
    // 检查 registry 注册
    const server = { tools: [], tool(name, desc, schema, handler) { this.tools.push(name); } };
    const { registered } = registerTools(server, {});
    assert.ok(registered >= 46);
    assert.ok(server.tools.includes('copilot_analyze'));
  });

  it('SKILL.md 关键段落', () => {
    const path = 'skills/trading-copilot/SKILL.md';
    assert.ok(existsSync(path), 'SKILL.md 必须存在');
    const c = readFileSync(path, 'utf8');
    for (const kw of ['Step 0', 'Step 1', 'copilot_analyze', '一致性校验', '免责']) {
      assert.ok(c.includes(kw), `SKILL.md 缺少 ${kw}`);
    }
  });
});
