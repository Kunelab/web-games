import { drawRounds, emptyHistory, type DrawHistory, type DrawSettings } from './blindtest-draw.js';
import type { MediaView } from './media-service.js';

/**
 * The first song, found while the host is still choosing.
 *
 * A generated session cannot open without a round to deal — a lobby that cannot
 * produce one is a room full of people watching a spinner — so the create call
 * drew one and refused with a 409 if it came back empty. On a cold catalogue
 * that is exactly what happened: the pools were still filling, the draw found
 * nothing eligible yet, and the host was told their settings were unplayable
 * when the truth was that the server had not finished looking.
 *
 * So the search moves to where the waiting already is. The setup screen polls
 * `/blindtest/count` every few seconds while the host reads the genre list, and
 * that poll now also puts one song aside. By the time anybody presses start it
 * is usually sitting here, and starting is instant.
 *
 * ## Exactly one
 *
 * Not a buffer. One round opens the room and `GameManager.LOOKAHEAD` keeps it
 * one ahead from then on, every draw happening inside a round that is already
 * playing. Drawing more here would spend a chorus lookup and a share of the
 * quota on songs for a game that may never be started at all — and on the
 * commonest path, a host who opens the screen and changes their mind, every one
 * of them is wasted.
 *
 * ## And not drawn again
 *
 * Held across everything except the one change that invalidates it: its own
 * genre being unticked. A host moves the difficulty slider, flips the region,
 * ticks a fourth genre and unticks it again, all while reading — and a draw per
 * adjustment would be a lookup per twitch of a slider. The song that is already
 * in hand is still a song from a genre they asked for, which is the only
 * property the opening round needs.
 */

interface Opener {
  /** Which selected genre this came from, and therefore what invalidates it. */
  genreId: string;
  item: MediaView;
  /** The draw's own bookkeeping, so the session does not deal this track twice. */
  history: DrawHistory;
  heldAt: number;
}

/**
 * One per account, because the thing being held is one account's next game.
 *
 * Keyed by user rather than by settings: a host has one setup screen open and
 * is heading for one session, so a second entry would only ever be a stale
 * first one.
 */
const held = new Map<number, Opener>();

/** Draws in flight, so a poll every four seconds does not start a draw every four seconds. */
const drawing = new Map<number, Promise<void>>();

/**
 * How long an unclaimed opener is kept.
 *
 * Long enough to cover reading the whole genre list and arguing about it; short
 * enough that a host who wandered off does not come back to a song drawn before
 * the pool was rebuilt. Swept on use rather than on a timer: there is one of
 * these per account and they are a few hundred bytes.
 */
const OPENER_TTL_MS = 30 * 60 * 1000;

function fresh(opener: Opener, settings: DrawSettings, now: number): boolean {
  return now - opener.heldAt < OPENER_TTL_MS && settings.genreIds.includes(opener.genreId);
}

/**
 * Puts one song aside for this account, if it does not already hold a good one.
 *
 * Never awaited by the caller that triggers it: this runs off the counting
 * endpoint, which a browser is waiting on, and the whole point is that the
 * search happens in the background while somebody reads a list.
 */
export function warmOpener(userId: number, settings: DrawSettings): void {
  const now = Date.now();

  const existing = held.get(userId);
  if (existing) {
    if (fresh(existing, settings, now)) return;
    // Its genre is gone, or it is stale. Dropped rather than kept as a fallback:
    // a song from a genre the host has just unticked is the one song they have
    // actively said they do not want.
    held.delete(userId);
  }

  if (drawing.has(userId)) return;

  const history = emptyHistory();
  const promise = drawRounds(settings, history, 1)
    .then(([item]) => {
      if (!item) return;
      // The settings may have moved on while the draw was out; the same test
      // decides whether it was worth keeping.
      const opener: Opener = { genreId: String(item.category ?? ''), item, history, heldAt: Date.now() };
      if (fresh(opener, settings, Date.now())) held.set(userId, opener);
    })
    .catch(() => undefined)
    .finally(() => {
      drawing.delete(userId);
    });

  drawing.set(userId, promise);
}

/**
 * Takes the song being held, if it still fits what is being started.
 *
 * Removed on the way out: an opener is one round for one session, and leaving
 * it behind would deal the same track to the next game this account opens.
 */
export function takeOpener(userId: number, settings: DrawSettings): { item: MediaView; history: DrawHistory } | null {
  const opener = held.get(userId);
  if (!opener) return null;

  held.delete(userId);
  if (!fresh(opener, settings, Date.now())) return null;

  return { item: opener.item, history: opener.history };
}

/** Test seam, and the way a signed-out account stops holding anything. */
export function forgetOpener(userId: number): void {
  held.delete(userId);
}
