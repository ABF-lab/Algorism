/**
 * clinical.js — screening arithmetic and risk stratification.
 *
 * Pure functions. No DOM, no network, no storage, no imports.
 * Calibrated to published ICMR / MDRF and IDF-DAR thresholds.
 *
 * This is screening, NOT diagnosis.
 */

// BMI — Asian Indian (ICMR) cut-offs
export function calcBMI(heightCm, weightKg) {
  if (!heightCm || !weightKg || heightCm <= 0 || weightKg <= 0) return null;
  const heightM = heightCm / 100;
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10;
}

export function classifyBMI(bmi) {
  if (bmi === null || bmi === undefined) return null;
  const note = "Asian Indian cut-offs (ICMR). Lower than standard WHO thresholds.";
  if (bmi < 18.5) {
    return { value: bmi, key: 'underweight', label: 'Underweight', tone: 'warn', note };
  } else if (bmi < 23.0) {
    return { value: bmi, key: 'normal', label: 'Normal', tone: 'ok', note };
  } else if (bmi < 25.0) {
    return { value: bmi, key: 'overweight', label: 'Overweight', tone: 'warn', note };
  } else {
    return { value: bmi, key: 'obese', label: 'Obese', tone: 'high', note };
  }
}

// Blood pressure — ACC/AHA categories
export function classifyBP(systolic, diastolic) {
  if (!systolic || !diastolic) return null;
  if (systolic >= 180 || diastolic >= 120) {
    return {
      systolic,
      diastolic,
      key: 'crisis',
      label: 'Crisis',
      tone: 'critical',
      action: 'Same-day medical attention. Do not send home with a routine slip.'
    };
  }
  if (systolic >= 140 || diastolic >= 90) {
    return {
      systolic,
      diastolic,
      key: 'stage2',
      label: 'Stage 2 Hypertension',
      tone: 'high',
      action: 'Clinician review needed.'
    };
  }
  if (systolic >= 130 || diastolic >= 80) {
    return {
      systolic,
      diastolic,
      key: 'stage1',
      label: 'Stage 1 Hypertension',
      tone: 'warn',
      action: 'Repeat reading and clinician review.'
    };
  }
  if (systolic >= 120) {
    return {
      systolic,
      diastolic,
      key: 'elevated',
      label: 'Elevated Blood Pressure',
      tone: 'warn',
      action: 'Recheck in 3 months.'
    };
  }
  return {
    systolic,
    diastolic,
    key: 'normal',
    label: 'Normal',
    tone: 'ok',
    action: 'Routine recheck in 12 months.'
  };
}

// Capillary glucose (mg/dL)
export function classifyGlucose(mgdl, fasting) {
  if (!mgdl) return null;
  const note = "Capillary screening value. Venous confirmation required before any diagnosis.";
  if (fasting) {
    if (mgdl >= 126) {
      return { value: mgdl, fasting: true, key: 'diabetes', label: 'Diabetes range (Fasting)', tone: 'high', note };
    } else if (mgdl >= 100) {
      return { value: mgdl, fasting: true, key: 'impaired', label: 'Impaired Fasting Glucose', tone: 'warn', note };
    } else {
      return { value: mgdl, fasting: true, key: 'normal', label: 'Normal (Fasting)', tone: 'ok', note };
    }
  } else {
    if (mgdl >= 200) {
      return { value: mgdl, fasting: false, key: 'diabetes', label: 'Diabetes range (Random)', tone: 'high', note };
    } else if (mgdl >= 140) {
      return { value: mgdl, fasting: false, key: 'raised', label: 'Raised Blood Glucose', tone: 'warn', note };
    } else {
      return { value: mgdl, fasting: false, key: 'normal', label: 'Normal (Random)', tone: 'ok', note };
    }
  }
}

