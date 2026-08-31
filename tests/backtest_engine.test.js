import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, runBacktestV3, snapTick } from '../src/backtest/engine.js';

// 合成 1m bars：从 t0 起 n 根，价格由 fn(i) 给 {o,h,l,c}
function bars(t0, n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = fn(i);
    out.push({ time: t0 + i * 60, open: b.o, high: b.h, low: b.l, close: b.c, volume: 100 });
  }
  return out;
}
const T0 = 1788000000; // 任意锚点
const sigLong = (over = {}) => ({
  bar_time: T0, dir: 'LONG', type: 'B', entry_ref: 100, sl: 98, tp: 104, ...over,
});

describe('engine: snapTick', () => {
  it('四舍五入到 tick 网格', () => {
    assert.equal(snapTick(100.1, 0.25), 100);
    assert.equal(snapTick(100.13, 0.25), 100.25);
  });
});

describe('engine: L1/L2 挂单与 TTL', () => {
  it('T1 不回踩 → 15min 后 EXPIRED，无成交', () => {
    const ds = { tf_seconds: 300, bars1m: bars(T0 + 300, 16, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })), signals: [sigLong()] };
    const [t] = runBacktest(ds);
    assert.equal(t.outcome, 'EXPIRED');
    assert.equal(t.fill_px, null);
    assert.equal(t.shifted, false);
  });

  it('T1b TTL 计时从挂单受理时刻起（bar close + latency），不是信号 K 开盘', () => {
    // 价格在 signalClose+880s 才回踩（若从 bar_time 起算 900s 会过期；从 close+2s 起算则仍有效）
    const pullBackAtMin = 14; // T0+300+14*60 = signalClose+840s < deadline(signalClose+902)
    const ds = {
      tf_seconds: 300,
      bars1m: bars(T0 + 300, 20, i => (i === pullBackAtMin
        ? { o: 105, h: 105.5, l: 99.5, c: 101 }
        : { o: 105, h: 105.5, l: 104.5, c: 105 })),
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds);
    assert.equal(t.fill_px, 100); // 成交了 → TTL 起点正确
  });
});

describe('engine: L4/L5 成交锚定与触发', () => {
  it('T2 回踩成交 → 涨到 TP：trigger=fill+2R，r=2', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        { time: T0 + 420, open: 101, high: 101.5, low: 99.5, close: 100.5, volume: 100 }, // 回踩 fill@100（当根不触TP/SL）
        ...bars(T0 + 480, 3, () => ({ o: 102, h: 104.5, l: 101.5, c: 104 })),         // high≥104 → TP
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds);
    assert.equal(t.outcome, 'TP');
    assert.equal(t.fill_px, 100);
    assert.equal(t.trigger, 104);
    assert.equal(t.r_multiple, 2);
    assert.equal(t.dollar, 80); // 4pt × $20 × 1
  });

  it('T3 成交后跌穿 SL：r=-1', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        { time: T0 + 420, open: 101, high: 101.5, low: 99.5, close: 100.5, volume: 100 },
        ...bars(T0 + 480, 3, () => ({ o: 100, h: 100.5, l: 97.5, c: 98 })), // low≤98 → SL
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds);
    assert.equal(t.outcome, 'SL');
    assert.equal(t.trigger, 98);
    assert.equal(t.r_multiple, -1);
    assert.equal(t.dollar, -40);
  });

  it('T4 同一根 bar 同时触及 TP 和 SL → 保守记 SL + ambiguous', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        { time: T0 + 420, open: 101, high: 101.5, low: 99.5, close: 100.5, volume: 100 },
        { time: T0 + 480, open: 101, high: 105, low: 97, close: 98, volume: 100 }, // both touched
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds);
    assert.equal(t.outcome, 'SL');
    assert.match(t.note, /ambiguous/);
  });

  it('T4b open 直接穿透挂单价 → 按开盘价成交（更优）', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        { time: T0 + 420, open: 99, high: 101, low: 98.5, close: 100, volume: 100 }, // open<px → fill@99
        ...bars(T0 + 480, 3, () => ({ o: 100, h: 103.5, l: 99.5, c: 103 })),          // tp=99+4=103
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds);
    assert.equal(t.fill_px, 99);
    assert.equal(t.outcome, 'TP');
  });
});

