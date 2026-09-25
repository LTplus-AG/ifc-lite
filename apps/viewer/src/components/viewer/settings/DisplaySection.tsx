/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings → Display. Navigation → SpaceMouse moved here from the Info
 * dialog's Preferences tab (#5509 put it there when no settings home
 * existed; #5857 is that home).
 */

import { useTranslation } from '@/i18n';
import { SpaceMousePanel } from '../SpaceMousePanel';
import { SettingsGroup } from './SettingsGroup';

export function DisplaySection() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t('settings.display.navigationTitle')}>
      <h4 className="mb-2 text-xs font-semibold">{t('settings.display.spaceMouseTitle')}</h4>
      <SpaceMousePanel />
    </SettingsGroup>
  );
}
