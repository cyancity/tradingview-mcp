/**
 * Copilot Analyzer — 编排 time + context + ict + 通用分析 + 报告
 */
import { parseTimeSemantics, findBarBySemantics } from './time.js';
import { collectFacts } from './context.js';
import { analyzeICT } from './ict.js';

// ---------- helpers ----------
function detectMultiTimeframeNeed(question = '', time = '') {
  const hay = `${question} ${time}`.toLowerCase();
  const keywords = ['多周期', '多时间', 'htf', 'ltf', 'higher timeframe', 'lower timeframe', '日线', '周线', '4h', '1h', '15m', '1d', '4小时', '小时级别', '分钟级别'];
  return keywords.some(k => hay.includes(k.toLowerCase()));
}

function formatNY(utcSeconds) {
  if (!utcSeconds) return '—';
  try {
    const d = new Date(utcSeconds * 1000);
    const ny = new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
    const utc = new Date(utcSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    return `${ny} NY / ${utc}`;
  } catch {
    return new Date(utcSeconds * 1000).toISOString();
  }
}

function calcRR(entry, stop, take) {
  if (entry == null || stop == null || take == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(take - entry);
  if (risk === 0) return null;
  return { risk: Number(risk.toFixed(8)), reward: Number(reward.toFixed(8)), rr: Number((reward / risk).toFixed(2)) };
}

// generic drawing analysis
function analyzeGeneric(facts) {
  const drawings = facts?.drawings?.items || facts?.drawings || [];
  const bars = facts?.bars || [];
  const result = { rectangles: [], trends: [], positions: [], horizontals: [] };
  const atr = (() => {
    if (!bars.length) return 1;
    let trs = [];
    for (let i = 1; i < bars.length; i++) trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
    const s = trs.slice(-14);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 1;
  })();

  for (const d of drawings) {
    const name = (d.name || '').toLowerCase();
    const pts = d.points || d.properties?.points || [];
    if (name.includes('rectangle') || d.name === 'rectangle') {
      if (pts.length >= 2) {
        const high = Math.max(pts[0].price, pts[1].price);
        const low = Math.min(pts[0].price, pts[1].price);
        // count bars inside
        const inside = bars.filter(b => b.high <= high && b.low >= low).length;
        const touched = bars.filter(b => b.low <= high && b.high >= low).length;
        result.rectangles.push({ id: d.id, high, low, points: pts, insideCount: inside, touchedCount: touched });
      }
    } else if (name.includes('trend') || name.includes('ray') || name.includes('arrow')) {
      if (pts.length >= 2) {
        const [p1, p2] = pts;
        const slope = (p2.price - p1.price) / ((p2.time - p1.time) || 1);
        let touches = 0;
        let breaks = 0;
        for (const b of bars) {
          if (b.time < p1.time) continue;
          const expected = p1.price + slope * (b.time - p1.time);
          const dist = Math.min(Math.abs(b.high - expected), Math.abs(b.low - expected), Math.abs(b.close - expected));
          if (dist < atr * 0.25) touches++;
          if ((slope > 0 && b.close < expected - atr * 0.5) || (slope < 0 && b.close > expected + atr * 0.5)) {
            // potential break after touches
          }
        }
        // break: last bar close beyond line
        if (bars.length) {
          const last = bars[bars.length - 1];
          const expLast = p1.price + slope * (last.time - p1.time);
          if ((slope >= 0 && last.close < expLast) || (slope < 0 && last.close > expLast)) breaks = 1;
        }
        result.trends.push({ id: d.id, name: d.name, slope: Number(slope.toExponential(3)), points: pts, touches, breaks, valid: touches >= 2 });
      }
    } else if (name.includes('long') || name.includes('short')) {
      if (pts.length >= 3) {
        const entry = pts[0].price;
        const stop = pts[1].price;
        const take = pts[2].price;
        const rr = calcRR(entry, stop, take);
        result.positions.push({ id: d.id, name: d.name, entry, stop, take, rr, points: pts });
      } else if (pts.length === 2) {
        result.positions.push({ id: d.id, name: d.name, points: pts, note: '仅2点，无法计算RR，需3点(entry/stop/take)' });
      }
    } else if (name.includes('horizontal')) {
      if (pts[0]) {
        const level = pts[0].price;
        const touches = bars.filter(b => Math.abs(b.high - level) < atr * 0.15 || Math.abs(b.low - level) < atr * 0.15 || Math.abs(b.close - level) < atr * 0.15).length;
        result.horizontals.push({ id: d.id, level, touches, points: pts });
      }
    }
  }
  return result;
}

export function buildVisualDrawings(ictResult, facts) {
  const drawings = [];
  if (!ictResult) return drawings;
  // FVG → rectangle半透明
  for (const f of (ictResult.fvg || []).slice(0, 5)) {
    if (f.mitigation) continue;
    // only unmitigated
    if (f.mitigated) continue;
    const color = f.type === 'bull' ? 'rgba(0, 200, 83, 0.18)' : 'rgba(255, 61, 0, 0.18)';
    drawings.push({
      shape: 'rectangle',
      points: [{ time: f.leftTime, price: f.top }, { time: f.rightTime, price: f.bottom }],
      overrides: JSON.stringify({ color, backgroundColor: color, linewidth: 1 }),
      meta: { kind: 'fvg', type: f.type, source: f },
    });
  }
  // OB → rectangle橙色
  for (const ob of (ictResult.orderBlocks || []).slice(0, 5)) {
    const color = ob.type === 'bull' ? 'rgba(255, 165, 0, 0.20)' : 'rgba(0, 122, 255, 0.20)';
    // OB zone high/low, time from formedAt to formedAt+ 5 bars (approx)
    const t1 = ob.formedAt;
    const t2 = ob.formedAt + 5 * 3600; // 5 hours approx, will be within chart range
    drawings.push({
      shape: 'rectangle',
      points: [{ time: t1, price: ob.zone.high }, { time: t2, price: ob.zone.low }],
      overrides: JSON.stringify({ color, backgroundColor: color }),
      meta: { kind: 'ob', type: ob.type, source: ob },
    });
  }
  // Liquidity → horizontal_line
  const liq = ictResult.liquidity;
  if (liq) {
    for (const lvl of [...(liq.bsl || []).slice(0, 2), ...(liq.ssl || []).slice(0, 2)]) {
      // need time: use last bar time
      const lastTime = facts?.bars?.[facts.bars.length - 1]?.time || Math.floor(Date.now() / 1000);
      drawings.push({
        shape: 'horizontal_line',
        points: [{ time: lastTime, price: lvl }],
        overrides: JSON.stringify({ linecolor: '#9C27B0', linewidth: 1, linestyle: 2 }),
        meta: { kind: 'liquidity', level: lvl },
      });
    }
  }
  return drawings;
}

function buildReport({ facts, ictResult, genericResult, timeRange, question, warnings }) {
  const symbol = facts?.symbol || facts?.state?.symbol || '—';
  const timeframe = facts?.timeframe || facts?.state?.resolution || '—';
  const bars = facts?.bars || [];
  const drawings = facts?.drawings?.items || facts?.drawings || [];
  const quote = facts?.quote || {};
  const lines = [];
  const label = timeRange?.label || '当前视口';
  lines.push(`# Trading Copilot 分析报告 — ${symbol} ${timeframe} · ${label}`);
  lines.push('');
  // Facts
  lines.push(`## 1. 事实摘要`);
  lines.push(`- 品种/周期: **${symbol} / ${timeframe}**`);
  lines.push(`- 区间: ${timeRange?.from ? formatNY(timeRange.from) : '—'} → ${timeRange?.to ? formatNY(timeRange.to) : '—'} (${timeRange?.confidence || '—'} 置信度)`);
  if (timeRange?.warnings?.length) lines.push(`  - ⚠️ 时间解析提示: ${timeRange.warnings.join('; ')}`);
  lines.push(`- K线: ${bars.length} 根，${bars.length ? `高 ${Math.max(...bars.map(b=>b.high))} / 低 ${Math.min(...bars.map(b=>b.low))} / 最新收 ${bars[bars.length-1]?.close}` : '无数据'}`);
  if (bars.length) {
    const last5 = bars.slice(-5).map(b => `  - ${new Date(b.time*1000).toISOString().slice(0,16)} O${b.open} H${b.high} L${b.low} C${b.close} V${b.volume ?? '—'}`).join('\n');
    lines.push(`- 最近5根:\n${last5}`);
  }
  lines.push(`- 绘图: ${Array.isArray(drawings) ? drawings.length : 0} 个（矩形/趋势线/射线/Long/Short）`);
  if (genericResult) {
    if (genericResult.rectangles.length) lines.push(`  - 矩形: ${genericResult.rectangles.map(r=> `[${r.low.toFixed(2)}-${r.high.toFixed(2)}] 触碰${r.touchedCount}根`).join(', ')}`);
    if (genericResult.trends.length) lines.push(`  - 趋势线/射线: ${genericResult.trends.map(t=> `${t.name||'trend'} 斜率${t.slope} 触碰${t.touches}次 ${t.valid?'有效':'待确认'}`).join('; ')}`);
    if (genericResult.positions.length) lines.push(`  - 仓位: ${genericResult.positions.map(p=> `${p.name||p.id} 入场${p.entry} 止损${p.stop} 止盈${p.take} RR=${p.rr?.rr ?? '—'}`).join('; ')}`);
  }
  const indCount = facts?.indicators?.count ?? facts?.indicators?.values ? Object.keys(facts.indicators.values||{}).length : 0;
  lines.push(`- 指标: ${indCount || '—'} 个`);
  if (facts?.indicators?.values) {
    const vals = Object.entries(facts.indicators.values).slice(0, 5).map(([k,v])=> `${k}:${typeof v==='object'?JSON.stringify(v):v}`).join(', ');
    if (vals) lines.push(`  - 读数: ${vals}`);
  }
  lines.push(`- 实时价: ${quote?.price ?? quote?.last ?? '—'}`);
  if (warnings?.length) lines.push(`- ⚠️ 数据警告: ${warnings.join('; ')}`);
  lines.push('');

  // ICT
  if (ictResult) {
    lines.push(`## 2. ICT 解读`);
    const s = ictResult.structure;
    lines.push(`- 市场结构: **${s.trend}** (swings ${s.swings.length} / BOS ${s.bos.length} / CHoCH ${s.choch.length})`);
    if (s.bos.length) lines.push(`  - BOS: ${s.bos.map(b=> `${b.type} 突破 ${b.level} 于 ${new Date(b.brokenAt*1000).toISOString().slice(0,16)}`).join('; ')}`);
    if (s.choch.length) lines.push(`  - CHoCH: ${s.choch.map(b=> `${b.type} 反转 ${b.level} 于 ${new Date(b.brokenAt*1000).toISOString().slice(0,16)}`).join('; ')}`);
    if (ictResult.fvg.length) lines.push(`- FVG: ${ictResult.fvg.map(f=> `${f.type} [${f.bottom.toFixed(2)}-${f.top.toFixed(2)}] ${f.mitigated?'已回补':'未回补'} (${new Date(f.leftTime*1000).toISOString().slice(0,10)})`).join('; ')}`);
    else lines.push(`- FVG: 无显著缺口`);
    if (ictResult.orderBlocks.length) lines.push(`- 订单块 OB: ${ictResult.orderBlocks.map(o=> `${o.type} [${o.zone.low.toFixed(2)}-${o.zone.high.toFixed(2)}] 形成于 ${new Date(o.formedAt*1000).toISOString().slice(0,16)}`).join('; ')}`);
    else lines.push(`- 订单块 OB: 无`);
    const liq = ictResult.liquidity;
    if (liq) {
      lines.push(`- 流动性: 等高 ${liq.equalHighs.length} / 等低 ${liq.equalLows.length} / BSL ${liq.bsl.slice(0,3).join(', ')} / SSL ${liq.ssl.slice(0,3).join(', ')}`);
      if (liq.hunts.length) lines.push(`  - 扫损: ${liq.hunts.map(h=> `${h.type} @${h.level} 索引${h.index}`).join('; ')}`);
    }
    const pd = ictResult.premiumDiscount;
    if (pd?.equilibrium) lines.push(`- 溢价/折扣: 平衡 ${pd.equilibrium.toFixed(2)} | 折扣 [${pd.discountZone.low.toFixed(2)}-${pd.discountZone.high.toFixed(2)}] | 溢价 [${pd.premiumZone.low.toFixed(2)}-${pd.premiumZone.high.toFixed(2)}] | OTE多 ${pd.oteBull.low.toFixed(2)}-${pd.oteBull.high.toFixed(2)} / 空 ${pd.oteBear.low.toFixed(2)}-${pd.oteBear.high.toFixed(2)}`);
    if (ictResult.killzones.length) lines.push(`- Killzone: ${ictResult.killzones.map(k=> `${k.name} ${k.count}根`).join(', ')}`);
    lines.push('');
  } else {
    lines.push(`## 2. 通用解读`);
    lines.push(`- 已走通用路径（未启用 ICT）`);
    lines.push('');
  }

  // Question association
  lines.push(`## 3. 与问题关联`);
  lines.push(`> 用户问题: “${question}”`);
  lines.push('');
  if (ictResult) {
    // simple heuristic: echo question and tie to ict
    if (question.includes('流动性') || question.toLowerCase().includes('liquidity')) {
      lines.push(`- 流动性视角: BSL ${ictResult.liquidity.bsl.slice(0,3).join(', ')} 为上方流动性，SSL ${ictResult.liquidity.ssl.slice(0,3).join(', ')} 为下方；等高/等低处易扫损，注意猎取风险。`);
    }
    if (question.includes('FVG') || question.toLowerCase().includes('fvg') || question.includes('缺口')) {
      lines.push(`- FVG视角: ${ictResult.fvg.length? ictResult.fvg.map(f=> `${f.type} ${f.bottom}-${f.top} ${f.mitigated?'已回补':'未回补'}`).join('; ') : '当前区间无显著 FVG'}`);
    }
    if (question.includes('矩形') || question.includes('区间')) {
      lines.push(`- 矩形/区间: ${genericResult.rectangles.length? `用户绘制 ${genericResult.rectangles.length} 个矩形，结合 ICT 的 Premium/Discount 判断：当前价 ${bars[bars.length-1]?.close} 处于 ${bars[bars.length-1]?.close > ictResult.premiumDiscount.equilibrium ? '溢价' : '折扣'}区` : '未检测到矩形绘图'}`);
    }
    // bias
    const bias = ictResult.structure.trend === 'bull' ? '偏多' : ictResult.structure.trend === 'bear' ? '偏空' : '中性/震荡';
    const conf = ictResult.structure.bos.length >=2 ? 'high' : ictResult.structure.bos.length===1 ? 'med' : 'low';
    lines.push(`- 结构倾向: **${bias}** (置信度 ${conf}) — 证据: BOS ${ictResult.structure.bos.length} / CHoCH ${ictResult.structure.choch.length} / FVG ${ictResult.fvg.filter(f=>!f.mitigated).length} 未回补`);
  } else {
    lines.push(`- 通用分析已基于绘图与K线事实给出，详见上文。`);
  }
  lines.push('');

  // Visual
  lines.push(`## 4. 视觉标记`);
  lines.push(`- 建议回写: FVG ${ictResult?.fvg?.filter(f=>!f.mitigated).length || 0} 个矩形、OB ${ictResult?.orderBlocks?.length || 0} 个矩形、流动性水平线 ${(ictResult?.liquidity?.bsl?.length||0)+(ictResult?.liquidity?.ssl?.length||0)} 条（详见 drawingsToCreate）`);
  lines.push(`- 回写后请截图核对：文字报告的 top/bottom 必须等于绘图 points 价格，否则视为 bug`);
  lines.push('');

  // Disclaimer
  lines.push(`## 5. 风险与免责`);
  lines.push(`> 本分析仅基于历史K线、指标与绘图事实，不构成投资建议。市场有风险，入市需谨慎。所有判断均标注置信度与证据来源，低置信度结论请结合其他信息验证。Bias 仅为结构倾向，非交易指令。`);
  lines.push(`> 数据来源: TradingView Desktop CDP 实时读取，指标与绘图需在图表可见时才可获取。`);
  lines.push('');
  if (timeRange?.from) lines.push(`*时间基准: ${formatNY(timeRange.from)} → ${formatNY(timeRange.to)} · 引擎: ICT ${ictResult?'已启用':'未启用'} · 周期: ${timeframe}*`);

  return lines.join('\n');
}

export async function analyze({ question, time, use_ict = true, include_drawings = true, include_indicators = true, max_bars = 200, create_visuals = true, _deps } = {}) {
  if (!question || typeof question !== 'string' || !question.trim()) throw new Error('question 不能为空');

  const warnings = [];
  // 1) 初步时间解析（无 bars）
  let timeRange = null;
  try {
    const ctx0 = { now: Math.floor(Date.now() / 1000) };
    // try to get visibleRange if available via deps
    if (_deps?.getVisibleRange) {
      try { ctx0.visibleRange = await _deps.getVisibleRange({}); } catch {}
    }
    timeRange = parseTimeSemantics(time || question, ctx0);
  } catch (e) {
    warnings.push(`time parse failed: ${e.message}`);
    timeRange = { from: null, to: null, label: '解析失败-将用视口', confidence: 'low', warnings };
  }

  // 2) 事实抽取
  const facts = await collectFacts({
    timeRange: timeRange?.from ? timeRange : null,
    includeDrawings: include_drawings,
    includeIndicators: include_indicators,
    maxBars: max_bars,
    _deps,
  });
  if (facts.warnings?.length) warnings.push(...facts.warnings);

  // 3) 单根语义二次解析（有 bars 后）
  if (facts.bars?.length) {
    const needSingle = /(大阳|大阴|长影|放量|大阳线|大阴线|单根|某一根)/.test(`${question} ${time||''}`);
    if (needSingle) {
      const hit = findBarBySemantics(facts.bars, `${question} ${time||''}`);
      if (hit) {
        timeRange.anchorBarIndex = hit.index;
        timeRange.anchorBar = hit.bar;
        // narrow to that bar
        // keep original from/to but note anchor
      }
    }
    // if timeRange failed but we have bars, fallback to visible bars range
    if (!timeRange.from && facts.bars.length) {
      timeRange.from = facts.bars[0].time;
      timeRange.to = facts.bars[facts.bars.length - 1].time;
      timeRange.label = `兜底: 最近${facts.bars.length}根`;
      timeRange.confidence = 'low';
    }
  }

  // 4) 多周期按需
  let htfFacts = null;
  if (detectMultiTimeframeNeed(question, time)) {
    if (_deps?.getOhlcvForTimeframe || _deps?.getHTFBars) {
      try {
        const fn = _deps.getOhlcvForTimeframe || _deps.getHTFBars;
        htfFacts = await fn({ timeframe: '240' });
        warnings.push('多周期: 已拉取 HTF 数据');
      } catch (e) {
        warnings.push(`多周期拉取失败: ${e.message}`);
      }
    } else {
      warnings.push('多周期: 检测到多周期需求，但未提供 HTF 拉取能力，已用当前周期分析');
    }
  }

  // 5) ICT
  let ictResult = null;
  if (use_ict) {
    try { ictResult = analyzeICT(facts); } catch (e) { warnings.push(`ICT失败: ${e.message}`); }
  }
  void htfFacts;

  // 6) Generic
  let genericResult = null;
  try { genericResult = analyzeGeneric(facts); } catch (e) { warnings.push(`通用分析失败: ${e.message}`); }

  // 7) Visual
  let drawingsToCreate = [];
  if (create_visuals && ictResult) {
    try { drawingsToCreate = buildVisualDrawings(ictResult, facts); } catch (e) { warnings.push(`视觉生成失败: ${e.message}`); }
  }

  // 8) Report
  const report = buildReport({ facts, ictResult, genericResult, timeRange, question, warnings });

  return {
    success: true,
    report,
    facts,
    ict: ictResult,
    generic: genericResult,
    timeRange,
    drawingsToCreate,
    warnings,
    meta: { symbol: facts.symbol || null, timeframe: facts.timeframe || null, bars: facts.bars?.length || 0, use_ict, include_drawings, include_indicators, max_bars },
  };
}
