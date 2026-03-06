// ═══════════════════════════════════════════════════════
//  auth.js  —  Google Sign-In + app boot sequence
// ═══════════════════════════════════════════════════════

async function bootApp() {
  const { initializeApp } = window.FirebaseAppAPI;
  const { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } = window.FirebaseAuthAPI;
  const { getFirestore, enableIndexedDbPersistence } = window.FirestoreAPI;

  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = getAuth(app);
  const db = getFirestore(app);

  // Enable offline persistence (critical for delivery runs)
  try {
    await enableIndexedDbPersistence(db);
  } catch(e) {
    // Will fail if multiple tabs open — that's fine
    if (e.code !== 'failed-precondition' && e.code !== 'unimplemented') {
      console.warn('Offline persistence unavailable:', e);
    }
  }

  const authScreen   = document.getElementById('auth-screen');
  const loadingScreen = document.getElementById('loading-screen');
  const appShell     = document.getElementById('app-shell');
  const authStatus   = document.getElementById('auth-status');
  const signInBtn    = document.getElementById('sign-in-btn');
  const signOutBtn   = document.getElementById('sign-out-btn');

  // Sign-in button — shared team password only
  const doSignIn = async () => {
    const password = document.getElementById('auth-password')?.value;
    if (!password) { authStatus.textContent = 'Enter the team password.'; return; }
    authStatus.textContent = 'Signing in…';
    signInBtn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, window.TEAM_EMAIL, password);
    } catch(e) {
      const msgs = {
        'auth/invalid-credential': 'Incorrect password.',
        'auth/wrong-password':     'Incorrect password.',
        'auth/too-many-requests':  'Too many attempts — try again later.',
      };
      authStatus.textContent = msgs[e.code] || 'Sign-in failed. Please try again.';
      signInBtn.disabled = false;
    }
  };
  signInBtn.addEventListener('click', doSignIn);
  // Allow pressing Enter in the password field
  document.getElementById('auth-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });

  // Sign-out button (in sidebar)
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      if (!confirm('Sign out of purpl CRM?')) return;
      await signOut(auth);
    });
  }

  // Auth state listener — runs on every page load
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Signed in — show loading, init DB, show app
      authScreen.style.display = 'none';
      loadingScreen.style.display = 'flex';
      appShell.style.display = 'none';

      // Init DB with Firebase
      await DB.init(user.uid, db);

      // Show migration banner if old localStorage data exists
      checkMigration();

      loadingScreen.style.display = 'none';
      appShell.style.display = 'flex';

      // Boot the app
      window.onAppReady();

    } else {
      // Signed out — show auth screen
      authScreen.style.display = 'flex';
      loadingScreen.style.display = 'none';
      appShell.style.display = 'none';
      authStatus.textContent = '';
    }
  });
}

function checkMigration() {
  const PFX = 'pcrm5_';
  const hasOldData = ['ac','pr','iv','ord'].some(k => {
    try {
      const v = localStorage.getItem(PFX + k);
      return v && JSON.parse(v).length > 0;
    } catch(e) { return false; }
  });
  const alreadyMigrated = localStorage.getItem('purpl_migrated');
  if (hasOldData && !alreadyMigrated) {
    showMigrationBanner();
  }
}

function showMigrationBanner() {
  const existing = document.getElementById('migrate-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'migrate-banner';
  banner.className = 'migrate-banner';
  banner.innerHTML = `
    <div>
      <strong>Import your existing data</strong>
      <p>We found existing purpl CRM data on this device. Import it to your cloud account now.</p>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button class="btn primary" onclick="runMigration()">Import Data</button>
      <button class="btn" onclick="dismissMigration()">Dismiss</button>
    </div>
  `;
  const dashPage = document.getElementById('page-dashboard');
  if (dashPage) dashPage.insertBefore(banner, dashPage.firstChild);
}

async function runMigration() {
  const btn = document.querySelector('#migrate-banner .btn.primary');
  if (btn) { btn.textContent = 'Importing…'; btn.disabled = true; }
  try {
    const count = await DB.importFromLocalStorage();
    localStorage.setItem('purpl_migrated', '1');
    const banner = document.getElementById('migrate-banner');
    if (banner) banner.remove();
    toast(`Imported ${count} records from your old data!`);
    renderDash();
  } catch(e) {
    toast('Import failed — please try again.');
    console.error(e);
  }
}

function dismissMigration() {
  localStorage.setItem('purpl_migrated', '1');
  const banner = document.getElementById('migrate-banner');
  if (banner) banner.remove();
}

// Boot when DOM is ready
document.addEventListener('DOMContentLoaded', bootApp);
