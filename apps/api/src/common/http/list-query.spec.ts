import { PAGE_LIMITS } from '@acc/contracts';
import { schema } from '@acc/db';

import { CursorCodec } from './cursor';
import { ListQuery, type ListQuerySpec } from './list-query';

/**
 * `ListQuery`'s bounds and allow-listing, asserted directly.
 *
 * The HTTP suite proves the DTO refuses an out-of-range `limit` before this code
 * runs, which means the clamp below is unreachable from a request — and
 * therefore invisible to an end-to-end test. It is still the guarantee for any
 * non-HTTP caller (a job, a future internal API) that reaches `ListQuery`
 * without passing through a DTO, so it is asserted where it can be.
 */
describe('ListQuery', () => {
  const spec: ListQuerySpec = {
    sortable: {
      key: { column: schema.roles.key, encode: (row) => String(row.key) },
      createdAt: { column: schema.roles.createdAt },
    },
    defaultSort: 'key',
    tieBreaker: schema.roles.id,
  };

  const lists = new ListQuery(new CursorCodec('a-test-signing-secret'));

  it('defaults the page size', () => {
    expect(lists.resolve({}, spec).limit).toBe(PAGE_LIMITS.DEFAULT);
  });

  it('clamps a limit above the maximum', () => {
    expect(lists.resolve({ limit: 10_000 }, spec).limit).toBe(PAGE_LIMITS.MAX);
  });

  it('clamps a limit below the minimum', () => {
    expect(lists.resolve({ limit: 0 }, spec).limit).toBe(PAGE_LIMITS.MIN);
    expect(lists.resolve({ limit: -5 }, spec).limit).toBe(PAGE_LIMITS.MIN);
  });

  it('reads one row beyond the page, to answer hasMore without a COUNT', () => {
    const resolved = lists.resolve({ limit: 10 }, spec);
    expect(lists.fetchSize(resolved)).toBe(11);
  });

  it('orders by the sort field and then the tie-breaker, never the field alone', () => {
    // Two terms, always. One term leaves rows sharing a sort value in an
    // undefined order between pages, which is how a keyset scheme silently
    // skips or repeats.
    expect(lists.resolve({ sort: 'key' }, spec).orderBy).toHaveLength(2);
    expect(lists.resolve({ sort: '-createdAt' }, spec).orderBy).toHaveLength(2);
  });

  it('refuses a sort field that is not on the allow-list', () => {
    expect(() => lists.resolve({ sort: 'orgId' }, spec)).toThrow();
    expect(() => lists.resolve({ sort: 'id; DROP TABLE roles' }, spec)).toThrow();
  });

  it('defaults to the spec’s sort when none is given', () => {
    expect(lists.resolve({}, spec).sortToken).toBe('key');
    expect(lists.resolve({}, spec).spec).toEqual({ field: 'key', direction: 'asc' });
  });

  it('parses the descending prefix', () => {
    expect(lists.resolve({ sort: '-key' }, spec).spec).toEqual({
      field: 'key',
      direction: 'desc',
    });
  });

  it('page one carries no keyset predicate', () => {
    expect(lists.resolve({}, spec).after).toBeUndefined();
  });
});
