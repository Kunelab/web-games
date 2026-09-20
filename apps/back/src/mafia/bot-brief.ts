import {
  ACTION,
  FACTION,
  SLOT,
  beliefs,
  contradicted,
  deductions,
  soloEndgame,
  townClock,
  provenLiar,
  rank,
  trustOf,
  type Deduction,
  type MafiaPlayer,
  type MafiaView,
  type PublicInfo,
  type RoleId
} from 'mafia-core';
import type { Locale } from 'i18n';
import type { BotMind } from './bot-mind.js';
import { screen } from './guard.js';
import { say } from './say.js';

/**
 * What a bot is told before it decides anything.
 *
 * Two shapes, for the two tempos, and the difference is not cosmetic. The fast
 * table needs a briefing a small model can read in one glance and answer in one
 * line — twenty-three of them are waiting and the day is ninety seconds long — so
 * `brief` is a *conclusion*, pre-chewed: who is hot, who got caught, what one
 * thing is worth saying. The slow table can afford the whole file, so `dossier`
 * hands over the board and lets the model do the reasoning itself.
 *
 * Both are built only from the bot's own `MafiaView` and the shared public board.
 * Neither can name a living player's role, because neither is ever given one.
 */
/* ------------------------------- the stance ------------------------------- */

/**
 * The sentence that tells a model who it is being right now.
 *
 * This is where the deterministic social model reaches the LLM. The numbers are
 * not shown — a model handed "falseAccuse: 0.62" writes like a spreadsheet — so
 * each appetite becomes an instruction, and only the ones that are actually
 * strong are included. A calm townie gets two lines; a cornered mafioso gets six
 * and they are all about survival.
 */

const WIN_LINE: Partial<Record<RoleId, string>> = {
  survivor:
    'YOU WIN WITH ANYBODY, as long as you are alive at the end — town, mafia, a lone killer, it does not matter. ' +
    'That makes claiming Survivor a real choice with a cost on both sides: it tells the room you are no threat, which ' +
    'buys you safety, and it also makes you a free vote nobody will ever protect. Never be the most suspicious seat, ' +
    'and never be the most useful one either.',
  amnesiac:
    "You are nobody yet. You win by REMEMBERING a dead player's role and then winning as that role, so the graveyard " +
    'is your role list: stay alive, watch what dies, and take the badge that is worth the most to whoever is winning.',
  lover:
    'You and your partner win together, whoever else wins, as long as you are BOTH alive at the end. If one of you ' +
    "dies the other dies of grief, so your partner's safety is your own and protecting them is not sentiment.",
  cultist: 'You win when the cult outnumbers the rest. Converting is how you grow; every convert is another vote.',
  mayor:
    'Revealing makes your vote count THREE, and paints a target on you for every killer at the table. Reveal when ' +
    'three votes settle it, not before.',
  marshall:
    'Revealing turns the day into an assembly line: no defence, and several hangings in one afternoon. It is one use ' +
    'of enormous force and it works just as well on the town, so spend it on a day the room already agrees.',
  jailor:
    'The seat you jail cannot act, cannot be killed by anyone else, and can be executed by you. You have a few ' +
    'executions for the whole game; executing a townie costs you the rest of them.',
  veteran:
    'On alert you kill EVERY visitor, including the doctor trying to save you and the sheriff checking you. It is a ' +
    'trap, not armour: the town loses people on your porch.',
  vigilante:
    'You have a few bullets. Shooting a townie is worse than not shooting at all — it is a kill the mafia did not ' +
    'have to make.',
  crier:
    'You speak into the night ANONYMOUSLY, and the room never learns which seat it was. That is also your proof: if ' +
    'they are about to hang you, you can promise to name yourself in the dark tonight, and the next dawn settles it. ' +
    'It costs you the anonymity that keeps you alive, so it is a last card.',
  jester:
    'You WIN if the town HANGS you, and nothing else counts. Look like a liar, never like a jester: a room that ' +
    'suspects a jester simply stops voting.',
  executioner:
    'You win only if your target is HANGED BY THE TOWN. If they die at night instead you have lost, so keeping them ' +
    'alive at night matters as much as pushing them by day.',
  witch: 'You win whenever the town loses, whoever beats them. You need not kill anybody: you need the town to fail.',
  scumbag: 'You win whenever the town loses. Survive, and help the wrong side quietly.',
  judge: 'You win whenever the town loses. Your court is one use of enormous force — spend it where it does damage.',
  auditor:
    'You win whenever the town loses. Blend in; you are not trying to win the day, you are trying to lose it for them.'
};

/** The win condition this seat needs spelled out, if its role has one. */
function winLine(view: MafiaView): string | null {
  const role = view.me?.role?.id;
  return role ? (WIN_LINE[role] ?? null) : null;
}

