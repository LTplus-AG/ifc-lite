/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { BarChart3, CalendarClock, FileCode2, FileSpreadsheet, type LucideIcon } from 'lucide-react';
import { DropdownMenuCheckboxItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';

/** Menu order and labels for the bottom strip's panels (the classic toolbar's "Workspace" group). */
const ITEMS: ReadonlyArray<{ id: BottomPanelId; label: string; Icon: LucideIcon }> = [
  { id: 'script', label: 'Script Editor', Icon: FileCode2 },
  { id: 'lists', label: 'Lists', Icon: FileSpreadsheet },
  { id: 'gantt', label: 'Schedule (Gantt)', Icon: CalendarClock },
  { id: 'charts', label: 'Charts', Icon: BarChart3 },
];

export function BottomPanelMenuItems({ active, onToggle }: {
  active: ReadonlySet<string>;
  onToggle(panel: BottomPanelId): void;
}) {
  return <>
    <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Workspace</DropdownMenuLabel>
    {ITEMS.map(({ id, label, Icon }) => (
      <DropdownMenuCheckboxItem key={id} checked={active.has(id)} onCheckedChange={() => onToggle(id)}>
        <Icon className="h-4 w-4 mr-2" />{label}
      </DropdownMenuCheckboxItem>
    ))}
  </>;
}
