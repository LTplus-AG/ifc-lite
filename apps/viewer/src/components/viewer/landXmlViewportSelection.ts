/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { landXmlPickSourceRefFromFederation } from '@/hooks/ingest/landXmlSemantics';

/** Route a synthetic terrain pick through the non-IFC source channel. */
export function selectLandXmlViewportPick(state: ViewerState, globalId: number): boolean {
  const sourceRef = landXmlPickSourceRefFromFederation(state, globalId);
  if (!sourceRef) return false;
  state.setSelectedLandXmlSource(sourceRef);
  return true;
}
