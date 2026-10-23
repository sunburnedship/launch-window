/* =====================================================================
   LAUNCH WINDOW — Live sync layer
   =====================================================================

   Wraps Firebase Realtime Database. Everything here is OPTIONAL: if the
   config is missing, the SDK fails to load, the school Wi-Fi blocks Google,
   or the network dies mid-session, every function below becomes a safe no-op
   and the game continues in solo mode.

   THE GAME ENGINE NEVER READS FROM THIS FILE. All scoring happens on the
   phone. Sync carries three things only:
       1. which round the instructor has opened, and how far into it
       2. each student's dilemma vote (for the live poll)
       3. each student's current score (for the live leaderboard)

   That means a dropped connection costs you visibility, never a student's game.

   Data model
   ----------
   rooms/{CODE}/meta            { createdAt, openRound, phase }
   rooms/{CODE}/players/{pid}   { name, team, round, score, done, ts }
   rooms/{CODE}/votes/{n}/{pid} "A" | "B" | "C"

   The two gates
   -------------
   Each quarter opens in two steps: first PLANNING (students allocate their ten
   engineering weeks), then the DECISION (students see the dilemma and vote).
   Both gates ride in fields that already existed, so the database rules did not
   have to change:

       meta.openRound   highest quarter whose PLANNING is open   (0-6)
       meta.phase       "p<plan>d<decide>", e.g. "p3d2"

   phase carries both numbers rather than just the current step, so a phone that
   reloads mid-session reads one value and knows exactly where the room is. A
   student client that cannot parse phase falls back to openRound for both gates,
   which is the old one-button behaviour.
   ===================================================================== */

