/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n/useTranslation';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { formatLocaleCount, formatLocaleList } from './formatLocaleCount';
import { matchHintFacts, type SetPatternPreview } from './pattern-preview';

const PATTERN_DELIMITER = '/…/';
const PATTERN_EXAMPLE = '/Qto_.*BaseQuantities/';

export function PatternHint({ preview }: { preview: SetPatternPreview }) {
  const { t, locale } = useTranslation();
  if (preview.isInvalid) {
    return <p className="text-2xs leading-relaxed text-destructive">{t('lists.builder.invalidPatternHint')}</p>;
  }
  if (preview.isPattern) {
    const facts = matchHintFacts(preview.matches);
    return (
      <p className="text-2xs leading-relaxed text-muted-foreground">
        {facts.count === 0
          ? t('lists.builder.patternMatchesNone')
          : t(facts.extra > 0 ? 'lists.builder.patternMatchesWithMore' : 'lists.builder.patternMatches', {
            count: facts.count,
            countDisplay: formatLocaleCount(facts.count, locale),
            names: formatLocaleList(facts.shown, locale),
            extra: formatLocaleCount(facts.extra, locale),
          })}
      </p>
    );
  }
  return (
    <p className="text-2xs leading-relaxed text-muted-foreground">
      {styleInterpolatedValues(t, 'lists.builder.patternHint', [
        ['delimiter', <code key="delimiter" className="rounded bg-muted px-1 font-mono text-2xs">{PATTERN_DELIMITER}</code>],
        ['example', <code key="example" className="rounded bg-muted px-1 font-mono text-2xs">{PATTERN_EXAMPLE}</code>],
      ])}
    </p>
  );
}
