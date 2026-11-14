/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
  type NewEntity,
} from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import {
  addDrawingMarkupToStore,
  DRAWING_MARKUP_OBJECTTYPE,
  DRAWING_MARKUP_PSET_NAME,
  DRAWING_MARKUP_QSET_NAME,
  type MarkupAnchor,
} from './drawing-markup.js';
import { addDimensionMarkupToStore, type DimensionMarkupParams } from './drawing-markup-dimension.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const ANCHOR: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
const ROOT_CONTEXT_ID = 14;

/** A horizontal 4 m dimension a=(1,2) b=(5,2), its line 0.5 m above. */
const DIM: DimensionMarkupParams = {
  a: { x: 1, y: 2 },
  b: { x: 5, y: 2 },
  distance: 4,
  offset: 0.5,
  orientation: 'aligned',
  lines: [
    [{ x: 1, y: 2.5 }, { x: 5, y: 2.5 }],
    [{ x: 1, y: 2.1 }, { x: 1, y: 2.7 }],
    [{ x: 5, y: 2.1 }, { x: 5, y: 2.7 }],
  ],
  ticks: [
    [{ x: 0.9, y: 2.4 }, { x: 1.1, y: 2.6 }],
    [{ x: 4.9, y: 2.4 }, { x: 5.1, y: 2.6 }],
  ],
  label: { position: { x: 3, y: 2.7 }, value: '4000', angle: 0, height: 0.25 },
  text: 'W <>',
  refA: 'IfcWall:2O2Fr$t4X7Zf8NOew3FL9r',
  refB: 'IfcWall:0Mh5r$t4X7Zf8NOew3FL9r',
  plane: '{"axis":"down","position":50,"flipped":false}',
};

function setup(maxId = 40) {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(maxId), view);
  const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
    'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
  ]).expressId;
  return { view, editor, contextId };
}

const entitiesOf = (view: MutablePropertyView) => new Map(view.getNewEntities().map((e) => [e.expressId, e]));
const ref = (value: unknown) => Number(String(value).slice(1));

function polylinePoints(entities: Map<number, NewEntity>, polylineId: number): Array<[number, number]> {
  const pointRefs = entities.get(polylineId)?.attributes[0] as string[];
  return pointRefs.map((r) => entities.get(ref(r))?.attributes[0] as [number, number]);
}

const namedQ = (view: MutablePropertyView, id: number): Record<string, number> => {
  const qto = view.getQuantitiesForEntity(id).find((s) => s.name === DRAWING_MARKUP_QSET_NAME);
  return Object.fromEntries((qto?.quantities ?? []).map((q) => [q.name, q.value]));
};

const namedP = (view: MutablePropertyView, id: number): Record<string, unknown> => {
  const pset = view.getForEntity(id).find((s) => s.name === DRAWING_MARKUP_PSET_NAME);
  return Object.fromEntries((pset?.properties ?? []).map((p) => [p.name, p.value]));
};

