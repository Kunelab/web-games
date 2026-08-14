/**
 * CoronaZ's soundscape, synthesised: no audio files, one WebAudio graph.
 *
 * Every effect is a couple of oscillators or a filtered noise burst, tuned to be
 * satisfying rather than realistic — the click of a loot crate, a crack per
 * calibre, a squelch for a kill. Procedural means every weapon gets its own
 * voice for the cost of a parameter row, and the whole system respects one mute
 * flag persisted per device.
 */

const MUTE_KEY = 'kune.cz.muted';

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (isMuted()) return null;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

export function isMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function toggleMute(): boolean {
  const next = !isMuted();
  localStorage.setItem(MUTE_KEY, next ? '1' : '0');
  return next;
}

/** One oscillator note with an exponential fade. */
function tone(
  frequency: number,
  duration: number,
  options: { type?: OscillatorType; gain?: number; slideTo?: number; delay?: number } = {}
): void {
  const ctx = audio();
  if (!ctx) return;
  const at = ctx.currentTime + (options.delay ?? 0);

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = options.type ?? 'sine';
  oscillator.frequency.setValueAtTime(frequency, at);
  if (options.slideTo) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, options.slideTo), at + duration);
  }
  gain.gain.setValueAtTime(options.gain ?? 0.08, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}

/** A filtered noise burst: the base of every gunshot. */
function noiseBurst(
  duration: number,
  options: { frequency?: number; type?: BiquadFilterType; gain?: number; delay?: number } = {}
): void {
  const ctx = audio();
  if (!ctx) return;
  const at = ctx.currentTime + (options.delay ?? 0);

  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = options.type ?? 'lowpass';
  filter.frequency.value = options.frequency ?? 800;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(options.gain ?? 0.15, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(at);
}

/* ------------------------------ the effects ------------------------------- */

export function sfxStep(): void {
  noiseBurst(0.05, { frequency: 300, gain: 0.05 });
}

export function sfxLoot(): void {
  tone(520, 0.09, { type: 'triangle', gain: 0.06 });
  tone(780, 0.12, { type: 'triangle', gain: 0.06, delay: 0.07 });
}

export function sfxHeal(): void {
  tone(390, 0.12, { type: 'sine', gain: 0.06 });
  tone(520, 0.16, { type: 'sine', gain: 0.06, delay: 0.09 });
}

export function sfxKill(): void {
  tone(180, 0.22, { type: 'square', gain: 0.05, slideTo: 45 });
  noiseBurst(0.14, { frequency: 500, gain: 0.1, delay: 0.02 });
}

export function sfxHurt(): void {
  tone(140, 0.18, { type: 'sawtooth', gain: 0.07, slideTo: 70 });
}

export function sfxObjective(): void {
  for (const [index, frequency] of [523, 659, 784].entries()) {
    tone(frequency, 0.16, { type: 'triangle', gain: 0.07, delay: index * 0.09 });
  }
}

export function sfxEscape(): void {
  for (const [index, frequency] of [523, 659, 784, 1046].entries()) {
    tone(frequency, 0.22, { type: 'triangle', gain: 0.08, delay: index * 0.12 });
  }
}

export function sfxDefeat(): void {
  for (const [index, frequency] of [392, 311, 233].entries()) {
    tone(frequency, 0.3, { type: 'sawtooth', gain: 0.06, delay: index * 0.16 });
  }
}

export function sfxHordePhase(): void {
  tone(90, 0.5, { type: 'sawtooth', gain: 0.05, slideTo: 55 });
}

/**
 * One voice per weapon: burst count, brightness and body per calibre. Melee
 * thuds, small arms crack, the minigun stutters, the flamethrower breathes.
 */
const WEAPON_VOICES: Record<string, { bursts: number; frequency: number; duration: number; thud?: number }> = {
  __fists: { bursts: 1, frequency: 250, duration: 0.06, thud: 90 },
  bat: { bursts: 1, frequency: 250, duration: 0.08, thud: 80 },
  machete: { bursts: 1, frequency: 2400, duration: 0.07, thud: 120 },
  pickaxe: { bursts: 1, frequency: 700, duration: 0.09, thud: 70 },
  chainsaw: { bursts: 4, frequency: 220, duration: 0.34, thud: 65 },
  pistol: { bursts: 1, frequency: 1800, duration: 0.1 },
  shotgun: { bursts: 1, frequency: 420, duration: 0.24 },
  p90: { bursts: 4, frequency: 2000, duration: 0.06 },
  ak47: { bursts: 3, frequency: 1200, duration: 0.09 },
  deagle: { bursts: 1, frequency: 900, duration: 0.2 },
  sniper: { bursts: 1, frequency: 600, duration: 0.3 },
  flamethrower: { bursts: 1, frequency: 260, duration: 0.55 },
  minigun: { bursts: 6, frequency: 1500, duration: 0.05 }
};

export function sfxShoot(weaponDef: string): void {
  const voice = WEAPON_VOICES[weaponDef] ?? WEAPON_VOICES.pistol;
  if (!voice) return;
  for (let burst = 0; burst < voice.bursts; burst++) {
    noiseBurst(voice.duration, {
      frequency: voice.frequency,
      type: voice.frequency > 1000 ? 'highpass' : 'lowpass',
      gain: 0.14,
      delay: burst * (voice.duration * 0.8)
    });
    if (voice.thud) {
      tone(voice.thud, voice.duration + 0.05, { type: 'sine', gain: 0.09, delay: burst * voice.duration * 0.8 });
    }
  }
}
