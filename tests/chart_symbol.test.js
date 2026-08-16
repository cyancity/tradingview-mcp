import test from 'node:test';
import assert from 'node:assert/strict';

import { setSymbol } from '../src/core/chart.js';

function depsWithSymbols(symbols) {
  let setCalls = 0;
  let reads = 0;
  return {
    deps: {
      evaluateAsync: async () => { setCalls += 1; },
      evaluate: async () => symbols[Math.min(reads++, symbols.length - 1)],
      waitForChartReady: async () => false,
    },
    setCalls: () => setCalls,
  };
}

test('setSymbol retries when a cold chart ignores the first switch', async () => {
  const fixture = depsWithSymbols(['BATS:QQQ', 'AMEX:SPY']);

  const result = await setSymbol({ symbol: 'SPY', _deps: fixture.deps });

  assert.equal(result.success, true);
  assert.equal(result.actual_symbol, 'AMEX:SPY');
  assert.equal(result.attempts, 2);
  assert.equal(fixture.setCalls(), 2);
});

test('setSymbol reports failure when the chart never confirms the request', async () => {
  const fixture = depsWithSymbols(['BATS:QQQ']);

  const result = await setSymbol({ symbol: 'SPY', _deps: fixture.deps });

  assert.equal(result.success, false);
  assert.equal(result.actual_symbol, 'BATS:QQQ');
  assert.equal(result.attempts, 2);
  assert.match(result.error, /did not switch/i);
});
