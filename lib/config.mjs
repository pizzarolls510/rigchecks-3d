import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RIGCHECK_PROJECT_ID,
  RIGCHECK_STORAGE_BUCKET
} from '../dist/lib/model-schema.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG_PATH = path.join(repositoryRoot, 'rigcheck.config.json');

export class ConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.details = details;
  }
}

export async function loadConfig(configPath = process.env.RIGCHECK_CONFIG || DEFAULT_CONFIG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ConfigError(
        'CONFIG_MISSING',
        `Configuration not found at ${configPath}. Copy rigcheck.config.example.json to rigcheck.config.json and set ownerUid.`,
        { configPath }
      );
    }
    if (error instanceof SyntaxError) {
      throw new ConfigError('CONFIG_INVALID_JSON', `Configuration at ${configPath} is not valid JSON.`, { configPath });
    }
    throw error;
  }

  if (parsed.projectId !== RIGCHECK_PROJECT_ID) {
    throw new ConfigError(
      'PROJECT_MISMATCH',
      `Configured projectId must be exactly ${RIGCHECK_PROJECT_ID}.`,
      { configuredProjectId: parsed.projectId ?? null, expectedProjectId: RIGCHECK_PROJECT_ID, configPath }
    );
  }

  if (typeof parsed.ownerUid !== 'string' || !parsed.ownerUid.trim()) {
    throw new ConfigError('OWNER_UID_MISSING', 'ownerUid must be configured explicitly.', { configPath });
  }

  const ownerUid = parsed.ownerUid.trim();
  if (ownerUid.length > 128 || ownerUid.includes('/')) {
    throw new ConfigError('OWNER_UID_INVALID', 'ownerUid must be at most 128 characters and cannot contain a slash.', { configPath });
  }

  return Object.freeze({
    projectId: RIGCHECK_PROJECT_ID,
    ownerUid,
    storageBucket: RIGCHECK_STORAGE_BUCKET,
    configPath
  });
}

export function expectedConfigSummary() {
  return {
    projectId: RIGCHECK_PROJECT_ID,
    storageBucket: RIGCHECK_STORAGE_BUCKET,
    configPath: process.env.RIGCHECK_CONFIG || DEFAULT_CONFIG_PATH
  };
}
