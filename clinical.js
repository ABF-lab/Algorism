/**
 * clinical.js — screening arithmetic and risk stratification.
 *
 * Pure functions. No DOM, no network, no storage, no imports.
 * This file and ledger.js are the two a clinician or treasurer would want to
 * audit, so they are readable without understanding the rest of the app.
 *
 * DAY-ONE HONESTY: this is a deterministic rules engine calibrated to published
 * ICMR / MDRF thresholds. It is not a trained model and must not be described as
 * one. Every threshold below is a named constant so it can be checked against
 * the source guideline line by line.
 *
 * SCOPE: this is screening, not diagnosis. Nothing here names a condition to a
 * patient. Clinician-facing band labels are for the record and the referral
 * slip; patient-facing text always routes to "see a doctor about this".
 */

/* ------------------------------------------------------------------ *
 * Indian Diabetes Risk Score (IDRS)
 * Madras Diabetes Research Foundation. Four inputs, max 100 points.
 * Validated for the Indian population; this is why it is used here in
 * preference to risk scores derived from European cohorts.
 * ------------------------------------------------------------------ */

export const IDRS_AGE_POINTS = [
  { maxExclusive: 35, points: 0, label: 'under 35' },
  { maxExclusive: 50, points: 20, label: '35 to 49' },
  { maxExclusive: Infinity, points: 30, label: '50 and over' },
];

/** Waist thresholds are sex-specific in the published score. Centimetres. */
export const IDRS_WAIST_POINTS = {
  male: [
    { maxExclusive: 90, points: 0, label: 'under 90cm' },
    { maxExclusive: 100, points: 10, label: '90 to 99cm' },
    { maxExclusive: Infinity, points: 20, label: '100cm and over' },
  ],
  female: [
    { maxExclusive: 80, points: 0, label: 'under 80cm' },
    { maxExclusive: 90, points: 10, label: '80 to 89cm' },
    { maxExclusive: Infinity, points: 20, label: '90cm and over' },
  ],
};

export const IDRS_ACTIVITY_POINTS = {
  vigorous: 0,   // strenuous work or regular vigorous exercise
  moderate: 10,
  mild: 20,
  sedentary: 30,
};

export const IDRS_FAMILY_HISTORY_POINTS = {
  none: 0,
  one_parent: 10,
  both_parents: 20,
};

/** Published IDRS bands. 30–59 is a single moderate band. */
export const IDRS_BANDS = [
  { maxExclusive: 30, band: 'low', label: 'Low risk' },
  { maxExclusive: 60, band: 'moderate', label: 'Moderate risk' },
  { maxExclusive: Infinity, band: 'high', label: 'High risk' },
];

/**
 * @param {{age:number, sex:'male'|'female', waistCm:number,
 *          activity:keyof typeof IDRS_ACTIVITY_POINTS,
 *          familyHistory:keyof typeof IDRS_FAMILY_HISTORY_POINTS}} input
 * @returns {{score:number, band:'low'|'moderate'|'high', label:string,
 *            breakdown:Array<{factor:string, detail:string, points:number}>}}
 */
export function idrs(input) {
  const { age, sex, waistCm, activity, familyHistory } = input;

  const ageRow = IDRS_AGE_POINTS.find((r) => age < r.maxExclusive);
  const waistTable = IDRS_WAIST_POINTS[sex] || IDRS_WAIST_POINTS.female;
  const waistRow = waistTable.find((r) => waistCm < r.maxExclusive);

  const activityPoints = IDRS_ACTIVITY_POINTS[activity];
  const familyPoints = IDRS_FAMILY_HISTORY_POINTS[familyHistory];

  if (activityPoints === undefined) throw new Error(`Unknown activity level: ${activity}`);
  if (familyPoints === undefined) throw new Error(`Unknown family history: ${familyHistory}`);

  const breakdown = [
    { factor: 'Age', detail: ageRow.label, points: ageRow.points },
    { factor: 'Waist', detail: waistRow.label, points: waistRow.points },
    { factor: 'Physical activity', detail: activity, points: activityPoints },
    { factor: 'Family history', detail: familyHistory.replace(/_/g, ' '), points: familyPoints },
  ];

  const score = breakdown.reduce((sum, row) => sum + row.points, 0);
  const bandRow = IDRS_BANDS.find((b) => score < b.maxExclusive);

  return { score, band: bandRow.band, label: bandRow.label, breakdown };
}

