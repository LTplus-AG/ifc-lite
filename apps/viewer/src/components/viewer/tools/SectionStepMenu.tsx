/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offset step (#7545): how far one wheel notch, arrow key or stepper click
 * moves the plane. A `10 cm ▾` control beside the offset, with the usual steps
 * and a custom one in millimetres.
 */

import { useState } from 'react';
import { ChevronDown, Ruler } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useLiveTestId } from './SectionBarMeasure';
import { HudPopover, HudPopoverContent, HudPopoverTrigger } from '../../viewport-ui/hud';
import { parseTypedNumber } from '../../viewport-ui/hud/HudValueField';
import {
  MAX_SECTION_STEP_M,
  MIN_SECTION_STEP_M,
  SECTION_STEP_PRESETS_M,
  formatStep,
  useSectionStep,
} from './sectionStep';

export function SectionStepMenu() {
  const { t } = useTranslation();
  const stepM = useSectionStep((s) => s.stepM);
  const setStepM = useSectionStep((s) => s.setStepM);
  const [custom, setCustom] = useState('');
  const triggerTestId = useLiveTestId('section-step');
  const label = formatStep(stepM);

  const commitCustom = () => {
    const mm = parseTypedNumber(custom);
    if (mm !== null) setStepM(Math.min(MAX_SECTION_STEP_M, Math.max(MIN_SECTION_STEP_M, mm / 1000)));
    setCustom('');
  };

  return (
    <HudPopover>
      <HudPopoverTrigger asChild>
        <button
          type="button"
          title={t('sectionPlanes.step.title', { step: label })}
          aria-label={t('sectionPlanes.step.aria')}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent"
          data-testid={triggerTestId}
        >
          <Ruler aria-hidden className="h-3.5 w-3.5" />
          {label}
          <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
        </button>
      </HudPopoverTrigger>
      <HudPopoverContent align="center" side="bottom" className="w-40 p-1" data-testid="section-step-menu" aria-label={t('sectionPlanes.step.aria')}>
        <ul aria-label={t('sectionPlanes.step.aria')}>
          {SECTION_STEP_PRESETS_M.map((m) => (
            <li key={m}>
              <button
                type="button"
                aria-pressed={Math.abs(m - stepM) < 1e-9}
                onClick={() => setStepM(m)}
                className={cn(
                  'flex w-full rounded-sm px-2 py-1 text-left text-xs tabular-nums',
                  Math.abs(m - stepM) < 1e-9 ? 'bg-overlay-accent-soft text-overlay-accent' : 'hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {formatStep(m)}
              </button>
            </li>
          ))}
        </ul>
        <label className="mt-1 flex items-center gap-1 border-t border-border px-2 pt-1 text-2xs text-muted-foreground">
          {t('sectionPlanes.step.custom')}
          <input
            type="text"
            inputMode="decimal"
            value={custom}
            aria-label={t('sectionPlanes.step.customAria')}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitCustom();
            }}
            onBlur={() => custom && commitCustom()}
            className="h-5 w-12 rounded-sm border border-border bg-background px-1 text-xs tabular-nums text-foreground"
          />
        </label>
      </HudPopoverContent>
    </HudPopover>
  );
}
