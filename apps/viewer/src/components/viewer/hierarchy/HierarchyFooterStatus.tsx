/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy panel's footer status strip: active storey/class/type-filter
 * chips with per-chip clear buttons when any filter is active, or an idle
 * hint otherwise. Both the multi-model and single-model layouts in
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
  /** The idle-state hint shown when no filter is active. */
  idleHint: string;
  /** Only the multi-model layout's idle hint used the slightly darker
   *  `text-zinc-500` (vs. `text-zinc-600`) light-mode shade — preserved as-is. */
  idleHintLightShade?: '500' | '600';
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
  idleHint,
  idleHintLightShade = '600',
}: HierarchyFooterStatusProps) {
  const { t } = useTranslation();

  if (!hasActiveFilters) {
    return (
      <div className={`p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-${idleHintLightShade} dark:text-zinc-500 text-center bg-zinc-50 dark:bg-black font-mono`}>
        {idleHint}
      </div>
    );
  }

  return (
    <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 bg-primary text-white dark:bg-primary">
      <div className="flex items-center justify-between text-xs font-medium gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          {selectedStoreys.size > 0 && (
            <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {t('hierarchy.panel.storeyCount', { count: selectedStoreys.size })}
              <button onClick={clearStoreySelection} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearStoreyFilterAriaLabel')}>&times;</button>
            </span>
          )}
          {classFilter !== null && (
            <>
              {selectedStoreys.size > 0 && <span className="text-[10px] opacity-50">+</span>}
              <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {classFilter.label}
                <button onClick={clearClassFilter} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearClassFilterAriaLabel')}>&times;</button>
              </span>
            </>
          )}
          {isolatedEntities !== null && (
            <>
              {(selectedStoreys.size > 0 || classFilter !== null) && <span className="text-[10px] opacity-50">+</span>}
              <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {typeIsolationLabel}
                <button onClick={clearIsolation} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearTypeFilterAriaLabel')}>&times;</button>
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="opacity-70 text-[10px] font-mono">{t('hierarchy.panel.escHint')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] uppercase border border-white/20 hover:bg-white/20 hover:text-white rounded-none px-2"
            onClick={() => { clearStoreySelection(); clearAllFilters(); }}
          >
            {t('hierarchy.panel.clearAllButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}
