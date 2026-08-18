/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tests that travel with `step-georeferencing.ts` (#2475 step 2a).
 *
 * Membership was established by MUTATION, not by name: disabling the phase at
 * its call site in `step-exporter.ts` kills 13 of the 15 tests below, and a
 * per-site sweep over all 43 guards and ledger calls in the moved region kills
 * the same named sets here as it did with the code in `step-exporter.ts`. The
 * two survivors of the whole-phase disable belong here for the same reason
 * their siblings do: "reports nothing when no georeferencing was requested" is
 * the control that keeps the refusal tests around it honest, and "writing the
 * Name the IfcProjectedCRS already has claims nothing" is killed by mutating
 * the CRS branch's `modifiedAttributes` initialisation rather than by removing
 * the phase, because with no phase nothing is claimed either.
 *
 * Three near-misses stayed behind deliberately. `rejects georeferencing edits
 * for IFC2X3 export` (`step-exporter.test.ts`) throws in `export()`'s setup,
 * before this phase runs. `reuses the project length unit when exporting
 * property units` (same file) reaches `findLengthUnitReference` through
 * `findUnitId` on the property-set path, not through georeferencing. And
 * `unit-normalize.test.ts`'s "excludes unit-definition and georeferencing
 * entities" exercises an unrelated classification table and touches none of
 * this module.
 *
 * The blocks below keep their original `describe` names so the suite reports
 * the same full test names it reported before the move.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

/** Decode Uint8Array content to string for test assertions */
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The "N modification(s)" the HEADER's FILE_DESCRIPTION claims, or null when
 *  it makes no such claim. */
function headerClaimedModifications(stepText: string): number | null {
  const m = /Re-exported by ifc-lite, (\d+) modification/.exec(stepText);
  return m ? Number(m[1]) : null;
}

/** Every `#id=CLASS(...)` defining line in the DATA section. */
function dataEntityLines(stepText: string): string[] {
  const data = stepText.slice(stepText.indexOf('DATA;') + 'DATA;'.length, stepText.indexOf('ENDSEC;', stepText.indexOf('DATA;')));
  return data.split('\n').map((l) => l.trim()).filter((l) => /^#\d+\s*=/.test(l));
}

type MockEntityRef = { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number };

function buildMockDataStore(
  entries: Array<[number, string, string]>,
  deferredIds?: Set<number>,
): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const deferred = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    const ref: MockEntityRef = { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 };
    // Deferred property atoms live in the source buffer but are split out of
    // byId/byType into deferredEntityIndex (mirrors deferPropertyAtomIndex).
    if (deferredIds?.has(id)) {
      deferred.set(id, ref);
    } else {
      byId.set(id, ref);
      if (!byType.has(upper)) byType.set(upper, []);
      byType.get(upper)!.push(id);
    }
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) {
    source.set(part, position);
    position += part.byteLength;
  }

  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
    ...(deferred.size > 0 ? { deferredEntityIndex: deferred } : {}),
  } as unknown as IfcDataStore;
}

