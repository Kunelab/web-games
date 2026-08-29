import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gameConfigSchema } from './config.js';
import { applyHeroAction, startGame } from './engine.js';
import { createGame, joinBot, joinHero, rematch, setLoadout, setMutations, spawnZombie } from './state.js';

/**
 * Another raid for the same table.
 *
 * Worth testing rather than reading because of what it has to carry and what it has
 * to *not* carry, and both halves fail silently. Keeping the code and the seat tokens
 * is the whole trick — it is what lets every phone in the room walk into the new
 * lobby without anybody typing anything — so a token that changed would look exactly
 * like "the game lost my seat", the bug this feature is supposed to remove rather
 * than introduce. And a wound or an inventory that survived would be a raid the table
 * did not play.
 */

function played() {
  const state = createGame({
    code: 'SAME',
    hostToken: 'host-token',
    gmToken: 'gm-token',
    hostUserId: 7,
    config: gameConfigSchema.parse({ mode: 'gm', gmClass: 'boucher', keys: 2, startingZombies: 0 }),
    seed: 111
  });

  const { hero } = joinHero(state, 'Maxime', undefined, ['tough-skin'], 'maxime');
  const bot = joinBot(state, 'Machine', 'looter', 'newbie');
  // A deliberate pick, so the rematch has something to carry forward. `joinHero`
  // hands back the seat itself, so this is the same object the state holds.
  hero.heroId = 'charles';
  setLoadout(state, hero.playerId, ['fetiche']);
  setMutations(state, ['thick', 'claws']);
  startGame(state, 0);

  // And then a raid happens to them.
  hero.hp = 10;
  hero.kills = 6;
  hero.searches = 4;
  hero.bag.push(...hero.bag, ...hero.bag);
  spawnZombie(state, hero.roomId, 'walker');
  applyHeroAction(state, hero.playerId, { type: 'search' });

  return { state, heroId: hero.playerId, botId: bot.playerId };
}

describe('rematch carries the table', () => {
  const { state, heroId, botId } = played();
  const next = rematch(state, 222);
  const before = state.heroes[heroId];
  const after = Object.values(next.heroes).find((hero) => hero.token === before?.token);

  it('keeps the code, so nothing has to be read out again', () => {
    assert.equal(next.code, state.code);
  });

  it('keeps the host and game master tokens', () => {
    assert.equal(next.hostToken, state.hostToken);
    assert.equal(next.gmToken, state.gmToken);
  });

  it('keeps every seat token, which is what a phone reclaims its seat with', () => {
    const tokens = new Set(Object.values(next.heroes).map((hero) => hero.token));
    for (const hero of Object.values(state.heroes)) {
      assert.ok(tokens.has(hero.token), `${hero.name} lost their seat`);
    }
  });

  it('keeps the names, the ledger, the character and the pick', () => {
    assert.ok(after);
    assert.equal(after.name, 'Maxime');
    assert.equal(after.account, 'maxime');
    assert.equal(after.heroId, 'charles');
    assert.deepEqual(after.loadout, ['fetiche']);
    assert.deepEqual(after.perks, ['tough-skin']);
  });

  it('keeps a bot a bot, with its personality', () => {
    const bot = Object.values(next.heroes).find((hero) => hero.token === state.heroes[botId]?.token);
    assert.ok(bot);
    assert.equal(bot.isBot, true);
    assert.deepEqual(bot.bot, { mindset: 'looter', skill: 'newbie' });
  });

  it('keeps the settings, and the handicap the table chose', () => {
    assert.equal(next.config.mode, 'gm');
    assert.equal(next.config.gmClass, 'boucher');
    assert.equal(next.config.keys, 2);
    assert.deepEqual(next.config.mutations, ['thick', 'claws']);
  });
});

describe('rematch drops the raid', () => {
  const { state, heroId } = played();
  const next = rematch(state, 222);
  const after = Object.values(next.heroes).find((hero) => hero.token === state.heroes[heroId]?.token);

  it('starts in the lobby, on turn zero', () => {
    assert.equal(next.phase, 'lobby');
    assert.equal(next.turn, 0);
  });

  it('heals everybody and empties the bags', () => {
    assert.ok(after);
    assert.equal(after.hp, after.maxHp);
    assert.equal(after.kills, 0);
    assert.equal(after.searches, 0);
    assert.ok(after.bag.length <= 1, 'the bag came back full');
    assert.equal(after.alive, true);
    assert.equal(after.escaped, false);
  });

  it('clears the board of the last raid', () => {
    /**
     * Against a freshly drawn world rather than against nothing.
     *
     * A new district seats its own pieces before anybody arrives — a boss
     * objective puts its colossus down at creation — so "the board is empty" is
     * a claim about the seed, not about the rematch, and it breaks the day the
     * dice fall differently. What has to hold is that the rematch adds nothing
     * of its own: the raid that just ended left nothing behind.
     */
    const fresh = createGame({
      code: state.code,
      hostToken: state.hostToken,
      gmToken: state.gmToken,
      hostUserId: state.hostUserId,
      config: { ...state.config, mutations: [...state.config.mutations] },
      seed: 222,
      gmPerks: [...state.gmPerks],
      gmLoadout: [...state.gmLoadout]
    });

    assert.equal(Object.keys(next.zombies).length, Object.keys(fresh.zombies).length);
    assert.equal(next.log.length, fresh.log.length);
  });

  it('draws a new world', () => {
    assert.notEqual(next.seed, state.seed);
  });
});

describe('rematch does not alias the old raid', () => {
  it('editing the new config leaves the old one alone', () => {
    /**
     * The old state is still alive while this is built — the server broadcasts it,
     * the phones are still showing its scoreboard — so two raids pointing at one
     * config object is the kind of aliasing that surfaces three features later as a
     * mutation leaking backwards into a finished game.
     */
    const { state } = played();
    const next = rematch(state, 222);

    assert.notEqual(next.config, state.config, 'the config object is shared');
    setMutations(next, ['swift']);
    assert.deepEqual(state.config.mutations, ['thick', 'claws'], 'the old raid changed under us');

    next.gmPerks.push('overlord');
    assert.ok(!state.gmPerks.includes('overlord'), 'the perk arrays are shared');
  });
});
