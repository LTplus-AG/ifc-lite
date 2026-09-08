/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Export anonymized subset" dialog (#2934, "object isolator / obfuscator"):
 * pick a seed selection, expand it by relationship context, preview exactly
 * that subset isolated in 3D, then export it as a STEP file with every
 * project-identifying signal removed. See the plan doc and
 * `packages/export/src/anonymize-export.ts` for the export mechanics this
 * dialog is a thin, reviewable front end for.
 *
 * Reachable three ways (pattern: `ExportDialog.tsx`, `GLBExportDialog.tsx`):
 * the export toolbar dropdown (`trigger` prop, registered in
 * `toolbar/export-commands.ts`), the entity context menu, and the Command
 * Palette. Only ONE of the two mounted instances may answer to the store
 * flag, or both open together (#3309 review): the context menu and Command
 * Palette set `anonymizedExportRequested`, and this component is ALSO
 * mounted trigger-less in `ViewerLayout.tsx`'s "Global Overlays" block (the
 * same host `FlavorDialog` uses) specifically to own that flag, so the
 * triggered instance ignores it — see the `trigger` prop doc below.
 */

import { useCallback, useState } from 'react';
import { EyeOff, Download, AlertCircle, Check, Loader2 } from 'lucide-react';
import type { AnonymizeResult, RelatedEntityOptions } from '@ifc-lite/export';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { ensureModelExportReady } from '@/services/desktop-export';
import { useAnonymizedExportSet } from './useAnonymizedExportSet';
import { usePreviewIsolation } from './usePreviewIsolation';
import { RelationTogglePanel } from './RelationTogglePanel';
import { RelatedEntityList } from './RelatedEntityList';
import { TypeCategoryBar } from './TypeCategoryBar';
import { runAnonymizedExport } from './anonymized-export-run';
import {
  AnonymizationOptionsPanel,
  coupleTogglesToRelations,
  coupleRelationsToToggles,
  DEFAULT_ANONYMIZE_TOGGLES,
  toAnonymizeOptions,
  type AnonymizeToggles,
} from './AnonymizationOptionsPanel';

/** Neutral default download stem; deliberately unrelated to the model's name. */
const DEFAULT_FILE_STEM = 'anonymized';

interface AnonymizedExportDialogProps {
  /**
   * Omit when mounting this as the trigger-less, always-open-able host (see
   * `ViewerLayout.tsx`'s "Global Overlays" — the context menu and Command
   * Palette entry points only flip `anonymizedExportRequested`, never render
   * a clickable element). Pass an element when registering this as an
   * `ExportDialogCommand` (`toolbar/export-commands.ts`).
   */
  trigger?: React.ReactNode;
}

