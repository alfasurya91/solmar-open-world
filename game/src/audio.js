/* ------------------------------------------------------------------ */
/* Solmar — synthetic audio engine. Every sound is generated at        */
/* runtime from oscillators and noise: no audio assets ship with the   */
/* game. The AudioContext is created on the first user gesture        */
/* (browser autoplay policy), so the engine starts muted.              */
/* ------------------------------------------------------------------ */

import { AUDIO } from './config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const noop = () => {};
/** Volume shorthand: playShot(a, 0.5) or playShot(a, { volume: 0.5 }). */
const opts = (v) => (v == null ? {} : typeof v === 'number' ? { volume: v } : v);
/** Last engine created, so fire-and-forget calls may omit the handle. */
let activeAudio = null;
const resolve = (audio) => (audio && audio.ctx !== undefined ? audio : activeAudio);
const live = (audio) => !!(audio && audio.ctx && audio.graph && audio.unlocked);
function busOf(audio, name) {
  const g = audio && audio.graph;
  return g ? g.buses[name] || g.buses[AUDIO.buses.sfx] : null;
}
/* --- node factories ------------------------------------------------ */
const mkGain = (ctx, v = 0.0001) => { const g = ctx.createGain(); g.gain.value = v; return g; };
const mkOsc = (ctx, type, hz, detune = 0) => {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz;
  o.detune.value = detune; return o;
};
const mkFilter = (ctx, type, hz, q = 1) => {
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = hz;
  f.Q.value = q; return f;
};
/** Connect nodes in series, return the last one. */
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}
/* --- tuning -------------------------------------------------------- */
const ENGINE = {
  idleHz: 44, redlineHz: 150, subRatio: 0.5, detunedOctave: 1.997,
  idleGain: 0.055, loadGain: 0.085, filterIdle: 340, filterMax: 2300,
  roadGain: 0.075, squealGain: 0.11, smooth: 0.07,
};
const MUSIC = {
  id: 'cruise',
  bpm: 82, stepsPerBar: 8, bassGain: 0.16, padGain: 0.03,
  arpGain: 0.05, kickGain: 0.2, hatGain: 0.018,
  bassSteps: [0, 4],                   // beats that get a bass note
  padSteps: [0],                       // beats that restate the pad
  hatSteps: [1, 3, 5, 7],              // beats that get a brushed hat
  snareGain: 0,                        // 0 disables the snare entirely
  snareSteps: [],
  progression: [                        // one bar per chord, MIDI notes
    { bass: 45, pad: [57, 60, 64, 71] }, // Am7
    { bass: 41, pad: [53, 57, 60, 64] }, // Fmaj7
    { bass: 48, pad: [55, 59, 64, 67] }, // Cmaj7
    { bass: 43, pad: [55, 59, 62, 67] }, // G6
  ],
  arp: [0, 1, 2, 3, 2, 1, 3, 2],
};

/* ------------------------------------------------------------------ */
/* Chase theme — a second, much faster bed the game can swap in while  */
/* a pursuit is live. Same scheduler, different tuning: double tempo,  */
/* a driving eighth-note bass, a backbeat snare and a minor-key run.   */
/* ------------------------------------------------------------------ */
const CHASE_MUSIC = {
  id: 'chase',
  bpm: 158, stepsPerBar: 8, bassGain: 0.17, padGain: 0.022,
  arpGain: 0.062, kickGain: 0.24, hatGain: 0.015,
  bassSteps: [0, 2, 4, 6],
  padSteps: [0, 4],
  hatSteps: [0, 1, 2, 3, 4, 5, 6, 7],  // driving eighth-note hats
  snareGain: 0.11,
  snareSteps: [2, 6],
  progression: [                        // Dm — Bb — F — C, urgent but simple
    { bass: 38, pad: [57, 62, 65, 69] }, // Dm
    { bass: 34, pad: [58, 62, 65, 70] }, // Bb
    { bass: 41, pad: [57, 60, 65, 69] }, // F
    { bass: 36, pad: [55, 60, 64, 67] }, // C
  ],
  arp: [0, 2, 1, 3, 2, 0, 3, 1],
};

/** Every track the scheduler understands, keyed by the id callers pass. */
const TRACKS = Object.freeze({ cruise: MUSIC, chase: CHASE_MUSIC });
const DEFAULT_TRACK = MUSIC.id;

