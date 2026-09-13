/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';

export interface PreviewMarker { id: string; point: { x: number; y: number; z: number }; check?: boolean }
export interface ProjectedMarker { id: string; x: number; y: number; check?: boolean }
export interface PreviewGesture { start: { x: number; y: number }; last: { x: number; y: number }; pointer: number }
export const NO_MARKERS: PreviewMarker[] = [];

/** One local `Renderer` on its own canvas for an appearance preview: init,
 * resize observer, device-loss failure, render-on-request ticking, marker
 * projection, orbit/zoom gesture state and the Reload retry. It never installs
 * a global renderer or moves the main camera. `upload` fills the freshly
 * initialised view (throw to fail the preview); `release` runs whenever the
 * view for that upload is discarded, so leases taken in `upload` are returned
 * on every path. The scene is rebuilt whenever `deps` change. */
export function useLocalPreviewRenderer({ upload, release, deps, disabled, markers, onReady, onError }: {
  upload(view: Renderer, signal: AbortSignal): Promise<void> | void;
  release?(): void;
  deps: readonly unknown[]; disabled: boolean; markers: readonly PreviewMarker[];
  onReady(ready: boolean): void; onError(message: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<Renderer | null>(null);
  const failure = useRef<((message: string) => void) | null>(null);
  const callbacks = useRef({ upload, release, onReady, onError }); callbacks.current = { upload, release, onReady, onError };
  const markerRef = useRef(markers); markerRef.current = markers;
  const blocked = useRef(disabled); blocked.current = disabled;
  const [projected, setProjected] = useState<ProjectedMarker[]>([]);
  const [generation, setGeneration] = useState(0), [failed, setFailed] = useState(false);
  const gesture = useRef<PreviewGesture | null>(null);
  const projectMarkers = useCallback((view: Renderer) => {
    const element = canvas.current; if (!element) return;
    const rect = element.getBoundingClientRect();
    const next = markerRef.current.flatMap(marker => { const p = view.getCamera().projectToScreen(marker.point, rect.width, rect.height); return p ? [{ id: marker.id, check: marker.check, x: p.x, y: p.y }] : []; });
    setProjected(previous => previous.length === next.length && previous.every((p, i) => p.id === next[i].id && p.x === next[i].x && p.y === next[i].y && p.check === next[i].check) ? previous : next);
  }, []);
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const controller = new AbortController(), view = new Renderer(element);
    let frame = 0, observer: ResizeObserver | undefined;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if (!blocked.current && renderer.current === view) { view.getCamera().zoom(event.deltaY); view.requestRender(); } };
    element.addEventListener('wheel', wheel, { passive: false });
    setFailed(false); callbacks.current.onReady(false);
    const discard = () => { observer?.disconnect(); if (renderer.current === view) renderer.current = null; view.destroy(); callbacks.current.release?.(); };
    const fail = (message: string) => {
      if (controller.signal.aborted) return; controller.abort(); cancelAnimationFrame(frame);
      setFailed(true); callbacks.current.onReady(false); callbacks.current.onError(message); discard();
    };
    failure.current = fail;
    const unsubscribeLoss = view.onDeviceLost(() => fail('The preview graphics connection was lost. Reload the preview to continue.'));
    void (async () => {
      try {
        await view.init(); controller.signal.throwIfAborted();
        renderer.current = view;
        const resize = () => { view.resize(element.clientWidth, element.clientHeight); view.requestRender(); };
        observer = new ResizeObserver(resize); observer.observe(element); resize();
        await callbacks.current.upload(view, controller.signal);
        if (controller.signal.aborted) return; // failed or unmounted while uploading: already discarded
        view.render(); projectMarkers(view); view.requestRender();
        const tick = () => { if (controller.signal.aborted) return; try { if (view.consumeRenderRequest()) { view.render(); projectMarkers(view); } frame = requestAnimationFrame(tick); } catch (error) { fail(error instanceof Error ? error.message : String(error)); } };
        frame = requestAnimationFrame(tick); callbacks.current.onReady(true);
      } catch (error) {
        if (!controller.signal.aborted) { setFailed(true); callbacks.current.onError(error instanceof Error ? error.message : String(error)); }
        discard();
      }
    })();
    return () => {
      controller.abort(); cancelAnimationFrame(frame); unsubscribeLoss(); element.removeEventListener('wheel', wheel);
      if (failure.current === fail) failure.current = null;
      discard(); callbacks.current.onReady(false);
    };
  // The scene is rebuilt from `deps` and on each Reload; callbacks are read through refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, generation, projectMarkers]);
  useEffect(() => { renderer.current?.requestRender(); }, [markers]);
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  /** Begins an orbit/pick gesture on the primary pointer. */
  const beginGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary || blocked.current || !renderer.current) return;
    const p = point(event); gesture.current = { start: p, last: p, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId);
  };
  /** The live gesture for this pointer event, or null when none is in progress or the preview is disabled. */
  const currentGesture = (event: React.PointerEvent<HTMLCanvasElement>): { current: PreviewGesture; view: Renderer } | null => {
    const current = gesture.current, view = renderer.current;
    return current && current.pointer === event.pointerId && view && !blocked.current ? { current, view } : null;
  };
  const orbit = (view: Renderer, current: PreviewGesture, p: { x: number; y: number }) => { view.getCamera().orbit(p.x - current.last.x, p.y - current.last.y); view.requestRender(); current.last = p; };
  /** True when the pointer barely moved since the gesture began: a click, not an orbit. */
  const isClick = (current: PreviewGesture, p: { x: number; y: number }) => Math.hypot(p.x - current.start.x, p.y - current.start.y) < 4;
  return { canvas, renderer, failure, failed, projected, projectMarkers, gesture, point, beginGesture, currentGesture, orbit, isClick, reload: () => setGeneration(value => value + 1) };
}

export function PreviewMarkers({ projected }: { projected: readonly ProjectedMarker[] }) {
  return <>{projected.map(marker => <span key={marker.id} className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border px-1 text-[10px] font-bold shadow ${marker.check ? 'bg-amber-100 text-amber-950' : 'bg-primary text-primary-foreground'}`} style={{ left: marker.x, top: marker.y }}>{marker.id}</span>)}</>;
}
