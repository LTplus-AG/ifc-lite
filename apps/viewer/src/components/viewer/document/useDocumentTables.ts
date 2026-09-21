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
 * the same list share one run) under a `dataKey` that changes whenever
 * something a run READS changes: the models' data stores, their tags, a
 * mutation, the zones, the unit overrides — and the geometry only when a
 * list has a world-coordinate column, because the store replaces
 * `geometryResult`/`models` on every streamed batch of a load and a
 * pset-heavy list must not re-run per batch (review finding). A result
 * computed under an older `dataKey` is unreachable, so a reloaded model can
 * never surface rows from the model it replaced (the #4946 lesson).
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

/** `true` when a list reads world coordinates, whose values move with the geometry and render frame. */
export function listReadsGeometry(list: ListDefinition): boolean {
  return list.columns.some((c) => c.source === 'geometry') || list.conditions.some((c) => c.source === 'geometry');
}

/** Counts up each time `value` changes identity between renders. */
function useVersionOf(value: unknown): number {
  const ref = useRef({ value, version: 0 });
  if (ref.current.value !== value) ref.current = { value, version: ref.current.version + 1 };
  return ref.current.version;
}

/** The same object while every dep is `===` its predecessor; a new one otherwise. */
function useStableKey(deps: readonly unknown[]): object {
  const ref = useRef<{ deps: readonly unknown[]; key: object } | null>(null);
  const prev = ref.current;
  if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) return prev.key;
  const next = { deps, key: {} };
  ref.current = next;
  return next.key;
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
  const providers = useListProviders();
  const { pairs, hasData } = providers;
  // The run reads the LATEST providers/units (a geometry batch rebuilds them without changing rows).
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const modelTags = useViewerStore((s) => s.modelTags);
  const modelTagAssignments = useViewerStore((s) => s.modelTagAssignments);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const zoneSets = useViewerStore((s) => s.zoneSets);
  const zoneAssignments = useViewerStore((s) => s.zoneAssignments);
  const zoneApportionment = useViewerStore((s) => s.zoneApportionment);

  const blocks = useMemo(() => (document?.blocks ?? []).filter((b): b is TableBlock => b.kind === 'table'), [document]);

  // A fresh identity whenever anything a run reads changes: results are only valid under the key they were computed for.
  // The data stores (not the model objects: a streamed batch replaces those) stand for the federation.
  const dataKey = useStableKey([
    pairs.length,
    ...pairs.flatMap((p) => [p.modelId, p.store]),
    unitDisplayOverrides, modelTags, modelTagAssignments, mutationVersion, zoneSets, zoneAssignments, zoneApportionment,
  ]);
  // Providers are rebuilt on every geometry batch; only a list reading world coordinates cares.
  const geometryVersion = useVersionOf(pairs);

  const fingerprints = useMemo(() => {
    const byBlock = new Map<string, string>();
    for (const b of blocks) {
      const list = b.source.list;
      byBlock.set(b.id, listReadsGeometry(list) ? `${listFingerprint(list)}|geometry:${geometryVersion}` : listFingerprint(list));
    }
    return byBlock;
  }, [blocks, geometryVersion]);
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
    for (const b of blocks) definitions.set(fingerprints.get(b.id)!, b.source.list);

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
          const live = providersRef.current;
          const result = runListFederated(list, live.pairs, useViewerStore.getState());
          const model = buildExportModel({
            title: list.name,
            columns: result.columns,
            rows: result.rows,
            grouping: list.grouping,
            numericCols: detectNumericColumns(result.columns, result.rows),
            columnWidths: [],
            generatedAt: new Date().toLocaleString(),
            modelUnits: live.modelUnits,
            unitDisplayOverrides: useViewerStore.getState().unitDisplayOverrides,
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
  }, [dataKey, wantedList, fingerprints, blocks, hasData]);

  return useMemo(() => {
    const out = new Map<string, TableState>();
    for (const [blockId, fp] of fingerprints) out.set(blockId, hasData ? (current.get(fp) ?? RESOLVING) : NO_MODEL);
    return out;
  }, [fingerprints, current, hasData]);
}
