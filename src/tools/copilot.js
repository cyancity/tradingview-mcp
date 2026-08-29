import { z } from 'zod';

export const group = 'copilot';

export const tools = [
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
