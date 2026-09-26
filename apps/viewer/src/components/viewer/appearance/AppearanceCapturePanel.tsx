/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { selectCreatedAppearanceObject } from './select-created-object';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { prepareCapturedRegion } from '@/lib/appearance/capture/source';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets';
import { createIfcFromCapturedMesh, type CapturedMeshSource } from '@/lib/appearance/create-captured-mesh';
import { useIfcAuthoringTarget } from './useIfcAuthoringTarget';
import { AppearanceMeshPreview } from './AppearanceMeshPreview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { appearanceSelectClass } from './AppearanceSourceFields';
import { useIfc } from '@/hooks/useIfc';
import { createBlankIfcFile } from '@/utils/createBlankIfc';
import { usePreparedModelFileRoute } from '@/hooks/ingest/usePreparedModelFileRoute';
import { useTranslation, type TranslationKey, type TranslationParameters } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

const MAX_CAPTURE_ROWS = 200_000;
const CAPTURE_ACCEPT = '.glb,.gltf,.bin,.png,.jpg,.jpeg,.ifc,.ifczip';

type CaptureMessage =
  | { kind: 'translated'; key: TranslationKey; params?: TranslationParameters }
  | { kind: 'raw'; text: string }
  | null;

function captureMessageParams(message: Extract<CaptureMessage, { kind: 'translated' }>, locale: string): TranslationParameters | undefined {
  if (message.key !== 'appearance.capture.surfaceTooLarge' || typeof message.params?.count !== 'number') {
    return message.params;
  }
  return {
    ...message.params,
    countDisplay: formatLocaleNumber(locale, message.params.count),
  };
}

