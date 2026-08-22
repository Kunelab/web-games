import { post, systemPost, visibleTo, type ChatMessage } from 'chat-core';

import {
  BYSTANDER_ROLES,
  FACTION_LABELS,
  FAMILIES,
  familyOf,
  isSoloKiller,
  roleDef,
  type FamilyId,
  type NightActionType,
  type RoleId
} from './roles.js';
import {
  alivePlayers,
  assignRoles,
  chatRules,
  jailChannel,
  nextBotName,
  nextFreeSlot,
  playerFamily,
  pmChannel,
  playerBySlot,
  type MafiaPlayer,
  type MafiaState,
  type NightAction,
  type PointEntry
} from './state.js';

/**
 * All mutation of a Mafia table. Every function validates against the state it
 * is given and returns plain results; timers, persistence and broadcasting are
 * the server manager's job. `now` is always passed in, `rng` is injectable, so
 * the whole engine replays deterministically under test.
 */

export interface ActionOutcome {
  ok: boolean;
  error?: string;
}

const POINTS: Record<PointEntry['reason'], number> = {
  win: 5,
  'solo-win': 5,
  survive: 2,
  kill: 1,
  save: 2,
  'lynch-evil': 1,
  'execute-evil': 2,
  participation: 1
};

function addPoints(state: MafiaState, playerId: string, reason: PointEntry['reason']): void {
  state.points.push({ playerId, reason, amount: POINTS[reason] });
}

function notify(player: MafiaPlayer, text: string): void {
  player.notifications.push(text);
  // The feed is private and unbounded otherwise; a phone needs the recent past only.
  if (player.notifications.length > 60) player.notifications.splice(0, player.notifications.length - 60);
}

function announce(state: MafiaState, text: string, now: number): void {
  systemPost(state.chat, 'day', text, now);
}

/**
 * An announcement that names somebody's identity — or their killer's.
 *
 * Marked at the source so a shared screen can withhold it. Every phone at the
 * table still receives it in full; the flag is not privacy, it is a label saying
 * "this line is a reveal", for surfaces that more than one person is looking at.
 */
function announceReveal(state: MafiaState, text: string, now: number): void {
  systemPost(state.chat, 'day', text, now, { reveals: true });
}

/** A line of the dawn report, and whether it gives an identity away. */
interface Announcement {
  text: string;
  reveals?: boolean;
}

/* ------------------------------- lobby ---------------------------------- */

export function joinMafia(
  state: MafiaState,
  name: string,
  token: string,
  playerId: string,
  presetToken?: string,
  account?: string
): { player: MafiaPlayer; rejoined: boolean } {
  // A returning phone proves its seat with the token it stored.
  if (presetToken) {
    const seated = Object.values(state.players).find((player) => player.token === presetToken);
    if (seated) {
      seated.connected = true;
      return { player: seated, rejoined: true };
    }
  }

  if (state.phase !== 'lobby') throw new Error('La partie a déjà commencé');

  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) throw new Error('Il faut un nom');
  if (Object.values(state.players).some((player) => player.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('Ce nom est déjà pris');
  }

  const slot = nextFreeSlot(state);
  if (slot === null) throw new Error('La table est pleine');

  const player: MafiaPlayer = {
    playerId,
    token,
    name: trimmed,
    slot,
    account,
    isBot: false,
    connected: true,
    alive: true,
    role: null,
    charges: 0,
    obsessionId: null,
    revealed: false,
    doused: false,
    charged: false,
    poisonedNight: null,
    disguiseRole: null,
    bondPartnerId: null,
    bondKind: null,
    cooldownUntilDay: null,
    silencedDay: null,
    lastWill: '',
    notifications: [],
    intel: [],
    death: null
  };
  state.players[playerId] = player;
  return { player, rejoined: false };
}

export function addMafiaBot(state: MafiaState, token: string, playerId: string): MafiaPlayer {
  if (state.phase !== 'lobby') throw new Error('La partie a déjà commencé');
  const slot = nextFreeSlot(state);
  if (slot === null) throw new Error('La table est pleine');

  const player: MafiaPlayer = {
    playerId,
    token,
    name: nextBotName(state),
    slot,
    isBot: true,
    connected: true,
    alive: true,
    role: null,
    charges: 0,
    obsessionId: null,
    revealed: false,
    doused: false,
    charged: false,
    poisonedNight: null,
    disguiseRole: null,
    bondPartnerId: null,
    bondKind: null,
    cooldownUntilDay: null,
    silencedDay: null,
    lastWill: '',
    notifications: [],
    intel: [],
    death: null
  };
  state.players[playerId] = player;
  return player;
}

export function removeMafiaBot(state: MafiaState, playerId: string): void {
  const player = state.players[playerId];
  if (state.phase === 'lobby' && player?.isBot) {
    delete state.players[playerId];
  }
}

export function startMafia(state: MafiaState, now: number, rng: () => number): void {
  if (state.phase !== 'lobby') throw new Error('Déjà en cours');
  if (Object.keys(state.players).length < state.config.minPlayers) {
    throw new Error(`Il faut au moins ${state.config.minPlayers} joueurs`);
  }

  assignRoles(state, rng);

  for (const player of Object.values(state.players)) {
    const def = roleDef(player.role!);
    notify(player, `Vous êtes ${def.name}. ${def.description}`);
    if (player.obsessionId) {
      const mark = state.players[player.obsessionId];
      if (mark) notify(player, `Votre obsession : faire pendre ${mark.name} (maison ${mark.slot}).`);
    }
  }

  beginDay(state, now, [{ text: 'La partie commence. Bienvenue en ville — apprenez à vous connaître, la nuit tombe vite.' }]);
}

/* -------------------------------- chat ---------------------------------- */

export function sayInChat(
  state: MafiaState,
  playerId: string,
  channel: string,
  text: string,
  now: number
): { ok: true; message: ChatMessage } | { ok: false; error: string } {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: 'Pas à cette table' };

  const rules = chatRules();
  if (!rules.canWrite(channel, playerId, state)) {
    return { ok: false, error: 'Vous ne pouvez pas parler ici' };
  }

  return post(state.chat, { channel, authorId: playerId, authorName: player.name, text, at: now });
}

export function chatVisibleTo(state: MafiaState, playerId: string): ChatMessage[] {
  return visibleTo(state.chat, playerId, state, chatRules());
}

/**
 * A whisper: private words, public gesture. The message lands in the pair's
 * pm channel; the whole square sees *that* two players leaned together —
 * which is half the fun and most of the danger.
 */
export function whisperTo(
  state: MafiaState,
  fromId: string,
  targetSlot: number,
  text: string,
  now: number
): { ok: true; message: ChatMessage } | { ok: false; error: string } {
  const from = state.players[fromId];
  const target = playerBySlot(state, targetSlot);
  if (!from || !target) return { ok: false, error: 'Destinataire introuvable' };
  if (target.playerId === fromId) return { ok: false, error: 'Se parler à soi-même, ça inquiète les voisins' };

  const channel = pmChannel(fromId, target.playerId);
  const rules = chatRules();
  if (!rules.canWrite(channel, fromId, state)) {
    return { ok: false, error: 'Impossible de murmurer maintenant' };
  }

  const result = post(state.chat, { channel, authorId: fromId, authorName: from.name, text, at: now });
  if (result.ok) {
    announce(state, `${from.name} murmure à l’oreille de ${target.name}…`, now);
  }
  return result;
}

export function setLastWill(state: MafiaState, playerId: string, text: string): ActionOutcome {
  const player = state.players[playerId];
  if (!player || !player.alive) return { ok: false, error: 'Trop tard' };
  player.lastWill = text.slice(0, 400);
  return { ok: true };
}

/* ----------------------------- day actions ------------------------------ */

