'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays, formatPaisa, parseMoneyToPaise } = require('../src/money');

test('BDT amounts convert to integer poisha without float rounding', () => {
  assert.equal(parseMoneyToPaise('0.01'), '1');
  assert.equal(parseMoneyToPaise('12'), '1200');
  assert.equal(parseMoneyToPaise('1000.7'), '100070');
  assert.equal(formatPaisa('100070'), '1000.70');
});

test('wallet rejects invalid, zero, negative, and over-precision amounts', () => {
  for (const amount of ['', '0', '-1', '1.001', '01.00', '1e4', 'NaN', '90000000000000.01']) {
    assert.throws(() => parseMoneyToPaise(amount), undefined, amount);
  }
  assert.equal(parseMoneyToPaise('0', { allowZero: true }), '0');
});

test('manual renewal adds duration to a later active expiry and bounds the term', () => {
  const base = new Date('2026-10-14T00:00:00.000Z');
  assert.equal(addDays(base, 30).toISOString(), '2026-11-13T00:00:00.000Z');
  assert.throws(() => addDays(base, 0));
  assert.throws(() => addDays(base, 3651));
});
