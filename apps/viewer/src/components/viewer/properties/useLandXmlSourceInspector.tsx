/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react';
import { useViewerStore } from '@/store';
import type { LandXmlSourceModel } from '@/hooks/ingest/landXmlSemantics';
import { LandXmlSourceInspector } from './LandXmlSourceInspector';
import { LandXmlAssumptionsNoticeSlot } from '../LandXmlGeorefAssumptionsLazy';

export function useLandXmlSourceInspector(
  models: ReadonlyMap<string, LandXmlSourceModel>,
): ReactElement | null {
  const selected = useViewerStore((state) => state.selectedLandXmlSource);
  const onSelect = useViewerStore((state) => state.setSelectedLandXmlSource);
  // The federated model, for the georeferencing assumptions it was placed under.
  const placed = useViewerStore((state) => (selected ? state.models.get(selected.modelId) : undefined));
  if (!selected) return null;
  const inspector = <LandXmlSourceInspector models={models} selected={selected} onSelect={onSelect} />;
  if (!placed?.landXmlAssumptionsApplied?.length) return inspector;
  return (
    <div className="flex h-full flex-col">
      <LandXmlAssumptionsNoticeSlot model={placed} />
      <div className="min-h-0 flex-1">{inspector}</div>
    </div>
  );
}
