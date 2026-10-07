/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from '@/i18n';
import { FACETS, type FacetKey, type FacetOption, type ReviewFilter } from '@/lib/review/facets';
import { FACET_KEY, facetValueLabel } from './review-labels';

/** One disclosure per facet; options and counts come from the snapshot, counts are cards. */
export function ReviewFilters({ options, filter, onChange }: {
  options: Record<FacetKey, FacetOption[]>; filter: ReviewFilter; onChange: (next: ReviewFilter) => void;
}) {
  const { t } = useTranslation();
  const active = FACETS.some(facet => (filter[facet]?.length ?? 0) > 0);
  const toggle = (facet: FacetKey, value: string, on: boolean) => {
    const current = filter[facet] ?? [];
    onChange({ ...filter, [facet]: on ? [...current, value] : current.filter(item => item !== value) });
  };
  return (
    <fieldset aria-label={t('reviewWorkspace.filters')} className="px-3 py-2 border-b border-border min-w-0 space-y-1" data-review-filters>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {FACETS.filter(facet => options[facet].length > 0).map(facet => {
          const selected = filter[facet]?.length ?? 0;
          return (
            <details key={facet} className="text-2xs min-w-0">
              <summary className="cursor-pointer select-none rounded px-1 py-0.5 hover:bg-muted focus-visible:outline focus-visible:outline-2"
                aria-label={selected ? t('reviewWorkspace.facetSelected', { facet: t(FACET_KEY[facet]), count: selected }) : t(FACET_KEY[facet])}>
                {t(FACET_KEY[facet])}{selected > 0 && <span className="ml-1 tabular-nums text-primary">({selected})</span>}
              </summary>
              <ul className="mt-1 max-h-40 overflow-y-auto space-y-0.5 pl-1">
                {options[facet].map(option => (
                  <li key={option.value}>
                    <Checkbox checked={filter[facet]?.includes(option.value) ?? false} onCheckedChange={on => toggle(facet, option.value, on)}
                      label={t('reviewWorkspace.facetOption', { label: facetValueLabel(t, facet, option.value, option.label), cards: option.cards })} />
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
      {active && <Button size="sm" variant="ghost" onClick={() => onChange({})}>{t('reviewWorkspace.clearFilters')}</Button>}
    </fieldset>
  );
}
