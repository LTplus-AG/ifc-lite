/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DxfUnderlayPanel - manage imported DXF reference underlays (issue #1782)
 *
 * Import DXF files as toggleable reference layers under the 2D drawing:
 * per-file visibility/opacity, per-DXF-layer toggles, centre-on-model, and
 * placement (offset / rotation / scale) against the model's coordinate
 * system. Site plans render on Down; frozen plane references project into
 * compatible Front/Side/Down drawings.
 *
 * "Align to model georeference" (issue #1929) is a per-underlay toggle for
 * DXFs authored in map/CRS coordinates (eastings/northings) rather than
 * the model's local frame — the inverse IfcMapConversion, resolved from
 * the federation anchor, is applied before the offset/rotation/scale
 * placement above.
 *
 * PR #1965 review: the toggle is now tri-state (`DxfUnderlayState`'s
 * `georeferenced` field doc, `drawing2DSlice.ts`). `ingestDxfFile` seeds a
 * fresh entry to "auto" (`undefined`) rather than baking in a boolean at
 * import time; the checkbox below shows the EFFECTIVE resolved state
 * (`resolveEffectiveGeoreferenced`, following `georeferenceAvailable`
 * while in auto mode) and only becomes an explicit `true`/`false` — pinned
 * regardless of anchor availability — once the user actually clicks it.
 *
 * Issue #2043: the 2D underlay is one of TWO independent visibility
 * toggles per entry — `visible` (2D drawing panel, this panel's original
 * behaviour) and `visible3D` (3D viewport overlay, `Viewport.tsx`'s
 * `useDxfUnderlays3DLines`). Both default to on and are controlled here,
 * not at import time, per the issue's explicit rejection of a load-time
 * 2D-vs-3D choice. The 3D overlay currently renders line paths only
 * (walls/boundaries); fills/hatches and text labels are not lifted to 3D
 * yet (`dxfUnderlayToWorldLines3D`'s doc in `dxfUnderlayMath.ts`).
 */

import React, { useCallback, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { posthog } from '@/lib/analytics';
import { ingestDxfFile } from '@/hooks/ingest/dxfIngest';
import type { SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import { UnderlayCard } from './drawing/DxfUnderlayCard';
import { captureDxfReferenceFrame } from '@/hooks/dxfReferencePlane';

export interface DxfUnderlayPanelProps {
  /** Centre the underlay on the generated drawing (offset adjustment). */
  onCenterOnModel: (id: string) => void;
  /** False when the current section is not a cardinal plan view. */
  planViewActive: boolean;
  /**
   * Whether an anchor model currently has a usable IfcMapConversion (issue
   * #1929 / PR #1965 review) — drives the checkbox's displayed state for
   * any underlay still in "auto" mode (`entry.georeferenced === undefined`).
   */
  georeferenceAvailable: boolean;
  sectionPlane?: SectionPlaneConfig;
}

export function DxfUnderlayPanel({ onCenterOnModel, planViewActive, georeferenceAvailable, sectionPlane }: DxfUnderlayPanelProps): React.ReactElement {
  const { t } = useTranslation(); const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [chosenMode, setChosenMode] = useState<'site-plan' | 'plane-reference' | null>(null);
  const mode = chosenMode ?? (planViewActive ? 'site-plan' : 'plane-reference');
  const [units, setUnits] = useState<'auto' | 'm' | 'mm' | 'cm' | 'ft' | 'in'>('auto');
  const [importing, setImporting] = useState(false);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ''; // allow re-importing the same file
    if (files.length === 0) return;

    setImporting(true);
    try {
      // Capture before awaiting bytes, but handle a section change while the
      // native picker was open (a custom plane cannot be registered).
      const referenceFrame = mode === 'plane-reference' && sectionPlane
        ? captureDxfReferenceFrame(useViewerStore.getState(), sectionPlane) : undefined;
      if (mode === 'plane-reference' && !referenceFrame) return;
      const options = { referenceFrame, units: units === 'auto' ? undefined : units };
      for (const file of files) {
        await ingestDxfFile(file, options); // errors surface as toasts inside
      }
      posthog.capture('dxf_underlay_imported', { file_count: files.length });
    } catch (error: unknown) {
      console.error('[DxfUnderlayPanel] import failed', error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }, [mode, units, sectionPlane]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* The inspector tab (#5495) carries the title; no panel-owned header. */}
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".dxf"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <label className="block space-y-1 text-xs">
          <span>{t('drawingUnderlay.dxf.importPlacement')}</span>
          <select className="w-full rounded border bg-background p-1" value={mode}
            onChange={event => setChosenMode(event.currentTarget.value === 'plane-reference' ? 'plane-reference' : 'site-plan')}>
            <option value="site-plan">{t('drawingUnderlay.dxf.sitePlan')}</option>
            <option value="plane-reference" disabled={!sectionPlane || !!sectionPlane.customPlane}>{t('drawingUnderlay.dxf.sectionReference')}</option>
          </select>
        </label>
        <label className="block space-y-1 text-xs">
          <span>{t('drawingUnderlay.dxf.units')}</span>
          <select className="w-full rounded border bg-background p-1" value={units} onChange={event => {
            const value = event.currentTarget.value;
            if (value === 'auto' || value === 'm' || value === 'mm' || value === 'cm' || value === 'ft' || value === 'in') setUnits(value);
          }}>
            <option value="auto">{t('drawingUnderlay.dxf.fileUnits')}</option>
            {(['m', 'mm', 'cm', 'ft', 'in'] as const).map(unit => <option key={unit} value={unit}>{unit}</option>)}
          </select>
        </label>
        <p className="text-2xs text-muted-foreground">{t('drawingUnderlay.dxf.unitsHint')}</p>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={importing || (mode === 'plane-reference' && (!sectionPlane || !!sectionPlane.customPlane))}
          onClick={() => fileInputRef.current?.click()}
        >
          {importing ? (
            <Spinner size="md" className="mr-2" />
          ) : (
            <FileUp className="h-4 w-4 mr-2" />
          )}
          {t('drawingUnderlay.dxf.importButton')}
        </Button>

        {dxfUnderlays.length === 0 && (
          <p className="text-xs text-muted-foreground px-1">{t('drawingUnderlay.dxf.emptyStateHint')}</p>
        )}

        {dxfUnderlays.map((state) => (
          <UnderlayCard key={state.id} state={state} onCenterOnModel={onCenterOnModel} planViewActive={planViewActive} georeferenceAvailable={georeferenceAvailable} sectionPlane={sectionPlane} />
        ))}
      </div>
    </div>
  );
}
