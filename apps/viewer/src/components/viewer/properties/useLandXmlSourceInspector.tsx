/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react';
import { useViewerStore } from '@/store';
import type { LandXmlSourceModel } from '@/hooks/ingest/landXmlSemantics';
import { LandXmlSourceInspector } from './LandXmlSourceInspector';

export function useLandXmlSourceInspector(
  models: ReadonlyMap<string, LandXmlSourceModel>,
): ReactElement | null {
  const selected = useViewerStore((state) => state.selectedLandXmlSource);
  const onSelect = useViewerStore((state) => state.setSelectedLandXmlSource);
  return selected ? <LandXmlSourceInspector models={models} selected={selected} onSelect={onSelect} /> : null;
}
