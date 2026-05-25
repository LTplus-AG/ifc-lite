/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boot-time wiring for `placement-edit`. Imported once for its side
 * effect from the app entrypoint (`main.tsx`). Keeps the
 * `@ifc-lite/parser` import out of `placement-edit.ts` itself so the
 * pure overlay-path logic stays unit-testable without a parser build.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { setSourceAttrsReader } from './placement-edit.js';

setSourceAttrsReader((dataStore: IfcDataStore, expressId: number) => {
  const ref = dataStore.entityIndex.byId.get(expressId);
  if (!ref) return null;
  const extractor = new EntityExtractor(dataStore.source);
  const entity = extractor.extractEntity(ref);
  return entity?.attributes ?? null;
});
