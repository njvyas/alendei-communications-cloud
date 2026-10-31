/**
 * U10 real-browser harness.
 *
 * Mounts the production dialog code (`useModalDialog`, `AccessibleDialog`,
 * `ProviderTransitionDialog`, `ProviderCreateDialog`) outside the Next.js app so
 * keyboard and focus behaviour can be exercised in real browsers without the
 * API, database or a login. It is bundled by `u10-dialogs.spec.ts` with esbuild
 * and served through Playwright request routing; API calls are mocked there.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import { AccessibleDialog } from '../../src/components/ui/dialog';
import { ProviderCreateDialog } from '../../src/components/providers/provider-create-dialog';
import { ProviderTransitionDialog } from '../../src/components/providers/provider-transition-dialog';
import { createAppQueryClient } from '../../src/lib/query-client';
import type { ProviderDetailView } from '../../src/lib/api-client';

const PROVIDER: ProviderDetailView = {
  id: '01955b0a-7b3b-7411-9a4f-000000000001',
  channelId: '01955b0a-7b3b-7411-9a4f-000000000002',
  channelCode: 'sms',
  name: 'U10 Harness Provider',
  adapterKey: 'simulator',
  status: 'active',
  healthState: 'healthy',
  healthOverride: null,
  healthChangedAt: null,
  circuitState: 'closed',
  circuitChangedAt: null,
  circuitCooldownUntil: null,
  capabilities: [],
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

type Scenario = 'transition' | 'create' | 'nested' | 'disabled' | 'permanent' | null;

function Harness() {
  const [scenario, setScenario] = useState<Scenario>(null);
  const [childOpen, setChildOpen] = useState(false);
  const [permanentMounted, setPermanentMounted] = useState(true);
  const close = () => setScenario(null);

  // Test hook: unmount the always-open dialog without closing it first.
  (window as unknown as { __u10Unmount: () => void }).__u10Unmount = () =>
    setPermanentMounted(false);

  return (
    <main>
      <h1>U10 dialog harness</h1>
      <p>
        <button type="button" id="outside">
          Page button outside dialogs
        </button>
      </p>
      <p>
        <button type="button" onClick={() => setScenario('transition')}>
          Open transition dialog
        </button>{' '}
        <button type="button" onClick={() => setScenario('create')}>
          Open create dialog
        </button>{' '}
        <button type="button" onClick={() => setScenario('nested')}>
          Open parent dialog
        </button>{' '}
        <button type="button" onClick={() => setScenario('disabled')}>
          Open disabled dialog
        </button>{' '}
        <button type="button" onClick={() => setScenario('permanent')}>
          Open unmount dialog
        </button>
      </p>

      <ProviderTransitionDialog
        open={scenario === 'transition'}
        onOpenChange={(open) => !open && close()}
        provider={PROVIDER}
        transition="disable"
      />

      <ProviderCreateDialog
        open={scenario === 'create'}
        onOpenChange={(open) => !open && close()}
      />

      <AccessibleDialog isOpen={scenario === 'nested'} onClose={close} titleId="parent-title">
        <h2 id="parent-title">Parent dialog</h2>
        <label htmlFor="parent-input">Parent field</label>
        <input id="parent-input" />
        <button type="button" onClick={() => setChildOpen(true)}>
          Open child dialog
        </button>
        <button type="button" onClick={close}>
          Close parent
        </button>
        <AccessibleDialog
          isOpen={childOpen}
          onClose={() => setChildOpen(false)}
          titleId="child-title"
        >
          <h2 id="child-title">Child dialog</h2>
          <button type="button">Child first</button>
          <button type="button" onClick={() => setChildOpen(false)}>
            Child last
          </button>
        </AccessibleDialog>
      </AccessibleDialog>

      <AccessibleDialog isOpen={scenario === 'disabled'} onClose={close} titleId="disabled-title">
        <h2 id="disabled-title">All controls disabled</h2>
        <button type="button" disabled>
          Disabled save
        </button>
        <button type="button" disabled>
          Disabled cancel
        </button>
      </AccessibleDialog>

      {permanentMounted && (
        <AccessibleDialog
          isOpen={scenario === 'permanent'}
          onClose={close}
          titleId="permanent-title"
        >
          <h2 id="permanent-title">Unmount dialog</h2>
          <button type="button">Only button</button>
        </AccessibleDialog>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={createAppQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}
