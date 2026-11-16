// The searches YOU ran, kept in your own browser.
//
// The published site is read-only: a page cannot write into the repository, so a deep search run here has
// nowhere to go but your own machine. This keeps each finished size in IndexedDB so it survives a reload, and
// the type cards show it beside the published record.
//
// It is deliberately NOT merged into the published data. Two sources on one screen are only honest while you
// can tell them apart, so anything from here is labelled as yours and not part of the published record until
// John has imported the file you send him. Records are keyed id/m/version, the same key the store uses, so a
// size you searched twice replaces itself rather than piling up.
'use strict';
window.LocalStore = (function () {
  const DB = 'mono2iso', STORE = 'searches', PROG = 'progress', VERSION = 2;
  let dbp = null, cache = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open(DB, VERSION); } catch (e) { rej(e); return; }
      req.onupgradeneeded = () => { const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
        if (!d.objectStoreNames.contains(PROG)) d.createObjectStore(PROG, { keyPath: 'key' }); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error('this browser would not open its database'));
    });
    return dbp;
  }
  function tx(mode, fn, store) {
    return open().then(d => new Promise((res, rej) => {
      const t = d.transaction(store || STORE, mode), s = t.objectStore(store || STORE);
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    }));
  }

  /** Record one FINISHED size. `row` is the per-size summary the save file carries; `finds` its results. */
  function putSize(id, m, version, row, finds, extra) {
    cache = null;
    return tx('readwrite', s => s.put({
      key: id + '/' + m + '@' + version,
      id, m, version, row, finds: finds || [], extra: extra || null, at: new Date().toISOString(),
    })).catch(e => { console.warn('could not remember that size in this browser:', e.message); });
  }
  /** The finished record of one size (or undefined). `extra` holds the options it was run with and the shapes. */
  function getSize(id, m, version) {
    return tx('readonly', s => s.get(id + '/' + m + '@' + version)).catch(() => undefined);
  }
  // ---- progress of a size that is still running ----------------------------------------------------------
  // Results are written in small chunks AS THEY ARRIVE, so a crash or reload loses at most the last few seconds.
  // A chunk is { done: [[cellNumber, code], ...], finds: [...] }. Nothing here is coverage: only putSize claims a size.
  const progPrefix = (id, m, version) => id + '/' + m + '@' + version + '#';
  function putChunk(id, m, version, chunk) {
    const key = progPrefix(id, m, version) + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
    return tx('readwrite', s => s.put(Object.assign({ key }, chunk)), PROG)
      .catch(e => { console.warn('could not save progress in this browser:', e.message); });
  }
  function getProgress(id, m, version) {
    const p = progPrefix(id, m, version);
    return tx('readonly', s => s.getAll(IDBKeyRange.bound(p, p + '\uffff')), PROG).then(r => r || []).catch(() => []);
  }
  function clearProgress(id, m, version) {
    const p = progPrefix(id, m, version);
    return tx('readwrite', s => s.delete(IDBKeyRange.bound(p, p + '\uffff')), PROG).catch(() => {});
  }
  /** Everything this browser holds, newest first. */
  function all() {
    return tx('readonly', s => s.getAll()).then(rows => (rows || []).sort((a, b) => String(b.at).localeCompare(String(a.at))))
      .catch(() => []);
  }
  /** Per type, what THIS browser adds: { depth, sizes:[m], finds:[...] }. Cached; cleared on every write. */
  function byType() {
    if (cache) return Promise.resolve(cache);
    return all().then(rows => {
      const out = {};
      for (const r of rows) {
        const t = out[r.id] = out[r.id] || { sizes: new Set(), finds: [], at: r.at };
        t.sizes.add(r.m);
        for (const f of r.finds || []) t.finds.push(f);
      }
      for (const id of Object.keys(out)) {
        const t = out[id];
        t.sizes = [...t.sizes].sort((a, b) => a - b);
        t.depth = t.sizes.length ? t.sizes[t.sizes.length - 1] : null;
      }
      cache = out;
      return out;
    });
  }
  function clearAll() { cache = null; return tx('readwrite', s => s.clear()).then(() => tx('readwrite', s => s.clear(), PROG)); }
  function forget(id) {
    cache = null;
    return all().then(rows => Promise.all(rows.filter(r => r.id === id)
      .map(r => tx('readwrite', s => s.delete(r.key)))));
  }
  /** Everything here as one file, in the shape program7/import_deepsearch.js reads -- one entry per type. */
  function exportAll() {
    return all().then(rows => {
      const byId = {};
      for (const r of rows) {
        const f = byId[r.id] = byId[r.id] || {
          kind: 'mono2iso deep search results', id: r.id, version: r.version,
          versionNote: 'program8 in-browser deep search, kept in a browser and exported',
          savedAt: new Date().toISOString(), sizesCompleted: [], results: [], combosTried: 0,
          skipIsohedral: false, skipReducible: true, reducibleSkipped: 0, isohedralNotListed: 0,
        };
        f.sizesCompleted.push(r.row);
        f.results.push(...(r.finds || []));
        f.combosTried += (r.row && r.row.judged) || 0;
        f.reducibleSkipped += (r.row && r.row.redSkipped) || 0;
        f.isohedralNotListed += (r.row && r.row.isoSkipped) || 0;
      }
      for (const id of Object.keys(byId)) {
        const f = byId[id];
        f.sizesCompleted.sort((a, b) => a.m - b.m);
        f.startM = f.sizesCompleted[0] ? f.sizesCompleted[0].m : null;
        f.targetM = f.sizesCompleted.length ? f.sizesCompleted[f.sizesCompleted.length - 1].m : null;
      }
      return Object.values(byId);
    });
  }
  return { putSize, getSize, putChunk, getProgress, clearProgress, all, byType, clearAll, forget, exportAll };
})();
