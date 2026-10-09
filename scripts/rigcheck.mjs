#!/usr/bin/env node

import { inspectGlb } from '../lib/glb.mjs';
import { ConfigError, expectedConfigSummary, loadConfig } from '../lib/config.mjs';
import { listCloudModels, uploadCloudModel, verifyCloudAccess } from '../lib/firebase-cloud.mjs';
import { RIGCHECK_PROJECT_ID } from '../dist/lib/model-schema.js';

const rawArgs = process.argv.slice(2);
const json = takeFlag(rawArgs, '--json');
const dryRun = takeFlag(rawArgs, '--dry-run');
const help = takeFlag(rawArgs, '--help') || takeFlag(rawArgs, '-h');
const command = rawArgs.shift();

if (help || !command) {
  printHelp();
  process.exitCode = help ? 0 : 1;
} else {
  try {
    assertNoUnknownFlags(rawArgs);
    const result = await runCommand(command, rawArgs, { dryRun });
    emitSuccess(command, result, json);
  } catch (error) {
    emitFailure(command, error, json);
    process.exitCode = 1;
  }
}

async function runCommand(name, args, options) {
  if (name === 'check') {
    assertExactArgs(name, args, 1);
    assertNoDryRun(name, options.dryRun);
    const inspection = await inspectGlb(args[0]);
    if (!inspection.valid) {
      const error = new Error('The GLB failed validation and is not safe to upload.');
      error.code = 'GLB_VALIDATION_FAILED';
      error.details = inspection;
      throw error;
    }
    return inspection;
  }

  if (name === 'doctor') {
    assertExactArgs(name, args, 0);
    assertNoDryRun(name, options.dryRun);
    return runDoctor();
  }

  if (name === 'list') {
    assertExactArgs(name, args, 0);
    assertNoDryRun(name, options.dryRun);
    const config = await loadConfig();
    const models = await listCloudModels(config);
    return { projectId: config.projectId, ownerUid: config.ownerUid, count: models.length, models };
  }

  if (name === 'upload') {
    assertExactArgs(name, args, 1);
    const config = await loadConfig();
    const inspection = await inspectGlb(args[0]);
    if (!inspection.valid) {
      const error = new Error('The GLB failed validation; no cloud operation was attempted.');
      error.code = 'GLB_VALIDATION_FAILED';
      error.details = inspection;
      throw error;
    }
    const upload = await uploadCloudModel(config, inspection, { dryRun: options.dryRun });
    return { projectId: config.projectId, ownerUid: config.ownerUid, inspection, upload };
  }

  const error = new Error(`Unknown command: ${name}`);
  error.code = 'UNKNOWN_COMMAND';
  throw error;
}

async function runDoctor() {
  const expected = expectedConfigSummary();
  const report = {
    projectId: RIGCHECK_PROJECT_ID,
    ownerUid: null,
    configPath: expected.configPath,
    ready: false,
    checks: {
      node: {
        ok: Number(process.versions.node.split('.')[0]) >= 22,
        message: `Node.js ${process.versions.node} (requires 22 or newer).`
      },
      config: { ok: false, message: 'Configuration has not been loaded.' },
      project: { ok: false, message: `Expected project ${RIGCHECK_PROJECT_ID}.` },
      adc: { ok: false, message: 'Skipped until configuration is valid.' },
      firestore: { ok: false, message: 'Skipped until configuration and ADC are valid.' },
      storage: { ok: false, message: 'Skipped until configuration and ADC are valid.' }
    }
  };

  try {
    const config = await loadConfig();
    report.ownerUid = config.ownerUid;
    report.configPath = config.configPath;
    report.checks.config = { ok: true, message: `Loaded ${config.configPath}.` };
    report.checks.project = { ok: config.projectId === RIGCHECK_PROJECT_ID, message: `Configured project is ${config.projectId}.` };
    Object.assign(report.checks, await verifyCloudAccess(config));
  } catch (error) {
    report.checks.config = { ok: false, message: error.message, code: error.code || 'CONFIG_ERROR' };
  }

  report.ready = Object.values(report.checks).every((check) => check.ok);
  if (!report.ready) {
    const error = new Error('This machine is not ready for RigCheck cloud operations.');
    error.code = 'DOCTOR_FAILED';
    error.details = report;
    throw error;
  }
  return report;
}

function takeFlag(args, flag) {
  let found = false;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index] === flag) {
      args.splice(index, 1);
      found = true;
    }
  }
  return found;
}

function assertNoUnknownFlags(args) {
  const unknown = args.find((arg) => arg.startsWith('-'));
  if (!unknown) return;
  const error = new Error(`Unknown option: ${unknown}`);
  error.code = 'UNKNOWN_OPTION';
  throw error;
}

