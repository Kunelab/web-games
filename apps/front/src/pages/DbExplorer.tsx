import { msg } from 'i18n';
import { useRef, useState } from 'react';
import { Link } from 'react-router';

import { api, type DbCell, type DbColumn } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { useT } from '../i18n/locale-context';
import { Button, Dialog, EmptyState, Loading } from '../ui';
import { Pagination } from '../ui/Pagination';
import './db-explorer.css';

/**
 * The database, for the super-admin: every table and its rows, read only.
 *
 * Nothing here decides what may be seen. The API masks personal data and
 * secrets before a row leaves the server and refuses the whole thing to anyone
 * who is not a super-admin; this page only draws what it is sent, and draws a
 * masked value as masked so it is never read as data.
 */
export default function DbExplorer() {
  const t = useT();
  const tables = useAsync(() => api.dbTables(), []);

  const [table, setTable] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const rows = useAsync(
    () =>
      table === null
        ? Promise.resolve(null)
        : api.dbPage(table, { page, sort: sort?.column, direction: sort?.direction ?? 'asc' }),
    [table, page, sort?.column, sort?.direction]
  );

  function pick(name: string) {
    setTable(name);
    setPage(0);
    setSort(null);
  }

  /** First press sorts up, the next down, the third goes back to the table's own order. */
  function sortBy(column: DbColumn) {
    setPage(0);
    setSort((current) =>
      current?.column !== column.name
        ? { column: column.name, direction: 'asc' }
        : current.direction === 'asc'
          ? { column: column.name, direction: 'desc' }
          : null
    );
  }

  const data = rows.data;

  return (
    <>
      <Link to="/" className="backlink">
        {t(msg('nav.backHome'))}
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{t(msg('dbx.title'))}</h1>
          <p className="page-sub">{t(msg('dbx.lede'))}</p>
        </div>
      </div>

      {tables.loading && <Loading />}
      {tables.error && <p className="field-error">{tables.error}</p>}

      {tables.data && (
        <div className="dbx">
          <nav className="dbx-tables" aria-label={t(msg('dbx.tables'))}>
            {tables.data.tables.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className={`dbx-table ${entry.name === table ? 'on' : ''}`}
                aria-current={entry.name === table ? 'true' : undefined}
                onClick={() => pick(entry.name)}
              >
                <span className="dbx-table-name">{entry.name}</span>
                <span className="dbx-table-count tabular">{entry.rows}</span>
              </button>
            ))}
          </nav>

          <section className="dbx-main">
            {table === null && <p className="page-sub">{t(msg('dbx.pick'))}</p>}
            {rows.error && <p className="field-error">{rows.error}</p>}
            {table !== null && rows.loading && !data && <Loading />}

            {data && (
              <>
                <h2 className="section-title">
                  {data.table} <span className="dbx-total tabular">{t(msg('dbx.rows', { count: data.total }))}</span>
                </h2>

                {data.total === 0 ? (
                  <EmptyState title={t(msg('dbx.empty'))} />
                ) : (
                  <div className={`dbx-grid ${rows.loading ? 'is-loading' : ''}`} ref={gridRef}>
                    <table>
                      <thead>
                        <tr>
                          {data.columns.map((column) => (
                            <th key={column.name} scope="col">
                              {column.masked ? (
                                <span className="dbx-head" title={t(msg('dbx.masked'))}>
                                  {column.name} 🔒
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="dbx-head"
                                  title={t(msg('dbx.sortBy', { column: column.name }))}
                                  onClick={() => sortBy(column)}
                                >
                                  {column.name}
                                  {sort?.column === column.name && (sort.direction === 'asc' ? ' ▲' : ' ▼')}
                                </button>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((row) => (
                          <tr
                            key={row.rowid}
                            tabIndex={0}
                            onClick={() => setOpened(row.rowid)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') setOpened(row.rowid);
                            }}
                          >
                            {row.cells.map((cell, index) => (
                              <td key={data.columns[index]?.name ?? index}>
                                <CellText cell={cell} />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <Pagination
                  page={data.page}
                  pageCount={Math.ceil(data.total / data.pageSize)}
                  start={data.page * data.pageSize}
                  shown={data.rows.length}
                  total={data.total}
                  onPage={setPage}
                  anchor={gridRef}
                />
              </>
            )}
          </section>
        </div>
      )}

      {table !== null && opened !== null && <RowDialog table={table} rowid={opened} onClose={() => setOpened(null)} />}
    </>
  );
}

/** One row in full, every column on its own line and JSON laid out to be read. */
function RowDialog({ table, rowid, onClose }: { table: string; rowid: number; onClose: () => void }) {
  const t = useT();
  const row = useAsync(() => api.dbRow(table, rowid), [table, rowid]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(msg('dbx.row', { table, rowid }))}
      actions={
        <Button variant="ghost" onClick={onClose}>
          {t(msg('dbx.close'))}
        </Button>
      }
    >
      {row.loading && <Loading />}
      {row.error && <p className="field-error">{row.error}</p>}
      {row.data && (
        <dl className="dbx-row">
          {row.data.columns.map((column, index) => (
            <div key={column.name} className="dbx-row-field">
              <dt>{column.name}</dt>
              <dd>
                <CellText cell={row.data?.row.cells[index] ?? null} whole />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Dialog>
  );
}

/** A cell as text: masked and empty drawn as such, JSON indented when shown whole. */
function CellText({ cell, whole = false }: { cell: DbCell; whole?: boolean }) {
  const t = useT();
  if (cell === null) return <span className="dbx-null">NULL</span>;
  if (typeof cell === 'number') return <span className="tabular">{cell}</span>;
  if (typeof cell === 'string') return whole ? <pre className="dbx-text">{laidOut(cell)}</pre> : <>{cell}</>;
  if ('masked' in cell) {
    return (
      <span className="dbx-masked" title={t(msg('dbx.masked'))}>
        •••
      </span>
    );
  }
  if ('blob' in cell) return <span className="dbx-null">{`<blob ${cell.blob} B>`}</span>;
  return (
    <>
      {cell.preview}
      <span className="dbx-null">{`… (${cell.length})`}</span>
    </>
  );
}

/** JSON indented, anything else as it came. */
function laidOut(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
