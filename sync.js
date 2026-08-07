/* =====================================================================
   LAUNCH WINDOW — Live sync layer
   =====================================================================

   Wraps Firebase Realtime Database. Everything here is OPTIONAL: if the
   config is missing, the SDK fails to load, the school Wi-Fi blocks Google,
   or the network dies mid-session, every function below becomes a safe no-op
   and the game continues in solo mode.

   THE GAME ENGINE NEVER READS FROM THIS FILE. All scoring happens on the
   phone. Sync carries three things only:
       1. which round the instructor has opened
       2. each student's dilemma vote (for the live poll)
       3. each student's current score (for the live leaderboard)

   That means a dropped connection costs you visibility, never a student's game.

   Data model
   ----------
   rooms/{CODE}/meta            { createdAt, openRound, phase }
   rooms/{CODE}/players/{pid}   { name, team, round, score, done, ts }
   rooms/{CODE}/votes/{n}/{pid} "A" | "B" | "C"
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
  async function init(){
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
      return false;
    }
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
      await S.fb.set(ref, { createdAt: Date.now(), openRound: 0, phase: 'lobby' });
      return code;
    }
    return null;
  }

  async function setOpenRound(n){
    if (!guard()) return;
    try {
      await S.fb.update(r('meta'), { openRound: n, phase: n >= 1 ? 'playing' : 'lobby' });
    } catch(e){ console.warn('setOpenRound failed', e); }
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

  async function joinRoom(code, name, team){
    if (!S.enabled) return null;
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4}$/.test(code)) return null;
    if (!(await roomExists(code))) return null;

    S.code = code;
    const pref = S.fb.push(r('players'));
    S.pid = pref.key;
    await S.fb.set(pref, {
      name: String(name).slice(0, 28),
      team: String(team || '').slice(0, 20),
      round: 0, score: 0, done: false, ts: Date.now()
    });
    // Tidy up if the phone closes the tab
    try { S.fb.onDisconnect(S.fb.ref(S.db, path('players', S.pid, 'ts'))).set(Date.now()); } catch(e){}
    return S.pid;
  }

  function onRoom(cb){
    if (!guard()) return;
    const un = S.fb.onValue(r('meta'), snap => cb(snap.val() || { openRound: 0, phase: 'lobby' }));
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
    init, onStatus, teardown,
    get enabled(){ return S.enabled; },
    get status(){ return S.status; },
    get code(){ return S.code; },
    get pid(){ return S.pid; },
    // host
    createRoom, setOpenRound, onPlayers, onVotes, endSession,
    // student
    joinRoom, roomExists, onRoom, submitVote, reportProgress
  };

})(typeof window !== 'undefined' ? window : globalThis);
