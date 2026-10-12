// RigCheck — client-side declaration reader for GLB and binary FBX files (skeleton, clips, rigid pivots).
// Generic glTF/FBX parsing only: no project data, no network. Used to classify files before anything is uploaded;
// the authoritative pipeline re-reads every file on the server. Mirrors the private pipeline's readers.

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const FBX_MAGIC = 'Kaydara FBX Binary  \u0000';
const KTIME_PER_SECOND = 46186158000;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const FBX_TIME_MODES = { 1: 120, 2: 100, 3: 60, 4: 50, 5: 48, 6: 30, 7: 30, 8: 29.97, 9: 29.97, 10: 25, 11: 24, 12: 1000, 13: 23.976, 15: 96, 16: 72, 17: 59.94, 18: 119.88 };

export class InspectError extends Error {}

const PIVOT_ROLES = [
  ['muzzle', ['muzzle', 'barrel_tip', 'firepoint', 'fire_point']],
  ['pitch', ['pitch', 'elevation', 'tilt']],
  ['yaw', ['yaw', 'swivel', 'traverse', 'azimuth']],
  ['base', ['base', 'mount', 'pedestal']]
];

export function pivotRole(name) {
  const lowered = String(name ?? '').toLowerCase();
  for (const [role, keys] of PIVOT_ROLES) if (keys.some((key) => lowered.includes(key))) return role;
  return null;
}

export function readGlbJson(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new InspectError('Not a GLB 2.0 file.');
  }
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || length > MAX_JSON_BYTES || 20 + length > buffer.byteLength) {
    throw new InspectError('The GLB has no readable JSON chunk.');
  }
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)).replace(/[\u0000 ]+$/, ''));
  } catch {
    throw new InspectError('The GLB JSON chunk is not valid JSON.');
  }
}

function round(values, digits = 5) {
  const factor = 10 ** digits;
  return values.map((value) => Math.round(Number(value) * factor) / factor);
}

function restOf(node) {
  if (Array.isArray(node?.matrix)) {
    const m = node.matrix;
    const sx = Math.hypot(m[0], m[1], m[2]) || 1;
    const sy = Math.hypot(m[4], m[5], m[6]) || 1;
    const sz = Math.hypot(m[8], m[9], m[10]) || 1;
    return { translation: [m[12], m[13], m[14]], rotation: matrixToQuaternion([[m[0] / sx, m[4] / sy, m[8] / sz], [m[1] / sx, m[5] / sy, m[9] / sz], [m[2] / sx, m[6] / sy, m[10] / sz]]) };
  }
  return { translation: node?.translation ?? [0, 0, 0], rotation: node?.rotation ?? [0, 0, 0, 1] };
}

function matrixToQuaternion(r) {
  const trace = r[0][0] + r[1][1] + r[2][2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, 0.25 * s];
  }
  if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = Math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2;
    return [0.25 * s, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s];
  }
  if (r[1][1] > r[2][2]) {
    const s = Math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2;
    return [(r[0][1] + r[1][0]) / s, 0.25 * s, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s];
  }
  const s = Math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2;
  return [(r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, 0.25 * s, (r[1][0] - r[0][1]) / s];
}

export function qMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export function qRotate(q, v) {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}

