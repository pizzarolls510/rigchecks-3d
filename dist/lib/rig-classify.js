// RigCheck — generic skeleton classification against rig profiles supplied at runtime (the INVASION profiles are
// private and arrive from the Asset Library API; nothing project-specific is defined here). Answers whether a file's
// clips can play on a target skeleton as-is (compatible), need a bake (requires_retarget), cannot be used
// (incompatible) or come from an unrecognised rig (unknown). Compatibility is never inferred from bone counts.
// Mirrors tools/animation/profiles.py in the private pipeline, which is authoritative on the server.
import { qMul, qRotate } from './animation-inspect.js';

export const STATUSES = ['compatible', 'requires_retarget', 'incompatible', 'unknown', 'not_applicable'];
export const CORE = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'];
const REST_ROTATION_TOLERANCE_DEG = 1;
const REST_OFFSET_TOLERANCE = 0.01;

const STATUS_LABELS = {
  compatible: 'Compatible',
  requires_retarget: 'Requires retarget',
  incompatible: 'Incompatible',
  unknown: 'Unknown rig',
  not_applicable: 'No skeleton'
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? STATUS_LABELS.unknown;
}

function stripPrefix(name, naming) {
  return naming?.prefix_pattern && name ? name.replace(new RegExp(naming.prefix_pattern), '') : name;
}

export function canonicalMap(names, naming) {
  const stripped = new Map();
  for (const name of names) if (name) stripped.set(stripPrefix(name, naming), name);
  const out = {};
  for (const [canonical, bone] of Object.entries(naming?.bones ?? {})) if (stripped.has(bone)) out[canonical] = stripped.get(bone);
  return out;
}

export function identify(skeleton, profiles) {
  const names = (skeleton?.joints ?? []).map((j) => j.name);
  let best = { naming: null, family: null, coverage: 0 };
  let bestKey = [0, 0];
  for (const [id, naming] of Object.entries(profiles?.namings ?? {})) {
    const required = naming.required?.length ? naming.required : Object.keys(naming.bones ?? {});
    if (!required.length) continue;
    const found = canonicalMap(names, naming);
    const coverage = required.filter((c) => c in found).length / required.length;
    const key = [coverage, Object.keys(found).length];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = { naming: id, family: naming.family ?? null, coverage };
      bestKey = key;
    }
  }
  return best.coverage < 0.85 ? { naming: null, family: null, coverage: best.coverage } : best;
}

function pairs(skeleton) {
  return new Set((skeleton?.joints ?? []).map((j) => `${j.name}\u0000${j.parent ?? ''}`));
}

export function matchRig(skeleton, profiles, namingId) {
  const own = pairs(skeleton);
  for (const [id, rig] of Object.entries(profiles?.rigs ?? {})) {
    const reference = rig?.reference;
    if (rig.naming !== namingId || !reference?.joints) continue;
    const theirs = pairs(reference);
    if (theirs.size === own.size && [...own].every((pair) => theirs.has(pair))) return id;
  }
  return null;
}

export function worldPositions(skeleton) {
  const byName = new Map((skeleton?.joints ?? []).map((j) => [j.name, j]));
  const base = skeleton?.rootTransform ?? skeleton?.root_transform ?? null;
  const cache = new Map();
  const world = (name, depth = 0) => {
    if (cache.has(name)) return cache.get(name);
    if (depth > 512) throw new Error('cyclic joint hierarchy');
    const joint = byName.get(name);
    const [pPos, pRot] = byName.has(joint.parent) ? world(joint.parent, depth + 1) : [base?.translation ?? [0, 0, 0], base?.rotation ?? [0, 0, 0, 1]];
    const moved = qRotate(pRot, joint.translation ?? [0, 0, 0]);
    const result = [pPos.map((value, i) => value + moved[i]), qMul(pRot, joint.rotation ?? [0, 0, 0, 1])];
    cache.set(name, result);
    return result;
  };
  return Object.fromEntries([...byName.keys()].map((name) => [name, world(name)[0]]));
}

const hasRest = (skeleton) => (skeleton?.joints ?? []).length > 0 && skeleton.joints.every((j) => Array.isArray(j.rotation) && Array.isArray(j.translation));

function sideIssue(skeleton, naming) {
  if (!hasRest(skeleton)) return null;
  const found = canonicalMap(skeleton.joints.map((j) => j.name), naming);
  if (!found.LeftHand || !found.RightHand) return null;
  const positions = worldPositions(skeleton);
  return positions[found.LeftHand][0] < positions[found.RightHand][0]
    ? "Left/Right bone labels are swapped (the Left hand sits on the character's right). Fix the rig's naming first." : null;
}

