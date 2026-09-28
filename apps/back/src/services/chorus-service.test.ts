import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DIALOGUE_PROFILE,
  THEME_PROFILE,
  VOCAL_PROFILE,
  alignsWith,
  clipWindow,
  uploadKind,
  type ChorusInfo
} from './chorus-service.js';

/** A three minute track whose hook lands at 0:40, 1:10 and 2:10. */
const chorus: ChorusInfo = { hits: [40, 70, 130], line: 'the hook', trackDuration: 180 };

/** Deterministic rolls, so an angle can be asked for rather than waited for. */
const always = (value: number) => () => value;

describe('alignsWith', () => {
  it('accepts a video whose clock matches the track', () => {
    assert.equal(alignsWith(chorus, 182), true);
  });

  it('rejects a music video that drifts', () => {
    // The real case: a VEVO upload with a cold open, measured at 22 to 64 seconds
    // out. Its clock is not the track's, so the lyric timestamps mean nothing.
    assert.equal(alignsWith(chorus, 245), false);
  });

  it('rejects when either duration is unknown', () => {
    assert.equal(alignsWith(chorus, null), false);
    assert.equal(alignsWith({ ...chorus, trackDuration: null }, 180), false);
  });
});

describe('uploadKind', () => {
  it('tells the recording from the video', () => {
    assert.equal(uploadKind('Daft Punk - Topic', 'One More Time'), 'topic');
    assert.equal(uploadKind('Daft Punk', 'Daft Punk - One More Time (Official Audio)'), 'audio');
    assert.equal(uploadKind('Stromae', 'Stromae - Papaoutai (Audio officiel)'), 'audio');
    assert.equal(uploadKind('Stromae', 'Stromae - Papaoutai (Clip Officiel)'), 'video');
  });
});

