// The gallery: a page of every anisohedral TILE we have found.
//
// John's spec: "a full page of images. have the sections separated as before - and expandable. I'd like all
// to start as just a single tile. If you click any tile, the right hand panel shows all full tilings that can
// use this - scrolling allowed. If you click one full tiling, you go into explore mode."
//
// A tile is a SHAPE, not a combo: 2,332 shapes realise 3,926 tilings, and 923 of those shapes tile in more
// than one way. So the page is shapes, each drawn once, and the panel lists the tilings that use the one you
// clicked. program7/export_gallery.js does the grouping, by congruence.tileKey.
//
// Three rules this has to keep:
//   * Curves are drawn only when the find STORED them. Render.curveSet's fallback is a decorative motif, and
//     a decoration turned #3187's rhombus into a spiky star.
//   * Clicking a tiling opens it on a stored shape, never on a fresh solve -- a combo's family has many
//     members and a re-solve can land on a different one, so you would get a different tile from the one you
//     pointed at.
//   * ...but on ITS OWN stored shape, not the drawn one. The tiles in a group are congruent, not identically
//     written: 1,357 of the 1,594 sibling tilings list the same tile from a different starting corner, and a
//     combo only closes on the array written in its own walk.
//
// Sections draw only when opened: 2,332 tiles is far more SVG than one page wants, and a visit looks at one
// or two sizes.
'use strict';
window.Gallery = (function () {
  const $ = id => document.getElementById(id);
  // every gallery tile is an anisohedral find, so it wears the anisohedral green (John, 2026-10-17)
  const GAL_FILL = 'var(--good,#36c275)';
  let open = {};            // which sections are expanded
  let sel = null;           // { s, i } the tile the right panel is showing
  let drawn = {};           // section id -> rendered HTML, so re-opening is instant
  // asked for at load time: the picker rewrites the hash to the selected type a moment later
  const WANT_PDF = location.hash === '#gallery-pdf';
  let state = 'idle';       // 'idle' | 'loading' | 'ready' | 'failed'
  // Group a section's tiles by CONTAINMENT: A is inside B when every shape A can take, curves included,
  // B can take too (John's definition, 2026-10-11). One-way -- B may be strictly more general.
  //
  // This replaces an earlier grouping by which isohedral criterion was recorded, which John ruled out:
  // "drop anything that rests on matching labels". Rightly so -- those labels are whatever the block
  // search found before it stopped (#25577 m4 is recorded [6] but exhaustively satisfies [1,6]), and
  // sharing a criterion says nothing about one family sitting inside another.
  //
  // export_gallery.js attaches `inside` and `has` per tile from containment_sweep.js. 879 of the 1,182
  // containments are within a single tile and already merged by tileKey; the 257 that relate DIFFERENT
  // tiles are what this view shows.
  // Containment is how the gallery reads, not a setting: a tile belongs under the most general form
  // that can take every shape it can. John, 2026-10-12: "I don't want a checkbox to ask if we want
  // containment. We should default to containment."

  function G() { return window.GALLERY; }
  /** Every tile by tid, across all sections (containment is within one m, but the unbalanced
   *  section is grouped by shape, so never assume the partner is in the same section). */
  let _byTid = null;
  function byTid() {
    if (!_byTid) {
      _byTid = {};
      const g = G(); if (!g) return _byTid;
      for (const sec of g.sections) for (const t of sec.tiles) if (t.tid) _byTid[t.tid] = t;
    }
    return _byTid;
  }
  /** a's family is a PROPER part of b's: inside b, and b not inside a (mutual = the same family). */
  const strictIn = (a, b) => !!a && !!b && (a.inside || []).indexOf(b.tid) >= 0
                                        && (b.inside || []).indexOf(a.tid) < 0;
  /**
   * ONE PICTURE PER FAMILY. Mutual containment means the same family -- each tile can take every
   * shape the other can -- so drawing both is drawing the same thing twice, at two different members.
   * John, 2026-10-13: "two forms of #25523 seem to match. Also three forms of #25550. Also two forms
   * of #209220 ... also #25520." Every one of those is a mutual class, and they are NOT mirror images
   * of each other: they are different members of one family (checked -- no pair matches as a shape,
   * even up to rotation, reflection and scale).
   *
   * Mirror matching itself IS done, upstream: containment_sweep tries all 2m relabellings, both
   * directions, which is exactly why these came out mutual in the first place.
   *
   * The class is the transitive closure of mutual edges. Its representative is the member that needs
   * no curves if the family has one -- a tile that only tiles WITH its curves is a restricted picture
   * of a family that tiles straight, and the general picture is the one to show (John, 2026-10-12).
   * Then the tile with the most tilings (the most informative picture), ties broken by tid so the
   * choice is stable across builds.
   */
  let _repOf = null, _classOf = null;
  function repOf(t) {
    if (!_repOf) {
      _repOf = {}; _classOf = {};
      const bt = byTid();
      const mutual = (a, b) => !!a && !!b && (a.inside || []).indexOf(b.tid) >= 0
                                          && (b.inside || []).indexOf(a.tid) >= 0;
      const seen = {};
      for (const tid of Object.keys(bt)) {
        if (seen[tid]) continue;
        const cls = [], queue = [tid];
        seen[tid] = true;
        while (queue.length) {
          const cur = bt[queue.shift()];
          cls.push(cur);
          for (const id of (cur.inside || []))
            if (!seen[id] && mutual(cur, bt[id])) { seen[id] = true; queue.push(id); }
        }
        cls.sort((a, b) => (b.tilings.length - a.tilings.length) || (a.tid < b.tid ? -1 : 1));
        for (const x of cls) { _repOf[x.tid] = cls[0].tid; _classOf[x.tid] = cls; }
      }
    }
    return _repOf[t.tid] || t.tid;
  }
  /** every tile in a tile's mutual class, itself included */
  function classOf(t) { repOf(t); return (_classOf && _classOf[t.tid]) || [t]; }
  /** not drawn: a strictly more general form exists, or another member of its family represents it */
  const hidden = t => (t.inside || []).some(id => strictIn(t, byTid()[id])) || repOf(t) !== t.tid;
  // Every tile carries the curves it is drawn with (program7/export_aniso_shapes.js stores ONE set per
  // shape: John's hand curves, a designed set, or a generated one sized so the drawn outline never
  // touches itself). So there is nothing to switch: the picture IS the stored shape. John, 2026-10-15:
  // "I like to see edges with curves so I can see what matches. I wouldn't want to see just straight
  // lines unless it was all I curves" -- an all-I tile simply has no orbit to curve.
  // ...except an unbalanced tile, stored with `straight: 1` so its polyomino / polyhex outline shows (John, 2026-10-20).
  const curvesFor = t => !(t && t.straight);

  // data/gallery.js is 839 KB and only this mode needs it, so it loads on first entry. Injected as a
  // <script> rather than fetched, for the same reason as types.js: the app must keep working from file://,
  // where fetch() of a local file is blocked.
  function init() {
    if (state === 'ready') { draw(); return; }
    if (state === 'failed') { fail(); return; }
    if (state === 'loading') return;
    state = 'loading';
    $('galBody').innerHTML = '<div class="placeholder">loading the gallery…</div>';
    const el = document.createElement('script');
    el.src = 'data/gallery.js';
    el.onload = () => { if (!G()) { state = 'failed'; fail(); return; } state = 'ready'; start();
      if (WANT_PDF) showPrint(); };      // program7/export_gallery_pdf.js opens the page this way
    el.onerror = () => { state = 'failed'; fail(); };
    document.head.appendChild(el);
  }
  function fail() {
    $('galBody').innerHTML = '<div class="placeholder bad">data/gallery.js did not load — run '
      + '<code>node program7/export_gallery.js</code>.</div>';
  }
  function start() {
    const g = G();
    if (!Object.keys(open).length && g.sections.length) open[g.sections[0].id] = true;  // unbalanced, open first
    draw();
  }

  function draw() {
    const g = G(); if (!g) return;
    // counts follow what is DRAWN: restricted forms live in a general tile's panel, not the grid
    const nTiles = g.sections.reduce((a, s) => a + s.tiles.filter(t => !hidden(t)).length, 0);
    const nTilings = g.sections.reduce((a, s) => a + s.tiles.reduce((b, t) => b + t.tilings.length, 0), 0);
    let h = '<div class="galHead"><b>' + nTiles.toLocaleString() + '</b> anisohedral tiles, realising <b>'
      + nTilings.toLocaleString() + '</b> tilings. <span class="muted">Each shape is drawn once, in its most '
      + 'general form — click it to see every combo that fits it, including the more restricted ones. '
      + 'Reducible combos are never shown here.</span>'
      + '<button id="galPrintBtn" style="display:block;margin-top:8px" title="every tile on one flowing page, for your browser\'s print dialog: choose Save as PDF">Save the whole gallery as a PDF…</button>'
      + '</div>';
    for (const s of g.sections) {
      const isOpen = !!open[s.id];
      const nt = s.tiles.reduce((a, t) => a + t.tilings.length, 0);
      const nShown = s.tiles.filter(t => !hidden(t)).length;
      h += '<section class="galSec"><button class="galToggle' + (s.swept ? ' swept' : '') + '" data-sec="'
        + s.id + '" aria-expanded="' + isOpen + '"><span class="caret">' + (isOpen ? '▾' : '▸') + '</span>'
        + ' <b>' + s.title + '</b>'
        + ' <span class="muted">' + nShown + ' tile' + (nShown === 1 ? '' : 's')
        + (nt !== nShown ? ', ' + nt + ' tilings' : '') + '</span></button>'
        // The note explains what the section's heading claims. It shows only when the section is OPEN:
        // seventeen of them in the collapsed list would bury the headings they are explaining.
        + (isOpen && s.note ? '<div class="galNote muted">' + s.note + '</div>' : '')
        + '<div class="galGrid" id="gal_' + s.id + '"' + (isOpen ? '' : ' hidden') + '></div></section>';
    }
    $('galBody').innerHTML = h;
    const pb = $('galPrintBtn'); if (pb) pb.addEventListener('click', printAll);
    $('galBody').querySelectorAll('.galToggle').forEach(b => b.addEventListener('click', () => {
      open[b.dataset.sec] = !open[b.dataset.sec]; draw();
    }));
    for (const s of g.sections) if (open[s.id]) fill(s);
    panel();
  }

  // ---- the whole gallery as one printable document (browser print dialog -> Save as PDF) ----------------------------
  // The same tiles the grid draws (a tile strictly inside another is not drawn), every section open, one flowing page with
  // a heading per section. Green on white so it prints well. app.css hides everything else while body has .galPrinting.
  function printHtml() {
    const g = G(); if (!g) return '';
    const shown = s => s.tiles.filter(t => !hidden(t));
    const nTiles = g.sections.reduce((a, s) => a + shown(s).length, 0);
    const nTilings = g.sections.reduce((a, s) => a + s.tiles.reduce((b, t) => b + t.tilings.length, 0), 0);
    let h = '<h1>mono2iso gallery</h1><p class="prLead">' + nTiles.toLocaleString() + ' anisohedral tiles, realising ' + nTilings.toLocaleString()
      + ' tilings. Each shape is drawn once, in its most general form. Caption: tegula number (+ how many more types share the shape), '
      + 'number of sides m, and the number of tilings if more than one. Reducible combos are never shown.</p>';
    for (const s of g.sections) {
      const ts = shown(s); if (!ts.length) continue;
      h += '<section class="prSec"><h2>' + s.title + ' <span>' + ts.length + ' tile' + (ts.length === 1 ? '' : 's') + '</span></h2>'
        + (s.note ? '<p class="prNote">' + s.note + '</p>' : '') + '<div class="prGrid">'
        + ts.map(t => {
          const svg = window.Render ? window.Render.tileSvg(t, 96, { curves: curvesFor(t), fill: '#36c275', stroke: '#1f7a49' }) : '';
          const n = t.tilings.length;
          return '<figure class="prFig">' + (svg || '<div class="nodraw">no shape</div>') + '<figcaption>#' + t.types[0]
            + (t.types.length > 1 ? ' +' + (t.types.length - 1) : '') + ' m' + t.m + (n > 1 ? ' ' + n + '×' : '') + '</figcaption></figure>';
        }).join('') + '</div></section>';
    }
    return h;
  }
  function showPrint() {
    let el = $('galPrint');
    if (!el) { el = document.createElement('div'); el.id = 'galPrint'; document.body.appendChild(el); }
    el.innerHTML = printHtml();
    document.body.classList.add('galPrinting');
  }
  function printAll() {
    const btn = $('galPrintBtn'); if (btn) { btn.disabled = true; btn.textContent = 'preparing…'; }
    setTimeout(() => {                                    // let the button repaint: a few thousand SVGs take a moment
      showPrint();
      window.print();
      document.body.classList.remove('galPrinting');
      const b = $('galPrintBtn'); if (b) { b.disabled = false; b.textContent = 'Save the whole gallery as a PDF…'; }
    }, 30);
  }

  /** One tile's figure. data-i indexes the SECTION's tile list, so clicks work in either layout. */
  function figureHtml(t, i, why) {
    const svg = window.Render ? window.Render.tileSvg(t, 104, { curves: curvesFor(t), fill: GAL_FILL }) : '';
    const n = t.tilings.length;
    return '<figure class="gtile opens" data-i="' + i + '" title="#'
      + t.types.join(' #') + ' · m=' + t.m + ' · ' + n + ' tiling' + (n === 1 ? '' : 's')
      + '">'
      + (svg || '<div class="nodraw">no shape</div>')
      + '<figcaption>#' + t.types[0] + (t.types.length > 1 ? ' +' + (t.types.length - 1) : '')
      + ' m' + t.m + (n > 1 ? ' <span class="cv">' + n + '×</span>' : '')
      + (why && why.length ? '<br><span class="galWhy">' + why.join('<br>') + '</span>' : '')
      + '</figcaption></figure>';
  }


  /** One section's tiles. Built once and kept: re-opening a section should not redraw 400 SVGs. */
  function fill(s) {
    const box = $('gal_' + s.id); if (!box) return;
    // Show the GENERAL picture, never the restricted one. John, 2026-10-12: "we need to put the
    // general picture in the gallery, not the restricted one." A tile STRICTLY inside another (its
    // family is a proper part of that one's) is not drawn here at all -- it is reached by clicking
    // the general tile, whose panel lists its combos marked "extra restrictions". Mutual pairs are
    // the same family, so one of them stands for all of them -- see repOf.
    if (!drawn[s.id]) drawn[s.id] = s.tiles.map((t, i) => hidden(t) ? '' : figureHtml(t, i)).join('');
    box.innerHTML = drawn[s.id];
    box.querySelectorAll('figure[data-i]').forEach(f => {
      if (sel && sel.s === s.id && sel.i === +f.dataset.i) f.classList.add('on');
      f.addEventListener('click', () => {
        sel = { s: s.id, i: +f.dataset.i };
        document.querySelectorAll('#galBody figure.on').forEach(o => o.classList.remove('on'));
        f.classList.add('on');
        panel();
        const p = $('galPanel'); if (p) p.scrollTop = 0;
      });
    });
  }

  /** The right panel: every tiling that uses the chosen tile. */
  function panel() {
    const el = $('galPanel'); if (!el) return;
    const g = G();
    if (!sel || !g) {
      el.innerHTML = '<div class="placeholder">Click a tile to see every tiling that uses it.</div>';
      return;
    }
    const s = g.sections.find(x => x.id === sel.s), t = s && s.tiles[sel.i];
    if (!t) { el.innerHTML = ''; return; }
    const svg = window.Render ? window.Render.tileSvg(t, 220, { curves: curvesFor(t), fill: GAL_FILL }) : '';
    const n = t.tilings.length;
    let h = '<div class="galBig">' + (svg || '<div class="nodraw">no shape</div>') + '</div>'
      + '<div class="meta">m = <b>' + t.m + '</b> &nbsp;·&nbsp; type' + (t.types.length > 1 ? 's' : '') + ' '
      + t.types.map(i => '<b>#' + i + '</b>').join(', ')
      + '</div>';
    if (t.types.length > 1)
      h += '<div class="why muted">The same shape tiles as ' + t.types.length + ' different types.</div>';
    // EVERY combo of this shape family: this tile's own, those of any tile in the SAME family
    // (mutual containment), and those of every tile strictly INSIDE it -- the restricted forms,
    // which are not drawn in the grid at all. John, 2026-10-12: "we need to put the general picture
    // in the gallery, not the restricted one", and "When we click a shape, it lists the combos that
    // fit it. This is where to list all combos, and if they have extra restrictions" -- "I wouldn't
    // even try to identify what the restriction is. Just say 'extra restrictions'."
    const bt = byTid();
    const rel = id => bt[id];
    // Expand both over mutual CLASSES: what is contained is a whole family, not one member of it.
    // Without this a narrower tile whose class representative is itself strictly inside something
    // becomes unreachable -- its class-mate is drawn nowhere and listed nowhere (it happened to
    // t406 and t2023).
    const same = classOf(t).filter(o => o.tid !== t.tid);
    const narrowerSeed = (t.has || []).map(rel).filter(o => o && strictIn(o, t));
    const narrower = [];
    const taken = new Set([t.tid].concat(same.map(o => o.tid)));
    for (const o of narrowerSeed) for (const x of classOf(o))
      if (!taken.has(x.tid)) { taken.add(x.tid); narrower.push(x); }
    const listed = [t].concat(same, narrower);
    const rows = [];
    for (const tile of listed) {
      const extra = strictIn(tile, t);
      tile.tilings.forEach((x, k) => rows.push({ x, tile, extra, isRep: tile === t && k === t.rep }));
    }
    const anyExtra = rows.some(r => r.extra);
    h += '<h3>' + rows.length + ' combo' + (rows.length === 1 ? '' : 's') + ' fit'
      + (rows.length === 1 ? 's' : '') + ' this shape</h3>'
      + '<div class="muted galHint">Click one to open it in Explore, on that tiling’s own shape.'
      + (rows.length > 1 ? ' The <b>marked</b> row is the one drawn above.' : '')
      + (narrower.length ? ' The ones marked <b>extra restrictions</b> are more restricted forms of this same shape.' : '')
      + '</div>'
      + '<table class="combos"><thead><tr><th>type</th><th>m</th><th>si</th><th>refl</th><th>off</th>'
      + '<th title="how many tiles in the block that tiles isohedrally">block</th>'
      + '<th>criteria</th>' + (anyExtra ? '<th></th>' : '') + '</tr></thead><tbody>'
      + rows.map((r, j) => '<tr class="galRow opens' + (r.isRep ? ' isrep' : '') + '" data-j="' + j
        + '" title="open in Explore"><td>#' + r.x.id + '</td><td>' + r.x.m + '</td><td>' + r.x.si + '</td><td>'
        + r.x.or + '</td><td>' + r.x.off + '</td><td>' + (r.x.block || '—') + '</td><td>'
        + ((r.x.crit || []).join(', ') || '—') + '</td>'
        + (anyExtra ? '<td class="galExtra muted">' + (r.extra ? 'extra restrictions' : '') + '</td>' : '')
        + '</tr>').join('')
      + '</tbody></table>';
    el.innerHTML = h;
    el.querySelectorAll('.galRow').forEach(row => row.addEventListener('click', () => {
      const j = +row.dataset.j, r = rows[j], x = r.x, rt = r.tile;
      const key = x.id + '/' + x.m + '/' + x.si + '/' + x.or + '/' + x.off;
      const go = () => {
        // Its own array, not the drawn one -- see rule 3 in the header.
        let shape = (window.ANISO_SHAPES || {})[key];
        if (!shape && rt.rep !== undefined && rt.tilings[rt.rep] === x) shape = { A: rt.A, L: rt.L, stored: rt.stored, fl: rt.fl };
        // Open on the curves the gallery IS SHOWING, not just the stored ones. A straight tile drawn
        // with decorative motifs used to arrive in Explore bare, and "design curves" then invented a
        // third set. John, 2026-10-14: "would like to see the same curves as the gallery."
        // With the curves of the COMBO'S OWN record and its own numbering (shape.we/es/mp): the gallery tile (rt) is drawn
        // counter-clockwise and may be numbered the other way round (2026-10-20), so its arrays do not fit this combo.
        if (shape && window.Render && window.Render.curveEdits && curvesFor(rt)) {
          const drawn = shape.we ? window.Render.curveEdits(shape.L.length, shape.we, shape.es, shape.stored, shape.mp)
                                 : window.Render.curveEdits(rt.m, rt.we, rt.es, shape.stored || rt.stored, rt.mp);
          if (drawn && Object.keys(drawn).length) shape = Object.assign({}, shape, { stored: drawn });
        }
        if (!shape) console.warn('gallery: no stored shape for ' + key + ' — Explore will solve it fresh');
        if (window.showMode) window.showMode('explore');
        // A row in this table is a TILING, so it opens as the tiling rather than as the lone tile.
        window.Explore.openShape({ id: x.id, m: x.m, si: x.si, or: x.or, off: x.off }, shape,
                                 { view: 'tiling' });
      };
      if (window.ANISO_SHAPES || !window.loadAnisoShapes) go(); else window.loadAnisoShapes(go);
    }));
  }

  return { init, draw };
})();
