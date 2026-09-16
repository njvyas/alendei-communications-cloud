import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES, PAGE_LIMITS, parseSort, type PageInfo, type SortSpec } from '@acc/contracts';
import { and, asc, desc, eq, gt, lt, or, type AnyColumn, type SQL } from 'drizzle-orm';

import { AppException } from '../errors/app.exception';
import type { CursorCodec } from './cursor';

/**
 * One sortable field, bound to the column that implements it.
 *
 * The map is the allow-list: a client names a key from it, never a column and
 * never an expression. That is the whole defence against order-by injection, and
 * it is structural — there is no code path that interpolates caller input into
 * SQL, so there is nothing to get wrong per endpoint.
 */
export interface SortableField {
  readonly column: AnyColumn;
  /** Renders this field's value from a row into the cursor. */
  readonly encode?: (row: Record<string, unknown>) => string;
  /**
   * Parses the cursor's string back into the value the column compares against.
   *
   * Needed because a cursor is text and a column is typed: a `timestamp` column
   * compares against a `Date`, and handing it the ISO string the cursor carries
   * fails in the driver rather than in SQL. Defaults to the string itself, which
   * is right for every text column.
   */
  readonly decode?: (raw: string) => unknown;
}

export interface ListQuerySpec {
  /** Sort key → column. The first entry is the default when no sort is given. */
  readonly sortable: Readonly<Record<string, SortableField>>;
  /** The default sort token, e.g. `-createdAt`. Must name a key in `sortable`. */
  readonly defaultSort: string;
  /**
   * The unique tie-breaker column, appended to every ordering.
   *
   * Without it two rows sharing a sort value have no defined order between
   * pages, and a row can be returned twice or skipped entirely as the plan
   * changes. Always the primary key.
   */
  readonly tieBreaker: AnyColumn;
}

export interface ListQueryInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export interface ResolvedListQuery {
  readonly limit: number;
  readonly sortToken: string;
  readonly spec: SortSpec;
  readonly orderBy: SQL[];
  /** Keyset predicate continuing after the cursor, or `undefined` on page one. */
  readonly after: SQL | undefined;
}

/**
 * Turns request input into a bounded, allow-listed, deterministic query plan
 * (`API.md` §8).
 *
 * Every endpoint's list behaviour goes through here so the conventions cannot
 * drift per resource — which is precisely how the pre-1B.5.8 API ended up with
 * five different collection shapes.
 */
export class ListQuery {
  constructor(private readonly cursors: CursorCodec) {}

  resolve(input: ListQueryInput, spec: ListQuerySpec): ResolvedListQuery {
    const sortToken = input.sort ?? spec.defaultSort;
    const parsed = parseSort(sortToken);

    const field = spec.sortable[parsed.field];
    if (!field) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Unsupported sort field',
        // The allowed keys are part of the published contract, so listing them
        // discloses nothing and makes the refusal actionable.
        details: {
          issues: [
            {
              field: 'sort',
              rule: 'SORT_NOT_ALLOWED',
              message: `sort must be one of: ${Object.keys(spec.sortable)
                .flatMap((k) => [k, `-${k}`])
                .join(', ')}`,
            },
          ],
        },
      });
    }

    const limit = this.clamp(input.limit);
    const direction = parsed.direction;
    const order = direction === 'desc' ? desc : asc;

    // The tie-breaker follows the sort field in the same direction, so the
    // composite ordering is total and the keyset predicate below matches it.
    const orderBy: SQL[] = [order(field.column), order(spec.tieBreaker)];

    let after: SQL | undefined;
    if (input.cursor) {
      const payload = this.cursors.decode(input.cursor, sortToken);
      const compare = direction === 'desc' ? lt : gt;

      const boundary = field.decode ? field.decode(payload.v ?? '') : payload.v;

      after =
        payload.v === undefined
          ? compare(spec.tieBreaker, payload.i)
          : // Row-wise continuation: strictly past the sort value, or equal to
            // it and strictly past the id. Written out rather than as a SQL row
            // comparison so it uses the composite index the same way the
            // ordering does — and so rows sharing a sort value are walked by the
            // tie-breaker rather than skipped.
            or(
              compare(field.column, boundary),
              and(eq(field.column, boundary), compare(spec.tieBreaker, payload.i)),
            );
    }

    return { limit, sortToken, spec: parsed, orderBy, after };
  }

  /**
   * Builds the page from one over-fetched row.
   *
   * `limit + 1` rows are read and the extra is discarded: that is what answers
   * `hasMore` without a second `COUNT(*)` over the same predicate, which no
   * current consumer needs and every page would otherwise pay for.
   */
  paginate<T extends Record<string, unknown>>(
    rows: readonly T[],
    resolved: ResolvedListQuery,
    spec: ListQuerySpec,
    idOf: (row: T) => string,
  ): { readonly items: readonly T[]; readonly page: PageInfo } {
    const hasMore = rows.length > resolved.limit;
    const items = hasMore ? rows.slice(0, resolved.limit) : rows;
    const last = items[items.length - 1];

    const sortable = spec.sortable[resolved.spec.field]!;
    const nextCursor =
      hasMore && last
        ? this.cursors.encode({
            s: resolved.sortToken,
            ...(sortable.encode ? { v: sortable.encode(last) } : {}),
            i: idOf(last),
          })
        : null;

    return { items, page: { nextCursor, hasMore, limit: resolved.limit } };
  }

  /** How many rows to read for a page: the page itself plus the probe row. */
  fetchSize(resolved: ResolvedListQuery): number {
    return resolved.limit + 1;
  }

  private clamp(limit: number | undefined): number {
    if (limit === undefined) return PAGE_LIMITS.DEFAULT;
    // Clamped rather than refused: a caller asking for 500 wants "as many as
    // possible", and a `400` there is pedantry. A caller asking for 0 or a
    // negative is a bug, and the DTO has already refused it.
    return Math.min(Math.max(limit, PAGE_LIMITS.MIN), PAGE_LIMITS.MAX);
  }
}
