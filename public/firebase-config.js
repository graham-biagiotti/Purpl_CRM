// Firebase project configuration for purpl CRM
// This file is safe to commit — API keys for Firebase web apps
// are designed to be public. Security is enforced by Firestore rules.

// ── Google Places API Key (Phase 3 — Address Autocomplete) ──────────────
// To enable address autocomplete on all address fields:
//  1. Go to console.cloud.google.com → your project
//  2. APIs & Services → Enable APIs → Enable "Places API" and "Maps JavaScript API"
//  3. APIs & Services → Credentials → + Create Credentials → API Key
//  4. Restrict key to: Places API + Maps JavaScript API + your domain
//  5. Paste the key below:
window.GOOGLE_PLACES_KEY = '';  // <-- paste your key here

// ── Shared team account ──────────────────────────────────────────────────────
// Create ONE Firebase Auth account (e.g. in the Firebase console) and put its
// email here. Everyone on the team enters only the shared password to log in.
// Steps: Firebase console → Authentication → Add user → set email + password
window.TEAM_EMAIL = 'team@purplbeverage.com'; // <-- change to your team email

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBbEQ1wV7MwJJjSC9_EalYxHMvTjHklwFY",
  authDomain: "purpl-crm.firebaseapp.com",
  projectId: "purpl-crm",
  storageBucket: "purpl-crm.firebasestorage.app",
  messagingSenderId: "805074818841",
  appId: "1:805074818841:web:69655531888bd5904d5788"
};
