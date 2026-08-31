// Backtest matching engine — replicates trade-system live semantics (limit generation).
// See docs/vsop-spec.md §6 for the fidelity contract and evidence line-references
// (executor-okx tools.js/pending.js/convert.js, gateway pipeline.js/semantic.js).
//
// Dataset: { tf_seconds, signals:[{bar_time(sec of signal bar OPEN), dir, type,
//            entry_ref, sl, tp, shift2?:{o,h,l,c}, states?:{...}}], bars1m:[...] }
//
// Live rules replicated:
//  L1 plain limit at entry_ref (not marketable)          L2 TTL 900s from placement (bar close+latency)
//  L3 rule C one-time shift on 2nd-bar body agree+chase  L4 TP/SL = fill ± SIGNAL tick offsets
//  L5 last-price touch via bar H/L, outcome=trigger px   L6 occupancy censor (position or pending)
//  L8 dedupe (bar_time,dir)                              L9 same-bar TP&SL → SL first (ambiguous)
// Toggles (controls, not live): rules.A runaway-cancel, rules.B time-stop → BE + 1R.
//
// Known bar-grain approximations (documented, not silently hidden):
//  A1 a 1m bar overlapping placement uses its full H/L (order only lives part of the bar)
//  A2 fill-bar TP/SL: OCO arms at fill instant; the remainder of the fill bar can trigger
//     both directions — checked, and flagged ambiguous when both touched (SL first)

export function snapTick(px, tick) { return Math.round(px / tick) * tick; }

/** coverage gate: order placement (signalClose + latency) must fall inside the bars window */
function placedTooEarly(signalClose, dataFrom) {
  // first bar covers [dataFrom, dataFrom+tf); placement must be >= dataFrom to have any bar to match against
  return signalClose + 2 < dataFrom;
}

/** Most recent CONFIRMED pivot low (LONG) / pivot high (SHORT) at or before the signal bar.
 *  MS fractal convention: pivot = p bars each side, all strictly lower (for low).
 *  Pivot must be confirmed: idx + pivot < signalIdx (right side fully before the signal bar). */
export function findRecentSwing(bars, signalBarTime, wantLow, pivot = 2, lookback = 50) {
  let sIdx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].time === signalBarTime) { sIdx = i; break; } }
  if (sIdx === -1) { // signal bar not in bars (aggregated view): fall back to nearest earlier bar
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].time <= signalBarTime) { sIdx = i; break; } }
    if (sIdx === -1) return null;
  }
  const from = Math.max(pivot, sIdx - lookback);
  for (let i = sIdx - pivot; i >= from; i--) {           // nearest first
    let ok = true;
    for (let k = 1; k <= pivot; k++) {
      const l = bars[i - k], r = bars[i + k];
      if (!l || !r) { ok = false; break; }
      if (wantLow ? !(bars[i].low < l.low && bars[i].low < r.low)
                  : !(bars[i].high > l.high && bars[i].high > r.high)) { ok = false; break; }
    }
    if (ok) return wantLow ? bars[i].low : bars[i].high;
  }
  return null;
}


