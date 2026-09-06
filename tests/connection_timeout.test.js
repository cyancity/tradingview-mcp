import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../src/connection.js';

test('withTimeout resolves when the wrapped promise wins the race', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000, 'Fast op');
  assert.equal(result, 'ok');
});

test('withTimeout rejects with a descriptive error when the deadline passes', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 50, 'Hung renderer'),
    (err) => {
      assert.match(err.message, /Hung renderer timed out after 50ms/);
      assert.match(err.message, /TradingView is not responding/);
      return true;
    }
  );
});

test('withTimeout clears its timer after settling (no dangling handles)', async () => {
  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  await withTimeout(Promise.resolve('x'), 50, 'Cleanup check');
  await new Promise(r => setTimeout(r, 80));
  const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  assert.ok(after <= before, 'timer should be cleared after settling');
});
