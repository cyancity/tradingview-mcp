import { z } from 'zod';

export const group = 'copilot';

export const tools = [
  {
    name: 'copilot_fast',
    description: 'Trading Copilot 快速路径 — 单次连接并发读取当前图表、报价、OHLCV 与 iFVG Pine 表格，并在本地计算 ICT；默认不截图、不读取用户绘图属性、不输出保护性输入。',
    schema: {
      study_filter: z.string().optional().describe('Pine 指标名称过滤，默认 iFVG；传空字符串表示不筛选'),
      max_bars: z.coerce.number().optional().describe('读取最近多少根 K 线（默认 100，最大 500）'),
      include_indicators: z.coerce.boolean().optional().describe('是否读取并脱敏当前数据窗口指标值（默认 false）'),
      include_visuals: z.coerce.boolean().optional().describe('是否并发读取 Pine lines/labels/boxes（默认 false）'),
      include_drawings: z.coerce.boolean().optional().describe('是否读取用户绘图及坐标（默认 false，较慢）'),
      include_bars: z.coerce.boolean().optional().describe('是否把全部 K 线放入输出（默认 false，仅保留最近 8 根+摘要）'),
      require_layout: z.string().optional().describe('要求当前布局名称精确匹配；只校验，不自动切换布局'),
    },
    handler: async (args) => {
      const fast = await import('../core/copilot/fast.js');
      return fast.analyzeFast(args);
    },
  },
  {
    name: 'copilot_analyze',
    description: 'Trading Copilot — 结合图表绘图/指标/K线，对用户问题做客观事实分析。未指定策略默认 ICT（use_ict true）。支持语义时间区间/单根K线定位、多周期按需、自动视觉回写标记。',
    schema: {
      question: z.string().describe('用户问题（自然语言）'),
      time: z.string().optional().describe('语义时间：如 "上周" / "2025-08-20那根大阴线" / "最近50根" / "2025-08-01 to 2025-08-15"，不传则用当前视口'),
      use_ict: z.coerce.boolean().optional().describe('是否用 ICT 分析（默认 true）'),
      include_drawings: z.coerce.boolean().optional(),
      include_indicators: z.coerce.boolean().optional(),
      max_bars: z.coerce.number().optional(),
      create_visuals: z.coerce.boolean().optional().describe('是否返回视觉回写绘图指令（默认 true，调用方可据此调 draw 创建）'),
    },
    handler: async (args) => {
      const analyzer = await import('../core/copilot/analyzer.js');
      return analyzer.analyze(args);
    },
  },
];
