import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gameConfigSchema } from '../config.js';
import { applyHeroAction, startGame } from '../engine.js';
import { createGame, joinHero } from '../state.js';
import { seedRng } from '../rng.js';
import { generateBoard, LAYOUT_IDS } from './index.js';
import { findsFor, lootBonusFor, SHINY_LOOT, START_FINDS } from './programs.js';
import { ROADWAY_PROGRAMS } from '../map.js';

/**
 * The search budget: how much a room holds, and that it runs out.
 *
 * Two separate claims, and they fail in opposite directions. The engine one is that
 * a room *stops* giving — without it, standing still in a good room is the strongest
 * play in the game and the whole "rooms differ" design is decorative. The generator
 * one is that there is nevertheless far more stock on a board than a raid can spend,
 * because this was never meant to be a scarcity dial: if the supply ever became
 * tight it would be squeezing the loot curve the bench spent five versions
 * balancing, from a direction nobody would think to look.
 */

function board(layout: string, seed: number) {
  return generateBoard(seedRng(seed), gameConfigSchema.parse({ layout }));
}

/**
 * The character is pinned, not auto-seated.
 *
 * Auto-seating draws from the base roster with the state's own RNG, so which
 * survivor turns up is a function of the seed — and one of them (Chuck) now bends
 * this very rule by finding one more thing than a room has left. A test about the
 * general rule that silently sometimes gets the exception is a test that fails
 * whenever an unrelated change shifts a die.
 */
function game(heroId = 'rosa', overrides: Record<string, unknown> = {}) {
  const state = createGame({
    code: 'TEST',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    config: gameConfigSchema.parse({ startingZombies: 0, fog: 'none', ...overrides }),
    seed: 4242
  });
  const { hero } = joinHero(state, 'Testeuse', undefined);
  hero.heroId = heroId;
  startGame(state, 0);
  return { state, hero };
}

/** Two survivors, both seated in the lobby, for the rules that involve a second one. */
function pair(firstId: string, secondId: string) {
  const state = createGame({
    code: 'TEST',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    config: gameConfigSchema.parse({ startingZombies: 0, fog: 'none' }),
    seed: 4242
  });
  const { hero } = joinHero(state, 'Première', undefined);
  const { hero: mate } = joinHero(state, 'Seconde', undefined);
  hero.heroId = firstId;
  mate.heroId = secondId;
  startGame(state, 0);
  return { state, hero, mate };
}

describe('a room runs dry', () => {
  it('refuses a search once its stock is spent, and charges nothing for the refusal', () => {
    const { state, hero } = game();
    const room = state.board.rooms.find((candidate) => candidate.id === hero.roomId);
    assert.ok(room);

    // Empty it by hand rather than by searching: the point is the refusal, not
    // however many free crates the opening happens to hand out.
    room.finds = 1;
    hero.freeSearchUsed = true;
    hero.freeRaidSearchUsed = true;
    hero.ap = 3;

    const first = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(first.ok, true);
    assert.equal(room.finds, 0);
    assert.equal(hero.ap, 2);

    const refused = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(refused.ok, false);
    assert.match(typeof refused.error === 'string' ? refused.error : '', /vidée/i);
    assert.equal(hero.ap, 2, 'a refused action must not cost a point');
    assert.equal(hero.bag.length, 1, 'nor hand out an item');
  });

  it('does not spend a free search on a refusal either', () => {
    const { state, hero } = game();
    const room = state.board.rooms.find((candidate) => candidate.id === hero.roomId);
    assert.ok(room);
    room.finds = 0;

    const refused = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(refused.ok, false);
    assert.equal(hero.freeRaidSearchUsed, false, 'the raid’s one free crate survives a refusal');
    assert.equal(hero.freeSearchUsed, false);
  });

  it('Chuck finds one more thing than the room has left — exactly one', () => {
    const { state, hero } = game('chuck');
    const room = state.board.rooms.find((candidate) => candidate.id === hero.roomId);
    assert.ok(room);

    room.finds = 0;
    hero.freeSearchUsed = true;
    hero.freeRaidSearchUsed = true;
    hero.ap = 3;

    const extra = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(extra.ok, true, 'a spent room is never quite spent for him');

    /**
     * And then it really is done.
     *
     * This is the assertion that caught the implementation being wrong: clamping the
     * room's stock at zero looked tidier and handed Chuck an *unlimited* supply,
     * because his allowance recomputed to one on every attempt. Letting the stock go
     * negative is what makes the second answer no.
     */
    hero.ap = 3;
    const again = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(again.ok, false, 'his extra find is one find, not a licence');
    assert.equal(hero.ap, 3, 'and the refusal is free');
  });

  it('Chuck’s extra find does not lend the room stock to anybody else', () => {
    // Both seats taken before the raid starts: `joinHero` refuses a latecomer,
    // rightly, so a two-survivor fixture has to be built in the lobby.
    const { state, hero, mate } = pair('chuck', 'rosa');
    const room = state.board.rooms.find((candidate) => candidate.id === hero.roomId);
    assert.ok(room);
    assert.ok(mate);

    mate.roomId = hero.roomId;
    mate.ap = 3;
    mate.freeSearchUsed = true;
    mate.freeRaidSearchUsed = true;

    room.finds = 0;
    hero.freeSearchUsed = true;
    hero.freeRaidSearchUsed = true;
    hero.ap = 3;

    assert.equal(applyHeroAction(state, hero.playerId, { type: 'search' }).ok, true);
    assert.equal(
      applyHeroAction(state, mate.playerId, { type: 'search' }).ok,
      false,
      'the room was already empty before he looked, and it is emptier now'
    );
  });

  it('one room emptying leaves the room next door alone', () => {
    const { state, hero } = game();
    const here = state.board.rooms.find((candidate) => candidate.id === hero.roomId);
    assert.ok(here);
    const elsewhere = state.board.rooms.find((candidate) => candidate.id !== here.id && candidate.finds > 0);
    assert.ok(elsewhere);
    const stock = elsewhere.finds;

    here.finds = 1;
    hero.freeSearchUsed = true;
    hero.freeRaidSearchUsed = true;
    applyHeroAction(state, hero.playerId, { type: 'search' });

    assert.equal(elsewhere.finds, stock, 'the budget is per room, not per board');
  });

  it('the start room is stocked for a full table on turn one', () => {
    // Two free searches each, up to five survivors, all standing on the same
    // pavement. Finding the opening room empty reads as a broken game.
    for (const layout of LAYOUT_IDS) {
      const built = board(layout, 77);
      const start = built.rooms.find((room) => room.kind === 'start');
      assert.ok(start, layout);
      assert.ok(start.finds >= START_FINDS, `${layout}: start room holds only ${start.finds}`);
    }
  });
});