describe('clipWindow', () => {
  it('puts an easy round on the intro or the chorus, never a verse', () => {
    for (const roll of [0, 0.44, 0.46, 0.99]) {
      const plan = clipWindow(180, { chorus, difficulty: 10, random: always(roll) });
      assert.notEqual(plan.angle, 'verse', `roll ${roll} produced a verse on an easy round`);
    }
  });

  it('avoids the hook on a hard round', () => {
    const plan = clipWindow(180, { chorus, difficulty: 95, random: always(0.1) });
    assert.equal(plan.angle, 'verse');
    // The widest gap here is 70 to 130, so the window starts inside it and clear
    // of both choruses rather than on either.
    assert.ok(plan.startGuess > 70, `expected a verse after the second chorus, got ${plan.startGuess}`);
    assert.ok(plan.startGuess < 130);
  });

  it('does not drag a late verse back onto the chorus', () => {
    /**
     * The regression this exists for. `VOCAL_PROFILE.maxStart` is 80, and the
     * widest gap in this six minute track is the one after the last chorus at
     * 3:20. Clamping a *measured* position to the profile's ceiling pulled the
     * window back to 80s, which here sits inside the second chorus: the round
     * played the hook while reporting itself as a verse, so the hard end of the
     * slider quietly served the easiest thing in the song.
     */
    const late: ChorusInfo = { hits: [40, 80, 120, 200], line: 'the hook', trackDuration: 360 };
    const plan = clipWindow(360, { chorus: late, difficulty: 95, profile: VOCAL_PROFILE, random: always(0.1) });

    assert.equal(plan.angle, 'verse');
    assert.ok(plan.startGuess > VOCAL_PROFILE.maxStart, `expected past the profile ceiling, got ${plan.startGuess}`);
    for (const hit of late.hits) {
      // Clear of the whole chorus section, not merely of the line that starts it.
      const overlaps = plan.startGuess < hit + 20 && plan.endGuess > hit;
      assert.ok(!overlaps, `verse window ${plan.startGuess}-${plan.endGuess} overlaps the chorus at ${hit}`);
    }
  });

  it('keeps the reveal inside the phase that plays it', () => {
    // The blind test kind reveals for 12 seconds. A longer window is not a longer
    // reveal, it is a window cut off mid-phrase by the phase change.
    for (const difficulty of [10, 50, 90]) {
      const plan = clipWindow(180, { chorus, difficulty, random: always(0.5) });
      assert.ok(plan.endReveal - plan.startReveal <= 12, `reveal ran ${plan.endReveal - plan.startReveal}s`);
    }
  });

  it('takes the second chorus, not the first, when it asks for the hook', () => {
    const plan = clipWindow(180, { chorus, difficulty: 20, random: always(0.9) });
    assert.equal(plan.angle, 'chorus');
    assert.equal(plan.startGuess, 70);
  });

  it('carries the reveal on from the guess window', () => {
    // Guess 22 to 42, reveal 41 to 53: the song keeps playing into the answer.
    for (const difficulty of [5, 50, 95]) {
      for (const roll of [0.1, 0.5, 0.9]) {
        const plan = clipWindow(180, { chorus, difficulty, random: always(roll) });
        assert.equal(plan.startReveal, plan.endGuess - 1, `${difficulty}/${roll}: ${JSON.stringify(plan)}`);
        assert.equal(plan.endReveal - plan.startReveal, 12);
      }
    }
  });

  it('slides the reveal back rather than cut it short at the end of the video', () => {
    const plan = clipWindow(40, { chorus: null, difficulty: 50, upload: 'topic', random: always(0.5) });
    assert.ok(plan.endReveal <= 38, JSON.stringify(plan));
    assert.equal(plan.endReveal - plan.startReveal, 12);
  });

  it('shifts the lyrics past a music video’s skit', () => {
    // Same chorus, a video 65 seconds longer than the recording: a cold open.
    // The timings are moved past it, and no window starts inside it.
    for (const roll of [0.1, 0.5, 0.9]) {
      const plan = clipWindow(245, { chorus, difficulty: 50, profile: VOCAL_PROFILE, random: always(roll) });
      assert.ok(plan.startGuess >= 65, `started at ${plan.startGuess}, inside the extra`);
    }
    const hook = clipWindow(245, { chorus, difficulty: 20, profile: VOCAL_PROFILE, random: always(0.9) });
    assert.equal(hook.angle, 'chorus');
    assert.equal(hook.startGuess, 70 + 65);
  });

  it('keeps both windows inside the recording, wherever the extra sits', () => {
    // 65 seconds of extra: if it were all at the end, the song stops at 180.
    for (const roll of [0.1, 0.5, 0.9]) {
      const plan = clipWindow(245, { chorus, difficulty: 50, profile: VOCAL_PROFILE, random: always(roll) });
      assert.ok(plan.endReveal <= 180, JSON.stringify(plan));
    }
  });

  it('gives up on lyrics too far from the video, but still starts past the extra', () => {
    const plan = clipWindow(400, { chorus, difficulty: 50, profile: VOCAL_PROFILE, random: always(0.5) });
    assert.equal(plan.source, 'profile');
    assert.ok(plan.startGuess >= 220, `started at ${plan.startGuess}`);
  });

  it('uses the recording length from a catalogue when there are no lyrics', () => {
    const plan = clipWindow(260, {
      difficulty: 10,
      trackSeconds: 200,
      profile: VOCAL_PROFILE,
      random: always(0.1)
    });
    // 60 seconds of video that is not the song: the intro is past it.
    assert.equal(plan.angle, 'intro');
    assert.ok(plan.startGuess >= 60, JSON.stringify(plan));
  });

  it('still opens an anime opening or a film theme on its intro', () => {
    // Those uploads start on the music; the caution is for sung music videos.
    const plan = clipWindow(91, { difficulty: 10, profile: THEME_PROFILE, random: always(0.1) });
    assert.equal(plan.angle, 'intro');
    assert.equal(plan.startGuess, THEME_PROFILE.minStart);
  });

  it('never opens a music video it knows nothing about on its intro', () => {
    for (const roll of [0, 0.5, 0.99]) {
      const plan = clipWindow(180, { difficulty: 10, random: always(roll) });
      assert.notEqual(plan.angle, 'intro');
    }
  });

  it('uses a model hint for an instrumental, clamped into range', () => {
    const plan = clipWindow(200, { difficulty: 50, profile: THEME_PROFILE, hintFraction: 0.25, random: always(0.5) });
    assert.equal(plan.source, 'hint');
    assert.equal(plan.startGuess, 50);
  });

  it('never lets a hint point past the end of the track', () => {
    const plan = clipWindow(200, { difficulty: 50, profile: THEME_PROFILE, hintFraction: 9, random: always(0.5) });
    assert.ok(plan.endGuess <= 200);
    assert.ok(plan.startGuess <= THEME_PROFILE.maxStart);
  });

  it('keeps both windows at least a second wide on a very short clip', () => {
    // The payload schema refuses a window that is not, so this is validation
    // rather than taste: a collapsed window fails to save at all.
    const plan = clipWindow(3, { chorus, difficulty: 50, random: always(0.5) });
    assert.ok(plan.endGuess > plan.startGuess);
    assert.ok(plan.endReveal > plan.startReveal);
  });

  it('starts dialogue at the top, because the whole clip is the scene', () => {
    const plan = clipWindow(90, { difficulty: 50, profile: DIALOGUE_PROFILE, random: always(0.5) });
    assert.ok(plan.startGuess <= DIALOGUE_PROFILE.maxStart);
  });

  it('has no chorus angle to offer when there are no lyrics', () => {
    for (const roll of [0, 0.5, 0.99]) {
      // An audio upload, which starts on the music, so its intro is safe to ask about.
      const plan = clipWindow(180, { difficulty: 10, upload: 'audio', random: always(roll) });
      assert.equal(plan.angle, 'intro');
      assert.equal(plan.source, 'profile');
    }
  });
});
