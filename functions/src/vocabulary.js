// The asset pipeline's own identifier rules and controlled vocabularies, read from
// tools/asset_pipeline/common.py at an exact commit: the same module the job runner imports from its checkout.
// Only the narrow literal forms common.py uses are understood (string-set literals, unions of earlier sets, and
// raw-string re.compile patterns); anything else fails closed, so a refactor there disables job requests with a
// clear error instead of letting the API validate against a guess.
import { ApiError } from './errors.js';

const MAX_CACHED_COMMITS = 4;
const SAFE_PATTERN = /^\^[A-Za-z0-9_\-[\]{},]+\$$/;

function fail(reason) {
  throw new ApiError(503, 'vocabulary_unavailable', `The asset pipeline vocabulary could not be read (${reason}).`);
}

// Returns the right-hand side of a top-level `NAME = ...` assignment, joined across lines until brackets balance.
function assignment(source, name) {
  const start = new RegExp(`^${name}\\s*=\\s*`, 'm').exec(source);
  if (!start) fail(`${name} not found`);
  let depth = 0;
  let end = start.index + start[0].length;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    else if (char === '\n' && depth === 0) break;
    if (depth < 0) fail(`${name} is malformed`);
  }
  return source.slice(start.index + start[0].length, end).trim();
}

function stringSet(source, name, seen = new Set()) {
  if (seen.has(name)) fail(`${name} is circular`);
  seen.add(name);
  const values = new Set();
  for (const term of assignment(source, name).split('|').map((part) => part.trim())) {
    if (/^[A-Z][A-Z0-9_]*$/.test(term)) {
      for (const value of stringSet(source, term, seen)) values.add(value);
      continue;
    }
    const literal = /^\{([\s\S]*)\}$/.exec(term);
    if (!literal) fail(`${name} is not a string-set literal`);
    for (const item of literal[1].split(',').map((part) => part.trim()).filter(Boolean)) {
      const string = /^"([^"\\\n]*)"$|^'([^'\\\n]*)'$/.exec(item);
      if (!string) fail(`${name} contains a non-literal value`);
      values.add(string[1] ?? string[2]);
    }
  }
  if (!values.size) fail(`${name} is empty`);
  return values;
}

function compiledPattern(source, name) {
  const match = /^re\.compile\(\s*r"([^"\n]*)"\s*\)$/.exec(assignment(source, name));
  if (!match || !SAFE_PATTERN.test(match[1])) fail(`${name} is not a simple anchored pattern`);
  return new RegExp(match[1]);
}

export function parsePipelineVocabulary(source) {
  if (typeof source !== 'string' || !source) fail('module is empty');
  const vocabulary = {
    assetId: compiledPattern(source, 'ID'),
    revisionId: compiledPattern(source, 'REVISION_ID'),
    categories: stringSet(source, 'CATEGORIES'),
    roles: stringSet(source, 'ROLES'),
    supportedExtensions: stringSet(source, 'SUPPORTED')
  };
  if ([...vocabulary.supportedExtensions].some((extension) => !/^\.[a-z0-9]{1,10}$/.test(extension))) {
    fail('SUPPORTED contains an unexpected extension');
  }
  return vocabulary;
}

// JSON-safe form for the browser (form choices and client-side pre-checks; the server re-checks everything).
export function publicVocabulary(vocabulary) {
  return {
    assetIdPattern: vocabulary.assetId.source,
    revisionIdPattern: vocabulary.revisionId.source,
    categories: [...vocabulary.categories].sort(),
    roles: [...vocabulary.roles].sort(),
    supportedExtensions: [...vocabulary.supportedExtensions].sort()
  };
}

// Keyed by immutable commit SHA, so a cached entry can never disagree with the repository.
export function createVocabularySource({ github, path }) {
  const cache = new Map();
  return {
    async at(commitSha) {
      if (cache.has(commitSha)) return cache.get(commitSha);
      const text = await github.fileText(commitSha, path);
      if (text === null) fail(`${path} is missing at ${commitSha.slice(0, 12)}`);
      const vocabulary = parsePipelineVocabulary(text);
      cache.set(commitSha, vocabulary);
      while (cache.size > MAX_CACHED_COMMITS) cache.delete(cache.keys().next().value);
      return vocabulary;
    }
  };
}
