/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why a clash result shows no rows, on the shared `ResultState` (U02, #6925).
 * The four cases used to be four hand-rolled blocks with two different
 * looks for "nothing ran" and "nothing found":
 *
 *   no-population  no rule matched any element, so no comparison ran
 *                  (a discipline matrix, or a single rule's empty side)
 *   partial        zero clashes, but some rules matched nothing and never ran
 *   no-findings    every rule ran and found nothing
 *   filtered       clashes exist; the status / touching filters hide them all
 *
 * The coverage classification itself stays in the clash package
 * (`classifyRuleCoverage`); this only maps it onto the shared states.
 */

import type { RuleCoverageOutcome } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { ResultState } from '../result/ResultState';

interface ClashResultStateProps {
  total: number;
  shown: number;
  coverage: RuleCoverageOutcome;
  /** More than one rule ran (a discipline matrix), so "the matrix" exists to blame. */
  multiRule: boolean;
  ruleCount: number;
  emptyRuleNames: readonly string[];
  emptySelectorDescriptions: readonly string[];
  /** Touching clashes are hidden and some exist, so unticking would reveal rows. */
  touchingHidden: boolean;
}

export function ClashResultState({
  total, shown, coverage, multiRule, ruleCount, emptyRuleNames, emptySelectorDescriptions, touchingHidden,
}: ClashResultStateProps) {
  const { t } = useTranslation();
  if (total > 0) {
    if (shown > 0) return null;
    return (
      <ResultState
        kind="filtered"
        title={t('clashPanel.noMatches.title')}
        details={[t(touchingHidden ? 'clashPanel.noMatches.hintWithUntick' : 'clashPanel.noMatches.hintPlain')]}
      />
    );
  }
  if (coverage === 'no-match') {
    return multiRule ? (
      <ResultState
        kind="no-population"
        title={t('clashPanel.matrixNoMatch.title')}
        details={[
          t('clashPanel.matrixNoMatch.description', { count: ruleCount }),
          t('clashPanel.matrixNoMatch.emptyRules', { names: emptyRuleNames.join(', ') }),
        ]}
      />
    ) : (
      <ResultState
        kind="no-population"
        title={t('clashPanel.selectorNoMatch.title')}
        details={[t('clashPanel.selectorNoMatch.description', { reasons: emptySelectorDescriptions.join(', ') })]}
      />
    );
  }
  const partial = coverage === 'partial' && emptyRuleNames.length > 0;
  return (
    <ResultState
      kind={partial ? 'partial' : 'no-findings'}
      title={t('clashPanel.noClashes.title')}
      details={partial
        ? [t('clashPanel.noClashes.partialRules', { count: emptyRuleNames.length, names: emptyRuleNames.join(', ') })]
        : []}
    />
  );
}
