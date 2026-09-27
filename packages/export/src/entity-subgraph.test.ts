/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `serializeEntitySubgraph` (#6232 WP1): the mini STEP buffer the wasm mesher
 * re-meshes an edited element from. Every assertion re-PARSES the output with
 * the real parser: the contract is that the buffer is a valid, closed STEP
 * file that means what the session's effective model says.
 */

import { describe, expect, it, vi } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { serializeEntitySubgraph, remeshContextRoots } from './entity-subgraph.js';
import { collectRefsInByteRange } from './reference-collector.js';

const WALL = 100;
const SOLID = 106;
const OPENING = 110;
const VOIDS = 116;
const WINDOW = 120;
const FILLS = 122;
const MATERIAL_REL = 134;
const CONTAINS = 42;
const STYLED_ITEM = 140;
const OTHER_WALL = 1000;

const guid = (n: number): string => `'${String(n).padStart(22, '0')}'`;

/** A wall voided by an opening filled by a window, a layered material shared
 *  with `extraWalls` other walls, a spatial container naming all of them, and
 *  a style on the wall's solid. */
function model(extraWalls: number, extraLines: string[] = []): string {
  const others: string[] = [];
  const otherIds: number[] = [];
  for (let k = 0; k < extraWalls; k++) {
    const b = OTHER_WALL + k * 10;
    otherIds.push(b);
    others.push(
      `#${b}=IFCWALL(${guid(b)},$,'Other ${k}',$,$,#${b + 1},#${b + 2},$,$);`,
      `#${b + 1}=IFCLOCALPLACEMENT(#41,#21);`,
      `#${b + 2}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${b + 3}));`,
      `#${b + 3}=IFCSHAPEREPRESENTATION(#23,'Body','SweptSolid',(#${b + 4}));`,
      `#${b + 4}=IFCEXTRUDEDAREASOLID(#${b + 5},#21,#108,3.);`,
      `#${b + 5}=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,0.2);`,
    );
  }
  const members = [WALL, WINDOW, ...otherIds].map((id) => `#${id}`).join(',');
  const materialMembers = [WALL, ...otherIds].map((id) => `#${id}`).join(',');
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');
FILE_NAME('m.ifc','2026-09-27T00:00:00',(''),(''),'t','t','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT(${guid(1)},$,'P',$,$,$,$,(#20),#10);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#20,$,.MODEL_VIEW.,$);
#30=IFCSITE(${guid(30)},$,'S',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#31=IFCLOCALPLACEMENT($,#21);
#32=IFCRELAGGREGATES(${guid(32)},$,$,$,#1,(#30));
#40=IFCBUILDINGSTOREY(${guid(40)},$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT(#31,#21);
#${CONTAINS}=IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid(CONTAINS)},$,$,$,(${members}),#40);
#${WALL}=IFCWALL(${guid(WALL)},$,'Wall',$,$,#101,#104,$,$);
#101=IFCLOCALPLACEMENT(#41,#21);
#104=IFCPRODUCTDEFINITIONSHAPE($,$,(#105));
#105=IFCSHAPEREPRESENTATION(#23,'Body','SweptSolid',(#${SOLID}));
#${SOLID}=IFCEXTRUDEDAREASOLID(#107,#21,#108,3.);
#107=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,5.,0.2);
#108=IFCDIRECTION((0.,0.,1.));
#${OPENING}=IFCOPENINGELEMENT(${guid(OPENING)},$,'O',$,$,#111,#112,$,.OPENING.);
#111=IFCLOCALPLACEMENT(#101,#21);
#112=IFCPRODUCTDEFINITIONSHAPE($,$,(#113));
#113=IFCSHAPEREPRESENTATION(#23,'Body','SweptSolid',(#114));
#114=IFCEXTRUDEDAREASOLID(#115,#21,#108,1.);
#115=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#${VOIDS}=IFCRELVOIDSELEMENT(${guid(VOIDS)},$,$,$,#${WALL},#${OPENING});
#${WINDOW}=IFCWINDOW(${guid(WINDOW)},$,'Win',$,$,#121,$,$,$,$,$,$,$);
#121=IFCLOCALPLACEMENT(#111,#21);
#${FILLS}=IFCRELFILLSELEMENT(${guid(FILLS)},$,$,$,#${OPENING},#${WINDOW});
#130=IFCMATERIAL('Brick',$,$);
#131=IFCMATERIALLAYER(#130,0.2,$,$,$,$,$);
#132=IFCMATERIALLAYERSET((#131),'LS',$);
#133=IFCMATERIALLAYERSETUSAGE(#132,.AXIS2.,.POSITIVE.,0.,$);
#${MATERIAL_REL}=IFCRELASSOCIATESMATERIAL(${guid(MATERIAL_REL)},$,$,$,(${materialMembers}),#133);
#${STYLED_ITEM}=IFCSTYLEDITEM(#${SOLID},(#141),$);
#141=IFCSURFACESTYLE('s',.BOTH.,(#142));
#142=IFCSURFACESTYLESHADING(#143,$);
#143=IFCCOLOURRGB($,1.,0.,0.);
${[...others, ...extraLines].join('\n')}
ENDSEC;
END-ISO-10303-21;`;
}

async function parse(text: string | Uint8Array): Promise<IfcDataStore> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer);
}

function withEditor(store: IfcDataStore): { view: MutablePropertyView; editor: StoreEditor } {
  const view = new MutablePropertyView(null, 'm');
  return { view, editor: new StoreEditor(store, view) };
}

/** Every express id the re-parsed buffer defines, and every `#ref` that no
 *  line defines. */
function closure(store: IfcDataStore): { defined: Set<number>; dangling: string[] } {
  const defined = new Set<number>();
  const dangling: string[] = [];
  for (const [id] of store.entityIndex.byId) defined.add(id);
  for (const [id, ref] of store.entityIndex.byId) {
    for (const target of collectRefsInByteRange(store.source, ref.byteOffset, ref.byteLength)) {
      if (!defined.has(target)) dangling.push(`#${id} -> #${target}`);
    }
  }
  return { defined, dangling };
}

function lineOf(bytes: Uint8Array, id: number): string | undefined {
  return new TextDecoder().decode(bytes).match(new RegExp(`^#${id}=[^\\n]*$`, 'm'))?.[0];
}

describe('serializeEntitySubgraph (#6232)', () => {
  it('parses back as a closed STEP file that keeps every express id', async () => {
    const store = await parse(model(3));
    const sub = serializeEntitySubgraph(store, null, { targets: new Set([WALL]) });
    const back = await parse(sub.bytes);
    const { defined, dangling } = closure(back);

    expect(dangling).toEqual([]);
    expect(defined).toEqual(new Set(sub.ids));
    expect(sub.unreadable).toEqual([]);
    // Ids preserved: the wall's own line is byte-identical to the source.
    expect(lineOf(sub.bytes, WALL)).toBe(`#${WALL}=IFCWALL(${guid(WALL)},$,'Wall',$,$,#101,#104,$,$);`);
    expect(back.entityIndex.byId.get(WALL)?.type.toUpperCase()).toBe('IFCWALL');
  });

  it('carries the project, the voiding and filling context and the material, but not neighbours or styles', async () => {
    const store = await parse(model(3));
    const sub = serializeEntitySubgraph(store, null, { targets: new Set([WALL]) });

    for (const id of [1, 10, 11, 20, 23, OPENING, VOIDS, WINDOW, FILLS, MATERIAL_REL, 133, 132, 131, 130]) {
      expect(sub.ids.has(id), `#${id}`).toBe(true);
    }
    for (const id of [OTHER_WALL, OTHER_WALL + 10, CONTAINS, 30, 32, 40, STYLED_ITEM, 141]) {
      expect(sub.ids.has(id), `#${id}`).toBe(false);
    }
    // The shared material relationship is narrowed to what the subgraph holds.
    expect(lineOf(sub.bytes, MATERIAL_REL)).toBe(
      `#${MATERIAL_REL}=IFCRELASSOCIATESMATERIAL(${guid(MATERIAL_REL)},$,$,$,(#${WALL}),#133);`,
    );
    const back = await parse(sub.bytes);
    expect(back.relationships.getRelated(WALL, RelationshipType.VoidsElement, 'forward')).toEqual([OPENING]);
    expect(back.relationships.getRelated(OPENING, RelationshipType.FillsElement, 'forward')).toEqual([WINDOW]);
  });

  it('carries queued edits and drops tombstoned context', async () => {
    const store = await parse(model(1));
    const { view, editor } = withEditor(store);
    editor.setPositionalAttribute(SOLID, 3, 4.5);
    editor.removeEntity(OPENING);

    const sub = serializeEntitySubgraph(store, view, { targets: new Set([WALL]) });
    expect(lineOf(sub.bytes, SOLID)).toBe(`#${SOLID}=IFCEXTRUDEDAREASOLID(#107,#21,#108,4.5);`);
    expect(sub.ids.has(OPENING)).toBe(false);
    expect(sub.ids.has(VOIDS)).toBe(false);
    expect(closure(await parse(sub.bytes)).dangling).toEqual([]);
  });

  it('round-trips an overlay-created wall with its IfcRelVoidsElement', async () => {
    const store = await parse(model(1));
    const { view, editor } = withEditor(store);
    const profile = editor.addEntity('IfcRectangleProfileDef', ['.AREA.', null, null, 2, 0.3]).expressId;
    const solid = editor.addEntity('IfcExtrudedAreaSolid', [`#${profile}`, '#21', '#108', 2.5]).expressId;
    const rep = editor.addEntity('IfcShapeRepresentation', ['#23', 'Body', 'SweptSolid', [`#${solid}`]]).expressId;
    const shape = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${rep}`]]).expressId;
    const place = editor.addEntity('IfcLocalPlacement', ['#41', '#21']).expressId;
    const wall = editor.addEntity('IfcWall', ['1wall000000000000000000', null, 'New', null, null, `#${place}`, `#${shape}`, null, null]).expressId;
    const openingPlace = editor.addEntity('IfcLocalPlacement', [`#${place}`, '#21']).expressId;
    const opening = editor.addEntity('IfcOpeningElement', ['1open000000000000000000', null, 'O', null, null, `#${openingPlace}`, '#112', null, '.OPENING.']).expressId;
    const rel = editor.addEntity('IfcRelVoidsElement', ['1void000000000000000000', null, null, null, `#${wall}`, `#${opening}`]).expressId;

    expect(remeshContextRoots(store, view, new Set([wall]))).toEqual(new Set([1, rel, wall, opening]));
    const sub = serializeEntitySubgraph(store, view, { targets: new Set([wall]) });
    const back = await parse(sub.bytes);
    expect(closure(back).dangling).toEqual([]);
    for (const id of [wall, opening, rel, solid, profile, place, 112, 114]) expect(sub.ids.has(id), `#${id}`).toBe(true);
    // Overlay-allocated ids are kept, so meshes key straight back.
    expect(back.relationships.getRelated(wall, RelationshipType.VoidsElement, 'forward')).toEqual([opening]);
    expect(back.entityIndex.byId.get(wall)?.type.toUpperCase()).toBe('IFCWALL');
  });

  it('terminates on reference cycles and on chains far deeper than any stack', async () => {
    const depth = 50_000;
    const chain: string[] = [`#200000=IFCLOCALPLACEMENT($,#21);`];
    for (let i = 1; i < depth; i++) chain.push(`#${200000 + i}=IFCLOCALPLACEMENT(#${200000 + i - 1},#21);`);
    const top = 200000 + depth - 1;
    const lines = [
      ...chain,
      `#300000=IFCWALL(${guid(300000)},$,'Deep',$,$,#${top},$,$,$);`,
      // Two placements relative to each other: a cycle.
      `#300001=IFCLOCALPLACEMENT(#300002,#21);`,
      `#300002=IFCLOCALPLACEMENT(#300001,#21);`,
      `#300003=IFCWALL(${guid(300003)},$,'Loop',$,$,#300001,$,$,$);`,
    ];
    const store = await parse(model(0, lines));

    const deep = serializeEntitySubgraph(store, null, { targets: new Set([300000]) });
    expect(deep.ids.has(200000)).toBe(true);
    expect(deep.ids.has(top)).toBe(true);
    const loop = serializeEntitySubgraph(store, null, { targets: new Set([300003]) });
    expect([300001, 300002, 300003].every((id) => loop.ids.has(id))).toBe(true);
    expect(closure(await parse(loop.bytes)).dangling).toEqual([]);
  });

  it('visits the same entities however large the rest of the model is', async () => {
    const visits = async (extraWalls: number): Promise<{ gets: number; size: number }> => {
      const store = await parse(model(extraWalls));
      const get = vi.spyOn(store.entityIndex.byId, 'get');
      const sub = serializeEntitySubgraph(store, null, { targets: new Set([WALL]) });
      return { gets: get.mock.calls.length, size: sub.ids.size };
    };
    const small = await visits(2);
    const large = await visits(2_000);
    expect(large.size).toBe(small.size);
    expect(large.gets).toBe(small.gets);
    // Bounded by the walked set, not the 12k-entity model.
    expect(large.gets).toBeLessThan(4 * large.size);
  });
});
