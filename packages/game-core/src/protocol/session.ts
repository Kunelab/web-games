import { z } from 'zod';

import type { RedactedAnswerField } from '../media/answer-field.js';
import { scoringConfigSchema } from '../scoring/score.js';

/**
 * Phases a round moves through.
 *
 * The server owns this, and every transition carries an absolute server-time
 * boundary so clients render countdowns and reveals from their synchronised clock
 * instead of being told what to draw.
 */
export type RoundPhase =
  /** Media loading, players told what is coming. */
  | 'loading'
  /** Memory panel visible, answers not yet open. */
  | 'study'
  /** Answers accepted. */
  | 'answering'
  /** Answers closed, correct values and per-round scores shown. */
  | 'reveal';

export type SessionPhase =
  /** Players joining, host has not started. */
  | 'lobby'
  | 'playing'
  /** Final standings. */
  | 'finished';

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  rank: number;
  /**
   * Badge key of the title this nickname has earned across past games, when it has
   * one. Pure cosmetics: the client maps the key to its French label.
   */
  title?: string;
}

/** What a player receives for the current round. */
export interface RoundView {
  roundId: string;
  index: number;
  total: number;
  kind: string;
  phase: RoundPhase;
  /** Server time this phase began. */
  phaseStartAt: number;
  /** Server time this phase ends, or null when it waits on the host. */
  phaseEndsAt: number | null;
  /**
   * The host has stopped the clock on this round.
   *
   * Sent as well as the null deadline because the two mean different things to
   * a screen. A round with no deadline is ordinary — an oral game has none, and
   * neither does a reveal waiting on the host — and drawing "paused" over every
   * one of those would be wrong. This says the clock was taken off the room
   * deliberately, which is worth a phone saying out loud: a player whose answer
   * box has gone quiet deserves to know it is not their connection.
   */
  held: boolean;
  /**
   * How long the answer phase is meant to last, in ms.
   *
   * Sent as well as the deadline because a progressive presentation needs a duration
   * even when there is no deadline: an oral round is host-driven, so `phaseEndsAt` is
   * null, and a reveal that derives its duration from that shows a fully unblurred
   * picture on the first frame, which is the whole game given away.
   */
  answerMs: number;
  /** Kind-specific, produced by the kind's playerPresentation. Never has answers. */
  presentation: unknown;
  fields: RedactedAnswerField[];
  /** Field keys this player has already answered correctly. */
  solvedFieldKeys: string[];
  /** Field keys this player has used up their attempts on. */
  lockedFieldKeys: string[];
  /** The race for the right to answer. Absent unless the round is a buzzer round. */
  buzz?: BuzzView;
}

/**
 * The buzzer, as one recipient sees it.
 *
 * Two of these fields are about the room and one is about you, which is why it is
 * one object rather than two: a phone has to answer "may I press this" in a single
 * glance, and that is a question about both.
 */
export interface BuzzView {
  /** Who holds the exclusive shot, or null while the buzzer is open. */
  holderId: string | null;
  holderName: string | null;
  /** Server time the holder's window closes. Null when nobody holds it. */
  windowEndsAt: number | null;
  /**
   * A race is being arbitrated: presses are in, the winner is not yet decided.
   *
   * Drawn as "buzzed" rather than as "open", because the buzzer is in fact already
   * gone. Showing it open for the couple of hundred milliseconds arbitration takes
   * would invite a press that cannot win, which is the one thing a race must never
   * do.
   */
  racing: boolean;
  /** This recipient has spent their shot and is out for the round. */
  spent: boolean;
}

/** Correct answers plus scores, sent only once answering has closed. */
export interface RevealView {
  roundId: string;
  answers: { key: string; label: string; value: string }[];
  explanation?: string;
  /**
   * Everyone's number on an estimation round, closest first.
   *
   * Only that kind fills this: guesses are the spectacle of the reveal there, where
   * on every other kind who-typed-what stays private. `delta` is signed, so the
   * screen can say "trop haut" or "trop bas".
   */
  guesses?: { playerId: string; name: string; value: number; delta: number }[];
  /**
   * How hard the round was held to be, 0 to 100, when the item says.
   *
   * Absent on anything nobody has judged, which is every hand-authored item and
   * every generated one saved before the number was kept. The screens print it
   * small beside the answer: it is the footnote to a round the room has just
   * either walked or been beaten by, not part of the reveal itself.
   */
  difficulty?: number;
  /**
   * The recording this round is filed under in the shared library, if it is.
   *
   * Present only for a generated round that was kept, and only while it is still
   * there. The host screen turns it into the one thing that can be done about a
   * wrong answer at the moment somebody notices: the reveal is read out, the room
   * says that is not the song, and the entry goes. Absent means there is nothing
   * to throw away - the round came from somebody's own library, or it has already
   * been purged - and the screen shows no button at all.
   */
  libraryCode?: string;
  roundScores: {
    playerId: string;
    name: string;
    points: number;
    /** Present only when it was not 1, so the screen can explain the number. */
    comboMultiplier?: number;
    comebackMultiplier?: number;
    /** Rounds won in a row including this one, for showing a running streak. */
    comboLength: number;
    fieldKeys: string[];
  }[];
}

