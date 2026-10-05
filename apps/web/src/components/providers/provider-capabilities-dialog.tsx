'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  providersApi,
  type ProviderCapabilityView,
  type ProviderDetailView,
} from '@/lib/api-client';
import {
  PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS,
  PROVIDER_CAPABILITY_KEY_PATTERN,
  PROVIDER_CAPABILITY_LIMITS,
} from '@acc/contracts';

interface ProviderCapabilitiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDetailView;
}

interface CapabilityRow {
  key: string;
  valueJson: string;
  error?: string;
}

export function ProviderCapabilitiesDialog({
  open,
  onOpenChange,
  provider,
}: ProviderCapabilitiesDialogProps) {
  const queryClient = useQueryClient();

  const [rows, setRows] = useState<CapabilityRow[]>(() =>
    provider.capabilities.map((c) => ({
      key: c.key,
      valueJson: JSON.stringify(c.value, null, 2),
    })),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!open) return null;

  const handleAddRow = () => {
    if (rows.length >= PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES) {
      setErrorMessage(`Cannot exceed ${PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES} capabilities.`);
      return;
    }
    setRows((prev) => [...prev, { key: '', valueJson: '""' }]);
  };

  const handleRemoveRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const handleKeyChange = (index: number, newKey: string) => {
    setRows((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index]!, key: newKey };
      return copy;
    });
  };

  const handleValueChange = (index: number, newValueJson: string) => {
    setRows((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index]!, valueJson: newValueJson };
      return copy;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    // Validate each row
    const seenKeys = new Set<string>();
    const formattedCapabilities: Array<{ key: string; value: unknown }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const trimmedKey = row.key.trim();

      if (!trimmedKey) {
        setErrorMessage(`Row ${i + 1}: capability key cannot be empty.`);
        return;
      }

      if (!PROVIDER_CAPABILITY_KEY_PATTERN.test(trimmedKey)) {
        setErrorMessage(
          `Row ${i + 1}: key "${trimmedKey}" must be 2–64 lower-case letters, digits or underscores, starting with a letter.`,
        );
        return;
      }

      for (const forbidden of PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS) {
        if (trimmedKey.includes(forbidden)) {
          setErrorMessage(
            `Row ${i + 1}: key cannot contain forbidden secret fragment "${forbidden}".`,
          );
          return;
        }
      }

      if (seenKeys.has(trimmedKey)) {
        setErrorMessage(`Duplicate capability key "${trimmedKey}". Keys must be unique.`);
        return;
      }
      seenKeys.add(trimmedKey);

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(row.valueJson);
      } catch {
        setErrorMessage(`Row ${i + 1}: value must be valid JSON.`);
        return;
      }

      const serializedSize = new TextEncoder().encode(JSON.stringify(parsedValue)).length;
      if (serializedSize > PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES) {
        setErrorMessage(
          `Row ${i + 1}: serialized value size (${serializedSize} bytes) exceeds limit (${PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES} bytes).`,
        );
        return;
      }

      formattedCapabilities.push({ key: trimmedKey, value: parsedValue });
    }

    setIsSubmitting(true);
    try {
      await providersApi.replaceCapabilities(provider.id, {
        capabilities: formattedCapabilities,
      });

      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to update capabilities. Please check your network connection.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-2xl rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-ink)]">
              Edit Capabilities — {provider.name}
            </h2>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Declared non-secret features and metadata supported by this provider adapter.
            </p>
          </div>
          <button
            type="button"
            onClick={handleAddRow}
            disabled={isSubmitting || rows.length >= PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES}
            className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
          >
            + Add Capability
          </button>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 text-xs text-[var(--color-bad,#ef4444)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1">
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
              No capabilities declared. Click &quot;+ Add Capability&quot; to configure one.
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((row, index) => (
                <div
                  key={index}
                  data-testid={`capability-row-${row.key || index}`}
                  className="rounded-lg border border-[var(--color-border-subtle)] p-3 bg-[var(--color-surface-raised)]/30 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1">
                      <label
                        htmlFor={`capability-key-${index}`}
                        className="block text-[11px] font-medium text-[var(--color-ink-muted)]"
                      >
                        Key (snake_case)
                      </label>
                      <input
                        id={`capability-key-${index}`}
                        type="text"
                        value={row.key}
                        onChange={(e) => handleKeyChange(index, e.target.value)}
                        placeholder="e.g. max_segments"
                        disabled={isSubmitting}
                        className="mt-0.5 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                        required
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveRow(index)}
                      disabled={isSubmitting}
                      className="mt-4 rounded p-1 text-[var(--color-bad,#ef4444)] hover:bg-[var(--color-bad-subtle,rgba(239,68,68,0.1))] text-xs font-medium"
                      title="Remove capability"
                    >
                      Delete
                    </button>
                  </div>

                  <div>
                    <label
                      htmlFor={`capability-value-${index}`}
                      className="block text-[11px] font-medium text-[var(--color-ink-muted)]"
                    >
                      Value (JSON)
                    </label>
                    <textarea
                      id={`capability-value-${index}`}
                      rows={2}
                      value={row.valueJson}
                      onChange={(e) => handleValueChange(index, e.target.value)}
                      placeholder='e.g. 10 or {"supports_templates": true}'
                      disabled={isSubmitting}
                      className="mt-0.5 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                      required
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t border-[var(--color-border-subtle)]">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Save Capabilities'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