/* --- graph, noise, envelopes --------------------------------------- */
function buildGraph(audio) {
  const ctx = audio.ctx;
  const master = mkGain(ctx);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 22; comp.ratio.value = 5;
  comp.attack.value = 0.004; comp.release.value = 0.24;
  chain(master, comp, ctx.destination);
  // named buses keep systems from sprinkling magic strings around
  const buses = {};
  for (const name of Object.values(AUDIO.buses)) {
    if (name === AUDIO.buses.master) continue;
    /* Keep a handle to the bus gain itself. chain() returns the last node,
     * which here would be the master, so the bus would be unmixable. */
    const trim = mkGain(ctx, 1);
    trim.connect(master);
    buses[name] = trim;
  }
  audio.graph = { master, comp, buses };
  applyBuses(audio);
}

/* Per-bus trim, so music and SFX can be mixed independently of the master
 * mute. Defaults are 1 so a caller that never touches them hears exactly
 * what the engine produced before these controls existed. */
const BUS_TRIM = Object.freeze({
  [AUDIO.buses.sfx]: 'sfx',
  [AUDIO.buses.ui]: 'ui',
  [AUDIO.buses.ambience]: 'ambience',
  [AUDIO.buses.voice]: 'voice',
});

function applyBuses(audio) {
  const buses = audio.graph?.buses;
  if (!buses || !audio.ctx) return;
  const t = audio.ctx.currentTime;
  for (const [busName, trimKey] of Object.entries(BUS_TRIM)) {
    const node = buses[busName];
    if (!node) continue;
    const target = clamp(audio.volumes?.[trimKey] ?? 1, 0, 1);
    node.gain.setTargetAtTime(target, t, 0.05);
  }
}

/** One and a half seconds of pink-ish noise, shared by every voice. */
function noiseBuffer(ctx) {
  if (ctx.__solmarNoise) return ctx.__solmarNoise;
  const len = Math.floor(ctx.sampleRate * 1.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let pink = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    pink = pink * 0.94 + white * 0.06;
    data[i] = white * 0.55 + pink * 1.1;
  }
  return (ctx.__solmarNoise = buf);
}
/** Looping noise source, used by the engine bed, squeal and hats. */
function noiseLoop(ctx) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx); s.loop = true; return s;
}
/** Exponential attack / hold / release on any AudioParam. */
function env(param, t0, peak, attack, hold, release) {
  const p = Math.max(0.0002, peak), a = Math.max(0.001, attack), h = Math.max(0, hold);
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(p, t0 + a);
  if (h > 0) param.setValueAtTime(p, t0 + a + h);
  param.exponentialRampToValueAtTime(0.0001, t0 + a + h + Math.max(0.01, release));
}

const takeVoice = (audio) => audio.voices < AUDIO.maxVoices && (audio.voices++, true);
/** Release the voice slot when the source ends. onended is attached before
 *  start(), and a timer backs it up so a missed event can never permanently
 *  drain the voice budget and silence the game. */
function ended(audio, node, gain, dur) {
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    try { gain.disconnect(); } catch { /* already gone */ }
    audio.voices = Math.max(0, audio.voices - 1);
  };
  node.onended = release;
  setTimeout(release, Math.max(50, (dur + 0.25) * 1000));
}
/* --- one-shot voices ----------------------------------------------- */
/** One oscillator note, with an optional lowpass and pitch glide. */
function tone(audio, o) {
  if (!live(audio) || audio.muted || !takeVoice(audio)) return null;
  const ctx = audio.ctx;
  const t0 = o.time ?? ctx.currentTime, dur = o.dur ?? 0.2;
  const attack = o.attack ?? 0.005, release = o.release ?? Math.max(0.03, dur * 0.7);
  const hz = Math.max(8, o.freq ?? 440);
  const osc = mkOsc(ctx, o.type || 'sine', hz);
  osc.frequency.setValueAtTime(hz, t0);        // anchor pitch for future notes
  if (o.endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.endFreq), t0 + dur);
  const gain = mkGain(ctx);
  env(gain.gain, t0, o.gain ?? 0.18, attack, Math.max(0, dur - attack - release), release);
  const head = o.lowpass ? chain(osc, mkFilter(ctx, 'lowpass', o.lowpass, o.q ?? 0.9)) : osc;
  chain(head, gain, busOf(audio, o.bus));
  ended(audio, osc, gain, dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  return osc;
}
/** Filtered noise burst: impacts, gunshots, squeal, hats. */
function burst(audio, o) {
  if (!live(audio) || audio.muted || !takeVoice(audio)) return null;
  const ctx = audio.ctx;
  const t0 = o.time ?? ctx.currentTime, dur = o.dur ?? 0.12;
  const src = noiseLoop(ctx);
  const filter = mkFilter(ctx, o.type || 'bandpass', o.freq ?? 1800, o.q ?? 0.8);
  filter.frequency.setValueAtTime(o.freq ?? 1800, t0);
  if (o.endFreq) filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.endFreq), t0 + dur);
  const gain = mkGain(ctx);
  env(gain.gain, t0, o.gain ?? 0.3, o.attack ?? 0.002, Math.max(0, dur * 0.15), o.release ?? dur);
  chain(src, filter, gain, busOf(audio, o.bus));
  ended(audio, src, gain, dur);
  src.start(t0);
  src.stop(t0 + dur + 0.06);
  return src;
}
/* --- continuous voices: engine, siren, music ----------------------- */
function startEngine(audio) {
  if (audio.engine || !live(audio)) return;
  const ctx = audio.ctx;
  const bus = busOf(audio, AUDIO.buses.sfx);
  const gain = mkGain(ctx);
  const filter = mkFilter(ctx, 'lowpass', ENGINE.filterIdle, 3.2);
  // two saws plus a square sub; the detuned octave gives slow beating
  const o1 = mkOsc(ctx, 'sawtooth', ENGINE.idleHz);
  const o2 = mkOsc(ctx, 'square', ENGINE.idleHz * ENGINE.subRatio);
  const o3 = mkOsc(ctx, 'sawtooth', ENGINE.idleHz * ENGINE.detunedOctave, -9);
  const subGain = mkGain(ctx, 0.45);
  chain(o1, filter);
  chain(o2, subGain, filter);
  chain(o3, filter);
  chain(filter, gain, bus);
  o1.start(); o2.start(); o3.start();
  // looping noise beds, one for the road and one for tyre squeal
  const bed = (hz, q) => {
    const src = noiseLoop(ctx), g = mkGain(ctx), f = mkFilter(ctx, 'bandpass', hz, q);
    chain(src, f, g, bus); src.start();
    return { src, g, f };
  };
  const road = bed(620, 0.5), squeal = bed(1750, 7);
  audio.engine = {
    o1, o2, o3, subGain, filter, gain,
    road: road.src, roadGain: road.g, roadFilter: road.f,
    squeal: squeal.src, squealGain: squeal.g, squealFilter: squeal.f,
  };
}
/** Continuous siren: a square LFO flips the pitch between two fixed tones,
 *  which is what gives a cruiser its hi-lo wail. Urgency (driven from
 *  updateAudio) raises the flip rate, so a level-5 chase yelps while a
 *  level-2 patrol moans. */