/**
 * The round as the host sees it: unredacted.
 *
 * The host screen has to play the clip and show the answers, so it genuinely needs
 * the payload. It is a separate field rather than a looser `RoundView` so that the
 * redacted and unredacted shapes can never be confused at a call site — a player
 * payload has no `hostRound`, and that is a type error rather than a leak.
 */
export interface HostRoundView {
  roundId: string;
  index: number;
  total: number;
  kind: string;
  title: string;
  phase: RoundPhase;
  /** The host has stopped the clock. See `RoundView.held`. */
  held: boolean;
  /**
   * The recording this round is filed under in the shared catalogue, if it is.
   *
   * The same value the reveal carries, on the host's own round so the controls
   * can offer a correction at any point in the round rather than only once the
   * answers are up. Present for a round generated in this session and for one
   * replayed out of the catalogue, since both are everybody's; absent for a
   * round that came from somebody's own library, which is theirs to edit in the
   * editor and not from here.
   */
  libraryCode?: string;
  phaseStartAt: number;
  phaseEndsAt: number | null;
  answerMs: number;
  payload: unknown;
  /**
   * `aliases` travels so the correction form can show what is already accepted.
   *
   * Without it the form could only ever add to a list it could not see, and
   * saving would have to mean "keep whatever is there" — which leaves no way to
   * remove a wrong spelling that is handing out points.
   */
  answers: { key: string; label: string; value: string; aliases: string[]; points: number }[];
}

/**
 * A distinction handed out with the final standings.
 *
 * The key names the achievement and the client owns the French label for it, so
 * adding an award is a server change plus one dictionary entry. `value` is already
 * formatted for display because only the server has the numbers it comes from.
 */
export interface FinalAward {
  key: string;
  playerId: string;
  playerName: string;
  value: string;
}

/**
 * How close a career is to one badge it has not earned yet.
 *
 * A count that climbs to a target, never a percentage, because "72 of 100" is an
 * argument for one more game in a way "72%" is not. `unit` is a catalogue key
 * rather than a word: the server owns the number and the client owns the noun,
 * which is the same rule every other string on this wire follows.
 */
export interface BadgeProgressView {
  key: string;
  current: number;
  target: number;
  /** Catalogue key for the noun, e.g. `badge.unit.games`. */
  unit: string;
  /** This game moved the count, so the bar can say so. */
  moved: boolean;
}

/**
 * What one game bought one player: the end-of-game payoff.
 *
 * Ported from CoronaZ, where it was the answer to "after three evenings there is
 * nothing left to chase". The quiz had the same hole and worse: tokens were
 * credited at the final whistle and shown nowhere until somebody happened to open
 * the shop, and the badge thresholds existed only as a title that silently
 * appeared next to a nickname one day. A progression nobody watches advancing is
 * a progression nobody believes in.
 */
export interface GameReward {
  playerId: string;
  name: string;
  /** What this game paid, and the balance afterwards. */
  gained: number;
  /**
   * The lifetime balance after banking, or null for a seat with no ledger.
   *
   * Nullable because Mafia seats bots, and a bot scores without banking: its row
   * exists so the humans can compare, not because anything was credited. The quiz
   * never sends null, and does not have to care that it could.
   */
  total: number | null;
  /** Badges that fell tonight. */
  newBadges: string[];
  /** The title they now wear, when tonight is what changed it. */
  newTitle: string | null;
  /** The nearest unearned badges, closest first: the reason to play another. */
  nextBadges: BadgeProgressView[];
}

