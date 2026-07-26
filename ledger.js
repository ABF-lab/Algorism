/**
 * ledger.js — the Zakat Preservation model.
 *
 * Pure functions. No DOM, no network, no storage, no imports.
 *
 * Every assumption in this file is a named, exported constant with its
 * provenance recorded. A committee treasurer should be able to read this file
 * alone, disagree with a number, change it, and understand exactly what moved.
 *
 * TWO RULES THIS FILE ENFORCES
 *
 *   1. Credit is written only when a referral is CONFIRMED COMPLETE by the
 *      follow-up agent. A slip handed to someone who may have thrown it away
 *      is not an outcome. This produces a smaller number than counting slips
 *      issued, and it is the only defensible one.
 *
 *   2. Every figure is a PROJECTION and is labelled as one wherever it is
 *      shown. Understating is safer than overstating, so the model is tuned
 *      to under-claim: see CONSERVATISM_FACTOR.
 */

/* ------------------------------------------------------------------ *
 * Observed figures — ABF field-costed, Bengaluru, 2026
 * These are the strongest numbers in the model precisely because they were
 * measured by ABF rather than cited from literature. Label them that way.
 * ------------------------------------------------------------------ */

/** Annual committee support for one member on maintenance dialysis. */
export const DIALYSIS_ANNUAL_SUPPORT_INR = 158880;

/** Consumables per screening. Range, not a point estimate. */
export const SCREENING_COST_MIN_INR = 12;
export const SCREENING_COST_MAX_INR = 15;

/** One-off diagnostic kit per centre. */
export const KIT_COST_INR = 5000;

/** Pre-identified mosques and community centres in the ABF network. */
export const NETWORK_CENTRES = 100;

export const OBSERVED_FIGURES_NOTE =
  'ABF field-costed, Bengaluru, 2026. Observed, not cited.';

/* ------------------------------------------------------------------ *
 * Projected complication pathways
 * These are NOT ABF-observed. They are the modelled part, and the part most
 * open to challenge. Each pathway states the annual community care burden if
 * the trajectory is reached, how many years the committee typically carries
 * it, and the baseline probability of reaching it from an untreated high-risk
 * state over the modelling horizon.
 *
 * PHASE 1 EXISTS TO TEST THESE NUMBERS against real disbursement records. If
 * the ledger does not hold up, these constants get corrected before scale,
 * not after.
 * ------------------------------------------------------------------ */

export const MODELLING_HORIZON_YEARS = 10;

export const PATHWAYS = {
  renal: {
    label: 'Maintenance dialysis',
    annualBurdenInr: DIALYSIS_ANNUAL_SUPPORT_INR,
    yearsOfBurden: 3,
    baselineProbability: 0.05,
    drivenBy: ['diabetes', 'hypertension'],
  },
  cardiac: {
    label: 'Cardiac event and post-event care',
    annualBurdenInr: 90000,
    yearsOfBurden: 2,
    baselineProbability: 0.08,
    drivenBy: ['hypertension'],
  },
  stroke: {
    label: 'Stroke and rehabilitation',
    annualBurdenInr: 110000,
    yearsOfBurden: 3,
    baselineProbability: 0.04,
    drivenBy: ['hypertension'],
  },
  foot: {
    label: 'Diabetic foot, ulceration to amputation',
    annualBurdenInr: 60000,
    yearsOfBurden: 2,
    baselineProbability: 0.05,
    drivenBy: ['diabetes'],
  },
  vision: {
    label: 'Retinopathy and vision loss',
    annualBurdenInr: 35000,
    yearsOfBurden: 4,
    baselineProbability: 0.06,
    drivenBy: ['diabetes'],
  },
};

/**
 * Proportion of the baseline probability averted by entering care early.
 * Deliberately modest. Early detection does not eliminate a complication
 * pathway, it defers and reduces it.
 */
export const RISK_REDUCTION_FROM_EARLY_CARE = 0.30;

/**
 * Applied to every projection. The model is tuned to under-claim: halving the
 * output costs nothing in credibility and buys a great deal.
 */
export const CONSERVATISM_FACTOR = 0.5;

/**
 * How much of the modelled benefit each screening outcome is credited.
 * A moderate-risk person confirmed in care is worth real prevention, but less
 * than a high-risk one, and this must be reflected rather than averaged away.
 */
export const OUTCOME_WEIGHTS = {
  urgent: 1.0,
  referral: 0.6,
  routine: 0,
};

/* ------------------------------------------------------------------ *
 * Per-record projection
 * ------------------------------------------------------------------ */

/**
 * Which pathways apply, given what the screening actually found.
 * A person flagged only on blood pressure is not credited against diabetic
 * foot ulceration.
 */
