import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSelfContained, inspectGlb, modelMetrics, parseGlbJson, sceneStats } from '../lib/glb.mjs';
import { makeTexturedGlb, makeTriangleGlb } from '../test-support/make-glb.mjs';

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

test('inspectGlb adds measurement-only metrics: used materials, skinned meshes and decoded texture sizes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rigcheck-glb-'));
  const plainPath = path.join(directory, 'textured.glb');
  await writeFile(plainPath, makeTexturedGlb({ width: 1024, height: 512, materials: 2 }));
  const plain = await inspectGlb(plainPath);
  assert.equal(plain.valid, true, JSON.stringify(plain.validation.messages));
  assert.deepEqual(plain.metrics.materials, { declared: 2, used: 1, primitivesWithoutMaterial: 0 });
  assert.equal(plain.metrics.meshNodes, 1);
  assert.equal(plain.metrics.skinnedMeshNodes, 0);
  assert.deepEqual(plain.metrics.images, [{ index: 0, mimeType: 'image/png', width: 1024, height: 512 }]);
  assert.equal(plain.metrics.maxImageDimension, 1024);
  assert.equal(plain.metrics.unmeasuredImages, 0);
  assert.equal(plain.metrics.drawCalls, 1);
  assert.equal(plain.metrics.vertices, 3);
  assert.deepEqual(plain.metrics.animations, []);

  const skinnedPath = path.join(directory, 'skinned.glb');
  await writeFile(skinnedPath, makeTexturedGlb({ width: 256, height: 256, skinned: true }));
  const skinned = await inspectGlb(skinnedPath);
  assert.equal(skinned.valid, true, JSON.stringify(skinned.validation.messages));
  assert.equal(skinned.metrics.skinnedMeshNodes, 1);
  assert.equal(skinned.skins, 1);
  assert.equal(skinned.metrics.maxImageDimension, 256);

  const untextured = await inspectGlb(await (async () => { const p = path.join(directory, 'tri.glb'); await writeFile(p, makeTriangleGlb()); return p; })());
  assert.deepEqual(untextured.metrics.images, []);
  assert.equal(untextured.metrics.maxImageDimension, null);
  assert.equal(untextured.metrics.materials.primitivesWithoutMaterial, 1);
});

test('modelMetrics reports undecodable images as unmeasured instead of guessing', () => {
  const metrics = modelMetrics({ scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ material: 1 }] }], materials: [{}, {}], images: [{}, {}] },
    { resources: [{ pointer: '/images/0', mimeType: 'image/ktx2' }, { pointer: '/images/1', mimeType: 'image/png', image: { width: 2048, height: 1024 } }], drawCallCount: 1 });
  assert.deepEqual(metrics.images, [{ index: 0, mimeType: 'image/ktx2', width: null, height: null }, { index: 1, mimeType: 'image/png', width: 2048, height: 1024 }]);
  assert.equal(metrics.maxImageDimension, 2048);
  assert.equal(metrics.unmeasuredImages, 1);
  assert.deepEqual(metrics.materials, { declared: 2, used: 1, primitivesWithoutMaterial: 0 });
  assert.equal(metrics.vertices, null);
});
