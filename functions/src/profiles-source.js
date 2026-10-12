// docs/ASSET_RIG_PROFILES.json at an exact commit: private INVASION rig namings, reference rest poses and gameplay slots.
// The public RigCheck code holds only the generic classifier; it receives this data from here. Older commits have no
// profiles file, which is reported as null rather than as an error.
const MAX_CACHED_COMMITS = 4;

export function createProfilesSource({ github, path }) {
  const cache = new Map();
  return {
    async at(commitSha) {
      if (cache.has(commitSha)) return cache.get(commitSha);
      const text = await github.fileText(commitSha, path);
      let profiles = null;
      if (text !== null) {
        try {
          const parsed = JSON.parse(text);
          profiles = parsed && parsed.profiles_version === 1 && typeof parsed.namings === 'object' ? parsed : null;
        } catch {
          profiles = null;
        }
      }
      cache.set(commitSha, profiles);
      while (cache.size > MAX_CACHED_COMMITS) cache.delete(cache.keys().next().value);
      return profiles;
    }
  };
}

// The slot policy for an asset category (operators -> profiles.slots.operator), or null.
export function slotPolicy(profiles, category) {
  const key = { operators: 'operator' }[category];
  const slots = key ? profiles?.slots?.[key] : null;
  return slots && typeof slots === 'object' ? slots : null;
}
