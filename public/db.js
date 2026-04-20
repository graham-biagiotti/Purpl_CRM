// ═══════════════════════════════════════════════════════
//  db.js  —  Firebase-backed data layer for purpl CRM
//
//  Architecture: multi-collection with in-memory cache
//  • Each data type gets its own Firestore collection
//  • On startup, all collections are loaded into _cache
//  • Reads are instant (synchronous from cache)
//  • Writes update cache immediately, persist via debounce
//  • Real-time listeners on each collection for multi-user
//  • API is identical to single-doc version (DB.a, DB.push, etc.)
// ═══════════════════════════════════════════════════════

// Collections that get their own Firestore collection (one doc per record)
const COLLECTION_KEYS = [
  'ac','pr','iv','orders',
  'retail_invoices','lf_invoices','combined_invoices',
  'dist_profiles','dist_reps','dist_pricing','dist_pos',
  'dist_invoices','dist_chains','dist_imports',
  'audit_log',
];

// Collections that stay in a single config document (small/rarely changing)
const CONFIG_ARRAY_KEYS = [
  'prod_hist','shipments','runs',
  'saved_reports','loose_cans','repack_jobs','pallets','pack_supply',
  'quick_notes','stock_locations','stock_transfers',
  'lf_skus','lf_wix_deductions','pending_invoices','returns',
];

// All array keys (union — used for cache initialization and API compatibility)
const ARRAY_KEYS = [...COLLECTION_KEYS, ...CONFIG_ARRAY_KEYS];

// Object keys stored in the config document
const OBJ_KEYS = ['settings','costs','today_run','invoice_settings','api_settings'];

