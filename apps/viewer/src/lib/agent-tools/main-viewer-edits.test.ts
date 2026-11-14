/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Agent edits on the main viewer's model (#9523), tab side: every edit tool
 * is refused unless the call's grant allows it, and an allowed call goes
 * through the viewer's reviewed-change commit as one undo step labelled as
 * the agent's, which Ctrl+Z (`undo`) reverts.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTabMessage } from '@ifc-lite/mcp/bridge-protocol';
import { useViewerStore } from '@/store';
import { CATALOG } from '@/components/mcp/data';
import { changeOperations } from '@/lib/changes/change-operations';
import { agentChangeLabelFor, useAgentChangeLabels } from '@/lib/changes/agent-change-labels';
import { mainViewerBridgeTools } from '@/lib/agent-bridge/session';
import { WALL_GID, WALL_ID, model, parseHelloWall, parseStep, seed, viewerHost } from '@/test/agent-tools-fixture';
import { MAIN_VIEWER_EDIT_TOOLS, dispatchMainViewerTool, type AgentToolResult } from './main-viewer-dispatch.js';
import { createMainViewerEditor } from './main-viewer-edits.js';
import { mainViewerToolDefinitions } from './main-viewer-tool-definitions.js';
import type { AgentEdit } from './types.js';

const PSET = 'Pset_WallCommon';

const ARGS: Record<(typeof MAIN_VIEWER_EDIT_TOOLS)[number], Record<string, unknown>> = {
  entity_set_property: { global_id: WALL_GID, pset: PSET, name: 'FireRating', value: 'EI60' },
  entity_delete_property: { global_id: WALL_GID, pset: PSET, name: 'IsExternal' },
  entity_set_attribute: { global_id: WALL_GID, attribute: 'Name', value: 'Agent wall' },
};

const editingHost = () => viewerHost({ editor: createMainViewerEditor(useViewerStore) });

/** An edit call; `canEdit: null` sends no grant at all. */
function edit(tool: string, args: Record<string, unknown>, canEdit: (() => boolean) | null = () => true, host = editingHost()) {
  return dispatchMainViewerTool(host, tool, args, canEdit ? { canEdit } : {});
}

function applied(result: AgentToolResult): AgentEdit {
  assert.equal(result.isError, false, `${result.errorCode}: ${result.text}`);
  assert.ok(result.edit, 'the result carries the edit');
  return result.edit;
}

const undoDepth = () => useViewerStore.getState().undoStacks.get('hello')?.length ?? 0;
const operations = () => {
  const s = useViewerStore.getState();
  return changeOperations(s.undoStacks, s.mutationBatchTags);
};
const view = () => useViewerStore.getState().mutationViews.get('hello')!;
const fireRating = () => view().getPropertyValue(WALL_ID, PSET, 'FireRating');
const wallName = () => view().getAttributeMutationsForEntity(WALL_ID).find((m) => m.name === 'Name')?.value;

