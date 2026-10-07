// RigCheck 3D — INVASION Asset Library (read-only browse, preview and Open in RigCheck).
// The authoritative source is docs/ASSET_MANIFEST.yaml on invasion-godot 3d-migration, served by the Asset Library API.
// Asset bytes arrive only through short-lived signed URLs and enter the existing viewer through #fileInput.
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  NOT_AVAILABLE,
  STATE_ORDER,
  UNKNOWN,
  displayValue,
  formatBytes,
  formatDate,
  groupManifest,
  stateLabel
} from "./lib/asset-library-model.js";
import { AssetApiError, apiGet, describeApiError, resolveApiBase, shortSha } from "./lib/asset-library-api.js";

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
const API_BASE = resolveApiBase(window.location, window.localStorage);
const DOWNLOAD_TIMEOUT_MS = 180000;
const VIEWER_LOAD_TIMEOUT_MS = 90000;

const topActions = document.querySelector('.top-actions');
const fileInput = document.querySelector('#fileInput');
const modelLabel = document.querySelector('#modelLabel');
const sourceLabel = document.querySelector('#sourceLabel');

if (!topActions || !fileInput) {
  console.warn('RigCheck Asset Library: required viewer controls were not found.');
} else {
  initAssetLibrary();
}

function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

function fieldList(pairs, className = 'asset-fields') {
  const list = el('dl', { className });
  for (const [label, value, options = {}] of pairs) {
    const row = el('div', { className: options.wide ? 'wide' : undefined });
    const shown = typeof value === 'string' ? value : displayValue(value, options.fallback ?? UNKNOWN);
    const isMissing = shown === UNKNOWN || shown === NOT_AVAILABLE;
    row.append(el('dt', { text: label }), el('dd', { text: shown, className: [isMissing ? 'missing' : '', options.code ? 'code' : '', options.prose ? 'prose' : ''].filter(Boolean).join(' ') || undefined }));
    list.append(row);
  }
  return list;
}

function rigCheckSummary(rigCheck) {
  if (!rigCheck || rigCheck.valid === null) return displayValue(rigCheck?.status);
  const counts = [`${displayValue(rigCheck.errorCount, '?')} errors`, `${displayValue(rigCheck.warningCount, '?')} warnings`];
  return `${rigCheck.valid ? 'Valid glTF' : 'Invalid glTF'} · ${counts.join(' · ')}`;
}

function provenanceSummary(provenance) {
  if (!provenance || (!provenance.source && !provenance.creator)) return NOT_AVAILABLE;
  return [provenance.source, provenance.creator && `by ${provenance.creator}`].filter(Boolean).join(' ');
}

