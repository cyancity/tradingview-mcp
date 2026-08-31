// VSOP detector — JS port of the user's "YOLO MS" Pine state machine — DRAFT, NOT authoritative.
// ⚠️ 实盘裁决必须读 TradingView 上的真 MS（CDP 标签/表），本端口仅离线回测用；
//    已知偏差：auto-fractal 长度 / bos 反向保护 / swing_filter 阈值未 port，S 信号可与真指标差 20+ 分钟。
//    对齐验收（逐根比对历史 MS 标签）通过前，禁止接进 pre-trade-gate。见 docs/vsop-spec.md §6。
// (2-stage confirmation: CHoCH -> pending -> first BOS = entry signal, plus Fake ChoCH FB/FS)

const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ta.atr (RMA of true range), aligned to bar index (null until warmed)
function atrSeries(bars, len = 14) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  const out = new Array(bars.length).fill(null);
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    acc += tr[i];
    if (i === len - 1) out[i] = acc / len;
    else if (i >= len) out[i] = (out[i - 1] * (len - 1) + tr[i]) / len;
  }
  return out;
}

// Fractal detection as in Pine: length=5, p=2, confirmed 2 bars after the pivot bar.
// Quality filter: pivot bar range >= minRangeAtr*ATR14(pivot), swing-side wick ratio >= minWickRatio.
export function fractals(bars, opts = {}) {
  const { minRangeAtr = 0.5, minWickRatio = 0.15, pivot = 2 } = opts;
  const atr = atrSeries(bars);
  const d = bars.map((b, i) => (i === 0 ? 0 : sgn(b.high - bars[i - 1].high)));
  const dl = bars.map((b, i) => (i === 0 ? 0 : sgn(b.low - bars[i - 1].low)));
  const bull = new Array(bars.length).fill(false);
  const bear = new Array(bars.length).fill(false);
  const p = pivot;
  for (let i = p * 2 + p; i < bars.length; i++) {
    const j = i - p; // pivot bar index
    const dh = d[i] + d[i - 1], dhp = d[i - 2] + d[i - 3];
    const dl2 = dl[i] + dl[i - 1], dlp = dl[i - 2] + dl[i - 3];
    let hi = true, lo = true;
    for (let k = i - 2 * p; k <= i; k++) {
      if (bars[k].high > bars[j].high) hi = false;
      if (bars[k].low < bars[j].low) lo = false;
    }
    const pb = bars[j];
    const range = pb.high - pb.low;
    const ap = atr[j];
    const volOk = !minRangeAtr || ap == null || range >= minRangeAtr * ap;
    const uw = pb.high - Math.max(pb.open, pb.close);
    const lw = Math.min(pb.open, pb.close) - pb.low;
    const uwOk = !minWickRatio || range <= 0 || uw / range >= minWickRatio;
    const lwOk = !minWickRatio || range <= 0 || lw / range >= minWickRatio;
    if (dh === -p && dhp === p && hi && volOk && uwOk) bull[i] = true;
    if (dl2 === p && dlp === -p && lo && volOk && lwOk) bear[i] = true;
  }
  return { bull, bear };
}

