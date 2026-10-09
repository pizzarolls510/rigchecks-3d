// In-memory doubles for the Asset Library API's dependencies (GitHub, Storage, Firestore). No network, no real
// repository, no real Actions runs.
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { strToU8, zipSync } from 'fflate';

export const HEAD_A = 'a'.repeat(40);
export const HEAD_B = 'b'.repeat(40);

export function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function lfsPointer(bytes) {
  return Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(bytes)}\nsize ${bytes.length}\n`);
}

function webStream(bytes, chunkSize = 64 * 1024) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
      return undefined;
    }
  });
}

// commits: { [sha]: { [path]: Buffer } } — files stored exactly as git would (LFS files as pointer text).
// lfs: { [oid]: Buffer } — LFS object store contents (can be tampered with to test integrity checks).
// Synthetic stand-in for tools/asset_pipeline/common.py: the same literal forms, generic values.
export const PIPELINE_COMMON = `
import re

CATEGORIES = {"operators", "enemies", "structures", "environments", "weapons",
              "ui", "effects", "audio", "other"}
ROLES = {"source", "runtime", "textures", "reference"}
LFS_EXTENSIONS = {".blend", ".glb", ".fbx", ".psd", ".tga", ".exr", ".tif", ".tiff", ".ktx2"}
SUPPORTED = LFS_EXTENSIONS | {".png", ".jpg", ".jpeg", ".webp", ".gif", ".hdr",
                              ".wav", ".ogg", ".mp3", ".flac", ".ttf", ".otf"}
ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
REVISION_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,95}$")
`;

export function resultZip(result, extra = {}) {
  return zipSync({ 'result.json': strToU8(JSON.stringify(result)), ...extra });
}

// runs: Map(runId -> { status, conclusion, displayTitle, htmlUrl, updatedAt, result }) driven by the test.
export function createFakeGitHub({ head, commits, lfs = {}, returnRunDetails = true }) {
  const calls = [];
  const state = { head, returnRunDetails, dispatchError: null, nextRunId: 9000 };
  const runs = new Map();
  const dispatches = [];
  const blobs = new Map();
  for (const files of Object.values(commits)) {
    for (const bytes of Object.values(files)) blobs.set(gitBlobSha(bytes), bytes);
  }
  const blobOverrides = new Map();
  const log = (name, ...args) => calls.push([name, ...args]);

  return {
    calls,
    state,
    runs,
    dispatches,
    blobOverrides,
    byteFetches: () => calls.filter(([name]) => name === 'blobStream' || name === 'lfsDownloadStream'),
    async branchHead(branch) {
      log('branchHead', branch);
      return state.head;
    },
    async fileText(sha, path) {
      log('fileText', sha, path);
      const bytes = commits[sha]?.[path];
      return bytes ? bytes.toString('utf8') : null;
    },
    async listDirectory(sha, directory) {
      log('listDirectory', sha, directory);
      const files = commits[sha] ?? {};
      const prefix = directory ? `${directory}/` : '';
      const entries = Object.entries(files)
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, bytes]) => ({ name: path.slice(prefix.length), path, type: 'file', sha: gitBlobSha(bytes), size: bytes.length }));
      return entries.length ? entries : null;
    },
    async blobText(blobSha) {
      log('blobText', blobSha);
      return (blobOverrides.get(blobSha) ?? blobs.get(blobSha)).toString('utf8');
    },
    async blobStream(blobSha) {
      log('blobStream', blobSha);
      return webStream(blobOverrides.get(blobSha) ?? blobs.get(blobSha));
    },
    async lfsDownloadStream({ oid, size }) {
      log('lfsDownloadStream', oid, size);
      const bytes = lfs[oid];
      if (!bytes) throw new Error(`fake LFS object ${oid} missing`);
      return webStream(bytes);
    },
    async dispatchWorkflow({ workflow, ref, inputs }) {
      log('dispatchWorkflow', workflow, ref, inputs);
      if (state.dispatchError) throw state.dispatchError;
      const id = state.nextRunId++;
      dispatches.push({ workflow, ref, inputs, runId: id });
      runs.set(id, {
        status: 'queued',
        conclusion: null,
        displayTitle: `asset-job ${inputs.job_id}`,
        htmlUrl: `https://github.com/example/runs/${id}`,
        updatedAt: null,
        result: null
      });
      return state.returnRunDetails ? { runId: id, htmlUrl: `https://github.com/example/runs/${id}` } : { runId: null, htmlUrl: null };
    },
    async findDispatchedRun({ workflow, branch, createdAfter, displayTitle }) {
      log('findDispatchedRun', workflow, branch, createdAfter, displayTitle);
      for (const [id, run] of runs) if (run.displayTitle === displayTitle) return { id, ...run };
      return null;
    },
    async getRun(runId) {
      log('getRun', runId);
      const run = runs.get(runId);
      if (!run) throw new Error(`fake run ${runId} missing`);
      return { id: runId, status: run.status, conclusion: run.conclusion, displayTitle: run.displayTitle, htmlUrl: run.htmlUrl, updatedAt: run.updatedAt };
    },
    async findArtifact(runId, name) {
      log('findArtifact', runId, name);
      const run = runs.get(runId);
      return run?.result ? { id: runId * 10, sizeInBytes: run.zip?.length ?? null } : null;
    },
    async downloadArtifact(artifactId, { maxBytes }) {
      log('downloadArtifact', artifactId, maxBytes);
      const run = runs.get(artifactId / 10);
      return run.zip ?? resultZip(run.result);
    }
  };
}

