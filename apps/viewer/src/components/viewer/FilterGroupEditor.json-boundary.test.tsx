/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { Rule, isFilterRule } from '@ifc-lite/rules';
import { loadSavedFilters, saveFilter, __internal } from '@/lib/search/saved-filters';
import { decodeArtifactLibraries } from '@/lib/storage/artifact-backup';
import { legacyCriteriaToFilterGroups } from '@/lib/lens/legacy-criteria-to-filter-groups';
import { FilterGroupEditor } from './FilterGroupEditor';

const broken = { name: 'A malformed material', schemaVersion: 2, updatedAt: 1,
  groups: [{ combinator: 'AND', rules: [{ kind: 'material', op: 'contains' }] }] };
const numeric = { name: 'Z valid numeric', schemaVersion: 2, updatedAt: 1,
  groups: [{ combinator: 'AND', rules: [Rule.quantity('Qto_WallBaseQuantities', 'Height', 'gt', 2.5)] }] };
function editor(groups: Parameters<typeof FilterGroupEditor>[0]['groups']): HTMLElement {
  return render(<FilterGroupEditor groups={groups} activeGroup={0} models={[]} onChange={() => {
    throw new Error('This boundary fixture does not edit its query');
  }} />);
}

describe('saved/imported JSON reaches the real group editor safely (#7554)', () => {
  beforeEach(() => {
    localStorage.clear();
    useViewerStore.setState({ ...fixtureModels(fixtureModel('m1')) });
  });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it('refuses the malformed grouped preset before its operand reaches ComboInput, preserving the original catalog', () => {
    const original = JSON.stringify([broken, numeric]);
    localStorage.setItem(__internal.STORAGE_KEY, original);
    const presets = loadSavedFilters();
    const first = presets[0];
    assert.ok(first, 'the independently valid preset remains available');
    // Old code accepts A malformed material first: this actual editor then
    // throws value.trim(), rather than testing a cast or a mocked guard.
    const ui = editor(first.groups);
    assert.deepEqual(presets.map(preset => preset.name), ['Z valid numeric']);
    assert.ok([...ui.querySelectorAll<HTMLInputElement>('input')].some(input => input.value === '2.5'));
    assert.equal(saveFilter('Another valid preset', [{ combinator: 'AND', rules: [Rule.material('contains', 'Concrete')] }]).persisted, false);
    assert.equal(localStorage.getItem(__internal.STORAGE_KEY), original, 'refusal must not erase unreadable saved content');
  });

  it('backup import rejects the whole malformed filter and a valid numeric import mounts unmodified', () => {
    const malformed: Record<string, unknown> = JSON.parse(JSON.stringify({ filters: [broken] }));
    assert.throws(() => decodeArtifactLibraries(malformed), /Invalid or unsupported saved filter/);
    const valid: Record<string, unknown> = JSON.parse(JSON.stringify({ filters: [numeric] }));
    const imported = decodeArtifactLibraries(valid).filters?.[0];
    assert.ok(imported);
    const ui = editor(imported.groups);
    assert.ok([...ui.querySelectorAll<HTMLInputElement>('input')].some(input => input.value === '2.5'));
    assert.deepEqual(imported.groups, numeric.groups);
  });

  it('keeps native v1 per-rule refusal and legitimate omitted legacy Lens existence operands', () => {
    localStorage.setItem(__internal.STORAGE_KEY, JSON.stringify([{ name: 'Native v1', combinator: 'OR',
      rules: [{ kind: 'material', op: 'contains' }, Rule.material('contains', '')] }]));
    const native = loadSavedFilters()[0];
    assert.ok(native);
    assert.deepEqual(native.groups, [{ combinator: 'OR', rules: [Rule.material('contains', '')] }]);
    const converted = legacyCriteriaToFilterGroups({ type: 'property', propertySet: 'Pset_WallCommon',
      propertyName: 'FireRating', operator: 'exists' });
    assert.equal(converted.status, 'readable');
    const rule = converted.groups[0]?.rules[0];
    assert.ok(rule && isFilterRule(rule));
    assert.equal(rule.kind, 'property');
    if (rule.kind !== 'property') throw new Error('Expected the legacy property rule');
    assert.equal(rule.value, '');
    assert.equal(rule.op, 'isNotNull');
    assert.ok(editor(converted.groups).querySelector('input'), 'the normalized legacy rule renders in the real editor');
  });
});
