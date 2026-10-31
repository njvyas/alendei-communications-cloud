'use client';

import { useState, useEffect } from 'react';
import {
  ApiError,
  domainsApi,
  type DomainVerificationDetails,
  type DomainView,
} from '@/lib/api-client';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface DomainVerificationDialogProps {
  readonly isOpen: boolean;
  readonly orgId: string;
  readonly domain: DomainView | null;
  readonly onClose: () => void;
  readonly onSuccess: (domain: DomainView) => void;
}

export function DomainVerificationDialog({
  isOpen,
  orgId,
  domain,
  onClose,
  onSuccess,
}: DomainVerificationDialogProps) {
  const [details, setDetails] = useState<DomainVerificationDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && domain) {
      setIsLoading(true);
      setErrorMessage(null);
      domainsApi
        .getVerification(orgId, domain.id)
        .then((res) => setDetails(res.data))
        .catch((err) => {
          setErrorMessage(
            err instanceof Error ? err.message : 'Failed to load verification challenge',
          );
        })
        .finally(() => setIsLoading(false));
    } else {
      setDetails(null);
      setErrorMessage(null);
    }
  }, [isOpen, orgId, domain]);

  const modal = useModalDialog(isOpen);

  if (!isOpen || !domain) return null;

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`Copied ${label} to clipboard`))
      .catch(() => toast.error('Failed to copy to clipboard'));
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    setErrorMessage(null);
    try {
      const res = await domainsApi.verify(orgId, domain.id);
      toast.success(`Domain ${domain.domain} verified and activated successfully!`);
      onSuccess(res.data);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'DOMAIN_VERIFICATION_FAILED') {
          setErrorMessage(
            'DNS TXT record not found or does not match challenge value yet. DNS propagation may take a few minutes.',
          );
        } else {
          setErrorMessage(err.message || 'Verification failed');
        }
      } else {
        setErrorMessage('Verification request failed. Please check network and try again.');
      }
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="domain-verification-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 focus:outline-none"
      {...modal.overlayProps(onClose, !isVerifying)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2
              id="domain-verification-title"
              className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
            >
              Verify Domain Ownership
            </h2>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Add the following DNS TXT challenge record with your DNS provider to verify ownership
              of <span className="font-semibold text-[var(--color-ink)]">{domain.domain}</span>.
            </p>
          </div>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
          >
            {errorMessage}
          </div>
        )}

        {isLoading ? (
          <div role="status" className="flex items-center justify-center py-8">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <span className="ml-2 text-xs text-[var(--color-ink-muted)]">
              Loading verification details…
            </span>
          </div>
        ) : details ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs">
              <div className="grid grid-cols-4 gap-2 border-b border-[var(--color-border-subtle)] pb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
                <div>Type</div>
                <div className="col-span-2">Host / Name</div>
                <div>TTL</div>
              </div>
              <div className="grid grid-cols-4 items-center gap-2 pt-2 font-mono text-xs text-[var(--color-ink)]">
                <div className="font-bold text-[var(--color-accent)]">{details.record.type}</div>
                <div className="col-span-2 flex items-center justify-between overflow-hidden pr-2">
                  <span className="truncate">{details.record.name}</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(details.record.name, 'Host name')}
                    className="ml-1 text-[11px] text-[var(--color-accent)] hover:underline"
                    aria-label="Copy host name"
                  >
                    Copy
                  </button>
                </div>
                <div>{details.record.ttl}s</div>
              </div>
            </div>

            <div>
              <label
                htmlFor="txt-challenge-value"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                TXT Value / Content
              </label>
              <div className="mt-1 flex items-center rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5">
                <input
                  id="txt-challenge-value"
                  type="text"
                  readOnly
                  value={details.record.value}
                  className="w-full bg-transparent font-mono text-xs text-[var(--color-ink)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleCopy(details.record.value, 'TXT value')}
                  className="ml-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                >
                  Copy
                </button>
              </div>
            </div>

            <div className="rounded-md border border-sky-500/20 bg-sky-500/10 p-3 text-xs text-sky-400">
              <p className="font-semibold">Verification Instructions</p>
              <p className="mt-1 text-[11px] leading-relaxed text-sky-300">
                {details.instructions}
              </p>
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isVerifying}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleVerify}
            disabled={isLoading || isVerifying}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {isVerifying ? 'Checking DNS…' : 'Verify Now'}
          </button>
        </div>
      </div>
    </div>
  );
}
