/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePdfAppearanceSource } from './usePdfAppearanceSource.js';
import { preparePdfPagePreview } from '@/lib/appearance/pdf/page-preview.js';
import { prepareAppearanceSnapshot, type AppearanceSnapshot } from '@/lib/appearance/snapshot.js';
import { expandAppearanceCorners } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets.js';
import { appearanceOwners, appearanceScope } from '@/lib/appearance/scope.js';
import { appearanceMapping, DEFAULT_APPEARANCE_SETTINGS } from '@/lib/appearance/settings.js';
import { createAppearancePlanner } from '@/lib/appearance/planner-worker-client.js';
import { AppearancePreviewSession, bindAppearancePreview, type AppearancePreviewParts } from '@/lib/appearance/preview.js';
import { appearanceRevision, captureAppearanceSource, commitAppearance } from '@/lib/appearance/command.js';
import type { AppearanceCatalog, AppearancePlan } from '@/lib/appearance/planner-types.js';
import type { AppearanceAssetOwner } from '@/lib/appearance/assets.js';
import type { AppearancePanelViewProps, AppearanceScope, AppearanceDraftSettings } from './types.js';

interface Draft {
  modelId: string;
  assetIds: string[];
  plan: AppearancePlan;
  groups: AppearancePreviewParts[];
  session: AppearancePreviewSession | null;
  owner: AppearanceAssetOwner;
  source: ReturnType<typeof captureAppearanceSource>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function discardDraft(draft: Draft | null): void {
  if (!draft) return;
  try { draft.session?.cancel(); }
  finally { appearanceAssets.releaseOwner(draft.owner); }
}

export function useAppearancePanel(): AppearancePanelViewProps {
  const models = useViewerStore(state => state.models);
  const activeModelId = useViewerStore(state => state.activeModelId);
  const mutationVersion = useViewerStore(state => state.mutationVersion);
  const selection = useViewerStore(state => state.selectedEntityIds);
  const primarySelection = useViewerStore(state => state.selectedEntityId);
  const sources = useViewerStore(state => state.appearanceSources);
  const roomId = useViewerStore(state => state.collabRoomId);
  const savedDraft = useRef(useViewerStore.getState().appearanceDraft).current;
  const canResumeModel = !savedDraft?.modelId || models.has(savedDraft.modelId);
  const [chosenModel, setChosenModel] = useState<string | null>(canResumeModel ? savedDraft?.modelId ?? null : null);
  const modelId = chosenModel && models.has(chosenModel) ? chosenModel : activeModelId;
  const [sourceId, setSourceId] = useState<string | null>(savedDraft
    ? sources.find(source => source.id === savedDraft.sourceId)?.id ?? null : sources[0]?.id ?? null);
  const [scope, setScope] = useState<AppearanceScope>(canResumeModel && savedDraft ? savedDraft.scope
    : { kind: selection.size || primarySelection !== null ? 'selection' : 'model' });
  const [settings, setSettings] = useState<AppearanceDraftSettings>({ ...(savedDraft?.settings ?? DEFAULT_APPEARANCE_SETTINGS) });
  const [status, setStatus] = useState<AppearancePanelViewProps['status']>('idle');
  const [statusMessage, setStatusMessage] = useState<string | undefined>(savedDraft && !savedDraft.previewEnabled
    ? 'Adjust the mapping to preview another appearance.' : undefined);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [showingOriginal, setShowingOriginal] = useState(false);
  const [counts, setCounts] = useState({ affected: 0, excluded: 0, reasons: [] as string[] });
  const [previewEnabled, setPreviewEnabled] = useState(canResumeModel && (savedDraft?.previewEnabled ?? true));
  const pendingAbort = useRef<AbortController | null>(null);
  const applyAbort = useRef<AbortController | null>(null);
  const appliedRevision = useRef<string | null>(null);
  const draft = useRef<Draft | null>(null);
  const planner = useRef<ReturnType<typeof createAppearancePlanner> | null>(null);
  const supported = useRef<number[]>([]);
  const snapshot = useRef<AppearanceSnapshot | null>(null);
  const [catalogState, setCatalogState] = useState<{ modelId: string; catalog: AppearanceCatalog } | null>(null);
  const mounted = useRef(true);
  const selectedSource = sources.find(source => source.id === sourceId);
  const target = models.get(modelId ?? '');
  const owners = useMemo(() => appearanceOwners(useViewerStore.getState(), modelId ?? ''),
    [models, modelId, selection, primarySelection, mutationVersion]);
  const scopeResult = appearanceScope(catalogState?.modelId === modelId ? catalogState.catalog : null, owners.selectedProductIds, scope);
  const unavailableReason = roomId ? 'Leave the shared room to edit appearance, then share the finished model.'
    : !target?.ifcDataStore ? 'Open an IFC model to apply appearance.'
    : target.schemaVersion === 'IFC2X3' || target.schemaVersion === 'IFC5' ? 'Appearance authoring currently needs an IFC4 or IFC4X3 model.'
    : target.loadState && target.loadState !== 'complete' ? 'Wait for the model to finish loading.' : undefined;

  const pdfSource = usePdfAppearanceSource(selectedSource, id => {
    setSourceId(id); setSettings(current => ({ ...current, kind: 'planar', repeatS: false, repeatT: false }));
    setPreviewEnabled(true);
  }, error => {
    pendingAbort.current?.abort(); planner.current?.cancel();
    setStatus('error'); setStatusMessage(message(error));
  });

  useEffect(() => {
    useViewerStore.getState().saveAppearanceDraft({ modelId, sourceId, scope, settings, previewEnabled });
  }, [modelId, sourceId, scope, settings, previewEnabled]);

  useEffect(() => {
    mounted.current = true;
    const ownedPlanner = createAppearancePlanner();
    planner.current = ownedPlanner;
    return () => {
      mounted.current = false;
      applyAbort.current?.abort();
      ownedPlanner.dispose();
      snapshot.current = null;
      if (planner.current === ownedPlanner) planner.current = null;
      const previous = draft.current; draft.current = null;
      discardDraft(previous);
    };
  }, []);

  useEffect(() => {
    if (!modelId || unavailableReason) {
      const previous = draft.current; draft.current = null;
      discardDraft(previous);
      snapshot.current = null; setCatalogState(null);
      setStatus('idle');
      setCounts({ affected: 0, excluded: 0, reasons: [] });
      setStatusMessage(undefined);
      return;
    }
    if (!previewEnabled || !sourceId) {
      const previous = draft.current; draft.current = null; discardDraft(previous);
    }
    const controller = new AbortController();
    pendingAbort.current = controller;
    const revision = appearanceRevision(modelId);
    if (draft.current && draft.current.plan.sourceRevision !== revision) {
      const previous = draft.current; draft.current = null; discardDraft(previous);
    }
    const owner: AppearanceAssetOwner = { kind: 'draft', id: crypto.randomUUID() };
    let adopted = false;
    supported.current = [];
    setCounts({ affected: 0, excluded: 0, reasons: [] });
    setStatus('preparing'); setStatusMessage(previewEnabled && sourceId ? 'Preparing appearance preview…' : 'Preparing model scope…');
    const timer = setTimeout(() => { void (async () => {
      try {
        const worker = planner.current;
        if (!worker) throw new Error('The appearance worker is unavailable.');
        const currentSnapshot = await prepareAppearanceSnapshot(snapshot.current, modelId, owners.productIds, worker, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        snapshot.current = currentSnapshot;
        setCatalogState({ modelId, catalog: currentSnapshot.catalog });
        if (!previewEnabled || !sourceId) {
          setCounts({ affected: 0, excluded: 0, reasons: [] });
          setStatus('idle');
          setStatusMessage(!sourceId ? undefined : appliedRevision.current
            ? appliedRevision.current === currentSnapshot.revision ? 'Appearance applied. Undo is available.'
              : 'Model updated. Adjust the mapping to preview again.'
            : 'Preview discarded. Adjust the mapping to preview again.');
          return;
        }
        const currentScope = appearanceScope(currentSnapshot.catalog, owners.selectedProductIds, scope);
        if (!currentScope.productIds.length) throw new Error('Choose a scope containing model surfaces.');
        const renderer = getGlobalRenderer();
        if (!renderer) throw new Error('The renderer is not ready to preview appearance.');
        const { source, schema, nextExpressId, bytes } = currentSnapshot;
        const assetId = selectedSource?.assetId ?? sourceId;
        const page = selectedSource?.pdf ? await preparePdfPagePreview({ snapshot: currentSnapshot,
          productIds: currentScope.productIds, source: selectedSource, settings, planner: worker, owner, signal: controller.signal }) : undefined;
        const firstPageImage = page?.itemImages.values().next().value;
        const imageUri = page ? firstPageImage?.imageUri ?? '' : modelAppearanceAssets.getAuthoredUri(modelId, assetId);
        if (!page) appearanceAssets.retain(assetId, owner);
        const bitmap = page ? firstPageImage?.bitmap : await appearanceAssets.decode(assetId, owner, controller.signal);
        currentSnapshot.validate();
        const plan = page?.plan ?? await worker.plan(bytes, { schema, sourceRevision: currentSnapshot.revision, nextExpressId,
          productIds: currentScope.productIds, imageUri, repeatS: settings.repeatS,
          repeatT: settings.repeatT, mapping: appearanceMapping(settings) }, { signal: controller.signal });
        if (controller.signal.aborted || !mounted.current) return;
        currentSnapshot.validate();
        const state = useViewerStore.getState();
        if (!plan.items.length) throw new Error(plan.exclusions[0]?.reason ?? 'No surfaces in this scope support the chosen mapping.');
        // Exclusions must be acknowledged explicitly before the narrower scope applies.
        supported.current = [...new Set(plan.items.map(item => item.productId))];
        if (plan.exclusions.length) {
          setCounts({ affected: new Set(plan.items.map(item => item.productId)).size,
            excluded: plan.exclusions.length, reasons: [...new Set(plan.exclusions.map(item => item.reason))] });
          throw new Error('Some objects cannot receive this appearance. Use the supported objects to continue.');
        }
        const previous = draft.current; draft.current = null;
        discardDraft(previous);
        if (!bitmap) throw new Error('The projected surfaces have no image.');
        const groups = bindAppearancePreview(state, renderer, modelId, plan, bitmap, imageUri,
          settings.repeatS, settings.repeatT, expandAppearanceCorners, page?.itemImages);
        const session = new AppearancePreviewSession(renderer);
        session.stage(groups);
        draft.current = { modelId, assetIds: page?.assetIds ?? [assetId], plan, groups, session, owner, source };
        adopted = true;
        setCounts({ affected: groups.length, excluded: 0, reasons: [] });
        setShowingOriginal(false); setStatus('ready'); setStatusMessage('Preview ready. Apply to save this appearance in the IFC model.');
      } catch (error) {
        if (!controller.signal.aborted && mounted.current) { setStatus('error'); setStatusMessage(message(error)); }
      } finally { if (!adopted) appearanceAssets.releaseOwner(owner); }
    })(); }, 250);
    return () => { clearTimeout(timer); controller.abort(); applyAbort.current?.abort(); if (!adopted) appearanceAssets.releaseOwner(owner); };
  }, [modelId, sourceId, selectedSource, settings, owners, scope, unavailableReason, mutationVersion, previewEnabled]);

  async function upload(file: File): Promise<void> {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) { await pdfSource.upload(file); return; }
    pdfSource.cancel();
    const uploadOwner: AppearanceAssetOwner = { kind: 'draft', id: crypto.randomUUID() };
    let assetId: string | undefined;
    let sourceOwner: AppearanceAssetOwner | undefined;
    let url: string | undefined;
    setSourceBusy(true);
    try {
      const asset = await appearanceAssets.add(file, { owner: uploadOwner });
      assetId = asset.id;
      if (!useViewerStore.getState().appearanceSources.some(source => source.id === asset.id)) {
        url = URL.createObjectURL(new Blob([appearanceAssets.encoded(asset.id)], { type: asset.mimeType }));
        sourceOwner = { kind: 'source', id: `appearance:${asset.id}` };
        appearanceAssets.retain(asset.id, sourceOwner);
        useViewerStore.getState().addAppearanceSource({ id: asset.id, name: file.name,
          width: asset.width, height: asset.height, thumbnailUrl: url });
      }
      if (mounted.current) { setSourceId(asset.id); setPreviewEnabled(true); }
    } catch (error) {
      if (mounted.current) {
        // An older scope/preview job must not overwrite the upload failure with
        // its later success message. Keep the previous committed appearance.
        pendingAbort.current?.abort(); planner.current?.cancel();
        setStatus('error'); setStatusMessage(message(error));
      }
    } finally {
      // A subscriber may throw after publication; the catalog still owns that
      // image. Only provisional resources that were never adopted are released.
      const adopted = useViewerStore.getState().appearanceSources.find(source => source.id === assetId);
      if (sourceOwner && !adopted) appearanceAssets.releaseOwner(sourceOwner);
      appearanceAssets.releaseOwner(uploadOwner);
      if (url && adopted?.thumbnailUrl !== url) URL.revokeObjectURL(url);
      if (mounted.current) setSourceBusy(false);
    }
  }
  function discard(): void {
    pdfSource.cancel();
    applyAbort.current?.abort();
    appliedRevision.current = null;
    pendingAbort.current?.abort();
    planner.current?.cancel();
    setPreviewEnabled(false);
    const previous = draft.current; draft.current = null;
    discardDraft(previous);
    setShowingOriginal(false); setStatus('idle'); setStatusMessage('Preview discarded.');
  }
  function compare(original: boolean): void {
    const current = draft.current;
    const renderer = getGlobalRenderer();
    if (!current || !renderer) return;
    try {
      if (original) { current.session?.cancel(); current.session = null; }
      else { const session = new AppearancePreviewSession(renderer); session.stage(current.groups); current.session = session; }
      setShowingOriginal(original);
    } catch (error) { setStatus('error'); setStatusMessage(message(error)); }
  }
  async function apply(): Promise<void> {
    const current = draft.current;
    const renderer = getGlobalRenderer();
    if (!current?.session || !renderer || status !== 'ready') return;
    const controller = new AbortController(); applyAbort.current = controller;
    setStatus('applying');
    try {
      await commitAppearance(current.modelId, current.assetIds, current.plan, renderer, current.session, current.groups, current.source, {
        signal: controller.signal,
        onProgress: phase => { if (mounted.current) setStatusMessage(phase === 'preparing' ? 'Preparing IFC changes…' : 'Saving appearance…'); },
      });
      setPreviewEnabled(false);
      appliedRevision.current = appearanceRevision(current.modelId);
      draft.current = null;
      appearanceAssets.releaseOwner(current.owner);
      setStatus('idle'); setStatusMessage('Appearance applied. Undo is available.');
    } catch (error) { if (mounted.current && !controller.signal.aborted) { setStatus('error'); setStatusMessage(message(error)); } }
    finally { if (applyAbort.current === controller) applyAbort.current = null; }
  }
  return {
    allowPdf: true, pdf: pdfSource.controls, pdfPassword: pdfSource.passwordPrompt,
    calibration: selectedSource?.pdf && selectedSource.thumbnailUrl ? {
      recipe: selectedSource.pdf.recipe, thumbnailUrl: selectedSource.thumbnailUrl,
      value: selectedSource.pdf.calibration, onChange: calibration => {
        const current = useViewerStore.getState().appearanceSources.find(source => source.id === selectedSource.id);
        if (current?.pdf) useViewerStore.getState().updateAppearanceSource({ ...current, pdf: { ...current.pdf, calibration } });
        setPreviewEnabled(true);
      },
    } : undefined,
    models: [...models.values()].map(model => ({ id: model.id, name: model.name })), modelId,
    onModelChange: id => { setChosenModel(id); setPreviewEnabled(true); }, sources, sourceId,
    onSourceChange: id => {
      pdfSource.cancel(); setSourceId(id);
      if (sources.find(source => source.id === id)?.pdf) setSettings(current => ({ ...current, kind: 'planar', repeatS: false, repeatT: false }));
      setPreviewEnabled(true);
    },
    onRemoveSource: id => { pdfSource.cancel(); if (sourceId === id) { discard(); setSourceId(null); } useViewerStore.getState().removeAppearanceSource(id); },
    onUpload: file => { void upload(file); }, sourceBusy: sourceBusy || pdfSource.busy, scope, onScopeChange: value => { setScope(value); setPreviewEnabled(true); },
    classes: scopeResult.classes, types: scopeResult.types, selectionCount: scopeResult.selectionCount,
    onUseSupported: () => {
      if (!modelId || !supported.current.length) return;
      const state = useViewerStore.getState();
      state.setSelectedEntityIds(supported.current.map(id => state.toGlobalId(modelId, id)));
      setScope({ kind: 'selection' }); setPreviewEnabled(true);
    },
    affectedCount: counts.affected, excludedCount: counts.excluded, exclusions: counts.reasons,
    settings, onSettingsChange: patch => { setSettings(current => ({ ...current, ...patch })); setPreviewEnabled(true); },
    status, statusMessage, unavailableReason, canApply: status === 'ready' && !!draft.current?.session,
    canDiscard: !!draft.current || status === 'preparing' || pdfSource.busy || !!pdfSource.passwordPrompt, hasPreview: !!draft.current,
    showingOriginal, onCompareChange: compare, onApply: () => { void apply(); }, onDiscard: discard,
  };
}
