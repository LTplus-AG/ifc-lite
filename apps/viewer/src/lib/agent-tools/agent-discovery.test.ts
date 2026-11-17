/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What a fresh agent sees in tool text: model ids, ranked discovery, and errors that say what to do next. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetFeaturesForTest } from '@/lib/features';
import { call, model, ok, parseHelloWall, seed, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from './main-viewer-dispatch';

const granted = (name: string, args: Record<string, unknown>) => dispatchMainViewerTool(viewerHost(), name, args, { canEdit: () => true });

describe('agent discovery and orientation', () => {
  beforeEach(async () => { resetFeaturesForTest(); seed([model('hello', await parseHelloWall())]); });

  it('model_list text carries each model id and schema', async () => {
    const text = ok(await call('model_list')).text;
    assert.match(text, /^1 model loaded: hello\.ifc \(model_id: hello, IFC\w+, [\d,]+ entities\)\.$/);
  });

  it('viewer_operations ranks natural-language queries and keeps pagination', async () => {
    const found = ok(await call('viewer_operations', { query: 'measure distance', limit: 3 })).structured as {
      total: number; offset: number; next_offset: number | null; operations: Array<{ id: string }>; hint?: string };
    assert.ok(found.operations.some(op => op.id === 'measurements.distance'), JSON.stringify(found.operations));
    assert.equal(found.offset, 0);
    assert.equal(found.next_offset, found.total > 3 ? 3 : null);
    assert.equal(found.hint, undefined);
  });

  it('viewer_operations treats a blank operation_id as no filter (the schema allows it)', async () => {
    const found = ok(await call('viewer_operations', { query: 'measure distance', operation_id: '', limit: 3 })).structured as { operations: Array<{ id: string }> };
    assert.ok(found.operations.some(op => op.id === 'measurements.distance'), JSON.stringify(found.operations));
  });

  it('a query matching nothing returns a hint naming owner families', async () => {
    const found = ok(await call('viewer_operations', { query: 'qqqxyzzy' })).structured as { total: number; hint: string };
    assert.equal(found.total, 0);
    assert.match(found.hint, /appearance/);
    assert.match(found.hint, /measurements/);
    const unknown = ok(await call('viewer_operations', { operation_id: 'measurement.distance' })).structured as { total: number; hint: string };
    assert.equal(unknown.total, 0);
    assert.match(unknown.hint, /measurements\.distance/);
  });

  it('execute with an unknown operation_id suggests the nearest ids', async () => {
    const result = await granted('viewer_operation_execute', { operation_id: 'screenshot', input: {} });
    assert.equal(result.errorCode, 'INVALID_INPUT');
    assert.match(result.text, /Nearest: [^.]*exports\.screenshot/);
  });

  it('execute with invalid input names the path and the expected shape', async () => {
    const result = await granted('viewer_operation_execute', { operation_id: 'exports.screenshot', input: {} });
    assert.equal(result.errorCode, 'INVALID_INPUT', result.text);
    assert.match(result.text, /input\.scope is required/);
    assert.match(result.text, /scope\*: "current-view"/);
    assert.match(result.text, /viewer_operations \{"operation_id":"exports\.screenshot"\}/);
  });
});
