/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel } from '@/store/types';
import { useTranslation } from '@/i18n';
import { LandXmlAssumptionsNoticeSlot } from '../LandXmlGeorefAssumptionsLazy';

/** Show what the current placement relied on, separately from source metadata. */
export function FederationAssumptionsNotice({ model }: { model: FederatedModel }) {
  const { t } = useTranslation();
  const aligned = model.federationAlignmentStatus === 'identity'
    || model.federationAlignmentStatus === 'same-crs' || model.federationAlignmentStatus === 'reprojected';
  return <>
    {aligned && model.ifcSharedVerticalDatumAssumed && (
      <section className="border-b border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-1">
        <h4 className="font-semibold">{t('settings.ifcFederation.assumed')}</h4>
        <p>{t(model.ifcSharedVerticalDatumAssumed === 'unresolved'
          ? 'settings.ifcFederation.appliedUnresolved' : 'settings.ifcFederation.applied')}</p>
      </section>
    )}
    <LandXmlAssumptionsNoticeSlot model={model} />
  </>;
}
