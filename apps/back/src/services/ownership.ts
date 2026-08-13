import { eq, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { SessionUser } from '../types/fastify.js';

export function isAdmin(user: SessionUser): boolean {
  return user.role === 'admin' || user.role === 'super-admin';
}

/**
 * Replaces the old `checkUserRole(req)` helper. Admins see every row, everyone
 * else is scoped to their own; returning `undefined` for admins lets the caller
 * drop it straight into `and(...)`.
 */
export function ownerFilter(column: SQLiteColumn, user: SessionUser): SQL | undefined {
  return isAdmin(user) ? undefined : eq(column, user.id);
}

/**
 * Strips `undefined` values so a PATCH only touches the fields it sent. Drizzle
 * would otherwise reject an all-undefined `set()` object.
 */
export function definedOnly<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      result[key as keyof T] = value as T[keyof T];
    }
  }
  return result;
}

export function hasUpdates(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0;
}

export type { SQLWrapper };
