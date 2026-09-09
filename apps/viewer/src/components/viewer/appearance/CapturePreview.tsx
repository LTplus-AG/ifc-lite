/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { Button } from '@/components/ui/button';
import { capturedScreenRegion } from './capture-screen-region';

/** A local renderer borrows the retained image. It never installs a global
 * renderer, changes the main camera, or publishes a model/IFC owner. */
export function CapturePreview({ mesh, assetId, triangles, disabled, onRegion, onReady, onError }: {
  mesh: MeshData; assetId: string; triangles: readonly number[]; disabled: boolean;
  onRegion(ids: number[]): void; onReady(ready: boolean): void; onError(message: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<Renderer | null>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const callbacks = useRef({ onRegion, onReady, onError }); callbacks.current = { onRegion, onReady, onError };
  const region = useRef(triangles); region.current = triangles;
  const blocked = useRef(disabled); blocked.current = disabled;
  const [selecting, setSelecting] = useState(false);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const gesture = useRef<{ start: { x: number; y: number }; last: { x: number; y: number }; pointer: number } | null>(null);
  function draw() {
    const view = renderer.current, image = bitmap.current;
    if (!view || !image) return false;
    try {
    view.getScene().clear();
    if (region.current.length) view.loadGeometry([{ ...mesh, origin: [0,0,0], textureBitmap: image,
      indices: Uint32Array.from(region.current.flatMap(id => [mesh.indices[id * 3], mesh.indices[id * 3 + 1], mesh.indices[id * 3 + 2]])) }]);
    view.render(); return true;
    } catch (error) { callbacks.current.onReady(false); callbacks.current.onError(error instanceof Error ? error.message : String(error)); return false; }
  }
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const controller = new AbortController(), view = new Renderer(element);
    const owner = { kind: 'draft' as const, id: `capture-preview:${crypto.randomUUID()}` };
    let frame = 0, observer: ResizeObserver | undefined;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if (!blocked.current && renderer.current === view) { view.getCamera().zoom(event.deltaY); view.requestRender(); } };
    element.addEventListener('wheel', wheel, { passive: false });
    callbacks.current.onReady(false);
    void (async () => {
      try {
        appearanceAssets.retain(assetId, owner);
        const image = await appearanceAssets.decode(assetId, owner, controller.signal);
        await view.init(); controller.signal.throwIfAborted();
        renderer.current = view; bitmap.current = image;
        const resize = () => { view.resize(element.clientWidth, element.clientHeight); view.requestRender(); };
        observer = new ResizeObserver(resize); observer.observe(element); resize();
        if (!draw()) return; view.fitToView(); view.requestRender();
        const tick = () => { if (controller.signal.aborted) return; if (view.consumeRenderRequest()) view.render(); frame = requestAnimationFrame(tick); };
        frame = requestAnimationFrame(tick); callbacks.current.onReady(true);
      } catch (error) {
        if (!controller.signal.aborted) callbacks.current.onError(error instanceof Error ? error.message : String(error));
        view.destroy(); appearanceAssets.releaseOwner(owner);
      }
    })();
    return () => {
      controller.abort(); cancelAnimationFrame(frame); observer?.disconnect(); element.removeEventListener('wheel', wheel);
      view.destroy(); if (renderer.current === view) { renderer.current = null; bitmap.current = null; }
      appearanceAssets.releaseOwner(owner); callbacks.current.onReady(false);
    };
  }, [mesh, assetId]);
  useEffect(() => { draw(); }, [triangles]);
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  return <div className="space-y-2">
    <div className="flex gap-2"><Button type="button" size="sm" variant={selecting ? 'secondary' : 'outline'} aria-pressed={selecting}
      disabled={disabled} onClick={() => { setSelecting(value => !value); setBox(null); }}>Select region</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onRegion(Array.from({ length: mesh.indices.length / 3 }, (_, i) => i))}>Entire surface</Button></div>
    <div className="relative overflow-hidden rounded border">
      <canvas ref={canvas} aria-label="Captured surface preview" className="h-64 w-full touch-none" onContextMenu={event => event.preventDefault()}
        onPointerDown={event => { if (!event.isPrimary || disabled || !renderer.current) return; const p = point(event); gesture.current = { start: p, last: p, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          const current = gesture.current, view = renderer.current; if (!current || current.pointer !== event.pointerId || !view || disabled) return;
          const p = point(event);
          if (selecting) setBox({ x: Math.min(p.x,current.start.x), y: Math.min(p.y,current.start.y), width: Math.abs(p.x-current.start.x), height: Math.abs(p.y-current.start.y) });
          else { view.getCamera().orbit(p.x-current.last.x,p.y-current.last.y); view.requestRender(); }
          current.last = p;
        }}
        onPointerUp={event => {
          const current = gesture.current, view = renderer.current; gesture.current = null; setBox(null);
          if (!current || current.pointer !== event.pointerId || !view || disabled) return;
          if (selecting) { const size = event.currentTarget; onRegion(capturedScreenRegion(mesh,current.start,point(event), p => view.getCamera().projectToScreen(p,size.clientWidth,size.clientHeight))); setSelecting(false); }
        }} onPointerCancel={() => { gesture.current = null; setBox(null); }}
 />
      {box && <div className="pointer-events-none absolute border border-primary bg-primary/15" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
    </div>
    <p className="text-[11px] text-muted-foreground">{selecting ? 'Drag a rectangle. Whole triangles are selected by their centres, through the surface.' : 'Drag to orbit. Scroll to zoom. Select region to keep part of this surface.'}</p>
  </div>;
}
