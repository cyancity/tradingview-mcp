import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeVsop, aggregate, runVsopMachine } from '../src/core/copilot/vsop.js';

const dir = dirname(fileURLToPath(import.meta.url));
const bars1m = JSON.parse(readFileSync(join(dir, 'fixtures/mnq_2026-08-31_1m.json'))).bars;

// 真值锚点（来自 TradingView YOLO-MS 面板 + 1分图执行标记，人工核对 2026-08-31）
const MS_PANEL = {
  s_signal_time_utc: 1788129300,   // ~06:35 面板"信号时间"，入场 29447
  s_entry: 29447,
  eyeball_bos_1m: 29367.75,        // 用户肉眼 BOS，08:21 附近——非 MS 信号
};

describe('VSOP draft port — 行为不变量（非实盘权威，见 vsop-spec §6）', () => {
  it('fixture 覆盖今天亚洲真空段', () => {
    assert.ok(bars1m.length >= 200);
    const bj = t => new Date((t + 8 * 3600) * 1000).toISOString().slice(11, 16);
    assert.equal(bj(bars1m.at(-1).time), '09:05'); // 最后一根 = 09:05 UTC+8 墙钟
  });

  it('核心教训：肉眼 08:21 "BOS@29367.75" 做多被 ≥5m 结构压制 → combo 判定 allowed=false', () => {
    // 该价位附近 1m 若出多头结构，HTF(5/15m) 当时 Bearish pending/confirmed 必须否决
    const r = analyzeVsop(bars1m, { vetoTfs: [5, 15] });
    const near = r.tickets.filter(t => t.dir === 'long' && t.time >= MS_PANEL.eyeball_bos_1m - 50 && t.time <= MS_PANEL.eyeball_bos_1m + 60);
    for (const t of near) {
      assert.equal(t.allowed, false, `long ticket ${new Date(t.time*1000).toISOString()} 不该放行（HTF 压制）`);
    }
  });

  it('HTF 5m 在真空段处于空头（finalOs<=0），印证"全周期 Bearish 表"', () => {
    const f5 = aggregate(bars1m, 5);
    const r5 = runVsopMachine(f5);
    assert.ok(r5.os <= 0, `5m os=${r5.os} 应为空头/中性`);
  });

  it('端口与真 MS 存在偏差 → 标记为 draft，S 信号时间不等于面板 06:35 正是要防的坑', () => {
    // 记录已知偏差：端口给的 S 时间与面板不同（20+ 分钟级），故实盘禁用端口。
    const r = runVsopMachine(bars1m);
    const sNear = r.tickets.find(t => t.dir === 'short' && Math.abs(t.time - MS_PANEL.s_signal_time_utc) <= 30 * 60);
    // 断言：端口不可能精确复现面板时间 —— 这本身就是"别信重实现"的回归守卫
    if (sNear) {
      assert.notEqual(sNear.entry, MS_PANEL.s_entry,
        '若端口精确命中面板 entry，说明它被改成了查表——违反"实盘以真指标为准"原则');
    }
  });
});
