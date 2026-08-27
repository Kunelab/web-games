import type { ChatMessage } from 'chat-core';
import { useEffect, useRef, useState, type FormEvent } from 'react';

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
}

/** Stable hue per author so a name keeps its color for the whole game. */
function authorHue(authorId: string): number {
  let hash = 0;
  for (let i = 0; i < authorId.length; i++) hash = (hash * 31 + authorId.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export function ChatPanel({ messages, channels, onSend, disabled = false, placeholder }: ChatPanelProps) {
  const t = useT();
  const [active, setActive] = useState(channels[0]?.id ?? 'day');
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // A channel that disappears (jail closing, day ending) falls back to the
  // first tab — derived, not synced: `active` may point at a gone channel and
  // the render simply ignores it.
  const activeChannel = channels.find((channel) => channel.id === active) ?? channels[0];
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
    <section className="chat-panel">
      {channels.length > 1 && (
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
        </div>
      )}

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
              <span className="chat-author" style={{ color: `hsl(${authorHue(message.authorId ?? '')}, 65%, 55%)` }}>
                {message.authorName}
              </span>
              <span className="chat-text">{message.text}</span>
            </p>
          )
        )}
        {visible.length === 0 && <p className="chat-line chat-line--system">Personne n’a encore parlé ici.</p>}
      </div>

      <form className="chat-compose" onSubmit={submit}>
        <input
          className="chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={400}
          placeholder={canWrite ? (placeholder ?? 'Votre message…') : 'Vous ne pouvez pas parler ici'}
          disabled={!canWrite}
        />
        <button className="chat-send" type="submit" disabled={!canWrite || !draft.trim()}>
          Envoyer
        </button>
      </form>
    </section>
  );
}
