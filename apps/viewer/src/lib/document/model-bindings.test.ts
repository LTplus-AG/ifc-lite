/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { modelBindingPath } from './binding-path.js';
import { elementPropertyPaths, literalTemplateText, parsePath, renderTemplate, resolveBinding, templatePaths, type BindingContext } from './bindings.js';
import { parseDocumentFile } from './persistence.js';
import { DOCUMENT_VERSION } from './types.js';

const WALL = '0Wall00000000000000041';
async function model(id: string, name: string, project: string, rating: string): Promise<BindingContext['models'][number]> {
  // Deliberately identical GlobalIds in both files: a model-qualified field must disambiguate (#6485).
  const source = `ISO-10303-21;
HEADER; FILE_DESCRIPTION((''),'2;1'); FILE_NAME('t','',(''),(''),'','',''); FILE_SCHEMA(('IFC4')); ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'${project}',$,$,$,$,$,$);
#41=IFCWALL('${WALL}',$,'${project} wall',$,$,$,$,$,$);
${project === 'Structure' ? "#42=IFCWALL('0Wall00000000000000042',$,'Second wall',$,$,$,$,$,$);" : ''}
#50=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${rating}'),$);
#51=IFCPROPERTYSET('0Pset000000000000000051',$,'Pset_WallCommon',$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000052',$,$,$,(#41),#51);
ENDSEC; END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(source);
  return { id, name, store: await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
}

describe('model-qualified document fields (#6485)', () => {
  let context: BindingContext;
  before(async () => {
    context = { models: [await model('a', 'Architecture.ifc', 'Architecture', 'REI60'), await model('b', 'Structure.ifc', 'Structure', 'REI120')], activeModelId: 'a', today: new Date(2026, 8, 29) };
  });
  it('resolves project, count and duplicate-GUID properties from the selected model as the active model changes', () => {
    const project = modelBindingPath('Structure.ifc', 'IfcProject.Name');
    const property = modelBindingPath('Structure.ifc', `Element[${WALL}].Pset_WallCommon.FireRating`);
    for (const activeModelId of ['a', 'b']) {
      const current = { ...context, activeModelId };
      assert.equal(resolveBinding(project, current).value, 'Structure');
      assert.equal(resolveBinding(property, current).value, 'REI120');
      assert.equal(resolveBinding(modelBindingPath('Structure.ifc', 'Model.Name'), current).value, 'Structure.ifc');
      assert.equal(resolveBinding(modelBindingPath('Structure.ifc', 'Count[IfcWall]'), current).value, '2');
      assert.equal(resolveBinding(modelBindingPath('Structure.ifc', 'Model.Count'), current).value, '1');
      assert.equal(resolveBinding('Count[IfcWall]', current).value, '3', 'existing federation counts retain their scope');
    }
  });
  it('keeps named bindings after document export/import and reload under new session ids', () => {
    const text = `{${modelBindingPath('Structure.ifc', 'IfcProject.Name')}}`;
    const imported = parseDocumentFile(JSON.stringify({ version: DOCUMENT_VERSION, id: 'd', name: 'Report', page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 't', style: 'body', text }] }));
    assert.equal(imported.blocks[0].kind, 'text');
    if (imported.blocks[0].kind !== 'text') assert.fail('text block was not retained');
    assert.equal(renderTemplate(imported.blocks[0].text, { ...context, activeModelId: 'new-a', models: context.models.map((item) => ({ ...item, id: `new-${item.id}` })) }).text, 'Structure');
  });
  it('escapes literal braces while ordinary authored fields still resolve (#6612)', () => {
    const literal = 'nested{part{Today}}.ifc';
    const text = `${literalTemplateText(literal)} — {Model.Name}`;
    assert.deepEqual(templatePaths(text), ['Model.Name']);
    const rendered = renderTemplate(text, context);
    assert.equal(rendered.text, `${literal} — Architecture.ifc`);
    assert.equal(rendered.bindings.length, 1);
    assert.equal(rendered.bindings[0].ok, true);
  });
  it('reports absent and ambiguous models instead of falling back to the active model', () => {
    const path = modelBindingPath('Structure.ifc', 'IfcProject.Name');
    const missing = resolveBinding(path, { ...context, models: [context.models[0]] });
    assert.equal(missing.ok, false);
    assert.match(missing.reason ?? '', /not loaded/);
    const ambiguous = resolveBinding(path, { ...context, models: [context.models[1], { ...context.models[0], name: 'Structure.ifc' }] });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.reason ?? '', /ambiguous/);
  });
  it('reads property mutations from the scoped model and offers the same effective property path', () => {
    const target = context.models[1];
    const view = new MutablePropertyView(target.store.properties, target.id);
    view.setProperty(41, 'Pset_WallCommon', 'FireRating', 'REI180');
    const scoped = { ...context, models: [context.models[0], { ...target, view }] };
    const path = `Element[${WALL}].Pset_WallCommon.FireRating`;
    assert.ok(elementPropertyPaths(WALL, { ...scoped, models: [scoped.models[1]] }).some((option) => option.path === path));
    assert.equal(resolveBinding(modelBindingPath(target.name, path), scoped).value, 'REI180');
    assert.equal(resolveBinding(path, scoped).value, 'REI60');
  });
  it('roundtrips model names containing dots, brackets, quotes and template braces', () => {
    const name = 'Structure ["rev.2"] {final}.ifc';
    const path = modelBindingPath(name, 'IfcProject.Name');
    const rendered = renderTemplate(`{${path}}`, { ...context, models: [{ ...context.models[1], name }] });
    assert.equal(rendered.text, 'Structure');
    assert.equal(rendered.bindings[0].ok, true);
  });
  it('preserves literal backslashes in existing quoted spatial selectors while decoding the new model selector', () => {
    for (const name of ['Level \\North', 'Level \\n']) {
      const legacy = `IfcBuildingStorey["${name}"].Elevation`;
      assert.equal(parsePath(legacy)?.[0].selector, name, 'a saved storey selector remains literal');
      const scoped = modelBindingPath('Structure \\North.ifc', legacy);
      const parsed = parsePath(scoped);
      assert.equal(parsed?.[0].selector, 'Structure \\North.ifc');
      assert.equal(parsed?.[1].selector, name, 'model qualification preserves the existing inner selector');
    }
  });
});
