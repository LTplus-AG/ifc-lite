/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Export to BCF" dialog for clash results.
 *
 * The headline requirement (see docs/architecture/clash-detection-plan.md §6) is
 * a *manageable* BCF: 1,000 clashes must never become 1,000 topics. This dialog
 * puts that control in the user's hands — choose how clashes collapse into
 * topics, filter by severity, cap the count, pick the initial status, and
 * optionally embed a rendered snapshot per topic — with a live readout of
 * exactly how many topics the current settings will produce *before* exporting.
 */

import { useCallback, useMemo, useState } from 'react';
import { Download, Crosshair, Loader2, ArrowRight, Camera, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useClash, type ClashBcfConfig, type ClashBcfGroupBy } from '@/hooks/useClash';
import type { ClashSeverity } from '@ifc-lite/clash';

interface ClashBcfExportDialogProps {
  trigger?: React.ReactNode;
}

const SEVERITIES: { key: ClashSeverity; label: string; color: string }[] = [
  { key: 'critical', label: 'Critical', color: '#f7768e' },
  { key: 'major', label: 'Major', color: '#ff9e64' },
  { key: 'minor', label: 'Minor', color: '#e0af68' },
  { key: 'info', label: 'Info', color: '#7aa2f7' },
];

const GROUPINGS: { key: ClashBcfGroupBy; label: string; hint: string }[] = [
  { key: 'cluster', label: 'Spatial cluster', hint: 'Nearby clashes of the same kind merge into one topic — the sensible default.' },
  { key: 'rule', label: 'Discipline rule', hint: 'One topic per rule (MEP × Structure, HVAC × Architecture, …).' },
  { key: 'typePair', label: 'Element-type pair', hint: 'One topic per type pair (IfcDuct × IfcWall, …).' },
  { key: 'element', label: 'Affected element', hint: "One topic per element — all of an element's clashes in one place." },
];

const STATUSES = ['Open', 'In Progress', 'Closed'] as const;

const DEFAULT_CONFIG: ClashBcfConfig = {
  groupBy: 'cluster',
  severities: ['critical', 'major', 'minor', 'info'],
  includeSnapshots: false,
  status: 'Open',
  maxTopics: 500,
};

export function ClashBcfExportDialog({ trigger }: ClashBcfExportDialogProps) {
  const { result, exportBcf, bcfPreview } = useClash();

  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<ClashBcfConfig>(DEFAULT_CONFIG);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const bySeverity = result?.summary.bySeverity;
  const preview = useMemo(() => bcfPreview(config), [bcfPreview, config, result]);

  const toggleSeverity = useCallback((sev: ClashSeverity) => {
    setConfig((prev) => {
      const has = prev.severities.includes(sev);
      const severities = has ? prev.severities.filter((s) => s !== sev) : [...prev.severities, sev];
      return { ...prev, severities };
    });
  }, []);

  const grouping = GROUPINGS.find((g) => g.key === config.groupBy) ?? GROUPINGS[0];
  const canExport = preview.topics > 0 && !exporting;

  const handleExport = useCallback(async () => {
    setExporting(true);
    setProgress(config.includeSnapshots ? { done: 0, total: preview.topics } : null);
    try {
      await exportBcf(config, (done, total) => setProgress({ done, total }));
      toast.success(`Exported ${preview.topics} BCF topic${preview.topics === 1 ? '' : 's'}`);
      setOpen(false);
    } catch (err) {
      console.error('[clash] BCF export failed', err);
      toast.error(`BCF export failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }, [config, exportBcf, preview.topics]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Don't let Esc / backdrop close the dialog mid-export: the snapshot loop
        // is driving the live renderer (camera + isolation), and there's no UI to
        // resume into if the dialog vanishes. Mirrors the IDS export dialog.
        if (exporting) return;
        setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
            <Download className="h-3.5 w-3.5 mr-1" />
            BCF
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[460px] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-[#f7768e]" />
            Export to BCF
          </DialogTitle>
          <DialogDescription>
            Turn clashes into a manageable set of BCF topics. Control how they group,
            which to include, and whether to embed snapshots.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1 max-h-[62vh] overflow-y-auto pr-1">
          {/* Grouping */}
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <Layers className="h-3 w-3" /> Group into topics by
            </Label>
            <Select
              value={config.groupBy}
              onValueChange={(v) => setConfig((p) => ({ ...p, groupBy: v as ClashBcfGroupBy }))}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPINGS.map((g) => (
                  <SelectItem key={g.key} value={g.key}>{g.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground leading-snug">{grouping.hint}</p>
          </div>

          {/* Severity filter */}
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Include severities
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {SEVERITIES.map((s) => {
                const on = config.severities.includes(s.key);
                const count = bySeverity?.[s.key] ?? 0;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => toggleSeverity(s.key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                      on ? 'border-transparent text-foreground' : 'border-border text-muted-foreground opacity-60 hover:opacity-100',
                    )}
                    style={on ? { background: `${s.color}1f`, borderColor: `${s.color}66` } : undefined}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.label}
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live preview — the hero readout */}
          <div className="flex items-center justify-center gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="text-center">
              <div className="text-2xl font-semibold tabular-nums leading-none">{preview.clashes}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">clashes</div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="text-center">
              <div className="text-2xl font-semibold tabular-nums leading-none text-[#f7768e]">{preview.topics}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                topic{preview.topics === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          {/* Status + cap, side by side */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Initial status</Label>
              <Select value={config.status} onValueChange={(v) => setConfig((p) => ({ ...p, status: v }))}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Max topics</Label>
              <input
                type="number"
                min={1}
                step={50}
                value={config.maxTopics}
                onChange={(e) => setConfig((p) => ({ ...p, maxTopics: Math.max(1, Number(e.target.value) || 1) }))}
                className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm tabular-nums"
              />
            </div>
          </div>

          {/* Snapshots */}
          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <Label className="flex items-center gap-1.5 text-sm">
                <Camera className="h-3.5 w-3.5" /> Include snapshots
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground leading-snug">
                Render each topic's viewpoint and embed a PNG. Slower for many topics.
              </p>
            </div>
            <Switch
              checked={config.includeSnapshots}
              onCheckedChange={(v) => setConfig((p) => ({ ...p, includeSnapshots: v }))}
            />
          </div>
        </div>

        <DialogFooter className="items-center">
          {progress && (
            <span className="mr-auto text-xs text-muted-foreground tabular-nums">
              Capturing snapshots {progress.done}/{progress.total}…
            </span>
          )}
          <Button variant="outline" onClick={() => setOpen(false)} disabled={exporting}>
            Cancel
          </Button>
          <Button onClick={() => void handleExport()} disabled={!canExport}>
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-1.5" />
            )}
            {exporting ? 'Exporting…' : `Export ${preview.topics} topic${preview.topics === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
