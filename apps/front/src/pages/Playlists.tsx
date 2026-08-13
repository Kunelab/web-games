import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, type Playlist } from '../api/client';
import { kindColor, kindLabel } from '../app/kinds';
import { useAsync } from '../hooks/useAsync';
import { useAuth } from '../hooks/useAuth';
import { Badge, Button, CopyIcon, Dialog, EmptyState, Field, IconButton, Input, Loading, Tag } from '../ui';
import './playlists.css';

export default function Playlists() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const playlists = useAsync(() => api.listPlaylists(), []);

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
      const created = await api.createPlaylist({ name: newName.trim() || 'Nouvelle playlist' });
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
        setNotice(
          `« ${copy.name ?? ''} » a été copiée, mais ${copy.dropped} média${copy.dropped === 1 ? '' : 's'} ` +
            `appartiennent à leur auteur et n’ont pas pu être repris.`
        );
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
      <div className="page-head">
        <div>
          <h1 className="page-title">Playlists</h1>
          <p className="page-sub">Une playlist devient une partie. Les joueurs rejoignent avec un code.</p>
        </div>
        <div className="page-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            Nouvelle playlist
          </Button>
        </div>
      </div>

      {playlists.loading && <Loading />}
      {playlists.error && <p className="field-error">{playlists.error}</p>}
      {notice && <p className="field-hint">{notice}</p>}

      {!playlists.loading && mine.length === 0 && shared.length === 0 && (
        <EmptyState
          title="Aucune playlist"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Créer la première
            </Button>
          }
        >
          <p>Une playlist rassemble des médias dans l’ordre où ils seront joués.</p>
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
          <h2 className="section-title">Playlists publiques</h2>
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
        title="Nouvelle playlist"
        actions={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Annuler
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void create()}>
              Créer
            </Button>
          </>
        }
      >
        <Field label="Nom">
          {({ id }) => (
            <Input
              id={id}
              value={newName}
              placeholder="Soirée du samedi"
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
        title="Supprimer cette playlist ?"
        description={`${pendingDelete?.name ?? ''} — les médias qu’elle contient ne sont pas supprimés.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Annuler
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              Supprimer
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
  return (
    <ul className="playlist-grid">
      {playlists.map((playlist) => {
        const playable = playlist.items.length - playlist.notReadyCount;

        return (
          <li className="playlist-card" key={playlist.id}>
            <div className="playlist-card-head">
              <Link to={`/playlists/${playlist.id}`} className="playlist-name">
                {playlist.name ?? 'Sans nom'}
              </Link>
              <span className="playlist-card-actions">
                <IconButton
                  icon={<CopyIcon />}
                  label={`Dupliquer ${playlist.name ?? ''}`}
                  disabled={duplicating !== null}
                  onClick={() => onDuplicate(playlist)}
                />
                {onDelete && (
                  <IconButton
                    icon={<TrashIcon />}
                    label={`Supprimer ${playlist.name ?? ''}`}
                    onClick={() => onDelete(playlist)}
                  />
                )}
              </span>
            </div>

            <p className="playlist-meta">
              {playlist.items.length === 0
                ? 'Vide'
                : `${playlist.items.length} média${playlist.items.length === 1 ? '' : 's'}`}
              {playlist.owner && ` · ${playlist.owner.login ?? ''}`}
              {playlist.public && ' · publique'}
            </p>

            {Object.keys(playlist.kindCounts).length > 0 && (
              <div className="playlist-kinds">
                {Object.entries(playlist.kindCounts).map(([kind, count]) => (
                  <Tag key={kind} dotColor={kindColor(kind)}>
                    {kindLabel(kind)} {count}
                  </Tag>
                ))}
              </div>
            )}

            <div className="playlist-card-foot">
              {playlist.notReadyCount > 0 ? (
                <Badge tone="warn">{playlist.notReadyCount} à compléter</Badge>
              ) : playlist.items.length > 0 ? (
                <Badge tone="ok">prête</Badge>
              ) : (
                <span />
              )}

              <Link to={`/playlists/${playlist.id}/lancer`}>
                <Button variant="primary" size="sm" disabled={playable === 0}>
                  Lancer
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
