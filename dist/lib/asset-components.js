// RigCheck Asset Library — suggestions for adding files: which component a file is and which logical asset it belongs
// to, from its content (skeleton, clips, pivots) and the manifest. Pure functions; the owner confirms or corrects every
// suggestion before anything is uploaded, and the private pipeline re-checks everything on ingest.
import { classify, fileSkeleton, revisionSkeleton } from './rig-classify.js';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tga', 'exr', 'hdr', 'ktx2', 'tif', 'tiff', 'psd']);
const RANK = { compatible: 4, requires_retarget: 3, incompatible: 1, unknown: 0, not_applicable: 0 };

export function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : '';
}

const componentOf = (revision) => revision?.component || 'model';

function modelRevisions(asset) {
  return (asset?.revisions ?? []).filter((revision) => componentOf(revision) === 'model');
}

function hasGlbModel(asset) {
  return modelRevisions(asset).some((revision) => (revision.files ?? []).some((file) => /\.glb$/i.test(file?.path ?? '')));
}

// Best classification of a file's skeleton against the model revisions of one asset (canonical first on ties).
export function classifyAgainstAsset(description, asset, profiles) {
  const source = fileSkeleton(description);
  if (!source) return null;
  const clipBones = [...new Set((description?.clips ?? []).flatMap((clip) => clip.bones ?? []))];
  let best = null;
  for (const revision of modelRevisions(asset)) {
    const target = revisionSkeleton(revision, profiles);
    if (!target?.joints?.length) continue;
    const result = classify(source, target, profiles, { clipBones: clipBones.length ? clipBones : null });
    const entry = { ...result, targetRevision: revision.revision_id, targetState: revision.canonical_state, targetSkeletonSource: target.source };
    const better = !best || RANK[entry.status] > RANK[best.status]
      || (RANK[entry.status] === RANK[best.status] && entry.targetState === 'canonical' && best.targetState !== 'canonical');
    if (better) best = entry;
  }
  return best;
}

// Which asset a file most likely belongs to: the preferred asset when given, otherwise the asset whose model skeleton
// classifies best (same-rig matches first). Returns null when nothing matches; a new asset ID is then needed.
export function suggestParent(description, manifest, profiles, preferredAssetId = null) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  if (preferredAssetId) {
    const asset = assets.find((candidate) => candidate?.asset_id === preferredAssetId);
    return asset ? { assetId: asset.asset_id, classification: classifyAgainstAsset(description, asset, profiles), reason: 'Selected asset' } : null;
  }
  if (!fileSkeleton(description)) return null;
  let best = null;
  for (const asset of assets) {
    const classification = classifyAgainstAsset(description, asset, profiles);
    if (!classification || RANK[classification.status] < RANK.requires_retarget) continue;
    const sameNaming = classification.sourceNaming && classification.sourceNaming === classification.targetNaming;
    const score = RANK[classification.status] * 10 + (sameNaming ? 5 : 0) + (asset.canonical_revision ? 1 : 0);
    if (!best || score > best.score) best = { assetId: asset.asset_id, classification, score, reason: sameNaming ? 'Same rig naming' : 'Retargetable humanoid' };
  }
  if (!best) return null;
  // A cross-naming match (e.g. a Mixamo clip that fits every humanoid) is only a suggestion when it is unique.
  return best;
}

// The component a file should become, given its content and (optional) parent asset.
export function suggestComponent(fileName, description, parentAsset, classification) {
  const extension = extensionOf(fileName);
  const clips = description?.clips?.length ?? 0;
  const skeleton = Boolean(fileSkeleton(description));
  const pivots = (description?.nodes ?? []).filter((node) => node.role).length;
  if (IMAGE.has(extension)) {
    return parentAsset && hasGlbModel(parentAsset)
      ? { component: 'materials', reason: 'An image for an asset with a 3D model is a material or texture set.' }
      : { component: 'model', reason: 'A 2D asset image.' };
  }
  if (extension === 'fbx') {
    return clips
      ? { component: 'source_clip', reason: `An FBX with ${clips} animation clip${clips === 1 ? '' : 's'} is a source clip to bake.` }
      : { component: 'model', reason: 'An FBX without clips is an editable model source.' };
  }
  if (extension !== 'glb') return { component: 'model', reason: 'Other files are recorded as model files.' };
  if (skeleton && clips) {
    const usable = parentAsset && classification && ['compatible', 'requires_retarget'].includes(classification.status);
    return usable
      ? { component: 'animation_collection', reason: `${clips} clip${clips === 1 ? '' : 's'} for ${parentAsset.display_name ?? parentAsset.asset_id}'s rig: an animation collection, not a competing model.` }
      : { component: 'model', reason: parentAsset ? 'The clips do not fit this asset\'s rig, so this is a separate model.' : 'A rigged model with clips for a new asset.' };
  }
  if (!skeleton && pivots && parentAsset && hasGlbModel(parentAsset)) {
    return { component: 'mechanical', reason: 'A rigid model with named pivots for an existing asset.' };
  }
  return { component: 'model', reason: skeleton ? 'A rigged model without clips.' : pivots ? 'A rigid model with named pivots.' : 'A static model.' };
}

// Manifest file hashes, so Cloud Library files already recorded in the manifest are not offered as unassigned.
export function manifestHashes(manifest) {
  const hashes = new Map();
  for (const asset of manifest?.assets ?? []) {
    for (const revision of asset?.revisions ?? []) {
      for (const file of revision?.files ?? []) {
        if (typeof file?.sha256 === 'string') hashes.set(file.sha256.toLowerCase(), { assetId: asset.asset_id, revisionId: revision.revision_id, path: file.path });
      }
    }
  }
  return hashes;
}

// Gameplay slots for an asset's category from the private profiles (operators -> slots.operator).
export function slotsFor(profiles, category) {
  const key = { operators: 'operator' }[category];
  const slots = key ? profiles?.slots?.[key] : null;
  return slots && typeof slots === 'object' ? Object.entries(slots).map(([slot, policy]) => ({
    slot, loop: policy?.loop === true, rootMotion: policy?.root_motion ?? 'in_place'
  })) : [];
}

// Clips that can fill slots: every clip of the asset's animation collections, baked ones first.
export function bindableClips(asset) {
  const out = [];
  for (const revision of asset?.revisions ?? []) {
    if (componentOf(revision) !== 'animation_collection') continue;
    const derived = revision.animation?.derived;
    const failed = new Set((derived?.clips ?? []).filter((clip) => !['pass', 'warning'].includes(clip?.status)).map((clip) => clip.output));
    for (const clip of revision.animation?.clips ?? []) {
      if (!clip?.name || failed.has(clip.name)) continue;
      out.push({ revisionId: revision.revision_id, clip: clip.name, state: revision.canonical_state, baked: Boolean(derived),
        targetRevision: derived?.target?.revision_id ?? null, durationS: clip.duration_s ?? null });
    }
  }
  return out.sort((a, b) => Number(b.baked) - Number(a.baked) || String(a.clip).localeCompare(String(b.clip)));
}
