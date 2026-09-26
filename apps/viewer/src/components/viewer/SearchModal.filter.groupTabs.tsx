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
import type { FilterRule } from '@ifc-lite/rules';
import { useTranslation } from '@/i18n';

export function GroupTabs({
  groups,
  activeIndex,
  onSelect,
  onRemove,
}: {
  groups: { rules: FilterRule[] }[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1 text-2xs" role="tablist" aria-label={t('filterGroups.tabsAriaLabel')}>
      {groups.map((g, i) => (
        <div key={i} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className="px-0.5 text-muted-foreground">+</span>}
          <button
            type="button"
            role="tab"
            aria-selected={i === activeIndex}
            onClick={() => onSelect(i)}
            className={`flex items-center gap-1 rounded border px-2 py-1 ${
              i === activeIndex
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
          >
            {t('filterGroups.groupLabel', { index: i + 1 })}
            <span className="text-2xs text-muted-foreground">({g.rules.length})</span>
          </button>
          {groups.length > 1 && (
            <button
              type="button"
              aria-label={t('filterGroups.removeGroupAriaLabel', { index: i + 1 })}
              onClick={() => onRemove(i)}
              className="rounded p-0.5 text-muted-foreground hover:bg-zinc-100 hover:text-destructive dark:hover:bg-zinc-800"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
