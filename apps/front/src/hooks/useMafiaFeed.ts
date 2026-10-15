import type { ChatMessage } from 'chat-core';
import type { MafiaBusy, MafiaReward } from 'mafia-core';
import { useEffect, useState } from 'react';

import type { mafiaSeat } from '../seat/protocols';
import type { SeatOf } from '../seat/useSeat';

/**
 * What a Mafia seat hears besides the view: chat pushed between broadcasts, the
 * rewards once the table ends, and which seats have a model working for them.
 *
 * Chat arrives twice: inside every `mafia:state` view (authoritative, filtered
 * server-side) and as incremental `mafia:message` pushes between broadcasts.
 * This merges the two, deduplicating on message id.
 */
export function useMafiaFeed(seat: Pick<SeatOf<typeof mafiaSeat>, 'view' | 'status' | 'on'>): {
  /** view.chat plus every message pushed since the last broadcast. */
  messages: ChatMessage[];
  rewards: MafiaReward[] | null;
  /** Which seats have a model working for them, and whether the ear is reading. */
  busy: MafiaBusy;
} {
  const { view, status, on } = seat;
  const [extra, setExtra] = useState<ChatMessage[]>([]);
  const [rewards, setRewards] = useState<MafiaReward[] | null>(null);
  /**
   * Deliberately outside the view.
   *
   * It changes several times a second and means nothing a moment later, so it
   * arrives on its own small event and never drags a projected board behind it.
   */
  const [busy, setBusy] = useState<MafiaBusy>(IDLE);

  useEffect(() => on('mafia:message', (message) => setExtra((current) => [...current, message])), [on]);
  useEffect(() => on('mafia:rewards', setRewards), [on]);
  useEffect(() => on('mafia:busy', setBusy), [on]);

  // A drop leaves the last state behind, and nothing is working for a table
  // this phone has just lost. Adjusted during render, as React recommends.
  const down = status === 'connecting';
  const [wasDown, setWasDown] = useState(down);
  if (down !== wasDown) {
    setWasDown(down);
    if (down) setBusy(IDLE);
  }

  // Messages a new view already carries need no duplicate in the side buffer.
  const [seenView, setSeenView] = useState(view);
  if (view !== seenView) {
    setSeenView(view);
    const lastId = view?.chat.at(-1)?.id ?? 0;
    setExtra((current) => current.filter((message) => message.id > lastId));
  }

  return { messages: view ? mergeMessages(view.chat, extra) : extra, rewards, busy };
}

const IDLE: MafiaBusy = { speaking: [], thinking: [], reading: false };

export function mergeMessages(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  if (extra.length === 0) return base;
  const lastId = base.at(-1)?.id ?? 0;
  const fresh = extra.filter((message) => message.id > lastId);
  return fresh.length > 0 ? [...base, ...fresh] : base;
}