function startSirenVoice(audio) {
  if (audio.siren || !live(audio)) return;
  const ctx = audio.ctx;
  const HI = 1030, LO = 610;                  // the two tones
  const osc = mkOsc(ctx, 'square', HI);
  const lfo = mkOsc(ctx, 'square', 1.1);      // square => hard two-step flip
  const lfoGain = mkGain(ctx, (HI - LO) / 2);
  // bias the oscillator to the midpoint so the LFO swings ±(HI-LO)/2
  osc.frequency.setValueAtTime((HI + LO) / 2, ctx.currentTime);
  chain(lfo, lfoGain, osc.frequency);
  // a second detuned voice an octave down thickens the horn
  const sub = mkOsc(ctx, 'sawtooth', LO / 2, 6);
  const subGain = mkGain(ctx, 0.35);
  chain(sub, subGain);
  const filter = mkFilter(ctx, 'bandpass', 880, 1.8);
  const gain = mkGain(ctx);
  chain(osc, filter);
  chain(subGain, filter);
  chain(filter, gain, busOf(audio, AUDIO.buses.sfx));
  osc.start(); lfo.start(); sub.start();
  audio.siren = { osc, lfo, lfoGain, filter, gain, sub, hi: HI, lo: LO };
}
function startMusic(audio) {
  if (audio.music || !live(audio)) return;
  const ctx = audio.ctx;
  const bus = mkGain(ctx);
  bus.connect(busOf(audio, AUDIO.buses.music) || busOf(audio, AUDIO.buses.sfx));
  /* Honour a track picked from a menu before the first gesture. */
  const track = TRACKS[audio.track] ? audio.track : DEFAULT_TRACK;
  audio.music = {
    bus, step: 0, nextTime: ctx.currentTime + 0.12,
    track, stepDur: 60 / TRACKS[track].bpm / 2,
  };
}

/** Switch the running loop to another track without tearing down the bus.
 *  The step clock restarts at the next eighth note, so a swap lands on a
 *  beat instead of mid-phrase. Works before the graph exists too: the choice
 *  is remembered and startMusic() opens with it. */
