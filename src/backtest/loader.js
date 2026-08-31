// Backtest dataset loader — reads the YOLO MS Backtest (MSB) ledger plots from a live
// TradingView chart via CDP, plus main-series 5m bars, and assembles the engine dataset.
//
// Phase0-verified (2026-08-31): display.none plots DO surface in study._data; column map
// = dataWindowView().items()[i]._id ("plot_N") → row[N+1] (alertcondition plots also
// occupy columns — do NOT index by item order; that was the original off-by-N bug).

import { connect, evaluate } from '../connection.js';

const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';

async function findStudy(entityId) {
  return evaluate(`(function(){
    var widget=${CHART}; var chart=widget._chartWidget;
    var srcs=chart.model().model().dataSources();
    for(var i=0;i<srcs.length;i++){
      var s=srcs[i]; var id=null; try{id=typeof s.id==='function'?s.id():s.id;}catch(e){}
      if(id===${JSON.stringify(entityId)}) return true;
    }
    return false;
  })()`);
}

/** Extract signal rows from the MSB study ledger. Returns [{time,type,entry,sl,tp,os,seq,br,kr,sess,range,states{...}}] */
export async function extractSignals(entityId, { _deps } = {}) {
  const ev = _deps?.evaluate || evaluate;
  const raw = await ev(`(function(){
    var widget=${CHART}; var chart=widget._chartWidget;
    var srcs=chart.model().model().dataSources();
    for(var i=0;i<srcs.length;i++){
      var s=srcs[i]; var id=null; try{id=typeof s.id==='function'?s.id():s.id;}catch(e){}
      if(id!==${JSON.stringify(entityId)}) continue;
      var dwv=s.dataWindowView?s.dataWindowView():null; if(!dwv) return JSON.stringify({error:'no dataWindowView'});
      var its=dwv.items();
      var col={}; its.forEach(function(x){ col[x._title]=parseInt(x._id.slice(5))+1; });
      if(col['bk_type']===undefined) return JSON.stringify({error:'not an MSB study (no bk_type)', titles:Object.keys(col)});
      var d=s._data; if(!d||typeof d.lastIndex!=='function') return JSON.stringify({error:'no _data'});
      var last=d.lastIndex(), first=d.firstIndex();
      var rows=[];
      for(var idx=first; idx<=last; idx++){
        var row=d.valueAt(idx); if(!row) continue;
        var num=function(t){var v=row[col[t]]; return (typeof v==='number'&&isFinite(v))?v:null;};
        if(num('bk_type')===null) continue;
        rows.push({
          time: row[0], type: num('bk_type'), entry: num('bk_entry'), sl: num('bk_sl'), tp: num('bk_tp'),
          os: num('bk_os'), seq: num('bk_seq'), br: num('bk_br'), kr: num('bk_kr'),
          sess: num('bk_sess'), range: num('bk_range'),
          states: { '1m': num('bk_state_1m'), '5m': num('bk_state_5m'), '15m': num('bk_state_15m'),
                    '1h': num('bk_state_1h'), '4h': num('bk_state_4h'), '1d': num('bk_state_1d') },
        });
      }
      return JSON.stringify({rows: rows, barsTotal: last-first+1});
    }
    return JSON.stringify({error:'study not found'});
  })()`);
  const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (d.error) throw new Error('extractSignals: ' + d.error + (d.titles ? ` (titles: ${d.titles.join(',')})` : ''));
  return d;
}

/** Extract v3 ledger series (continuous, per-bar): ADD orders, trail SL, CHoCH-flat events.
 *  Returns { add: [{time,type,entry,sl}], flat: [{time,px}], trail: [{time,sl}] } */
