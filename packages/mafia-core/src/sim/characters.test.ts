import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHARACTERS, castCharacter } from "./characters.js";
import { DEFAULT_PROFILE, makePersonality } from "./policies.js";

/** A small deterministic generator, so a table is the same table every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe("the cast", () => {
  /**
   * The balance numbers were measured on `DEFAULT_PROFILE`, so the cast has to
   * play near it on average while each seat plays away from it.
   */
  it("averages out to the default profile", () => {
    for (const trait of [
      "aggression",
      "herd",
      "claimRate",
      "deceit",
      "courage",
    ] as const) {
      const mean =
        CHARACTERS.reduce(
          (sum, character) =>
            sum + (character.profile[trait] ?? DEFAULT_PROFILE[trait]),
          0,
        ) / CHARACTERS.length;
      assert.ok(
        Math.abs(mean - DEFAULT_PROFILE[trait]) <= 0.05,
        `${trait} averages ${mean.toFixed(2)}`,
      );
    }
  });

  /** `9RVWV`: twenty-two bots, one voice. */
  it("seats a table with several voices", () => {
    const rng = seeded(42);
    const voices = new Set<string>();
    for (let seat = 0; seat < 20; seat++) {
      const character = castCharacter(rng);
      const personality = makePersonality(
        {
          ...DEFAULT_PROFILE,
          ...character.profile,
          character: character.id,
          voice: character.voice,
        },
        rng,
      );
      assert.equal(personality.voice?.mood, character.voice.mood);
      voices.add(character.voice.mood);
    }
    assert.ok(
      voices.size >= 5,
      `only ${voices.size} voices at a table of twenty`,
    );
  });
});
