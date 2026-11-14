/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mobile layout (#9718): the viewport, the docked panel pane and the
 * command bar, placed by the form factor on one CSS grid
 * (`mobileShellLayout`). Split out of `ViewerLayout`, which keeps the desktop.
 *
 * The grid's children never change order or type, so rotating, folding and
 * unfolding restyle the shell without remounting the viewport (its WebGPU
 * canvas) and without closing an open panel; the store says which panel is
 * open, `MobilePanelHost` frames it for the current form factor.
 *
 * - Modal sheet (portrait, cover): the panels float over the viewport with a
 *   scrim that closes them.
 * - Side pane (landscape, near-tablet) and fold segment: the panels portal into
 *   the pane slot, which is beside the viewport or in the fold's other
 *   segment. No scrim: the model stays interactive beside an open panel.
 */

import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { selectHasModelsLoaded } from '@/hooks/model-presence';
import { mobileCommandPlacement, mobilePanelHost } from '@/lib/layout/form-factor';
import type { AnalysisExtensionDefinition } from '@/services/analysis-extensions';
import { ViewportContainer } from './ViewportContainer';
import { HierarchyPanel } from './HierarchyPanel';
import { MobileToolbar } from './MobileToolbar';
import { useVisualViewportBottomInset } from './MobileBottomSheet';
import { MobilePanelHost, MobilePaneSlotProvider } from './MobilePanelHost';
import { MobilePanelLauncher } from './MobilePanelLauncher';
import { MobilePanelSheet } from './MobilePanelSheet';
import { mobileShellLayout } from './mobile-shell-layout';

export function MobileShell({ analysisExtension }: { analysisExtension: AnalysisExtensionDefinition | null }) {
  const { t } = useTranslation();
  const formFactor = useViewerStore((s) => s.formFactor);
  const leftPanelCollapsed = useViewerStore((s) => s.leftPanelCollapsed);
  const rightPanelCollapsed = useViewerStore((s) => s.rightPanelCollapsed);
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);
  // Hide the Panels button while the empty-state "Load IFC" card shows. A boolean
  // selector, not `useIfc()`, which re-rendered the layout on every geometry update (#6232).
  const hasModelsLoaded = useViewerStore(selectHasModelsLoaded);
  // Keep the shell inside the visible viewport: on iOS Safari with the bottom URL bar,
  // innerHeight includes the bar, so the shell pads itself above the overlay once.
  const bottomViewportInset = useVisualViewportBottomInset();
  const [paneSlot, setPaneSlot] = useState<HTMLElement | null>(null);

  const placement = mobileCommandPlacement(formFactor);
  const host = mobilePanelHost(formFactor);
  const layout = mobileShellLayout(formFactor);
  const panelOpen = !leftPanelCollapsed || !rightPanelCollapsed;
  // A fold shows the Panels list inline in its control segment, model or not:
  // it covers nothing there.
  const showLauncher = !panelOpen && (hasModelsLoaded || host === 'segment');

  return (
    <div
      data-mobile-shell={placement}
      data-mobile-panel-host={host}
      className={layout.fixed ? 'fixed inset-0 grid' : 'flex-1 min-h-0 grid'}
      style={{ ...layout.shell, paddingBottom: bottomViewportInset }}
    >
      <MobilePaneSlotProvider value={paneSlot}>
        <div data-mobile-viewport className="relative min-h-0 min-w-0 overflow-hidden" style={{ gridArea: 'view' }}>
          <div className="h-full w-full">
            <ViewportContainer />
          </div>

          {/* A modal sheet's backdrop; a docked pane has none, the model stays interactive. */}
          {panelOpen && host === 'sheet' && (
            <button type="button" aria-label={t('shellChrome.layout.closePanelsAriaLabel')}
              className="absolute inset-0 z-30 border-0 bg-scrim/40 p-0 animate-in fade-in duration-200"
              onClick={() => {
                setLeftPanelCollapsed(true);
                setRightPanelCollapsed(true);
              }}
            />
          )}

          {!leftPanelCollapsed && (
            <MobilePanelHost title={t('shellChrome.layout.hierarchyLabel')} onClose={() => setLeftPanelCollapsed(true)}>
              <HierarchyPanel />
            </MobilePanelHost>
          )}

          {/* Whichever single panel is open. */}
          <MobilePanelSheet analysisExtension={analysisExtension} />

          {/* One entry point to every panel, Hierarchy and Properties included (#5853, #8802 R6). */}
          {showLauncher && <MobilePanelLauncher />}
        </div>

        {/* The docked pane's slot: beside the viewport, or the fold's other segment.
            Empty (no panel open) it is hidden, and its grid track collapses. */}
        <div
          ref={setPaneSlot}
          data-mobile-pane-slot
          className={`flex min-h-0 min-w-0 flex-col bg-background empty:hidden ${host === 'side-pane' ? 'border-l' : ''}`}
          style={{ gridArea: 'pane', ...layout.pane }}
        />
      </MobilePaneSlotProvider>

      <MobileToolbar placement={placement} style={{ gridArea: 'bar' }} />
    </div>
  );
}
