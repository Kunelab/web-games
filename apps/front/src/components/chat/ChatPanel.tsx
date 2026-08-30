import type { ChatMessage } from 'chat-core';
import { msg } from 'i18n';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { authorColour } from '../../ui/authorHue';
import { cx } from '../../ui/cx';
import { useT } from '../../i18n/locale-context';
import './chat.css';

/**
 * The generic chat surface: channel tabs, a scrolling log, one input. It knows
 * nothing about any game — channels, permissions and message filtering all
 * happened server-side; this only renders what it was given and emits sends.
 *
 * Theming is CSS variables (`--chat-*`, see chat.css), so Mafia can dress it
 * in lamplight and CoronaZ in biohazard green without touching this file.
 */

export interface ChatChannelTab {
  id: string;
  label: string;
  canWrite: boolean;
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  channels: ChatChannelTab[];
  onSend: (channel: string, text: string) => void;
  /** Grays the input regardless of channel permissions (e.g. dead, spectator). */
  disabled?: boolean;
  placeholder?: string;
  /** Extra class on the root, for a game that wants its own shell (see mafia.css). */
  className?: string;
  /**
   * A short tag rendered in front of an author's name.
   *
   * Mafia's house number, in practice — and the reason it is a callback rather
   * than something baked into `ChatMessage`: chat-core has no idea what a house
   * is, and CoronaZ's survivors have nothing to put here. The panel stays a
   * panel; the game decides what the label in front of a name means.
   */
  authorTag?: (authorName: string) => string | null;
  /**
   * Tabs that are not channels.
   *
   * Mafia's accusation trail, in practice: a record that belongs beside the
   * conversation and reads like it, but that must not live *in* it — the chat is
   * a fixed-size ring, and an afternoon of twenty-four players changing their
   * minds would push the morning's death announcements out of it. So it gets a
   * tab of its own with its own budget, rendered by whoever owns the data.
   *
   * Read-only by construction: there is no channel behind them to post to, so
   * the composer hides while one is open.
   */
  extraTabs?: { id: string; label: string; render: () => ReactNode }[];
}

export function ChatPanel({
  messages,
  channels,
  onSend,
  disabled = false,
  placeholder,
  className,
  authorTag,
  extraTabs = []
}: ChatPanelProps) {
  const t = useT();
  const [active, setActive] = useState(channels[0]?.id ?? 'day');
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // A channel that disappears (jail closing, day ending) falls back to the
  // first tab — derived, not synced: `active` may point at a gone channel and
  // the render simply ignores it.
  const extra = extraTabs.find((tab) => tab.id === active) ?? null;
  const activeChannel = extra ? null : (channels.find((channel) => channel.id === active) ?? channels[0]);
  const visible = messages.filter((message) => message.channel === (activeChannel?.id ?? 'day'));

  useEffect(() => {
    const log = logRef.current;
    if (log && stickToBottom.current) {
      log.scrollTop = log.scrollHeight;
    }
  }, [visible.length, active]);

  function onScroll() {
    const log = logRef.current;
    if (!log) return;
    stickToBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeChannel) return;
    onSend(activeChannel.id, text);
    setDraft('');
  }

  const canWrite = !disabled && !!activeChannel?.canWrite;

  return (
    <section className={cx('chat-panel', className)}>
      {channels.length + extraTabs.length > 1 && (
        <div className="chat-tabs" role="tablist">
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              role="tab"
              aria-selected={channel.id === activeChannel?.id}
              className={channel.id === activeChannel?.id ? 'chat-tab chat-tab--active' : 'chat-tab'}
              onClick={() => setActive(channel.id)}
            >
              {channel.label}
            </button>
          ))}
          {extraTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === extra?.id}
              className={tab.id === extra?.id ? 'chat-tab chat-tab--active' : 'chat-tab'}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {extra ? (
        <div className="chat-log chat-log--extra">{extra.render()}</div>
      ) : (
      <div className="chat-log" ref={logRef} onScroll={onScroll}>
        {visible.map((message) =>
          message.kind === 'system' ? (
            <p key={message.id} className="chat-line chat-line--system">
              {/* The game's own voice arrives as a key; the reader's language
                  decides the words. A player's own text never does. */}
              {message.msg ? t(message.msg) : message.text}
            </p>
          ) : (
            <p key={message.id} className="chat-line">
              {/* The number first, because that is how the table addresses each
                  other: "16, where were you?" is only readable if 16 is written
                  on the line the answer comes back on. */}
              {authorTag?.(message.authorName) && <span className="chat-slot">{authorTag(message.authorName)}</span>}
              <span className="chat-author" style={{ color: authorColour(message.authorName) }}>
                {message.authorName}
              </span>
              <span className="chat-text">{message.text}</span>
            </p>
          )
        )}
        {visible.length === 0 && <p className="chat-line chat-line--system">{t(msg('chat.empty'))}</p>}
      </div>
      )}

      {!extra && (
      <form className="chat-compose" onSubmit={submit}>
        <input
          className="chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={400}
          placeholder={canWrite ? (placeholder ?? t(msg('chat.placeholder'))) : t(msg('chat.muted'))}
          disabled={!canWrite}
        />
        <button className="chat-send" type="submit" disabled={!canWrite || !draft.trim()}>
          {t(msg('chat.send'))}
        </button>
      </form>
      )}
    </section>
  );
}
