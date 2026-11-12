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

import { useSyncExternalStore } from 'react';
import { Check, AlertCircle, Info, X } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { dismiss, getToasts, subscribeToasts, type Toast } from './toast-store';
export { toast } from './toast-store';

// ─── React Component ──────────────────────────────────────────────────────

export function useToastItems(): Toast[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts);
}

const iconMap = {
  success: Check,
  error: AlertCircle,
  info: Info,
};

const colorMap = {
  success: 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-200',
  error: 'border-red-500/50 bg-red-50 dark:bg-red-950/80 text-red-800 dark:text-red-200',
  info: 'border-zinc-300 dark:border-zinc-700 bg-white text-zinc-800 dark:text-zinc-200',
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

/** Shared rows for the app anchor and modal-owned notice shelf (#9875). */
export function ToastMessages({ items }: { items: Toast[] }) {
  const { t } = useTranslation();
  const renderItem = (item: Toast) => {
    const Icon = iconMap[item.type];
    const actions = Array.isArray(item.action) ? item.action : item.action ? [item.action] : [];
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
        <span className="text-xs font-medium flex-1 min-w-0 break-words">{item.message}</span>
        {item.count > 1 && (
          <span className="shrink-0 text-2xs font-semibold tabular-nums opacity-70" aria-hidden="true">
            ×{item.count}
          </span>
        )}
        {actions.map((action) => (
          <Button key={action.label} size="sm" variant="link"
            onClick={() => {
              action.onClick();
              if (action.dismiss !== false) dismiss(item.id);
            }}
            className="shrink-0 min-h-6 rounded-sm px-1 text-xs font-semibold underline underline-offset-2 hover:bg-black/10 dark:hover:bg-white/10"
          >
            {action.label}
          </Button>
        ))}
        <button
          onClick={() => dismiss(item.id)}
          aria-label={t('viewerShell.toast.dismiss')}
          className="shrink-0 min-h-6 min-w-6 p-0.5 rounded-sm hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    );
  };

  return <>
      <div role="alert" aria-atomic="false" className="flex flex-col-reverse gap-2 pb-2 empty:pb-0">
        {items.filter((item) => item.type === 'error').map(renderItem)}
      </div>
      {/* A toast row contains block elements, which cannot be children of output. */}
      {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div role="status" aria-live="polite" className="flex flex-col-reverse gap-2">
        {items.filter((item) => item.type !== 'error').map(renderItem)}
      </div>
  </>;
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
  const items = useToastItems().filter((item) => !item.dialogId);
  return (
    <div data-toast-anchor className={cn(
      'bottom-4 right-4 z-(--z-toast) flex flex-col pointer-events-none max-w-sm',
      variant === 'absolute' ? 'absolute' : 'fixed',
    )}>
      <ToastMessages items={items} />
    </div>
  );
}
