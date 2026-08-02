/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADVERSARIAL tests for edit-column-in-place (PR #1700). Pins down:
 *  - legacy persisted columns (pre-#1591 shapes without psetName / label)
 *  - a NO-CHANGE edit save rewriting a custom label (confirmed loss)
 *  - regex pattern round-trip incl. flags and escapes
 *  - the missing duplicate guard in EDIT mode + the add-guard id drift
 *  - duplicate column ids in imported/legacy definitions
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeList, compileNameMatcher, type ColumnDefinition, type ListDataProvider, type ListDefinition } from '@ifc-lite/lists';
import { IfcTypeEnum, PropertyValueType, QuantityType } from '@ifc-lite/data';
import { isEditableColumn, draftFromColumn, columnFromDraft, columnDefKey, draftDefKey, updateColumnInPlace, type ColumnDraft } from './column-edit.js';

/** The content-derived key the duplicate guard now uses (ListBuilder.tsx
 *  `isDuplicateColumn`), mirrored here to prove the guard recognises an edited
 *  column regardless of its (stable) id. */
const addPathKey = (d: ColumnDraft) => draftDefKey(d);

describe('legacy persisted columns (pre-feature shapes)', () => {
  it('a legacy property column without psetName/label survives draftFromColumn', () => {
    // Old persisted lists can carry property columns without the optional
    // fields — psetName and label are `?` in the schema, and localStorage
    // JSON is loaded unvalidated (persistence.ts loadListDefinitions).
    const legacy = { id: 'old-1', source: 'property', propertyName: 'FireRating' } as ColumnDefinition;
    assert.equal(isEditableColumn(legacy), true);
    const draft = draftFromColumn(legacy);
    assert.deepEqual(draft, { source: 'property', setName: '', propName: 'FireRating' });
    // Round-trip does not throw and keeps the id.
    const back = columnFromDraft(draft, legacy.id);
    assert.equal(back.id, 'old-1');
    assert.equal(back.psetName, '');
    assert.equal(back.propertyName, 'FireRating');
  });

  it('a legacy quantity column maps to a quantity draft (source not collapsed)', () => {
    const legacy = { id: 'old-q', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume' } as ColumnDefinition;
    assert.equal(draftFromColumn(legacy).source, 'quantity');
  });

  it('FIXED: a no-change edit save preserves a custom label override (perfect no-op)', () => {
    // ColumnDefinition.label is a "Display label override"; imported .list.json
    // definitions can carry one. columnFromDraft now takes the PREVIOUS column
    // and keeps a deliberate override (a label that differs from the auto-label
    // its own definition would generate), so opening the editor and saving
    // WITHOUT any change is a perfect no-op instead of a silent rename.
    const col: ColumnDefinition = {
      id: 'c', source: 'property', psetName: 'Pset_WallCommon',
      propertyName: 'FireRating', label: 'Fire Rating (custom)',
    };
    const unchanged = columnFromDraft(draftFromColumn(col), col.id, col);
    assert.equal(unchanged.psetName, col.psetName);
    assert.equal(unchanged.propertyName, col.propertyName);
    // The override survives, so the whole definition round-trips byte-for-byte.
    assert.equal(unchanged.label, col.label);
    assert.deepEqual(unchanged, col);
  });

  it('FIXED: an auto-labelled column still regenerates its label on a definition edit', () => {
    // When the old label WAS the auto-label (== propertyName), it is not an
    // override, so editing the property name refreshes the label as before.
    const col: ColumnDefinition = {
      id: 'c', source: 'property', psetName: 'Pset_WallCommon',
      propertyName: 'FireRating', label: 'FireRating',
    };
    const edited = columnFromDraft({ ...draftFromColumn(col), propName: 'LoadBearing' }, col.id, col);
    assert.equal(edited.propertyName, 'LoadBearing');
    assert.equal(edited.label, 'LoadBearing');
  });
});

describe('regex column round-trip through the editor', () => {
  it('preserves a /regex/ set pattern byte-for-byte, incl. flags and escapes', () => {
    for (const pattern of [
      '/Qto_.*BaseQuantities/',
      '/qto_.+/i', // flags
      '/Pset_\\w+Common/', // escapes
      '/^(Qto|Pset)_[A-Za-z]+$/',
    ]) {
      const col: ColumnDefinition = {
        id: `custom-quantity-${pattern}-NetVolume`.replace(/\s+/g, '-'),
        source: 'quantity', psetName: pattern, propertyName: 'NetVolume', label: 'NetVolume',
      };
      const roundTripped = columnFromDraft(draftFromColumn(col), col.id);
      assert.equal(roundTripped.psetName, pattern, `pattern mangled: ${pattern}`);
      // The pattern still compiles to the same matcher semantics.
      assert.equal(compileNameMatcher(roundTripped.psetName!)('Qto_WallBaseQuantities'),
        compileNameMatcher(pattern)('Qto_WallBaseQuantities'));
    }
  });

  it('trim() cannot mutate a well-formed /…/ literal (delimiters are non-space)', () => {
    // Inner spaces are regex content and must survive; only OUTER whitespace
    // (which cannot be part of a /…/ literal) is trimmed.
    const col: ColumnDefinition = {
      id: 'x', source: 'property', psetName: '/Pset_[A-Z]{2} Common/', propertyName: 'P', label: 'P',
    };
    assert.equal(columnFromDraft(draftFromColumn(col), 'x').psetName, '/Pset_[A-Z]{2} Common/');
  });

  it('an edited regex column still resolves values end-to-end after the round-trip', () => {
    const provider: ListDataProvider = {
      getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1] : []),
      getEntityName: () => 'W', getEntityGlobalId: () => 'g', getEntityDescription: () => '',
      getEntityObjectType: () => '', getEntityTag: () => '', getEntityTypeName: () => 'IfcWall',
      getPropertySets: () => [],
      getQuantitySets: () => [
        { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', value: 0.28, type: QuantityType.Volume }] },
      ],
    };
    const original: ColumnDefinition = {
      id: 'vol', source: 'quantity', psetName: '/Qto_.*BaseQuantities/', propertyName: 'GrossVolume', label: 'GrossVolume',
    };
    // Pencil-edit: change only the quantity name, keep the pattern.
    const edited = columnFromDraft({ ...draftFromColumn(original), propName: 'NetVolume' }, original.id);
    const def: ListDefinition = {
      id: 'd', name: 'd', createdAt: 0, updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall], conditions: [],
      columns: updateColumnInPlace([original], 'vol', edited),
    };
    assert.equal(executeList(def, provider).rows[0].values[0], 0.28);
  });
});

