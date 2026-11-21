// Solmar audio: WebAudio synthesis — effects, looped music, engine hum tracking car speed.
// No audio files; everything generated at runtime. AudioContext created lazily on first gesture.

const MUSIC_LEVEL = 0.3;
const SFX_LEVEL = 0.55;
const ENGINE_LEVEL = 0.14;

const TOP_SPEED = 320;
const TEMPO = 68;
const ROOT = 55;

export function createAudio() {
  return {
    ctx: null,
    master: null,
    musicBus: null,
    sfxBus: null,
    engineBus: null,
    noiseBuffer: null,
    enabled: true,
    muted: false,
    engineOsc: null,
    engineSub: null,
    engineSubFilter: null,
    engineSubGain: null,
    engineMix: null,
    engineLfo: null,
    engineLfoGain: null,
    engineActive: false,
    engineLevel: 0,
    lastSpeed: 0,
    musicPlaying: false,
    musicRun: 0,
    musicTimer: null,
    bassIndex: 0,
    arpIndex: 0,
    musicStart: 0,
  };
}

function ensureContext(audio) {
  if (!audio) return null;

  if (audio.ctx) {
    if (audio.ctx.state === 'suspended' && audio.enabled) audio.ctx.resume().catch(() => {});
    return audio.ctx;
  }

  const Ctor = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null;
  if (!Ctor) return null;

  let ctx;
  try {
    ctx = new Ctor();
  } catch (err) {
    return null;
  }

  audio.ctx = ctx;

  const master = ctx.createGain();
  master.gain.value = audio.muted ? 0 : 1;
  master.connect(ctx.destination);
  audio.master = master;

  const musicBus = ctx.createGain();
  musicBus.gain.value = MUSIC_LEVEL;
  musicBus.connect(master);
  audio.musicBus = musicBus;

  const sfxBus = ctx.createGain();
  sfxBus.gain.value = SFX_LEVEL;
  sfxBus.connect(master);
  audio.sfxBus = sfxBus;

  const engineBus = ctx.createGain();
  engineBus.gain.value = 0;
  engineBus.connect(master);
  audio.engineBus = engineBus;

  audio.noiseBuffer = buildNoise(ctx, 0.5);

  if (ctx.state === 'suspended' && audio.enabled) ctx.resume().catch(() => {});
  return ctx;
}

