// Curves for a tile that has none: one curve per edge orbit, big enough to SEE, small enough that the
// drawn outline never touches itself.
//
//   const CS = makeCurveSizing({ TD, TCv, CD });
//   CS.size(ctx, A, L)                       -> { ok, edits, clearance, straight, visibility, meta }
//   CS.size(ctx, A, L, { meta: prevMeta })   -> same, re-fitting only the SCALES (fast; for a slider move)
//
// ctx is the finder's curve context: { TC, m, edgeSym, whichEdge, mapping }.
//
// WHY THIS EXISTS. The gallery used to decorate a curve-free tile with fixed-size sample motifs, to show
// which edges are identified. Measured over 3,613 such tiles (2026-10-15), the samples at least halved
// the tile's clearance on 3,428 and made the drawn outline CROSS ITSELF on 231 -- 72991/8/1/0/1 is one:
// its straight outline has a 4.6% gap and the samples closed it. John: "some of the images in the
// gallery look like they have very small gaps - if any." The curves were never checked against the tile.
//
// WHAT IT DOES. For each non-I orbit it picks a motif (any of the type's motifs, either way up) and a
// scale, to maximise the FAINTEST orbit's bulge -- measured as a fraction of the tile's diameter, on
// that orbit's shortest edge, capped once it is plenty -- subject to the drawn outline keeping at least
// half the straight outline's clearance. Every candidate is evaluated on the points as they will be
// STORED (rounded to 4 decimals), so what is verified is exactly what is drawn.
//
// FULL-EDGE SHAPES (John, 2026-10-18). The type's own motifs are small marks (at most ~0.1 of the edge), and on a short
// edge of a big tile they come out a pixel or two high in a thumbnail -- the two edge types cannot be told apart. When
// the faintest U or S orbit is that faint, it is given a FULL-EDGE shape instead: a U bulging across the whole edge (the
// rounded curve John drew on 1727342 m10 si31, or a squared-off one) and, for S, the same U squeezed onto half the edge
// so that the S's point symmetry turns it into a real S. Two orbits of one type take different ones. Only faint orbits change.
//
// ONE SELF-CONTAINED FUNCTION on purpose. The browser runs the finder inside Web Workers built from a
// Blob, which cannot load files; finder_pool.js posts this function's SOURCE (makeCurveSizing.toString())
// into each worker, and the node exporter requires it. Nothing in it may reach outside its own body.
function makeCurveSizing(deps) {
  'use strict';
  const TD = deps.TD, TCv = deps.TCv, CD = deps.CD;
  const VCAP = 0.02;                   // a bulge that moves 2% of the diameter (2px at thumbnail size) is plenty
  const KEEP = 0.5;                    // keep at least half of the straight outline's clearance
  const FLOOR = 1e-3;                  // never below 10x the simplicity gate (1e-4); hand shapes clear it too
  const SCALES = [0.04, 0.07, 0.11, 0.16, 0.23, 0.33, 0.47, 0.67, 0.95];
  const THUMB_PX = 96;                 // the gallery thumbnail
  const FAINT_PX = 1.9;                // an orbit that cannot reach 2 px (the old "plenty") in the thumbnail is "a pixel or two": too small to see
  const FULL_CAP_PX = 6;               // a full-edge shape is sized up to about this many pixels, no further
  // the two U bases, as editor points (the drawn half; the last point is the fold): rounded (John's) and squared-off
  const FULL_U = [[[0, 0], [0.2143, -0.3536], [0.5, -0.4644]], [[0, 0], [0.07, -0.4644], [0.5, -0.4644]]];
  const FULLN = 4;                     // per type: 2 bases x 2 sides
  const isUS = t => t === 'U' || t === 'S';
  const r4 = x => Math.round(x * 1e4) / 1e4;

  function frame(ctx, A, L) {
    const m = ctx.m, TC = ctx.TC;
    const V = TC.verticesOf(A, L, m).slice(0, m);
    const rc = TD.repMapping(m, ctx.whichEdge, ctx.mapping, ctx.edgeSym).rc;
    const order = [], shortest = {};
    for (let i = 0; i < m; i++) {
      const o = rc[i];
      if (o.type === 'I') continue;
      if (shortest[o.rep] === undefined) { shortest[o.rep] = L[i]; order.push(o.rep); }
      else shortest[o.rep] = Math.min(shortest[o.rep], L[i]);
    }
    let diam = 0;
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++)
      diam = Math.max(diam, Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1]));
    const type = {};
    for (const o of rc) type[o.rep] = o.type;
    return { V, rc, order, shortest, diam: diam || 1, type };
  }
  // variant numbers at or above the type's own motif count are the full-edge shapes: j = v - count, base j % 2, side j >= 2
  function fullPts(type, j) {
    const base = FULL_U[j % 2], sign = j >= 2 ? -1 : 1;
    let pts = base;
    if (type === 'S') {              // the whole U squeezed onto the S's first half; buildCanon turns the other half into the opposite bump
      pts = TCv.buildCanon('U', base).map(p => [p[0] * 0.5, p[1] * 0.5]);
    }
    return pts.map(p => [p[0], p[1] * sign]);
  }
  const motif = (type, v, s) => {
    const n = TCv.motifCount(type);
    const raw = (v >= n && isUS(type)) ? fullPts(type, v - n) : TCv.motifPts(type, v);
    return { type, pts: raw.map(p => [r4(p[0]), r4(p[1] * s)]) };
  };
  function clearanceOf(fr, edits) {
    const co = fr.rc.map(o => {
      const e = edits[o.rep];
      return e ? TCv.applyMap(TCv.buildCanon(e.type, e.pts), o.code) : [[0, 0], [1, 0]];
    });
    try { return CD.separation(TCv.curvedTile(fr.V, co)).rel; } catch (e) { return -Infinity; }
  }
  // the faintest orbit's bulge, as a fraction of the diameter, capped at VCAP, scaled to 0..1
  function visibilityOf(fr, edits) {
    let worst = 1;
    for (const rep of fr.order) {
      const e = edits[rep];
      const amp = e ? Math.max.apply(null, e.pts.map(p => Math.abs(p[1]))) : 0;
      worst = Math.min(worst, Math.min(amp * fr.shortest[rep] / fr.diam, VCAP) / VCAP);
    }
    return fr.order.length ? worst : 1;
  }

  function size(ctx, A, L, opts) {
    opts = opts || {};
    const fr = frame(ctx, A, L);
    if (!fr.order.length) return { ok: true, edits: {}, clearance: null, straight: null, visibility: 1, meta: {} };
    let straight = -Infinity;
    try { straight = CD.separation(fr.V).rel; } catch (e) {}
    // A straight outline that already crosses itself has no clearance to keep a fraction of: the curves
    // have to be DESIGNED to open it, which is the designer's job, not this module's.
    if (!(straight > FLOOR)) return { ok: false, reason: 'the straight outline is not simple', straight };
    // WHAT TO KEEP HALF OF. The curved tile's clearance is not comparable to the straight outline's:
    // the moment ANY curve is present the measure drops by an order of magnitude (72991: straight
    // 4.6e-2, a 4% curve 1e-3, peaking at 8e-3 around scale 0.33, crossing at 1.0), because the curved
    // outline is sampled and its corners and collinear runs come into play. Requiring half of the
    // STRAIGHT figure made 6 of 6 test tiles infeasible. So the reference is the best the tile's own
    // motifs can reach -- every orbit on its first motif at each scale -- and the requirement is half
    // of that, never below the floor.
    let cref = -Infinity, sref = SCALES[0];
    for (const s of SCALES) {
      const ed = {};
      fr.order.forEach((rep, k) => { ed[rep] = motif(fr.type[rep], k % Math.max(1, TCv.motifCount(fr.type[rep])), s); });
      const c = clearanceOf(fr, ed);
      if (c > cref) { cref = c; sref = s; }
    }
    const need = Math.max(FLOOR, KEEP * cref);
    const nVar = rep => TCv.motifCount(fr.type[rep]);
    const meta = {};                                   // rep -> { v, s }
    const build = () => {
      const ed = {};
      for (const rep of fr.order) ed[rep] = motif(fr.type[rep], meta[rep].v, meta[rep].s);
      return ed;
    };
    const feasible = ed => clearanceOf(fr, ed) >= need;
    const objective = ed => { const c = clearanceOf(fr, ed);
      return c >= need ? visibilityOf(fr, ed) + 1e-3 * Math.min(1, c / straight) : -1; };

    const prev = opts.meta || null;
    // DISTINCT TEMPLATES. Two orbits of the same type must not share a motif, or the picture cannot show they are different
    // edges (John, 2026-10-17, #209100 m6 si2: two S orbits drawn with the same square-ish blocks). The optimiser used to
    // choose each orbit's motif on its own, so equal-looking optima collided. Same-type orbits now take different BASE
    // templates (variant % bank size, ignoring the flip) while the bank has enough; past that, at least different variants.
    const bank = rep => Math.max(1, nVar(rep) / 2);
    const sameType = rep => fr.order.filter(r => fr.type[r] === fr.type[rep]);
    const clash = (rep, v) => {
      const peers = sameType(rep).filter(r => r !== rep && meta[r]); if (!peers.length) return false;
      const strict = sameType(rep).length <= bank(rep);
      return peers.some(r => strict ? (meta[r].v % bank(rep)) === (v % bank(rep)) : meta[r].v === v);
    };
    const seen = {};
    fr.order.forEach(rep => {
      const t = fr.type[rep], ti = seen[t] = (seen[t] === undefined ? 0 : seen[t] + 1);
      // start at the scale that achieved the reference clearance: that point is feasible by construction
      meta[rep] = prev && prev[rep] ? { v: prev[rep].v, s: sref } : { v: ti % Math.max(1, nVar(rep)), s: sref };
    });
    if (!feasible(build())) {
      // even the faintest curve does not fit -- possible only when the gap is a hair above the gate
      return { ok: false, reason: 'no curve fits inside this tile\'s clearance', straight };
    }
    let cur = objective(build());
    const passes = prev ? 2 : 3;
    for (let pass = 0; pass < passes; pass++) {
      let moved = false;
      for (const rep of fr.order) {
        const keepV = meta[rep].v, keepS = meta[rep].s;
        let bestV = keepV, bestS = keepS, bestO = cur;
        const vs = prev ? [keepV] : Array.from({ length: nVar(rep) }, (_, i) => i);
        for (const v of vs) for (const s of SCALES) {
          if (v !== keepV && clash(rep, v)) continue;      // never move onto a template a sibling orbit already wears
          meta[rep] = { v, s };
          const o = objective(build());
          if (o > bestO + 1e-9) { bestO = o; bestV = v; bestS = s; }
        }
        meta[rep] = { v: bestV, s: bestS };
        if (bestO > cur + 1e-9) { cur = bestO; moved = true; }
      }
      if (!moved) break;
    }
    // FULL-EDGE SHAPES for any U or S orbit still only a pixel or two high (see the header).
    const stdN = rep => TCv.motifCount(fr.type[rep]);
    const pxOf = (rep, ed) => { const e = ed[rep]; const amp = e ? Math.max.apply(null, e.pts.map(p => Math.abs(p[1]))) : 0;
                                return amp * fr.shortest[rep] / fr.diam * THUMB_PX; };
    const faint = fr.order.filter(rep => isUS(fr.type[rep]) && pxOf(rep, build()) < FAINT_PX);
    if (faint.length) {
      const obj2 = ed => { const c = clearanceOf(fr, ed); if (c < need) return -1;
        let t = 0; for (const rep of faint) t += Math.min(pxOf(rep, ed), FULL_CAP_PX) / FULL_CAP_PX;
        return t + 1e-3 * Math.min(1, c / straight); };
      const fullBase = rep => (meta[rep].v - stdN(rep)) % 2;
      const clash2 = (rep, v) => faint.some(r => r !== rep && fr.type[r] === fr.type[rep] && meta[r].v >= stdN(r)
        && faint.filter(q => fr.type[q] === fr.type[rep]).length <= 2 && ((meta[r].v - stdN(r)) % 2) === ((v - stdN(rep)) % 2));
      let cur2 = obj2(build());
      for (let pass = 0; pass < 2; pass++) {
        let moved = false;
        for (const rep of faint) {
          const keep = meta[rep]; let best = keep, bestO = cur2;
          const vs = prev ? [keep.v] : Array.from({ length: FULLN }, (_, j) => stdN(rep) + j);
          for (const v of vs) for (const sc of SCALES.concat([1])) {
            if (!prev && clash2(rep, v)) continue;
            meta[rep] = { v, s: sc };
            const o = obj2(build());
            if (o > bestO + 1e-9) { bestO = o; best = meta[rep]; }
          }
          meta[rep] = best;
          if (bestO > cur2 + 1e-9) { cur2 = bestO; moved = true; }
        }
        if (!moved) break;
      }
    }
    const edits = build();
    const clearance = clearanceOf(fr, edits);
    return { ok: clearance >= need, edits, clearance, straight, cref, visibility: visibilityOf(fr, edits), meta };
  }
  return { size, VCAP, KEEP };
}
if (typeof module !== 'undefined' && module.exports) module.exports = makeCurveSizing;
if (typeof window !== 'undefined') window.makeCurveSizing = makeCurveSizing;
