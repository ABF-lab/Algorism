# Sehat Ledger

**Zakat is no longer arriving as charity. It is arriving as a bill.**

Community zakat and sadaqah funds are being consumed by late-stage diabetes and
hypertension complications that were preventable at a screening cost of ₹12 to ₹15
per person. Sehat Ledger is an offline-first screening tool that turns a mosque
volunteer with a low-end Android phone into a preventive health worker, and
measures every screening as zakat capital preserved.

Built at **Algorism № 001**, Bengaluru, 26 July 2026, by the
**Active Bengaluru Foundation**. Track: Ummah.

---

## Run it

```bash
node serve.mjs      # or: npm start
```

Then open <http://localhost:8080>.

The application has **no build step, no bundler, no transpiler and no
dependencies** — six ES modules loaded natively by the browser. `serve.mjs`
exists only because browsers refuse to load ES modules over `file://`, and
because the camera and service worker require a secure context. It is never
deployed.

```bash
npm test            # 57 tests, no dependencies
```

There is also a **Run self-test** button under Setup, for machines with no Node.

## Deploy

Push to GitHub, then enable Pages on the repository root. That is the whole
deployment: static files, HTTPS, no configuration.

HTTPS is not optional. Browsers only expose `getUserMedia` and service workers
on a secure context, so **without HTTPS there is no camera and no offline mode**.
A LAN IP will not do.

---

## The two-minute demo

Open **Setup → Add sample records** first, so the committee dashboard is legible.
Then, with the phone in airplane mode:

1. **New screening → consent.** Read the script out; tick both boxes.
2. **Vitals → "Read the glucometer with the camera."** The value fills itself.
   With no API key it returns a labelled simulated reading of 214 mg/dL.
3. **See result.** Risk flags elevated. Nothing has touched the network.
4. **Make referral slip.** Generates in Urdu, naming the clinic and the scheme.
5. **Save and start follow-up → Send day 3 message.** Then simulate the reply:
   *"I could not go, the clinic is closed by the time I finish work."*
   The agent does not repeat itself — it surfaces the evening clinic.
6. **Reply again:** *"Yes I went and collected the medicine."* Referral marked complete.
7. **Ledger.** Only now does the figure move.

`test-flow.js` runs exactly this sequence headlessly, keyless, on every `npm test`.

---

## Architecture

| File | Responsibility |
|---|---|
| `clinical.js` | IDRS, BMI, BP, glucose, outcome escalation. Pure functions, no DOM, no network. |
| `ledger.js` | The zakat preservation model. Every assumption is a named constant. |
| `ai.js` | All three Gemini calls, each with a deterministic mock fallback. |
| `app.js` | Routing, screening flow, camera, threads, rendering. |
| `sw.js` | Offline shell. |
| `styles.css` | Design system. |

`clinical.js` and `ledger.js` depend on nothing else in the project. That is
deliberate: the two files a clinician or a treasurer would want to audit are the
two they can read without understanding the rest.

Storage is `localStorage` only. No backend, no database, no accounts. This is not
a shortcut, it is the privacy design — health data never leaves the handset, so
there is no server to breach and no third party in the chain. The airplane-mode
demo is not a simulation of offline capability; it is how the app actually runs.

Total payload: **~125 KB** across 11 files.

See [docs/architecture.md](docs/architecture.md) for the reasoning, and
[docs/business_strategy.md](docs/business_strategy.md) for the case.

---

## Where AI does the work

Three calls, each with a structured JSON response schema so output is parsed,
not scraped:

| Call | Job |
|---|---|
| `readDeviceScreen` | Reads digits from a glucometer or BP monitor. **Instructed to refuse rather than guess** — a wrong vital sign is worse than none. |
| `generateReferral` | Referral slip and counselling script in Urdu, Kannada, Hindi or Tamil, at the reader's literacy level. |
| `followUpTurn` | Classifies the barrier, decides the action, escalates to a volunteer. |

**Every call degrades to a labelled mock.** No key, no signal, or a rate limit
returns realistic simulated output that says on screen that it is simulated. A
demo that dies because the venue wifi died is not a demo, and output that
silently pretends to be live is worse than no output.

**Key handling.** Entered by the operator under Setup, held in `localStorage`,
never committed. On a public deployment this is a client-side key: restrict it by
referrer in AI Studio and rotate it after the event. Production moves the calls
behind a proxy.

---

## Honesty notes

Read these before demoing. Each is a limitation stated deliberately rather than
discovered by a judge.

- **Risk stratification is a deterministic rules engine**, calibrated to published
  ICMR and MDRF thresholds. It is not a trained model and must not be called one.
  A learned classifier needs screening volume that does not exist yet.
- **Every rupee figure is a projection** and is labelled as one everywhere it
  appears. The model is deliberately tuned to under-claim — see
  `CONSERVATISM_FACTOR` in `ledger.js`, which halves every output.
- **The observed figures are the strong ones.** ₹5,000 kit, ₹12–15 consumables and
  ₹1,58,880 annual dialysis support are ABF field-costed in Bengaluru. The
  complication-pathway probabilities are modelled, and testing them against real
  disbursement records is the entire purpose of Phase 1.
- **The clinic directory in `app.js` is placeholder data.** Illustrative entries so
  the referral flow is demonstrable. Replace with the real PHC and Namma Clinic
  list, with verified addresses and hours, before any field use. The model is
  instructed never to invent a clinic — it only repeats what this table gives it,
  so the accuracy of the referral is the accuracy of that table.
- **The non-English strings need native-speaker review.** Consent scripts, fallback
  slips and fallback agent phrasing are drafted, not verified. English is
  authoritative until someone signs off on the rest.
- **The follow-up agent runs against a simulated thread.** WhatsApp Business API
  approval outlasts a build day. The agent logic, barrier classification and
  escalation path are real; production substitutes the channel, not the system.
- **Ledger credit is gated on confirmed completion.** This produces a *smaller*
  number than counting slips issued. That is the point, and it is the only
  defensible figure.

---

## Consent, privacy and scope

- **This is screening, not diagnosis.** No condition is ever named to a patient.
  The output is always "see a doctor about this", never "you have diabetes".
  `test-clinical.js` and `test-flow.js` both assert this across every language.
- **Consent is captured before any reading is taken.** Consent to be contacted for
  follow-up is a separate opt-in, and declining it does not affect the screening.
  Where it is declined, the app refuses to open a follow-up thread at all.
- **The agent identifies itself as automated** in its first message, every time.
  It never diagnoses, never prescribes, and never changes medication.
- **Storage is on-device.** Erasure on request is one button under Setup, because
  the DPDP Act 2023 treats this as sensitive personal data and purpose
  limitation, consent and erasure are designed in rather than retrofitted.
- **Screening data is never shared with commercial parties**, aggregate or otherwise.

---

## Not built, on the roadmap

- Offline voice input in Kannada, Urdu, Hindi and Tamil
- Learned risk classifier — requires screening volume
- Geospatial density mapping to target intervention by cluster
- Live PHC and Namma Clinic availability integration
- Automated benefit eligibility checks against Ayushman Bharat and state schemes
- Multi-volunteer aggregation and a central committee dashboard, which need a
  backend. The record shape is already a flat serialisable object, so moving to
  Supabase with row-level security is additive.
