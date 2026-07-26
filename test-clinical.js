/**
 * test-clinical.js — run with `npm test` or `node --test`.
 * Zero dependencies: node:test and node:assert are built in.
 *
 * These tests exist so a clinician can change a threshold in clinical.js and
 * find out immediately whether they broke an escalation rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  idrs, bmi, bloodPressure, glucose, assess, patientSafeSummary,
  BP_CRISIS_SYSTOLIC,
} from './clinical.js';

/* ------------------------------- IDRS ------------------------------- */

test('IDRS scores a young active person with no family history at zero', () => {
  const r = idrs({ age: 30, sex: 'male', waistCm: 85, activity: 'vigorous', familyHistory: 'none' });
  assert.equal(r.score, 0);
  assert.equal(r.band, 'low');
});

test('IDRS scores the maximum-risk profile at 100', () => {
  const r = idrs({ age: 55, sex: 'male', waistCm: 105, activity: 'sedentary', familyHistory: 'both_parents' });
  assert.equal(r.score, 100);
  assert.equal(r.band, 'high');
});

test('IDRS applies sex-specific waist thresholds', () => {
  const common = { age: 30, activity: 'vigorous', familyHistory: 'none' };
  // 85cm is below the male cutoff (90) but inside the female 80-89 band.
  assert.equal(idrs({ ...common, sex: 'male', waistCm: 85 }).score, 0);
  assert.equal(idrs({ ...common, sex: 'female', waistCm: 85 }).score, 10);
});

test('IDRS band boundaries are 30 and 60', () => {
  // Exactly 30: age 50+ alone.
  const at30 = idrs({ age: 50, sex: 'male', waistCm: 85, activity: 'vigorous', familyHistory: 'none' });
  assert.equal(at30.score, 30);
  assert.equal(at30.band, 'moderate', '30 is the bottom of the moderate band, not low');

  // Exactly 60: 30 + 20 + 10.
  const at60 = idrs({ age: 50, sex: 'male', waistCm: 100, activity: 'moderate', familyHistory: 'none' });
  assert.equal(at60.score, 60);
  assert.equal(at60.band, 'high', '60 is the bottom of the high band');
});

test('IDRS breakdown sums to the score', () => {
  const r = idrs({ age: 40, sex: 'female', waistCm: 85, activity: 'moderate', familyHistory: 'one_parent' });
  assert.equal(r.score, 50);
  assert.equal(r.breakdown.reduce((s, b) => s + b.points, 0), r.score);
});

test('IDRS rejects unknown categorical inputs rather than scoring them as zero', () => {
  const base = { age: 40, sex: 'male', waistCm: 85, familyHistory: 'none' };
  assert.throws(() => idrs({ ...base, activity: 'unknown' }), /Unknown activity/);
  assert.throws(() => idrs({ ...base, activity: 'mild', familyHistory: 'maybe' }), /Unknown family history/);
});

/* -------------------------------- BMI -------------------------------- */

test('BMI uses Asian Indian cutoffs, not WHO international', () => {
  // 24.2 is "normal" under WHO but overweight for this population.
  const r = bmi(70, 170);
  assert.equal(r.value, 24.2);
  assert.equal(r.band, 'overweight');

  // 27.7 is "overweight" under WHO but obese here.
  assert.equal(bmi(80, 170).band, 'obese');
});

test('BMI band boundaries fall at 18.5, 23 and 25', () => {
  // Height 100cm makes weight and BMI numerically identical.
  assert.equal(bmi(18.4, 100).band, 'underweight');
  assert.equal(bmi(18.5, 100).band, 'normal');
  assert.equal(bmi(22.9, 100).band, 'normal');
  assert.equal(bmi(23, 100).band, 'overweight');
  assert.equal(bmi(25, 100).band, 'obese');
});

test('BMI returns null rather than Infinity on unusable input', () => {
  assert.equal(bmi(70, 0), null);
  assert.equal(bmi(0, 170), null);
  assert.equal(bmi(undefined, undefined), null);
});

/* --------------------------- Blood pressure --------------------------- */

test('blood pressure grades on whichever reading is worse', () => {
  assert.equal(bloodPressure(118, 78).band, 'normal');
  assert.equal(bloodPressure(125, 82).band, 'elevated');
  assert.equal(bloodPressure(145, 88).band, 'stage1', 'systolic alone should escalate');
  assert.equal(bloodPressure(138, 92).band, 'stage1', 'diastolic alone should escalate');
  assert.equal(bloodPressure(165, 95).band, 'stage2');
});

