import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { answerFieldSchema, type AnswerField } from './answer-field.js';
import { mediaReadiness, partitionPlayable } from './readiness.js';
import { blindtest } from './kinds/blindtest.js';
import { quiz } from './kinds/quiz.js';
import { imageReveal } from './kinds/image-reveal.js';
import { validateMedia } from './registry.js';

function answer(overrides: Partial<AnswerField> = {}): AnswerField {
  return answerFieldSchema.parse({ key: 'title', label: 'Titre', value: 'Africa', ...overrides });
}

describe('drafts are savable', () => {
  it('accepts a blindtest with no video yet', () => {
    const result = validateMedia({
      kind: 'blindtest',
      title: 'Brouillon',
      answers: [],
      payload: blindtest.defaultPayload
    });
    assert.equal(result.success, true);
  });

  it('accepts a quiz with no question yet', () => {
    const result = validateMedia({
      kind: 'quiz',
      title: 'Brouillon',
      answers: [],
      payload: quiz.defaultPayload
    });
    assert.equal(result.success, true);
  });

  it('still rejects a structurally invalid payload', () => {
    // Not a draft, just wrong: a seven-character video id can never be valid.
    const result = validateMedia({
      kind: 'blindtest',
      title: 'Cassé',
      answers: [],
      payload: { ...blindtest.defaultPayload, code: 'abcdefg' }
    });
    assert.equal(result.success, false);
  });

  it('rejects an unknown kind', () => {
    const result = validateMedia({ kind: 'nope', title: 'x', answers: [], payload: {} });
    assert.equal(result.success, false);
  });

  it('rejects duplicate answer keys', () => {
    const result = validateMedia({
      kind: 'quiz',
      title: 'x',
      answers: [answer({ key: 'a' }), answer({ key: 'a' })],
      payload: quiz.defaultPayload
    });
    assert.equal(result.success, false);
  });
});

describe('mediaReadiness', () => {
  it('refuses a draft with nothing to present', () => {
    const readiness = mediaReadiness({
      kind: 'blindtest',
      answers: [answer()],
      payload: blindtest.defaultPayload
    });
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.missing, ['la vidéo YouTube']);
  });

  it('refuses an item with no answer worth points', () => {
    const readiness = mediaReadiness({
      kind: 'blindtest',
      answers: [answer({ value: '   ' })],
      payload: { ...blindtest.defaultPayload, code: 'thJgU9jkdU4' }
    });
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.missing, ['au moins une réponse']);
  });

  it('accepts a complete item', () => {
    const readiness = mediaReadiness({
      kind: 'blindtest',
      answers: [answer()],
      payload: { ...blindtest.defaultPayload, code: 'thJgU9jkdU4' }
    });
    assert.deepEqual(readiness, { ready: true, missing: [] });
  });

  it('reports every problem at once rather than one at a time', () => {
    const readiness = mediaReadiness({
      kind: 'image-reveal',
      answers: [],
      payload: imageReveal.defaultPayload
    });
    assert.equal(readiness.missing.length, 2);
  });

  it('catches a choice field whose answer is not among its choices', () => {
    const readiness = mediaReadiness({
      kind: 'quiz',
      answers: [answer({ key: 'answer', value: 'Oulan-Bator', choices: ['Astana', 'Bichkek'] })],
      payload: { question: 'Capitale de la Mongolie ?', imageUrl: '', explanation: '' }
    });
    assert.equal(readiness.ready, false);
    assert.ok(readiness.missing.some((entry) => entry.includes('choix')));
  });
});

describe('partitionPlayable', () => {
  it('separates playable items from drafts', () => {
    const ready = {
      kind: 'blindtest',
      answers: [answer()],
      payload: { ...blindtest.defaultPayload, code: 'thJgU9jkdU4' }
    };
    const draft = { kind: 'blindtest', answers: [], payload: blindtest.defaultPayload };

    const { playable, skipped } = partitionPlayable([ready, draft]);
    assert.equal(playable.length, 1);
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0]?.missing.length);
  });
});
