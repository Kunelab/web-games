import { Link } from 'react-router';

import { api, type Playlist } from '../../api/client';
import { gameEntry } from '../../app/games';
import { kindColor, kindLabel } from '../../app/kinds';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Badge, Button, EmptyState, Loading } from '../../ui';
import './menu.css';

/**
 * Choosing what to play, before choosing how.
 *
 * The only way to open a quiz used to be to walk into your own playlist and press
 * a button inside it, which made someone else's public quiz effectively
 * unplayable — you could see it in the list and there was nothing to do with it.
 * Both shelves are here, side by side, and both lead to the same launch screen.
 */
export default function QuizCreate() {
  const entry = gameEntry('quiz');
  const { user } = useAuth();
  const playlists = useAsync(() => api.listPlaylists(), []);

  if (playlists.loading) return <Loading />;

  const all = playlists.data ?? [];
  const mine = all.filter((playlist) => playlist.user_id === user?.id);
  const published = all.filter((playlist) => playlist.user_id !== user?.id && playlist.public);

  return (
    <div className="menu" style={{ '--game-accent': entry.accent } as React.CSSProperties}>
      <header className="menu-head">
        <span className="menu-emoji" aria-hidden="true">
          🎬
        </span>
        <div>
          <h1 className="menu-title">Créer un salon</h1>
          <p className="menu-lede">
            Choisissez le quiz à jouer. L’écran suivant règle la partie — ordre, chrono, points — et décide si le salon
            est public ou privé.
          </p>
        </div>
      </header>

      <Shelf
        title="Mes quiz"
        empty="Vous n’avez pas encore de quiz. Un quiz est un groupe de questions."
        action={
          <Link to="/playlists">
            <Button variant="secondary">Créer un quiz</Button>
          </Link>
        }
        playlists={mine}
      />

      <Shelf
        title="Quiz publics"
        empty="Personne n’a encore publié de quiz."
        playlists={published}
      />

      <Link to={entry.path} className="menu-back">
        ← Retour au menu Quiz
      </Link>
    </div>
  );
}

function Shelf({
  title,
  empty,
  action,
  playlists
}: {
  title: string;
  empty: string;
  action?: React.ReactNode;
  playlists: Playlist[];
}) {
  return (
    <section className="guide-section">
      <h2>{title}</h2>

      {playlists.length === 0 ? (
        <EmptyState title={empty} action={action} />
      ) : (
        <div className="menu-grid">
          {playlists.map((playlist) => {
            const ready = playlist.items.length - playlist.notReadyCount;
            return (
              <Link
                key={playlist.id}
                to={`/playlists/${playlist.id}/lancer`}
                className={`menu-tile ${ready === 0 ? 'locked' : ''}`}
              >
                <strong>{playlist.name ?? 'Sans titre'}</strong>
                <span className="menu-tile-hint">
                  {ready} question{ready === 1 ? '' : 's'} jouable{ready === 1 ? '' : 's'}
                  {playlist.owner?.login && playlist.public && ` · par ${playlist.owner.login}`}
                </span>
                <span className="qp-choices">
                  {Object.entries(playlist.kindCounts).map(([kind, count]) => (
                    <span key={kind} className="guide-stats" style={{ color: kindColor(kind) }}>
                      {kindLabel(kind)} × {count}
                    </span>
                  ))}
                </span>
                {playlist.public && <Badge tone="ok">Public</Badge>}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
