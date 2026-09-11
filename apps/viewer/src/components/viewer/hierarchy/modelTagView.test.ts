/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Models section's tag view (issue #4215) over the rows the REAL tree
 * builder emits for a three-model federation: the row filter lists fewer
 * models and touches nothing else; "By tag" groups them under one header
 * per tag plus an explicit Untagged group; a model under two tags is listed
 * under both but counted once per group and keeps its own model id on every
 * row.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types.js';
import { DEFAULT_MODEL_TAG_VIEW, type ModelTagView } from '@/store/slices/modelTagsSlice.js';
import type { ModelTag } from '@/lib/model-tags/types.js';
import { buildTreeData, buildUnifiedStoreys, splitNodes } from './treeDataBuilder.js';
import {
  applyModelTagView,
  groupModelBlocks,
  modelIdsMatchingTagView,
  splitModelBlocks,
  UNTAGGED_GROUP_ID,
} from './modelTagView.js';
import type { TreeNode } from './types.js';

/** Just what the MODELS section of `buildTreeData` reads: one storey, no project. */
function makeStore(storeyId: number): IfcDataStore {
  return {
    entityCount: 7,
    spatialHierarchy: {
      project: undefined,
      byStorey: new Map([[storeyId, []]]),
      storeyElevations: new Map([[storeyId, 0]]),
    },
    entities: { getName: () => 'Level' },
  } as unknown as IfcDataStore;
}

function federatedModel(id: string): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: makeStore(5), geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0, idOffset: 0, maxExpressId: 100,
  } as FederatedModel;
}

const S: ModelTag = { id: 'tag-s', name: 'Structure' };
const A: ModelTag = { id: 'tag-a', name: 'Architecture' };
const tags = new Map([[S.id, S], [A.id, A]]);
/** m1 Structure + Architecture, m2 Structure, m3 untagged. */
const assignments = new Map([['m1', new Set([S.id, A.id])], ['m2', new Set([S.id])]]);

/** The Models-section rows exactly as the panel gets them from the builder. */
function modelRows(): TreeNode[] {
  const models = new Map(['m1', 'm2', 'm3'].map((id) => [id, federatedModel(id)]));
  const storeys = buildUnifiedStoreys(models, 'elevation-desc');
  const nodes = buildTreeData(models, null, new Set(), true, storeys, 'elevation-desc');
  return splitNodes(nodes, true).modelsNodes;
}

const view = (patch: Partial<ModelTagView>): ModelTagView => ({ ...DEFAULT_MODEL_TAG_VIEW, ...patch });
const modelIdsOf = (nodes: TreeNode[]) => nodes.filter((n) => n.type === 'model-header').map((n) => n.modelIds[0]);

describe('modelTagView (#4215)', () => {
  it('fixture sanity: the builder emits one model row per model, in federation order', () => {
    assert.deepEqual(splitModelBlocks(modelRows()).map((b) => b.modelId), ['m1', 'm2', 'm3']);
  });

  it('no view → the rows pass through unchanged', () => {
    const rows = modelRows();
    assert.deepEqual(applyModelTagView(rows, DEFAULT_MODEL_TAG_VIEW, tags, assignments), rows);
  });

  it('the row filter lists models carrying ANY of the chosen tags, or untagged when asked — and nothing else changes', () => {
    const rows = modelRows();
    const structure = applyModelTagView(rows, view({ filterTagIds: [S.id] }), tags, assignments);
    assert.deepEqual(modelIdsOf(structure), ['m1', 'm2']);
    assert.deepEqual(structure.map((n) => n.isVisible), [true, true], 'a row filter never rewrites visibility');
    assert.deepEqual(modelIdsOf(applyModelTagView(rows, view({ filterTagIds: [A.id] }), tags, assignments)), ['m1']);
    assert.deepEqual(modelIdsOf(applyModelTagView(rows, view({ filterUntagged: true }), tags, assignments)), ['m3']);
    assert.deepEqual(
      modelIdsOf(applyModelTagView(rows, view({ filterTagIds: [A.id], filterUntagged: true }), tags, assignments)),
      ['m1', 'm3'],
    );
    // What "Isolate matching models" is handed: the same answer, as ids.
    assert.deepEqual(modelIdsMatchingTagView(['m1', 'm2', 'm3'], view({ filterTagIds: [S.id] }), assignments), ['m1', 'm2']);
  });

  it('a filter naming only a deleted tag lists nothing rather than everything', () => {
    assert.deepEqual(modelIdsOf(applyModelTagView(modelRows(), view({ filterTagIds: ['tag-gone'] }), tags, assignments)), []);
  });

  it('"By tag" groups by tag name, then an explicit Untagged group; a two-tag model is under both, counted once each', () => {
    const grouped = applyModelTagView(modelRows(), view({ groupByTag: true }), tags, assignments);
    const headers = grouped.filter((n) => n.type === 'model-tag-group');
    assert.deepEqual(headers.map((h) => [h.name, h.elementCount]), [['Architecture', 1], ['Structure', 2], ['Untagged', 1]]);
    assert.deepEqual(
      grouped.map((n) => (n.type === 'model-tag-group' ? `#${n.name}` : n.modelIds[0])),
      ['#Architecture', 'm1', '#Structure', 'm1', 'm2', '#Untagged', 'm3'],
    );
    // One model, two rows: each row still names the model, and the ids differ only so React can key them.
    const m1Rows = grouped.filter((n) => n.type === 'model-header' && n.modelIds[0] === 'm1');
    assert.equal(m1Rows.length, 2);
    assert.notEqual(m1Rows[0].id, m1Rows[1].id);
    assert.ok(m1Rows.every((n) => n.id.startsWith('model-')), 'the panel recognises a model row by this prefix');
    assert.ok(m1Rows.every((n) => !n.hasChildren), 'grouped rows do not drill down (expansion is keyed on the ungrouped id)');
    const distinct = new Set(grouped.filter((n) => n.type === 'model-header').map((n) => n.modelIds[0]));
    assert.equal(distinct.size, 3, 'the federation is still three models');
  });

  it('Untagged is shown when empty (every model is tagged) unless a filter excludes untagged models', () => {
    const allTagged = new Map([...assignments, ['m3', new Set([A.id])]]);
    const blocks = splitModelBlocks(modelRows());
    const withEmpty = groupModelBlocks(blocks, view({ groupByTag: true }), tags, allTagged);
    assert.deepEqual(withEmpty.at(-1), { id: UNTAGGED_GROUP_ID, name: 'Untagged', tag: null, modelIds: [] });

    // Filtering to Architecture lists m1 only — which still carries Structure, so it is under both; no Untagged row.
    const filtered = applyModelTagView(modelRows(), view({ groupByTag: true, filterTagIds: [A.id] }), tags, assignments);
    assert.deepEqual(filtered.filter((n) => n.type === 'model-tag-group').map((n) => n.name), ['Architecture', 'Structure']);
    assert.deepEqual(filtered.filter((n) => n.type === 'model-header').map((n) => n.modelIds[0]), ['m1', 'm1']);
  });

  it('a tag that was deleted but is still in an assignment set neither groups nor counts', () => {
    const stale = new Map([['m1', new Set(['tag-gone'])]]);
    const grouped = applyModelTagView(modelRows(), view({ groupByTag: true }), tags, stale);
    assert.deepEqual(grouped.filter((n) => n.type === 'model-tag-group').map((n) => [n.name, n.elementCount]), [['Untagged', 3]]);
  });
});