function setMusicTrack(audio, id) {
  const next = TRACKS[id] ? id : DEFAULT_TRACK;
  audio.track = next;
  const m = audio.music;
  if (!m) return next;
  if (m.track === next) return next;
  m.track = next;
  m.step = 0;
  m.stepDur = 60 / TRACKS[next].bpm / 2;
  if (audio.ctx) m.nextTime = audio.ctx.currentTime + 0.06;
  return next;
}
/** One eighth-note step of the loop, scheduled at an absolute time. */
function scheduleStep(audio, step, time) {
  const ctx = audio.ctx, m = audio.music;
  const track = TRACKS[m.track] || MUSIC;
  const chord = track.progression[Math.floor(step / track.stepsPerBar) % track.progression.length];
  const beat = step % track.stepsPerBar;
  const beatDur = 60 / track.bpm;
  const voice = (type, freq, peak, dur, attack, release, filterHz) => {
    const osc = mkOsc(ctx, type, freq);
    const g = mkGain(ctx);
    env(g.gain, time, peak, attack, 0, release);
    const head = filterHz ? chain(osc, mkFilter(ctx, 'lowpass', filterHz, 1.1)) : osc;
    chain(head, g, m.bus);
    osc.start(time);
    osc.stop(time + dur);
    osc.onended = () => { try { g.disconnect(); } catch { /* noop */ } };
  };
  if (track.bassSteps.includes(beat)) {
    voice('sine', mtof(chord.bass), track.bassGain, beatDur * 1.6, 0.03, beatDur * 1.5);
    voice('sine', 56, track.kickGain, 0.28, 0.004, 0.2);
  }
  if (track.padSteps.includes(beat)) {   // warm pad, nudged off-centre for width
    for (const note of chord.pad) {
      voice('triangle', mtof(note) * (1 + (Math.random() * 0.008 - 0.004)),
        track.padGain, beatDur * 3.1, 0.35, beatDur * 1.2);
    }
  }
  const arpNote = chord.pad[track.arp[beat] % chord.pad.length] + 12;
  voice('triangle', mtof(arpNote), track.arpGain, m.stepDur * 1.8, 0.008, m.stepDur * 1.4, 2600);
  if (track.snareGain > 0 && track.snareSteps.includes(beat)) { // backbeat
    const snare = noiseLoop(ctx), sg = mkGain(ctx);
    env(sg.gain, time, track.snareGain, 0.003, 0, 0.1);
    chain(snare, mkFilter(ctx, 'bandpass', 1900, 0.9), sg, m.bus);
    snare.start(time);
    snare.stop(time + 0.14);
    snare.onended = () => { try { sg.disconnect(); } catch { /* noop */ } };
  }
  if (track.hatSteps.includes(beat)) {  // brushed hat on the offbeats
    const hat = noiseLoop(ctx), hg = mkGain(ctx);
    env(hg.gain, time, track.hatGain, 0.003, 0, 0.055);
    chain(hat, mkFilter(ctx, 'highpass', 6200, 0.7), hg, m.bus);
    hat.start(time);
    hat.stop(time + 0.09);
    hat.onended = () => { try { hg.disconnect(); } catch { /* noop */ } };
  }
}
/* --- autoplay unlock ----------------------------------------------- */
function applyMaster(audio) {
  if (!audio.ctx || !audio.graph) return;
  const t = audio.ctx.currentTime;
  const g = audio.graph.master.gain;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(audio.muted ? 0.0001 : AUDIO.masterVolume, t, 0.08);
}
function unlock(audio) {
  if (!audio) return;
  const Ctor = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!Ctor) return;
  audio.unlocked = true;                       // gates live(), so set it first
  if (!audio.ctx) {
    try { audio.ctx = new Ctor({ latencyHint: 'interactive' }); }
    catch { audio.unlocked = false; return; }  // no audio output available
    buildGraph(audio);
    startEngine(audio);
    startMusic(audio);
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume?.().catch(noop);
  if (!audio.userMuted) audio.muted = false;   // the first gesture lifts the mute
  applyMaster(audio);
  if (audio.engine) {
    audio.engine.gain.gain.setTargetAtTime(ENGINE.idleGain, audio.ctx.currentTime, 0.2);
  }
}
function bindUnlock(audio) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
  const handler = () => {
    unlock(audio);
    if (audio.unlocked) for (const ev of events) window.removeEventListener(ev, handler);
  };
  for (const ev of events) window.addEventListener(ev, handler, { passive: true });
  audio.detachUnlock = () => {
    for (const ev of events) window.removeEventListener(ev, handler);
  };
}
/* --- public API ---------------------------------------------------- */
/** Create the audio state. Nothing allocates until the first gesture. */
export function createAudio(options = {}) {
  const audio = {
    ctx: null, graph: null, engine: null, siren: null, music: null,
    voices: 0, muted: true, userMuted: false, unlocked: false, options,
    /* Independent mixes, applied to the named buses. 1 = untouched. */
    musicVolume: clamp(options.musicVolume ?? 1, 0, 1),
    sfxVolume: clamp(options.sfxVolume ?? 1, 0, 1),
    volumes: {
      music: clamp(options.musicVolume ?? 1, 0, 1),
      sfx: clamp(options.sfxVolume ?? 1, 0, 1),
      ui: clamp(options.uiVolume ?? 1, 0, 1),
      ambience: 1,
      voice: 1,
    },
  };
  activeAudio = audio;
  bindUnlock(audio);
  return audio;
}
/** Drive the continuous voices. `snapshot` may carry speed, maxSpeed,
 *  throttle, boosting, revving, drifting, slip, wanted, siren and paused. */
