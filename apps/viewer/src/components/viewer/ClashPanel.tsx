/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import {
  X,
  Play,
  Loader2,
  Trash2,
  Crosshair,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useClash } from '@/hooks/useClash';
import { ClashBcfExportDialog } from '@/components/viewer/ClashBcfExportDialog';
import { ClashSettingsDialog } from '@/components/viewer/ClashSettingsDialog';
import type { Clash, ClashSeverity } from '@ifc-lite/clash';

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

function shortName(key: string): string {
  return key.length > 10 ? `${key.slice(0, 8)}…` : key;
}

export function ClashPanel({ onClose }: ClashPanelProps) {
  const {
    result,
    running,
    error,
    mode,
    tolerance,
    clearance,
    groupBy,
    selectedId,
    presets,
    setMode,
    setTolerance,
    setClearance,
    setGroupBy,
    runAll,
    runMatrix,
    runPreset,
    focusClash,
    highlightAll,
    clearHighlight,
    clearAll,
  } = useClash();

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Group the flat clash list for display along the selected dimension.
  const sections = useMemo(() => {
    if (!result) return [] as Array<{ key: string; label: string; color?: string; items: Clash[] }>;
    const buckets = new Map<string, Clash[]>();
    for (const c of result.clashes) {
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
    // that actually ran — discipline presets, custom presets, and the synthetic
    // "all-clashes" — so no hardcoding or preset lookup is needed.
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
  }, [result, groupBy]);

  const total = result?.summary.total ?? 0;
  const bySeverity = result?.summary.bySeverity;

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <Crosshair className="h-4 w-4 text-[#f7768e]" />
        <span className="text-sm font-semibold tracking-tight">Clash detection</span>
        <div className="ml-auto flex items-center gap-1">
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

      {/* Run controls */}
      <div className="p-3 space-y-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
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
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
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
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
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
        <Button
          variant="outline"
          className="w-full h-7 text-xs"
          disabled={running}
          onClick={() => void runMatrix()}
        >
          <Play className="h-3.5 w-3.5 mr-1.5" />
          Run discipline matrix
        </Button>

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
            <span className="text-xs text-muted-foreground">{total === 1 ? 'clash' : 'clashes'}</span>
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

      {/* Toolbar: group-by + actions */}
      {result && total > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
            className="rounded border border-border bg-transparent px-1.5 py-0.5"
          >
            <option value="severity">By severity</option>
            <option value="rule">By rule</option>
            <option value="typePair">By type pair</option>
          </select>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={highlightAll}>
              Highlight
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clearHighlight}>
              Clear
            </Button>
            <ClashBcfExportDialog />
          </div>
        </div>
      )}

      {/* Results */}
      <ScrollArea className="flex-1">
        {!result && !running && (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center text-muted-foreground">
            <Crosshair className="h-8 w-8 mb-3 opacity-40" />
            <p className="text-sm">Detect all clashes, run the discipline matrix, or pick a preset to find conflicts in the loaded models. Click any result to highlight both elements and frame the camera on it.</p>
          </div>
        )}

        {result && total === 0 && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <p className="text-sm">No clashes found for this rule set. 🎉</p>
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
                section.items.map((clash) => (
                  <button
                    key={clash.id}
                    onClick={() => focusClash(clash)}
                    className={cn(
                      'flex w-full items-center gap-2 py-1.5 pr-3 pl-2 text-left text-xs hover:bg-muted/50',
                      selectedId === clash.id && 'bg-primary/10',
                    )}
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
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {clash.a.name ?? shortName(clash.a.key)} ↔ {clash.b.name ?? shortName(clash.b.key)}
                      </div>
                    </div>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {clash.distance < 0
                        ? `−${Math.abs(clash.distance).toFixed(3)}m`
                        : `${clash.distance.toFixed(3)}m`}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}
