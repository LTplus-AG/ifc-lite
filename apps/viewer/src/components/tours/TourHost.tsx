/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single mount point for the tour UI (ViewerLayout's global-overlays block).
 *
 * Layering: portal to document.body at z-40 - above floating panels (z-30),
 * below dialogs / dropdowns / the command palette (z-50), so action steps
 * that open those surfaces keep them interactive and un-dimmed. The layer is
 * pointer-events-none; only the step card re-enables pointer events.
 */

import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cancelPrereq, confirmPrereqWithDemo } from '@/lib/tours/controller';
import { getTour } from '@/lib/tours/registry';
import { useTourStore } from '@/lib/tours/tour-store';
import type { TourDefinition } from '@/lib/tours/types';
import { TourSpotlight } from './TourSpotlight';
import { TourStepCard } from './TourStepCard';

function PrereqCard({ tour }: { tour: TourDefinition }) {
  const demoLoading = useTourStore((s) => s.demoLoading);
  const needsSecond = Boolean(tour.prerequisites?.secondModel);
  const needsStack = Boolean(tour.prerequisites?.layerStack);
  return (
    <div
      role="dialog"
      aria-label={`${tour.title}: prerequisites`}
      className="pointer-events-auto fixed left-1/2 top-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <div className="text-sm font-semibold">{tour.title}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        {needsStack
          ? 'This tour needs a composed layer stack. Load the demo stack (three tiny layers) to follow along.'
          : needsSecond
            ? 'This tour needs two loaded revisions of a model. Load the demo project to follow along.'
            : 'This tour needs a loaded model. Load the demo project to follow along, or open your own IFC file first.'}
      </p>
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={cancelPrereq} disabled={demoLoading}>
          Cancel
        </Button>
        <Button size="sm" disabled={demoLoading} onClick={() => void confirmPrereqWithDemo()}>
          {demoLoading && <Loader2 className="animate-spin" />}
          {needsStack ? 'Load demo stack' : 'Load demo project'}
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
