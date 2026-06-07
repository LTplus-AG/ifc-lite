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
import { GitCompareArrows, Plus, Minus, PencilLine, Loader2, Play, X, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useCompare } from '@/hooks/useCompare';
import { useCompareOverlay } from '@/hooks/useCompareOverlay';
import { COMPARE_COLORS, type RGBA } from '@/lib/compare/overlay';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import { describeChange, type ChangeDetail, type FieldDelta, type GeometrySummary } from '@/lib/compare/describeChange';
import type { DiffScope, DiffState, DiffEntry } from '@ifc-lite/diff';

interface ComparePanelProps {
  onClose?: () => void;
}

const SCOPES: { id: DiffScope; label: string }[] = [
  { id: 'both', label: 'Both' },
  { id: 'data', label: 'Data' },
  { id: 'geometry', label: 'Geometry' },
];

/** States listed in the panel (unchanged only affects 3D ghosting). */
const LISTED_STATES: { state: Exclude<DiffState, 'unchanged'>; label: string; color: RGBA; Icon: typeof Plus }[] = [
  { state: 'modified', label: 'Changed', color: COMPARE_COLORS.modified, Icon: PencilLine },
  { state: 'added', label: 'Added', color: COMPARE_COLORS.added, Icon: Plus },
  { state: 'deleted', label: 'Deleted', color: COMPARE_COLORS.deleted, Icon: Minus },
];

/** Cap rows rendered per group so a huge diff can't stall the DOM. */
const MAX_ROWS_PER_GROUP = 1000;

function rgbaCss([r, g, b, a]: RGBA): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

interface CompareRow {
  key: string;
  ifcType: string;
  name: string;
  changeKinds: string[];
  ref: CompareRef;
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
  const selectedKey = useViewerStore((s) => s.compareSelectedKey);
  const setBaseModelId = useViewerStore((s) => s.setCompareBaseModelId);
  const setHeadModelId = useViewerStore((s) => s.setCompareHeadModelId);
  const setScope = useViewerStore((s) => s.setCompareScope);
  const setShowUnchanged = useViewerStore((s) => s.setCompareShowUnchanged);
  const clearCompare = useViewerStore((s) => s.clearCompare);

  const { running, result, error, runComparison } = useCompare();

