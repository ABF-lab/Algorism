/**
 * ai.js — the three model calls, each with a labelled mock fallback.
 *
 * DESIGN RULE: no model call is ever load-bearing for a screening. If there is
 * no key, no signal, or a rate limit, the call returns realistic simulated
 * output flagged `simulated: true`, and the UI says so on screen. A demo that
 * dies because the venue wifi died is not a demo. Output that silently
 * pretends to be live is worse than no output.
 *
 * KEY HANDLING: entered by the operator at runtime, held in localStorage on the
 * device, never committed. On a public deployment this is a client-side key and
 * must be referrer-restricted in AI Studio and rotated after the event. A
 * production deployment moves these calls behind a proxy.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';
const KEY_STORAGE = 'sehat.apiKey';
const TIMEOUT_MS = 12000;

export const LANGUAGES = {
  ur: 'Urdu',
  kn: 'Kannada',
  hi: 'Hindi',
  ta: 'Tamil',
  en: 'English',
};

/* ------------------------------ key handling ------------------------------ */

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
    return true;
  } catch {
    return false;
  }
}

export function hasApiKey() {
  return Boolean(getApiKey());
}

/* ------------------------------ transport ------------------------------ */

/**
 * One place where every model call goes out, so there is one place where
 * failure is handled. Throws on any non-success; callers catch and mock.
 */
async function callGemini(parts, responseSchema, systemInstruction) {
  const key = getApiKey();
  if (!key) throw new Error('no-key');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ENDPOINT}/${MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      // Never cached. A stale vital sign is a clinical hazard.
      cache: 'no-store',
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        systemInstruction: systemInstruction
          ? { parts: [{ text: systemInstruction }] }
          : undefined,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
    });

    if (!res.ok) throw new Error(`http-${res.status}`);
    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty-response');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Uniform shape so the UI can render a badge without special-casing. */
function live(data) {
  return { ...data, simulated: false };
}

function mock(data, why) {
  return { ...data, simulated: true, simulationReason: why };
}

function reasonFor(err) {
  const m = String(err && err.message);
  if (m === 'no-key') return 'No API key set';
  if (m === 'offline') return 'Device is offline';
  if (m.startsWith('http-429')) return 'Rate limited';
  if (m.startsWith('http-')) return `API error ${m.slice(5)}`;
  if (m === 'AbortError' || (err && err.name === 'AbortError')) return 'Request timed out';
  return 'Model unavailable';
}

/* ------------------------------------------------------------------ *
 * 1. Vision — read the device screen
 *
 * The single largest cause of data loss in community screening is
 * transcription. The volunteer points the camera at the glucometer or BP
 * monitor instead of typing.
 *
 * The model is instructed to REFUSE rather than guess. A wrong vital sign is
 * worse than no vital sign, because a wrong low reading sends someone home.
 * ------------------------------------------------------------------ */

const VISION_SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean' },
    deviceType: { type: 'string', enum: ['glucometer', 'bp_monitor', 'unknown'] },
    glucoseMgdl: { type: 'number' },
    systolic: { type: 'number' },
    diastolic: { type: 'number' },
    pulse: { type: 'number' },
    note: { type: 'string' },
  },
  required: ['readable', 'deviceType', 'note'],
};

const VISION_INSTRUCTION = `You read digits from the LCD screen of a medical device in a photograph.

Rules, in order of importance:
1. If the display is blurred, glared, partially obscured, mid-refresh, or you are
   not certain of EVERY digit, set readable=false and explain what is wrong in
   note. Never guess a digit. A wrong vital sign is more dangerous than none.
2. Report only what is printed on the screen. Do not infer, convert or correct.
3. A glucometer shows one number, in mg/dL. A BP monitor shows systolic over
   diastolic and usually a pulse.
4. If a glucose value is shown in mmol/L, multiply by 18 to give mg/dL and say
   so in note.
5. note must be one short sentence a volunteer can read.`;

/**
 * @param {string} base64Jpeg image data, no data: prefix
 * @param {'glucometer'|'bp_monitor'} expected which device the volunteer chose
 */
