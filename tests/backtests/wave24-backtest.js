// Wave 24 backtests — v252 pre-second-user hardening:
// (1) seed guard — seedIfEmpty must never mistake a FAILED boot load for an
//     empty database (demo settings/costs/SKUs overwriting production on a
//     fresh device with flaky network);
// (2) autocomplete loader resilience — a hung request or a script that loads
//     but never fires the ready-callback used to leave a forever-pending
//     cached promise (autocomplete dead until full page reload).
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const plSrc = fs.readFileSync(path.join(__dirname, '../../public/places.js'), 'utf8');
const fuSrc = fs.readFileSync(path.join(__dirname, '../../public/find-us.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + load-confirmed flag');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  ok(dbSrc.includes('this._loadConfirmed = !!configSnap;'),
    '_loadConfirmed set from whether the server ANSWERED (null = failed read)');
  ok(dbSrc.indexOf('this._loadConfirmed = !!configSnap;') < dbSrc.indexOf("if (!configSnap || !configSnap.exists"),
    'flag decided before any branch consumes the snapshot');
}

console.log('[B] seedIfEmpty — run the REAL function against stub DBs');
{
  const seedSrc = slc(src, 'function seedIfEmpty()', '\n// Returns true for satin');
  const run = (dbState) => {
    const calls = { set: [], setObj: [] };
    const DB = {
      _firestoreReady: dbState.ready !== false,
      _loadConfirmed: dbState.confirmed !== false,
      _cache: dbState.cache || {},
      a(k) { return this._cache[k] || []; },
      obj(k, def) { return this._cache[k] ?? def; },
      set(k, v) { calls.set.push(k); this._cache[k] = v; },
      setObj(k, v) { calls.setObj.push(k); this._cache[k] = v; },
    };
    let n = 0;
    new Function('DB', 'uid', 'today', seedSrc + '\nseedIfEmpty();')(
      DB, () => 'id' + (++n), () => '2026-11-09');
    return calls;
  };

  // THE v252 case: boot reads failed on a fresh device — cache is empty but
  // the database is NOT. Nothing may be written, not even the LF SKU seed.
  const r1 = run({ confirmed: false, cache: {} });
  ok(r1.set.length === 0 && r1.setObj.length === 0,
    'FAILED load + empty cache → seeds NOTHING (the data-loss hole, closed)');

  const r2 = run({ ready: false, cache: {} });
  ok(r2.set.length === 0 && r2.setObj.length === 0,
    'not firestore-ready → seeds nothing (pre-existing guard intact)');

  // Production shape: server answered, data present → untouched.
  const r3 = run({ cache: { settings: { seeded: true }, lf_skus: [{ id: 'x' }], ac: [{ id: 'a' }] } });
  ok(r3.set.length === 0 && r3.setObj.length === 0,
    'confirmed load + real data → seeds nothing');

  // Genuine first run: server answered "empty" → full seed still works.
  const r4 = run({ cache: {} });
  ok(r4.set.includes('lf_skus') && r4.set.includes('ac') && r4.set.includes('pr')
     && r4.setObj.includes('settings') && r4.setObj.includes('costs'),
    'confirmed-EMPTY database → first-run seed still happens');

  // Settings exist but unseeded → only the seeded flag is stamped.
  const r5 = run({ cache: { settings: { company: 'purpl' }, lf_skus: [{ id: 'x' }] } });
  ok(r5.set.length === 0 && r5.setObj.length === 1 && r5.setObj[0] === 'settings',
    'existing unseeded settings → marked seeded, nothing else written');

  // Gate F1 (v252): restoreMyData — the OTHER boot writer (hardcoded account
  // restorer from the March 2026 incident) — carries the identical guard, in
  // the right order (after _firestoreReady, before the data_restored check
  // that reads the possibly-unloaded settings cache).
  const rmd = slc(src, 'function restoreMyData()', 'const mkId');
  ok(rmd.includes('if (!DB._loadConfirmed) return;'),
    'restoreMyData refuses to run after a failed boot read (gate F1)');
  ok(rmd.indexOf('_firestoreReady') < rmd.indexOf('_loadConfirmed')
     && rmd.indexOf('_loadConfirmed') < rmd.indexOf('data_restored'),
    'guard ordered before the cache-reading restored-flag check');
}

