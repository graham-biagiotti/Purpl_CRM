// ═══════════════════════════════════════════════════════
//  places.js — Google Places Address Autocomplete
//  purpl CRM — Phase 3
//
//  ── SETUP ───────────────────────────────────────────────
//  1. Get a Google Places API key (see firebase-config.js)
//  2. Add to firebase-config.js:
//       window.GOOGLE_PLACES_KEY = 'YOUR_KEY_HERE';
//  3. That's it — autocomplete activates automatically.
//
//  ── HOW TO GET A KEY ────────────────────────────────────
//  1. Go to console.cloud.google.com
//  2. Select or create your project (e.g. purpl-crm)
//  3. APIs & Services → Enable APIs → search "Places API" → Enable
//     Also enable "Maps JavaScript API" for geocoding fallback
//  4. APIs & Services → Credentials → + Create Credentials → API Key
//  5. RESTRICT the key:
//     • Application restrictions: HTTP referrers
//       Add: purpl-crm.web.app/* and purpl-crm.firebaseapp.com/*
//     • API restrictions: Places API, Maps JavaScript API
//  6. Copy the key into firebase-config.js
// ═══════════════════════════════════════════════════════

(function() {
  'use strict';

  const KEY = window.GOOGLE_PLACES_KEY || '';
  let _loaded  = false;
  let _loading = null;
  let _autoRetries = 0;     // v252: bounded self-heal attempts after a failure
  let _failToastShown = false;

  // v252: one quiet retry path shared by the failure timer and the browser's
  // back-online event. Bounded so a dead key can't retry forever; the cap
  // resets whenever a retry is triggered by real connectivity returning.
  function _scheduleRetry(fromOnline) {
    if (fromOnline) _autoRetries = 0;
    if (_loaded || _loading) return;
    if (_autoRetries >= 3) return;
    _autoRetries++;
    setTimeout(() => {
      if (_loaded || _loading) return;
      load().then(ok => { if (ok) reattach(); });
    }, fromOnline ? 500 : 15000);
  }
  window.addEventListener('online', () => _scheduleRetry(true));

  // v252: Google calls this global on key/billing/referrer problems AFTER the
  // script itself loaded — the one failure shape that used to die with no
  // signal at all (it named the Geocoding-API outage only in the console).
  window.gm_authFailure = () => {
    console.warn('purpl CRM: Google Maps rejected the API key (auth/billing/referrer).');
    if (typeof toast === 'function') {
      toast('⚠️ Address suggestions unavailable — Google Maps key problem (check APIs & billing in Google Cloud).', 9000);
    }
  };

  // ── Load Google Maps JS API with Places library ───────
  function load() {
    // v252 gate F2: removing a timed-out script tag does NOT abort its
    // in-flight fetch — a slow connection can execute it late, making the
    // API live while our state says failed. Never inject a second copy
    // (Google warns, and duplicate includes can corrupt Places widgets).
    if (!_loaded && window.google?.maps?.places) _loaded = true;
    if (_loaded)  return Promise.resolve(true);
    if (_loading) return _loading;

    if (!KEY) {
      console.info(
        'purpl CRM: Address autocomplete disabled.\n' +
        'Add window.GOOGLE_PLACES_KEY to firebase-config.js to enable it.\n' +
        'See places.js for setup instructions.'
      );
      return Promise.resolve(false);
    }

    _loading = new Promise(resolve => {
      // v252: every failure shape funnels here. The old loader only recovered
      // from onerror — a request that HUNG, or a script that loaded but never
      // called the ready-callback, left the cached promise pending for the
      // tab's whole life, so autocomplete stayed dead until a full page
      // reload. Now: settle once, clear the cache so the next load() (modal
      // open, retry timer, back-online) starts fresh, and self-heal quietly.
      let settled = false;
      const s = document.createElement('script');
      const fail = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.warn('purpl CRM: Google Places API failed to load (' + why + ').');
        _loading = null;
        try { s.remove(); } catch (_) {}
        if (!_failToastShown && typeof toast === 'function') {
          _failToastShown = true;
          toast('Address suggestions didn\'t load — retrying in the background.', 5000);
        }
        _scheduleRetry(false);
        resolve(false);
      };
      const timer = setTimeout(() => fail('timeout'), 10000);
      window.__purplPlacesReady = () => {
        // v252 gate F2: a LATE arrival (after the watchdog already failed
        // this attempt) still means the API is live now — record that so the
        // next load() returns instantly instead of double-including.
        if (settled) { _loaded = true; return; }
        settled = true;
        clearTimeout(timer);
        _loaded = true;
        _autoRetries = 0;
        resolve(true);
      };
      // v252: v=quarterly pins Google's slow channel (weekly updates landed
      // silently); loading=async is their blessed pattern for callback loads.
      s.src     = `https://maps.googleapis.com/maps/api/js?key=${KEY}&v=quarterly&loading=async&libraries=places&callback=__purplPlacesReady`;
      s.async   = true;
      s.defer   = true;
      s.onerror = () => fail('network');
      document.head.appendChild(s);
    });

    return _loading;
  }

  // ── Attach Places Autocomplete to one input element ───
  //   Stores selected lat/lng in el.dataset.lat / el.dataset.lng.
  //   Safe to call multiple times (idempotent via _placesAttached flag).
  function attach(inputEl) {
    if (!inputEl) return;
    if (inputEl._placesAttached) return;   // already done
    if (!window.google?.maps?.places) return;

    inputEl._placesAttached = true;

    const ac = new google.maps.places.Autocomplete(inputEl, {
      componentRestrictions: { country: 'us' },
      fields: ['formatted_address', 'geometry', 'address_components'],
    });

    // On selection: fill address + store coords
    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (!place?.geometry) return;

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();

      inputEl.dataset.lat = lat;
      inputEl.dataset.lng = lng;

      // Structured components: ShipStation (and anything else that needs
      // street/city/state/zip) should never have to re-parse a free-text
      // address string that Google already broke apart for us.
      if (Array.isArray(place.address_components)) {
        const get = (type, short) => {
          const c = place.address_components.find(x => (x.types || []).includes(type));
          return c ? (short ? c.short_name : c.long_name) : '';
        };
        const parts = {
          street1: [get('street_number'), get('route')].filter(Boolean).join(' '),
          street2: get('subpremise'),
          city: get('locality') || get('postal_town') || get('sublocality') || get('administrative_area_level_3'),
          state: get('administrative_area_level_1', true),
          zip: get('postal_code'),
        };
        if (parts.street1 || parts.city) inputEl.dataset.addrParts = JSON.stringify(parts);
      }

      // Fill in the clean formatted address
      if (place.formatted_address) {
        inputEl.value = place.formatted_address;
      }

      // Trigger any existing oninput listeners
      inputEl.dispatchEvent(new Event('addressSelected', { bubbles: true }));
    });

    // If user edits manually after autocomplete, clear stored coords
    // so we fall back to geocoding on save
    inputEl.addEventListener('input', () => {
      delete inputEl.dataset.lat;
      delete inputEl.dataset.lng;
      delete inputEl.dataset.addrParts;
    });
  }

  // ── Geocode a plain address string → {lat, lng, formatted} ──
  async function geocode(address) {
    if (!address?.trim()) return null;
    if (!window.google?.maps?.Geocoder) return null;

    return new Promise(resolve => {
      new google.maps.Geocoder().geocode(
        { address: address.trim(), componentRestrictions: { country: 'us' } },
        (results, status) => {
          if (status === 'OK' && results[0]) {
            resolve({
              lat:       results[0].geometry.location.lat(),
              lng:       results[0].geometry.location.lng(),
              formatted: results[0].formatted_address,
            });
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  // ── Get coords for an address input ──────────────────
  //   Uses stored autocomplete coords if available;
  //   falls back to geocoding the typed value.
  async function getCoords(inputEl) {
    if (!inputEl) return null;
    if (inputEl.dataset.lat) {
      return {
        lat: parseFloat(inputEl.dataset.lat),
        lng: parseFloat(inputEl.dataset.lng),
      };
    }
    const val = inputEl.value?.trim();
    if (!val) return null;
    return await geocode(val);
  }

  // ── IDs of all address inputs in the app ─────────────
  const ADDRESS_FIELD_IDS = [
    'eac-address',     // Edit Account form
    'epr-address',     // Edit Prospect form
    'del-stop-addr',   // Orders & Delivery — Route Builder add stop
    'loc-address',     // Inventory Locations — add location form
    'ws-address',      // Wholesale application form (public-facing)
    'stk-address',     // Settings — Where to Find Us extra locations
  ];

  // ── Attach to all known address fields ───────────────
  function reattach() {
    if (!_loaded) return;
    ADDRESS_FIELD_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) attach(el);
    });
  }

  // ── Init: load API then attach to all fields ─────────
  async function initAll() {
    const ok = await load();
    if (!ok) return;
    reattach();
  }

  // ── Public API ────────────────────────────────────────
  window.PlacesAC = { load, attach, geocode, getCoords, initAll, reattach };
})();
