/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useState } from 'react';
import {
  X,
  Play,
  Loader2,
  Trash2,
  Crosshair,
  Copy,
  Info,
  Focus,
  ArrowUpDown,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Layers,
  FilePlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useClash } from '@/hooks/useClash';
import { useBCF } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { ClashBcfExportDialog } from '@/components/viewer/ClashBcfExportDialog';
import { ClashSettingsDialog } from '@/components/viewer/ClashSettingsDialog';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import {
  isTouching,
  penetrationDepth,
  sortClashes,
  DUPLICATES_RULE,
  type Clash,
  type ClashElementRef,
  type ClashSeverity,
  type ClashSortBy,
} from '@ifc-lite/clash';

interface ClashPanelProps {
  onClose?: () => void;
}

const SEVERITY_ORDER: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];

const SEVERITY: Record<ClashSeverity, { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#f7768e' },
  major: { label: 'Major', color: '#ff9e64' },
  minor: { label: 'Minor', color: '#e0af68' },
  info: { label: 'Info', color: '#7aa2f7' },
};

const SORT_LABEL: Record<ClashSortBy, string> = {
  severity: 'Sort: severity',
  depth: 'Sort: overlap depth',
  distance: 'Sort: distance',
};

/** Distinct colours for the two sides of a pair so each is identifiable when
 *  stepping through (#1277). The 3D view highlights both via the selection
 *  channel; these dots label which row is which side. */
const SIDE_COLOR = ['#7dcfff', '#bb9af7'] as const;

function shortName(key: string): string {
  return key.length > 10 ? `${key.slice(0, 8)}…` : key;
}

function formatDistance(distance: number): string {
  return distance < 0 ? `−${Math.abs(distance).toFixed(3)}m` : `${distance.toFixed(3)}m`;
}

/** A plain-language description of what a clash is and why it was flagged (#1276). */
function describeClash(c: Clash): string {
  if (c.rule === DUPLICATES_RULE.id) {
    return c.severity === 'major'
      ? 'Exact duplicate — coincident geometry with the same shape'
      : 'Overlapping — near-coincident objects in the same place';
  }
  if (c.status === 'clearance') {
    return `Clearance violation — ${c.distance.toFixed(3)} m gap, closer than required`;
  }
  if (isTouching(c)) {
    return 'Touching contact (≈0 m) — surfaces meet but barely overlap';
  }
  return `Hard clash — ${penetrationDepth(c).toFixed(3)} m interpenetration`;
}

