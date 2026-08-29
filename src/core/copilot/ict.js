/**
 * ICT 分析引擎 — 纯函数，无 CDP 依赖
 * 6 模块：结构/FVG/OB/流动性/Premium-Discount/Killzone
 */

// ---------- helpers ----------
function atr(bars, period = 14) {
  if (!bars || bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  if (!slice.length) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ---------- 1. Swings ----------
export function detectSwings(bars, pivot = 2) {
  if (!bars || bars.length < pivot * 2 + 1) return [];
  const swings = [];
  for (let i = pivot; i < bars.length - pivot; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= pivot; j++) {
      if (bars[i - j].high >= h || bars[i + j].high >= h) isHigh = false;
      if (bars[i - j].low <= l || bars[i + j].low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, time: bars[i].time, price: h, type: 'high' });
    if (isLow) swings.push({ index: i, time: bars[i].time, price: l, type: 'low' });
  }
  swings.sort((a, b) => a.index - b.index);
  return swings;
}

// ---------- 2. Structure BOS/CHoCH ----------
export function detectStructure(bars, pivot = 2) {
  const swings = detectSwings(bars, pivot);
  const bos = [];
  const choch = [];
  if (!bars || bars.length < 2 || swings.length < 2) {
    return { trend: 'range', swings, bos, choch };
  }
  // track last broken high/low
  let trend = 'range';
  let lastHigh = null;
  let lastLow = null;
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  // iterate bars to check breaks
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].close;
    // check high break
    if (highs.length) {
      const prevHigh = highs.filter(h => h.index < i).pop();
      if (prevHigh && c > prevHigh.price) {
        const already = bos.some(b => b.level === prevHigh.price && b.brokenAt === bars[i].time);
        if (!already) {
          const entry = { type: 'bull', level: prevHigh.price, brokenAt: bars[i].time, index: i, swingIndex: prevHigh.index };
          // if previous trend was bear, this is CHoCH
          if (trend === 'bear') choch.push({ ...entry, kind: 'choch' });
          else bos.push(entry);
          trend = 'bull';
          lastHigh = prevHigh.price;
        }
      }
    }
    // check low break
    if (lows.length) {
      const prevLow = lows.filter(l => l.index < i).pop();
      if (prevLow && c < prevLow.price) {
        const already = bos.some(b => b.level === prevLow.price && b.brokenAt === bars[i].time);
        const alreadyC = choch.some(b => b.level === prevLow.price && b.brokenAt === bars[i].time);
        if (!already && !alreadyC) {
          const entry = { type: 'bear', level: prevLow.price, brokenAt: bars[i].time, index: i, swingIndex: prevLow.index };
          if (trend === 'bull') choch.push({ ...entry, kind: 'choch' });
          else bos.push(entry);
          trend = 'bear';
          lastLow = prevLow.price;
        }
      }
    }
  }
  void lastHigh; void lastLow;
  return { trend, swings, bos, choch };
}

// ---------- 3. FVG ----------
export function detectFVG(bars) {
  if (!bars || bars.length < 3) return [];
  const fvgs = [];
  for (let i = 0; i < bars.length - 2; i++) {
    const b0 = bars[i];
    const b2 = bars[i + 2];
    // bull FVG: b0.low > b2.high (gap up)
    if (b0.low > b2.high) {
      const top = b0.low;
      const bottom = b2.high;
      // check mitigated: any later bar low <= top and high >= bottom (price revisits)
      let mitigated = false;
      for (let j = i + 3; j < bars.length; j++) {
        if (bars[j].low <= top && bars[j].high >= bottom) { mitigated = true; break; }
        if (bars[j].low < bottom) break; // fully covered? keep simple: any overlap = mitigated
      }
      // deduplicate overlapping: if overlaps previous FVG skip
      const last = fvgs[fvgs.length - 1];
      if (last && last.type === 'bull' && Math.abs(last.top - top) < 1e-8 && Math.abs(last.bottom - bottom) < 1e-8) continue;
      fvgs.push({ type: 'bull', top, bottom, leftTime: b0.time, rightTime: b2.time, leftIndex: i, rightIndex: i + 2, mitigated });
    }
    // bear FVG: b0.high < b2.low
    if (b0.high < b2.low) {
      const bottom = b0.high;
      const top = b2.low;
      let mitigated = false;
      for (let j = i + 3; j < bars.length; j++) {
        if (bars[j].low <= top && bars[j].high >= bottom) { mitigated = true; break; }
      }
      const last = fvgs[fvgs.length - 1];
      if (last && last.type === 'bear' && Math.abs(last.top - top) < 1e-8 && Math.abs(last.bottom - bottom) < 1e-8) continue;
      fvgs.push({ type: 'bear', top, bottom, leftTime: b0.time, rightTime: b2.time, leftIndex: i, rightIndex: i + 2, mitigated });
    }
  }
  return fvgs;
}

