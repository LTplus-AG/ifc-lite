/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sidebar customizer popover (#1208).
 *
 * Lets the user reorder the activity bar (drag a row, or the keyboard up/down
 * buttons) and choose which panels appear in it (the eye toggle), plus reset
 * to defaults. A self-contained NON-MODAL popover (role="group") anchored to
 * the activity-bar footer — closes on an outside click or Escape, moves focus
 * into itself on open and restores it on close. The same store actions back the
 * inline drag in the activity bar, so the two stay consistent.
 */

import { useEffect, useRef, useState } from 'react';
import { GripVertical, Eye, EyeOff, RotateCcw, Lock, ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { getPanelDef } from '@/lib/panels/registry';

export function CustomizeSidebar({ onClose }: { onClose: () => void }) {
  const order = useViewerStore((s) => s.sidebarOrder);
  const hiddenIds = useViewerStore((s) => s.sidebarHiddenIds);
  const reorder = useViewerStore((s) => s.reorderSidebarPanel);
  const setShown = useViewerStore((s) => s.setPanelShownInSidebar);
  const resetLayout = useViewerStore((s) => s.resetSidebarLayout);

  const hidden = new Set(hiddenIds);
  const ref = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Move focus into the popover on open and restore it to the trigger on close.
  useEffect(() => {
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    ref.current?.focus();
    return () => {
      try { restoreFocusRef.current?.focus?.(); } catch (err) { console.debug('[sidebar] focus restore skipped:', err); }
    };
  }, []);

  // Close on outside click / Escape. The customize toggle button is excluded —
  // otherwise its own click would close the popover here (mousedown) and then
  // immediately reopen it (the button's click handler), so it could never close.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Exclude the whole activity bar: its icons (drag-reorder / hide-toggle)
      // and the customize toggle are part of the same customize surface, so
      // interacting with them must not dismiss the popover.
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !target.closest('[data-activity-bar]')
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer the mousedown listener a tick so the click that opened us doesn't close us.
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="group"
      tabIndex={-1}
      aria-label="Customize sidebar panels"
      className="absolute bottom-2 right-14 z-40 w-64 rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden outline-none"
    >
      <div className="flex items-center justify-between px-3 h-9 border-b border-border bg-muted/40">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Customize sidebar
        </span>
        <button
          type="button"
          onClick={() => resetLayout()}
          title="Reset to default order + show all"
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto py-1">
        {order.map((id, index) => {
          const def = getPanelDef(id);
          if (!def) return null;
          const Icon = def.Icon;
          const isHidden = hidden.has(id);
          const locked = id === 'properties';
          return (
            <div
              key={id}
              draggable
              onDragStart={() => setDragId(id)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (overId !== id) setOverId(id);
              }}
              onDrop={() => {
                if (dragId && dragId !== id) reorder(dragId as never, order.indexOf(id));
                setDragId(null);
                setOverId(null);
              }}
              className={cn(
                'group flex items-center gap-1.5 px-2 py-1.5 mx-1 rounded-md cursor-grab active:cursor-grabbing',
                dragId === id && 'opacity-40',
                overId === id && dragId && dragId !== id && 'ring-1 ring-primary/60',
                isHidden && 'opacity-50',
              )}
            >
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" aria-hidden />
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-xs flex-1 truncate">{def.title}</span>
              <button
                type="button"
                disabled={index === 0}
                onClick={() => reorder(id, index - 1)}
                aria-label={`Move ${def.title} up`}
                className="h-6 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25 disabled:pointer-events-none transition-colors"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={index === order.length - 1}
                onClick={() => reorder(id, index + 1)}
                aria-label={`Move ${def.title} down`}
                className="h-6 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25 disabled:pointer-events-none transition-colors"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => setShown(id, isHidden)}
                aria-label={locked ? `${def.title} is always shown` : `${isHidden ? 'Show' : 'Hide'} ${def.title}`}
                title={locked ? 'Always shown' : isHidden ? 'Show in sidebar' : 'Hide from sidebar'}
                className={cn(
                  'h-6 w-6 inline-flex items-center justify-center rounded transition-colors',
                  locked ? 'opacity-30' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {locked ? (
                  <Lock className="h-3.5 w-3.5" />
                ) : isHidden ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground select-none">
        Drag or use ▲▼ to reorder · the eye shows / hides
      </div>
    </div>
  );
}
