#!/usr/bin/env node
// Deep search from the command line: the app's Deep search tab, for runs that should go all night.
//
//   node tools/deep_search.js --id 25546 --from 56 --to 70
//
//   --id N          the type (tegula number)                                   required
//   --from M --to M  first and last m (sizes with no sum-types are skipped)     required
//   --reducible     also judge reducible combos (default: skipped, as in the app)
//   --no-iso        count isohedral combos instead of listing them
//   --workers N     worker threads (default: cores - 1)
//   --out DIR       where everything is written (default: deep_results/<id> next to the app)
//   --fresh         ignore what is already in DIR and search everything again
//   --recycle N     replace a worker after N jobs, to drop its caches (default 150)
//   --page N        sum-types per grid job (default 150)
//   --curve-ms N    curve-search budget per combo (default 60000, the app's)
//   --shapes MODE   which finds carry their shape (angles, lengths, curves) in the results file: all (default), slow, none.
//                   A shape found once can be hard to find again, so keep them; 'slow' keeps only finds that took --slow-secs.
//   --slow-secs N   what 'slow' means (default 30)
//
// It runs the very same finder as the app: data/finder_bundle.js, in the very same worker code (read out of
// js/finder_pool.js), so a verdict here is the verdict the app would give. Verdicts are classified exactly as in
// js/deep.js, and the results file has the app's "save results" shape, so program7/import_deepsearch.js reads it.
//
// Safe to stop and restart at any time: every judged combo is appended to DIR/progress_m<M>.jsonl as it arrives, and a
// size only counts as searched once it is FINISHED (DIR/size_m<M>.json). Run it again with the same arguments and it
// carries on. To stop cleanly: Ctrl+C, or create a file named STOP in DIR (STOP_AFTER_SIZE: finish the size now running,
// then stop). Results file: DIR/deepsearch_<id>_m<from>-<to>.json, rewritten after every finished size.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker } = require('worker_threads');

const APP = path.join(__dirname, '..');
const arg = (() => {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) { console.error('unexpected argument ' + a[i]); process.exit(2); }
    const k = a[i].slice(2), isFlag = ['reducible', 'no-iso', 'fresh'].includes(k);
    o[k] = isFlag ? true : a[++i];
  }
  return o;
})();
const ID = +arg.id, M0 = +arg.from, M1 = +arg.to;
if (!ID || !M0 || !M1 || M1 < M0) { console.error('usage: node tools/deep_search.js --id N --from M --to M  [--reducible] [--no-iso] [--workers N] [--out DIR] [--fresh]'); process.exit(2); }
const OPTS = { red: !!arg.reducible, iso: !arg['no-iso'] };
const NW = Math.max(1, +arg.workers || Math.max(1, os.cpus().length - 1));
const RECYCLE = +arg.recycle || 150, PAGE = +arg.page || 150, CURVE_MS = +arg['curve-ms'] || 60000;
const SHAPES = arg.shapes || 'all', SLOW_MS = (+arg['slow-secs'] || 30) * 1000;
if (!['all', 'slow', 'none'].includes(SHAPES)) { console.error('--shapes must be all, slow or none'); process.exit(2); }
const OUT = path.resolve(arg.out || path.join(APP, 'deep_results', String(ID)));
fs.mkdirSync(OUT, { recursive: true });

const log = s => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + s);
let stop = false, stopAfter = false;
process.on('SIGINT', () => { if (stop) process.exit(130); stop = true; log('Ctrl+C: finishing the combos in flight, saving, then stopping (press again to quit at once)'); });
const flagFile = n => fs.existsSync(path.join(OUT, n));

