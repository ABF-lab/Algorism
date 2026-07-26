import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calcBMI,
  classifyBMI,
  classifyBP,
  classifyGlucose,
  calcIDRS,
  assess,
  fastingRisk
} from './clinical.js';

test('BMI 170/70 = 24.2 and classifies overweight', () => {
  const bmiVal = calcBMI(170, 70);
  assert.equal(bmiVal, 24.2);
  const bmiClass = classifyBMI(bmiVal);
  assert.equal(bmiClass.key, 'overweight');
  assert.equal(bmiClass.tone, 'warn');
});

test('BP 185/125 = crisis', () => {
  const bpClass = classifyBP(185, 125);
  assert.equal(bpClass.key, 'crisis');
  assert.equal(bpClass.tone, 'critical');
});

test('IDRS max case (age55/waist95/sedentary/both) = 100', () => {
  const idrsVal = calcIDRS({
    age: 55,
    sex: 'male',
    waistCm: 95,
    activity: 'sedentary',
    family: 'both_parents'
  });
  assert.equal(idrsVal.total, 100);
  assert.equal(idrsVal.band, 'high');
});

test('Measured BP crisis beats a low questionnaire', () => {
  const record = {
    age: 30,
    sex: 'male',
    waistCm: 85,
    activity: 'vigorous',
    family: 'none',
    systolic: 185,
    diastolic: 125
  };
  const assessment = assess(record);
  assert.equal(assessment.outcome, 'urgent');
  assert.equal(assessment.tone, 'critical');
  assert.ok(assessment.reasons.some(r => r.includes('Blood pressure crisis')));
});

test('Waist fallback from BMI sets proxied: true', () => {
  const idrsVal = calcIDRS({
    age: 30,
    sex: 'male',
    bmi: 26,
    activity: 'vigorous',
    family: 'none'
  });
  assert.equal(idrsVal.proxied, true);
  assert.equal(idrsVal.components[1].proxied, true);
  assert.equal(idrsVal.components[1].points, 20); // BMI >= 25 -> 20 pts
});

test('Ramadan fasting risk classifies correctly', () => {
  const record = {
    knownDiabetic: true,
    insulin: true,
    glucoseMgdl: 150
  };
  const risk = fastingRisk(record, assess(record));
  assert.equal(risk.level, 'veryhigh');
  assert.equal(risk.tone, 'high');
  assert.ok(risk.factors.includes('Using insulin'));
});