describe('engine: L3 规则C 位移', () => {
  it('T6 第二根5m K 阳线同向且追价>0 → 挂单移至其 low（一次性、受 30% cap）', () => {
    // entry_ref=100, sl=98 → rPts=2, cap=0.6。shift2 low=99.5 → shift=0.5 ≤0.6 ✓
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 12, i => (i === 10 ? { o: 101, h: 102, l: 99.2, c: 101.5 } : { o: 102, h: 102.5, l: 101.5, c: 102 })),
        { time: T0 + 300 + 12 * 60, open: 101, high: 101.5, low: 99.4, close: 100, volume: 100 }, // 回踩到 99.5 → fill
        ...bars(T0 + 300 + 13 * 60, 3, () => ({ o: 100, h: 103.5, l: 99.5, c: 103 })), // tp=99.5+4=103.5
      ],
      signals: [sigLong({ shift2: { o: 101, h: 102, l: 99.5, c: 101.5 } })],
    };
    const [t] = runBacktest(ds);
    assert.equal(t.shifted, true);
    assert.equal(t.fill_px, 99.5);
    assert.equal(t.outcome, 'TP');
  });

  it('T6b 位移超过 30% cap → 不移', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: bars(T0 + 300, 16, () => ({ o: 102, h: 102.5, l: 101.5, c: 102 })),
      signals: [sigLong({ shift2: { o: 101, h: 102, l: 98.5, c: 101.5 } })], // shift=1.5 > 0.6
    };
    const [t] = runBacktest(ds);
    assert.equal(t.shifted, false);
    assert.equal(t.outcome, 'EXPIRED');
  });

  it('T6c 阴线（实体不同向）→ 不移', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: bars(T0 + 300, 16, () => ({ o: 102, h: 102.5, l: 101.5, c: 102 })),
      signals: [sigLong({ shift2: { o: 101.5, h: 102, l: 99.5, c: 100.5 } })], // 阴线
    };
    const [t] = runBacktest(ds);
    assert.equal(t.shifted, false);
  });
});

describe('engine: L6/L8 占用与去重', () => {
  it('T5 持仓未平期间的新信号 → CENSORED', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        { time: T0 + 420, open: 101, high: 101.5, low: 99.5, close: 100.5, volume: 100 }, // sig1 fill
        ...bars(T0 + 480, 30, () => ({ o: 101, h: 101.5, l: 100.5, c: 101 })),        // 30min 不触 TP/SL
      ],
      signals: [sigLong(), sigLong({ bar_time: T0 + 1800, type: 'B2' })], // sig2 在持仓中
    };
    const [t1, t2] = runBacktest(ds);
    assert.equal(t1.outcome, 'OPEN_AT_END');
    assert.equal(t2.outcome, 'CENSORED');
    assert.equal(t2.note, 'occupied');
  });

  it('T9 同 (bar_time,dir) 去重 → 只跑一笔', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: bars(T0 + 300, 16, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
      signals: [sigLong(), sigLong()],
    };
    assert.equal(runBacktest(ds).length, 1);
  });
});

