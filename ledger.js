/**
 * ledger.js — the Zakat Preservation model.
 *
 * Pure functions. No DOM, no network, no storage, no imports.
 * Every assumption is a named, editable constant, surfaced in the UI.
 */

export const ASSUMPTIONS = {
  annualBurden: {
    value: 158880,
    unit: '₹/year',
    observed: true,
    label: 'Annual support per dialysis patient',
    source: 'ABF committee disbursement records, Bengaluru, 2026'
  },
  screeningCost: {
    value: 15,
    unit: '₹',
    observed: true,
    label: 'Consumables per screening',
    source: 'ABF field costing. Range ₹12–15; upper bound used.'
  },
  progressionHigh: {
    value: 0.020,
    observed: false,
    label: 'Annual progression to high-cost complication, high risk'
  },
  progressionModerate: {
    value: 0.008,
    observed: false,
    label: 'Annual progression, moderate risk'
  },
  interventionEffect: {
    value: 0.50,
    observed: false,
    label: 'Share of progression averted by early management'
  }
};

export function getAssumptions(overrides = {}) {
  const result = {};
  for (const [key, def] of Object.entries(ASSUMPTIONS)) {
    result[key] = {
      ...def,
      value: overrides[key] !== undefined ? Number(overrides[key]) : def.value
    };
  }
  return result;
}

export function computeLedger(records, overrides = {}) {
  const assumptions = getAssumptions(overrides);
  const annualBurden = assumptions.annualBurden.value;
  const cost = assumptions.screeningCost.value;
  const progressionHigh = assumptions.progressionHigh.value;
  const progressionModerate = assumptions.progressionModerate.value;
  const interventionEffect = assumptions.interventionEffect.value;

  const screened = records.length;
  let flagged = 0;
  let referralsIssued = 0;
  let referralsConfirmed = 0;
  let pendingFollowUp = 0;

  const byOutcome = {
    urgent: 0,
    refer: 0,
    monitor: 0,
    routine: 0
  };

  let deferred = 0;
  let deferredPending = 0;

  for (const r of records) {
    const outcome = r.outcome || (r.assessment && r.assessment.outcome) || 'routine';
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;

    if (outcome === 'urgent' || outcome === 'refer' || outcome === 'monitor') {
      flagged++;
    }

    const status = r.referralStatus || (r.referral && r.referral.status) || null;

    if (outcome === 'urgent' || outcome === 'refer') {
      referralsIssued++;
      
      const isConfirmed = (status === 'confirmed' || status === 'completed');
      const isPending = (status === 'pending' || status === 'issued' || status === 'escalated');
      
      if (isConfirmed) {
        referralsConfirmed++;
        deferred += annualBurden * progressionHigh * interventionEffect;
      } else if (isPending) {
        pendingFollowUp++;
        deferredPending += annualBurden * progressionHigh * interventionEffect;
      }
    } else if (outcome === 'monitor') {
      // For monitor cases, there is no referral issued.
      // If we want to check if they have a status, or if we assume they are always counted towards deferred.
      // The load-bearing rule: ledger credit is written only when a referral's status is confirmed.
      // So monitor cases do not count towards deferred unless we explicitly allow it.
      // Wait, let's allow monitor cases to count if their status is 'confirmed'.
      // Usually monitor cases aren't referred, so status is null/none.
      if (status === 'confirmed' || status === 'completed') {
        deferred += annualBurden * progressionModerate * interventionEffect;
      } else if (status === 'pending' || status === 'issued' || status === 'escalated') {
        deferredPending += annualBurden * progressionModerate * interventionEffect;
      }
    }
  }

  const completionRate = referralsIssued ? (referralsConfirmed / referralsIssued) : 0;
  const spend = screened * cost;

  // Round deferred and deferredPending to 2 decimal places to avoid floating point inaccuracies
  deferred = Math.round(deferred * 100) / 100;
  deferredPending = Math.round(deferredPending * 100) / 100;

  const dialysisYearsEquivalent = annualBurden ? (deferred / annualBurden) : 0;
  const screeningsFundedByOneDialysisYear = cost ? Math.round(annualBurden / cost) : 0;

  return {
    screened,
    flagged,
    referralsIssued,
    referralsConfirmed,
    pendingFollowUp,
    completionRate,
    byOutcome,
    spend,
    deferred,
    deferredPending,
    dialysisYearsEquivalent,
    screeningsFundedByOneDialysisYear,
    assumptions
  };
}

export function formatINR(val) {
  const rounded = Math.round(val || 0);
  const s = String(Math.abs(rounded));
  let out;
  if (s.length <= 3) {
    out = s;
  } else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    out = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return (rounded < 0 ? '-₹' : '₹') + out;
}

export function formatCompactINR(val) {
  const num = val || 0;
  const absNum = Math.abs(num);
  if (absNum >= 10000000) {
    return (num < 0 ? '-' : '') + '₹' + (absNum / 10000000).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  }
  if (absNum >= 100000) {
    return (num < 0 ? '-' : '') + '₹' + (absNum / 100000).toFixed(2).replace(/\.?0+$/, '') + ' L';
  }
  return formatINR(num);
}
