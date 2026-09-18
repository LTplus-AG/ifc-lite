/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { BarChart3, CalendarClock, FileCode2, FileSpreadsheet, FileText, type LucideIcon } from 'lucide-react';
import { DropdownMenuCheckboxItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';

/**
 * Menu order and labels for the bottom strip's panels (the classic
 * toolbar's "Workspace" group). Translation keys, not text: this table is
 * a plain data module, so it carries a key per row and the component below
 * calls `t()` at render time (#4918 slice 2).
 */
const ITEMS: ReadonlyArray<{ id: BottomPanelId; labelKey: TranslationKey; Icon: LucideIcon }> = [
  { id: 'script', labelKey: 'workspacePanels.bottom.script', Icon: FileCode2 },
  { id: 'lists', labelKey: 'workspacePanels.bottom.lists', Icon: FileSpreadsheet },
  { id: 'gantt', labelKey: 'workspacePanels.bottom.gantt', Icon: CalendarClock },
  { id: 'charts', labelKey: 'workspacePanels.bottom.charts', Icon: BarChart3 },
  { id: 'document', labelKey: 'workspacePanels.bottom.document', Icon: FileText },
];

export function BottomPanelMenuItems({ active, onToggle }: {
  active: ReadonlySet<string>;
  onToggle(panel: BottomPanelId): void;
}) {
  const { t } = useTranslation();
  return <>
    <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('workspacePanels.workspaceLabel')}</DropdownMenuLabel>
    {ITEMS.map(({ id, labelKey, Icon }) => (
      <DropdownMenuCheckboxItem key={id} checked={active.has(id)} onCheckedChange={() => onToggle(id)}>
        <Icon className="h-4 w-4 mr-2" />{t(labelKey)}
      </DropdownMenuCheckboxItem>
    ))}
  </>;
}
