import { register } from '../router.js';
import { analyze } from '../../core/copilot/analyzer.js';
import { analyzeFast } from '../../core/copilot/fast.js';

register('copilot', {
  description: 'Trading Copilot — ICT 客观分析',
  subcommands: new Map([
    ['fast', {
      description: 'Fast current-chart snapshot + local ICT (read-only, parallel)',
      options: {
        filter: { type: 'string', short: 'f', description: 'Pine study name filter (default iFVG; empty = all)' },
        bars: { type: 'string', short: 'n', description: 'Recent bars to read (default 100, max 500)' },
        indicators: { type: 'boolean', description: 'Include current data-window indicator values (redacted)' },
        visuals: { type: 'boolean', description: 'Also read Pine lines/labels/boxes' },
        drawings: { type: 'boolean', description: 'Read user drawings and their points (slower)' },
        'raw-bars': { type: 'boolean', description: 'Include all requested bars in output' },
        'require-layout': { type: 'string', description: 'Require an exact active layout name; never switches layout' },
      },
      handler: (opts) => analyzeFast({
        study_filter: opts.filter === undefined ? 'iFVG' : opts.filter,
        max_bars: opts.bars ? Number(opts.bars) : 100,
        include_indicators: Boolean(opts.indicators),
        include_visuals: Boolean(opts.visuals),
        include_drawings: Boolean(opts.drawings),
        include_bars: Boolean(opts['raw-bars']),
        require_layout: opts['require-layout'],
      }),
    }],
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
