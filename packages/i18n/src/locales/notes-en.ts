import type { Catalogue } from '../index.js';

/**
 * The private feed, in English: what the night told you and nobody else.
 *
 * These are the last sentences in the game that used to be written as prose and
 * stored that way — a player's `notifications` were French strings sitting in the
 * persisted state, so they survived every other localisation pass untouched and
 * reached an English reader exactly as written. They are keys now, resolved on
 * the screen that shows them and by the server only when it briefs a bot.
 *
 * The `mafia.trade.*` block is the Investigator's answer sheet: roles sharing a
 * trade share a line, which is the whole point — an ambiguous result is the
 * information, so two roles must read *identically*, not merely similarly.
 */
export const notesEn: Catalogue = {
  /* ------------------------------ what you are ------------------------------ */
  'mafia.note.lodgeStruck': 'You knocked, and {name} answered in the cult’s words. They did not see the morning.',
  'mafia.note.lodgeHeld': '{name} came to preach at your door. The lodge does not convert.',
  'mafia.note.roleDealt': 'You are the {role}. {description}',
  'mafia.note.obsession': 'Your obsession: get {name} (house {slot}) hanged.',
  'mafia.note.jailedNight': 'You have been dragged to a cell for the night. The Jailor is listening.',
  'mafia.note.jesterWon': 'They hanged you. You win.',
  'mafia.note.execWon': 'Your obsession is swinging. You win.',
  'mafia.note.griefMad': 'Your obsession died without a rope. Grief drives you mad: you are the Jester now.',
  'mafia.note.remembered': 'It all comes back to you: you are the {role}.',
  'mafia.note.promoted': 'Somebody has to hold the knife now. You are the {role}.',
  'mafia.note.kidnapDone': 'You had {name} in a sack all night. They did nothing, and nobody could reach them.',
  'mafia.note.audited': 'A relentless audit — your papers, your tools, your former life, seized. You are the {role}.',

  /* --------------------------- what you did tonight ------------------------- */
  'mafia.note.onAlert': 'You spend the night on alert, rifle across your knees.',
  'mafia.note.vestOn': 'Vest on for the night.',
  'mafia.note.controlDone': 'You bewitched {name} and diverted their deed towards {other}.',
  'mafia.note.controlIdle': '{name} had no deed to divert tonight.',
  'mafia.note.busDone': 'You swapped {first} and {second}. Only you know who slept where.',
  'mafia.note.silenceDone': '{name} will not say a word tomorrow.',
  'mafia.note.douseDone': '{name}’s house is soaked.',
  'mafia.note.chargeDone': '{name}’s house is wired.',
  'mafia.note.poisonDone': '{name} is poisoned: they go out tomorrow, unless a doctor gets there first.',
  'mafia.note.disguised': 'Tonight the curious will take you for the {role}.',
  'mafia.note.hiding': 'You spend the night hidden at {name}’s. Whatever was aimed at you will find them.',
  'mafia.note.charmDone': '{name} belongs to you: if you fall, that heart stops too.',
  'mafia.note.bondDone': 'Your heart chose {name}. Live together, or die together.',
  'mafia.note.cleaned': '{name}’s body is unrecognisable. They were the {role}.',
  'mafia.note.initiateDone': '{name} has joined the lodge.',
  'mafia.note.initiateRefused': '{name} declined the initiation.',
  'mafia.note.convertDone': '{name} has joined the Cult.',
  'mafia.note.convertRefused': '{name} resisted the call.',
  'mafia.note.convertCrowded': 'Another of us reached a door first tonight; {name} was left where they stood.',
  'mafia.note.auditDone': '{name} has been reduced to administrative nothing.',
  'mafia.note.auditFailed': '{name} is untouchable on paper.',
  'mafia.note.executedInnocent': 'You executed an innocent. Your hands shake: no more executions.',

  /* -------------------------- what was done to you -------------------------- */
  'mafia.note.controlled': 'A will not your own guided your steps tonight.',
  'mafia.note.bussed': 'A bus dropped you off somewhere else tonight.',
  'mafia.note.kidnapped': 'A bag over your head, an unfamiliar cellar: you were taken for the night.',
  'mafia.note.blocked': 'Somebody kept you busy all night. Your action came to nothing.',
  'mafia.note.blockDone': 'You kept {name} busy all night. Whatever they had planned, it did not happen.',
  'mafia.note.blockFailed': '{name} was sitting up, armed and waiting. Nobody keeps that one busy.',
  'mafia.note.silenced': 'A letter under your door: “One word tomorrow and everyone will know.” You are mute.',
  'mafia.note.doused': 'A smell of petrol soaks into your walls…',
  'mafia.note.poisoned': 'A bitter taste at the back of your throat. You feel feverish…',
  'mafia.note.charmed': 'A heady perfume clings to your skin. Your heart no longer beats quite for you.',
  'mafia.note.bonded': 'Somebody loves you madly: {name}. Live together, or die together.',
  'mafia.note.initiated': 'You have been initiated into the lodge. Your brothers know you now.',
  'mafia.note.converted': 'Voices in the night… and suddenly it is all clear. You belong to the Cult.',

  /* ------------------------------- the violence ----------------------------- */
  'mafia.note.targetMissing': 'Your target was nowhere to be found tonight.',
  'mafia.note.attackFailed': 'Your target survived your attack.',
  'mafia.note.attackImmune': 'Your blade found something harder than skin. That house does not fall to this.',
  'mafia.note.attackVested': 'Padding, under the shirt. Somebody was expecting you.',
  'mafia.note.attackHealed': 'You left them for dead and somebody stitched them up before dawn.',
  'mafia.note.attackTooLate': 'Somebody had already been there. You put your knife into a body.',
  'mafia.note.powerSpent': 'You have nothing left to spend tonight.',
  'mafia.note.cellarSpent': 'You can still take somebody tonight, but you have nothing left to end them with.',
  'mafia.note.cellarKill': 'You did not let {name} out.',
  'mafia.note.cellarDry': 'You have no executions left; {name} walks out at dawn.',
  'mafia.note.resting': 'Last night took everything you had. You are staying in tonight.',
  'mafia.note.survived': 'You were attacked tonight, and you held.',
  'mafia.note.guarded': 'Somebody died for you tonight.',
  'mafia.note.bodyguardRepelled': 'A bodyguard drove you off.',
  'mafia.note.purged': 'The fever breaks: your blood was purged in time.',
  'mafia.note.healed': 'You were left for dead, but expert hands stitched you back together.',
  'mafia.note.healSaved': 'Your patient was attacked tonight. You saved them.',

  /* -------------------------------- what you saw ---------------------------- */
  'mafia.note.familyAimed': 'The {family} aimed at house {slot} tonight.',
  /**
   * The needle, by name. A sheriff that says "suspicious" hands the town an
   * argument; one that says "a Serial Killer" hands it an instruction.
   */
  'mafia.note.sheriff.suspect': '{name} is SUSPICIOUS.',
  'mafia.note.sheriff.mafia': '{name} is a member of the MAFIA.',
  'mafia.note.sheriff.triad': '{name} is a member of the TRIAD.',
  'mafia.note.sheriff.cult': '{name} is a CULTIST.',
  'mafia.note.sheriff.serial-killer': '{name} is a SERIAL KILLER.',
  'mafia.note.sheriff.mass-murderer': '{name} is a MASS MURDERER.',
  'mafia.note.sheriff.arsonist': '{name} is an ARSONIST.',
  'mafia.note.sheriff.poisoner': '{name} is a POISONER.',
  'mafia.note.sheriff.electromaniac': '{name} is an ELECTROMANIAC.',
  'mafia.note.sheriffClear': '{name} has nothing suspicious about them.',
  'mafia.note.exactRole': '{name} is the {role}.',
  'mafia.note.tradeLine': '{name} {line}.',
  /* The same finding, with the answer sheet the whole table shares. */
  'mafia.note.tradeLineRoles': '{name} {line}. At this table that means: {roles}.',
  'mafia.note.visitorsSeen': 'At {name}’s tonight: {names}.',
  'mafia.note.visitorsNone': 'Nobody called on {name} tonight.',
  'mafia.note.trackedTo': '{name} went out tonight: seen at {names}.',
  'mafia.note.trackedHome': '{name} never left their house tonight.',
  'mafia.note.autopsy': 'Under your scalpel, {name} gives up the secret: they were the {role}.',

  /* -------------------------- why somebody won ------------------------------ */
  'mafia.win.reason.town': 'The Town wins',
  'mafia.win.reason.mafia': 'The Mafia wins',
  'mafia.win.reason.triad': 'The Triad wins',
  'mafia.win.reason.cult': 'The Cult wins',
  'mafia.win.reason.jester': 'Jester hanged: they win alone',
  'mafia.win.reason.executioner': 'Obsession hanged: the Executioner wins',
  'mafia.win.reason.survivor': 'Survived to the very end',
  'mafia.win.reason.parasite': 'Thrived on the town’s misery',
  'mafia.win.reason.lovers': 'Love outlasted the town',
  'mafia.win.reason.serial-killer': 'Last blade standing',
  'mafia.win.reason.arsonist': 'Last flame standing',
  'mafia.win.reason.mass-murderer': 'Last massacre standing',
  'mafia.win.reason.poisoner': 'Last vial standing',
  'mafia.win.reason.electromaniac': 'Last current standing',

  /* --------------------- the investigator's answer sheet -------------------- */
  'mafia.trade.quiet': 'does not seem to be hiding much',
  'mafia.trade.snoop': 'pries into other people’s lives',
  'mafia.trade.watcher': 'watches the comings and goings',
  'mafia.trade.healer': 'has well-kept hands',
  'mafia.trade.rough': 'has calloused hands',
  'mafia.trade.night': 'works nights',
  'mafia.trade.powder': 'smells of gunpowder',
  'mafia.trade.keys': 'carries a ring of keys',
  'mafia.trade.hands': 'shakes a great many hands',
  'mafia.trade.ink': 'has ink-stained fingers',
  'mafia.trade.laugh': 'laughs alone',
  'mafia.trade.blade': 'is sharpening something',
  'mafia.trade.gas': 'smells of petrol',
  'mafia.trade.herbs': 'carries strange herbs',
  'mafia.trade.wheel': 'has their hands on a steering wheel',
  'mafia.trade.chalk': 'has chalk on their sleeves',
  'mafia.trade.paint': 'smells of greasepaint',
  'mafia.trade.wires': 'has pockets full of copper wire',
  'mafia.trade.bottle': 'carries little vials',
  'mafia.trade.rope': 'has new rope',
  'mafia.trade.charm': 'wears a heady perfume',
  'mafia.trade.dirt': 'has dirt under their fingernails'
};

export default notesEn;