// ---- the worker pool --------------------------------------------------------------------------------------------
class Pool {
  constructor(n) { this.n = n; this.slots = []; this.queue = []; this.seq = 0; this.info = null; this.ready = null; }
  start() {
    this.ready = new Promise(res => { this._res = res; });
    for (let i = 0; i < this.n; i++) this.slots.push(this.spawn());
    return this.ready;
  }
  spawn(old) {
    const s = old || {};
    Object.assign(s, { jobs: 0, busy: false, ok: false, cur: null });
    // a worker that runs out of memory dies alone (the job it held is reported as failed); a fresh one takes its place
    const w = s.w = new Worker(path.join(__dirname, 'deep_worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    // events of a worker that has since been replaced (recycled, or dead) must not touch the slot's new worker
    w.on('message', d => { if (s.w === w) this.onMsg(s, d); });
    w.on('error', e => { if (s.w === w) this.died(s, e); });
    w.on('exit', code => { if (s.w === w && s.cur) this.died(s, new Error('worker exited ' + code)); });
    return s;
  }
  died(s, e) {
    const cur = s.cur; s.cur = null;
    try { s.w.terminate(); } catch (x) {}
    if (cur) cur.reject(new Error(String(e && e.message || e)));
    this.spawn(s);
  }
  onMsg(s, d) {
    if (d.type === 'ready') { s.ok = true; this.info = d.info; if (this._res && this.slots.every(x => x.ok)) { this._res(); this._res = null; } this.pump(); return; }
    const job = s.cur; if (!job || d.id !== job.id) return;
    if (d.type === 'progress') { if (job.onProgress) job.onProgress(d); return; }
    s.cur = null; s.busy = false; s.jobs++;
    if (d.type === 'result') job.resolve(d.result); else job.reject(new Error(d.message));
    if (s.jobs >= RECYCLE) { s.w.terminate(); this.spawn(s); } else this.pump();
  }
  pump() {
    for (const s of this.slots) {
      if (!this.queue.length) return;
      if (!s.ok || s.busy) continue;
      const job = this.queue.shift();
      if (job.skip && job.skip()) { job.resolve(null); s.busy = false; this.pump(); return; }
      s.busy = true; s.cur = job; s.w.postMessage(Object.assign({ id: job.id }, job.msg));
    }
  }
  submit(msg, onProgress, skip) {
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.seq, msg, resolve, reject, onProgress, skip }); this.pump(); });
  }
  async close() { await Promise.all(this.slots.map(s => s.w.terminate())); }
}

// ---- files --------------------------------------------------------------------------------------------------------
const sizeFile = m => path.join(OUT, 'size_m' + m + '.json');
const progFile = m => path.join(OUT, 'progress_m' + m + '.jsonl');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const sameOpts = o => o && o.red === OPTS.red && o.iso === OPTS.iso;

// One find as the results file carries it (same as fileFind in js/deep.js): the shape is the finder's witness, rounded as the store rounds it
const rnd = (x, d) => +(+x).toFixed(d);
function fileFind(r) {
  const o = { id: ID, m: r.m, si: r.si, sum: r.sum, or: r.or, off: r.off, kind: r.kind,
              crit: (r.crit || []).join(','), blk: r.block ? r.block + '@' + r.block + 't' : '' };
  if (r.reducible) o.reducible = true;
  if (r.ms != null) o.ms = r.ms;
  if (r.edge) o.edge = r.edge;                         // for drawing in the app (js/deep.js); the store keeps only the witness curves
  if (r.deco && SHAPES !== 'none') o.deco = r.deco;
  if (r.shape && r.shape.A && (SHAPES === 'all' || (SHAPES === 'slow' && r.ms >= SLOW_MS))) {
    o.shape = { A: r.shape.A.map(x => rnd(x, 6)), L: r.shape.L.map(x => rnd(x, 8)) };
    if (r.curves) {
      o.curves = {};
      for (const k of Object.keys(r.curves)) o.curves[k] = { type: r.curves[k].type, pts: r.curves[k].pts.map(p => [rnd(p[0], 6), rnd(p[1], 6)]) };
      if (r.curveClr != null) o.curveClr = +(+r.curveClr).toExponential(4);
    }
  }
  return o;
}

