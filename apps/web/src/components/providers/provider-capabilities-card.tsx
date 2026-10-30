'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, providersApi, type ProviderDetailView } from '@/lib/api-client';
import {
  PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS,
  PROVIDER_CAPABILITY_KEY_PATTERN,
  PROVIDER_CAPABILITY_LIMITS,
} from '@acc/contracts';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { AccessibleDialog } from '@/components/ui/dialog';
import { ActionFeedback, type ActionFeedbackMessage } from '@/components/ui/action-feedback';
import { humanizeApiError } from '@/lib/error-mapping';

/**
 * Authoritative simulator behaviors supported by the platform (U8, ADR-013 PD-3, ADR-014 D19).
 */
export const SUPPORTED_SIMULATOR_BEHAVIORS = ['SUCCESS', '500', '429', 'TIMEOUT'] as const;

export type SupportedSimulatorBehavior = (typeof SUPPORTED_SIMULATOR_BEHAVIORS)[number];

export const SIMULATOR_BEHAVIOR_KEY = 'simulator_behavior';

export interface SimulatorBehaviorOption {
  readonly value: SupportedSimulatorBehavior;
  readonly label: string;
  readonly description: string;
}

export const SIMULATOR_BEHAVIOR_OPTIONS: readonly SimulatorBehaviorOption[] = [
  {
    value: 'SUCCESS',
    label: 'SUCCESS',
    description: 'Normal delivery (200 OK / Provider Accepted)',
  },
  {
    value: '500',
    label: '500',
    description: 'HTTP 500 Internal Error (Triggers fallback & error log)',
  },
  {
    value: '429',
    label: '429',
    description: 'HTTP 429 Rate Limited (Triggers backoff / rate limit)',
  },
  {
    value: 'TIMEOUT',
    label: 'TIMEOUT',
    description: 'Adapter timeout (Transitions to outcome_unknown)',
  },
];

/**
 * Checks whether a given capability key corresponds to the simulator behavior setting.
 */
export function isSimulatorBehaviorKey(key: string): boolean {
  return key.trim().toLowerCase() === SIMULATOR_BEHAVIOR_KEY;
}

/**
 * Parses the raw JSON string representation of a capability value into a string.
 */
export function parseSimulatorBehaviorValue(valueJson: string): string {
  try {
    const parsed = JSON.parse(valueJson);
    if (typeof parsed === 'string') return parsed;
    return String(parsed);
  } catch {
    // If not valid JSON, strip surrounding quotes if present or return raw
    return valueJson.replace(/^"(.*)"$/, '$1');
  }
}

/**
 * Formats a simulator behavior value as a JSON string literal.
 * Crucial for preserving string types (e.g. "500" must remain a JSON string, never a number).
 */
export function formatSimulatorBehaviorPayload(behavior: string): string {
  return JSON.stringify(behavior);
}

// -----------------------------------------------------------------------------
// Simulator Behavior Selector
// -----------------------------------------------------------------------------

export interface SimulatorBehaviorSelectorProps {
  readonly id?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}

