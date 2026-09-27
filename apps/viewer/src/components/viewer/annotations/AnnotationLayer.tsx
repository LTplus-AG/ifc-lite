/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene-kernel overlay for annotation pins (#5511, charter #5478).
 *
 * Each pin is a `Pin` primitive registered with the shared `SceneProjector`
 * (`components/viewport-ui/scene`) — the projector's one rAF loop keeps it
 * glued to its world point; this component no longer runs its own
 * `requestAnimationFrame` + `projectToScreen` loop (that loop, and the
 * bespoke DOM-billboard `AnnotationPin` button it drove, are gone; see
 * `Pin.tsx`).
 *
 * The popover and drop-input still need a raw screen anchor point (they
 * edge-clamp against the canvas, which `AnchoredCard`'s fixed offset
 * doesn't do), so `useScreenAnchor` below drives ONE extra hidden anchor per
 * surface through the same shared projector via `useWorldAnchor` directly —
 * still one loop, just a second registration rather than a bespoke primitive.
 *
 * Key invariants:
 *   • The layer is `pointer-events: none` by default. Each pin and
 *     popover opts into `pointer-events: auto` so 3D interactions
 *     (orbit, pan, pick) still pass through the empty space between
 *     pins.
 *   • Only one popover or drop-input is visible at a time. They
 *     anchor to the pin's last projected position and re-anchor as
 *     the camera moves.
 *   • Persistence happens on commit/edit/delete via the slice's
 *     localStorage write — this layer never touches storage directly.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useTranslation } from '@/i18n';
import type { AnnotationPosition } from '@/store/slices/annotationsSlice';
import { Pin, useWorldAnchor, type Vec3, type ScreenPoint } from '@/components/viewport-ui/scene';
import { AnnotationPopover } from './AnnotationPopover';
import { AnnotationDropInput } from './AnnotationDropInput';

function makePreview(note: string, emptyNoteLabel: string, maxLen = 60): string {
  const trimmed = note.trim();
  if (trimmed.length === 0) return emptyNoteLabel;
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/**
 * Registers `worldPoint` on the shared projector via a hidden anchor and
 * mirrors its screen position into React state — for the popover/drop-input,
 * which need a plain `{x, y}` number pair (not a DOM-transform ref) to
 * edge-clamp against the canvas.
 */
function useScreenAnchor(worldPoint: Vec3 | null): { hiddenRef: React.RefObject<HTMLDivElement | null>; screen: ScreenPoint | null } {
  const [screen, setScreen] = useState<ScreenPoint | null>(null);
  const { ref } = useWorldAnchor<HTMLDivElement>(() => worldPoint, {
    onProject: (projection) => setScreen(projection.screen),
  });
  return { hiddenRef: ref, screen };
}

export function AnnotationLayer() {
  const { t } = useTranslation();
  const annotations = useViewerStore((s) => s.annotations);
  const draft = useViewerStore((s) => s.draft);
  const selectedAnnotationId = useViewerStore((s) => s.selectedAnnotationId);
  const selectAnnotation = useViewerStore((s) => s.selectAnnotation);
  const updateAnnotation = useViewerStore((s) => s.updateAnnotation);
  const removeAnnotation = useViewerStore((s) => s.removeAnnotation);
  const commitDraft = useViewerStore((s) => s.commitDraft);
  const cancelDraft = useViewerStore((s) => s.cancelDraft);
  const { ifcDataStore, models } = useIfc();

  // Canvas geometry, for the popover/drop-input's edge clamp — DOM geometry
  // tracking, not a per-frame projection loop.
  const containerRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const parent = container.parentElement;
    if (!parent) return;

    let observer: ResizeObserver | null = null;

    const measure = (canvas: HTMLCanvasElement) => {
      const rect = canvas.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    };

    const bind = (canvas: HTMLCanvasElement) => {
      measure(canvas);
      observer = new ResizeObserver(() => measure(canvas));
      observer.observe(canvas);
    };

    const initialCanvas = parent.querySelector('canvas') as HTMLCanvasElement | null;
    if (initialCanvas) {
      bind(initialCanvas);
      return () => observer?.disconnect();
    }

    // Canvas not mounted yet (initial mount before viewport renders) —
    // watch the parent for the canvas to appear, then bind once it does.
    const mutationObserver = new MutationObserver(() => {
      const canvas = parent.querySelector('canvas') as HTMLCanvasElement | null;
      if (canvas) {
        bind(canvas);
        mutationObserver.disconnect();
      }
    });
    mutationObserver.observe(parent, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      observer?.disconnect();
    };
  }, []);

  // Stable list view so React doesn't churn when the Map identity
  // changes but the entries are equal.
  const annotationList = useMemo(() => Array.from(annotations.values()), [annotations]);

  const emptyNoteLabel = t('annotations.layer.emptyNotePreview');

  const selectedAnnotation = selectedAnnotationId ? annotations.get(selectedAnnotationId) : null;
  const selectedAnchor = useScreenAnchor(selectedAnnotation?.position ?? null);
  const draftAnchor = useScreenAnchor(draft?.position ?? null);

  // Resolve entity type + id for the popover header. Cheap lookup
  // against whichever data store the annotation was anchored to.
  const resolveEntityType = (modelId: string | null, expressId: number | null): string | null => {
    if (expressId === null) return null;
    // Federation safety: when the annotation carries a modelId that
    // isn't in the current `models` map, falling back to
    // `ifcDataStore` would silently resolve `expressId` against the
    // wrong model (the same id can exist in many federated models).
    // The fallback is therefore restricted to single-model sessions.
    let dataStore: typeof ifcDataStore | null;
    if (!modelId) {
      dataStore = ifcDataStore;
    } else {
      const scoped = models.get(modelId)?.ifcDataStore;
      if (scoped) {
        dataStore = scoped;
      } else if (models.size <= 1) {
        dataStore = ifcDataStore;
      } else {
        return null;
      }
    }
    if (!dataStore?.entities) return null;
    return dataStore.entities.getTypeName(expressId) || null;
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-label={t('annotations.layer.ariaLabel')}
    >
      {/* Hidden anchors that mirror the popover/drop-input's screen position
          through the shared projector (see useScreenAnchor above). */}
      <div ref={selectedAnchor.hiddenRef} style={{ display: 'none' }} />
      <div ref={draftAnchor.hiddenRef} style={{ display: 'none' }} />

      {/* Pins */}
      {annotationList.map((annotation, i) => {
        const index = i + 1;
        const isSelected = selectedAnnotationId === annotation.id;
        const preview = makePreview(annotation.note, emptyNoteLabel);
        return (
          <Pin
            key={annotation.id}
            worldPoint={annotation.position}
            active={isSelected}
            title={
              preview
                ? t('annotations.pin.ariaLabelWithPreview', { index, preview })
                : t('annotations.pin.ariaLabelNoPreview', { index })
            }
            onClick={() => selectAnnotation(isSelected ? null : annotation.id)}
            groupProps={{ 'data-annotation-pin-id': annotation.id }}
          >
            <text textAnchor="middle" dy="1" className="font-mono font-bold tabular-nums">
              {index <= 9 ? index : '·'}
            </text>
          </Pin>
        );
      })}

      {/* Popover for the selected pin */}
      {selectedAnnotation && bounds && selectedAnchor.screen && (
        <AnnotationPopover
          annotation={selectedAnnotation}
          anchorX={selectedAnchor.screen.x}
          anchorY={selectedAnchor.screen.y}
          boundaryEl={containerRef.current}
          entityType={resolveEntityType(selectedAnnotation.modelId, selectedAnnotation.entityExpressId)}
          onSave={(note) => updateAnnotation(selectedAnnotation.id, note)}
          onDelete={() => removeAnnotation(selectedAnnotation.id)}
          onClose={() => selectAnnotation(null)}
        />
      )}

      {/* Ghost pin + drop input while drafting */}
      {draft && (
        <Pin worldPoint={draft.position} active>
          <text textAnchor="middle" dy="1" className="font-mono font-bold tabular-nums">
            {annotationList.length + 1 <= 9 ? annotationList.length + 1 : '·'}
          </text>
        </Pin>
      )}
      {draft && bounds && draftAnchor.screen && (
        <AnnotationDropInput
          anchorX={draftAnchor.screen.x}
          anchorY={draftAnchor.screen.y}
          boundaryEl={containerRef.current}
          entityType={resolveEntityType(draft.modelId, draft.entityExpressId)}
          entityExpressId={draft.entityExpressId}
          onSave={(note) => commitDraft(note)}
          onCancel={cancelDraft}
        />
      )}
    </div>
  );
}

export type { AnnotationPosition };