describe('agent edits on the main viewer (#9523)', () => {
  beforeEach(async () => {
    seed([model('hello', await parseHelloWall())]);
    useAgentChangeLabels.setState({ byBatch: new Map() });
  });

  it('a read-only grant refuses every edit tool with READ_ONLY and writes nothing', async () => {
    for (const grant of [null, () => false]) {
      for (const tool of MAIN_VIEWER_EDIT_TOOLS) {
        const result = await edit(tool, ARGS[tool], grant);
        assert.equal(result.isError, true, tool);
        assert.equal(result.errorCode, 'READ_ONLY', tool);
        assert.equal(result.edit, undefined);
      }
    }
    assert.equal(undoDepth(), 0, 'no undo entries');
    assert.equal(view().getAttributeMutationsForEntity(WALL_ID).length, 0);
  });

  it('a read-only grant is enforced by the tool itself too, not only by the dispatcher', async () => {
    // A grant that flips between the dispatcher's check and the write (a revoke) still refuses.
    let calls = 0;
    const result = await edit('entity_set_attribute', ARGS.entity_set_attribute, () => calls++ === 0);
    assert.equal(result.errorCode, 'READ_ONLY');
    assert.equal(calls, 2, 'checked at dispatch and again at the write');
    assert.equal(undoDepth(), 0);
  });

  it('allowed, each call is one undo step labelled as the agent\'s, and undo restores the prior value', async () => {
    const before = fireRating() ?? null;
    const set = applied(await edit('entity_set_property', ARGS.entity_set_property));
    assert.deepEqual(set, {
      modelId: 'hello', expressId: WALL_ID, globalId: WALL_GID, entityType: 'IfcWall',
      field: `${PSET}.FireRating`, before, after: 'EI60', changed: true,
    });
    assert.equal(fireRating(), 'EI60');

    const named = applied(await edit('entity_set_attribute', ARGS.entity_set_attribute));
    assert.equal(named.after, 'Agent wall');
    assert.equal(wallName(), 'Agent wall');

    const ops = operations();
    assert.equal(ops.length, 2, 'two calls, two operations');
    const labels = useAgentChangeLabels.getState().byBatch;
    assert.deepEqual(ops.map((op) => agentChangeLabelFor(labels, op.id)), ['Name', `${PSET}.FireRating`], 'newest first, both labelled');

    useViewerStore.getState().undo('hello');
    assert.notEqual(wallName(), 'Agent wall', 'one undo reverts the last call only');
    assert.equal(fireRating(), 'EI60');
    useViewerStore.getState().undo('hello');
    assert.equal(fireRating() ?? null, before, 'the second undo restores the value the agent replaced');
    assert.equal(undoDepth(), 0);
  });

  it('deleting a property is one step, and undo brings it back', async () => {
    const before = view().getPropertyValue(WALL_ID, PSET, 'IsExternal');
    assert.notEqual(before, undefined, 'the fixture wall has Pset_WallCommon.IsExternal');
    const removed = applied(await edit('entity_delete_property', ARGS.entity_delete_property));
    assert.equal(removed.after, null);
    assert.equal(removed.before, before);
    assert.equal(view().getPropertyValue(WALL_ID, PSET, 'IsExternal') ?? null, null);
    assert.equal(operations().length, 1);
    useViewerStore.getState().undo('hello');
    assert.equal(view().getPropertyValue(WALL_ID, PSET, 'IsExternal'), before);
  });

  it('a value the user changed since the agent read it is refused as STATE_CHANGED, nothing written', async () => {
    useViewerStore.getState().setAttribute('hello', WALL_ID, 'Name', 'User wall');
    const depth = undoDepth();
    const result = await edit('entity_set_attribute', { ...ARGS.entity_set_attribute, expected: 'What the agent read' });
    assert.equal(result.errorCode, 'STATE_CHANGED');
    assert.deepEqual(result.structured, { current: 'User wall', expected: 'What the agent read' });
    assert.equal(wallName(), 'User wall');
    assert.equal(undoDepth(), depth);

    applied(await edit('entity_set_attribute', { ...ARGS.entity_set_attribute, expected: 'User wall' }));
    assert.equal(wallName(), 'Agent wall', 'the matching expected value is accepted');
  });

  it('a delete whose property the user already removed is STATE_CHANGED when the agent passed what it read', async () => {
    useViewerStore.getState().deleteProperty('hello', WALL_ID, PSET, 'IsExternal');
    const depth = undoDepth();
    const result = await edit('entity_delete_property', { ...ARGS.entity_delete_property, expected: true });
    assert.equal(result.errorCode, 'STATE_CHANGED', result.text);
    assert.equal(undoDepth(), depth);
    useViewerStore.setState({ editEnabled: false });
    assert.equal((await edit('entity_delete_property', ARGS.entity_delete_property)).errorCode, 'PERMISSION_DENIED',
      'the edit gate is reported before "no such property"');
  });

  it('expected: null on an unset attribute means empty text', async () => {
    const result = applied(await edit('entity_set_attribute', { global_id: WALL_GID, attribute: 'Tag', value: 'T-1', expected: null }));
    assert.equal(result.after, 'T-1');
  });

  it('a value already in place is reported unchanged and adds no undo step', async () => {
    applied(await edit('entity_set_property', ARGS.entity_set_property));
    const again = applied(await edit('entity_set_property', ARGS.entity_set_property));
    assert.equal(again.changed, false);
    assert.match((await edit('entity_set_property', ARGS.entity_set_property)).text, /nothing was changed/);
    assert.equal(operations().length, 1);
  });

  it('the viewer\'s own edit gate applies: with edit mode off the edit is refused', async () => {
    useViewerStore.setState({ editEnabled: false });
    const result = await edit('entity_set_property', ARGS.entity_set_property);
    assert.equal(result.errorCode, 'PERMISSION_DENIED', result.text);
    assert.equal(undoDepth(), 0);
  });

  it('bad arguments are refused before anything is written', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['entity_set_attribute', { global_id: WALL_GID, attribute: 'GlobalId', value: '0000000000000000000000' }],
      ['entity_set_property', { global_id: WALL_GID, pset: PSET, name: 'X', value: { nested: true } }],
      ['entity_set_property', { global_id: WALL_GID, pset: '', name: 'X', value: 1 }],
      ['entity_delete_property', { global_id: WALL_GID, pset: PSET, name: 'NoSuchProperty' }],
      ['entity_set_property', { global_id: '0000000000000000000000', pset: PSET, name: 'X', value: 1 }],
    ];
    for (const [tool, args] of cases) {
      const result = await edit(tool, args);
      assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
      assert.match(String(result.errorCode), /INVALID_INPUT|ENTITY_NOT_FOUND/);
    }
    assert.equal(undoDepth(), 0);
  });

  it('a host without an editor serves no edits even when allowed', async () => {
    const result = await edit('entity_set_property', ARGS.entity_set_property, () => true, viewerHost());
    assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION');
  });

  it('tools the viewer does not offer stay refused whatever the grant', async () => {
    for (const tool of ['entity_delete', 'entity_create', 'mutation_undo', 'model_save']) {
      const result = await edit(tool, { global_id: WALL_GID });
      assert.equal(result.isError, true, tool);
      assert.notEqual(result.errorCode, undefined);
    }
  });
});

