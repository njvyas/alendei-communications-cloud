import { useSyncExternalStore } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  readonly id: string;
  readonly type: ToastType;
  readonly title: string;
  readonly message?: string;
  readonly duration?: number; // ms, default 4000; 0 for persistent
  readonly createdAt: number;
}

export interface ToastOptions {
  readonly duration?: number;
}

let toasts: readonly ToastItem[] = [];
const listeners = new Set<() => void>();
const timeoutMap = new Map<string, ReturnType<typeof setTimeout>>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function generateId(): string {
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const toast = {
  show(type: ToastType, title: string, message?: string, options?: ToastOptions): string {
    const id = generateId();
    const duration = options?.duration ?? 4000;
    const newItem: ToastItem = {
      id,
      type,
      title,
      message,
      duration,
      createdAt: Date.now(),
    };

    // Keep at most 5 toasts visible at once, oldest dropped
    toasts = [...toasts.slice(-4), newItem];
    notify();

    if (duration > 0) {
      const timeoutId = setTimeout(() => {
        toast.dismiss(id);
      }, duration);
      timeoutMap.set(id, timeoutId);
    }

    return id;
  },

  success(title: string, message?: string, options?: ToastOptions): string {
    return toast.show('success', title, message, options);
  },

  error(title: string, message?: string, options?: ToastOptions): string {
    return toast.show('error', title, message, options);
  },

  info(title: string, message?: string, options?: ToastOptions): string {
    return toast.show('info', title, message, options);
  },

  dismiss(id: string): void {
    const timeoutId = timeoutMap.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutMap.delete(id);
    }
    const previousLength = toasts.length;
    toasts = toasts.filter((t) => t.id !== id);
    if (toasts.length !== previousLength) {
      notify();
    }
  },

  clear(): void {
    for (const timeoutId of timeoutMap.values()) {
      clearTimeout(timeoutId);
    }
    timeoutMap.clear();
    toasts = [];
    notify();
  },

  getToasts(): readonly ToastItem[] {
    return toasts;
  },
};

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => toasts,
    () => toasts,
  );
}
