/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { trackExportCompleted } from '@/lib/analytics';
import type { ExportSurface } from '@/lib/analytics-export-events';
import { downloadBlob, modelExportFilename } from '@/lib/export/download';
import { isStepSourceModel, resolveStepExportBytes } from './step-export-source';
import { ExportDialogShell, type ExportDialogShellResult } from './ExportDialogShell';

/** STEP-based export: preserve the producer's local-coordinate fallback (#10607). */
export function CityJsonExportDialog({ surface, trigger }: { surface: ExportSurface; trigger?: React.ReactNode }) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const modelList = useMemo(() => [...models.values()].filter(isStepSourceModel), [models]);
  const [selectedId, setSelectedId] = useState('');
  const [sequence, setSequence] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!modelList.some((m) => m.id === selectedId)) setSelectedId(modelList[0]?.id ?? '');
  }, [modelList, selectedId]);
  const model = modelList.find((m) => m.id === selectedId);
  const localCoordinates = useMemo(() => open && !!model &&
    (!model.ifcDataStore || !extractGeoreferencingOnDemand(model.ifcDataStore)?.hasGeoreference), [open, model]);

  async function handleExport(): Promise<ExportDialogShellResult> {
    if (!model) return { success: false, message: t('cityJsonExport.noSource') };
    // Load both the facade and the separate export WASM only on demand.
    const { exportCityJson, cityJsonRefusalReason } = await import('@ifc-lite/geometry');
    try {
      const bytes = await resolveStepExportBytes(model, getMutationView);
      const result = await exportCityJson(bytes, { sequence });
      const blob = new Blob([result.text], { type: sequence ? 'application/x-ndjson' : 'application/json' });
      downloadBlob(blob, modelExportFilename(model.name, sequence ? 'city.jsonl' : 'city.json'));
      const message = t('cityJsonExport.exported');
      // Keep diagnostics visible and bounded; retain the full list inline.
      if (result.warnings.length) {
        const warnings = result.warnings.slice(0, 5).map((w) => w.slice(0, 300)).join('\n');
        toast.info(t('cityJsonExport.warnings', { warnings, count: String(result.warnings.length) }));
      } else toast.success(message);
      trackExportCompleted({ surface, format: sequence ? 'cityjsonseq' : 'cityjson', size_kb: Math.round(blob.size / 1024) });
      return { success: true, message, warnings: result.warnings };
    } catch (error) {
      const reason = cityJsonRefusalReason(error);
      if (reason === null) console.error('CityJSON export failed:', error);
      return { success: false, message: t('cityJsonExport.failed', {
        reason: reason ?? (error instanceof Error ? error.message : t('geometryExport.shared.unknownError')),
      }) };
    }
  }

  return <ExportDialogShell
    trigger={trigger ?? <Button variant="outline" size="sm"><Download className="h-4 w-4 mr-2" />{t('exportCommands.cityjson.menuLabel')}</Button>}
    icon={<Download className="h-5 w-5" />}
    title={t('exportCommands.cityjson.menuLabel')}
    description={t('cityJsonExport.description')}
    cancelLabel={t('geometryExport.kmz.cancelButton')}
    exportLabel={t('geometryExport.kmz.exportButton')}
    exportingLabel={t('geometryExport.kmz.exportingButton')}
    successTitle={t('geometryExport.kmz.successTitle')}
    errorTitle={t('geometryExport.kmz.errorTitle')}
    filenamePreview={model ? modelExportFilename(model.name, sequence ? 'city.jsonl' : 'city.json') : undefined}
    exportDisabled={!model} onExport={handleExport} onOpenStateChange={setOpen}
  >{({ isExporting }) => <>
    {localCoordinates && <Alert><AlertDescription>{t('cityJsonExport.localNotice')}</AlertDescription></Alert>}
    {!model && <Alert><AlertDescription>{t('cityJsonExport.noSource')}</AlertDescription></Alert>}
    {modelList.length > 1 && <div className="space-y-2">
      <Label htmlFor="cityjson-model">{t('geometryExport.kmz.modelLabel')}</Label>
      <Select value={selectedId} onValueChange={setSelectedId} disabled={isExporting}>
        <SelectTrigger id="cityjson-model"><SelectValue /></SelectTrigger>
        <SelectContent>{modelList.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>}
    <div className="space-y-2">
      <Label htmlFor="cityjson-format">{t('geometryExport.kmz.outputLabel')}</Label>
      <Select value={sequence ? 'sequence' : 'document'} onValueChange={(v) => setSequence(v === 'sequence')} disabled={isExporting}>
        <SelectTrigger id="cityjson-format"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="document">{t('cityJsonExport.document')}</SelectItem>
          <SelectItem value="sequence">{t('cityJsonExport.sequence')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  </>}</ExportDialogShell>;
}