export function createFakeStore() {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    async exists(name) {
      calls.push(['exists', name]);
      return objects.has(name);
    },
    createWriteStream(name, options) {
      calls.push(['createWriteStream', name, options]);
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          objects.set(name, { bytes: Buffer.concat(chunks), options });
          callback();
        }
      });
    },
    async copyIfAbsent(source, destination) {
      calls.push(['copyIfAbsent', source, destination]);
      if (objects.has(destination)) return;
      objects.set(destination, objects.get(source));
    },
    async delete(name) {
      calls.push(['delete', name]);
      objects.delete(name);
    },
    async signedReadUrl(name, { expiresAt, fileName, contentType }) {
      calls.push(['signedReadUrl', name, { expiresAt, fileName, contentType }]);
      return `https://storage.googleapis.com/fake-bucket/${encodeURI(name)}?X-Goog-Expires=600&X-Goog-Signature=fake`;
    },
    // Staged uploads are written by the browser straight to Storage; tests place them in `objects` directly.
    async stat(name) {
      calls.push(['stat', name]);
      const object = objects.get(name);
      if (!object) return null;
      const md5Hash = object.md5Hash === undefined ? createHash('md5').update(object.bytes).digest('base64') : object.md5Hash;
      return { size: object.bytes.length, md5Hash, contentType: object.options?.contentType ?? null };
    },
    async signedStagedReadUrl(name, { expiresAt }) {
      calls.push(['signedStagedReadUrl', name, { expiresAt }]);
      return `https://storage.googleapis.com/fake-bucket/${encodeURI(name)}?X-Goog-Expires=1800&X-Goog-Signature=staged`;
    }
  };
}

// Firestore double with the semantics the job code relies on: transactions are atomic (run one at a time here),
// all reads must precede writes, update() requires an existing document, and nothing is written if the
// transaction function throws.
export function createFakeDb() {
  const docs = new Map();
  let queue = Promise.resolve();
  const clone = (value) => (value === null || value === undefined ? null : structuredClone(value));
  return {
    docs,
    async get(path) {
      return clone(docs.get(path));
    },
    async update(path, fields) {
      if (!docs.has(path)) throw Object.assign(new Error(`NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...clone(fields) });
    },
    async findEqual(collection, field, value, limit) {
      const read = (data, dotted) => dotted.split('.').reduce((current, key) => current?.[key], data);
      return [...docs.entries()]
        .filter(([path, data]) => path.startsWith(`${collection}/`) && path.split('/').length === 2 && read(data, field) === value)
        .slice(0, limit)
        .map(([, data]) => clone(data));
    },
    runTransaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const tx = {
          async get(path) {
            if (writes.length) throw new Error('Firestore transactions require all reads before writes');
            return clone(docs.get(path));
          },
          set(path, value) { writes.push(['set', path, clone(value)]); },
          update(path, fields) { writes.push(['update', path, clone(fields)]); },
          delete(path) { writes.push(['delete', path]); }
        };
        const result = await fn(tx);
        for (const [kind, path, value] of writes) {
          if (kind === 'set') docs.set(path, value);
          else if (kind === 'delete') docs.delete(path);
          else if (!docs.has(path)) throw new Error(`NOT_FOUND: ${path}`);
          else docs.set(path, { ...docs.get(path), ...value });
        }
        return result;
      });
      queue = run.catch(() => {});
      return run;
    }
  };
}

export const TOKENS = {
  reader: { uid: 'reader-uid', assetLibraryRole: 'reader' },
  writer: { uid: 'writer-uid', assetLibraryRole: 'writer' },
  writer2: { uid: 'writer2-uid', assetLibraryRole: 'writer' },
  noclaim: { uid: 'plain-uid' },
  bogusrole: { uid: 'bogus-uid', assetLibraryRole: 'admin' }
};

export async function fakeVerifyIdToken(token) {
  const decoded = TOKENS[token];
  if (!decoded) throw Object.assign(new Error('invalid token'), { code: 'auth/argument-error' });
  return decoded;
}

export async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    async request(path, { token, origin, method = 'GET', headers = {}, json, body: rawBody } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...(json !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : rawBody !== undefined ? { body: rawBody } : {})
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: response.status, headers: response.headers, body, text };
    }
  };
}
