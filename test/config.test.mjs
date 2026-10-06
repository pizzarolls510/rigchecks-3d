import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';

test('loadConfig accepts only the RigCheck project and an explicit owner UID', async () => {
  const configPath = await temporaryConfig({ projectId: 'rigcheck-cfbe3', ownerUid: 'owner-123' });
  const config = await loadConfig(configPath);
  assert.equal(config.projectId, 'rigcheck-cfbe3');
  assert.equal(config.ownerUid, 'owner-123');
  assert.equal(config.storageBucket, 'rigcheck-cfbe3.firebasestorage.app');
});

test('loadConfig rejects a mismatched Firebase project', async () => {
  const configPath = await temporaryConfig({ projectId: 'wrong-project', ownerUid: 'owner-123' });
  await assert.rejects(loadConfig(configPath), { code: 'PROJECT_MISMATCH' });
});

test('loadConfig rejects a missing owner UID', async () => {
  const configPath = await temporaryConfig({ projectId: 'rigcheck-cfbe3' });
  await assert.rejects(loadConfig(configPath), { code: 'OWNER_UID_MISSING' });
});

async function temporaryConfig(value) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rigcheck-config-'));
  const configPath = path.join(directory, 'rigcheck.config.json');
  await writeFile(configPath, JSON.stringify(value));
  return configPath;
}
