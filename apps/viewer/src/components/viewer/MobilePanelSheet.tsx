/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The narrow layout's panel sheet: whichever single panel is open, rendered
 * through the shared id → body map every other host uses. Moved out of
 * `ViewerLayout` (#6926) so the narrow-layout journeys (Assistant sheet with
 * its return target, drafts and selection surviving a switch) can be mounted
 * in tests without the WebGPU viewport.
 *
 * Analysis extensions are not registry panels, so they keep their own branch.
 */

import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useBottomPanelFlags } from '@/hooks/useBottomPanelFlags';
import { activeBottomPanel } from '@/lib/panels/bottom-panels';
import { getPanelDef } from '@/lib/panels/registry';
import { resolveMobileSheet } from '@/lib/panels/mobileSheet';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { closeActiveAnalysisExtension, type AnalysisExtensionDefinition } from '@/services/analysis-extensions';
import { MobileBottomSheet } from './MobileBottomSheet';

export function MobilePanelSheet({ bottomInset, analysisExtension }: {
  bottomInset: number;
  /** The active analysis extension (either placement), which owns the sheet when present. */
  analysisExtension: AnalysisExtensionDefinition | null;
}) {
  const { t } = useTranslation();
  const rightPanelCollapsed = useViewerStore((s) => s.rightPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);
  const sidebarActivePanel = useViewerStore((s) => s.sidebarActivePanel);
  const bottomPanel = activeBottomPanel(useBottomPanelFlags());
  const { closePanel } = usePanelControls();
  const sheet = useMemo(() => resolveMobileSheet({
    hasAnalysisExtension: analysisExtension !== null,
    bottomPanel,
    sidebarActivePanel,
  }), [analysisExtension, bottomPanel, sidebarActivePanel]);
  if (rightPanelCollapsed) return null;
  return (
    <MobileBottomSheet
      title={sheet.kind === 'extension' ? (analysisExtension?.label ?? t('shellChrome.layout.analysisFallback')) : t(getPanelDef(sheet.id)?.titleKey ?? 'properties.panel.title')}
      bottomInset={bottomInset}
      onClose={() => {
        setRightPanelCollapsed(true);
        // Close ONLY what the sheet is showing.
        if (sheet.kind === 'extension') closeActiveAnalysisExtension();
        // Clears the dock flag AND float/pop-out channels, so closing the sheet
        // can't leave the panel open where the phone has no room to show it.
        else closePanel(sheet.id);
      }}
    >
      {sheet.kind === 'extension'
        ? analysisExtension?.renderPanel({ onClose: closeActiveAnalysisExtension })
        : renderPanelBody(sheet.id, () => closePanel(sheet.id))}
    </MobileBottomSheet>
  );
}
