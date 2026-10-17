export { ACTION, FACTION, NO, refusalOf, ROLE, SLOT, type DeathSource } from './messages.js';
export {
  CREATES,
  ROLES,
  SELF_FIRES,
  wearableMask,
  twinMasks,
  maskRank,
  type Faction,
  type RoleDef,
  type RoleId
} from './roles.js';
export { staysHome } from './powers.js';
export {
  DEFAULT_CONFIG,
  chatRules,
  createMafiaGame,
  isLodgeMate,
  isMason,
  jailChannel,
  keepsCell,
  isKeeper,
  captiveOf,
  playerBySlot,
  playerFamily,
  pointsFor,
  SKIP_VOTE,
  tableRoleList,
  spokenLocale,
  tablePresence,
  WILL_MAX_CHARS,
  type IntelEntry,
  type MafiaConfig,
  type MafiaPlayer,
  type MafiaSetupChoice,
  type MafiaState
} from './state.js';
export { SETUPS, SLOT_TOKENS, isSlotToken, slotFaction, slotPool, type SlotToken } from './setups.js';
export {
  addMafiaBot,
  advanceMafia,
  callCourt,
  castBallot,
  castVote,
  chatLineFor,
  checkVictory,
  dropMafiaSeat,
  jailTarget,
  joinMafia,
  legalNightAction,
  needsSecondTarget,
  mafiaPaused,
  noteSeatAlive,
  noteSeatSilent,
  proposeMafiaKick,
  removeMafiaBot,
  restoreMafiaTable,
  revealMayor,
  sayInChat,
  setLastWill,
  setNightAction,
  startMafia,
  tickMafiaPresence,
  voteMafiaKick,
  whisperTo,
  type ActionOutcome
} from './engine.js';
export {
  toMafiaView,
  type MafiaChannelKind,
  type MafiaPublicPlayer,
  type MafiaView,
  type MafiaViewer,
  type MafiaViewMe
} from './view.js';
export { emptyMafiaStats, mafiaReward, type MafiaCareerStats } from './careers.js';

/**
 * The social model. Exported because the live bot driver and the headless bench
 * must reach for the same one: a bot that panics differently from the simulated
 * seat we measured is a bot we have not measured.
 */
export { agendaOf, stanceOf, type Agenda, type Stance } from './social.js';
export {
  claimerWeight,
  decideNightTarget,
  heedChance,
  judgeRequest,
  type RequestRefusal,
  type RequestVerdict,
  cellProves,
  contradicted,
  ownsUpTo,
  buddyRead,
  QUIET_TRADE,
  sheriffSuspects,
  isEvilRole,
  tradeVerdict,
  tradeSuspects,
  couldStillAct,
  DEFAULT_PROFILE,
  makePersonality,
  parityPressure,
  provenLiar,
  suspicion,
  knockIsTest,
  suspicionParts,
  stolenBadge,
  trustOf,
  uncontestedBadge,
  type Brain,
  type Claim,
  type ClaimKind,
  type PublicInfo
} from './sim/policies.js';
export { testimonyOf } from './sim/testimony.js';
export { BotTable, type NightAim } from './sim/table.js';
export {
  CHARACTERS,
  castCharacter,
  castProfile,
  type Character,
  type CharacterId,
  type Voice
} from './sim/characters.js';
export { deductions, strongest, type Deduction } from './sim/deduce.js';

export { rank, caseFor, defenceFor, type Reason } from './sim/ranking.js';
export { beliefs } from './sim/beliefs.js';
export {
  mafiaActionSchema,
  mafiaBallotSchema,
  mafiaChatSchema,
  mafiaConfigSchema,
  mafiaDayActionSchema,
  mafiaJoinSchema,
  mafiaKickSchema,
  mafiaVoteSchema,
  mafiaWhisperSchema,
  mafiaWillSchema,
  type MafiaClientToServer,
  type MafiaJoinAck,
  type MafiaReward,
  type MafiaServerToClient,
  type MafiaBusy
} from './protocol.js';
export { wagonOpener } from './sim/tempo.js';
export { townClock, soloEndgame } from './sim/clock.js';
