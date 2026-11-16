// Explore, slice 1: pick a combo. John, 2026-10-02: "how will we expand the choice from the right panel
// to full screen and let us pick m, si, or, off?"
//
// The type picker hands over a type; this takes the whole width and asks the three questions in order --
// size, sum-type, then orientation and offset -- and judges whichever combo you land on.
//
// Every cell is RECOMPUTED here, through the frozen finder's own harness in a Web Worker, and NOTHING
// in the grid comes from a store. It asks only what the CONFIGURATION is -- 0.11 ms a combo, so a whole
// size is instant -- never whether a tile was found, which costs ~1.7 s a combo.
//
// Store marks were tried and dropped (John, 2026-10-03): a legacy 0.8 deep-dive find sat on a cell this
// recomputes as reducible, and two sources of truth in one grid is the thing we are avoiding.
//
// Slice 2 (below): "work on this combo" opens ONE combo in a dedicated worker and draws it live, with the
// two kinds of slider the old app had --
//   true parameters  walk the closing family; every move RE-CLOSES the tile, so it always closes
//   raw              edit a free angle or an edge length directly and LEAVE THE GAP, drawn in red
// Slice 3 adds CURVE EDITING. One curve per edge ORBIT: every edge that must match carries the same curve,
// transformed by its own Klein code, so editing one edge edits all of them at once -- that is what makes the
// result still tile.
//
// EVERY control point of EVERY copy is draggable, including the derived half of a U or S curve (John,
// 2026-10-06), and the edge under the mouse is the one being edited -- there is no edge to pick first. Three
// coordinate frames are involved and each drag walks back through all of them:
//   world  ->  the edge's own frame        unmapFromEdge(V[e], V[e+1], .)
//          ->  the ORBIT's frame           undo the edge's Klein code: x->1-x if code&1, y->-y if code&2
//          ->  the STORED half             mirrorPt for a point on a U/S derived half (the map is its own
//                                          inverse, so the same formula derives and recovers)
// Only then is the stored point moved, and the whole orbit redraws from it.
// Slice 4 adds the TILING view, the radio pair John asked for: one tile, or the tile glued into a patch by the
// type's own symmetry. The patch comes from tiler_core.develop, which glues copies through the net data, so it
// is built by the group rather than searched for. No overlap check anywhere: a closed, simple boundary tiles.
'use strict';
window.Explore = (function () {
  const $ = id => document.getElementById(id);
  const CLS = ['live', 'red', 'imp', 'nodata'];      // index = the worker's status code
  const WHY = ['can be solved for', 'reducible — a smaller-m combo describes the same tiling',
               'impossible: the vertex-angle equations have no non-zero solution',
               'no configuration data'];
  /**
   * What the published record says about each combo of ONE size, for the grid.
   * John, 2026-10-14: "when we show the blue tiles that mark a combo that isn't instantly impossible,
   * can we put a '?' to show it's an open question. We could put 'A' or 'I' for anisohedral or
   * isohedral combos."
   *
   * 'A' is exact and complete: the store lists every anisohedral find. 'I' is sparse on purpose --
   * the app feed carries ONE isohedral example per type (412 of 1,098 types have one), because that
   * is all the gallery and the cards ever needed; a blue cell with no letter is therefore genuinely
   * an open question rather than a gap in the display.
   */
  function marksFor(id, m) {
    const out = {};
    const T = (window.APP_STORE && window.APP_STORE.types) || {};
    const s = T[id];
    if (!s) return out;
    for (const f of (s.a || [])) if (f[0] === m) out[f[1] + '/' + f[2] + '/' + f[3]] = 'A';
    // combos of tiles isohedral only by splitting an I side are ISOHEDRAL (John, 2026-10-17) -- the feed keeps them in `s`
    for (const f of (s.s || [])) if (f[0] === m) out[f[1] + '/' + f[2] + '/' + f[3]] = 'I';
    if (s.i && s.i[0] === m) out[s.i[1] + '/' + s.i[2] + '/' + s.i[3]] = 'I';
    return out;
  }
  const MARK_WHY = { A: 'anisohedral — a tile that needs more than one orbit',
                     I: 'isohedral — a known single-orbit tiling',
                     '?': 'open — solvable, but nothing found here yet' };
  let st = null;                                      // { id, m, si, or, off, sizes, rows, judging, ws }
  let sess = null, moving = false, pendingMove = null;   // the open combo's worker, and latest-wins slider moves
  let cv = null;                                        // { edits, sel, hover, drag } -- the curve editor's state
  let view = 'tile';                                    // 'tile' = one tile | 'tiling' = the developed patch
  let patch = null;                                     // { tiles } | { reason } -- whatever the worker last sent
  let patchTiles = 40;                                  // how many copies to glue
  // PAN AND ZOOM. John, 2026-10-16: "in explore mode, can we include +/-/1x buttons. with sliders when the
  // shape goes out of bounds, or some way to pan the canvas so we can see different parts?"
  // The single tile is drawn from a FIXED frame {cx, cy, half} (so a slider visibly moves the shape), so
  // zooming and panning it are edits to that frame -- and toWorld() / hit-testing stay right for free.
  // The tiling is auto-fitted, so it keeps its own view {z, cx, cy} in picture units (S = 520), applied
  // through the svg viewBox. Both are reset by 1x, and by opening a different combo.
  const VS = 520;
  let pz = { z: 1, cx: VS / 2, cy: VS / 2 };
  const ZOOM_STEP = 1.25, ZOOM_MIN = 0.05, ZOOM_MAX = 60;
  const XLO = -1, XHI = 2, YMAX = 3;                    // how far a control point may be pulled, as the old app had it
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  function open(id) {
    st = { id, m: null, si: null, or: null, off: null, sizes: null, rows: new Map(), gridFor: null };
    $('explore').hidden = false;
    document.querySelector('main').hidden = true;
    $('selectors').hidden = true;
    draw();
    FinderPool.sizes(id, 20).then(list => {
      if (!st || st.id !== id) return;
      st.sizes = list;
      if (list.length) chooseM(list[0][0]); else draw();
    }).catch(err => fail(err));
  }
  // Every change of combo goes through here, so the developed tiling of the old combo goes too: kept, it was drawn for the
  // NEW combo until the view was switched (John, 2026-10-18).
  function closeWork() { if (sess) { sess.then(s => s.close()); sess = null; } if (st) st.ws = null; moving = false; pendingMove = null; cv = null; patch = null; }
  function close() {
    closeWork();
    st = null;
    $('explore').hidden = true;
    document.querySelector('main').hidden = false;
    $('selectors').hidden = false;
  }
  function fail(err) {
    $('exBody').innerHTML = `<div class="exNote bad">${String(err && err.message || err)}</div>`;
  }

  // ONE PAGE of sum-types at a time (John, 2026-10-07: "just do one page worth and be able to move
  // pages"). The grid costs one config() per CELL and one redraw per ROW, and both run away at large m:
  // #1727337 at m = 19 has 45,696 sum-types -- 1,736,448 cells, and 45,696 redraws of a table that is
  // still growing. That is the freeze, and it happens while PICKING the combo, not editing it.
  // A page costs what it shows, whatever m is.
  // A page is bounded by CELLS, not rows, because the cost is one config() per cell and config() is ~15ms
  // for a big type: 100 rows at m = 19 is 3,800 calls, about a minute. Rows per page therefore shrink as m
  // grows, so a page costs roughly the same wherever you are.
  const PAGE_CELLS = 1200;
  function pageRows(m) { return Math.max(10, Math.floor(PAGE_CELLS / (2 * m))); }
  function sumCount(m) {
    const row = (st.sizes || []).find(x => x[0] === m);
    return row ? row[1] : 0;
  }
  function chooseM(m) {
    closeWork();
    st.m = m; st.si = null; st.or = null; st.off = null; st.verdict = null;
    st.page = 0;
    loadPage(0, true);
  }
  /** Fetch one page of sum-types. `pick` lands on the first solvable combo of the page. */
  function loadPage(page, pick) {
    st.page = page; st.rows = new Map(); st.gridDone = false;
    const want = st.gridFor = st.id + '/' + st.m + '/' + page;
    draw();
    let lastDraw = 0;
    FinderPool.grid(st.id, st.m, d => {
      if (!st || st.gridFor !== want) return;        // a later size or page was picked; ignore stragglers
      if (d.page) { st.total = d.total; return; }    // the header message: how many sum-types in all
      st.rows.set(d.si, d);
      if (pick && st.or === null) {
        const k = d.row.indexOf(0);
        if (k >= 0) { st.si = d.si; st.or = k < st.m ? 0 : 1; st.off = k % st.m; }
      }
      // Redrawing on every row is quadratic: each redraw rebuilds the whole table built so far.
      const now = Date.now();
      if (now - lastDraw > 150) { lastDraw = now; draw(); }
    }, page * pageRows(st.m), pageRows(st.m)).then(r => {
      if (!st || st.gridFor !== want) return;
      st.total = (r && r.sums) || st.total;
      st.gridDone = true;
      if (pick && st.si === null) st.si = firstUsableSi();
      draw();
    }).catch(fail);
  }
  /** Show the page that contains this si, and select it. */
  function goToSi(si, or, off) {
    const n = sumCount(st.m);
    si = Math.max(0, Math.min(n - 1, si | 0));
    st.si = si; st.or = or ? 1 : 0; st.off = Math.max(0, Math.min(st.m - 1, off | 0));
    closeWork(); st.verdict = null;
    loadPage(Math.floor(si / pageRows(st.m)), false);
  }

  function firstUsableSi() {
    for (const [si, d] of [...st.rows.entries()].sort((a, b) => a[0] - b[0]))
      if (d.row.some(v => v === 0)) return si;
    return st.rows.size ? [...st.rows.keys()].sort((a, b) => a - b)[0] : null;
  }
  let lastCell = null;
  const DBL_MS = 450;
  function chooseCell(si, or, off) {
    closeWork();
    st.si = si; st.or = or; st.off = off; st.verdict = null; draw();
  }
  function judge() {
    if (st.si === null || st.or === null) return;
    const combo = { id: st.id, m: st.m, si: st.si, or: st.or, off: st.off };
    st.judging = true; st.verdict = null; draw();
    FinderPool.find(combo, { curveBudgetMs: 60000 }).then(r => {
      if (!st || st.m !== combo.m || st.si !== combo.si || st.or !== combo.or || st.off !== combo.off) return;
      st.judging = false; st.verdict = r; draw();
    }).catch(err => { st.judging = false; st.verdict = { verdict: 'error', details: { reason: String(err.message || err) } }; draw(); });
  }

  function draw() {
    if (!st) return;
    const row = (window.byIdForExplore && window.byIdForExplore(st.id)) || null;
    $('exTitle').innerHTML = `#${st.id}` + (row ? ` <span class="muted">${row.k}_${row.q} ${row.n}_${row.r} · orbifold ${row.o}</span>` : '');
    let h = '';

    // 1. size
    h += `<section class="exStep"><h2>size <span class="muted">m — the number of sides</span></h2><div class="chips">`;
    if (!st.sizes) h += `<span class="muted">working out which sizes this type allows…</span>`;
    else if (!st.sizes.length) h += `<span class="muted">no sum-types at any size up to m = 20</span>`;
    else h += st.sizes.map(([m, n]) =>
      `<button class="chip-m${m === st.m ? ' on' : ''}" data-m="${m}" title="${n} sum-type${n === 1 ? '' : 's'}">${m}<small>${n}</small></button>`).join('');
    h += `</div></section>`;

    // 2. sum-type, with its row of (orientation, offset) cells
    // Once the workspace is open the grid has done its job -- John, 2026-10-07: "after I get in edit
    // mode, I don't really want the grid. That's just to pick combos." It is also the expensive part of
    // the page, so dropping it keeps editing responsive at large m.
    if (st.m && st.ws) {
      h += `<section class="exStep exPicked"><b>#${st.id}</b> m${st.m}`
        + (st.si == null ? '' : ` si${st.si} refl${st.or} off${st.off}`)
        + ` <button id="exChange">change combo</button></section>`;
    } else if (st.m) {
      const n = sumCount(st.m), pages = Math.max(1, Math.ceil(n / pageRows(st.m)));
      const lo = st.page * pageRows(st.m);
      h += `<section class="exStep"><h2>sum-type and offset `
        + `<span class="muted">each row is one sum-type si; the two half-rows are orientation 0 and 1, `
        + `and the columns are the offset</span>`
        + (st.gridDone ? '' : ` <span class="muted">— working…</span>`) + `</h2>`;
      h += `<div class="exPager"><button id="exPgPrev"${st.page <= 0 ? ' disabled' : ''}>◀ prev</button>`
        + `<span class="muted">sum-types ${(lo + 1).toLocaleString()}–${Math.min(n, lo + pageRows(st.m)).toLocaleString()}`
        + ` of ${n.toLocaleString()} &nbsp;·&nbsp; page ${st.page + 1} of ${pages.toLocaleString()}</span>`
        + `<button id="exPgNext"${st.page >= pages - 1 ? ' disabled' : ''}>next ▶</button>`
        + `<span class="exJump"><label>go to si</label><input id="exJsi" type="number" min="0" max="${n - 1}" value="${st.si == null ? lo : st.si}">`
        + `<button id="exJgo">go</button></span></div>`;
      h += `<div class="exLegend">` + [0, 1, 2, 3].map(i =>
        `<span><i class="cell ${CLS[i]}"></i>${WHY[i]}</span>`).join('')
        + ['A', 'I', '?'].map(k =>
            `<span><i class="cell live mk${k === 'A' || k === 'I' ? ' mk' + k : ''}">${k}</i>${MARK_WHY[k]}</span>`).join('')
        + `</div>`;
      h += `<div class="exGrid"><table><thead><tr><th class="si">si</th><th class="sum">angle sums</th>`;
      for (const or of [0, 1]) for (let off = 0; off < st.m; off++)
        h += `<th class="off${off === 0 && or === 1 ? ' sep' : ''}">${or}:${off}</th>`;
      h += `</tr></thead><tbody>`;
      const MK = marksFor(st.id, st.m);
      for (const si of [...st.rows.keys()].sort((a, b) => a - b)) {
        const d = st.rows.get(si);
        h += `<tr${si === st.si ? ' class="on"' : ''}><th class="si">${si}</th><td class="sum">${d.label}</td>`;
        d.row.forEach((v, k) => {
          const or = k < st.m ? 0 : 1, off = k % st.m;
          const sel = si === st.si && or === st.or && off === st.off;
          // only a LIVE cell carries a letter: the others are already settled by their colour
          const mk = v === 0 ? (MK[si + '/' + or + '/' + off] || '?') : '';
          h += `<td class="cell ${CLS[v]}${mk === 'A' || mk === 'I' ? ' mk' + mk : ''}${sel ? ' sel' : ''}${off === 0 && or === 1 ? ' sep' : ''}"`
            + ` data-si="${si}" data-or="${or}" data-off="${off}"`
            + ` title="si ${si} · orientation ${or} · offset ${off} — ${WHY[v]}`
            + `${mk ? ' · ' + MARK_WHY[mk] : ''} · double-click to open">${mk}</td>`;
        });
        h += `</tr>`;
      }
      h += `</tbody></table></div></section>`;
    }

    // 3. the chosen combo
    if (st.si !== null && st.or !== null) {
      // ONE way in (John, 2026-10-21: "default to the work on this combo. But then have the other button available after the
      // quick answer"). Opening is the quick answer: the gallery's shape, else the first member that closes. The deeper search
      // is the full finder, offered once the combo is open, and its verdict stays beside the shape.
      h += `<section class="exStep"><h2>combo</h2><div class="exPick">`
        + `<b>#${st.id} m${st.m} si${st.si} or${st.or} off${st.off}</b> `;
      if (!st.ws)
        h += `<button id="exWork" title="the gallery's shape if there is one, otherwise the first member that closes">open this combo</button>`
          + `<span class="muted">or double-click its cell</span>`;
      else
        h += `<button id="exJudge"${st.judging ? ' disabled' : ''} title="the full finder: every member it can reach, the isohedral criteria and the impossibility rules">`
          + `${st.judging ? 'searching…' : st.verdict ? 'search again' : 'deeper search'}</button>`
          + `<span class="muted">runs the finder ${FinderPool.info() ? 'v' + FinderPool.info().version : ''} in a worker, up to a minute or two</span>`;
      h += `</div>`;
      if (st.verdict) h += verdictHtml(st.verdict);
      h += `</section>`;
      if (st.ws) h += workspaceHtml();
    }
    $('exBody').innerHTML = h;

    $('exBody').querySelectorAll('button[data-m]').forEach(b =>
      b.addEventListener('click', () => chooseM(+b.dataset.m)));
    // Double-click a cell to open that combo and land on its shape (John, 2026-10-21: "without having to scroll down and
    // click the work on this combo"). Each click redraws the grid, so the browser's dblclick never reaches the same cell:
    // a second click on the same cell within DBL_MS counts instead.
    $('exBody').querySelectorAll('td.cell').forEach(c =>
      c.addEventListener('click', () => {
        const si = +c.dataset.si, or = +c.dataset.or, off = +c.dataset.off, key = si + '/' + or + '/' + off, t = Date.now();
        const dbl = lastCell && lastCell.key === key && t - lastCell.t < DBL_MS;
        lastCell = dbl ? null : { key, t };
        if (dbl) { scrollToShape = true; openWork(); } else chooseCell(si, or, off);
      }));
    const ch = $('exChange');
    if (ch) ch.addEventListener('click', () => { closeWork(); st.verdict = null; loadPage(st.page || 0, false); });
    const pp = $('exPgPrev'); if (pp) pp.addEventListener('click', () => loadPage(st.page - 1, true));
    const pn = $('exPgNext'); if (pn) pn.addEventListener('click', () => loadPage(st.page + 1, true));
    const jg = $('exJgo');
    if (jg) jg.addEventListener('click', () => goToSi(+($('exJsi') || {}).value, st.or || 0, st.off || 0));
    const js = $('exJsi');
    if (js) js.addEventListener('keydown', e => { if (e.key === 'Enter') jg && jg.click(); });
    const jb = $('exJudge'); if (jb) jb.addEventListener('click', judge);
    const wb = $('exWork'); if (wb) wb.addEventListener('click', () => { scrollToShape = true; openWork(); });
    const of = $('exOpenFound');
    if (of) of.addEventListener('click', () => { const d = st.verdict && st.verdict.details; if (d && d.shape) { scrollToShape = true; openWork(d.shape); } });
    if (st.ws) wireWorkspace();
    // Click a picture, land on the picture. openFile draws several times, and the scroll has to wait for
    // the draw that puts a PICTURE in the box, not merely the box: in the tiling view the patch arrives
    // later, and until it does the page is short enough that there is nothing to scroll -- scrollIntoView
    // runs, moves nothing, and the flag is spent before the content that needed scrolling to exists.
    if (scrollToShape && $('exTileBox') && $('exTileBox').querySelector('svg')) {
      scrollToShape = false;
      $('exTileBox').scrollIntoView({ block: 'center' });
    }
  }

  function verdictHtml(r) {
    const d = r.details || {};
    const chip = { anisohedral: 'A', isohedral: 'P', impossible: 'X', unknown: 'U', error: 'X' }[r.verdict] || 'U';
    let h = `<div class="exVerdict"><span class="chip ${chip}">${r.verdict}</span>`;
    if (d.block) h += `<span class="why">a block of <b>${d.block.size}</b> tile${d.block.size === 1 ? '' : 's'} `
      + `satisfies isohedral criteri${(d.block.criteria || []).length === 1 ? 'on' : 'a'} <b>${(d.block.criteria || []).join(', ')}</b></span>`;
    if (r.verdict === 'impossible') h += `<span class="why">${d.reason}<br><span class="muted">${d.basis || ''}</span></span>`;
    // John, 2026-10-17: never say "not a tile" for a search result -- only a proof earns that. The finder's stored wording
    // ("no member tiles: ...") is kept as it is in the record; what is SHOWN says what actually happened.
    if (r.verdict === 'unknown') h += `<span class="why">${String(d.reason || '').replace(/^no member tiles/, 'deep search found no tile')   /* 1.5 wording; 1.6 already says it */}`
      + (d.likelyImpossible ? `<br><b>likely impossible</b> — ${d.evidence}` : '')
      + `<br><span class="muted">unknown means we did not find one, never that there is none.</span></span>`;
    if (d.members) h += `<span class="why muted">members judged: ` +
      Object.entries(d.members).map(([k, v]) => `${v} ${k}`).join(', ') + `</span>`;
    if (r.timing) h += `<span class="why muted">${(r.timing.ms / 1000).toFixed(1)}s</span>`;
    h += `</div>`;
    if (d.shape && window.Render) {
      const svg = window.Render.tileSvg({ A: d.shape.A, L: d.shape.L }, 150, { curves: false });
      if (svg) h += `<div class="exShape">${svg}<div class="lbl">the member the search found, with straight edges `
        + `<button id="exOpenFound">open this shape</button></div></div>`;
    }
    return h;
  }

  // ================= slice 2: the live tile ==============================================================
  // found: a shape from the deeper search ({A, L}) to open instead of the gallery's or the first member's
  function openWork(found) {
    closeWork();
    st.ws = { busy: true, mode: 'true', data: null, frame: null, err: null };
    pz = { z: 1, cx: VS / 2, cy: VS / 2 };
    draw();
    sess = FinderPool.session();
    // THE GALLERY'S SHAPE, when the combo has one (John, 2026-10-18: "when we load a tile in explore mode, default to copy the
    // shape in the gallery ... otherwise someone has to try to design a difficult curve again"). data/aniso_shapes.js holds the
    // gallery's shape and curves for every combo it shows, hand-drawn ones included; data/iso_shapes.js holds the isohedral tiles
    // that are hard to curve. Open on that, not on the solver's default, which may land on another member of the family.
    // The shapes file is loaded on first use (the gallery shares the same loader), so the open waits for it.
    const key = [st.id, st.m, st.si, st.or, st.off].join('/');
    const shapesReady = () => new Promise(res => { if (window.ANISO_SHAPES || !window.loadAnisoShapes) res(); else window.loadAnisoShapes(res); });
    const call = s => shapesReady().then(() => {
      const saved = found ? null : (window.ISO_SHAPES || {})[key] || (window.ANISO_SHAPES || {})[key];
      const sh = found ? { A: found.A, L: found.L, stored: {}, ca: true } : saved ? unflipShape(saved) : null;
      return sh ? s.call('openSaved', { file: { id: st.id, m: st.m, si: st.si, or: st.or, off: st.off, manual: { A: sh.A, L: sh.L },
                                                  curveEdits: sh.stored || {}, curvesAuto: !!sh.ca } })
                : s.call('open', { combo: { id: st.id, m: st.m, si: st.si, or: st.or, off: st.off } });
    });
    sess.then(call).then(d => {
      if (!st || !st.ws) return;
      st.ws.busy = false;
      if (!d.ok) { st.ws.err = d.reason; draw(); return; }
      st.ws.data = d; st.ws.frame = frameOf(d.V);
      cv = { edits: d.curves ? JSON.parse(JSON.stringify(d.curves)) : {}, sel: null, hover: null, drag: null };
      draw();
    }).catch(err => { if (st && st.ws) { st.ws.busy = false; st.ws.err = String(err.message || err); draw(); } });
  }
  // A FIXED frame, taken from the first shape and generously padded, so a slider visibly changes the shape
  // instead of being cancelled out by the picture re-fitting itself every frame.
  function frameOf(V) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of V) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
    const half = Math.max(c - a, d - b, 1e-6) * 0.5 * 1.9;
    return { cx: (a + c) / 2, cy: (b + d) / 2, half, half1: half };
  }
  // 1x: re-centre and re-scale to the shape as it stands now (what "fit view" did), for either view
  function fitFrame() {
    pz = { z: 1, cx: VS / 2, cy: VS / 2 };
    if (st.ws && st.ws.data) { st.ws.frame = frameOf(st.ws.data.V); view === 'tiling' ? drawPatch() : drawTile(); }
    showZoom();
  }
  const zoomLevel = () => view === 'tiling' ? pz.z : (st && st.ws && st.ws.frame ? st.ws.frame.half1 / st.ws.frame.half : 1);
  function showZoom() { const el = $('exZoomLbl'); if (el) el.textContent = '×' + zoomLevel().toFixed(2).replace(/\.?0+$/, ''); }
  // zoom by factor f about picture point (sx, sy), so the thing under the cursor stays under the cursor
  function zoomBy(f, sx, sy) {
    if (sx == null) { sx = VS / 2; sy = VS / 2; }
    const z0 = zoomLevel(), z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z0 * f));
    if (z1 === z0) return;
    if (view === 'tiling') {
      const ux = pz.cx + (sx - VS / 2) / pz.z, uy = pz.cy + (sy - VS / 2) / pz.z;
      pz.z = z1; pz.cx = ux - (sx - VS / 2) / z1; pz.cy = uy - (sy - VS / 2) / z1;
      drawPatch();
    } else if (st && st.ws && st.ws.frame) {
      const fr = st.ws.frame, w = toWorld(sx, sy);
      fr.half = fr.half1 / z1;
      const k = VS / (2 * fr.half);
      fr.cx = w[0] - (sx - VS / 2) / k; fr.cy = w[1] + (sy - VS / 2) / k;
      drawTile();
    }
    showZoom();
  }
  // move the picture by (dx, dy) picture units, as a drag does
  function panBy(dx, dy) {
    if (view === 'tiling') { pz.cx -= dx / pz.z; pz.cy -= dy / pz.z; drawPatch(); return; }
    const fr = st && st.ws && st.ws.frame; if (!fr) return;
    const k = VS / (2 * fr.half);
    fr.cx -= dx / k; fr.cy += dy / k;
    drawTile();
  }

  function workspaceHtml() {
    const w = st.ws;
    if (w.busy && !w.data) return `<section class="exStep"><h2>shape</h2><div class="muted">opening the combo…</div></section>`;
    if (w.err) return `<section class="exStep"><h2>shape</h2><div class="exNote bad">${w.err}</div></section>`;
    const d = w.data, fam = d.family;
    let h = `<section class="exStep"><h2>shape</h2><div class="exWork"><div id="exTileBox"></div><div class="exCtl">`;
    h += `<div class="exMode"><label><input type="radio" name="exv" value="tile"${view === 'tile' ? ' checked' : ''}> single tile</label>`
      + `<label><input type="radio" name="exv" value="tiling"${view === 'tiling' ? ' checked' : ''}> full tiling</label>`
      + (view === 'tiling' ? `<label class="muted">copies <input type="number" id="exNT" min="4" max="400" step="4" value="${patchTiles}" style="width:68px"></label>` : '')
      + `</div>`;
    h += `<div class="exMode"><label><input type="radio" name="exm" value="true"${w.mode === 'true' ? ' checked' : ''}> true parameters</label>`
      + `<label><input type="radio" name="exm" value="raw"${w.mode === 'raw' ? ' checked' : ''}> raw sliders</label>`
      + `<span class="exZoomBox" title="zoom the picture; drag empty space to pan; the mouse wheel zooms about the pointer">`
      + `<button id="exZoomOut" title="zoom out">−</button><button id="exFit" title="back to 1x: re-centre and re-scale to this shape">1×</button>`
      + `<button id="exZoomIn" title="zoom in">+</button><span id="exZoomLbl" class="muted"></span></span>`
      // The raw sliders do not re-close, so they can leave the tile open. This walks from WHERE YOU
      // ARE to the nearest closure, rather than re-solving the combo (which could land on a quite
      // different member). John, 2026-10-13.
      + `<button id="exReclose" title="from this shape, find the nearest closure">re-close</button>`
      // REDUCE. John, 2026-10-16. A combo whose vertexAngle mask has zeros is one tile padded with redundant points; this
      // opens the fewer-sided combo that describes the same tile, with the drawn curves carried across.
      + `<button id="exReduce" class="${d.reducible ? 'exReducible' : ''}" title="${d.reducible
          ? d.reducible + ' redundant vertice' + (d.reducible === 1 ? '' : 's') + ': open the ' + (d.A.length - d.reducible) + '-sided combo that describes this same tile, keeping its curves'
          : 'every vertex of this combo is a real corner of the tiling, so there is nothing to reduce'}">Reduce${d.reducible ? ' (' + d.reducible + ')' : ''}</button>`
      + `<button id="exReset" title="go back to the shape this combo opened with">reset shape</button></div>`;
    h += `<div id="exNote"></div>`;
    if (w.mode === 'true') {
      h += `<div class="muted exHint">${fam.dim == null ? 'the size of the closing family could not be worked out' : fam.dim + '-parameter closing family'}`
        + ` (${fam.nU} unknowns − ${fam.rank} for closing). Drag: the tile re-closes after every move.</div>`;
      if (fam.relations.length) h += `<div class="muted exHint">forced: ${fam.relations.join('; ')}</div>`;
      if (!d.drivers.length) h += `<div class="muted">rigid — the type leaves no shape freedom, so there is nothing to drag.</div>`;
      d.drivers.forEach((x, di) => {
        const ang = x.kind === 'A', step = Math.max((x.hi - x.lo) / 200, 1e-4);
        h += `<div class="row"><label title="${ang ? 'angle' : 'length ratio'}">${x.txt}</label>`
          + `<input type="range" min="${x.lo}" max="${x.hi}" step="${step}" value="${x.val}" data-di="${di}">`
          + `<input type="number" class="val" step="${ang ? 0.1 : 0.001}" value="${x.val.toFixed(ang ? 1 : 3)}" data-din="${di}"></div>`;
      });
    } else {
      h += `<div class="muted exHint">raw: change a free angle or an edge length and the tile is left <b>open</b> — the gap is drawn in red. `
        + `Switch back to true parameters to close it again.</div>`;
      h += `<h3>free angles (°)</h3>`;
      if (!d.raw.free.length) h += `<div class="muted">every angle is fixed by the type</div>`;
      d.raw.free.forEach(x => {
        const lo = Math.min(5, Math.floor(x.val) - 30), hi = Math.max(355, Math.ceil(x.val) + 30);
        h += `<div class="row"><label>A${x.i}</label><input type="range" min="${lo}" max="${hi}" step="0.5" value="${x.val}" data-ra="${x.i}">`
          + `<input type="number" class="val" step="0.1" value="${x.val.toFixed(1)}" data-ran="${x.i}"></div>`;
      });
      h += `<h3>edge lengths</h3>`;
      d.raw.groups.forEach((g, gi) => {
        const hi = Math.max(3, g.val * 3);
        h += `<div class="row"><label>e${g.edges.join('=')}</label><input type="range" min="0.05" max="${hi}" step="0.01" value="${g.val}" data-rg="${gi}">`
          + `<input type="number" class="val" step="0.01" value="${g.val.toFixed(2)}" data-rgn="${gi}"></div>`;
      });
    }
    h += curvesHtml(d);
    h += `<div id="exReadout"></div></div></div></section>`;
    return h;
  }

  // Which orbits can carry a curve at all: a straight (I) edge has no freedom.
  function editableOrbits(d) { return (d.orbits || []).filter(o => o.type !== 'I'); }
  function curvesHtml(d) {
    const orb = editableOrbits(d);
    let h = `<h3>curves</h3>`;
    if (d.diag) {
      const v = d.diag.verdict;
      h += `<div class="muted exHint">` + (v === 'straight ok'
        ? 'the straight outline is already a simple closed shape — these curves show which edges match, and you can change them freely'
        : v === 'curves required'
          ? 'on this shape the straight outline does not stay simple (' + (d.diag.problems || []).map(p =>
              p.kind === 'zeroCorner' ? 'corner ' + p.vertex + ' is 0°'
              : p.kind === 'crossing' ? 'edges ' + (p.edges || []).join(' and ') + ' cross'
              : 'a corner touches another edge').join('; ') + '), so it needs curves to be a tile — the readout below says if yours still touch'
          : 'this shape is not a tile: ' + (d.diag.reason || '')) + `</div>`;
    }
    if (!orb.length) return h + `<div class="muted">every edge is straight (I) — there is nothing to curve.</div>`;
    h += `<div class="exMode"><button id="exDesign" title="let the designer choose curves that open this shape">design curves</button>`
      + `<button id="exClearC" title="remove every curve and go back to straight edges">straight edges</button>`
      + `<span id="exClr" class="muted"></span></div>`;
    h += `<div class="chips exOrbits">` + orb.map(o =>
      `<button class="chip-m${cv && cv.sel === o.rep ? ' on' : ''}" data-orb="${o.rep}" title="edge${o.edges.length === 1 ? '' : 's'} ${o.edges.join(', ')} — all carry this one curve">`
      + `${o.type}<small>e${o.edges.join(',')}</small></button>`).join('') + `</div>`;
    h += `<div class="muted exHint">Move the mouse over an edge to work on it — the group it belongs to lights up. Drag any handle on any copy `
      + `to move that point, drag the curve itself to add one, or right-click a handle to remove it. Every edge in the group follows. `
      + `Blue handles are on the derived half of a U or S curve; they are editable too. Grey handles are pinned by the edge type.</div>`;
    return h;
  }

  // ---- drawing and dragging the curve on the SELECTED orbit's representative edge ---------------------
  // Points are stored in the edge's own canonical frame: x from 0 at the edge's start to 1 at its end, y out
  // to the side. TilerCurves maps that onto each edge instance, so one stored point moves every matching edge.
  function curveOfAll(d) {
    const TCv = window.TilerCurves;
    return (d.rc || []).map(o => { const ed = cv && cv.edits[o.rep];
      return ed ? TCv.applyMap(TCv.buildCanon(ed.type, ed.pts), o.code) : [[0, 0], [1, 0]]; });
  }
  function ensureEdit(d, rep) {
    const o = (d.orbits || []).find(x => x.rep === rep); if (!o) return null;
    if (!cv.edits[rep]) cv.edits[rep] = { type: o.type, pts: window.TilerCurves.motifPts(o.type, 0) };
    return cv.edits[rep];
  }
  // a stored point is fixed when the edge type pins it: the start always, and the far end for J and S
  const ptFixed = (type, i, n) => i === 0 || ((type === 'J' || type === 'S') && i === n - 1);

  function drawTile() {
    const w = st && st.ws; const box = $('exTileBox');
    if (!w || !w.data || !box) return;
    if (view === 'tiling') return drawPatch();
    const d = w.data, V = d.V, m = d.A.length, S = 520, fr = w.frame, k = S / (2 * fr.half);
    const X = p => (S / 2 + (p[0] - fr.cx) * k), Y = p => (S / 2 - (p[1] - fr.cy) * k);
    const open = d.gap > 1e-6;
    const TCv = window.TilerCurves;
    const hasCurves = cv && Object.keys(cv.edits).length;
    let pts = V.slice(0, m);
    if (hasCurves && !open) { try { pts = TCv.curvedTile(V.slice(0, m), curveOfAll(d)); } catch (e) { pts = V.slice(0, m); } }
    let path = 'M' + X(pts[0]).toFixed(1) + ' ' + Y(pts[0]).toFixed(1);
    for (let i = 1; i < pts.length; i++) path += ' L' + X(pts[i]).toFixed(1) + ' ' + Y(pts[i]).toFixed(1);
    path += open ? ' L' + X(V[m]).toFixed(1) + ' ' + Y(V[m]).toFixed(1) : ' Z';
    let svg = `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg" style="touch-action:none">`;
    svg += `<path d="${path}" fill="${open ? 'none' : '#2b4a73'}" fill-opacity="0.55" stroke="#9ec5fe" stroke-width="2" stroke-linejoin="round"/>`;
    if (open) svg += `<line x1="${X(V[m]).toFixed(1)}" y1="${Y(V[m]).toFixed(1)}" x2="${X(V[0]).toFixed(1)}" y2="${Y(V[0]).toFixed(1)}" stroke="#ff6b6b" stroke-width="2.5" stroke-dasharray="6 4"/>`
      + `<circle cx="${X(V[m]).toFixed(1)}" cy="${Y(V[m]).toFixed(1)}" r="4.5" fill="#ff6b6b"/>`;
    for (let i = 0; i < m; i++)
      svg += `<circle cx="${X(V[i]).toFixed(1)}" cy="${Y(V[i]).toFixed(1)}" r="3" fill="#cfe3ff"/>`
        + `<text x="${(X(V[i]) + 7).toFixed(1)}" y="${(Y(V[i]) - 6).toFixed(1)}" font-size="11" fill="#8fa6c4">${i}</text>`;
    // Handles on EVERY copy of every curved edge. The orbit under the mouse is drawn brightest; the others
    // are still live, so any copy can be grabbed. A point pinned by the edge type is grey and inert.
    if (cv && !open) {
      cv.hit = [];                                       // what is on screen, for hit-testing: {e, j, x, y, rep}
      for (const o of (d.orbits || [])) {
        if (o.type === 'I') continue;
        const ed = cv.edits[o.rep]; if (!ed) continue;
        const lit = cv.sel === o.rep;
        const canon = TCv.buildCanon(ed.type, ed.pts), n = ed.pts.length;
        for (const e of o.edges) {
          const code = (d.rc[e] || {}).code || 0;
          const W = TCv.mapToEdge(TCv.applyMap(canon, code), V[e], V[(e + 1) % m]);
          svg += `<polyline points="${W.map(p => X(p).toFixed(1) + ',' + Y(p).toFixed(1)).join(' ')}" fill="none"`
            + ` stroke="#ffd166" stroke-width="${lit ? 2.2 : 1.2}" stroke-opacity="${lit ? 1 : 0.4}"/>`;
          W.forEach((p, i) => {
            const ci = (code & 1) ? W.length - 1 - i : i;      // applyMap reverses the order when code&1
            const raw = TCv.fullIdxToRaw(ed.type, n, ci);
            const fixed = ptFixed(ed.type, raw.r, n);
            cv.hit.push({ e, ci, rep: o.rep, x: X(p), y: Y(p), fixed });
            svg += `<circle class="cvh" cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="${lit ? 4.5 : 3}"`
              + ` fill="${fixed ? '#6b7a8d' : (raw.mirror ? '#7fb3ff' : '#ffd166')}" fill-opacity="${lit ? 1 : 0.5}"`
              + ` stroke="#ffd166" stroke-opacity="${lit ? 0.9 : 0.35}" stroke-width="1.2"/>`;
          });
        }
      }
    }
    svg += '</svg>';
    box.innerHTML = svg;
    wireCurveMouse(d);
    const rd = $('exReadout'); if (rd) rd.innerHTML = readoutHtml(d);
    const nt = $('exNote');
    const note = d.note || (cv && cv.note) || null;
    if (nt) nt.innerHTML = (open ? `<div class="exGap">open by <b>${d.gap.toExponential(2)}</b> of the shortest edge</div>`
                                 : `<div class="exClosed">closed</div>`) + (note ? `<div class="exNote bad">${note}</div>` : '');
  }

  // The patch, fitted to the box. Two colours, one per orbit, because a 2-isohedral tiling is exactly two
  // orbits of the same tile and seeing which copy belongs to which is the point of the picture.
  function drawPatch() {
    const box = $('exTileBox'); if (!box) return;
    const S = 520;
    if (!patch) { box.innerHTML = `<div class="exPad muted">building the tiling…</div>`; fetchPatch(); return; }
    if (!patch.tiles) { box.innerHTML = `<div class="exPad exNote bad">${patch.reason || 'the tiling could not be built'}</div>`; return; }
    let a = Infinity, b = Infinity, c = -Infinity, d2 = -Infinity;
    for (const t of patch.tiles) for (const p of t.pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d2 = Math.max(d2, p[1]); }
    const w = c - a, h = d2 - b, k = (S - 16) / Math.max(w, h, 1e-9);
    const ox = (S - w * k) / 2, oy = (S - h * k) / 2;
    const X = p => (ox + (p[0] - a) * k).toFixed(1), Y = p => (S - oy - (p[1] - b) * k).toFixed(1);
    const fill = ['#9ec5fe', '#ffd9a8'];
    const vb = `${(pz.cx - S / (2 * pz.z)).toFixed(2)} ${(pz.cy - S / (2 * pz.z)).toFixed(2)} ${(S / pz.z).toFixed(2)} ${(S / pz.z).toFixed(2)}`;
    let svg = `<svg viewBox="${vb}" width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg" style="touch-action:none">`;
    for (const t of patch.tiles) {
      const dpath = t.pts.map((p, i) => (i ? 'L' : 'M') + X(p) + ' ' + Y(p)).join(' ') + ' Z';
      svg += `<path d="${dpath}" fill="${fill[t.orbit] || '#9ec5fe'}" fill-opacity="0.85" stroke="#1b2733" stroke-width="${(0.9 / pz.z).toFixed(3)}" stroke-linejoin="round"/>`;
    }
    svg += '</svg>';
    box.innerHTML = svg;
    const rd = $('exReadout'); if (rd && st.ws.data) rd.innerHTML = readoutHtml(st.ws.data);
    const nt = $('exNote');
    // keep whatever the last load or design said: the tiling view must not swallow it
    if (nt) nt.innerHTML = `<div class="exClosed">${patch.tiles.length} copies, glued edge to edge by the type's own symmetry</div>`
      + ((cv && cv.note) ? `<div class="exNote bad">${cv.note}</div>` : '');
  }
  function fetchPatch() {
    if (!sess) return;
    const mine = sess;                       // a reply from a combo that has since been replaced must not be drawn
    sess.then(s => s.call('patch', { maxTiles: patchTiles })).then(r => {
      if (!st || !st.ws || view !== 'tiling' || sess !== mine) return;
      patch = r.ok ? { tiles: r.tiles } : { reason: r.reason };
      drawPatch();
    }).catch(err => { if (sess !== mine) return; patch = { reason: String(err.message || err) }; drawPatch(); });
  }
  // any change to the shape or its curves invalidates the patch
  function patchStale() { patch = null; if (view === 'tiling') fetchPatch(); }

  // screen -> world
  function toWorld(sx, sy) {
    const S = 520, fr = st.ws.frame, k = S / (2 * fr.half);
    return [fr.cx + (sx - S / 2) / k, fr.cy - (sy - S / 2) / k];
  }
  // screen -> the ORBIT's own frame, through edge e's placement and Klein code
  function toCanonFor(d, e, code, sx, sy) {
    const m = d.A.length;
    const p = window.TilerCurves.unmapFromEdge(d.V[e], d.V[(e + 1) % m], toWorld(sx, sy));
    return [(code & 1) ? 1 - p[0] : p[0], (code & 2) ? -p[1] : p[1]];
  }
  function pushCurves() {
    if (!sess) return;
    sess.then(s => s.call('setCurves', { edits: cv.edits })).then(r => {
      if (!st || !st.ws) return;
      st.ws.data = r; patchStale(); drawTile();
      const el = $('exClr');
      if (el) el.innerHTML = r.clearance == null ? ''
        : r.clearance > 0 ? `<span class="exClosed">clear by ${r.clearance.toExponential(1)}</span>`
                          : `<span class="exGap">the boundary touches itself</span>`;
    }).catch(() => {});
  }
  // Move a point, wherever it was grabbed: fold the screen position back to the ORBIT's frame through this
  // edge's code, then (for a derived U/S point) through the mirror, and store it.
  function moveGrabbed(d, sx, sy) {
    const g = cv.drag, ed = cv.edits[g.rep]; if (!ed) return;
    const n = ed.pts.length;
    const raw = window.TilerCurves.fullIdxToRaw(ed.type, n, g.ci);
    if (ptFixed(ed.type, raw.r, n)) return;
    let c = toCanonFor(d, g.e, g.code, sx, sy);
    if (raw.mirror) c = window.TilerCurves.mirrorPt(ed.type, c);
    if (!isFinite(c[0]) || !isFinite(c[1])) return;          // a measurement off a detached picture: ignore it
    const x = clamp(c[0], XLO, XHI), y = clamp(c[1], -YMAX, YMAX);
    ed.pts[raw.r] = (ed.type === 'U' && raw.r === n - 1) ? [0.5, y] : [x, y];   // a U's fold stays on the midline
    delete ed.auto; cv.note = null;
    drawTile();
  }
  // nearest drawn handle to a screen point, if it is close enough to mean it
  function nearestHandle(sx, sy, r) {
    let best = null, bd = r * r;
    for (const h of (cv.hit || [])) { const dx = h.x - sx, dy = h.y - sy, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = h; } }
    return best;
  }
  // nearest curved EDGE to a screen point: its orbit is the one the mouse is over
  function nearestEdge(d, sx, sy) {
    const m = d.A.length, TCv = window.TilerCurves, S = 520, fr = st.ws.frame, k = S / (2 * fr.half);
    const X = p => S / 2 + (p[0] - fr.cx) * k, Y = p => S / 2 - (p[1] - fr.cy) * k;
    let best = null, bd = 18 * 18;
    for (const o of (d.orbits || [])) {
      if (o.type === 'I') continue;
      const ed = cv.edits[o.rep]; if (!ed) continue;
      const canon = TCv.buildCanon(ed.type, ed.pts);
      for (const e of o.edges) {
        const code = (d.rc[e] || {}).code || 0;
        const W = TCv.mapToEdge(TCv.applyMap(canon, code), d.V[e], d.V[(e + 1) % m]).map(p => [X(p), Y(p)]);
        for (let i = 0; i < W.length - 1; i++) {
          const a = W[i], b = W[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], LL = dx * dx + dy * dy || 1;
          let t = ((sx - a[0]) * dx + (sy - a[1]) * dy) / LL; t = clamp(t, 0, 1);
          const px = a[0] + t * dx, py = a[1] + t * dy, dd = (sx - px) * (sx - px) + (sy - py) * (sy - py);
          if (dd < bd) { bd = dd; best = { rep: o.rep, e, code, seg: i }; }
        }
      }
    }
    return best;
  }
  function wireCurveMouse(d) {
    const svg = $('exTileBox').querySelector('svg'); if (!svg || !cv) return;
    // Each redraw builds a NEW <svg>, so a reference captured here goes stale the moment the curve moves --
    // a stale node measures 0x0 and every position came back Infinity. Always measure the one on screen.
    const at = e => { const live = $('exTileBox').querySelector('svg'); if (!live) return null;
      const r = live.getBoundingClientRect(); if (!r.width || !r.height) return null;
      return [(e.clientX - r.left) * 520 / r.width, (e.clientY - r.top) * 520 / r.height]; };
    svg.addEventListener('mousedown', e => {
      const p = at(e); if (!p) return; const [sx, sy] = p;
      const h = nearestHandle(sx, sy, 9);
      if (h) {
        if (h.fixed) return;
        const code = (d.rc[h.e] || {}).code || 0;
        cv.sel = h.rep; cv.drag = { e: h.e, ci: h.ci, rep: h.rep, code };
        e.preventDefault(); drawTile(); return;
      }
      // dragging the curve itself adds a point there, and the same gesture moves it
      const ne = nearestEdge(d, sx, sy); if (!ne) return;
      const ed = cv.edits[ne.rep]; if (!ed) return;
      const n = ed.pts.length;
      let c = toCanonFor(d, ne.e, ne.code, sx, sy);
      // which STORED segment this lands on: fold the point back and insert after the nearest stored one
      const mirrored = window.TilerCurves.mirrorPt(ed.type, c);
      const cand = (ed.type === 'U' || ed.type === 'S') && c[0] > 0.5 ? mirrored : c;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < n - 1; i++) {
        const a = ed.pts[i], b = ed.pts[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1], LL = dx * dx + dy * dy || 1;
        let t = ((cand[0] - a[0]) * dx + (cand[1] - a[1]) * dy) / LL; t = clamp(t, 0, 1);
        const dist = Math.hypot(cand[0] - (a[0] + t * dx), cand[1] - (a[1] + t * dy));
        if (dist < bd) { bd = dist; bi = i; }
      }
      ed.pts.splice(bi + 1, 0, [clamp(cand[0], XLO, XHI), clamp(cand[1], -YMAX, YMAX)]);
      // The grab index is into the FULL drawn curve. A press on the far half of a U/S curve inserted the point's
      // mirror image into the stored half, so the drag must hold the MIRROR copy (the one under the cursor):
      // holding the stored one made it jump to the cursor's side of the centre point. John, 2026-10-16.
      const farHalf = (ed.type === 'U' || ed.type === 'S') && c[0] > 0.5;
      const ci = farHalf ? (2 * (n + 1) - 2) - (bi + 1) : bi + 1;
      cv.sel = ne.rep; cv.drag = { e: ne.e, ci, rep: ne.rep, code: ne.code };
      delete ed.auto; cv.note = null;
      e.preventDefault(); drawTile();
    });
    svg.addEventListener('mousemove', e => {
      const p = at(e); if (!p) return; const [sx, sy] = p;
      if (cv.drag) { moveGrabbed(d, sx, sy); return; }
      // hover picks the edge, so there is nothing to choose first
      const h = nearestHandle(sx, sy, 9);
      const rep = h ? h.rep : (nearestEdge(d, sx, sy) || {}).rep;
      svg.style.cursor = h ? (h.fixed ? 'not-allowed' : 'grab') : (rep != null ? 'copy' : 'default');
      if (rep != null && rep !== cv.sel) { cv.sel = rep; drawTile(); }
    });
    // The gesture is followed on the WINDOW, not on this <svg>: the element under the pointer is replaced on
    // every redraw, so listeners bound to it would stop hearing the drag it started. Armed once.
    if (!cv.armed) {
      cv.armed = true;
      window.addEventListener('mousemove', e => {
        if (!cv || !cv.drag || !st || !st.ws || !st.ws.data) return;
        const p = at(e); if (!p) return;
        e.preventDefault(); moveGrabbed(st.ws.data, p[0], p[1]);
      });
      window.addEventListener('mouseup', () => { if (cv && cv.drag) { cv.drag = null; pushCurves(); } });
    }
    svg.addEventListener('mouseleave', () => { if (!cv.drag) svg.style.cursor = 'default'; });
    svg.addEventListener('contextmenu', e => {
      const p = at(e); if (!p) return; const [sx, sy] = p;
      const h = nearestHandle(sx, sy, 9); if (!h || h.fixed) return;
      const ed = cv.edits[h.rep]; if (!ed || ed.pts.length <= 2) return;
      const raw = window.TilerCurves.fullIdxToRaw(ed.type, ed.pts.length, h.ci);
      if (ptFixed(ed.type, raw.r, ed.pts.length)) return;
      e.preventDefault(); ed.pts.splice(raw.r, 1); cv.note = null; drawTile(); pushCurves();
    });
  }

  // The box outlives every redraw (only its <svg> is replaced), so wheel and pan listen on the BOX. A drag on
  // empty space pans; a press the curve editor wants (a handle, or near an edge) has already been claimed
  // with preventDefault() by wireCurveMouse, which runs first because it sits on the <svg> inside the box.
  let panDrag = null, panArmed = false;
  function wirePanZoom() {
    const box = $('exTileBox'); if (!box) return;
    const at = e => { const live = box.querySelector('svg'); if (!live) return null;
      const r = live.getBoundingClientRect(); if (!r.width || !r.height) return null;
      return [(e.clientX - r.left) * VS / r.width, (e.clientY - r.top) * VS / r.height]; };
    box.addEventListener('wheel', e => {
      const p = at(e); if (!p) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, p[0], p[1]);
    }, { passive: false });
    box.addEventListener('mousedown', e => {
      if (e.defaultPrevented || e.button !== 0) return;
      const p = at(e); if (!p) return;
      panDrag = { x: p[0], y: p[1] };
      box.style.cursor = 'grabbing';
      e.preventDefault();
    });
    if (!panArmed) {                                       // armed once: the window outlives the box
      panArmed = true;
      window.addEventListener('mousemove', e => {
        if (!panDrag) return;
        const b = $('exTileBox'), live = b && b.querySelector('svg'); if (!live) return;
        const r = live.getBoundingClientRect(); if (!r.width) return;
        const x = (e.clientX - r.left) * VS / r.width, y = (e.clientY - r.top) * VS / r.height;
        const dx = x - panDrag.x, dy = y - panDrag.y;
        panDrag.x = x; panDrag.y = y;
        panBy(dx, dy);
      });
      window.addEventListener('mouseup', () => {
        if (!panDrag) return;
        panDrag = null; const b = $('exTileBox'); if (b) b.style.cursor = '';
      });
    }
  }

  function readoutHtml(d) {
    // the INSIDE angle, as the sliders show it (finder_pool: on a clockwise walk the finder's angle is 360 minus the inside one)
    const inside = a => { const v = d.cw ? 360 - a : a; return ((v % 360) + 360) % 360; };
    const rows = d.A.map((a, i) => `<tr><td>${i}</td><td>${inside(a).toFixed(2)}°</td><td>${d.L[i].toFixed(4)}</td></tr>`).join('');
    return `<table class="exTable"><thead><tr><th>corner / edge</th><th>angle</th><th>length of edge i→i+1</th></tr></thead><tbody>${rows}</tbody></table>`;
  }


  // ---- moves: latest wins. A drag fires faster than the solver answers, so while one is in flight only the
  // newest request is kept, and it goes out the moment the worker is free. Nothing queues up behind a slow one.
  function sendMove(type, payload) {
    pendingMove = { type, payload };
    if (moving) return;
    moving = true;
    (function go() {
      const mv = pendingMove; pendingMove = null;
      if (!mv || !sess) { moving = false; return; }
      sess.then(s => s.call(mv.type, mv.payload)).then(d => {
        if (st && st.ws) { applyResult(d, mv); }
        if (pendingMove) go(); else moving = false;
      }).catch(err => { moving = false; if (st && st.ws) { st.ws.err = String(err.message || err); draw(); } });
    })();
  }
  // keep the slider and its number box in step with where the worker actually put the shape
  function applyResult(d, mv) {
    const w = st.ws;
    // A re-close moves the shape to wherever the nearest closure is, so every control is stale:
    // redraw the whole panel, as toTrue/reset do. It keeps the current mode, so re-closing from the
    // raw sliders leaves you on the raw sliders, now reading the closed shape.
    if (mv.type === 'toTrue' || mv.type === 'reset' || mv.type === 'reclose') {
      if (mv.type === 'reset' || d.curvesAuto) cv.edits = d.curves ? JSON.parse(JSON.stringify(d.curves)) : {};
      w.data = d; draw(); return;
    }
    // generated curves follow the shape: the worker re-sized them for this move, so take its set
    if (d.curvesAuto) cv.edits = d.curves ? JSON.parse(JSON.stringify(d.curves)) : {};
    w.data = d;                                       // a refused move comes back with ok:false and the OLD shape + a note
    patchStale();
    drawTile();
    if (mv.type === 'moveTrue') d.drivers.forEach((x, di) => {
      const s = document.querySelector('input[data-di="' + di + '"]'), n = document.querySelector('input[data-din="' + di + '"]');
      if (s && +s.value !== x.val) s.value = x.val;
      if (n && document.activeElement !== n) n.value = x.val.toFixed(x.kind === 'A' ? 1 : 3);
    });
  }
  function wireWorkspace() {
    const w = st.ws; if (!w || !w.data) return;
    drawTile();
    const root = $('exBody');
    root.querySelectorAll('input[name="exm"]').forEach(r => r.addEventListener('change', () => {
      if (r.value === w.mode) return;
      w.mode = r.value;
      if (r.value === 'true') { sendMove('toTrue', {}); } else { draw(); }
    }));
    root.querySelectorAll('input[data-di]').forEach(s => {
      const di = +s.dataset.di, n = root.querySelector('input[data-din="' + di + '"]');
      s.addEventListener('input', () => { n.value = (+s.value).toFixed(w.data.drivers[di].kind === 'A' ? 1 : 3); sendMove('moveTrue', { di, value: +s.value }); });
      n.addEventListener('input', () => { if (n.value !== '' && isFinite(+n.value)) { s.value = n.value; sendMove('moveTrue', { di, value: +n.value }); } });
    });
    root.querySelectorAll('input[data-ra]').forEach(s => {
      const i = +s.dataset.ra, n = root.querySelector('input[data-ran="' + i + '"]');
      s.addEventListener('input', () => { n.value = (+s.value).toFixed(1); sendMove('moveRaw', { kind: 'A', i, value: +s.value }); });
      n.addEventListener('input', () => { if (n.value !== '' && isFinite(+n.value)) { s.value = n.value; sendMove('moveRaw', { kind: 'A', i, value: +n.value }); } });
    });
    root.querySelectorAll('input[data-rg]').forEach(s => {
      const gi = +s.dataset.rg, n = root.querySelector('input[data-rgn="' + gi + '"]');
      s.addEventListener('input', () => { n.value = (+s.value).toFixed(2); sendMove('moveRaw', { kind: 'L', gi, value: +s.value }); });
      n.addEventListener('input', () => { if (n.value !== '' && isFinite(+n.value)) { s.value = n.value; sendMove('moveRaw', { kind: 'L', gi, value: +n.value }); } });
    });
    root.querySelectorAll('input[name="exv"]').forEach(r => r.addEventListener('change', () => {
      if (r.value === view) return;
      view = r.value; patch = null; draw();
    }));
    const nt = $('exNT');
    if (nt) nt.addEventListener('change', () => {
      const v = Math.max(4, Math.min(400, +nt.value || 40));
      if (v === patchTiles) return;
      patchTiles = v; patch = null; drawPatch();
    });
    root.querySelectorAll('button[data-orb]').forEach(b => b.addEventListener('click', () => {
      cv.sel = +b.dataset.orb; ensureEdit(w.data, cv.sel); draw(); pushCurves();
    }));
    const db = $('exDesign');
    if (db) db.addEventListener('click', () => {
      db.disabled = true; db.textContent = 'designing…';
      sess.then(s => s.call('designCurves', { ms: 30000 })).then(r => {
        if (!st || !st.ws) return;
        st.ws.data = r;
        if (r.curves) cv.edits = JSON.parse(JSON.stringify(r.curves));
        cv.note = r.note || null;
        if (cv.sel == null) { const o = editableOrbits(r)[0]; if (o) cv.sel = o.rep; }
        // the designer found nothing: hand the orbit its default motif so it can still be edited by hand,
        // which is the whole point of the editor -- John's curves were drawn where the designer gave up
        if (cv.sel != null) ensureEdit(r, cv.sel);
        draw(); pushCurves();
      }).catch(err => { st.ws.err = String(err.message || err); draw(); });
    });
    const cb = $('exClearC');
    if (cb) cb.addEventListener('click', () => { cv.edits = {}; sess.then(s => s.call('clearCurves', {})).then(r => { st.ws.data = r; draw(); }); });
    const fb = $('exFit'); if (fb) fb.addEventListener('click', fitFrame);
    const zi = $('exZoomIn'), zo = $('exZoomOut');
    if (zi) zi.addEventListener('click', () => zoomBy(ZOOM_STEP));
    if (zo) zo.addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
    wirePanZoom(); showZoom();
    const rc = $('exReclose'); if (rc) rc.addEventListener('click', () => sendMove('reclose', {}));
    const rd = $('exReduceBtn') || $('exReduce');
    if (rd) rd.addEventListener('click', () => {
      rd.disabled = true; const label = rd.textContent; rd.textContent = 'reducing…';
      sess.then(s => s.call('reduce', {})).then(r => {
        if (!st || !st.ws) return;
        if (!r.ok) {                                        // refused: say why, and carry on with this combo
          rd.disabled = false; rd.textContent = label;
          const nt = $('exNote'); if (nt) nt.innerHTML = '<div class="exNote bad">Reduce: ' + r.reason + '</div>';
          return;
        }
        // open the reduced combo as a combo of its own; the report says what happened and how exact it was
        const bits = [r.note];
        if (r.outlineDeviation != null) bits.push(r.outlineDeviation < 1e-6 ? 'the outline is identical to the old one' : 'the outline differs from the old one by ' + r.outlineDeviation.toExponential(1) + ' of the tile');
        if (r.warnings && r.warnings.length) bits.push('NOTE: ' + r.warnings.join('; '));
        openFile({ id: r.id, m: r.m, si: r.si, or: r.or, off: r.off, manual: { A: r.A, L: r.L }, curveEdits: r.curves || {},
                   view: view === 'tiling' ? 'full' : 'tiles', reduceNote: bits.join(' — ') });
      }).catch(err => { rd.disabled = false; rd.textContent = label; const nt = $('exNote'); if (nt) nt.innerHTML = '<div class="exNote bad">Reduce: ' + String(err.message || err) + '</div>'; });
    });
    const rb = $('exReset'); if (rb) rb.addEventListener('click', () => { w.mode = 'true'; sendMove('reset', {}); });
  }

  // ================= saving and loading ==================================================================
  // The file is the SAME shape the old app wrote -- id, m, sum, orient, off, view, curves, manual{A,L},
  // curveEdits -- so John's existing combo files open here and anything saved here opens there. Angles are
  // written to 4 decimals and lengths to 6 (TC.roundShape, his rule): readable numbers, re-closed on load.
  function currentCombo() { return st && st.m != null && st.si != null && st.or != null ? { id: st.id, m: st.m, si: st.si, or: st.or, off: st.off } : null; }
  function download(name, blob) {
    const a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function sumRowFor(si) {                                 // the angle-sum row, as the old files store it
    const d = st.rows.get(si);
    return d && d.label != null ? '[' + String(d.label).replace(/[\[\]\s]/g, '') + ']' : null;
  }
  function saveCombo() {
    const c = currentCombo();
    if (!c) { alert('Open a combo in Explore first — pick a type, a size and a cell.'); return; }
    if (!sess || !st.ws || !st.ws.data) { alert('Press "work on this combo" first, so there is a shape to save.'); return; }
    sess.then(s => s.call('forSave', {})).then(r => {
      const file = {
        kind: 'mono2iso combo', id: c.id, m: c.m, si: c.si, sum: sumRowFor(c.si), orient: c.or, off: c.off,
        view: view === 'tiling' ? 'full' : 'tiles', curves: !!(cv && Object.keys(cv.edits).length),
        manual: { A: r.A, L: r.L },
        curveEdits: (cv && Object.keys(cv.edits).length) ? cv.edits : {},
        savedBy: 'program8 explore, finder ' + (FinderPool.info() ? FinderPool.info().version : '?'),
        savedAt: new Date().toISOString(),
      };
      download('combo_' + c.id + '_m' + c.m + '_si' + c.si + '_or' + c.or + '_off' + c.off + '.json',
               new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
    }).catch(err => alert('could not save: ' + (err.message || err)));
  }
  // ---- LINKS TO A COMBO (John, 2026-10-21: "open the app and automatically load a combo in explore mode with full tiling,
  // complete with curves ... like have a link to the page", as program6's "save link" did, with curves or without).
  //   #combo=ID/m/si/or/off&view=tiling              Explore on the combo, drawn with the gallery's shape and curves if it has
  //                                                  them (else the finder's own member), single tile or full tiling
  //   ...&s=<data>                                   with THIS shape and these curves packed into the link (base64 of the same
  //                                                  fields a saved combo file carries), so hand-edited curves travel too
  // The link is all there is: nothing is stored anywhere, so it works on the published site as well as from a file.
  const b64u = str => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = str => decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/'))));
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => alert('Link copied:\n' + text.slice(0, 160) + (text.length > 160 ? ' ...' : '')), () => window.prompt('Copy this link:', text));
    else window.prompt('Copy this link:', text);
  }
  function comboLink(withShape) {
    const c = currentCombo();
    if (!c) { alert('Open a combo in Explore first -- pick a type, a size and a cell.'); return; }
    const base = location.href.split('#')[0] + '#combo=' + [c.id, c.m, c.si, c.or, c.off].join('/') + '&view=' + (view === 'tiling' ? 'tiling' : 'tile');
    if (!withShape) { copyText(base); return; }
    if (!sess || !st.ws || !st.ws.data) { alert('Press "work on this combo" first, so there is a shape to put in the link.'); return; }
    sess.then(s => s.call('forSave', {})).then(r => {
      const r4 = x => +(+x).toFixed(4), r6 = x => +(+x).toFixed(6), ed = {};
      for (const k of Object.keys((cv && cv.edits) || {})) { const e = cv.edits[k]; if (e && e.pts) ed[k] = { type: e.type, pts: e.pts.map(p => [r4(p[0]), r4(p[1])]) }; }
      copyText(base + '&s=' + b64u(JSON.stringify({ A: r.A.map(r4), L: r.L.map(r6), c: ed })));
    }).catch(err => alert('could not make the link: ' + (err.message || err)));
  }
  /** Open what a link names. params: URLSearchParams of the hash (combo, view, s). Returns false if it names no combo. */
  function openLink(params) {
    const k = String(params.get('combo') || '').split('/').map(Number);
    if (k.length !== 5 || k.some(x => !Number.isFinite(x))) return false;
    const combo = { id: k[0], m: k[1], si: k[2], or: k[3], off: k[4] }, wantTiling = params.get('view') === 'tiling';
    const packed = params.get('s');
    if (packed) {
      let d = null; try { d = JSON.parse(unb64u(packed)); } catch (e) { d = null; }
      if (d && d.A && d.L) {
        openFile(Object.assign({}, combo, { manual: { A: d.A, L: d.L }, curveEdits: d.c || {}, curvesAuto: false, view: wantTiling ? 'full' : 'tiles' }));
        return true;
      }
      alert('The shape in this link could not be read, so the combo opens on its gallery shape instead.');
    }
    const go = () => { const sh = (window.ANISO_SHAPES || {})[k.join('/')] || null; openShape(combo, sh, { view: wantTiling ? 'tiling' : 'tile' }); };
    if (window.ANISO_SHAPES || !window.loadAnisoShapes) go(); else window.loadAnisoShapes(go);
    return true;
  }

  function loadComboFile(text) {
    let f; try { f = JSON.parse(text); } catch (e) { alert('that file is not JSON'); return; }
    if (f.id == null || f.m == null) { alert('that file has no id and m — it is not a saved combo'); return; }
    openFile(f);
  }
  /**
   * Open a combo on a shape that is already in hand -- the picture you clicked on the card, or a saved file.
   * The worker's openSaved does the work for both: it re-closes the saved numbers within their own rounding
   * and keeps the curves. Re-solving instead would be wrong here, because a combo's family has many members
   * and the solver could land on a different one -- you would get a different tile from the one you pointed
   * at, which is exactly what a picture is a promise against.
   */
  /**
   * UNDO THE FLIP. The exporter stores a clockwise curved witness as its counter-clockwise MIRROR IMAGE (`fl: 1`):
   * the picture needs counter-clockwise, and this was John's rule for flipping (2026-10-16). The record then
   * carries its own numbering -- vertices reversed, angles A -> 360 - A, edges m-1-k -- and its curves are keyed
   * in that numbering. Explore's session is in the COMBO's numbering, and a curved shape is deliberately not
   * re-aligned on load (curves are indexed by edge), so opening a flipped record as it stands gave curves on the
   * wrong edges: drawn clearance -1.4e-2, -1.8e-2, -8e-5 against +5.5e-2 and the rest when right. The flip is an
   * involution, so applying it again returns the combo-numbered shape and its own curves. Same rule as
   * program7/shape_place.js (flipTemplate): J reverse + (1-x, -y); U y -> -y; S unchanged.
   */
  function unflipShape(shape) {
    if (!shape || !shape.fl || !shape.A || !shape.L) return shape;
    const A = shape.A, L = shape.L, m = L.length, P = k => m - 1 - k;
    const tpl = (type, pts) => type === 'J' ? pts.slice().reverse().map(p => [1 - p[0], -p[1]])
                            : type === 'U' ? pts.map(p => [p[0], -p[1]]) : pts.map(p => [p[0], p[1]]);
    const ed = {};
    for (const k of Object.keys(shape.stored || {})) ed[P(+k)] = { type: shape.stored[k].type, pts: tpl(shape.stored[k].type, shape.stored[k].pts) };
    return Object.assign({}, shape, {
      A: A.map((_, k) => (((360 - A[(m - k) % m]) % 360) + 360) % 360), L: L.map((_, k) => L[P(k)]),
      stored: ed, fl: undefined, es: undefined, we: undefined, mp: undefined });
  }
  function openShape(combo, shape, opt) {
    opt = opt || {};
    shape = unflipShape(shape);
    openFile({ id: combo.id, m: combo.m, si: combo.si, or: combo.or, off: combo.off,
               manual: (shape && shape.A) ? { A: shape.A, L: shape.L } : null,
               curveEdits: (shape && shape.stored) || {},
               // `ca` marks a GENERATED set: it may be re-sized when the shape moves. A hand or designed set has none.
               curvesAuto: !!(shape && shape.ca),
               // 'full' is the tiling, anything else the single tile -- the save file's own spelling.
               // A picture on a card is one tile, so it opens as one; a gallery row IS a tiling.
               view: opt.view === 'tiling' ? 'full' : 'tiles' });
    scrollToShape = true;
  }
  // Clicking a picture should land you on that picture, not at the top of a 1,000-row combo grid.
  let scrollToShape = false;
  function openFile(f) {
    // Whatever mode you were in, opening a combo means you want to look at it.
    // John, 2026-10-12: "if we ever load a combo, we should go right to explore mode."
    if (window.showMode) window.showMode('explore');
    open(f.id);                                            // the type first, so the grid and sizes are right
    const want = f.id;
    FinderPool.sizes(f.id, 40).then(list => {
      if (!st || st.id !== want) return;
      st.sizes = list;
      chooseM(f.m);
      closeWork();
      st.ws = { busy: true, mode: 'true', data: null, frame: null, err: null };
      pz = { z: 1, cx: VS / 2, cy: VS / 2 };
      draw();
      sess = FinderPool.session();
      return sess.then(s => s.call('openSaved', { file: f })).then(d => {
        if (!st || !st.ws) return;
        st.ws.busy = false;
        if (!d.ok) { st.ws.err = d.reason || 'the combo in that file could not be opened'; draw(); return; }
        st.si = d.si; st.or = d.or; st.off = d.off;
        st.ws.data = d; st.ws.frame = frameOf(d.V);
        cv = { edits: d.curves ? JSON.parse(JSON.stringify(d.curves)) : {}, sel: null, hover: null, drag: null,
               note: [f.reduceNote, d.note].filter(Boolean).join(' — ') || null };
        if (f.view === 'full') view = 'tiling';
        patch = null;
        draw();
        draw();                                        // a second pass: the first had no shape to scroll to
      });
    }).catch(err => { if (st && st.ws) { st.ws.busy = false; st.ws.err = String(err.message || err); draw(); } });
  }
  // ---- pictures. The drawing on screen IS the file: same geometry, same colours, with a white background so
  // it is usable outside this page.
  function currentSvg() {
    const el = $('exTileBox') && $('exTileBox').querySelector('svg');
    if (!el) { alert('There is no picture to save yet — open a combo and press "work on this combo".'); return null; }
    const copy = el.cloneNode(true);
    copy.querySelectorAll('circle.cvh').forEach(n => n.remove());      // editing handles are not part of the tile
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', 0); bg.setAttribute('y', 0); bg.setAttribute('width', 520); bg.setAttribute('height', 520);
    bg.setAttribute('fill', '#ffffff');
    copy.insertBefore(bg, copy.firstChild);
    return copy;
  }
  function pictureName(ext) {
    const c = currentCombo();
    return (c ? 'tile_' + c.id + '_m' + c.m + '_si' + c.si + '_or' + c.or + '_off' + c.off : 'tile')
      + (view === 'tiling' ? '_tiling' : '') + '.' + ext;
  }
  function saveSvg() {
    const el = currentSvg(); if (!el) return;
    download(pictureName('svg'), new Blob([new XMLSerializer().serializeToString(el)], { type: 'image/svg+xml' }));
  }
  function savePng() {
    const el = currentSvg(); if (!el) return;
    const SCALE = 2;                                       // twice the drawn size, so it is usable in a document
    const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(el))));
    const img = new Image();
    img.onload = () => {
      const cvs = document.createElement('canvas');
      cvs.width = 520 * SCALE; cvs.height = 520 * SCALE;
      const g = cvs.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, cvs.width, cvs.height);
      g.drawImage(img, 0, 0, cvs.width, cvs.height);
      cvs.toBlob(b => { if (b) download(pictureName('png'), b); else alert('the picture could not be turned into a PNG'); });
    };
    img.onerror = () => alert('the picture could not be turned into a PNG');
    img.src = src;
  }

  // ---- the searches this browser has collected -----------------------------------------------------------
  // A published page cannot write into the repository, so a deep search run here lives in this browser until
  // its file is sent in and imported. This hands over everything at once rather than one search at a time.
  function saveMine() {
    if (!window.LocalStore) { alert('This browser cannot keep your searches.'); return; }
    window.LocalStore.exportAll().then(files => {
      if (!files.length) { alert('This browser has no searches yet. Run one in Deep search first.'); return; }
      const one = files.length === 1;
      download(one ? 'deepsearch_' + files[0].id + '_m' + files[0].startM + '-' + files[0].targetM + '.json'
                   : 'my_searches_' + new Date().toISOString().slice(0, 10) + '.json',
               new Blob([JSON.stringify(one ? files[0] : files, null, 1)], { type: 'application/json' }));
    }).catch(err => alert('could not read this browser\'s searches: ' + (err.message || err)));
  }
  function clearMine() {
    if (!window.LocalStore) return;
    window.LocalStore.all().then(rows => {
      if (!rows.length) { alert('This browser has no searches to forget.'); return; }
      if (!confirm('Forget ' + rows.length + ' searched size' + (rows.length === 1 ? '' : 's') + ' kept in this browser?\n\n'
        + 'Save them first if you have not sent the file — this cannot be undone.')) return;
      window.LocalStore.clearAll().then(() => location.reload());
    });
  }

  function wireFileMenu() {
    const sm = $('saveMine'); if (sm) sm.addEventListener('click', saveMine);
    const cm = $('clearMine'); if (cm) cm.addEventListener('click', clearMine);
    const sc = $('saveCombo'); if (sc) sc.addEventListener('click', saveCombo);
    const cl = $('copyComboLink'); if (cl) cl.addEventListener('click', () => comboLink(false));
    const sl = $('copyShapeLink'); if (sl) sl.addEventListener('click', () => comboLink(true));
    const sv = $('saveSvg'); if (sv) sv.addEventListener('click', saveSvg);
    const pn = $('savePng'); if (pn) pn.addEventListener('click', savePng);
    const lc = $('loadCombo'), inp = $('comboFile');
    if (lc && inp) {
      lc.addEventListener('click', () => { inp.value = ''; inp.click(); });
      inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; if (!f) return;
        const rd = new FileReader(); rd.onload = () => loadComboFile(String(rd.result)); rd.readAsText(f); });
    }
  }
  wireFileMenu();

  /** Land on one combo from another mode: pick the size, wait for its grid, then select the cell. */
  function goTo(m, si, or, off) {
    if (!st) return;
    const land = () => { st.si = si; st.or = or; st.off = off; draw(); };
    if (st.m !== m) {
      chooseM(m);
      // the grid fills row by row; wait for the row this combo is on rather than for the whole size
      let tries = 0;
      const wait = setInterval(() => {
        if (!st || st.m !== m) { clearInterval(wait); return; }
        if (st.rows.has(si) || ++tries > 60) { clearInterval(wait); land(); }
      }, 250);
    } else land();
  }
  return { open, close, loadComboFile, openShape, unflipShape, goTo, openLink };
})();
