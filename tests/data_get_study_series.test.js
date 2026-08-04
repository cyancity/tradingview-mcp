/**
 * Unit tests for getStudySeries — the display.none plot reader behind
 * data_get_study_series.
 *
 * Run: node --test tests/data_get_study_series.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStudySeries } from '../src/core/data.js';

// Mock evaluate: the injected expression serializes to a JS string; we
// emulate the study source lookup and row mapping directly.
function mockDeps({ sourceFound = true, titles = ['PDH', 'ENV_1M', 'POI1_META'], rows = [] } = {}) {
  const calls = [];
  const evaluate = async (expr) => {
    calls.push(expr);
    if (!sourceFound) return { error: 'Study source not found: nope' };
    const start = expr.match(/start = Math\.max\(d\.firstIndex\(\), last - (\d+) \+ 1\)/);
    const limit = start ? Number(start[1]) : 1;
    return {
      bars: rows.slice(-limit).map((row) => ({
        time: row[0],
        plots: Object.fromEntries(titles.map((t, i) => [t, Number.isFinite(row[i + 1]) ? row[i + 1] : null])),
      })),
      plot_count: titles.length,
    };
  };
  evaluate.calls = calls;
  return { _deps: { evaluate }, calls };
}

describe('getStudySeries() — raw plot series reader', () => {
  it('rejects a missing entity_id', async () => {
    await assert.rejects(() => getStudySeries({ _deps: mockDeps()._deps }), /entity_id/);
  });

  it('returns one bar with all plot titles by default', async () => {
    const rows = [[1000, 28965, 11, 131]];
    const { _deps } = mockDeps({ rows });
    const r = await getStudySeries({ entity_id: 'study_1', _deps });
    assert.equal(r.success, true);
    assert.equal(r.bar_count, 1);
    assert.equal(r.plot_count, 3);
    assert.deepEqual(r.bars[0], { time: 1000, plots: { PDH: 28965, ENV_1M: 11, POI1_META: 131 } });
  });

  it('converts na plot values to null', async () => {
    const rows = [[1000, 28965, NaN, 131]];
    const { _deps } = mockDeps({ rows });
    const r = await getStudySeries({ entity_id: 'study_1', _deps });
    assert.equal(r.bars[0].plots.ENV_1M, null);
  });

  it('limits to the requested trailing count', async () => {
    const rows = [[1, 10, 20], [2, 11, 21], [3, 12, 22], [4, 13, 23]];
    const { _deps } = mockDeps({ titles: ['ENV_1M', 'ENV_5M'], rows });
    const r = await getStudySeries({ entity_id: 'study_1', count: 2, _deps });
    assert.equal(r.bar_count, 2);
    assert.deepEqual(r.bars.map((b) => b.time), [3, 4]);
  });

  it('caps count at 500', async () => {
    const { _deps, calls } = mockDeps({ rows: [[1, 2]] });
    await getStudySeries({ entity_id: 'study_1', count: 9999, _deps });
    assert.match(calls[0], /last - 500 \+ 1/);
  });

  it('throws when the study source is not found', async () => {
    const { _deps } = mockDeps({ sourceFound: false });
    await assert.rejects(() => getStudySeries({ entity_id: 'nope', _deps }), /Study source not found/);
  });
});
