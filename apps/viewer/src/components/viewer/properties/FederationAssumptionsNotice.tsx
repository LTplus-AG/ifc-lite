/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel } from '@/store/types';
import { IfcSharedVerticalDatumNoticeSlot } from '../IfcFederationAssumptionsLazy';
import { LandXmlAssumptionsNoticeSlot } from '../LandXmlGeorefAssumptionsLazy';

/** Show what the current placement relied on, separately from source metadata. Both notices load lazily. */
export function FederationAssumptionsNotice({ model }: { model: FederatedModel }) {
  return <>
    <IfcSharedVerticalDatumNoticeSlot model={model} />
    <LandXmlAssumptionsNoticeSlot model={model} />
  </>;
}
