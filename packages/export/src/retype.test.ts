/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { retypeStepLine } from './retype.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type MockEntityRef = { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number };

function buildMockDataStore(
  entries: Array<[number, string, string]>,
  schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' = 'IFC4',
): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
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
    schemaVersion,
    entityCount: entries.length,
    parseTime: 0,
    source,
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

/** Pull the single `#id=...;` record for an entity out of exported content.
 *  Matches up to the STEP record terminator (`;`) rather than a line boundary,
 *  so the slice is correct regardless of how the file is wrapped. */
function lineFor(content: string, id: number): string {
  const m = content.match(new RegExp(`#${id}=[^;]*;`));
  return m ? m[0] : '';
}

describe('retypeStepLine (unit)', () => {
  it('swaps the keyword for an identical IFC4 layout, preserving args byte-for-byte', () => {
    const line = "#42=IFCBUILDINGELEMENTPROXY('guid',$,'Proxy',$,$,#10,#20,'tag',.NOTDEFINED.);";
    const out = retypeStepLine(line, 'IfcBuildingElementProxy', 'IfcColumn', null, 'IFC4');
    expect(out).toBe("#42=IFCCOLUMN('guid',$,'Proxy',$,$,#10,#20,'tag',.NOTDEFINED.);");
  });

  it('drops an out-of-domain carried PredefinedType', () => {
    // .ELEMENT. is valid for a proxy but not for IfcColumn → drop to $.
    const line = "#42=IFCBUILDINGELEMENTPROXY('guid',$,'P',$,$,#10,#20,'tag',.ELEMENT.);";
    const out = retypeStepLine(line, 'IfcBuildingElementProxy', 'IfcColumn', null, 'IFC4');
    expect(out).toBe("#42=IFCCOLUMN('guid',$,'P',$,$,#10,#20,'tag',$);");
  });

  it('sets a valid PredefinedType override', () => {
    const line = "#42=IFCBUILDINGELEMENTPROXY('guid',$,'P',$,$,#10,#20,'tag',$);";
    const out = retypeStepLine(line, 'IfcBuildingElementProxy', 'IfcColumn', 'PILASTER', 'IFC4');
    expect(out).toBe("#42=IFCCOLUMN('guid',$,'P',$,$,#10,#20,'tag',.PILASTER.);");
  });

  it('falls back to USERDEFINED + ObjectType for an unknown PredefinedType override', () => {
    const line = "#42=IFCBUILDINGELEMENTPROXY('guid',$,'P',$,$,#10,#20,'tag',$);";
    const out = retypeStepLine(line, 'IfcBuildingElementProxy', 'IfcColumn', 'MY_SPECIAL_KIND', 'IFC4');
    // ObjectType is attribute index 4; PredefinedType index 8.
    expect(out).toBe("#42=IFCCOLUMN('guid',$,'P',$,'MY_SPECIAL_KIND',#10,#20,'tag',.USERDEFINED.);");
  });

  it('drops the trailing IFC2X3 CompositionType when the target has no 9th attribute', () => {
    // IFC2X3 proxy has CompositionType; IfcColumn has only 8 attributes.
    const line = "#42=IFCBUILDINGELEMENTPROXY('guid',$,'P',$,$,#10,#20,'tag',.ELEMENT.);";
    const out = retypeStepLine(line, 'IfcBuildingElementProxy', 'IfcColumn', null, 'IFC2X3');
    expect(out).toBe("#42=IFCCOLUMN('guid',$,'P',$,$,#10,#20,'tag');");
  });

  it('keyword-only swaps when the target class is unknown to the schema', () => {
    const line = "#42=IFCBUILDINGELEMENTPROXY('guid',$,'P',$,$,#10,#20,'tag',$);";
    const out = retypeStepLine(line, 'IfcBuildingElementProxy', 'IfcVendorExtensionThing', null, 'IFC4');
    expect(out).toBe("#42=IFCVENDOREXTENSIONTHING('guid',$,'P',$,$,#10,#20,'tag',$);");
  });
});