/* ------------------------------------------------------------------ *
 * BMI — Asian Indian cutoffs
 * ICMR / WHO Asia-Pacific, NOT the WHO international cutoffs. Risk begins at a
 * lower BMI in South Asian populations, so using 25/30 here would under-refer
 * exactly the people this programme exists to find.
 * ------------------------------------------------------------------ */

export const BMI_BANDS_ASIAN_INDIAN = [
  { maxExclusive: 18.5, band: 'underweight', label: 'Underweight' },
  { maxExclusive: 23, band: 'normal', label: 'Normal' },
  { maxExclusive: 25, band: 'overweight', label: 'Overweight' },
  { maxExclusive: Infinity, band: 'obese', label: 'Obese' },
];

/**
 * @param {number} weightKg
 * @param {number} heightCm
 * @returns {{value:number, band:string, label:string}|null} null if inputs unusable
 */
export function bmi(weightKg, heightCm) {
  if (!weightKg || !heightCm || heightCm <= 0) return null;
  const metres = heightCm / 100;
  const value = round1(weightKg / (metres * metres));
  const row = BMI_BANDS_ASIAN_INDIAN.find((b) => value < b.maxExclusive);
  return { value, band: row.band, label: row.label };
}

/* ------------------------------------------------------------------ *
 * Blood pressure
 * Hypertension threshold 140/90, per ICMR guidance for India, rather than the
 * 2017 ACC/AHA 130/80. Ordered most-severe-first: a reading is graded by
 * whichever of systolic or diastolic is worse.
 * ------------------------------------------------------------------ */

export const BP_CRISIS_SYSTOLIC = 180;
export const BP_CRISIS_DIASTOLIC = 110;

export const BP_BANDS = [
  { band: 'crisis', label: 'Very high', systolicMin: BP_CRISIS_SYSTOLIC, diastolicMin: BP_CRISIS_DIASTOLIC },
  { band: 'stage2', label: 'High, stage 2', systolicMin: 160, diastolicMin: 100 },
  { band: 'stage1', label: 'High, stage 1', systolicMin: 140, diastolicMin: 90 },
  { band: 'elevated', label: 'Slightly raised', systolicMin: 120, diastolicMin: 80 },
  { band: 'normal', label: 'Normal', systolicMin: 0, diastolicMin: 0 },
];

/**
 * @param {number} systolic mmHg
 * @param {number} diastolic mmHg
 */
export function bloodPressure(systolic, diastolic) {
  if (!systolic || !diastolic) return null;
  const row = BP_BANDS.find((b) => systolic >= b.systolicMin || diastolic >= b.diastolicMin);
  return { systolic, diastolic, band: row.band, label: row.label };
}

/* ------------------------------------------------------------------ *
 * Blood glucose
 * ICMR / ADA thresholds. Fasting and random are graded separately because a
 * volunteer in the field will usually only have one of them.
 * ------------------------------------------------------------------ */

export const GLUCOSE_URGENT_FASTING = 250;  // mg/dL
export const GLUCOSE_URGENT_RANDOM = 300;   // mg/dL

export const GLUCOSE_BANDS = {
  fasting: [
    { maxExclusive: 100, band: 'normal', label: 'Normal' },
    { maxExclusive: 126, band: 'impaired', label: 'Above normal range' },
    { maxExclusive: Infinity, band: 'high', label: 'Well above normal range' },
  ],
  random: [
    { maxExclusive: 140, band: 'normal', label: 'Normal' },
    { maxExclusive: 200, band: 'impaired', label: 'Above normal range' },
    { maxExclusive: Infinity, band: 'high', label: 'Well above normal range' },
  ],
};

/**
 * @param {number} mgdl
 * @param {'fasting'|'random'} type
 */
export function glucose(mgdl, type = 'random') {
  if (!mgdl) return null;
  const table = GLUCOSE_BANDS[type];
  if (!table) throw new Error(`Unknown glucose type: ${type}`);
  const row = table.find((b) => mgdl < b.maxExclusive);
  const urgentAt = type === 'fasting' ? GLUCOSE_URGENT_FASTING : GLUCOSE_URGENT_RANDOM;
  return { mgdl, type, band: row.band, label: row.label, urgent: mgdl >= urgentAt };
}

