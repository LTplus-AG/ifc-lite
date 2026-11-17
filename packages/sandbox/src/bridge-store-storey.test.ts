/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9025: scripts reach the storey authoring surface of bim.store; malformed arguments are refused before the SDK. */
import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { buildStoreNamespace } from './bridge-store.js';

const STOREY_METHODS = [
  'listStoreyLevels', 'suggestStorey', 'addStorey', 'renameStorey', 'planStoreyEdit', 'editStorey', 'planStoreyDelete', 'deleteStorey',
];

function method(name: string) {
  const found = buildStoreNamespace().methods.find((candidate) => candidate.name === name);
  expect(found, `bim.store.${name} is registered in the sandbox`).toBeDefined();
  return found!;
}

describe('bim.store storey bridge (#9025)', () => {
  it('registers every storey method', () => {
    const names = new Set(buildStoreNamespace().methods.map((candidate) => candidate.name));
    expect(STOREY_METHODS.filter((name) => !names.has(name))).toEqual([]);
  });

  it('dispatches edits and deletions to the SDK unchanged', () => {
    const editStorey = vi.fn(() => [{ modelId: 'm', expressId: 7 }]);
    const deleteStorey = vi.fn(() => [{ modelId: 'm', expressId: 9 }]);
    const sdk = { store: { editStorey, deleteStorey } } as unknown as BimContext;
    const edit = { kind: 'floorHeight', storeyId: 9, Height: 3.5 };
    expect(method('editStorey').call(sdk, ['m', edit], { sandboxSessionId: 'test' })).toEqual([{ modelId: 'm', expressId: 7 }]);
    expect(editStorey).toHaveBeenCalledWith('m', edit, undefined);
    const mode = { kind: 'move', targetStoreyId: 4 };
    method('deleteStorey').call(sdk, [{ modelId: 'm', expressId: 9 }, mode], { sandboxSessionId: 'test' });
    expect(deleteStorey).toHaveBeenCalledWith({ modelId: 'm', expressId: 9 }, mode, undefined);
    // A reviewed plan reaches the SDK, which refuses it once the model has moved on.
    const reviewed = { storeyId: 9, mode, contents: [], roots: [], refusals: [] };
    method('deleteStorey').call(sdk, [{ modelId: 'm', expressId: 9 }, mode, reviewed], { sandboxSessionId: 'test' });
    expect(deleteStorey).toHaveBeenLastCalledWith({ modelId: 'm', expressId: 9 }, mode, reviewed);
    expect(() => method('editStorey').call(sdk, ['m', edit, 'stale'], { sandboxSessionId: 'test' })).toThrow('expected must be an object');
  });

  it('refuses malformed arguments before the SDK is reached', () => {
    const editStorey = vi.fn();
    const deleteStorey = vi.fn();
    const suggestStorey = vi.fn();
    const sdk = { store: { editStorey, deleteStorey, suggestStorey } } as unknown as BimContext;
    const call = (name: string, args: unknown[]) => () => method(name).call(sdk, args, { sandboxSessionId: 'test' });
    expect(call('editStorey', ['m', { kind: 'height', storeyId: 9, Height: 3 }])).toThrow('edit.kind must be "elevation" or "floorHeight"');
    expect(call('editStorey', ['m', { kind: 'elevation', storeyId: 0, Elevation: 3 }])).toThrow('edit.storeyId must be a positive integer');
    expect(call('deleteStorey', [{ modelId: 'm', expressId: 9 }, { kind: 'move' }])).toThrow('mode.targetStoreyId must be a positive integer');
    expect(call('deleteStorey', [{ modelId: 'm', expressId: 9 }, { kind: 'purge' }])).toThrow('mode.kind must be');
    expect(call('suggestStorey', ['m', 9, 'sideways'])).toThrow('side must be "above" or "below"');
    expect(editStorey).not.toHaveBeenCalled();
    expect(deleteStorey).not.toHaveBeenCalled();
    expect(suggestStorey).not.toHaveBeenCalled();
  });
});
