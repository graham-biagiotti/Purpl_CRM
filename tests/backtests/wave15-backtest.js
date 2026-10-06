// Wave 15 backtests — TS1 resilience (v238).
// Covers: db.js listener terminal-death auto-resubscribe + "Live sync lost"
// surface; field.html hardening (confirmed-negative role gate, persistence-
// failure warnings, unsent-entry age bar, field listener resub); places.js
// loader retry; nav() markClean + dialog-cancel routing.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '../../public/style.css'), 'utf8');
const fieldSrc = fs.readFileSync(path.join(__dirname, '../../public/field.html'), 'utf8');
const placesSrc = fs.readFileSync(path.join(__dirname, '../../public/places.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(__dirname, '../../public/auth.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('[A] structural — db.js listener resilience');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  ok(dbSrc.includes('_listenerDied(') && dbSrc.includes('_listenerAlive(') && dbSrc.includes('_resubDeadNow('),
    'listener-health machinery exists (died/alive/rescue)');
  // BOTH error handlers route to _listenerDied — a console.warn-only handler
  // is the original bug (probe4: tab silently stale forever).
  ok((dbSrc.match(/this\._listenerDied\(/g) || []).length >= 2,
    'collection AND config error handlers call _listenerDied');
  ok(!/err => \{\s*console\.warn\(`\[db\] Snapshot error/.test(dbSrc),
    'no warn-only snapshot error handler remains');
  const died = slc(dbSrc, '_listenerDied(key, err) {', '\n  },');
  ok(/Math\.min\(60000,/.test(died), 'resubscribe backoff capped at 60s');
  ok(died.includes('this._deadListeners.add(key)') && died.includes('_updateSyncUI'),
    'death marks the stream dead and repaints the sync indicator');
  const alive = slc(dbSrc, '_listenerAlive(key, fromCache) {', '\n  },');
  ok(alive.includes('this._listenerRetries[key] = 0'), 'a delivered snapshot resets the backoff');
  ok(/deadListeners\.delete\(key\)[\s\S]{0,120}Live sync restored/.test(alive),
    'full recovery announces itself');
  // Gate fix [1]: with IndexedDB persistence every (re)listen raises an
  // initial FROM-CACHE snapshot before the server answers — healing on it
  // defeated the backoff (permanent 2s loop) and flickered "Saved" mid-outage.
  ok(/if \(fromCache\) return;/.test(alive), "only a SERVER snapshot heals (gate [1]: from-cache can't)");
  ok((dbSrc.match(/_listenerAlive\((?:key|'__config__'), !!\(snap\.metadata && snap\.metadata\.fromCache\)\)/g) || []).length === 2,
    'both listeners pass the snapshot origin into _listenerAlive');
  // Gate fix [2]: sign-out teardown.
  ok(dbSrc.includes('_teardownListeners()') && /_firestoreReady = false/.test(slc(dbSrc, '_teardownListeners() {', '\n  },')),
    'teardown exists and parks the data layer (gate [2])');
  ok(authSrc.includes('DB._teardownListeners()'),
    'auth.js sign-out branch tears the listeners down (gate [2])');
  // Gate fix [4]: first server snapshot after a resubscribe full-replaces.
  ok(/_resubPending[\s\S]{0,40}\[key\] = true/.test(slc(dbSrc, '_resubscribe(key) {', '\n  },')),
    'resubscribe arms the full-apply flag (gate [4])');
  ok(/_resubPending && this\._resubPending\[key\] && !\(snap\.metadata && snap\.metadata\.fromCache\)/.test(dbSrc),
    'full-apply consumes only a SERVER snapshot (gate [4])');
  // The redrive (online/visibility/heartbeat) also rescues dead listeners now.
  const wire = slc(dbSrc, 'if (!this._onlineWired)', '\n    }\n');
  ok(wire.includes('this._resubDeadNow()'), 'focus/online/heartbeat redrive fires pending resubscribes immediately');
  const ui = slc(dbSrc, '_updateSyncUI(status) {', '\n  },');
  ok(/_deadListeners\.size && status !== 'error'/.test(ui),
    "dead listeners override happy states in the sync UI (failed WRITE 'error' still wins)");
  ok(ui.includes('Live sync lost'), 'stale state labeled "Live sync lost"');
  ok(cssSrc.includes('.sync-dot.stale'), 'style.css styles the stale dot');
  // Wave-10 contract intact: listener bodies (with their defer guards) still
  // live between _subscribeAll and _scheduleRefresh's definition.
  const dbCode = dbSrc.replace(/\/\/[^\n]*/g, '');
  const sub = dbCode.slice(dbCode.indexOf('_subscribeAll'), dbCode.indexOf('_scheduleRefresh() {'));
  ok(/this\._dirtyIds\[key\] && this\._dirtyIds\[key\]\.size/.test(sub),
    'wave10 G3 guard still inside the listener slice after the refactor');
}

console.log('[A2] structural — field.html hardening');
{
  const script = slc(fieldSrc, '<script>\n(function', '</script>');
  // 1. Role gate: sign out ONLY on a confirmed negative, never on a failed read.
  ok(/roleKnown && !\['field', 'employee', 'admin'\]\.includes\(role\)/.test(script),
    'role gate requires a CONFIRMED negative before signing out');
  ok(script.includes("get({ source: 'cache' })"), 'failed server role-read falls back to cache');
  ok(/if \(!roleKnown\) toast\(/.test(script), 'unverifiable role continues WITH a notice, not a sign-out');
  // 2. Persistence failure surfaced.
  ok(/persistenceOk = false; persistFailCode/.test(script), 'enablePersistence failure captured, not swallowed');
  ok(script.includes('failed-precondition'), 'two-tabs case gets its own explanation');
  ok(/persistenceOk\s*\?\s*'Saved on your phone/.test(script),
    'offline submit toast is honest when there is no offline queue');
  ok(/persistenceOk\s*[\s\S]{0,80}No signal — entries save on your phone/.test(script),
    'offline bar message downgraded when persistence is off');
  // 3. Unsent-entry age bar.
  ok(fieldSrc.includes('id="pending-bar"'), 'pending bar element exists');
  ok(/function renderPendingBar\(\)/.test(script) && /ageMin < 10/.test(script),
    'pending bar renders for entries unsent > 10 min');
  ok(/setInterval\(renderPendingBar, 60000\)/.test(script), 'pending bar re-evaluated every minute');
  ok(/renderPendingBar\(\);[\s\S]{0,200}if \(openEntryId\)/.test(script),
    'pending bar refreshes on every snapshot, even with a detail card open');
  // 4. Field log listener resubscribes on terminal error — but never for a
  // signed-out/replaced user (gate [3]).
  ok(/auth\.currentUser && auth\.currentUser\.uid === me\.uid\) listenMyLogs\(\)/.test(script),
    'field log resubscribe is gated on the SAME still-signed-in user (gate [3])');
  ok(/me = null; myLogs = \[\];/.test(script) && /clearTimeout\(window\._logsResub\)/.test(script),
    'sign-out clears me/myLogs and the pending resub timer (gate [3])');
  ok(/if \(pb\) pb\.style\.display = 'none'/.test(script), 'sign-out hides the pending bar (gate [3])');
  // Gate [5]: the persistence warning also fires from the catch when the
  // auth callback already ran (restored-session race).
  ok(/if \(me\) warnPersistence\(\)/.test(script), 'persistence warning survives the auth/catch race (gate [5])');
  // Gate [8]: pending age from the latest touch, not original creation.
  ok(/new Date\(l\.updatedAt \|\| l\.createdAt\)/.test(script), 'pending age uses updatedAt||createdAt (gate [8])');
}

console.log('[A3] structural — app.js nav + places loader');
{
  const navFn = slc(src, 'function nav(page) {', '\nconst renders = {');
  ok(navFn.includes('DB.markClean()'), 'nav() clears the dirty flag it used to strand');
  ok(navFn.includes("o.id === 'modal-dlg'") && navFn.includes('dlg-cancel'),
    'nav() routes the shared dialog through Cancel (promise always resolves)');
  ok(/onerror[\s\S]{0,700}_loading = null/.test(placesSrc),
    'places loader clears the cached promise on failure so the next call retries');
  ok(/_loading = null;[\s\S]{0,120}s\.remove\(\)/.test(placesSrc), 'failed script tag removed');
}

console.log('[B] dynamic — listener lifecycle (stubbed Firestore)');
function makeDB() {
  const subs = [];
  const ui = { dot: { className: 'sync-dot synced' }, label: { textContent: 'Saved' } };
  const toasts = [];
  const mkSub = (pathStr) => (onNext, onErr) => {
    const s = { path: pathStr, onNext, onErr, unsubbed: false };
    subs.push(s);
    return () => { s.unsubbed = true; };
  };
  const window = {
    FirestoreAPI: {
      doc: () => ({ __cfg: true }),
      getDoc: () => Promise.resolve({ exists: false }),
      setDoc: () => Promise.resolve(),
      onSnapshot: (ref, onNext, onErr) => mkSub('__config__')(onNext, onErr),
    },
    addEventListener: () => {},
    toast: (m) => toasts.push(m),
  };
  const document = {
    getElementById: (id) => id === 'sync-dot' ? ui.dot : id === 'sync-label' ? ui.label : null,
    querySelectorAll: () => [], addEventListener: () => {},
  };
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const toast = window.toast;
  const DB = new Function('window', 'document', 'localStorage', 'toast', dbSrc + '\n;return DB;')(
    window, document, localStorage, toast);
  DB._db = {
    collection: (p) => ({
      onSnapshot: mkSub(p),
      doc: () => ({ set: () => Promise.resolve(), delete: () => Promise.resolve() }),
      get: () => Promise.resolve({ docs: [] }),
    }),
    batch: () => ({ set() {}, delete() {}, commit: () => Promise.resolve() }),
  };
  DB._firestoreReady = true;
  return { DB, subs, ui, toasts };
}
const liveSnap = { docChanges: () => [], docs: [], metadata: {} };
(async () => {
  // B1: terminal error → dead, stale UI, resub scheduled
  const { DB, subs, ui, toasts } = makeDB();
  DB._subscribeAll();
  const acSub = subs.find(s => s.path === 'workspace/main/ac');
  ok(!!acSub && subs.some(s => s.path === '__config__'), 'B1: all streams subscribed (collections + config)');
  acSub.onErr({ code: 'permission-denied', message: 'denied' });
  ok(DB._deadListeners.has('ac'), 'B1: terminal error marks the stream dead');
  ok(ui.label.textContent.includes('Live sync lost') && ui.dot.className === 'sync-dot stale',
    'B1: sync indicator flips to Live sync lost');
  ok(!!DB._resubTimers['ac'], 'B1: resubscribe timer scheduled');
  // A save completing while dead must NOT repaint "Saved"
  DB._updateSyncUI('synced');
  ok(ui.label.textContent.includes('Live sync lost'), 'B1: a successful save cannot mask a dead stream');
  DB._updateSyncUI('error');
  ok(ui.label.textContent === 'Sync error', "B1: a failed WRITE ('error') still wins the indicator");
  DB._updateSyncUI('synced'); // back to masked-stale for B2

  // B2: backoff fires → old stream torn down, new subscription created
  await sleep(2300); // first retry = 2000ms
  const acSubs = subs.filter(s => s.path === 'workspace/main/ac');
  ok(acSubs.length === 2 && acSub.unsubbed, 'B2: backoff resubscribed (old stream unsubscribed, new one live)');

  // B3: snapshot delivery heals — dead cleared, UI repainted, announced
  acSubs[1].onNext(liveSnap);
  ok(!DB._deadListeners.has('ac'), 'B3: delivered snapshot clears the dead mark');
  ok(ui.label.textContent === 'Saved', 'B3: indicator repaints to the real status');
  ok(toasts.some(t => t.includes('Live sync restored')), 'B3: recovery announced');
  ok(DB._listenerRetries['ac'] === 0, 'B3: backoff reset for the healed stream');

  // B4: config stream + immediate rescue path (_resubDeadNow, no backoff wait)
  const cfg0 = subs.filter(s => s.path === '__config__').pop();
  cfg0.onErr({ code: 'unavailable', message: 'transport broke' });
  ok(DB._deadListeners.has('__config__'), 'B4: config stream death tracked under __config__');
  DB._resubDeadNow();
  const cfgSubs = subs.filter(s => s.path === '__config__');
  ok(cfgSubs.length === 2 && cfg0.unsubbed, 'B4: focus/heartbeat rescue resubscribes immediately');
  ok(!DB._resubTimers['__config__'], 'B4: pending backoff timer cancelled by the rescue');
  cfgSubs[1].onNext({ metadata: {}, exists: false, data: () => ({}) });
  ok(DB._deadListeners.size === 0, 'B4: config snapshot heals the last dead stream');

  // B5 (gate [1]): a FROM-CACHE snapshot must not heal, must not reset the
  // backoff, and must not consume the full-apply flag — with IndexedDB
  // persistence the SDK raises one on every (re)listen before the server
  // answers, so healing on it meant a permanent 2s resubscribe loop and a
  // flickering "Saved" during the outage. (Contract update: the original B5
  // only timed its own synchronous calls — vacuous, gate-caught; this one
  // measures real backoff growth across the timers.)
  const ac1 = subs.filter(s => s.path === 'workspace/main/ac').pop();
  const restoredBefore = toasts.filter(t => t.includes('Live sync restored')).length;
  ac1.onErr({ code: 'permission-denied' });
  ok(DB._deadListeners.has('ac') && DB._listenerRetries['ac'] === 1, 'B5: failure marks dead (n=1)');
  await sleep(2300); // first backoff = 2s
  const ac2 = subs.filter(s => s.path === 'workspace/main/ac').pop();
  ok(ac2 !== ac1, 'B5: 2s backoff resubscribed');
  ac2.onNext({ docChanges: () => [], docs: [], metadata: { fromCache: true } });
  ok(DB._deadListeners.has('ac'), 'B5: from-cache snapshot does NOT heal a dead stream');
  ok(DB._listenerRetries['ac'] === 1, 'B5: from-cache snapshot does NOT reset the backoff');
  ok(DB._resubPending['ac'] === true, 'B5: from-cache snapshot does NOT consume the full-apply flag');
  ok(toasts.filter(t => t.includes('Live sync restored')).length === restoredBefore,
    'B5: no spurious restored toast on the cache flicker');
  ok(ui.label.textContent.includes('Live sync lost'), 'B5: indicator stays honest through the cache flicker');
  ac2.onErr({ code: 'permission-denied' }); // n=2 → 4s delay
  const nAc = subs.filter(s => s.path === 'workspace/main/ac').length;
  await sleep(2500);
  ok(subs.filter(s => s.path === 'workspace/main/ac').length === nAc,
    'B5: second delay GREW past 2s — the backoff survives cache snapshots');
  await sleep(2200); // ≥4s total
  const ac3 = subs.filter(s => s.path === 'workspace/main/ac').pop();
  ok(ac3 !== ac2, 'B5: 4s backoff resubscribed');

  // B6 (gate [4]): the first SERVER snapshot after a resubscribe replaces the
  // cache wholesale — a collection emptied remotely during the outage raises
  // zero docChanges when nothing cached backs the query and would otherwise
  // keep its stale rows until reload.
  DB._cache.ac = [{ id: 'ghost', name: 'deleted-remotely-during-outage' }];
  ac3.onNext({ docChanges: () => [], docs: [], metadata: { fromCache: false } });
  ok(DB._deadListeners.size === 0, 'B6: server snapshot heals the stream');
  ok(Array.isArray(DB._cache.ac) && DB._cache.ac.length === 0,
    'B6: stale ghost rows replaced by the server view');
  ok(DB._resubPending['ac'] === false, 'B6: full-apply flag consumed');

  // B7 (gate [2]): sign-out teardown stops the whole machine.
  ac3.onErr({ code: 'permission-denied' }); // leave a dead stream + pending timer behind
  DB._teardownListeners();
  ok(subs.every(s => s.unsubbed), 'B7: teardown unsubscribes every stream');
  ok(DB._deadListeners.size === 0 && Object.keys(DB._resubTimers).length === 0,
    'B7: dead set and resub timers cleared');
  ok(DB._firestoreReady === false, 'B7: data layer parked until the next sign-in');
  await sleep(2300);
  ok(subs.every(s => s.unsubbed), 'B7: no resubscribe fires after teardown');

  console.log('[C] dynamic — places loader retry');
  {
    const scripts = [];
    const win = { GOOGLE_PLACES_KEY: 'TESTKEY' };
    const doc = {
      createElement: () => { const s = { remove() { s.removed = true; } }; scripts.push(s); return s; },
      head: { appendChild: () => {} },
      getElementById: () => null,
    };
    new Function('window', 'document', 'console', placesSrc)(win, doc, console);
    const p1 = win.PlacesAC.load();
    ok(scripts.length === 1, 'C1: first load() injects the script');
    scripts[0].onerror();
    ok((await p1) === false, 'C1: failed load resolves false (callers degrade gracefully)');
    ok(scripts[0].removed, 'C1: dead script tag removed');
    const p2 = win.PlacesAC.load();
    ok(scripts.length === 2, 'C2: next load() RETRIES instead of returning the cached failure');
    win.__purplPlacesReady();
    ok((await p2) === true, 'C2: retry succeeds');
    await win.PlacesAC.load();
    ok(scripts.length === 2, 'C3: once loaded, no further script injections');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
