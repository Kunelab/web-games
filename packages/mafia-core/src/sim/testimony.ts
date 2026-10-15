import { ROLES, type RoleId } from '../roles.js';
import { sheriffSuspects, type IntelEntry } from '../state.js';
import { isEvilRole, tradeVerdict, type Claim } from './policies.js';

/**
 * What one night's record says out loud, as claims on the board.
 *
 * The one rule wherever a record becomes words: a dead seat's will read off the
 * graveyard, a live seat reading out its night on the stand, a liar's invented
 * notebook, the bench's wills, and a promise kept the next morning. There used
 * to be four copies of this mapping and they disagreed about the Lookout (every
 * visitor, the first only, or an accusation at a house that died), about a tail
 * that went nowhere and about a blocked night, so the same night read one way
 * in a will and another from the stand.
 *
 * Only what the night found. A night that merely happened to the seat (it was
 * blocked, jailed, saved, doused) names nobody and is said here as nothing; the
 * one caller that needs an excuse for an empty night, a promise kept, adds it
 * itself. Every claim is signed by the speaker, dated to the night it is about
 * and marked as worked, because a record read out is the badge speaking and not
 * a hunch.
 *
 * `rolesInPlay` is the roster on the wall, which is what an examiner's smell is
 * read against: a line only one dealt role could leave is a verdict.
 */
export function testimonyOf(
  entry: IntelEntry,
  speakerSlot: number,
  rolesInPlay?: ReadonlySet<RoleId>
): Omit<Claim, 'truthful'>[] {
  const base = {
    day: entry.night,
    night: entry.night,
    claimerSlot: speakerSlot,
    worked: true,
    from: entry.kind
  } as const;
  switch (entry.kind) {
    case 'sheriff':
      return [{ ...base, targetSlot: entry.targetSlot, kind: sheriffSuspects(entry.value) ? 'accuse' : 'clear' }];
    case 'role':
      // Guarded, so a stray string in a record cannot become a claim.
      if (!(entry.value in ROLES)) return [];
      return [{ ...base, targetSlot: entry.targetSlot, kind: isEvilRole(entry.value as RoleId) ? 'accuse' : 'clear' }];
    case 'visitors':
      // A watcher standing at the door is in its own list; it does not sight itself.
      return (entry.slots ?? [])
        .filter((visitor) => visitor !== speakerSlot)
        .map((visitor) => ({ ...base, targetSlot: visitor, kind: 'sighting' as const, at: entry.targetSlot }));
    case 'tracked': {
      // Where the tail ended is the finding. A tail that went nowhere saw nobody go out.
      const where = entry.slots?.[0];
      return where === undefined ? [] : [{ ...base, targetSlot: entry.targetSlot, kind: 'sighting', at: where }];
    }
    case 'trade': {
      const verdict = tradeVerdict(entry.value, rolesInPlay);
      return [
        {
          ...base,
          targetSlot: entry.targetSlot,
          kind: verdict === 'damning' ? 'accuse' : verdict === 'clean' ? 'clear' : 'hint'
        }
      ];
    }
    case 'went':
      return [{ ...base, targetSlot: entry.targetSlot, kind: 'account', account: 'visited' }];
    default:
      return [];
  }
}
