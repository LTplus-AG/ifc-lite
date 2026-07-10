/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour analytics. All events go through the scrub-safe `lib/analytics`
 * client; payloads are ids from our own registries, enums, and numbers -
 * never file or model names.
 *
 * `tour_step_broken` is the rot alarm: a PostHog insight grouped by
 * `anchor_id` (excluding the non-rot reasons) replaces any CI anchor check.
 */

import { posthog } from '@/lib/analytics';
import type { TourAbortReason, TourBrokenReason, TourId, TourSource } from './types';

export function trackTourStarted(tourId: TourId, source: TourSource): void {
  posthog.capture('tour_started', { tour_id: tourId, source });
}

export function trackStepCompleted(
  tourId: TourId,
  stepId: string,
  stepIndex: number,
  gated: boolean,
  durationMs: number,
): void {
  posthog.capture('tour_step_completed', {
    tour_id: tourId,
    step_id: stepId,
    step_index: stepIndex,
    gated,
    duration_ms: Math.round(durationMs),
  });
}

export function trackStepSkipped(
  tourId: TourId,
  stepId: string,
  stepIndex: number,
  afterHint: boolean,
): void {
  posthog.capture('tour_step_skipped', {
    tour_id: tourId,
    step_id: stepId,
    step_index: stepIndex,
    after_hint: afterHint,
  });
}

export function trackStepBroken(
  tourId: TourId,
  stepId: string,
  stepIndex: number,
  anchorId: string | undefined,
  reason: TourBrokenReason,
): void {
  posthog.capture('tour_step_broken', {
    tour_id: tourId,
    step_id: stepId,
    step_index: stepIndex,
    anchor_id: anchorId ?? 'none',
    reason,
  });
}

export function trackDemoLoaded(tourId: TourId): void {
  posthog.capture('tour_demo_loaded', { tour_id: tourId });
}

export function trackTourCompleted(tourId: TourId, durationMs: number, stepsSkipped: number): void {
  posthog.capture('tour_completed', {
    tour_id: tourId,
    duration_ms: Math.round(durationMs),
    steps_skipped: stepsSkipped,
  });
}

export function trackTourAbandoned(
  tourId: TourId,
  stepId: string | undefined,
  stepIndex: number,
  reason: TourAbortReason,
): void {
  posthog.capture('tour_abandoned', {
    tour_id: tourId,
    step_id: stepId ?? 'none',
    step_index: stepIndex,
    reason,
  });
}
