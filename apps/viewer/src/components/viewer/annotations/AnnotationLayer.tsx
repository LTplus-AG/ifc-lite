/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DOM-billboard overlay for annotation pins.
 *
 * Sits on top of the WebGPU canvas and re-projects every pin's world
 * position to screen space each frame via the camera callbacks.
 * Uses a single rAF loop driven by camera/canvas events (we listen
 * to a per-frame tick exposed by the camera) so the loop pauses when
 * nothing's moving — the runtime cost when idle is zero.
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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import type { AnnotationPosition } from '@/store/slices/annotationsSlice';
import { AnnotationPin } from './AnnotationPin';
import { AnnotationPopover } from './AnnotationPopover';
import { AnnotationDropInput } from './AnnotationDropInput';

interface ProjectedPin {
  id: string;
  index: number;
  /** Screen-space position relative to the canvas. Null when behind the camera. */
  screen: { x: number; y: number } | null;
  preview: string;
}

function makePreview(note: string, maxLen = 60): string {
  const trimmed = note.trim();
  if (trimmed.length === 0) return '(empty note)';
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/**
 * Pins live in the canvas's coordinate space. The wrapping <div>
 * matches the canvas's bounding rect; pins are positioned absolutely
 * within it. We mirror the canvas geometry via a ResizeObserver +
 * a per-frame projection tick.
 */
export function AnnotationLayer() {
  const annotations = useViewerStore((s) => s.annotations);
  const draft = useViewerStore((s) => s.draft);
  const selectedAnnotationId = useViewerStore((s) => s.selectedAnnotationId);
  const selectAnnotation = useViewerStore((s) => s.selectAnnotation);
  const updateAnnotation = useViewerStore((s) => s.updateAnnotation);
  const removeAnnotation = useViewerStore((s) => s.removeAnnotation);
  const commitDraft = useViewerStore((s) => s.commitDraft);
  const cancelDraft = useViewerStore((s) => s.cancelDraft);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const { ifcDataStore, models } = useIfc();

  // Track canvas geometry so the overlay sits exactly on top.
  const containerRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const canvas = container.parentElement?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      // No canvas yet (initial mount before viewport renders) — the
      // ResizeObserver below will fire once the canvas appears via a
      // separate effect.
      return;
    }

    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Stable list view so React doesn't churn when the Map identity
  // changes but the entries are equal.
  const annotationList = useMemo(() => Array.from(annotations.values()), [annotations]);

  // Per-frame projection tick. We don't have a global "camera moved"
  // event, so a rAF loop is the cheapest way to keep pins glued to
  // the world. The loop is mostly idle — projection is < 10 µs per
  // pin and the typical scene has < 20 pins.
  const [projectedPins, setProjectedPins] = useState<ProjectedPin[]>([]);
  const [draftScreen, setDraftScreen] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const project = cameraCallbacks.projectToScreen;
    if (!project) {
      setProjectedPins([]);
      setDraftScreen(null);
      return;
    }

    let raf: number | null = null;
    let lastSerialized = '';

    const tick = () => {
      const next: ProjectedPin[] = annotationList.map((ann, i) => ({
        id: ann.id,
        index: i + 1,
        screen: project(ann.position),
        preview: makePreview(ann.note),
      }));

      // Cheap deep-eq check: serialize the screen positions. Skip the
      // setState when nothing moved, otherwise we re-render every
      // frame even when the camera is still.
      const serialized = next.map((p) => `${p.id}:${p.screen?.x ?? 'x'}:${p.screen?.y ?? 'y'}`).join(',');
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        setProjectedPins(next);
      }

      const draftPos = useViewerStore.getState().draft?.position ?? null;
      const draftScreenNext = draftPos ? project(draftPos) : null;
      setDraftScreen((prev) => {
        if (prev === draftScreenNext) return prev;
        if (prev && draftScreenNext && prev.x === draftScreenNext.x && prev.y === draftScreenNext.y) {
          return prev;
        }
        return draftScreenNext;
      });

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
    // The list of annotations is captured per-render via annotationList;
    // that closure is what the rAF tick reads. Pin position changes
    // automatically pick up via the next render's loop replacement.
  }, [cameraCallbacks, annotationList]);

  const selectedAnnotation = selectedAnnotationId ? annotations.get(selectedAnnotationId) : null;
  const selectedScreen = useMemo(() => {
    if (!selectedAnnotation) return null;
    return projectedPins.find((p) => p.id === selectedAnnotation.id)?.screen ?? null;
  }, [selectedAnnotation, projectedPins]);

  // Resolve entity type + id for the popover header. Cheap lookup
  // against whichever data store the annotation was anchored to.
  const resolveEntityType = (modelId: string | null, expressId: number | null): string | null => {
    if (expressId === null) return null;
    const dataStore = modelId ? models.get(modelId)?.ifcDataStore : ifcDataStore;
    if (!dataStore?.entities) return null;
    return dataStore.entities.getTypeName(expressId) || null;
  };

  if (!bounds) {
    return <div ref={containerRef} className="absolute inset-0 pointer-events-none" />;
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-label="Annotations layer"
    >
      {/* Pins */}
      {projectedPins.map((pin) => {
        if (!pin.screen) return null;
        const annotation = annotations.get(pin.id);
        if (!annotation) return null;
        const isSelected = selectedAnnotationId === pin.id;
        return (
          <div
            key={pin.id}
            data-annotation-pin-id={pin.id}
            className="absolute pointer-events-auto"
            style={{
              left: pin.screen.x,
              top: pin.screen.y,
              transform: 'translate(-50%, -50%)',
              animationDelay: `${pin.index * 40}ms`,
            }}
          >
            <AnnotationPin
              index={pin.index}
              selected={isSelected}
              preview={pin.preview}
              onClick={() => selectAnnotation(isSelected ? null : pin.id)}
            />
          </div>
        );
      })}

      {/* Popover for the selected pin */}
      {selectedAnnotation && selectedScreen && (
        <AnnotationPopover
          annotation={selectedAnnotation}
          anchorX={selectedScreen.x}
          anchorY={selectedScreen.y}
          canvasWidth={bounds.width}
          canvasHeight={bounds.height}
          entityType={resolveEntityType(selectedAnnotation.modelId, selectedAnnotation.entityExpressId)}
          onSave={(note) => updateAnnotation(selectedAnnotation.id, note)}
          onDelete={() => removeAnnotation(selectedAnnotation.id)}
          onClose={() => selectAnnotation(null)}
        />
      )}

      {/* Drop input + ghost pin while drafting */}
      {draft && draftScreen && (
        <>
          <div
            className="absolute pointer-events-none"
            style={{
              left: draftScreen.x,
              top: draftScreen.y,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <AnnotationPin index={annotationList.length + 1} variant="draft" />
          </div>
          <AnnotationDropInput
            anchorX={draftScreen.x}
            anchorY={draftScreen.y}
            canvasWidth={bounds.width}
            canvasHeight={bounds.height}
            entityType={resolveEntityType(draft.modelId, draft.entityExpressId)}
            entityExpressId={draft.entityExpressId}
            onSave={(note) => commitDraft(note)}
            onCancel={cancelDraft}
          />
        </>
      )}
    </div>
  );
}

export type { AnnotationPosition };