// the results file, in the app's "save results" shape (js/deep.js save())
function writeResults(ver, info) {
  const sizes = [];
  for (const f of fs.readdirSync(OUT)) { const mm = /^size_m(\d+)\.json$/.exec(f); if (mm) { const j = readJson(path.join(OUT, f)); if (j && j.row) sizes.push(j); } }
  if (!sizes.length) return;
  sizes.sort((a, b) => a.m - b.m);
  const fin = sizes.map(s => s.row);
  const file = {
    kind: 'mono2iso deep search results', id: ID, name: String(ID), version: ver,
    versionNote: 'program8 command-line deep search (tools/deep_search.js), finder ' + (info ? info.version + ' [' + info.hash + ']' : '?'),
    savedAt: new Date().toISOString(), startM: sizes[0].m, targetM: sizes[sizes.length - 1].m,
    skipIsohedral: !OPTS.iso, skipReducible: !OPTS.red,
    reducibleSkipped: fin.reduce((a, r) => a + r.redSkipped, 0), isohedralNotListed: fin.reduce((a, r) => a + r.isoSkipped, 0),
    sizesCompleted: fin.map(r => ({ m: r.m, combos: r.combos, closed: r.aniso + r.iso, clean: r.aniso + r.iso, aniso: r.aniso, foundNoTile: r.notile,
                                    redSkipped: r.redSkipped, isoSkipped: r.isoSkipped, unknown: r.unknown, noConfig: r.impossible, secs: r.secs })),
    combosTried: fin.reduce((a, r) => a + r.judged, 0),
    shapesSaved: SHAPES,
    results: [].concat(...sizes.map(s => (s.results || []).map(fileFind))),
  };
  const name = 'deepsearch_' + ID + '_m' + file.startM + '-' + file.targetM + '.json';
  for (const f of fs.readdirSync(OUT)) if (/^deepsearch_\d+_m\d+-\d+\.json$/.test(f) && f !== name && f.startsWith('deepsearch_' + ID + '_')) fs.unlinkSync(path.join(OUT, f));
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(file, null, 1));
  return name;
}

