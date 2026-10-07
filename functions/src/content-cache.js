// Content identity resolution and the derived Storage cache.
// Bytes stream GitHub -> temporary object -> verified -> server-side copy to the content-addressed name.
// They never pass through an HTTP response and are never held in memory as a whole file.
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CACHE_PREFIX, CACHE_TMP_PREFIX, LFS_POINTER_MAX_BYTES } from './config.js';
import { ApiError } from './errors.js';

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1\n';

const CONTENT_TYPES = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  hdr: 'image/vnd.radiance',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ktx2: 'image/ktx2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  flac: 'audio/flac'
};

export function contentTypeFor(path) {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export function parseLfsPointer(text) {
  if (typeof text !== 'string' || !text.startsWith(LFS_POINTER_PREFIX)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  if (!oid || size === undefined) return null;
  return { oid, size: Number(size) };
}

export async function resolveContent({ source, github, commitSha, path }) {
  const entry = await source.treeEntry(commitSha, path);
  if (!entry) {
    throw new ApiError(404, 'not_published', 'Not yet available from the authoritative repository.', { path, commitSha });
  }
  if (entry.size <= LFS_POINTER_MAX_BYTES) {
    const pointer = parseLfsPointer(await github.blobText(entry.sha));
    if (pointer) return { kind: 'lfs', contentId: `lfs/${pointer.oid}`, oid: pointer.oid, size: pointer.size, blobSha: entry.sha };
  }
  return { kind: 'git', contentId: `git/${entry.sha}`, blobSha: entry.sha, size: entry.size };
}

export function cacheObjectName(content) {
  return `${CACHE_PREFIX}${content.contentId}`;
}

function toNodeStream(stream) {
  return typeof stream?.getReader === 'function' ? Readable.fromWeb(stream) : stream;
}

export async function ensureCached({ store, github, content, contentType, metadata, maxBytes, makeTmpId }) {
  const finalName = cacheObjectName(content);
  if (await store.exists(finalName)) return { name: finalName, cacheHit: true };
  if (content.size > maxBytes) {
    throw new ApiError(413, 'asset_too_large', `This file is larger than the Asset Library delivery limit (${maxBytes} bytes).`);
  }

  // LFS objects are identified by sha256 of their bytes; git blobs by sha1 over the "blob <size>\0" header.
  const hash = content.kind === 'lfs' ? createHash('sha256') : createHash('sha1').update(`blob ${content.size}\0`);
  const expected = content.kind === 'lfs' ? content.oid : content.blobSha;
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > content.size) {
        callback(new ApiError(502, 'integrity_mismatch', 'The repository returned more bytes than recorded.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  const tmpName = `${CACHE_TMP_PREFIX}${makeTmpId()}`;
  try {
    const upstream = content.kind === 'lfs'
      ? await github.lfsDownloadStream({ oid: content.oid, size: content.size })
      : await github.blobStream(content.blobSha);
    await pipeline(toNodeStream(upstream), meter, store.createWriteStream(tmpName, { contentType, metadata }));
    const digest = hash.digest('hex');
    if (received !== content.size || digest !== expected) {
      throw new ApiError(502, 'integrity_mismatch', 'The repository bytes did not match their recorded identity; nothing was cached.', {
        contentId: content.contentId,
        expectedSize: content.size,
        receivedSize: received
      });
    }
    // Create-only: a concurrent fill of the same content ID already wrote identical bytes.
    await store.copyIfAbsent(tmpName, finalName);
    return { name: finalName, cacheHit: false };
  } finally {
    await store.delete(tmpName).catch(() => {});
  }
}
