/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud rendering controls (color mode, size mode, point size, EDL)
 * plus the BIM↔scan deviation heatmap. Docked in the sidebar's `pointclouds`
 * side panel (#5507) — renders only when point cloud assets are loaded; the
 * activity bar hides the panel's rail icon otherwise. Used to be a floating
 * card pinned at `bottom-4 left-4`, which collided with the axis/scale
 * cluster in that corner.
 */

import { Scan, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import type { PointColorModeUi, PointSizeModeUi } from '@/store/slices/pointCloudSlice';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { PointCloudLegend } from './PointCloudLegend';
import { PointCloudClasses } from './PointCloudClasses';
import { DeviationPanel } from './DeviationPanel';
import { applyPointCloudAlignmentToggle } from '@/hooks/ingest/pointCloudAlignment';
import { getGlobalRenderer } from '@/hooks/useBCF';

const COLOR_MODES: Array<{ value: PointColorModeUi; labelKey: TranslationKey; hintKey: TranslationKey }> = [
  { value: 'rgb',            labelKey: 'pointCloudPanel.colorMode.rgb.label',            hintKey: 'pointCloudPanel.colorMode.rgb.hint' },
  { value: 'classification', labelKey: 'pointCloudPanel.colorMode.classification.label', hintKey: 'pointCloudPanel.colorMode.classification.hint' },
  { value: 'intensity',      labelKey: 'pointCloudPanel.colorMode.intensity.label',      hintKey: 'pointCloudPanel.colorMode.intensity.hint' },
  { value: 'height',         labelKey: 'pointCloudPanel.colorMode.height.label',         hintKey: 'pointCloudPanel.colorMode.height.hint' },
  { value: 'fixed',          labelKey: 'pointCloudPanel.colorMode.fixed.label',          hintKey: 'pointCloudPanel.colorMode.fixed.hint' },
  { value: 'deviation',      labelKey: 'pointCloudPanel.colorMode.deviation.label',      hintKey: 'pointCloudPanel.colorMode.deviation.hint' },
];

const SIZE_MODES: Array<{ value: PointSizeModeUi; labelKey: TranslationKey; hintKey: TranslationKey }> = [
  { value: 'fixed-px',       labelKey: 'pointCloudPanel.sizeMode.fixedPx.label',       hintKey: 'pointCloudPanel.sizeMode.fixedPx.hint' },
  { value: 'attenuated',     labelKey: 'pointCloudPanel.sizeMode.attenuated.label',     hintKey: 'pointCloudPanel.sizeMode.attenuated.hint' },
  { value: 'adaptive-world', labelKey: 'pointCloudPanel.sizeMode.adaptiveWorld.label',  hintKey: 'pointCloudPanel.sizeMode.adaptiveWorld.hint' },
];

export interface PointCloudPanelProps {
  /** Number of currently-loaded point cloud assets — panel hides when 0. */
  assetCount: number;
  /** Total triangle count across the scene (gates the BIM↔scan deviation
   *  compute button — useless without a BIM model loaded). */
  triangleCount: number;
  /** Docked-panel close handler. Omitted in standalone/test renders, where
   *  the header simply carries no close button. */
  onClose?: () => void;
}

export function PointCloudPanel({ assetCount, triangleCount, onClose }: PointCloudPanelProps) {
  const { t } = useTranslation();
  const colorMode = useViewerStore((s) => s.pointCloudColorMode);
  const setColorMode = useViewerStore((s) => s.setPointCloudColorMode);
  const sizeMode = useViewerStore((s) => s.pointCloudSizeMode);
  const setSizeMode = useViewerStore((s) => s.setPointCloudSizeMode);
  const pointSize = useViewerStore((s) => s.pointCloudPointSize);
  const setPointSize = useViewerStore((s) => s.setPointCloudPointSize);
  const worldRadius = useViewerStore((s) => s.pointCloudWorldRadius);
  const setWorldRadius = useViewerStore((s) => s.setPointCloudWorldRadius);
  const edlEnabled = useViewerStore((s) => s.pointCloudEdlEnabled);
  const setEdlEnabled = useViewerStore((s) => s.setPointCloudEdlEnabled);
  const edlStrength = useViewerStore((s) => s.pointCloudEdlStrength);
  const setEdlStrength = useViewerStore((s) => s.setPointCloudEdlStrength);
  const fixedColor = useViewerStore((s) => s.pointCloudFixedColor);
  const setFixedColor = useViewerStore((s) => s.setPointCloudFixedColor);
  const deviationComputed = useViewerStore((s) => s.pointCloudDeviationComputed);
  const alignmentAvailable = useViewerStore((s) => s.pointCloudAlignmentAvailable);
  const alignmentEnabled = useViewerStore((s) => s.pointCloudAlignmentEnabled);
  const setAlignmentEnabled = useViewerStore((s) => s.setPointCloudAlignmentEnabled);

  if (assetCount <= 0) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <Scan className="h-4 w-4 text-teal-600" />
        <span className="font-medium text-sm">{t('pointCloudPanel.title')}</span>
        <span className="text-2xs text-muted-foreground">
          {t('pointCloudPanel.assetCount', { count: assetCount })}
        </span>
        <span className="flex-1" />
        {onClose && (
          <IconButton label={t('pointCloudPanel.close')} variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">

      {/* Color mode */}
      <div className="flex flex-col gap-0.5">
        <span className="text-2xs uppercase text-muted-foreground tracking-wider">{t('pointCloudPanel.colourSectionLabel')}</span>
        {COLOR_MODES.map((mode) => {
          const active = colorMode === mode.value;
          return (
            <button
              key={mode.value}
              aria-pressed={active}
              onClick={() => setColorMode(mode.value)}
              title={t(mode.hintKey)}
              className={cn(
                'flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors text-left',
                active
                  ? 'bg-teal-600 text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {t(mode.labelKey)}
            </button>
          );
        })}
        <PointCloudLegend colorMode={colorMode} />
        {colorMode === 'deviation' && !deviationComputed && (
          // Selecting the Deviation colour mode only tells the shader to
          // read the per-point deviation buffer — it does NOT run the
          // compare. Until "Compute deviation" runs, that buffer is all
          // zeros, so every point maps to the ramp centre (grey). Nudge
          // the user toward the compute button below.
          <span className="text-2xs text-amber-500 px-2 leading-tight">
            {triangleCount > 0
              ? t('pointCloudPanel.deviation.computeHint')
              : t('pointCloudPanel.deviation.needsModelHint')}
          </span>
        )}
        {colorMode === 'fixed' && (
          // Native colour input — keeps the panel dependency-free.
          // Hex round-trips through float[0..1]: parse `#rrggbb` to a
          // [r,g,b,1] tuple on input, format the active rgb back to hex
          // on display. Alpha stays 1 since fixed-mode opacity is
          // controlled by the splat shape, not the colour swatch.
          <label className="flex items-center justify-between gap-2 mt-1 px-2 py-1 rounded bg-muted/40">
            <span className="text-2xs text-muted-foreground">{t('pointCloudPanel.solidColourLabel')}</span>
            <input
              type="color"
              value={rgbToHex(fixedColor)}
              onChange={(e) => setFixedColor(hexToRgba(e.target.value, fixedColor[3]))}
              aria-label={t('pointCloudPanel.solidColourPickerAriaLabel')}
              className="h-6 w-10 rounded border-0 cursor-pointer bg-transparent"
            />
          </label>
        )}
      </div>

      {/* IfcMapConversion alignment (issue #1804) — hidden entirely when
          no loaded model has a usable map conversion; there's nothing
          to toggle in that case. */}
      {alignmentAvailable && (
        <label className="flex items-center justify-between gap-2 cursor-pointer px-2 py-1 rounded bg-muted/40">
          <span
            className="text-2xs text-muted-foreground"
            title={t('pointCloudPanel.alignToModel.hint')}
          >
            {t('pointCloudPanel.alignToModel.label')}
          </span>
          <input
            type="checkbox"
            checked={alignmentEnabled}
            onChange={(e) => {
              const enabled = e.target.checked;
              setAlignmentEnabled(enabled);
              applyPointCloudAlignmentToggle(getGlobalRenderer(), enabled);
            }}
            className="accent-teal-600"
            title={t('pointCloudPanel.alignToModel.checkboxTitle')}
          />
        </label>
      )}

      {/* Per-ASPRS-class visibility — toggles the splat shader's
          class-mask uniform; works in any colour mode but most
          discoverable when colorMode === 'classification'. */}
      <PointCloudClasses />

      {/* Size mode */}
      <div className="flex flex-col gap-0.5">
        <span className="text-2xs uppercase text-muted-foreground tracking-wider">{t('pointCloudPanel.sizeSectionLabel')}</span>
        <div className="grid grid-cols-3 gap-0.5">
          {SIZE_MODES.map((mode) => {
            const active = sizeMode === mode.value;
            return (
              <button
                key={mode.value}
                aria-pressed={active}
                onClick={() => setSizeMode(mode.value)}
                title={t(mode.hintKey)}
                className={cn(
                  'px-1.5 py-1 rounded text-2xs transition-colors',
                  active
                    ? 'bg-teal-600 text-white'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {t(mode.labelKey)}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 mt-1">
          <span className="text-2xs text-muted-foreground w-8 shrink-0">{t('pointCloudPanel.pointSizePx', { value: pointSize.toFixed(0) })}</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={pointSize}
            onChange={(e) => setPointSize(Number(e.target.value))}
            className="flex-1 h-1 accent-teal-600 cursor-pointer"
            title={t('pointCloudPanel.splatSizeTitle')}
          />
        </label>
        {sizeMode !== 'fixed-px' && (
          <label className="flex items-center gap-2">
            <span className="text-2xs text-muted-foreground w-8 shrink-0">
              {t('pointCloudPanel.worldRadiusMm', { value: (worldRadius * 1000).toFixed(0) })}
            </span>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={Math.round(worldRadius * 1000)}
              onChange={(e) => setWorldRadius(Number(e.target.value) / 1000)}
              className="flex-1 h-1 accent-teal-600 cursor-pointer"
              title={t('pointCloudPanel.worldRadiusTitle')}
            />
          </label>
        )}
      </div>

      {/* EDL */}
      <div className="flex flex-col gap-0.5">
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-2xs uppercase text-muted-foreground tracking-wider">{t('pointCloudPanel.edlSectionLabel')}</span>
          <input
            type="checkbox"
            checked={edlEnabled}
            onChange={(e) => setEdlEnabled(e.target.checked)}
            className="accent-teal-600"
            title={t('pointCloudPanel.edlCheckboxTitle')}
          />
        </label>
        {edlEnabled && (
          <label className="flex items-center gap-2">
            <span className="text-2xs text-muted-foreground w-8 shrink-0">
              {edlStrength.toFixed(1)}
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={edlStrength}
              onChange={(e) => setEdlStrength(Number(e.target.value))}
              className="flex-1 h-1 accent-teal-600 cursor-pointer"
              title={t('pointCloudPanel.edlStrengthTitle')}
            />
          </label>
        )}
      </div>

      {/* BIM↔scan deviation heatmap — only useful when both meshes
          and points are loaded. The panel renders nothing when there
          are no triangles in the scene. */}
      <DeviationPanel triangleCount={triangleCount} />
      </div>
    </div>
  );
}

function rgbToHex([r, g, b]: [number, number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
  // Browsers always emit "#rrggbb" from <input type="color">, so we
  // can skip the 3-char shorthand path. Parse byte-by-byte and divide.
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b, alpha];
}
