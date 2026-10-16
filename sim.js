/* =====================================================================
 *  PILL OR RUG - deterministic simulation (sim v5)
 *  ---------------------------------------------------------------------
 *  Pure logic: no DOM, no canvas, no Math.random, no wall clock, no
 *  Math.sin/cos (engine-dependent last bits). Same file runs in the
 *  browser (window.PillSim) and in Node (require('./sim.js')).
 *
 *  Contract:
 *    const s = PillSim.newSim(seed);              // uint32 seed
 *    PillSim.step(s, flap);                        // one 60 Hz tick, flap = bool
 *    ... until !s.alive
 *    PillSim.record(s) -> { v, sim, seed, inputs, score, frames, ... }
 *    PillSim.replay(run) -> { score, frames, ... } (must equal the record)
 *
 *  Timing: s.frame counts every tick (inputs are indexed by it).
 *          s.af counts "active" ticks (world time). They only differ
 *          while the CTO revive window freezes the world.
 *  The world (candles, phases, events) depends ONLY on seed + s.af,
 *  never on what the player does, so a ghost / a daily seed always
 *  sees the same chart.
 *  Optional hook: s.fx = function(name, a, b, c, d) for juice; it must
 *  never write to the sim. Leave it null on a server.
 * ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PillSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIM_VERSION = 5;

  // ---------- math helpers (IEEE-exact ops only) ----------
  function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t){ return a + (b - a) * t; }
  function mulberry32(a){ return function(){ let t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const PI = 3.141592653589793, TWO_PI = 6.283185307179586, HALF_PI = 1.5707963267948966;
  const C3 = -1 / 6, C5 = 1 / 120, C7 = -1 / 5040, C9 = 1 / 362880, C11 = -1 / 39916800;
  // deterministic sine: range reduction + Taylor polynomial (+ - * / floor only)
  function dsin(x){
    x = x - Math.floor(x / TWO_PI) * TWO_PI;
    if (x > PI) x -= TWO_PI;
    if (x > HALF_PI) x = PI - x; else if (x < -HALF_PI) x = -PI - x;
    const x2 = x * x;
    return x * (1 + x2 * (C3 + x2 * (C5 + x2 * (C7 + x2 * (C9 + x2 * C11)))));
  }

  // ---------- world constants ----------
  // World units: 960x540 physics space. 1 buffer pixel = 3 world units. 1 frame = 1/60 s.
  const W = 960, H = 540, LW = 320, LH = 180, PX = 3;
  const HUD_PX = 14;
  const GROUND_PX = 14, GROUND_TOP = LH - GROUND_PX;
  const CEIL_Y = HUD_PX * PX;
  const GROUND_Y = GROUND_TOP * PX;
  const MID_Y = (CEIL_Y + GROUND_Y) / 2;
  const PLAYER_X = 200;
  const STEP = 1000 / 60;

  // =====================================================================
  //  TUNING (all gameplay numbers live here)
  // =====================================================================
  const TUNE = {
    // --- pill physics (per 60 Hz frame) ---
    // v4: a tap SETS the upward speed (vy = -thrust): same jump height every time, no stacking.
    gravUp: 0.5, gravDown: 0.57,
    thrust: 8.1, maxUp: 9.5, maxFall: 10,
    hit: { rx: 21, ry: 11 },
    candleW: 66, wick: 15,
    nearMiss: 18,
    firstX: 780,
    // --- difficulty by run time: [sec, speed, spacing, gap(body to body), max jump between gaps] ---
    // v4: the first 20 s are easier (wider gaps, slower), then the ramp.
    diff: [
      [0, 3.2, 365, 182, 100],
      [20, 3.5, 345, 162, 145],
      [35, 4.3, 325, 154, 175],
      [55, 5.0, 305, 144, 195],
      [80, 5.6, 292, 136, 205],
      [100, 6.0, 282, 130, 210]
    ],
    // first candles: wide and flat, then a ramp to the normal table (candles n..rampTo)
    firstCandles: { n: 6, gap: 192, jump: 80, rampTo: 12 },
    restGap: 20,
    launchSec: 10,
    phase: { min: 8, max: 14, announce: 1.5 },
    // green = chance that a normal candle is GREEN (pass-through, never kills). Only red bodies kill.
    phases: {
      LAUNCH: { label: 'STEALTH LAUNCH', g: 1, speed: 1, coins: 1, drift: 0, noise: 55, green: 0.1 },
      PUMP: { label: "WE'RE SO BACK", g: 0.98, speed: 1, coins: 2, drift: -18, noise: 12, ceilPad: 60, green: 0.4 },
      DUMP: { label: "IT'S OVER", g: 1.05, speed: 1, coins: 1, drift: 35, noise: 10, spike: 20, green: 0.06 },
      CHOP: { label: 'CRAB MARKET', g: 1, speed: 1, coins: 1, amp: 35, period: 1.2, spacing: 0.8, green: 0.15 },
      ATH: { label: 'NEW ATH', g: 0.95, speed: 1, coins: 0 },
      BOSS: { label: 'THE DEV', g: 1, speed: 0.7, coins: 0 }
    },
    green: { tutorialN: 3, lev: 0.5, cash: 400 },
    ath: { after: 60, chance: 0.35, dur: 6 },
    // --- events (seconds of world time) ---
    events: {
      first: 9,                  // first event is always an AIRDROP (a gift, not a trap)
      second: 7,                 // ...and 7 s later the 2nd one is always an EASY rug (you see the joke of the title)
      airdropFrom: 9, sniperFrom: 20, rugFrom: 16, bundleFrom: 25, kolFrom: 25, devFrom: 30, fudFrom: 35, mevFrom: 30,
      devCooldown: 30, kolUp: 0.1, kolDown: 0.14,
      dev: { shift: 35, safe: 150, dump: 180 },   // only candles at least `safe` ahead of the pill move (never the one you are in)
      rug: { warn: 160, trigger: 75, shift: 95, easyShift: 55, close: 30, frames: 12 },
      sniper: { track: 72, lock: 12, lead: 10, follow: 0.12, gunX: 930, speed: 18, len: 30, hitH: 10, doubleAfter: 45, doubleDelay: 30, dodgeLev: 0.5 },
      bundle: { n: 4, step: 25, gapPlus: 25, lev: 2 },
      mev: { open: 220, shut: 125, lead: 60, close: 45, hold: 40, reopen: 30, maxJump: 70 },
      fud: { warn: 60, dur: 300, alphaAt: 150, fade: 20 },
      airdrop: { fall: 1.6, r: 18, cash: 1500, lev: 2, float: 6, off: 40 }
    },
    // --- CTO (community takeover): one revive per run, 15 taps in 2.5 s ---
    cto: { minSec: 20, taps: 15, window: 150, inv: 120, levKeep: 0.5 },
    // --- BOSS "THE DEV": when the bonding curve hits 100% (end of world 0), before the migration ---
    boss: {
      intro: 70, speedMul: 0.7,
      throws: 6, throwEvery: 46, throwLead: 42, throwSpeed: 5.6, throwGap: 160, lanes: [-90, 0, 90],
      wallIn: 50, wallHold: 160, wallOut: 30, wallHalf: 100, wallAmp: 60, wallPeriod: 120,
      shots: 3, shotEvery: 36, shotLanes: [-130, -45, 45, 130], gap: 6,
      pay: 5000                     // x leverage x world mul, per attack survived
    },
    // --- economy (score = market cap) ---
    startMC: 4200,
    gain: { candle: 300, near: 500, coin: 100, perSec: 50 },
    lev: { max: 20, candle: 0.5, near: 1, pickup: 1, decaySec: 4, tapLimit: 4 },
    coins: { chance: 0.32, r: 15 },
    shield: { first: 15, every: 22 },
    worlds: [
      { name: 'BONDING CURVE', short: 'CURVE', target: 69000, mul: 1 },
      { name: 'PUMPSWAP', short: 'SWAP', target: 600000, mul: 4 },
      { name: 'TRENCHES 3AM', short: '3AM', target: 3e6, mul: 10 },
      { name: 'MOON', short: 'MOON', target: Infinity, mul: 25, g: 0.72, thrust: 0.85 }
    ],
    // --- juice (ms / buffer px), used by the client only ---
    fx: { hitstopDeath: 120, hitstopShield: 70, hitstopPickup: 40, shakeX: 5, shakeY: 4, traumaDecay: 1.6, restartMs: 600, nearSlow: 0.6, nearSlowMs: 80 }
  };

  function diffAt(t){
    const D = TUNE.diff;
    const last = D[D.length - 1];
    if (t >= last[0]) return { speed: last[1], spacing: last[2], gap: last[3], jump: last[4] };
    for (let i = 0; i < D.length - 1; i++) {
      const a = D[i], b = D[i + 1];
      if (t < b[0]) { const k = (t - a[0]) / (b[0] - a[0]); return { speed: lerp(a[1], b[1], k), spacing: lerp(a[2], b[2], k), gap: lerp(a[3], b[3], k), jump: lerp(a[4], b[4], k) }; }
    }
    return { speed: D[0][1], spacing: D[0][2], gap: D[0][3], jump: D[0][4] };
  }

  function emit(s, name, a, b, c, d){ if (s.fx) s.fx(name, a, b, c, d); }

  // =====================================================================
  //  STATE
  // =====================================================================
  function newSim(seed){
    seed = seed >>> 0;
    return {
      v: 4, sim: SIM_VERSION, seed, rng: mulberry32(seed), frame: 0, af: 0, alive: true,
      y: MID_Y, py: MID_Y, vy: 0, speed: TUNE.diff[0][1], dist: 0, scroll: 0,
      obs: [], coins: [], picks: [], shots: [], crates: [], price: MID_Y, chopBase: MID_Y, candleN: 0, passed: 0,
      mc: TUNE.startMC, maxMc: TUNE.startMC, lev: 1, maxLev: 1, tapsSince: 0, sincePass: 0, nearCount: 0, streak: 0,
      shield: false, inv: 0, gradInv: false, world: 0, worldStartMc: TUNE.startMC, curve: 0,
      phase: { id: 'LAUNCH', start: 0, until: TUNE.launchSec * 60 }, next: null, forced: null, announced: false, athDone: false,
      ev: null, evCount: 0, nextEv: TUNE.events.first * 60, lastDev: -1e9, lastEv: null, rest: 0, rugNext: false, mevNext: false,
      bundle: null, bundleN: 0, fogFrom: -1, fogUntil: -1, fogClear: false,
      rugUntil: -1, devUntil: -1, kol1Until: -1, kol2Until: -1, wind: 0, nextShield: TUNE.shield.first * 60,
      cto: null, ctoUsed: false, revives: 0,
      boss: null, bossDone: false, bossBeat: false, lastGreen: false, rugEasy: false,
      inputs: [], cause: null, killer: null, deathKind: null,
      hist: [], marks: [], trail: [], lastFlap: -1e9, gradAt: -1e9,
      fx: null
    };
  }
  function phaseId(s){ if (s.boss) return 'BOSS'; return (s.forced && s.af < s.forced.until) ? s.forced.id : s.phase.id; }
  function worldTime(s){ return s.af / 60; }

  // =====================================================================
  //  STEP (one fixed 60 Hz tick)
  // =====================================================================
  function step(s, flapNow){
    if (!s.alive) return;
    if (flapNow) s.inputs.push(s.frame);
    // ---- CTO window: the world is frozen, only taps count ----
    if (s.cto) { ctoTick(s, flapNow); s.frame++; return; }
    const f = s.af, t = f / 60;
    // ---- market + events ----
    updatePhase(s, t);
    updateEvents(s, t);
    if (s.boss) bossTick(s);
    const pid = phaseId(s);
    const ph = TUNE.phases[pid];
    const wd = TUNE.worlds[s.world];
    const d = diffAt(t);
    s.speed += (d.speed * ph.speed - s.speed) * 0.04;
    // ---- pill physics ----
    s.py = s.y;
    if (flapNow) {
      // fixed pump: a tap sets the upward speed (no stacking from rapid taps)
      s.vy = -TUNE.thrust * (wd.thrust || 1);
      s.tapsSince++; s.lastFlap = f;
      emit(s, 'flap');
    }
    const g = (s.vy < 0 ? TUNE.gravUp : TUNE.gravDown) * ph.g * (wd.g || 1);
    s.vy = clamp(s.vy + g + s.wind, -TUNE.maxUp * 1.25, TUNE.maxFall);
    s.y += s.vy;
    s.scroll += s.speed;
    // ---- spawn candles by DISTANCE ----
    if (f === 0) { spawnCandle(s, TUNE.firstX, d, ph, pid); s.dist = W + 30 - TUNE.firstX; }
    else if (s.boss) s.dist = 0;
    else if (pid !== 'ATH') {
      s.dist += s.speed;
      const B = s.bundle;
      const inBundle = B && B.n > 0 && B.n < B.total && B.last;
      const spacing = inBundle ? TUNE.candleW : d.spacing * (ph.spacing || 1);
      if (s.dist >= spacing) { s.dist -= spacing; spawnCandle(s, inBundle ? B.last.x + TUNE.candleW : W + 30, d, ph, pid); }
    } else {
      s.dist = 0;
      if (f % 7 === 0) s.coins.push({ x: W + 10 + s.rng() * 240, px: 0, y: CEIL_Y + 6, vy: 1 + s.rng() * 1.4, o: null, off: 0, got: false });
    }
    // ---- move world ----
    for (let i = s.obs.length - 1; i >= 0; i--) {
      const o = s.obs[i];
      o.px = o.x; o.x -= o.vx || s.speed;
      animCandle(s, o);
      if (o.x + o.w < -80) s.obs.splice(i, 1);
    }
    for (let i = s.coins.length - 1; i >= 0; i--) {
      const c = s.coins[i];
      c.px = c.x; c.x -= s.speed;
      if (c.o) { const gg = geo(c.o, f); c.y = (gg.top + gg.bot) / 2 + c.off; }
      else if (c.vy) { c.y += c.vy; if (c.y > GROUND_Y - 10) c.vy = 0; }
      if (c.x < -30 || c.got) s.coins.splice(i, 1);
    }
    for (let i = s.picks.length - 1; i >= 0; i--) {
      const p = s.picks[i];
      p.px = p.x; p.x -= s.speed;
      if (p.x < -30 || p.got) s.picks.splice(i, 1);
    }
    updateShots(s);
    updateCrates(s);
    // ---- economy: time only pays a little ----
    s.mc += TUNE.gain.perSec / 60 * wd.mul;
    // ---- collisions ----
    collide(s);
    if (!s.alive || s.cto) { s.frame++; s.af++; return; }
    // ---- leverage decay (anti camping) ----
    // sim 5: the leverage clock is frozen while THE DEV is on screen and in the graduation pipe (no candles to pass there),
    // so beating the boss no longer wipes your leverage back to x1.
    if (!s.boss && !s.gradInv) s.sincePass++;
    if (s.sincePass > TUNE.lev.decaySec * 60 && s.lev > 1 && pid !== 'ATH') { s.lev = 1; emit(s, 'levLost'); }
    if (s.inv > 0 && --s.inv === 0) s.gradInv = false;
    // ---- bonding curve / graduation ----
    s.curve = curvePct(s);
    if (s.curve >= 100 && !s.boss) {
      if (s.world === 0 && !s.bossDone) startBoss(s);          // 100% bonding curve: THE DEV wakes up before the migration
      else if (s.world < TUNE.worlds.length - 1) graduate(s);
    }
    if (s.mc > s.maxMc) s.maxMc = s.mc;
    if (s.lev > s.maxLev) s.maxLev = s.lev;
    // ---- history (PnL card) + on-screen chart trail ----
    if (f % 6 === 0) s.hist.push(Math.round(s.y), Math.round(s.mc));
    if (f % 3 === 0) {
      s.trail.push({ y: s.y, sc: s.scroll });
      while (s.trail.length && s.scroll - s.trail[0].sc > PLAYER_X + 60) s.trail.shift();
    }
    s.frame++; s.af++;
  }

  function geo(o, f){
    let c = o.c + o.shift;
    if (o.osc) c += o.osc.amp * dsin(f * TWO_PI / (o.osc.period * 60) + o.osc.ph);
    return { top: c - o.g / 2 + o.ext + o.spike, bot: c + o.g / 2 + o.drop };   // lethal body edges
  }
  function animCandle(s, o){
    const f = s.af;
    if (o.shift !== o.shiftT) o.shift += clamp(o.shiftT - o.shift, -7, 7);
    if (o.rug) {
      // telegraph (shake + arrow) from trigger+warn, then the LP is pulled at `trigger`:
      // the gap jumps `mag` up or down (seeded direction, shown by the arrow) and closes a bit.
      const R = TUNE.events.rug, r = o.rug, dx = o.x - (PLAYER_X + TUNE.hit.rx);
      if (r.state === 0 && dx < R.trigger + R.warn) { r.state = 1; emit(s, 'rugWarn', o); }
      if (r.state === 1 && dx < R.trigger) { r.state = 2; r.f = f; s.rugUntil = f + 120; emit(s, 'rugPulled', o); }
      if (r.state === 2) {
        const k = clamp((f - r.f) / R.frames, 0, 1), sh = r.dir * r.mag * k, cl = R.close * k;
        o.ext = sh + cl / 2; o.drop = sh - cl / 2;
      }
    }
    if (o.spikeMax) o.spike = o.spikeMax * clamp(1 - (o.x - PLAYER_X) / 420, 0, 1);
    if (o.mev) {
      const M = TUNE.events.mev, m = o.mev;
      if (m.state === 0 && o.x - (PLAYER_X + TUNE.hit.rx) <= M.lead * s.speed) { m.state = 1; m.f = f; emit(s, 'mevClose', o); }
      if (m.state === 1) {
        const el = f - m.f;
        let k;
        if (el < M.close) k = el / M.close;
        else if (el < M.close + M.hold) k = 1;
        else if (el < M.close + M.hold + M.reopen) k = 1 - (el - M.close - M.hold) / M.reopen;
        else { k = 0; m.state = 2; }
        o.g = M.open - (M.open - M.shut) * k;
      }
    }
  }

  function spawnCandle(s, x, d, ph, pid){
    const n = s.candleN++;
    const FC = TUNE.firstCandles;
    let gap = d.gap, jump = d.jump;
    if (n < FC.n) { gap = FC.gap; jump = FC.jump; }
    else if (n < FC.rampTo) { const k = (n - FC.n + 1) / (FC.rampTo - FC.n + 1); gap = lerp(FC.gap, d.gap, k); jump = lerp(FC.jump, d.jump, k); }
    if (s.rest > 0) { gap += TUNE.restGap; s.rest--; }
    const isRug = s.rugNext;
    let rug = null;
    if (isRug) {
      s.rugNext = false; gap += 20;
      rug = { state: 0, f: 0, dir: s.rng() < 0.5 ? -1 : 1, mag: s.rugEasy ? TUNE.events.rug.easyShift : TUNE.events.rug.shift, easy: s.rugEasy };
      s.rugEasy = false;
    }
    const B = (!isRug && s.bundle && s.bundle.n < s.bundle.total) ? s.bundle : null;
    const isMev = !B && !isRug && s.mevNext;
    if (isMev) { s.mevNext = false; gap = TUNE.events.mev.open; jump = Math.min(jump, TUNE.events.mev.maxJump); }
    if (B) gap += TUNE.events.bundle.gapPlus;
    const special = !!(B || isMev || isRug);
    // green candles: pass-through bonus (never two in a row, never special). Candle #tutorialN is always green.
    let green = false;
    if (!special && n >= 3 && !s.lastGreen) green = n === TUNE.green.tutorialN || s.rng() < (ph.green || 0);
    s.lastGreen = green;
    const amp = (pid === 'CHOP' && !special) ? ph.amp : 0;
    const lo = CEIL_Y + gap / 2 + (ph.ceilPad || 24) + amp + (rug && rug.dir < 0 ? rug.mag : 0);
    const hi = GROUND_Y - gap / 2 - 24 - amp - (rug && rug.dir > 0 ? rug.mag : 0);
    const r = s.rng(), r2 = s.rng();
    const c = s.price;
    let tgt;
    if (pid === 'PUMP') { tgt = c + ph.drift + (r * 2 - 1) * ph.noise; if (c <= lo + 4) tgt = c + r2 * 45; }
    else if (pid === 'DUMP') { tgt = c + ph.drift + (r * 2 - 1) * ph.noise; if (c >= hi - 4) tgt = c - r2 * 45; }
    else if (pid === 'CHOP') tgt = s.chopBase + (r * 2 - 1) * 15;
    else tgt = c + (r * 2 - 1) * (ph.noise || 40);
    if (B && B.n > 0) {             // bundle: a staircase, one step per candle
      const st = TUNE.events.bundle.step;
      tgt = c + B.dir * st;
      if (tgt < lo || tgt > hi) { B.dir = -B.dir; tgt = c + B.dir * st; }
    }
    tgt = clamp(tgt, c - jump, c + jump);
    tgt = clamp(tgt, lo, hi);
    s.price = tgt;
    const o = {
      x, px: x, w: TUNE.candleW, c: tgt, g: gap, n, shift: 0, shiftT: 0, ext: 0, drop: 0, spike: 0,
      spikeMax: (pid === 'DUMP' && !special) ? ph.spike : 0,
      osc: amp ? { amp, period: ph.period, ph: s.rng() * TWO_PI } : null,
      kind: green ? 'green' : isRug ? 'rug' : 'red', green, rode: false, rug,
      bundle: B ? B.id : 0, bundleIdx: B ? B.n : -1, bundleTotal: B ? B.total : 0,
      mev: isMev ? { state: 0, f: 0 } : null,
      passed: false, minClear: 1e9, dead: false
    };
    if (B) { B.n++; B.last = o; }
    const prev = s.obs.length ? s.obs[s.obs.length - 1] : null;
    s.obs.push(o);
    // SOL coins on the risky line (3 per packet)
    const kolBoost = s.af <= s.kol1Until ? 2 : 1;
    if (n >= 3 && !isRug && !special && s.rng() < TUNE.coins.chance * ph.coins * kolBoost) {
      const side = s.rng() < 0.5 ? -1 : 1;
      const off = side * Math.max(0, gap / 2 - 30);
      for (let k = -1; k <= 1; k++) s.coins.push({ x: x + o.w / 2 + k * 40, px: 0, y: 0, o, off: off * (k === 0 ? 1 : 0.6), got: false });
    }
    // DIAMOND HANDS shield between two candles (world timing only, never depends on the player)
    if (prev && !special && !prev.bundle && s.af >= s.nextShield && n >= 4) {
      s.picks.push({ x: (prev.x + prev.w + x) / 2, px: 0, y: (prev.c + prev.shift + tgt) / 2, type: 'shield', got: false });
      s.nextShield = s.af + Math.round((TUNE.shield.every + s.rng() * 10) * 60);
    }
  }

  // =====================================================================
  //  COLLISIONS / DEATH / CTO
  // =====================================================================
  function collide(s){
    const rx = TUNE.hit.rx, ry = TUNE.hit.ry, X = PLAYER_X, f = s.af;
    if (s.y - ry < CEIL_Y && !saveOrDie(s, 'ceiling', null)) return;
    if (s.y + ry > GROUND_Y && !saveOrDie(s, 'ground', null)) return;
    for (const o of s.obs) {
      if (o.dead) continue;
      if (X + rx > o.x && X - rx < o.x + o.w) {
        const g = geo(o, f);
        const Yn = s.y;
        const clear = Math.min((Yn - ry) - g.top, g.bot - (Yn + ry));
        if (clear < o.minClear) o.minClear = clear;
        const dx = (clamp(X, o.x, o.x + o.w) - X) / rx;
        const dt = (Math.min(Yn, g.top) - Yn) / ry, db = (Math.max(Yn, g.bot) - Yn) / ry;
        if ((dx * dx + dt * dt < 1) || (dx * dx + db * db < 1)) {
          if (o.green) { if (!o.rode) { o.rode = true; emit(s, 'rideIn', o); } }     // green body: fly through it
          else if (!saveOrDie(s, 'candle', o)) return;
        }
      }
      if (!o.passed && o.x + o.w < X - rx) passCandle(s, o);
    }
    // boss "PULL LP" corridor
    if (s.boss) {
      const bw = bossWall(s, 0);
      if (bw.on && (s.y - ry < bw.top || s.y + ry > bw.bot) && !saveOrDie(s, 'boss', null)) return;
    }
    // sniper bullets (swept segment, so 18 world/frame never tunnels)
    const SN = TUNE.events.sniper;
    for (const sh of s.shots) {
      if (sh.state !== 2 || sh.hit) continue;
      if (X + rx > sh.x && X - rx < sh.px + SN.len && Math.abs(sh.lockY - s.y) < ry + SN.hitH) { if (!saveOrDie(s, 'sniper', sh)) return; }
      if (!sh.passed && !sh.hit && sh.x + SN.len < X - rx) { sh.passed = true; addLev(s, SN.dodgeLev); emit(s, 'shotDodge', sh); }
    }
    const cr = TUNE.coins.r;
    for (const c of s.coins) {
      if (c.got) continue;
      const dx = (c.x - X) / (rx + cr), dy = (c.y - s.y) / (ry + cr);
      if (dx * dx + dy * dy < 1) {
        c.got = true;
        const amt = TUNE.gain.coin * s.lev * TUNE.worlds[s.world].mul;
        s.mc += amt; emit(s, 'coin', c, amt);
      }
    }
    for (const p of s.picks) {
      if (p.got) continue;
      const dx = (p.x - X) / (rx + 18), dy = (p.y - s.y) / (ry + 18);
      if (dx * dx + dy * dy < 1) {
        p.got = true;
        addLev(s, TUNE.lev.pickup);
        if (p.type === 'alpha') { s.fogClear = true; emit(s, 'alphaGet', p); }
        else { s.shield = true; emit(s, 'shieldGet', p); }
      }
    }
    const A = TUNE.events.airdrop;
    for (const c of s.crates) {
      if (c.got || c.landed) continue;
      const dx = (c.x - X) / (rx + A.r), dy = (c.y - s.y) / (ry + A.r);
      if (dx * dx + dy * dy < 1) {
        c.got = true;
        let amt = 0;
        if (c.bonus === 'shield' && !s.shield) s.shield = true;
        else if (c.bonus === 'lev') addLev(s, A.lev);
        else { amt = A.cash * TUNE.worlds[s.world].mul; s.mc += amt; c.bonus = 'cash'; }
        emit(s, 'crateGet', c, c.bonus, amt);
      }
    }
  }
  function saveOrDie(s, kind, o){
    const wall = kind === 'ground' || kind === 'ceiling';
    if (s.inv > 0) {
      if (kind === 'candle') { if (s.gradInv) { o.dead = true; emit(s, 'shatter', o); } return true; }
      if (wall) bounce(s, kind); else if (o) o.hit = true;
      return true;
    }
    if (s.shield) {
      s.shield = false; s.lev = 1; s.inv = 40;
      if (kind === 'candle') { o.dead = true; emit(s, 'shatter', o); }
      else if (wall) bounce(s, kind);
      else if (o) o.hit = true;
      emit(s, 'shieldBreak', o);
      return true;
    }
    const cause = causeText(s, kind, o);
    if (!s.ctoUsed && worldTime(s) >= TUNE.cto.minSec) {
      s.ctoUsed = true;
      s.cto = { f0: s.frame, taps: 0, kind, killer: o, cause };
      emit(s, 'ctoOpen', s.cto);
      return false;
    }
    die(s, kind, o, cause);
    return false;
  }
  function die(s, kind, o, cause){
    s.alive = false; s.deathKind = kind; s.killer = o; s.cause = cause;
  }
  function ctoTick(s, flap){
    const c = s.cto, C = TUNE.cto;
    if (flap) { c.taps++; emit(s, 'ctoTap', c.taps); }
    if (c.taps >= C.taps) { revive(s); return; }
    if (s.frame - c.f0 >= C.window) {
      s.cto = null;
      s.ctoFailed = true;
      emit(s, 'ctoFail', c);
      die(s, c.kind, c.killer, c.cause);
    }
  }
  function revive(s){
    const c = s.cto;
    s.cto = null; s.revives++;
    s.y = s.py = MID_Y; s.vy = -3;
    s.inv = TUNE.cto.inv; s.gradInv = true;
    s.lev = Math.max(1, s.lev * TUNE.cto.levKeep);
    s.sincePass = 0; s.tapsSince = 0;
    for (const sh of s.shots) sh.hit = true;
    s.marks.push({ f: s.af, t: 'CTO' });
    emit(s, 'ctoWin', c);
  }
  function bounce(s, kind){
    if (kind === 'ground') { s.y = GROUND_Y - TUNE.hit.ry - 2; s.vy = -TUNE.thrust * 0.9; }
    else { s.y = CEIL_Y + TUNE.hit.ry + 2; s.vy = 2; }
  }
  function causeText(s, kind, o){
    const f = s.af;
    if (s.boss || kind === 'boss' || (o && o.boss)) return 'THE DEV OUTLASTED YOU';
    if (kind === 'sniper') return 'SNIPED IN BLOCK 0';
    if ((o && o.rug && o.rug.state === 2) || (f <= s.rugUntil && kind === 'ground')) return 'RUGGED AT ' + Math.floor(s.curve) + '% CURVE';
    if (o && o.mev) return 'SANDWICHED BY MEV';
    if (o && o.bundle) return 'BUNDLED AND DUMPED';
    if (f <= s.devUntil && kind !== 'ceiling') return 'DEV DUMPED ON YOU';
    if (f <= s.kol2Until) return 'EXIT LIQUIDITY FOR A KOL';
    if (f >= s.fogFrom && f < s.fogUntil && !s.fogClear) return 'FUDDED OUT';
    if (kind === 'ground') return 'WENT TO ZERO';
    if (kind === 'ceiling') return 'FLEW TOO CLOSE TO THE ATH';
    return 'REKT BY A RED CANDLE';
  }
  function addLev(s, v){
    const before = s.lev;
    s.lev = Math.min(TUNE.lev.max, s.lev + v);
    for (const tier of [5, 10, 20]) if (before < tier && s.lev >= tier) emit(s, 'levTier', tier);
  }
  function passCandle(s, o){
    o.passed = true; s.passed++;
    const mul = TUNE.worlds[s.world].mul;
    const amt = TUNE.gain.candle * s.lev * mul;
    if (s.tapsSince <= TUNE.lev.tapLimit) addLev(s, TUNE.lev.candle);
    const near = !o.green && o.minClear <= TUNE.nearMiss;
    let nearAmt = 0;
    if (near) { nearAmt = TUNE.gain.near * s.lev * mul; s.nearCount++; s.streak++; addLev(s, TUNE.lev.near); }
    else if (!o.green) s.streak = 0;
    let rideAmt = 0;
    if (o.rode) { rideAmt = TUNE.green.cash * s.lev * mul; addLev(s, TUNE.green.lev); }
    s.mc += amt + nearAmt + rideAmt;
    s.tapsSince = 0; s.sincePass = 0;
    emit(s, 'pass', o, amt, near, nearAmt);
    if (o.rode) emit(s, 'ride', o, rideAmt);
    if (o.bundle && o.bundleIdx === o.bundleTotal - 1) { addLev(s, TUNE.events.bundle.lev); emit(s, 'bundleClear', o); }
  }
  function curvePct(s){
    const wd = TUNE.worlds[s.world];
    if (!isFinite(wd.target)) return 100;
    const p = clamp((s.mc - s.worldStartMc) / (wd.target - s.worldStartMc), 0, 1);
    if (s.world === 0) {               // the curve crawls between 60% and 75% (yes, you'll die at 69% a lot)
      if (p < 0.45) return p / 0.45 * 60;
      if (p < 0.80) return 60 + (p - 0.45) / 0.35 * 15;
      return 75 + (p - 0.80) / 0.20 * 25;
    }
    return p * 100;
  }
  function graduate(s){
    s.world++; s.worldStartMc = s.mc; s.inv = 120; s.gradInv = true; s.gradAt = s.af; s.curve = 0;
    s.marks.push({ f: s.af, t: 'GRAD' });
    emit(s, 'grad', s.world);
  }

  // =====================================================================
  //  MARKET PHASES
  // =====================================================================
  function updatePhase(s, t){
    const f = s.af;
    if (s.forced && f >= s.forced.until) { s.forced = null; emit(s, 'phase', phaseId(s)); }
    if (!s.next) s.next = pickPhase(s, t);
    if (!s.announced && f >= s.phase.until - TUNE.phase.announce * 60) { s.announced = true; emit(s, 'announce', s.next.id); }
    if (f >= s.phase.until) {
      const n = s.next;
      s.phase = { id: n.id, start: f, until: f + n.dur };
      s.next = null; s.announced = false;
      if (n.id === 'CHOP') s.chopBase = clamp(s.price, CEIL_Y + 150, GROUND_Y - 150);
      if (n.id === 'ATH') { s.athDone = true; s.marks.push({ f, t: 'ATH' }); }
      if (!s.forced) emit(s, 'phase', n.id);
    }
  }
  function pickPhase(s, t){
    const cur = s.phase.id;
    if (t > TUNE.ath.after && !s.athDone && s.rng() < TUNE.ath.chance) return { id: 'ATH', dur: TUNE.ath.dur * 60 };
    const opts = ['PUMP', 'DUMP', 'CHOP'].filter(p => p !== cur);
    const id = opts[Math.floor(s.rng() * opts.length)];
    return { id, dur: Math.round((TUNE.phase.min + s.rng() * (TUNE.phase.max - TUNE.phase.min)) * 60) };
  }

  // =====================================================================
  //  EVENTS: AIRDROP / SNIPER / RUG / BUNDLE / KOL / DEV / FUD / MEV
  //  Start and end only depend on world time + positions (never on the player).
  // =====================================================================
  const HARD = { RUG: 1, DEV: 1, SNIPER: 1, BUNDLE: 1, MEV: 1, FUD: 1 };
  function eventInterval(t){ return t < 45 ? 9 : t < 70 ? 7 : t < 90 ? 6 : 5; }
  function updateEvents(s, t){
    const f = s.af, E = TUNE.events;
    if (s.boss) { s.nextEv = Math.max(s.nextEv, f + 60); return; }     // the boss owns the screen
    if (!s.ev && f >= s.nextEv) {
      if (phaseId(s) === 'ATH') s.nextEv = f + 60;
      else {
        let type = null;
        if (!s.evCount) type = 'AIRDROP';
        else if (s.evCount === 1) { type = 'RUG'; s.rugEasy = true; }   // 2nd event: always an easy, well telegraphed rug
        else {
          const opts = [];
          if (t >= E.airdropFrom) opts.push('AIRDROP');
          if (t >= E.sniperFrom) opts.push('SNIPER');
          if (t >= E.rugFrom) opts.push('RUG');
          if (t >= E.bundleFrom) opts.push('BUNDLE');
          if (t >= E.kolFrom) opts.push('KOL');
          if (t >= E.devFrom && f - s.lastDev >= E.devCooldown * 60) opts.push('DEV');
          if (t >= E.fudFrom) opts.push('FUD');
          if (t >= E.mevFrom) opts.push('MEV');
          const pool = opts.length > 1 ? opts.filter(o => o !== s.lastEv) : opts;
          if (pool.length) type = pool[Math.floor(s.rng() * pool.length)];
        }
        if (type) startEvent(s, type);
        s.nextEv = f + (s.evCount === 1 ? E.second : eventInterval(t)) * 60;
      }
    }
    if (s.ev) tickEvent(s);
  }
  function newShot(f0, fixedY){ return { f0, state: -1, y: 0, lockY: 0, x: TUNE.events.sniper.gunX, px: TUNE.events.sniper.gunX, done: false, hit: false, passed: false, boss: fixedY != null, fixedY: fixedY == null ? null : fixedY }; }
  function startEvent(s, type){
    const f = s.af, E = TUNE.events;
    s.ev = { type, f0: f, stage: 0 };
    s.lastEv = type; s.evCount++;
    s.marks.push({ f, t: type });
    if (type === 'RUG') s.rugNext = true;
    else if (type === 'KOL') { s.forced = { id: 'PUMP', until: f + 240 }; s.wind = -E.kolUp; s.kol1Until = f + 240; }
    else if (type === 'SNIPER') {
      s.shots.push(newShot(f));
      if (worldTime(s) >= E.sniper.doubleAfter) s.shots.push(newShot(f + E.sniper.doubleDelay));
    }
    else if (type === 'BUNDLE') s.bundle = { id: ++s.bundleN, n: 0, total: E.bundle.n, dir: s.price > MID_Y ? -1 : 1, last: null };
    else if (type === 'MEV') s.mevNext = true;
    else if (type === 'AIRDROP') {
      const r = s.rng(), b = s.rng();
      const y0 = CEIL_Y + 24 + r * 60;
      s.crates.push({ x: W + 20, px: W + 20, y: y0, by: y0, off: (s.rng() < 0.5 ? -1 : 1) * E.airdrop.off, got: false, landed: false, lost: false, bonus: b < 0.34 ? 'shield' : b < 0.67 ? 'lev' : 'cash' });
    }
    emit(s, 'ev', type, 0);
  }
  function tickEvent(s){
    const e = s.ev, f = s.af, el = f - e.f0, E = TUNE.events;
    if (e.type === 'RUG') {
      const rc = s.obs.find(o => o.rug);
      if ((!s.rugNext && !rc) || el > 900) endEvent(s);
      else if (rc && rc.rug.state === 2 && f > s.rugUntil) endEvent(s);
    } else if (e.type === 'DEV') {
      if (e.stage === 0 && el >= 72) {
        e.stage = 1;
        // only the candles AHEAD move (never the one the pill is inside): they were flagged during the telegraph
        const D = E.dev;
        for (const o of s.obs) if (o.x >= PLAYER_X + D.safe && o.x < W + 120 && !o.boss) { o.shiftT += D.shift; o.devHit = true; }
        s.price = Math.min(s.price + D.shift, GROUND_Y - 120);
        s.forced = { id: 'DUMP', until: f + D.dump }; s.devUntil = f + D.dump; s.lastDev = f;
        emit(s, 'ev', 'DEV', 1);
      } else if (e.stage === 1 && el >= 72 + E.dev.dump) endEvent(s);
    } else if (e.type === 'KOL') {
      if (e.stage === 0 && el >= 240) { e.stage = 1; s.wind = E.kolDown; s.forced = { id: 'DUMP', until: f + 180 }; s.kol2Until = f + 180; emit(s, 'ev', 'KOL', 1); }
      else if (e.stage === 1 && el >= 420) { s.wind = 0; endEvent(s); }
    } else if (e.type === 'SNIPER') {
      if (s.shots.every(sh => sh.done)) { s.shots.length = 0; endEvent(s); }
    } else if (e.type === 'BUNDLE') {
      const b = s.bundle;
      const gone = b && b.n >= b.total && b.last && b.last.x + b.last.w < PLAYER_X - TUNE.hit.rx;
      if (!b || gone || el > 1200) { s.bundle = null; endEvent(s); }
    } else if (e.type === 'MEV') {
      const m = s.obs.find(o => o.mev && o.x + o.w >= PLAYER_X - TUNE.hit.rx);
      if ((!s.mevNext && !m) || el > 900) { s.mevNext = false; endEvent(s); }
    } else if (e.type === 'FUD') {
      const F = E.fud;
      if (e.stage === 0 && el >= F.warn) { e.stage = 1; s.fogFrom = f; s.fogUntil = f + F.dur; s.fogClear = false; emit(s, 'ev', 'FUD', 1); }
      if (e.stage === 1 && !e.alpha && el >= F.warn + F.alphaAt) {
        e.alpha = true;
        s.picks.push({ x: W + 20, px: W + 20, y: clamp(s.price, CEIL_Y + 60, GROUND_Y - 60), type: 'alpha', got: false });
      }
      if (e.stage === 1 && f >= s.fogUntil) { emit(s, 'fogEnd'); endEvent(s); }
    } else if (e.type === 'AIRDROP') {
      if (!s.crates.length || el > 900) endEvent(s);
    }
  }
  function endEvent(s){
    const hard = !!HARD[s.ev.type];
    s.ev = null;
    if (hard) s.rest = 2;
  }
  function updateShots(s){
    const SN = TUNE.events.sniper, f = s.af;
    for (const sh of s.shots) {
      if (sh.done) continue;
      const el = f - sh.f0;
      if (el < 0) continue;
      if (sh.state === -1) { sh.state = 0; sh.y = sh.boss ? MID_Y : s.y; emit(s, 'shotTrack', sh); }
      if (sh.state === 0) {
        sh.y += ((sh.boss ? sh.fixedY : s.y) - sh.y) * SN.follow;     // boss shots sweep to a seeded lane (never aim at you)
        // lock aims where you WILL be (lead), not where you are
        if (el >= SN.track) { sh.state = 1; sh.lockY = sh.boss ? sh.fixedY : clamp(s.y + s.vy * SN.lead, CEIL_Y + 20, GROUND_Y - 20); sh.y = sh.lockY; emit(s, 'shotLock', sh); }
      } else if (sh.state === 1) {
        if (el >= SN.track + SN.lock) { sh.state = 2; sh.x = sh.px = SN.gunX; emit(s, 'shotFire', sh); }
      } else if (sh.state === 2) {
        sh.px = sh.x; sh.x -= SN.speed;
        if (sh.x + SN.len < -20) sh.done = true;
      }
    }
  }
  function updateCrates(s){
    const A = TUNE.events.airdrop, f = s.af;
    for (let i = s.crates.length - 1; i >= 0; i--) {
      const c = s.crates[i];
      c.px = c.x; c.x -= s.speed;
      if (!c.got) {
        // v4: the crate parachutes down to the gap of the nearest candle, then floats there (+-float)
        let best = null, bd = 1e9;
        for (const o of s.obs) { if (o.dead) continue; const d = Math.abs(o.x + o.w / 2 - c.x); if (d < bd) { bd = d; best = o; } }
        let ty = c.by;
        if (best) { const g = geo(best, f); ty = (g.top + g.bot) / 2 + c.off; }
        c.by += clamp(ty - c.by, -A.fall, A.fall);
        c.y = c.by + A.float * dsin(f * TWO_PI / 60);
        if (!c.lost && c.x < PLAYER_X - 60) { c.lost = true; emit(s, 'crateLost', c); }
      }
      if (c.x < -40) s.crates.splice(i, 1);      // positional only (a claimed crate stays as a ghost entry)
    }
  }

  // =====================================================================
  //  BOSS "THE DEV" (100% bonding curve, before the migration)
  //  Fully scripted on boss time (s.af - f0) + the seed: never on the player.
  //  1 SELL ORDERS: 6 red candles thrown fast on 3 lanes (each one telegraphed by an arrow 0.7 s before)
  //  2 PULL LP: ceiling and floor close into a waving corridor
  //  3 SNIPER SWARM: 3 locked shots, 0.5 s apart
  //  Each attack survived pays TUNE.boss.pay x leverage. Survive all 3 = BEAT THE DEV, then graduation.
  // =====================================================================
  function bossPlan(s){
    const B = TUNE.boss, f0 = s.af;
    const throws = [];
    let lane = 1;
    for (let i = 0; i < B.throws; i++) {
      // next lane: always one lane up or down (a 90 unit move, never 180), seeded
      const r = s.rng();
      if (i > 0) { let d = r < 0.5 ? -1 : 1; if (lane + d < 0 || lane + d >= B.lanes.length) d = -d; lane += d; }
      const warnAt = B.intro + i * B.throwEvery;
      throws.push({ lane, c: MID_Y + B.lanes[lane], warnAt, at: warnAt + B.throwLead, done: false });
    }
    const lastAt = throws[throws.length - 1].at;
    const a1End = lastAt + Math.ceil((W + 30 - (PLAYER_X - TUNE.hit.rx - TUNE.candleW)) / B.throwSpeed) + B.gap;
    const a2Start = a1End + B.gap, a2End = a2Start + B.wallIn + B.wallHold + B.wallOut;
    const a3Start = a2End + B.gap;
    return { f0, throws, a1End, a2Start, a2End, a3Start, ph: s.rng() * TWO_PI, stage: 0, paid: 0, shots: false };
  }
  function startBoss(s){
    const f = s.af;
    // the dev clears the chart: current event ends, candles ahead get eaten
    s.ev = null; s.wind = 0; s.forced = null; s.bundle = null; s.rugNext = false; s.mevNext = false; s.rugEasy = false;
    if (s.fogUntil > f) s.fogUntil = f;
    s.devUntil = s.kol1Until = s.kol2Until = -1;
    for (const o of s.obs) if (!o.dead && o.x > PLAYER_X + 140) { o.dead = true; emit(s, 'shatter', o); }
    s.boss = bossPlan(s);
    s.marks.push({ f, t: 'BOSS' });
    emit(s, 'bossStart', s.boss);
  }
  function bossPay(s, stage){
    const amt = TUNE.boss.pay * s.lev * TUNE.worlds[s.world].mul;
    s.mc += amt; s.boss.paid++;
    emit(s, 'bossPay', stage, amt);
  }
  function bossTick(s){
    const b = s.boss, B = TUNE.boss, el = s.af - b.f0;
    for (const th of b.throws) {
      if (th.done || el < th.at) continue;
      th.done = true;
      const o = {
        x: W + 30, px: W + 30, w: TUNE.candleW, c: th.c, g: B.throwGap, n: s.candleN++, shift: 0, shiftT: 0, ext: 0, drop: 0, spike: 0, spikeMax: 0, osc: null,
        kind: 'red', green: false, rode: false, rug: null, bundle: 0, bundleIdx: -1, bundleTotal: 0, mev: null, passed: false, minClear: 1e9, dead: false,
        boss: true, vx: B.throwSpeed
      };
      s.obs.push(o);
      emit(s, 'bossThrow', o);
    }
    if (b.stage === 0 && el >= b.a1End) { b.stage = 1; bossPay(s, 1); emit(s, 'bossStage', 2); }
    if (b.stage === 1 && el >= b.a2End) { b.stage = 2; bossPay(s, 2); emit(s, 'bossStage', 3); }
    if (b.stage === 2 && !b.shots && el >= b.a3Start) {
      b.shots = true;
      // 3 of the 4 lanes, seeded order: one lane always stays free
      const lanes = B.shotLanes.slice();
      for (let i = lanes.length - 1; i > 0; i--) { const j = Math.floor(s.rng() * (i + 1)); const t = lanes[i]; lanes[i] = lanes[j]; lanes[j] = t; }
      for (let i = 0; i < B.shots; i++) s.shots.push(newShot(s.af + i * B.shotEvery, MID_Y + lanes[i]));
    }
    if (b.stage === 2 && b.shots && el > b.a3Start + 10 && s.shots.every(sh => !sh.boss || sh.done)) {
      bossPay(s, 3);
      s.shots = s.shots.filter(sh => !sh.done);
      s.boss = null; s.bossDone = true; s.bossBeat = true;
      s.price = MID_Y; s.rest = 2; s.dist = 0; s.nextEv = s.af + 6 * 60;
      s.marks.push({ f: s.af, t: 'BEAT' });
      s.sincePass = 0;                 // beating the dev counts as a pass: leverage is kept
      emit(s, 'bossWin');
      graduate(s);
    }
  }
  // corridor of attack 2 at dx world units ahead of the pill: { on, k, top, bot } (lethal above top / below bot)
  function bossWall(s, dx){
    const b = s.boss;
    if (!b) return { on: false, k: 0, top: CEIL_Y, bot: GROUND_Y };
    const B = TUNE.boss, el = s.af - b.f0 - b.a2Start;
    const tot = B.wallIn + B.wallHold + B.wallOut;
    if (el < 0 || el >= tot) return { on: false, k: 0, top: CEIL_Y, bot: GROUND_Y };
    const k = el < B.wallIn ? el / B.wallIn : el >= B.wallIn + B.wallHold ? 1 - (el - B.wallIn - B.wallHold) / B.wallOut : 1;
    const u = el + (dx || 0) / (s.speed > 0.5 ? s.speed : 0.5);
    const c = MID_Y + B.wallAmp * dsin(u * TWO_PI / B.wallPeriod + b.ph);
    return { on: true, k, top: lerp(CEIL_Y, c - B.wallHalf, k), bot: lerp(GROUND_Y, c + B.wallHalf, k) };
  }
  // boss progress 0..1 (for the HP bar)
  function bossProgress(s){
    const b = s.boss;
    if (!b) return s.bossBeat ? 1 : 0;
    const el = s.af - b.f0, end = b.a3Start + TUNE.events.sniper.track + TUNE.events.sniper.lock + (TUNE.boss.shots - 1) * TUNE.boss.shotEvery + 50;
    return clamp(el / end, 0, 1);
  }

  // =====================================================================
  //  RUN RECORD / REPLAY / ENCODING
  // =====================================================================
  function record(s){
    return { v: 4, sim: SIM_VERSION, seed: s.seed, inputs: s.inputs.slice(), score: Math.floor(s.mc), frames: s.frame, af: s.af,
      cause: s.cause, passed: s.passed, world: s.world, revives: s.revives, boss: s.bossBeat ? 1 : 0 };
  }
  const MAX_INPUTS = 60000;
  function sanitizeInputs(arr){
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (let i = 0; i < arr.length && out.length < MAX_INPUTS; i++) {
      const v = arr[i];
      if (typeof v === 'number' && v >= 0 && v === Math.floor(v) && v < 1e8) out.push(v);
    }
    out.sort((a, b) => a - b);
    const uniq = [];
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) uniq.push(out[i]);
    return uniq;
  }
  // feeder(inputs)(frame) -> true if a tap happened on that frame (frames must be asked in increasing order)
  function feeder(inputs){
    const a = sanitizeInputs(inputs);
    let i = 0;
    return function(f){
      while (i < a.length && a[i] < f) i++;
      if (i < a.length && a[i] === f) { i++; return true; }
      return false;
    };
  }
  // replay(run, {maxFrames}) -> recomputed result. Server: compare .score / .frames with the claim.
  function replay(run, opts){
    opts = opts || {};
    const s = newSim(run.seed);
    const feed = feeder(run.inputs);
    const cap = Math.min(opts.maxFrames || 60 * 60 * 30, 60 * 60 * 30);
    while (s.alive && s.frame < cap) step(s, feed(s.frame));
    return { score: Math.floor(s.mc), frames: s.frame, af: s.af, cause: s.cause, alive: s.alive, passed: s.passed, world: s.world, revives: s.revives, boss: s.bossBeat ? 1 : 0, sim: SIM_VERSION };
  }
  // compact input encoding for URLs / storage: frame deltas as base64url varints (5 data bits per char)
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function encodeInputs(inputs){
    const a = sanitizeInputs(inputs);
    let out = '', prev = 0;
    for (let i = 0; i < a.length; i++) {
      let d = a[i] - prev; prev = a[i];
      do { let b = d & 31; d = Math.floor(d / 32); if (d > 0) b |= 32; out += B64[b]; } while (d > 0);
    }
    return out;
  }
  function decodeInputs(str){
    const out = [];
    if (typeof str !== 'string' || str.length > 200000) return out;
    let prev = 0, d = 0, mul = 1;
    for (let i = 0; i < str.length && out.length < MAX_INPUTS; i++) {
      const b = B64.indexOf(str[i]);
      if (b < 0) return [];
      d += (b & 31) * mul;
      if (b & 32) { mul *= 32; if (mul > 1e9) return []; }
      else { prev += d; out.push(prev); d = 0; mul = 1; }
    }
    return out;
  }
  // daily seed: FNV-1a of "pill-or-rug:YYYY-MM-DD" (UTC day), same for everyone
  function dayKey(date){
    const d = date || new Date();
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function dailySeed(key){
    const str = 'pill-or-rug:' + key;
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function dayNumber(key){
    const p = String(key).split('-').map(Number);
    return Math.floor((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(2026, 0, 1)) / 86400000) + 1;
  }

  return {
    SIM_VERSION, W, H, LW, LH, PX, HUD_PX, GROUND_PX, GROUND_TOP, CEIL_Y, GROUND_Y, MID_Y, PLAYER_X, STEP, TUNE,
    clamp, lerp, mulberry32, dsin, diffAt,
    newSim, step, geo, phaseId, causeText, curvePct, startEvent, worldTime, startBoss, bossWall, bossProgress,
    record, replay, feeder, sanitizeInputs, encodeInputs, decodeInputs,
    dayKey, dailySeed, dayNumber
  };
});
