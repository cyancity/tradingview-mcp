/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient, reconnectTo, getTargetInfo, CDP_HOST, CDP_PORT } from '../connection.js';

// ────────────────────────────────────────────────────────────────────────────
// Pine editor DOM helpers (injected into the TradingView page).
//
// ROOT-CAUSE BACKGROUND: TradingView keeps MULTIPLE Monaco editor instances
// in the DOM (one per open script tab / per editor widget instance), and the
// Pine widget can be hidden behind another bottom-widget. The legacy finder
// (document.querySelector('.monaco-editor.pine-editor-monaco') + getEditors()[0])
// picked the FIRST instance in DOM/creation order, which is NOT guaranteed to
// be the ACTIVE (visible) tab's editor. All read/write ops therefore hit a
// "detached buffer" that the user never sees, and `pine save` (raw Ctrl+S)
// landed on whatever element had UI focus in the connected tab. Every helper
// below therefore selects the VISIBLE editor and verifies state after
// mutating it; callers fail loudly when verification fails.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Finds the ACTIVE (visible) Pine editor among all Monaco instances in the
 * page. Selection order:
 *   1. the first VISIBLE .monaco-editor.pine-editor-monaco container,
 *   2. else the first container inside a visible bottom layout area,
 *   3. else the first container overall (legacy single-editor behavior).
 * From the React fiber tree it then returns the editor instance whose DOM
 * node is the chosen container (never blindly editors[0]).
 * Returns { editor, env, visible } or null.
 */
