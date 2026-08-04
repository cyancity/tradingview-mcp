import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { reconnectTo } from '../../connection.js';
import { readFileSync } from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Shared --target option for CDP-bound pine subcommands.
 * The CLI is otherwise pinned to the FIRST chart target found at connect
 * (see src/connection.js findChartTarget); with several browser tabs open
 * the Pine editor may live in a different tab than the one the CLI attached
 * to. --target lets the caller pick the tab explicitly.
 */
const targetOption = {
  target: { type: 'string', description: 'CDP target id to operate on (list with: tv pine targets)' },
};

/** If --target given, re-attach the CDP client to that target first. */
async function withTarget(opts, fn) {
  if (opts.target) {
    const listed = await core.listTargets();
    if (!listed.targets.some(t => t.id === opts.target)) {
      throw new Error(`Target ${opts.target} not found. Run "tv pine targets" for the current list.`);
    }
    await reconnectTo(opts.target);
  }
  return fn();
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from the VISIBLE editor',
      options: targetOption,
      handler: (opts) => withTarget(opts, () => core.getSource()),
    }],
    ['set', {
      description: 'Set Pine Script source into the VISIBLE editor (reads stdin or --file)',
      options: { ...targetOption, file: { type: 'string', short: 'f', description: 'Read source from file' } },
      handler: async (opts) => {
        return withTarget(opts, async () => {
          let source;
          if (opts.file) {
            source = readFileSync(opts.file, 'utf-8');
          } else {
            source = await readStdin();
          }
          if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
          return core.setSource({ source });
        });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      options: targetOption,
      handler: (opts) => withTarget(opts, () => core.smartCompile()),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      options: targetOption,
      handler: (opts) => withTarget(opts, () => core.compile()),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the VISIBLE editor buffer (Ctrl+S dispatched to the focused active editor)',
      options: targetOption,
      handler: (opts) => withTarget(opts, () => core.save()),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library) in the ACTIVE tab',
      options: targetOption,
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return withTarget(opts, () => core.newScript({ type }));
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name: activates its tab in the editor tab bar, loads the source into the VISIBLE editor, and verifies',
      options: targetOption,
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script"');
        return withTarget(opts, () => core.openScript({ name: positionals.join(' ') }));
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['targets', {
      description: 'List TradingView browser tabs (CDP targets) so pine commands can pick the right one with --target',
      handler: () => core.listTargets(),
    }],
    ['verify-tab', {
      description: 'Inspect the connected tab: is the Pine editor visible, which script tab is active, does the active tab match the editor buffer? Run before set/save to assert the right script is open.',
      options: targetOption,
      handler: (opts) => withTarget(opts, () => core.verifyTab()),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors from the VISIBLE editor',
      options: targetOption,
      handler: (opts) => withTarget(opts, () => core.getErrors()),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      options: targetOption,
      handler: (opts) => withTarget(opts, () => core.getConsole()),
    }],
  ]),
});
