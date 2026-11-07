/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The unified sidebar's activity bar (#1208).
 *
 * A registry-driven vertical icon rail on the viewport's right edge — the
 * evolution of the #1200 panel switcher. Icons follow the user's custom order
 * (`sidebarOrder`) and visible set (`sidebarHiddenIds`), are grouped by task
 * with hairline dividers (the group name is the divider's accessible text and
 * tooltip), and exactly one icon, the panel shown in the right pane, carries
 * the active state (`ActivityBarItem`). Icons that don't fit the rail's height
 * go into an overflow menu rather than being clipped (#8802 R1). With no model
 * loaded, model-dependent panels wait in that menu, marked as needing one, so
 * the first screen's rail shows only what works without a model (#8802 R6).
 * The footer toggles customize mode, collapse, and a layout menu. In customize
 * mode every icon becomes drag-reorderable and gains an eye toggle inline (the
 * rail scrolls then).
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
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
import { resetLayout } from '@/store/layoutReset';
import { useTranslation } from '@/i18n';
import { usePanelControls } from '@/hooks/usePanelControls';
import { WORKSPACE_PANELS, getPanelDef, panelGroupDefinition, panelModelGateMode, type WorkspacePanelId } from '@/lib/panels/registry';
import { useRailPanelIds } from '@/hooks/useRailPanelIds';
import { pendingCompositionMutations } from '@/lib/layers/pending';
import { isViewerEmpty } from '@/lib/tours/demo-kit';
import { useTourStore } from '@/lib/tours/tour-store';
import { getTour } from '@/lib/tours/registry';
import { ActivityBarItem } from './ActivityBarItem';
import { ActivityBarOverflow } from './ActivityBarOverflow';
import { layoutRail } from './rail-overflow';
import { useEmptyStartFoldsSidebarPane } from '../welcome/useEmptyStartFold';
const CustomizeSidebar = lazy(() => import('./CustomizeSidebar').then(module => ({ default: module.CustomizeSidebar })));

/** Alt+N shortcut KEY per panel, by registry index (frozen since #1200): 1-9,
 *  then 0. Only the first ten registry entries get a shortcut; later
 *  additions (e.g. Hierarchy, #1267) have none, so the map is limited to the
 *  first ten. The label itself ('Alt+{key}') is composed at render time. */
const ALT_KEY = new Map<WorkspacePanelId, string>(
  WORKSPACE_PANELS.slice(0, 10).map((p, i) => [p.id, i < 9 ? String(i + 1) : '0']),
);

/** Panels that show nothing but a "start with a model" state on an empty
 *  viewer: the registry's takeover gate, plus Properties and Hierarchy whose
 *  own empty states the welcome tour anchors (`panelModelGateMode`). */
function needsModel(id: WorkspacePanelId): boolean {
  return panelModelGateMode(id) === 'takeover' || id === 'properties' || id === 'hierarchy' || id === 'measurements';
}

/** The icon list's height, tracked so overflowing icons can move to a menu. */
function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

export function ActivityBar() {
  const { t } = useTranslation();
  const order = useViewerStore((s) => s.sidebarOrder);
  const hiddenIds = useViewerStore((s) => s.sidebarHiddenIds);
  const mode = useViewerStore((s) => s.sidebarMode);
  const customizing = useViewerStore((s) => s.sidebarCustomizing);
  const setSidebarMode = useViewerStore((s) => s.setSidebarMode);
  const setSidebarCustomizing = useViewerStore((s) => s.setSidebarCustomizing);
  const setPanelShownInSidebar = useViewerStore((s) => s.setPanelShownInSidebar);
  const reorder = useViewerStore((s) => s.reorderSidebarPanel);
  const viewerEmpty = useViewerStore(isViewerEmpty);

  const { isOpen, panelLocation, toggle, openInHome, floatPanel, popOutPanel, activePanel, floatingIds, poppedIds } = usePanelControls();
  // The start screen folds a Properties-only pane (`SidebarDock`).
  const paneFolded = useEmptyStartFoldsSidebarPane();

  // Draft-awareness badge on the Layers icon (#1717 exposure): unpublished
  // composition edits are the moment the feature becomes relevant — surface
  // the count where the user already looks, like the Room peers badge.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const hasStack = useViewerStore((s) => s.layerStack.length > 0);
  const pendingLayerEdits = useMemo(() => {
    void mutationVersion;
    return hasStack ? pendingCompositionMutations().length : 0;
  }, [mutationVersion, hasStack]);

  const [dragId, setDragId] = useState<WorkspacePanelId | null>(null);
  const [overId, setOverId] = useState<WorkspacePanelId | null>(null);

  // One rail list for the activity bar and the mobile Panels sheet (#5853).
  const visibleIds = useRailPanelIds();

  // The single active item: the panel the right pane actually shows, derived
  // exactly as `SidebarPanelHost` derives it (the active panel, or Information
  // when that one is detached), and only while the pane is expanded and not
  // folded for the start screen. Panels docked elsewhere read as "open".
  const detached = (id: WorkspacePanelId) => floatingIds.has(id) || poppedIds.has(id);
  const paneShown: WorkspacePanelId | null = !detached(activePanel)
    ? activePanel
    : detached('properties') ? null : 'properties';
  const primaryId = mode === 'expanded' && !paneFolded ? paneShown : null;

  // Prefer the current tour anchor on the rail. If a short window forces it
  // into More, the menu opens so the resolver still finds its live anchor.
  const tourRailAnchor = useTourStore((s) => {
    if (!s.tourId || s.status === 'idle') return null;
    const anchor = getTour(s.tourId)?.steps[s.stepIndex]?.anchor;
    return anchor?.startsWith('activity-') ? (anchor.slice('activity-'.length) as WorkspacePanelId) : null;
  });

  const listRef = useRef<HTMLDivElement>(null);
  const listHeight = useElementHeight(listRef);
  const entries = useMemo(
    () => visibleIds.flatMap((id) => {
      const def = getPanelDef(id);
      return def ? [{ id, group: def.group }] : [];
    }),
    [visibleIds],
  );
  // Every open panel stays on the rail, read from the same `isOpen` that
  // draws the icons' open marks; on the empty start screen the panels that
  // need a model wait in More (`layoutRail`).
  const fit = useMemo(
    () => (customizing
      ? { visible: entries.map((e) => e.id), overflow: [], waiting: [] }
      : layoutRail(entries, listHeight, {
        anchors: [tourRailAnchor, primaryId],
        isOpen,
        waits: viewerEmpty ? needsModel : null,
      })),
    [customizing, entries, isOpen, listHeight, primaryId, tourRailAnchor, viewerEmpty],
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
    <div data-activity-bar className="relative flex flex-col items-center w-12 shrink-0 h-full border-l border-divider bg-panel">
      {/* Panels */}
      <div
        ref={listRef}
        className={cn(
          'flex-1 min-h-0 w-full overflow-x-hidden py-1.5 flex flex-col items-center gap-0.5',
          customizing ? 'overflow-y-auto' : 'overflow-y-hidden',
        )}
      >
        {fit.visible.map((id, index) => {
          const def = getPanelDef(id);
          if (!def) return null;
          const loc = panelLocation(id);
          const startsGroup = def.group !== prevGroup;
          prevGroup = def.group;
          const group = panelGroupDefinition(def.group);
          return (
            <div key={id} className="contents">
              {startsGroup && (
                // The group name is the divider's accessible text and tooltip:
                // a visible caption never fit the 48px rail (#8802 R1).
                <h3
                  data-panel-group={def.group}
                  title={`${t(group.labelKey)} · ${t(group.descriptionKey)}`}
                  className={cn('w-6 shrink-0', index > 0 ? 'my-1 h-px bg-divider' : 'h-0 overflow-hidden')}
                >
                  <span className="sr-only">{t(group.labelKey)}</span>
                </h3>
              )}
              <ActivityBarItem
                id={id}
                location={loc}
                open={isOpen(id)}
                active={id === primaryId}
                quiet={viewerEmpty && needsModel(id) && loc !== 'docked'}
                customizing={customizing}
                altKey={ALT_KEY.get(id)}
                badge={id === 'layers' ? pendingLayerEdits : undefined}
                dragging={dragId === id}
                dropTarget={overId === id && dragId !== null && dragId !== id}
                onActivate={() => (customizing ? setPanelShownInSidebar(id, false) : onIconClick(id))}
                onDragStart={() => customizing && setDragId(id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  // Only an icon reorder claims the drag; a file is the window's (#5845).
                  if (!customizing || !dragId) return;
                  e.preventDefault();
                  if (overId !== id) setOverId(id);
                }}
                onDrop={() => {
                  if (customizing && dragId && dragId !== id) reorder(dragId, order.indexOf(id));
                  setDragId(null);
                  setOverId(null);
                }}
              />
            </div>
          );
        })}
        {fit.overflow.length > 0 && (
          <ActivityBarOverflow ids={fit.overflow} locationOf={panelLocation} onSelect={onIconClick} waiting={fit.waiting} />
        )}
      </div>

      {/* Footer controls */}
      <div className="w-full shrink-0 border-t border-divider py-1.5 flex flex-col items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-sidebar-customize-toggle
              aria-label={t(customizing ? 'shellChrome.shared.doneCustomizing' : 'shellChrome.shared.customizeSidebar')}
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
          <TooltipContent side="left">
            {t(customizing ? 'shellChrome.shared.doneCustomizing' : 'shellChrome.shared.customizeSidebar')}
          </TooltipContent>
        </Tooltip>

        <FooterButton
          label={t(mode === 'collapsed' ? 'shellChrome.activityBar.expandSidebar' : 'shellChrome.shared.collapseToIcons')}
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
                  aria-label={t('shellChrome.activityBar.sidebarOptions')}
                  className="h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  <EllipsisVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="left">{t('shellChrome.activityBar.sidebarOptions')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="left" align="end" className="w-52">
            <DropdownMenuItem onSelect={() => setSidebarCustomizing(true)} className="gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              {t('shellChrome.activityBar.customizePanelsMenuItem')}
            </DropdownMenuItem>
            {hiddenIds.length > 0 && (
              <DropdownMenuItem
                onSelect={() => hiddenIds.forEach((id) => setPanelShownInSidebar(id, true))}
                className="gap-2"
              >
                <Eye className="h-4 w-4 text-muted-foreground" />
                {t('shellChrome.activityBar.showAllPanels', { count: hiddenIds.length })}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => resetLayout()} className="gap-2">
              <RotateCcw className="h-4 w-4 text-muted-foreground" />
              {t('shellChrome.activityBar.resetLayoutMenuItem')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Keyboard-accessible detach (the grip drag is mouse-only). */}
            <DropdownMenuItem onSelect={() => floatPanel(activePanel)} className="gap-2">
              <SquareArrowOutUpRight className="h-4 w-4 text-muted-foreground" />
              {t('shellChrome.activityBar.floatCurrentPanel')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => popOutPanel(activePanel)} className="gap-2">
              <MonitorUp className="h-4 w-4 text-muted-foreground" />
              {t('shellChrome.activityBar.popOutToAnotherScreen')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {customizing && <Suspense fallback={null}><CustomizeSidebar onClose={() => setSidebarCustomizing(false)} /></Suspense>}
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
