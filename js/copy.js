// Copy tiling: you are looking at a tiling -- a picture in a paper, a Myers polyform page, a drawing --
// and you want to know which combo of which type it is.
//
// What you can actually count off a picture is how many m-gon sides each net edge spans, per orbit:
// #25546 reads as "8,6,1,11,8 / 8,8,1,8,8,1". That fixes m (both orbits sum to it) and usually pins the
// combo to a handful. Reducible combos ARE allowed here -- unlike the gallery, which is a catalogue of
// distinct tiles; here you are identifying the thing in front of you, and it may well be a reducible
// description.
//
// ALWAYS ANCHORED. John, 2026-10-07: "For copy tiling, I'd like to always use the anchor option."
// Anchored means both lists are read from the SAME m-gon vertex, the same way round its numbering --
// which is what you do naturally when reading one picture. The free reading (each orbit matched up to
// rotation and reversal independently) returns far more and is not offered.
'use strict';
window.CopyTiling = (function () {
  const $ = id => document.getElementById(id);
  let typeId = null, busy = false, res = null, raw = '', shapes = {}, sel = -1;

  function init(id) {
    if (id != null) typeId = id;
    draw();
  }

  function draw() {
    const row = typeId != null && window.byIdForExplore ? window.byIdForExplore(typeId) : null;
    let h = '<div id="exHead"><h1>Copy tiling</h1></div>'
      + '<div class="copyIntro muted">'
      + '<b>1. Find the type.</b> Count how many net edges each orbit’s tile has — those two numbers are '
      + 'the type’s <b>k</b> and <b>n</b>. Open <b>Explore</b>, set the <i>k_q n_r</i> filter to them, and '
      + 'compare the pictures with your tiling; the orbifold narrows it further if you can read the symmetry. '
      + 'Bring the Tegula number back here.<br>'
      + '<b>2. Count the side sizes.</b> For each orbit, how many sides of the tile each net edge spans, as two '
      + 'lists separated by <b>/</b>. Both must sum to the same number — that is <i>m</i>.<br>'
      + '<b>Start both lists at the same corner of the tile, and go the same way round.</b> '
      + 'That is what makes the answer precise: for #25546 the anchored reading '
      + '<code>8,6,1,11,8 / 8,1,8,8,1,8</code> gives exactly its four real combos, while starting the '
      + 'second list one corner further on gives four different combos, all self-intersecting.</div>'
      + '<div class="copyRow"><label>type</label> <input id="cpId" value="' + (typeId == null ? '' : typeId)
      + '" size="8" placeholder="Tegula #"> '
      + (row ? '<span class="muted">' + row.k + '_' + row.q + ' ' + row.n + '_' + row.r
               + ' · needs <b>' + row.k + '</b> and <b>' + row.n + '</b> sizes · orbifold ' + row.o + '</span>'
             : '<span class="muted">enter a type number</span>')
      + '</div>'
      + '<div class="copyRow"><label>side sizes</label> '
      + '<input id="cpSizes" value="' + raw.replace(/"/g, '&quot;') + '" size="40" '
      + 'placeholder="8,6,1,11,8 / 8,8,1,8,8,1"> '
      + '<button id="cpGo"' + (busy ? ' disabled' : '') + '>' + (busy ? 'searching…' : 'find combos') + '</button>'
      + '<span id="cpNote" class="muted"></span></div>';
    if (res && res.err) h += '<div class="exNote bad">' + res.err + '</div>';
    else if (res) h += resultHtml();
    $('copyBody').innerHTML = h;
    wire();
  }

  function resultHtml() {
    const n = res.hits.length;
    if (!n) {
      let why = 'No combo of type #' + typeId + ' reads that way.';
      if (res.freeOnly) why += ' But <b>' + res.freeOnly + '</b> combo' + (res.freeOnly === 1 ? '' : 's')
        + ' match' + (res.freeOnly === 1 ? 'es' : '') + ' the two lists <i>separately</i> — so the counts are '
        + 'probably right and the two lists just start at different corners. Try rotating one list.';
      else why += ' Check the numbers, or try another type.';
      return '<div class="exNote">' + why + '</div>';
    }
    let h = '<div class="copyFound"><b>' + n + '</b> combo' + (n === 1 ? '' : 's')
      + ' of #' + typeId + ' read that way at m = ' + res.m
      + ' <span class="muted">(' + res.probed.toLocaleString() + ' configurations examined'
      + (res.bothOrders ? '; both orbit orders tried' : '') + ')</span>'
      + '<span class="muted"> — click one to open it in Explore.</span>'
      + (res.freeOnly ? '<div class="muted" style="font-size:12px;margin-top:4px">'
          + res.freeOnly + ' further combo' + (res.freeOnly === 1 ? '' : 's') + ' match the two lists '
          + 'separately but not from a common corner, so they are not shown.</div>' : '')
      + '</div><div class="copyGrid">';
    h += res.hits.map(function (x, i) {
      const sh = shapes[i];
      const cls = 'gtile opens' + (i === sel ? ' on' : '') + (x.kind !== 'ok' ? ' warn' : '');
      let pic;
      if (sh === undefined) pic = '<div class="nodraw">drawing…</div>';
      else if (sh === null) pic = '<div class="nodraw">' + (x.kind === 'self-intersecting' ? 'self-<br>intersecting' : 'no tile') + '</div>';
      else pic = window.Render.tileSvg(sh, 104, { curves: !!sh.stored });
      return '<figure class="' + cls + '" data-i="' + i + '" title="si=' + x.si + ' refl=' + x.or
        + ' off=' + x.off + (x.kind !== 'ok' ? ' — ' + x.kind : '') + '">' + pic
        + '<figcaption>si' + x.si + ' r' + x.or + ' o' + x.off
        + (x.kind !== 'ok' ? '<br><span class="cv">' + x.kind + '</span>' : '') + '</figcaption></figure>';
    }).join('');
    return h + '</div>';
  }

  function wire() {
    const go = $('cpGo'); if (go) go.addEventListener('click', run);
    const sz = $('cpSizes');
    if (sz) sz.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    const idb = $('cpId');
    if (idb) idb.addEventListener('change', () => {
      const v = parseInt(idb.value, 10);
      if (Number.isFinite(v)) { typeId = v; res = null; shapes = {}; sel = -1; draw(); }
    });
    document.querySelectorAll('#copyBody figure[data-i]').forEach(f =>
      f.addEventListener('click', () => open(+f.dataset.i)));
  }

  /** "8,6,1,11,8 / 8,8,1,8,8,1" -> [[...],[...]], or null */
  function parse(text) {
    const parts = String(text || '').split('/');
    if (parts.length !== 2) return null;
    const nums = s => s.split(/[,\s]+/).filter(Boolean).map(Number);
    const a = nums(parts[0]), b = nums(parts[1]);
    if (!a.length || !b.length || a.concat(b).some(x => !Number.isFinite(x) || x <= 0)) return null;
    return [a, b];
  }

  function run() {
    if (busy) return;
    const idv = parseInt(($('cpId') || {}).value, 10);
    if (!Number.isFinite(idv)) { alert('enter a Tegula type number'); return; }
    typeId = idv;
    raw = ($('cpSizes') || {}).value || '';
    const lists = parse(raw);
    if (!lists) { res = { err: 'type two lists of positive whole numbers separated by / — e.g. 8,6,1,11,8 / 8,8,1,8,8,1' }; draw(); return; }
    busy = true; res = null; shapes = {}; sel = -1; draw();
    const note = $('cpNote');
    FinderPool.ready()
      .then(() => FinderPool.findSizes(typeId, lists[0], lists[1], p => {
        if (note) note.textContent = 'sum-type ' + p.si + ' of ' + p.total + ' — ' + p.found + ' so far';
      }))
      .then(r => { busy = false; res = r; draw(); if (r && r.hits) drawHits(); })
      .catch(e => { busy = false; res = { err: String(e.message || e) }; draw(); });
  }

  // Each hit is solved in the pool so the results read as a gallery rather than a table of numbers.
  // One at a time, in order, so the pictures fill in top-down and a long list stays responsive.
  function drawHits() {
    // the SAME array, not a copy: it is the token that says "these results are still on screen",
    // and a copy never equals res.hits, so every drawn shape was thrown away
    const hits = res.hits;
    let i = 0;
    (function next() {
      if (i >= hits.length || !res || res.hits !== hits) return;
      const x = hits[i], mine = i;
      FinderPool.judge({ id: typeId, m: x.m, si: x.si, or: x.or, off: x.off },
                       { withReducible: true, curveBudgetMs: 4000 })
        .then(r => {
          const d = r && r.details;
          shapes[mine] = (d && d.shape && d.shape.A) ? d.shape : null;
        })
        .catch(() => { shapes[mine] = null; })
        .then(() => { if (res && res.hits === hits) { draw(); i++; next(); } });
    })();
  }

  function open(i) {
    const x = res && res.hits[i]; if (!x) return;
    sel = i;
    if (window.showMode) window.showMode('explore');
    window.Explore.openShape({ id: typeId, m: x.m, si: x.si, or: x.or, off: x.off },
                             shapes[i] || null, { view: 'tiling' });
  }

  /** prev / next through the results from inside Explore. */
  function step(dir) {
    if (!res || !res.hits.length) return false;
    const n = res.hits.length;
    open(((sel < 0 ? (dir > 0 ? -1 : 0) : sel) + dir + n) % n);
    return true;
  }
  function count() { return res && res.hits ? res.hits.length : 0; }

  return { init, draw, step, count };
})();
