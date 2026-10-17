import type { Personality, Quirks } from "./policies.js";

/**
 * The people a bot can be.
 *
 * Every live bot used to be `DEFAULT_PROFILE` rolled within 0.2 of itself, and
 * every threshold that gave a seat a voice of its own sat at or beyond the edge
 * of that range: an aggression over 0.7, a claim rate under 0.3, a deceit over
 * 0.6. So no bot ever reached one. Ten live games, 1,723 lines spoken by bots,
 * and every one of them was written by somebody "dry, a little sarcastic". A
 * table of twenty-two of the same person is not a table.
 *
 * A character is a starting point rather than a costume: its numbers are still
 * rolled within 0.2 of where it starts (see `makePersonality`), so two Hotheads
 * at one table are two different hotheads. What it adds is a *centre* far
 * enough from the average for the policy to play it differently, and a voice
 * for the mouth that matches what the policy is doing.
 *
 * The cast is balanced so its average is `DEFAULT_PROFILE`: aggression about
 * 0.5, herd 0.5, claim rate 0.7, deceit 0.4, courage 0.5. The bench numbers the
 * game is tuned against were measured on that average, and a mixed table plays
 * near it while each seat plays away from it.
 */
export type CharacterId =
  | "hothead"
  | "analyst"
  | "follower"
  | "quiet"
  | "smooth"
  | "joker"
  | "paranoid"
  | "veteran"
  | "earnest";

export interface Character {
  id: CharacterId;
  /** Where its numbers are rolled from. Anything left out is `DEFAULT_PROFILE`'s. */
  profile: Partial<Omit<Personality, "temperament" | "voice">>;
  /** How it comes across, for the mouth. See `Personality.voice`. */
  voice: Voice;
}

/**
 * How a character comes across: the temperament its lines are written in, how
 * it types, and whether it types in lowercase, which is the one habit applied
 * to a line after it is written (the phrasebook's lines included).
 */
export interface Voice {
  mood: string;
  habit: string;
  lowercase?: boolean;
}

const withQuirks = (partial: Partial<Quirks>): Quirks => ({
  stonewall: 0,
  waffle: 0,
  lateSwitch: 0,
  press: 0,
  ...partial,
});

export const CHARACTERS: readonly Character[] = [
  {
    id: "hothead",
    profile: {
      aggression: 0.85,
      herd: 0.35,
      claimRate: 0.8,
      deceit: 0.45,
      courage: 0.8,
    },
    voice: {
      mood: "hot-headed and combative, quick to accuse and slow to back down",
      habit: "Short punchy lines, the odd exclamation mark.",
    },
  },
  {
    id: "analyst",
    profile: {
      aggression: 0.3,
      herd: 0.2,
      claimRate: 0.75,
      deceit: 0.3,
      courage: 0.5,
      quirks: withQuirks({ press: 0.3 }),
    },
    voice: {
      mood: "calm and analytical, you reason from who said what and when",
      habit: "Complete sentences, a little precise, never shouting.",
    },
  },
  {
    id: "follower",
    profile: {
      aggression: 0.45,
      herd: 0.85,
      claimRate: 0.65,
      deceit: 0.35,
      courage: 0.4,
      quirks: withQuirks({ lateSwitch: 0.3 }),
    },
    voice: {
      mood: "easygoing and agreeable, happier backing a good point than making one",
      habit: 'Casual and friendly, the odd "yeah" or "fair".',
    },
  },
  {
    id: "quiet",
    profile: {
      aggression: 0.3,
      herd: 0.55,
      claimRate: 0.4,
      deceit: 0.35,
      courage: 0.45,
      quirks: withQuirks({ stonewall: 0.2 }),
    },
    voice: {
      mood: "taciturn: you barely speak, and never more than a few words",
      habit: "Lowercase, three to six words, no full stop.",
      lowercase: true,
    },
  },
  {
    id: "smooth",
    profile: {
      aggression: 0.4,
      herd: 0.45,
      claimRate: 0.7,
      deceit: 0.8,
      courage: 0.5,
    },
    voice: {
      mood: "smooth and friendly, plausible, never quite pinned down",
      habit: 'Relaxed and conversational, likes "honestly" and "look".',
    },
  },
  {
    id: "joker",
    profile: {
      aggression: 0.5,
      herd: 0.5,
      claimRate: 0.7,
      deceit: 0.45,
      courage: 0.55,
    },
    voice: {
      mood: "playful, you tease and joke but still make your point",
      habit: 'Light and a bit cheeky, the occasional "lol".',
    },
  },
  {
    id: "paranoid",
    profile: {
      aggression: 0.65,
      herd: 0.25,
      claimRate: 0.7,
      deceit: 0.35,
      courage: 0.55,
      quirks: withQuirks({ press: 0.4 }),
    },
    voice: {
      mood: "suspicious of everyone, you question motives and timing",
      habit: 'Lots of short questions: "why now?", "who benefits?".',
    },
  },
  {
    id: "veteran",
    profile: {
      aggression: 0.5,
      herd: 0.5,
      claimRate: 0.7,
      deceit: 0.4,
      courage: 0.5,
    },
    voice: { mood: "dry, a little sarcastic", habit: "Terse and deadpan." },
  },
  {
    id: "earnest",
    profile: {
      aggression: 0.35,
      herd: 0.6,
      claimRate: 0.85,
      deceit: 0.25,
      courage: 0.45,
    },
    voice: {
      mood: "earnest and a little anxious, you want the town to win and say so",
      habit: 'Polite, slightly over-explains, says "I think" a lot.',
    },
  },
];

/** The profile a seat cast as this character is rolled from: `base`, moved to where the character starts. */
export function castProfile(
  character: Character,
  base: Personality,
): Personality {
  return {
    ...base,
    ...character.profile,
    character: character.id,
    voice: character.voice,
  };
}

/**
 * One character, drawn from the cast.
 *
 * Its own draw, separate from the one that rolls the numbers, so adding a
 * character to the cast changes who a seat is and nothing about how a given
 * character's numbers come out.
 */
export function castCharacter(rng: () => number): Character {
  return CHARACTERS[Math.floor(rng() * CHARACTERS.length) % CHARACTERS.length];
}