export const FIND_ACTIVE_MONACO = `
  (function findActiveMonacoEditor() {
    function isVisible(el) {
      if (!el || el.offsetParent === null) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    var containers = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    if (!containers || containers.length === 0) return null;
    var chosen = null;
    for (var i = 0; i < containers.length; i++) {
      if (isVisible(containers[i])) { chosen = containers[i]; break; }
    }
    if (!chosen) {
      var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
      if (bottomArea && bottomArea.offsetHeight > 50) {
        for (var j = 0; j < containers.length; j++) {
          if (bottomArea.contains(containers[j])) { chosen = containers[j]; break; }
        }
      }
    }
    if (!chosen) chosen = containers[0];
    var el = chosen;
    var fiberKey;
    for (var k = 0; k < 20; k++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(key) { return key.indexOf('__reactFiber$') === 0; });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          for (var e = 0; e < editors.length; e++) {
            try {
              var dom = editors[e].getDomNode();
              if (dom === chosen || (dom && dom.contains(chosen)) || (chosen && chosen.contains(dom))) {
                return { editor: editors[e], env: env, visible: isVisible(chosen) };
              }
            } catch (err) {}
          }
          if (editors.length > 0) return { editor: editors[0], env: env, visible: isVisible(chosen) };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Lists the Pine editor's open script tabs (the tab strip at the top of the
 * editor panel). Best-effort: role=tab first, then class-based candidates.
 * Returns { scope_found, tabs: [{index, text, active, x, y, width, height}], active }.
 */
export const EDITOR_TABS = `
  (function findEditorTabs() {
    var scope = document.querySelector('.pine-editor-container')
      || document.querySelector('[class*="pine-editor"]')
      || document.querySelector('[class*="layout__area--bottom"]');
    var result = { scope_found: !!scope, tabs: [], active: null };
    if (!scope) return result;
    var tabEls = scope.querySelectorAll('[role="tab"], [class*="script-tab"], [class*="scriptTab"], [class*="pine-tab"]');
    if (tabEls.length === 0) tabEls = scope.querySelectorAll('[class*="tab"]');
    for (var i = 0; i < tabEls.length; i++) {
      var el = tabEls[i];
      var text = (el.textContent || '').trim();
      if (!text || text.length > 120) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var cls = String(el.className || '');
      var isActive = cls.indexOf('active') !== -1 || cls.indexOf('selected') !== -1 || el.getAttribute('aria-selected') === 'true';
      var item = { index: i, text: text.substring(0, 120), active: !!isActive, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      result.tabs.push(item);
      if (isActive && !result.active) result.active = text.substring(0, 120);
    }
    return result;
  })()
`;

/**
 * Pure helper: does a tab's text match the requested script name?
 * Exact match first, then substring (case-insensitive).
 */
export function tabMatches(text, name) {
  const t = String(text || '').trim().toLowerCase();
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return t === n || t.indexOf(n) !== -1;
}

/**
 * Returns a JS expression (string) evaluating to a matcher function used
 * INSIDE the injected page snippets. Kept in sync with tabMatches by
 * construction, and unit-testable offline.
 */
export function tabMatchExpr(name) {
  const n = String(name || '').toLowerCase();
  return `(function(text){ text=(text||'').trim().toLowerCase(); var n=${JSON.stringify(n)}; if(!n) return false; return text === n || text.indexOf(n) !== -1; })`;
}

/**
 * Pure helper: extract the script title from Pine source
 * (e.g. indicator("My Script") -> "My Script").
 */
export function extractScriptTitle(source) {
  if (typeof source !== 'string') return null;
  const m = source.match(/(?:indicator|strategy|library)\s*\(\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/**
 * Injected snippet: click the Pine editor tab whose title matches `name`.
 * Tries exact match then substring match, scoped to the Pine editor
 * container first and the bottom layout area second (widget-bar header
 * elements are excluded). Returns { clicked, text, exact } or
 * { clicked: false }.
 */
export function clickScriptTabExpr(name) {
  const match = tabMatchExpr(name);
  const exact = JSON.stringify(String(name || '').toLowerCase());
  return `
  (function() {
    var match = ${match};
    var exact = ${exact};
    function withinWidgetHeader(el) {
      var n = el;
      while (n && n !== document.body) {
        var c = String(n.className || '');
        if (c.indexOf('widgetbar') !== -1) return true;
        n = n.parentElement;
      }
      return false;
    }
    function collect(scope) {
      if (!scope) return [];
      var out = [];
      var list = scope.querySelectorAll('[role="tab"]');
      for (var i = 0; i < list.length; i++) out.push(list[i]);
      var list2 = scope.querySelectorAll('[class*="script-tab"], [class*="scriptTab"], [class*="pine-tab"], [class*="tab"]');
      for (var j = 0; j < list2.length; j++) out.push(list2[j]);
      return out;
    }
    function tryClick(scope, exactOnly) {
      var els = collect(scope);
      for (var k = 0; k < els.length; k++) {
        var el = els[k];
        if (withinWidgetHeader(el)) continue;
        var text = (el.textContent || '').trim();
        if (!text || text.length > 120) continue;
        if (!match(text)) continue;
        if (exactOnly && text.toLowerCase() !== exact) continue;
        el.click();
        return { clicked: true, text: text.substring(0, 120), exact: exactOnly };
      }
      return null;
    }
    var r1 = tryClick(document.querySelector('.pine-editor-container'), true);
    if (r1) return r1;
    var r2 = tryClick(document.querySelector('[class*="layout__area--bottom"]'), true);
    if (r2) return r2;
    var r3 = tryClick(document.querySelector('.pine-editor-container'), false);
    if (r3) return r3;
    var r4 = tryClick(document.querySelector('[class*="layout__area--bottom"]'), false);
    if (r4) return r4;
    return { clicked: false, text: null };
  })()`;
}

/**
 * Injected async snippet: best-effort "open script via the Pine toolbar
 * script-name dropdown". Clicks the script-title button, types the name into
 * the popup's search box (React-controlled input), clicks the matching row.
 * Every step is reported; returns { ok, step, text? }.
 */
export function openViaDropdownExpr(name) {
  const n = JSON.stringify(String(name || ''));
  return `
  (function() {
    return new Promise(function(resolve) {
      function fail(step) { resolve({ ok: false, step: step }); }
      function findScope() {
        return document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
      }
      var scope = findScope();
      if (!scope) return fail('scope');
      var titleBtn = null;
      var btns = scope.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim();
        var cls = String(btns[i].className || '');
        if (!t || t.length >= 80) continue;
        if (/save|add to chart|update|compile/i.test(t)) continue;
        if (cls.indexOf('title') !== -1 || cls.indexOf('name') !== -1 || cls.indexOf('select') !== -1 || cls.indexOf('caret') !== -1 || cls.indexOf('toggle') !== -1) {
          titleBtn = btns[i];
          break;
        }
      }
      if (!titleBtn) return fail('title-btn');
      titleBtn.click();
      setTimeout(function() {
        var popup = null;
        var popups = document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [class*="popup"], [class*="menu"], [class*="dropdown"]');
        for (var p = 0; p < popups.length; p++) {
          var pr = popups[p].getBoundingClientRect();
          if (pr.width > 50 && pr.height > 30 && popups[p].offsetParent !== null) { popup = popups[p]; break; }
        }
        if (!popup) return fail('popup');
        var inp = popup.querySelector('input');
        if (inp) {
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${n});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        function clickRow(rows) {
          var target = ${n}.toLowerCase();
          for (var r = 0; r < rows.length; r++) {
            var rt = (rows[r].textContent || '').trim();
            if (!rt || rt.length > 120) continue;
            var lt = rt.toLowerCase();
            if (lt === target || lt.indexOf(target) !== -1) {
              rows[r].click();
              return rt.substring(0, 120);
            }
          }
          return null;
        }
        setTimeout(function() {
          var rows = popup.querySelectorAll('[role="option"], [class*="listRow"], [class*="list-row"], [class*="row"], [class*="item"]');
          var clicked = clickRow(rows);
          if (clicked) return resolve({ ok: true, step: 'row-click', text: clicked });
          if (inp) {
            setTimeout(function() {
              var rows2 = popup.querySelectorAll('[role="option"], [class*="listRow"], [class*="list-row"], [class*="row"], [class*="item"]');
              var clicked2 = clickRow(rows2);
              if (clicked2) return resolve({ ok: true, step: 'row-click-retry', text: clicked2 });
              return fail('row');
            }, 700);
          } else {
            return fail('row');
          }
        }, 500);
      }, 400);
    });
  })()`;
}

/**
 * Activate a script tab via the Pine editor's script-name dropdown, using the
 * menu structure actually present in current TradingView Desktop builds
 * (menu `[class*="contentDefaultAppearance"]`, rows `[class*="button-XNUivTou"]`).
 * The legacy openViaDropdownExpr looked for role=menu/input/option which this
 * build does not render, so it silently failed and left `set`/`compile` acting
 * on whichever (possibly read-only community) script happened to be visible.
 * Matches by full title OR shorttitle (the dropdown lists the shorttitle, e.g.
 * "Ms" for "YOLO MS"). Returns { ok, already, matched } / { ok:false, step }.
 */
export function activateScriptViaDropdownExpr(name, short) {
  const n = JSON.stringify(String(name || '').toLowerCase());
  const s = JSON.stringify(String(short || '').toLowerCase());
  return `
  (function() {
    return new Promise(function(resolve) {
      var name = ${n};
      var short = ${s};
      var done = false;
      function finish(r) { if (!done) { done = true; resolve(r); } }
      function tryMenu() {
        var menu = document.querySelector('[class*="contentDefaultAppearance"]');
        if (!menu) return finish({ ok: false, step: 'menu' });
        var rows = menu.querySelectorAll('[class*="button-XNUivTou"]');
        var avail = [];
        for (var i = 0; i < rows.length; i++) {
          var t = (rows[i].textContent || '').trim();
          avail.push(t.slice(0, 40));
          var tl = t.toLowerCase();
          if (tl === name || (short && tl === short) || (name && tl.indexOf(name) !== -1) || (short && tl.indexOf(short) !== -1)) {
            rows[i].click();
            return finish({ ok: true, matched: t.slice(0, 60) });
          }
        }
        finish({ ok: false, step: 'no-match', available: avail.slice(0, 12) });
      }
      function start() {
        var btn = document.querySelector('[class*="nameButton"]');
        if (!btn) return finish({ ok: false, step: 'nameButton' });
        var cur = (btn.textContent || '').trim().toLowerCase();
        // Already on the target script — no-op, the buffer is the right one.
        if (cur === name || (short && cur === short)) return finish({ ok: true, already: true });
        btn.click();
        setTimeout(tryMenu, 700);
      }
      start();
      setTimeout(function() { finish({ ok: false, step: 'timeout' }); }, 5000);
    });
  })()
  `;
}

/** Extract the indicator/strategy title and shorttitle from Pine source. */
export function parsePineMeta(source) {
  const m = String(source || '').match(/^(?:indicator|strategy|library)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"])?/);
  return m ? { title: m[1], short: m[2] || '' } : null;
}

/**
 * Opens the Pine Editor panel and waits for a VISIBLE Monaco editor.
 * The legacy behavior treated mere DOM existence as "open", which allowed
 * all read/write ops to silently target a hidden editor instance. Now the
 * pine-editor widget is explicitly activated and visibility is required.
 * Returns true if a visible editor is available, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const state = await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      return m ? { present: true, visible: m.visible } : { present: false, visible: false };
    })()
  `);
  if (state?.present && state.visible) return true;

  // Monaco missing or hidden: activate the Pine widget explicitly.
  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (bwb) {
        if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
        else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
      }
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn && btn.offsetParent !== null) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { var m = ${FIND_ACTIVE_MONACO}; return m ? m.visible : false; })()`);
    if (ready) return true;
  }
  return false;
}

/** Builds a "no visible Pine editor" error naming the connected CDP target. */
export async function editorUnavailableError(action) {
  let where = '';
  try {
    const t = await getTargetInfo();
    where = ` in target ${t.id} (${t.title || t.url || 'unknown tab'})`;
  } catch { /* no target info */ }
  return new Error(
    `Could not open Pine Editor${where} — no visible editor found. ` +
    `If you have many browser tabs, the CLI is pinned to ONE CDP target (see tv status). ` +
    `Run "tv pine targets" (or pine_list_targets) to list tabs and retry with --target <id> ` +
    `(or pine_select_target) pointing at the tab that shows the Pine editor, ` +
    `then verify with "tv pine verify-tab".`
  );
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('getSource');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('setSource');

  // ROOT-CAUSE guard: before writing, make sure the editor's ACTIVE buffer is
  // the script this source belongs to. Without this, setValue() can land in a
  // read-only community script's buffer (e.g. "Smart Money Concepts [LuxAlgo]")
  // while compile() re-fetches the saved script and reverts everything to v5.
  const meta = parsePineMeta(source);
  if (meta?.title) {
    try {
      const act = await evaluateAsync(activateScriptViaDropdownExpr(meta.title, meta.short));
      if (act?.ok) await new Promise(r => setTimeout(r, 700));
    } catch { /* best-effort: fall through to setValue */ }
  }

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return { ok: false, reason: 'no active monaco' };
      m.editor.setValue(${escaped});
      return { ok: true, visible: m.visible };
    })()
  `);

  if (!set || !set.ok) {
    throw new Error('Monaco found but setValue() failed on the ACTIVE editor instance.');
  }

  // Verify the ACTIVE editor actually received the content (fail loudly on
  // divergence instead of silently editing a detached buffer).
  const verified = await evaluate(`
    (function() {
      function norm(s) {
        while (s.length > 0 && (s.charCodeAt(s.length - 1) === 10 || s.charCodeAt(s.length - 1) === 13)) s = s.substring(0, s.length - 1);
        return s;
      }
      var expected = ${escaped};
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return { ok: false, reason: 'no active monaco after set' };
      var value = m.editor.getValue();
      return { ok: norm(value) === norm(expected), visible: m.visible };
    })()
  `);

  if (!verified || !verified.ok) {
    throw new Error(
      'pine set: verification failed — the VISIBLE editor does not contain the injected content. ' +
      'The editor being written is not the one shown in the connected tab. Use "tv pine verify-tab" to inspect, ' +
      'and check "tv status" / "tv pine targets" to confirm which browser tab the CLI is attached to.'
    );
  }

  return { success: true, lines_set: source.split('\n').length, editor_visible: verified.visible };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('compile');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    // Keyboard fallback: focus the ACTIVE editor first so the key event
    // reaches the editor the CLI has been manipulating.
    await evaluate(`
      (function() {
        var m = ${FIND_ACTIVE_MONACO};
        if (m && typeof m.editor.focus === 'function') m.editor.focus();
      })()
    `);
    await new Promise(r => setTimeout(r, 150));
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('getErrors');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('save');

  // Focus the ACTIVE editor so the Ctrl+S key event reaches the editor whose
  // buffer the CLI has been manipulating. Raw CDP key events land on whatever
  // element has DOM focus in the connected tab; if another script tab (or the
  // chart) has focus, Ctrl+S would save the WRONG script — or nothing.
  await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      if (m && typeof m.editor.focus === 'function') m.editor.focus();
      return m ? m.visible : false;
    })()
  `);
  await new Promise(r => setTimeout(r, 200));

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('smartCompile');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    // Keyboard fallback: focus the ACTIVE editor first (see compile()).
    await evaluate(`
      (function() {
        var m = ${FIND_ACTIVE_MONACO};
        if (m && typeof m.editor.focus === 'function') m.editor.focus();
      })()
    `);
    await new Promise(r => setTimeout(r, 150));
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('newScript');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // Set the template into the ACTIVE editor instance.
  const escaped = JSON.stringify(template);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return { ok: false, reason: 'no active monaco' };
      m.editor.setValue(${escaped});
      return { ok: true, visible: m.visible };
    })()
  `);

  if (!set || !set.ok) throw new Error('Monaco editor not found. Ensure Pine Editor is open.');

  return {
    success: true,
    type,
    action: 'new_script_created',
    template: typeMap[type],
    editor_visible: set.visible,
    note: 'Template written into the currently ACTIVE editor tab. It replaces that tab\'s buffer — if that tab holds a saved script, save() will overwrite it. To edit on a fresh tab, open a new script in the Pine editor UI first.',
  };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw await editorUnavailableError('openScript');

  const escapedName = JSON.stringify(name.toLowerCase());

  // 1) Fetch the saved script source (no UI mutation yet).
  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length, source: source};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  // 2) ACTIVATE the script's tab in the VISIBLE editor tab bar. The legacy
  // implementation never touched the tab bar — it only setValue'd into
  // whatever Monaco instance the finder returned, so the visible tab never
  // switched and the buffer diverged from the UI. Fail loudly instead of
  // silently operating on a detached buffer.
  const clickResult = await evaluate(clickScriptTabExpr(result.name));
  let tabActivated = clickResult?.clicked === true;

  if (!tabActivated) {
    // Best-effort: open via the Pine toolbar script dropdown.
    const dropdownResult = await evaluateAsync(openViaDropdownExpr(result.name));
    tabActivated = dropdownResult?.ok === true;
  }
  if (!tabActivated) {
    // Fallback: the script-name dropdown menu actually rendered by current
    // builds ([class*="contentDefaultAppearance"] + button-XNUivTou rows).
    const short = parsePineMeta(result.source)?.short || '';
    const menuResult = await evaluateAsync(activateScriptViaDropdownExpr(result.name, short));
    tabActivated = menuResult?.ok === true;
  }

  if (!tabActivated) {
    throw new Error(
      `Script "${result.name}" is not open in the Pine editor of the connected tab, and it could not be opened automatically ` +
      `(tab-click ${clickResult?.clicked === true ? 'ok' : 'miss'}). ` +
      `Open the script in the Pine editor tab bar manually (or create a new script with "tv pine new" + "tv pine set"), then retry. ` +
      `Check "tv pine targets" / "tv status" to confirm which browser tab the CLI is attached to, and inspect state with "tv pine verify-tab".`
    );
  }

  // Let the tab switch settle.
  await new Promise(r => setTimeout(r, 500));

  // 3) Write the fetched source into the ACTIVE (visible) editor.
  const escaped = JSON.stringify(result.source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return { ok: false, reason: 'no active monaco' };
      m.editor.setValue(${escaped});
      return { ok: true, visible: m.visible };
    })()
  `);
  if (!set || !set.ok) {
    throw new Error('Pine editor found but setValue() failed on the ACTIVE editor instance.');
  }

  // 4) VERIFY the ACTIVE editor now holds the fetched source — fail loudly
  // rather than reporting "opened: true" against a detached buffer.
  const verified = await evaluateAsync(`
    (function() {
      function norm(s) {
        while (s.length > 0 && (s.charCodeAt(s.length - 1) === 10 || s.charCodeAt(s.length - 1) === 13)) s = s.substring(0, s.length - 1);
        return s;
      }
      var expected = ${escaped};
      var m = ${FIND_ACTIVE_MONACO};
      if (!m) return { ok: false, reason: 'no active monaco after set' };
      var value = m.editor.getValue();
      return { ok: norm(value) === norm(expected), visible: m.visible, len: value.length };
    })()
  `);

  if (!verified || !verified.ok) {
    throw new Error(
      `pine open: verification failed — after activating the tab, the VISIBLE editor does not contain script "${result.name}". ` +
      `This usually means the CLI's CDP target is not the tab you are looking at. ` +
      `Run "tv pine targets" and retry with --target <id>, then "tv pine verify-tab".`
    );
  }

  return {
    success: true,
    name: result.name,
    script_id: result.id,
    lines: result.lines,
    source: 'internal_api',
    opened: true,
    tab_activated: tabActivated,
    tab_clicked: clickResult?.clicked === true ? clickResult.text : null,
    verified: true,
  };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}