export async function readDeviceScreen(base64Jpeg, expected) {
  try {
    const data = await callGemini(
      [
        { text: `Read this ${expected === 'glucometer' ? 'glucometer' : 'blood pressure monitor'} display.` },
        { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } },
      ],
      VISION_SCHEMA,
      VISION_INSTRUCTION
    );
    return live(data);
  } catch (err) {
    return mock(mockReading(expected), reasonFor(err));
  }
}

/**
 * Deterministic simulated reading. Values sit in the referral band on purpose:
 * a demo that always returns "normal" demonstrates nothing.
 */
function mockReading(expected) {
  return expected === 'glucometer'
    ? { readable: true, deviceType: 'glucometer', glucoseMgdl: 214, note: 'Simulated reading, no model call was made.' }
    : { readable: true, deviceType: 'bp_monitor', systolic: 148, diastolic: 94, pulse: 82, note: 'Simulated reading, no model call was made.' };
}

/* ------------------------------------------------------------------ *
 * 2. Language — referral slip and counselling script
 *
 * "HbA1c elevated, consult physician" is useless to the person holding it. The
 * slip has to name the clinic, name the scheme, and tell them what to say at
 * the desk, in their language, at their literacy level.
 *
 * SCOPE RULE: never name a condition. The output is always "see a doctor about
 * this", never "you have diabetes".
 * ------------------------------------------------------------------ */

const REFERRAL_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    body: { type: 'string' },
    whatToSayAtTheDesk: { type: 'string' },
    counsellingScript: { type: 'string' },
    englishGloss: { type: 'string' },
  },
  required: ['headline', 'body', 'whatToSayAtTheDesk', 'counsellingScript', 'englishGloss'],
};

const REFERRAL_INSTRUCTION = `You write referral slips for a community health screening
programme run by mosque volunteers in Bengaluru.

Absolute rules:
1. NEVER name or imply a diagnosis. Not "diabetes", not "high blood pressure",
   not "sugar problem". This is a screening, not a diagnosis. Say that some
   readings were higher than expected and a doctor should look at them.
2. Write for someone who may read slowly. Short sentences. No medical words.
3. Name the specific clinic and the specific scheme given to you. Never invent
   a clinic, a scheme, a cost or an opening time.
4. whatToSayAtTheDesk is one sentence the patient can repeat verbatim on arrival.
5. counsellingScript is what the VOLUNTEER says out loud when handing the slip
   over, in the same language, warm and unalarming, under 60 words.
6. englishGloss is a plain-English translation of body, so a supervisor who does
   not read the target language can audit what was sent.
7. Write in the requested language using its own script.`;

/**
 * @param {object} opts
 * @param {object} opts.assessment output of clinical.assess()
 * @param {string} opts.language one of LANGUAGES keys
 * @param {string} opts.clinicName
 * @param {string} opts.clinicDetail address / hours
 * @param {string} opts.scheme government scheme the patient qualifies for
 * @param {string} [opts.patientName]
 */
export async function generateReferral(opts) {
  const { assessment, language, clinicName, clinicDetail, scheme, patientName } = opts;
  const languageName = LANGUAGES[language] || 'English';

  try {
    const data = await callGemini(
      [{
        text: [
          `Language: ${languageName}`,
          patientName ? `Patient first name: ${patientName}` : 'Patient name: not recorded',
          `Urgency: ${assessment.action === 'urgent' ? 'see a doctor TODAY' : 'see a doctor within a week'}`,
          `Findings the doctor should look at (do not repeat these numbers to the patient as a diagnosis):`,
          ...assessment.reasons.map((r) => `  - ${r}`),
          `Clinic: ${clinicName}`,
          `Clinic detail: ${clinicDetail}`,
          `Scheme the patient qualifies for: ${scheme}`,
        ].join('\n'),
      }],
      REFERRAL_SCHEMA,
      REFERRAL_INSTRUCTION
    );
    return live(data);
  } catch (err) {
    return mock(mockReferral(opts, languageName), reasonFor(err));
  }
}

