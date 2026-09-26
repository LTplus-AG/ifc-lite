/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `TourStepCard` is a coachmark, not a dialog: it must stay non-modal (no
 * focus trap — the spotlit target underneath it stays interactive) while
 * still exposing its accessible name correctly (#5817). It used to set
 * `aria-label` directly; this asserts the `aria-labelledby` wiring —
 * pointing at a real element, resolving to the same "step N of total:
 * title" text — and that nothing added a focus trap or `aria-modal`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { getTour } from '@/lib/tours/registry';
import { useTourStore } from '@/lib/tours/tour-store';
import { toursEn } from '@/i18n/catalogues/tours.en';
import { TourStepCard } from './TourStepCard.js';

afterEach(() => {
  cleanup();
  useTourStore.setState({ hintVisible: false, gateBroken: false });
});

describe('TourStepCard stays a non-modal coachmark (#5817)', () => {
  it('resolves its accessible name via aria-labelledby, not a duplicated aria-label', () => {
    const tour = getTour('welcome')!;
    const step = tour.steps.find((s) => s.id === 'orbit')!;
    const container = render(
      <TourStepCard tour={tour} step={step} stepIndex={1} targetEl={null} />,
    );
    const card = container.querySelector('[role="dialog"]');
    assert.ok(card, 'the card renders with role=dialog');
    assert.equal(card!.hasAttribute('aria-label'), false, 'no duplicated aria-label string');

    const labelledBy = card!.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'expected aria-labelledby');
    const labelEl = container.querySelector(`#${labelledBy}`);
    assert.ok(labelEl, 'aria-labelledby must reference a real element in the card');

    const expected = toursEn['tours.tourStepCard.ariaLabel']
      .replace('{step}', '2')
      .replace('{total}', String(tour.steps.length))
      .replace('{title}', step.title);
    assert.equal(labelEl!.textContent, expected);
  });

  it('never sets aria-modal or a tabindex-trapping wrapper — it stays a coachmark, not a Radix dialog', () => {
    const tour = getTour('welcome')!;
    const step = tour.steps.find((s) => s.id === 'orbit')!;
    const container = render(
      <TourStepCard tour={tour} step={step} stepIndex={0} targetEl={null} />,
    );
    const card = container.querySelector('[role="dialog"]')!;
    assert.equal(card.getAttribute('aria-modal'), null, 'a coachmark must not claim aria-modal');
    // No Radix overlay/portal artifacts — this card renders in place.
    assert.equal(document.querySelector('[data-radix-popper-content-wrapper]'), null);
  });
});
