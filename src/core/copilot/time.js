/**
 * src/core/copilot/time.js
 * 语义时间解析 — 纯函数，无 CDP 依赖
 * 时区：America/New_York (EDT UTC-4 / EST UTC-5)
 * DST：3月第二个周日 02:00 - 11月第一个周日 02:00 为 EDT，其余 EST
 */

/* ---------- NY 时区工具 ---------- */

function getSecondSundayMarch(year) {
  const dow = new Date(Date.UTC(year, 2, 1)).getUTCDay(); // 0 Sun
  const firstSunday = 1 + ((7 - dow) % 7);
  return firstSunday + 7;
}

function getFirstSundayNov(year) {
  const dow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - dow) % 7);
  return firstSunday;
}

function isNYDSTWall(year, month, day, hour = 0) {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  if (month === 3) {
    const second = getSecondSundayMarch(year);
    if (day < second) return false;
    if (day > second) return true;
    // same day: 02:00 jump
    return hour >= 2;
  }
  // month === 11
  const first = getFirstSundayNov(year);
  if (day < first) return true;
  if (day > first) return false;
  return hour < 2;
}

function isDSTByUTCms(utcMs) {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const second = getSecondSundayMarch(y);
  const first = getFirstSundayNov(y);
  const start = Date.UTC(y, 2, second, 7, 0, 0);
  const end = Date.UTC(y, 10, first, 6, 0, 0);
  return utcMs >= start && utcMs < end;
}

function nyWallToUTCSeconds(year, month, day, hour = 0, minute = 0, second = 0) {
  const isDST = isNYDSTWall(year, month, day, hour);
  const offsetMin = isDST ? -240 : -300;
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const utcMs = wallMs - offsetMin * 60 * 1000;
  return Math.floor(utcMs / 1000);
}

