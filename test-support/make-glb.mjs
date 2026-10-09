import zlib from 'node:zlib';
export function makeTriangleGlb() {
  const binary = Buffer.alloc(36);
  const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  vertices.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const gltf = {
    asset: { version: '2.0', generator: 'RigCheck CLI tests' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
      min: [0, 0, 0],
      max: [1, 1, 0]
    }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length, target: 34962 }],
    buffers: [{ byteLength: binary.length }]
  };
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const bin = pad(binary, 0x00);
  const totalLength = 12 + 8 + json.length + 8 + bin.length;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  const binHeader = 20 + json.length;
  output.writeUInt32LE(bin.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  bin.copy(output, binHeader + 8);
  return output;
}

function pad(buffer, byte) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, byte)]) : buffer;
}

// A valid PNG of the given size (solid gray). Enough for gltf-validator to decode its header.
export function makePng(width, height) {
  const { deflateSync, crc32 } = zlib;
  const row = Buffer.alloc(1 + width, 0x80);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// One triangle with an embedded base-color texture, a configurable number of declared materials (only the first is
// used by the mesh), and an optional skin. Used to test RigCheck's measurement-only metrics.
export function makeTexturedGlb({ width = 64, height = 32, materials = 1, skinned = false } = {}) {
  const positions = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const uvs = Buffer.alloc(24);
  [0, 0, 1, 0, 0, 1].forEach((value, index) => uvs.writeFloatLE(value, index * 4));
  const png = makePng(width, height);
  const segments = [];
  let offset = 0;
  const view = (bytes, extra = {}) => {
    const entry = { buffer: 0, byteOffset: offset, byteLength: bytes.length, ...extra };
    segments.push(pad(bytes, 0x00));
    offset += pad(bytes, 0x00).length;
    return entry;
  };
  const bufferViews = [view(positions, { target: 34962 }), view(uvs, { target: 34962 }), view(png)];
  const attributes = { POSITION: 0, TEXCOORD_0: 1 };
  const accessors = [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }
  ];
  const gltf = {
    asset: { version: '2.0', generator: 'RigCheck CLI tests' },
    scene: 0,
    scenes: [{ nodes: skinned ? [0, 1] : [0] }],
    nodes: [{ mesh: 0, ...(skinned ? { skin: 0 } : {}) }, ...(skinned ? [{ name: 'root_bone' }] : [])],
    meshes: [{ primitives: [{ attributes, material: 0 }] }],
    materials: Array.from({ length: materials }, (_, index) => ({ name: `material_${index}`, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } })),
    textures: [{ source: 0 }],
    images: [{ bufferView: 2, mimeType: 'image/png' }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }]
  };
  if (skinned) {
    const joints = Buffer.alloc(12);
    joints.fill(0);
    const weights = Buffer.alloc(48);
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0].forEach((value, index) => weights.writeFloatLE(value, index * 4));
    const inverse = Buffer.alloc(64);
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((value, index) => inverse.writeFloatLE(value, index * 4));
    bufferViews.push(view(joints, { target: 34962 }), view(weights, { target: 34962 }), view(inverse));
    accessors.push(
      { bufferView: 3, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 5, componentType: 5126, count: 1, type: 'MAT4' }
    );
    attributes.JOINTS_0 = 2;
    attributes.WEIGHTS_0 = 3;
    gltf.skins = [{ joints: [1], inverseBindMatrices: 4 }];
    gltf.buffers[0].byteLength = offset;
  }
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const bin = Buffer.concat(segments);
  const totalLength = 12 + 8 + json.length + 8 + bin.length;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  output.writeUInt32LE(bin.length, 20 + json.length);
  output.writeUInt32LE(0x004e4942, 24 + json.length);
  bin.copy(output, 28 + json.length);
  return output;
}
