/* Pill or Rug - shared leaderboard client (talks to the Cloudflare Worker).
 * Plain script, no build step. Load it AFTER sim.js and BEFORE the main game <script>:
 *   <script>window.CONFIG = { API_BASE: 'https://<your-worker>.workers.dev' };</script>  (in <head>)
 *   <script src="score-client.js"></script>
 * If API_BASE is empty or the Worker is down, everything falls back to local play/local scores.
 *
 * API:
 *   PORScore.enabled                       -> true if an API base is configured
 *   PORScore.playerId()                    -> stable anonymous player id (random 128 bits, localStorage 'pill_pid').
 *                                             Sent with /seed and /submit; the server only keeps a salted hash of it.
 *                                             Clearing site data makes a new player (accepted limit).
 *   PORScore.prefetch(mode)                -> fetch a signed seed in the background ('normal' | 'daily')
 *                                             daily = today's secret chart, only the server knows it (no ticket = practice)
 *   PORScore.takeSeed(mode)                -> {seed, token, mode, day} SYNC (pre-fetched, still fresh) or null
 *                                             null => play with a local seed; the run is NOT ranked online
 *   PORScore.submitRun(run, ticket, {wallet, name}) -> Promise<{status:'verified'|'unranked'|'rejected'|'offline', score, rank, runId, claim, error}>
 *   PORScore.claimName(runId, claim, name) -> Promise<{ok, name, error}>  (initials typed after the run was sent)
 *   PORScore.cleanInitials(s)              -> 'ABC' (3 chars A-Z0-9, not a bad word) or null
 *   PORScore.fetchLeaderboard(mode, limit) -> Promise<entries[] | null>   (null = unreachable)
 *   PORScore.fetchFeed()                   -> Promise<feed | null>   (TRENCH WIRE: latest verified runs, today's #1, deaths by cause)
 *   PORScore.toRows(entries)               -> rows for the game's renderLeaderboardList() (rid = run id)
 *   PORScore.badge(result)                 -> shows a small VERIFIED / REJECTED toast
 */
