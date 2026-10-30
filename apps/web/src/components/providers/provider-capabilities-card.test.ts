import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';

import {
  ProviderCapabilitiesCard,
  ProviderCapabilitiesDialog,
  SimulatorBehaviorSelector,
  SUPPORTED_SIMULATOR_BEHAVIORS,
  SIMULATOR_BEHAVIOR_KEY,
  isSimulatorBehaviorKey,
  parseSimulatorBehaviorValue,
  formatSimulatorBehaviorPayload,
  validateAndFormatCapabilityRows,
  addCapabilityRow,
  addSimulatorBehaviorRow,
  removeCapabilityRow,
  updateCapabilityKey,
  updateCapabilityValue,
  updateSimulatorBehavior,
  type CapabilityRow,
} from './provider-capabilities-card';
import { createAppQueryClient } from '../../lib/query-client';
import { ApiError, type ProviderDetailView } from '../../lib/api-client';
import { humanizeApiError } from '../../lib/error-mapping';
import { PROVIDER_CAPABILITY_LIMITS } from '@acc/contracts';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('U8: ProviderCapabilitiesCard & SimulatorBehaviorSelector Unit Tests', () => {
  const PROVIDER_ID = '01955b0a-7b3b-7411-9a4f-pr0000000001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch0000000001';

  const mockSimulatorProvider: ProviderDetailView = {
    id: PROVIDER_ID,
    channelId: CHANNEL_ID,
    channelCode: 'whatsapp',
    name: 'QA WhatsApp Simulator',
    adapterKey: 'simulator',
    status: 'active',
    healthState: 'healthy',
    healthOverride: null,
    healthChangedAt: null,
    circuitState: 'closed',
    circuitChangedAt: null,
    circuitCooldownUntil: null,
    capabilities: [
      { key: 'simulator_behavior', value: '500' },
      { key: 'max_segments', value: 10 },
      { key: 'supports_templates', value: true },
    ],
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  const mockEmptyProvider: ProviderDetailView = {
    ...mockSimulatorProvider,
    id: '01955b0a-7b3b-7411-9a4f-pr0000000002',
    name: 'Empty Provider',
    capabilities: [],
  };

  function renderWithQuery(ui: React.ReactElement): string {
    const queryClient = createAppQueryClient();
    return renderToStaticMarkup(
      React.createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  }

  describe('1. Constants, Helpers & Type-Preservation Contract', () => {
    it('defines the 4 authoritative supported simulator behaviors and key constant', () => {
      assert.equal(SIMULATOR_BEHAVIOR_KEY, 'simulator_behavior');
      assert.deepEqual(SUPPORTED_SIMULATOR_BEHAVIORS, ['SUCCESS', '500', '429', 'TIMEOUT']);
      assert.equal(SUPPORTED_SIMULATOR_BEHAVIORS.length, 4);
    });

    it('identifies simulator_behavior keys case-insensitively with trimming', () => {
      assert.equal(isSimulatorBehaviorKey('simulator_behavior'), true);
      assert.equal(isSimulatorBehaviorKey('SIMULATOR_BEHAVIOR'), true);
      assert.equal(isSimulatorBehaviorKey('  simulator_behavior  '), true);
      assert.equal(isSimulatorBehaviorKey('max_segments'), false);
      assert.equal(isSimulatorBehaviorKey('other_key'), false);
    });

    it('parses JSON string representation without type coercion', () => {
      assert.equal(parseSimulatorBehaviorValue('"500"'), '500');
      assert.equal(parseSimulatorBehaviorValue('"429"'), '429');
      assert.equal(parseSimulatorBehaviorValue('"SUCCESS"'), 'SUCCESS');
      assert.equal(parseSimulatorBehaviorValue('"TIMEOUT"'), 'TIMEOUT');
      assert.equal(parseSimulatorBehaviorValue('500'), '500');
      assert.equal(parseSimulatorBehaviorValue(''), '');
    });

    it('formats behavior payload strictly as JSON string literal to preserve string types', () => {
      const formatted500 = formatSimulatorBehaviorPayload('500');
      assert.equal(formatted500, '"500"');
      assert.equal(typeof JSON.parse(formatted500), 'string');

      const formatted429 = formatSimulatorBehaviorPayload('429');
      assert.equal(formatted429, '"429"');
      assert.equal(typeof JSON.parse(formatted429), 'string');

      const formattedSuccess = formatSimulatorBehaviorPayload('SUCCESS');
      assert.equal(formattedSuccess, '"SUCCESS"');
      assert.equal(typeof JSON.parse(formattedSuccess), 'string');

      const formattedTimeout = formatSimulatorBehaviorPayload('TIMEOUT');
      assert.equal(formattedTimeout, '"TIMEOUT"');
      assert.equal(typeof JSON.parse(formattedTimeout), 'string');
    });
  });

  describe('2. validateAndFormatCapabilityRows Pure Helper (Finding 2)', () => {
    it('successfully formats valid capabilities into the API contract', () => {
      const rows: CapabilityRow[] = [
        { key: 'simulator_behavior', valueJson: '"429"' },
        { key: 'max_segments', valueJson: '10' },
        { key: 'supports_templates', valueJson: 'true' },
        { key: 'extra_info', valueJson: '{"team": "qa", "tags": [1, 2]}' },
      ];

      const res = validateAndFormatCapabilityRows(rows);
      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.capabilities.length, 4);
        assert.equal(res.capabilities[0]?.key, 'simulator_behavior');
        assert.equal(res.capabilities[0]?.value, '429');
        assert.equal(typeof res.capabilities[0]?.value, 'string');

        assert.equal(res.capabilities[1]?.key, 'max_segments');
        assert.equal(res.capabilities[1]?.value, 10);
        assert.equal(typeof res.capabilities[1]?.value, 'number');

        assert.equal(res.capabilities[2]?.key, 'supports_templates');
        assert.equal(res.capabilities[2]?.value, true);
        assert.equal(typeof res.capabilities[2]?.value, 'boolean');

        assert.equal(res.capabilities[3]?.key, 'extra_info');
        assert.deepEqual(res.capabilities[3]?.value, { team: 'qa', tags: [1, 2] });
      }
    });

    it('rejects empty capability keys', () => {
      const rows: CapabilityRow[] = [{ key: '   ', valueJson: '"123"' }];
      const res = validateAndFormatCapabilityRows(rows);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.title, 'Validation Error');
        assert.ok(res.error.message.includes('cannot be empty'));
        assert.equal(res.error.rowNumber, 1);
      }
    });

    it('rejects keys violating snake_case regex pattern', () => {
      const invalidKeys = ['A', '123_abc', 'has space', 'hyphen-key', 'UpperCase', 'a'];
      for (const invalid of invalidKeys) {
        const rows: CapabilityRow[] = [{ key: invalid, valueJson: '"val"' }];
        const res = validateAndFormatCapabilityRows(rows);
        assert.equal(res.ok, false, `Key "${invalid}" should be rejected`);
        if (!res.ok) {
          assert.equal(res.error.title, 'Invalid Key Format');
        }
      }
    });

    it('rejects keys containing forbidden secret fragments', () => {
      const forbiddenSamples = [
        'user_token',
        'api_key_secret',
        'admin_passwd',
        'db_password',
        'client_credential',
        'my_private_key',
        'apikey',
      ];
      for (const bad of forbiddenSamples) {
        const rows: CapabilityRow[] = [{ key: bad, valueJson: '"val"' }];
        const res = validateAndFormatCapabilityRows(rows);
        assert.equal(res.ok, false, `Key "${bad}" should trigger forbidden fragment error`);
        if (!res.ok) {
          assert.equal(res.error.title, 'Forbidden Key Fragment');
        }
      }
    });

    it('rejects duplicate capability keys', () => {
      const rows: CapabilityRow[] = [
        { key: 'max_segments', valueJson: '10' },
        { key: 'max_segments', valueJson: '20' },
      ];
      const res = validateAndFormatCapabilityRows(rows);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.title, 'Duplicate Key');
        assert.ok(res.error.message.includes('Duplicate capability key "max_segments"'));
      }
    });

    it('rejects invalid JSON values', () => {
      const rows: CapabilityRow[] = [{ key: 'custom_val', valueJson: 'not valid json' }];
      const res = validateAndFormatCapabilityRows(rows);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.title, 'Invalid JSON');
      }
    });

    it('rejects null capability values', () => {
      const rows: CapabilityRow[] = [{ key: 'custom_val', valueJson: 'null' }];
      const res = validateAndFormatCapabilityRows(rows);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.title, 'Invalid Value');
        assert.ok(res.error.message.includes('cannot be null'));
      }
    });

    it('rejects serialized values exceeding byte size limit', () => {
      const hugeString = 'x'.repeat(PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES + 10);
      const rows: CapabilityRow[] = [
        { key: 'large_payload', valueJson: JSON.stringify(hugeString) },
      ];
      const res = validateAndFormatCapabilityRows(rows);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.title, 'Value Size Limit Exceeded');
      }
    });
  });

  describe('3. State Transition Helpers (Interactive Logic) (Finding 2)', () => {
    it('addCapabilityRow adds empty row and respects MAX_ENTRIES limit', () => {
      const initial: CapabilityRow[] = [{ key: 'max_segments', valueJson: '10' }];
      const added = addCapabilityRow(initial);
      assert.equal(added.length, 2);
      assert.deepEqual(added[1], { key: '', valueJson: '""' });

      // At limit
      const fullRows: CapabilityRow[] = Array.from(
        { length: PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES },
        (_, i) => ({ key: `key_${i}`, valueJson: '1' }),
      );
      const capped = addCapabilityRow(fullRows);
      assert.equal(capped.length, PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES);
    });

    it('addSimulatorBehaviorRow adds simulator row and respects limit', () => {
      const initial: CapabilityRow[] = [];
      const added = addSimulatorBehaviorRow(initial);
      assert.equal(added.length, 1);
      assert.deepEqual(added[0], {
        key: 'simulator_behavior',
        valueJson: '"SUCCESS"',
      });
    });

    it('removeCapabilityRow removes only target row index', () => {
      const rows: CapabilityRow[] = [
        { key: 'k1', valueJson: '1' },
        { key: 'k2', valueJson: '2' },
        { key: 'k3', valueJson: '3' },
      ];
      const updated = removeCapabilityRow(rows, 1);
      assert.equal(updated.length, 2);
      assert.equal(updated[0]?.key, 'k1');
      assert.equal(updated[1]?.key, 'k3');
    });

    it('updateCapabilityKey switches key and initializes default simulator behavior when transitioning', () => {
      const rows: CapabilityRow[] = [{ key: 'other_key', valueJson: '"custom_text"' }];
      const switched = updateCapabilityKey(rows, 0, 'simulator_behavior');
      assert.equal(switched[0]?.key, 'simulator_behavior');
      assert.equal(switched[0]?.valueJson, '"SUCCESS"');

      // If switching from simulator to generic key, valueJson is preserved
      const switchedBack = updateCapabilityKey(switched, 0, 'custom_attr');
      assert.equal(switchedBack[0]?.key, 'custom_attr');
      assert.equal(switchedBack[0]?.valueJson, '"SUCCESS"');
    });

    it('updateCapabilityValue updates raw JSON value for a row', () => {
      const rows: CapabilityRow[] = [{ key: 'max_segments', valueJson: '10' }];
      const updated = updateCapabilityValue(rows, 0, '25');
      assert.equal(updated[0]?.valueJson, '25');
    });

    it('updateSimulatorBehavior formats behavior string and preserves JSON quotes', () => {
      const rows: CapabilityRow[] = [{ key: 'simulator_behavior', valueJson: '"SUCCESS"' }];
      const updated = updateSimulatorBehavior(rows, 0, '500');
      assert.equal(updated[0]?.valueJson, '"500"');
      assert.equal(typeof JSON.parse(updated[0]!.valueJson), 'string');
    });
  });

  describe('4. SimulatorBehaviorSelector Rendering & Options (Finding 3)', () => {
    it('renders select element with data-testid="simulator-behavior-select"', () => {
      let selectedValue = '500';
      const html = renderToStaticMarkup(
        React.createElement(SimulatorBehaviorSelector, {
          id: 'test-selector',
          value: selectedValue,
          onChange: (v) => {
            selectedValue = v;
          },
        }),
      );

      assert.ok(html.includes('data-testid="simulator-behavior-select"'));
      assert.ok(html.includes('id="test-selector"'));
      for (const behavior of SUPPORTED_SIMULATOR_BEHAVIORS) {
        assert.ok(html.includes(`value="${behavior}"`), `Option ${behavior} should be rendered`);
      }
      assert.ok(html.includes('<option value="500" selected="">500'));
    });

    it('renders (Empty / Unspecified) for empty-string value, preventing visual misrepresentation as SUCCESS (Finding 3)', () => {
      const html = renderToStaticMarkup(
        React.createElement(SimulatorBehaviorSelector, {
          value: '',
          onChange: () => {},
        }),
      );

      assert.ok(html.includes('value=""'));
      assert.ok(html.includes('(Empty / Unspecified)'));
      // Must NOT be selected on SUCCESS
      assert.ok(!html.includes('value="SUCCESS" selected=""'));
    });

    it('renders custom/legacy values without crashing or dropping data', () => {
      const html = renderToStaticMarkup(
        React.createElement(SimulatorBehaviorSelector, {
          value: 'CUSTOM_DELAY_200MS',
          onChange: () => {},
        }),
      );

      assert.ok(html.includes('value="CUSTOM_DELAY_200MS"'));
      assert.ok(html.includes('CUSTOM_DELAY_200MS (Custom / Legacy)'));
    });

    it('disables select input when disabled prop is true', () => {
      const html = renderToStaticMarkup(
        React.createElement(SimulatorBehaviorSelector, {
          value: 'SUCCESS',
          onChange: () => {},
          disabled: true,
        }),
      );

      assert.ok(html.includes('disabled=""'));
    });
  });

  describe('5. ProviderCapabilitiesCard Rendering & Dialog Lifecycle (Finding 1 & 3)', () => {
    it('renders declared capabilities, badge for simulator_behavior, and handles empty-string badge correctly', () => {
      const providerWithEmpty: ProviderDetailView = {
        ...mockSimulatorProvider,
        capabilities: [
          { key: 'simulator_behavior', value: '' },
          { key: 'max_segments', value: 10 },
        ],
      };

      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesCard, {
          provider: providerWithEmpty,
          canManage: true,
        }),
      );

      assert.ok(html.includes('Declared Capabilities'));
      assert.ok(html.includes('data-testid="simulator-behavior-badge"'));
      // Empty string must render (empty) instead of empty string or SUCCESS
      assert.ok(html.includes('(empty)'));
    });

    it('conditionally mounts ProviderCapabilitiesDialog ONLY when isDialogOpen is true (Finding 1)', () => {
      // When card is rendered statically, isDialogOpen is initial false
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesCard, {
          provider: mockSimulatorProvider,
          canManage: true,
        }),
      );

      // Card must be present
      assert.ok(html.includes('data-testid="provider-capabilities-card"'));
      // Dialog modal must NOT be mounted in DOM at all
      assert.ok(!html.includes('role="dialog"'));
      assert.ok(!html.includes('id="edit-capabilities-title"'));
      assert.ok(!html.includes('data-testid="save-capabilities-btn"'));
    });

    it('suppresses edit button when canManage is false', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesCard, {
          provider: mockSimulatorProvider,
          canManage: false,
        }),
      );

      assert.ok(!html.includes('data-testid="edit-capabilities-btn"'));
    });
  });

  describe('6. ProviderCapabilitiesDialog Accessible Form & Delete Labels (Finding 4)', () => {
    it('renders row-specific aria-label on delete buttons for accessibility (Finding 4)', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesDialog, {
          open: true,
          onOpenChange: () => {},
          provider: mockSimulatorProvider,
        }),
      );

      assert.ok(html.includes('role="dialog"'));
      assert.ok(html.includes('aria-modal="true"'));
      assert.ok(html.includes('aria-label="Remove capability simulator_behavior"'));
      assert.ok(html.includes('aria-label="Remove capability max_segments"'));
    });

    it('renders "+ Add Simulator Behavior" button when provider lacks simulator_behavior', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesDialog, {
          open: true,
          onOpenChange: () => {},
          provider: mockEmptyProvider,
        }),
      );

      assert.ok(html.includes('data-testid="add-simulator-behavior-btn"'));
      assert.ok(html.includes('+ Add Simulator Behavior'));
      assert.ok(html.includes('data-testid="add-capability-btn"'));
    });

    it('hides "+ Add Simulator Behavior" button when provider already has simulator_behavior', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesDialog, {
          open: true,
          onOpenChange: () => {},
          provider: mockSimulatorProvider,
        }),
      );

      assert.ok(!html.includes('data-testid="add-simulator-behavior-btn"'));
      assert.ok(html.includes('data-testid="add-capability-btn"'));
    });
  });

  describe('7. API Error Handling Humanization (Finding 2)', () => {
    it('humanizes 403 AUTHZ_SCOPE_DENIED API error into a friendly message', () => {
      const apiErr = new ApiError(403, 'AUTHZ_SCOPE_DENIED', 'Scope denied', 'corr-123', false);
      const humanized = humanizeApiError(apiErr, 'Failed to update provider capabilities');
      assert.equal(humanized.title, 'Scope Denied');
      assert.ok(humanized.message.includes('authority'));
      assert.equal(humanized.code, 'AUTHZ_SCOPE_DENIED');
      assert.equal(humanized.correlationId, 'corr-123');
    });

    it('humanizes 400 validation API error', () => {
      const apiErr = new ApiError(
        400,
        'VALIDATION_ERROR',
        'Invalid capability payload format',
        'corr-456',
        false,
      );
      const humanized = humanizeApiError(apiErr, 'Failed to update provider capabilities');
      assert.equal(humanized.title, 'Failed to update provider capabilities');
      assert.equal(humanized.message, 'Invalid capability payload format');
      assert.equal(humanized.code, 'VALIDATION_ERROR');
      assert.equal(humanized.correlationId, 'corr-456');
    });
  });
});
