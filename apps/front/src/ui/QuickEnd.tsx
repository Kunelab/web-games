import { msg } from 'i18n';
import type { LobbyGame } from 'lobby-core';
import { useNavigate } from 'react-router';

import { gameEntry } from '../app/games';
import { useT } from '../i18n/locale-context';
import { Button } from './index';

/**
 * "Encore" or "assez", under the final standings.
 *
 * Only a quick match offers the first one, and only it can: an organised game
 * belongs to whoever opened it, and there is nobody for a stranger's rematch to
 * belong to. Quick rooms have no owner, so pressing this puts you in the
 * successor room of the game that just ended — the same room everyone else who
 * pressed it lands in, which is what makes it a rematch rather than three people
 * each starting a lonely lobby.
 *
 * How the screen knows: the quick lobby wrote the game's code into session
 * storage on its way out. No mark, no rematch — which is exactly right for a game
 * that was never a quick match to begin with.
 */

function quickOrigin(gameCode: string): LobbyGame | null {
  try {
    const value = sessionStorage.getItem(`kune.quick.${gameCode}`);
    return value === 'quiz' || value === 'coronaz' || value === 'mafia' ? value : null;
  } catch {
    return null;
  }
}

export interface QuickEndProps {
  /** The finished game's join code. */
  code: string;
  /** Where "retour" goes when this was not a quick match. */
  fallbackGame: LobbyGame;
}

export function QuickEnd({ code, fallbackGame }: QuickEndProps) {
  const navigate = useNavigate();
  const t = useT();
  const origin = quickOrigin(code);
  const entry = gameEntry(origin ?? fallbackGame);

  return (
    <div className="quick-end">
      {origin && (
        <Button
          variant="primary"
          size="lg"
          onClick={() => void navigate(`/partie-rapide/${origin}?revanche=${code}`)}
        >
          {t(msg('quickEnd.again'))}
        </Button>
      )}

      <Button variant="secondary" size="lg" onClick={() => void navigate(entry.path)}>
        {t(msg('quickEnd.back', { game: entry.name }))}
      </Button>
    </div>
  );
}
