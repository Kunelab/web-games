import { msg } from 'i18n';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, type Playlist } from '../api/client';
import { kindColor, kindKey } from '../app/kinds';
import { useAsync } from '../hooks/useAsync';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/locale-context';
import { Badge, Button, CopyIcon, Dialog, EmptyState, Field, IconButton, Input, Loading, Tag } from '../ui';
import './playlists.css';

export default function Playlists() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const playlists = useAsync(() => api.listPlaylists(), []);
  /**
   * Games this account is hosting right now. The host token normally lives in
   * sessionStorage, so a television that lost its tab, or a different device
   * entirely, had no way back into a running game. The server reissues the token
   * to its owner here, and "Reprendre" plants it where the host screen looks.
   */
  const liveSessions = useAsync(() => api.mySessions(), []);

  function resume(session: { code: string; hostToken: string }) {
    sessionStorage.setItem(`kune.host.${session.code}`, session.hostToken);
    void navigate(`/partie/${session.code}`);
  }

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Playlist | null>(null);
  /** The playlist being copied, so only its own button shows the pending state. */
  const [duplicating, setDuplicating] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    try {
      const created = await api.createPlaylist({ name: newName.trim() || t(msg('pl.defaultName')) });
      setCreating(false);
      setNewName('');
      void navigate(`/playlists/${created.id}`);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    await api.deletePlaylist(pendingDelete.id);
    setPendingDelete(null);
    playlists.reload();
  }

  /**
   * Copies a playlist and opens it.
   *
   * Copying a public playlist of someone else's keeps the arrangement but not the
   * items, because the media belongs to its author. Saying so is better than
   * handing over an empty playlist and letting them work out why.
   */
  async function duplicate(playlist: Playlist) {
    setDuplicating(playlist.id);
    setNotice(null);
    try {
      const copy = await api.duplicatePlaylist(playlist.id);

      if (copy.dropped > 0) {
        // Staying put: navigating away would replace the explanation with an
        // apparently empty playlist, which is the confusing half of what happened.
        setNotice(t(msg('pl.copiedPartly', { name: copy.name ?? '', count: copy.dropped })));
        playlists.reload();
        return;
      }

      void navigate(`/playlists/${copy.id}`);
    } finally {
      setDuplicating(null);
    }
  }

  const mine = (playlists.data ?? []).filter((playlist) => playlist.user_id === user?.id);
  const shared = (playlists.data ?? []).filter((playlist) => playlist.user_id !== user?.id);

  return (
    <>
      <Link to="/" className="backlink">
        {t(msg('nav.backHome'))}
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{t(msg('pl.title'))}</h1>
          <p className="page-sub">{t(msg('pl.lede'))}</p>
        </div>
        <div className="page-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t(msg('pl.new'))}
          </Button>
        </div>
      </div>

      {playlists.loading && <Loading />}
      {playlists.error && <p className="field-error">{playlists.error}</p>}
      {notice && <p className="field-hint">{notice}</p>}

      {(liveSessions.data ?? []).length > 0 && (
        <div className="live-banner">
          {(liveSessions.data ?? []).map((session) => (
            <div className="live-banner-row" key={session.code}>
              <span>
                {t(msg('pl.live'))} <strong className="tabular">{session.code}</strong> · {session.playlistName}
                {session.phase === 'lobby' && t(msg('pl.liveWaiting'))}
              </span>
              <Button variant="secondary" size="sm" onClick={() => resume(session)}>
                {t(msg('pl.resume'))}
              </Button>
            </div>
          ))}
        </div>
      )}

      {!playlists.loading && mine.length === 0 && shared.length === 0 && (
        <EmptyState
          title={t(msg('pl.none'))}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t(msg('pl.createFirst'))}
            </Button>
          }
        >
          <p>{t(msg('pl.whatIsPlaylist'))}</p>
        </EmptyState>
      )}

      {mine.length > 0 && (
        <PlaylistGrid
          playlists={mine}
          duplicating={duplicating}
          onDuplicate={(playlist) => void duplicate(playlist)}
          onDelete={setPendingDelete}
        />
      )}

      {shared.length > 0 && (
        <>
          <h2 className="section-title">{t(msg('pl.publicOnes'))}</h2>
          {/* Copyable but not deletable: someone else's playlist is a starting
              point you can take, not one you can remove. */}
          <PlaylistGrid
            playlists={shared}
            duplicating={duplicating}
            onDuplicate={(playlist) => void duplicate(playlist)}
          />
        </>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={t(msg('pl.newDialog'))}
        actions={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t(msg('pl.cancel'))}
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void create()}>
              {t(msg('pl.create'))}
            </Button>
          </>
        }
      >
        <Field label={t(msg('pl.name'))}>
          {({ id }) => (
            <Input
              id={id}
              value={newName}
              placeholder={t(msg('pl.namePlaceholder'))}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void create();
                }
              }}
            />
          )}
        </Field>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t(msg('pl.deleteTitle'))}
        description={t(msg('pl.deleteDesc', { name: pendingDelete?.name ?? '' }))}
        actions={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t(msg('pl.cancel'))}
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              {t(msg('pl.delete'))}
            </Button>
          </>
        }
      />
    </>
  );
}

function PlaylistGrid({
  playlists,
  duplicating,
  onDuplicate,
  onDelete
}: {
  playlists: Playlist[];
  duplicating: number | null;
  onDuplicate: (playlist: Playlist) => void;
  onDelete?: (playlist: Playlist) => void;
}) {
  const t = useT();
  return (
    <ul className="playlist-grid">
      {playlists.map((playlist) => {
        const playable = playlist.items.length - playlist.notReadyCount;

        return (
          <li className="playlist-card" key={playlist.id}>
            <div className="playlist-card-head">
              <Link to={`/playlists/${playlist.id}`} className="playlist-name">
                {playlist.name ?? t(msg('pl.untitled'))}
              </Link>
              <span className="playlist-card-actions">
                <IconButton
                  icon={<CopyIcon />}
                  label={t(msg('pl.duplicate', { name: playlist.name ?? '' }))}
                  disabled={duplicating !== null}
                  onClick={() => onDuplicate(playlist)}
                />
                {onDelete && (
                  <IconButton
                    icon={<TrashIcon />}
                    label={t(msg('pl.deleteOne', { name: playlist.name ?? '' }))}
                    onClick={() => onDelete(playlist)}
                  />
                )}
              </span>
            </div>

            <p className="playlist-meta">
              {playlist.items.length === 0
                ? t(msg('pl.emptyMeta'))
                : t(msg('pl.mediaCount', { count: playlist.items.length }))}
              {playlist.owner && ` · ${playlist.owner.login ?? ''}`}
              {playlist.public && t(msg('pl.publicMeta'))}
            </p>

            {Object.keys(playlist.kindCounts).length > 0 && (
              <div className="playlist-kinds">
                {Object.entries(playlist.kindCounts).map(([kind, count]) => (
                  <Tag key={kind} dotColor={kindColor(kind)}>
                    {t(msg(kindKey(kind)))} {count}
                  </Tag>
                ))}
              </div>
            )}

            <div className="playlist-card-foot">
              {playlist.notReadyCount > 0 ? (
                <Badge tone="warn">{t(msg('pl.toFinish', { count: playlist.notReadyCount }))}</Badge>
              ) : playlist.items.length > 0 ? (
                <Badge tone="ok">{t(msg('pl.ready'))}</Badge>
              ) : (
                <span />
              )}

              <Link to={`/playlists/${playlist.id}/lancer`}>
                <Button variant="primary" size="sm" disabled={playable === 0}>
                  {t(msg('pl.launch'))}
                </Button>
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