/**
 * The stage, on a device that is not the host screen.
 *
 * Sent to whoever is a stage tonight: every player when the room has no
 * television, or the single phone the host appointed as one. It is the host
 * round with the answers taken out — the clip to play, and not one word of what
 * it is.
 *
 * Only kinds the host screen normally presents alone need this. Everything else
 * already reaches a player through its redacted `presentation`, whose image
 * URLs are opaque per-round tokens; handing those kinds the raw payload instead
 * would post the answer in the filename.
 *
 * For the one kind that does need it, the trade is stated rather than hidden: a
 * blindtest payload carries a YouTube id, and a player determined enough to open
 * it in another tab inside a twenty-second round can read the title off it. That
 * is the price of hearing the clip at all on a device that is not a television,
 * and the title, the category and every answer field still never leave the
 * server.
 */
export interface StageRoundView {
  roundId: string;
  index: number;
  total: number;
  kind: string;
  phase: RoundPhase;
  phaseStartAt: number;
  phaseEndsAt: number | null;
  answerMs: number;
  payload: unknown;
}

export interface SessionView {
  code: string;
  phase: SessionPhase;
  /**
   * What the host called this room, or '' when they called it nothing.
   *
   * Public by construction: it is the line the board already shows to strangers,
   * so there is nothing here a joined player could not have read before joining.
   * Its neighbour in the config, the password, is never projected anywhere.
   */
  name: string;
  /**
   * True when the game generates its own rounds and has no fixed length.
   *
   * The screens need it because `total` is meaningless here: the order grows by
   * one every time the buffer tops up, so "manche 3 / 7" becomes "4 / 8" and
   * reads as a game that is getting longer as you play it, which is true and is
   * not what a progress counter is for.
   */
  infinite?: boolean;
  /**
   * True when the game is being played out loud with no phones.
   *
   * The one piece of the session config the screens genuinely need: a television
   * showing a join code, a countdown and a score strip is showing three things that
   * do not exist in this mode. Sending the whole config to every client for one flag
   * would be worse.
   */
  oral: boolean;
  /**
   * True when the media plays on one designated screen and nowhere else.
   *
   * The screens need it for the same reason they need `oral`: it decides whether
   * this device is a stage or only a buzzer. The server still owns the
   * consequence — `stageRound` is built or withheld per recipient — so a client
   * that ignored this flag would draw a blank frame, never a leak.
   */
  tvOnly: boolean;
  /**
   * Which device that screen is: a player's id, or null for the host screen.
   *
   * Meaningless unless `tvOnly`. The host picks it in the lobby, because the
   * question only has an answer once the devices are in the room and have said
   * their names — which is what a lobby is for.
   */
  tvPlayerId: string | null;
  players: PlayerView[];
  round: RoundView | null;
  reveal: RevealView | null;
  isHost: boolean;
  /**
   * The word at the door, for the one screen entitled to read it back.
   *
   * Present only when `isHost`, and absent entirely when the room has no door.
   * The host screen is a television showing a join code to the room it belongs
   * to, and a password that cannot be shown there is a password the host has to
   * remember across a refresh — which is how a room ends up locked against its
   * own players. Everybody else's view never carries it.
   */
  password?: string;
  /** Present only when `isHost`. */
  hostRound?: HostRoundView | null;
  /**
   * Present only for a device that is a stage: every player when there is no
   * television, or the one phone the host appointed as it.
   */
  stageRound?: StageRoundView | null;
  /** Items excluded from this session because they were incomplete. */
  skipped?: { title: string; missing: string[] }[];
  /** Present once the session is finished: the ceremony, and what it paid. */
  final?: { awards: FinalAward[]; rewards: GameReward[] };
}

