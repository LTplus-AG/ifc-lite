/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import { isAnalyticsOptedOut } from '@/lib/analytics-consent';
import { setAnalyticsOptOut } from '@/lib/analytics';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

export function AnalyticsConsentSection() {
  const { t } = useTranslation();
  const [optedOut, setOptedOut] = useState(isAnalyticsOptedOut);
  return (
    <SettingsGroup title={t('settings.privacy.analyticsTitle')}>
      <p className="text-xs text-muted-foreground">{t('settings.privacy.analyticsDisclosure')}</p>
      <p className="text-xs text-muted-foreground">{t('settings.privacy.analyticsExclusions')}</p>
      <SettingsRow
        label={t('settings.privacy.analyticsOptOut')}
        hint={t('settings.privacy.analyticsOptOutHint')}
        htmlFor="settings-analytics-opt-out"
      >
        <Switch
          id="settings-analytics-opt-out"
          checked={optedOut}
          onCheckedChange={(checked) => {
            setAnalyticsOptOut(checked);
            setOptedOut(checked);
          }}
        />
      </SettingsRow>
      <a
        href="https://github.com/LTplus-AG/ifc-lite/blob/main/docs/guide/privacy.md"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary underline"
      >
        {t('settings.privacy.learnMore')}
      </a>
    </SettingsGroup>
  );
}
