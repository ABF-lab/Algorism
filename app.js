/**
 * app.js — routing, screening flow, camera, follow-up threads, rendering.
 *
 * Everything that touches the DOM lives here. clinical.js and ledger.js stay
 * pure so they can be audited and tested without a browser.
 */

import { assess, patientSafeSummary } from './clinical.js';
import {
  committeeLedger, burdenDeferred, dialysisComparison, formatInr,
  SCREENING_COST_MIN_INR, SCREENING_COST_MAX_INR,
} from './ledger.js';
import {
  readDeviceScreen, generateReferral, followUpTurn, openingMessage,
  getApiKey, setApiKey, hasApiKey, LANGUAGES, BARRIERS,
} from './ai.js';

/* ====================================================================== *
 * Storage
 * localStorage only. Health data collected by volunteers never leaves the
 * handset, so there is no server to breach and no third party in the chain.
 * ====================================================================== */

const STORE = {
  records: 'sehat.records',
  settings: 'sehat.settings',
  draft: 'sehat.draft',
};

const DEFAULT_SETTINGS = {
  centre: '',
  volunteer: '',
  language: 'ur',
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    // Quota exhausted on a low-end device is a real failure mode, not a warning.
    flash('Could not save to this device. Free up space before screening again.', 'warn');
    return false;
  }
}

const getRecords = () => load(STORE.records, []);
const setRecords = (r) => save(STORE.records, r);
const getSettings = () => ({ ...DEFAULT_SETTINGS, ...load(STORE.settings, {}) });
const setSettings = (s) => save(STORE.settings, s);

function upsertRecord(record) {
  const all = getRecords();
  const i = all.findIndex((r) => r.id === record.id);
  if (i >= 0) all[i] = record; else all.unshift(record);
  setRecords(all);
  updateBadge();
  return record;
}

const findRecord = (id) => getRecords().find((r) => r.id === id);

function newId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ====================================================================== *
 * Sample clinic directory
 *
 * PLACEHOLDER DATA. These are illustrative entries so the referral flow is
 * demonstrable. Replace with the real PHC and Namma Clinic list, with verified
 * addresses and opening hours, before any field use. The language model is
 * instructed never to invent a clinic; it only ever repeats what is passed in
 * from here, so the accuracy of this table is the accuracy of the referral.
 * ====================================================================== */

const CLINICS = [
  {
    id: 'nc-shivajinagar',
    name: 'Namma Clinic, Shivajinagar',
    detail: 'Open 9am to 4pm, Monday to Saturday',
    evening: false,
  },
  {
    id: 'nc-frazer-evening',
    name: 'Namma Clinic, Frazer Town',
    detail: 'Open 2pm to 8pm, Monday to Saturday',
    evening: true,
  },
  {
    id: 'phc-tannery',
    name: 'PHC, Tannery Road',
    detail: 'Open 9am to 1pm and 2pm to 4pm, Monday to Saturday',
    evening: false,
  },
  {
    id: 'phc-sunday',
    name: 'Urban PHC, Bharathinagar',
    detail: 'Open 9am to 1pm, includes Sunday morning',
    evening: true,
  },
];

const SCHEMES = [
  'Ayushman Bharat PM-JAY',
  'Arogya Karnataka',
  'State NCD programme, free screening and first-line medication',
];

const eveningClinic = () => CLINICS.find((c) => c.evening) || CLINICS[0];

/* ====================================================================== *
 * Small helpers
 * ====================================================================== */

const $ = (sel) => document.querySelector(sel);
const app = () => $('#app');

/** Escape everything interpolated into HTML. Patient names come from the field. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const RTL = new Set(['ur']);
const dirFor = (lang) => (RTL.has(lang) ? 'rtl' : 'ltr');

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

function flash(message, kind = 'info') {
  const bar = $('#statusbar');
  bar.textContent = message;
  bar.className = 'statusbar' + (kind === 'info' ? ' statusbar--info' : '');
  bar.hidden = false;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { bar.hidden = true; }, 5000);
}

/** One consistent way to show that output did not come from a live model. */
function simNote(result) {
  if (!result || !result.simulated) return '';
  return `<p class="simnote"><strong>Simulated</strong><span>${esc(result.simulationReason || 'No model call was made')}. This output was generated on the device, not by a model.</span></p>`;
}

function badge(action) {
  const label = { routine: 'No referral', referral: 'Refer', urgent: 'Refer today' }[action] || action;
  return `<span class="badge badge--${esc(action)}">${esc(label)}</span>`;
}

function referralBadge(status) {
  if (!status) return '';
  const label = { issued: 'Awaiting confirmation', completed: 'Confirmed in care', escalated: 'Escalated' }[status] || status;
  return `<span class="badge badge--${esc(status)}">${esc(label)}</span>`;
}

/* ====================================================================== *
 * Router
 * ====================================================================== */

const routes = [
  [/^\/$/, renderHome, 'Sehat Ledger'],
  [/^\/screen$/, renderWizard, 'New screening'],
  [/^\/records$/, renderRecords, 'Records'],
  [/^\/record\/(.+)$/, renderRecord, 'Screening'],
  [/^\/followups$/, renderFollowups, 'Follow-up'],
  [/^\/thread\/(.+)$/, renderThread, 'Follow-up'],
  [/^\/ledger$/, renderLedger, 'Zakat Preservation Ledger'],
  [/^\/settings$/, renderSettings, 'Setup'],
];

function currentPath() {
  return (location.hash || '#/').slice(1) || '/';
}

function go(path) {
  location.hash = '#' + path;
}

function router() {
  const path = currentPath();
  for (const [pattern, view, title] of routes) {
    const m = path.match(pattern);
    if (m) {
      $('#title').textContent = title;
      $('#back').hidden = path === '/';
      document.querySelectorAll('.tab').forEach((t) => {
        const active = t.dataset.tab === path || (t.dataset.tab !== '/' && path.startsWith(t.dataset.tab));
        if (active) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
      });
      view(...m.slice(1));
      app().scrollTo?.(0, 0);
      window.scrollTo(0, 0);
      return;
    }
  }
  go('/');
}

/* ====================================================================== *
 * Home
 * ====================================================================== */