export function ClashPanel({ onClose }: ClashPanelProps) {
  const {
    result,
    running,
    error,
    progress,
    mode,
    tolerance,
    clearance,
    groupBy,
    selectedId,
    presets,
    modelCount,
    setMode,
    setTolerance,
    setClearance,
    setGroupBy,
    runAll,
    runMatrix,
    runPreset,
    runDuplicates,
    focusClash,
    selectElement,
    highlightAll,
    clearHighlight,
    clearAll,
  } = useClash();

  // In-app BCF: create a topic from a clash without leaving the tool (#1279).
  const { createViewpointFromState } = useBCF();
  const bcfProject = useViewerStore((s) => s.bcfProject);
  const bcfAuthor = useViewerStore((s) => s.bcfAuthor);
  const setBcfProject = useViewerStore((s) => s.setBcfProject);
  const addTopic = useViewerStore((s) => s.addTopic);
  const addViewpoint = useViewerStore((s) => s.addViewpoint);
  const setBcfPanelVisible = useViewerStore((s) => s.setBcfPanelVisible);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<ClashSortBy>('severity');
  const [hideTouching, setHideTouching] = useState(false);
  const [isolateOnSelect, setIsolateOnSelect] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [creatingTopic, setCreatingTopic] = useState(false);

  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Touching (≈0 m contact) count — surfaced so the user can choose to hide them. */
  const touchingCount = useMemo(
    () => (result ? result.clashes.filter((c) => isTouching(c)).length : 0),
    [result],
  );

  /** The clashes actually shown: touching filter applied, then ordered by `sortBy`. */
  const visibleClashes = useMemo(() => {
    if (!result) return [] as Clash[];
    const list = hideTouching ? result.clashes.filter((c) => !isTouching(c)) : result.clashes;
    return sortClashes(list, sortBy);
  }, [result, hideTouching, sortBy]);

  // Group the (filtered, sorted) clash list for display along the selected dimension.
  // Items keep their sorted order within each bucket.
  const sections = useMemo(() => {
    if (!result) return [] as Array<{ key: string; label: string; color?: string; items: Clash[] }>;
    const buckets = new Map<string, Clash[]>();
    for (const c of visibleClashes) {
      const key =
        groupBy === 'severity'
          ? c.severity
          : groupBy === 'rule'
            ? c.rule
            : [c.a.tag, c.b.tag].sort().join(' × ');
      const list = buckets.get(key);
      if (list) list.push(c);
      else buckets.set(key, [c]);
    }
    const entries = [...buckets.entries()];
    if (groupBy === 'severity') {
      entries.sort((a, b) => SEVERITY_ORDER.indexOf(a[0] as ClashSeverity) - SEVERITY_ORDER.indexOf(b[0] as ClashSeverity));
    } else {
      entries.sort((a, b) => b[1].length - a[1].length);
    }
    // Map rule id → human name for "By rule" labels. rulesRun covers every rule
    // that actually ran — discipline presets, custom presets, the synthetic
    // "all-clashes" and the duplicate scan — so no hardcoding is needed.
    const ruleNames = new Map(result.rulesRun.map((r) => [r.id, r.name]));
    return entries.map(([key, items]) => ({
      key,
      label:
        groupBy === 'severity'
          ? SEVERITY[key as ClashSeverity].label
          : groupBy === 'rule'
            ? ruleNames.get(key) ?? key
            : key,
      color: groupBy === 'severity' ? SEVERITY[key as ClashSeverity].color : undefined,
      items,
    }));
  }, [result, visibleClashes, groupBy]);

  const total = result?.summary.total ?? 0;
  const shown = visibleClashes.length;
  const bySeverity = result?.summary.bySeverity;

  /**
   * Create a BCF topic from the selected clash (or the whole result) directly in
   * the in-app issue tracker — no download/re-import round-trip (#1279). The
   * clash is framed + selected first so the captured viewpoint shows it.
   */
  const createBcfTopic = useCallback(async (): Promise<void> => {
    if (!result || creatingTopic) return;
    const clash = selectedId ? result.clashes.find((c) => c.id === selectedId) ?? null : null;
    setCreatingTopic(true);
    try {
      if (clash) {
        focusClash(clash);
        // Wait for the camera move + a render before grabbing the snapshot.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (!bcfProject) setBcfProject(createBCFProject({ name: 'Clash report' }));
      const title = clash
        ? `Clash: ${clash.a.tag} × ${clash.b.tag}`
        : `Clash report — ${total} ${total === 1 ? 'clash' : 'clashes'}`;
      const description = clash
        ? `${describeClash(clash)}\n${clash.a.name ?? clash.a.key} ↔ ${clash.b.name ?? clash.b.key}`
        : `${total} ${total === 1 ? 'clash' : 'clashes'} detected across the loaded model(s).`;
      const topic = createBCFTopic({ title, description, author: bcfAuthor, topicType: 'Clash', topicStatus: 'Open' });
      addTopic(topic);
      const vp = await createViewpointFromState({ includeSnapshot: true, includeSelection: true, includeHidden: true });
      if (vp) addViewpoint(topic.guid, vp);
      setBcfPanelVisible(true);
    } catch (err) {
      console.error('[clash] BCF topic creation failed', err);
    } finally {
      setCreatingTopic(false);
    }
  }, [result, creatingTopic, selectedId, focusClash, bcfProject, setBcfProject, total, bcfAuthor, addTopic, createViewpointFromState, addViewpoint, setBcfPanelVisible]);

  /** One side (A or B) of a clash inside the expanded row (#1276). */
  const ElementRow = ({ el, side }: { el: ClashElementRef; side: 0 | 1 }) => (
    <button
      onClick={() => selectElement(el, isolateOnSelect)}
      title={`${el.tag} · ${el.name ?? el.key}`}
      className="flex w-full items-center gap-2 py-1 pl-7 pr-3 text-left hover:bg-muted/50"
    >
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: SIDE_COLOR[side] }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-foreground">{el.tag}</div>
        <div className="truncate text-[10px] text-muted-foreground">{el.name ?? shortName(el.key)}</div>
      </div>
      <Focus className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <Crosshair className="h-4 w-4 text-[#f7768e] shrink-0" />
        <span className="text-sm font-semibold tracking-tight min-w-0">Clash detection</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7', showHelp && 'text-primary')}
            title="How clash detection works"
            onClick={() => setShowHelp((v) => !v)}
          >
            <Info className="h-4 w-4" />
          </Button>
          <ClashSettingsDialog />
          {result && (
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Clear results" onClick={clearAll}>
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

      {/* Help / explanation (#1272, #1274) */}
      {showHelp && (
        <div className="px-3 py-2.5 border-b border-border bg-muted/30 text-[11px] leading-relaxed text-muted-foreground space-y-1.5">
          <p>
            <b className="text-foreground">Hard</b> finds interpenetrations (overlap beyond <i>tol</i>).{' '}
            <b className="text-foreground">Clearance</b> additionally flags elements closer than the required{' '}
            <i>gap</i> — so raising the gap adds <i>more</i> results, it does not filter existing ones.
          </p>
          <p>
            <b className="text-foreground">tol</b> is the touch band (m) — how much bare surface contact is ignored.{' '}
            <b className="text-foreground">gap</b> (clearance mode) is the minimum required separation.
          </p>
          <p>
            <b className="text-foreground">Severity</b> comes from the element-type pair (e.g. pipe vs structure =
            critical), <i>not</i> from overlap depth. Sort by <i>overlap depth</i> to surface the worst
            interpenetrations first.
          </p>
          <p>
            <b className="text-foreground">Touching</b> results sit at ≈0 m — coincident faces such as a wall meeting a
            slab. Hide them to focus on genuine overlaps.
          </p>
        </div>
      )}

      {/* Run controls */}
      <div className="p-3 space-y-3 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs shrink-0">
            {(['hard', 'clearance'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'px-2.5 py-1 capitalize transition-colors',
                  mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-xs text-muted-foreground" title="Touch band (m): surface contact within this distance is ignored">
            tol
            <input
              type="number"
              step={0.001}
              min={0}
              value={tolerance}
              onChange={(e) => setTolerance(Number(e.target.value))}
              className="w-16 rounded border border-border bg-transparent px-1.5 py-0.5 text-foreground"
            />
          </label>
          {mode === 'clearance' && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground" title="Minimum required separation (m); elements closer than this are flagged">
              gap
              <input
                type="number"
                step={0.01}
                min={0}
                value={clearance}
                onChange={(e) => setClearance(Number(e.target.value))}
                className="w-16 rounded border border-border bg-transparent px-1.5 py-0.5 text-foreground"
              />
            </label>
          )}
        </div>

        <Button className="w-full h-8" disabled={running} onClick={() => void runAll()}>
          {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Crosshair className="h-4 w-4 mr-1.5" />}
          {running ? 'Detecting…' : 'Detect all clashes'}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 h-7 text-xs"
            disabled={running}
            onClick={() => void runDuplicates()}
            title="Find duplicate or fully-overlapping objects in the loaded geometry"
          >
            <Copy className="h-3.5 w-3.5 mr-1.5" />
            Find duplicates
          </Button>
          <Button
            variant="outline"
            className="flex-1 h-7 text-xs"
            disabled={running}
            onClick={() => void runMatrix()}
            title="Run the enabled discipline-vs-discipline rules"
          >
            <Play className="h-3.5 w-3.5 mr-1.5" />
            Discipline matrix
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.id}
              disabled={running}
              onClick={() => void runPreset(p.id)}
              title={p.description}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                'border-border hover:bg-muted disabled:opacity-50',
              )}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: SEVERITY[p.severity].color }} />
              {p.name}
            </button>
          ))}
        </div>

        {/* Live progress — the engine yields between chunks so this paints even
            on large models that take a while (#1281). */}
        {running && progress && (() => {
          const determinate = progress.total > 0;
          const pct = determinate ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
          const label = determinate
            ? `Checking ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} pairs`
            : 'Preparing geometry…';
          return (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="truncate">{label}</span>
                {determinate && <span className="tabular-nums">{pct}%</span>}
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full bg-[#f7768e]', determinate ? 'transition-[width] duration-150' : 'w-2/5 animate-pulse')}
                  style={determinate ? { width: `${pct}%` } : undefined}
                />
              </div>
            </div>
          );
        })()}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 m-3 p-2 rounded-md bg-[#f7768e]/10 text-[#f7768e] text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Summary */}
      {result && (
        <div className="px-3 py-2.5 border-b border-border">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-2xl font-semibold tabular-nums">{total}</span>
            <span className="text-xs text-muted-foreground">
              {total === 1 ? 'clash' : 'clashes'}
              {hideTouching && touchingCount > 0 && ` · ${shown} shown`}
            </span>
          </div>
          {total > 0 && bySeverity && (
            <>
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                {SEVERITY_ORDER.map((s) =>
                  bySeverity[s] > 0 ? (
                    <div
                      key={s}
                      style={{ width: `${(bySeverity[s] / total) * 100}%`, background: SEVERITY[s].color }}
                    />
                  ) : null,
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                {SEVERITY_ORDER.filter((s) => bySeverity[s] > 0).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ background: SEVERITY[s].color }} />
                    {SEVERITY[s].label} {bySeverity[s]}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Toolbar: group-by + sort + actions */}
      {result && total > 0 && (
        <div className="px-3 py-2 border-b border-border text-xs space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
              className="min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5"
            >
              <option value="severity">By severity</option>
              <option value="rule">By rule</option>
              <option value="typePair">By type pair</option>
            </select>
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ClashSortBy)}
              className="min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5"
            >
              {(['severity', 'depth', 'distance'] as ClashSortBy[]).map((s) => (
                <option key={s} value={s}>{SORT_LABEL[s]}</option>
              ))}
            </select>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={creatingTopic}
                title={selectedId ? 'Create a BCF topic from the selected clash' : 'Create a BCF topic for this clash report'}
                onClick={() => void createBcfTopic()}
              >
                {creatingTopic ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FilePlus className="h-3.5 w-3.5 mr-1" />}
                BCF topic
              </Button>
              <ClashBcfExportDialog />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <label className="inline-flex items-center gap-1.5 cursor-pointer" title="Hide ≈0 m face/edge contacts">
              <input type="checkbox" checked={hideTouching} onChange={(e) => setHideTouching(e.target.checked)} className="accent-[#f7768e]" />
              Hide touching{touchingCount > 0 ? ` (${touchingCount})` : ''}
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer" title="When selecting a clash, hide everything except the clashing objects">
              <input type="checkbox" checked={isolateOnSelect} onChange={(e) => setIsolateOnSelect(e.target.checked)} className="accent-[#f7768e]" />
              Isolate on select
            </label>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" title="Select every element involved in a clash" onClick={highlightAll}>
                Highlight all
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" title="Clear selection and isolation" onClick={clearHighlight}>
                Clear
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      <ScrollArea className="flex-1">
        {!result && !running && (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center text-muted-foreground">
            <Crosshair className="h-8 w-8 mb-3 opacity-40" />
            <p className="text-sm">
              {modelCount <= 1
                ? 'Check this model in seconds: “Detect all clashes” finds every overlap inside it, and “Find duplicates” catches coincident objects — no discipline setup needed.'
                : 'Detect all clashes, run the discipline matrix, or pick a preset to find conflicts across the loaded models.'}
            </p>
            <p className="mt-2 text-[11px]">Click any result to highlight both elements; expand a row to step through each object.</p>
          </div>
        )}

        {result && total === 0 && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <p className="text-sm">No clashes found for this rule set. 🎉</p>
          </div>
        )}

        {result && total > 0 && shown === 0 && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <p className="text-sm">All {total} results are ≈0 m touching contacts. Untick “Hide touching” to see them.</p>
          </div>
        )}

        {sections.map((section) => {
          const isCollapsed = collapsed.has(section.key);
          return (
            <div key={section.key} className="border-b border-border/60">
              <button
                onClick={() => toggleSection(section.key)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {section.color && (
                  <span className="h-2 w-2 rounded-full" style={{ background: section.color }} />
                )}
                <span className="truncate">{section.label}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{section.items.length}</span>
              </button>
              {!isCollapsed &&
                section.items.map((clash) => {
                  const isExpanded = expanded.has(clash.id);
                  const touch = isTouching(clash);
                  return (
                    <div
                      key={clash.id}
                      className={cn('border-t border-border/40', selectedId === clash.id && 'bg-primary/10')}
                    >
                      <div className="flex w-full items-stretch text-xs">
                        <button
                          onClick={() => toggleExpand(clash.id)}
                          title={isExpanded ? 'Collapse' : 'Show both objects'}
                          className="flex items-center pl-2 pr-1 text-muted-foreground hover:text-foreground"
                        >
                          {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          onClick={() => focusClash(clash, isolateOnSelect)}
                          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left hover:bg-muted/50"
                        >
                          <span
                            className="self-stretch w-0.5 rounded-full shrink-0"
                            style={{ background: SEVERITY[clash.severity].color }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate">
                              <span className="text-foreground">{clash.a.tag}</span>
                              <span className="text-muted-foreground"> × </span>
                              <span className="text-foreground">{clash.b.tag}</span>
                              {touch && (
                                <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                                  touch
                                </span>
                              )}
                            </div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              {clash.a.name ?? shortName(clash.a.key)} ↔ {clash.b.name ?? shortName(clash.b.key)}
                            </div>
                          </div>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{formatDistance(clash.distance)}</span>
                        </button>
                        <button
                          onClick={() => focusClash(clash, true)}
                          title="Isolate this pair (hide everything else)"
                          className="flex items-center px-2 text-muted-foreground hover:text-foreground"
                        >
                          <Focus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="pb-1.5">
                          <div className="px-7 py-1 text-[10px] text-muted-foreground">{describeClash(clash)}</div>
                          <ElementRow el={clash.a} side={0} />
                          <ElementRow el={clash.b} side={1} />
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}
