/**
 * The quick-match room.
 *
 * Every game in the house has a lobby, and every one of them asks the same three
 * questions: who is here, what are we playing, and have enough of us said yes. The
 * answers used to be a host's — one person picked the playlist, the map and the
 * moment. A room with nobody in charge has to decide those itself, so they are the
 * three things this file models and nothing else: the engines below still own the
 * game, and the transport above still owns the sockets.
 *
 * Pure by construction. Nothing here reads a clock it was not handed or reaches for
 * randomness it was not given, which is what makes the vote arithmetic testable
 * without standing up a server.
 */

export const LOBBY_GAMES = ['quiz', 'coronaz', 'mafia'] as const;
export type LobbyGame = (typeof LOBBY_GAMES)[number];

export function isLobbyGame(value: string): value is LobbyGame {
  return (LOBBY_GAMES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ options */

export interface QuickOptionChoice {
  value: string;
  label: string;
}

/**
 * One dial the room may turn, and how it is set when nobody turns it.
 *
 * `roll: true` means the lobby draws a value at random on creation — the point of
 * a quick match is that the map and the quiz are a surprise, not that they are
 * always the same first entry. `roll: false` pins the declared default, which is
 * what the settings nobody wants randomised (a clock length, say) need.
 */
export interface QuickOptionSpec {
  key: string;
  label: string;
  hint?: string;
  choices: QuickOptionChoice[];
  roll: boolean;
  /** Used when `roll` is false, and as the tie-break when a vote is split. */
  fallback: string;
}

/* ------------------------------------------------------------------- people */

export interface QuickMember {
  id: string;
  name: string;
  joinedAt: number;
  connected: boolean;
  lastSeenAt: number;
  /** Voted to start now. */
  ready: boolean;
  /** Option key → the value this member is pushing for. */
  votes: Record<string, string>;
}

export type QuickPhase = 'gathering' | 'countdown' | 'launched' | 'closed';

/**
 * Whether this game can seat machine players.
 *
 * Not the quiz: its bots would have to answer the questions, and a bot that knows
 * every answer is not an opponent, it is a scoreboard. The other two already run
 * bots in their own lobbies, which is what this exposes to the shared room.
 */
export function quickBotsAllowed(game: LobbyGame): boolean {
  return game === 'coronaz' || game === 'mafia';
}

/** Members plus bots: what the game will actually be dealt. */
export function quickSeats(lobby: QuickLobby): number {
  return Object.keys(lobby.members).length + lobby.bots;
}

/** The most bots this room could still ask for, people having priority. */
export function quickMaxBots(lobby: QuickLobby): number {
  if (!quickBotsAllowed(lobby.game)) return 0;
  return Math.max(0, lobby.maxPlayers - Object.keys(lobby.members).length);
}

export interface QuickLobby {
  code: string;
  game: LobbyGame;
  createdAt: number;
  phase: QuickPhase;
  minPlayers: number;
  maxPlayers: number;
  /** Drawn once at creation: what a tied or empty vote falls back to. */
  rolled: Record<string, string>;
  members: Record<string, QuickMember>;
  /**
   * Machine players the room has asked for, seated when the game is created.
   *
   * A count rather than a roster: they have no vote, no presence and no name
   * until the engine deals them one, so there is nothing else to keep. Quiz is
   * always 0 — see `quickBotsAllowed`.
   */
  bots: number;
  /** Set when the room has decided; the launch happens when the clock reaches it. */
  startsAt: number | null;
  /** The real game, once it exists. */
  launch: { code: string } | null;
  /**
   * The finished game this room was spawned from by a replay vote.
   *
   * Kept so the screen can say "waiting for the others" rather than "waiting",
   * which is the difference between a room that is filling up and one that looks
   * broken.
   */
  fromGameCode: string | null;
  lastActivityAt: number;
}

/**
 * How long the room gets between deciding and starting.
 *
 * Long enough that the last person to vote sees the count flip and understands
 * why the screen changed, short enough that nobody wanders off. It also gives a
 * member who changes their mind a window to take the vote back, which is the
 * reason it is a countdown rather than an immediate launch.
 */
export const QUICK_COUNTDOWN_MS = 5000;

/** A member silent for this long is treated as gone for the vote arithmetic. */
export const QUICK_STALE_MS = 20_000;

export interface CreateQuickLobbyOptions {
  code: string;
  game: LobbyGame;
  specs: QuickOptionSpec[];
  minPlayers: number;
  maxPlayers: number;
  /** Returns an integer in [0, maxExclusive). Supplied so the caller owns randomness. */
  randomInt: (maxExclusive: number) => number;
  now: number;
  fromGameCode?: string | null;
}

export function createQuickLobby(options: CreateQuickLobbyOptions): QuickLobby {
  const rolled: Record<string, string> = {};

  for (const spec of options.specs) {
    if (spec.choices.length === 0) {
      rolled[spec.key] = spec.fallback;
      continue;
    }
    const drawn = spec.roll ? spec.choices[options.randomInt(spec.choices.length)] : undefined;
    rolled[spec.key] = drawn?.value ?? spec.fallback;
  }

  return {
    code: options.code,
    game: options.game,
    createdAt: options.now,
    phase: 'gathering',
    minPlayers: options.minPlayers,
    maxPlayers: options.maxPlayers,
    rolled,
    members: {},
    bots: 0,
    startsAt: null,
    launch: null,
    fromGameCode: options.fromGameCode ?? null,
    lastActivityAt: options.now
  };
}

export type QuickJoinResult = { ok: true; member: QuickMember } | { ok: false; error: 'full' | 'closed' | 'started' };

export function joinQuickLobby(lobby: QuickLobby, input: { id: string; name: string; now: number }): QuickJoinResult {
  if (lobby.phase === 'closed') return { ok: false, error: 'closed' };
  if (lobby.phase === 'launched') return { ok: false, error: 'started' };

  const existing = lobby.members[input.id];
  if (existing) {
    existing.connected = true;
    existing.lastSeenAt = input.now;
    lobby.lastActivityAt = input.now;
    return { ok: true, member: existing };
  }

  if (Object.keys(lobby.members).length >= lobby.maxPlayers) {
    return { ok: false, error: 'full' };
  }

  const member: QuickMember = {
    id: input.id,
    name: input.name,
    joinedAt: input.now,
    connected: true,
    lastSeenAt: input.now,
    ready: false,
    votes: {}
  };

  lobby.members[input.id] = member;
  // A person always outranks a machine: the room gives back a bot's seat rather
  // than turning somebody away from a table it filled itself.
  lobby.bots = Math.min(lobby.bots, quickMaxBots(lobby));
  lobby.lastActivityAt = input.now;
  return { ok: true, member };
}

/**
 * A member is dropped rather than marked away.
 *
 * A quick lobby is not a table with assigned seats: nothing about it survives the
 * player leaving, and keeping a ghost in the roster would raise the majority
 * everyone else has to clear. Reconnection re-joins, which is the same three
 * fields.
 */
export function dropQuickMember(lobby: QuickLobby, memberId: string, now: number): void {
  if (!(memberId in lobby.members)) return;
  delete lobby.members[memberId];
  lobby.lastActivityAt = now;
}

export function markQuickSeen(lobby: QuickLobby, memberId: string, now: number): void {
  const member = lobby.members[memberId];
  if (!member) return;
  member.connected = true;
  member.lastSeenAt = now;
  lobby.lastActivityAt = now;
}

export function setQuickReady(lobby: QuickLobby, memberId: string, ready: boolean, now: number): void {
  const member = lobby.members[memberId];
  if (!member || lobby.phase === 'launched' || lobby.phase === 'closed') return;
  member.ready = ready;
  member.lastSeenAt = now;
  lobby.lastActivityAt = now;
}

/**
 * How many machine players the room wants.
 *
 * Anyone may set it, like every other setting here — a hostless room has nobody
 * to own the decision, and a bot count is far less contentious than the map.
 * Clamped rather than refused, so a stale screen asking for eight seats in a room
 * that has room for three gets three instead of nothing.
 */
export function setQuickBots(lobby: QuickLobby, count: number, now: number): boolean {
  if (lobby.phase === 'launched' || lobby.phase === 'closed') return false;
  if (!quickBotsAllowed(lobby.game)) return false;

  const wanted = Math.max(0, Math.min(Math.trunc(count), quickMaxBots(lobby)));
  if (wanted === lobby.bots) return false;

  lobby.bots = wanted;
  lobby.lastActivityAt = now;
  return true;
}

/** An unknown key or an unknown value is ignored rather than stored. */
export function setQuickVote(
  lobby: QuickLobby,
  memberId: string,
  specs: QuickOptionSpec[],
  key: string,
  value: string,
  now: number
): boolean {
  const member = lobby.members[memberId];
  if (!member || lobby.phase === 'launched' || lobby.phase === 'closed') return false;

  const spec = specs.find((candidate) => candidate.key === key);
  if (!spec || !spec.choices.some((choice) => choice.value === value)) return false;

  member.votes[key] = value;
  member.lastSeenAt = now;
  lobby.lastActivityAt = now;
  return true;
}

/* -------------------------------------------------------------------- votes */

/** Members whose phone has said something recently enough to be counted. */
export function quickPresent(lobby: QuickLobby, now: number): QuickMember[] {
  return Object.values(lobby.members).filter((member) => member.connected && now - member.lastSeenAt < QUICK_STALE_MS);
}

/**
 * The settings in force: plurality per option, ties broken by the roll.
 *
 * Plurality rather than a majority because most options have three or four
 * choices and a room of five will rarely give any of them half. Falling back to
 * what was rolled — instead of to the first choice, or to whatever a first voter
 * picked — keeps an unpopular option at the surprise the quick match promised.
 */
export function tallyQuick(lobby: QuickLobby, specs: QuickOptionSpec[]): Record<string, string> {
  const settings: Record<string, string> = {};

  for (const spec of specs) {
    const counts = new Map<string, number>();
    for (const member of Object.values(lobby.members)) {
      const vote = member.votes[spec.key];
      if (vote === undefined) continue;
      if (!spec.choices.some((choice) => choice.value === vote)) continue;
      counts.set(vote, (counts.get(vote) ?? 0) + 1);
    }

    const rolled = lobby.rolled[spec.key] ?? spec.fallback;
    let best = rolled;
    let bestCount = 0;
    let tied = false;

    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
        tied = false;
      } else if (count === bestCount) {
        tied = true;
      }
    }

    settings[spec.key] = bestCount === 0 || tied ? rolled : best;
  }

  return settings;
}