function renderHome() {
  const records = getRecords();
  const settings = getSettings();
  const today = records.filter((r) => sameDay(new Date(r.screenedAt), new Date()));
  const needsAction = pendingFollowups().length;

  app().innerHTML = `
    ${!settings.centre ? `
      <div class="card">
        <h2>Set up this device</h2>
        <p class="muted small">Record which centre and volunteer this phone belongs to before screening. It takes a moment and it is what makes the records attributable.</p>
        <a class="btn btn--primary btn--block" href="#/settings">Open setup</a>
      </div>` : ''}

    <div class="card">
      <div class="row">
        <div class="stat"><div class="stat__value">${today.length}</div><div class="stat__label">Screened today</div></div>
        <div class="stat"><div class="stat__value">${records.length}</div><div class="stat__label">Total on device</div></div>
        <div class="stat"><div class="stat__value">${needsAction}</div><div class="stat__label">Need follow-up</div></div>
      </div>
    </div>

    <a class="btn btn--primary btn--block btn--lg" href="#/screen">Start a new screening</a>

    <div class="card" style="margin-top:16px">
      <h3>How this device is working</h3>
      <div class="kv"><span class="kv__k">Connection</span><span class="kv__v">${navigator.onLine ? 'Online' : 'Offline, screening still works'}</span></div>
      <div class="kv"><span class="kv__k">Model calls</span><span class="kv__v">${hasApiKey() ? 'Live' : 'Simulated, no key set'}</span></div>
      <div class="kv"><span class="kv__k">Centre</span><span class="kv__v">${esc(settings.centre || 'Not set')}</span></div>
      <div class="kv"><span class="kv__k">Volunteer</span><span class="kv__v">${esc(settings.volunteer || 'Not set')}</span></div>
    </div>

    <p class="tiny muted center">Screening, not diagnosis. Records stay on this device.</p>
  `;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/* ====================================================================== *
 * Screening wizard
 *
 * Five steps. Consent first, always, before any reading is taken.
 * The draft persists to localStorage so a screen lock does not lose a
 * half-finished screening.
 * ====================================================================== */

const STEPS = ['consent', 'person', 'vitals', 'result', 'referral'];

function getDraft() {
  return load(STORE.draft, null);
}

function setDraft(d) {
  save(STORE.draft, d);
}

function clearDraft() {
  try { localStorage.removeItem(STORE.draft); } catch {}
}

function startDraft() {
  const s = getSettings();
  const d = {
    id: newId(),
    step: 0,
    screenedAt: new Date().toISOString(),
    centre: s.centre,
    volunteer: s.volunteer,
    language: s.language,
    consent: { given: false, followUpOptIn: false, at: null },
    glucoseType: 'random',
    activity: 'sedentary',
    familyHistory: 'none',
    sex: 'male',
  };
  setDraft(d);
  return d;
}

function renderWizard() {
  const d = getDraft() || startDraft();
  const step = STEPS[d.step] || 'consent';

  const dots = STEPS.map((_, i) => `<span class="steps__dot ${i <= d.step ? 'steps__dot--done' : ''}"></span>`).join('');

  app().innerHTML = `<div class="steps">${dots}</div><div id="step"></div>`;

  ({
    consent: stepConsent,
    person: stepPerson,
    vitals: stepVitals,
    result: stepResult,
    referral: stepReferral,
  })[step](d);
}

function advance(d, to) {
  d.step = typeof to === 'number' ? to : d.step + 1;
  setDraft(d);
  renderWizard();
}

/* ---------------------------- step 1: consent ---------------------------- */

const CONSENT_SCRIPT = {
  en: 'We are from the mosque health programme. We would like to check your blood pressure and blood sugar. It takes about five minutes and it is free. This is a check, not a diagnosis, and if anything looks higher than expected we will help you see a doctor. Your details stay on this phone. May we go ahead?',
  ur: 'ہم مسجد کے صحت پروگرام سے ہیں۔ ہم آپ کا بلڈ پریشر اور شوگر دیکھنا چاہتے ہیں۔ اس میں پانچ منٹ لگیں گے اور یہ مفت ہے۔ یہ صرف جانچ ہے، بیماری کی تشخیص نہیں۔ اگر کچھ زیادہ نکلا تو ہم آپ کو ڈاکٹر تک پہنچنے میں مدد کریں گے۔ آپ کی تفصیلات اسی فون میں رہیں گی۔ کیا ہم شروع کریں؟',
  kn: 'ನಾವು ಮಸೀದಿ ಆರೋಗ್ಯ ಕಾರ್ಯಕ್ರಮದಿಂದ ಬಂದಿದ್ದೇವೆ. ನಿಮ್ಮ ರಕ್ತದೊತ್ತಡ ಮತ್ತು ಸಕ್ಕರೆ ಪರೀಕ್ಷಿಸಲು ಬಯಸುತ್ತೇವೆ. ಐದು ನಿಮಿಷ ಸಾಕು, ಇದು ಉಚಿತ. ಇದು ಪರೀಕ್ಷೆ ಮಾತ್ರ, ರೋಗ ನಿರ್ಣಯವಲ್ಲ. ಏನಾದರೂ ಹೆಚ್ಚಿದ್ದರೆ ವೈದ್ಯರನ್ನು ಭೇಟಿಯಾಗಲು ಸಹಾಯ ಮಾಡುತ್ತೇವೆ. ನಿಮ್ಮ ವಿವರಗಳು ಈ ಫೋನಿನಲ್ಲೇ ಇರುತ್ತವೆ. ಮುಂದುವರಿಯಲೇ?',
  hi: 'हम मस्जिद के सेहत कार्यक्रम से हैं। हम आपका ब्लड प्रेशर और शुगर देखना चाहते हैं। इसमें पाँच मिनट लगेंगे और यह मुफ़्त है। यह सिर्फ़ जाँच है, बीमारी की पुष्टि नहीं। अगर कुछ ज़्यादा निकला तो हम आपको डॉक्टर तक पहुँचने में मदद करेंगे। आपकी जानकारी इसी फ़ोन में रहेगी। क्या हम शुरू करें?',
  ta: 'நாங்கள் பள்ளிவாசல் சுகாதாரத் திட்டத்திலிருந்து வந்துள்ளோம். உங்கள் இரத்த அழுத்தம் மற்றும் சர்க்கரையை பரிசோதிக்க விரும்புகிறோம். ஐந்து நிமிடம் ஆகும், இது இலவசம். இது பரிசோதனை மட்டுமே, நோய் கண்டறிதல் அல்ல. ஏதேனும் அதிகமாக இருந்தால் மருத்துவரை அணுக உதவுவோம். உங்கள் விவரங்கள் இந்த ஃபோனிலேயே இருக்கும். தொடரலாமா?',
};

function stepConsent(d) {
  $('#step').innerHTML = `
    <div class="card">
      <h2>Consent</h2>
      <p class="small muted">Read this out in the person's language before taking any reading.</p>
      <div class="field">
        <label for="lang">Language</label>
        <select id="lang">
          ${Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}" ${d.language === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </div>
      <div class="slip" dir="${dirFor(d.language)}" id="consent-script">
        <p class="slip__body">${esc(CONSENT_SCRIPT[d.language] || CONSENT_SCRIPT.en)}</p>
      </div>
    </div>

    <div class="card stack">
      <div class="choices">
        <input type="checkbox" id="c1" ${d.consent.given ? 'checked' : ''}>
        <label for="c1">They agreed to be screened</label>
      </div>
      <div class="choices">
        <input type="checkbox" id="c2" ${d.consent.followUpOptIn ? 'checked' : ''}>
        <label for="c2">They agreed to be contacted for follow-up</label>
      </div>
      <p class="tiny muted">Follow-up consent is separate. Declining it does not affect the screening, and no message is ever sent without it.</p>
    </div>

    <button class="btn btn--primary btn--block btn--lg" id="next" ${d.consent.given ? '' : 'disabled'}>Continue</button>
  `;

  $('#lang').onchange = (e) => {
    d.language = e.target.value;
    setDraft(d);
    renderWizard();
  };
  $('#c1').onchange = (e) => {
    d.consent.given = e.target.checked;
    d.consent.at = e.target.checked ? new Date().toISOString() : null;
    setDraft(d);
    $('#next').disabled = !e.target.checked;
  };
  $('#c2').onchange = (e) => {
    d.consent.followUpOptIn = e.target.checked;
    setDraft(d);
  };
  $('#next').onclick = () => {
    if (!d.consent.given) return;
    advance(d);
  };
}

/* ----------------------------- step 2: person ----------------------------- */

function stepPerson(d) {
  $('#step').innerHTML = `
    <div class="card">
      <h2>About the person</h2>
      <div class="field">
        <label for="name">Name <span class="muted">(optional)</span></label>
        <input id="name" value="${esc(d.name || '')}" autocomplete="off">
      </div>
      <div class="field">
        <label for="phone">Phone ${d.consent.followUpOptIn ? '' : '<span class="muted">(follow-up not consented)</span>'}</label>
        <input id="phone" type="tel" inputmode="numeric" value="${esc(d.phone || '')}" ${d.consent.followUpOptIn ? '' : 'disabled'}>
        <p class="field__hint">Only used by the follow-up agent, and only if they opted in.</p>
      </div>
      <div class="row">
        <div class="field">
          <label for="age">Age</label>
          <input id="age" type="number" inputmode="numeric" min="1" max="120" value="${d.age ?? ''}">
        </div>
        <div class="field">
          <label>Sex</label>
          <div class="choices">
            <input type="radio" name="sex" id="sx-m" value="male" ${d.sex === 'male' ? 'checked' : ''}><label for="sx-m">Male</label>
            <input type="radio" name="sex" id="sx-f" value="female" ${d.sex === 'female' ? 'checked' : ''}><label for="sx-f">Female</label>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="height">Height, cm</label>
          <input id="height" type="number" inputmode="decimal" value="${d.heightCm ?? ''}">
        </div>
        <div class="field">
          <label for="weight">Weight, kg</label>
          <input id="weight" type="number" inputmode="decimal" value="${d.weightKg ?? ''}">
        </div>
        <div class="field">
          <label for="waist">Waist, cm</label>
          <input id="waist" type="number" inputmode="decimal" value="${d.waistCm ?? ''}">
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Risk factors</h3>
      <div class="field">
        <label>Physical activity</label>
        <div class="choices">
          ${[['vigorous', 'Heavy work'], ['moderate', 'Moderate'], ['mild', 'Light'], ['sedentary', 'Mostly sitting']]
            .map(([v, l]) => `<input type="radio" name="act" id="act-${v}" value="${v}" ${d.activity === v ? 'checked' : ''}><label for="act-${v}">${l}</label>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Parents with diabetes</label>
        <div class="choices">
          ${[['none', 'Neither'], ['one_parent', 'One'], ['both_parents', 'Both']]
            .map(([v, l]) => `<input type="radio" name="fam" id="fam-${v}" value="${v}" ${d.familyHistory === v ? 'checked' : ''}><label for="fam-${v}">${l}</label>`).join('')}
        </div>
      </div>
    </div>

    <div class="row">
      <button class="btn btn--ghost" id="back-step">Back</button>
      <button class="btn btn--primary" id="next">Continue</button>
    </div>
  `;

  const sync = () => {
    d.name = $('#name').value.trim();
    d.phone = $('#phone').value.trim();
    d.age = num($('#age').value);
    d.heightCm = num($('#height').value);
    d.weightKg = num($('#weight').value);
    d.waistCm = num($('#waist').value);
    d.sex = document.querySelector('input[name=sex]:checked')?.value || 'male';
    d.activity = document.querySelector('input[name=act]:checked')?.value || 'sedentary';
    d.familyHistory = document.querySelector('input[name=fam]:checked')?.value || 'none';
    setDraft(d);
  };

  $('#step').addEventListener('change', sync);
  $('#back-step').onclick = () => { sync(); advance(d, d.step - 1); };
  $('#next').onclick = () => {
    sync();
    if (!d.age) return flash('Age is needed to calculate the risk score.');
    advance(d);
  };
}

const num = (v) => (v === '' || v == null ? undefined : Number(v));

/* ----------------------------- step 3: vitals ----------------------------- */

function stepVitals(d) {
  $('#step').innerHTML = `
    <div class="card">
      <h2>Blood pressure</h2>
      <button class="btn btn--ghost btn--block" id="scan-bp">Read the monitor with the camera</button>
      <div class="row" style="margin-top:12px">
        <div class="field">
          <label for="sys">Systolic</label>
          <input id="sys" type="number" inputmode="numeric" value="${d.systolic ?? ''}">
        </div>
        <div class="field">
          <label for="dia">Diastolic</label>
          <input id="dia" type="number" inputmode="numeric" value="${d.diastolic ?? ''}">
        </div>
        <div class="field">
          <label for="pul">Pulse</label>
          <input id="pul" type="number" inputmode="numeric" value="${d.pulse ?? ''}">
        </div>
      </div>
      <div id="bp-note"></div>
    </div>

    <div class="card">
      <h2>Blood sugar</h2>
      <button class="btn btn--ghost btn--block" id="scan-glu">Read the glucometer with the camera</button>
      <div class="field" style="margin-top:12px">
        <label>Sample</label>
        <div class="choices">
          <input type="radio" name="gt" id="gt-r" value="random" ${d.glucoseType !== 'fasting' ? 'checked' : ''}><label for="gt-r">Random</label>
          <input type="radio" name="gt" id="gt-f" value="fasting" ${d.glucoseType === 'fasting' ? 'checked' : ''}><label for="gt-f">Fasting</label>
        </div>
      </div>
      <div class="field">
        <label for="glu">Reading, mg/dL</label>
        <input id="glu" type="number" inputmode="numeric" value="${d.glucoseMgdl ?? ''}">
      </div>
      <div id="glu-note"></div>
    </div>

    <div class="row">
      <button class="btn btn--ghost" id="back-step">Back</button>
      <button class="btn btn--primary" id="next">See result</button>
    </div>
  `;

  const sync = () => {
    d.systolic = num($('#sys').value);
    d.diastolic = num($('#dia').value);
    d.pulse = num($('#pul').value);
    d.glucoseMgdl = num($('#glu').value);
    d.glucoseType = document.querySelector('input[name=gt]:checked')?.value || 'random';
    setDraft(d);
  };

  $('#step').addEventListener('change', sync);

  $('#scan-bp').onclick = () => scan('bp_monitor', (res) => {
    if (res.readable && res.systolic) {
      $('#sys').value = res.systolic;
      $('#dia').value = res.diastolic ?? '';
      $('#pul').value = res.pulse ?? '';
      d.visionSimulated = res.simulated;
      sync();
    }
    $('#bp-note').innerHTML = readingNote(res);
  });

  $('#scan-glu').onclick = () => scan('glucometer', (res) => {
    if (res.readable && res.glucoseMgdl) {
      $('#glu').value = res.glucoseMgdl;
      d.visionSimulated = res.simulated;
      sync();
    }
    $('#glu-note').innerHTML = readingNote(res);
  });

  $('#back-step').onclick = () => { sync(); advance(d, d.step - 1); };
  $('#next').onclick = () => {
    sync();
    if (!d.systolic && !d.glucoseMgdl) return flash('Enter at least one reading, or scan the device.');
    d.assessment = assess(d);
    setDraft(d);
    advance(d);
  };
}

function readingNote(res) {
  if (!res.readable) {
    return `<p class="simnote" style="background:var(--amber-100);color:var(--amber-600)"><strong>Not read</strong><span>${esc(res.note)} Type the numbers in by hand.</span></p>`;
  }
  return simNote(res) + `<p class="tiny muted">${esc(res.note)}</p>`;
}

/* ----------------------------- step 4: result ----------------------------- */

function stepResult(d) {
  const a = d.assessment || assess(d);
  const f = a.findings;

  $('#step').innerHTML = `
    <div class="card">
      <h2>${esc(a.label)} ${badge(a.action)}</h2>
      <p>${esc(patientSafeSummary(a))}</p>
      <p class="tiny muted">This is what to say to the person. It deliberately does not name any condition.</p>
    </div>

    <div class="card">
      <h3>What was measured</h3>
      ${f.bp ? kv('Blood pressure', `${f.bp.systolic}/${f.bp.diastolic} — ${f.bp.label}`) : ''}
      ${f.glucose ? kv(`Blood sugar (${f.glucose.type})`, `${f.glucose.mgdl} mg/dL — ${f.glucose.label}`) : ''}
      ${f.bmi ? kv('BMI', `${f.bmi.value} — ${f.bmi.label}`) : ''}
      ${f.idrs ? kv('IDRS', `${f.idrs.score} of 100 — ${f.idrs.label}`) : ''}
      ${f.idrs ? `<details><summary class="small muted" style="margin-top:8px">How the risk score was reached</summary>
        ${f.idrs.breakdown.map((b) => kv(b.factor + ' — ' + b.detail, String(b.points))).join('')}
      </details>` : ''}
    </div>

    ${a.reasons.length ? `<div class="card">
      <h3>Why this outcome</h3>
      <ul class="small">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <p class="tiny muted">Deterministic rules calibrated to ICMR thresholds. Not a trained model.</p>
    </div>` : ''}

    <div class="row">
      <button class="btn btn--ghost" id="back-step">Back</button>
      <button class="btn btn--primary" id="next">${a.action === 'routine' ? 'Save screening' : 'Make referral slip'}</button>
    </div>
  `;

  $('#back-step').onclick = () => advance(d, d.step - 1);
  $('#next').onclick = () => {
    if (a.action === 'routine') {
      finishRoutine(d, a);
    } else {
      advance(d);
    }
  };
}

const kv = (k, v) => `<div class="kv"><span class="kv__k">${esc(k)}</span><span class="kv__v">${esc(v)}</span></div>`;

function finishRoutine(d, a) {
  const record = { ...d, assessment: a, referral: null, thread: [] };
  delete record.step;
  upsertRecord(record);
  clearDraft();
  flash(`Saved. Next check in ${a.monitoringMonths} months.`, 'info');
  go('/record/' + record.id);
}

/* ---------------------------- step 5: referral ---------------------------- */

function stepReferral(d) {
  const a = d.assessment;
  d.clinicId = d.clinicId || CLINICS[0].id;
  d.scheme = d.scheme || SCHEMES[0];

  $('#step').innerHTML = `
    <div class="card">
      <h2>Referral</h2>
      <div class="field">
        <label for="clinic">Send them to</label>
        <select id="clinic">
          ${CLINICS.map((c) => `<option value="${c.id}" ${d.clinicId === c.id ? 'selected' : ''}>${esc(c.name)} — ${esc(c.detail)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="scheme">Scheme they qualify for</label>
        <select id="scheme">
          ${SCHEMES.map((s) => `<option ${d.scheme === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn--primary btn--block" id="gen">Generate slip in ${esc(LANGUAGES[d.language])}</button>
    </div>
    <div id="slip-out"></div>
  `;

  $('#clinic').onchange = (e) => { d.clinicId = e.target.value; setDraft(d); };
  $('#scheme').onchange = (e) => { d.scheme = e.target.value; setDraft(d); };

  // A slip already generated before the phone locked or the volunteer stepped
  // back should still be on screen, not silently lost.
  if (d.slip) {
    $('#gen').textContent = 'Regenerate slip';
    renderSlipOut(d, d.slip, CLINICS.find((c) => c.id === d.clinicId));
  }

  $('#gen').onclick = async () => {
    const btn = $('#gen');
    btn.disabled = true;
    btn.textContent = 'Writing the slip…';
    const clinic = CLINICS.find((c) => c.id === d.clinicId);
    const slip = await generateReferral({
      assessment: a,
      language: d.language,
      clinicName: clinic.name,
      clinicDetail: clinic.detail,
      scheme: d.scheme,
      patientName: d.name,
    });
    d.slip = slip;
    setDraft(d);
    btn.disabled = false;
    btn.textContent = 'Regenerate slip';
    renderSlipOut(d, slip, clinic);
  };
}

function renderSlipOut(d, slip, clinic) {
  $('#slip-out').innerHTML = `
    ${simNote(slip)}
    <div class="slip" dir="${dirFor(d.language)}">
      <div class="slip__headline">${esc(slip.headline)}</div>
      <div class="slip__body">${esc(slip.body)}</div>
      <div class="slip__say"><strong>${dirFor(d.language) === 'rtl' ? 'کاؤنٹر پر کہیں' : 'Say at the desk'}:</strong> ${esc(slip.whatToSayAtTheDesk)}</div>
      <div class="slip__disclaimer">${esc(slip.englishGloss)}</div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Read this out while handing it over</h3>
      <p dir="${dirFor(d.language)}">${esc(slip.counsellingScript)}</p>
    </div>

    <div class="row">
      <button class="btn btn--ghost" id="print">Print</button>
      <button class="btn btn--primary" id="save">Save and start follow-up</button>
    </div>
  `;

  $('#print').onclick = () => window.print();
  $('#save').onclick = () => {
    const record = {
      ...d,
      referral: {
        status: 'issued',
        clinicId: clinic.id,
        clinicName: clinic.name,
        clinicDetail: clinic.detail,
        scheme: d.scheme,
        issuedAt: new Date().toISOString(),
        slip,
      },
      thread: [],
    };
    delete record.step;
    delete record.slip;
    upsertRecord(record);
    clearDraft();
    flash(d.consent.followUpOptIn
      ? 'Saved. The follow-up agent will contact them on day three.'
      : 'Saved. No follow-up: they did not consent to being contacted.', 'info');
    go('/record/' + record.id);
  };
}

/* ====================================================================== *
 * Camera
 * ====================================================================== */

let cameraStream = null;

async function scan(deviceType, onResult) {
  const panel = $('#camera');
  const video = $('#camera-video');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
  } catch {
    flash('No camera available. Type the reading in by hand.');
    return;
  }

  video.srcObject = cameraStream;
  await video.play().catch(() => {});
  panel.hidden = false;

  const close = () => {
    panel.hidden = true;
    cameraStream?.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    video.srcObject = null;
  };

  $('#camera-cancel').onclick = close;
  $('#camera-shoot').onclick = async () => {
    const canvas = $('#camera-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    close();
    flash('Reading the display…', 'info');
    const res = await readDeviceScreen(base64, deviceType);
    onResult(res);
  };
}

/* ====================================================================== *
 * Records
 * ====================================================================== */

function renderRecords() {
  const records = getRecords();
  if (!records.length) {
    app().innerHTML = emptyState('No screenings on this device yet.', 'Start a screening', '#/screen');
    return;
  }

  app().innerHTML = `
    <div class="card card--flush">
      <ul class="list">
        ${records.map((r) => `
          <li><a class="list__item" href="#/record/${esc(r.id)}">
            <div class="list__main">
              <div class="list__title">${esc(r.name || 'Not named')} <span class="muted small">${r.age ? r.age : ''}</span></div>
              <div class="list__sub">${fmtDate(r.screenedAt)} · ${esc(r.centre || 'No centre set')}</div>
            </div>
            ${badge(r.assessment?.action || 'routine')}
          </a></li>`).join('')}
      </ul>
    </div>
  `;
}

function renderRecord(id) {
  const r = findRecord(id);
  if (!r) return go('/records');
  const a = r.assessment;
  const b = burdenDeferred(r);

  app().innerHTML = `
    <div class="card">
      <h2>${esc(r.name || 'Not named')} ${badge(a.action)}</h2>
      <p class="small muted">${fmtDate(r.screenedAt)} at ${fmtTime(r.screenedAt)} · ${esc(r.centre || 'No centre')} · ${esc(r.volunteer || 'No volunteer')}</p>
      ${r.visionSimulated ? '<p class="tiny muted">Reading captured with a simulated vision call.</p>' : ''}
    </div>

    <div class="card">
      <h3>Findings</h3>
      ${a.findings.bp ? kv('Blood pressure', `${a.findings.bp.systolic}/${a.findings.bp.diastolic} — ${a.findings.bp.label}`) : ''}
      ${a.findings.glucose ? kv('Blood sugar', `${a.findings.glucose.mgdl} mg/dL ${a.findings.glucose.type} — ${a.findings.glucose.label}`) : ''}
      ${a.findings.bmi ? kv('BMI', `${a.findings.bmi.value} — ${a.findings.bmi.label}`) : ''}
      ${a.findings.idrs ? kv('IDRS', `${a.findings.idrs.score} of 100 — ${a.findings.idrs.label}`) : ''}
      ${kv('Next check', `${a.monitoringMonths} months`)}
    </div>

    ${r.referral ? `
      <div class="card">
        <h3>Referral ${referralBadge(r.referral.status)}</h3>
        ${kv('Clinic', r.referral.clinicName)}
        ${kv('Detail', r.referral.clinicDetail)}
        ${kv('Scheme', r.referral.scheme)}
        ${kv('Issued', fmtDate(r.referral.issuedAt))}
        <div class="row" style="margin-top:12px">
          <a class="btn btn--primary" href="#/thread/${esc(r.id)}">${r.thread?.length ? 'Open follow-up' : 'Start follow-up'}</a>
        </div>
      </div>

      <div class="card">
        <h3>Ledger</h3>
        <div class="kv"><span class="kv__k">Burden deferred</span><span class="kv__v">${b.credited ? formatInr(b.inr) : '—'}</span></div>
        <p class="tiny muted">${esc(b.reason)}. ${b.credited ? 'Projection, not an observed saving.' : 'Credit is written only when the agent confirms the person reached care.'}</p>
      </div>` : ''}

    <div class="card">
      <h3>Consent</h3>
      ${kv('Screening', r.consent?.given ? 'Given' : 'Not recorded')}
      ${kv('Follow-up contact', r.consent?.followUpOptIn ? 'Opted in' : 'Declined')}
      ${r.consent?.at ? kv('Recorded at', fmtTime(r.consent.at)) : ''}
    </div>

    <button class="btn btn--danger btn--block" id="del">Delete this record</button>
  `;

  $('#del').onclick = () => {
    if (!confirm('Delete this screening permanently? This cannot be undone.')) return;
    setRecords(getRecords().filter((x) => x.id !== id));
    flash('Record deleted.');
    go('/records');
  };
}

function emptyState(text, cta, href) {
  return `<div class="card center">
    <p class="muted">${esc(text)}</p>
    ${cta ? `<a class="btn btn--primary" href="${href}">${esc(cta)}</a>` : ''}
  </div>`;
}

/* ====================================================================== *
 * Follow-up
 *
 * The loop does not close until someone actually reaches a doctor. This is
 * where every community screening programme quietly fails, so it gets its own
 * tab and its own badge.
 * ====================================================================== */

function pendingFollowups() {
  return getRecords().filter((r) =>
    r.referral && r.referral.status !== 'completed' && r.consent?.followUpOptIn
  );
}

function renderFollowups() {
  const all = getRecords().filter((r) => r.referral);
  if (!all.length) {
    app().innerHTML = emptyState('No referrals yet. Follow-up threads appear here once a slip is issued.');
    return;
  }

  const pending = all.filter((r) => r.referral.status !== 'completed');
  const done = all.filter((r) => r.referral.status === 'completed');

  app().innerHTML = `
    ${pending.length ? section('Open', pending) : ''}
    ${done.length ? section('Confirmed in care', done) : ''}
    <p class="tiny muted center">The agent contacts people on day three and day ten. It never diagnoses and never prescribes.</p>
  `;

  function section(title, list) {
    return `<h3>${title}</h3><div class="card card--flush"><ul class="list">
      ${list.map((r) => `<li><a class="list__item" href="#/thread/${esc(r.id)}">
        <div class="list__main">
          <div class="list__title">${esc(r.name || 'Not named')}</div>
          <div class="list__sub">${esc(r.referral.clinicName)} · ${contactCount(r)}</div>
        </div>
        ${referralBadge(r.referral.status)}
      </a></li>`).join('')}
    </ul></div>`;
  }
}

function contactCount(r) {
  const n = (r.thread || []).filter((m) => m.from === 'agent').length;
  if (!n) return 'not started';
  return n === 1 ? '1 contact' : `${n} contacts`;
}

function renderThread(id) {
  const r = findRecord(id);
  if (!r || !r.referral) return go('/followups');
  r.thread = r.thread || [];

  if (!r.consent?.followUpOptIn) {
    app().innerHTML = `<div class="card">
      <h2>No follow-up for this person</h2>
      <p class="muted">They did not consent to being contacted. No message will be sent, and the referral cannot be confirmed by the agent.</p>
      <a class="btn btn--ghost btn--block" href="#/record/${esc(id)}">Back to the record</a>
    </div>`;
    return;
  }

  const agentTurns = r.thread.filter((m) => m.from === 'agent').length;
  const complete = r.referral.status === 'completed';

  app().innerHTML = `
    <div class="card">
      <h2>${esc(r.name || 'Not named')} ${referralBadge(r.referral.status)}</h2>
      <p class="small muted">Referred to ${esc(r.referral.clinicName)} on ${fmtDate(r.referral.issuedAt)}.</p>
      <p class="tiny muted">WhatsApp Business API approval outlasts a build day, so this runs the real agent against a simulated thread. Production swaps the channel, not the system.</p>
    </div>

    <div class="thread" id="thread">
      ${r.thread.length ? r.thread.map(msgHtml).join('') : '<p class="msg msg--system">No messages yet.</p>'}
    </div>

    <div class="card" style="margin-top:16px">
      ${complete ? '<p class="muted">This referral is confirmed complete. The ledger has been credited.</p>' : `
        <div class="row">
          <button class="btn btn--primary" id="send-agent">${agentTurns === 0 ? 'Send day 3 message' : 'Send day 10 message'}</button>
        </div>
        <div class="field" style="margin-top:12px">
          <label for="reply">Simulate their reply</label>
          <textarea id="reply" placeholder="Type what the patient sends back…"></textarea>
          <p class="field__hint">Stands in for the WhatsApp channel. The agent's response is generated the same way it will be in production.</p>
        </div>
        <button class="btn btn--ghost btn--block" id="send-patient" ${agentTurns === 0 ? 'disabled' : ''}>Send reply and let the agent respond</button>
      `}
    </div>

    <div class="card">
      <h3>Mark by hand</h3>
      <p class="tiny muted">Use only when a volunteer has confirmed the outcome in person.</p>
      <div class="row">
        <button class="btn btn--ghost" id="mark-complete" ${complete ? 'disabled' : ''}>Confirm they reached care</button>
        <button class="btn btn--ghost" id="mark-escalate">Escalate to volunteer</button>
      </div>
    </div>
  `;

  const scroll = () => { const t = $('#thread'); t?.scrollIntoView({ block: 'end' }); };

  if (!complete) {
    $('#send-agent').onclick = async () => {
      const day = agentTurns === 0 ? 3 : 10;
      if (agentTurns === 0) {
        pushMsg(r, { from: 'agent', text: openingMessage(r.language, day), day, simulated: !hasApiKey() });
      } else {
        await agentRespond(r, day);
      }
      renderThread(id);
      scroll();
    };

    $('#send-patient').onclick = async () => {
      const text = $('#reply').value.trim();
      if (!text) return flash('Type the reply first.');
      pushMsg(r, { from: 'patient', text });
      const day = r.thread.filter((m) => m.from === 'agent').length >= 2 ? 10 : 3;
      await agentRespond(r, day);
      renderThread(id);
      scroll();
    };
  }

  $('#mark-complete').onclick = () => {
    if (complete) return;
    setStatus(r, 'completed');
    pushMsg(r, { from: 'system', text: 'Volunteer confirmed in person that the patient reached care.' });
    flash('Referral confirmed. The ledger has been credited.', 'info');
    renderThread(id);
  };

  $('#mark-escalate').onclick = () => {
    setStatus(r, 'escalated');
    pushMsg(r, { from: 'system', text: 'Escalated to the volunteer who ran the screening.' });
    renderThread(id);
  };
}

function msgHtml(m) {
  if (m.from === 'system') return `<p class="msg msg--system">${esc(m.text)}</p>`;
  const meta = [
    m.day ? `Day ${m.day}` : '',
    m.at ? fmtTime(m.at) : '',
    m.simulated ? 'simulated' : '',
    m.barrier && m.barrier !== 'no_reply' ? BARRIERS[m.barrier] : '',
  ].filter(Boolean).join(' · ');
  return `<div class="msg msg--${esc(m.from)}">${esc(m.text)}<span class="msg__meta">${esc(meta)}</span></div>`;
}

function pushMsg(record, msg) {
  record.thread = record.thread || [];
  record.thread.push({ at: new Date().toISOString(), ...msg });
  upsertRecord(record);
}

function setStatus(record, status) {
  record.referral = { ...record.referral, status, [`${status}At`]: new Date().toISOString() };
  upsertRecord(record);
}

async function agentRespond(record, dayNumber) {
  flash('The agent is replying…', 'info');
  const turn = await followUpTurn({
    thread: record.thread.filter((m) => m.from !== 'system').map((m) => ({ from: m.from, text: m.text })),
    language: record.language,
    dayNumber,
    context: {
      clinicName: record.referral.clinicName,
      clinicDetail: record.referral.clinicDetail,
      scheme: record.referral.scheme,
      eveningClinic: `${eveningClinic().name}, ${eveningClinic().detail}`,
    },
  });

  pushMsg(record, {
    from: 'agent',
    text: turn.reply,
    day: dayNumber,
    simulated: turn.simulated,
    barrier: turn.barrier,
  });

  if (turn.action === 'mark_complete') {
    setStatus(record, 'completed');
    record.medicationCollected = Boolean(turn.medicationCollected);
    upsertRecord(record);
    pushMsg(record, { from: 'system', text: 'Referral confirmed complete. Ledger credited.' });
  } else if (turn.action === 'escalate_to_volunteer') {
    setStatus(record, 'escalated');
    pushMsg(record, { from: 'system', text: `Escalated to volunteer. ${turn.escalationNote || ''}`.trim() });
  }
}

/* ====================================================================== *
 * Committee dashboard
 * ====================================================================== */

function renderLedger() {
  const records = getRecords();
  const now = new Date();
  const month = committeeLedger(records, { month: now.getMonth(), year: now.getFullYear() });
  const all = committeeLedger(records);
  const cmp = dialysisComparison();

  app().innerHTML = `
    <div class="card">
      <div class="stat stat--hero">
        <div class="stat__value">${formatInr(month.burdenDeferredInr)}</div>
        <div class="stat__label">Projected community care burden deferred this month</div>
      </div>
      <p class="tiny muted center" style="margin-top:10px">
        A projection, not an observed saving. Credited only for referrals the follow-up agent
        confirmed complete. ${month.referralsIssued - month.referralsCompleted} referral(s) issued
        this month are not counted here because nobody has confirmed the person reached care.
      </p>
    </div>

    <div class="card">
      <div class="row">
        <div class="stat"><div class="stat__value">${month.screenings}</div><div class="stat__label">Screened</div></div>
        <div class="stat"><div class="stat__value">${month.highRiskIdentified}</div><div class="stat__label">High risk found</div></div>
        <div class="stat"><div class="stat__value">${Math.round(month.referralCompletionRate * 100)}%</div><div class="stat__label">Reached care</div></div>
      </div>
      <div class="kv" style="margin-top:12px"><span class="kv__k">Referrals issued</span><span class="kv__v">${month.referralsIssued}</span></div>
      <div class="kv"><span class="kv__k">Confirmed in care</span><span class="kv__v">${month.referralsCompleted}</span></div>
      <div class="kv"><span class="kv__k">Consumables spent</span><span class="kv__v">${formatInr(month.consumablesSpentInr.min)} – ${formatInr(month.consumablesSpentInr.max)}</span></div>
      <p class="tiny muted">Completion is measured against referrals issued, not screenings performed. A slip handed over is not an outcome.</p>
    </div>

    <div class="card">
      <h3>What the fund did not have to spend</h3>
      <p class="small">All time, this device: <strong>${formatInr(all.burdenDeferredInr)}</strong> deferred across
        ${all.referralsCompleted} confirmed referral(s). That would fund
        <strong>${all.screeningsEquivalent.min.toLocaleString('en-IN')} to ${all.screeningsEquivalent.max.toLocaleString('en-IN')}</strong>
        further screenings at ${formatInr(SCREENING_COST_MIN_INR)}–${formatInr(SCREENING_COST_MAX_INR)} each.</p>
    </div>

    <div class="card">
      <h3>The arithmetic this programme exists for</h3>
      <p class="small">One community member on maintenance dialysis consumes
        <strong>${formatInr(cmp.annualSupportInr)}</strong> of committee support per year.</p>
      <p class="small">The same amount funds
        <strong>${cmp.screeningsEquivalent.min.toLocaleString('en-IN')} to ${cmp.screeningsEquivalent.max.toLocaleString('en-IN')}</strong>
        screenings, which is every person across all ${cmp.networkCentres} centres in the ABF network,
        roughly ${cmp.perCentre.min} to ${cmp.perCentre.max} people per centre.</p>
      <p class="tiny muted">Costing figures are ABF field-costed, Bengaluru 2026. Observed, not cited.
        Complication-pathway figures are modelled and are what Phase 1 exists to test against real disbursement records.</p>
    </div>
  `;
}

/* ====================================================================== *
 * Settings
 * ====================================================================== */

function renderSettings() {
  const s = getSettings();

  app().innerHTML = `
    <div class="card">
      <h3>This device</h3>
      <div class="field">
        <label for="centre">Centre</label>
        <input id="centre" value="${esc(s.centre)}" placeholder="Masjid name or centre">
      </div>
      <div class="field">
        <label for="volunteer">Volunteer</label>
        <input id="volunteer" value="${esc(s.volunteer)}" placeholder="Who is screening">
      </div>
      <div class="field">
        <label for="deflang">Default language</label>
        <select id="deflang">
          ${Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}" ${s.language === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn--primary btn--block" id="save-settings">Save</button>
    </div>

    <div class="card">
      <h3>Model access</h3>
      <p class="small muted">Without a key the app still works end to end. Vision, referral and follow-up
        fall back to simulated output, clearly labelled on screen.</p>
      <div class="field">
        <label for="key">Gemini API key</label>
        <input id="key" type="password" value="${esc(getApiKey())}" placeholder="Leave blank to run simulated" autocomplete="off">
        <p class="field__hint">Stored on this device only, never committed. On a public deployment,
          restrict it by referrer in AI Studio and rotate it after the event.</p>
      </div>
      <button class="btn btn--primary btn--block" id="save-key">Save key</button>
    </div>

    <div class="card">
      <h3>Demo data</h3>
      <p class="small muted">Anonymised sample records so the committee dashboard is legible before
        real screenings exist.</p>
      <div class="row">
        <button class="btn btn--ghost" id="seed">Add sample records</button>
        <button class="btn btn--ghost" id="selftest">Run self-test</button>
      </div>
      <div id="selftest-out"></div>
    </div>

    <div class="card">
      <h3>Data on this device</h3>
      <div class="kv"><span class="kv__k">Records stored</span><span class="kv__v">${getRecords().length}</span></div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn--ghost" id="export">Export JSON</button>
        <button class="btn btn--danger" id="wipe">Erase everything</button>
      </div>
      <p class="tiny muted">Health data never leaves this handset. Erasure on request is a DPDP Act
        obligation, so it is one button rather than a support request.</p>
    </div>
  `;

  $('#save-settings').onclick = () => {
    setSettings({
      centre: $('#centre').value.trim(),
      volunteer: $('#volunteer').value.trim(),
      language: $('#deflang').value,
    });
    flash('Saved.', 'info');
  };

  $('#save-key').onclick = () => {
    setApiKey($('#key').value);
    flash(hasApiKey() ? 'Key saved. Model calls are live.' : 'Key cleared. Running simulated.', 'info');
  };

  $('#seed').onclick = () => { seed(); flash('Sample records added.', 'info'); renderSettings(); };

  $('#selftest').onclick = () => { $('#selftest-out').innerHTML = selfTest(); };

  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(getRecords(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sehat-records-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('#wipe').onclick = () => {
    if (!confirm('Erase every record on this device? This cannot be undone.')) return;
    setRecords([]);
    clearDraft();
    flash('All records erased.');
    renderSettings();
  };
}

/* ====================================================================== *
 * Sample data
 * ====================================================================== */

const SAMPLE_NAMES = ['Fatima', 'Abdul', 'Zainab', 'Imran', 'Ayesha', 'Yusuf', 'Rukhsana', 'Salim', 'Nadia', 'Rafiq'];

function seed() {
  const now = Date.now();
  const day = 86400000;
  const out = [];

  const profiles = [
    { sex: 'female', age: 54, waistCm: 94, activity: 'sedentary', familyHistory: 'both_parents', heightCm: 152, weightKg: 68, systolic: 152, diastolic: 96, glucoseMgdl: 224, status: 'completed' },
    { sex: 'male', age: 61, waistCm: 104, activity: 'mild', familyHistory: 'one_parent', heightCm: 168, weightKg: 79, systolic: 168, diastolic: 102, glucoseMgdl: 198, status: 'completed' },
    { sex: 'male', age: 47, waistCm: 96, activity: 'moderate', familyHistory: 'none', heightCm: 171, weightKg: 74, systolic: 144, diastolic: 92, glucoseMgdl: 152, status: 'issued' },
    { sex: 'female', age: 38, waistCm: 88, activity: 'sedentary', familyHistory: 'one_parent', heightCm: 157, weightKg: 63, systolic: 128, diastolic: 84, glucoseMgdl: 168, status: 'issued' },
    { sex: 'female', age: 29, waistCm: 74, activity: 'moderate', familyHistory: 'none', heightCm: 160, weightKg: 54, systolic: 114, diastolic: 74, glucoseMgdl: 96, status: null },
    { sex: 'male', age: 33, waistCm: 84, activity: 'vigorous', familyHistory: 'none', heightCm: 174, weightKg: 68, systolic: 118, diastolic: 76, glucoseMgdl: 104, status: null },
    { sex: 'male', age: 58, waistCm: 101, activity: 'sedentary', familyHistory: 'both_parents', heightCm: 166, weightKg: 81, systolic: 182, diastolic: 114, glucoseMgdl: 268, status: 'escalated' },
    { sex: 'female', age: 66, waistCm: 92, activity: 'mild', familyHistory: 'one_parent', heightCm: 149, weightKg: 61, systolic: 158, diastolic: 94, glucoseMgdl: 176, status: 'completed' },
  ];

  profiles.forEach((p, i) => {
    const { status, ...fields } = p;
    const screenedAt = new Date(now - (i * 3 + 1) * day).toISOString();
    const a = assess(fields);
    const clinic = CLINICS[i % CLINICS.length];

    const record = {
      id: newId(),
      screenedAt,
      centre: 'Masjid-e-Noor, Shivajinagar',
      volunteer: 'Sample data',
      language: 'ur',
      name: SAMPLE_NAMES[i % SAMPLE_NAMES.length],
      consent: { given: true, followUpOptIn: true, at: screenedAt },
      glucoseType: 'random',
      ...fields,
      assessment: a,
      isSample: true,
      referral: status ? {
        status,
        clinicId: clinic.id,
        clinicName: clinic.name,
        clinicDetail: clinic.detail,
        scheme: SCHEMES[i % SCHEMES.length],
        issuedAt: screenedAt,
        slip: null,
      } : null,
      thread: status ? [
        { from: 'agent', text: openingMessage('ur', 3), at: new Date(now - (i * 3 - 2) * day).toISOString(), day: 3, simulated: true },
        ...(status === 'completed' ? [
          { from: 'patient', text: 'ہاں، میں چلا گیا تھا اور دوا بھی لے لی۔', at: screenedAt },
          { from: 'system', text: 'Referral confirmed complete. Ledger credited.' },
        ] : status === 'escalated' ? [
          { from: 'system', text: 'Two contacts made, no reply. Escalated to the volunteer.' },
        ] : []),
      ] : [],
    };

    out.push(record);
  });

  setRecords([...out, ...getRecords()]);
}

/* ====================================================================== *
 * In-browser self-test
 * A short invariant check for machines with no Node. The full suite is
 * test-clinical.js and test-ledger.js.
 * ====================================================================== */

function selfTest() {
  const checks = [];
  const t = (name, fn) => {
    try { fn(); checks.push([true, name]); }
    catch (e) { checks.push([false, `${name} — ${e.message}`]); }
  };
  const eq = (a, b, m) => { if (a !== b) throw new Error(m || `expected ${b}, got ${a}`); };

  t('crisis BP escalates to urgent', () => eq(assess({ systolic: 190, diastolic: 118 }).action, 'urgent'));
  t('raised BP refers', () => eq(assess({ systolic: 146, diastolic: 92 }).action, 'referral'));
  t('normal readings do not refer', () => eq(assess({ systolic: 116, diastolic: 74, glucoseMgdl: 96 }).action, 'routine'));
  t('patient text names no condition', () => {
    const s = patientSafeSummary(assess({ systolic: 190, diastolic: 118 }));
    if (/diabet|hypertens/i.test(s)) throw new Error('leaked a condition name');
  });
  t('unconfirmed referral is not credited', () => {
    const r = { assessment: assess({ systolic: 150, diastolic: 96 }), referral: { status: 'issued' } };
    eq(burdenDeferred(r).inr, 0);
  });
  t('confirmed referral is credited', () => {
    const r = { assessment: assess({ systolic: 150, diastolic: 96 }), referral: { status: 'completed' } };
    if (burdenDeferred(r).inr <= 0) throw new Error('expected credit');
  });
  t('rupee formatting is Indian grouped', () => eq(formatInr(158880), '₹1,58,880'));

  const failed = checks.filter(([ok]) => !ok);
  return `<div class="card" style="margin-top:12px">
    <h3>${failed.length ? `${failed.length} of ${checks.length} failed` : `All ${checks.length} checks passed`}</h3>
    <ul class="small">${checks.map(([ok, n]) => `<li>${ok ? '✓' : '✗'} ${esc(n)}</li>`).join('')}</ul>
  </div>`;
}

/* ====================================================================== *
 * Boot
 * ====================================================================== */

function updateOnlineState() {
  document.body.classList.toggle('is-offline', !navigator.onLine);
}

function updateBadge() {
  const n = pendingFollowups().length;
  const el = $('#followup-badge');
  el.textContent = n;
  el.hidden = n === 0;
}

window.addEventListener('hashchange', () => { router(); updateBadge(); });
window.addEventListener('online', updateOnlineState);
window.addEventListener('offline', updateOnlineState);

$('#back').onclick = () => history.back();

updateOnlineState();
router();
updateBadge();

/* Service worker. Registered last so a failure here never blocks the app. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });

  // A cache-first worker serving yesterday's JavaScript looks exactly like
  // "my changes did nothing". Reload once when a new worker takes control.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}