export function runBacktest(dataset, opts = {}) {
  const {
    rules = {}, ttl_s = 900, latency_s = 2, shiftCapFrac = 0.30,
    ruleB_s = 1800, ruleB_be_ticks = 2,
    qty = 1, tick = 0.25, pointValue = 20, ambiguousSlFirst = true,
    minRPts = 0,           // L7b: gateway R_TOO_SMALL gate — signals with R below this are rejected
    exitMode = 'A',        // 'A' = live (signal sl/tp as-is: K±prevK extremes ∓1pt, 1:2)
                           // 'B' = control: same entry, SL = swing low/high of current range, TP 1:1
    swingLookback = 50, swingPivot = 2,   // exitMode B swing search params (MS fractal convention p=2)
    guard = null,          // LIVE position guard (user's real rule, stackable on A/B):
                           // { be_after_s: 1800, hard_exit_s: 2700, be_ticks: 0 }
                           // 30min without TP → SL to breakeven; 45min → force-close at bar close.
                           // Bar-grain note: hard exit uses the close of the first bar ending
                           // past the deadline (at most one bar later than the live instant).
    timeWindow = null,     // { startH: 8, startM: 30, endH: 12, endM: 0, tz: 'America/New_York' }
                           // Signal bar_time must fall within [start, end) in the given timezone.
                           // Signals outside the window get outcome FILTERED_TIME.
    htfFilter = false,     // When true: if 15m AND 1h states are both bearish (≤ -1), skip LONG;
                           //            if 15m AND 1h states are both bullish (≥ 1), skip SHORT.
                           // Outcome = FILTERED_HTF. FB/FS are kept (tagged for separate analysis).
    tpRatio = null,        // Override TP distance: tpPts = rPts * tpRatio (e.g. 1 for 1:1, 3 for 1:3).
                           // null = use signal's original TP. Applies after exitMode B override.
    sessionClose = null, // { h, m, tz } — force-close any open position at NY hh:mm.
                         // Bar-close time (NY) >= session end → exit at bar close (after TP/SL checks).
                         // Simulates the trader leaving the desk at a fixed wall-clock time.
  } = opts;
  const useC = rules.C !== false, useA = !!rules.A, useB = !!rules.B;
  const tfs = dataset.tf_seconds || 300;
  const bars = dataset.bars1m;
  const signals = [...dataset.signals]
    .filter((s, i, a) => a.findIndex(x => x.bar_time === s.bar_time && x.dir === s.dir) === i) // L8
    .sort((a, b) => a.bar_time - b.bar_time);

  const trades = [];
  let occupiedUntil = -Infinity;
  const dataFrom = bars.length ? bars[0].time : Infinity;             // coverage gate
  for (const sig of signals) {
    const isLong = sig.dir === 'LONG';
    const signalClose = sig.bar_time + tfs;
    // ---- F1: time window filter (e.g. NY 8:30–12:00) ----
    if (timeWindow) {
      const { startH = 0, startM = 0, endH = 24, endM = 0, tz = 'America/New_York' } = timeWindow;
      const d = new Date(sig.bar_time * 1000);
      const nyStr = d.toLocaleString('en-US', { timeZone: tz, hour12: false });
      // nyStr format: "M/D/YYYY, HH:MM:SS"
      const timeParts = nyStr.split(', ')[1].split(':');
      const h = parseInt(timeParts[0], 10) % 24;  // toLocaleString may return 24 as 0
      const m = parseInt(timeParts[1], 10);
      const minuteOfDay = h * 60 + m;
      const windowStart = startH * 60 + startM;
      const windowEnd = endH * 60 + endM;
      if (minuteOfDay < windowStart || minuteOfDay >= windowEnd) {
        trades.push(base(sig, sig.sl, sig.tp, {
          outcome: 'FILTERED_TIME', note: `outside ${startH}:${String(startM).padStart(2,'0')}–${endH}:${String(endM).padStart(2,'0')} ${tz}`,
          ny_time: `${h}:${String(m).padStart(2,'0')}`,
        }));
        continue;
      }
    }
    // ---- F2: HTF trend filter (15m + 1h suppress contra signals) ----
    if (htfFilter && sig.states) {
      const s15 = sig.states['15m'], s1h = sig.states['1h'];
      if (s15 != null && s1h != null) {
        const bothBear = s15 <= -1 && s1h <= -1;
        const bothBull = s15 >= 1 && s1h >= 1;
        // B signals (not FB) suppressed when HTF opposes
        const isFakeout = sig.type === 'FB' || sig.type === 'FS';
        if (!isFakeout && bothBear && isLong) {
          trades.push(base(sig, sig.sl, sig.tp, {
            outcome: 'FILTERED_HTF', note: `15m=${s15},1h=${s1h} suppress LONG`,
          }));
          continue;
        }
        if (!isFakeout && bothBull && !isLong) {
          trades.push(base(sig, sig.sl, sig.tp, {
            outcome: 'FILTERED_HTF', note: `15m=${s15},1h=${s1h} suppress SHORT`,
          }));
          continue;
        }
      }
    }
    if (placedTooEarly(signalClose, dataFrom)) {                      // coverage
      trades.push(base(sig, sig.sl, sig.tp, { outcome: 'SKIPPED_NO_DATA', note: 'signal precedes bars window' }));
      continue;
    }
    if (signalClose < occupiedUntil) {                                  // L6
      trades.push(base(sig, sig.sl, sig.tp, { outcome: 'CENSORED', note: 'occupied' }));
      continue;
    }
    // ---- exit mode B: re-anchor SL to the swing low/high of the current range ----
    let slRef = sig.sl, tpRef = sig.tp;
    if (exitMode === 'B') {
      const swing = findRecentSwing(bars, sig.bar_time, isLong, swingPivot, swingLookback);
      if (swing == null) {
        trades.push(base(sig, slRef, tpRef, { outcome: 'SKIPPED_NO_SWING', note: 'no confirmed swing within lookback' }));
        continue;
      }
      slRef = swing;
      tpRef = isLong ? sig.entry_ref + (sig.entry_ref - swing) : sig.entry_ref - (swing - sig.entry_ref); // 1:1
    }
    const rPts = Math.abs(sig.entry_ref - slRef);
    let tPts = tpRatio != null ? rPts * tpRatio : Math.abs(tpRef - sig.entry_ref);
    if (tpRatio != null) tpRef = isLong ? sig.entry_ref + tPts : sig.entry_ref - tPts;
    if (!rPts || !tPts || (isLong ? slRef >= sig.entry_ref : slRef <= sig.entry_ref)) {
      trades.push(base(sig, slRef, tpRef, { outcome: 'INVALID', note: 'bad R' }));
      continue;
    }
    if (minRPts > 0 && rPts < minRPts) {           // L7b: gateway R_TOO_SMALL gate
      trades.push(base(sig, slRef, tpRef, { outcome: 'REJECTED', note: 'R_TOO_SMALL' }));
      continue;
    }

    let px = snapTick(sig.entry_ref, tick);
    const placedAt = signalClose + latency_s;                           // L2
    const deadline = placedAt + ttl_s;
    let filled = null, armed = false, beArmed = false, shifted = false, shiftEvalDone = false;
    let outcome = null, trigger = null, exitTime = null, note = null;

    for (const b of bars) {
      const bClose = b.time + 60;
      if (bClose <= placedAt) continue;                                 // A1

      if (!filled) {
        const touched = isLong ? b.low <= px : b.high >= px;            // L1 touch
        if (touched) {
          const openThrough = isLong ? b.open <= px : b.open >= px;
          filled = { px: snapTick(openThrough ? b.open : px, tick), time: b.time };
        } else {
          if (useA && (isLong ? b.high >= tpRef : b.low <= tpRef)) {  // control rule A
            outcome = 'CANCELLED_RUNAWAY'; note = 'ruleA'; break;
          }
          if (!shiftEvalDone && bClose >= signalClose + 2 * tfs) {      // L3
            shiftEvalDone = true;
            const body = sig.shift2 || { o: b.open, h: b.high, l: b.low, c: b.close };
            const agree = isLong ? body.c >= body.o : body.c <= body.o;
            const newPx = snapTick(isLong ? body.l : body.h, tick);
            const chase = isLong ? px - newPx : newPx - px;
            if (useC && agree && chase > 0 && Math.abs(newPx - px) <= shiftCapFrac * rPts) {
              px = newPx; shifted = true;
            }
          }
          if (bClose >= deadline) { outcome = shifted ? 'EXPIRED_AFTER_SHIFT' : 'EXPIRED'; break; }
          continue;
        }
      }

      // ---- position management (also on the fill bar: A2) ----
      let tpPx = snapTick(isLong ? filled.px + tPts : filled.px - tPts, tick);   // L4
      let slPx = snapTick(isLong ? filled.px - rPts : filled.px + rPts, tick);
      if (useB && !armed && bClose - (filled.time + 60) >= ruleB_s) {   // control rule B
        armed = true;
        slPx = snapTick(isLong ? filled.px + ruleB_be_ticks * tick : filled.px - ruleB_be_ticks * tick, tick);
        tpPx = snapTick(isLong ? filled.px + rPts : filled.px - rPts, tick);
        note = note ? note + ',B_armed' : 'B_armed';
      }
      // ---- guard: BE arm (BEFORE hit checks — it moves slPx) ----
      const heldS = bClose - (filled.time + 60);
      if (guard && guard.be_after_s != null && !beArmed && heldS >= guard.be_after_s) {
        beArmed = true;
        const beTicks = guard.be_ticks ?? 0;
        slPx = snapTick(isLong ? filled.px + beTicks * tick : filled.px - beTicks * tick, tick);
        note = note ? note + `,BE@${Math.round(guard.be_after_s / 60)}m` : `BE@${Math.round(guard.be_after_s / 60)}m`;
      }
      const hitTP = isLong ? b.high >= tpPx : b.low <= tpPx;
      const hitSL = isLong ? b.low <= slPx : b.high >= slPx;            // L5
      if (hitTP && hitSL && ambiguousSlFirst) {
        outcome = 'SL'; trigger = slPx; exitTime = b.time;
        note = note ? note + ',ambiguous' : 'ambiguous'; break;
      }
      if (hitSL) { outcome = 'SL'; trigger = slPx; exitTime = b.time; break; }
      if (hitTP) { outcome = 'TP'; trigger = tpPx; exitTime = b.time; break; }
      // ---- guard: hard time exit (TP/SL on this bar take precedence) ----
      if (guard && guard.hard_exit_s != null && heldS >= guard.hard_exit_s) {
        outcome = 'TIME_EXIT'; trigger = b.close; exitTime = b.time;
        note = note ? note + `,hard@${Math.round(guard.hard_exit_s / 60)}m` : `hard@${Math.round(guard.hard_exit_s / 60)}m`;
        break;
      }
      // ---- session close: NY wall-clock hard exit (after TP/SL precedence) ----
      if (sessionClose && filled) {
        const nyStr = new Date(bClose * 1000).toLocaleString('en-US',
          { timeZone: sessionClose.tz || 'America/New_York', hour12: false });
        const tp2 = nyStr.split(', ')[1].split(':');
        const hh = parseInt(tp2[0], 10) % 24, mm = parseInt(tp2[1], 10);
        if (hh * 60 + mm >= (sessionClose.h * 60 + (sessionClose.m || 0))) {
          outcome = 'SESSION_EXIT'; trigger = b.close; exitTime = b.time;
          note = note ? note + `,sess@${sessionClose.h}:${String(sessionClose.m || 0).padStart(2,'0')}` : `sess@${sessionClose.h}:${String(sessionClose.m || 0).padStart(2,'0')}`;
          break;
        }
      }
    }
    if (!outcome) outcome = filled ? 'OPEN_AT_END' : 'EXPIRED';

    const t = base(sig, slRef, tpRef, {
      outcome, fill_px: filled ? filled.px : null,
      fill_time: filled ? filled.time + 60 : null,
      trigger, exit_time: exitTime !== null ? exitTime + 60 : null,
      shifted, note,
    });
    if (filled && (outcome === 'TP' || outcome === 'SL' || outcome === 'TIME_EXIT' || outcome === 'SESSION_EXIT')) {
      const pts = isLong ? trigger - filled.px : filled.px - trigger;
      t.r_multiple = +(pts / rPts).toFixed(3);
      t.dollar = +(pts * pointValue * qty).toFixed(2);
      t.hold_min = +(((exitTime + 60) - (filled.time + 60)) / 60).toFixed(1);
    }
    trades.push(t);
    occupiedUntil = !filled ? deadline : (outcome === 'OPEN_AT_END' ? Infinity : exitTime + 60); // L6
  }
  return trades;
}