describe('addDimensionMarkupToStore', () => {
  it('pins the DIMENSION tag string', () => {
    expect(DRAWING_MARKUP_OBJECTTYPE.DIMENSION).toBe('IfcLite:Markup:Dimension');
  });

  it('emits an IfcAnnotation tagged DIMENSION whose items are a→b, the drawn lines, the ticks, then the text', () => {
    const { view, editor, contextId } = setup();
    const result = addDimensionMarkupToStore(editor, ANCHOR, contextId, DIM);
    const entities = entitiesOf(view);

    const annotation = entities.get(result.annotationId);
    expect(annotation?.type).toBe('IfcAnnotation');
    expect(annotation?.attributes[2]).toBe('Dimension');
    expect(annotation?.attributes[4]).toBe(DRAWING_MARKUP_OBJECTTYPE.DIMENSION);
    expect(annotation?.attributes[6]).toBe(`#${result.productShapeId}`);

    const shapeRep = entities.get(result.shapeRepId);
    expect(shapeRep?.attributes.slice(0, 3)).toEqual([`#${contextId}`, 'Annotation', 'Annotation2D']);
    expect(shapeRep?.attributes[3]).toEqual([...result.polylineIds, result.textLiteralId].map((id) => `#${id}`));

    expect(result.polylineIds).toHaveLength(1 + DIM.lines.length + DIM.ticks.length);
    expect(polylinePoints(entities, result.polylineIds[0])).toEqual([[1, 2], [5, 2]]);
    const drawn = [...DIM.lines, ...DIM.ticks];
    drawn.forEach(([p, q], i) => {
      expect(polylinePoints(entities, result.polylineIds[i + 1])).toEqual([[p.x, p.y], [q.x, q.y]]);
    });

    const literal = entities.get(result.textLiteralId);
    expect(literal?.type).toBe('IfcTextLiteralWithExtent');
    expect(literal?.attributes[0]).toBe('4000');
    expect(literal?.attributes[4]).toBe('center');
    const placement = entities.get(ref(literal?.attributes[1]));
    expect(entities.get(ref(placement?.attributes[0]))?.attributes[0]).toEqual([3, 2.7]);
    expect(entities.get(ref(placement?.attributes[1]))?.attributes[0]).toEqual([1, 0]);
  });

  it('stores the measured value as a LENGTH quantity and the dimension fields in the markup pset', () => {
    const { view, editor, contextId } = setup();
    const { annotationId } = addDimensionMarkupToStore(editor, ANCHOR, contextId, DIM);
    expect(namedQ(view, annotationId)).toEqual({ Distance: 4 });
    expect(namedP(view, annotationId)).toEqual({
      Offset: 0.5,
      Orientation: 'aligned',
      Text: 'W <>',
      RefA: DIM.refA,
      RefB: DIM.refB,
      Plane: DIM.plane,
    });
  });

  it('leaves optional pset fields out when they are absent', () => {
    const { view, editor, contextId } = setup();
    const { annotationId } = addDimensionMarkupToStore(editor, ANCHOR, contextId, {
      ...DIM, text: undefined, refA: undefined, refB: undefined, plane: undefined, orientation: 'vertical', offset: -1,
    });
    expect(namedP(view, annotationId)).toEqual({ Offset: -1, Orientation: 'vertical' });
  });

  it('writes every length in the native unit (millimetre model)', () => {
    const { view, editor, contextId } = setup();
    const mm: MarkupAnchor = { ...ANCHOR, lengthUnitScale: 0.001 };
    const result = addDimensionMarkupToStore(editor, mm, contextId, DIM);
    const entities = entitiesOf(view);
    expect(polylinePoints(entities, result.polylineIds[0])).toEqual([[1000, 2000], [5000, 2000]]);
    expect(polylinePoints(entities, result.polylineIds[1])).toEqual([[1000, 2500], [5000, 2500]]);
    expect(namedQ(view, result.annotationId).Distance).toBe(4000);
    expect(namedP(view, result.annotationId).Offset).toBe(500);
    const extent = entities.get(ref(entities.get(result.textLiteralId)?.attributes[3]));
    expect(extent?.attributes[1]).toBe(250);
  });

  it('rejects non-finite input before writing anything', () => {
    const bad: Array<[string, Partial<DimensionMarkupParams>]> = [
      ['a', { a: { x: NaN, y: 0 } }],
      ['distance', { distance: -1 }],
      ['offset', { offset: Infinity }],
      ['orientation', { orientation: 'diagonal' as never }],
      ['lines', { lines: [[{ x: 0, y: 0 }, { x: Infinity, y: 0 }]] }],
      ['ticks', { ticks: [[{ x: NaN, y: 0 }, { x: 0, y: 0 }]] }],
      ['label.angle', { label: { ...DIM.label, angle: NaN } }],
      ['label.height', { label: { ...DIM.label, height: -0.1 } }],
    ];
    for (const [label, patch] of bad) {
      const { view, editor, contextId } = setup();
      const before = view.getNewEntities().length;
      expect(() => addDimensionMarkupToStore(editor, ANCHOR, contextId, { ...DIM, ...patch }), label).toThrow(/addDimensionMarkupToStore/);
      expect(view.getNewEntities().length, label).toBe(before);
    }
  });

  it('is part of the batch, under the shared subcontext', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addDrawingMarkupToStore(editor, ANCHOR, ROOT_CONTEXT_ID, {
      measure2DResults: [{ id: 'm', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, distance: 1 }],
      dimensions2D: [{ id: 'd', ...DIM }],
    });
    expect(result.dimensions).toHaveLength(1);
    const shapeRep = entitiesOf(view).get(result.dimensions[0].shapeRepId);
    expect(shapeRep?.attributes[0]).toBe(`#${result.subContextId}`);
  });
});

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
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

describe('addDimensionMarkupToStore through StepExporter', () => {
  it('exports a schema-shaped annotation, quantity and property set', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STOREY_MODEL).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const view = new MutablePropertyView(null, 'm1');
    view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));
    const editor = new StoreEditor(store, view);
    addDrawingMarkupToStore(editor, resolveSpatialAnchor(store, 30), 7, { dimensions2D: [{ id: 'd', ...DIM }] });
    const out = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);

    expect(out).toMatch(/IFCANNOTATION\('.{22}',\$,'Dimension',\$,'IfcLite:Markup:Dimension',#\d+,#\d+\);/);
    expect(out).toMatch(/IFCSHAPEREPRESENTATION\(#\d+,'Annotation','Annotation2D',\((#\d+,){6}#\d+\)\);/);
    expect(out).toMatch(/IFCTEXTLITERALWITHEXTENT\('4000',#\d+,\.RIGHT\.,#\d+,'center'\);/);
    expect(out).toMatch(/IFCQUANTITYLENGTH\('Distance',\$,\$,4\.,\$\);/);
    expect(out).toMatch(/IFCPROPERTYSINGLEVALUE\('Offset',\$,IFCREAL\(0\.5\),\$\);/);
    expect(out).toMatch(/IFCPROPERTYSINGLEVALUE\('Orientation',\$,IFCLABEL\('aligned'\),\$\);/);
    expect(out).toContain(`IFCTEXT('{"axis":"down","position":50,"flipped":false}')`);
  });
});
