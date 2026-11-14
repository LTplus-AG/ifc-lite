/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Argument handling in the shared agent tool core (#9523), through both the
 * playground and the main-viewer host: paging arguments are bounded at both
 * ends, an id that is not in the model is ENTITY_NOT_FOUND for every tool that
 * takes one, and a truncated bulk lookup says it was truncated.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, parsePlaygroundModel } from '@/components/mcp/playground-dispatcher';
import { useViewerStore } from '@/store';
import { HELLO_WALL, WALL_GID, WALL_ID, call, fileBytes, model, parseHelloWall, seed } from '@/test/agent-tools-fixture';

type Call = (tool: string, args: Record<string, unknown>) => Promise<{ isError: boolean; errorCode?: string; text: string; structured: unknown }>;

/** Both hosts over the same unedited hello-wall. */
async function hosts(): Promise<Array<[string, Call]>> {
  const bytes = await fileBytes(HELLO_WALL);
  const playground = await parsePlaygroundModel(bytes.slice().buffer, 'hello-wall.ifc');
  return [
    ['playground', (tool, args) => dispatch(playground, tool, args)],
    ['main viewer', (tool, args) => call(tool, args)],
  ];
}

describe('agent tool arguments (#9523)', () => {
  beforeEach(async () => seed([model('hello', await parseHelloWall())]));

  it('query_entities bounds limit and offset at both ends (review: limit -1 returned all but the last)', async () => {
    for (const [host, run] of await hosts()) {
      const page = async (args: Record<string, unknown>) => (await run('query_entities', args)).structured as { count: number; entities: unknown[] };
      const all = await page({ limit: 200 });
      assert.ok(all.count > 1, host);
      assert.equal((await page({ limit: -1 })).entities.length, 0, `${host}: a negative limit is 0, not "all but the last"`);
      assert.equal((await page({ limit: 1.7 })).entities.length, 1, `${host}: a fraction is truncated`);
      assert.equal((await page({ limit: 1e12 })).entities.length, Math.min(all.count, 200), `${host}: a huge limit is the cap`);
      assert.equal((await page({ limit: 'many' })).entities.length, Math.min(all.count, 50), `${host}: not a number falls back to the default`);
      assert.deepEqual((await page({ offset: -5, limit: 1 })).entities, (await page({ offset: 0, limit: 1 })).entities, `${host}: a negative offset is 0`);
      assert.equal((await page({ offset: Number.NaN })).entities.length, Math.min(all.count, 50), host);
      assert.equal((await page({ offset: 1e15 })).entities.length, 0, host);
    }
  });

  it('an express_id that is not in the model is ENTITY_NOT_FOUND for every tool that takes one (review: get_entity returned a placeholder)', async () => {
    const tools = ['get_entity', 'relationships', 'containment_chain', 'geometry_bbox', 'geometry_volume', 'geometry_area', 'bsdd_match'];
    for (const [host, run] of await hosts()) {
      for (const tool of tools) {
        assert.equal((await run(tool, { express_id: 999_999 })).errorCode, 'ENTITY_NOT_FOUND', `${host} ${tool}`);
        assert.equal((await run(tool, { express_id: 1.5 })).errorCode, 'INVALID_INPUT', `${host} ${tool}: not an id`);
        assert.equal((await run(tool, { express_id: -3 })).errorCode, 'INVALID_INPUT', `${host} ${tool}: not an id`);
      }
      assert.equal((await run('cost_evaluate', { express_id: 999_999, target: 'item' })).errorCode, 'ENTITY_NOT_FOUND', `${host} cost_evaluate`);
      assert.equal((await run('get_entity', { express_id: WALL_ID })).isError, false, `${host}: a real id still answers`);
    }
  });

  it('a deleted express_id is ENTITY_NOT_FOUND on the main viewer', async () => {
    assert.equal(useViewerStore.getState().removeEntity('hello', WALL_ID), true);
    for (const tool of ['get_entity', 'relationships', 'containment_chain', 'geometry_bbox']) {
      assert.equal((await call(tool, { express_id: WALL_ID })).errorCode, 'ENTITY_NOT_FOUND', tool);
    }
  });

  it('get_entities_bulk reports a truncated request as truncated, not as unresolved (review: 201 ids read "Resolved 200/201")', async () => {
    for (const [host, run] of await hosts()) {
      const over = await run('get_entities_bulk', { global_ids: Array.from({ length: 201 }, () => WALL_GID) });
      const s = over.structured as { entities: unknown[]; requested: number; considered: number; resolved: number; truncated: boolean; cap: number };
      assert.deepEqual([s.entities.length, s.requested, s.considered, s.resolved, s.truncated, s.cap], [200, 201, 200, 200, true, 200], host);
      assert.match(over.text, /Resolved 200\/200 .*first 200 of 201.*1 skipped/, host);

      const within = await run('get_entities_bulk', { global_ids: [WALL_GID, 'missing', WALL_GID, 7] });
      const w = within.structured as { entities: Array<{ ref?: { expressId: number } } | null>; truncated?: boolean };
      assert.deepEqual(w.entities.map((e) => e?.ref?.expressId ?? null), [WALL_ID, null, WALL_ID, null], `${host}: one entry per position, repeats resolve each time`);
      assert.equal(w.truncated, undefined, host);
      assert.equal(within.text, 'Resolved 2/4 entities.', host);
      assert.equal((await run('get_entities_bulk', { global_ids: WALL_GID })).errorCode, 'INVALID_INPUT', `${host}: a bare string is not a list`);
    }
  });
});
