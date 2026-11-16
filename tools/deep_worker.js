// One worker thread of tools/deep_search.js. It runs the SAME worker code the browser app runs (the BOOT string
// inside js/finder_pool.js, read out of that file at start-up so the two cannot drift apart) on the SAME bundled
// finder (data/finder_bundle.js). Messages in and out are the browser's own: init / judge / grid -> result / progress.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { parentPort } = require('worker_threads');

const APP = path.join(__dirname, '..');
const poolSrc = fs.readFileSync(path.join(APP, 'js', 'finder_pool.js'), 'utf8');
const mm = /const BOOT = String\.raw`([\s\S]*?)`;\s*\n\s*let loading/.exec(poolSrc);
if (!mm) throw new Error('could not find the worker code (BOOT) in js/finder_pool.js');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(APP, 'data', 'finder_bundle.js'), 'utf8'), sandbox);
const bundle = sandbox.window.FINDER_BUNDLE;
if (!bundle) throw new Error('data/finder_bundle.js did not define FINDER_BUNDLE');

// BOOT assigns a bare `onmessage` (a global in a browser worker) and talks through `postMessage` and `self`.
const post = m => parentPort.postMessage(m);
new Function('self', 'postMessage', mm[1])({}, post);
parentPort.on('message', d => global.onmessage({ data: d }));
// the curve sizer (js/curve_sizing.js), as the browser posts it, so a find comes back with curves to draw it with
let sizer = null; try { sizer = require(path.join(APP, 'js', 'curve_sizing.js')).toString(); } catch (e) {}
global.onmessage({ data: { type: 'init', bundle, sizer, reducer: null } });
