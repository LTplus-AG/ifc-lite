/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcQuerySpec` evaluation over the real viewer backend and the committed
 * sample. The federated case loads the same file under two model ids, so
 * every express id exists twice: results must stay model-aware end to end.
 *
 * Expected values are read from the STEP text of building-architecture.ifc:
 * 4 IfcWall, 3 of them Pset_WallCommon.IsExternal = .T., wall NetVolume
 * #272 + #297 + #321 + #363, the largest (#321) on #315 "house - outer wall - house left".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRef } from '@ifc-lite/a2ui';
import { MODEL_A, MODEL_B, seedA2uiModels, selectedRefs } from '@/test/a2ui-fixture';
import { aggregate, aggregatePool, evaluateQuery, FieldReader, groupRows } from './query-eval';
import { runIfcFunction } from './functions';

const WALL_VOLUMES = [1.26926493526358, 1.7856181822821586, 4.230883117545889, 0.16470195328802126];
const LEFT_WALL = 315;

describe('evaluateQuery', () => {

  it('returns each model\'s entities once when two models share every express id', async () => {
    const { host } = await seedA2uiModels({ federated: true });
    const result = evaluateQuery(host, { types: ['IfcWall'] });
    assert.deepEqual(result.problems, []);
    assert.equal(result.total, 8);
    const a = result.rows.filter((r) => r.ref.modelId === MODEL_A).map((r) => r.ref.expressId).sort();
    const b = result.rows.filter((r) => r.ref.modelId === MODEL_B).map((r) => r.ref.expressId).sort();
    assert.equal(a.length, 4);
    assert.deepEqual(a, b, 'same express ids in both models');
    assert.equal(new Set(result.rows.map((r) => r.key)).size, 8, 'refs stay distinct');
  });

  it('restricts to one model, and marks a query on an unloaded model inert', async () => {
    const { host } = await seedA2uiModels({ federated: true });
    const onlyB = evaluateQuery(host, { types: ['IfcWall'], modelId: MODEL_B });
    assert.deepEqual([...new Set(onlyB.rows.map((r) => r.ref.modelId))], [MODEL_B]);
    const missing = evaluateQuery(host, { types: ['IfcWall'], modelId: 'not-loaded' });
    assert.equal(missing.unloadedModel, 'not-loaded');
    assert.equal(missing.rows.length, 0);
  });

  it('filters on property sets, accepts upper-case class names and reports bad input', async () => {
    const { host } = await seedA2uiModels();
    const external = evaluateQuery(host, { types: ['IFCWALL'], where: [{ path: 'Pset_WallCommon.IsExternal', op: 'eq', value: true }] });
    assert.equal(external.total, 3);
    const internal = evaluateQuery(host, { types: ['IfcWall'], where: [{ path: 'Pset_WallCommon.IsExternal', op: 'neq', value: true }] });
    assert.deepEqual(internal.rows.map((r) => r.name), ['plumbing wall']);
    const missing = evaluateQuery(host, { types: ['IfcWall'], where: [{ path: 'Pset_DoorCommon.FireRating', op: 'missing' }] });
    assert.equal(missing.total, 4);
    const bad = evaluateQuery(host, { types: ['Wall'], where: [{ path: 'a b', op: 'eq', value: 1 }] });
    assert.deepEqual(bad.problems.map((p) => p.path), ['types', 'where[0].path']);
    assert.equal(bad.total, 0, 'a query with problems yields nothing rather than every product');
  });

  it('resolves quantity-set paths for where, sums and groups (Qto_*, not only Pset_*)', async () => {
    const { host } = await seedA2uiModels();
    const reader = new FieldReader(host);
    const walls = evaluateQuery(host, { types: ['IfcWall'] }, reader);
    const sum = aggregate(reader, aggregatePool(walls), 'sum', 'Qto_WallBaseQuantities.NetVolume');
    assert.ok(Math.abs((sum ?? 0) - WALL_VOLUMES.reduce((x, y) => x + y, 0)) < 1e-9, `sum ${sum}`);
    assert.equal(aggregate(reader, walls.rows, 'max', 'Qto_WallBaseQuantities.NetVolume'), Math.max(...WALL_VOLUMES));
    const big = evaluateQuery(host, { types: ['IfcWall'], where: [{ path: 'Qto_WallBaseQuantities.NetVolume', op: 'gt', value: 4 }] }, reader);
    assert.deepEqual(big.rows.map((r) => r.ref.expressId), [LEFT_WALL]);
    assert.equal(runIfcFunction(host, 'sumQuantity', { query: { types: ['IfcWall'] }, path: 'Qto_WallBaseQuantities.NetVolume' }, { caller: 'agent', userActivated: false }), sum);
    const byExternal = groupRows(reader, walls.rows, 'Pset_WallCommon.IsExternal', 'none');
    assert.deepEqual(byExternal.map((g) => [g.label, g.value]), [['true', 3], ['false', 1]]);
  });

  it('reads built-in storey and type fields', async () => {
    const { host } = await seedA2uiModels();
    const reader = new FieldReader(host);
    const onStorey = evaluateQuery(host, { types: ['IfcWall'], storey: '00 groundfloor' }, reader);
    assert.equal(onStorey.total, 4);
    assert.equal(reader.value(onStorey.rows[0], 'type'), 'IfcWall');
  });

  it('applies the limit to rows but aggregates every match unless the query set one', async () => {
    const { host } = await seedA2uiModels({ federated: true });
    const implicit = evaluateQuery(host, { types: ['IfcWall'] });
    assert.equal(aggregatePool(implicit).length, 8);
    const limited = evaluateQuery(host, { types: ['IfcWall'], limit: 2 });
    assert.equal(limited.rows.length, 2);
    assert.equal(limited.total, 8);
    assert.equal(aggregatePool(limited).length, 2);
  });
});

describe('model-aware actions', () => {
  it('selects the entity in the model the ref names, not its twin with the same express id', async () => {
    const { host } = await seedA2uiModels({ federated: true });
    const ref = encodeRef({ modelId: MODEL_B, expressId: LEFT_WALL });
    runIfcFunction(host, 'select', { refs: [ref] }, { caller: 'renderer', userActivated: true });
    assert.deepEqual(selectedRefs(host), [ref]);
    runIfcFunction(host, 'select', { refs: [encodeRef({ modelId: MODEL_A, expressId: LEFT_WALL })] }, { caller: 'renderer', userActivated: true });
    assert.deepEqual(selectedRefs(host), [`${MODEL_A}:${LEFT_WALL}`]);
  });

  it('drops refs to models that are not loaded instead of acting on a twin', async () => {
    const { host } = await seedA2uiModels();
    runIfcFunction(host, 'select', { refs: [`${MODEL_B}:${LEFT_WALL}`] }, { caller: 'renderer', userActivated: true });
    assert.deepEqual(selectedRefs(host), []);
  });
});