export function revealMayor(state: MafiaState, playerId: string, now: number): ActionOutcome {
  const player = state.players[playerId];
  if (!player?.alive || (player.role !== 'mayor' && player.role !== 'marshall')) {
    return { ok: false, error: 'Impossible' };
  }
  if (state.phase !== 'day') return { ok: false, error: 'Attendez le jour' };
  if (player.revealed) return { ok: false, error: 'Déjà révélé' };

  player.revealed = true;
  announce(
    state,
    player.role === 'mayor'
      ? `${player.name} sort son écharpe : c'est le Maire ! Son vote compte triple.`
      : `${player.name} sort son insigne : c'est le Prévôt ! Aujourd'hui, la ville juge sans défense — et à la chaîne.`,
    now
  );
  return { ok: true };
}

/** A revealed, living marshall turns the day into an assembly line of justice. */
function marshallActive(state: MafiaState): boolean {
  return Object.values(state.players).some((player) => player.alive && player.role === 'marshall' && player.revealed);
}

/**
 * The judge's exceptional court: the current top-voted player goes straight to
 * judgement — no accusation threshold, no defense — and the judge's secret
 * ballot counts triple. Once per game, and nobody knows who called it.
 */
export function callCourt(state: MafiaState, playerId: string, now: number): ActionOutcome {
  const judge = state.players[playerId];
  if (!judge?.alive || judge.role !== 'judge') return { ok: false, error: 'Impossible' };
  if (judge.charges <= 0) return { ok: false, error: 'Le tribunal a déjà siégé' };
  if (state.phase !== 'day' || state.stage !== 'discussion' || state.day <= 1) {
    return { ok: false, error: 'Pas maintenant' };
  }

  // The court needs a defendant: the current top-voted player.
  const counts = new Map<string, number>();
  for (const targetId of Object.values(state.votes)) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  let accusedId: string | null = null;
  let best = 0;
  for (const [targetId, count] of counts) {
    if (count > best && state.players[targetId]?.alive) {
      accusedId = targetId;
      best = count;
    }
  }
  if (!accusedId) return { ok: false, error: 'Personne n’est accusé' };

  judge.charges -= 1;
  state.trial = { accusedId, ballots: {}, court: true };
  state.stage = 'judgement';
  state.votes = {};
  state.trialsToday += 1;
  state.phaseEndsAt = now + state.config.judgementMs;
  const accused = state.players[accusedId];
  announce(state, `Une voix tonne : « TRIBUNAL D'EXCEPTION ! » ${accused.name} est jugé séance tenante, sans défense.`, now);
  return { ok: true };
}

/** The jailor picks his prisoner in daylight; the cell locks at dusk. */
export function jailTarget(state: MafiaState, playerId: string, targetSlot: number | null): ActionOutcome {
  const player = state.players[playerId];
  if (!player?.alive || player.role !== 'jailor') return { ok: false, error: 'Impossible' };
  if (state.phase !== 'day') return { ok: false, error: 'Choisissez pendant le jour' };

  if (targetSlot === null) {
    state.jailedId = null;
    return { ok: true };
  }
  const target = playerBySlot(state, targetSlot);
  if (!target?.alive || target.playerId === playerId) return { ok: false, error: 'Cible invalide' };
  state.jailedId = target.playerId;
  return { ok: true };
}

function voteWeight(player: MafiaPlayer): number {
  return player.role === 'mayor' && player.revealed ? 3 : 1;
}

export function castVote(state: MafiaState, voterId: string, targetSlot: number | null, now: number): ActionOutcome {
  const voter = state.players[voterId];
  if (!voter?.alive) return { ok: false, error: 'Les morts ne votent pas' };
  if (state.phase !== 'day' || state.stage !== 'discussion') return { ok: false, error: 'Pas maintenant' };
  if (state.day <= 1) return { ok: false, error: 'Pas de vote le premier jour' };

  if (targetSlot === null) {
    delete state.votes[voterId];
    return { ok: true };
  }

  const target = playerBySlot(state, targetSlot);
  if (!target?.alive) return { ok: false, error: 'Cible invalide' };
  if (target.playerId === voterId) return { ok: false, error: 'Pas contre soi-même' };

  state.votes[voterId] = target.playerId;

  const alive = alivePlayers(state);
  const needed = Math.floor(alive.reduce((sum, p) => sum + voteWeight(p), 0) / 2) + 1;
  const against = alive
    .filter((p) => state.votes[p.playerId] === target.playerId)
    .reduce((sum, p) => sum + voteWeight(p), 0);

  /**
   * An accusation is no longer announced.
   *
   * It used to post a system line on every single vote, including every change of
   * mind — twenty-four players revising twice is seventy-odd lines a day, and the
   * chat log is a fixed ring, so the day phase was steadily deleting its own
   * record of who died and what they turned out to be. The live count belongs on
   * the player list, where it now sits beside each name and updates without
   * costing anything; only the moment that actually changes the game — the
   * threshold falling — is worth a line in the square.
   */
  if (against >= needed) {
    state.trial = { accusedId: target.playerId, ballots: {} };
    state.votes = {};
    state.trialsToday += 1;
    if (marshallActive(state)) {
      // The marshall's day: straight to the verdict.
      state.stage = 'judgement';
      state.phaseEndsAt = now + state.config.judgementMs;
      announce(state, `${target.name} est traîné à la barre. Le Prévôt refuse la défense : votez !`, now);
    } else {
      state.stage = 'defense';
      state.phaseEndsAt = now + state.config.defenseMs;
      announce(state, `La ville traîne ${target.name} à la barre. Défendez-vous !`, now);
    }
  }
  return { ok: true };
}

export function castBallot(
  state: MafiaState,
  voterId: string,
  verdict: 'guilty' | 'innocent' | 'abstain'
): ActionOutcome {
  const voter = state.players[voterId];
  if (!voter?.alive) return { ok: false, error: 'Les morts ne votent pas' };
  if (state.phase !== 'day' || state.stage !== 'judgement' || !state.trial) {
    return { ok: false, error: 'Pas maintenant' };
  }
  if (state.trial.accusedId === voterId) return { ok: false, error: "L'accusé ne vote pas" };

  if (verdict === 'abstain') delete state.trial.ballots[voterId];
  else state.trial.ballots[voterId] = verdict;
  return { ok: true };
}

/* ---------------------------- night actions ----------------------------- */

export interface LegalAction {
  type: NightActionType;
  /** Slots this action may target; empty for self-targeted powers. */
  targets: number[];
  charges: number | null;
}

export function legalNightAction(state: MafiaState, playerId: string): LegalAction | null {
  const player = state.players[playerId];
  if (!player?.alive || state.phase !== 'night' || !player.role) return null;
  if (state.jailedId === playerId) return null;

  const def = roleDef(player.role);
  if (!def.nightAction) return null;
  if (def.charges !== undefined && player.charges <= 0) return null;

  const family = playerFamily(player);
  const others = alivePlayers(state).filter((other) => other.playerId !== playerId);
  const outsiders = others.filter((other) => family === null || playerFamily(other) !== family);
  const slots = (list: MafiaPlayer[]) => list.map((entry) => entry.slot);
  const uses = def.charges !== undefined ? player.charges : null;

  switch (def.nightAction) {
    case 'alert':
    case 'vest':
      return { type: def.nightAction, targets: [], charges: player.charges };
    case 'jail-execute': {
      if (!state.jailedId) return null;
      const jailed = state.players[state.jailedId];
      return jailed?.alive ? { type: 'jail-execute', targets: [jailed.slot], charges: player.charges } : null;
    }
    case 'kill': {
      // The vigilante holds fire the first night; the town has met nobody yet.
      if (player.role === 'vigilante' && state.day <= 1) return null;
      return { type: 'kill', targets: slots(family ? outsiders : others), charges: uses };
    }
    case 'frame':
    case 'silence':
    case 'charm':
    case 'rampage':
    case 'poison':
    case 'kidnap':
    case 'audit':
      return { type: def.nightAction, targets: slots(outsiders), charges: uses };
    case 'clean':
      // You only clean bodies the family made; anybody outside is fair prep.
      return { type: 'clean', targets: slots(outsiders), charges: uses };
    case 'douse':
    case 'charge':
      // Any house can be prepared; his own house means pulling the trigger.
      return { type: def.nightAction, targets: [...slots(others), player.slot], charges: null };
    case 'swap':
      // Two houses trade fates; the driver may ride his own bus.
      return { type: 'swap', targets: [...slots(others), player.slot], charges: null };
    case 'convert':
      if (player.cooldownUntilDay !== null && state.day < player.cooldownUntilDay) return null;
      return { type: 'convert', targets: slots(outsiders), charges: null };
    case 'bond':
      if (player.bondPartnerId !== null) return null;
      return { type: 'bond', targets: slots(others), charges: uses };
    case 'remember':
    case 'autopsy': {
      const dead = Object.values(state.players).filter((entry) => !entry.alive);
      return dead.length > 0 ? { type: def.nightAction, targets: slots(dead), charges: uses } : null;
    }
    default:
      return { type: def.nightAction, targets: slots(others), charges: null };
  }
}

