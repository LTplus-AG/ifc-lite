/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A layer's contribution rendered from the shared StackDiff contract
 * (#1717 V1): what the layer adds, deletes, and modifies on top of the
 * stack below it. Rows select in 3D through the composition's path →
 * expressId bridge when the path resolves to a meshed entity.
 */

import { useCallback, useMemo, useState } from 'react';
import type { StackDiff } from '@ifc-lite/merge';
import { useViewerStore } from '@/store';
import type { LayerStackEntry } from '@/store/slices/layerStackSlice';
import { pathTail } from '@/lib/layers/stack';

type ChangeKind = 'added' | 'deleted' | 'modified';

interface DiffRow {
  path: string;
  kind: ChangeKind;
  components: string[];
}

const KIND_META: Record<ChangeKind, { dot: string; label: string; chip: string }> = {
  added: {
    dot: 'bg-emerald-500',
    label: 'added',
    chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  },
  modified: {
    dot: 'bg-amber-500',
    label: 'modified',
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  },
  deleted: {
    dot: 'bg-red-500',
    label: 'deleted',
    chip: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300',
  },
};

/** Trim a componentKey to its display tail (`pset:Pset_WallCommon` → `Pset_WallCommon`). */
function componentLabel(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

const ROW_LIMIT = 200;

export function LayerDiffView({ entry, diff }: { entry: LayerStackEntry; diff: StackDiff }) {
  const [kindFilter, setKindFilter] = useState<ChangeKind | null>(null);

  const rows = useMemo<DiffRow[]>(() => {
    const out: DiffRow[] = [];
    for (const path of diff.added) out.push({ path, kind: 'added', components: [] });
    for (const entity of diff.modified) {
      out.push({ path: entity.path, kind: 'modified', components: entity.components });
    }
    for (const path of diff.deleted) out.push({ path, kind: 'deleted', components: [] });
    return out;
  }, [diff]);

  const visible = kindFilter ? rows.filter((r) => r.kind === kindFilter) : rows;

  const selectPath = useCallback((path: string) => {
    const state = useViewerStore.getState();
    const expressId = state.layerStackPathToId?.get(path);
    if (expressId !== undefined) state.setSelectedEntityIds([expressId]);
  }, []);

  const counts: Array<{ kind: ChangeKind; count: number }> = [
    { kind: 'added', count: diff.added.length },
    { kind: 'modified', count: diff.modified.length },
    { kind: 'deleted', count: diff.deleted.length },
  ];

  return (
    <div className="animate-in fade-in slide-in-from-top-1 rounded-md border bg-card/30 p-2">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="truncate text-[11px] font-medium" title={entry.name}>
          Changes by {entry.name}
        </span>
      </div>
      <div className="flex items-center gap-1 pb-1.5">
        {counts.map(({ kind, count }) => {
          const m = KIND_META[kind];
          const active = kindFilter === kind;
          return (
            <button
              key={kind}
              type="button"
              disabled={count === 0}
              onClick={() => setKindFilter(active ? null : kind)}
              className={`rounded-full border px-1.5 py-px text-[10px] font-medium leading-none transition-colors disabled:opacity-40 ${
                active ? m.chip : 'border-border text-muted-foreground hover:bg-muted/60'
              }`}
            >
              {count} {m.label}
            </button>
          );
        })}
      </div>
      {visible.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-muted-foreground">
          This layer changes nothing on top of the stack below it.
        </p>
      ) : (
        <div className="flex flex-col">
          {visible.slice(0, ROW_LIMIT).map((row) => {
            const m = KIND_META[row.kind];
            return (
              <button
                key={`${row.kind}:${row.path}`}
                type="button"
                onClick={() => selectPath(row.path)}
                className="group flex items-start gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/60"
                title={row.path}
              >
                <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${m.dot}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px]">{pathTail(row.path)}</span>
                  {row.components.length > 0 && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {row.components.map(componentLabel).join(', ')}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {visible.length > ROW_LIMIT && (
            <p className="px-1 py-1 text-[10px] text-muted-foreground">
              Showing {ROW_LIMIT} of {visible.length} changes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
