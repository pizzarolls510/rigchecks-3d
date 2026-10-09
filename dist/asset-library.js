// RigCheck 3D — INVASION Asset Library (browse, preview and Open in RigCheck; for writers also upload candidate,
// promote and re-validate). The authoritative source is docs/ASSET_MANIFEST.yaml on invasion-godot 3d-migration,
// served by the Asset Library API. Asset bytes arrive only through short-lived signed URLs and enter the existing
// viewer through #fileInput. Changes run only as Asset Library jobs (the INVASION pipeline on GitHub Actions).
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
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
import { AssetApiError, apiGet, apiPost, describeApiError, resolveApiBase, shortSha } from "./lib/asset-library-api.js";
import {
  buildIngestRequest,
  buildPromoteConfirmRequest,
  buildPromoteDryRunRequest,
  checkIngestForm,
  checkUploadFile,
  describeJobError,
  isTerminalJob,
  jobStatusText,
  pollJob,
  roleFromClaims,
  summarizeDryRun,
  summarizeIngest,
  summarizeValidation
} from "./lib/asset-library-jobs.js";

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
const storage = getStorage(app);
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
  let role = null;
  let vocabulary = null;
  // One job at a time from this page; its progress lives in the job tray, which survives re-renders.
  let jobBusy = false;
  let tray = null;
  let pollGeneration = 0;
  let reusableUpload = null;
  let uploadForm = null;

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
          <button class="button secondary asset-write-action" id="assetLibraryUpload" type="button" hidden>Upload candidate</button>
          <button class="asset-icon-button" id="assetLibraryRefresh" type="button" title="Refresh from the authoritative branch" aria-label="Refresh manifest">↻</button>
          <button class="asset-icon-button" id="assetLibraryClose" type="button" aria-label="Close asset library">×</button>
        </div>
      </header>
      <div class="asset-library-tools">
        <input class="asset-search" id="assetLibrarySearch" type="search" placeholder="Search assets or IDs" autocomplete="off" />
        <label class="asset-review-filter"><input id="assetLibraryReviewOnly" type="checkbox" /> Needs review</label>
      </div>
      <p class="asset-library-status" id="assetLibraryStatus" role="status" aria-live="polite"></p>
      <section class="asset-job-tray" id="assetLibraryJobTray" aria-live="polite" hidden></section>
      <div class="asset-library-body" id="assetLibraryBody">
        <nav class="asset-library-list" id="assetLibraryList" aria-label="Assets"></nav>
        <section class="asset-library-detail" id="assetLibraryDetail" aria-live="polite"></section>
      </div>
      <footer class="asset-library-foot" id="assetLibraryFoot">Read-only view of the INVASION manifest. Notes and states change only through the asset pipeline.</footer>
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
  const uploadButton = overlay.querySelector('#assetLibraryUpload');
  const jobTray = overlay.querySelector('#assetLibraryJobTray');
  const footer = overlay.querySelector('#assetLibraryFoot');

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
      vocabulary = response.vocabulary ?? null;
      role = await readRole();
      accessState = 'ok';
      sourceLine.textContent = `Manifest as of ${shortSha(commitSha) ?? UNKNOWN} on ${response.branch}`;
      sourceLine.title = commitSha ?? '';
      const reviewCount = grouped.manualReviewAssetIds.length;
      setStatus(`${grouped.assetCount} assets · ${grouped.revisionCount} revisions · ${reviewCount} need manual review.`);
      if (!grouped.schemaSupported) setStatus(`Manifest schema ${displayValue(grouped.schemaVersion)} is newer than this viewer expects; showing what it can read.`, true);
      if (selectedAssetId && !findAsset(selectedAssetId)) selectedAssetId = null;
      render();
      if (tray && !jobBusy) renderTray();
    } catch (error) {
      grouped = null;
      vocabulary = null;
      accessState = error?.code === 'not_authorized' ? 'not_authorized' : 'error';
      logUnexpected('manifest', error);
      setStatus(error instanceof AssetApiError ? error.message : describeApiError('internal'), true);
      render();
    } finally {
      refreshButton.disabled = jobBusy;
      refreshButton.classList.remove('spinning');
    }
  }

  async function readRole() {
    try {
      return roleFromClaims((await currentUser.getIdTokenResult()).claims);
    } catch {
      return null;
    }
  }

  // Writer controls are a convenience; the API enforces the writer claim on every change.
  function canWrite() {
    return role === 'writer' && Boolean(vocabulary) && Boolean(commitSha) && accessState === 'ok';
  }

  function findAsset(assetId) {
    return grouped?.categories.flatMap((category) => category.assets).find((asset) => asset.assetId === assetId) ?? null;
  }

  function render() {
    body.classList.toggle('showing-detail', Boolean(selectedAssetId) || Boolean(uploadForm));
    uploadButton.hidden = !canWrite();
    uploadButton.disabled = jobBusy;
    footer.textContent = role === 'writer'
      ? 'Changes run through the INVASION asset pipeline and are committed to 3d-migration. Notes are read-only.'
      : 'Read-only view of the INVASION manifest. Notes and states change only through the asset pipeline.';
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
          uploadForm = null;
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
    if (uploadForm && canWrite()) {
      detail.replaceChildren(uploadForm);
      return;
    }
    uploadForm = null;
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
        : null,
      canWrite() ? writerAssetActions(asset) : null
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
    const promotePanel = el('div', { className: 'revision-promote' });
    if (canWrite() && revision.state === 'candidate') {
      const promote = el('button', { className: 'button secondary asset-write-action', text: 'Promote…', attrs: { type: 'button' } });
      promote.disabled = jobBusy;
      promote.addEventListener('click', () => startPromotion(asset, revision, promotePanel));
      actions.append(promote);
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
        review.required ? el('span', { className: 'badge review', text: 'Manual review' }) : null,
        productionBadge(revision)
      ]),
      actions,
      promotePanel,
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
      revisionProductionBlock(revision),
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


  // ------------------------------------------------------------------------------------------------ writer jobs

  function formField(label, control, hint) {
    const error = el('span', { className: 'asset-form-error', attrs: { role: 'alert' } });
    const field = el('label', { className: 'asset-form-field' }, [
      el('span', { className: 'asset-form-label', text: label }),
      control,
      hint ? el('span', { className: 'asset-form-hint', text: hint }) : null,
      error
    ]);
    return { field, control, error };
  }

  function choice(options, value, blankLabel) {
    const node = el('select');
    node.append(el('option', { text: blankLabel, attrs: { value: '' } }));
    for (const option of options) node.append(el('option', { text: option, attrs: { value: option } }));
    node.value = options.includes(value) ? value : '';
    return node;
  }

  function setJobBusy(value) {
    jobBusy = value;
    refreshButton.disabled = value;
    uploadButton.disabled = value;
    for (const button of overlay.querySelectorAll('.asset-write-action')) button.disabled = value;
  }

  function apiErrorMessage(error) {
    if (!(error instanceof AssetApiError)) return describeApiError('internal');
    if (error.code === 'rate_limited' && error.retryAfterSeconds) return `${error.message} Try again in about ${Math.ceil(error.retryAfterSeconds / 60)} min.`;
    return error.message;
  }

  function writerAssetActions(asset) {
    const upload = el('button', { className: 'button secondary asset-write-action', text: 'Upload candidate', attrs: { type: 'button' } });
    upload.addEventListener('click', () => openUploadForm(asset));
    const validate = el('button', { className: 'button ghost asset-write-action', text: 'Re-validate', attrs: { type: 'button', title: 'Re-run the pipeline inspections for this asset (read-only)' } });
    validate.addEventListener('click', () => startAndTrack('/api/jobs/validate', { assetId: asset.assetId, recheck: true }));
    for (const button of [upload, validate]) button.disabled = jobBusy;
    return el('div', { className: 'asset-write-actions' }, [upload, validate]);
  }

  // ---- job tray: the one place a job's progress, review and outcome are shown

  function clearTray() {
    tray = null;
    jobTray.hidden = true;
    jobTray.replaceChildren();
  }

  function renderTray() {
    if (!tray) return clearTray();
    const { job } = tray;
    const close = jobBusy ? null : el('button', { className: 'asset-icon-button', text: '×', attrs: { type: 'button', 'aria-label': 'Dismiss job' } });
    close?.addEventListener('click', clearTray);
    const head = el('header', { className: 'asset-job-head' }, [
      el('strong', { text: tray.title ?? (job ? jobStatusText(job) : 'Working…') }),
      el('span', { className: 'asset-job-meta' }, [
        job ? el('span', { className: 'code dim', text: `job ${job.jobId}` }) : null,
        job?.baseSha ? el('span', { className: 'code dim', text: `base ${shortSha(job.baseSha)}` }) : null,
        job?.runUrl ? el('a', { text: 'View run', attrs: { href: job.runUrl, target: '_blank', rel: 'noopener noreferrer' } }) : null
      ]),
      close
    ]);
    const parts = [head];
    if (job && !isTerminalJob(job) && !tray.title) parts.push(el('div', { className: 'asset-job-progress', attrs: { role: 'progressbar', 'aria-label': 'Job running' } }));
    if (tray.message) parts.push(el('p', { className: `asset-job-message${tray.isError ? ' error' : ''}`, text: tray.message }));
    if (job && isTerminalJob(job)) parts.push(...jobOutcome(job));
    if (tray.staleBase || job?.error?.code === 'stale_base') parts.push(refreshPrompt());
    jobTray.replaceChildren(...parts.filter(Boolean));
    jobTray.hidden = false;
    return undefined;
  }

  function refreshPrompt() {
    const refresh = el('button', { className: 'button secondary', text: 'Refresh manifest', attrs: { type: 'button' } });
    refresh.disabled = jobBusy;
    refresh.addEventListener('click', () => loadManifest());
    return el('div', { className: 'asset-job-actions' }, [refresh]);
  }

  function issueList(items, severity = 'warning') {
    return el('ul', { className: 'issue-list' }, items.map((item) => el('li', { className: `severity-${severity}` }, [el('span', { text: item })])));
  }

  function jobOutcome(job) {
    if (job.status === 'error' && job.operation === 'promote_dry_run' && summarizeDryRun(job).available) return blockedReview(job);
    if (job.status === 'error') {
      const detailText = job.result?.pipeline?.error;
      return [
        el('p', { className: 'asset-job-message error', text: describeJobError(job) }),
        job.mutation ? el('p', { className: 'dim', text: job.pushed ? `Commit ${shortSha(job.commitSha)} was pushed.` : 'Nothing was committed to 3d-migration.' }) : null,
        typeof detailText === 'string' && detailText !== describeJobError(job) ? el('p', { className: 'dim', text: detailText }) : null
      ];
    }
    if (job.operation === 'ingest') {
      const summary = summarizeIngest(job);
      return [
        el('p', { className: 'asset-job-message', text: `Candidate ${displayValue(summary.revisionId)} was recorded for ${displayValue(summary.assetId)} and committed to 3d-migration as ${shortSha(job.commitSha) ?? UNKNOWN}.` }),
        summary.files.length ? fileChangeTable(['File', 'Role', 'Size'], summary.files.map((file) => [file.path, file.role, formatBytes(file.sizeBytes)])) : null,
        summary.warnings.length ? issueList(summary.warnings) : null,
        productionView(summary.production, { open: true, heading: 'Production check' }),
        summary.production && summary.production.status !== 'not_applicable'
          ? el('p', { className: 'dim', text: 'Budget results never block an upload. The candidate stays a candidate until you promote it.' })
          : null
      ];
    }
    if (job.operation === 'promote_confirm') {
      const integration = job.result?.pipeline?.result?.integration_required;
      return [
        el('p', { className: 'asset-job-message', text: `${displayValue(job.params?.revision_id)} is now canonical for ${displayValue(job.params?.asset_id)}, committed to 3d-migration as ${shortSha(job.commitSha) ?? UNKNOWN}.` }),
        typeof integration === 'string' ? el('p', { className: 'dim', text: integration }) : null
      ];
    }
    if (job.operation === 'validate') {
      const summary = summarizeValidation(job);
      if (!summary.available) return [el('p', { className: 'dim', text: 'The validation result is too large to show here; see the run on GitHub.' })];
      return [
        el('p', { className: 'asset-job-message', text: `${summary.ok ? 'Valid' : 'Not valid'} · ${summary.counts.error} errors · ${summary.counts.warning} warnings · ${summary.freshInspections} files re-inspected` }),
        summary.findings.length ? el('ul', { className: 'issue-list' }, summary.findings.map((finding) => el('li', { className: `severity-${finding.severity}` }, [
          el('span', { className: 'issue-severity', text: String(finding.severity).toUpperCase() }),
          el('span', { text: finding.text })
        ]))) : null,
        summary.more ? el('p', { className: 'dim', text: `${summary.more} more findings are in the run result.` }) : null,
        ...summary.production
          .filter((entry) => entry.production && entry.production.status !== 'not_applicable')
          .map((entry) => productionView(entry.production, { heading: `${entry.revisionId}${entry.canonicalState === 'canonical' ? ' (canonical)' : ''}` }))
      ];
    }
    if (job.operation === 'promote_dry_run') return dryRunReview(job);
    return [];
  }

  function fileChangeTable(headings, rows) {
    return el('table', { className: 'revision-files' }, [
      el('thead', {}, [el('tr', {}, headings.map((label) => el('th', { text: label })))]),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((cell, index) => el('td', { className: /file/i.test(headings[index]) ? 'code' : undefined, text: displayValue(cell) })))))
    ]);
  }

  // Renders the pipeline's own dry-run payload, then gates "Confirm promotion" on it.
  function dryRunReview(job) {
    const summary = summarizeDryRun(job);
    if (!summary.available) return [el('p', { className: 'asset-job-message error', text: 'The dry-run result could not be read; run the dry run again.' })];
    const asset = findAsset(summary.assetId);
    const stale = summary.baseSha !== commitSha;
    const fields = fieldList([
      ['Selected candidate', summary.revisionId, { code: true }],
      ['Current canonical', summary.previousCanonical ?? asset?.canonicalRevisionId, { code: true, fallback: 'None' }],
      ['Manifest change', `${summary.revisionId} becomes canonical${summary.previousCanonical ? `; ${summary.previousCanonical} becomes superseded` : ''}`, { wide: true }],
      ['Validation', summary.warningsReadable ? (summary.warnings.length ? `${summary.warnings.length} warning${summary.warnings.length === 1 ? '' : 's'} (listed below)` : 'No warnings') : 'The warning list could not be read', { wide: true }],
      ['Git LFS rules to add', summary.lfsRulesToAdd.length ? summary.lfsRulesToAdd.join(', ') : 'None', { wide: true, code: true }],
      ['Godot integration', summary.integrationRequired, { wide: true, prose: true, fallback: NOT_AVAILABLE }]
    ]);
    const files = summary.files.length
      ? fileChangeTable(['Candidate file', 'Canonical file', 'Role', 'Size'], summary.files.map((file) => [file.from, file.to, file.role, formatBytes(file.sizeBytes)]))
      : null;
    const confirm = el('button', { className: 'button primary', text: 'Confirm promotion', attrs: { type: 'button' } });
    let accept = null;
    let acceptRow = null;
    if (summary.requiresAcceptance) {
      accept = el('input', { attrs: { type: 'checkbox' } });
      acceptRow = el('label', { className: 'asset-accept' }, [accept, el('span', {
        text: summary.warningsReadable
          ? `I reviewed the ${summary.warnings.length} warning${summary.warnings.length === 1 ? '' : 's'} above and accept ${summary.warnings.length === 1 ? 'it' : 'them'} for this promotion.`
          : 'The warning list could not be read. I accept the promotion without reviewing it.'
      })]);
      accept.addEventListener('change', () => { confirm.disabled = !canConfirm(); });
    }
    const canConfirm = () => !jobBusy && !stale && !job.confirmJobId && canWrite() && (!accept || accept.checked);
    confirm.disabled = !canConfirm();
    confirm.addEventListener('click', () => {
      if (!canConfirm()) return;
      startAndTrack('/api/jobs/promote', buildPromoteConfirmRequest(job, accept?.checked), { refreshOnDone: true });
    });
    return [
      el('p', { className: 'asset-job-message', text: 'Dry run finished. Nothing has changed yet. Review the promotion below; it only happens when you confirm.' }),
      fields,
      productionView(summary.production, { open: summary.production?.status !== 'pass' }),
      summary.warnings.length ? issueList(summary.warnings) : null,
      files,
      acceptRow,
      stale ? el('p', { className: 'asset-job-message error', text: 'The branch changed since this dry run. Run the dry run again before confirming.' }) : null,
      job.confirmJobId ? el('p', { className: 'dim', text: 'This dry run has already been confirmed.' }) : null,
      el('div', { className: 'asset-job-actions' }, [confirm, rerunButton(job)])
    ];
  }

  // A blocked dry run: every blocker the pipeline found, its production results and partial plan. No confirm.
  function blockedReview(job) {
    const summary = summarizeDryRun(job);
    const count = summary.blockers.length;
    return [
      el('p', { className: 'asset-job-message error', text: `Promotion is blocked, and nothing has changed. Resolve ${count === 1 ? 'this blocker' : `these ${count} blockers`} first:` }),
      issueList(summary.blockers, 'error'),
      productionView(summary.production, { open: summary.production?.status !== 'pass' }),
      summary.warnings.length ? detailsBlock(`Warnings (${summary.warnings.length})`, issueList(summary.warnings)) : null,
      el('div', { className: 'asset-job-actions' }, [rerunButton(job)])
    ];
  }

  function rerunButton(job) {
    const button = el('button', { className: 'button secondary asset-write-action', text: 'Run dry run again', attrs: { type: 'button' } });
    button.disabled = jobBusy || !canWrite();
    button.addEventListener('click', () => {
      const params = job.params ?? {};
      startAndTrack('/api/jobs/promote', buildPromoteDryRunRequest({
        baseSha: commitSha,
        assetId: params.asset_id,
        revisionId: params.revision_id,
        displayName: params.display_name,
        category: params.category,
        destination: params.destination
      }));
    });
    return button;
  }

  // ---- production compliance (evaluated only by the INVASION pipeline; shown here as recorded)

  function productionBadge(revision) {
    if (revision.production) {
      const accepted = revision.production.warningsAccepted ? ' · warnings accepted' : '';
      return el('span', { className: `badge production state-${revision.production.status}`, text: `Production: ${revision.production.statusLabel}${accepted}` });
    }
    return revision.hasModel ? el('span', { className: 'badge production state-not_verified', text: 'Production: Not evaluated' }) : null;
  }

  function revisionProductionBlock(revision) {
    if (revision.production) return productionView(revision.production);
    if (!revision.hasModel) return null;
    return detailsBlock('Production compliance · Not evaluated', el('p', { className: 'dim', text: 'This revision was recorded before production checks existed. Re-validate the asset to evaluate it against its profile. A promotion dry run always evaluates it.' }));
  }

  function productionView(production, { open = false, heading = 'Production compliance' } = {}) {
    if (!production) return null;
    const source = production.profileSource === 'asset_assignment' ? ' · assigned to this asset'
      : production.profileSource === 'category_default' ? ' · from category' : '';
    const rows = production.checks.map((check) => el('li', { className: `production-row status-${check.status}` }, [
      el('span', { className: 'production-label', text: check.label }),
      el('span', { className: 'production-value', text: check.measured === NOT_AVAILABLE ? '—' : check.measured }),
      el('span', { className: 'production-target', text: check.target === NOT_AVAILABLE ? '' : `target ${check.target}` }),
      el('span', { className: `production-state state-${check.status}`, text: check.statusLabel }),
      check.status !== 'pass' && check.message ? el('span', { className: 'production-message', text: check.message }) : null
    ]));
    const body = el('div', { className: 'production' }, [
      el('p', { className: 'production-profile', text: production.profileLabel ? `Profile: ${production.profileLabel}${source}` : (production.reason ?? 'No production profile applies.') }),
      production.exception ? el('p', { className: 'dim', text: production.exception }) : null,
      production.warningsAccepted
        ? el('p', { className: 'asset-job-message', text: 'Its production warnings were explicitly accepted at promotion. That does not make it production-compliant; the results below are unchanged.' })
        : null,
      production.profileLabel && production.reason ? el('p', { className: 'dim', text: production.reason }) : null,
      rows.length ? el('ul', { className: 'production-checks' }, rows) : null,
      production.outstanding.length
        ? el('div', { className: 'production-outstanding' }, [el('strong', { text: 'Outstanding before promotion' }), issueList(production.outstanding)])
        : null,
      production.notVerified.length ? el('p', { className: 'dim', text: `Not verified here: ${production.notVerified.join('; ')}.` }) : null
    ]);
    const block = el('details', { className: 'revision-details production-details' }, [
      el('summary', {}, [el('span', { text: heading }), el('span', { className: `badge production state-${production.status}`, text: production.statusLabel })]),
      body
    ]);
    block.open = open;
    return block;
  }

  async function fetchJob(jobId) {
    return (await apiGet({ base: API_BASE, path: `/api/jobs/${encodeURIComponent(jobId)}`, getIdToken })).job;
  }

  // Follows a job until it finishes. Transient polling failures keep the last known state and retry.
  async function follow(job, generation) {
    let last = job;
    tray = { job };
    renderTray();
    return pollJob({
      getJob: async () => {
        try {
          last = await fetchJob(job.jobId);
        } catch (error) {
          if (!(error instanceof AssetApiError) || !['network', 'upstream_error', 'internal', 'rate_limited'].includes(error.code)) throw error;
        }
        return last;
      },
      onUpdate: (current) => {
        if (generation !== pollGeneration) return;
        tray = { job: current };
        renderTray();
      },
      isCancelled: () => generation !== pollGeneration
    });
  }

  async function startAndTrack(path, body, { refreshOnDone = false } = {}) {
    if (jobBusy || !canWrite()) return null;
    setJobBusy(true);
    const generation = ++pollGeneration;
    tray = { title: 'Starting the job…' };
    renderTray();
    try {
      const { job } = await apiPost({ base: API_BASE, path, body, getIdToken });
      const final = await follow(job, generation);
      if (refreshOnDone && final?.status === 'done') await loadManifest();
      return final;
    } catch (error) {
      logUnexpected('job', error);
      tray = { job: tray?.job, title: tray?.job ? 'Lost track of the job' : 'The job did not start', message: apiErrorMessage(error), isError: true, staleBase: error?.code === 'stale_base' };
      return null;
    } finally {
      setJobBusy(false);
      renderTray();
    }
  }

  // ---- upload candidate

  function uploadToStaging(file, path, onProgress) {
    return new Promise((resolve, reject) => {
      const task = uploadBytesResumable(storageRef(storage, path), file, { contentType: file.type || 'application/octet-stream' });
      task.on('state_changed',
        (snapshot) => onProgress(snapshot.totalBytes ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0),
        (error) => reject(error?.code === 'storage/unauthorized'
          ? new AssetApiError('writer_required', 403, 'Storage refused the upload. Asset Library write access and a supported file are required.')
          : new AssetApiError('network', 0, 'The upload failed. Check your connection and try again.')),
        () => resolve());
    });
  }

  function openUploadForm(asset = null) {
    if (!canWrite() || jobBusy) return;
    uploadForm = buildUploadForm(asset);
    render();
    detail.scrollTop = 0;
  }

  function buildUploadForm(asset) {
    const back = el('button', { className: 'text-button asset-back', text: asset ? '← Back to asset' : '← All assets', attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      uploadForm = null;
      selectedAssetId = asset?.assetId ?? null;
      render();
    });
    const assetIds = grouped.categories.flatMap((category) => category.assets.map((entry) => entry.assetId)).filter(Boolean).sort();
    const datalist = el('datalist', { attrs: { id: 'assetLibraryAssetIds' } }, assetIds.map((id) => el('option', { attrs: { value: id } })));

    const file = formField('File', el('input', { attrs: { type: 'file', accept: vocabulary.supportedExtensions.join(',') } }),
      `Supported: ${vocabulary.supportedExtensions.join(' ')} · up to ${formatBytes(vocabulary.maxUploadBytes)}`);
    const assetId = formField('Asset ID', el('input', { attrs: { type: 'text', list: 'assetLibraryAssetIds', autocomplete: 'off', spellcheck: 'false', required: '' } }),
      'An existing asset gets a new candidate revision; a new ID creates a new logical asset.');
    assetId.control.value = asset?.assetId ?? '';
    const known = el('span', { className: 'asset-form-hint' });
    assetId.field.insertBefore(known, assetId.error);
    const revisionId = formField('Revision ID (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false' } }), 'Left blank, the pipeline derives it from the file contents.');
    const displayName = formField('Display name (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off' } }));
    const category = formField('Category', choice(vocabulary.categories, asset?.category, 'Not set'), 'An existing asset keeps its category; it cannot change here.');
    const fileRole = formField('File role', choice(vocabulary.roles, '', 'Automatic'), 'Automatic: source for .blend/.fbx/.psd, otherwise runtime.');
    const note = formField('Note (optional)', el('textarea', { attrs: { rows: '3' } }));
    const source = formField('Source / provenance (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off' } }));
    const creator = formField('Creator (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off' } }));
    const fields = { assetId, revisionId, displayName, category, role: fileRole, note, source, creator };

    const describeKnown = () => {
      const existing = findAsset(assetId.control.value.trim());
      known.textContent = existing ? `Existing asset: ${displayValue(existing.displayName, existing.assetId)} · ${existing.categoryLabel} · ${existing.revisionCount} revision${existing.revisionCount === 1 ? '' : 's'}` : '';
      if (existing?.category && !category.control.value) category.control.value = existing.category;
    };
    assetId.control.addEventListener('input', describeKnown);
    describeKnown();

    const submit = el('button', { className: 'button primary asset-write-action', text: 'Upload and ingest', attrs: { type: 'submit' } });
    submit.disabled = jobBusy;
    const form = el('form', { className: 'asset-form', attrs: { novalidate: '' } }, [
      el('p', { className: 'dim', text: 'The INVASION asset pipeline ingests the file as a new candidate revision, and the job commits only the pipeline\'s own changes to 3d-migration. Nothing becomes canonical without a separate, reviewed promotion.' }),
      file.field, datalist, assetId.field, revisionId.field, displayName.field, category.field, fileRole.field, note.field, source.field, creator.field,
      el('div', { className: 'asset-job-actions' }, [submit])
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(Object.entries(fields).map(([name, entry]) => [name, entry.control.value]));
      const errors = checkIngestForm(values, vocabulary);
      const fileError = checkUploadFile(file.control.files?.[0], vocabulary);
      file.error.textContent = fileError ?? '';
      for (const [name, entry] of Object.entries(fields)) entry.error.textContent = errors[name] ?? '';
      if (fileError || Object.keys(errors).length) return;
      submitUpload(file.control.files[0], values);
    });
    return el('section', { className: 'asset-upload' }, [
      el('header', { className: 'asset-detail-head' }, [back, el('h3', { text: asset ? `Upload candidate for ${displayValue(asset.displayName, asset.assetId)}` : 'Upload candidate' })]),
      form
    ]);
  }

  async function submitUpload(file, values) {
    if (jobBusy || !canWrite()) return;
    setJobBusy(true);
    const generation = ++pollGeneration;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    let job = null;
    try {
      let jobId = reusableUpload?.key === key ? reusableUpload.jobId : null;
      if (!jobId) {
        tray = { title: 'Reserving the upload…' };
        renderTray();
        const reservation = await apiPost({
          base: API_BASE,
          path: '/api/uploads',
          body: { fileName: file.name, size: file.size, ...(file.type ? { contentType: file.type } : {}) },
          getIdToken
        });
        await uploadToStaging(file, reservation.stagingPath, (percent) => {
          tray = { title: `Uploading ${file.name} · ${percent}% of ${formatBytes(file.size)}` };
          renderTray();
        });
        jobId = reservation.jobId;
        reusableUpload = { key, jobId };
      }
      tray = { title: 'Starting the ingest job…' };
      renderTray();
      ({ job } = await apiPost({ base: API_BASE, path: '/api/jobs/ingest', body: buildIngestRequest(values, { jobId, baseSha: commitSha }), getIdToken }));
      reusableUpload = null;
      const final = await follow(job, generation);
      if (final?.status === 'done') {
        uploadForm = null;
        selectedAssetId = values.assetId.trim();
        await loadManifest();
      }
    } catch (error) {
      logUnexpected('upload', error);
      // These leave the reservation unused, so a retry with the same file skips the upload.
      if (!['stale_base', 'mutation_in_progress', 'rate_limited', 'invalid_request', 'network', 'upstream_error', 'vocabulary_unavailable'].includes(error?.code) || job) reusableUpload = null;
      tray = { job, title: job ? 'Lost track of the job' : 'The upload was not ingested', message: apiErrorMessage(error), isError: true, staleBase: error?.code === 'stale_base' };
    } finally {
      setJobBusy(false);
      renderTray();
    }
  }

  // ---- promote (always a dry run first)

  // Promote starts the mandatory dry run immediately with the asset's recorded name and category. The options form
  // only opens when something is missing or the user wants a different destination/name/category.
  function startPromotion(asset, revision, panel) {
    if (jobBusy || !canWrite()) return;
    if (!asset.displayName || !asset.category) {
      showPromoteOptions(asset, revision, panel, 'This asset needs a display name and category before it can be promoted. Fill them in to start the dry run.');
      return;
    }
    const change = el('button', { className: 'text-button', text: 'Change options', attrs: { type: 'button' } });
    change.addEventListener('click', () => showPromoteOptions(asset, revision, panel));
    panel.replaceChildren(el('div', { className: 'asset-form compact' }, [
      el('p', { className: 'dim', text: `Checking ${revision.revisionId} with a promotion dry run. Review the result in the panel above; nothing changes until you confirm.` }),
      change
    ]));
    startAndTrack('/api/jobs/promote', buildPromoteDryRunRequest({ baseSha: commitSha, assetId: asset.assetId, revisionId: revision.revisionId }));
  }

  function showPromoteOptions(asset, revision, panel, message = null) {
    const displayName = formField('Display name', el('input', { attrs: { type: 'text', autocomplete: 'off' } }), asset.displayName ? null : 'Required: this asset has no display name yet.');
    displayName.control.value = asset.displayName ?? '';
    const category = formField('Category', choice(vocabulary.categories, asset.category, 'Not set'), asset.category ? null : 'Required: this asset has no category yet.');
    const destination = formField('Destination (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: `assets/${asset.category ?? '<category>'}/${asset.assetId}` } }),
      'An unused directory under assets/. Left blank, the pipeline uses the placeholder path.');
    const run = el('button', { className: 'button primary asset-write-action', text: 'Run dry run', attrs: { type: 'button' } });
    run.disabled = jobBusy;
    const cancel = el('button', { className: 'button ghost', text: 'Close', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => panel.replaceChildren());
    run.addEventListener('click', () => {
      const errors = checkIngestForm({ assetId: asset.assetId, displayName: displayName.control.value }, vocabulary);
      displayName.error.textContent = errors.displayName ?? '';
      if (errors.displayName) return;
      startAndTrack('/api/jobs/promote', buildPromoteDryRunRequest({
        baseSha: commitSha,
        assetId: asset.assetId,
        revisionId: revision.revisionId,
        displayName: displayName.control.value,
        category: category.control.value,
        destination: destination.control.value
      }));
    });
    panel.replaceChildren(el('div', { className: 'asset-form compact' }, [
      el('p', { className: message ? 'asset-job-message error' : 'dim', text: message ?? `Run the promotion dry run for ${revision.revisionId} with different options. Nothing changes until you review it and confirm.` }),
      displayName.field, category.field, destination.field,
      el('div', { className: 'asset-job-actions' }, [run, cancel])
    ]));
  }

  assetButton.addEventListener('click', openLibrary);
  uploadButton.addEventListener('click', () => openUploadForm(null));
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
      role = null;
      vocabulary = null;
      uploadForm = null;
      reusableUpload = null;
      pollGeneration += 1;
      jobBusy = false;
      clearTray();
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