// ---------- 4. Order Blocks ----------
export function detectOrderBlocks(bars, structure) {
  if (!bars || bars.length < 5) return [];
  const src = structure || detectStructure(bars);
  const events = [...(src.bos || []), ...(src.choch || [])].sort((a, b) => a.index - b.index);
  const obs = [];
  for (const ev of events) {
    const idx = ev.index;
    // look back up to 5 bars for last opposite candle
    const isBull = ev.type === 'bull';
    let found = null;
    for (let k = idx - 1; k >= Math.max(0, idx - 5); k--) {
      const b = bars[k];
      const isBearCandle = b.close < b.open;
      const isBullCandle = b.close > b.open;
      if (isBull && isBearCandle) { found = b; break; }
      if (!isBull && isBullCandle) { found = b; break; }
    }
    if (found) {
      const zone = { high: found.high, low: found.low };
      // avoid duplicates
      if (obs.some(o => o.zone.high === zone.high && o.zone.low === zone.low)) continue;
      obs.push({ type: isBull ? 'bull' : 'bear', zone, formedAt: found.time, formedIndex: bars.indexOf(found), bosIndex: idx, bosLevel: ev.level });
    }
  }
  return obs;
}

// ---------- 5. Liquidity ----------
export function detectLiquidity(bars, atrPeriod = 14) {
  if (!bars || bars.length < 3) return { equalHighs: [], equalLows: [], bsl: [], ssl: [], hunts: [] };
  const a = atr(bars, atrPeriod) || 1;
  const thresh = a * 0.2;
  const equalHighs = [];
  const equalLows = [];
  // sliding window 10
  const win = 10;
  for (let i = 0; i < bars.length; i++) {
    for (let j = i + 1; j < Math.min(bars.length, i + win); j++) {
      if (Math.abs(bars[i].high - bars[j].high) < thresh) {
        const level = (bars[i].high + bars[j].high) / 2;
        if (!equalHighs.some(e => Math.abs(e.level - level) < thresh)) {
          equalHighs.push({ level, indices: [i, j], times: [bars[i].time, bars[j].time] });
        }
      }
      if (Math.abs(bars[i].low - bars[j].low) < thresh) {
        const level = (bars[i].low + bars[j].low) / 2;
        if (!equalLows.some(e => Math.abs(e.level - level) < thresh)) {
          equalLows.push({ level, indices: [i, j], times: [bars[i].time, bars[j].time] });
        }
      }
    }
  }
  // BSL/SSL: recent swing highs/lows as liquidity pools
  const swings = detectSwings(bars, 2);
  const recentHighs = swings.filter(s => s.type === 'high').slice(-5).map(s => s.price);
  const recentLows = swings.filter(s => s.type === 'low').slice(-5).map(s => s.price);
  const bsl = [...new Set([...equalHighs.map(e => e.level), ...recentHighs])].sort((x, y) => y - x).slice(0, 5);
  const ssl = [...new Set([...equalLows.map(e => e.level), ...recentLows])].sort((x, y) => x - y).slice(0, 5);

  // Stop hunts: long upper wick piercing prior high then close back
  const hunts = [];
  for (let i = 2; i < bars.length; i++) {
    const b = bars[i];
    const body = Math.abs(b.close - b.open) || 1;
    const upperWick = b.high - Math.max(b.open, b.close);
    const lowerWick = Math.min(b.open, b.close) - b.low;
    const prevHigh = Math.max(...bars.slice(Math.max(0, i - 5), i).map(x => x.high));
    const prevLow = Math.min(...bars.slice(Math.max(0, i - 5), i).map(x => x.low));
    if (upperWick > 2 * body && b.high > prevHigh && b.close < prevHigh) {
      hunts.push({ type: 'buy_hunt', index: i, time: b.time, level: b.high, prevLevel: prevHigh });
    }
    if (lowerWick > 2 * body && b.low < prevLow && b.close > prevLow) {
      hunts.push({ type: 'sell_hunt', index: i, time: b.time, level: b.low, prevLevel: prevLow });
    }
  }

  return { equalHighs, equalLows, bsl, ssl, hunts };
}

