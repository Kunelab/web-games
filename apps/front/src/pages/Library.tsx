import { msg } from 'i18n';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { api, type MediaItem } from '../api/client';
import { kindColor, kindKey } from '../app/kinds';
import { fieldText } from '../forms/fieldText';
import { useAsync } from '../hooks/useAsync';
import { useLocale } from '../i18n/locale-context';
import { Badge, Button, Chip, CopyIcon, Dialog, EmptyState, IconButton, Input, Loading, Tag } from '../ui';
import './library.css';

/**
 * The library: everything that can be presented, in one place.
 *
 * Replaces the separate "videos" and "images" pages, which were two destinations for
 * one idea. Filters live in the URL, so a filtered view is a link you can keep, and
 * the back button steps through your filtering rather than leaving the page.
 */
export default function Library() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, locale } = useLocale();

  const kind = params.get('type') ?? '';
  const search = params.get('q') ?? '';
  const [searchDraft, setSearchDraft] = useState(search);

  const kinds = useAsync(() => api.kinds(), []);
  const media = useAsync(() => api.listMedia({ kind: kind || undefined, search: search || undefined }), [kind, search]);

  /**
   * What the confirm dialog is about: one row, or a whole selection.
   *
   * A list rather than an item, because the two deletions are the same
   * deletion. Keeping a second dialog for the bulk case would mean two places
   * to remember that this is the operation which quietly empties playlists.
   */
  const [pendingDelete, setPendingDelete] = useState<MediaItem[] | null>(null);
  const [usage, setUsage] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * The rows ticked, by id.
   *
   * Ids and not items, so a reload of the list does not strand the selection on
   * stale copies. Anything ticked and then filtered out of view stays ticked —
   * which is why the bar says how many there are, and why "select all" says
   * "shown".
   */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  /** The item being copied, so only its own button shows the pending state. */
  const [duplicating, setDuplicating] = useState<number | null>(null);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    setParams(next, { replace: true });
  }

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const item of media.data ?? []) {
      result[item.kind] = (result[item.kind] ?? 0) + 1;
    }
    return result;
  }, [media.data]);

  /**
   * Opens the confirmation, then goes and finds out what it will break.
   *
   * The dialog is up before the answer arrives, because the question is already
   * answerable without it — the count of playlists is what turns a confirm into
   * an informed one, not what makes it a confirm. Asked per media because that
   * is the endpoint there is; a selection of thirty is thirty small requests,
   * which is acceptable for something a person pressed once.
   */
  async function askDelete(targets: MediaItem[]) {
    if (targets.length === 0) return;
    setPendingDelete(targets);
    setUsage(null);
    try {
      const counts = await Promise.all(targets.map((item) => api.mediaUsage(item.id)));
      setUsage(counts.reduce((total, result) => total + result.playlists, 0));
    } catch {
      setUsage(null);
    }
  }

  function toggleSelected(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /**
   * Copies an item and opens the copy.
   *
   * Opening it is the point: a duplicate is made in order to change something, and
   * leaving the user on a list with two near-identical rows makes them hunt for the
   * one they just created.
   */
  async function duplicate(item: MediaItem) {
    setDuplicating(item.id);
    try {
      const copy = await api.duplicateMedia(item.id);
      void navigate(`/bibliotheque/${copy.id}`);
    } finally {
      setDuplicating(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      // One at a time and in order: there is no bulk endpoint, and firing thirty
      // deletes at once at a small box is not worth the tenth of a second.
      for (const item of pendingDelete) {
        await api.deleteMedia(item.id);
      }
      // Only what was actually deleted leaves the selection, so a failure
      // half-way through leaves the rest of it ticked and retryable.
      setSelected((current) => {
        const next = new Set(current);
        for (const item of pendingDelete) next.delete(item.id);
        return next;
      });
      setPendingDelete(null);
      media.reload();
    } finally {
      setDeleting(false);
    }
  }

  const items = media.data ?? [];
  const notReady = items.filter((item) => !item.readiness.ready).length;
  const selectedItems = items.filter((item) => selected.has(item.id));
  const allShownSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const many = (pendingDelete?.length ?? 0) > 1;

  return (
    <>
      <Link to="/" className="backlink">
        {t(msg('nav.backHome'))}
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{t(msg('lib.title'))}</h1>
          <p className="page-sub">
            {media.loading
              ? t(msg('lib.loading'))
              : notReady > 0
                ? t(msg('lib.countUnfinished', { count: items.length, unfinished: notReady }))
                : t(msg('lib.count', { count: items.length }))}
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            {t(msg('lib.importYoutube'))}
          </Button>
          <Button variant="primary" onClick={() => void navigate('/bibliotheque/nouveau')}>
            {t(msg('lib.newMedia'))}
          </Button>
        </div>
      </div>

      <div className="toolbar">
        <form
          className="search"
          onSubmit={(event) => {
            event.preventDefault();
            setParam('q', searchDraft.trim());
          }}
        >
          <Input
            type="search"
            value={searchDraft}
            placeholder={t(msg('lib.search'))}
            aria-label={t(msg('lib.searchLabel'))}
            onChange={(event) => {
              setSearchDraft(event.target.value);
              if (event.target.value === '') setParam('q', '');
            }}
          />
        </form>

        <div className="filters">
          <Chip active={!kind} onClick={() => setParam('type', '')}>
            {t(msg('lib.all'))}
          </Chip>
          {(kinds.data ?? []).map((descriptor) => (
            <Chip
              key={descriptor.id}
              active={kind === descriptor.id}
              dotColor={kindColor(descriptor.id)}
              onClick={() => setParam('type', kind === descriptor.id ? '' : descriptor.id)}
            >
              {descriptor.label[locale] ?? descriptor.label.en}
              {counts[descriptor.id] ? ` ${counts[descriptor.id]}` : ''}
            </Chip>
          ))}
        </div>
      </div>

      {/*
        The selection bar, which exists only while there is a selection.

        Not a permanent toolbar with dead buttons in it: the library is a list
        you read far more often than you tidy, and a row of greyed-out actions
        at the top of it every single visit is the cost of a feature used on a
        wet Sunday. Ticking the first box is what summons it.
      */}
      {selected.size > 0 && (
        <div className="lib-selection" role="status">
          <span className="lib-selection-count">{t(msg('lib.selected', { count: selected.size }))}</span>

          {!allShownSelected && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set([...selected, ...items.map((item) => item.id)]))}
            >
              {t(msg('lib.selectAll'))}
            </Button>
          )}

          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            {t(msg('lib.clearSelection'))}
          </Button>

          <Button variant="danger" size="sm" onClick={() => void askDelete(selectedItems)}>
            {t(msg('lib.deleteSelected'))}
          </Button>
        </div>
      )}

      {media.loading && <Loading />}
      {media.error && <p className="field-error">{media.error}</p>}

      {!media.loading && items.length === 0 && (
        <EmptyState
          title={t(msg(search || kind ? 'lib.noResults' : 'lib.empty'))}
          action={
            search || kind ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearchDraft('');
                  setParams(new URLSearchParams(), { replace: true });
                }}
              >
                {t(msg('lib.clearFilters'))}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void navigate('/bibliotheque/nouveau')}>
                {t(msg('lib.addFirst'))}
              </Button>
            )
          }
        >
          <p>{t(msg(search || kind ? 'lib.noMatch' : 'lib.whatIsMedia'))}</p>
        </EmptyState>
      )}

      {items.length > 0 && (
        <ul className="media-list">
          {items.map((item) => (
            <li key={item.id} className="media-row">
              <span className="kind-bar" style={{ background: kindColor(item.kind) }} aria-hidden="true" />

              {/* Named after the row it ticks, because "checkbox" read out forty
                  times in a row tells somebody nothing about which one is which. */}
              <input
                type="checkbox"
                className="media-tick"
                checked={selected.has(item.id)}
                aria-label={t(msg('lib.select', { title: item.title }))}
                onChange={() => toggleSelected(item.id)}
              />

              <Link to={`/bibliotheque/${item.id}`} className="media-main">
                <span className="media-title">{item.title}</span>
                <span className="media-meta">
                  {t(msg(kindKey(item.kind)))}
                  {item.category ? ` · ${item.category}` : ''}
                  {item.date ? ` · ${item.date.slice(0, 4)}` : ''}
                </span>
              </Link>

              <span className="media-answers">
                {item.answers.slice(0, 3).map((answer) => (
                  <Tag key={answer.key}>
                    {fieldText(t, answer.label)} {answer.points}
                  </Tag>
                ))}
              </span>

              <span className="media-state">
                {item.readiness.ready ? (
                  <span className="tabular media-points">
                    {t(
                      msg('play.points', {
                        points: item.answers.reduce((total, answer) => total + answer.points + answer.directBonus, 0)
                      })
                    )}
                  </span>
                ) : (
                  <Badge tone="warn">{t(msg('lib.unfinished'))}</Badge>
                )}
              </span>

              <IconButton
                icon={<CopyIcon />}
                label={t(msg('lib.duplicate', { title: item.title }))}
                disabled={duplicating !== null}
                onClick={() => void duplicate(item)}
              />

              <IconButton
                icon={<TrashIcon />}
                label={t(msg('lib.delete', { title: item.title }))}
                onClick={() => void askDelete([item])}
              />
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t(many ? msg('lib.deleteManyTitle', { count: pendingDelete?.length ?? 0 }) : msg('lib.deleteTitle'))}
        description={many ? t(msg('lib.deleteManyDesc')) : pendingDelete?.[0]?.title}
        actions={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t(msg('lib.cancel'))}
            </Button>
            <Button variant="danger" busy={deleting} onClick={() => void confirmDelete()}>
              {t(msg('lib.confirmDelete'))}
            </Button>
          </>
        }
      >
        {/* Saying how many playlists break is the difference between a confirm
            dialog that informs and one that is clicked through reflexively. */}
        <p className="dialog-desc">
          {usage === null
            ? t(msg('lib.checkingUsage'))
            : usage === 0
              ? t(msg(many ? 'lib.usedNowhereMany' : 'lib.usedNowhere'))
              : t(msg(many ? 'lib.willBeRemovedMany' : 'lib.willBeRemoved', { count: usage }))}
        </p>
      </Dialog>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          setImportOpen(false);
          media.reload();
        }}
      />
    </>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const t = useLocale().t;
  const [reference, setReference] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await api.youtubeImport(reference, category || undefined);
      setResult(
        outcome.notReady > 0
          ? t(msg('lib.import.doneUnfinished', { count: outcome.imported, unfinished: outcome.notReady }))
          : t(msg('lib.import.done', { count: outcome.imported }))
      );
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(msg('lib.import.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(msg('lib.import.title'))}
      description={t(msg('lib.import.desc'))}
      actions={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t(msg('lib.import.close'))}
          </Button>
          <Button variant="primary" busy={busy} disabled={!reference.trim()} onClick={() => void run()}>
            {t(msg('lib.import.run'))}
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <Input
          value={reference}
          placeholder={t(msg('lib.import.reference'))}
          aria-label={t(msg('lib.import.playlistLabel'))}
          onChange={(event) => setReference(event.target.value)}
        />
        <Input
          value={category}
          placeholder={t(msg('lib.import.category'))}
          aria-label={t(msg('lib.import.categoryLabel'))}
          onChange={(event) => setCategory(event.target.value)}
        />
        {result && <p className="field-hint">{result}</p>}
        {error && <p className="field-error">{error}</p>}
      </div>
    </Dialog>
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
