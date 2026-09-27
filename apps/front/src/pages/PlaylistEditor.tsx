import { msg } from 'i18n';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { api, type MediaItem, type Playlist } from '../api/client';
import { isAdmin, useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/locale-context';
import { kindColor, kindKey } from '../app/kinds';
import { useAsync } from '../hooks/useAsync';
import { Badge, Button, Chip, Dialog, Field, IconButton, Input, Loading, Switch } from '../ui';
import './library.css';
import './playlists.css';

/**
 * What a shared quiz looks like when it is not yours: its contents, and nothing
 * you can press.
 *
 * Deliberately not a disabled copy of the editor. A greyed-out drag handle and a
 * dead "Save" button invite the same misunderstanding the editor did — that this
 * is nearly editable and something is merely broken. A plain list says what it
 * is, and the one action on the screen is the one that works.
 */
function PlaylistPreview({ playlist }: { playlist: Playlist }) {
  const t = useT();
  const items = playlist.items ?? [];

  return (
    <section className="pl-panel">
      <header className="pl-panel-head">
        <h2 className="pl-panel-title">{t(msg('ple.inPlaylist'))}</h2>
        <span className="pl-panel-count">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="pl-panel-empty">{t(msg('ple.addFromLibrary'))}</p>
      ) : (
        <ul className="pl-list">
          {items.map((item) => (
            <li className="pl-row" key={item.id}>
              <span className="pl-row-title">{item.title}</span>
              <Badge>{t(msg(kindKey(item.kind)))}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Contents on the left, library on the right.
 *
 * Both are visible at once, which is the fix for the old editor's mode switch: it
 * toggled between "the list" and "add items" so you could never see what you were
 * building while choosing what to add.
 */
export default function PlaylistEditor() {
  const t = useT();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const playlistId = Number(id);
  const [copying, setCopying] = useState(false);

  const playlist = useAsync(() => api.getPlaylist(playlistId), [playlistId]);
  const library = useAsync(() => api.listMedia(), []);

  if (playlist.loading) return <Loading />;

  if (!playlist.data) {
    return (
      <>
        <Link to="/playlists" className="backlink">
          {t(msg('ple.back'))}
        </Link>
        <p className="field-error">{playlist.error ?? t(msg('launch.notFound'))}</p>
      </>
    );
  }

  /**
   * Somebody else's public quiz opens as a copy, not as an editor.
   *
   * The server has always refused the write — `PATCH /playlists/:id` checks
   * ownership, and public means readable, not editable — but this screen had no
   * idea whose playlist it was showing. So it offered the full editor on a quiz
   * you do not own, let you rename it, reorder it, add to it, and then failed
   * the save silently. Nothing was ever at risk; it simply lied about what it
   * could do.
   *
   * Duplicating is the real answer and already exists on both sides, so the
   * screen offers that instead of a save it cannot perform.
   *
   * Admins are the exception, and they have to be: the generated-rounds
   * catalogue is written with no owner at all, so no id ever matches it and the
   * ownership test alone locked every account out of the one playlist that is
   * meant to be maintained. The server has always allowed this: `mayEdit` runs
   * `ownerFilter`, which an admin's role widens to "any row". So this only stops
   * the screen from hiding an edit the API would have accepted all along.
   */
  const mine = playlist.data.user_id === user?.id || isAdmin(user);
  if (!mine) {
    return (
      <>
        <Link to="/playlists" className="backlink">
          {t(msg('ple.back'))}
        </Link>
        <div className="page-head">
          <div>
            <h1 className="page-title">{playlist.data.name}</h1>
            <p className="page-sub">{t(msg('ple.readOnly'))}</p>
          </div>
          <div className="page-actions">
            <Button
              variant="primary"
              busy={copying}
              onClick={() => {
                setCopying(true);
                void api
                  .duplicatePlaylist(playlistId)
                  .then((copy) => navigate(`/playlists/${copy.id}`))
                  .finally(() => setCopying(false));
              }}
            >
              {t(msg('ple.duplicateToEdit'))}
            </Button>
          </div>
        </div>
        <p className="field-hint">
          {t(msg('ple.readOnlyHint', { owner: playlist.data.owner?.login ?? '—' }))}
        </p>
        <PlaylistPreview playlist={playlist.data} />
      </>
    );
  }

  // Keyed on the loaded playlist, so its editable state is seeded from props on
  // mount rather than copied in by an effect. Reloading after a save remounts with
  // the saved values and resets the dirty flag for free.
  return (
    <Editor
      key={`${playlist.data.id}-${playlist.data.last_modified ?? ''}`}
      playlist={playlist.data}
      library={library.data ?? []}
      libraryLoading={library.loading}
      onSaved={() => playlist.reload()}
    />
  );
}

interface EditorProps {
  playlist: Playlist;
  library: MediaItem[];
  libraryLoading: boolean;
  onSaved: () => void;
}

/**
 * The shared generated-rounds catalogue, by the name the server files it
 * under. Kept as a literal with the sync note rather than served by the API:
 * the playlist itself is the identifier here, and renaming it on either side
 * without the other only hides the duplicate flags, never breaks an edit.
 * Must stay identical to `EVERYTHING_PLAYLIST_NAME` in
 * `apps/back/src/services/blindtest-library.ts`.
 */
const EVERYTHING_PLAYLIST_NAME = 'Tout (généré)';

type DuplicateReason = 'same-video' | 'same-track' | 'similar';

interface DuplicatePartner {
  id: number;
  reason: DuplicateReason;
}

interface DuplicateInfo {
  /** Strongest reason found against this entry. */
  reason: DuplicateReason;
  partners: DuplicatePartner[];
}

const DUPLICATE_RANK: Record<DuplicateReason, number> = { 'same-video': 0, 'same-track': 1, similar: 2 };

function duplicateReasonKey(reason: DuplicateReason): string {
  if (reason === 'same-video') return 'ple.duplicate.sameVideo';
  if (reason === 'same-track') return 'ple.duplicate.sameTrack';
  return 'ple.duplicate.similar';
}

function Editor({ playlist, library, libraryLoading, onSaved }: EditorProps) {
  const t = useT();
  const { user } = useAuth();
  const playlistId = playlist.id;
  const admin = isAdmin(user);

  /**
   * Whether this row offers a way through to the media editor.
   *
   * The same test the server applies in `ownerFilter`, asked here so the link is
   * absent rather than dead: a member who took a copy of a public quiz has rows
   * in it they cannot open, and a pencil that leads to "média introuvable" is
   * worse than no pencil.
   *
   * For an admin it is always true, which is the point of it. The generated
   * rounds belong to nobody, so they appear in no library and there is otherwise
   * no route to them at all: you could see that a clip's artist was wrong, sat
   * in a playlist you were allowed to edit, and have nowhere to go to fix it.
   */
  function mayEditMedia(item: MediaItem): boolean {
    return isAdmin(user) || (user !== null && item.user_id === user.id);
  }

  const [name, setName] = useState(playlist.name ?? '');
  const [isPublic, setIsPublic] = useState(Boolean(playlist.public));
  const [order, setOrder] = useState<number[]>(playlist.items.map((item) => item.id));
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** The entry whose duplicate flag the admin is settling, by id. */
  const [dupTargetId, setDupTargetId] = useState<number | null>(null);
  const [dupBusy, setDupBusy] = useState<'clear' | 'delete' | null>(null);

  const byId = useMemo(() => {
    const map = new Map<number, MediaItem>();
    for (const item of library) map.set(item.id, item);
    for (const item of playlist.items) map.set(item.id, item);
    return map;
  }, [library, playlist.items]);

  const chosen = order.map((mediaId) => byId.get(mediaId)).filter((item): item is MediaItem => Boolean(item));
  const chosenIds = new Set(order);

  /**
   * Possible duplicates in the shared catalogue, admin only.
   *
   * Fetched solely on the `Tout (généré)` playlist: that playlist *is* the
   * catalogue the detector scans, so anywhere else the flags would be about
   * rows that are not even on screen. Non-admins never fetch — the endpoint
   * would refuse them, and there is no icon to feed.
   */
  const showDuplicates = admin && playlist.name === EVERYTHING_PLAYLIST_NAME;
  const duplicates = useAsync(
    () => (showDuplicates ? api.blindtestDuplicates() : Promise.resolve({ groups: [] })),
    [showDuplicates, playlistId]
  );

  /**
   * Flags by entry, with the partners each entry collides with.
   *
   * Partners accumulate across groups with the strongest reason kept per
   * partner, so the dialog can name each collision honestly rather than
   * repeating the group's headline reason for all of them.
   */
  const dupById = useMemo(() => {
    const acc = new Map<number, { reason: DuplicateReason; partners: Map<number, DuplicateReason> }>();
    for (const group of duplicates.data?.groups ?? []) {
      const reason = group.reason;
      for (const id of group.mediaIds) {
        let entry = acc.get(id);
        if (!entry) {
          entry = { reason, partners: new Map() };
          acc.set(id, entry);
        } else if (DUPLICATE_RANK[reason] < DUPLICATE_RANK[entry.reason]) {
          entry.reason = reason;
        }
        for (const other of group.mediaIds) {
          if (other === id) continue;
          const current = entry.partners.get(other);
          if (!current || DUPLICATE_RANK[reason] < DUPLICATE_RANK[current]) entry.partners.set(other, reason);
        }
      }
    }
    const map = new Map<number, DuplicateInfo>();
    for (const [id, entry] of acc) {
      map.set(id, {
        reason: entry.reason,
        partners: [...entry.partners.entries()].map(([partnerId, partnerReason]) => ({
          id: partnerId,
          reason: partnerReason
        }))
      });
    }
    return map;
  }, [duplicates.data]);

  const dupTarget = dupTargetId !== null ? byId.get(dupTargetId) : undefined;
  const dupInfo = dupTargetId !== null ? dupById.get(dupTargetId) : undefined;

  /**
   * "These are not duplicates": settles every flag raised against the entry.
   *
   * Stored server-side as the entry's current pairs, so a genuinely new
   * collision later still flags. The icon drops on the reload below.
   */
  async function clearDuplicateFlag(item: MediaItem) {
    setDupBusy('clear');
    try {
      await api.blindtestDismissDuplicate(item.id);
      setDupTargetId(null);
      duplicates.reload();
    } finally {
      setDupBusy(null);
    }
  }

  /**
   * Deletes the duplicate entry outright.
   *
   * The row goes through the ordinary `DELETE /media/:id` — an admin may call
   * it on any row, including an ownerless one — whose cascade drops the
   * playlist link with it. Local order follows, and the saved playlist is
   * reloaded for the counts.
   */
  async function deleteDuplicateMedia(item: MediaItem) {
    setDupBusy('delete');
    try {
      await api.deleteMedia(item.id);
      setOrder((current) => current.filter((mediaId) => mediaId !== item.id));
      setDupTargetId(null);
      duplicates.reload();
      onSaved();
    } finally {
      setDupBusy(null);
    }
  }

  const available = library.filter((item) => {
    if (chosenIds.has(item.id)) return false;
    if (kindFilter && item.kind !== kindFilter) return false;
    if (search && !item.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const sensors = useSensors(
    // A small distance threshold so a tap still counts as a click on the row.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = order.indexOf(Number(active.id));
    const to = order.indexOf(Number(over.id));
    if (from === -1 || to === -1) return;

    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    setOrder(next);
    setDirty(true);
  }

  function add(mediaId: number) {
    setOrder([...order, mediaId]);
    setDirty(true);
  }

  /**
   * Everything the filters are currently showing, in one press.
   *
   * Building a thirty-item blind test was thirty presses, each of which removed
   * the row from under the cursor and moved the next one up into it. The search
   * box and the kind chips above are already the selection — "every 90s clip",
   * "everything with 'Queen' in the title" — so this only had to act on what
   * they had narrowed the list to rather than grow a second way of choosing.
   *
   * Appended in the order shown, which is the order the list is sorted in, and
   * the whole point of the panel to the left is that it can then be rearranged.
   */
  function addAll() {
    if (available.length === 0) return;
    setOrder([...order, ...available.map((item) => item.id)]);
    setDirty(true);
  }

  function remove(mediaId: number) {
    setOrder(order.filter((candidate) => candidate !== mediaId));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await api.updatePlaylist(playlistId, {
        name: name.trim() || t(msg('pl.untitled')),
        public: isPublic,
        mediaIds: order
      });
      setDirty(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const notReady = chosen.filter((item) => !item.readiness.ready).length;
  const kinds = [...new Set(library.map((item) => item.kind))];

  return (
    <>
      <Link to="/playlists" className="backlink">
        {t(msg('ple.back'))}
      </Link>

      <div className="page-head">
        <div style={{ flex: 1, minWidth: '14rem' }}>
          <Field label={t(msg('ple.name'))}>
            {({ id: fieldId }) => (
              <Input
                id={fieldId}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setDirty(true);
                }}
              />
            )}
          </Field>
        </div>
        <div className="page-actions">
          <Link to={`/playlists/${playlistId}/lancer`}>
            <Button variant="secondary" disabled={chosen.length - notReady === 0 || dirty}>
              {t(msg('ple.launch'))}
            </Button>
          </Link>
          <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>
            {t(msg(dirty ? 'ple.save' : 'ple.saved'))}
          </Button>
        </div>
      </div>

      <div style={{ marginBottom: 'var(--space-5)', maxWidth: '32rem' }}>
        <Switch
          label={t(msg('ple.public'))}
          hint={t(msg('ple.publicHint'))}
          checked={isPublic}
          onCheckedChange={(checked) => {
            setIsPublic(checked);
            setDirty(true);
          }}
        />
      </div>

      <div className="pl-editor">
        <section className="pl-panel">
          <header className="pl-panel-head">
            <h2 className="pl-panel-title">{t(msg('ple.inPlaylist'))}</h2>
            <span className="pl-panel-count">
              {chosen.length} ·{' '}
              {notReady > 0 ? t(msg('pl.toFinish', { count: notReady })) : t(msg('ple.allReady'))}
              {dupById.size > 0 && <> · {t(msg('ple.duplicate.count', { count: dupById.size }))}</>}
            </span>
          </header>

          {chosen.length === 0 ? (
            <p className="pl-panel-empty">{t(msg('ple.addFromLibrary'))}</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <ul className="pl-items">
                  {chosen.map((item, index) => (
                    <SortableRow
                      key={item.id}
                      item={item}
                      index={index}
                      canEdit={mayEditMedia(item)}
                      duplicate={showDuplicates ? dupById.get(item.id) : undefined}
                      onShowDuplicate={() => setDupTargetId(item.id)}
                      onRemove={() => remove(item.id)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </section>

        <section className="pl-panel">
          <header className="pl-panel-head">
            <h2 className="pl-panel-title">{t(msg('ple.library'))}</h2>
            <span className="pl-panel-count">{t(msg('ple.available', { count: available.length }))}</span>
          </header>

          <div style={{ padding: 'var(--space-3) var(--space-4)' }} className="stack-3">
            <Input
              type="search"
              value={search}
              placeholder={t(msg('ple.search'))}
              aria-label={t(msg('ple.searchLabel'))}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="filters">
              <Chip active={!kindFilter} onClick={() => setKindFilter('')}>
                {t(msg('lib.all'))}
              </Chip>
              {kinds.map((kind) => (
                <Chip
                  key={kind}
                  active={kindFilter === kind}
                  dotColor={kindColor(kind)}
                  onClick={() => setKindFilter(kindFilter === kind ? '' : kind)}
                >
                  {t(msg(kindKey(kind)))}
                </Chip>
              ))}
            </div>

            {/* Offered only when it would do something more than the row buttons
                already do: for one item it is the same press with a longer walk. */}
            {available.length > 1 && (
              <Button variant="secondary" size="sm" onClick={addAll}>
                {t(msg('ple.addAll', { count: available.length }))}
              </Button>
            )}
          </div>

          {libraryLoading && <Loading />}

          {!libraryLoading && available.length === 0 ? (
            <p className="pl-panel-empty">
              {library.length === 0 ? (
                <>
                  {t(msg('ple.libraryEmpty'))}{' '}
                  <Link to="/bibliotheque/nouveau" className="link-quiet">
                    {t(msg('ple.addMedia'))}
                  </Link>
                </>
              ) : (
                t(msg('ple.nothingLeft'))
              )}
            </p>
          ) : (
            <ul className="pl-items">
              {available.map((item) => (
                <li className="pl-item" key={item.id}>
                  <span />
                  <span className="pl-item-bar" style={{ background: kindColor(item.kind) }} aria-hidden="true" />
                  <span className="pl-item-main">
                    <span className="pl-item-title">{item.title}</span>
                    <span className="pl-item-meta">
                      {t(msg(kindKey(item.kind)))}
                      {item.category ? ` · ${item.category}` : ''}
                      {!item.readiness.ready && t(msg('ple.unfinishedMeta'))}
                    </span>
                  </span>
                  <IconButton
                    icon={<PlusIcon />}
                    label={t(msg('ple.add', { title: item.title }))}
                    onClick={() => add(item.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog
        open={dupTarget !== undefined && dupInfo !== undefined}
        onOpenChange={(open) => {
          if (!open) setDupTargetId(null);
        }}
        title={t(msg('ple.duplicate.title'))}
        description={dupTarget?.title}
        actions={
          <>
            <Button variant="ghost" disabled={dupBusy !== null} onClick={() => setDupTargetId(null)}>
              {t(msg('ple.duplicate.cancel'))}
            </Button>
            {dupTarget && (
              <Button variant="secondary" busy={dupBusy === 'clear'} onClick={() => void clearDuplicateFlag(dupTarget)}>
                {t(msg('ple.duplicate.clear'))}
              </Button>
            )}
            {dupTarget && (
              <Button variant="danger" busy={dupBusy === 'delete'} onClick={() => void deleteDuplicateMedia(dupTarget)}>
                {t(msg('ple.duplicate.delete'))}
              </Button>
            )}
          </>
        }
      >
        <p className="dialog-desc">{t(msg('ple.duplicate.explains'))}</p>
        {dupInfo && (
          <ul className="pl-dup-list">
            {dupInfo.partners.map((partner) => (
              <li key={partner.id}>
                <span className="pl-dup-partner">{byId.get(partner.id)?.title ?? `#${partner.id}`}</span>
                <span className="pl-dup-reason"> — {t(msg(duplicateReasonKey(partner.reason)))}</span>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}

function SortableRow({
  item,
  index,
  canEdit,
  duplicate,
  onShowDuplicate,
  onRemove
}: {
  item: MediaItem;
  index: number;
  canEdit: boolean;
  duplicate?: DuplicateInfo;
  onShowDuplicate?: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  return (
    <li
      ref={setNodeRef}
      className={`pl-item ${isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {/* A real button, so reordering works from the keyboard too. */}
      <button
        type="button"
        className="pl-handle"
        aria-label={t(msg('ple.move', { title: item.title, position: index + 1 }))}
        {...attributes}
        {...listeners}
      >
        <GripIcon />
      </button>
      <span className="pl-item-bar" style={{ background: kindColor(item.kind) }} aria-hidden="true" />
      <span className="pl-item-main">
        <span className="pl-item-title">
          {index + 1}. {item.title}
        </span>
        <span className="pl-item-meta">
          {t(msg(kindKey(item.kind)))}
          {item.category ? ` · ${item.category}` : ''}
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {!item.readiness.ready && <Badge tone="warn">{t(msg('lib.unfinished'))}</Badge>}
        {/*
          The duplicate flag, on the generated catalogue only and for admins.
          A warning triangle rather than a badge: the row is playable as is,
          and a badge would read as a verdict where this is a question.
        */}
        {duplicate && (
          <IconButton
            icon={<DuplicateIcon />}
            className="pl-dup-flag"
            label={t(msg('ple.duplicate.flag', { title: item.title }))}
            onClick={onShowDuplicate}
          />
        )}
        {/*
          A new tab, deliberately.

          This playlist is very likely half-edited: the order moved, the name
          changed, nothing saved yet, and none of that survives a navigation.
          Correcting one clip's artist should not cost you the reordering you
          just did, and the alternative would be a "leave without saving?"
          dialogue, which this app has nowhere else and does not need here.

          A real anchor rather than a button, so it also behaves the way a link
          should: the middle click and the context menu both work.
        */}
        {canEdit && (
          <a
            className="btn btn-icon"
            href={`/bibliotheque/${item.id}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t(msg('ple.editMedia', { title: item.title }))}
            title={t(msg('ple.editMedia', { title: item.title }))}
          >
            <PencilIcon />
          </a>
        )}
        <IconButton icon={<MinusIcon />} label={t(msg('ple.remove', { title: item.title }))} onClick={onRemove} />
      </span>
    </li>
  );
}

/** A warning triangle, at the same weight as the grip and the minus beside it. */
function DuplicateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4 2.5 20h19L12 4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.2" fill="currentColor" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** A pencil, at the same weight as the grip and the minus beside it. */
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m14.5 7.5 2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
