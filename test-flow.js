/**
 * test-flow.js — walks the two-minute demo end to end, headlessly.
 *
 * This is the sequence in the strategy document, step for step:
 *   1-2. reading captured from the device screen
 *   3.   risk flags elevated, offline throughout
 *   4.   referral slip generates in Urdu naming clinic and scheme
 *   5.   day 3, patient cannot attend, agent resolves the barrier
 *   6.   day 10, patient confirms attendance and medication
 *   7.   only now does the ledger move
 *
 * Runs with no API key, so every model call takes its mock path. That is the
 * point: the airplane-mode demo must work, and this proves it does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assess, patientSafeSummary } from './clinical.js';
import { burdenDeferred, committeeLedger, formatInr } from './ledger.js';
import { readDeviceScreen, generateReferral, followUpTurn, openingMessage, hasApiKey } from './ai.js';

const CLINIC = {
  clinicName: 'Namma Clinic, Shivajinagar',
  clinicDetail: 'Open 9am to 4pm, Monday to Saturday',
  scheme: 'Ayushman Bharat PM-JAY',
  eveningClinic: 'Namma Clinic, Frazer Town, open 2pm to 8pm',
};

test('the environment has no key, so every call must take the mock path', () => {
  assert.equal(hasApiKey(), false, 'test must run keyless to prove the offline demo');
});

/* ------------------------- steps 1 to 3: capture ------------------------- */

test('step 1-3: the glucometer is read and the reading flags elevated', async () => {
  const res = await readDeviceScreen('not-a-real-image', 'glucometer');

  assert.equal(res.simulated, true);
  assert.match(res.simulationReason, /No API key/);
  assert.equal(res.readable, true);
  assert.equal(res.glucoseMgdl, 214);
  assert.match(res.note, /[Ss]imulated/, 'simulated output must say so in its own note');

  const a = assess({
    age: 54, sex: 'female', waistCm: 94, activity: 'sedentary', familyHistory: 'both_parents',
    heightCm: 152, weightKg: 68, glucoseMgdl: res.glucoseMgdl, glucoseType: 'random',
  });
  assert.equal(a.action, 'referral', 'a demo that returns "normal" demonstrates nothing');
  assert.ok(!/diabet|hypertens/i.test(patientSafeSummary(a)));
});

test('a BP monitor scan fills all three fields', async () => {
  const res = await readDeviceScreen('not-a-real-image', 'bp_monitor');
  assert.equal(res.deviceType, 'bp_monitor');
  assert.equal(res.systolic, 148);
  assert.equal(res.diastolic, 94);
  assert.equal(res.pulse, 82);
  assert.equal(assess({ systolic: res.systolic, diastolic: res.diastolic }).action, 'referral');
});

/* --------------------------- step 4: the slip --------------------------- */

const assessment = assess({
  age: 54, sex: 'female', waistCm: 94, activity: 'sedentary', familyHistory: 'both_parents',
  heightCm: 152, weightKg: 68, systolic: 148, diastolic: 94, glucoseMgdl: 214, glucoseType: 'random',
});

test('step 4: the slip generates in Urdu and names the clinic and the scheme', async () => {
  const slip = await generateReferral({ ...CLINIC, assessment, language: 'ur', patientName: 'Fatima' });

  assert.equal(slip.simulated, true);
  assert.ok(/[؀-ۿ]/.test(slip.headline), 'headline must be in Urdu script');
  assert.ok(/[؀-ۿ]/.test(slip.whatToSayAtTheDesk));
  assert.ok(slip.body.includes(CLINIC.clinicName), 'the slip must name the specific clinic');
  assert.ok(slip.body.includes(CLINIC.scheme), 'the slip must name the specific scheme');
  assert.ok(slip.counsellingScript.length > 0, 'the volunteer needs something to read out');
});

test('the English gloss lets a supervisor audit a language they cannot read', async () => {
  const slip = await generateReferral({ ...CLINIC, assessment, language: 'ur' });
  assert.ok(slip.englishGloss.includes(CLINIC.clinicName));
  assert.ok(!/diabet|hypertens/i.test(slip.englishGloss), 'the slip must never name a condition');
});

test('an urgent case tells the person to go today', async () => {
  const urgent = assess({ systolic: 190, diastolic: 118, glucoseMgdl: 340 });
  const slip = await generateReferral({ ...CLINIC, assessment: urgent, language: 'en' });
  assert.match(slip.body, /today/i);
});

test('every supported language produces a slip rather than falling back silently', async () => {
  for (const lang of ['ur', 'kn', 'hi', 'ta', 'en']) {
    const slip = await generateReferral({ ...CLINIC, assessment, language: lang });
    assert.ok(slip.headline, `${lang} produced no headline`);
    assert.ok(slip.body.includes(CLINIC.clinicName), `${lang} lost the clinic name`);
  }
});

/* ---------------------- steps 5 and 6: the agent ---------------------- */

test('step 5: the agent does not repeat itself, it resolves the barrier', async () => {
  const opening = openingMessage('en', 3);
  const thread = [{ from: 'agent', text: opening }];

  // The exact reply from the demo script.
  thread.push({ from: 'patient', text: 'I could not go, the clinic is closed by the time I finish work.' });

  const turn = await followUpTurn({ thread, language: 'en', dayNumber: 3, context: CLINIC });

  assert.equal(turn.simulated, true);
  assert.equal(turn.barrier, 'timing_conflict', 'the agent must identify WHY, not just that they did not go');
  assert.equal(turn.action, 'resolve_barrier');
  assert.ok(turn.reply.includes('Frazer Town'), 'it must surface the evening clinic, not repeat the reminder');
  assert.notEqual(turn.reply, opening, 'repeating the reminder is the failure mode this exists to avoid');
});