export function SimulatorBehaviorSelector({
  id,
  value,
  onChange,
  disabled = false,
}: SimulatorBehaviorSelectorProps) {
  const isCustomValue = Boolean(
    value && !SUPPORTED_SIMULATOR_BEHAVIORS.includes(value as SupportedSimulatorBehavior),
  );

  return (
    <div className="space-y-1">
      <select
        id={id}
        data-testid="simulator-behavior-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-0.5 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-mono font-medium text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
      >
        {SUPPORTED_SIMULATOR_BEHAVIORS.map((b) => {
          const opt = SIMULATOR_BEHAVIOR_OPTIONS.find((o) => o.value === b);
          return (
            <option key={b} value={b}>
              {opt ? `${opt.label} — ${opt.description}` : b}
            </option>
          );
        })}
        {isCustomValue && <option value={value}>{value} (Custom / Legacy)</option>}
      </select>
      <p className="text-[11px] text-[var(--color-ink-muted)]">
        Simulated outcome when dispatching messages through this adapter.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Provider Capabilities Edit Dialog
// -----------------------------------------------------------------------------

export interface ProviderCapabilitiesDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly provider: ProviderDetailView;
}

export interface CapabilityRow {
  key: string;
  valueJson: string;
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
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  const hasSimulatorBehavior = rows.some((r) => isSimulatorBehaviorKey(r.key));

  const handleAddRow = () => {
    setFeedback(null);
    if (rows.length >= PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES) {
      setFeedback({
        type: 'error',
        title: 'Limit Exceeded',
        message: `Cannot exceed ${PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES} capabilities.`,
      });
      return;
    }
    setRows((prev) => [...prev, { key: '', valueJson: '""' }]);
  };

  const handleAddSimulatorBehavior = () => {
    setFeedback(null);
    if (rows.length >= PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES) {
      setFeedback({
        type: 'error',
        title: 'Limit Exceeded',
        message: `Cannot exceed ${PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES} capabilities.`,
      });
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        key: SIMULATOR_BEHAVIOR_KEY,
        valueJson: formatSimulatorBehaviorPayload(SUPPORTED_SIMULATOR_BEHAVIORS[0]),
      },
    ]);
  };

  const handleRemoveRow = (index: number) => {
    setFeedback(null);
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const handleKeyChange = (index: number, newKey: string) => {
    setFeedback(null);
    setRows((prev) => {
      const copy = [...prev];
      const target = copy[index]!;
      const wasSimulator = isSimulatorBehaviorKey(target.key);
      const willBeSimulator = isSimulatorBehaviorKey(newKey);

      let updatedValueJson = target.valueJson;
      if (!wasSimulator && willBeSimulator) {
        // Switching to simulator_behavior: ensure valid default valueJson
        const parsed = parseSimulatorBehaviorValue(target.valueJson);
        const validBehavior = (SUPPORTED_SIMULATOR_BEHAVIORS as readonly string[]).includes(parsed)
          ? parsed
          : SUPPORTED_SIMULATOR_BEHAVIORS[0];
        updatedValueJson = formatSimulatorBehaviorPayload(validBehavior);
      }

      copy[index] = {
        ...target,
        key: newKey,
        valueJson: updatedValueJson,
      };
      return copy;
    });
  };

  const handleValueChange = (index: number, newValueJson: string) => {
    setFeedback(null);
    setRows((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index]!, valueJson: newValueJson };
      return copy;
    });
  };

  const handleSimulatorSelect = (index: number, selectedBehavior: string) => {
    handleValueChange(index, formatSimulatorBehaviorPayload(selectedBehavior));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const seenKeys = new Set<string>();
    const formattedCapabilities: Array<{ key: string; value: unknown }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const trimmedKey = row.key.trim();

      if (!trimmedKey) {
        setFeedback({
          type: 'error',
          title: 'Validation Error',
          message: `Row ${i + 1}: capability key cannot be empty.`,
        });
        return;
      }

      if (!PROVIDER_CAPABILITY_KEY_PATTERN.test(trimmedKey)) {
        setFeedback({
          type: 'error',
          title: 'Invalid Key Format',
          message: `Row ${i + 1}: key "${trimmedKey}" must be 2–64 lower-case letters, digits or underscores, starting with a letter.`,
        });
        return;
      }

      for (const forbidden of PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS) {
        if (trimmedKey.includes(forbidden)) {
          setFeedback({
            type: 'error',
            title: 'Forbidden Key Fragment',
            message: `Row ${i + 1}: key cannot contain forbidden secret fragment "${forbidden}".`,
          });
          return;
        }
      }

      if (seenKeys.has(trimmedKey)) {
        setFeedback({
          type: 'error',
          title: 'Duplicate Key',
          message: `Duplicate capability key "${trimmedKey}". Keys must be unique.`,
        });
        return;
      }
      seenKeys.add(trimmedKey);

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(row.valueJson);
      } catch {
        setFeedback({
          type: 'error',
          title: 'Invalid JSON',
          message: `Row ${i + 1}: value must be valid JSON.`,
        });
        return;
      }

      if (parsedValue === null) {
        setFeedback({
          type: 'error',
          title: 'Invalid Value',
          message: `Row ${i + 1}: capability value cannot be null.`,
        });
        return;
      }

      const serializedSize = new TextEncoder().encode(JSON.stringify(parsedValue)).length;
      if (serializedSize > PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES) {
        setFeedback({
          type: 'error',
          title: 'Value Size Limit Exceeded',
          message: `Row ${i + 1}: serialized value size (${serializedSize} bytes) exceeds limit (${PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES} bytes).`,
        });
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
        const humanized = humanizeApiError(err, 'Failed to update provider capabilities');
        setFeedback({
          type: 'error',
          title: humanized.title,
          message: humanized.message,
          code: humanized.code,
          correlationId: humanized.correlationId,
        });
      } else {
        setFeedback({
          type: 'error',
          title: 'Network Error',
          message: 'Failed to update capabilities. Please check your network connection.',
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog
      isOpen={open}
      onClose={() => onOpenChange(false)}
      titleId="edit-capabilities-title"
      descriptionId="edit-capabilities-desc"
      maxWidth="max-w-2xl"
    >
      <div className="flex flex-col max-h-[80vh]">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--color-border-subtle)]">
          <div>
            <h2
              id="edit-capabilities-title"
              className="text-base font-semibold tracking-tight text-[var(--color-ink)]"
            >
              Edit Capabilities — {provider.name}
            </h2>
            <p id="edit-capabilities-desc" className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Declared non-secret features and metadata supported by this provider adapter.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!hasSimulatorBehavior && (
              <button
                type="button"
                onClick={handleAddSimulatorBehavior}
                disabled={isSubmitting || rows.length >= PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES}
                className="rounded-md border border-[var(--color-accent)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                data-testid="add-simulator-behavior-btn"
              >
                + Add Simulator Behavior
              </button>
            )}
            <button
              type="button"
              onClick={handleAddRow}
              disabled={isSubmitting || rows.length >= PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
              data-testid="add-capability-btn"
            >
              + Add Capability
            </button>
          </div>
        </div>

        <div className="mt-3">
          <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />
        </div>

        <form onSubmit={handleSubmit} className="mt-3 flex-1 overflow-y-auto space-y-3 pr-1">
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
              No capabilities declared. Click &quot;+ Add Simulator Behavior&quot; or &quot;+ Add
              Capability&quot; to configure one.
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((row, index) => {
                const isSimulator = isSimulatorBehaviorKey(row.key);
                return (
                  <div
                    key={index}
                    data-testid={`capability-row-${row.key || index}`}
                    className="rounded-lg border border-[var(--color-border-subtle)] p-3 bg-[var(--color-surface-raised)]/30 space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1">
                        <label
                          htmlFor={`capability-key-${index}`}
                          className="block text-[11px] font-medium text-[var(--color-ink-muted)]"
                        >
                          Key (snake_case)
                        </label>
                        <div className="flex items-center gap-2 mt-0.5">
                          <input
                            id={`capability-key-${index}`}
                            type="text"
                            value={row.key}
                            onChange={(e) => handleKeyChange(index, e.target.value)}
                            placeholder="e.g. max_segments"
                            disabled={isSubmitting}
                            className="block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                            required
                          />
                          {isSimulator && (
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-[var(--color-accent)] text-white">
                              Simulator Control
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveRow(index)}
                        disabled={isSubmitting}
                        className="mt-4 rounded p-1 text-[var(--color-bad,#ef4444)] hover:bg-[var(--color-bad-subtle,rgba(239,68,68,0.1))] text-xs font-medium"
                        title="Remove capability"
                        data-testid={`remove-capability-${index}`}
                      >
                        Delete
                      </button>
                    </div>

                    <div>
                      <label
                        htmlFor={`capability-value-${index}`}
                        className="block text-[11px] font-medium text-[var(--color-ink-muted)]"
                      >
                        {isSimulator ? 'Simulator Behavior' : 'Value (JSON)'}
                      </label>
                      {isSimulator ? (
                        <SimulatorBehaviorSelector
                          id={`capability-value-${index}`}
                          value={parseSimulatorBehaviorValue(row.valueJson)}
                          onChange={(val) => handleSimulatorSelect(index, val)}
                          disabled={isSubmitting}
                        />
                      ) : (
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
                      )}
                    </div>
                  </div>
                );
              })}
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
              data-testid="save-capabilities-btn"
            >
              {isSubmitting ? 'Saving…' : 'Save Capabilities'}
            </button>
          </div>
        </form>
      </div>
    </AccessibleDialog>
  );
}