export function setNightAction(
  state: MafiaState,
  playerId: string,
  targetSlot: number | null,
  secondTargetSlot?: number | null
): ActionOutcome {
  const legal = legalNightAction(state, playerId);
  if (!legal) return { ok: false, error: 'Aucune action possible' };

  if (targetSlot === null) {
    delete state.nightActions[playerId];
    return { ok: true };
  }

  let targetId: string | null = null;
  if (legal.targets.length > 0) {
    const target = playerBySlot(state, targetSlot);
    if (!target || !legal.targets.includes(target.slot)) return { ok: false, error: 'Cible invalide' };
    targetId = target.playerId;
  }

  // Second target (witch destination, bus's other house): optional; the night
  // resolver rolls one when it's missing.
  let secondTargetId: string | null = null;
  if ((legal.type === 'control' || legal.type === 'swap') && secondTargetSlot != null) {
    const destination = playerBySlot(state, secondTargetSlot);
    if (destination?.alive) secondTargetId = destination.playerId;
  }

  state.nightActions[playerId] = { type: legal.type, targetId, secondTargetId };
  return { ok: true };
}

/* ------------------------------ transitions ----------------------------- */

function beginDay(state: MafiaState, now: number, announcements: Announcement[]): void {
  state.day += 1;
  state.phase = 'day';
  state.stage = 'discussion';
  state.trial = null;
  state.trialsToday = 0;
  state.votes = {};
  state.nightActions = {};
  state.phaseEndsAt = now + (state.day === 1 ? Math.round(state.config.dayMs * 0.6) : state.config.dayMs);

  announce(state, `— Jour ${state.day} —`, now);
  for (const line of announcements) {
    if (line.reveals) announceReveal(state, line.text, now);
    else announce(state, line.text, now);
  }
}

function beginNight(state: MafiaState, now: number): void {
  state.phase = 'night';
  state.stage = null;
  state.trial = null;
  state.votes = {};
  state.nightActions = {};
  state.phaseEndsAt = now + state.config.nightMs;

  announce(state, `La nuit ${state.day} tombe sur la ville. Fermez vos portes.`, now);

  const jailed = state.jailedId ? state.players[state.jailedId] : null;
  const jailor = Object.values(state.players).find((player) => player.role === 'jailor' && player.alive);
  if (jailed?.alive && jailor?.alive) {
    notify(jailed, 'On vous a traîné en cellule pour la nuit. Le Geôlier vous écoute.');
    systemPost(state.chat, jailChannel(state.day), `${jailed.name} est en cellule. La conversation est privée.`, now);
  } else {
    state.jailedId = null;
  }
}

/** Advances whatever phase just hit its deadline. Idempotent per deadline. */
export function advanceMafia(state: MafiaState, now: number, rng: () => number): void {
  if (state.phase === 'day' && state.stage === 'discussion') {
    beginNight(state, now);
    return;
  }
  if (state.phase === 'day' && state.stage === 'defense') {
    state.stage = 'judgement';
    state.phaseEndsAt = now + state.config.judgementMs;
    const accused = state.trial ? state.players[state.trial.accusedId] : null;
    if (accused) announce(state, `La ville juge ${accused.name} : coupable ou innocent ?`, now);
    return;
  }
  if (state.phase === 'day' && state.stage === 'judgement') {
    concludeTrial(state, now);
    return;
  }
  if (state.phase === 'night') {
    const announcements = resolveNight(state, rng);
    if (checkVictory(state, now)) return;
    if (state.day >= state.config.maxDays) {
      endGame(state, now, 'La ville, épuisée, déclare un match nul.');
      return;
    }
    beginDay(state, now, announcements);
  }
}

function concludeTrial(state: MafiaState, now: number): void {
  const trial = state.trial;
  const accused = trial ? state.players[trial.accusedId] : null;
  state.trial = null;
  state.stage = 'discussion';

  if (!trial || !accused?.alive) {
    beginNight(state, now);
    return;
  }

  let guilty = 0;
  let innocent = 0;
  for (const [voterId, verdict] of Object.entries(trial.ballots)) {
    const voter = state.players[voterId];
    if (!voter?.alive) continue;
    // In the judge's exceptional court, his own gavel weighs triple.
    const weight = trial.court && voter.role === 'judge' ? 3 : voteWeight(voter);
    if (verdict === 'guilty') guilty += weight;
    else innocent += weight;
  }

  announce(state, `Verdict : ${guilty} coupable, ${innocent} innocent.`, now);

  // The ballots go public with the verdict: the town sees who wanted the rope
  // and who wanted mercy. Saving a mafioso in public is how trust dies.
  const guiltyIds = Object.entries(trial.ballots)
    .filter(([voterId, verdict]) => verdict === 'guilty' && state.players[voterId]?.alive)
    .map(([voterId]) => voterId);
  const innocentIds = Object.entries(trial.ballots)
    .filter(([voterId, verdict]) => verdict === 'innocent' && state.players[voterId]?.alive)
    .map(([voterId]) => voterId);
  // Recorded either way: the end-of-game replay shows every hand that was raised.
  (state.trialLog ??= []).push({
    day: state.day,
    accusedId: accused.playerId,
    lynched: guilty > innocent,
    guiltyIds,
    innocentIds
  });

  /**
   * In the judge's court the ballots stay sealed, and that is not flavour.
   *
   * The tally is *weighted* and the name lists are *headcounts*, so publishing both
   * hands out the difference — and in a court the only hidden weight on the
   * board is the judge's own triple gavel. Four guilty votes beside two names,
   * with no mayor revealed, names the judge as surely as a confession; with one
   * voter it reads "3 coupable" beside one name. The role's entire promise is
   * that nobody knows who called the court, so the court votes in secret and the
   * arithmetic has nothing to subtract from.
   *
   * An ordinary trial publishes both safely: the revealed mayor is the only
   * weight above one, and everyone can already see his sash.
   */
  if (trial.court) {
    announce(state, 'Le tribunal d’exception a voté à bulletin secret : aucun nom ne sortira de cette salle.', now);
  } else {
    const names = (ids: string[]) => ids.map((id) => state.players[id]?.name).filter(Boolean).join(', ') || 'personne';
    announce(state, `Ont voté coupable : ${names(guiltyIds)}. Ont voté innocent : ${names(innocentIds)}.`, now);
  }

  if (guilty > innocent) {
    lynch(state, accused, trial, now);
    if (checkVictory(state, now)) return;
    beginNight(state, now);
    return;
  }

  announce(state, `${accused.name} est épargné.`, now);
  const trialCap = state.config.trialsPerDay + (marshallActive(state) ? 2 : 0);
  if (state.trialsToday >= trialCap) {
    beginNight(state, now);
  } else {
    state.phaseEndsAt = now + state.config.aftermathMs;
  }
}

/** Evil in the sheriff's sense: families and solo killers. */
function evilRole(role: RoleId): boolean {
  return familyOf(role) !== null || isSoloKiller(role);
}

