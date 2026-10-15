'use strict';

const MAX_PAISE = 9_000_000_000_000_000n;

function parseMoneyToPaise(value, { allowZero = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error('Enter an amount with up to two decimal places.');
  }
  const [whole, fraction = ''] = raw.split('.');
  const paise = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if ((!allowZero && paise <= 0n) || paise > MAX_PAISE) {
    throw new Error(allowZero ? 'Amount is outside the allowed range.' : 'Amount must be greater than zero.');
  }
  return paise.toString();
}

function formatPaisa(value) {
  const paise = BigInt(value ?? 0);
  const negative = paise < 0n;
  const absolute = negative ? -paise : paise;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function addDays(date, days) {
  const parsed = Number(days);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) throw new Error('Subscription duration must be 1–3650 days.');
  return new Date(date.getTime() + parsed * 24 * 60 * 60 * 1000);
}

module.exports = { MAX_PAISE: MAX_PAISE.toString(), addDays, formatPaisa, parseMoneyToPaise };
