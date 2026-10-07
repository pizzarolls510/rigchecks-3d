// Thin adapter over a @google-cloud/storage Bucket (as returned by firebase-admin) for the asset cache.

function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createBucketStore(bucket) {
  return {
    async exists(name) {
      const [exists] = await bucket.file(name).exists();
      return exists;
    },

    createWriteStream(name, { contentType, metadata }) {
      return bucket.file(name).createWriteStream({
        resumable: true,
        validation: 'crc32c',
        contentType,
        metadata: { contentType, cacheControl: 'private, max-age=0', metadata }
      });
    },

    async copyIfAbsent(sourceName, destinationName) {
      try {
        await bucket.file(sourceName).copy(bucket.file(destinationName), { preconditionOpts: { ifGenerationMatch: 0 } });
      } catch (error) {
        // 412: the destination already exists, i.e. a concurrent request cached the same content ID.
        if (error?.code === 412) return;
        throw error;
      }
    },

    async delete(name) {
      await bucket.file(name).delete({ ignoreNotFound: true });
    },

    async signedReadUrl(name, { expiresAt, fileName, contentType }) {
      const [url] = await bucket.file(name).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: expiresAt,
        responseDisposition: contentDisposition(fileName),
        responseType: contentType
      });
      return url;
    }
  };
}