/**
 * Pre-written fallback slips. English is authoritative; the others are
 * placeholders pending native-speaker review (see README, "Translations").
 */
const MOCK_SLIPS = {
  ur: {
    headline: 'ڈاکٹر سے رجوع کریں',
    body: 'آج کی جانچ میں کچھ نتائج معمول سے زیادہ آئے ہیں۔ یہ کوئی بیماری کی تشخیص نہیں ہے۔ براہِ کرم اس پرچی کے ساتھ نیچے دیے گئے کلینک جائیں۔',
    whatToSayAtTheDesk: 'مجھے مسجد کی صحت جانچ سے بھیجا گیا ہے، یہ پرچی دیکھ لیجیے۔',
    counsellingScript: 'گھبرانے کی بات نہیں ہے۔ آج کی جانچ میں کچھ نتائج ذرا زیادہ آئے ہیں، اس لیے ایک ڈاکٹر کو دکھا لینا بہتر ہے۔ یہ پرچی ساتھ لے جائیے، وہاں سب لکھا ہوا ہے۔',
  },
  kn: {
    headline: 'ವೈದ್ಯರನ್ನು ಭೇಟಿ ಮಾಡಿ',
    body: 'ಇಂದಿನ ತಪಾಸಣೆಯಲ್ಲಿ ಕೆಲವು ಅಳತೆಗಳು ನಿರೀಕ್ಷೆಗಿಂತ ಹೆಚ್ಚಿವೆ. ಇದು ರೋಗ ನಿರ್ಣಯವಲ್ಲ. ದಯವಿಟ್ಟು ಈ ಚೀಟಿಯೊಂದಿಗೆ ಕೆಳಗಿನ ಚಿಕಿತ್ಸಾಲಯಕ್ಕೆ ಹೋಗಿ.',
    whatToSayAtTheDesk: 'ಮಸೀದಿ ಆರೋಗ್ಯ ತಪಾಸಣೆಯಿಂದ ಕಳುಹಿಸಿದ್ದಾರೆ, ಈ ಚೀಟಿ ನೋಡಿ.',
    counsellingScript: 'ಗಾಬರಿಪಡುವ ಅಗತ್ಯವಿಲ್ಲ. ಇಂದಿನ ಕೆಲವು ಅಳತೆಗಳು ಸ್ವಲ್ಪ ಹೆಚ್ಚಿವೆ, ಹಾಗಾಗಿ ಒಮ್ಮೆ ವೈದ್ಯರಿಗೆ ತೋರಿಸುವುದು ಒಳ್ಳೆಯದು. ಈ ಚೀಟಿ ತೆಗೆದುಕೊಂಡು ಹೋಗಿ.',
  },
  hi: {
    headline: 'डॉक्टर को दिखाएँ',
    body: 'आज की जाँच में कुछ रीडिंग सामान्य से ज़्यादा आई हैं। यह किसी बीमारी की पुष्टि नहीं है। कृपया यह पर्ची लेकर नीचे लिखे क्लिनिक जाएँ।',
    whatToSayAtTheDesk: 'मुझे मस्जिद की सेहत जाँच से भेजा गया है, यह पर्ची देख लीजिए।',
    counsellingScript: 'घबराने की कोई बात नहीं है। आज कुछ रीडिंग थोड़ी ज़्यादा आई हैं, इसलिए एक बार डॉक्टर को दिखा लेना ठीक रहेगा। यह पर्ची साथ ले जाइए, इसमें सब लिखा है।',
  },
  ta: {
    headline: 'மருத்துவரை அணுகவும்',
    body: 'இன்றைய பரிசோதனையில் சில அளவீடுகள் எதிர்பார்த்ததை விட அதிகமாக உள்ளன. இது நோய் கண்டறிதல் அல்ல. இந்தச் சீட்டுடன் கீழே உள்ள மருத்துவமனைக்குச் செல்லுங்கள்.',
    whatToSayAtTheDesk: 'பள்ளிவாசல் உடல்நல பரிசோதனையிலிருந்து அனுப்பப்பட்டேன், இந்தச் சீட்டைப் பாருங்கள்.',
    counsellingScript: 'பயப்பட வேண்டியதில்லை. இன்று சில அளவீடுகள் சற்று அதிகமாக உள்ளன, அதனால் ஒருமுறை மருத்துவரிடம் காட்டுவது நல்லது. இந்தச் சீட்டை எடுத்துச் செல்லுங்கள்.',
  },
  en: {
    headline: 'Please see a doctor',
    body: 'Some of today’s readings were higher than expected. This is not a diagnosis. Please take this slip to the clinic named below.',
    whatToSayAtTheDesk: 'I was sent from the mosque health screening, please look at this slip.',
    counsellingScript: 'There is nothing to worry about right now. A few of today’s readings were a bit higher than we expect, so it is worth having a doctor look at them. Take this slip with you, everything is written on it.',
  },
};