describe('engine: 对照组规则 A/B（live 未实现，开关验证）', () => {
  it('T7 ruleA：未成交直达 TP → 撤单', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 103, h: 103.5, l: 102.5, c: 103 })),
        { time: T0 + 420, open: 103, high: 104.5, low: 102.8, close: 104 }, // high≥104 且未回踩
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds, { rules: { A: true } });
    assert.equal(t.outcome, 'CANCELLED_RUNAWAY');
    assert.equal(t.note, 'ruleA');
  });

  it('T8 ruleB：30min 未到 TP → SL 移保本+、TP 降 1R，随后回踩 BE 离场', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        { time: T0 + 420, open: 101, high: 101.5, low: 99.5, close: 100.5, volume: 100 }, // 回踩 fill@100（当根不触TP/SL）
        ...bars(T0 + 480, 29, () => ({ o: 100.8, h: 101.5, l: 100.6, c: 101 })),      // 29min 窄幅
        { time: T0 + 480 + 29 * 60, open: 101, high: 101.5, low: 100.4, close: 100.5, volume: 100 }, // 第30min→arm；同根 low≤100.5
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds, { rules: { B: true } });
    assert.equal(t.outcome, 'SL');
    assert.equal(t.trigger, 100.5); // BE+2tick
    assert.match(t.note, /B_armed/);
    assert.equal(t.r_multiple, 0.25);
  });
});

describe('engine: SHORT 镜像', () => {
  it('T10 空单全路径：回踩成交 → 跌到 TP', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 95, h: 95.5, l: 94.5, c: 95 })),
        { time: T0 + 420, open: 95, high: 100.5, low: 95, close: 99, volume: 100 }, // 回踩 fill@100
        ...bars(T0 + 480, 3, () => ({ o: 99, h: 99.5, l: 95.5, c: 96 })),           // low≤96 → TP
      ],
      signals: [{ bar_time: T0, dir: 'SHORT', type: 'S', entry_ref: 100, sl: 102, tp: 96 }],
    };
    const [t] = runBacktest(ds);
    assert.equal(t.outcome, 'TP');
    assert.equal(t.fill_px, 100);
    assert.equal(t.trigger, 96);
    assert.equal(t.r_multiple, 2);
  });
});

describe('engine: L7b gateway R_TOO_SMALL 门', () => {
  it('T11 R=1pt 的信号在 minRPts 门下被拒', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: bars(T0 + 300, 16, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
      signals: [sigLong({ entry_ref: 100, sl: 99, tp: 102 })], // R=1
    };
    const [t] = runBacktest(ds, { minRPts: 5 });
    assert.equal(t.outcome, 'REJECTED');
    assert.equal(t.note, 'R_TOO_SMALL');
  });
});

describe('engine: guard 实盘守护（30m BE / 45m 强平）', () => {
  const fillBar = { time: T0 + 420, open: 101, high: 101.5, low: 99.5, close: 100.5, volume: 100 };
  const flat = (t0, n, o, h, l, c) => bars(t0, n, () => ({ o, h, l, c }));

  it('T13 30min 未到 TP → SL 移 BE，回踩 BE 离场（r≈0）', () => {
    // fill@100 at T0+480; 30min 后 BE=100；随后一根 low≤100
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        fillBar,
        ...flat(T0 + 480, 29, 100.8, 101.4, 100.6, 101),   // 29min 窄幅（不触 TP104/SL98）
        { time: T0 + 480 + 29 * 60, open: 100.9, high: 101.2, low: 99.8, close: 100.2, volume: 100 }, // 第30min arm BE，同根 low≤100
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds, { guard: { be_after_s: 1800, hard_exit_s: 2700 } });
    assert.equal(t.outcome, 'SL');
    assert.equal(t.trigger, 100);       // 纯 BE（be_ticks=0）
    assert.equal(t.r_multiple, 0);
    assert.match(t.note, /BE@30m/);
  });

  it('T14 45min 无 TP/SL → 强平 TIME_EXIT @close', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        fillBar,
        ...flat(T0 + 480, 44, 100.8, 101.4, 100.6, 101),   // 44min 窄幅（BE 在 30min 已 arm，但未回踩）
        { time: T0 + 480 + 44 * 60, open: 101, high: 101.4, low: 100.7, close: 101.2, volume: 100 }, // 第45min 强平
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds, { guard: { be_after_s: 1800, hard_exit_s: 2700 } });
    assert.equal(t.outcome, 'TIME_EXIT');
    assert.equal(t.trigger, 101.2);     // 该 bar close
    assert.match(t.note, /BE@30m/);
    assert.match(t.note, /hard@45m/);
    assert.equal(t.r_multiple, 0.6);    // (101.2-100)/2
  });

  it('T15 守护不影响 30min 内的正常 TP/SL', () => {
    const ds = {
      tf_seconds: 300,
      bars1m: [
        ...bars(T0 + 300, 2, () => ({ o: 105, h: 105.5, l: 104.5, c: 105 })),
        fillBar,
        ...bars(T0 + 480, 3, () => ({ o: 102, h: 104.5, l: 101.5, c: 104 })), // 3min 内 TP
      ],
      signals: [sigLong()],
    };
    const [t] = runBacktest(ds, { guard: { be_after_s: 1800, hard_exit_s: 2700 } });
    assert.equal(t.outcome, 'TP');
    assert.equal(t.r_multiple, 2);
    assert.ok(!/BE@/.test(t.note || ''));
  });
});

