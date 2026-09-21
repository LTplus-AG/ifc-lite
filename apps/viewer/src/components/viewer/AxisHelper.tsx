/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Axis Helper component - shows XYZ coordinate system following IFC standard (Z-up)
 * Note: While WebGL uses Y-up internally, IFC convention is Z-up, so we display
 * the axes with Z pointing upward to match what users expect in IFC/BIM context.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from '@/i18n';

interface AxisHelperProps {
  rotationX?: number;
  rotationY?: number;
}

export interface AxisHelperRef {
  updateRotation: (x: number, y: number) => void;
}

export const AxisHelper = forwardRef<AxisHelperRef, AxisHelperProps>(({ rotationX = -25, rotationY = 45 }, ref) => {
  const { t } = useTranslation();
  const size = 50;
  const axisLength = 20;
  const labelOffset = 26;
  const rotationContainerRef = useRef<HTMLDivElement | null>(null);
  const xLabelRef = useRef<HTMLDivElement | null>(null);
  const yLabelRef = useRef<HTMLDivElement | null>(null);
  const zLabelRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRotationRef = useRef<{ x: number; y: number } | null>(null);

  const applyRotation = (x: number, y: number) => {
    if (!rotationContainerRef.current) return;

    rotationContainerRef.current.style.transform = `rotateX(${x}deg) rotateY(${y}deg)`;

    const inverseRotation = `rotateY(${-y}deg) rotateX(${-x}deg)`;
    if (xLabelRef.current) xLabelRef.current.style.transform = inverseRotation;
    if (zLabelRef.current) zLabelRef.current.style.transform = inverseRotation;
    if (yLabelRef.current) yLabelRef.current.style.transform = `translateZ(${labelOffset}px) ${inverseRotation}`;
  };

  useImperativeHandle(ref, () => ({
    updateRotation: (x: number, y: number) => {
      pendingRotationRef.current = { x, y };
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }

      rafRef.current = requestAnimationFrame(() => {
        if (pendingRotationRef.current) {
          applyRotation(pendingRotationRef.current.x, pendingRotationRef.current.y);
          pendingRotationRef.current = null;
        }
        rafRef.current = null;
      });
    },
  }), []);

  useEffect(() => {
    applyRotation(rotationX, rotationY);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // Convert from WebGL convention (Y-up) to IFC display convention (Z-up)
  // In the viewer, Y is up in 3D space, but we relabel:
  // - WebGL X -> Display X (right)
  // - WebGL Y -> Display Z (up in IFC)
  // - WebGL Z -> Display Y (forward in IFC)

  return (
    <div
      className="relative select-none"
      style={{
        width: size,
        height: size,
        perspective: 200,
      }}
    >
      <div
        ref={rotationContainerRef}
        className="relative w-full h-full"
        style={{
          transformStyle: 'preserve-3d',
          transform: `rotateX(${rotationX}deg) rotateY(${rotationY}deg)`,
        }}
      >
        {/* X Axis - Red (pointing right) */}
        <div
          className="absolute bg-red-500"
          style={{
            width: axisLength,
            height: 2,
            left: size / 2,
            top: size / 2 - 1,
            transformOrigin: 'left center',
            transform: 'rotateY(0deg)',
          }}
        />
        <div
          ref={xLabelRef}
          className="absolute text-red-500 font-bold text-xs"
          style={{
            left: size / 2 + labelOffset,
            top: size / 2 - 6,
            transform: `rotateY(${-rotationY}deg) rotateX(${-rotationX}deg)`,
            transformStyle: 'preserve-3d',
          }}
        >
          {t('cesiumGeo.axisHelper.labelX')}
        </div>

        {/* Z Axis - Blue (pointing up in IFC) - this is WebGL Y */}
        <div
          className="absolute bg-blue-500"
          style={{
            width: 2,
            height: axisLength,
            left: size / 2 - 1,
            top: size / 2 - axisLength,
            transformOrigin: 'center bottom',
          }}
        />
        <div
          ref={zLabelRef}
          className="absolute text-blue-500 font-bold text-xs"
          style={{
            left: size / 2 - 4,
            top: size / 2 - labelOffset - 6,
            transform: `rotateY(${-rotationY}deg) rotateX(${-rotationX}deg)`,
            transformStyle: 'preserve-3d',
          }}
        >
          {t('cesiumGeo.axisHelper.labelZ')}
        </div>

        {/* Y Axis - Green (pointing into screen in IFC) - this is WebGL -Z */}
        <div
          className="absolute bg-green-500"
          style={{
            width: axisLength,
            height: 2,
            left: size / 2,
            top: size / 2 - 1,
            transformOrigin: 'left center',
            transform: 'rotateY(-90deg)',
          }}
        />
        <div
          ref={yLabelRef}
          className="absolute text-green-500 font-bold text-xs"
          style={{
            left: size / 2 - 4,
            top: size / 2 + 6,
            transform: `translateZ(${labelOffset}px) rotateY(${-rotationY}deg) rotateX(${-rotationX}deg)`,
            transformStyle: 'preserve-3d',
          }}
        >
          {t('cesiumGeo.axisHelper.labelY')}
        </div>

        {/* Origin point */}
        <div
          className="absolute w-2 h-2 bg-white rounded-full border border-gray-400"
          style={{
            left: size / 2 - 4,
            top: size / 2 - 4,
          }}
        />
      </div>
    </div>
  );
});

AxisHelper.displayName = 'AxisHelper';
