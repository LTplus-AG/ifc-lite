/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Compare panel's impact and run-reconciliation sections (#6921):
 * `CompareImpactSection`, `CompareReconcileSection` and their wrapper.
 * IFC class names, rule names, specification names and GlobalIds stay
 * literal: they are model or rule content, not UI copy.
 */
export const compareAnalysisEn = {
  'compareAnalysis.sectionsLabel': 'Comparison impact and reconciliation',
  'compareAnalysis.impact.title': 'Impact on other analyses',
  'compareAnalysis.impact.summary': {
    one: '{count} changed element checked against loaded results',
    other: '{count} changed elements checked against loaded results',
  },
  'compareAnalysis.impact.unresolved': {
    one: '{count} change has no GlobalId and is never joined.',
    other: '{count} changes have no GlobalId and are never joined.',
  },
  'compareAnalysis.impact.limitations': 'Joined by model and GlobalId only. A touched finding does not prove the change caused or fixed it.',
  'compareAnalysis.source.clash': 'Clashes',
  'compareAnalysis.source.validation': 'Validation failures',
  'compareAnalysis.source.list': 'List rows',
  'compareAnalysis.source.bcf': 'BCF topics',
  'compareAnalysis.status.available': { one: '{count} touched', other: '{count} touched' },
  'compareAnalysis.status.stale': { one: '{count} touched · run before later edits', other: '{count} touched · run before later edits' },
  'compareAnalysis.status.unavailable': 'Not loaded',
  'compareAnalysis.impact.none': 'No loaded analysis references a changed element.',
  'compareAnalysis.impact.listRow': '{name}: {touched} of {total} rows',
  'compareAnalysis.impact.listColumn': '{label}: {touched} of {total}',
  'compareAnalysis.side.base': 'A',
  'compareAnalysis.side.head': 'B',
  'compareAnalysis.reconcile.title': 'Reconcile findings across revisions',
  'compareAnalysis.reconcile.kindLabel': 'Analysis',
  'compareAnalysis.reconcile.kind.clash': 'Clash',
  'compareAnalysis.reconcile.kind.validation': 'Validation',
  'compareAnalysis.reconcile.capture': 'Capture current run',
  'compareAnalysis.reconcile.captureNoClash': 'Run clash detection to capture a run.',
  'compareAnalysis.reconcile.captureNoValidation': 'Run a validation to capture a run.',
  'compareAnalysis.reconcile.none': 'No captured runs yet. A run over both revisions can serve as base and head.',
  'compareAnalysis.reconcile.baseRun': 'Base run (A)',
  'compareAnalysis.reconcile.headRun': 'Head run (B)',
  'compareAnalysis.reconcile.runLabel': '{time} · {models}',
  'compareAnalysis.reconcile.modelsUnknown': 'models unknown',
  'compareAnalysis.reconcile.remove': 'Remove the selected head run',
  'compareAnalysis.reconcile.run': 'Reconcile',
  'compareAnalysis.reconcile.refused': 'These runs cannot be reconciled:',
  'compareAnalysis.incompat.kindDiffers': 'The runs are of different analyses ({detail}).',
  'compareAnalysis.incompat.noComparison': 'Run a comparison first.',
  'compareAnalysis.incompat.runModelsUnknown': 'A run does not record which models it examined.',
  'compareAnalysis.incompat.baseModelNotInRun': 'The base run did not examine model A.',
  'compareAnalysis.incompat.headModelNotInRun': 'The head run did not examine model B.',
  'compareAnalysis.incompat.rulesDiffer': 'The clash rules differ: {detail}.',
  'compareAnalysis.incompat.settingsDiffer': 'The clash settings differ: {detail}.',
  'compareAnalysis.incompat.scopeDiffers': 'The rule scope differs: {detail}.',
  'compareAnalysis.incompat.sourceDiffers': 'The rule sets differ: {detail}.',
  'compareAnalysis.incompat.specificationsDiffer': 'The specifications differ: {detail}.',
  'compareAnalysis.incompat.runStale': 'A run was made before later model edits: {detail}.',
  'compareAnalysis.state.new': 'New',
  'compareAnalysis.state.resolved': 'Resolved',
  'compareAnalysis.state.persisting': 'Persisting',
  'compareAnalysis.state.changed': 'Changed',
  'compareAnalysis.state.notEvaluated': 'Not evaluated',
  'compareAnalysis.reconcile.partial': 'Partial: findings the head run could not re-examine are not evaluated, never resolved.',
  'compareAnalysis.reconcile.excluded': {
    one: '{count} finding pairs or lacks identity across revisions and is not reconciled.',
    other: '{count} findings pair or lack identity across revisions and are not reconciled.',
  },
  'compareAnalysis.reason.headRunTruncated': 'head run truncated',
  'compareAnalysis.reason.ruleNotRun': 'rule not run',
  'compareAnalysis.reason.ruleMatchedNothing': 'rule matched nothing',
  'compareAnalysis.reason.elementNotReexamined': 'element not re-examined',
  'compareAnalysis.reason.coverageNotAttributable': 'coverage not attributable to B',
  'compareAnalysis.reason.specificationError': 'specification failed to run',
  'compareAnalysis.reason.entityNotEvaluated': 'element not evaluated',
  'compareAnalysis.reconcile.changes': 'changed: {fields}',
} as const satisfies Record<string, TranslationValue>;
