import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import RolesPage from '../../app/(console)/roles/page';
import { RoleCreateDialog } from './role-create-dialog';
import { RoleEditDialog } from './role-edit-dialog';
import { useHeldOrganizationPermissions, useSession } from '../../lib/session-store';
import { type EffectiveAuthorization, type UserIdentity } from '../../lib/api-client';

// Ensure React is globally available
(globalThis as unknown as { React: typeof React }).React = React;

interface MockNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  style: Record<string, string>;
  childNodes: MockNode[];
  options: unknown[];
  selectedIndex: number;
  innerHTML: string;
  textContent: string;
  addEventListener: () => void;
  removeEventListener: () => void;
  appendChild: (child: MockNode) => MockNode;
  removeChild: (child: MockNode) => MockNode;
  insertBefore: (child: MockNode) => MockNode;
  setAttribute: () => void;
  removeAttribute: () => void;
  ownerDocument?: unknown;
}

function setupDom() {
  function createNode(tag = 'DIV'): MockNode {
    const node: MockNode = {
      nodeType: 1,
      nodeName: tag,
      tagName: tag,
      style: {},
      childNodes: [],
      options: [],
      selectedIndex: 0,
      innerHTML: '',
      textContent: '',
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: (child: MockNode) => {
        node.childNodes.push(child);
        return child;
      },
      removeChild: (child: MockNode) => {
        const idx = node.childNodes.indexOf(child);
        if (idx !== -1) node.childNodes.splice(idx, 1);
        return child;
      },
      insertBefore: (child: MockNode) => {
        node.childNodes.push(child);
        return child;
      },
      setAttribute: () => {},
      removeAttribute: () => {},
    };
    return node;
  }

  const target = createNode();
  const doc = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: createNode('HTML'),
    createElement: (tag: string) => createNode(tag),
    createElementNS: (_: string, tag: string) => createNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, nodeValue: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    defaultView: undefined as unknown,
  };
  target.ownerDocument = doc;
  class ElementMock {}
  class HTMLIFrameElementMock extends ElementMock {}
  doc.defaultView = {
    Element: ElementMock,
    HTMLIFrameElement: HTMLIFrameElementMock,
    getComputedStyle: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as Record<string, unknown>).window = doc.defaultView;
  (globalThis as unknown as Record<string, unknown>).document = doc;
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  let caughtError: Error | null = null;
  const root = ReactDOM.createRoot(target as unknown as Element, {
    onUncaughtError: (err) => {
      caughtError = err instanceof Error ? err : new Error(String(err));
    },
    onCaughtError: (err) => {
      caughtError = err instanceof Error ? err : new Error(String(err));
    },
  });

  return {
    target,
    root,
    getError: () => caughtError,
    unmount: () => {
      try {
        root.unmount();
      } catch {
        // ignore unmount errors in test environment
      }
    },
  };
}

