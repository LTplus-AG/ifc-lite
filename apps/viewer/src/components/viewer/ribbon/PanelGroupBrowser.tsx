/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ribbon panel browser generated from the same task groups as the rail (#5873). */
import { BrowsePanels } from '@/icons';
import { useTranslation } from '@/i18n';
import { isCollabEnabled } from '@/lib/collab/config';
import { PANEL_GROUPS, WORKSPACE_PANELS } from '@/lib/panels/registry';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useViewerStore } from '@/store';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RibbonGroup, RibbonLargeButton } from './primitives';

export function PanelGroupBrowser() {
  const { t } = useTranslation();
  const { isOpen, openInHome, toggle } = usePanelControls();
  const sidebarMode = useViewerStore((state) => state.sidebarMode);
  const setSidebarMode = useViewerStore((state) => state.setSidebarMode);

  const activate = (id: (typeof WORKSPACE_PANELS)[number]['id'], region: (typeof WORKSPACE_PANELS)[number]['region']) => {
    if (region === 'side' && sidebarMode === 'collapsed') {
      setSidebarMode('expanded');
      openInHome(id, 'ribbon');
      return;
    }
    toggle(id, 'ribbon');
  };

  return (
    <RibbonGroup label={t('shellChrome.panelGroups.browse')}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RibbonLargeButton
            data-ribbon-content="panel-browser"
            icon={BrowsePanels}
            label={t('shellChrome.panelGroups.browse')}
            aria-label={t('shellChrome.panelGroups.browse')}
            hasMenu
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] w-72 overflow-y-auto">
          {PANEL_GROUPS.map((group, index) => {
            const panels = WORKSPACE_PANELS.filter((panel) =>
              panel.group === group.id && (panel.id !== 'collab' || isCollabEnabled()));
            if (panels.length === 0) return null;
            return (
              <DropdownMenuGroup key={group.id}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel data-panel-group={group.id} title={t(group.descriptionKey)}>
                  {t(group.labelKey)}
                </DropdownMenuLabel>
                {panels.map((panel) => (
                  <DropdownMenuCheckboxItem
                    key={panel.id}
                    data-panel-id={panel.id}
                    checked={isOpen(panel.id)}
                    onCheckedChange={() => activate(panel.id, panel.region)}
                  >
                    <panel.Icon className="mr-2 h-4 w-4" />
                    {t(panel.titleKey)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </RibbonGroup>
  );
}
