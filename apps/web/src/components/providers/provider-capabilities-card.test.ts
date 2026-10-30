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
} from './provider-capabilities-card';
import { createAppQueryClient } from '../../lib/query-client';
import type { ProviderDetailView } from '../../lib/api-client';

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
      // If raw string without quotes was somehow supplied
      assert.equal(parseSimulatorBehaviorValue('500'), '500');
    });

    it('formats behavior payload strictly as JSON string literal to preserve string types', () => {
      // Issue #36: "500", "429", and "true" must remain JSON strings, not numbers or booleans
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

  describe('2. SimulatorBehaviorSelector Rendering & Options', () => {
    it('renders a select element with data-testid="simulator-behavior-select"', () => {
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
      // All 4 supported values should appear as options
      for (const behavior of SUPPORTED_SIMULATOR_BEHAVIORS) {
        assert.ok(html.includes(`value="${behavior}"`), `Option ${behavior} should be rendered`);
      }
      // Value 500 should be selected
      assert.ok(html.includes('<option value="500" selected="">500'));
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

  describe('3. ProviderCapabilitiesCard Rendering', () => {
    it('renders declared capabilities and special badge for simulator_behavior', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesCard, {
          provider: mockSimulatorProvider,
          canManage: true,
        }),
      );

      assert.ok(html.includes('Declared Capabilities'));
      assert.ok(html.includes('Non-secret provider adapter attributes'));
      assert.ok(html.includes('data-testid="edit-capabilities-btn"'));

      // Check capabilities items
      assert.ok(html.includes('data-testid="capability-item-simulator_behavior"'));
      assert.ok(html.includes('data-testid="simulator-behavior-badge"'));
      assert.ok(html.includes('500'));

      // Other capabilities
      assert.ok(html.includes('data-testid="capability-item-max_segments"'));
      assert.ok(html.includes('10'));
      assert.ok(html.includes('data-testid="capability-item-supports_templates"'));
      assert.ok(html.includes('true'));
    });

    it('renders empty state when provider has zero capabilities', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesCard, {
          provider: mockEmptyProvider,
          canManage: true,
        }),
      );

      assert.ok(html.includes('data-testid="capabilities-empty-state"'));
      assert.ok(html.includes('No capabilities declared for this provider.'));
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

  describe('4. ProviderCapabilitiesDialog Accessible Form & Row Structure', () => {
    it('renders accessible dialog with title, description, and simulator behavior controls', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesDialog, {
          open: true,
          onOpenChange: () => {},
          provider: mockSimulatorProvider,
        }),
      );

      assert.ok(html.includes('role="dialog"'));
      assert.ok(html.includes('aria-modal="true"'));
      assert.ok(html.includes('id="edit-capabilities-title"'));
      assert.ok(html.includes('Edit Capabilities — QA WhatsApp Simulator'));

      // Renders simulator_behavior row with dedicated selector
      assert.ok(html.includes('data-testid="capability-row-simulator_behavior"'));
      assert.ok(html.includes('Simulator Control'));
      assert.ok(html.includes('data-testid="simulator-behavior-select"'));

      // Renders standard textarea for other capabilities
      assert.ok(html.includes('data-testid="capability-row-max_segments"'));
      assert.ok(html.includes('Value (JSON)'));

      // Save button exists
      assert.ok(html.includes('data-testid="save-capabilities-btn"'));
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

      // Provider already has simulator_behavior, so button to add a second one is hidden
      assert.ok(!html.includes('data-testid="add-simulator-behavior-btn"'));
      assert.ok(html.includes('data-testid="add-capability-btn"'));
    });

    it('returns null when dialog open prop is false', () => {
      const html = renderWithQuery(
        React.createElement(ProviderCapabilitiesDialog, {
          open: false,
          onOpenChange: () => {},
          provider: mockSimulatorProvider,
        }),
      );

      assert.equal(html, '');
    });
  });
});
