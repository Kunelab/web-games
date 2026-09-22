import { msg } from 'i18n';

import { useT } from '../i18n/locale-context';
import { Field, Input } from './index';

/**
 * What a room is called, and what it asks at the door.
 *
 * The companion of [PublicSwitch](./PublicSwitch.tsx), and it exists for the same
 * reason: these two questions are asked in all three setup screens and the
 * *wording* of them is the feature. A name only matters once a room is on the
 * board, where every quiz is called after its playlist and every table after its
 * role list, so three open rooms look like one room listed three times. And a
 * password is what makes the board safe to use at all — listing a room is how the
 * people you invited find it, and the password is what stops everybody else who
 * reads the same list from sitting down.
 *
 * Both are optional and both default to empty, which is exactly how every room
 * worked before this existed.
 */
export function RoomDoor({
  name,
  password,
  onName,
  onPassword,
  /** What the board will call this room when it is left unnamed, in the reader's words. */
  fallback
}: {
  name: string;
  password: string;
  onName: (next: string) => void;
  onPassword: (next: string) => void;
  fallback: string;
}) {
  const t = useT();

  return (
    <>
      <Field label={t(msg('room.name'))} hint={t(msg('room.name.hint', { fallback }))}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={name}
            maxLength={40}
            placeholder={fallback}
            onChange={(event) => onName(event.target.value)}
          />
        )}
      </Field>

      <Field label={t(msg('room.password'))} hint={t(msg('room.password.hint'))}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            /**
             * Deliberately not a `type="password"`.
             *
             * This one is set by somebody who then has to read it out to a room,
             * or paste it into the same message as the join code. It is not a
             * secret being kept from whoever is at the keyboard — they are the
             * person choosing it — and dots would only hide their own typo.
             */
            value={password}
            maxLength={40}
            autoComplete="off"
            onChange={(event) => onPassword(event.target.value)}
          />
        )}
      </Field>
    </>
  );
}
