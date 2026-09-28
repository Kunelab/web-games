import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { msUntilQuotaReset } from './blindtest-prefill.js';

const HOUR = 60 * 60 * 1000;

describe('msUntilQuotaReset', () => {
  it('counts to midnight in Los Angeles, which is 9:00 in Paris', () => {
    // 06:00 in Paris in summer (UTC+2) is 04:00 UTC, 21:00 the evening before in LA.
    assert.equal(msUntilQuotaReset(new Date('2026-09-29T04:00:00Z')), 3 * HOUR);
    // And in winter, when both sides have moved an hour.
    assert.equal(msUntilQuotaReset(new Date('2026-12-15T05:00:00Z')), 3 * HOUR);
  });

  it('starts again just after the reset', () => {
    // 07:00:01 UTC is 00:00:01 in LA in summer.
    assert.equal(msUntilQuotaReset(new Date('2026-09-29T07:00:01Z')), 24 * HOUR - 1000);
  });

  it('never says zero or more than a day', () => {
    for (let minute = 0; minute < 24 * 60; minute += 17) {
      const left = msUntilQuotaReset(new Date(Date.UTC(2026, 8, 29, 0, minute)));
      assert.ok(left > 0 && left <= 24 * HOUR, String(left));
    }
  });
});