/* ------------------------------------------------------------------ *
 * Overall screening outcome
 * Combines the above into one of three actions. This is the only function the
 * UI needs, and it is deliberately conservative: any single urgent finding
 * escalates the whole record.
 * ------------------------------------------------------------------ */

export const OUTCOMES = {
  routine: {
    action: 'routine',
    label: 'No referral needed',
    /** Months until the person should be screened again. */
    monitoringMonths: 12,
  },
  referral: {
    action: 'referral',
    label: 'Refer to clinic',
    monitoringMonths: 3,
  },
  urgent: {
    action: 'urgent',
    label: 'Refer today',
    monitoringMonths: 1,
  },
};

/**
 * Grade a complete screening record.
 *
 * @param {object} r screening record
 * @returns {{action:'routine'|'referral'|'urgent', label:string,
 *            monitoringMonths:number, reasons:string[], findings:object}}
 */
export function assess(r) {
  const findings = {
    idrs: (r.age && r.sex && r.waistCm) ? idrs({
      age: r.age,
      sex: r.sex,
      waistCm: r.waistCm,
      activity: r.activity || 'sedentary',
      familyHistory: r.familyHistory || 'none',
    }) : null,
    bmi: bmi(r.weightKg, r.heightCm),
    bp: bloodPressure(r.systolic, r.diastolic),
    glucose: glucose(r.glucoseMgdl, r.glucoseType || 'random'),
  };

  const reasons = [];
  let action = 'routine';
  const escalate = (to, why) => {
    reasons.push(why);
    if (to === 'urgent') action = 'urgent';
    else if (to === 'referral' && action !== 'urgent') action = 'referral';
  };

  if (findings.bp) {
    if (findings.bp.band === 'crisis') {
      escalate('urgent', `Blood pressure ${findings.bp.systolic}/${findings.bp.diastolic}, at or above ${BP_CRISIS_SYSTOLIC}/${BP_CRISIS_DIASTOLIC}`);
    } else if (findings.bp.band === 'stage1' || findings.bp.band === 'stage2') {
      escalate('referral', `Blood pressure ${findings.bp.systolic}/${findings.bp.diastolic}, at or above 140/90`);
    }
  }

  if (findings.glucose) {
    if (findings.glucose.urgent) {
      escalate('urgent', `${cap(findings.glucose.type)} blood sugar ${findings.glucose.mgdl} mg/dL, markedly raised`);
    } else if (findings.glucose.band === 'high') {
      escalate('referral', `${cap(findings.glucose.type)} blood sugar ${findings.glucose.mgdl} mg/dL, above the referral threshold`);
    } else if (findings.glucose.band === 'impaired') {
      escalate('referral', `${cap(findings.glucose.type)} blood sugar ${findings.glucose.mgdl} mg/dL, in the intermediate range`);
    }
  }

  if (findings.idrs && findings.idrs.band === 'high') {
    escalate('referral', `IDRS ${findings.idrs.score} of 100, high risk band`);
  }

  if (findings.bmi && findings.bmi.band === 'obese' && action === 'routine') {
    // On its own, obesity is a monitoring trigger rather than a referral.
    reasons.push(`BMI ${findings.bmi.value}, obese by Asian Indian cutoffs`);
  }

  const outcome = OUTCOMES[action];
  return {
    action,
    label: outcome.label,
    monitoringMonths: outcome.monitoringMonths,
    reasons,
    findings,
  };
}

/**
 * Patient-facing summary. Never names a condition, per the consent and scope
 * rules in the strategy document. The referral slip generated by the language
 * model uses this framing too.
 */
export function patientSafeSummary(assessment) {
  switch (assessment.action) {
    case 'urgent':
      return 'Some of today’s readings are higher than expected. Please see a doctor today.';
    case 'referral':
      return 'Some of today’s readings are higher than expected. Please see a doctor about this.';
    default:
      return `Today’s readings look as expected. Please come for another check in ${assessment.monitoringMonths} months.`;
  }
}

/* ---------------------------- helpers ---------------------------- */

function round1(n) {
  return Math.round(n * 10) / 10;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
