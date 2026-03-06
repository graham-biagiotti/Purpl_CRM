// ═══════════════════════════════════════════════════════
//  db.js  —  Firebase-backed data layer for purpl CRM
//
//  Strategy: load-all-on-start cache
//  • On startup, all Firestore collections are loaded into
//    memory (_cache). Reads are instant (synchronous).
//  • Writes update _cache immediately and persist to
//    Firestore in the background (fire-and-forget).
//  • Firebase's IndexedDB layer handles offline — data is
//    available even with no signal.
// ═══════════════════════════════════════════════════════

// Collections stored as arrays in Firestore as single docs
// (small dataset, single user — simplest possible approach)
const ARRAY_KEYS = [
  'ac','pr','iv','ord','orders','inv_log_v2',
  'prod_hist','prod_sched','shipments','dist',
  'rem','pack_types','runs',
  // Phase 4 — Distributors
  'dist_profiles',   // distributor profiles
  'dist_reps',       // sales reps per distributor
  'dist_pricing',    // SKU pricing per distributor
  'dist_pos',        // purchase orders from distributors
  'dist_invoices',   // invoices sent to distributors
  'dist_chains',     // store/chain coverage per distributor
  'dist_imports',    // imported order records (CSV/webhook)
  // Phase 6 — Reports
  'saved_reports',   // saved report configurations
  // Phase 7 — Inventory
  'loose_cans',      // raw can receipts (pre-pack)
  'repack_jobs',     // loose cans → finished packs conversion jobs
  'pallets',         // pallet tracking records
  'pack_supply',     // packaging supplies (labels, cartons, films, etc.)
];
// Collections stored as plain objects (settings, costs, today_run)
const OBJ_KEYS = ['settings','costs','today_run'];

const DB = {
  _cache: {},
  _uid: null,
  _db: null,
  _syncStatus: 'synced', // 'synced' | 'syncing' | 'error'

  // ── Init ────────────────────────────────────────────
  async init(uid, firestoreDb) {
    this._uid = uid;
    this._db = firestoreDb;
    await this._loadAll();
    this._updateSyncUI('synced');
  },

  // ── Load all data from Firestore into memory ────────
  async _loadAll() {
    const { doc, getDoc, setDoc } = window.FirestoreAPI;
    const ref = doc(this._db, 'workspace', 'main', 'data', 'store');
    try {
      let snap = await getDoc(ref);
      // One-time migration: copy existing user data to shared workspace
      if (!snap.exists() && this._uid) {
        const oldRef = doc(this._db, 'users', this._uid, 'data', 'store');
        const oldSnap = await getDoc(oldRef);
        if (oldSnap.exists()) {
          await setDoc(ref, oldSnap.data());
          snap = await getDoc(ref);
        }
      }
      if (snap.exists()) {
        const data = snap.data();
        ARRAY_KEYS.forEach(k => {
          this._cache[k] = Array.isArray(data[k]) ? data[k] : [];
        });
        OBJ_KEYS.forEach(k => {
          this._cache[k] = data[k] || null;
        });
      } else {
        // First time user — initialize empty
        ARRAY_KEYS.forEach(k => this._cache[k] = []);
        OBJ_KEYS.forEach(k => this._cache[k] = null);
      }
    } catch(e) {
      console.warn('Firestore load failed, using cached/empty data:', e);
      ARRAY_KEYS.forEach(k => { if(!this._cache[k]) this._cache[k] = []; });
      OBJ_KEYS.forEach(k => { if(!this._cache[k]) this._cache[k] = null; });
    }
  },

  // ── Persist to Firestore (fire-and-forget) ──────────
  _save() {
    if (!this._uid || !this._db) return;
    this._updateSyncUI('syncing');
    const { doc, setDoc } = window.FirestoreAPI;
    const ref = doc(this._db, 'workspace', 'main', 'data', 'store');
    const payload = {};
    ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
    setDoc(ref, payload)
      .then(() => this._updateSyncUI('synced'))
      .catch(e => { console.error('Firestore save error:', e); this._updateSyncUI('error'); });
  },

  _updateSyncUI(status) {
    this._syncStatus = status;
    const dot = document.getElementById('sync-dot');
    const label = document.getElementById('sync-label');
    if (!dot || !label) return;
    dot.className = 'sync-dot ' + status;
    label.textContent = status === 'synced' ? 'Saved' : status === 'syncing' ? 'Saving…' : 'Sync error';
  },

  // ── Public API (mirrors old localStorage DB object) ─
  get(k) { return this._cache[k] || []; },
  set(k, v) { this._cache[k] = v; this._save(); },
  obj(k, def = {}) { return this._cache[k] || def; },
  setObj(k, v) { this._cache[k] = v; this._save(); },
  a(k) { return this.get(k); },
  push(k, v) { const a = this.a(k); a.push(v); this.set(k, a); },
  update(k, id, fn) {
    const a = this.a(k);
    const i = a.findIndex(x => x.id === id);
    if (i >= 0) { a[i] = fn(a[i]); this.set(k, a); }
  },
  remove(k, id) { this.set(k, this.a(k).filter(x => x.id !== id)); },

  // ── Import from localStorage (one-time migration) ───
  async importFromLocalStorage() {
    const PFX = 'pcrm5_';
    let imported = 0;
    ARRAY_KEYS.forEach(k => {
      try {
        const raw = localStorage.getItem(PFX + k);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) {
            this._cache[k] = parsed;
            imported += parsed.length;
          }
        }
      } catch(e) {}
    });
    OBJ_KEYS.forEach(k => {
      try {
        const raw = localStorage.getItem(PFX + k);
        if (raw) { this._cache[k] = JSON.parse(raw); }
      } catch(e) {}
    });
    if (imported > 0) {
      await this._forceSave();
    }
    return imported;
  },

  async _forceSave() {
    const { doc, setDoc } = window.FirestoreAPI;
    const ref = doc(this._db, 'workspace', 'main', 'data', 'store');
    const payload = {};
    ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
    await setDoc(ref, payload);
  }
};
