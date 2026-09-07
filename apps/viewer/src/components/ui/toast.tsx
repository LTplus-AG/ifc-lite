/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lightweight toast notification system.
 * Usage:
 *   import { toast } from '@/components/ui/toast';
 *   toast.success('Exported 42 entities');
 *   toast.error('Export failed');
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Check, AlertCircle, Download, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Store (vanilla, framework-agnostic) ─────────────────────────────────

interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
}

type Listener = () => void;

let nextId = 0;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

function addToast(type: Toast['type'], message: string, durationMs = 3000) {
  const id = nextId++;
  toasts = [...toasts, { id, type, message }];
  notify();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, durationMs);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

/** Imperative toast API */
export const toast = {
  success: (message: string) => addToast('success', message, 3000),
  error: (message: string) => addToast('error', message, 5000),
  info: (message: string) => addToast('info', message, 3000),
};

// ─── React Component ──────────────────────────────────────────────────────

function useToasts(): Toast[] {
  const [, setTick] = useState(0);
  const tickRef = useRef(0);

  useEffect(() => {
    const listener = () => {
      tickRef.current++;
      setTick(tickRef.current);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  return toasts;
}

const iconMap = {
  success: Check,
  error: AlertCircle,
  info: Download,
};

const colorMap = {
  success: 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-200',
  error: 'border-red-500/50 bg-red-50 dark:bg-red-950/80 text-red-800 dark:text-red-200',
  info: 'border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200',
};

/** Mount this once at the app root (e.g. in App.tsx) */
export function Toaster() {
  const items = useToasts();

  const handleDismiss = useCallback((id: number) => dismiss(id), []);

  if (items.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none max-w-sm"
    >
      {items.map((t) => {
        const Icon = iconMap[t.type];
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-center gap-2 border-2 px-3 py-2 shadow-lg',
              'animate-in slide-in-from-bottom-2 fade-in-0 duration-200',
              colorMap[t.type],
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="text-xs font-medium flex-1 min-w-0">{t.message}</span>
            <button
              onClick={() => handleDismiss(t.id)}
              className="shrink-0 p-0.5 rounded-sm hover:bg-black/10 dark:hover:bg-white/10"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
