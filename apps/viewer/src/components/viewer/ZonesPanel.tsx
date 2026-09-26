/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ZonesPanel — author + manage location zones (issue #1810 v1).
 *
 * Zone sets are independent named collections of oriented boxes ("Sections",
 * "Takt areas", ...). Per zone set: toggle 3D visibility, add/remove zones,
 * edit a zone numerically or via the 3D gizmo (`ZoneOverlay`, entered via
 * "Edit in 3D"), generate a whole set from the loaded model's storeys, jump
 * the 3D selection to everything in a zone, and export/import the set as a
 * small JSON file (the only persistence beyond the localStorage auto-save
 * `zonesSlice` already does).
 */

import { trackExportCompleted } from '@/lib/analytics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Layers3,
  Download,
  Upload,
  MousePointerClick,
  Pencil,
  Scissors,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { generateZonesFromStoreys } from '@/hooks/useZoneStoreyGeneration';
import { selectElementsInZone } from '@/hooks/useZoneSelection';
import { useZoneGeometrySplit } from '@/hooks/useZoneGeometrySplit';
import type { Zone } from '@/lib/zones';
import { ZoneApportionSummary } from './ZoneApportionSummary';
import { ZoneWriteBackControl } from './ZoneWriteBackControl';

interface ZonesPanelProps {
  onClose?: () => void;
}

const DEG = 180 / Math.PI;

function toDeg(rad: number): number {
  return Math.round((rad * DEG) % 360 * 10) / 10;
}

function fromDeg(deg: number): number {
  return (Number(deg) || 0) / DEG;
}

/** Numeric input that commits on blur/Enter rather than every keystroke, so
 *  typing "-1.5" doesn't briefly parse "-1" mid-edit and fight the drag
 *  handles for the same field. Resyncs its draft from `value` whenever the
 *  field ISN'T focused, so a live 3D-gizmo drag (which updates `value` every
 *  frame) is visible in the panel instead of only after a refocus. */
function NumberField({
  value, onCommit, className, title,
}: { value: number; onCommit: (v: number) => void; className?: string; title?: string }) {
  const round = (v: number) => String(Math.round(v * 1000) / 1000);
  const [draft, setDraft] = useState(round(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const lastValueRef = useRef(value);
  if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    if (typeof document === 'undefined' || document.activeElement !== inputRef.current) {
      // Safe to update synchronously during render: this only fires when an
      // EXTERNAL value change (gizmo drag / another user in future collab)
      // arrives while unfocused, not in response to this component's own state.
      if (draft !== round(value)) setDraft(round(value));
    }
  }
  return (
    <Input
      ref={inputRef}
      value={draft}
      title={title}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(round(value))}
      onBlur={() => {
        const n = Number(draft);
        if (Number.isFinite(n)) onCommit(n);
        else setDraft(round(value));
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={className ?? 'h-6 w-16 px-1 text-2xs'}
    />
  );
}

function ZoneRow({
  zone, editing, exporting, exportProgress, onEdit, onUpdate, onRemove, onSelect, onExportGeometry,
}: {
  zone: Zone;
  editing: boolean;
  /** A geometry export for THIS zone is running: the control is disabled and
   *  says so, because the cut takes hundreds of milliseconds per element. */
  exporting: boolean;
  /** Elements cut so far, while `exporting`. Worth rendering only because the
   *  cutting moved to a worker: on the main thread nothing could repaint
   *  between the first element and the last. */
  exportProgress?: { done: number; total: number } | null;
  onEdit: () => void;
  onUpdate: (patch: Partial<Omit<Zone, 'id'>>) => void;
  onRemove: () => void;
  onSelect: () => void;
  onExportGeometry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`rounded-md border p-2 text-xs space-y-1.5 ${editing ? 'border-amber-500 bg-amber-500/5' : 'border-border/60'}`}>
      <div className="flex items-center gap-1.5">
        <Input
          value={zone.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="h-6 flex-1 px-1.5 text-xs font-medium"
        />
        {/* Hidden for a prism: the 3D gizmo edits the box fields, which a
            prism derives from its footprint, so the handles would move nothing
            (see `ZoneOverlay`). A control that does nothing is worse than no
            control. */}
        {!zone.footprint && (
          <IconButton
            label={editing ? t('zonesPanel.zoneRow.stopEditingTitle') : t('zonesPanel.zoneRow.editIn3dTitle')}
            variant={editing ? 'default' : 'ghost'}
            className="h-6 w-6"
            onClick={onEdit}
          >
            <Pencil className="h-3 w-3" />
          </IconButton>
        )}
        <IconButton label={t('zonesPanel.zoneRow.selectTitle')} className="h-6 w-6" onClick={onSelect}>
          <MousePointerClick className="h-3 w-3" />
        </IconButton>
        {/* The geometry half of #2508: elements wholly in this zone plus the
            CUT pieces of the straddlers, as one model of this section. */}
        <IconButton
          label={t('zonesPanel.zoneRow.exportGeometryAriaLabel', { name: zone.name })}
          tooltip={exporting ? t('zonesPanel.zoneRow.exportingTitle') : t('zonesPanel.zoneRow.exportGeometryTitle')}
          className="h-6 w-6"
          disabled={exporting}
          onClick={onExportGeometry}
        >
          <Scissors className={`h-3 w-3${exporting ? ' animate-pulse' : ''}`} />
        </IconButton>
        {exporting && exportProgress && (
          <output className="text-2xs tabular-nums text-muted-foreground" aria-live="polite">
            {t('zonesPanel.zoneRow.cuttingProgress', { done: exportProgress.done, total: exportProgress.total })}
          </output>
        )}
        <IconButton label={t('zonesPanel.zoneRow.deleteZoneTitle')} className="h-6 w-6 text-destructive" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
        </IconButton>
      </div>
      {/* A PRISM zone (#2508 item 4) owns only its vertical extent: its X/Z
          centre, size and rotation are DERIVED from the footprint, so offering
          them as editable fields would show numbers that snap back on the next
          import and change nothing in between. */}
      {zone.footprint ? (
        <div className="grid grid-cols-3 gap-1">
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{t('zonesPanel.zoneRow.baseYLabel')}</span>
            <NumberField
              value={zone.center[1] - zone.size[1] / 2}
              onCommit={(v) => onUpdate({ center: [zone.center[0], v + zone.size[1] / 2, zone.center[2]] })}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{t('zonesPanel.zoneRow.prismHeightLabel')}</span>
            <NumberField
              value={zone.size[1]}
              onCommit={(v) => {
                const height = Math.max(0.05, v);
                const base = zone.center[1] - zone.size[1] / 2;
                onUpdate({
                  size: [zone.size[0], height, zone.size[2]],
                  center: [zone.center[0], base + height / 2, zone.center[2]],
                });
              }}
            />
          </label>
          <span className="self-end text-2xs text-muted-foreground truncate" title={t('zonesPanel.zoneRow.footprintTitle')}>
            {t('zonesPanel.zoneRow.prismPts', { count: zone.footprint.length })}
          </span>
        </div>
      ) : (
      <div className="grid grid-cols-3 gap-1">
        {(['zonesPanel.zoneRow.centerXLabel', 'zonesPanel.zoneRow.centerYLabel', 'zonesPanel.zoneRow.centerZLabel'] as const).map((labelKey, i) => (
          <label key={labelKey} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{t(labelKey)}</span>
            <NumberField
              value={zone.center[i]}
              onCommit={(v) => {
                const center: [number, number, number] = [...zone.center];
                center[i] = v;
                onUpdate({ center });
              }}
            />
          </label>
        ))}
        {(['zonesPanel.zoneRow.widthLabel', 'zonesPanel.zoneRow.heightLabel', 'zonesPanel.zoneRow.depthLabel'] as const).map((labelKey, i) => (
          <label key={labelKey} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{t(labelKey)}</span>
            <NumberField
              value={zone.size[i]}
              onCommit={(v) => {
                const size: [number, number, number] = [...zone.size];
                size[i] = Math.max(0.05, v);
                onUpdate({ size });
              }}
            />
          </label>
        ))}
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('zonesPanel.zoneRow.rotationLabel')}</span>
          <NumberField value={toDeg(zone.rotationY)} onCommit={(v) => onUpdate({ rotationY: fromDeg(v) })} />
        </label>
      </div>
      )}
    </div>
  );
}

export function ZonesPanel({ onClose }: ZonesPanelProps) {
  const { t } = useTranslation();
  const zoneSets = useViewerStore((s) => s.zoneSets);
  const editingZone = useViewerStore((s) => s.editingZone);
  const zoneAssignmentTiming = useViewerStore((s) => s.zoneAssignmentTiming);
  const createZoneSet = useViewerStore((s) => s.createZoneSet);
  const removeZoneSet = useViewerStore((s) => s.removeZoneSet);
  const renameZoneSet = useViewerStore((s) => s.renameZoneSet);
  const setZoneSetVisible = useViewerStore((s) => s.setZoneSetVisible);
  const addZone = useViewerStore((s) => s.addZone);
  const updateZone = useViewerStore((s) => s.updateZone);
  const removeZone = useViewerStore((s) => s.removeZone);
  const setEditingZone = useViewerStore((s) => s.setEditingZone);
  const replaceZonesInSet = useViewerStore((s) => s.replaceZonesInSet);
  const exportZoneSetsJSON = useViewerStore((s) => s.exportZoneSetsJSON);
  const importZoneSetsJSON = useViewerStore((s) => s.importZoneSetsJSON);
  const { exportZone } = useZoneGeometrySplit();
  // Which zone's geometry export is running, for the disabled state, plus a ref
  // so a second click is refused in the same tick the first one starts (state
  // has not re-rendered yet at that point).
  const [exportingZoneId, setExportingZoneId] = useState<string | null>(null);
  const exportingRef = useRef(false);
  // How far the cut has got. Only meaningful while a worker is doing the work:
  // before this, the main thread was blocked and nothing could have painted it.
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);

  const [newSetName, setNewSetName] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);

  // `ZoneOverlay` is mounted independently at the viewport root, so an edit
  // session left behind when this panel goes away would keep live gizmo
  // handles intercepting pointer events with no UI left to stop them
  // (PR #1869 review, P2). Clear on unmount (panel switch) — the explicit
  // close button below clears eagerly too.
  useEffect(() => () => {
    useViewerStore.getState().setEditingZone(null);
  }, []);

  const handleClose = useCallback(() => {
    setEditingZone(null);
    onClose?.();
  }, [setEditingZone, onClose]);

  const handleAddSet = useCallback(() => {
    const name = newSetName.trim() || 'Untitled set';
    createZoneSet(name);
    setNewSetName('');
  }, [newSetName, createZoneSet]);
  const handleGenerateFromStoreys = useCallback(() => {
    const result = generateZonesFromStoreys();
    if (!result.ok) {
      toast.error(t('zonesPanel.generateFromStoreysError', { error: result.error }));
      return;
    }
    const id = createZoneSet('Storeys');
    replaceZonesInSet(id, result.zones);
    toast.success(t('zonesPanel.generateFromStoreysSuccess', { count: result.zones.length }));
  }, [createZoneSet, replaceZonesInSet, t]);
  const handleExport = useCallback(() => {
    const json = exportZoneSetsJSON();
    downloadFile(json, `${sanitizeFilename('zone-sets')}.json`, 'application/json');
    trackExportCompleted({ format: 'json', surface: 'zones_panel' });
  }, [exportZoneSetsJSON]);
  const handleImportFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const result = importZoneSetsJSON(text);
      if (!result.ok) {
        toast.error(t('zonesPanel.importFailed', { error: result.error }));
      } else {
        toast.success(t('zonesPanel.importSuccess'));
      }
    } catch (error) {
      toast.error(t('zonesPanel.importFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }, [importZoneSetsJSON, t]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <Box className="h-4 w-4 text-amber-600" />
        <span className="font-medium text-sm flex-1">{t('zonesPanel.header.title')}</span>
        {onClose && (
          <IconButton label={t('zonesPanel.header.closeLabel')} className="h-6 w-6" onClick={handleClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-b p-2">
        <Input
          value={newSetName}
          onChange={(e) => setNewSetName(e.target.value)}
          placeholder={t('zonesPanel.header.newSetPlaceholder')}
          className="h-7 flex-1 text-xs"
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddSet(); }}
        />
        <Button size="sm" className="h-7" onClick={handleAddSet}>
          <Plus className="h-3.5 w-3.5" /> {t('zonesPanel.header.addSetButton')}
        </Button>
      </div>

      <div className="flex items-center gap-1.5 border-b p-2">
        <Button variant="outline" size="sm" className="h-7 flex-1" onClick={handleGenerateFromStoreys}>
          <Layers3 className="h-3.5 w-3.5" /> {t('zonesPanel.header.generateFromStoreysButton')}
        </Button>
        <IconButton label={t('zonesPanel.header.exportSetsTitle')} className="h-7 w-7" onClick={handleExport}>
          <Download className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={t('zonesPanel.header.importSetsTitle')} className="h-7 w-7" onClick={() => importInputRef.current?.click()}>
          <Upload className="h-3.5 w-3.5" />
        </IconButton>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => { void handleImportFile(e.target.files?.[0]); }}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {zoneSets.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">{t('zonesPanel.emptyState')}</p>
        )}
        {zoneSets.map((zs) => (
          <Collapsible key={zs.id} defaultOpen className="rounded-md border">
            <div className="flex items-center gap-1 p-1.5">
              <CollapsibleTrigger className="flex-1 flex items-center gap-1.5 px-1 py-0.5 text-left">
                <span className="font-medium text-xs">{zs.name}</span>
                <span className="text-2xs text-muted-foreground">{t('zonesPanel.zoneCount', { count: zs.zones.length })}</span>
              </CollapsibleTrigger>
              <IconButton
                label={zs.visible ? t('zonesPanel.hideIn3dTitle') : t('zonesPanel.showIn3dTitle')}
                className="h-6 w-6"
                onClick={() => setZoneSetVisible(zs.id, !zs.visible)}
              >
                {zs.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </IconButton>
              <IconButton
                label={t('zonesPanel.addZoneTitle')}
                className="h-6 w-6"
                onClick={() => addZone(zs.id, { name: `Zone ${zs.zones.length + 1}` })}
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label={t('zonesPanel.deleteZoneSetTitle')}
                className="h-6 w-6 text-destructive"
                onClick={() => removeZoneSet(zs.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            <CollapsibleContent className="space-y-1.5 border-t p-1.5">
              <Input
                value={zs.name}
                onChange={(e) => renameZoneSet(zs.id, e.target.value)}
                className="h-6 text-2xs text-muted-foreground"
                placeholder={t('zonesPanel.setNamePlaceholder')}
              />
              {zs.zones.map((zone) => (
                <ZoneRow
                  key={zone.id}
                  zone={zone}
                  editing={editingZone?.setId === zs.id && editingZone.zoneId === zone.id}
                  onEdit={() => setEditingZone(
                    editingZone?.setId === zs.id && editingZone.zoneId === zone.id
                      ? null
                      : { setId: zs.id, zoneId: zone.id },
                  )}
                  onUpdate={(patch) => updateZone(zs.id, zone.id, patch)}
                  onRemove={() => removeZone(zs.id, zone.id)}
                  onSelect={() => {
                    const count = selectElementsInZone(zs.id, zone.id);
                    if (count > 0) toast.success(t('zonesPanel.selectedElements', { count }));
                    else toast.info(t('zonesPanel.noElementsInZone'));
                  }}
                  exporting={exportingZoneId === zone.id}
                  exportProgress={exportProgress}
                  onExportGeometry={async () => {
                    // The split is seconds of synchronous work (~357 ms per cut
                    // element, measured), so three things have to happen before
                    // it starts: mark the zone busy, let the browser PAINT that
                    // (a state change alone does not, since the handler blocks
                    // the same frame), and refuse a second click. Without the
                    // last one a queued click starts a whole second run the
                    // moment the first returns.
                    if (exportingRef.current) return;
                    exportingRef.current = true;
                    setExportingZoneId(zone.id);
                    setExportProgress(null);
                    let result: Awaited<ReturnType<typeof exportZone>>;
                    try {
                      // The cutting runs in a worker now, so this await yields
                      // to the event loop rather than blocking it: the disabled
                      // state paints, the progress below updates, and the model
                      // can still be orbited while a section is being cut.
                      result = await exportZone(
                        zs,
                        zs.zones.indexOf(zone),
                        (done, total) => setExportProgress({ done, total }),
                      );
                    } catch (error) {
                      // The kernel, the GLB build and the download can each
                      // throw. Inside an ASYNC handler a throw becomes an
                      // unhandled rejection, so the user would sit in front of
                      // a control that reset itself and said nothing.
                      console.error('[zones] geometry export failed', error);
                      const message = error instanceof Error ? error.message : 'unknown error';
                      toast.error(t('zonesPanel.exportZoneError', { name: zone.name, message }));
                      return;
                    } finally {
                      exportingRef.current = false;
                      setExportingZoneId(null);
                      setExportProgress(null);
                    }
                    if (!result.ok) {
                      toast.error(result.reason === 'no-binding'
                        ? t('zonesPanel.exportNoBinding')
                        : result.reason === 'busy'
                          // Reachable by closing the panel mid-export and
                          // reopening it: this component's own guard resets,
                          // the run behind it does not.
                          ? t('zonesPanel.exportBusy')
                          : t('zonesPanel.exportNothingToExport'));
                      return;
                    }
                    trackExportCompleted({ format: 'glb', surface: 'zones_panel' });
                    const { whole, cut, refused, noGeometry, elapsedMs } = result.summary;
                    const elapsed = (elapsedMs / 1000).toFixed(1);
                    const successKey: TranslationKey = refused > 0 && noGeometry > 0
                      ? 'zonesPanel.exportGeometrySuccessBoth'
                      : refused > 0 ? 'zonesPanel.exportGeometrySuccessRefusedOnly'
                        : noGeometry > 0 ? 'zonesPanel.exportGeometrySuccessNoGeometryOnly'
                          : 'zonesPanel.exportGeometrySuccessPlain';
                    toast.success(t(successKey, { whole, cut, elapsed, refused, noGeometry }));
                  }}
                />
              ))}
              {/* Volume apportionment for this set's straddlers (#2508). On
                  demand only — never part of load. */}
              {zs.zones.length > 0 && <ZoneApportionSummary zoneSet={zs} />}
              {/* ...and the way that result leaves the viewer (#2508 item 3). */}
              {zs.zones.length > 0 && <ZoneWriteBackControl zoneSet={zs} />}
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>

      {zoneAssignmentTiming && (
        <div className="border-t p-2 text-2xs text-muted-foreground">
          {t('zonesPanel.assignmentTimingLine', {
            elementCount: zoneAssignmentTiming.elementCount.toLocaleString(),
            zoneSetCount: zoneAssignmentTiming.zoneSetCount, elapsedMs: zoneAssignmentTiming.elapsedMs.toFixed(1),
          })}
        </div>
      )}
    </div>
  );
}
