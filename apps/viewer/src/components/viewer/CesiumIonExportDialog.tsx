/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CloudUpload, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { ExportSurface } from '@/lib/analytics-export-events';
import { exportModelStep } from '@/lib/export/model-step-export';
import { mapStepSchema } from '@/lib/export/artifact-naming';
import { modelExportFilename } from '@/lib/export/download';
import { IonUploadError, ionAssetUrl, uploadToCesiumIon, type IonUploadPhase } from '@/lib/geo/cesium-ion-upload';
import { listExportModels, resolveExportModel } from './export-model-selection';
import { preferredExportModelId } from './export-model-default';
import { ExportDialogShell } from './ExportDialogShell';

export interface CesiumIonExportDialogProps {
  trigger?: React.ReactNode;
  surface: ExportSurface;
  /** Network transport only; serialization always uses the real shared exporter. */
  upload?: typeof uploadToCesiumIon;
}

export function CesiumIonExportDialog({ trigger, upload = uploadToCesiumIon }: CesiumIonExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore(s => s.models);
  const activeModelId = useViewerStore(s => s.activeModelId);
  const legacyStore = useViewerStore(s => s.ifcDataStore);
  const legacyGeometry = useViewerStore(s => s.geometryResult);
  const [selectedId, setSelectedId] = useState('');
  const [token, setToken] = useState('');
  const [assetId, setAssetId] = useState<number>();
  const [assetName, setAssetName] = useState('');
  const [phase, setPhase] = useState<'serialize' | IonUploadPhase>();
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const modelList = useMemo(() => listExportModels(models, new Set(), legacyStore)
    .filter(model => model.schemaVersion !== 'IFC5' && !model.sourceSchema
      && (model.id === '__legacy__' || models.get(model.id)?.ifcDataStore)), [models, legacyStore]);
  useEffect(() => {
    if (!modelList.some(model => model.id === selectedId)) {
      setSelectedId(preferredExportModelId(modelList.map(model => model.id), activeModelId));
    }
  }, [modelList, selectedId, activeModelId]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const selected = resolveExportModel(models, selectedId, legacyStore, legacyGeometry);

  async function onUpload() {
    const abort = new AbortController();
    controller.current = abort;
    setAssetId(undefined);
    setPhase('serialize');
    try {
      // Resolve again at invocation: never export a removed model or stale view.
      const state = useViewerStore.getState();
      const model = resolveExportModel(state.models, selectedId, state.ifcDataStore, state.geometryResult);
      if (!model?.ifcDataStore || model.schemaVersion === 'IFC5' || model.sourceSchema) {
        return { success: false, message: t('ionUpload.noModel') };
      }
      const result = await exportModelStep({
        modelId: selectedId, dataStore: model.ifcDataStore,
        mutationView: state.getMutationView(selectedId) ?? undefined,
        options: {
          schema: mapStepSchema(model.ifcDataStore.schemaVersion ?? ''),
          includeGeometry: true, applyMutations: true, visibleOnly: false,
          georefMutations: state.georefMutations.get(selectedId) ?? undefined,
          application: 'ifc-lite', description: 'Exported from ifc-lite for Cesium ion',
          onProgress: () => abort.signal.throwIfAborted(),
        },
        scheduleState: {
          scheduleData: state.scheduleData, scheduleIsEdited: state.scheduleIsEdited,
          scheduleSourceModelId: state.scheduleSourceModelId,
        },
      });
      abort.signal.throwIfAborted();
      if (result.stats.warnings.length) {
        return { success: false, message: t('ionUpload.exportWarnings', { count: result.stats.warnings.length }) };
      }
      if (result.resources.exportResources().resources.size) {
        return { success: false, message: t('ionUpload.texturesUnsupported') };
      }
      const response = await upload({
        token, name: model.name.replace(/\.[^.]+$/, ''),
        fileName: modelExportFilename(model.name, 'ifc'),
        bytes: typeof result.content === 'string' ? new TextEncoder().encode(result.content) : result.content,
        signal: abort.signal, onPhase: next => { if (mounted.current) setPhase(next); },
      });
      if (mounted.current) { setAssetId(response.assetId); setAssetName(response.name ?? model.name.replace(/\.[^.]+$/, '')); }
      return { success: true, message: t('ionUpload.accepted') };
    } catch (error) {
      if (mounted.current && error instanceof IonUploadError) {
        setAssetId(error.assetId); setAssetName(selected?.name.replace(/\.[^.]+$/, '') ?? '');
      }
      if (abort.signal.aborted) return { success: false, message: t('ionUpload.cancelled') };
      // Serialization errors can contain model content; show a safe explanation.
      return { success: false, message: error instanceof IonUploadError
        ? t('ionUpload.failed', { phase: t(`ionUpload.phase.${error.phase}`), status: error.status ?? '—',
          help: t(`ionUpload.failure.${error.reason}`) })
        : t('ionUpload.serializationFailed') };
    } finally {
      controller.current = null;
      if (mounted.current) setPhase(undefined);
    }
  }

  return <ExportDialogShell
    trigger={trigger ?? <Button variant="outline" size="sm"><CloudUpload className="h-4 w-4 mr-2" />{t('exportCommands.ion.menuLabel')}</Button>}
    icon={<CloudUpload className="h-5 w-5" />}
    title={t('ionUpload.title')} description={t('ionUpload.description')}
    cancelLabel={t('ionUpload.close')} exportLabel={t('ionUpload.upload')} exportingLabel={t('ionUpload.uploading')}
    successTitle={t('ionUpload.successTitle')} errorTitle={t('ionUpload.errorTitle')}
    exportDisabled={!selected?.ifcDataStore || !token.trim()}
    onOpenStateChange={open => { if (!open) setToken(''); else setAssetId(undefined); }}
    onExport={onUpload}
    footerLeading={({ isExporting }) => isExporting && <Button variant="outline" onClick={() => controller.current?.abort()}>{t('ionUpload.abort')}</Button>}
    resultDetails={assetId !== undefined && <Button asChild className="h-auto min-h-9 w-full min-w-0 whitespace-normal">
      <a href={ionAssetUrl(assetId)} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden className="h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{t('ionUpload.openAsset', { name: assetName })}</span>
      </a>
    </Button>}
  >{({ isExporting }) => <>
    <div className="grid gap-2">
      <Label htmlFor="ion-model">{t('ionUpload.model')}</Label>
      <Select value={selectedId} onValueChange={setSelectedId} disabled={isExporting}>
        <SelectTrigger id="ion-model"><SelectValue placeholder={t('ionUpload.noModel')} /></SelectTrigger>
        <SelectContent>{modelList.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid gap-2">
      <Label htmlFor="ion-token">{t('ionUpload.token')}</Label>
      <Input id="ion-token" type="password" autoComplete="off" value={token} disabled={isExporting} onChange={event => setToken(event.target.value)} />
      <p className="text-xs text-muted-foreground">{t('ionUpload.tokenHelp')}{' '}<a className="underline" href="https://ion.cesium.com/tokens" target="_blank" rel="noopener noreferrer">{t('ionUpload.createToken')}</a></p>
    </div>
    <p className="text-sm text-muted-foreground">{t('ionUpload.placement')}</p>
    {phase && <output className="text-sm">{t(`ionUpload.phase.${phase}`)}</output>}
  </>}</ExportDialogShell>;
}
