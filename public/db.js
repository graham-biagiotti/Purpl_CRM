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
  'prod_hist','runs','shipments',
];

// Append-only collections: entries may be CREATED but never updated or
// deleted (mirrors firestore.rules — audit_log is tamper-proof). Batch saves
// must only write NEW docs for these keys, never re-set existing ones (a
// merge-set on an existing doc is an UPDATE, which the rules deny) and never
// delete, otherwise the whole batch is rejected with permission-denied.
const APPEND_ONLY_KEYS = ['audit_log'];

// H1/H2/M14: the unload recovery snapshot only captures items modified within
// this window before tab-close, and replay only resurrects missing items that
// recent. Bounds the blob size and prevents stale rows from being resurrected
// over a legitimate remote deletion. 30 min comfortably covers an active
// editing session (incl. offline edits that keep retrying) without reaching
// back to long-saved data.
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;

// Arrays that stay in a single config document (small/rarely changing)
const CONFIG_ARRAY_KEYS = [
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

    // Migrate arrays that moved from config to collections (one-time)
    const _movedToCollection = ['prod_hist','runs','shipments'];
    const freshSnap = await getDoc(this._configRef()).catch(() => null);
    const configData2 = freshSnap?.data?.() || {};
    let _needsConfigResave = false;
    for (const key of _movedToCollection) {
      const arr = configData2[key];
      if (Array.isArray(arr) && arr.length > 0) {
        console.log(`[db] Migrating ${arr.length} ${key} items from config to collection...`);
        for (const item of arr) {
          if (!item.id) continue;
          this._cache[key] = this._cache[key] || [];
          if (!this._cache[key].some(x => x.id === item.id)) this._cache[key].push(item);
          try { await this._collRef(key).doc(item.id).set(item); } catch(e) { console.warn(`[db] Migration write failed for ${key}/${item.id}:`, e); }
        }
        _needsConfigResave = true;
      }
    }
    if (_needsConfigResave) {
      const cleanPayload = { _dbVersion: 2 };
      CONFIG_ARRAY_KEYS.forEach(k => cleanPayload[k] = this._cache[k] || []);
      OBJ_KEYS.forEach(k => cleanPayload[k] = this._cache[k] ?? null);
      const { setDoc } = window.FirestoreAPI;
      await setDoc(this._configRef(), cleanPayload).catch(e => console.warn('[db] Config cleanup failed:', e));
      console.log('[db] Config doc cleaned — migrated arrays removed.');
    }

    this._firestoreReady = true;

    // Set up real-time listeners
    this._subscribeAll();

    // HIGH-2: replay any unsaved edits a previous tab-close left behind.
    this._replayRecovery();

    // HIGH-3: re-drive any cached-but-unsaved keys when connectivity returns.
    // After 3 failed transient save retries a key sits in _saveDirtyKeys with
    // no scheduled retry — without this it would only flush on the next manual
    // edit or reload. Fire once on reconnect.
    if (!this._onlineWired) {
      this._onlineWired = true;
      window.addEventListener('online', () => {
        if (!this._firestoreReady) return;
        const stuck = [...(this._saveDirtyKeys || [])];
        if (stuck.length) {
          // M11: reset backoff ONLY for the keys we're re-driving. The previous
          // global `_saveRetries = {}` also wiped counters for keys still
          // mid-backoff, which could trigger a retry storm on those.
          stuck.forEach(k => {
            if (this._saveRetries) delete this._saveRetries[k];
            this._scheduleSave(k);
          });
          if (window.toast) toast('Reconnected — syncing your changes…');
        }
      });
    }

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

        if (this._dirty || this._atomicInProgress || (this._saveDirtyKeys && this._saveDirtyKeys.has(key))) {
          this._pendingRemoteChanges = true;
          if (this._dirty) this._showRemoteChangeWarning();
        } else {
          try {
            this._cache[key] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
          } catch(mapErr) {
            console.error(`[db] Corrupt snapshot for ${key}, keeping cache:`, mapErr);
          }
          this._scheduleRefresh(); // H4: debounced
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

      // Mirror the collection-listener guard (line ~176): a remote config
      // snapshot must NOT overwrite local config that's edited-but-unflushed.
      // Config keys (CONFIG_ARRAY_KEYS + OBJ_KEYS) live in _saveDirtyKeys while
      // a debounced save is pending, and atomicUpdate also flushes config.
      const _configKeyDirty = this._saveDirtyKeys &&
        [...CONFIG_ARRAY_KEYS, ...OBJ_KEYS].some(k => this._saveDirtyKeys.has(k));
      if (this._dirty || this._atomicInProgress || _configKeyDirty) {
        this._pendingRemoteChanges = true;
        this._showRemoteChangeWarning();
      } else {
        const data = snap.data();
        CONFIG_ARRAY_KEYS.forEach(k => {
          if (data.hasOwnProperty(k)) {
            this._cache[k] = Array.isArray(data[k]) ? data[k] : (this._cache[k] || []);
          }
        });
        OBJ_KEYS.forEach(k => {
          if (data.hasOwnProperty(k)) {
            this._cache[k] = (data[k] !== undefined && data[k] !== null) ? data[k] : null;
          }
        });
        this._scheduleRefresh(); // H4: debounced
      }
    }, err => {
      console.warn('[db] Config snapshot error:', err);
    });
    this._unsubscribers.push(configUnsub);
  },

  // H4: coalesce bursts of remote snapshots into ONE re-render. Each snapshot
  // used to call refreshCurrentPage() directly, which re-runs migrations + a
  // full page render; a multi-collection update (or another user's batch) thus
  // caused a render storm. Debounce so N near-simultaneous events render once.
  _scheduleRefresh() {
    if (!window.refreshCurrentPage) return;
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => { try { window.refreshCurrentPage(); } catch(_) {} }, 120);
  },

  // ── Migration from single-doc to multi-collection ──
  async _migrateFromSingleDoc(data) {
    const { setDoc } = window.FirestoreAPI;

    // Write each collection-based array as individual documents
    for (const key of COLLECTION_KEYS) {
      const items = Array.isArray(data[key]) ? data[key] : [];
      this._cache[key] = items;
      for (const item of items) {
        if (!item.id) { console.warn(`[db] Migration: skipping ${key} item without id`, item); continue; }
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

  _recoveryKey() { return 'pcrm_recovery_' + (this._uid || 'anon'); },

  _flushPendingSave() {
    if (!this._saveDirtyKeys || this._saveDirtyKeys.size === 0) return;
    // HIGH-2: the async .set() calls below queue to IndexedDB, but that queue
    // write is itself async and is NOT guaranteed to commit before the tab is
    // torn down. localStorage.setItem IS synchronous and completes before
    // unload — write a recovery snapshot first so the last edit can never be
    // lost. Replayed (with timestamp comparison) on next init.
    try {
      const ts = Date.now();
      const recovery = { ts, collections: {}, config: {} };
      this._saveDirtyKeys.forEach(key => {
        if (COLLECTION_KEYS.includes(key) && !APPEND_ONLY_KEYS.includes(key)) {
          // H1/H2/M14: snapshot ONLY items modified recently (the genuine
          // unsaved edits), not the whole collection. Snapshotting every row
          // made old, untouched rows resurrection candidates on replay (H1)
          // and bloated the blob past the localStorage quota (M14). An item
          // the user actually touched this session has a fresh _updatedAt;
          // anything older has long since saved (or surfaced a failure toast).
          recovery.collections[key] = (this._cache[key] || []).filter(it =>
            it && it._updatedAt && (ts - new Date(it._updatedAt).getTime() <= RECOVERY_WINDOW_MS));
        } else if (CONFIG_ARRAY_KEYS.includes(key) || OBJ_KEYS.includes(key)) {
          recovery.config[key] = this._cache[key];
        }
      });
      // M15: two tabs of the same user share one recovery key. Merge with any
      // existing blob instead of overwriting, so the earlier-closing tab's
      // unsaved edits aren't dropped. Union collection items by id (newest
      // _updatedAt wins); keep the max ts; config takes whichever is present.
      try {
        const prevRaw = localStorage.getItem(this._recoveryKey());
        if (prevRaw) {
          const prev = JSON.parse(prevRaw);
          if (prev && prev.ts && (ts - prev.ts) <= 864e5) {
            recovery.ts = Math.max(ts, prev.ts);
            Object.entries(prev.collections || {}).forEach(([key, items]) => {
              if (!Array.isArray(items)) return;
              const merged = new Map((recovery.collections[key] || []).map(x => [x.id, x]));
              items.forEach(it => {
                if (!it || !it.id) return;
                const cur = merged.get(it.id);
                if (!cur || (it._updatedAt || '') > (cur._updatedAt || '')) merged.set(it.id, it);
              });
              recovery.collections[key] = [...merged.values()];
            });
            Object.entries(prev.config || {}).forEach(([key, val]) => {
              if (!(key in recovery.config)) recovery.config[key] = val;
            });
          }
        }
      } catch(_) { /* malformed prior blob — overwrite it */ }
      localStorage.setItem(this._recoveryKey(), JSON.stringify(recovery));
    } catch(e) { /* localStorage full/unavailable — fall through to async writes */ }

    this._saveDirtyKeys.forEach(key => {
      if (this._saveTimers[key]) {
        clearTimeout(this._saveTimers[key]);
        this._saveTimers[key] = null;
      }
      if (COLLECTION_KEYS.includes(key)) {
        (this._cache[key] || []).forEach(item => {
          if (item?.id) this._writeDoc(key, item);
        });
      }
    });
    // Config is a single doc — flush it directly
    if (this._saveDirtyKeys.size > 0) this._saveConfig();
    this._saveDirtyKeys.clear();
  },

  // HIGH-2 / H1 / H2: replay any recovery snapshot left by a previous
  // tab-close. Re-asserts an item only when (a) it still exists on the server
  // and our backup is meaningfully newer (an unsaved edit), or (b) it is
  // missing from the server AND was modified just before close (an unsaved
  // create). A missing item that was NOT recently modified is treated as a
  // legitimate remote deletion and left deleted — never resurrected.
  _replayRecovery() {
    let recovery;
    try {
      const raw = localStorage.getItem(this._recoveryKey());
      if (!raw) return;
      recovery = JSON.parse(raw);
    } catch(e) { try { localStorage.removeItem(this._recoveryKey()); } catch(_) {} return; }
    // Ignore stale recovery (>24h) — too risky to replay against drifted data
    if (!recovery || (recovery.ts && Date.now() - recovery.ts > 864e5)) {
      try { localStorage.removeItem(this._recoveryKey()); } catch(_) {}
      return;
    }
    let restored = 0;
    const recoveryTs = recovery.ts || 0;
    // H2: require the local copy to beat the server by a margin so trivial
    // client-clock skew between devices can't flip "newer" and clobber a
    // genuinely-newer remote edit. Cross-device times are not authoritative;
    // this only reduces the window, it cannot fully eliminate a true conflict.
    const SKEW_MARGIN_MS = 5000;
    const newer = (a, b) => {
      const ta = a?._updatedAt ? new Date(a._updatedAt).getTime() : 0;
      const tb = b?._updatedAt ? new Date(b._updatedAt).getTime() : 0;
      return ta - tb > SKEW_MARGIN_MS;
    };
    // H1: only resurrect a server-missing item if it was edited right before
    // close (recovery is fresh AND the item's stamp is within the window).
    const recentlyTouched = (it) => it && it._updatedAt &&
      (recoveryTs - new Date(it._updatedAt).getTime() <= RECOVERY_WINDOW_MS);
    Object.entries(recovery.collections || {}).forEach(([key, items]) => {
      if (!COLLECTION_KEYS.includes(key) || !Array.isArray(items)) return;
      const live = this._cache[key] || [];
      const byId = new Map(live.map(x => [x.id, x]));
      items.forEach(item => {
        if (!item?.id) return;
        const cur = byId.get(item.id);
        const reassert = cur ? newer(item, cur) : recentlyTouched(item);
        if (reassert) {
          // Local edit didn't reach the server — re-assert it
          const idx = live.findIndex(x => x.id === item.id);
          if (idx >= 0) live[idx] = item; else live.push(item);
          this._writeDoc(key, item);
          restored++;
        }
      });
      this._cache[key] = live;
    });
    Object.entries(recovery.config || {}).forEach(([key, val]) => {
      const cur = this._cache[key];
      // Config has no per-key timestamp; only restore if the server value is
      // empty/missing (i.e. the local config write was lost), never overwrite
      // a populated server value.
      const curEmpty = cur === null || cur === undefined ||
        (Array.isArray(cur) && cur.length === 0) ||
        (typeof cur === 'object' && !Array.isArray(cur) && Object.keys(cur).length === 0);
      if (curEmpty && val != null) { this._cache[key] = val; restored++; }
    });
    if (restored > 0) {
      this._saveConfig();
      if (window.toast) toast('Recovered ' + restored + ' unsaved change' + (restored > 1 ? 's' : '') + ' from your last session.');
      if (window.refreshCurrentPage) window.refreshCurrentPage();
    }
    try { localStorage.removeItem(this._recoveryKey()); } catch(_) {}
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

    // C1: this path NEVER deletes. It only creates/updates the docs currently
    // in cache. Deletions are propagated explicitly via _deleteDoc (from
    // remove() and atomicUpdate's before/after diff) — inferring deletion from
    // "server has an id my cache lacks" is unsafe because the cache is stale
    // during in-flight saves and could wipe another user's new docs.
    // For append-only collections we still read existing ids so we only CREATE
    // new docs (re-setting an existing one is an UPDATE the rules reject).
    const appendOnly = APPEND_ONLY_KEYS.includes(key);
    const guard = appendOnly
      ? colRef.get().then(snap => new Set(snap.docs.map(d => d.id)))
      : Promise.resolve(null);
    guard.then(existingIds => {
      items.forEach(item => {
        if (!item.id) return;
        if (appendOnly && existingIds.has(item.id)) return;
        batch.set(colRef.doc(item.id), item, { merge: true });
      });
      return batch.commit();
    }).then(() => {
      this._saveRetries = {};
      this._updateSyncUI('synced');
    }).catch(e => {
      console.error(`[db] Save error for ${key}:`, e);
      this._updateSyncUI('error');
      // Permanent failures (rules/permission) should not retry endlessly
      const code = e?.code || '';
      const permanent = ['permission-denied','not-found','invalid-argument','failed-precondition','already-exists','resource-exhausted','unimplemented'].includes(code);
      if (permanent) {
        if (window.toast) toast('⚠️ Save rejected by server: ' + (e.message || code) + '. Changes NOT saved.', 10000);
        return;
      }
      // Transient failures (offline, timeout) — retry
      const retries = (this._saveRetries?.[key] || 0) + 1;
      if (!this._saveRetries) this._saveRetries = {};
      this._saveRetries[key] = retries;
      if (retries <= 3) {
        if (window.toast) toast('⚠️ Save failed — retrying…');
        setTimeout(() => this._doSave(key), 2000 * retries);
      } else {
        this._saveDirtyKeys.add(key);
        if (window.toast) toast('⚠️ Save failed after 3 retries. Your changes are cached locally — they will sync when connection is restored.', 10000);
      }
    });
  },

  _saveConfig() {
    const { setDoc } = window.FirestoreAPI;
    const payload = { _dbVersion: 2 };
    CONFIG_ARRAY_KEYS.forEach(k => payload[k] = this._cache[k] || []);
    OBJ_KEYS.forEach(k => payload[k] = (this._cache[k] !== undefined && this._cache[k] !== null) ? this._cache[k] : null);

    setDoc(this._configRef(), payload, { merge: true })
      .then(() => { this._configRetries = 0; this._updateSyncUI('synced'); })
      .catch(e => {
        console.error('[db] Config save error:', e);
        this._updateSyncUI('error');
        // LOW-1: classify like _saveCollection — never retry a permanent error
        // forever (that's a retry storm). Bound transient retries; leave config
        // keys dirty so the reconnect re-drive (online listener) picks them up.
        const code = e?.code || '';
        const permanent = ['permission-denied','not-found','invalid-argument','failed-precondition','already-exists','resource-exhausted','unimplemented'].includes(code);
        if (permanent) {
          if (window.toast) toast('⚠️ Settings save rejected by server: ' + (e.message || code) + '. Changes NOT saved.', 10000);
          return;
        }
        const retries = (this._configRetries || 0) + 1;
        this._configRetries = retries;
        if (retries <= 3) {
          if (window.toast) toast('⚠️ Settings save failed — retrying…');
          setTimeout(() => this._saveConfig(), 2000 * retries);
        } else {
          [...CONFIG_ARRAY_KEYS, ...OBJ_KEYS].forEach(k => this._saveDirtyKeys.add(k));
          if (window.toast) toast('⚠️ Settings save failed after 3 retries — cached locally, will sync when reconnected.', 10000);
        }
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
    // Do NOT reload here. _loadFromCollections() REPLACES the whole cache from
    // the server; if a just-made local write hasn't committed yet, that reload
    // wipes it (this is how a confirmed portal order lost its invoice — twice).
    // It's also unnecessary: the per-collection snapshot listeners reconcile the
    // cache on their own once writes are server-confirmed, and apply any
    // remote change that was deferred while we were dirty at the same time.
    // The user can still force a hard refresh via "Load Changes" (applyPendingRemote).
    this._pendingRemoteChanges = false;
    this._dismissRemoteWarning();
  },

  applyPendingRemote() {
    // User explicitly asked to load the latest. Still don't reload over
    // in-flight writes (would wipe a just-saved invoice); wait briefly for them
    // to settle, then do the hard refresh.
    if (this._atomicInProgress || (this._saveDirtyKeys && this._saveDirtyKeys.size > 0)) {
      clearTimeout(this._applyPendingRetry);
      this._applyPendingRetry = setTimeout(() => this.applyPendingRemote(), 300);
      return;
    }
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

  // ── Immediate single-doc writes (survives tab close via IndexedDB persistence) ──
  _writeDoc(key, item) {
    if (!this._db || !this._firestoreReady || !item?.id) return;
    this._collRef(key).doc(item.id).set(item, { merge: true })
      .then(() => this._updateSyncUI('synced'))
      .catch(e => {
        console.warn(`[db] Immediate write failed for ${key}/${item.id}:`, e);
        this._updateSyncUI('error');
        // Re-queue for debounced batch save as fallback
        this._saveDirtyKeys.add(key);
        this._scheduleSave(key);
      });
  },
  _deleteDoc(key, id) {
    if (!this._db || !this._firestoreReady || !id) return;
    this._collRef(key).doc(id).delete()
      .then(() => this._updateSyncUI('synced'))
      .catch(e => {
        console.warn(`[db] Immediate delete failed for ${key}/${id}:`, e);
        this._updateSyncUI('error');
        this._saveDirtyKeys.add(key);
        this._scheduleSave(key);
      });
  },

  // ── Public API ──
  get(k) { return this._cache[k] || []; },
  set(k, v) { this._cache[k] = v; this._save(k); },
  obj(k, def = {}) { return this._cache[k] || def; },
  setObj(k, v) { this._cache[k] = v; this._save(k); },
  a(k) { return this.get(k); },
  _stamp(item) { if (item && typeof item === 'object') item._updatedAt = new Date().toISOString(); return item; },
  push(k, v) {
    if (COLLECTION_KEYS.includes(k)) this._stamp(v);
    const a = this.a(k); a.push(v); this._cache[k] = a; this._save(k);
    if (COLLECTION_KEYS.includes(k) && v?.id) this._writeDoc(k, v);
  },
  update(k, id, fn) {
    const a = this.a(k);
    const i = a.findIndex(x => x.id === id);
    if (i < 0) {
      console.warn(`[db] update: ${k}/${id} not found (may have been deleted)`);
      return false;
    }
    a[i] = this._stamp(fn(a[i])); this._cache[k] = a; this._save(k);
    if (COLLECTION_KEYS.includes(k)) this._writeDoc(k, a[i]);
    return true;
  },
  remove(k, id) {
    this._cache[k] = this.a(k).filter(x => x.id !== id); this._save(k);
    if (COLLECTION_KEYS.includes(k)) this._deleteDoc(k, id);
  },

  atomicUpdate(fn) {
    // Block snapshots during atomic update to prevent the 50ms race
    this._atomicInProgress = true;
    const allKeys = [...ARRAY_KEYS, ...OBJ_KEYS];
    try {
      const before = {};
      COLLECTION_KEYS.forEach(k => { before[k] = new Set((this._cache[k]||[]).map(x => x?.id).filter(Boolean)); });
      fn(this._cache);
      const now = new Date().toISOString();
      COLLECTION_KEYS.forEach(k => {
        const appendOnly = APPEND_ONLY_KEYS.includes(k);
        const after = new Set();
        (this._cache[k]||[]).forEach(item => {
          if (item && typeof item === 'object') {
            // L5: don't re-stamp append-only rows (they're immutable; the
            // server skips re-writing them, so a new _updatedAt is pure drift).
            if (!appendOnly) item._updatedAt = now;
            if (item.id) {
              after.add(item.id);
              if (!before[k].has(item.id)) this._writeDoc(k, item);
            }
          }
        });
        // C1: propagate deletions EXPLICITLY. Previously _saveCollection inferred
        // deletions from "server has a doc my cache doesn't" — but the cache is
        // intentionally stale during a save/atomicUpdate (snapshot deferral), so
        // that diff could delete another user's just-created docs. Diff the
        // before/after id sets here instead. Append-only collections never delete.
        if (!appendOnly) {
          before[k].forEach(id => { if (!after.has(id)) this._deleteDoc(k, id); });
        }
      });
      allKeys.forEach(k => this._scheduleSave(k));
    } catch (e) {
      // A throwing mutator must NOT leave _atomicInProgress stuck — that would
      // permanently jam snapshot sync for the session. Clear it and rethrow.
      this._atomicInProgress = false;
      throw e;
    }
    // Flush immediately for atomicity. finally guarantees the flag clears even
    // if a _saveCollection/_saveConfig throws synchronously.
    setTimeout(() => {
      try {
        allKeys.forEach(k => {
          if (this._saveTimers[k]) {
            clearTimeout(this._saveTimers[k]);
            this._saveTimers[k] = null;
          }
        });
        COLLECTION_KEYS.forEach(k => this._saveCollection(k));
        this._saveConfig();
        // M13: these direct flushes bypass _doSave (which is what normally
        // clears _saveDirtyKeys). Without this, every key touched by an
        // atomicUpdate stays "dirty" forever — jamming the config snapshot
        // listener, which then defers ALL remote config changes indefinitely.
        // A failed save re-adds its own key via its retry path.
        allKeys.forEach(k => this._saveDirtyKeys && this._saveDirtyKeys.delete(k));
      } finally {
        this._atomicInProgress = false;
      }
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
    // C1: create/update only — never delete by cache-absence (see _saveCollection).
    const items = this._cache[key] || [];
    const colRef = this._collRef(key);
    const appendOnly = APPEND_ONLY_KEYS.includes(key);
    const existingIds = appendOnly
      ? new Set((await colRef.get()).docs.map(d => d.id))
      : null;
    const batch = this._db.batch();
    items.forEach(item => {
      if (!item.id) return;
      if (appendOnly && existingIds.has(item.id)) return;
      batch.set(colRef.doc(item.id), item, { merge: true });
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
