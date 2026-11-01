/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The UI for the IFC shared-height-system assumption (#8042): the Settings
 * group that opts into it, and the "Assumed" notice on a model placed under it.
 *
 * One lazy module, loaded by `IfcFederationAssumptionsLazy.tsx` only when
 * there is something to show, so neither this code nor its catalogue is in
 * the eager bundle. The Settings layout components already live in the entry
 * chunk and are passed in as props rather than imported; see
 * `LandXmlGeorefAssumptionsLazy.tsx` for why.
 */

import '@/i18n/catalogues/ifc-federation-assumptions.register';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Switch } from '@/components/ui/switch';
import type { FederatedModel } from '@/store';
import type { SettingsGroup as SettingsGroupComponent, SettingsRow as SettingsRowComponent } from './settings/SettingsGroup';

/** Settings → General's "IFC federation" group. Off by default. */
export function IfcFederationSettingsGroup({ SettingsGroup, SettingsRow }: {
  SettingsGroup: typeof SettingsGroupComponent;
  SettingsRow: typeof SettingsRowComponent;
}) {
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

/** What an aligned IFC model's placement relied on, separately from source metadata. */
export function IfcSharedVerticalDatumNotice({ model }: { model: FederatedModel }) {
  const { t } = useTranslation();
  return (
    <section className="border-b border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-1">
      <h4 className="font-semibold">{t('settings.ifcFederation.assumed')}</h4>
      <p>{t(model.ifcSharedVerticalDatumAssumed === 'unresolved'
        ? 'settings.ifcFederation.appliedUnresolved' : 'settings.ifcFederation.applied')}</p>
    </section>
  );
}
