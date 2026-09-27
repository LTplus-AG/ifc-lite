/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { BarChart3, CalendarClock, FileCode2, FileSpreadsheet, FileText, PencilRuler, Workflow, type LucideIcon } from 'lucide-react';
import { DropdownMenuCheckboxItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import { panelTitleKey } from '@/lib/panels/registry';

/**
 * Menu order for the bottom strip's panels (the classic toolbar's
 * "Workspace" group); names come from the workspace-panel registry.
 */
const ITEMS: ReadonlyArray<{ id: BottomPanelId; Icon: LucideIcon }> = [
  { id: 'script', Icon: FileCode2 },
  { id: 'lists', Icon: FileSpreadsheet },
  { id: 'gantt', Icon: CalendarClock },
  { id: 'charts', Icon: BarChart3 },
  { id: 'document', Icon: FileText },
  { id: 'drawing', Icon: PencilRuler },
  { id: 'flow', Icon: Workflow },
];

export function BottomPanelMenuItems({ active, onToggle }: {
  active: ReadonlySet<string>;
  onToggle(panel: BottomPanelId): void;
}) {
  const { t } = useTranslation();
  return <>
    <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('workspacePanels.workspaceLabel')}</DropdownMenuLabel>
    {ITEMS.map(({ id, Icon }) => (
      <DropdownMenuCheckboxItem key={id} checked={active.has(id)} onCheckedChange={() => onToggle(id)}>
        <Icon className="h-4 w-4 mr-2" />{t(panelTitleKey(id))}
      </DropdownMenuCheckboxItem>
    ))}
  </>;
}