  const modelList = useMemo(() => Array.from(models.values()), [models]);

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
    const empty = new Map<DiffState, { rows: CompareRow[]; truncated: number }>();
    if (!result) return empty;
    const out = new Map<DiffState, { rows: CompareRow[]; truncated: number }>();
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
      bucket.rows.push({ key: entry.key, ifcType, name, changeKinds: entry.changeKinds, ref });
    }
    return out;
  }, [result, models]);

  const counts = result?.diff.counts;
  const canRun = !!baseModelId && !!headModelId && baseModelId !== headModelId && !running;

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

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <GitCompareArrows className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-semibold tracking-tight min-w-0">Compare models</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {result && (
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
          {/* Run controls */}
          <div className="p-3 space-y-3 border-b border-border">
            <div className="grid grid-cols-[1.25rem_1fr] items-center gap-x-2 gap-y-2 text-xs">
              <span className="text-muted-foreground">A</span>
              <select
                value={baseModelId ?? ''}
                onChange={(e) => setBaseModelId(e.target.value)}
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-foreground min-w-0"
              >
                {modelList.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <span className="text-muted-foreground">B</span>
              <select
                value={headModelId ?? ''}
                onChange={(e) => setHeadModelId(e.target.value)}
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-foreground min-w-0"
              >
                {modelList.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>

            {baseModelId === headModelId && (
              <p className="text-xs text-[#e0af68]">Pick two different models.</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-border overflow-hidden text-xs shrink-0">
                {SCOPES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setScope(s.id)}
                    className={cn(
                      'px-2.5 py-1 transition-colors',
                      scope === s.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showUnchanged}
                  onChange={(e) => setShowUnchanged(e.target.checked)}
                />
                Show unchanged
              </label>
            </div>

            <Button size="sm" className="w-full gap-1.5" disabled={!canRun} onClick={() => void runComparison()}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? 'Comparing…' : 'Run comparison'}
            </Button>

            {error && <p className="text-xs text-[#f7768e]">{error}</p>}

            {result?.geometryUnavailable && scope !== 'data' && (
              <p className="text-xs text-[#e0af68]">
                One model has no geometry fingerprints (loaded outside the WASM
                mesh path), so geometry changes can’t be detected. Data changes
                are still accurate — switch to the Data scope for reliable results.
              </p>
            )}
          </div>

          {/* Counts */}
          {counts && (
            <div className="grid grid-cols-4 gap-1 p-3 border-b border-border text-center">
              <CountBadge label="Changed" value={counts.modified} color={COMPARE_COLORS.modified} />
              <CountBadge label="Added" value={counts.added} color={COMPARE_COLORS.added} />
              <CountBadge label="Deleted" value={counts.deleted} color={COMPARE_COLORS.deleted} />
              <CountBadge label="Unchanged" value={counts.unchanged} color={COMPARE_COLORS.unchanged} />
            </div>
          )}

          {/* Results list */}
          <ScrollArea className="flex-1 min-h-0">
            {!result ? (
              <div className="p-4 text-sm text-muted-foreground">
                Run a comparison to see added, changed, and deleted elements.
              </div>
            ) : (
              <div className="p-2 space-y-3">
                {LISTED_STATES.map(({ state, label, color, Icon }) => {
                  const bucket = groups.get(state);
                  if (!bucket || bucket.rows.length === 0) return null;
                  return (
                    <div key={state}>
                      <div className="flex items-center gap-1.5 px-1 py-1 text-xs font-medium">
                        <Icon className="h-3.5 w-3.5" style={{ color: rgbaCss(color) }} />
                        <span>{label}</span>
                        <span className="text-muted-foreground">({bucket.rows.length + bucket.truncated})</span>
                      </div>
                      <div className="space-y-0.5">
                        {bucket.rows.map((row) => (
                          <button
                            key={row.key}
                            onClick={() => focusEntry(row)}
                            className={cn(
                              'w-full text-left rounded px-2 py-1 flex items-center gap-2 hover:bg-muted transition-colors min-w-0',
                              selectedKey === row.key && 'bg-muted',
                            )}
                          >
                            <span
                              className="h-2.5 w-2.5 rounded-sm shrink-0"
                              style={{ backgroundColor: rgbaCss(color) }}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs">
                              {row.name || row.ifcType}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {state === 'modified' && row.changeKinds.length > 0
                                ? row.changeKinds.join(' · ')
                                : row.ifcType.replace(/^Ifc/, '')}
                            </span>
                          </button>
                        ))}
                        {bucket.truncated > 0 && (
                          <p className="px-2 py-1 text-[10px] text-muted-foreground">
                            +{bucket.truncated} more not shown
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
                {counts && counts.added + counts.modified + counts.deleted === 0 && (
                  <div className="p-3 text-sm text-muted-foreground">
                    No differences in scope “{result.scope}”. The models match.
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          {/* What-changed detail for the selected element */}
          {detail && selectedRow && <ChangeDetailView row={selectedRow} detail={detail} />}
        </>
      )}
    </div>
  );
}

/** Per-element "what changed" — geometry move/reshape + data field deltas. */
function ChangeDetailView({ row, detail }: { row: CompareRow; detail: ChangeDetail }) {
  return (
    <div className="border-t border-border shrink-0 max-h-[42%] overflow-auto">
      <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-1.5 sticky top-0 bg-background">
        <PencilLine className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-semibold truncate">{row.name || row.ifcType}</span>
        <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{row.ifcType.replace(/^Ifc/, '')}</span>
      </div>
      <div className="px-3 pb-3 space-y-2.5 text-xs">
        {detail.geometry && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Geometry</div>
            <GeometryDetail summary={detail.geometry} />
          </div>
        )}
        {detail.data.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Data <span className="text-muted-foreground/70">({detail.data.length})</span>
            </div>
            <div className="space-y-1">
              {detail.data.map((d, i) => <FieldDeltaRow key={i} delta={d} />)}
            </div>
          </div>
        ) : detail.dataOnlyGeometric ? (
          <div className="text-[11px] text-muted-foreground italic">
            Data fingerprint differs but no field-level change could be pinpointed.
          </div>
        ) : !detail.geometry ? (
          <div className="text-[11px] text-muted-foreground italic">No field-level detail available.</div>
        ) : null}
      </div>
    </div>
  );
}

function GeometryDetail({ summary }: { summary: GeometrySummary }) {
  const moved = summary.movedDistance >= 1e-3;
  const fmt = (n: number) => (Math.abs(n) < 1e-3 ? '0' : n.toFixed(n >= 1 ? 2 : 3));
  const headline = summary.reshaped ? (moved ? 'Reshaped + moved' : 'Reshaped') : moved ? 'Moved' : 'Geometry changed';
  return (
    <div className="rounded border border-border/60 px-2 py-1.5 space-y-0.5">
      <div className="font-medium">{headline}</div>
      {moved && (
        <div className="text-muted-foreground tabular-nums">
          {fmt(summary.movedDistance)} m
          <span className="text-muted-foreground/70">
            {' '}(Δx {fmt(summary.delta.x)}, Δy {fmt(summary.delta.y)}, Δz {fmt(summary.delta.z)})
          </span>
        </div>
      )}
    </div>
  );
}

function FieldDeltaRow({ delta }: { delta: FieldDelta }) {
  const kindColor: Record<FieldDelta['kind'], string> = {
    changed: 'text-[#e0af68]',
    added: 'text-[#9ece6a]',
    removed: 'text-[#f7768e]',
  };
  return (
    <div className="rounded border border-border/40 px-2 py-1">
      <div className="flex items-baseline gap-1.5 min-w-0">
        {delta.group && <span className="text-[10px] text-muted-foreground shrink-0 truncate max-w-[40%]">{delta.group}</span>}
        <span className="text-[11px] font-medium truncate">{delta.name}</span>
        <span className={cn('ml-auto text-[10px] shrink-0', kindColor[delta.kind])}>{delta.kind}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] tabular-nums mt-0.5 min-w-0">
        <span className="text-muted-foreground line-through truncate max-w-[45%]">{delta.before ?? '—'}</span>
        <span className="text-muted-foreground/60 shrink-0">→</span>
        <span className="truncate max-w-[45%]">{delta.after ?? '—'}</span>
      </div>
    </div>
  );
}

function CountBadge({ label, value, color }: { label: string; value: number; color: RGBA }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-sm font-semibold tabular-nums" style={{ color: rgbaCss([color[0], color[1], color[2], 1]) }}>
        {value.toLocaleString()}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}
