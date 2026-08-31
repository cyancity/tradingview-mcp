# 改造计划：YOLO-MS v3 —— 3-bar swing + FVG 过滤 + 滚仓

> 2026-09-01 · 用户裁决。目标：把 MS 策略从「5-bar swing + 固定 1:2 出场」改回「3-bar swing + FVG 校验 + 滚仓出场」，量化每次改动的贡献。

## 0. 现状与目标

### 现状（yolo-ms-backtest.pine，commit 97ef09c 后）
- `auto_len = tf_min <= 60 ? 5 : 7` → 1-5m 用 **5-bar swing**（8-24 从 3 改成 5，理由是「3 was too sensitive」）
- 入场：CHoCH → pending → 第一 BOS → B/S 信号（水平位挂单）
- Fake CHoCH → FB/FS（趋势延续信号）
- 出场：固定 TP = 1:2（或 1:1），SL = 信号K+前一根极值 ∓ 1pt
- 状态：os ∈ {1 bull, 2 bull-pending, -1 bear, -2 bear-pending, 0 neutral}

### 目标（用户裁决 2026-09-01）
1. **3-bar swing**：1-5m 全部用 3-bar 判 swing（回到 97ef09c 之前），大周期 15m/1h 保持 5-bar，4h/1d 保持 7-bar
2. **FVG 过滤（开关）**：1-5m 的 BOS 突破**必须伴随 FVG** 才产生信号；CHoCH 也加 FVG 过滤（独立开关，方便统计）
3. **第二 BOS 无条件加仓**（无 FVG 要求），水平位挂单，止损 = 同一 swing low/high
4. **滚仓出场**：加仓后取消固定 TP → 每个新 FVG 把止损上移到该 FVG 3 根 K 的第一根低点（多）/高点（空）→ 直到反向 CHoCH 或止损触及 → **全部平仓**

## 1. 需要确认的口径（已确认）

| 项 | 裁决 |
|---|---|
| FVG 定义 | 3-bar luxalgo 标准：`bullFvg = low > high[2] and close > high[2]`（当前 bar 收盘时判定缺口成立） |
| FVG 周期范围 | 1-5m 全部要求 FVG 才出信号（开关可关） |
| CHoCH FVG | 独立开关，默认关（便于对照统计） |
| 3-bar swing 范围 | 仅 1-5m；15m/1h 5-bar；4h/1d 7-bar |
| 加仓时机 | 第二 BOS（同向续破）无条件加仓，无 FVG 要求 |
| 加仓止损 | 同一 swing low/high（主信号同结构位） |
| 滚仓触发 | 每个新 FVG → 止损上移到该 FVG 3 根中第一根的低点/高点 |
| 全部平仓 | 反向 CHoCH 出现 → 加仓+底仓全部市价平 |

## 2. 工作分解

### Phase A：Pine 指标改造（strategy-validator/pinescript/indicators/yolo-ms-backtest.pine）

**A1. 3-bar swing**
```pine
auto_len = current_tf_min <= 5 ? 3 : current_tf_min <= 60 ? 5 : 7
```
同时改 MTF dashboard 里的 `f_get_structure_state()`（第 525 行同样逻辑）。`p = int(length/2)` → 3-bar 时 p=1。

**A2. FVG 检测（新增）**
```pine
// 3-bar FVG (luxalgo): 当前 bar 收盘时, low > high[2] (bull) / high < low[2] (bear)
bull_fvg = low > high[2] and close > high[2]
bear_fvg = high < low[2] and close < low[2]
```
- 信号 bar 收盘（confirmed）时判定
- 输入：`use_fvg_filter`（BOS 信号要求 FVG，默认关）、`fvg_on_choch`（CHoCH 要求 FVG，默认关）

**A3. 信号门控**
- B/S 第一 BOS：`if showEntrySignals and bull_choch_happened and bull_bos_seq == 1 and (not use_fvg_filter or bull_fvg)`
- FB/FS：同样逻辑（Fake CHoCH 后的趋势延续信号）
- CHoCH 置位：`sig_bull_choch := use_fvg ? bull_fvg : true`（FVG 开关作用于 CHoCH 是否计入）
- 反向 BOS（via protected levels）分支同样加 FVG 门控

