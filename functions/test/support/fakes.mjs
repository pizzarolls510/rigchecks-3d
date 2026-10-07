// In-memory doubles for the Asset Library API's three dependencies. No network, no real repository.
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';

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
export function createFakeGitHub({ head, commits, lfs = {} }) {
  const calls = [];
  const state = { head };
  const blobs = new Map();
  for (const files of Object.values(commits)) {
    for (const bytes of Object.values(files)) blobs.set(gitBlobSha(bytes), bytes);
  }
  const blobOverrides = new Map();
  const log = (name, ...args) => calls.push([name, ...args]);

  return {
    calls,
    state,
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
    }
  };
}

export const TOKENS = {
  reader: { uid: 'reader-uid', assetLibraryRole: 'reader' },
  writer: { uid: 'writer-uid', assetLibraryRole: 'writer' },
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
    async request(path, { token, origin, method = 'GET', headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...headers
        }
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