// ---------- 6. Premium / Discount ----------
export function detectPremiumDiscount(bars) {
  if (!bars || bars.length < 2) return { discountZone: null, premiumZone: null, oteBull: null, oteBear: null, equilibrium: null };
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const range = rangeHigh - rangeLow || 1;
  const mid = (rangeHigh + rangeLow) / 2;
  const discountZone = { low: rangeLow, high: mid };
  const premiumZone = { low: mid, high: rangeHigh };
  // OTE 62-79% fib of range
  const oteBull = { low: rangeLow + range * 0.62, high: rangeLow + range * 0.79 }; // retrace in bull
  const oteBear = { low: rangeHigh - range * 0.79, high: rangeHigh - range * 0.62 };
  return { discountZone, premiumZone, oteBull, oteBear, equilibrium: mid, rangeHigh, rangeLow, range };
}

// ---------- 7. Killzones ----------
function isDSTByUTCms(utcMs) {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const getSecondSundayMarch = (yy) => {
    const dow = new Date(Date.UTC(yy, 2, 1)).getUTCDay();
    const first = 1 + ((7 - dow) % 7);
    return first + 7;
  };
  const getFirstSundayNov = (yy) => {
    const dow = new Date(Date.UTC(yy, 10, 1)).getUTCDay();
    return 1 + ((7 - dow) % 7);
  };
  const second = getSecondSundayMarch(y);
  const first = getFirstSundayNov(y);
  const start = Date.UTC(y, 2, second, 7, 0, 0);
  const end = Date.UTC(y, 10, first, 6, 0, 0);
  return utcMs >= start && utcMs < end;
}

function utcToNYHourMin(utcSeconds) {
  const utcMs = utcSeconds * 1000;
  const isDST = isDSTByUTCms(utcMs);
  const offsetMin = isDST ? -240 : -300;
  const nyMs = utcMs + offsetMin * 60 * 1000;
  const d = new Date(nyMs);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), isDST };
}

export function detectKillzones(bars) {
  if (!bars || bars.length === 0) return [];
  const groups = {
    'London': [],
    'NY AM': [],
    'NY PM': [],
    'Asia': [],
  };
  for (let i = 0; i < bars.length; i++) {
    const { h, m } = utcToNYHourMin(bars[i].time);
    const minutes = h * 60 + m;
    // NY AM Killzone 08:00-11:00 ET, London 07:00-10:00 ET, NY PM 13:30-16:00 ET
    // classify with priority NY AM > London > NY PM
    if (minutes >= 8 * 60 && minutes < 11 * 60) groups['NY AM'].push(i);
    else if (minutes >= 7 * 60 && minutes < 10 * 60) groups['London'].push(i);
    else if (minutes >= 13 * 60 + 30 && minutes < 16 * 60) groups['NY PM'].push(i);
    else groups['Asia'].push(i);
  }
  const out = [];
  for (const [name, indices] of Object.entries(groups)) {
    if (!indices.length) continue;
    const times = indices.map(i => bars[i].time);
    out.push({ name, from: Math.min(...times), to: Math.max(...times), indices, count: indices.length, barsInZone: indices.length });
  }
  return out;
}

// ---------- Aggregate ----------
export function analyzeICT(facts) {
  const bars = facts?.bars || facts || [];
  if (!Array.isArray(bars) || bars.length === 0) {
    return { structure: { trend: 'range', swings: [], bos: [], choch: [] }, fvg: [], orderBlocks: [], liquidity: { equalHighs: [], equalLows: [], bsl: [], ssl: [], hunts: [] }, premiumDiscount: detectPremiumDiscount(bars), killzones: [], meta: { barsAnalyzed: 0, swingCount: 0 } };
  }
  const structure = detectStructure(bars);
  const fvg = detectFVG(bars);
  const orderBlocks = detectOrderBlocks(bars, structure);
  const liquidity = detectLiquidity(bars);
  const premiumDiscount = detectPremiumDiscount(bars);
  const killzones = detectKillzones(bars);
  return {
    structure,
    fvg,
    orderBlocks,
    liquidity,
    premiumDiscount,
    killzones,
    meta: { barsAnalyzed: bars.length, swingCount: structure.swings.length },
  };
}
