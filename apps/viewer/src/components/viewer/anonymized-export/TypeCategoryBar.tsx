/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "What am I about to export?" overview for the anonymized isolated export:
 * one chip per IFC class in the candidate set with its entity count. Clicking
 * a chip blocks that whole class regardless of how its entities were reached
 * — the per-relationship toggles say *why* something is in the set, this says
 * *what* is in it, and a class you never selected showing up here (every
 * `IfcSpace` of a storey, say) is exactly the leak this view exists to catch.
 * Locked classes (every entity is a seed or part of the spatial chain) are
 * shown but not clickable.
 */

import { cn } from '@/lib/utils';
import type { TypeCategory } from './useAnonymizedExportSet';

interface TypeCategoryBarProps {
  categories: ReadonlyArray<TypeCategory>;
  onToggle: (typeName: string, excluded: boolean) => void;
}

export function TypeCategoryBar({ categories, onToggle }: TypeCategoryBarProps) {
  if (categories.length === 0) return null;
  const excludedCount = categories.filter((c) => c.excluded).length;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Categories in export
        </div>
        <div className="text-[11px] text-muted-foreground">
          {excludedCount > 0 ? `${excludedCount} blocked · ` : ''}click a category to block it
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories in export">
        {categories.map((c) => (
          <button
            key={c.typeName}
            type="button"
            disabled={c.locked}
            aria-pressed={c.excluded}
            aria-label={`${c.excluded ? 'Unblock' : 'Block'} ${c.typeName}`}
            title={c.locked ? 'Always included (selection or spatial chain)' : c.excluded ? 'Blocked — click to include' : 'Included — click to block'}
            onClick={() => onToggle(c.typeName, !c.excluded)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
              c.excluded
                ? 'border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300 line-through'
                : 'border-emerald-600/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
              c.locked && 'opacity-70 cursor-not-allowed border-dashed',
              !c.locked && 'hover:opacity-80',
            )}
          >
            <span>{c.typeName}</span>
            <span className="rounded-full bg-background/60 px-1 text-[10px] tabular-nums">{c.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