/** A minimal already-georeferenced model: `#40` CRS, `#41` MapConversion. */
function buildGeoreferencedMockDataStore(): IfcDataStore {
  return buildMockDataStore([
    [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Project',$,$,$,$,(#20),#30);"],
    [2, 'IFCSIUNIT', '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);'],
    [20, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);"],
    [21, 'IFCAXIS2PLACEMENT3D', '#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);'],
    [22, 'IFCCARTESIANPOINT', '#22=IFCCARTESIANPOINT((0.,0.,0.));'],
    [23, 'IFCDIRECTION', '#23=IFCDIRECTION((0.,0.,1.));'],
    [24, 'IFCDIRECTION', '#24=IFCDIRECTION((1.,0.,0.));'],
    [30, 'IFCUNITASSIGNMENT', '#30=IFCUNITASSIGNMENT((#2));'],
    [40, 'IFCPROJECTEDCRS', "#40=IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+',$,$,$,#2);"],
    [41, 'IFCMAPCONVERSION', '#41=IFCMAPCONVERSION(#20,#40,1.,2.,3.,1.,0.,1.);'],
  ]);
}

/** Count `#N` references in the output that have no `#N=` definition. */
function findDanglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

const SIMPLE_TYPE_INHERITANCE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('bonsai-wall.ifc','2026-03-05T16:26:36+01:00',(''),(''),'IfcOpenShell 0.8.4','Bonsai 0.8.4','Nobody');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('3hDMyWaBD34QvUUlT4RWFp',$,'My Project',$,$,$,$,(#14,#26),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#5=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#6=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#7=IFCMEASUREWITHUNIT(IFCREAL(0.0174532925199433),#6);
#8=IFCCONVERSIONBASEDUNIT(#5,.PLANEANGLEUNIT.,'degree',#7);
#9=IFCUNITASSIGNMENT((#4,#2,#8,#3));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
#15=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);
#16=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#14,$,.GRAPH_VIEW.,$);
#17=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Box','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);
#18=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Annotation','Model',*,*,*,*,#14,$,.SECTION_VIEW.,$);
#19=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Annotation','Model',*,*,*,*,#14,$,.ELEVATION_VIEW.,$);
#20=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Annotation','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);
#21=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Annotation','Model',*,*,*,*,#14,$,.PLAN_VIEW.,$);
#22=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Profile','Model',*,*,*,*,#14,$,.ELEVATION_VIEW.,$);
#23=IFCCARTESIANPOINT((0.,0.));
#24=IFCDIRECTION((1.,0.));
#25=IFCAXIS2PLACEMENT2D(#23,#24);
#26=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-05,#25,$);
#27=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Plan',*,*,*,*,#26,$,.GRAPH_VIEW.,$);
#28=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Plan',*,*,*,*,#26,$,.PLAN_VIEW.,$);
#29=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Annotation','Plan',*,*,*,*,#26,$,.PLAN_VIEW.,$);
#30=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Annotation','Plan',*,*,*,*,#26,$,.REFLECTED_PLAN_VIEW.,$);
#31=IFCSITE('1ys5Xwuxz8gPJk6N$NGhAG',$,'My Site',$,$,#54,$,$,$,$,$,$,$,$);
#37=IFCBUILDING('1dD_4AEJ59G9oTwHbSmmRt',$,'My Building',$,$,#60,$,$,$,$,$,$);
#43=IFCBUILDINGSTOREY('3k5u60s7r12OPKv1nruD6M',$,'My Storey',$,$,#66,$,$,$,$);
#49=IFCRELAGGREGATES('1RfFWrOFL6ced6gx07DFcL',$,$,$,#1,(#31));
#50=IFCCARTESIANPOINT((0.,0.,0.));
#51=IFCDIRECTION((0.,0.,1.));
#52=IFCDIRECTION((1.,0.,0.));
#53=IFCAXIS2PLACEMENT3D(#50,#51,#52);
#54=IFCLOCALPLACEMENT($,#53);
#55=IFCRELAGGREGATES('13VdlfCyD7IvzBfhQF8M3Y',$,$,$,#31,(#37));
#56=IFCCARTESIANPOINT((0.,0.,0.));
#57=IFCDIRECTION((0.,0.,1.));
#58=IFCDIRECTION((1.,0.,0.));
#59=IFCAXIS2PLACEMENT3D(#56,#57,#58);
#60=IFCLOCALPLACEMENT(#54,#59);
#61=IFCRELAGGREGATES('2wzboEKcj62wkpq4H3Go4A',$,$,$,#37,(#43));
#62=IFCCARTESIANPOINT((0.,0.,0.));
#63=IFCDIRECTION((0.,0.,1.));
#64=IFCDIRECTION((1.,0.,0.));
#65=IFCAXIS2PLACEMENT3D(#62,#63,#64);
#66=IFCLOCALPLACEMENT(#60,#65);
#67=IFCWALLTYPE('02noD_fgv7DRHMvfv0SV0w',$,'Unnamed',$,$,(#72,#114),$,$,$,.SOLIDWALL.);
#68=IFCMATERIAL('Unknown',$,$);
#69=IFCMATERIALLAYERSET((#71),$,$);
#70=IFCRELASSOCIATESMATERIAL('0GZpueOLHCp8ItZI8K9juZ',$,$,$,(#67),#69);
#71=IFCMATERIALLAYER(#68,0.1,$,$,$,$,$);
#72=IFCPROPERTYSET('18KOgExr53LPlg5lwhO6kc',$,'EPset_Parametric',$,(#73));
#73=IFCPROPERTYSINGLEVALUE('LayerSetDirection',$,IFCLABEL('AXIS2'),$);
#74=IFCWALL('2Z2BGIG3j5fRzbeoRb82Lt',$,'Wall',$,$,#87,#82,$,$);
#75=IFCRELCONTAINEDINSPATIALSTRUCTURE('0ks7WqP9P1T9HzMS3XRmfq',$,$,$,(#74),#43);
#76=IFCRELDEFINESBYTYPE('1w3sQ1jr1BZ9doHPwxb_Ot',$,$,$,(#74),#67);
#77=IFCMATERIALLAYERSETUSAGE(#69,.AXIS2.,.POSITIVE.,0.,$);
#78=IFCRELASSOCIATESMATERIAL('166pYvOfvEhwbgTPrP$zhW',$,$,$,(#74),#77);
#82=IFCPRODUCTDEFINITIONSHAPE($,$,(#113,#110));
#83=IFCCARTESIANPOINT((0.,0.,0.));
#84=IFCDIRECTION((0.,0.,1.));
#85=IFCDIRECTION((7.54979012640431E-08,0.999999999999997,0.));
#86=IFCAXIS2PLACEMENT3D(#83,#84,#85);
#87=IFCLOCALPLACEMENT(#66,#86);
#98=IFCPROPERTYSET('2uHe2P__j6SQdzI5aAl7dy',$,'EPset_Parametric',$,(#100));
#99=IFCRELDEFINESBYPROPERTIES('3RvuyBKU97PewBz7cjM$Si',$,$,$,(#74),#98);
#100=IFCPROPERTYSINGLEVALUE('Engine',$,IFCLABEL('Bonsai.DumbLayer2'),$);
#101=IFCCARTESIANPOINTLIST2D(((0.,0.),(0.,0.1),(6.50000000000002,0.1),(6.50000000000002,0.)));
#102=IFCINDEXEDPOLYCURVE(#101,(IFCLINEINDEX((1,2,3,4,1))),$);
#103=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#102);
#104=IFCCARTESIANPOINT((0.,0.,0.));
#105=IFCDIRECTION((0.,0.,1.));
#106=IFCDIRECTION((1.,0.,0.));
#107=IFCAXIS2PLACEMENT3D(#104,#105,#106);
#108=IFCDIRECTION((0.,0.,1.));
#109=IFCEXTRUDEDAREASOLID(#103,#107,#108,3.);
#110=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#109));
#111=IFCCARTESIANPOINTLIST2D(((0.,0.),(6.50000000000002,0.)));
#112=IFCINDEXEDPOLYCURVE(#111,$,$);
#113=IFCSHAPEREPRESENTATION(#27,'Axis','Curve2D',(#112));
#114=IFCPROPERTYSET('3wkd_mjInDCfOthy7w_A6V',$,'Pset_WallCommon',$,(#115));
#115=IFCPROPERTYSINGLEVALUE('AcousticRating',$,IFCLABEL('This is Pset of the WallType'),$);
#116=IFCPROPERTYSET('1yqM3I0Wn6ah7BCQg6Cf_U',$,'Pset_Warranty',$,(#118));
#117=IFCRELDEFINESBYPROPERTIES('0x8Q_7Can5hOwBoiPhy1Mf',$,$,$,(#74),#116);
#118=IFCPROPERTYSINGLEVALUE('Exclusions',$,IFCTEXT('This is Pset of the Wall occurence'),$);
ENDSEC;
END-ISO-10303-21;`;

describe('StepExporter', () => {
  it('creates IfcProjectedCRS and IfcMapConversion from scratch when georeferencing is added', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(SIMPLE_TYPE_INHERITANCE_IFC).buffer);
    const exporter = new StepExporter(store);

    const result = exporter.export({
      schema: 'IFC4',
      applyMutations: true,
      georefMutations: {
        projectedCRS: {
          name: 'EPSG:2056',
          description: 'CH1903+ / LV95',
          geodeticDatum: 'CH1903+',
          mapProjection: 'Swiss Oblique Mercator 1995',
          mapUnit: 'METRE',
        },
        mapConversion: {
          eastings: 2600000,
          northings: 1200000,
          orthogonalHeight: 500,
          xAxisAbscissa: 0,
          xAxisOrdinate: 1,
          scale: 1,
        },
      },
    });

    const content = decode(result.content);
    expect(content).toContain("IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95','CH1903+',$,'Swiss Oblique Mercator 1995',$,#");
    expect(content).toMatch(/IFCMAPCONVERSION\(#14,#\d+,2600000\.,1200000\.,500\.,0\.,1\.,1\.\);/);
    expect(content).toContain('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
    // A surviving context means nothing was refused — no spurious warning.
    expect(result.stats.warnings).toEqual([]);
  });

  it('prefers the 3D model representation context when creating IfcMapConversion', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Project',$,$,$,$,(#10,#20),#30);"],
      [10, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-05,#11,$);"],
      [11, 'IFCAXIS2PLACEMENT2D', "#11=IFCAXIS2PLACEMENT2D(#12,#13);"],
      [12, 'IFCCARTESIANPOINT', '#12=IFCCARTESIANPOINT((0.,0.));'],
      [13, 'IFCDIRECTION', '#13=IFCDIRECTION((1.,0.));'],
      [20, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);"],
      [21, 'IFCAXIS2PLACEMENT3D', "#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);"],
      [22, 'IFCCARTESIANPOINT', '#22=IFCCARTESIANPOINT((0.,0.,0.));'],
      [23, 'IFCDIRECTION', '#23=IFCDIRECTION((0.,0.,1.));'],
      [24, 'IFCDIRECTION', '#24=IFCDIRECTION((1.,0.,0.));'],
      [30, 'IFCUNITASSIGNMENT', '#30=IFCUNITASSIGNMENT(());'],
    ]);

    const exporter = new StepExporter(dataStore);
    const result = exporter.export({
      schema: 'IFC4',
      applyMutations: true,
      georefMutations: {
        projectedCRS: { name: 'EPSG:2056', mapUnit: 'METRE' },
        mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
      },
    });

    expect(decode(result.content)).toMatch(/IFCMAPCONVERSION\(#20,#\d+,2600000\.,1200000\.,500\.,1\.,0\.,1\.\);/);
    // Happy path: the conversion was written, so nothing was refused.
    expect(result.stats.warnings).toEqual([]);
  });

  describe('map conversion that cannot be written (#2067)', () => {
    // No IfcGeometricRepresentationContext anywhere, so there is no id the new
    // IfcMapConversion could use as SourceCRS. Skipping it is correct — writing
    // it would dangle — but the file that comes back is identical to one where
    // no map conversion was ever requested, so the refusal has to be returned.
    const NO_CONTEXT_ENTRIES: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Project',$,$,$,$,$,#30);"],
      [2, 'IFCSIUNIT', '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);'],
      [30, 'IFCUNITASSIGNMENT', '#30=IFCUNITASSIGNMENT((#2));'],
    ];

    it('reports the refusal when creating both the CRS and the conversion', () => {
      const dataStore = buildMockDataStore(NO_CONTEXT_ENTRIES);

      const result = new StepExporter(dataStore).export({
        schema: 'IFC4',
        applyMutations: true,
        georefMutations: {
          projectedCRS: { name: 'EPSG:1234', mapUnit: 'METRE' },
          mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
        },
      });

      const content = decode(result.content);
      // A map conversion really was requested and the CRS really was written —
      // the absent IFCMAPCONVERSION is the thing under test, not a no-op export.
      expect(content).toContain("IFCPROJECTEDCRS('EPSG:1234'");
      expect(content).not.toContain('IFCMAPCONVERSION');
      expect(findDanglingRefs(content)).toEqual([]);
      expect(result.stats.warnings).toHaveLength(1);
      // `SourceCRS` is the substring that discriminates this refusal from the
      // TargetCRS one: `toContain('IfcMapConversion')` alone is satisfied by
      // either message, so it cannot tell the two refusals apart (#2105
      // review). Full equality pins the explanation, not merely that
      // something was reported.
      expect(result.stats.warnings[0]).toContain('SourceCRS');
      expect(result.stats.warnings[0]).toBe(
        'Cannot create IfcMapConversion: no IfcGeometricRepresentationContext is available to reference as SourceCRS. The IfcProjectedCRS is unaffected.',
      );
    });

    it('reports the refusal when the CRS already exists and only the conversion is new', () => {
      const dataStore = buildMockDataStore([
        ...NO_CONTEXT_ENTRIES,
        [40, 'IFCPROJECTEDCRS', "#40=IFCPROJECTEDCRS('EPSG:1234',$,$,$,$,$,#2);"],
      ]);

      const result = new StepExporter(dataStore).export({
        schema: 'IFC4',
        applyMutations: true,
        georefMutations: {
          mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500 },
        },
      });

      const content = decode(result.content);
      expect(content).toContain("#40=IFCPROJECTEDCRS('EPSG:1234'");
      expect(content).not.toContain('IFCMAPCONVERSION');
      expect(result.stats.warnings).toHaveLength(1);
      // On this path the export writes no IfcProjectedCRS at all — it
      // references the pre-existing #40. The message must not claim a CRS
      // was written, only that the conversion could not be (#2105 review).
      // Full equality pins the explanation to the same strength as the other
      // two refusal tests in this describe block (#2105 review round two).
      expect(result.stats.warnings[0]).not.toContain('was written');
      expect(result.stats.warnings[0]).toBe(
        'Cannot create IfcMapConversion: no IfcGeometricRepresentationContext is available to reference as SourceCRS. The IfcProjectedCRS is unaffected.',
      );
    });

    it('reports the refusal even when the delta export has nothing else to write', () => {
      const dataStore = buildMockDataStore([
        ...NO_CONTEXT_ENTRIES,
        [40, 'IFCPROJECTEDCRS', "#40=IFCPROJECTEDCRS('EPSG:1234',$,$,$,$,$,#2);"],
      ]);

      const result = new StepExporter(dataStore).export({
        schema: 'IFC4',
        applyMutations: true,
        deltaOnly: true,
        georefMutations: {
          mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500 },
        },
      });

      expect(decode(result.content)).not.toContain('IFCMAPCONVERSION');
      expect(result.stats.warnings).toHaveLength(1);
    });

    it('reports nothing when no georeferencing was requested', () => {
      const dataStore = buildMockDataStore(NO_CONTEXT_ENTRIES);

      const result = new StepExporter(dataStore).export({ schema: 'IFC4', applyMutations: true });

      expect(result.stats.warnings).toEqual([]);
    });

    it('reports the refusal when a map conversion is requested with no projectedCRS and none in the file', () => {
      // Neither IFCPROJECTEDCRS nor IFCMAPCONVERSION exists, and the caller
      // did not ask for a projectedCRS either — both CREATE branches skip,
      // so nothing is attempted and (before the fix) nothing was refused.
      //
      // The fixture CARRIES a context on purpose (review of #2105). Under
      // NO_CONTEXT_ENTRIES both refusal conditions are true at once, so the
      // context-specific message reads as acceptable here and the test cannot
      // tell the two refusals apart — it passed when the branch emitted the
      // wrong explanation. With a usable context present, the missing CRS is
      // the only thing that can produce a refusal.
      const dataStore = buildMockDataStore([
        ...NO_CONTEXT_ENTRIES,
        [50, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#50=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);"],
      ]);

      const result = new StepExporter(dataStore).export({
        schema: 'IFC4',
        applyMutations: true,
        georefMutations: {
          mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500 },
        },
      });

      const content = decode(result.content);
      expect(content).not.toContain('IFCMAPCONVERSION');
      expect(content).not.toContain('IFCPROJECTEDCRS');
      expect(result.stats.warnings).toHaveLength(1);
      // `TargetCRS` is the one substring that discriminates the two messages:
      // the context message also mentions both IfcMapConversion and
      // IfcProjectedCRS ("...The IfcProjectedCRS is unaffected"), so asserting
      // on those alone passes for either. Equality pins the explanation, not
      // merely that something was reported.
      expect(result.stats.warnings[0]).toContain('TargetCRS');
      expect(result.stats.warnings[0]).toBe(
        'Cannot create IfcMapConversion: no IfcProjectedCRS was requested and none exists in the file to reference as TargetCRS. Nothing was written.',
      );
    });
  });

  it('recreates georeferencing the session deleted instead of editing the tombstone', () => {
    const dataStore = buildGeoreferencedMockDataStore();
    const mutationView = new MutablePropertyView(null, 'model-georef');
    mutationView.deleteEntity(40);
    mutationView.deleteEntity(41);

    const exporter = new StepExporter(dataStore, mutationView);
    const result = exporter.export({
      schema: 'IFC4',
      applyMutations: true,
      georefMutations: {
        projectedCRS: { name: 'EPSG:1234', mapUnit: 'METRE' },
        mapConversion: { eastings: 10, northings: 20, orthogonalHeight: 30, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
      },
    });

    const content = decode(result.content);
    // The tombstoned #40/#41 are never written, so the edit has to land on a
    // NEW pair — otherwise the georeferencing disappears from the file.
    expect(content).not.toContain('#40=');
    expect(content).not.toContain('#41=');
    expect(content).toContain("IFCPROJECTEDCRS('EPSG:1234'");
    expect(content).toMatch(/IFCMAPCONVERSION\(#20,#\d+,10\.,20\.,30\.,1\.,0\.,1\.\);/);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('recreates a deleted IfcMapConversion while keeping the surviving IfcProjectedCRS', () => {
    const dataStore = buildGeoreferencedMockDataStore();
    const mutationView = new MutablePropertyView(null, 'model-georef');
    mutationView.deleteEntity(41);

    const exporter = new StepExporter(dataStore, mutationView);
    const result = exporter.export({
      schema: 'IFC4',
      applyMutations: true,
      georefMutations: {
        mapConversion: { eastings: 10, northings: 20, orthogonalHeight: 30, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
      },
    });

    const content = decode(result.content);
    expect(content).not.toContain('#41=');
    expect(content).toMatch(/IFCMAPCONVERSION\(#20,#40,10\.,20\.,30\.,1\.,0\.,1\.\);/);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('writes an unquoted STEP real when setting a MapConversion field that was previously $ (#2724)', () => {
    // OrthogonalHeight, XAxisAbscissa, XAxisOrdinate and Scale are all
    // OPTIONAL in IFC4, so a real file can legally carry `$` there. The
    // named-attribute rewrite path (`serializeNamedAttribute` ->
    // `serializeAttributeValue`) infers REAL-vs-string formatting from the
    // token being replaced; when that token is `$` there is no numeric
    // token to key off, and the fallback must still emit an unquoted STEP
    // real, not a quoted string.
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Project',$,$,$,$,(#20),#30);"],
      [2, 'IFCSIUNIT', '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);'],
      [20, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);"],
      [21, 'IFCAXIS2PLACEMENT3D', '#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);'],
      [22, 'IFCCARTESIANPOINT', '#22=IFCCARTESIANPOINT((0.,0.,0.));'],
      [23, 'IFCDIRECTION', '#23=IFCDIRECTION((0.,0.,1.));'],
      [24, 'IFCDIRECTION', '#24=IFCDIRECTION((1.,0.,0.));'],
      [30, 'IFCUNITASSIGNMENT', '#30=IFCUNITASSIGNMENT((#2));'],
      [40, 'IFCPROJECTEDCRS', "#40=IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+',$,$,$,#2);"],
      // OrthogonalHeight is `$` in the source file — schema-legal, and the
      // exact shape a real project's file has before anyone sets it.
      [41, 'IFCMAPCONVERSION', '#41=IFCMAPCONVERSION(#20,#40,1.,2.,$,1.,0.,1.);'],
    ]);

    const exporter = new StepExporter(dataStore);
    const result = exporter.export({
      schema: 'IFC4',
      applyMutations: true,
      georefMutations: {
        mapConversion: { orthogonalHeight: 12345 },
      },
    });

    const content = decode(result.content);
    const mcLine = content.match(/#41=IFCMAPCONVERSION\([^;]*\);/)?.[0] ?? '';
    // An unquoted STEP real, not `'12345.'` / `'12345'` — IFC4
    // OrthogonalHeight is IfcLengthMeasure, a REAL, not a string.
    expect(mcLine).toBe('#41=IFCMAPCONVERSION(#20,#40,1.,2.,12345.,1.,0.,1.);');
  });

  it('never points new georeferencing at a deleted context or length unit', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Project',$,$,$,$,(#20,#25),#30);"],
      [2, 'IFCSIUNIT', '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);'],
      [20, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);"],
      [21, 'IFCAXIS2PLACEMENT3D', '#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);'],
      [22, 'IFCCARTESIANPOINT', '#22=IFCCARTESIANPOINT((0.,0.,0.));'],
      [23, 'IFCDIRECTION', '#23=IFCDIRECTION((0.,0.,1.));'],
      [24, 'IFCDIRECTION', '#24=IFCDIRECTION((1.,0.,0.));'],
      [25, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#25=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);"],
      [30, 'IFCUNITASSIGNMENT', '#30=IFCUNITASSIGNMENT((#2));'],
    ]);
    const mutationView = new MutablePropertyView(null, 'model-georef');
    mutationView.deleteEntity(20);
    mutationView.deleteEntity(2);

    const exporter = new StepExporter(dataStore, mutationView);
    const result = exporter.export({
      schema: 'IFC4',
      applyMutations: true,
      georefMutations: {
        projectedCRS: { name: 'EPSG:1234', mapUnit: 'METRE' },
        mapConversion: { eastings: 10, northings: 20, orthogonalHeight: 30, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
      },
    });

    const content = decode(result.content);
    // SourceCRS falls through to the surviving context, and the map unit is
    // synthesised rather than reusing the tombstoned #2.
    expect(content).toMatch(/IFCMAPCONVERSION\(#25,#\d+,10\.,20\.,30\.,1\.,0\.,1\.\);/);
    const crsLine = content.match(/#\d+=IFCPROJECTEDCRS\([^;]*\);/)?.[0] ?? '';
    expect(crsLine).toContain("'EPSG:1234'");
    expect(crsLine).not.toContain('#2)');
    const newUnitId = Number(crsLine.match(/#(\d+)\);$/)?.[1]);
    expect(content).toContain(`#${newUnitId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  });
});

/**
 * The corpus and session helpers the two nomination-count blocks below came
 * with, from `delta-modification-count.test.ts` (#2462) and
 * `attribute-nomination-effect.test.ts` (#2483). The two files' base corpora
 * differ — the delta one carries an `IfcMapConversion`, the nomination one an
 * `IfcProjectedCRS` whose `Name` a no-op edit rewrites — so both are kept.
 */
const CRS_ID = 40;
const MAP_CONVERSION_ID = 41;
/** The `Name` the IfcProjectedCRS is already carrying in both corpora. */
const CRS_NAME = 'EPSG:1000';

const DELTA_BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,$,$,.STANDARD.);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('old'),$);
#50=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuQ',$,'Pset_WallCommon',$,(#51));
#51=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#52=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR',$,$,$,(#8),#50);
#40=IFCPROJECTEDCRS('${CRS_NAME}',$,$,$,$,$,$);
#41=IFCMAPCONVERSION($,#40,1000.,2000.,0.,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const NOMINATION_BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,$,$,.STANDARD.);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('old'),$);
#40=IFCPROJECTEDCRS('${CRS_NAME}',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseDeltaBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(DELTA_BASE_IFC)));
}