/**
 * What the town is told a body was, under the table's `revealOnDeath` policy.
 *
 * The announcements and the projected view have to agree exactly — a corpse whose
 * role is withheld from the roster but named in the square is withheld from
 * nobody. Reads the true `role` on purpose: a borrowed face is an examiner's
 * problem, and a role that was genuinely changed reveals what it became.
 */
function bodyReads(state: MafiaState, player: MafiaPlayer): string {
  const role = player.role;
  if (!role) return 'On ne saura jamais qui il était.';
  switch (state.config.revealOnDeath ?? 'role') {
    case 'none':
      return 'Son secret est mort avec lui.';
    case 'faction': {
      const faction = roleDef(role).faction;
      return faction === 'neutral'
        ? 'Il ne servait que lui-même.'
        : `Il était de la ${FACTION_LABELS[faction]}.`;
    }
    default:
      return `C'était ${roleDef(role).name}.`;
  }
}

function lynch(state: MafiaState, accused: MafiaPlayer, trial: { ballots: Record<string, 'guilty' | 'innocent'> }, now: number): void {
  const role = accused.role!;
  kill(state, accused, 'day', 'pendu par la ville');
  announceReveal(state, `${accused.name} se balance au bout de la corde. ${bodyReads(state, accused)}`, now);
  if (accused.lastWill) announceReveal(state, `Dernières volontés de ${accused.name} : « ${accused.lastWill} »`, now);

  if (evilRole(role)) {
    for (const [voterId, verdict] of Object.entries(trial.ballots)) {
      const voter = state.players[voterId];
      if (verdict === 'guilty' && voter?.alive) addPoints(state, voterId, 'lynch-evil');
    }
  }

  if (role === 'jester') {
    state.winners.push({ playerId: accused.playerId, reason: 'Bouffon pendu : il gagne seul' });
    addPoints(state, accused.playerId, 'solo-win');
    notify(accused, 'Ils vous ont pendu. Vous avez gagné.');
    announce(state, `Un rire monte du gibet… le Bouffon voulait cette corde. Il gagne.`, now);
  }

  for (const player of Object.values(state.players)) {
    if (player.role === 'executioner' && player.alive && player.obsessionId === accused.playerId) {
      state.winners.push({ playerId: player.playerId, reason: 'Obsession pendue : le Bourreau gagne' });
      addPoints(state, player.playerId, 'solo-win');
      notify(player, 'Votre obsession se balance. Vous avez gagné.');
    }
  }

  // A broken heart follows its owner into the grave, even from the gallows.
  for (const line of cascadeBonds(state)) {
    announceReveal(state, line, now);
  }
}

function kill(state: MafiaState, victim: MafiaPlayer, phase: 'day' | 'night', cause: string): void {
  victim.alive = false;
  victim.death = { day: state.day, phase, cause };
  state.deaths.push({ playerId: victim.playerId, day: state.day, phase, cause, role: victim.role! });

  // A dead jailor frees his prisoner; a dead prisoner empties the cell.
  const jailor = Object.values(state.players).find((player) => player.role === 'jailor');
  if (victim.playerId === state.jailedId || victim.playerId === jailor?.playerId) {
    state.jailedId = null;
  }
}

/**
 * Bound hearts stop together: lovers die of grief, the heartbreaker's charmed
 * follow him down. Loops until stable (a chain of hearts falls link by link).
 * Returns the announcement lines.
 */
function cascadeBonds(state: MafiaState): string[] {
  const lines: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const player of Object.values(state.players)) {
      if (!player.alive || !player.bondPartnerId) continue;
      const partner = state.players[player.bondPartnerId];
      if (partner && !partner.alive) {
        kill(state, player, state.phase === 'day' ? 'day' : 'night', 'mort de chagrin');
        lines.push(`${player.name} s'est éteint de chagrin. ${bodyReads(state, player)}`);
        changed = true;
      }
    }
  }
  return lines;
}

/* --------------------------- night resolution --------------------------- */

interface Attack {
  attackerId: string;
  targetId: string;
  power: number;
  label: string;
}

/**
 * The powers that read the town rather than change it.
 *
 * Named once because two passes need to agree on the list: the movement pass
 * that puts these visitors on the street, and the results pass that tells them
 * what they saw. They disagreed before, and that was the bug.
 */
const INVESTIGATIVE: NightActionType[] = ['investigate', 'examine', 'watch', 'track', 'shadow', 'autopsy'];

