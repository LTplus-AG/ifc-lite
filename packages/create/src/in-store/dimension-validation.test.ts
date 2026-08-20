/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-builder regression: every in-store element builder must reject
 * non-finite dimension params (`NaN` / `Infinity`), not just non-positive
 * ones. A bare `value <= 0` check is `false` for both `NaN` and `Infinity`,
 * so those values used to sail past validation and land as the literal
 * STEP tokens `NaN` / `Infinity` in the emitted `IfcExtrudedAreaSolid` /
 * profile attributes — invalid IFC written with no error.
 *
 * `column.ts` picked up the `Number.isFinite` guard while closing the
 * merge-roundtrip gap from LTplus-AG/ifc-lite#592; this file is the single
 * place that pins the guard for every builder so a tenth builder landing
 * without it shows up here instead of shipping silently, the way the
 * original eight did.
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
import { addBeamToStore } from './beam.js';
import { addDoorToStore } from './door.js';
import { addWindowToStore } from './window.js';
import { addMemberToStore } from './member.js';
import { addWallToStore } from './wall.js';
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
  /** Dimension fields to fuzz, one at a time. */
  fields: string[];
}

const cases: BuilderCase[] = [
  {
    label: 'addColumnToStore',
    build: (editor, params) => addColumnToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 0.3, Depth: 0.4, Height: 3 },
    fields: ['Width', 'Depth', 'Height'],
  },
  {
    label: 'addBeamToStore',
    build: (editor, params) => addBeamToStore(editor, ANCHOR, params as never),
    base: { Start: [0, 0, 0], End: [5, 0, 0], Width: 0.3, Height: 0.3 },
    fields: ['Width', 'Height'],
  },
  {
    label: 'addDoorToStore',
    build: (editor, params) => addDoorToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 0.9, Height: 2.1, FrameThickness: 0.05 },
    fields: ['Width', 'Height', 'FrameThickness'],
  },
  {
    label: 'addWindowToStore',
    build: (editor, params) => addWindowToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 1.2, Height: 1.5, FrameThickness: 0.05 },
    fields: ['Width', 'Height', 'FrameThickness'],
  },
  {
    label: 'addMemberToStore',
    build: (editor, params) => addMemberToStore(editor, ANCHOR, params as never),
    base: { Start: [0, 0, 0], End: [5, 0, 0], Width: 0.15, Height: 0.15 },
    fields: ['Width', 'Height'],
  },
  {
    label: 'addWallToStore',
    build: (editor, params) => addWallToStore(editor, ANCHOR, params as never),
    base: { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 },
    fields: ['Thickness', 'Height'],
  },
  {
    label: 'addPlateToStore',
    build: (editor, params) => addPlateToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 1, Depth: 1, Thickness: 0.01 },
    fields: ['Width', 'Depth', 'Thickness'],
  },
  {
    label: 'addRoofToStore',
    build: (editor, params) => addRoofToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 1, Depth: 1, Thickness: 0.01 },
    fields: ['Width', 'Depth', 'Thickness'],
  },
  {
    label: 'addSpaceToStore',
    build: (editor, params) => addSpaceToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 3, Depth: 4, Height: 2.5 },
    fields: ['Width', 'Depth', 'Height'],
  },
  {
    label: 'addSlabToStore',
    build: (editor, params) => addSlabToStore(editor, ANCHOR, params as never),
    base: { Position: [0, 0, 0], Width: 3, Depth: 4, Thickness: 0.2 },
    fields: ['Width', 'Depth', 'Thickness'],
  },
];

describe.each(cases)('$label dimension validation', ({ build, base, fields }) => {
  it('accepts the valid baseline params (sanity check for the fuzzed fields below)', () => {
    const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
    expect(() => build(editor, base)).not.toThrow();
  });

  for (const field of fields) {
    it(`rejects NaN ${field}`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      expect(() => build(editor, { ...base, [field]: NaN })).toThrow();
    });

    it(`rejects Infinity ${field}`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      expect(() => build(editor, { ...base, [field]: Infinity })).toThrow();
    });

    it(`rejects -Infinity ${field}`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      expect(() => build(editor, { ...base, [field]: -Infinity })).toThrow();
    });

    // Pin the pre-existing behaviour: zero/negative dimensions must keep
    // throwing exactly as they did before this fix.
    it(`still rejects zero ${field} (pinned pre-existing behaviour)`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      expect(() => build(editor, { ...base, [field]: 0 })).toThrow(/positive/);
    });

    it(`still rejects negative ${field} (pinned pre-existing behaviour)`, () => {
      const editor = new StoreEditor(makeStore(50), new MutablePropertyView(null, 'm1'));
      expect(() => build(editor, { ...base, [field]: -1 })).toThrow(/positive/);
    });
  }
});
