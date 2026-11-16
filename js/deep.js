// Deep search: one type, a range of sizes, searched in the browser.
//
// John's spec (2026-09-30): "we would start with selecting a type. Then begin and end sizes, m. Again, use the
// full page. I'd like to see the results as a gallery... be able to filter out reducible and isohedral. If we
// click one, we go into explore mode."
//
// WHAT IT SAVES, and why that shape
//   A size counts only when it is FINISHED. The file records every completed size -- including one that found
//   nothing, because "finding nothing is a result" (John, 2026-10-04, after the old app refused to save a
//   search of #209073 that found none). program7/import_deepsearch.js reads exactly this shape and turns each
//   completed size into a done record in the store.
//   The version is the finder's own, with the variant digit 6 for an in-browser app deep search: the finder
//   being 1.4 makes this 1.4.6.
//
// HOW IT RUNS
//   Every combo goes through the same frozen finder the backend uses, in the worker pool, so a verdict here and
//   a verdict from an overnight run are the same verdict. Sizes are done in order and combos within a size are
//   spread across the workers. Stopping is immediate; whatever sizes were finished are still savable, and the
//   half-finished size is simply not claimed.
'use strict';
window.Deep = (function () {
  const $ = id => document.getElementById(id);
  let st = null;      // { id, m0, m1, withReducible, listIso, running, stop, sizes, results, done, startedAt }

  const KINDS = ['anisohedral', 'isohedral', 'impossible', 'unknown'];
  // Tile colours, as everywhere else: green anisohedral, yellow isohedral. A REDUCIBLE combo (a smaller tiling padded with redundant vertices)
  // is the same colour greyed down (John, 2026-10-18).
  const FILL = { anisohedral: 'var(--good,#36c275)', isohedral: '#d8b13a' };
  const FILL_RED = { anisohedral: '#7f9f8d', isohedral: '#a69c78' };
  const fillOf = r => (r.reducible ? FILL_RED : FILL)[r.kind] || undefined;

  function init(typeId) {
    if (!st) st = { id: typeId || null, m0: null, m1: null, withReducible: false, listIso: true,
                    running: false, stop: false, sizes: [], results: [], done: [], startedAt: null, note: null, shapes: 'all' };
    else if (typeId != null && typeId !== st.id) { Object.assign(st, { id: typeId, sizes: [], sizesLoaded: false, m0: null, m1: null, results: [], done: [], note: null }); }
    draw();
    if (st.id != null && !st.sizesLoaded) loadSizes();
  }
  function loadSizes() {
    const want = st.id;
    // Only the SMALL sizes are scanned, to pick sensible defaults and show combo counts. There is NO upper limit on m (John, 2026-10-18):
    // the from/to boxes take any size, and run() asks the worker for each size's sum-types as it reaches it.
    FinderPool.sizes(st.id, 30).then(list => {
      if (!st || st.id !== want) return;
      st.sizes = list; st.sizesLoaded = true;
      if (st.m0 == null && list.length) { st.m0 = list[0][0]; st.m1 = list[Math.min(3, list.length - 1)][0]; }
      else if (st.m0 == null) { st.m0 = 3; st.m1 = 6; }
      draw();
    }).catch(err => { st.note = String(err.message || err); draw(); });
  }

  // ---- the search ---------------------------------------------------------------------------------------
  // draw() rebuilds the whole page; while a search is running, ask for it at most every 400 ms
  let drawT = 0;
  function softDraw() { const n = Date.now(); if (n - drawT > 400) { drawT = n; draw(); } }
  const SHOW_MAX = 300;           // the gallery draws at most this many tiles; all of them are still kept and saved

  async function run() {
    st.running = true; st.stop = false; st.stopAfter = false; st.results = []; st.done = []; st.note = null; st.startedAt = Date.now();
    draw();
    const LS = window.LocalStore;
    const sizes = []; for (let m = Math.max(3, st.m0); m <= st.m1; m++) sizes.push(m);
    for (const m of sizes) {
      if (st.stop || st.stopAfter) break;
      const info = FinderPool.info(), ver = (info ? info.version : '?') + '.6';
      const opts = { red: !!st.withReducible, iso: !!st.listIso };
      const sameOpts = o => o && o.red === opts.red && o.iso === opts.iso;
      const row = { m, combos: 0, judged: 0, aniso: 0, iso: 0, notile: 0, unknown: 0, impossible: 0,
                    redSkipped: 0, isoSkipped: 0, t0: Date.now(), running: true };
      // 1. this size already FINISHED in this browser with the same options: take it as it was
      if (LS && !st.fresh) {
        const rec = await LS.getSize(st.id, m, ver);
        if (rec && rec.extra && sameOpts(rec.extra.opts)) {
          const r = rec.row || {};
          Object.assign(row, { combos: r.combos, judged: r.judged, aniso: r.aniso, iso: r.iso, notile: r.foundNoTile != null ? r.foundNoTile : r.notTile, unknown: r.unknown,
                               impossible: r.noConfig, redSkipped: r.redSkipped, isoSkipped: r.isoSkipped, secs: r.secs,
                               running: false, finished: true, restored: true });
          (rec.extra.results || []).forEach(x => st.results.push(x));
          st.done.push(row); draw(); continue;
        }
      }
      st.done.push(row); draw();
      // 2. a half-searched run of this size: replay what it recorded and skip those combos
      const doneSet = new Set();
      if (LS) {
        const prog = st.fresh ? [] : await LS.getProgress(st.id, m, ver);
        let used = 0;
        for (const ch of prog) {
          if (!sameOpts(ch.opts)) continue;
          used++;
          for (const [cell, code] of ch.done || []) {
            doneSet.add(cell); row.judged++;
            if (code === 'a') row.aniso++; else if (code === 'i') { row.iso++; if (!opts.iso) row.isoSkipped++; }
            else if (code === 'x') row.impossible++; else if (code === 'n') row.notile++; else row.unknown++;
          }
          for (const f of ch.finds || []) st.results.push(f);
        }
        if (!used) await LS.clearProgress(st.id, m, ver);        // none, or left by a run with other options
        if (doneSet.size) { st.note = `m=${m}: carrying on from ${doneSet.size.toLocaleString()} combos already judged in this browser`; draw(); }
      }
      // every combo of this size; only the ones still to judge are kept, as plain numbers: (si*2m + k)*2 + (1 if reducible)
      const todo = [];
      await FinderPool.grid(st.id, m, d => {
        if (!d.row) return;                                    // the worker's first message only announces the page
        st.gridLabels = st.gridLabels || {};
        st.gridLabels[m + '/' + d.si] = d.label;          // the angle-sum row, which the saved file carries
        d.row.forEach((v, k) => {
          row.combos++;
          if (v === 2) row.impossible++;       // 2 = the angle equations have no solution: an answer, not a search
          else if (v === 1 && !st.withReducible) row.redSkipped++;
          else if (v === 0 || v === 1) { const cell = d.si * 2 * m + k; if (!doneSet.has(cell)) todo.push(cell * 2 + v); }
        });
        softDraw();
      });
      doneSet.clear();
      if (!row.combos) { st.done.pop(); draw(); continue; }        // this type has no sum-types at this size: nothing to search or record
      draw();
      // results go to this browser's store as they arrive, so a crash loses seconds, not the run
      let buf = { done: [], finds: [] }, lastFlush = Date.now();
      const flush = () => {
        if (!LS || !(buf.done.length || buf.finds.length)) return Promise.resolve();
        const ch = { opts, done: buf.done, finds: buf.finds }; buf = { done: [], finds: [] }; lastFlush = Date.now();
        return LS.putChunk(st.id, m, ver, ch);
      };
      const N = Math.max(1, FinderPool.size());
      let next = 0, live = 0;
      await new Promise(resolve => {
        const pump = () => {
          if (st.stop && !live) return resolve();
          while (!st.stop && live < N && next < todo.length) {
            const n = todo[next++], v = n % 2, cell = (n - v) / 2, k = cell % (2 * m);
            const c = { si: Math.floor(cell / (2 * m)), or: k < m ? 0 : 1, off: k % m, reducible: v === 1 };
            live++;
            FinderPool.judge({ id: st.id, m, si: c.si, or: c.or, off: c.off },
                             { withReducible: st.withReducible, curveBudgetMs: 60000 })
              .then(r => {
                row.judged++;
                let code, kept = null;
                if (r.verdict === 'anisohedral') { row.aniso++; code = 'a'; kept = keep(r, m, c); }
                else if (r.verdict === 'isohedral') { row.iso++; code = 'i'; if (st.listIso) kept = keep(r, m, c); else row.isoSkipped++; }
                else if (r.verdict === 'impossible') { row.impossible++; code = 'x'; }
                else if (/^(deep search found no tile|no member tiles)/.test(String((r.details || {}).reason || ''))) { row.notile++; code = 'n'; }   // 1.6 wording, and 1.5's
                else { row.unknown++; code = 'u'; }
                buf.done.push([cell, code]); if (kept) buf.finds.push(kept);
                if (buf.done.length >= 40 || Date.now() - lastFlush > 5000) flush();
                if (row.judged % 5 === 0 || next >= todo.length) softDraw();
              })
              .catch(() => { row.judged++; row.unknown++; })        // not recorded as judged: a later run tries it again
              .then(() => { live--; pump(); });
          }
          if (!live && next >= todo.length) resolve();
        };
        if (!todo.length) resolve(); else pump();
      });
      await flush();
      row.running = false;
      row.secs = Math.round((Date.now() - row.t0) / 1000);
      row.finished = !st.stop;                 // a size interrupted part-way is NOT coverage and is never claimed
      // keep it in this browser, so a reload does not lose the work. Only a FINISHED size: a half-searched one
      // is not coverage and must never be remembered as though it were (its progress chunks stay, to resume from).
      if (row.finished && LS) {
        const mine = st.results.filter(x => x.m === m);
        await LS.putSize(st.id, m, ver,
          { m, combos: row.combos, judged: row.judged, aniso: row.aniso, iso: row.iso, foundNoTile: row.notile,
            unknown: row.unknown, noConfig: row.impossible, redSkipped: row.redSkipped, isoSkipped: row.isoSkipped,
            closed: row.aniso + row.iso, clean: row.aniso + row.iso, secs: row.secs },
          mine.map(x => fileFind(x, 'all')),
          { opts, results: mine });
        await LS.clearProgress(st.id, m, ver);
      }
      draw();
    }
    st.running = false;
    st.note = st.stop ? 'stopped — finished sizes are kept; a half-searched size carries on from where it got to when you search again'
            : st.stopAfter ? 'stopped after the size that was running — every size shown finished and can be saved' : 'finished';
    draw();
  }
  function keep(r, m, c) {
    const d = r.details || {};
    const x = { m, si: c.si, or: c.or, off: c.off, kind: r.verdict, reducible: !!c.reducible, sum: sumRow(m, c.si),
                block: d.block ? d.block.size : null, crit: d.block ? d.block.criteria : null, ms: r.ms == null ? null : r.ms,
                shape: d.shape ? { A: d.shape.A, L: d.shape.L } : null,
                curves: d.shape && d.shape.curves && Object.keys(d.shape.curves).length ? d.shape.curves : null,
                curveClr: d.shape && d.shape.curveClearance != null ? d.shape.curveClearance : null,
                edge: d.edge || null, deco: d.deco || null,
                split: d.split ? { crit: d.split.crit, cuts: d.split.cuts, why: d.split.why } : null };   // 1.6: isohedral only with a cut in an I side
    st.results.push(x);
    return x;
  }

  // What a result is drawn with: its shape, its combo's edge orbits, and the curves -- the finder's own where the tile needs them,
  // otherwise the decorative set the worker sized for it. Without edge data (an older file) it is drawn straight.
  function drawShape(r) {
    const e = r.edge || {};
    return { A: r.shape.A, L: r.shape.L, es: e.es, we: e.we, mp: e.mp, stored: r.curves || r.deco || undefined };
  }

  // One find as the results file carries it. The shape (angles, lengths and the curves that made it a tile) is the
  // finder's WITNESS, kept because a shape found once can be hard to find again: some take minutes, and the search
  // has a time budget. mode: 'all' every find, 'slow' only finds that took SLOW_MS or more, 'none'. Rounded as the store rounds it.
  const SLOW_MS = 30000, rnd = (x, d) => +(+x).toFixed(d);
  function fileFind(r, mode) {
    const o = { id: st.id, m: r.m, si: r.si, sum: r.sum || sumRow(r.m, r.si), or: r.or, off: r.off, kind: r.kind,
                crit: Array.isArray(r.crit) ? r.crit.join(',') : (r.crit || ''), blk: r.block ? r.block + '@' + r.block + 't' : '' };
    if (r.reducible) o.reducible = true;
    if (r.ms != null) o.ms = r.ms;
    // for drawing only (the store keeps the witness curves, not these): the edge orbits and the decorative curves
    if (r.edge) o.edge = r.edge;
    if (r.split) o.split = r.split;          // 1.6: where the I sides are cut (the importer keeps it as an isohedral combo)
    if (r.deco && mode !== 'none') o.deco = r.deco;
    if (r.shape && r.shape.A && (mode === 'all' || (mode === 'slow' && r.ms >= SLOW_MS))) {
      o.shape = { A: r.shape.A.map(x => rnd(x, 6)), L: r.shape.L.map(x => rnd(x, 8)) };
      if (r.curves) {
        o.curves = {};
        for (const k of Object.keys(r.curves)) o.curves[k] = { type: r.curves[k].type, pts: r.curves[k].pts.map(p => [rnd(p[0], 6), rnd(p[1], 6)]) };
        if (r.curveClr != null) o.curveClr = +(+r.curveClr).toExponential(4);
      }
    }
    return o;
  }

  // ---- open a results file (made by "save results" or by tools/deep_search.js) and keep it in this browser ------
  async function openFile(file) {
    if (st.running) { alert('A search is running — stop it first.'); return; }
    let d; try { d = JSON.parse(await file.text()); } catch (e) { alert('That file is not readable as JSON.'); return; }
    if (!d || d.kind !== 'mono2iso deep search results' || !d.id || !(d.sizesCompleted || []).length) { alert('That is not a deep search results file.'); return; }
    const LS = window.LocalStore, ver = d.version || '?', opts = { red: !d.skipReducible, iso: !d.skipIsohedral };
    if (st.id !== d.id) init(d.id);
    st.results = []; st.done = [];
    let nShape = 0, nNew = 0;
    const key = r => r.si + '/' + r.or + '/' + r.off;
    for (const sc of d.sizesCompleted) {
      const mine = (d.results || []).filter(r => r.m === sc.m).map(r => {
        const nums = String(r.crit || '').match(/-?\d+/g);
        return { m: r.m, si: r.si, or: r.or, off: r.off, kind: r.kind, sum: r.sum, reducible: !!r.reducible, ms: r.ms == null ? null : r.ms,
                 block: r.blk ? parseInt(r.blk, 10) : null, crit: nums ? nums.map(Number) : null,
                 shape: r.shape ? { A: r.shape.A, L: r.shape.L } : null, curves: r.curves || null, curveClr: r.curveClr == null ? null : r.curveClr,
                 edge: r.edge || null, deco: r.deco || null };
      });
      let row = { m: sc.m, combos: sc.combos, judged: Math.max(0, sc.combos - (sc.noConfig || 0) - (sc.redSkipped || 0)), aniso: sc.aniso || 0,
                  iso: (sc.closed || 0) - (sc.aniso || 0), foundNoTile: (sc.foundNoTile != null ? sc.foundNoTile : sc.notTile) || 0, unknown: sc.unknown || 0, noConfig: sc.noConfig || 0,
                  redSkipped: sc.redSkipped || 0, isoSkipped: sc.isoSkipped || 0, closed: sc.closed || 0, clean: sc.clean || 0, secs: sc.secs };
      let results = mine;
      const had = LS ? await LS.getSize(d.id, sc.m, ver) : null;
      if (had && had.extra && had.extra.results) {                         // already held: keep every find from both
        const seen = new Set(had.extra.results.map(key));
        results = had.extra.results.map(r => { const n = mine.find(q => key(q) === key(r)); return (!r.shape && n && n.shape) ? Object.assign({}, r, { shape: n.shape, curves: n.curves, curveClr: n.curveClr }) : r; })
                    .concat(mine.filter(r => !seen.has(key(r))));
        if (had.row && had.row.judged > row.judged) row = had.row;
        nNew += mine.filter(r => !seen.has(key(r))).length;
      } else nNew += mine.length;
      nShape += results.filter(r => r.shape).length;
      if (LS) await LS.putSize(d.id, sc.m, ver, row, results.map(x => fileFind(x, 'all')), { opts, results });
      st.done.push({ m: sc.m, combos: row.combos, judged: row.judged, aniso: row.aniso, iso: row.iso, notile: row.foundNoTile != null ? row.foundNoTile : row.notTile, unknown: row.unknown,
                     impossible: row.noConfig, redSkipped: row.redSkipped, isoSkipped: row.isoSkipped, secs: row.secs, running: false, finished: true, restored: true });
      results.forEach(x => st.results.push(x));
    }
    st.m0 = d.sizesCompleted[0].m; st.m1 = d.sizesCompleted[d.sizesCompleted.length - 1].m;
    st.note = 'opened ' + file.name + ': ' + d.sizesCompleted.length + ' sizes, ' + (d.results || []).length + ' finds (' + nNew + ' new to this browser, ' + nShape + ' with a saved shape). It is kept in this browser as yours.';
    draw();
  }

  // ---- saving: the shape program7/import_deepsearch.js reads -------------------------------------------
  function sumRow(m, si) { const d = (st.gridLabels || {})[m + '/' + si]; return d == null ? null : '[' + String(d).replace(/[\[\]\s]/g, '') + ']'; }
  function save() {
    const fin = st.done.filter(r => r.finished);
    if (!fin.length) { alert('No size has finished yet — there is nothing to save.'); return; }
    const info = FinderPool.info();
    const file = {
      kind: 'mono2iso deep search results',
      id: st.id, name: (window.byIdForExplore && window.byIdForExplore(st.id)) ? sigOf(window.byIdForExplore(st.id)) : String(st.id),
      // the finder's own version, with the variant digit 6: an in-browser app deep search
      version: (info ? info.version : '?') + '.6',
      versionNote: 'program8 in-browser deep search, finder ' + (info ? info.version + ' [' + info.hash + ']' : '?'),
      savedAt: new Date().toISOString(),
      startM: st.m0, targetM: st.m1,
      skipIsohedral: !st.listIso, skipReducible: !st.withReducible,
      reducibleSkipped: fin.reduce((a, r) => a + r.redSkipped, 0),
      isohedralNotListed: fin.reduce((a, r) => a + r.isoSkipped, 0),
      // ONLY finished sizes. A size that found nothing is recorded exactly like one that did.
      sizesCompleted: fin.map(r => ({ m: r.m, combos: r.combos, closed: r.aniso + r.iso, clean: r.aniso + r.iso,
                                      aniso: r.aniso, foundNoTile: r.notile, redSkipped: r.redSkipped, isoSkipped: r.isoSkipped,
                                      unknown: r.unknown, noConfig: r.impossible, secs: r.secs })),
      combosTried: fin.reduce((a, r) => a + r.judged, 0),
      shapesSaved: st.shapes,
      results: st.results.filter(r => fin.some(f => f.m === r.m)).map(r => fileFind(r, st.shapes)),
    };
    const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = 'deepsearch_' + st.id + '_m' + st.m0 + '-' + (fin[fin.length - 1].m) + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  const sigOf = r => `${r.k}_${r.q} ${r.n}_${r.r}`;

  // ---- drawing ------------------------------------------------------------------------------------------
  function draw() {
    const el = $('deepBody'); if (!el || !st) return;
    const row = (window.byIdForExplore && window.byIdForExplore(st.id)) || null;
    let h = '';
    h += `<section class="exStep"><h2>type</h2><div class="exMode">`
      + `<label>Tegula # <input id="dpId" type="number" value="${st.id == null ? '' : st.id}" style="width:110px"></label>`
      + (row ? `<span class="muted">${sigOf(row)} · orbifold ${row.o}</span>` : `<span class="muted">pick a type</span>`)
      + `</div></section>`;
    if (st.id == null) { el.innerHTML = h; wire(); return; }
    if (!st.sizesLoaded) { el.innerHTML = h + `<div class="muted">working out which sizes this type allows…</div>`; wire(); return; }
    const known = new Map(st.sizes);
    const inRange = []; for (let m = st.m0; m <= st.m1 && inRange.length < 40; m++) inRange.push(m);
    h += `<section class="exStep"><h2>sizes</h2><div class="exMode">`
      + `<label>from m <input id="dpM0" type="number" min="3" step="1" value="${st.m0}" style="width:70px"></label>`
      + `<label>to m <input id="dpM1" type="number" min="3" step="1" value="${st.m1}" style="width:70px"></label>`
      + `<label title="a reducible combo is a smaller-m tiling padded with redundant vertices; normally not judged"><input type="checkbox" id="dpRed"${st.withReducible ? ' checked' : ''}> include reducible</label>`
      + `<label title="list every isohedral combo found, not just count them"><input type="checkbox" id="dpIso"${st.listIso ? ' checked' : ''}> list isohedral</label>`
      + `<label title="normally a size already searched in this browser is reused, and a half-searched one carries on; tick to search everything again"><input type="checkbox" id="dpFresh"${st.fresh ? ' checked' : ''}> search again from scratch</label>`
      + `</div><div class="muted exHint">no upper limit on m. Combos per size: ${inRange.map(m => m + ' (' + (known.has(m) ? (known.get(m) * 2 * m).toLocaleString() : (m <= 30 ? 'none' : 'counted when reached')) + ')').join('  ·  ')}${st.m1 - st.m0 >= 40 ? ' …' : ''}</div>`
      + `<div class="exMode">`
      + (st.running ? `<button id="dpStop">stop now</button><button id="dpStopAfter"${st.stopAfter ? ' disabled' : ''} title="let the size now running finish (all workers keep going on its combos), then stop">stop after this size</button>` : `<button id="dpRun">search</button>`)
      + `<button id="dpSave"${st.done.some(r => r.finished) ? '' : ' disabled'}>save results…</button>`
      + `<label title="a shape found once can be hard to find again, so the file can carry the shape itself (angles, lengths, curves)">shapes in the file <select id="dpShapes"><option value="all"${st.shapes === 'all' ? ' selected' : ''}>every find</option><option value="slow"${st.shapes === 'slow' ? ' selected' : ''}>only finds that took 30 s or more</option><option value="none"${st.shapes === 'none' ? ' selected' : ''}>none</option></select></label>`
      + `<button id="dpOpen"${st.running ? ' disabled' : ''} title="a results file from save results or from tools/deep_search.js; it is kept in this browser as yours">open results file…</button><input type="file" id="dpFile" accept=".json,application/json" style="display:none">`
      + `<span class="muted">finished sizes are kept in this browser; "save" writes a file to send</span>`
      + `<span class="muted">runs the finder ${FinderPool.info() ? 'v' + FinderPool.info().version : ''} in ${Math.max(1, FinderPool.size())} workers</span>`
      + (st.note ? `<span class="muted">${st.note}</span>` : '') + `</div></section>`;
    if (st.done.length) {
      h += `<section class="exStep"><h2>sizes searched</h2><table class="exTable"><thead><tr>`
        + `<th>m</th><th>combos</th><th>judged</th><th>anisohedral</th><th>isohedral</th><th title="no member of the combo was found that tiles -- a search result, not a proof that none exists">deep search found no tile</th>`
        + `<th>unknown</th><th title="proved for every member from the DD symbol: the angle equations have no solution, or (finder 1.7) a fatal rule holds for the whole family">impossible</th><th>reducible skipped</th><th>time</th></tr></thead><tbody>`
        + st.done.map(r => `<tr${r.running ? ' class="on"' : ''}><td>${r.m}</td><td>${r.combos.toLocaleString()}</td>`
          + `<td>${r.judged.toLocaleString()}</td><td><b>${r.aniso}</b></td><td>${r.iso}</td><td>${r.notile}</td>`
          + `<td>${r.unknown}</td><td>${r.impossible}</td><td>${r.redSkipped}</td>`
          + `<td>${r.running ? 'searching…' : (r.finished ? (r.restored ? 'kept from before' : r.secs + 's') : 'stopped — carries on next time')}</td></tr>`).join('')
        + `</tbody></table></section>`;
    }
    const drawable = st.results.filter(r => r.shape);
    if (st.results.length) {
      h += `<section class="exStep"><h2>results <span class="muted">${st.results.length} found — green anisohedral, yellow isohedral, greyed = reducible — click one to open it in Explore</span></h2>`;
      h += (st.results.length > SHOW_MAX ? `<div class="muted">showing the first ${SHOW_MAX} — all ${st.results.length} are kept and saved</div>` : '')
        + `<div class="minigal">` + st.results.slice(0, SHOW_MAX).map((r, i) => {
        const svg = (r.shape && window.Render)
          ? window.Render.tileSvg(drawShape(r), 96, { curves: !!r.edge, fill: fillOf(r) }) : '';
        return `<figure class="gtile${r.kind === 'anisohedral' ? ' needs' : ''}" data-res="${i}" style="cursor:pointer"`
          + ` title="m=${r.m} si=${r.si} refl=${r.or} off=${r.off} — ${r.kind}${r.reducible ? ' (reducible: a smaller tiling with redundant vertices)' : ''}">`
          + `${svg || '<div class="nodraw">no shape</div>'}`
          + `<figcaption>m${r.m} ${r.kind === 'anisohedral' ? '<span class="cv">aniso</span>' : (r.split ? 'iso·split' : 'iso')}${r.reducible ? ' <span class="muted">red.</span>' : ''}</figcaption></figure>`;
      }).join('') + `</div></section>`;
    } else if (st.done.length && !st.running) {
      h += `<section class="exStep"><div class="muted">Nothing was found in that range — which is a result worth keeping: these sizes are now known to be empty. `
        + `They are remembered in this browser, and "save results" writes the file to send.</div></section>`;
    }
    el.innerHTML = h;
    wire();
  }
  function wire() {
    const id = $('dpId');
    if (id) id.addEventListener('change', () => { const v = +id.value; if (v) init(v); });
    const m0 = $('dpM0'); if (m0) m0.addEventListener('change', () => { st.m0 = Math.max(3, Math.floor(+m0.value) || 3); if (st.m1 < st.m0) st.m1 = st.m0; draw(); });
    const m1 = $('dpM1'); if (m1) m1.addEventListener('change', () => { st.m1 = Math.max(3, Math.floor(+m1.value) || 3); if (st.m1 < st.m0) st.m0 = st.m1; draw(); });
    const sa = $('dpStopAfter'); if (sa) sa.addEventListener('click', () => { st.stopAfter = true; st.note = 'will stop after the size now running'; draw(); });
    const rd = $('dpRed'); if (rd) rd.addEventListener('change', () => { st.withReducible = rd.checked; });
    const fr = $('dpFresh'); if (fr) fr.addEventListener('change', () => { st.fresh = fr.checked; });
    const is = $('dpIso'); if (is) is.addEventListener('change', () => { st.listIso = is.checked; });
    const go = $('dpRun'); if (go) go.addEventListener('click', () => run());
    const sp = $('dpStop'); if (sp) sp.addEventListener('click', () => { st.stop = true; st.note = 'stopping…'; draw(); });
    const sv = $('dpSave'); if (sv) sv.addEventListener('click', save);
    const sh = $('dpShapes'); if (sh) sh.addEventListener('change', () => { st.shapes = sh.value; });
    const op = $('dpOpen'), fi = $('dpFile');
    if (op && fi) { op.addEventListener('click', () => fi.click()); fi.addEventListener('change', () => { if (fi.files[0]) openFile(fi.files[0]); fi.value = ''; }); }
    document.querySelectorAll('#deepBody figure[data-res]').forEach(f => f.addEventListener('click', () => {
      const r = st.results[+f.dataset.res]; if (!r) return;
      if (window.showMode) window.showMode('explore');
      window.Explore.open(st.id);
      // Explore needs the size and the cell; it fills its own grid, so hand it the combo and let it settle
      setTimeout(() => window.Explore.goTo && window.Explore.goTo(r.m, r.si, r.or, r.off), 400);
    }));
  }

  return { init, draw, state: () => st };
})();