**A4. 第二 BOS 加仓 + 滚仓（新增状态机）**
- 新增 `var float trail_sl = na`、`var int add_count = 0`
- 第一 BOS：`trail_sl := swing_low`（当前 lower.value 或 bull_bos_low）
- 第二 BOS（bull_bos_seq == 2 且 os==1）：
  - 出加仓信号（新 plot `bk_add`，type 3/-3）
  - `trail_sl := lower.value`（同一 swing low）
  - 取消固定 TP → 进入滚仓模式
- 每个新 FVG（bull_fvg 成立时）：`trail_sl := low[2]`（FVG 3 根中第一根低点）
- 反向 CHoCH（os 从 1 → -2）：标记全平事件（`bk_add_exit`）
- 滚仓模式下不再用 tpRatio 出场，只跟踪 trail_sl

**A5. 账本扩展**
- 新 plot：`bk_trail_sl`（当前跟踪止损）、`bk_add`（加仓标记 1/-1/0）、`bk_add_exit`（反向 CHoCH 平仓标记）
- bk_type 扩展：3 = ADD-LONG, -3 = ADD-SHORT（或复用 bk_add 字段标记）

### Phase B：engine 扩展（tradingview-mcp/src/backtest/engine.js）

**B1. 加仓撮合**
- ADD 信号：水平位挂单（entry = 同 swing 突破位），SL = swing low/high（不是信号K极值）
- TTL/规则 C 同主信号
- 加仓成交后进入「滚仓」模式：不再按 tpRatio 出场，改用 trail_sl

**B2. 滚仓出场**
- 新增 `trailMode: true` 选项
- 每个新 FVG（信号序列中）→ trail_sl 上移
- 反向 CHoCH → 全部平仓（`EXIT_CHOCH` outcome）
- 价格触及 trail_sl → 平仓（`TRAIL_SL` outcome）
- 底仓 + 加仓分开记录，合并汇总

**B3. 测试**
- 加仓撮合：第二 BOS 在水平位成交、SL 同 swing
- 滚仓：FVG 上移止损、反向 CHoCH 全平、触及 trail_sl 出场
- 主信号 1:1 TP 在加仓后停用

### Phase C：回测矩阵与报告

**C1. 数据**：复用已保存的 7月/8月 数据集（1m/2m/3m/5m），改 Pine 后重新提取账本（需重新连 TV 拉数据让指标重算）

**C2. 矩阵**
```
基线(5-bar,无FVG,固定1:2) × 3-bar swing × +FVG-BOS × +FVG-CHoCH × +加仓滚仓
= 4-6 个配置 × 5 数据集
```
关键对照：
- 3-bar vs 5-bar（swing 敏感性对信号质量的影响）
- FVG 过滤 on/off（砍掉多少假信号、胜率提升多少）
- 加仓滚仓 vs 固定 TP（趋势行情的收益捕捉差异）

**C3. 报告**：vol8，逐配置对比 + 结论（哪些改动真正提升期望）

## 3. 风险与注意

- **改 Pine 后需重连 TV 重算历史**：指标改 swing/FVG 逻辑后，历史信号全部变化，必须重新 requestMoreData + 提取账本
- **FVG 开关默认关**：保证与现版本二进制兼容，可随时对照
- **3-bar swing 更敏感**：97ef09c commit 显示 3→5 是因为「太敏感」（假 swing 多）——但用户要回 3-bar + FVG 过滤的组合，FVG 可能就是用来抑制 3-bar 的过度敏感
- **滚仓无固定 TP**：单笔可能从大赢变平/小亏（trail 触发），需在报告里诚实展示
- **样本量**：FVG 过滤后信号减少（7月 5m 134→预计 40-60），单月统计可靠性下降，需多月数据

## 4. 交付物

1. `yolo-ms-backtest.pine` v3（3-bar swing + FVG 开关 + 加仓滚仓 + 账本扩展）
2. engine.js 加仓/滚仓支持 + 测试
3. vol8 回测报告（矩阵对照）
4. 更新后的数据集文件（重新提取）

## 5. 待确认（如果用户有异议）

- 加仓信号在图表上如何标注？（label "ADD" / 表格行扩展）
- 滚仓止损上移是否每根 bar 检查 FVG，还是只在信号 bar 检查？（默认：每根 confirmed bar 检查，FVG 成立即上移）
- 反向 CHoCH 全平时，是否包含 FB/FS 引发的底仓？（默认：全部仓位，含底仓）
