/* =====================================================================
   LAUNCH WINDOW — Firebase configuration
   =====================================================================

   THIS IS THE ONLY FILE YOU NEED TO EDIT TO TURN ON LIVE SYNC.

   Paste the config block from your Firebase project below, replacing the
   placeholder values. Step-by-step instructions with screenshots of where
   to click are in  FIREBASE SETUP.md  in this folder.

   If you leave this file exactly as it is, the game still works — it simply
   runs in solo mode with manual score entry, identical to Manual Package 1.
   Nothing breaks. There is no wrong state to leave this in.

   These keys are meant to be public. They identify your project; they do not
   grant access. Access is controlled by the security rules you paste into the
   Firebase console (see database.rules.json). Do not be alarmed that they are
   readable in your page source — that is how Firebase web apps work.
   ===================================================================== */

window.LW_FIREBASE = {

  // ---- paste your config here -------------------------------------
  apiKey:            "AIzaSyCsGc6JtawRoF66K3k68bTt3BehRG8l0ls",
  authDomain:        "launch-window-b7e70.firebaseapp.com",
  databaseURL:       "https://launch-window-b7e70-default-rtdb.firebaseio.com",
  projectId:         "launch-window-b7e70",
  appId:             "1:1032854489048:web:948c69a81bb0ec151a54ad"
  // ------------------------------------------------------------------

};

/* Version of the Firebase JavaScript SDK to load from Google's CDN.
   If Google ever retires this version, bump the number — nothing else changes. */
window.LW_FIREBASE_SDK_VERSION = "12.17.1";