export function stanceLine(mind: BotMind, view: MafiaView): string {
  const s = mind.stance;
  const orders: string[] = [];
  const strong = (value: number, threshold = 0.5) => value >= threshold;
  const mood =
    mind.brain.desperation >= 0.75
      ? 'You are CORNERED: it is decided now, so take risks.'
      : mind.brain.desperation >= 0.45
        ? 'You are under pressure: people are looking at you, act.'
        : 'You are safe for now: watch, and ask questions.';
  orders.push(mood);
  /**
   * The agenda line, unless the role has already been handed a better one.
   *
   * These two blocks say the same thing at two levels of detail: the agenda
   * speaks for a *kind* of seat and `WIN_LINE` for the role itself. When both
   * fire the briefing states one fact twice, and on a Survivor it was worse
   * than that — the header says "Survivor, Neutral side", the role card in
   * `You know` says it wins by seeing the end, the agenda says "You win by
   * staying alive", and the win line says "YOU WIN WITH ANYBODY, as long as you
   * are alive at the end", which is ninety tokens of one sentence said four
   * ways on every turn that seat takes all game.
   *
   * The specific one wins, because it is the one written for the role. The
   * agenda stays for every seat that has no win line of its own, which is most
   * of the town.
   */
  const named = winLine(view) !== null;
  if (named) {
    /** The role's own line covers it. See `WIN_LINE`. */
  } else
    switch (mind.agenda) {
    case 'town':
      orders.push('Your side wins when the killers hang. Truth serves you — not to the point of dying for it.');
      break;
    case 'family':
      orders.push(
        'You must pass for a villager. Agree with the room on whatever costs nothing: credibility is spent late and earned early.'
      );
      break;
    case 'butcher':
      orders.push('You are alone. You have no allies to cover: your weapons are noise and doubt.');
      break;
    case 'jester':
      orders.push(
        'You WIN if the town HANGS you. Nobody must guess that is your goal. Claim a big, checkable role, contradict yourself, accuse at random: look like a liar, never like a jester.'
      );
      break;
    case 'executioner':
      orders.push(`You win if house ${view.me?.obsessionSlot ?? '?'} is hanged. Nothing else matters to you.`);
      break;
    case 'parasite':
      orders.push('You thrive on misfortune: a town that fails is a town you beat. Keep the chaos going.');
      break;
    case 'passenger':
      orders.push('You win by staying alive. Be useful, be liked, never be the most suspicious.');
      break;
  }
  const win = winLine(view);
  if (win) orders.push(win);
  if (strong(s.seekInfo, 0.45)) {
    orders.push('ASK somebody what they did last night, and remember the answer.');
  }
  if (s.answerHonestly < 0.4) {
    orders.push('If asked about your night, LIE or dodge — say you never left home.');
  }
  if (strong(s.falseAccuse, 0.45)) {
    orders.push('Accuse somebody even without proof, preferably where suspicion already points.');
  }
  if (strong(s.fakeClaim, 0.4)) {
    orders.push('You may claim a role that is not yours in order to protect yourself.');
  }
  if (strong(s.jesterGambit, 0.35) && mind.agenda !== 'jester') {
    orders.push('Last resort: claim to be the JESTER — nobody dares hang a jester.');
  }
  if (strong(s.sacrificeAlly, 0.4)) {
    orders.push('One of your own is in danger: do not defend them. Dropping them buys you the room’s trust.');
  }
  if (strong(s.troll, 0.5)) {
    orders.push('You may needle, provoke, show off — one line, not a routine.');
  }
  if (strong(s.buildTrust, 0.5)) {
    orders.push('Vote with the room when you agree: you are building a reputation for later.');
  }
  if (strong(s.pushHard, 0.6)) {
    orders.push('Push the pace: get somebody hanged today.');
  }
  return orders.join('\n');
}

/* -------------------------------- the brief ------------------------------- */

/**
 * The two things a bot has to be *told*, because the board does not show them.
 *
 * A question aimed at you is the engine of the day phase, and it was invisible:
 * the deterministic policies check for one and answer it, but the LLM was never
 * informed — so a table of bots interrogated each other for six straight days
 * and nobody ever accounted for anything. The loop was half-built.
 *
 * The vote threshold is the same omission. A model that does not know how many
 * voices hang somebody cannot judge whether pushing is worth it, so it never
 * pushes and the day simply expires. Both belong in every briefing.
 */
function pressure(view: MafiaView, board: PublicInfo): string[] {
  const me = view.me!;
  const lines: string[] = [];

  const asked = board.claims.filter(
    (claim) =>
      claim.kind === 'question' &&
      claim.targetSlot === me.slot &&
      // Already answered? Then it is settled, and repeating it is noise.
      !board.claims.some(
        (answer) => answer.kind === 'account' && answer.claimerSlot === me.slot && answer.day >= claim.day
      )
  );
  if (asked.length > 0) {
    const who = [...new Set(asked.map((claim) => claim.claimerSlot))].join(', ');
    lines.push(
      `YOU ARE BEING ASKED TO ACCOUNT FOR YOURSELF (house ${who}): say where you were last night. ` +
        'Set claim = account-home if you claim you never left, or account-visited + claimSlot if you admit a visit.'
    );
  }

  const alive = view.players.filter((player) => player.alive).length;
  const needed = Math.floor(alive / 2) + 1;
  const leader = view.players.filter((player) => player.alive).sort((a, b) => b.votesAgainst - a.votesAgainst)[0];
  /**
   * Said once, here, because this is where the live count is.
   *
   * `legalMoves` used to print the same bar and the same "nobody is targeted
   * yet" a few lines earlier. The procedure that used to ride along with it —
   * what a trial actually is — is kept on the branch where a model needs it,
   * which is the one where no wagon exists yet and it is deciding whether to
   * start one.
   */
  lines.push(
    leader && leader.votesAgainst > 0
      ? `It takes ${needed} votes to start a trial. ${leader.slot}. ${leader.name} has ${leader.votesAgainst} — ${needed - leader.votesAgainst} more and they are on trial.`
      : `It takes ${needed} votes to put somebody on the stand, where they defend themselves and the room votes guilty or innocent. Nobody is targeted yet.`
  );

  /**
   * Naming the vote, not merely offering it.
   *
   * Bots that interrogate beautifully and never vote produce a game that cannot
   * end: measured, six days of sharp questioning with zero trials, because
   * "you may vote" is an option and a model with an option takes the quiet one.
   * When the record has actually caught somebody, that stops being a suggestion
   * — there is a named house, a reason, and an instruction.
   */
  const caught = board.aliveSlots.filter((slot) => slot !== me.slot && contradicted(slot, board));
  if (caught.length > 0) {
    const names = caught
      .map((slot) => view.players.find((player) => player.slot === slot))
      .map((player) => (player ? `${player.slot}. ${player.name}` : ''))
      .filter(Boolean)
      .join(', ');
    lines.push(`CAUGHT IN A LIE: ${names}. Say so and VOTE — set targetSlot to their house number.`);
  } else if (view.day >= 3 && (!leader || leader.votesAgainst === 0)) {
    lines.push(
      'Three days and nobody has been put on trial. A town that never hangs anybody loses. Pick your best suspect and vote (targetSlot).'
    );
  }
  return lines;
}

/** One line per seat that matters, and nothing about the ones that do not. */