// -----------------------------------------------------------------------------
// Provider Capabilities Card (Main Component)
// -----------------------------------------------------------------------------

export interface ProviderCapabilitiesCardProps {
  readonly provider: ProviderDetailView;
  readonly canManage?: boolean;
}

export function ProviderCapabilitiesCard({
  provider,
  canManage = true,
}: ProviderCapabilitiesCardProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <>
      <div data-testid="provider-capabilities-card">
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Declared Capabilities</CardTitle>
              <CardDescription>Non-secret provider adapter attributes</CardDescription>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => setIsDialogOpen(true)}
                className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors"
                data-testid="edit-capabilities-btn"
              >
                Edit
              </button>
            )}
          </div>

          <div className="mt-4">
            {provider.capabilities.length === 0 ? (
              <div
                className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-xs text-[var(--color-ink-muted)]"
                data-testid="capabilities-empty-state"
              >
                No capabilities declared for this provider.
              </div>
            ) : (
              <div className="max-h-[220px] overflow-y-auto divide-y divide-[var(--color-border-subtle)] pr-1">
                {provider.capabilities.map((c) => {
                  const isSimulator = isSimulatorBehaviorKey(c.key);
                  return (
                    <div
                      key={c.key}
                      data-testid={`capability-item-${c.key}`}
                      className="py-2 text-xs flex justify-between items-start gap-2"
                    >
                      <span className="font-mono font-medium text-[var(--color-ink)]">{c.key}</span>
                      {isSimulator ? (
                        <span
                          data-testid="simulator-behavior-badge"
                          className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-subtle)]"
                        >
                          {String(c.value)}
                        </span>
                      ) : (
                        <pre className="font-mono text-[11px] text-[var(--color-ink-muted)] max-w-[200px] overflow-x-auto text-right">
                          {JSON.stringify(c.value)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      </div>

      <ProviderCapabilitiesDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        provider={provider}
      />
    </>
  );
}