describe('duplicate handling in edit mode', () => {
  const fire: ColumnDefinition = {
    id: 'custom-property-Pset_WallCommon-FireRating',
    source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', label: 'FireRating',
  };
  const acoustic: ColumnDefinition = {
    id: 'custom-property-Pset_WallCommon-AcousticRating',
    source: 'property', psetName: 'Pset_WallCommon', propertyName: 'AcousticRating', label: 'AcousticRating',
  };

  it('FIXED: editing a column into an exact duplicate is detectable via the definition key', () => {
    // The pure helper still keeps ids stable (sort/width binding relies on it),
    // so an edit CAN produce two columns with the same definition under
    // different ids. The guard no longer keys on the id: `columnDefKey` derives
    // identity from CONTENT, so the two collide and the UI blocks the save.
    const draft = draftFromColumn(fire); // = FireRating definition
    const next = updateColumnInPlace([fire, acoustic], acoustic.id, columnFromDraft(draft, acoustic.id, acoustic));
    assert.equal(next.length, 2);
    const [a, b] = next;
    assert.notEqual(a.id, b.id); // ids stay distinct (no key collision) ...
    assert.equal(columnDefKey(a), columnDefKey(b)); // ... but the DEFINITION keys collide
    // The edit-mode guard excludes the edited slot itself, then flags any OTHER
    // column sharing the draft's definition key — here, `fire`.
    const isDuplicate = (d: ColumnDraft, excludeId?: string) =>
      next.some((c) => c.id !== excludeId && columnDefKey(c) === draftDefKey(d));
    assert.equal(isDuplicate(draft, b.id), true);
  });

  it('FIXED: after an edit, the ADD-mode duplicate guard still sees the column by definition', () => {
    // Edit AcousticRating -> FireRating: the column keeps its OLD id.
    const edited = columnFromDraft(draftFromColumn(fire), acoustic.id, acoustic);
    const columns = updateColumnInPlace([acoustic], acoustic.id, edited);
    // The add guard keys on CONTENT, not id: the fresh-add draft's definition
    // key matches the edited column's, so "Custom column" is blocked.
    const freshAddKey = addPathKey(draftFromColumn(fire));
    const selectedDefKeys = new Set(columns.map((c) => columnDefKey(c)));
    assert.equal(freshAddKey, columnDefKey(fire), 'key mirror sanity check');
    assert.equal(selectedDefKeys.has(freshAddKey), true);
  });

  it('EDGE: duplicate ids in an imported definition make one edit rewrite BOTH slots', () => {
    // importListDefinition never validates column-id uniqueness, so a
    // hand-authored .list.json can carry two columns with the same id. The
    // in-place edit maps over ALL matches.
    const dupA = { ...fire };
    const dupB = { ...fire, propertyName: 'LoadBearing', label: 'LoadBearing' };
    const edited = columnFromDraft({ source: 'property', setName: 'Pset_X', propName: 'Y' }, fire.id);
    const next = updateColumnInPlace([dupA, dupB], fire.id, edited);
    assert.equal(next[0].propertyName, 'Y');
    assert.equal(next[1].propertyName, 'Y'); // second slot silently rewritten too
  });
});

