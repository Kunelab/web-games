import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { awardMeta } from './awards';
import { badgeMeta } from './badges';
import { czPerkMeta, czTrophyMeta } from './czMeta';
import { kindColor, kindName } from './kinds';
import { mafiaBadgeMeta } from './mafiaBadges';

/**
 * The faces the server's keys are given, read through the functions every
 * screen calls.
 *
 * Each table answers two kinds of key. One it lists gets its own emoji and its
 * checked catalogue keys. One it has never heard of, which is what a server a
 * release ahead of this build sends, gets the generic face and a key built from
 * the raw id, so the page still renders and the missing line shows as itself.
 *
 * `toString` stands for the third kind, and the one that is easy to get wrong:
 * a key every plain object answers to by inheritance. It is not in any table,
 * and must be read as unknown rather than handing a function to the page as an
 * emoji.
 */

describe('the faces of server keys', () => {
  it('gives an award it knows its own emoji, and one it does not the generic medal', () => {
    assert.deepEqual(awardMeta('sniper'), { emoji: '🎯', title: { k: 'award.sniper' } });
    assert.deepEqual(awardMeta('pacifist'), { emoji: '🏅', title: { k: 'award.pacifist' } });
    assert.deepEqual(awardMeta('toString'), { emoji: '🏅', title: { k: 'award.toString' } });
  });

  it('gives a quiz badge it knows its own emoji, and one it does not the generic medal', () => {
    assert.deepEqual(badgeMeta('pillar'), {
      emoji: '🛋️',
      title: { k: 'badge.pillar' },
      hint: { k: 'badge.pillar.hint' }
    });
    assert.deepEqual(badgeMeta('night-owl'), {
      emoji: '🏅',
      title: { k: 'badge.night-owl' },
      hint: { k: 'badge.night-owl.hint' }
    });
    assert.deepEqual(badgeMeta('toString'), {
      emoji: '🏅',
      title: { k: 'badge.toString' },
      hint: { k: 'badge.toString.hint' }
    });
  });

  it('gives a CoronaZ trophy it knows its own emoji, and one it does not the generic medal', () => {
    assert.deepEqual(czTrophyMeta('boss-hunter'), {
      emoji: '🏹',
      title: { k: 'coronaz.trophy.boss-hunter' },
      hint: { k: 'coronaz.trophy.boss-hunter.hint' }
    });
    assert.deepEqual(czTrophyMeta('pyromaniac'), {
      emoji: '🏅',
      title: { k: 'coronaz.trophy.pyromaniac' },
      hint: { k: 'coronaz.trophy.pyromaniac.hint' }
    });
    assert.deepEqual(czTrophyMeta('toString'), {
      emoji: '🏅',
      title: { k: 'coronaz.trophy.toString' },
      hint: { k: 'coronaz.trophy.toString.hint' }
    });
  });

  it('gives a CoronaZ perk it knows its own emoji, and one it does not the generic sparkle', () => {
    assert.deepEqual(czPerkMeta('sprinter'), { emoji: '👟', label: { k: 'coronaz.perk.sprinter' } });
    assert.deepEqual(czPerkMeta('night-vision'), { emoji: '✨', label: { k: 'coronaz.perk.night-vision' } });
    assert.deepEqual(czPerkMeta('toString'), { emoji: '✨', label: { k: 'coronaz.perk.toString' } });
  });

  it('gives a Mafia badge it knows its own emoji, and one it does not the generic medal', () => {
    assert.deepEqual(mafiaBadgeMeta('kingmaker'), {
      emoji: '👑',
      title: { k: 'mafia.badge.kingmaker' },
      hint: { k: 'mafia.badge.kingmaker.hint' }
    });
    assert.deepEqual(mafiaBadgeMeta('turncoat'), {
      emoji: '🏅',
      title: { k: 'mafia.badge.turncoat' },
      hint: { k: 'mafia.badge.turncoat.hint' }
    });
    assert.deepEqual(mafiaBadgeMeta('toString'), {
      emoji: '🏅',
      title: { k: 'mafia.badge.toString' },
      hint: { k: 'mafia.badge.toString.hint' }
    });
  });

  it('gives a media kind it knows its own colour and name, and one it does not the faint ink', () => {
    assert.equal(kindColor('estimation'), 'var(--kind-estimation)');
    assert.deepEqual(kindName('estimation'), { k: 'quiz.kind.estimation' });

    assert.equal(kindColor('karaoke'), 'var(--ink-faint)');
    assert.deepEqual(kindName('karaoke'), { k: 'quiz.kind.karaoke' });

    assert.equal(kindColor('toString'), 'var(--ink-faint)');
    assert.deepEqual(kindName('toString'), { k: 'quiz.kind.toString' });
  });
});