describe('StepExporter retype materialization', () => {
  it('retypes an existing proxy to IfcColumn, keeping geometry + IfcRel references on the same id', () => {
    const store = buildMockDataStore([
      [10, 'IfcLocalPlacement', '#10=IFCLOCALPLACEMENT($,#11);'],
      [11, 'IfcAxis2Placement3D', '#11=IFCAXIS2PLACEMENT3D(#12,$,$);'],
      [12, 'IfcCartesianPoint', '#12=IFCCARTESIANPOINT((0.,0.,0.));'],
      [20, 'IfcProductDefinitionShape', '#20=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));'],
      [21, 'IfcShapeRepresentation', "#21=IFCSHAPEREPRESENTATION(#22,'Body','SweptSolid',(#23));"],
      [22, 'IfcGeometricRepresentationContext', '#22=IFCGEOMETRICREPRESENTATIONCONTEXT($,$,3,$,$,$);'],
      [23, 'IfcExtrudedAreaSolid', '#23=IFCEXTRUDEDAREASOLID(#24,$,#25,1.);'],
      [24, 'IfcRectangleProfileDef', '#24=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.3,0.3);'],
      [25, 'IfcDirection', '#25=IFCDIRECTION((0.,0.,1.));'],
      [42, 'IfcBuildingElementProxy', "#42=IFCBUILDINGELEMENTPROXY('1abcGUID000000000000PR',$,'SW-Part',$,$,#10,#20,'PART-42',.NOTDEFINED.);"],
      [50, 'IfcRelContainedInSpatialStructure', "#50=IFCRELCONTAINEDINSPATIALSTRUCTURE('relGUID00000000000000',$,$,$,(#42),#60);"],
    ]);

    const view = new MutablePropertyView(null, 'm1');
    view.setEntityType(42, 'IfcColumn');

    const exporter = new StepExporter(store, view);
    const content = decode(exporter.export({ schema: 'IFC4', applyMutations: true }).content);

    // The proxy is now a column…
    expect(content).toContain("#42=IFCCOLUMN('1abcGUID000000000000PR',$,'SW-Part',$,$,#10,#20,'PART-42',.NOTDEFINED.);");
    expect(content).not.toContain('IFCBUILDINGELEMENTPROXY');
    // …with its geometry + placement + the containment relationship all still
    // pointing at #42 (refs are by #id, so they carry over untouched).
    expect(lineFor(content, 42)).toContain('#10');
    expect(lineFor(content, 42)).toContain('#20');
    expect(content).toContain('(#42),#60');
    expect(content).toContain('#23=IFCEXTRUDEDAREASOLID(#24,$,#25,1.);');
  });

  it('retypes with a PredefinedType override', () => {
    const store = buildMockDataStore([
      [42, 'IfcBuildingElementProxy', "#42=IFCBUILDINGELEMENTPROXY('g',$,'P',$,$,$,$,$,.NOTDEFINED.);"],
    ]);
    const view = new MutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(42);
    view.setEntityType(42, 'IfcBeam', 'JOIST');

    const exporter = new StepExporter(store, view);
    const content = decode(exporter.export({ schema: 'IFC4', applyMutations: true }).content);

    expect(content).toContain("#42=IFCBEAM('g',$,'P',$,$,$,$,$,.JOIST.);");
  });

  it('retypes a freshly-created overlay entity', () => {
    const store = buildMockDataStore([
      [1, 'IfcProject', "#1=IFCPROJECT('projGUID0000000000000',$,'P',$,$,$,$,$,$);"],
    ]);
    const view = new MutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    // Per the NewEntity convention, label strings are passed RAW (serializeStepValue
    // quotes them); `$`/`.ENUM.`/`#N` tokens pass through.
    const created = view.createEntity('IfcBuildingElementProxy', [
      'newGUID00000000000000', '$', 'Created', '$', '$', '$', '$', '$', '.NOTDEFINED.',
    ]);
    view.setEntityType(created.expressId, 'IfcMember', 'MULLION');

    const exporter = new StepExporter(store, view);
    const content = decode(exporter.export({ schema: 'IFC4', applyMutations: true }).content);

    expect(content).toContain(`#${created.expressId}=IFCMEMBER('newGUID00000000000000',$,'Created',$,$,$,$,$,.MULLION.);`);
    expect(content).not.toContain('IFCBUILDINGELEMENTPROXY');
  });

  it('applies a same-class PredefinedType override on a created entity', () => {
    const store = buildMockDataStore([
      [1, 'IfcProject', "#1=IFCPROJECT('projGUID0000000000000',$,'P',$,$,$,$,$,$);"],
    ]);
    const view = new MutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(1);
    const created = view.createEntity('IfcColumn', [
      'colGUID000000000000000', '$', 'Col', '$', '$', '$', '$', '$', '$',
    ]);
    // Same class, but set PredefinedType via the retype API.
    view.setEntityType(created.expressId, 'IfcColumn', 'PILASTER');

    const exporter = new StepExporter(store, view);
    const content = decode(exporter.export({ schema: 'IFC4', applyMutations: true }).content);

    expect(content).toContain(`#${created.expressId}=IFCCOLUMN('colGUID000000000000000',$,'Col',$,$,$,$,$,.PILASTER.);`);
  });

  it('combines a retype with a name attribute edit on the same entity', () => {
    const store = buildMockDataStore([
      [42, 'IfcBuildingElementProxy', "#42=IFCBUILDINGELEMENTPROXY('g',$,'OldName',$,$,$,$,$,.NOTDEFINED.);"],
    ]);
    const view = new MutablePropertyView(null, 'm1');
    view.setEntityType(42, 'IfcColumn');
    view.setAttribute(42, 'Name', 'NewName');

    const exporter = new StepExporter(store, view);
    const content = decode(exporter.export({ schema: 'IFC4', applyMutations: true }).content);

    expect(content).toContain("#42=IFCCOLUMN('g',$,'NewName',$,$,$,$,$,.NOTDEFINED.);");
  });
});