export function pathwaysFor(record) {
  const drivers = new Set();
  const f = record.assessment && record.assessment.findings;
  if (!f) return [];

  if (f.glucose && (f.glucose.band === 'impaired' || f.glucose.band === 'high')) drivers.add('diabetes');
  if (f.idrs && f.idrs.band === 'high') drivers.add('diabetes');
  if (f.bp && ['stage1', 'stage2', 'crisis'].includes(f.bp.band)) drivers.add('hypertension');

  return Object.entries(PATHWAYS)
    .filter(([, p]) => p.drivenBy.some((d) => drivers.has(d)))
    .map(([key, p]) => ({ key, ...p }));
}

/**
 * Projected community care burden deferred by one screening.
 *
 * Returns zero unless the referral is confirmed complete. This is the gate
 * that makes the whole ledger honest.
 *
 * @param {object} record a screening record
 * @returns {{inr:number, credited:boolean, reason:string,
 *            breakdown:Array<{pathway:string, inr:number}>, isProjection:true}}
 */
export function burdenDeferred(record) {
  const nil = (reason) => ({ inr: 0, credited: false, reason, breakdown: [], isProjection: true });

  if (!record.assessment) return nil('No assessment on record');

  const weight = OUTCOME_WEIGHTS[record.assessment.action] ?? 0;
  if (weight === 0) return nil('No referral was required');

  const status = record.referral && record.referral.status;
  if (status !== 'completed') {
    return nil(
      status === 'issued' ? 'Referral issued but not yet confirmed complete'
        : status === 'escalated' ? 'Escalated to volunteer, not yet confirmed'
        : 'Referral not confirmed complete'
    );
  }

  const breakdown = pathwaysFor(record).map((p) => {
    const averted = p.baselineProbability * RISK_REDUCTION_FROM_EARLY_CARE;
    const fullBurden = p.annualBurdenInr * p.yearsOfBurden;
    const inr = Math.round(fullBurden * averted * weight * CONSERVATISM_FACTOR);
    return { pathway: p.label, inr };
  });

  const inr = breakdown.reduce((sum, b) => sum + b.inr, 0);
  return {
    inr,
    credited: true,
    reason: 'Referral confirmed complete by follow-up agent',
    breakdown,
    isProjection: true,
  };
}

/* ------------------------------------------------------------------ *
 * Committee-level aggregate
 * ------------------------------------------------------------------ */

/**
 * @param {object[]} records
 * @param {{month?:number, year?:number}} [period] omit for all-time
 */
export function committeeLedger(records, period) {
  const inPeriod = period
    ? records.filter((r) => {
        const d = new Date(r.screenedAt);
        return d.getMonth() === period.month && d.getFullYear() === period.year;
      })
    : records.slice();

  const referralsIssued = inPeriod.filter(
    (r) => r.assessment && OUTCOME_WEIGHTS[r.assessment.action] > 0
  );
  const referralsCompleted = referralsIssued.filter(
    (r) => r.referral && r.referral.status === 'completed'
  );

  const highRisk = inPeriod.filter(
    (r) => r.assessment && (r.assessment.action === 'urgent' || r.assessment.action === 'referral')
  );

  const credits = inPeriod.map(burdenDeferred).filter((b) => b.credited);
  const burdenDeferredInr = credits.reduce((sum, b) => sum + b.inr, 0);

  const screenings = inPeriod.length;

  return {
    screenings,
    highRiskIdentified: highRisk.length,
    referralsIssued: referralsIssued.length,
    referralsCompleted: referralsCompleted.length,
    /** Confirmed completions over referrals issued. The honest denominator. */
    referralCompletionRate: referralsIssued.length
      ? referralsCompleted.length / referralsIssued.length
      : 0,
    burdenDeferredInr,
    consumablesSpentInr: {
      min: screenings * SCREENING_COST_MIN_INR,
      max: screenings * SCREENING_COST_MAX_INR,
    },
    /** How many further screenings the deferred burden would fund. */
    screeningsEquivalent: screeningsFundedBy(burdenDeferredInr),
    isProjection: true,
  };
}

/**
 * The headline arithmetic from the strategy document: what a given rupee
 * amount buys in screenings.
 */
export function screeningsFundedBy(inr) {
  return {
    min: Math.floor(inr / SCREENING_COST_MAX_INR),
    max: Math.floor(inr / SCREENING_COST_MIN_INR),
  };
}

/**
 * The core comparison, precomputed for the dashboard: one dialysis patient's
 * annual support against the cost of screening the whole network.
 */
export function dialysisComparison() {
  const equivalent = screeningsFundedBy(DIALYSIS_ANNUAL_SUPPORT_INR);
  return {
    annualSupportInr: DIALYSIS_ANNUAL_SUPPORT_INR,
    screeningsEquivalent: equivalent,
    networkCentres: NETWORK_CENTRES,
    perCentre: {
      min: Math.floor(equivalent.min / NETWORK_CENTRES),
      max: Math.floor(equivalent.max / NETWORK_CENTRES),
    },
  };
}

/** Indian digit grouping. ₹1,58,880 rather than ₹158,880. */
export function formatInr(n) {
  const rounded = Math.round(n || 0);
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
