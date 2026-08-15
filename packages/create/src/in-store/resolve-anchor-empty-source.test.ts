/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcDataStore.source` is a MANDATORY accessor (#2183, #2345): even a
 * store with no usable bytes carries `EMPTY_SOURCE_BYTES`, never
 * null/undefined, so a plain `if (store.source)` / `if (!store.source)`
 * check in `resolve-anchor.ts` never actually fires on a source-less store
 * — it was dead.
 *
 * The maintainer's call that fixing these four guards is "no behavior
 * change" holds for every REAL call site: `resolveSpatialAnchor` is only
 * ever invoked (from `create`'s in-store builders) on a store this same
 * process just parsed, which always carries real, resident source bytes —
 * an empty-source store never reaches this function today. This suite
 * pins the hypothetical (currently unreached) case anyway, for the record:
 * with a synthetic empty-source store (real `entityIndex`, but `source`
 * swapped to `EMPTY_SOURCE_BYTES`, modelling a hypothetical future
 * server-parsed caller), BOTH the old dead-checked code and the new
 * correctly-expressed guard fail closed — never a silent wrong anchor —
 * just via different internal paths: the old code's checks never fire, so
 * `EntityExtractor` runs against a clamped-empty slice, every extraction
 * attempt returns `undefined`, and `findBodyContextId`/`findAxisContextId`
 * mask that by falling back to `ctxIds[0]` regardless, deferring the
 * failure to `findStoreyPlacementId` and a generic "no resolvable
 * IfcLocalPlacement" error; the new guard instead reports the absence at
 * its own, more specific call site. Same "still throws, different message"
 * class as `resolve-source.ts` — not a silent-output regression.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_SOURCE_BYTES, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { resolveSpatialAnchor } from './resolve-anchor.js';

const STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

describe('resolveSpatialAnchor: store with no source bytes (hypothetical, not reached today)', () => {
  it('fails closed with a thrown error, never a silently-wrong anchor', async () => {
    const parsed = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STOREY_MODEL).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    // Simulate a store whose source was never resident: real entityIndex,
    // but IfcSourceBytes.source is the shared EMPTY sentinel.
    const store: IfcDataStore = { ...parsed, source: EMPTY_SOURCE_BYTES };

    expect(() => resolveSpatialAnchor(store, 30)).toThrow();
  });

  it('bounding control: a store WITH real source still resolves the anchor correctly', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STOREY_MODEL).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );

    const anchor = resolveSpatialAnchor(store, 30);

    expect(anchor.storeyPlacementId).toBe(20);
    expect(anchor.bodyContextId).toBe(7);
    expect(anchor.axisContextId).toBe(7);
  });
});
