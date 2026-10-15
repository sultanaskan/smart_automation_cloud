'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashToken, newToken, normalizeUsername, passwordHash, passwordMatches, safeEqual, validatePassword } = require('../src/security');

test('API session tokens are random and stored as one-way hashes', () => {
  const a = newToken();
  const b = newToken();
  assert.ok(a.length >= 40);
  assert.notEqual(a, b);
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), a);
});

test('safe equality and account input rules reject malformed data', () => {
  assert.equal(safeEqual('abcd', 'abcd'), true);
  assert.equal(safeEqual('abcd', 'abce'), false);
  assert.throws(() => normalizeUsername('ab'));
  assert.throws(() => normalizeUsername('admin!'));
  assert.equal(normalizeUsername('member_01'), 'member_01');
  assert.throws(() => validatePassword('short'));
  assert.throws(() => validatePassword('x'.repeat(73)));
  assert.equal(validatePassword('a safe long password'), 'a safe long password');
});

test('password hashes verify but do not expose the original password', async () => {
  const hash = await passwordHash('a long private password');
  assert.notEqual(hash, 'a long private password');
  assert.equal(await passwordMatches('a long private password', hash), true);
  assert.equal(await passwordMatches('wrong password', hash), false);
});