// IDRS — Indian Diabetes Risk Score
export function calcIDRS({ age, sex, waistCm, bmi, activity, family }) {
  if (age === undefined || age === null) return null;

  let agePoints = 0;
  if (age >= 50) agePoints = 30;
  else if (age >= 35) agePoints = 20;

  let waistPoints = 0;
  let waistProxied = false;

  if (waistCm !== undefined && waistCm !== null && waistCm > 0) {
    const higher = sex === 'female' ? 80 : 90;
    const lower = sex === 'female' ? 70 : 80;
    if (waistCm >= higher) waistPoints = 20;
    else if (waistCm >= lower) waistPoints = 10;
  } else if (bmi !== undefined && bmi !== null) {
    waistProxied = true;
    if (bmi >= 25) waistPoints = 20;
    else if (bmi >= 23) waistPoints = 10;
  } else {
    waistPoints = 0;
  }

  const act = activity || 'mild';
  let actPoints = 20;
  if (act === 'vigorous') actPoints = 0;
  else if (act === 'moderate') actPoints = 10;
  else if (act === 'mild') actPoints = 20;
  else if (act === 'sedentary') actPoints = 30;

  const fam = family || 'none';
  let famPoints = 0;
  if (fam === 'both' || fam === 'both_parents') famPoints = 20;
  else if (fam === 'one' || fam === 'one_parent') famPoints = 10;

  const total = agePoints + waistPoints + actPoints + famPoints;

  let band = 'low';
  let label = 'Low risk';
  let tone = 'ok';

  if (total >= 60) {
    band = 'high';
    label = 'High risk';
    tone = 'high';
  } else if (total >= 30) {
    band = 'moderate';
    label = 'Moderate risk';
    tone = 'warn';
  }

  const components = [
    { name: 'Age', points: agePoints, max: 30 },
    { name: 'Waist Circumference', points: waistPoints, max: 20, proxied: waistProxied },
    { name: 'Physical Activity', points: actPoints, max: 30 },
    { name: 'Family History', points: famPoints, max: 20 }
  ];

  return {
    total,
    band,
    label,
    tone,
    proxied: waistProxied,
    components
  };
}

export const OUTCOME_META = {
  urgent: {
    title: "Needs care today",
    tone: "critical",
    summary: "Same-day medical attention required.",
    followUp: true,
    referral: true
  },
  refer: {
    title: "Refer to clinician",
    tone: "high",
    summary: "Please consult a healthcare professional.",
    followUp: true,
    referral: true
  },
  monitor: {
    title: "Monitor",
    tone: "warn",
    summary: "Keep monitoring your health with regular check-ups.",
    followUp: false,
    referral: false
  },
  routine: {
    title: "Routine recheck",
    tone: "ok",
    summary: "Continue routine checks.",
    followUp: false,
    referral: false
  }
};

// Overall outcome
export function assess(record) {
  const bmiVal = calcBMI(record.heightCm, record.weightKg);
  const bmiObj = classifyBMI(bmiVal);
  const bpObj = classifyBP(record.systolic, record.diastolic);
  
  const glucoseMgdl = record.glucoseMgdl || record.bloodSugar;
  const isFasting = record.glucoseType === 'fasting' || record.glucoseFasting === true;
  const glucoseObj = classifyGlucose(glucoseMgdl, isFasting);
  
  const idrsObj = calcIDRS({
    age: record.age,
    sex: record.sex,
    waistCm: record.waistCm,
    bmi: bmiVal,
    activity: record.activity,
    family: record.family || record.familyHistory
  });
  
  const reasons = [];
  let outcome = 'routine';
  
  const setOutcome = (newOutcome, reason) => {
    reasons.push(reason);
    const ranks = { routine: 0, monitor: 1, refer: 2, urgent: 3 };
    if (ranks[newOutcome] > ranks[outcome]) {
      outcome = newOutcome;
    }
  };
  
  // 1. BP check
  if (bpObj) {
    if (bpObj.key === 'crisis') {
      setOutcome('urgent', `Blood pressure crisis: ${bpObj.systolic}/${bpObj.diastolic} mmHg`);
    } else if (bpObj.key === 'stage2') {
      setOutcome('refer', `Blood pressure Stage 2: ${bpObj.systolic}/${bpObj.diastolic} mmHg`);
    } else if (bpObj.key === 'stage1' || bpObj.key === 'elevated') {
      setOutcome('monitor', `Blood pressure: ${bpObj.systolic}/${bpObj.diastolic} mmHg (${bpObj.label})`);
    }
  }
  
  // 2. Glucose check
  if (glucoseObj) {
    if (glucoseObj.key === 'diabetes') {
      setOutcome('refer', `Blood glucose in diabetes range: ${glucoseObj.value} mg/dL (${glucoseObj.fasting ? 'Fasting' : 'Random'})`);
    } else if (glucoseObj.key === 'impaired' || glucoseObj.key === 'raised') {
      setOutcome('monitor', `Impaired/raised blood glucose: ${glucoseObj.value} mg/dL (${glucoseObj.fasting ? 'Fasting' : 'Random'})`);
    }
  }
  
  // 3. IDRS check
  if (idrsObj) {
    if (idrsObj.band === 'high') {
      setOutcome('refer', `High Diabetes Risk Score (IDRS: ${idrsObj.total})`);
    } else if (idrsObj.band === 'moderate') {
      setOutcome('monitor', `Moderate Diabetes Risk Score (IDRS: ${idrsObj.total})`);
    }
  }
  
  // 4. BMI check
  if (bmiObj) {
    if (bmiObj.key === 'obese') {
      setOutcome('monitor', `Obese BMI: ${bmiObj.value} kg/m²`);
    }
  }
  
  // 5. Already diagnosed
  if (record.knownDiabetic || record.knownHypertensive || record.diabetic || record.hypertensive) {
    setOutcome('monitor', 'Previously diagnosed diabetes or hypertension');
  }
  
  const meta = OUTCOME_META[outcome];
  const monitoringMonths = outcome === 'urgent' ? 1 : outcome === 'refer' ? 3 : outcome === 'monitor' ? 6 : 12;
  
  const idrsCompatible = idrsObj ? {
    ...idrsObj,
    score: idrsObj.total,
    breakdown: idrsObj.components.map(c => ({
      factor: c.name,
      detail: c.proxied ? 'Proxied by BMI' : '',
      points: c.points
    }))
  } : null;

  const findings = {
    bmi: bmiObj,
    bp: bpObj,
    glucose: glucoseObj,
    idrs: idrsCompatible
  };

  return {
    bmi: bmiObj,
    bp: bpObj,
    glucose: glucoseObj,
    idrs: idrsCompatible,
    findings,
    outcome,
    action: outcome === 'refer' ? 'referral' : outcome, // map refer to referral for old code
    monitoringMonths,
    reasons,
    ...meta
  };
}

