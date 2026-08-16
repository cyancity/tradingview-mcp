import assert from 'node:assert/strict';
import test from 'node:test';

import { isLandingTarget, waitForLandingTarget } from '../src/core/tab.js';

test('landing target is recognized by Desktop URL before its title is populated', () => {
  assert.equal(isLandingTarget({
    type: 'page',
    title: '',
    url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/new-tab/index.html?tab=1',
  }), true);
  assert.equal(isLandingTarget({
    type: 'page',
    title: 'New tab',
    url: '',
  }), true);
  assert.equal(isLandingTarget({
    type: 'page',
    title: 'Chart',
    url: 'https://www.tradingview.com/chart/abc/',
  }), false);
});

test('landing target polling tolerates a delayed renderer target', async () => {
  const target = {
    id: 'landing-1',
    type: 'page',
    title: '',
    url: 'file:///app/new-tab/index.html?tab=1',
  };
  const responses = [[], [], [target]];
  let sleeps = 0;

  const found = await waitForLandingTarget({
    attempts: 4,
    delayMs: 0,
    listTargets: async () => responses.shift() ?? [],
    sleep: async () => { sleeps += 1; },
  });

  assert.deepEqual(found, target);
  assert.equal(sleeps, 2);
});

test('landing target polling returns null after its bounded attempts', async () => {
  let calls = 0;
  const found = await waitForLandingTarget({
    attempts: 3,
    delayMs: 0,
    listTargets: async () => { calls += 1; return []; },
    sleep: async () => {},
  });

  assert.equal(found, null);
  assert.equal(calls, 3);
});
