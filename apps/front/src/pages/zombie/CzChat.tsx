import type { ChatMessage } from 'chat-core';
import { useEffect, useRef, useState } from 'react';

/**
 * The survivors' channel, as a drawer rather than a column.
 *
 * The raid screen never scrolls — the map owns the middle and the hands own the
 * bottom — so a permanent chat would have to take that space from one of them.
 * It opens over the board instead, and announces itself with a dot when
 * something was said while it was shut.
 *
 * Read-only on the television, which is a screen nobody types on.
 */
export default function CzChat({
  messages,
  me,
  onSend
}: {
  messages: ChatMessage[];
  /** Your own player id, so your lines read as yours. */
  me?: string;
  /** Absent on the television: it shows the thread and cannot add to it. */
  onSend?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [seen, setSeen] = useState(0);
  const feed = useRef<HTMLDivElement | null>(null);

  const latest = messages.at(-1)?.id ?? 0;

  /**
   * Nothing is unread while you are looking at it, and the marker moves on the
   * way in *and* the way out — both are things you did, so both are handled in
   * the handler. Reconciling it from an effect instead would be a render caused
   * by a render, and would count a line as unread for one frame after arriving
   * in an open panel.
   */
  const unread = open ? 0 : messages.filter((message) => message.id > seen && message.authorId !== me).length;

  function toggle() {
    setSeen(latest);
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (open) feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [open, latest]);

  function send() {
    const text = draft.trim();
    if (!text || !onSend) return;
    onSend(text);
    setDraft('');
  }

  return (
    <>
      <button
        type="button"
        className={`cz-chat-toggle ${open ? 'on' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label={unread > 0 ? `Discussion, ${unread} non lus` : 'Discussion'}
      >
        💬
        {!open && unread > 0 && <span className="cz-chat-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="cz-chat">
          <div className="cz-chat-feed" ref={feed}>
            {messages.length === 0 ? (
              <p className="cz-chat-empty">Personne n’a encore rien dit.</p>
            ) : (
              messages.map((message) => (
                <p key={message.id} className={`cz-chat-line ${message.authorId === me ? 'mine' : ''}`}>
                  <strong>{message.authorName}</strong> {message.text}
                </p>
              ))
            )}
          </div>

          {onSend && (
            <form
              className="cz-chat-compose"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Dire quelque chose…"
                maxLength={400}
                aria-label="Message"
              />
              <button type="submit" disabled={!draft.trim()}>
                Envoyer
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
