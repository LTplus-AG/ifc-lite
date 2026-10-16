/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export the selected IFC terrain as LandXML 1.2 (#7600).
 *
 * The candidates are the CURRENT SELECTION (`getSelectionBaseRefs`), narrowed
 * to `IfcGeographicElement` / `IfcSite` in one model
 * (`resolveTerrainSelection`). While the dialog is open, every change of that
 * selection runs the real producer over the model as edited
 * (`editedModelBytes`, the same bytes the CSV export reads) as a preflight:
 * the dialog offers Export only when the producer accepted the selection, and
 * otherwise shows the producer's own refusal reason. Export then downloads
 * the preflight's document; it does not run the producer a second time.
 *
 * Chrome (open/busy/result state, footer, result alert) is `ExportDialogShell`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Download } from 'lucide-react';
import type { ExportSurface } from '@/lib/analytics-export-events';
import { trackExportCompleted } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { getSelectionBaseRefs } from '@/store/basketVisibleSet';
import { entityRefToString, stringToEntityRef } from '@/store/types';
import { downloadBlob } from '@/lib/export/download';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import {
  landXmlTerrainFilename,
  resolveTerrainSelection,
  runLandXmlTerrainExport,
  type LandXmlTerrainProcessor,
  type TerrainPreflight,
} from '@/lib/export/landXmlTerrainExport';
import { GeometryProcessor, type LandXmlTerrainExportOptions } from '@ifc-lite/geometry';
import { formatLocaleNumber, useTranslation } from '@/i18n';
import { ExportDialogShell, type ExportDialogShellResult } from './ExportDialogShell';

interface LandXmlTerrainExportDialogProps {
  surface: ExportSurface;
  trigger?: React.ReactNode;
  /** The geometry processor factory; tests inject a stub. */
  createProcessor?: () => LandXmlTerrainProcessor;
}

type PreflightState = TerrainPreflight | { status: 'checking' } | null;
type LinearUnit = NonNullable<LandXmlTerrainExportOptions['linearUnit']>;

const LINEAR_UNITS: readonly LinearUnit[] = ['metre', 'internationalFoot', 'usSurveyFoot'];
/** Decimal places in the written unit; 6 is a micrometre in metres, far below survey precision. */
const DECIMALS = ['3', '4', '6'] as const;

const createGeometryProcessor = (): LandXmlTerrainProcessor => new GeometryProcessor();

