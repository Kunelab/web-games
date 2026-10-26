import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openDb } from '../db/open.js';
import { chargeUnits, quotaDay, searchesOn, spendSearch, unitsLeft } from './youtube-budget.js';

const clock = { now: () => Date.parse('2026-10-26T12:00:00Z') };

describe("the day's YouTube allowance", () => {
  it('gives out searches up to the budget and no further', () => {
    const { db } = openDb(':memory:');

    assert.equal(spendSearch(db, 2, clock), true);
    assert.equal(spendSearch(db, 2, clock), true);
    assert.equal(spendSearch(db, 2, clock), false);
    assert.equal(searchesOn(db, quotaDay(clock)), 2);
  });

  it('counts the units of the cheap calls against the same day', () => {
    const { db } = openDb(':memory:');
    chargeUnits(db, 30, clock);

    // A search is a hundred units: one fits beside thirty, a second does not.
    assert.equal(unitsLeft(db, 2, clock), 170);
    assert.equal(spendSearch(db, 2, clock), true);
    assert.equal(spendSearch(db, 2, clock), false);
    // Thirty units are a search begun.
    assert.equal(searchesOn(db, quotaDay(clock)), 2);
  });
});
