// Firebase configuration for STAGING environment
// ─────────────────────────────────────────────────────────────────────────────
// SETUP INSTRUCTIONS (one-time):
//
//  1. Go to console.firebase.google.com
//  2. Click "Add project" → name it "purpl-crm-staging"
//  3. Disable Google Analytics (not needed for staging) → Create project
//  4. In the new project:
//       Build → Firestore Database → Create database → Start in production mode
//       Build → Authentication → Get started → enable Google sign-in
//       Build → Hosting → Get started (click through the steps)
//  5. Go to Project Settings (gear icon) → General → scroll to "Your apps"
//  6. Click "Add app" → Web (</>)  → register as "purpl-crm-staging"
//  7. Copy the firebaseConfig values below from the snippet Firebase shows you
//  8. In Firestore → Rules → paste in the same rules from production (firestore.rules)
//  9. In Authentication → Settings → Authorized domains → add your staging domain
// 10. Run: npm run deploy:staging
// ─────────────────────────────────────────────────────────────────────────────

window.GOOGLE_PLACES_KEY = '';  // optional — paste key here if you want address autocomplete in staging
window.OLD_OWNER_UID = '';

window.FIREBASE_CONFIG = {
  apiKey:            "AIzaSyA8C177ja3e-npoyL_NluL8rNw705R1rB0",
  authDomain:        "purpl-crm-staging.firebaseapp.com",
  projectId:         "purpl-crm-staging",
  storageBucket:     "purpl-crm-staging.firebasestorage.app",
  messagingSenderId: "112798197802",
  appId:             "1:112798197802:web:547101ee18ecf221303b53"
};