export async function extractLedgerV3(entityId, { _deps } = {}) {
  const ev = _deps?.evaluate || evaluate;
  const raw = await ev(`(function(){
    var widget=${CHART}; var chart=widget._chartWidget;
    var srcs=chart.model().model().dataSources();
    for(var i=0;i<srcs.length;i++){
      var s=srcs[i]; var id=null; try{id=typeof s.id==='function'?s.id():s.id;}catch(e){}
      if(id!==${JSON.stringify(entityId)}) continue;
      var dwv=s.dataWindowView?s.dataWindowView():null; if(!dwv) return JSON.stringify({error:'no dataWindowView'});
      var its=dwv.items();
      var col={}; its.forEach(function(x){ col[x._title]=parseInt(x._id.slice(5))+1; });
      if(col['bk_add_type']===undefined) return JSON.stringify({error:'not an MSB v3 study (no bk_add_type)', titles:Object.keys(col)});
      var d=s._data; if(!d||typeof d.lastIndex!=='function') return JSON.stringify({error:'no _data'});
      var last=d.lastIndex(), first=d.firstIndex();
      var add=[], flat=[], trail=[];
      for(var idx=first; idx<=last; idx++){
        var row=d.valueAt(idx); if(!row) continue;
        var num=function(t){var v=row[col[t]]; return (typeof v==='number'&&isFinite(v))?v:null;};
        var at=num('bk_add_type');
        if(at!==null && num('bk_add_time')!==null) add.push({time: num('bk_add_time'), type: at, entry: num('bk_add_entry'), sl: num('bk_add_sl')});
        if(num('bk_flat_time')!==null) flat.push({time: num('bk_flat_time'), px: num('bk_flat_px')});
        var ts=num('bk_trail_sl');
        if(ts!==null) trail.push({time: row[0], sl: ts});
      }
      return JSON.stringify({add: add, flat: flat, trail: trail, barsTotal: last-first+1});
    }
    return JSON.stringify({error:'study not found'});
  })()`);
  const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (d.error) throw new Error('extractLedgerV3: ' + d.error + (d.titles ? ` (titles: ${d.titles.join(',')})` : ''));
  return d;
}

/** Read main-series bars (chart timeframe) as [{time,open,high,low,close,volume}]
 *  Note: series bars valueAt() returns an ARRAY [time,o,h,l,c,v] (same as data.js getOhlcv). */
export async function extractBars({ count = 5000 } = {}) {
  const raw = await evaluate(`(function(){
    var widget=${CHART};
    var chart=widget._chartWidget;
    var series=chart.model().model().mainSeries();
    var bars=series.bars();
    var last=bars.lastIndex(), first=bars.firstIndex();
    var start=Math.max(first, last-${count}+1);
    var out=[];
    for(var i=start;i<=last;i++){
      var b=bars.valueAt(i); if(!b) continue;
      out.push({time:b[0], open:b[1], high:b[2], low:b[3], close:b[4], volume:b[5]||0});
    }
    return JSON.stringify(out);
  })()`);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const TYPE_NAME = { 1: 'B', 2: 'FB', '-1': 'S', '-2': 'FS' };

/** Assemble engine dataset: signals (from ledger) + 5m bars (for shift2 + grain-5m matching) */
export function buildDataset(sigExtract, bars5m, { tf_seconds = 300 } = {}) {
  const barByTime = new Map(bars5m.map(b => [b.time, b]));
  const signals = sigExtract.rows.map(r => {
    const shiftBar = barByTime.get(r.time + 2 * tf_seconds) || null; // 2nd 5m bar after signal bar
    return {
      bar_time: r.time,
      dir: r.type > 0 ? 'LONG' : 'SHORT',
      type: TYPE_NAME[r.type] || String(r.type),
      entry_ref: r.entry, sl: r.sl, tp: r.tp,
      os: r.os, seq: r.seq, sess: r.sess,
      states: r.states,
      shift2: shiftBar ? { o: shiftBar.open, h: shiftBar.high, l: shiftBar.low, c: shiftBar.close } : null,
    };
  });
  return { tf_seconds, signals, bars1m: bars5m, grain: '5m' };
}
