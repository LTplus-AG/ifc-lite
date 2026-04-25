/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModal.sql — the DuckDB-backed SQL tab (P4).
 *
 * Layered on top of the existing `@ifc-lite/query` DuckDB integration.
 * Load-perf guarantee unchanged: the engine is dynamic-imported and
 * init happens only on the first actual Run — not on modal open, not
 * on IFC load.
 *
 * UI
 *   left rail   — schema browser (tables + views, click column to insert)
 *   editor      — monospace textarea; ⌘↵ / Ctrl+↵ runs; ⌘⇧↵ runs + keeps focus
 *   top buttons — Templates dropdown, Run, Copy
 *   result pane — virtualized table; row click → select + frame (when a
 *                 recognised entity-id column is present)
 *   error box   — friendly title + hint, always with the raw text
 *
 * Multi-model caveat: DuckDB is initialised against the ACTIVE model
 * only. A banner makes that explicit when >1 model is loaded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Play, Copy, Database, FileCode2, AlertCircle, ExternalLink, Star, Bookmark, Download, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { listSqlTemplates } from '@/lib/search/sql-templates';
import { rewriteSqlError } from '@/lib/search/sql-error-rewriter';
import { isDuckDBAvailable, runSql } from '@/lib/search/sql-state';
import {
  loadSavedQueries,
  saveQuery,
  deleteSavedQuery,
  type SavedQuery,
} from '@/lib/search/saved-queries';
import { downloadResult } from '@/lib/search/result-export';
import { evaluateFilterRulesFederated } from '@/lib/search/filter-evaluate';
import { runTier0Scan, type ScanModel } from '@/lib/search/tier0-scan';
import { queryTier1Indexes, type Tier1Index } from '@/lib/search/tier1-index';
import { SearchModalSqlBuilder } from './SearchModal.sql.builder';

/** Rows per virtualizer page — tuned for the result table row height. */
const RESULT_ROW_HEIGHT = 28;

/** Tables + views the DuckDBIntegration registers. Kept local so we don't
 *  have to import the private helpers from `@ifc-lite/query`. */
const SCHEMA = {
  tables: [
    {
      name: 'entities',
      columns: [
        'express_id', 'global_id', 'name', 'description', 'type',
        'object_type', 'has_geometry', 'is_type',
        'contained_in_storey', 'defined_by_type',
      ],
    },
    {
      name: 'properties',
      columns: [
        'entity_id', 'pset_name', 'pset_global_id', 'prop_name', 'prop_type',
        'value_string', 'value_real', 'value_int', 'value_bool',
      ],
    },
    {
      name: 'quantities',
      columns: [
        'entity_id', 'qset_name', 'quantity_name', 'quantity_type', 'value', 'formula',
      ],
    },
    {
      name: 'relationships',
      columns: ['source_id', 'target_id', 'rel_type', 'rel_id'],
    },
  ],
  views: [
    'walls', 'doors', 'windows', 'slabs', 'columns', 'beams', 'spaces',
    'entity_properties', 'entity_quantities',
  ],
} as const;

/** Columns we recognise as "selection keys" — clicking a row with one of
 *  these routes the value through the viewer's selection system. */
const SELECTION_COLUMNS = ['express_id', 'entity_id', 'source_id', 'target_id'] as const;

