import {
  ACTION_LABELS,
  FACTION_LABELS,
  claimerWeight,
  contradicted,
  trustOf,
  type MafiaView,
  type PublicInfo
} from 'mafia-core';
import type { Locale } from 'i18n';
import type { BotMind } from './bot-mind.js';
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
  lines.push(
    leader && leader.votesAgainst > 0
      ? `It takes ${needed} votes to start a trial. ${leader.slot}. ${leader.name} has ${leader.votesAgainst} — ${needed - leader.votesAgainst} more and they are on trial.`
      : `It takes ${needed} votes to start a trial. Nobody is targeted yet.`
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
  const rows = view.players
    .filter((player) => player.alive)
    .map((player) => {
      const notes: string[] = [];
      if (player.votesAgainst > 0) notes.push(`${player.votesAgainst} votes`);
      if (caught.has(player.slot)) notes.push('CAUGHT LYING');
      const trust = trustOf(player.slot, board);
      if (trust >= 2) notes.push('has hanged killers before');
      else if (trust <= -2) notes.push('tried to save killers');
      const roleClaim = board.claims.find(
        (claim) => claim.kind === 'role-claim' && claim.claimerSlot === player.slot && claim.claimedRole
      );
      if (roleClaim) notes.push(`claims to be ${roleClaim.claimedRole}`);
      const account = board.claims.find((claim) => claim.kind === 'account' && claim.claimerSlot === player.slot);
      if (account)
        notes.push(account.account === 'home' ? 'says they never left home' : `says they went to ${account.targetSlot}`);
      if (player.revealedMayor) notes.push('revealed Mayor');
      const weight = claimerWeight(player.slot, board);
      if (weight === 0 && board.claims.some((claim) => claim.claimerSlot === player.slot)) notes.push('proven liar');
      return { slot: player.slot, name: player.name, notes, score: notes.length + player.votesAgainst };
    })
    .filter((row) => row.notes.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return rows.map((row) => `${row.slot}. ${row.name} — ${row.notes.join(', ')}`);
}

/**
 * The fast briefing: a conclusion, not a transcript.
 *
 * Deliberately short. A 4B model given a wall of chat answers about the wall of
 * chat; given three facts and an instruction it answers about the game. The
 * chat is trimmed to the last handful of *human-authored* lines, because those
 * are the ones a bot is expected to react to.
 */
export function brief(view: MafiaView, board: PublicInfo, mind: BotMind, task: string, locale: Locale): string {
  const me = view.me!;
  const lines: string[] = [];
  lines.push(
    `Day ${view.day}, ${view.phase === 'night' ? 'NIGHT' : 'DAY'}${view.stage ? ` (${view.stage})` : ''}. ${view.players.filter((p) => p.alive).length} alive.`
  );
  if (me.role)
    lines.push(
      `You: ${me.role.name}, ${FACTION_LABELS[me.role.faction]} side${me.charges !== null ? `, ${me.charges} use(s) left` : ''}.`
    );
  if (me.teammates && me.teammates.length > 0) {
    lines.push(`With you: ${me.teammates.map((mate) => `${mate.slot} ${mate.name}`).join(', ')}.`);
  }
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

  const hot = heatmap(view, board, hotRows);
  if (hot.length > 0) lines.push(`What matters:\n${hot.join('\n')}`);
  else lines.push('Nobody stands out yet.');
  const news = me.notifications.slice(-2);
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
function transcript(view: MafiaView, window: number, humansPresent: boolean): string {
  // Authored lines only: the game's own announcements are already summarised
  // above, so this needs no renderer.
  const spoken = view.chat.filter((message) => message.authorId);
  const recent = spoken.slice(-window);

  // The defendant's words, wherever they fell in the log.
  if (view.trial) {
    const defence = spoken
      .filter((message) => message.authorName === view.trial?.name)
      .slice(-3)
      .filter((message) => !recent.includes(message));
    recent.unshift(...defence);
  }

  const humanSlots = new Set(view.players.filter((player) => !player.isBot).map((player) => player.name));
  const rendered = recent.map((message) => {
    const person = humanSlots.has(message.authorName) ? ' [HUMAN PLAYER]' : '';
    return `${message.authorName}${person}: ${message.text}`;
  });

  if (rendered.length === 0) return 'Nobody has spoken yet.';
  const header = humansPresent
    ? 'WHAT WAS ACTUALLY SAID — read it properly. Claims, accusations and defences matter more than the numbers above, especially from human players:'
    : 'Recent lines:';
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
  locale: Locale
): string {
  const me = view.me!;
  const lines: string[] = [];
  lines.push(`— Thinking round ${round}/${rounds} —`);
  lines.push(`Day ${view.day}, phase ${view.phase}${view.stage ? ` (${view.stage})` : ''}.`);
  if (me.role) {
    lines.push(`Your secret role: ${me.role.name} (${FACTION_LABELS[me.role.faction]} side). ${me.role.description}`);
  }
  if (me.charges !== null) lines.push(`Uses left: ${me.charges}.`);
  if (me.teammates && me.teammates.length > 0) {
    lines.push(
      `Your allies: ${me.teammates.map((mate) => `${mate.slot}. ${mate.name} (${mate.roleName})`).join(', ')}.`
    );
  }
  if (me.obsessionSlot !== null) lines.push(`Your obsession: get house ${me.obsessionSlot} hanged.`);
  lines.push(
    `The houses: ${view.players
      .map((player) => {
        const bits = [`${player.slot}. ${player.name}`];
        if (!player.alive) bits.push(`DEAD${player.roleName ? ` (${player.roleName})` : ''}`);
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
  if (me.notifications.length > 0) lines.push(`Your private information:\n${me.notifications.slice(-8).join('\n')}`);
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
  lines.push(stanceLine(mind, view));
  lines.push(task);
  return lines.join('\n');
}

/** The verb this bot's power goes by, for the night prompt. */

export function actionVerb(view: MafiaView): string | null {
  const action = view.me?.action;
  return action ? ACTION_LABELS[action.type] : null;
}
