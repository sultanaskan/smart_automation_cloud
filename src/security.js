'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

function newId() { return crypto.randomUUID(); }
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(token, 'utf8').digest('hex'); }
function newCsrfToken() { return crypto.randomBytes(32).toString('hex'); }
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normalizeUsername(value) {
  const username = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) {
    throw new Error('Username must be 3–80 letters, digits, dots, underscores, or hyphens.');
  }
  return username;
}
function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value, 'utf8') > 72) {
    throw new Error('Use a password with at least 12 characters and no more than 72 UTF-8 bytes.');
  }
  return value;
}
function cleanText(value, maxLength, label, { required = false } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(`${label} is required.`);
  if (result.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return result;
}
function asBoolean(value) { return value === true || value === 'true' || value === '1' || value === 1; }
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function passwordHash(password) { return bcrypt.hash(password, 12); }
function passwordMatches(password, hash) { return bcrypt.compare(password, hash); }

module.exports = {
  asBoolean, asyncRoute, cleanText, hashToken, newCsrfToken, newId, newToken,
  normalizeUsername, passwordHash, passwordMatches, safeEqual, validatePassword
};
