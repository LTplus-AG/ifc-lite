/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's Plan ‖ 3D split (charter #6232, M2 §1.2): the 3D
 * viewport on the right, the storey plan on the left, 40/60 by default, in
 * the layout the session slice holds (`modelLayout`, persisted). Outside the
 * workspace, or in the '3d' layout, the viewport has the panel to itself.
 *
 * The viewport (`children`) keeps ONE position in the tree whatever the
 * layout: the plan pane and its handle are optional siblings before it, so
 * switching layouts never remounts the 3D view (and its GPU device) — the
 * side-by-side drawing preset's branch swap does, which is why this is not
 * built the same way.
 *
 * The plan pane is `PlanView` (M2.4). Which layout shows, and the pane
 * sizes, follow `model-layout.ts`: the 3D pane never gets narrower than its
 * HUD needs. In 3D alone a narrow strip at the left edge brings the plan back
 * (disabled while there is no room for it).
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, type PanelImperativeHandle } from 'react-resizable-panels';
import { useViewerStore } from '@/store';
import type { ModelLayout } from '@/store/slices/authoringSessionSidebar';
import { useTranslation } from '@/i18n';
import { PlanView } from '../plan/PlanView';
import { MODEL_3D_MIN_PX, PLAN_MIN_PX, effectiveModelLayout, planPaneWidth, splitFits } from './model-layout';

/** The split's own width (the viewport panel beside the rail), kept current. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function ModelWorkspaceSplit({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const inWorkspace = useViewerStore((s) => s.workspaceMode === 'model');
  const setModelLayout = useViewerStore((s) => s.setModelLayout);
  const hostRef = useRef<HTMLDivElement>(null);
  const width = useWidth(hostRef);
  const layout = effectiveModelLayout(useViewerStore((s) => s.modelLayout), width);
  const planRef = useRef<PanelImperativeHandle>(null);
  const showPlan = inWorkspace && layout !== '3d';
  const fits = splitFits(width);

  // Plan ↔ Split resizes the mounted pane; a pane that just mounted (from
  // '3d', or on entry) already opens at its layout's `defaultSize`.
  const shown = useRef<ModelLayout | null>(null);
  useEffect(() => {
    const previous = shown.current;
    shown.current = showPlan ? layout : null;
    if (showPlan && previous !== null && previous !== layout) planRef.current?.resize(`${planPaneWidth(layout, width)}px`);
  }, [showPlan, layout, width]);

  return (
    // The strip sits OUTSIDE the panel group (a group lays out panels only);
    // it and the group keep fixed sibling slots, so toggling it never remounts the group.
    <div ref={hostRef} data-model-split-width={width} className="flex h-full min-w-0 flex-1">
      {inWorkspace && !showPlan && (
        <button
          type="button"
          data-model-show-plan
          disabled={!fits}
          aria-label={t('modelWorkspace.plan.show')}
          title={fits ? t('modelWorkspace.plan.show') : t('modelWorkspace.plan.noRoom')}
          onClick={() => setModelLayout('split')}
          className="flex w-6 shrink-0 items-start justify-center border-r border-border bg-background pt-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <PanelLeftOpen aria-hidden className="h-3.5 w-3.5" />
        </button>
      )}
      <PanelGroup orientation="horizontal" className="h-full min-w-0 flex-1" data-model-layout={showPlan ? layout : '3d'}>
        {showPlan && (
          <Panel id="model-plan-panel" panelRef={planRef} defaultSize={`${planPaneWidth(layout, width)}px`} minSize={`${PLAN_MIN_PX}px`}>
            <div data-model-plan-pane className="h-full w-full">
              <PlanView layout={layout} />
            </div>
          </Panel>
        )}
        {showPlan && (
          <PanelResizeHandle className="w-1.5 bg-border transition-colors hover:bg-primary/50 active:bg-primary/70 cursor-col-resize" />
        )}
        {/* Never narrower than its HUD needs (measured, `model-layout.ts`); bare numbers are px in v4, so sizes carry units. */}
        <Panel id="model-3d-panel" minSize={showPlan ? `${MODEL_3D_MIN_PX}px` : undefined}>
          {children}
        </Panel>
      </PanelGroup>
    </div>
  );
}
