/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';

/** Explanation of the clash modes and their displayed severity. */
export function ClashHelp() {
  const { t } = useTranslation();
  return (
    <div className="px-3 py-2.5 border-b border-border bg-muted/30 text-2xs leading-relaxed text-muted-foreground space-y-1.5">
      <p>
        <b className="text-foreground">{t('clashPanel.help.hardLabel')}</b> {t('clashPanel.help.hardDescription')}{' '}
        <i>{t('clashPanel.help.tolAbbrev')}</i>).{' '}
        <b className="text-foreground">{t('clashPanel.help.clearanceLabel')}</b> {t('clashPanel.help.clearanceDescription')}{' '}
        <i>{t('clashPanel.help.gapAbbrev')}</i> {t('clashPanel.help.gapAddsMore')} <i>{t('clashPanel.help.moreLabel')}</i>{' '}
        {t('clashPanel.help.resultsNotFiltered')}
      </p>
      <p>
        <b className="text-foreground">{t('clashPanel.help.tolAbbrev')}</b> {t('clashPanel.help.tolDescription')}{' '}
        <b className="text-foreground">{t('clashPanel.help.gapAbbrev')}</b> {t('clashPanel.help.gapDescription')}
      </p>
      <p>
        <b className="text-foreground">{t('clashPanel.help.severityLabel')}</b> {t('clashPanel.help.severityDescription')}{' '}
        <i>{t('clashPanel.help.notLabel')}</i> {t('clashPanel.help.fromOverlapDepth')}{' '}
        <i>{t('clashPanel.help.overlapDepthLabel')}</i> {t('clashPanel.help.surfaceWorst')}
      </p>
      <p>
        <b className="text-foreground">{t('clashPanel.help.touchingLabel')}</b> {t('clashPanel.help.touchingDescription')}
      </p>
    </div>
  );
}
