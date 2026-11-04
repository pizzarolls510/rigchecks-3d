// Client-side GLB/FBX reading, rig classification and add-file suggestions. Synthetic rigs and profiles only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { InspectError, describeFbx, describeGltf, inspectBuffer, readGlbJson } from '../dist/lib/animation-inspect.js';
import { classify, fileSkeleton, revisionSkeleton } from '../dist/lib/rig-classify.js';
import { aliasedAsset, bindableClips, manifestHashes, slotsFor, suggestComponent, suggestParent } from '../dist/lib/asset-components.js';

const FBX = readFileSync(new URL('./fixtures/mixamo-style-walk.fbx', import.meta.url));

// A synthetic humanoid: canonical key -> [bone name, parent canonical, translation].
const LAYOUT = [
  ['Hips', null, [0, 1, 0]], ['Spine', 'Hips', [0, 0.1, 0]], ['Chest', 'Spine', [0, 0.1, 0]], ['UpperChest', 'Chest', [0, 0.1, 0]],
  ['Neck', 'UpperChest', [0, 0.1, 0]], ['Head', 'Neck', [0, 0.1, 0]],
  ...['Left', 'Right'].flatMap((side) => {
    const x = side === 'Left' ? 1 : -1;
    return [[`${side}Shoulder`, 'UpperChest', [0.05 * x, 0.08, 0]], [`${side}UpperArm`, `${side}Shoulder`, [0.1 * x, 0, 0]],
      [`${side}LowerArm`, `${side}UpperArm`, [0.25 * x, 0, 0]], [`${side}Hand`, `${side}LowerArm`, [0.25 * x, 0, 0]],
      [`${side}UpperLeg`, 'Hips', [0.1 * x, -0.05, 0]], [`${side}LowerLeg`, `${side}UpperLeg`, [0, -0.45, 0]],
      [`${side}Foot`, `${side}LowerLeg`, [0, -0.45, 0]], [`${side}Toes`, `${side}Foot`, [0, -0.05, 0.1]]];
  })
];
const SIDE = { Left: 'L', Right: 'R' };
const GENERIC = Object.fromEntries(LAYOUT.map(([c]) => [c, c.replace(/^(Left|Right)(.*)$/, (_m, side, part) => `${part.toLowerCase()}.${SIDE[side]}`).replace(/^[A-Z]/, (ch) => ch.toLowerCase())]));
const MIXAMO = { Hips: 'Hips', Spine: 'Spine', Chest: 'Spine1', UpperChest: 'Spine2', Neck: 'Neck', Head: 'Head',
  ...Object.fromEntries(['Left', 'Right'].flatMap((s) => [[`${s}Shoulder`, `${s}Shoulder`], [`${s}UpperArm`, `${s}Arm`], [`${s}LowerArm`, `${s}ForeArm`],
    [`${s}Hand`, `${s}Hand`], [`${s}UpperLeg`, `${s}UpLeg`], [`${s}LowerLeg`, `${s}Leg`], [`${s}Foot`, `${s}Foot`], [`${s}Toes`, `${s}ToeBase`]])) };
const CORE = LAYOUT.map(([c]) => c);
const PROFILES = {
  profiles_version: 1,
  namings: {
    generic: { label: 'Generic', family: 'humanoid', bones: GENERIC, required: CORE },
    mixamo: { label: 'Mixamo', family: 'humanoid', bones: MIXAMO, required: CORE, prefix_pattern: '^mixamorig[0-9]*:' },
    bug: { label: 'Bug', family: 'insectoid', bones: { body: 'body', leg: 'leg' }, required: ['body', 'leg'] }
  },
  rigs: {},
  slots: { operator: { idle: { loop: true }, walk: { loop: true }, fall: { loop: false, root_motion: 'keep' } } }
};

function skeleton(names = GENERIC, { rotate = null } = {}) {
  return { joints: LAYOUT.map(([c, parent, translation]) => ({ name: names[c], parent: parent ? names[parent] : null,
    rotation: rotate && c === 'LeftUpperArm' ? rotate : [0, 0, 0, 1], translation })) };
}

