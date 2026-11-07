'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, contactsApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { extractContactTags, setContactTags, RECOMMENDED_CDP_TAGS } from '@/lib/cdp';
import type { ContactResponse } from '@acc/contracts';

interface ContactTagsCardProps {
  readonly contact: ContactResponse;
  readonly canManage?: boolean;
  readonly onTagsUpdated?: (tags: string[]) => void;
}

export function ContactTagsCard({
  contact,
  canManage = false,
  onTagsUpdated,
}: ContactTagsCardProps) {
  const queryClient = useQueryClient();
  const currentTags = extractContactTags(contact.metadata);

  const [newTagInput, setNewTagInput] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableRecommendations = RECOMMENDED_CDP_TAGS.filter(
    (rec) => !currentTags.some((t) => t.toLowerCase() === rec.toLowerCase()),
  );

  const handleSaveTags = async (updatedTags: string[]) => {
    setIsUpdating(true);
    setError(null);

    const nextMetadata = setContactTags(contact.metadata, updatedTags);
    try {
      await contactsApi.update(contact.id, {
        metadata: nextMetadata,
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'detail', contact.id] });
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });

      toast.success('Tags Updated', 'Contact tags have been successfully saved.');
      onTagsUpdated?.(updatedTags);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message || 'Failed to update contact tags.');
      } else {
        setError('An unexpected error occurred while saving tags.');
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAddTag = async (tagName: string) => {
    const trimmed = tagName.trim();
    if (!trimmed) return;
    if (currentTags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      setError(`Tag "${trimmed}" is already assigned to this contact.`);
      return;
    }

    const nextTags = [...currentTags, trimmed];
    setNewTagInput('');
    await handleSaveTags(nextTags);
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    const nextTags = currentTags.filter((t) => t !== tagToRemove);
    await handleSaveTags(nextTags);
  };

  return (
    <Card
      className="border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs"
      data-testid="contact-tags-card"
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Tags & Segmentation</CardTitle>
            <CardDescription>
              Customer segment labels and classification tags for audience engagement
            </CardDescription>
          </div>
          <span className="rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-2.5 py-0.5 text-xs font-mono text-[var(--color-ink-muted)]">
            {currentTags.length} {currentTags.length === 1 ? 'tag' : 'tags'}
          </span>
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

        {/* Current Active Tags */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-[var(--color-ink-muted)]">
            Active Contact Tags:
          </label>
          {currentTags.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-4 text-center text-xs text-[var(--color-ink-muted)]">
              No tags assigned yet. Add tags below to segment this contact.
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="contact-tags-list">
              {currentTags.map((tag) => (
                <span
                  key={tag}
                  data-testid={`contact-tag-${tag.toLowerCase().replace(/\s+/g, '-')}`}
                  className="inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-400"
                >
                  <span>{tag}</span>
                  {canManage && (
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() => handleRemoveTag(tag)}
                      aria-label={`Remove tag ${tag}`}
                      className="ml-0.5 rounded hover:text-white focus:outline-none"
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Add Tag Input */}
        {canManage && (
          <div className="space-y-3 pt-2 border-t border-[var(--color-border-subtle)]">
            <div className="flex gap-2">
              <label htmlFor="add-tag-input" className="sr-only">
                Add custom tag
              </label>
              <input
                id="add-tag-input"
                type="text"
                aria-label="Add custom tag"
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddTag(newTagInput);
                  }
                }}
                disabled={isUpdating}
                placeholder="Add custom tag (e.g. VIP, Wholesale)..."
                data-testid="add-tag-input"
                className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => handleAddTag(newTagInput)}
                disabled={isUpdating || !newTagInput.trim()}
                data-testid="add-tag-btn"
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors shrink-0"
              >
                {isUpdating ? 'Saving…' : 'Add Tag'}
              </button>
            </div>

            {/* Quick Suggestions */}
            {availableRecommendations.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-[11px] text-[var(--color-ink-muted)]">
                  Suggested Categories:
                </span>
                <div className="flex flex-wrap gap-1">
                  {availableRecommendations.slice(0, 6).map((rec) => (
                    <button
                      key={rec}
                      type="button"
                      disabled={isUpdating}
                      onClick={() => handleAddTag(rec)}
                      data-testid={`suggest-tag-${rec.toLowerCase()}`}
                      className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] text-[var(--color-ink-muted)] hover:border-indigo-500/50 hover:text-indigo-400 transition-colors"
                    >
                      + {rec}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
