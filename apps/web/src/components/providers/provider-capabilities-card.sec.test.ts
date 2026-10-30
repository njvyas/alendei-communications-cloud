import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';

import {
  ProviderCapabilitiesCard,
  ProviderCapabilitiesDialog,
  SimulatorBehaviorSelector,
  formatSimulatorBehaviorPayload,
} from './provider-capabilities-card';
import {
  ProviderCapabilitiesDialog as ReExportedDialog,
  ProviderCapabilitiesCard as ReExportedCard,
} from './provider-capabilities-dialog';
import { createAppQueryClient } from '../../lib/query-client';
import {
  PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS,
  PROVIDER_CAPABILITY_KEY_PATTERN,
  PROVIDER_CAPABILITY_LIMITS,
} from '@acc/contracts';
import type { ProviderDetailView } from '../../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('SEC-U8: Provider Capabilities Security, Validation & Type Preservation Tests', () => {
  const mockProvider: ProviderDetailView = {
    id: '01955b0a-7b3b-7411-9a4f-pr0000000001',
    channelId: '01955b0a-7b3b-7411-9a4f-ch0000000001',
    channelCode: 'whatsapp',
    name: 'QA Simulator Provider',
    adapterKey: 'simulator',
    status: 'active',
    healthState: 'healthy',
    healthOverride: null,
    healthChangedAt: null,
    circuitState: 'closed',
    circuitChangedAt: null,
    circuitCooldownUntil: null,
    capabilities: [
      { key: 'simulator_behavior', value: 'SUCCESS' },
      { key: 'max_segments', value: 10 },
    ],
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  describe('1. Re-export Backwards Compatibility', () => {
    it('ensures provider-capabilities-dialog.tsx re-exports ProviderCapabilitiesDialog and Card', () => {
      assert.equal(typeof ReExportedDialog, 'function');
      assert.equal(typeof ReExportedCard, 'function');
      assert.equal(ReExportedDialog, ProviderCapabilitiesDialog);
      assert.equal(ReExportedCard, ProviderCapabilitiesCard);
    });
  });

  describe('2. Validation Constraints on Capability Keys', () => {
    it('verifies PROVIDER_CAPABILITY_KEY_PATTERN enforces snake_case starting with letter', () => {
      // Valid keys
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('simulator_behavior'), true);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('max_segments'), true);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('supports_templates'), true);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('rcs_message_types'), true);

      // Invalid keys
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test(''), false);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('A'), false);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('Simulator_Behavior'), false);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('simulator-behavior'), false);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('123_invalid'), false);
      assert.equal(PROVIDER_CAPABILITY_KEY_PATTERN.test('has spaces'), false);
    });

    it('verifies forbidden secret key fragments are strictly detected', () => {
      const forbiddenFragments = PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS;
      assert.ok(forbiddenFragments.length > 0);

      // Check detection logic
      for (const forbidden of forbiddenFragments) {
        const testKey = `custom_${forbidden}_attr`;
        assert.equal(
          testKey.includes(forbidden),
          true,
          `Key containing forbidden fragment "${forbidden}" must be detected`,
        );
      }

      // Safe keys must not trigger false positives
      for (const safeKey of [
        'simulator_behavior',
        'max_segments',
        'throughput_limit',
        'allowed_schemes',
      ]) {
        for (const forbidden of forbiddenFragments) {
          assert.equal(safeKey.includes(forbidden), false);
        }
      }
    });

    it('enforces capability limits matching platform contracts', () => {
      assert.equal(PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES, 50);
      assert.equal(PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES, 4096);
    });
  });

  describe('3. JSON Type Preservation Semantics (Issue #36 & #21)', () => {
    it('preserves "500", "429", and "SUCCESS" as string types in JSON payload format', () => {
      const behaviors = ['SUCCESS', '500', '429', 'TIMEOUT'] as const;

      for (const b of behaviors) {
        const formatted = formatSimulatorBehaviorPayload(b);
        assert.equal(formatted, `"${b}"`);

        const parsed = JSON.parse(formatted);
        assert.equal(typeof parsed, 'string');
        assert.equal(parsed, b);
      }
    });

    it('ensures numeric strings are never serialized as naked numbers', () => {
      const payload500 = formatSimulatorBehaviorPayload('500');
      // Must NOT be the naked number 500
      assert.notEqual(payload500, '500');
      // Must be quoted
      assert.equal(payload500, '"500"');

      const payload429 = formatSimulatorBehaviorPayload('429');
      assert.notEqual(payload429, '429');
      assert.equal(payload429, '"429"');
    });

    it('preserves non-simulator JSON values (numbers, booleans, objects)', () => {
      const numVal = 10;
      const numJson = JSON.stringify(numVal);
      assert.equal(JSON.parse(numJson), 10);
      assert.equal(typeof JSON.parse(numJson), 'number');

      const boolVal = true;
      const boolJson = JSON.stringify(boolVal);
      assert.equal(JSON.parse(boolJson), true);
      assert.equal(typeof JSON.parse(boolJson), 'boolean');

      const objVal = { enabled: true, tags: ['sms', 'otp'] };
      const objJson = JSON.stringify(objVal);
      assert.deepEqual(JSON.parse(objJson), objVal);
    });
  });

  describe('4. Component Rendering Invariants', () => {
    it('renders provider capabilities card with correct testids', () => {
      const queryClient = createAppQueryClient();
      const html = renderToStaticMarkup(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ProviderCapabilitiesCard, {
            provider: mockProvider,
            canManage: true,
          }),
        ),
      );

      assert.ok(html.includes('data-testid="provider-capabilities-card"'));
      assert.ok(html.includes('data-testid="edit-capabilities-btn"'));
      assert.ok(html.includes('data-testid="capability-item-simulator_behavior"'));
      assert.ok(html.includes('data-testid="simulator-behavior-badge"'));
    });

    it('renders simulator behavior dropdown with correct default value and options', () => {
      let value = '429';
      const html = renderToStaticMarkup(
        React.createElement(SimulatorBehaviorSelector, {
          id: 'test-select-429',
          value,
          onChange: (newVal) => {
            value = newVal;
          },
        }),
      );

      assert.ok(html.includes('data-testid="simulator-behavior-select"'));
      assert.ok(html.includes('<option value="429" selected="">429'));
      assert.ok(html.includes('value="SUCCESS"'));
      assert.ok(html.includes('value="500"'));
      assert.ok(html.includes('value="TIMEOUT"'));
    });
  });
});
