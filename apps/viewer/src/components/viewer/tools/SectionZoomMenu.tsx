/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact zoom on the Section bar (#7545): what to frame (the selection, the part of
 * the model the planes leave, the whole model) and how much room to leave around it
 * (a percentage of its largest extent, or a length in metres). The last choice is
 * remembered, so the next Zoom is one click. "Selection" is the remembered choice only while
 * something is selected: with nothing selected it is shown as unavailable (with the reason) and the
 * menu frames the cut area instead, rather than opening on a button that cannot be pressed.
 */

import { useState } from 'react';
import { ChevronDown, ZoomIn } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useLiveTestId } from './SectionBarMeasure';
import { HudPopover, HudPopoverContent, HudPopoverTrigger } from '../../viewport-ui/hud';
import { parseTypedNumber } from '../../viewport-ui/hud/HudValueField';
import { zoomToSectionTarget } from '@/lib/section/section-zoom';
import { MAX_ZOOM_MARGIN_FRACTION, type SectionZoomMargin, type SectionZoomTarget } from '@/lib/section/section-zoom-spec';

const TARGETS: readonly SectionZoomTarget[] = ['selection', 'cut-region', 'model'];
const TARGET_KEY = { selection: 'selection', 'cut-region': 'cutRegion', model: 'model' } as const;

/** The margin as the field shows it: a percentage for a fraction, metres for a length. */
const shown = (m: SectionZoomMargin) => String(Number((m.kind === 'fraction' ? m.value * 100 : m.value).toFixed(3)));

export function SectionZoomMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const spec = useViewerStore((s) => s.sectionZoom);
  const setSpec = useViewerStore((s) => s.setSectionZoom);
  const hasSelection = useViewerStore((s) => s.selectedEntityId !== null || s.selectedEntityIds.size > 0);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => shown(spec.margin));
  const [nothing, setNothing] = useState(false);
  const triggerTestId = useLiveTestId('section-zoom');

  const typedNumber = parseTypedNumber(text);
  const parsed = typedNumber ?? Number.NaN;
  const valid = typedNumber !== null && parsed >= 0 && (spec.margin.kind === 'metres' || parsed / 100 <= MAX_ZOOM_MARGIN_FRACTION);
  // The remembered target, unless it is the selection and nothing is selected: then the cut area.
  const target: SectionZoomTarget = spec.target === 'selection' && !hasSelection ? 'cut-region' : spec.target;

  const setKind = (kind: SectionZoomMargin['kind']) => {
    if (kind === spec.margin.kind) return;
    // 10 % <-> 0.1 m would be nonsense; switching unit keeps the number, which is what the field shows.
    const value = valid ? (kind === 'fraction' ? parsed / 100 : parsed) : spec.margin.value;
    setSpec({ ...spec, margin: { kind, value } });
    setText(shown({ kind, value }));
  };

  const apply = async () => {
    if (!valid) return;
    const margin: SectionZoomMargin = { kind: spec.margin.kind, value: spec.margin.kind === 'fraction' ? parsed / 100 : parsed };
    setSpec({ ...spec, margin });
    const done = await zoomToSectionTarget(useViewerStore.getState(), { target, margin });
    setNothing(!done);
    if (done) setOpen(false);
  };

  return (
    <HudPopover open={open} onOpenChange={(v) => { setOpen(v); if (v) setNothing(false); }}>
      <HudPopoverTrigger asChild>
        <button
          type="button"
          title={t('sectionPlanes.zoom.title')}
          aria-label={t('sectionPlanes.zoom.label')}
          data-testid={triggerTestId}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent"
        >
          <ZoomIn aria-hidden className="h-3.5 w-3.5" />
          {!compact && t('sectionPlanes.zoom.label')}
          <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
        </button>
      </HudPopoverTrigger>
      <HudPopoverContent align="center" side="bottom" className="w-60 space-y-2 p-2" data-testid="section-zoom-menu" aria-label={t('sectionPlanes.zoom.label')}>
        <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
          <legend className="sr-only">{t('sectionPlanes.zoom.targetAria')}</legend>
          {TARGETS.map((option) => {
            const unavailable = option === 'selection' && !hasSelection;
            return (
              <label
                key={option}
                title={unavailable ? t('sectionPlanes.zoom.needSelection') : undefined}
                className={cn(
                  'rounded-sm px-2 py-1 text-left text-xs has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring',
                  unavailable ? 'cursor-not-allowed text-muted-foreground opacity-60' : 'cursor-pointer',
                  target === option ? 'bg-overlay-accent-soft text-overlay-accent' : !unavailable && 'hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <input
                  type="radio"
                  name="section-zoom-target"
                  className="sr-only"
                  checked={target === option}
                  disabled={unavailable}
                  onChange={() => { setSpec({ ...spec, target: option }); setNothing(false); }}
                />
                {t(`sectionPlanes.zoom.target.${TARGET_KEY[option]}`)}
                {unavailable && <span className="block text-2xs">{t('sectionPlanes.zoom.needSelection')}</span>}
              </label>
            );
          })}
        </fieldset>
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          {t('sectionPlanes.zoom.margin')}
          <input
            type="text"
            inputMode="decimal"
            value={text}
            aria-label={t('sectionPlanes.zoom.marginAria')}
            aria-invalid={!valid}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void apply(); }}
            className="h-5 w-14 rounded-sm border border-border bg-background px-1 text-right text-xs tabular-nums text-foreground"
          />
          <fieldset className="m-0 inline-flex overflow-hidden rounded-sm border border-border p-0">
            <legend className="sr-only">{t('sectionPlanes.zoom.unitAria')}</legend>
            {(['fraction', 'metres'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={spec.margin.kind === kind}
                onClick={() => setKind(kind)}
                className={cn('px-1.5 text-xs', spec.margin.kind === kind ? 'bg-overlay-accent-soft text-overlay-accent' : 'hover:bg-accent hover:text-accent-foreground')}
              >
                {t(kind === 'fraction' ? 'sectionTool.distance.percentUnit' : 'sectionTool.distance.unit')}
              </button>
            ))}
          </fieldset>
        </label>
        <button
          type="button"
          disabled={!valid}
          onClick={() => void apply()}
          className="w-full rounded-sm bg-overlay-accent-soft px-2 py-1 text-xs font-medium text-overlay-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('sectionPlanes.zoom.apply')}
        </button>
        {nothing && <output className="block text-2xs text-muted-foreground">{t('sectionPlanes.zoom.nothing')}</output>}
      </HudPopoverContent>
    </HudPopover>
  );
}