function glb(doc) {
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const bytes = Buffer.concat([header, padded]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

function riggedDoc({ names = GENERIC, clips = ['Walk'] } = {}) {
  const nodes = [{ name: 'Armature', children: [1] }];
  const index = {};
  for (const [c] of LAYOUT) index[c] = nodes.push({ name: names[c], translation: LAYOUT.find(([k]) => k === c)[2] }) - 1;
  for (const [c, parent] of LAYOUT) if (parent) (nodes[index[parent]].children ??= []).push(index[c]);
  nodes.push({ name: 'Body', mesh: 0, skin: 0 });
  return { asset: { version: '2.0' }, nodes, meshes: [{ primitives: [] }], skins: [{ joints: CORE.map((c) => index[c]) }],
    accessors: [{ count: 31, max: [1.0] }],
    animations: clips.map((name) => ({ name, samplers: [{ input: 0, output: 0 }], channels: [{ sampler: 0, target: { node: index.Hips, path: 'translation' } }] })) };
}

test('GLB declarations: joints, parents, rest, clips and container transform', () => {
  const description = inspectBuffer('rig.glb', glb(riggedDoc()));
  const s = description.skeletons[0];
  assert.equal(s.jointCount, 22);
  assert.equal(s.container, 'Armature');
  assert.deepEqual(s.roots, ['hips']);
  assert.equal(s.joints.find((j) => j.name === 'lowerleg.L').parent, 'upperleg.L');
  assert.deepEqual(description.clips[0], { index: 0, name: 'Walk', durationS: 1, channels: 1, bones: ['hips'], rootTranslation: ['hips'] });
  assert.equal(description.mesh.skinnedMeshNodes, 1);
  assert.throws(() => readGlbJson(new ArrayBuffer(8)), InspectError);
});

test('binary FBX declarations: Mixamo-style bones, hierarchy and the animation stack', () => {
  const buffer = FBX.buffer.slice(FBX.byteOffset, FBX.byteOffset + FBX.length);
  const description = describeFbx(buffer);
  assert.equal(description.skeletons[0].jointCount, 22);
  assert.deepEqual(description.skeletons[0].roots, ['mixamorig:Hips']);
  assert.equal(description.skeletons[0].joints.find((j) => j.name === 'mixamorig:LeftLeg').parent, 'mixamorig:LeftUpLeg');
  assert.equal(description.clips.length, 1);
  assert.equal(description.clips[0].durationS, 1);
  assert.equal(description.fps, 30);
  const ascii = new TextEncoder().encode('; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n}');
  assert.throws(() => describeFbx(ascii.buffer), /ASCII FBX/);
});

test('classification never infers compatibility from bone counts', () => {
  const target = skeleton();
  assert.equal(classify(skeleton(), target, PROFILES).status, 'compatible');
  const rotated = classify(skeleton(GENERIC, { rotate: [0, 0, 0.3826834, 0.9238795] }), target, PROFILES);
  assert.equal(rotated.status, 'requires_retarget');
  assert.match(rotated.reasons[0], /Rest rotations differ by up to 45\.0°/);
  const fbx = describeFbx(FBX.buffer.slice(FBX.byteOffset, FBX.byteOffset + FBX.length));
  const mixamo = classify(fileSkeleton(fbx), target, PROFILES);
  assert.deepEqual([mixamo.status, mixamo.sourceNaming, mixamo.mappedBones], ['requires_retarget', 'mixamo', 22]);
  const swapped = skeleton(Object.fromEntries(Object.entries(GENERIC).map(([c, n]) => [c.replace(/^Left/, 'Tmp').replace(/^Right/, 'Left').replace(/^Tmp/, 'Right'), n])));
  assert.equal(classify(swapped, target, PROFILES).status, 'incompatible');
  const unknown = { joints: [{ name: 'a', parent: null }, { name: 'b', parent: 'a' }] };
  assert.equal(classify(unknown, target, PROFILES).status, 'unknown');
  const bug = { joints: [{ name: 'body', parent: null }, { name: 'leg', parent: 'body' }] };
  assert.equal(classify(bug, target, PROFILES).status, 'incompatible');
  const noToes = { joints: skeleton().joints.filter((j) => !j.name.startsWith('toes')) };
  assert.deepEqual(classify(noToes, target, PROFILES).missingRequired, ['LeftToes', 'RightToes']);
  assert.equal(classify({ joints: [] }, target, PROFILES).status, 'not_applicable');
});

test('manifest model skeletons come from recorded data or a matching profile reference', () => {
  const compact = { animation: { skeleton: { joints: [['hips', null, [0, 0, 0, 1], [0, 1, 0]], ['spine', 'hips', [0, 0, 0, 1], [0, 0.1, 0]]] } } };
  assert.deepEqual(revisionSkeleton(compact, PROFILES).joints[1], { name: 'spine', parent: 'hips', rotation: [0, 0, 0, 1], translation: [0, 0.1, 0] });
  const profiles = { ...PROFILES, rigs: { generic_22: { naming: 'generic', reference: skeleton() } } };
  const legacy = { model: { skeletons: [{ name: 'Rig', bones: CORE.map((c) => GENERIC[c]) }] } };
  const resolved = revisionSkeleton(legacy, profiles);
  assert.equal(resolved.source, 'profile_reference');
  assert.equal(resolved.rig, 'generic_22');
  assert.equal(classify(skeleton(), resolved, profiles).status, 'compatible');
});

test('add-file suggestions keep clip collections from competing with the model', () => {
  const model = { revision_id: 'r_model', canonical_state: 'canonical', files: [{ path: 'assets/x/model.glb', sha256: 'a'.repeat(64) }],
    animation: { skeleton: { joints: skeleton().joints.map((j) => [j.name, j.parent, j.rotation, j.translation]) } } };
  const collection = { revision_id: 'r_clips', component: 'animation_collection', canonical_state: 'candidate', files: [],
    animation: { clips: [{ name: 'Walk' }, { name: 'Bad' }], derived: { target: { revision_id: 'r_model' }, clips: [{ output: 'Walk', status: 'pass' }, { output: 'Bad', status: 'fail' }] } } };
  const manifest = { assets: [{ asset_id: 'hero', display_name: 'Hero', category: 'operators', canonical_revision: 'r_model', revisions: [model, collection] },
    { asset_id: 'tower', category: 'structures', revisions: [{ revision_id: 'r_t', files: [{ path: 'assets/t/t.glb', sha256: 'b'.repeat(64) }] }] }] };
  const description = inspectBuffer('walks.glb', glb(riggedDoc({ clips: ['Walk', 'Run'] })));
  const parent = suggestParent(description, manifest, PROFILES);
  assert.equal(parent.assetId, 'hero');
  assert.equal(parent.classification.status, 'compatible');
  assert.equal(suggestComponent('walks.glb', description, manifest.assets[0], parent.classification).component, 'animation_collection');
  assert.equal(suggestComponent('walks.glb', description, null, null).component, 'model');
  const fbx = describeFbx(FBX.buffer.slice(FBX.byteOffset, FBX.byteOffset + FBX.length));
  assert.equal(suggestComponent('Walking.fbx', fbx, manifest.assets[0], null).component, 'source_clip');
  assert.equal(suggestComponent('albedo.png', { clips: [] }, manifest.assets[0], null).component, 'materials');
  const turret = describeGltf({ nodes: [{ name: 'Root', children: [1] }, { name: 'YawPivot', children: [2] }, { name: 'PitchPivot', mesh: 0 }], meshes: [{}] });
  assert.equal(suggestComponent('turret.glb', turret, manifest.assets[1], null).component, 'mechanical');
  assert.equal(suggestParent({ skeletons: [{ joints: [{ name: 'q', parent: null }] }], clips: [] }, manifest, PROFILES), null);
  assert.deepEqual(manifestHashes(manifest).get('a'.repeat(64)), { assetId: 'hero', revisionId: 'r_model', path: 'assets/x/model.glb' });
  assert.deepEqual(slotsFor(PROFILES, 'operators').map((s) => [s.slot, s.loop]), [['idle', true], ['walk', true], ['fall', false]]);
  assert.deepEqual(slotsFor(PROFILES, 'structures'), []);
  assert.deepEqual(bindableClips(manifest.assets[0]).map((c) => c.clip), ['Walk']);
});

test('a file named after a declared alias is suggested for that asset, never as a new one', () => {
  const manifest = { assets: [{ asset_id: 'sample_suit', identity: { aliases: ['working_name'] } }, { asset_id: 'other', identity: null }] };
  assert.equal(aliasedAsset('working_name', manifest), 'sample_suit');
  assert.equal(aliasedAsset('working_name_walks_v2', manifest), 'sample_suit');
  assert.equal(aliasedAsset('working_named', manifest), null, 'only whole name parts match');
  assert.equal(aliasedAsset('sample_suit', manifest), null, 'asset IDs themselves are matched elsewhere');
  assert.equal(aliasedAsset('anything', { assets: [] }), null);
});