export function updateAudio(audio, snapshot = {}, dt = 1 / 60) {
  const a = resolve(audio);
  if (!a || !a.ctx) return;
  if (a.ctx.state === 'suspended' && a.unlocked) a.ctx.resume?.().catch(noop);
  const t = a.ctx.currentTime;
  const speed = Math.max(0, snapshot.speed ?? 0);
  const drive = clamp(speed / (snapshot.maxSpeed ?? 325), 0, 1.15);
  const load = clamp(snapshot.throttle ?? drive, 0, 1);
  const eng = a.engine;
  if (eng) {
    // pitch tracks speed; the detuned third voice thickens the top end
    const hz = lerp(ENGINE.idleHz, ENGINE.redlineHz, drive) * (snapshot.boosting ? 1.1 : 1);
    eng.o1.frequency.setTargetAtTime(hz, t, ENGINE.smooth);
    eng.o2.frequency.setTargetAtTime(hz * ENGINE.subRatio, t, ENGINE.smooth);
    eng.o3.frequency.setTargetAtTime(hz * ENGINE.detunedOctave, t, ENGINE.smooth);
    eng.filter.frequency.setTargetAtTime(
      lerp(ENGINE.filterIdle, ENGINE.filterMax, drive) + load * 240, t, 0.1);
    const revving = snapshot.revving ? 0.05 : 0;
    eng.gain.gain.setTargetAtTime(
      a.muted ? 0.0001 : ENGINE.idleGain + ENGINE.loadGain * load + revving, t, 0.12);
    eng.roadGain.gain.setTargetAtTime(
      a.muted ? 0.0001 : ENGINE.roadGain * (0.25 + drive * 0.9), t, 0.2);
    const slip = clamp(snapshot.slip ?? 0, 0, 1);
    const squealing = !a.muted && (snapshot.drifting || slip > 0.35);
    eng.squealGain.gain.setTargetAtTime(
      squealing ? ENGINE.squealGain * clamp(slip + 0.4, 0, 1) : 0.0001, t, 0.08);
    eng.squealFilter.frequency.setTargetAtTime(1500 + slip * 900, t, 0.15);
    eng.o1.detune.setTargetAtTime(drive > 0.05 ? -6 - drive * 8 : 0, t, 0.3);
  }
  const wanted = snapshot.wanted ?? 0;
  const sirenOn = !!(snapshot.siren || wanted >= 2);
  if (sirenOn) startSirenVoice(a);
  if (a.siren) {
    const sirenVol = 0.055 * clamp(a.volumes?.sfx ?? 1, 0, 1);
    a.siren.gain.gain.setTargetAtTime(a.muted || !sirenOn ? 0.0001 : sirenVol, t, 0.16);
    const urgency = clamp(wanted / 5, 0, 1);
    // hi-lo flip rate: ~0.9 Hz on a soft tail, ~2.4 Hz at five stars
    a.siren.lfo.frequency.setTargetAtTime(0.9 + urgency * 1.5, t, 0.3);
    a.siren.filter.frequency.setTargetAtTime(820 + urgency * 260, t, 0.4);
    // a wider swing as the chase heats up, kept around the two base tones
    const span = ((a.siren.hi - a.siren.lo) / 2) * (0.75 + urgency * 0.5);
    a.siren.lfoGain.gain.setTargetAtTime(span, t, 0.3);
    a.siren.sub.frequency.setTargetAtTime(a.siren.lo / 2, t, 0.4);
  }
  // Swap in the fast theme once a pursuit is actually live.
  const chase = snapshot.chase ?? ((snapshot.wanted ?? 0) >= 2 || !!snapshot.siren);
  setMusicTrack(a, chase ? 'chase' : DEFAULT_TRACK);
  updateMusic(a, snapshot);
  void dt;
}
/** Look-ahead scheduler: keeps a quarter second of music queued. */
function updateMusic(audio, snapshot) {
  const m = audio.music;
  if (!m || !audio.ctx) return;
  const t = audio.ctx.currentTime;
  const quiet = audio.muted || snapshot.paused;
  const duck = snapshot.wanted > 0 ? 0.6 : 1;   // duck under a chase
  const base = AUDIO.musicVolume * clamp(audio.musicVolume ?? 1, 0, 1);
  m.bus.gain.setTargetAtTime(
    quiet ? 0.0001 : base * duck, t, Math.max(0.05, AUDIO.musicFade * 0.35));
  if (quiet) { m.nextTime = t + 0.08; return; }
  if (m.nextTime < t - 0.4) m.nextTime = t + 0.05;
  const track = TRACKS[m.track] || MUSIC;
  let guard = 0;
  while (m.nextTime < t + 0.25 && guard++ < 16) {
    scheduleStep(audio, m.step, m.nextTime);
    m.nextTime += m.stepDur;
    m.step = (m.step + 1) % (track.stepsPerBar * track.progression.length);
  }
}
/* --- one-shots ----------------------------------------------------- */
/** Gunshot. Defaults to the pistol crack (bright noise slap over a low body
 *  thump), unchanged. `{ weapon: 'rifle' }` plays the sharper, longer rifle
 *  report on top of it: a harder transient, a mid-band crackle and a tail
 *  that rings out — so the two are clearly different from across the street.
 *
 *    playShot(audio)                        pistol
 *    playShot(audio, 0.6)                   pistol, 60% volume
 *    playShot(audio, { weapon: 'rifle' })   rifle
 */
