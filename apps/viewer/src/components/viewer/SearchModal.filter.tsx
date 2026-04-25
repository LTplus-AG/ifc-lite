/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModalFilter — chip-based structured-rule filtering.
 *
 * Owns the run lifecycle: assembles per-model arguments, folds the
 * inline search query into a Tier-1/Tier-0 candidate set when present,
 * runs the path-B evaluator (chunked + cancellable + progress), and
 * renders the result table. The chip-editing UI lives in
 * `SearchModalFilterBuilder`; that's a UI-only sibling that reads /
 * writes the same slice state.
 *
 * No DuckDB. No SQL editor. The path-B evaluator handles 4M-entity
 * models via `selectIterationSource` (byType / byStorey index
 * prefilter under AND + op:in), cheap-first per-entity rule ordering,
 * and async chunked yielding — so a single Run button is the whole
 * story.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Play, AlertCircle, Download } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { evaluateFilterRulesFederated } from '@/lib/search/filter-evaluate';
import { runTier0Scan, type ScanModel } from '@/lib/search/tier0-scan';
import { queryTier1Indexes, type Tier1Index } from '@/lib/search/tier1-index';
import { downloadResult } from '@/lib/search/result-export';
import { SearchModalFilterBuilder } from './SearchModal.filter.builder';

/** Rows per virtualizer page — tuned for the result table row height. */
const RESULT_ROW_HEIGHT = 28;
const TEXT_HIT_LIMIT = 50_000;
const FILTER_CHUNK_SIZE = 20_000;
const DEFAULT_LIMIT = 5_000;

/** Columns we treat as "selection keys" — clicking a row routes the
 *  value through the viewer's selection system. */
const SELECTION_COLUMNS = ['express_id', 'entity_id'] as const;

