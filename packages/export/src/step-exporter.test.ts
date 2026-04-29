/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, Mutation } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView as LiveMutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

/** Decode Uint8Array content to string for test assertions */
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function buildMockDataStore(entries: Array<[number, string, string]>): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    byId.set(id, { expressId: id, type: type.toUpperCase(), byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(type.toUpperCase())) {
      byType.set(type.toUpperCase(), []);
    }
    byType.get(type.toUpperCase())!.push(id);
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
    source,
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
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
    const mutations: Mutation[] = [{
      id: 'mut_1',
      type: 'UPDATE_PROPERTY',
      timestamp: Date.now(),
      modelId: 'test-model',
      entityId: 67,
      psetName: 'Pset_WallCommon',
      propName: 'AcousticRating',
      oldValue: 'This is Pset of the WallType',
      newValue: 'Edited type value',
      valueType: PropertyValueType.Label,
    }];

    const mutationView = {
      getMutations: () => mutations,
      getForEntity: (entityId: number) => entityId === 67 ? [{
        name: 'Pset_WallCommon',
        globalId: '3wkd_mjInDCfOthy7w_A6V',
        properties: [{
          name: 'AcousticRating',
          type: PropertyValueType.Label,
          value: 'Edited type value',
        }],
      }] : [],
      getQuantitiesForEntity: () => [],
    } as unknown as MutablePropertyView;

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
    const mutations: Mutation[] = [{
      id: 'mut_unit_1',
      type: 'CREATE_PROPERTY',
      timestamp: Date.now(),
      modelId: 'test-model',
      entityId: 74,
      psetName: 'Pset_Custom',
      propName: 'OffsetDistance',
      newValue: 12.5,
      valueType: PropertyValueType.Real,
    }];

    const mutationView = {
      getMutations: () => mutations,
      getForEntity: (entityId: number) => entityId === 74 ? [{
        name: 'Pset_Custom',
        globalId: 'test-pset',
        properties: [{
          name: 'OffsetDistance',
          type: PropertyValueType.Real,
          value: 12.5,
          unit: 'METRE',
        }],
      }] : [],
      getQuantitiesForEntity: () => [],
    } as unknown as MutablePropertyView;

    const exporter = new StepExporter(store, mutationView);
    const result = exporter.export({ schema: 'IFC4', applyMutations: true });
    const content = decode(result.content);

    expect(content).not.toContain(',#0);');
    expect(content).toMatch(/#\d+=IFCPROPERTYSINGLEVALUE\('OffsetDistance',\$,IFCREAL\(12\.5\),#\d+\);/);
  });

  it('generates valid IFC GlobalIds for new STEP entities', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(SIMPLE_TYPE_INHERITANCE_IFC).buffer);
    const mutations: Mutation[] = [{
      id: 'mut_guid_1',
      type: 'CREATE_PROPERTY',
      timestamp: Date.now(),
      modelId: 'test-model',
      entityId: 74,
      psetName: 'Pset_GUID_Check',
      propName: 'Marker',
      newValue: 'ok',
      valueType: PropertyValueType.Label,
    }];

    const mutationView = {
      getMutations: () => mutations,
      getForEntity: (entityId: number) => entityId === 74 ? [{
        name: 'Pset_GUID_Check',
        globalId: '',
        properties: [{
          name: 'Marker',
          type: PropertyValueType.Label,
          value: 'ok',
        }],
      }] : [],
      getQuantitiesForEntity: () => [],
    } as unknown as MutablePropertyView;

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
    expect(content).toContain('#11=IFCCARTESIANPOINT((1,2,3));');
    expect(content).toContain('#12=IFCDIRECTION((0,0,1));');
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
});