(function () {
  'use strict';
  // "sim3" etc. The Worker accepts only the sim version it was built with -> redeploy the Worker when sim.js changes.
  function clientVersion() { return 'sim' + ((window.PillSim && window.PillSim.SIM_VERSION) || 0); }
  var API = String((window.CONFIG && window.CONFIG.API_BASE) || window.PTP_API || '').replace(/\/+$/, '');
  var MAX_AGE_MS = 5 * 60 * 1000;         // server TTL is 10 min: a taken seed still has >= 5 min to be started
  var TIMEOUT_MS = 6000;
  var pool = { normal: null, daily: null };
  var PID = null;
  function playerId() {
    if (PID) return PID;
    try { PID = localStorage.getItem('pill_pid'); } catch (e) { PID = null; }
    if (!PID || !/^[A-Za-z0-9_-]{22,64}$/.test(PID)) {
      var b = new Uint8Array(16), s = '';
      (window.crypto || window.msCrypto).getRandomValues(b);
      for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
      PID = s;                              // 32 hex chars = 128 random bits
      try { localStorage.setItem('pill_pid', PID); } catch (e) { /* private mode: one id for this page load */ }
    }
    return PID;
  }
  var inflight = { normal: null, daily: null };

  function fetchJson(path, opts) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    opts = opts || {};
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }).then(function (b) { b._status = r.status; return b; });
    }).finally(function () { if (t) clearTimeout(t); });
  }

  function fresh(t) { return t && (Date.now() - t.got) < MAX_AGE_MS; }

  function prefetch(mode) {
    mode = mode === 'daily' ? 'daily' : 'normal';
    if (!API || fresh(pool[mode]) || inflight[mode]) return inflight[mode] || Promise.resolve(pool[mode]);
    inflight[mode] = fetchJson('/seed?mode=' + mode + '&pid=' + encodeURIComponent(playerId()), { cache: 'no-store' }).then(function (b) {
      if (b && b.ok && b.token) pool[mode] = { seed: b.seed >>> 0, token: b.token, mode: b.mode, day: b.day, got: Date.now() };
      return pool[mode];
    }).catch(function () { return null; }).finally(function () { inflight[mode] = null; });
    return inflight[mode];
  }

  function takeSeed(mode) {
    mode = mode === 'daily' ? 'daily' : 'normal';
    var t = fresh(pool[mode]) ? pool[mode] : null;
    pool[mode] = null;
    prefetch(mode);                       // keep one ready for the instant restart
    return t;
  }

  function submitRun(run, ticket, who) {
    if (!API || !ticket) return Promise.resolve({ status: 'offline' });
    if (!run || (run.seed >>> 0) !== ticket.seed) return Promise.resolve({ status: 'unranked', error: 'seed_not_from_server' });
    who = who || {};
    var body = {
      token: ticket.token, seed: ticket.seed, mode: ticket.mode,
      inputs: run.inputs, claimedScore: run.score, frames: run.frames,
      wallet: who.wallet || null, name: who.name || null, clientVersion: clientVersion(), pid: playerId()
    };
    return fetchJson('/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (b) {
        if (b && b.ok && b.verified) return { status: b.ranked ? 'verified' : 'unranked', score: b.score, rank: b.rank, runId: b.runId || null, claim: b.claim || null, name: b.name || null };
        return { status: 'rejected', error: (b && b.error) || 'unknown', message: b && b.message };
      })
      .catch(function () { return { status: 'offline' }; });
  }

  // 3-letter arcade initials. Same rules + list as the server (server/src/lib.js), the server has the last word.
  var BLOCKED = ('ASS FUK FUC FCK FKU FUQ CUM CUN CNT COK DIK DIC DIX JIZ TIT SEX PUS VAG SHT ' +
    'FAG FGT NIG NGR NGA NGG KKK KYS HOE SLT WHR NAZ').split(' ');
  var LEET = { '0': 'O', '1': 'I', '3': 'E', '4': 'A', '5': 'S', '7': 'T', '8': 'B' };
  function cleanInitials(n) {
    if (typeof n !== 'string') return null;
    var c = n.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    if (c.length !== 3) return null;
    var f = c.replace(/[0-9]/g, function (d) { return LEET[d] || d; });
    return BLOCKED.indexOf(c) >= 0 || BLOCKED.indexOf(f) >= 0 ? null : c;
  }

  function claimName(runId, claim, name) {
    if (!API || !runId || !claim) return Promise.resolve({ ok: false, error: 'offline' });
    return fetchJson('/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: runId, claim: claim, name: name }) })
      .then(function (b) { return b && b.ok ? { ok: true, name: b.name } : { ok: false, error: (b && b.error) || 'unknown' }; })
      .catch(function () { return { ok: false, error: 'offline' }; });
  }

  function fetchLeaderboard(mode, limit) {
    if (!API) return Promise.resolve(null);
    mode = mode === 'daily' ? 'daily' : 'normal';
    return fetchJson('/leaderboard?mode=' + mode + '&limit=' + (limit || 10))
      .then(function (b) { return b && b.ok ? b.entries : null; })
      .catch(function () { return null; });
  }

  function fetchFeed() {
    if (!API) return Promise.resolve(null);
    return fetchJson('/feed')
      .then(function (b) { return b && b.ok ? b : null; })
      .catch(function () { return null; });
  }

  // entries -> the shape the game's renderLeaderboardList() expects (+ name, shared)
  function toRows(entries) {
    return (entries || []).map(function (e) {
      return { score: Number(e.score) || 0, wallet: e.wallet || null, name: cleanInitials(e.name), rid: e.rid || null, mode: 'normal', date: e.created_at, shared: true };
    });
  }

  var toastEl = null;
  function badge(res) {
    if (!res || res.status === 'offline') return;
    var txt = res.status === 'verified' ? 'SCORE VERIFIED' + (res.rank ? '  #' + res.rank : '')
      : res.status === 'unranked' ? 'VERIFIED (NOT RANKED)'
      : 'SCORE REJECTED' + (res.error === 'old_client' ? ': RELOAD THE PAGE' : '');
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;padding:8px 12px;' +
        'font:10px Silkscreen,"Press Start 2P",monospace;letter-spacing:1px;border:2px solid #07060f;pointer-events:none;transition:opacity .4s;opacity:0';
      document.body.appendChild(toastEl);
    }
    // phone stage: the big REBUY / SHARE buttons own the bottom of the screen, so the toast goes to the top
    var top = document.body && document.body.classList.contains('stage');
    toastEl.style.top = top ? 'max(12px, env(safe-area-inset-top))' : 'auto';
    toastEl.style.bottom = top ? 'auto' : '16px';
    toastEl.textContent = txt;
    toastEl.style.background = '#07060f';
    toastEl.style.color = res.status === 'rejected' ? '#ff8f9f' : '#2ee88a';
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.style.opacity = '0'; }, 2600);
  }

  window.PORScore = {
    enabled: !!API, version: clientVersion, playerId: playerId,
    prefetch: prefetch, takeSeed: takeSeed, submitRun: submitRun, claimName: claimName,
    fetchLeaderboard: fetchLeaderboard, fetchFeed: fetchFeed, toRows: toRows, badge: badge, cleanInitials: cleanInitials
  };
  if (API) {
    prefetch('normal'); prefetch('daily');
    // keep one fresh seed per mode ready (no-op while still fresh): instant restart stays instant
    setInterval(function () { if (!document.hidden) { prefetch('normal'); prefetch('daily'); } }, 60000);
  }
})();
