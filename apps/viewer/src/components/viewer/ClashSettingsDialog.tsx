/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash settings dialog — opened from the gear in the clash panel header.
 *
 * Two tabs:
 *  - Detection: the global knobs (mode, tolerance, clearance, cluster radius,
 *    report-touch, default grouping), each persisted on change.
 *  - Rules: the discipline-matrix preset set. Toggle / edit / reset the built-ins
 *    and add your own custom rules (type-selector A × B + severity), with a live
 *    "matches N classes" preview against the loaded model. Persisted to
 *    localStorage; shareable via export / import.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Settings2, Plus, Pencil, Trash2, RotateCcw, Upload, Download, Check, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { matchesSelector, type ClashSeverity } from '@ifc-lite/clash';
import { exportPresets, importPresets, type ClashPreset } from '@/lib/clash/persistence';

const SEVERITY: Record<ClashSeverity, { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#f7768e' },
  major: { label: 'Major', color: '#ff9e64' },
  minor: { label: 'Minor', color: '#e0af68' },
  info: { label: 'Info', color: '#7aa2f7' },
};
const SEVERITIES: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];

interface Draft {
  id: string | null; // null = new custom rule
  name: string;
  selectorA: string;
  selectorB: string;
  severity: ClashSeverity;
}

interface ClashSettingsDialogProps {
  trigger?: React.ReactNode;
}

