/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5864: the Bulk editor's class targets matched class NAMES by substring,
 * so "Wall" also selected IfcCurtainWall and the IfcWallType type object
 * (and "Stair" selected IfcStairFlight). A target now selects its exact
 * class plus that class's schema subtypes (IfcWallStandardCase under IfcWall).
 *
 * Drives the real dialog over a fixture store, then reads the entities a run
 * actually wrote to.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { BulkPropertyEditor } from './BulkPropertyEditor.js';
// A namespace import: with the fix reverted `classTargetEnums` is absent, and
// the helper test must fail on an assertion rather than on a missing export.
import * as options from './bulk-property-editor-options.js';

const PSET = 'Pset_Test';
const PROP = 'Foo';

const ENTITIES = [
  { expressId: 1, type: 'IfcWall', name: 'Wall' },
  { expressId: 2, type: 'IfcWallStandardCase', name: 'Standard wall' },
  { expressId: 3, type: 'IfcCurtainWall', name: 'Curtain wall' },
  { expressId: 4, type: 'IfcWallType', name: 'Wall type' },
  { expressId: 5, type: 'IfcStair', name: 'Stair' },
  { expressId: 6, type: 'IfcStairFlight', name: 'Flight' },
];

// A real parse: class targets resolve through the EntityTable's type enums,
// which the lightweight fixture store does not populate.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('classes.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#2=IFCWALLSTANDARDCASE('0Wall00000000000000002',$,'Standard wall',$,$,$,$,$,$);
#3=IFCCURTAINWALL('0Wall00000000000000003',$,'Curtain wall',$,$,$,$,$,$);
#4=IFCWALLTYPE('0Wall00000000000000004',$,'Wall type',$,$,$,$,$,$,.STANDARD.);
#5=IFCSTAIR('0Stair0000000000000005',$,'Stair',$,$,$,$,$,$);
#6=IFCSTAIRFLIGHT('0Stair0000000000000006',$,'Flight',$,$,$,$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

let parsed: Promise<IfcDataStore> | null = null;
function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  parsed ??= new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return parsed;
}

async function seed(modelIds: readonly string[]): Promise<void> {
  const store = await parse();
  useViewerStore.setState({
    ...fixtureModels(...modelIds.map((id, i) => ({ ...fixtureModel(id, { idOffset: i * 1_000_000 }), ifcDataStore: store }))),
    mutationViews: new Map(),
    mutationVersion: 0,
    collabRole: null,
  });
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const input = (placeholder: string) =>
  [...document.body.querySelectorAll('input')].find((i) => i.placeholder === placeholder) as HTMLInputElement;
const button = (match: (text: string) => boolean) =>
  [...document.body.querySelectorAll('button')].find((b) => match(b.textContent?.trim() ?? '')) as HTMLButtonElement | undefined;

/** Open the dialog, pick one class target, set Pset_Test.Foo = X, run it; returns the ids written. */
async function runOnClass(label: string, modelId: string): Promise<number[]> {
  const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
  click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Open')!);
  await advance(0);
  await advance(0);
  // The class targets are clickable badges (not buttons) today.
  const chip = [...document.body.querySelectorAll<HTMLElement>('.cursor-pointer')].find((el) => el.textContent?.trim() === label);
  assert.ok(chip, `the "${label}" class target must render`);
  click(chip!);
  setNativeValue(input('e.g., Pset_WallCommon'), PSET);
  setNativeValue(input('e.g., FireRating'), PROP);
  setNativeValue(input('Value'), 'X');
  await advance(250);
  const apply = button((text) => text.startsWith('Apply to'));
  assert.ok(apply && !apply.disabled, 'Apply must be enabled');
  click(apply!);
  await advance(0);
  await advance(0);
  const view = useViewerStore.getState().mutationViews.get(modelId)!;
  return ENTITIES.map((e) => e.expressId).filter((id) => view.getPropertyValue(id, PSET, PROP) === 'X');
}

describe('Bulk editor class targets are exact classes (#5864)', () => {
  afterEach(() => cleanup());

  it('"Wall" writes IfcWall and IfcWallStandardCase, never IfcCurtainWall or IfcWallType', async () => {
    await seed(['m']);
    assert.deepEqual(await runOnClass('Wall', 'm'), [1, 2]);
  });

  it('"Stair" does not sweep in IfcStairFlight', async () => {
    await seed(['m']);
    assert.deepEqual(await runOnClass('Stair', 'm'), [5]);
  });

  it('is the same with two federated models (targets the selected model only)', async () => {
    await seed(['a', 'b']);
    assert.deepEqual(await runOnClass('Wall', 'a'), [1, 2]);
    assert.equal(useViewerStore.getState().mutationViews.get('b'), undefined, 'model b is untouched');
  });

  it('classTargetEnums matches by schema inheritance, not by name', () => {
    const { classTargetEnums } = options as Partial<typeof options>;
    assert.equal(typeof classTargetEnums, 'function', 'bulk-property-editor-options exports classTargetEnums (#5864)');
    if (!classTargetEnums) return;
    const present = new Map([[1, 'IfcWall'], [2, 'IfcWallStandardCase'], [3, 'IfcCurtainWall'], [4, 'IfcWallType'], [5, 'IfcFurniture']]);
    assert.deepEqual(classTargetEnums('IfcWall', present), [1, 2]);
    assert.deepEqual(classTargetEnums('IfcCurtainWall', present), [3]);
    // An IFC4 subtype the old "Furnishing" substring never reached.
    assert.deepEqual(classTargetEnums('IfcFurnishingElement', present), [5]);
  });
});