export function LandXmlTerrainExportDialog({
  surface,
  trigger,
  createProcessor = createGeometryProcessor,
}: LandXmlTerrainExportDialogProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [preflight, setPreflight] = useState<PreflightState>(null);
  // Options only change how the document is written, never whether the
  // selection qualifies, so they apply at Export rather than re-running the
  // preflight (#7618).
  const [linearUnit, setLinearUnit] = useState<LinearUnit>('metre');
  const [decimals, setDecimals] = useState<(typeof DECIMALS)[number]>('6');
  const [surfaceNames, setSurfaceNames] = useState<Record<number, string>>({});
  const models = useViewerStore((s) => s.models);
  const legacyStore = useViewerStore((s) => s.ifcDataStore);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  // A primitive key, so the store subscription only re-renders when the
  // selection itself changes; read only while open (the ribbon mounts this
  // dialog permanently).
  const selectionKey = useViewerStore((s) =>
    isOpen ? getSelectionBaseRefs(s).map(entityRefToString).join('\n') : '',
  );

  const selection = useMemo(
    () =>
      resolveTerrainSelection({
        refs: selectionKey ? selectionKey.split('\n').map(stringToEntityRef) : [],
        models,
        legacyStore,
      }),
    [selectionKey, models, legacyStore],
  );

  useEffect(() => {
    if (!isOpen || selection.kind !== 'ready') {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    setPreflight({ status: 'checking' });
    void (async () => {
      let outcome: TerrainPreflight;
      try {
        const bytes = editedModelBytes(selection.store, getMutationView(selection.modelId));
        outcome = await runLandXmlTerrainExport(bytes, selection.productIds, createProcessor);
      } catch (error) {
        console.error('LandXML terrain preflight failed:', error);
        outcome = { status: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
      if (!cancelled) setPreflight(outcome);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, selection, getMutationView, createProcessor]);

  const ready = useMemo(
    () => (selection.kind === 'ready' && preflight?.status === 'ready' ? { selection, preflight } : null),
    [selection, preflight],
  );

  // Each new preflight seeds the name fields with the names it would write.
  useEffect(() => {
    if (preflight?.status !== 'ready') return;
    setSurfaceNames(Object.fromEntries(preflight.result.surfaces.map((entry) => [entry.productId, entry.name])));
  }, [preflight]);

  const handleExport = useCallback(async (): Promise<ExportDialogShellResult> => {
    if (!ready) {
      return { success: false, message: t('landXmlTerrainExport.noSelectionDescription') };
    }
    try {
      const bytes = editedModelBytes(ready.selection.store, getMutationView(ready.selection.modelId));
      const outcome = await runLandXmlTerrainExport(bytes, ready.selection.productIds, createProcessor, {
        linearUnit,
        decimals: Number(decimals),
        surfaceNames,
      });
      if (outcome.status !== 'ready') {
        throw new Error(outcome.status === 'refused' ? outcome.reason
          : outcome.status === 'failed' ? outcome.message : t('landXmlTerrainExport.unavailableDescription'));
      }
      const blob = new Blob([outcome.result.xml], { type: 'application/xml' });
      downloadBlob(blob, landXmlTerrainFilename(ready.selection.modelName));
      trackExportCompleted({ format: 'landxml', surface, size_kb: Math.round(blob.size / 1024) });
      const message = t('landXmlTerrainExport.exportedMessage', { sizeKb: (blob.size / 1024).toFixed(0) });
      toast.success(message);
      return { success: true, message };
    } catch (error) {
      console.error('LandXML terrain export failed:', error);
      const message = t('landXmlTerrainExport.failedMessage', {
        reason: error instanceof Error ? error.message : t('geometryExport.shared.unknownError'),
      });
      toast.error(message);
      return { success: false, message };
    }
  }, [ready, surface, t, getMutationView, createProcessor, linearUnit, decimals, surfaceNames]);

  return (
    <ExportDialogShell
      trigger={
        trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('landXmlTerrainExport.triggerButton')}
          </Button>
        )
      }
      icon={<Download className="h-5 w-5" />}
      title={t('landXmlTerrainExport.dialogTitle')}
      description={t('landXmlTerrainExport.dialogDescription')}
      cancelLabel={t('landXmlTerrainExport.cancelButton')}
      exportLabel={t('landXmlTerrainExport.exportButton')}
      exportingLabel={t('landXmlTerrainExport.exportingButton')}
      exportIcon={<Download className="h-4 w-4 mr-2" />}
      successTitle={t('landXmlTerrainExport.successTitle')}
      errorTitle={t('landXmlTerrainExport.errorTitle')}
      filenamePreview={ready ? landXmlTerrainFilename(ready.selection.modelName) : undefined}
      exportDisabled={!ready}
      onExport={handleExport}
      onOpenStateChange={setIsOpen}
    >
      {selection.skipped > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('landXmlTerrainExport.skippedNote', { count: selection.skipped })}
        </p>
      )}

      {selection.kind === 'none' && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('landXmlTerrainExport.noSelectionTitle')}</AlertTitle>
          <AlertDescription>{t('landXmlTerrainExport.noSelectionDescription')}</AlertDescription>
        </Alert>
      )}

      {selection.kind === 'multiple-models' && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('landXmlTerrainExport.multipleModelsTitle')}</AlertTitle>
          <AlertDescription>
            {t('landXmlTerrainExport.multipleModelsDescription', { count: selection.modelCount })}
          </AlertDescription>
        </Alert>
      )}

      {selection.kind === 'ready' && preflight && (
        <PreflightView
          preflight={preflight}
          surfaceNames={surfaceNames}
          onSurfaceNameChange={(productId, name) => setSurfaceNames((names) => ({ ...names, [productId]: name }))}
        />
      )}

      {ready && (
        <div className="grid gap-3">
          <div className="flex items-center gap-4">
            <Label className="w-32 text-muted-foreground">{t('landXmlTerrainExport.outputLabel')}</Label>
            <Badge variant="secondary">{t('landXmlTerrainExport.outputFormat')}</Badge>
            <span className="text-xs text-muted-foreground">{t('landXmlTerrainExport.fileExtension')}</span>
          </div>
          <div className="flex items-center gap-4">
            <Label htmlFor="landxml-terrain-units" className="w-32">{t('landXmlTerrainExport.unitsLabel')}</Label>
            <Select value={linearUnit} onValueChange={(value) => setLinearUnit(value as LinearUnit)}>
              <SelectTrigger id="landxml-terrain-units">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LINEAR_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>{t(`landXmlTerrainExport.unit.${unit}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {linearUnit === 'usSurveyFoot' && (
            <p className="text-xs text-muted-foreground">{t('landXmlTerrainExport.usSurveyFootNote')}</p>
          )}
          <div className="flex items-center gap-4">
            <Label htmlFor="landxml-terrain-decimals" className="w-32">{t('landXmlTerrainExport.decimalsLabel')}</Label>
            <Select value={decimals} onValueChange={(value) => setDecimals(value as (typeof DECIMALS)[number])}>
              <SelectTrigger id="landxml-terrain-decimals">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DECIMALS.map((places) => (
                  <SelectItem key={places} value={places}>{t(`landXmlTerrainExport.decimals.${places}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </ExportDialogShell>
  );
}

interface PreflightViewProps {
  preflight: Exclude<PreflightState, null>;
  /** The editable `Surface@name` per product, seeded from the preflight. */
  surfaceNames: Readonly<Record<number, string>>;
  onSurfaceNameChange: (productId: number, name: string) => void;
}

function PreflightView({ preflight, surfaceNames, onSurfaceNameChange }: PreflightViewProps) {
  const { t, locale } = useTranslation();
  switch (preflight.status) {
    case 'checking':
      return (
        <output className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          {t('landXmlTerrainExport.checking')}
        </output>
      );
    case 'refused':
      return (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('landXmlTerrainExport.refusedTitle')}</AlertTitle>
          <AlertDescription className="break-words">{preflight.reason}</AlertDescription>
        </Alert>
      );
    case 'unavailable':
    case 'failed':
      return (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('landXmlTerrainExport.checkFailedTitle')}</AlertTitle>
          <AlertDescription className="break-words">
            {preflight.status === 'failed' ? preflight.message : t('landXmlTerrainExport.unavailableDescription')}
          </AlertDescription>
        </Alert>
      );
    case 'ready': {
      const { surfaces, crsName } = preflight.result;
      return (
        <div className="grid gap-2">
          <p className="text-sm font-medium">
            {t('landXmlTerrainExport.surfacesHeading', { count: surfaces.length })}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="font-normal">{t('landXmlTerrainExport.surfaceNameColumn')}</th>
                <th scope="col" className="font-normal text-right">{t('landXmlTerrainExport.pointsColumn')}</th>
                <th scope="col" className="font-normal text-right">{t('landXmlTerrainExport.trianglesColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {surfaces.map((surface) => (
                <tr key={surface.productId} data-terrain-surface={surface.productId}>
                  <td className="pr-2">
                    <Input
                      className="h-8"
                      value={surfaceNames[surface.productId] ?? surface.name}
                      aria-label={t('landXmlTerrainExport.surfaceNameInput', { name: surface.name })}
                      onChange={(event) => onSurfaceNameChange(surface.productId, event.target.value)}
                    />
                  </td>
                  <td className="text-right tabular-nums">{formatLocaleNumber(locale, surface.points)}</td>
                  <td className="text-right tabular-nums">{formatLocaleNumber(locale, surface.faces)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">
            {t('landXmlTerrainExport.crsLabel', { crsName })}
          </p>
        </div>
      );
    }
  }
}
