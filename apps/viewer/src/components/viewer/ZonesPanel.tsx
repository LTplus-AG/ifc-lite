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
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useViewerStore } from '@/store';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { generateZonesFromStoreys } from '@/hooks/useZoneStoreyGeneration';
import { selectElementsInZone } from '@/hooks/useZoneSelection';
import type { Zone } from '@/lib/zones';
import { ZoneApportionSummary } from './ZoneApportionSummary';

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
      className={className ?? 'h-6 w-16 px-1 text-[11px]'}
    />
  );
}

function ZoneRow({
  setId, zone, editing, onEdit, onUpdate, onRemove, onSelect,
}: {
  setId: string;
  zone: Zone;
  editing: boolean;
  onEdit: () => void;
  onUpdate: (patch: Partial<Omit<Zone, 'id'>>) => void;
  onRemove: () => void;
  onSelect: () => void;
}) {
  return (
    <div className={`rounded-md border p-2 text-xs space-y-1.5 ${editing ? 'border-amber-500 bg-amber-500/5' : 'border-border/60'}`}>
      <div className="flex items-center gap-1.5">
        <Input
          value={zone.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="h-6 flex-1 px-1.5 text-xs font-medium"
        />
        <Button
          variant={editing ? 'default' : 'ghost'}
          size="icon"
          className="h-6 w-6"
          title={editing ? 'Stop editing in 3D' : 'Edit in 3D (move / resize / rotate handles)'}
          onClick={onEdit}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Select elements in this zone" onClick={onSelect}>
          <MousePointerClick className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="Delete zone" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {(['Center X', 'Center Y', 'Center Z'] as const).map((label, i) => (
          <label key={label} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{label}</span>
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
        {(['Width (X)', 'Height (Y)', 'Depth (Z)'] as const).map((label, i) => (
          <label key={label} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{label}</span>
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
          <span className="text-muted-foreground">Rotation (°)</span>
          <NumberField value={toDeg(zone.rotationY)} onCommit={(v) => onUpdate({ rotationY: fromDeg(v) })} />
        </label>
      </div>
    </div>
  );
}

export function ZonesPanel({ onClose }: ZonesPanelProps) {
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
      toast.error(`Could not generate zones from storeys: ${result.error}`);
      return;
    }
    const id = createZoneSet('Storeys');
    replaceZonesInSet(id, result.zones);
    toast.success(`Generated ${result.zones.length} zone(s) from storeys`);
  }, [createZoneSet, replaceZonesInSet]);

  const handleExport = useCallback(() => {
    const json = exportZoneSetsJSON();
    downloadFile(json, `${sanitizeFilename('zone-sets')}.json`, 'application/json');
  }, [exportZoneSetsJSON]);

  const handleImportFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const result = importZoneSetsJSON(text);
      if (!result.ok) {
        toast.error(`Import failed: ${result.error}`);
      } else {
        toast.success('Zone sets imported');
      }
    } catch (error) {
      toast.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }, [importZoneSetsJSON]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <Box className="h-4 w-4 text-amber-600" />
        <span className="font-medium text-sm flex-1">Location zones</span>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-b p-2">
        <Input
          value={newSetName}
          onChange={(e) => setNewSetName(e.target.value)}
          placeholder="New zone set name…"
          className="h-7 flex-1 text-xs"
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddSet(); }}
        />
        <Button size="sm" className="h-7" onClick={handleAddSet}>
          <Plus className="h-3.5 w-3.5" /> Set
        </Button>
      </div>

      <div className="flex items-center gap-1.5 border-b p-2">
        <Button variant="outline" size="sm" className="h-7 flex-1" onClick={handleGenerateFromStoreys}>
          <Layers3 className="h-3.5 w-3.5" /> Generate from storeys
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Export zone sets as JSON" onClick={handleExport}>
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Import zone sets from JSON"
          onClick={() => importInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
        </Button>
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
          <p className="p-3 text-xs text-muted-foreground">
            No zone sets yet. Create one above, or generate one from the model&apos;s storeys.
          </p>
        )}
        {zoneSets.map((zs) => (
          <Collapsible key={zs.id} defaultOpen className="rounded-md border">
            <div className="flex items-center gap-1 p-1.5">
              <CollapsibleTrigger className="flex-1 flex items-center gap-1.5 px-1 py-0.5 text-left">
                <span className="font-medium text-xs">{zs.name}</span>
                <span className="text-[10px] text-muted-foreground">{zs.zones.length} zone{zs.zones.length === 1 ? '' : 's'}</span>
              </CollapsibleTrigger>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                title={zs.visible ? 'Hide in 3D view' : 'Show in 3D view'}
                onClick={() => setZoneSetVisible(zs.id, !zs.visible)}
              >
                {zs.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                title="Add zone"
                onClick={() => addZone(zs.id, { name: `Zone ${zs.zones.length + 1}` })}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive"
                title="Delete zone set"
                onClick={() => removeZoneSet(zs.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <CollapsibleContent className="space-y-1.5 border-t p-1.5">
              <Input
                value={zs.name}
                onChange={(e) => renameZoneSet(zs.id, e.target.value)}
                className="h-6 text-[11px] text-muted-foreground"
                placeholder="Set name"
              />
              {zs.zones.map((zone) => (
                <ZoneRow
                  key={zone.id}
                  setId={zs.id}
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
                    if (count > 0) toast.success(`Selected ${count} element(s)`);
                    else toast.info('No elements in this zone');
                  }}
                />
              ))}
              {/* Volume apportionment for this set's straddlers (#2508). On
                  demand only — never part of load. */}
              {zs.zones.length > 0 && <ZoneApportionSummary zoneSet={zs} />}
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>

      {zoneAssignmentTiming && (
        <div className="border-t p-2 text-[10px] text-muted-foreground">
          Last assignment: {zoneAssignmentTiming.elementCount.toLocaleString()} element(s) x{' '}
          {zoneAssignmentTiming.zoneSetCount} set(s) in {zoneAssignmentTiming.elapsedMs.toFixed(1)}ms
        </div>
      )}
    </div>
  );
}
