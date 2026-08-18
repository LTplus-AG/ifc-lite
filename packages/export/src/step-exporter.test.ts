/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser, EntityExtractor, extractPropertiesOnDemand, asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView as LiveMutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

/** Decode Uint8Array content to string for test assertions */
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * A real `MutablePropertyView` wired to `store`, never a hand-rolled partial.
 * Partial fakes silently stop exercising the exporter the moment it reads a
 * method they don't implement — which is how the overlay-vs-history attribute
 * bug (#1957) could have shipped unnoticed here.
 */
function liveView(store: IfcDataStore): LiveMutablePropertyView {
  const view = new LiveMutablePropertyView(null, 'test-model');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return view;
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
  it('rewrites root attributes on exported STEP entities', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCCOLUMN', "#1=IFCCOLUMN('g',$,'Old Name','Old Description','Old Type',$,$,'OLD-TAG',.COLUMN.);"],
    ]);
    const mutationView = new LiveMutablePropertyView(null, 'model-1');
    mutationView.setAttribute(1, 'Name', 'Updated Name');
    mutationView.setAttribute(1, 'Description', '');
    mutationView.setAttribute(1, 'ObjectType', 'CSV Type');
    mutationView.setAttribute(1, 'Tag', 'CSV-TAG');
    mutationView.setAttribute(1, 'PredefinedType', 'USERDEFINED');

    const exporter = new StepExporter(dataStore, mutationView);
    const result = exporter.export({
      schema: 'IFC4',
      includeGeometry: true,
      includeProperties: true,
      includeQuantities: true,
      includeRelationships: true,
      applyMutations: true,
    });

    expect(decode(result.content)).toContain(
      "#1=IFCCOLUMN('g',$,'Updated Name',$,'CSV Type',$,$,'CSV-TAG',.USERDEFINED.);",
    );
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  it('updates type-owned HasPropertySets instead of creating a duplicate relationship', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(SIMPLE_TYPE_INHERITANCE_IFC).buffer);
    const mutationView = liveView(store);
    mutationView.setProperty(67, 'Pset_WallCommon', 'AcousticRating', 'Edited type value', PropertyValueType.Label);

    const exporter = new StepExporter(store, mutationView);
    const result = exporter.export({ schema: 'IFC4', applyMutations: true });

    expect(decode(result.content)).toContain("IFCLABEL('Edited type value')");
    expect(decode(result.content)).not.toContain("IFCLABEL('This is Pset of the WallType')");
    expect(decode(result.content)).not.toContain("#114=IFCPROPERTYSET('3wkd_mjInDCfOthy7w_A6V'");
    expect(decode(result.content)).not.toMatch(/IFCRELDEFINESBYPROPERTIES\([^;]*\(#67\),#/);
    expect(decode(result.content)).toMatch(/#67=IFCWALLTYPE\([^;]*\(#72,#\d+\)[^;]*\);/);
  });

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
    const mutationView = new LiveMutablePropertyView(null, 'model-georef');
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
    const mutationView = new LiveMutablePropertyView(null, 'model-georef');
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
    const mutationView = new LiveMutablePropertyView(null, 'model-georef');
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

  it('rejects georeferencing edits for IFC2X3 export', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(SIMPLE_TYPE_INHERITANCE_IFC).buffer);
    const exporter = new StepExporter(store);

    expect(() => exporter.export({
      schema: 'IFC2X3',
      applyMutations: true,
      georefMutations: {
        projectedCRS: { name: 'EPSG:2056' },
      },
    })).toThrow(/IFC4 or newer/);
  });

  it('reuses the project length unit when exporting property units', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(SIMPLE_TYPE_INHERITANCE_IFC).buffer);
    const mutationView = liveView(store);
    mutationView.setProperty(74, 'Pset_Custom', 'OffsetDistance', 12.5, PropertyValueType.Real, 'METRE');

    const exporter = new StepExporter(store, mutationView);
    const result = exporter.export({ schema: 'IFC4', applyMutations: true });
    const content = decode(result.content);

    expect(content).not.toContain(',#0);');
    expect(content).toMatch(/#\d+=IFCPROPERTYSINGLEVALUE\('OffsetDistance',\$,IFCREAL\(12\.5\),#\d+\);/);
  });

  it('generates valid IFC GlobalIds for new STEP entities', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(SIMPLE_TYPE_INHERITANCE_IFC).buffer);
    const mutationView = liveView(store);
    mutationView.setProperty(74, 'Pset_GUID_Check', 'Marker', 'ok', PropertyValueType.Label);

    const exporter = new StepExporter(store, mutationView);
    const result = exporter.export({ schema: 'IFC4', applyMutations: true });
    const content = decode(result.content);
    const guids = Array.from(content.matchAll(/IFC(?:PROPERTYSET|RELDEFINESBYPROPERTIES)\('([^']+)'/g)).map((match) => match[1]);

    expect(guids.length).toBeGreaterThan(0);
    for (const guid of guids) {
      expect(isValidIfcGuid(guid)).toBe(true);
    }
  });

  it('emits overlay-created entities at the end of the DATA section', () => {
    const dataStore = buildMockDataStore([
      [10, 'IFCCARTESIANPOINT', '#10=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(10);
    const point = view.createEntity('IFCCARTESIANPOINT', [[1, 2, 3]]);
    view.createEntity('IFCDIRECTION', [[0, 0, 1]]);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(point.expressId).toBe(11);
    expect(content).toContain('#10=IFCCARTESIANPOINT((0.,0.,0.));');
    // Coordinates / DirectionRatios are REAL-backed slots, so whole numbers
    // serialize with a decimal point (#1839) — a bare `(1,2,3)` is a STEP type
    // violation strict validators reject.
    expect(content).toContain('#11=IFCCARTESIANPOINT((1.,2.,3.));');
    expect(content).toContain('#12=IFCDIRECTION((0.,0.,1.));');
    expect(result.stats.newEntityCount).toBe(2);
  });

  it('skips tombstoned entities in the export', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCCARTESIANPOINT', '#1=IFCCARTESIANPOINT((0.,0.,0.));'],
      [2, 'IFCCARTESIANPOINT', '#2=IFCCARTESIANPOINT((1.,1.,1.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).toContain('#1=IFCCARTESIANPOINT((0.,0.,0.));');
    expect(content).not.toContain('#2=IFCCARTESIANPOINT');
  });

  // #1978: editing a pset/qset on an entity and then deleting that entity
  // must not leave an IFCRELDEFINESBYPROPERTIES pointing at a #N with no
  // defining line. The entity-emission loop (step-exporter.ts:~589) already
  // skips the deleted entity itself; the pset/qset generation loops read
  // from the same unfiltered mutation history and did not.
  it('does not emit a dangling IFCRELDEFINESBYPROPERTIES for a deleted entity with a pset edit', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCWALL', "#1=IFCWALL('1ys5Xwuxz8gPJk6N$NGhAG',$,'Wall',$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setProperty(1, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
    view.deleteEntity(1);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).not.toContain('#1=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('does not emit a dangling IFCRELDEFINESBYPROPERTIES for a deleted entity with a quantity edit', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCWALL', "#1=IFCWALL('1ys5Xwuxz8gPJk6N$NGhAG',$,'Wall',$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setQuantity(1, 'Qto_WallBaseQuantities', 'Length', 3, QuantityType.Length);
    view.deleteEntity(1);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).not.toContain('#1=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Greptile P1 on #1967 (effective-changes.ts:361): "deletion hides emitted
  // property sets" — a tombstoned SOURCE entity's pset/qset edits are hidden
  // from `getEffectiveChanges()` (review side) while `StepExporter` (export
  // side) allegedly still emitted an IFCRELDEFINESBYPROPERTIES for them,
  // targeting the now-absent express id. The maintainer called this real but
  // sequencing-dependent on #2030 (`willBeEmitted`) landing first — it has.
  // This test pins the AGREEMENT itself, not just each side in isolation:
  // review must show nothing but the entity-deleted row, and export must
  // emit neither the entity's own line nor a relation referencing it.
  it('review and export agree on a tombstoned source entity with a pset edit (#1967 P1)', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCWALL', "#1=IFCWALL('1ys5Xwuxz8gPJk6N$NGhAG',$,'Wall',$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setProperty(1, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
    view.deleteEntity(1);

    // Review side: only the entity-deleted row survives, the pset edit is hidden.
    expect(view.getEffectiveChanges()).toEqual([{ entityId: 1, kind: 'entity-deleted' }]);

    // Export side: neither the wall's own line nor a relation for it is emitted.
    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).not.toContain('#1=IFCWALL');
    expect(content).not.toContain('IFCRELDEFINESBYPROPERTIES');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Adjacent hole flagged on #1996 by louistrue: `deleteEntity` FORGETS an
  // overlay-created entity (removes it from `newEntities`) rather than
  // tombstoning it, so `isDeleted()` returns false for it and the #1978
  // guards above never fire. A created-then-deleted entity's pset/qset
  // mutations are still in history and must not be emitted either.
  it('does not emit a dangling IFCRELDEFINESBYPROPERTIES for a created-then-deleted entity with a pset edit', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCWALL', "#1=IFCWALL('1ys5Xwuxz8gPJk6N$NGhAG',$,'Wall',$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    const created = view.createEntity('IFCWALL', []);
    view.setProperty(created.expressId, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
    view.deleteEntity(created.expressId);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).not.toContain(`#${created.expressId}=IFCWALL`);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('does not emit a dangling IFCRELDEFINESBYPROPERTIES for a created-then-deleted entity with a quantity edit', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCWALL', "#1=IFCWALL('1ys5Xwuxz8gPJk6N$NGhAG',$,'Wall',$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    const created = view.createEntity('IFCWALL', []);
    view.setQuantity(created.expressId, 'Qto_WallBaseQuantities', 'Length', 3, QuantityType.Length);
    view.deleteEntity(created.expressId);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).not.toContain(`#${created.expressId}=IFCWALL`);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // The third route by which an entity's own line is dropped, after the
  // tombstone and the forgotten create: `visibleOnly` filtering. The entity
  // loop skips anything outside `allowedEntityIds`, so a pset edited on an
  // entity that is then hidden used to emit an IFCRELDEFINESBYPROPERTIES
  // pointing at a line the visibility filter had already removed.
  it('does not emit a dangling IFCRELDEFINESBYPROPERTIES for a hidden entity under visibleOnly', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA2',$,'Wall',$,$,$,$,$);"],
      [3, 'IFCDOOR', "#3=IFCDOOR('1ys5Xwuxz8gPJk6N$NGhA3',$,'Door',$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setProperty(3, 'Pset_DoorCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set([3]),
    });
    const content = decode(result.content);

    expect(content).not.toContain('#3=IFCDOOR');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // #2548: the closure-walk fix that stops a HIDDEN product's pset from
  // riding along on the relationship that named it (see
  // `visible-only-dangling-refs.test.ts`) has to recognise a DELETED subject
  // too, not just a hidden one — `getVisibleEntityIds` never adds a
  // tombstoned entity to `hiddenProductIds` (the effective index's iteration
  // skips it outright, so it is never classified at all), so a naive
  // `hiddenProductIds`-only check would still treat a relationship whose sole
  // subject was DELETED as "surviving filtering" and bridge into its pset.
  it('does not ship a deleted door’s property set under visibleOnly', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [3, 'IFCDOOR', "#3=IFCDOOR('1ys5Xwuxz8gPJk6N$NGhA3',$,'Door',$,$,$,$,$);"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhA0',$,'Pset_Custom',$,(#11));"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('CONFIDENTIAL'),$);"],
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,(#3),#10);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(3);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).not.toContain('#3=IFCDOOR');
    expect(content).not.toContain('CONFIDENTIAL');
    expect(content).not.toContain('IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Maintainer-found defect on this PR (predicate asymmetry): the closure's
  // bridge check treats a referenced id that never existed in the file the
  // same as one that was excluded (`excludeIds.has(id) || !entityIndex.has(id)`
  // in `isBridgeTargetExcluded`), while emission's own predicate
  // (`isExcludedFromRelationshipRefs`) only excludes a HIDDEN product or a
  // TOMBSTONED id — never "never existed". A relationship whose OwnerHistory
  // slot already names a dangling `#999` (a pre-existing corrupt/truncated
  // source, not something this export pass created) therefore blocks the
  // closure from bridging into the SAME relationship's RelatingPropertyDefinition
  // (`#10`), even though that relationship's own line ships unfiltered and
  // still names both. Net effect: a VISIBLE wall silently loses its pset, and
  // the file gains a second dangling ref (`#10`) alongside the pre-existing one
  // (`#999`) that was already there before this export ran.
  it('does not drop a visible element’s pset when another attribute on the same relationship names an id that never existed', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [3, 'IFCWALL', "#3=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA3',$,'Wall',$,$,$,$,$);"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhA0',$,'Pset_Custom',$,(#11));"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('VISIBLE_COST'),$);"],
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('1ys5Xwuxz8gPJk6N$NGh22',#999,$,$,(#3),#10);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('VISIBLE_COST');
    expect(content).toContain('#10=IFCPROPERTYSET');
    // `#999` is a pre-existing dangling ref in the SOURCE file itself (out of
    // scope for this fix — a truncated file / another tool's exporter bug);
    // `#10` must not join it.
    expect(findDanglingRefs(content)).toEqual([999]);
  });

  // Maintainer-found defect on this PR (`refGroupsOf` unions stale values into
  // a BLOCKING predicate): an overlay-created relationship's authored refs are
  // read as the UNION of the creation payload plus every queued override, the
  // same shape `refsOf` uses (safe there because closure GROWTH from a stale
  // entry is harmless). Feeding that union to `relationshipRefsSurviveExclusion`
  // is unsafe: a stale, since-superseded group can still BLOCK bridging even
  // though the override retargeted the relationship at a visible entity.
  it('does not drop a visible element’s pset when an overlay-created relationship is retargeted away from a hidden one', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [9, 'IFCWALL', "#9=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA9',$,'HiddenWall',$,$,$,$,$);"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhAA',$,'Pset_Custom',$,(#11));"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('VISIBLE_COST'),$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(11);
    const rel = view.createEntity('IFCRELDEFINESBYPROPERTIES', [
      '1ys5Xwuxz8gPJk6N$NGh22', null, null, null, ['#9'], '#10',
    ]);
    // Retarget RelatedObjects (attribute index 4) from the hidden wall to the
    // visible one, after creation — the shape #2347 already documents as
    // unsafe for a positional "last two" read; here it is unsafe for the
    // UNIONED refGroupsOf read instead.
    view.setPositionalAttribute(rel.expressId, 4, ['#8']);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set([9]),
    });
    const content = decode(result.content);

    expect(content).not.toContain('#9=IFCWALL');
    expect(content).toContain('VISIBLE_COST');
    expect(content).toContain('#10=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // CodeRabbit finding on #2637: `collectReferencedEntityIds`'s bridge check
  // for a SOURCE-backed `IFCREL*` (one with no `NewEntity` creation payload)
  // parsed the relationship's raw bytes only — never consulting a queued
  // positional/named-attribute mutation the way `refGroupsOf` already did for
  // an OVERLAY-CREATED one. Retargeting `RelatedObjects` from a hidden wall
  // to a visible one via `setPositionalAttribute` on a SOURCE line therefore
  // still judged the bridge by the STALE, pre-mutation reference: emission
  // (which does apply the mutation) writes the visible wall into the output
  // line, but the closure — still seeing the hidden one in its own read —
  // wrongly refused to bridge into the pset, dropping it from the file the
  // emitted relationship line still names.
  it('does not drop a visible element’s pset when a SOURCE-backed relationship is retargeted away from a hidden one', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [9, 'IFCWALL', "#9=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA9',$,'HiddenWall',$,$,$,$,$);"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhAA',$,'Pset_Custom',$,(#11));"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('VISIBLE_COST'),$);"],
      // SOURCE-backed — not created via `view.createEntity` — with
      // RelatedObjects (attribute index 4) still naming the hidden wall in
      // the source bytes.
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,(#9),#10);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    // Retarget RelatedObjects from the hidden wall to the visible one — a
    // positional mutation applied to a SOURCE line, not a creation payload.
    view.setPositionalAttribute(22, 4, ['#8']);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set([9]),
    });
    const content = decode(result.content);

    expect(content).not.toContain('#9=IFCWALL');
    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain('VISIBLE_COST');
    expect(content).toContain('#10=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // CodeRabbit finding on #2637: `refGroupsOf`'s named-attribute resolver
  // used `getAllAttributesForEntity` — the IFC4-pinned registry, empty for an
  // IFC4X3-only relationship class such as `IfcRelAdheresToElement` — so a
  // named override (`setAttribute`) on one resolved no slot and was silently
  // ignored by the CLOSURE, while emission's own resolver
  // (`getAttributeNamesAcrossSchemas`, already cross-schema per
  // `applyOverlayEntityOverrides`'s own comment) applied it. The closure kept
  // judging the relationship by the STALE creation-payload value.
  it('does not drop a target reachable only through an IFC4X3-only relationship class, retargeted by a named attribute edit', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [9, 'IFCWALL', "#9=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA9',$,'HiddenWall',$,$,$,$,$);"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhAA',$,'Pset_Custom',$,(#11));"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('ADHERES_TARGET'),$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(11);
    // IfcRelAdheresToElement: [GlobalId, OwnerHistory, Name, Description,
    // RelatingElement, RelatedSurfaceFeatures] — IFC4X3-only, no IFC4-pinned
    // metadata. RelatingElement starts at the hidden wall.
    const rel = view.createEntity('IFCRELADHERESTOELEMENT', [
      '1ys5Xwuxz8gPJk6N$NGh22', null, null, null, '#9', ['#10'],
    ]);
    // Named-attribute override, not positional — exercises the resolver
    // `refGroupsOf` uses to map the name to a slot.
    view.setAttribute(rel.expressId, 'RelatingElement', '#8');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set([9]),
    });
    const content = decode(result.content);

    expect(content).not.toContain('#9=IFCWALL');
    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain('ADHERES_TARGET');
    expect(content).toContain('#10=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Fifth-layer maintainer finding on #2637 (review comment 5303864666): round
  // 4 gave `refGroupsOf` a `sourceGroups` splice so the closure's BRIDGE
  // DECISION for a SOURCE-backed relationship accounts for a queued mutation
  // — but the refs actually ENQUEUED into the closure still came exclusively
  // from byte-scanning the entity's ORIGINAL bytes. So a mutation that
  // retargets a relationship's single-valued attribute (here
  // `RelatingPropertyDefinition`) onto an entity nothing else in the file
  // names lets the bridge decision through (correctly — the emitted line will
  // name the new target, so the relationship's own line survives) but the
  // retargeted id is never queued for the walk, so its defining line never
  // ships: a dangling ref, structurally invalid IFC, emitted with no error.
  it('does not leave a dangling ref when a SOURCE-backed relationship’s single-valued attribute is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhAA',$,'Pset_Original',$,(#11));"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('ORIGINAL_COST'),$);"],
      // #50/#51: an entirely separate pset, named by NOTHING in the source
      // bytes — reachable only once the mutation below retargets #22 onto it.
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('RETARGETED_COST'),$);"],
      // SOURCE-backed relationship — not created via `view.createEntity` —
      // still naming #10 (RelatingPropertyDefinition, a single-valued
      // attribute) in the source bytes.
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,(#8),#10);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    // Retarget RelatingPropertyDefinition (a single-valued attribute, named
    // by the reviewer's repro) from #10 onto #50 — a named-attribute
    // mutation on a SOURCE line, exactly the reviewer's failing case.
    view.setAttribute(22, 'RelatingPropertyDefinition', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain('RETARGETED_COST');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Same fix, a different `IFCREL*` arity — `relationshipRefGroupsFromSourceLine`
  // / `extractRelationshipRefGroupsIndexed` are generic over STEP argument
  // position, not a per-subtype table, so this is a cheap generality check
  // rather than a new gap: `IfcRelAssociatesMaterial`'s `RelatingMaterial` is
  // a single-valued attribute at a DIFFERENT index than
  // `IfcRelDefinesByProperties`'s `RelatingPropertyDefinition` above.
  it('does not leave a dangling ref when IfcRelAssociatesMaterial’s RelatingMaterial is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [10, 'IFCMATERIAL', "#10=IFCMATERIAL('OriginalMaterial');"],
      // #50: an unreferenced material — reachable only once the mutation
      // below retargets #22's RelatingMaterial onto it.
      [50, 'IFCMATERIAL', "#50=IFCMATERIAL('RetargetedMaterial');"],
      [22, 'IFCRELASSOCIATESMATERIAL', "#22=IFCRELASSOCIATESMATERIAL('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,(#8),#10);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatingMaterial', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain("#50=IFCMATERIAL('RetargetedMaterial')");
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Coverage gap flagged by review on #2637: every retargeting test above
  // exercises an attribute that is either the SECOND positional slot
  // (RelatingPropertyDefinition, RelatingMaterial) or a LIST. `IfcRelVoidsElement`
  // is the one relationship whose two class-specific attributes (indices 4 and
  // 5: RelatingBuildingElement, RelatedOpeningElement) are BOTH single-valued —
  // no list attribute at all — and it is also the one case where the closure
  // fix mattering means dropped GEOMETRY, not a dropped property: an opening's
  // Representation is reachable only by walking through the opening, which is
  // itself only reachable if `IfcRelVoidsElement`'s own line survives and is
  // walked. Retargets the TRAILING (index 5) bare attribute, mirroring the
  // reviewer's exact repro shape one class over.
  it('does not leave a dangling ref when a SOURCE-backed IfcRelVoidsElement’s RelatedOpeningElement is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [20, 'IFCOPENINGELEMENT', "#20=IFCOPENINGELEMENT('1ys5Xwuxz8gPJk6N$NGhB0',$,'OriginalOpening',$,$,$,$,$);"],
      // #50/#51: an entirely separate entity, named by NOTHING in the source
      // bytes — reachable only once the mutation below retargets #22's
      // RelatedOpeningElement onto it.
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Marker',$,IFCTEXT('RETARGETED_VOID_TARGET'),$);"],
      // SOURCE-backed — not created via `view.createEntity` — still naming
      // #20 (RelatedOpeningElement, a single-valued attribute at index 5) in
      // the source bytes.
      [22, 'IFCRELVOIDSELEMENT', "#22=IFCRELVOIDSELEMENT('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,#8,#20);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatedOpeningElement', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain('RETARGETED_VOID_TARGET');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Same gap, `IfcRelAggregates` — the ONE class-specific attribute order this
  // PR's earlier retargeting tests never exercised: RelatingObject is the
  // FIRST (index 4) attribute and RelatedObjects the list SECOND (index 5) —
  // the reverse of `IfcRelContainedInSpatialStructure` (list first, single
  // second) and `IfcRelDefinesByProperties` (same). Retargets the LEADING
  // bare attribute.
  it('does not leave a dangling ref when a SOURCE-backed IfcRelAggregates’ RelatingObject is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCBEAM', "#8=IFCBEAM('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleMember',$,$,$,$,$);"],
      [20, 'IFCELEMENTASSEMBLY', "#20=IFCELEMENTASSEMBLY('1ys5Xwuxz8gPJk6N$NGhB0',$,'OriginalAssembly',$,$,$,$,$);"],
      // #50/#51: an entirely separate entity, named by NOTHING in the source
      // bytes — reachable only once the mutation below retargets #22's
      // RelatingObject (index 4, the LEADING attribute) onto it.
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Marker',$,IFCTEXT('RETARGETED_AGGREGATES_TARGET'),$);"],
      [22, 'IFCRELAGGREGATES', "#22=IFCRELAGGREGATES('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,#20,(#8));"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatingObject', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCBEAM');
    expect(content).toContain('RETARGETED_AGGREGATES_TARGET');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Same gap, `IfcRelNests` — positionally identical to `IfcRelAggregates`
  // (RelatingObject single at 4, RelatedObjects list at 5) but a distinct
  // class, named explicitly on #2637's review. Exercises the LIST attribute
  // instead, via `setPositionalAttribute` rather than a named override.
  it('does not leave a dangling ref when a SOURCE-backed IfcRelNests’ RelatedObjects list is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCPORT', "#8=IFCPORT('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleHost',$,$,$,$,$);"],
      [20, 'IFCPORT', "#20=IFCPORT('1ys5Xwuxz8gPJk6N$NGhB0',$,'OriginalNested',$,$,$,$,$);"],
      // #50/#51: an entirely separate entity, named by NOTHING in the source
      // bytes — reachable only once the mutation below retargets #22's
      // RelatedObjects list onto it.
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Marker',$,IFCTEXT('RETARGETED_NESTS_TARGET'),$);"],
      [22, 'IFCRELNESTS', "#22=IFCRELNESTS('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,#8,(#20));"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setPositionalAttribute(22, 5, ['#50']);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCPORT');
    expect(content).toContain('RETARGETED_NESTS_TARGET');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // IFC2X3 coverage: `IfcRelVoidsElement`, `IfcRelAggregates`, `IfcRelNests`
  // and `IfcRelAssociatesMaterial` all carry IDENTICAL attribute lists in
  // IFC2X3 and IFC4 (verified against the generated schema tables in
  // `@ifc-lite/data`: `entities-ifc2x3.ts` vs `entities-ifc4.ts`), so there is
  // no arity difference for THESE FOUR classes to exercise. What this test
  // instead confirms is that the closure/bridge mechanism — which is purely
  // SYNTACTIC (byte/text parsing of the STEP line, `splitTopLevelArgs`) for a
  // SOURCE-backed relationship, and consults `getAttributeNamesAcrossSchemas`
  // (a version-invariant, IFC4-pinned-then-union resolver) only for a NAMED
  // attribute override — behaves identically when `dataStore.schemaVersion`
  // is `'IFC2X3'` rather than the `'IFC4'` every other test in this file uses.
  it('does not leave a dangling ref for a retargeted IfcRelAggregates on an IFC2X3 source', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCBEAM', "#8=IFCBEAM('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleMember',$,$,$,$,$);"],
      [20, 'IFCELEMENTASSEMBLY', "#20=IFCELEMENTASSEMBLY('1ys5Xwuxz8gPJk6N$NGhB0',$,'OriginalAssembly',$,$,$,$,$);"],
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Marker',$,IFCTEXT('RETARGETED_2X3_TARGET'),$);"],
      [22, 'IFCRELAGGREGATES', "#22=IFCRELAGGREGATES('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,#20,(#8));"],
    ]);
    (dataStore as unknown as { schemaVersion: string }).schemaVersion = 'IFC2X3';
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatingObject', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC2X3',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCBEAM');
    expect(content).toContain('RETARGETED_2X3_TARGET');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Coverage gap flagged on #2637 round 6: `IfcRelAssociatesClassification`
  // had no retargeting test at all. Retargets its trailing single-valued
  // attribute, `RelatingClassification` (index 5) — same shape the
  // `IfcRelAssociatesMaterial` test above already covers positionally, but a
  // distinct class, and the closure/bridge mechanism is generic over class,
  // not a per-subtype table, so this is a cheap generality check.
  it('does not leave a dangling ref when IfcRelAssociatesClassification’s RelatingClassification is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [10, 'IFCCLASSIFICATION', "#10=IFCCLASSIFICATION($,$,$,'OriginalSource');"],
      // #50/#51: an entirely separate classification reference, named by
      // NOTHING in the source bytes — reachable only once the mutation below
      // retargets #22's RelatingClassification onto it.
      [50, 'IFCCLASSIFICATIONREFERENCE', "#50=IFCCLASSIFICATIONREFERENCE($,'RET.001','RetargetedClassRef',$,$,$);"],
      [22, 'IFCRELASSOCIATESCLASSIFICATION', "#22=IFCRELASSOCIATESCLASSIFICATION('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,(#8),#10);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatingClassification', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain("#50=IFCCLASSIFICATIONREFERENCE($,'RET.001'");
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Coverage gap flagged on #2637 round 6: `IfcRelDefinesByType` had a
  // dangling-refs test for a HIDDEN member (`visible-only-dangling-refs.test.ts`)
  // but no retargeting test. Retargets `RelatingType` (index 5, trailing
  // single-valued), the same position `IfcRelDefinesByProperties`'s
  // `RelatingPropertyDefinition` test above exercises, one class over.
  it('does not leave a dangling ref when IfcRelDefinesByType’s RelatingType is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [10, 'IFCWALLTYPE', "#10=IFCWALLTYPE('1ys5Xwuxz8gPJk6N$NGhAA',$,'OriginalType',$,$,$,$,$,$,.STANDARD.);"],
      // #50: an entirely separate type, named by NOTHING in the source bytes —
      // reachable only once the mutation below retargets #22's RelatingType.
      [50, 'IFCWALLTYPE', "#50=IFCWALLTYPE('1ys5Xwuxz8gPJk6N$NGhBB',$,'RetargetedType',$,$,$,$,$,$,.STANDARD.);"],
      [22, 'IFCRELDEFINESBYTYPE', "#22=IFCRELDEFINESBYTYPE('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,(#8),#10);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatingType', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain("#50=IFCWALLTYPE('1ys5Xwuxz8gPJk6N$NGhBB',$,'RetargetedType'");
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Coverage gap flagged on #2637 round 6: `IfcRelSpaceBoundary` had a
  // hidden-member test (`visible-only-dangling-refs.test.ts`) but no
  // retargeting test. Like `IfcRelVoidsElement`, EVERY class-specific
  // attribute is single-valued — no list at all — but unlike it, the pair is
  // (RelatingSpace, RelatedBuildingElement) at indices 4/5 with THREE more
  // trailing attributes (ConnectionGeometry, PhysicalOrVirtualBoundary,
  // InternalOrExternalBoundary). Retargets the LEADING bare attribute
  // (RelatingSpace, index 4) — the position the `IfcRelVoidsElement` test
  // above did not exercise (it retargeted the TRAILING one). The retarget
  // target is an `IfcPropertySet` chain, not another `IfcSpace` — `IFCSPACE`
  // is itself a `PRODUCT_TYPES` member, so it would become a root on its own
  // regardless of this relationship's bridging and the test would pass
  // vacuously (caught by the non-vacuity check: an early draft using
  // `IFCSPACE` as the target stayed GREEN even with `reference-collector.ts`
  // reverted to before the closure fix existed).
  it('does not leave a dangling ref when IfcRelSpaceBoundary’s RelatingSpace is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleWall',$,$,$,$,$);"],
      [20, 'IFCSPACE', "#20=IFCSPACE('1ys5Xwuxz8gPJk6N$NGhB0',$,'OriginalSpace',$,$,$,$,$,$,$);"],
      // #50/#51: an entirely separate pset, named by NOTHING in the source
      // bytes — reachable only once the mutation below retargets #22's
      // RelatingSpace onto it. Not itself a `PRODUCT_TYPES` member, so it
      // only ships if the relationship actually bridges into it.
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Marker',$,IFCTEXT('RETARGETED_SPACEBOUNDARY_TARGET'),$);"],
      [22, 'IFCRELSPACEBOUNDARY', "#22=IFCRELSPACEBOUNDARY('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,#20,#8,$,.PHYSICAL.,.EXTERNAL.);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatingSpace', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain('RETARGETED_SPACEBOUNDARY_TARGET');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Coverage gap flagged on #2637 round 6: `IfcRelContainedInSpatialStructure`
  // is exercised extensively for hidden-member filtering
  // (`visible-only-dangling-refs.test.ts`) but never for a RETARGET. Its
  // shape is `RelatedElements` (list, index 4) then `RelatingStructure`
  // (single, index 5) — the SAME order `IfcRelDefinesByProperties` uses, but
  // exercised here via `setPositionalAttribute` on the LIST rather than a
  // named override on the single attribute. The retarget target is an
  // `IfcPropertySet` chain, not another `IfcWall` — `IFCWALL` is itself a
  // `PRODUCT_TYPES` member, so it would become a root on its own regardless
  // of this relationship's bridging (same non-vacuity trap the
  // `IfcRelSpaceBoundary` test above notes: an early draft using `IFCWALL`
  // as the target stayed GREEN even with the closure fix reverted).
  it('does not leave a dangling ref when a SOURCE-backed IfcRelContainedInSpatialStructure’s RelatedElements list is retargeted onto an otherwise-unreferenced entity', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCBUILDINGSTOREY', "#2=IFCBUILDINGSTOREY('1ys5Xwuxz8gPJk6N$NGhA2',$,'Storey',$,$,$,$,$,$,0.);"],
      [8, 'IFCWALL', "#8=IFCWALL('1ys5Xwuxz8gPJk6N$NGhA8',$,'OriginalMember',$,$,$,$,$);"],
      // #50/#51: an entirely separate pset, named by NOTHING in the source
      // bytes — reachable only once the mutation below retargets #22's
      // RelatedElements list onto it. Not itself a `PRODUCT_TYPES` member, so
      // it only ships if the relationship actually bridges into it.
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Marker',$,IFCTEXT('RETARGETED_CONTAINMENT_TARGET'),$);"],
      [22, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', "#22=IFCRELCONTAINEDINSPATIALSTRUCTURE('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,(#8),#2);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setPositionalAttribute(22, 4, ['#50']);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#2=IFCBUILDINGSTOREY');
    expect(content).toContain('RETARGETED_CONTAINMENT_TARGET');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // A GENUINE IFC2X3 arity difference — verified against the generated
  // schema tables in `@ifc-lite/data`: `entities-ifc4.ts` gives
  // `IfcRelSequence` NINE attributes (GlobalId, OwnerHistory, Name,
  // Description, RelatingProcess, RelatedProcess, TimeLag, SequenceType,
  // UserDefinedSequenceType); `entities-ifc2x3.ts` gives it EIGHT — IFC4 adds
  // the trailing `UserDefinedSequenceType`. (The earlier IFC2X3 test above
  // used `IfcRelAggregates`, whose attribute list is IDENTICAL between
  // schemas — see that test's own comment — so it pinned parity, not an
  // arity difference. A repo-wide diff of every `IFCREL*` class shared by
  // both `entities-ifc*.ts` tables found exactly one other non-abstract
  // divergence, `IfcRelCoversSpaces`, and that is a same-arity attribute
  // RENAME [RelatingSpace ↔ RelatedSpace], not a count difference.
  // `IfcRelDecomposes`/`IfcRelDefines` also differ, but both are abstract
  // EXPRESS supertypes never instantiated on their own — IFC4 simply moved
  // their shared attributes down into concrete subtypes, which stayed
  // identical, as already confirmed.) `RelatingProcess`/`RelatedProcess` sit
  // at the SAME indices (4/5) in both schemas — the shorter arity is a
  // TRAILING difference — so this exercises the same retarget shape as the
  // IFC4 tests above, just on the schema that genuinely has fewer attributes
  // to parse `splitTopLevelArgs` over.
  it('does not leave a dangling ref for a retargeted IfcRelSequence on an IFC2X3 source (a genuine arity difference)', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
      [8, 'IFCTASK', "#8=IFCTASK('1ys5Xwuxz8gPJk6N$NGhA8',$,'VisibleTask',$,$,$,$,$,.NOTDEFINED.);"],
      [20, 'IFCTASK', "#20=IFCTASK('1ys5Xwuxz8gPJk6N$NGhB0',$,'OriginalPredecessor',$,$,$,$,$,.NOTDEFINED.);"],
      [50, 'IFCPROPERTYSET', "#50=IFCPROPERTYSET('1ys5Xwuxz8gPJk6N$NGhBB',$,'Pset_Retargeted',$,(#51));"],
      [51, 'IFCPROPERTYSINGLEVALUE', "#51=IFCPROPERTYSINGLEVALUE('Marker',$,IFCTEXT('RETARGETED_SEQ_2X3_TARGET'),$);"],
      // IFC2X3 IfcRelSequence: [GlobalId, OwnerHistory, Name, Description,
      // RelatingProcess, RelatedProcess, TimeLag, SequenceType] — 8 attrs,
      // no trailing UserDefinedSequenceType.
      [22, 'IFCRELSEQUENCE', "#22=IFCRELSEQUENCE('1ys5Xwuxz8gPJk6N$NGh22',$,$,$,#20,#8,$,$);"],
    ]);
    (dataStore as unknown as { schemaVersion: string }).schemaVersion = 'IFC2X3';
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setAttribute(22, 'RelatingProcess', '#50');

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC2X3',
      applyMutations: true,
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const content = decode(result.content);

    expect(content).toContain('#8=IFCTASK');
    expect(content).toContain('RETARGETED_SEQ_2X3_TARGET');
    expect(content).toContain('#50=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('applies positional attribute mutations to non-IfcRoot entities', () => {
    const dataStore = buildMockDataStore([
      [35, 'IFCRECTANGLEPROFILEDEF', '#35=IFCRECTANGLEPROFILEDEF(.AREA.,$,#34,0.3,0.4);'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setPositionalAttribute(35, 3, 0.6);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).toContain('#35=IFCRECTANGLEPROFILEDEF(.AREA.,$,#34,0.6,0.4);');
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  // Regression #1839: a WHOLE number written into a REAL-backed positional slot
  // (IfcRectangleProfileDef.XDim : IfcPositiveLengthMeasure) must serialize with
  // a decimal point. Previously it came out as a bare INTEGER (`...,1,0.4`) and
  // strict validators (ifcopenshell.validate) rejected the file.
  it('serializes an integral edit of a REAL-typed positional slot as a STEP REAL', () => {
    const dataStore = buildMockDataStore([
      [35, 'IFCRECTANGLEPROFILEDEF', '#35=IFCRECTANGLEPROFILEDEF(.AREA.,$,#34,0.4,0.4);'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setPositionalAttribute(35, 3, 1); // XDim := 1.0

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).toContain('#35=IFCRECTANGLEPROFILEDEF(.AREA.,$,#34,1.,0.4);');
    expect(content).not.toContain('#34,1,0.4');
  });

  // Regression #1839: the in-store builders emit their own geometry as overlay
  // entities with whole-number lengths (millimetre models are the common case).
  // Every REAL-backed slot on a freshly-added entity must carry a decimal point.
  it('forces REAL literals on whole-number lengths of overlay-created geometry', () => {
    const dataStore = buildMockDataStore([
      [10, 'IFCCARTESIANPOINT', '#10=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(10);
    // #11 profile: XDim/YDim are REAL; #12 extruded solid: Depth (index 3) is REAL.
    view.createEntity('IFCRECTANGLEPROFILEDEF', ['.AREA.', null, '#34', 400, 400]);
    view.createEntity('IFCEXTRUDEDAREASOLID', ['#11', '#20', '#21', 3000]);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).toContain('#11=IFCRECTANGLEPROFILEDEF(.AREA.,$,#34,400.,400.);');
    expect(content).toContain('#12=IFCEXTRUDEDAREASOLID(#11,#20,#21,3000.);');
  });

  // Regression #1839 (Codex review): IFC4X3-only entities are absent from the
  // parser's IFC4-pinned registry, so positional names must resolve across the
  // schema union — otherwise alignment/civil REAL slots (StartDirection,
  // SegmentLength, …) fall back to bare INTEGER literals.
  it('forces REAL literals on IFC4X3-only entity slots (alignment geometry)', () => {
    const dataStore = buildMockDataStore([
      [5, 'IFCCARTESIANPOINT', '#5=IFCCARTESIANPOINT((0.,0.));'],
    ]);
    (dataStore as unknown as { schemaVersion: string }).schemaVersion = 'IFC4X3';
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(5);
    // StartTag, EndTag, StartPoint, StartDirection, StartRadiusOfCurvature,
    // EndRadiusOfCurvature, SegmentLength, GravityCenterLineHeight, PredefinedType
    view.createEntity('IFCALIGNMENTHORIZONTALSEGMENT', [
      null, null, '#5', 0, 0, 0, 5000, 0, '.LINE.',
    ]);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4X3',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).toContain(
      '#6=IFCALIGNMENTHORIZONTALSEGMENT($,$,#5,0.,0.,0.,5000.,0.,.LINE.);',
    );
  });

  // Guard against over-forcing: an INTEGER-typed slot keeps its integer form.
  // IfcQuantityCount.CountValue is a pure IfcCountMeasure (xs:integer), so a
  // whole-number value must NOT gain a decimal point. Uses the new-entity path
  // (no source token) so only the schema signal is in play.
  it('leaves integer-typed slots as INTEGER literals', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCCARTESIANPOINT', '#1=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    // Name, Description, Unit, CountValue (integer), Formula
    view.createEntity('IFCQUANTITYCOUNT', ['n', null, null, 5, null]);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).toContain("#2=IFCQUANTITYCOUNT('n',$,$,5,$);");
    expect(content).not.toContain('5.');
  });

  // #1839 follow-up: SELECT-typed slots must type-qualify a defined-type member.
  // IfcBoundaryNodeCondition.TranslationalStiffnessX : SELECT(IfcBoolean,
  // IfcLinearStiffnessMeasure). A bare `.T.` is non-conformant (strict validators
  // reject it; ifc-lite's own reader loses the member type).
  it('auto-qualifies a boolean written into a SELECT slot (positional edit)', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCBOUNDARYNODECONDITION', "#1=IFCBOUNDARYNODECONDITION('bc',IFCLINEARSTIFFNESSMEASURE(1000.),$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setPositionalAttribute(1, 1, true); // TranslationalStiffnessX := true

    const content = decode(new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true }).content);
    expect(content).toContain("#1=IFCBOUNDARYNODECONDITION('bc',IFCBOOLEAN(.T.),$,$,$,$,$);");
    expect(content).not.toMatch(/,\.T\.,/); // never a bare .T. in the slot
  });

  it('auto-qualifies boolean and number SELECT members on overlay-created entities', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCCARTESIANPOINT', '#1=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    // Name, TranslationalStiffnessX(bool), TranslationalStiffnessY(number), Z, Rot X/Y/Z
    view.createEntity('IFCBOUNDARYNODECONDITION', ['bc', true, 2000, null, null, null, null]);

    const content = decode(new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true }).content);
    // boolean -> IFCBOOLEAN(.T.); number -> the sole REAL member IfcLinearStiffnessMeasure
    expect(content).toContain("#2=IFCBOUNDARYNODECONDITION('bc',IFCBOOLEAN(.T.),IFCLINEARSTIFFNESSMEASURE(2000.),$,$,$,$);");
  });

  // The emitted qualified token round-trips: ifc-lite's parser reads it back with
  // the member type preserved (a bare `.T.` would parse as the untyped string).
  it('emits SELECT qualification that the parser reads back with its type', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCBOUNDARYNODECONDITION', "#1=IFCBOUNDARYNODECONDITION('bc',$,$,$,$,$,$);"],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setPositionalAttribute(1, 1, true);
    const content = decode(new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true }).content);
    const line = content.split(/\r?\n/).find(l => l.includes('IFCBOUNDARYNODECONDITION'))!;

    const bytes = new TextEncoder().encode(line);
    const extractor = new EntityExtractor(bytes);
    const entity = extractor.extractEntity({
      expressId: 1, type: 'IFCBOUNDARYNODECONDITION', byteOffset: 0, byteLength: bytes.length, lineNumber: 0,
    })!;
    // Typed value round-trips as [typeName, innerValue] — the member type survives.
    expect(entity.attributes[1]).toEqual(['IFCBOOLEAN', '.T.']);
  });

  // The { typed } marker is the escape hatch for ambiguous SELECTs / the IfcValue
  // family, where a bare value can't disambiguate the member. NominalValue is
  // IfcValue (100+ REAL members) so a number does NOT auto-qualify.
  it('honours the { typed } marker and leaves ambiguous selects to it', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCCARTESIANPOINT', '#1=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    // Name(IfcIdentifier), Description, NominalValue(IfcValue, ambiguous), Unit
    view.createEntity('IFCPROPERTYSINGLEVALUE', [
      'P', null, { typed: { type: 'IfcLengthMeasure', value: 3 } }, null,
    ]);
    // A bare number in the same ambiguous slot stays bare (needs the marker).
    view.createEntity('IFCPROPERTYSINGLEVALUE', ['Q', null, 5, null]);

    const content = decode(new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true }).content);
    expect(content).toContain("#2=IFCPROPERTYSINGLEVALUE('P',$,IFCLENGTHMEASURE(3.),$);");
    expect(content).toContain("#3=IFCPROPERTYSINGLEVALUE('Q',$,5,$);");
  });

  // Regression: the deltaOnly early-return previously fired before the
  // overlay-entities pass, so `createEntity()`-only edits were silently
  // dropped from delta exports.
  it('emits overlay-created entities under deltaOnly when no other modifications exist', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCCARTESIANPOINT', '#1=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    view.createEntity('IFCDIRECTION', [[1, 0, 0]]);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
      deltaOnly: true,
    });
    const content = decode(result.content);

    expect(content).toContain('#2=IFCDIRECTION((1.,0.,0.));');
    expect(content).not.toContain('#1=IFCCARTESIANPOINT');
    expect(result.stats.newEntityCount).toBe(1);
  });

  it('honours applyMutations: false for overlay state', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCCARTESIANPOINT', '#1=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    view.createEntity('IFCDIRECTION', [[1, 0, 0]]);
    view.deleteEntity(1);
    view.setPositionalAttribute(1, 0, [9, 9, 9]);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: false,
    });
    const content = decode(result.content);

    expect(content).toContain('#1=IFCCARTESIANPOINT((0.,0.,0.));');
    expect(content).not.toContain('IFCDIRECTION');
    expect(result.stats.newEntityCount).toBe(0);
  });

  it('exports from a SharedArrayBuffer-backed source without TextDecoder/SAB error', async () => {
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('skip: SharedArrayBuffer unavailable in this runtime');
      return;
    }
    // Copy the fixture bytes into a SAB so the parser produces a
    // dataStore.source that is SAB-backed — the same shape the in-browser
    // parser worker hands the main thread. Firefox (and Chrome with the
    // SAB-decode mitigation enabled) rejects `TextDecoder.decode()` on
    // SAB-backed views, which used to break STEP export with:
    //   "TextDecoder.decode: ArrayBufferView branch ... can't be a
    //    SharedArrayBuffer or an ArrayBufferView backed by a
    //    SharedArrayBuffer"
    const encoded = new TextEncoder().encode(SIMPLE_TYPE_INHERITANCE_IFC);
    const sab = new SharedArrayBuffer(encoded.byteLength);
    new Uint8Array(sab).set(encoded);

    const parser = new IfcParser();
    const store = await parser.parseColumnar(sab as unknown as ArrayBuffer, {
      disableWorkerScan: true,
    });

    // Apply a positional override so we also exercise the mutation paths
    // that decode source subarrays via the helper methods.
    const view = new LiveMutablePropertyView(null, 'sab-model');
    view.setAttribute(74, 'Name', 'SAB-Safe Wall');

    const exporter = new StepExporter(store, view);
    const result = exporter.export({ schema: 'IFC4', applyMutations: true });

    const content = decode(result.content);
    expect(content).toContain('IFCWALL');
    expect(content).toContain("'SAB-Safe Wall'");
    expect(result.stats.entityCount).toBeGreaterThan(0);
  });

  // Regression: github.com/LTplus-AG/ifc-lite/issues/1110
  // The parser can defer property atoms (IfcPropertySingleValue, IfcQuantity*)
  // out of byId on huge files. The exporter must still emit them, or the kept
  // IfcPropertySet/IfcElementQuantity containers reference dropped entities.
  it('emits deferred property atoms so the output has no dangling refs', () => {
    const store = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'W',$,$,$,$,$);"],
      [3, 'IFCPROPERTYSET', "#3=IFCPROPERTYSET('g3',$,'Pset_Wall',$,(#5));"],
      [4, 'IFCELEMENTQUANTITY', "#4=IFCELEMENTQUANTITY('g4',$,'Qto',$,$,(#6));"],
      [5, 'IFCPROPERTYSINGLEVALUE', "#5=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);"],
      [6, 'IFCQUANTITYLENGTH', "#6=IFCQUANTITYLENGTH('Length',$,$,2500.,$);"],
      [7, 'IFCRELDEFINESBYPROPERTIES', "#7=IFCRELDEFINESBYPROPERTIES('g7',$,$,$,(#2),#3);"],
    ], new Set([5, 6]));

    const exporter = new StepExporter(store);
    const result = exporter.export({ schema: 'IFC4' });
    const content = decode(result.content);

    expect(content).toContain("#5=IFCPROPERTYSINGLEVALUE('IsExternal'");
    expect(content).toContain("#6=IFCQUANTITYLENGTH('Length'");
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // Coverage gap: no test drove `export()` with a source schema genuinely
  // different from the target `schema` option, so `converting` (schema-converter.ts
  // `needsConversion`) was always false and both `if (converting)` branches below
  // were dead code — confirmed by mutation testing (`if (false && converting)`
  // in either branch alone: 708/708 tests still pass). `schema-converter.test.ts`
  // only unit-tests `convertStepLine` directly, never through the exporter.
  //
  // This pins the SOURCE-ITERATION branch (~line 1225): a source-backed entity
  // whose type is renamed between IFC2X3 and IFC4 (`IFC2X3_TO_IFC4` map in
  // schema-converter.ts) must come out under its IFC4 name, not pass through
  // unconverted under its IFC2X3 name.
  it('converts a source-backed entity type when exporting to a different schema (IFC2X3 -> IFC4)', () => {
    const dataStore = buildMockDataStore([
      [5, 'IFCELECTRICDISTRIBUTIONPOINT', "#5=IFCELECTRICDISTRIBUTIONPOINT('1ys5Xwuxz8gPJk6N$NGhA5',$,'Panel',$,$,$,$,$);"],
    ]);
    (dataStore as unknown as { schemaVersion: string }).schemaVersion = 'IFC2X3';

    const result = new StepExporter(dataStore).export({ schema: 'IFC4' });
    const content = decode(result.content);

    expect(content).toContain('#5=IFCELECTRICDISTRIBUTIONBOARD(');
    expect(content).not.toContain('IFCELECTRICDISTRIBUTIONPOINT');
  });

  // Same coverage gap, but for the OVERLAY pass (~line 1511): an entity
  // created via `mutationView.createEntity` — never source-backed — of a
  // class that needs conversion must ALSO have its rendered `argsText`
  // (here just the entity-type token) run through `convertStepLine`,
  // independently of the source-iteration pass above.
  it('converts an overlay-created entity type when exporting to a different schema (IFC2X3 -> IFC4)', () => {
    const dataStore = buildMockDataStore([
      [1, 'IFCPROJECT', "#1=IFCPROJECT('1ys5Xwuxz8gPJk6N$NGhA1',$,'P',$,$,$,$,$,$);"],
    ]);
    (dataStore as unknown as { schemaVersion: string }).schemaVersion = 'IFC2X3';
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    const created = view.createEntity('IFCELECTRICDISTRIBUTIONPOINT', []);

    const result = new StepExporter(dataStore, view).export({
      schema: 'IFC4',
      applyMutations: true,
    });
    const content = decode(result.content);

    expect(content).toContain(`#${created.expressId}=IFCELECTRICDISTRIBUTIONBOARD(`);
    expect(content).not.toContain('IFCELECTRICDISTRIBUTIONPOINT');
  });
});
