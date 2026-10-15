'use strict';

const { zipSync, strFromU8, strToU8 } = require('fflate');

const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 12 * 1024 * 1024;
const EXPECTED_KIND = 'smart-automation-workflow';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findManifest(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_PACKAGE_BYTES) {
    throw new Error('Choose a workflow package under 25 MB.');
  }
  const min = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('Workflow package is not a valid ZIP archive.');
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength !== buffer.length) throw new Error('Workflow package ZIP directory is invalid.');
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw new Error('Multi-disk ZIP packages are not supported.');
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries !== buffer.readUInt16LE(eocd + 8) || entries > 10000) throw new Error('Workflow package contains too many or unsupported ZIP entries.');
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff
      || directoryOffset + directorySize > eocd) {
    throw new Error('ZIP64 workflow packages are not supported.');
  }
  let offset = directoryOffset;
  let manifest = null;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Workflow package ZIP directory is invalid.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > directoryOffset + directorySize || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff) {
      throw new Error('Workflow package contains an unsupported ZIP entry.');
    }
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === 'workflow.json') {
      if (manifest) throw new Error('Workflow package contains duplicate definitions.');
      if (uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('Workflow definition is too large.');
      if ((flags & 1) !== 0) throw new Error('Encrypted workflow definitions are not supported.');
      if (method !== 0 && method !== 8) throw new Error('Workflow definition uses an unsupported ZIP compression method.');
      if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('Workflow package definition header is invalid.');
      }
      const localFlags = buffer.readUInt16LE(localOffset + 6);
      const localMethod = buffer.readUInt16LE(localOffset + 8);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (localMethod !== method || ((localFlags ^ flags) & 1) !== 0 || dataEnd > directoryOffset
          || buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8') !== name) {
        throw new Error('Workflow package definition entry is invalid.');
      }
      let manifestBytes;
      try {
        const compressed = buffer.subarray(dataStart, dataEnd);
        if (method === 0) manifestBytes = Buffer.from(compressed);
        else manifestBytes = require('node:zlib').inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES });
      } catch {
        throw new Error('Could not decompress workflow definition within the allowed size.');
      }
      if (manifestBytes.length !== uncompressedSize || crc32(manifestBytes) !== expectedCrc) {
        throw new Error('Workflow package definition failed ZIP integrity checks.');
      }
      manifest = manifestBytes;
    }
    offset = end;
  }
  if (offset !== directoryOffset + directorySize) throw new Error('Workflow package ZIP directory is invalid.');
  if (!manifest) throw new Error('This is not a Smart Automation workflow package.');
  return manifest;
}

function sanitizeWorkflowPackage(buffer, override = {}) {
  const manifestBytes = findManifest(buffer);
  let parsed;
  try { parsed = JSON.parse(strFromU8(manifestBytes)); }
  catch { throw new Error('Workflow definition is not valid JSON.'); }
  if (!parsed || parsed.kind !== EXPECTED_KIND || !parsed.workflow || !Array.isArray(parsed.workflow.actions)) {
    throw new Error('Workflow package format is invalid or unsupported.');
  }
  const sanitized = structuredClone(parsed);
  sanitized.batchItems = [];
  sanitized.assets = [];
  const manifestName = String(sanitized.workflow.name ?? '').trim();
  const name = String(override.name ?? manifestName).trim();
  if (!name || name.length > 200) throw new Error('Workflow name is required and must be under 200 characters.');
  const description = String(override.description ?? sanitized.workflow.description ?? '').trim();
  if (description.length > 4000) throw new Error('Workflow description must be 4000 characters or fewer.');
  sanitized.workflow.name = name;
  sanitized.workflow.description = description;
  const cleanJson = strToU8(JSON.stringify(sanitized));
  if (cleanJson.length > MAX_MANIFEST_BYTES) throw new Error('Workflow definition is too large.');
  return {
    name,
    description,
    bytes: Buffer.from(zipSync({ 'workflow.json': cleanJson }, { level: 6 }))
  };
}

module.exports = { MAX_PACKAGE_BYTES, MAX_MANIFEST_BYTES, sanitizeWorkflowPackage };
