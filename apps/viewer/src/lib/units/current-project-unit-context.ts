/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { extractProjectUnits, readCurrentProjectUnits, type CurrentProjectUnitResult, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** Missing native context is unknown; an available undeclared context keeps its canonical defaults. */
export function currentProjectUnitContext(store: IfcDataStore | null, view: MutablePropertyView | null | undefined): CurrentProjectUnitResult {
  if (!store) return { status: 'unavailable', reason: 'Native project units require an available model store', value: null };
  if (view) return readCurrentProjectUnits(store, view);
  if (!store.source?.length) return { status: 'unavailable', reason: 'Native project units require source or a surviving mutation view', value: null };
  try { return { status: 'available', reason: null, value: extractProjectUnits(store.source, store.entityIndex) }; }
  catch (error) {
    console.warn('[Units] Native source project units are unreadable', error);
    return { status: 'unavailable', reason: 'Native source project units are unreadable', value: null };
  }
}
