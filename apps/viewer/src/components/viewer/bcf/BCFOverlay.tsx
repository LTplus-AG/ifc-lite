/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCFOverlay — renders BCF topic markers as 3D-positioned overlays in the
 * viewport, on the shared scene-overlay kernel (#5511, charter #5478).
 *
 * Each marker is a `Pin`, its connector line two anchors on a shared `<line>`
 * (`Connector` below — no fixed-pixel-offset primitive fits "two independent
 * world points", so it registers directly on the projector the same way
 * `Leader` does internally), and its hover tooltip an `AnchoredCard`. All of
 * it rides the ONE shared `SceneProjector` mounted by `SceneOverlayRoot` in
 * `ViewportContainer`; this component no longer creates its own WebGPU
 * projection adapter or polls `requestAnimationFrame` itself (that adapter,
 * and the framework-agnostic DOM renderer it drove — `@ifc-lite/bcf`'s
 * `BCFOverlayRenderer` — are gone; see the package's changeset).
 *
 * Distance-based marker scale/opacity (the pre-kernel renderer's depth cue)
 * is dropped as an intentional simplification — out of scope for a
 * projector-consolidation PR; every other scene primitive keeps a constant
 * screen size regardless of distance.
 *
 * Connects:
 *   - Zustand store (BCF topics, active topic)
 *   - Renderer (entity bounds, for marker positioning — `computeMarkerPositions`)
 *   - BCF panel (click marker → open topic, bidirectional sync)
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { globalIdToExpressId as globalIdToExpressIdLookup } from '@/hooks/bcfIdLookup';
import { bcfWorldOffset, renderFrameBounds, topicToRenderFrame } from '@/hooks/bcf/viewpoint-world-frame';
import { computeMarkerPositions, type BCFMarker3D, type OverlayBBox, type EntityBoundsLookup } from '@ifc-lite/bcf';
import { Pin, AnchoredCard, useSceneLayer, useWorldAnchor, type Vec3, type ScreenPoint } from '@/components/viewport-ui/scene';

// ============================================================================
// Status → colour (BCF status strings are free text; these four cover the
// common BCF vocabulary, everything else falls back to ink).
// ============================================================================

const STATUS_FILL_VAR: Record<string, string> = {
  open: 'var(--overlay-status-danger)',
  'in progress': 'var(--overlay-status-warn)',
  resolved: 'var(--overlay-status-ok)',
  closed: 'var(--overlay-ink-muted)',
};

function statusFill(status: string, active: boolean): string {
  if (active) return 'var(--overlay-accent)';
  return STATUS_FILL_VAR[status.toLowerCase()] ?? 'var(--overlay-ink)';
}

// ============================================================================
// Connector: a line between two independently-projected world points — the
// marker's floating position and its bbox-anchor. Registers two invisible
// anchors on the shared projector (same technique `Leader` uses internally
// for its own visible line) rather than reusing `Leader`, which connects one
// world anchor to a FIXED PIXEL offset, not a second world point.
// ============================================================================

function Connector({ from, to, color }: { from: Vec3; to: Vec3; color: string }) {
  const svgLayer = useSceneLayer('svg');
  const lineRef = useRef<SVGLineElement | null>(null);
  const p1Ref = useRef<ScreenPoint | null>(null);
  const p2Ref = useRef<ScreenPoint | null>(null);

  const apply = () => {
    const line = lineRef.current;
    if (!line) return;
    const p1 = p1Ref.current;
    const p2 = p2Ref.current;
    if (!p1 || !p2) {
      line.style.display = 'none';
      return;
    }
    line.style.display = '';
    line.setAttribute('x1', String(p1.x));
    line.setAttribute('y1', String(p1.y));
    line.setAttribute('x2', String(p2.x));
    line.setAttribute('y2', String(p2.y));
  };

  const { ref: anchor1 } = useWorldAnchor<SVGGElement>(() => from, {
    onProject: (projection) => {
      p1Ref.current = projection.screen;
      apply();
    },
  });
  const { ref: anchor2 } = useWorldAnchor<SVGGElement>(() => to, {
    onProject: (projection) => {
      p2Ref.current = projection.screen;
      apply();
    },
  });

  if (!svgLayer) return null;

  return createPortal(
    <>
      <g ref={anchor1} style={{ display: 'none' }} data-scene-primitive="bcf-connector-anchor" />
      <g ref={anchor2} style={{ display: 'none' }} data-scene-primitive="bcf-connector-anchor" />
      <line
        ref={lineRef}
        style={{ display: 'none' }}
        data-scene-primitive="bcf-connector"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="3 2"
        strokeOpacity={0.5}
      />
    </>,
    svgLayer,
  );
}

// ============================================================================
// React Component
// ============================================================================

export function BCFOverlay() {
  const { t } = useTranslation();
  const [hoveredGuid, setHoveredGuid] = useState<string | null>(null);

  // Store selectors
  const bcfProject = useViewerStore((s) => s.bcfProject);
  const activeTopicId = useViewerStore((s) => s.activeTopicId);
  const setActiveTopic = useViewerStore((s) => s.setActiveTopic);
  const openWorkspacePanel = useViewerStore((s) => s.openWorkspacePanel);
  const models = useViewerStore((s) => s.models);
  const loading = useViewerStore((s) => s.loading);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);

  // GlobalId → expressId lookup (delegates to shared utility)
  const globalIdToExpressId = useCallback(
    (globalIdString: string) =>
      globalIdToExpressIdLookup(globalIdString, models, ifcDataStore),
    [models, ifcDataStore],
  );

  // Bounds lookup — queries the live renderer's Scene directly.
  const boundsLookup: EntityBoundsLookup = useCallback(
    (ifcGuid: string): OverlayBBox | null => {
      const renderer = getGlobalRenderer();
      if (!renderer) return null;
      const result = globalIdToExpressId(ifcGuid);
      if (!result) return null;
      return renderer.getScene().getEntityBoundingBox(result.expressId);
    },
    [globalIdToExpressId],
  );

  // Topics list — stored viewpoints are world coordinates; markers are
  // placed in the render frame (#4806).
  const topics = (() => {
    if (!bcfProject) return [];
    const offset = bcfWorldOffset(models, useViewerStore.getState().geometryResult);
    const bounds = renderFrameBounds(models);
    return Array.from(bcfProject.topics.values(), (topic) => topicToRenderFrame(topic, offset, bounds));
  })();

  // Compute markers — recomputes when topics, bounds, or loading changes
  // (bounding boxes get cached once geometry finishes loading).
  const markers = useMemo(
    () =>
      computeMarkerPositions(topics, boundsLookup, {
        targetDistance: getGlobalRenderer()?.getCamera().getDistance() ?? 50,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topics, boundsLookup, loading],
  );

  const hasTopics = bcfProject !== null && bcfProject.topics.size > 0;
  if (!hasTopics) return null;

  return (
    <>
      {/* Connector lines, drawn first so markers paint on top. */}
      {markers.map(
        (marker: BCFMarker3D) =>
          marker.connectorAnchor && (
            <Connector
              key={`${marker.topicGuid}-connector`}
              from={marker.position}
              to={marker.connectorAnchor}
              color={statusFill(marker.status, marker.topicGuid === activeTopicId)}
            />
          ),
      )}

      {/* Markers. */}
      {markers.map((marker: BCFMarker3D) => (
        <Pin
          key={marker.topicGuid}
          worldPoint={marker.position}
          fill={statusFill(marker.status, marker.topicGuid === activeTopicId)}
          title={marker.title}
          onClick={() => {
            setActiveTopic(marker.topicGuid);
            // Open BCF exclusively so clicking a marker brings it to the
            // front over any other right panel (e.g. clash).
            openWorkspacePanel('bcf');
          }}
          groupProps={{
            'data-bcf-marker-id': marker.topicGuid,
            onPointerEnter: () => setHoveredGuid(marker.topicGuid),
            onPointerLeave: () => setHoveredGuid((prev) => (prev === marker.topicGuid ? null : prev)),
          }}
        >
          <text textAnchor="middle" dy="1" className="font-mono font-bold tabular-nums">
            {marker.index}
          </text>
        </Pin>
      ))}

      {/* Hover tooltip — one at a time, an `AnchoredCard` in the DOM layer. */}
      {markers.map(
        (marker: BCFMarker3D) =>
          hoveredGuid === marker.topicGuid && (
            <AnchoredCard key={`${marker.topicGuid}-tooltip`} worldPoint={marker.position} offset={{ dx: -90, dy: -48 }}>
              <div className="w-[180px] font-mono text-2xs leading-relaxed">
                <p className="font-semibold truncate">{marker.title}</p>
                <p className="mt-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
                  {marker.status}
                  {marker.priority ? ` · ${marker.priority}` : ''}
                  {marker.commentCount > 0
                    ? ` · ${t('bcf.topicDetail.commentCount', { count: marker.commentCount })}`
                    : ''}
                </p>
              </div>
            </AnchoredCard>
          ),
      )}
    </>
  );
}