export function playShot(audio, options) {
  const a = resolve(audio), o = opts(options);
  const vol = o.volume ?? 1;
  const weapon = typeof o.weapon === 'string' ? o.weapon.toLowerCase() : 'pistol';

  if (weapon === 'rifle' || weapon === 'smg' || weapon === 'shotgun') {
    const rifle = weapon === 'rifle' || weapon === 'smg';
    // sharp supersonic crack
    burst(a, { dur: rifle ? 0.18 : 0.26, gain: 0.78 * vol,
      freq: rifle ? 4200 : 3000, endFreq: rifle ? 900 : 520, q: rifle ? 1.1 : 0.6 });
    // body thump, tuned lower and shorter than the pistol's
    tone(a, { type: rifle ? 'square' : 'sawtooth', freq: rifle ? 240 : 170,
      endFreq: 62, dur: rifle ? 0.14 : 0.22, gain: 0.42 * vol, lowpass: rifle ? 1500 : 1100 });
    // mid crackle that the pistol does not have
    burst(a, { dur: rifle ? 0.05 : 0.09, gain: 0.24 * vol, freq: 1600, q: 2.2, attack: 0.001 });
    // ringing tail so a rifle report carries further than a pistol
    burst(a, { dur: rifle ? 0.34 : 0.4, gain: 0.1 * vol, freq: 2600,
      endFreq: 640, q: 0.9, attack: 0.004, release: 0.5 });
    return;
  }

  burst(a, { dur: 0.11, gain: 0.5 * vol, freq: 2400, endFreq: 620, q: 0.7 });
  tone(a, { type: 'sine', freq: 190, endFreq: 58, dur: 0.15, gain: 0.34 * vol, lowpass: 900 });
  burst(a, { dur: 0.03, gain: 0.16 * vol, freq: 5200, q: 1.4, attack: 0.001 });
}

/** Rifle report as its own entry point, for call sites that know the weapon
 *  without wanting to build an options object. Identical to
 *  playShot(audio, { weapon: 'rifle', volume }). */
export function playRifleShot(audio, options) {
  const o = opts(options);
  playShot(resolve(audio), { ...o, weapon: 'rifle' });
}

/** One footstep. `surface` picks the character: 'concrete' (default),
 *  'sand' (soft, muffled) or 'grass' (airy rustle). `running` makes the
 *  heel strike harder and shorter. Deliberately quiet — footsteps are a
 *  texture under the engine, not an event. */
