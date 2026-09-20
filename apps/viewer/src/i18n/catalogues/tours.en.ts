/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tour UI's own chrome (#4918 slice 5): the Learn tab's catalog list,
 * the per-panel tour launcher, the host's prerequisite card, the first-run
 * invite, and the step card's controls.
 *
 * Deliberately NOT covered: `tour.title` / `tour.description` / `step.title`
 * / `step.body` / `step.action.label` come from `TOUR_REGISTRY`
 * (`@/lib/tours/registry`, outside this slice's directories) — authored
 * tour content, not UI copy in these components, same reasoning as the
 * command-palette catalogue's tour entries.
 */
export const toursEn = {
  'tours.learnTab.description':
    'Interactive walkthroughs run on your model or the bundled demo project. Every step can be skipped.',
  'tours.learnTab.completedAriaLabel': 'Completed',
  'tours.learnTab.replay': 'Replay',
  'tours.learnTab.start': 'Start',
  'tours.learnTab.minutes': '{count} min',

  'tours.panelTourButton.startAriaLabel': 'Start tour: {title}',
  'tours.panelTourButton.tooltip': '{title} ({count} min tour)',

  'tours.tourHost.prereqAriaLabel': '{title}: prerequisites',
  'tours.tourHost.prereqLayerStack': 'This tour needs a composed layer stack. Load the demo stack (three tiny layers) to follow along.',
  'tours.tourHost.prereqSecondModel': 'This tour needs two loaded revisions of a model. Load the demo project to follow along.',
  'tours.tourHost.prereqModel': 'This tour needs a loaded model. Load the demo project to follow along, or open your own IFC file first.',
  'tours.tourHost.cancel': 'Cancel',
  'tours.tourHost.loadDemoStack': 'Load demo stack',
  'tours.tourHost.loadDemoProject': 'Load demo project',

  'tours.tourInvite.prompt': 'New here?',
  'tours.tourInvite.start': 'Take the two minute tour',
  'tours.tourInvite.dismissAriaLabel': 'Dismiss tour invite',

  'tours.tourStepCard.ariaLabel': 'Tour step {step} of {total}: {title}',
  'tours.tourStepCard.endTourAriaLabel': 'End tour',
  'tours.tourStepCard.redockedNotice': 'The panel was docked back into the sidebar for this step.',
  'tours.tourStepCard.stuckHint': 'Stuck? Skip this step and keep going.',
  'tours.tourStepCard.skipStep': 'Skip step',
  'tours.tourStepCard.done': 'Done',
  'tours.tourStepCard.next': 'Next',
} as const;
