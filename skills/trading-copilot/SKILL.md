---
name: trading-copilot
description: Trading Copilot — 用 ICT 客观分析图表，结合用户绘图/指标/K线回答问题。支持语义时间区间与单根K线定位，自动视觉回写。未指定策略默认 ICT。
---

# Trading Copilot Workflow

> 默认自动走 copilot，无需用户显式指定 ICT。所有判断必须带事实佐证 + 置信度，报告末尾强制免责。

## Step 0: 理解问题与时间

1. 读取用户 `question`（自然语言）与可选 `time`（语义时间）
2. 优先用 `copilot_analyze` 的时间解析：
   - 显式：`2025-08-20` / `2025-08-01 to 2025-08-15`
   - 相对：`最近50根` / `近7天`
   - 自然：`上周` / `昨天` / `今天`（均按 America/New_York）
   - NY Killzone：`纽约开盘` → 当天 8-11am ET
   - 模糊单根：`那根大阴线` / `长上影` → 由 analyzer 在 bars 中搜索
3. 若解析 `confidence=low`，在报告开头回显 `from/to` 供用户确认

## Step 1: 事实抽取（并行）

调用 `copilot_analyze`（或手动并行）：
- `chart_get_state` → 品种/周期/指标 entity_ids
- `chart_get_visible_range` → 当前视口
- `data_get_ohlcv count=200`（默认，不传即 200；用户提多周期才额外拉 HTF）
- `data_get_study`（全量，可选对关键指标拉 series）
- `data_get_pine_drawings kind=line/label/box/table`（若有 Pine）
- `draw action=list` + 前 20 个 `draw action=properties`（含 ray/long_position/short_position 的 2/3 点）
- `quote_get` → 实时价

> 多周期按需：仅当 `question` 含 `多周期/4H/日线/15m/HTF` 等才额外拉取，否则默认当前周期

## Step 2: 选择分析路径

- `use_ict=true`（默认）→ 走 ICT 引擎：市场结构(BOS/CHoCH) → FVG → OB → 流动性(Equal Highs/Lows/BSL/SSL) → Premium/Discount + OTE → Killzone
- `use_ict=false` → 通用：支撑/阻力（rectangle/horizontal_line）、趋势线有效性（触碰次数/突破）、Long/Short RR 校验
- 无论哪条路径，都计算 `generic` 供交叉验证

## Step 3: 生成报告

`copilot_analyze` 返回结构化 `report` Markdown，按此顺序：

```
# Trading Copilot 分析报告 — {symbol} {timeframe} {label}
## 1. 事实摘要
- 品种/周期/区间（NY + UTC 双标注）/当前价/bars数/绘图数/指标数
- K线事实：区间高低、振幅、成交量分位、关键 Bars 引用
- 绘图事实：每个 drawing 的点位/区间/斜率/RR
- 指标读数：RSI/MACD/EMA 等当前值
## 2. ICT 解读（或通用解读）
- 市场结构：trend + BOS/CHoCH 列表（带 level/brokenAt）
- FVG：bull/bear 列表 + 是否 mitigated
- Order Blocks：zone + formedAt
- 流动性：equalHighs/equalLows + BSL/SSL + hunts
- Premium/Discount + OTE
- Killzone：bars 所在时段
## 3. 与问题关联
- 逐条回答 question，引用证据索引（bar time/drawing id/indicator）
- Bias（若结构明确）：bullish/bearish/neutral + 置信度 high/med/low + 证据
## 4. 视觉标记
- 建议回写的绘图：FVG→ rectangle(半透明), OB→ rectangle, 流动性→ horizontal_line
## 5. 风险与免责
> 本分析仅基于历史K线与绘图事实，不构成投资建议。市场有风险，入市需谨慎。所有判断均标注置信度与证据来源，低置信度结论请结合其他信息验证。
```

每个判断必须附 `证据 + 置信度`，禁止无证据预测。

## Step 4: 视觉确认（带验收）

1. 若 `drawingsToCreate` 非空，用 `draw action=shape` 逐个回写到图上：
   - FVG: `shape=rectangle, points=[{time:leftTime, price:top}, {time:rightTime, price:bottom}], overrides='{\"color\":\"rgba(0,255,0,0.2)\"}'`
   - OB: 同上，`color: rgba(255,165,0,0.2)`
   - 流动性: `shape=horizontal_line, point={time:barTime, price:level}`
2. `capture_screenshot region=chart` 截图
3. **一致性校验**：文字报告中的 `FVG top/bottom` 必须等于回写 `rectangle` 的 `points[0].price / points[1].price`，否则视为 bug（测试中比对）
4. 截图与报告一并返回用户

## Step 5: 清理（可选）

- 若回写为临时分析，提示用户 `draw action=clear` 可清除，或保留供后续讨论

## 触发规则

- 任何关于图表分析的问题，默认先调 `copilot_analyze`，再自由发挥
- 显式 `time` 优先于从 question 中解析
- 绘图缺失时提示“请先在 TV 中绘制矩形/趋势线/射线/Long/Short，再提问”

## 上下文管理

- `max_bars` 默认 200，最大 500，超限截断并提示
- 绘图超过 20 个时仅取前 20，提示用户
- 多周期数据仅按需拉取，避免上下文膨胀
