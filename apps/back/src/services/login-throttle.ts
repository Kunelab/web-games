/**
 * Failed-login accounting, per account rather than per address.
 *
 * The rate limit on the route counts requests from one IP, which is the right
 * shape for a clumsy typist and the wrong one for somebody who wants in: two
 * hundred addresses at ten a minute is two thousand guesses a minute against one
 * account, and nothing on the route notices. This counts the account instead, so
 * the guessing is throttled wherever it comes from.
 *
 * Deliberately *not* a lockout. Locking an account after N failures hands anyone
 * who knows a login a way to keep its owner out for free, which trades a slow
 * attack for a free one. A delay that doubles costs an attacker everything and
 * costs the owner a few seconds they spend reading their password manager.
 *
 * In memory, because the server is one process and the whole point is to be
 * cheap. A restart forgives everyone, which is a real hole and a small one: it
 * takes the attacker a restart of a server they do not control.
 */

/** Free attempts before the delay starts. Room for a typo and a caps-lock. */
const FREE_ATTEMPTS = 5;

/** The delay doubles per failure past the free ones, up to this. */
const MAX_DELAY_MS = 15 * 60 * 1000;

const FIRST_DELAY_MS = 1000;

/** An account nobody has failed on for this long is forgotten entirely. */
const FORGET_MS = 60 * 60 * 1000;

/**
 * Cap on tracked accounts, so a flood of invented logins cannot grow this map
 * until the process dies. When it is hit the oldest entries go: an attacker who
 * evicts their own record has to start the doubling again from zero, which is
 * not a win for them.
 */
const MAX_TRACKED = 10_000;

interface Attempts {
  failures: number;
  /** Nothing is even checked before this instant. */
  blockedUntil: number;
  lastFailureAt: number;
}

const attempts = new Map<string, Attempts>();

/** Same account, whatever case it was typed in. */
function key(login: string): string {
  return login.trim().toLowerCase();
}

function sweep(now: number): void {
  for (const [name, record] of attempts) {
    if (now - record.lastFailureAt > FORGET_MS) attempts.delete(name);
  }

  if (attempts.size <= MAX_TRACKED) return;
  const oldest = [...attempts.entries()]
    .sort((left, right) => left[1].lastFailureAt - right[1].lastFailureAt)
    .slice(0, attempts.size - MAX_TRACKED);
  for (const [name] of oldest) attempts.delete(name);
}

/**
 * How much longer this account is refused, in milliseconds. 0 means go ahead.
 *
 * Checked before the password is verified, so a throttled account costs no
 * argon2 work at all — which is the second reason this exists: 19 MiB and two
 * passes per guess is a denial of service the attacker gets for free otherwise.
 */
export function loginBlockedFor(login: string, now = Date.now()): number {
  const record = attempts.get(key(login));
  if (!record) return 0;
  return Math.max(0, record.blockedUntil - now);
}

export function noteLoginFailure(login: string, now = Date.now()): void {
  const name = key(login);
  const record = attempts.get(name) ?? { failures: 0, blockedUntil: 0, lastFailureAt: now };

  record.failures += 1;
  record.lastFailureAt = now;

  const over = record.failures - FREE_ATTEMPTS;
  if (over > 0) {
    record.blockedUntil = now + Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (over - 1));
  }

  attempts.set(name, record);
  sweep(now);
}

/** A password that worked clears the account's record entirely. */
export function noteLoginSuccess(login: string): void {
  attempts.delete(key(login));
}

/** Test seam: the map outlives a single case otherwise. */
export function resetLoginThrottle(): void {
  attempts.clear();
}
