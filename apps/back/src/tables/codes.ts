import { randomInt } from 'node:crypto';

import { generateJoinCode } from 'game-core';

/** Anything that holds join codes: a game's tables, the quick rooms. */
export interface CodeHolder {
  has(code: string): boolean;
}

/**
 * One namespace for every code in the house, so a typo lands nowhere at all.
 *
 * Every game used to roll its own codes and check them against whichever other
 * games it happened to be told about. The quiz checked only quizzes, the raids
 * checked quizzes and raids, Mafia checked those two and not the quick rooms, so
 * two rooms of different games could share a code, and a player typing it into
 * the wrong join screen walked into a stranger's game rather than being told
 * there was none.
 *
 * So every holder registers itself here once, and a new code is checked against
 * all of them at the moment it is handed out. Holders are asked rather than
 * copied: there is no second list of codes to fall out of step with the tables
 * that own them, and nothing to release when a table goes.
 */
export class CodeRegistry {
  private readonly holders: CodeHolder[] = [];

  constructor(private readonly random: (maxExclusive: number) => number = randomInt) {}

  /** Adds a namespace that every code handed out from now on has to stay clear of. */
  track(holder: CodeHolder): void {
    this.holders.push(holder);
  }

  /**
   * A code nobody in the house is using.
   *
   * Free only until the caller files something under it, so the caller files it
   * before it next yields: an `await` in between is a window for another create
   * to be handed the same code.
   */
  allocate(): string {
    for (let attempt = 0; attempt < 200; attempt++) {
      const code = generateJoinCode(this.random);
      if (!this.holders.some((holder) => holder.has(code))) return code;
    }
    throw new Error('could not allocate an unused join code');
  }
}