// ---- one size -----------------------------------------------------------------------------------------------------
async function runSize(pool, m, ver) {
  // already finished with the same options: keep it
  if (!arg.fresh) {
    const j = readJson(sizeFile(m));
    if (j && sameOpts(j.opts) && j.ver === ver) { log(`m=${m}: already finished in ${OUT} — kept`); return { finished: true, kept: true }; }
  }
  const row = { m, combos: 0, judged: 0, aniso: 0, iso: 0, notile: 0, unknown: 0, impossible: 0, redSkipped: 0, isoSkipped: 0 };
  const results = [], done = new Set(), t0 = Date.now();
  // a half-searched run of this size: replay it
  const pf = progFile(m);
  if (fs.existsSync(pf)) {
    const lines = fs.readFileSync(pf, 'utf8').split('\n').filter(Boolean);
    let hdr = null; try { hdr = JSON.parse(lines[0]).hdr; } catch (e) {}
    if (arg.fresh || !hdr || !sameOpts(hdr.opts) || hdr.ver !== ver) {
      fs.renameSync(pf, pf + '.old-' + Date.now());                                   // kept, never overwritten
    } else {
      for (const ln of lines.slice(1)) {
        let r; try { r = JSON.parse(ln); } catch (e) { continue; }                      // a torn last line from a crash
        if (r.d) {
          const [cell, code] = r.d; done.add(cell); row.judged++;
          if (code === 'a') row.aniso++; else if (code === 'i') { row.iso++; if (!OPTS.iso) row.isoSkipped++; }
          else if (code === 'x') row.impossible++; else if (code === 'n') row.notile++; else row.unknown++;
        } else if (r.f) results.push(r.f);
      }
      if (done.size) log(`m=${m}: carrying on from ${done.size.toLocaleString()} combos already judged`);
    }
  }
  if (!fs.existsSync(pf)) fs.writeFileSync(pf, JSON.stringify({ hdr: { id: ID, m, ver, opts: OPTS } }) + '\n');

  // 1. every combo of this size, in pages across the workers; keep only those still to judge, as plain numbers
  const labels = new Map(), todo = [];
  let total = null, pages = [], launched = false, gridRows = 0;
  const onRow = d => {
    if (d.page) { total = d.total; if (!launched) { launched = true; for (let from = PAGE; from < total; from += PAGE) pages.push(pool.submit({ type: 'grid', typeId: ID, m, from, count: PAGE }, onRow, () => stop)); } return; }
    if (!d.row) return;
    gridRows++; labels.set(d.si, d.label);
    d.row.forEach((v, k) => {
      row.combos++;
      if (v === 2) row.impossible++;
      else if (v === 1 && !OPTS.red) row.redSkipped++;
      else if (v === 0 || v === 1) { const cell = d.si * 2 * m + k; if (!done.has(cell)) todo.push(cell * 2 + v); }
    });
  };
  log(`m=${m}: listing the combos…`);
  const lastLog = { t: Date.now() };
  const ticker = setInterval(() => { if (Date.now() - lastLog.t > 30000) { lastLog.t = Date.now(); log(`m=${m}: listed ${gridRows.toLocaleString()} of ${total == null ? '?' : total.toLocaleString()} sum-types`); } }, 5000);
  const first = pool.submit({ type: 'grid', typeId: ID, m, from: 0, count: PAGE }, onRow, () => stop);
  await first; await Promise.all(pages); clearInterval(ticker);
  done.clear();
  if (stop) { log(`m=${m}: stopped while listing — nothing lost, it will list again next time`); return { finished: false }; }
  if (!row.combos) { log(`m=${m}: this type has no sum-types at this size`); fs.unlinkSync(pf); return { finished: true, empty: true }; }
  log(`m=${m}: ${row.combos.toLocaleString()} combos, ${todo.length.toLocaleString()} to judge (${row.impossible.toLocaleString()} have no angle solution, ${row.redSkipped.toLocaleString()} reducible skipped), ${Math.round((Date.now() - t0) / 1000)}s so far`);

  // 2. judge them, saving each answer as it arrives
  let buf = [], lastFlush = Date.now();
  const flush = () => { if (!buf.length) return; fs.appendFileSync(pf, buf.join('\n') + '\n'); buf = []; lastFlush = Date.now(); };
  let next = 0, live = 0, lastStat = Date.now();
  const tJudge = Date.now(), judge0 = row.judged;
  await new Promise(resolve => {
    const pumpAll = () => {
      if (!stop && (flagFile('STOP') || flagFile('STOP_AFTER_SIZE') && !stopAfter)) { if (flagFile('STOP')) { stop = true; log('STOP file found: stopping'); } else { stopAfter = true; log('STOP_AFTER_SIZE file found: will stop when this size is done'); } }
      while (!stop && live < NW * 2 && next < todo.length) {
        const n = todo[next++], v = n % 2, cell = (n - v) / 2, k = cell % (2 * m);
        const c = { si: Math.floor(cell / (2 * m)), or: k < m ? 0 : 1, off: k % m };
        live++;
        pool.submit({ type: 'judge', combo: { id: ID, m, si: c.si, or: c.or, off: c.off }, opts: { withReducible: OPTS.red, curveBudgetMs: CURVE_MS } })
          .then(r => {
            row.judged++;
            let code, kept = null;
            const keep = () => { kept = { m, si: c.si, or: c.or, off: c.off, kind: r.verdict, reducible: v === 1, sum: '[' + String(labels.get(c.si)).replace(/[\[\]\s]/g, '') + ']',
                                         block: r.details && r.details.block ? r.details.block.size : null, crit: r.details && r.details.block ? r.details.block.criteria : null,
                                         ms: r.ms == null ? null : r.ms,
                                         shape: r.details && r.details.shape ? { A: r.details.shape.A, L: r.details.shape.L } : null,
                                         curves: r.details && r.details.shape && r.details.shape.curves && Object.keys(r.details.shape.curves).length ? r.details.shape.curves : null,
                                         curveClr: r.details && r.details.shape && r.details.shape.curveClearance != null ? r.details.shape.curveClearance : null,
                                         edge: (r.details && r.details.edge) || null, deco: (r.details && r.details.deco) || null }; results.push(kept); };
            if (r.verdict === 'anisohedral') { row.aniso++; code = 'a'; keep(); }
            else if (r.verdict === 'isohedral') { row.iso++; code = 'i'; if (OPTS.iso) keep(); else row.isoSkipped++; }
            else if (r.verdict === 'impossible') { row.impossible++; code = 'x'; }
            else if (/^(deep search found no tile|no member tiles)/.test(String((r.details || {}).reason || ''))) { row.notile++; code = 'n'; }   // 1.6 wording, and 1.5's
            else { row.unknown++; code = 'u'; }
            buf.push(JSON.stringify({ d: [cell, code] })); if (kept) buf.push(JSON.stringify({ f: kept }));
            if (buf.length >= 40 || Date.now() - lastFlush > 5000) flush();
          })
          .catch(e => { row.judged++; row.unknown++; log(`m=${m} si=${c.si} or=${c.or} off=${c.off}: ${e.message.split('\n')[0]} (counted unknown; not recorded, so a later run tries it again)`); })
          .then(() => { live--; pumpAll(); });
      }
      if (Date.now() - lastStat > 30000) {
        lastStat = Date.now();
        const did = row.judged - judge0, rate = did / ((Date.now() - tJudge) / 1000 || 1), left = todo.length - next + live;
        log(`m=${m}: judged ${next - live}/${todo.length}  found ${row.aniso} aniso, ${row.iso} iso  ${rate.toFixed(1)}/s  ~${rate ? Math.round(left / rate / 60) : '?'} min left`);
      }
      if (!live && (stop || next >= todo.length)) resolve();
    };
    const t = setInterval(() => { if (!live && next >= todo.length || stop && !live) clearInterval(t); else pumpAll(); }, 2000);
    pumpAll();
  });
  flush();
  row.secs = Math.round((Date.now() - t0) / 1000);
  const finished = !stop;
  if (finished) {
    fs.writeFileSync(sizeFile(m) + '.tmp', JSON.stringify({ m, ver, opts: OPTS, row, results }));
    fs.renameSync(sizeFile(m) + '.tmp', sizeFile(m));
    fs.unlinkSync(pf);
    log(`m=${m}: FINISHED in ${row.secs}s — ${row.aniso} anisohedral, ${row.iso} isohedral, ${row.notile} found no tile, ${row.unknown} unknown`);
  } else log(`m=${m}: stopped part-way (${row.judged.toLocaleString()} judged) — saved; run again to carry on`);
  return { finished };
}

(async () => {
  const pool = new Pool(NW);
  log(`deep search of #${ID}, m=${M0}..${M1}, ${NW} workers, results in ${OUT}`);
  log(`options: ${OPTS.red ? 'reducible combos judged' : 'reducible skipped'}, ${OPTS.iso ? 'isohedral listed' : 'isohedral only counted'}`);
  await pool.start();
  const ver = pool.info.version + '.6';
  log(`finder ${pool.info.version} [${pool.info.hash}], results versioned ${ver}`);
  try {
    for (let m = M0; m <= M1 && !stop && !stopAfter; m++) {
      const r = await runSize(pool, m, ver);
      if (r.finished && !r.empty) { const n = writeResults(ver, pool.info); if (n) log('results file: ' + path.join(OUT, n)); }
      if (flagFile('STOP_AFTER_SIZE')) stopAfter = true;
    }
  } finally { await pool.close(); }
  log(stop ? 'stopped' : stopAfter ? 'stopped after the size that was running' : 'finished all sizes');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
