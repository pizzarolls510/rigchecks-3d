import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSelfContained, inspectGlb, parseGlbJson, sceneStats } from '../lib/glb.mjs';
import { makeTriangleGlb } from '../test-support/make-glb.mjs';

test('inspectGlb validates and reports website-compatible scene statistics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rigcheck-glb-'));
  const filePath = path.join(directory, 'triangle.glb');
  await writeFile(filePath, makeTriangleGlb());

  const result = await inspectGlb(filePath);
  assert.equal(result.valid, true);
  assert.equal(result.fileType, 'glb');
  assert.equal(result.triangles, 1);
  assert.equal(result.meshes, 1);
  assert.equal(result.bones, 0);
  assert.equal(result.skins, 0);
  assert.equal(result.clips, 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.validation.errorCount, 0);
});

test('sceneStats counts rendered primitive instances and active skin joints', () => {
  const result = sceneStats({
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { mesh: 0, skin: 0 },
      { mesh: 0 },
      {},
      {}
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { indices: 1 }] }],
    accessors: [{ count: 6 }, { count: 3 }],
    skins: [{ joints: [2, 3] }]
  });

  assert.deepEqual(result, { triangles: 6, meshes: 4, bones: 2, skins: 1 });
});

test('parseGlbJson rejects an invalid magic header', () => {
  const bytes = Buffer.alloc(20);
  assert.throws(() => parseGlbJson(bytes), { code: 'INVALID_GLB_MAGIC' });
});

test('assertSelfContained rejects sidecar resources', () => {
  assert.throws(
    () => assertSelfContained({ images: [{ uri: 'texture.png' }] }),
    { code: 'EXTERNAL_RESOURCES' }
  );
  assert.doesNotThrow(() => assertSelfContained({ images: [{ uri: 'data:image/png;base64,AAAA' }] }));
});
