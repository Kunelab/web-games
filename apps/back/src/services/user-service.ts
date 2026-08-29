import { randomBytes } from 'node:crypto';

import { hash, parseOptions, verify, type Algorithm, type Options } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { users, type User } from '../db/schema.js';

/**
 * argon2id, at the parameters OWASP recommends.
 *
 * These are also this package's defaults, and they are written out anyway: a
 * future release changing a default would silently change how hard every
 * password in the database is to crack, and that is not a thing to learn from a
 * changelog.
 *
 * The reason this is argon2id rather than the bcrypt it replaced is memory.
 * bcrypt costs ~4 KiB whatever its work factor, so a GPU runs tens of thousands
 * of guesses side by side; 19 MiB each puts an 8 GiB card at a few hundred. Time
 * is the only thing a bcrypt work factor buys, and time is what an attacker has
 * the most of.
 */
/**
 * `Algorithm.Argon2id`, spelled as its value.
 *
 * The package declares that enum as an ambient `const enum`, which this
 * workspace's `verbatimModuleSyntax` refuses to inline — importing the member
 * is a compile error rather than a runtime one, so it is written out here once.
 */
const ARGON2ID = 2 as Algorithm;

const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  /** 19 MiB, per thread. */
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
} satisfies Options;

/**
 * A real hash of nothing, compared against when the login does not exist.
 *
 * Without it an unknown user answers in a microsecond and a known one in a
 * hundred milliseconds, which turns the login form into a way to enumerate
 * accounts. Built once, lazily, from the same options as everything else — a
 * hardcoded constant would drift the moment the parameters above changed, and
 * the drift would be exactly the timing signal this exists to remove.
 */
let unknownUserHash: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  unknownUserHash ??= hash(randomBytes(32).toString('hex'), HASH_OPTIONS);
  return unknownUserHash;
}

/**
 * Whether a stored hash was made with weaker parameters than we use now.
 *
 * Anything unparseable — a bcrypt hash from before this migration, a truncated
 * column — is not rehashable, because rehashing needs the plaintext to have been
 * verified first and those never verify. Said plainly here rather than left to a
 * thrown exception at the call site.
 */
function belowPolicy(stored: string): boolean {
  try {
    const current = parseOptions(stored);
    return (
      current.algorithm !== HASH_OPTIONS.algorithm ||
      current.memoryCost < HASH_OPTIONS.memoryCost ||
      current.timeCost < HASH_OPTIONS.timeCost ||
      current.parallelism !== HASH_OPTIONS.parallelism
    );
  } catch {
    return false;
  }
}

/**
 * Constant-ish password check.
 *
 * `verify` throws rather than returning false when the stored string is not an
 * argon2 hash at all, which is what every account created before the migration
 * holds. Those accounts simply cannot log in — deliberately, and the database
 * was empty when the switch was made — but a login attempt against one has to
 * answer "wrong password", not crash the route.
 */
async function matches(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password, HASH_OPTIONS);
  } catch {
    return false;
  }
}

/** What `create` says when the login was taken between the check and the insert. */
export type CreateUserResult = { ok: true; user: User } | { ok: false; reason: 'taken' };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

export const userService = {
  async getByLogin(login: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.login, login)).limit(1);
    return user;
  },

  async getById(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  },

  /**
   * Seats a new account.
   *
   * The caller checks the login first for the sake of a decent error message;
   * this catches the case where two people claimed the same name in the gap
   * between that check and this insert. Before the unique index existed, both
   * inserts succeeded and one of the two accounts became permanently
   * unreachable, since every lookup is a `LIMIT 1`.
   */
  async create(login: string, password: string, email: string): Promise<CreateUserResult> {
    const hashedPassword = await hash(password, HASH_OPTIONS);

    try {
      const [user] = await db
        .insert(users)
        .values({
          login,
          password: hashedPassword,
          email,
          role: 'member'
        })
        .returning();

      if (!user) {
        throw new Error('user insert returned no row');
      }
      return { ok: true, user };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: 'taken' };
      throw error;
    }
  },

  async authenticate(login: string, password: string): Promise<User | null> {
    const user = await this.getByLogin(login);

    // Compare against a dummy hash when the login is unknown so that a missing
    // user and a wrong password take the same amount of time.
    const stored = user?.password ?? (await dummyHash());
    const ok = await matches(stored, password);

    if (!user || !ok) {
      return null;
    }

    /**
     * Raising the parameters is free for everyone already here: the one moment
     * the server legitimately holds a plaintext password is right now, so the
     * stronger hash is written on the way past. Nobody is asked to change
     * anything, and a policy change reaches the whole table one login at a time.
     */
    if (user.password && belowPolicy(user.password)) {
      const upgraded = await hash(password, HASH_OPTIONS);
      await db.update(users).set({ password: upgraded }).where(eq(users.id, user.id));
    }

    await db.update(users).set({ last_login: new Date().toISOString() }).where(eq(users.id, user.id));

    return user;
  },

  /**
   * Changes a password, the current one having been proven.
   *
   * Not a password *reset*: there is no mail out of this deployment yet, so the
   * only way to change a password is to already know it. The reset by e-mail is
   * the missing half, and it needs an SMTP path before it needs code.
   */
  async changePassword(userId: number, current: string, next: string): Promise<boolean> {
    const user = await this.getById(userId);
    if (!user?.password) return false;
    if (!(await matches(user.password, current))) return false;

    await db
      .update(users)
      .set({ password: await hash(next, HASH_OPTIONS), last_modified: new Date().toISOString() })
      .where(eq(users.id, userId));

    return true;
  }
};