export function AppearanceCapturePanel() {
  const { t, locale, revision } = useTranslation();
  const models = useViewerStore(state => state.models), selected = useViewerStore(state => state.selectedEntityId);
  const room = useViewerStore(state => state.collabRoomId);
  const placement = useViewerStore(state => state.modelPlacement);
  const { addModel, loadFile, loadFilesSequentially, loading } = useIfc();
  const target = useIfcAuthoringTarget();
  const candidates = useMemo(() => [...models.values()].flatMap(model => (model.geometryResult?.meshes ?? [])
    .flatMap((mesh, index) => mesh.textureRef ? [{ id: `${model.id}:${index}`, modelId: model.id, mesh,
      label: t('appearance.capture.surfaceLabel', { modelName: model.name, n: formatLocaleNumber(locale, index + 1), triangleCount: formatLocaleNumber(locale, mesh.indices.length / 3) }) }] : [])), [models, t, locale, revision]);
  const excludedSurfaces = useMemo(() => [...models.values()].reduce((count, model) => count
    + (model.geometryResult?.meshes ?? []).filter(mesh => !mesh.textureRef).length, 0), [models]);
  const [chosen, setChosen] = useState('');
  const candidate = chosen ? candidates.find(item => item.id === chosen)
    : candidates.find(item => item.mesh.expressId === selected) ?? candidates[0];
  const [triangles, setTriangles] = useState<number[]>([]);
  // An over-limit surface starts with a single placeholder triangle; a user's own one-triangle region looks the same by length.
  const [placeholder, setPlaceholder] = useState(false);
  const [prepared, setPrepared] = useState<CapturedMeshSource | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [Name, setName] = useState('Captured surface');
  const [created, setCreated] = useState(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<CaptureMessage>(null), [error, setError] = useState(false);
  const setTranslatedMessage = useCallback((key: TranslationKey, params?: TranslationParameters) => {
    setMessage({ kind: 'translated', key, params });
  }, []);
  const setRawMessage = useCallback((text: string) => { setMessage({ kind: 'raw', text }); }, []);
  const operation = useRef<AbortController | null>(null);
  const scanInput = useRef<HTMLInputElement>(null);
  const routeScanFiles = useCallback((files: File[]) => {
    setTranslatedMessage('appearance.capture.loadingScan'); setError(false);
    // Bundle preparation awaits before routing, so decide from the store now:
    // a model loaded meanwhile is added to, not replaced.
    if (useViewerStore.getState().models.size === 0 && files.length === 1) void loadFile(files[0]);
    else void loadFilesSequentially(files);
  }, [loadFile, loadFilesSequentially, setTranslatedMessage]);
  const prepareAndLoadScan = usePreparedModelFileRoute(routeScanFiles);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, []);
  const [imagesSettled, setImagesSettled] = useState(0);
  useEffect(() => {
    operation.current?.abort(); setReady(false); setPrepared(null); setAssetId(null); setMessage(null); setError(false);
    setPlaceholder(false);
    if (!candidate) { setTriangles([]); return; }
    setChosen(candidate.id);
    try {
      const first = prepareCapturedRegion(candidate.modelId, candidate.mesh, [0]);
      const count = candidate.mesh.indices.length / 3;
      setAssetId(first.assetId);
      setTriangles(count <= MAX_CAPTURE_ROWS ? Array.from({ length: count }, (_, i) => i) : [0]);
      setPlaceholder(count > MAX_CAPTURE_ROWS);
      if (count > MAX_CAPTURE_ROWS) setTranslatedMessage('appearance.capture.surfaceTooLarge', { count });
    } catch (failure) {
      setTriangles([]); setRawMessage(failure instanceof Error ? failure.message : String(failure));
      // A freshly loaded scan is listed before its images settle: wait for them and prepare again.
      const decoding = modelAppearanceAssets.pendingDecode(candidate.modelId);
      setError(!decoding);
      if (!decoding) return;
      let live = true;
      void decoding.then(() => { if (live) setImagesSettled(count => count + 1); });
      return () => { live = false; };
    }
  }, [candidate?.modelId, candidate?.mesh, imagesSettled, setRawMessage, setTranslatedMessage]);
  useEffect(() => { setCreated(false); }, [candidate?.mesh, triangles]);
  useEffect(() => {
    if (operation.current || created) return;
    setPrepared(null); if (!candidate || !assetId) return;
    if (placement.preview) { setTranslatedMessage('appearance.capture.finishRepositioning'); return; }
    if (!triangles.length) { setTranslatedMessage('appearance.capture.noTriangles'); return; }
    try { setPrepared(prepareCapturedRegion(candidate.modelId,candidate.mesh,triangles)); setError(false); setTranslatedMessage(placeholder
      ? 'appearance.capture.overLimitNotice'
      : 'appearance.capture.reviewRegion'); }
    catch (failure) { setError(true); setRawMessage(failure instanceof Error ? failure.message : String(failure)); }
  }, [candidate?.modelId, candidate?.mesh, assetId, triangles, placeholder, placement, created, setRawMessage, setTranslatedMessage]);
  async function createDestination() {
    if (loading || busy) return;
    setTranslatedMessage('appearance.capture.creatingDestination'); setError(false);
    try {
      const modelId = await addModel(createBlankIfcFile({ projectName: 'Captured Surfaces' }));
      if (modelId) { target.setChosenModel(modelId); target.setChosenContainer(undefined); setTranslatedMessage('appearance.capture.destinationCreated'); }
      else { setError(true); setTranslatedMessage('appearance.capture.destinationFailed'); }
    } catch (failure) { setError(true); setRawMessage(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function create() {
    const renderer = getGlobalRenderer();
    if (!prepared || !ready || !renderer || !target.modelId || target.containerId === undefined || operation.current || room) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(false); setTranslatedMessage('appearance.capture.creatingSurface');
    try {
      const result = await createIfcFromCapturedMesh(target.modelId,target.containerId,prepared,renderer,{ Name,signal:controller.signal });
      if (controller.signal.aborted) return;
      selectCreatedAppearanceObject(target.modelId, result);
      setPrepared(null); setCreated(true);
      setTranslatedMessage('appearance.capture.surfaceCreated');
    } catch (failure) { if (!controller.signal.aborted) { setError(true); setRawMessage(failure instanceof Error ? failure.message : String(failure)); } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  return <section className="mt-4 space-y-3" aria-label={t('appearance.capture.sectionAriaLabel')} aria-busy={busy || loading}>
    <div><h2 className="text-sm font-semibold">{t('appearance.capture.heading')}</h2>
      <p className="mt-1 text-2xs text-muted-foreground">{t('appearance.capture.description')}</p></div>
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-medium">{t('appearance.capture.step1Heading')}</h3>
        <Button type="button" size="sm" variant="outline" disabled={busy || loading} onClick={() => scanInput.current?.click()}>{t('appearance.capture.addScan')}</Button></div>
      <input ref={scanInput} type="file" multiple accept={CAPTURE_ACCEPT} className="hidden" aria-label={t('appearance.capture.addScanFilesAriaLabel')} onChange={event => {
        const files = Array.from(event.target.files ?? []); if (files.length) prepareAndLoadScan(files); event.target.value = '';
      }}/>
    <label className="block text-2xs">{t('appearance.capture.sourceSurfaceLabel')}<select className={appearanceSelectClass} aria-label={t('appearance.capture.sourceSurfaceAriaLabel')} value={candidate?.id ?? ''} disabled={busy || loading}
      onChange={event => setChosen(event.target.value)}>{!candidate && <option value="">{candidates.length ? t('appearance.capture.chooseSourceSurface') : t('appearance.capture.openOrAddModel')}</option>}
      {candidates.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {!candidate && <p className="text-2xs text-muted-foreground">{t('appearance.capture.formatsNote')}</p>}
    {!candidate && excludedSurfaces > 0 && <p className="text-2xs text-muted-foreground">{t('appearance.capture.excludedSurfacesNote', {
      count: excludedSurfaces, countDisplay: formatLocaleNumber(locale, excludedSurfaces),
    })}</p>}
    {candidate && assetId && <AppearanceMeshPreview key={candidate.id} mesh={candidate.mesh} assetId={assetId} triangles={triangles} disabled={busy || loading}
      onRegion={ids => { if (ids.length > MAX_CAPTURE_ROWS) { setError(true); setTranslatedMessage('appearance.capture.regionTooLarge'); return; } setPlaceholder(false); setTriangles(ids); }}
      onReady={value => { setReady(value); if (value && !message) { setError(false); setTranslatedMessage('appearance.capture.reviewRegion'); } }} onError={text => { setReady(false); setError(true); setRawMessage(text); }} />}
    {!!assetId && <output className="block text-2xs">{t('appearance.capture.trianglesInRegion', {
      count: triangles.length, countDisplay: formatLocaleNumber(locale, triangles.length),
    })}</output>}
    </div>
    <fieldset disabled={busy || loading || !!room} className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-medium">{t('appearance.capture.step2Heading')}</h3>
        <Button type="button" size="sm" variant="outline" disabled={busy || loading || !!room} onClick={() => { void createDestination(); }}>{t('appearance.capture.newIfc4Model')}</Button></div>
      <label className="block text-2xs">{t('appearance.capture.destinationModelLabel')}<select aria-label={t('appearance.capture.destinationModelAriaLabel')} className={appearanceSelectClass} value={target.modelId}
        onChange={event => { target.setChosenModel(event.target.value); target.setChosenContainer(undefined); }}>
        {!target.eligible.length && <option value="">{t('appearance.capture.addEditableModel')}</option>}
        {target.eligible.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      <label className="block text-2xs">{t('appearance.capture.containerLabel')}<select aria-label={t('appearance.capture.containerAriaLabel')} className={appearanceSelectClass} value={target.containerId ?? ''}
        onChange={event => target.setChosenContainer(Number(event.target.value))}>
        {!target.containers.length && <option value="">{t('appearance.capture.noContainer')}</option>}
        {target.containers.map(node => <option key={node.expressId} value={node.expressId}>{node.name || t('appearance.capture.containerFallbackName', { expressId: node.expressId })}</option>)}
      </select></label>
      <label className="block text-2xs">{t('appearance.capture.nameLabel')}<Input aria-label={t('appearance.capture.nameAriaLabel')} value={Name} onChange={event => setName(event.target.value)} /></label>
      <h3 className="pt-1 text-xs font-medium">{t('appearance.capture.step3Heading')}</h3>
      <Button type="button" className="w-full" disabled={!ready || !prepared || !!placement.preview || !target.modelId || target.containerId === undefined || !Name.trim()}
        onClick={() => { void create(); }}>{t('appearance.capture.createIfcObject')}</Button>
    </fieldset>
    {room && <p className="text-2xs text-muted-foreground">{t('appearance.capture.leaveRoomNotice')}</p>}
    {busy && <Button type="button" variant="outline" onClick={() => { operation.current?.abort(); setTranslatedMessage('appearance.capture.cancelled'); }}>{t('appearance.capture.cancelCreation')}</Button>}
    {message && <p role={error ? 'alert' : 'status'} className={`text-2xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{message.kind === 'translated' ? t(message.key, captureMessageParams(message, locale)) : message.text}</p>}
  </section>;
}
