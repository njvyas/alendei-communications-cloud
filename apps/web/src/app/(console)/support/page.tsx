'use client';

import { useState } from 'react';
import { useCanAccessPlatformSupport, useSession } from '@/lib/session-store';
import { SupportOverviewTab } from '@/components/support/support-overview-tab';
import { SupportRoutingTab } from '@/components/support/support-routing-tab';
import { SupportDispatchTab } from '@/components/support/support-dispatch-tab';
import { SupportAuditTab } from '@/components/support/support-audit-tab';
import { cn } from '@/lib/cn';

type TabKey = 'overview' | 'routing' | 'dispatch' | 'audit';

export default function PlatformSupportPage() {
  const canAccess = useCanAccessPlatformSupport();
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  const [inputOrgId, setInputOrgId] = useState<string>(selectedOrgId ?? '');
  const [activeOrgId, setActiveOrgId] = useState<string>(selectedOrgId ?? '');
  const [currentTab, setCurrentTab] = useState<TabKey>('overview');

  if (!canAccess) {
    return (
      <div
        className="rounded-lg border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-6 text-center"
        data-testid="support-access-denied"
      >
        <h2 className="text-base font-semibold text-[var(--color-bad)]">Access Restricted</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          The Platform Support Cockpit requires platform-level read authority (
          <code className="font-mono">platform.support.read</code>). Tenant-level administrators and
          unprivileged operators cannot access cross-tenant diagnostics.
        </p>
      </div>
    );
  }

  const handleInspectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputOrgId.trim()) {
      setActiveOrgId(inputOrgId.trim());
    }
  };

  const handleUseActiveOrg = () => {
    if (selectedOrgId) {
      setInputOrgId(selectedOrgId);
      setActiveOrgId(selectedOrgId);
    }
  };

  return (
    <div className="space-y-6" data-testid="platform-support-cockpit">
      {/* Cockpit Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">Platform Support Cockpit</h1>
            <span className="rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-2.5 py-0.5 text-2xs font-mono font-medium text-[var(--color-ink-muted)]">
              platform.support.read
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Read-only operational diagnostics, routing oversight, dispatch troubleshooting, and
            cross-tenant audit search.
          </p>
        </div>
      </div>

      {/* Target Organization Selector Bar */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <form onSubmit={handleInspectSubmit} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[280px]">
            <label
              htmlFor="targetOrgId"
              className="block text-2xs font-medium text-[var(--color-ink-muted)]"
            >
              Target Organization UUID
            </label>
            <input
              id="targetOrgId"
              type="text"
              placeholder="e.g. 0192e2... (UUIDv7)"
              value={inputOrgId}
              onChange={(e) => setInputOrgId(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs text-[var(--color-ink)]"
            />
          </div>

          <button
            type="submit"
            className="rounded-md bg-[var(--color-ink)] px-4 py-1.5 text-xs font-semibold text-[var(--color-surface)] hover:opacity-90 transition-opacity"
          >
            Inspect Org
          </button>

          {selectedOrgId && (
            <button
              type="button"
              onClick={handleUseActiveOrg}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
            >
              Use Selected Org ({selectedOrgId.slice(0, 8)}…)
            </button>
          )}
        </form>

        {activeOrgId ? (
          <p className="mt-2.5 text-2xs text-[var(--color-ink-muted)]">
            Actively diagnosing target:{' '}
            <span className="font-mono font-medium text-[var(--color-ink)]">{activeOrgId}</span>
          </p>
        ) : (
          <p className="mt-2.5 text-2xs text-[var(--color-warn)]">
            Enter an Organization UUID above to view organization-specific overview, routing, and
            dispatch diagnostics.
          </p>
        )}
      </div>

      {/* Cockpit Tabs Navigation */}
      <div className="border-b border-[var(--color-border-subtle)]">
        <nav className="flex space-x-6" aria-label="Support Tabs">
          <button
            type="button"
            onClick={() => setCurrentTab('overview')}
            className={cn(
              'pb-3 text-xs font-medium border-b-2 transition-colors',
              currentTab === 'overview'
                ? 'border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            Overview & Hierarchy
          </button>

          <button
            type="button"
            onClick={() => setCurrentTab('routing')}
            className={cn(
              'pb-3 text-xs font-medium border-b-2 transition-colors',
              currentTab === 'routing'
                ? 'border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            Routing & Providers
          </button>

          <button
            type="button"
            onClick={() => setCurrentTab('dispatch')}
            className={cn(
              'pb-3 text-xs font-medium border-b-2 transition-colors',
              currentTab === 'dispatch'
                ? 'border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            Dispatch & Failures
          </button>

          <button
            type="button"
            onClick={() => setCurrentTab('audit')}
            className={cn(
              'pb-3 text-xs font-medium border-b-2 transition-colors',
              currentTab === 'audit'
                ? 'border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            Cross-Tenant Audit Search
          </button>
        </nav>
      </div>

      {/* Tab Panels */}
      <div>
        {currentTab === 'overview' &&
          (activeOrgId ? (
            <SupportOverviewTab orgId={activeOrgId} />
          ) : (
            <div className="py-12 text-center text-xs text-[var(--color-ink-muted)]">
              Specify a Target Organization UUID above to view organization configuration,
              hierarchy, and metrics.
            </div>
          ))}

        {currentTab === 'routing' &&
          (activeOrgId ? (
            <SupportRoutingTab orgId={activeOrgId} />
          ) : (
            <div className="py-12 text-center text-xs text-[var(--color-ink-muted)]">
              Specify a Target Organization UUID above to inspect channel routing configurations and
              provider health.
            </div>
          ))}

        {currentTab === 'dispatch' &&
          (activeOrgId ? (
            <SupportDispatchTab orgId={activeOrgId} />
          ) : (
            <div className="py-12 text-center text-xs text-[var(--color-ink-muted)]">
              Specify a Target Organization UUID above to inspect live dispatch queue and failure
              diagnostics.
            </div>
          ))}

        {currentTab === 'audit' && <SupportAuditTab initialOrgId={activeOrgId} />}
      </div>
    </div>
  );
}
