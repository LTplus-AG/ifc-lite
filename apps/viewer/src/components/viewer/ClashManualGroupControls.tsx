/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChevronDown, ChevronRight, FilePlus, Focus, Pencil, Trash2, X } from 'lucide-react';
import type { Clash } from '@ifc-lite/clash';

interface ClashGroupHeaderProps {
  sectionKey: string;
  label: string;
  color?: string;
  count: number;
  collapsed: boolean;
  manualGroupId?: string;
  creatingTopic: boolean;
  onToggle: (key: string) => void;
  onFocus: (groupId: string) => void;
  onCreateBcf: (groupId: string) => void;
  onRename: (groupId: string, label: string) => void;
  onRemove: (groupId: string) => void;
}

export function ClashGroupHeader({
  sectionKey,
  label,
  color,
  count,
  collapsed,
  manualGroupId,
  creatingTopic,
  onToggle,
  onFocus,
  onCreateBcf,
  onRename,
  onRemove,
}: ClashGroupHeaderProps) {
  return (
    <div className="flex w-full items-center border-b border-border/60 text-xs font-medium">
      <button
        onClick={() => onToggle(sectionKey)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 hover:bg-muted/50"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
        <span className="truncate">{label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">{count}</span>
      </button>
      {manualGroupId && (
        <div className="flex items-center pr-1">
          <button className="p-1 text-muted-foreground hover:text-foreground" title="Focus every object in this group" onClick={() => onFocus(manualGroupId)}>
            <Focus className="h-3.5 w-3.5" />
          </button>
          <button className="p-1 text-muted-foreground hover:text-foreground" title="Create one BCF topic from this group" disabled={creatingTopic} onClick={() => onCreateBcf(manualGroupId)}>
            <FilePlus className="h-3.5 w-3.5" />
          </button>
          <button className="p-1 text-muted-foreground hover:text-foreground" title="Rename this group" onClick={() => onRename(manualGroupId, label)}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button className="p-1 text-muted-foreground hover:text-destructive" title="Ungroup these clashes" onClick={() => onRemove(manualGroupId)}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export function ClashGroupingCheckbox({
  clash,
  checked,
  onChange,
}: {
  clash: Clash;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center pl-2" title="Select this clash for manual grouping">
      <input
        type="checkbox"
        aria-label={`Select clash ${clash.a.name ?? clash.a.key} and ${clash.b.name ?? clash.b.key}`}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-primary"
      />
    </label>
  );
}

export function RemoveFromClashGroupButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="Remove this clash from the group" className="flex items-center px-2 text-muted-foreground hover:text-destructive">
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
