// RigCheck 3D v0.3 — optional persistent Firebase Authentication.
// The viewer remains local-first; auth only enables cloud features when the user chooses to sign in.
(() => {
  const firebaseConfig = {
    apiKey: "AIzaSyDpXmQbxQ0NzY-oTI9lfdxi7DO5MMXZdYg",
    authDomain: "rigcheck-cfbe3.firebaseapp.com",
    projectId: "rigcheck-cfbe3",
    storageBucket: "rigcheck-cfbe3.firebasestorage.app",
    messagingSenderId: "384535133161",
    appId: "1:384535133161:web:97604909523e84675d6978",
    measurementId: "G-KL9Q38WL3S"
  };

  const topActions = document.querySelector('.top-actions');
  const privacyPill = document.querySelector('.privacy-pill');
  if (!topActions) return;

  const accountButton = document.createElement('button');
  accountButton.id = 'accountButton';
  accountButton.className = 'button ghost account-button';
  accountButton.type = 'button';
  accountButton.textContent = 'Cloud';
  accountButton.setAttribute('aria-haspopup', 'dialog');
  topActions.insertBefore(accountButton, topActions.firstChild);

  const overlay = document.createElement('div');
  overlay.id = 'accountOverlay';
  overlay.className = 'account-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="account-card" role="dialog" aria-modal="true" aria-labelledby="accountTitle">
      <div class="account-card-head">
        <div>
          <span class="eyebrow">RIGCHECK CLOUD</span>
          <h2 id="accountTitle">Your account</h2>
        </div>
        <button class="account-close" id="accountClose" type="button" aria-label="Close account panel">×</button>
      </div>
      <div class="account-state" id="accountState">
        <div class="account-avatar" id="accountAvatar" aria-hidden="true">R</div>
        <div class="account-copy">
          <strong id="accountName">Loading…</strong>
          <span id="accountEmail">Checking saved sign-in</span>
        </div>
      </div>
      <p class="account-note" id="accountNote">RigCheck still works locally without an account. Sign in once to enable your cloud model library and keep the session on this device.</p>
      <button class="button primary wide" id="googleSignIn" type="button">Continue with Google</button>
      <button class="button secondary wide" id="signOutButton" type="button" hidden>Sign out</button>
      <button class="text-button account-local" id="continueLocal" type="button">Continue locally</button>
      <p class="account-error" id="accountError" role="status" aria-live="polite"></p>
    </section>
  `;
  document.body.appendChild(overlay);

  const closeButton = overlay.querySelector('#accountClose');
  const continueLocal = overlay.querySelector('#continueLocal');
  const signInButton = overlay.querySelector('#googleSignIn');
  const signOutButton = overlay.querySelector('#signOutButton');
  const accountName = overlay.querySelector('#accountName');
  const accountEmail = overlay.querySelector('#accountEmail');
  const accountAvatar = overlay.querySelector('#accountAvatar');
  const accountNote = overlay.querySelector('#accountNote');
  const accountError = overlay.querySelector('#accountError');

  let authApi = null;
  let auth = null;
  let currentUser = null;

  function openOverlay() {
    overlay.hidden = false;
    document.body.classList.add('account-open');
    closeButton?.focus();
  }

  function closeOverlay() {
    overlay.hidden = true;
    document.body.classList.remove('account-open');
    accountButton.focus();
  }

  function initials(user) {
    const label = user?.displayName || user?.email || 'R';
    const parts = label.trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : label.slice(0, 1)).toUpperCase();
  }

  function renderUser(user) {
    currentUser = user || null;
    accountError.textContent = '';

    if (user) {
      accountButton.textContent = user.displayName?.split(' ')[0] || 'Account';
      accountButton.classList.add('signed-in');
      if (privacyPill) privacyPill.textContent = 'Cloud ready';
      accountName.textContent = user.displayName || 'Signed in';
      accountEmail.textContent = user.email || 'Firebase account';
      accountAvatar.textContent = initials(user);
      accountNote.textContent = 'You are signed in on this device. RigCheck will restore this session automatically on future launches.';
      signInButton.hidden = true;
      signOutButton.hidden = false;
      continueLocal.hidden = true;
    } else {
      accountButton.textContent = 'Cloud';
      accountButton.classList.remove('signed-in');
      if (privacyPill) privacyPill.textContent = 'Local only';
      accountName.textContent = 'Not signed in';
      accountEmail.textContent = 'Local inspection still works';
      accountAvatar.textContent = 'R';
      accountNote.textContent = 'Sign in once to enable your cloud model library. Firebase will remember the session on this device afterward.';
      signInButton.hidden = false;
      signOutButton.hidden = true;
      continueLocal.hidden = false;
    }
  }

  accountButton.addEventListener('click', openOverlay);
  closeButton?.addEventListener('click', closeOverlay);
  continueLocal?.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeOverlay();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) closeOverlay();
  });

  signInButton?.addEventListener('click', async () => {
    if (!authApi || !auth) {
      accountError.textContent = 'Cloud sign-in is still loading. Try again in a moment.';
      return;
    }

    accountError.textContent = '';
    signInButton.disabled = true;
    signInButton.textContent = 'Opening Google…';

    try {
      const provider = new authApi.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authApi.signInWithPopup(auth, provider);
    } catch (error) {
      const code = error?.code || '';
      if (code === 'auth/unauthorized-domain') {
        accountError.textContent = 'This GitHub Pages domain must be added to Firebase Authentication → Settings → Authorized domains.';
      } else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        accountError.textContent = 'Sign-in was cancelled.';
      } else if (code === 'auth/popup-blocked') {
        accountError.textContent = 'The Google sign-in window was blocked. Try again directly from the Home Screen app.';
      } else {
        console.error('RigCheck sign-in error:', error);
        accountError.textContent = 'Could not sign in with Google. Check the Firebase Authentication settings and try again.';
      }
    } finally {
      signInButton.disabled = false;
      signInButton.textContent = 'Continue with Google';
    }
  });

  signOutButton?.addEventListener('click', async () => {
    if (!authApi || !auth) return;
    signOutButton.disabled = true;
    try {
      await authApi.signOut(auth);
    } catch (error) {
      console.error('RigCheck sign-out error:', error);
      accountError.textContent = 'Could not sign out. Try again.';
    } finally {
      signOutButton.disabled = false;
    }
  });

  async function initFirebaseAuth() {
    try {
      const [appApi, loadedAuthApi] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js')
      ]);

      authApi = loadedAuthApi;
      const app = appApi.getApps().length ? appApi.getApp() : appApi.initializeApp(firebaseConfig);
      auth = authApi.getAuth(app);

      // Explicit local persistence = sign in once, then restore automatically on this browser/PWA installation.
      await authApi.setPersistence(auth, authApi.browserLocalPersistence);
      authApi.onAuthStateChanged(auth, renderUser, (error) => {
        console.error('RigCheck auth state error:', error);
        renderUser(null);
      });
    } catch (error) {
      console.warn('RigCheck cloud auth unavailable; local viewer remains usable.', error);
      renderUser(null);
      accountEmail.textContent = 'Cloud unavailable · local mode active';
      accountError.textContent = navigator.onLine ? 'Firebase Authentication could not load.' : 'Offline mode — cloud sign-in will return when you reconnect.';
    }
  }

  renderUser(null);
  initFirebaseAuth();

  // Expose only the current authenticated identity for later Storage/Firestore modules.
  window.RigCheckAuth = {
    get user() {
      return currentUser;
    },
    get auth() {
      return auth;
    },
    open: openOverlay
  };
})();
