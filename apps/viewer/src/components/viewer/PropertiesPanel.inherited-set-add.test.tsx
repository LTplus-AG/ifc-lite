/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5966: adding a property to a set the element only INHERITS from its type
 * used to create a one-property set of that name on the element. Tools that
 * let an occurrence set replace the type's set then showed the set losing its
 * other properties. The new occurrence set now carries the type's properties
 * forward; the type's own set is untouched.
 *
 * Real parsed store, real `PropertiesPanel`, real "Add property" dialog, real
 * "Export changes" STEP path (re-parsed), real Ctrl+Z.
 */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, click, render, type } from '@/test/render.js';
import { useViewerStore, type ViewerState } from '@/store';
import { extractPropertiesOnDemand, extractTypeEntityOwnProperties, type IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { addToPropertySet } from '@/lib/properties/add-to-property-set';
import { exportAndReparse, fileRows, panelRows, parseStep, seedModel } from '@/test/properties-panel-harness.js';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'm1';
const ID_OFFSET = 1_000_000;
const WALL = 72;
const WALL_TYPE = 90;

const guid = (mnemonic: string): string => (mnemonic + '0'.repeat(22)).slice(0, 22);

// Wall #72 carries two custom psets from the file (Custom_A: A1, A2 and
// Custom_B: B1). Its type #90 owns Custom_T (T1, T2) through HasPropertySets.
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSINGLEVALUE('A1',$,IFCLABEL('a1'),$);
#82= IFCPROPERTYSINGLEVALUE('A2',$,IFCLABEL('a2'),$);
#80= IFCPROPERTYSET('${guid('PSA')}',$,'Custom_A',$,(#81,#82));
#83= IFCRELDEFINESBYPROPERTIES('${guid('RDA')}',$,$,$,(#72),#80);
#85= IFCPROPERTYSINGLEVALUE('B1',$,IFCLABEL('b1'),$);
#84= IFCPROPERTYSET('${guid('PSB')}',$,'Custom_B',$,(#85));
#86= IFCRELDEFINESBYPROPERTIES('${guid('RDB')}',$,$,$,(#72),#84);
#90= IFCWALLTYPE('${guid('WTYP')}',$,'WT',$,$,(#91),$,$,$,.STANDARD.);
#92= IFCPROPERTYSINGLEVALUE('T1',$,IFCLABEL('t1'),$);
#93= IFCPROPERTYSINGLEVALUE('T2',$,IFCLABEL('t2'),$);
#95= IFCPROPERTYSINGLEVALUE('TW',$,IFCLENGTHMEASURE(0.2),$);
#91= IFCPROPERTYSET('${guid('PST')}',$,'Custom_T',$,(#92,#93,#95));
#94= IFCRELDEFINESBYTYPE('${guid('RDT')}',$,$,$,(#72),#90);
ENDSEC;
END-ISO-10303-21;
`;

const TYPE_ROWS = ['90:Custom_T:T1', '90:Custom_T:T2', '90:Custom_T:TW'];

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.body.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(input, `input "${placeholder}" must render`);
  return input as HTMLInputElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `button "${text}" must render`);
  return button as HTMLButtonElement;
}

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('Adding to a type-inherited set overrides it with every property (#5966)', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(() => { cleanup(); useViewerStore.setState(initialState, true); });

  async function mountWall(): Promise<{ container: HTMLElement; full: IfcDataStore }> {
    const full = await parseStep(MODEL);
    seedModel(MODEL_ID, ID_OFFSET, full, WALL);
    const container = render(<PropertiesPanel />);
    await advance(0);
    return { container, full };
  }

  it('the dialog says the set is inherited, and the export carries T1, T2 and T3 on the wall', async () => {
    const { container, full } = await mountWall();
    // Every write of the override reaches collab peers (createPropertySet is not mirrored).
    const mirrored: string[] = [];
    const mirror: ViewerState['mirrorPropertyEdit'] = (_m, id, pset, prop) => { mirrored.push(`${id}:${pset}:${prop}`); };
    useViewerStore.setState({ mirrorPropertyEdit: mirror });
    const trigger = container.querySelector('button[aria-label="Add property"]');
    assert.ok(trigger);
    click(trigger);
    await advance(0);
    click(buttonByText('Custom name'));
    await advance(0);
    type(inputByPlaceholder('e.g., Pset_MyCustomProperties'), 'Custom_T');
    await advance(0);
    assert.match(document.body.textContent ?? '', /Custom_T is inherited from WT/, 'the dialog makes the target explicit');
    type(inputByPlaceholder('e.g., FireRating'), 'T3');
    type(inputByPlaceholder('Property value'), 't3');
    await advance(0);
    click(buttonByText('Add Property'));
    await advance(0);

    assert.deepEqual(panelRows(container), [
      '72:Custom_A:A1', '72:Custom_A:A2', '72:Custom_B:B1',
      '72:Custom_T:T1', '72:Custom_T:T2', '72:Custom_T:T3', '72:Custom_T:TW', ...TYPE_ROWS,
    ]);
    const reparsed = await exportAndReparse(MODEL_ID, full);
    assert.deepEqual(fileRows(extractPropertiesOnDemand(reparsed, WALL)), [
      'Custom_A.A1=a1', 'Custom_A.A2=a2', 'Custom_B.B1=b1',
      'Custom_T.T1=t1', 'Custom_T.T2=t2', 'Custom_T.T3=t3', 'Custom_T.TW=0.2',
    ]);
    const tw = extractPropertiesOnDemand(reparsed, WALL).find((p) => p.name === 'Custom_T')?.properties.find((p) => p.name === 'TW');
    assert.match(String(tw?.dataType), /^IFCLENGTHMEASURE$/i, 'a carried measure keeps its IFC data type');
    assert.deepEqual(fileRows(extractTypeEntityOwnProperties(reparsed, WALL_TYPE)), ['Custom_T.T1=t1', 'Custom_T.T2=t2', 'Custom_T.TW=0.2'], 'the type set is untouched');

    assert.deepEqual(mirrored.sort(), ['72:Custom_T:T1', '72:Custom_T:T2', '72:Custom_T:T3', '72:Custom_T:TW']);

    // One Ctrl+Z removes the whole override.
    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    await advance(0);
    assert.deepEqual(panelRows(container), ['72:Custom_A:A1', '72:Custom_A:A2', '72:Custom_B:B1', ...TYPE_ROWS]);
  });

  it('a multi-property add (the bSDD card\'s shape) carries forward only what it does not set', async () => {
    const { container } = await mountWall();
    addToPropertySet(useViewerStore.getState(), {
      modelId: MODEL_ID, entityId: WALL,
      existingPsets: ['Custom_A', 'Custom_B', 'Custom_T'],
      inheritedFrom: { typeId: WALL_TYPE, typeName: 'WT', psetNames: ['Custom_T'] },
    }, 'Custom_T', [
      { name: 'T2', value: 'mine', type: PropertyValueType.Label },
      { name: 'T4', value: 't4', type: PropertyValueType.Label },
    ]);
    useViewerStore.getState().bumpMutationVersion();
    await advance(0);
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    const set = view.getForEntity(WALL).find((p) => p.name === 'Custom_T');
    assert.deepEqual(set?.properties.map((p) => `${p.name}=${String(p.value)}`).sort(), ['T1=t1', 'T2=mine', 'T4=t4', 'TW=0.2']);
    assert.ok(panelRows(container).includes('90:Custom_T:T2'));
  });

  it('the bSDD card\'s "add all" on an inherited set carries the type\'s properties too', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      uri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall', code: 'IfcWall', name: 'IfcWall',
      classProperties: [{ name: 'T5', propertyCode: 'T5', dataType: 'IfcLabel', propertySet: 'Custom_T', units: null }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const full = await parseStep(MODEL);
      seedModel(MODEL_ID, ID_OFFSET, full, WALL);
      useViewerStore.setState({ propertiesActiveTab: 'bsdd' });
      render(<PropertiesPanel />);
      await advance(50);
      const header = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom_T'));
      assert.ok(header, 'the bSDD card lists the Custom_T group');
      const addAll = header!.querySelector('svg.lucide-plus')?.closest('button');
      assert.ok(addAll, 'the group offers "add all"');
      click(addAll!);
      await advance(0);

      const reparsed = await exportAndReparse(MODEL_ID, full);
      assert.deepEqual(fileRows(extractPropertiesOnDemand(reparsed, WALL)).filter((r) => r.startsWith('Custom_T.')).map((r) => r.split('=')[0]),
        ['Custom_T.T1', 'Custom_T.T2', 'Custom_T.T5', 'Custom_T.TW']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('an IFC2X3 door style\'s set is carried too (a type object not named *Type)', async () => {
    const store = await parseStep(DOOR_STYLE_MODEL);
    seedModel(MODEL_ID, ID_OFFSET, store, 10);
    const container = render(<PropertiesPanel />);
    await advance(0);
    assert.deepEqual(panelRows(container), ['20:Custom_S:S1']);
    addToPropertySet(useViewerStore.getState(), {
      modelId: MODEL_ID, entityId: 10, existingPsets: ['Custom_S'],
      inheritedFrom: { typeId: 20, typeName: 'DS', psetNames: ['Custom_S'] },
    }, 'Custom_S', [{ name: 'S2', value: 's2', type: PropertyValueType.Label }]);
    const set = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getForEntity(10).find((p) => p.name === 'Custom_S');
    assert.deepEqual(set?.properties.map((p) => p.name).sort(), ['S1', 'S2']);
  });

  it('refuses, with nothing written, a set holding a property it cannot copy exactly', async () => {
    const withEnum = MODEL
      .replace(`#90= IFCWALLTYPE('${guid('WTYP')}',$,'WT',$,$,(#91),$,$,$,.STANDARD.);`,
        `#90= IFCWALLTYPE('${guid('WTYP')}',$,'WT',$,$,(#91,#97),$,$,$,.STANDARD.);\n#96= IFCPROPERTYENUMERATEDVALUE('TE',$,(IFCLABEL('A'),IFCLABEL('B')),$);\n#97= IFCPROPERTYSET('${guid('PSE')}',$,'Custom_E',$,(#96));`);
    const full = await parseStep(withEnum);
    seedModel(MODEL_ID, ID_OFFSET, full, WALL);
    const container = render(<PropertiesPanel />);
    await advance(0);
    assert.ok(panelRows(container).includes('90:Custom_E:TE'), 'fixture sanity: the type carries the enumerated set');
    const result = addToPropertySet(useViewerStore.getState(), {
      modelId: MODEL_ID, entityId: WALL, existingPsets: ['Custom_A', 'Custom_B', 'Custom_T', 'Custom_E'],
      inheritedFrom: { typeId: WALL_TYPE, typeName: 'WT', psetNames: ['Custom_T', 'Custom_E'] },
    }, 'Custom_E', [{ name: 'X', value: 'x', type: PropertyValueType.Label }]);
    assert.deepEqual(result, { ok: false, uncopyable: ['TE'] });
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    assert.equal(view.getForEntity(WALL).some((p) => p.name === 'Custom_E'), false, 'nothing is written on the wall');
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0, 0);
  });
});

const DOOR_STYLE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('d','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,$,$);
#10= IFCDOOR('${guid('DOOR')}',$,'Door',$,$,$,$,$,1.,1.);
#21= IFCPROPERTYSINGLEVALUE('S1',$,IFCLABEL('s1'),$);
#22= IFCPROPERTYSET('${guid('PSS')}',$,'Custom_S',$,(#21));
#20= IFCDOORSTYLE('${guid('DSTY')}',$,'DS',$,$,(#22),$,$,.SINGLE_SWING_LEFT.,.NOTDEFINED.,.F.,.F.);
#30= IFCRELDEFINESBYTYPE('${guid('RDT')}',$,$,$,(#10),#20);
ENDSEC;
END-ISO-10303-21;
`;