async function parseNominationBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(NOMINATION_BASE_IFC)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

describe('deltaOnly modification count vs what the delta contains', () => {
  it('a georeferencing edit to an EXISTING IfcProjectedCRS claims nothing either', async () => {
    const store = await parseDeltaBase();
    const { view } = newSession(store);

    // Queued as attribute edits against #40, which only the skipped
    // source-iteration pass would write.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      deltaOnly: true,
      georefMutations: { projectedCRS: { name: 'EPSG:2056' } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings.join('\n')).toContain(`#${CRS_ID}`);
    expect(result.stats.warnings.join('\n')).toContain('georeferencing edits');
  });

  it('a georeferencing edit to an EXISTING IfcMapConversion claims nothing either', async () => {
    const store = await parseDeltaBase();
    const { view } = newSession(store);

    // The map-conversion branch is a SECOND nomination site with the same
    // shape, and nothing pinned it: deleted, a delta claimed a modification for
    // #41 over an empty DATA section again, with the suite green.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      deltaOnly: true,
      georefMutations: { mapConversion: { eastings: 12345, northings: 67890 } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings.join('\n')).toContain(`#${MAP_CONVERSION_ID}`);
    expect(result.stats.warnings.join('\n')).toContain('georeferencing edits');
  });
});

describe('full (non-delta) export is unchanged by the delta fix', () => {
  it('a georeferencing edit to an existing CRS still counts and still lands', async () => {
    const store = await parseDeltaBase();
    const { view } = newSession(store);

    // Every field the modify-existing-CRS branch can set, each a distinct
    // non-interchangeable value so a positional swap would be observable.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: {
        projectedCRS: {
          name: 'EPSG:2056',
          description: 'LV95 Modified',
          geodeticDatum: 'CH1903+',
          verticalDatum: 'LN02',
          mapProjection: 'Swiss Oblique Mercator 1995',
          mapZone: '32N',
        },
      },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(
      `#${CRS_ID}=IFCPROJECTEDCRS('EPSG:2056','LV95 Modified','CH1903+','LN02','Swiss Oblique Mercator 1995','32N',$);`,
    );
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  it('a georeferencing edit to an existing IfcMapConversion still counts and still lands', async () => {
    const store = await parseDeltaBase();
    const { view } = newSession(store);

    // Same shape as the CRS case above, for the sibling modify branch: every
    // settable field, each a distinct value so a transposed pair would fail.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: {
        mapConversion: {
          eastings: 2650000,
          northings: 1250000,
          orthogonalHeight: 555,
          xAxisAbscissa: 0.1,
          xAxisOrdinate: 0.2,
          scale: 0.9999,
        },
      },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(
      `#${MAP_CONVERSION_ID}=IFCMAPCONVERSION($,#${CRS_ID},2650000.,1250000.,555.,0.1,0.2,0.9999);`,
    );
    expect(result.stats.modifiedEntityCount).toBe(1);
  });
});

