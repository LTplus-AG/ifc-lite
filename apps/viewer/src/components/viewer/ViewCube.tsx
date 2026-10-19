/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { VIEW_CUBE_EDGE_BAND_PX, VIEW_CUBE_SIZE_PX } from './viewcube-box';
import {
  CUBE_FACES,
  faceOfDirection,
  facesOfDirection,
  isZoneHighlighted,
  zonesForFace,
  type CubeDirection,
  type CubeFace,
  type CubeZone,
} from './viewcube-zones';

interface ViewCubeProps {
  onViewChange?: (view: string) => void;
  /** An edge or corner was clicked: camera offset in the preset face frame. */
  onDirectionChange?: (direction: CubeDirection) => void;
  onDrag?: (deltaX: number, deltaY: number) => void;
  rotationX?: number;
  rotationY?: number;
}

export interface ViewCubeRef {
  updateRotation: (x: number, y: number) => void;
}

const FACE_VIEWS: Record<string, { rx: number; ry: number }> = {
  front: { rx: 0, ry: 0 },
  back: { rx: 0, ry: 180 },
  top: { rx: -90, ry: 0 },
  bottom: { rx: 90, ry: 0 },
  right: { rx: 0, ry: -90 },
  left: { rx: 0, ry: 90 },
};

const FACES: { id: CubeFace; label: string; transform: (h: number) => string }[] = [
  { id: 'front', label: 'FRONT', transform: (h) => `translateZ(${h}px)` },
  { id: 'back', label: 'BACK', transform: (h) => `translateZ(${-h}px) rotateY(180deg)` },
  { id: 'top', label: 'TOP', transform: (h) => `translateY(${-h}px) rotateX(90deg)` },
  { id: 'bottom', label: 'BTM', transform: (h) => `translateY(${h}px) rotateX(-90deg)` },
  { id: 'right', label: 'RIGHT', transform: (h) => `translateX(${h}px) rotateY(90deg)` },
  { id: 'left', label: 'LEFT', transform: (h) => `translateX(${-h}px) rotateY(-90deg)` },
];

const ZONES_BY_FACE = Object.fromEntries(CUBE_FACES.map((f) => [f, zonesForFace(f)])) as Record<CubeFace, CubeZone[]>;

const cubeTransform = (x: number, y: number) => `rotateX(${x}deg) rotateY(${y}deg)`;

