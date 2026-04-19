/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cap-surface appearance controls shown inside the expanded Section panel.
 * Lets the user pick the hatch pattern, colours, and spacing for the filled
 * cut surface the renderer draws on top of the model.
 */

import { useCallback, useId } from 'react';
import { useViewerStore } from '@/store';
import type { SectionCapHatchId } from '@/store/types';

const PATTERN_LABELS: Record<SectionCapHatchId, string> = {
  solid:      'Solid fill',
  diagonal:   'Diagonal',
  crossHatch: 'Cross-hatch',
  horizontal: 'Horizontal',
  vertical:   'Vertical',
  concrete:   'Concrete',
  brick:      'Brick',
  insulation: 'Insulation',
};

const PATTERN_IDS: SectionCapHatchId[] = [
  'diagonal', 'crossHatch', 'horizontal', 'vertical',
  'concrete', 'brick', 'insulation', 'solid',
];

function rgbaToHex(c: [number, number, number, number]): string {
  const to2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${to2(c[0])}${to2(c[1])}${to2(c[2])}`;
}

function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1, alpha];
  return [
    parseInt(m[1], 16) / 255,
    parseInt(m[2], 16) / 255,
    parseInt(m[3], 16) / 255,
    alpha,
  ];
}

export function SectionCapControls(): React.JSX.Element {
  const sectionPlane   = useViewerStore((s) => s.sectionPlane);
  const setShowCap     = useViewerStore((s) => s.setSectionShowCap);
  const setCapStyle    = useViewerStore((s) => s.setSectionCapStyle);

  const onPattern = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setCapStyle({ pattern: e.target.value as SectionCapHatchId });
  }, [setCapStyle]);

  const onFillColor = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCapStyle({ fillColor: hexToRgba(e.target.value, sectionPlane.capStyle.fillColor[3]) });
  }, [setCapStyle, sectionPlane.capStyle.fillColor]);

  const onStrokeColor = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCapStyle({ strokeColor: hexToRgba(e.target.value, sectionPlane.capStyle.strokeColor[3]) });
  }, [setCapStyle, sectionPlane.capStyle.strokeColor]);

  const onSpacing = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setCapStyle({ spacingPx: Math.max(2, v) });
  }, [setCapStyle]);

  const onAngle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const deg = Number(e.target.value);
    if (Number.isFinite(deg)) setCapStyle({ angleRad: (deg * Math.PI) / 180 });
  }, [setCapStyle]);

  const onWidth = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setCapStyle({ widthPx: Math.max(1, v) });
  }, [setCapStyle]);

  const onToggleCap = useCallback(() => {
    setShowCap(!sectionPlane.showCap);
  }, [setShowCap, sectionPlane.showCap]);

  const angleDeg = Math.round((sectionPlane.capStyle.angleRad * 180) / Math.PI);

  // Stable ids for label/control association. Multiple instances of the
  // panel (rare, but possible during HMR) each get their own id namespace.
  const baseId = useId();
  const patternId = `${baseId}-pattern`;
  const fillId    = `${baseId}-fill`;
  const strokeId  = `${baseId}-stroke`;
  const spacingId = `${baseId}-spacing`;
  const angleId   = `${baseId}-angle`;
  const widthId   = `${baseId}-width`;

  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs text-muted-foreground">Cut surface</label>
        <button
          type="button"
          onClick={onToggleCap}
          className={`text-[10px] font-mono uppercase px-1.5 py-0.5 border ${
            sectionPlane.showCap
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-muted text-muted-foreground border-muted'
          }`}
          title={sectionPlane.showCap ? 'Hide filled cap' : 'Show filled cap'}
        >
          {sectionPlane.showCap ? 'On' : 'Off'}
        </button>
      </div>

      {sectionPlane.showCap && (
        <div className="space-y-2">
          <div>
            <label htmlFor={patternId} className="text-[10px] text-muted-foreground block mb-1">Hatch pattern</label>
            <select
              id={patternId}
              value={sectionPlane.capStyle.pattern}
              onChange={onPattern}
              className="w-full text-xs bg-muted px-1.5 py-1 rounded border-none"
            >
              {PATTERN_IDS.map((id) => (
                <option key={id} value={id}>{PATTERN_LABELS[id]}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={fillId} className="text-[10px] text-muted-foreground block mb-1">Fill</label>
              <input
                id={fillId}
                type="color"
                value={rgbaToHex(sectionPlane.capStyle.fillColor)}
                onChange={onFillColor}
                className="w-full h-6 rounded cursor-pointer"
              />
            </div>
            <div>
              <label htmlFor={strokeId} className="text-[10px] text-muted-foreground block mb-1">Hatch</label>
              <input
                id={strokeId}
                type="color"
                value={rgbaToHex(sectionPlane.capStyle.strokeColor)}
                onChange={onStrokeColor}
                className="w-full h-6 rounded cursor-pointer"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor={spacingId} className="text-[10px] text-muted-foreground block mb-1">Spacing (px)</label>
              <input
                id={spacingId}
                type="number"
                min="2"
                max="64"
                step="1"
                value={sectionPlane.capStyle.spacingPx}
                onChange={onSpacing}
                className="w-full text-xs bg-muted px-1.5 py-0.5 rounded border-none text-right"
              />
            </div>
            <div>
              <label htmlFor={angleId} className="text-[10px] text-muted-foreground block mb-1">Angle (°)</label>
              <input
                id={angleId}
                type="number"
                min="-180"
                max="180"
                step="5"
                value={angleDeg}
                onChange={onAngle}
                className="w-full text-xs bg-muted px-1.5 py-0.5 rounded border-none text-right"
              />
            </div>
            <div>
              <label htmlFor={widthId} className="text-[10px] text-muted-foreground block mb-1">Width (px)</label>
              <input
                id={widthId}
                type="number"
                min="1"
                max="16"
                step="0.5"
                value={sectionPlane.capStyle.widthPx}
                onChange={onWidth}
                className="w-full text-xs bg-muted px-1.5 py-0.5 rounded border-none text-right"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SectionCapControls;