function resolveNight(state: MafiaState, rng: () => number): Announcement[] {
  const acts = state.nightActions;
  const jailedId = state.jailedId;
  const announcements: Announcement[] = [];

  const actionOf = (player: MafiaPlayer): NightAction | undefined => acts[player.playerId];
  const players = Object.values(state.players);
  const living = (id: string | null | undefined): MafiaPlayer | null => {
    if (!id) return null;
    const player = state.players[id];
    return player?.alive ? player : null;
  };
  const randomOther = (excludeId: string): MafiaPlayer | null => {
    const pool = players.filter((entry) => entry.alive && entry.playerId !== excludeId);
    return pool[Math.floor(rng() * pool.length)] ?? null;
  };

  const blocked = new Set<string>();
  if (jailedId) blocked.add(jailedId);

  // Yesterday's borrowed faces wash off before tonight's are painted on.
  for (const player of players) player.disguiseRole = null;

  // Self-preparations first: they cannot be blocked (short of a jail cell).
  const alerted = new Set<string>();
  const vested = new Set<string>();
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (action?.type === 'alert' && player.charges > 0) {
      player.charges -= 1;
      alerted.add(player.playerId);
      notify(player, 'Vous passez la nuit en alerte, fusil sur les genoux.');
    }
    if (action?.type === 'vest' && player.charges > 0) {
      player.charges -= 1;
      vested.add(player.playerId);
      notify(player, 'Gilet enfilé pour la nuit.');
    }
  }

  /** Who stepped out to whose house tonight; the lookout and veteran read this. */
  const visits: { visitorId: string; targetId: string }[] = [];
  const visit = (visitorId: string, targetId: string): void => {
    visits.push({ visitorId, targetId });
  };

  // The witch weaves before anyone leaves home: her victim's hand is guided to
  // another door. Acting first is her roleblock immunity.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'witch') continue;
    const action = actionOf(player);
    if (action?.type !== 'control') continue;
    const victim = living(action.targetId);
    if (!victim) continue;
    visit(player.playerId, victim.playerId);

    const victimAction = acts[victim.playerId];
    if (victimAction && victimAction.targetId && victimAction.targetId !== victim.playerId) {
      const destination = living(action.secondTargetId) ?? randomOther(victim.playerId);
      if (destination) {
        victimAction.targetId = destination.playerId;
        notify(victim, 'Une volonté étrangère a guidé vos pas cette nuit.');
        notify(player, `Vous avez envoûté ${victim.name} et détourné son geste vers ${destination.name}.`);
      }
    } else {
      notify(player, `${victim.name} n'avait aucun geste à détourner cette nuit.`);
    }
  }

  // The bus rolls next: two houses trade fates, and everything aimed at one
  // arrives at the other. The driver is on the road before the roadblocks.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'bus-driver') continue;
    const action = actionOf(player);
    if (action?.type !== 'swap') continue;
    const first = living(action.targetId);
    const second = living(action.secondTargetId) ?? randomOther(first?.playerId ?? player.playerId);
    if (!first || !second || first.playerId === second.playerId) continue;

    visit(player.playerId, first.playerId);
    visit(player.playerId, second.playerId);
    for (const [actorId, other] of Object.entries(acts)) {
      if (actorId === player.playerId) continue;
      // Self-aimed deeds (the match, the lever) stay home; journeys reroute.
      if (other.targetId === actorId) continue;
      if (other.targetId === first.playerId) other.targetId = second.playerId;
      else if (other.targetId === second.playerId) other.targetId = first.playerId;
    }
    notify(first, 'Un bus vous a déposé ailleurs cette nuit.');
    notify(second, 'Un bus vous a déposé ailleurs cette nuit.');
    notify(player, `Vous avez échangé ${first.name} et ${second.name}. Vous seul savez qui dormait où.`);
    player.intel.push({
      night: state.day,
      kind: 'swapped',
      targetSlot: first.slot,
      value: `${first.slot},${second.slot}`,
      slots: [first.slot, second.slot]
    });
  }

  // Kidnappings: gone for the night — unreachable, harmless, furious.
  const sheltered = new Set<string>();
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (action?.type !== 'kidnap') continue;
    const target = living(action.targetId);
    if (!target) continue;
    visit(player.playerId, target.playerId);
    blocked.add(target.playerId);
    sheltered.add(target.playerId);
    notify(target, 'Un sac sur la tête, une cave inconnue : on vous a enlevé pour la nuit.');
    player.intel.push({ night: state.day, kind: 'blocked', targetSlot: target.slot, value: 'kidnapped' });
  }

  // Roleblocks. An alerted veteran is home armed — nobody "keeps him busy".
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (action?.type !== 'block') continue;
    const target = living(action.targetId);
    if (!target) continue;
    visit(player.playerId, target.playerId);
    if (!alerted.has(target.playerId)) {
      blocked.add(target.playerId);
      notify(target, 'Quelqu’un vous a retenu toute la nuit. Votre action est tombée à l’eau.');
      // The blocker knows whom they kept busy — a quiet night says a lot.
      player.intel.push({ night: state.day, kind: 'blocked', targetSlot: target.slot, value: 'blocked' });
    }
  }

  // Preparations, protections and marks.
  const framed = new Set<string>();
  const healers = new Map<string, string[]>();
  const guards = new Map<string, string[]>();
  const hideHosts = new Map<string, string>();
  const cleanTargets = new Map<string, string>();
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action) continue;
    const target = living(action.targetId);
    if (!target) continue;

    switch (action.type) {
      case 'frame':
        framed.add(target.playerId);
        visit(player.playerId, target.playerId);
        break;
      case 'heal':
        healers.set(target.playerId, [...(healers.get(target.playerId) ?? []), player.playerId]);
        visit(player.playerId, target.playerId);
        break;
      case 'guard':
        guards.set(target.playerId, [...(guards.get(target.playerId) ?? []), player.playerId]);
        visit(player.playerId, target.playerId);
        break;
      case 'silence':
        target.silencedDay = state.day + 1;
        visit(player.playerId, target.playerId);
        notify(target, 'Une lettre sous votre porte : « Un mot demain et tout le monde saura. » Vous voilà muet.');
        notify(player, `${target.name} se taira demain.`);
        break;
      case 'douse':
        if (target.playerId !== player.playerId) {
          target.doused = true;
          visit(player.playerId, target.playerId);
          notify(target, 'Une odeur d’essence imprègne vos murs…');
          notify(player, `La maison de ${target.name} est imbibée.`);
          player.intel.push({ night: state.day, kind: 'doused', targetSlot: target.slot, value: 'doused' });
        }
        break;
      case 'charge':
        if (target.playerId !== player.playerId) {
          target.charged = true;
          visit(player.playerId, target.playerId);
          notify(player, `La maison de ${target.name} est câblée.`);
          player.intel.push({ night: state.day, kind: 'doused', targetSlot: target.slot, value: 'charged' });
        }
        break;
      case 'poison':
        target.poisonedNight = state.day;
        visit(player.playerId, target.playerId);
        notify(target, 'Un goût amer au fond de la gorge. Vous vous sentez fiévreux…');
        notify(player, `${target.name} est empoisonné : il s’éteindra demain, sauf médecin.`);
        break;
      case 'imitate':
        player.disguiseRole = target.role;
        visit(player.playerId, target.playerId);
        notify(player, `Cette nuit, les curieux vous prendront pour ${roleDef(target.role!).name}.`);
        break;
      case 'hide':
        hideHosts.set(player.playerId, target.playerId);
        visit(player.playerId, target.playerId);
        notify(player, `Vous passez la nuit caché chez ${target.name}. Ce qui vous visait le trouvera.`);
        break;
      case 'charm':
        target.bondPartnerId = player.playerId;
        target.bondKind = 'charm';
        visit(player.playerId, target.playerId);
        notify(target, 'Un parfum entêtant vous colle à la peau. Votre cœur ne bat plus tout à fait pour vous.');
        notify(player, `${target.name} vous appartient : si vous tombez, ce cœur s’arrête aussi.`);
        break;
      case 'bond':
        if (player.charges > 0 && player.bondPartnerId === null) {
          player.charges -= 1;
          player.bondPartnerId = target.playerId;
          player.bondKind = 'lover';
          target.bondPartnerId = player.playerId;
          target.bondKind = 'lover';
          visit(player.playerId, target.playerId);
          notify(player, `Votre cœur a choisi ${target.name}. Vivez ensemble, ou mourez ensemble.`);
          notify(target, `Quelqu’un vous aime à la folie : ${player.name}. Vivez ensemble, ou mourez ensemble.`);
        }
        break;
      case 'clean':
        cleanTargets.set(player.playerId, target.playerId);
        visit(player.playerId, target.playerId);
        break;
      default:
        break;
    }
  }

  /**
   * The investigators step out with everybody else.
   *
   * Their *journeys* are declared here, in the movement pass, and their
   * *findings* are computed much further down once the shooting is over. Those
   * are two different things and they were previously one: recording the visits
   * next to the results meant they landed after the veteran's porch and after
   * the mass murderer's house, so a sheriff could sound out an alerted veteran
   * for free and a lookout could watch a massacre from the doorway. Both were
   * the most common visitors on the board, which made both mechanics ornamental.
   *
   * Nothing reads `visits` before this point; everything that punishes a visitor
   * reads it after. That ordering is the whole contract, and there is a test per
   * mechanic holding it down.
   */
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action?.targetId || !INVESTIGATIVE.includes(action.type)) continue;
    // An autopsy is performed on a slab, not on a doorstep: nobody goes out.
    if (action.type === 'autopsy') continue;
    if (!state.players[action.targetId]) continue;
    visit(player.playerId, action.targetId);
  }

  // Attacks.
  const attacks: Attack[] = [];

  // Yesterday's poison runs its course tonight — unless a doctor purges it.
  for (const player of players) {
    if (!player.alive || player.poisonedNight === null) continue;
    if (player.poisonedNight <= state.day - 1) {
      const poisoner = players.find((entry) => entry.alive && entry.role === 'poisoner');
      attacks.push({
        attackerId: poisoner?.playerId ?? player.playerId,
        targetId: player.playerId,
        power: 2,
        label: 'le poison'
      });
    }
  }

  // The match drops: everything soaked burns. Fire is power 3 — no doctor, no
  // bodyguard, no vest argues with it. Only a jail cell is stone enough.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'arsonist') continue;
    const action = actionOf(player);
    if (action?.type !== 'douse' || action.targetId !== player.playerId) continue;
    for (const soaked of players) {
      if (soaked.alive && soaked.doused && soaked.playerId !== player.playerId) {
        attacks.push({ attackerId: player.playerId, targetId: soaked.playerId, power: 3, label: 'l’Incendiaire' });
      }
    }
  }

  // The lever drops: every wired house takes the surge. Power 2 — curable.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'electromaniac') continue;
    const action = actionOf(player);
    if (action?.type !== 'charge' || action.targetId !== player.playerId) continue;
    for (const wired of players) {
      if (wired.alive && wired.charged && wired.playerId !== player.playerId) {
        attacks.push({ attackerId: player.playerId, targetId: wired.playerId, power: 2, label: 'l’Électromane' });
      }
    }
  }

  // The family kills: each family's leader orders, an executor carries.
  const familyKillTargets = new Map<FamilyId, string>();
  for (const familyId of Object.keys(FAMILIES) as (keyof typeof FAMILIES)[]) {
    const meta = FAMILIES[familyId];
    const members = players.filter((entry) => entry.alive && playerFamily(entry) === familyId);
    if (members.length === 0) continue;
    const leader = members.find((entry) => roleDef(entry.role!).familyRank === 'leader');
    const executors = members.filter((entry) => roleDef(entry.role!).familyRank === 'executor');

    const leaderOrder = leader ? actionOf(leader) : undefined;
    const executorOrder = executors.map((entry) => actionOf(entry)).find((order) => order?.type === 'kill');
    const targetId = (leaderOrder?.type === 'kill' ? leaderOrder.targetId : null) ?? executorOrder?.targetId ?? null;
    const target = living(targetId);
    const carrier =
      executors.find((entry) => !blocked.has(entry.playerId)) ??
      (leader && !blocked.has(leader.playerId) ? leader : null);
    if (target && carrier) {
      attacks.push({ attackerId: carrier.playerId, targetId: target.playerId, power: 1, label: meta.label });
      visit(carrier.playerId, target.playerId);
      familyKillTargets.set(familyId, target.playerId);
    }
  }

  // Lone guns, lone blades, and one massacre.
  const rampages: { attackerId: string; houseId: string }[] = [];
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action) continue;
    const target = living(action.targetId);
    if (!target) continue;

    if (action.type === 'kill' && playerFamily(player) === null) {
      if (player.role === 'vigilante') {
        if (player.charges <= 0) continue;
        player.charges -= 1;
        attacks.push({ attackerId: player.playerId, targetId: target.playerId, power: 1, label: 'le Justicier' });
        visit(player.playerId, target.playerId);
      }
      if (player.role === 'serial-killer') {
        // Power 2: the blade goes through night immunity and vests — the
        // Godfather's predator (a 1v1 of untouchables was 84% of all draws).
        attacks.push({ attackerId: player.playerId, targetId: target.playerId, power: 2, label: 'le Tueur en série' });
        visit(player.playerId, target.playerId);
      }
    }

    // The massacre: the house, and everyone unlucky enough to be in it. Who was
    // in it is settled below, once every journey has been declared.
    if (action.type === 'rampage' && player.role === 'mass-murderer') {
      attacks.push({ attackerId: player.playerId, targetId: target.playerId, power: 1, label: 'le Tueur de masse' });
      visit(player.playerId, target.playerId);
      rampages.push({ attackerId: player.playerId, houseId: target.playerId });
    }
  }

  /**
   * And now the collateral, after the last visitor is on the street.
   *
   * Expanded in its own pass rather than inline, because inline it could only
   * see the journeys declared by players the loop had already reached — so
   * whether a killer or a family carrier died in someone else's massacre came
   * down to seat order, and no investigator was ever caught at all.
   */
  for (const { attackerId, houseId } of rampages) {
    const caught = new Set(
      visits.filter((entry) => entry.targetId === houseId && entry.visitorId !== attackerId).map((entry) => entry.visitorId)
    );
    for (const visitorId of caught) {
      attacks.push({ attackerId, targetId: visitorId, power: 1, label: 'le Tueur de masse' });
    }
  }

  // The jailor's execution: inside the cell, no protection reaches it.
  const jailor = players.find((p) => p.alive && p.role === 'jailor');
  const jailed = living(jailedId);
  if (jailor && jailed && actionOf(jailor)?.type === 'jail-execute' && jailor.charges > 0) {
    jailor.charges -= 1;
    attacks.push({ attackerId: jailor.playerId, targetId: jailed.playerId, power: 3, label: 'le Geôlier' });
  }

  // The veteran shoots everything that moves on his porch.
  for (const { visitorId, targetId } of visits) {
    if (alerted.has(targetId) && visitorId !== targetId) {
      attacks.push({ attackerId: targetId, targetId: visitorId, power: 2, label: 'le Vétéran' });
    }
  }

  // Resolution, one attack at a time.
  const diedTonight = new Set<string>();
  for (const attack of attacks) {
    // A hidden coward hands his fate to his host.
    const hiddenAt = hideHosts.get(attack.targetId);
    const finalTargetId = hiddenAt && state.players[hiddenAt]?.alive ? hiddenAt : attack.targetId;
    const target = state.players[finalTargetId];
    const attacker = state.players[attack.attackerId];
    if (!target || !target.alive || diedTonight.has(target.playerId)) continue;

    const fromJailor = attack.label === 'le Geôlier';
    const isPoison = attack.label === 'le poison';

    // The cell protects its prisoner from the outside world, never from its keeper.
    if (target.playerId === jailedId && !fromJailor && !isPoison) {
      if (attacker) notify(attacker, 'Votre cible était introuvable cette nuit.');
      continue;
    }
    // A kidnapped player is somewhere nobody knows.
    if (sheltered.has(target.playerId) && !isPoison) {
      if (attacker) notify(attacker, 'Votre cible était introuvable cette nuit.');
      continue;
    }

    let defense = 0;
    if (target.role && roleDef(target.role).nightImmune) defense = Math.max(defense, 1);
    if (vested.has(target.playerId)) defense = Math.max(defense, 1);
    if (alerted.has(target.playerId)) defense = Math.max(defense, 2);
    if (isPoison) defense = 0; // the poison is already inside; armour is irrelevant

    if (attack.power <= defense) {
      notify(target, 'On vous a attaqué cette nuit, mais vous avez tenu bon.');
      if (attacker) notify(attacker, 'Votre cible a survécu à votre attaque.');
      continue;
    }

    // A bodyguard steps in front of anything short of an execution or a fire.
    const guardList = (guards.get(target.playerId) ?? []).map((id) => state.players[id]).filter((g) => g?.alive);
    if (!fromJailor && !isPoison && attack.power <= 2 && guardList.length > 0) {
      const guard = guardList[0];
      if (guard) {
        diedTonight.add(guard.playerId);
        kill(state, guard, 'night', `mort en protégeant ${target.name}`);
        addPoints(state, guard.playerId, 'save');
        notify(target, 'Quelqu’un est mort pour vous cette nuit.');
        if (attacker && attacker.playerId !== guard.playerId) {
          const counterDefense = attacker.role && roleDef(attacker.role).nightImmune ? 1 : 0;
          if (2 > counterDefense && !diedTonight.has(attacker.playerId)) {
            diedTonight.add(attacker.playerId);
            kill(state, attacker, 'night', 'abattu par un garde du corps');
          } else {
            notify(attacker, 'Un garde du corps vous a repoussé.');
          }
        }
        continue;
      }
    }

    // The doctor saves anything short of an execution or a fire — and purges poison.
    const healerList = (healers.get(target.playerId) ?? []).map((id) => state.players[id]).filter((h) => h?.alive);
    if (!fromJailor && attack.power <= 2 && healerList.length > 0) {
      if (isPoison) {
        target.poisonedNight = null;
        notify(target, 'La fièvre tombe : on vous a purgé le sang à temps.');
      } else {
        notify(target, 'On vous a laissé pour mort, mais des mains expertes vous ont recousu.');
      }
      for (const healer of healerList) {
        if (healer) {
          notify(healer, 'Votre patient a été attaqué cette nuit. Vous l’avez sauvé.');
          healer.intel.push({ night: state.day, kind: 'saved', targetSlot: target.slot, value: 'saved' });
          addPoints(state, healer.playerId, 'save');
        }
      }
      continue;
    }

    diedTonight.add(target.playerId);
    kill(state, target, 'night', `tué par ${attack.label}`);
    if (isPoison) target.poisonedNight = null;
    if (attacker && attacker.playerId !== target.playerId) {
      addPoints(state, attacker.playerId, 'kill');
      if (fromJailor) {
        if (target.role && evilRole(target.role)) {
          addPoints(state, attacker.playerId, 'execute-evil');
        } else {
          attacker.charges = 0;
          notify(attacker, 'Vous avez exécuté un innocent. Vos mains tremblent : plus aucune exécution.');
        }
      }
    }
  }

  // Spent or cured poison clears; a fresh dose keeps ticking toward tomorrow.
  for (const player of players) {
    if (player.poisonedNight !== null && player.poisonedNight <= state.day - 1) {
      player.poisonedNight = null;
    }
  }

  // Bound hearts stop together.
  for (const line of cascadeBonds(state)) {
    announcements.push({ text: line, reveals: true });
  }

  // The cleaners pass before dawn: a nameless body, one more family secret.
  for (const [cleanerId, targetId] of cleanTargets) {
    const cleaner = state.players[cleanerId];
    const target = state.players[targetId];
    if (!cleaner?.alive || cleaner.charges <= 0 || !target || target.alive) continue;
    const record = state.deaths.find((death) => death.playerId === targetId && death.day === state.day);
    if (!record) continue;
    record.hidden = true;
    cleaner.charges -= 1;
    cleaner.intel.push({ night: state.day, kind: 'role', targetSlot: target.slot, value: target.role! });
    notify(cleaner, `Le cadavre de ${target.name} est méconnaissable. C'était ${roleDef(target.role!).name}.`);
  }

  // Dawn report.
  for (const player of players) {
    if (diedTonight.has(player.playerId)) {
      const record = state.deaths.find((death) => death.playerId === player.playerId);
      const roleLine = record?.hidden ? 'Le corps est méconnaissable.' : bodyReads(state, player);
      announcements.push({
        text: `${player.name} a été retrouvé mort — ${record?.cause ?? 'sans explication'}. ${roleLine}`,
        reveals: true
      });
      if (player.lastWill && !record?.hidden) {
        // A will is a claim about roles; on a shared screen it is a reveal too.
        announcements.push({ text: `Dernières volontés de ${player.name} : « ${player.lastWill} »`, reveals: true });
      }
    }
  }
  if (announcements.length === 0) {
    announcements.push({ text: 'Personne n’est mort cette nuit. La ville respire — pour l’instant.' });
  }

  // A widowed executioner grieves into motley.
  for (const player of players) {
    if (player.role === 'executioner' && player.alive && player.obsessionId && !state.players[player.obsessionId]?.alive) {
      player.role = 'jester';
      player.obsessionId = null;
      notify(player, 'Votre obsession est morte sans corde. Le deuil vous rend fou : vous êtes désormais le Bouffon.');
    }
  }

  // The spy's ear: which doors the families chose tonight.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'spy') continue;
    for (const [familyId, targetId] of familyKillTargets) {
      const target = state.players[targetId];
      if (!target) continue;
      notify(player, `${familyId === 'mafia' ? 'La Mafia' : 'La Triade'} a visé la maison ${target.slot} cette nuit.`);
      player.intel.push({ night: state.day, kind: 'spied', targetSlot: target.slot, value: familyId });
    }
  }

  /**
   * Now the findings — the town as it stood tonight, deaths included.
   *
   * The journeys themselves were declared far above, in the movement pass, so by
   * the time anything here reads `visits` it is complete: a lookout sees the
   * other investigators who called at the house, which is the point. What this
   * pass adds is the `diedTonight` filter — an investigator shot on somebody's
   * porch went out, and everyone watching saw him go, but he does not live to
   * report what he found.
   */
  const investigators = players.filter((player) => {
    if (!player.alive || blocked.has(player.playerId) || diedTonight.has(player.playerId)) return false;
    const action = actionOf(player);
    if (!action?.targetId || !state.players[action.targetId]) return false;
    return INVESTIGATIVE.includes(action.type);
  });
  for (const player of investigators) {
    const action = actionOf(player)!;
    const target = state.players[action.targetId!];
    if (!target) continue;
    // A borrowed face fools every examiner.
    const shownRole = target.disguiseRole ?? target.role!;
    const shown = roleDef(shownRole);

    if (action.type === 'investigate') {
      const suspect =
        framed.has(target.playerId) ||
        !!shown.suspicious ||
        (familyOf(shownRole) !== null && !shown.detectionImmune);
      notify(player, `${target.name} ${suspect ? 'est SUSPECT' : 'n’a rien de suspect'}.`);
      player.intel.push({ night: state.day, kind: 'sheriff', targetSlot: target.slot, value: suspect ? 'suspect' : 'clear' });
    }
    if (action.type === 'examine') {
      if (player.role === 'consigliere' || player.role === 'administrator') {
        notify(player, `${target.name} est ${shown.name}.`);
        player.intel.push({ night: state.day, kind: 'role', targetSlot: target.slot, value: shownRole });
      } else {
        const line = framed.has(target.playerId) ? roleDef('framer').investigated : shown.investigated;
        notify(player, `${target.name} ${line}.`);
        player.intel.push({ night: state.day, kind: 'trade', targetSlot: target.slot, value: line });
      }
    }
    if (action.type === 'watch' || action.type === 'shadow') {
      const seenPlayers = [
        ...new Set(
          visits
            .filter((entry) => entry.targetId === target.playerId && entry.visitorId !== player.playerId)
            .map((entry) => state.players[entry.visitorId])
            .filter((visitor): visitor is MafiaPlayer => !!visitor)
        )
      ];
      notify(
        player,
        seenPlayers.length > 0
          ? `Chez ${target.name} cette nuit : ${seenPlayers.map((v) => v.name).join(', ')}.`
          : `Personne n’a rendu visite à ${target.name} cette nuit.`
      );
      player.intel.push({
        night: state.day,
        kind: 'visitors',
        targetSlot: target.slot,
        value: seenPlayers.map((v) => String(v.slot)).join(','),
        slots: seenPlayers.map((v) => v.slot)
      });
    }
    if (action.type === 'track' || action.type === 'shadow') {
      const wentTo = [
        ...new Set(
          visits
            .filter((entry) => entry.visitorId === target.playerId)
            .map((entry) => state.players[entry.targetId])
            .filter((house): house is MafiaPlayer => !!house)
        )
      ];
      notify(
        player,
        wentTo.length > 0
          ? `${target.name} est sorti cette nuit : vu chez ${wentTo.map((v) => v.name).join(', ')}.`
          : `${target.name} n’a pas quitté sa maison cette nuit.`
      );
      player.intel.push({
        night: state.day,
        kind: 'tracked',
        targetSlot: target.slot,
        value: wentTo.map((v) => String(v.slot)).join(','),
        slots: wentTo.map((v) => v.slot)
      });
    }
    if (action.type === 'autopsy' && !target.alive) {
      notify(player, `Sous votre scalpel, ${target.name} livre son secret : c'était ${roleDef(target.role!).name}.`);
      player.intel.push({ night: state.day, kind: 'role', targetSlot: target.slot, value: target.role! });
    }
  }

  // Conversions, initiations and paperwork — after the blood has dried.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action?.targetId) continue;
    const target = state.players[action.targetId];
    if (!target) continue;

    if (action.type === 'recruit' && player.role === 'mason-leader' && target.alive) {
      visit(player.playerId, target.playerId);
      if (target.role === 'citizen') {
        target.role = 'mason';
        notify(target, 'On vous a initié à la loge. Vos frères vous connaissent désormais.');
        notify(player, `${target.name} a rejoint la loge.`);
      } else {
        notify(player, `${target.name} a décliné l’initiation.`);
      }
    }

    if (action.type === 'convert' && player.role === 'cultist' && target.alive) {
      visit(player.playerId, target.playerId);
      if (target.role && roleDef(target.role).faction === 'town') {
        const converted: RoleId = target.role === 'doctor' ? 'witch-doctor' : 'cultist';
        target.role = converted;
        target.charges = roleDef(converted).charges ?? 0;
        player.cooldownUntilDay = state.day + 2;
        notify(target, 'Des voix dans la nuit… et soudain tout est clair. Vous appartenez à la Secte.');
        notify(player, `${target.name} a rejoint la Secte.`);
        announcements.push({ text: 'Des cantiques étranges ont résonné cette nuit. La Secte grandit…', reveals: true });
      } else {
        notify(player, `${target.name} a résisté à l’appel.`);
      }
    }

    if (action.type === 'remember' && player.role === 'amnesiac' && !target.alive && target.role) {
      const remembered = target.role;
      player.role = remembered;
      player.charges = roleDef(remembered).charges ?? 0;
      notify(player, `Tout vous revient : vous êtes ${roleDef(remembered).name}.`);
      announcements.push({
        text: `L'Amnésique s'est souvenu : il était ${roleDef(remembered).name}, comme ${target.name}.`,
        reveals: true
      });
    }

    if (action.type === 'audit' && player.role === 'auditor' && target.alive && player.charges > 0) {
      visit(player.playerId, target.playerId);
      const targetDef = roleDef(target.role!);
      let audited: RoleId | null = null;
      if (targetDef.faction === 'town') audited = 'citizen';
      else if (targetDef.faction === 'mafia' && targetDef.familyRank !== 'leader') audited = 'mafioso';
      else if (targetDef.faction === 'triad' && targetDef.familyRank !== 'leader') audited = 'enforcer';
      else if (targetDef.faction === 'neutral' && !targetDef.soloKiller && target.role !== 'auditor') audited = 'scumbag';
      if (audited && audited !== target.role) {
        player.charges -= 1;
        target.role = audited;
        target.charges = roleDef(audited).charges ?? 0;
        notify(target, `Un contrôle implacable : vos papiers, vos outils, votre vie d'avant — saisis. Vous êtes ${roleDef(audited).name}.`);
        notify(player, `${target.name} a été réduit à néant administratif.`);
      } else {
        notify(player, `${target.name} est inattaquable sur le papier.`);
      }
    }
  }

  state.jailedId = null;
  state.nightActions = {};
  return announcements;
}

