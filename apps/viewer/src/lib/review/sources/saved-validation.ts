/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7091: saved failures remain historical until a native compatible run re-examines them (#7371). */
import type { TranslatableMessage, TranslationKey } from '@/i18n';
import type { SavedValidationReport } from '../../validation/reports/history';
import { reexamineSavedValidation, type CurrentValidationRun, type Reexamination, type ReexaminationGap, type RowReexamination } from '../../validation/reports/reexamine';
import type { FindingLifecycle, FindingSourceResult, RunGap } from '../types';
import { savedValidationFacts } from '@ifc-lite/sdk/review';

/** A candidate is never a decision: the saved native status is kept verbatim either way.
 * `changed` stays distinct from `persisting`, so different failed requirements are never shown as the same failure. */
const LIFECYCLE: Record<RowReexamination['state'], FindingLifecycle> = {
  persisting: 'persistent', changed: 'changed', resolved: 'no-longer-observed', notEvaluated: 'not-evaluated',
};
/** Every stable reason code has its own plain-language sentence; the code itself is never shown. */
const REASON: Record<ReexaminationGap, TranslationKey> = {
  noCurrentRun: 'reviewWorkspace.reexamination.historical', definitionNotRecorded: 'reviewWorkspace.reexamination.definitionNotRecorded',
  definitionUnknown: 'reviewWorkspace.reexamination.definitionUnknown', definitionDiffers: 'reviewWorkspace.reexamination.definitionDiffers',
  runFreshnessUnknown: 'reviewWorkspace.reexamination.runFreshnessUnknown', runStale: 'reviewWorkspace.reexamination.runStale',
  scopeUnknown: 'reviewWorkspace.reexamination.scopeUnknown', scopeDiffers: 'reviewWorkspace.reexamination.scopeDiffers',
  identityUnavailable: 'reviewWorkspace.reexamination.identityUnavailable', modelAmbiguous: 'reviewWorkspace.reexamination.modelAmbiguous',
  identityAmbiguous: 'reviewWorkspace.reexamination.identityAmbiguous', specificationError: 'reviewWorkspace.reexamination.specificationError',
  entityNotEvaluated: 'reviewWorkspace.reexamination.entityNotEvaluated', runIncomplete: 'reviewWorkspace.reexamination.runIncomplete',
};
const OUTCOME: Record<Exclude<RowReexamination['state'], 'notEvaluated'>, TranslationKey> = {
  persisting: 'reviewWorkspace.reexamination.persisting', changed: 'reviewWorkspace.reexamination.changed',
  resolved: 'reviewWorkspace.reexamination.resolved',
};
const outcomeNote = (outcome: RowReexamination): TranslatableMessage =>
  ({ labelKey: outcome.state === 'notEvaluated' ? REASON[outcome.reason] : OUTCOME[outcome.state] });
const gap = (labelKey: TranslationKey): RunGap => ({ code: 'partial-source', message: { labelKey } });
/** Without a current run the saved run says so in one sentence; otherwise every refusal reason follows as its own line. */
function reexaminationGaps(result: Reexamination | null): RunGap[] {
  if (!result) return [gap('reviewWorkspace.reexamination.countOnly')];
  if (result.compatible) {
    // Compatible runs can still leave rows unchecked (capped, unevaluated, ambiguous): "each" is said only when none was,
    // and a run that checked none of them never says it checked them again.
    const skipped = [...result.rows.values()].filter(row => row.state === 'notEvaluated').length;
    if (!skipped) return [gap('reviewWorkspace.reexamination.compatible')];
    return [{ code: 'partial-source', message: skipped === result.rows.size
      ? { labelKey: 'reviewWorkspace.reexamination.compatibleNone', params: { count: skipped } }
      : { labelKey: 'reviewWorkspace.reexamination.compatiblePartial', params: { count: skipped, total: result.rows.size } } }];
  }
  return [...new Set(['reviewWorkspace.reexamination.historical' as const, ...result.reasons.map(reason => REASON[reason])])].map(gap);
}

export function savedValidationFindings(reports: readonly SavedValidationReport[], current: CurrentValidationRun | null = null): FindingSourceResult {
  const result: FindingSourceResult = { runs: [], findings: [] };
  for (const saved of reports) {
    const snapshot = saved.snapshot;
    if (snapshot.kind !== 'ids-report') continue;
    const captured = snapshot.elementEvidence;
    const reexamined = captured ? reexamineSavedValidation(snapshot, current) : null;
    const facts = savedValidationFacts<TranslatableMessage>(saved, {
      incomplete: reexaminationGaps(reexamined),
      outcome: row => {
        const outcome = reexamined?.compatible ? reexamined.rows.get(row.id) : undefined;
        return outcome ? { lifecycle: LIFECYCLE[outcome.state], notes: [outcomeNote(outcome)] } : undefined;
      },
    });
    result.runs.push(...facts.runs);
    result.findings.push(...facts.findings);
  }
  return result;
}