describe('how much a room holds', () => {
  it('scales with what the room is worth searching', () => {
    // The same sentence should be true of both numbers: an armoury is worth going
    // to, and worth staying in for a while.
    assert.ok(findsFor('armoury', 1) > findsFor('office', 1));
    assert.ok(findsFor('office', 1) > findsFor('street', 1));
  });

  it('gives a roadway almost nothing, which is what a road is', () => {
    for (const program of ROADWAY_PROGRAMS) {
      assert.equal(findsFor(program, 9), 1, program);
    }
  });

  it('never lets a big poor room out-hold a small rich one', () => {
    // Without the cap the outdoor rooms — the largest on the board and the poorest
    // by design — would hold the most of anything.
    assert.ok(findsFor('armoury', 1) > findsFor('yard', 9));
    assert.ok(findsFor('pharmacy', 1) > findsFor('sidewalk', 9));
  });

  it('always holds at least one thing', () => {
    for (const cells of [1, 4, 9]) {
      for (const program of ['street', 'yard', 'restroom', 'armoury'] as const) {
        assert.ok(findsFor(program, cells) >= 1, `${program} ${cells}`);
      }
    }
  });

  it('a shiny room really does hold more than an ordinary one', () => {
    // The glitter on the floor and the stock behind it have to agree, or the map
    // is advertising something the room does not have.
    const shiny = (['pharmacy', 'armoury', 'evidence'] as const).filter(
      (program) => lootBonusFor(program) >= SHINY_LOOT
    );
    assert.ok(shiny.length > 0);
    for (const program of shiny) {
      assert.ok(findsFor(program, 1) >= 3, program);
    }
  });
});

describe('the supply is not a scarcity dial', () => {
  /**
   * What a greedy full table actually spends, measured on the bench rather than
   * argued: five `looter` bots on `difficile` open about fourteen crates in a raid,
   * because a bot stops when its hands are good and not when the board runs out.
   * Boards hold 200–290. The margin is an order of magnitude, and it should stay
   * one: the moment the supply became tight this would be squeezing the loot curve
   * from a direction nobody would think to look.
   */
  const GREEDY_RAID_SEARCHES = 14;

  for (const layout of LAYOUT_IDS) {
    it(`${layout}: holds far more than a raid spends`, () => {
      // Several boards, because one seed is an anecdote.
      let total = 0;
      const boards = 8;
      for (let index = 0; index < boards; index++) {
        total += board(layout, 1234 + index * 97).rooms.reduce((sum, room) => sum + room.finds, 0);
      }
      const average = total / boards;

      assert.ok(
        average > GREEDY_RAID_SEARCHES * 8,
        `${layout}: ${average.toFixed(0)} finds against ${GREEDY_RAID_SEARCHES} spent`
      );
    });
  }

  it('every room on every layout is stocked', () => {
    for (const layout of LAYOUT_IDS) {
      const built = board(layout, 999);
      for (const room of built.rooms) {
        assert.ok(room.finds >= 1, `${layout} ${room.id} (${room.program}) holds nothing at all`);
      }
    }
  });

  it('a room’s stock always matches its programme', () => {
    // A cluster overflow turns an armoury into a corridor, and `demote` has to
    // carry the stock across with the loot bonus. If only one of the two followed,
    // the board would hold jackpot stock behind a hallway's face — invisible, and
    // exactly the kind of thing nobody would think to look for.
    for (const layout of LAYOUT_IDS) {
      const built = board(layout, 31337);
      for (const room of built.rooms) {
        const expected =
          room.kind === 'start'
            ? Math.max(findsFor(room.program, room.cells.length), START_FINDS)
            : findsFor(room.program, room.cells.length);
        assert.equal(room.finds, expected, `${layout} ${room.id} (${room.program}) holds ${room.finds}`);
      }
    }
  });
});