describe('engine v3: runBacktestV3 加仓滚仓', () => {
  // 干净序列：fill@101 (bar1 low>SL99)，TP@103 (bar3)，SL 区在 bar5 之后
  const mkBars = () => [
    { time: T0, open: 100, high: 100.5, low: 99.5, close: 100, volume: 0 },          // signal bar
    { time: T0 + 60, open: 100, high: 101.25, low: 99.75, close: 100.5, volume: 0 }, // touch 101 → fill
    { time: T0 + 120, open: 100.5, high: 102, low: 100.25, close: 101.5, volume: 0 },
    { time: T0 + 180, open: 101.5, high: 103.25, low: 101.25, close: 102, volume: 0 }, // TP 区
    { time: T0 + 240, open: 102, high: 104, low: 101.5, close: 103, volume: 0 },
    { time: T0 + 300, open: 103, high: 105, low: 97, close: 98, volume: 0 },           // SL 触及
  ];
  const baseOpts = { useInitialTP: true, initialTPRatio: 1, ttl_s: 300 };
  const sig = { bar_time: T0, dir: 'LONG', type: 'B', entry_ref: 101, sl: 99, tp: 103 };

  it('V1 第一 BOS 入场 + 初始 1:1 TP 出场', () => {
    const ds = { tf_seconds: 60, signals: [sig], add: [], flat: [], trail: [], bars1m: mkBars() };
    const [t] = runBacktestV3(ds, baseOpts);
    assert.equal(t.outcome, 'TP');
    assert.equal(t.r_multiple, 1); // 1:1
    assert.equal(t.size, 1);
  });

  it('V2 ADD 后停用 TP → 滚仓 trail SL 上移 → SL 触及全平', () => {
    const ds = {
      tf_seconds: 60, signals: [sig],
      add: [{ time: T0 + 180, type: 3, entry: 101, sl: 99 }],
      flat: [],
      trail: [{ time: T0 + 240, sl: 101.5 }],   // FVG 滚仓上移
      bars1m: mkBars(),
    };
    const [t] = runBacktestV3(ds, baseOpts);
    assert.equal(t.outcome, 'SL');
    assert.equal(t.size, 2);                     // 主 + ADD
    assert.ok(t.note && /ADD@/.test(t.note));
    assert.equal(t.trigger, 101.5);              // trail SL
    assert.equal(t.r_multiple, 0.75);            // fill@100, R=2, exit@101.5 → +1.5/2 = 0.75R
  });

  it('V3 反向 CHoCH flat → 市价全平', () => {
    // TP=102 会在 bar3 (high 103.25) 触发；flat 放 bar2 (T0+120) 抢先
    const ds = {
      tf_seconds: 60, signals: [sig],
      add: [], flat: [{ time: T0 + 120, px: 102.5 }], trail: [], bars1m: mkBars(),
    };
    const [t] = runBacktestV3(ds, baseOpts);
    assert.equal(t.outcome, 'FLAT_CHOCH');
    assert.equal(t.trigger, 102.5);
    assert.equal(t.size, 1);
  });
});