function initAssetLibrary() {
  let currentUser = null;
  let grouped = null;
  let commitSha = null;
  let selectedAssetId = null;
  let accessState = 'idle';
  let busy = false;

  const assetButton = el('button', {
    className: 'button ghost asset-library-button',
    text: 'Assets',
    attrs: { id: 'assetLibraryButton', type: 'button', title: 'INVASION Asset Library', 'aria-haspopup': 'dialog' }
  });
  const anchor = document.querySelector('#libraryButton') ?? document.querySelector('#accountButton');
  if (anchor?.nextSibling) topActions.insertBefore(assetButton, anchor.nextSibling);
  else topActions.insertBefore(assetButton, topActions.firstChild);

  const overlay = el('div', { className: 'asset-library-overlay', attrs: { id: 'assetLibraryOverlay' } });
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="asset-library-card" role="dialog" aria-modal="true" aria-labelledby="assetLibraryTitle">
      <header class="asset-library-head">
        <div>
          <span class="eyebrow">INVASION</span>
          <h2 id="assetLibraryTitle">Asset Library</h2>
          <p id="assetLibrarySource">Authoritative asset manifest</p>
        </div>
        <div class="asset-library-head-actions">
          <button class="asset-icon-button" id="assetLibraryRefresh" type="button" title="Refresh from the authoritative branch" aria-label="Refresh manifest">↻</button>
          <button class="asset-icon-button" id="assetLibraryClose" type="button" aria-label="Close asset library">×</button>
        </div>
      </header>
      <div class="asset-library-tools">
        <input class="asset-search" id="assetLibrarySearch" type="search" placeholder="Search assets or IDs" autocomplete="off" />
        <label class="asset-review-filter"><input id="assetLibraryReviewOnly" type="checkbox" /> Needs review</label>
      </div>
      <p class="asset-library-status" id="assetLibraryStatus" role="status" aria-live="polite"></p>
      <div class="asset-library-body" id="assetLibraryBody">
        <nav class="asset-library-list" id="assetLibraryList" aria-label="Assets"></nav>
        <section class="asset-library-detail" id="assetLibraryDetail" aria-live="polite"></section>
      </div>
      <footer class="asset-library-foot">Read-only view of the INVASION manifest. Notes and states change only through the asset pipeline.</footer>
    </section>
  `;
  document.body.appendChild(overlay);

  const sourceLine = overlay.querySelector('#assetLibrarySource');
  const refreshButton = overlay.querySelector('#assetLibraryRefresh');
  const closeButton = overlay.querySelector('#assetLibraryClose');
  const searchInput = overlay.querySelector('#assetLibrarySearch');
  const reviewOnly = overlay.querySelector('#assetLibraryReviewOnly');
  const status = overlay.querySelector('#assetLibraryStatus');
  const body = overlay.querySelector('#assetLibraryBody');
  const list = overlay.querySelector('#assetLibraryList');
  const detail = overlay.querySelector('#assetLibraryDetail');

  const getIdToken = () => {
    if (!currentUser) throw new AssetApiError('unauthenticated', 401);
    return currentUser.getIdToken();
  };

  function setStatus(message = '', isError = false) {
    status.textContent = message;
    status.classList.toggle('error', Boolean(isError));
  }

  function openLibrary() {
    if (!currentUser) {
      window.RigCheckAuth?.open?.();
      return;
    }
    overlay.hidden = false;
    document.body.classList.add('asset-library-open');
    closeButton.focus();
    if (!grouped && accessState !== 'loading') loadManifest();
  }

  function closeLibrary() {
    overlay.hidden = true;
    document.body.classList.remove('asset-library-open');
    assetButton.focus();
  }

  async function loadManifest({ forceTokenRefresh = false } = {}) {
    if (!currentUser) return;
    accessState = 'loading';
    refreshButton.disabled = true;
    refreshButton.classList.add('spinning');
    setStatus('Loading the authoritative manifest…');
    try {
      if (forceTokenRefresh) await currentUser.getIdToken(true);
      const response = await apiGet({ base: API_BASE, path: '/api/manifest', getIdToken });
      grouped = groupManifest(response.manifest);
      commitSha = response.commitSha;
      accessState = 'ok';
      sourceLine.textContent = `Manifest as of ${shortSha(commitSha) ?? UNKNOWN} on ${response.branch}`;
      sourceLine.title = commitSha ?? '';
      const reviewCount = grouped.manualReviewAssetIds.length;
      setStatus(`${grouped.assetCount} assets · ${grouped.revisionCount} revisions · ${reviewCount} need manual review.`);
      if (!grouped.schemaSupported) setStatus(`Manifest schema ${displayValue(grouped.schemaVersion)} is newer than this viewer expects; showing what it can read.`, true);
      if (selectedAssetId && !findAsset(selectedAssetId)) selectedAssetId = null;
      render();
    } catch (error) {
      grouped = null;
      accessState = error?.code === 'not_authorized' ? 'not_authorized' : 'error';
      logUnexpected('manifest', error);
      setStatus(error instanceof AssetApiError ? error.message : describeApiError('internal'), true);
      render();
    } finally {
      refreshButton.disabled = false;
      refreshButton.classList.remove('spinning');
    }
  }

  function findAsset(assetId) {
    return grouped?.categories.flatMap((category) => category.assets).find((asset) => asset.assetId === assetId) ?? null;
  }

  function render() {
    body.classList.toggle('showing-detail', Boolean(selectedAssetId));
    if (accessState === 'not_authorized') return renderAccessMessage();
    renderList();
    renderDetail();
    return undefined;
  }

  function renderAccessMessage() {
    list.replaceChildren();
    const recheck = el('button', { className: 'button secondary', text: 'Check access again', attrs: { type: 'button' } });
    recheck.addEventListener('click', () => loadManifest({ forceTokenRefresh: true }));
    detail.replaceChildren(el('div', { className: 'asset-empty' }, [
      el('strong', { text: 'Not authorized for the Asset Library' }),
      el('span', { text: `You are signed in as ${currentUser?.email ?? 'this account'}, but it has no Asset Library role. The project owner must grant access; then sign out and back in, or check again.` }),
      recheck
    ]));
  }

  function matches(asset, search) {
    if (reviewOnly.checked && !asset.needsManualReview) return false;
    if (!search) return true;
    return `${asset.displayName ?? ''} ${asset.assetId ?? ''}`.toLowerCase().includes(search);
  }

  function renderList() {
    list.replaceChildren();
    if (!grouped) return;
    const search = searchInput.value.trim().toLowerCase();
    let shown = 0;
    for (const category of grouped.categories) {
      const assets = category.assets.filter((asset) => matches(asset, search));
      if (!assets.length) continue;
      const group = el('section', { className: 'asset-category' }, [
        el('h3', { text: `${category.label} (${assets.length})` })
      ]);
      for (const asset of assets) {
        shown += 1;
        const button = el('button', {
          className: `asset-row${asset.assetId === selectedAssetId ? ' selected' : ''}`,
          attrs: { type: 'button', ...(asset.assetId === selectedAssetId ? { 'aria-current': 'true' } : {}) }
        }, [
          el('span', { className: 'asset-row-name', text: displayValue(asset.displayName, asset.assetId) }),
          el('span', { className: 'asset-row-id', text: asset.assetId }),
          el('span', { className: 'asset-row-meta' }, [
            el('span', { className: 'chip', text: `${asset.revisionCount} rev` }),
            asset.stateCounts.candidate ? el('span', { className: 'chip candidate', text: `${asset.stateCounts.candidate} candidate` }) : null,
            asset.canonical ? null : el('span', { className: 'chip warn', text: 'No canonical' }),
            asset.needsManualReview ? el('span', { className: 'chip review', text: 'Review' }) : null
          ])
        ]);
        button.addEventListener('click', () => {
          selectedAssetId = asset.assetId;
          render();
          detail.scrollTop = 0;
        });
        group.append(button);
      }
      list.append(group);
    }
    if (!shown) list.append(el('p', { className: 'asset-list-empty', text: 'No assets match.' }));
  }

  function renderDetail() {
    const asset = findAsset(selectedAssetId);
    if (!asset) {
      detail.replaceChildren(el('div', { className: 'asset-empty' }, [
        el('strong', { text: grouped ? 'Select an asset' : 'Asset Library' }),
        el('span', { text: grouped ? 'Assets are grouped by category. Each shows its current canonical revision, candidates and superseded revisions.' : 'The manifest has not loaded.' })
      ]));
      return;
    }

    const back = el('button', { className: 'text-button asset-back', text: '← All assets', attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      selectedAssetId = null;
      render();
    });

    const canonical = asset.canonical;
    const header = el('header', { className: 'asset-detail-head' }, [
      back,
      el('h3', { text: displayValue(asset.displayName, asset.assetId) }),
      asset.needsManualReview
        ? el('span', { className: 'badge review', text: `Manual review required · ${asset.manualReviewRevisionIds.length} revision${asset.manualReviewRevisionIds.length === 1 ? '' : 's'}` })
        : null
    ]);

    const issues = asset.canonicalIssues.length
      ? el('ul', { className: 'asset-warning' }, asset.canonicalIssues.map((issue) => el('li', { text: issue })))
      : null;

    const counts = asset.stateCounts;
    const summary = fieldList([
      ['Display name', asset.displayName],
      ['Asset ID', asset.assetId, { code: true }],
      ['Category', asset.categoryLabel],
      ['Canonical revision', asset.canonicalRevisionId, { code: true, fallback: NOT_AVAILABLE }],
      ['Revisions', `${asset.revisionCount} · ${counts.canonical} canonical · ${counts.candidate} candidate · ${counts.superseded} superseded${counts.other ? ` · ${counts.other} other` : ''}`],
      ['Updated / imported', formatDate(asset.latestDate)],
      ['Note', asset.noteSummary, { wide: true, prose: true, fallback: NOT_AVAILABLE }],
      ['Runtime path', canonical?.runtimePath, { wide: true, code: true, fallback: NOT_AVAILABLE }],
      ['Source path', canonical?.sourcePath, { wide: true, code: true, fallback: NOT_AVAILABLE }],
      ['Provenance', provenanceSummary(canonical?.provenance), { wide: true }],
      ['Triangles', canonical?.model.triangles],
      ['Materials', canonical?.model.materials ? `${canonical.model.materials.length}` : null],
      ['Textures', canonical?.model.textureCount],
      ['Rig status', canonical?.rigCheck.status],
      ['RigCheck', canonical ? rigCheckSummary(canonical.rigCheck) : null, { wide: true }],
      ['Known issues', canonical ? `${canonical.knownIssues.length}` : null],
      ['Pipeline status', canonical?.pipelineStatus],
      ['Manual review', asset.needsManualReview ? `Yes — ${asset.manualReviewRevisionIds.join(', ')}` : 'No', { wide: true }]
    ]);
    const summarySection = el('section', { className: 'asset-summary' }, [
      el('h4', { text: canonical ? 'Asset summary (from the canonical revision)' : 'Asset summary (no canonical revision recorded)' }),
      summary
    ]);

    const groups = [...STATE_ORDER, 'other']
      .filter((state) => asset.groups[state]?.length)
      .map((state) => el('section', { className: `revision-group state-${state}` }, [
        el('h4', { text: `${stateLabel(state)} (${asset.groups[state].length})` }),
        ...asset.groups[state].map((revision) => revisionCard(asset, revision))
      ]));

    detail.replaceChildren(...[header, issues, summarySection, ...groups].filter(Boolean));
  }

  function detailsBlock(title, content, open = false) {
    const block = el('details', { className: 'revision-details' }, [el('summary', { text: title }), content]);
    block.open = open;
    return block;
  }

  function revisionCard(asset, revision) {
    const stateText = revision.isCanonical ? 'CURRENT / CANONICAL' : displayValue(revision.state).toUpperCase();
    const card = el('article', { className: `revision-card state-${revision.state ?? 'unknown'}${revision.isCanonical ? ' is-canonical' : ''}` });
    const actions = el('div', { className: 'revision-actions' });
    const preview = el('div', { className: 'revision-preview' });

    if (revision.openInRigCheckPath) {
      const open = el('button', { className: 'button primary', text: 'Open in RigCheck', attrs: { type: 'button' } });
      open.addEventListener('click', () => openInRigCheck(asset, revision, open));
      actions.append(open);
    }
    if (revision.previewImagePath) {
      const show = el('button', { className: 'button secondary', text: 'Preview image', attrs: { type: 'button' } });
      show.addEventListener('click', () => showPreview(asset, revision, preview, show));
      actions.append(show);
    }
    if (!revision.openInRigCheckPath && !revision.previewImagePath) {
      actions.append(el('span', { className: 'revision-no-preview', text: 'No viewable model or image in this revision' }));
    }

    const files = el('table', { className: 'revision-files' }, [
      el('thead', {}, [el('tr', {}, ['Path', 'Role', 'Format', 'Size'].map((label) => el('th', { text: label })))]),
      el('tbody', {}, revision.files.map((file) => el('tr', {}, [
        el('td', { className: 'code', text: displayValue(file.path) }),
        el('td', { text: displayValue(file.role) }),
        el('td', { text: displayValue(file.format) }),
        el('td', { text: formatBytes(file.sizeBytes) })
      ])))
    ]);

    const model = revision.model;
    const modelFields = fieldList([
      ['Triangles', model.triangles],
      ['Polygons', model.polygons],
      ['Meshes', model.meshes],
      ['Textures', model.textureCount],
      ['Materials', model.materials?.map((name) => name ?? UNKNOWN), { wide: true }],
      ['Skeletons', model.skeletons?.map((skeleton) => `${displayValue(skeleton.name)} (${displayValue(skeleton.boneCount)} bones)`), { wide: true }],
      ['Animations', model.animations?.map((name) => name ?? UNKNOWN), { wide: true }]
    ]);

    const rig = revision.rigCheck;
    const validationFields = fieldList([
      ['Technical status', revision.technical.status],
      ['Technical checked', formatDate(revision.technical.checkedAt)],
      ['Rig status', rig.status],
      ['Rig status reason', rig.reason, { fallback: NOT_AVAILABLE }],
      ['RigCheck result', rigCheckSummary(rig), { wide: true }],
      ['Bones / clips', rig.bones === null && rig.clips === null ? null : `${displayValue(rig.bones)} bones · ${displayValue(rig.clips)} clips`],
      ['RigCheck checked', formatDate(rig.checkedAt)],
      ['Rig compatible', rig.compatible]
    ]);

    const provenanceFields = fieldList([
      ['Source', revision.provenance.source, { wide: true, fallback: NOT_AVAILABLE }],
      ['Creator', revision.provenance.creator, { fallback: NOT_AVAILABLE }],
      ['Git reference', revision.provenance.gitReference, { code: true, fallback: NOT_AVAILABLE }],
      ['Legacy in place', revision.provenance.legacyInPlace]
    ]);

    const issueList = revision.knownIssues.length
      ? el('ul', { className: 'issue-list' }, revision.knownIssues.map((issue) => el('li', { className: `severity-${issue.severity}` }, [
        el('span', { className: 'issue-severity', text: issue.severity.toUpperCase() }),
        el('span', { className: 'code', text: displayValue(issue.code) }),
        el('span', { text: displayValue(issue.message, '') }),
        issue.location ? el('span', { className: 'code dim', text: issue.location }) : null
      ])))
      : el('p', { className: 'dim', text: 'No known issues recorded.' });

    const review = revision.manualReview;
    const reviewContent = review.required
      ? el('ul', { className: 'issue-list' }, review.reasons.map((reason) => el('li', { className: `severity-${reason.severity}` }, [
        el('span', { className: 'issue-severity', text: reason.severity.toUpperCase() }),
        el('span', { className: 'code', text: displayValue(reason.code) }),
        el('span', { text: displayValue(reason.message, '') })
      ])))
      : el('p', { className: 'dim', text: 'No manual review required by recorded data.' });

    card.append(
      el('header', { className: 'revision-head' }, [
        el('span', { className: 'revision-id code', text: displayValue(revision.revisionId) }),
        el('span', { className: `badge state ${revision.isCanonical ? 'canonical' : revision.state ?? ''}`, text: stateText }),
        review.required ? el('span', { className: 'badge review', text: 'Manual review' }) : null
      ]),
      actions,
      preview,
      fieldList([
        ['Pipeline status', revision.pipelineStatus],
        ['Created', formatDate(revision.createdAt)],
        ['Ingested', formatDate(revision.ingestedAt)],
        ['Recorded', formatDate(revision.recordedAt)],
        ['Promoted', formatDate(revision.promotedAt)],
        ['Runtime path', revision.runtimePath, { wide: true, code: true, fallback: NOT_AVAILABLE }],
        ['Source path', revision.sourcePath, { wide: true, code: true, fallback: NOT_AVAILABLE }],
        ['Supersedes', revision.supersedes, { code: true, fallback: NOT_AVAILABLE }],
        ['Superseded by', revision.supersededBy, { code: true, fallback: NOT_AVAILABLE }],
        ['Notes', revision.note, { wide: true, prose: true, fallback: NOT_AVAILABLE }]
      ]),
      detailsBlock(`Manual review${review.required ? ` (${review.reasons.length})` : ''}`, reviewContent, review.required),
      detailsBlock(`Known issues (${revision.knownIssues.length})`, issueList),
      detailsBlock('Validation', validationFields),
      detailsBlock('Model metadata', modelFields),
      detailsBlock('Provenance', provenanceFields),
      detailsBlock(`Files (${revision.files.length})`, files)
    );
    return card;
  }

  function requestFile(assetId, revisionId, path) {
    return apiGet({ base: API_BASE, path: '/api/file', params: { asset: assetId, revision: revisionId, path }, getIdToken });
  }

  async function fetchSigned(url, onProgress) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok || !response.body || !onProgress) return { response, blob: response.ok ? await response.blob() : null };
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received, total);
      }
      return { response, blob: new Blob(chunks) };
    } catch (error) {
      throw new AssetApiError('network', 0, error?.name === 'AbortError' ? 'The download timed out. Try again.' : describeApiError('network'));
    } finally {
      clearTimeout(timer);
    }
  }

  // Signed URLs expire after 10 minutes; an expired one is re-requested once.
  async function downloadAssetFile(assetId, revisionId, path, onProgress) {
    let info = await requestFile(assetId, revisionId, path);
    let result = await fetchSigned(info.url, onProgress);
    if (result.response.status === 400 || result.response.status === 403) {
      info = await requestFile(assetId, revisionId, path);
      result = await fetchSigned(info.url, onProgress);
    }
    if (!result.response.ok) throw new AssetApiError('network', result.response.status, `The download failed (${result.response.status}).`);
    if (typeof info.size === 'number' && result.blob.size !== info.size) throw new AssetApiError('integrity_mismatch', 0);
    return new File([result.blob], info.fileName, { type: info.contentType });
  }

  async function waitForViewer(fileName) {
    const started = Date.now();
    while (Date.now() - started < VIEWER_LOAD_TIMEOUT_MS) {
      if (modelLabel?.textContent === fileName && sourceLabel?.textContent === 'LOCAL FILE') return true;
      if (sourceLabel?.textContent === 'LOAD FAILED') return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  // Same entry point as the Open model button and Cloud Library: the existing viewer stack does all loading.
  async function loadFileIntoViewer(file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    const loaded = await waitForViewer(file.name);
    if (loaded && sourceLabel) sourceLabel.textContent = 'INVASION ASSET';
    return loaded;
  }

  // Expected API states (unauthorized, not yet published, ...) are shown in the UI, not logged as faults.
  function logUnexpected(context, error) {
    if (!(error instanceof AssetApiError) || error.code === 'internal' || error.code === 'network') {
      console.error(`RigCheck Asset Library ${context} error:`, error);
    }
  }

  function markUnavailable(button, error) {
    if (error?.code === 'not_published' || error?.code === 'not_registered') {
      const note = el('span', { className: 'revision-no-preview', text: describeApiError(error.code) });
      button.replaceWith(note);
    }
  }

  async function openInRigCheck(asset, revision, button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    const name = revision.openInRigCheckPath.split('/').pop();
    setStatus(`Preparing ${name}…`);
    try {
      const file = await downloadAssetFile(asset.assetId, revision.revisionId, revision.openInRigCheckPath, (received, total) => {
        setStatus(total ? `Downloading ${name} · ${Math.round((received / total) * 100)}% of ${formatBytes(total)}` : `Downloading ${name} · ${formatBytes(received)}`);
      });
      setStatus(`Opening ${name} (${formatBytes(file.size)}) in RigCheck…`);
      const loaded = await loadFileIntoViewer(file);
      if (!loaded) throw new AssetApiError('internal', 0, 'The viewer could not open this file.');
      setStatus(`${name} (${revision.revisionId}) is open in RigCheck.`);
      closeLibrary();
    } catch (error) {
      logUnexpected('open', error);
      setStatus(error instanceof AssetApiError ? error.message : describeApiError('internal'), true);
      markUnavailable(button, error);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  async function showPreview(asset, revision, container, button) {
    button.disabled = true;
    const path = revision.previewImagePath;
    try {
      const info = await requestFile(asset.assetId, revision.revisionId, path);
      const image = el('img', { attrs: { alt: `Preview of ${info.fileName}`, decoding: 'async' } });
      let retried = false;
      image.addEventListener('error', async () => {
        if (retried) {
          container.replaceChildren(el('p', { className: 'dim', text: 'The preview image could not be displayed.' }));
          return;
        }
        retried = true;
        try {
          image.src = (await requestFile(asset.assetId, revision.revisionId, path)).url;
        } catch (error) {
          container.replaceChildren(el('p', { className: 'dim', text: describeApiError(error?.code) }));
        }
      });
      image.src = info.url;
      container.replaceChildren(image, el('span', { className: 'dim code', text: `${info.fileName} · ${formatBytes(info.size)}` }));
      button.hidden = true;
    } catch (error) {
      logUnexpected('preview', error);
      setStatus(error instanceof AssetApiError ? error.message : describeApiError('internal'), true);
      markUnavailable(button, error);
      button.disabled = false;
    }
  }

  assetButton.addEventListener('click', openLibrary);
  closeButton.addEventListener('click', closeLibrary);
  refreshButton.addEventListener('click', () => loadManifest());
  searchInput.addEventListener('input', renderList);
  reviewOnly.addEventListener('change', renderList);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeLibrary(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) closeLibrary();
  });

  onAuthStateChanged(auth, (user) => {
    const changed = (user?.uid ?? null) !== (currentUser?.uid ?? null);
    currentUser = user || null;
    assetButton.classList.toggle('signed-in', Boolean(user));
    assetButton.title = user ? 'Open the INVASION Asset Library' : 'Sign in to use the INVASION Asset Library';
    if (changed) {
      grouped = null;
      commitSha = null;
      selectedAssetId = null;
      accessState = 'idle';
      if (!user && !overlay.hidden) closeLibrary();
      if (user && !overlay.hidden) loadManifest();
    }
  });

  window.RigCheckAssetLibrary = {
    open: openLibrary,
    refresh: () => loadManifest(),
    get commitSha() { return commitSha; }
  };
}