function mockReferral(opts, languageName) {
  const slip = MOCK_SLIPS[opts.language] || MOCK_SLIPS.en;
  const urgentSuffix = opts.assessment.action === 'urgent' ? ' Go today.' : '';
  return {
    headline: slip.headline,
    body: `${slip.body}\n\n${opts.clinicName} — ${opts.clinicDetail}\n${opts.scheme}${urgentSuffix}`,
    whatToSayAtTheDesk: slip.whatToSayAtTheDesk,
    counsellingScript: slip.counsellingScript,
    englishGloss: `${MOCK_SLIPS.en.body} Clinic: ${opts.clinicName}, ${opts.clinicDetail}. Scheme: ${opts.scheme}.${urgentSuffix} [Simulated ${languageName} slip.]`,
  };
}

/* ------------------------------------------------------------------ *
 * 3. Agent — the follow-up turn
 *
 * This is where every community screening programme in India quietly fails.
 * People get screened, get a slip, and never go. The programme reports
 * impressive screening numbers while outcomes stay flat.
 *
 * The agent does NOT repeat the reminder. It finds out what is in the way.
 * It never diagnoses, never prescribes, never changes medication.
 * ------------------------------------------------------------------ */

/** The barrier taxonomy from the strategy document, plus a catch-all. */
export const BARRIERS = {
  unknown_location: 'Does not know where the clinic is',
  cannot_take_leave: 'Cannot take time off work',
  cost: 'Could not afford it',
  not_serious: 'Does not think it is serious',
  went: 'Attended the clinic',
  other: 'Something else',
  no_reply: 'No reply',
};

const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: {
    barrier: { type: 'string', enum: Object.keys(BARRIERS) },
    reply: { type: 'string' },
    action: { type: 'string', enum: ['await_reply', 'resolve_barrier', 'mark_complete', 'escalate_to_volunteer'] },
    escalationNote: { type: 'string' },
    medicationCollected: { type: 'boolean' },
  },
  required: ['barrier', 'reply', 'action'],
};

const FOLLOWUP_INSTRUCTION = `You are an automated follow-up assistant for the Active
Bengaluru Foundation community health screening programme. You message people who
were referred to a clinic, on day three and day ten.

Absolute rules:
1. NEVER diagnose, never prescribe, never discuss changing medication. You route
   people to care and remove the obstacle in front of them. Nothing else.
2. NEVER name a condition. If asked what is wrong, say the doctor will explain.
3. If the person has NOT gone, do not repeat the reminder. Find out WHY, then
   solve that specific thing:
   - does not know where it is  -> send location, timings, what to say at the desk
   - cannot take leave          -> offer the nearest evening or Sunday clinic
   - could not afford it        -> confirm the scheme they qualify for and what it covers
   - does not think it serious  -> restate the finding plainly, offer to speak to a family member
4. After two attempts with no useful reply, set action=escalate_to_volunteer and
   write escalationNote for the volunteer who screened them.
5. If they confirm they attended, ask once whether they collected medication,
   then set action=mark_complete.
6. Reply in the same language the person wrote in. Keep it under 45 words.
7. You have already identified yourself as an automated assistant in the first
   message of this thread. Do not repeat that every turn.
8. If they ask you to stop, set action=escalate_to_volunteer with a note that
   they opted out, and reply with a short acknowledgement. Never message again.`;

