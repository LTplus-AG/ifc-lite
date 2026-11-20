/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The eager mount points of the IFC shared-height-system UI (#8042). Each
 * one is a few bytes that load the real component (and its lazy English
 * catalogue) only when there is something to show: the Settings group when
 * Settings → General opens, the "Assumed" notice for an aligned model placed
 * under the assumption. Same pattern, and the same rule about handing in
 * entry-chunk components as props, as `LandXmlGeorefAssumptionsLazy.tsx`.
 */

import { Suspense } from 'react';
import { lazyChunk } from '@/lib/lazy-chunk';
import type { FederatedModel } from '@/store';
import { SettingsGroup, SettingsRow } from './settings/SettingsGroup';

// One dynamic import for both: one lazy chunk, one preload list in the entry.
const load = () => import('./IfcFederationAssumptionsUi');
const SettingsBody = lazyChunk(() => load().then((m) => ({ default: m.IfcFederationSettingsGroup })));
const Notice = lazyChunk(() => load().then((m) => ({ default: m.IfcSharedVerticalDatumNotice })));

/** Settings → General's "IFC federation" group. */
export function IfcFederationSettingsSlot() {
  return <Suspense fallback={null}><SettingsBody SettingsGroup={SettingsGroup} SettingsRow={SettingsRow} /></Suspense>;
}

/** The "Assumed height system" notice; renders nothing unless an aligned placement relied on it. */
export function IfcSharedVerticalDatumNoticeSlot({ model }: { model: FederatedModel }) {
  const aligned = model.federationAlignmentStatus === 'identity'
    || model.federationAlignmentStatus === 'same-crs' || model.federationAlignmentStatus === 'reprojected';
  // Site context reports its own LN02 assumption on its card (SiteContextCard).
  if (!aligned || !model.ifcSharedVerticalDatumAssumed || model.spatialReference?.sourceMetadata?.format === 'site-context') return null;
  return <Suspense fallback={null}><Notice model={model} /></Suspense>;
}
