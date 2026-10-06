// Two-client Firestore-emulator harness for public/db.js (compat SDK).
// makeClient(name)  -> { app, db }  compat firestore wired to 127.0.0.1:8686
// loadDB(db, opts)  -> DB object from public/db.js, running against that client
'use strict';
const fs = require('fs');
const path = require('path');
const firebase = require('firebase/compat/app').default || require('firebase/compat/app');
require('firebase/compat/firestore');

const DB_JS = path.resolve(process.env.DB_SRC || path.join(__dirname, '../../public/db.js'));
const CFG = { projectId: 'demo-purpl', apiKey: 'fake', appId: 'fake' };

function makeClient(name) {
  const app = firebase.initializeApp(CFG, name);
  const db = app.firestore();
  db.useEmulator('127.0.0.1', 8686);
  return { app, db };
}

function makeEnv() {
  const toasts = [];
  const localStore = {};
  const localStorage = {
    getItem: (k) => (k in localStore ? localStore[k] : null),
    setItem: (k, v) => { localStore[k] = String(v); },
    removeItem: (k) => { delete localStore[k]; },
  };
  const document = {
    getElementById: () => null,
    addEventListener: () => {},
    visibilityState: 'visible',
  };
  const window = {
    addEventListener: () => {},
    toast: (msg) => { toasts.push(msg); },
  };
  const toast = window.toast;
  return { window, document, localStorage, toast, toasts, localStore };
}

// Evaluate db.js with stubs; returns {DB, env}
function loadDB(compatDb, { uid = 'test-user' } = {}) {
  const env = makeEnv();
  const src = fs.readFileSync(DB_JS, 'utf8');
  // db.js expects window.FirestoreAPI shims (see index.html:3125)
  env.window.FirestoreAPI = {
    getFirestore: (app) => app.firestore(),
    enableIndexedDbPersistence: (db) => db.enablePersistence(),
    doc: (db, ...p) => db.doc(p.join('/')),
    getDoc: (ref) => ref.get(),
    setDoc: (ref, d, opts) => ref.set(d, opts || {}),
    onSnapshot: (ref, ...args) => ref.onSnapshot(...args),
  };
  const factory = new Function(
    'window', 'document', 'localStorage', 'toast', 'setInterval', 'setTimeout', 'clearTimeout', 'console',
    src + '\nreturn DB;'
  );
  const DB = factory(env.window, env.document, env.localStorage, env.toast,
    setInterval, setTimeout, clearTimeout, console);
  DB.__env = env;
  DB.__init = () => DB.init(uid, compatDb);
  return DB;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed the workspace so DB.init skips migration paths.
async function seed(db, { ac = [] } = {}) {
  await db.doc('workspace/main/config/main').set({ _dbVersion: 2, quick_notes: [], settings: { seeded: true } });
  for (const item of ac) await db.doc('workspace/main/ac/' + item.id).set(item);
}

module.exports = { firebase, makeClient, loadDB, seed, sleep };
