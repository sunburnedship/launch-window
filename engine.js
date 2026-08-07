/* =====================================================================
   LAUNCH WINDOW  —  Game Engine
   Pulse: an AI health wearable venture simulation
   ASU Technological Entrepreneurship & Management

   This file is the single source of truth for all game math.
   It is loaded by index.html (student app) and by simulate.js (balance
   testing) so the two can never drift apart.
   ===================================================================== */

(function (root) {
  'use strict';

  // ---------------------------------------------------------------
  // TUNING CONSTANTS
  // ---------------------------------------------------------------
  const CONFIG = {
    WEEKS_PER_ROUND: 10,

    // Per engineering-week effects
    BUILD:    { users: 6,  cash: 0.8, rSafety: 2, rData: 1, rBias: 1, trust: 0 },
    VALIDATE: { users: 0,  cash: -0.2, rSafety: -7, trust: 0.3 },
    PROTECT:  { users: 0,  cash: -0.2, rData:  -7, trust: 0.2 },
    AUDIT:    { users: 0,  cash: -0.2, rBias:  -7, trust: 0.3 },

    // Entropy: risk accumulates every quarter just from operating at scale
    DRIFT: { rSafety: 4, rData: 4, rBias: 4 },

    // Burn grows as the company scales — you cannot coast on the seed round
    BURN_BASE: 3,               // $M fixed operating cost in Q1
    BURN_PER_ROUND: 1.5,        // added each subsequent quarter
    TRUST_GROWTH_FACTOR: 0.12,  // users gained per point of trust above 50

    // Emergency financing when you run out of money
    RESCUE_CASH: 15,            // $M raised in a down round
    RESCUE_TRUST: -12,          // reputational cost of a fire sale
    RESCUE_USER_MULT: 0.85,     // layoffs and churn

    // Risk bands (numbers are never shown to students)
    BANDS: [
      { max: 24,  label: 'Low',      cls: 'band-low' },
      { max: 49,  label: 'Elevated', cls: 'band-elev' },
      { max: 74,  label: 'Serious',  cls: 'band-serious' },
      { max: 999, label: 'Critical', cls: 'band-critical' }
    ],

    // Checkpoint thresholds — aligned to band edges so outcomes feel fair
    MAJOR_THRESHOLD: 50,   // "Serious" or worse triggers a major failure
    MINOR_THRESHOLD: 25,   // "Elevated" triggers a warning

    // Final scoring weights.
    //
    // Trust is a MULTIPLIER on everything you built, not an additive term — and it
    // RAMPS IN over the six quarters. This is not a gimmick: early-stage companies
    // really are valued on growth, and mature ones really are valued on durability.
    // Mechanically it produces the moment the whole game is built around. Through Q3
    // the scoreboard is almost pure growth, so the students cutting corners lead it.
    // From Q4 the multiplier and the risk penalty phase in, and the board inverts in
    // front of the room.
    SCORE: {
      users: 8,
      cash: 6,
      trustSwing: 0.4,   // at full ramp, trust 0 -> 0.6x and trust 100 -> 1.4x
      risk: -1.5,
      rampRounds: 5      // ramp reaches 1.0 at round 6
    },
    INTEGRITY_BONUS: 250   // per risk meter finishing in the Low band
  };

  // ---------------------------------------------------------------
  // STARTING STATE
  // ---------------------------------------------------------------
  function newState(name, team) {
    return {
      name: name || '',
      team: team || '',
      round: 1,
      users: 0,      // thousands of active users
      cash: 12,      // $M in the bank (seed round)
      trust: 50,     // 0-100 public trust
      rSafety: 10,
      rData: 10,
      rBias: 18,     // starts elevated: the training data was already skewed
      log: [],       // narrative event log
      history: [],   // per-round snapshots
      choices: []    // record of dilemma answers
    };
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function band(v) {
    for (const b of CONFIG.BANDS) if (v <= b.max) return b;
    return CONFIG.BANDS[CONFIG.BANDS.length - 1];
  }

  // ---------------------------------------------------------------
  // ROUND CONTENT
  // ---------------------------------------------------------------
  const ROUNDS = [
    {
      n: 1,
      quarter: 'Q1',
      title: 'The Keynote',
      brief:
        'Pulse detects irregular heart rhythms from the wrist and, using your AI model, tells the user ' +
        'what to do next. In your own lab testing it is right 71% of the time. ' +
        'A major tech conference just offered you the opening keynote. Your head of marketing has ' +
        'written a slide that says "clinical-grade accuracy."',
      question: 'What goes on the slide?',
      options: [
        {
          key: 'A',
          label: 'Say "clinical-grade accuracy."',
          sub: 'Not a regulated term. Investors will love it.',
          fx: { users: 45, cash: 8, trust: -4, rSafety: 35 },
          result:
            'The keynote goes viral. Two VCs email you before you leave the stage. A cardiologist ' +
            'posts a thread asking which clinical trial you are referring to. You do not reply.'
        },
        {
          key: 'B',
          label: 'Say "early research prototype."',
          sub: 'Honest, less exciting, fewer signups.',
          fx: { users: 18, trust: 10, rSafety: 2 },
          result:
            'The room is politely interested rather than electrified. But three research hospitals ' +
            'reach out about a pilot, and the cardiology community starts treating you as serious.'
        },
        {
          key: 'C',
          label: 'Skip the keynote and keep testing.',
          sub: 'Nobody hears about you this quarter.',
          fx: { users: 5, cash: -3, rSafety: -18, trust: 4 },
          result:
            'You spend the quarter running accuracy studies instead of shaking hands. Accuracy climbs ' +
            'to 84%. Your competitor takes the keynote slot and gets the magazine cover.'
        }
      ]
    },
    {
      n: 2,
      quarter: 'Q2',
      title: 'Whose Bodies?',
      brief:
        'Your AI learned from 12,000 users. 84% of them are white adults between 25 and 45. ' +
        'Your optical sensor is measurably less accurate on darker skin tones, and you have almost no ' +
        'training data from teenagers — who are a third of your waitlist. Collecting a representative ' +
        'dataset costs one quarter and $6M.',
      question: 'How do you handle the gap?',
      options: [
        {
          key: 'A',
          label: 'Ship now. Fix it in a later version.',
          sub: 'Every startup carries technical debt.',
          fx: { users: 50, cash: 5, trust: -5, rBias: 42, rSafety: 6 },
          result:
            'Growth is excellent. Support tickets from users with darker skin tones climb 4x, and your ' +
            'team quietly labels them "sensor fit issues" in the tracker.'
        },
        {
          key: 'B',
          label: 'Ship with an on-screen accuracy notice.',
          sub: 'Tell affected users the model is less reliable for them.',
          fx: { users: 28, trust: 8, rBias: 12 },
          result:
            'Some users are annoyed by the banner. Others screenshot it approvingly. You have not fixed ' +
            'the problem, but nobody can say you hid it.'
        },
        {
          key: 'C',
          label: 'Delay a quarter and collect the data.',
          sub: 'Costs $6M and a quarter of growth.',
          fx: { users: 6, cash: -6, rBias: -30, trust: 14 },
          result:
            'A painful quarter. But accuracy across skin tones converges to within 3 points, and the new ' +
            'model finally works on adolescent heart rates. Your engineers are proud of this one.'
        }
      ]
    },
    {
      n: 3,
      quarter: 'Q3',
      title: 'The Offer',
      brief:
        'A pharmaceutical analytics firm offers $18M for de-identified Pulse health data. Your terms of ' +
        'service — which 0.4% of users have read — technically permit this. Researchers have repeatedly ' +
        'shown that "de-identified" health data can often be re-identified by cross-referencing it with ' +
        'other datasets.',
      question: 'Do you take the money?',
      options: [
        {
          key: 'A',
          label: 'Take the deal. Say nothing.',
          sub: '$18M buys you eighteen months of runway.',
          fx: { cash: 18, users: 8, trust: -6, rData: 42 },
          result:
            'The money hits the bank and your CFO is thrilled. A copy of your users’ health data now ' +
            'exists on four servers you do not control.'
        },
        {
          key: 'B',
          label: 'Take it, but ask users to opt in first.',
          sub: 'Only 38% will say yes, so the price drops.',
          fx: { cash: 7, trust: 12, rData: 8, users: 5 },
          result:
            'The buyer pays less for a smaller dataset. But 38% of your users actively chose to contribute ' +
            'to medical research, and several of them tell their friends about it.'
        },
        {
          key: 'C',
          label: 'Decline.',
          sub: 'No money. No exposure.',
          fx: { trust: 18, rData: -10, users: 8 },
          result:
            'You turn down the largest check anyone has offered you. Your board is not delighted. ' +
            'You put "we do not sell your health data" on the homepage, and it converts well.'
        }
      ]
    },
    {
      n: 4,
      quarter: 'Q4',
      title: 'The Recommender',
      brief:
        'Pulse now tells users what to do: "your readings suggest you should contact a physician today." ' +
        'Right now a licensed clinician reviews every flagged case before the user sees it. That costs ' +
        '$4M a quarter and delays the alert by up to six hours. Removing the human makes it instant — and ' +
        'your growth team says instant alerts are the killer feature.',
      question: 'Who reviews the AI?',
      warning: 'Your board has scheduled an FDA pre-submission review for the end of this quarter.',
      options: [
        {
          key: 'A',
          label: 'Remove human review entirely.',
          sub: 'Instant alerts. $4M a quarter saved.',
          fx: { users: 45, cash: 6, trust: -5, rSafety: 38 },
          result:
            'Alerts are instant and users love it. In week nine the model tells 340 healthy people to go ' +
            'to an emergency room. Eleven of them do.'
        },
        {
          key: 'B',
          label: 'Keep review for high-severity alerts only.',
          sub: 'A compromise. Most alerts go straight through.',
          fx: { users: 24, cash: 2, trust: 2, rSafety: 8 },
          result:
            'Routine alerts are instant; the frightening ones get a human first. Your clinical advisor ' +
            'calls this "defensible."'
        },
        {
          key: 'C',
          label: 'Keep full review and publish the policy.',
          sub: 'Slower. Expensive. Say it out loud.',
          fx: { users: 12, cash: -4, trust: 15, rSafety: -14 },
          result:
            'You publish "every Pulse health alert is reviewed by a licensed clinician." Two pediatric ' +
            'hospital systems begin recommending Pulse to families.'
        }
      ]
    },
    {
      n: 5,
      quarter: 'Q5',
      title: 'The Competitor',
      brief:
        'A rival launches at half your price with a flashier AI, and your growth flatlines. Your ' +
        'engineering lead says the new "predictive diagnosis" feature could ship in three weeks instead ' +
        'of twelve — if you skip the false-positive study. Telling a healthy sixteen-year-old that they ' +
        'may have a heart condition is not a small thing.',
      question: 'How fast do you ship?',
      options: [
        {
          key: 'A',
          label: 'Three weeks. Beat them to market.',
          sub: 'Skip the false-positive study.',
          fx: { users: 55, cash: 10, trust: -6, rSafety: 40, rBias: 12 },
          result:
            'You launch first and the press calls it a comeback. Your support queue fills with messages ' +
            'from frightened parents. You do not know your false-positive rate, because you did not measure it.'
        },
        {
          key: 'B',
          label: 'Six weeks. Adults only at first.',
          sub: 'Limit the blast radius while you learn.',
          fx: { users: 30, cash: 3, trust: 3, rSafety: 10 },
          result:
            'You lose the launch race but gather real-world data on a population you understand. ' +
            'The teen version ships next quarter with far better numbers.'
        },
        {
          key: 'C',
          label: 'Take the full twelve weeks.',
          sub: 'Do the study. Lose the quarter.',
          fx: { users: 10, cash: -2, trust: 14, rSafety: -12 },
          result:
            'The study finds a 9% false-positive rate in adolescents and you fix it before launch. ' +
            'Nobody outside the company will ever know this happened. Your competitor takes the quarter.'
        }
      ]
    },
    {
      n: 6,
      quarter: 'Q6',
      title: 'The Reporter',
      brief:
        'A journalist is writing a major feature on AI health wearables. She asks you for two things: ' +
        'your accuracy data broken down by age and skin tone, and a list of every organization you have ' +
        'shared user data with. She is publishing in three weeks with or without you.',
      question: 'What do you send her?',
      warning: 'Whatever you have been carrying quietly is about to become public.',
      options: [
        {
          key: 'A',
          label: 'Decline to comment.',
          sub: 'Say nothing and hope the story is boring.',
          fx: { trust: -14, rData: 16, rBias: 16 },
          result:
            'The piece runs with the line "Pulse did not respond to repeated requests for comment," ' +
            'which readers correctly interpret as an answer.'
        },
        {
          key: 'B',
          label: 'Share selectively — your best numbers.',
          sub: 'Technically true. Strategically incomplete.',
          fx: { trust: -2, rData: 18, rBias: 18, users: 10 },
          result:
            'She notices the gaps. She always notices the gaps. She files a public records request instead.'
        },
        {
          key: 'C',
          label: 'Publish everything, including the gaps.',
          sub: 'Full disclosure, including where you fall short.',
          fx: { trust: 22, rData: -16, rBias: -16, users: -8 },
          result:
            'The article is not flattering — but it is fair, and it names Pulse as the only company in the ' +
            'category that answered the question. Three competitors get subpoenas. You get a paragraph.'
        }
      ]
    }
  ];

  // ---------------------------------------------------------------
  // ALLOCATION TRACKS
  // ---------------------------------------------------------------
  const TRACKS = [
    { key: 'build',    name: 'BUILD',    tag: 'Features & growth',  color: '#FFC627',
      desc: 'New features, marketing, scale. Grows users and revenue — and quietly grows every kind of risk.' },
    { key: 'validate', name: 'VALIDATE', tag: 'Safety testing',     color: '#4CC9F0',
      desc: 'Accuracy studies, false-positive analysis, failure testing. Lowers Safety Risk.' },
    { key: 'protect',  name: 'PROTECT',  tag: 'Privacy & security', color: '#7BDFA0',
      desc: 'Encryption, access controls, consent design, data minimization. Lowers Data Risk.' },
    { key: 'audit',    name: 'AUDIT',    tag: 'Fairness testing',   color: '#C77DFF',
      desc: 'Testing the model across skin tones, ages and body types; correcting the training set. Lowers Bias Risk.' }
  ];

  // ---------------------------------------------------------------
  // APPLY AN ALLOCATION  {build, validate, protect, audit}
  // ---------------------------------------------------------------
  function applyAllocation(s, a) {
    const C = CONFIG;
    const w = k => a[k] || 0;

    s.users   += w('build') * C.BUILD.users;
    s.cash    += w('build') * C.BUILD.cash;
    s.rSafety += w('build') * C.BUILD.rSafety;
    s.rData   += w('build') * C.BUILD.rData;
    s.rBias   += w('build') * C.BUILD.rBias;

    s.rSafety += w('validate') * C.VALIDATE.rSafety;
    s.trust   += w('validate') * C.VALIDATE.trust;
    s.rData   += w('protect')  * C.PROTECT.rData;
    s.trust   += w('protect')  * C.PROTECT.trust;
    s.rBias   += w('audit')    * C.AUDIT.rBias;
    s.trust   += w('audit')    * C.AUDIT.trust;

    s.cash += (w('validate') + w('protect') + w('audit')) * -0.2;

    // Quarterly entropy and burn
    s.rSafety += C.DRIFT.rSafety;
    s.rData   += C.DRIFT.rData;
    s.rBias   += C.DRIFT.rBias;
    s.cash    -= (C.BURN_BASE + C.BURN_PER_ROUND * (s.round - 1));

    // Word of mouth: trust above 50 compounds into growth as you scale
    if (s.trust > 50) s.users += (s.trust - 50) * C.TRUST_GROWTH_FACTOR * (1 + s.round * 0.2);

    normalize(s);
  }

  // Run out of money and you take an emergency down round. This closes the
  // "spend everything on safety and never grow" degenerate strategy.
  function checkSolvency(s) {
    if (s.cash >= 0) return null;
    const C = CONFIG;
    s.cash += C.RESCUE_CASH;
    s.trust += C.RESCUE_TRUST;
    s.users *= C.RESCUE_USER_MULT;
    normalize(s);
    const ev = {
      severity: 'minor', icon: '$',
      title: 'EMERGENCY FINANCING',
      body: 'You ran out of money. Your investors put in $' + C.RESCUE_CASH + 'M at a punishing valuation ' +
            'and you lay off part of the team. The product survives; the momentum does not.',
      lesson: 'Being right about the risk does not help if you cannot make payroll. Responsible companies still have to be companies.'
    };
    s.log.push(ev);
    return ev;
  }

  function applyChoice(s, fx) {
    for (const k of ['users', 'cash', 'trust', 'rSafety', 'rData', 'rBias']) {
      if (fx[k]) s[k] += fx[k];
    }
    normalize(s);
  }

  function normalize(s) {
    s.trust   = clamp(s.trust, 0, 100);
    s.rSafety = clamp(s.rSafety, 0, 100);
    s.rData   = clamp(s.rData, 0, 100);
    s.rBias   = clamp(s.rBias, 0, 100);
    s.users   = Math.max(0, s.users);
  }

  // ---------------------------------------------------------------
  // CHECKPOINTS — deterministic, so students control their own fate
  // ---------------------------------------------------------------
  function checkpoint(s, which) {
    const events = [];
    const MAJ = CONFIG.MAJOR_THRESHOLD, MIN = CONFIG.MINOR_THRESHOLD;

    if (which === 'regulatory') {
      if (s.rSafety >= MAJ) {
        s.users *= 0.45; s.cash -= 15; s.trust -= 28;
        events.push({
          severity: 'major', icon: '⚠',
          title: 'RECALL — FDA Class II',
          body: 'The FDA reviews your accuracy claims against your clinical evidence and finds a gap ' +
                'between the two. Pulse is pulled from shelves pending correction. More than half your ' +
                'users stop opening the app. Your general counsel begins every sentence with "unfortunately."',
          lesson: 'Safety debt does not stay quiet. It waits for the moment it will cost the most.'
        });
      } else if (s.rSafety >= MIN) {
        s.cash -= 5; s.trust -= 8;
        events.push({
          severity: 'minor', icon: '!',
          title: 'FDA Warning Letter',
          body: 'Regulators flag your marketing language and require corrective disclosures within 60 days. ' +
                'Embarrassing and expensive, but survivable.',
          lesson: 'You got the cheap version of this lesson. Most companies do not.'
        });
      } else {
        s.cash += 6; s.trust += 12; s.users += 25;
        events.push({
          severity: 'good', icon: '✓',
          title: 'FDA Clearance Pathway Granted',
          body: 'Your evidence holds up. Pulse is cleared to market its detection feature as validated — ' +
                'a claim your competitors legally cannot make. Two insurers open partnership talks.',
          lesson: 'The testing you paid for quietly became the thing your competitors cannot copy.'
        });
      }
    }

    if (which === 'reckoning') {
      if (s.rData >= MAJ) {
        s.users *= 0.6; s.cash -= 12; s.trust -= 25;
        events.push({
          severity: 'major', icon: '⚠',
          title: 'BREACH — 2.1M Health Records Exposed',
          body: 'An unsecured analytics endpoint exposes user health records, including data you shared ' +
                'with partners. Researchers re-identify 40,000 individuals within a week. You are now a ' +
                'case study, and not the good kind.',
          lesson: 'Every copy of a dataset is a copy you will one day have to defend.'
        });
      } else if (s.rData >= MIN) {
        s.trust -= 10; s.cash -= 4;
        events.push({
          severity: 'minor', icon: '!',
          title: 'Privacy Complaint Filed',
          body: 'A state attorney general opens an inquiry into your consent language. No breach, but a ' +
                'costly quarter of lawyers and a bad news cycle.',
          lesson: 'Consent that nobody understood is not really consent.'
        });
      } else {
        s.trust += 10; s.users += 15;
        events.push({
          severity: 'good', icon: '✓',
          title: 'Independent Privacy Audit Passed',
          body: 'An outside audit finds your data practices match your public claims. A school district ' +
                'approves Pulse for a student athlete program — the first in the category.',
          lesson: 'Trust is slow to build and it is the only thing that compounds.'
        });
      }

      if (s.rBias >= MAJ) {
        s.users *= 0.7; s.trust -= 22; s.cash -= 8;
        events.push({
          severity: 'major', icon: '⚠',
          title: 'INVESTIGATION — "Pulse Works Better On Some People"',
          body: 'A university research team publishes an audit showing your model misses arrhythmias in ' +
                'users with darker skin at nearly three times the rate. The finding is picked up everywhere. ' +
                'Two hospital partners suspend their pilots the same day.',
          lesson: 'A model is only as fair as the data it learned from. That is an engineering decision, not an accident.'
        });
      } else if (s.rBias >= MIN) {
        s.trust -= 8;
        events.push({
          severity: 'minor', icon: '!',
          title: 'Accuracy Gap Reported',
          body: 'The article notes measurable performance differences across user groups. You are cited as ' +
                'a company that knows about the problem and says it is working on it.',
          lesson: 'Knowing about the gap is better than not knowing. Closing it is better still.'
        });
      } else {
        s.trust += 12; s.users += 20;
        events.push({
          severity: 'good', icon: '✓',
          title: 'Named the Category Benchmark',
          body: 'The audit finds Pulse performs within 3 points across every group tested. The journalist ' +
                'calls it "the only one that worked for everybody," and that sentence is worth more than ' +
                'any ad you could have bought.',
          lesson: 'Designing for everyone was the growth strategy the whole time.'
        });
      }
    }

    normalize(s);
    events.forEach(e => s.log.push(e));
    return events;
  }

  // ---------------------------------------------------------------
  // FINAL SCORING
  // ---------------------------------------------------------------
  function score(s, roundOverride) {
    const W = CONFIG.SCORE;
    const riskTotal = s.rSafety + s.rData + s.rBias;

    // How far through the game are we? Determines how much the market has
    // repriced you on trust rather than on raw growth.
    const r = roundOverride != null ? roundOverride : (s.round || ROUNDS.length);
    const ramp = clamp((r - 1) / W.rampRounds, 0, 1);

    const built = s.users * W.users + s.cash * W.cash;
    const trustMult = 1 + ((s.trust - 50) / 50) * W.trustSwing * ramp;

    const parts = {
      built:      Math.round(built),
      ramp:       +ramp.toFixed(2),
      trustMult:  +trustMult.toFixed(2),
      multiplied: Math.round(built * trustMult),
      risk:       Math.round(riskTotal * W.risk * ramp)
    };

    let bonus = 0;
    const clean = [];
    if (s.rSafety < CONFIG.MINOR_THRESHOLD) { bonus += CONFIG.INTEGRITY_BONUS; clean.push('Safety'); }
    if (s.rData   < CONFIG.MINOR_THRESHOLD) { bonus += CONFIG.INTEGRITY_BONUS; clean.push('Data'); }
    if (s.rBias   < CONFIG.MINOR_THRESHOLD) { bonus += CONFIG.INTEGRITY_BONUS; clean.push('Fairness'); }
    bonus = Math.round(bonus * ramp);
    parts.integrity = bonus;
    parts.integrityCategories = clean;

    const total = Math.max(0, parts.multiplied + parts.risk + bonus);
    return { total, parts, riskTotal };
  }

  // ---------------------------------------------------------------
  // ARCHETYPES — printed on the certificate
  // ---------------------------------------------------------------
  function archetype(s, sc) {
    const risk = sc.riskTotal;
    const growth = s.users;

    if (risk < 75 && sc.total >= 3600)
      return { title: 'The Responsible Innovator',
               blurb: 'You grew fast and you grew clean. This is the hardest quadrant to reach, and it is the one real companies are judged by five years later.' };
    if (risk < 75 && growth < 150)
      return { title: 'The Guardian',
               blurb: 'Nothing you shipped ever hurt anyone. You also left a great deal of growth on the table. The discipline is real — now pair it with more ambition.' };
    if (risk >= 150 && growth >= 250)
      return { title: 'The Rocket',
               blurb: 'Spectacular growth, spectacular exposure. You built something people wanted before you knew whether it worked. A great many real companies do exactly this.' };
    if (risk >= 150)
      return { title: 'The Gambler',
               blurb: 'You took the risky path and did not get the growth to justify it. Worth asking which of those bets you would take again.' };
    if (sc.total >= 2400)
      return { title: 'The Balanced Builder',
               blurb: 'You read the tradeoffs and paid for the ones that mattered. This is what most good technology leadership actually looks like.' };
    return { title: 'The Survivor',
             blurb: 'Pulse is still standing. You learned the expensive lesson in a classroom instead of a courtroom, which is the entire point of this exercise.' };
  }

  // ---------------------------------------------------------------
  const API = {
    CONFIG, ROUNDS, TRACKS,
    newState, applyAllocation, applyChoice, checkpoint, checkSolvency, score, archetype, band, clamp, normalize
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.LaunchWindow = API;

})(typeof window !== 'undefined' ? window : globalThis);
