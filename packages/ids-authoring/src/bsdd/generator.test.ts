/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dictionary → IDS (IDS-072) on the recorded test dictionary: tree,
 * inheritance, scope options, preview, one-transaction apply, and an
 * audit- and lint-clean result.
 */

import { auditIDSDocument, parseIDS } from '@ifc-lite/ids';
import { writeIdsXml } from '@ifc-lite/rules';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO, demoClass, demoSource } from '../../test/bsdd/replay.js';
import { counterIds } from '../../test/corpus.js';
import { createStudioDocument } from '../document/from-ids.js';
import { commit, createStudioState, undo } from '../history/history.js';
import { createLintContext } from '../lint/context.js';
import type { LintContext } from '../lint/types.js';
import { buildClassTree, effectiveProperties, loadClassesWithAncestors } from './dictionary.js';
import { planDictionaryIds, previewDictionaryIds, type DictionaryIdsOptions } from './generator.js';
import type { BsddClass, BsddClassSummary, BsddDictionary } from './types.js';

let lint: LintContext;
let dictionary: BsddDictionary;
let rows: BsddClassSummary[];
let classes: Map<string, BsddClass>;
beforeAll(async () => {
  lint = await createLintContext();
  const src = demoSource();
  const dict = await src.getDictionary(DEMO);
  if (!dict) throw new Error('fixture dictionary missing');
  dictionary = dict;
  rows = await src.listClasses(DEMO);
  classes = (await loadClassesWithAncestors(src, rows.map((r) => r.uri))).classes;
});

const plan = (options: Partial<DictionaryIdsOptions> = {}, selected = rows.map((r) => r.uri)) =>
  planDictionaryIds({ dictionary, classes, selected, options: { ifcVersions: ['IFC4'], ...options }, gate: lint.gate, newId: counterIds(0xd1c7) });

describe('dictionary tree and hierarchy', () => {
  it('builds the parent/child tree from the flat class list', () => {
    const tree = buildClassTree(rows);
    expect(tree.map((n) => [n.code, n.children.map((c) => `${c.code}@${c.depth}`)])).toEqual([
      ['WAL', ['WAL-EXT@1', 'WAL-INT@1', 'WAL-PRT@1']],
      ['DOR', []],
      ['SHD', []],
    ]);
  });

  it('survives a parent cycle and a missing parent', () => {
    const row = (code: string, parentClassCode?: string): BsddClassSummary => ({ uri: `${DEMO}/class/${code}`, code, name: code, dictionaryUri: DEMO, relatedIfcEntityNames: [], ...(parentClassCode ? { parentClassCode } : {}) });
    const tree = buildClassTree([row('A', 'B'), row('B', 'A'), row('C', 'A'), row('D', 'ZZZ')]);
    expect(tree.map((n) => n.code).sort()).toEqual(['A', 'B', 'D']);
    expect(tree.find((n) => n.code === 'A')?.children.map((c) => c.code)).toEqual(['C']);
  });

  it('loads ancestors for inheritance, reports unknown classes, and respects the budget', async () => {
    const src = demoSource();
    const got = await loadClassesWithAncestors(src, [demoClass('WAL-EXT'), demoClass('GONE')]);
    expect([...got.classes.keys()]).toEqual([demoClass('WAL-EXT'), demoClass('WAL')]);
    expect(got.missing).toEqual([demoClass('GONE')]);
    expect((await loadClassesWithAncestors(src, [demoClass('WAL-EXT')], { maxClasses: 1 })).truncated).toBe(true);
  });

  it('inherits parent properties; a redefined property overrides the parent’s', () => {
    const ext = classes.get(demoClass('WAL-EXT'));
    if (!ext) throw new Error('fixture missing');
    const props = effectiveProperties(ext, classes);
    expect(props.map((p) => `${p.propertySet}.${p.code}`)).toEqual([
      'Demo_Wall.LoadBearing',
      'Demo_Wall.FireRating',
      'Demo_Wall.Thickness',
      'Demo_Wall.ThermalTransmittance',
      'Pset_WallCommon.IsExternal',
    ]);
    expect(props[0].isRequired).toBe(false); // the external wall's own definition
  });
});

