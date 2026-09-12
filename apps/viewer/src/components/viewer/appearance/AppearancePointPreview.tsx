/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { Button } from '@/components/ui/button';
import { pickScanPoint, type ScanPointSource } from '@/lib/appearance/scan/point-source';

export interface PreviewMarker { id: string; point: { x: number; y: number; z: number }; check?: boolean }
const NO_MARKERS: PreviewMarker[] = [];
/** Screen-space pick radius in CSS pixels; a scan point has no larger target zone than itself. */
const PICK_TOLERANCE_PX = 8;

/** A local renderer shows the retained point sample (never the streamed GPU
 * asset of the main view) and resolves a click to one retained point index.
 * It never installs a global renderer, moves the main camera or publishes a model. */
export function AppearancePointPreview({ source, positions, disabled, onReady, onError, onLandmark, markers = NO_MARKERS, instruction, canvasLabel }: {
  source: ScanPointSource;
  /** Preview-frame positions to show: the sample as retained, or its aligned copy. */
  positions: Float32Array; disabled: boolean;
  onReady(ready: boolean): void; onError(message: string): void; onLandmark?(index: number): void;
  markers?: PreviewMarker[]; instruction?: string; canvasLabel?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<Renderer | null>(null);
  const failure = useRef<((message: string) => void) | null>(null);
  const callbacks = useRef({ onReady, onError, onLandmark }); callbacks.current = { onReady, onError, onLandmark };
  const markerRef = useRef(markers); markerRef.current = markers;
  const blocked = useRef(disabled); blocked.current = disabled;
  const [projected, setProjected] = useState<{ id: string; x: number; y: number; check?: boolean }[]>([]);
  const [generation, setGeneration] = useState(0), [failed, setFailed] = useState(false);
  const gesture = useRef<{ start: { x: number; y: number }; last: { x: number; y: number }; pointer: number } | null>(null);
  const colors = useMemo(() => Float32Array.from(source.colors, byte => byte / 255), [source]);
  function projectMarkers(view: Renderer) {
    const element = canvas.current; if (!element) return;
    const rect = element.getBoundingClientRect();
    const next = markerRef.current.flatMap(marker => { const p = view.getCamera().projectToScreen(marker.point, rect.width, rect.height); return p ? [{ id: marker.id, check: marker.check, x: p.x, y: p.y }] : []; });
    setProjected(previous => previous.length === next.length && previous.every((p, i) => p.id === next[i].id && p.x === next[i].x && p.y === next[i].y && p.check === next[i].check) ? previous : next);
  }
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const controller = new AbortController(), view = new Renderer(element);
    let frame = 0, observer: ResizeObserver | undefined;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if (!blocked.current && renderer.current === view) { view.getCamera().zoom(event.deltaY); view.requestRender(); } };
    element.addEventListener('wheel', wheel, { passive: false });
    setFailed(false); callbacks.current.onReady(false);
    const fail = (message: string) => {
      if (controller.signal.aborted) return; controller.abort(); cancelAnimationFrame(frame);
      setFailed(true); callbacks.current.onReady(false); callbacks.current.onError(message);
      observer?.disconnect(); if (renderer.current === view) renderer.current = null; view.destroy();
    };
    failure.current = fail;
    const unsubscribeLoss = view.onDeviceLost(() => fail('The preview graphics connection was lost. Reload the preview to continue.'));
    void (async () => {
      try {
        await view.init(); controller.signal.throwIfAborted();
        renderer.current = view;
        const resize = () => { view.resize(element.clientWidth, element.clientHeight); view.requestRender(); };
        observer = new ResizeObserver(resize); observer.observe(element); resize();
        const bbox = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
        for (let i = 0; i < source.count * 3; i++) { const axis = i % 3; bbox.min[axis] = Math.min(bbox.min[axis], positions[i]); bbox.max[axis] = Math.max(bbox.max[axis], positions[i]); }
        const handle = view.beginPointCloudStream({ expressId: 1, ifcType: 'IfcGeographicElement' });
        view.appendPointCloudChunk(handle, { positions, colors, pointCount: source.count, bbox });
        view.endPointCloudStream(handle);
        view.fitToView(); view.render(); projectMarkers(view); view.requestRender();
        const tick = () => { if (controller.signal.aborted) return; try { if (view.consumeRenderRequest()) { view.render(); projectMarkers(view); } frame = requestAnimationFrame(tick); } catch (error) { fail(error instanceof Error ? error.message : String(error)); } };
        frame = requestAnimationFrame(tick); callbacks.current.onReady(true);
      } catch (error) {
        if (!controller.signal.aborted) { setFailed(true); callbacks.current.onError(error instanceof Error ? error.message : String(error)); }
        view.destroy();
      }
    })();
    return () => {
      controller.abort(); cancelAnimationFrame(frame); observer?.disconnect(); unsubscribeLoss(); element.removeEventListener('wheel', wheel);
      if (failure.current === fail) failure.current = null;
      view.destroy(); if (renderer.current === view) renderer.current = null; callbacks.current.onReady(false);
    };
  }, [source, positions, colors, generation]);
  useEffect(() => { renderer.current?.requestRender(); }, [markers]);
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  function pick(view: Renderer, element: HTMLCanvasElement, p: { x: number; y: number }) {
    const rect = element.getBoundingClientRect();
    const camera = view.getCamera();
    const ray = camera.unprojectToRay(p.x * element.width / rect.width, p.y * element.height / rect.height, element.width, element.height);
    const pixel = PICK_TOLERANCE_PX * element.height / Math.max(1, rect.height);
    const tolerance = camera.getProjectionMode() === 'orthographic'
      ? () => (pixel / element.height) * 2 * camera.getOrthoSize()
      : (t: number) => (pixel / element.height) * 2 * t * Math.tan(camera.getFOV() / 2);
    return pickScanPoint(positions, source.count, ray, tolerance);
  }
  return <div className="space-y-2">
    {failed && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setGeneration(value => value + 1)}>Reload preview</Button>}
    <div className="relative overflow-hidden rounded border">
      <canvas ref={canvas} aria-label={canvasLabel ?? 'Scan point preview'} className="h-64 w-full touch-none" onContextMenu={event => event.preventDefault()}
        onPointerDown={event => { if (!event.isPrimary || disabled || !renderer.current) return; const p = point(event); gesture.current = { start: p, last: p, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          const current = gesture.current, view = renderer.current; if (!current || current.pointer !== event.pointerId || !view || disabled) return;
          const p = point(event); view.getCamera().orbit(p.x - current.last.x, p.y - current.last.y); view.requestRender(); current.last = p;
        }}
        onPointerUp={event => {
          const current = gesture.current, view = renderer.current;
          if (!current || current.pointer !== event.pointerId || !view || disabled) return;
          gesture.current = null;
          const p = point(event);
          if (callbacks.current.onLandmark && Math.hypot(p.x - current.start.x, p.y - current.start.y) < 4) {
            const hit = pick(view, event.currentTarget, p);
            if (hit) callbacks.current.onLandmark(hit.index);
          }
        }} onPointerCancel={() => { gesture.current = null; }} />
      {projected.map(marker => <span key={marker.id} className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border px-1 text-[10px] font-bold shadow ${marker.check ? 'bg-amber-100 text-amber-950' : 'bg-primary text-primary-foreground'}`} style={{ left: marker.x, top: marker.y }}>{marker.id}</span>)}
    </div>
    <p className="text-[11px] text-muted-foreground">{instruction ?? 'Click a scan point, then its matching point in the main IFC view. Drag to orbit; scroll to zoom.'}</p>
  </div>;
}