test('blood pressure crisis triggers on either limb', () => {
  assert.equal(bloodPressure(BP_CRISIS_SYSTOLIC, 90).band, 'crisis');
  assert.equal(bloodPressure(150, 112).band, 'crisis');
});

/* ------------------------------ Glucose ------------------------------ */

test('glucose thresholds differ between fasting and random', () => {
  assert.equal(glucose(120, 'random').band, 'normal');
  assert.equal(glucose(120, 'fasting').band, 'impaired', '120 fasting is not normal');
  assert.equal(glucose(160, 'random').band, 'impaired');
  assert.equal(glucose(210, 'random').band, 'high');
  assert.equal(glucose(130, 'fasting').band, 'high');
});

test('glucose flags urgent separately from band', () => {
  assert.equal(glucose(210, 'random').urgent, false);
  assert.equal(glucose(320, 'random').urgent, true);
  assert.equal(glucose(260, 'fasting').urgent, true);
});

test('glucose rejects an unknown sample type', () => {
  assert.throws(() => glucose(120, 'postprandial'), /Unknown glucose type/);
});

/* ------------------------------ assess ------------------------------ */

const healthy = {
  age: 30, sex: 'male', waistCm: 80, activity: 'vigorous', familyHistory: 'none',
  weightKg: 62, heightCm: 172, systolic: 116, diastolic: 76,
  glucoseMgdl: 95, glucoseType: 'random',
};

test('a clean screening needs no referral and sets a 12 month interval', () => {
  const a = assess(healthy);
  assert.equal(a.action, 'routine');
  assert.equal(a.monitoringMonths, 12);
  assert.deepEqual(a.reasons, []);
});

test('raised blood pressure alone produces a referral', () => {
  const a = assess({ ...healthy, systolic: 145, diastolic: 88 });
  assert.equal(a.action, 'referral');
  assert.equal(a.monitoringMonths, 3);
  assert.match(a.reasons.join(' '), /Blood pressure 145\/88/);
});

test('a crisis reading escalates the whole record to urgent', () => {
  const a = assess({ ...healthy, systolic: 186, diastolic: 115 });
  assert.equal(a.action, 'urgent');
  assert.equal(a.monitoringMonths, 1);
});

test('one urgent finding outranks other merely-referral findings', () => {
  const a = assess({ ...healthy, systolic: 145, diastolic: 88, glucoseMgdl: 340 });
  assert.equal(a.action, 'urgent', 'urgent must win over referral regardless of order');
  assert.equal(a.reasons.length, 2, 'both reasons are still recorded');
});

test('a high IDRS refers even when every vital sign is normal', () => {
  const a = assess({
    ...healthy, age: 55, waistCm: 105, activity: 'sedentary', familyHistory: 'both_parents',
  });
  assert.equal(a.findings.idrs.band, 'high');
  assert.equal(a.action, 'referral');
});

test('obesity alone is recorded but does not by itself trigger a referral', () => {
  const a = assess({ ...healthy, weightKg: 85, heightCm: 165 });
  assert.equal(a.findings.bmi.band, 'obese');
  assert.equal(a.action, 'routine');
  assert.match(a.reasons.join(' '), /obese/);
});

test('assess tolerates a partial record from the field', () => {
  const a = assess({ systolic: 150, diastolic: 95 });
  assert.equal(a.action, 'referral');
  assert.equal(a.findings.idrs, null);
  assert.equal(a.findings.bmi, null);
  assert.equal(a.findings.glucose, null);
});

/* --------------------- patient-facing safety rule --------------------- */

test('patient summary never names a condition', () => {
  const forbidden = /diabet|hypertens|blood pressure is high|sugar disease/i;
  for (const record of [
    healthy,
    { ...healthy, systolic: 145, diastolic: 88 },
    { ...healthy, systolic: 190, diastolic: 120, glucoseMgdl: 350 },
  ]) {
    const text = patientSafeSummary(assess(record));
    assert.ok(!forbidden.test(text), `leaked a condition name: "${text}"`);
    assert.match(text, /doctor|check/i, 'must still route the person somewhere');
  }
});

test('patient summary escalates urgency wording for urgent cases', () => {
  assert.match(patientSafeSummary(assess({ ...healthy, systolic: 190, diastolic: 120 })), /today/);
});