function assertExactArgs(name, args, count) {
  if (args.length === count) return;
  const expected = count === 0 ? 'no arguments' : count === 1 ? 'one file path' : `${count} arguments`;
  const error = new Error(`rigcheck ${name} expects ${expected}.`);
  error.code = 'INVALID_ARGUMENTS';
  throw error;
}

function assertNoDryRun(name, enabled) {
  if (!enabled) return;
  const error = new Error(`--dry-run is only supported by rigcheck upload; ${name} is already read-only.`);
  error.code = 'INVALID_OPTION';
  throw error;
}

function emitSuccess(commandName, result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, command: commandName, result }, null, 2)}\n`);
    return;
  }
  if (commandName === 'doctor') return printDoctor(result);
  if (commandName === 'check') return printCheck(result);
  if (commandName === 'list') return printList(result);
  if (commandName === 'upload') return printUpload(result);
}

function emitFailure(commandName, error, asJson) {
  const payload = {
    ok: false,
    command: commandName || null,
    error: {
      code: error?.code || (error instanceof ConfigError ? error.code : 'RIGCHECK_ERROR'),
      message: error?.message || 'RigCheck failed.',
      ...(error?.details ? { details: error.details } : {})
    }
  };
  const rendered = JSON.stringify(payload, null, 2);
  if (asJson) process.stdout.write(`${rendered}\n`);
  else {
    process.stderr.write(`RigCheck error [${payload.error.code}]: ${payload.error.message}\n`);
    if (payload.error.details?.checks) printDoctor(payload.error.details, process.stderr);
  }
}

function printDoctor(report, stream = process.stdout) {
  stream.write(`RigCheck doctor\nProject ID: ${report.projectId}\nOwner UID: ${report.ownerUid || 'NOT CONFIGURED'}\nConfig: ${report.configPath}\n\n`);
  for (const [name, check] of Object.entries(report.checks)) {
    stream.write(`${check.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} ${check.message}\n`);
  }
  stream.write(`\n${report.ready ? 'READY' : 'NOT READY'}\n`);
}

function printCheck(result) {
  process.stdout.write(
    `${result.valid ? 'VALID' : 'INVALID'}  ${result.fileName}\n`
    + `Size: ${formatBytes(result.sizeBytes)} (${result.sizeBytes} bytes)\n`
    + `SHA-256: ${result.sha256}\n`
    + `Triangles: ${result.triangles}\nMeshes: ${result.meshes}\nBones: ${result.bones}\nSkins: ${result.skins}\nClips: ${result.clips}\n`
    + (result.metrics
      ? `Materials used: ${result.metrics.materials.used} of ${result.metrics.materials.declared}\n`
        + `Skinned mesh nodes: ${result.metrics.skinnedMeshNodes}\n`
        + `Largest texture: ${result.metrics.maxImageDimension === null ? (result.metrics.images.length ? 'not measured' : 'none') : `${result.metrics.maxImageDimension} px`}\n`
      : '')
    + `Validator: ${result.validation.errorCount} errors, ${result.validation.warningCount} warnings, ${result.validation.infoCount} infos, ${result.validation.hintCount} hints\n`
  );
  for (const issue of result.validation.messages) {
    process.stdout.write(`- [${severityName(issue.severity)}] ${issue.code}: ${issue.message}${issue.pointer ? ` (${issue.pointer})` : ''}\n`);
  }
}

function printList(result) {
  process.stdout.write(`RigCheck Cloud — ${result.count} model${result.count === 1 ? '' : 's'}\nProject ID: ${result.projectId}\nOwner UID: ${result.ownerUid}\n\n`);
  if (!result.models.length) return;
  for (const model of result.models) {
    process.stdout.write(`${model.id}  ${model.name || model.originalName || 'Untitled model'}  ${formatBytes(model.sizeBytes)}  ${model.updatedAt || 'unknown date'}\n`);
  }
}

function printUpload(result) {
  printCheck(result.inspection);
  const upload = result.upload;
  process.stdout.write(`\n${upload.status.toUpperCase()}\nModel ID: ${upload.modelId}\n`);
  if (upload.storagePath) process.stdout.write(`Storage: ${upload.storagePath}\n`);
  if (upload.message) process.stdout.write(`${upload.message}\n`);
  if (upload.likelyDuplicates?.length) process.stdout.write(`Warning: ${upload.likelyDuplicates.length} likely name-and-size duplicate(s) found.\n`);
}

function severityName(value) {
  return ['ERROR', 'WARNING', 'INFO', 'HINT'][value] || String(value);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function printHelp() {
  process.stdout.write(`RigCheck CLI\n\nUsage:\n  rigcheck doctor [--json]\n  rigcheck check <file.glb> [--json]\n  rigcheck upload <file.glb> [--dry-run] [--json]\n  rigcheck list [--json]\n`);
}
