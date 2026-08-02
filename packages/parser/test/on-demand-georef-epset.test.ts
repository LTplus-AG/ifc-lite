/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractGeoreferencingOnDemand } from '../src/on-demand-extractors.js';
import { EntityExtractor } from '../src/entity-extractor.js';

/**
 * The on-demand georef path (used by the viewer's properties panel) only
 * loaded IfcMapConversion/IfcProjectedCRS/IfcSite, so IFC2x3 models that carry
 * georeferencing in `ePset_MapConversion` / `ePset_ProjectedCRS` property sets
 * fell through to the legacy IfcSite EPSG:4326 fallback and displayed the wrong
 * CRS. These fixtures mirror files written by the `ifc-georeferencer` tool
 * (lowercase `ePset_`, typed IFCLABEL values).
 */
async function storeFromIfc(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('extractGeoreferencingOnDemand — IFC2x3 ePset fallback', () => {
  it('surfaces the EPSG code from lowercase ePset_ProjectedCRS (RD + NAP compound)', async () => {
    const ifc = `#6=IFCPROJECT('1mj5Hja8yfJfRTJSXP39EZ',$,'P',$,$,$,$,$,$);
#30=IFCSITE('06pHC0eJnCHlVXWW2sVoPO',$,'Site',$,$,$,$,$,.ELEMENT.,(51,26,47,208626),(5,27,36,650968),$,$,$);
#1357=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:7415'),$);
#1358=IFCPROPERTYSET('27AKTMp8j58fBEhvkJkcNJ',$,'ePset_ProjectedCRS',$,(#1357));
#1359=IFCRELDEFINESBYPROPERTIES('3eMryiQHj84vNzfI1G88R1',$,$,$,(#30),#1358);
#1360=IFCPROPERTYSINGLEVALUE('TargetCRS',$,IFCLABEL('EPSG:7415'),$);
#1361=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(160073528.13858587),$);
#1362=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(384153306.2191765),$);
#1363=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(0.),$);
#1364=IFCPROPERTYSINGLEVALUE('XAxisAbscissa',$,IFCREAL(0.6156614753256583),$);
#1365=IFCPROPERTYSINGLEVALUE('XAxisOrdinate',$,IFCREAL(-0.788010753606722),$);
#1366=IFCPROPERTYSINGLEVALUE('Scale',$,IFCREAL(1.),$);
#1367=IFCPROPERTYSET('2If4Y3Lpv6dgTDkC5x_dnr',$,'ePset_MapConversion',$,(#1360,#1361,#1362,#1363,#1364,#1365,#1366));
#1368=IFCRELDEFINESBYPROPERTIES('0AUnylrXbCLgALz5UN_kQ2',$,$,$,(#30),#1367);`;
    const store = await storeFromIfc(ifc);
    const georef = extractGeoreferencingOnDemand(store);

    expect(georef?.hasGeoreference).toBe(true);
    expect(georef?.source).toBe('ePSetMapConversion');
    // The whole point: the file's EPSG code reaches the panel, not EPSG:4326.
    expect(georef?.projectedCRS?.name).toBe('EPSG:7415');
    expect(georef?.mapConversion?.eastings).toBeCloseTo(160073528.13858587, 3);
  });

  it('reads horizontal-only EPSG:28992 the same way', async () => {
    const ifc = `#30=IFCSITE('06pHC0eJnCHlVXWW2sVoPO',$,'Site',$,$,$,$,$,.ELEMENT.,(51,26,47,208626),(5,27,36,650968),$,$,$);
#1357=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:28992'),$);
#1358=IFCPROPERTYSET('27AKTMp8j58fBEhvkJkcNJ',$,'ePset_ProjectedCRS',$,(#1357));
#1360=IFCPROPERTYSINGLEVALUE('TargetCRS',$,IFCLABEL('EPSG:28992'),$);
#1361=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(160073528.13858587),$);
#1362=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(384153306.2191765),$);
#1363=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(0.),$);
#1367=IFCPROPERTYSET('2If4Y3Lpv6dgTDkC5x_dnr',$,'ePset_MapConversion',$,(#1360,#1361,#1362,#1363));`;
    const store = await storeFromIfc(ifc);
    const georef = extractGeoreferencingOnDemand(store);

    expect(georef?.source).toBe('ePSetMapConversion');
    expect(georef?.projectedCRS?.name).toBe('EPSG:28992');
  });

  it('still uses the legacy IfcSite fallback when no ePsets exist', async () => {
    const ifc = `#30=IFCSITE('06pHC0eJnCHlVXWW2sVoPO',$,'Site',$,$,$,$,$,.ELEMENT.,(51,26,47,208626),(5,27,36,650968),$,$,$);`;
    const store = await storeFromIfc(ifc);
    const georef = extractGeoreferencingOnDemand(store);

    expect(georef?.source).toBe('siteLocation');
    expect(georef?.projectedCRS?.name).toBe('EPSG:4326');
  });

  it('memoizes per store so repeated calls do not re-scan property sets', async () => {
    // The on-demand scan decodes every IfcPropertySet to find ePset_MapConversion
    // on models without an IfcMapConversion. The viewer calls this on the render
    // path once per streamed geometry batch, so without caching a property-heavy
    // model re-scans tens of thousands of psets per batch (regression #1404).
    const ifc = `#30=IFCSITE('06pHC0eJnCHlVXWW2sVoPO',$,'Site',$,$,$,$,$,.ELEMENT.,(51,26,47,208626),(5,27,36,650968),$,$,$);
#1357=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:28992'),$);
#1358=IFCPROPERTYSET('27AKTMp8j58fBEhvkJkcNJ',$,'ePset_ProjectedCRS',$,(#1357));
#1360=IFCPROPERTYSINGLEVALUE('TargetCRS',$,IFCLABEL('EPSG:28992'),$);
#1367=IFCPROPERTYSET('2If4Y3Lpv6dgTDkC5x_dnr',$,'ePset_MapConversion',$,(#1360));`;
    const store = await storeFromIfc(ifc);
    const first = extractGeoreferencingOnDemand(store);
    const second = extractGeoreferencingOnDemand(store);
    // A cache miss recomputes a fresh GeoreferenceInfo object; the cache returns
    // the identical reference. Reference equality therefore proves memoization.
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  // Work-count regression guard (deterministic, machine-independent — counts
  // work done, not wall-clock). The georef scan decodes one entity per property
  // set on models without an IfcMapConversion; memoization must drop that to
  // zero on subsequent calls so the viewer's per-batch invocations are free.
  it('scans property sets once: zero entity decodes on the memoized second call', async () => {
    const PSET_COUNT = 400;
    let ifc = `#30=IFCSITE('06pHC0eJnCHlVXWW2sVoPO',$,'Site',$,$,$,$,$,.ELEMENT.,(51,26,47,208626),(5,27,36,650968),$,$,$);\n`;
    // Many non-georef property sets force the scan to run to completion (the
    // worst case: no ePset_MapConversion exists, so it never early-returns).
    for (let i = 0; i < PSET_COUNT; i += 1) {
      ifc += `#${1000 + i}=IFCPROPERTYSET('pset${i}aaaaaaaaaaaaaaaaaaaa',$,'Pset_Generic_${i}',$,());\n`;
    }
    const store = await storeFromIfc(ifc);

    const decode = vi.spyOn(EntityExtractor.prototype, 'extractEntity');
    decode.mockClear();
    extractGeoreferencingOnDemand(store);
    const firstCallDecodes = decode.mock.calls.length;
    decode.mockClear();
    extractGeoreferencingOnDemand(store);
    const secondCallDecodes = decode.mock.calls.length;
    decode.mockRestore();

    // First call actually scanned the property sets...
    expect(firstCallDecodes).toBeGreaterThanOrEqual(PSET_COUNT);
    // ...the second call did NO work — the regression (#1404) re-scanned on
    // every geometry batch, which on a real model is tens of thousands of
    // decodes per batch.
    expect(secondCallDecodes).toBe(0);
  });
});
