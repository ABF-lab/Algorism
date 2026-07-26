/**
 * test-ledger.js — run with `npm test` or `node --test`.
 *
 * The tests that matter most here are the ones asserting that credit is NOT
 * written. The ledger's only claim to honesty is that it refuses to count a
 * referral nobody acted on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assess } from './clinical.js';
import {
  burdenDeferred, committeeLedger, pathwaysFor, screeningsFundedBy,
  dialysisComparison, formatInr,
  DIALYSIS_ANNUAL_SUPPORT_INR, SCREENING_COST_MIN_INR, SCREENING_COST_MAX_INR,
} from './ledger.js';

/* ------------------------------ fixtures ------------------------------ */

const base = {
  age: 30, sex: 'male', waistCm: 80, activity: 'vigorous', familyHistory: 'none',
  weightKg: 62, heightCm: 172, systolic: 116, diastolic: 76,
  glucoseMgdl: 95, glucoseType: 'random',
};

/** Build a record the way app.js does: raw fields plus a computed assessment. */
function record(overrides = {}, referralStatus = null, screenedAt = '2026-07-26T10:00:00Z') {
  const fields = { ...base, ...overrides };
  return {
    id: 'test',
    screenedAt,
    ...fields,
    assessment: assess(fields),
    referral: referralStatus ? { status: referralStatus } : null,
  };
}

const URGENT = { systolic: 190, diastolic: 118, glucoseMgdl: 340 };
const REFERRAL = { systolic: 145, diastolic: 92, glucoseMgdl: 210 };

/* -------------------------- the honesty gate -------------------------- */

test('a routine screening is never credited, however it is followed up', () => {
  for (const status of [null, 'issued', 'completed']) {
    const b = burdenDeferred(record({}, status));
    assert.equal(b.inr, 0);
    assert.equal(b.credited, false);
  }
});

test('an issued but unconfirmed referral is credited nothing', () => {
  const b = burdenDeferred(record(REFERRAL, 'issued'));
  assert.equal(b.inr, 0);
  assert.equal(b.credited, false);
  assert.match(b.reason, /not yet confirmed/i);
});

test('an escalated referral is credited nothing until it completes', () => {
  const b = burdenDeferred(record(REFERRAL, 'escalated'));
  assert.equal(b.inr, 0);
  assert.equal(b.credited, false);
});

test('credit is written only once the agent confirms completion', () => {
  const b = burdenDeferred(record(REFERRAL, 'completed'));
  assert.ok(b.inr > 0);
  assert.equal(b.credited, true);
  assert.match(b.reason, /confirmed complete/i);
});

test('a record with no assessment is credited nothing rather than throwing', () => {
  const b = burdenDeferred({ id: 'x', referral: { status: 'completed' } });
  assert.equal(b.inr, 0);
  assert.equal(b.credited, false);
});

/* --------------------------- the arithmetic --------------------------- */

test('an urgent confirmed referral projects the documented figure', () => {
  // renal 3575 + cardiac 2160 + stroke 1980 + foot 900 + vision 1260
  const b = burdenDeferred(record(URGENT, 'completed'));
  assert.equal(b.inr, 9875);
  assert.equal(b.breakdown.length, 5);
  assert.equal(b.breakdown.reduce((s, x) => s + x.inr, 0), b.inr);
});

test('a moderate referral is weighted below an urgent one', () => {
  const urgent = burdenDeferred(record(URGENT, 'completed')).inr;
  const referral = burdenDeferred(record(REFERRAL, 'completed')).inr;
  assert.equal(referral, 5925);
  assert.ok(referral < urgent, 'moderate risk must not be credited as if it were urgent');
});

test('every projection is labelled as a projection', () => {
  assert.equal(burdenDeferred(record(URGENT, 'completed')).isProjection, true);
  assert.equal(burdenDeferred(record({}, null)).isProjection, true);
  assert.equal(committeeLedger([]).isProjection, true);
});

/* ------------------------ pathway attribution ------------------------ */

test('a blood-pressure-only finding is not credited against diabetic pathways', () => {
  const keys = pathwaysFor(record({ systolic: 150, diastolic: 95 }, 'completed')).map((p) => p.key);
  assert.ok(keys.includes('cardiac') && keys.includes('stroke') && keys.includes('renal'));
  assert.ok(!keys.includes('foot'), 'diabetic foot must not be claimed for a hypertension finding');
  assert.ok(!keys.includes('vision'));
});

