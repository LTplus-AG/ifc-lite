/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Panel switcher (issue #1200): a compact icon rail on the right edge of the
 * viewport for jumping between workspace panels without crossing the screen to
 * the toolbar, plus a dropdown to pop a panel out into a floating window or
 * reset the layout. Pairs with the Alt+1..7 keyboard shortcuts.
 */

import { PanelsTopLeft, SquareArrowOutUpRight, RotateCcw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';

export function PanelSwitcher() {
  const { isOpen, toggleDocked, floatPanel, floatingIds } = usePanelControls();
  const resetDockLayout = useViewerStore((s) => s.resetDockLayout);

  return (
    <div className="absolute right-1 top-1/2 -translate-y-1/2 z-20 pointer-events-auto flex flex-col items-center gap-1 rounded-lg border border-border bg-background/85 backdrop-blur-sm p-1 shadow-lg">
      {WORKSPACE_PANELS.map((p, i) => {
        const open = isOpen(p.id);
        const floating = floatingIds.has(p.id);
        return (
          <Tooltip key={p.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={open}
                onClick={() => toggleDocked(p.id)}
                className={cn(
                  'relative h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors',
                  open ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <p.Icon className="h-4 w-4" />
                {floating && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {p.title}
              <span className="text-muted-foreground"> · Alt+{i + 1}{floating ? ' · floating' : ''}</span>
            </TooltipContent>
          </Tooltip>
        );
      })}

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <PanelsTopLeft className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="left">Pop out / layout</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="left" align="end" className="w-48">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Pop out as window
          </DropdownMenuLabel>
          {WORKSPACE_PANELS.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => floatPanel(p.id)} className="gap-2">
              <p.Icon className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1">{p.title}</span>
              <SquareArrowOutUpRight className="h-3.5 w-3.5 text-muted-foreground" />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => resetDockLayout()}
            disabled={floatingIds.size === 0}
            className="gap-2"
          >
            <RotateCcw className="h-4 w-4 text-muted-foreground" />
            Reset layout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