/* ------------------------------- endings -------------------------------- */

const FAMILY_WIN: Record<FamilyId, { reason: string; headline: string }> = {
  mafia: { reason: 'Victoire de la Mafia', headline: 'La famille contrôle la ville. La Mafia l’emporte !' },
  triad: { reason: 'Victoire de la Triade', headline: 'Le Dragon déploie ses anneaux. La Triade l’emporte !' },
  cult: { reason: 'Victoire de la Secte', headline: 'Les cantiques couvrent tout. La Secte l’emporte !' }
};

const SOLO_WIN: Partial<Record<RoleId, { reason: string; headline: string }>> = {
  'serial-killer': {
    reason: 'Dernier tueur debout',
    headline: 'Plus personne ne répond à l’appel… sauf un. Le Tueur en série l’emporte.'
  },
  arsonist: { reason: 'Dernière flamme debout', headline: 'La ville n’est plus que cendres. L’Incendiaire l’emporte.' },
  'mass-murderer': { reason: 'Dernier massacre debout', headline: 'Le silence est total. Le Tueur de masse l’emporte.' },
  poisoner: {
    reason: 'Dernière fiole debout',
    headline: 'Tout le monde avait bu quelque chose, un jour. L’Empoisonneur l’emporte.'
  },
  electromaniac: { reason: 'Dernier courant debout', headline: 'La ville grésille encore. L’Électromane l’emporte.' }
};