export function playFootstep(audio, options) {
  const a = resolve(audio), o = opts(options);
  const vol = o.volume ?? 1;
  const surface = typeof o.surface === 'string' ? o.surface.toLowerCase() : 'concrete';
  const running = !!o.running;

  if (surface === 'sand') {
    burst(a, { dur: running ? 0.09 : 0.12, gain: (running ? 0.3 : 0.24) * vol,
      freq: 780, endFreq: 300, q: 0.5, type: 'lowpass', attack: 0.006 });
    return;
  }
  if (surface === 'grass') {
    burst(a, { dur: running ? 0.08 : 0.11, gain: 0.2 * vol,
      freq: 3200, endFreq: 1500, q: 0.8, attack: 0.008 });
    return;
  }
  // concrete: a short bright toe/heel tick over a dull pad
  burst(a, { dur: running ? 0.045 : 0.06, gain: (running ? 0.42 : 0.3) * vol,
    freq: running ? 2900 : 2300, endFreq: 900, q: 1.6, attack: 0.001 });
  tone(a, { type: 'sine', freq: running ? 140 : 105, endFreq: 60,
    dur: running ? 0.07 : 0.09, gain: 0.2 * vol, lowpass: 700 });
}
/** Fist: muffled low thud with a short skin slap. */
export function playPunch(audio, options) {
  const a = resolve(audio), vol = opts(options).volume ?? 1;
  burst(a, { dur: 0.09, gain: 0.34 * vol, freq: 720, endFreq: 220, q: 0.6, type: 'lowpass' });
  tone(a, { type: 'sine', freq: 128, endFreq: 46, dur: 0.14, gain: 0.4 * vol, lowpass: 520 });
  burst(a, { dur: 0.028, gain: 0.1 * vol, freq: 2600, q: 1.2 });
}
/** Pickup chime: three rising bell notes on the UI bus. */
export function playPickup(audio, options) {
  const a = resolve(audio), vol = opts(options).volume ?? 1;
  if (!live(a)) return;
  const t = a.ctx.currentTime;
  [83, 88, 95].forEach((n, i) => {                     // B5, E6, B6
    const at = t + i * 0.055;
    tone(a, { type: 'sine', freq: mtof(n), dur: 0.2 + i * 0.06, attack: 0.004,
      gain: (0.14 - i * 0.025) * vol, time: at, bus: AUDIO.buses.ui });
    tone(a, { type: 'triangle', freq: mtof(n) * 2, dur: 0.12,
      gain: (0.05 - i * 0.01) * vol, time: at, bus: AUDIO.buses.ui });
  });
}
/** Mission complete: warm fanfare over a sustained pad. */
export function playMissionComplete(audio, options) {
  const a = resolve(audio), vol = opts(options).volume ?? 1;
  if (!live(a)) return;
  const t = a.ctx.currentTime;
  [69, 72, 76, 81].forEach((n, i) => {                 // A4 C5 E5 A5
    const last = i === 3, at = t + i * 0.14;
    tone(a, { type: 'triangle', freq: mtof(n), dur: last ? 1.1 : 0.24, attack: 0.01,
      gain: (0.16 + (last ? 0.04 : 0)) * vol, lowpass: 4200, time: at, bus: AUDIO.buses.ui });
    tone(a, { type: 'sine', freq: mtof(n + 12), dur: last ? 0.9 : 0.2,
      gain: 0.045 * vol, time: at, bus: AUDIO.buses.ui });
  });
  for (const n of [57, 64, 69]) {                      // sustained Am bed
    tone(a, { type: 'sine', freq: mtof(n), dur: 1.35, gain: 0.05 * vol,
      attack: 0.25, time: t, bus: AUDIO.buses.ui });
  }
  burst(a, { dur: 0.6, gain: 0.05 * vol, freq: 4800, q: 0.6,
    attack: 0.05, release: 0.7, bus: AUDIO.buses.ui });
}
/** Two-tone wail as a one-shot; the looping siren lives in updateAudio. */
export function playSiren(audio, options) {
  const a = resolve(audio), o = opts(options);
  const duration = o.duration ?? 1.6, vol = o.volume ?? 1;
  if (!live(a) || a.muted) return;
  const ctx = a.ctx, t0 = ctx.currentTime;
  const osc = mkOsc(ctx, 'square', 940);
  const segment = 0.32;                                // alternate hi/lo
  for (let t = 0; t < duration; t += segment) {
    osc.frequency.setValueAtTime(t % (segment * 2) === 0 ? 940 : 690, t0 + t);
  }
  const gain = mkGain(ctx);
  env(gain.gain, t0, 0.07 * vol, 0.04, Math.max(0, duration - 0.2), 0.18);
  chain(osc, mkFilter(ctx, 'bandpass', 900, 2.4), gain, busOf(a, AUDIO.buses.sfx));
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
  osc.onended = () => { try { gain.disconnect(); } catch { /* noop */ } };
}
/** UI click: dry and quiet so menus never fatigue the ear. */
export function playClick(audio, options) {
  const a = resolve(audio), o = opts(options), vol = o.volume ?? 1;
  if (!live(a)) return;
  const freq = o.low ? 640 : 1180;
  tone(a, { type: 'square', freq, endFreq: freq * 0.82, dur: 0.045,
    gain: 0.05 * vol, attack: 0.002, bus: AUDIO.buses.ui });
  burst(a, { dur: 0.02, gain: 0.02 * vol, freq: 4200, q: 1.1, bus: AUDIO.buses.ui });
}
/** Mute or unmute everything. Accepts (audio, bool) or a bare bool that
 *  targets the most recent engine; returns the resulting mute state. */
