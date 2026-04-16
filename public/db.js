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

// Superset of all array keys across every branch/version.
// Keys not yet populated in Firestore will default to [].
// Using {merge:true} on saves ensures we never delete keys
// that exist in Firestore but aren't in this list.
const ARRAY_KEYS = [
  'ac','pr','iv','ord','orders','inv_log_v2',
  'prod_hist','prod_sched','shipments','dist',
  'rem','pack_types','runs',
  // Phase 4 — Distributors
  'dist_profiles',
  'dist_reps',
  'dist_pricing',
  'dist_pos',
  'dist_invoices',
  'dist_chains',
  'dist_imports',
  // Phase 6 — Reports
  'saved_reports',
  // Phase 7 — Inventory
  'loose_cans',
  'repack_jobs',
  'pallets',
  'pack_supply',
  // UX Phase 2 — Dashboard Quick Notes
  'quick_notes',
  // UX Phase 5 — Inventory Locations
  'stock_locations',
  'stock_transfers',
  // Lavender Fields
  'lf_skus',
  'lf_invoices',
  'lf_wix_deductions',
  'retail_invoices',
  'combined_invoices',
  'pending_invoices',
  'returns',
  // Audit
  'audit_log',
];

// Superset of all object keys across every branch/version.
const OBJ_KEYS = ['settings','costs','today_run','invoice_settings','api_settings'];

const DB = {
  _cache: {},
  _uid: null,
  _db: null,
  _syncStatus: 'synced', // 'synced' | 'syncing' | 'error'
  _firestoreReady: false,
  _saveTimer: null,

  _ref() {
    const { doc } = window.FirestoreAPI;
    return doc(this._db, 'workspace', 'main', 'data', 'store');
  },

  async init(uid, firestoreDb) {
    this._uid = uid;
    this._db = firestoreDb;
    await this._subscribe();
    this._updateSyncUI('synced');
  },

  _subscribe() {
    return new Promise((resolve) => {
      const { onSnapshot } = window.FirestoreAPI;
      const ref = this._ref();
      let initialized = false;
      this._unsubscribe = onSnapshot(ref, async (snap) => {
        if (!initialized) {
          initialized = true;
          if (snap.exists) {
            this._applyData(snap.data());
          } else {
            await this._migrateFromLegacyPath(this._uid);
          }
          this._firestoreReady = true;
          if (window.refreshCurrentPage) window.refreshCurrentPage();
          resolve();
        } else if (snap.exists && !snap.metadata.hasPendingWrites) {
          this._applyData(snap.data());
          if (window.refreshCurrentPage) window.refreshCurrentPage();
        }
      }, (err) => {
        console.warn('Firestore snapshot error:', err);
        this._updateSyncUI('error');
        if (window.toast) toast('⚠️ Could not connect to database: ' + (err.code || err.message));
        ARRAY_KEYS.forEach(k => { if (!this._cache[k]) this._cache[k] = []; });
        OBJ_KEYS.forEach(k => { if (!this._cache[k]) this._cache[k] = null; });
        if (!initialized) { initialized = true; resolve(); }
      });
    });
  },

  _applyData(data) {
    if (!data) return;
    ARRAY_KEYS.forEach(k => {
      this._cache[k] = Array.isArray(data[k]) ? data[k] : [];
    });
    OBJ_KEYS.forEach(k => {
      this._cache[k] = (data[k] !== undefined && data[k] !== null) ? data[k] : null;
    });
    // Preserve any keys in Firestore that we don't track yet
    Object.keys(data).forEach(k => {
      if (!ARRAY_KEYS.includes(k) && !OBJ_KEYS.includes(k)) {
        this._cache[k] = data[k];
      }
    });
  },

  async _migrateFromLegacyPath(oldUid) {
    const { doc, getDoc, setDoc } = window.FirestoreAPI;
    try {
      const oldRef = doc(this._db, 'users', oldUid, 'data', 'store');
      const snap = await getDoc(oldRef);
      if (snap.exists) {
        const data = snap.data();
        ARRAY_KEYS.forEach(k => {
          this._cache[k] = Array.isArray(data[k]) ? data[k] : [];
        });
        OBJ_KEYS.forEach(k => {
          this._cache[k] = data[k] || null;
        });
        const payload = {};
        ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
        OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
        await setDoc(this._ref(), payload, { merge: true });
      } else {
        ARRAY_KEYS.forEach(k => this._cache[k] = []);
        OBJ_KEYS.forEach(k => this._cache[k] = null);
      }
    } catch(e) {
      console.warn('Migration failed:', e);
      ARRAY_KEYS.forEach(k => { if(!this._cache[k]) this._cache[k] = []; });
      OBJ_KEYS.forEach(k => { if(!this._cache[k]) this._cache[k] = null; });
    }
  },

  // Debounced save — coalesces rapid writes into a single Firestore write.
  // Waits 500ms after the last write before persisting.
  _save() {
    if (!this._db || !this._firestoreReady) return;
    this._updateSyncUI('syncing');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._doSave(), 500);
  },

  _doSave() {
    if (!this._db || !this._firestoreReady) return;
    const { setDoc } = window.FirestoreAPI;
    const ref = this._ref();
    const payload = {};
    ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
    // Preserve unknown keys from cache (loaded by _applyData)
    Object.keys(this._cache).forEach(k => {
      if (!(k in payload)) payload[k] = this._cache[k];
    });
    setDoc(ref, payload, { merge: true })
      .then(() => this._updateSyncUI('synced'))
      .catch(e => {
        console.error('Firestore save error:', e);
        this._updateSyncUI('error');
        if (window.toast) toast('⚠️ Save failed — check your connection. Changes may be lost on reload.');
      });
  },

  _updateSyncUI(status) {
    this._syncStatus = status;
    const dot = document.getElementById('sync-dot');
    const label = document.getElementById('sync-label');
    if (!dot || !label) return;
    dot.className = 'sync-dot ' + status;
    label.textContent = status === 'synced' ? 'Saved' : status === 'syncing' ? 'Saving…' : 'Sync error';
  },

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

  atomicUpdate(fn) {
    fn(this._cache);
    this._save();
  },

  async importFromLocalStorage() {
    if (!this._firestoreReady) {
      throw new Error('Cannot import: Firestore has not confirmed document state yet.');
    }
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
    if (!this._firestoreReady) {
      throw new Error('Cannot save: Firestore has not confirmed document state yet.');
    }
    const { setDoc } = window.FirestoreAPI;
    const payload = {};
    ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
    Object.keys(this._cache).forEach(k => {
      if (!(k in payload)) payload[k] = this._cache[k];
    });
    try {
      await setDoc(this._ref(), payload, { merge: true });
    } catch(e) {
      console.error('Firestore _forceSave error:', e);
      this._updateSyncUI('error');
      if (window.toast) toast('⚠️ Save failed — check your connection. Changes may be lost on reload.');
      throw e;
    }
  }
};
