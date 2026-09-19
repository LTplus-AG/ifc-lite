/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tour UI's own chrome reads the i18n catalogue (#4918 slice 5):
 * `LearnTab`, `PanelTourButton`, `TourHost`'s prerequisite card, `TourInvite`,
 * and `TourStepCard`.
 *
 * The oracle is a pseudo-locale that maps every `tours.en.ts` key to a
 * marked copy of its English text. Each component is mounted in a state
 * that surfaces its own chrome, the locale is switched live, and every
 * marked string that was readable in English must reappear marked. A label
 * left hardcoded, or a consumer that does not re-render on a locale switch,
 * fails here by name.
 *
 * `tour.title` / `tour.description` / `step.title` / `step.body` /
 * `step.action.label` come from `TOUR_REGISTRY` (real tour content, not a
 * literal in these components) and are deliberately excluded from the
 * translated-key assertions below, same reasoning as the command-palette
 * catalogue's tour entries.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { toursEn } from '@/i18n/catalogues/tours.en';
import { useTourStore, type TourUiState } from '@/lib/tours/tour-store';
import { getTour } from '@/lib/tours/registry';
import { LearnTab } from './LearnTab';
import { PanelTourButton } from './PanelTourButton';
import { TourHost } from './TourHost';
import { TourInvite } from './TourInvite';
import { TourStepCard } from './TourStepCard';

type TourKey = keyof typeof toursEn;
const KEYS = Object.keys(toursEn) as TourKey[];
const STATIC_KEYS = KEYS.filter((key) => !toursEn[key].includes('{'));

