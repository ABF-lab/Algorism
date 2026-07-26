import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLedger,
  formatINR,
  formatCompactINR,
  getAssumptions
} from './ledger.js';

test('one dialysis year / 15 = 10,592 screenings', () => {
  const ledger = computeLedger([]);
  const result = ledger.screeningsFundedByOneDialysisYear;
  assert.equal(result, 10592);
});

test('per high risk case deferred amount = 1588.80', () => {
  const records = [
    { outcome: 'refer', referralStatus: 'confirmed' }
  ];
  const ledger = computeLedger(records);
  assert.equal(ledger.deferred, 1588.8);
});

test('exactly 100 confirmed high-risk cases = one dialysis year', () => {
  const records = [];
  for (let i = 0; i < 100; i++) {
    records.push({ outcome: 'refer', referralStatus: 'confirmed' });
  }
  const ledger = computeLedger(records);
  assert.equal(ledger.deferred, 158880);
  assert.equal(ledger.dialysisYearsEquivalent, 1);
});

test('pending referrals excluded from deferred but tracked in deferredPending', () => {
  const records = [
    { outcome: 'refer', referralStatus: 'pending' },
    { outcome: 'urgent', referralStatus: 'pending' },
    { outcome: 'refer', referralStatus: 'confirmed' }
  ];
  const ledger = computeLedger(records);
  assert.equal(ledger.deferred, 1588.8);
  assert.equal(ledger.deferredPending, 1588.8 * 2);
  assert.equal(ledger.pendingFollowUp, 2);
  assert.equal(ledger.referralsConfirmed, 1);
});

test('formatting works correctly', () => {
  assert.equal(formatINR(158880), '₹1,58,880');
  assert.equal(formatCompactINR(158880), '₹1.59 L');
  assert.equal(formatCompactINR(10000000), '₹1 Cr');
  assert.equal(formatCompactINR(1500), '₹1,500');
});