/**
 * @param {object} opts
 * @param {Array<{from:'agent'|'patient', text:string}>} opts.thread
 * @param {string} opts.language
 * @param {number} opts.dayNumber 3 or 10
 * @param {object} opts.context clinic, scheme, alternative clinic
 */
export async function followUpTurn(opts) {
  const { thread, language, dayNumber, context } = opts;
  const languageName = LANGUAGES[language] || 'English';

  try {
    const data = await callGemini(
      [{
        text: [
          `Language: ${languageName}`,
          `This is the day ${dayNumber} contact.`,
          `Referred to: ${context.clinicName} — ${context.clinicDetail}`,
          `Scheme: ${context.scheme}`,
          `Nearest clinic with evening or Sunday hours: ${context.eveningClinic}`,
          `Attempts made so far: ${thread.filter((m) => m.from === 'agent').length}`,
          '',
          'Conversation so far:',
          ...thread.map((m) => `${m.from === 'agent' ? 'You' : 'Patient'}: ${m.text}`),
        ].join('\n'),
      }],
      FOLLOWUP_SCHEMA,
      FOLLOWUP_INSTRUCTION
    );
    return live(data);
  } catch (err) {
    return mock(mockFollowUp(opts), reasonFor(err));
  }
}

/**
 * Deterministic agent fallback. Classifies on keywords, then applies the same
 * barrier-resolution table the model is instructed to use, so the demo shows
 * the real behaviour even with no key.
 */
function mockFollowUp(opts) {
  const { thread, language, dayNumber, context } = opts;
  const lang = MOCK_SLIPS[language] ? language : 'en';
  const last = [...thread].reverse().find((m) => m.from === 'patient');
  const attempts = thread.filter((m) => m.from === 'agent').length;

  if (!last) {
    return {
      barrier: 'no_reply',
      reply: MOCK_AGENT[lang].opening(dayNumber),
      action: 'await_reply',
    };
  }

  const t = last.text.toLowerCase();
  const barrier =
    /went|gaya|gaye|hogaya|attended|yes i went|collected|ಹೋಗಿದ್ದೆ|گیا|गया|சென்றேன்/.test(t) ? 'went'
    : /where|address|kahan|kaha|location|ಎಲ್ಲಿ|کہاں|कहाँ|எங்கே/.test(t) ? 'unknown_location'
    : /work|leave|job|closed|shift|duty|time|ಕೆಲಸ|کام|काम|வேலை/.test(t) ? 'cannot_take_leave'
    : /afford|money|cost|paisa|fees|expensive|ದುಡ್ಡು|پیسے|पैसे|பணம்/.test(t) ? 'cost'
    : /fine|ok|nothing wrong|not serious|theek|ಸರಿ|ٹھیک|ठीक|நல்லா/.test(t) ? 'not_serious'
    : 'other';

  if (barrier === 'went') {
    const collected = /medicine|medication|dawa|tablet|ಔಷಧ|دوا|दवा|மருந்து/.test(t);
    return {
      barrier,
      reply: MOCK_AGENT[lang].completed(collected),
      action: collected ? 'mark_complete' : 'await_reply',
      medicationCollected: collected,
    };
  }

  if (barrier === 'other' && attempts >= 2) {
    return {
      barrier: 'no_reply',
      reply: MOCK_AGENT[lang].escalating(),
      action: 'escalate_to_volunteer',
      escalationNote: `Two contacts made, barrier not identified. Last message: "${last.text}". Referred to ${context.clinicName}.`,
    };
  }

  return {
    barrier,
    reply: MOCK_AGENT[lang].resolve(barrier, context),
    action: 'resolve_barrier',
  };
}

/**
 * Fallback agent phrasing. English is authoritative; other languages pending
 * native-speaker review before field use.
 */
