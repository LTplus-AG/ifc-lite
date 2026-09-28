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
 * The plan pane is `PlanView` (M2.4). In the '3d' layout a narrow strip
 * stays at the left edge to bring it back; 'plan' keeps a sliver of 3D so
 * the GPU view never unmounts.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, type PanelImperativeHandle } from 'react-resizable-panels';
import { useViewerStore } from '@/store';
import type { ModelLayout } from '@/store/slices/authoringSessionSidebar';
import { useTranslation } from '@/i18n';
import { PlanView } from '../plan/PlanView';

/**
 * Plan pane share per layout, in percent ('plan' keeps a sliver of 3D, so the
 * viewport stays mounted and visible). Panel sizes go in as `%` strings: a
 * bare number is pixels to react-resizable-panels v4.
 */
const PLAN_SIZE = { plan: 80, split: 40 } as const;

export function ModelWorkspaceSplit({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const inWorkspace = useViewerStore((s) => s.workspaceMode === 'model');
  const layout = useViewerStore((s) => s.modelLayout);
  const setModelLayout = useViewerStore((s) => s.setModelLayout);
  const planRef = useRef<PanelImperativeHandle>(null);
  const showPlan = inWorkspace && layout !== '3d';

  // Plan ↔ Split resizes the mounted pane; a pane that just mounted (from
  // '3d', or on entry) already opens at its layout's `defaultSize`.
  const shown = useRef<ModelLayout | null>(null);
  useEffect(() => {
    const previous = shown.current;
    shown.current = showPlan ? layout : null;
    if (showPlan && previous !== null && previous !== layout) planRef.current?.resize(`${PLAN_SIZE[layout === 'plan' ? 'plan' : 'split']}%`);
  }, [showPlan, layout]);

  return (
    // The strip sits OUTSIDE the panel group (a group lays out panels only);
    // it and the group keep fixed sibling slots, so toggling it never remounts the group.
    <div className="flex h-full min-w-0 flex-1">
      {inWorkspace && !showPlan && (
        <button
          type="button"
          data-model-show-plan
          aria-label={t('modelWorkspace.plan.show')}
          title={t('modelWorkspace.plan.show')}
          onClick={() => setModelLayout('split')}
          className="flex w-6 shrink-0 items-start justify-center border-r border-border bg-background pt-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelLeftOpen aria-hidden className="h-3.5 w-3.5" />
        </button>
      )}
      <PanelGroup orientation="horizontal" className="h-full min-w-0 flex-1" data-model-layout={showPlan ? layout : '3d'}>
        {showPlan && (
          <Panel id="model-plan-panel" panelRef={planRef} defaultSize={`${PLAN_SIZE[layout === 'plan' ? 'plan' : 'split']}%`} minSize="20%">
            <div data-model-plan-pane className="h-full w-full">
              <PlanView />
            </div>
          </Panel>
        )}
        {showPlan && (
          <PanelResizeHandle className="w-1.5 bg-border transition-colors hover:bg-primary/50 active:bg-primary/70 cursor-col-resize" />
        )}
        <Panel id="model-3d-panel" minSize="20%">
          {children}
        </Panel>
      </PanelGroup>
    </div>
  );
}