export function SearchModalFilter() {
  const {
    searchFilter,
    searchFilterResult,
    searchFilterRunning,
    searchFilterError,
    searchQuery,
    searchIndexes,
    setSearchFilterRunning,
    setSearchFilterResult,
    setSearchFilterError,
    models,
    activeModelId,
    setSelectedEntity,
    setSelectedEntityId,
    cameraCallbacks,
  } = useViewerStore(
    useShallow((s) => ({
      searchFilter: s.searchFilter,
      searchFilterResult: s.searchFilterResult,
      searchFilterRunning: s.searchFilterRunning,
      searchFilterError: s.searchFilterError,
      searchQuery: s.searchQuery,
      searchIndexes: s.searchIndexes,
      setSearchFilterRunning: s.setSearchFilterRunning,
      setSearchFilterResult: s.setSearchFilterResult,
      setSearchFilterError: s.setSearchFilterError,
      models: s.models,
      activeModelId: s.activeModelId,
      setSelectedEntity: s.setSelectedEntity,
      setSelectedEntityId: s.setSelectedEntityId,
      cameraCallbacks: s.cameraCallbacks,
    })),
  );

  const activeModel = activeModelId ? models.get(activeModelId) : undefined;
  const activeStore = activeModel?.ifcDataStore ?? null;
  const multiModel = models.size > 1;

  // ── Run lifecycle: progress, cancel, limit-hit badge ──────────────────
  const runController = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null);
  const [limitHit, setLimitHit] = useState<number | null>(null);

  const runFilter = useCallback(async () => {
    if (searchFilterRunning) return;
    if (searchFilter.rules.length === 0) {
      setSearchFilterError('Add at least one rule before running.');
      return;
    }

    runController.current?.abort();
    const controller = new AbortController();
    runController.current = controller;

    setSearchFilterRunning(true);
    setSearchFilterError(null);
    setLimitHit(null);
    setProgress({ scanned: 0, total: 0 });

    const start = performance.now();
    try {
      const modelArgs: Array<{ id: string; store: typeof activeStore }> = [];
      for (const m of models.values()) {
        if (m.ifcDataStore) modelArgs.push({ id: m.id, store: m.ifcDataStore });
      }

      // Fold the inline search query in as a Tier-1/Tier-0 candidate
      // set when present. Empty query → no narrowing (full scan with
      // index prefilter applied inside the evaluator).
      const trimmedQuery = searchQuery.trim();
      let candidatesByModel: Map<string, Iterable<number>> | undefined;
      if (trimmedQuery.length > 0) {
        const t0Models: ScanModel[] = [];
        const t1Indexes: Tier1Index[] = [];
        for (const m of modelArgs) {
          const rec = searchIndexes.get(m.id);
          if (rec?.status === 'ready' && rec.index) {
            t1Indexes.push(rec.index);
          } else {
            t0Models.push({ id: m.id, ifcDataStore: m.store });
          }
        }
        const t1Hits = t1Indexes.length > 0
          ? queryTier1Indexes(t1Indexes, trimmedQuery, { limit: TEXT_HIT_LIMIT })
          : [];
        const t0Hits = t0Models.length > 0
          ? runTier0Scan(t0Models, trimmedQuery, { limit: TEXT_HIT_LIMIT })
          : [];
        const grouped = new Map<string, Set<number>>();
        for (const hit of t1Hits.concat(t0Hits)) {
          let bucket = grouped.get(hit.modelId);
          if (!bucket) { bucket = new Set(); grouped.set(hit.modelId, bucket); }
          bucket.add(hit.expressId);
        }
        candidatesByModel = new Map();
        for (const [id, set] of grouped) candidatesByModel.set(id, set);
        for (const m of modelArgs) {
          // Models with no text hits get an empty candidate so structured
          // rules can't slip through under intersection semantics.
          if (!candidatesByModel.has(m.id)) candidatesByModel.set(m.id, []);
        }
      }

      const limit = searchFilter.limit > 0 ? searchFilter.limit : DEFAULT_LIMIT;
      const matched = await evaluateFilterRulesFederated(
        modelArgs,
        searchFilter.rules,
        searchFilter.combinator,
        {
          limit,
          chunkSize: FILTER_CHUNK_SIZE,
          candidateExpressIdsByModel: candidatesByModel,
          signal: controller.signal,
          onProgress: (scanned, total) => setProgress({ scanned, total }),
        },
      );

      const multi = modelArgs.length > 1;
      const columns = multi
        ? ['express_id', 'global_id', 'name', 'type', 'model_id']
        : ['express_id', 'global_id', 'name', 'type'];
      const rows: unknown[][] = matched.map((m) =>
        multi
          ? [m.expressId, m.globalId, m.name, m.ifcType, m.modelId]
          : [m.expressId, m.globalId, m.name, m.ifcType],
      );
      setSearchFilterResult({
        columns,
        rows,
        runMs: Math.round(performance.now() - start),
      });
      if (matched.length >= limit) setLimitHit(limit);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setSearchFilterError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runController.current === controller) {
        runController.current = null;
        setSearchFilterRunning(false);
        setProgress(null);
      }
    }
  }, [
    models,
    searchFilter,
    searchFilterRunning,
    searchIndexes,
    searchQuery,
    setSearchFilterError,
    setSearchFilterResult,
    setSearchFilterRunning,
  ]);

  const cancelFilter = useCallback(() => {
    runController.current?.abort();
  }, []);

  // Cancel any in-flight run when the modal unmounts so background
  // chunked work doesn't keep ticking after close.
  useEffect(() => () => {
    runController.current?.abort();
  }, []);

  // Locate the model_id column (only present in federated runs) — same
  // routing rule as before: known column → use that model's id space.
  const modelIdColumnIndex = useMemo(() => {
    const cols = searchFilterResult?.columns;
    if (!cols) return -1;
    return cols.indexOf('model_id');
  }, [searchFilterResult]);

  const selectionKeyIndex = useMemo(() => {
    const cols = searchFilterResult?.columns;
    if (!cols) return -1;
    for (const candidate of SELECTION_COLUMNS) {
      const i = cols.indexOf(candidate);
      if (i >= 0) return i;
    }
    return -1;
  }, [searchFilterResult]);

  const handleRowClick = useCallback((row: unknown[]) => {
    if (selectionKeyIndex < 0) return;
    const rowModelId = modelIdColumnIndex >= 0 && typeof row[modelIdColumnIndex] === 'string'
      ? (row[modelIdColumnIndex] as string)
      : activeModelId;
    if (!rowModelId) return;
    const raw = row[selectionKeyIndex];
    const expressId = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && !Number.isNaN(Number(raw))
        ? Number(raw)
        : null;
    if (expressId === null || expressId <= 0) return;
    const globalId = toGlobalIdFromModels(models, rowModelId, expressId);
    setSelectedEntityId(globalId);
    setSelectedEntity({ modelId: rowModelId, expressId });
    if (cameraCallbacks.frameSelection) {
      window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
    }
  }, [activeModelId, cameraCallbacks, models, modelIdColumnIndex, selectionKeyIndex, setSelectedEntity, setSelectedEntityId]);

  const handleExport = useCallback((format: 'csv' | 'json') => {
    if (!searchFilterResult || searchFilterResult.rows.length === 0) return;
    downloadResult(searchFilterResult, format);
  }, [searchFilterResult]);

  if (!activeStore) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Load an IFC file first — the filter runs against the active model&apos;s data.
      </div>
    );
  }

  const canRun = searchFilter.rules.length > 0;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* ── Builder (chip palette) ─────────────────────────────────────── */}
      <div className="overflow-y-auto border-b">
        <SearchModalFilterBuilder />
      </div>

      {/* ── Run bar: status · run/cancel · export ──────────────────────── */}
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[11px]">
        <RuleSummary
          ruleCount={searchFilter.rules.length}
          combinator={searchFilter.combinator}
          limit={searchFilter.limit}
        />

        {progress && progress.total > 0 && (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="relative h-1.5 w-32 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
              <span
                className="absolute left-0 top-0 h-full bg-primary transition-[width] duration-100"
                style={{
                  width: `${Math.min(100, Math.round((progress.scanned / progress.total) * 100))}%`,
                }}
              />
            </span>
            <span className="font-mono">
              {progress.scanned.toLocaleString()} / {progress.total.toLocaleString()}
            </span>
          </span>
        )}
        {progress && progress.total <= 0 && (
          <span className="font-mono text-muted-foreground">
            scanned {progress.scanned.toLocaleString()}
          </span>
        )}

        {!searchFilterRunning && limitHit !== null && (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
            title="Increase the limit or narrow the rules to see more matches"
          >
            limited to {limitHit.toLocaleString()}
          </span>
        )}

        {searchFilterResult && !searchFilterRunning && (
          <span className="text-muted-foreground">
            ⏱ {searchFilterResult.runMs} ms · {searchFilterResult.rows.length.toLocaleString()} rows
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!searchFilterResult || searchFilterResult.rows.length === 0}
                className="h-7 gap-1 text-xs"
                title="Export results"
              >
                <Download className="h-3 w-3" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => handleExport('csv')}>
                Download CSV
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleExport('json')}>
                Download JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {searchFilterRunning ? (
            <Button
              variant="outline"
              size="sm"
              onClick={cancelFilter}
              className="h-7 gap-1 text-xs"
            >
              Cancel
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={runFilter}
              disabled={!canRun}
              className="h-7 gap-1 text-xs"
              title={canRun ? 'Run the filter against every loaded model' : 'Add a rule first'}
            >
              <Play className="h-3 w-3" />
              Run
            </Button>
          )}
        </div>
      </div>

      {multiModel && (
        <div className="border-b bg-zinc-50 px-3 py-1.5 text-[11px] text-muted-foreground dark:bg-zinc-900/30">
          Filtering across all {models.size} loaded models. Click any row to
          select that element in the right model.
        </div>
      )}

      {/* ── Result area: error stacks above the last good table ────────── */}
      {searchFilterError && <FilterErrorBox raw={searchFilterError} />}
      <FilterResultTable
        result={searchFilterResult}
        selectionKeyIndex={selectionKeyIndex}
        onRowClick={handleRowClick}
      />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function RuleSummary({
  ruleCount,
  combinator,
  limit,
}: {
  ruleCount: number;
  combinator: 'AND' | 'OR';
  limit: number;
}) {
  if (ruleCount === 0) {
    return (
      <span className="text-muted-foreground italic">No rules — add one to run.</span>
    );
  }
  return (
    <span className="text-muted-foreground">
      <span className="font-mono text-foreground">{ruleCount}</span>{' '}
      rule{ruleCount === 1 ? '' : 's'}
      <span className="mx-1">·</span>
      <span className="font-mono">{combinator}</span>
      <span className="mx-1">·</span>
      limit{' '}
      <span className="font-mono text-foreground">
        {limit > 0 ? limit.toLocaleString() : '∞'}
      </span>
    </span>
  );
}