// State machine over confirmed bars. Returns tickets (B/S/FB/FS) + final os + events log.
// os: 1 bull-confirmed | 2 bull-pending | 0 neutral | -2 bear-pending | -1 bear-confirmed
export function runVsopMachine(bars, opts = {}) {
  const { slOffsetPts = 1.0, tpRatio = 2.0 } = opts;
  const { bull, bear } = fractals(bars, opts);
  let upper = null, lower = null; // { value, idx, iscrossed }
  let os = 0, bullSeq = 0, bearSeq = 0;
  let lastBullChIdx = null, lastBearChIdx = null;
  const tickets = [], events = [];

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    if (bull[i]) {
      const j = i - 2;
      upper = { value: bars[j].high, idx: j, iscrossed: false };
    }
    if (bear[i]) {
      const j = i - 2;
      lower = { value: bars[j].low, idx: j, iscrossed: false };
    }

    // ----- bullish side -----
    if (upper && !upper.iscrossed && prev && b.close > upper.value && prev.close <= upper.value) {
      const oldOs = os;
      upper.iscrossed = true;
      const isChoch = os === -1;
      if (isChoch) {
        os = 2; bullSeq = 0; bearSeq = 0;
        lastBullChIdx = i;
        events.push({ type: 'bull_choch', time: b.time, i, level: upper.value });
      } else if (os === 2) {
        os = 1; bullSeq += 1;
        if (lastBullChIdx !== null) {
          const entry = upper.value;
          const sl = Math.min(b.low, prev.low) - slOffsetPts;
          const tp = entry + tpRatio * (entry - sl);
          tickets.push({ dir: 'long', type: 'B', time: b.time, i, entry, sl, tp });
          events.push({ type: 'B', time: b.time, i });
          lastBullChIdx = null;
        }
      } else {
        os = 1; bullSeq += 1;
      }
      // Fake bearish CHoCH -> FB continuation long
      if (oldOs === -2 && lastBearChIdx !== null) {
        const entry = upper.value;
        const sl = Math.min(b.low, prev.low) - slOffsetPts;
        const tp = entry + tpRatio * (entry - sl);
        tickets.push({ dir: 'long', type: 'FB', time: b.time, i, entry, sl, tp, fakeOf: lastBearChIdx });
        events.push({ type: 'fake_bear_choch', time: b.time, i });
        lastBearChIdx = null;
      }
    }

    // ----- bearish side (mirror) -----
    if (lower && !lower.iscrossed && prev && b.close < lower.value && prev.close >= lower.value) {
      const oldOs = os;
      lower.iscrossed = true;
      const isChoch = os === 1;
      if (isChoch) {
        os = -2; bearSeq = 0; bullSeq = 0;
        lastBearChIdx = i;
        events.push({ type: 'bear_choch', time: b.time, i, level: lower.value });
      } else if (os === -2) {
        os = -1; bearSeq += 1;
        if (lastBearChIdx !== null) {
          const entry = lower.value;
          const sl = Math.max(b.high, prev.high) + slOffsetPts;
          const tp = entry - tpRatio * (sl - entry);
          tickets.push({ dir: 'short', type: 'S', time: b.time, i, entry, sl, tp });
          events.push({ type: 'S', time: b.time, i });
          lastBearChIdx = null;
        }
      } else {
        os = -1; bearSeq += 1;
      }
      if (oldOs === 2 && lastBullChIdx !== null) {
        const entry = lower.value;
        const sl = Math.max(b.high, prev.high) + slOffsetPts;
        const tp = entry - tpRatio * (sl - entry);
        tickets.push({ dir: 'short', type: 'FS', time: b.time, i, entry, sl, tp, fakeOf: lastBullChIdx });
        events.push({ type: 'fake_bull_choch', time: b.time, i });
        lastBullChIdx = null;
      }
    }
  }
  return { os, tickets, events };
}

// Aggregate 1m bars into an N-minute series
export function aggregate(bars, minutes) {
  const step = minutes * 60;
  const map = new Map();
  for (const b of bars) {
    const k = Math.floor(b.time / step) * step;
    const a = map.get(k);
    if (!a) map.set(k, { time: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    else {
      a.high = Math.max(a.high, b.high);
      a.low = Math.min(a.low, b.low);
      a.close = b.close;
      a.volume += b.volume;
    }
  }
  return [...map.values()].sort((x, y) => x.time - y.time);
}

// Combo signal: 1m tickets filtered by HTF veto. Default veto TFs: 15m + 60m
// (5m pending-bull/bull-confirmed is required context; a fresh bearish structure on 15m/1h suppresses).
export function analyzeVsop(bars1m, opts = {}) {
  const { vetoTfs = [15, 60], allowTfs = [5] } = opts;
  const m1 = runVsopMachine(bars1m, opts);
  const htfStates = {};
  for (const tf of new Set([...allowTfs, ...vetoTfs])) {
    const series = aggregate(bars1m, tf);
    const r = runVsopMachine(series, opts);
    htfStates[tf] = { os: r.os, events: r.events.slice(-4) };
  }
  // Evaluate veto context at each 1m ticket time (approximate: use htf os at ticket index)
  const results = m1.tickets.map(t => {
    const allowCtx = allowTfs.every(tf => htfStateAt(bars1m, tf, t.time, opts) > 0 || htfStateAt(bars1m, tf, t.time, opts) === 2);
    const vetoed = vetoTfs.some(tf => htfStateAt(bars1m, tf, t.time, opts) < 0);
    return { ...t, allowed: allowCtx && !vetoed, reason: !allowCtx ? 'htf-context-not-bullish' : vetoed ? 'htf-veto-bearish' : 'pass' };
  });
  return { finalOs: m1.os, events: m1.events, tickets: results, htfStates };
}

// os of TF series at (or just before) bar time t
function htfStateAt(bars1m, tfMinutes, t, opts) {
  const series = aggregate(bars1m, tfMinutes).filter(b => b.time <= t);
  if (series.length < 6) return 0;
  return runVsopMachine(series, opts).os;
}
