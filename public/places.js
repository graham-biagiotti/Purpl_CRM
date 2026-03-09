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

  // ── Load Google Maps JS API with Places library ───────
  function load() {
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
      const s    = document.createElement('script');
      s.src      = `https://maps.googleapis.com/maps/api/js?key=${KEY}&libraries=places&loading=async`;
      s.async    = true;
      s.defer    = true;
      s.onload   = () => { _loaded = true; resolve(true); };
      s.onerror  = () => {
        console.warn('purpl CRM: Google Places API failed to load. Check your API key and billing.');
        resolve(false);
      };
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
      fields: ['formatted_address', 'geometry'],
    });

    // On selection: fill address + store coords
    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (!place?.geometry) return;

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();

      inputEl.dataset.lat = lat;
      inputEl.dataset.lng = lng;

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