const MOCK_AGENT = {
  en: {
    opening: (d) => `Assalamu alaikum. This is an automated assistant from the ABF health programme. ${d === 3 ? 'A few days ago' : 'Last week'} you were given a slip to visit a clinic. Were you able to go?`,
    resolve: (b, c) => ({
      unknown_location: `It is ${c.clinicName}, ${c.clinicDetail}. At the desk just say you were sent from the mosque health screening and show the slip.`,
      cannot_take_leave: `That makes sense. ${c.eveningClinic} is open later, so you would not need to take a day off. Would that work better?`,
      cost: `You will not have to pay for this. You qualify under ${c.scheme}, which covers the consultation and the basic tests. Show the slip at the desk.`,
      not_serious: `That is fair, and you may well be fine. The reading was higher than we expect, and it is the kind of thing that is easy to deal with early. Would it help if I explained it to someone in your family?`,
      other: `Understood. Is there something making it difficult to get there? I may be able to help with that.`,
    }[b]),
    completed: (collected) => collected
      ? 'That is good to hear, thank you for letting me know. That is everything from me.'
      : 'Good, thank you for going. One last thing, were you able to collect the medicine the doctor advised?',
    escalating: () => 'Thank you. I will ask someone from the local team to get in touch with you directly.',
  },
  ur: {
    opening: (d) => `السلام علیکم۔ یہ اے بی ایف صحت پروگرام کا خودکار پیغام ہے۔ ${d === 3 ? 'کچھ دن پہلے' : 'پچھلے ہفتے'} آپ کو کلینک جانے کی پرچی دی گئی تھی۔ کیا آپ جا سکے؟`,
    resolve: (b, c) => ({
      unknown_location: `وہ ${c.clinicName} ہے، ${c.clinicDetail}۔ کاؤنٹر پر بس کہہ دیجیے کہ مسجد کی صحت جانچ سے بھیجا گیا ہے اور پرچی دکھا دیجیے۔`,
      cannot_take_leave: `سمجھ سکتا ہوں۔ ${c.eveningClinic} دیر تک کھلا رہتا ہے، تو چھٹی لینے کی ضرورت نہیں ہوگی۔ کیا یہ بہتر رہے گا؟`,
      cost: `آپ کو پیسے نہیں دینے پڑیں گے۔ آپ ${c.scheme} کے تحت آتے ہیں، اس میں ڈاکٹر کی فیس اور بنیادی ٹیسٹ شامل ہیں۔ کاؤنٹر پر پرچی دکھا دیجیے۔`,
      not_serious: `ہو سکتا ہے آپ بالکل ٹھیک ہوں۔ بس ایک پیمائش توقع سے زیادہ تھی، اور ایسی چیزیں شروع میں آسانی سے سنبھل جاتی ہیں۔ کیا میں آپ کے گھر کے کسی فرد کو سمجھا دوں؟`,
      other: `سمجھ گیا۔ کیا کوئی چیز جانے میں رکاوٹ بن رہی ہے؟ شاید میں اس میں مدد کر سکوں۔`,
    }[b]),
    completed: (collected) => collected
      ? 'یہ جان کر خوشی ہوئی، بتانے کا شکریہ۔ میری طرف سے بس اتنا ہی۔'
      : 'اچھا ہوا کہ آپ گئے، شکریہ۔ ایک آخری بات، کیا آپ ڈاکٹر کی بتائی ہوئی دوا لے سکے؟',
    escalating: () => 'شکریہ۔ میں مقامی ٹیم سے کہتا ہوں کہ وہ آپ سے براہِ راست رابطہ کریں۔',
  },
  kn: {
    opening: (d) => `ನಮಸ್ಕಾರ. ಇದು ABF ಆರೋಗ್ಯ ಕಾರ್ಯಕ್ರಮದ ಸ್ವಯಂಚಾಲಿತ ಸಂದೇಶ. ${d === 3 ? 'ಕೆಲವು ದಿನಗಳ ಹಿಂದೆ' : 'ಕಳೆದ ವಾರ'} ನಿಮಗೆ ಚಿಕಿತ್ಸಾಲಯಕ್ಕೆ ಹೋಗಲು ಚೀಟಿ ಕೊಟ್ಟಿದ್ದೆವು. ಹೋಗಲು ಆಯಿತೇ?`,
    resolve: (b, c) => ({
      unknown_location: `ಅದು ${c.clinicName}, ${c.clinicDetail}. ಕೌಂಟರ್‌ನಲ್ಲಿ ಮಸೀದಿ ಆರೋಗ್ಯ ತಪಾಸಣೆಯಿಂದ ಬಂದಿದ್ದೇನೆ ಎಂದು ಹೇಳಿ ಚೀಟಿ ತೋರಿಸಿ.`,
      cannot_take_leave: `ಅರ್ಥವಾಗುತ್ತದೆ. ${c.eveningClinic} ಸಂಜೆ ತಡವಾಗಿಯೂ ತೆರೆದಿರುತ್ತದೆ, ರಜೆ ಹಾಕುವ ಅಗತ್ಯವಿಲ್ಲ. ಇದು ಅನುಕೂಲವಾಗುತ್ತದೆಯೇ?`,
      cost: `ನೀವು ಹಣ ಕೊಡಬೇಕಿಲ್ಲ. ನೀವು ${c.scheme} ಅಡಿಯಲ್ಲಿ ಬರುತ್ತೀರಿ, ಅದರಲ್ಲಿ ವೈದ್ಯರ ಶುಲ್ಕ ಮತ್ತು ಮೂಲ ಪರೀಕ್ಷೆಗಳು ಸೇರಿವೆ. ಕೌಂಟರ್‌ನಲ್ಲಿ ಚೀಟಿ ತೋರಿಸಿ.`,
      not_serious: `ನೀವು ಚೆನ್ನಾಗಿಯೇ ಇರಬಹುದು. ಒಂದು ಅಳತೆ ನಿರೀಕ್ಷೆಗಿಂತ ಹೆಚ್ಚಿತ್ತು, ಇಂತಹವು ಆರಂಭದಲ್ಲಿ ಸುಲಭವಾಗಿ ಸರಿಹೋಗುತ್ತವೆ. ನಿಮ್ಮ ಮನೆಯವರಿಗೆ ವಿವರಿಸಲೇ?`,
      other: `ಅರ್ಥವಾಯಿತು. ಹೋಗಲು ಏನಾದರೂ ತೊಂದರೆ ಇದೆಯೇ? ಬಹುಶಃ ನಾನು ಸಹಾಯ ಮಾಡಬಹುದು.`,
    }[b]),
    completed: (collected) => collected
      ? 'ಒಳ್ಳೆಯದು, ತಿಳಿಸಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದ. ನನ್ನ ಕಡೆಯಿಂದ ಇಷ್ಟೇ.'
      : 'ಹೋಗಿದ್ದು ಒಳ್ಳೆಯದಾಯಿತು, ಧನ್ಯವಾದ. ಕೊನೆಯ ಪ್ರಶ್ನೆ, ವೈದ್ಯರು ಹೇಳಿದ ಔಷಧಿ ತೆಗೆದುಕೊಂಡಿರಾ?',
    escalating: () => 'ಧನ್ಯವಾದ. ಸ್ಥಳೀಯ ತಂಡದವರು ನಿಮ್ಮನ್ನು ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸುತ್ತಾರೆ.',
  },
  hi: {
    opening: (d) => `असलाम वालेकुम। यह ABF सेहत कार्यक्रम का स्वचालित संदेश है। ${d === 3 ? 'कुछ दिन पहले' : 'पिछले हफ़्ते'} आपको क्लिनिक जाने की पर्ची दी गई थी। क्या आप जा पाए?`,
    resolve: (b, c) => ({
      unknown_location: `वह ${c.clinicName} है, ${c.clinicDetail}। काउंटर पर बस कह दीजिए कि मस्जिद की सेहत जाँच से भेजा गया है और पर्ची दिखा दीजिए।`,
      cannot_take_leave: `समझ सकता हूँ। ${c.eveningClinic} देर तक खुला रहता है, तो छुट्टी लेने की ज़रूरत नहीं होगी। क्या यह ठीक रहेगा?`,
      cost: `आपको पैसे नहीं देने होंगे। आप ${c.scheme} के तहत आते हैं, इसमें डॉक्टर की फीस और बुनियादी जाँच शामिल हैं। काउंटर पर पर्ची दिखा दीजिए।`,
      not_serious: `हो सकता है आप बिल्कुल ठीक हों। बस एक रीडिंग उम्मीद से ज़्यादा थी, और ऐसी चीज़ें शुरू में आसानी से सँभल जाती हैं। क्या मैं आपके घर में किसी को समझा दूँ?`,
      other: `समझ गया। क्या कोई चीज़ जाने में रुकावट बन रही है? शायद मैं उसमें मदद कर सकूँ।`,
    }[b]),
    completed: (collected) => collected
      ? 'यह जानकर अच्छा लगा, बताने के लिए शुक्रिया। मेरी तरफ़ से बस इतना ही।'
      : 'अच्छा हुआ कि आप गए, शुक्रिया। एक आख़िरी बात, क्या आप डॉक्टर की बताई दवा ले पाए?',
    escalating: () => 'शुक्रिया। मैं स्थानीय टीम से कहता हूँ कि वे आपसे सीधे संपर्क करें।',
  },
  ta: {
    opening: (d) => `வணக்கம். இது ABF சுகாதாரத் திட்டத்தின் தானியங்கி செய்தி. ${d === 3 ? 'சில நாட்களுக்கு முன்' : 'கடந்த வாரம்'} உங்களுக்கு மருத்துவமனைக்குச் செல்ல சீட்டு கொடுக்கப்பட்டது. செல்ல முடிந்ததா?`,
    resolve: (b, c) => ({
      unknown_location: `அது ${c.clinicName}, ${c.clinicDetail}. கவுண்டரில் பள்ளிவாசல் உடல்நல பரிசோதனையிலிருந்து வந்தேன் என்று சொல்லி சீட்டைக் காட்டுங்கள்.`,
      cannot_take_leave: `புரிகிறது. ${c.eveningClinic} மாலையிலும் திறந்திருக்கும், விடுப்பு எடுக்க வேண்டியதில்லை. இது வசதியாக இருக்குமா?`,
      cost: `நீங்கள் பணம் கொடுக்க வேண்டியதில்லை. ${c.scheme} திட்டத்தில் நீங்கள் வருகிறீர்கள், அதில் மருத்துவர் கட்டணமும் அடிப்படை பரிசோதனைகளும் அடங்கும். சீட்டைக் காட்டுங்கள்.`,
      not_serious: `நீங்கள் நன்றாகவே இருக்கலாம். ஒரு அளவீடு எதிர்பார்த்ததை விட அதிகமாக இருந்தது, இதுபோன்றவை ஆரம்பத்திலேயே எளிதாக சரியாகும். உங்கள் வீட்டில் யாருக்காவது விளக்கவா?`,
      other: `புரிந்தது. செல்வதற்கு ஏதேனும் தடையாக உள்ளதா? நான் உதவ முடியும்.`,
    }[b]),
    completed: (collected) => collected
      ? 'நல்லது, தெரிவித்ததற்கு நன்றி. என் பக்கம் இதுவே இறுதி.'
      : 'சென்றது நல்லது, நன்றி. கடைசியாக ஒன்று, மருத்துவர் சொன்ன மருந்தை வாங்க முடிந்ததா?',
    escalating: () => 'நன்றி. உள்ளூர் குழுவினர் உங்களை நேரடியாகத் தொடர்பு கொள்வார்கள்.',
  },
};

/** Exposed so app.js can open a thread without a model call. */
export function openingMessage(language, dayNumber) {
  const lang = MOCK_AGENT[language] ? language : 'en';
  return MOCK_AGENT[lang].opening(dayNumber);
}
