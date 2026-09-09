/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PackagePlus, Palette, Puzzle } from 'lucide-react';
import { DropdownMenuCheckboxItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import type { RightPanel } from './useWorkspacePanelControls.js';

export function AuthorPanelMenuItems({ active, canEdit, onToggle }: {
  active: ReadonlySet<string>;
  canEdit: boolean;
  onToggle(panel: RightPanel): void;
}) {
  return <>
    <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Author</DropdownMenuLabel>
    <DropdownMenuCheckboxItem checked={active.has('appearance')} onCheckedChange={() => onToggle('appearance')}>
      <Palette className="h-4 w-4 mr-2" />Appearance
    </DropdownMenuCheckboxItem>
    <DropdownMenuCheckboxItem checked={active.has('addElement')} disabled={!canEdit} onCheckedChange={() => onToggle('addElement')}>
      <PackagePlus className="h-4 w-4 mr-2" />Add Element
    </DropdownMenuCheckboxItem>
    <DropdownMenuCheckboxItem checked={active.has('extensions')} onCheckedChange={() => onToggle('extensions')}>
      <Puzzle className="h-4 w-4 mr-2" />Extensions
    </DropdownMenuCheckboxItem>
  </>;
}
