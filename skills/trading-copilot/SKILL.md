---
name: trading-copilot
description: TradingView 当前盘面与 ICT 分析。当前 MNQ/iFVG 问题默认走快速并发快照；只有语义时间、多周期、用户绘图或视觉回写才升级深度分析。
---

# Trading Copilot Workflow

> 默认先收集可复核事实，再给 ICT 解读。当前盘面回答优先使用 `copilot_fast`，结论必须带证据、置信度和免责。

## Route selection

| 用户请求 | 路径 | 默认读取 |
| --- | --- | --- |
| “现在 MNQ 怎么看”“结合 iFVG 看盘” | `copilot_fast` / `tv copilot fast` | 当前 pane、layout、报价、100 根 OHLCV、iFVG table、本地 ICT |
| 指定“上周/昨天/最近 N 根/那根大阴线” | `copilot_analyze` | 时间解析、可定位 bars、完整报告 |
| 指定 4H/1H/15m、HTF/LTF 或多 pane | `copilot_analyze` | 当前周期 + 明确要求的 HTF，逐次复核状态 |
| 问手绘矩形/趋势线/Long/Short | `copilot_analyze`，或 fast 加 `include_drawings` | 用户绘图坐标与 K 线触碰/RR |
| 要截图、自动标记、视觉验收 | 深度路径 | 最后只截图一次 |

## Step 0: 先判定问题类型

1. 没有时间语义、没有多周期、没有手绘对象问题时，直接走快速路径，不先逐个调用 `state`、`quote`、`ohlcv` 和 Pine 工具。
2. “结合 iFVG”时默认 `study_filter="iFVG"`；不要用受保护的 `entity_id` 去读取指标输入。
3. 用户要求新闻、宏观事件或外部资料时，才并行启动外部搜索；普通盘面分析不调用 doctor/search。

## Step 1: 快速路径（默认）

优先一次调用 MCP `copilot_fast`，或执行：

    tv copilot fast --filter iFVG

默认参数与输出约定：

- 只读取 active pane，不切换 symbol、timeframe、layout，也不 focus 其他 pane。
- `max_bars=100`；输出摘要和最近 8 根，ICT 在本地纯函数计算。只有需要逐根核对时才加 `include_bars=true` / `--raw-bars`。
- 默认读取目标 Pine 指标的 `table`；只有需要指标线、标注、区域时才加 `include_visuals=true` / `--visuals`。
- 默认不读取用户绘图属性；只有用户明确问手绘对象时才加 `include_drawings=true` / `--drawings`。
- 默认不调用截图、不回写绘图、不读取保护性 inputs；需要当前数据窗口读数才加 `include_indicators=true` / `--indicators`，输出已经脱敏。
- 输出中的 `timings_ms.slowest` 是真实本次耗时，先看它再决定是否扩展采集范围。

快速并发契约：

1. `state`、`activeLayout`、`quote`、`ohlcv` 在同一 anchor batch 中用 `Promise.allSettled` 并发。
2. iFVG table、可选的 lines/labels/boxes、可选的 indicators/drawings 在同一 auxiliary batch 中并发。
3. 用户绘图属性只有在 `list` 返回后才启动，并发读取最多 20 个对象；这是唯一允许的 N+1 慢路径。
4. 任何一个 Pine/绘图读取失败都降级为 warning，不能丢掉 quote/OHLCV/ICT；不要因为一个可选字段失败而整轮重跑。
5. CLI 场景必须使用一次 `tv copilot fast`，不要开多个 `node src/cli/index.js` 进程分别读取事实；这样才能复用单个 CDP 连接。

## Step 2: 从 iFVG 表格提取事实

把表格内容当作指标事实，原样记录关键信息：

- `Setup`：方向和状态（例如 LONG/SHORT、TIGHT/WIDE、ACTIVE/WAITING）
- `Entry`、`Stop`、`TP1`、`TP2`：价格与点数距离
- `Size`、`Risk`：只作为指标显示的风险参数，不推导成下单指令
- 线、标签、box 若按需开启：记录其价格、区间、文字和来源指标

然后用 fast 输出的 `ict` 做交叉核对：

- 市场结构：trend、最近 BOS/CHoCH、结构置信度
- FVG/OB：方向、上下边界、是否 mitigated
- Liquidity：BSL/SSL、等高/等低、hunt
- Premium/Discount：当前收盘相对 equilibrium 的位置
- Killzone：仅按 bars 的时间事实描述，不把时段直接当作交易信号

报告中必须区分“iFVG 指标给出的 Setup/价位”和“ICT 引擎从 OHLCV 推导的结构”，两者不一致时明确指出，不替一方强行覆盖另一方。

## Step 3: 需要深度分析时升级

以下任一条件命中，改用 `copilot_analyze`：

- 有自然语言时间、单根 K 线描述或需要当前视口 fallback；
- 要多周期、HTF/LTF 或其他 pane；
- 要分析手绘坐标、趋势线触碰、Long/Short RR；
- 要 FVG/OB/流动性自动回写或截图；
- fast 的表格/状态读取失败，需要完整报告和 warning。

深度路径的事实抽取仍要并发独立读取：

- `chart_get_state`、`chart_get_visible_range`、OHLCV、quote；
- 已知指标才传 `study_filter` 的 Pine drawings；
- 用户绘图先 `draw action=list`，再对最多 20 个对象并发 `properties`；
- 不为“看起来完整”额外读取未请求的 source、verbose raw 或其他 pane。

## Step 4: 报告格式

快速问题也按下面的短格式回答，避免把采集过程变成冗长流水账：

1. **结论先行**：当前结构偏多/偏空/震荡；iFVG Setup 与状态。
2. **事实表**：symbol、timeframe、quote、OHLCV 区间、iFVG Entry/Stop/TP、状态和数据时间。
3. **ICT 交叉验证**：BOS/CHoCH、FVG/OB、BSL/SSL、Premium/Discount；每条附价格或 bar 时间证据。
4. **情景与失效条件**：只描述“若价格保持/失守某事实水平则结构如何变化”，不写无依据目标预测。
5. **数据质量**：列出 warnings、active layout、是否只分析 active pane；必要时指出需升级深度路径。
6. **免责**：本分析仅基于 TradingView 当前读取的历史 K 线、指标和绘图事实，不构成投资建议；Bias 不是交易指令。

## Step 5: 视觉确认与安全边界

这一阶段必须做一致性校验：文字报告的价格边界与回写对象的 points 严格相等。

只有用户明确要求或深度路径生成了 `drawingsToCreate` 时：

1. 回写 FVG/OB/流动性前，核对文字报告的 `top/bottom` 与 rectangle `points` 价格严格相等。
2. 所有回写完成后只调用一次 `capture_screenshot region=chart`。
3. 不要把 screenshot 当作替代结构化事实的理由，也不要在 fast 默认路径里截图。

TradingView 操作遵守 `pinescript-deployment` 规则：iFVG 正式运行/告警使用 `iFVG` layout；开发/测试使用 `StrategyTester`；fast 只校验 active layout，`require_layout` 不会自动切换。任何 layout、symbol、timeframe 或 pane 变化后都要重新读取 active state。

## 不要走的慢路径

- 不要为当前盘面先跑完整 `copilot_analyze` 再重复读取 iFVG。
- 不要默认 `data_get_study` 全量、四类 Pine 图形、20 个 user drawing 属性和截图全部开启。
- 不要连续 focus pane 来“确认一下”，这会引入状态漂移和额外等待；多周期是显式升级项。
- 不要把外部新闻搜索、浏览器截图或页面可视化当成普通盘面分析的必经步骤。
