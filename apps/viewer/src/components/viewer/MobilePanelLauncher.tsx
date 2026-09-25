/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mobile entry points to the panels (#5853).
 *
 * Mobile has no rail, and it used to offer only two hard-coded floating
 * buttons, Hierarchy and Properties; every other registry panel was
 * unreachable on a phone. The Panels button opens a sheet listing exactly the
 * panels the desktop rail shows (`useRailPanelIds`, one list for both), and a
 * tap opens that panel in its home region, which the mobile sheet then shows.
 */

import { useState, type ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useRailPanelIds } from '@/hooks/useRailPanelIds';
import { useBottomPanelFlags } from '@/hooks/useBottomPanelFlags';
import { activeBottomPanel } from '@/lib/panels/bottom-panels';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { MobileBottomSheet } from './MobileBottomSheet';

function FloatingButton({ icon, label, ariaLabel, onClick }: { icon: ReactNode; label: string; ariaLabel: string; onClick: () => void }) {
  return (
    <button className="flex flex-col items-center gap-1 group touch-manipulation" onClick={onClick} aria-label={ariaLabel}>
      <span className="grid place-items-center min-h-[44px] min-w-[44px] bg-background/90 backdrop-blur-sm border border-border rounded-md group-active:bg-foreground group-active:text-background transition-colors">
        {icon}
      </span>
      <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground leading-none">{label}</span>
    </button>
  );
}

export function MobilePanelLauncher({ bottomInset }: { bottomInset: number }) {
  const { t } = useTranslation();
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);
  const { openInHome, closePanel } = usePanelControls();
  const openBottomPanel = activeBottomPanel(useBottomPanelFlags());
  const railIds = useRailPanelIds();
  const [listOpen, setListOpen] = useState(false);

  const openFromList = (id: WorkspacePanelId) => {
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
      <div className="absolute top-4 left-4 flex flex-col gap-2.5 z-20">
        <FloatingButton
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h7" /></svg>}
          label={t('shellChrome.layout.hierarchyLabel')}
          ariaLabel={t('shellChrome.layout.openHierarchyAriaLabel')}
          onClick={() => { setRightPanelCollapsed(true); setLeftPanelCollapsed(false); }}
        />
        <FloatingButton
          icon={<svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
          label={t('shellChrome.layout.propertiesLabel')}
          ariaLabel={t('shellChrome.layout.openPropertiesAriaLabel')}
          onClick={() => { setLeftPanelCollapsed(true); setRightPanelCollapsed(false); }}
        />
        <FloatingButton
          icon={<LayoutGrid className="h-5 w-5" />}
          label={t('shellChrome.layout.panelsLabel')}
          ariaLabel={t('shellChrome.layout.openPanelsAriaLabel')}
          onClick={() => setListOpen(true)}
        />
      </div>
      {listOpen && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('shellChrome.layout.closePanelsAriaLabel')}
            className="absolute inset-0 bg-black/40 z-30 animate-in fade-in duration-200"
            onClick={() => setListOpen(false)}
          />
          <MobileBottomSheet title={t('shellChrome.layout.panelsLabel')} bottomInset={bottomInset} onClose={() => setListOpen(false)}>
            <ul className="py-1">
              {railIds.map((id) => {
                const def = getPanelDef(id);
                if (!def) return null;
                const divider = prevGroup !== null && prevGroup !== def.group;
                prevGroup = def.group;
                return (
                  <li key={id} className={divider ? 'border-t border-border/70' : undefined}>
                    <button
                      className="flex w-full items-center gap-3 px-4 min-h-[44px] text-sm text-left active:bg-muted touch-manipulation"
                      onClick={() => openFromList(id)}
                    >
                      <def.Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {def.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </MobileBottomSheet>
        </>
      )}
    </>
  );
}
