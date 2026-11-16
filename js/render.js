// Drawing one tile. Extracted from picker.js so every mode -- gallery, deep search, copy tiling,
// explore -- draws from ONE implementation rather than each growing its own.
//
// Nothing here solves. It takes (A, L) -- interior angles and edge lengths -- and draws. A turtle
// walk over those reproduces the engine's TC.verticesOf EXACTLY (checked: max vertex error 0.00e+0),
// which is why no solver needs porting into the browser.
'use strict';
window.Render = (function () {

  /** Corner positions from interior angles + edge lengths. Matches TC.verticesOf exactly. */
  function tileVerts(A, L) {
    const v = [[0, 0]]; let x = 0, y = 0, dir = 0;
    for (let i = 0; i < L.length; i++) {
      x += L[i] * Math.cos(dir); y += L[i] * Math.sin(dir); v.push([x, y]);
      dir += Math.PI - A[(i + 1) % A.length] * Math.PI / 180;
    }
    return v.slice(0, L.length);
  }

  /**
   * Walk whichEdge to this edge's orbit REPRESENTATIVE, XOR-accumulating the Klein-4 mapping codes
   * along the way. Mirrors mono2iso.js's repMap exactly.
   * code: 0 = as-is, 1 = reversed, 2 = negated, 3 = both.
   */
  function repOf(m, we, mp, i) {
    let cur = i, code = 0, guard = 0;
    while (we && we[cur] != null && we[cur] !== cur && guard++ < m) { code ^= (mp && mp[cur]) || 0; cur = we[cur]; }
    return { rep: cur, code };
  }

  // One curve per edge ORBIT -- but each edge carries that curve TRANSFORMED BY ITS OWN KLEIN CODE.
  //
  // This is the part my first version got wrong, and John caught it on #48, #123 and #130: "the
  // example shown on the side panel won't tile with this symmetry group." Without applyMap, an edge
  // that must carry the reflected or end-swapped version of its orbit's curve carried the raw one, so
  // matching edges did not match and the drawn tile did not tile. Three things were wrong:
  //   * the orbit was taken as we[i], a single hop, instead of walking all the way to the rep;
  //   * the edge TYPE was read from edge i instead of from the rep (only the rep's type is meaningful);
  //   * the per-edge mapping code was never accumulated and never applied.
  // Correct assembly, matching mono2iso.js:1384-1392 exactly.
  /**
   * The per-orbit curve EDITS a tile is actually drawn with: its own stored ones where it has them,
   * and the decorative motif chosen by ORBIT POSITION otherwise. Returned in the {rep: {type, pts}}
   * shape a combo file stores, so Explore can be opened on exactly the picture the gallery shows.
   *
   * John, 2026-10-14: "For the gallery-click, we go to full-tiling but with no design curves, just
   * straight edges. I like the full-tiling mode, but would like to see the same curves as the
   * gallery." The click passed only `stored`, so a tile drawn with DECORATIVE motifs arrived in
   * Explore bare, and "design curves" then invented a third set.
   *
   * Motif choice is by orbit position, not representative index: rep % motifCount collides, because
   * the bank is DOUBLED (second half y-negated), so two distinct U orbits drew the same shape
   * mirrored -- #25642 m6 si2/or1/off0, we = [0,0,0,0,4,4]. John, 2026-10-10: "We should always pick
   * a different shaped U curve if the edges don't match." nthOrbit counts every new orbit, stored or
   * not, so the sequence matches whatever curveSet would have picked.
   */
  function curveEdits(m, we, es, stored, mp) {
    const TCv = window.TilerCurves;
    if (!TCv) return {};
    const out = {};
    let nthOrbit = 0;
    for (let i = 0; i < m; i++) {
      const { rep } = repOf(m, we, mp, i);
      if (Object.prototype.hasOwnProperty.call(out, rep)) continue;
      const t = TCv.SYM ? (TCv.SYM[es ? es[rep] : 0] || 'I') : 'I';
      if (stored && stored[rep]) {
        out[rep] = { type: stored[rep].type, pts: stored[rep].pts };
      } else {
        let e = null;
        try {
          const n = TCv.motifCount ? TCv.motifCount(t) : 0;
          if (n) e = { type: t, pts: TCv.motifPts(t, nthOrbit % n), auto: true };
        } catch (err) { e = null; }
        out[rep] = e;                                  // null for an I edge: nothing to draw
      }
      nthOrbit++;
    }
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }
  /** Those edits, built and placed into each edge through its Klein code. */
  function curveSet(m, we, es, stored, mp) {
    if (!window.TilerCurves) return null;
    const TCv = window.TilerCurves;
    const edits = curveEdits(m, we, es, stored, mp);
    const byRep = {}, out = [];
    for (let i = 0; i < m; i++) {
      const { rep, code } = repOf(m, we, mp, i);
      if (byRep[rep] === undefined) {
        const ed = edits[rep];
        let c = null;
        if (ed) { try { c = TCv.buildCanon(ed.type, ed.pts); } catch (e) { c = null; } }
        byRep[rep] = c || [[0, 0], [1, 0]];
      }
      let placed = byRep[rep];
      if (code && TCv.applyMap) { try { placed = TCv.applyMap(byRep[rep], code); } catch (e) {} }
      out.push(placed);
    }
    return out;
  }

  /** Boundary points for a tile: curved if curves are asked for and buildable, straight otherwise. */
  function boundary(shape, curves) {
    const base = tileVerts(shape.A, shape.L);
    if (!curves) return base;
    const cs = curveSet(shape.A.length, shape.we, shape.es, shape.stored, shape.mp);
    if (cs && window.TilerCurves && window.TilerCurves.curvedTile) {
      try { return window.TilerCurves.curvedTile(base, cs); } catch (e) { return base; }
    }
    return base;
  }

  function bbox(pts) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
    return { minx: a, miny: b, maxx: c, maxy: d, w: c - a, h: d - b };
  }

  /**
   * SVG markup for one tile, fitted to a px box.
   * shape: { A, L, we, es, stored? }
   */
  function tileSvg(shape, px, opts) {
    opts = opts || {};
    if (!shape || !shape.A || !shape.L) return '';
    const fill = opts.fill || 'var(--tile,#9ec5fe)';
    const pts = boundary(shape, opts.curves !== false);
    const bb = bbox(pts), pad = opts.pad === undefined ? 6 : opts.pad;
    const sc = (px - 2 * pad) / Math.max(bb.w, bb.h, 1e-9);
    // centre it in the box rather than pinning to a corner, so a grid of tiles reads evenly
    const ox = pad + (px - 2 * pad - bb.w * sc) / 2, oy = pad + (px - 2 * pad - bb.h * sc) / 2;
    const X = p => (ox + (p[0] - bb.minx) * sc).toFixed(2);
    // SVG y grows downward; flip so the tile is not drawn mirrored
    const Y = p => (px - oy - (p[1] - bb.miny) * sc).toFixed(2);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p) + ' ' + Y(p)).join(' ') + ' Z';
    return '<svg viewBox="0 0 ' + px + ' ' + px + '" width="' + px + '" height="' + px + '" '
         + 'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
         + '<path d="' + d + '" fill="' + fill + '" '
         // A 1 px stroke in the FILL's colour, so a narrow section stays visible instead of vanishing to a hair (John,
         // 2026-10-17). non-scaling-stroke keeps it 1 screen pixel however the svg is scaled. A caller may still pass its own.
         + 'stroke="' + (opts.stroke || fill) + '" stroke-width="' + (opts.strokeWidth || 1)
         + '" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
  }

  /** A standalone .svg file for download (Save SVG), with real colours rather than CSS vars. */
  function tileSvgFile(shape, px, opts) {
    opts = Object.assign({ fill: '#9ec5fe', stroke: '#1b2733' }, opts || {});
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + tileSvg(shape, px || 512, opts);
  }

  return { tileVerts, curveSet, curveEdits, repOf, boundary, bbox, tileSvg, tileSvgFile };
})();