function FilterErrorBox({ raw }: { raw: string }) {
  return (
    <div className="border-b bg-red-50/50 px-4 py-3 dark:bg-red-950/20">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-semibold text-red-900 dark:text-red-200">Filter failed</div>
          <div className="mt-1 break-words text-red-800 dark:text-red-300">{raw}</div>
        </div>
      </div>
    </div>
  );
}

interface FilterResultTableProps {
  result: { columns: string[]; rows: unknown[][] } | null;
  selectionKeyIndex: number;
  onRowClick: (row: unknown[]) => void;
}

function FilterResultTable({ result, selectionKeyIndex, onRowClick }: FilterResultTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: result?.rows.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RESULT_ROW_HEIGHT,
    overscan: 20,
  });

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Add rules and click Run.
      </div>
    );
  }

  if (result.rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        0 matches — broaden the rules, lower the limit, or try OR.
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex items-center border-b bg-zinc-50/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground dark:bg-zinc-900/30">
        {result.columns.map((c) => (
          <div key={c} className="flex-1 truncate px-2 font-mono">
            {c}
          </div>
        ))}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const row = result.rows[vRow.index];
            const clickable = selectionKeyIndex >= 0;
            return (
              <div
                key={vRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vRow.size,
                  transform: `translateY(${vRow.start}px)`,
                }}
                className={cn(
                  'flex items-center border-b border-zinc-100 px-3 text-[11px] dark:border-zinc-900',
                  clickable && 'cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
                onClick={() => clickable && onRowClick(row)}
              >
                {result.columns.map((_, i) => (
                  <div key={i} className="flex-1 truncate px-2 font-mono">
                    {formatCell(row[i])}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