describe('planDictionaryIds', () => {
  it('one spec per class: inherited properties, inactive classes and set-less properties skipped with notes', () => {
    const p = plan();
    expect(p.specs.map((s) => [s.name, s.entities, s.properties.length])).toEqual([
      ['Wall (WAL)', ['IfcWall'], 3],
      ['External wall (WAL-EXT)', ['IfcWall'], 5],
      ['Internal wall (WAL-INT)', ['IfcWall'], 3],
      ['Door (DOR)', ['IfcDoor'], 6],
      ['Shading device (SHD)', ['IfcShadingDevice', 'IfcWindow'], 1],
    ]);
    expect(p.notes).toEqual([
      'WAL-PRT: inactive in bSDD; skipped',
      'DOR.SurfaceFinish: bSDD property SurfaceFinish: an optional requirement needs a dataType in IDS 1.0 and none maps; require it or leave it out; skipped',
      'DOR.Manufacturer: bSDD property Manufacturer has no property set; choose one; skipped',
    ]);
    expect(plan({ inheritProperties: false }).specs.find((s) => s.classCodes[0] === 'WAL-INT')?.properties).toEqual([]);
    expect(plan({ propertyScope: 'required' }).specs[0].properties).toEqual(['LoadBearing', 'FireRating']);
    expect(plan({ fallbackPropertySet: 'Project_Common' }).specs.find((s) => s.classCodes[0] === 'DOR')?.properties).toContain('Manufacturer');
  });

  it('one spec per entity: classification enumeration and only the properties every class shares', () => {
    const p = plan({ grouping: 'perEntity' });
    expect(p.specs.map((s) => [s.name, s.classCodes, s.properties])).toEqual([
      ['IfcWall (Demo Elements)', ['WAL', 'WAL-EXT', 'WAL-INT'], ['LoadBearing', 'FireRating', 'Thickness']],
      ['IfcDoor (Demo Elements)', ['DOR'], ['FireExit', 'ClearWidth', 'LeafCount', 'InstallationDate', 'Grade', 'Accessories']],
      ['IfcShadingDevice (Demo Elements)', ['SHD'], ['SolarFactor']],
    ]);
    expect(p.notes).toContain('SHD: grouped under IfcShadingDevice, its first related entity');
  });

  it('drops related entities that do not exist in the target versions', () => {
    const p = plan({ ifcVersions: ['IFC2X3'] }, [demoClass('SHD')]);
    expect(p.specs[0].entities).toEqual(['IfcWindow']);
    expect(p.notes).toEqual(['SHD: related entity IfcShadingDevice does not exist in IFC2X3; left out']);
  });
});

describe('preview and apply', () => {
  it('previews counts and lint on a dry run, then applies as ONE undoable transaction', () => {
    const doc = createStudioDocument({ title: 'Demo Elements requirements', newId: counterIds(0xd0c) });
    const p = plan();
    const preview = previewDictionaryIds(doc, p, lint);
    expect(preview.gate).toEqual({ ok: true, issues: [] });
    expect([preview.specCount, preview.applicabilityFacets, preview.requirements]).toEqual([5, 10, 18]);
    expect(preview.lint).toMatchObject({ error: 0, warning: 0, byCode: { 'IDSL-ENT-003': 5 } }); // info: IfcWall also has IfcWallStandardCase, …
    expect(preview.result?.ids.specifications.every((s) => s.minOccurs === 0)).toBe(true); // optional by default
    expect(previewDictionaryIds(doc, plan({ cardinality: 'required' }), lint).lint.byCode['IDSL-CARD-004']).toBe(5);
    expect(doc.ids.specifications).toEqual([]); // the dry run left the document alone
    const state = commit(createStudioState(doc), p.ops, { source: { by: 'import', format: 'bsdd', ref: DEMO } }).state;
    expect(state.doc).toEqual(preview.result);
    expect(state.history.past).toHaveLength(1);
    expect(undo(state).doc).toEqual(doc);
  });

  it('the generated IDS is audit-clean and lint-clean (no errors, no warnings) and round-trips through XML', async () => {
    const doc = createStudioDocument({ title: 'Demo Elements requirements', newId: counterIds(0xd0d) });
    const preview = previewDictionaryIds(doc, plan({ fallbackPropertySet: 'Project_Common' }), lint);
    if (!preview.result) throw new Error(JSON.stringify(preview.gate.issues));
    expect(preview.lint.error + preview.lint.warning, JSON.stringify(preview.lint.byCode)).toBe(0);
    const xml = writeIdsXml(preview.result.ids);
    const audit = await auditIDSDocument(xml);
    expect(audit.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const reread = parseIDS(xml);
    expect(reread.specifications.map((s) => s.requirements.length)).toEqual(preview.result.ids.specifications.map((s) => s.requirements.length));
    expect(reread.specifications[1].requirements.find((r) => r.facet.type === 'property' && r.facet.uri)?.facet).toMatchObject({ uri: expect.stringContaining('/prop/') });
  });
});
