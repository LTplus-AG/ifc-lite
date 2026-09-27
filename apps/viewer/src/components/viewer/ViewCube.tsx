/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface ViewCubeProps {
  onViewChange?: (view: string) => void;
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

const FACES = [
  { id: 'front', label: 'FRONT', transform: (h: number) => `translateZ(${h}px)` },
  { id: 'back', label: 'BACK', transform: (h: number) => `translateZ(${-h}px) rotateY(180deg)` },
  { id: 'top', label: 'TOP', transform: (h: number) => `translateY(${-h}px) rotateX(90deg)` },
  { id: 'bottom', label: 'BTM', transform: (h: number) => `translateY(${h}px) rotateX(-90deg)` },
  { id: 'right', label: 'RIGHT', transform: (h: number) => `translateX(${h}px) rotateY(90deg)` },
  { id: 'left', label: 'LEFT', transform: (h: number) => `translateX(${-h}px) rotateY(-90deg)` },
];

export const ViewCube = forwardRef<ViewCubeRef, ViewCubeProps>(
  ({ onViewChange, onDrag, rotationX = -25, rotationY = 45 }, ref) => {
    const [hovered, setHovered] = useState<string | null>(null);
    const [isMouseDown, setIsMouseDown] = useState(false);
    const dragStartRef = useRef<{ x: number; y: number } | null>(null);
    const didDragRef = useRef(false);
    const isDraggingRef = useRef(false);
    const onDragRef = useRef(onDrag);
    const rotationContainerRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number | null>(null);
    const pendingRotationRef = useRef<{ x: number; y: number } | null>(null);

    // Keep onDrag ref up to date
    useEffect(() => {
      onDragRef.current = onDrag;
    }, [onDrag]);

    // Expose updateRotation method via ref for direct updates (no React re-renders)
    useImperativeHandle(ref, () => ({
      updateRotation: (x: number, y: number) => {
        if (!rotationContainerRef.current) return;

        // Store pending rotation
        pendingRotationRef.current = { x, y };

        // Cancel any pending animation frame
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
        }

        // Batch updates via requestAnimationFrame for smooth 60fps
        rafRef.current = requestAnimationFrame(() => {
          if (rotationContainerRef.current && pendingRotationRef.current) {
            rotationContainerRef.current.style.transform = `rotateX(${pendingRotationRef.current.x}deg) rotateY(${pendingRotationRef.current.y}deg)`;
            pendingRotationRef.current = null;
          }
          rafRef.current = null;
        });
      },
    }), []);

    // Initial rotation from props (only on mount)
    useEffect(() => {
      if (rotationContainerRef.current) {
        rotationContainerRef.current.style.transform = `rotateX(${rotationX}deg) rotateY(${rotationY}deg)`;
      }
    }, []); // Empty deps - only set initial rotation

    const size = 60;
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

    const handleFaceClick = useCallback((face: string) => {
      // Only trigger click if we didn't drag
      if (!didDragRef.current) {
        onViewChange?.(face);
      }
    }, [onViewChange]);

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
            transform: `rotateX(${rotationX}deg) rotateY(${rotationY}deg)`,
          }}
        >
          {FACES.map(({ id, label, transform }) => (
            <button
              key={id}
              type="button"
              className={cn(
                'absolute w-full h-full flex items-center justify-center text-2xs font-bold transition-colors cursor-pointer',
                'bg-card/95 border border-border/50',
                hovered === id ? 'bg-primary/30 border-primary text-primary' : 'hover:bg-muted'
              )}
              style={{
                transform: transform(half),
                backfaceVisibility: 'hidden',
              }}
              onMouseEnter={() => setHovered(id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => handleFaceClick(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  });

ViewCube.displayName = 'ViewCube';

export { FACE_VIEWS };
