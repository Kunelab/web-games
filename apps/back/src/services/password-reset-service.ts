import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, eq, gt, lt } from 'drizzle-orm';

import { db } from '../db/index.js';
import { passwordResets, users, type User } from '../db/schema.js';

/**
 * How long a reset link works for.
 *
 * An hour is the usual answer and the reasoning is the same here: the link is a
 * bearer credential sitting in a mailbox, so it should stop being one soon after
 * it has served its purpose, while still surviving somebody who asks for it,
 * gets distracted, and comes back after dinner.
 */
export const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Tokens are 32 random bytes, base64url.
 *
 * 256 bits, from `randomBytes` rather than anything seeded, because this value
 * *is* the authentication for as long as it lives: whoever holds it is treated
 * as the account's owner. base64url so it survives being a query parameter, a
 * copied line in a terminal, and whatever a mail client decides to do to a URL.
 */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What goes in the table. See the note on the table itself for why SHA-256. */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compares two digests without leaking where they first differ.
 *
 * Overkill on the face of it, since a lookup by primary key gives the answer
 * anyway. It is here because the alternative invites the version of this code
 * that fetches candidate rows and compares with `===`, and at that point the
 * timing of a failed comparison is a real oracle for guessing a token byte by
 * byte. Both inputs are fixed-length hex, so the lengths always match.
 */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface IssuedReset {
  /** The clear token. Held only long enough to be put in a link, never stored. */
  token: string;
  expiresAt: number;
}

export const passwordResetService = {
  /**
   * Issues a link for whoever owns this e-mail address, if anyone does.
   *
   * Returns `null` when nobody does, and the route deliberately says the same
   * thing either way: an endpoint that answers "no such account" is a way to
   * find out which of a list of addresses has one here, and people reuse
   * addresses across sites that are not this one.
   *
   * Any earlier link for the same account is dropped first. Asking twice is what
   * somebody does when the first link did not arrive, and it should leave them
   * with one working link rather than a set of them, each of which is another
   * chance for an old mail to be read by the wrong person later.
   */
  async issueForEmail(email: string): Promise<(IssuedReset & { user: User }) | null> {
    this.sweep();

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return null;

    const token = newToken();
    const expiresAt = Date.now() + RESET_TTL_MS;

    db.transaction((tx) => {
      tx.delete(passwordResets).where(eq(passwordResets.user_id, user.id)).run();
      tx.insert(passwordResets)
        .values({ token_hash: digest(token), user_id: user.id, expires_at: expiresAt })
        .run();
    });

    return { token, expiresAt, user };
  },

  /**
   * Whose account this token opens, or undefined if it opens none.
   *
   * Read-only, so the reset page can tell somebody the link has expired before
   * asking them to think of a new password — rather than after.
   */
  async userIdFor(token: string): Promise<number | undefined> {
    const hash = digest(token);

    const [row] = await db
      .select()
      .from(passwordResets)
      .where(and(eq(passwordResets.token_hash, hash), gt(passwordResets.expires_at, Date.now())))
      .limit(1);

    if (!row || !digestsMatch(row.token_hash, hash)) return undefined;
    return row.user_id;
  },

  /**
   * Spends the token, whatever the caller does next.
   *
   * Separate from `userIdFor` so the route can delete the row in the same breath
   * as it reads it: a token that is looked up and then used to set a password is
   * a token that must not still work afterwards, and leaving those two steps far
   * apart is how a link ends up being replayable.
   */
  async consume(token: string): Promise<number | undefined> {
    const userId = await this.userIdFor(token);
    if (userId === undefined) return undefined;

    await db.delete(passwordResets).where(eq(passwordResets.token_hash, digest(token)));
    return userId;
  },

  /** Drops every outstanding link for an account. Used after a successful reset. */
  async clearFor(userId: number): Promise<void> {
    await db.delete(passwordResets).where(eq(passwordResets.user_id, userId));
  },

  /**
   * Deletes expired rows.
   *
   * Called on the way into issuing rather than on a timer. The table only grows
   * when somebody asks for a link, so the moment somebody asks is exactly when
   * it is worth tidying, and it saves this module owning an interval that has to
   * be cleaned up in tests and on shutdown.
   */
  sweep(): void {
    db.delete(passwordResets).where(lt(passwordResets.expires_at, Date.now())).run();
  }
};