test('a glucose-only finding is not credited against cardiac or stroke', () => {
  const keys = pathwaysFor(record({ glucoseMgdl: 240 }, 'completed')).map((p) => p.key);
  assert.ok(keys.includes('foot') && keys.includes('vision') && keys.includes('renal'));
  assert.ok(!keys.includes('cardiac'));
  assert.ok(!keys.includes('stroke'));
});

test('a clean screening maps to no pathways at all', () => {
  assert.deepEqual(pathwaysFor(record()), []);
});

/* --------------------------- committee view --------------------------- */

test('committee ledger reports completion against issued, not against screenings', () => {
  const records = [
    record(),                          // routine, no referral
    record(),                          // routine, no referral
    record(REFERRAL, 'issued'),        // referred, not confirmed
    record(REFERRAL, 'completed'),     // referred, confirmed
    record(URGENT, 'completed'),       // referred, confirmed
    record(URGENT, 'escalated'),       // referred, chasing
  ];
  const l = committeeLedger(records);

  assert.equal(l.screenings, 6);
  assert.equal(l.referralsIssued, 4, 'only the four that needed a referral');
  assert.equal(l.referralsCompleted, 2);
  assert.equal(l.referralCompletionRate, 0.5, 'denominator is referrals issued, not screenings');
  assert.equal(l.highRiskIdentified, 4);
  assert.equal(l.burdenDeferredInr, 5925 + 9875);
});

test('committee ledger on an empty month reports zero rather than NaN', () => {
  const l = committeeLedger([]);
  assert.equal(l.screenings, 0);
  assert.equal(l.referralCompletionRate, 0);
  assert.equal(l.burdenDeferredInr, 0);
  assert.equal(l.consumablesSpentInr.min, 0);
});

test('committee ledger filters to a requested month', () => {
  const records = [
    record(URGENT, 'completed', '2026-07-10T09:00:00Z'),
    record(URGENT, 'completed', '2026-06-10T09:00:00Z'),
  ];
  const july = committeeLedger(records, { month: 6, year: 2026 }); // 0-indexed
  assert.equal(july.screenings, 1);
  assert.equal(july.burdenDeferredInr, 9875);
});

test('consumables spent are reported as the costed range, not a point estimate', () => {
  const l = committeeLedger([record(), record(), record()]);
  assert.equal(l.consumablesSpentInr.min, 3 * SCREENING_COST_MIN_INR);
  assert.equal(l.consumablesSpentInr.max, 3 * SCREENING_COST_MAX_INR);
});

/* ------------------- the headline strategy arithmetic ------------------- */

test('one dialysis patient-year matches the screenings claimed in the strategy', () => {
  const s = screeningsFundedBy(DIALYSIS_ANNUAL_SUPPORT_INR);
  // Document claims "10,600 to 13,200". These are the exact figures behind it.
  assert.equal(s.min, Math.floor(DIALYSIS_ANNUAL_SUPPORT_INR / SCREENING_COST_MAX_INR));
  assert.equal(s.max, Math.floor(DIALYSIS_ANNUAL_SUPPORT_INR / SCREENING_COST_MIN_INR));
  assert.equal(s.min, 10592);
  assert.equal(s.max, 13240);
});

test('the dialysis comparison covers every centre in the network', () => {
  const c = dialysisComparison();
  assert.equal(c.networkCentres, 100);
  assert.ok(c.perCentre.min >= 100, 'the claim is that it screens everyone at all 100 centres');
});

/* ------------------------------ formatting ------------------------------ */

test('currency uses Indian digit grouping', () => {
  assert.equal(formatInr(158880), '₹1,58,880');
  assert.equal(formatInr(100000), '₹1,00,000');
  assert.equal(formatInr(10000000), '₹1,00,00,000');
  assert.equal(formatInr(1000), '₹1,000');
  assert.equal(formatInr(100), '₹100');
  assert.equal(formatInr(0), '₹0');
});

test('currency rounds rather than emitting paise', () => {
  assert.equal(formatInr(9874.6), '₹9,875');
  assert.equal(formatInr(undefined), '₹0');
});
