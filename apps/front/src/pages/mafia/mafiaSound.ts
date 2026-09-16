import { useEffect, useRef } from 'react';

import type { MafiaView } from 'mafia-core';

import { mafiaSfx } from '../../app/assets';

/**
 * The table's soundscape: eight recordings and one rule about when to play them.
 *
 * CoronaZ synthesises its audio, which is the right answer for a game that
 * needs a different crack per calibre and a squelch per kill. Mafia wants the
 * opposite: a handful of moments, each of which happens once and matters — dawn,
 * nightfall, a trial opening, a rope, a body found, the end. Those are recorded,
 * not oscillated, and there are few enough of them to name individually.
 *
 * What this file is really about is *when*, because every one of these events is
 * a state transition observed by several screens at once and it is very easy to
 * make a television bark eight times while it catches up:
 *
 *  - **Only a change plays.** Every cue is keyed on a value that moves once —
 *    the phase, the day, the number of corpses — and compared against what was
 *    last seen. A re-render, a reconnection or a second view of the same state
 *    is silent.
 *  - **The first state is silent.** Opening a table mid-game would otherwise
 *    play nightfall at you because the phase "changed" from nothing to night.
 *  - **One cue at a time.** A death and a phase change land in the same tick at
 *    dawn; they queue rather than stack, because two recordings at once is
 *    noise rather than two events.
 *
 * Muting is per device and shared with nothing: `localStorage`, one key, read on
 * every play so a mute takes effect on the next sound rather than the next
 * reload.
 */

const MUTE_KEY = 'kune.mafia.muted';

/** Every cue this game has. The file is `public/games/mafia/sfx/<name>.flac`. */
export type MafiaCue =
  | 'phase-day'
  | 'phase-night'
  | 'trial-start'
  | 'execution'
  | 'death-reveal'
  | 'victory'
  | 'defeat'
  | 'vote-cast';

/** How loud each one is, relative to itself. A rope should not be a dawn. */
const LEVEL: Record<MafiaCue, number> = {
  'phase-day': 0.5,
  'phase-night': 0.5,
  'trial-start': 0.55,
  execution: 0.6,
  'death-reveal': 0.6,
  victory: 0.65,
  defeat: 0.65,
  'vote-cast': 0.35
};

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    // A browser with storage switched off is not a browser that wants an error
    // thrown at it from a sound effect.
    return false;
  }
}

export function toggleMute(): boolean {
  const next = !isMuted();
  try {
    localStorage.setItem(MUTE_KEY, next ? '1' : '0');
  } catch {
    /* nothing to do about it, and nothing worth breaking over */
  }
  return next;
}

/**
 * One element per cue, kept and rewound rather than created per play.
 *
 * A fresh `Audio` per event means a fresh network request on browsers that have
 * not cached the file yet, which is how a sound arrives after the thing it was
 * about. These load on first use and stay.
 */
const players = new Map<MafiaCue, HTMLAudioElement>();

/** What is playing now, so two cues in one tick do not talk over each other. */
let busyUntil = 0;

export function play(cue: MafiaCue): void {
  if (isMuted()) return;
  // Two recordings at once is noise, not two events. The second is dropped
  // rather than queued: by the time the first finishes it is no longer news.
  if (Date.now() < busyUntil) return;

  try {
    let element = players.get(cue);
    if (!element) {
      element = new Audio(mafiaSfx(cue));
      element.preload = 'auto';
      players.set(cue, element);
    }
    element.volume = LEVEL[cue];
    element.currentTime = 0;
    busyUntil = Date.now() + 700;
    // A browser that has not been interacted with refuses to play, which is
    // correct behaviour and not an error worth surfacing.
    void element.play().catch(() => undefined);
  } catch {
    /* an unplayable sound is a cosmetic downgrade, never a broken screen */
  }
}

/**
 * The table, watched for the handful of moments worth hearing.
 *
 * One hook, called by both the phone and the television, so the two agree about
 * what makes a noise without either of them knowing which recordings exist.
 * Everything it watches is in the public view, so a spectator hears the same
 * table as a player.
 */
export function useMafiaSound(view: MafiaView | null): void {
  const seen = useRef<{ phase: string; day: number; trial: number | null; dead: number; over: boolean } | null>(null);

  useEffect(() => {
    if (!view) return;

    const dead = view.players.filter((player) => !player.alive).length;
    const now = {
      phase: view.phase,
      day: view.day,
      trial: view.trial?.slot ?? null,
      dead,
      over: view.phase === 'ended'
    };

    const before = seen.current;
    seen.current = now;
    // The first state a screen sees is not a transition: joining a table at
    // midnight must not announce nightfall.
    if (!before) return;

    if (now.over && !before.over) {
      /**
       * Whether the evening went your way, from your own row of the standings.
       *
       * A spectator and a corpse both get the defeat cue, which is the honest
       * answer: nobody reading a scoreboard they are not on has won anything.
       */
      const mine = view.results?.find((row) => row.slot === view.me?.slot);
      play(mine?.winner ? 'victory' : 'defeat');
      return;
    }

    // A body is the loudest thing that can happen, so it is asked first.
    if (now.dead > before.dead) {
      play(before.phase === 'day' && view.stage !== 'discussion' ? 'execution' : 'death-reveal');
      return;
    }

    if (now.trial !== null && now.trial !== before.trial) {
      play('trial-start');
      return;
    }

    if (now.phase !== before.phase) {
      if (now.phase === 'night') play('phase-night');
      else if (now.phase === 'day') play('phase-day');
    }
  }, [view]);
}
