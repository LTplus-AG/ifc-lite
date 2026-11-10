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
 * HUD needs. In 3D alone the rail's Plan toggle brings the plan back
 * (disabled while there is no room for it).
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, type PanelImperativeHandle } from 'react-resizable-panels';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { PlanView } from '../plan/PlanView';
import { MODEL_3D_MIN_PX, PLAN_MIN_PX, effectiveModelLayout, planPaneWidth, publishSplitWidth, splitFits } from './model-layout';

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
  const entry = useViewerStore((s) => s.session?.entry);
  const pick = useViewerStore((s) => s.modelLayout);
  const picked = useViewerStore((s) => s.session?.layoutPicked === true);
  const inWorkspace = useViewerStore((s) => s.workspaceMode === 'model');
  const hostRef = useRef<HTMLDivElement>(null);
  const width = useWidth(hostRef);
  const layout = effectiveModelLayout(pick, width);
  const planRef = useRef<PanelImperativeHandle>(null);
  const showPlan = inWorkspace && layout !== '3d';
  useEffect(() => { publishSplitWidth(width); }, [width]);

  // Measure after entry has added the rail and inspector. This runs once per
  // session: reopening the sidebar is an intentional choice, kept until Split is picked again.
  useEffect(() => {
    if (!entry) return;
    const frame = requestAnimationFrame(() => {
      const s = useViewerStore.getState();
      const actual = hostRef.current?.getBoundingClientRect().width ?? 0;
      if (s.session?.entry === entry && s.modelLayout !== '3d' && actual > 0
        && !splitFits(actual) && s.sidebarMode === 'expanded') s.setSidebarMode('collapsed');
    });
    return () => cancelAnimationFrame(frame);
  }, [entry]);

  // Resizing in the commit that MOUNTS the plan pane throws ("Layout not found
  // for Panel"): the group has not registered it yet, and the throw blanked
  // the whole viewer (#6315). So a fresh mount resizes a frame later (the
  // group would otherwise restore the pane's last size, not this layout's),
  // and a plan <-> split switch (or a resize in Plan) on a mounted pane
  // resizes at once.
  const shown = useRef<'plan' | 'split' | null>(null);
  useEffect(() => {
    const next = showPlan ? layout : null;
    const prev = shown.current;
    shown.current = next;
    // Plan is "the plan as large as the 3D minimum allows": it follows the
    // width. Split keeps whatever the user dragged it to.
    if (!next || (prev === next && next !== 'plan')) return;
    const size = `${planPaneWidth(next, width)}px`;
    if (prev) {
      planRef.current?.resize(size);
      return;
    }
    const frame = requestAnimationFrame(() => planRef.current?.resize(size));
    return () => cancelAnimationFrame(frame);
  }, [showPlan, layout, width]);

  return (
    // A plain wrapper measured for `model-layout.ts`; the plan toggle is the rail's.
    <div ref={hostRef} data-model-split-width={width} className="flex h-full min-w-0 flex-1 flex-col">
      {inWorkspace && picked && pick !== '3d' && width > 0 && !splitFits(width) && (
        <output data-model-layout-notice className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground">{t('modelWorkspace.plan.noRoom')}</output>
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
          <PanelResizeHandle className="shell-splitter-v" />
        )}
        {/* Never narrower than its HUD needs (measured, `model-layout.ts`); bare numbers are px in v4, so sizes carry units. */}
        <Panel id="model-3d-panel" minSize={showPlan ? `${MODEL_3D_MIN_PX}px` : undefined}>
          {children}
        </Panel>
      </PanelGroup>
    </div>
  );
}
