// RigCheck 3D — INVASION Asset Library (browse, preview and Open in RigCheck; for writers also add files as
// candidates, retarget/bake clips, bind gameplay animation slots, promote and re-validate). The authoritative source is docs/ASSET_MANIFEST.yaml on invasion-godot 3d-migration,
// served by the Asset Library API. Asset bytes arrive only through short-lived signed URLs and enter the existing
// viewer through #fileInput. Changes run only as Asset Library jobs (the INVASION pipeline on GitHub Actions).
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytesResumable, getBlob } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { getFirestore, collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  COMPONENT_ORDER,
  NOT_AVAILABLE,
  STATE_ORDER,
  UNKNOWN,
  componentLabel,
  displayValue,
  formatBytes,
  formatDate,
  groupManifest,
  shortNote,
  stateLabel
} from "./lib/asset-library-model.js";
import { InspectError, inspectBuffer } from "./lib/animation-inspect.js";
import { revisionSkeleton, statusLabel as classificationLabel } from "./lib/rig-classify.js";
import { bindableClips, classifyAgainstAsset, extensionOf, manifestHashes, slotsFor, suggestComponent, suggestParent } from "./lib/asset-components.js";
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
  operationLabel,
  pollJob,
  roleFromClaims,
  summarizeAnimate,
  summarizeBind,
  summarizeDryRun,
  summarizeIngest,
  summarizeInspections,
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
const firestore = getFirestore(app);
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
  // A saved job report shown in the detail pane (any role); survives re-renders like the upload form.
  let reportView = null;
  // The asset whose Reports list was last opened, so returning from a report keeps the list open.
  let reportsOpenFor = null;
  // The raw manifest (for client-side classification) and the private rig profiles served with it.
  let rawManifest = null;
  let rigProfiles = null;
  // Selected detail tab per asset, and the multi-file Add files flow (writers).
  const assetTabs = new Map();
  let addFiles = null;
  let addFilesView = null;
  // A source revision chosen with "Retarget…" on its card, preselected in the Animations tab form.
  let retargetPreset = null;

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
          <button class="button secondary asset-write-action" id="assetLibraryUpload" type="button" hidden>Add files</button>
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
      rawManifest = response.manifest;
      rigProfiles = response.rigProfiles ?? null;
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
      rawManifest = null;
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
    body.classList.toggle('showing-detail', Boolean(selectedAssetId) || Boolean(reportView) || Boolean(addFilesView));
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
          reportView = null;
          addFilesView = null;
          addFiles = null;
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
    if (reportView) {
      detail.replaceChildren(reportView);
      return;
    }
    if (addFilesView && canWrite()) {
      detail.replaceChildren(addFilesView);
      return;
    }
    addFilesView = null;
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

    const tabs = detailTabs(asset);
    const tab = tabs.some((entry) => entry.id === assetTabs.get(asset.assetId)) ? assetTabs.get(asset.assetId) : 'overview';
    let content;
    if (tab === 'models') content = stateGroups(asset, asset.modelGroups);
    else if (tab === 'rig') content = rigTab(asset);
    else if (tab === 'animations') content = animationsTab(asset);
    else if (tab === 'materials') content = materialsTab(asset);
    else if (tab === 'history') content = historyTab(asset);
    else if (tab === 'validation') content = validationTab(asset);
    else content = [issues, summarySection, componentsOverview(asset), canonical ? el('section', { className: 'revision-group state-canonical' }, [
      el('h4', { text: 'Current model (canonical)' }), revisionCard(asset, canonical)]) : null, bindingsSummary(asset)];
    detail.replaceChildren(...[header, tabBar(asset, tabs, tab), ...content].filter(Boolean));
  }

  function stateGroups(asset, groupsByState) {
    const groups = [...STATE_ORDER, 'other']
      .filter((state) => groupsByState[state]?.length)
      .map((state) => el('section', { className: `revision-group state-${state}` }, [
        el('h4', { text: `${stateLabel(state)} (${groupsByState[state].length})` }),
        ...groupsByState[state].map((revision) => revisionCard(asset, revision))
      ]));
    return groups.length ? groups : [el('p', { className: 'dim', text: 'No model revisions are recorded for this asset.' })];
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

    const isClips = revision.component === 'animation_collection' || revision.component === 'source_clip';
    if (revision.openInRigCheckPath) {
      const open = el('button', { className: `button ${isClips ? 'secondary' : 'primary'}`, text: isClips ? 'Preview original' : 'Open in RigCheck',
        attrs: { type: 'button', title: isClips ? 'Open this file on its own skeleton in RigCheck' : 'Open this model in RigCheck' } });
      open.addEventListener('click', () => openInRigCheck(asset, revision, open));
      actions.append(open);
    }
    if (revision.component === 'animation_collection' && revision.animation?.clips?.length) {
      const target = previewTarget(asset, revision);
      if (target) {
        const show = el('button', { className: 'button primary', text: 'Preview on character', attrs: { type: 'button', title: `Play these clips on ${target.revisionId}` } });
        show.addEventListener('click', () => previewOnCharacter(asset, revision, target, show));
        actions.append(show);
      }
    }
    if (isClips && canWrite() && revision.animation?.clips?.length) {
      const retarget = el('button', { className: 'button secondary asset-write-action', text: 'Retarget…', attrs: { type: 'button' } });
      retarget.disabled = jobBusy;
      retarget.addEventListener('click', () => {
        retargetPreset = { assetId: asset.assetId, sources: [revision.revisionId] };
        assetTabs.set(asset.assetId, 'animations');
        render();
        detail.querySelector('.asset-retarget')?.scrollIntoView({ block: 'start' });
      });
      actions.append(retarget);
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
        el('span', { className: `badge component component-${revision.component}`, text: revision.componentLabel }),
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
      animationBlock(asset, revision),
      detailsBlock(`Manual review${review.required ? ` (${review.reasons.length})` : ''}`, reviewContent, review.required),
      revision.component === 'model' ? revisionProductionBlock(revision) : null,
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
    const upload = el('button', { className: 'button secondary asset-write-action', text: 'Add files', attrs: { type: 'button', title: 'Add models, clip collections, source clips or textures to this asset as candidates' } });
    upload.addEventListener('click', () => openAddFiles(asset));
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
        job?.runUrl ? el('a', { text: 'GitHub run', attrs: { href: job.runUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Technical diagnostics on GitHub Actions. The full report opens in RigCheck.' } }) : null
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

  function jobOutcome(job, options = {}) {
    if (job.status === 'error' && job.operation === 'promote_dry_run' && summarizeDryRun(job).available) return blockedReview(job, options);
    if (job.status === 'error') {
      const detailText = job.result?.pipeline?.error;
      return [
        el('p', { className: 'asset-job-message error', text: describeJobError(job) }),
        job.mutation ? el('p', { className: 'dim', text: job.pushed ? `Commit ${shortSha(job.commitSha)} was pushed.` : 'Nothing was committed to 3d-migration.' }) : null,
        typeof detailText === 'string' && detailText !== describeJobError(job) ? el('p', { className: 'dim', text: detailText }) : null
      ];
    }
    if (job.operation === 'animate') return animateOutcome(job);
    if (job.operation === 'bind') {
      const summary = summarizeBind(job);
      return [
        el('p', { className: 'asset-job-message', text: `Animation slots for ${displayValue(summary.assetId)} were saved and committed to 3d-migration as ${shortSha(job.commitSha) ?? UNKNOWN}.` }),
        summary.slots ? fileChangeTable(['Slot', 'Clip', 'Collection', 'Loop'], Object.entries(summary.slots).map(([slot, value]) => [slot, value.clip, value.revision_id, value.loop ? 'Loop' : 'Once'])) : null,
        summary.warnings.length ? issueList(summary.warnings) : null,
        summary.integrationRequired ? el('p', { className: 'dim', text: summary.integrationRequired }) : null
      ];
    }
    if (job.operation === 'ingest') {
      const summary = summarizeIngest(job);
      return [
        el('p', { className: 'asset-job-message', text: `${componentLabel(job.params?.component ?? 'model')} candidate ${displayValue(summary.revisionId)} was recorded for ${displayValue(summary.assetId)} and committed to 3d-migration as ${shortSha(job.commitSha) ?? UNKNOWN}.` }),
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
      if (options.inReport) return validationReport(job);
      const summary = summarizeValidation(job);
      const failing = summary.production.filter((entry) => entry.production?.status === 'fail').length;
      const open = el('button', { className: 'button primary', text: 'Open full report', attrs: { type: 'button' } });
      open.addEventListener('click', () => openReport(job));
      return [
        el('p', { className: 'asset-job-message', text: summary.available
          ? `${summary.ok ? 'Valid' : 'Not valid'} · ${summary.counts.error} errors · ${summary.counts.warning} warnings · ${summary.freshInspections} files re-inspected${failing ? ` · ${failing} revision${failing === 1 ? '' : 's'} over budget` : ''}`
          : 'The validation finished.' }),
        el('p', { className: 'dim', text: 'The full report (triangles, materials, textures, budgets, warnings and errors) opens here in RigCheck. It also stays under this asset\'s Reports.' }),
        el('div', { className: 'asset-job-actions' }, [open])
      ];
    }
    if (job.operation === 'promote_dry_run') return dryRunReview(job, options);
    return [];
  }

  function fileChangeTable(headings, rows) {
    return el('table', { className: 'revision-files' }, [
      el('thead', {}, [el('tr', {}, headings.map((label) => el('th', { text: label })))]),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((cell, index) => el('td', { className: /file/i.test(headings[index]) ? 'code' : undefined, text: displayValue(cell) })))))
    ]);
  }

  // Renders the pipeline's own dry-run payload, then gates "Confirm promotion" on it.
  function dryRunReview(job, { readOnly = false } = {}) {
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
    if (readOnly) {
      // A saved review: no acceptance or confirm here. Promoting always starts from a fresh dry run.
      return [
        el('p', { className: 'asset-job-message', text: job.confirmJobId ? 'Saved dry-run review. This dry run was confirmed.' : 'Saved dry-run review. To promote, click Promote… on the revision; that runs a fresh dry run first.' }),
        fields,
        productionView(summary.production, { open: true }),
        summary.warnings.length ? issueList(summary.warnings) : null,
        files
      ];
    }
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
  function blockedReview(job, { readOnly = false } = {}) {
    const summary = summarizeDryRun(job);
    const count = summary.blockers.length;
    return [
      el('p', { className: 'asset-job-message error', text: `Promotion is blocked, and nothing has changed. Resolve ${count === 1 ? 'this blocker' : `these ${count} blockers`} first:` }),
      issueList(summary.blockers, 'error'),
      productionView(summary.production, { open: summary.production?.status !== 'pass' }),
      summary.warnings.length ? detailsBlock(`Warnings (${summary.warnings.length})`, issueList(summary.warnings)) : null,
      readOnly ? null : el('div', { className: 'asset-job-actions' }, [rerunButton(job)])
    ];
  }

  // ---- saved job reports, read in RigCheck (GitHub Actions stays a technical diagnostic link)

  async function openReport(jobOrId) {
    let job = typeof jobOrId === 'string' ? null : jobOrId;
    try {
      if (!job) job = await fetchJob(jobOrId);
    } catch (error) {
      logUnexpected('report', error);
      setStatus(apiErrorMessage(error), true);
      return;
    }
    if (job.params?.asset_id && findAsset(job.params.asset_id)) selectedAssetId = job.params.asset_id;
    reportView = reportShell(job);
    render();
    detail.scrollTop = 0;
  }

  function reportShell(job) {
    const asset = findAsset(job.params?.asset_id);
    // Unlike the phone-only list back button, this one is always shown: a report replaces the asset detail.
    const back = el('button', { className: 'text-button asset-report-back', text: asset ? '← Back to asset' : '← All assets', attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      reportView = null;
      render();
    });
    const title = job.operation === 'validate' ? 'Validation report' : `${operationLabel(job.operation)} report`;
    const checkedOut = job.result?.checked_out_sha ?? job.baseSha;
    const meta = fieldList([
      ['Asset', asset ? displayValue(asset.displayName, asset.assetId) : job.params?.asset_id, { fallback: NOT_AVAILABLE }],
      ['Revision', job.params?.revision_id, { code: true, fallback: job.operation === 'validate' ? 'All revisions' : NOT_AVAILABLE }],
      ['Finished', isTerminalJob(job) ? formatDate(job.updatedAt) : 'Still running', {}],
      ['Repository state', shortSha(checkedOut), { code: true, fallback: NOT_AVAILABLE }],
      ['Result', jobStatusText(job), { wide: true }]
    ]);
    const body = isTerminalJob(job) ? jobOutcome(job, { readOnly: true, inReport: true }) : [el('p', { className: 'dim', text: 'This job has not finished yet. Reopen the report when it has.' })];
    const diagnostics = el('p', { className: 'dim asset-report-diagnostics' }, [
      job.runUrl ? el('a', { text: 'GitHub Actions run', attrs: { href: job.runUrl, target: '_blank', rel: 'noopener noreferrer' } }) : null,
      el('span', { text: `${job.runUrl ? ' · technical diagnostics only' : ''} · job ${job.jobId}` })
    ]);
    return el('section', { className: 'asset-report' }, [
      el('header', { className: 'asset-detail-head' }, [back, el('h3', { text: title })]),
      meta,
      ...body.filter(Boolean),
      diagnostics
    ]);
  }

  function validationReport(job) {
    const summary = summarizeValidation(job);
    if (!summary.available) {
      return [el('p', { className: 'asset-job-message error', text: job.resultTruncated
        ? 'This report was too large to store in full. Its complete result file is attached to the GitHub Actions run below (kept for 7 days).'
        : 'This report has no stored result.' })];
    }
    const files = summarizeInspections(job);
    const production = summary.production.filter((entry) => entry.production);
    return [
      el('p', { className: `asset-job-message${summary.ok ? '' : ' error'}`, text: `${summary.ok ? 'Valid' : 'Not valid'} · ${summary.counts.error} errors · ${summary.counts.warning} warnings · ${summary.freshInspections} files re-inspected` }),
      production.length ? el('section', { className: 'asset-report-section' }, [
        el('h4', { text: 'Production budgets' }),
        ...production.map((entry) => productionView(entry.production, { open: entry.production.status !== 'not_applicable', heading: `${entry.revisionId}${entry.canonicalState === 'canonical' ? ' (canonical)' : ''}` }))
      ]) : null,
      files.length ? el('section', { className: 'asset-report-section' }, [
        el('h4', { text: `Files (${files.length})` }),
        ...files.map(fileReport)
      ]) : el('p', { className: 'dim', text: 'No files were re-inspected (the validation ran without a re-check).' }),
      el('section', { className: 'asset-report-section' }, [
        el('h4', { text: `Findings (${summary.allFindings.length})` }),
        summary.allFindings.length
          ? el('ul', { className: 'issue-list' }, summary.allFindings.map((finding) => el('li', { className: `severity-${finding.severity}` }, [
            el('span', { className: 'issue-severity', text: String(finding.severity).toUpperCase() }),
            el('span', { text: finding.text })
          ])))
          : el('p', { className: 'dim', text: 'No findings.' })
      ])
    ];
  }

  function fileReport(file) {
    const model = file.model;
    const head = el('header', { className: 'revision-head' }, [
      el('span', { className: 'revision-id code', text: displayValue(file.fileName) }),
      el('span', { className: 'chip', text: `${String(file.format ?? '').toUpperCase()} · ${formatBytes(file.sizeBytes)}` }),
      el('span', { className: `badge production state-${file.technicalStatus === 'pass' ? 'pass' : file.technicalStatus === 'fail' ? 'fail' : 'warning'}`, text: `Technical: ${displayValue(file.technicalStatus)}` })
    ]);
    const parts = [head];
    if (model) {
      const textures = model.textures === null ? null
        : model.textures.length ? model.textures.map((t) => `${t.width ?? '?'}×${t.height ?? '?'}${t.mimeType ? ` ${t.mimeType.replace('image/', '')}` : ''}${t.width === null ? ' (size not measured)' : ''}`).join(', ') : 'None';
      parts.push(fieldList([
        ['glTF validity', model.valid === null ? null : model.valid ? 'Valid' : 'Invalid'],
        ['Triangles', model.triangles],
        ['Meshes', model.meshes],
        ['Materials', model.materialsUsed === null ? model.materialsDeclared : `${model.materialsUsed} used of ${displayValue(model.materialsDeclared, '?')}`],
        ['Skinned meshes', model.skinnedMeshes],
        ['Bones', model.bones],
        ['Vertices', model.vertices],
        ['Draw calls', model.drawCalls],
        ['Largest texture', model.maxTexture === null ? null : `${model.maxTexture} px`],
        ['Textures', textures, { wide: true }],
        ['Animation clips', model.animations.length ? model.animations.join(', ') : 'None', { wide: true }]
      ]));
      const validator = model.validator;
      if (validator) {
        const counts = `${validator.errors} errors · ${validator.warnings} warnings · ${validator.infos} infos · ${validator.hints} hints${validator.truncated ? ' (list truncated)' : ''}`;
        parts.push(validator.messages.length
          ? detailsBlock(`glTF validator: ${counts}`, el('ul', { className: 'issue-list' }, validator.messages.map((message) => el('li', { className: `severity-${message.severity}` }, [
            el('span', { className: 'issue-severity', text: message.severity.toUpperCase() }),
            el('span', { className: 'code', text: displayValue(message.code) }),
            el('span', { text: message.message }),
            message.pointer ? el('span', { className: 'code dim', text: message.pointer }) : null
          ]))), validator.errors + validator.warnings > 0)
          : el('p', { className: 'dim', text: `glTF validator: ${counts}` }));
      }
    }
    if (file.technicalIssues.length) {
      parts.push(el('ul', { className: 'issue-list' }, file.technicalIssues.map((issue) => el('li', { className: `severity-${issue.severity}` }, [
        el('span', { className: 'issue-severity', text: issue.severity.toUpperCase() }),
        el('span', { className: 'code', text: displayValue(issue.code) }),
        el('span', { text: issue.text })
      ]))));
    }
    return el('article', { className: 'revision-card asset-report-file' }, parts);
  }

  // Recent jobs for this asset (any role): reopen a validation report or a saved dry-run review at any time.
  function reportsBlock(asset) {
    const list = el('div', { className: 'asset-reports' }, [el('p', { className: 'dim', text: 'Loading…' })]);
    const block = detailsBlock('Reports', list);
    block.addEventListener('toggle', async () => {
      if (!block.open) {
        if (reportsOpenFor === asset.assetId) reportsOpenFor = null;
        return;
      }
      reportsOpenFor = asset.assetId;
      list.replaceChildren(el('p', { className: 'dim', text: 'Loading…' }));
      try {
        const { jobs } = await apiGet({ base: API_BASE, path: '/api/jobs', params: { asset: asset.assetId }, getIdToken });
        if (!jobs.length) {
          list.replaceChildren(el('p', { className: 'dim', text: 'No reports yet. Re-validate, upload or promote to create one.' }));
          return;
        }
        list.replaceChildren(...jobs.map((entry) => {
          const open = el('button', { className: 'button secondary', text: 'Open', attrs: { type: 'button' } });
          open.addEventListener('click', () => openReport(entry.jobId));
          const state = entry.status === 'done' ? 'pass' : entry.status === 'error' ? 'fail' : 'not_verified';
          return el('div', { className: 'asset-report-row' }, [
            el('span', { className: 'asset-report-name', text: `${operationLabel(entry.operation)}${entry.revisionId ? ` · ${entry.revisionId}` : ''}` }),
            el('span', { className: 'dim', text: formatDate(entry.createdAt) }),
            el('span', { className: `badge production state-${state}`, text: entry.status === 'done' ? 'Finished' : entry.status === 'error' ? `Failed${entry.errorCode ? ` · ${entry.errorCode}` : ''}` : 'In progress' }),
            open
          ]);
        }));
      } catch (error) {
        logUnexpected('reports', error);
        list.replaceChildren(el('p', { className: 'asset-job-message error', text: apiErrorMessage(error) }));
      }
    });
    if (reportsOpenFor === asset.assetId) block.open = true; // fires "toggle", which reloads the list
    return block;
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

  // ------------------------------------------------------------------------------------------- asset detail tabs

  function rawAsset(assetId) {
    return rawManifest?.assets?.find((asset) => asset?.asset_id === assetId) ?? null;
  }

  function is3d(asset) {
    return asset.revisions.some((revision) => revision.files.some((file) => ['glb', 'gltf', 'fbx'].includes(file.format)));
  }

  function detailTabs(asset) {
    const threeD = is3d(asset);
    const count = (component) => asset.components[component]?.length ?? 0;
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'models', label: threeD ? `Models (${count('model')})` : `Revisions (${count('model')})` },
      threeD ? { id: 'rig', label: 'Rig' } : null,
      threeD ? { id: 'animations', label: `Animations (${count('animation_collection') + count('source_clip')})` } : null,
      { id: 'materials', label: 'Materials' },
      { id: 'history', label: `History (${asset.revisionCount})` },
      { id: 'validation', label: 'Validation' }
    ];
    return tabs.filter(Boolean);
  }

  function tabBar(asset, tabs, active) {
    const bar = el('nav', { className: 'asset-tabs', attrs: { role: 'tablist', 'aria-label': 'Asset sections' } });
    for (const tab of tabs) {
      const button = el('button', { className: `asset-tab${tab.id === active ? ' active' : ''}`, text: tab.label,
        attrs: { type: 'button', role: 'tab', 'aria-selected': String(tab.id === active), 'data-tab': tab.id } });
      button.addEventListener('click', () => {
        assetTabs.set(asset.assetId, tab.id);
        render();
        detail.scrollTop = 0;
      });
      bar.append(button);
    }
    return bar;
  }

  function componentsOverview(asset) {
    const rows = COMPONENT_ORDER.filter((component) => asset.components[component]?.length).map((component) => {
      const list = asset.components[component];
      const canonicalId = component === 'model' ? asset.canonicalRevisionId : asset.componentCanonicals[component];
      const candidates = list.filter((revision) => revision.state === 'candidate').length;
      return [componentLabel(component), `${list.length} revision${list.length === 1 ? '' : 's'} · canonical ${canonicalId ?? 'none'} · ${candidates} candidate${candidates === 1 ? '' : 's'}`];
    });
    if (!rows.length) return null;
    return el('section', { className: 'asset-summary' }, [
      el('h4', { text: 'Components' }),
      fieldList(rows.map(([label, value]) => [label, value, { wide: true }])),
      el('p', { className: 'dim', text: 'Each component is versioned and promoted on its own. A clip collection never replaces the model, and the model canonical is what the game references.' })
    ]);
  }

  function bindingsSummary(asset) {
    const slots = slotsFor(rigProfiles, asset.category);
    if (!slots.length) return null;
    const bound = asset.bindings?.slots ?? {};
    return el('section', { className: 'asset-summary' }, [
      el('h4', { text: 'Gameplay animation slots' }),
      fieldList(slots.map(({ slot, loop }) => [slot, bound[slot] ? `${bound[slot].clip} · ${bound[slot].revisionId}${bound[slot].loop === false ? ' · once' : ' · loops'}` : `Not bound (${loop ? 'looping' : 'one-shot'} slot)`])),
      el('p', { className: 'dim', text: 'Bindings record intent only. The game still uses the model canonical\'s own clips until a bound collection is promoted and integrated in Godot.' })
    ]);
  }

  function modelSkeletonInfo(revision) {
    const raw = rawAsset(selectedAssetId)?.revisions?.find((entry) => entry.revision_id === revision.revisionId);
    const resolved = raw ? revisionSkeleton(raw, rigProfiles) : null;
    const recorded = revision.animation?.skeleton;
    const rigId = recorded?.rig ?? resolved?.rig ?? null;
    const rig = rigId ? rigProfiles?.rigs?.[rigId] : null;
    return { resolved, recorded, rigId, rig };
  }

  function rigTab(asset) {
    const parts = [];
    for (const revision of asset.components.model ?? []) {
      const { resolved, recorded, rigId, rig } = modelSkeletonInfo(revision);
      const mechanical = revision.animation?.mechanical;
      if (!resolved?.joints?.length && !mechanical) continue;
      const naming = recorded?.naming ?? (rig ? rig.naming : null);
      const family = recorded?.family ?? rig?.family ?? (rigProfiles?.namings?.[naming]?.family ?? null);
      const fields = fieldList([
        ['Revision', `${revision.revisionId}${revision.isCanonical ? ' (canonical)' : ''}`, { code: true }],
        ['Skeleton', resolved?.joints?.length ? `${displayValue(resolved.name)} · ${resolved.joints.length} joints` : 'No skeleton'],
        ['Rig profile', rig ? `${rig.label ?? rigId}` : naming ? `Unregistered rig with ${rigProfiles?.namings?.[naming]?.label ?? naming} naming` : 'Not recognised', { wide: true }],
        ['Family', family],
        ['Rest pose', rig?.rest_pose, { wide: true, fallback: NOT_AVAILABLE }],
        ['Units / facing', [rig?.units, rig?.forward].filter(Boolean).join(' · ') || null, { wide: true, fallback: NOT_AVAILABLE }],
        ['Source of this data', resolved?.source === 'recorded' ? 'Recorded at ingest' : resolved?.source === 'profile_reference' ? 'Matched to the registered rig reference by joint names' : resolved?.source === 'names_only' ? 'Joint names only' : NOT_AVAILABLE, { wide: true }],
        ['Notes', rig?.notes, { wide: true, prose: true, fallback: NOT_AVAILABLE }]
      ]);
      const card = el('article', { className: 'revision-card' }, [fields]);
      if (family === 'insectoid') card.append(el('p', { className: 'dim', text: 'Creature rigs are registered for identification only. Clips are shared only with an identical rig; there is no creature retargeting.' }));
      if (mechanical) card.append(mechanicalBlock(mechanical));
      parts.push(card);
    }
    if (!parts.length) parts.push(el('p', { className: 'dim', text: 'No skeleton or pivot data is recorded for this asset\'s models.' }));
    return [el('section', { className: 'revision-group' }, [el('h4', { text: 'Rig and pivots' }), ...parts])];
  }

  function mechanicalBlock(mechanical) {
    return el('div', { className: 'asset-mechanical' }, [
      el('h5', { text: `Mechanical pivots${mechanical.profile ? ` (${mechanical.profile})` : ''}` }),
      fileChangeTable(['Pivot node', 'Role', 'Parent', 'Mesh'], mechanical.pivots.map((pivot) => [pivot.node, pivot.role, pivot.parent, pivot.has_mesh ? 'Yes' : 'No'])),
      mechanical.issues.length ? issueList(mechanical.issues.map((issue) => `${issue.code}: ${issue.message}`)) : el('p', { className: 'dim', text: 'Hierarchy and axis checks passed.' }),
      el('p', { className: 'dim', text: mechanical.note ?? 'Describes the model only; gameplay aiming is unchanged.' })
    ]);
  }

  function animationBlock(asset, revision) {
    const animation = revision.animation;
    if (!animation || (!animation.clips.length && !animation.mechanical && !animation.skeleton)) return null;
    const parts = [];
    if (animation.clips.length) {
      const derivedClips = new Map((animation.derived?.clips ?? []).map((clip) => [clip.output, clip]));
      const godotClips = new Map((animation.derived?.godot?.clips ?? []).map((clip) => [clip.name, clip]));
      parts.push(fileChangeTable(animation.derived ? ['Clip', 'Length', 'Mode', 'Bake', 'Godot'] : ['Clip', 'Length'], animation.clips.map((clip) => {
        const baked = derivedClips.get(clip.name);
        const godot = godotClips.get(clip.name);
        const row = [clip.name, clip.durationS === null ? null : `${clip.durationS.toFixed(2)} s`];
        if (animation.derived) row.push(baked?.mode ?? null, baked ? statusWord(baked.status) : null, godot ? (godot.ok ? `OK${godot.loop ? ' · loops' : ''}` : 'Failed') : 'Not run');
        return row;
      })));
    }
    if (animation.skeleton) {
      parts.push(fieldList([
        ['Skeleton', `${displayValue(animation.skeleton.name)} · ${displayValue(animation.skeleton.jointCount)} joints`],
        ['Naming', rigProfiles?.namings?.[animation.skeleton.naming]?.label ?? animation.skeleton.naming, { fallback: 'Not recognised' }],
        ['Registered rig', rigProfiles?.rigs?.[animation.skeleton.rig]?.label ?? animation.skeleton.rig, { fallback: 'None' }]
      ]));
    }
    if (animation.classification.length) {
      parts.push(el('ul', { className: 'asset-classification' }, animation.classification.map((entry) => el('li', {}, [
        el('span', { className: `badge classification ${entry.status}`, text: classificationLabel(entry.status) }),
        el('span', { className: 'code', text: `→ ${entry.targetRevision}${entry.targetState === 'canonical' ? ' (canonical model)' : ''}` }),
        el('span', { className: 'dim', text: entry.reasons.join(' ') })
      ]))));
    }
    const derived = animation.derived;
    if (derived) {
      parts.push(fieldList([
        ['Baked for', derived.target?.revision_id ? `${derived.target.asset_id}/${derived.target.revision_id}` : null, { code: true, wide: true }],
        ['Sources', derived.sources.map((source) => `${source.asset_id ?? '?'}/${source.revision_id ?? '?'} (${source.format ?? '?'}, ${source.naming ?? '?'})`).join(', '), { wide: true }],
        ['Recipe', derived.recipeSha256 ? derived.recipeSha256.slice(0, 16) : null, { code: true }],
        ['Tool', derived.tool ? `${derived.tool.name} ${derived.tool.version} · Blender ${derived.tool.blender}` : null, { wide: true }],
        ['Rest pose after export', derived.exportCheck ? (derived.exportCheck.rest_pose_unchanged ? 'Unchanged' : 'Changed') : null],
        ['Godot 4.6.3 check', derived.godot ? `${derived.godot.ok ? 'Passed' : derived.godot.ok === false ? 'Failed' : 'Not run'}${derived.godot.engine ? ` · ${derived.godot.engine}` : ''}` : 'Not run', { wide: true }]
      ]));
      const failed = derived.clips.filter((clip) => !['pass', 'warning'].includes(clip.status));
      if (failed.length) parts.push(el('div', {}, [el('strong', { text: 'Clips left out of this collection' }), issueList(failed.map((clip) => `${clip.output ?? clip.sourceClip ?? 'Clip'}: ${clip.error ?? statusWord(clip.status)}${clip.issues.length ? ` — ${clip.issues.map((i) => i.message).join(' ')}` : ''}`), 'error')]));
      const metrics = derived.clips.filter((clip) => ['pass', 'warning'].includes(clip.status));
      if (metrics.length) {
        parts.push(detailsBlock('Bake validation per clip', fileChangeTable(['Clip', 'Knee min', 'Loop seam', 'Pose error', 'Issues'], metrics.map((clip) => {
          const knees = clip.metrics.knee_flexion_deg ?? {};
          const kneeMin = Math.min(...Object.values(knees).map((range) => range?.[0]).filter((v) => typeof v === 'number'));
          return [clip.output, Number.isFinite(kneeMin) ? `${kneeMin.toFixed(1)}°` : null, typeof clip.metrics.loop_seam_deg === 'number' ? `${clip.metrics.loop_seam_deg.toFixed(1)}°` : null,
            typeof clip.metrics.absolute_direction_error_deg === 'number' ? `${clip.metrics.absolute_direction_error_deg.toFixed(1)}°` : '—',
            clip.issues.length ? clip.issues.map((issue) => issue.code).join(', ') : 'None'];
        }))));
      }
    }
    if (animation.mechanical) parts.push(mechanicalBlock(animation.mechanical));
    return detailsBlock(animation.clips.length ? `Animation (${animation.clips.length} clip${animation.clips.length === 1 ? '' : 's'})` : 'Rig data', el('div', { className: 'asset-animation' }, parts), revision.component !== 'model');
  }

  function statusWord(status) {
    return { pass: 'Pass', warning: 'Warnings', fail: 'Failed validation', error: 'Error' }[status] ?? displayValue(status);
  }

  // The model a collection previews on: the revision it was baked for, else the canonical model, else any rigged model.
  function previewTarget(asset, revision) {
    const models = (asset.components.model ?? []).filter((model) => model.openInRigCheckPath && /\.glb$/i.test(model.openInRigCheckPath));
    const baked = revision.animation?.derived?.target?.revision_id;
    return models.find((model) => model.revisionId === baked) ?? models.find((model) => model.isCanonical) ?? models[0] ?? null;
  }

  async function loadFilesIntoViewer(files) {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    const loaded = await waitForViewer(files[0].name);
    if (loaded && sourceLabel) sourceLabel.textContent = 'INVASION ASSET';
    return loaded;
  }

  async function previewOnCharacter(asset, revision, target, button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      const progress = (label) => (received, total) => setStatus(total ? `Downloading ${label} · ${Math.round((received / total) * 100)}% of ${formatBytes(total)}` : `Downloading ${label} · ${formatBytes(received)}`);
      const model = await downloadAssetFile(asset.assetId, target.revisionId, target.openInRigCheckPath, progress(`model ${target.revisionId}`));
      const clips = await downloadAssetFile(asset.assetId, revision.revisionId, revision.openInRigCheckPath, progress(`clips ${revision.revisionId}`));
      setStatus(`Opening ${revision.revisionId} on ${target.revisionId} in RigCheck…`);
      if (!(await loadFilesIntoViewer([model, clips]))) throw new AssetApiError('internal', 0, 'The viewer could not open these files.');
      setStatus(`${revision.animation.clips.length} clip(s) from ${revision.revisionId} are playing on ${target.revisionId}. Choose a clip in the viewer.`);
      closeLibrary();
    } catch (error) {
      logUnexpected('preview', error);
      setStatus(error instanceof AssetApiError ? error.message : describeApiError('internal'), true);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  function animationsTab(asset) {
    const collections = asset.components.animation_collection ?? [];
    const sources = asset.components.source_clip ?? [];
    const parts = [];
    if (slotsFor(rigProfiles, asset.category).length) parts.push(bindingEditor(asset));
    if (canWrite()) parts.push(retargetForm(asset));
    for (const [label, list] of [['Animation collections', collections], ['Source clips', sources]]) {
      if (!list.length) continue;
      parts.push(el('section', { className: 'revision-group' }, [el('h4', { text: `${label} (${list.length})` }), ...list.map((revision) => revisionCard(asset, revision))]));
    }
    if (!collections.length && !sources.length) {
      parts.push(el('div', { className: 'asset-empty' }, [
        el('strong', { text: 'No clips yet' }),
        el('span', { text: 'Add Mixamo FBX files as source clips or a GLB with clips as a collection, then retarget them onto this asset\'s model.' })
      ]));
    }
    return parts;
  }

  function bindingEditor(asset) {
    const slots = slotsFor(rigProfiles, asset.category);
    const clips = bindableClips(rawAsset(asset.assetId));
    const bound = asset.bindings?.slots ?? {};
    const section = el('section', { className: 'asset-summary asset-bindings' }, [el('h4', { text: 'Gameplay animation slots' })]);
    const rows = [];
    const table = el('div', { className: 'asset-binding-rows' });
    for (const { slot, loop, rootMotion } of slots) {
      const select = el('select', { attrs: { 'aria-label': `Clip for ${slot}` } });
      select.append(el('option', { text: 'Not bound', attrs: { value: '' } }));
      for (const clip of clips) {
        select.append(el('option', { text: `${clip.clip} — ${clip.revisionId} (${clip.state}${clip.baked ? `, baked for ${clip.targetRevision ?? '?'}` : ', not baked'})`, attrs: { value: `${clip.revisionId}\u0000${clip.clip}` } }));
      }
      const current = bound[slot];
      select.value = current ? `${current.revisionId}\u0000${current.clip}` : '';
      const loopBox = el('input', { attrs: { type: 'checkbox' } });
      loopBox.checked = current?.loop ?? loop;
      const root = el('select', { attrs: { 'aria-label': `Root motion for ${slot}` } }, ['in_place', 'keep'].map((value) => el('option', { text: value === 'in_place' ? 'In place' : 'Keep root motion', attrs: { value } })));
      root.value = current?.rootMotion ?? rootMotion ?? 'in_place';
      select.disabled = loopBox.disabled = root.disabled = !canWrite() || jobBusy;
      rows.push({ slot, select, loopBox, root, current });
      table.append(el('div', { className: 'asset-binding-row' }, [
        el('span', { className: 'asset-binding-slot code', text: slot }), select,
        el('label', { className: 'asset-accept' }, [loopBox, el('span', { text: 'Loop' })]), root
      ]));
    }
    section.append(table);
    if (!clips.length) section.append(el('p', { className: 'dim', text: 'There are no clips to bind yet. Retarget clips onto this asset\'s model first.' }));
    if (canWrite()) {
      const save = el('button', { className: 'button primary asset-write-action', text: 'Save slot bindings', attrs: { type: 'button' } });
      save.disabled = jobBusy || !clips.length;
      save.addEventListener('click', () => {
        const slotsBody = {};
        for (const row of rows) {
          const [revisionId, clip] = row.select.value ? row.select.value.split('\u0000') : [null, null];
          const before = row.current ? `${row.current.revisionId}\u0000${row.current.clip}\u0000${row.current.loop}\u0000${row.current.rootMotion}` : '';
          const after = revisionId ? `${revisionId}\u0000${clip}\u0000${row.loopBox.checked}\u0000${row.root.value}` : '';
          if (before === after) continue;
          slotsBody[row.slot] = revisionId ? { revisionId, clip, loop: row.loopBox.checked, rootMotion: row.root.value } : null;
        }
        if (!Object.keys(slotsBody).length) {
          setStatus('The slot bindings are unchanged.');
          return;
        }
        startAndTrack('/api/jobs/bind', { baseSha: commitSha, assetId: asset.assetId, slots: slotsBody }, { refreshOnDone: true });
      });
      section.append(el('div', { className: 'asset-job-actions' }, [save]));
    }
    section.append(el('p', { className: 'dim', text: 'Saving records the bindings in the manifest (a reviewed commit to 3d-migration). It does not change Godot scenes or the game\'s current clips.' }));
    return section;
  }

  function retargetForm(asset) {
    const raw = rawAsset(asset.assetId);
    const targets = (asset.components.model ?? []).filter((model) => model.files.some((file) => file.format === 'glb'));
    const sourceRevisions = [...(asset.components.source_clip ?? []), ...(asset.components.animation_collection ?? [])].filter((revision) => revision.animation?.clips?.length);
    const preset = retargetPreset?.assetId === asset.assetId ? retargetPreset : null;
    const section = el('section', { className: 'asset-summary asset-retarget' }, [el('h4', { text: 'Retarget and bake' })]);
    if (!targets.length || !sourceRevisions.length) {
      section.append(el('p', { className: 'dim', text: !targets.length ? 'This asset has no rigged GLB model to bake onto.' : 'Add source clips (Mixamo FBX) or a clip collection first.' }));
      return section;
    }
    const targetSelect = el('select');
    for (const model of targets) targetSelect.append(el('option', { text: `${model.revisionId}${model.isCanonical ? ' (canonical)' : ''} · ${model.state}`, attrs: { value: model.revisionId } }));
    targetSelect.value = (targets.find((model) => model.isCanonical) ?? targets[0]).revisionId;
    const target = formField('Target model', targetSelect, 'Clips are baked onto this model\'s skeleton. The result is a new candidate collection; nothing becomes canonical.');
    const clipRows = [];
    const sourcesBox = el('div', { className: 'asset-retarget-sources' });
    for (const revision of sourceRevisions) {
      const include = el('input', { attrs: { type: 'checkbox' } });
      include.checked = preset ? preset.sources.includes(revision.revisionId) : revision.component === 'source_clip' && revision.state !== 'superseded';
      const classification = revision.animation.classification.find((entry) => entry.targetRevision === targetSelect.value) ?? revision.animation.classification[0];
      const head = el('label', { className: 'asset-accept' }, [include, el('span', { text: `${revision.revisionId} · ${revision.componentLabel} · ${revision.animation.clips.length} clip${revision.animation.clips.length === 1 ? '' : 's'}` }),
        classification ? el('span', { className: `badge classification ${classification.status}`, text: classificationLabel(classification.status) }) : null]);
      const rows = revision.animation.clips.map((clip) => {
        const use = el('input', { attrs: { type: 'checkbox' } });
        use.checked = true;
        const output = el('input', { attrs: { type: 'text', value: '', placeholder: revision.animation.format === 'fbx' && revision.animation.clips.length === 1 ? 'file name' : clip.name, spellcheck: 'false', 'aria-label': `Output name for ${clip.name}` } });
        const mode = choice(['cyclic', 'absolute'], '', 'auto');
        const loop = choice(['loop', 'once'], '', 'auto');
        const row = el('div', { className: 'asset-retarget-clip' }, [use, el('span', { className: 'code', text: clip.name }), output, mode, loop]);
        clipRows.push({ revision, clip, use, output, mode, loop, include });
        return row;
      });
      sourcesBox.append(el('div', { className: 'asset-retarget-source' }, [head, ...rows]));
    }
    const note = formField('Note (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off' } }));
    const run = el('button', { className: 'button primary asset-write-action', text: 'Bake as candidate collection', attrs: { type: 'button' } });
    run.disabled = jobBusy;
    const error = el('p', { className: 'asset-form-error', attrs: { role: 'alert' } });
    run.addEventListener('click', () => {
      const chosen = sourceRevisions.filter((revision) => clipRows.some((row) => row.revision === revision && row.include.checked));
      if (!chosen.length) {
        error.textContent = 'Choose at least one source.';
        return;
      }
      const overrides = [];
      for (const row of clipRows) {
        const index = chosen.indexOf(row.revision);
        if (index < 0) continue;
        const entry = { source: index, clip: row.clip.name };
        if (!row.use.checked) entry.skip = true;
        if (row.output.value.trim()) entry.output = row.output.value.trim();
        if (row.mode.value) entry.mode = row.mode.value;
        if (row.loop.value) entry.loop = row.loop.value === 'loop';
        if (Object.keys(entry).length > 2) overrides.push(entry);
      }
      error.textContent = '';
      retargetPreset = null;
      startAndTrack('/api/jobs/animate', {
        baseSha: commitSha, assetId: asset.assetId, targetRevisionId: targetSelect.value,
        sources: chosen.map((revision) => ({ assetId: asset.assetId, revisionId: revision.revisionId })),
        ...(overrides.length ? { recipe: { overrides } } : {}),
        ...(note.control.value.trim() ? { note: note.control.value.trim() } : {})
      }, { refreshOnDone: true });
    });
    section.append(target.field, el('div', { className: 'asset-form-label', text: 'Sources and clips (mode and loop default to automatic: walk/run/idle are cyclic and loop; other clips are held poses)' }),
      sourcesBox, note.field, error, el('div', { className: 'asset-job-actions' }, [run]),
      el('p', { className: 'dim', text: 'Runs Blender 4.3.2 offline on the job runner, validates every clip (knees, loop seams, pose, rest pose) and checks import and looping in Godot 4.6.3. Failed clips are reported and left out.' }));
    if (!raw) section.append(el('p', { className: 'asset-job-message error', text: 'The manifest has not loaded.' }));
    return section;
  }

  function animateOutcome(job) {
    const summary = summarizeAnimate(job);
    if (job.status === 'error' || !summary.available) {
      return [
        el('p', { className: 'asset-job-message error', text: describeJobError(job) }),
        summary.clips.length ? animateClipTable(summary) : null,
        el('p', { className: 'dim', text: job.pushed ? `Commit ${shortSha(job.commitSha)} was pushed.` : 'Nothing was committed to 3d-migration.' })
      ];
    }
    return [
      el('p', { className: 'asset-job-message', text: summary.duplicate
        ? `This exact bake is already recorded as ${displayValue(summary.revisionId)}; nothing new was committed.`
        : `Candidate collection ${displayValue(summary.revisionId)} (${summary.summary?.baked ?? '?'} clip${summary.summary?.baked === 1 ? '' : 's'}) was recorded for ${displayValue(summary.assetId)} and committed as ${shortSha(job.commitSha) ?? UNKNOWN}.` }),
      animateClipTable(summary),
      el('p', { className: 'dim', text: `Godot 4.6.3: ${summary.godot ? (summary.godot.ok ? 'every clip resolved on the model and played with the right loop behaviour' : `failed — ${(summary.godot.errors ?? []).join(' ') || summary.godot.reason || 'see the report'}`) : 'not run'}. Rest pose after export: ${summary.exportCheck?.rest_pose_unchanged ? 'unchanged' : 'not verified'}.` })
    ];
  }

  function animateClipTable(summary) {
    return fileChangeTable(['Clip', 'Mode', 'Result', 'Knee min', 'Loop seam', 'Godot'], summary.clips.map((clip) => [
      clip.output ?? clip.sourceClip ?? 'Source', clip.mode ?? '—',
      [statusWord(clip.status), clip.error, clip.issues.length ? clip.issues.join('; ') : null].filter(Boolean).join(' — '),
      clip.kneeMin === null ? '—' : `${clip.kneeMin.toFixed(1)}°`, clip.loopSeam === null || clip.loopSeam === undefined ? '—' : `${Number(clip.loopSeam).toFixed(1)}°`,
      clip.godot ? (clip.godot.ok ? `OK${clip.godot.loop ? ' · loops' : ''}` : 'Failed') : (['pass', 'warning'].includes(clip.status) ? 'Not run' : '—')
    ]));
  }

  function materialsTab(asset) {
    const parts = [];
    for (const revision of [...(asset.components.model ?? []), ...(asset.components.materials ?? [])]) {
      const textures = revision.files.filter((file) => file.role === 'textures' || ['png', 'jpg', 'jpeg', 'webp', 'ktx2'].includes(file.format));
      if (!revision.model.materials?.length && !textures.length) continue;
      parts.push(el('article', { className: 'revision-card' }, [
        el('header', { className: 'revision-head' }, [el('span', { className: 'revision-id code', text: revision.revisionId }),
          el('span', { className: `badge component component-${revision.component}`, text: revision.componentLabel }),
          el('span', { className: `badge state ${revision.isCanonical ? 'canonical' : revision.state ?? ''}`, text: revision.isCanonical ? 'CANONICAL' : displayValue(revision.state).toUpperCase() })]),
        fieldList([['Materials', revision.model.materials?.map((name) => name ?? UNKNOWN), { wide: true, fallback: NOT_AVAILABLE }], ['Textures in the model', revision.model.textureCount]]),
        textures.length ? fileChangeTable(['Texture file', 'Format', 'Size'], textures.map((file) => [file.path, file.format, formatBytes(file.sizeBytes)])) : null
      ]));
    }
    return parts.length ? [el('section', { className: 'revision-group' }, [el('h4', { text: 'Materials and textures' }), ...parts])]
      : [el('p', { className: 'dim', text: 'No material or texture data is recorded for this asset.' })];
  }

  function historyTab(asset) {
    const revisions = [...asset.revisions].sort((a, b) => (new Date(b.latestDate ?? 0).getTime() || 0) - (new Date(a.latestDate ?? 0).getTime() || 0));
    return [el('section', { className: 'revision-group' }, [
      el('h4', { text: 'History (newest first)' }),
      fileChangeTable(['Revision', 'Component', 'State', 'Recorded', 'Promoted', 'Links', 'Note'], revisions.map((revision) => [
        revision.revisionId, revision.componentLabel, revision.isCanonical ? 'canonical (current)' : revision.state, formatDate(revision.ingestedAt ?? revision.recordedAt), formatDate(revision.promotedAt, '—'),
        [revision.supersedes && `supersedes ${revision.supersedes}`, revision.supersededBy && `superseded by ${revision.supersededBy}`].filter(Boolean).join('; ') || '—',
        shortNote(revision.note, 90) ?? '—'
      ]))
    ])];
  }

  function validationTab(asset) {
    const parts = [];
    const canonical = asset.canonical;
    if (canonical?.production) parts.push(productionView(canonical.production, { open: true, heading: `Production compliance (canonical model ${canonical.revisionId})` }));
    const review = asset.revisions.filter((revision) => revision.manualReview.required);
    parts.push(el('section', { className: 'asset-summary' }, [
      el('h4', { text: `Manual review (${review.length})` }),
      review.length ? el('ul', { className: 'issue-list' }, review.flatMap((revision) => revision.manualReview.reasons.map((reason) => el('li', { className: `severity-${reason.severity}` }, [
        el('span', { className: 'issue-severity', text: reason.severity.toUpperCase() }), el('span', { className: 'code', text: `${revision.revisionId} · ${displayValue(reason.code)}` }), el('span', { text: displayValue(reason.message, '') })
      ])))) : el('p', { className: 'dim', text: 'No manual review required by recorded data.' })
    ]));
    parts.push(reportsBlock(asset));
    return parts;
  }

  // ------------------------------------------------------------------------------------- add files (writers)

  function openAddFiles(asset = null) {
    if (!canWrite() || jobBusy) return;
    addFiles = { presetAssetId: asset?.assetId ?? null, items: [], cloud: null, running: false };
    reportView = null;
    refreshAddFiles();
    detail.scrollTop = 0;
  }

  function refreshAddFiles() {
    if (!addFiles) {
      addFilesView = null;
      return render();
    }
    addFilesView = buildAddFilesView();
    return render();
  }

  function suggestedId(name) {
    const stem = String(name).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 64);
    return stem || 'new_asset';
  }

  function applySuggestions(item, { keepParent = false } = {}) {
    const description = item.description;
    let parent = null;
    if (keepParent) {
      const asset = rawAsset(item.assetId);
      parent = asset ? { assetId: asset.asset_id, classification: description ? classifyAgainstAsset(description, asset, rigProfiles) : null } : null;
    } else {
      parent = description ? suggestParent(description, rawManifest, rigProfiles, addFiles.presetAssetId) : (addFiles.presetAssetId ? { assetId: addFiles.presetAssetId, classification: null } : null);
      item.assetId = parent?.assetId ?? addFiles.presetAssetId ?? suggestedId(item.name);
      item.parentReason = parent?.reason ?? (rawAsset(item.assetId) ? 'Selected asset' : 'New asset');
    }
    item.classification = parent?.classification ?? null;
    if (!item.componentTouched) {
      const suggestion = suggestComponent(item.name, description, rawAsset(item.assetId), item.classification);
      item.component = suggestion.component;
      item.componentReason = suggestion.reason;
    }
  }

  async function inspectItem(item, buffer) {
    try {
      item.description = ['glb', 'fbx'].includes(extensionOf(item.name)) ? inspectBuffer(item.name, buffer) : { format: extensionOf(item.name), skeletons: [], clips: [], nodes: null };
      item.inspectError = null;
    } catch (error) {
      item.description = null;
      item.inspectError = error instanceof InspectError ? error.message : 'The file could not be read.';
    }
    applySuggestions(item);
    item.inspecting = false;
  }

  async function addLocalFiles(fileList) {
    for (const file of [...fileList]) {
      const item = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: file.name, size: file.size, source: 'device', file,
        inspecting: true, status: 'pending', displayName: '', category: '' };
      addFiles.items.push(item);
      refreshAddFiles();
      const problem = checkUploadFile(file, vocabulary);
      if (problem) {
        Object.assign(item, { inspecting: false, status: 'blocked', message: problem });
        continue;
      }
      await inspectItem(item, await file.arrayBuffer());
      refreshAddFiles();
    }
  }

  async function loadCloudLibrary() {
    addFiles.cloud = { loading: true, models: [], error: null };
    refreshAddFiles();
    try {
      const snapshot = await getDocs(query(collection(firestore, 'users', currentUser.uid, 'models'), orderBy('updatedAt', 'desc')));
      const hashes = manifestHashes(rawManifest);
      addFiles.cloud = { loading: false, error: null, models: snapshot.docs.map((entry) => {
        const data = { id: entry.id, ...entry.data() };
        return { ...data, inManifest: data.sha256 ? hashes.get(String(data.sha256).toLowerCase()) ?? null : null };
      }) };
    } catch (error) {
      console.error('RigCheck Asset Library cloud listing error:', error);
      addFiles.cloud = { loading: false, models: [], error: 'Your Cloud Library could not be listed.' };
    }
    refreshAddFiles();
  }

  async function addCloudModel(model) {
    const name = model.originalName ?? String(model.storagePath ?? '').split('/').pop();
    const item = { id: `cloud-${model.id}`, name: String(model.storagePath ?? name).split('/').pop(), size: model.sizeBytes ?? null, source: 'cloud', cloudModel: model,
      inspecting: true, status: 'pending', displayName: '', category: '' };
    if (addFiles.items.some((existing) => existing.id === item.id)) return;
    addFiles.items.push(item);
    refreshAddFiles();
    try {
      const blob = await getBlob(storageRef(storage, model.storagePath));
      await inspectItem(item, await blob.arrayBuffer());
    } catch (error) {
      console.error('RigCheck Asset Library cloud read error:', error);
      Object.assign(item, { inspecting: false, status: 'blocked', message: 'This Cloud Library file could not be read.' });
    }
    refreshAddFiles();
  }

  function itemSummary(item) {
    const d = item.description;
    if (item.inspectError) return item.inspectError;
    if (!d) return item.inspecting ? 'Reading…' : '';
    const skeleton = d.skeletons?.[0];
    const parts = [String(d.format ?? extensionOf(item.name)).toUpperCase()];
    if (skeleton) parts.push(`${skeleton.jointCount ?? skeleton.joints?.length} joints`);
    if (d.clips?.length) parts.push(`${d.clips.length} clip${d.clips.length === 1 ? '' : 's'}`);
    if (d.mesh?.meshNodes !== undefined) parts.push(d.mesh.meshNodes ? `${d.mesh.meshNodes} mesh${d.mesh.meshNodes === 1 ? '' : 'es'}` : 'no mesh');
    const pivots = (d.nodes ?? []).filter((node) => node.role);
    if (pivots.length) parts.push(`pivots: ${pivots.map((node) => node.role).join(', ')}`);
    return parts.join(' · ');
  }

  function addFileRow(item) {
    const row = el('article', { className: `revision-card asset-add-item status-${item.status}` });
    const remove = el('button', { className: 'asset-icon-button', text: '×', attrs: { type: 'button', 'aria-label': `Remove ${item.name}` } });
    remove.disabled = addFiles.running;
    remove.addEventListener('click', () => {
      addFiles.items = addFiles.items.filter((entry) => entry !== item);
      refreshAddFiles();
    });
    row.append(el('header', { className: 'revision-head' }, [
      el('span', { className: 'revision-id code', text: item.name }),
      el('span', { className: 'chip', text: `${item.source === 'cloud' ? 'Cloud Library' : 'This device'} · ${formatBytes(item.size)}` }),
      item.status !== 'pending' ? el('span', { className: `badge production state-${item.status === 'done' ? 'pass' : item.status === 'failed' || item.status === 'blocked' ? 'fail' : 'not_verified'}`, text: item.status.toUpperCase() }) : null,
      remove
    ]));
    row.append(el('p', { className: 'dim', text: itemSummary(item) }));
    if (item.message) row.append(el('p', { className: `asset-job-message${['failed', 'blocked'].includes(item.status) ? ' error' : ''}`, text: item.message }));
    if (item.inspecting || item.status === 'blocked') return row;
    const clips = item.description?.clips ?? [];
    if (clips.length) {
      row.append(detailsBlock(`Detected clips (${clips.length})`, fileChangeTable(['Clip', 'Length'], clips.map((clip) => [clip.name, clip.durationS === null || clip.durationS === undefined ? null : `${Number(clip.durationS).toFixed(2)} s`])), clips.length <= 12));
    }
    const assetIds = grouped.categories.flatMap((category) => category.assets.map((asset) => asset.assetId)).sort();
    const parentInput = el('input', { attrs: { type: 'text', list: 'assetLibraryAssetIds', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Asset for ${item.name}` } });
    parentInput.value = item.assetId ?? '';
    parentInput.disabled = addFiles.running || item.status === 'done';
    parentInput.addEventListener('change', () => {
      item.assetId = parentInput.value.trim();
      item.parentReason = rawAsset(item.assetId) ? 'Chosen' : 'New asset';
      applySuggestions(item, { keepParent: true });
      refreshAddFiles();
    });
    const existing = rawAsset(item.assetId);
    const component = choice(vocabulary.components ?? ['model'], item.component, 'model');
    component.value = item.component;
    component.disabled = parentInput.disabled;
    component.addEventListener('change', () => {
      item.component = component.value;
      item.componentTouched = true;
      item.componentReason = 'Chosen';
      refreshAddFiles();
    });
    const fields = [
      formField('Asset', parentInput, existing ? `Existing asset: ${existing.display_name ?? existing.asset_id} · ${item.parentReason ?? ''}` : 'A new logical asset will be created with this ID.'),
      formField('Add as', component, item.componentReason)
    ];
    if (!existing) {
      const name = el('input', { attrs: { type: 'text', autocomplete: 'off' } });
      name.value = item.displayName;
      name.addEventListener('input', () => { item.displayName = name.value; });
      const category = choice(vocabulary.categories, item.category, 'Not set');
      category.addEventListener('change', () => { item.category = category.value; });
      name.disabled = category.disabled = parentInput.disabled;
      fields.push(formField('Display name (new asset)', name), formField('Category (new asset)', category));
    }
    row.append(el('div', { className: 'asset-add-fields' }, fields.map((entry) => entry.field)));
    if (item.classification) {
      row.append(el('p', { className: 'asset-classification-line' }, [
        el('span', { className: `badge classification ${item.classification.status}`, text: classificationLabel(item.classification.status) }),
        el('span', { className: 'dim', text: ` against ${item.classification.targetRevision}: ${item.classification.reasons.join(' ')}` })
      ]));
    } else if (item.description?.skeletons?.length && existing) {
      row.append(el('p', { className: 'dim', text: 'This asset has no model skeleton to compare with.' }));
    }
    if (item.revisionId) row.append(el('p', { className: 'asset-job-message', text: `Recorded as ${item.component} candidate ${item.revisionId}.` }));
    return row;
  }

  function buildAddFilesView() {
    const back = el('button', { className: 'text-button asset-back', text: addFiles.presetAssetId ? '← Back to asset' : '← All assets', attrs: { type: 'button' } });
    back.disabled = addFiles.running;
    back.addEventListener('click', () => {
      selectedAssetId = addFiles.presetAssetId ?? selectedAssetId;
      addFiles = null;
      addFilesView = null;
      render();
    });
    const picker = el('input', { attrs: { type: 'file', multiple: '', accept: vocabulary.supportedExtensions.join(',') } });
    picker.disabled = addFiles.running;
    picker.addEventListener('change', () => {
      if (picker.files?.length) addLocalFiles(picker.files);
    });
    const assetIds = grouped.categories.flatMap((category) => category.assets.map((asset) => asset.assetId)).sort();
    const datalist = el('datalist', { attrs: { id: 'assetLibraryAssetIds' } }, assetIds.map((id) => el('option', { attrs: { value: id } })));
    const cloudButton = el('button', { className: 'button ghost', text: addFiles.cloud ? 'Refresh Cloud Library' : 'Show unassigned Cloud Library files', attrs: { type: 'button' } });
    cloudButton.disabled = addFiles.running || addFiles.cloud?.loading;
    cloudButton.addEventListener('click', loadCloudLibrary);
    const cloud = el('div', { className: 'asset-cloud-files' });
    if (addFiles.cloud?.loading) cloud.append(el('p', { className: 'dim', text: 'Listing your RigCheck Cloud Library…' }));
    else if (addFiles.cloud?.error) cloud.append(el('p', { className: 'asset-job-message error', text: addFiles.cloud.error }));
    else if (addFiles.cloud) {
      const unassigned = addFiles.cloud.models.filter((model) => !model.inManifest);
      const assigned = addFiles.cloud.models.filter((model) => model.inManifest);
      cloud.append(el('p', { className: 'dim', text: `${unassigned.length} unassigned · ${assigned.length} already in the manifest (matched by content hash). Files without a recorded hash are listed as unassigned until the pipeline checks them.` }));
      for (const model of unassigned) {
        const add = el('button', { className: 'button secondary', text: 'Add', attrs: { type: 'button' } });
        add.disabled = addFiles.running || addFiles.items.some((item) => item.id === `cloud-${model.id}`);
        add.addEventListener('click', () => addCloudModel(model));
        cloud.append(el('div', { className: 'asset-report-row' }, [
          el('span', { className: 'asset-report-name', text: model.name ?? model.originalName ?? model.id }),
          el('span', { className: 'dim', text: `${formatBytes(model.sizeBytes)}${typeof model.clips === 'number' ? ` · ${model.clips} clips` : ''}${typeof model.bones === 'number' ? ` · ${model.bones} bones` : ''}` }),
          add
        ]));
      }
      if (assigned.length) {
        cloud.append(detailsBlock(`Already in the manifest (${assigned.length})`, el('ul', { className: 'issue-list' }, assigned.map((model) => el('li', {}, [
          el('span', { text: model.name ?? model.id }), el('span', { className: 'code dim', text: `${model.inManifest.assetId}/${model.inManifest.revisionId}` })
        ])))));
      }
    }
    const note = formField('Note (optional, all files)', el('textarea', { attrs: { rows: '2' } }));
    const source = formField('Source / provenance (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off', placeholder: 'e.g. Mixamo, Tripo -> Blender' } }));
    const creator = formField('Creator (optional)', el('input', { attrs: { type: 'text', autocomplete: 'off' } }));
    for (const [entry, key] of [[note, 'note'], [source, 'source'], [creator, 'creator']]) {
      entry.control.value = addFiles[key] ?? '';
      entry.control.disabled = addFiles.running;
      entry.control.addEventListener('input', () => { addFiles[key] = entry.control.value; });
    }
    const ready = addFiles.items.filter((item) => item.status === 'pending' && !item.inspecting);
    const submit = el('button', { className: 'button primary asset-write-action', text: ready.length ? `Add ${ready.length} file${ready.length === 1 ? '' : 's'} as candidates` : 'Add files as candidates', attrs: { type: 'button' } });
    submit.disabled = addFiles.running || jobBusy || !ready.length || addFiles.items.some((item) => item.inspecting);
    submit.addEventListener('click', submitAddFiles);
    return el('section', { className: 'asset-upload asset-add-files' }, [
      el('header', { className: 'asset-detail-head' }, [back, el('h3', { text: addFiles.presetAssetId ? `Add files to ${displayValue(rawAsset(addFiles.presetAssetId)?.display_name, addFiles.presetAssetId)}` : 'Add files' })]),
      el('p', { className: 'dim', text: 'Each file is read here first: clips, skeleton and pivots are detected and a parent asset and component are suggested. Check them, then add. Every file becomes a candidate through the INVASION pipeline; nothing becomes canonical, and the private manifest stays the only record.' }),
      formField('Files from this device', picker, `Supported: ${vocabulary.supportedExtensions.join(' ')} · up to ${formatBytes(vocabulary.maxUploadBytes)} each`).field,
      datalist,
      el('div', { className: 'asset-cloud' }, [el('div', { className: 'asset-job-actions' }, [cloudButton]), cloud]),
      ...addFiles.items.map(addFileRow),
      addFiles.items.length ? el('div', { className: 'asset-add-common' }, [note.field, source.field, creator.field]) : null,
      el('div', { className: 'asset-job-actions' }, [submit])
    ]);
  }

  async function submitAddFiles() {
    if (!addFiles || addFiles.running || jobBusy || !canWrite()) return;
    const items = addFiles.items.filter((item) => item.status === 'pending' && !item.inspecting);
    for (const item of items) {
      const values = { assetId: item.assetId ?? '', displayName: rawAsset(item.assetId) ? '' : item.displayName, category: rawAsset(item.assetId) ? '' : item.category,
        note: addFiles.note ?? '', source: addFiles.source ?? '', creator: addFiles.creator ?? '' };
      const errors = checkIngestForm(values, vocabulary);
      if (Object.keys(errors).length) {
        Object.assign(item, { status: 'failed', message: Object.values(errors).join(' ') });
      }
    }
    addFiles.running = true;
    setJobBusy(true);
    refreshAddFiles();
    for (const item of items) {
      if (item.status !== 'pending') continue;
      const generation = ++pollGeneration;
      try {
        item.status = 'uploading';
        item.message = item.source === 'cloud' ? 'Copying from your Cloud Library…' : 'Uploading…';
        refreshAddFiles();
        let reservation;
        if (item.source === 'cloud') {
          reservation = await apiPost({ base: API_BASE, path: '/api/uploads/library', body: { modelId: item.cloudModel.id }, getIdToken });
        } else {
          reservation = await apiPost({ base: API_BASE, path: '/api/uploads', body: { fileName: item.file.name, size: item.file.size, ...(item.file.type ? { contentType: item.file.type } : {}) }, getIdToken });
          await uploadToStaging(item.file, reservation.stagingPath, (percent) => {
            item.message = `Uploading · ${percent}%`;
            refreshAddFiles();
          });
        }
        item.status = 'ingesting';
        item.message = 'The pipeline is checking and recording the file…';
        refreshAddFiles();
        const values = { assetId: item.assetId, component: item.component, note: addFiles.note ?? '', source: addFiles.source ?? '', creator: addFiles.creator ?? '',
          ...(rawAsset(item.assetId) ? {} : { displayName: item.displayName, category: item.category }) };
        const { job } = await apiPost({ base: API_BASE, path: '/api/jobs/ingest', body: buildIngestRequest(values, { jobId: reservation.jobId, baseSha: commitSha }), getIdToken });
        const final = await follow(job, generation);
        if (final?.status === 'done') {
          Object.assign(item, { status: 'done', revisionId: summarizeIngest(final).revisionId, message: null });
          await loadManifest();
        } else {
          Object.assign(item, { status: 'failed', message: final ? describeJobError(final) : 'The job did not finish.' });
        }
      } catch (error) {
        logUnexpected('add files', error);
        Object.assign(item, { status: 'failed', message: apiErrorMessage(error) });
        if (error?.code === 'stale_base') await loadManifest();
      }
      refreshAddFiles();
    }
    addFiles.running = false;
    setJobBusy(false);
    const done = items.filter((item) => item.status === 'done').length;
    setStatus(`${done} of ${items.length} file${items.length === 1 ? '' : 's'} added as candidates.`, done < items.length);
    refreshAddFiles();
  }

  assetButton.addEventListener('click', openLibrary);
  uploadButton.addEventListener('click', () => openAddFiles(null));
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
      reportView = null;
      addFiles = null;
      addFilesView = null;
      rawManifest = null;
      rigProfiles = null;
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
