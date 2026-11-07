'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, contactsApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  extractCustomFields,
  setCustomField,
  removeCustomField,
  type CustomFieldEntry,
  type CustomFieldType,
} from '@/lib/cdp';
import type { ContactResponse } from '@acc/contracts';

interface ContactCustomFieldsCardProps {
  readonly contact: ContactResponse;
  readonly canManage?: boolean;
}

export function ContactCustomFieldsCard({
  contact,
  canManage = false,
}: ContactCustomFieldsCardProps) {
  const queryClient = useQueryClient();
  const fields = extractCustomFields(contact.metadata);

  const [isAdding, setIsAdding] = useState(false);
  const [fieldKey, setFieldKey] = useState('');
  const [fieldType, setFieldType] = useState<CustomFieldType>('string');
  const [fieldValue, setFieldValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSaveAttribute = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = fieldKey.trim();
    if (!cleanKey) {
      setError('Field key name is required.');
      return;
    }

    if (cleanKey.toLowerCase() === 'tags' || cleanKey.toLowerCase() === 'tag_list') {
      setError('Field name "tags" is reserved for CDP tags. Use the Tags manager.');
      return;
    }

    let parsedVal: unknown = fieldValue;
    if (fieldType === 'number') {
      const num = Number(fieldValue);
      if (Number.isNaN(num)) {
        setError('Value must be a valid number.');
        return;
      }
      parsedVal = num;
    } else if (fieldType === 'boolean') {
      parsedVal = fieldValue === 'true' || fieldValue === '1';
    } else if (fieldType === 'json') {
      try {
        parsedVal = JSON.parse(fieldValue);
      } catch {
        setError('Value must be valid JSON syntax.');
        return;
      }
    }

    setIsSaving(true);
    setError(null);

    const nextMetadata = setCustomField(contact.metadata, cleanKey, parsedVal);

    try {
      await contactsApi.update(contact.id, {
        metadata: nextMetadata,
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'detail', contact.id] });
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });

      toast.success('Field Added', `Attribute "${cleanKey}" added to contact profile.`);
      setFieldKey('');
      setFieldValue('');
      setIsAdding(false);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message || 'Failed to update custom attribute.');
      } else {
        setError('An unexpected error occurred while saving the attribute.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAttribute = async (keyToDelete: string) => {
    setIsSaving(true);
    setError(null);

    const nextMetadata = removeCustomField(contact.metadata, keyToDelete);

    try {
      await contactsApi.update(contact.id, {
        metadata: nextMetadata,
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'detail', contact.id] });
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });

      toast.success('Field Removed', `Attribute "${keyToDelete}" removed.`);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message || 'Failed to remove custom attribute.');
      } else {
        setError('An unexpected error occurred while deleting the attribute.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card
      className="border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs"
      data-testid="contact-custom-fields-card"
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Custom Fields & CDP Attributes</CardTitle>
            <CardDescription>
              Demographic variables, customer lifecycle values, and external CRM attributes
            </CardDescription>
          </div>
          {canManage && !isAdding && (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              data-testid="add-custom-field-btn"
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
            >
              + Add Field
            </button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div
            role="alert"
            className="rounded-md border border-rose-500/20 bg-rose-500/10 p-2.5 text-xs text-rose-400"
          >
            {error}
          </div>
        )}

        {/* Add Attribute Form */}
        {isAdding && (
          <form
            onSubmit={handleSaveAttribute}
            className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 text-xs space-y-3"
            data-testid="custom-field-form"
          >
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-indigo-400">Add New Attribute</h4>
              <button
                type="button"
                onClick={() => {
                  setIsAdding(false);
                  setError(null);
                }}
                className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label
                  htmlFor="cf-key-input"
                  className="block text-[11px] font-medium text-[var(--color-ink-muted)] mb-1"
                >
                  Attribute Key
                </label>
                <input
                  id="cf-key-input"
                  type="text"
                  value={fieldKey}
                  onChange={(e) => setFieldKey(e.target.value)}
                  disabled={isSaving}
                  placeholder="e.g. company, ltv, tier"
                  className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="cf-type-select"
                  className="block text-[11px] font-medium text-[var(--color-ink-muted)] mb-1"
                >
                  Type
                </label>
                <select
                  id="cf-type-select"
                  value={fieldType}
                  onChange={(e) => setFieldType(e.target.value as CustomFieldType)}
                  disabled={isSaving}
                  className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
                >
                  <option value="string">Text (String)</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean (True/False)</option>
                  <option value="json">JSON Object</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="cf-val-input"
                  className="block text-[11px] font-medium text-[var(--color-ink-muted)] mb-1"
                >
                  Value
                </label>
                {fieldType === 'boolean' ? (
                  <select
                    id="cf-val-input"
                    value={fieldValue}
                    onChange={(e) => setFieldValue(e.target.value)}
                    disabled={isSaving}
                    className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
                  >
                    <option value="">Select Boolean...</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    id="cf-val-input"
                    type="text"
                    value={fieldValue}
                    onChange={(e) => setFieldValue(e.target.value)}
                    disabled={isSaving}
                    placeholder={fieldType === 'number' ? '42' : 'Value string...'}
                    className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:border-indigo-500 focus:outline-none"
                  />
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsAdding(false)}
                disabled={isSaving}
                className="rounded px-2.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving || !fieldKey.trim() || !fieldValue.trim()}
                data-testid="save-custom-field-btn"
                className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {isSaving ? 'Saving…' : 'Save Attribute'}
              </button>
            </div>
          </form>
        )}

        {/* Existing Custom Attributes Table */}
        {fields.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
            No custom attributes defined for this contact. Click &quot;+ Add Field&quot; to attach
            demographic or CRM properties.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
            <table className="w-full text-left text-xs" data-testid="custom-fields-table">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-ink-muted)]">
                  <th scope="col" className="px-3.5 py-2 font-medium">
                    Attribute Key
                  </th>
                  <th scope="col" className="px-3.5 py-2 font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-3.5 py-2 font-medium">
                    Value
                  </th>
                  {canManage && (
                    <th scope="col" className="px-3.5 py-2 font-medium text-right">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {fields.map((f: CustomFieldEntry) => {
                  const renderedValue =
                    typeof f.value === 'object' && f.value !== null
                      ? JSON.stringify(f.value)
                      : String(f.value);

                  return (
                    <tr
                      key={f.key}
                      data-testid={`custom-field-row-${f.key}`}
                      className="hover:bg-[var(--color-surface)]"
                    >
                      <td className="px-3.5 py-2 font-mono text-[11px] font-semibold text-[var(--color-ink)]">
                        {f.key}
                      </td>
                      <td className="px-3.5 py-2">
                        <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-muted)]">
                          {f.type}
                        </span>
                      </td>
                      <td className="px-3.5 py-2 font-mono text-[11px] text-[var(--color-ink)]">
                        {renderedValue}
                      </td>
                      {canManage && (
                        <td className="px-3.5 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteAttribute(f.key)}
                            disabled={isSaving}
                            data-testid={`delete-field-btn-${f.key}`}
                            className="rounded p-1 text-[var(--color-ink-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                            aria-label={`Delete attribute ${f.key}`}
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
