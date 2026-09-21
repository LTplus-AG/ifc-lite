/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list runs behind a document's table blocks (#5142), one `TableState`
 * per block. A list is run through `runListFederated` — the Lists panel's
 * own path — but never through the panel's single `listResult` slot, and
 * asynchronously: a pset-heavy list over a large federation takes seconds,
 * and the preview must not freeze on every keystroke.
 *
 * Results are keyed by the list's content (not the block: two blocks over
 * the same list share one run) under a `dataKey` that changes whenever the
 * federation, its tags, a mutation, the zones or the unit overrides do —
 * the same inputs `useChartSourceFilters` invalidates on. A result computed
 * under an older `dataKey` is unreachable, so a reloaded model can never
 * surface rows from the model it replaced (the #4946 lesson).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ListDefinition } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import type { DocumentSpec, TableBlock } from '@/lib/document/types';
import type { TableState } from '@/lib/document/resolve-table';
import { runListFederated } from '@/lib/lists/run-list';
import { buildExportModel } from '@/lib/lists/export/model';
import { detectNumericColumns } from '../lists/list-table-utils';
import { useListProviders } from '../lists/useListProviders';

/** What a run is keyed by: the list's content, minus what cannot change its rows. */
export function listFingerprint(list: ListDefinition): string {
  const { id: _id, name: _name, description: _description, createdAt: _c, updatedAt: _u, ...content } = list;
  void _id; void _name; void _description; void _c; void _u;
  return JSON.stringify(content);
}

const EMPTY: ReadonlyMap<string, TableState> = new Map();
const RESOLVING: TableState = { status: 'resolving' };
const NO_MODEL: TableState = { status: 'no-model' };

interface Results {
  key: object;
  byFingerprint: ReadonlyMap<string, TableState>;
}

/** Defers to the next frame in the browser; a timer where there is no frame (tests). */
const nextFrame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(fn, 0);
  return () => clearTimeout(handle);
};

export function useDocumentTables(document: DocumentSpec | null): ReadonlyMap<string, TableState> {
  const { pairs, modelUnits, hasData } = useListProviders();
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const models = useViewerStore((s) => s.models);
  const modelTags = useViewerStore((s) => s.modelTags);
  const modelTagAssignments = useViewerStore((s) => s.modelTagAssignments);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  // A fresh identity whenever anything a run reads changes: results are only valid under the key they were computed for.
  const dataKey = useMemo<object>(() => ({}), [pairs, modelUnits, unitDisplayOverrides, models, modelTags, modelTagAssignments, mutationVersion]);

  const blocks = useMemo(() => (document?.blocks ?? []).filter((b): b is TableBlock => b.kind === 'table'), [document]);
  const fingerprints = useMemo(() => {
    const byBlock = new Map<string, string>();
    for (const b of blocks) byBlock.set(b.id, listFingerprint(b.source.list));
    return byBlock;
  }, [blocks]);
  // The distinct lists to run. A document edit re-runs the effect, which then finds nothing left to do.
  const wantedList = useMemo(() => [...new Set(fingerprints.values())].sort(), [fingerprints]);

  const [results, setResults] = useState<Results>({ key: dataKey, byFingerprint: EMPTY });
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const current = results.key === dataKey ? results.byFingerprint : EMPTY;

  useEffect(() => {
    if (!hasData) return;
    const live = resultsRef.current;
    const done = live.key === dataKey ? live.byFingerprint : EMPTY;
    const wanted = wantedList.filter((fp) => !done.has(fp));
    if (wanted.length === 0) return;
    const definitions = new Map<string, ListDefinition>();
    for (const b of blocks) definitions.set(listFingerprint(b.source.list), b.source.list);

    let cancelled = false;
    let cancelFrame: (() => void) | null = null;
    // One list per frame, in sequence: two heavy blocks must not double the stall.
    const runAt = (i: number): void => {
      if (cancelled || i >= wanted.length) return;
      cancelFrame = nextFrame(() => {
        if (cancelled) return;
        const fp = wanted[i];
        const list = definitions.get(fp);
        let state: TableState;
        try {
          if (!list) throw new Error('list definition missing');
          // `executeList` already applied the list's `sortBy` per model; the export model is built
          // exactly as the Lists panel builds it for its own export.
          const result = runListFederated(list, pairs, useViewerStore.getState());
          const model = buildExportModel({
            title: list.name,
            columns: result.columns,
            rows: result.rows,
            grouping: list.grouping,
            numericCols: detectNumericColumns(result.columns, result.rows),
            columnWidths: [],
            generatedAt: new Date().toLocaleString(),
            modelUnits,
            unitDisplayOverrides,
          });
          state = { status: 'ok', model };
        } catch (err) {
          // Shown in the block (preview and PDF), like the Lists panel's error box (#4317).
          console.error('[Documents] table block list run failed:', err);
          state = { status: 'error', message: err instanceof Error ? err.message : String(err) };
        }
        setResults((prev) => {
          const base = prev.key === dataKey ? prev.byFingerprint : EMPTY;
          return { key: dataKey, byFingerprint: new Map(base).set(fp, state) };
        });
        runAt(i + 1);
      });
    };
    runAt(0);
    return () => { cancelled = true; cancelFrame?.(); };
  }, [dataKey, wantedList, blocks, hasData, pairs, modelUnits, unitDisplayOverrides]);

  return useMemo(() => {
    const out = new Map<string, TableState>();
    for (const [blockId, fp] of fingerprints) out.set(blockId, hasData ? (current.get(fp) ?? RESOLVING) : NO_MODEL);
    return out;
  }, [fingerprints, current, hasData]);
}
