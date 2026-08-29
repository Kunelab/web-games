import { isLobbyGame, type LobbyGame } from 'lobby-core';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { gameEntry } from '../app/games';
import { useCountdown, useServerClock } from '../hooks/useServerClock';
import { rememberNickname, storedNickname, useQuickplay } from '../hooks/useQuickplay';
import { Button, Field, Input, Loading } from '../ui';
import './quickplay.css';

/**
 * The room with nobody in charge.
 *
 * One screen for all three games, because there is nothing game-specific left in
 * it: the server rolled the settings, named the options and priced the majority,
 * and what arrives here is a list of labelled choices and a count. That is the
 * whole reason the quick lobby is a shared object rather than a third copy of a
 * setup form.
 *
 * Three states, in order. A nickname, if this phone has never given one. Then the
 * room: who is here, what it will play, and how many more yeses it needs. Then
 * the redirect, when the game it started exists.
 */
export default function Quickplay() {
  const params = useParams<{ game: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const game: LobbyGame = params.game && isLobbyGame(params.game) ? params.game : 'quiz';
  const entry = gameEntry(game);

  const [name, setName] = useState(storedNickname);
  const [draft, setDraft] = useState(storedNickname);
  const { serverNow } = useServerClock();

  const room = search.get('salon') ?? undefined;
  const replayOf = search.get('revanche') ?? undefined;

  const { connected, lobby, launch, error, ready, vote, setBots } = useQuickplay({
    game,
    name,
    code: room,
    replayOf,
    enabled: name.trim().length > 0
  });

  const startsIn = useCountdown(lobby?.startsAt ?? null, serverNow);

  /**
   * Leaving for the game the room started.
   *
   * The lobby code is written down on the way out, keyed by the game's own code.
   * That is what lets the end screen offer "encore" — a finished game cannot
   * otherwise know it was ever a quick match.
   */
  useEffect(() => {
    if (!launch) return;
    try {
      sessionStorage.setItem(`kune.quick.${launch.code}`, launch.game);
    } catch {
      // Without it the end screen simply offers no rematch. Nothing breaks.
    }
    void navigate(launch.path, { replace: true });
  }, [launch, navigate]);

  if (!name.trim()) {
    return (
      <div className="jeu-screen jeu-center">
        <form
          className="join-form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draft.trim();
            if (!trimmed) return;
            rememberNickname(trimmed);
            setName(trimmed);
          }}
        >
          <h1 className="join-title">Partie rapide — {entry.name}</h1>
          <p className="qp-lede">{entry.tagline}</p>

          <Field label="Votre nom">
            {({ id }) => (
              <Input
                id={id}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={24}
                placeholder="Max"
                autoFocus
              />
            )}
          </Field>

          <Button type="submit" variant="primary" size="lg" block disabled={!draft.trim()}>
            Chercher une partie
          </Button>
        </form>
      </div>
    );
  }

  if (error && !lobby) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">{error}</p>
        <Button variant="secondary" onClick={() => void navigate(entry.path)}>
          Retour au menu {entry.name}
        </Button>
      </div>
    );
  }

  if (!lobby) {
    return <Loading label={connected ? 'Recherche d’un salon…' : 'Connexion…'} />;
  }

  const you = lobby.members.find((member) => member.id === lobby.you);
  const counting = lobby.phase === 'countdown';

  return (
    <div className="jeu-screen qp">
      <header className="qp-head">
        <div>
          <h1 className="qp-title">
            <span aria-hidden="true">{entry.emoji}</span> Partie rapide — {entry.name}
          </h1>
          <p className="qp-lede">
            {lobby.fromGameCode
              ? 'Revanche : les joueurs de la partie précédente arrivent, et la place est ouverte à d’autres.'
              : 'Personne n’organise. Les réglages sont tirés au sort, la table les change en votant.'}
          </p>
        </div>
        <span className="qp-code" title="Le code de ce salon">
          {lobby.code}
        </span>
      </header>

      <section className="qp-panel">
        <h2 className="qp-panel-title">
          Joueurs{' '}
          <span className="qp-count">
            {lobby.members.length + lobby.bots}/{lobby.maxPlayers}
          </span>
        </h2>
        <ul className="qp-members">
          {lobby.members.map((member) => (
            <li key={member.id} className={`qp-member ${member.ready ? 'on' : ''}`}>
              <span className="qp-member-dot" aria-hidden="true">
                {member.ready ? '✅' : member.connected ? '⏳' : '💤'}
              </span>
              <span className="qp-member-name">
                {member.name}
                {member.id === lobby.you && <em> — vous</em>}
              </span>
            </li>
          ))}
        </ul>

        {lobby.botsAllowed && (
          <div className="qp-bots">
            <div className="qp-bots-head">
              <strong>Bots</strong>
              <span className="qp-count">{lobby.bots}</span>
            </div>

            {lobby.bots > 0 && (
              <ul className="qp-members qp-members-bots">
                {Array.from({ length: lobby.bots }, (unused, index) => (
                  <li key={index} className="qp-member qp-member-bot">
                    <span className="qp-member-dot" aria-hidden="true">
                      🤖
                    </span>
                    <span className="qp-member-name">Bot {index + 1}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="qp-bots-controls">
              <button
                type="button"
                className="qp-bot-step"
                onClick={() => setBots(lobby.bots - 1)}
                disabled={!connected || lobby.bots === 0}
                aria-label="Un bot de moins"
              >
                −
              </button>
              <button
                type="button"
                className="qp-bot-step"
                onClick={() => setBots(lobby.bots + 1)}
                disabled={!connected || lobby.bots >= lobby.maxBots}
                aria-label="Un bot de plus"
              >
                +
              </button>
              {lobby.members.length + lobby.bots < lobby.minPlayers && (
                <button
                  type="button"
                  className="qp-bot-fill"
                  onClick={() => setBots(lobby.minPlayers - lobby.members.length)}
                  disabled={!connected}
                >
                  Compléter la table
                </button>
              )}
            </div>

            <p className="qp-hint">
              Ils prennent leur place au lancement, et rendent leur siège dès qu’une personne arrive.
            </p>
          </div>
        )}

        {lobby.members.length + lobby.bots < lobby.minPlayers && (
          <p className="qp-hint">
            Il faut au moins {lobby.minPlayers} joueur{lobby.minPlayers > 1 ? 's' : ''} pour lancer
            {lobby.botsAllowed ? ', bots compris' : ''}. En attente…
          </p>
        )}
      </section>

      <section className="qp-panel">
        <h2 className="qp-panel-title">Réglages</h2>
        <p className="qp-hint">
          Chacun vote, le choix majoritaire l’emporte. En cas d’égalité, le tirage au sort du départ est conservé.
        </p>

        {lobby.options.map((option) => (
          <div className="qp-option" key={option.key}>
            <div className="qp-option-head">
              <strong>{option.label}</strong>
              <span className="qp-option-value">{labelOf(option.choices, option.value)}</span>
            </div>
            {option.hint && <p className="qp-hint">{option.hint}</p>}

            {option.choices.length === 0 ? (
              <p className="qp-hint">Rien de publié pour l’instant.</p>
            ) : (
              <div className="qp-choices">
                {option.choices.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    className={`qp-choice ${option.yours === choice.value ? 'mine' : ''} ${
                      option.value === choice.value ? 'winning' : ''
                    }`}
                    onClick={() => vote(option.key, choice.value)}
                  >
                    <span>{choice.label}</span>
                    {choice.votes > 0 && <span className="qp-votes">{choice.votes}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>

      <footer className="qp-start">
        <div className="qp-tally">
          <strong>
            {lobby.ready} / {lobby.needed}
          </strong>
          <span>
            {' '}
            prêt{lobby.ready > 1 ? 's' : ''} — il en faut {lobby.needed}
          </span>
        </div>

        {counting ? (
          <p className="qp-countdown" role="status">
            Départ dans {startsIn} s
          </p>
        ) : null}

        <Button
          variant={you?.ready ? 'secondary' : 'primary'}
          size="lg"
          onClick={() => ready(!you?.ready)}
          disabled={!connected}
        >
          {you?.ready ? 'Retirer mon vote' : 'Je suis prêt'}
        </Button>

        <Button variant="ghost" onClick={() => void navigate(entry.path)}>
          Quitter
        </Button>
      </footer>
    </div>
  );
}

function labelOf(choices: { value: string; label: string }[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? '—';
}