describe('order / binding preservation under edit', () => {
  it('editing column i of n keeps order and every other object identity', () => {
    const cols: ColumnDefinition[] = [
      { id: 'a', source: 'attribute', propertyName: 'Name' },
      { id: 'b', source: 'property', psetName: 'P', propertyName: 'X', label: 'X' },
      { id: 'c', source: 'spatial', propertyName: 'Container' },
      { id: 'd', source: 'model', propertyName: 'Model' },
    ];
    const next = updateColumnInPlace(cols, 'b', columnFromDraft({ source: 'quantity', setName: 'Q', propName: 'Z' }, 'ignored-id'));
    assert.deepEqual(next.map((c) => c.id), ['a', 'b', 'c', 'd'], 'order and ids stable');
    assert.equal(next[1].id, 'b', 'id is FORCED back even when next carries another id');
    assert.equal(next[1].source, 'quantity');
    assert.equal(next[0], cols[0]);
    assert.equal(next[2], cols[2]);
    assert.equal(next[3], cols[3]);
  });

  it('grouping/sum bindings (by column id) survive an in-place edit', () => {
    const provider: ListDataProvider = {
      getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2] : []),
      getEntityName: (id) => `W${id}`, getEntityGlobalId: () => 'g', getEntityDescription: () => '',
      getEntityObjectType: () => '', getEntityTag: () => '', getEntityTypeName: () => 'IfcWall',
      getPropertySets: () => [
        { name: 'P', globalId: 'pg', properties: [{ name: 'X', value: 'x', type: PropertyValueType.Label }] },
      ],
      getQuantitySets: (id) => [
        { name: 'Q', quantities: [{ name: 'Z', value: id === 1 ? 2 : 3, type: QuantityType.Volume }] },
      ],
    };
    const cols: ColumnDefinition[] = [
      { id: 'cls', source: 'attribute', propertyName: 'Class' },
      { id: 'v', source: 'property', psetName: 'P', propertyName: 'X', label: 'X' },
    ];
    // Edit the summed column from a string property to a numeric quantity.
    const columns = updateColumnInPlace(cols, 'v', columnFromDraft({ source: 'quantity', setName: 'Q', propName: 'Z' }, 'v'));
    const def: ListDefinition = {
      id: 'g', name: 'g', createdAt: 0, updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall], conditions: [], columns,
      grouping: { columnId: 'cls', sumColumnIds: ['v'] },
    };
    const result = executeList(def, provider);
    assert.equal(result.summary?.sums.v, 5, 'sum binding by id still resolves after the edit');
  });
});
