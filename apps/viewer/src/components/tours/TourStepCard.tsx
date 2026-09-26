/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tour step card. Two modes:
 * - anchored: positioned next to the spotlit target via floating-ui
 *   (animationFrame autoUpdate - plain autoUpdate misses pure layout shift);
 * - docked: bottom-center of the viewport for canvas steps and as the
 *   fallback when the anchor unmounted mid-step.
 *
 * The card is the only pointer-events-auto element in the tour layer.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computePosition, autoUpdate, offset, flip, shift, type Placement } from '@floating-ui/dom';
import { X } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { isTextEntryElement } from '@/lib/keyboard-event';
import { abortTour, nextStep, runStepAction, skipStep } from '@/lib/tours/controller';
import { useTourStore } from '@/lib/tours/tour-store';
import type { TourDefinition, TourStep } from '@/lib/tours/types';

interface TourStepCardProps {
  tour: TourDefinition;
  step: TourStep;
  stepIndex: number;
  targetEl: HTMLElement | null;
}

function useAnchoredPosition(targetEl: HTMLElement | null, placement: Placement) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [lost, setLost] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    setPos(null);
    setLost(false);
    if (!el || !targetEl) return;
    const update = () => {
      if (!targetEl.isConnected) {
        setLost(true);
        return;
      }
      void computePosition(targetEl, el, {
        placement,
        strategy: 'fixed',
        middleware: [offset(12), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => setPos({ x, y }));
    };
    return autoUpdate(targetEl, el, update, { animationFrame: true });
  }, [targetEl, placement]);

  return { ref, pos, lost };
}

export function TourStepCard({ tour, step, stepIndex, targetEl }: TourStepCardProps) {
  const { t } = useTranslation();
  const hintVisible = useTourStore((s) => s.hintVisible);
  const gateBroken = useTourStore((s) => s.gateBroken);
  const redockedPanel = useTourStore((s) => s.redockedPanel);
  const demoLoading = useTourStore((s) => s.demoLoading);

  const anchored = step.kind !== 'canvas' && targetEl !== null;
  const { ref, pos, lost } = useAnchoredPosition(anchored ? targetEl : null, step.placement ?? 'bottom');
  const docked = !anchored || lost;

  // Move keyboard focus onto the card when the step changes so Tab lands on
  // the card controls, without stealing focus from an input mid-typing.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isTextEntryElement(document.activeElement)) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [stepIndex]);

  const showNext = !step.gate || gateBroken;
  const total = tour.steps.length;

  return (
    // This nonmodal anchored tour card uses the existing div for its measured position.
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <div role="dialog"
      ref={(el) => {
        ref.current = el;
        cardRef.current = el;
      }}
      aria-label={t('tours.tourStepCard.ariaLabel', { step: stepIndex + 1, total, title: step.title })}
      tabIndex={-1}
      className={cn(
        'pointer-events-auto w-80 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none',
        docked
          ? 'fixed bottom-12 left-1/2 -translate-x-1/2'
          : 'fixed',
        anchored && !docked && pos === null && 'invisible',
      )}
      style={anchored && !docked && pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          {tour.steps.map((s, i) => (
            <span
              key={s.id}
              className={cn(
                'h-1.5 w-1.5 rounded-full transition-colors',
                i === stepIndex ? 'bg-primary' : i < stepIndex ? 'bg-primary/40' : 'bg-muted-foreground/25',
              )}
            />
          ))}
        </div>
        <IconButton
          label={t('tours.tourStepCard.endTourAriaLabel')}
          size="icon-xs"
          onClick={() => abortTour('close')}
          className="-mr-1.5 -mt-1.5 text-muted-foreground"
        >
          <X />
        </IconButton>
      </div>

      <div className="mt-1.5 text-sm font-semibold">{step.title}</div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.body}</p>

      {redockedPanel && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('tours.tourStepCard.redockedNotice')}
        </p>
      )}
      {hintVisible && !showNext && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('tours.tourStepCard.stuckHint')}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {stepIndex + 1} / {total}
        </span>
        <div className="flex items-center gap-1.5">
          {step.action && (
            <Button
              variant="outline"
              size="sm"
              disabled={demoLoading}
              onClick={() => void runStepAction()}
            >
              {demoLoading && <Spinner />}
              {step.action.label}
            </Button>
          )}
          <Button
            variant={hintVisible && !showNext ? 'secondary' : 'ghost'}
            size="sm"
            className="text-muted-foreground"
            onClick={skipStep}
          >
            {t('tours.tourStepCard.skipStep')}
          </Button>
          {showNext && (
            <Button size="sm" onClick={nextStep}>
              {stepIndex + 1 === total ? t('tours.tourStepCard.done') : t('tours.tourStepCard.next')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
