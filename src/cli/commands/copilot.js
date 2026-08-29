import { register } from '../router.js';
import { analyze } from '../../core/copilot/analyzer.js';

register('copilot', {
  description: 'Trading Copilot — ICT 客观分析',
  subcommands: new Map([
    ['analyze', {
      description: 'Analyze chart with ICT (default) — question + semantic time + drawings/indicators',
      options: {
        time: { type: 'string', short: 't', description: '语义时间：如 \"上周\" / \"2025-08-20那根大阴线\" / \"最近50根\"' },
        ict: { type: 'boolean', description: '启用 ICT 分析（默认 true，--no-ict 关闭）' },
        'no-ict': { type: 'boolean', description: '关闭 ICT，走通用分析' },
        'max-bars': { type: 'string', description: '最多分析 K 线数（默认 200，max 500）' },
        'no-visuals': { type: 'boolean', description: '不返回视觉回写指令' },
      },
      handler: async (opts, positionals) => {
        const question = positionals.join(' ').trim();
        if (!question) throw new Error('Usage: tv copilot analyze \"你的问题\" [--time \"上周\"] [--no-ict] ');
        const useIct = opts['no-ict'] ? false : (opts.ict !== undefined ? Boolean(opts.ict) : true);
        const maxBars = opts['max-bars'] ? Number(opts['max-bars']) : 200;
        const createVisuals = !opts['no-visuals'];
        return analyze({
          question,
          time: opts.time,
          use_ict: useIct,
          max_bars: maxBars,
          create_visuals: createVisuals,
        });
      },
    }],
  ]),
});