export function ClashSettingsDialog({ trigger }: ClashSettingsDialogProps) {
  const mode = useViewerStore((s) => s.clashMode);
  const tolerance = useViewerStore((s) => s.clashTolerance);
  const clearance = useViewerStore((s) => s.clashClearance);
  const clusterEpsilon = useViewerStore((s) => s.clashClusterEpsilon);
  const reportTouch = useViewerStore((s) => s.clashReportTouch);
  const groupBy = useViewerStore((s) => s.clashGroupBy);
  const presets = useViewerStore((s) => s.clashPresets);
  const classes = useViewerStore((s) => s.discoveredLensData?.classes ?? null);

  const setMode = useViewerStore((s) => s.setClashMode);
  const setTolerance = useViewerStore((s) => s.setClashTolerance);
  const setClearance = useViewerStore((s) => s.setClashClearance);
  const setClusterEpsilon = useViewerStore((s) => s.setClashClusterEpsilon);
  const setReportTouch = useViewerStore((s) => s.setClashReportTouch);
  const setGroupBy = useViewerStore((s) => s.setClashGroupBy);
  const resetSettings = useViewerStore((s) => s.resetClashSettings);
  const createPreset = useViewerStore((s) => s.createClashPreset);
  const updatePreset = useViewerStore((s) => s.updateClashPreset);
  const deletePreset = useViewerStore((s) => s.deleteClashPreset);
  const setPresetEnabled = useViewerStore((s) => s.setClashPresetEnabled);
  const resetPresets = useViewerStore((s) => s.resetClashPresets);
  const importClashPresets = useViewerStore((s) => s.importClashPresets);

  const [draft, setDraft] = useState<Draft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const matchCount = useCallback(
    (selector: string): number | null => {
      if (!classes) return null;
      const s = selector.trim();
      if (!s) return null;
      return classes.filter((c) => matchesSelector(c, s)).length;
    },
    [classes],
  );

  const startAdd = () =>
    setDraft({ id: null, name: '', selectorA: '', selectorB: '', severity: 'major' });
  const startEdit = (p: ClashPreset) =>
    setDraft({ id: p.id, name: p.name, selectorA: p.selectorA, selectorB: p.selectorB, severity: p.severity });

  const saveDraft = useCallback(() => {
    if (!draft) return;
    const result = draft.id
      ? updatePreset(draft.id, {
          name: draft.name,
          selectorA: draft.selectorA,
          selectorB: draft.selectorB,
          severity: draft.severity,
        })
      : createPreset({
          name: draft.name,
          severity: draft.severity,
          selectorA: draft.selectorA,
          selectorB: draft.selectorB,
        });
    if (result.ok) {
      setDraft(null);
    } else {
      toast.error(result.message);
    }
  }, [draft, createPreset, updatePreset]);

  const draftValid =
    !!draft && draft.name.trim().length > 0 && draft.selectorA.trim().length > 0 && draft.selectorB.trim().length > 0;

  const onImport = useCallback(
    async (file: File) => {
      try {
        const imported = await importPresets(file);
        if (imported.length === 0) {
          toast.error('No valid rules found in that file.');
          return;
        }
        const result = importClashPresets(imported);
        if (result.ok) toast.success(`Imported ${imported.length} rule${imported.length === 1 ? '' : 's'}`);
        else toast.error(result.message);
      } catch {
        toast.error('Could not read that file as clash rules.');
      }
    },
    [importClashPresets],
  );

  const enabledCount = useMemo(() => presets.filter((p) => p.enabled).length, [presets]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Clash settings">
            <Settings2 className="h-4 w-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[540px] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-[#f7768e]" />
            Clash settings
          </DialogTitle>
          <DialogDescription>
            Tune detection and curate the rule set. {enabledCount} of {presets.length} rules enabled.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="detection" className="mt-1">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="detection">Detection</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
          </TabsList>

          {/* ---- Detection ---------------------------------------------------- */}
          <TabsContent value="detection" className="space-y-3 max-h-[58vh] overflow-y-auto pr-1">
            <SettingRow label="Default mode" hint="Hard finds interpenetrations; clearance finds gaps smaller than the required distance.">
              <Select value={mode} onValueChange={(v) => setMode(v as 'hard' | 'clearance')}>
                <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hard">Hard</SelectItem>
                  <SelectItem value="clearance">Clearance</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label="Tolerance" hint="Touching band (m). Surfaces within this distance count as contact, not penetration.">
              <NumberField value={tolerance} step={0.001} min={0} onCommit={setTolerance} suffix="m" />
            </SettingRow>

            <SettingRow label="Clearance gap" hint="Required gap (m) in clearance mode. Anything closer than this is a violation.">
              <NumberField value={clearance} step={0.01} min={0} onCommit={setClearance} suffix="m" />
            </SettingRow>

            <SettingRow label="Cluster radius" hint="How far apart clashes can be and still merge into one BCF topic (m).">
              <NumberField value={clusterEpsilon} step={0.1} min={0.01} onCommit={setClusterEpsilon} suffix="m" />
            </SettingRow>

            <SettingRow label="Report grazing contacts" hint="Include touch-classified results (surfaces that just graze) in detection.">
              <Switch checked={reportTouch} onCheckedChange={setReportTouch} />
            </SettingRow>

            <SettingRow label="Default grouping" hint="How the results list is organized in the panel.">
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as typeof groupBy)}>
                <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="severity">By severity</SelectItem>
                  <SelectItem value="rule">By rule</SelectItem>
                  <SelectItem value="typePair">By type pair</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <div className="pt-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={resetSettings}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Reset detection settings
              </Button>
            </div>
          </TabsContent>

          {/* ---- Rules -------------------------------------------------------- */}
          <TabsContent value="rules" className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Button size="sm" className="h-7 px-2 text-xs" onClick={startAdd} disabled={!!draft}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add rule
              </Button>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Reset to the built-in rules" onClick={resetPresets}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Export rules" onClick={() => exportPresets(presets)}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Import rules" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,.clash-presets.json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onImport(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>

            <ScrollArea className="max-h-[42vh] pr-1">
              <div className="space-y-1">
                {presets.map((p) => (
                  <div
                    key={p.id}
                    className={cn(
                      'flex items-center gap-2 rounded-md border border-border px-2 py-1.5',
                      !p.enabled && 'opacity-55',
                    )}
                  >
                    <Switch checked={p.enabled} onCheckedChange={(v) => setPresetEnabled(p.id, v)} />
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY[p.severity].color }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">
                        {p.name}
                        {!p.builtin && <span className="ml-1.5 text-[10px] text-muted-foreground">custom</span>}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {p.selectorA} <span className="opacity-60">×</span> {p.selectorB}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="h-6 w-6" title="Edit" onClick={() => startEdit(p)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    {p.builtin ? (
                      <span className="w-6" />
                    ) : (
                      <Button variant="ghost" size="icon" className="h-6 w-6" title="Delete" onClick={() => deletePreset(p.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>

            {draft && (
              <div className="rounded-md border border-[#f7768e]/40 bg-muted/30 p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{draft.id ? 'Edit rule' : 'New rule'}</span>
                  <button onClick={() => setDraft(null)} className="text-muted-foreground hover:text-foreground" title="Cancel">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Rule name (e.g. Ducts vs Beams)"
                  className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm"
                />
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <SelectorField
                    value={draft.selectorA}
                    onChange={(v) => setDraft({ ...draft, selectorA: v })}
                    count={matchCount(draft.selectorA)}
                    hasModel={classes !== null}
                    placeholder="IfcDuct*|IfcPipe*"
                  />
                  <span className="text-xs text-muted-foreground">×</span>
                  <SelectorField
                    value={draft.selectorB}
                    onChange={(v) => setDraft({ ...draft, selectorB: v })}
                    count={matchCount(draft.selectorB)}
                    hasModel={classes !== null}
                    placeholder="IfcWall*|IfcSlab"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Select value={draft.severity} onValueChange={(v) => setDraft({ ...draft, severity: v as ClashSeverity })}>
                    <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SEVERITIES.map((s) => (
                        <SelectItem key={s} value={s}>{SEVERITY[s].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="ml-auto h-8" disabled={!draftValid} onClick={saveDraft}>
                    <Check className="h-3.5 w-3.5 mr-1" /> {draft.id ? 'Save' : 'Add'}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Selectors: <code>IfcWall</code>, <code>IfcPipe*</code>, <code>IfcWall|IfcSlab</code>, <code>!IfcSpace</code>, <code>*</code>.
                  Leave B equal to A for a self-clash within one group.
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
      <div className="min-w-0">
        <Label className="text-sm">{label}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Numeric input that commits on change, clamped by the store setter. */
function NumberField({
  value, step, min, suffix, onCommit,
}: { value: number; step: number; min: number; suffix?: string; onCommit: (v: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1">
      <input
        type="number"
        step={step}
        min={min}
        value={value}
        onChange={(e) => onCommit(Number(e.target.value))}
        className="h-8 w-24 rounded-md border border-border bg-transparent px-2 text-sm tabular-nums text-right"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** Type-selector input with a live "matches N classes" hint. */
function SelectorField({
  value, onChange, count, hasModel, placeholder,
}: { value: string; onChange: (v: string) => void; count: number | null; hasModel: boolean; placeholder: string }) {
  return (
    <div className="min-w-0">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-xs font-mono"
      />
      <div className="mt-0.5 h-3 text-[10px] text-muted-foreground truncate">
        {!hasModel
          ? 'load a model to preview'
          : count === null
            ? ' '
            : count > 0
              ? `✓ matches ${count} class${count === 1 ? '' : 'es'}`
              : 'matches no classes'}
      </div>
    </div>
  );
}
