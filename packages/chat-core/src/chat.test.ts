import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { msg } from 'i18n';

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
    systemPost(chat, 'secret', msg('annonce secrète'), 3);

    const insider = visibleTo(chat, 'b', new Set(['b']), rules);
    const outsider = visibleTo(chat, 'a', new Set(['b']), rules);
    assert.equal(insider.length, 3);
    assert.equal(outsider.length, 1);
    assert.equal(outsider[0]?.text, 'public');
  });

  it('keeps each channel bounded, newest kept', () => {
    const chat = createChat({ perChannel: 60 });
    for (let i = 0; i < 600; i++) {
      systemPost(chat, 'open', msg(`m${i}`), i);
    }
    assert.equal(chat.messages.length, 60);
    assert.equal(chat.messages[0]?.msg?.k, 'm540');
    assert.equal(chat.messages.at(-1)?.msg?.k, 'm599');
  });

  /**
   * The point of per-channel retention: one loud channel cannot delete another.
   * A whole family shouting in private used to evict the town's public record.
   */
  it('a flooded channel does not evict another channel', () => {
    const chat = createChat({ perChannel: 20 });
    systemPost(chat, 'day', msg('la nuit est tombée'), 0);
    for (let i = 0; i < 500; i++) {
      systemPost(chat, 'mafia', msg(`spam${i}`), i + 1);
    }
    const day = chat.messages.filter((message) => message.channel === 'day');
    assert.equal(day.length, 1);
    assert.equal(day[0]?.msg?.k, 'la nuit est tombée');
  });

  /**
   * And the split within a channel: chatter is meant to scroll away, a death
   * notice is not, so they are counted separately and never compete.
   */
  it('chatter does not evict the announcements in the same channel', () => {
    const chat = createChat({ perChannel: 5 });
    systemPost(chat, 'day', msg('Alice a été retrouvée morte'), 0);
    for (let i = 0; i < 50; i++) {
      post(chat, { channel: 'day', authorId: `u${i}`, authorName: 'U', text: `bla ${i}`, at: 1000 + i });
    }
    const announcements = chat.messages.filter((message) => message.kind === 'system');
    const spoken = chat.messages.filter((message) => message.kind !== 'system');
    assert.equal(announcements.length, 1);
    assert.equal(announcements[0]?.msg?.k, 'Alice a été retrouvée morte');
    assert.equal(spoken.length, 5);
  });

  it('a channel override outranks the default', () => {
    const chat = createChat({ perChannel: 3, channels: { day: 10 } });
    for (let i = 0; i < 40; i++) {
      systemPost(chat, 'day', msg(`d${i}`), i);
      systemPost(chat, 'whisper', msg(`w${i}`), i);
    }
    assert.equal(chat.messages.filter((message) => message.channel === 'day').length, 10);
    assert.equal(chat.messages.filter((message) => message.channel === 'whisper').length, 3);
  });

  it('the total is a backstop when a table opens many channels', () => {
    const chat = createChat({ perChannel: 50, total: 100 });
    for (let channel = 0; channel < 20; channel++) {
      for (let i = 0; i < 40; i++) systemPost(chat, `pm:${channel}`, msg(`m${i}`), channel * 100 + i);
    }
    assert.equal(chat.messages.length, 100);
  });
});