export function SearchModalSql() {
  const {
    searchSqlQuery,
    searchSqlResult,
    searchSqlRunning,
    searchSqlError,
    searchSqlMode,
    searchFilter,
    searchQuery,
    searchIndexes,
    setSearchSqlQuery,
    setSearchSqlRunning,
    setSearchSqlResult,
    setSearchSqlError,
    setSearchSqlMode,
    models,
    activeModelId,
    setSelectedEntity,
    setSelectedEntityId,
    cameraCallbacks,
  } = useViewerStore(
    useShallow((s) => ({
      searchSqlQuery: s.searchSqlQuery,
      searchSqlResult: s.searchSqlResult,
      searchSqlRunning: s.searchSqlRunning,
      searchSqlError: s.searchSqlError,
      searchSqlMode: s.searchSqlMode,
      searchFilter: s.searchFilter,
      searchQuery: s.searchQuery,
      searchIndexes: s.searchIndexes,
      setSearchSqlQuery: s.setSearchSqlQuery,
      setSearchSqlRunning: s.setSearchSqlRunning,
      setSearchSqlResult: s.setSearchSqlResult,
      setSearchSqlError: s.setSearchSqlError,
      setSearchSqlMode: s.setSearchSqlMode,
      models: s.models,
      activeModelId: s.activeModelId,
      setSelectedEntity: s.setSelectedEntity,
      setSelectedEntityId: s.setSelectedEntityId,
      cameraCallbacks: s.cameraCallbacks,
    })),
  );

  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void isDuckDBAvailable().then((v) => { if (!cancelled) setAvailable(v); });
    return () => { cancelled = true; };
  }, []);

  const activeModel = activeModelId ? models.get(activeModelId) : undefined;
  const activeStore = activeModel?.ifcDataStore ?? null;
  const multiModel = models.size > 1;

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertAtCursor = useCallback((snippet: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setSearchSqlQuery(`${searchSqlQuery}${snippet}`);
      return;
    }
    const start = ta.selectionStart ?? searchSqlQuery.length;
    const end = ta.selectionEnd ?? searchSqlQuery.length;
    const next = `${searchSqlQuery.slice(0, start)}${snippet}${searchSqlQuery.slice(end)}`;
    setSearchSqlQuery(next);
    // Restore caret after React re-renders.
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (!ta2) return;
      const pos = start + snippet.length;
      ta2.focus();
      ta2.selectionStart = pos;
      ta2.selectionEnd = pos;
    });
  }, [searchSqlQuery, setSearchSqlQuery]);

  const applyTemplate = useCallback((sql: string) => {
    setSearchSqlQuery(sql);
    textareaRef.current?.focus();
  }, [setSearchSqlQuery]);

  const runSqlQuery = useCallback(async (rawSql: string) => {
    if (!activeStore) {
      setSearchSqlError('No active model — load an IFC file before running SQL.');
      return;
    }
    // Defense in depth: never invoke runSql when DuckDB-WASM isn't
    // resolvable. The Builder already disables the Run SQL button in
    // this state, but a stale React closure or a programmatic caller
    // could still reach here — short-circuit with a friendly message
    // rather than letting the bare-specifier error bubble up.
    if (available === false) {
      setSearchSqlError(
        '@duckdb/duckdb-wasm is not installed. Use Fast Run in the Builder, or install with `pnpm add @duckdb/duckdb-wasm` and reload.',
      );
      return;
    }
    if (searchSqlRunning) return;
    const sql = rawSql.trim();
    if (!sql) return;

    setSearchSqlRunning(true);
    const start = performance.now();
    try {
      const result = await runSql(activeStore, sql);
      setSearchSqlResult({
        columns: result.columns,
        rows: result.rows,
        runMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      const rewritten = rewriteSqlError(err);
      setSearchSqlError(rewritten.raw);
    } finally {
      setSearchSqlRunning(false);
    }
  }, [activeStore, available, searchSqlRunning,
      setSearchSqlError, setSearchSqlResult, setSearchSqlRunning]);

  const runEditor = useCallback(() => {
    void runSqlQuery(searchSqlQuery);
  }, [runSqlQuery, searchSqlQuery]);

  // ── Fast Run lifecycle: progress, cancel, limit-hit badge ──────────────
  // Local component state rather than the global store: nothing else in
  // the app needs to read these and they're rebuilt every run.
  const fastRunController = useRef<AbortController | null>(null);
  const [fastRunProgress, setFastRunProgress] = useState<{ scanned: number; total: number } | null>(null);
  const [fastRunLimitHit, setFastRunLimitHit] = useState<number | null>(null);

  /**
   * Path-B Fast Run — evaluate the chip rules in-memory across every
   * loaded model with an `ifcDataStore`. Async + chunked so the main
   * thread stays responsive on huge models (4M+ entities), with an
   * AbortController so the user can cancel mid-flight, and a progress
   * callback that drives the chunked progress strip.
   */
  const runFast = useCallback(async () => {
    if (searchSqlRunning) return;
    if (searchFilter.rules.length === 0) {
      setSearchSqlError('Add at least one rule before Fast Run.');
      return;
    }
    // Replace any previous run's controller — clicking Fast Run while
    // a stale run is somehow still queued aborts the old one cleanly.
    fastRunController.current?.abort();
    const controller = new AbortController();
    fastRunController.current = controller;

    setSearchSqlRunning(true);
    setSearchSqlError(null);
    setFastRunLimitHit(null);
    setFastRunProgress({ scanned: 0, total: 0 });

    const start = performance.now();
    try {
      const modelArgs: Array<{ id: string; store: typeof activeStore }> = [];
      for (const m of models.values()) {
        if (m.ifcDataStore) modelArgs.push({ id: m.id, store: m.ifcDataStore });
      }

      // ── Tier-1/Tier-0 narrowing ────────────────────────────────────
      // When the inline search bar carries a non-empty query, fold it
      // into the run as a candidate set: structured rules only check
      // the text-search hit list rather than scanning every entity.
      // Empty query → full scan, same as before.
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
          ? queryTier1Indexes(t1Indexes, trimmedQuery, { limit: 50_000 })
          : [];
        const t0Hits = t0Models.length > 0
          ? runTier0Scan(t0Models, trimmedQuery, { limit: 50_000 })
          : [];
        const grouped = new Map<string, Set<number>>();
        for (const hit of t1Hits.concat(t0Hits)) {
          let bucket = grouped.get(hit.modelId);
          if (!bucket) { bucket = new Set(); grouped.set(hit.modelId, bucket); }
          bucket.add(hit.expressId);
        }
        // Always build a candidate map when the user is narrowing — even
        // when the text query produced zero hits. Without this, a misspelt
        // query would fall back to a full scan and structured rules would
        // return matches unrelated to the text (intersection semantics).
        candidatesByModel = new Map();
        for (const [id, set] of grouped) candidatesByModel.set(id, set);
        for (const m of modelArgs) {
          if (!candidatesByModel.has(m.id)) candidatesByModel.set(m.id, []);
        }
      }

      const limit = searchFilter.limit > 0 ? searchFilter.limit : 5_000;
      const matched = await evaluateFilterRulesFederated(
        modelArgs,
        searchFilter.rules,
        searchFilter.combinator,
        {
          limit,
          candidateExpressIdsByModel: candidatesByModel,
          signal: controller.signal,
          onProgress: (scanned, total) => {
            // React batches setState across microtasks but explicit
            // chunk-boundary calls still surface a smooth progress
            // signal because each yieldToEventLoop allows a paint.
            setFastRunProgress({ scanned, total });
          },
        },
      );

      // Tag rows with model id when more than one model is loaded so the
      // user can tell results apart.
      const multi = modelArgs.length > 1;
      const columns = multi
        ? ['express_id', 'global_id', 'name', 'type', 'model_id']
        : ['express_id', 'global_id', 'name', 'type'];
      const rows: unknown[][] = matched.map((m) =>
        multi
          ? [m.expressId, m.globalId, m.name, m.ifcType, m.modelId]
          : [m.expressId, m.globalId, m.name, m.ifcType],
      );
      setSearchSqlResult({
        columns,
        rows,
        runMs: Math.round(performance.now() - start),
      });
      // Surface the limit-hit affordance when we stopped early. The
      // result count will equal the limit at this point — let the user
      // know more matches likely exist beyond the cap.
      if (matched.length >= limit) setFastRunLimitHit(limit);
    } catch (err) {
      // Aborted runs aren't errors — just clear running state.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setSearchSqlError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only clear running state if THIS run is still the active one.
      // A second click that aborts the first will have already started
      // its own run and we don't want to clobber its state.
      if (fastRunController.current === controller) {
        fastRunController.current = null;
        setSearchSqlRunning(false);
        setFastRunProgress(null);
      }
    }
  }, [
    models,
    searchFilter,
    searchIndexes,
    searchQuery,
    searchSqlRunning,
    setSearchSqlError,
    setSearchSqlResult,
    setSearchSqlRunning,
  ]);

  /** Cancel the in-flight Fast Run. No-op if nothing is running. */
  const cancelFastRun = useCallback(() => {
    fastRunController.current?.abort();
  }, []);

  // Cancel any in-flight Fast Run when the modal unmounts so background
  // chunked work doesn't keep ticking after the user closes the tab.
  useEffect(() => () => {
    fastRunController.current?.abort();
  }, []);

  /** Builder "Open in Editor" — copies the generated SQL into the editor
   *  and flips the sub-mode. Lets the user edit, run, or learn from it. */
  const promoteToEditor = useCallback((sql: string) => {
    if (!sql) return;
    setSearchSqlQuery(sql);
    setSearchSqlMode('editor');
    // Focus the textarea on the next frame so the caret lands inside.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [setSearchSqlMode, setSearchSqlQuery]);

  const copyQuery = useCallback(() => {
    if (!searchSqlQuery) return;
    void navigator.clipboard?.writeText(searchSqlQuery);
  }, [searchSqlQuery]);

  // ── Saved queries ──────────────────────────────────────────────────
  // Loaded once per modal open + refreshed after every save / delete.
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => loadSavedQueries());

  const handleSaveQuery = useCallback(() => {
    const sql = searchSqlQuery.trim();
    if (!sql) return;
    if (typeof window === 'undefined') return;
    const name = window.prompt(
      'Save this query as:',
      'My query — ' + new Date().toLocaleString(),
    );
    if (!name || !name.trim()) return;
    setSavedQueries(saveQuery(name, sql));
  }, [searchSqlQuery]);

  const handleApplySaved = useCallback((q: SavedQuery) => {
    setSearchSqlQuery(q.sql);
    setSearchSqlMode('editor');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [setSearchSqlMode, setSearchSqlQuery]);

  const handleDeleteSaved = useCallback((id: string) => {
    setSavedQueries(deleteSavedQuery(id));
  }, []);

  // ── Result export ──────────────────────────────────────────────────
  const handleExport = useCallback((format: 'csv' | 'json') => {
    if (!searchSqlResult) return;
    const stem = `ifc-query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    downloadResult(
      { columns: searchSqlResult.columns, rows: searchSqlResult.rows },
      format,
      stem,
    );
  }, [searchSqlResult]);

  // Keyboard inside textarea — ⌘↵ / Ctrl+↵ runs the query.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runEditor();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      // Insert a real tab at cursor rather than tabbing out of the field.
      e.preventDefault();
      insertAtCursor('  ');
    }
  }, [insertAtCursor, runEditor]);

  // Locate the first selection-key column in the result, if any.
  const selectionKeyIndex = useMemo(() => {
    const cols = searchSqlResult?.columns;
    if (!cols) return -1;
    for (const candidate of SELECTION_COLUMNS) {
      const i = cols.indexOf(candidate);
      if (i >= 0) return i;
    }
    return -1;
  }, [searchSqlResult]);

  // Locate the model_id column (only present in federated Fast Run results).
  const modelIdColumnIndex = useMemo(() => {
    const cols = searchSqlResult?.columns;
    if (!cols) return -1;
    return cols.indexOf('model_id');
  }, [searchSqlResult]);

  const handleRowClick = useCallback((row: unknown[]) => {
    if (selectionKeyIndex < 0) return;
    // Federated Fast Run rows know which model they belong to; SQL Editor
    // rows fall back to the active model (DuckDB only sees one model).
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

  // ── Render early-outs for the "not ready" states ─────────────────────
  // DuckDB unavailable still leaves Fast Run usable, so we no longer
  // hard-block the entire tab — we just disable Editor mode and steer
  // the user toward Builder + Fast Run via a banner.
  if (!activeStore) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Load an IFC file first — search runs against the active model&apos;s data.
      </div>
    );
  }

  const duckDbUnavailable = available === false;
  const isEditor = searchSqlMode === 'editor' && !duckDbUnavailable;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* ── Top toolbar: mode toggle + Editor-only actions + timing ── */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="inline-flex rounded border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-950">
          <button
            type="button"
            onClick={() => setSearchSqlMode('builder')}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              !isEditor
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Builder
          </button>
          <button
            type="button"
            onClick={() => !duckDbUnavailable && setSearchSqlMode('editor')}
            disabled={duckDbUnavailable}
            title={duckDbUnavailable ? 'SQL Editor needs @duckdb/duckdb-wasm' : undefined}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              isEditor
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            } ${duckDbUnavailable ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            Editor
          </button>
        </div>

        {isEditor && (
          <>
            <div className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                  <FileCode2 className="h-3 w-3" />
                  Templates
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <DropdownMenuLabel>Starter queries</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {listSqlTemplates().map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onSelect={() => applyTemplate(t.sql)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="font-medium">{t.label}</span>
                    <span className="text-[11px] text-muted-foreground">{t.description}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="default"
              size="sm"
              onClick={runEditor}
              disabled={searchSqlRunning || !searchSqlQuery.trim()}
              className="h-7 gap-1 text-xs"
            >
              <Play className="h-3 w-3" />
              {searchSqlRunning ? 'Running…' : 'Run'}
              <kbd className="ml-1 rounded border border-primary-foreground/30 bg-primary-foreground/10 px-1 font-mono text-[9px]">⌘↵</kbd>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={copyQuery}
              disabled={!searchSqlQuery}
              className="h-7 gap-1 text-xs"
              title="Copy query to clipboard"
            >
              <Copy className="h-3 w-3" />
              Copy
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleSaveQuery}
              disabled={!searchSqlQuery.trim()}
              className="h-7 gap-1 text-xs"
              title="Save query under a name"
            >
              <Star className="h-3 w-3" />
              Save
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={savedQueries.length === 0}
                  className="h-7 gap-1 text-xs"
                  title="Saved queries"
                >
                  <Bookmark className="h-3 w-3" />
                  My queries
                  {savedQueries.length > 0 && (
                    <span className="ml-0.5 rounded bg-zinc-200 px-1 text-[9px] dark:bg-zinc-800">
                      {savedQueries.length}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <DropdownMenuLabel>Saved queries</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {savedQueries.length === 0 ? (
                  <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                    No saved queries yet — click Save above to add one.
                  </div>
                ) : (
                  savedQueries.map((q) => (
                    <div
                      key={q.id}
                      className="group flex items-start gap-1 px-1"
                    >
                      <button
                        type="button"
                        onClick={() => handleApplySaved(q)}
                        className="flex-1 truncate rounded px-2 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        title={q.sql}
                      >
                        <div className="truncate font-medium">{q.name}</div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {q.sql.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) ?? q.sql}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSaved(q.id)}
                        aria-label={`Delete saved query ${q.name}`}
                        className="invisible self-center rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground group-hover:visible dark:hover:bg-zinc-800"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {fastRunProgress && fastRunProgress.total > 0 && (
            // Inline progress strip while a Fast Run is in flight. The
            // chunked yieldToEventLoop in the evaluator gives the
            // browser time to paint between updates so this animates
            // smoothly even on 4M-entity scans.
            <span className="inline-flex items-center gap-1.5">
              <span className="relative h-1.5 w-24 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                <span
                  className="absolute left-0 top-0 h-full bg-primary transition-[width] duration-100"
                  style={{
                    width: `${Math.min(100, Math.round((fastRunProgress.scanned / fastRunProgress.total) * 100))}%`,
                  }}
                />
              </span>
              <span className="font-mono">
                {fastRunProgress.scanned.toLocaleString()} / {fastRunProgress.total.toLocaleString()}
              </span>
            </span>
          )}
          {fastRunProgress && fastRunProgress.total <= 0 && (
            <span className="font-mono">
              scanned {fastRunProgress.scanned.toLocaleString()}
            </span>
          )}
          {searchSqlRunning && fastRunController.current && (
            <Button
              variant="ghost"
              size="sm"
              onClick={cancelFastRun}
              className="h-6 gap-1 text-[11px] text-amber-700 hover:text-amber-900 dark:text-amber-300"
              title="Stop the in-flight evaluator"
            >
              Cancel
            </Button>
          )}
          {!searchSqlRunning && fastRunLimitHit !== null && (
            <span
              className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
              title="Increase the limit or narrow the rules to see more matches"
            >
              limited to {fastRunLimitHit.toLocaleString()}
            </span>
          )}
          {searchSqlResult && !searchSqlRunning && (
            <span>⏱ {searchSqlResult.runMs} ms · {searchSqlResult.rows.length.toLocaleString()} rows</span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!searchSqlResult || searchSqlResult.rows.length === 0}
                className="h-7 gap-1 text-xs"
                title="Export results"
              >
                <Download className="h-3 w-3" />
                Export
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
        </div>
      </div>

      {multiModel && (
        <div className="border-b bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          SQL Editor runs against the active model only ({activeModel?.name ?? activeModelId}).
          Fast Run (Builder) evaluates across every loaded model.
        </div>
      )}

      {duckDbUnavailable && (
        <div className="border-b bg-blue-50 px-3 py-1.5 text-[11px] text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          DuckDB-WASM not installed — Editor disabled. Builder &amp; Fast Run still work
          (no DuckDB needed). To enable SQL Editor: <code className="rounded bg-blue-100 px-1 font-mono dark:bg-blue-900/60">pnpm add @duckdb/duckdb-wasm</code>
        </div>
      )}

      {/* ── Body: Builder (full width) OR schema + Editor pair ─────────── */}
      <div className="flex flex-1 min-h-0">
        {isEditor && (
          <aside className="w-56 shrink-0 overflow-y-auto border-r bg-zinc-50/50 px-3 py-3 text-xs dark:bg-zinc-900/30">
            <div className="mb-2 flex items-center gap-1 font-semibold uppercase text-[10px] tracking-wider text-muted-foreground">
              <Database className="h-3 w-3" /> Tables
            </div>
            {SCHEMA.tables.map((t) => (
              <details key={t.name} className="mb-1.5" open>
                <summary className="cursor-pointer rounded px-1 py-0.5 font-mono font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  {t.name}
                </summary>
                <ul className="ml-3 mt-1 space-y-0.5">
                  {t.columns.map((col) => (
                    <li key={col}>
                      <button
                        type="button"
                        className="w-full rounded px-1 py-0.5 text-left font-mono text-[11px] text-muted-foreground hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800"
                        onClick={() => insertAtCursor(col)}
                        title={`Insert "${col}" at cursor`}
                      >
                        {col}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            <div className="mt-3 mb-2 flex items-center gap-1 font-semibold uppercase text-[10px] tracking-wider text-muted-foreground">
              <ExternalLink className="h-3 w-3" /> Views
            </div>
            <ul className="space-y-0.5">
              {SCHEMA.views.map((v) => (
                <li key={v}>
                  <button
                    type="button"
                    className="w-full rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    onClick={() => insertAtCursor(v)}
                    title={`Insert "${v}" at cursor`}
                  >
                    {v}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}

        <div className="flex flex-1 min-w-0 flex-col">
          {isEditor ? (
            <textarea
              ref={textareaRef}
              value={searchSqlQuery}
              onChange={(e) => setSearchSqlQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              placeholder="-- Pick a template, or write SQL against entities / properties / quantities…"
              className="h-48 shrink-0 resize-none border-b bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:bg-background"
            />
          ) : (
            <SearchModalSqlBuilder
              onPromoteToEditor={promoteToEditor}
              onRunSql={(sql) => void runSqlQuery(sql)}
              onRunFast={runFast}
              running={searchSqlRunning}
              sqlUnavailable={duckDbUnavailable}
            />
          )}

          {/* Notebook layout: the latest error stacks ABOVE the previous
              result table, so users keep their last successful query
              visible while debugging the new failure. Mirrors DuckDB UI /
              Jupyter behaviour. */}
          {searchSqlError && <SqlErrorBox raw={searchSqlError} />}
          <SqlResultTable
            result={searchSqlResult}
            selectionKeyIndex={selectionKeyIndex}
            onRowClick={handleRowClick}
          />
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function SqlErrorBox({ raw }: { raw: string }) {
  const rewritten = useMemo(() => rewriteSqlError(raw), [raw]);
  return (
    <div className="flex-1 overflow-y-auto bg-red-50/50 px-4 py-3 dark:bg-red-950/20">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-semibold text-red-900 dark:text-red-200">{rewritten.title}</div>
          {rewritten.hint && (
            <div className="mt-1 text-red-800 dark:text-red-300">{rewritten.hint}</div>
          )}
          {rewritten.raw !== rewritten.title && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-red-700 opacity-80 hover:opacity-100 dark:text-red-400">
                Raw error
              </summary>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-red-100 px-2 py-1 font-mono text-[11px] text-red-900 dark:bg-red-900/30 dark:text-red-200">
                {rewritten.raw}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

interface SqlResultTableProps {
  result: { columns: string[]; rows: unknown[][] } | null;
  selectionKeyIndex: number;
  onRowClick: (row: unknown[]) => void;
}

function SqlResultTable({ result, selectionKeyIndex, onRowClick }: SqlResultTableProps) {
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
        Pick a template or type a query, then ⌘↵ to run.
      </div>
    );
  }

  if (result.rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        0 rows — query ran successfully but returned no matches.
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