(function (root) {
  'use strict';

  const S = {
    enabled: false,       // did Firebase come up?
    status: 'off',        // off | connecting | live | lost | blocked
    code: null,           // room code
    pid: null,            // this player's id
    isHost: false,
    db: null, fb: null,
    _statusCbs: [],
    _unsubs: []
  };

  function setStatus(s, detail){
    if (S.status === s) return;
    S.status = s;
    S._statusCbs.forEach(cb => { try { cb(s, detail); } catch(e){} });
  }

  function configLooksReal(c){
    if (!c) return false;
    const vals = [c.apiKey, c.databaseURL, c.projectId];
    return vals.every(v => typeof v === 'string' && v.length > 0 && v.indexOf('PASTE_YOUR') === -1);
  }

  // ---------------------------------------------------------------
  // INIT — safe to call always; resolves to false rather than throwing
  // ---------------------------------------------------------------
  let _initPromise = null;

  async function init(){
    // One shared attempt. The student app calls this at boot AND again if the
    // student tries to join after a slow start; both should await the same work
    // rather than racing two Firebase apps into existence.
    if (_initPromise) return _initPromise;
    _initPromise = (async function(){
      const cfg = root.LW_FIREBASE;
      if (!configLooksReal(cfg)) { setStatus('off', 'not configured'); return false; }

      const v = root.LW_FIREBASE_SDK_VERSION || '12.17.1';
      const base = 'https://www.gstatic.com/firebasejs/' + v + '/';
      setStatus('connecting');

      try {
        const [appMod, dbMod, authMod] = await Promise.all([
          import(base + 'firebase-app.js'),
          import(base + 'firebase-database.js'),
          import(base + 'firebase-auth.js')
        ]);

        const app = appMod.initializeApp(cfg);

        // Anonymous auth: the security rules require a signed-in user, which keeps
        // random internet traffic out of your rooms. Students never see this happen.
        const auth = authMod.getAuth(app);
        await authMod.signInAnonymously(auth);

        S.fb = dbMod;
        S.db = dbMod.getDatabase(app);
        S.enabled = true;

        // Watch the connection so the UI can show an honest badge
        const connRef = dbMod.ref(S.db, '.info/connected');
        dbMod.onValue(connRef, snap => {
          setStatus(snap.val() ? 'live' : 'lost');
        });

        setStatus('live');
        return true;

      } catch (err) {
        // Blocked by network policy, offline, bad config, retired SDK version —
        // all land here, and all mean the same thing: play solo.
        console.warn('[Launch Window] Live sync unavailable, continuing in solo mode:', err && err.message);
        S.enabled = false;
        setStatus('blocked', err && err.message);
        _initPromise = null;          // allow a later retry when the student asks
        return false;
      }
    })();
    return _initPromise;
  }

  // ---------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------
  const path = (...p) => ['rooms', S.code].concat(p).join('/');
  function r(...p){ return S.fb.ref(S.db, path(...p)); }
  function guard(){ return S.enabled && S.code; }

  function makeCode(){
    // No I, O, 0, 1 — they get misread across a classroom.
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }

  // phase <-> gates. Unparseable or absent phase means "old host": fall back to
  // openRound for both gates, which is exactly the previous behaviour.
  function readGates(meta){
    meta = meta || {};
    const open = typeof meta.openRound === 'number' ? meta.openRound : 0;
    const m = /^p(\d)d(\d)$/.exec(String(meta.phase || ''));
    if (m) return { plan: +m[1], decide: +m[2] };
    return { plan: open, decide: open };
  }
  const writeGates = (plan, decide) => 'p' + plan + 'd' + decide;

  // ---------------------------------------------------------------
  // HOST
  // ---------------------------------------------------------------
  async function createRoom(){
    if (!S.enabled) return null;
    S.isHost = true;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeCode();
      const ref = S.fb.ref(S.db, 'rooms/' + code + '/meta');
      const snap = await S.fb.get(ref);
      if (snap.exists()) continue;              // collision, try again
      S.code = code;
      await S.fb.set(ref, { createdAt: Date.now(), openRound: 0, phase: writeGates(0, 0) });
      return code;
    }
    return null;
  }

  // Open both gates at once (kept for compatibility; equivalent to the old
  // single "Open Q3" button).
  async function setOpenRound(n){ return setGates(n, n); }

  async function setGates(plan, decide){
    if (!guard()) return;
    try {
      await S.fb.update(r('meta'), { openRound: plan, phase: writeGates(plan, decide) });
    } catch(e){ console.warn('setGates failed', e); }
  }

  function onPlayers(cb){
    if (!guard()) return;
    const ref = r('players');
    const un = S.fb.onValue(ref, snap => {
      const v = snap.val() || {};
      cb(Object.keys(v).map(k => Object.assign({ pid: k }, v[k])));
    });
    S._unsubs.push(un);
  }

  function onVotes(round, cb){
    if (!guard()) return function(){};
    const ref = r('votes', String(round));
    const un = S.fb.onValue(ref, snap => {
      const v = snap.val() || {};
      const tally = { A: 0, B: 0, C: 0 };
      Object.keys(v).forEach(k => { if (tally[v[k]] != null) tally[v[k]]++; });
      cb(tally, Object.keys(v).length);
    });
    S._unsubs.push(un);
    return un;
  }

  async function endSession(){
    if (!guard()) return;
    try { await S.fb.set(S.fb.ref(S.db, 'rooms/' + S.code), null); } catch(e){}
    S.code = null;
  }

  // ---------------------------------------------------------------
  // STUDENT
  // ---------------------------------------------------------------
  async function roomExists(code){
    if (!S.enabled) return false;
    try {
      const snap = await S.fb.get(S.fb.ref(S.db, 'rooms/' + code + '/meta'));
      return snap.exists();
    } catch(e){ return false; }
  }

  const cleanCode = c => String(c || '').trim().toUpperCase();
  const validCode = c => /^[A-Z2-9]{4}$/.test(c);

  async function joinRoom(code, name, team){
    if (!S.enabled) return null;
    code = cleanCode(code);
    if (!validCode(code)) return null;
    if (!(await roomExists(code))) return null;

    S.code = code;
    const pref = S.fb.push(r('players'));
    S.pid = pref.key;
    await S.fb.set(pref, {
      name: String(name).slice(0, 28),
      team: String(team || '').slice(0, 20),
      round: 0, score: 0, done: false, ts: Date.now()
    });
    watchDisconnect();
    return S.pid;
  }

  /* -----------------------------------------------------------------
     REJOIN — the fix for "my phone dropped and I couldn't get back in"

     S.code and S.pid live in memory only, so a reload (locked phone, tab
     evicted by iOS, accidental back-swipe, battery saver) loses them even
     though the student's game is safe in localStorage. The student app now
     saves the pair alongside the game and hands it back here.

     We re-attach to the EXISTING player row rather than pushing a new one,
     so the roster stays honest: one row per student, not one per reconnect.
     If the row is gone — instructor ended the session, or the student is on
     a different phone — we fall back to creating a fresh row carrying their
     current score, which still gets them onto the leaderboard.
     ----------------------------------------------------------------- */
  async function rejoinRoom(code, pid, fallback){
    if (!S.enabled) return null;
    code = cleanCode(code);
    if (!validCode(code) || !pid) return null;
    if (!(await roomExists(code))) return null;

    S.code = code;
    try {
      const snap = await S.fb.get(S.fb.ref(S.db, 'rooms/' + code + '/players/' + pid));
      if (snap.exists()) {
        S.pid = pid;
        watchDisconnect();
        return S.pid;
      }
    } catch(e){ /* fall through to a fresh row */ }

    if (fallback && fallback.name) {
      const pidNew = await joinRoom(code, fallback.name, fallback.team);
      if (pidNew && fallback.score != null) {
        await reportProgress(fallback.round || 0, fallback.score, !!fallback.done);
      }
      return pidNew;
    }
    S.code = null;
    return null;
  }

  function watchDisconnect(){
    // Tidy up if the phone closes the tab
    try { S.fb.onDisconnect(S.fb.ref(S.db, path('players', S.pid, 'ts'))).set(Date.now()); } catch(e){}
  }

  function onRoom(cb){
    if (!guard()) return;
    const un = S.fb.onValue(r('meta'), snap => cb(snap.val() || { openRound: 0, phase: writeGates(0,0) }));
    S._unsubs.push(un);
  }

  async function submitVote(round, key){
    if (!guard() || !S.pid) return;
    try { await S.fb.set(r('votes', String(round), S.pid), key); } catch(e){}
  }

  async function reportProgress(round, score, done){
    if (!guard() || !S.pid) return;
    try {
      await S.fb.update(r('players', S.pid), {
        round: round, score: Math.max(0, Math.round(score)), done: !!done, ts: Date.now()
      });
    } catch(e){}
  }

  // ---------------------------------------------------------------
  function onStatus(cb){ S._statusCbs.push(cb); cb(S.status); }
  function teardown(){ S._unsubs.forEach(u => { try{ u(); }catch(e){} }); S._unsubs = []; }

  root.LWSync = {
    init, onStatus, teardown, readGates,
    get enabled(){ return S.enabled; },
    get status(){ return S.status; },
    get code(){ return S.code; },
    get pid(){ return S.pid; },
    // host
    createRoom, setOpenRound, setGates, onPlayers, onVotes, endSession,
    // student
    joinRoom, rejoinRoom, roomExists, onRoom, submitVote, reportProgress
  };

})(typeof window !== 'undefined' ? window : globalThis);
