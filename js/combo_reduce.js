// REDUCE a combo: find the fewer-sided combo that describes the SAME tile, and carry the drawn curves across.
//
//   const R = makeComboReducer({ H, TC, TD, TCv, CD });
//   R.reduce(S)  ->  { ok:false, reason }  |  { ok:true, id, m, si, or, off, A, L, curves, note, ... }
//
// S is an Explore session: { combo:{id,m,si,or,off}, cfg, m, A, L, curves }.
//
// WHAT "REDUCIBLE" MEANS HERE. specify()'s vertexAngle mask has a 0 at a position that appears in no vertex
// equation of the tiling: the m-gon is really an (m-k)-gon padded with k decorative points, and the same physical
// tile has a description with fewer sides. (A 0-degree or 180-degree angle is NOT this -- see
// reference_reducible_two_meanings.) The padding is common: every #25638 find above m=12 is one tile described
// over and over at m = 24, 36 ... 144.
//
// THE ALGORITHM is program4's reduce_combo.js, ported (2026-08-08/09, John's design), plus the curve carry:
//   1. the dropped positions are the mask's zeros;
//   2. each boundary position is covered by TWO net edges, one per orientation (the k-gon's walk and the n-gon's
//      walk over the SAME boundary). Dropping a vertex shrinks BOTH -- the missing piece in the first manual try;
//   3. the smaller m's sum-types are searched for one whose net-edge size vector matches;
//   4. the new shape is built from the ACTUAL VERTEX COORDINATES of the old one: connect the kept vertices by chords.
//      Whatever bend a dropped vertex had becomes detail on the new edge, so the new polygon is closed by
//      construction (John, 2026-08-09: "feed the old coordinates of the vertices you will use ... it should already
//      be a solution");
//   5. (orient, off) at the matched sum-type is searched for the structure the shape satisfies, preferring the one
//      whose declared edge types agree with the merge rule's derived types (Klein-code XOR: merged is U iff
//      c_i ^ c_(k-1-i) == 1 for every pair, S iff == 3, else J; an odd span's middle must be U/I resp. S/I);
//   6. NEW HERE -- the CURVES. A curve is a polyline through its stored points, so the merge is exact: a merged
//      edge's curve is the concatenation of its sub-edges' drawn polylines (dropped vertices included, as points on
//      the curve), expressed in the new chord's frame. For a U or S edge the stored half runs to the arclength
//      midpoint. The result is CHECKED: the new outline must coincide with the old one, and the report says by how
//      much it does not.
//
// ONE SELF-CONTAINED FUNCTION on purpose, like curve_sizing.js: the browser runs the engine in Web Workers built from
// a Blob, so finder_pool.js posts this function's SOURCE (makeComboReducer.toString()) into each worker; node requires it.
function makeComboReducer(deps) {
  'use strict';
  const H = deps.H, TC = deps.TC, TD = deps.TD, TCv = deps.TCv, CD = deps.CD;
  const SYM = { 0: 'J', 1: 'U', 2: 'I', 3: 'S' };
  const fail = reason => ({ ok: false, reason });

  /** how many positions are redundant, without doing any work -- the button uses this to say what it will do */
  function droppedOf(cfg, m) {
    const va = cfg && cfg.vertexAngle, out = [];
    if (!va) return out;
    for (let i = 0; i < m; i++) if (va[i] === 0) out.push(i);
    return out;
  }

  function reduce(S, opts) {
    opts = opts || {};
    const m = S.m, cfg = S.cfg, id = S.combo.id, A0 = S.A, L0 = S.L;
    if (!cfg || !cfg.ned) return fail('this combo has no net-edge data to reduce from');
    if (!(TC.gapOf(A0, L0, m) / Math.max.apply(null, L0) < 1e-6)) return fail('the tile is open -- close it first (re-close), then reduce');
    const dropped = droppedOf(cfg, m);
    if (!dropped.length) return fail('nothing to reduce: every vertex of this combo is a real corner of the tiling');
    const newM = m - dropped.length;
    if (newM < 3) return fail('reducing would leave fewer than 3 sides');

    // ---- 2. the target net-edge sizes: shrink every net edge that covers a dropped position, both orientations
    const ned = cfg.ned, origSizes = ned[4].map(Math.abs), dec = new Array(origSizes.length).fill(0);
    for (const p of dropped) for (let g = 0; g < origSizes.length; g++) {
      const size = Math.abs(ned[4][g]), begin = ned[5][g], sign = ned[4][g] < 0 ? -1 : 1;
      for (let k = 0; k < size; k++) if ((((begin + sign * k) % m) + m) % m === p) dec[g]++;
    }
    const target = origSizes.map((s, g) => s - dec[g]);
    if (target.some(s => s < 1)) return fail('a net edge would shrink below one position: this combo does not reduce that way');

    // ---- 3. the matching sum-type at the smaller m
    H.loadType(id);
    const newSums = H.runSums(newM), t0 = Date.now(), budget = opts.searchMs || 25000;
    // Net-edge SIZES are only a cheap PREFILTER now: every sum-type whose sizes match is a candidate, and the choice
    // among them (and among their (orient, off)) is made on the GEOMETRY below, as the program6 reducer did.
    const cands = [];
    for (let s = 0; s < newSums.length; s++) {
      if (Date.now() - t0 > budget) { if (cands.length) break; return fail('gave up after ' + Math.round(budget / 1000) + ' s: ' + newSums.length.toLocaleString() + ' sum-types at m=' + newM + ' is too many to search here'); }
      // whether a configuration EXISTS depends on (orient, off): 25638/12 si 5 is "impossible" at (0, 0) and fine at (0, 4)
      let c2 = null;
      for (let o = 0; o < 2 && !c2; o++) for (let f = 0; f < newM && !c2; f++) {
        let c = null; try { c = H.config(id, newM, o, f, s); } catch (e) { c = null; }
        if (c && !c.impossible && c.ned) c2 = c;
      }
      if (!c2) continue;
      const z = c2.ned[4].map(Math.abs);
      if (z.length === target.length && z.every((v, i) => v === target[i])) cands.push(s);
    }
    if (!cands.length) return fail('no sum-type at m=' + newM + ' has the reduced net-edge structure: this type cannot represent the reduction');

    // ---- 4. the new shape from the old coordinates: chords between the kept vertices
    const va = cfg.vertexAngle, kept = []; for (let i = 0; i < m; i++) if (va[i] === 1) kept.push(i);
    const K = kept.length, Vall = TC.verticesOf(A0, L0, m), Vk = kept.map(i => Vall[i]);
    if (K !== newM) return fail('internal: ' + K + ' kept vertices but the reduced size is ' + newM);
    const newL = Vk.map((p, k) => { const q = Vk[(k + 1) % K]; return Math.hypot(q[0] - p[0], q[1] - p[1]); });
    const newA = Vk.map((cur, k) => {
      const prev = Vk[(k - 1 + K) % K], next = Vk[(k + 1) % K];
      const dIn = Math.atan2(cur[1] - prev[1], cur[0] - prev[0]) * 180 / Math.PI, dOut = Math.atan2(next[1] - cur[1], next[0] - cur[0]) * 180 / Math.PI;
      return ((180 - (dOut - dIn)) % 360 + 360) % 360;
    });

    // ---- 5. the derived curve type of every merged edge, from the OLD config's Klein codes
    const repMap = i => { let cur = i, code = 0, g = 0; while (cfg.whichEdge[cur] != null && cfg.whichEdge[cur] !== cur && g++ < m) { code ^= (cfg.mapping[cur] || 0); cur = cfg.whichEdge[cur]; } return { rep: cur, code }; };
    function mergedType(start, span) {
      const info = []; for (let j = 0; j < span; j++) { const e = (start + j) % m; info.push(Object.assign({ e, type: SYM[cfg.edgeSym[e]] }, repMap(e))); }
      if (info.every(x => x.type === 'I')) return 'I';               // straight pieces in a line make one straight edge
      let isU = true, isS = true;
      for (let i = 0; i < Math.floor(span / 2); i++) {
        const a = info[i], b = info[span - 1 - i];
        if (a.rep !== b.rep) { isU = false; isS = false; continue; }
        // STABILISER RULE (ported from program7/cross_m_containment.js, 2026-10-23). A piece is the SAME curve under any code in its
        // stabiliser: an S piece is point-symmetric (codes c and c^3 draw it identically), a U piece mirror-symmetric (c and c^1),
        // an I piece fixed by all four. So the flanking pair's map x = c_a ^ c_b only has to reach 1 (for U) or 3 (for S) modulo
        // that group. This is what lets three translated copies of one S piece (x = 0) join into one S curve (#209077 m7 ->
        // #72788 m5, John, 2026-10-17). For J pieces the stabiliser is {0}, which is the old plain rule.
        const stab = { S: [0, 3], U: [0, 1], I: [0, 1, 2, 3], J: [0] }[a.type] || [0], x = a.code ^ b.code;
        if (!stab.some(g => (x ^ g) === 1)) isU = false;
        if (!stab.some(g => (x ^ g) === 3)) isS = false;
      }
      if (span % 2 === 1) { const mid = info[(span - 1) / 2]; if (!(mid.type === 'U' || mid.type === 'I')) isU = false; if (!(mid.type === 'S' || mid.type === 'I')) isS = false; }
      return isU ? 'U' : isS ? 'S' : 'J';
    }
    const merged = [];
    kept.forEach((v, k) => { const span = ((kept[(k + 1) % K] - v + m) % m) || m; if (span > 1) merged.push({ newIdx: k, span, start: v, derived: mergedType(v, span) }); });

    // ---- (orient, off) at the matched sum-type: residual against the new equations, then agreement with the derived types
    const residual = (eqs, A) => { let mx = 0; for (const eq of eqs) { let s = 0; for (let i = 0; i < A.length; i++) s += eq[i] * A[i]; mx = Math.max(mx, Math.abs(((s - eq[A.length] + 180) % 360 + 360) % 360 - 180)); } return mx; };
    const agreeOf = c2 => { let n = 0; for (const me of merged) { const dc = SYM[c2.edgeSym[me.newIdx]]; if (dc === me.derived || dc === 'I') n++; } return n; };
    // John's rule (program6, 2026-09): the target must be IRREDUCIBLE by specify()'s own test -- a combo that is itself
    // padded is a duplicate, so reducing into it has not finished the job (#600159 m10 si18 or1 off6 must land on
    // m8 si2 or1 off4, not on a padded m8 si2 or0 off6). Among irreducible targets that the chord polygon satisfies
    // (residual < 1e-6) take the best fit; ties go to agreement with the derived curve types.
    let best = null, matchSi = -1, nPadded = 0;
    for (const s2 of cands) for (const o of [0, 1]) for (let f = 0; f < newM; f++) {
      let c2 = null; try { c2 = H.config(id, newM, o, f, s2); } catch (e) { c2 = null; }
      if (!c2 || c2.impossible || !c2.eqs) continue;
      if (c2.vertexAngle && Array.prototype.some.call(c2.vertexAngle, v => v === 0)) { nPadded++; continue; }
      const r = residual(c2.eqs, newA), ag = agreeOf(c2), cand = { o, f, r, c2, ag, si: s2 };
      if (!best) { best = cand; continue; }
      const cg = r < 1e-3, bg = best.r < 1e-3;
      if (cg && bg) { if (ag > best.ag || (ag === best.ag && r < best.r)) best = cand; } else if (r < best.r) best = cand;
    }
    if (!best && nPadded) return fail('the combos at m=' + newM + ' that carry the reduced structure are themselves reducible (padded duplicates), so this is not the real reduction');
    if (best) matchSi = best.si;
    if (!best) return fail('no usable configuration at m=' + newM + ' for the matched sum-type');

    // ---- the shape: the chord polygon itself when it already satisfies the new structure, else re-solved from it
    let A = newA, L = newL, how = 'exact: the chord polygon of the old vertices', exact = true;
    if (best.r >= 1e-3) {
      exact = false;
      const groups2 = H.lenGroups(best.c2.whichEdge, newM);
      let sp = null; try { sp = TC.solveTile(best.c2.eqs, groups2, newM, { seed: { A: newA, L: newL }, edgeSym: best.c2.edgeSym, fdEps: 1e-6, lam: 1e-7, ftol: 1e-14, maxIt: 800 }); } catch (e) {}
      if (sp && sp.ok && !sp.clamped) { A = sp.A; L = sp.L; how = 're-solved from the chord polygon as a seed (the new structure moves the shape a little)'; }
      else return fail('the chord polygon does not satisfy the reduced structure (residual ' + best.r.toFixed(3) + ' deg) and re-solving from it failed: this shape is not a member of the reduced combo');
    }

    // ---- 6. THE CURVES: carry the drawn outline onto the new edges
    const c2 = best.c2, rcOld = TD.repMapping(m, cfg.whichEdge, cfg.mapping, cfg.edgeSym).rc;
    const oldEdits = S.curves || {};
    const edgeWorld = e => {                                    // the drawn polyline of ORIGINAL edge e, in world coordinates
      const ed = oldEdits[rcOld[e].rep], P0 = Vall[e], P1 = Vall[(e + 1) % m];
      if (!ed || rcOld[e].type === 'I') return [P0, P1];
      return TCv.mapToEdge(TCv.applyMap(TCv.buildCanon(ed.type, ed.pts), rcOld[e].code), P0, P1);
    };
    const newPath = [];                                        // per NEW edge: its boundary polyline in world coordinates
    for (let k = 0; k < K; k++) {
      const span = ((kept[(k + 1) % K] - kept[k] + m) % m) || m; let path = [];
      for (let j = 0; j < span; j++) { const w = edgeWorld((kept[k] + j) % m); path = path.concat(j ? w.slice(1) : w); }
      newPath.push(path);
    }
    const rcNew = TD.repMapping(newM, c2.whichEdge, c2.mapping, c2.edgeSym).rc;
    const Vnew = TC.verticesOf(A, L, newM);
    // each new edge's polyline in ITS OWN edge frame (x along the edge, y to its left, edge = 1)
    const inFrame = k => newPath[k].map(q => TCv.unmapFromEdge(exact ? Vk[k] : Vnew[k], exact ? Vk[(k + 1) % K] : Vnew[(k + 1) % newM], q));
    const arcMid = pts => {                                     // the point at half the arclength, and the vertices before it
      const seg = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); tot += d; }
      let acc = 0; const head = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        if (acc + seg[i - 1] >= tot / 2 - 1e-12) { const t = seg[i - 1] ? (tot / 2 - acc) / seg[i - 1] : 0; head.push([pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]); return head; }
        acc += seg[i - 1]; head.push(pts[i]);
      }
      return head;
    };
    const straight = pts => pts.every(p => Math.abs(p[1]) < 1e-9);
    const curves = {}, seenRep = {}; const warnings = [];
    for (let k = 0; k < newM; k++) {
      const rep = rcNew[k].rep; if (seenRep[rep] !== undefined || rcNew[k].type === 'I') { if (rcNew[k].type === 'I' && !straight(inFrame(k))) warnings.push('edge ' + k + ' is declared straight (I) by the reduced combo but its outline bends'); continue; }
      seenRep[rep] = k;
      const pts = inFrame(rep); const T = rcNew[k].type;
      let stored;
      if (T === 'J') stored = pts.map(p => [p[0], p[1]]);
      else stored = arcMid(pts).map(p => [p[0], p[1]]);          // U / S: the half up to the fold at the arclength midpoint
      if (stored.length < 2 || (T === 'J' && straight(pts))) continue;         // straight: nothing to store
      if (T === 'S') stored[stored.length - 1] = [0.5, 0];          // an S curve's centre lies ON the edge; buildCanon snaps it too
      curves[rep] = { type: T, pts: stored };
    }

    // ---- CHECK: does the new curved tile trace the OLD outline?
    const sample = (poly, n) => { const out = []; for (let i = 0; i < poly.length - 1; i++) for (let t = 0; t < n; t++) out.push([poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t / n, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t / n]); return out; };
    let newOutline = null, clrNew = null, clrOld = null, dev = null;
    try {
      const co = rcNew.map(o => { const e = curves[o.rep]; return e ? TCv.applyMap(TCv.buildCanon(e.type, e.pts), o.code) : [[0, 0], [1, 0]]; });
      const Vn2 = Vnew.slice(0, newM); const tile = TCv.curvedTile(Vn2, co); newOutline = tile; clrNew = CD.separation(tile).rel;
      const co0 = rcOld.map(o => { const e = oldEdits[o.rep]; return e ? TCv.applyMap(TCv.buildCanon(e.type, e.pts), o.code) : [[0, 0], [1, 0]]; });
      const oldTile = TCv.curvedTile(Vall.slice(0, m), co0); clrOld = CD.separation(oldTile).rel;
      if (exact) {                                              // the same boundary, so every old point must lie on the new outline
        const so = sample(oldTile.concat([oldTile[0]]), 6), nt = newOutline.concat([newOutline[0]]);
        const distTo = q => { let d = Infinity; for (let i = 0; i < nt.length - 1; i++) { const ax = nt[i][0], ay = nt[i][1], bx = nt[i + 1][0], by = nt[i + 1][1], ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1; const t = Math.max(0, Math.min(1, ((q[0] - ax) * ex + (q[1] - ay) * ey) / l2)); d = Math.min(d, Math.hypot(q[0] - ax - t * ex, q[1] - ay - t * ey)); } return d; };
        dev = 0; for (const q of so) dev = Math.max(dev, distTo(q));
        const diam = Math.max.apply(null, Vall.map(p => Math.max(Math.abs(p[0] - Vall[0][0]), Math.abs(p[1] - Vall[0][1]))));
        dev = dev / (diam || 1);
      }
    } catch (e) { warnings.push('could not measure the new outline: ' + e.message); }

    const agreeAll = !merged.length || agreeOf(c2) === merged.length;
    if (!agreeAll) warnings.push('the merge rule and the reduced combo disagree about a merged edge\'s curve type (derived ' + merged.map(me => me.derived).join('/') + ', declared ' + merged.map(me => SYM[c2.edgeSym[me.newIdx]]).join('/') + ')');
    if (exact && dev != null && dev > 1e-6) warnings.push('the new outline differs from the old by ' + dev.toExponential(1) + ' of the tile size');
    return { ok: true, id, m: newM, fromM: m, si: matchSi, or: best.o, off: best.f, A, L, curves,
      dropped, merged: merged.map(me => ({ edge: me.newIdx, span: me.span, derived: me.derived, declared: SYM[c2.edgeSym[me.newIdx]] })),
      exact, how, residual: best.r, outlineDeviation: dev, clearanceOld: clrOld, clearanceNew: clrNew, warnings,
      note: 'reduced from m=' + m + ' to m=' + newM + ' (' + dropped.length + ' redundant vertice' + (dropped.length === 1 ? '' : 's') + ' removed): ' + how };
  }
  return { reduce, droppedOf };
}
if (typeof module !== 'undefined' && module.exports) module.exports = makeComboReducer;
if (typeof window !== 'undefined') window.makeComboReducer = makeComboReducer;
