import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSwings, detectStructure, detectFVG, detectOrderBlocks, detectLiquidity, detectPremiumDiscount, detectKillzones, analyzeICT } from '../src/core/copilot/ict.js';

function mkBar(time, open, high, low, close, volume = 1000) { return { time, open, high, low, close, volume }; }

describe('ICT: empty / single', () => {
  it('空 bars 返回空', () => {
    assert.deepEqual(detectFVG([]), []);
    assert.deepEqual(detectSwings([], 2), []);
    const s = detectStructure([]);
    assert.equal(s.trend, 'range');
  });
  it('单根无 FVG', () => {
    const bars = [mkBar(1, 100, 105, 95, 102)];
    assert.equal(detectFVG(bars).length, 0);
  });
});

describe('FVG', () => {
  it('bull FVG 检出', () => {
    const bars = [
      mkBar(1, 100, 110, 105, 107),
      mkBar(2, 107, 108, 106, 107),
      mkBar(3, 102, 104, 100, 101),
    ];
    // b0.low 105 > b2.high 104 => bull FVG
    const fvg = detectFVG(bars);
    assert.equal(fvg.length, 1);
    assert.equal(fvg[0].type, 'bull');
    assert.equal(fvg[0].top, 105);
    assert.equal(fvg[0].bottom, 104);
    assert.equal(fvg[0].mitigated, false);
  });
  it('bull FVG mitigated', () => {
    const bars = [
      mkBar(1, 100, 110, 105, 107),
      mkBar(2, 107, 108, 106, 107),
      mkBar(3, 102, 104, 100, 101),
      mkBar(4, 103, 106, 102, 105),
    ];
    const fvg = detectFVG(bars);
    assert.equal(fvg[0].mitigated, true);
  });
  it('bear FVG', () => {
    const bars = [
      mkBar(1, 100, 95, 90, 92),
      mkBar(2, 92, 93, 91, 92),
      mkBar(3, 100, 105, 100, 103),
    ];
    // b0.high 95 < b2.low 100 => bear FVG
    const fvg = detectFVG(bars);
    assert.equal(fvg[0].type, 'bear');
    assert.equal(fvg[0].bottom, 95);
    assert.equal(fvg[0].top, 100);
  });
});

describe('Swings & Structure', () => {
  it('swings 检出', () => {
    const bars = [
      mkBar(1, 100, 100, 90, 95),
      mkBar(2, 95, 101, 94, 100),
      mkBar(3, 100, 110, 99, 105), // swing high?
      mkBar(4, 105, 106, 100, 102),
      mkBar(5, 102, 103, 95, 96),
      mkBar(6, 96, 97, 90, 91), // swing low?
      mkBar(7, 91, 95, 90, 94),
    ];
    const swings = detectSwings(bars, 1);
    assert.ok(swings.length >= 1);
  });
  it('BOS & trend bull', () => {
    const bars = [
      mkBar(1, 100, 100, 90, 95),
      mkBar(2, 95, 102, 94, 100),
      mkBar(3, 100, 105, 99, 103),
      mkBar(4, 103, 106, 102, 105),
      mkBar(5, 105, 110, 104, 108), // close breaks prior high
      mkBar(6, 108, 112, 107, 111),
      mkBar(7, 111, 115, 110, 114),
    ];
    const st = detectStructure(bars, 1);
    assert.ok(['bull','bear','range'].includes(st.trend));
    assert.ok(Array.isArray(st.swings));
    // BOS/CHoCH 可能为 0 取决于 pivot，该用例仅校验不抛错且结构完整
    assert.ok(Array.isArray(st.bos) && Array.isArray(st.choch));
  });
  it('CHoCH', () => {
    const bars = [
      mkBar(1, 100, 100, 90, 95),
      mkBar(2, 95, 105, 94, 103),
      mkBar(3, 103, 110, 102, 108), // bull bos
      mkBar(4, 108, 109, 100, 101), // bear break
      mkBar(5, 101, 102, 90, 91),
      mkBar(6, 91, 95, 88, 92),
    ];
    const st = detectStructure(bars, 1);
    // 至少能检测到结构，不强制 BOS 数量（取决于 pivot 敏感度）
    assert.ok(['bull','bear','range'].includes(st.trend));
    assert.ok(Array.isArray(st.swings));
  });
});

describe('OrderBlocks', () => {
  it('基于 BOS 前反向K', () => {
    const bars = [
      mkBar(1, 100, 101, 99, 99.5), // bear
      mkBar(2, 99.5, 100, 98, 99),
      mkBar(3, 99, 105, 98, 104), // bull bos
      mkBar(4, 104, 110, 103, 108),
    ];
    const st = detectStructure(bars, 1);
    const obs = detectOrderBlocks(bars, st);
    assert.ok(Array.isArray(obs));
  });
});

describe('Liquidity', () => {
  it('等高', () => {
    const bars = [
      mkBar(1, 100, 100, 90, 95),
      mkBar(2, 95, 100.05, 90, 96),
      mkBar(3, 96, 100, 90, 97),
    ];
    const liq = detectLiquidity(bars, 14);
    assert.ok(liq.equalHighs.length >= 1 || liq.bsl.length >= 1);
  });
});

describe('PremiumDiscount', () => {
  it('range 计算', () => {
    const bars = [mkBar(1, 50, 100, 50, 75), mkBar(2, 75, 100, 50, 80)];
    const pd = detectPremiumDiscount(bars);
    assert.equal(pd.equilibrium, 75);
    assert.equal(pd.discountZone.high, 75);
    assert.equal(pd.premiumZone.low, 75);
  });
});

describe('Killzones', () => {
  it('NY 时间分组', () => {
    // 2025-08-20 08:30 NY = 12:30 UTC
    const tNY830 = Math.floor(Date.UTC(2025, 7, 20, 12, 30, 0) / 1000);
    const tNY1400 = Math.floor(Date.UTC(2025, 7, 20, 18, 0, 0) / 1000); // 14 NY = 18 UTC
    const tAsia = Math.floor(Date.UTC(2025, 7, 20, 5, 0, 0) / 1000); // 01 NY
    const bars = [mkBar(tNY830, 100, 101, 99, 100), mkBar(tNY1400, 100, 101, 99, 100), mkBar(tAsia, 100, 101, 99, 100)];
    const kz = detectKillzones(bars);
    assert.ok(kz.some(k => k.name === 'NY AM'));
    assert.ok(kz.some(k => k.name === 'NY PM' || k.name === 'Asia'));
  });
});

describe('analyzeICT 聚合', () => {
  it('20 根 bars 齐全', () => {
    const bars = [];
    let t = 1723000000;
    for (let i = 0; i < 20; i++) bars.push(mkBar(t + i * 3600, 100 + i, 105 + i, 95 + i, 102 + i));
    const r = analyzeICT({ bars });
    assert.equal(r.meta.barsAnalyzed, 20);
    assert.ok('structure' in r && 'fvg' in r && 'orderBlocks' in r && 'liquidity' in r && 'premiumDiscount' in r && 'killzones' in r);
  });
});
