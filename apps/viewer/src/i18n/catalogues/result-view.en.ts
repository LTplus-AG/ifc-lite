/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The shared result and artifact chrome (U02, #6925): the ResultView source
 * line and coverage line, status chips, result states, scope control,
 * select-all wording and the artifact header (`components/viewer/result/`).
 * What a row or a finding is called stays in each panel's own catalogue and
 * is passed in as a complete message.
 */
export const resultViewEn = {
  'resultView.region': '{source} results',
  'resultView.source': 'Source',
  'resultView.models': { one: 'Model: {names}', other: 'Models ({count}): {names}' },
  'resultView.population': 'Population',
  'resultView.coverage': 'Coverage',
  'resultView.incomplete': 'Incomplete',
  'resultView.actions': 'Result actions',
  'resultView.evidence': 'Evidence details',

  'resultStatus.complete': 'Complete',
  'resultStatus.partial': 'Partial',
  'resultStatus.failed': 'Failed',
  'resultStatus.running': 'Running',
  'resultStatus.stale': 'Stale',
  'resultStatus.cancelled': 'Cancelled',
  'resultStatus.interrupted': 'Interrupted',
  'resultStatus.queued': 'Queued',
  'resultStatus.uncertain': 'Outcome unknown',
  'resultStatus.blocked': 'Blocked',
  'resultStatus.unsupported': 'Unsupported',
  'resultStatus.draft': 'Draft',
  'resultStatus.ready': 'Ready to review',
  'resultStatus.applying': 'Applying',
  'resultStatus.applied': 'Applied',

  'resultState.noPopulation': 'No applicable elements',
  'resultState.noFindings': 'No findings',
  'resultState.failed': 'The run failed',
  'resultState.unsupported': 'Not supported here',
  'resultState.partial': 'Partial result',
  'resultState.filtered': 'Nothing matches the filters',

  'resultScope.label': 'Scope',
  'resultScope.selected': 'Selected ({count})',
  'resultScope.filtered': 'Filtered ({count})',
  'resultScope.all': 'All ({count})',

  'resultSelection.selectPage': { one: 'Select the {countDisplay} result on this page', other: 'Select all {countDisplay} on this page' },
  'resultSelection.selectEverything': { one: 'Select the {countDisplay} matching result', other: 'Select all {countDisplay} matching results' },
  'resultSelection.pageSelected': { one: '{countDisplay} result on this page selected.', other: 'All {countDisplay} on this page selected.' },
  'resultSelection.selectPopulation': { one: 'Select the {countDisplay} matching result', other: 'Select all {countDisplay} matching results' },
  'resultSelection.resolving': { one: 'Retrieving the {countDisplay} matching result…', other: 'Retrieving all {countDisplay} matching results…' },
  'resultSelection.populationSelected': { one: 'The {countDisplay} matching result is selected.', other: 'All {countDisplay} matching results are selected.' },
  'resultSelection.failed': 'The matching results could not be retrieved.',
  'resultSelection.retry': 'Retry',
  'resultSelection.clear': 'Clear selection',
  'resultSelection.highlighted': '1 in focus',
  'resultSelection.selected': { one: '{countDisplay} selected', other: '{countDisplay} selected' },
  'resultSelection.included': { one: '{countDisplay} in batch', other: '{countDisplay} in batch' },

  'artifactHeader.region': '{name} artifact',
} as const satisfies Record<string, TranslationValue>;