describe('edit tool definitions (#9523)', () => {
  it('are mutate-scope catalog tools, listed readOnly: false with model_id', () => {
    const scopes = new Map(CATALOG.tools.map((tool) => [tool.name, tool.scope]));
    const definitions = mainViewerToolDefinitions();
    for (const name of MAIN_VIEWER_EDIT_TOOLS) {
      assert.equal(scopes.get(name), 'mutate', `${name} is a catalog mutation tool`);
      const definition = definitions.find((tool) => tool.name === name);
      assert.equal(definition?.readOnly, false, name);
      assert.ok(definition?.inputSchema.properties.model_id, `${name} takes model_id`);
    }
    assert.ok(definitions.filter((tool) => !tool.readOnly).every((tool) => (MAIN_VIEWER_EDIT_TOOLS as readonly string[]).includes(tool.name)),
      'nothing else is labelled as changing the model');
  });

  for (const permission of ['read-only', 'read-write'] as const) {
    it(`the full tool list passes the bridge's hello validator with permission ${permission}`, () => {
      const hello = { type: 'hello', protocol: 1, pairingCode: 'ABCDEFGHJKMNPQRSTVWX', permission, tools: mainViewerBridgeTools() };
      const parsed = parseTabMessage(JSON.stringify(hello));
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
      const update = parseTabMessage(JSON.stringify({ type: 'update', sessionId: 's', permission, tools: mainViewerBridgeTools() }));
      assert.ok(update.ok, update.ok ? '' : update.error);
    });
  }
});

/** Two walls sharing one GlobalId (#100 and #200), as a sloppy exporter writes them. */
const DUPLICATE_GID = '1dup00000000000000000a';
const DUPLICATED = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('dup.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);
#100=IFCWALL('${DUPLICATE_GID}',$,'First',$,$,$,$,$,$);
#200=IFCWALL('${DUPLICATE_GID}',$,'Second',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

describe('agent edits and duplicated GlobalIds (#9523 review)', () => {
  beforeEach(async () => {
    seed([model('dup', await parseStep(new TextEncoder().encode(DUPLICATED)))]);
    useAgentChangeLabels.setState({ byBatch: new Map() });
  });

  it('never writes to another entity than the one asked for', async () => {
    const names = () => {
      const v = useViewerStore.getState().mutationViews.get('dup')!;
      return [100, 200].map((id) => v.getAttributeMutationsForEntity(id).find((m) => m.name === 'Name')?.value ?? null);
    };
    const outcomes: Array<[number, AgentToolResult]> = [];
    for (const id of [100, 200]) {
      outcomes.push([id, await edit('entity_set_attribute', { express_id: id, attribute: 'Name', value: `Agent ${id}` })]);
    }
    for (const [id, result] of outcomes) {
      if (result.isError) {
        assert.equal(result.errorCode, 'ENTITY_NOT_FOUND', result.text);
        assert.match(result.text, /not unique/);
      } else {
        assert.equal(result.edit?.expressId, id, 'the result names the entity that was written');
        assert.equal(names()[id === 100 ? 0 : 1], `Agent ${id}`, `#${id} itself holds the new name`);
      }
    }
    assert.equal(outcomes.filter(([, r]) => r.isError).length, 1, 'the entity the resolver does not pick is refused');
    const written = names();
    assert.ok(written.every((name, i) => name === null || name === `Agent ${[100, 200][i]}`), `no cross write: ${JSON.stringify(written)}`);
  });

  it('refuses the duplicate the same way whatever the call, and reports the edit gate first', async () => {
    const refused: number[] = [];
    for (const id of [100, 200]) {
      const r = await edit('entity_delete_property', { express_id: id, pset: 'Pset_WallCommon', name: 'Absent' });
      if (/not unique/.test(r.text)) refused.push(id);
    }
    assert.equal(refused.length, 1, 'a delete of an absent property on the duplicate says "not unique", not "no property"');
    useViewerStore.setState({ editEnabled: false });
    const denied = await edit('entity_set_attribute', { express_id: refused[0], attribute: 'Name', value: 'x' });
    assert.equal(denied.errorCode, 'PERMISSION_DENIED');
  });
});
