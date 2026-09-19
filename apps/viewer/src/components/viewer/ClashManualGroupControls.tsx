/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChevronDown, ChevronRight, FilePlus, Focus, Pencil, Trash2, X } from 'lucide-react';
import type { Clash } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';

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
  const { t } = useTranslation();
  return (
    <div className="flex w-full items-center border-b border-border/60 text-xs font-medium">
      <button
        onClick={() => onToggle(sectionKey)}
        aria-expanded={!collapsed}
        aria-label={t(collapsed ? 'clashGroups.expand' : 'clashGroups.collapse', { name: label })}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 hover:bg-muted/50"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
        <span className="truncate">{label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">{count}</span>
      </button>
      {manualGroupId && (
        <div className="flex items-center pr-1">
          <button className="p-1 text-muted-foreground hover:text-foreground" title={t('clashGroups.focus')} onClick={() => onFocus(manualGroupId)}>
            <Focus className="h-3.5 w-3.5" />
          </button>
          <button className="p-1 text-muted-foreground hover:text-foreground" title={t('clashGroups.createBcf')} disabled={creatingTopic} onClick={() => onCreateBcf(manualGroupId)}>
            <FilePlus className="h-3.5 w-3.5" />
          </button>
          <button className="p-1 text-muted-foreground hover:text-foreground" title={t('clashGroups.rename')} onClick={() => onRename(manualGroupId, label)}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button className="p-1 text-muted-foreground hover:text-destructive" title={t('clashGroups.ungroup')} onClick={() => onRemove(manualGroupId)}>
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
  const { t } = useTranslation();
  return (
    <label className="flex items-center pl-2" title={t('clashGroups.selectForGrouping')}>
      <input
        type="checkbox"
        aria-label={t('clashGroups.select', { first: clash.a.name ?? clash.a.key, second: clash.b.name ?? clash.b.key })}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-primary"
      />
    </label>
  );
}

export function RemoveFromClashGroupButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button onClick={onClick} title={t('clashGroups.removeMember')} className="flex items-center px-2 text-muted-foreground hover:text-destructive">
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
