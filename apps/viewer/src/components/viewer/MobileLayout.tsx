/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The narrow layout (#9718): the viewport, its sheets and floats, then the
 * command bar under it in thumb reach, or as a rail beside it on a phone on its
 * side.
 *
 * Desktop never renders it, so `ViewerLayout` loads this module lazily and its
 * mobile-only chrome stays out of the entry chunk (Perf ratchet ceilings,
 * `docs/guide/performance.md`). `ViewportContainer` and `HierarchyPanel` are
 * shared with desktop and stay in their own chunks.
 */

import type { AnalysisExtensionDefinition } from '@/services/analysis-extensions';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { selectHasModelsLoaded } from '@/hooks/model-presence';
import { mobileCommandPlacement } from '@/lib/layout/form-factor';
import { HierarchyPanel } from './HierarchyPanel';
import { ViewportContainer } from './ViewportContainer';
import { MobileToolbar } from './MobileToolbar';
import { MobileBottomSheet, useVisualViewportBottomInset } from './MobileBottomSheet';
import { MobilePanelLauncher } from './MobilePanelLauncher';
import { MobilePanelSheet } from './MobilePanelSheet';

export function MobileLayout({ analysisExtension }: { analysisExtension: AnalysisExtensionDefinition | null }) {
  const { t } = useTranslation();
  const commandPlacement = useViewerStore((s) => mobileCommandPlacement(s.formFactor));
  const leftPanelCollapsed = useViewerStore((s) => s.leftPanelCollapsed);
  const rightPanelCollapsed = useViewerStore((s) => s.rightPanelCollapsed);
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);

  // Keep the mobile shell inside the visible viewport. On iOS Safari with bottom URL bar, dvh/innerHeight INCLUDES
  // the URL bar area, so `bottom: 0` lands behind it; visualViewport.height excludes it. Applied once, to the
  // whole mobile shell (#9718): its command bar, sheets and floats all stop above the overlay.
  const bottomViewportInset = useVisualViewportBottomInset();

  // Hide mobile floating buttons when the empty-state "Load IFC" card shows.
  // A boolean selector, not `useIfc()`: that hook subscribes to `models` and
  // `geometryResult`, so every geometry update re-rendered the whole layout (#6232).
  const hasModelsLoaded = useViewerStore(selectHasModelsLoaded);

  return (
    <div data-mobile-shell={commandPlacement} style={{ paddingBottom: bottomViewportInset }}
      className={commandPlacement === 'side-rail' ? 'flex-1 min-h-0 flex flex-row' : 'flex-1 min-h-0 flex flex-col'}>
    <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden">
      {/* Full-screen Viewport */}
      <div className="h-full w-full">
        <ViewportContainer />
      </div>

      {/* Backdrop overlay when sheet is open */}
      {(!leftPanelCollapsed || !rightPanelCollapsed) && (
        <button type="button" aria-label={t('shellChrome.layout.closePanelsAriaLabel')}
          className="absolute inset-0 z-30 border-0 bg-scrim/40 p-0 animate-in fade-in duration-200"
          onClick={() => {
            setLeftPanelCollapsed(true);
            setRightPanelCollapsed(true);
          }}
        />
      )}

      {/* Mobile Bottom Sheet - Hierarchy */}
      {!leftPanelCollapsed && (
        <MobileBottomSheet
          title={t('shellChrome.layout.hierarchyLabel')}
          onClose={() => setLeftPanelCollapsed(true)}
        >
          <HierarchyPanel />
        </MobileBottomSheet>
      )}

      {/* Mobile Bottom Sheet — whichever single panel is open (`MobilePanelSheet`). */}
      <MobilePanelSheet analysisExtension={analysisExtension} />

      {/* Mobile Panels button: one entry point to every panel, Hierarchy and
          Properties included (#5853, #8802 R6). Hidden in the empty state so the
          "Load IFC" card stays unobstructed. */}
      {leftPanelCollapsed && rightPanelCollapsed && hasModelsLoaded && (
        <MobilePanelLauncher />
      )}
    </div>
    <MobileToolbar placement={commandPlacement} />
    </div>
  );
}
