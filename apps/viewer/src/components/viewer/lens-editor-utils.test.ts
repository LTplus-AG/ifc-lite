/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildAutoColorLensToSave,
  duplicateLensConfig,
  mergeImportedLenses,
  moveItem,
  reserveUniqueId,
} from './lens-editor-utils.js';
import type { Lens } from '@/store/slices/lensSlice';

const ruleLens: Lens = {
  id: 'lens-envelope',
  name: 'Building Envelope',
  builtin: true,
  rules: [
    { id: 'wall', name: 'Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#111111' },
    { id: 'roof', name: 'Roofs', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcRoof' }, action: 'colorize', color: '#222222' },
  ],
};

describe('buildAutoColorLensToSave (#1365)', () => {
  it('preserves the existing id when editing a saved lens (so rename updates in place)', () => {
    let generated = false;
    const lens = buildAutoColorLensToSave(
      { id: 'lens-auto-123' },
      { name: 'Renamed lens', autoColor: { source: 'ifcType' } },
      () => { generated = true; return 'lens-auto-SHOULD-NOT-BE-USED'; },
    );

    assert.equal(lens.id, 'lens-auto-123', 'editing must keep the original id');
    assert.equal(generated, false, 'must not generate a new id when editing');
    assert.equal(lens.name, 'Renamed lens');
    assert.deepEqual(lens.autoColor, { source: 'ifcType' });
    assert.deepEqual(lens.rules, []);
  });

  it('mints a fresh id only when creating a new lens (no initial id)', () => {
    const lens = buildAutoColorLensToSave(
      {},
      { name: 'Color by IFC Class', autoColor: { source: 'property', psetName: 'Pset_X', propertyName: 'P' } },
      () => 'lens-auto-FRESH',
    );

    assert.equal(lens.id, 'lens-auto-FRESH');
    assert.equal(lens.name, 'Color by IFC Class');
    assert.deepEqual(lens.autoColor, { source: 'property', psetName: 'Pset_X', propertyName: 'P' });
  });
});

describe('duplicateLensConfig (#1403)', () => {
  it('makes an editable, deletable copy of a built-in (drops builtin flag, fresh id, "(copy)" name)', () => {
    const copy = duplicateLensConfig(ruleLens, () => 'lens-NEW');
    assert.equal(copy.id, 'lens-NEW');
    assert.equal(copy.name, 'Building Envelope (copy)');
    assert.equal(copy.builtin, undefined, 'copy must not be a builtin');
    assert.equal(copy.rules.length, 2);
  });

  it('regenerates rule ids and clones criteria so editing the copy never mutates the source', () => {
    const copy = duplicateLensConfig(ruleLens, () => 'lens-NEW');
    assert.deepEqual(copy.rules.map((r) => r.id), ['lens-NEW-rule-0', 'lens-NEW-rule-1']);
    // Mutating the copy's first criteria must not affect the source.
    copy.rules[0].criteria.ifcType = 'IfcSlab';
    assert.equal(ruleLens.rules[0].criteria.ifcType, 'IfcWall');
  });

  it('carries the autoColor spec for auto-color lenses', () => {
    const auto: Lens = { id: 'lens-by-class', name: 'By IFC Class', builtin: true, rules: [], autoColor: { source: 'ifcType' } };
    const copy = duplicateLensConfig(auto, () => 'lens-NEW');
    assert.deepEqual(copy.autoColor, { source: 'ifcType' });
    assert.equal(copy.builtin, undefined);
  });
});

describe('mergeImportedLenses (#1403)', () => {
  const existing: Lens[] = [
    { id: 'lens-envelope', name: 'Building Envelope', builtin: true, rules: [] },
    { id: 'custom-1', name: 'My Lens', rules: [] },
  ];

  it('upserts by id: re-importing the same ids updates in place instead of doing nothing', () => {
    // Round-trip: an edited export carries the existing ids.
    const imported = [
      { id: 'lens-envelope', name: 'Building Envelope', rules: ruleLens.rules },
      { id: 'custom-1', name: 'My Lens Renamed', rules: [] },
    ];
    const next = mergeImportedLenses(existing, imported, (i) => `gen-${i}`);
    assert.equal(next.length, 2, 'no duplicates created on re-import');
    assert.equal(next[0].name, 'Building Envelope');
    assert.equal(next[0].rules.length, 2, 'builtin override picked up the edited rules');
    assert.equal(next[0].builtin, true, 'replacing a builtin preserves the builtin flag');
    assert.equal(next[1].name, 'My Lens Renamed', 'custom lens updated in place');
  });

  it('appends lenses with new ids, keeping existing order', () => {
    const next = mergeImportedLenses(existing, [{ id: 'custom-2', name: 'New', rules: [] }], (i) => `gen-${i}`);
    assert.deepEqual(next.map((l) => l.id), ['lens-envelope', 'custom-1', 'custom-2']);
    assert.equal(next[2].builtin, false, 'a brand-new imported lens is never a builtin');
  });

  it('generates ids for id-less hand-authored lenses', () => {
    const next = mergeImportedLenses(existing, [{ name: 'No Id', rules: [] }], (i) => `gen-${i}`);
    assert.equal(next.length, 3);
    assert.equal(next[2].id, 'gen-0');
  });

  it('skips malformed entries (missing name or rules) without throwing', () => {
    const next = mergeImportedLenses(
      existing,
      [null, 42, { name: '' }, { name: 'x' }, { name: 'ok', rules: [] }],
      (i) => `gen-${i}`,
    );
    assert.deepEqual(next.map((l) => l.name), ['Building Envelope', 'My Lens', 'ok']);
  });

  it('rejects lenses whose rules array is shape-invalid (e.g. [null] or partial rule)', () => {
    const next = mergeImportedLenses(
      existing,
      [
        { name: 'bad-null-rule', rules: [null] },
        { name: 'bad-partial-rule', rules: [{ id: 'r', name: 'r' /* missing enabled/criteria/action/color */ }] },
        { name: 'good', rules: ruleLens.rules },
      ],
      (i) => `gen-${i}`,
    );
    assert.deepEqual(next.map((l) => l.name), ['Building Envelope', 'My Lens', 'good']);
  });

  it('preserves a valid imported autoColor spec (and clones it)', () => {
    const spec = { source: 'material' as const };
    const next = mergeImportedLenses(existing, [{ id: 'auto-x', name: 'Auto', rules: [], autoColor: spec }], (i) => `gen-${i}`);
    assert.deepEqual(next[2].autoColor, { source: 'material' });
    assert.notEqual(next[2].autoColor, spec, 'autoColor must be cloned, not aliased');
  });

  it('rejects a lens carrying a malformed autoColor (bad shape or unknown source)', () => {
    const next = mergeImportedLenses(
      existing,
      [
        { id: 'a1', name: 'arr-autocolor', rules: [], autoColor: [] },
        { id: 'a2', name: 'bad-source', rules: [], autoColor: { source: 'not-a-source' } },
        { id: 'a3', name: 'bad-pset-type', rules: [], autoColor: { source: 'property', psetName: 7 } },
        { id: 'a4', name: 'good-autocolor', rules: [], autoColor: { source: 'ifcType' } },
      ],
      (i) => `gen-${i}`,
    );
    assert.deepEqual(next.map((l) => l.name), ['Building Envelope', 'My Lens', 'good-autocolor']);
  });
});

describe('reserveUniqueId (#1403)', () => {
  it('returns the base id when free and reserves it', () => {
    const taken = new Set<string>();
    assert.equal(reserveUniqueId('lens-1', taken), 'lens-1');
    assert.ok(taken.has('lens-1'));
  });

  it('appends an incrementing suffix on collision', () => {
    const taken = new Set(['lens-1', 'lens-1-1']);
    assert.equal(reserveUniqueId('lens-1', taken), 'lens-1-2');
    assert.ok(taken.has('lens-1-2'));
  });

  it('produces distinct ids across successive calls with the same base', () => {
    const taken = new Set<string>();
    const a = reserveUniqueId('lens-x', taken);
    const b = reserveUniqueId('lens-x', taken);
    const c = reserveUniqueId('lens-x', taken);
    assert.deepEqual([a, b, c], ['lens-x', 'lens-x-1', 'lens-x-2']);
  });
});

describe('moveItem (#1403)', () => {
  it('moves an item forward', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  });
  it('moves an item backward', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  });
  it('returns an unchanged copy for no-op / out-of-range moves', () => {
    const arr = ['a', 'b', 'c'];
    assert.deepEqual(moveItem(arr, 1, 1), arr);
    assert.deepEqual(moveItem(arr, -1, 2), arr);
    assert.deepEqual(moveItem(arr, 0, 9), arr);
    assert.notEqual(moveItem(arr, 1, 1), arr, 'returns a fresh array, not the same reference');
  });
});
