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
 * The plan pane itself arrives with M2.4; until then it is a placeholder.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, type PanelImperativeHandle } from 'react-resizable-panels';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

/** Plan pane share per layout ('plan' keeps a sliver of 3D until M2.4 decides). */
const PLAN_SIZE = { plan: 80, split: 40 } as const;

export function ModelWorkspaceSplit({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const inWorkspace = useViewerStore((s) => s.workspaceMode === 'model');
  const layout = useViewerStore((s) => s.modelLayout);
  const planRef = useRef<PanelImperativeHandle>(null);
  const showPlan = inWorkspace && layout !== '3d';

  useEffect(() => {
    if (layout !== '3d') planRef.current?.resize(`${PLAN_SIZE[layout]}%`);
  }, [showPlan, layout]);

  return (
    <PanelGroup orientation="horizontal" className="h-full min-w-0 flex-1" data-model-layout={showPlan ? layout : '3d'}>
      {showPlan && (
        <Panel id="model-plan-panel" panelRef={planRef} defaultSize={PLAN_SIZE[layout === 'plan' ? 'plan' : 'split']} minSize={20}>
          <section
            data-model-plan-pane
            aria-label={t('modelWorkspace.plan.title')}
            className="flex h-full w-full items-center justify-center bg-background p-6"
          >
            <p className="max-w-[18rem] text-center text-xs text-muted-foreground">{t('modelWorkspace.plan.placeholder')}</p>
          </section>
        </Panel>
      )}
      {showPlan && (
        <PanelResizeHandle className="w-1.5 bg-border transition-colors hover:bg-primary/50 active:bg-primary/70 cursor-col-resize" />
      )}
      <Panel id="model-3d-panel" minSize={20}>
        {children}
      </Panel>
    </PanelGroup>
  );
}