const DB = {
  _cache: {},
  _uid: null,
  _db: null,
  _syncStatus: 'synced',
  _firestoreReady: false,
  _saveTimers: {},
  _dirty: false,
  _pendingRemoteChanges: false,
  _unsubscribers: [],
  _initCount: 0,
  _initTarget: 0,

  // Base path for all CRM data
  _basePath() { return 'workspace/main'; },

  // Collection reference for a given key
  _collRef(key) {
    return this._db.collection(this._basePath() + '/' + key);
  },

  // Config document reference
  _configRef() {
    const { doc } = window.FirestoreAPI;
    return doc(this._db, 'workspace', 'main', 'config', 'main');
  },

  // Legacy single-doc reference (for migration check)
  _legacyRef() {
    const { doc } = window.FirestoreAPI;
    return doc(this._db, 'workspace', 'main', 'data', 'store');
  },

  async init(uid, firestoreDb) {
    this._uid = uid;
    this._db = firestoreDb;
    await this._loadAll();
    this._updateSyncUI('synced');
  },

  async _loadAll() {
    // Initialize cache
    ARRAY_KEYS.forEach(k => { if (!this._cache[k]) this._cache[k] = []; });
    OBJ_KEYS.forEach(k => { if (!this._cache[k]) this._cache[k] = null; });

    // Check if we need to migrate from single-doc
    const { getDoc } = window.FirestoreAPI;
    const configSnap = await getDoc(this._configRef()).catch(() => null);

    if (!configSnap || !configSnap.exists || !configSnap.data()?._dbVersion) {
      // No multi-collection data yet — check for legacy single doc
      const legacySnap = await getDoc(this._legacyRef()).catch(() => null);
      if (legacySnap && legacySnap.exists) {
        console.log('[db] Found legacy single-doc data — running migration...');
        await this._migrateFromSingleDoc(legacySnap.data());
        console.log('[db] Migration complete.');
      } else {
        // Try legacy user path
        await this._migrateFromLegacyPath(this._uid);
      }
    } else {
      // Load from multi-collection
      await this._loadFromCollections();
      // Load config doc
      const configData = configSnap.data();
      CONFIG_ARRAY_KEYS.forEach(k => {
        this._cache[k] = Array.isArray(configData[k]) ? configData[k] : [];
      });
      OBJ_KEYS.forEach(k => {
        this._cache[k] = (configData[k] !== undefined && configData[k] !== null) ? configData[k] : null;
      });
    }

    this._firestoreReady = true;

    // Set up real-time listeners
    this._subscribeAll();

    if (window.refreshCurrentPage) window.refreshCurrentPage();
  },

  async _loadFromCollections() {
    // Load all collection-based data in parallel
    const loads = COLLECTION_KEYS.map(async (key) => {
      try {
        const snap = await this._collRef(key).get();
        this._cache[key] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      } catch(e) {
        console.warn(`[db] Failed to load collection ${key}:`, e);
        this._cache[key] = [];
      }
    });
    await Promise.all(loads);
  },

  _subscribeAll() {
    // Clean up existing listeners
    this._unsubscribers.forEach(fn => fn());
    this._unsubscribers = [];

    const { onSnapshot } = window.FirestoreAPI;

    // Listen to each collection
    COLLECTION_KEYS.forEach(key => {
      const unsub = this._collRef(key).onSnapshot(snap => {
        if (!this._firestoreReady) return;
        // Only process remote changes (not local echoes)
        const hasLocalChanges = snap.docChanges().some(c => c.doc.metadata.hasPendingWrites);
        if (hasLocalChanges) return;

        const remoteChanges = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
        if (!remoteChanges.length) return;

        if (this._dirty) {
          this._pendingRemoteChanges = true;
          this._showRemoteChangeWarning();
        } else {
          this._cache[key] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
          if (window.refreshCurrentPage) window.refreshCurrentPage();
        }
      }, err => {
        console.warn(`[db] Snapshot error on ${key}:`, err);
      });
      this._unsubscribers.push(unsub);
    });

    // Listen to config document
    const configUnsub = onSnapshot(this._configRef(), snap => {
      if (!this._firestoreReady) return;
      if (snap.metadata.hasPendingWrites) return;
      if (!snap.exists) return;

      if (this._dirty) {
        this._pendingRemoteChanges = true;
        this._showRemoteChangeWarning();
      } else {
        const data = snap.data();
        CONFIG_ARRAY_KEYS.forEach(k => {
          this._cache[k] = Array.isArray(data[k]) ? data[k] : [];
        });
        OBJ_KEYS.forEach(k => {
          this._cache[k] = (data[k] !== undefined && data[k] !== null) ? data[k] : null;
        });
        if (window.refreshCurrentPage) window.refreshCurrentPage();
      }
    }, err => {
      console.warn('[db] Config snapshot error:', err);
    });
    this._unsubscribers.push(configUnsub);
  },

  // ── Migration from single-doc to multi-collection ──
  async _migrateFromSingleDoc(data) {
    const { setDoc } = window.FirestoreAPI;

    // Write each collection-based array as individual documents
    for (const key of COLLECTION_KEYS) {
      const items = Array.isArray(data[key]) ? data[key] : [];
      this._cache[key] = items;
      for (const item of items) {
        if (!item.id) continue;
        try {
          await this._collRef(key).doc(item.id).set(item);
        } catch(e) {
          console.error(`[db] Migration failed for ${key}/${item.id}:`, e);
        }
      }
    }

    // Build config document with remaining data
    const configPayload = { _dbVersion: 2 };
    CONFIG_ARRAY_KEYS.forEach(k => {
      configPayload[k] = Array.isArray(data[k]) ? data[k] : [];
      this._cache[k] = configPayload[k];
    });
    OBJ_KEYS.forEach(k => {
      configPayload[k] = (data[k] !== undefined && data[k] !== null) ? data[k] : null;
      this._cache[k] = configPayload[k];
    });

    await setDoc(this._configRef(), configPayload, { merge: true });
    console.log(`[db] Migrated: ${COLLECTION_KEYS.map(k => `${k}(${this._cache[k].length})`).join(', ')}`);
  },

  async _migrateFromLegacyPath(oldUid) {
    const { doc, getDoc } = window.FirestoreAPI;
    try {
      const oldRef = doc(this._db, 'users', oldUid, 'data', 'store');
      const snap = await getDoc(oldRef);
      if (snap.exists) {
        await this._migrateFromSingleDoc(snap.data());
      }
    } catch(e) {
      console.warn('Legacy migration failed:', e);
    }
  },

  // ── Debounced save per collection ──
  // Each collection has its own debounce timer so writing to 'ac'
  // doesn't delay a save to 'orders'
  _save(key) {
    if (!this._db || !this._firestoreReady) return;
    this._updateSyncUI('syncing');

    if (!key) {
      // No specific key — save everything that's dirty
      this._saveDirtyKeys.forEach(k => this._scheduleSave(k));
      return;
    }
    this._scheduleSave(key);
  },

  _saveDirtyKeys: new Set(),

  _scheduleSave(key) {
    this._saveDirtyKeys.add(key);
    if (this._saveTimers[key]) clearTimeout(this._saveTimers[key]);
    this._saveTimers[key] = setTimeout(() => this._doSave(key), 500);
  },

  _flushPendingSave() {
    this._saveDirtyKeys.forEach(key => {
      if (this._saveTimers[key]) {
        clearTimeout(this._saveTimers[key]);
        this._saveTimers[key] = null;
        this._doSave(key);
      }
    });
  },

  _doSave(key) {
    if (!this._db || !this._firestoreReady) return;
    this._saveDirtyKeys.delete(key);

    if (COLLECTION_KEYS.includes(key)) {
      this._saveCollection(key);
    } else if (CONFIG_ARRAY_KEYS.includes(key) || OBJ_KEYS.includes(key)) {
      this._saveConfig();
    }
  },

  _saveCollection(key) {
    const items = this._cache[key] || [];
    const batch = this._db.batch();
    const colRef = this._collRef(key);

    // Get current docs to find deletions
    colRef.get().then(snap => {
      const existingIds = new Set(snap.docs.map(d => d.id));
      const cacheIds = new Set(items.map(x => x.id).filter(Boolean));

      // Set/update all current items
      items.forEach(item => {
        if (!item.id) return;
        batch.set(colRef.doc(item.id), item, { merge: true });
      });

      // Delete removed items
      existingIds.forEach(id => {
        if (!cacheIds.has(id)) {
          batch.delete(colRef.doc(id));
        }
      });

      return batch.commit();
    }).then(() => {
      this._saveRetries = {};
      this._updateSyncUI('synced');
    }).catch(e => {
      console.error(`[db] Save error for ${key}:`, e);
      this._updateSyncUI('error');
      const retries = (this._saveRetries?.[key] || 0) + 1;
      if (!this._saveRetries) this._saveRetries = {};
      this._saveRetries[key] = retries;
      if (retries <= 3) {
        if (window.toast) toast('⚠️ Save failed — retrying…');
        setTimeout(() => this._doSave(key), 2000 * retries);
      } else {
        if (window.toast) toast('⚠️ Save failed after 3 retries.');
      }
    });
  },

  _saveConfig() {
    const { setDoc } = window.FirestoreAPI;
    const payload = { _dbVersion: 2 };
    CONFIG_ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = (this._cache[k] !== undefined && this._cache[k] !== null) ? this._cache[k] : null);

    setDoc(this._configRef(), payload, { merge: true })
      .then(() => this._updateSyncUI('synced'))
      .catch(e => {
        console.error('[db] Config save error:', e);
        this._updateSyncUI('error');
        if (window.toast) toast('⚠️ Settings save failed — retrying…');
        setTimeout(() => this._saveConfig(), 2000);
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

  // ── Dirty flag for multi-user ──
  markDirty() { this._dirty = true; },
  markClean() {
    this._dirty = false;
    if (this._pendingRemoteChanges) {
      this._pendingRemoteChanges = false;
      // Reload all collections
      this._loadFromCollections().then(() => {
        if (window.refreshCurrentPage) window.refreshCurrentPage();
      });
    }
    this._dismissRemoteWarning();
  },

  applyPendingRemote() {
    this._pendingRemoteChanges = false;
    this._dirty = false;
    this._dismissRemoteWarning();
    this._loadFromCollections().then(() => {
      if (window.refreshCurrentPage) window.refreshCurrentPage();
    });
  },

  _showRemoteChangeWarning() {
    if (document.getElementById('remote-change-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'remote-change-banner';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#fef3c7;border-top:2px solid #f59e0b;padding:12px 20px;z-index:9999;display:flex;align-items:center;justify-content:center;gap:12px;font-size:14px;color:#92400e;font-family:sans-serif';
    banner.innerHTML = '<span>⚠️ Another user made changes. Save your work first, or reload to get the latest.</span>' +
      '<button onclick="DB.applyPendingRemote()" style="background:#f59e0b;color:#fff;border:none;padding:6px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px">Load Changes</button>' +
      '<button onclick="DB._dismissRemoteWarning()" style="background:transparent;border:1px solid #f59e0b;color:#92400e;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px">Dismiss</button>';
    document.body.appendChild(banner);
  },

  _dismissRemoteWarning() {
    const el = document.getElementById('remote-change-banner');
    if (el) el.remove();
  },

  // ── Public API (identical to single-doc version) ──
  get(k) { return this._cache[k] || []; },
  set(k, v) { this._cache[k] = v; this._save(k); },
  obj(k, def = {}) { return this._cache[k] || def; },
  setObj(k, v) { this._cache[k] = v; this._save(k); },
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
    // Find which keys were likely modified and save them all
    const allKeys = [...ARRAY_KEYS, ...OBJ_KEYS];
    allKeys.forEach(k => this._scheduleSave(k));
    // Flush immediately for atomicity
    setTimeout(() => {
      allKeys.forEach(k => {
        if (this._saveTimers[k]) {
          clearTimeout(this._saveTimers[k]);
          this._saveTimers[k] = null;
        }
      });
      // Save collections that have data
      COLLECTION_KEYS.forEach(k => this._saveCollection(k));
      this._saveConfig();
    }, 50);
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
            const existing = this._cache[k] || [];
            const existingIds = new Set(existing.map(x => x.id).filter(Boolean));
            const newItems = parsed.filter(x => !x.id || !existingIds.has(x.id));
            this._cache[k] = [...existing, ...newItems];
            imported += newItems.length;
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
    // Save all collections
    for (const key of COLLECTION_KEYS) {
      await this._saveCollectionSync(key);
    }
    await this._saveConfigSync();
  },

  async _saveCollectionSync(key) {
    const items = this._cache[key] || [];
    const colRef = this._collRef(key);
    const snap = await colRef.get();
    const existingIds = new Set(snap.docs.map(d => d.id));
    const cacheIds = new Set(items.map(x => x.id).filter(Boolean));
    const batch = this._db.batch();
    items.forEach(item => {
      if (!item.id) return;
      batch.set(colRef.doc(item.id), item, { merge: true });
    });
    existingIds.forEach(id => {
      if (!cacheIds.has(id)) batch.delete(colRef.doc(id));
    });
    await batch.commit();
  },

  async _saveConfigSync() {
    const { setDoc } = window.FirestoreAPI;
    const payload = { _dbVersion: 2 };
    CONFIG_ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = (this._cache[k] !== undefined && this._cache[k] !== null) ? this._cache[k] : null);
    await setDoc(this._configRef(), payload, { merge: true });
  },
};
