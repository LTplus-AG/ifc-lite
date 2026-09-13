/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Raycaster, type Intersection } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { Button } from '@/components/ui/button';
import { capturedScreenRegion } from './capture-screen-region';
import { NO_MARKERS, PreviewMarkers, useLocalPreviewRenderer, type PreviewMarker } from './local-preview-renderer';

const NO_PARTS: readonly MeshData[] = [];
/** How a region gesture was made, so a face-selection host can add, remove or toggle (#4404). */
export interface RegionGesture { kind: 'marquee' | 'click'; subtract: boolean }
export interface FaceSelectionMode {
  /** Triangles outside the region stay visible in this colour instead of being hidden. */
  unselectedColor: readonly [number, number, number, number];
}

/** A local renderer borrows the retained image. It never installs a global
 * renderer, changes the main camera, or publishes a model/IFC owner. */
export function AppearanceMeshPreview({ mesh, assetId, additionalMeshes = NO_PARTS, initialPlane, triangles, disabled, onRegion, onReady, onError, onLandmark, markers = NO_MARKERS, regionControls = true, instruction, canvasLabel, faceSelection }: {
  mesh: MeshData; assetId?: string; additionalMeshes?: readonly MeshData[]; triangles: readonly number[]; disabled: boolean;
  onRegion(ids: number[], gesture: RegionGesture): void; onReady(ready: boolean): void; onError(message: string): void;
  onLandmark?(hit: Intersection): void; markers?: PreviewMarker[];
  initialPlane?: { normal: readonly [number, number, number]; up: readonly [number, number, number] };
  regionControls?: boolean; instruction?: string; canvasLabel?: string;
  /** Face-selection mode: the whole surface stays visible, select mode is sticky, a click toggles one triangle. */
  faceSelection?: FaceSelectionMode;
}) {
  const bitmap = useRef<ImageBitmap | null>(null);
  /** The image lease for the current scene; released whenever that scene's view is discarded. */
  const owner = useRef<{ kind: 'draft'; id: string } | null>(null);
  const region = useRef(triangles); region.current = triangles;
  const [selecting, setSelecting] = useState(false);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const preview = useLocalPreviewRenderer({
    deps: [mesh, assetId, additionalMeshes, initialPlane], disabled, markers, onReady, onError,
    async upload(view, signal) {
      if ((!assetId && mesh.textureRef) || additionalMeshes.some(part => part.textureRef)) throw new Error('The preview is missing a retained image for its textured geometry.');
      const lease = { kind: 'draft' as const, id: `capture-preview:${crypto.randomUUID()}` };
      owner.current = lease;
      if (assetId) appearanceAssets.retain(assetId, lease);
      bitmap.current = assetId ? await appearanceAssets.decode(assetId, lease, signal) : null;
      signal.throwIfAborted();
      if (!draw()) return;
      view.fitToView();
      if (initialPlane) {
        const camera = view.getCamera(), target = camera.getTarget(), distance = camera.getDistance();
        camera.setUp(...initialPlane.up);
        camera.setPosition(target.x + initialPlane.normal[0] * distance, target.y + initialPlane.normal[1] * distance, target.z + initialPlane.normal[2] * distance);
      }
    },
    release() {
      bitmap.current = null;
      if (owner.current) { appearanceAssets.releaseOwner(owner.current); owner.current = null; }
    },
  });
  function draw() {
    const view = preview.renderer.current, image = bitmap.current;
    if (!view || (assetId && !image)) return false;
    try {
      view.getScene().clear();
      const count = mesh.indices.length / 3;
      const visible = selecting && !faceSelection ? Array.from({ length: count }, (_, i) => i) : region.current;
      const base = mesh.origin ?? [0, 0, 0];
      const corners = (ids: readonly number[]) => Uint32Array.from(ids.flatMap(id => [mesh.indices[id * 3], mesh.indices[id * 3 + 1], mesh.indices[id * 3 + 2]]));
      const parts: MeshData[] = visible.length ? [{ ...mesh, origin: [0, 0, 0], textureBitmap: image ?? undefined, indices: corners(visible) }] : [];
      if (faceSelection) {
        const chosen = new Set(visible), rest = Array.from({ length: count }, (_, i) => i).filter(id => !chosen.has(id));
        if (rest.length) parts.push({ ...mesh, origin: [0, 0, 0], indices: corners(rest), color: [...faceSelection.unselectedColor], uvs: undefined, texture: undefined, textureRef: undefined, textureBitmap: undefined });
      }
      for (const part of additionalMeshes) parts.push({ ...part, origin: [
        (part.origin?.[0] ?? 0) - base[0], (part.origin?.[1] ?? 0) - base[1], (part.origin?.[2] ?? 0) - base[2]] });
      if (parts.length) view.loadGeometry(parts);
      view.render(); preview.projectMarkers(view); return true;
    } catch (error) { preview.failure.current?.(error instanceof Error ? error.message : String(error)); return false; }
  }
  useEffect(() => { draw(); }, [triangles, selecting, faceSelection]);
  return <div className="space-y-2">
    {preview.failed && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={preview.reload}>Reload preview</Button>}
    {regionControls && <div className="flex gap-2"><Button type="button" size="sm" variant={selecting ? 'secondary' : 'outline'} aria-pressed={selecting}
      disabled={disabled} onClick={() => { setSelecting(value => !value); setBox(null); }}>{faceSelection ? 'Pick faces' : 'Select region'}</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onRegion(Array.from({ length: mesh.indices.length / 3 }, (_, i) => i), { kind: 'marquee', subtract: false })}>{faceSelection ? 'All faces' : 'Entire surface'}</Button></div>}
    <div className="relative overflow-hidden rounded border">
      <canvas ref={preview.canvas} aria-label={canvasLabel ?? 'Captured surface preview'} className="h-64 w-full touch-none" onContextMenu={event => event.preventDefault()}
        onPointerDown={preview.beginGesture}
        onPointerMove={event => {
          const live = preview.currentGesture(event); if (!live) return;
          const p = preview.point(event);
          if (selecting) { setBox({ x: Math.min(p.x, live.current.start.x), y: Math.min(p.y, live.current.start.y), width: Math.abs(p.x - live.current.start.x), height: Math.abs(p.y - live.current.start.y) }); live.current.last = p; }
          else preview.orbit(live.view, live.current, p);
        }}
        onPointerUp={event => {
          const live = preview.currentGesture(event); if (!live) return;
          preview.gesture.current = null; setBox(null);
          const p = preview.point(event), element = event.currentTarget, click = preview.isClick(live.current, p);
          const pick = () => {
            const rect = element.getBoundingClientRect();
            const ray = live.view.getCamera().unprojectToRay(p.x * element.width / rect.width, p.y * element.height / rect.height, element.width, element.height);
            return new Raycaster().raycast(ray, [{ ...mesh, origin: [0, 0, 0] }]);
          };
          if (!selecting && onLandmark && click) { const hit = pick(); if (hit) onLandmark(hit); }
          if (selecting && faceSelection && click) { const hit = pick(); if (hit) onRegion([hit.triangleIndex], { kind: 'click', subtract: event.altKey }); return; }
          if (selecting) { onRegion(capturedScreenRegion(mesh, live.current.start, p, q => live.view.getCamera().projectToScreen(q, element.clientWidth, element.clientHeight)), { kind: 'marquee', subtract: event.altKey }); if (!faceSelection) setSelecting(false); }
        }} onPointerCancel={() => { preview.gesture.current = null; setBox(null); }}
 />
      <PreviewMarkers projected={preview.projected} />
      {box && <div className="pointer-events-none absolute border border-primary bg-primary/15" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
    </div>
    <p className="text-[11px] text-muted-foreground">{instruction ?? (faceSelection
      ? (selecting ? 'Drag a rectangle to add whole faces by their centres, or click one face to toggle it. Hold Alt to remove.' : 'Drag to orbit. Scroll to zoom. Turn on Pick faces to restrict the image to part of this surface.')
      : (selecting ? 'Drag a rectangle. Whole triangles are selected by their centres, through the surface.' : 'Drag to orbit. Scroll to zoom. Select region to keep part of this surface.'))}</p>
  </div>;
}
