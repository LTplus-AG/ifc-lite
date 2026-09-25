/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BUILD → SERIALISE → PARSE, for the LandXML→IFC mapping.
 *
 * §8 of `docs/architecture/landxml-to-ifc-mapping.md` is explicit that a count
 * check is not acceptance, and §2.2 says why: a transposed export is a
 * reflection, so it stays well-formed, still renders, and passes every
 * count-based assertion. What this file asserts is therefore not "three
 * vertices came back" but **which authored value came back in X and which in
 * Y**, read out of the re-parsed file rather than out of the writer.
 *
 * The fixture's northings are ~6.4 million and its eastings ~158 thousand —
 * deliberately asymmetric and at realistic projected-CRS magnitudes. A square,
 * origin-centred fixture would pass this file with the axes swapped.
 *
 * Note on `store.entities.getTypeName`: the TypeScript lite parser does not
 * index tessellated geometry *resource* entities by type name — it reports
 * `Unknown` for `IfcCartesianPointList3D`. `store.getEntity()` returns their
 * parsed attributes regardless, which is what these assertions read. The
 * express ids are located from the serialized text, so a change in emission
 * order cannot quietly repoint an assertion at a different entity.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import { landXmlToIfc } from './landxml-to-ifc.js';
import type { LandXmlIfcSource } from './source-types.js';

