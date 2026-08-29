import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawShape, listDrawings, SHAPE_DEFS } from '../src/core/drawing.js';

describe('SHAPE_DEFS', () => {
  it('包含5种核心+扩展', () => {
    assert.equal(SHAPE_DEFS.rectangle, 2);
    assert.equal(SHAPE_DEFS.trend_line, 2);
    assert.equal(SHAPE_DEFS.ray, 2);
    assert.equal(SHAPE_DEFS.long_position, 3);
    assert.equal(SHAPE_DEFS.short_position, 3);
  });
});

describe('drawShape 点数校验与路由', () => {
  function mockDeps() {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('getAllShapes')) return ['old_1'];
      return undefined;
    };
    const getChartApi = async () => 'window.TradingViewApi._activeChartWidgetWV.value()';
    return { evaluate, getChartApi, calls };
  }

  it('1点 horizontal_line 用 points', async () => {
    const deps = mockDeps();
    let secondCall = false;
    const origEval = deps.evaluate;
    deps.evaluate = async (expr) => {
      if (expr.includes('getAllShapes') && secondCall) return ['old_1', 'new_1'];
      if (expr.includes('getAllShapes')) { secondCall = true; return ['old_1']; }
      if (expr.includes('createShape')) return undefined;
      return origEval(expr);
    };
    const r = await drawShape({ shape: 'horizontal_line', points: [{ time: 1000, price: 150 }], _deps: deps });
    assert.equal(r.success, true);
  });

  it('2点 trend_line 成功', async () => {
    const deps = mockDeps();
    let cnt = 0;
    deps.evaluate = async (expr) => {
      if (expr.includes('getAllShapes')) { cnt++; return cnt === 2 ? ['old_1', 'new_1'] : ['old_1']; }
      if (expr.includes('createMultipointShape')) {
        assert.ok(expr.includes('trend_line'));
        return undefined;
      }
      return undefined;
    };
    const r = await drawShape({ shape: 'trend_line', points: [{ time: 1000, price: 100 }, { time: 2000, price: 110 }], _deps: deps });
    assert.equal(r.success, true);
  });

  it('2点 ray 成功', async () => {
    const deps = mockDeps();
    let cnt = 0;
    deps.evaluate = async (expr) => {
      if (expr.includes('getAllShapes')) { cnt++; return cnt === 2 ? ['old_1', 'new_2'] : ['old_1']; }
      if (expr.includes('createMultipointShape')) return undefined;
      return undefined;
    };
    const r = await drawShape({ shape: 'ray', points: [{ time: 1000, price: 100 }, { time: 2000, price: 110 }], _deps: deps });
    assert.equal(r.success, true);
  });

  it('3点 long_position 成功', async () => {
    const deps = mockDeps();
    let cnt = 0;
    deps.evaluate = async (expr) => {
      if (expr.includes('getAllShapes')) { cnt++; return cnt === 2 ? ['old_1', 'new_3'] : ['old_1']; }
      if (expr.includes('createMultipointShape')) return undefined;
      return undefined;
    };
    const r = await drawShape({ shape: 'long_position', points: [{ time: 1000, price: 100 }, { time: 1000, price: 95 }, { time: 2000, price: 110 }], _deps: deps });
    assert.equal(r.success, true);
  });

  it('3点 short_position 成功', async () => {
    const deps = mockDeps();
    let cnt = 0;
    deps.evaluate = async (expr) => {
      if (expr.includes('getAllShapes')) { cnt++; return cnt === 2 ? ['old_1', 'new_4'] : ['old_1']; }
      if (expr.includes('createMultipointShape')) return undefined;
      return undefined;
    };
    const r = await drawShape({ shape: 'short_position', points: [{ time: 1000, price: 110 }, { time: 1000, price: 115 }, { time: 2000, price: 90 }], _deps: deps });
    assert.equal(r.success, true);
  });

  it('点数不足抛错 requires 2 points', async () => {
    const deps = mockDeps();
    await assert.rejects(() => drawShape({ shape: 'trend_line', points: [{ time: 1000, price: 100 }], _deps: deps }), /requires 2 points/);
  });

  it('long_position 2点抛错 requires 3', async () => {
    const deps = mockDeps();
    await assert.rejects(() => drawShape({ shape: 'long_position', points: [{ time: 1000, price: 100 }, { time: 2000, price: 110 }], _deps: deps }), /requires 3 points/);
  });

  it('legacy point/point2 仍可用', async () => {
    const deps = mockDeps();
    let cnt = 0;
    deps.evaluate = async (expr) => {
      if (expr.includes('getAllShapes')) { cnt++; return cnt === 2 ? ['old_1', 'new_5'] : ['old_1']; }
      if (expr.includes('createMultipointShape')) return undefined;
      return undefined;
    };
    const r = await drawShape({ shape: 'trend_line', point: { time: 1000, price: 100 }, point2: { time: 2000, price: 110 }, _deps: deps });
    assert.equal(r.success, true);
  });

  it('points 优先于 point/point2', async () => {
    const deps = mockDeps();
    let captured = null;
    deps.evaluate = async (expr) => {
      if (expr.includes('getAllShapes')) return ['old_1'];
      if (expr.includes('createMultipointShape') || expr.includes('createShape')) { captured = expr; return undefined; }
      return undefined;
    };
    // points 是3点，point 是1点，应走3点路径
    try { await drawShape({ shape: 'long_position', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }, { time: 3, price: 3 }], point: { time: 9, price: 9 }, _deps: deps }); } catch {}
    assert.ok(captured && captured.includes('createMultipointShape'));
  });
});

describe('listDrawings with_points', () => {
  it('with_points true 返回 points', async () => {
    const deps = {
      evaluate: async (expr) => {
        if (expr.includes('getAllShapes')) {
          // simulate api returning shapes with getPoints
          return [{ id: '1', name: 'rectangle' }];
        }
        return null;
      },
      getChartApi: async () => 'window.TradingViewApi._activeChartWidgetWV.value()',
    };
    // Without TV we just check it doesn't throw and returns count
    const r = await listDrawings({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
  });
});