/**
 * Inspect the Pine editor state of the CONNECTED target: is the editor
 * visible, which script tab is active in the tab bar, what is the ACTIVE
 * editor's buffer title, and do they agree? Also reports how many Pine
 * Monaco instances exist in the DOM (the divergence diagnostic) and which
 * CDP target the CLI is attached to.
 * Callers should run this before set/save to assert the right script is open.
 */
export async function verifyTab() {
  const state = await evaluate(`
    (function() {
      var containers = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
      var m = ${FIND_ACTIVE_MONACO};
      return {
        monaco_instance_count: containers.length,
        present: m !== null,
        visible: m ? m.visible : false,
        source: m ? m.editor.getValue() : null,
      };
    })()
  `);
  const tabs = await evaluate(EDITOR_TABS);

  const bufferTitle = state?.source ? extractScriptTitle(state.source) : null;
  const activeTitle = tabs?.active || null;
  let matches = null;
  if (activeTitle && bufferTitle) {
    const a = activeTitle.toLowerCase();
    const b = bufferTitle.toLowerCase();
    matches = a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
  }

  let target = null;
  try {
    const t = await getTargetInfo();
    target = { id: t.id, title: t.title, url: t.url };
  } catch { /* not connected yet */ }

  const instanceCount = state?.monaco_instance_count ?? 0;
  return {
    success: true,
    target,
    editor_present: state?.present === true,
    editor_visible: state?.visible === true,
    monaco_instance_count: instanceCount,
    active_tab_title: activeTitle,
    tab_count: tabs?.tabs?.length ?? 0,
    tabs: tabs?.tabs ?? [],
    editor_buffer_title: bufferTitle,
    active_tab_matches_buffer: matches,
    ...(instanceCount > 1 && {
      warning: `Found ${instanceCount} Pine editor instances in this tab's DOM. The CLI now targets the VISIBLE (active) one. ` +
        `If the visible tab is not the script you want, switch it in the UI first, then re-verify.`,
    }),
    ...(!activeTitle && {
      note: 'Could not detect the editor tab bar in the DOM (TV version may render it differently). Rely on editor_buffer_title / editor_visible. If tabs are listed in the UI, their DOM differs — report the TV version for a follow-up.',
    }),
  };
}

