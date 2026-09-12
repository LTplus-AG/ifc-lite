/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { Button } from '@/components/ui/button';
import { pickScanPoint, type ScanPointSource } from '@/lib/appearance/scan/point-source';
import { NO_MARKERS, PreviewMarkers, useLocalPreviewRenderer, type PreviewMarker } from './local-preview-renderer';

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
  const colors = useMemo(() => Float32Array.from(source.colors, byte => byte / 255), [source]);
  const preview = useLocalPreviewRenderer({
    deps: [source, positions, colors], disabled, markers, onReady, onError,
    upload(view) {
      const bbox = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
      for (let i = 0; i < source.count * 3; i++) { const axis = i % 3; bbox.min[axis] = Math.min(bbox.min[axis], positions[i]); bbox.max[axis] = Math.max(bbox.max[axis], positions[i]); }
      const handle = view.beginPointCloudStream({ expressId: 1, ifcType: 'IfcGeographicElement' });
      view.appendPointCloudChunk(handle, { positions, colors, pointCount: source.count, bbox });
      view.endPointCloudStream(handle);
      view.fitToView();
    },
  });
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
    {preview.failed && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={preview.reload}>Reload preview</Button>}
    <div className="relative overflow-hidden rounded border">
      <canvas ref={preview.canvas} aria-label={canvasLabel ?? 'Scan point preview'} className="h-64 w-full touch-none" onContextMenu={event => event.preventDefault()}
        onPointerDown={preview.beginGesture}
        onPointerMove={event => { const live = preview.currentGesture(event); if (live) preview.orbit(live.view, live.current, preview.point(event)); }}
        onPointerUp={event => {
          const live = preview.currentGesture(event); if (!live) return;
          preview.gesture.current = null;
          const p = preview.point(event);
          if (onLandmark && preview.isClick(live.current, p)) {
            const hit = pick(live.view, event.currentTarget, p);
            if (hit) onLandmark(hit.index);
          }
        }} onPointerCancel={() => { preview.gesture.current = null; }} />
      <PreviewMarkers projected={preview.projected} />
    </div>
    <p className="text-[11px] text-muted-foreground">{instruction ?? 'Click a scan point, then its matching point in the main IFC view. Drag to orbit; scroll to zoom.'}</p>
  </div>;
}
