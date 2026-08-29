import { isLobbyGame, quickJoinPath, type LobbyCard, type LobbyGame } from 'lobby-core';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { api, ApiError } from '../api/client';
import { GAMES, gameEntry } from '../app/games';
import { useAsync } from '../hooks/useAsync';
import { Button, Chip, Field, Input, Loading } from '../ui';
import './play.css';

/**
 * The way in, for anyone who was not handed a link.
 *
 * It used to be a code box and nothing else, which quietly assumed that every
 * game began with somebody in the room reading five letters aloud. That is still
 * how most evenings start, so the box is first — but a public lobby is a game
 * looking for players, and it now has somewhere to be found.
 *
 * Both halves are anonymous. Players have no accounts, and a board you must sign
 * in to read is a board nobody arrives at.
 */
export default function Join() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();

  const filterParam = search.get('jeu');
  const filter: LobbyGame | null = filterParam && isLobbyGame(filterParam) ? filterParam : null;

  const board = useAsync(() => api.lobbies(filter ?? undefined), [filter]);

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * A code names a game without saying which game it belongs to.
   *
   * Codes share one namespace across all three engines precisely so a player can
   * type one without knowing, so this asks each summary endpoint in turn and
   * sends them wherever it lands. Four hundred and four everywhere means the code
   * is wrong, which is the one answer worth reporting.
   */
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalised = code.trim().toUpperCase();

    setBusy(true);
    setError(null);

    const probes: { game: LobbyGame; ask: () => Promise<unknown> }[] = [
      { game: 'quiz', ask: () => api.sessionSummary(normalised) },
      { game: 'coronaz', ask: () => api.czSummary(normalised) },
      { game: 'mafia', ask: () => api.mafiaSummary(normalised) }
    ];

    for (const probe of probes) {
      try {
        await probe.ask();
        void navigate(quickJoinPath(probe.game, normalised));
        return;
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 404) {
          setError('Vérification impossible.');
          setBusy(false);
          return;
        }
      }
    }

    setError('Aucune partie avec ce code.');
    setBusy(false);
  }

  const cards = board.data ?? [];

  return (
    <div className="jeu-screen join-page">
      <form className="join-form" onSubmit={(event) => void submit(event)}>
        <h1 className="join-title">Rejoindre une partie</h1>

        <Field label="Code de la partie" error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className="code-input"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABC12"
              maxLength={5}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              autoFocus
            />
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={code.trim().length !== 5}>
          Continuer
        </Button>
      </form>

      <section className="join-board">
        <div className="join-board-head">
          <h2>Salons ouverts</h2>
          <div className="filters">
            <Chip active={filter === null} onClick={() => setSearch({})}>
              Tous
            </Chip>
            {GAMES.map((game) => (
              <Chip
                key={game.id}
                active={filter === game.id}
                dotColor={game.accent}
                onClick={() => setSearch({ jeu: game.id })}
              >
                {game.name}
              </Chip>
            ))}
          </div>
        </div>

        {board.loading ? (
          <Loading />
        ) : cards.length === 0 ? (
          <p className="play-note">
            Aucun salon public pour l’instant. Lancez-en un depuis le menu d’un jeu, ou démarrez une partie rapide.
          </p>
        ) : (
          <ul className="join-cards">
            {cards.map((card) => (
              <LobbyRow key={`${card.game}-${card.code}`} card={card} />
            ))}
          </ul>
        )}

        <Button variant="ghost" onClick={() => board.reload()}>
          Rafraîchir
        </Button>
      </section>
    </div>
  );
}

function LobbyRow({ card }: { card: LobbyCard }) {
  const navigate = useNavigate();
  const entry = gameEntry(card.game);

  /**
   * A quick room is entered through the quick lobby, not through the game: it has
   * no game yet. Everything else already exists and takes you straight to a seat.
   */
  const target = card.quick ? `/partie-rapide/${card.game}?salon=${card.code}` : quickJoinPath(card.game, card.code);

  return (
    <li className="join-card" style={{ borderLeftColor: entry.accent }}>
      <span className="join-card-emoji" aria-hidden="true">
        {entry.emoji}
      </span>

      <div className="join-card-body">
        <strong>{card.title}</strong>
        <span className="join-card-meta">
          {entry.name}
          {card.quick ? ' · partie rapide' : card.host ? ` · chez ${card.host}` : ''}
          {card.detail ? ` · ${card.detail}` : ''}
        </span>
      </div>

      <span className="join-card-count">
        {card.players}
        {card.maxPlayers !== null && `/${card.maxPlayers}`}
      </span>

      <Button variant="primary" size="sm" onClick={() => void navigate(target)}>
        Rejoindre
      </Button>
    </li>
  );
}
