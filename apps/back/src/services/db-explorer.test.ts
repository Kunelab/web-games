import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

/**
 * The database explorer, on a database of its own.
 *
 * Built the way the app builds its own, so the tables and columns checked here
 * are the ones a super-admin will see. The module reads the environment on
 * import, so it is pointed at a temporary file first.
 */
const directory = mkdtempSync(join(tmpdir(), 'kune-explorer-test-'));
const file = join(directory, 'test.db');
process.env.DATABASE_FILE = file;
process.env.SECRET ??= 'explorer-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { openDb } = await import('../db/open.js');
const { COLUMNS, MASK, createExplorer, openReader } = await import('./db-explorer.js');

const { sqlite } = openDb(file);
sqlite
  .prepare(
    "INSERT INTO Users (id, role, login, email, password, createdAt, updatedAt) VALUES (1, 'member', 'ana', 'ana@example.com', 'hash', '', '')"
  )
  .run();
sqlite
  .prepare(
    "INSERT INTO Users (id, role, login, email, password, createdAt, updatedAt) VALUES (2, 'member', 'bo', NULL, 'hash', '', '')"
  )
  .run();
sqlite.prepare('INSERT INTO Sessions (sid, expires_at, data) VALUES (\'secret-sid\', 1, \'{"user":{"id":1}}\')').run();
sqlite
  .prepare(
    'INSERT INTO GameSessions (code, host_token, phase, config, state, last_activity_at) VALUES (?, ?, ?, ?, ?, 0)'
  )
  .run(
    'ABCDE',
    'host-secret',
    'playing',
    JSON.stringify({ password: 'door', name: 'Soirée' }),
    JSON.stringify({ hostToken: 'host-secret', players: [{ name: 'ana', token: 'seat', tokens: 12 }] })
  );
sqlite
  .prepare("INSERT INTO BugReports (login, area, message, user_agent) VALUES ('ana', 'quiz', ?, 'Firefox 130')")
  .run('x'.repeat(500));

const explorer = createExplorer(file);
after(() => {
  explorer.close();
  sqlite.close();
});

const rowsOf = (table: string) => explorer.page(table, { page: 0, direction: 'asc' });
const cell = (table: string, column: string, index = 0) => {
  const page = rowsOf(table);
  return page.rows[index]?.cells[page.columns.findIndex((candidate) => candidate.name === column)];
};

describe('the database explorer', () => {
  it('has a label for every column of every table the app creates', () => {
    const unlabelled = explorer
      .tables()
      .flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}`))
      .filter((key) => {
        const [table = '', column = ''] = key.split('.');
        return COLUMNS[table]?.[column] === undefined;
      });
    assert.deepEqual(unlabelled, [], 'label these in COLUMNS: show, mask or scrub');
  });

  it('shows a username and masks the rest of a person', () => {
    assert.equal(cell('Users', 'login'), 'ana');
    assert.deepEqual(cell('Users', 'email'), { masked: true });
    assert.deepEqual(cell('Users', 'password'), { masked: true });
    assert.equal(cell('Users', 'email', 1), null, 'no address is not an address');
  });

  it('never sends a session id, a host token or a browser', () => {
    assert.deepEqual(cell('Sessions', 'sid'), { masked: true });
    assert.deepEqual(cell('Sessions', 'data'), { masked: true });
    assert.deepEqual(cell('GameSessions', 'host_token'), { masked: true });
    assert.deepEqual(cell('BugReports', 'user_agent'), { masked: true });
  });

  it('masks the secrets inside a saved game, and nothing else in it', () => {
    const page = rowsOf('GameSessions');
    const { row } = explorer.row('GameSessions', page.rows[0]?.rowid ?? 0);
    const at = (column: string) => row.cells[page.columns.findIndex((candidate) => candidate.name === column)];

    const state = JSON.parse(at('state') as string) as { hostToken: string; players: Record<string, unknown>[] };
    assert.equal(state.hostToken, MASK);
    assert.deepEqual(state.players[0], { name: 'ana', token: MASK, tokens: 12 });

    const config = JSON.parse(at('config') as string) as { password: string; name: string };
    assert.deepEqual(config, { password: MASK, name: 'Soirée' });
  });

  it('shortens a long cell on the page and sends it whole on its row', () => {
    const preview = cell('BugReports', 'message') as { preview: string; length: number };
    assert.equal(preview.length, 500);
    assert.ok(preview.preview.length < 500);

    const page = rowsOf('BugReports');
    const { row } = explorer.row('BugReports', page.rows[0]?.rowid ?? 0);
    assert.equal(row.cells[page.columns.findIndex((column) => column.name === 'message')], 'x'.repeat(500));
  });

  it('sorts by a visible column, and refuses a masked or unknown one', () => {
    const sorted = explorer.page('Users', { page: 0, sort: 'login', direction: 'desc' });
    assert.equal(sorted.rows[0]?.cells[sorted.columns.findIndex((column) => column.name === 'login')], 'bo');

    assert.throws(() => explorer.page('Users', { page: 0, sort: 'email', direction: 'asc' }), /masquée/);
    assert.throws(() => explorer.page('Users', { page: 0, sort: 'nope', direction: 'asc' }), /inconnue/);
    assert.throws(() => explorer.page('Nope', { page: 0, direction: 'asc' }), /inconnue/);
  });

  it('cannot write', () => {
    const reader = openReader(file);
    try {
      assert.throws(() => reader.prepare('DELETE FROM Users').run(), /readonly/);
    } finally {
      reader.close();
    }
  });
});
