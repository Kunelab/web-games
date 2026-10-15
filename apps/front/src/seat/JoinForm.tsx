import { msg, type Msg } from 'i18n';
import type { FormEvent, ReactNode } from 'react';

import { useT } from '../i18n/locale-context';
import { NICKNAME_MAX } from '../tools/nickname';
import { Button, Field, Input } from '../ui';
import type { SeatStatus } from './seat';
import type { JoinDraft } from './useJoinDraft';

interface JoinFormProps {
  /** What has been typed so far. See `useJoinDraft`. */
  draft: JoinDraft;
  /** Where the seat stands. The door and the busy button are both read off it. */
  status: SeatStatus;
  /** The seat's last complaint: a refusal, a wrong word, a server gone quiet. */
  error: Msg | null;
  /** Asks for the seat. The page's, so a game can do something with the answer. */
  join: (name: string, password: string) => Promise<unknown>;
  /** What the name box is called: inside the box on `play`, above it on `mafia`. */
  nameLabel: string;
  submitLabel: string;
  /** The longest name this game's server takes. */
  nameMax?: number;
  /**
   * Which stylesheet the form is dressed for.
   *
   * `play` is the quiz's and the raid's (`play.css`): the boxes say what they
   * are inside them, and the button spins while a join is out. `mafia` is the
   * table's (`mafia.css`): labelled boxes, a line explaining the word, the
   * complaint under the button, and the button saying what it is doing through
   * the `submitLabel` it is handed.
   */
  look?: 'play' | 'mafia';
  /** What heads the form, inside it. */
  children?: ReactNode;
}

/**
 * The form a phone fills in to take a seat, in all three games.
 *
 * A remembered seat is presented by the seat itself (see `createSeat`), so this
 * is what a phone sees until it holds one: a name, the word at the door when
 * there is one, the seat's last complaint, and a button that knows a join is
 * out. The quiz and the raid each had the same copy of it and Mafia a third in
 * its own dress; the pages now say only what their boxes and button are called.
 */
export function JoinForm({
  draft,
  status,
  error,
  join,
  nameLabel,
  submitLabel,
  nameMax = NICKNAME_MAX,
  look = 'play',
  children
}: JoinFormProps) {
  const t = useT();
  const { name, setName, password, setPassword } = draft;
  const locked = status === 'locked';
  const joining = status === 'joining';
  const asked = t(msg('room.asked'));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void join(name, password);
  }

  /*
   * In both dresses the name box takes the focus until the room asks for a word,
   * and the word's box takes it from then on. The name is already filled from
   * last time; the word is the box the thumb wants.
   */

  if (look === 'mafia') {
    return (
      <form onSubmit={submit} className="mz-join-form">
        {children}
        <Field label={nameLabel}>
          {({ id }) => (
            <Input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={nameMax}
              autoFocus={!locked}
            />
          )}
        </Field>
        {locked && (
          <Field label={asked} hint={t(msg('room.asked.hint'))}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                maxLength={40}
                autoComplete="off"
                autoFocus
              />
            )}
          </Field>
        )}
        <Button type="submit" disabled={joining || !name.trim()}>
          {submitLabel}
        </Button>
        {error && <p className="mz-error">{t(error)}</p>}
      </form>
    );
  }

  return (
    <form className="join-form" onSubmit={submit}>
      {children}
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={nameLabel}
        maxLength={nameMax}
        aria-label={nameLabel}
        autoFocus={!locked}
      />
      {locked && (
        <Input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={asked}
          maxLength={40}
          aria-label={asked}
          autoComplete="off"
          autoFocus
        />
      )}
      {error && <p className="play-error">{t(error)}</p>}
      <Button type="submit" variant="primary" size="lg" block busy={joining} disabled={!name.trim()}>
        {submitLabel}
      </Button>
    </form>
  );
}
