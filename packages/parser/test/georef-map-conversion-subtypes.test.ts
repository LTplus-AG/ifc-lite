/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `entityIndex.byType` is keyed by the RAW STEP type name, so a georeferencing
 * read that asks only for `IfcMapConversion` never sees a file written with a
 * concrete subtype spelling. IFC4X3 has exactly one such subtype,
 * `IfcMapConversionScaled`, and missing it did not merely drop a field: with no
 * mapConversion there is no `transformMatrix`, so the model was placed at its
 * local origin instead of its map position. Same defect shape as #3229/#3232.
 *
 * The list is checked against the generated schema tables in BOTH directions
 * so it cannot drift: nothing concrete in the IfcMapConversion family may be
 * missing from it, and nothing in it may be a name no bundled schema defines.
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import type { IfcEntityInfo } from '@ifc-lite/data';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractGeoreferencingOnDemand } from '../src/on-demand-extractors.js';
import { MAP_CONVERSION_TYPE_NAMES } from '../src/georef-extractor.js';

const SCHEMAS: ReadonlyArray<readonly [string, readonly IfcEntityInfo[]]> = [
  ['IFC2X3', ENTITIES_IFC2X3],
  ['IFC4', ENTITIES_IFC4],
  ['IFC4X3', ENTITIES_IFC4X3],
];

/** Concrete entities whose parent chain reaches `root`, plus `root` itself. */
function concreteFamily(entities: readonly IfcEntityInfo[], root: string): Set<string> {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const out = new Set<string>();
  for (const entity of entities) {
    if (entity.abstract) continue;
    let cursor: IfcEntityInfo | undefined = entity;
    for (let hops = 0; cursor && hops <= 64; hops++) {
      if (cursor.name === root) {
        out.add(entity.name);
        break;
      }
      cursor = cursor.parent ? byName.get(cursor.parent) : undefined;
    }
  }
  return out;
}

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

/** IfcMapConversion's own attributes, then the three IfcMapConversionScaled adds. */
const BASE_ATTRS = '#10,#37,545991.679663973,4184941.96970872,0.,0.866025,0.5,1.';
const HEADER = `#6=IFCPROJECT('1mj5Hja8yfJfRTJSXP39EZ',$,'P',$,$,$,$,$,$);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);
#37=IFCPROJECTEDCRS('EPSG:25833','ETRS89 / UTM 33N','ETRS89','NN2000',$,'33N',$);`;

describe('MAP_CONVERSION_TYPE_NAMES tracks the schema', () => {
  // Anti-vacuity: the derivation must find a family at all, and it must find
  // the subtype that makes this test worth having. Otherwise both direction
  // checks below would pass over an empty set forever.
  it('the derivation is non-vacuous and finds the IFC4X3 subtype', () => {
    for (const [label, entities] of SCHEMAS) {
      const family = concreteFamily(entities, 'IfcMapConversion');
      if (label === 'IFC2X3') {
        // IFC2X3 has no IfcMapConversion at all — that is the ePSet path.
        expect(family.size, `${label} unexpectedly defines IfcMapConversion`).toBe(0);
        continue;
      }
      expect(family.has('IfcMapConversion'), `${label}: the root must be in its own family`).toBe(true);
    }
    expect(concreteFamily(ENTITIES_IFC4X3, 'IfcMapConversion').has('IfcMapConversionScaled')).toBe(true);
    expect(concreteFamily(ENTITIES_IFC4, 'IfcMapConversion').has('IfcMapConversionScaled')).toBe(false);
  });

  it('names every concrete IfcMapConversion class of every bundled schema', () => {
    const listed = new Set(MAP_CONVERSION_TYPE_NAMES);
    const missing: string[] = [];
    for (const [label, entities] of SCHEMAS) {
      for (const name of concreteFamily(entities, 'IfcMapConversion')) {
        if (!listed.has(name)) missing.push(`${label}:${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names no class that no bundled schema defines', () => {
    const known = new Set<string>();
    for (const [, entities] of SCHEMAS) {
      for (const name of concreteFamily(entities, 'IfcMapConversion')) known.add(name);
    }
    expect(MAP_CONVERSION_TYPE_NAMES.filter((n) => !known.has(n))).toEqual([]);
  });
});

describe('extractGeoreferencingOnDemand reads IfcMapConversionScaled', () => {
  it('gives IFCMAPCONVERSIONSCALED the same georeference as IFCMAPCONVERSION', async () => {
    const plain = await storeFromIfc(`${HEADER}\n#38=IFCMAPCONVERSION(${BASE_ATTRS});`);
    const scaled = await storeFromIfc(`${HEADER}\n#38=IFCMAPCONVERSIONSCALED(${BASE_ATTRS},1.,1.,1.);`);

    // Pin the control, so a regression that breaks BOTH spellings cannot pass
    // this test by making them equally broken.
    const plainGeoref = extractGeoreferencingOnDemand(plain);
    expect(plainGeoref?.source).toBe('mapConversion');
    expect(plainGeoref?.mapConversion?.eastings).toBeCloseTo(545991.679663973, 6);
    expect(plainGeoref?.transformMatrix).toBeDefined();

    const scaledGeoref = extractGeoreferencingOnDemand(scaled);
    expect(scaledGeoref?.source).toBe('mapConversion');
    expect(scaledGeoref?.mapConversion).toEqual(plainGeoref?.mapConversion);
    expect(scaledGeoref?.transformMatrix).toEqual(plainGeoref?.transformMatrix);
  });

  it('does not leave a CRS the model cannot be transformed into', async () => {
    // The nastiest shape of the miss. Without the widening the scaled file
    // yields no mapConversion and therefore no transformMatrix, yet
    // `hasGeoreference` stays TRUE off the IfcProjectedCRS alone and `source`
    // is left undefined — so the file reports a projected CRS while sitting at
    // its local origin, rather than reporting itself ungeoreferenced. The
    // IfcSite here also pins that the fallback chain is not what answers.
    const scaled = await storeFromIfc(
      `${HEADER}
#30=IFCSITE('06pHC0eJnCHlVXWW2sVoPO',$,'Site',$,$,$,$,$,.ELEMENT.,(51,26,47,208626),(5,27,36,650968),$,$,$);
#38=IFCMAPCONVERSIONSCALED(${BASE_ATTRS},1.,1.,1.);`,
    );
    const georef = extractGeoreferencingOnDemand(scaled);
    expect(georef?.projectedCRS?.name).toBe('EPSG:25833');
    expect(georef?.source).toBe('mapConversion');
    expect(georef?.transformMatrix).toBeDefined();
    expect(georef?.mapConversion?.northings).toBeCloseTo(4184941.96970872, 6);
  });
});