test('step 6: confirming attendance and medication completes the referral', async () => {
  const thread = [
    { from: 'agent', text: openingMessage('en', 3) },
    { from: 'patient', text: 'I could not go, the clinic is closed by the time I finish work.' },
    { from: 'agent', text: 'Frazer Town is open later.' },
    { from: 'patient', text: 'Yes I went on Sunday and I collected the medicine.' },
  ];

  const turn = await followUpTurn({ thread, language: 'en', dayNumber: 10, context: CLINIC });
  assert.equal(turn.barrier, 'went');
  assert.equal(turn.medicationCollected, true);
  assert.equal(turn.action, 'mark_complete');
});

test('the agent classifies each barrier in the strategy table to its own remedy', async () => {
  const cases = [
    ['I do not know where it is', 'location_unknown', /Shivajinagar/],
    ['I cannot take a day off from work', 'timing_conflict', /Frazer Town/],
    ['I could not afford it, no money', 'cost_concern', /PM-JAY|not have to pay/],
    ['I am fine, it is not serious', 'low_severity', /family|early/i],
  ];

  for (const [reply, expectedBarrier, expectedRemedy] of cases) {
    const turn = await followUpTurn({
      thread: [{ from: 'agent', text: openingMessage('en', 3) }, { from: 'patient', text: reply }],
      language: 'en', dayNumber: 3, context: CLINIC,
    });
    assert.equal(turn.barrier, expectedBarrier, `"${reply}" misclassified as ${turn.barrier}`);
    assert.match(turn.reply, expectedRemedy, `"${reply}" got the wrong remedy`);
  }
});

test('an unresolved thread escalates to the volunteer rather than nagging', async () => {
  const thread = [
    { from: 'agent', text: openingMessage('en', 3) },
    { from: 'patient', text: 'hmm' },
    { from: 'agent', text: 'Is something making it difficult?' },
    { from: 'patient', text: 'hmm' },
  ];
  const turn = await followUpTurn({ thread, language: 'en', dayNumber: 10, context: CLINIC });
  assert.equal(turn.action, 'escalate_to_volunteer');
  assert.ok(turn.escalationNote.length > 0, 'the volunteer needs the history, not just a ping');
});

test('the agent opens by identifying itself as automated', () => {
  assert.match(openingMessage('en', 3), /automated/i);
});

test('the agent never names a condition in any language', async () => {
  for (const lang of ['en', 'ur', 'kn', 'hi', 'ta']) {
    for (const reply of ['I am fine, not serious', 'no money', 'where is it']) {
      const turn = await followUpTurn({
        thread: [{ from: 'agent', text: openingMessage(lang, 3) }, { from: 'patient', text: reply }],
        language: lang, dayNumber: 3, context: CLINIC,
      });
      assert.ok(turn.reply, `${lang} produced no reply for "${reply}"`);
      assert.ok(!/diabet|hypertens/i.test(turn.reply), `${lang} leaked a condition name`);
    }
  }
});

/* ------------------------ step 7: the ledger moves ------------------------ */

test('step 7: the ledger moves only at the end, not when the slip was issued', () => {
  const record = {
    id: 'demo', screenedAt: new Date().toISOString(),
    assessment,
    referral: { status: 'issued' },
  };

  assert.equal(burdenDeferred(record).inr, 0, 'issuing a slip must move nothing');
  assert.equal(committeeLedger([record]).burdenDeferredInr, 0);
  assert.equal(committeeLedger([record]).referralCompletionRate, 0);

  record.referral.status = 'completed';

  const credited = burdenDeferred(record);
  assert.ok(credited.inr > 0, 'confirmation is what moves the ledger');
  assert.equal(credited.credited, true);

  const l = committeeLedger([record]);
  assert.equal(l.burdenDeferredInr, credited.inr);
  assert.equal(l.referralCompletionRate, 1);
  assert.equal(l.highRiskIdentified, 1);
  assert.ok(l.screeningsEquivalent.min > 0, 'the treasurer sees what the fund did not spend');
});

test('the committee view of a realistic mixed month understates rather than overstates', () => {
  const mk = (fields, status) => ({
    screenedAt: new Date().toISOString(),
    assessment: assess(fields),
    referral: status ? { status } : null,
  });

  const records = [
    mk({ systolic: 116, diastolic: 74, glucoseMgdl: 96 }, null),
    mk({ systolic: 118, diastolic: 76, glucoseMgdl: 104 }, null),
    mk({ systolic: 148, diastolic: 94, glucoseMgdl: 214 }, 'completed'),
    mk({ systolic: 144, diastolic: 92, glucoseMgdl: 152 }, 'issued'),
    mk({ systolic: 182, diastolic: 114, glucoseMgdl: 268 }, 'escalated'),
  ];

  const l = committeeLedger(records);
  assert.equal(l.screenings, 5);
  assert.equal(l.referralsIssued, 3);
  assert.equal(l.referralsCompleted, 1);
  assert.ok(l.referralCompletionRate < 0.5, 'the honest rate is low, and that is the point');

  const optimistic = records
    .filter((r) => r.referral)
    .reduce((s, r) => s + burdenDeferred({ ...r, referral: { status: 'completed' } }).inr, 0);
  assert.ok(l.burdenDeferredInr < optimistic,
    'counting slips issued would report a larger number; the gated figure must be smaller');

  assert.equal(typeof formatInr(l.burdenDeferredInr), 'string');
});
