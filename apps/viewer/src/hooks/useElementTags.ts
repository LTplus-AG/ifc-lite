/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { hitTestAnnotations } from '@/hooks/annotation2DHitTest';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { resolvedElementTags, resolveElementTagAnchor, resolveElementTagLabel } from '@/lib/drawing/element-tags';
import type { Point2D } from '@/store/slices/drawing2DSlice';

function inside(point: Point2D, ring: readonly Point2D[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x) result = !result;
  }
  return result;
}

/** Kept inside the lazy Drawing panel; the eager store holds only tag records. */
export function useElementTags(drawing: Drawing2D | null, transform: { x: number; y: number; scale: number },
  axis: 'down' | 'front' | 'side', container: React.RefObject<HTMLDivElement | null>) {
  const tags = useViewerStore(s => s.tagAnnotations2D);
  const mutationVersion = useViewerStore(s => s.mutationVersion);
  const models = useViewerStore(s => s.models);
  const views = useViewerStore(s => s.mutationViews);
  const dragging = useRef<{ id: string; start: Point2D; offset: Point2D } | null>(null);
  // Resolve on every store publication relevant to labels/identity and every generation.
  const texts = useMemo(() => drawing ? resolvedElementTags(drawing) : [], [drawing, tags, mutationVersion, models, views]);
  const toDrawing = (e: React.MouseEvent): Point2D | null => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (e.clientX-rect.left-transform.x)/(axis === 'side' ? -transform.scale : transform.scale),
      y: (e.clientY-rect.top-transform.y)/(axis === 'down' ? transform.scale : -transform.scale) };
  };
  useEffect(() => {
    const release = () => { dragging.current = null; };
    window.addEventListener('mouseup', release);
    return () => window.removeEventListener('mouseup', release);
  }, []);
  function handleMouseDown(e: React.MouseEvent): boolean {
    if (e.button !== 0 || !drawing) return false;
    const point = toDrawing(e);
    if (!point) return false;
    const state = useViewerStore.getState();
    if (state.annotation2DActiveTool === 'tag') {
      const polygons = [...drawing.cutPolygons, ...drawing.projectionPolygons];
      // Smaller footprints (doors/windows) win over enclosing space footprints.
      const candidates = polygons.filter(p => inside(point, p.polygon.outer) && !p.polygon.holes.some(h => inside(point, h)))
        .sort((a,b) => {
          const size = (ring: readonly Point2D[]) => Math.abs(ring.reduce((sum,p,i) => { const q=ring[(i+1)%ring.length]; return sum+p.x*q.y-q.x*p.y; },0));
          return size(a.polygon.outer)-size(b.polygon.outer);
        });
      for (const polygon of candidates) {
        const ref = resolveEntityRef(polygon.entityId);
        const tag = { id: `tag-${crypto.randomUUID()}`, modelId: ref.modelId, entityId: ref.expressId,
          anchor: point, offset: { x: 0, y: 0 }, template: 'auto' as const };
        if (resolveElementTagLabel(tag) === null) continue;
        tag.anchor = resolveElementTagAnchor(tag, polygons, polygon.entityId);
        tag.offset = { x: 0.15, y: 0.15 };
        state.addTagAnnotation2D(tag);
        break;
      }
      return true;
    }
    if (state.annotation2DActiveTool !== 'none') return false;
    const rect = container.current!.getBoundingClientRect();
    const hit = hitTestAnnotations({ screenX: e.clientX-rect.left, screenY: e.clientY-rect.top, threshold: 10,
      drawingToScreen: p => ({ x: p.x*(axis === 'side' ? -transform.scale : transform.scale)+transform.x,
        y: p.y*(axis === 'down' ? transform.scale : -transform.scale)+transform.y }),
      texts, clouds: [], polys: [], measures: [] });
    const tag = hit && tags.find(tag => tag.id === hit.id);
    if (!tag) return false;
    state.setSelectedAnnotation2D({ type: 'tag', id: tag.id });
    dragging.current = { id: tag.id, start: point, offset: tag.offset };
    return true;
  }
  function handleMouseMove(e: React.MouseEvent): boolean {
    const drag = dragging.current, point = toDrawing(e);
    if (!drag || !point) return false;
    useViewerStore.getState().updateTagAnnotation2D(drag.id, { x: drag.offset.x+point.x-drag.start.x, y: drag.offset.y+point.y-drag.start.y });
    return true;
  }
  return { texts, handleMouseDown, handleMouseMove };
}
