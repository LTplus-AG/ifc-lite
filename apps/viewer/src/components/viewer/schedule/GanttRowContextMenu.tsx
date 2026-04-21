/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttRowContextMenu — right-click menu for Gantt task rows.
 *
 * Design decisions:
 *   • The menu operates on *either* the right-clicked row OR the current
 *     Gantt multi-selection, depending on whether the clicked row was
 *     already part of the selection. Matches Finder/Windows Explorer
 *     semantics: right-clicking a non-selected item acts on just that
 *     item; right-clicking within a selection acts on the selection.
 *   • Menu is portal-rendered via Radix DropdownMenu so it escapes the
 *     Gantt's overflow container (which is `overflow: hidden`).
 *   • All commands route through `useGanttInteractions` so there's a
 *     single source of truth for "what does Isolate mean?" — no drift
 *     between keyboard, double-click, and this menu.
 */

import { useMemo } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Focus, MousePointerClick, Eye, EyeOff, X, ChevronRight,
} from 'lucide-react';
import { useViewerStore } from '@/store';
import type { GanttInteractionActions } from './useGanttInteractions';

export interface GanttContextMenuState {
  /** globalId of the task the user right-clicked. */
  taskGlobalId: string;
  /** Task display label (truncated to fit the menu header). */
  label: string;
  /** Viewport anchor { x, y } in page coordinates (from MouseEvent). */
  anchorX: number;
  anchorY: number;
}

interface GanttRowContextMenuProps {
  state: GanttContextMenuState | null;
  onClose: () => void;
  interactions: GanttInteractionActions;
}

/**
 * A portal-rendered context menu that opens at the given anchor. The
 * trigger is an invisible, zero-size element positioned absolutely — the
 * DropdownMenu renders its popup next to it.
 */
export function GanttRowContextMenu({
  state,
  onClose,
  interactions,
}: GanttRowContextMenuProps) {
  const selectedTaskGlobalIds = useViewerStore(s => s.selectedTaskGlobalIds);

  // Decide the effective target set: if right-click landed on an already-
  // selected row, operate on the whole selection; otherwise just that row.
  const targets = useMemo<string[]>(() => {
    if (!state) return [];
    if (selectedTaskGlobalIds.has(state.taskGlobalId) && selectedTaskGlobalIds.size > 1) {
      return Array.from(selectedTaskGlobalIds);
    }
    return [state.taskGlobalId];
  }, [state, selectedTaskGlobalIds]);

  if (!state) return null;

  const doWith = (fn: (ids: string[]) => void) => () => {
    fn(targets);
    onClose();
  };

  const singular = targets.length === 1;
  const suffix = singular ? '' : ` (${targets.length})`;

  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* Zero-size trigger anchored to the cursor position so the popup
          opens where the user right-clicked. */}
      <DropdownMenuTrigger asChild>
        <div
          style={{
            position: 'fixed',
            left: state.anchorX,
            top: state.anchorY,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} className="w-[220px]">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground truncate">
          {state.label}{!singular && <span className="ml-1 opacity-70">+{targets.length - 1} more</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={doWith(ids => interactions.isolateSelection(ids))}>
          <Eye className="h-3.5 w-3.5 mr-2" />
          Isolate in 3D{suffix}
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">I</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={doWith(ids => interactions.frameSelection(ids))}>
          <Focus className="h-3.5 w-3.5 mr-2" />
          Frame in 3D{suffix}
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">F</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={doWith(ids => interactions.selectInViewport(ids))}>
          <MousePointerClick className="h-3.5 w-3.5 mr-2" />
          Select in 3D{suffix}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={doWith(() => useViewerStore.getState().showAll())}
          className="text-xs"
        >
          <EyeOff className="h-3.5 w-3.5 mr-2" />
          Show everything (clear isolation)
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={doWith(() => interactions.clearGanttSelection())}
          className="text-xs"
        >
          <X className="h-3.5 w-3.5 mr-2" />
          Clear Gantt selection
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">Esc</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard?.writeText(state.taskGlobalId).catch(() => {});
            onClose();
          }}
          className="text-xs"
        >
          <ChevronRight className="h-3.5 w-3.5 mr-2" />
          Copy task globalId
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