export function patientSafeSummary(assessment) {
  const outcome = assessment.outcome || assessment.action;
  if (outcome === 'urgent') {
    return 'Some of today’s readings are higher than expected. Please see a doctor today.';
  } else if (outcome === 'refer' || outcome === 'referral') {
    return 'Some of today’s readings are higher than expected. Please see a doctor about this.';
  } else {
    return `Today’s readings look as expected. Please come for another check in ${assessment.monitoringMonths || 12} months.`;
  }
}

// Ramadan fasting risk
export function fastingRisk(record, assessment) {
  const isDiabetic = record.knownDiabetic || record.diabetic || 
                     (assessment && assessment.glucose && assessment.glucose.key === 'diabetes');
                     
  if (!isDiabetic) return null;
  
  const factors = [];
  let level = 'moderate';
  let label = 'Moderate Risk';
  let tone = 'warn';
  let guidance = 'Fasting may be possible with planning, hydration, and monitoring. Consult a doctor.';
  
  const glucoseVal = record.glucoseMgdl || record.bloodSugar || 0;
  
  if (record.insulin) {
    factors.push('Using insulin');
    level = 'veryhigh';
  }
  if (glucoseVal >= 300) {
    factors.push('Glucose ≥ 300 mg/dL');
    level = 'veryhigh';
  }
  if (record.hypoHistory || record.hypoglycemiaHistory) {
    factors.push('History of severe hypoglycemia');
    level = 'veryhigh';
  }
  if (record.ckd || record.chronicKidneyDisease) {
    factors.push('Chronic Kidney Disease (CKD)');
    level = 'veryhigh';
  }
  
  if (level !== 'veryhigh') {
    if (record.sulfonylurea) {
      factors.push('Using sulfonylurea');
      level = 'high';
    }
    if (record.age >= 70) {
      factors.push('Age ≥ 70');
      level = 'high';
    }
  }
  
  if (level === 'veryhigh') {
    label = 'Very High Risk';
    tone = 'high';
    guidance = 'Fasting is not recommended. Medical exemption highly advised. Please consult a doctor.';
  } else if (level === 'high') {
    label = 'High Risk';
    tone = 'high';
    guidance = 'Fasting is generally not recommended. If attempted, strict medical supervision is required.';
  }
  
  const disclaimer = 'Clinical guidance only, grounded in IDF-DAR; religious rulings on exemption rest with a qualified scholar, not the app.';
  
  return {
    level,
    factors,
    label,
    tone,
    guidance,
    disclaimer
  };
}
