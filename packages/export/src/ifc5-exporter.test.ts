/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView as LiveMutablePropertyView } from '@ifc-lite/mutations';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  RelationshipGraphBuilder,
  QuantityTableBuilder,
  PropertyValueType,
} from '@ifc-lite/data';
import {
  ALL_OFFICIAL_SCHEMAS,
  IFC_PROP_SCHEMAS,
  STANDARD_IMPORT_URIS,
  validateIfcxFile,
  validateValue,
} from './__fixtures__/ifc5-official-schemas.js';

// ============================================================================
// Reference file helpers
// ============================================================================

const MODELS_DIR = resolve(__dirname, '../../../tests/models/ifc5');

// Fixtures are fetched on demand via `pnpm fixtures` (AGENTS.md §9). Cross-
// validation tests that load reference IFCx files skip cleanly when the
// fixtures aren't on disk so a fresh checkout doesn't crash with ENOENT.
const FIXTURES = {
  helloWall: 'Hello_Wall_hello-wall.ifcx',
  accaBuilding: 'ACCA_Building_esempio_01_edificius.ifcx',
  ifcHero: 'IFC_Hero_Model_IFC_Hero_Model.ifcx',
} as const;
const FIXTURES_AVAILABLE = Object.values(FIXTURES).every((name) =>
  existsSync(resolve(MODELS_DIR, name)),
);

function loadReferenceFile(filename: string): any {
  return JSON.parse(readFileSync(resolve(MODELS_DIR, filename), 'utf-8'));
}

// ============================================================================
// Test data builder
// ============================================================================

function buildMinimalDataStore(
  entities: Array<{
    expressId: number;
    type: string;
    globalId?: string;
    name?: string;
    description?: string;
  }>,
): IfcDataStore {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(entities.length, strings);
  for (const e of entities) {
    entityBuilder.add(e.expressId, e.type, e.globalId ?? '', e.name ?? '', e.description ?? '', '');
  }
  const propertyBuilder = new PropertyTableBuilder(strings);
  const relBuilder = new RelationshipGraphBuilder();
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: entities.length,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    strings,
    entities: entityBuilder.build(),
    properties: propertyBuilder.build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: relBuilder.build(),
  } as unknown as IfcDataStore;
}

/**
 * Path of the synthetic document-root node the exporter unshifts onto
 * `file.data` — `generateUuid(0)`, which is module-private in the exporter.
 */
const DOCUMENT_ROOT_PATH = '00000000-0000-4000-8000-000000000000';

interface IfcxNodeLike {
  path: string;
  children?: Record<string, string | null>;
  attributes?: Record<string, unknown>;
}

/**
 * Walk the exported document from its root node and collect every path that
 * is actually reachable via `children`.
 *
 * Membership in `file.data` is NOT reachability: a node can be emitted and
 * still have nothing anywhere list it as a child, which is precisely the
 * failure #2047 is about. Every reachability assertion goes through here so
 * it cannot pass on mere presence.
 */
function reachablePaths(file: { data: IfcxNodeLike[] }): Set<string> {
  const byPath = new Map(file.data.map((n) => [n.path, n]));
  const reached = new Set<string>();
  const queue: string[] = byPath.has(DOCUMENT_ROOT_PATH) ? [DOCUMENT_ROOT_PATH] : [];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (reached.has(path)) continue;
    reached.add(path);
    for (const child of Object.values(byPath.get(path)?.children ?? {})) {
      if (child) queue.push(child);
    }
  }
  return reached;
}

function makeMockMeshes(expressId: number) {
  return [{
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.8, 0.6, 0.4, 0.9] as [number, number, number, number],
  }];
}

// ============================================================================
// Official schema validation tests
// ============================================================================

