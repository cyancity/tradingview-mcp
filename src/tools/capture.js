import { z } from 'zod';
import * as core from '../core/capture.js';

export const group = 'capture';

export const tools = [
  {
    name: 'capture_screenshot',
    description: 'Take a screenshot of the TradingView chart',
    schema: {
      region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
      filename: z.string().optional().describe('Custom filename (without extension)'),
      method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
      wait_for_render: z.boolean().optional().describe('Wait for the chart canvas to stabilize before capturing. Use after chart_set to avoid stale frames.'),
    },
    handler: ({ region, filename, method, wait_for_render }) =>
      core.captureScreenshot({ region, filename, method, waitForRender: wait_for_render }),
  },
];
