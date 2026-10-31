// Toast notifications. The store lives here so non-React code can raise them;
// ui.tsx's Toaster renders it.
import { create } from 'zustand';
import { isHidden } from './hidden';

export type ToastTone = 'info' | 'success' | 'error';
export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  leaving?: boolean;
}

// Time the exit animation gets before the toast is removed (EXIT_MS in ui.tsx).
const LEAVE_MS = 170;

export const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let toastId = 0;

// Fire-and-forget notification, usable from anywhere (including non-React code).
export function toast(message: string, tone: ToastTone = 'info'): void {
  // Secret mode: nothing may pop up while the window is hidden, not even later.
  if (isHidden()) return;
  const id = ++toastId;
  useToasts.setState((s) => ({ items: [...s.items, { id, tone, message }] }));
  // Fade out first, then drop it.
  setTimeout(
    () => {
      useToasts.setState((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
      setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), LEAVE_MS);
    },
    tone === 'error' ? 8000 : 4000,
  );
}