export const ViewCube = forwardRef<ViewCubeRef, ViewCubeProps>(
  ({ onViewChange, onDirectionChange, onDrag, rotationX = -25, rotationY = 45 }, ref) => {
    const { t } = useTranslation();
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const [isMouseDown, setIsMouseDown] = useState(false);
    const dragStartRef = useRef<{ x: number; y: number } | null>(null);
    const didDragRef = useRef(false);
    const isDraggingRef = useRef(false);
    const onDragRef = useRef(onDrag);
    const rotationContainerRef = useRef<HTMLDivElement>(null);

    // Keep onDrag ref up to date
    useEffect(() => {
      onDragRef.current = onDrag;
    }, [onDrag]);

    // Expose updateRotation for direct updates (no React re-renders). Applied
    // synchronously: the caller already runs once per camera change (pointer
    // move or animation-loop tick), and deferring to another animation frame
    // is what made the cube trail the model by a frame while orbiting.
    useImperativeHandle(ref, () => ({
      updateRotation: (x: number, y: number) => {
        if (rotationContainerRef.current) {
          rotationContainerRef.current.style.transform = cubeTransform(x, y);
        }
      },
    }), []);

    // Initial rotation from props (only on mount)
    useEffect(() => {
      if (rotationContainerRef.current) {
        rotationContainerRef.current.style.transform = cubeTransform(rotationX, rotationY);
      }
    }, []); // Empty deps - only set initial rotation

    const size = VIEW_CUBE_SIZE_PX;
    const half = size / 2;

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      // Track mouse position for potential drag
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      didDragRef.current = false;
      isDraggingRef.current = false;
      setIsMouseDown(true);
    }, []);

    // Document-level mouse handlers
    useEffect(() => {
      if (!isMouseDown) {
        document.body.style.cursor = '';
        return;
      }

      const handleDocumentMouseMove = (e: MouseEvent) => {
        if (!dragStartRef.current) return;

        const deltaX = e.clientX - dragStartRef.current.x;
        const deltaY = e.clientY - dragStartRef.current.y;

        // Start dragging after threshold (distinguishes from clicks)
        if (!isDraggingRef.current && (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5)) {
          isDraggingRef.current = true;
          didDragRef.current = true;
          document.body.style.cursor = 'grabbing';
        }

        if (isDraggingRef.current) {
          onDragRef.current?.(deltaX * 2, deltaY * 2);
          dragStartRef.current = { x: e.clientX, y: e.clientY };
        }
      };

      const handleDocumentMouseUp = () => {
        setIsMouseDown(false);
        isDraggingRef.current = false;
        dragStartRef.current = null;
        document.body.style.cursor = '';
        // Reset didDragRef after a brief delay to allow click to check it
        setTimeout(() => {
          didDragRef.current = false;
        }, 50);
      };

      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleDocumentMouseMove);
        document.removeEventListener('mouseup', handleDocumentMouseUp);
        document.body.style.cursor = '';
      };
    }, [isMouseDown]);

    const handleZoneClick = useCallback((zone: CubeZone) => {
      // Only trigger click if we didn't drag
      if (didDragRef.current) return;
      const face = faceOfDirection(zone.direction);
      if (face) onViewChange?.(face);
      else onDirectionChange?.(zone.direction);
    }, [onViewChange, onDirectionChange]);

    return (
      // Mouse dragging changes the cube orientation; the child face buttons provide keyboard views.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div
        className="relative select-none"
        style={{
          width: size,
          height: size,
          perspective: 200,
        }}
        onMouseDown={handleMouseDown}
      >
        <div
          ref={rotationContainerRef}
          className="relative w-full h-full"
          style={{
            transformStyle: 'preserve-3d',
            transform: cubeTransform(rotationX, rotationY),
          }}
        >
          {FACES.map(({ id, label, transform }) => (
            <div
              key={id}
              className="absolute w-full h-full grid"
              style={{
                transform: transform(half),
                backfaceVisibility: 'hidden',
                gridTemplate: `${VIEW_CUBE_EDGE_BAND_PX}px 1fr ${VIEW_CUBE_EDGE_BAND_PX}px / ${VIEW_CUBE_EDGE_BAND_PX}px 1fr ${VIEW_CUBE_EDGE_BAND_PX}px`,
              }}
            >
              {ZONES_BY_FACE[id].map((zone) => {
                const lit = isZoneHighlighted(zone, id, hoveredKey);
                const isFace = zone.kind === 'face';
                return (
                  <button
                    key={zone.key}
                    type="button"
                    aria-label={t('viewportLighting.viewCube.zoneAria', {
                      faces: facesOfDirection(zone.direction)
                        .map((f) => t(`viewportLighting.viewCube.face.${f}`))
                        .join(' / '),
                    })}
                    data-viewcube-zone={zone.kind}
                    // Keyboard users get the six face views (as before) plus the view shortcuts;
                    // 20 more stops, many of them facing away, would bloat the tab order.
                    tabIndex={isFace ? undefined : -1}
                    className={cn(
                      'flex items-center justify-center text-2xs font-bold transition-colors cursor-pointer border',
                      lit
                        ? 'bg-primary/40 border-primary text-primary'
                        : isFace
                          ? 'bg-card/95 border-border/50 hover:bg-muted'
                          : 'bg-muted/70 border-border/50',
                    )}
                    onMouseEnter={() => setHoveredKey(zone.key)}
                    onMouseLeave={() => setHoveredKey(null)}
                    onClick={() => handleZoneClick(zone)}
                  >
                    {isFace ? label : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  });

ViewCube.displayName = 'ViewCube';

export { FACE_VIEWS };
