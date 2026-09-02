# Trading Copilot 快速路径性能记录

这份 reference 只记录流程与可验证的性能约束；它不是交易策略，也不改变 iFVG 的信号定义。

## 上一轮耗时审计

上一轮 MNQ/iFVG 分析的“约 15 分钟”不能全部归因于单个 API。工具输出里能确认的热点如下：

| 环节 | 上一轮观察 | 影响 |
| --- | --- | --- |
| 独立 CLI 读取 state/quote/OHLCV/Pine | 每个 node src/cli/index.js 都要重新发现/attach CDP target | 固定连接成本重复发生，也可能产生并发 client 竞争 |
| copilot_analyze | 单次工具 wall time 约 0.5s，但输出约 1121 行、16.5k tokens | 主要拖慢上下文处理，不是 CPU 计算慢 |
| screenshot | 一次调用 wall time 约 6.7s | 当前盘面不需要视觉确认时属于纯额外等待；遇到 broker modal 还会降低可用性 |
| Pine 读取 | lines/labels/boxes/tables 四类全部查询，即使只需要 iFVG table | 多次 CDP evaluate 与无关输出 |
| user drawings | list 后再逐个 properties，最多 20 个 | 必须在 list 之后才能做，属于真正的 N+1 慢路径 |
| pane focus/timeframe 恢复 | 多次 focus 和重读状态 | 会触发图表状态漂移与重复等待；当前盘面问题并不需要它 |
| 外部 doctor/search | doctor 约 2.8s，外部搜索约 4–9s | 只有新闻/宏观问题才有收益，普通盘面不应启动 |

这些是已观察到的工具耗时/输出量，不把未测量的模型思考时间伪装成精确分项；copilot_fast.timings_ms 会给出每次真实执行的分项。

## 新路径的预算模型

~~~
一次 copilot_fast
  ├─ anchor 并发: state + activeLayout + quote + OHLCV
  ├─ auxiliary 并发: iFVG table
  │                 + (按需) indicators / lines / labels / boxes / drawings list
  ├─ (按需) drawing properties 并发: 最多 20 个
  └─ 本地 ICT: 不再经过 CDP
~~~

输出必须检查：

- timings_ms.total：本次完整 wall time；
- timings_ms.slowest：最慢的五个真实任务；
- meta.one_connection_batch=true：确认调用走的是批量路径；
- warnings：单个可选读取失败时只降级，不整轮重跑。

## 取舍

快速路径默认牺牲三项非必要信息以换取稳定时间：

1. 不解析自然语言日期，不定位“那根大阴线”；这类问题升级 copilot_analyze。
2. 不读取用户手绘对象属性；只有用户提到手绘对象才打开 include_drawings。
3. 不截图、不回写、不读取保护性 indicator inputs；需要视觉验收时单独进入深度路径。

OHLCV 仍由本地 ICT 引擎分析，因此快速输出不是只有“报价”；它同时给出结构、FVG、OB、Liquidity、Premium/Discount 和 Killzone 的紧凑事实。iFVG table 与 ICT 结果必须分栏呈现，不能把模型推导冒充指标原值。

## 手动 fallback 的并发模板

如果 copilot_fast 不可用，至少把独立读取放进一个并发批次：

~~~
const results = await Promise.allSettled([
  chart_get_state(),
  chart_get_visible_range(),
  data_get_ohlcv({ count: 100 }),
  quote_get(),
  data_get_pine_drawings({ kind: 'table', study_filter: 'iFVG' }),
]);
~~~

只对成功结果继续分析；不要因为一个 Pine primitive 缺失而重复整批请求。lines/labels/boxes、指标值和 user drawings 作为第二层按需并发。