function heatmap(view: MafiaView, board: PublicInfo, limit: number): string[] {
  const caught = new Set(board.aliveSlots.filter((slot) => contradicted(slot, board)));

  /**
   * The order, taken from the ranking rather than invented here.
   *
   * This used to sort by `notes.length + votesAgainst` — by *how many kinds of
   * remark a seat had attracted* — so a seat caught in a flat contradiction and
   * nothing else ranked below a seat with three harmless notes, and the model
   * was handed the least interesting people first. `rank` answers the question
   * the sort was trying to ask, it answers it with a fitted likelihood ratio per
   * piece of evidence, and its ordering is measured: the seats it puts at the
   * top are killers nine times in ten.
   *
   * The probability itself is deliberately not printed. It is well calibrated
   * at the top and worthless at the bottom (see `rank`), so a number next to
   * every name would be four-fifths noise dressed as precision, and a model
   * handed "0.34" will reason about the 0.34. The order carries the signal and
   * the notes carry the argument.
   */
  const standing = rank(board);
  const place = new Map(standing.map((suspect, index) => [suspect.slot, index]));
  const worst = standing.filter((suspect) => suspect.against.length > 0).slice(0, 3);
  const flagged = new Set(worst.map((suspect) => suspect.slot));

  const rows = view.players
    .filter((player) => player.alive)
    .map((player) => {
      const notes: string[] = [];
      if (player.votesAgainst > 0) notes.push(`${player.votesAgainst} votes`);
      if (caught.has(player.slot)) notes.push('CAUGHT LYING');

      /**
       * What the record itself contradicts, which the model could not see.
       *
       * `deductions` has moved the voting since the day it was written and
       * reached the briefing through nothing at all: a bot could *cite* one
       * when it accused, and a model being asked to decide a turn was never
       * told that house 3 claimed to be poisoned on night 1 and is still
       * standing. The one kind of evidence on this board that needs no witness
       * and can be checked by anybody, missing from the sheet.
       */
      for (const finding of deductions(player.slot, board).slice(0, 2)) notes.push(caughtBy(finding));

      const trust = trustOf(player.slot, board);
      if (trust >= 2) notes.push('has hanged killers before');
      else if (trust <= -2) notes.push('tried to save killers');
      const roleClaim = board.claims.find(
        (claim) => claim.kind === 'role-claim' && claim.claimerSlot === player.slot && claim.claimedRole
      );
      if (roleClaim) notes.push(`claims to be ${roleClaim.claimedRole}`);
      const account = board.claims.find((claim) => claim.kind === 'account' && claim.claimerSlot === player.slot);
      if (account)
        notes.push(
          account.account === 'home' ? 'says they never left home' : `says they went to ${account.targetSlot}`
        );
      if (player.revealedMayor) notes.push('revealed Mayor');

      /**
       * A voice the record has written off, which stopped being sayable.
       *
       * The test was `claimerWeight === 0`, and a floor of 0.2 was put under
       * living seats on the day the trust meter stopped being a cliff — so this
       * has printed for nobody since, silently. `provenLiar` is what the phrase
       * was always reaching for: vouching for a revealed killer, or being one.
       */
      if (provenLiar(player.slot, board)) notes.push('proven liar');

      return { slot: player.slot, name: player.name, notes, order: place.get(player.slot) ?? 99 };
    })
    .filter((row) => row.notes.length > 0)
    .sort((a, b) => a.order - b.order)
    .slice(0, limit);

  return rows.map((row) => {
    const lead = flagged.has(row.slot) ? ' [WORTH A LOOK]' : '';
    return `${row.slot}. ${row.name}${lead} — ${row.notes.join(', ')}`;
  });
}

/**
 * One deduction as a phrase for the sheet, not as a line of dialogue.
 *
 * The catalogue already holds twenty-seven ways of *saying* each of these; what
 * a briefing wants is the flattest possible statement of the fact, in English,
 * because the model is reasoning with it rather than repeating it.
 */
function caughtBy(finding: Deduction): string {
  switch (finding.kind) {
    case 'poison-survived':
      return `said poisoned on night ${finding.night} and is still alive`;
    case 'visited-a-corpse':
      return `claims a visit to ${finding.otherSlot} on night ${finding.night}, who was already dead`;
    case 'guarded-nobody-died':
      return `claims a bodyguard died for them on night ${finding.night}, when nobody died`;
    case 'two-in-one-cell':
      return `both they and ${finding.otherSlot} claim the cell on night ${finding.night}`;
    case 'acted-from-the-cell':
      return `claims the cell on night ${finding.night} and a visit the same night`;
    case 'impossible-ailment':
      return `claims a ${finding.ailment} nobody left alive could have done`;
    case 'role-not-in-play':
      return `claims ${finding.role}, which this game never dealt`;
    case 'no-slot-left':
      return `claims ${finding.role}, and every slot that could have been one is already in the graveyard`;
    case 'no-room-for-all':
      return `claims ${finding.role}, and so does ${finding.others.join(' and ')}, and the roster has room for fewer`;
    case 'relay-denied':
      return `quoted ${finding.otherSlot}, who denies saying it`;
    case 'broken-promise':
      return `promised proof on night ${finding.night} and gave none`;
    default:
      return 'contradicted by the record';
  }
}

/**
 * The table's role list, in the reader's language.
 *
 * `roleList` is `SlotToken`s, which are either a role or a category ("random
 * town"), and both are things a player can see on their own screen — so both
 * belong in a briefing. Counted rather than repeated, because "Mafioso ×3" is
 * the shape of the game and "Mafioso, Mafioso, Mafioso" is three lines of
 * nothing.
 */