/** Key-specific pseudo translation; keeps every `{placeholder}` of the English text. */
const mark = (key: TourKey) => `⟦${key}|${toursEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels, plain text, and every reachable Radix `TooltipContent` string. */
function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => button.focus());
    addReadable(document.body, out);
    act(() => button.blur());
  }
  return out;
}

/** Assert that every English static key readable in `container` reappears
 *  marked once the pseudo-locale is active. */
function assertTranslates(container: HTMLElement, localeName: string, requiredKeys: TourKey[]): void {
  const english = readableStrings(container);
  for (const key of requiredKeys) {
    assert.ok(english.has(toursEn[key]), `${key}: expected English text to be visible before locale switch`);
  }
  registerLocale(localeName, PSEUDO);
  act(() => setLocale(localeName));
  const after = readableStrings(container);
  let sawAny = false;
  for (const key of STATIC_KEYS) {
    const text = toursEn[key];
    if (!english.has(text)) continue;
    sawAny = true;
    assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
  }
  assert.ok(sawAny, `expected at least one tours.* string to be visible in this render`);
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('LearnTab localization (#4918)', () => {
  it('translates the catalog description, completed badge, and start/replay buttons', () => {
    const container = render(<LearnTab onClose={() => {}} />);
    assertTranslates(container, 'tours-learntab-pseudo', [
      'tours.learnTab.description',
      'tours.learnTab.start',
    ]);
    const minutes = getTour('welcome')!.minutes;
    assert.ok(readableStrings(container).has(mark('tours.learnTab.minutes').replace('{count}', String(minutes))));
  });

  it('selects the singular duration form for the one-minute ribbon tour (#5000 review)', () => {
    registerLocale('tours-duration-plural', {
      'tours.learnTab.minutes': { one: 'ONE {count} minute', other: 'OTHER {count} minutes' },
    });
    act(() => setLocale('tours-duration-plural'));
    const container = render(<LearnTab onClose={() => {}} />);

    assert.ok(readableStrings(container).has('ONE 1 minute'));
  });
});

describe('PanelTourButton localization (#4918)', () => {
  it('translates the launcher aria-label and tooltip', () => {
    // Both of this component's keys are interpolated ('{title}' / '{count}'),
    // so they are excluded from STATIC_KEYS; assert the interpolated marked
    // form directly instead, the same way viewer-shell.i18n.test.tsx does
    // for ChunkErrorBoundary's `{label}` keys.
    const tour = getTour('bcf')!;
    const container = render(<PanelTourButton panelId="bcf" />);
    const button = container.querySelector('button')!;
    assert.equal(button.getAttribute('aria-label'), `Start tour: ${tour.title}`);
    act(() => button.focus());
    const englishTooltip = document.body.textContent ?? '';
    assert.ok(englishTooltip.includes(`${tour.title} (${tour.minutes} min tour)`));

    registerLocale('tours-panelbutton-pseudo', PSEUDO);
    act(() => setLocale('tours-panelbutton-pseudo'));
    assert.equal(
      button.getAttribute('aria-label'),
      `⟦tours.panelTourButton.startAriaLabel|Start tour: ${tour.title}⟧`,
    );
    act(() => button.focus());
    const after = document.body.textContent ?? '';
    assert.ok(
      after.includes(`⟦tours.panelTourButton.tooltip|${tour.title} (${tour.minutes} min tour)⟧`),
    );
  });
});

describe('TourHost prerequisite card localization (#4918)', () => {
  const RESET: TourUiState = {
    status: 'idle',
    tourId: null,
    source: null,
    stepIndex: 0,
    stepPhase: 'preparing',
    targetEl: null,
    hintVisible: false,
    gateBroken: false,
    redockedPanel: false,
    demoLoading: false,
  };

  afterEach(() => {
    useTourStore.setState(RESET);
  });

  it('translates the prerequisite card copy for a model-only tour', () => {
    act(() => {
      useTourStore.setState({ status: 'prereq', tourId: 'welcome' });
    });
    const container = render(<TourHost />);
    assertTranslates(container, 'tours-prereq-pseudo', [
      'tours.tourHost.prereqModel',
      'tours.tourHost.cancel',
      'tours.tourHost.loadDemoProject',
    ]);
    assert.ok(readableStrings(container).has(
      mark('tours.tourHost.prereqAriaLabel').replace('{title}', getTour('welcome')!.title),
    ));
  });
});

describe('TourInvite localization (#4918)', () => {
  it('translates the first-run invite prompt, CTA, and dismiss label', () => {
    const container = render(<TourInvite />);
    assertTranslates(container, 'tours-invite-pseudo', [
      'tours.tourInvite.prompt',
      'tours.tourInvite.start',
      'tours.tourInvite.dismissAriaLabel',
    ]);
  });
});

describe('TourStepCard localization (#4918)', () => {
  const tour = getTour('welcome')!;
  // 'orbit' is a canvas step (no anchor/floating-ui positioning needed under jsdom).
  const step = tour.steps.find((s) => s.id === 'orbit')!;

  afterEach(() => {
    useTourStore.setState({ hintVisible: false, gateBroken: false });
  });

  it('translates the aria-label, end-tour button, skip button, and progress controls', () => {
    act(() => useTourStore.setState({ gateBroken: true }));
    const container = render(
      <TourStepCard tour={tour} step={step} stepIndex={1} targetEl={null} />,
    );
    assertTranslates(container, 'tours-stepcard-pseudo', [
      'tours.tourStepCard.endTourAriaLabel',
      'tours.tourStepCard.skipStep',
      'tours.tourStepCard.next',
    ]);
    assert.ok(readableStrings(container).has(
      mark('tours.tourStepCard.ariaLabel')
        .replace('{step}', '2')
        .replace('{total}', String(tour.steps.length))
        .replace('{title}', step.title),
    ));
  });

  it('translates "Done" on the final step', () => {
    const lastIndex = tour.steps.length - 1;
    const lastStep = tour.steps[lastIndex];
    const container = render(
      <TourStepCard tour={tour} step={lastStep} stepIndex={lastIndex} targetEl={null} />,
    );
    const english = readableStrings(container);
    assert.ok(english.has(toursEn['tours.tourStepCard.done']), 'expected the English "Done" label before switching locale');
    registerLocale('tours-stepcard-done-pseudo', PSEUDO);
    act(() => setLocale('tours-stepcard-done-pseudo'));
    const after = readableStrings(container);
    assert.ok(after.has(mark('tours.tourStepCard.done')));
  });

  it('translates the stuck hint and removes it once a broken gate unlocks Next', () => {
    const gatedIndex = tour.steps.findIndex((candidate) => candidate.gate !== undefined);
    assert.notEqual(gatedIndex, -1, 'welcome tour must retain a gated step for this regression');
    act(() => useTourStore.setState({ hintVisible: true, gateBroken: false }));
    const container = render(
      <TourStepCard tour={tour} step={tour.steps[gatedIndex]} stepIndex={gatedIndex} targetEl={null} />,
    );
    registerLocale('tours-stepcard-stuck-pseudo', PSEUDO);
    act(() => setLocale('tours-stepcard-stuck-pseudo'));
    assert.ok(readableStrings(container).has(mark('tours.tourStepCard.stuckHint')));

    act(() => useTourStore.setState({ gateBroken: true }));
    const unlocked = readableStrings(container);
    assert.equal(unlocked.has(mark('tours.tourStepCard.stuckHint')), false);
    assert.ok(unlocked.has(mark('tours.tourStepCard.next')));
  });
});
