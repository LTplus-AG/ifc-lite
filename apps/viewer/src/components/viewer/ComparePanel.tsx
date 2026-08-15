/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model comparison panel (issue #924). Pick two loaded models as A (base) and
 * B (head), choose a data/geometry/both scope, run the `@ifc-lite/diff` engine,
 * and review added / modified / deleted elements — colour-coded in 3D (via
 * `useCompareOverlay`) and listed here. Row click selects + frames the element.
 */

import { useEffect, useMemo } from 'react';
import { GitCompareArrows, X, Trash2, Download, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useViewerStore } from '@/store';
import { useCompare } from '@/hooks/useCompare';
import { useCompareOverlay } from '@/hooks/useCompareOverlay';
import { posthog } from '@/lib/analytics';
import { COMPARE_COLORS } from '@/lib/compare/overlay';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import { describeChange, type ChangeDetail } from '@/lib/compare/describeChange';
import { downloadCompareReport } from '@/lib/compare/exportReport';
import { ChangeDetailView } from './compare/ChangeDetailView';
import { BcfFromChange } from './compare/BcfFromChange';
import { useBcfFromChange } from './compare/useBcfFromChange';
import { CompareResultsList, CountBadge, LISTED_STATES, type CompareBucket } from './compare/CompareResultsList';
import { CompareRunControls } from './compare/CompareRunControls';
import { changedTypeCounts, contentMatchRows, hasReportableChanges, MAX_ROWS_PER_GROUP, type CompareMatchRow, type CompareRow } from './compare/changeRow';
import { contentMatchCounts, contentMatchingRan } from '@/lib/compare/contentMatches';
import type { DiffState, DiffEntry } from '@ifc-lite/diff';

interface ComparePanelProps {
  onClose?: () => void;
}

/** The side actually drawn for an entry: base for deletions, head otherwise. */
function renderRef(entry: DiffEntry<CompareRef>): CompareRef | undefined {
  return (entry.state === 'deleted' ? entry.base?.ref : entry.head?.ref) ?? entry.base?.ref;
}

export function ComparePanel({ onClose }: ComparePanelProps) {
  useCompareOverlay();

  const models = useViewerStore((s) => s.models);
  const baseModelId = useViewerStore((s) => s.compareBaseModelId);
  const headModelId = useViewerStore((s) => s.compareHeadModelId);
  const scope = useViewerStore((s) => s.compareScope);
  const showUnchanged = useViewerStore((s) => s.compareShowUnchanged);
  const matchByContent = useViewerStore((s) => s.compareMatchByContent);
  const excludedTypes = useViewerStore((s) => s.compareExcludedTypes);
  const selectedKey = useViewerStore((s) => s.compareSelectedKey);
  const setBaseModelId = useViewerStore((s) => s.setCompareBaseModelId);
  const setHeadModelId = useViewerStore((s) => s.setCompareHeadModelId);
  const setScope = useViewerStore((s) => s.setCompareScope);
  const setShowUnchanged = useViewerStore((s) => s.setCompareShowUnchanged);
  const setMatchByContent = useViewerStore((s) => s.setCompareMatchByContent);
  const addExcludedType = useViewerStore((s) => s.addCompareExcludedType);
  const removeExcludedType = useViewerStore((s) => s.removeCompareExcludedType);
  const clearExcludedTypes = useViewerStore((s) => s.clearCompareExcludedTypes);
  const clearCompare = useViewerStore((s) => s.clearCompare);
  const bcfAuthor = useViewerStore((s) => s.bcfAuthor);

  const { running, result, error, runComparison } = useCompare();

  const modelList = useMemo(() => Array.from(models.values()), [models]);

  // BCF-from-change flow (form state, viewpoint capture, topic creation).
  const bcf = useBcfFromChange(modelList, selectedKey);

  // Default the A/B selection to the first two loaded models, and repair the
  // selection if a chosen model was removed.
  useEffect(() => {
    const ids = modelList.map((m) => m.id);
    // A comparison computed against a model that's since been removed leaves a
    // stale overlay on the survivor (the overlay hook keys off the result, not
    // the model list) — drop it so the scene is restored.
    const ran = useViewerStore.getState().compareResult;
    if (ran && (!ids.includes(ran.baseModelId) || !ids.includes(ran.headModelId))) {
      clearCompare();
    }
    if (ids.length === 0) return;
    if (!baseModelId || !ids.includes(baseModelId)) {
      setBaseModelId(ids[0]);
    }
    if (ids.length > 1 && (!headModelId || !ids.includes(headModelId) || headModelId === ids[0])) {
      const other = ids.find((id) => id !== ids[0]);
      if (other) setHeadModelId(other);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelList]);

  // Resolve a display name + grouped rows from the diff result. Names live in
  // the per-model store (the engine result carries only type + key), so we
  // look them up here via each entry's ref.
  const groups = useMemo(() => {
    const empty = new Map<DiffState, CompareBucket>();
    if (!result) return empty;
    const out = new Map<DiffState, CompareBucket>();
    for (const { state } of LISTED_STATES) out.set(state, { rows: [], truncated: 0 });

    for (const entry of result.diff.entries) {
      const bucket = out.get(entry.state);
      if (!bucket) continue; // skip unchanged
      const ref = renderRef(entry);
      if (!ref) continue;
      if (bucket.rows.length >= MAX_ROWS_PER_GROUP) {
        bucket.truncated++;
        continue;
      }
      const store = models.get(ref.modelId)?.ifcDataStore;
      const name = store?.entities.getName(ref.localId) || '';
      const ifcType = (entry.head ?? entry.base)?.ifcType ?? 'IfcProduct';
      bucket.rows.push({ key: entry.key, ifcType, name, state: entry.state, changeKinds: entry.changeKinds, ref });
    }
    return out;
  }, [result, models]);

  // Content-match rows (#1891). They live on `diff.contentMatches`, NOT in
  // `diff.entries` - a retiring match removed its entries outright - so this is
  // separate plumbing rather than another bucket of `groups`.
  const matchRows = useMemo<CompareMatchRow[]>(
    () =>
      contentMatchRows(result?.diff.contentMatches, (ref) =>
        models.get(ref.modelId)?.ifcDataStore?.entities.getName(ref.localId) || '',
      ),
    [result, models],
  );
  const matchCounts = useMemo(() => contentMatchCounts(result?.diff.contentMatches), [result]);

  const counts = result?.diff.counts;
  const canRun = !!baseModelId && !!headModelId && baseModelId !== headModelId && !running;

  // Classes present among the current changes - the "ignore a class" picker's
  // options (#1470). Excluded classes are already absent from the diff.
  const typeCounts = useMemo(
    () => (result ? changedTypeCounts(result.diff.entries) : []),
    [result],
  );

  // "What changed" detail for the selected entry — computed lazily from both
  // stores so a huge diff stays cheap (only the selection is described).
  const detail = useMemo<ChangeDetail | null>(() => {
    if (!result || !selectedKey) return null;
    const entry = result.diff.byKey.get(selectedKey);
    return entry ? describeChange(entry, models) : null;
  }, [result, selectedKey, models]);

  const selectedRow = useMemo<CompareRow | null>(() => {
    if (!selectedKey) return null;
    for (const bucket of groups.values()) {
      const row = bucket.rows.find((r) => r.key === selectedKey);
      if (row) return row;
    }
    return null;
  }, [groups, selectedKey]);

  const focusEntry = (row: CompareRow) => {
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.setSelectedEntityIds([row.ref.globalId]);
    state.addEntitiesToSelection([{ modelId: row.ref.modelId, expressId: row.ref.localId }]);
    state.setCompareSelectedKey(row.key);
    requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
  };

  // Select every element in a state bucket at once (section-header click).
  // Iterates the full diff entries — not the display-capped `groups` rows — so
  // the selection matches the header count, including "+N more not shown" rows.
  const focusGroup = (groupState: DiffState) => {
    if (!result) return;
    const refs = result.diff.entries
      .filter((e) => e.state === groupState)
      .map(renderRef)
      .filter((r): r is CompareRef => !!r);
    if (refs.length === 0) return;
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.setSelectedEntityIds(refs.map((r) => r.globalId));
    state.addEntitiesToSelection(refs.map((r) => ({ modelId: r.modelId, expressId: r.localId })));
    state.setCompareSelectedKey(null); // bulk select → no single-row "what changed" detail
    requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
  };

  /** Select the elements a content-match row stands for. Retiring matches
   *  select their head copies (the base copies are hidden by the overlay);
   *  review groups select every candidate on both sides. */
  const focusMatch = (row: CompareMatchRow) => {
    if (row.refs.length === 0) return;
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.setSelectedEntityIds(row.refs.map((r) => r.globalId));
    state.addEntitiesToSelection(row.refs.map((r) => ({ modelId: r.modelId, expressId: r.localId })));
    // A content match is not a `DiffEntry`, so it has no "what changed" detail
    // and no BCF pre-fill yet - the row key still drives the list highlight.
    state.setCompareSelectedKey(row.key);
    requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
  };

  const focusMatchGroup = (rows: CompareMatchRow[]) => {
    const refs = rows.flatMap((row) => row.refs);
    if (refs.length === 0) return;
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.setSelectedEntityIds(refs.map((r) => r.globalId));
    state.addEntitiesToSelection(refs.map((r) => ({ modelId: r.modelId, expressId: r.localId })));
    state.setCompareSelectedKey(null);
    requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
  };

  const downloadReport = (format: 'csv' | 'json') => {
    if (!result) return;
    // Pass the blacklist in its original IFC casing so the report reads
    // "IfcOpeningElement", not the engine's uppercase-normalized form (#1470).
    downloadCompareReport(format, result, models, excludedTypes);
    const c = result.diff.counts;
    posthog.capture('model_compare_export', {
      format,
      scope: result.scope,
      row_count: c.added + c.modified + c.deleted,
    });
  };

  // Composing a BCF issue: collapse the diff chrome so the form owns the panel.
  // Gate on the selected row too, so a vanished selection can never leave the
  // panel empty (chrome hidden but no form to show).
  const bcfComposing = bcf.formOpen && !!selectedRow;

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <GitCompareArrows className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-semibold tracking-tight min-w-0">Compare models</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {result && !bcfComposing && (
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Clear results" onClick={clearCompare}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Close" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {modelList.length < 2 ? (
        <div className="p-4 text-sm text-muted-foreground">
          Load a second model to compare. Open two IFC files (federation), then pick
          version A and version B here.
        </div>
      ) : (
        <>
          {/* Diff chrome (run controls, counts, report, results, detail) — hidden
              while composing a BCF issue so the form owns the panel. The user has
              committed to raising an issue and the change context is already in the
              pre-filled form, so re-running / exports / browsing only get in the way. */}
          {!bcfComposing && (
            <>
              <CompareRunControls
                models={modelList}
                baseModelId={baseModelId}
                headModelId={headModelId}
                onBaseModelId={setBaseModelId}
                onHeadModelId={setHeadModelId}
                scope={scope}
                onScope={setScope}
                showUnchanged={showUnchanged}
                onShowUnchanged={setShowUnchanged}
                matchByContent={matchByContent}
                onMatchByContent={setMatchByContent}
                canRun={canRun}
                running={running}
                onRun={() => void runComparison()}
                error={error}
                geometryUnavailable={!!result?.geometryUnavailable}
                excludedTypes={excludedTypes}
                changedTypeCounts={typeCounts}
                onAddExcludedType={addExcludedType}
                onRemoveExcludedType={removeExcludedType}
                onClearExcludedTypes={clearExcludedTypes}
              />

              {/* Counts. The Matched badge appears when the content pass RAN, not
                  when it found something (#1891) — added/deleted are lower BECAUSE
                  of it, so the number explaining the drop sits next to them. */}
              {counts && (
                <div
                  className={cn(
                    'grid gap-1 p-3 border-b border-border text-center',
                    contentMatchingRan(result?.diff.contentMatches) ? 'grid-cols-5' : 'grid-cols-4',
                  )}
                  {...tourAnchor(TOUR_ANCHORS.compareCounts)}
                >
                  <CountBadge label="Changed" value={counts.modified} color={COMPARE_COLORS.modified} />
                  <CountBadge label="Added" value={counts.added} color={COMPARE_COLORS.added} />
                  <CountBadge label="Deleted" value={counts.deleted} color={COMPARE_COLORS.deleted} />
                  {contentMatchingRan(result?.diff.contentMatches) && (
                    <CountBadge label="Matched" value={matchCounts.matchedElements} color={COMPARE_COLORS.matched} />
                  )}
                  <CountBadge label="Unchanged" value={counts.unchanged} color={COMPARE_COLORS.unchanged} />
                </div>
              )}

              {/* Export the full change report (#1202) — exact negation of the results list's empty state. */}
              {result && counts && hasReportableChanges(counts, matchRows) && (
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
                  <Download className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Download report</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => downloadReport('csv')}>
                      CSV
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => downloadReport('json')}>
                      JSON
                    </Button>
                  </div>
                </div>
              )}

              {/* Results list */}
              <CompareResultsList
                result={result}
                groups={groups}
                counts={counts}
                matchRows={matchRows}
                selectedKey={selectedKey}
                onFocus={focusEntry}
                onFocusGroup={focusGroup}
                onFocusMatch={focusMatch}
                onFocusMatchGroup={focusMatchGroup}
              />

              {/* What-changed detail for the selected element */}
              {detail && selectedRow && <ChangeDetailView row={selectedRow} detail={detail} />}
            </>
          )}

          {/* Compose context — slim strip naming the target element while the BCF
              form is open, with a way back to the change list. */}
          {bcfComposing && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs shrink-0">
              <button
                type="button"
                onClick={() => bcf.setFormOpen(false)}
                className="flex items-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
                title="Back to changes"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-muted-foreground shrink-0">Issue for</span>
              <span className="font-medium truncate min-w-0">{selectedRow.name || selectedRow.ifcType}</span>
              <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                {selectedRow.ifcType.replace(/^Ifc/, '')}
              </span>
            </div>
          )}

          {/* Raise a BCF issue from the focused change (#1199) */}
          {selectedRow && (
            <BcfFromChange
              row={selectedRow}
              detail={detail}
              author={bcfAuthor}
              open={bcf.formOpen}
              createdTitle={bcf.createdTitle}
              onStart={() => { bcf.setCreatedTitle(null); bcf.setFormOpen(true); }}
              onCancel={() => bcf.setFormOpen(false)}
              onSubmit={bcf.submit}
              onOpenBcfPanel={() => useViewerStore.getState().openWorkspacePanel('bcf')}
              snapshot={bcf.viewpoint?.snapshot ?? null}
              onCaptureSnapshot={() => void bcf.captureViewpoint()}
              capturingSnapshot={bcf.capturingSnapshot}
            />
          )}
        </>
      )}
    </div>
  );
}
