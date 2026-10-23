/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The eager mount points of the LandXML georeferencing-assumption UI. Each
 * one is a few bytes that load the real component (and its lazy English
 * catalogue) only when there is something to show: the refusal prompt while
 * a refusal is published, the Settings group when Settings → General opens,
 * the "Assumed" notice for a model placed under an assumption.
 *
 * The HUD notice, checkbox and Settings layout components are handed to the
 * lazy components from here rather than imported by them. They already live
 * in the entry chunk; a lazy chunk importing them makes the bundler split
 * each into a new eagerly preloaded chunk, which grew the viewer's eager JS
 * past its perf ceiling. Measure with `scripts/perf-ratchet/measure-bundle.mjs`
 * before changing an import in the lazy components.
 */

import { lazy, Suspense } from 'react';
import { useViewerStore, type FederatedModel } from '@/store';
import { Checkbox } from '@/components/ui/checkbox';
import { HudItem, HudNotice } from '../viewport-ui/hud';
import { SettingsGroup, SettingsRow } from './settings/SettingsGroup';

// One dynamic import for all three: one lazy chunk, one preload list in the entry.
const load = () => import('./LandXmlGeorefAssumptionsUi');
const Prompt = lazy(() => load().then((m) => ({ default: m.LandXmlAssumptionRefusalPrompt })));
const SettingsBody = lazy(() => load().then((m) => ({ default: m.LandXmlGeorefSettingsGroup })));
const Notice = lazy(() => load().then((m) => ({ default: m.LandXmlAssumptionsNotice })));

/** Mounted beside `LandXmlUnitsRefusalPrompt` in the viewport HUD. */
export function LandXmlAssumptionRefusalPromptSlot() {
  // Published only with a non-empty offer (`landXmlAssumptionRefusalFrom`).
  if (!useViewerStore((s) => s.landXmlAssumptionRefusal)) return null;
  return (
    <HudItem region="top-center" order={13}>
      <Suspense fallback={null}><Prompt HudNotice={HudNotice} Checkbox={Checkbox} /></Suspense>
    </HudItem>
  );
}

/** Settings → General's "LandXML georeferencing" group. */
export function LandXmlGeorefSettingsSlot() {
  return <Suspense fallback={null}><SettingsBody SettingsGroup={SettingsGroup} SettingsRow={SettingsRow} /></Suspense>;
}

/** The "Assumed" notice; renders nothing for a model placed on declared CRSs alone. */
export function LandXmlAssumptionsNoticeSlot({ model }: { model: FederatedModel | undefined }) {
  if (!model?.landXmlAssumptionsApplied?.length) return null;
  return <Suspense fallback={null}><Notice model={model} /></Suspense>;
}
