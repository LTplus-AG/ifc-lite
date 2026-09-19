/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { expandAppearanceCorners } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { appearanceOwners } from '@/lib/appearance/scope';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import type { AppearanceAssetOwner } from '@/lib/appearance/assets';
import { createAppearancePlanner } from '@/lib/appearance/planner-worker-client';
import { AppearancePreviewSession, bindAppearancePreview, type AppearancePreviewParts } from '@/lib/appearance/preview';
import { commitAppearance } from '@/lib/appearance/command';
import { prepareMeshTransfer, type ScanTransferSettings } from '@/lib/appearance/scan/prepare-transfer';
import type { MeshTransferPlan } from '@/lib/appearance/scan/transfer-types';
import type { ScanWorkflowMessage, useScanWorkbench } from './useScanWorkbench';
import { ScanValidationError, scanFailureMessage } from './scan-validation-message';

interface Draft {
  output: Awaited<ReturnType<typeof prepareMeshTransfer>>; owner: AppearanceAssetOwner;
  groups: AppearancePreviewParts[]; preview: AppearancePreviewSession | null;
}
const translated = (key: Extract<ScanWorkflowMessage, { kind: 'translated' }>['key']): ScanWorkflowMessage => ({ kind: 'translated', key });
const raw = (text: string): ScanWorkflowMessage => ({ kind: 'raw', text });
type ScanTransferWorkbench = Pick<ReturnType<typeof useScanWorkbench>, 'targetId' | 'session' | 'result' | 'stale' | 'busy' | 'applyAppearance'>;
export function useScanTransfer(work: ScanTransferWorkbench) {
  const [productIds, setProductIds] = useState<number[]>([]);
  const [settings, setSettings] = useState<ScanTransferSettings>({ toleranceMetres: 0.01, reviewed: false,
    texelsPerMetre: 256, maxDistanceMetres: 0.02, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01,
    // Point-cloud fit (#4381): 3 cm support, 4..32 neighbours, 3 mm surface band.
    neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003 });
  const [coverage, setCoverage] = useState<MeshTransferPlan['transfer'] | null>(null);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [original, setOriginal] = useState(false);
  const [status, setStatus] = useState<ScanWorkflowMessage>(() => translated('appearance.scanTransfer.status.chooseObjects')), [error, setError] = useState(false);
  const planner = useRef<ReturnType<typeof createAppearancePlanner> | null>(null);
  const operation = useRef<AbortController | null>(null), draft = useRef<Draft | null>(null), mounted = useRef(true);
  const selected = useViewerStore(state => state.selectedEntityIds), scalar = useViewerStore(state => state.selectedEntityId);
  const model = useViewerStore(state => state.models.get(work.targetId));
  const view = useViewerStore(state => state.mutationViews.get(work.targetId));
  const owners = appearanceOwners(useViewerStore.getState(), work.targetId);
  const selectedCount = owners.selectedProductIds.length;
  const targets = owners.productIds.map(id => ({ id, name: String(view?.getNewEntity(id)?.attributes[2] ?? model?.ifcDataStore?.entities.getName(id) ?? '') || `IFC object #${id}` }));
  void selected; void scalar;
  function release() {
    const current = draft.current; draft.current = null;
    if (current) try { current.preview?.cancel(); } finally { appearanceAssets.releaseOwner(current.owner); }
  }
  useEffect(() => {
    mounted.current = true; const worker = createAppearancePlanner(); planner.current = worker;
    return () => { mounted.current = false; operation.current?.abort(); worker.dispose(); release(); planner.current = null; };
  }, []);
  useEffect(() => {
    operation.current?.abort(); planner.current?.cancel(); release(); setReady(false); setOriginal(false); setCoverage(null); setBusy(false);
  }, [work.session, work.result, work.stale, settings, productIds]);
  useEffect(() => { setProductIds([]); }, [work.targetId]);
  useEffect(() => { setSettings(value => value.reviewed ? { ...value, reviewed: false } : value); }, [work.result]);
  async function preview() {
    if (!work.session || !work.result || work.stale || work.busy || !planner.current || busy) return;
    release(); const controller = new AbortController(); operation.current = controller;
    const owner: AppearanceAssetOwner = { kind: 'draft', id: crypto.randomUUID() };
    let adopted = false; setBusy(true); setReady(false); setError(false); setStatus(translated('appearance.scanTransfer.status.sampling'));
    try {
      const session = work.session, renderer = getGlobalRenderer();
      if (!renderer) throw new ScanValidationError('appearance.scanTransfer.error.viewNotReady');
      const output = await prepareMeshTransfer(session, work.result, productIds, settings, planner.current, owner, controller.signal);
      controller.signal.throwIfAborted(); session.validate();
      setCoverage(output.transfer);
      if (!output.plan || !output.transfer.applicable || !(output.transfer.coverage.observedRasterInteriorTexels > 0)) { setStatus(output.transfer.diagnostics.length ? raw(output.transfer.diagnostics.join(' ')) : translated('appearance.scanTransfer.status.noSurface')); return; }
      if (output.transfer.exclusions.length) throw new ScanValidationError('appearance.scanTransfer.error.unsupportedObjects');
      const first = output.itemImages.values().next().value;
      if (!first) throw new ScanValidationError('appearance.scanTransfer.error.noRetainedImage');
      const groups = bindAppearancePreview(useViewerStore.getState(), renderer, session.targetModelId, output.plan,
        first.bitmap, first.imageUri, false, false, expandAppearanceCorners, output.itemImages);
      const staged = new AppearancePreviewSession(renderer); staged.stage(groups);
      draft.current = { output, owner, groups, preview: staged }; adopted = true;
      setReady(true); setOriginal(false); setStatus(translated('appearance.scanTransfer.status.reviewCoverage'));
    } catch (failure) { if (!controller.signal.aborted && mounted.current) { setError(true); setStatus(scanFailureMessage(failure)); } }
    finally { if (!adopted) appearanceAssets.releaseOwner(owner); if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(false); } }
  }
  function compare() {
    const current = draft.current, renderer = getGlobalRenderer();
    if (!current || !renderer || busy || work.busy) return;
    try {
      work.session?.validate();
      if (current.preview) { current.preview.cancel(); current.preview = null; setOriginal(true); }
      else { const next = new AppearancePreviewSession(renderer); next.stage(current.groups); current.preview = next; setOriginal(false); }
    } catch (failure) { setError(true); setStatus(scanFailureMessage(failure)); setReady(false); }
  }
  async function apply() {
    const current = draft.current, session = work.session, renderer = getGlobalRenderer();
    if (!current?.output.plan || !session || !renderer || busy || work.busy || !ready) return;
    const plan = current.output.plan;
    await work.applyAppearance(async signal => {
      session.validate();
      if (!current.preview) { current.preview = new AppearancePreviewSession(renderer); current.preview.stage(current.groups); }
      await commitAppearance(session.targetModelId, current.output.assetIds, plan, renderer, current.preview, current.groups, session.appearanceSource, { signal });
      useViewerStore.getState().setActiveModel(session.targetModelId);
      current.preview = null; release(); setReady(false); setSettings(value => ({ ...value, reviewed: false }));
    });
  }
  return { productIds, setProductIds, targets, selectedCount, settings, setSettings, coverage, busy, ready, original, status, error, preview, compare, apply,
    pointSource: work.session?.source.kind === 'points',
    chooseSelection() { setProductIds(appearanceOwners(useViewerStore.getState(), work.targetId).selectedProductIds); setStatus(translated('appearance.scanTransfer.status.targetsPinned')); },
    discard() { operation.current?.abort(); planner.current?.cancel(); release(); setBusy(false); setReady(false); setOriginal(false); setCoverage(null); setStatus(translated('appearance.scanTransfer.status.discarded')); },
  };
}