export function describeGltf(doc) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const parent = new Map();
  nodes.forEach((node, index) => (node?.children ?? []).forEach((child) => parent.set(child, index)));
  const skeletons = (doc?.skins ?? []).map((skin, skinIndex) => {
    const indexes = (skin?.joints ?? []).filter((j) => Number.isInteger(j) && j >= 0 && j < nodes.length);
    const set = new Set(indexes);
    const joints = indexes.map((index) => {
      const p = parent.get(index);
      const rest = restOf(nodes[index]);
      return { name: nodes[index]?.name ?? null, parent: set.has(p) ? nodes[p]?.name ?? null : null,
        rotation: round(rest.rotation), translation: round(rest.translation) };
    });
    let ancestor = indexes.length ? parent.get(indexes[0]) : undefined;
    while (ancestor !== undefined && set.has(ancestor)) ancestor = parent.get(ancestor);
    const container = ancestor !== undefined ? nodes[ancestor]?.name ?? null : null;
    let position = [0, 0, 0];
    let rotation = [0, 0, 0, 1];
    const chain = [];
    for (let a = ancestor; a !== undefined; a = parent.get(a)) chain.push(a);
    for (const index of chain.reverse()) {
      const rest = restOf(nodes[index]);
      const moved = qRotate(rotation, rest.translation);
      position = position.map((value, i) => value + moved[i]);
      rotation = qMul(rotation, rest.rotation);
    }
    return { index: skinIndex, name: skin?.name ?? null, container, jointCount: joints.length,
      roots: joints.filter((j) => j.parent === null).map((j) => j.name), joints,
      rootTransform: { translation: round(position), rotation: round(rotation) } };
  });
  const jointNames = new Set(skeletons.flatMap((s) => s.joints.map((j) => j.name)));
  const accessors = Array.isArray(doc?.accessors) ? doc.accessors : [];
  const clips = (doc?.animations ?? []).map((animation, index) => {
    let duration = 0;
    for (const sampler of animation?.samplers ?? []) {
      const max = accessors[sampler?.input]?.max;
      if (Array.isArray(max) && Number.isFinite(max[0])) duration = Math.max(duration, max[0]);
    }
    const bones = new Set();
    const translation = new Set();
    for (const channel of animation?.channels ?? []) {
      const name = nodes[channel?.target?.node]?.name;
      if (jointNames.has(name)) bones.add(name);
      if (channel?.target?.path === 'translation' && name) translation.add(name);
    }
    return { index, name: animation?.name ?? null, durationS: Math.round(duration * 10000) / 10000,
      channels: (animation?.channels ?? []).length, bones: [...bones].sort(), rootTranslation: [...translation].sort() };
  });
  const meshNodes = nodes.filter((node) => node && 'mesh' in node);
  const rigid = doc?.skins?.length ? null : nodes.map((node, index) => {
    const rest = restOf(node);
    return { name: node?.name ?? null, parent: parent.has(index) ? nodes[parent.get(index)]?.name ?? null : null,
      hasMesh: 'mesh' in (node ?? {}), role: pivotRole(node?.name), translation: round(rest.translation), rotation: round(rest.rotation) };
  });
  return { format: 'glb', skeletons, clips, mesh: { meshNodes: meshNodes.length, skinnedMeshNodes: meshNodes.filter((n) => 'skin' in n).length },
    nodes: rigid, extensionsUsed: doc?.extensionsUsed ?? [] };
}

// ------------------------------------------------------------------------------------------------ binary FBX

function fbxTree(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 21));
  if (magic !== FBX_MAGIC) {
    const head = new TextDecoder().decode(bytes.subarray(0, 2048));
    if (/^\s*;|FBXHeaderExtension/.test(head)) throw new InspectError('ASCII FBX is not supported; export binary FBX (Mixamo and Blender do by default).');
    throw new InspectError('Not a binary FBX file.');
  }
  const view = new DataView(buffer);
  const version = view.getUint32(23, true);
  const wide = version >= 7500;
  const utf8 = new TextDecoder();
  let count = 0;

  function prop(offset) {
    const kind = String.fromCharCode(bytes[offset]);
    offset += 1;
    switch (kind) {
      case 'Y': return [view.getInt16(offset, true), offset + 2];
      case 'C': return [bytes[offset] !== 0, offset + 1];
      case 'I': return [view.getInt32(offset, true), offset + 4];
      case 'F': return [view.getFloat32(offset, true), offset + 4];
      case 'D': return [view.getFloat64(offset, true), offset + 8];
      case 'L': return [view.getBigInt64(offset, true), offset + 8];
      case 'f': case 'd': case 'l': case 'i': case 'b':
        return [null, offset + 12 + view.getUint32(offset + 8, true)];
      case 'S': case 'R': {
        const length = view.getUint32(offset, true);
        return [kind === 'S' ? utf8.decode(bytes.subarray(offset + 4, offset + 4 + length)) : null, offset + 4 + length];
      }
      default: throw new InspectError(`Unknown FBX property type ${JSON.stringify(kind)}.`);
    }
  }

  function node(offset) {
    let end;
    let props;
    if (wide) {
      end = Number(view.getBigUint64(offset, true));
      props = Number(view.getBigUint64(offset + 8, true));
      offset += 24;
    } else {
      end = view.getUint32(offset, true);
      props = view.getUint32(offset + 4, true);
      offset += 12;
    }
    const nameLength = bytes[offset];
    offset += 1;
    if (end === 0) return [null, offset + nameLength];
    if (++count > 2_000_000 || end > bytes.length) throw new InspectError('The FBX node table is corrupt.');
    const name = new TextDecoder('latin1').decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const values = [];
    for (let i = 0; i < props; i += 1) {
      const [value, next] = prop(offset);
      values.push(value);
      offset = next;
    }
    const children = [];
    while (offset < end) {
      const [child, next] = node(offset);
      offset = next;
      if (!child) break;
      children.push(child);
    }
    return [{ name, props: values, children }, end];
  }

  const top = [];
  let offset = 27;
  try {
    while (offset < bytes.length - 13) {
      const [child, next] = node(offset);
      if (!child) break;
      top.push(child);
      offset = next;
    }
  } catch (error) {
    if (error instanceof InspectError) throw error;
    throw new InspectError('The FBX structure is truncated or corrupt.');
  }
  return { version, top };
}