describe('Roles React 19 Render Loop & Hook Stability Regression Tests', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-orgBBBBBBBBBB';

  const originalFetch = globalThis.fetch;
  let domHandle: ReturnType<typeof setupDom> | null = null;
  let currentAuth: EffectiveAuthorization;

  const createMockUser = (orgIds: string[] = [ORG_A, ORG_B]): UserIdentity => ({
    userId: 'u1-test-user',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 's1-test-session',
    authenticatedAt: new Date().toISOString(),
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    authorizedOrganizationIds: orgIds,
    roles: [],
    permissions: [],
  });

  const createMockAuthorization = (
    orgId: string,
    permissions: string[] = ['roles.read', 'roles.create', 'roles.update', 'roles.delete'],
  ): EffectiveAuthorization => ({
    actorType: 'user',
    userId: 'u1-test-user',
    apiKeyId: null,
    organizationIds: [ORG_A, ORG_B],
    isPlatformAdmin: false,
    grants: [
      {
        roleId: `role-${orgId}`,
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: orgId,
        orgId: orgId,
        permissions,
      },
    ],
  });

  beforeEach(() => {
    domHandle = setupDom();
    currentAuth = createMockAuthorization(ORG_A);

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/me/authorization')) {
        const activeOrg = useSession.getState().selectedOrganizationId;
        const authData = activeOrg === ORG_A ? currentAuth : createMockAuthorization(ORG_B, []);
        return new Response(JSON.stringify({ data: authData }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [], page: { hasMore: false } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    useSession.getState().setSession({
      accessToken: 'token-roles-test',
      user: createMockUser(),
      authorization: currentAuth,
      selectedOrgId: ORG_A,
    });
  });

  afterEach(() => {
    if (domHandle) {
      domHandle.unmount();
      domHandle = null;
    }
    globalThis.fetch = originalFetch;
    useSession.getState().clearSession();
  });

  it('useHeldOrganizationPermissions returns stable Set reference across component rerenders when inputs are unchanged', async () => {
    const capturedRefs: Set<string>[] = [];
    let triggerRerender: () => void = () => {};

    function TestHookComponent() {
      const [, setTick] = React.useState(0);
      triggerRerender = () => setTick((t) => t + 1);

      const held = useHeldOrganizationPermissions();
      capturedRefs.push(held);
      return React.createElement('div', null, `Held: ${held.size}`);
    }

    await React.act(async () => {
      domHandle!.root.render(React.createElement(TestHookComponent));
    });

    assert.equal(capturedRefs.length, 1);
    const initialRef = capturedRefs[0]!;
    assert(initialRef.has('roles.read'));
    assert(initialRef.has('roles.create'));

    // Trigger component re-render without changing store state
    await React.act(async () => {
      triggerRerender();
    });

    assert.equal(capturedRefs.length, 2);
    // MUST be identical reference (Object.is) due to useMemo
    assert.equal(
      capturedRefs[1],
      initialRef,
      'useHeldOrganizationPermissions must return the exact same Set reference on re-render',
    );

    // Trigger an un-related store state update (touching unrelated store slice)
    await React.act(async () => {
      useSession.setState({ errorMessage: 'an unrelated error message' });
      triggerRerender();
    });

    assert.equal(
      capturedRefs[capturedRefs.length - 1],
      initialRef,
      'useHeldOrganizationPermissions must maintain stable Set reference when authorization and org inputs are unchanged',
    );
  });

  it('useHeldOrganizationPermissions recalculates and returns new Set reference when selectedOrganization changes', async () => {
    const capturedRefs: Set<string>[] = [];

    function TestHookComponent() {
      const held = useHeldOrganizationPermissions();
      capturedRefs.push(held);
      return React.createElement('div', null, `Held: ${held.size}`);
    }

    await React.act(async () => {
      domHandle!.root.render(React.createElement(TestHookComponent));
    });

    const initialRef = capturedRefs[capturedRefs.length - 1]!;
    assert(initialRef.has('roles.read'));

    // Switch to ORG_B where the user holds NO grants in current mock authorization
    await React.act(async () => {
      useSession.getState().selectOrganization(ORG_B);
    });

    const updatedRef = capturedRefs[capturedRefs.length - 1]!;
    assert.notEqual(
      updatedRef,
      initialRef,
      'useHeldOrganizationPermissions must recompute and return a new Set reference on organization change',
    );
    assert.equal(updatedRef.size, 0, 'User holds no permissions in ORG_B');
  });

  it('useHeldOrganizationPermissions recalculates and returns new Set reference when authorization changes', async () => {
    const capturedRefs: Set<string>[] = [];

    function TestHookComponent() {
      const held = useHeldOrganizationPermissions();
      capturedRefs.push(held);
      return React.createElement('div', null, `Held: ${held.size}`);
    }

    await React.act(async () => {
      domHandle!.root.render(React.createElement(TestHookComponent));
    });

    const initialRef = capturedRefs[capturedRefs.length - 1]!;

    // Update authorization with additional permissions via setSession
    const newAuth = createMockAuthorization(ORG_A, [
      'roles.read',
      'roles.create',
      'workspaces.create',
    ]);
    currentAuth = newAuth;

    await React.act(async () => {
      useSession.getState().setSession({
        accessToken: 'token-roles-test',
        user: createMockUser(),
        authorization: newAuth,
        selectedOrgId: ORG_A,
      });
    });

    const updatedRef = capturedRefs[capturedRefs.length - 1]!;
    assert.notEqual(
      updatedRef,
      initialRef,
      'useHeldOrganizationPermissions must recompute and return a new Set reference on authorization change',
    );
    assert(updatedRef.has('workspaces.create'));
  });

  it('renders RoleCreateDialog and RoleEditDialog while closed without triggering infinite render loop', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function TestDialogsWrapper() {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(React.Fragment, null, [
          React.createElement(RoleCreateDialog, {
            key: 'create',
            isOpen: false,
            onClose: () => {},
            onSuccess: () => {},
          }),
          React.createElement(RoleEditDialog, {
            key: 'edit',
            role: null,
            isOpen: false,
            onClose: () => {},
            onSuccess: () => {},
          }),
        ]),
      );
    }

    await React.act(async () => {
      domHandle!.root.render(React.createElement(TestDialogsWrapper));
    });

    const err = domHandle!.getError();
    assert.equal(err, null, 'Closed dialogs must render cleanly without React error #185');
  });

  it('renders RolesPage successfully with React 19 while create/edit dialogs are closed without render loop (#185)', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await React.act(async () => {
      domHandle!.root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(RolesPage),
        ),
      );
    });

    // Wait a tick for any microtask or effect updates
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const err = domHandle!.getError();
    assert.equal(
      err,
      null,
      `RolesPage must mount and render successfully without React error #185. Caught: ${err?.message}`,
    );
  });
});
