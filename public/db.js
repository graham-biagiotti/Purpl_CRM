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
  'ac','pr','iv','orders',
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
  // UX Phase 2 — Dashboard Quick Notes
  'quick_notes',     // scratchpad notes (text, author, ts)
  // UX Phase 5 — Inventory Locations
  'stock_locations', // named stock locations (Warehouse, fridge, event trailer…)
  'stock_transfers', // transfers between locations
  // Lavender Fields
  'lf_skus',            // LF product catalog (name, wholesalePrice, caseSize, msrp)
  'lf_invoices',        // LF wholesale invoices (line-item format)
  'lf_wix_deductions',  // Wix inventory pull requests tied to LF invoices
  'retail_invoices',    // delivery-run invoices (already used — registering here)
];
// Collections stored as plain objects (settings, costs, today_run)
const OBJ_KEYS = ['settings','costs','today_run'];

const DB = {
  _cache: {},
  _uid: null,
  _db: null,
  _syncStatus: 'synced', // 'synced' | 'syncing' | 'error'
  _firestoreReady: false, // true only after Firestore confirms document state (never after timeout)

  // ── Shared workspace path (all users share same data) ─
  _ref() {
    const { doc } = window.FirestoreAPI;
    return doc(this._db, 'workspace', 'main', 'data', 'store');
  },

  // ── Init ────────────────────────────────────────────
  async init(uid, firestoreDb) {
    this._uid = uid;
    this._db = firestoreDb;
    await this._subscribe();
    this._updateSyncUI('synced');
  },

  // ── Real-time listener (replaces one-shot _loadAll) ─
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
          // If the 10s timeout already fired and booted the app with empty cache,
          // refresh whichever page is showing now that real data has loaded.
          if (window.refreshCurrentPage) window.refreshCurrentPage();
          resolve();
        } else if (snap.exists && !snap.metadata.hasPendingWrites) {
          // Remote change from another user — update cache and refresh UI
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
    ARRAY_KEYS.forEach(k => {
      this._cache[k] = Array.isArray(data[k]) ? data[k] : [];
    });
    OBJ_KEYS.forEach(k => {
      this._cache[k] = data[k] || null;
    });
  },

  // ── One-time migration from old per-user path ───────
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
        // Save to shared workspace
        const payload = {};
        ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
        OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
        await setDoc(this._ref(), payload);
        console.log('Migration complete: data moved to shared workspace');
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

  // ── Persist to Firestore (fire-and-forget) ──────────
  _save() {
    if (!this._db) return;
    this._updateSyncUI('syncing');
    const { setDoc } = window.FirestoreAPI;
    const ref = this._ref();
    const payload = {};
    ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
    setDoc(ref, payload)
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

  // ── Atomic multi-key update (single Firestore write) ─
  // Apply fn(cache) which may mutate multiple keys,
  // then persist once. Safe because all data is one doc.
  atomicUpdate(fn) {
    fn(this._cache);
    this._save();
  },

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
    const { setDoc } = window.FirestoreAPI;
    const payload = {};
    ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = this._cache[k] || null);
    try {
      await setDoc(this._ref(), payload);
    } catch(e) {
      console.error('Firestore _forceSave error:', e);
      this._updateSyncUI('error');
      if (window.toast) toast('⚠️ Save failed — check your connection. Changes may be lost on reload.');
      throw e;
    }
  }
};
