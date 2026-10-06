import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import validator from 'gltf-validator';
import { MAX_GLB_BYTES } from '../dist/lib/model-schema.js';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

export class GlbCheckError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GlbCheckError';
    this.code = code;
    this.details = details;
  }
}

export async function inspectGlb(filePath) {
  const absolutePath = path.resolve(filePath);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new GlbCheckError('FILE_NOT_FOUND', `File not found: ${absolutePath}`);
    throw error;
  }

  if (!fileStat.isFile()) throw new GlbCheckError('NOT_A_FILE', `Not a regular file: ${absolutePath}`);
  if (!/\.glb$/i.test(absolutePath)) throw new GlbCheckError('NOT_GLB', 'RigCheck Cloud accepts self-contained .glb files only.');
  if (fileStat.size > MAX_GLB_BYTES) {
    throw new GlbCheckError('FILE_TOO_LARGE', `GLB exceeds the ${MAX_GLB_BYTES}-byte upload limit.`, {
      sizeBytes: fileStat.size,
      maxBytes: MAX_GLB_BYTES
    });
  }

  const bytes = await readFile(absolutePath);
  const json = parseGlbJson(bytes);
  assertSelfContained(json);
  const validation = await validator.validateBytes(new Uint8Array(bytes), {
    uri: path.basename(absolutePath),
    maxIssues: 1000
  });

  const stats = sceneStats(json);
  const issues = normalizeIssues(validation.issues);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return {
    path: absolutePath,
    fileName: path.basename(absolutePath),
    fileType: 'glb',
    sizeBytes: fileStat.size,
    sha256,
    valid: issues.errorCount === 0,
    triangles: stats.triangles,
    meshes: stats.meshes,
    bones: stats.bones,
    skins: stats.skins,
    clips: Array.isArray(json.animations) ? json.animations.length : 0,
    validation: issues
  };
}

export function parseGlbJson(bytes) {
  if (bytes.length < 20) throw new GlbCheckError('INVALID_GLB', 'File is too short to contain a valid GLB header and JSON chunk.');
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new GlbCheckError('INVALID_GLB_MAGIC', 'File does not have the GLB magic header.');
  const version = bytes.readUInt32LE(4);
  if (version !== 2) throw new GlbCheckError('UNSUPPORTED_GLB_VERSION', `Expected GLB version 2, received ${version}.`);
  const declaredLength = bytes.readUInt32LE(8);
  if (declaredLength !== bytes.length) {
    throw new GlbCheckError('INVALID_GLB_LENGTH', `GLB header declares ${declaredLength} bytes, but the file contains ${bytes.length}.`);
  }

  const chunkLength = bytes.readUInt32LE(12);
  const chunkType = bytes.readUInt32LE(16);
  if (chunkType !== JSON_CHUNK || 20 + chunkLength > bytes.length) {
    throw new GlbCheckError('INVALID_GLB_JSON_CHUNK', 'The first GLB chunk is not a valid JSON chunk.');
  }

  try {
    return JSON.parse(bytes.subarray(20, 20 + chunkLength).toString('utf8').replace(/[\u0000 ]+$/g, ''));
  } catch {
    throw new GlbCheckError('INVALID_GLB_JSON', 'The GLB JSON chunk could not be parsed.');
  }
}

export function sceneStats(gltf) {
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  const skins = Array.isArray(gltf.skins) ? gltf.skins : [];
  const scenes = Array.isArray(gltf.scenes) ? gltf.scenes : [];
  const defaultScene = scenes[gltf.scene ?? 0] || { nodes: [] };
  const visited = new Set();
  const activeNodes = [];

  function visit(nodeIndex) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodes.length || visited.has(nodeIndex)) return;
    visited.add(nodeIndex);
    activeNodes.push(nodeIndex);
    for (const child of nodes[nodeIndex].children || []) visit(child);
  }
  for (const nodeIndex of defaultScene.nodes || []) visit(nodeIndex);

  let meshInstances = 0;
  let triangles = 0;
  const activeSkinIndexes = new Set();
  const activeBoneIndexes = new Set();

  for (const nodeIndex of activeNodes) {
    const node = nodes[nodeIndex];
    if (Number.isInteger(node.skin) && skins[node.skin]) {
      activeSkinIndexes.add(node.skin);
      for (const joint of skins[node.skin].joints || []) activeBoneIndexes.add(joint);
    }
    if (!Number.isInteger(node.mesh) || !meshes[node.mesh]) continue;
    for (const primitive of meshes[node.mesh].primitives || []) {
      meshInstances += 1;
      triangles += primitiveTriangleCount(primitive, gltf.accessors || []);
    }
  }

  return {
    triangles: Math.round(triangles),
    meshes: meshInstances,
    bones: activeBoneIndexes.size,
    skins: activeSkinIndexes.size
  };
}

export function assertSelfContained(gltf) {
  const externalUris = [
    ...(gltf.buffers || []).map((entry) => entry?.uri),
    ...(gltf.images || []).map((entry) => entry?.uri)
  ].filter((uri) => typeof uri === 'string' && uri && !uri.startsWith('data:'));
  if (externalUris.length) {
    throw new GlbCheckError(
      'EXTERNAL_RESOURCES',
      'GLB references external resources; RigCheck Cloud accepts one self-contained file only.',
      { resourceCount: externalUris.length }
    );
  }
}

function primitiveTriangleCount(primitive, accessors) {
  const accessorIndex = Number.isInteger(primitive.indices) ? primitive.indices : primitive.attributes?.POSITION;
  const count = Number.isInteger(accessorIndex) ? Number(accessors[accessorIndex]?.count || 0) : 0;
  const mode = primitive.mode ?? 4;
  if (mode === 4) return count / 3;
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function normalizeIssues(issues = {}) {
  const messages = [...(issues.messages || [])].map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    pointer: issue.pointer || null
  }));
  return {
    errorCount: Number(issues.numErrors || 0),
    warningCount: Number(issues.numWarnings || 0),
    infoCount: Number(issues.numInfos || 0),
    hintCount: Number(issues.numHints || 0),
    truncated: Boolean(issues.truncated),
    messages
  };
}
