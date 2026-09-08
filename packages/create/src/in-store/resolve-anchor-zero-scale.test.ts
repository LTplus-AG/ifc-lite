/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `resolveSpatialAnchor` guards `extractLengthUnitScale`'s result with
 * `s > 0` before trusting it — a zero (or negative/non-finite) scale must
 * fall back to the metre default, not be accepted verbatim, since a zero
 * scale would collapse every subsequently emitted length to 0. The real
 * `extractLengthUnitScale` implementation never returns exactly 0 (its own
 * guards route degenerate cases back to the 1.0 fallback), so this pins the
 * `resolveSpatialAnchor` guard directly by mocking that one export, mirroring
 * the pattern in `extract-walls-unit-scale.test.ts`.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('@ifc-lite/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ifc-lite/parser')>();
  return {
    ...actual,
    extractLengthUnitScale: () => 0,
  };
});

const { IfcParser } = await import('@ifc-lite/parser');
const { resolveSpatialAnchor } = await import('./resolve-anchor.js');

/** Minimal IFC4 model with one storey — enough for `resolveSpatialAnchor`. */
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveSpatialAnchor: zero length-unit scale', () => {
  it('falls back to the metre default instead of accepting a zero scale', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STOREY_MODEL).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );

    const anchor = resolveSpatialAnchor(store, 30);

    expect(anchor.lengthUnitScale).toBe(1.0);
  });
});
