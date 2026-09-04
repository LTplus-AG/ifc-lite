/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3338, the COLOUR channel.
 *
 * `pendingColorUpdates` is flushed to the renderer, which looks each id up in
 * its mesh set. A geometry-less `IfcElementAssembly` id is not in that set, so
 * `ifc.viewer.colorize([assemblyRef], red)` painted nothing: the assembly's
 * parts kept their original colour and the script reported success. Same
 * failure as the SDK `hide()` in `visibility-adapter.assembly.test.ts`, same
 * cause, and the same fix — route through the shared presentation resolver.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createViewerAdapter } from './viewer-adapter.js';
import type { StoreApi } from './types.js';

type Color = [number, number, number, number];
type ColorMap = Map<number, Color>;

const MODEL_ID = 'default';
const ASSEMBLY_ID = 42;
const PART_A = 9001;
const PART_B = 9002;
const red: Color = [1, 0, 0, 1];
const blue: Color = [0, 0, 1, 1];

/** Mirrors the real resolver: a geometry-less assembly becomes its
 *  geometry-bearing parts; anything else resolves to itself. */
const assemblyResolver = (ids: number[]) =>
  ids.flatMap((id) => (id === ASSEMBLY_ID ? [PART_A, PART_B] : [id]));

function makeStore(resolveHighlightIds?: (ids: number[]) => number[]) {
  let pendingColorUpdates: ColorMap | null = null;
  const resolverCalls: number[][] = [];
  const state = {
    // idOffset 0 so a global id is the express id.
    models: new Map([[MODEL_ID, { idOffset: 0 }]]),
    get pendingColorUpdates() {
      return pendingColorUpdates;
    },
    setPendingColorUpdates: (updates: ColorMap) => {
      pendingColorUpdates = new Map(updates);
    },
    cameraCallbacks: resolveHighlightIds
      ? {
          resolveHighlightIds: (ids: number[]) => {
            resolverCalls.push([...ids]);
            return resolveHighlightIds(ids);
          },
        }
      : {},
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { store, getPending: () => pendingColorUpdates, resolverCalls };
}

describe('SDK viewer adapter: colorize() and #3338 assembly expansion', () => {
  it('colorize() paints a geometry-less assembly by painting its parts (RED without the fix)', () => {
    const { store, getPending } = makeStore(assemblyResolver);
    createViewerAdapter(store).colorize([{ modelId: MODEL_ID, expressId: ASSEMBLY_ID }], red);

    const pending = getPending();
    assert.deepEqual(pending?.get(PART_A), red, 'the assembly\'s first part must be painted');
    assert.deepEqual(pending?.get(PART_B), red, 'the assembly\'s second part must be painted');
    assert.deepEqual(
      pending?.get(ASSEMBLY_ID),
      red,
      'the raw id stays in the map (union policy) — it owns no mesh, so it costs nothing',
    );
  });

  it('colorizeAll() expands each batch, and an explicitly named part keeps its own colour', () => {
    const { store, getPending } = makeStore(assemblyResolver);
    createViewerAdapter(store).colorizeAll([
      { refs: [{ modelId: MODEL_ID, expressId: ASSEMBLY_ID }], color: red },
      { refs: [{ modelId: MODEL_ID, expressId: PART_B }], color: blue },
    ]);

    const pending = getPending();
    assert.deepEqual(pending?.get(PART_A), red, 'the part reached only through the assembly is red');
    assert.deepEqual(
      pending?.get(PART_B),
      blue,
      'PART_B was named explicitly, so its own colour wins over the colour it inherited as ' +
      'the assembly\'s part — regardless of which batch came first',
    );
  });

  it('resolves once per distinct colour, not once per id', () => {
    const { store, resolverCalls } = makeStore(assemblyResolver);
    createViewerAdapter(store).colorizeAll([
      {
        refs: [
          { modelId: MODEL_ID, expressId: ASSEMBLY_ID },
          { modelId: MODEL_ID, expressId: 7 },
          { modelId: MODEL_ID, expressId: 8 },
        ],
        color: red,
      },
    ]);

    assert.equal(resolverCalls.length, 1, 'three same-coloured ids must cost one resolver call');
    assert.deepEqual(resolverCalls[0], [ASSEMBLY_ID, 7, 8]);
  });

  it('resetColors([assemblyRef]) removes the parts that colorize() added', () => {
    const { store, getPending } = makeStore(assemblyResolver);
    const adapter = createViewerAdapter(store);
    const assemblyRef = { modelId: MODEL_ID, expressId: ASSEMBLY_ID };

    adapter.colorize([assemblyRef], red);
    adapter.resetColors([assemblyRef]);

    const pending = getPending();
    assert.equal(pending?.size, 0, 'a targeted reset must drop every id its own colorize() set');
  });

  it('a plain element ref is untouched by the expansion (no over-reach)', () => {
    const { store, getPending } = makeStore(assemblyResolver);
    createViewerAdapter(store).colorize([{ modelId: MODEL_ID, expressId: PART_A }], red);

    assert.deepEqual([...(getPending() ?? [])], [[PART_A, red]]);
  });

  it('with no resolver wired, colorize() still paints the raw ids rather than nothing', () => {
    const { store, getPending } = makeStore(undefined);
    createViewerAdapter(store).colorize([{ modelId: MODEL_ID, expressId: ASSEMBLY_ID }], red);

    assert.deepEqual([...(getPending() ?? [])], [[ASSEMBLY_ID, red]]);
  });
});
