/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The unified sidebar's activity bar (#1208).
 *
 * A registry-driven vertical icon rail on the viewport's right edge — the
 * evolution of the #1200 panel switcher. Icons follow the user's custom order
 * (`sidebarOrder`) and visible set (`sidebarHiddenIds`), cluster into groups
 * with dividers, highlight the active docked panel, and flag floating / popped
 * panels with a dot. The footer toggles customize mode, collapse, and a
 * layout menu. In customize mode every icon becomes drag-reorderable and
 * gains an eye toggle inline.
 */

import { useState } from 'react';
import {
  SlidersHorizontal,
  PanelRightClose,
  PanelRightOpen,
  EllipsisVertical,
  RotateCcw,
  Eye,
  SquareArrowOutUpRight,
  MonitorUp,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { WORKSPACE_PANELS, getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { isCollabEnabled } from '@/lib/collab/config';
import { activityAnchor, tourAnchor } from '@/lib/tours/anchors';
import { CustomizeSidebar } from './CustomizeSidebar';

/** Alt+N hint per panel, by registry index (frozen since #1200): 1-9, then 0.
 *  Only the first ten registry entries get a shortcut; later additions (e.g.
 *  Hierarchy, #1267) have none, so the map is limited to the first ten. */
const ALT_LABEL = new Map<WorkspacePanelId, string>(
  WORKSPACE_PANELS.slice(0, 10).map((p, i) => [p.id, i < 9 ? `Alt+${i + 1}` : 'Alt+0']),
);

export function ActivityBar() {
  const order = useViewerStore((s) => s.sidebarOrder);
  const hiddenIds = useViewerStore((s) => s.sidebarHiddenIds);
  const mode = useViewerStore((s) => s.sidebarMode);
  const customizing = useViewerStore((s) => s.sidebarCustomizing);
  const setSidebarMode = useViewerStore((s) => s.setSidebarMode);
  const setSidebarCustomizing = useViewerStore((s) => s.setSidebarCustomizing);
  const setPanelShownInSidebar = useViewerStore((s) => s.setPanelShownInSidebar);
  const reorder = useViewerStore((s) => s.reorderSidebarPanel);
  const resetLayout = useViewerStore((s) => s.resetSidebarLayout);
  // Layer-stack panel (#1717) only surfaces while a federated stack is loaded.
  const hasLayerStack = useViewerStore((s) => s.layerStack.length > 0);

  const { isOpen, panelLocation, toggle, openInHome, floatPanel, popOutPanel, activePanel } = usePanelControls();

  const hidden = new Set(hiddenIds);
  const [dragId, setDragId] = useState<WorkspacePanelId | null>(null);
  const [overId, setOverId] = useState<WorkspacePanelId | null>(null);

  // Hidden panels are removed from the rail in every mode (#1263), including
  // customize. Restoring a hidden panel happens in the Customize popover's
  // dedicated Hidden section, not by an inline greyed icon here. The collab
  // Room panel only surfaces while the collab feature flag is on.
  const visibleIds = order.filter(
    (id) =>
      (!hidden.has(id) || id === 'properties') &&
      (id !== 'collab' || isCollabEnabled()) &&
      (id !== 'layers' || hasLayerStack),
  );

  const onIconClick = (id: WorkspacePanelId) => {
    const region = getPanelDef(id)?.region;
    // The left nav panel (Hierarchy, #1267) lives in its own slot, so just
    // toggle it; it never affects the right-pane sidebar mode.
    if (region === 'left') {
      toggle(id);
      return;
    }
    // Bottom-region panels (Script / Schedule / Lists) open in the bottom strip
    // — their own region — without touching the right-pane sidebar mode.
    if (region === 'bottom') {
      toggle(id);
      return;
    }
    if (mode === 'collapsed') {
      // Collapsed icons open + expand the right pane; they never toggle off.
      setSidebarMode('expanded');
      openInHome(id);
      return;
    }
    toggle(id);
  };

  let prevGroup: string | null = null;

  return (
    <div data-activity-bar className="relative flex flex-col items-center w-12 shrink-0 h-full border-l border-border bg-background">
      {/* Panels */}
      <div className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden py-1.5 flex flex-col items-center gap-0.5">
        {visibleIds.map((id) => {
          const def = getPanelDef(id);
          if (!def) return null;
          const Icon = def.Icon;
          const loc = panelLocation(id);
          const active = loc === 'docked';
          const open = isOpen(id);
          const showDivider = prevGroup !== null && def.group !== prevGroup;
          prevGroup = def.group;

          // Accessible name: the Radix tooltip is NOT the button's name, and
          // tooltips don't fire on touch / for many SR users, so set it
          // explicitly. In customize mode the action is "hide" (only shown
          // panels render here now, #1263).
          const ariaLabel = customizing
            ? `${def.title}, activate to hide from the sidebar`
            : `${def.title}${loc === 'floating' ? ' (floating)' : loc === 'popped' ? ' (popped out)' : ''}`;

          return (
            <div key={id} className="contents">
              {showDivider && <div className="my-1 h-px w-6 bg-border/70" aria-hidden />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    {...tourAnchor(activityAnchor(id))}
                    aria-label={ariaLabel}
                    aria-pressed={active}
                    draggable={customizing && id !== 'properties'}
                    onDragStart={() => customizing && setDragId(id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                    }}
                    onDragOver={(e) => {
                      if (!customizing) return;
                      e.preventDefault();
                      if (overId !== id) setOverId(id);
                    }}
                    onDrop={() => {
                      if (customizing && dragId && dragId !== id) reorder(dragId, order.indexOf(id));
                      setDragId(null);
                      setOverId(null);
                    }}
                    onClick={() => (customizing ? setPanelShownInSidebar(id, false) : onIconClick(id))}
                    className={cn(
                      'relative h-9 w-9 inline-flex items-center justify-center rounded-md transition-colors',
                      active
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      customizing && 'cursor-grab active:cursor-grabbing',
                      dragId === id && 'opacity-40',
                      overId === id && dragId && dragId !== id && 'ring-1 ring-primary/60',
                    )}
                  >
                    {/* Active accent bar (VS Code idiom) */}
                    {active && !customizing && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-primary" aria-hidden />
                    )}
                    <Icon className="h-4 w-4" />
                    {/* Detached indicator dot — floating (primary) vs popped out (emerald). */}
                    {!customizing && open && loc !== 'docked' && (
                      <span
                        className={cn(
                          'absolute -right-0 -top-0 h-1.5 w-1.5 rounded-full ring-1 ring-background',
                          loc === 'popped' ? 'bg-emerald-500' : 'bg-primary',
                        )}
                        aria-hidden
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {def.title}
                  <span className="text-muted-foreground">
                    {customizing
                      ? ' · click to hide'
                      : `${ALT_LABEL.get(id) ? ` · ${ALT_LABEL.get(id)}` : ''}${loc === 'floating' ? ' · floating' : loc === 'popped' ? ' · popped out' : ''}`}
                  </span>
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>

      {/* Footer controls */}
      <div className="w-full shrink-0 border-t border-border py-1.5 flex flex-col items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-sidebar-customize-toggle
              aria-label={customizing ? 'Done customizing' : 'Customize sidebar'}
              aria-pressed={customizing}
              onClick={() => setSidebarCustomizing(!customizing)}
              className={cn(
                'h-9 w-9 inline-flex items-center justify-center rounded-md transition-colors',
                customizing ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{customizing ? 'Done customizing' : 'Customize sidebar'}</TooltipContent>
        </Tooltip>

        <FooterButton
          label={mode === 'collapsed' ? 'Expand sidebar' : 'Collapse to icons'}
          onClick={() => setSidebarMode(mode === 'collapsed' ? 'expanded' : 'collapsed')}
        >
          {mode === 'collapsed' ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
        </FooterButton>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Sidebar options"
                  className="h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  <EllipsisVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="left">Sidebar options</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="left" align="end" className="w-52">
            <DropdownMenuItem onSelect={() => setSidebarCustomizing(true)} className="gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              Customize panels…
            </DropdownMenuItem>
            {hiddenIds.length > 0 && (
              <DropdownMenuItem
                onSelect={() => hiddenIds.forEach((id) => setPanelShownInSidebar(id, true))}
                className="gap-2"
              >
                <Eye className="h-4 w-4 text-muted-foreground" />
                Show all panels ({hiddenIds.length} hidden)
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => resetLayout()} className="gap-2">
              <RotateCcw className="h-4 w-4 text-muted-foreground" />
              Reset layout
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Keyboard-accessible detach (the grip drag is mouse-only). */}
            <DropdownMenuItem onSelect={() => floatPanel(activePanel)} className="gap-2">
              <SquareArrowOutUpRight className="h-4 w-4 text-muted-foreground" />
              Float current panel
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => popOutPanel(activePanel)} className="gap-2">
              <MonitorUp className="h-4 w-4 text-muted-foreground" />
              Pop out to another screen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {customizing && <CustomizeSidebar onClose={() => setSidebarCustomizing(false)} />}
    </div>
  );
}

function FooterButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            'h-9 w-9 inline-flex items-center justify-center rounded-md transition-colors',
            active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
