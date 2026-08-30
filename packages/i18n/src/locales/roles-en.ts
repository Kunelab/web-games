import type { Catalogue } from '../index.js';

/**
 * The cast, in English: camps, the sixty-three roles, the verb each night power
 * puts on a button, and the category names the published role list uses.
 *
 * Split out of `en.ts` because it is content of a different kind. `en.ts` is the
 * *script* — what the town says as the evening happens — and reads top to bottom
 * as one. This is a *table*, and a translator working on either one has no
 * business scrolling through the other.
 *
 * Roles keep their French definitions in `mafia-core/roles.ts`, which is what the
 * bot prompts and the headless simulator read: those two want prose in one
 * language and neither is a person's screen. Every surface a player looks at
 * resolves the keys below instead.
 */
export const rolesEn: Catalogue = {
  /* -------------------------------- the camps ------------------------------- */
  'mafia.faction.town': 'Town',
  'mafia.faction.mafia': 'Mafia',
  'mafia.faction.triad': 'Triad',
  'mafia.faction.cult': 'Cult',
  'mafia.faction.neutral': 'Neutral',

  /* --------------------------------- the Town ------------------------------- */
  'mafia.role.citizen.name': 'Citizen',
  'mafia.role.citizen.desc': 'No power, one voice. Debate is your weapon.',
  'mafia.role.sheriff.name': 'Sheriff',
  'mafia.role.sheriff.desc': 'Each night, probe a player: suspicious or not.',
  'mafia.role.investigator.name': 'Private Investigator',
  'mafia.role.investigator.desc': 'Each night, examine a player and learn their likely trade.',
  'mafia.role.detective.name': 'Detective',
  'mafia.role.detective.desc': 'Each night, tail a player and learn whose house they went to.',
  'mafia.role.lookout.name': 'Lookout',
  'mafia.role.lookout.desc': 'Each night, watch a house and see who calls on it.',
  'mafia.role.spy.name': 'Spy',
  'mafia.role.spy.desc':
    'Overhears the families conspiring at night — never seeing a face — and learns who they aimed at.',
  'mafia.role.coroner.name': 'Coroner',
  'mafia.role.coroner.desc': 'Each night, autopsy a body and learn its true role, cleaned or not.',
  'mafia.role.doctor.name': 'Doctor',
  'mafia.role.doctor.desc': 'Each night, heal a player and save them from an attack.',
  'mafia.role.bodyguard.name': 'Bodyguard',
  'mafia.role.bodyguard.desc': 'Guard a player; if they are attacked, you fall along with the attacker.',
  'mafia.role.escort.name': 'Escort',
  'mafia.role.escort.desc': 'Each night, keep a player at home: their action is cancelled.',
  'mafia.role.bus-driver.name': 'Bus Driver',
  'mafia.role.bus-driver.desc': 'Each night, swap two houses: everything aimed at one lands on the other.',
  'mafia.role.vigilante.name': 'Vigilante',
  'mafia.role.vigilante.desc': 'Three bullets to do justice yourself. Aim well.',
  'mafia.role.veteran.name': 'Veteran',
  'mafia.role.veteran.desc': 'On alert, guns down anyone who visits that night.',
  'mafia.role.jailor.name': 'Jailor',
  'mafia.role.jailor.desc':
    'By day, picks a prisoner; by night, questions them in the cell and may execute them.',
  'mafia.role.mayor.name': 'Mayor',
  'mafia.role.mayor.desc': 'Can reveal in broad daylight: their vote then counts triple.',
  'mafia.role.marshall.name': 'Marshall',
  'mafia.role.marshall.desc':
    'Can reveal in broad daylight: that day the town judges without a defence, and hangs in bulk.',
  'mafia.role.crier.name': 'Town Crier',
  'mafia.role.crier.desc': 'Their voice carries even at night — anonymously, across the village square.',
  'mafia.role.mason.name': 'Mason',
  'mafia.role.mason.desc': 'A member of the lodge: the brothers know each other and talk at night.',
  'mafia.role.mason-leader.name': 'Mason Leader',
  'mafia.role.mason-leader.desc': 'Each night, may initiate a citizen into the lodge.',
  'mafia.role.stump.name': 'Stump',
  'mafia.role.stump.desc': 'A tree has roots and an opinion. Says nothing, dies of nothing at night, votes.',

  /* -------------------------------- the Mafia ------------------------------- */
  'mafia.role.godfather.name': 'Godfather',
  'mafia.role.godfather.desc': 'Orders the murder of the night. Above suspicion, untouchable at home.',
  'mafia.role.mafioso.name': 'Mafioso',
  'mafia.role.mafioso.desc': 'The family’s gun arm: carries out the Godfather’s order.',
  'mafia.role.caporegime.name': 'Caporegime',
  'mafia.role.caporegime.desc':
    'Lieutenant of the family. When the Godfather falls, he learns to smile like him.',
  'mafia.role.soldato.name': 'Soldato',
  'mafia.role.soldato.desc': 'One more soldier in the family. Orders are orders.',
  'mafia.role.consigliere.name': 'Consigliere',
  'mafia.role.consigliere.desc': 'Each night, learns a player’s exact role.',
  'mafia.role.consort.name': 'Consort',
  'mafia.role.consort.desc': 'Each night, keeps a player at home: their action is cancelled.',
  'mafia.role.framer.name': 'Framer',
  'mafia.role.framer.desc': 'Dresses an innocent up as a suspect for the night.',
  'mafia.role.blackmailer.name': 'Blackmailer',
  'mafia.role.blackmailer.desc': 'Each night, gags a player: tomorrow they vote, but say nothing.',
  'mafia.role.janitor.name': 'Janitor',
  'mafia.role.janitor.desc':
    'Wipes the body’s identity away — the town buries a stranger, the family learns the role.',
  'mafia.role.agent.name': 'Agent',
  'mafia.role.agent.desc': 'Each night, tails a player: who visited them, and whose house they went to.',
  'mafia.role.beguiler.name': 'Beguiler',
  'mafia.role.beguiler.desc': 'Hides at somebody’s house: whatever was meant for you strikes your host.',
  'mafia.role.disguiser.name': 'Disguiser',
  'mafia.role.disguiser.desc': 'Steals a player’s profile: investigators will see the other face.',
  'mafia.role.actress.name': 'Actress',
  'mafia.role.actress.desc': 'Plays somebody else’s part: investigators applaud without understanding.',
  'mafia.role.kidnapper.name': 'Kidnapper',
  'mafia.role.kidnapper.desc': 'Takes a player for the night: unreachable, harmless, furious.',
  'mafia.role.heartbreaker.name': 'Heartbreaker',
  'mafia.role.heartbreaker.desc': 'Makes a player fall madly in love: if your heart stops, so does theirs.',

  /* -------------------------------- the Triad ------------------------------- */
  'mafia.role.dragon-head.name': 'Dragon Head',
  'mafia.role.dragon-head.desc':
    'Orders the murder of the night for the Triad. Above suspicion, untouchable.',
  'mafia.role.enforcer.name': 'Enforcer',
  'mafia.role.enforcer.desc': 'The Triad’s gun arm.',
  'mafia.role.vanguard.name': 'Vanguard',
  'mafia.role.vanguard.desc': 'One more soldier for the Triad.',
  'mafia.role.administrator.name': 'Administrator',
  'mafia.role.administrator.desc': 'Each night, learns a player’s exact role.',
  'mafia.role.liaison.name': 'Liaison',
  'mafia.role.liaison.desc': 'Each night, keeps a player at home: their action is cancelled.',
  'mafia.role.forger.name': 'Forger',
  'mafia.role.forger.desc': 'Dresses an innocent up as a suspect for the night.',
  'mafia.role.silencer.name': 'Silencer',
  'mafia.role.silencer.desc': 'Each night, gags a player: tomorrow they vote without a word.',
  'mafia.role.incense-master.name': 'Incense Master',
  'mafia.role.incense-master.desc':
    'The incense erases the body’s identity; the Triad, though, learns everything.',
  'mafia.role.informant.name': 'Informant',
  'mafia.role.informant.desc': 'Each night, tails a player: visits received, visits paid.',
  'mafia.role.deceiver.name': 'Deceiver',
  'mafia.role.deceiver.desc': 'Hides at somebody’s house: whatever was meant for you strikes your host.',
  'mafia.role.interrogator.name': 'Interrogator',
  'mafia.role.interrogator.desc': 'Takes a player for the night: unreachable, harmless, terrified.',
  'mafia.role.diva.name': 'Diva',
  'mafia.role.diva.desc': 'Wears somebody else’s face: investigators will never see through it.',

  /* ------------------------------- the Neutrals ----------------------------- */
  'mafia.role.jester.name': 'Jester',
  'mafia.role.jester.desc': 'You win if the town hangs you. Make yourself hated.',
  'mafia.role.executioner.name': 'Executioner',
  'mafia.role.executioner.desc':
    'Obsessed with one mark: get them hanged by day and you win. If they die at night, grief turns you into the Jester.',
  'mafia.role.survivor.name': 'Survivor',
  'mafia.role.survivor.desc': 'Wins if they see the end, whoever takes it. Four bulletproof vests.',
  'mafia.role.amnesiac.name': 'Amnesiac',
  'mafia.role.amnesiac.desc':
    'No longer remembers who they are. One night, at the graveyard, it will come back to them.',
  'mafia.role.scumbag.name': 'Scumbag',
  'mafia.role.scumbag.desc':
    'A filthy reputation and no power at all. Wins if the town loses — and they are still breathing.',
  'mafia.role.judge.name': 'Judge',
  'mafia.role.judge.desc':
    'Can call an exceptional court: immediate judgement, no defence, and their voice counts triple. Wins if the town loses.',
  'mafia.role.auditor.name': 'Auditor',
  'mafia.role.auditor.desc':
    'Reduces a player to administrative nothing: their role is dissolved. Wins if the town loses.',
  'mafia.role.witch.name': 'Witch',
  'mafia.role.witch.desc':
    'Each night, bewitches a player and diverts their deed to another house. Wins if the Town does not — and she is still breathing.',
  'mafia.role.lover.name': 'Lover',
  'mafia.role.lover.desc':
    'Chooses the one their heart wants. They win together if they survive together — and die together.',
  'mafia.role.cultist.name': 'Cultist',
  'mafia.role.cultist.desc':
    'Every other night, converts a soul of the town. The Cult wins once it holds the majority.',
  'mafia.role.witch-doctor.name': 'Witch Doctor',
  'mafia.role.witch-doctor.desc': 'The cult’s physician: heals its own and everybody else.',
  'mafia.role.serial-killer.name': 'Serial Killer',
  'mafia.role.serial-killer.desc':
    'Kills every night — the blade goes through vests and even the Godfather’s guard. Wins alone, when nobody is left to stop them.',
  'mafia.role.mass-murderer.name': 'Mass Murderer',
  'mafia.role.mass-murderer.desc': 'Butchers a house and everyone inside it that night. Wins alone.',
  'mafia.role.arsonist.name': 'Arsonist',
  'mafia.role.arsonist.desc':
    'Douses a house in petrol every night — or strikes the match at home, and everything soaked goes up. Nothing stops fire. Wins alone.',
  'mafia.role.poisoner.name': 'Poisoner',
  'mafia.role.poisoner.desc':
    'A slow poison: the victim goes out the following night, unless a doctor purges them in time. Wins alone.',
  'mafia.role.electromaniac.name': 'Electromaniac',
  'mafia.role.electromaniac.desc': 'Electrifies houses in silence — then, at home, pulls the lever. Wins alone.',

  /* -------------------------- the verb on the button ------------------------ */
  'mafia.action.kill': 'Kill',
  'mafia.action.heal': 'Heal',
  'mafia.action.guard': 'Guard',
  'mafia.action.block': 'Occupy',
  'mafia.action.investigate': 'Probe',
  'mafia.action.examine': 'Examine',
  'mafia.action.watch': 'Watch',
  'mafia.action.track': 'Track',
  'mafia.action.shadow': 'Shadow',
  'mafia.action.frame': 'Frame',
  'mafia.action.jail-execute': 'Execute',
  'mafia.action.alert': 'Go on alert',
  'mafia.action.vest': 'Put the vest on',
  'mafia.action.douse': 'Douse',
  'mafia.action.control': 'Bewitch',
  'mafia.action.silence': 'Silence',
  'mafia.action.clean': 'Clean',
  'mafia.action.swap': 'Swap',
  'mafia.action.kidnap': 'Kidnap',
  'mafia.action.recruit': 'Initiate',
  'mafia.action.convert': 'Convert',
  'mafia.action.remember': 'Remember',
  'mafia.action.audit': 'Audit',
  'mafia.action.imitate': 'Borrow the face',
  'mafia.action.hide': 'Hide at',
  'mafia.action.charm': 'Charm',
  'mafia.action.bond': 'Love',
  'mafia.action.autopsy': 'Autopsy',
  'mafia.action.rampage': 'Rampage',
  'mafia.action.poison': 'Poison',
  'mafia.action.charge': 'Wire up',

  /** The same power, pointed at your own house: a different sentence entirely. */
  'mafia.action.douse.self': 'Burn it all',
  'mafia.action.charge.self': 'Send the current',

  /* --------------------------- the published role list ---------------------- */
  'mafia.slot.town-core': 'Town Core',
  'mafia.slot.town-investigative': 'Town Investigative',
  'mafia.slot.town-protective': 'Town Protective',
  'mafia.slot.town-killing': 'Town Killing',
  'mafia.slot.town-power': 'Town Power',
  'mafia.slot.town-support': 'Town Support',
  'mafia.slot.town-random': 'Random Town',
  'mafia.slot.mafia-support': 'Mafia Support',
  'mafia.slot.mafia-deception': 'Mafia Deception',
  'mafia.slot.mafia-random': 'Random Mafia',
  'mafia.slot.triad-random': 'Random Triad',
  'mafia.slot.neutral-benign': 'Neutral Benign',
  'mafia.slot.neutral-evil': 'Neutral Evil',
  'mafia.slot.neutral-killing': 'Neutral Killing',
  'mafia.slot.neutral-random': 'Random Neutral',
  'mafia.slot.any': 'Any Role',
  'mafia.slot.pool': 'Rolled at the start from: {roles}.'
};

export default rolesEn;
