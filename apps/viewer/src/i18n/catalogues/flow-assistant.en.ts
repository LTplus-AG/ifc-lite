/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Assistant Flow run diagnosis, tracked-element effects and preflight
 * (`FlowProposalReview.tsx`, `FlowPreflight.tsx`, `FlowTrackingImpacts.tsx`).
 */
export const flowAssistantEn = {
  'flowAssistant.suggestDebug': 'Why did the last run fail, and how can the graph be fixed?',
  'flowAssistant.diagnosisTitle': 'Diagnosis of the last run',
  'flowAssistant.diagnosisNode': '{node}: {status} · lane errors: {count}',
  'flowAssistant.codeTitle': 'Script code this change sets',
  'flowAssistant.codeHint': 'The assistant wrote this code. It runs in the sandbox on the next Run; read it before applying.',
  'flowAssistant.codeParam': '{node} · {param} ({language})',
  'flowAssistant.trackingTitle': 'Tracked elements affected',
  'flowAssistant.trackingOwnership': 'Elements created by a tracked node belong to this graph under its tracking key: re-runs update the same GlobalIds, and the graph removes them once no node claims the key.',
  'flowAssistant.owned': { one: '{count} owned element', other: '{count} owned elements' },
  'flowAssistant.ownedUnknown': 'owned elements (none recorded for the active model)',
  'flowAssistant.trackingRemoved': '{node} is removed: {owned} under “{key}” are deleted from the model on the next Run.',
  'flowAssistant.trackingRekeyed': '{node} changes tracking key from “{key}” to “{next}”: {owned} are deleted on the next Run and new elements are created.',
  'flowAssistant.trackingMode': '{node} switches to “{mode}” tracking: {owned} under “{key}” follow the new mode on the next Run.',
  'flowAssistant.trackingBranch': '{node} or its inputs change: {owned} under “{key}” are updated on the next Run.',
  'flowAssistant.trackingAdded': '{node} will create elements owned by this graph under “{key}”.',
  'flowAssistant.trackingAcknowledge': 'I understand which tracked elements this change updates or removes on the next Run.',
  'flowAssistant.preflight': 'Preflight',
  'flowAssistant.preflightRunning': 'Checking the graph…',
  'flowAssistant.preflightOk': 'Preflight passed for “{name}”. Nothing was executed; run it from Flow when ready.',
  'flowAssistant.preflightFailed': 'Preflight found problems. Nothing was executed.',
  'flowAssistant.preflightStale': 'The graph changed after this preflight; check it again.',
  'flowAssistant.openFlowToRun': 'Open Flow to run',
} as const satisfies Record<string, TranslationValue>;
