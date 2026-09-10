/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Renderer, Raycaster, type Intersection } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { Button } from '@/components/ui/button';
import { capturedScreenRegion } from './capture-screen-region';

const NO_PARTS: readonly MeshData[] = [];
const NO_MARKERS: { id: string; point: { x: number; y: number; z: number }; check?: boolean }[] = [];

/** A local renderer borrows the retained image. It never installs a global
 * renderer, changes the main camera, or publishes a model/IFC owner. */
export function AppearanceMeshPreview({ mesh, assetId, additionalMeshes = NO_PARTS, initialPlane, triangles, disabled, onRegion, onReady, onError, onLandmark, markers = NO_MARKERS, regionControls = true, instruction, canvasLabel }: {
  mesh: MeshData; assetId?: string; additionalMeshes?: readonly MeshData[]; triangles: readonly number[]; disabled: boolean;
  onRegion(ids: number[]): void; onReady(ready: boolean): void; onError(message: string): void;
  onLandmark?(hit: Intersection): void; markers?: { id: string; point: { x: number; y: number; z: number }; check?: boolean }[];
  initialPlane?: { normal: readonly [number, number, number]; up: readonly [number, number, number] };
  regionControls?: boolean; instruction?: string; canvasLabel?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<Renderer | null>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const failure = useRef<((message: string) => void) | null>(null);
  const callbacks = useRef({ onRegion, onReady, onError, onLandmark }); callbacks.current = { onRegion, onReady, onError, onLandmark };
  const markerRef = useRef(markers); markerRef.current = markers;
  const [projected, setProjected] = useState<{ id: string; x: number; y: number; check?: boolean }[]>([]);
  function projectMarkers(view: Renderer) {
    const element = canvas.current; if (!element) return;
    const next = markerRef.current.flatMap(marker => { const p = view.getCamera().projectToScreen(marker.point, element.getBoundingClientRect().width, element.getBoundingClientRect().height); return p ? [{ id: marker.id, check: marker.check, x: p.x, y: p.y }] : []; });
    setProjected(previous => previous.length === next.length && previous.every((p, i) => p.id === next[i].id && p.x === next[i].x && p.y === next[i].y && p.check === next[i].check) ? previous : next);
  }
  const region = useRef(triangles); region.current = triangles;
  const blocked = useRef(disabled); blocked.current = disabled;
  const [generation, setGeneration] = useState(0), [failed, setFailed] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const gesture = useRef<{ start: { x: number; y: number }; last: { x: number; y: number }; pointer: number } | null>(null);
  function draw() {
    const view = renderer.current, image = bitmap.current;
    if (!view || (assetId && !image)) return false;
    try {
    view.getScene().clear();
    const visible = selecting ? Array.from({ length: mesh.indices.length / 3 }, (_, i) => i) : region.current;
    const base = mesh.origin ?? [0, 0, 0];
    const parts: MeshData[] = visible.length ? [{ ...mesh, origin: [0,0,0], textureBitmap: image ?? undefined,
      indices: Uint32Array.from(visible.flatMap(id => [mesh.indices[id * 3], mesh.indices[id * 3 + 1], mesh.indices[id * 3 + 2]])) }] : [];
    for (const part of additionalMeshes) parts.push({ ...part, origin: [
      (part.origin?.[0] ?? 0) - base[0], (part.origin?.[1] ?? 0) - base[1], (part.origin?.[2] ?? 0) - base[2]] });
    if (parts.length) view.loadGeometry(parts);
    view.render(); projectMarkers(view); return true;
    } catch (error) { failure.current?.(error instanceof Error ? error.message : String(error)); return false; }
  }
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const controller = new AbortController(), view = new Renderer(element);
    const owner = { kind: 'draft' as const, id: `capture-preview:${crypto.randomUUID()}` };
    let frame = 0, observer: ResizeObserver | undefined;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if (!blocked.current && renderer.current === view) { view.getCamera().zoom(event.deltaY); view.requestRender(); } };
    element.addEventListener('wheel', wheel, { passive: false });
    setFailed(false); callbacks.current.onReady(false);
    const fail = (message: string) => {
      if (controller.signal.aborted) return; controller.abort(); cancelAnimationFrame(frame);
      setFailed(true); callbacks.current.onReady(false); callbacks.current.onError(message);
      observer?.disconnect();
      if (renderer.current === view) { renderer.current = null; bitmap.current = null; }
      view.destroy(); appearanceAssets.releaseOwner(owner);
    };
    failure.current = fail;
    const unsubscribeLoss = view.onDeviceLost(() => fail('The preview graphics connection was lost. Reload the preview to continue.'));
    void (async () => {
      try {
        if ((!assetId && mesh.textureRef) || additionalMeshes.some(part => part.textureRef)) throw new Error('The preview is missing a retained image for its textured geometry.');
        if (assetId) appearanceAssets.retain(assetId, owner);
        const image = assetId ? await appearanceAssets.decode(assetId, owner, controller.signal) : null;
        await view.init(); controller.signal.throwIfAborted();
        renderer.current = view; bitmap.current = image;
        const resize = () => { view.resize(element.clientWidth, element.clientHeight); view.requestRender(); };
        observer = new ResizeObserver(resize); observer.observe(element); resize();
        if (!draw()) { view.destroy(); appearanceAssets.releaseOwner(owner); return; } view.fitToView();
        if (initialPlane) {
          const camera = view.getCamera(), target = camera.getTarget(), distance = camera.getDistance();
          camera.setUp(...initialPlane.up);
          camera.setPosition(target.x + initialPlane.normal[0] * distance, target.y + initialPlane.normal[1] * distance, target.z + initialPlane.normal[2] * distance);
        }
        view.requestRender();
        const tick = () => { if (controller.signal.aborted) return; try { if (view.consumeRenderRequest()) { view.render(); projectMarkers(view); } frame = requestAnimationFrame(tick); } catch (error) { fail(error instanceof Error ? error.message : String(error)); } };
        frame = requestAnimationFrame(tick); callbacks.current.onReady(true);
      } catch (error) {
        if (!controller.signal.aborted) { setFailed(true); callbacks.current.onError(error instanceof Error ? error.message : String(error)); }
        view.destroy(); appearanceAssets.releaseOwner(owner);
      }
    })();
    return () => {
      controller.abort(); cancelAnimationFrame(frame); observer?.disconnect(); unsubscribeLoss(); element.removeEventListener('wheel', wheel);
      if (failure.current === fail) failure.current = null;
      view.destroy(); if (renderer.current === view) { renderer.current = null; bitmap.current = null; }
      appearanceAssets.releaseOwner(owner); callbacks.current.onReady(false);
    };
  }, [mesh, assetId, additionalMeshes, initialPlane, generation]);
  useEffect(() => { draw(); }, [triangles, selecting]);
  useEffect(() => { renderer.current?.requestRender(); }, [markers]);
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  return <div className="space-y-2">
    {failed && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setGeneration(value => value + 1)}>Reload preview</Button>}
    {regionControls && <div className="flex gap-2"><Button type="button" size="sm" variant={selecting ? 'secondary' : 'outline'} aria-pressed={selecting}
      disabled={disabled} onClick={() => { setSelecting(value => !value); setBox(null); }}>Select region</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onRegion(Array.from({ length: mesh.indices.length / 3 }, (_, i) => i))}>Entire surface</Button></div>}
    <div className="relative overflow-hidden rounded border">
      <canvas ref={canvas} aria-label={canvasLabel ?? "Captured surface preview"} className="h-64 w-full touch-none" onContextMenu={event => event.preventDefault()}
        onPointerDown={event => { if (!event.isPrimary || disabled || !renderer.current) return; const p = point(event); gesture.current = { start: p, last: p, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          const current = gesture.current, view = renderer.current; if (!current || current.pointer !== event.pointerId || !view || disabled) return;
          const p = point(event);
          if (selecting) setBox({ x: Math.min(p.x,current.start.x), y: Math.min(p.y,current.start.y), width: Math.abs(p.x-current.start.x), height: Math.abs(p.y-current.start.y) });
          else { view.getCamera().orbit(p.x-current.last.x,p.y-current.last.y); view.requestRender(); }
          current.last = p;
        }}
        onPointerUp={event => {
          const current = gesture.current, view = renderer.current;
          if (!current || current.pointer !== event.pointerId || !view || disabled) return;
          gesture.current = null; setBox(null);
          if (!selecting && callbacks.current.onLandmark && Math.hypot(point(event).x - current.start.x, point(event).y - current.start.y) < 4) { const p = point(event); const element = event.currentTarget; const ray = view.getCamera().unprojectToRay(p.x * element.width / element.getBoundingClientRect().width, p.y * element.height / element.getBoundingClientRect().height, element.width, element.height); const hit = new Raycaster().raycast(ray, [{ ...mesh, origin: [0,0,0] }]); if (hit) callbacks.current.onLandmark(hit); }
          if (selecting) { const size = event.currentTarget; onRegion(capturedScreenRegion(mesh,current.start,point(event), p => view.getCamera().projectToScreen(p,size.clientWidth,size.clientHeight))); setSelecting(false); }
        }} onPointerCancel={() => { gesture.current = null; setBox(null); }}
 />
      {projected.map(marker => <span key={marker.id} className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border px-1 text-[10px] font-bold shadow ${marker.check ? 'bg-amber-100 text-amber-950' : 'bg-primary text-primary-foreground'}`} style={{ left: marker.x, top: marker.y }}>{marker.id}</span>)}
      {box && <div className="pointer-events-none absolute border border-primary bg-primary/15" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
    </div>
    <p className="text-[11px] text-muted-foreground">{instruction ?? (selecting ? 'Drag a rectangle. Whole triangles are selected by their centres, through the surface.' : 'Drag to orbit. Scroll to zoom. Select region to keep part of this surface.')}</p>
  </div>;
}