/** Realistic SWEREF99 TM values: northings ~6.4e6, eastings ~1.6e5. */
const SOURCE: LandXmlIfcSource = {
  schema: 'LandXML-1.2',
  version: '1.2',
  units: {
    linearUnit: 'meter', elevationUnit: 'meter',
    linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
  },
  surfaces: [{
    sourceId: 'landxml:surface:1',
    name: 'Existing Ground',
    kind: 'tin',
    renderState: 'rendered',
    points: [
      { sourceId: 'landxml:surface:1:point:1', id: '1', northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
      { sourceId: 'landxml:surface:1:point:2', id: '2', northing: 6406990.12, easting: 157903.44, elevation: 21.03 },
      { sourceId: 'landxml:surface:1:point:3', id: '3', northing: 6407001.55, easting: 157888.02, elevation: 19.88 },
      { sourceId: 'landxml:surface:1:point:4', id: '4', northing: 6407012.40, easting: 157875.91, elevation: 18.42 },
    ],
    faces: [['1', '2', '3'], ['2', '4', '3']],
  }],
  plan: {
    cogoPoints: [{
      sourceId: 'landxml:cgpoint:994',
      name: 'Point 994',
      code: 'VAG_VM',
      description: 'Offset startpoint',
      point: { northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
    }],
  },
};

async function exportAndParse(source: LandXmlIfcSource): Promise<{ content: string; store: IfcDataStore }> {
  const result = landXmlToIfc(source, { sourceFileName: 'eg.xml', timestampMs: 0 });
  expect(result.status, 'a mappable source must export').toBe('exported');
  const content = result.status === 'exported' ? result.content : '';
  const bytes = new TextEncoder().encode(content);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  return { content, store };
}

/** The express id of the first instance of `type` in the emitted text. */
function expressIdOf(content: string, type: string): number {
  const match = new RegExp(`#(\\d+)=${type}\\(`).exec(content);
  expect(match, `${type} must be present in the exported file`).not.toBeNull();
  return Number(match![1]);
}

describe('LandXML→IFC round trip (#4937, mapping §8.1)', () => {
  it('re-parses as IFC4X3 with the terrain and survey products the mapping promises', async () => {
    const { content, store } = await exportAndParse(SOURCE);
    expect(store.schemaVersion).toBe('IFC4X3');

    const terrain = store.getEntity!(expressIdOf(content, 'IFCGEOGRAPHICELEMENT'));
    expect(terrain!.type).toBe('IFCGEOGRAPHICELEMENT');
    expect(terrain!.attributes[2], 'the LandXML surface name survives as Name').toBe('Existing Ground');
    expect(terrain!.attributes[8], 'PredefinedType is .TERRAIN.').toBe('.TERRAIN.');

    const annotation = store.getEntity!(expressIdOf(content, 'IFCANNOTATION'));
    expect(annotation!.attributes[2]).toBe('Point 994');
    expect(annotation!.attributes[7], 'PredefinedType is .SURVEY.').toBe('.SURVEY.');
  });

  it('puts the LandXML EASTING in X and the NORTHING in Y, read back from the parsed file', async () => {
    const { content, store } = await exportAndParse(SOURCE);
    const coordList = store.getEntity!(expressIdOf(content, 'IFCCARTESIANPOINTLIST3D'));
    const rows = coordList!.attributes[0] as number[][];

    expect(rows).toHaveLength(SOURCE.surfaces[0].points.length);
    // Per authored vertex, not just the first: a writer that transposed only
    // some rows would still satisfy a single-row check.
    SOURCE.surfaces[0].points.forEach((point, index) => {
      expect(rows[index][0], `vertex ${index} X must be the authored easting`).toBeCloseTo(point.easting, 6);
      expect(rows[index][1], `vertex ${index} Y must be the authored northing`).toBeCloseTo(point.northing, 6);
      expect(rows[index][2], `vertex ${index} Z must be the authored elevation`).toBeCloseTo(point.elevation, 6);
    });

    // And the two must not be interchangeable in this fixture — if they were,
    // the assertions above would prove nothing.
    expect(rows[0][0]).not.toBeCloseTo(rows[0][1], 0);
  });

  it('places the survey point at its easting/northing through the placement, not the representation', async () => {
    const { content, store } = await exportAndParse(SOURCE);
    const annotationId = expressIdOf(content, 'IFCANNOTATION');
    const annotation = store.getEntity!(annotationId)!;

    const placement = store.getEntity!(annotation.attributes[5] as number)!;
    const axis = store.getEntity!(placement.attributes[1] as number)!;
    const located = store.getEntity!(axis.attributes[0] as number)!;
    const coordinates = located.attributes[0] as number[];
    const authored = SOURCE.plan!.cogoPoints![0].point!;
    expect(coordinates[0], 'placement X is the easting').toBeCloseTo(authored.easting, 6);
    expect(coordinates[1], 'placement Y is the northing').toBeCloseTo(authored.northing, 6);
    expect(coordinates[2]).toBeCloseTo(authored.elevation!, 6);

    // The representation carries the LOCAL origin, deliberately: one
    // authoritative position per point, not two that can disagree.
    const shape = store.getEntity!(annotation.attributes[6] as number)!;
    const representation = store.getEntity!((shape.attributes[2] as number[])[0])!;
    const item = store.getEntity!((representation.attributes[3] as number[])[0])!;
    expect(item.attributes[0]).toEqual([0, 0, 0]);
  });

  it('satisfies the IfcTriangulatedIrregularNetwork constraints after a real parse', async () => {
    const { content, store } = await exportAndParse(SOURCE);
    const tin = store.getEntity!(expressIdOf(content, 'IFCTRIANGULATEDIRREGULARNETWORK'))!;

    // Attribute order: Coordinates, Normals, Closed, CoordIndex, PnIndex, Flags.
    expect(tin.attributes[0], 'Coordinates references the point list')
      .toBe(expressIdOf(content, 'IFCCARTESIANPOINTLIST3D'));
    // `NotClosed : Closed = FALSE` — `$` does NOT satisfy it, so this must be
    // the explicit boolean and never absent.
    expect(tin.attributes[2]).toBe('.F.');
    expect(tin.attributes[3], 'CoordIndex is 1-based and matches the authored faces')
      .toEqual([[1, 2, 3], [2, 4, 3]]);
    // `Flags` is mandatory and LIST [1:?], unlike most IFC list attributes.
    expect(Array.isArray(tin.attributes[5])).toBe(true);
    expect((tin.attributes[5] as number[]).length).toBeGreaterThan(0);
  });

  it('contains the terrain and the survey point in the site', async () => {
    const { content, store } = await exportAndParse(SOURCE);
    const siteId = expressIdOf(content, 'IFCSITE');
    const terrainId = expressIdOf(content, 'IFCGEOGRAPHICELEMENT');
    const annotationId = expressIdOf(content, 'IFCANNOTATION');

    const containments = [...content.matchAll(/#(\d+)=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/g)]
      .map((match) => store.getEntity!(Number(match[1]))!);
    const toSite = containments.filter((rel) => rel.attributes[5] === siteId);
    expect(toSite, 'exactly one containment row targets the site').toHaveLength(1);
    expect(toSite[0].attributes[4]).toEqual(expect.arrayContaining([terrainId, annotationId]));
  });

  it('carries its conversion provenance into the parsed file', async () => {
    const { content, store } = await exportAndParse(SOURCE);
    const setId = [...content.matchAll(/#(\d+)=IFCPROPERTYSET\(/g)]
      .map((match) => Number(match[1]))
      .find((id) => (store.getEntity!(id)!.attributes[2]) === 'LandXML_Conversion');
    expect(setId, 'the conversion provenance property set survives a parse').toBeDefined();

    // NominalValue comes back as the parsed typed value — `['IFCLABEL', ...]`
    // — which is itself worth pinning: every conversion property is written as
    // a label rather than promoted to a number, so a value like '00123' keeps
    // its leading zero.
    const byName = new Map(
      (store.getEntity!(setId!)!.attributes[4] as number[])
        .map((id) => store.getEntity!(id)!)
        .map((property) => [property.attributes[0] as string, property.attributes[2] as [string, string]]),
    );
    expect(byName.get('MappingVersion')).toEqual(['IFCLABEL', '1.3']);
    expect(byName.get('LandXmlSchema')).toEqual(['IFCLABEL', 'LandXML-1.2']);
    expect(byName.get('SourceFileName')).toEqual(['IFCLABEL', 'eg.xml']);
    expect(byName.get('CoordinateOrderSwapped')).toEqual(['IFCLABEL', 'false']);
  });
});