/**
 * Enumerate all CDP page targets (browser tabs) that look like TradingView,
 * so callers can pick which tab the pine tools operate on. Does not attach
 * to any target.
 */
export async function listTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const pages = (Array.isArray(targets) ? targets : [])
    .filter(t => t.type === 'page' && (/tradingview/i.test(t.url || '') || /tradingview/i.test(t.title || '')))
    .map(t => ({
      id: t.id,
      title: t.title || null,
      url: t.url || null,
      chart_id: t.url?.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));
  return { success: true, target_count: pages.length, targets: pages };
}

/**
 * Point all subsequent pine operations at a specific browser tab (CDP target).
 * Uses the same reconnectTo() primitive as tab_switch. Fails loudly if the
 * target id is unknown; the pine ops themselves fail loudly when no visible
 * Pine editor exists in the selected target.
 */
export async function selectTarget({ targetId }) {
  const listed = await listTargets();
  const t = listed.targets.find(x => x.id === targetId);
  if (!t) {
    throw new Error(
      `CDP target ${targetId} not found among ${listed.target_count} TradingView targets. ` +
      `Run "tv pine targets" (or pine_list_targets) for the current list.`
    );
  }
  await reconnectTo(targetId);
  return {
    success: true,
    target_id: t.id,
    target_title: t.title,
    target_url: t.url,
    note: 'All subsequent pine_* operations now run in this tab. Use pine_verify_tab to confirm the Pine editor is visible and the active tab is the script you intend to modify.',
  };
}
