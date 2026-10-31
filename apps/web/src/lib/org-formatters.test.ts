import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatOrgOptionLabel, formatOrgTooltip } from './org-formatters';

describe('Organization Option Label & Tooltip Formatters (U1)', () => {
  const TEST_UUID = '01955b0a-7b3b-7411-9a4f-9e67d4f99999';

  describe('formatOrgOptionLabel', () => {
    it('formats resolved organization as "${name} (${slug})"', () => {
      const label = formatOrgOptionLabel(TEST_UUID, {
        name: 'Acme International',
        slug: 'acme',
      });
      assert.equal(label, 'Acme International (acme)');
    });

    it('falls back to "Organization ${id.slice(0, 8)}…" when organization is undefined', () => {
      const label = formatOrgOptionLabel(TEST_UUID, undefined);
      assert.equal(label, 'Organization 01955b0a…');
    });

    it('falls back to "Organization ${id.slice(0, 8)}…" when organization is null', () => {
      const label = formatOrgOptionLabel(TEST_UUID, null);
      assert.equal(label, 'Organization 01955b0a…');
    });

    it('falls back to "Organization ${id.slice(0, 8)}…" when name is empty string or whitespace', () => {
      const label = formatOrgOptionLabel(TEST_UUID, { name: '', slug: 'acme' });
      assert.equal(label, 'Organization 01955b0a…');
    });

    it('falls back to "Organization ${id.slice(0, 8)}…" when slug is empty string or whitespace', () => {
      const label = formatOrgOptionLabel(TEST_UUID, { name: 'Acme', slug: '' });
      assert.equal(label, 'Organization 01955b0a…');
    });

    it('handles short identifiers without throwing', () => {
      const label = formatOrgOptionLabel('org-1', undefined);
      assert.equal(label, 'Organization org-1…');
    });
  });

  describe('formatOrgTooltip', () => {
    it('returns "${name} (${slug})" for resolved organizations', () => {
      const tooltip = formatOrgTooltip(TEST_UUID, {
        name: 'Acme International',
        slug: 'acme',
      });
      assert.equal(tooltip, 'Acme International (acme)');
    });

    it('returns "Organization ID: ${id}" preserving the full UUID for unresolved organizations', () => {
      const tooltip = formatOrgTooltip(TEST_UUID, undefined);
      assert.equal(tooltip, `Organization ID: ${TEST_UUID}`);
    });

    it('returns "Organization ID: ${id}" when organization fields are missing', () => {
      const tooltip = formatOrgTooltip(TEST_UUID, { name: null, slug: null });
      assert.equal(tooltip, `Organization ID: ${TEST_UUID}`);
    });
  });
});
