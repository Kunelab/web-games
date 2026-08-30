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
import { Link, useParams } from 'react-router';

import { api, type MediaItem, type Playlist } from '../api/client';
import { useT } from '../i18n/locale-context';
import { kindColor, kindKey } from '../app/kinds';
import { useAsync } from '../hooks/useAsync';
import { Badge, Button, Chip, Field, IconButton, Input, Loading, Switch } from '../ui';
import './library.css';
import './playlists.css';

/**
 * Contents on the left, library on the right.
 *
 * Both are visible at once, which is the fix for the old editor's mode switch: it
 * toggled between "the list" and "add items" so you could never see what you were
 * building while choosing what to add.
 */
export default function PlaylistEditor() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const playlistId = Number(id);

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

function Editor({ playlist, library, libraryLoading, onSaved }: EditorProps) {
  const t = useT();
  const playlistId = playlist.id;

  const [name, setName] = useState(playlist.name ?? '');
  const [isPublic, setIsPublic] = useState(Boolean(playlist.public));
  const [order, setOrder] = useState<number[]>(playlist.items.map((item) => item.id));
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const byId = useMemo(() => {
    const map = new Map<number, MediaItem>();
    for (const item of library) map.set(item.id, item);
    for (const item of playlist.items) map.set(item.id, item);
    return map;
  }, [library, playlist.items]);

  const chosen = order.map((mediaId) => byId.get(mediaId)).filter((item): item is MediaItem => Boolean(item));
  const chosenIds = new Set(order);

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
                    <SortableRow key={item.id} item={item} index={index} onRemove={() => remove(item.id)} />
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
    </>
  );
}

function SortableRow({ item, index, onRemove }: { item: MediaItem; index: number; onRemove: () => void }) {
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
        <IconButton icon={<MinusIcon />} label={t(msg('ple.remove', { title: item.title }))} onClick={onRemove} />
      </span>
    </li>
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
