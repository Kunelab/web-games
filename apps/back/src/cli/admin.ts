/* eslint-disable no-console -- a CLI's output is its interface */
import { eq } from 'drizzle-orm';

import { closeDb, db } from '../db/index.js';
import { users } from '../db/schema.js';

/**
 * Role management from the shell.
 *
 * Roles are enforced everywhere (`ownership.ts` widens reads for admins) but there
 * was no way to grant one short of editing the database by hand. There is still no
 * HTTP surface for this on purpose: promoting an account is a decision the box
 * owner takes at the box, not something a stolen admin cookie should be able to do.
 *
 *   pnpm --filter back admin list
 *   pnpm --filter back admin role <login> <member|admin|super-admin>
 */

const ROLES = ['member', 'admin', 'super-admin'] as const;

const [command, login, role] = process.argv.slice(2);

async function main(): Promise<number> {
  if (command === 'list') {
    const rows = await db
      .select({ id: users.id, login: users.login, role: users.role, last_login: users.last_login })
      .from(users);

    if (rows.length === 0) {
      console.log('No users.');
      return 0;
    }

    for (const row of rows) {
      console.log(
        `${String(row.id).padStart(4)}  ${(row.login ?? '').padEnd(24)} ${(row.role ?? 'member').padEnd(12)} last login: ${row.last_login ?? 'never'}`
      );
    }
    return 0;
  }

  if (command === 'role') {
    if (!login || !role || !(ROLES as readonly string[]).includes(role)) {
      console.error(`Usage: admin role <login> <${ROLES.join('|')}>`);
      return 1;
    }

    const [user] = await db.select().from(users).where(eq(users.login, login)).limit(1);
    if (!user) {
      console.error(`No user with login "${login}".`);
      return 1;
    }

    await db.update(users).set({ role }).where(eq(users.id, user.id));
    console.log(`${login}: ${user.role ?? 'member'} -> ${role}`);
    return 0;
  }

  console.error('Usage:\n  admin list\n  admin role <login> <member|admin|super-admin>');
  return 1;
}

main()
  .then((code) => {
    closeDb();
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    closeDb();
    console.error(error);
    process.exitCode = 1;
  });