describe('Ifc5Exporter', () => {
  describe('official schema validation', () => {
    it('export with geometry + properties produces zero validation errors against official schemas', () => {
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(1, strings);
      entityBuilder.add(1, 'IFCWALL', 'abc-123', 'TestWall', 'A test wall', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      propertyBuilder.add({
        entityId: 1,
        psetName: 'Pset_WallCommon',
        psetGlobalId: '',
        propName: 'IsExternal',
        value: true,
        propType: PropertyValueType.Boolean,
      });

      const relBuilder = new RelationshipGraphBuilder();
      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 1, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
      } as unknown as IfcDataStore;

      const meshes = makeMockMeshes(1);
      const exporter = new Ifc5Exporter(dataStore, { meshes } as any);
      const result = exporter.export({ onlyTreeEntities: false });
      const file = JSON.parse(result.content);

      const errors = validateIfcxFile(file);
      expect(errors).toEqual([]);
    });

    it('IFC4 properties without IFC5 schema are NOT exported (avoids "Missing schema" viewer error)', () => {
      // Simulates the exact user scenario: Revit IFC4 file with Pset_WallCommon
      // containing properties like Reference, LoadBearing, ExtendToStructure
      // which have NO matching schema in prop@v5a.ifcx
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(2, strings);
      entityBuilder.add(1, 'IFCWALL', 'wall-1', 'TestWall', '', '');
      entityBuilder.add(2, 'IFCBUILDING', 'bldg-1', 'TestBuilding', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      // IsExternal IS in the official prop schema → should be exported
      propertyBuilder.add({
        entityId: 1, psetName: 'Pset_WallCommon', psetGlobalId: '',
        propName: 'IsExternal', value: true, propType: PropertyValueType.Boolean,
      });
      // Reference is NOT in prop@v5a.ifcx → must NOT be exported
      propertyBuilder.add({
        entityId: 1, psetName: 'Pset_WallCommon', psetGlobalId: '',
        propName: 'Reference', value: 'Holz Aussenwand_470mm', propType: PropertyValueType.String,
      });
      // LoadBearing is NOT in prop@v5a.ifcx → must NOT be exported
      propertyBuilder.add({
        entityId: 1, psetName: 'Pset_WallCommon', psetGlobalId: '',
        propName: 'LoadBearing', value: true, propType: PropertyValueType.Boolean,
      });
      // ExtendToStructure is NOT in prop@v5a.ifcx → must NOT be exported
      propertyBuilder.add({
        entityId: 1, psetName: 'Pset_WallCommon', psetGlobalId: '',
        propName: 'ExtendToStructure', value: false, propType: PropertyValueType.Boolean,
      });
      // NumberOfStoreys IS in the official prop schema → should be exported
      propertyBuilder.add({
        entityId: 2, psetName: 'Pset_BuildingCommon', psetGlobalId: '',
        propName: 'NumberOfStoreys', value: 3, propType: PropertyValueType.Integer,
      });
      // IsLandmarked is NOT in prop@v5a.ifcx → must NOT be exported
      propertyBuilder.add({
        entityId: 2, psetName: 'Pset_BuildingCommon', psetGlobalId: '',
        propName: 'IsLandmarked', value: false, propType: PropertyValueType.Boolean,
      });
      // AboveGround is NOT in prop@v5a.ifcx → must NOT be exported
      propertyBuilder.add({
        entityId: 2, psetName: 'Pset_BuildingStoreyCommon', psetGlobalId: '',
        propName: 'AboveGround', value: 'UNKNOWN', propType: PropertyValueType.String,
      });

      const relBuilder = new RelationshipGraphBuilder();
      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 2, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
      } as unknown as IfcDataStore;

      const exporter = new Ifc5Exporter(dataStore);
      const result = exporter.export({ includeGeometry: false, onlyTreeEntities: false });
      const file = JSON.parse(result.content);

      // Must produce zero validation errors
      const errors = validateIfcxFile(file);
      expect(errors).toEqual([]);

      // Verify correct properties are present/absent
      const allPropKeys = new Set<string>();
      for (const node of file.data) {
        for (const key of Object.keys(node.attributes ?? {})) {
          if (key.startsWith('bsi::ifc::prop::') && key !== 'bsi::ifc::prop::Name' && key !== 'bsi::ifc::prop::Description') {
            allPropKeys.add(key);
          }
        }
      }

      // These should be exported (they have official IFC5 schemas)
      expect(allPropKeys).toContain('bsi::ifc::prop::IsExternal');
      expect(allPropKeys).toContain('bsi::ifc::prop::NumberOfStoreys');

      // These must NOT be exported (no official IFC5 schema)
      expect(allPropKeys).not.toContain('bsi::ifc::prop::Reference');
      expect(allPropKeys).not.toContain('bsi::ifc::prop::LoadBearing');
      expect(allPropKeys).not.toContain('bsi::ifc::prop::ExtendToStructure');
      expect(allPropKeys).not.toContain('bsi::ifc::prop::IsLandmarked');
      expect(allPropKeys).not.toContain('bsi::ifc::prop::AboveGround');
    });

    it('export without geometry produces zero validation errors', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'g1', name: 'Wall' },
      ]);
      const exporter = new Ifc5Exporter(dataStore);
      const result = exporter.export({ includeGeometry: false, includeProperties: false, onlyTreeEntities: false });
      const file = JSON.parse(result.content);

      const errors = validateIfcxFile(file);
      expect(errors).toEqual([]);
    });

    it('every attribute key in export output has a matching official schema', () => {
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(1, strings);
      entityBuilder.add(1, 'IFCWALL', 'abc', 'Wall', 'desc', '');
      const propertyBuilder = new PropertyTableBuilder(strings);
      propertyBuilder.add({
        entityId: 1, psetName: 'Pset_WallCommon', psetGlobalId: '', propName: 'IsExternal',
        value: true, propType: PropertyValueType.Boolean,
      });
      const relBuilder = new RelationshipGraphBuilder();
      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 1, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings, entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
      } as unknown as IfcDataStore;

      const meshes = makeMockMeshes(1);
      const exporter = new Ifc5Exporter(dataStore, { meshes } as any);
      const result = exporter.export({ onlyTreeEntities: false });
      const file = JSON.parse(result.content);

      // Collect every attribute key used in the export
      const usedKeys = new Set<string>();
      for (const node of file.data) {
        for (const key of Object.keys(node.attributes ?? {})) {
          usedKeys.add(key);
        }
      }

      // Every key must either be in the official schemas or follow the
      // bsi::ifc::prop:: pattern (custom properties are allowed by spec)
      const unknownKeys: string[] = [];
      for (const key of usedKeys) {
        if (ALL_OFFICIAL_SCHEMAS[key]) continue;
        // Custom properties under bsi::ifc::prop:: are allowed
        if (key.startsWith('bsi::ifc::prop::')) continue;
        unknownKeys.push(key);
      }

      expect(unknownKeys).toEqual([]);
    });

    it('exporter IFC5_KNOWN_PROP_NAMES matches the real prop@v5a.ifcx schema file', () => {
      // This test ensures the hardcoded allowlist in ifc5-exporter.ts stays
      // in sync with the real BSI schema file. If buildingSMART adds/removes
      // a property in prop@v5a.ifcx, this test will fail until the exporter
      // is updated.
      const officialPropNames = Object.keys(IFC_PROP_SCHEMAS)
        .map((k) => k.replace('bsi::ifc::prop::', ''))
        .filter((n) => n !== 'Name' && n !== 'Description'); // handled separately

      // Build a set of known props that the exporter knows about by
      // exporting all official props and checking which ones survive
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(1, strings);
      entityBuilder.add(1, 'IFCWALL', 'g1', 'Wall', '', '');
      const propertyBuilder = new PropertyTableBuilder(strings);

      // Add ALL official property names from the real schema
      for (const propName of officialPropNames) {
        propertyBuilder.add({
          entityId: 1,
          psetName: 'Test',
          psetGlobalId: '',
          propName,
          value: propName === 'IsExternal' ? true : propName === 'NumberOfStoreys' ? 1 : 0.0,
          propType: propName === 'IsExternal' ? PropertyValueType.Boolean
            : propName === 'NumberOfStoreys' ? PropertyValueType.Integer
            : PropertyValueType.Real,
        });
      }

      const relBuilder = new RelationshipGraphBuilder();
      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 1, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
      } as unknown as IfcDataStore;

      const exporter = new Ifc5Exporter(dataStore);
      const file = JSON.parse(exporter.export({ includeGeometry: false, onlyTreeEntities: false }).content);

      const exportedPropNames = new Set<string>();
      for (const node of file.data) {
        for (const key of Object.keys(node.attributes ?? {})) {
          if (key.startsWith('bsi::ifc::prop::') && key !== 'bsi::ifc::prop::Name' && key !== 'bsi::ifc::prop::Description') {
            exportedPropNames.add(key.replace('bsi::ifc::prop::', ''));
          }
        }
      }

      // Every official prop should be exported
      const missingFromExporter = officialPropNames.filter((n) => !exportedPropNames.has(n));
      expect(missingFromExporter).toEqual([]);
    });

    it('does NOT use deprecated bsi::ifc::globalId attribute', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'some-guid', name: 'Wall' },
      ]);
      const exporter = new Ifc5Exporter(dataStore);
      const result = exporter.export({ includeGeometry: false, onlyTreeEntities: false });
      const file = JSON.parse(result.content);

      for (const node of file.data) {
        expect(node.attributes?.['bsi::ifc::globalId']).toBeUndefined();
        expect(node.attributes?.['bsi::ifc::name']).toBeUndefined();
        expect(node.attributes?.['bsi::ifc::description']).toBeUndefined();
      }
    });

    it('uses bsi::ifc::prop::Name and bsi::ifc::prop::Description instead', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'g1', name: 'MyWall', description: 'A wall' },
      ]);
      const exporter = new Ifc5Exporter(dataStore);
      const result = exporter.export({ includeGeometry: false, includeProperties: false, onlyTreeEntities: false });
      const file = JSON.parse(result.content);

      const node = file.data[0];
      expect(node.attributes['bsi::ifc::prop::Name']).toBe('MyWall');
      expect(node.attributes['bsi::ifc::prop::Description']).toBe('A wall');
    });
  });

  describe('bsi::ifc::class', () => {
    it('has both code and uri matching official schema', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'abc', name: 'Wall' },
      ]);
      const exporter = new Ifc5Exporter(dataStore);
      const result = exporter.export({ includeGeometry: false, includeProperties: false, onlyTreeEntities: false });
      const file = JSON.parse(result.content);

      const cls = file.data[0].attributes['bsi::ifc::class'];
      expect(cls).toEqual({
        code: 'IfcWall',
        uri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/IfcWall',
      });

      // Validate against official schema
      const schema = ALL_OFFICIAL_SCHEMAS['bsi::ifc::class'];
      const errors = validateValue(cls, schema.value, 'bsi::ifc::class');
      expect(errors).toEqual([]);
    });

    it.skipIf(!FIXTURES_AVAILABLE)('uri pattern matches real IFC5 reference files', () => {
      const ref = loadReferenceFile('Hello_Wall_hello-wall.ifcx');
      // Extract the URI pattern from reference
      const refUriPattern = /^https:\/\/identifier\.buildingsmart\.org\/uri\/buildingsmart\/ifc\/\d[.\d]*\/class\/\w+$/;
      for (const node of ref.data) {
        const cls = node.attributes?.['bsi::ifc::class'];
        if (cls) expect(cls.uri).toMatch(refUriPattern);
      }

      // Our export must match same pattern
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'g1', name: 'Wall' },
      ]);
      const exporter = new Ifc5Exporter(dataStore);
      const file = JSON.parse(exporter.export({ includeGeometry: false, includeProperties: false, onlyTreeEntities: false }).content);
      expect(file.data[0].attributes['bsi::ifc::class'].uri).toMatch(refUriPattern);
    });
  });

  describe('usd::usdgeom::mesh', () => {
    it('only contains points and faceVertexIndices (per official schema)', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'g1', name: 'Wall' },
      ]);
      const meshes = makeMockMeshes(1);
      const exporter = new Ifc5Exporter(dataStore, { meshes } as any);
      const file = JSON.parse(exporter.export({ onlyTreeEntities: false }).content);

      const mesh = file.data[0].attributes['usd::usdgeom::mesh'];
      // Must have the required keys
      expect(mesh).toHaveProperty('points');
      expect(mesh).toHaveProperty('faceVertexIndices');
      // Must NOT have keys outside the official schema
      const allowedKeys = new Set(['points', 'faceVertexIndices']);
      for (const key of Object.keys(mesh)) {
        expect(allowedKeys.has(key)).toBe(true);
      }

      // Validate value against official schema
      const schema = ALL_OFFICIAL_SCHEMAS['usd::usdgeom::mesh'];
      const errors = validateValue(mesh, schema.value, 'usd::usdgeom::mesh');
      expect(errors).toEqual([]);
    });

    it('points are arrays of [x,y,z] reals', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'g1', name: 'Wall' },
      ]);
      const meshes = makeMockMeshes(1);
      const exporter = new Ifc5Exporter(dataStore, { meshes } as any);
      const file = JSON.parse(exporter.export({ onlyTreeEntities: false }).content);

      const mesh = file.data[0].attributes['usd::usdgeom::mesh'];
      expect(Array.isArray(mesh.points)).toBe(true);
      for (const pt of mesh.points) {
        expect(Array.isArray(pt)).toBe(true);
        expect(pt).toHaveLength(3);
        for (const v of pt) expect(typeof v).toBe('number');
      }
    });

    it('faceVertexIndices are integers', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'g1', name: 'Wall' },
      ]);
      const meshes = makeMockMeshes(1);
      const exporter = new Ifc5Exporter(dataStore, { meshes } as any);
      const file = JSON.parse(exporter.export({ onlyTreeEntities: false }).content);

      const mesh = file.data[0].attributes['usd::usdgeom::mesh'];
      expect(Array.isArray(mesh.faceVertexIndices)).toBe(true);
      for (const idx of mesh.faceVertexIndices) {
        expect(Number.isInteger(idx)).toBe(true);
      }
    });
  });

  describe('imports', () => {
    it.skipIf(!FIXTURES_AVAILABLE)('import URIs match those used in real IFC5 files', () => {
      const ref = loadReferenceFile('Hello_Wall_hello-wall.ifcx');
      const refUris = new Set((ref.imports ?? []).map((i: any) => i.uri));

      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'abc', name: 'Wall' },
      ]);
      const meshes = makeMockMeshes(1);
      const exporter = new Ifc5Exporter(dataStore, { meshes } as any);
      const file = JSON.parse(exporter.export({ onlyTreeEntities: false }).content);

      for (const imp of file.imports) {
        expect(imp).toHaveProperty('uri');
        expect(typeof imp.uri).toBe('string');
        expect(refUris).toContain(imp.uri);
      }
    });

    it('includes prop import when name/description are written', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'g1', name: 'Wall', description: 'Desc' },
      ]);
      const exporter = new Ifc5Exporter(dataStore);
      const file = JSON.parse(exporter.export({ includeGeometry: false, includeProperties: false, onlyTreeEntities: false }).content);

      const propImport = file.imports.find(
        (i: { uri: string }) => i.uri === STANDARD_IMPORT_URIS.IFC_PROP,
      );
      expect(propImport).toBeDefined();
    });
  });

  describe.skipIf(!FIXTURES_AVAILABLE)('cross-validation against reference files', () => {
    it('reference file Hello_Wall_hello-wall.ifcx passes official schema validation', () => {
      const ref = loadReferenceFile('Hello_Wall_hello-wall.ifcx');
      const errors = validateIfcxFile(ref);
      expect(errors).toEqual([]);
    });

    it('reference file ACCA_Building passes official schema validation', () => {
      const ref = loadReferenceFile('ACCA_Building_esempio_01_edificius.ifcx');
      const errors = validateIfcxFile(ref);
      expect(errors).toEqual([]);
    });

    it('reference file IFC_Hero_Model passes official schema validation', () => {
      const ref = loadReferenceFile('IFC_Hero_Model_IFC_Hero_Model.ifcx');
      const errors = validateIfcxFile(ref);
      expect(errors).toEqual([]);
    });
  });

  // ==========================================================================
  // End-to-end: parse real IFC4 → export IFC5 → validate against official schemas
  // ==========================================================================

  describe('end-to-end: IFC4 parse → IFC5 export → official schema validation', () => {
    // Real IFC4 file content (Revit-exported, walls with properties)
    const REAL_IFC4 = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView_V1.0]'),'2;1');
FILE_NAME('test','2023-01-17T16:18:54+01:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCORGANIZATION($,'Autodesk Revit 2023 (ENU)',$,$,$);
#2=IFCAPPLICATION(#1,'2023','Autodesk Revit 2023 (ENU)','Revit');
#3=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCDIRECTION((1.,0.,0.));
#9=IFCDIRECTION((0.,0.,1.));
#15=IFCPERSON($,'Author','IFC',(),$,$,$,$);
#16=IFCORGANIZATION($,'TestOrg','',$,$);
#17=IFCPERSONANDORGANIZATION(#15,#16,$);
#18=IFCOWNERHISTORY(#17,#2,$,.NOCHANGE.,$,$,$,1673968733);
#19=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#21=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#22=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#25=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#24=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.017453292519943278),#22);
#26=IFCCONVERSIONBASEDUNIT(#25,.PLANEANGLEUNIT.,'DEGREE',#24);
#82=IFCUNITASSIGNMENT((#19,#20,#21,#26));
#83=IFCAXIS2PLACEMENT3D(#3,$,$);
#85=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#83,$);
#90=IFCPROJECT('3k3rYVmQDDW90hT9pdtv9K',#18,'0000','IfcProject Description',$,'Project','Status',(#85),#82);
#92=IFCAXIS2PLACEMENT3D(#3,$,$);
#112=IFCLOCALPLACEMENT($,#92);
#113=IFCSITE('3k3rYVmQDDW90hT9pdtv9M',#18,'TestSite',$,$,#112,$,$,.ELEMENT.,(47,21,39,600219),(8,33,38,576431),0.,$,$);
#93=IFCLOCALPLACEMENT(#112,#92);
#95=IFCBUILDING('3k3rYVmQDDW90hT9pdtv9L',#18,'TestBuilding',$,$,#93,$,'TestBuilding',.ELEMENT.,$,$,$);
#98=IFCLOCALPLACEMENT(#93,#92);
#99=IFCBUILDINGSTOREY('3k3rYVmQDDW90hT9mO8S_F',#18,'U1.UG_RDOK',$,'Level',#98,$,'U1.UG_RDOK',.ELEMENT.,-3.5);
#102=IFCBUILDINGSTOREY('3k3rYVmQDDW90hT9mO86pt',#18,'00.EG_RDOK',$,'Level',#98,$,'00.EG_RDOK',.ELEMENT.,0.);
#119=IFCLOCALPLACEMENT(#98,#92);
#139=IFCWALL('3DqaUydM99ehywE4_2hm1u',#18,'Basic Wall:Holz Aussenwand_470mm:2270026',$,'Basic Wall:Holz Aussenwand_470mm',#119,$,'2270026',.NOTDEFINED.);
#264=IFCWALL('3DqaUydM99ehywE4_2hm2J',#18,'Basic Wall:Holz tragende Wohnungstrennwand_380mm:2270113',$,'Basic Wall:Holz tragende Wohnungstrennwand_380mm',#119,$,'2270113',.NOTDEFINED.);
#320=IFCWALL('3DqaUydM99ehywE4_2hm37',#18,'Basic Wall:STB 30cm:2270197',$,'Basic Wall:STB 30cm, Beton C30/37',#119,$,'2270197',.NOTDEFINED.);
#234=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#235=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);
#236=IFCPROPERTYSINGLEVALUE('ExtendToStructure',$,IFCBOOLEAN(.F.),$);
#230=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('Holz Aussenwand_470mm'),$);
#237=IFCPROPERTYSET('3GyMrhoFW4z01N$8$28gdn',#18,'Pset_WallCommon',$,(#230,#234,#235,#236));
#240=IFCRELDEFINESBYPROPERTIES('2mQcscH4zO43fkth_BMjq4',#18,$,$,(#139),#237);
#356=IFCRELCONTAINEDINSPATIALSTRUCTURE('18M1N3O8v0TvfnULSexYwc',#18,$,$,(#139,#264,#320),#99);
#363=IFCRELAGGREGATES('2Tp0Y1RCTYVG3kBW3f1hFa',#18,$,$,#90,(#113));
#364=IFCRELAGGREGATES('3QnmEzPqwebvbfIT3RQXck',#18,$,$,#113,(#95));
#365=IFCRELAGGREGATES('3mQBaTfuH9QBHDcYQBQvNl',#18,$,$,#95,(#99,#102));
ENDSEC;
END-ISO-10303-21;`;

    it('real IFC4 file exported as IFC5 produces zero validation errors', async () => {
      const parser = new IfcParser();
      const store = await parser.parseColumnar(
        new TextEncoder().encode(REAL_IFC4).buffer,
      );

      const exporter = new Ifc5Exporter(store);
      const result = exporter.export({ includeGeometry: false });
      const file = JSON.parse(result.content);

      // Validate against official schemas
      const errors = validateIfcxFile(file);
      expect(errors).toEqual([]);
    });

    it('real IFC4 file exported as IFC5 has no unknown attribute keys', async () => {
      const parser = new IfcParser();
      const store = await parser.parseColumnar(
        new TextEncoder().encode(REAL_IFC4).buffer,
      );

      const exporter = new Ifc5Exporter(store);
      const result = exporter.export({ includeGeometry: false });
      const file = JSON.parse(result.content);

      const unknownKeys: string[] = [];
      for (const node of file.data) {
        for (const key of Object.keys(node.attributes ?? {})) {
          if (ALL_OFFICIAL_SCHEMAS[key]) continue;
          if (key.startsWith('bsi::ifc::prop::')) continue;
          unknownKeys.push(`${node.path}: ${key}`);
        }
      }
      expect(unknownKeys).toEqual([]);
    });

    it('real IFC4 file exported as IFC5 has correct imports for all used namespaces', async () => {
      const parser = new IfcParser();
      const store = await parser.parseColumnar(
        new TextEncoder().encode(REAL_IFC4).buffer,
      );

      const exporter = new Ifc5Exporter(store);
      const result = exporter.export({ includeGeometry: false });
      const file = JSON.parse(result.content);

      // Should have IFC core (for bsi::ifc::class) and prop imports
      const importUris = new Set(file.imports.map((i: any) => i.uri));
      expect(importUris.has(STANDARD_IMPORT_URIS.IFC_CORE)).toBe(true);
      expect(importUris.has(STANDARD_IMPORT_URIS.IFC_PROP)).toBe(true);
    });

    it('real IFC4 file exported as IFC5 contains expected entities', async () => {
      const parser = new IfcParser();
      const store = await parser.parseColumnar(
        new TextEncoder().encode(REAL_IFC4).buffer,
      );

      const exporter = new Ifc5Exporter(store);
      const result = exporter.export({ includeGeometry: false });
      const file = JSON.parse(result.content);

      // Check that we have the expected entity types
      const classCodes = new Set<string>();
      for (const node of file.data) {
        const cls = node.attributes?.['bsi::ifc::class'];
        if (cls) classCodes.add(cls.code);
      }

      expect(classCodes).toContain('IfcWall');
      expect(classCodes).toContain('IfcProject');
      expect(classCodes).toContain('IfcSite');
      expect(classCodes).toContain('IfcBuilding');
      expect(classCodes).toContain('IfcBuildingStorey');
    });
  });

  // #2046: Ifc5Exporter never consulted the overlay for deletions — it walked
  // `dataStore.entities` raw, so an entity removed via
  // `MutablePropertyView.deleteEntity()` still came out in the IFCX output.
  // StepExporter already resolves this via `getEffectiveEntityIndex(...).isDeleted()`.
  describe('overlay deletions (#2046)', () => {
    it('does not include a deleted entity as its own node in the export', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'wall-1-guid', name: 'Wall1' },
        { expressId: 2, type: 'IFCWALL', globalId: 'wall-2-guid', name: 'Wall2 (deleted)' },
      ]);
      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(2);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      const names = file.data.map((n: any) => n.attributes?.['bsi::ifc::prop::Name']);
      expect(names).toContain('Wall1');
      expect(names).not.toContain('Wall2 (deleted)');
    });

    it('does not reference a deleted entity as a child of a surviving spatial container', () => {
      // Simulates a storey containing two walls, one of which is deleted.
      // A deleted entity must not survive as a *child reference* even though
      // its own node is gone (a second inconsistency, not a fix).
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(3, strings);
      entityBuilder.add(10, 'IFCBUILDINGSTOREY', 'storey-guid', 'Storey1', '', '');
      entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');
      entityBuilder.add(2, 'IFCWALL', 'wall-2-guid', 'Wall2 (deleted)', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      const relBuilder = new RelationshipGraphBuilder();
      const byStorey = new Map<number, number[]>([[10, [1, 2]]]);

      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 3, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
        spatialHierarchy: {
          project: { expressId: 10, name: 'Storey1', children: [] },
          bySite: null,
          byBuilding: null,
          byStorey,
          bySpace: null,
        },
      } as unknown as IfcDataStore;

      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(2);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      const storeyNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Storey1',
      );
      expect(storeyNode).toBeDefined();
      const childUuids: string[] = Object.values(storeyNode.children ?? {});
      const wall1Node = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
      );
      expect(wall1Node).toBeDefined();
      expect(childUuids).toContain(wall1Node.path);
      // No deleted-entity node exists at all, and no dangling child path
      // points at one either.
      const allNodePaths = new Set(file.data.map((n: any) => n.path));
      for (const uuid of childUuids) {
        expect(allNodePaths.has(uuid)).toBe(true);
      }
      expect(Object.keys(storeyNode.children ?? {})).not.toContain('Wall2_(deleted)');
    });

    it('regression: a non-deleted entity still exports exactly as before', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'wall-1-guid', name: 'Wall1' },
      ]);
      const exporter = new Ifc5Exporter(dataStore, null, null);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      const names = file.data.map((n: any) => n.attributes?.['bsi::ifc::prop::Name']);
      expect(names).toContain('Wall1');
      expect(file.data.length).toBe(1);
    });

    it('regression: hiddenEntityIds/isolatedEntityIds visibility filtering is unaffected by the deletion gate', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'wall-1-guid', name: 'Wall1' },
        { expressId: 2, type: 'IFCWALL', globalId: 'wall-2-guid', name: 'Wall2' },
      ]);
      const exporter = new Ifc5Exporter(dataStore, null, null);
      const result = exporter.export({
        onlyTreeEntities: false,
        visibleOnly: true,
        hiddenEntityIds: new Set([2]),
      });
      const file = JSON.parse(result.content);

      const names = file.data.map((n: any) => n.attributes?.['bsi::ifc::prop::Name']);
      expect(names).toContain('Wall1');
      expect(names).not.toContain('Wall2');
    });

    // #2047: a *self*-deleted entity was fixed above, but a survivor whose
    // PARENT is deleted was not — it kept its own node (correctly) but its
    // dangling `parentOf` edge pointed at a container that is itself skipped
    // during export, so nothing ever listed it as a child. It was present in
    // `file.data` but unreachable by walking the document from the root —
    // same failure class as the self-deletion bug, different trigger.
    it('re-parents a surviving child to the nearest surviving ancestor when its direct parent is deleted', () => {
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(4, strings);
      entityBuilder.add(100, 'IFCPROJECT', 'project-guid', 'Project1', '', '');
      entityBuilder.add(20, 'IFCBUILDING', 'building-guid', 'Building1', '', '');
      entityBuilder.add(10, 'IFCBUILDINGSTOREY', 'storey-guid', 'Storey1 (deleted)', '', '');
      entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      const relBuilder = new RelationshipGraphBuilder();
      const byStorey = new Map<number, number[]>([[10, [1]]]);

      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 4, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
        spatialHierarchy: {
          project: {
            expressId: 100,
            name: 'Project1',
            children: [
              {
                expressId: 20,
                name: 'Building1',
                children: [
                  { expressId: 10, name: 'Storey1 (deleted)', children: [] },
                ],
              },
            ],
          },
          bySite: null,
          byBuilding: null,
          byStorey,
          bySpace: null,
        },
      } as unknown as IfcDataStore;

      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(10);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      // The deleted storey has no node at all.
      const storeyNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Storey1 (deleted)',
      );
      expect(storeyNode).toBeUndefined();

      // The wall survives as its own node...
      const wallNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
      );
      expect(wallNode).toBeDefined();

      // ...and must be reachable by walking the document from its root, not
      // merely present in `file.data`. Root -> Project -> Building -> Wall,
      // skipping the deleted Storey entirely (re-parented to Building, the
      // nearest surviving ancestor).
      const rootNode = file.data.find((n: any) => n.path === file.data[0].path);
      expect(rootNode.children).toBeDefined();
      const projectUuid = Object.values(rootNode.children)[0] as string;
      const projectNode = file.data.find((n: any) => n.path === projectUuid);
      expect(projectNode).toBeDefined();

      const buildingUuid = Object.values(projectNode.children ?? {})[0] as string;
      expect(buildingUuid).toBeDefined();
      const buildingNode = file.data.find((n: any) => n.path === buildingUuid);
      expect(buildingNode).toBeDefined();
      expect(buildingNode.attributes?.['bsi::ifc::prop::Name']).toBe('Building1');

      const buildingChildUuids: string[] = Object.values(buildingNode.children ?? {});
      expect(buildingChildUuids).toContain(wallNode.path);
    });

    // #2047 (degenerate branch): the common case above has a surviving
    // ancestor to re-parent onto. When the WHOLE chain above the survivor is
    // deleted, `resolveSurvivingParent` returns `undefined` and the child
    // lands in the document-root bucket — which used to be read only by the
    // collision-naming loop and never by an emission path, so the survivor
    // was emitted with nothing listing it as a child: exactly the
    // unreachable-orphan failure this PR set out to fix, one branch over.
    it('a survivor whose entire ancestor chain is deleted is reachable from the document root', () => {
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(4, strings);
      entityBuilder.add(100, 'IFCPROJECT', 'project-guid', 'Project1 (deleted)', '', '');
      entityBuilder.add(20, 'IFCBUILDING', 'building-guid', 'Building1 (deleted)', '', '');
      entityBuilder.add(10, 'IFCBUILDINGSTOREY', 'storey-guid', 'Storey1 (deleted)', '', '');
      entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      const relBuilder = new RelationshipGraphBuilder();
      const byStorey = new Map<number, number[]>([[10, [1]]]);

      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 4, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
        spatialHierarchy: {
          project: {
            expressId: 100,
            name: 'Project1 (deleted)',
            children: [
              {
                expressId: 20,
                name: 'Building1 (deleted)',
                children: [
                  { expressId: 10, name: 'Storey1 (deleted)', children: [] },
                ],
              },
            ],
          },
          bySite: null,
          byBuilding: null,
          byStorey,
          bySpace: null,
        },
      } as unknown as IfcDataStore;

      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(100);
      view.deleteEntity(20);
      view.deleteEntity(10);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      // Every deleted ancestor is gone, including the project.
      const names = file.data.map((n: any) => n.attributes?.['bsi::ifc::prop::Name']);
      expect(names).not.toContain('Project1 (deleted)');
      expect(names).not.toContain('Building1 (deleted)');
      expect(names).not.toContain('Storey1 (deleted)');

      // The wall survives as its own node...
      const wallNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
      );
      expect(wallNode).toBeDefined();

      // ...and — the point of the test — is reachable by walking `children`
      // from the document root, not merely present in `file.data`. With no
      // surviving project the root node exists solely to hold it.
      const rootNode = file.data.find((n: any) => n.path === DOCUMENT_ROOT_PATH);
      expect(rootNode).toBeDefined();
      expect(Object.values(rootNode.children ?? {})).toContain(wallNode.path);
      expect(reachablePaths(file).has(wallNode.path)).toBe(true);
    });

    it('applyMutations: false ignores the deletion — the re-parenting logic must not kick in', () => {
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(4, strings);
      entityBuilder.add(100, 'IFCPROJECT', 'project-guid', 'Project1', '', '');
      entityBuilder.add(20, 'IFCBUILDING', 'building-guid', 'Building1', '', '');
      entityBuilder.add(10, 'IFCBUILDINGSTOREY', 'storey-guid', 'Storey1', '', '');
      entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      const relBuilder = new RelationshipGraphBuilder();
      const byStorey = new Map<number, number[]>([[10, [1]]]);

      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 4, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
        spatialHierarchy: {
          project: {
            expressId: 100,
            name: 'Project1',
            children: [
              {
                expressId: 20,
                name: 'Building1',
                children: [
                  { expressId: 10, name: 'Storey1', children: [] },
                ],
              },
            ],
          },
          bySite: null,
          byBuilding: null,
          byStorey,
          bySpace: null,
        },
      } as unknown as IfcDataStore;

      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(10);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      // applyMutations: false -> the overlay's tombstone for the storey must
      // be ignored entirely, exactly as if `view` were never passed. Output
      // must match pre-#2047 (and pre-#2046) behavior: the storey still
      // exists as its own node and still directly parents the wall.
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: false });
      const file = JSON.parse(result.content);

      const storeyNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Storey1',
      );
      expect(storeyNode).toBeDefined();

      const wallNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
      );
      expect(wallNode).toBeDefined();

      // Wall is a direct child of the (undeleted) storey — no re-parenting.
      const storeyChildUuids: string[] = Object.values(storeyNode.children ?? {});
      expect(storeyChildUuids).toContain(wallNode.path);
    });

    it('a cycle in the deleted-ancestor chain does not hang the exporter — falls back to the root bucket', () => {
      // Two deleted "containers" (1 <-> 2) reference each other as parent via
      // the flat containment maps (not the recursive spatial-tree walk, which
      // cannot itself express a cycle). A surviving wall (3) whose only path
      // to a surviving ancestor runs through that cycle must not spin the
      // ancestor walk forever — it should fall back to the document root.
      // This test's own completion (under vitest's default timeout) is one
      // assertion; the other is that the rooted wall is REACHABLE from the
      // document root. Bucket membership alone is not: this test used to
      // pass while the wall sat in a bucket no emission path ever read.
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(3, strings);
      entityBuilder.add(1, 'IFCBUILDING', 'b1-guid', 'B1 (deleted)', '', '');
      entityBuilder.add(2, 'IFCBUILDING', 'b2-guid', 'B2 (deleted)', '', '');
      entityBuilder.add(3, 'IFCWALL', 'wall-guid', 'Wall1', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      const relBuilder = new RelationshipGraphBuilder();
      // parentOf: 2 -> 1 (via bySite) and 1 -> 2 (via byBuilding) — a cycle.
      // Wall (3) is contained in 1 (via byStorey).
      const bySite = new Map<number, number[]>([[1, [2]]]);
      const byBuilding = new Map<number, number[]>([[2, [1]]]);
      const byStorey = new Map<number, number[]>([[1, [3]]]);

      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 3, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
        spatialHierarchy: {
          project: null,
          bySite,
          byBuilding,
          byStorey,
          bySpace: null,
        },
      } as unknown as IfcDataStore;

      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(1);
      view.deleteEntity(2);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      const names = file.data.map((n: any) => n.attributes?.['bsi::ifc::prop::Name']);
      expect(names).not.toContain('B1 (deleted)');
      expect(names).not.toContain('B2 (deleted)');
      expect(names).toContain('Wall1');

      const wallNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
      );
      expect(reachablePaths(file).has(wallNode.path)).toBe(true);
    });

    it('a cycle that loops back through the surviving child itself does not make it its own parent', () => {
      // parentOf: Wall1(1) -> Building1(2, deleted) -> Wall1(1). A malformed
      // hierarchy where the deleted ancestor's own "parent" is the surviving
      // child we started from. `!isDeleted(current)` is trivially true the
      // instant `current` cycles back to `childId` (it's the one node in the
      // chain guaranteed to survive), so the cycle/visited check must run
      // BEFORE the deleted check, or this resolves Wall1 as its own parent.
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(2, strings);
      entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');
      entityBuilder.add(2, 'IFCBUILDING', 'b2-guid', 'B2 (deleted)', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      const relBuilder = new RelationshipGraphBuilder();
      // bySite: 1 -> [2] gives parentOf(2) = 1.
      // byStorey: 2 -> [1] gives parentOf(1) = 2.
      const bySite = new Map<number, number[]>([[1, [2]]]);
      const byStorey = new Map<number, number[]>([[2, [1]]]);

      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 2, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
        spatialHierarchy: {
          project: null,
          bySite,
          byBuilding: null,
          byStorey,
          bySpace: null,
        },
      } as unknown as IfcDataStore;

      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(2);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      const wallNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
      );
      expect(wallNode).toBeDefined();

      // Wall1 must not appear in its own children dict (no self-parenting).
      const wallChildUuids: string[] = Object.values(wallNode.children ?? {});
      expect(wallChildUuids).not.toContain(wallNode.path);

      // Its only route to a surviving ancestor is the cycle, so it is rooted
      // exactly like the non-cyclic case: the document root — and nothing
      // else — lists it as a child, and it is reachable from there rather
      // than stranded in `file.data`.
      for (const node of file.data) {
        if (node.path === DOCUMENT_ROOT_PATH) continue;
        const childUuids: string[] = Object.values(node.children ?? {});
        expect(childUuids).not.toContain(wallNode.path);
      }
      const rootNode = file.data.find((n: any) => n.path === DOCUMENT_ROOT_PATH);
      expect(rootNode).toBeDefined();
      expect(Object.values(rootNode.children ?? {})).toContain(wallNode.path);
      expect(reachablePaths(file).has(wallNode.path)).toBe(true);
    });

    // Every deletion test above uses distinct entity names (`Wall1` /
    // `Wall2 (deleted)`), so a tombstoned sibling that leaked into the name
    // index (line ~453) or the childrenOf grouping (lines ~500/507) would
    // never be visible: those two cases only diverge once two SURVIVING
    // siblings share a raw name and one of them is a ghost. This test closes
    // that gap directly.
    it('does not leave a deleted sibling in the name/collision index — survivor keeps its bare name (#2047)', () => {
      const strings = new StringTable();
      const entityBuilder = new EntityTableBuilder(3, strings);
      entityBuilder.add(10, 'IFCBUILDINGSTOREY', 'storey-guid', 'Storey1', '', '');
      entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall', '', '');
      entityBuilder.add(2, 'IFCWALL', 'wall-2-guid', 'Wall', '', '');

      const propertyBuilder = new PropertyTableBuilder(strings);
      const relBuilder = new RelationshipGraphBuilder();
      // Two same-named siblings under one storey; #2 is deleted below.
      const byStorey = new Map<number, number[]>([[10, [1, 2]]]);

      const dataStore = {
        fileSize: 0, schemaVersion: 'IFC4', entityCount: 3, parseTime: 0,
        source: new Uint8Array(0),
        entityIndex: { byId: new Map(), byType: new Map() },
        strings,
        entities: entityBuilder.build(),
        properties: propertyBuilder.build(),
        quantities: new QuantityTableBuilder(strings).build(),
        relationships: relBuilder.build(),
        spatialHierarchy: {
          project: { expressId: 10, name: 'Storey1', children: [] },
          bySite: null,
          byBuilding: null,
          byStorey,
          bySpace: null,
        },
      } as unknown as IfcDataStore;

      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(2);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      const result = exporter.export({ onlyTreeEntities: false, applyMutations: true });
      const file = JSON.parse(result.content);

      const storeyNode = file.data.find(
        (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Storey1',
      );
      expect(storeyNode).toBeDefined();

      // If the deleted "Wall" (id 2) were still counted as a same-name
      // sibling, the survivor would be forced onto the collision-suffixed
      // key "Wall_1" instead of the bare "Wall" it is entitled to once it is
      // the storey's only wall.
      const childKeys = Object.keys(storeyNode.children ?? {});
      expect(childKeys).toEqual(['Wall']);
      expect(childKeys).not.toContain('Wall_1');
    });

    // The re-parenting walk (#2047) lets a surviving child reach the root
    // through a chain of deleted ancestors, which is enough to satisfy every
    // *reachability* assertion above without the UUID-assignment skip (the
    // `if (effective.isDeleted(id)) continue` guard over `entityUuids`)
    // doing anything distinguishable — `childrenOf`'s own deleted-child skip
    // already keeps a tombstoned id out of every parent's children dict
    // regardless of whether it also has a UUID. Assert the invariant at the
    // uuid-table level directly, so this test fails if that specific guard
    // is ever dropped even though no downstream reachability check would
    // notice.
    it('assigns no entityUuids entry to a deleted entity, checked at the uuid table itself (#2046)', () => {
      const dataStore = buildMinimalDataStore([
        { expressId: 1, type: 'IFCWALL', globalId: 'wall-1-guid', name: 'Wall1' },
        { expressId: 2, type: 'IFCWALL', globalId: 'wall-2-guid', name: 'Wall2 (deleted)' },
      ]);
      const view = new LiveMutablePropertyView(null, 'm1');
      view.deleteEntity(2);

      const exporter = new Ifc5Exporter(dataStore, null, view);
      exporter.export({ onlyTreeEntities: false, applyMutations: true });

      const entityUuids = (
        exporter as unknown as { entityUuids: Map<number, string> }
      ).entityUuids;
      expect(entityUuids.has(2)).toBe(false);
      expect(entityUuids.has(1)).toBe(true);
    });
  });
});
