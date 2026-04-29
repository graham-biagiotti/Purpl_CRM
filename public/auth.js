// ═══════════════════════════════════════════════════════
//  auth.js  —  Google + Email/Password Sign-In
// ═══════════════════════════════════════════════════════

async function bootApp() {
  const { initializeApp } = window.FirebaseAppAPI;
  const { getAuth, onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword, GoogleAuthProvider, signOut } = window.FirebaseAuthAPI;
  const { getFirestore, enableIndexedDbPersistence } = window.FirestoreAPI;

  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = getAuth(app);
  const db = getFirestore(app);

  // Emulator connection is handled ONLY by test infrastructure
  // (global-setup.js sets FIRESTORE_EMULATOR_HOST for Node.js admin SDK).
  // The browser app NEVER connects to emulators — it always talks to
  // whichever project is in FIREBASE_CONFIG (prod or staging).
  // This prevents any possibility of test code affecting production data.

  try {
    await enableIndexedDbPersistence(db);
  } catch(e) {
    if (e.code !== 'failed-precondition' && e.code !== 'unimplemented') {
      console.warn('Offline persistence unavailable:', e);
    }
  }

  const authScreen    = document.getElementById('auth-screen');
  const loadingScreen = document.getElementById('loading-screen');
  const appShell      = document.getElementById('app-shell');
  const authStatus    = document.getElementById('auth-status');
  const googleBtn     = document.getElementById('google-sign-in-btn');
  const signInBtn     = document.getElementById('sign-in-btn');
  const emailInput    = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  const signOutBtn    = document.getElementById('sign-out-btn');

  googleBtn.addEventListener('click', async () => {
    authStatus.textContent = 'Opening Google sign-in…';
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch(e) {
      authStatus.textContent = 'Sign-in failed. Please try again.';
      console.error(e);
    }
  });

  signInBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      authStatus.textContent = 'Please enter your email and password.';
      return;
    }
    authStatus.textContent = 'Signing in…';
    signInBtn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch(e) {
      authStatus.textContent = 'Error: ' + (e.code || e.message);
      signInBtn.disabled = false;
      console.error(e);
    }
  });

  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') signInBtn.click();
  });

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      if (!confirm('Sign out of purpl CRM?')) return;
      await signOut(auth);
    });
  }

  onAuthStateChanged(auth, async (user) => {
    window._currentUser = user || null;
    if (user) {
      authScreen.style.display = 'none';
      loadingScreen.style.display = 'flex';
      appShell.style.display = 'none';

      const slowTimer = setTimeout(() => {
        const el = loadingScreen.querySelector('p') || loadingScreen;
        el.textContent = 'Loading is slow — check your connection…';
      }, 10000);

      try {
        await DB.init(user.uid, db);
      } catch(e) {
        clearTimeout(slowTimer);
        console.error('DB init failed:', e);
        const el = loadingScreen.querySelector('p') || loadingScreen;
        el.textContent = 'Unable to load data. Check your internet and refresh the page.';
        return;
      }
      clearTimeout(slowTimer);

      // Ensure a users/{uid} doc exists for role-based access control
      try {
        const { doc, getDoc, setDoc } = window.FirestoreAPI;
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          await setDoc(userRef, {
            email: user.email || '',
            displayName: user.displayName || user.email?.split('@')[0] || '',
            role: 'admin',
            createdAt: new Date().toISOString(),
          });
        }
        window._userRole = userSnap.exists() ? userSnap.data().role : 'admin';
      } catch(e) {
        console.warn('User doc init failed:', e);
        window._userRole = 'employee';
      }

      checkMigration();

      loadingScreen.style.display = 'none';
      appShell.style.display = 'flex';

      window.onAppReady();

    } else {
      authScreen.style.display = 'flex';
      loadingScreen.style.display = 'none';
      appShell.style.display = 'none';
      authStatus.textContent = '';
      signInBtn.disabled = false;
    }
  });

  window.addEventListener('beforeunload', () => {
    if (typeof DB !== 'undefined' && DB._flushPendingSave) DB._flushPendingSave();
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

document.addEventListener('DOMContentLoaded', bootApp);
