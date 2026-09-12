import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Primary key: UUIDv7, time-sortable (`DATABASE.md` §1). `uuidv7()` is a plain
 * SQL function installed by the first migration, so no non-core extension is
 * required and ids are equally generable in the database or application-side.
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/** `created_at`/`updated_at` on every table (`DATABASE.md` §1). */
export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
