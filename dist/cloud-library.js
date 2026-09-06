// RigCheck 3D v0.4 — Firebase Storage + Firestore model library.
// Models stay client-side while being inspected; Firebase only stores/syncs files and metadata.
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getBlob,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import {
  createCloudModelDocument,
  GLB_CONTENT_TYPE,
  MAX_GLB_BYTES,
  modelStoragePath,
  safeDisplayName
} from "./lib/model-schema.js";

const firebaseConfig = {
  apiKey: "AIzaSyDpXmQbxQ0NzY-oTI9lfdxi7DO5MMXZdYg",
  authDomain: "rigcheck-cfbe3.firebaseapp.com",
  projectId: "rigcheck-cfbe3",
  storageBucket: "rigcheck-cfbe3.firebasestorage.app",
  messagingSenderId: "384535133161",
  appId: "1:384535133161:web:97604909523e84675d6978",
  measurementId: "G-KL9Q38WL3S"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const CLOUD_DOWNLOAD_TIMEOUT_MS = 120000;
const VIEWER_LOAD_TIMEOUT_MS = 60000;

const topActions = document.querySelector('.top-actions');
const fileInput = document.querySelector('#fileInput');
const modelLabel = document.querySelector('#modelLabel');
const sourceLabel = document.querySelector('#sourceLabel');
const canvas = document.querySelector('#viewport');
const statsEls = {
  triangles: document.querySelector('#trianglesStat'),
  meshes: document.querySelector('#meshesStat'),
  bones: document.querySelector('#bonesStat'),
  clips: document.querySelector('#clipsStat'),
  size: document.querySelector('#sizeStat')
};

if (!topActions || !fileInput) {
  console.warn('RigCheck Cloud Library: required viewer controls were not found.');
} else {
  initCloudLibrary();
}

function initCloudLibrary() {
  let currentUser = null;
  let currentModels = [];
  let currentViewerGlb = null;
  let currentViewerSource = null;
  let cloudLoadInProgress = false;
  let busy = false;

  const libraryButton = document.createElement('button');
  libraryButton.id = 'libraryButton';
  libraryButton.className = 'button ghost library-button';
  libraryButton.type = 'button';
  libraryButton.textContent = 'Library';
  libraryButton.title = 'Cloud Model Library';

  const accountButton = document.querySelector('#accountButton');
  if (accountButton?.nextSibling) topActions.insertBefore(libraryButton, accountButton.nextSibling);
  else if (accountButton) topActions.appendChild(libraryButton);
  else topActions.insertBefore(libraryButton, topActions.firstChild);

  const overlay = document.createElement('div');
  overlay.id = 'cloudLibraryOverlay';
  overlay.className = 'cloud-library-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="cloud-library-card" role="dialog" aria-modal="true" aria-labelledby="cloudLibraryTitle">
      <header class="cloud-library-head">
        <div>
          <span class="eyebrow">RIGCHECK CLOUD</span>
          <h2 id="cloudLibraryTitle">Model Library</h2>
          <p id="cloudLibrarySubtitle">Your GLBs, synced across devices.</p>
        </div>
        <button class="cloud-library-close" id="cloudLibraryClose" type="button" aria-label="Close model library">×</button>
      </header>

      <div class="cloud-library-actions">
        <button class="button primary" id="saveCurrentCloud" type="button" disabled>Save to Library</button>
        <button class="button secondary" id="uploadCloudModel" type="button">Upload GLB</button>
        <input id="cloudUploadInput" type="file" accept=".glb,model/gltf-binary,application/octet-stream" hidden />
      </div>

      <div class="cloud-progress" id="cloudProgress" hidden>
        <div class="cloud-progress-copy">
          <strong id="cloudProgressLabel">Uploading…</strong>
          <span id="cloudProgressPercent">0%</span>
        </div>
        <div class="cloud-progress-track"><i id="cloudProgressBar"></i></div>
      </div>

      <div class="cloud-library-tools">
        <input class="cloud-search" id="cloudSearch" type="search" placeholder="Search models" autocomplete="off" />
        <button class="cloud-filter" id="favoriteFilter" type="button" aria-pressed="false" title="Show favorites only">★</button>
        <button class="cloud-filter" id="refreshLibrary" type="button" title="Refresh library">↻</button>
      </div>

      <p class="cloud-library-status" id="cloudLibraryStatus" role="status" aria-live="polite"></p>
      <div class="cloud-model-list" id="cloudModelList"></div>

      <footer class="cloud-library-foot">
        <span>GLBs are private to your signed-in Firebase account.</span>
        <button class="text-button" id="openCloudAccount" type="button">Account</button>
      </footer>
    </section>
  `;
  document.body.appendChild(overlay);

  const closeButton = overlay.querySelector('#cloudLibraryClose');
  const saveCurrentButton = overlay.querySelector('#saveCurrentCloud');
  const uploadButton = overlay.querySelector('#uploadCloudModel');
  const uploadInput = overlay.querySelector('#cloudUploadInput');
  const progress = overlay.querySelector('#cloudProgress');
  const progressLabel = overlay.querySelector('#cloudProgressLabel');
  const progressPercent = overlay.querySelector('#cloudProgressPercent');
  const progressBar = overlay.querySelector('#cloudProgressBar');
  const searchInput = overlay.querySelector('#cloudSearch');
  const favoriteFilter = overlay.querySelector('#favoriteFilter');
  const refreshButton = overlay.querySelector('#refreshLibrary');
  const status = overlay.querySelector('#cloudLibraryStatus');
  const list = overlay.querySelector('#cloudModelList');
  const openAccount = overlay.querySelector('#openCloudAccount');

  function openLibrary() {
    if (!currentUser) {
      window.RigCheckAuth?.open?.();
      return;
    }
    overlay.hidden = false;
    document.body.classList.add('cloud-library-open');
    renderModels();
    refreshModels();
  }

  function closeLibrary() {
    overlay.hidden = true;
    document.body.classList.remove('cloud-library-open');
    libraryButton.focus();
  }

  function setStatus(message = '', isError = false) {
    status.textContent = message;
    status.classList.toggle('error', Boolean(isError));
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    syncSaveCurrentButton();
    uploadButton.disabled = busy || !currentUser;
    refreshButton.disabled = busy || !currentUser;
  }

  function syncSaveCurrentButton() {
    const cloudModelIsOpen = currentViewerSource === 'cloud';
    saveCurrentButton.textContent = cloudModelIsOpen ? 'Save model to device' : 'Save to Library';
    saveCurrentButton.title = cloudModelIsOpen
      ? 'Download the complete GLB currently open in the viewer'
      : 'Upload the local GLB currently open in the viewer';
    saveCurrentButton.disabled = busy || !currentViewerGlb || !currentUser;
  }

  function setProgress(label, fraction = 0, visible = true) {
    progress.hidden = !visible;
    const indeterminate = fraction === null;
    progress.classList.toggle('indeterminate', indeterminate);
    if (indeterminate) {
      progressLabel.textContent = label;
      progressPercent.textContent = 'WORKING';
      progressBar.style.width = '32%';
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    progressLabel.textContent = label;
    progressPercent.textContent = `${pct}%`;
    progressBar.style.width = `${pct}%`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, unit);
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  }

  function numericStat(element) {
    const raw = element?.textContent?.trim() || '';
    if (!raw || raw === '—') return null;
    const value = Number(raw.replace(/,/g, '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(value) ? value : null;
  }

  function snapshotViewerStats() {
    return {
      triangles: numericStat(statsEls.triangles),
      meshes: numericStat(statsEls.meshes),
      bones: numericStat(statsEls.bones),
      clips: numericStat(statsEls.clips)
    };
  }

  function modelCollection(uid = currentUser?.uid) {
    return collection(db, 'users', uid, 'models');
  }

  function modelDoc(id, uid = currentUser?.uid) {
    return doc(db, 'users', uid, 'models', id);
  }

  function firebaseMessage(error) {
    const code = error?.code || '';
    if (code.includes('permission-denied') || code.includes('storage/unauthorized')) {
      return 'Firebase is connected, but the Firestore/Storage security rules still need to be published.';
    }
    if (code.includes('failed-precondition') || code.includes('not-found')) {
      return 'Create the Firestore database and Cloud Storage bucket for this Firebase project, then try again.';
    }
    if (code === 'rigcheck/download-timeout') {
      return 'The model download timed out. Check your connection and try again.';
    }
    if (code.includes('storage/download-size-exceeded')) {
      return 'That cloud model exceeds RigCheck\'s 200 MB download limit.';
    }
    if (code.includes('storage/quota-exceeded')) return 'Firebase Storage quota was exceeded.';
    if (!navigator.onLine) return 'You are offline. Local RigCheck still works; cloud actions need a connection.';
    return error?.message ? `Cloud error: ${error.message}` : 'RigCheck Cloud could not complete that action.';
  }

  function uploadTaskPromise(task, label) {
    return new Promise((resolve, reject) => {
      task.on('state_changed', (snapshot) => {
        const fraction = snapshot.totalBytes ? snapshot.bytesTransferred / snapshot.totalBytes : 0;
        setProgress(label, fraction, true);
      }, reject, () => resolve(task.snapshot));
    });
  }

  async function captureThumbnail(modelId) {
    if (!canvas || !currentUser) return null;
    const blob = await new Promise((resolve) => {
      try {
        canvas.toBlob(resolve, 'image/webp', 0.78);
      } catch {
        resolve(null);
      }
    });
    if (!blob || blob.size > 5 * 1024 * 1024) return null;
    const path = `users/${currentUser.uid}/thumbnails/${modelId}.webp`;
    const task = uploadBytesResumable(storageRef(storage, path), blob, { contentType: 'image/webp' });
    await uploadTaskPromise(task, 'Saving preview…');
    return path;
  }

  async function waitForViewer(fileName, timeoutMs = VIEWER_LOAD_TIMEOUT_MS) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (modelLabel?.textContent === fileName && sourceLabel?.textContent === 'LOCAL FILE') {
        await new Promise((resolve) => setTimeout(resolve, 180));
        return true;
      }
      if (sourceLabel?.textContent === 'LOAD FAILED') return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async function downloadModelBlob(model) {
    const expectedBytes = Number(model.sizeBytes);
    if (Number.isFinite(expectedBytes) && expectedBytes > MAX_GLB_BYTES) {
      const error = new Error('Cloud model exceeds the download limit.');
      error.code = 'storage/download-size-exceeded';
      throw error;
    }

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error('Cloud model download timed out.');
        error.code = 'rigcheck/download-timeout';
        reject(error);
      }, CLOUD_DOWNLOAD_TIMEOUT_MS);
    });

    setProgress(`Downloading ${model.name || model.originalName || 'model'}…`, null, true);
    try {
      return await Promise.race([
        getBlob(storageRef(storage, model.storagePath), MAX_GLB_BYTES),
        timeout
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function loadFileIntoViewer(file, source = 'LOCAL FILE') {
    cloudLoadInProgress = source === 'RIGCHECK CLOUD';
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      const loaded = await waitForViewer(file.name);
      if (loaded && sourceLabel) sourceLabel.textContent = source;
      return loaded;
    } finally {
      setTimeout(() => { cloudLoadInProgress = false; }, 0);
    }
  }

  async function saveCurrentModel() {
    if (!currentViewerGlb || busy) return;
    if (currentViewerSource !== 'cloud') {
      await uploadModel(currentViewerGlb);
      return;
    }

    await saveFileToDevice(currentViewerGlb);
  }

  async function saveFileToDevice(file) {
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: file.name });
        setStatus(`${file.name} was sent to the destination you chose.`);
        return true;
      }
    } catch (error) {
      if (error?.name === 'AbortError') return false;
      console.warn('RigCheck model share fell back to a download:', error);
    }

    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name || 'rigcheck-model.glb';
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(`${link.download} was saved to your downloads.`);
    return true;
  }

  async function downloadCloudModel(model) {
    if (!currentUser || busy) return;
    setBusy(true);
    setStatus(`Downloading ${model.name || model.originalName || 'model'}…`);
    try {
      const blob = await downloadModelBlob(model);
      setProgress('Preparing model file…', 1, true);
      const file = new File([blob], model.originalName || `${model.name || 'model'}.glb`, {
        type: model.contentType || blob.type || 'model/gltf-binary'
      });
      await saveFileToDevice(file);
    } catch (error) {
      console.error('RigCheck cloud model save error:', error);
      setStatus(firebaseMessage(error), true);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress('', 0, false), 700);
    }
  }

  async function uploadModel(file, { loadFirst = false } = {}) {
    if (!currentUser || busy) return;
    if (!file || !/\.glb$/i.test(file.name)) {
      setStatus('Cloud Library currently accepts self-contained .glb files only.', true);
      return;
    }
    if (file.size > MAX_GLB_BYTES) {
      setStatus(`That GLB is ${formatBytes(file.size)}. RigCheck currently caps cloud uploads at 200 MB.`, true);
      return;
    }

    setBusy(true);
    setStatus('');
    let modelId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const modelPath = modelStoragePath(currentUser.uid, modelId, file.name);

    try {
      if (loadFirst) {
        await loadFileIntoViewer(file, 'LOCAL FILE');
      }

      const task = uploadBytesResumable(storageRef(storage, modelPath), file, {
        contentType: GLB_CONTENT_TYPE,
        customMetadata: { originalName: file.name }
      });
      await uploadTaskPromise(task, `Uploading ${file.name}…`);

      const stats = snapshotViewerStats();
      let thumbnailPath = null;
      try {
        thumbnailPath = await captureThumbnail(modelId);
      } catch (thumbnailError) {
        console.warn('RigCheck thumbnail upload skipped:', thumbnailError);
      }

      setProgress('Saving model info…', 1, true);
      await setDoc(modelDoc(modelId), createCloudModelDocument({
        modelId,
        originalName: file.name,
        storagePath: modelPath,
        sizeBytes: file.size,
        triangles: stats.triangles,
        meshes: stats.meshes,
        bones: stats.bones,
        clips: stats.clips,
        thumbnailPath,
        sha256: null,
        timestamp: serverTimestamp()
      }));

      setStatus(`${file.name} is saved to your Cloud Library.`);
      await refreshModels();
    } catch (error) {
      console.error('RigCheck cloud upload error:', error);
      setStatus(firebaseMessage(error), true);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress('', 0, false), 700);
    }
  }

  async function refreshModels() {
    if (!currentUser) return;
    setStatus('Loading library…');
    refreshButton.classList.add('spinning');
    try {
      const snapshot = await getDocs(query(modelCollection(), orderBy('updatedAt', 'desc')));
      currentModels = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
      setStatus(currentModels.length ? `${currentModels.length} model${currentModels.length === 1 ? '' : 's'} in your library.` : 'Your Cloud Library is empty.');
      renderModels();
    } catch (error) {
      console.error('RigCheck cloud library read error:', error);
      currentModels = [];
      renderModels();
      setStatus(firebaseMessage(error), true);
    } finally {
      refreshButton.classList.remove('spinning');
    }
  }

  async function openCloudModel(model) {
    if (!currentUser || busy) return;
    setBusy(true);
    setStatus(`Downloading ${model.name || model.originalName || 'model'}…`);
    try {
      const blob = await downloadModelBlob(model);
      setStatus(`Opening ${model.name || model.originalName || 'model'}…`);
      setProgress('Opening model…', 1, true);
      const file = new File([blob], model.originalName || `${model.name || 'model'}.glb`, {
        type: model.contentType || blob.type || 'model/gltf-binary'
      });
      const loaded = await loadFileIntoViewer(file, 'RIGCHECK CLOUD');
      if (!loaded) throw new Error('The downloaded GLB could not be opened by the viewer.');
      await updateDoc(modelDoc(model.id), {
        lastOpenedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      closeLibrary();
    } catch (error) {
      console.error('RigCheck cloud model open error:', error);
      setStatus(firebaseMessage(error), true);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress('', 0, false), 700);
    }
  }

  async function renameModel(model) {
    const next = window.prompt('Model name', model.name || safeDisplayName(model.originalName || 'model.glb'));
    if (!next?.trim() || next.trim() === model.name) return;
    try {
      await updateDoc(modelDoc(model.id), { name: next.trim(), updatedAt: serverTimestamp() });
      model.name = next.trim();
      renderModels();
      setStatus('Model renamed.');
    } catch (error) {
      setStatus(firebaseMessage(error), true);
    }
  }

  async function toggleFavorite(model) {
    const next = !model.favorite;
    model.favorite = next;
    renderModels();
    try {
      await updateDoc(modelDoc(model.id), { favorite: next, updatedAt: serverTimestamp() });
    } catch (error) {
      model.favorite = !next;
      renderModels();
      setStatus(firebaseMessage(error), true);
    }
  }

  async function deleteModel(model) {
    if (!window.confirm(`Delete “${model.name || model.originalName}” from your Cloud Library?`)) return;
    setBusy(true);
    try {
      await deleteObject(storageRef(storage, model.storagePath));
      if (model.thumbnailPath) {
        try { await deleteObject(storageRef(storage, model.thumbnailPath)); } catch (error) { console.warn(error); }
      }
      await deleteDoc(modelDoc(model.id));
      currentModels = currentModels.filter((item) => item.id !== model.id);
      renderModels();
      setStatus('Model deleted.');
    } catch (error) {
      console.error('RigCheck cloud delete error:', error);
      setStatus(firebaseMessage(error), true);
    } finally {
      setBusy(false);
    }
  }

  function createStat(label, value) {
    const span = document.createElement('span');
    span.textContent = `${label} ${value ?? '—'}`;
    return span;
  }

  function renderModels() {
    list.replaceChildren();
    const search = searchInput.value.trim().toLowerCase();
    const favoritesOnly = favoriteFilter.getAttribute('aria-pressed') === 'true';
    const filtered = currentModels.filter((model) => {
      const matchesSearch = !search || `${model.name || ''} ${model.originalName || ''}`.toLowerCase().includes(search);
      return matchesSearch && (!favoritesOnly || model.favorite);
    });

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'cloud-empty';
      empty.innerHTML = currentModels.length
        ? '<strong>No matching models.</strong><span>Try a different search or favorite filter.</span>'
        : '<strong>No cloud models yet.</strong><span>Open a GLB and tap “Save current model,” or upload one here.</span>';
      list.appendChild(empty);
      return;
    }

    for (const model of filtered) {
      const card = document.createElement('article');
      card.className = 'cloud-model-card';

      const preview = document.createElement('button');
      preview.className = 'cloud-model-preview';
      preview.type = 'button';
      preview.title = 'Open model';
      preview.addEventListener('click', () => openCloudModel(model));
      const previewFallback = document.createElement('span');
      previewFallback.textContent = '3D';
      preview.appendChild(previewFallback);
      if (model.thumbnailPath) {
        getDownloadURL(storageRef(storage, model.thumbnailPath)).then((url) => {
          const image = new Image();
          image.alt = '';
          image.loading = 'lazy';
          image.src = url;
          image.onload = () => preview.replaceChildren(image);
        }).catch(() => {});
      }

      const body = document.createElement('div');
      body.className = 'cloud-model-body';
      const name = document.createElement('strong');
      name.textContent = model.name || safeDisplayName(model.originalName || 'model.glb');
      const fileMeta = document.createElement('span');
      fileMeta.className = 'cloud-model-file';
      fileMeta.textContent = `${model.originalName || 'model.glb'} · ${formatBytes(model.sizeBytes)}`;
      const statRow = document.createElement('div');
      statRow.className = 'cloud-model-stats';
      statRow.append(
        createStat('△', model.triangles),
        createStat('Bones', model.bones),
        createStat('Clips', model.clips)
      );
      body.append(name, fileMeta, statRow);

      const actions = document.createElement('div');
      actions.className = 'cloud-model-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open';
      open.className = 'cloud-mini-button primary';
      open.addEventListener('click', () => openCloudModel(model));
      const download = document.createElement('button');
      download.type = 'button';
      download.textContent = '↓';
      download.className = 'cloud-mini-button icon';
      download.title = 'Save full GLB to device';
      download.setAttribute('aria-label', `Save ${model.name || model.originalName || 'model'} to device`);
      download.addEventListener('click', () => downloadCloudModel(model));
      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.textContent = model.favorite ? '★' : '☆';
      favorite.className = 'cloud-mini-button icon';
      favorite.title = model.favorite ? 'Remove favorite' : 'Favorite';
      favorite.addEventListener('click', () => toggleFavorite(model));
      const more = document.createElement('button');
      more.type = 'button';
      more.textContent = '•••';
      more.className = 'cloud-mini-button icon';
      more.title = 'Model actions';
      more.addEventListener('click', async () => {
        const action = window.prompt('Type RENAME or DELETE', 'RENAME');
        if (action?.trim().toUpperCase() === 'RENAME') await renameModel(model);
        if (action?.trim().toUpperCase() === 'DELETE') await deleteModel(model);
      });
      actions.append(open, download, favorite, more);

      card.append(preview, body, actions);
      list.appendChild(card);
    }
  }

  libraryButton.addEventListener('click', openLibrary);
  closeButton.addEventListener('click', closeLibrary);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeLibrary(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) closeLibrary();
  });

  window.addEventListener('rigcheck:model-loaded', (event) => {
    const file = event.detail?.file;
    if (!(file instanceof File) || !/\.glb$/i.test(file.name)) return;
    currentViewerGlb = file;
    currentViewerSource = cloudLoadInProgress ? 'cloud' : 'local';
    syncSaveCurrentButton();
  });

  saveCurrentButton.addEventListener('click', saveCurrentModel);
  uploadButton.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = '';
    if (file) await uploadModel(file, { loadFirst: true });
  });
  searchInput.addEventListener('input', renderModels);
  favoriteFilter.addEventListener('click', () => {
    const next = favoriteFilter.getAttribute('aria-pressed') !== 'true';
    favoriteFilter.setAttribute('aria-pressed', String(next));
    renderModels();
  });
  refreshButton.addEventListener('click', refreshModels);
  openAccount.addEventListener('click', () => {
    closeLibrary();
    window.RigCheckAuth?.open?.();
  });

  onAuthStateChanged(auth, (user) => {
    currentUser = user || null;
    libraryButton.classList.toggle('signed-in', Boolean(user));
    libraryButton.title = user ? 'Open your Cloud Model Library' : 'Sign in to use Cloud Model Library';
    syncSaveCurrentButton();
    uploadButton.disabled = busy || !user;
    if (!user) {
      currentModels = [];
      if (!overlay.hidden) closeLibrary();
    }
  });

  window.RigCheckCloudLibrary = {
    open: openLibrary,
    refresh: refreshModels,
    get models() { return [...currentModels]; }
  };
}