function buildNoise(ctx, seconds) {
  const length = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export function setEnabled(audio, on) {
  if (!audio) return;
  audio.enabled = !!on;
  if (!audio.ctx) return;

  if (audio.enabled) {
    audio.ctx.resume().catch(() => {});
    if (audio.musicPlaying) {
      if (audio.musicTimer !== null) {
        clearTimeout(audio.musicTimer);
        audio.musicTimer = null;
      }
      audio.musicStart = audio.ctx.currentTime + 0.1;
      scheduleMusic(audio, audio.musicRun);
    }
    return;
  }

  stopEngine(audio, true);
  if (audio.musicTimer !== null) {
    clearTimeout(audio.musicTimer);
    audio.musicTimer = null;
  }
  audio.ctx.suspend().catch(() => {});
}

export function setMuted(audio, muted) {
  if (!audio) return;
  audio.muted = !!muted;
  if (audio.master && audio.ctx) {
    const now = audio.ctx.currentTime;
    audio.master.gain.cancelScheduledValues(now);
    audio.master.gain.setTargetAtTime(audio.muted ? 0 : 1, now, 0.02);
  }
  if (audio.muted) stopEngine(audio, true);
}

export function playSfx(audio, name) {
  if (!audio || !audio.enabled || audio.muted) return;
  const ctx = ensureContext(audio);
  if (!ctx) return;

  switch (name) {
    case 'engine': engineRev(audio); break;
    case 'skid': skid(audio); break;
    case 'crash': crash(audio); break;
    case 'pickup': pickup(audio); break;
    case 'punch': punchHit(audio); break;
    case 'shoot': gunshot(audio); break;
    case 'siren': siren(audio); break;
    case 'mission': missionSting(audio); break;
    case 'success': successSting(audio); break;
    case 'click': click(audio); break;
    case 'arrest': arrestSting(audio); break;
    default: break;
  }
}

function tone(audio, {
  freq = 440,
  type = 'sine',
  at = 0,
  dur = 0.2,
  peak = 0.15,
  attack = 0.005,
  hold = 0,
  bus = 'sfx',
  sweep = 'exp',
} = {}) {
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  if (Array.isArray(freq)) {
    const from = Math.max(1, freq[0]);
    const to = Math.max(1, freq[1]);
    osc.frequency.setValueAtTime(from, t0);
    if (sweep === 'linear') osc.frequency.linearRampToValueAtTime(to, t0 + dur);
    else osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  } else {
    osc.frequency.setValueAtTime(Math.max(1, freq), t0);
  }

  const apex = Math.max(0.0001, peak);
  const rise = Math.max(0.001, attack);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(apex, t0 + rise);
  if (hold > 0) gain.gain.setValueAtTime(apex, t0 + rise + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + rise + hold + dur);

  osc.connect(gain);
  gain.connect(bus === 'music' ? audio.musicBus : audio.sfxBus);
  osc.start(t0);
  osc.stop(t0 + rise + hold + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
  return osc;
}

function noiseBurst(audio, {
  at = 0,
  dur = 0.2,
  peak = 0.12,
  filter = 'bandpass',
  freq = 900,
  freqTo = null,
  q = 4,
} = {}) {
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  const shape = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  src.buffer = audio.noiseBuffer;
  shape.type = filter;
  shape.frequency.setValueAtTime(Math.max(20, freq), t0);
  if (freqTo) shape.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t0 + dur);
  shape.Q.value = q;

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(Math.max(0.0001, peak), t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(shape);
  shape.connect(gain);
  gain.connect(audio.sfxBus);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
  src.onended = () => {
    src.disconnect();
    shape.disconnect();
    gain.disconnect();
  };
}

function engineRev(audio) {
  tone(audio, { freq: [90, 235], type: 'sawtooth', dur: 0.22, peak: 0.16, attack: 0.01 });
  tone(audio, { freq: [70, 110], type: 'square', at: 0.02, dur: 0.3, peak: 0.05 });
}

function skid(audio) {
  noiseBurst(audio, { dur: 0.42, peak: 0.14, filter: 'bandpass', freq: 2600, freqTo: 700, q: 1.4 });
  noiseBurst(audio, { at: 0.03, dur: 0.3, peak: 0.06, filter: 'highpass', freq: 1800, q: 0.8 });
}

function crash(audio) {
  tone(audio, { freq: [70, 32], type: 'sine', dur: 0.3, peak: 0.34, attack: 0.004 });
  noiseBurst(audio, { dur: 0.26, peak: 0.16, filter: 'highpass', freq: 1500, q: 0.9 });
  noiseBurst(audio, { at: 0.02, dur: 0.14, peak: 0.08, filter: 'bandpass', freq: 3200, q: 3 });
}

function pickup(audio) {
  const notes = [784, 1047, 1319];
  notes.forEach((freq, i) => {
    tone(audio, { freq, type: 'sine', at: i * 0.055, dur: 0.18, peak: 0.15 });
    tone(audio, { freq: freq * 2, type: 'triangle', at: i * 0.055, dur: 0.09, peak: 0.04 });
  });
}

function punchHit(audio) {
  tone(audio, { freq: [150, 62], type: 'triangle', dur: 0.12, peak: 0.24, attack: 0.003 });
  noiseBurst(audio, { dur: 0.07, peak: 0.09, filter: 'lowpass', freq: 900, q: 0.7 });
}

function gunshot(audio) {
  noiseBurst(audio, { dur: 0.09, peak: 0.22, filter: 'highpass', freq: 1400, q: 0.7 });
  tone(audio, { freq: [260, 70], type: 'square', dur: 0.07, peak: 0.14, attack: 0.002 });
  noiseBurst(audio, { at: 0.05, dur: 0.28, peak: 0.045, filter: 'bandpass', freq: 700, freqTo: 260, q: 1.1 });
}

function siren(audio) {
  const ctx = audio.ctx;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(680, t0);
  osc.frequency.linearRampToValueAtTime(1080, t0 + 0.42);
  osc.frequency.linearRampToValueAtTime(680, t0 + 0.84);

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.11, t0 + 0.05);
  gain.gain.setValueAtTime(0.11, t0 + 0.76);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.86);

  osc.connect(gain);
  gain.connect(audio.sfxBus);
  osc.start(t0);
  osc.stop(t0 + 0.9);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

function missionSting(audio) {
  const notes = [261.63, 329.63, 392.0, 523.25];
  notes.forEach((freq, i) => {
    tone(audio, { freq, type: 'triangle', at: i * 0.08, dur: 0.3, peak: 0.11 });
  });
}

function successSting(audio) {
  const notes = [392.0, 523.25, 659.25];
  notes.forEach((freq, i) => {
    tone(audio, { freq, type: 'sine', at: i * 0.04, dur: 0.55, peak: 0.12, attack: 0.01 });
  });
  tone(audio, { freq: 1046.5, type: 'triangle', at: 0.12, dur: 0.4, peak: 0.05 });
}

function click(audio) {
  tone(audio, { freq: 1250, type: 'sine', dur: 0.028, peak: 0.06, attack: 0.002 });
}

function arrestSting(audio) {
  const notes = [329.63, 293.66, 246.94];
  notes.forEach((freq, i) => {
    tone(audio, { freq, type: 'triangle', at: i * 0.11, dur: 0.5, peak: 0.14, attack: 0.01 });
  });
  tone(audio, { freq: [80, 45], type: 'sine', at: 0.3, dur: 0.7, peak: 0.12 });
}

export function startMusic(audio) {
  if (!audio || !audio.enabled || audio.muted || audio.musicPlaying) return;
  const ctx = ensureContext(audio);
  if (!ctx) return;

  audio.musicPlaying = true;
  audio.musicRun += 1;
  audio.bassIndex = 0;
  audio.arpIndex = 0;
  audio.musicStart = ctx.currentTime + 0.12;
  scheduleMusic(audio, audio.musicRun);
}

export function stopMusic(audio) {
  if (!audio) return;
  audio.musicPlaying = false;
  audio.musicRun += 1;
  if (audio.musicTimer !== null) {
    clearTimeout(audio.musicTimer);
    audio.musicTimer = null;
  }
}

function scheduleMusic(audio, run) {
  if (!audio.musicPlaying || run !== audio.musicRun || !audio.ctx || !audio.musicBus) return;

  const ctx = audio.ctx;
  const beat = 60 / TEMPO;
  const bar = beat * 4;
  const start = Math.max(ctx.currentTime + 0.05, audio.musicStart);
  audio.musicStart = start + bar;

  const bassSteps = [0, 7, 12, 7];
  for (let i = 0; i < bassSteps.length; i += 1) {
    const idx = (audio.bassIndex + i) % bassSteps.length;
    const freq = ROOT * Math.pow(2, bassSteps[idx] / 12);
    bassNote(audio, start + i * beat, freq, beat * 0.92);
  }

  const arpSteps = [0, 3, 7, 12, 7, 3];
  const arpRoot = ROOT * 4;
  const perBeat = 2;
  for (let i = 0; i < arpSteps.length / perBeat; i += 1) {
    for (let j = 0; j < perBeat; j += 1) {
      const idx = (audio.arpIndex + i * perBeat + j) % arpSteps.length;
      const at = start + (i + j / perBeat) * beat;
      const freq = arpRoot * Math.pow(2, arpSteps[idx] / 12);
      arpNote(audio, at, freq, beat * 0.55);
    }
  }

  audio.bassIndex = (audio.bassIndex + 1) % bassSteps.length;
  audio.arpIndex = (audio.arpIndex + 2) % arpSteps.length;

  const wait = Math.max(40, (audio.musicStart - ctx.currentTime - 0.12) * 1000);
  audio.musicTimer = setTimeout(() => {
    audio.musicTimer = null;
    scheduleMusic(audio, run);
  }, wait);
}

function bassNote(audio, at, freq, dur) {
  const ctx = audio.ctx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(0.2, at + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
  osc.connect(gain);
  gain.connect(audio.musicBus);
  osc.start(at);
  osc.stop(at + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

function arpNote(audio, at, freq, dur) {
  const ctx = audio.ctx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(0.06, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0004, at + dur);
  osc.connect(gain);
  gain.connect(audio.musicBus);
  osc.start(at);
  osc.stop(at + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

export function updateAudio(audio, world, dt) {
  if (!audio || !audio.ctx || !audio.enabled || audio.muted) {
    if (audio) stopEngine(audio, false);
    return;
  }

  const car = world && world.player ? world.player.car : null;
  const speed = car && Number.isFinite(car.speed) ? Math.abs(car.speed) : 0;

  if (!car || speed < 12) {
    stopEngine(audio, false);
    return;
  }

  const load = Math.min(1, speed / TOP_SPEED);
  if (!audio.engineActive) startEngine(audio, load);

  const ctx = audio.ctx;
  const now = ctx.currentTime;
  const smooth = Math.min(0.25, Math.max(0.01, (Number.isFinite(dt) ? dt : 0.016) * 6));
  const pitch = 54 + load * 168;
  const wobble = 17 + load * 13;
  const level = 0.05 + load * ENGINE_LEVEL * 0.9;

  if (audio.engineOsc) audio.engineOsc.frequency.setTargetAtTime(pitch, now, smooth);
  if (audio.engineSub) audio.engineSub.frequency.setTargetAtTime(pitch * 0.5, now, smooth);
  if (audio.engineLfo) audio.engineLfo.frequency.setTargetAtTime(wobble, now, smooth);
  if (audio.engineBus) audio.engineBus.gain.setTargetAtTime(level, now, smooth);

  audio.engineLevel = level;
  audio.lastSpeed = car ? car.speed : 0;
}

function startEngine(audio, load) {
  const ctx = audio.ctx;
  const now = ctx.currentTime;
  const pitch = 54 + load * 168;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = pitch;

  const sub = ctx.createOscillator();
  sub.type = 'square';
  sub.frequency.value = pitch * 0.5;

  const subFilter = ctx.createBiquadFilter();
  subFilter.type = 'lowpass';
  subFilter.frequency.value = 220;

  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.type = 'sine';
  lfo.frequency.value = 17 + load * 13;
  lfoGain.gain.value = pitch * 0.03;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  const mix = ctx.createGain();
  mix.gain.value = 1;

  const subGain = ctx.createGain();
  subGain.gain.value = 0.35;

  osc.connect(mix);
  sub.connect(subFilter);
  subFilter.connect(subGain);
  subGain.connect(mix);
  mix.connect(audio.engineBus);

  if (audio.engineBus) {
    audio.engineBus.gain.cancelScheduledValues(now);
    audio.engineBus.gain.setValueAtTime(0.0001, now);
    audio.engineBus.gain.setTargetAtTime(0.06 + load * ENGINE_LEVEL, now, 0.05);
  }

  osc.start(now);
  sub.start(now);
  lfo.start(now);

  audio.engineOsc = osc;
  audio.engineSub = sub;
  audio.engineSubFilter = subFilter;
  audio.engineSubGain = subGain;
  audio.engineMix = mix;
  audio.engineLfo = lfo;
  audio.engineLfoGain = lfoGain;
  audio.engineActive = true;
  audio.engineLevel = 0.06 + load * ENGINE_LEVEL;
}

function stopEngine(audio, hard) {
  if (!audio || !audio.engineActive) return;
  const ctx = audio.ctx;
  if (!ctx) {
    audio.engineActive = false;
    return;
  }

  const now = ctx.currentTime;
  const fade = hard ? 0.02 : 0.18;

  if (audio.engineBus) {
    audio.engineBus.gain.cancelScheduledValues(now);
    audio.engineBus.gain.setValueAtTime(Math.max(0.0001, audio.engineBus.gain.value), now);
    audio.engineBus.gain.exponentialRampToValueAtTime(0.0001, now + fade);
  }

  const voices = [audio.engineOsc, audio.engineSub, audio.engineLfo].filter(Boolean);
  for (let i = 0; i < voices.length; i += 1) {
    const voice = voices[i];
    try {
      voice.stop(now + fade + 0.01);
    } catch (err) {}
    voice.onended = () => voice.disconnect();
  }

  const nodes = [audio.engineMix, audio.engineSubFilter, audio.engineSubGain, audio.engineLfoGain];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node) setTimeout(() => node.disconnect(), (fade + 0.1) * 1000);
  }

  audio.engineOsc = null;
  audio.engineSub = null;
  audio.engineSubFilter = null;
  audio.engineSubGain = null;
  audio.engineMix = null;
  audio.engineLfo = null;
  audio.engineLfoGain = null;
  audio.engineActive = false;
  audio.engineLevel = 0;
  audio.lastSpeed = 0;
}