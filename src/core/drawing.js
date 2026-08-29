/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';

export const SHAPE_DEFS = {
  horizontal_line: 1,
  vertical_line: 1,
  trend_line: 2,
  rectangle: 2,
  ray: 2,
  long_position: 3,
  short_position: 3,
  text: 1,
  arrow: 2,
};

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, points, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  // Resolve points array: if `points` is provided (non-empty array) it takes precedence over legacy point/point2
  let pts;
  if (points !== undefined && points !== null) {
    if (!Array.isArray(points)) throw new Error('points must be an array');
    pts = points;
  } else {
    if (!point) throw new Error('point is required');
    pts = [point];
    if (point2) pts.push(point2);
  }

  // Validate point count against SHAPE_DEFS when shape is known
  if (shape && Object.prototype.hasOwnProperty.call(SHAPE_DEFS, shape)) {
    const expected = SHAPE_DEFS[shape];
    if (pts.length !== expected) {
      throw new Error(`shape ${shape} requires ${expected} points`);
    }
  }

  // Validate and normalize each point to finite numbers, preserving original error naming for legacy paths
  const validated = pts.map((p, i) => {
    let timeName;
    let priceName;
    if (points !== undefined && points !== null) {
      timeName = `points[${i}].time`;
      priceName = `points[${i}].price`;
    } else {
      if (i === 0) {
        timeName = 'point.time';
        priceName = 'point.price';
      } else {
        timeName = 'point2.time';
        priceName = 'point2.price';
      }
    }
    const t = requireFinite(p.time, timeName);
    const pr = requireFinite(p.price, priceName);
    return { time: t, price: pr };
  });

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  if (validated.length === 1) {
    const p = validated[0];
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${p.time}, price: ${p.price} },
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    const arrStr = `[${validated.map(p => `{ time: ${p.time}, price: ${p.price} }`).join(', ')}]`;
    await evaluate(`
      ${apiPath}.createMultipointShape(
        ${arrStr},
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (after || []).find(id => !(before || []).includes(id)) || null;
  const result = { entity_id: newId };
  return { success: true, shape, entity_id: result?.entity_id };
}

export async function listDrawings(opts = {}) {
  // Allow optional with_points flag and optional _deps injection; keep backward compat when called with no args
  const with_points = opts?.with_points ?? opts?.withPoints ?? false;
  const deps = opts?._deps ? _resolve(opts._deps) : null;
  // Also support direct _deps passed as second arg or via opts._deps; fallback to default
  const evaluate = deps?.evaluate || _evaluate;
  const getChartApi = deps?.getChartApi || _getChartApi;
  // Handle legacy case where opts is actually _deps (if caller passes {evaluate, getChartApi} without with_points)
  // but that is indistinguishable; we already handled _deps inside opts.
  const apiPath = await getChartApi();
  if (with_points) {
    const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) {
        var o = { id: s.id, name: s.name };
        try { var pts = s.getPoints(); if (pts) o.points = pts; } catch(e) {}
        // Ensure ray/long_position/short_position and all types are included as-is; no filtering
        return o;
      });
    })()
  `);
    return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
  }
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  // For long_position / short_position retain points as-is (no transformation)
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await _getChartApi();
  await _evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}
