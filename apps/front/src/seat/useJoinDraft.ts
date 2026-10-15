import { useState } from 'react';

import { storedNickname } from '../tools/nickname';

/**
 * What a player has typed into the join form so far.
 *
 * Held by the page rather than the form, because the form is not on screen for
 * the whole wait: a connection that drops before the player submits puts the
 * page back on its "connecting" screen, and a draft kept inside the form would
 * be thrown away with it, leaving them to type it all again.
 */
export interface JoinDraft {
  name: string;
  setName: (name: string) => void;
  password: string;
  setPassword: (password: string) => void;
}

/** The page's half of `JoinForm`: call it before any early return. */
export function useJoinDraft(): JoinDraft {
  /**
   * Filled from the name this phone last played under, whatever the game was.
   *
   * Not from the seat's own name: that one is what a silent rejoin sends back,
   * and the seat reads it itself, but it is empty the first time this phone
   * meets this code, which is exactly when the box is shown. So a player types
   * their name once, not once per game and again per evening.
   */
  const [name, setName] = useState(storedNickname);
  /**
   * The word at the door. The box only appears once the seat says the room has
   * one (`locked`): the overwhelming majority of rooms have no door, and a
   * password box on every join screen is a question almost nobody has an answer
   * to. See `JoinAnswer.needsPassword`.
   */
  const [password, setPassword] = useState('');
  return { name, setName, password, setPassword };
}
