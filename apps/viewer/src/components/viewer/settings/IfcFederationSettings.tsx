/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

export function IfcFederationSettings() {
  const { t } = useTranslation();
  const enabled = useViewerStore((s) => s.ifcSharedVerticalDatum);
  const setEnabled = useViewerStore((s) => s.setIfcSharedVerticalDatum);
  return (
    <SettingsGroup title={t('settings.ifcFederation.title')}>
      <SettingsRow label={t('settings.ifcFederation.sharedVertical')}
        hint={t('settings.ifcFederation.hint')} htmlFor="settings-ifc-shared-vertical">
        <Switch id="settings-ifc-shared-vertical" checked={enabled} onCheckedChange={setEnabled} />
      </SettingsRow>
    </SettingsGroup>
  );
}
