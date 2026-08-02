/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { createLayerStackSlice, type LayerStackSlice, type LayerStackEntry } from './layerStackSlice.js';
import { layerStackEntry, computeLayerContribution, shortContentId, pathTail } from '../../lib/layers/stack.js';

function makeFile(data: IfcxFile['data'], id = 'layer-x'): IfcxFile {
  return {
    header: { id, ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-07-11T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
}

function entryFor(file: IfcxFile, id: string, name: string): LayerStackEntry {
  return layerStackEntry({ id, name, file, buffer: new ArrayBuffer(8) });
}

describe('LayerStackSlice (#1717)', () => {
  let state: LayerStackSlice;
  let setState: (partial: Partial<LayerStackSlice> | ((s: LayerStackSlice) => Partial<LayerStackSlice>)) => void;

  beforeEach(() => {
    setState = (partial) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createLayerStackSlice(setState, () => state, {} as never);
  });

  it('starts empty', () => {
    assert.deepStrictEqual(state.layerStack, []);
    assert.strictEqual(state.layerStackPathToId, null);
    assert.strictEqual(state.layerStackDiff, null);
  });

  it('setLayerStack replaces the stack and resets the diff', () => {
    const entry = entryFor(makeFile([{ path: 'wall-1', attributes: { A: 1 } }]), 'l1', 'base.ifcx');
    state.setLayerStackDiff({ layerId: 'stale', diff: { added: [], deleted: [], modified: [] } });
    state.setLayerStack([entry], new Map([['wall-1', 7]]));
    assert.strictEqual(state.layerStack.length, 1);
    assert.strictEqual(state.layerStackPathToId?.get('wall-1'), 7);
    assert.strictEqual(state.layerStackDiff, null);
  });

  it('clearLayerStack resets everything including busy', () => {
    const entry = entryFor(makeFile([{ path: 'wall-1' }]), 'l1', 'base.ifcx');
    state.setLayerStack([entry], null);
    state.setLayerDiffBusy(true);
    state.clearLayerStack();
    assert.deepStrictEqual(state.layerStack, []);
    assert.strictEqual(state.layerDiffBusy, false);
  });
});

describe('layerStackEntry provenance summary', () => {
  it('summarizes an unsigned layer', () => {
    const entry = entryFor(makeFile([{ path: 'a' }, { path: 'b' }]), 'l1', 'plain.ifcx');
    assert.strictEqual(entry.nodeCount, 2);
    assert.strictEqual(entry.authorKind, undefined);
    assert.strictEqual(entry.contentId, undefined);
  });

  it('keeps a blake3 content address, drops synthetic ids', () => {
    const addressed = entryFor(makeFile([], 'blake3:abcdef1234567890'), 'l1', 'a.ifcx');
    assert.strictEqual(addressed.contentId, 'blake3:abcdef1234567890');
    const synthetic = entryFor(makeFile([], 'layer-3'), 'l2', 'b.ifcx');
    assert.strictEqual(synthetic.contentId, undefined);
  });

  it('extracts author kind, intent, and check tallies from the header manifest', () => {
    const manifest = createProvenanceManifest({
      author: { kind: 'agent', principal: 'bot-7' },
      intent: 'Set fire ratings',
      created: '2026-07-10T12:00:00Z',
      base: null,
      checks: [
        { tool: '@ifc-lite/ids@2.x', spec: 'fire.ids', result: 'pass' },
        { tool: '@ifc-lite/ids@2.x', spec: 'geo.ids', result: 'fail' },
      ],
    });
    const file = setProvenance(makeFile([{ path: 'wall-1' }]), manifest);
    const entry = entryFor(file, 'l1', 'agent-layer.ifcx');
    assert.strictEqual(entry.authorKind, 'agent');
    assert.strictEqual(entry.authorPrincipal, 'bot-7');
    assert.strictEqual(entry.intent, 'Set fire ratings');
    assert.strictEqual(entry.checksTotal, 2);
    assert.strictEqual(entry.checksPassed, 1);
  });
});

describe('computeLayerContribution', () => {
  const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

  it('isolates what one layer changes on top of the stack below it', async () => {
    const base = entryFor(
      makeFile([{ path: 'wall-1', attributes: { [FIRE]: 'REI60', Name: 'W1' } }]),
      'l1',
      'base.ifcx',
    );
    const overlay = entryFor(
      makeFile([
        { path: 'wall-1', attributes: { [FIRE]: 'REI90' } },
        { path: 'door-1', attributes: { Name: 'D1' } },
      ]),
      'l2',
      'overlay.ifcx',
    );
    const diff = await computeLayerContribution([base, overlay], 'l2');
    assert.ok(diff);
    assert.deepStrictEqual(diff.added, ['door-1']);
    assert.deepStrictEqual(diff.deleted, []);
    assert.strictEqual(diff.modified.length, 1);
    assert.strictEqual(diff.modified[0].path, 'wall-1');
  });

  it('returns null for an unknown layer id', async () => {
    const base = entryFor(makeFile([{ path: 'wall-1' }]), 'l1', 'base.ifcx');
    assert.strictEqual(await computeLayerContribution([base], 'nope'), null);
  });
});

describe('display helpers', () => {
  it('shortContentId trims the scheme and truncates', () => {
    assert.strictEqual(shortContentId('blake3:abcdef1234567890'), 'abcdef12');
  });
  it('pathTail keeps the last segment', () => {
    assert.strictEqual(pathTail('site/building/wall-1'), 'wall-1');
    assert.strictEqual(pathTail('wall-1'), 'wall-1');
  });
});