describe('a georeferencing edit is the same site with the same signal', () => {
  it('writing the Name the IfcProjectedCRS already has claims nothing', async () => {
    // The georef branch queues its fields into the very same
    // `modifiedAttributes` map and its `changed` flag is INTENT — a field was
    // supplied, not a field that differs. Found in the same sweep as #2483's
    // two cases and fixed with them, since it is the same mechanism one site
    // over.
    const store = await parseNominationBase();
    const view = new MutablePropertyView(null, 'test-model');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: { projectedCRS: { name: CRS_NAME } },
    });
    const text = new TextDecoder().decode(result.content);

    const crsLine = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`#${CRS_ID}=`));
    expect(crsLine).toBe(`#${CRS_ID}=IFCPROJECTEDCRS('${CRS_NAME}',$,$,$,$,$,$);`);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('writing a DIFFERENT Name still counts and still lands', async () => {
    const store = await parseNominationBase();
    const view = new MutablePropertyView(null, 'test-model');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: { projectedCRS: { name: 'EPSG:2056' } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(`#${CRS_ID}=IFCPROJECTEDCRS('EPSG:2056'`);
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  it('writing a DIFFERENT Eastings on IfcMapConversion still counts and still lands', async () => {
    // The MapConversion branch queues into the same `modifiedAttributes` map
    // as the CRS branch above and gates its nomination the same way
    // (`hasEmittableHostBytes`) — this is that branch's own sibling case,
    // parallel to the CRS one directly above it. Uses the delta corpus, which
    // is the one of the two that carries an `IfcMapConversion` (#41).
    const store = await parseDeltaBase();
    const view = new MutablePropertyView(null, 'test-model');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: { mapConversion: { eastings: 1500 } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(`#${MAP_CONVERSION_ID}=IFCMAPCONVERSION($,#${CRS_ID},1500.`);
    expect(result.stats.modifiedEntityCount).toBe(1);
  });
});
