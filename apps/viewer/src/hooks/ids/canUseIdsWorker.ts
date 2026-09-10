/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { isIfcxDataStore } from '@/store';
import { idsWorkerSupported } from './idsWorkerClient';

/**
 * Is this model's IDS run safe to hand to the validation worker?
 *
 * Preferred path: validate in a Web Worker so the whole run is off the main
 * thread — the UI stays at full frame rate and progress actually paints. Every
 * other heavy stage (parse, geometry) already runs in a worker; this brings
 * validation in line. The caller falls back to in-process validation when this
 * returns false: the worker is unavailable, the model has no source bytes for
 * it to re-parse, or those bytes are not STEP.
 *
 * The IFCX exclusion is load-bearing, not defensive. An IFCX store's `source`
 * is the IFCX **JSON** file (`buildIfcxDataStore`,
 * hooks/ingest/viewerModelIngest.ts) and its byte index is empty, so
 * `byteLength > 0` is true and the worker's `parseColumnar` happily parses JSON
 * as STEP and yields a store with no properties, attributes or relationships.
 * Before #3946 an IFCX model with pending edits was saved from that by the
 * edits themselves, which forced the main thread; removing that fork without
 * this term would convert a working validation into a silently empty one.
 */
export function canUseIdsWorker(dataStore: IfcDataStore): boolean {
  return (
    idsWorkerSupported()
    && !isIfcxDataStore(dataStore)
    && !!dataStore.source
    && dataStore.source.byteLength > 0
  );
}
