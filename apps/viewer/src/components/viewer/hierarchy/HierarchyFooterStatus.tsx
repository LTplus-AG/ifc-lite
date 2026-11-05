/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy panel's footer status strip: active storey/class/type-filter
 * chips with per-chip clear buttons when any filter is active, nothing
 * otherwise. Both the multi-model and single-model layouts in
 * `HierarchyPanel.tsx` rendered this same block (only the idle hint's copy
 * and one text-color shade differed) — extracted verbatim (#5883 review:
 * kept HierarchyPanel under its module-size allowlist row rather than
 * growing it for the new ARIA tree / keyboard-nav wiring).
 */

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

export interface HierarchyFooterStatusProps {
  hasActiveFilters: boolean;
  selectedStoreys: ReadonlySet<number>;
  classFilter: { ids: Set<number>; label: string } | null;
  isolatedEntities: Set<number> | null;
  typeIsolationLabel: string | null;
  clearStoreySelection: () => void;
  clearClassFilter: () => void;
  clearIsolation: () => void;
  clearAllFilters: () => void;
}

export function HierarchyFooterStatus({
  hasActiveFilters,
  selectedStoreys,
  classFilter,
  isolatedEntities,
  typeIsolationLabel,
  clearStoreySelection,
  clearClassFilter,
  clearIsolation,
  clearAllFilters,
}: HierarchyFooterStatusProps) {
  const { t } = useTranslation();

  // Idle, the strip used to pin a permanent "Click to select · Ctrl toggle"
  // hint under the tree. Selection is discoverable from the rows themselves,
  // so idle shows nothing and the tree gets the room (#8802).
  if (!hasActiveFilters) return null;

  // Active filters: a neutral strip with primary-tinted chips (sentence case),
  // so the filter reads as state without out-shouting the selection.
  const chip = 'inline-flex items-center gap-1 rounded-sm bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-foreground';
  const clear = 'ml-0.5 text-xs leading-none text-muted-foreground hover:text-foreground';
  return (
    <div className="border-t border-border bg-muted/50 px-2 py-1.5">
      <div className="flex items-center justify-between text-xs gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          {selectedStoreys.size > 0 && (
            <span className={chip}>
              {t('hierarchy.panel.storeyCount', { count: selectedStoreys.size })}
              <button onClick={clearStoreySelection} className={clear} aria-label={t('hierarchy.panel.clearStoreyFilterAriaLabel')}>&times;</button>
            </span>
          )}
          {classFilter !== null && (
            <>
              {selectedStoreys.size > 0 && <span className="text-2xs text-muted-foreground">+</span>}
              <span className={chip}>
                {classFilter.label}
                <button onClick={clearClassFilter} className={clear} aria-label={t('hierarchy.panel.clearClassFilterAriaLabel')}>&times;</button>
              </span>
            </>
          )}
          {isolatedEntities !== null && (
            <>
              {(selectedStoreys.size > 0 || classFilter !== null) && <span className="text-2xs text-muted-foreground">+</span>}
              <span className={chip}>
                {typeIsolationLabel}
                <button onClick={clearIsolation} className={clear} aria-label={t('hierarchy.panel.clearTypeFilterAriaLabel')}>&times;</button>
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <kbd className="rounded-sm border border-border px-1 font-mono text-2xs text-muted-foreground">{t('hierarchy.panel.escHint')}</kbd>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-2xs"
            onClick={() => { clearStoreySelection(); clearAllFilters(); }}
          >
            {t('hierarchy.panel.clearAllButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}