function properties70(node) {
  const block = node?.children?.find((child) => child.name === 'Properties70');
  const values = {};
  for (const p of block?.children ?? []) if (p.name === 'P' && typeof p.props[0] === 'string') values[p.props[0]] = p.props.slice(4);
  return values;
}

const objectName = (value) => (typeof value === 'string' ? value.split('\u0000\u0001')[0] : null);

export function describeFbx(buffer) {
  const { version, top } = fbxTree(buffer);
  const objects = top.find((n) => n.name === 'Objects')?.children ?? [];
  const connections = top.find((n) => n.name === 'Connections')?.children ?? [];
  const settings = properties70(top.find((n) => n.name === 'GlobalSettings'));
  const models = new Map();
  const stacks = [];
  let meshes = 0;
  for (const object of objects) {
    if (object.props.length < 3) continue;
    const [uid, rawName, kind] = object.props;
    const key = String(uid);
    if (object.name === 'Model') models.set(key, { name: objectName(rawName), type: kind });
    else if (object.name === 'AnimationStack') {
      const props = properties70(object);
      const stop = (props.LocalStop ?? props.ReferenceStop ?? [null])[0];
      const start = (props.LocalStart ?? props.ReferenceStart ?? [0n])[0] ?? 0n;
      stacks.push({ name: objectName(rawName), durationS: typeof stop === 'bigint' ? Math.round(Number(stop - (typeof start === 'bigint' ? start : 0n)) / KTIME_PER_SECOND * 10000) / 10000 : null });
    } else if (object.name === 'Geometry' && kind === 'Mesh') meshes += 1;
  }
  const parentOf = new Map();
  for (const c of connections) {
    if (c.name === 'C' && c.props[0] === 'OO') {
      const child = String(c.props[1]);
      const parent = String(c.props[2]);
      if (models.has(child) && models.has(parent)) parentOf.set(child, parent);
    }
  }
  const bones = [...models.entries()].filter(([, m]) => m.type === 'LimbNode' || m.type === 'Root');
  const boneIds = new Set(bones.map(([id]) => id));
  const joints = bones.map(([id, m]) => ({ name: m.name, parent: boneIds.has(parentOf.get(id)) ? models.get(parentOf.get(id)).name : null }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const containerId = bones.map(([id]) => parentOf.get(id)).find((p) => p && !boneIds.has(p));
  const timeMode = (settings.TimeMode ?? [null])[0];
  const fps = FBX_TIME_MODES[timeMode] ?? (Number((settings.CustomFrameRate ?? [0])[0]) || null);
  return {
    format: 'fbx', version,
    skeletons: joints.length ? [{ name: containerId ? models.get(containerId).name : null, container: containerId ? models.get(containerId).name : null,
      jointCount: joints.length, roots: joints.filter((j) => j.parent === null).map((j) => j.name), joints, rootTransform: null }] : [],
    clips: stacks.map((stack, index) => ({ index, name: stack.name, durationS: stack.durationS, channels: null, bones: [], rootTranslation: [] })),
    mesh: { meshes }, nodes: null, fps
  };
}

export function inspectBuffer(fileName, buffer) {
  const extension = String(fileName).toLowerCase().split('.').pop();
  if (extension === 'glb') return describeGltf(readGlbJson(buffer));
  if (extension === 'fbx') return describeFbx(buffer);
  return { format: extension, skeletons: [], clips: [], mesh: null, nodes: null };
}
