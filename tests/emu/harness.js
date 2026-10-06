// Two-client multiuser harness: loads the REAL public/db.js against the
// Firestore emulator. Each client gets its own Firebase app instance (own
// local mutation queue → genuine hasPendingWrites semantics) and its own
// window/localStorage/document stubs, created by shadowing those globals in
// the eval scope that runs db.js — no cross-realm objects anywhere.
// (Recreated into the repo 2026-10-06 after a scratchpad wipe; identical to
// the harness that verified v231-v236. Override the db.js under test with
// env DB_SRC.)
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, deleteDoc,
  collection, getDocs, getDocsFromServer, onSnapshot, writeBatch,
} = require('firebase/firestore');

const DB_JS_PATH = process.env.DB_SRC || path.join(__dirname, '../../public/db.js');
const EMU_HOST = '127.0.0.1', EMU_PORT = 8686, PROJECT = 'demo-purpl';

let appCount = 0;
function rawFirestore(name) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, name || ('app' + (++appCount)));
  const f = getFirestore(app);
  connectFirestoreEmulator(f, EMU_HOST, EMU_PORT);
  return f;
}

// ── Compat adapter: the exact surface db.js + index.html's FirestoreAPI use ──
function wrapDocSnap(s) {
  return {
    get exists() { return s.exists(); },
    id: s.id,
    data: () => s.data(),
    metadata: s.metadata,
  };
}
function wrapQuerySnap(s) {
  return {
    docs: s.docs.map(wrapDocSnap),
    metadata: s.metadata,
    docChanges: () => s.docChanges().map(c => ({ type: c.type, doc: wrapDocSnap(c.doc) })),
  };
}
function wrapDocRef(ref) {
  return {
    _ref: ref,
    id: ref.id,
    get: () => getDoc(ref).then(wrapDocSnap),
    set: (data, opts) => setDoc(ref, JSON.parse(JSON.stringify(data)), opts || {}),
    delete: () => deleteDoc(ref),
    onSnapshot: (cb, errCb) => onSnapshot(ref, s => cb(wrapDocSnap(s)), errCb),
  };
}
function wrapCollRef(f, p) {
  const ref = collection(f, p);
  return {
    doc: (id) => wrapDocRef(doc(f, p + '/' + id)),
    get: () => getDocs(ref).then(wrapQuerySnap),
    onSnapshot: (cb, errCb) => onSnapshot(ref, s => cb(wrapQuerySnap(s)), errCb),
  };
}
function compatDb(f) {
  return {
    _fs: f,
    collection: (p) => wrapCollRef(f, p),
    batch: () => {
      const b = writeBatch(f);
      return {
        set: (dw, data, opts) => b.set(dw._ref, JSON.parse(JSON.stringify(data)), opts || {}),
        delete: (dw) => b.delete(dw._ref),
        commit: () => b.commit(),
      };
    },
  };
}
function makeFirestoreAPI() {
  // Mirrors index.html's window.FirestoreAPI shims exactly.
  return {
    doc: (dbw, ...p) => wrapDocRef(doc(dbw._fs, p.join('/'))),
    getDoc: (ref) => ref.get(),
    setDoc: (ref, d, opts) => ref.set(d, opts || {}),
    onSnapshot: (ref, ...args) => ref.onSnapshot(...args),
  };
}

// ── Client factory: evaluates the real db.js with shadowed globals ──
function makeClient(name) {
  const f = rawFirestore(name);
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const window = {
    FirestoreAPI: makeFirestoreAPI(),
    addEventListener: () => {},
    toast: undefined,
    refreshCurrentPage: undefined,
  };
  const document = { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const toast = undefined; void toast; void document; void localStorage; void window;
  // Direct eval: db.js sees the shadowed window/localStorage/document above.
  const DB = eval(fs.readFileSync(DB_JS_PATH, 'utf8') + '\n;DB');
  return { DB, fs: f, compat: compatDb(f), window, localStorage, name };
}

// ── Server-truth helpers (separate observer app, always reads from server) ──
const obs = rawFirestore('observer');
async function serverCol(key) {
  const s = await getDocsFromServer(collection(obs, 'workspace/main/' + key));
  const out = {};
  s.docs.forEach(d => { out[d.id] = d.data(); });
  return out;
}
async function serverConfig() {
  const s = await getDoc(doc(obs, 'workspace/main/config/main'));
  return s.exists() ? s.data() : null;
}
async function seed(config, cols) {
  await setDoc(doc(obs, 'workspace/main/config/main'), config);
  for (const [key, docs] of Object.entries(cols || {})) {
    for (const d of docs) await setDoc(doc(obs, `workspace/main/${key}/${d.id}`), d);
  }
}
async function wipe() {
  // Emulator REST wipe of the whole project
  const http = require('http');
  await new Promise((res, rej) => {
    const req = http.request({
      host: EMU_HOST, port: EMU_PORT, method: 'DELETE',
      path: `/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    }, r => { r.resume(); r.on('end', res); });
    req.on('error', rej); req.end();
  });
}

// Watch a collection from the observer and record every remote change event.
function watchChanges(key) {
  const events = [];
  const unsub = onSnapshot(collection(obs, 'workspace/main/' + key), s => {
    s.docChanges().forEach(c => events.push({ type: c.type, id: c.doc.id, data: c.doc.data() }));
  });
  return { events, unsub };
}
function watchConfig() {
  const events = [];
  const unsub = onSnapshot(doc(obs, 'workspace/main/config/main'), s => {
    events.push(s.exists() ? s.data() : null);
  });
  return { events, unsub };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

module.exports = { makeClient, serverCol, serverConfig, seed, wipe, watchChanges, watchConfig, sleep, until };