function hipsHeight(skeleton, naming) {
  if (!hasRest(skeleton)) return null;
  const found = canonicalMap(skeleton.joints.map((j) => j.name), naming);
  return found.Hips ? Math.abs(worldPositions(skeleton)[found.Hips][1]) || null : null;
}

function angleDeg(a, b) {
  const dot = Math.min(1, Math.abs(a.reduce((sum, value, i) => sum + value * b[i], 0)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

export function restDifferences(source, target) {
  const src = new Map(source.joints.map((j) => [j.name, j]));
  const out = { maxRotationDeg: 0, rotationJoint: null, maxOffset: 0, offsetJoint: null };
  for (const joint of target.joints) {
    const other = src.get(joint.name);
    if (!other?.rotation || !joint.rotation) continue;
    const angle = angleDeg(other.rotation, joint.rotation);
    const offset = Math.hypot(...(other.translation ?? [0, 0, 0]).map((v, i) => v - (joint.translation ?? [0, 0, 0])[i]));
    if (angle > out.maxRotationDeg) Object.assign(out, { maxRotationDeg: angle, rotationJoint: joint.name });
    if (offset > out.maxOffset) Object.assign(out, { maxOffset: offset, offsetJoint: joint.name });
  }
  return out;
}

export function classify(source, target, profiles, { clipBones = null } = {}) {
  const result = { status: 'unknown', sourceNaming: null, targetNaming: null, sourceRig: null, targetRig: null, family: null,
    mappedBones: 0, missingRequired: [], droppedTracks: [], rest: null, reasons: [] };
  if (!source?.joints?.length) return { ...result, status: 'not_applicable', reasons: ['The file has no skeleton.'] };
  if (!target?.joints?.length) return { ...result, reasons: ['The target has no skeleton.'] };
  if (!profiles?.namings) return { ...result, reasons: ['Rig profiles are not available, so rigs cannot be compared.'] };
  const s = identify(source, profiles);
  const t = identify(target, profiles);
  Object.assign(result, { sourceNaming: s.naming, targetNaming: t.naming,
    sourceRig: s.naming ? matchRig(source, profiles, s.naming) : null, targetRig: t.naming ? matchRig(target, profiles, t.naming) : null });
  if (!s.naming) return { ...result, reasons: [`The source skeleton matches no registered rig naming (best coverage ${Math.round(s.coverage * 100)}%).`] };
  if (!t.naming) return { ...result, reasons: [`The target skeleton matches no registered rig naming (best coverage ${Math.round(t.coverage * 100)}%).`] };
  result.family = s.family;
  if (s.family !== t.family) return { ...result, status: 'incompatible', reasons: [`Different rig families: ${s.family} source, ${t.family} target.`] };
  const sDef = profiles.namings[s.naming];
  const tDef = profiles.namings[t.naming];
  for (const [skeleton, def, label] of [[source, sDef, 'Source'], [target, tDef, 'Target']]) {
    const issue = sideIssue(skeleton, def);
    if (issue) return { ...result, status: 'incompatible', reasons: [`${label}: ${issue}`] };
  }
  const sMap = canonicalMap(source.joints.map((j) => j.name), sDef);
  const tMap = canonicalMap(target.joints.map((j) => j.name), tDef);
  const required = (tDef.required?.length ? tDef.required : Object.keys(tDef.bones)).filter((c) => c in tDef.bones);
  const missingTarget = required.filter((c) => !(c in tMap));
  const missingSource = required.filter((c) => !(c in sMap));
  const shared = Object.keys(sMap).filter((c) => c in tMap);
  result.mappedBones = shared.length;
  const reverse = Object.fromEntries(Object.entries(sMap).map(([c, name]) => [name, c]));
  const animated = clipBones ?? source.joints.map((j) => j.name);
  result.droppedTracks = animated.filter((name) => !(reverse[name] in tMap)).sort();
  if (missingTarget.length) return { ...result, status: 'incompatible', missingRequired: missingTarget, reasons: [`The target lacks required ${t.family} bones: ${missingTarget.join(', ')}.`] };
  if (missingSource.length) return { ...result, status: 'incompatible', missingRequired: missingSource, reasons: [`The source cannot drive required bones: ${missingSource.join(', ')}.`] };
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  if (s.family !== 'humanoid') {
    const same = s.naming === t.naming && sameSet(pairs(source), pairs(target));
    const rest = same && hasRest(source) && hasRest(target) ? restDifferences(source, target) : null;
    return same && rest && rest.maxRotationDeg <= REST_ROTATION_TOLERANCE_DEG
      ? { ...result, rest, status: 'compatible', reasons: ['Identical creature rig: clips can play unchanged.'] }
      : { ...result, rest, status: 'incompatible', reasons: [`${s.family[0].toUpperCase()}${s.family.slice(1)} retargeting is not supported; only an identical rig can share clips.`] };
  }
  const sp = new Map(source.joints.map((j) => [j.name, j.parent]));
  const tp = new Map(target.joints.map((j) => [j.name, j.parent]));
  const sameNames = s.naming === t.naming && shared.every((c) => sMap[c] === tMap[c]) && shared.every((c) => sp.get(sMap[c]) === tp.get(tMap[c]));
  if (sameNames && hasRest(source) && hasRest(target)) {
    const rest = restDifferences(source, target);
    result.rest = rest;
    const height = hipsHeight(target, tDef) || 1;
    const rotationOk = rest.maxRotationDeg <= REST_ROTATION_TOLERANCE_DEG;
    const offsetOk = rest.maxOffset <= REST_OFFSET_TOLERANCE * height;
    if (rotationOk && offsetOk && !result.droppedTracks.length) {
      return { ...result, status: 'compatible', reasons: ['Same bone names, hierarchy and rest pose: clips can play unchanged.'] };
    }
    const reasons = [];
    if (!rotationOk) reasons.push(`Rest rotations differ by up to ${rest.maxRotationDeg.toFixed(1)}° (${rest.rotationJoint}).`);
    if (!offsetOk) reasons.push(`Joint positions differ by up to ${Math.round((rest.maxOffset * 1000) / height)} mm per metre of hips height (${rest.offsetJoint}).`);
    if (result.droppedTracks.length) reasons.push(`${result.droppedTracks.length} animated bone(s) have no counterpart on the target and would be dropped.`);
    reasons.push('Bake the clips onto the target (identity mapping).');
    return { ...result, status: 'requires_retarget', reasons };
  }
  const reasons = [`Maps ${shared.length} bones from the ${sDef.label ?? s.naming} naming onto the ${tDef.label ?? t.naming} naming.`];
  if (!hasRest(source)) reasons.push('The source rest pose is not declared in the file; the bake resolves it in Blender.');
  if (result.droppedTracks.length) reasons.push(`${result.droppedTracks.length} animated bone(s) have no counterpart on the target and would be dropped.`);
  return { ...result, status: 'requires_retarget', reasons };
}

// ---------------------------------------------------------------------------------- manifest model skeletons

function expandCompact(skeleton) {
  return {
    name: skeleton?.name ?? null,
    rootTransform: skeleton?.root_transform ?? null,
    joints: (skeleton?.joints ?? []).map((entry) => (Array.isArray(entry)
      ? { name: entry[0], parent: entry[1], ...(entry.length >= 4 ? { rotation: entry[2], translation: entry[3] } : {}) }
      : entry))
  };
}

// The skeleton of a manifest model revision: its recorded animation.skeleton (new revisions), else the reference rest
// pose of the registered rig whose joint names equal the revision's recorded bone list (revisions recorded earlier).
export function revisionSkeleton(revision, profiles) {
  const recorded = revision?.animation?.skeleton;
  if (recorded?.joints?.length) return { ...expandCompact(recorded), source: 'recorded' };
  const bones = revision?.model?.skeletons?.[0]?.bones;
  if (!Array.isArray(bones) || !bones.length) return null;
  const names = new Set(bones);
  for (const [id, rig] of Object.entries(profiles?.rigs ?? {})) {
    const joints = rig?.reference?.joints;
    if (joints && joints.length === names.size && joints.every((j) => names.has(j.name))) {
      return { name: revision.model.skeletons[0].name ?? null, rootTransform: rig.reference.root_transform ?? null,
        joints: joints.map((j) => ({ ...j })), source: 'profile_reference', rig: id };
    }
  }
  return { name: revision.model.skeletons[0].name ?? null, joints: bones.map((name) => ({ name, parent: null })), source: 'names_only' };
}

// A client-side description (animation-inspect.js) as a classifier skeleton.
export function fileSkeleton(description) {
  const skeleton = description?.skeletons?.[0];
  return skeleton ? { name: skeleton.name, rootTransform: skeleton.rootTransform ?? null, joints: skeleton.joints } : null;
}