export const sessionConfigSchema = z.object({
  /** Play the playlist in a random order. */
  shuffle: z.boolean().default(false),
  /** Order media by their date rather than playlist position. */
  chronological: z.boolean().default(false),

  /**
   * No phones: the television is the only screen and answers are spoken aloud.
   *
   * Nothing is submitted, so nothing is scored, and the parts of the game that
   * exist to arbitrate between players stop applying: there is no answer deadline,
   * because the deadline exists to stop people typing, and a room talking to each
   * other does not need one. The host drives the pace from the television.
   *
   * It is also the way to try a playlist out alone, which is why it must be
   * startable with nobody in the room at all.
   */
  oral: z.boolean().default(false),
  /** How many wrong tries a player gets per field before it locks. */
  attemptsPerField: z.number().int().min(1).max(10).default(3),

  /**
   * The race format: one buzzer, and only whoever wins it may answer.
   *
   * The alternative to the position ladder rather than a layer on top of it. By
   * default the room answers simultaneously and being first is worth a bigger
   * multiplier, which is a fine way to score a quiz and a poor way to *play* one:
   * nobody in the room can tell they are racing, because everybody is typing at
   * once and the race is settled afterwards by arithmetic nobody sees.
   *
   * With this on, the race is the thing that happens. One player takes the buzzer,
   * everyone else is locked out while they answer, and getting it wrong costs them
   * the round rather than a fraction of a point. Scoring flattens to face value to
   * match: see `buzzerScoringConfig`.
   *
   * Off by default. It is a different game, not a better one, and it wants a room
   * that has agreed to play it.
   */
  buzzer: z.boolean().default(false),

  /**
   * How long the winner of the buzzer has to answer, in ms.
   *
   * Short on purpose. The window is the whole risk of the format: pressing before
   * you know the answer has to be a real gamble, and it stops being one if you can
   * buzz and then spend twenty seconds working it out. Eight seconds is enough to
   * type a name you already have and not enough to find one you do not.
   */
  buzzerWindowMs: z.number().int().min(3_000).max(30_000).default(8_000),
  /** Advance automatically when the reveal timer ends, rather than waiting. */
  autoAdvance: z.boolean().default(true),
  scoring: scoringConfigSchema.default(scoringConfigSchema.parse({})),

  /**
   * Lists the game on the public board, where anyone can find its code.
   *
   * Private by default. Everything about the join flow already worked by passing
   * a code around a room, and a game that starts accepting strangers because a
   * default flipped is not a feature anybody asked for.
   */
  public: z.boolean().default(false),

  /**
   * What this room is called, when its host bothered to name it.
   *
   * Empty means unnamed, and unnamed is still the common case: a room whose code
   * is read aloud across a kitchen table needs no name at all. It earns one the
   * moment the room is on the board, where "Blind test infini" repeated eleven
   * times is a list nobody can choose from — so this is what the card shows when
   * it is set, and the playlist's own name when it is not.
   */
  name: z.string().trim().max(40).default(''),

  /**
   * A word at the door. Empty means there is no door.
   *
   * The companion of `public`, and the reason that switch is now safe to use for
   * more than a room of friends: listing a game is how people find it, and a
   * password is how the ones you meant get in and nobody else does. A private
   * room may carry one too — a code circulated in a group chat is a code that
   * has left the room.
   *
   * Compared in the clear, and deliberately. This is not an account: it protects
   * an evening that lasts two hours, it is typed once on a phone and read off a
   * television, and the host wants to be able to see what they set. Hashing it
   * would buy nothing against anyone who can already read the server's memory,
   * and cost the one thing the feature is for. It is never projected into any
   * view — see `toSessionView`.
   */
  password: z.string().trim().max(40).default(''),

  /**
   * There is a television, and it is the only screen showing the media.
   *
   * Opt *in*, and that inversion is the whole point. It used to be implicit —
   * a launched game always assumed a big screen somebody was sitting at, and
   * the media went there and nowhere else. Every phone in the room got a
   * question with no picture and no sound, and there was no setting to say
   * otherwise, because the "no television" case only existed inside quick
   * match, unnamed, as a side effect of having no host.
   *
   * That is backwards. Most rooms are people on a sofa with phones; a shared
   * screen is the special case and the one worth asking about. So off by
   * default: without a television, every device is its own stage and everybody
   * gets the clip and its sound — while guessing and at the reveal.
   *
   * Which device the television *is* is not settled here. It is picked in the
   * lobby and lives on the session as `tvPlayerId`, not in the config, because
   * it is a fact about tonight's room rather than about the game's rules.
   *
   * The host screen still exists either way. This is about where the *media*
   * plays, not about who presses "next".
   */
  tv: z.boolean().default(false),

  /**
   * Nobody is driving.
   *
   * A quick match has no host: no one chose the playlist, and no one is sitting at
   * a television pressing "suivant". The server owns every transition instead —
   * which it already did, the host merely had a veto — and each player's phone
   * becomes its own stage, via `stageRound`. Implies `autoAdvance`, because there
   * is no hand left to advance it.
   */
  autonomous: z.boolean().default(false)
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;

export const defaultSessionConfig: SessionConfig = sessionConfigSchema.parse({});

/**
 * Join codes are typed by hand from a phone, so the alphabet excludes the
 * characters people misread: no 0/O, no 1/I/L.
 */
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 5;

export function isJoinCode(value: string): boolean {
  if (value.length !== JOIN_CODE_LENGTH) return false;
  return [...value].every((character) => JOIN_CODE_ALPHABET.includes(character));
}

/** Requires a source of randomness so the caller controls it. */
export function generateJoinCode(randomInt: (maxExclusive: number) => number): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

export const joinCodeSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(isJoinCode, { message: 'Code de partie invalide' });