export function AnonymizedExportDialog({ trigger }: AnonymizedExportDialogProps) {
  const [localOpen, setLocalOpen] = useState(false);
  // Only the trigger-less host instance (ViewerLayout's "Global Overlays")
  // responds to the store flag; a triggered instance (the export dropdown)
  // owns its own open state exclusively, otherwise both instances would open
  // together whenever the context menu or Command Palette sets the flag —
  // see the module docblock and the `trigger` prop doc above.
  const isHost = trigger === undefined;
  const anonymizedExportRequested = useViewerStore((s) => s.anonymizedExportRequested);
  const setAnonymizedExportRequested = useViewerStore((s) => s.setAnonymizedExportRequested);
  const open = localOpen || (isHost && anonymizedExportRequested);

  const handleOpenChange = useCallback((next: boolean) => {
    setLocalOpen(next);
    if (!next && isHost) setAnonymizedExportRequested(false);
  }, [isHost, setAnonymizedExportRequested]);

  const set = useAnonymizedExportSet(open);

  // Anonymization toggles share ONE polarity (ON = anonymize, OFF = keep);
  // `toAnonymizeOptions` maps them onto the core's mixed flags.
  const [toggles, setToggles] = useState<AnonymizeToggles>({ ...DEFAULT_ANONYMIZE_TOGGLES });
  // Asked for explicitly — never derived from the model name (that would
  // leak the project in the filename of an otherwise anonymized file).
  const [fileStem, setFileStem] = useState(DEFAULT_FILE_STEM);

  const [previewEnabled, setPreviewEnabled] = useState(true);
  usePreviewIsolation({
    enabled: open && previewEnabled && set.includedIds.size > 0,
    targetModelId: set.targetModelId,
    includedIds: set.includedIds,
  });

  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);
  const [lastResult, setLastResult] = useState<AnonymizeResult | null>(null);

  // ONE DECISION, TWO CONTROLS (#3351). "Property sets -> Anonymize" only ever
  // cleared `HasPropertySets` on type classes, so a pset pulled in by the
  // `IfcRelDefinesByProperties` walk survived with its values while the label
  // said it was dropped. The CLI has never had this bug because `--keep-psets`
  // drives BOTH the walk and `keepPropertySets` from one flag; these two
  // handlers give the dialog the same invariant, in both directions, so the
  // state where the walk is on and psets are "anonymized" cannot be reached.
  const handleTogglesChange = useCallback(
    (next: AnonymizeToggles) => {
      const { toggles: coupled, turnRelationOff } = coupleTogglesToRelations(
        next,
        set.options.IfcRelDefinesByProperties ?? false,
      );
      if (turnRelationOff) set.setOption({ IfcRelDefinesByProperties: false });
      setToggles(coupled);
    },
    [set],
  );

  const handleRelationChange = useCallback(
    (patch: Partial<RelatedEntityOptions>) => {
      // Asking for source psets IS asking to keep them.
      setToggles((t) => coupleRelationsToToggles(t, patch.IfcRelDefinesByProperties === true));
      set.setOption(patch);
    },
    [set],
  );

  const handleExport = useCallback(async () => {
    if (!set.targetModelId || set.includedIds.size === 0) return;
    setIsExporting(true);
    setExportResult(null);
    try {
      const dataStore = await ensureModelExportReady(set.targetModelId);
      if (!dataStore) throw new Error('Model data is unavailable for export');
      const result = runAnonymizedExport({
        store: dataStore,
        fileStem,
        includedIds: set.includedIds,
        options: toAnonymizeOptions(toggles),
      });
      setLastResult(result);
      const warningCount = result.stats.warnings.length;
      const msg = `Exported ${result.stats.entityCount} entities`
        + (warningCount > 0 ? ` (${warningCount} warning${warningCount === 1 ? '' : 's'})` : '');
      setExportResult({ success: true, message: msg });
      toast.success(msg);

      const relationToggles = [
        set.options.IfcRelVoidsElement ?? true ? 'voids' : null,
        set.options.IfcRelFillsElement ?? true ? 'fills' : null,
        (set.options.IfcRelAggregates ?? 'both') !== 'none' ? 'aggregates' : null,
        set.options.IfcRelDefinesByType ?? true ? 'type' : null,
        set.options.IfcRelAssociatesMaterial ?? true ? 'material' : null,
        set.options.IfcRelDefinesByProperties ?? false ? 'psets' : null,
        (set.options.IfcRelConnectsPathElementsDepth ?? 0) > 0 ? 'connected' : null,
      ].filter((v): v is string => v !== null);
      posthog.capture('export_completed', {
        format: 'ifc-anonymized',
        seed_count: set.seeds.length,
        included_count: set.includedIds.size,
        relation_toggles: relationToggles,
        anonymize_property_sets: toggles.propertySets,
        anonymize_names: toggles.names,
        anonymize_other_names: toggles.otherNames,
        anonymize_guids: toggles.globalIds,
        anonymize_root_placement_position: toggles.rootPlacementPosition,
        anonymize_georeferencing: toggles.georeferencing,
        anonymize_currency: toggles.currency,
      });
    } catch (error) {
      const msg = `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      setExportResult({ success: false, message: msg });
      toast.error(msg);
    } finally {
      setIsExporting(false);
    }
  }, [set, toggles, fileStem]);

  return (
    // Non-modal on purpose: the right ~60% of the 99vw content is a
    // transparent, click-through pane so the REAL viewport underneath acts as
    // the 3D preview (isolation + highlight via `usePreviewIsolation`) and
    // stays orbit-able while the dialog is open. Interacting with the
    // viewport must therefore not count as "click outside" (Radix's non-modal
    // default would close the dialog); Escape and the buttons still close it.
    <Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
      {/* No fallback trigger: the trigger-less ViewerLayout host must render
          nothing visible of its own — see the props doc above. */}
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        hideCloseButton
        onInteractOutside={(e) => e.preventDefault()}
        className="left-[0.5vw] top-[4vh] translate-x-0 translate-y-0 w-[99vw] max-w-none h-[92vh] p-0 gap-0 border-0 bg-transparent shadow-none grid grid-cols-[minmax(420px,40%)_1fr] gap-x-4 pointer-events-none data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-top-0"
      >
        {/* Left: controls (opaque, interactive). */}
        <div className="pointer-events-auto flex flex-col min-h-0 rounded-lg border bg-background shadow-lg">
          <DialogHeader className="px-5 pt-4 pb-2">
            <DialogTitle className="flex items-center gap-2">
              <EyeOff className="h-5 w-5" />
              Export Anonymized Subset
            </DialogTitle>
            <DialogDescription>
              Objects highlighted in the 3D view on the right are what gets exported —
              every project-identifying signal removed, local transformations kept.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 px-5 py-2 flex-1 min-h-0 overflow-y-auto">
            {set.otherModelSeedCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {set.otherModelSeedCount} selected object{set.otherModelSeedCount === 1 ? '' : 's'} in other models not included
              </p>
            )}
            {set.droppedOverlaySeedCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {set.droppedOverlaySeedCount} selected object{set.droppedOverlaySeedCount === 1 ? '' : 's'} created in this
                session {set.droppedOverlaySeedCount === 1 ? 'has' : 'have'} no source record and cannot be included
              </p>
            )}
            {!set.hasSelection && (
              <p className="text-sm text-muted-foreground">
                Select one or more objects in the 3D view, then reopen this dialog.
              </p>
            )}

            {set.hasSelection && (
              <>
                <RelationTogglePanel options={set.options} onChange={handleRelationChange} related={set.related} />

                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">
                    Result: {set.includedIds.size} entit{set.includedIds.size === 1 ? 'y' : 'ies'}
                    {set.related?.truncated && (
                      <Badge variant="destructive" className="ml-2 align-middle">Truncated</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Preview in 3D</Label>
                    <Switch checked={previewEnabled} onCheckedChange={setPreviewEnabled} />
                  </div>
                </div>

                <TypeCategoryBar categories={set.typeCategories} onToggle={set.setTypeExcluded} />

                <RelatedEntityList
                  dataStore={set.targetModel?.ifcDataStore ?? null}
                  seeds={set.seeds}
                  related={set.related}
                  excludedIds={set.excludedIds}
                  lockedIds={set.lockedIds}
                  onSetExcluded={set.setExcluded}
                />

                <AnonymizationOptionsPanel toggles={toggles} onTogglesChange={handleTogglesChange} disabled={isExporting} />
              </>
            )}

            {isExporting && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Exporting…
              </div>
            )}

            {exportResult && (
              <Alert variant={exportResult.success ? 'default' : 'destructive'}>
                {exportResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                <AlertTitle>{exportResult.success ? 'Success' : 'Error'}</AlertTitle>
                <AlertDescription>{exportResult.message}</AlertDescription>
              </Alert>
            )}

            {lastResult && lastResult.stats.warnings.length > 0 && (
              <details className="text-xs text-muted-foreground border rounded p-2">
                <summary className="cursor-pointer select-none">
                  {lastResult.stats.warnings.length} warning{lastResult.stats.warnings.length === 1 ? '' : 's'}
                </summary>
                <ul className="list-disc pl-4 mt-1 space-y-0.5">
                  {lastResult.stats.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <DialogFooter className="px-5 pb-4 pt-3 border-t sm:items-center gap-2">
            <div className="flex items-center gap-2 flex-1 sm:mr-auto">
              <Label htmlFor="anon-file-stem" className="text-sm shrink-0">File name</Label>
              <Input
                id="anon-file-stem"
                value={fileStem}
                disabled={isExporting}
                onChange={(e) => setFileStem(e.target.value)}
                placeholder={DEFAULT_FILE_STEM}
                className="h-8"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="text-sm text-muted-foreground">.ifc</span>
            </div>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleExport()} disabled={isExporting || !set.hasSelection || set.includedIds.size === 0}>
              {isExporting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Export .ifc
                </>
              )}
            </Button>
          </DialogFooter>
        </div>

        {/* Right: click-through pane over the live viewport. */}
        <div className="relative pointer-events-none min-h-0">
          {set.hasSelection && (
            <div className="absolute top-2 left-2 rounded-md border bg-background/80 backdrop-blur px-2 py-1 text-xs text-muted-foreground">
              3D preview — {set.includedIds.size} highlighted object{set.includedIds.size === 1 ? '' : 's'} will be exported
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
