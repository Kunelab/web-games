import type { Catalogue } from '../index.js';

/**
 * Everything the screens themselves say, in English: the words on buttons, the
 * one-line prompt that tells you what the phase wants from you, the refusals the
 * server hands back, and the labels the shared chat and pause surfaces need.
 *
 * Kept apart from `en.ts` on the same principle as `roles-en.ts`: that file is
 * the game's *narrative*, written to be read straight through, and mixing button
 * labels into it makes both halves harder to translate. A key here is UI; a key
 * there is something the town said out loud.
 */
export const screenEn: Catalogue = {
  /* --------------------------- what the table refuses ----------------------- */
  'mafia.refuse.notSeated': 'You are not at a table',
  'mafia.refuse.noTable': 'This table no longer exists',
  'mafia.refuse.badRequest': 'Invalid request',
  'mafia.refuse.paused': 'The table is paused',
  'mafia.refuse.deadNoVote': 'The dead do not vote',
  'mafia.refuse.notNow': 'Not now',
  'mafia.refuse.firstDay': 'No vote on the first day',
  'mafia.refuse.stillTalking': 'Too early — the town is still talking',
  'mafia.refuse.badTarget': 'Invalid target',
  'mafia.refuse.needsSecondTarget': 'Name a second house too',
  'mafia.refuse.sameTwice': 'The same house twice',
  'mafia.refuse.notYourself': 'Not against yourself',
  'mafia.refuse.accusedSilent': 'The accused does not vote',
  'mafia.refuse.waitForDay': 'Wait for daylight',
  'mafia.refuse.noAction': 'You have nothing to play',
  'mafia.refuse.dayOnly': 'Choose during the day',
  'mafia.refuse.noRecipient': 'No such recipient',
  'mafia.refuse.alreadyRevealed': 'Already revealed',
  'mafia.refuse.whisperNotNow': 'You cannot whisper right now',
  'mafia.refuse.impossible': 'Impossible',
  'mafia.refuse.courtSpent': 'The court has already sat',
  'mafia.refuse.nobodyAccused': 'Nobody is accused',
  'mafia.refuse.courtSplit': 'The square is split down the middle, no defendant',
  'mafia.refuse.whisperSelf': 'Talking to yourself worries the neighbours',
  'mafia.refuse.tooLate': 'Too late',
  'mafia.refuse.cannotSpeakHere': 'You cannot speak here',
  'mafia.refuse.notAtTable': 'You are not at this table',
  'mafia.refuse.emptyMessage': 'Say something first',
  'mafia.refuse.messageTooLong': 'That message is too long',
  'mafia.refuse.slowDown': 'Steady on, too many messages',
  'mafia.refuse.tableMovedOn': 'The table carried on without you',
  'mafia.refuse.alreadyStarted': 'The game has already started',
  'mafia.refuse.nameRequired': 'A name is required',
  'mafia.refuse.nameTaken': 'That name is taken',
  'mafia.refuse.nameIsARole': 'That is a role or a faction. Pick a name of your own.',
  'mafia.refuse.tableFull': 'The table is full',
  'mafia.refuse.alreadyRunning': 'Already under way',
  'mafia.refuse.needPlayers': 'At least {count} players are needed',
  'mafia.refuse.hostOnly': 'That is the host’s to do',
  'mafia.refuse.startFailed': 'Could not start the game',
  'mafia.refuse.joinFailed': 'Could not join',
  'presence.kick.tooSoon': 'Too soon: give them time to come back.',
  'presence.kick.targetPresent': 'That player is here.',
  'presence.kick.alreadyOpen': 'A vote is already open.',
  'presence.kick.alreadyKicked': 'That player has already left the table.',
  'presence.kick.self': 'You do not vote yourself out.',
  'presence.kick.noVote': 'No vote is open.',
  'presence.kick.impossible': 'Impossible.',

  /* -------------------------------- the channels ---------------------------- */
  'mafia.channel.day': 'Village Square',
  'mafia.channel.mafia': 'The Family',
  'mafia.channel.triad': 'The Triad',
  'mafia.channel.cult': 'The Cult',
  'mafia.channel.mason': 'The Lodge',
  'mafia.channel.dead': 'Graveyard',
  'mafia.channel.jail': 'The Cell',
  'mafia.channel.pm': '🤫 {name}',

  /* -------------------------------- the chat box ---------------------------- */
  'net.unreachable': 'Cannot reach the server.',
  'chat.empty': 'Nobody has spoken here yet.',
  'chat.placeholder': 'Your message…',
  'chat.muted': 'You cannot speak here',
  'chat.send': 'Send',

  /* ------------------------------ the pause card ---------------------------- */
  'presence.paused.short': 'Paused · waiting for {names}',
  'presence.paused.title': 'The table is waiting',
  'presence.paused.lead': 'Waiting for {names} to come back.',
  'presence.paused.away': 'away for {seconds}s',
  'presence.paused.note': 'The time left on the phase is given back to you untouched.',
  'presence.paused.expiry': 'With no return, play resumes without them in {seconds}s.',
  'presence.resuming.title': 'Everybody is back',
  'presence.resuming.soon': 'Resuming shortly',
  'presence.resuming.inPrefix': 'Resuming in',
  'presence.resuming.inSeconds': 'resuming in {seconds}s',
  'presence.vote.question': 'Carry on without {name}?',
  'presence.vote.tally': '{yes} yes · {no} no, {needed} needed',
  'presence.vote.yes': 'Carry on',
  'presence.vote.no': 'Wait',
  'presence.vote.propose': 'This absence is dragging on. Propose carrying on without:',
  'presence.fold': 'Fold away',
  'presence.unfold': 'Show',
  'presence.recovering': 'reconnecting…',
  'presence.recovering.title': '{label}: reconnecting…',

  /* -------------------------------- the seat screen ------------------------- */
  'mafia.ui.title': 'Mafia',
  'mafia.ui.table': 'Table {code}',
  'mafia.ui.yourName': 'Your name',
  'mafia.ui.connecting': 'Connecting…',
  'mafia.ui.takeSeat': 'Take a seat',
  'mafia.ui.joinFailed': 'Could not join',
  'mafia.ui.phase.lobby': 'Waiting room',
  'mafia.ui.phase.day': '☀️ Day {day}',
  'mafia.ui.phase.night': '🌙 Night {day}',
  'mafia.ui.phase.ended': 'Game over',
  'mafia.ui.phaseName.lobby': 'waiting room',
  'mafia.ui.phaseName.day': 'day',
  'mafia.ui.phaseName.night': 'night',
  'mafia.ui.phaseName.ended': 'finished',
  'mafia.ui.stage.defense': '⚖️ Defence',
  'mafia.ui.stage.judgement': '⚖️ Judgement',
  'mafia.ui.alive': '{count} alive',
  'mafia.ui.players': 'Players',
  'mafia.ui.lobby.count': '{seats} / {max} players · code {code}',
  'mafia.ui.lobby.addBots': '+ 1 bot',
  'mafia.ui.lobby.start': 'Start the game',
  'mafia.ui.charges': '{count} left',
  'mafia.ui.dead': 'Dead',
  'mafia.ui.survived': 'survived',
  'mafia.ui.withYou': 'With you: {mates}',
  'mafia.ui.obsession': 'Your obsession: house {slot}',
  'mafia.ui.you': 'you',
  'mafia.ui.bot': 'Bot',
  'mafia.ui.revealed': 'Revealed',
  'mafia.ui.fold': 'Hide this panel',
  'mafia.ui.unfold': 'Show this panel',
  'mafia.ui.away': 'Disconnected',
  'mafia.ui.whisperTo': 'Whisper to {name}',
  'mafia.ui.unknownIdentity': 'Identity unknown',
  'mafia.ui.onStand': 'On the stand',
  'mafia.ui.accuses': 'accuses house {slot}',
  'mafia.ui.votesAgainst': '{count} votes against',
  'mafia.ui.familyVotes': '{count} of your family are aiming here tonight',
  'mafia.ui.ally': 'with you · {role}',
  /* What an ally is doing with their own night, on the family's roster. */
  'mafia.ui.allyAims': '{action} → house {slot}',
  'mafia.ui.allyAimsPair': '{action} → house {slot}, towards house {second}',
  'mafia.ui.allyWaiting': '{action} · no order yet',
  'mafia.ui.zoomOut': 'Zoom out',
  'mafia.ui.zoomIn': 'Zoom in',
  'mafia.ui.cancel': 'Cancel',
  'mafia.ui.withdraw': 'Withdraw',
  'mafia.ui.accuse': 'Accuse',
  'mafia.ui.jail': 'Jail',
  'mafia.ui.release': 'Release',
  'mafia.ui.guilty': 'Guilty',
  'mafia.ui.innocent': 'Innocent',
  'mafia.ui.abstain': 'Abstain',
  'mafia.ui.backToAccusations': '↩︎ Back to accusations',
  'mafia.ui.prisoner': '🔒 Prisoner: house {slot}',
  'mafia.ui.pickPrisoner': '🔒 Pick a prisoner',
  'mafia.ui.revealMayor': '🎗️ Reveal yourself as Mayor',
  'mafia.ui.callCourt': '⚖️ Convene the court',
  'mafia.ui.callCourtSure': '⚖️ Confirm: immediate judgement',
  'mafia.ui.pickSecond.control': 'Bewitched: house {slot}. Which door do you send them to?',
  'mafia.ui.pickSecond.swap': 'First house: {slot}. Which one do you swap it with?',
  'mafia.ui.secondHere.control': 'Send here',
  'mafia.ui.secondHere.swap': 'Swap with',
  'mafia.ui.firstPicked': '① Picked',
  'mafia.ui.secondPicked': '② Destination',
  'mafia.ui.will': '📜 Last will',
  'mafia.ui.willLabel': 'What the town will read on your body',
  'mafia.ui.seal': 'Seal',
  'mafia.ui.whisperLabel': '🤫 To {name}, the town will see that you whispered',
  'mafia.ui.send': 'Send',
  'mafia.ui.close': 'Close',
  'mafia.ui.results': 'The masks come off',
  'mafia.ui.col.seat': '#',
  'mafia.ui.col.player': 'Player',
  'mafia.ui.col.role': 'Role',
  'mafia.ui.col.outcome': 'Outcome',
  'mafia.ui.col.points': 'Points',
  'mafia.ui.totalPoints': '{name}: {total} pts in total',
  'mafia.ui.signInToKeep': 'Sign in to keep your points from one game to the next.',
  'mafia.ui.seatLabel': '{name} (house {slot})',
  'mafia.ui.journal': 'Your private notes',

  /* ---------------------------- the two corner icons ------------------------ */
  'mafia.ui.willsIcon': 'Last wills',
  'mafia.ui.willsTitle': 'Last wills',
  'mafia.ui.willsEmpty': 'Nobody has died yet: no will has been opened.',
  'mafia.ui.willsNone': 'Left nothing behind.',
  'mafia.ui.willsMine': 'Your own will',
  'mafia.ui.willsMineEmpty': 'You have sealed nothing yet.',
  'mafia.ui.votesTab': '⚖ Votes',
  'mafia.ui.closeTable': 'Close this table',
  'mafia.ui.closeTableSure': 'Close it for everyone?',
  'mafia.ui.closeTableNote': 'Ends the game for every player and frees the code.',
  'mafia.ui.votesEmpty': 'Nobody has accused anybody yet.',
  'mafia.ui.votesDay': 'Day {day}',
  'mafia.ui.votesAccuse': '{voter} → {target}',
  'mafia.ui.votesWithdraw': '{voter} takes it back',
  'mafia.ui.votesSkip': '{voter} → hang nobody',
  'mafia.ui.willsTabMine': 'Yours',
  'mafia.ui.willsTabDead': 'The dead ({count})',
  'mafia.ui.willsSealed': 'Sealed ✓',
  'mafia.ui.skipIcon': 'Hang nobody today',
  'mafia.ui.roleCardIcon': 'Your role',
  'mafia.ui.roleListTitle': 'Roles in play',
  'mafia.ui.roleListEmpty': 'The role list is drawn when the game starts.',
  'mafia.ui.roleListIcon': 'Role list',

  /* ---------------------------------- prompts ------------------------------- */
  'mafia.ui.prompt.lobby': 'Waiting: the host starts the game once the table is ready.',
  'mafia.ui.prompt.dead': 'You are dead. The graveyard listens to you; the town no longer hears you.',
  'mafia.ui.prompt.jailed': '🔒 In a cell for the night. Talk to the Jailor in the Cell tab.',
  'mafia.ui.prompt.nightIdle': 'The night passes. You have nothing to play, listen.',
  'mafia.ui.prompt.selfAction': 'Your power plays at home: “{action}” on your own row.',
  'mafia.ui.prompt.pickTarget': 'Choose your target: “{action}” on somebody’s row.',
  'mafia.ui.prompt.yourDefense': 'This is your trial. You alone have the floor: defend yourself in the chat.',
  'mafia.ui.prompt.defense': '{name} is defending themselves. The town listens.',
  'mafia.ui.prompt.yourJudgement': 'The town is voting on your fate.',
  'mafia.ui.prompt.judgement': 'Give your verdict.',
  'mafia.ui.prompt.jailPick': 'Name tonight’s prisoner.',
  'mafia.ui.prompt.discussion': 'Talk, then accuse whoever you want to see on the stand.',
  'mafia.ui.ballotOpensIn': '{seconds}s',
  'mafia.ui.bot.reading': 'Reading the square…',
  'mafia.ui.prompt.firstDay': 'First day: you talk, you do not hang. Make some friends.',

  /* -------------------------------- the skip vote --------------------------- */
  'mafia.ui.skip': 'Hang nobody today',
  'mafia.ui.skipChosen': 'You want nobody hanged',
  'mafia.ui.skipTally': '{count} / {needed} for no hanging',

  /* -------------------------------- the television -------------------------- */
  'mafia.tv.onStand': '{name} on the stand',
  'mafia.tv.code': 'Code {code}',
  'mafia.tv.hideRoles': '🙈 Hide the roles',
  'mafia.tv.showRoles': '👁️ Reveal the roles',
  'mafia.tv.fullscreen': 'Full screen',
  'mafia.tv.joinAt': 'Join the table at',
  'mafia.tv.noSpoilers': 'Spoiler-free: this screen shows no role at all. Identities stay on the phones.',
  'mafia.tv.unrecognisable': 'Unrecognisable body',
  'mafia.tv.deadShort': 'Dead',
  'mafia.tv.veiled': '⸻ a secret was told here ⸻',
  'mafia.tv.cannotJoin': 'Could not join this table',

  /* ------------------------------- the setup screen ------------------------- */
  'mafia.setup.pitch':
    'Up to 24 players around the village square. The town hunts its killers; the killers swear they are innocent. Free, and forever.',
  'mafia.setup.resume': 'Resume table {code} ({players} players, {phase})',
  'mafia.setup.dayPace': 'Pace of the days',
  'mafia.setup.nightPace': 'Pace of the nights',
  'mafia.setup.day90': 'Day: 1 min 30',
  'mafia.setup.day120': 'Day: 2 min',
  'mafia.setup.day180': 'Day: 3 min',
  'mafia.setup.night30': 'Night: 30 s',
  'mafia.setup.night45': 'Night: 45 s',
  'mafia.setup.night60': 'Night: 1 min',
  'mafia.setup.revealLabel': 'Role reveal',
  'mafia.setup.reveal.role': 'On death: the whole role',
  'mafia.setup.reveal.faction': 'On death: the camp only',
  'mafia.setup.reveal.none': 'On death: nothing at all',
  'mafia.setup.revealHint':
    'A body cleaned by the Janitor stays anonymous whatever the setting, and a borrowed face fools investigators only, the corpse always says what the player really was.',
  'mafia.setup.tab.proposed': 'Proposed templates',
  'mafia.setup.tab.mine': 'My templates ({count}/10)',
  'mafia.setup.auto.name': 'Automatic balance',
  'mafia.setup.auto.desc': 'The server composes a balanced table for the number of players.',
  'mafia.setup.chaos.name': '🎲 Total chaos',
  'mafia.setup.chaos.desc': 'Every seat rolls a role at random. No promises, no regrets.',
  'mafia.setup.preset.classique-15.name': 'Classic (15)',
  'mafia.setup.preset.classique-15.desc': 'The wiki’s reference setup: 9 Town, 3 Mafia, 3 Neutrals.',
  'mafia.setup.preset.choix-de-raphael-15.name': 'Raphael’s Choice (15)',
  'mafia.setup.preset.choix-de-raphael-15.desc': 'More chance on the Mafia side, two benign Neutrals: 9 / 3 / 3.',
  'mafia.setup.preset.deantwo-15.name': 'Deantwo (15)',
  'mafia.setup.preset.deantwo-15.desc': 'A tighter town, five Neutrals: polite chaos. 7 / 3 / 5.',
  'mafia.setup.preset.grand-classique-24.name': 'Grand Classic (24)',
  'mafia.setup.preset.grand-classique-24.desc':
    'The Classic stretched to 24 seats, same proportions: 14 Town, 5 Mafia, 5 Neutrals.',
  'mafia.setup.preset.nuit-noire-24.name': 'Black Night (24)',
  'mafia.setup.preset.nuit-noire-24.desc': 'Two lone killers in the same dark: 14 Town, 5 Mafia, 5 Neutrals.',
  'mafia.setup.seatsSummary': '{count} seats, {roles}',
  'mafia.setup.remove': 'Remove',
  'mafia.setup.addSeat': 'Add a seat ({count}/24)',
  'mafia.setup.emptyDraft': 'Add some seats below.',
  'mafia.setup.templateName': 'Template name',
  'mafia.setup.save': '💾 Save',
  'mafia.setup.useTemplate': 'Use this template',
  'mafia.setup.custom': 'Custom ({count} seats)',
  'mafia.setup.chosen': 'Chosen distribution:',
  'mafia.setup.open': 'Open a table',
  'mafia.setup.createFailed': 'Could not create the table',
  'mafia.setup.saveFailed': 'Could not save',
  'mafia.setup.created': 'Table {code} is open. Players join with this code or this QR:',
  'mafia.setup.goSit': 'Take my seat at the table',
  'mafia.setup.thisTable': 'this table',
  'mafia.setup.tvTitle': 'All in the same room?',
  'mafia.setup.tvPitch':
    'Open the town large on a TV or a PC. That screen does not play, takes no seat, and starts without revealing a single role.',
  'mafia.setup.openTv': '📺 Open the town screen',
  /* ------------------------------ what a bot says --------------------------- */
  /**
   * Two rules, and the second one is the one that keeps getting broken.
   *
   * **A variant asserts only what the call site has checked.** A phrasing picked
   * out of a hat can never carry a fact of its own: no "I never left my house"
   * from a seat that went out, no "two days of nothing" on day two. Those read
   * as flavour and play as evidence, and a player misled by the decoration has
   * been beaten by a bug rather than by an opponent. Anything that needs a fact
   * takes it as a parameter, or lives in a `why.*` fragment gated on the board.
   *
   * **And short.** People type short. "Morning. Nobody has done anything yet, so
   * let us keep it that way." is nobody's good morning; "Morning." is. Every
   * line here is one move — a vote, a question, an alibi, a finding — and the
   * second clause that explains the first is almost always worth deleting. If a
   * line has a reason in it, the reason arrives as `{why}` because the code
   * computed it; otherwise the line stops.
   */
  'mafia.ailment.poison': 'poisoned',
  'mafia.ailment.douse': 'doused in petrol',
  'mafia.ailment.healed': 'healed by a doctor',
  'mafia.ailment.guarded': 'saved by a bodyguard',
  'mafia.ailment.survived': 'attacked and survived',
  'mafia.ailment.silenced': 'blackmailed',
  'mafia.ailment.blocked': 'roleblocked',
  'mafia.ailment.controlled': 'controlled by a witch',
  'mafia.ailment.bussed': 'swapped by a bus driver',
  'mafia.ailment.jailed': 'held in the cell',

  'mafia.bot.accuse.1': 'Voting {who}.',
  'mafia.bot.accuse.2': '{who} for me.',
  'mafia.bot.accuse.3': '{who}. Nothing hard, just a read.',
  /**
   * A vote with nothing on the board behind it, which says so.
   *
   * Every one of these admits the same thing in a different voice, because the
   * alternative — posting "Voting 7." and letting the room guess whether a
   * corpse's will or a coin flip is behind it — is the single easiest way for a
   * table of bots to look like it is withholding evidence. See `sentence`.
   */
  'mafia.bot.accuseRead.1': '{who}. Nothing hard, just a read.',
  'mafia.bot.accuseRead.2': '{who} for me, on feel. Nothing on the board yet.',
  'mafia.bot.accuseRead.3': 'Voting {who}. No evidence, I just do not like the seat.',
  'mafia.bot.accuseRead.4': '{who}, and I will say plainly I have nothing solid.',
  'mafia.bot.accuseRead.5': 'Putting my vote on {who} to start something. It is only a read.',
  'mafia.bot.accuseRead.6': '{who}. A hunch, not a case. Somebody give me better.',
  'mafia.bot.accuse.4': 'I think it is {who}.',
  'mafia.bot.accuse.5': 'My vote: {who}.',
  'mafia.bot.accuse.6': 'Voting {who} unless somebody has better.',
  'mafia.bot.accuse.7': '{who}. I want them to answer.',
  'mafia.bot.accuse.8': '{who} is my suspect.',
  'mafia.bot.accuse.9': 'Voting {who}. Change my mind.',
  'mafia.bot.clear.1': '{who} looks fine.',
  'mafia.bot.clear.2': 'Not {who}.',
  'mafia.bot.clear.3': 'I am not voting {who}.',
  'mafia.bot.clear.4': 'I would not vote {who}.',
  'mafia.bot.clear.5': 'Leave {who}.',
  'mafia.bot.clear.6': 'Off {who}, we are wasting the day.',
  'mafia.bot.clear.7': '{who} is the wrong name.',
  'mafia.bot.clear.8': 'Not {who}. I would argue that.',
  'mafia.bot.clear.9': '{who} adds up for me.',
  /**
   * The town's own killer owning a shot the dawn report will back. See the
   * `kill-claim` kind: this is only ever said on a morning it can be checked.
   */
  'mafia.bot.killClaim.1': 'That was me. I killed {who} on night {night}.',
  'mafia.bot.killClaim.2': '{who} was mine, night {night}. Check the report.',
  'mafia.bot.killClaim.3': 'I shot {who} on night {night}. It is in this morning’s report.',
  'mafia.bot.killClaim.4': 'Night {night}, {who}. That was my doing and I will own it.',
  'mafia.bot.killClaim.5': 'I took {who} on night {night}. The report says how.',
  'mafia.bot.killClaim.6': '{who} died by my hand on night {night}. Read the morning.',
  'mafia.bot.roleClaim.1': 'I am the {role}.',
  'mafia.bot.roleClaim.2': '{role}, that is me.',
  'mafia.bot.roleClaim.3': 'I am the {role}. Put me to work tonight.',
  'mafia.bot.roleClaim.4': 'I am the {role}. Check me tomorrow.',
  'mafia.bot.roleClaim.5': 'I am the {role}. If anyone else claims it, say so now.',
  'mafia.bot.roleClaim.6': 'Fine: I am the {role}.',
  /**
   * The account. This one *is* an assertion and is meant to be: the caller has
   * decided the seat claims it stayed in, truthfully or not, and files that on
   * the board for a lookout to catch tomorrow. No variant adds a second fact on
   * top — who called at the door, what a witness could or could not say.
   */
  'mafia.bot.stayedHome.1': 'Home all night.',
  'mafia.bot.stayedHome.2': 'I did not go out.',
  'mafia.bot.stayedHome.3': 'Stayed in.',
  'mafia.bot.stayedHome.4': 'Nowhere last night.',
  'mafia.bot.stayedHome.5': 'Home. Nothing to report.',
  'mafia.bot.stayedHome.6': 'I was in all night.',
  'mafia.bot.stayedHome.7': 'No visits from me.',
  'mafia.bot.stayedHome.8': 'In bed.',
  'mafia.bot.stayedHome.9': 'I went nowhere.',
  'mafia.bot.visited.1': 'I went to {who}.',
  'mafia.bot.visited.2': 'I was at {who}.',
  'mafia.bot.visited.3': 'I was at {who}’s last night.',
  'mafia.bot.visited.4': 'I spent last night at {who}’s.',
  'mafia.bot.visited.5': 'I called on {who}.',
  'mafia.bot.visited.6': '{who}’s house. That is where I was.',
  'mafia.bot.visited.7': 'I went to {who}’s and nowhere else.',
  'mafia.bot.visited.8': 'I visited {who}. Check it.',
  'mafia.bot.visited.9': 'I visited {who} last night, that is all.',
  'mafia.bot.question.1': '{who}, where were you?',
  'mafia.bot.question.2': '{who}, your night?',
  'mafia.bot.question.3': '{who}, whose door?',
  'mafia.bot.question.4': '{who}, what did you do last night?',
  'mafia.bot.question.5': '{who}, in or out?',
  'mafia.bot.question.6': 'Whose door, {who}?',
  'mafia.bot.question.7': '{who}, your night, please.',
  'mafia.bot.question.8': '{who}, answer for last night.',
  'mafia.bot.question.9': '{who}? Your night.',
  /** A sighting is one fact: somebody called at that house. Nothing else. */
  'mafia.bot.sighting.1': 'Somebody went into {who} last night.',
  'mafia.bot.sighting.2': '{who} had a visitor.',
  'mafia.bot.sighting.3': '{who} was not alone.',
  'mafia.bot.sighting.4': 'Someone was at {who}.',
  'mafia.bot.sighting.5': 'Someone called on {who}.',
  'mafia.bot.sighting.6': '{who} had company last night.',
  'mafia.bot.sighting.7': 'A visitor at {who} last night.',
  'mafia.bot.sighting.8': 'Somebody visited {who}.',
  'mafia.bot.sighting.9': 'I saw somebody at {who}. Own up.',
  /**
   * Needling, and the mark is picked at random — see `decideDay`, where a taunt
   * is noise on purpose. So none of these reports what the mark has done.
   */
  'mafia.bot.taunt.1': '{who}, say something.',
  'mafia.bot.taunt.2': '{who}, pick a name.',
  'mafia.bot.taunt.3': '{who}, still there?',
  'mafia.bot.taunt.4': '{who}, who are you voting?',
  'mafia.bot.taunt.5': 'Let us hear from {who}.',
  'mafia.bot.taunt.6': '{who} is very comfortable.',
  'mafia.bot.taunt.7': '{who}, you are hard to read.',
  'mafia.bot.taunt.8': '{who}, what do you think?',
  'mafia.bot.taunt.9': 'One thing, {who}.',
  'mafia.bot.hint.1': 'Not sure about {who}.',
  'mafia.bot.hint.2': 'Something is off with {who}.',
  'mafia.bot.hint.3': '{who} bothers me.',
  'mafia.bot.hint.4': 'Half an eye on {who}.',
  'mafia.bot.hint.5': 'Watching {who}. Not voting yet.',
  'mafia.bot.hint.6': '{who} does not sit right.',

  /**
   * Day one, where nothing has happened yet.
   *
   * So these are greetings and only greetings. "One of us is lying" and "ask me
   * anything today" were both said on a morning with nothing to lie about and
   * nothing to ask — a seat performing a game that has not started, which reads
   * as a script rather than as a person saying hello.
   */
  'mafia.bot.hello.1': 'Morning.',
  'mafia.bot.hello.2': 'Hi.',
  'mafia.bot.hello.3': 'Hey.',
  'mafia.bot.hello.4': 'Hello.',
  'mafia.bot.hello.5': 'Morning all.',
  'mafia.bot.hello.6': 'Present.',
  'mafia.bot.hello.7': 'Day one.',
  'mafia.bot.hello.8': 'Here.',
  'mafia.bot.hello.9': 'Awake.',
  'mafia.bot.hello.10': 'Good morning.',
  'mafia.bot.hello.11': 'Hi everyone.',
  'mafia.bot.hello.12': 'Here we go.',

  /* ------- why a seat thinks what it thinks: gated on the board, always ------ */
  'mafia.bot.why.poisonSurvived.1':
    'they claimed they were poisoned on night {night}, poison kills the next night, and they are still alive',
  'mafia.bot.why.poisonSurvived.2':
    'they said poisoned on night {night}, and poison kills the next night. They are here',
  'mafia.bot.why.poisonSurvived.3': 'nobody says they healed them, and the poison they claimed never killed them',
  'mafia.bot.why.visitedCorpse.1': 'they say they visited {who} on night {night}, and {who} was already dead by then',
  'mafia.bot.why.visitedCorpse.2': 'they claim a visit to {who} on night {night}, but {who} had already been killed',
  'mafia.bot.why.visitedCorpse.3': 'their own account has them visiting a house whose owner was already dead',
  'mafia.bot.why.guardedNoDeath.1':
    'they say a bodyguard died protecting them on night {night}, and nobody died that night',
  'mafia.bot.why.guardedNoDeath.2': 'a bodyguard who saves you dies doing it, and nobody died on night {night}',
  'mafia.bot.why.guardedNoDeath.3': 'nobody was killed on night {night}, so no bodyguard died protecting anyone',
  'mafia.bot.why.twoInCell.1': 'they and {who} both say the jailor held them on night {night}, and the cell holds one',
  'mafia.bot.why.twoInCell.2': 'two people cannot be in the cell on the same night, and {who} claims night {night} too',
  'mafia.bot.why.twoInCell.3': 'one of them and {who} is lying about being jailed on night {night}',
  'mafia.bot.why.actedFromCell.1':
    'they say the jailor held them on night {night} and that they visited someone the same night',
  'mafia.bot.why.actedFromCell.2': 'nobody acts from the cell, and they claim both for night {night}',
  'mafia.bot.why.actedFromCell.3': 'you cannot be jailed and visiting a house on the same night, and they claim both',
  'mafia.bot.why.impossibleAilment.1': 'they say they were {what}, and nobody alive could have done that',
  'mafia.bot.why.impossibleAilment.2': 'they claim they were {what}. Check the role list: nobody left can do it',
  'mafia.bot.why.impossibleAilment.3':
    'the role that leaves somebody {what} is not in this game, or it is already dead',
  'mafia.bot.why.roleNotInPlay.1': 'they claimed {role}, and this game never dealt a {role}',
  'mafia.bot.why.roleNotInPlay.2': 'there is no {role} in this game. It is on the role list',
  'mafia.bot.why.roleNotInPlay.3': '{role} was never dealt, so that claim is invented',
  /**
   * The same catch one step on: the roster allowed the badge and the graveyard
   * has since used up every slot that could have been it. Said with the corpses
   * named, because that is the half the room can check. See `no-slot-left`.
   */
  'mafia.bot.why.noSlotLeft.1': 'every slot that could have been {role} is in the graveyard already',
  'mafia.bot.why.noSlotLeft.2': 'count the list: there is nowhere left at this table for a {role} to be',
  'mafia.bot.why.noSlotLeft.3': 'the {role} slots are all accounted for, so that badge cannot exist any more',
  'mafia.bot.why.noRoomForAll.1': 'you and {who} both claim {role}, and the list has room for one of you',
  'mafia.bot.why.noRoomForAll.2': 'count the slots: {role} fits once, and {who} claims it too',
  'mafia.bot.why.noRoomForAll.3': 'one of you and {who} is lying about being {role}, the roster says so',
  'mafia.bot.why.relayDenied.1': 'they quoted {who}, and {who} says they never said it',
  'mafia.bot.why.relayDenied.2': 'they said {who} told them that, and {who} denies it',
  'mafia.bot.why.relayDenied.3': 'they put those words in {who}’s mouth and {who} says no',
  'mafia.bot.why.brokenPromise.1': 'they asked for one more night to prove it, and then proved nothing',
  'mafia.bot.why.brokenPromise.2': 'we gave them the night they wanted, and they did nothing with it',
  'mafia.bot.why.brokenPromise.3': 'they promised proof by morning and morning came with nothing',
  'mafia.bot.case.doorstep.1': 'someone saw you visiting {at} on night {night}, and {at} was killed that night',
  'mafia.bot.case.doorstep.2': 'a watcher saw you go to {at}’s house on night {night}, the night {at} was killed',
  'mafia.bot.case.admitted.1': 'you said yourself you visited {at} on night {night}, the night {at} was killed',
  'mafia.bot.case.admitted.2': 'by your own account you were at {at}’s house on the night {at} died',
  'mafia.bot.case.caughtLying.1': 'you said you stayed home, and someone saw you visiting a house that night',
  'mafia.bot.case.caughtLying.2': 'your alibi is that you never left, and a watcher says you did',
  'mafia.bot.case.wasOut.1': 'someone saw you visiting a house on night {night}',
  'mafia.bot.case.wasOut.2': 'a watcher reported you visiting someone on night {night}',
  'mafia.bot.case.badge.1': 'nobody has ever disputed your {role} claim, which is what a fake one does',
  'mafia.bot.case.badge.2': 'you claimed {role} and not one person has stood up against it all game',
  'mafia.bot.case.savedKillers.1': 'you voted innocent on people who turned out to be killers',
  'mafia.bot.case.savedKillers.2': 'you have voted to spare killers before',
  'mafia.bot.case.pushedByPlain.1': '{other} has you at the top of their list',
  'mafia.bot.case.pushedByPlain.2': '{other} named you today and I think they are right',
  'mafia.bot.case.pushedBy.1': '{other} accused you and you have not answered',
  'mafia.bot.case.pushedBy.2': '{other} named you and you have said nothing back',
  'mafia.bot.case.namedInAWill.1': '{other} wrote your name down before they died',
  'mafia.bot.case.namedInAWill.2': 'you are in {other}’s will, and {other} is past arguing about it',
  'mafia.bot.case.accuserSilenced.1': 'you were accused by {other}, and {other} was dead by morning',
  'mafia.bot.case.accuserSilenced.2': '{other} pointed at you and did not live to say it twice',
  'mafia.bot.case.ledTownWagon.1': 'you started the wagon on {at} on day {day}, and {at} was town',
  'mafia.bot.case.ledTownWagon.2': 'the case against {at} was yours, on day {day}, and we hanged a townsperson for it',
  'mafia.bot.for.ledKillerWagon.1': 'they were the first name on {at}, back on day {day}, and they were right',
  'mafia.bot.for.ledKillerWagon.2': 'they opened the case on {at} while the rest of us were still guessing',
  'mafia.bot.for.neverOut.1': 'nobody has ever reported them visiting anyone',
  'mafia.bot.for.neverOut.2': 'no watcher has ever named them on any night',
  'mafia.bot.for.vouched.1': '{other} says they are innocent',
  'mafia.bot.for.vouched.2': '{other} has already cleared them',
  'mafia.bot.for.hangedKillers.1': 'they voted guilty on people who turned out to be killers',
  'mafia.bot.for.hangedKillers.2': 'they have been right about the people we hanged',
  'mafia.bot.for.nothingBroken.1': 'nothing they have claimed has been disproved',
  'mafia.bot.for.nothingBroken.2': 'nobody has caught them in anything all game',
  'mafia.bot.case.open.1': '{who}. {reasons}.',
  'mafia.bot.case.open.2': 'I am on {who}. {reasons}.',
  'mafia.bot.case.open.3': '{who}. {reasons}. That is enough for me.',
  'mafia.bot.for.open.1': 'Leave {who} out of it. {reasons}.',
  'mafia.bot.for.open.2': '{who} is the wrong seat. {reasons}.',
  'mafia.bot.for.open.3': 'Not {who}. {reasons}.',
  'mafia.bot.skip.lastCall.1': 'Last call: has anybody got anything at all? Otherwise we waste the day.',
  'mafia.bot.skip.lastCall.2': 'Before we throw the day away, any checks? Any visitors? Anything?',
  'mafia.bot.skip.lastCall.3': 'Speak now if you were out last night. I am voting to hang nobody otherwise.',
  'mafia.bot.skip.lastCall.4': 'Anyone holding something? Say it now, or we skip and pay for it tonight.',
  'mafia.bot.lodge.recruit.1': 'I am bringing {who} into the lodge tonight. Leave them alone tomorrow.',
  'mafia.bot.lodge.recruit.2': '{who} joins us tonight. Do not put them on the stand.',
  'mafia.bot.lodge.recruit.3': 'Tonight I initiate {who}. Treat them as one of ours.',
  'mafia.bot.lodge.watch.1': 'Watch {who}: {why}.',
  'mafia.bot.lodge.watch.2': 'It is {who} for me: {why}.',
  'mafia.bot.lodge.watch.3': 'Keep an eye on {who}, because {why}.',
  'mafia.bot.lodge.plain.1': '{who} is the one I would hang tomorrow, for what it is worth.',
  'mafia.bot.lodge.plain.2': 'Nothing solid, but I do not like {who}.',
  'mafia.bot.lodge.plain.3': 'If it goes to a vote tomorrow, I am on {who}.',
  'mafia.bot.case.confessed.1': 'they told us themselves they are the {role}',
  'mafia.bot.case.confessed.2': 'they said out loud they are the {role}',
  'mafia.bot.case.confessedPlain.1': 'they told us themselves which side they are on',
  'mafia.bot.case.confessedPlain.2': 'they said out loud they are one of the killers',
  'mafia.bot.family.mine.1': 'I have {who} tonight. Do what you like with the knife.',
  'mafia.bot.family.mine.2': '{who} is mine this evening. Work around it.',
  'mafia.bot.family.mine.3': 'I am spending the night on {who}.',
  'mafia.bot.verdict.guilty.why.1': 'Guilty: {why}.',
  'mafia.bot.verdict.guilty.why.2': 'Guilty, and here is why: {why}.',
  'mafia.bot.verdict.guilty.why.3': 'I am voting guilty, because {why}.',
  'mafia.bot.verdict.guilty.plain.1': 'Guilty. Somebody hangs today, and {who} is the best name we have.',
  'mafia.bot.verdict.guilty.plain.2': 'Guilty on {who}. Nobody has given me a better one.',
  'mafia.bot.verdict.guilty.plain.3': 'Guilty. We are out of days to be careful with.',
  'mafia.bot.verdict.innocent.plain.1': 'Innocent. There is nothing on {who} but the crowd.',
  'mafia.bot.verdict.innocent.plain.2': 'Innocent. We put {who} up here on a hunch and the hunch has not improved.',
  'mafia.bot.verdict.innocent.plain.3': 'Innocent. Bring me something checkable and I will change my mind.',
  'mafia.bot.verdict.turned.why.1': 'I put {who} up there, and I am voting innocent: {why}.',
  'mafia.bot.verdict.turned.why.2': 'My name is on that wagon and I am voting innocent anyway, because {why}.',
  'mafia.bot.verdict.turned.why.3': 'I wanted {who} up here. Innocent, and here is what changed: {why}.',
  'mafia.bot.verdict.turned.plain.1': 'I put {who} up there and I am voting innocent. The defence answered me.',
  'mafia.bot.verdict.turned.plain.2': 'I wanted {who} on the stand. I heard them out, and I am voting innocent.',
  'mafia.bot.verdict.turned.plain.3': 'My vote put {who} here and I am taking it back. Innocent.',
  'mafia.bot.whisper.role.1': 'Between us: I am the {role}. You asked, so you have it.',
  'mafia.bot.whisper.role.2': 'Quietly, and only to you: {role}. Do what you like with it.',
  'mafia.bot.whisper.role.3': 'You are the one seat I know is not a wolf, so: {role}.',
  'mafia.bot.whisper.role.4': '{role}. Saying it out there gets me killed tonight, saying it to you does not.',
  'mafia.bot.why.ledTownWagon.1': 'they opened the wagon on {at} back on day {day}, and {at} was town',
  'mafia.bot.why.ledTownWagon.2': 'the case against {at} on day {day} was theirs, and we hanged a townsperson for it',
  'mafia.bot.why.ledTownWagon.3': 'they were the first name on {at} on day {day}, and {at} was innocent',
  'mafia.bot.why.accuserSilenced.1': '{other} accused them and was dead by morning',
  'mafia.bot.why.accuserSilenced.2': 'the seat that pointed at them, {other}, did not live to say it twice',
  'mafia.bot.why.accuserSilenced.3': '{other} named them and was killed that same night',
  'mafia.bot.why.willQuote.1': '{who} wrote it down before they died: “{line}”',
  'mafia.bot.why.willQuote.2': 'it is in {who}’s will, word for word: “{line}”',
  'mafia.bot.why.willQuote.3': 'read {who}’s will again: “{line}”',
  'mafia.bot.why.willNames.1': '{who} named them in their will, and {who} is not here to take it back',
  'mafia.bot.why.willNames.2': 'a dead player wrote their name down. {who} did, and it cost them',
  'mafia.bot.why.willNames.3': '{who} put them in writing before they were killed',
  'mafia.bot.why.contradiction.1': 'they said they stayed home, and {who} saw them visiting someone that night',
  'mafia.bot.why.contradiction.2': 'their alibi is that they never left, and {who} watched them go to a house',
  'mafia.bot.why.contradiction.3': '{who} saw them visiting someone on a night they claim they stayed in',
  'mafia.bot.why.seen.1': '{who} saw them visiting a house on night {night}',
  'mafia.bot.why.seen.2': 'on night {night}, {who} watched them go to someone’s house',
  'mafia.bot.why.seen.3': '{who} reported them visiting someone on night {night}',
  'mafia.bot.why.check.1': 'I checked them on night {night} and the result came back guilty',
  'mafia.bot.why.check.2': 'my check on them on night {night} came back guilty',
  'mafia.bot.why.check.3': 'I investigated them on night {night} and it was not clean',
  'mafia.bot.why.checkNamed.1': 'I checked them on night {night} and the result was {what}',
  'mafia.bot.why.checkNamed.2': 'my night {night} check on them came back {what}',
  'mafia.bot.why.checkNamed.3': 'I investigated them on night {night} and found {what}',
  'mafia.bot.why.admitted.1': 'they told us themselves they visited {who} on night {night}',
  'mafia.bot.why.admitted.2': 'by their own account they went to {who}’s house on night {night}',
  'mafia.bot.why.admitted.3': 'they admitted visiting {who} on night {night}',
  'mafia.bot.why.doubleClaim.1': 'they and {who} both claim to be the {role}, so one of them is lying',
  'mafia.bot.why.doubleClaim.2': 'two people claim to be the {role}: them and {who}',
  'mafia.bot.why.doubleClaim.3': 'they claim {role} and so does {who}, and there is only one',
  'mafia.bot.why.myBadge.1': 'I am the {role}, so their claim is false',
  'mafia.bot.why.myBadge.2': 'they claimed my role. I am the {role}',
  'mafia.bot.why.myBadge.3': 'I am the {role}, which means they cannot be',
  'mafia.bot.why.silent.1': 'they have not made a single claim all game',
  'mafia.bot.why.silent.2': 'they have told us nothing at all since day one',
  'mafia.bot.why.silent.3': 'a whole game without saying anything is a choice',
  'mafia.bot.why.buddy.1': 'they and {who} have never once voted against each other',
  'mafia.bot.why.buddy.2': 'they and {who} vote together every day and never against each other',
  'mafia.bot.why.buddy.3': 'not once all game has their vote gone to {who}, or {who}’s to them',
  'mafia.bot.why.wagon.1': 'people are voting for them and they have not answered any of it',
  'mafia.bot.why.wagon.2': 'the room is voting for them and they have said nothing back',
  'mafia.bot.why.wagon.3': 'they have not answered a single one of those votes',
  /**
   * The same citation without the jab, for when the jab is not true.
   *
   * See `spokeSince`: "and they never answered" is a second fact, and a seat
   * that has answered is owed the version that does not say otherwise.
   */
  'mafia.bot.why.pushedBy.1': '{who} has them at the top of their list',
  'mafia.bot.why.pushedBy.2': '{who} named them today and I think {who} is right',
  'mafia.bot.why.pushedBy.4': '{who} is pushing them and I have nothing better',
  'mafia.bot.why.pushedBy.5': 'I am following {who} on this one',
  'mafia.bot.why.pushedBy.6': '{who} got there first and the case reads',
  'mafia.bot.why.pushedBy.3': '{who} is on them, and that is good enough to look',
  'mafia.bot.why.wagonPlain.1': 'half the room is already voting for them',
  'mafia.bot.why.wagonPlain.2': 'the votes are piling up on them and I am not going to be the one to move them off',
  'mafia.bot.why.wagonPlain.3': 'the room has made its mind up about them',
  'mafia.bot.why.ownBadge.1': 'they claimed {role} and not one person has disputed it all game',
  'mafia.bot.why.ownBadge.2': 'nobody has stood up against their {role} claim, which is what a fake one does',
  'mafia.bot.why.ownBadge.3': 'their {role} claim has gone unchallenged the whole game',
  'mafia.bot.why.savedKillers.1': 'they voted innocent on people who turned out to be killers',
  'mafia.bot.why.savedKillers.2': 'they have voted to spare killers before',
  'mafia.bot.why.savedKillers.3': 'when we had a killer on the stand, they voted to let them go',
  'mafia.bot.why.nowhere.1': 'they have never told us where they were on any night',
  'mafia.bot.why.nowhere.2': 'they have never given an account of a single night',
  'mafia.bot.why.nowhere.3': 'not one of their nights is on the record',
  'mafia.bot.why.accused.1': '{who} accused them and they never answered it',
  'mafia.bot.why.accused.2': '{who} named them and they have not answered',
  'mafia.bot.why.accused.4': '{who} put them on the board and nothing came back',
  'mafia.bot.why.accused.5': 'they were named by {who} and have let it stand',
  'mafia.bot.why.accused.6': '{who} called them out and they have not touched it since',
  'mafia.bot.why.accused.3': '{who} accused them and nothing came back',
  'mafia.bot.why.badge.1': '{who} claims to be the {role}, and accused them',
  'mafia.bot.why.badge.2': 'the {role} is {who}, and they have accused them',
  'mafia.bot.why.badge.3': '{who} claimed {role} and put them at the top of the list',
  /**
   * The Investigator's nose, as a reason.
   *
   * `{line}` is the trade itself — "smells of gunpowder", "has new rope" — and
   * it is a shortlist rather than a name: several roles share each smell, and
   * which ones is public. So this only ever goes on an accusation when every
   * role still on that shortlist is somebody's enemy. See `tradeVerdict`.
   */
  'mafia.bot.why.trade.1': 'I examined them on night {night}: {line}',
  'mafia.bot.why.trade.2': 'my night {night} examination of them came back: {line}',
  'mafia.bot.why.trade.3': 'I looked into them on night {night}: {line}',

  /* ------------------------- and why one is worth keeping ------------------- */
  'mafia.bot.whyClear.mine.1': 'I checked them on night {night} and the result came back clean',
  'mafia.bot.whyClear.mine.2': 'my night {night} check on them was clean',
  'mafia.bot.whyClear.mine.3': 'I investigated them on night {night} and found nothing',
  'mafia.bot.whyClear.vouched.1': '{who}, who claims to be the {role}, says they are innocent',
  'mafia.bot.whyClear.vouched.2': 'the {role} is {who}, and they have already cleared them',
  'mafia.bot.whyClear.vouched.3': '{who} claimed {role} and said they are clean',
  'mafia.bot.whyClear.accounted.1': 'they told us where they were and nobody has contradicted it',
  'mafia.bot.whyClear.accounted.2': 'their account of the night is on the record and nobody has broken it',
  'mafia.bot.whyClear.accounted.3': 'nobody has caught them lying about a single night',
  'mafia.bot.whyClear.trade.1': 'I examined them on night {night}: {line}, which is a town result here',
  'mafia.bot.whyClear.trade.2': 'my night {night} examination came back: {line}, and that is town on this role list',
  'mafia.bot.whyClear.trade.3': 'my examine put them in the town half of the list',

  /* --------------------- the same move, with the reason on it --------------- */
  'mafia.bot.accuseWhy.1': 'It is {who}: {why}.',
  'mafia.bot.accuseWhy.2': 'Voting {who}: {why}.',
  'mafia.bot.accuseWhy.3': 'Voting {who}, because {why}.',
  'mafia.bot.accuseWhy.4': '{who}. Reason: {why}.',
  'mafia.bot.accuseWhy.5': 'It is {who} for me: {why}.',
  'mafia.bot.accuseWhy.6': 'Voting {who}, {why}.',
  'mafia.bot.accuseWhy.7': 'Voting {who}: {why}, and no answer yet.',
  'mafia.bot.accuseWhy.8': 'On {who}: {why}.',
  'mafia.bot.accuseWhy.9': '{who}: {why}. Enough for me.',
  'mafia.bot.clearWhy.1': 'Not {who}, {why}.',
  'mafia.bot.clearWhy.2': 'Leave {who}: {why}.',
  'mafia.bot.clearWhy.3': '{who} is not the one: {why}.',
  'mafia.bot.clearWhy.4': 'Off {who}: {why}.',
  'mafia.bot.clearWhy.5': 'Not {who}: {why}. Settled for me.',
  'mafia.bot.clearWhy.6': 'Not {who}, because {why}.',
  /**
   * The accusation with the speaker's own neck on it.
   *
   * Only for a finding that names a role outright — a Consigliere's examine, or
   * a trade line whose whole shortlist is one camp — because that is the only
   * evidence worth this much. It is the strongest move the game has: it
   * converts a claim nobody can check into a bet the room *can* settle
   * tomorrow, and a liar who makes it has one day to live. Which is exactly why
   * a liar sometimes makes it.
   */
  'mafia.bot.stake.role.1': '{who} is the {role}. If I am wrong, hang me tomorrow.',
  'mafia.bot.stake.role.2': '{who} is the {role}. Wrong, and you can have me next.',
  'mafia.bot.stake.role.3': 'I will stake my life: {who} is the {role}.',
  'mafia.bot.stake.role.4': '{who} is the {role}. If I am wrong, I will not argue when you come for me.',
  'mafia.bot.stake.role.5': 'Put me up tomorrow if {who} is not the {role}.',
  'mafia.bot.stake.role.6': '{who} is the {role}, and I am betting my life on it.',
  'mafia.bot.stake.faction.1': '{who} is {faction}. If I am wrong, hang me tomorrow.',
  'mafia.bot.stake.faction.2': '{who} is {faction}. Wrong, and you can have me next.',
  'mafia.bot.stake.faction.3': 'I will stake my life: {who} is {faction}.',
  'mafia.bot.stake.faction.4': '{who} is {faction}. If I am wrong, I will not argue when you come for me.',
  'mafia.bot.stake.faction.5': 'Put me up tomorrow if {who} is not {faction}.',
  'mafia.bot.stake.faction.6': '{who} is {faction}, and I am betting my life on it.',

  /* ------------------------ answering a wagon, and why ---------------------- */
  /**
   * A denial with a reason, and a denial with nothing.
   *
   * The reason comes from `denyWhy`, which reads the board as `why` does. The
   * plain form is what is left when there is nothing: it denies and demands,
   * which is all an innocent has, and it never invents an alibi on the accused's
   * behalf. "{who} is lying about me. I never left my house" did exactly that,
   * every sixth denial, whatever the seat had done with its night.
   */
  'mafia.bot.deny.why.1': '{who} is lying about me: {why}.',
  'mafia.bot.deny.why.2': 'Not true, {who}: {why}.',
  'mafia.bot.deny.why.3': '{who} has this wrong: {why}.',
  'mafia.bot.deny.why.4': 'No, {who} is wrong, and {why}.',
  'mafia.bot.deny.why.5': 'Wrong, {who}: {why}.',
  'mafia.bot.deny.why.6': '{who} is wrong about me, and {why}.',
  'mafia.bot.deny.plain.1': '{who} is wrong about me.',
  'mafia.bot.deny.plain.2': 'No. Which night, {who}?',
  'mafia.bot.deny.plain.3': '{who} is wrong, or covering for somebody.',
  'mafia.bot.deny.plain.4': 'That is a lie, {who}. Name the house.',
  'mafia.bot.deny.plain.5': '{who} is wrong. Ask them which night.',
  'mafia.bot.deny.plain.6': 'Not true, {who}. Give me something checkable.',
  'mafia.bot.denyWhy.toldHome.1': 'I already gave my night, and it was home',
  'mafia.bot.denyWhy.toldHome.2': 'I said I stayed in and I am not moving off it',
  'mafia.bot.denyWhy.toldHome.3': 'my account has not changed since I gave it',
  'mafia.bot.denyWhy.toldVisited.1': 'I already told you I was at {house}',
  'mafia.bot.denyWhy.toldVisited.2': 'my account has said {house} from the start',
  'mafia.bot.denyWhy.toldVisited.3': 'I said {house} before any of this',
  'mafia.bot.denyWhy.theirSilence.1': 'they have not given a night of their own',
  'mafia.bot.denyWhy.theirSilence.2': 'they have said nothing about their own nights',
  'mafia.bot.denyWhy.theirSilence.3': 'I am still waiting to hear where they were',
  'mafia.bot.denyWhy.theirCaught.1': 'they have been caught out once already',
  'mafia.bot.denyWhy.theirCaught.2': 'they have been contradicted already',
  'mafia.bot.denyWhy.theirCaught.3': 'they are the one the room caught, not me',
  'mafia.bot.denyWhy.alone.1': 'they are the only one saying it',
  'mafia.bot.denyWhy.alone.2': 'nobody else has said anything of the kind',
  'mafia.bot.denyWhy.alone.3': 'one person is saying this and nobody has backed them',

  /* ------------------------------- on the stand ----------------------------- */
  'mafia.bot.defend.accuser.1': '{who} started this. Why is nobody looking at them?',
  'mafia.bot.defend.accuser.2': 'This all came from {who}. Ask them for one checkable thing.',
  'mafia.bot.defend.accuser.3': 'The votes followed {who}. Start there, not with me.',
  /**
   * The same stand, for a badge with no power behind it.
   *
   * `defend.role` threatens the room with what hanging you costs it, which is
   * nothing when the badge is Citizen. See the call site in `stand`.
   */
  'mafia.bot.defend.rolePlain.1': 'I am the {role}. That is all I am, and it is the truth.',
  'mafia.bot.defend.rolePlain.2': 'I am the {role}. No power, nothing to show you, and still not your killer.',
  'mafia.bot.defend.rolePlain.3': 'The {role}. I know it proves nothing. It is what I have.',
  'mafia.bot.defend.role.1': 'I am the {role}. Hang me and you will see it on my body tomorrow.',
  'mafia.bot.defend.role.2': 'I am the {role}. Hang me and the town loses its {role}.',
  'mafia.bot.defend.role.3': '{role}. That is my defence.',
  'mafia.bot.defend.visited.1': 'I was at {who} on night {night}. That is on the record.',
  'mafia.bot.defend.visited.2': '{who}, night {night}. That is what I said.',
  'mafia.bot.defend.visited.3': 'I told you where I was: {who}, night {night}. Check it.',
  /** Asks rather than asserts, because the seat may well have been named. */
  'mafia.bot.defend.nothing.1': 'Name the thing I did.',
  'mafia.bot.defend.nothing.2': 'If there is a case, make it.',
  'mafia.bot.defend.nothing.3': 'Somebody say what I actually did.',
  /**
   * The gag, on the stand.
   *
   * A blackmailed seat cannot speak at all — `chatRules` refuses it — so the
   * engine says this on its behalf when the trial opens. A seat that *can*
   * speak and says it anyway is bluffing, and the bluff is only worth trying
   * from somebody who has been quiet all day. Then it stays quiet, because a
   * muted person would.
   */
  'mafia.bot.muted.1': 'I am muted.',
  'mafia.bot.muted.2': 'I am muted. I cannot answer.',
  'mafia.bot.muted.3': 'Muted. That is all I can give you.',

  /* ---------------------- something was done to me last night --------------- */
  'mafia.bot.poisoned.1': 'I was poisoned. Doctor, I need you tonight.',
  'mafia.bot.poisoned.2': 'Poisoned last night. Without a doctor I am dead by morning.',
  'mafia.bot.poisoned.3': 'Poisoned. One night left.',
  'mafia.bot.poisoned.4': 'There is a poisoner and it came to me. Doctor, tonight.',
  'mafia.bot.poisoned.5': 'I am dead at dawn without a heal.',
  'mafia.bot.poisoned.6': 'Poisoned. Tomorrow I am a body.',
  'mafia.bot.doused.1': 'I woke up smelling of petrol. There is an arsonist.',
  'mafia.bot.doused.2': 'The arsonist doused me last night.',
  'mafia.bot.doused.3': 'Petrol on my step. The arsonist is working.',
  'mafia.bot.doused.4': 'I am doused. Remember somebody chose my house.',
  'mafia.bot.doused.5': 'The arsonist came to me. Watch who was out.',
  'mafia.bot.doused.6': 'Doused last night. Nothing cures that.',
  /**
   * Somebody came for me and I am still here.
   *
   * The most valuable thing a town seat can say, and until now it lived only in
   * a private notification. Each reports exactly what the engine told the seat:
   * a heal says a doctor is alive and was pointed here, a bodyguard says there
   * is a corpse in the square that belongs to this doorway, and `survived` says
   * only that the seat is breathing — which is why it names nobody.
   */
  'mafia.bot.healed.1': 'A doctor healed me last night.',
  'mafia.bot.healed.2': 'They came for me and a doctor got there first.',
  'mafia.bot.healed.3': 'Healed last night. There is a doctor at this table.',
  'mafia.bot.healed.4': 'I should be dead. A doctor saved me.',
  'mafia.bot.healed.5': 'Somebody tried me last night. A doctor stopped it.',
  'mafia.bot.healed.6': 'Healed. Whoever you are, thank you.',
  'mafia.bot.guarded.1': 'A bodyguard died in my doorway last night.',
  'mafia.bot.guarded.2': 'They came for me. A bodyguard took it instead.',
  'mafia.bot.guarded.3': 'That corpse this morning is the bodyguard who stood in front of me.',
  'mafia.bot.guarded.4': 'I was the target. A bodyguard died for it.',
  'mafia.bot.guarded.5': 'A bodyguard died at my door last night. That is the body you found.',
  'mafia.bot.guarded.6': 'They tried me and a bodyguard paid for it.',
  'mafia.bot.survived.1': 'Somebody came for me and I am still here.',
  'mafia.bot.survived.2': 'They tried to kill me last night and it failed.',
  'mafia.bot.survived.3': 'I was attacked last night and I lived.',
  'mafia.bot.survived.4': 'Somebody picked my house. It did not work.',
  'mafia.bot.survived.5': 'There was an attack on me. I am fine.',
  'mafia.bot.survived.6': 'They came, and I am still standing.',
  /**
   * And the day after a gag. It cannot be said while it is on, so it is always
   * about yesterday — and it exists because `why.silent` votes people for
   * saying nothing.
   */
  'mafia.bot.silenced.1': 'I was blackmailed yesterday.',
  'mafia.bot.silenced.2': 'I was gagged yesterday. That is why I said nothing.',
  'mafia.bot.silenced.3': 'A blackmailer gagged me. I could not say a word yesterday.',
  'mafia.bot.silenced.4': 'Blackmailed yesterday. Somebody here sends those letters.',
  'mafia.bot.silenced.5': 'I was not quiet by choice yesterday.',
  'mafia.bot.silenced.6': 'Gagged yesterday. Do not read it as anything else.',
  /**
   * Somebody got in my way last night.
   *
   * The three morning sentences every real table hears, and until now no bot
   * could say: each explains a missing or wrong result and proves a role is at
   * the table. A Sheriff with no page for last night says the first one before
   * anything else.
   */
  'mafia.bot.blocked.1': 'I was roleblocked last night.',
  'mafia.bot.blocked.2': 'Somebody kept me home last night. No result.',
  'mafia.bot.blocked.3': 'Roleblocked. I got nothing last night.',
  'mafia.bot.blocked.4': 'I was blocked last night. Somebody here keeps people home.',
  'mafia.bot.blocked.5': 'No result from me: I was roleblocked.',
  'mafia.bot.blocked.6': 'My power did not go off last night. Somebody blocked me.',
  'mafia.bot.controlled.1': 'I was controlled last night.',
  'mafia.bot.controlled.2': 'A witch moved me last night. Whatever I did, I did not choose it.',
  'mafia.bot.controlled.3': 'Witched last night. There is a witch at this table.',
  'mafia.bot.controlled.4': 'Somebody redirected me last night.',
  'mafia.bot.controlled.5': 'I was sent somewhere I did not pick last night.',
  'mafia.bot.controlled.6': 'Controlled. Do not read my night as mine.',
  'mafia.bot.jailed.1': 'I was in the cell last night.',
  'mafia.bot.jailed.2': 'The jailor had me last night. No result from me.',
  'mafia.bot.jailed.3': 'I spent last night in jail. Ask the jailor.',
  'mafia.bot.jailed.4': 'Jailed last night, so I did nothing.',
  'mafia.bot.jailed.5': 'I was locked up last night. Whoever holds the keys can say so.',
  'mafia.bot.jailed.6': 'In the cell all night. That is my alibi.',
  'mafia.bot.bussed.1': 'I was transported last night.',
  'mafia.bot.bussed.2': 'A bus driver moved me last night. Anything aimed at me landed elsewhere.',
  'mafia.bot.bussed.3': 'Transported. Whoever checked me last night checked somebody else.',
  'mafia.bot.bussed.4': 'I was swapped last night. There is a bus driver at this table.',
  'mafia.bot.bussed.5': 'Somebody switched my house last night.',
  'mafia.bot.bussed.6': 'Bussed. Results on me from last night are off.',

  /* ------------------------------ the family room --------------------------- */
  'mafia.bot.family.aim.1': 'Tonight: {who}, {why}.',
  'mafia.bot.family.aim.2': '{who}: {why}.',
  'mafia.bot.family.aim.3': '{who}, because {why}.',
  'mafia.bot.family.aim.4': '{who} tonight: {why}.',
  'mafia.bot.family.aim.5': 'Take {who}: {why}.',
  'mafia.bot.family.aim.6': 'My pick is {who}, {why}.',
  'mafia.bot.family.aim.7': '{who}: {why}. Better ideas?',
  'mafia.bot.family.aim.8': 'It has to be {who}: {why}.',
  'mafia.bot.family.aim.9': '{who}, {why}. Before it gets worse.',
  'mafia.bot.family.plain.1': 'Tonight: {who}.',
  'mafia.bot.family.plain.2': '{who}. Nobody will miss them.',
  'mafia.bot.family.plain.3': '{who}, unless somebody has a name.',
  'mafia.bot.family.plain.4': 'I want {who}.',
  'mafia.bot.family.plain.5': '{who}. Out of the way after tonight.',
  'mafia.bot.family.plain.6': 'Put it on {who} and let us sleep.',
  'mafia.bot.family.why.claimed.1': 'they are claiming {role} in the square',
  'mafia.bot.family.why.claimed.2': 'they said {role} out loud',
  'mafia.bot.family.why.claimed.3': 'the square has them as the {role} now',
  'mafia.bot.family.why.talker.1': 'they are clearing people and the town listens',
  'mafia.bot.family.why.talker.2': 'they keep clearing people and the room believes them',
  'mafia.bot.family.why.talker.3': 'every day they cross a name off and the town follows',
  'mafia.bot.family.why.trusted.1': 'the square believes them now',
  'mafia.bot.family.why.trusted.2': 'they have the room’s ear',
  'mafia.bot.family.why.trusted.3': 'nobody argues with them any more',
  'mafia.bot.family.why.pushing.1': 'they spent today pushing {who} of ours',
  'mafia.bot.family.why.pushing.2': 'they have been on {who} all afternoon',
  'mafia.bot.family.why.pushing.3': 'they will have {who} hanged by tomorrow',
  'mafia.bot.family.why.quiet.1': 'nobody has asked them anything',
  'mafia.bot.family.why.quiet.2': 'no claim, no question, no wagon',
  'mafia.bot.family.why.quiet.3': 'they are invisible',
  'mafia.bot.family.hush': 'No names, no numbers, no roles in here. A spy can hear this room.',
  'mafia.bot.family.hush.agree.1': 'Yes. Tonight. Nothing more in here.',
  'mafia.bot.family.hush.agree.2': 'Agreed. Do not say it again, someone may be listening.',
  'mafia.bot.family.hush.agree.3': 'Fine, that one. No more names in this room.',
  'mafia.bot.family.hush.refuse.1': 'No, not that one. Not in here. Give me a reason tomorrow.',
  'mafia.bot.family.hush.refuse.2': 'I would rather not. And keep it vague in here, a spy can hear us.',
  'mafia.bot.family.hush.refuse.3': 'Not tonight. No names in this room.',
  'mafia.bot.family.hush.reply.1': 'Heard. Not in here, someone may be listening.',
  'mafia.bot.family.hush.reply.2': 'Understood. No names or numbers in this room.',
  'mafia.bot.family.hush.reply.3': 'I hear you. Keep it vague in here.',
  'mafia.bot.family.agree.1': '{who} then.',
  'mafia.bot.family.agree.2': 'Fine, {who}.',
  'mafia.bot.family.agree.3': '{who} it is.',
  'mafia.bot.family.agree.4': 'Agreed: {who}.',
  'mafia.bot.family.agree.5': '{who}. Good enough.',
  'mafia.bot.family.agree.6': 'Done. {who}.',
  'mafia.bot.family.refuse.why.1': 'Not {who}. {mine}, because {why}.',
  'mafia.bot.family.refuse.why.2': '{who} can wait. {mine} tonight, {why}.',
  'mafia.bot.family.refuse.why.3': 'No. {mine}: {why}.',
  'mafia.bot.family.refuse.mine.1': 'Not {who}. {mine} matters more tonight.',
  'mafia.bot.family.refuse.mine.2': '{who} can wait. {mine} cannot.',
  'mafia.bot.family.refuse.mine.3': 'I want {mine}, not {who}.',
  'mafia.bot.family.refuse.plain.1': 'Not {who}. Give me a reason.',
  'mafia.bot.family.refuse.plain.2': 'Why {who}?',
  'mafia.bot.family.refuse.plain.3': '{who}? What have they done?',
  'mafia.bot.family.warn.1': 'They had {count} on {who} today.',
  'mafia.bot.family.warn.2': '{count} votes on {who} this afternoon. That is a problem.',
  'mafia.bot.family.warn.3': '{who} took {count} today. One of us is next.',
  'mafia.bot.family.told.1': 'For the record, I told them I was {claim}.',
  'mafia.bot.family.told.2': 'Careful: I claimed {claim} out there.',
  'mafia.bot.family.told.3': 'My story out there is {claim}. Keep to it.',

  /* ------- a night read out loud, from a real record or an invented one ------- */
  'mafia.bot.dump.suspect.1': 'Night {night}: I checked {who}. Bad.',
  'mafia.bot.dump.suspect.2': 'Night {night}, {who}: bad.',
  'mafia.bot.dump.suspect.3': '{who} came back guilty on night {night}.',
  /** The same finding, with the name the needle actually gave it. */
  'mafia.bot.dump.named.1': 'Night {night}: I checked {who}. {what}.',
  'mafia.bot.dump.named.2': 'Night {night}, {who}: {what}.',
  'mafia.bot.dump.named.3': '{who} came back {what} on night {night}.',
  'mafia.bot.dump.clear.1': 'Night {night}: I checked {who}. Clean.',
  'mafia.bot.dump.clear.2': 'Night {night}, {who}: clean.',
  'mafia.bot.dump.clear.3': '{who} came back clean on night {night}.',
  'mafia.bot.dump.visitors.1': 'Night {night}: {who} had visitors, {slots}.',
  'mafia.bot.dump.visitors.2': 'Night {night}, at {who}’s door: {slots}.',
  'mafia.bot.dump.visitors.3': '{who} was visited on night {night} by {slots}.',
  'mafia.bot.dump.nobody.1': 'Night {night}: nobody went near {who}.',
  'mafia.bot.dump.nobody.2': 'Night {night}, {who}: no visitors.',
  'mafia.bot.dump.nobody.3': 'Not one visitor at {who}, night {night}.',
  'mafia.bot.dump.role.1': 'Night {night}: {who} is the {role}.',
  'mafia.bot.dump.role.2': 'Night {night}, exact role: {who} is the {role}.',
  'mafia.bot.dump.role.3': 'Night {night} {who} is {role}.',
  /** The Coroner's page: a body, read. */
  'mafia.bot.dump.autopsy.1': 'Night {night}: I examined {who}’s body. {role}.',
  'mafia.bot.dump.autopsy.2': 'Autopsy, night {night}: {who} was the {role}.',
  'mafia.bot.dump.autopsy.3': '{who} was the {role}. I read the body on night {night}.',
  /**
   * The Investigator reading out a smell, with the shortlist it narrows to.
   *
   * The shortlist is the finding. "Smells of gunpowder" on its own is a riddle;
   * "smells of gunpowder, so one of: Vigilante, Veteran, Mafioso" is something
   * the room can cross-reference against the claims already on the board.
   */
  'mafia.bot.dump.trade.1': 'Night {night}: {who} {line}. One of: {roles}.',
  'mafia.bot.dump.trade.2': '{who} {line}, night {night}. So: {roles}.',
  'mafia.bot.dump.trade.3': 'Examined {who}, night {night}: {line}. One of: {roles}.',
  /**
   * And the same power coming back with nothing, which is not the same sentence.
   *
   * A quiet read has no shortlist: the roles that *wear* the quiet line are
   * three harmless ones, but the roles that can *produce* it are everybody who
   * stayed in that night, so printing "one of: Citizen, Survivor, Amnesiac" was
   * an exoneration the power never issued. Say what was actually learned, which
   * is only that the seat did not go out.
   */
  'mafia.bot.dump.quiet.1': 'Night {night}: I examined {who}. Nothing on them, so they stayed in.',
  'mafia.bot.dump.quiet.2': 'Night {night}, {who}: nothing to find. That is not the same as clean.',
  'mafia.bot.dump.quiet.3': 'Examined {who} on night {night} and came back empty. They had a quiet night, no more than that.',
  'mafia.bot.dump.saved.1': 'Night {night}: somebody came for {who} and I stopped it.',
  'mafia.bot.dump.saved.2': 'Night {night}: {who} was attacked. I was there.',
  'mafia.bot.dump.saved.3': '{who} lived through night {night} because of me.',
  'mafia.bot.dump.tracked.1': 'Night {night}: {who} went out. I followed.',
  'mafia.bot.dump.tracked.2': 'Night {night} I was on {who}, and they left.',
  'mafia.bot.dump.tracked.3': '{who} did not stay in on night {night}.',
  'mafia.bot.dump.blocked.1': 'Night {night}: I held {who} at home.',
  'mafia.bot.dump.blocked.2': 'Night {night}: {who} did nothing. That was me.',
  'mafia.bot.dump.blocked.3': '{who} was kept in on night {night}.',
  'mafia.bot.dump.jailedQuiet.1': 'Night {night}: {who} was in my cell. Nothing came of it.',
  'mafia.bot.dump.jailedQuiet.2': 'I had {who} locked up on night {night}. He sat quiet.',
  'mafia.bot.dump.jailedQuiet.3': 'Night {night} in the cell: {who}, and he reached for nothing.',
  'mafia.bot.dump.jailedTried.1': 'Night {night}: {who} was in my cell, and he tried to work from it.',
  'mafia.bot.dump.jailedTried.2': 'I locked {who} up on night {night}. He reached for something.',
  'mafia.bot.dump.jailedTried.3': 'Night {night}: {who} spent it in my cell and did not sit still.',
  'mafia.bot.dump.controlledKill.1':
    'Night {night}: I took {who}’s hand and sent it at {house}. {house} did not wake up.',
  'mafia.bot.dump.controlledKill.2':
    'I steered {who} onto {house} on night {night}, and {house} died. {who} is carrying something.',
  'mafia.bot.dump.controlledKill.3':
    'Night {night}: {who}’s hand, pointed at {house}. There was a body at {house} in the morning.',
  'mafia.bot.dump.controlledIdle.1': 'Night {night}: I took {who}’s hand and there was nothing in it.',
  'mafia.bot.dump.controlledIdle.2': 'I had {who} on night {night}. He was doing nothing at all.',
  'mafia.bot.dump.controlledIdle.3': 'Night {night}: {who} had no order to give. Make of that what you like.',
  'mafia.bot.dump.swapped.1': 'Night {night}: I swapped {slots}.',
  'mafia.bot.dump.swapped.2': 'Night {night}: {slots} woke up in each other’s houses.',
  'mafia.bot.dump.swapped.3': '{slots} changed places on night {night}. My doing.',
  'mafia.bot.dump.spied.1': 'Night {night}: the family went for {who}.',
  'mafia.bot.dump.spied.2': 'Night {night}: I heard them choose {who}.',
  'mafia.bot.dump.spied.3': 'The knife was on {who}, night {night}. I heard it.',
  /**
   * The same nights, crossed with the dawn report.
   *
   * A Lookout's list is a list; a Lookout's list *on the house that died* is a
   * shortlist of killers, and the two are one entry in the notebook. Each of
   * these says exactly what the record says and what the report said, joined:
   * who called, and that the house was a corpse by morning. The join is public
   * arithmetic anybody with the same two facts would do. Nothing is inferred
   * out loud — "so 6 is the killer" is the room's to say, not the witness's.
   */
  'mafia.bot.dump.visitorsDead.1': 'Night {night}: {slots} visited {who}. {who} died that night.',
  'mafia.bot.dump.visitorsDead.2': '{who} died on night {night}. The visitors that night: {slots}.',
  'mafia.bot.dump.visitorsDead.3': 'The night {who} died, {slots} went in. Night {night}.',
  'mafia.bot.dump.nobodyDead.1': 'Night {night}: nobody visited {who}. {who} died that night.',
  'mafia.bot.dump.nobodyDead.2': '{who} died on night {night} and I saw nobody go in.',
  'mafia.bot.dump.nobodyDead.3': 'No visitor at {who} on night {night}, and {who} was dead by morning.',
  'mafia.bot.dump.trackedDead.1': 'Night {night}: {who} went to {house}. {house} died that night.',
  'mafia.bot.dump.trackedDead.2': 'I followed {who} to {house} on night {night}. {house} is dead.',
  'mafia.bot.dump.trackedDead.3': '{who} was at {house} the night {house} died. Night {night}.',
  'mafia.bot.dump.spiedDead.1': 'Night {night}: the family chose {who}. {who} died.',
  'mafia.bot.dump.spiedDead.2': 'I heard the family pick {who} on night {night}, and {who} died.',
  'mafia.bot.dump.spiedDead.3': '{who} was the family’s target on night {night}. That is the body.',
  'mafia.bot.dump.spiedLived.1': 'Night {night}: the family chose {who}. {who} is still alive.',
  'mafia.bot.dump.spiedLived.2': 'I heard the family pick {who} on night {night}. {who} lived.',
  'mafia.bot.dump.spiedLived.3': '{who} was the family’s target on night {night} and is still here.',
  'mafia.bot.dump.blockedDead.1': 'Night {night}: I held {who} at home. {house} died that night.',
  'mafia.bot.dump.blockedDead.2': '{who} was with me all of night {night}. {house} died.',
  'mafia.bot.dump.blockedDead.3': 'I kept {who} in on night {night}, the night {house} died.',
  'mafia.bot.dump.wentDead.1': 'Night {night}: I went to {who}. {who} died that night.',
  'mafia.bot.dump.wentDead.2': 'I was at {who} on night {night}, and {who} died.',
  'mafia.bot.dump.wentDead.3': '{who} died the night I visited. Night {night}.',
  /** The bus: whatever was aimed at one house arrived at the other. */
  'mafia.bot.dump.swappedDead.1':
    'Night {night}: I swapped {who} and {house}. {who} died, so the killer was going to {house}.',
  'mafia.bot.dump.swappedDead.2':
    'I swapped {who} with {house} on night {night}. {who} died. That knife was for {house}.',
  'mafia.bot.dump.swappedDead.3': '{who} died on night {night} in a swap with {house}. Whoever did it wanted {house}.',
  'mafia.bot.dump.went.1': 'Night {night}: I went to {who}.',
  'mafia.bot.dump.went.2': 'Night {night}: I was at {who}.',
  'mafia.bot.dump.went.3': '{who}, night {night}. That is where I was.',
  'mafia.bot.dump.onAlert.1': 'Night {night}: I was on alert, at home.',
  'mafia.bot.dump.onAlert.2': 'Night {night}: on my own porch, rifle out. I went nowhere.',
  'mafia.bot.dump.onAlert.3': 'I left the house on no night. Night {night}: alert.',
  'mafia.bot.dump.onVest.1': 'Night {night}: vest on, at home.',
  'mafia.bot.dump.onVest.2': 'Night {night}: I wore the vest and went nowhere.',
  'mafia.bot.dump.onVest.3': 'I visited nobody on night {night}. The vest was on.',
  'mafia.bot.dump.going.1': 'Tonight I am going to {who}.',
  'mafia.bot.dump.going.2': 'Night {night}: {who} is where I will be.',
  'mafia.bot.dump.going.3': 'Tonight, {who}.',
  'mafia.bot.dump.closing.1': 'That is everything. Do what you like with it.',
  'mafia.bot.dump.closing.2': 'You have all of it.',
  'mafia.bot.dump.closing.3': 'Everything I know is out. Decide.',
  /**
   * The crier's night line, which used to be a name.
   *
   * The role has no night action at all: its whole power is that its voice
   * carries into the square after dark, anonymously. So the suspect it used to
   * name was never a finding — it was the top of the ordinary public ranking,
   * the same board every seat reads, read out in a voice that sounds like a
   * tip-off. "You did not hear this from anyone. Watch 7." is a sentence that
   * promises a source, and the role does not have one.
   *
   * That is worse than flavour that means nothing, because an anonymous name
   * cannot be argued with: nobody can ask the voice how it knows, or hold it to
   * the guess tomorrow. It was unaccountable pressure landing on whoever the
   * board already disliked, which is the cascade that hangs the wrong seat.
   *
   * A joke carries the voice, keeps the role's one real perk (the town hears
   * somebody in the dark and knows the crier is alive), and asserts nothing.
   * The French set is French jokes rather than these translated, because a pun
   * does not survive the crossing.
   */
  /**
   * The crier reading the record aloud. See `crierNews`.
   *
   * Every one of these is a count off the board, checkable by anybody who
   * scrolls up, and none of them names a suspect or claims a source.
   */
  'mafia.bot.crier.news.contested.1': 'Count them: {count} of you are claiming {role}. At least one is lying.',
  'mafia.bot.crier.news.contested.2': '{count} people here say they are the {role}. There are not {count}.',
  'mafia.bot.crier.news.toll.1': 'The rope has taken {count} of us. {town} were town.',
  'mafia.bot.crier.news.toll.2': '{count} hanged so far, {town} of them ours. Count before you pull it again.',
  'mafia.bot.crier.news.quiet.1': 'Nobody died last night. Somebody is choosing not to swing.',
  'mafia.bot.crier.news.quiet.2': 'An empty cart this morning. Ask yourselves why.',
  'mafia.bot.crier.news.silent.1': '{who} has not said one thing all game. That is on the record.',
  'mafia.bot.crier.news.silent.2': 'Scroll up. {who} has not made a single claim since day one.',
  'mafia.bot.crier.joke.1': 'I used to hate facial hair. Then it grew on me.',
  'mafia.bot.crier.joke.2': 'I only know 25 letters of the alphabet. I do not know y.',
  'mafia.bot.crier.joke.3': 'What do you call a fish with no eyes? A fsh.',
  'mafia.bot.crier.joke.4': 'I would tell you a construction joke, but I am still working on it.',
  'mafia.bot.crier.joke.5': 'I am afraid of calendars. Their days are numbered.',
  'mafia.bot.crier.joke.6': 'What do you call cheese that is not yours? Nacho cheese.',
  'mafia.bot.crier.joke.7': 'I used to be a banker, but I lost interest.',
  'mafia.bot.crier.joke.8': 'Why did the scarecrow win an award? He was outstanding in his field.',
  'mafia.bot.crier.joke.9': 'I do not trust stairs. They are always up to something.',
  'mafia.bot.crier.quiet.1': 'Sleep light. Somebody here is lying.',
  'mafia.bot.crier.quiet.2': 'Lock up.',
  'mafia.bot.crier.quiet.3': 'Quiet night. Too quiet.',

  /* ------------------------ what the grey text already said ----------------- */
  /**
   * Public facts, restated with one join.
   *
   * Everything the dawn report and the trial record announce is the room's to
   * repeat, and a seat that repeats it is a seat that has read it — which is
   * most of what a real player does with an afternoon. Each of these takes two
   * things the square already saw and puts them in one sentence: a claim and a
   * corpse, a ballot and a role. Nothing here is knowledge the speaker has and
   * the room does not.
   */
  'mafia.bot.fact.quiet.1': 'Nobody died last night.',
  'mafia.bot.fact.quiet.2': 'A quiet night. No body.',
  'mafia.bot.fact.quiet.3': 'No body this morning.',
  'mafia.bot.fact.hangedTown.1': 'We hanged town yesterday. {who} was the {role}.',
  'mafia.bot.fact.hangedTown.2': '{who} was the {role}. We got that one wrong.',
  'mafia.bot.fact.hangedTown.3': 'Yesterday’s hanging was a mistake: {who}, {role}.',
  'mafia.bot.fact.hangedEvil.1': '{who} was the {role}. We got that one right.',
  'mafia.bot.fact.hangedEvil.2': 'Yesterday was right. {who} was the {role}.',
  'mafia.bot.fact.hangedEvil.3': 'One down: {who}, the {role}.',
  'mafia.bot.fact.claimerDied.1': '{who} claimed {role} and died that night.',
  'mafia.bot.fact.claimerDied.2': '{who} said {role} in the square and was dead by morning.',
  'mafia.bot.fact.claimerDied.3': 'The night after {who} claimed {role}, {who} died.',
  'mafia.bot.fact.votersWrong.1': '{names} voted guilty on {who}, who was town.',
  'mafia.bot.fact.votersWrong.2': '{who} was town, and {names} pulled the rope.',
  'mafia.bot.fact.votersWrong.3': '{names} put a hand up for {who}. {who} was town.',

  /* --------------------------- a night in the cell ---------------------------- */
  'mafia.bot.jail.ask.1': 'What are you?',
  'mafia.bot.jail.ask.2': 'Role, and what you did with your nights.',
  'mafia.bot.jail.ask.3': 'Give me something I can check.',
  'mafia.bot.jail.ask.4': 'Why should I open this door?',
  'mafia.bot.jail.ask.5': 'Role first. Then a night I can verify.',
  'mafia.bot.jail.ask.6': 'One useful sentence buys you the morning.',
  'mafia.bot.jail.ask.7': 'Who are you, and who else knows?',
  'mafia.bot.jail.ask.8': 'Say something the square can confirm.',
  'mafia.bot.jail.ask.9': 'Talk me out of what I am thinking.',
  'mafia.bot.jail.ask.10': 'Name a night and a house.',
  'mafia.bot.jail.ask.11': 'Lie and I will know by tomorrow. So?',
  'mafia.bot.jail.ask.12': 'Nobody can hear us. Speak.',
  /**
   * The lever, which is only leverage while it is still there to pull.
   *
   * A Jailor gets three and the cell goes on opening after the third, so "I
   * can kill you from here" out of an empty hand is a bluff the prisoner calls
   * by living through the morning. `cellLine` reaches for these only while a
   * charge remains, which is why they are not simply more `ask` variants.
   */
  'mafia.bot.jail.trust.1': 'I believe you. It is {who} holding the keys — I am the Jailor. Stay alive and say so for me.',
  'mafia.bot.jail.trust.2': 'Good enough for me, {role}. My name is {who}, and I am the one with the cell. Vouch for me tomorrow.',
  'mafia.bot.jail.trust.3': 'You walk at dawn. {who}, Jailor — now you know who to back when they come for me.',
  'mafia.bot.jail.threat.1': 'I can kill you from here. Talk.',
  'mafia.bot.jail.threat.2': 'I still have an execution. Talk me out of it.',
  'mafia.bot.jail.threat.3': 'You leave this cell when I say so. Well?',
  'mafia.bot.jail.plead.role.1': 'I am the {role}. Check me tomorrow.',
  'mafia.bot.jail.plead.role.2': 'The {role}. Same answer at dawn.',
  'mafia.bot.jail.plead.role.3': 'I am the {role}. Kill me and the town loses it.',
  'mafia.bot.jail.plead.offer.1': 'I am the {role}. Let me work tonight and you get a result tomorrow.',
  'mafia.bot.jail.plead.offer.2': 'I am the {role}. Kill me and nobody does my job.',
  'mafia.bot.jail.plead.offer.3': 'I am the {role}. Keep me one more night and I bring you something.',
  'mafia.bot.jail.plead.work.1': 'I am the {role}. Night {night} I looked at {who}.',
  'mafia.bot.jail.plead.work.2': 'The {role}. Night {night}, {who}. Check it tomorrow.',
  'mafia.bot.jail.plead.work.3': 'I am the {role} and I can prove it: night {night}, {who}.',
  /** No badge to show, which is not the same as never having left the house. */
  'mafia.bot.jail.plead.home.1': 'I have nothing to give you.',
  'mafia.bot.jail.plead.home.2': 'No role, no findings, nothing to trade.',
  'mafia.bot.jail.plead.home.3': 'I am nobody.',
  'mafia.bot.jail.silent.1': '…',
  'mafia.bot.jail.silent.2': 'Nothing.',
  'mafia.bot.jail.silent.3': 'You can ask all night.',

  /* ------------------------- the room turns, and answers --------------------- */
  /**
   * Said as soon as votes land, by a seat that does not yet know what it is
   * accused of. So every one is a demand or a question: counting the votes or
   * citing the record are facts, and the caller has checked neither.
   */
  'mafia.bot.pressure.1': 'Why me?',
  'mafia.bot.pressure.2': 'Whoever is voting me, say why.',
  'mafia.bot.pressure.3': 'Who started this?',
  'mafia.bot.pressure.4': 'Ask me anything.',
  'mafia.bot.pressure.5': 'Somebody make the argument.',
  'mafia.bot.pressure.6': 'Name one thing I did.',
  'mafia.bot.pressure.7': 'You are voting me. What for?',
  'mafia.bot.pressure.8': 'Ask me about any night.',
  'mafia.bot.pressure.9': 'Who put my name up?',
  'mafia.bot.pressure.10': 'If it is me, say what I did.',
  'mafia.bot.pressure.11': 'Say what you have before you pull.',
  'mafia.bot.pressure.12': 'Vote me, but give a reason first.',
  'mafia.bot.plead.1': 'This is a mistake.',
  'mafia.bot.plead.2': 'Check who pushed this.',
  'mafia.bot.plead.3': 'Look at who wants me gone.',
  'mafia.bot.plead.4': 'Make sure you are right.',
  'mafia.bot.plead.5': 'Hang me and you are a seat short and no wiser.',
  'mafia.bot.plead.6': 'Name a night of mine. I will answer.',
  'mafia.bot.plead.7': 'I am the easy vote, not the right one.',
  'mafia.bot.plead.8': 'Whoever built this knows what they are doing.',
  'mafia.bot.plead.9': 'Take a day. The real one will still be here.',
  'mafia.bot.watch.1': 'Let them speak.',
  'mafia.bot.watch.2': 'Listening.',
  'mafia.bot.watch.3': 'Say something worth hearing.',
  'mafia.bot.watch.4': 'Your night, your role. In that order.',
  'mafia.bot.watch.5': 'This is your turn. Use it.',
  'mafia.bot.watch.6': 'Nothing yet. Keep going.',
  'mafia.bot.watch.7': 'Say the thing only the real one knows.',
  'mafia.bot.watch.8': 'I vote on what comes out now.',
  'mafia.bot.watch.9': 'Quiet. Let them talk.',

  /* ------------------------------ the last word ------------------------------ */
  'mafia.bot.will.1': 'Everything I had is above.',
  'mafia.bot.will.2': 'Watch who speaks first each day.',
  'mafia.bot.will.3': 'I told you what I knew.',
  'mafia.bot.will.4': 'Finish it.',
  'mafia.bot.will.5': 'Whoever killed me had a reason. Find it.',
  'mafia.bot.will.6': 'Read the nights, not the noise.',
  'mafia.bot.will.7': 'I was wrong about plenty. Not all of it.',
  'mafia.bot.will.8': 'Do not waste the day on me.',
  'mafia.bot.will.9': 'Count who never got asked a question.',
  /**
   * The signature of a seat the Auditor rewrote. See `roleBefore`.
   *
   * Signing the new badge over the old badge's notes read as a forged will and
   * got real evidence thrown out, so the will says what happened instead.
   */
  'mafia.bot.will.audited.1': 'I was the {was}. An Auditor made me the {now}. The nights below are mine and they are true.',
  'mafia.bot.will.audited.2': 'I was the {was} until an Auditor got to me. I am the {now} now. Everything under this still happened.',
  'mafia.bot.will.audited.3': '{was}, then an Auditor. I died a {now}. Read the nights anyway.',
  'mafia.bot.will.role.1': 'I am the {role}.',
  'mafia.bot.will.role.2': 'The {role}, for what it is worth now.',
  'mafia.bot.will.role.3': 'I was the {role}. Every word was true.',
  'mafia.bot.will.note.liar.1': 'Day {day}: {who} is lying.',
  'mafia.bot.will.note.liar.2': 'Day {day}: {who} said something that does not hold.',
  'mafia.bot.will.note.liar.3': 'Day {day}: do not believe {who}.',
  'mafia.bot.will.note.evil.1': 'Day {day}: {who} is not one of us.',
  'mafia.bot.will.note.evil.2': 'Day {day}: I voted {who} and I still would.',
  'mafia.bot.will.note.evil.3': 'Day {day}: {who}. My read and my vote.',
  'mafia.bot.will.note.wrong.1': 'Day {day}: I was wrong about {who}.',
  'mafia.bot.will.note.wrong.2': 'Day {day}: {who} was town. My mistake.',
  'mafia.bot.will.note.wrong.3': 'Day {day}: cross {who} off. I got that wrong.'
};

export default screenEn;
