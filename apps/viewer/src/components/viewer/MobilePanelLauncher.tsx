/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mobile entry point to the panels (#5853, #8802 R6).
 *
 * Mobile has no rail. One labelled Panels button opens a sheet listing exactly
 * the panels the desktop rail shows (`useRailPanelIds`, one list for both),
 * Hierarchy and Properties included, and a tap opens that panel in its home
 * region, which the mobile sheet then shows.
 *
 * It used to be three 48px tiles (Hierarchy, Properties, Panels) stacked over
 * the model's top-left quarter with tracked-caps captions. The one button sits
 * at the bottom edge instead, level with the Home/zoom pill
 * (`MOBILE_NAV_ROW`), where a thumb reaches it and the model is not.
 *
 * The list opens wherever panels open (`MobilePanelHost`, #9718): a sheet on a
 * portrait phone, the docked pane beside the model in landscape and on a
 * near-tablet. In a fold the list has the control segment to itself while no
 * panel is open, so it is shown there inline and there is no button.
 */

import { useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useRailPanelIds } from '@/hooks/useRailPanelIds';
import { useBottomPanelFlags } from '@/hooks/useBottomPanelFlags';
import { activeBottomPanel } from '@/lib/panels/bottom-panels';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { MobilePanelHost } from './MobilePanelHost';
import { mobileNavRowStyle } from './mobile-overlay-layout';
import { mobileCommandPlacement, mobilePanelHost } from '@/lib/layout/form-factor';

export function MobilePanelLauncher() {
  const { t } = useTranslation();
  const placement = useViewerStore((s) => mobileCommandPlacement(s.formFactor));
  const host = useViewerStore((s) => mobilePanelHost(s.formFactor));
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);
  const { openInHome, closePanel } = usePanelControls();
  const openBottomPanel = activeBottomPanel(useBottomPanelFlags());
  const railIds = useRailPanelIds();
  const [listOpen, setListOpen] = useState(false);
  const inline = host === 'segment';

  const openMobilePanel = (id: WorkspacePanelId) => {
    setListOpen(false);
    if (getPanelDef(id)?.region === 'left') {
      setRightPanelCollapsed(true);
      openInHome(id);
      return;
    }
    setLeftPanelCollapsed(true);
    // The sheet shows an open bottom-strip panel before any side panel, so a
    // stale one would hide the panel just chosen.
    if (openBottomPanel && openBottomPanel !== id) closePanel(openBottomPanel);
    openInHome(id);
    setRightPanelCollapsed(false);
  };

  let prevGroup: string | null = null;
  return (
    <>
      {/* Named by its visible label, so what a sighted user reads is what a
          screen reader announces (WCAG 2.5.3). 44px tall: a phone target. */}
      {!inline && (
        <button
          type="button"
          aria-expanded={listOpen}
          data-mobile-panels-launcher
          className="absolute z-20 inline-flex h-11 items-center gap-2 rounded-md border border-border bg-background/90 pl-3 pr-4 text-sm font-medium text-foreground shadow-sm backdrop-blur-sm touch-manipulation active:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={mobileNavRowStyle(placement, 'right')}
          onClick={() => setListOpen((open) => !open)}
        >
          <LayoutGrid className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('shellChrome.layout.panelsLabel')}
        </button>
      )}
      {(listOpen || inline) && (
        <>
          {host === 'sheet' && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('shellChrome.layout.closePanelListAriaLabel')}
              className="absolute inset-0 bg-scrim/40 z-30 animate-in fade-in duration-200"
              onClick={() => setListOpen(false)}
            />
          )}
          <MobilePanelHost title={t('shellChrome.layout.panelsLabel')} onClose={inline ? undefined : () => setListOpen(false)}>
            <ul data-mobile-panel-list className="py-1">
              {railIds.map((id) => {
                const def = getPanelDef(id);
                if (!def) return null;
                const divider = prevGroup !== null && prevGroup !== def.group;
                prevGroup = def.group;
                return (
                  <li key={id} className={divider ? 'border-t border-border/70' : undefined}>
                    <button
                      className="flex w-full items-center gap-3 px-4 min-h-[44px] text-sm text-left active:bg-muted touch-manipulation"
                      onClick={() => openMobilePanel(id)}
                    >
                      <def.Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {t(def.titleKey)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </MobilePanelHost>
        </>
      )}
    </>
  );
}
