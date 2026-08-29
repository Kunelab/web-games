import { Switch } from './index';

/**
 * Private or listed, asked the same way in all three setup screens.
 *
 * One component rather than three switches because the *wording* is the feature:
 * "public" is an invitation to strangers, and a host has to understand that
 * before they flip it, not after somebody they have never met is sitting at the
 * table. Off by default everywhere, which is also how every game worked before
 * the board existed.
 */
export function PublicSwitch({
  value,
  onChange,
  what
}: {
  value: boolean;
  /** What is being opened, in French, lowercase: "cette partie", "ce raid". */
  what: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <Switch
      label="Salon public"
      hint={
        value
          ? `${what.charAt(0).toUpperCase()}${what.slice(1)} apparaît dans la liste des salons ouverts : n’importe qui peut arriver.`
          : `Seules les personnes à qui vous donnez le code peuvent rejoindre ${what}.`
      }
      checked={value}
      onCheckedChange={onChange}
    />
  );
}
