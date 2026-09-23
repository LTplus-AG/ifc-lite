/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-builder regression for LTplus-AG/ifc-lite#5217: every in-store
 * element builder that takes a `Position` must reject a non-finite
 * coordinate. `serializeStepValue` (`packages/export/src/step-serialization.ts`)
 * turns a non-finite number into `$`, which is valid ISO 10303-21 syntax
 * for an *omitted* attribute but not for a member of a mandatory
 * `LIST [1:3] OF IfcLengthMeasure` (`IfcCartesianPoint.Coordinates`). A
 * `NaN`/`Infinity` Position that reached the serializer unguarded would
 * emit `#N=IFCCARTESIANPOINT(($,0,0));` — invalid IFC written with no
 * error.
 *
 * `wall.ts` / `beam.ts` / `member.ts` already call `assertFinitePoint3` on
 * `Start`/`End`. `door.ts`, `window.ts`, `column.ts`, `slab.ts`, `roof.ts`,
 * `plate.ts` and `space.ts` did not guard `Position` at all — this file is
 * the single place that pins the guard for every one of them, so a new
 * builder landing without it shows up here instead of shipping silently.
 */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { addColumnToStore } from './column.js';
import { addDoorToStore } from './door.js';
import { addWindowToStore } from './window.js';
import { addPlateToStore } from './plate.js';
import { addRoofToStore } from './roof.js';
import { addSpaceToStore } from './space.js';
import { addSlabToStore } from './slab.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const ANCHOR: SpatialAnchor = {
  ownerHistoryId: 5,
  bodyContextId: 14,
  axisContextId: 15,
  storeyId: 43,
  storeyPlacementId: 54,
};

interface BuilderCase {
  label: string;
  build: (editor: StoreEditor, params: Record<string, unknown>) => unknown;
  base: Record<string, unknown>;
}

const cases: BuilderCase[] = [
  {
    label: 'addColumnToStore',
    build: (editor, params) => addColumnToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 0.3, Depth: 0.4, Height: 3 },
  },
  {
    label: 'addDoorToStore',
    build: (editor, params) => addDoorToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 0.9, Height: 2.1, FrameThickness: 0.05 },
  },
  {
    label: 'addWindowToStore',
    build: (editor, params) => addWindowToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 1.2, Height: 1.5, FrameThickness: 0.05 },
  },
  {
    label: 'addPlateToStore',
    build: (editor, params) => addPlateToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 1, Depth: 1, Thickness: 0.01 },
  },
  {
    label: 'addRoofToStore',
    build: (editor, params) => addRoofToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 1, Depth: 1, Thickness: 0.01 },
  },
  {
    label: 'addSpaceToStore',
    build: (editor, params) => addSpaceToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 3, Depth: 4, Height: 2.5 },
  },
  {
    label: 'addSlabToStore',
    build: (editor, params) => addSlabToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 3, Depth: 4, Thickness: 0.2 },
  },
];

describe.each(cases)('$label Position finiteness validation', ({ build, base }) => {
  it('accepts the valid baseline params (sanity check for the fuzzed Position below)', () => {
    const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
    expect(() => build(editor, base)).not.toThrow();
  });

  for (const axis of [0, 1, 2] as const) {
    it(`rejects NaN Position[${axis}]`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      const position = (base.Position as number[]).slice();
      position[axis] = NaN;
      expect(() => build(editor, { ...base, Position: position })).toThrow(/finite coordinates/);
    });

    it(`rejects Infinity Position[${axis}]`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      const position = (base.Position as number[]).slice();
      position[axis] = Infinity;
      expect(() => build(editor, { ...base, Position: position })).toThrow(/finite coordinates/);
    });

    it(`rejects -Infinity Position[${axis}]`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      const position = (base.Position as number[]).slice();
      position[axis] = -Infinity;
      expect(() => build(editor, { ...base, Position: position })).toThrow(/finite coordinates/);
    });
  }

  // No-regression pin: an ordinary finite Position away from the origin
  // must still be accepted, exactly as before this fix.
  it('still accepts an ordinary finite Position (pinned pre-existing behaviour)', () => {
    const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
    expect(() => build(editor, { ...base, Position: [3.5, -2, 1.25] })).not.toThrow();
  });
});
