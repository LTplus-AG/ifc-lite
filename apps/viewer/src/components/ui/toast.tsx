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
import { Check, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

// ─── Store (vanilla, framework-agnostic) ─────────────────────────────────

interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
  /** How many identical toasts were merged into this one. */
  count: number;
  /** Increases every time a toast is shown or merged into; orders by recency. */
  seq: number;
  action?: { label: string; onClick: () => void };
}

type Listener = () => void;

/** A burst of failures (e.g. repeated GPU device loss) must not bury the UI (#5603). */
const MAX_VISIBLE = 3;

let nextId = 0;
let nextSeq = 0;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function notify() {
  for (const l of listeners) l();
}

function clearTimer(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

/**
 * Show a toast, or bump the count of an identical one already on screen and
 * make it the newest. `durationMs: null` keeps it until dismissed. Past
 * `MAX_VISIBLE` the oldest toasts are evicted, transient ones before errors:
 * an error stays until dismissed, so newer successes must not push it off.
 */
function addToast(type: Toast['type'], message: string, durationMs: number | null, action?: Toast['action']) {
  const existing = toasts.find((t) => t.type === type && t.message === message);
  const id = existing?.id ?? nextId++;
  const others = toasts.filter((t) => t.id !== id);
  const excess = Math.max(0, others.length - (MAX_VISIBLE - 1));
  // `others` is oldest-first, so this is oldest transient, then oldest error.
  const evictOrder = [...others.filter((t) => t.type !== 'error'), ...others.filter((t) => t.type === 'error')];
  const evicted = new Set(evictOrder.slice(0, excess).map((t) => t.id));
  for (const evictedId of evicted) clearTimer(evictedId);
  const kept = others.filter((t) => !evicted.has(t.id));
  toasts = [...kept, { id, type, message, count: (existing?.count ?? 0) + 1, seq: nextSeq++, action }];
  clearTimer(id);
  if (durationMs !== null) timers.set(id, setTimeout(() => dismiss(id), durationMs));
  notify();
}

function dismiss(id: number) {
  clearTimer(id);
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

/** Imperative toast API. Errors stay until the user dismisses them. */
export const toast = {
  success: (message: string, action?: Toast['action']) => addToast('success', message, action ? null : 3000, action),
  error: (message: string) => addToast('error', message, null),
  info: (message: string, action?: Toast['action']) => addToast('info', message, action ? null : 3000, action),
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
  info: Info,
};

const colorMap = {
  success: 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-200',
  error: 'border-red-500/50 bg-red-50 dark:bg-red-950/80 text-red-800 dark:text-red-200',
  info: 'border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200',
};

export interface ToasterProps {
  /**
   * `fixed` (default) pins the stack to the browser viewport — the app
   * shell's own mount (`App.tsx`, and the `/mcp` routes, which have no
   * viewport panel to anchor to). `absolute` anchors it to the nearest
   * positioned ancestor instead: the main viewer mounts one inside
   * `ViewportContainer`'s own `relative` root (#5504, charter #5478 item
   * 22) so toasts sit at the viewport's bottom-right, above the status bar,
   * rather than the whole window's.
   */
  variant?: 'fixed' | 'absolute';
}

/**
 * Mount once per anchor (app root by default, or a `relative` viewport
 * container — see {@link ToasterProps.variant}). Both live regions stay
 * mounted while empty so the first toast is announced; errors go to the
 * assertive `alert` region. Each region shows its newest toast on top.
 * Mount only ONE live instance at a time: every `Toaster` reads the same
 * module-level store, so two mounted together would render every toast twice.
 */
export function Toaster({ variant = 'fixed' }: ToasterProps = {}) {
  const items = useToasts();
  const { t } = useTranslation();

  const handleDismiss = useCallback((id: number) => dismiss(id), []);

  const renderItem = (item: Toast) => {
    const Icon = iconMap[item.type];
    return (
      <div
        key={item.id}
        data-toast-seq={item.seq}
        className={cn(
          'pointer-events-auto flex items-center gap-2 border-2 px-3 py-2 shadow-lg',
          'animate-in slide-in-from-bottom-2 fade-in-0 duration-200',
          colorMap[item.type],
        )}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium flex-1 min-w-0">{item.message}</span>
        {item.count > 1 && (
          <span className="shrink-0 text-[10px] font-semibold tabular-nums opacity-70" aria-hidden="true">
            ×{item.count}
          </span>
        )}
        {item.action && (
          <button
            onClick={() => {
              item.action?.onClick();
              handleDismiss(item.id);
            }}
            className="shrink-0 rounded-sm px-1 text-xs font-semibold underline underline-offset-2 hover:bg-black/10 dark:hover:bg-white/10"
          >
            {item.action.label}
          </button>
        )}
        <button
          onClick={() => handleDismiss(item.id)}
          aria-label={t('viewerShell.toast.dismiss')}
          className="shrink-0 p-0.5 rounded-sm hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <div
      className={cn(
        'bottom-4 right-4 z-(--z-toast) flex flex-col pointer-events-none max-w-sm',
        variant === 'absolute' ? 'absolute' : 'fixed',
      )}
    >
      <div role="alert" aria-atomic="false" className="flex flex-col-reverse gap-2 pb-2 empty:pb-0">
        {items.filter((item) => item.type === 'error').map(renderItem)}
      </div>
      {/* A toast row contains block elements, which cannot be children of output. */}
      {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div role="status" aria-live="polite" className="flex flex-col-reverse gap-2">
        {items.filter((item) => item.type !== 'error').map(renderItem)}
      </div>
    </div>
  );
}
