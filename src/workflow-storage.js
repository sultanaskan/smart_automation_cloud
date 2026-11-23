'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const WORKFLOW_DIRECTORY = 'workflows';

function packageStorageName(workflowId, version) {
  const id = String(workflowId || '');
  const revision = Number(version);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Workflow package storage identity is invalid.');
  }
  return `${WORKFLOW_DIRECTORY}/${id}-v${revision}.saworkflow`;
}

function resolvePackagePath(storageRoot, storageName) {
  const name = String(storageName || '');
  if (!/^workflows\/[0-9a-f-]{36}-v[1-9][0-9]*\.saworkflow$/i.test(name)) {
    throw new Error('Workflow package storage reference is invalid.');
  }
  const root = path.resolve(storageRoot, WORKFLOW_DIRECTORY);
  const target = path.resolve(storageRoot, ...name.split('/'));
  if (!target.startsWith(root + path.sep)) throw new Error('Workflow package path is outside private storage.');
  return target;
}

async function writeWorkflowPackage(storageRoot, storageName, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Workflow package content is empty.');
  const destination = resolvePackagePath(storageRoot, storageName);
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.package-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return destination;
}

async function readWorkflowPackage(storageRoot, storageName, maximumBytes) {
  const filePath = resolvePackagePath(storageRoot, storageName);
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > maximumBytes) {
    throw new Error('Stored workflow package is missing or has an invalid size.');
  }
  return fs.readFile(filePath);
}

async function removeWorkflowPackage(storageRoot, storageName) {
  if (!storageName) return;
  await fs.rm(resolvePackagePath(storageRoot, storageName), { force: true });
}

module.exports = {
  packageStorageName,
  readWorkflowPackage,
  removeWorkflowPackage,
  writeWorkflowPackage
};