console.log('[C] places.js loader — static contracts');
{
  ok(/v=quarterly&loading=async&libraries=places/.test(plSrc),
    'CRM loader pinned to quarterly channel with async loading');
  ok(/setTimeout\(\(\) => fail\('timeout'\), 10000\)/.test(plSrc),
    'a hung request fails after 10s instead of pending forever');
  ok(/const fail = \(why\) => \{[\s\S]{0,400}_loading = null;/.test(plSrc),
    'every failure clears the cached promise so the next call retries fresh');
  ok(/if \(settled\) return;/.test(plSrc) && plSrc.includes('clearTimeout(timer)'),
    'success/failure settle exactly once and cancel the timer');
  ok(plSrc.includes("window.addEventListener('online'"),
    'coming back online triggers a retry');
  ok(/_autoRetries >= 3\) return;/.test(plSrc),
    'self-heal retries are bounded (a dead key cannot loop forever)');
  ok(plSrc.includes('window.gm_authFailure'),
    'key/billing/referrer failures surface a toast instead of dying silently');
  ok(/_autoRetries = 0;[\s\S]{0,80}resolve\(true\)/.test(plSrc),
    'a successful load resets the retry budget');
  ok(/v=quarterly&loading=async/.test(fuSrc),
    'find-us.html public-map loader pinned too');
}

console.log('[D] places.js loader — run the REAL loader against stubs');
{
  // Evaluate the whole IIFE with a controllable environment.
  const mk = () => {
    const env = {
      scripts: [], timers: [], listeners: {},
      window: null, document: null,
    };
    env.window = {
      GOOGLE_PLACES_KEY: 'test-key',
      addEventListener: (ev, fn) => { env.listeners[ev] = fn; },
    };
    env.document = {
      createElement: () => {
        const s = { removed: false, remove() { this.removed = true; } };
        return s;
      },
      head: { appendChild: (s) => env.scripts.push(s) },
      getElementById: () => null,
    };
    const timers = env.timers;
    const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    const fakeClearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
    new Function('window', 'document', 'setTimeout', 'clearTimeout',
      plSrc)(env.window, env.document, fakeSetTimeout, fakeClearTimeout);
    return env;
  };

  (async () => {
    // Hung request: fire the 10s timer → promise resolves false, and the NEXT
    // load() starts a brand-new script (the page-reload ritual is dead).
    const e1 = mk();
    const p1 = e1.window.PlacesAC.load();
    ok(e1.scripts.length === 1, 'load() appends the Maps script');
    const hangTimer = e1.timers.find(t => t.ms === 10000 && !t.cleared);
    ok(!!hangTimer, '10s watchdog armed');
    hangTimer.fn();
    ok(await p1 === false, 'hung load resolves false instead of pending forever');
    ok(e1.scripts[0].removed === true, 'dead script tag removed');
    // Gate F2 (v252): the timed-out script can still EXECUTE late (removing
    // the tag doesn't abort the fetch). The late callback hits the settled
    // closure, which must record the live API — and the next load() must NOT
    // inject a second Maps copy.
    e1.window.__purplPlacesReady();
    ok(await e1.window.PlacesAC.load() === true && e1.scripts.length === 1,
      'late execution after timeout → recorded as loaded, NO second include (gate F2)');

    // Without a late arrival, the next load() retries with a fresh script.
    const e1b = mk();
    const p1c = e1b.window.PlacesAC.load();
    e1b.timers.find(t => t.ms === 10000 && !t.cleared).fn();
    await p1c;
    e1b.window.PlacesAC.load();
    ok(e1b.scripts.length === 2, 'no late arrival → the very next load() retries with a fresh script');

    // Script loads and callback fires: resolves true, watchdog cancelled,
    // later loads are satisfied from cache (no second script).
    const e2 = mk();
    const p2 = e2.window.PlacesAC.load();
    e2.window.__purplPlacesReady();
    ok(await p2 === true, 'ready-callback resolves true');
    const w2 = e2.timers.find(t => t.ms === 10000);
    ok(w2 && w2.cleared === true, 'watchdog cancelled on success');
    e2.window.PlacesAC.load();
    ok(e2.scripts.length === 1, 'loaded state cached — no duplicate script');

    // Gate F2 (v252): a page where Google Maps is ALREADY live short-circuits
    // entirely — load() never injects a duplicate copy.
    const e4 = mk();
    e4.window.google = { maps: { places: {} } };
    ok(await e4.window.PlacesAC.load() === true && e4.scripts.length === 0,
      'API already present → load() returns true without injecting anything (gate F2)');

    // network onerror: same recovery as timeout.
    const e3 = mk();
    const p3 = e3.window.PlacesAC.load();
    e3.scripts[0].onerror();
    ok(await p3 === false && e3.scripts[0].removed, 'onerror fails cleanly');
    // back-online handler exists and schedules a retry attempt.
    ok(typeof e3.listeners.online === 'function', 'online listener registered');
    e3.listeners.online();
    ok(e3.timers.some(t => t.ms === 500), 'back-online schedules an immediate retry');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