/**
 * How many yes votes this room needs: a strict majority of who is actually here.
 *
 * The floor used to be `minPlayers` flat, which was right when only people could
 * take a seat: a room of three could not start a game that deals five, and asking
 * for five yes votes from three phones said so. Bots fill that gap now, so the
 * floor drops by however many the room has ordered — one player who seated four
 * machines needs one yes, not five, and without this they would watch a
 * permanently unreachable `1 / 5`.
 */
export function quickNeeded(lobby: QuickLobby, now: number): number {
  const present = quickPresent(lobby, now).length;
  const playable = Math.max(0, lobby.minPlayers - lobby.bots);
  return Math.max(playable, Math.floor(present / 2) + 1);
}

export type QuickDecision = 'wait' | 'countdown' | 'launch' | 'cancel';

/**
 * What the room has decided, from the votes alone.
 *
 * Two ways in: enough people said yes, or there is no room left for anyone else
 * and waiting would only stall a full house. A countdown already running is
 * re-checked on every change, so withdrawing the vote that tipped it calls the
 * launch off rather than letting a room start against itself.
 */
export function quickDecision(lobby: QuickLobby, now: number): QuickDecision {
  if (lobby.phase === 'launched' || lobby.phase === 'closed') return 'wait';

  const present = quickPresent(lobby, now);
  // `full` stays a count of people. A room that filled its own spare seats with
  // bots has not decided anything, and starting it on their behalf would rob the
  // table of the countdown it is entitled to.
  const full = Object.keys(lobby.members).length >= lobby.maxPlayers;
  // Bots do count here: seating them is exactly how three friends start a game
  // that needs five, which is the reason the room can ask for them at all.
  const enough = present.length + lobby.bots >= lobby.minPlayers;
  const yes = present.filter((member) => member.ready).length;
  const decided = enough && (full || yes >= quickNeeded(lobby, now));

  if (lobby.phase === 'countdown') {
    if (!decided) return 'cancel';
    return lobby.startsAt !== null && now >= lobby.startsAt ? 'launch' : 'wait';
  }

  return decided ? 'countdown' : 'wait';
}

export function armQuickCountdown(lobby: QuickLobby, now: number, delayMs = QUICK_COUNTDOWN_MS): void {
  lobby.phase = 'countdown';
  lobby.startsAt = now + delayMs;
  lobby.lastActivityAt = now;
}

export function cancelQuickCountdown(lobby: QuickLobby, now: number): void {
  lobby.phase = 'gathering';
  lobby.startsAt = null;
  lobby.lastActivityAt = now;
}