export function setMuted(audio, value = true) {
  let a = audio, next = value;
  if (typeof audio === 'boolean') { a = activeAudio; next = audio; }
  if (!a) return false;
  a.userMuted = a.muted = !!next;
  if (!a.muted) {
    if (!a.ctx) {
      unlock(a);                              // allow unmuting before a gesture
    } else {
      if (a.ctx.state === 'suspended') a.ctx.resume?.().catch(noop);
      if (!a.unlocked) {
        a.unlocked = true;
        if (!a.engine) startEngine(a);
        if (!a.music) startMusic(a);
      }
    }
  }
  applyMaster(a);
  if (a.music && a.ctx) a.music.nextTime = a.ctx.currentTime + 0.08;
  return a.muted;
}

/* --- independent music / SFX volume --------------------------------- */
/*
 * These act on the named buses, so a player can turn the music down without
 * losing gunfire and sirens. Levels are 0..1 multipliers relative to the
 * AUDIO.* base in config; the master mute is untouched by them, and a level
 * set before the first gesture is kept and applied when the graph is built.
 *
 *   setMusicVolume(audio, 0.25)   quieter music, SFX untouched
 *   setSfxVolume(audio, 0)        silence SFX, music keeps playing
 *   getVolumes(audio)             { music, sfx, ui, master, muted }
 */

/** Clamp an incoming level; non-numbers return null so callers can ignore. */
function level(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n, 0, 1) : null;
}

/**
 * setMusicVolume(audio, level) -> number
 *
 * Sets the music level (0..1) and returns what was applied. Also accepts a
 * bare number, which targets the most recent engine. Applies immediately when
 * the graph exists and is remembered otherwise, so it is safe to call on a
 * settings screen before the first click.
 */
export function setMusicVolume(audio, value) {
  let a = audio, next = value;
  if (typeof audio === 'number') { a = activeAudio; next = audio; }
  const v = level(next);
  if (!a || v === null) return a ? clamp(a.musicVolume ?? 1, 0, 1) : 0;
  a.musicVolume = v;
  a.volumes = { ...(a.volumes || {}), music: v };
  applyBuses(a);
  if (a.music && a.ctx) a.music.nextTime = a.ctx.currentTime + 0.08;
  return v;
}

/**
 * setSfxVolume(audio, level) -> number
 *
 * Sets the SFX level (0..1): gunshots, sirens, footsteps, impact bursts.
 * The looping siren and engine follow it too, since they live on the same
 * bus. Same call shapes as setMusicVolume().
 */
export function setSfxVolume(audio, value) {
  let a = audio, next = value;
  if (typeof audio === 'number') { a = activeAudio; next = audio; }
  const v = level(next);
  if (!a || v === null) return a ? clamp(a.sfxVolume ?? 1, 0, 1) : 0;
  a.sfxVolume = v;
  a.volumes = { ...(a.volumes || {}), sfx: v };
  applyBuses(a);
  return v;
}

/** Toggle back and forth in one call, handy for a key binding or a slider
 *  that steps: setMusicVolumeBy(audio, -0.1) lowers music by 10%. Returns
 *  the new level. */
export function setMusicVolumeBy(audio, delta) {
  const a = resolve(audio);
  const d = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0;
  return setMusicVolume(a, clamp((a?.musicVolume ?? 1) + d, 0, 1));
}

export function setSfxVolumeBy(audio, delta) {
  const a = resolve(audio);
  const d = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0;
  return setSfxVolume(a, clamp((a?.sfxVolume ?? 1) + d, 0, 1));
}

/** Current mix, for a settings UI that has to paint its sliders. Values are
 *  the 0..1 multipliers, not the scaled bus gains. */
export function getVolumes(audio) {
  const a = resolve(audio);
  if (!a) return { music: 1, sfx: 1, ui: 1, master: 0, muted: true };
  return {
    music: clamp(a.musicVolume ?? 1, 0, 1),
    sfx: clamp(a.sfxVolume ?? 1, 0, 1),
    ui: clamp(a.volumes?.ui ?? 1, 0, 1),
    master: AUDIO.masterVolume,
    muted: !!a.muted,
  };
}

/**
 * setMusicTrack(audio, id) -> string
 *
 * Picks the looping theme: 'cruise' (the original 82 BPM bed) or 'chase'
 * (the fast pursuit theme). Unknown ids fall back to 'cruise'. updateAudio()
 * calls this itself — it swaps to 'chase' while a pursuit is live — so this
 * export exists for a music-select screen or a manual override.
 */
export function setMusicTrackById(audio, id) {
  const a = resolve(audio);
  if (!a) return DEFAULT_TRACK;
  if (!a.music) startMusic(a);
  return setMusicTrack(a, id);
}

/** The theme currently queued, whether or not the graph is up yet. */
export function getMusicTrack(audio) {
  const a = resolve(audio);
  if (!a) return DEFAULT_TRACK;
  return a.music?.track ?? (TRACKS[a.track] ? a.track : DEFAULT_TRACK);
}