function utcToNYWall(utcSeconds) {
  const utcMs = utcSeconds * 1000;
  const isDST = isDSTByUTCms(utcMs);
  const offsetMin = isDST ? -240 : -300;
  const nyMs = utcMs + offsetMin * 60 * 1000;
  const d = new Date(nyMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    isDST
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getReferenceNY(ctx) {
  let nowSec;
  const raw = ctx && ctx.now != null ? ctx.now : null;
  if (raw instanceof Date) nowSec = Math.floor(raw.getTime() / 1000);
  else if (typeof raw === 'number') {
    nowSec = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    nowSec = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  } else {
    nowSec = Math.floor(Date.now() / 1000);
  }
  const ny = utcToNYWall(nowSec);
  return { nowSec, ny };
}

function addDaysToNY(ny, delta) {
  const base = Date.UTC(ny.year, ny.month - 1, ny.day);
  const ms = base + delta * 86400000;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function nyDayStart(y, m, d) {
  return nyWallToUTCSeconds(y, m, d, 0, 0, 0);
}
function nyDayEnd(y, m, d) {
  return nyWallToUTCSeconds(y, m, d, 23, 59, 59);
}

/* ---------- 辅助：findBarBySemantics ---------- */

/**
 * 根据描述在 bars 中寻找最匹配的单根 K 线
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume?:number}>} bars
 * @param {string} desc
 * @returns {{index:number, bar:any, type:string}|null}
 */
export function findBarBySemantics(bars, desc) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  if (!desc || typeof desc !== 'string') return null;
  const s = desc.toLowerCase();
  const orig = desc;

  const contains = (keywords) => keywords.some((k) => s.includes(k.toLowerCase()) || orig.includes(k));

  // 判断类型，优先级：bearish > bullish > upper > lower > volume > doji
  let type = null;
  if (contains(['大阴线', '大阴', '阴线', '长阴', 'bearish', 'big bearish', 'large bearish'])) type = 'bearish';
  else if (contains(['大阳线', '大阳', '阳线', '长阳', '中阳', '光头阳', 'bullish', 'big bullish', 'large bullish'])) type = 'bullish';
  else if (contains(['长上影', '上影线', '上影', 'upper shadow', 'upper wick', 'long upper'])) type = 'upper';
  else if (contains(['长下影', '下影线', '下影', 'lower shadow', 'lower wick', 'long lower'])) type = 'lower';
  else if (contains(['放量', '高成交量', '高量', '大量', '爆量', '巨量', 'volume spike', 'high volume', 'huge volume'])) type = 'volume';
  else if (contains(['十字星', 'doji', '十字'])) type = 'doji';
  else if (contains(['放量', '大阳', '大阴', '上影', '下影'])) type = 'volume'; // fallback generic
  else return null;

  let bestIdx = -1;

  if (type === 'bullish') {
    let maxBody = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.close == null || b.open == null || b.high == null || b.low == null) continue;
      const isBull = b.close > b.open;
      if (!isBull) continue;
      const body = Math.abs(b.close - b.open);
      const range = b.high - b.low;
      const score = range > 0 ? body / range : body;
      // prefer larger body ratio, tie break by body
      const composite = score * 1000 + body;
      if (composite > maxBody) {
        maxBody = composite;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      // fallback to any max body
      let maxAny = -Infinity;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const body = Math.abs((b.close ?? 0) - (b.open ?? 0));
        if (body > maxAny) { maxAny = body; bestIdx = i; }
      }
    }
  } else if (type === 'bearish') {
    let maxBody = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.close == null || b.open == null || b.high == null || b.low == null) continue;
      const isBear = b.close < b.open;
      if (!isBear) continue;
      const body = Math.abs(b.close - b.open);
      const range = b.high - b.low;
      const score = range > 0 ? body / range : body;
      const composite = score * 1000 + body;
      if (composite > maxBody) {
        maxBody = composite;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      let maxAny = -Infinity;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const body = Math.abs((b.close ?? 0) - (b.open ?? 0));
        if (body > maxAny) { maxAny = body; bestIdx = i; }
      }
    }
  } else if (type === 'upper') {
    let maxUpper = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.high == null || b.open == null || b.close == null || b.low == null) continue;
      const upper = b.high - Math.max(b.open, b.close);
      const range = b.high - b.low;
      const ratio = range > 0 ? upper / range : 0;
      const composite = ratio * 1000 + upper;
      if (composite > maxUpper) {
        maxUpper = composite;
        bestIdx = i;
      }
    }
  } else if (type === 'lower') {
    let maxLower = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.low == null || b.open == null || b.close == null || b.high == null) continue;
      const lower = Math.min(b.open, b.close) - b.low;
      const range = b.high - b.low;
      const ratio = range > 0 ? lower / range : 0;
      const composite = ratio * 1000 + lower;
      if (composite > maxLower) {
        maxLower = composite;
        bestIdx = i;
      }
    }
  } else if (type === 'volume') {
    let maxVol = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const vol = b.volume ?? 0;
      if (vol > maxVol) {
        maxVol = vol;
        bestIdx = i;
      }
    }
    // if all zero, fallback to largest range (proxy for volume)
    if (maxVol <= 0) {
      let maxRange = -Infinity;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const range = (b.high ?? 0) - (b.low ?? 0);
        if (range > maxRange) { maxRange = range; bestIdx = i; }
      }
    }
  } else if (type === 'doji') {
    let minBodyRatio = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.high == null || b.low == null || b.open == null || b.close == null) continue;
      const body = Math.abs(b.close - b.open);
      const range = b.high - b.low;
      const ratio = range > 0 ? body / range : 1;
      if (ratio < minBodyRatio) {
        minBodyRatio = ratio;
        bestIdx = i;
      }
    }
  }

  if (bestIdx === -1) return null;
  return { index: bestIdx, bar: bars[bestIdx], type };
}

/* ---------- 主函数：parseTimeSemantics ---------- */

/**
 * 解析语义化时间输入
 * @param {string} input - 用户输入
 * @param {{now?:number|Date, timeframe?:string, visibleRange?:{from:number,to:number}, bars?:Array}} ctx
 * @returns {{from:number|null,to:number|null,anchorBarIndex:number|null,label:string,confidence:'high'|'med'|'low',warnings:string[]}}
 */
