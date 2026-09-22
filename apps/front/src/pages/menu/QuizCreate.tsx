import { msg } from 'i18n';
import { Link } from 'react-router';

import { api, type Playlist } from '../../api/client';
import { gameEntry } from '../../app/games';
import { kindColor, kindKey } from '../../app/kinds';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { useT } from '../../i18n/locale-context';
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
  const t = useT();
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
          <h1 className="menu-title">{t(msg('quiz.create.title'))}</h1>
          <p className="menu-lede">{t(msg('quiz.create.lede'))}</p>
        </div>
      </header>

      {/*
        The one thing on this page that is not somebody's playlist.

        It belongs here rather than behind its own door in the menu, because the
        question this page asks is "what are we playing tonight", and a generated
        blind test is one of the answers to it. Keeping it elsewhere meant a host
        who wanted one left the room-opening flow entirely and arrived at a screen
        that could not make the room public, name it or lock it — everything past
        this tile is the same launch screen a playlist gets.
      */}
      <section className="guide-section">
        <h2>{t(msg('quiz.create.generated'))}</h2>
        <div className="menu-grid">
          <Link to="/quiz/infini" className="menu-tile">
            <strong>♾️ {t(msg('launch.blindtest'))}</strong>
            <span className="menu-tile-hint">{t(msg('quiz.create.generatedHint'))}</span>
          </Link>
        </div>
      </section>

      <Shelf
        title={t(msg('quiz.create.mine'))}
        empty={t(msg('quiz.create.mineEmpty'))}
        action={
          <Link to="/playlists">
            <Button variant="secondary">{t(msg('quiz.create.makeOne'))}</Button>
          </Link>
        }
        playlists={mine}
      />

      <Shelf title={t(msg('quiz.create.public'))} empty={t(msg('quiz.create.publicEmpty'))} playlists={published} />

      <Link to={entry.path} className="menu-back">
        {t(msg('quiz.guide.back'))}
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
  const t = useT();
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
                <strong>{playlist.name ?? t(msg('quiz.create.untitled'))}</strong>
                <span className="menu-tile-hint">
                  {t(msg('quiz.create.playable', { count: ready }))}
                  {playlist.owner?.login &&
                    playlist.public &&
                    ` ${t(msg('quiz.create.by', { login: playlist.owner.login }))}`}
                </span>
                <span className="qp-choices">
                  {Object.entries(playlist.kindCounts).map(([kind, count]) => (
                    <span key={kind} className="guide-stats" style={{ color: kindColor(kind) }}>
                      {t(msg(kindKey(kind)))} × {count}
                    </span>
                  ))}
                </span>
                {playlist.public && <Badge tone="ok">{t(msg('quiz.create.publicBadge'))}</Badge>}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
