import { z } from 'zod';

import type { ChatMessage } from 'chat-core';
import { isSlotToken } from './setups.js';
import type { MafiaView } from './view.js';

/** Wire contract between the phones and the server, shared by both apps. */

export const mafiaJoinSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(20),
  playerToken: z.string().max(64).optional()
});

export const mafiaChatSchema = z.object({
  channel: z.string().min(1).max(24),
  text: z.string().min(1).max(400)
});

export const mafiaVoteSchema = z.object({
  targetSlot: z.number().int().min(1).max(24).nullable()
});

export const mafiaBallotSchema = z.object({
  verdict: z.enum(['guilty', 'innocent', 'abstain'])
});

export const mafiaActionSchema = z.object({
  targetSlot: z.number().int().min(1).max(24).nullable(),
  /** Witch only: where the controlled player is sent. */
  secondTargetSlot: z.number().int().min(1).max(24).nullable().optional()
});

export const mafiaWhisperSchema = z.object({
  targetSlot: z.number().int().min(1).max(24),
  text: z.string().min(1).max(400)
});

export const mafiaDayActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('jail'), targetSlot: z.number().int().min(1).max(24).nullable() }),
  z.object({ type: z.literal('reveal') }),
  z.object({ type: z.literal('court') })
]);

export const mafiaWillSchema = z.object({
  text: z.string().max(400)
});

const slotTokenSchema = z.string().max(24).refine(isSlotToken, 'Slot inconnu');

export const mafiaSetupSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({ mode: z.literal('chaos') }),
  z.object({ mode: z.literal('preset'), presetId: z.string().max(40) }),
  z.object({ mode: z.literal('custom'), slots: z.array(slotTokenSchema).min(4).max(24) })
]);

export const mafiaConfigSchema = z.object({
  maxPlayers: z.number().int().min(4).max(24).optional(),
  dayMs: z.number().int().min(30_000).max(600_000).optional(),
  nightMs: z.number().int().min(15_000).max(180_000).optional(),
  setup: mafiaSetupSchema.optional()
});

type Ack<T> = (response: T) => void;
export type MafiaAckResult = { ok: true } | { ok: false; error: string };

export interface MafiaJoinAck {
  ok: boolean;
  error?: string;
  playerId?: string;
  playerToken?: string;
  view?: MafiaView;
}

export interface MafiaReward {
  playerId: string;
  name: string;
  gained: number;
  /** Lifetime balance after banking; null for anonymous seats the server does not track. */
  total: number | null;
}

export interface MafiaClientToServer {
  'mafia:join': (payload: z.infer<typeof mafiaJoinSchema>, ack: Ack<MafiaJoinAck>) => void;
  'mafia:host': (payload: { code: string; hostToken: string }, ack: Ack<{ ok: boolean; error?: string; view?: MafiaView }>) => void;
  'mafia:start': (payload: { hostToken: string }) => void;
  'mafia:addBots': (payload: { hostToken: string; count: number }) => void;
  'mafia:chat': (payload: z.infer<typeof mafiaChatSchema>, ack: Ack<MafiaAckResult>) => void;
  'mafia:whisper': (payload: z.infer<typeof mafiaWhisperSchema>, ack: Ack<MafiaAckResult>) => void;
  'mafia:vote': (payload: z.infer<typeof mafiaVoteSchema>, ack: Ack<MafiaAckResult>) => void;
  'mafia:ballot': (payload: z.infer<typeof mafiaBallotSchema>, ack: Ack<MafiaAckResult>) => void;
  'mafia:action': (payload: z.infer<typeof mafiaActionSchema>, ack: Ack<MafiaAckResult>) => void;
  'mafia:dayAction': (payload: z.infer<typeof mafiaDayActionSchema>, ack: Ack<MafiaAckResult>) => void;
  'mafia:will': (payload: z.infer<typeof mafiaWillSchema>, ack: Ack<MafiaAckResult>) => void;
}

export interface MafiaServerToClient {
  'mafia:state': (view: MafiaView) => void;
  'mafia:message': (message: ChatMessage) => void;
  'mafia:rewards': (rewards: MafiaReward[]) => void;
  'mafia:error': (payload: { message: string }) => void;
}
