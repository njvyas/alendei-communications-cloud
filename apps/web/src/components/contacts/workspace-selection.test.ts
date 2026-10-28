import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTACTS_PAGE_SIZE,
  CONTACTS_SORT,
  EMPTY_PAGER,
  contactsListParams,
  cursorStackFor,
  resolveActiveWorkspaceId,
} from './workspace-selection';

// Contacts page workspace selection must follow the active organization: a
// workspace id kept from a previous organization is never queried.
describe('Contacts workspace selection and pagination', () => {
  const ORG_A_WS_1 = '01955b0a-7b3b-7411-9a4f-9e67d4f9a001';
  const ORG_A_WS_2 = '01955b0a-7b3b-7411-9a4f-9e67d4f9a002';
  const ORG_B_WS_1 = '01955b0a-7b3b-7411-9a4f-9e67d4f9b001';
  const orgAWorkspaces = [{ id: ORG_A_WS_1 }, { id: ORG_A_WS_2 }];
  const orgBWorkspaces = [{ id: ORG_B_WS_1 }];

  it('1. keeps a selection that belongs to the active organization', () => {
    assert.equal(resolveActiveWorkspaceId(ORG_A_WS_2, orgAWorkspaces), ORG_A_WS_2);
  });

  it('2. replaces a workspace from another organization with the first of the active one', () => {
    assert.equal(resolveActiveWorkspaceId(ORG_A_WS_2, orgBWorkspaces), ORG_B_WS_1);
  });

  it('3. defaults to the first workspace when nothing is selected', () => {
    assert.equal(resolveActiveWorkspaceId('', orgAWorkspaces), ORG_A_WS_1);
  });

  it('4. resolves to none when the organization has no workspaces (or they are not loaded)', () => {
    assert.equal(resolveActiveWorkspaceId(ORG_A_WS_1, []), '');
    assert.equal(resolveActiveWorkspaceId('', []), '');
  });

  it('5. pagination built for one workspace starts at the first page for another', () => {
    const pager = { workspaceId: ORG_A_WS_2, cursorStack: ['c2', 'c3'] };
    assert.deepEqual(cursorStackFor(pager, ORG_A_WS_2), ['c2', 'c3']);
    assert.deepEqual(cursorStackFor(pager, ORG_B_WS_1), []);
    assert.deepEqual(cursorStackFor(pager, ''), []);
    assert.deepEqual(cursorStackFor(EMPTY_PAGER, ORG_A_WS_1), []);
  });
});

// #30 (QAF-019): the list is requested newest first, so a contact just created
// is at the top of the first page.
describe('Contacts list order (#30)', () => {
  it('1. requests the first page newest first at the fixed page size', () => {
    assert.deepEqual(contactsListParams(undefined), {
      cursor: undefined,
      limit: 25,
      sort: '-createdAt',
    });
  });

  it('2. keeps the same order and size when following a cursor', () => {
    assert.deepEqual(contactsListParams('c2'), { cursor: 'c2', limit: 25, sort: '-createdAt' });
  });

  it('3. uses the descending form of the contract sort field', () => {
    assert.equal(CONTACTS_SORT, '-createdAt');
    assert.equal(CONTACTS_PAGE_SIZE, 25);
  });
});