function endGame(state: MafiaState, now: number, headline: string): void {
  state.phase = 'ended';
  state.stage = null;
  state.trial = null;
  state.phaseEndsAt = null;

  const townWon = state.winners.some((winner) => winner.reason === 'Victoire de la Ville');
  const lovers = new Set<string>();
  for (const player of Object.values(state.players)) {
    if (player.alive) addPoints(state, player.playerId, 'survive');
    if (player.alive && player.role === 'survivor') {
      state.winners.push({ playerId: player.playerId, reason: 'A survécu jusqu’au bout' });
      addPoints(state, player.playerId, 'solo-win');
    }
    // Misfortune's parasites: alive while the town failed is a win.
    if (
      player.alive &&
      (player.role === 'witch' || player.role === 'scumbag' || player.role === 'judge' || player.role === 'auditor') &&
      !townWon
    ) {
      state.winners.push({ playerId: player.playerId, reason: 'A prospéré dans le malheur' });
      addPoints(state, player.playerId, 'solo-win');
    }
    // Lovers win together, whoever else won.
    if (
      player.alive &&
      player.bondKind === 'lover' &&
      player.bondPartnerId &&
      state.players[player.bondPartnerId]?.alive &&
      !lovers.has(player.playerId)
    ) {
      lovers.add(player.playerId);
      lovers.add(player.bondPartnerId);
      state.winners.push({ playerId: player.playerId, reason: 'L’amour a survécu à la ville' });
      state.winners.push({ playerId: player.bondPartnerId, reason: 'L’amour a survécu à la ville' });
      addPoints(state, player.playerId, 'solo-win');
      addPoints(state, player.bondPartnerId, 'solo-win');
    }
    if (!player.isBot) addPoints(state, player.playerId, 'participation');
  }

  announce(state, headline, now);
  const roster = Object.values(state.players)
    .sort((a, b) => a.slot - b.slot)
    .map((player) => `${player.slot}. ${player.name} — ${roleDef(player.role!).name}`)
    .join(' · ');
  announceReveal(state, `Les masques tombent : ${roster}`, now);
}

