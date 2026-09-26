/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Spinner } from '@/components/ui/spinner';

/**
 * Single mount point for the tour UI (ViewerLayout's global-overlays block).
 *
 * Layering: portal to document.body at z-40 - above floating panels (z-30),
 * below dialogs / dropdowns / the command palette (z-50), so action steps
 * that open those surfaces keep them interactive and un-dimmed. The layer is
 * pointer-events-none; only the step card re-enables pointer events.
 */

import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { cancelPrereq, confirmPrereqWithDemo } from '@/lib/tours/controller';
import { getTour } from '@/lib/tours/registry';
import { useTourStore } from '@/lib/tours/tour-store';
import type { TourDefinition } from '@/lib/tours/types';
import { TourSpotlight } from './TourSpotlight';
import { TourStepCard } from './TourStepCard';

function PrereqCard({ tour }: { tour: TourDefinition }) {
  const { t } = useTranslation();
  const demoLoading = useTourStore((s) => s.demoLoading);
  const needsSecond = Boolean(tour.prerequisites?.secondModel);
  const needsStack = Boolean(tour.prerequisites?.layerStack);
  return (
    <div
      role="dialog"
      aria-label={t('tours.tourHost.prereqAriaLabel', { title: tour.title })}
      className="pointer-events-auto fixed left-1/2 top-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <div className="text-sm font-semibold">{tour.title}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        {needsStack
          ? t('tours.tourHost.prereqLayerStack')
          : needsSecond
            ? t('tours.tourHost.prereqSecondModel')
            : t('tours.tourHost.prereqModel')}
      </p>
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={cancelPrereq} disabled={demoLoading}>
          {t('tours.tourHost.cancel')}
        </Button>
        <Button size="sm" disabled={demoLoading} onClick={() => void confirmPrereqWithDemo()}>
          {demoLoading && <Spinner />}
          {needsStack ? t('tours.tourHost.loadDemoStack') : t('tours.tourHost.loadDemoProject')}
        </Button>
      </div>
    </div>
  );
}

export function TourHost() {
  const status = useTourStore((s) => s.status);
  const tourId = useTourStore((s) => s.tourId);
  const stepIndex = useTourStore((s) => s.stepIndex);
  const stepPhase = useTourStore((s) => s.stepPhase);
  const targetEl = useTourStore((s) => s.targetEl);

  if (status === 'idle' || !tourId) return null;
  const tour = getTour(tourId);
  if (!tour) return null;
  const step = tour.steps[stepIndex];

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-40">
      {status === 'prereq' && <PrereqCard tour={tour} />}
      {status === 'running' && step && stepPhase === 'active' && (
        <>
          {step.kind !== 'canvas' && targetEl && <TourSpotlight targetEl={targetEl} />}
          <TourStepCard tour={tour} step={step} stepIndex={stepIndex} targetEl={targetEl} />
        </>
      )}
    </div>,
    document.body,
  );
}