function rolesInPlay(view: MafiaView, locale: Locale): string {
  if (view.roleList.length === 0) return '';
  const counts = new Map<string, number>();
  for (const token of view.roleList) {
    const label = say(locale)(SLOT(token));
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} x${count}` : label)).join(', ');
}

/**
 * The counting, which the model was never shown.
 *
 * The briefing handed over an ordering and no reason: `rank` decides who sits
 * at the top of the heatmap, and nothing anywhere said *why*, so a model asked
 * to decide a turn was reasoning about names in a list. Meanwhile the seat's own
 * brain was holding the two pieces of arithmetic a person at that table would
 * actually open their mouth about — how close the killers are to the numbers,
 * and which seats could have made a night's attack once the impossible ones are
 * crossed off.
 *
 * Both are checkable by anybody in the room, both are sentences rather than
 * numbers, and both cost about fifteen tokens. That is the difference between a
 * bot that says "vote 7" and one that says "of the four who could have killed 9
 * on night three, three are cleared and only 7 is left", which is the whole of
 * what the town is for.
 *
 * `beliefs` already carries the reason codes and the nights; this turns the two
 * that are arithmetic into English and leaves the rest of the read alone.
 */
function arithmetic(view: MafiaView, board: PublicInfo, self: MafiaPlayer): string | null {
  if (!view.me?.alive) return null;
  const lines: string[] = [];

  /**
   * The clock, said out loud as a quantity.
   *
   * It has always been the town's sense of how much time it has and it reached
   * the model as nothing at all, so a bot on the last afternoon before parity
   * argued exactly as it had on day two. Then it reached the model as a mood,
   * in two fixed sentences, and a mood is not something a player can reason
   * with: "the killers are close to parity" is true on half the afternoons of
   * every game and tells a model nothing it can act on.
   *
   * What a person says is a number. We can afford one more mistake. Hanging the
   * wrong man today loses it and going home does not. Those are sentences with
   * arithmetic behind them, they are the same arithmetic the played brain is
   * using to decide, and they are available from the second morning because the
   * roster is on the wall. See `townClock`.
   */
  /**
   * Three lines, one of which is ever printed, and none of them longer than the
   * mood they replace.
   *
   * The briefing is a budget (see `budget.ts`): every token here is one the next
   * seat does not get to spend on thinking. So the arithmetic is said the way a
   * person says it at a table, which happens also to be the short way, and the
   * bell line carries the skip arithmetic rather than adding a fourth section
   * for it.
   */
  const clock = townClock(board);
  if (soloEndgame(board)) {
    /**
     * A different game, and the one place the advice above would be wrong.
     *
     * Against a family the town is racing a head count, so a quiet day is a
     * cheap day. Against a lone knife there is no head count to lose: nobody
     * wins by standing level with the last villager, so every quiet day is a
     * free kill and the only move that ever helps is finding them.
     */
    lines.push(
      'THE CLOCK: whoever is left kills alone and wins by outliving everybody. Going home quietly is a free kill for ' +
        'them. Somebody has to hang.'
    );
  } else if (clock.blades > 0 && clock.mislynches === 0) {
    lines.push(
      'THE CLOCK: no wrong ropes left. Hanging a townsperson today loses it tonight; hanging nobody costs half that. ' +
        'Be sure, or say you are not.'
    );
  } else if (clock.mislynches === 1) {
    lines.push('THE CLOCK: one wrong rope left. Do not vote somebody just because the room is.');
  } else if (clock.mislynches === 2) {
    lines.push('THE CLOCK: two wrong ropes left before they have the numbers.');
  }

  /** And the night's own arithmetic, which nobody can talk their way out of. */
  const NARROWED = new Set(['only-one-left', 'one-of-two', 'one-of-few']);
  const read = [...beliefs(self, board).values()];
  const counted = read
    .filter((belief) => belief.because.some((why) => NARROWED.has(why.code)))
    .sort((left, right) => right.odds - left.odds)
    .slice(0, 2);

  for (const belief of counted) {
    const who = view.players.find((player) => player.slot === belief.slot);
    const why = belief.because.find((entry) => NARROWED.has(entry.code));
    if (!who || !why) continue;
    if (why.code === 'only-one-left') {
      lines.push(
        `THE COUNTING: of everybody who could have made the attack on night ${why.night}, only ${belief.slot}. ${who.name} is left. Say so, and say how you know.`
      );
    } else if (why.code === 'one-of-two') {
      lines.push(
        `THE COUNTING: after night ${why.night} it is ${belief.slot}. ${who.name} or house ${why.other}, and nobody else. Say so.`
      );
    }
  }

  /**
   * The shortlist, when it is a shortlist rather than a name.
   *
   * Said once for the whole list rather than once per seat, because that is
   * what it is: one deduction about several houses. It carries no score (see
   * `worth` in `beliefs.ts` for why the bench refused to price it) and it is
   * still the most useful sentence a seat can say on a middle afternoon, since
   * it tells the room where *not* to spend the day.
   */
  if (!counted.some((belief) => belief.because.some((why) => why.code !== 'one-of-few'))) {
    const few = read.find((belief) => belief.because.some((why) => why.code === 'one-of-few'));
    const why = few?.because.find((entry) => entry.code === 'one-of-few');
    if (why?.code === 'one-of-few') {
      const shortlist = read
        .filter((belief) =>
          belief.because.some((entry) => entry.code === 'one-of-few' && entry.count === why.count)
        )
        .map((belief) => `${belief.slot}. ${view.players.find((player) => player.slot === belief.slot)?.name ?? ''}`);
      lines.push(
        `THE COUNTING: night ${why.night} was one of these ${why.count}: ${shortlist.join(', ')}. Nobody else could have. Say so.`
      );
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * The fast briefing: a conclusion, not a transcript.
 *
 * Deliberately short. A 4B model given a wall of chat answers about the wall of
 * chat; given three facts and an instruction it answers about the game. The
 * chat is trimmed to the last handful of *human-authored* lines, because those
 * are the ones a bot is expected to react to.
 */
export function brief(
  view: MafiaView,
  board: PublicInfo,
  mind: BotMind,
  task: string,
  locale: Locale,
  /**
   * This seat as the engine holds it, for the one piece of reasoning only it can
   * do.
   *
   * `beliefs` reads a seat's own intel and its own rescued night, and neither
   * survives the projection into a view. Optional, so a caller holding only a
   * board still gets a briefing, one section shorter.
   */
  self?: MafiaPlayer
): string {
  const me = view.me!;
  const lines: string[] = [];
  lines.push(
    `Day ${view.day}, ${view.phase === 'night' ? 'NIGHT' : 'DAY'}${view.stage ? ` (${view.stage})` : ''}. ${view.players.filter((p) => p.alive).length} alive.`
  );
  if (me.role)
    lines.push(
      `You: ${say(locale)(me.role.name)}, ${say(locale)(FACTION(me.role.faction))} side${me.charges !== null ? `, ${me.charges} use(s) left` : ''}.`
    );
  if (me.teammates && me.teammates.length > 0) {
    lines.push(`With you: ${me.teammates.map((mate) => `${mate.slot} ${mate.name}`).join(', ')}.`);
  }

  /**
   * The roles that were dealt, which is public information and was missing.
   *
   * Without it a model bluffs whatever role it has heard of — a Veteran at a
   * table with no Veteran in it, which is a claim the whole square can dismiss
   * in one line and which makes the bot look like software rather than a liar.
   * A bluff is only a bluff if it could have been true. The list is already on
   * every player's screen, top right; this is the same list.
   */
  const dealt = rolesInPlay(view, locale);
  if (dealt) lines.push(`Roles dealt in this game — nothing else exists here: ${dealt}`);
  /**
   * How much room the transcript gets, and why it is not a constant.
   *
   * The summary is a crutch. It is the right crutch for a table of twenty-three
   * bots trading formulaic accusations at speed — but the moment a *person* is at
   * the table, the interesting content is what they actually typed, and a
   * heatmap saying "3 voix" is a poor substitute for reading their defence. A
   * human's claim deserves to be weighed on its words; a bot's rarely has any
   * beyond what the ledger already captured.
   *
   * So the window scales with human presence, and past a couple of people the
   * summary shrinks to make room rather than competing for it.
   */
  const humans = view.players.filter((player) => player.alive && !player.isBot).length;
  const window = humans === 0 ? 6 : humans <= 2 ? 16 : 26;
  const hotRows = humans >= 2 ? 3 : 5;

  const sums = self ? arithmetic(view, board, self) : null;
  if (sums) lines.push(sums);

  const hot = heatmap(view, board, hotRows);
  if (hot.length > 0) lines.push(`What matters:\n${hot.join('\n')}`);
  else lines.push('Nobody stands out yet.');
  const news = me.notifications.slice(-2).map((note) => say(locale)(note));
  if (news.length > 0) lines.push(`You know: ${news.join(' / ')}`);
  if (view.trial) lines.push(`ON TRIAL: ${view.trial.slot}. ${view.trial.name}.`);

  /**
   * What the town was told this morning.
   *
   * The most important two sentences of any day — who died and what they turned
   * out to be — and they were missing from the fast briefing entirely, because
   * they arrive as announcements rather than as anybody's speech. A bot reasoning
   * from the roster alone knows *that* a seat is dead and not what killed it.
   */
  const dawn = view.chat
    .filter((message) => message.msg && message.reveals)
    .slice(-3)
    .map((message) => say(locale)(message.msg!));
  if (dawn.length > 0) lines.push(`This morning:\n${dawn.join('\n')}`);

  lines.push(legalMoves(view));
  lines.push(transcript(view, window, humans > 0));
  lines.push(...pressure(view, board));
  lines.push(stanceLine(mind, view));
  lines.push(task);
  return lines.join('\n');
}

/**
 * The last stretch of conversation, with the people marked as people.
 *
 * Two deliberate choices. Human lines are labelled, because a model told which
 * voices are human weighs them differently — and it should: those are the claims
 * that were reasoned rather than sampled. And an accused player's own defence is
 * always carried in full even if it falls outside the window, because the one
 * moment a table is genuinely reading each other is the two minutes somebody
 * spends arguing for their life.
 */
/**
 * The most a briefing will ever spend on what was said, and on any one line.
 *
 * Roughly five hundred tokens and forty-five words. Both are ceilings rather
 * than targets: an ordinary afternoon comes in well under them, and what they
 * exist for is the afternoon that does not.
 */
const TRANSCRIPT_CHARS = 2200;

/**
 * How many of a person's lines are carried back into the window when the bots
 * have talked over them. Small on purpose: see `transcript`.
 */
const HUMAN_FLOOR = 4;
/**
 * The chat itself refuses anything past four hundred characters, so this only
 * ever bites a *merged* run — somebody who typed three long messages in a row —
 * and a single message is never clipped. The total above is the real bound.
 */
const LINE_CHARS = 500;

/**
 * The moves that exist for this seat at this moment.
 *
 * The briefing told a bot its mood, its agenda, the board and the transcript,
 * and never once what it was allowed to *do*. That was survivable while the
 * model only chose words — the policy picked the move — and it is not
 * survivable now that the model is asked to decide, because a model that does
 * not know the rules invents them: it heals as a Sheriff, votes on day one,
 * targets a corpse, and the engine refuses all of it while the seat does
 * nothing at all.
 *
 * The engine already knows every answer here — `legalNightAction` computes the
 * legal targets, `voteThreshold` the majority, the stage the rest — so this is
 * not teaching the model the rulebook. It is handing it the one page that
 * applies. Which is also why it is cheap: fifty tokens about *this* seat beats
 * a thousand about all fifty-six roles, and it is right rather than
 * approximately remembered.
 */
function legalMoves(view: MafiaView): string {
  const me = view.me;
  if (!me?.alive) return 'You are dead. You may only talk in the graveyard; the living cannot hear you.';

  const lines: string[] = ['WHAT YOU MAY DO RIGHT NOW — these are the only legal moves; anything else is refused:'];

  if (view.phase === 'night') {
    if (me.jailed) {
      lines.push('- You are in the cell tonight. You have no power to use and the square cannot hear you.');
    } else if (me.action) {
      const targets = me.action.targets.length > 0 ? me.action.targets.join(', ') : 'yourself only';
      lines.push(`- Tonight your power is ${me.action.type}. Legal targets: ${targets}.`);
      if (me.action.secondTargets?.length) {
        lines.push(`- It needs a second house as well. Legal second targets: ${me.action.secondTargets.join(', ')}.`);
      }
      if (me.action.charges !== null)
        lines.push(`- You have ${me.action.charges} use(s) of it left, for the whole game.`);
    } else {
      lines.push('- You have no power to use tonight. You can only talk where you are allowed to talk.');
    }
    return lines.join('\n');
  }

  /**
   * The day, in the order it actually happens.
   *
   * A trial is two beats and a model that has not been told that treats the
   * defence as the verdict — it argues its case in the round where nobody is
   * listening yet, and says nothing in the round that decides.
   */
  if (view.stage === 'defense') {
    lines.push(
      view.trial?.slot === me.slot
        ? '- You are ON THE STAND. This is your defence and it is the last thing said before the vote. Nobody else may speak.'
        : `- House ${view.trial?.slot ?? '?'} is on the stand defending themselves. You listen; you do not speak.`
    );
    return lines.join('\n');
  }
  if (view.stage === 'judgement') {
    lines.push(
      view.trial?.slot === me.slot
        ? '- You are on trial and the room is voting guilty or innocent. The accused does not vote.'
        : `- Vote GUILTY or INNOCENT on house ${view.trial?.slot ?? '?'}. Guilty hangs them; a tie spares them.`
    );
    return lines.join('\n');
  }

  if (view.day <= 1) {
    lines.push('- There is NO VOTE on the first day. Nobody can be hanged today. All you can do is talk.');
    return lines.join('\n');
  }
  if (view.voteOpensAt !== null && Date.now() < view.voteOpensAt) {
    const wait = Math.ceil((view.voteOpensAt - Date.now()) / 1000);
    lines.push(
      `- The ballot is not open yet — about ${wait}s of talking left. You cannot accuse or skip until it opens.`
    );
  } else {
    lines.push(
      '- You may accuse one house, or vote to skip the day. Changing your mind is free until the count lands.'
    );
    /**
     * The bar, and who is nearest it, are `pressure`'s to say.
     *
     * Both sections printed both facts. Every day briefing carried "7 votes put
     * somebody on the stand. Nobody is targeted yet." here and "It takes 7
     * votes to start a trial. Nobody is targeted yet." forty tokens later —
     * the same two numbers, in the same words, on every turn of every day. What
     * belongs in this section is the *procedure*, because this section is the
     * list of legal moves; what belongs in `pressure` is the live count, and it
     * already carries how many more the wagon needs.
     */
    if (view.skipVotes > 0) lines.push(`- ${view.skipVotes} seat(s) want to skip the day.`);
  }
  return lines.join('\n');
}

/**
 * Which day or night each line was said on, read off the game's own headers.
 *
 * The transcript carried one bit of time — a line was from this phase or it was
 * not — and a model handed six lines with a single `[EARLIER]` between them
 * cannot tell last night's claim from the one four nights ago. That is most of
 * what "the bot answered something from ages ago" looks like from a chair: not
 * the bot replying to a dead greeting, which the filters now stop, but the bot
 * treating night 2's alibi and night 5's as the same fact.
 *
 * Derived rather than stored. `dayHeader` and `nightFall` are posted into the
 * square at every phase change and both carry their day number, so walking the
 * log in order gives every line its stamp without adding a field to
 * `ChatMessage` that every persisted table would then be missing.
 *
 * The map is keyed by message id because the tail is reordered and merged
 * before it is rendered.
 */
function stamps(chat: MafiaView['chat']): Map<number, string> {
  const at = new Map<number, string>();
  let label = 'day 1';
  for (const message of chat) {
    const key = message.msg?.k;
    /**
     * `D3` and `N3` rather than "day 3" and "night 3".
     *
     * Every line carries one, and six characters a line against a budget the
     * bench measures in tokens is the difference between fitting and not: the
     * long form put a fifteen-seat table with two people at it sixteen tokens
     * over. The legend goes in the transcript header, which is paid once per
     * request instead of once per line.
     */
    /**
     * A `MsgValue` is a string, a number, or another `Msg`, and only the first
     * two have a spelling. Interpolating the union put `[object Object]` one
     * bad parameter away from the transcript header every bot reads.
     */
    const day = message.msg?.p?.day;
    const which = typeof day === 'string' || typeof day === 'number' ? String(day) : '?';
    if (key === 'mafia.day.header') label = `D${which}`;
    else if (key === 'mafia.night.fall') label = `N${which}`;
    else at.set(message.id, label);
  }
  return at;
}

function transcript(view: MafiaView, window: number, humansPresent: boolean): string {
  // Authored lines only: the game's own announcements are already summarised
  // above, so this needs no renderer.
  const spoken = view.chat.filter((message) => message.authorId);
  const humanNames = new Set(view.players.filter((player) => !player.isBot).map((player) => player.name));

  /**
   * Where "earlier" stops being context and starts being a different game.
   *
   * The tail below deliberately keeps old lines and marks them — see the
   * `[EARLIER]` note further down, and the reason given there: an accusation
   * from yesterday is exactly the thing a defence has to answer, and the claims
   * board keeps only the *fact* of one, never the words.
   *
   * The two rescues are not that. Their whole job is to reach back *past* the
   * window and promote something into it, and neither had any bound at all, so
   * both promoted lines the marker would then have to apologise for. On a table
   * of fifteen talking bots and one quiet human, the human rescue meant the
   * same "hello" from day one was lifted into every briefing for the rest of
   * the game, under a header saying in capitals that what people said matters
   * more than the numbers. A line nobody has repeated since day one is not
   * being drowned out. It is over.
   *
   * `phaseStartedAt` is stamped at `beginDay` and `beginNight` only, never at a
   * stage change, so one window holds an afternoon's argument, the trial it
   * produced and the verdict — the unit a person would call "right now".
   */
  const since = view.phaseStartedAt ?? 0;
  const when = stamps(view.chat);
  const current = (message: { at: number }): boolean => message.at >= since;

  /**
   * A person's words keep their place in the window whatever the bots do.
   *
   * The window was the last N lines and nothing else, which on a table with
   * fifteen talking bots is a window onto the bots. A person types one sentence,
   * eleven seats answer it, and by the next turn the sentence itself has fallen
   * out of the briefing — while the header above it says, in capitals, that
   * what people said matters more than the numbers.
   *
   * So the tail is taken as before and then the most recent human lines are put
   * back if they fell out of it. Bounded, because the point is that a person is
   * not drowned out, not that a person may flood the prompt: past a handful the
   * rest is the same argument said again, and the character budget below still
   * has the last word.
   */
  const tail = spoken.slice(-window);
  const kept = new Set(tail);
  const rescued = spoken
    .filter((message) => humanNames.has(message.authorName) && !kept.has(message) && current(message))
    .slice(-HUMAN_FLOOR);
  const recent = [...rescued, ...tail].sort((left, right) => spoken.indexOf(left) - spoken.indexOf(right));

  // The defendant's words, wherever they fell in the log.
  if (view.trial) {
    const defence = spoken
      // This trial. A seat that stood here on day three and survived it is not
      // defending itself now, and its old defence is not this one's.
      .filter((message) => message.authorName === view.trial?.name && current(message))
      .slice(-3)
      .filter((message) => !recent.includes(message));
    recent.unshift(...defence);
  }

  const slots = new Map(view.players.map((player) => [player.name, player.slot]));

  /**
   * Which room a line was said in, and why the model has to be told.
   *
   * `view.chat` is this seat's whole projection, so a mafioso's transcript
   * already contained the family's private channel — mixed in with the square,
   * unlabelled and indistinguishable. Two failures fell out of that: the model
   * could not use the family channel as a *plan* (it read as more square talk),
   * and it could repeat something from it out loud, which hands the town the
   * game. Naming the room fixes both, and costs four characters a line.
   */
  const room = (channel: string): string => {
    if (channel === 'day') return '';
    if (channel === 'jail') return ' (in the cell, private)';
    if (channel === 'dead') return ' (graveyard, the living cannot hear this)';
    if (channel.startsWith('pm:')) return ' (whispered to you)';
    return ' (YOUR SECRET CHANNEL — the town cannot see this, and must never learn what is in it)';
  };

  /**
   * One speaker's run of lines, as the one thing they were saying.
   *
   * People type "7", then "where were you", then "last night". Three lines in
   * the log, one question at the table, and three lines in the briefing is both
   * more tokens — the `4 Name [HUMAN PLAYER]:` prefix is most of a fragment —
   * and harder to read: a model handed them separately dutifully tries to find
   * a meaning in "last night" on its own. Same coalescing the readers do.
   */
  const merged: typeof recent = [];
  for (const message of recent) {
    const previous = merged[merged.length - 1];
    if (previous && previous.authorName === message.authorName && previous.channel === message.channel) {
      merged[merged.length - 1] = { ...previous, text: `${previous.text} ${message.text}` };
      continue;
    }
    merged.push(message);
  }

  /**
   * A hard bound on the transcript, in characters.
   *
   * The window is a line count, and a line is whatever somebody typed into it:
   * twenty-six lines is two hundred tokens of ordinary chat and two thousand
   * from one person pasting a wall of text. That is the prompt's whole budget,
   * spent by a stranger, on every seat's turn for the rest of the phase — and
   * on a free tier paid for in tokens per minute it is the difference between a
   * table that talks and a table that does not.
   *
   * Newest first, because the oldest line is the one the room has moved past.
   */
  /**
   * When *this* phase started, so a line can be told from a memory.
   *
   * The transcript is a window on the last N lines and nothing in it said how
   * old any of them were, so a model answering its turn answered all of them
   * equally. From a real game: a player greeted the table on day five and a bot
   * said "Hi Max" back on day five, and again on day six, and again while
   * standing on the gallows on day seven — by which point Max had been dead for
   * four days. The bot was not confused about who was alive. It was reading a
   * four-day-old greeting as something that had just been said to it.
   *
   * `phaseStartedAt` is computed once on the view, beside the deadline it is
   * derived from, rather than reconstructed here from a config this module has
   * no business reading.
   */
  const startedAt = view.phaseStartedAt ?? 0;

  const rendered: string[] = [];
  let left = TRANSCRIPT_CHARS;
  for (let index = merged.length - 1; index >= 0; index--) {
    const message = merged[index];
    const person = humanNames.has(message.authorName) ? ' [HUMAN PLAYER]' : '';
    const slot = slots.get(message.authorName);
    const who = slot === undefined ? message.authorName : `${slot} ${message.authorName}`;
    // Screened here rather than at the chat, because the square is for people
    // and this line is for a model: a human reading the same message sees it
    // exactly as typed. See `guard.ts`.
    const clean = screen(message.text).text;
    const said = clean.length > LINE_CHARS ? `${clean.slice(0, LINE_CHARS)}…` : clean;
    /**
     * Anything older than this phase is background, and says so.
     *
     * Not dropped — an accusation from yesterday is exactly the thing a defence
     * has to answer, and the claims board keeps only the *fact* of it, never
     * the words. Marked instead, so the model can read it and know better than
     * to reply to it.
     */
    /**
     * Every line stamped, and the older ones still told to stay quiet.
     *
     * The stamp is the fact ("night 3"); the warning is the instruction. They
     * do different jobs and the first is the one that survives a small model
     * ignoring the second — a night number is something the line *is*, not
     * something the model has to be persuaded about. Four characters a line
     * against `TRANSCRIPT_CHARS`, which is the trade the header above is
     * already making for the room label.
     */
    const stamp = when.get(message.id) ?? '?';
    /**
     * One marker carrying both the stamp and the warning.
     *
     * They were two, and the long one was spent on every old line: "[EARLIER —
     * context only, already dealt with, do not reply to it]" is a dozen tokens
     * of instruction repeated per line, which is the same mistake as putting a
     * rule in the data. Merged, the old lines get *cheaper* than before and
     * gain their night number, which is the fact the warning was standing in
     * for all along.
     *
     * A line from the current phase carries nothing. It is now; the briefing
     * has already said what day it is, and stamping "now" on every line of an
     * active afternoon is the one place the per-line cost buys nothing at all.
     */
    const age = message.at < startedAt ? ` [${stamp}, earlier — context, do not reply]` : '';
    const line = `${who}${person}${room(message.channel)}${age}: ${said}`;
    if (line.length > left && rendered.length > 0) break;
    left -= line.length;
    rendered.unshift(line);
  }

  if (rendered.length === 0) return 'Nobody has spoken yet.';
  /**
   * Every line is dated, and only the ones that need ink pay for it.
   *
   * An unmarked line is one said in the phase named here; a marked one carries
   * its own. So the transcript is fully dated either way, and the common case —
   * an active afternoon where every line is from this afternoon — spends
   * nothing per line to say so. Stamping those too was measured at ten tokens
   * over the bench's own ceiling on a fifteen-seat table with two people at it,
   * and the ceiling is there because the model is paid for in tokens a minute.
   */
  /**
   * And the legend itself is only printed when something is marked.
   *
   * It explains what a stamp means, so on a transcript with no stamps in it —
   * the common case, an afternoon whose lines are all from this afternoon — it
   * is twenty tokens explaining a notation that does not appear. The same
   * reasoning as the per-line stamp immediately above, applied one level up.
   */
  const nowLabel = `${view.phase === 'night' ? 'N' : 'D'}${view.day}`;
  const stamped = rendered.some((line) => line.includes(', earlier — context'));
  const legend = stamped ? ` (unmarked = now (${nowLabel}); D2 = day 2, N2 = night 2)` : '';
  const header = humansPresent
    ? `WHAT WAS ACTUALLY SAID${legend} — read it properly. Claims, accusations and defences matter more than the numbers above, especially from human players:`
    : `Recent lines${legend}:`;
  return `${header}\n${rendered.join('\n')}`;
}

/**
 * The slow briefing: everything, and time to think about it.
 *
 * Used by the deliberate tempo, where a table takes as long as it needs. The
 * whole roster, the whole claims board, the trial record and the full private
 * feed — the model is expected to do real deduction here rather than pattern-match
 * a summary, so nothing is pre-chewed for it.
 */
export function dossier(
  view: MafiaView,
  board: PublicInfo,
  mind: BotMind,
  task: string,
  round: number,
  rounds: number,
  locale: Locale,
  self?: MafiaPlayer
): string {
  const me = view.me!;
  const lines: string[] = [];
  lines.push(`— Thinking round ${round}/${rounds} —`);
  lines.push(`Day ${view.day}, phase ${view.phase}${view.stage ? ` (${view.stage})` : ''}.`);
  if (me.role) {
    lines.push(
      `Your secret role: ${say(locale)(me.role.name)} (${say(locale)(FACTION(me.role.faction))} side). ${say(locale)(me.role.description)}`
    );
  }
  if (me.charges !== null) lines.push(`Uses left: ${me.charges}.`);
  if (me.teammates && me.teammates.length > 0) {
    lines.push(
      `Your allies: ${me.teammates.map((mate) => `${mate.slot}. ${mate.name} (${say(locale)(mate.roleName)})`).join(', ')}.`
    );
  }
  if (me.obsessionSlot !== null) lines.push(`Your obsession: get house ${me.obsessionSlot} hanged.`);
  lines.push(
    `The houses: ${view.players
      .map((player) => {
        const bits = [`${player.slot}. ${player.name}`];
        if (!player.alive) bits.push(`DEAD${player.roleName ? ` (${say(locale)(player.roleName)})` : ''}`);
        if (player.onTrial) bits.push('ON TRIAL');
        if (player.votesAgainst > 0) bits.push(`${player.votesAgainst} votes against`);
        if (player.votedSlot !== null) bits.push(`accuses ${player.votedSlot}`);
        return bits.join(' ');
      })
      .join(' | ')}`
  );
  const said = board.claims.slice(-24).map((claim) => {
    switch (claim.kind) {
      case 'accuse':
        return `D${claim.day}: ${claim.claimerSlot} accuses ${claim.targetSlot}`;
      case 'clear':
        return `D${claim.day}: ${claim.claimerSlot} clears ${claim.targetSlot}`;
      case 'hint':
        return `D${claim.day}: ${claim.claimerSlot} finds ${claim.targetSlot} shady`;
      case 'role-claim':
        return `D${claim.day}: ${claim.claimerSlot} claims to be ${claim.claimedRole}`;
      case 'question':
        return `D${claim.day}: ${claim.claimerSlot} presses ${claim.targetSlot} for an account`;
      case 'account':
        return claim.account === 'home'
          ? `D${claim.day}: ${claim.claimerSlot} says they never left home`
          : `D${claim.day}: ${claim.claimerSlot} says they went to ${claim.targetSlot}`;
      case 'sighting':
        return `D${claim.day}: ${claim.claimerSlot} SAW ${claim.targetSlot} outside`;
      default:
        return `D${claim.day}: ${claim.claimerSlot} needles ${claim.targetSlot}`;
    }
  });
  if (said.length > 0) lines.push(`What has been said:\n${said.join('\n')}`);
  const caught = board.aliveSlots.filter((slot) => contradicted(slot, board));
  if (caught.length > 0) lines.push(`Contradicted by testimony: houses ${caught.join(', ')}.`);
  if (board.trials.length > 0) {
    lines.push(
      `Past trials: ${board.trials
        .map(
          (trial) =>
            `D${trial.day} ${trial.accusedSlot} ${trial.lynched ? 'hanged' : 'spared'} (guilty: ${trial.guiltySlots.join('/') || '—'})`
        )
        .join(' ; ')}`
    );
  }
  if (me.notifications.length > 0) {
    lines.push(
      `Your private information:\n${me.notifications
        .slice(-8)
        .map((note) => say(locale)(note))
        .join('\n')}`
    );
  }
  /**
   * The slow tempo reads the whole conversation, and reads it last.
   *
   * Placed after the structured board on purpose: the ledger is the skeleton, the
   * transcript is what actually happened, and the thing closest to the question
   * is the thing a model weighs hardest. Humans are named as humans here too.
   */
  const humanNames = new Set(view.players.filter((player) => !player.isBot).map((player) => player.name));
  const chat = view.chat
    .slice(-50)
    .map((message) =>
      message.authorId
        ? `${message.authorName}${humanNames.has(message.authorName) ? ' [HUMAN PLAYER]' : ''}: ${message.text}`
        : `[town] ${message.msg ? say(locale)(message.msg) : message.text}`
    );
  if (chat.length > 0) {
    lines.push(
      `THE CONVERSATION — the most reliable source on this sheet. Weigh claims, accusations and defences against what was actually said:\n${chat.join('\n')}`
    );
  }
  lines.push(...pressure(view, board));
  /**
   * The arithmetic, which the slow tempo needed more than the fast one and was
   * the only one of the two not getting it.
   *
   * `brief` is a conclusion handed to a small model, so it has carried the
   * clock and the counting since they existed. `dossier` hands a larger model
   * the board and asks it to reason, and a model reasoning about an endgame
   * without being told how many mistakes the town can still afford will reason
   * carefully to the wrong answer. Placed by the stance, because it is the
   * thing the decision turns on.
   */
  const sums = self ? arithmetic(view, board, self) : null;
  if (sums) lines.push(sums);
  lines.push(stanceLine(mind, view));
  lines.push(task);
  return lines.join('\n');
}

/**
 * The verb this bot's power goes by, for the night prompt.
 *
 * In the table's *spoken* language, not the server's: the bot will name this
 * power out loud in a shared channel, and a bot claiming « Sonder » at an
 * English table is a bot the table cannot answer.
 */
export function actionVerb(view: MafiaView, locale: Locale): string | null {
  const action = view.me?.action;
  return action ? say(locale)(ACTION(action.type)) : null;
}
