import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChat, post, systemPost, visibleTo, type ChannelRules } from './chat.js';

/** Rules for tests: 'open' is public, 'secret' readable only by its members. */
const rules: ChannelRules<Set<string>> = {
  canRead: (channel, memberId, secretMembers) => channel === 'open' || secretMembers.has(memberId),
  canWrite: () => true
};

describe('chat-core', () => {
  it('posts and reads back a message', () => {
    const chat = createChat();
    const result = post(chat, { channel: 'open', authorId: 'a', authorName: 'Alice', text: 'salut', at: 1000 });
    assert.equal(result.ok, true);
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0]?.text, 'salut');
  });

  it('rejects empty and oversized messages', () => {
    const chat = createChat();
    assert.equal(post(chat, { channel: 'open', authorId: 'a', authorName: 'A', text: '   ', at: 0 }).ok, false);
    const long = 'x'.repeat(401);
    assert.equal(post(chat, { channel: 'open', authorId: 'a', authorName: 'A', text: long, at: 0 }).ok, false);
  });

  it('rate limits an author inside the window but not outside it', () => {
    const chat = createChat();
    for (let i = 0; i < 5; i++) {
      assert.equal(post(chat, { channel: 'open', authorId: 'a', authorName: 'A', text: `m${i}`, at: 1000 + i }).ok, true);
    }
    assert.equal(post(chat, { channel: 'open', authorId: 'a', authorName: 'A', text: 'too fast', at: 1010 }).ok, false);
    // Another author is unaffected.
    assert.equal(post(chat, { channel: 'open', authorId: 'b', authorName: 'B', text: 'me though', at: 1010 }).ok, true);
    // The same author, once the window has passed.
    assert.equal(post(chat, { channel: 'open', authorId: 'a', authorName: 'A', text: 'later', at: 12_000 }).ok, true);
  });

  it('filters channels per member', () => {
    const chat = createChat();
    post(chat, { channel: 'open', authorId: 'a', authorName: 'A', text: 'public', at: 1 });
    post(chat, { channel: 'secret', authorId: 'b', authorName: 'B', text: 'entre nous', at: 2 });
    systemPost(chat, 'secret', 'annonce secrète', 3);

    const insider = visibleTo(chat, 'b', new Set(['b']), rules);
    const outsider = visibleTo(chat, 'a', new Set(['b']), rules);
    assert.equal(insider.length, 3);
    assert.equal(outsider.length, 1);
    assert.equal(outsider[0]?.text, 'public');
  });

  it('keeps the log bounded', () => {
    const chat = createChat();
    for (let i = 0; i < 600; i++) {
      systemPost(chat, 'open', `m${i}`, i);
    }
    assert.equal(chat.messages.length, 500);
    assert.equal(chat.messages[0]?.text, 'm100');
  });
});