export function parseTimeSemantics(input, ctx = {}) {
  const warnings = [];
  const ctxSafe = ctx || {};
  const visibleRange = ctxSafe.visibleRange;
  const bars = ctxSafe.bars;

  const makeFallback = (extra) => {
    if (extra) warnings.push(extra);
    if (!warnings.includes('fallback to visible range')) warnings.push('fallback to visible range');
    const hasRange = visibleRange && typeof visibleRange.from === 'number' && typeof visibleRange.to === 'number';
    return {
      from: hasRange ? visibleRange.from : (visibleRange?.from ?? null),
      to: hasRange ? visibleRange.to : (visibleRange?.to ?? null),
      anchorBarIndex: null,
      label: hasRange ? 'fallback:visibleRange' : 'fallback',
      confidence: 'low',
      warnings: [...warnings]
    };
  };

  // branch 1: 非字符串
  if (typeof input !== 'string') {
    return makeFallback('invalid input type');
  }
  const trimmed = input.trim();
  // branch 2: 空字符串
  if (!trimmed) {
    return makeFallback('empty input');
  }
  const lower = trimmed.toLowerCase();
  const { ny: refNY } = getReferenceNY(ctxSafe);

  // ---------- 1) 区间：到 / 至 ----------
  // branch 3: 中文 到/至
  if (trimmed.includes('到') || trimmed.includes('至')) {
    const m = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?\s*(?:到|至)\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (m) {
      let y1 = Number(m[1]); let mo1 = Number(m[2]); let d1 = Number(m[3]);
      let h1 = m[4] != null ? Number(m[4]) : null; let mi1 = m[5] != null ? Number(m[5]) : 0; let s1 = m[6] != null ? Number(m[6]) : 0;
      let y2 = Number(m[7]); let mo2 = Number(m[8]); let d2 = Number(m[9]);
      let h2 = m[10] != null ? Number(m[10]) : null; let mi2 = m[11] != null ? Number(m[11]) : 0; let s2 = m[12] != null ? Number(m[12]) : 0;
      if (mo1 >= 1 && mo1 <= 12 && mo2 >= 1 && mo2 <= 12 && d1 >= 1 && d1 <= daysInMonth(y1, mo1) && d2 >= 1 && d2 <= daysInMonth(y2, mo2)) {
        // handle reversed interval: compare start vs end
        const startOrder = Date.UTC(y1, mo1-1, d1, h1 ?? 0, mi1, s1);
        const endOrder = Date.UTC(y2, mo2-1, d2, h2 ?? 0, mi2, s2);
        if (startOrder > endOrder) {
          let ty=y1, tmo=mo1, td=d1, th=h1, tmi=mi1, ts=s1;
          y1=y2; mo1=mo2; d1=d2; h1=h2; mi1=mi2; s1=s2;
          y2=ty; mo2=tmo; d2=td; h2=th; mi2=tmi; s2=ts;
          warnings.push('swapped interval');
        }
        let from, to;
        if (h1 != null) from = nyWallToUTCSeconds(y1, mo1, d1, h1, mi1, s1);
        else from = nyDayStart(y1, mo1, d1);
        if (h2 != null) to = nyWallToUTCSeconds(y2, mo2, d2, h2, mi2, s2);
        else to = nyDayEnd(y2, mo2, d2);
        return { from, to, anchorBarIndex: null, label: `interval:${y1}-${String(mo1).padStart(2,'0')}-${String(d1).padStart(2,'0')}到${y2}-${String(mo2).padStart(2,'0')}-${String(d2).padStart(2,'0')}`, confidence: 'high', warnings };
      }
    }
  }

  // branch 4: 英文 to
  if (/\bto\b/i.test(trimmed)) {
    const m = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?\s+to\s+(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/i);
    if (m) {
      let y1 = Number(m[1]); let mo1 = Number(m[2]); let d1 = Number(m[3]);
      let h1 = m[4] != null ? Number(m[4]) : null; let mi1 = m[5] != null ? Number(m[5]) : 0; let s1 = m[6] != null ? Number(m[6]) : 0;
      let y2 = Number(m[7]); let mo2 = Number(m[8]); let d2 = Number(m[9]);
      let h2 = m[10] != null ? Number(m[10]) : null; let mi2 = m[11] != null ? Number(m[11]) : 0; let s2 = m[12] != null ? Number(m[12]) : 0;
      if (mo1 >= 1 && mo1 <= 12 && mo2 >= 1 && mo2 <= 12 && d1 >= 1 && d1 <= daysInMonth(y1, mo1) && d2 >= 1 && d2 <= daysInMonth(y2, mo2)) {
        const startOrder = Date.UTC(y1, mo1-1, d1, h1 ?? 0, mi1, s1);
        const endOrder = Date.UTC(y2, mo2-1, d2, h2 ?? 0, mi2, s2);
        if (startOrder > endOrder) {
          let ty=y1, tmo=mo1, td=d1, th=h1, tmi=mi1, ts=s1;
          y1=y2; mo1=mo2; d1=d2; h1=h2; mi1=mi2; s1=s2;
          y2=ty; mo2=tmo; d2=td; h2=th; mi2=tmi; s2=ts;
          warnings.push('swapped interval');
        }
        let from, to;
        if (h1 != null) from = nyWallToUTCSeconds(y1, mo1, d1, h1, mi1, s1);
        else from = nyDayStart(y1, mo1, d1);
        if (h2 != null) to = nyWallToUTCSeconds(y2, mo2, d2, h2, mi2, s2);
        else to = nyDayEnd(y2, mo2, d2);
        return { from, to, anchorBarIndex: null, label: `interval:${y1}-${String(mo1).padStart(2,'0')}-${String(d1).padStart(2,'0')} to ${y2}-${String(mo2).padStart(2,'0')}-${String(d2).padStart(2,'0')}`, confidence: 'high', warnings };
      }
    }
  }

  // branch 5: hyphen - / — / –
  if (/(\d{4})[-/](\d{1,2})[-/](\d{1,2}).*[-—–].*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.test(trimmed)) {
    // avoid matching single date internal hyphen by requiring separator between two full dates
    const m = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?\s*[-—–]\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (m) {
      // ensure not mis-parsing interval like "2025-08-01 to ..." already handled; hyphen case may overlap but we already returned if matched to
      // check that the matched separator is indeed hyphen not part of earlier pattern that was to/到; still valid
      const hasToOrChinese = /\bto\b/i.test(m[0]) || m[0].includes('到') || m[0].includes('至');
      if (!hasToOrChinese) {
        let y1 = Number(m[1]); let mo1 = Number(m[2]); let d1 = Number(m[3]);
        let h1 = m[4] != null ? Number(m[4]) : null; let mi1 = m[5] != null ? Number(m[5]) : 0; let s1 = m[6] != null ? Number(m[6]) : 0;
        let y2 = Number(m[7]); let mo2 = Number(m[8]); let d2 = Number(m[9]);
        let h2 = m[10] != null ? Number(m[10]) : null; let mi2 = m[11] != null ? Number(m[11]) : 0; let s2 = m[12] != null ? Number(m[12]) : 0;
        if (mo1 >= 1 && mo1 <= 12 && mo2 >= 1 && mo2 <= 12 && d1 >= 1 && d1 <= daysInMonth(y1, mo1) && d2 >= 1 && d2 <= daysInMonth(y2, mo2)) {
          const startOrder = Date.UTC(y1, mo1-1, d1, h1 ?? 0, mi1, s1);
          const endOrder = Date.UTC(y2, mo2-1, d2, h2 ?? 0, mi2, s2);
          if (startOrder > endOrder) {
            let ty=y1, tmo=mo1, td=d1, th=h1, tmi=mi1, ts=s1;
            y1=y2; mo1=mo2; d1=d2; h1=h2; mi1=mi2; s1=s2;
            y2=ty; mo2=tmo; d2=td; h2=th; mi2=tmi; s2=ts;
            warnings.push('swapped interval');
          }
          let from, to;
          if (h1 != null) from = nyWallToUTCSeconds(y1, mo1, d1, h1, mi1, s1);
          else from = nyDayStart(y1, mo1, d1);
          if (h2 != null) to = nyWallToUTCSeconds(y2, mo2, d2, h2, mi2, s2);
          else to = nyDayEnd(y2, mo2, d2);
          return { from, to, anchorBarIndex: null, label: `interval:${y1}-${String(mo1).padStart(2,'0')}-${String(d1).padStart(2,'0')} - ${y2}-${String(mo2).padStart(2,'0')}-${String(d2).padStart(2,'0')}`, confidence: 'high', warnings };
        }
      }
    }
  }

  // ---------- 2) 显式单日 / 单时刻 ----------
  // branch 6: 精确匹配 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss (anchored)
  const singleExact = trimmed.match(/^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{1,2}))?)?\s*$/);
  if (singleExact) {
    const y = Number(singleExact[1]); const mo = Number(singleExact[2]); const d = Number(singleExact[3]);
    const hasTime = singleExact[4] != null;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
      if (hasTime) {
        const h = Number(singleExact[4]); const mi = Number(singleExact[5]); const s = singleExact[6] != null ? Number(singleExact[6]) : 0;
        if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59) {
          const ts = nyWallToUTCSeconds(y, mo, d, h, mi, s);
          return { from: ts, to: ts, anchorBarIndex: null, label: `exact:${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}`, confidence: 'high', warnings };
        }
      } else {
        const from = nyDayStart(y, mo, d);
        const to = nyDayEnd(y, mo, d);
        return { from, to, anchorBarIndex: null, label: `exact:${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`, confidence: 'high', warnings };
      }
    }
  }

  // branch 7: 嵌入式 ISO 日期（句子中包含）— 提取第一个
  const embedded = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{1,2}))?)?/);
  if (embedded && embedded[0].length >= 8) {
    // ensure not already handled as interval (interval already returned) and not being part of relative expression
    // we treat embedded as explicit date if the whole input contains a date and no other higher priority matched
    // But to avoid shadowing natural language, only use if input looks like date-focused (contains year)
    // We'll check if trimmed is mostly date-like or contains "分析" etc but still date
    // For safety, if embedded found and input length < 40 and no other keywords, we can return
    // We check if input contains date and doesn't contain relative keywords already checked? Already passed interval, so ok.
    // However we should only trigger if trimmed length is close to date or contains date with surrounding Chinese
    // We implement as: if embedded and trimmed.replace(embedded[0],'').trim().length < 20 (remaining small) OR input explicitly asks for that day
    const remaining = trimmed.replace(embedded[0], '').trim();
    const isDateFocused = remaining.length < 25 || /那天|当天|这一天|该日|当日/.test(trimmed);
    if (isDateFocused) {
      const y = Number(embedded[1]); const mo = Number(embedded[2]); const d = Number(embedded[3]);
      const hasTime = embedded[4] != null;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
        if (hasTime) {
          const h = Number(embedded[4]); const mi = Number(embedded[5]); const s = embedded[6] != null ? Number(embedded[6]) : 0;
          if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59) {
            const ts = nyWallToUTCSeconds(y, mo, d, h, mi, s);
            return { from: ts, to: ts, anchorBarIndex: null, label: `embedded:${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}`, confidence: 'high', warnings };
          }
        } else {
          const from = nyDayStart(y, mo, d);
          const to = nyDayEnd(y, mo, d);
          return { from, to, anchorBarIndex: null, label: `embedded:${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`, confidence: 'high', warnings };
        }
      }
    }
  }

  // ---------- 3) 相对：最近 N 根 / 近 N 天 / last N bars / last N days ----------
  // branch 8: 中文 最近 N 根
  const rootMatchCN = trimmed.match(/(?:最近|近)\s*(\d+)\s*根/);
  if (rootMatchCN) {
    const n = Number(rootMatchCN[1]);
    if (n > 0) {
      if (Array.isArray(bars) && bars.length > 0) {
        const startIdx = Math.max(0, bars.length - n);
        const fromBar = bars[startIdx];
        const toBar = bars[bars.length - 1];
        return { from: fromBar.time, to: toBar.time, anchorBarIndex: startIdx, label: `最近${n}根`, confidence: 'med', warnings };
      }
      // fallback to N days calendar if no bars
      const startYMD = addDaysToNY(refNY, -(n - 1));
      const from = nyDayStart(startYMD.year, startYMD.month, startYMD.day);
      const to = nyDayEnd(refNY.year, refNY.month, refNY.day);
      return { from, to, anchorBarIndex: null, label: `最近${n}根(calendar fallback)`, confidence: 'med', warnings };
    }
  }

  // branch 9: 中文 近 N 天 / 最近 N 天
  const dayMatchCN = trimmed.match(/(?:最近|近)\s*(\d+)\s*天/);
  if (dayMatchCN) {
    const n = Number(dayMatchCN[1]);
    if (n > 0) {
      const startYMD = addDaysToNY(refNY, -(n - 1));
      const from = nyDayStart(startYMD.year, startYMD.month, startYMD.day);
      const to = nyDayEnd(refNY.year, refNY.month, refNY.day);
      return { from, to, anchorBarIndex: null, label: `近${n}天`, confidence: 'med', warnings };
    }
  }

  // branch 10: 英文 last N bars / past N bars / recent N bars
  const barsMatchEN = lower.match(/(?:last|past|recent)\s+(\d+)\s*bars?\b/);
  if (barsMatchEN) {
    const n = Number(barsMatchEN[1]);
    if (n > 0) {
      if (Array.isArray(bars) && bars.length > 0) {
        const startIdx = Math.max(0, bars.length - n);
        const fromBar = bars[startIdx];
        const toBar = bars[bars.length - 1];
        return { from: fromBar.time, to: toBar.time, anchorBarIndex: startIdx, label: `last ${n} bars`, confidence: 'med', warnings };
      }
      const startYMD = addDaysToNY(refNY, -(n - 1));
      const from = nyDayStart(startYMD.year, startYMD.month, startYMD.day);
      const to = nyDayEnd(refNY.year, refNY.month, refNY.day);
      return { from, to, anchorBarIndex: null, label: `last ${n} bars(calendar fallback)`, confidence: 'med', warnings };
    }
  }

  // branch 11: 英文 last N days / past N days / recent N days / last N day
  const daysMatchEN = lower.match(/(?:last|past|recent)\s+(\d+)\s*days?\b/);
  if (daysMatchEN) {
    const n = Number(daysMatchEN[1]);
    if (n > 0) {
      const startYMD = addDaysToNY(refNY, -(n - 1));
      const from = nyDayStart(startYMD.year, startYMD.month, startYMD.day);
      const to = nyDayEnd(refNY.year, refNY.month, refNY.day);
      return { from, to, anchorBarIndex: null, label: `last ${n} days`, confidence: 'med', warnings };
    }
  }

  // ---------- 4) 自然语言 ----------
  // branch 12: 今天 / today
  if (trimmed.includes('今天') || /\btoday\b/i.test(trimmed)) {
    const from = nyDayStart(refNY.year, refNY.month, refNY.day);
    const to = nyDayEnd(refNY.year, refNY.month, refNY.day);
    return { from, to, anchorBarIndex: null, label: '今天', confidence: 'med', warnings };
  }

  // branch 14: 前天 / day before yesterday (must check before 昨天 because contains yesterday substring)
  if (trimmed.includes('前天') || /day before yesterday/i.test(trimmed)) {
    const ymd = addDaysToNY(refNY, -2);
    const from = nyDayStart(ymd.year, ymd.month, ymd.day);
    const to = nyDayEnd(ymd.year, ymd.month, ymd.day);
    return { from, to, anchorBarIndex: null, label: '前天', confidence: 'med', warnings };
  }

  // branch 13: 昨天 / 昨日 / yesterday
  if (trimmed.includes('昨天') || trimmed.includes('昨日') || /\byesterday\b/i.test(trimmed)) {
    const ymd = addDaysToNY(refNY, -1);
    const from = nyDayStart(ymd.year, ymd.month, ymd.day);
    const to = nyDayEnd(ymd.year, ymd.month, ymd.day);
    return { from, to, anchorBarIndex: null, label: '昨天', confidence: 'med', warnings };
  }

  // branch 15: 本周 / this week
  if (trimmed.includes('本周') || /this week/i.test(trimmed)) {
    const dow = refNY.weekday; // 0 Sun
    const diffToMon = (dow + 6) % 7;
    const mon = addDaysToNY(refNY, -diffToMon);
    const sun = addDaysToNY(mon, 6);
    const from = nyDayStart(mon.year, mon.month, mon.day);
    const to = nyDayEnd(sun.year, sun.month, sun.day);
    return { from, to, anchorBarIndex: null, label: '本周', confidence: 'med', warnings };
  }

  // branch 16: 上周 / last week
  if (trimmed.includes('上周') || /last week/i.test(trimmed)) {
    const dow = refNY.weekday;
    const diffToMon = (dow + 6) % 7;
    const monThis = addDaysToNY(refNY, -diffToMon);
    const monLast = addDaysToNY(monThis, -7);
    const sunLast = addDaysToNY(monLast, 6);
    const from = nyDayStart(monLast.year, monLast.month, monLast.day);
    const to = nyDayEnd(sunLast.year, sunLast.month, sunLast.day);
    return { from, to, anchorBarIndex: null, label: '上周', confidence: 'med', warnings };
  }

  // branch 17: 上月 / last month
  if (trimmed.includes('上月') || /last month/i.test(trimmed)) {
    let y = refNY.year; let m = refNY.month - 1;
    if (m < 1) { m = 12; y -= 1; }
    const from = nyDayStart(y, m, 1);
    const to = nyDayEnd(y, m, daysInMonth(y, m));
    return { from, to, anchorBarIndex: null, label: '上月', confidence: 'med', warnings };
  }

  // branch 18: 本月 / this month
  if (trimmed.includes('本月') || /this month/i.test(trimmed)) {
    const y = refNY.year; const m = refNY.month;
    const from = nyDayStart(y, m, 1);
    const to = nyDayEnd(y, m, daysInMonth(y, m));
    // alternative: to = nyDayEnd(refNY.year, refNY.month, refNY.day) for till today, but spec says 上月为上个月，推断本月为当月整月
    return { from, to, anchorBarIndex: null, label: '本月', confidence: 'med', warnings };
  }

  // ---------- 5) NY Killzone ----------
  // branch 19: 纽约开盘 / NY open / Killzone
  if (trimmed.includes('纽约开盘') || trimmed.includes('纽约时段') || trimmed.includes('纽市') || lower.includes('ny open') || lower.includes('ny killzone') || lower.includes('killzone') || lower.includes('kill zone') || lower.includes('ict killzone')) {
    const from = nyWallToUTCSeconds(refNY.year, refNY.month, refNY.day, 8, 0, 0);
    const to = nyWallToUTCSeconds(refNY.year, refNY.month, refNY.day, 11, 0, 0);
    return { from, to, anchorBarIndex: null, label: 'NY Killzone 8-11am ET', confidence: 'med', warnings };
  }

  // branch 20: 伦敦 / London
  if (trimmed.includes('伦敦') || lower.includes('london open') || lower.includes('london session') || (lower.includes('london') && !lower.includes('new london'))) {
    // 按 spec 仍映射到当天 8-11am ET
    const from = nyWallToUTCSeconds(refNY.year, refNY.month, refNY.day, 8, 0, 0);
    const to = nyWallToUTCSeconds(refNY.year, refNY.month, refNY.day, 11, 0, 0);
    // London open 本应为 3am ET，但 spec 统一要求 8-11am ET，保留此映射并加 note
    return { from, to, anchorBarIndex: null, label: 'London->NY Killzone 8-11am ET', confidence: 'med', warnings };
  }

  // ---------- 6) 单根模糊 ----------
  // branch 21: 大阳线 (bullish)
  if (trimmed.includes('大阳线') || (trimmed.includes('阳线') && !trimmed.includes('阴线')) || lower.includes('big bullish') || lower.includes('large bullish')) {
    if (Array.isArray(bars) && bars.length > 0) {
      const found = findBarBySemantics(bars, trimmed);
      if (found) {
        const bar = bars[found.index];
        return { from: bar.time, to: bar.time, anchorBarIndex: found.index, label: `大阳线:bar#${found.index}`, confidence: 'low', warnings };
      }
    }
    // fallback if no bars but keyword matched -> still low confidence fallback
    // continue to generic handling below
  }

  // branch 22: 大阴线 (bearish)
  if (trimmed.includes('大阴线') || trimmed.includes('阴线') || lower.includes('big bearish') || lower.includes('large bearish') || lower.includes('bearish')) {
    if (Array.isArray(bars) && bars.length > 0) {
      const found = findBarBySemantics(bars, trimmed);
      if (found) {
        const bar = bars[found.index];
        return { from: bar.time, to: bar.time, anchorBarIndex: found.index, label: `大阴线:bar#${found.index}`, confidence: 'low', warnings };
      }
    }
  }

  // branch 23: 长上影
  if (trimmed.includes('长上影') || trimmed.includes('上影线') || trimmed.includes('上影') || lower.includes('upper shadow') || lower.includes('upper wick') || lower.includes('long upper')) {
    if (Array.isArray(bars) && bars.length > 0) {
      const found = findBarBySemantics(bars, trimmed);
      if (found) {
        const bar = bars[found.index];
        return { from: bar.time, to: bar.time, anchorBarIndex: found.index, label: `长上影:bar#${found.index}`, confidence: 'low', warnings };
      }
    }
  }

  // branch 24: 放量
  if (trimmed.includes('放量') || trimmed.includes('高成交量') || trimmed.includes('爆量') || lower.includes('high volume') || lower.includes('volume spike') || lower.includes('huge volume') || lower.includes('burst volume')) {
    if (Array.isArray(bars) && bars.length > 0) {
      const found = findBarBySemantics(bars, trimmed);
      if (found) {
        const bar = bars[found.index];
        return { from: bar.time, to: bar.time, anchorBarIndex: found.index, label: `放量:bar#${found.index}`, confidence: 'low', warnings };
      }
    }
  }

  // branch 25: 通用模糊兜底 — 任何包含上述关键词但未在上面分支返回的，再尝试一次
  const hasFuzzy = trimmed.includes('大阳') || trimmed.includes('大阴') || trimmed.includes('上影') || trimmed.includes('下影') || trimmed.includes('放量') || trimmed.includes('十字星') || lower.includes('doji') || lower.includes('volume') || lower.includes('bullish') || lower.includes('bearish') || lower.includes('shadow');
  if (hasFuzzy) {
    if (Array.isArray(bars) && bars.length > 0) {
      const found = findBarBySemantics(bars, trimmed);
      if (found) {
        const bar = bars[found.index];
        return { from: bar.time, to: bar.time, anchorBarIndex: found.index, label: `fuzzy:${trimmed}->bar#${found.index}`, confidence: 'low', warnings };
      }
    }
    // 有模糊词但无 bars -> fallback with warning
    warnings.push('fuzzy semantics requires bars');
    return makeFallback();
  }

  // ---------- 兜底 ----------
  // branch 26: fallback
  return makeFallback();
}