function base(sig, slRef, tpRef, extra) {
  return {
    bar_time: sig.bar_time, dir: sig.dir, type: sig.type,
    entry_ref: sig.entry_ref, sl_ref: slRef, tp_ref: tpRef,
    states: sig.states, ...extra,
  };
}

/**
 * runBacktestV3 — position-lifecycle matching for the v3 roll strategy.
 * Dataset: { signals:[B/S/FB/FS with entry/sl/tp], add:[{time,type,entry,sl}],
 *            flat:[{time,px}], trail:[{time,sl}], bars1m:[...], tf_seconds }
 *
 * Lifecycle:
 *  entry signal fills at level (limit, TTL) → open position (size 1)
 *  ADD order fills at same level → size += 1 (no TTL gating beyond entry's window)
 *  trail events move the protective stop (trail_sl); TP (if any) disabled after first ADD
 *  flat event (reverse CHoCH) → close ALL at market
 *  SL touch → close ALL at SL
 *  TP touch (only before first ADD) → close ALL at TP
 */
export function runBacktestV3(dataset, opts = {}) {
  const {
    tick = 0.25, pointValue = 2, qty = 1, ttl_s = 900, latency_s = 2,
    minRPts = 0, ambiguousSlFirst = true,
    useInitialTP = true,   // 第一 BOS 用 1:1 TP；ADD 后停用（滚仓）
    initialTPRatio = 1,    // 初始 TP 盈亏比（默认 1:1）
    rollMode = true,       // 是否应用 ADD 加仓 + flat 全平（false = 纯固定 TP 出场）
  } = opts;
  const tfs = dataset.tf_seconds || 300;
  const bars = dataset.bars1m;
  const signals = [...(dataset.signals || [])].sort((a, b) => a.bar_time - b.bar_time);
  const adds = [...(dataset.add || [])].sort((a, b) => a.time - b.time);
  const flats = [...(dataset.flat || [])].sort((a, b) => a.time - b.time);
  const trails = [...(dataset.trail || [])].sort((a, b) => a.time - b.time);
  const dataFrom = bars.length ? bars[0].time : Infinity;

  const trades = [];
  let pos = null;            // { dir, size, fill_px, fill_time, sl, tp, rolled, note }
  let addIdx = 0, flatIdx = 0, trailIdx = 0;
  let occupiedUntil = -Infinity;

  const snap = (px) => snapTick(px, tick);

  const closePos = (outcome, trigger, exitTime, note) => {
    const merged = pos.note ? (note ? pos.note + ',' + note : pos.note) : note;
    const t = {
      bar_time: pos.entry_time, dir: pos.dir, type: pos.type,
      entry_ref: pos.entry_px, sl_ref: pos.sl, tp_ref: pos.tp,
      outcome, fill_px: pos.fill_px, fill_time: pos.fill_time,
      trigger, exit_time: exitTime, size: pos.size, note: merged,
      states: pos.states,
    };
    if (pos.fill_px != null && trigger != null) {
      const pts = pos.dir === 'LONG' ? trigger - pos.fill_px : pos.fill_px - trigger;
      t.r_multiple = +(pts / pos.rPts).toFixed(3);
      t.dollar = +(pts * pointValue * pos.size * qty).toFixed(2);
      t.hold_min = +(((exitTime + 60) - (pos.fill_time)) / 60).toFixed(1);
    }
    trades.push(t);
    occupiedUntil = exitTime + 60;
    pos = null;
  };

  const openEntry = (sig) => {
    const isLong = sig.dir === 'LONG';
    const rPts = Math.abs(sig.entry_ref - sig.sl);
    if (!rPts || (isLong ? sig.sl >= sig.entry_ref : sig.sl <= sig.entry_ref)) return null;
    if (minRPts > 0 && rPts < minRPts) return null;
    return {
      dir: sig.dir, type: sig.type, size: 1,
      entry_ref: sig.entry_ref, entry_px: snap(sig.entry_ref), entry_time: sig.bar_time,
      fill_px: null, fill_time: null, sl: sig.sl, tp: sig.tp,
      rPts, rolled: false, states: sig.states,
    };
  };

  for (const sig of signals) {
    // coverage gate
    if (sig.bar_time + tfs + 2 < dataFrom) {
      trades.push(base(sig, sig.sl, sig.tp, { outcome: 'SKIPPED_NO_DATA', note: 'signal precedes bars window' }));
      continue;
    }
    if (pos) {
      trades.push(base(sig, sig.sl, sig.tp, { outcome: 'CENSORED', note: 'occupied' }));
      continue;
    }
    const p = openEntry(sig);
    if (!p) {
      trades.push(base(sig, sig.sl, sig.tp, { outcome: 'REJECTED', note: 'bad R or R_TOO_SMALL' }));
      continue;
    }
    pos = p;
    const placedAt = sig.bar_time + tfs + latency_s;
    const deadline = placedAt + ttl_s;
    let expired = false;

    for (const b of bars) {
      const bClose = b.time + 60;
      if (bClose <= placedAt) continue;
      if (!pos) break;

      // ---- fill ----
      if (!pos.fill_px) {
        const touched = pos.dir === 'LONG' ? b.low <= pos.entry_px : b.high >= pos.entry_px;
        if (touched) {
          const openThrough = pos.dir === 'LONG' ? b.open <= pos.entry_px : b.open >= pos.entry_px;
          pos.fill_px = snap(openThrough ? b.open : pos.entry_px);
          pos.fill_time = b.time + 60;
          pos.sl = snap(pos.sl);
          pos.tp = useInitialTP ? snap(pos.dir === 'LONG' ? pos.fill_px + initialTPRatio * pos.rPts : pos.fill_px - initialTPRatio * pos.rPts) : null;
        } else {
          if (bClose >= deadline) { expired = true; break; }
          continue;
        }
      }

      // ---- apply trail SL moves (from ledger: FVG roll) ----
      while (trailIdx < trails.length && trails[trailIdx].time <= b.time + 60) {
        const tr = trails[trailIdx++];
        const newSl = snap(tr.sl);
        const better = pos.dir === 'LONG' ? newSl > pos.sl : newSl < pos.sl;
        if (better) { pos.sl = newSl; pos.rolled = true; }
      }

      // ---- apply ADD fills (same bar as entry allowed) ----
      while (rollMode && addIdx < adds.length && adds[addIdx].time <= b.time + 60) {
        const ad = adds[addIdx++];
        if (!pos || pos.dir !== (ad.type > 0 ? 'LONG' : 'SHORT')) continue;
        // ADD order at same level — fill if touched
        const aPx = snap(ad.entry);
        const touched = pos.dir === 'LONG' ? b.low <= aPx : b.high >= aPx;
        if (touched) {
          pos.size += 1;
          pos.tp = null;               // 滚仓：ADD 后停用 TP
          pos.rolled = true;
          pos.note = (pos.note ? pos.note + ',' : '') + 'ADD@' + ad.time;
        }
      }

      // ---- reverse CHoCH flat (只对已加仓/滚仓中的仓位生效；未加仓的用 TP/SL 出场) ----
      while (rollMode && flatIdx < flats.length && flats[flatIdx].time <= b.time + 60) {
        const fl = flats[flatIdx++];
        if (pos && pos.rolled) {
          closePos('FLAT_CHOCH', snap(fl.px || b.close), b.time + 60, 'reverse CHoCH flat');
          break;
        }
        // pos 未加仓：跳过该 flat，继续看下一个（flat 绑定到滚仓仓位，与固定 TP 仓位无关）
      }
      if (!pos) break;

      // ---- TP/SL ----
      const hitTP = pos.tp != null && (pos.dir === 'LONG' ? b.high >= pos.tp : b.low <= pos.tp);
      const hitSL = pos.dir === 'LONG' ? b.low <= pos.sl : b.high >= pos.sl;
      if (hitTP && hitSL && ambiguousSlFirst) { closePos('SL', pos.sl, b.time + 60, 'ambiguous,SL'); break; }
      if (hitSL) { closePos('SL', pos.sl, b.time + 60, pos.rolled ? 'trail' : 'stop'); break; }
      if (hitTP) { closePos('TP', pos.tp, b.time + 60, 'TP'); break; }
    }

    if (pos) {
      if (expired) { trades.push(base(sig, sig.sl, sig.tp, { outcome: 'EXPIRED', note: 'TTL', states: sig.states })); pos = null; }
      else { closePos('OPEN_AT_END', pos.fill_px, bars.length ? bars[bars.length - 1].time + 60 : null, 'open at end'); }
    }
  }
  // leftover flats with no position: record as events (no trade)
  return trades;
}
