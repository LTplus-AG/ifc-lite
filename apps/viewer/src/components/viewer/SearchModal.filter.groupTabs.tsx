/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GroupTabs` — which `FilterGroup` the builder's rule list, AND/OR toggle
 * and add/remove-rule actions edit (#4904).
 *
 * Pulled out of `SearchModal.filter.builder.tsx` to stay under the
 * ~400-line module cap (`scripts/check-module-size.mjs`) once groups
 * needed their own toolbar row there. A `+` sits between tabs — the same
 * character the selector field's `+` union syntax uses — so a second
 * group added here is visibly the same union, not a different feature.
 */

import { X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { FilterRule } from '@ifc-lite/rules';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n';

export function GroupTabsPanel({ groups, activeIndex, onSelect, onRemove, children }: {
  groups: { rules: FilterRule[] }[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
  children: ReactNode;
}) {
  if (groups.length <= 1) return <div className="flex flex-col gap-3">{children}</div>;
  return (
    <Tabs value={String(activeIndex)} onValueChange={(value) => onSelect(Number(value))} className="flex flex-col gap-1">
      <GroupTabs groups={groups} activeIndex={activeIndex} />
      <TabsContent value={String(activeIndex)} className="order-2 mt-0 flex flex-col gap-3 pt-2">{children}</TabsContent>
      <GroupRemoveActions groups={groups} onRemove={onRemove} />
    </Tabs>
  );
}

function GroupTabs({
  groups,
  activeIndex,
}: {
  groups: { rules: FilterRule[] }[];
  activeIndex: number;
}) {
  const { t } = useTranslation();
  return (
    <TabsList className="flex h-auto flex-wrap items-center justify-start gap-1 bg-transparent p-0 text-[11px]" aria-label={t('filterGroups.tabsAriaLabel')}>
      {groups.map((g, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden className="px-0.5 text-muted-foreground">+</span>}
          <TabsTrigger
            value={String(i)}
            className={`flex items-center gap-1 rounded border px-2 py-1 ${
              i === activeIndex
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
          >
            {t('filterGroups.groupLabel', { index: i + 1 })}
            <span className="text-[10px] text-muted-foreground">({g.rules.length})</span>
          </TabsTrigger>
        </Fragment>
      ))}
    </TabsList>
  );
}

/** After the panel in DOM order, beside the tabs visually, for a direct Tab-to-panel path. */
function GroupRemoveActions({ groups, onRemove }: {
  groups: { rules: FilterRule[] }[];
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="order-1 flex flex-wrap items-center gap-1">
      {groups.map((_, i) => (
        <button
          key={i}
          type="button"
          aria-label={t('filterGroups.removeGroupAriaLabel', { index: i + 1 })}
          onClick={() => onRemove(i)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-zinc-100 hover:text-destructive dark:hover:bg-zinc-800"
        >
          <span>{t('filterGroups.groupLabel', { index: i + 1 })}</span>
          <X className="h-3 w-3" aria-hidden />
        </button>
      ))}
    </div>
  );
}
