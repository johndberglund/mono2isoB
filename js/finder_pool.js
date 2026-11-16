// Run the tile finder in the browser: a pool of Web Workers, each running the bundled finder version.
//
//   await FinderPool.ready()                       loads data/finder_bundle.js and starts the workers
//   const r = await FinderPool.find({id,m,si,or,off}, {curveBudgetMs: 60000})
//        -> { version, combo, verdict, details, timing }     (same shape as program7/finder/find.js)
//
// One worker per job at a time, and never two jobs in one worker: the engine keeps its state in globals
// (specify() mutates netEdgeData, ...), so it is not reentrant. Parallelism is separate workers.
// The workers are built from a Blob, because Chrome refuses a Worker from a file:// URL; the finder's
// own source is posted in as data, not loaded from disk.
'use strict';
window.FinderPool = (function () {
  const BOOT = String.raw`
    self.global = self;
    self.process = { cpuUsage: () => ({ user: Math.round(performance.now() * 1000), system: 0 }), argv: [], env: {} };
    let FIND = null, CLASSIFY = null, INFO = null;
    function boot(bundle) {
      const files = bundle.files, cache = {};
      const norm = p => { const o = []; for (const s of String(p).split('/')) { if (!s || s === '.') continue; if (s === '..') o.pop(); else o.push(s); } return o.join('/'); };
      const dirOf = k => k.split('/').slice(0, -1).join('/');
      const pathShim = { join: (...a) => norm(a.join('/')), resolve: (...a) => '/' + norm(a.join('/')), dirname: p => '/' + dirOf(norm(p)) };
      const fsShim = {
        readFileSync: p => { const k = norm(p); if (!(k in files)) throw new Error('ENOENT: not in the finder bundle: ' + k); return files[k]; },
        existsSync: p => norm(p) in files,
      };
      function makeRequire(dir) {
        return function (req) {
          if (req === 'fs') return fsShim;
          if (req === 'path') return pathShim;
          const k = norm(req.charAt(0) === '.' ? dir + '/' + req : req);
          return load(/\.js$/.test(k) ? k : k + '.js');
        };
      }
      function load(k) {
        if (cache[k]) return cache[k].exports;
        const src = files[k];
        if (src == null) throw new Error('module not in the finder bundle: ' + k);
        const m = { exports: {} }; cache[k] = m;
        const dir = dirOf(k);
        new Function('module', 'exports', 'require', '__dirname', '__filename', src)(m, m.exports, makeRequire(dir), '/' + dir, '/' + k);
        return m.exports;
      }
      const F = load('find.js');
      FIND = F.find; CLASSIFY = F.classify; INFO = { version: F.VERSION, hash: bundle.hash };
      const RT = load('lib/dd_route.js'); H = RT.H; TC = RT.TC; RTE = RT;   // the finder's OWN harness and solver
      JD = load('judge.js');
      TD = load('lib/tile_designer.js'); TCv = load('lib/tiler_curves.js');
      TSym = load('lib/tile_symmetry.js'); AAlg = load('lib/angle_algebra.js');
    }
    let H = null, TC = null, JD = null, TD = null, TCv = null, RTE = null, TSym = null, AAlg = null;
    let CSZ = null;      // the curve sizer, built from SOURCE the page posts in (see js/curve_sizing.js)
    let RED = null;      // the combo reducer, likewise (see js/combo_reduce.js)
    // Which m this type has sum-types for, and how many each has. runSums is cheap; config is not.
    function sizes(id, mMax) {
      H.loadType(id);
      const out = [];
      for (let m = 3; m <= mMax; m++) { let n = 0; try { n = H.runSums(m).length; } catch (e) { n = 0; } if (n) out.push([m, n]); }
      return out;
    }
    // Status of every (si, or, off) at one size, RECOMPUTED (never read from a store):
    //   0 live  1 reducible  2 impossible: the vertex-angle equations have no non-zero solution
    //   3 no configuration data
    // Posted a row (one si) at a time so a big m fills in instead of freezing.
    // ONE PAGE of sum-types, not all of them. config() is called per CELL, so a full grid at
    // #1727337 m = 19 is 45,696 sum-types x 2 x 19 = 1,736,448 calls -- minutes of work for a table
    // nobody can read. A page costs what it shows.
    function grid(jobId, id, m, from, count) {
      H.loadType(id);
      const sums = H.runSums(m);
      const lo = Math.max(0, from || 0);
      const hi = count ? Math.min(sums.length, lo + count) : sums.length;
      postMessage({ type: 'progress', id: jobId, total: sums.length, page: true, from: lo, to: hi });
      for (let si = lo; si < hi; si++) {
        const row = [];
        for (const or of [0, 1]) for (let off = 0; off < m; off++) {
          let cfg = null;
          try { cfg = H.config(id, m, or, off, si); } catch (e) {}
          row.push(!cfg || cfg.impossible || !cfg.whichEdge || !cfg.eqs
            ? (cfg && cfg.why === 'noangles' ? 2 : 3)
            : (cfg.vertexAngle && cfg.vertexAngle.some(function (v) { return v === 0; }) ? 1 : 0));
        }
        postMessage({ type: 'progress', id: jobId, si: si, label: String(sums[si]), row: row, total: sums.length });
      }
      return { m: m, sums: sums.length, from: lo, to: hi };
    }
    // ---- FIND A COMBO BY ITS PER-ORBIT SIDE SIZES (Copy tiling) ----------------------------------------
    // Reads what you can count off a picture: how many m-gon sides each net edge spans, per orbit.
    // Mirrors program7/side_sizes.js exactly; that file is the readable copy and carries the full
    // reasoning, and regress_side_sizes.js checks the two against each other.
    //
    // ALWAYS ANCHORED (John, 2026-10-07: "For copy tiling, I'd like to always use the anchor option").
    // Both lists are read from the SAME m-gon vertex, the same way round its numbering.
    //
    // Sizes are read from the ENGINE GLOBALS after runSpecify, not from H.config(): config returns early
    // with no ned whenever a configuration is unrealizable, and the probe depends on exactly those -- at
    // m = 34 nearly every off = 0 is unrealizable yet row 4 is filled in regardless.
    function sizeVariants(a) {
      const rot = x => x.map((_, i) => x.slice(i).concat(x.slice(0, i)));
      return new Set(rot(a).concat(rot(a.slice().reverse())).map(x => x.join(',')));
    }
    function netCorners(ned, m, lo, hi) {
      const s = new Set();
      for (let j = lo; j < hi; j++) s.add(((ned[5][j] + ned[6][j]) % m + m) % m);
      return s;
    }
    function sizesFrom(C, v, d, m) {
      const L = []; let p = v;
      do { let q = p, n = 0;
           do { q = ((q + d) % m + m) % m; n++; } while (!C.has(q));
           L.push(n); p = q;
      } while (p !== v && L.length <= m);
      return L;
    }
    // The tile's own symmetry, as relabellings of the m-gon: the ROSETTE groups, C_n for rotations and
    // D_n once reflections are in (John, 2026-10-07). Read from the D-symbol, never from the drawn shape:
    // a shape can have a symmetry the TILING does not.
    // groupsFor gives a stabilizer PER ORBIT and each acts WITHIN its orbit, so the group that may move
    // ORBIT 2's start is orbit 2's own -- #69294 m36's orbit-0 reflection f8 only permutes orbit 1's
    // corners. Orbit 1 needs no group: every corner of it is already tried as a start.
    function tileSyms(cfg, m) {
      const ident = [{ kind: 'rot', t: 0 }];
      try {
        const ned = cfg.ned;
        const tbl = TC.sideTables(cfg.k, cfg.n, ned[5].slice(), ned[4].map(Math.abs), ned[2], ned[3], ned[6], m);
        const actx = AAlg.makeContext(cfg.eqs, m, tbl);
        if (actx.sys && actx.sys.inconsistent) return ident;
        const g = TSym.groupsFor(actx, { ned: ned, k: cfg.k, n: cfg.n, whichEdge: cfg.whichEdge, edgeSym: cfg.edgeSym }, m);
        const arr = (g.groups || [])[1] || [];
        const out = [], seen = {};
        for (const sg of arr) { const key = TSym.key(sg); if (!seen[key]) { seen[key] = 1; out.push(sg); } }
        if (!out.some(function (x) { return x.kind === 'rot' && x.t === 0; })) out.unshift({ kind: 'rot', t: 0 });
        return out;
      } catch (e) { return ident; }                 // identity only: never widen on an error
    }
    // Orbit 2 may start at sigma(v) for each tile symmetry sigma, and a reflection reverses the way
    // round the numbering so orbit 2 is walked with -d under one.
    function anchoredStart(ned, k, n, listA, listB, m, syms) {
      const CA = netCorners(ned, m, 0, k), CB = netCorners(ned, m, k, k + n);
      const a = listA.join(','), b = listB.join(',');
      const G = (syms && syms.length) ? syms : [{ kind: 'rot', t: 0 }];
      for (const v of CA) {
        for (const d of [1, -1]) {
          if (sizesFrom(CA, v, d, m).join(',') !== a) continue;
          for (const sg of G) {
            const v2 = TSym.vertexOf(sg, v, m);
            if (!CB.has(v2)) continue;
            const d2 = sg.kind === 'refl' ? -d : d;
            if (sizesFrom(CB, v2, d2, m).join(',') === b) return { v: v, d: d, sym: TSym.key(sg) };
          }
        }
      }
      return null;
    }
    function findOneOrder(jobId, id, listA, listB, m) {
      const AV = sizeVariants(listA), BV = sizeVariants(listB);
      let sums = []; try { sums = H.runSums(m); } catch (e) { return { err: 'no sum-types at ' + m + ' sides' }; }
      if (!sums.length) return { err: '#' + id + ' has no sum-types at ' + m + ' sides at all' };
      const hits = []; let probed = 0, scanned = 0, freeOnly = 0;
      for (let si = 0; si < sums.length; si++) {
        for (const or of [0, 1]) {
          const probe = H.runSpecify(sums[si], or, 0); probed++;
          if (/engine error/.test(probe)) continue;
          const ned = self.netEdgeData;
          if (!ned || !ned[4]) continue;
          const sz = ned[4].map(Math.abs);
          const k = self.firstPolygonSize, n = self.secondPolygonSize;
          if (sz.length !== k + n) continue;
          if (!(AV.has(sz.slice(0, k).join(',')) && BV.has(sz.slice(k).join(',')))) continue;
          for (let off = 0; off < m; off++) {
            const txt = H.runSpecify(sums[si], or, off); probed++;
            if (!/tileAngles/.test(txt) || /no angles/.test(txt)) continue;
            scanned++;
            // the symmetry needs eqs, which the globals do not carry; config() has them and is
            // realizable here (tileAngles is present), so the cost falls only on real candidates
            let syms = null;
            try { const c2 = H.config(id, m, or, off, si); if (c2 && c2.ned) syms = tileSyms(c2, m); } catch (e) {}
            const at = anchoredStart(self.netEdgeData, k, n, listA, listB, m, syms);
            if (!at) { freeOnly++; continue; }     // matches each orbit, but not from one common corner
            hits.push({ id: id, m: m, si: si, or: or, off: off, sizes: sz, anchorAt: at,
                        kind: /self intersection/.test(txt) ? 'self-intersecting'
                            : /reducible/.test(txt) ? 'reducible' : 'ok' });
          }
        }
        if (si % 25 === 0 || si === sums.length - 1)
          postMessage({ type: 'progress', id: jobId, si: si + 1, total: sums.length, found: hits.length });
      }
      return { m: m, hits: hits, probed: probed, scanned: scanned, nsum: sums.length, freeOnly: freeOnly };
    }
    function findSizes(jobId, id, listA, listB) {
      const mA = listA.reduce((x, y) => x + y, 0), mB = listB.reduce((x, y) => x + y, 0);
      if (mA !== mB) return { err: 'the two orbits must span the same number of sides — got ' + mA + ' and ' + mB };
      const T = H.loadType(id);                       // k and n are properties of the TYPE
      const k = T.k, n = T.n;
      const orders = [];
      if (listA.length === k && listB.length === n) orders.push([listA, listB]);
      if (listB.length === k && listA.length === n) orders.push([listB, listA]);
      if (orders.length === 2 && JSON.stringify(listA) === JSON.stringify(listB)) orders.pop();
      if (!orders.length) return { err: 'type #' + id + ' needs ' + k + ' and ' + n
        + ' sides per orbit — got ' + listA.length + ' and ' + listB.length + ' (tried both orders)' };
      if (orders.length === 1) return findOneOrder(jobId, id, orders[0][0], orders[0][1], mA);
      const seen = {}, all = []; let probed = 0, scanned = 0, free = 0, base = null;
      for (const o of orders) {
        const r = findOneOrder(jobId, id, o[0], o[1], mA);
        if (r.err) return r;
        base = base || r; probed += r.probed; scanned += r.scanned; free += r.freeOnly || 0;
        for (const h of r.hits) { const key = h.si + '|' + h.or + '|' + h.off;
          if (!seen[key]) { seen[key] = 1; all.push(h); } }
      }
      all.sort((a, b) => a.si - b.si || a.or - b.or || a.off - b.off);
      return { m: base.m, hits: all, probed: probed, scanned: scanned, nsum: base.nsum,
               freeOnly: free, bothOrders: true };
    }

    // ---- EXPLORE SESSION: one combo held open so sliders can move it ------------------------------------
    // Two ways to move a shape, as in the old app:
    //   TRUE parameters  walk the closing family; every move RE-CLOSES the tile (closeHeld), so it always closes
    //   RAW   edit a free angle or an edge length directly and LEAVE THE GAP -- the tile is allowed to be open
    let S = null;
    const shortest = L => Math.min.apply(null, L);
    // DEFAULT TO SHOWING CURVES. John, 2026-10-15: "in explore mode, I want to default to showing curves."
    // A tile with no curves of its own gets a generated set, sized so the drawn outline never touches
    // itself (js/curve_sizing.js -- the same module that made the stored ones). While those curves are
    // GENERATED they follow the shape: every move re-sizes them, with the motifs kept and only the scales
    // refit, so a slider never leaves a curve crossing the outline. The moment the user edits a curve,
    // or loads their own, they are theirs and are never touched; "straight edges" turns this off for the
    // session. A tile whose STRAIGHT outline already crosses itself cannot be sized -- its curves have to
    // be designed to open it -- so it gets one short designer pass when opened and is left alone after.
    function autoFit(initial) {
      if (!CSZ || !S || S.noAuto) return;
      const have = !!(S.curves && Object.keys(S.curves).length);
      if (have && !S.autoCurves) return;                          // somebody's own curves
      const gap = TC.gapOf(S.A, S.L, S.m) / Math.max.apply(null, S.L);
      if (!(gap < 1e-6)) return;                                  // an open tile: nothing to size against
      const r4 = function (x) { return Math.round(x * 1e4) / 1e4; };
      const key = S.A.map(r4).join(',') + '|' + S.L.map(r4).join(',');
      if (!initial && S.fitKey === key) return;
      S.fitKey = key;
      const ctx = RTE.curveCtx(S.cfg, S.m);
      let r = null;
      try {
        r = CSZ.size(ctx, S.A, S.L, (!initial && S.autoMeta) ? { meta: S.autoMeta } : {});
        if ((!r || !r.ok) && !initial) r = CSZ.size(ctx, S.A, S.L, {});
      } catch (e) { r = null; }
      if (r && r.ok) { S.curves = Object.keys(r.edits).length ? clean(r.edits) : null; S.autoMeta = r.meta; S.autoCurves = true; return; }
      // The straight outline does not stay simple here, so curves have to be DESIGNED to open it. A short
      // pass: 3 s when a tile is opened, 0.7 s mid-drag (the client coalesces moves, so a slow stretch
      // only makes the slider less smooth, never queues up). If nothing is found the curves are DROPPED,
      // not kept: the previous member's curves on this member are wrong, and the clearance readout then
      // says honestly that the outline touches itself. Measured on 209209: keeping them left three
      // positions of a slider with the drawn outline crossing itself (clearance -5e-3 to -3e-2).
      let dg = null; try { dg = TD.diagnose({}, ctx, S.A, S.L); } catch (e) { S.curves = null; return; }
      let dc = null;
      if (dg && dg.verdict === 'curves required') {
        try { dc = TD.designCurves({}, ctx, S.A, S.L, {}, dg, { starts: initial ? 12 : 6, deadline: Date.now() + (initial ? 3000 : 700) }); } catch (e) {}
      }
      if (dc && dc.clearance > RTE.CURVE_CLEAR_MIN && dc.curveEdits && Object.keys(dc.curveEdits).length) {
        S.curves = clean(dc.curveEdits); S.autoMeta = null; S.autoCurves = true;
      } else if (!initial) { S.curves = null; S.autoMeta = null; }   // stay in auto mode: the next move tries again
    }
    function payload(note) {
      if (S && S.autoCurves) autoFit(false);
      const V = TC.verticesOf(S.A, S.L, S.m);                       // m+1 points; the last is where the walk ENDS
      const gap = Math.hypot(V[S.m][0] - V[0][0], V[S.m][1] - V[0][1]) / shortest(S.L);
      const st = TC.angleStructure(S.cfg.eqs, S.m);
      // One curve per edge ORBIT. rc[i] says which orbit representative edge i follows and under which Klein
      // code, which is what makes matching edges carry the same curve -- see render.js.
      const rcAll = TD.repMapping(S.m, S.cfg.whichEdge, S.cfg.mapping, S.cfg.edgeSym).rc;
      const orbits = [];
      for (let i = 0; i < S.m; i++) { const o = rcAll[i];
        if (!orbits.some(function (x) { return x.rep === o.rep; }))
          orbits.push({ rep: o.rep, type: o.type, edges: [] }); }
      for (let i = 0; i < S.m; i++) { const o = rcAll[i];
        for (const x of orbits) if (x.rep === o.rep) x.edges.push(i); }
      let diag = null;
      try { const d = TD.diagnose({}, RTE.curveCtx(S.cfg, S.m), S.A, S.L);
        diag = { verdict: d.verdict, reason: d.reason || null,
                 problems: (d.problems || []).map(function (x) { return { kind: x.kind, vertex: x.vertex, edges: x.edges }; }) }; } catch (e) {}
      return { ok: true, V: V, A: S.A.slice(), L: S.L.slice(), gap: gap, note: note || null,
        rc: rcAll.map(function (o) { return { rep: o.rep, code: o.code, type: o.type }; }), orbits: orbits, diag: diag,
        curves: S.curves || null, curvesAuto: !!S.autoCurves,
        // redundant vertices: positions of specify()'s vertexAngle mask that are 0 (the tile is padded). The Reduce button
        // reads this; it is a count, nothing is computed beyond reading the mask.
        reducible: (function () { let n = 0; const va = S.cfg && S.cfg.vertexAngle; if (va) for (let i = 0; i < S.m; i++) if (va[i] === 0) n++; return n; })(),
        es: Array.from(S.cfg.edgeSym || []), we: Array.from(S.cfg.whichEdge || []), mp: Array.from(S.cfg.mapping || []),
        family: { dim: S.fam.dim, rank: S.fam.rank, nU: S.fam.nU, relations: (S.fam.relations || []).map(shownRel) },
        // angles as the INSIDE angle (see shownA); on a clockwise walk the range turns over, so lo and hi swap
        drivers: S.drivers.map(function (d) { return d.kind === 'A' && S.cw
          ? { txt: d.txt, kind: d.kind, lo: 360 - d.hi, hi: 360 - d.lo, val: 360 - d.val }
          : { txt: d.txt, kind: d.kind, lo: d.lo, hi: d.hi, val: d.val }; }),
        cw: !!S.cw,
        raw: { free: st.free.map(function (i) { return { i: i, val: shownA(S.A[i]) }; }),
               groups: S.groups.map(function (g) { return { edges: g, val: S.L[g[0]] }; }) } };
    }
    function driversAt(u, A, L) {
      const pd = TC.pickDrivers(S.cfg.eqs, S.groups, S.m, u);
      // at a special member of the family the closure rank drops and pickDrivers counts one too many; then use
      // the family's own drivers (picked at a regular member) with this shape's values
      const src = (pd.drivers.length === S.fam.dim) ? pd.drivers : S.fam.drivers;
      return src.map(function (d) {
        const rr = d.kind === 'A' ? S.fam.angleRanges[d.idx] : S.fam.lengthRanges[d.idx];
        return widen(Object.assign({}, d, { lo: Math.min(rr.lo, u[d.u]), hi: Math.max(rr.hi, u[d.u]), val: u[d.u] }));
      });
    }
    // SLIDER RANGES ARE NOT LIMITS (John, 2026-10-24, #209100 m5 si0 or0 off0: "I don't know that we need these limits. It
    // looks like the shape could continue past these limits."). shapeFamily's ranges are only the spread of the members it happened
    // to sample, so a slider stopped where the samples did. An angle may now go anywhere in (0, 360) and a length ratio four times
    // past what was sampled; a move with no closing tile is refused by moveTrue as before ("the family folds back").
    function widen(d) {
      if (d.kind === 'A') return Object.assign(d, { lo: 0.5, hi: 359.5 });
      return Object.assign(d, { lo: Math.min(d.lo, d.val) / 4, hi: Math.max(d.hi, d.val) * 4 });
    }
    // ANGLES AS SEEN (John, 2026-10-24, same combo: "it says that vertex 4 is between 270 and 300 degrees. It looks like you are
    // naming it inside out."). The finder's corner angle A is the inside angle only when the combo walks the tile counter-clockwise;
    // walked clockwise it is 360 minus the inside angle. A session remembers which way its tile is walked (S.cw, set when the
    // family starts) and every angle it shows -- sliders, raw angles, forced relations -- is the inside angle; values coming back
    // from the page are turned back the same way.
    const cwOf = function (A, L) { const V = TC.verticesOf(A, L, S.m); let a = 0;
      for (let i = 0; i < S.m; i++) { const p = V[i], q = V[(i + 1) % S.m]; a += p[0] * q[1] - q[0] * p[1]; } return a < 0; };
    const shownA = function (a) { return S.cw ? 360 - a : a; };
    // A forced relation's VALUE is re-read from the shape on screen: the sampled members it was found on may be walked either way
    // round, so its number cannot just be flipped; every member satisfies it, the current one included.
    const inside = function (i) { const v = shownA(S.A[i]); return ((v % 360) + 360) % 360; };
    const shownRel = function (s) {
      return s.replace(/^A(\d+) = (-?[\d.]+)°$/, function (_, a) { return 'A' + a + ' = ' + inside(+a).toFixed(1) + '°'; })
              .replace(/^A(\d+) \+ A(\d+) = (-?[\d.]+)°$/, function (_, a, b) { return 'A' + a + ' + A' + b + ' = ' + (inside(+a) + inside(+b)).toFixed(1) + '°'; });
    };
    function startFamily(note) {
      const F = TC.familyFns(S.cfg.eqs, S.groups, S.m), A = S.A, L = S.L;
      const gapNow = TC.gapOf(A, L, S.m) / Math.max.apply(null, L);
      S.F = F; S.drivers = []; S.mode = 'true';
      if (!(S.fam.dim > 0)) { S.u = F.toU(A, L); S.u0 = S.u.slice(); S.A0 = A.slice(); S.L0 = L.slice(); S.cw = cwOf(A, L); return note; }
      if (gapNow < 0.02) {                                           // start AT the shape on screen
        const u = F.toU(A, L);
        S.drivers = driversAt(u, A, L);
        const held = S.drivers.map(function (d) { return d.u; });
        const r = TC.closeHeld(S.cfg.eqs, S.groups, S.m, A, L, u, u, held);   // refine a nearly-closed shape
        let moved = 0;
        if (r.ok) {                                                  // a refinement must not jump to another tiling
          const V0 = TC.verticesOf(A, L, S.m), V1 = TC.verticesOf(r.A, r.L, S.m); let diam = 0;
          for (let i = 0; i < S.m; i++) for (let j = i + 1; j < S.m; j++) diam = Math.max(diam, Math.hypot(V0[i][0] - V0[j][0], V0[i][1] - V0[j][1]));
          for (let i = 0; i < S.m; i++) moved = Math.max(moved, Math.hypot(V1[i][0] - V0[i][0], V1[i][1] - V0[i][1]));
          if (diam > 0 && moved / diam <= 0.02) { S.A = r.A.slice(); S.L = r.L.slice(); }
          else note = 're-closing would have jumped to a different tiling, so the shape was kept as it was';
        }
        S.A0 = S.A.slice(); S.L0 = S.L.slice(); S.u0 = F.toU(S.A, S.L); S.u = S.u0.slice();
        S.drivers = driversAt(S.u0, S.A, S.L);
      } else {                                                       // too far open: start from the family's own closed member
        const U = F.unpack(S.fam.baseU.slice());
        S.A = U.A.slice(); S.L = U.L.slice(); S.A0 = S.A.slice(); S.L0 = S.L.slice();
        S.u0 = S.fam.baseU.slice(); S.u = S.u0.slice();
        S.drivers = S.fam.drivers.map(function (d) { return widen(Object.assign({}, d)); });
        note = 'the raw shape was too far from closed, so this is the closing family\'s own member instead';
      }
      S.cw = cwOf(S.A, S.L);
      return note;
    }
    function openSession(combo) {
      H.loadType(combo.id); H.runSums(combo.m);
      const cfg = H.config(combo.id, combo.m, combo.or, combo.off, combo.si);
      if (!cfg || cfg.impossible || !cfg.whichEdge || !cfg.eqs)
        return { ok: false, reason: cfg && cfg.why === 'noangles' ? 'the vertex-angle equations have no non-zero solution: proven impossible'
                                                               : 'this combo has no configuration' };
      const m = combo.m, groups = H.lenGroups(cfg.whichEdge, m);
      let sh = null, note = null;
      const fm = JD.findMembers(cfg, m, 1, 4, {});
      if (fm.list.length) sh = { A: fm.list[0].A.slice(), L: fm.list[0].L.slice() };
      else { const t = TC.solveTile(cfg.eqs, groups, m, { edgeSym: cfg.edgeSym });
             if (t && t.A) { sh = { A: t.A.slice(), L: t.L.slice() }; note = 'no closing tile was found; this is the nearest the solver got'; } }
      if (!sh) return { ok: false, reason: 'the solver found no shape for this combo' };
      S = { combo: combo, cfg: cfg, m: m, groups: groups, A: sh.A, L: sh.L, curves: null };
      S.fam = TC.shapeFamily(cfg.eqs, groups, m, { seed: { A: sh.A, L: sh.L } });
      note = startFamily(note);
      autoFit(true);
      return payload(note);
    }
    function moveTrue(d) {
      const dr = S.drivers[d.di];
      if (!dr) return Object.assign(payload(), { ok: false });
      const value = dr.kind === 'A' ? shownA(d.value) : d.value;    // the page sends the inside angle
      const u = S.u.slice(); u[dr.u] = value;
      const held = S.drivers.map(function (x) { return x.u; });
      const r = TC.closeHeld(S.cfg.eqs, S.groups, S.m, S.A0, S.L0, S.u0, u, held);
      if (!r.ok) return Object.assign(payload('no closing tile there -- the family folds back; the slider stays where it was'), { ok: false });
      S.u = r.u.slice(); S.A = r.A.slice(); S.L = r.L.slice(); dr.val = value;
      return payload();
    }
    function moveRaw(d) {
      S.mode = 'raw';
      const st = TC.angleStructure(S.cfg.eqs, S.m);
      if (d.kind === 'A') {
        const A = new Array(S.m).fill(0);
        st.free.forEach(function (c) { A[c] = c === d.i ? shownA(d.value) : S.A[c]; });   // the page sends the inside angle
        for (const c in st.dep) { let v = st.dep[c].rhs; for (const f in st.dep[c].co) v -= st.dep[c].co[f] * A[f]; A[+c] = v; }
        S.A = A;
      } else {
        S.groups[d.gi].forEach(function (i) { S.L[i] = d.value; });
      }
      return payload();
    }
    // RE-CLOSE FROM HERE. John, 2026-10-13: "can we add a reclose button? That would start from the
    // current location that the raw sliders have got us to and explore the space around that to find
    // the nearest closure."
    //
    // The raw sliders deliberately do not re-close -- that is what makes them raw -- so a session can
    // sit off the closing manifold. closeConstrained with NO drivers held is exactly the nearest-
    // closure walk: damped Gauss-Newton on the closure residual over every unknown, started at where
    // you are, so it falls to the closure nearest the current shape rather than re-solving the combo.
    //
    // It comes back with group 0 normalised to length 1, so the tile would jump in size; rescaling by
    // the group-0 length the user had keeps the picture where they left it, and scale is a gauge here
    // anyway -- the closure condition is scale invariant.
    function reclose() {
      const st = TC.angleStructure(S.cfg.eqs, S.m);
      const nU = st.free.length + (S.groups.length - 1);
      if (!nU) return Object.assign(payload('this combo is rigid -- there is nothing to re-close'), { ok: false });
      const base = S.L[S.groups[0][0]];
      const u0 = st.free.map(function (c) { return S.A[c]; })
        .concat(S.groups.slice(1).map(function (g) { return S.L[g[0]] / base; }));
      const gapBefore = TC.gapOf(S.A, S.L, S.m) / Math.max.apply(null, S.L);
      let out = null;
      try { out = TC.closeConstrained(S.cfg.eqs, S.groups, S.m, u0, []); } catch (e) {}
      if (!out || !out.A) return Object.assign(payload('could not re-close from here'), { ok: false });
      const scale = base / out.L[S.groups[0][0]];
      const L2 = out.L.map(function (x) { return x * scale; });
      const gap = TC.gapOf(out.A, L2, S.m) / Math.max.apply(null, L2);
      if (!(gap < 1e-9)) {
        return Object.assign(payload('no closure found near this shape (closest gap '
          + gap.toExponential(2) + ' of the longest edge)'), { ok: false });
      }
      let dA = 0, dL = 0;
      for (let i = 0; i < S.m; i++) {
        dA = Math.max(dA, Math.abs(out.A[i] - S.A[i]));
        dL = Math.max(dL, Math.abs(L2[i] - S.L[i]) / Math.max(1e-9, Math.abs(S.L[i])));
      }
      S.A = out.A; S.L = L2;
      const moved = (dA < 5e-4 && dL < 5e-4)
        ? 'already closed -- nothing moved'
        : 'moved to the nearest closure: angles by up to ' + dA.toFixed(3) + ' deg, lengths by up to '
          + (100 * dL).toFixed(2) + '%';
      return Object.assign(payload('re-closed (gap was ' + gapBefore.toExponential(2) + '); ' + moved), { ok: true });
    }
    function toTrue() { const note = startFamily(null); return payload(note); }
    // ---- saved combos ------------------------------------------------------------------------------------
    // SAVE ROUNDED, RECLOSE ON LOAD (John's rule). A file keeps angles to 4 decimals and lengths to 6, which is
    // readable but no longer closes exactly; recloseSaved walks back to exact closure, moving each number within
    // its own saved precision. If it cannot get there without moving the shape further than the rounding can
    // account for, the file is used AS SAVED and the result says so -- it never silently substitutes a
    // different tile for the one in the file.
    function shapeForSave() {
      const r = TC.roundShape(S.A, S.L);
      return { A: r.A, L: r.L };
    }
    // the sum-type index a saved file's angle-sum row corresponds to (old files store the row, not the index)
    function siForSum(id, m, sum) {
      H.loadType(id); const sums = H.runSums(m);
      const want = String(sum).replace(/[\[\]\s]/g, '');
      for (let i = 0; i < sums.length; i++) if (String(sums[i]).replace(/\s/g, '') === want) return i;
      return -1;
    }
    // The relabelling that puts a saved shape into THIS config's own vertex numbering, or null.
    //
    // John, 2026-10-13: "Is the vertex numbering off?" It was. export_aniso_shapes.js reverses an
    // uncurved shape so it draws counter-clockwise, reversing es/we/mp with it, so the RECORD is
    // self-consistent -- but its A/L are then not in the config's numbering. 827 of 3,926 stored
    // shapes are reflected that way. Anything that pairs such a shape with cfg.eqs / lenGroups is
    // wrong, which is why the raw sliders did not match the drawing and the first drag lost closure.
    //
    // Corners and edges relabel together, and the edge map differs by one step when the walk is
    // reversed. Judged on the RAW INTEGER angle equations and the length groups, at the tolerance the
    // saved precision allows (angles 4 decimals, lengths 6).
    function alignToConfig(cfg, groups, m, A, L) {
      const go = new Array(m).fill(-1);
      groups.forEach(function (g, k) { g.forEach(function (e) { go[e] = k; }); });
      // A row may be off by a WHOLE MULTIPLE OF 360 and still be satisfied: the equations hold
      // exactly for TRUE angles, while a saved angle can be the mod-360 reduced one, and every row
      // has integer coefficients, so the difference is always k*360. recloseSaved lifts the angles
      // for this same reason. Demanding an exact zero here called 185 perfectly good shapes
      // "unalignable" (John, 2026-10-13: "I loaded several of them and they look good to me").
      // Score every relabelling and keep the BEST, never the first that squeaks under tolerance.
      // A shape can sit just inside the tolerance on the WRONG relabelling while fitting another one
      // exactly -- 209220/6/3/0/1 passes the identity at 8e-3 of a degree and its true reflection at
      // ~1e-13 -- and taking the first match then binds every control to the wrong entry, which is the
      // whole bug this function exists to prevent.
      function residual(Aa, Ll) {
        let w = 0;
        for (let q = 0; q < cfg.eqs.length; q++) {
          const row = cfg.eqs[q];
          let acc = 0;
          for (let i = 0; i < m; i++) acc += row[i] * Aa[i];
          const diff = acc - row[m];
          w = Math.max(w, Math.abs(diff - 360 * Math.round(diff / 360)));
        }
        for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++)
          if (go[i] === go[j]) {
            const rel = Math.abs(Ll[i] - Ll[j]) / Math.max(1e-9, Math.abs(Ll[i]));
            w = Math.max(w, rel * 10);              // put a relative length error on the degree scale
          }
        return w;
      }
      let best = null;
      for (let r = 0; r < m; r++) for (const dir of [1, -1]) {
        const c = [], e = [];
        for (let j = 0; j < m; j++) {
          const ci = ((r + dir * j) % m + m) % m;
          c.push(ci);
          e.push(dir > 0 ? ci : ((ci - 1) % m + m) % m);
        }
        const Aa = c.map(function (i) { return A[i]; });
        const Ll = e.map(function (i) { return L[i]; });
        const w = residual(Aa, Ll);
        if (w > 2e-2) continue;
        if (!best || w < best.w) best = { w: w, identity: (dir > 0 && r === 0), A: Aa, L: Ll,
                                          how: (dir > 0 ? 'rotation by ' + r : 'reflection at ' + r) };
      }
      return best;
    }
    function openSaved(f) {
      const id = f.id, m = f.m;
      let si = (f.si != null) ? f.si : siForSum(id, m, f.sum);
      if (si < 0) return { ok: false, reason: 'this file\'s angle sums ' + f.sum + ' are not a sum-type of #' + id + ' at m=' + m };
      const or = (f.or != null) ? f.or : f.orient, off = f.off;
      const r = openSession({ id: id, m: m, si: si, or: or, off: off });
      if (!r.ok) return r;
      const man = f.manual || {};
      if (!man.A || !man.L || man.A.length !== m) return Object.assign(r, { note: 'the file has no shape for this combo, so the solver\'s own was used', si: si, or: or, off: off });
      let A = man.A.slice(), L = man.L.slice(), note = null;
      // Align BEFORE re-closing: recloseSaved solves against S.cfg.eqs and S.groups, and the raw
      // sliders startFamily() builds below come from the same place, so a shape in a different walk
      // must be brought into this numbering first or every control binds to the wrong entry.
      // Curve edits are indexed by EDGE -- the exporter never reverses a curved shape for exactly
      // that reason -- so a file carrying them is left exactly as saved.
      let alignNote = null, dropCurves = false;
      const hasCurveEdits = !!(f.curveEdits && Object.keys(f.curveEdits).length);
      const al = alignToConfig(S.cfg, S.groups, m, A, L);
      if (!al) {
        alignNote = 'this shape does not fit the combo under any relabelling, so it was used as saved';
      } else if (!al.identity && hasCurveEdits && f.curvesAuto) {
        // GENERATED curves (the gallery decoration, curvesAuto) are keyed to the numbering the shape is STORED in, and 27% of the
        // gallery's shapes are stored in another numbering than their combo's (2026-10-20 audit: 1,659 of 6,258). Left as saved they
        // land on the wrong edges: #209209 m7 si14 drew one S template on edges of different lengths. They are only decoration,
        // so align the shape to this combo and let the sizer make a fresh set for THIS numbering (autoFit below).
        A = al.A; L = al.L; dropCurves = true;
        alignNote = 'vertex numbering re-aligned to this combo (' + al.how + '); the stored decorative curves belong to the other numbering, so fresh ones were made';
      } else if (!al.identity && hasCurveEdits) {
        alignNote = 'the file stores this shape in a different vertex numbering (' + al.how
                  + ') but carries curve edits, which are indexed by edge, so it was left as saved';
      } else if (!al.identity) {
        A = al.A; L = al.L;
        alignNote = 'vertex numbering re-aligned to this combo (' + al.how
                  + '): the file stores the shape in a different walk';
      }
      try {
        // the same floors the exporter accepts with (program7/shape_place.js FLOORS): 0.05 degree, 5e-4 relative
        const rc = TC.recloseSaved(S.cfg.eqs, S.groups, m, A, L, { floorA: 0.05, floorL: 5e-4 });
        if (rc.ok) { A = rc.A; L = rc.L;
          note = rc.gapBefore > 1e-12 ? 'loaded and re-closed: the saved numbers are rounded, so the shape was walked back to exact closure within that rounding' : null;
        } else {
          note = 'loaded AS SAVED: it does not re-close within its own rounding (gap ' + rc.gapBefore.toExponential(2) + ')'
               + (rc.reason ? ' -- ' + rc.reason : '') + ', so the file\'s own numbers are being used';
        }
      } catch (e) { note = 'loaded as saved: re-closing failed (' + e.message + ')'; }
      if (alignNote) note = note ? (alignNote + '; ' + note) : alignNote;
      S.A = A; S.L = L;
      S.curves = (!dropCurves && f.curveEdits && Object.keys(f.curveEdits).length) ? clean(f.curveEdits) : null;
      S.autoCurves = !!(S.curves && f.curvesAuto) || dropCurves; S.autoMeta = null; S.noAuto = false;
      const n2 = startFamily(note);
      if (!S.curves) autoFit(true);
      // Generated curves that came WITH the shape are the gallery's own set: keep them on open (John, 2026-10-14: "would like
      // to see the same curves as the gallery"). Marking this shape as already fitted stops payload() re-sizing them at once;
      // they are re-sized only when the shape actually moves.
      else if (S.autoCurves && !dropCurves) { const r4f = function (x) { return Math.round(x * 1e4) / 1e4; }; S.fitKey = S.A.map(r4f).join(',') + '|' + S.L.map(r4f).join(','); }
      return Object.assign(payload(n2), { si: si, or: or, off: off });
    }
    // The automatic designer, on the shape as it stands. Returns the curves it chose, or says why not.
    function designCurves(ms) {
      const ctx = RTE.curveCtx(S.cfg, S.m);
      let dg = null; try { dg = TD.diagnose({}, ctx, S.A, S.L); } catch (e) { return Object.assign(payload('could not diagnose this shape'), { ok: false }); }
      if (dg.verdict === 'not a tile') return Object.assign(payload('rejected: ' + dg.reason), { ok: false });     // 1.6.1 wording
      const dl = Date.now() + (ms || 30000);
      let dc = null; try { dc = TD.designCurves({}, ctx, S.A, S.L, S.curves || {}, dg, { starts: 24, deadline: dl }); } catch (e) {}
      if (dc && dc.clearance > RTE.CURVE_CLEAR_MIN) { S.curves = clean(dc.curveEdits); S.autoCurves = false; return payload('curves designed on this shape (clearance ' + dc.clearance.toExponential(1) + ')'); }
      // nothing clears on THIS member: walk the family for one where curves do clear
      let w = null; try { w = TD.designShapeAndCurves({}, ctx, S.A, S.L, S.curves || {}, { starts: 24, deadline: dl }); } catch (e) {}
      if (w && w.A && w.clearance > RTE.CURVE_CLEAR_MIN) {
        S.A = w.A.slice(); S.L = w.L.slice(); S.curves = clean(w.curveEdits); S.autoCurves = false; startFamily(null);
        return payload('no curve clears on that shape, so the family was searched: this is a different member, with curves (clearance ' + w.clearance.toExponential(1) + ')');
      }
      return Object.assign(payload('no curve found that clears this shape, here or elsewhere in its family'), { ok: false });
    }
    function clean(edits) { const o = {};
      for (const k of Object.keys(edits || {})) { const e = edits[k]; if (e && e.pts) o[k] = { type: e.type, pts: e.pts.map(function (q) { return [q[0], q[1]]; }) }; }
      return o; }
    // the editor's own edits, straight from the client; measured, never second-guessed
    function setCurves(edits) {
      S.curves = (edits && Object.keys(edits).length) ? clean(edits) : null;
      S.autoCurves = false;                                       // an edit makes them the user's own
      return payload(null);
    }
    // THE TILING. develop() glues copies of the tile edge to edge through the type's own net data, so the
    // patch is built by the symmetry group, not by searching for a fit. Nothing here checks for overlaps:
    // a boundary that closes and does not cross itself tiles (John, 2026-10-02) -- the drawn boundary is
    // checked for crossing once, on the tile itself, and that is the whole test.
    function patch(maxTiles) {
      const m = S.m, V = TC.verticesOf(S.A, S.L, m).slice(0, m), ned = S.cfg.ned;
      const gap = TC.gapOf(S.A, S.L, m) / Math.max.apply(null, S.L);
      if (!(gap < 1e-6)) return { ok: false, reason: 'the tile does not close yet (gap ' + gap.toExponential(2) + ' of its longest edge) -- close it first' };
      let placed = null;
      try { placed = TC.develop(V, S.cfg.k, S.cfg.n, ned[5].slice(), ned[4].map(Math.abs), ned[2], ned[3], ned[6], maxTiles || 60); }
      catch (e) { return { ok: false, reason: 'the tiling could not be developed: ' + e.message }; }
      if (!placed || !placed.length) return { ok: false, reason: 'the tiling could not be developed' };
      let tiles;
      if (S.curves && Object.keys(S.curves).length) {
        const rcAll = TD.repMapping(m, S.cfg.whichEdge, S.cfg.mapping, S.cfg.edgeSym).rc;
        const curveOf = rcAll.map(function (o) { const ed = S.curves[o.rep];
          return ed ? TCv.applyMap(TCv.buildCanon(ed.type, ed.pts), o.code) : [[0, 0], [1, 0]]; });
        try { tiles = TCv.buildCurvedTiles(placed, V, curveOf).map(function (t) { return { orbit: t.orbit, pts: t.pts }; }); }
        catch (e) { tiles = placed.map(function (t) { return { orbit: t.orbit, pts: t.verts }; }); }
      } else tiles = placed.map(function (t) { return { orbit: t.orbit, pts: t.verts }; });
      // round for transport: this is a picture, and full precision would triple the message size
      const r = x => Math.round(x * 1e4) / 1e4;
      return { ok: true, tiles: tiles.map(function (t) { return { orbit: t.orbit, pts: t.pts.map(function (q) { return [r(q[0]), r(q[1])]; }) }; }) };
    }
    // How much room the DRAWN boundary has: > 0 means it does not touch itself anywhere.
    function clearance() {
      const V = TC.verticesOf(S.A, S.L, S.m).slice(0, S.m);
      const rcAll = TD.repMapping(S.m, S.cfg.whichEdge, S.cfg.mapping, S.cfg.edgeSym).rc;
      const curveOf = rcAll.map(function (o) {
        const ed = S.curves && S.curves[o.rep];
        return ed ? TCv.applyMap(TCv.buildCanon(ed.type, ed.pts), o.code) : [[0, 0], [1, 0]]; });
      try { return RTE.CD.separation(TCv.curvedTile(V, curveOf)).rel; } catch (e) { return null; }
    }
    function resetSession() { return openSession(S.combo); }
    // REDUCE: the fewer-sided combo for the same tile (js/combo_reduce.js). Searching the smaller m's sum-types
    // runs the engine on OTHER (m, si) configurations, so the harness's global state is put back on THIS session's
    // combo afterwards, whatever the outcome -- the session carries on if the reduction was refused.
    function reduceSession() {
      if (!RED) return { ok: false, reason: 'the reducer did not load in this worker' };
      let r;
      try { r = RED.reduce({ combo: S.combo, cfg: S.cfg, m: S.m, A: S.A, L: S.L, curves: S.curves || null }); }
      catch (e) { r = { ok: false, reason: 'the reduction threw: ' + e.message }; }
      try { H.loadType(S.combo.id); H.runSums(S.m); H.config(S.combo.id, S.m, S.combo.or, S.combo.off, S.combo.si); } catch (e) {}
      return r;
    }

    onmessage = function (e) {
      const d = e.data;
      try {
        if (d.type === 'open') postMessage({ type: 'result', id: d.id, result: openSession(d.combo) });
        else if (d.type === 'moveTrue') postMessage({ type: 'result', id: d.id, result: moveTrue(d) });
        else if (d.type === 'moveRaw') postMessage({ type: 'result', id: d.id, result: moveRaw(d) });
        else if (d.type === 'toTrue') postMessage({ type: 'result', id: d.id, result: toTrue() });
        else if (d.type === 'reclose') postMessage({ type: 'result', id: d.id, result: reclose() });
        else if (d.type === 'reset') postMessage({ type: 'result', id: d.id, result: resetSession() });
        else if (d.type === 'reduce') postMessage({ type: 'result', id: d.id, result: reduceSession() });
        else if (d.type === 'designCurves') postMessage({ type: 'result', id: d.id, result: designCurves(d.ms) });
        else if (d.type === 'setCurves') postMessage({ type: 'result', id: d.id, result: Object.assign(setCurves(d.edits), { clearance: clearance() }) });
        else if (d.type === 'clearCurves') { S.noAuto = true; postMessage({ type: 'result', id: d.id, result: setCurves(null) }); }
        else if (d.type === 'patch') postMessage({ type: 'result', id: d.id, result: patch(d.maxTiles) });
        else if (d.type === 'forSave') postMessage({ type: 'result', id: d.id, result: shapeForSave() });
        else if (d.type === 'openSaved') postMessage({ type: 'result', id: d.id, result: openSaved(d.file) });
        else if (d.type === 'init') { boot(d.bundle);
          if (d.sizer) { try { CSZ = (new Function('return (' + d.sizer + ')'))()({ TD: TD, TCv: TCv, CD: RTE.CD }); } catch (e) { CSZ = null; } }
          if (d.reducer) { try { RED = (new Function('return (' + d.reducer + ')'))()({ H: H, TC: TC, TD: TD, TCv: TCv, CD: RTE.CD }); } catch (e) { RED = null; } }
          postMessage({ type: 'ready', info: INFO }); }
        else if (d.type === 'find') postMessage({ type: 'result', id: d.id, result: FIND(d.combo, d.opts || {}) });
        // A deep search may ask for REDUCIBLE combos to be judged too, which find() never does. Rather than
        // change the frozen version, call its judge with that option and read the answer with the version's
        // OWN classifier, so a deep-search verdict means exactly what find() would have meant.
        else if (d.type === 'judge') {
          const c = d.combo, o = d.opts || {};
          const t0 = Date.now();
          let r; try { r = JD.judgeCombo(c.id, c.m, c.or, c.off, c.si, { withReducible: !!o.withReducible, curveBudgetMs: o.curveBudgetMs || 0 }); }
          catch (e) { r = { kind: 'threw', why: e.message }; }
          const out = CLASSIFY(r);
          // FOR DRAWING the tile with curves (John, 2026-10-20: "in the deep search ... include curves on the edges"): the combo's
          // edge orbits (es/we/mp, the same numbering as the shape) and, when the finder's witness needs no curves, a decorative set
          // from the same sizer the gallery uses. Outside the frozen finder; nothing here changes the verdict.
          try {
            const sh = out.details && out.details.shape;
            if (sh && sh.A && sh.L) {
              const cfg = H.config(c.id, c.m, c.or, c.off, c.si);
              if (cfg && cfg.edgeSym) {
                out.details.edge = { es: Array.from(cfg.edgeSym), we: Array.from(cfg.whichEdge), mp: Array.from(cfg.mapping) };
                if (!(sh.curves && Object.keys(sh.curves).length) && CSZ) {
                  const z = CSZ.size(RTE.curveCtx(cfg, c.m), sh.A, sh.L, {});
                  if (z && z.ok && Object.keys(z.edits).length) out.details.deco = z.edits;
                }
              }
            }
          } catch (e) { /* a picture without curves is still a picture */ }
          postMessage({ type: 'result', id: d.id, result: { version: INFO.version, combo: c, verdict: out.verdict, details: out.details, ms: Date.now() - t0 } });
        }
        else if (d.type === 'sizes') postMessage({ type: 'result', id: d.id, result: sizes(d.typeId, d.mMax || 20) });
        else if (d.type === 'grid') postMessage({ type: 'result', id: d.id, result: grid(d.id, d.typeId, d.m, d.from, d.count) });
        else if (d.type === 'findSizes') postMessage({ type: 'result', id: d.id, result: findSizes(d.id, d.typeId, d.listA, d.listB) });
      } catch (err) { postMessage({ type: 'error', id: d.id, message: String(err && err.stack || err) }); }
    };`;

  let loading = null, workers = [], idle = [], queue = [], seq = 0, pending = {}, info = null;

  function loadBundle() {
    if (window.FINDER_BUNDLE) return Promise.resolve(window.FINDER_BUNDLE);
    return new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = 'data/finder_bundle.js';
      el.onload = () => res(window.FINDER_BUNDLE);
      el.onerror = () => rej(new Error('data/finder_bundle.js did not load -- run, in program7: node app_tools/build_finder_bundle.js'));
      document.head.appendChild(el);
    });
  }
  function startWorker(bundle) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(new Blob([BOOT], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = e => {
        const d = e.data;
        if (d.type === 'ready') { info = d.info; w.onmessage = onMsg(w); res(w); }
        else if (d.type === 'error') rej(new Error(d.message));
      };
      w.onerror = e => rej(new Error('worker failed: ' + (e.message || e)));
      w.postMessage({ type: 'init', bundle, sizer: window.makeCurveSizing ? window.makeCurveSizing.toString() : null,
                                   reducer: window.makeComboReducer ? window.makeComboReducer.toString() : null });
    });
  }
  function onMsg(w) {
    return e => {
      const d = e.data, p = pending[d.id];
      if (!p) return;
      if (d.type === 'progress') { if (p.onProgress) p.onProgress(d); return; }   // job is still running
      delete pending[d.id];
      if (d.type === 'result') p.resolve(d.result); else p.reject(new Error(d.message));
      const n = (jobsDone.get(w) || 0) + 1; jobsDone.set(w, n);
      if (n >= RECYCLE_AFTER) recycle(w); else { idle.push(w); pump(); }
    };
  }
  // A worker's caches only grow (the solver remembers every system it has solved), and a long deep search at a large m
  // ran the browser out of memory. After RECYCLE_AFTER jobs a worker is replaced by a fresh one: same finder, so the
  // answers are the same; only the remembered work is dropped. If the new one cannot start, the old one carries on.
  const RECYCLE_AFTER = window.FINDER_RECYCLE_AFTER || 150, jobsDone = new WeakMap();
  function recycle(w) {
    loadBundle().then(b => startWorker(b)).then(nw => {
      jobsDone.set(nw, 0);
      workers[workers.indexOf(w)] = nw; w.terminate();
      idle.push(nw); pump();
    }).catch(() => { jobsDone.set(w, 0); idle.push(w); pump(); });
  }
  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop(), job = queue.shift();
      pending[job.id] = job;
      w.postMessage(job.msg);
    }
  }
  function submit(msg, onProgress) {
    return ready().then(() => new Promise((resolve, reject) => {
      msg.id = ++seq;
      queue.push({ id: msg.id, msg, resolve, reject, onProgress }); pump();
    }));
  }
  /** Start `n` workers (default: cores - 1, at least 1). Safe to call again. */
  function ready(n) {
    if (loading) return loading;
    n = n || Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    loading = loadBundle().then(b => Promise.all(Array.from({ length: n }, () => startWorker(b))))
      .then(ws => { workers = ws; idle = ws.slice(); ws.forEach(w => jobsDone.set(w, 0)); return { workers: ws.length, version: info.version, hash: info.hash }; });
    return loading;
  }
  const find = (combo, opts) => submit({ type: 'find', combo, opts });
  /** Like find, but will judge a reducible combo when opts.withReducible is set. */
  const judge = (combo, opts) => submit({ type: 'judge', combo, opts });
  /** [[m, sumTypeCount], ...] for one type. */
  const sizes = (typeId, mMax) => submit({ type: 'sizes', typeId, mMax });
  /** Status of every combo at one size. onRow({si, label, row, total}) fires per sum-type as it lands. */
  const grid = (typeId, m, onRow, from, count) => submit({ type: 'grid', typeId, m, from, count }, onRow);
  // Copy tiling: the combos of this type whose per-orbit side sizes match a picture. Always anchored.
  const findSizes = (typeId, listA, listB, onProgress) =>
    submit({ type: 'findSizes', typeId, listA, listB }, onProgress);
  /** A dedicated worker holding ONE open combo. call(type, payload) -> Promise. close() frees the worker. */
  function session() {
    return loadBundle().then(b => startWorker(b)).then(w => {
      const wait = {}; let n = 0;
      w.onmessage = e => { const d = e.data, p = wait[d.id]; if (!p) return; delete wait[d.id];
        if (d.type === 'result') p.resolve(d.result); else p.reject(new Error(d.message)); };
      return {
        call: (type, payload) => new Promise((resolve, reject) => {
          const id = ++n; wait[id] = { resolve, reject }; w.postMessage(Object.assign({ type, id }, payload || {})); }),
        close: () => w.terminate(),
      };
    });
  }
  return { ready, find, judge, sizes, grid, findSizes, session, info: () => info, size: () => workers.length };
})();