/** True when the game just ended; the caller stops scheduling. */
export function checkVictory(state: MafiaState, now: number): boolean {
  if (state.phase === 'ended') return true;
  const alive = alivePlayers(state);
  const families: FamilyId[] = ['mafia', 'triad', 'cult'];
  const byFamily = new Map<FamilyId, MafiaPlayer[]>(
    families.map((familyId) => [familyId, alive.filter((player) => playerFamily(player) === familyId)])
  );
  const soloKillers = alive.filter((player) => player.role !== null && isSoloKiller(player.role));

  const crownFamily = (familyId: FamilyId): void => {
    const win = FAMILY_WIN[familyId];
    for (const player of Object.values(state.players)) {
      if (player.role && familyOf(player.role) === familyId) {
        state.winners.push({ playerId: player.playerId, reason: win.reason });
        addPoints(state, player.playerId, 'win');
      }
    }
    endGame(state, now, win.headline);
  };

  const familiesAlive = families.filter((familyId) => (byFamily.get(familyId)?.length ?? 0) > 0);

  // The town wins when every family and every lone killer is in the ground.
  if (familiesAlive.length === 0 && soloKillers.length === 0) {
    for (const player of Object.values(state.players)) {
      if (player.role && roleDef(player.role).faction === 'town') {
        state.winners.push({ playerId: player.playerId, reason: 'Victoire de la Ville' });
        addPoints(state, player.playerId, 'win');
      }
    }
    endGame(state, now, 'La ville est purgée. La Ville l’emporte !');
    return true;
  }

  // A lone killer wins once nothing that could stop him still breathes.
  if (familiesAlive.length === 0 && soloKillers.length > 0) {
    const kinds = new Set(soloKillers.map((player) => player.role));
    const threats = alive.filter((player) => !soloKillers.includes(player) && !BYSTANDER_ROLES.has(player.role!));
    if (kinds.size === 1 && threats.length === 0) {
      const win = SOLO_WIN[soloKillers[0].role!] ?? SOLO_WIN['serial-killer']!;
      for (const player of soloKillers) {
        state.winners.push({ playerId: player.playerId, reason: win.reason });
        addPoints(state, player.playerId, 'solo-win');
      }
      endGame(state, now, win.headline);
      return true;
    }
    return false;
  }

  // A family wins at parity, once its rivals and the lone killers are gone.
  if (familiesAlive.length === 1 && soloKillers.length === 0) {
    const familyId = familiesAlive[0];
    const members = byFamily.get(familyId)!;
    const rest = alive.filter((player) => playerFamily(player) !== familyId);
    if (members.length >= rest.length) {
      crownFamily(familyId);
      return true;
    }
  }
  return false;
}
