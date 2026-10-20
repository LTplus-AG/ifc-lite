/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cap-surface appearance, inside the Section bar's Cap popover (#5499):
 *
 *   Display   [Surfaces] [Lines]
 *   Fill      ■  [Uniform] [Element colour]
 *   Hatch     <pattern ▾>  ■
 *   Spacing / Angle / Width
 *
 * Each choice sits with the colour it uses: the fill source with the fill
 * colour, the hatch pattern with the hatch colour.
 *
 * Surfaces and Lines toggle independently (outlines only, a hatched fill,
 * or both); the hatch inputs are disabled while Surfaces is off. Styled as
 * the panels are — sans 12px labels, `tabular-nums` numbers, the shared
 * accent wash for a pressed toggle — never a bespoke mono/uppercase bar.
 */

import { useCallback, useId } from 'react';
import { useViewerStore } from '@/store';
import type { SectionCapHatchId, SectionCapStyle } from '@/store/types';
import { useTranslation, type TranslationKey } from '@/i18n';
import { HudToggle } from '../../viewport-ui/hud/HudToggle';
import { HudSegmented } from '../../viewport-ui/hud/HudSegmented';

type SectionCapFillMode = NonNullable<SectionCapStyle['fillMode']>;

const PATTERN_LABEL_KEYS: Record<SectionCapHatchId, TranslationKey> = {
  solid:      'sectionCap.pattern.solid',
  diagonal:   'sectionCap.pattern.diagonal',
  crossHatch: 'sectionCap.pattern.crossHatch',
  horizontal: 'sectionCap.pattern.horizontal',
  vertical:   'sectionCap.pattern.vertical',
  concrete:   'sectionCap.pattern.concrete',
  brick:      'sectionCap.pattern.brick',
  insulation: 'sectionCap.pattern.insulation',
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

const CAPTION = 'text-2xs font-medium uppercase tracking-wider text-muted-foreground';
const FIELD = 'w-full rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs tabular-nums outline-none focus:ring-1 focus:ring-ring';

export function SectionCapControls(): React.JSX.Element {
  const { t } = useTranslation();
  const sectionPlane       = useViewerStore((s) => s.sectionPlane);
  const setShowCap         = useViewerStore((s) => s.setSectionShowCap);
  const setShowOutlines    = useViewerStore((s) => s.setSectionShowOutlines);
  const setCapStyle        = useViewerStore((s) => s.setSectionCapStyle);

  const onPattern = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setCapStyle({ pattern: e.target.value as SectionCapHatchId });
  }, [setCapStyle]);

  const onFillMode = useCallback((mode: SectionCapFillMode) => {
    setCapStyle({ fillMode: mode });
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

  const onToggleCap      = useCallback(() => setShowCap(!sectionPlane.showCap), [setShowCap, sectionPlane.showCap]);
  const onToggleOutlines = useCallback(() => setShowOutlines(!sectionPlane.showOutlines), [setShowOutlines, sectionPlane.showOutlines]);

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

  const fillMode = sectionPlane.capStyle.fillMode ?? 'uniform';
  const hatchInputsDisabled = !sectionPlane.showCap;

  const swatch = 'h-5 w-5 shrink-0 cursor-pointer rounded-sm border border-border bg-transparent p-0';
  const ROW = 'flex items-center gap-2';
  const ROW_LABEL = `${CAPTION} w-14 shrink-0`;

  return (
    <div className="space-y-2" data-section-cap-controls>
      {/* Display toggles — surfaces and lines independently. */}
      <div className={ROW}>
        <span className={ROW_LABEL}>{t('sectionCap.display')}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <HudToggle pressed={sectionPlane.showCap} onPressedChange={onToggleCap}
            title={t(sectionPlane.showCap ? 'sectionCap.hideSurfaces' : 'sectionCap.showSurfaces')}>
            {t('sectionCap.surfaces')}
          </HudToggle>
          <HudToggle pressed={sectionPlane.showOutlines} onPressedChange={onToggleOutlines}
            title={t(sectionPlane.showOutlines ? 'sectionCap.hideLines' : 'sectionCap.showLines')}>
            {t('sectionCap.lines')}
          </HudToggle>
        </div>
      </div>

      {/* Surface look, disabled while surfaces are off. Each row pairs a choice with the colour it uses:
          the fill source with the fill colour, the hatch pattern with the hatch colour. */}
      <fieldset
        disabled={hatchInputsDisabled}
        className={`space-y-2 ${hatchInputsDisabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        <div className={ROW}>
          <span className={ROW_LABEL}>{t('sectionCap.fillLabel')}</span>
          <input
            id={fillId}
            type="color"
            value={rgbaToHex(sectionPlane.capStyle.fillColor)}
            onChange={onFillColor}
            className={swatch}
            aria-label={t('sectionCap.fillAriaLabel')}
            title={t(fillMode === 'element' ? 'sectionCap.fillColorFallbackTitle' : 'sectionCap.fillColorTitle')}
          />
          <HudSegmented<SectionCapFillMode>
            aria-label={t('sectionCap.fillMode')}
            value={fillMode}
            onChange={onFillMode}
            className="ml-auto"
            options={[
              { value: 'uniform', label: t('sectionCap.fillMode.uniform'), title: t('sectionCap.fillMode.uniformTitle') },
              { value: 'element', label: t('sectionCap.fillMode.element'), title: t('sectionCap.fillMode.elementTitle') },
            ]}
          />
        </div>

        <div className={ROW}>
          <label htmlFor={patternId} className={ROW_LABEL}>{t('sectionCap.patternLabel')}</label>
          <select
            id={patternId}
            value={sectionPlane.capStyle.pattern}
            onChange={onPattern}
            className={`${FIELD} min-w-0 flex-1`}
          >
            {PATTERN_IDS.map((id) => (
              <option key={id} value={id}>{t(PATTERN_LABEL_KEYS[id])}</option>
            ))}
          </select>
          <input
            id={strokeId}
            type="color"
            value={rgbaToHex(sectionPlane.capStyle.strokeColor)}
            onChange={onStrokeColor}
            className={swatch}
            aria-label={t('sectionCap.hatchAriaLabel')}
            title={t('sectionCap.hatchLabel')}
          />
        </div>

        <div className="grid grid-cols-3 gap-2 pt-0.5">
          <div>
            <label htmlFor={spacingId} className="mb-0.5 block text-2xs text-muted-foreground">{t('sectionCap.spacingLabel')}</label>
            <input id={spacingId} type="number" min="2" max="64" step="1" value={sectionPlane.capStyle.spacingPx} onChange={onSpacing} className={FIELD} />
          </div>
          <div>
            <label htmlFor={angleId} className="mb-0.5 block text-2xs text-muted-foreground">{t('sectionCap.angleLabel')}</label>
            <input id={angleId} type="number" min="-180" max="180" step="5" value={angleDeg} onChange={onAngle} className={FIELD} />
          </div>
          <div>
            <label htmlFor={widthId} className="mb-0.5 block text-2xs text-muted-foreground">{t('sectionCap.widthLabel')}</label>
            <input id={widthId} type="number" min="1" max="16" step="0.5" value={sectionPlane.capStyle.widthPx} onChange={onWidth} className={FIELD} />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

export default SectionCapControls;
