import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { users, type User } from '../db/schema.js';

const SALT_ROUNDS = 10;

/**
 * Migrated from bcryptjs to the native bcrypt binding. Hash formats are
 * interchangeable ($2a$ written by bcryptjs verifies fine here), so existing
 * passwords keep working.
 */
export const userService = {
  async getByLogin(login: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.login, login)).limit(1);
    return user;
  },

  async getById(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  },

  async create(login: string, password: string, email: string): Promise<User> {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
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
    return user;
  },

  async authenticate(login: string, password: string): Promise<User | null> {
    const user = await this.getByLogin(login);

    // Compare against a dummy hash when the login is unknown so that a missing
    // user and a wrong password take the same amount of time.
    const hash = user?.password ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const matches = await bcrypt.compare(password, hash);

    if (!user || !matches) {
      return null;
    }

    await db.update(users).set({ last_login: new Date().toISOString() }).where(eq(users.id, user.id));

    return user;
  }
};
