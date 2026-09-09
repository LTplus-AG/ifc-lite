/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { selectCreatedAppearanceObject } from './select-created-object';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { prepareCapturedRegion } from '@/lib/appearance/capture/source';
import { createIfcFromCapturedMesh, type CapturedMeshSource } from '@/lib/appearance/create-captured-mesh';
import { useIfcAuthoringTarget } from './useIfcAuthoringTarget';
import { CapturePreview } from './CapturePreview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { appearanceSelectClass } from './AppearanceSourceFields';

export function AppearanceCapturePanel() {
  const models = useViewerStore(state => state.models), selected = useViewerStore(state => state.selectedEntityId);
  const room = useViewerStore(state => state.collabRoomId);
  const placement = useViewerStore(state => state.modelPlacement), mutationVersion = useViewerStore(state => state.mutationVersion);
  const target = useIfcAuthoringTarget();
  const candidates = useMemo(() => [...models.values()].flatMap(model => (model.geometryResult?.meshes ?? [])
    .flatMap((mesh, index) => mesh.textureRef ? [{ id: `${model.id}:${index}`, modelId: model.id, mesh,
      label: `${model.name} · Surface ${index + 1} · ${(mesh.indices.length / 3).toLocaleString()} triangles` }] : [])), [models]);
  const [chosen, setChosen] = useState('');
  const candidate = chosen ? candidates.find(item => item.id === chosen)
    : candidates.find(item => item.mesh.expressId === selected) ?? candidates[0];
  const [triangles, setTriangles] = useState<number[]>([]);
  const [prepared, setPrepared] = useState<CapturedMeshSource | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [Name, setName] = useState('Captured surface');
  const [created, setCreated] = useState(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, []);
  useEffect(() => {
    operation.current?.abort(); setReady(false); setPrepared(null); setAssetId(null); setMessage(''); setError(false);
    if (!candidate) { setTriangles([]); return; }
    setChosen(candidate.id);
    if (candidate.mesh.indices.length / 3 > 200_000) { setError(true); setMessage('Choose a source surface with at most 200000 triangles.'); setTriangles([]); return; }
    try {
      const first = prepareCapturedRegion(candidate.modelId, candidate.mesh, [0]);
      setAssetId(first.assetId); setTriangles(Array.from({ length: candidate.mesh.indices.length / 3 }, (_, i) => i));
    } catch (failure) { setTriangles([]); setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
  }, [candidate?.modelId, candidate?.mesh]);
  useEffect(() => { setCreated(false); }, [candidate?.mesh, triangles]);
  useEffect(() => {
    if (operation.current || created) return;
    setPrepared(null); if (!candidate || !assetId) return;
    if (placement.preview) { setMessage('Finish repositioning the model to create this region.'); return; }
    if (!triangles.length) { setMessage('The rectangle contains no triangle centres. Choose another region or Entire surface.'); return; }
    try { setPrepared(prepareCapturedRegion(candidate.modelId,candidate.mesh,triangles)); setError(false); setMessage('Review the textured region, then choose where to create it.'); }
    catch (failure) { setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
  }, [candidate?.modelId, candidate?.mesh, assetId, triangles, placement, mutationVersion, created]);
  async function create() {
    const renderer = getGlobalRenderer();
    if (!prepared || !ready || !renderer || !target.modelId || target.containerId === undefined || operation.current || room) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(false); setMessage('Creating textured IFC surface…');
    try {
      const result = await createIfcFromCapturedMesh(target.modelId,target.containerId,prepared,renderer,{ Name,signal:controller.signal });
      if (controller.signal.aborted) return;
      selectCreatedAppearanceObject(target.modelId, result);
      setPrepared(null); setCreated(true);
      setMessage('Textured IfcBuildingElementProxy created and selected. Undo is available.');
    } catch (failure) { if (!controller.signal.aborted) { setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  return <section className="mt-4 space-y-3" aria-label="Create from scan" aria-busy={busy}>
    <h2 className="text-sm font-semibold">Create from scan</h2>
    <p className="text-[11px] text-muted-foreground">Turn a selected scan surface into a textured IFC object. Open or add a textured GLB to begin.</p>
    <label className="block text-[11px]">Source surface<select className={appearanceSelectClass} aria-label="Captured source surface" value={candidate?.id ?? ''} disabled={busy}
      onChange={event => setChosen(event.target.value)}>{!candidate && <option value="">{candidates.length ? 'Choose a source surface' : 'Open or add a textured model'}</option>}
      {candidates.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {candidate && assetId && <CapturePreview key={candidate.id} mesh={candidate.mesh} assetId={assetId} triangles={triangles} disabled={busy}
      onRegion={setTriangles} onReady={value => { setReady(value); if (value) { setError(false); setMessage('Review the textured region, then choose where to create it.'); } }} onError={text => { setReady(false); setError(true); setMessage(text); }} />}
    {!!assetId && <p className="text-[11px]" role="status">{triangles.length.toLocaleString()} triangles in this region</p>}
    <fieldset disabled={busy || !!room} className="space-y-2">
      <label className="block text-[11px]">Destination model<select aria-label="Capture destination model" className={appearanceSelectClass} value={target.modelId}
        onChange={event => { target.setChosenModel(event.target.value); target.setChosenContainer(undefined); }}>
        {!target.eligible.length && <option value="">Add an editable IFC4 model</option>}
        {target.eligible.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      <label className="block text-[11px]">Container<select aria-label="Capture container" className={appearanceSelectClass} value={target.containerId ?? ''}
        onChange={event => target.setChosenContainer(Number(event.target.value))}>
        {!target.containers.length && <option value="">No spatial container available</option>}
        {target.containers.map(node => <option key={node.expressId} value={node.expressId}>{node.name || `#${node.expressId}`}</option>)}
      </select></label>
      <label className="block text-[11px]">Name<Input aria-label="Captured object Name" value={Name} onChange={event => setName(event.target.value)} /></label>
      <Button type="button" className="w-full" disabled={!ready || !prepared || !!placement.preview || !target.modelId || target.containerId === undefined || !Name.trim()}
        onClick={() => { void create(); }}>Create IFC object</Button>
    </fieldset>
    {room && <p className="text-[11px] text-muted-foreground">Leave the shared room to create captured objects, then share the saved model.</p>}
    {busy && <Button type="button" variant="outline" onClick={() => { operation.current?.abort(); setMessage('Creation cancelled.'); }}>Cancel creation</Button>}
    {message && <p role={error ? 'alert' : 'status'} className={`text-[11px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>}
  </section>;
}
