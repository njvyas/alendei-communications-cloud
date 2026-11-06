'use client';

import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useState, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';

import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme-store';
import { useModalDialog } from '@/components/ui/dialog';
import { IconSearch, IconClose, IconOverview } from './icons';
import { NAV_ITEMS, isNavItemVisible, type NavVisibilityContext, type NavItemConfig } from './types';

export interface CommandPaletteProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly navContext: NavVisibilityContext;
  readonly onSignOut?: () => void;
}

interface CommandAction {
  readonly id: string;
  readonly label: string;
  readonly category: 'Navigation' | 'Actions';
  readonly icon?: React.ComponentType<{ className?: string }>;
  readonly shortcut?: string;
  readonly onSelect: () => void;
}

export function CommandPalette({ isOpen, onClose, navContext, onSignOut }: CommandPaletteProps) {
  const router = useRouter();
  const { preference, setPreference } = useTheme();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const { panelRef, overlayProps } = useModalDialog(isOpen);

  // Reset query and selected index whenever opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Small timeout to allow dialog mount
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Build authorized commands
  const commands = useMemo<CommandAction[]>(() => {
    const list: CommandAction[] = [];

    // 1. Navigation items (filtered strictly by capability)
    const visibleNavItems = NAV_ITEMS.filter((item) => isNavItemVisible(item.href, navContext));
    for (const item of visibleNavItems) {
      list.push({
        id: `nav-${item.href}`,
        label: `Go to ${item.label}`,
        category: 'Navigation',
        icon: item.icon,
        shortcut: item.href,
        onSelect: () => {
          onClose();
          router.push(item.href as Route);
        },
      });
    }

    // 2. Capability-filtered quick actions
    if (navContext.canSendMessages) {
      list.push({
        id: 'action-send-message',
        label: '+ Send Message',
        category: 'Actions',
        onSelect: () => {
          onClose();
          router.push('/messages' as Route);
        },
      });
    }

    if (navContext.canReadTemplates) {
      list.push({
        id: 'action-create-template',
        label: '+ Create Template',
        category: 'Actions',
        onSelect: () => {
          onClose();
          router.push('/templates' as Route);
        },
      });
    }

    if (navContext.canReadContacts) {
      list.push({
        id: 'action-add-contact',
        label: '+ Add Contact',
        category: 'Actions',
        onSelect: () => {
          onClose();
          router.push('/contacts' as Route);
        },
      });
    }

    if (navContext.canReadUsers) {
      list.push({
        id: 'action-invite-user',
        label: '+ Invite User',
        category: 'Actions',
        onSelect: () => {
          onClose();
          router.push('/users' as Route);
        },
      });
    }

    if (navContext.canReadWorkspaces) {
      list.push({
        id: 'action-create-workspace',
        label: '+ Create Workspace',
        category: 'Actions',
        onSelect: () => {
          onClose();
          router.push('/workspaces' as Route);
        },
      });
    }

    // Theme toggles
    list.push({
      id: 'action-toggle-theme',
      label: `Switch Theme (currently ${preference})`,
      category: 'Actions',
      shortcut: 'Theme',
      onSelect: () => {
        const next = preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark';
        setPreference(next);
        onClose();
      },
    });

    if (onSignOut) {
      list.push({
        id: 'action-sign-out',
        label: 'Sign Out',
        category: 'Actions',
        onSelect: () => {
          onClose();
          onSignOut();
        },
      });
    }

    return list;
  }, [navContext, router, onClose, preference, setPreference, onSignOut]);

  // Filter commands by search query
  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        (c.shortcut && c.shortcut.toLowerCase().includes(q)),
    );
  }, [commands, query]);

  // Keep selected index within bounds
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    if (listRef.current) {
      const activeEl = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredCommands.length > 0 ? (prev + 1) % filteredCommands.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredCommands.length > 0 ? (prev - 1 + filteredCommands.length) % filteredCommands.length : 0,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        filteredCommands[selectedIndex].onSelect();
      }
    }
  };

  if (!isOpen) return null;

  const activeOptionId =
    filteredCommands[selectedIndex] ? `command-item-${filteredCommands[selectedIndex].id}` : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="command-palette-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-16 sm:pt-24 focus:outline-none"
      {...overlayProps(onClose, true)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-acc-border bg-acc-card shadow-2xl focus:outline-none"
      >
        <h2 id="command-palette-title" className="sr-only">
          Command Palette
        </h2>

        {/* Search Input Bar */}
        <div className="flex items-center border-b border-acc-border px-4 py-3">
          <IconSearch className="size-4 shrink-0 text-acc-text-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isOpen}
            aria-controls="command-results"
            aria-activedescendant={activeOptionId}
            aria-label="Search commands or destinations"
            placeholder="Type a command or destination..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent px-3 text-sm text-acc-text-primary placeholder:text-acc-text-muted focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close command palette"
            className="rounded p-1 text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary"
          >
            <IconClose className="size-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="max-h-80 overflow-y-auto p-2">
          {filteredCommands.length === 0 ? (
            <div className="p-6 text-center text-sm text-acc-text-muted">
              No matching commands or destinations found.
            </div>
          ) : (
            <ul id="command-results" role="listbox" ref={listRef} className="flex flex-col gap-0.5">
              {filteredCommands.map((item, idx) => {
                const isSelected = selectedIndex === idx;
                const Icon = item.icon ?? IconOverview;
                return (
                  <li
                    key={item.id}
                    id={`command-item-${item.id}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => item.onSelect()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={cn(
                      'flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
                      isSelected
                        ? 'bg-acc-primary text-acc-on-primary'
                        : 'text-acc-text-primary hover:bg-acc-surface-raised',
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Icon className={cn('size-4 shrink-0', isSelected ? 'text-acc-on-primary' : 'text-acc-text-secondary')} />
                      <span className="truncate">{item.label}</span>
                    </div>
                    {item.shortcut && (
                      <span
                        className={cn(
                          'ml-3 shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]',
                          isSelected
                            ? 'bg-acc-primary-hover text-acc-on-primary'
                            : 'bg-acc-surface-raised text-acc-text-muted',
                        )}
                      >
                        {item.shortcut}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Keyboard hints footer */}
        <div className="flex items-center justify-between border-t border-acc-border px-4 py-2 text-[11px] text-acc-text-muted bg-acc-bg">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="rounded border border-acc-border bg-acc-card px-1 py-0.5 font-mono">↑↓</kbd> Navigate
            </span>
            <span>
              <kbd className="rounded border border-acc-border bg-acc-card px-1 py-0.5 font-mono">↵</kbd> Select
            </span>
            <span>
              <kbd className="rounded border border-acc-border bg-acc-card px-1 py-0.5 font-mono">Esc</kbd> Close
            </span>
          </div>
          <span>Alendei Command</span>
        </div>
      </div>
    </div>
  );
}
